export const ULTRA_POLICY_VERSION = "windows-pcvr-ultra-v1" as const;
export const ULTRA_BENCHMARK_WORKLOAD_ID = "semaframe-ultra-tiered-material-shadow-v2" as const;
export const ULTRA_DEFAULT_MODE = "balanced" as const;

export const ULTRA_GIB = 1024 * 1024 * 1024;
export const ULTRA_MINIMUM_SYSTEM_MEMORY_BYTES = 16 * ULTRA_GIB;
export const ULTRA_MAXIMUM_PROCESS_RSS_BYTES = 4 * ULTRA_GIB;
export const ULTRA_MINIMUM_GPU_HEADROOM_BYTES = 2 * ULTRA_GIB;
export const ULTRA_MAXIMUM_GPU_MEMORY_USAGE_RATIO = 0.8;
export const ULTRA_REQUIRED_FRAME_RATE_HZ = 90;
export const ULTRA_MAXIMUM_P95_FRAME_TIME_MS = 11.2;
export const ULTRA_MAXIMUM_DROPPED_FRAME_RATIO = 0.01;
export const ULTRA_MAXIMUM_CONSECUTIVE_DROPPED_FRAMES = 2;
export const ULTRA_MINIMUM_BENCHMARK_DURATION_MS = 60_000;
export const ULTRA_MAXIMUM_BENCHMARK_DURATION_MS = 10 * 60_000;
export const ULTRA_PROBE_MAXIMUM_AGE_MS = 10 * 60_000;
export const ULTRA_BENCHMARK_MAXIMUM_AGE_MS = 10 * 60_000;
export const ULTRA_CLOCK_SKEW_MS = 60_000;
// Never let a locally issued gate outlive the maximum age of the physical
// probe/benchmark evidence that produced it.
export const ULTRA_RECEIPT_REVALIDATION_MS = 10 * 60_000;
export const ULTRA_RECEIPT_TTL_MS = 24 * 60 * 60_000;

export type UltraFingerprint = `sha256:${string}`;

export type UltraStaticProbe = Readonly<{
  version: 1;
  policyVersion: typeof ULTRA_POLICY_VERSION;
  platform: "windows" | "macos" | "linux" | "unknown";
  architecture: "x64" | "arm64" | "unknown";
  operatingSystemVersion: string;
  logicalProcessorCount: number;
  systemMemoryBytes: number;
  graphics: Readonly<{
    adapterFingerprint: string;
    driverVersion: string;
    hardwareAccelerated: boolean;
    supportedByRuntime: boolean;
  }>;
  runtime: Readonly<{
    kind: "meta_horizon_link" | "none" | "unknown";
    version: string | null;
    openXrActive: boolean;
  }>;
  webXr: Readonly<{
    browserEngine: "chromium" | "unknown";
    secureContext: boolean;
    immersiveVrSupported: boolean;
  }>;
  collectedAt: string;
}>;

export type UltraStaticProbeFailureCode =
  | "invalid_probe"
  | "policy_mismatch"
  | "windows_required"
  | "x64_required"
  | "probe_stale"
  | "probe_from_future"
  | "system_memory_below_minimum"
  | "hardware_acceleration_required"
  | "graphics_runtime_unsupported"
  | "meta_horizon_link_required"
  | "openxr_runtime_inactive"
  | "chromium_required"
  | "secure_context_required"
  | "immersive_webxr_unavailable";

export type UltraStaticProbeEvaluation = Readonly<{
  version: 1;
  policyVersion: typeof ULTRA_POLICY_VERSION;
  eligible: boolean;
  failures: readonly UltraStaticProbeFailureCode[];
  fingerprint: UltraFingerprint;
  evaluatedAt: string;
}>;

export type UltraTransport = "link_cable" | "air_link";

