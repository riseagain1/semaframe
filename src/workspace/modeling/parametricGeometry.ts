import type { JSONSchema, Vec2, Vec3 } from "../components/componentTypes";
import { deterministicDigest } from "../components/manifestDigest";
import type { SpatialBounds } from "../spatial/spatialTypes";

/**
 * Version of the canonical, renderer-independent parametric geometry contract.
 * Increment this when a descriptor's meaning or canonical digest input changes.
 */
export const PARAMETRIC_GEOMETRY_VERSION = 1 as const;

/**
 * Browser-safe limits for one primitive. Dimensions are always expressed in SI
 * metres and describe the evaluated full extent, not renderer-specific scale.
 */
export const PARAMETRIC_GEOMETRY_LIMITS = Object.freeze({
  minimumDimensionM: 1e-6,
  maximumExtentM: 1_000,
  maximumRadiusM: 500,
});

export type ParametricAxis = "x" | "y" | "z";

export type ParametricBox = Readonly<{
  kind: "box";
  sizeM: Readonly<Vec3>;
}>;

export type ParametricSphere = Readonly<{
  kind: "sphere";
  radiusM: number;
}>;

export type ParametricCylinder = Readonly<{
  kind: "cylinder";
  radiusM: number;
  /** End-to-end length along `axis`. */
  heightM: number;
  axis: ParametricAxis;
}>;

export type ParametricCone = Readonly<{
  kind: "cone";
  radiusM: number;
  /** End-to-end length from the base to the apex along `axis`. */
  heightM: number;
  axis: ParametricAxis;
}>;

export type ParametricCapsule = Readonly<{
  kind: "capsule";
  radiusM: number;
  /** Length of the cylindrical section; hemispherical caps are additional. */
  cylinderHeightM: number;
  axis: ParametricAxis;
}>;

export type ParametricPlane = Readonly<{
  kind: "plane";
  /** Dimensions along the two world axes other than `normalAxis`. */
  sizeM: Readonly<Vec2>;
  normalAxis: ParametricAxis;
}>;

/** Closed set of exact, origin-centred primitives supported by Modeling 1.0. */
export type ParametricPrimitive =
  | ParametricBox
  | ParametricSphere
  | ParametricCylinder
  | ParametricCone
  | ParametricCapsule
  | ParametricPlane;

type ColliderBase = Readonly<{ centerM: Readonly<Vec3> }>;

/** Analytic collision shape derived from the same parameters as the render geometry. */
export type ParametricCollider =
  | (ColliderBase & Readonly<{ shape: "box"; sizeM: Readonly<Vec3> }>)
  | (ColliderBase & Readonly<{ shape: "sphere"; radiusM: number }>)
  | (ColliderBase & Readonly<{
    shape: "cylinder";
    radiusM: number;
    heightM: number;
    axis: ParametricAxis;
  }>)
  | (ColliderBase & Readonly<{
    shape: "cone";
    radiusM: number;
    heightM: number;
    axis: ParametricAxis;
    /** The base is on the negative side of the axis and the apex on the positive side. */
    baseDirection: "negative_axis";
  }>)
  | (ColliderBase & Readonly<{
    shape: "capsule";
    radiusM: number;
    cylinderHeightM: number;
    axis: ParametricAxis;
  }>)
  | (ColliderBase & Readonly<{
    shape: "plane";
    sizeM: Readonly<Vec2>;
    normalAxis: ParametricAxis;
    twoSided: true;
  }>);

export type ParametricGeometryIssueCode =
  | "invalid_type"
  | "missing_property"
  | "unknown_property"
  | "invalid_value"
  | "non_finite"
  | "out_of_range"
  | "extent_exceeded";

export type ParametricGeometryIssue = Readonly<{
  path: string;
  code: ParametricGeometryIssueCode;
  message: string;
}>;

export type ParametricGeometryEvaluation = Readonly<{
  primitive: ParametricPrimitive;
  bounds: SpatialBounds;
  volumeM3: number;
  collider: ParametricCollider;
  digest: string;
}>;

