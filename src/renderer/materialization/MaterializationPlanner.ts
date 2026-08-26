import * as THREE from "three";
import { deriveParametricBounds } from "../../workspace/modeling/parametricGeometry";
import type { EntityId, EntityState, SceneState, Vec3 } from "../sceneRenderTypes";
import type {
  MaterializationAssetBounds,
  MaterializationPlan,
  MaterializationPlanEntry,
  MaterializationPlannerInput,
  MaterializationProxy,
  MaterializationProxySource,
} from "./materializationTypes";

const GLYPH_SIZE = Object.freeze({ x: 0.18, y: 0.18, z: 0.18 });
const MIN_PROXY_EXTENT = 0.002;

type Candidate = Readonly<{
  entity: EntityState;
  depth: number;
  priority: number;
  worldCenter: THREE.Vector3;
  proxy: MaterializationProxy;
}>;

/**
 * Produce one deterministic, bounded presentation plan from already-committed
 * semantic entities. The plan never changes transforms or creates Workspace
 * operations; it only supplies timing and lightweight proxy geometry.
 */
export function planMaterialization(input: MaterializationPlannerInput): MaterializationPlan {
  const uniqueIds = [...new Set(input.addedEntityIds)].sort(stableCompare);
  const worldMatrices = worldMatricesFor(input.state);
  const candidates = uniqueIds.flatMap((entityId): Candidate[] => {
    const entity = input.state.entities.get(entityId);
    const worldMatrix = worldMatrices.get(entityId);
    if (!entity || !worldMatrix || !isVisuallyPresent(entity)) return [];
    const local = localProxyFor(entity, input.resolveAssetBounds);
    const proxy = Object.freeze({
      ...local,
      worldMatrix: Object.freeze(worldMatrix.toArray()),
    });
    return [{
      entity,
      depth: hierarchyDepth(entityId, input.state.entities),
      priority: entityPriority(entity),
      worldCenter: new THREE.Vector3(
        proxy.localCenter.x,
        proxy.localCenter.y,
        proxy.localCenter.z,
      ).applyMatrix4(worldMatrix),
      proxy,
    }];
  });

  const center = candidates.length
    ? candidates.reduce((sum, candidate) => sum.add(candidate.worldCenter), new THREE.Vector3())
      .multiplyScalar(1 / candidates.length)
    : new THREE.Vector3();
  const radius = Math.max(0.5, ...candidates.map((candidate) => candidate.worldCenter.distanceTo(center)));
  candidates.sort((left, right) => left.priority - right.priority
    || left.depth - right.depth
    || left.worldCenter.y - right.worldCenter.y
    || left.worldCenter.distanceToSquared(center) - right.worldCenter.distanceToSquared(center)
    || stableCompare(left.entity.id, right.entity.id));
  const candidatesById = new Map(candidates.map((candidate) => [candidate.entity.id, candidate]));
  const ordered: Candidate[] = [];
  const emitted = new Set<EntityId>();
  const visiting = new Set<EntityId>();
  const emitWithParent = (candidate: Candidate): void => {
    if (emitted.has(candidate.entity.id)) return;
    if (visiting.has(candidate.entity.id)) return;
    visiting.add(candidate.entity.id);
    const parent = candidate.entity.parentId ? candidatesById.get(candidate.entity.parentId) : undefined;
    if (parent) emitWithParent(parent);
    visiting.delete(candidate.entity.id);
    emitted.add(candidate.entity.id);
    ordered.push(candidate);
  };
  for (const candidate of candidates) emitWithParent(candidate);
  candidates.splice(0, candidates.length, ...ordered);

  const maximumDepth = Math.max(0, ...candidates.map(({ depth }) => depth));
  // Reserve at most 1.5 seconds for hierarchy staggering. Normal hierarchies
  // retain the preferred 120ms gap while pathological depth stays bounded.
  const parentGapMs = maximumDepth > 0 ? Math.min(120, 1_500 / maximumDepth) : 120;
  const waveStartMs = input.mode === "full" ? 350 : 250;
  const waveSpanMs = input.mode === "full" ? 1_500 : 1_200;
  const revealDurationMs = input.mode === "full" ? 420 : 260;
  const startById = new Map<EntityId, number>();
  const denominator = Math.max(1, candidates.length - 1);
  const entries: MaterializationPlanEntry[] = candidates.map((candidate, order) => {
    const rankedStart = waveStartMs + waveSpanMs * order / denominator;
    const parentStart = candidate.entity.parentId
      ? startById.get(candidate.entity.parentId)
      : undefined;
    const revealAtMs = Math.round(Math.max(
      rankedStart,
      parentStart === undefined ? 0 : parentStart + parentGapMs,
    ));
    startById.set(candidate.entity.id, revealAtMs);
    return Object.freeze({
      entityId: candidate.entity.id,
      ...(candidate.entity.parentId ? { parentId: candidate.entity.parentId } : {}),
      order,
      revealAtMs,
      revealDurationMs,
      proxy: candidate.proxy,
    });
  });
  const latestReveal = Math.max(0, ...entries.map((entry) => entry.revealAtMs + entry.revealDurationMs));
  const totalDurationMs = Math.min(3_900, Math.max(
    2_000,
    Math.round(latestReveal + (input.mode === "full" ? 450 : 300)),
  ));
  return Object.freeze({
    batchKey: input.batchKey,
    mode: input.mode,
    totalDurationMs,
    center: frozenVec3(center),
    radius,
    entries: Object.freeze(entries),
  });
}

