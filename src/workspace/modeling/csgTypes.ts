import type { JSONSchema, Vec3 } from "../components/componentTypes";
import { deterministicDigest } from "../components/manifestDigest";
import {
  PARAMETRIC_PRIMITIVE_JSON_SCHEMA,
  parseParametricPrimitive,
  validateParametricPrimitive,
  type ParametricGeometryIssueCode,
  type ParametricPrimitive,
} from "./parametricGeometry";

/** Canonical, renderer-independent light-solid CSG contract. */
export const CSG_DEFINITION_VERSION = 1 as const;

/**
 * Deliberately conservative limits: CSG is an interactive modeling feature,
 * not an unbounded geometry-compute endpoint.
 */
export const CSG_DEFINITION_LIMITS = Object.freeze({
  maximumNodes: 127,
  maximumLeaves: 64,
  maximumDepth: 12,
  maximumTranslationM: 100_000,
  minimumScale: 1e-4,
  maximumScale: 100,
  maximumOutputCoordinateM: 200_000,
});

export type CsgQuaternion = Readonly<{
  x: number;
  y: number;
  z: number;
  w: number;
}>;

export type CsgTransform = Readonly<{
  translationM?: Readonly<Vec3>;
  rotationQuaternion?: CsgQuaternion;
  scale?: Readonly<Vec3>;
}>;

export type CsgPrimitiveNode = Readonly<{
  kind: "primitive";
  /** Plane is intentionally rejected because a CSG leaf must enclose volume. */
  primitive: Exclude<ParametricPrimitive, { kind: "plane" }>;
  transform?: CsgTransform;
}>;

export type CsgBooleanNode = Readonly<{
  kind: "union" | "subtract" | "intersect";
  left: CsgNode;
  right: CsgNode;
}>;

export type CsgNode = CsgPrimitiveNode | CsgBooleanNode;

export type CsgDefinition = Readonly<{
  version: typeof CSG_DEFINITION_VERSION;
  root: CsgNode;
}>;

export type CsgDefinitionIssueCode =
  | "invalid_type"
  | "missing_property"
  | "unknown_property"
  | "invalid_value"
  | "non_finite"
  | "out_of_range"
  | "non_solid"
  | "cyclic_value"
  | "limit_exceeded";

export type CsgDefinitionIssue = Readonly<{
  path: string;
  code: CsgDefinitionIssueCode;
  message: string;
}>;

const FINITE_NUMBER_SCHEMA = Object.freeze({ type: "number" });
const TRANSLATION_NUMBER_SCHEMA = Object.freeze({
  type: "number",
  minimum: -CSG_DEFINITION_LIMITS.maximumTranslationM,
  maximum: CSG_DEFINITION_LIMITS.maximumTranslationM,
});
const SCALE_NUMBER_SCHEMA = Object.freeze({
  type: "number",
  minimum: CSG_DEFINITION_LIMITS.minimumScale,
  maximum: CSG_DEFINITION_LIMITS.maximumScale,
});

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

const TRANSLATION_SCHEMA = strictObjectSchema({
  x: TRANSLATION_NUMBER_SCHEMA,
  y: TRANSLATION_NUMBER_SCHEMA,
  z: TRANSLATION_NUMBER_SCHEMA,
}, ["x", "y", "z"]);

const SCALE_SCHEMA = strictObjectSchema({
  x: SCALE_NUMBER_SCHEMA,
  y: SCALE_NUMBER_SCHEMA,
  z: SCALE_NUMBER_SCHEMA,
}, ["x", "y", "z"]);

const QUATERNION_SCHEMA = strictObjectSchema({
  x: FINITE_NUMBER_SCHEMA,
  y: FINITE_NUMBER_SCHEMA,
  z: FINITE_NUMBER_SCHEMA,
  w: FINITE_NUMBER_SCHEMA,
}, ["x", "y", "z", "w"]);

const TRANSFORM_SCHEMA = Object.freeze({
  ...strictObjectSchema({
    translationM: TRANSLATION_SCHEMA,
    rotationQuaternion: QUATERNION_SCHEMA,
    scale: SCALE_SCHEMA,
  }, []),
  minProperties: 1,
});

/**
 * Recursive command schema. Runtime validation additionally enforces depth,
 * node/leaf limits, finiteness, unit quaternions, acyclicity, and solid leaves.
 */
