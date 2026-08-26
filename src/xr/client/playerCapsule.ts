import type { XRAabb, XRPlayerCapsule, XRVec3 } from "./contracts";
import { finiteNumber, finiteVec3, validateAabb } from "./math";

export type XRCapsuleObstacle = Readonly<{
  id: string;
  bounds: XRAabb;
  enabled?: boolean;
}>;

export type XRCapsulePlacementResult = Readonly<{
  valid: boolean;
  conflicts: readonly string[];
}>;

export function normalizePlayerCapsule(value: XRPlayerCapsule): XRPlayerCapsule {
  const feet = finiteVec3(value.feet, "capsule.feet");
  const radius = finiteNumber(value.radius, "capsule.radius");
  const height = finiteNumber(value.height, "capsule.height");
  if (radius <= 0 || radius > 5) throw new RangeError("capsule.radius must be in (0, 5]");
  if (height < radius * 2 || height > 10) {
    throw new RangeError("capsule.height must be at least twice its radius and no more than 10");
  }
  return Object.freeze({ feet, radius, height });
}

function intervalDistance(minimum: number, maximum: number, value: number): number {
  if (value < minimum) return minimum - value;
  if (value > maximum) return value - maximum;
  return 0;
}

function intervalGap(leftMin: number, leftMax: number, rightMin: number, rightMax: number): number {
  if (leftMax < rightMin) return rightMin - leftMax;
  if (rightMax < leftMin) return leftMin - rightMax;
  return 0;
}

/** Exact vertical capsule versus axis-aligned box test. */
export function playerCapsuleIntersectsAabb(
  capsuleValue: XRPlayerCapsule,
  boundsValue: XRAabb,
  margin = 0,
): boolean {
  const capsule = normalizePlayerCapsule(capsuleValue);
  const bounds = validateAabb(boundsValue);
  const safeMargin = finiteNumber(margin, "margin");
  if (safeMargin < 0 || safeMargin > 5) throw new RangeError("margin must be in [0, 5]");
  const radius = capsule.radius + safeMargin;
  const segmentMinimumY = capsule.feet.y + capsule.radius;
  const segmentMaximumY = capsule.feet.y + capsule.height - capsule.radius;
  const dx = intervalDistance(bounds.min.x, bounds.max.x, capsule.feet.x);
  const dz = intervalDistance(bounds.min.z, bounds.max.z, capsule.feet.z);
  const dy = intervalGap(segmentMinimumY, segmentMaximumY, bounds.min.y, bounds.max.y);
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

export function playerCapsuleBounds(capsuleValue: XRPlayerCapsule): XRAabb {
  const capsule = normalizePlayerCapsule(capsuleValue);
  return Object.freeze({
    min: Object.freeze({
      x: capsule.feet.x - capsule.radius,
      y: capsule.feet.y,
      z: capsule.feet.z - capsule.radius,
    }),
    max: Object.freeze({
      x: capsule.feet.x + capsule.radius,
      y: capsule.feet.y + capsule.height,
      z: capsule.feet.z + capsule.radius,
    }),
  });
}

export function validatePlayerCapsulePlacement(
  capsule: XRPlayerCapsule,
  obstacles: readonly XRCapsuleObstacle[],
  margin = 0,
): XRCapsulePlacementResult {
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const obstacle of obstacles) {
    const normalized = obstacle.id.trim();
    if (!normalized) throw new TypeError("Capsule obstacle id cannot be empty");
    if (seen.has(normalized)) throw new TypeError(`Capsule obstacle id ${normalized} is duplicated`);
    seen.add(normalized);
    if (obstacle.enabled !== false && playerCapsuleIntersectsAabb(capsule, obstacle.bounds, margin)) {
      conflicts.push(normalized);
    }
  }
  return Object.freeze({ valid: conflicts.length === 0, conflicts: Object.freeze(conflicts) });
}

export function movePlayerCapsule(capsule: XRPlayerCapsule, feet: XRVec3): XRPlayerCapsule {
  const normalized = normalizePlayerCapsule(capsule);
  return Object.freeze({ ...normalized, feet: finiteVec3(feet, "feet") });
}