function localProxyFor(
  entity: EntityState,
  resolveAssetBounds: MaterializationPlannerInput["resolveAssetBounds"],
): Omit<MaterializationProxy, "worldMatrix"> {
  const geometry = entity.renderGeometry;
  if (geometry?.kind === "reality") {
    const signs = geometry.sourceAxisSigns;
    const first = new THREE.Vector3(
      geometry.bounds.min.x * signs.x,
      geometry.bounds.min.y * signs.y,
      geometry.bounds.min.z * signs.z,
    );
    const second = new THREE.Vector3(
      geometry.bounds.max.x * signs.x,
      geometry.bounds.max.y * signs.y,
      geometry.bounds.max.z * signs.z,
    );
    const min = first.clone().min(second);
    const max = first.clone().max(second);
    return proxyBounds(
      "reality_bounds",
      min.clone().add(max).multiplyScalar(0.5),
      max.clone().sub(min),
    );
  }
  if (geometry?.kind === "parametric") {
    const bounds = deriveParametricBounds(geometry.definition);
    return proxyBounds("parametric_bounds", vector(bounds.center), vector(bounds.size));
  }
  const assetBounds = resolveAssetBounds?.(entity.assetId);
  if (assetBounds) {
    return proxyBounds("asset_bounds", vector(assetBounds.center), vector(assetBounds.size));
  }
  const collision = entity.collision;
  if (collision?.enabled && collision.shape === "box") {
    return proxyBounds("collision_bounds", vector(collision.center), vector(collision.size));
  }
  if (collision?.enabled && collision.shape === "compound" && collision.parts.length) {
    const bounds = new THREE.Box3();
    for (const part of collision.parts) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        part.rotation.x,
        part.rotation.y,
        part.rotation.z,
        "XYZ",
      ));
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        bounds.expandByPoint(new THREE.Vector3(
          x * part.size.x / 2,
          y * part.size.y / 2,
          z * part.size.z / 2,
        ).applyQuaternion(rotation).add(vector(part.center)));
      }
    }
    return proxyBounds(
      "collision_bounds",
      bounds.getCenter(new THREE.Vector3()),
      bounds.getSize(new THREE.Vector3()),
    );
  }
  return Object.freeze({
    source: "loading_glyph" as const,
    reliableBounds: false,
    localCenter: Object.freeze({ x: 0, y: GLYPH_SIZE.y / 2, z: 0 }),
    localSize: GLYPH_SIZE,
  });
}

function proxyBounds(
  source: Exclude<MaterializationProxySource, "loading_glyph" | "resolved_render_bounds">,
  center: THREE.Vector3,
  size: THREE.Vector3,
): Omit<MaterializationProxy, "worldMatrix"> {
  return Object.freeze({
    source,
    reliableBounds: true,
    localCenter: frozenVec3(center),
    localSize: Object.freeze({
      x: Math.max(MIN_PROXY_EXTENT, Math.abs(size.x)),
      y: Math.max(MIN_PROXY_EXTENT, Math.abs(size.y)),
      z: Math.max(MIN_PROXY_EXTENT, Math.abs(size.z)),
    }),
  });
}

function worldMatricesFor(state: Readonly<SceneState>): ReadonlyMap<EntityId, THREE.Matrix4> {
  const result = new Map<EntityId, THREE.Matrix4>();
  const visiting = new Set<EntityId>();
  const visit = (entityId: EntityId): THREE.Matrix4 | undefined => {
    const cached = result.get(entityId);
    if (cached) return cached;
    const entity = state.entities.get(entityId);
    if (!entity || visiting.has(entityId)) return undefined;
    visiting.add(entityId);
    const local = matrixForEntity(entity);
    const parent = entity.parentId ? visit(entity.parentId) : undefined;
    const world = parent ? parent.clone().multiply(local) : local;
    visiting.delete(entityId);
    result.set(entityId, world);
    return world;
  };
  for (const id of state.entities.keys()) visit(id);
  return result;
}

function matrixForEntity(entity: EntityState): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    vector(entity.transform.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      entity.transform.rotation.x,
      entity.transform.rotation.y,
      entity.transform.rotation.z,
      "XYZ",
    )),
    vector(entity.transform.scale),
  );
}

function hierarchyDepth(entityId: EntityId, entities: ReadonlyMap<EntityId, EntityState>): number {
  let depth = 0;
  let current = entities.get(entityId)?.parentId;
  const visited = new Set<EntityId>([entityId]);
  while (current && !visited.has(current)) {
    visited.add(current);
    depth += 1;
    current = entities.get(current)?.parentId;
  }
  return depth;
}

function entityPriority(entity: EntityState): number {
  if (entity.renderGeometry?.kind === "assembly" || entity.kind === "structure") return 0;
  if (entity.kind === "prop" || entity.kind === "primitive") return 1;
  if (entity.kind === "character" || entity.kind === "animal") return 2;
  return 3;
}

function isVisuallyPresent(entity: EntityState): boolean {
  if ((entity.appearance.opacity ?? 1) <= 0.001) return false;
  if (entity.state.type === "prop") return entity.state.visible !== false;
  if (entity.state.type === "effect") return entity.state.enabled;
  if (entity.state.type === "generic") return entity.state.properties?.visible !== false;
  return true;
}

function vector(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}

function frozenVec3(value: THREE.Vector3): Vec3 {
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function materializationAssetBounds(
  center: Vec3,
  size: Vec3,
): MaterializationAssetBounds {
  return Object.freeze({ center: Object.freeze({ ...center }), size: Object.freeze({ ...size }) });
}
