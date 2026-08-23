import { z } from "zod";
import { CAD_EXPRESSION_SCHEMA, type CadExpression } from "./cadParameters";
import { CAD_SKETCH_SCHEMA, type CadSketchDefinition, type CadVector3 } from "./cadSketch";

export type CadBooleanKind = "union" | "cut" | "intersect";
export type CadProfileOperation = "new" | "join" | "cut" | "intersect";

export type CadProfileRef = Readonly<{
  sketchFeatureId: string;
  loopIds: readonly string[];
}>;

export type CadAxisRef = Readonly<{
  originM: CadVector3;
  direction: CadVector3;
}>;

export type CadTopologyRef = Readonly<{
  bodyId: string;
  producerFeatureId: string;
  elementType: "face" | "edge" | "vertex";
  role: string;
  sourceEntityId?: string;
  occurrencePath?: readonly number[];
  expectedSignature?: Readonly<{
    surfaceType?: "plane" | "cylinder" | "cone" | "sphere" | "bspline";
    directionHint?: CadVector3;
    centroidHintM?: CadVector3;
    areaHintM2?: number;
    lengthHintM?: number;
  }>;
}>;

type CadFeatureBase = Readonly<{
  id: string;
  name: string;
  suppressed?: boolean;
}>;

export type CadSketchFeature = CadFeatureBase & Readonly<{
  kind: "sketch";
  sketch: CadSketchDefinition;
}>;

export type CadExtrudeFeature = CadFeatureBase & Readonly<{
  kind: "extrude";
  profile: CadProfileRef;
  distance: CadExpression;
  symmetric?: boolean;
  operation: CadProfileOperation;
  targetBodyId?: string;
  resultBodyId: string;
}>;

export type CadRevolveFeature = CadFeatureBase & Readonly<{
  kind: "revolve";
  profile: CadProfileRef;
  axis: CadAxisRef;
  angle: CadExpression;
  operation: CadProfileOperation;
  targetBodyId?: string;
  resultBodyId: string;
}>;

export type CadBooleanFeature = CadFeatureBase & Readonly<{
  kind: "boolean";
  operation: CadBooleanKind;
  leftBodyId: string;
  rightBodyId: string;
  resultBodyId: string;
}>;

export type CadHoleFeature = CadFeatureBase & Readonly<{
  kind: "hole";
  targetBodyId: string;
  resultBodyId: string;
  centerM: CadVector3;
  axis: CadVector3;
  diameter: CadExpression;
  depth?: CadExpression;
  throughAll: boolean;
}>;

export type CadFilletFeature = CadFeatureBase & Readonly<{
  kind: "fillet";
  targetBodyId: string;
  resultBodyId: string;
  edges: readonly CadTopologyRef[];
  radius: CadExpression;
}>;

export type CadChamferFeature = CadFeatureBase & Readonly<{
  kind: "chamfer";
  targetBodyId: string;
  resultBodyId: string;
  edges: readonly CadTopologyRef[];
  distance: CadExpression;
}>;

export type CadShellFeature = CadFeatureBase & Readonly<{
  kind: "shell";
  targetBodyId: string;
  resultBodyId: string;
  removedFaces: readonly CadTopologyRef[];
  thickness: CadExpression;
}>;

export type CadSweepFeature = CadFeatureBase & Readonly<{
  kind: "sweep";
  profile: CadProfileRef;
  pathSketchFeatureId: string;
  operation: CadProfileOperation;
  targetBodyId?: string;
  resultBodyId: string;
}>;

export type CadLoftFeature = CadFeatureBase & Readonly<{
  kind: "loft";
  profiles: readonly CadProfileRef[];
  ruled: boolean;
  operation: CadProfileOperation;
  targetBodyId?: string;
  resultBodyId: string;
}>;

export type CadLinearPatternFeature = CadFeatureBase & Readonly<{
  kind: "linear_pattern";
  seedBodyId: string;
  resultBodyId: string;
  direction: CadVector3;
  spacing: CadExpression;
  count: CadExpression;
  operation: "new" | "join";
}>;

export type CadCircularPatternFeature = CadFeatureBase & Readonly<{
  kind: "circular_pattern";
  seedBodyId: string;
  resultBodyId: string;
  axis: CadAxisRef;
  angle: CadExpression;
  count: CadExpression;
  operation: "new" | "join";
}>;

export type CadFeature =
  | CadSketchFeature
  | CadExtrudeFeature
  | CadRevolveFeature
  | CadBooleanFeature
  | CadHoleFeature
  | CadFilletFeature
  | CadChamferFeature
  | CadShellFeature
  | CadSweepFeature
  | CadLoftFeature
  | CadLinearPatternFeature
  | CadCircularPatternFeature;

