import type { XRControllerRay, XRPlayerCapsule, XRVec2, XRVec3 } from "./contracts";
import {
  addVec3,
  finiteNumber,
  finiteVec3,
  normalizeVec3,
  rotateVec3AroundY,
  scaleVec3,
  subtractVec3,
  XR_MATH_EPSILON,
} from "./math";
import {
  movePlayerCapsule,
  type XRCapsuleObstacle,
  validatePlayerCapsulePlacement,
} from "./playerCapsule";

export type XRTeleportSurface = Readonly<{
  id: string;
  height: number;
  boundary: readonly XRVec2[];
  enabled?: boolean;
}>;

export type XRTeleportPlan =
  | Readonly<{
    valid: true;
    surfaceId: string;
    targetFeet: XRVec3;
    rigDelta: XRVec3;
    distance: number;
  }>
  | Readonly<{
    valid: false;
    reason: "collision" | "no_surface";
    conflicts: readonly string[];
  }>;

function pointOnSegment2(point: XRVec2, left: XRVec2, right: XRVec2): boolean {
  const cross = (point.y - left.y) * (right.x - left.x) - (point.x - left.x) * (right.y - left.y);
  if (Math.abs(cross) > 1e-8) return false;
  const dot = (point.x - left.x) * (right.x - left.x) + (point.y - left.y) * (right.y - left.y);
  const length = (right.x - left.x) ** 2 + (right.y - left.y) ** 2;
  return dot >= -1e-8 && dot <= length + 1e-8;
}

export function pointInTeleportBoundary(point: XRVec2, boundary: readonly XRVec2[]): boolean {
  if (boundary.length < 3) throw new RangeError("Teleport surface boundary requires at least three points");
  let inside = false;
  for (let index = 0, previous = boundary.length - 1; index < boundary.length; previous = index++) {
    const currentPoint = boundary[index]!;
    const previousPoint = boundary[previous]!;
    if (pointOnSegment2(point, previousPoint, currentPoint)) return true;
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function hitSurface(ray: XRControllerRay, surface: XRTeleportSurface): Readonly<{
  point: XRVec3;
  distance: number;
}> | undefined {
  const height = finiteNumber(surface.height, "surface.height");
  if (Math.abs(ray.direction.y) <= XR_MATH_EPSILON) return undefined;
  const distance = (height - ray.origin.y) / ray.direction.y;
  if (distance < 0 || distance > ray.maxDistance) return undefined;
  const point = addVec3(ray.origin, scaleVec3(ray.direction, distance));
  if (!pointInTeleportBoundary({ x: point.x, y: point.z }, surface.boundary)) return undefined;
  return { point: Object.freeze(point), distance };
}

export function planTeleport(input: Readonly<{
  ray: XRControllerRay;
  currentFeet: XRVec3;
  capsule: XRPlayerCapsule;
  surfaces: readonly XRTeleportSurface[];
  obstacles?: readonly XRCapsuleObstacle[];
  safetyMargin?: number;
}>): XRTeleportPlan {
  const maxDistance = finiteNumber(input.ray.maxDistance, "ray.maxDistance");
  if (maxDistance <= 0 || maxDistance > 1_000) throw new RangeError("ray.maxDistance must be in (0, 1000]");
  const ray: XRControllerRay = Object.freeze({
    origin: finiteVec3(input.ray.origin, "ray.origin"),
    direction: normalizeVec3(input.ray.direction, "ray.direction"),
    maxDistance,
  });
  let nearest: Readonly<{ surface: XRTeleportSurface; point: XRVec3; distance: number }> | undefined;
  for (const surface of input.surfaces) {
    if (surface.enabled === false) continue;
    const surfaceId = surface.id.trim();
    if (!surfaceId) throw new TypeError("Teleport surface id cannot be empty");
    for (const [index, point] of surface.boundary.entries()) {
      finiteNumber(point.x, `surface.boundary[${index}].x`);
      finiteNumber(point.y, `surface.boundary[${index}].y`);
    }
    const hit = hitSurface(ray, surface);
    if (hit && (!nearest || hit.distance < nearest.distance)) nearest = { surface, ...hit };
  }
  if (!nearest) return Object.freeze({ valid: false, reason: "no_surface", conflicts: Object.freeze([]) });
  const targetFeet = Object.freeze({ x: nearest.point.x, y: nearest.surface.height, z: nearest.point.z });
  const placement = validatePlayerCapsulePlacement(
    movePlayerCapsule(input.capsule, targetFeet),
    input.obstacles ?? [],
    input.safetyMargin ?? 0,
  );
  if (!placement.valid) {
    return Object.freeze({ valid: false, reason: "collision", conflicts: placement.conflicts });
  }
  return Object.freeze({
    valid: true,
    surfaceId: nearest.surface.id,
    targetFeet,
    rigDelta: Object.freeze(subtractVec3(targetFeet, finiteVec3(input.currentFeet, "currentFeet"))),
    distance: nearest.distance,
  });
}

export type XRSnapTurnPlan = Readonly<{
  deltaRadians: number;
  nextYawRadians: number;
  nextRigPosition: XRVec3;
  preservedHeadPosition: XRVec3;
}>;

function wrapAngle(radians: number): number {
  const full = Math.PI * 2;
  return ((radians + Math.PI) % full + full) % full - Math.PI;
}

/** Rotate the rig around the current head position to avoid an artificial orbit. */
export function planSnapTurn(input: Readonly<{
  direction: "left" | "right";
  incrementDegrees?: number;
  currentYawRadians: number;
  rigPosition: XRVec3;
  headWorldPosition: XRVec3;
}>): XRSnapTurnPlan {
  const increment = finiteNumber(input.incrementDegrees ?? 30, "incrementDegrees");
  if (increment <= 0 || increment > 90) throw new RangeError("incrementDegrees must be in (0, 90]");
  const currentYaw = finiteNumber(input.currentYawRadians, "currentYawRadians");
  const rigPosition = finiteVec3(input.rigPosition, "rigPosition");
  const head = finiteVec3(input.headWorldPosition, "headWorldPosition");
  const delta = increment * Math.PI / 180 * (input.direction === "left" ? 1 : -1);
  const headOffset = subtractVec3(head, rigPosition);
  const nextRigPosition = subtractVec3(head, rotateVec3AroundY(headOffset, delta));
  return Object.freeze({
    deltaRadians: delta,
    nextYawRadians: wrapAngle(currentYaw + delta),
    nextRigPosition: Object.freeze(nextRigPosition),
    preservedHeadPosition: Object.freeze(head),
  });
}
