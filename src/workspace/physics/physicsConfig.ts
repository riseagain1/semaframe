import type { JSONObject, Vec3 } from "../components/componentTypes";
import {
  DEFAULT_SPATIAL_PHYSICS,
  type PhysicsConstraint,
  type SpatialPhysicsConfig,
} from "./physicsTypes";

const MAX_CONSTRAINTS = 16;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exact(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function vector(value: unknown, min = -1_000, max = 1_000): Vec3 | undefined {
  const record = object(value);
  if (!record || !exact(record, ["x", "y", "z"])) return undefined;
  if (!finite(record.x, min, max) || !finite(record.y, min, max) || !finite(record.z, min, max)) return undefined;
  return { x: record.x, y: record.y, z: record.z };
}

function constraint(value: unknown): PhysicsConstraint | undefined {
  const record = object(value);
  if (!record || !exact(record, ["id", "type", "targetId", "anchor", "targetAnchor", "axis", "limits", "enabled"])) return undefined;
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) return undefined;
  if (!(["fixed", "hinge", "slider", "ball"] as const).includes(record.type as never)) return undefined;
  if (typeof record.targetId !== "string" || !ID_PATTERN.test(record.targetId)) return undefined;
  const anchor = vector(record.anchor);
  const targetAnchor = vector(record.targetAnchor);
  const axis = vector(record.axis, -1, 1);
  if (!anchor || !targetAnchor || !axis || typeof record.enabled !== "boolean") return undefined;
  let limits: { min: number; max: number } | undefined;
  if (record.limits !== undefined) {
    const raw = object(record.limits);
    if (!raw || !exact(raw, ["min", "max"]) || !finite(raw.min, -1_000_000, 1_000_000)
      || !finite(raw.max, -1_000_000, 1_000_000) || raw.min > raw.max) return undefined;
    limits = { min: raw.min, max: raw.max };
  }
  return {
    id: record.id,
    type: record.type as PhysicsConstraint["type"],
    targetId: record.targetId,
    anchor,
    targetAnchor,
    axis,
    ...(limits ? { limits } : {}),
    enabled: record.enabled,
  };
}

export function parseSpatialPhysicsConfig(raw: unknown): SpatialPhysicsConfig | undefined {
  const record = object(raw);
  if (!record || !exact(record, [
    "enabled", "bodyType", "massKg", "centerOfMass", "friction", "restitution", "gravityScale", "stabilityMode", "constraints",
  ])) return undefined;
  // spatial-entity@1.4 did not persist the master switch. Missing means the
  // previously active behavior; current 1.5 manifests require the field.
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") return undefined;
  if (!(["static", "dynamic", "kinematic"] as const).includes(record.bodyType as never)) return undefined;
  if (!finite(record.massKg, 0.001, 1_000_000)) return undefined;
  const centerOfMass = vector(record.centerOfMass);
  if (!centerOfMass || !finite(record.friction, 0, 2) || !finite(record.restitution, 0, 1)
    || !finite(record.gravityScale, 0, 10)) return undefined;
  if (record.stabilityMode !== "report" && record.stabilityMode !== "enforce") return undefined;
  if (!Array.isArray(record.constraints) || record.constraints.length > MAX_CONSTRAINTS) return undefined;
  const constraints = record.constraints.map(constraint);
  if (constraints.some((entry) => !entry)) return undefined;
  if (new Set(constraints.map((entry) => entry!.id)).size !== constraints.length) return undefined;
  return {
    enabled: record.enabled ?? true,
    bodyType: record.bodyType as SpatialPhysicsConfig["bodyType"],
    massKg: record.massKg,
    centerOfMass,
    friction: record.friction,
    restitution: record.restitution,
    gravityScale: record.gravityScale,
    stabilityMode: record.stabilityMode,
    constraints: constraints as PhysicsConstraint[],
  };
}

export function spatialPhysicsConfigFromProps(props: Readonly<JSONObject>): SpatialPhysicsConfig | undefined {
  return props.physics === undefined ? undefined : parseSpatialPhysicsConfig(props.physics);
}

export function effectiveSpatialPhysicsConfig(props: Readonly<JSONObject>): SpatialPhysicsConfig {
  return spatialPhysicsConfigFromProps(props) ?? DEFAULT_SPATIAL_PHYSICS;
}
