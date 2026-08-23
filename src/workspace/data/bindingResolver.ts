import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { JSONSchema, JSONObject, JSONValue } from "../components/componentTypes";
import type { ResourceBinding, WorkspaceConnection, WorkspaceResource } from "./dataTypes";
import {
  assertWorkspaceResourceSafe,
  WorkspaceResourceValidationError,
} from "./resourceSecurity";

const bindingAjv = new Ajv2020({ allErrors: true, strict: false, strictNumbers: true });
addFormats(bindingAjv);
const propsValidators = new Map<string, ValidateFunction>();
const MAX_CACHED_PROPS_SCHEMAS = 128;
const MAX_BINDING_PATH_SEGMENTS = 32;
const MAX_TEMPLATE_OUTPUT_LENGTH = 100_000;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export type ResourceBindingDiagnosticCode =
  | "missing_component"
  | "missing_resource"
  | "missing_snapshot"
  | "live_binding_unavailable"
  | "unsafe_resource"
  | "stale_snapshot"
  | "duplicate_target"
  | "target_not_writable"
  | "target_not_bindable"
  | "missing_component_schema"
  | "source_path_not_found"
  | "invalid_transform"
  | "target_schema_mismatch";

export type ResourceBindingDiagnostic = Readonly<{
  bindingId: string;
  componentId: string;
  resourceId: string;
  targetProp: string;
  code: ResourceBindingDiagnosticCode;
  severity: "warning" | "error";
  message: string;
  details?: readonly string[];
}>;

export type ResourceBindingComponent = Readonly<{
  id: string;
  props: Readonly<JSONObject>;
  propsSchema?: JSONSchema;
  writableProps?: readonly string[];
  bindableProps?: readonly string[];
}>;

export type ResourceBindingResolution = Readonly<{
  effectiveProps: ReadonlyMap<string, JSONObject>;
  diagnostics: readonly ResourceBindingDiagnostic[];
}>;

type PathReadResult =
  | Readonly<{ ok: true; value: JSONValue }>
  | Readonly<{ ok: false; reason: string }>;

type TransformResult =
  | Readonly<{ ok: true; value: JSONValue }>
  | Readonly<{ ok: false; reason: string }>;

function errorDetails(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 16).map((error) =>
    `${error.instancePath || "/"} ${error.message ?? error.keyword}`,
  );
}

function validatorForPropsSchema(schema: JSONSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = propsValidators.get(key);
  if (cached) return cached;
  const validator = bindingAjv.compile(structuredClone(schema));
  if (propsValidators.size >= MAX_CACHED_PROPS_SCHEMAS) {
    const oldest = propsValidators.keys().next().value as string | undefined;
    if (oldest !== undefined) propsValidators.delete(oldest);
  }
  propsValidators.set(key, validator);
  return validator;
}

function parseBindingPath(path: string | undefined): readonly (string | number)[] | undefined {
  if (path === undefined || path.trim() === "" || path.trim() === "$") return [];
  const trimmed = path.trim();
  const segments: Array<string | number> = [];
  if (trimmed.startsWith("/")) {
    for (const encoded of trimmed.slice(1).split("/")) {
      let segment: string;
      try {
        segment = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
      } catch {
        return undefined;
      }
      if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined;
      segments.push(/^\d+$/u.test(segment) ? Number(segment) : segment);
      if (segments.length > MAX_BINDING_PATH_SEGMENTS) return undefined;
    }
    return segments;
  }

  let remaining = trimmed.startsWith("$") ? trimmed.slice(1) : `.${trimmed}`;
  while (remaining) {
    const property = /^\.([A-Za-z0-9_-]+)/u.exec(remaining);
    if (property) {
      const segment = property[1]!;
      if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined;
      segments.push(segment);
      remaining = remaining.slice(property[0].length);
    } else {
      const index = /^\[(\d+)\]/u.exec(remaining);
      if (index) {
        segments.push(Number(index[1]));
        remaining = remaining.slice(index[0].length);
      } else {
        const quoted = /^\["((?:\\.|[^"\\])*)"\]/u.exec(remaining);
        if (!quoted) return undefined;
        try {
          const segment = JSON.parse(`"${quoted[1]}"`) as string;
          if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined;
          segments.push(segment);
        } catch {
          return undefined;
        }
        remaining = remaining.slice(quoted[0].length);
      }
    }
    if (segments.length > MAX_BINDING_PATH_SEGMENTS) return undefined;
  }
  return segments;
}

