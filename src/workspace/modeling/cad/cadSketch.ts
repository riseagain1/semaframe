import { z } from "zod";
import {
  CAD_EXPRESSION_SCHEMA,
  evaluateCadLength,
  type CadExpression,
  type CadQuantity,
} from "./cadParameters";

export const CAD_SKETCH_SOLVER_VERSION = "1.0.0" as const;
export const CAD_SKETCH_SOLVER_LIMITS = Object.freeze({
  maximumVariables: 128,
  maximumConstraints: 128,
  maximumIterations: 50,
});

export type CadPoint2 = Readonly<{ x: number; y: number }>;
export type CadVector3 = Readonly<{ x: number; y: number; z: number }>;

export type CadSketchPlane = Readonly<{
  originM: CadVector3;
  xAxis: CadVector3;
  yAxis: CadVector3;
  normal: CadVector3;
}>;

export type CadSketchEntity =
  | Readonly<{ id: string; kind: "line"; start: CadPoint2; end: CadPoint2; construction?: boolean }>
  | Readonly<{ id: string; kind: "circle"; center: CadPoint2; radiusM: number; construction?: boolean }>
  | Readonly<{
      id: string;
      kind: "arc";
      start: CadPoint2;
      mid: CadPoint2;
      end: CadPoint2;
      construction?: boolean;
    }>;

export type CadSketchPointRole = "start" | "mid" | "end" | "center";
export type CadSketchPointRef = Readonly<{ entityId: string; point: CadSketchPointRole }>;

export type CadSketchConstraint =
  | Readonly<{ id: string; kind: "coincident"; first: CadSketchPointRef; second: CadSketchPointRef }>
  | Readonly<{ id: string; kind: "horizontal" | "vertical"; entityId: string }>
  | Readonly<{
      id: string;
      kind: "distance";
      first: CadSketchPointRef;
      second: CadSketchPointRef;
      value: CadExpression;
    }>
  | Readonly<{ id: string; kind: "length"; entityId: string; value: CadExpression }>
  | Readonly<{ id: string; kind: "radius"; entityId: string; value: CadExpression }>
  | Readonly<{
      id: string;
      kind: "fixed";
      point: CadSketchPointRef;
      position: CadPoint2;
    }>
  | Readonly<{
      id: string;
      kind: "parallel" | "perpendicular" | "equal_length";
      firstEntityId: string;
      secondEntityId: string;
    }>;

export type CadSketchLoop = Readonly<{
  id: string;
  entityIds: readonly string[];
  role: "outer" | "hole";
}>;

export type CadSketchDefinition = Readonly<{
  plane: CadSketchPlane;
  entities: readonly CadSketchEntity[];
  loops: readonly CadSketchLoop[];
  constraints: readonly CadSketchConstraint[];
}>;

export type CadSketchSolveResult = Readonly<{
  solverVersion: typeof CAD_SKETCH_SOLVER_VERSION;
  status: "under_constrained" | "fully_constrained" | "over_constrained";
  degreesOfFreedom: number;
  iterations: number;
  maximumResidual: number;
  conflictingConstraintIds: readonly string[];
  entities: readonly CadSketchEntity[];
}>;

export class CadSketchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_sketch"
      | "duplicate_sketch_id"
      | "unknown_sketch_reference"
      | "invalid_sketch_plane"
      | "degenerate_sketch_entity"
      | "solver_failed",
    readonly path?: string,
  ) {
    super(message);
    this.name = "CadSketchError";
  }
}

const ID = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u);
const COORDINATE = z.number().finite().min(-1e6).max(1e6);
const POINT_2 = z.strictObject({ x: COORDINATE, y: COORDINATE });
const VECTOR_3 = z.strictObject({ x: COORDINATE, y: COORDINATE, z: COORDINATE });
const POINT_REF = z.strictObject({
  entityId: ID,
  point: z.enum(["start", "mid", "end", "center"]),
});

