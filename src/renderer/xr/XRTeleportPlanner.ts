import * as THREE from "three";
import type { EntityState } from "../sceneRenderTypes";
import type { SpatialCollisionConfig } from "../../workspace/spatial/spatialTypes";
import {
  planTeleport,
  type XRTeleportPlan,
} from "../../xr/client/locomotion";
import type { XRCapsuleObstacle } from "../../xr/client/playerCapsule";

export const XR_TELEPORT_CAPSULE = Object.freeze({ radius: 0.3, height: 1.8 });
export const XR_TELEPORT_SAFETY_MARGIN = 0.05;

const WALKABLE_ENVIRONMENT_NAMES = new Set([
  "environment:ground",
  "environment:room:rug",
  "environment:street:road",
  "environment:street:sidewalk-left",
  "environment:street:sidewalk-right",
]);

const INVALID_SCENE_CONFLICT = "xr-teleport-scene-invalid";

export type ThreeRendererTeleportEntity = Readonly<{
  id: string;
  root: THREE.Object3D;
  collision: SpatialCollisionConfig;
}>;

export type ThreeRendererTeleportInput = Readonly<{
  /** Controller ray in render-relative world coordinates. */
  rayOrigin: THREE.Vector3;
  rayDirection: THREE.Vector3;
  maxDistance: number;
  /** Tracked head and reference-floor origin in render-relative world coordinates. */
  headWorldPosition: THREE.Vector3;
  rigWorldPosition: THREE.Vector3;
  /** Semantic floating origin subtracted from rendered scene roots. */
  renderOrigin: THREE.Vector3;
  walkableSurface: THREE.Object3D;
  environmentRoot: THREE.Object3D;
  entities: readonly ThreeRendererTeleportEntity[];
}>;

function failClosed(): XRTeleportPlan {
  return Object.freeze({
    valid: false,
    reason: "collision",
    conflicts: Object.freeze([INVALID_SCENE_CONFLICT]),
  });
}

function finiteVector(value: THREE.Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function worldVisible(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function semanticBounds(
  object: THREE.Object3D,
  renderOrigin: THREE.Vector3,
): THREE.Box3 | undefined {
  object.updateWorldMatrix(true, true);
  const rendered = new THREE.Box3().setFromObject(object);
  if (rendered.isEmpty()
    || !finiteVector(rendered.min)
    || !finiteVector(rendered.max)) return undefined;
  return rendered.translate(renderOrigin);
}

function obstacle(id: string, bounds: THREE.Box3): XRCapsuleObstacle {
  return Object.freeze({
    id,
    bounds: Object.freeze({
      min: Object.freeze({ x: bounds.min.x, y: bounds.min.y, z: bounds.min.z }),
      max: Object.freeze({ x: bounds.max.x, y: bounds.max.y, z: bounds.max.z }),
    }),
  });
}

function explicitPartBounds(
  root: THREE.Object3D,
  center: Readonly<{ x: number; y: number; z: number }>,
  size: Readonly<{ x: number; y: number; z: number }>,
  rotation: Readonly<{ x: number; y: number; z: number }>,
  margin: number,
  renderOrigin: THREE.Vector3,
): THREE.Box3 | undefined {
  root.updateWorldMatrix(true, false);
  if (root.matrixWorld.elements.some((entry) => !Number.isFinite(entry))
    || Math.abs(root.matrixWorld.determinant()) <= Number.EPSILON
    || !finiteVector(new THREE.Vector3(center.x, center.y, center.z))
    || !finiteVector(new THREE.Vector3(size.x, size.y, size.z))
    || !finiteVector(new THREE.Vector3(rotation.x, rotation.y, rotation.z))
    || !Number.isFinite(margin)
    || margin < 0
    || size.x <= 0
    || size.y <= 0
    || size.z <= 0) return undefined;
  const partRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rotation.x, rotation.y, rotation.z, "XYZ"),
  );
  const bounds = new THREE.Box3();
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    bounds.expandByPoint(new THREE.Vector3(
      x * size.x / 2,
      y * size.y / 2,
      z * size.z / 2,
    )
      .applyQuaternion(partRotation)
      .add(new THREE.Vector3(center.x, center.y, center.z))
      .applyMatrix4(root.matrixWorld)
      .add(renderOrigin));
  }
  // Spatial collision margins are world-space OBB extents. Expanding each AABB
  // axis by sqrt(3) * margin conservatively contains every rotated OBB margin.
  bounds.expandByScalar(margin * Math.sqrt(3));
  return bounds.isEmpty() || !finiteVector(bounds.min) || !finiteVector(bounds.max)
    ? undefined
    : bounds;
}

function entityCollisionBounds(
  candidate: ThreeRendererTeleportEntity,
  renderOrigin: THREE.Vector3,
): THREE.Box3 | undefined {
  if (candidate.collision.shape === "asset_bounds") {
    const bounds = semanticBounds(candidate.root, renderOrigin);
    return bounds?.expandByScalar(candidate.collision.margin);
  }
  const parts = candidate.collision.shape === "box"
    ? [{
        center: candidate.collision.center,
        size: candidate.collision.size,
        rotation: { x: 0, y: 0, z: 0 },
      }]
    : candidate.collision.parts;
  const result = new THREE.Box3();
  for (const part of parts) {
    const bounds = explicitPartBounds(
      candidate.root,
      part.center,
      part.size,
      part.rotation,
      candidate.collision.margin,
      renderOrigin,
    );
    if (!bounds) return undefined;
    result.union(bounds);
  }
  return result.isEmpty() ? undefined : result;
}