const DIMENSION_SCHEMA = Object.freeze({
  type: "number",
  minimum: PARAMETRIC_GEOMETRY_LIMITS.minimumDimensionM,
  maximum: PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM,
});
const RADIUS_SCHEMA = Object.freeze({
  type: "number",
  minimum: PARAMETRIC_GEOMETRY_LIMITS.minimumDimensionM,
  maximum: PARAMETRIC_GEOMETRY_LIMITS.maximumRadiusM,
});
const AXIS_SCHEMA = Object.freeze({ enum: ["x", "y", "z"] });

function strictObjectSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    properties,
    required: [...required],
  });
}

const SIZE_2_SCHEMA = strictObjectSchema({
  x: DIMENSION_SCHEMA,
  y: DIMENSION_SCHEMA,
}, ["x", "y"]);

const SIZE_3_SCHEMA = strictObjectSchema({
  x: DIMENSION_SCHEMA,
  y: DIMENSION_SCHEMA,
  z: DIMENSION_SCHEMA,
}, ["x", "y", "z"]);

/**
 * JSON Schema for command/manifests. Runtime parsing remains authoritative for
 * the capsule's combined `cylinderHeightM + 2 * radiusM` extent constraint.
 */
export const PARAMETRIC_PRIMITIVE_JSON_SCHEMA: JSONSchema = Object.freeze({
  oneOf: [
    strictObjectSchema({ kind: { const: "box" }, sizeM: SIZE_3_SCHEMA }, ["kind", "sizeM"]),
    strictObjectSchema({ kind: { const: "sphere" }, radiusM: RADIUS_SCHEMA }, ["kind", "radiusM"]),
    strictObjectSchema({
      kind: { const: "cylinder" },
      radiusM: RADIUS_SCHEMA,
      heightM: DIMENSION_SCHEMA,
      axis: AXIS_SCHEMA,
    }, ["kind", "radiusM", "heightM", "axis"]),
    strictObjectSchema({
      kind: { const: "cone" },
      radiusM: RADIUS_SCHEMA,
      heightM: DIMENSION_SCHEMA,
      axis: AXIS_SCHEMA,
    }, ["kind", "radiusM", "heightM", "axis"]),
    strictObjectSchema({
      kind: { const: "capsule" },
      radiusM: RADIUS_SCHEMA,
      cylinderHeightM: DIMENSION_SCHEMA,
      axis: AXIS_SCHEMA,
    }, ["kind", "radiusM", "cylinderHeightM", "axis"]),
    strictObjectSchema({
      kind: { const: "plane" },
      sizeM: SIZE_2_SCHEMA,
      normalAxis: AXIS_SCHEMA,
    }, ["kind", "sizeM", "normalAxis"]),
  ],
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function issue(
  path: string,
  code: ParametricGeometryIssueCode,
  message: string,
): ParametricGeometryIssue {
  return Object.freeze({ path, code, message });
}

function validateKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  issues: ParametricGeometryIssue[],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      issues.push(issue(`${path}.${key}`, "missing_property", `${path}.${key} is required`));
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(issue(`${path}.${key}`, "unknown_property", `${path}.${key} is not allowed`));
    }
  }
}

function validateDimension(
  value: unknown,
  path: string,
  maximum: number,
  issues: ParametricGeometryIssue[],
): value is number {
  if (typeof value !== "number") {
    issues.push(issue(path, "invalid_type", `${path} must be a number in metres`));
    return false;
  }
  if (!Number.isFinite(value)) {
    issues.push(issue(path, "non_finite", `${path} must be finite`));
    return false;
  }
  if (value < PARAMETRIC_GEOMETRY_LIMITS.minimumDimensionM || value > maximum) {
    issues.push(issue(
      path,
      "out_of_range",
      `${path} must be between ${PARAMETRIC_GEOMETRY_LIMITS.minimumDimensionM} and ${maximum} metres`,
    ));
    return false;
  }
  return true;
}

function validateAxis(
  value: unknown,
  path: string,
  issues: ParametricGeometryIssue[],
): value is ParametricAxis {
  if (value !== "x" && value !== "y" && value !== "z") {
    issues.push(issue(path, "invalid_value", `${path} must be one of x, y, or z`));
    return false;
  }
  return true;
}

