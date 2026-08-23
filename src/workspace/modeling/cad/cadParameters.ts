import { z } from "zod";

export const CAD_PARAMETER_DIMENSIONS = ["scalar", "length", "angle", "integer"] as const;
export type CadParameterDimension = typeof CAD_PARAMETER_DIMENSIONS[number];

export const CAD_EXPRESSION_FUNCTIONS = ["abs", "min", "max"] as const;
export type CadExpressionFunction = typeof CAD_EXPRESSION_FUNCTIONS[number];

export type CadExpression =
  | Readonly<{
      kind: "constant";
      value: number;
      dimension: CadParameterDimension;
    }>
  | Readonly<{
      kind: "parameter";
      parameterId: string;
    }>
  | Readonly<{
      kind: "negate";
      value: CadExpression;
    }>
  | Readonly<{
      kind: "binary";
      operation: "add" | "subtract" | "multiply" | "divide";
      left: CadExpression;
      right: CadExpression;
    }>
  | Readonly<{
      kind: "function";
      function: CadExpressionFunction;
      arguments: readonly CadExpression[];
    }>;

export type CadParameter = Readonly<{
  id: string;
  name: string;
  dimension: CadParameterDimension;
  expression: CadExpression;
}>;

export type CadQuantity = Readonly<{
  value: number;
  dimension: CadParameterDimension;
}>;

export type CadParameterEvaluation = Readonly<{
  byId: ReadonlyMap<string, CadQuantity>;
  byName: ReadonlyMap<string, CadQuantity>;
}>;

export class CadParameterError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_parameter"
      | "duplicate_parameter"
      | "unknown_parameter"
      | "parameter_cycle"
      | "dimension_mismatch"
      | "division_by_zero"
      | "non_finite_result",
    readonly path?: string,
  ) {
    super(message);
    this.name = "CadParameterError";
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const FINITE_NUMBER = z.number().finite().min(-1e12).max(1e12);

export const CAD_EXPRESSION_SCHEMA: z.ZodType<CadExpression> = z.lazy(() => z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("constant"),
    value: FINITE_NUMBER,
    dimension: z.enum(CAD_PARAMETER_DIMENSIONS),
  }),
  z.strictObject({
    kind: z.literal("parameter"),
    parameterId: z.string().regex(IDENTIFIER_PATTERN),
  }),
  z.strictObject({
    kind: z.literal("negate"),
    value: CAD_EXPRESSION_SCHEMA,
  }),
  z.strictObject({
    kind: z.literal("binary"),
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    left: CAD_EXPRESSION_SCHEMA,
    right: CAD_EXPRESSION_SCHEMA,
  }),
  z.strictObject({
    kind: z.literal("function"),
    function: z.enum(CAD_EXPRESSION_FUNCTIONS),
    arguments: z.array(CAD_EXPRESSION_SCHEMA).min(1).max(16),
  }),
]));

export const CAD_PARAMETER_SCHEMA: z.ZodType<CadParameter> = z.strictObject({
  id: z.string().regex(IDENTIFIER_PATTERN),
  name: z.string().trim().min(1).max(128),
  dimension: z.enum(CAD_PARAMETER_DIMENSIONS),
  expression: CAD_EXPRESSION_SCHEMA,
});

export function cadConstant(
  value: number,
  dimension: CadParameterDimension,
): CadExpression {
  return Object.freeze({ kind: "constant", value, dimension });
}

function assertFinite(quantity: CadQuantity, context: string): CadQuantity {
  if (!Number.isFinite(quantity.value)) {
    throw new CadParameterError(`${context} produced a non-finite value`, "non_finite_result");
  }
  if (quantity.dimension === "integer" && !Number.isSafeInteger(quantity.value)) {
    throw new CadParameterError(`${context} must produce a safe integer`, "dimension_mismatch");
  }
  return Object.freeze(quantity);
}

function sameDimension(
  left: CadQuantity,
  right: CadQuantity,
  context: string,
): CadParameterDimension {
  if (left.dimension !== right.dimension) {
    throw new CadParameterError(
      `${context} requires matching dimensions, received ${left.dimension} and ${right.dimension}`,
      "dimension_mismatch",
    );
  }
  return left.dimension;
}

function multiplyDimension(
  left: CadParameterDimension,
  right: CadParameterDimension,
): CadParameterDimension {
  if (left === "scalar") return right;
  if (right === "scalar") return left;
  if (left === "integer" && right === "integer") return "integer";
  if (left === "integer") return right;
  if (right === "integer") return left;
  throw new CadParameterError(
    `Multiplication of ${left} by ${right} would create an unsupported compound dimension`,
    "dimension_mismatch",
  );
}

function divideDimension(
  left: CadParameterDimension,
  right: CadParameterDimension,
): CadParameterDimension {
  if (right === "scalar" || right === "integer") return left;
  if (left === right) return "scalar";
  throw new CadParameterError(
    `Division of ${left} by ${right} creates an unsupported dimension`,
    "dimension_mismatch",
  );
}