export const CAD_SKETCH_ENTITY_SCHEMA: z.ZodType<CadSketchEntity> = z.discriminatedUnion("kind", [
  z.strictObject({
    id: ID,
    kind: z.literal("line"),
    start: POINT_2,
    end: POINT_2,
    construction: z.boolean().optional(),
  }),
  z.strictObject({
    id: ID,
    kind: z.literal("circle"),
    center: POINT_2,
    radiusM: z.number().finite().min(1e-6).max(1_000),
    construction: z.boolean().optional(),
  }),
  z.strictObject({
    id: ID,
    kind: z.literal("arc"),
    start: POINT_2,
    mid: POINT_2,
    end: POINT_2,
    construction: z.boolean().optional(),
  }),
]);

export const CAD_SKETCH_CONSTRAINT_SCHEMA: z.ZodType<CadSketchConstraint> = z.discriminatedUnion("kind", [
  z.strictObject({ id: ID, kind: z.literal("coincident"), first: POINT_REF, second: POINT_REF }),
  z.strictObject({ id: ID, kind: z.literal("horizontal"), entityId: ID }),
  z.strictObject({ id: ID, kind: z.literal("vertical"), entityId: ID }),
  z.strictObject({
    id: ID,
    kind: z.literal("distance"),
    first: POINT_REF,
    second: POINT_REF,
    value: CAD_EXPRESSION_SCHEMA,
  }),
  z.strictObject({ id: ID, kind: z.literal("length"), entityId: ID, value: CAD_EXPRESSION_SCHEMA }),
  z.strictObject({ id: ID, kind: z.literal("radius"), entityId: ID, value: CAD_EXPRESSION_SCHEMA }),
  z.strictObject({ id: ID, kind: z.literal("fixed"), point: POINT_REF, position: POINT_2 }),
  z.strictObject({ id: ID, kind: z.literal("parallel"), firstEntityId: ID, secondEntityId: ID }),
  z.strictObject({ id: ID, kind: z.literal("perpendicular"), firstEntityId: ID, secondEntityId: ID }),
  z.strictObject({ id: ID, kind: z.literal("equal_length"), firstEntityId: ID, secondEntityId: ID }),
]);

export const CAD_SKETCH_SCHEMA: z.ZodType<CadSketchDefinition> = z.strictObject({
  plane: z.strictObject({ originM: VECTOR_3, xAxis: VECTOR_3, yAxis: VECTOR_3, normal: VECTOR_3 }),
  entities: z.array(CAD_SKETCH_ENTITY_SCHEMA).max(512),
  loops: z.array(z.strictObject({
    id: ID,
    entityIds: z.array(ID).min(1).max(512),
    role: z.enum(["outer", "hole"]),
  })).max(128),
  constraints: z.array(CAD_SKETCH_CONSTRAINT_SCHEMA).max(1_024),
});

const distance2 = (first: CadPoint2, second: CadPoint2): number => (
  Math.hypot(first.x - second.x, first.y - second.y)
);

