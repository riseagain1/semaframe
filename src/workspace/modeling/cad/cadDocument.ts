import { z } from "zod";
import { deterministicDigest } from "../../components/manifestDigest";
import {
  CAD_FEATURE_SCHEMA,
  type CadFeature,
  type CadProfileRef,
} from "./cadFeatures";
import {
  CAD_PARAMETER_SCHEMA,
  evaluateCadAngle,
  evaluateCadExpression,
  evaluateCadLength,
  evaluateCadParameters,
  type CadExpression,
  type CadParameter,
} from "./cadParameters";
import { CAD_SKETCH_SOLVER_VERSION, parseCadSketchDefinition } from "./cadSketch";

export const CAD_PART_DEFINITION_FORMAT_VERSION = "1.0" as const;
export const CAD_EVALUATION_EVIDENCE_FORMAT_VERSION = "1.0" as const;
export const CAD_PART_EVALUATOR_VERSION = "1.0.0" as const;

export const CAD_PART_LIMITS = Object.freeze({
  maximumParameters: 256,
  maximumFeatures: 256,
  maximumActiveBodies: 64,
  maximumDocumentBytes: 1_048_576,
  maximumMeshVertices: 500_000,
  maximumMeshTriangles: 1_000_000,
  maximumMeshFaceGroups: 50_000,
  maximumMeshBytes: 33_554_432,
  minimumLengthM: 1e-6,
  maximumLengthM: 1_000,
  maximumPatternCount: 256,
});

export type CadBoundsV1 = Readonly<{
  min: Readonly<{ x: number; y: number; z: number }>;
  max: Readonly<{ x: number; y: number; z: number }>;
  size: Readonly<{ x: number; y: number; z: number }>;
  center: Readonly<{ x: number; y: number; z: number }>;
}>;

export type CadEvaluationBodyEvidenceV1 = Readonly<{
  bodyId: string;
  bounds: CadBoundsV1;
  volumeM3: number;
  surfaceAreaM2: number;
  centerOfMassM: Readonly<{ x: number; y: number; z: number }>;
  valid: true;
}>;

export type CadEvaluationDiagnosticV1 = Readonly<{
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  featureId?: string;
}>;

/** Compact, replay-safe evidence. OCCT handles and triangle buffers are deliberately excluded. */
export type CadEvaluationEvidenceV1 = Readonly<{
  formatVersion: typeof CAD_EVALUATION_EVIDENCE_FORMAT_VERSION;
  definitionDigest: string;
  evaluatorVersion: typeof CAD_PART_EVALUATOR_VERSION;
  sketchSolverVersion: typeof CAD_SKETCH_SOLVER_VERSION;
  exactness: "brep";
  status: "valid";
  bodies: readonly CadEvaluationBodyEvidenceV1[];
  overallBounds: CadBoundsV1;
  diagnostics: readonly CadEvaluationDiagnosticV1[];
}>;

export type CadPartDefinitionV1 = Readonly<{
  formatVersion: typeof CAD_PART_DEFINITION_FORMAT_VERSION;
  partId: string;
  displayName: string;
  units: "metre";
  parameters: readonly CadParameter[];
  history: readonly CadFeature[];
  activeBodyIds: readonly string[];
}>;

export type CadDocumentEdit =
  | Readonly<{ kind: "rename_part"; displayName: string }>
  | Readonly<{ kind: "set_parameter"; parameter: CadParameter }>
  | Readonly<{ kind: "delete_parameter"; parameterId: string }>
  | Readonly<{ kind: "upsert_feature"; feature: CadFeature; beforeFeatureId?: string }>
  | Readonly<{ kind: "delete_feature"; featureId: string }>
  | Readonly<{ kind: "reorder_feature"; featureId: string; beforeFeatureId?: string }>
  | Readonly<{ kind: "suppress_feature"; featureId: string; suppressed: boolean }>
  | Readonly<{ kind: "set_active_bodies"; bodyIds: readonly string[] }>;