export const CSG_DEFINITION_JSON_SCHEMA: JSONSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["version", "root"],
  properties: {
    version: { const: CSG_DEFINITION_VERSION },
    root: { $ref: "#/$defs/node" },
  },
  $defs: {
    node: {
      oneOf: [
        strictObjectSchema({
          kind: { const: "primitive" },
          primitive: PARAMETRIC_PRIMITIVE_JSON_SCHEMA,
          transform: TRANSFORM_SCHEMA,
        }, ["kind", "primitive"]),
        strictObjectSchema({
          kind: { enum: ["union", "subtract", "intersect"] },
          left: { $ref: "#/$defs/node" },
          right: { $ref: "#/$defs/node" },
        }, ["kind", "left", "right"]),
      ],
    },
  },
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function issue(
  path: string,
  code: CsgDefinitionIssueCode,
  message: string,
): CsgDefinitionIssue {
  return Object.freeze({ path, code, message });
}

function validateKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  issues: CsgDefinitionIssue[],
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

function validateFiniteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: CsgDefinitionIssue[],
): value is number {
  if (typeof value !== "number") {
    issues.push(issue(path, "invalid_type", `${path} must be a number`));
    return false;
  }
  if (!Number.isFinite(value)) {
    issues.push(issue(path, "non_finite", `${path} must be finite`));
    return false;
  }
  if (value < minimum || value > maximum) {
    issues.push(issue(
      path,
      "out_of_range",
      `${path} must be between ${minimum} and ${maximum}`,
    ));
    return false;
  }
  return true;
}

function validateVec3(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: CsgDefinitionIssue[],
): value is Vec3 {
  const candidate = record(value);
  if (!candidate) {
    issues.push(issue(path, "invalid_type", `${path} must be an object`));
    return false;
  }
  validateKeys(candidate, ["x", "y", "z"], ["x", "y", "z"], path, issues);
  const x = validateFiniteNumber(candidate.x, `${path}.x`, minimum, maximum, issues);
  const y = validateFiniteNumber(candidate.y, `${path}.y`, minimum, maximum, issues);
  const z = validateFiniteNumber(candidate.z, `${path}.z`, minimum, maximum, issues);
  return x && y && z;
}

function validateQuaternion(
  value: unknown,
  path: string,
  issues: CsgDefinitionIssue[],
): value is CsgQuaternion {
  const candidate = record(value);
  if (!candidate) {
    issues.push(issue(path, "invalid_type", `${path} must be an object`));
    return false;
  }
  validateKeys(candidate, ["x", "y", "z", "w"], ["x", "y", "z", "w"], path, issues);
  const x = validateFiniteNumber(candidate.x, `${path}.x`, -1, 1, issues);
  const y = validateFiniteNumber(candidate.y, `${path}.y`, -1, 1, issues);
  const z = validateFiniteNumber(candidate.z, `${path}.z`, -1, 1, issues);
  const w = validateFiniteNumber(candidate.w, `${path}.w`, -1, 1, issues);
  if (!(x && y && z && w)) return false;
  const length = Math.hypot(
    candidate.x as number,
    candidate.y as number,
    candidate.z as number,
    candidate.w as number,
  );
  if (Math.abs(length - 1) > 1e-6) {
    issues.push(issue(
      path,
      "invalid_value",
      `${path} must be a unit quaternion within 1e-6`,
    ));
    return false;
  }
  return true;
}

function validateTransform(
  value: unknown,
  path: string,
  issues: CsgDefinitionIssue[],
): value is CsgTransform {
  const candidate = record(value);
  if (!candidate) {
    issues.push(issue(path, "invalid_type", `${path} must be an object`));
    return false;
  }
  validateKeys(
    candidate,
    ["translationM", "rotationQuaternion", "scale"],
    [],
    path,
    issues,
  );
  if (Object.hasOwn(candidate, "translationM")) {
    validateVec3(
      candidate.translationM,
      `${path}.translationM`,
      -CSG_DEFINITION_LIMITS.maximumTranslationM,
      CSG_DEFINITION_LIMITS.maximumTranslationM,
      issues,
    );
  }
  if (Object.hasOwn(candidate, "rotationQuaternion")) {
    validateQuaternion(candidate.rotationQuaternion, `${path}.rotationQuaternion`, issues);
  }
  if (Object.hasOwn(candidate, "scale")) {
    validateVec3(
      candidate.scale,
      `${path}.scale`,
      CSG_DEFINITION_LIMITS.minimumScale,
      CSG_DEFINITION_LIMITS.maximumScale,
      issues,
    );
  }
  return true;
}