function vectorLength(value: CadVector3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function dot3(first: CadVector3, second: CadVector3): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function assertSketchSemantics(sketch: CadSketchDefinition): void {
  const entityIds = new Set<string>();
  for (const entity of sketch.entities) {
    if (entityIds.has(entity.id)) {
      throw new CadSketchError(`Duplicate sketch entity ${entity.id}`, "duplicate_sketch_id", entity.id);
    }
    entityIds.add(entity.id);
    if (entity.kind === "line" && distance2(entity.start, entity.end) < 1e-9) {
      throw new CadSketchError(`Line ${entity.id} is degenerate`, "degenerate_sketch_entity", entity.id);
    }
    if (entity.kind === "arc") {
      const twiceArea = (entity.mid.x - entity.start.x) * (entity.end.y - entity.start.y)
        - (entity.mid.y - entity.start.y) * (entity.end.x - entity.start.x);
      if (Math.abs(twiceArea) < 1e-12) {
        throw new CadSketchError(`Arc ${entity.id} is collinear`, "degenerate_sketch_entity", entity.id);
      }
    }
  }
  const loopIds = new Set<string>();
  for (const loop of sketch.loops) {
    if (loopIds.has(loop.id)) throw new CadSketchError(`Duplicate sketch loop ${loop.id}`, "duplicate_sketch_id", loop.id);
    loopIds.add(loop.id);
    for (const entityId of loop.entityIds) {
      const entity = sketch.entities.find((candidate) => candidate.id === entityId);
      if (!entity || entity.construction) {
        throw new CadSketchError(
          `Loop ${loop.id} references unknown or construction entity ${entityId}`,
          "unknown_sketch_reference",
          loop.id,
        );
      }
    }
  }
  const constraintIds = new Set<string>();
  const entityById = new Map(sketch.entities.map((entity) => [entity.id, entity]));
  const requireEntity = (id: string, kind?: CadSketchEntity["kind"]): CadSketchEntity => {
    const entity = entityById.get(id);
    if (!entity || (kind && entity.kind !== kind)) {
      throw new CadSketchError(`Unknown or incompatible sketch entity ${id}`, "unknown_sketch_reference", id);
    }
    return entity;
  };
  const requirePoint = (ref: CadSketchPointRef): void => {
    const entity = requireEntity(ref.entityId);
    const supported = entity.kind === "line"
      ? ref.point === "start" || ref.point === "end"
      : entity.kind === "circle"
        ? ref.point === "center"
        : ref.point === "start" || ref.point === "mid" || ref.point === "end";
    if (!supported) throw new CadSketchError(`Invalid point ${ref.point} on ${entity.id}`, "unknown_sketch_reference", entity.id);
  };
  for (const constraint of sketch.constraints) {
    if (constraintIds.has(constraint.id)) {
      throw new CadSketchError(`Duplicate sketch constraint ${constraint.id}`, "duplicate_sketch_id", constraint.id);
    }
    constraintIds.add(constraint.id);
    if (constraint.kind === "coincident" || constraint.kind === "distance") {
      requirePoint(constraint.first);
      requirePoint(constraint.second);
    } else if (constraint.kind === "fixed") {
      requirePoint(constraint.point);
    } else if (constraint.kind === "radius") {
      requireEntity(constraint.entityId, "circle");
    } else if (constraint.kind === "horizontal" || constraint.kind === "vertical" || constraint.kind === "length") {
      requireEntity(constraint.entityId, "line");
    } else if ("firstEntityId" in constraint) {
      requireEntity(constraint.firstEntityId, "line");
      requireEntity(constraint.secondEntityId, "line");
    }
  }

  const { xAxis, yAxis, normal } = sketch.plane;
  const xLength = vectorLength(xAxis);
  const yLength = vectorLength(yAxis);
  const normalLength = vectorLength(normal);
  if ([xLength, yLength, normalLength].some((value) => Math.abs(value - 1) > 1e-6)
    || Math.abs(dot3(xAxis, yAxis)) > 1e-6
    || Math.abs(dot3(xAxis, normal)) > 1e-6
    || Math.abs(dot3(yAxis, normal)) > 1e-6) {
    throw new CadSketchError("Sketch plane basis must be orthonormal", "invalid_sketch_plane", "plane");
  }
  const cross = {
    x: xAxis.y * yAxis.z - xAxis.z * yAxis.y,
    y: xAxis.z * yAxis.x - xAxis.x * yAxis.z,
    z: xAxis.x * yAxis.y - xAxis.y * yAxis.x,
  };
  if (dot3(cross, normal) < 1 - 1e-6) {
    throw new CadSketchError("Sketch plane x/y axes must form the declared right-handed normal", "invalid_sketch_plane", "plane");
  }
}

export function parseCadSketchDefinition(value: unknown): CadSketchDefinition {
  const parsed = CAD_SKETCH_SCHEMA.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CadSketchError(
      `Invalid sketch at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid value"}`,
      "invalid_sketch",
      issue?.path.join(".") || "$",
    );
  }
  assertSketchSemantics(parsed.data);
  return structuredClone(parsed.data);
}