export class CadDocumentError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_cad_document"
      | "cad_document_too_large"
      | "duplicate_cad_identity"
      | "unknown_feature_reference"
      | "unknown_body_reference"
      | "invalid_feature_order"
      | "invalid_feature_value"
      | "invalid_cad_edit"
      | "invalid_cad_evidence"
      | "cad_evidence_mismatch",
    readonly path?: string,
  ) {
    super(message);
    this.name = "CadDocumentError";
  }
}

const ID = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u);
// A sketch origin and two local axes can combine before a revolve around a
// remote axis. This remains bounded while accommodating every schema-valid V1 input.
const EVIDENCE_COORDINATE = z.number().finite().min(-5_000_000).max(5_000_000);
const EVIDENCE_VECTOR = z.strictObject({
  x: EVIDENCE_COORDINATE,
  y: EVIDENCE_COORDINATE,
  z: EVIDENCE_COORDINATE,
});
const EVIDENCE_BOUNDS = z.strictObject({
  min: EVIDENCE_VECTOR,
  max: EVIDENCE_VECTOR,
  size: z.strictObject({
    x: z.number().finite().min(0).max(10_000_000),
    y: z.number().finite().min(0).max(10_000_000),
    z: z.number().finite().min(0).max(10_000_000),
  }),
  center: EVIDENCE_VECTOR,
});
const CAD_EVALUATION_EVIDENCE_SCHEMA: z.ZodType<CadEvaluationEvidenceV1> = z.strictObject({
  formatVersion: z.literal(CAD_EVALUATION_EVIDENCE_FORMAT_VERSION),
  definitionDigest: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/u),
  evaluatorVersion: z.literal(CAD_PART_EVALUATOR_VERSION),
  sketchSolverVersion: z.literal(CAD_SKETCH_SOLVER_VERSION),
  exactness: z.literal("brep"),
  status: z.literal("valid"),
  bodies: z.array(z.strictObject({
    bodyId: ID,
    bounds: EVIDENCE_BOUNDS,
    volumeM3: z.number().finite().positive().max(1e21),
    surfaceAreaM2: z.number().finite().positive().max(1e15),
    centerOfMassM: EVIDENCE_VECTOR,
    valid: z.literal(true),
  })).min(1).max(CAD_PART_LIMITS.maximumActiveBodies),
  overallBounds: EVIDENCE_BOUNDS,
  diagnostics: z.array(z.strictObject({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().trim().min(1).max(2_048),
    featureId: ID.optional(),
  })).max(1_024),
});
const CAD_PART_SCHEMA: z.ZodType<CadPartDefinitionV1> = z.strictObject({
  formatVersion: z.literal(CAD_PART_DEFINITION_FORMAT_VERSION),
  partId: ID,
  displayName: z.string().trim().min(1).max(256),
  units: z.literal("metre"),
  parameters: z.array(CAD_PARAMETER_SCHEMA).max(CAD_PART_LIMITS.maximumParameters),
  history: z.array(CAD_FEATURE_SCHEMA).max(CAD_PART_LIMITS.maximumFeatures),
  activeBodyIds: z.array(ID).max(CAD_PART_LIMITS.maximumActiveBodies),
});

function approximatelyEqual(first: number, second: number): boolean {
  return Math.abs(first - second) <= 1e-8 * Math.max(1, Math.abs(first), Math.abs(second));
}

function assertEvidenceBounds(bounds: CadBoundsV1, path: string): void {
  for (const axis of ["x", "y", "z"] as const) {
    const expectedSize = bounds.max[axis] - bounds.min[axis];
    const expectedCenter = (bounds.min[axis] + bounds.max[axis]) / 2;
    if (expectedSize < 0
      || !approximatelyEqual(bounds.size[axis], expectedSize)
      || !approximatelyEqual(bounds.center[axis], expectedCenter)) {
      throw new CadDocumentError(
        `${path}.${axis} is internally inconsistent`,
        "invalid_cad_evidence",
        `${path}.${axis}`,
      );
    }
  }
}

