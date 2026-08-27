import {
  ANONYMOUS_PERFORMANCE_DIAGNOSTIC_VERSION,
  PERFORMANCE_METRIC_ALLOWLIST,
  type AnonymousPerformanceDiagnosticPayload,
  type AnonymousPerformanceEnvironment,
  type AnonymousPerformanceMetrics,
  type PerformanceMetricName,
} from "./contracts";

const ENVIRONMENT_VALUES = Object.freeze({
  releaseChannel: new Set(["stable", "preview", "development"]),
  runtime: new Set(["browser", "desktop", "xr_viewer"]),
  renderer: new Set(["webgl", "webgpu", "unknown"]),
  hardwareTier: new Set(["low", "medium", "high", "unknown"]),
});

export class AnonymousDiagnosticValidationError extends TypeError {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "AnonymousDiagnosticValidationError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AnonymousDiagnosticValidationError(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AnonymousDiagnosticValidationError(path, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new AnonymousDiagnosticValidationError(path, "must not contain symbol properties");
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) {
      throw new AnonymousDiagnosticValidationError(path, "must contain data properties only");
    }
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  const body = record(value, path);
  const expected = new Set(keys);
  for (const key of Object.getOwnPropertyNames(body)) {
    if (!expected.has(key)) throw new AnonymousDiagnosticValidationError(`${path}.${key}`, "is not allowlisted");
  }
  for (const key of keys) {
    if (!Object.hasOwn(body, key)) throw new AnonymousDiagnosticValidationError(`${path}.${key}`, "is required");
  }
  return body;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>, path: string): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new AnonymousDiagnosticValidationError(path, "is not an allowlisted coarse category");
  }
  return value as T;
}

function parseEnvironment(value: unknown): AnonymousPerformanceEnvironment {
  const body = exact(value, ["releaseChannel", "runtime", "renderer", "hardwareTier"], "$.environment");
  return Object.freeze({
    releaseChannel: enumValue<AnonymousPerformanceEnvironment["releaseChannel"]>(
      body.releaseChannel, ENVIRONMENT_VALUES.releaseChannel, "$.environment.releaseChannel",
    ),
    runtime: enumValue<AnonymousPerformanceEnvironment["runtime"]>(
      body.runtime, ENVIRONMENT_VALUES.runtime, "$.environment.runtime",
    ),
    renderer: enumValue<AnonymousPerformanceEnvironment["renderer"]>(
      body.renderer, ENVIRONMENT_VALUES.renderer, "$.environment.renderer",
    ),
    hardwareTier: enumValue<AnonymousPerformanceEnvironment["hardwareTier"]>(
      body.hardwareTier, ENVIRONMENT_VALUES.hardwareTier, "$.environment.hardwareTier",
    ),
  });
}

function parseMetrics(value: unknown): AnonymousPerformanceMetrics {
  const body = record(value, "$.metrics");
  const metricNames = Object.keys(PERFORMANCE_METRIC_ALLOWLIST) as PerformanceMetricName[];
  const allowed = new Set<string>(metricNames);
  const names = Object.getOwnPropertyNames(body);
  if (names.length === 0) throw new AnonymousDiagnosticValidationError("$.metrics", "must contain at least one metric");
  const parsed: Partial<Record<PerformanceMetricName, number>> = {};
  for (const name of names) {
    if (!allowed.has(name)) throw new AnonymousDiagnosticValidationError(`$.metrics.${name}`, "is not allowlisted");
    const metricName = name as PerformanceMetricName;
    const value = body[metricName];
    const rule = PERFORMANCE_METRIC_ALLOWLIST[metricName];
    if (typeof value !== "number" || !Number.isFinite(value) || value < rule.minimum || value > rule.maximum) {
      throw new AnonymousDiagnosticValidationError(
        `$.metrics.${metricName}`,
        `must be a finite number between ${rule.minimum} and ${rule.maximum}`,
      );
    }
    parsed[metricName] = value;
  }
  return Object.freeze(parsed);
}

export function parseAnonymousPerformanceDiagnosticPayload(value: unknown): AnonymousPerformanceDiagnosticPayload {
  const body = exact(value, ["schemaVersion", "category", "environment", "metrics"], "$");
  if (body.schemaVersion !== ANONYMOUS_PERFORMANCE_DIAGNOSTIC_VERSION) {
    throw new AnonymousDiagnosticValidationError("$.schemaVersion", `must equal ${ANONYMOUS_PERFORMANCE_DIAGNOSTIC_VERSION}`);
  }
  if (body.category !== "performance") {
    throw new AnonymousDiagnosticValidationError("$.category", "must equal performance");
  }
  return Object.freeze({
    schemaVersion: ANONYMOUS_PERFORMANCE_DIAGNOSTIC_VERSION,
    category: "performance",
    environment: parseEnvironment(body.environment),
    metrics: parseMetrics(body.metrics),
  });
}
