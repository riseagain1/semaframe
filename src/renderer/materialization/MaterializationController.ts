import * as THREE from "three";
import {
  applyObjectVisualEffects,
  type RenderVisualEffects,
} from "../visualEffects";
import type { EntityId } from "../sceneRenderTypes";
import { MaterializationLayer } from "./MaterializationLayer";
import type { MaterializationPlan } from "./materializationTypes";

// Async reality/CAD assets may be provided by external decoders. A broken
// decoder must not leave renderer-only proxies or partially faded roots on
// screen forever, even though the semantic Workspace commit already succeeded.
const MATERIALIZATION_FAILSAFE_GRACE_MS = 12_000;

type AttachedContent = {
  root?: THREE.Object3D;
  effects?: RenderVisualEffects;
  semanticallyVisible?: boolean;
  readyAtMs?: number;
  complete: boolean;
};

/** Owns one renderer-only pass and guarantees cancellation restores final presentation. */
export class MaterializationController {
  private readonly layer: MaterializationLayer;
  private readonly now: () => number;
  private plan: MaterializationPlan | null = null;
  private startedAtMs = 0;
  private readonly content = new Map<EntityId, AttachedContent>();
  private disposed = false;

  constructor(layer: MaterializationLayer, now: () => number = defaultNow) {
    this.layer = layer;
    this.now = now;
  }

  begin(plan: MaterializationPlan): void {
    if (this.disposed) return;
    this.cancel(true);
    this.plan = plan;
    this.startedAtMs = this.now();
    this.content.clear();
    for (const entry of plan.entries) this.content.set(entry.entityId, { complete: false });
    try {
      this.layer.begin(plan);
    } catch (error) {
      // Materialization is presentation only. If its lightweight layer cannot
      // initialize, clear every partial proxy and let the authoritative render
      // flow surface the error without leaving a half-started pass behind.
      this.layer.clear();
      this.plan = null;
      this.content.clear();
      throw error;
    }
  }

  attach(
    entityId: EntityId,
    root: THREE.Object3D,
    effects: RenderVisualEffects,
    semanticallyVisible: boolean,
  ): void {
    const entry = this.content.get(entityId);
    if (!entry || !this.plan || this.disposed) return;
    if (entry.root === root) return;
    entry.root = root;
    entry.effects = effects;
    entry.semanticallyVisible = semanticallyVisible;
    entry.readyAtMs = Math.max(0, this.now() - this.startedAtMs);
    entry.complete = false;
    root.userData.materializationInteractive = false;
    root.visible = semanticallyVisible;
    applyObjectVisualEffects(root, { ...effects, opacity: 0 });
    this.layer.refineBounds(entityId, root);
  }

  update(timeMs = this.now()): void {
    const plan = this.plan;
    if (!plan || this.disposed) return;
    const elapsedMs = Math.max(0, timeMs - this.startedAtMs);
    if (elapsedMs > plan.totalDurationMs + MATERIALIZATION_FAILSAFE_GRACE_MS) {
      this.cancel(true);
      return;
    }
    let allComplete = true;
    for (const entry of plan.entries) {
      const attached = this.content.get(entry.entityId);
      if (!attached) continue;
      const readyAtMs = attached.readyAtMs;
      const revealStart = Math.max(entry.revealAtMs, readyAtMs ?? Number.POSITIVE_INFINITY);
      const progress = Number.isFinite(revealStart)
        ? THREE.MathUtils.clamp((elapsedMs - revealStart) / Math.max(1, entry.revealDurationMs), 0, 1)
        : 0;
      const waitingPulse = 0.94 + Math.sin(elapsedMs / 180 + entry.order) * 0.04;
      this.layer.updateProxy(entry.entityId, progress >= 1 ? 0 : progress > 0 ? 1 - progress : waitingPulse);
      if (!attached.root || !attached.effects || attached.semanticallyVisible === undefined) {
        allComplete = false;
        continue;
      }
      if (progress < 1) {
        allComplete = false;
        attached.root.visible = attached.semanticallyVisible;
        attached.root.userData.materializationInteractive = progress >= 0.35;
        applyObjectVisualEffects(attached.root, {
          ...attached.effects,
          opacity: attached.effects.opacity * progress,
          emissiveIntensity: attached.effects.emissiveIntensity + (1 - progress) * 0.18,
        });
      } else if (!attached.complete) {
        applyFinal(attached);
        this.layer.removeEntity(entry.entityId);
      }
    }
    this.layer.updateScan(elapsedMs);
    if (allComplete && elapsedMs >= plan.totalDurationMs) {
      this.layer.clear();
      this.plan = null;
      this.content.clear();
    }
  }

  detach(entityId: EntityId): void {
    this.content.delete(entityId);
    this.layer.removeEntity(entityId);
  }

  cancel(complete: boolean): void {
    if (complete) {
      for (const attached of this.content.values()) applyFinal(attached);
    }
    this.layer.clear();
    this.plan = null;
    this.content.clear();
  }

  isActive(): boolean {
    return this.plan !== null;
  }

  isEntityInteractive(entityId: EntityId): boolean {
    const attached = this.content.get(entityId);
    return !attached || attached.root?.userData.materializationInteractive !== false;
  }

  remainingRevealMs(entityId: EntityId, timeMs = this.now()): number {
    const plan = this.plan;
    const entry = plan?.entries.find((candidate) => candidate.entityId === entityId);
    if (!plan || !entry) return 0;
    const attached = this.content.get(entityId);
    const elapsedMs = Math.max(0, timeMs - this.startedAtMs);
    const revealStart = Math.max(entry.revealAtMs, attached?.readyAtMs ?? entry.revealAtMs);
    return Math.max(0, revealStart + entry.revealDurationMs - elapsedMs);
  }

  getCollisionRoot(entityId: EntityId): THREE.Object3D | undefined {
    return this.layer.getCollisionRoot(entityId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel(false);
    this.disposed = true;
    this.layer.dispose();
  }
}

function applyFinal(attached: AttachedContent): void {
  if (!attached.root || !attached.effects || attached.semanticallyVisible === undefined) return;
  applyObjectVisualEffects(attached.root, attached.effects);
  attached.root.visible = attached.semanticallyVisible;
  attached.root.userData.materializationInteractive = true;
  attached.complete = true;
}

function defaultNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
