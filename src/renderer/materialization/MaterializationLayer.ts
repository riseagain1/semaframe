import * as THREE from "three";
import type { EntityId } from "../sceneRenderTypes";
import type { MaterializationPlan, MaterializationPlanEntry } from "./materializationTypes";

const HIDDEN_SCALE = 0.000_001;

type ProxySlot = Readonly<{
  index: number;
  baseMatrix: THREE.Matrix4;
}>;

/** One instanced renderer-only hologram layer shared by every active batch. */
export class MaterializationLayer {
  readonly root = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly proxyMaterial = new THREE.MeshBasicMaterial({
    color: 0x58e6ff,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    wireframe: true,
    toneMapped: false,
  });
  private readonly hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private readonly proxies: THREE.InstancedMesh;
  private readonly scanMaterial = new THREE.MeshBasicMaterial({
    color: 0x7af1ff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  private readonly scanRing = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1, 64),
    this.scanMaterial,
  );
  private readonly slots = new Map<EntityId, ProxySlot>();
  private readonly collisionRoots = new Map<EntityId, THREE.Object3D>();
  private readonly maxProxyInstances: number;
  private plan: MaterializationPlan | null = null;
  private disposed = false;

  constructor(parent: THREE.Object3D, maxProxyInstances = 128) {
    this.maxProxyInstances = Math.max(1, Math.min(512, Math.trunc(maxProxyInstances)));
    this.root.name = "materialization-layer";
    this.root.renderOrder = 90;
    this.proxies = new THREE.InstancedMesh(this.geometry, this.proxyMaterial, this.maxProxyInstances);
    this.proxies.name = "materialization-proxies";
    this.proxies.count = 0;
    this.proxies.frustumCulled = false;
    this.proxies.renderOrder = 90;
    this.proxies.raycast = () => undefined;
    this.scanRing.name = "materialization-scan-ring";
    this.scanRing.rotation.x = -Math.PI / 2;
    this.scanRing.visible = false;
    this.scanRing.renderOrder = 91;
    this.scanRing.raycast = () => undefined;
    this.root.add(this.proxies, this.scanRing);
    parent.add(this.root);
  }

  begin(plan: MaterializationPlan): void {
    if (this.disposed) return;
    this.clear();
    this.plan = plan;
    const sampled = sampleEntries(plan.entries, this.maxProxyInstances);
    this.proxies.count = sampled.length;
    sampled.forEach((entry, index) => {
      const baseMatrix = proxyMatrix(entry);
      this.slots.set(entry.entityId, { index, baseMatrix });
      this.proxies.setMatrixAt(index, baseMatrix);
      this.proxies.setColorAt(index, new THREE.Color(
        entry.proxy.reliableBounds ? 0x58e6ff : 0xffcf66,
      ));
    });
    this.proxies.instanceMatrix.needsUpdate = true;
    if (this.proxies.instanceColor) this.proxies.instanceColor.needsUpdate = true;
    for (const entry of plan.entries) {
      if (!entry.proxy.reliableBounds) continue;
      const collisionRoot = new THREE.Group();
      collisionRoot.name = `materialization-collision:${entry.entityId}`;
      collisionRoot.matrixAutoUpdate = false;
      collisionRoot.matrix.fromArray([...entry.proxy.worldMatrix]);
      const bounds = new THREE.Mesh(this.geometry, this.hiddenMaterial);
      bounds.name = `materialization-bounds:${entry.entityId}`;
      bounds.position.set(
        entry.proxy.localCenter.x,
        entry.proxy.localCenter.y,
        entry.proxy.localCenter.z,
      );
      bounds.scale.set(
        entry.proxy.localSize.x,
        entry.proxy.localSize.y,
        entry.proxy.localSize.z,
      );
      collisionRoot.add(bounds);
      this.root.add(collisionRoot);
      this.collisionRoots.set(entry.entityId, collisionRoot);
    }
    this.scanRing.position.set(plan.center.x, plan.center.y + 0.015, plan.center.z);
    this.scanRing.scale.setScalar(0.01);
    this.scanRing.visible = plan.mode === "full";
  }