type VariableEntity = {
  source: CadSketchEntity;
  offsets: Record<string, number>;
};

function encodeEntities(entities: readonly CadSketchEntity[]): {
  values: number[];
  variables: Map<string, VariableEntity>;
} {
  const values: number[] = [];
  const variables = new Map<string, VariableEntity>();
  const appendPoint = (point: CadPoint2): number => {
    const offset = values.length;
    values.push(point.x, point.y);
    return offset;
  };
  for (const entity of entities) {
    if (entity.kind === "line") {
      variables.set(entity.id, { source: entity, offsets: { start: appendPoint(entity.start), end: appendPoint(entity.end) } });
    } else if (entity.kind === "circle") {
      const center = appendPoint(entity.center);
      const radius = values.length;
      values.push(entity.radiusM);
      variables.set(entity.id, { source: entity, offsets: { center, radius } });
    } else {
      variables.set(entity.id, {
        source: entity,
        offsets: { start: appendPoint(entity.start), mid: appendPoint(entity.mid), end: appendPoint(entity.end) },
      });
    }
  }
  return { values, variables };
}

function decodedPoint(values: readonly number[], variable: VariableEntity, role: CadSketchPointRole): CadPoint2 {
  const offset = variable.offsets[role];
  if (offset === undefined) throw new Error(`Missing sketch point ${role}`);
  return { x: values[offset]!, y: values[offset + 1]! };
}

function decodeEntities(values: readonly number[], variables: ReadonlyMap<string, VariableEntity>): CadSketchEntity[] {
  return [...variables.values()].map(({ source, offsets }) => {
    if (source.kind === "line") return { ...source, start: decodedPoint(values, { source, offsets }, "start"), end: decodedPoint(values, { source, offsets }, "end") };
    if (source.kind === "circle") return {
      ...source,
      center: decodedPoint(values, { source, offsets }, "center"),
      radiusM: Math.abs(values[offsets.radius]!),
    };
    return {
      ...source,
      start: decodedPoint(values, { source, offsets }, "start"),
      mid: decodedPoint(values, { source, offsets }, "mid"),
      end: decodedPoint(values, { source, offsets }, "end"),
    };
  });
}

type ConstraintResidual = Readonly<{ id: string; values: readonly number[] }>;