function environmentObstacles(
  root: THREE.Object3D,
  renderOrigin: THREE.Vector3,
): readonly XRCapsuleObstacle[] | undefined {
  const result: XRCapsuleObstacle[] = [];
  let meshIndex = 0;
  let invalid = false;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !worldVisible(object, root)) return;
    const index = meshIndex++;
    if (isXRTeleportNonBlockingEnvironmentObject(object)) return;
    const bounds = semanticBounds(object, renderOrigin);
    if (!bounds) {
      invalid = true;
      return;
    }
    result.push(obstacle(
      `environment:${index.toString().padStart(4, "0")}:${object.name || "mesh"}`,
      bounds,
    ));
  });
  return invalid ? undefined : Object.freeze(result);
}

/** Only explicitly flat, load-bearing preset meshes are teleport surfaces. */
export function isXRTeleportWalkableEnvironmentObject(object: THREE.Object3D): boolean {
  return object instanceof THREE.Mesh && WALKABLE_ENVIRONMENT_NAMES.has(object.name);
}

function isXRTeleportNonBlockingEnvironmentObject(object: THREE.Object3D): boolean {
  return isXRTeleportWalkableEnvironmentObject(object)
    || object.name.startsWith("environment:street:stripe:");
}

/** Visual-only and transform-only roots never become player collision authority. */
export function isXRTeleportBlockingEntity(
  entity: EntityState | undefined,
  entities?: ReadonlyMap<string, EntityState>,
): boolean {
  if (!entity
    || entity.kind === "effect"
    || entity.renderGeometry?.kind === "assembly"
    || entity.renderGeometry?.kind === "reality"
    || entity.collision?.enabled !== true
    || entity.collision.role !== "solid") return false;
  if (!entities) return true;

  const visited = new Set<string>([entity.id]);
  let parentId = entity.parentId;
  while (parentId) {
    if (visited.has(parentId)) return true;
    visited.add(parentId);
    const parent = entities.get(parentId);
    if (!parent) return true;
    if (parent.renderGeometry?.kind === "assembly"
      && parent.renderGeometry.collisionPolicy === "none") return false;
    parentId = parent.parentId;
  }
  return true;
}

/**
 * Convert live render-relative geometry to one semantic collision plan. Any
 * missing/non-finite bound rejects the teleport instead of silently omitting a
 * potentially blocking object.
 */
export function planThreeRendererTeleport(
  input: ThreeRendererTeleportInput,
): XRTeleportPlan {
  try {
    if (!finiteVector(input.rayOrigin)
      || !finiteVector(input.rayDirection)
      || !finiteVector(input.headWorldPosition)
      || !finiteVector(input.rigWorldPosition)
      || !finiteVector(input.renderOrigin)
      || !isXRTeleportWalkableEnvironmentObject(input.walkableSurface)) return failClosed();

    const surfaceBounds = semanticBounds(input.walkableSurface, input.renderOrigin);
    if (!surfaceBounds) return failClosed();
    const inset = XR_TELEPORT_CAPSULE.radius + XR_TELEPORT_SAFETY_MARGIN;
    const minimumX = surfaceBounds.min.x + inset;
    const maximumX = surfaceBounds.max.x - inset;
    const minimumZ = surfaceBounds.min.z + inset;
    const maximumZ = surfaceBounds.max.z - inset;
    if (!(minimumX < maximumX && minimumZ < maximumZ)) return failClosed();

    const environment = environmentObstacles(input.environmentRoot, input.renderOrigin);
    if (!environment) return failClosed();
    const entities: XRCapsuleObstacle[] = [];
    for (const candidate of input.entities) {
      if (!candidate.collision.enabled || candidate.collision.role !== "solid") continue;
      const id = candidate.id.trim();
      if (!id) return failClosed();
      const bounds = entityCollisionBounds(candidate, input.renderOrigin);
      if (!bounds) return failClosed();
      entities.push(obstacle(`entity:${id}`, bounds));
    }

    const semanticRayOrigin = input.rayOrigin.clone().add(input.renderOrigin);
    const semanticHead = input.headWorldPosition.clone().add(input.renderOrigin);
    const semanticRig = input.rigWorldPosition.clone().add(input.renderOrigin);
    const currentFeet = Object.freeze({
      x: semanticHead.x,
      y: semanticRig.y,
      z: semanticHead.z,
    });
    return planTeleport({
      ray: Object.freeze({
        origin: Object.freeze({
          x: semanticRayOrigin.x,
          y: semanticRayOrigin.y,
          z: semanticRayOrigin.z,
        }),
        direction: Object.freeze({
          x: input.rayDirection.x,
          y: input.rayDirection.y,
          z: input.rayDirection.z,
        }),
        maxDistance: input.maxDistance,
      }),
      currentFeet,
      capsule: Object.freeze({
        feet: currentFeet,
        radius: XR_TELEPORT_CAPSULE.radius,
        height: XR_TELEPORT_CAPSULE.height,
      }),
      surfaces: [Object.freeze({
        id: input.walkableSurface.name,
        height: surfaceBounds.max.y,
        boundary: Object.freeze([
          Object.freeze({ x: minimumX, y: minimumZ }),
          Object.freeze({ x: maximumX, y: minimumZ }),
          Object.freeze({ x: maximumX, y: maximumZ }),
          Object.freeze({ x: minimumX, y: maximumZ }),
        ]),
      })],
      obstacles: Object.freeze([...environment, ...entities]),
      safetyMargin: XR_TELEPORT_SAFETY_MARGIN,
    });
  } catch {
    return failClosed();
  }
}