export function evaluateCadExpression(
  expressionInput: CadExpression,
  parameters: ReadonlyMap<string, CadQuantity>,
): CadQuantity {
  const expression = CAD_EXPRESSION_SCHEMA.parse(expressionInput);
  const evaluate = (candidate: CadExpression): CadQuantity => {
    switch (candidate.kind) {
      case "constant":
        return assertFinite({ value: candidate.value, dimension: candidate.dimension }, "Constant");
      case "parameter": {
        const value = parameters.get(candidate.parameterId);
        if (!value) {
          throw new CadParameterError(
            `Unknown parameter ${candidate.parameterId}`,
            "unknown_parameter",
            candidate.parameterId,
          );
        }
        return value;
      }
      case "negate": {
        const value = evaluate(candidate.value);
        return assertFinite({ value: -value.value, dimension: value.dimension }, "Negation");
      }
      case "binary": {
        const left = evaluate(candidate.left);
        const right = evaluate(candidate.right);
        if (candidate.operation === "add" || candidate.operation === "subtract") {
          const dimension = sameDimension(left, right, candidate.operation);
          return assertFinite({
            value: candidate.operation === "add"
              ? left.value + right.value
              : left.value - right.value,
            dimension,
          }, candidate.operation);
        }
        if (candidate.operation === "multiply") {
          return assertFinite({
            value: left.value * right.value,
            dimension: multiplyDimension(left.dimension, right.dimension),
          }, "Multiplication");
        }
        if (Math.abs(right.value) <= Number.EPSILON) {
          throw new CadParameterError("Division by zero", "division_by_zero");
        }
        return assertFinite({
          value: left.value / right.value,
          dimension: divideDimension(left.dimension, right.dimension),
        }, "Division");
      }
      case "function": {
        if (candidate.function === "abs" && candidate.arguments.length !== 1) {
          throw new CadParameterError("abs requires exactly one argument", "invalid_parameter");
        }
        const values = candidate.arguments.map(evaluate);
        const dimension = values[0]!.dimension;
        for (const value of values.slice(1)) sameDimension(values[0]!, value, candidate.function);
        const numbers = values.map((value) => value.value);
        const value = candidate.function === "abs"
          ? Math.abs(numbers[0]!)
          : candidate.function === "min"
            ? Math.min(...numbers)
            : Math.max(...numbers);
        return assertFinite({ value, dimension }, candidate.function);
      }
    }
  };
  return evaluate(expression);
}

export function evaluateCadParameters(
  parameterInputs: readonly CadParameter[],
): CadParameterEvaluation {
  const parameters = parameterInputs.map((parameter, index) => {
    const parsed = CAD_PARAMETER_SCHEMA.safeParse(parameter);
    if (!parsed.success) {
      throw new CadParameterError(
        `Invalid parameter at index ${index}: ${parsed.error.issues[0]?.message ?? "invalid value"}`,
        "invalid_parameter",
        `parameters[${index}]`,
      );
    }
    return parsed.data;
  });
  const definitions = new Map<string, CadParameter>();
  const names = new Set<string>();
  for (const parameter of parameters) {
    if (definitions.has(parameter.id) || names.has(parameter.name)) {
      throw new CadParameterError(
        `Duplicate parameter identity ${parameter.id} or name ${parameter.name}`,
        "duplicate_parameter",
        parameter.id,
      );
    }
    definitions.set(parameter.id, parameter);
    names.add(parameter.name);
  }

  const resolved = new Map<string, CadQuantity>();
  const visiting = new Set<string>();
  const resolve = (id: string): CadQuantity => {
    const existing = resolved.get(id);
    if (existing) return existing;
    const definition = definitions.get(id);
    if (!definition) throw new CadParameterError(`Unknown parameter ${id}`, "unknown_parameter", id);
    if (visiting.has(id)) {
      throw new CadParameterError(`Parameter dependency cycle includes ${id}`, "parameter_cycle", id);
    }
    visiting.add(id);
    const dependencyMap = new Proxy(resolved, {
      get(target, property, receiver) {
        if (property === "get") {
          return (dependencyId: string): CadQuantity | undefined => (
            definitions.has(dependencyId) ? resolve(dependencyId) : undefined
          );
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const value = evaluateCadExpression(definition.expression, dependencyMap);
    visiting.delete(id);
    if (value.dimension !== definition.dimension) {
      throw new CadParameterError(
        `Parameter ${definition.name} declares ${definition.dimension} but evaluates to ${value.dimension}`,
        "dimension_mismatch",
        id,
      );
    }
    resolved.set(id, value);
    return value;
  };
  for (const id of definitions.keys()) resolve(id);
  return Object.freeze({
    byId: resolved,
    byName: new Map(parameters.map((parameter) => [parameter.name, resolved.get(parameter.id)!])),
  });
}

export function evaluateCadLength(
  expression: CadExpression,
  parameters: ReadonlyMap<string, CadQuantity>,
  context: string,
): number {
  const result = evaluateCadExpression(expression, parameters);
  if (result.dimension !== "length") {
    throw new CadParameterError(`${context} must have length dimension`, "dimension_mismatch", context);
  }
  return result.value;
}

export function evaluateCadAngle(
  expression: CadExpression,
  parameters: ReadonlyMap<string, CadQuantity>,
  context: string,
): number {
  const result = evaluateCadExpression(expression, parameters);
  if (result.dimension !== "angle") {
    throw new CadParameterError(`${context} must have angle dimension`, "dimension_mismatch", context);
  }
  return result.value;
}