function readBindingPath(value: JSONValue, path: string | undefined): PathReadResult {
  const segments = parseBindingPath(path);
  if (!segments) return { ok: false, reason: `Invalid binding path ${String(path)}` };
  let current: JSONValue = value;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !Number.isSafeInteger(segment) || segment >= current.length) {
        return { ok: false, reason: `Binding path ${String(path)} does not exist` };
      }
      current = current[segment]!;
      continue;
    }
    if (
      !current
      || typeof current !== "object"
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { ok: false, reason: `Binding path ${String(path)} does not exist` };
    }
    current = current[segment]!;
  }
  return { ok: true, value: structuredClone(current) };
}

function primitiveTemplateValue(value: JSONValue): string | undefined {
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function applyTransform(value: JSONValue, binding: ResourceBinding): TransformResult {
  const transform = binding.transform;
  if (transform.kind === "identity") return { ok: true, value: structuredClone(value) };
  if (transform.kind === "pick") {
    const selected = readBindingPath(value, transform.path);
    return selected.ok ? selected : { ok: false, reason: selected.reason };
  }
  if (transform.kind === "format_number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: "format_number requires one finite number" };
    }
    const decimals = transform.decimals ?? 0;
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 20) {
      return { ok: false, reason: "format_number decimals must be between 0 and 20" };
    }
    return {
      ok: true,
      value: `${transform.prefix ?? ""}${value.toFixed(decimals)}${transform.suffix ?? ""}`,
    };
  }
  const replacement = primitiveTemplateValue(value);
  if (replacement === undefined) {
    return { ok: false, reason: "template requires one primitive value" };
  }
  const result = transform.template.replace(/\{\{\s*value\s*\}\}/gu, replacement);
  if (result.length > MAX_TEMPLATE_OUTPUT_LENGTH) {
    return { ok: false, reason: `template output exceeds ${MAX_TEMPLATE_OUTPUT_LENGTH} characters` };
  }
  return { ok: true, value: result };
}

function diagnostic(
  binding: ResourceBinding,
  code: ResourceBindingDiagnosticCode,
  message: string,
  severity: "warning" | "error" = "error",
  details?: readonly string[],
): ResourceBindingDiagnostic {
  return {
    bindingId: binding.id,
    componentId: binding.componentId,
    resourceId: binding.resourceId,
    targetProp: binding.targetProp,
    code,
    severity,
    message,
    ...(details?.length ? { details: [...details] } : {}),
  };
}

/**
 * Resolve frozen resource snapshots into effective component props.
 *
 * This is a pure projection: canonical component props, resource snapshots,
 * connections, history, and Workspace revision are never mutated. Live
 * bindings deliberately fail closed until a trusted host runtime supplies a
 * separate live snapshot plane.
 */