function validateSize2(
  value: unknown,
  path: string,
  issues: ParametricGeometryIssue[],
): value is Vec2 {
  const candidate = record(value);
  if (!candidate) {
    issues.push(issue(path, "invalid_type", `${path} must be an object`));
    return false;
  }
  validateKeys(candidate, ["x", "y"], ["x", "y"], path, issues);
  const x = validateDimension(
    candidate.x,
    `${path}.x`,
    PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM,
    issues,
  );
  const y = validateDimension(
    candidate.y,
    `${path}.y`,
    PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM,
    issues,
  );
  return x && y;
}

function validateSize3(
  value: unknown,
  path: string,
  issues: ParametricGeometryIssue[],
): value is Vec3 {
  const candidate = record(value);
  if (!candidate) {
    issues.push(issue(path, "invalid_type", `${path} must be an object`));
    return false;
  }
  validateKeys(candidate, ["x", "y", "z"], ["x", "y", "z"], path, issues);
  const x = validateDimension(
    candidate.x,
    `${path}.x`,
    PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM,
    issues,
  );
  const y = validateDimension(
    candidate.y,
    `${path}.y`,
    PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM,
    issues,
  );
  const z = validateDimension(
    candidate.z,
    `${path}.z`,
    PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM,
    issues,
  );
  return x && y && z;
}

export function validateParametricPrimitive(value: unknown): readonly ParametricGeometryIssue[] {
  const issues: ParametricGeometryIssue[] = [];
  const candidate = record(value);
  if (!candidate) {
    return Object.freeze([
      issue("$", "invalid_type", "Parametric primitive must be an object"),
    ]);
  }
  if (!Object.hasOwn(candidate, "kind")) {
    return Object.freeze([
      issue("$.kind", "missing_property", "$.kind is required"),
    ]);
  }

  switch (candidate.kind) {
    case "box":
      validateKeys(candidate, ["kind", "sizeM"], ["kind", "sizeM"], "$", issues);
      if (Object.hasOwn(candidate, "sizeM")) validateSize3(candidate.sizeM, "$.sizeM", issues);
      break;
    case "sphere":
      validateKeys(candidate, ["kind", "radiusM"], ["kind", "radiusM"], "$", issues);
      if (Object.hasOwn(candidate, "radiusM")) {
        validateDimension(
          candidate.radiusM,
          "$.radiusM",
          PARAMETRIC_GEOMETRY_LIMITS.maximumRadiusM,
          issues,
        );
      }
      break;
    case "cylinder":
    case "cone":
      validateKeys(
        candidate,
        ["kind", "radiusM", "heightM", "axis"],
        ["kind", "radiusM", "heightM", "axis"],
        "$",
        issues,
      );
      if (Object.hasOwn(candidate, "radiusM")) {
        validateDimension(
          candidate.radiusM,
          "$.radiusM",
          PARAMETRIC_GEOMETRY_LIMITS.maximumRadiusM,
          issues,
        );
      }
      if (Object.hasOwn(candidate, "heightM")) {
        validateDimension(
          candidate.heightM,
          "$.heightM",
          PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM,
          issues,
        );
      }
      if (Object.hasOwn(candidate, "axis")) validateAxis(candidate.axis, "$.axis", issues);
      break;
    case "capsule": {
      validateKeys(
        candidate,
        ["kind", "radiusM", "cylinderHeightM", "axis"],
        ["kind", "radiusM", "cylinderHeightM", "axis"],
        "$",
        issues,
      );
      const radiusValid = Object.hasOwn(candidate, "radiusM") && validateDimension(
        candidate.radiusM,
        "$.radiusM",
        PARAMETRIC_GEOMETRY_LIMITS.maximumRadiusM,
        issues,
      );
      const heightValid = Object.hasOwn(candidate, "cylinderHeightM") && validateDimension(
        candidate.cylinderHeightM,
        "$.cylinderHeightM",
        PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM,
        issues,
      );
      if (Object.hasOwn(candidate, "axis")) validateAxis(candidate.axis, "$.axis", issues);
      if (radiusValid && heightValid
        && (candidate.cylinderHeightM as number) + 2 * (candidate.radiusM as number)
          > PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM) {
        issues.push(issue(
          "$",
          "extent_exceeded",
          `Capsule total extent must not exceed ${PARAMETRIC_GEOMETRY_LIMITS.maximumExtentM} metres`,
        ));
      }
      break;
    }
    case "plane":
      validateKeys(
        candidate,
        ["kind", "sizeM", "normalAxis"],
        ["kind", "sizeM", "normalAxis"],
        "$",
        issues,
      );
      if (Object.hasOwn(candidate, "sizeM")) validateSize2(candidate.sizeM, "$.sizeM", issues);
      if (Object.hasOwn(candidate, "normalAxis")) {
        validateAxis(candidate.normalAxis, "$.normalAxis", issues);
      }
      break;
    default:
      issues.push(issue(
        "$.kind",
        "invalid_value",
        "$.kind must be box, sphere, cylinder, cone, capsule, or plane",
      ));
  }
  return Object.freeze(issues);
}