/** Strictly validates replay evidence before it is trusted by persistence or handoff. */
export function parseCadEvaluationEvidence(
  value: unknown,
  expectedDefinition?: CadPartDefinitionV1,
): CadEvaluationEvidenceV1 {
  const parsed = CAD_EVALUATION_EVIDENCE_SCHEMA.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CadDocumentError(
      `Invalid CAD evidence at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid value"}`,
      "invalid_cad_evidence",
      issue?.path.join(".") || "$",
    );
  }
  const evidence = parsed.data;
  if (evidence.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new CadDocumentError(
      "Valid CAD evidence cannot contain error diagnostics",
      "invalid_cad_evidence",
      "diagnostics",
    );
  }
  assertEvidenceBounds(evidence.overallBounds, "overallBounds");
  const bodyIds = new Set<string>();
  for (const [index, body] of evidence.bodies.entries()) {
    if (bodyIds.has(body.bodyId)) {
      throw new CadDocumentError(
        `Duplicate CAD evidence body ${body.bodyId}`,
        "invalid_cad_evidence",
        `bodies.${index}.bodyId`,
      );
    }
    bodyIds.add(body.bodyId);
    assertEvidenceBounds(body.bounds, `bodies.${index}.bounds`);
    for (const axis of ["x", "y", "z"] as const) {
      if (body.centerOfMassM[axis] < body.bounds.min[axis] - 1e-8
        || body.centerOfMassM[axis] > body.bounds.max[axis] + 1e-8) {
        throw new CadDocumentError(
          `Body ${body.bodyId} center of mass lies outside its bounds`,
          "invalid_cad_evidence",
          `bodies.${index}.centerOfMassM.${axis}`,
        );
      }
      if (body.bounds.min[axis] < evidence.overallBounds.min[axis] - 1e-8
        || body.bounds.max[axis] > evidence.overallBounds.max[axis] + 1e-8) {
        throw new CadDocumentError(
          `Body ${body.bodyId} lies outside overallBounds`,
          "invalid_cad_evidence",
          `bodies.${index}.bounds.${axis}`,
        );
      }
    }
  }
  for (const axis of ["x", "y", "z"] as const) {
    const minimum = Math.min(...evidence.bodies.map((body) => body.bounds.min[axis]));
    const maximum = Math.max(...evidence.bodies.map((body) => body.bounds.max[axis]));
    if (!approximatelyEqual(evidence.overallBounds.min[axis], minimum)
      || !approximatelyEqual(evidence.overallBounds.max[axis], maximum)) {
      throw new CadDocumentError(
        `overallBounds.${axis} does not match the body union`,
        "invalid_cad_evidence",
        `overallBounds.${axis}`,
      );
    }
  }
  if (expectedDefinition !== undefined) {
    const definition = parseCadPartDefinition(expectedDefinition);
    if (evidence.definitionDigest !== cadPartDefinitionDigest(definition)) {
      throw new CadDocumentError(
        "CAD evidence definitionDigest does not match the expected definition",
        "cad_evidence_mismatch",
        "definitionDigest",
      );
    }
    if (evidence.bodies.length !== definition.activeBodyIds.length
      || evidence.bodies.some((body, index) => body.bodyId !== definition.activeBodyIds[index])) {
      throw new CadDocumentError(
        "CAD evidence bodies do not match the expected activeBodyIds",
        "cad_evidence_mismatch",
        "bodies",
      );
    }
    const featureIds = new Set(definition.history.map((feature) => feature.id));
    if (evidence.diagnostics.some((diagnostic) => diagnostic.featureId && !featureIds.has(diagnostic.featureId))) {
      throw new CadDocumentError(
        "CAD evidence contains a diagnostic for an unknown feature",
        "cad_evidence_mismatch",
        "diagnostics",
      );
    }
  }
  return structuredClone(evidence);
}

export function assertCadEvaluationEvidence(
  value: unknown,
  expectedDefinition?: CadPartDefinitionV1,
): asserts value is CadEvaluationEvidenceV1 {
  parseCadEvaluationEvidence(value, expectedDefinition);
}

function byteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
  } catch (error) {
    throw new CadDocumentError(
      `CAD document must be acyclic JSON: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_cad_document",
    );
  }
}

function boundedPositiveLength(value: number, context: string): void {
  if (value < CAD_PART_LIMITS.minimumLengthM || value > CAD_PART_LIMITS.maximumLengthM) {
    throw new CadDocumentError(
      `${context} must be between ${CAD_PART_LIMITS.minimumLengthM} and ${CAD_PART_LIMITS.maximumLengthM} metres`,
      "invalid_feature_value",
      context,
    );
  }
}

function requireNonZeroVector(
  value: Readonly<{ x: number; y: number; z: number }>,
  context: string,
): void {
  if (Math.hypot(value.x, value.y, value.z) < 1e-12) {
    throw new CadDocumentError(`${context} must be non-zero`, "invalid_feature_value", context);
  }
}

function assertProfile(
  profile: CadProfileRef,
  sketches: ReadonlyMap<string, Extract<CadFeature, { kind: "sketch" }>>,
  featureId: string,
): void {
  const sketch = sketches.get(profile.sketchFeatureId);
  if (!sketch) {
    throw new CadDocumentError(
      `Feature ${featureId} references missing or later sketch ${profile.sketchFeatureId}`,
      "unknown_feature_reference",
      featureId,
    );
  }
  const loops = new Set(sketch.sketch.loops.map((loop) => loop.id));
  for (const loopId of profile.loopIds) {
    if (!loops.has(loopId)) {
      throw new CadDocumentError(
        `Feature ${featureId} references unknown loop ${loopId}`,
        "unknown_feature_reference",
        featureId,
      );
    }
  }
}

function requireBody(bodyIds: ReadonlySet<string>, bodyId: string | undefined, featureId: string): void {
  if (!bodyId || !bodyIds.has(bodyId)) {
    throw new CadDocumentError(
      `Feature ${featureId} references unknown body ${String(bodyId)}`,
      "unknown_body_reference",
      featureId,
    );
  }
}

function assertProfileOperation(
  feature: Extract<CadFeature, { kind: "extrude" | "revolve" | "sweep" | "loft" }>,
  bodyIds: ReadonlySet<string>,
): void {
  if (feature.operation === "new") {
    if (feature.targetBodyId !== undefined) {
      throw new CadDocumentError(
        `New-body feature ${feature.id} cannot declare targetBodyId`,
        "invalid_feature_value",
        feature.id,
      );
    }
    if (bodyIds.has(feature.resultBodyId)) {
      throw new CadDocumentError(
        `New-body feature ${feature.id} would overwrite body ${feature.resultBodyId}`,
        "duplicate_cad_identity",
        feature.resultBodyId,
      );
    }
  } else {
    requireBody(bodyIds, feature.targetBodyId, feature.id);
    if (bodyIds.has(feature.resultBodyId) && feature.resultBodyId !== feature.targetBodyId) {
      throw new CadDocumentError(
        `Feature ${feature.id} would overwrite unrelated body ${feature.resultBodyId}`,
        "duplicate_cad_identity",
        feature.resultBodyId,
      );
    }
  }
}

function assertDerivedBodyResult(
  bodyIds: ReadonlySet<string>,
  resultBodyId: string,
  allowedExistingBodyIds: readonly string[],
  featureId: string,
): void {
  if (bodyIds.has(resultBodyId) && !allowedExistingBodyIds.includes(resultBodyId)) {
    throw new CadDocumentError(
      `Feature ${featureId} would overwrite unrelated body ${resultBodyId}`,
      "duplicate_cad_identity",
      resultBodyId,
    );
  }
}

function assertFeatureSemantics(definition: CadPartDefinitionV1): void {
  const featureIds = new Set<string>();
  const sketches = new Map<string, Extract<CadFeature, { kind: "sketch" }>>();
  const bodyIds = new Set<string>();
  const bodyProducer = new Map<string, string>();
  const parameters = evaluateCadParameters(definition.parameters).byId;

  for (const feature of definition.history) {
    if (featureIds.has(feature.id)) {
      throw new CadDocumentError(`Duplicate CAD feature ${feature.id}`, "duplicate_cad_identity", feature.id);
    }
    featureIds.add(feature.id);
    if (feature.suppressed) continue;
    if (feature.kind === "sketch") {
      parseCadSketchDefinition(feature.sketch);
      sketches.set(feature.id, feature);
      continue;
    }
    if (feature.kind === "extrude") {
      assertProfile(feature.profile, sketches, feature.id);
      assertProfileOperation(feature, bodyIds);
      boundedPositiveLength(Math.abs(evaluateCadLength(feature.distance, parameters, feature.id)), feature.id);
      bodyIds.add(feature.resultBodyId);
      bodyProducer.set(feature.resultBodyId, feature.id);
      continue;
    }
    if (feature.kind === "revolve") {
      assertProfile(feature.profile, sketches, feature.id);
      assertProfileOperation(feature, bodyIds);
      const angle = Math.abs(evaluateCadAngle(feature.angle, parameters, feature.id));
      requireNonZeroVector(feature.axis.direction, `${feature.id}.axis.direction`);
      if (angle < 1e-9 || angle > Math.PI * 2 + 1e-9) {
        throw new CadDocumentError(`Revolve ${feature.id} angle must be in (0, 2π]`, "invalid_feature_value", feature.id);
      }
      bodyIds.add(feature.resultBodyId);
      bodyProducer.set(feature.resultBodyId, feature.id);
      continue;
    }
    if (feature.kind === "boolean") {
      requireBody(bodyIds, feature.leftBodyId, feature.id);
      requireBody(bodyIds, feature.rightBodyId, feature.id);
      assertDerivedBodyResult(bodyIds, feature.resultBodyId, [feature.leftBodyId, feature.rightBodyId], feature.id);
      bodyIds.add(feature.resultBodyId);
      bodyProducer.set(feature.resultBodyId, feature.id);
      continue;
    }
    if (feature.kind === "hole") {
      requireBody(bodyIds, feature.targetBodyId, feature.id);
      assertDerivedBodyResult(bodyIds, feature.resultBodyId, [feature.targetBodyId], feature.id);
      requireNonZeroVector(feature.axis, `${feature.id}.axis`);
      boundedPositiveLength(evaluateCadLength(feature.diameter, parameters, feature.id), feature.id);
      if (!feature.throughAll) {
        if (!feature.depth) throw new CadDocumentError(`Blind hole ${feature.id} requires depth`, "invalid_feature_value", feature.id);
        boundedPositiveLength(evaluateCadLength(feature.depth, parameters, feature.id), feature.id);
      }
      bodyIds.add(feature.resultBodyId);
      bodyProducer.set(feature.resultBodyId, feature.id);
      continue;
    }
    if (feature.kind === "fillet" || feature.kind === "chamfer" || feature.kind === "shell") {
      requireBody(bodyIds, feature.targetBodyId, feature.id);
      assertDerivedBodyResult(bodyIds, feature.resultBodyId, [feature.targetBodyId], feature.id);
      const topologyRefs = feature.kind === "shell" ? feature.removedFaces : feature.edges;
      const expectedElementType = feature.kind === "shell" ? "face" : "edge";
      for (const reference of topologyRefs) {
        if (reference.bodyId !== feature.targetBodyId
          || reference.elementType !== expectedElementType
          || reference.producerFeatureId === feature.id
          || !featureIds.has(reference.producerFeatureId)
          || bodyProducer.get(reference.bodyId) !== reference.producerFeatureId) {
          throw new CadDocumentError(
            `Feature ${feature.id} has an invalid or forward topology reference`,
            "unknown_feature_reference",
            feature.id,
          );
        }
      }
      const expression = feature.kind === "fillet"
        ? feature.radius
        : feature.kind === "chamfer"
          ? feature.distance
          : feature.thickness;
      boundedPositiveLength(Math.abs(evaluateCadLength(expression, parameters, feature.id)), feature.id);
      bodyIds.add(feature.resultBodyId);
      bodyProducer.set(feature.resultBodyId, feature.id);
      continue;
    }
    if (feature.kind === "sweep") {
      assertProfile(feature.profile, sketches, feature.id);
      if (!sketches.has(feature.pathSketchFeatureId)) {
        throw new CadDocumentError(`Sweep ${feature.id} has unknown path sketch`, "unknown_feature_reference", feature.id);
      }
      assertProfileOperation(feature, bodyIds);
      bodyIds.add(feature.resultBodyId);
      bodyProducer.set(feature.resultBodyId, feature.id);
      continue;
    }
    if (feature.kind === "loft") {
      for (const profile of feature.profiles) assertProfile(profile, sketches, feature.id);
      assertProfileOperation(feature, bodyIds);
      bodyIds.add(feature.resultBodyId);
      bodyProducer.set(feature.resultBodyId, feature.id);
      continue;
    }
    requireBody(bodyIds, feature.seedBodyId, feature.id);
    assertDerivedBodyResult(
      bodyIds,
      feature.resultBodyId,
      feature.operation === "join" ? [feature.seedBodyId] : [],
      feature.id,
    );
    const count = evaluateCadExpression(feature.count, parameters);
    if ((count.dimension !== "integer" && count.dimension !== "scalar")
      || !Number.isSafeInteger(count.value)
      || count.value < 2
      || count.value > CAD_PART_LIMITS.maximumPatternCount) {
      throw new CadDocumentError(
        `Pattern ${feature.id} count must be an integer from 2 to ${CAD_PART_LIMITS.maximumPatternCount}`,
        "invalid_feature_value",
        feature.id,
      );
    }
    if (feature.kind === "linear_pattern") {
      requireNonZeroVector(feature.direction, `${feature.id}.direction`);
      boundedPositiveLength(evaluateCadLength(feature.spacing, parameters, feature.id), feature.id);
    } else {
      requireNonZeroVector(feature.axis.direction, `${feature.id}.axis.direction`);
      const angle = Math.abs(evaluateCadAngle(feature.angle, parameters, feature.id));
      if (angle < 1e-9 || angle > Math.PI * 2 + 1e-9) {
        throw new CadDocumentError(`Circular pattern ${feature.id} has invalid angle`, "invalid_feature_value", feature.id);
      }
    }
    bodyIds.add(feature.resultBodyId);
    bodyProducer.set(feature.resultBodyId, feature.id);
  }

  const active = new Set<string>();
  for (const bodyId of definition.activeBodyIds) {
    if (active.has(bodyId)) throw new CadDocumentError(`Duplicate active body ${bodyId}`, "duplicate_cad_identity", bodyId);
    active.add(bodyId);
    requireBody(bodyIds, bodyId, "activeBodyIds");
  }
  if (bodyIds.size > 0 && active.size === 0) {
    throw new CadDocumentError("A non-empty CAD part requires at least one active body", "invalid_feature_value", "activeBodyIds");
  }
}

export function parseCadPartDefinition(value: unknown): CadPartDefinitionV1 {
  if (byteLength(value) > CAD_PART_LIMITS.maximumDocumentBytes) {
    throw new CadDocumentError(
      `CAD document exceeds ${CAD_PART_LIMITS.maximumDocumentBytes} bytes`,
      "cad_document_too_large",
    );
  }
  const parsed = CAD_PART_SCHEMA.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CadDocumentError(
      `Invalid CAD document at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid value"}`,
      "invalid_cad_document",
      issue?.path.join(".") || "$",
    );
  }
  try {
    assertFeatureSemantics(parsed.data);
  } catch (error) {
    if (error instanceof CadDocumentError) throw error;
    throw new CadDocumentError(
      error instanceof Error ? error.message : String(error),
      "invalid_feature_value",
    );
  }
  return structuredClone(parsed.data);
}