function residuals(
  values: readonly number[],
  variables: ReadonlyMap<string, VariableEntity>,
  constraints: readonly CadSketchConstraint[],
  parameters: ReadonlyMap<string, CadQuantity>,
): ConstraintResidual[] {
  const point = (ref: CadSketchPointRef): CadPoint2 => decodedPoint(values, variables.get(ref.entityId)!, ref.point);
  const line = (id: string): readonly [CadPoint2, CadPoint2] => {
    const variable = variables.get(id)!;
    return [decodedPoint(values, variable, "start"), decodedPoint(values, variable, "end")];
  };
  const lineVector = (id: string): readonly [number, number, number] => {
    const [start, end] = line(id);
    const x = end.x - start.x;
    const y = end.y - start.y;
    const length = Math.max(1e-12, Math.hypot(x, y));
    return [x / length, y / length, length];
  };
  return constraints.map((constraint): ConstraintResidual => {
    if (constraint.kind === "coincident") {
      const first = point(constraint.first);
      const second = point(constraint.second);
      return { id: constraint.id, values: [first.x - second.x, first.y - second.y] };
    }
    if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      const [start, end] = line(constraint.entityId);
      return { id: constraint.id, values: [constraint.kind === "horizontal" ? end.y - start.y : end.x - start.x] };
    }
    if (constraint.kind === "distance") {
      return {
        id: constraint.id,
        values: [distance2(point(constraint.first), point(constraint.second))
          - evaluateCadLength(constraint.value, parameters, constraint.id)],
      };
    }
    if (constraint.kind === "length") {
      const vector = lineVector(constraint.entityId);
      return { id: constraint.id, values: [vector[2] - evaluateCadLength(constraint.value, parameters, constraint.id)] };
    }
    if (constraint.kind === "radius") {
      const variable = variables.get(constraint.entityId)!;
      return {
        id: constraint.id,
        values: [Math.abs(values[variable.offsets.radius]!)
          - evaluateCadLength(constraint.value, parameters, constraint.id)],
      };
    }
    if (constraint.kind === "fixed") {
      const value = point(constraint.point);
      return { id: constraint.id, values: [value.x - constraint.position.x, value.y - constraint.position.y] };
    }
    if (!("firstEntityId" in constraint)) {
      throw new CadSketchError(`Unsupported sketch constraint ${constraint.id}`, "solver_failed", constraint.id);
    }
    const first = lineVector(constraint.firstEntityId);
    const second = lineVector(constraint.secondEntityId);
    if (constraint.kind === "parallel") return { id: constraint.id, values: [first[0] * second[1] - first[1] * second[0]] };
    if (constraint.kind === "perpendicular") return { id: constraint.id, values: [first[0] * second[0] + first[1] * second[1]] };
    return { id: constraint.id, values: [first[2] - second[2]] };
  });
}

function flattenResiduals(input: readonly ConstraintResidual[]): number[] {
  return input.flatMap((entry) => [...entry.values]);
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | undefined {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) < 1e-14) return undefined;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    for (let index = column; index <= size; index += 1) augmented[column]![index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let index = column; index <= size; index += 1) {
        augmented[row]![index] -= factor * augmented[column]![index]!;
      }
    }
  }
  return augmented.map((row) => row[size]!);
}

function matrixRank(matrixInput: readonly (readonly number[])[], tolerance = 1e-7): number {
  const matrix = matrixInput.map((row) => [...row]);
  if (!matrix.length) return 0;
  let rank = 0;
  for (let column = 0; column < matrix[0]!.length && rank < matrix.length; column += 1) {
    let pivot = rank;
    for (let row = rank + 1; row < matrix.length; row += 1) {
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(matrix[pivot]![column]!) <= tolerance) continue;
    [matrix[rank], matrix[pivot]] = [matrix[pivot]!, matrix[rank]!];
    const divisor = matrix[rank]![column]!;
    for (let index = column; index < matrix[rank]!.length; index += 1) matrix[rank]![index] /= divisor;
    for (let row = 0; row < matrix.length; row += 1) {
      if (row === rank) continue;
      const factor = matrix[row]![column]!;
      for (let index = column; index < matrix[row]!.length; index += 1) {
        matrix[row]![index] -= factor * matrix[rank]![index]!;
      }
    }
    rank += 1;
  }
  return rank;
}

function jacobian(
  values: readonly number[],
  evaluate: (candidate: readonly number[]) => number[],
): number[][] {
  const base = evaluate(values);
  const result = base.map(() => Array.from({ length: values.length }, () => 0));
  for (let column = 0; column < values.length; column += 1) {
    const step = 1e-7 * Math.max(1, Math.abs(values[column]!));
    const next = [...values];
    next[column]! += step;
    const output = evaluate(next);
    for (let row = 0; row < base.length; row += 1) result[row]![column] = (output[row]! - base[row]!) / step;
  }
  return result;
}