export class ParametricGeometryValidationError extends TypeError {
  readonly issues: readonly ParametricGeometryIssue[];

  constructor(issues: readonly ParametricGeometryIssue[]) {
    super(issues.map((entry) => entry.message).join("; "));
    this.name = "ParametricGeometryValidationError";
    this.issues = issues;
  }
}

function normalizedNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function frozenVec2(value: Vec2): Readonly<Vec2> {
  return Object.freeze({ x: normalizedNumber(value.x), y: normalizedNumber(value.y) });
}

function frozenVec3(value: Vec3): Readonly<Vec3> {
  return Object.freeze({
    x: normalizedNumber(value.x),
    y: normalizedNumber(value.y),
    z: normalizedNumber(value.z),
  });
}

export function parseParametricPrimitive(value: unknown): ParametricPrimitive {
  const issues = validateParametricPrimitive(value);
  if (issues.length > 0) throw new ParametricGeometryValidationError(issues);
  const candidate = value as ParametricPrimitive;
  switch (candidate.kind) {
    case "box":
      return Object.freeze({ kind: "box", sizeM: frozenVec3(candidate.sizeM) });
    case "sphere":
      return Object.freeze({ kind: "sphere", radiusM: normalizedNumber(candidate.radiusM) });
    case "cylinder":
      return Object.freeze({
        kind: "cylinder",
        radiusM: normalizedNumber(candidate.radiusM),
        heightM: normalizedNumber(candidate.heightM),
        axis: candidate.axis,
      });
    case "cone":
      return Object.freeze({
        kind: "cone",
        radiusM: normalizedNumber(candidate.radiusM),
        heightM: normalizedNumber(candidate.heightM),
        axis: candidate.axis,
      });
    case "capsule":
      return Object.freeze({
        kind: "capsule",
        radiusM: normalizedNumber(candidate.radiusM),
        cylinderHeightM: normalizedNumber(candidate.cylinderHeightM),
        axis: candidate.axis,
      });
    case "plane":
      return Object.freeze({
        kind: "plane",
        sizeM: frozenVec2(candidate.sizeM),
        normalAxis: candidate.normalAxis,
      });
  }
}

export function isParametricPrimitive(value: unknown): value is ParametricPrimitive {
  return validateParametricPrimitive(value).length === 0;
}

function zero(): Readonly<Vec3> {
  return Object.freeze({ x: 0, y: 0, z: 0 });
}

function radialHalfExtents(
  axis: ParametricAxis,
  axialHalfExtent: number,
  radialExtent: number,
): Vec3 {
  switch (axis) {
    case "x": return { x: axialHalfExtent, y: radialExtent, z: radialExtent };
    case "y": return { x: radialExtent, y: axialHalfExtent, z: radialExtent };
    case "z": return { x: radialExtent, y: radialExtent, z: axialHalfExtent };
  }
}

function planeHalfExtents(plane: ParametricPlane): Vec3 {
  switch (plane.normalAxis) {
    case "x": return { x: 0, y: plane.sizeM.x / 2, z: plane.sizeM.y / 2 };
    case "y": return { x: plane.sizeM.x / 2, y: 0, z: plane.sizeM.y / 2 };
    case "z": return { x: plane.sizeM.x / 2, y: plane.sizeM.y / 2, z: 0 };
  }
}