export function resolveWorkspaceResourceBindings(input: Readonly<{
  components: readonly ResourceBindingComponent[];
  resources: ReadonlyMap<string, WorkspaceResource>;
  connections: ReadonlyMap<string, WorkspaceConnection>;
}>): ResourceBindingResolution {
  const effectiveProps = new Map<string, JSONObject>();
  const components = new Map(input.components.map((component) => [component.id, component] as const));
  const diagnostics: ResourceBindingDiagnostic[] = [];
  for (const component of input.components) {
    effectiveProps.set(component.id, structuredClone(component.props));
  }

  const bindings = [...input.connections.values()]
    .filter((connection): connection is ResourceBinding => connection.kind === "resource_binding" && connection.enabled)
    .sort((left, right) => left.id.localeCompare(right.id));
  const targetCounts = new Map<string, number>();
  for (const binding of bindings) {
    const key = `${binding.componentId}\u0000${binding.targetProp}`;
    targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
  }

  for (const binding of bindings) {
    const component = components.get(binding.componentId);
    if (!component) {
      diagnostics.push(diagnostic(binding, "missing_component", `Binding ${binding.id} targets a missing component`));
      continue;
    }
    const duplicateKey = `${binding.componentId}\u0000${binding.targetProp}`;
    if ((targetCounts.get(duplicateKey) ?? 0) > 1) {
      diagnostics.push(diagnostic(
        binding,
        "duplicate_target",
        `Multiple enabled bindings target ${binding.componentId}.${binding.targetProp}; none were projected`,
      ));
      continue;
    }
    if (binding.mode !== "snapshot") {
      diagnostics.push(diagnostic(
        binding,
        "live_binding_unavailable",
        `Live binding ${binding.id} requires a trusted host runtime`,
        "warning",
      ));
      continue;
    }
    const resource = input.resources.get(binding.resourceId);
    if (!resource) {
      diagnostics.push(diagnostic(binding, "missing_resource", `Binding ${binding.id} references a missing resource`));
      continue;
    }
    try {
      assertWorkspaceResourceSafe(resource);
    } catch (error) {
      const details = error instanceof WorkspaceResourceValidationError ? error.details : [];
      diagnostics.push(diagnostic(
        binding,
        "unsafe_resource",
        error instanceof Error ? error.message : `Resource ${resource.id} is invalid`,
        "error",
        details,
      ));
      continue;
    }
    if (!resource.snapshot) {
      diagnostics.push(diagnostic(binding, "missing_snapshot", `Resource ${resource.id} has no frozen snapshot`));
      continue;
    }
    if (resource.snapshot.stale) {
      diagnostics.push(diagnostic(
        binding,
        "stale_snapshot",
        `Binding ${binding.id} is using the frozen stale snapshot for ${resource.id}`,
        "warning",
      ));
    }
    if (!component.propsSchema) {
      diagnostics.push(diagnostic(
        binding,
        "missing_component_schema",
        `No exact props schema is available for ${binding.componentId}`,
      ));
      continue;
    }
    const bindableProps = component.bindableProps ?? component.writableProps;
    if (bindableProps && !bindableProps.includes(binding.targetProp)) {
      diagnostics.push(diagnostic(
        binding,
        "target_not_bindable",
        `Property ${binding.targetProp} is not bindable on ${binding.componentId}`,
      ));
      continue;
    }
    const source = readBindingPath(resource.snapshot.data, binding.sourcePath);
    if (!source.ok) {
      diagnostics.push(diagnostic(binding, "source_path_not_found", source.reason));
      continue;
    }
    const transformed = applyTransform(source.value, binding);
    if (!transformed.ok) {
      diagnostics.push(diagnostic(binding, "invalid_transform", transformed.reason));
      continue;
    }
    const current = effectiveProps.get(component.id) ?? structuredClone(component.props);
    const candidate = { ...structuredClone(current), [binding.targetProp]: structuredClone(transformed.value) };
    let validator: ValidateFunction;
    try {
      validator = validatorForPropsSchema(component.propsSchema);
    } catch (error) {
      diagnostics.push(diagnostic(
        binding,
        "missing_component_schema",
        `Component props schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
      ));
      continue;
    }
    if (!validator(candidate)) {
      const details = errorDetails(validator.errors);
      diagnostics.push(diagnostic(
        binding,
        "target_schema_mismatch",
        `Binding ${binding.id} does not produce valid props for ${component.id}: ${details.join("; ")}`,
        "error",
        details,
      ));
      continue;
    }
    effectiveProps.set(component.id, candidate);
  }
  return { effectiveProps, diagnostics };
}