export function solveCadSketch(
  sketchInput: CadSketchDefinition,
  parameters: ReadonlyMap<string, CadQuantity> = new Map(),
): CadSketchSolveResult {
  const sketch = parseCadSketchDefinition(sketchInput);
  const { values: initial, variables } = encodeEntities(sketch.entities);
  if (initial.length > CAD_SKETCH_SOLVER_LIMITS.maximumVariables
    || sketch.constraints.length > CAD_SKETCH_SOLVER_LIMITS.maximumConstraints) {
    throw new CadSketchError(
      `Built-in sketch solver supports at most ${CAD_SKETCH_SOLVER_LIMITS.maximumVariables} variables and ${CAD_SKETCH_SOLVER_LIMITS.maximumConstraints} constraints`,
      "solver_failed",
      "sketch",
    );
  }
  let current = [...initial];
  let damping = 1e-6;
  let iterations = 0;
  const evaluate = (candidate: readonly number[]): number[] => flattenResiduals(
    residuals(candidate, variables, sketch.constraints, parameters),
  );
  let currentResidual = evaluate(current);
  const cost = (candidate: readonly number[]): number => candidate.reduce((sum, value) => sum + value * value, 0);
  for (; iterations < CAD_SKETCH_SOLVER_LIMITS.maximumIterations
    && Math.max(0, ...currentResidual.map(Math.abs)) > 1e-9; iterations += 1) {
    const derivative = jacobian(current, evaluate);
    const size = current.length;
    const normal = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
    const right = Array.from({ length: size }, () => 0);
    for (let row = 0; row < derivative.length; row += 1) {
      for (let column = 0; column < size; column += 1) {
        right[column]! -= derivative[row]![column]! * currentResidual[row]!;
        for (let inner = 0; inner < size; inner += 1) {
          normal[column]![inner]! += derivative[row]![column]! * derivative[row]![inner]!;
        }
      }
    }
    for (let index = 0; index < size; index += 1) normal[index]![index]! += damping;
    const delta = solveLinearSystem(normal, right);
    if (!delta) break;
    const next = current.map((value, index) => value + delta[index]!);
    const nextResidual = evaluate(next);
    if (cost(nextResidual) < cost(currentResidual)) {
      current = next;
      currentResidual = nextResidual;
      damping = Math.max(1e-12, damping / 4);
    } else {
      damping = Math.min(1e12, damping * 10);
    }
  }
  const grouped = residuals(current, variables, sketch.constraints, parameters);
  const maximumResidual = Math.max(0, ...grouped.flatMap((entry) => entry.values.map(Math.abs)));
  const derivative = jacobian(current, evaluate);
  const degreesOfFreedom = Math.max(0, current.length - matrixRank(derivative));
  const conflictingConstraintIds = grouped
    .filter((entry) => Math.max(0, ...entry.values.map(Math.abs)) > 1e-7)
    .map((entry) => entry.id);
  const status = maximumResidual > 1e-7
    ? "over_constrained" as const
    : degreesOfFreedom === 0
      ? "fully_constrained" as const
      : "under_constrained" as const;
  const entities = decodeEntities(current, variables);
  for (const entity of entities) {
    if (entity.kind === "circle" && entity.radiusM < 1e-6) {
      throw new CadSketchError(`Solved circle ${entity.id} has invalid radius`, "solver_failed", entity.id);
    }
  }
  return Object.freeze({
    solverVersion: CAD_SKETCH_SOLVER_VERSION,
    status,
    degreesOfFreedom,
    iterations,
    maximumResidual,
    conflictingConstraintIds: Object.freeze(conflictingConstraintIds),
    entities: Object.freeze(entities.map((entity) => Object.freeze(entity))),
  });
}

export const DEFAULT_CAD_SKETCH_PLANE: CadSketchPlane = Object.freeze({
  originM: Object.freeze({ x: 0, y: 0, z: 0 }),
  xAxis: Object.freeze({ x: 1, y: 0, z: 0 }),
  yAxis: Object.freeze({ x: 0, y: 1, z: 0 }),
  normal: Object.freeze({ x: 0, y: 0, z: 1 }),
});