function halfExtents(primitive: ParametricPrimitive): Vec3 {
  switch (primitive.kind) {
    case "box":
      return { x: primitive.sizeM.x / 2, y: primitive.sizeM.y / 2, z: primitive.sizeM.z / 2 };
    case "sphere":
      return { x: primitive.radiusM, y: primitive.radiusM, z: primitive.radiusM };
    case "cylinder":
    case "cone":
      return radialHalfExtents(primitive.axis, primitive.heightM / 2, primitive.radiusM);
    case "capsule":
      return radialHalfExtents(
        primitive.axis,
        primitive.cylinderHeightM / 2 + primitive.radiusM,
        primitive.radiusM,
      );
    case "plane":
      return planeHalfExtents(primitive);
  }
}

function boundsForPrimitive(primitive: ParametricPrimitive): SpatialBounds {
  const half = halfExtents(primitive);
  return Object.freeze({
    min: frozenVec3({ x: -half.x, y: -half.y, z: -half.z }),
    max: frozenVec3(half),
    center: zero(),
    size: frozenVec3({ x: 2 * half.x, y: 2 * half.y, z: 2 * half.z }),
  });
}

export function deriveParametricBounds(value: unknown): SpatialBounds {
  return boundsForPrimitive(parseParametricPrimitive(value));
}

function volumeForPrimitive(primitive: ParametricPrimitive): number {
  switch (primitive.kind) {
    case "box":
      return primitive.sizeM.x * primitive.sizeM.y * primitive.sizeM.z;
    case "sphere":
      return (4 / 3) * Math.PI * primitive.radiusM ** 3;
    case "cylinder":
      return Math.PI * primitive.radiusM ** 2 * primitive.heightM;
    case "cone":
      return (Math.PI * primitive.radiusM ** 2 * primitive.heightM) / 3;
    case "capsule":
      return Math.PI * primitive.radiusM ** 2 * primitive.cylinderHeightM
        + (4 / 3) * Math.PI * primitive.radiusM ** 3;
    case "plane":
      return 0;
  }
}

export function deriveParametricVolumeM3(value: unknown): number {
  return volumeForPrimitive(parseParametricPrimitive(value));
}

function colliderForPrimitive(primitive: ParametricPrimitive): ParametricCollider {
  const centerM = zero();
  switch (primitive.kind) {
    case "box":
      return Object.freeze({ shape: "box", centerM, sizeM: frozenVec3(primitive.sizeM) });
    case "sphere":
      return Object.freeze({ shape: "sphere", centerM, radiusM: primitive.radiusM });
    case "cylinder":
      return Object.freeze({
        shape: "cylinder",
        centerM,
        radiusM: primitive.radiusM,
        heightM: primitive.heightM,
        axis: primitive.axis,
      });
    case "cone":
      return Object.freeze({
        shape: "cone",
        centerM,
        radiusM: primitive.radiusM,
        heightM: primitive.heightM,
        axis: primitive.axis,
        baseDirection: "negative_axis",
      });
    case "capsule":
      return Object.freeze({
        shape: "capsule",
        centerM,
        radiusM: primitive.radiusM,
        cylinderHeightM: primitive.cylinderHeightM,
        axis: primitive.axis,
      });
    case "plane":
      return Object.freeze({
        shape: "plane",
        centerM,
        sizeM: frozenVec2(primitive.sizeM),
        normalAxis: primitive.normalAxis,
        twoSided: true,
      });
  }
}

export function deriveParametricCollider(value: unknown): ParametricCollider {
  return colliderForPrimitive(parseParametricPrimitive(value));
}

/**
 * Stable application digest for cache/replay identity. This is deliberately
 * not a cryptographic trust primitive; security-sensitive packages must add a
 * cryptographic content hash at their boundary.
 */
export function parametricGeometryDigest(value: unknown): string {
  const primitive = parseParametricPrimitive(value);
  return `geometry-v${PARAMETRIC_GEOMETRY_VERSION}:${deterministicDigest({
    version: PARAMETRIC_GEOMETRY_VERSION,
    primitive,
  })}`;
}

/** Evaluates every geometry projection from one validated canonical descriptor. */
export function evaluateParametricGeometry(value: unknown): ParametricGeometryEvaluation {
  const primitive = parseParametricPrimitive(value);
  return Object.freeze({
    primitive,
    bounds: boundsForPrimitive(primitive),
    volumeM3: volumeForPrimitive(primitive),
    collider: colliderForPrimitive(primitive),
    digest: parametricGeometryDigest(primitive),
  });
}
