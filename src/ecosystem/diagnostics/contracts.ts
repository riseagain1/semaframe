export const ANONYMOUS_PERFORMANCE_DIAGNOSTIC_VERSION = "1" as const;

export const PERFORMANCE_METRIC_ALLOWLIST = Object.freeze({
  startup_ms: Object.freeze({ minimum: 0, maximum: 600_000, unit: "ms" }),
  workspace_open_ms: Object.freeze({ minimum: 0, maximum: 600_000, unit: "ms" }),
  command_apply_p95_ms: Object.freeze({ minimum: 0, maximum: 60_000, unit: "ms" }),
  frame_p95_ms: Object.freeze({ minimum: 0, maximum: 10_000, unit: "ms" }),
  dropped_frame_ratio: Object.freeze({ minimum: 0, maximum: 1, unit: "ratio" }),
} as const);

export type PerformanceMetricName = keyof typeof PERFORMANCE_METRIC_ALLOWLIST;
export type AnonymousPerformanceMetrics = Readonly<Partial<Record<PerformanceMetricName, number>>>;

export type AnonymousPerformanceEnvironment = Readonly<{
  releaseChannel: "stable" | "preview" | "development";
  runtime: "browser" | "desktop" | "xr_viewer";
  renderer: "webgl" | "webgpu" | "unknown";
  hardwareTier: "low" | "medium" | "high" | "unknown";
}>;

export type AnonymousPerformanceDiagnosticPayload = Readonly<{
  schemaVersion: typeof ANONYMOUS_PERFORMANCE_DIAGNOSTIC_VERSION;
  category: "performance";
  environment: AnonymousPerformanceEnvironment;
  metrics: AnonymousPerformanceMetrics;
}>;

export type AnonymousPerformanceDiagnosticConfig = Readonly<{
  enabled: boolean;
}>;

export const DEFAULT_ANONYMOUS_PERFORMANCE_DIAGNOSTIC_CONFIG: AnonymousPerformanceDiagnosticConfig =
  Object.freeze({ enabled: false });

export type AnonymousPerformanceDiagnosticPreview = Readonly<{
  enabled: boolean;
  payload: AnonymousPerformanceDiagnosticPayload | null;
  serializedPayload: string | null;
  byteLength: number;
  notice: string;
}>;
