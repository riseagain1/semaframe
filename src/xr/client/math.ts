import type { XRAabb, XRPose, XRQuaternion, XRVec3 } from "./contracts";

export const XR_MATH_EPSILON = 1e-9;

export function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

export function finiteVec3(value: XRVec3, label: string): XRVec3 {
  return Object.freeze({
    x: finiteNumber(value.x, `${label}.x`),
    y: finiteNumber(value.y, `${label}.y`),
    z: finiteNumber(value.z, `${label}.z`),
  });
}

export function addVec3(left: XRVec3, right: XRVec3): XRVec3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

export function subtractVec3(left: XRVec3, right: XRVec3): XRVec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

export function scaleVec3(value: XRVec3, scale: number): XRVec3 {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

export function dotVec3(left: XRVec3, right: XRVec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function lengthSquaredVec3(value: XRVec3): number {
  return dotVec3(value, value);
}

export function normalizeVec3(value: XRVec3, label = "vector"): XRVec3 {
  const finite = finiteVec3(value, label);
  const length = Math.sqrt(lengthSquaredVec3(finite));
  if (length <= XR_MATH_EPSILON) throw new RangeError(`${label} must have non-zero length`);
  return Object.freeze(scaleVec3(finite, 1 / length));
}

export function normalizeQuaternion(value: XRQuaternion, label = "orientation"): XRQuaternion {
  const x = finiteNumber(value.x, `${label}.x`);
  const y = finiteNumber(value.y, `${label}.y`);
  const z = finiteNumber(value.z, `${label}.z`);
  const w = finiteNumber(value.w, `${label}.w`);
  const length = Math.hypot(x, y, z, w);
  if (length <= XR_MATH_EPSILON) throw new RangeError(`${label} must have non-zero length`);
  return Object.freeze({ x: x / length, y: y / length, z: z / length, w: w / length });
}

export function normalizePose(value: XRPose, label = "pose"): XRPose {
  return Object.freeze({
    position: finiteVec3(value.position, `${label}.position`),
    orientation: normalizeQuaternion(value.orientation, `${label}.orientation`),
  });
}

/** Rotate a vector by a normalized quaternion. */
export function rotateVec3ByQuaternion(value: XRVec3, quaternion: XRQuaternion): XRVec3 {
  const q = normalizeQuaternion(quaternion);
  const qVector = { x: q.x, y: q.y, z: q.z };
  const uv = {
    x: qVector.y * value.z - qVector.z * value.y,
    y: qVector.z * value.x - qVector.x * value.z,
    z: qVector.x * value.y - qVector.y * value.x,
  };
  const uuv = {
    x: qVector.y * uv.z - qVector.z * uv.y,
    y: qVector.z * uv.x - qVector.x * uv.z,
    z: qVector.x * uv.y - qVector.y * uv.x,
  };
  return addVec3(value, addVec3(scaleVec3(uv, 2 * q.w), scaleVec3(uuv, 2)));
}

export function rotateVec3AroundY(value: XRVec3, radians: number): XRVec3 {
  finiteNumber(radians, "radians");
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: value.x * cosine + value.z * sine,
    y: value.y,
    z: -value.x * sine + value.z * cosine,
  };
}

export function validateAabb(bounds: XRAabb, label = "bounds"): XRAabb {
  const min = finiteVec3(bounds.min, `${label}.min`);
  const max = finiteVec3(bounds.max, `${label}.max`);
  if (min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new RangeError(`${label} min must not exceed max`);
  }
  return Object.freeze({ min, max });
}

export function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