  updateProxy(entityId: EntityId, factor: number): void {
    const slot = this.slots.get(entityId);
    if (!slot || this.disposed) return;
    const scalar = THREE.MathUtils.clamp(factor, 0, 1);
    const matrix = slot.baseMatrix.clone();
    if (scalar <= 0.000_01) matrix.scale(new THREE.Vector3(HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE));
    else matrix.scale(new THREE.Vector3(scalar, scalar, scalar));
    this.proxies.setMatrixAt(slot.index, matrix);
    this.proxies.instanceMatrix.needsUpdate = true;
  }

  updateScan(elapsedMs: number): void {
    const plan = this.plan;
    if (!plan || plan.mode !== "full" || this.disposed) return;
    const progress = THREE.MathUtils.clamp(elapsedMs / Math.max(1, plan.totalDurationMs), 0, 1);
    const radius = Math.max(0.05, plan.radius * (0.1 + progress * 1.35));
    this.scanRing.scale.setScalar(radius);
    this.scanMaterial.opacity = 0.42 * Math.sin(Math.PI * progress);
    this.scanRing.visible = progress > 0 && progress < 1;
  }

  /** Replace an approximate proxy with the render root's resolved AABB. */
  refineBounds(entityId: EntityId, renderRoot: THREE.Object3D): void {
    const slot = this.slots.get(entityId);
    if (!slot || this.disposed) return;
    renderRoot.updateWorldMatrix(true, true);
    this.root.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3().setFromObject(renderRoot);
    if (bounds.isEmpty()) return;
    const inverse = this.root.matrixWorld.clone().invert();
    const local = new THREE.Box3();
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          local.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(inverse));
        }
      }
    }
    const center = local.getCenter(new THREE.Vector3());
    const size = local.getSize(new THREE.Vector3());
    if (![center.x, center.y, center.z, size.x, size.y, size.z].every(Number.isFinite)) return;
    slot.baseMatrix.compose(
      center,
      new THREE.Quaternion(),
      new THREE.Vector3(
        Math.max(0.002, size.x),
        Math.max(0.002, size.y),
        Math.max(0.002, size.z),
      ),
    );
    this.proxies.setMatrixAt(slot.index, slot.baseMatrix);
    this.proxies.instanceMatrix.needsUpdate = true;
  }

  getCollisionRoot(entityId: EntityId): THREE.Object3D | undefined {
    return this.collisionRoots.get(entityId);
  }

  removeEntity(entityId: EntityId): void {
    this.updateProxy(entityId, 0);
    const collisionRoot = this.collisionRoots.get(entityId);
    collisionRoot?.removeFromParent();
    this.collisionRoots.delete(entityId);
  }

  clear(): void {
    this.plan = null;
    this.slots.clear();
    this.proxies.count = 0;
    this.proxies.instanceMatrix.needsUpdate = true;
    this.scanRing.visible = false;
    for (const root of this.collisionRoots.values()) root.removeFromParent();
    this.collisionRoots.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.root.removeFromParent();
    this.geometry.dispose();
    this.proxyMaterial.dispose();
    this.hiddenMaterial.dispose();
    this.scanRing.geometry.dispose();
    this.scanMaterial.dispose();
  }
}

function proxyMatrix(entry: MaterializationPlanEntry): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray([...entry.proxy.worldMatrix])
    .multiply(new THREE.Matrix4().makeTranslation(
      entry.proxy.localCenter.x,
      entry.proxy.localCenter.y,
      entry.proxy.localCenter.z,
    ))
    .multiply(new THREE.Matrix4().makeScale(
      entry.proxy.localSize.x,
      entry.proxy.localSize.y,
      entry.proxy.localSize.z,
    ));
}

function sampleEntries(
  entries: readonly MaterializationPlanEntry[],
  limit: number,
): readonly MaterializationPlanEntry[] {
  if (entries.length <= limit) return entries;
  if (limit === 1) return [entries[0]!];
  const selected: MaterializationPlanEntry[] = [];
  for (let index = 0; index < limit; index += 1) {
    selected.push(entries[Math.round(index * (entries.length - 1) / (limit - 1))]!);
  }
  return selected;
}