type ValidationStats = {
  nodes: number;
  leaves: number;
  nodeLimitReported: boolean;
  leafLimitReported: boolean;
};

function validateNode(
  value: unknown,
  path: string,
  depth: number,
  ancestors: WeakSet<object>,
  stats: ValidationStats,
  issues: CsgDefinitionIssue[],
): void {
  const candidate = record(value);
  if (!candidate) {
    issues.push(issue(path, "invalid_type", `${path} must be a CSG node object`));
    return;
  }
  if (ancestors.has(candidate)) {
    issues.push(issue(path, "cyclic_value", `${path} contains a cyclic object reference`));
    return;
  }
  stats.nodes += 1;
  if (stats.nodes > CSG_DEFINITION_LIMITS.maximumNodes) {
    if (!stats.nodeLimitReported) {
      stats.nodeLimitReported = true;
      issues.push(issue(
        path,
        "limit_exceeded",
        `CSG definitions may contain at most ${CSG_DEFINITION_LIMITS.maximumNodes} nodes`,
      ));
    }
    return;
  }
  if (depth > CSG_DEFINITION_LIMITS.maximumDepth) {
    issues.push(issue(
      path,
      "limit_exceeded",
      `CSG definitions may be at most ${CSG_DEFINITION_LIMITS.maximumDepth} nodes deep`,
    ));
    return;
  }

  ancestors.add(candidate);
  try {
    switch (candidate.kind) {
      case "primitive": {
        validateKeys(candidate, ["kind", "primitive", "transform"], ["kind", "primitive"], path, issues);
        stats.leaves += 1;
        if (stats.leaves > CSG_DEFINITION_LIMITS.maximumLeaves && !stats.leafLimitReported) {
          stats.leafLimitReported = true;
          issues.push(issue(
            path,
            "limit_exceeded",
            `CSG definitions may contain at most ${CSG_DEFINITION_LIMITS.maximumLeaves} leaves`,
          ));
        }
        if (Object.hasOwn(candidate, "primitive")) {
          const primitiveIssues = validateParametricPrimitive(candidate.primitive);
          for (const primitiveIssue of primitiveIssues) {
            const suffix = primitiveIssue.path === "$" ? "" : primitiveIssue.path.slice(1);
            issues.push(issue(
              `${path}.primitive${suffix}`,
              csgIssueCodeForPrimitive(primitiveIssue.code),
              primitiveIssue.message.replace(/^\$/, `${path}.primitive`),
            ));
          }
          if (record(candidate.primitive)?.kind === "plane") {
            issues.push(issue(
              `${path}.primitive.kind`,
              "non_solid",
              "A plane has no enclosed volume and cannot be a solid CSG leaf",
            ));
          }
        }
        if (Object.hasOwn(candidate, "transform")) {
          validateTransform(candidate.transform, `${path}.transform`, issues);
        }
        break;
      }
      case "union":
      case "subtract":
      case "intersect":
        validateKeys(candidate, ["kind", "left", "right"], ["kind", "left", "right"], path, issues);
        if (Object.hasOwn(candidate, "left")) {
          validateNode(candidate.left, `${path}.left`, depth + 1, ancestors, stats, issues);
        }
        if (Object.hasOwn(candidate, "right")) {
          validateNode(candidate.right, `${path}.right`, depth + 1, ancestors, stats, issues);
        }
        break;
      default:
        if (!Object.hasOwn(candidate, "kind")) {
          issues.push(issue(`${path}.kind`, "missing_property", `${path}.kind is required`));
        } else {
          issues.push(issue(
            `${path}.kind`,
            "invalid_value",
            `${path}.kind must be primitive, union, subtract, or intersect`,
          ));
        }
    }
  } finally {
    ancestors.delete(candidate);
  }
}

function csgIssueCodeForPrimitive(code: ParametricGeometryIssueCode): CsgDefinitionIssueCode {
  switch (code) {
    case "invalid_type": return "invalid_type";
    case "missing_property": return "missing_property";
    case "unknown_property": return "unknown_property";
    case "invalid_value": return "invalid_value";
    case "non_finite": return "non_finite";
    case "out_of_range":
    case "extent_exceeded":
      return "out_of_range";
  }
}