const ID = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u);
const NAME = z.string().trim().min(1).max(256);
const COORDINATE = z.number().finite().min(-1e6).max(1e6);
const VECTOR_3 = z.strictObject({ x: COORDINATE, y: COORDINATE, z: COORDINATE });
const BASE = { id: ID, name: NAME, suppressed: z.boolean().optional() } as const;
const PROFILE = z.strictObject({ sketchFeatureId: ID, loopIds: z.array(ID).min(1).max(128) });
const AXIS = z.strictObject({ originM: VECTOR_3, direction: VECTOR_3 });
const PROFILE_OPERATION = z.enum(["new", "join", "cut", "intersect"]);
const TOPOLOGY_REF = z.strictObject({
  bodyId: ID,
  producerFeatureId: ID,
  elementType: z.enum(["face", "edge", "vertex"]),
  role: z.string().trim().min(1).max(128),
  sourceEntityId: ID.optional(),
  occurrencePath: z.array(z.number().int().min(0).max(1_024)).max(16).optional(),
  expectedSignature: z.strictObject({
    surfaceType: z.enum(["plane", "cylinder", "cone", "sphere", "bspline"]).optional(),
    directionHint: VECTOR_3.optional(),
    centroidHintM: VECTOR_3.optional(),
    areaHintM2: z.number().finite().positive().max(1e12).optional(),
    lengthHintM: z.number().finite().positive().max(1e6).optional(),
  }).optional(),
});

export const CAD_FEATURE_SCHEMA: z.ZodType<CadFeature> = z.discriminatedUnion("kind", [
  z.strictObject({ ...BASE, kind: z.literal("sketch"), sketch: CAD_SKETCH_SCHEMA }),
  z.strictObject({
    ...BASE,
    kind: z.literal("extrude"),
    profile: PROFILE,
    distance: CAD_EXPRESSION_SCHEMA,
    symmetric: z.boolean().optional(),
    operation: PROFILE_OPERATION,
    targetBodyId: ID.optional(),
    resultBodyId: ID,
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("revolve"),
    profile: PROFILE,
    axis: AXIS,
    angle: CAD_EXPRESSION_SCHEMA,
    operation: PROFILE_OPERATION,
    targetBodyId: ID.optional(),
    resultBodyId: ID,
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("boolean"),
    operation: z.enum(["union", "cut", "intersect"]),
    leftBodyId: ID,
    rightBodyId: ID,
    resultBodyId: ID,
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("hole"),
    targetBodyId: ID,
    resultBodyId: ID,
    centerM: VECTOR_3,
    axis: VECTOR_3,
    diameter: CAD_EXPRESSION_SCHEMA,
    depth: CAD_EXPRESSION_SCHEMA.optional(),
    throughAll: z.boolean(),
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("fillet"),
    targetBodyId: ID,
    resultBodyId: ID,
    edges: z.array(TOPOLOGY_REF).min(1).max(256),
    radius: CAD_EXPRESSION_SCHEMA,
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("chamfer"),
    targetBodyId: ID,
    resultBodyId: ID,
    edges: z.array(TOPOLOGY_REF).min(1).max(256),
    distance: CAD_EXPRESSION_SCHEMA,
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("shell"),
    targetBodyId: ID,
    resultBodyId: ID,
    removedFaces: z.array(TOPOLOGY_REF).min(1).max(256),
    thickness: CAD_EXPRESSION_SCHEMA,
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("sweep"),
    profile: PROFILE,
    pathSketchFeatureId: ID,
    operation: PROFILE_OPERATION,
    targetBodyId: ID.optional(),
    resultBodyId: ID,
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("loft"),
    profiles: z.array(PROFILE).min(2).max(32),
    ruled: z.boolean(),
    operation: PROFILE_OPERATION,
    targetBodyId: ID.optional(),
    resultBodyId: ID,
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("linear_pattern"),
    seedBodyId: ID,
    resultBodyId: ID,
    direction: VECTOR_3,
    spacing: CAD_EXPRESSION_SCHEMA,
    count: CAD_EXPRESSION_SCHEMA,
    operation: z.enum(["new", "join"]),
  }),
  z.strictObject({
    ...BASE,
    kind: z.literal("circular_pattern"),
    seedBodyId: ID,
    resultBodyId: ID,
    axis: AXIS,
    angle: CAD_EXPRESSION_SCHEMA,
    count: CAD_EXPRESSION_SCHEMA,
    operation: z.enum(["new", "join"]),
  }),
]);

export function parseCadFeature(value: unknown): CadFeature {
  return structuredClone(CAD_FEATURE_SCHEMA.parse(value));
}