export type UltraRuntimeBenchmarkInput = Readonly<{
  version: 1;
  policyVersion: typeof ULTRA_POLICY_VERSION;
  workloadId: typeof ULTRA_BENCHMARK_WORKLOAD_ID;
  transport: UltraTransport;
  targetFrameRateHz: number;
  durationMs: number;
  frameTimeSamplesMs: readonly number[];
  droppedFrameCount: number;
  maximumConsecutiveDroppedFrames: number;
  processRssSamplesBytes: readonly number[];
  gpuMemoryUsageRatioSamples: readonly number[];
  gpuMemoryHeadroomSamplesBytes: readonly number[];
  thermalThrottleObserved: boolean;
  runtimeDisconnectCount: number;
  completedAt: string;
}>;

export type UltraBenchmarkFailureCode =
  | "invalid_benchmark"
  | "policy_mismatch"
  | "workload_mismatch"
  | "benchmark_stale"
  | "benchmark_from_future"
  | "duration_below_minimum"
  | "duration_above_maximum"
  | "target_frame_rate_mismatch"
  | "insufficient_frame_samples"
  | "insufficient_memory_samples"
  | "frame_time_above_limit"
  | "frame_rate_below_limit"
  | "dropped_frame_ratio_above_limit"
  | "consecutive_dropped_frames_above_limit"
  | "process_rss_above_limit"
  | "gpu_memory_usage_above_limit"
  | "gpu_memory_headroom_below_limit"
  | "thermal_throttling_observed"
  | "runtime_disconnect_observed";

export type UltraBenchmarkMetrics = Readonly<{
  observedFrameRateHz: number;
  p95FrameTimeMs: number;
  droppedFrameRatio: number;
  maximumConsecutiveDroppedFrames: number;
  maximumProcessRssBytes: number;
  maximumGpuMemoryUsageRatio: number;
  minimumGpuMemoryHeadroomBytes: number;
}>;

export type UltraRuntimeBenchmarkEvaluation = Readonly<{
  version: 1;
  policyVersion: typeof ULTRA_POLICY_VERSION;
  passed: boolean;
  failures: readonly UltraBenchmarkFailureCode[];
  metrics?: UltraBenchmarkMetrics;
  fingerprint: UltraFingerprint;
  evaluatedAt: string;
}>;

export type UltraEligibilityReceipt = Readonly<{
  version: 1;
  policyVersion: typeof ULTRA_POLICY_VERSION;
  scope: "windows_pcvr_ultra";
  status: "eligible";
  probeFingerprint: UltraFingerprint;
  benchmarkFingerprint: UltraFingerprint;
  issuedAt: string;
  revalidateAt: string;
  expiresAt: string;
  fingerprint: UltraFingerprint;
}>;

export type UltraReceiptStatus =
  | "valid"
  | "missing"
  | "invalid"
  | "policy_mismatch"
  | "probe_ineligible"
  | "benchmark_failed"
  | "probe_changed"
  | "benchmark_changed"
  | "revalidation_required"
  | "expired";

export type UltraReceiptValidation = Readonly<{
  valid: boolean;
  status: UltraReceiptStatus;
}>;

export type UltraActivationRequest = Readonly<{
  version: 1;
  requestedMode: "balanced" | "ultra";
}>;

export type UltraDegradationAction =
  | "keep_workspace_open"
  | "preserve_committed_state"
  | "disable_windows_pcvr_ultra"
  | "select_balanced_render_profile"
  | "cap_target_frame_rate_72"
  | "reduce_reality_splat_budget"
  | "reduce_expensive_lighting";

export type UltraDegradationPlan = Readonly<{
  version: 1;
  targetMode: typeof ULTRA_DEFAULT_MODE;
  preservesWorkspace: true;
  preservesCommittedState: true;
  actions: readonly UltraDegradationAction[];
  revalidationRequired: boolean;
}>;

export type UltraGateDecision = Readonly<{
  version: 1;
  requestedMode: "balanced" | "ultra";
  effectiveMode: "balanced" | "ultra";
  state: "default" | "eligible" | "locked";
  reason: "balanced_requested" | UltraReceiptStatus;
  receiptFingerprint?: UltraFingerprint;
  degradation?: UltraDegradationPlan;
}>;