export function validateCsgDefinition(value: unknown): readonly CsgDefinitionIssue[] {
  const issues: CsgDefinitionIssue[] = [];
  const candidate = record(value);
  if (!candidate) {
    return Object.freeze([
      issue("$", "invalid_type", "CSG definition must be an object"),
    ]);
  }
  validateKeys(candidate, ["version", "root"], ["version", "root"], "$", issues);
  if (Object.hasOwn(candidate, "version") && candidate.version !== CSG_DEFINITION_VERSION) {
    issues.push(issue(
      "$.version",
      "invalid_value",
      `$.version must be ${CSG_DEFINITION_VERSION}`,
    ));
  }
  if (Object.hasOwn(candidate, "root")) {
    validateNode(candidate.root, "$.root", 1, new WeakSet(), {
      nodes: 0,
      leaves: 0,
      nodeLimitReported: false,
      leafLimitReported: false,
    }, issues);
  }
  return Object.freeze(issues);
}

export class CsgDefinitionValidationError extends TypeError {
  readonly issues: readonly CsgDefinitionIssue[];

  constructor(issues: readonly CsgDefinitionIssue[]) {
    super(issues.map((entry) => entry.message).join("; "));
    this.name = "CsgDefinitionValidationError";
    this.issues = issues;
  }
}

function normalizedNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function frozenVec3(value: Vec3): Readonly<Vec3> {
  return Object.freeze({
    x: normalizedNumber(value.x),
    y: normalizedNumber(value.y),
    z: normalizedNumber(value.z),
  });
}

function canonicalQuaternion(value: CsgQuaternion): CsgQuaternion {
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  let x = value.x / length;
  let y = value.y / length;
  let z = value.z / length;
  let w = value.w / length;
  const firstNonZero = [w, x, y, z].find((entry) => entry !== 0) ?? 1;
  if (firstNonZero < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  return Object.freeze({
    x: normalizedNumber(x),
    y: normalizedNumber(y),
    z: normalizedNumber(z),
    w: normalizedNumber(w),
  });
}

function canonicalTransform(value: CsgTransform | undefined): CsgTransform | undefined {
  if (!value) return undefined;
  const translationM = value.translationM ? frozenVec3(value.translationM as Vec3) : undefined;
  const rotationQuaternion = value.rotationQuaternion
    ? canonicalQuaternion(value.rotationQuaternion)
    : undefined;
  const scale = value.scale ? frozenVec3(value.scale as Vec3) : undefined;
  const translationIsIdentity = !translationM
    || (translationM.x === 0 && translationM.y === 0 && translationM.z === 0);
  const rotationIsIdentity = !rotationQuaternion
    || (rotationQuaternion.x === 0
      && rotationQuaternion.y === 0
      && rotationQuaternion.z === 0
      && rotationQuaternion.w === 1);
  const scaleIsIdentity = !scale || (scale.x === 1 && scale.y === 1 && scale.z === 1);
  if (translationIsIdentity && rotationIsIdentity && scaleIsIdentity) return undefined;
  return Object.freeze({
    ...(translationIsIdentity ? {} : { translationM }),
    ...(rotationIsIdentity ? {} : { rotationQuaternion }),
    ...(scaleIsIdentity ? {} : { scale }),
  });
}

function canonicalNode(value: CsgNode): CsgNode {
  if (value.kind === "primitive") {
    const primitive = parseParametricPrimitive(value.primitive);
    if (primitive.kind === "plane") {
      throw new CsgDefinitionValidationError([
        issue("$.root.primitive.kind", "non_solid", "A plane cannot be a CSG leaf"),
      ]);
    }
    const transform = canonicalTransform(value.transform);
    return Object.freeze({
      kind: "primitive",
      primitive,
      ...(transform ? { transform } : {}),
    });
  }
  return Object.freeze({
    kind: value.kind,
    left: canonicalNode(value.left),
    right: canonicalNode(value.right),
  });
}

export function parseCsgDefinition(value: unknown): CsgDefinition {
  const issues = validateCsgDefinition(value);
  if (issues.length > 0) throw new CsgDefinitionValidationError(issues);
  const candidate = value as CsgDefinition;
  return Object.freeze({
    version: CSG_DEFINITION_VERSION,
    root: canonicalNode(candidate.root),
  });
}

export function isCsgDefinition(value: unknown): value is CsgDefinition {
  return validateCsgDefinition(value).length === 0;
}

export function csgDefinitionDigest(value: unknown): string {
  const definition = parseCsgDefinition(value);
  return `csg-definition-v${CSG_DEFINITION_VERSION}:${deterministicDigest(definition)}`;
}
