import type {
  ComponentInstance,
  Vec3,
  World3DPlacement,
} from "../components/componentTypes";

type Quaternion = { x: number; y: number; z: number; w: number };

export type ResolvedWorldTransform = Readonly<{
  position: Vec3;
  rotation: Quaternion;
  scale: Vec3;
}>;

const EPSILON = 1e-12;

function add(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function multiply(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x * right.x, y: left.y * right.y, z: left.z * right.z };
}

function divide(left: Vec3, right: Vec3): Vec3 {
  if (Math.abs(right.x) <= EPSILON || Math.abs(right.y) <= EPSILON || Math.abs(right.z) <= EPSILON) {
    throw new TypeError("A world transform cannot be resolved through a zero parent scale");
  }
  return { x: left.x / right.x, y: left.y / right.y, z: left.z / right.z };
}

function normalizeQuaternion(value: Quaternion): Quaternion {
  const magnitude = Math.hypot(value.x, value.y, value.z, value.w);
  if (magnitude <= EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: value.x / magnitude,
    y: value.y / magnitude,
    z: value.z / magnitude,
    w: value.w / magnitude,
  };
}

function quaternionFromEulerXYZ(rotation: Vec3): Quaternion {
  const c1 = Math.cos(rotation.x / 2);
  const c2 = Math.cos(rotation.y / 2);
  const c3 = Math.cos(rotation.z / 2);
  const s1 = Math.sin(rotation.x / 2);
  const s2 = Math.sin(rotation.y / 2);
  const s3 = Math.sin(rotation.z / 2);
  return normalizeQuaternion({
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  });
}

function multiplyQuaternion(left: Quaternion, right: Quaternion): Quaternion {
  return normalizeQuaternion({
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  });
}

function inverseQuaternion(value: Quaternion): Quaternion {
  const normalized = normalizeQuaternion(value);
  return { x: -normalized.x, y: -normalized.y, z: -normalized.z, w: normalized.w };
}

function rotateVector(quaternion: Quaternion, value: Vec3): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = quaternion;
  const ix = qw * value.x + qy * value.z - qz * value.y;
  const iy = qw * value.y + qz * value.x - qx * value.z;
  const iz = qw * value.z + qx * value.y - qy * value.x;
  const iw = -qx * value.x - qy * value.y - qz * value.z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

/** Convert a normalized quaternion to Three.js-compatible intrinsic XYZ Euler radians. */
function eulerXYZFromQuaternion(value: Quaternion): Vec3 {
  const { x, y, z, w } = normalizeQuaternion(value);
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const rotationY = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    return {
      x: Math.atan2(-m23, m33),
      y: rotationY,
      z: Math.atan2(-m12, m11),
    };
  }
  return { x: Math.atan2(m32, m22), y: rotationY, z: 0 };
}

function world3dPlacement(component: Readonly<ComponentInstance>): World3DPlacement {
  if (component.placement.space !== "world3d") {
    throw new TypeError(`Component ${component.id} does not have a world3d transform`);
  }
  return component.placement;
}

/** Resolve a component's world transform from the authoritative parent hierarchy. */
export function resolveComponentWorldTransform(
  components: ReadonlyMap<string, ComponentInstance>,
  componentId: string,
): ResolvedWorldTransform {
  const cache = new Map<string, ResolvedWorldTransform>();
  const visiting = new Set<string>();
  const resolve = (id: string): ResolvedWorldTransform => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new TypeError(`Component hierarchy cycle includes ${id}`);
    const component = components.get(id);
    if (!component) throw new TypeError(`Unknown component ${id}`);
    const placement = world3dPlacement(component);
    visiting.add(id);
    const localRotation = quaternionFromEulerXYZ(placement.rotation);
    const parent = component.parentId ? components.get(component.parentId) : undefined;
    const parentTransform = parent && parent.placement.space === "world3d"
      ? resolve(parent.id)
      : undefined;
    const result: ResolvedWorldTransform = parentTransform
      ? {
          position: add(
            parentTransform.position,
            rotateVector(parentTransform.rotation, multiply(parentTransform.scale, placement.position)),
          ),
          rotation: multiplyQuaternion(parentTransform.rotation, localRotation),
          scale: multiply(parentTransform.scale, placement.scale),
        }
      : {
          position: structuredClone(placement.position),
          rotation: localRotation,
          scale: structuredClone(placement.scale),
        };
    visiting.delete(id);
    cache.set(id, result);
    return result;
  };
  return resolve(componentId);
}

/**
 * Resolve the local placement required to keep `world` unchanged beneath a
 * new parent. An undefined parent means a root-level world placement.
 */
export function localPlacementForWorldTransform(
  world: ResolvedWorldTransform,
  parentWorld?: ResolvedWorldTransform,
): World3DPlacement {
  if (!parentWorld) {
    return {
      space: "world3d",
      position: structuredClone(world.position),
      rotation: eulerXYZFromQuaternion(world.rotation),
      scale: structuredClone(world.scale),
    };
  }
  const inverseParentRotation = inverseQuaternion(parentWorld.rotation);
  return {
    space: "world3d",
    position: divide(
      rotateVector(inverseParentRotation, subtract(world.position, parentWorld.position)),
      parentWorld.scale,
    ),
    rotation: eulerXYZFromQuaternion(multiplyQuaternion(inverseParentRotation, world.rotation)),
    scale: divide(world.scale, parentWorld.scale),
  };
}