export function assertCadPartDefinition(value: unknown): asserts value is CadPartDefinitionV1 {
  parseCadPartDefinition(value);
}

export function cadPartDefinitionDigest(value: CadPartDefinitionV1): string {
  return deterministicDigest(parseCadPartDefinition(value));
}

export function defaultCadPartDefinition(
  partId = "cad_part",
  displayName = "CAD Part",
): CadPartDefinitionV1 {
  return parseCadPartDefinition({
    formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
    partId,
    displayName,
    units: "metre",
    parameters: [],
    history: [],
    activeBodyIds: [],
  });
}

function editFailure(message: string, path?: string): never {
  throw new CadDocumentError(message, "invalid_cad_edit", path);
}

export function applyCadDocumentEdits(
  definitionInput: CadPartDefinitionV1,
  edits: readonly CadDocumentEdit[],
): CadPartDefinitionV1 {
  if (edits.length > 100) editFailure("One CAD update supports at most 100 semantic edits");
  const definition = parseCadPartDefinition(definitionInput);
  const mutable = structuredClone(definition) as {
    displayName: string;
    parameters: CadParameter[];
    history: CadFeature[];
    activeBodyIds: string[];
  } & Omit<CadPartDefinitionV1, "displayName" | "parameters" | "history" | "activeBodyIds">;
  for (const edit of edits) {
    switch (edit.kind) {
      case "rename_part": {
        const name = edit.displayName.trim();
        if (!name || name.length > 256) editFailure("CAD part display name must contain 1 to 256 characters", "displayName");
        mutable.displayName = name;
        break;
      }
      case "set_parameter": {
        const parsedParameter = CAD_PARAMETER_SCHEMA.safeParse(edit.parameter);
        if (!parsedParameter.success) {
          editFailure(
            `Invalid CAD parameter edit: ${parsedParameter.error.issues[0]?.message ?? "invalid value"}`,
            "parameter",
          );
        }
        const parameter = parsedParameter.data;
        const index = mutable.parameters.findIndex((candidate) => candidate.id === parameter.id);
        if (index < 0) mutable.parameters.push(parameter);
        else mutable.parameters[index] = parameter;
        break;
      }
      case "delete_parameter": {
        const index = mutable.parameters.findIndex((candidate) => candidate.id === edit.parameterId);
        if (index < 0) editFailure(`Unknown parameter ${edit.parameterId}`, edit.parameterId);
        mutable.parameters.splice(index, 1);
        break;
      }
      case "upsert_feature": {
        const parsedFeature = CAD_FEATURE_SCHEMA.safeParse(edit.feature);
        if (!parsedFeature.success) {
          editFailure(
            `Invalid CAD feature edit: ${parsedFeature.error.issues[0]?.message ?? "invalid value"}`,
            "feature",
          );
        }
        const feature = parsedFeature.data;
        const current = mutable.history.findIndex((candidate) => candidate.id === feature.id);
        if (current >= 0) mutable.history.splice(current, 1);
        if (edit.beforeFeatureId === undefined) mutable.history.push(feature);
        else {
          const before = mutable.history.findIndex((candidate) => candidate.id === edit.beforeFeatureId);
          if (before < 0) editFailure(`Unknown beforeFeatureId ${edit.beforeFeatureId}`, edit.beforeFeatureId);
          mutable.history.splice(before, 0, feature);
        }
        break;
      }
      case "delete_feature": {
        const index = mutable.history.findIndex((candidate) => candidate.id === edit.featureId);
        if (index < 0) editFailure(`Unknown feature ${edit.featureId}`, edit.featureId);
        mutable.history.splice(index, 1);
        break;
      }
      case "reorder_feature": {
        const index = mutable.history.findIndex((candidate) => candidate.id === edit.featureId);
        if (index < 0) editFailure(`Unknown feature ${edit.featureId}`, edit.featureId);
        const [feature] = mutable.history.splice(index, 1);
        if (edit.beforeFeatureId === undefined) mutable.history.push(feature!);
        else {
          const before = mutable.history.findIndex((candidate) => candidate.id === edit.beforeFeatureId);
          if (before < 0) editFailure(`Unknown beforeFeatureId ${edit.beforeFeatureId}`, edit.beforeFeatureId);
          mutable.history.splice(before, 0, feature!);
        }
        break;
      }
      case "suppress_feature": {
        const index = mutable.history.findIndex((candidate) => candidate.id === edit.featureId);
        if (index < 0) editFailure(`Unknown feature ${edit.featureId}`, edit.featureId);
        mutable.history[index] = { ...mutable.history[index]!, suppressed: edit.suppressed };
        break;
      }
      case "set_active_bodies":
        mutable.activeBodyIds = [...edit.bodyIds];
        break;
    }
  }
  return parseCadPartDefinition(mutable);
}

export function cadLengthExpression(valueM: number): CadExpression {
  return { kind: "constant", value: valueM, dimension: "length" };
}

export function cadAngleExpression(valueRad: number): CadExpression {
  return { kind: "constant", value: valueRad, dimension: "angle" };
}
