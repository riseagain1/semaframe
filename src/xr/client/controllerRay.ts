import type {
  XRAabb,
  XRControllerRay,
  XRPose,
  XRRayHit,
  XRRayHitKind,
  XRVec3,
} from "./contracts";
import {
  addVec3,
  finiteNumber,
  finiteVec3,
  normalizePose,
  normalizeVec3,
  rotateVec3ByQuaternion,
  scaleVec3,
  validateAabb,
  XR_MATH_EPSILON,
} from "./math";

export type XRRayTarget = Readonly<{
  id: string;
  kind?: XRRayHitKind;
  bounds: XRAabb;
  selectable?: boolean;
}>;

export function controllerRayFromPose(
  poseValue: XRPose,
  options: Readonly<{ localForward?: XRVec3; maxDistance?: number }> = {},
): XRControllerRay {
  const pose = normalizePose(poseValue, "controllerPose");
  const localForward = normalizeVec3(options.localForward ?? { x: 0, y: 0, z: -1 }, "localForward");
  const maxDistance = finiteNumber(options.maxDistance ?? 100, "maxDistance");
  if (maxDistance <= 0 || maxDistance > 1_000) throw new RangeError("maxDistance must be in (0, 1000]");
  return Object.freeze({
    origin: pose.position,
    direction: normalizeVec3(rotateVec3ByQuaternion(localForward, pose.orientation), "ray.direction"),
    maxDistance,
  });
}

function axisValue(value: XRVec3, axis: 0 | 1 | 2): number {
  return axis === 0 ? value.x : axis === 1 ? value.y : value.z;
}

function axisNormal(axis: 0 | 1 | 2, sign: number): XRVec3 {
  if (axis === 0) return { x: sign, y: 0, z: 0 };
  if (axis === 1) return { x: 0, y: sign, z: 0 };
  return { x: 0, y: 0, z: sign };
}

export function intersectControllerRayAabb(
  rayValue: XRControllerRay,
  boundsValue: XRAabb,
): Readonly<{ point: XRVec3; normal: XRVec3; distance: number }> | undefined {
  const ray: XRControllerRay = {
    origin: finiteVec3(rayValue.origin, "ray.origin"),
    direction: normalizeVec3(rayValue.direction, "ray.direction"),
    maxDistance: finiteNumber(rayValue.maxDistance, "ray.maxDistance"),
  };
  if (ray.maxDistance <= 0) throw new RangeError("ray.maxDistance must be positive");
  const bounds = validateAabb(boundsValue);
  let enter = 0;
  let exit = ray.maxDistance;
  let enterNormal: XRVec3 | undefined;
  let exitNormal: XRVec3 | undefined;

  for (const axis of [0, 1, 2] as const) {
    const origin = axisValue(ray.origin, axis);
    const direction = axisValue(ray.direction, axis);
    const minimum = axisValue(bounds.min, axis);
    const maximum = axisValue(bounds.max, axis);
    if (Math.abs(direction) <= XR_MATH_EPSILON) {
      if (origin < minimum || origin > maximum) return undefined;
      continue;
    }
    let near = (minimum - origin) / direction;
    let far = (maximum - origin) / direction;
    let nearNormal = axisNormal(axis, -Math.sign(direction));
    let farNormal = axisNormal(axis, Math.sign(direction));
    if (near > far) {
      [near, far] = [far, near];
      [nearNormal, farNormal] = [farNormal, nearNormal];
    }
    if (near > enter) {
      enter = near;
      enterNormal = nearNormal;
    }
    if (far < exit) {
      exit = far;
      exitNormal = farNormal;
    }
    if (enter > exit) return undefined;
  }

  const startsInside = enter <= XR_MATH_EPSILON && !enterNormal;
  const distance = startsInside ? exit : enter;
  const normal = startsInside ? exitNormal : enterNormal;
  if (!normal || distance < 0 || distance > ray.maxDistance) return undefined;
  return Object.freeze({
    point: Object.freeze(addVec3(ray.origin, scaleVec3(ray.direction, distance))),
    normal: Object.freeze(normal),
    distance,
  });
}

export function pickNearestControllerRayTarget(
  ray: XRControllerRay,
  targets: readonly XRRayTarget[],
): XRRayHit | undefined {
  let nearest: XRRayHit | undefined;
  for (const target of targets) {
    if (target.selectable === false) continue;
    const id = target.id.trim();
    if (!id) throw new TypeError("Ray target id cannot be empty");
    const intersection = intersectControllerRayAabb(ray, target.bounds);
    if (!intersection || (nearest && intersection.distance >= nearest.distance)) continue;
    nearest = Object.freeze({
      kind: target.kind ?? "component",
      targetId: id,
      ...intersection,
    });
  }
  return nearest;
}
