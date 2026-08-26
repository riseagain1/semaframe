import {
  ULTRA_BENCHMARK_MAXIMUM_AGE_MS,
  ULTRA_BENCHMARK_WORKLOAD_ID,
  ULTRA_CLOCK_SKEW_MS,
  ULTRA_MAXIMUM_BENCHMARK_DURATION_MS,
  ULTRA_MAXIMUM_CONSECUTIVE_DROPPED_FRAMES,
  ULTRA_MAXIMUM_DROPPED_FRAME_RATIO,
  ULTRA_MAXIMUM_GPU_MEMORY_USAGE_RATIO,
  ULTRA_MAXIMUM_P95_FRAME_TIME_MS,
  ULTRA_MAXIMUM_PROCESS_RSS_BYTES,
  ULTRA_MINIMUM_BENCHMARK_DURATION_MS,
  ULTRA_MINIMUM_GPU_HEADROOM_BYTES,
  ULTRA_POLICY_VERSION,
  ULTRA_REQUIRED_FRAME_RATE_HZ,
  type UltraBenchmarkFailureCode,
  type UltraBenchmarkMetrics,
  type UltraRuntimeBenchmarkEvaluation,
  type UltraRuntimeBenchmarkInput,
} from "./contracts";
import { fingerprintUltraValue } from "./fingerprint";

const MAXIMUM_SAMPLE_COUNT = 1_000_000;

function isFiniteSamples(values: readonly number[], minimumLength: number): boolean {
  return values.length >= minimumLength
    && values.length <= MAXIMUM_SAMPLE_COUNT
    && values.every((value) => Number.isFinite(value) && value >= 0);
}

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * ratio) - 1);
  return ordered[index] ?? Number.POSITIVE_INFINITY;
}

function maximum(values: readonly number[]): number {
  return values.reduce((result, value) => Math.max(result, value), Number.NEGATIVE_INFINITY);
}

function minimum(values: readonly number[]): number {
  return values.reduce((result, value) => Math.min(result, value), Number.POSITIVE_INFINITY);
}

function canonicalTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

function metricsFor(input: UltraRuntimeBenchmarkInput): UltraBenchmarkMetrics | undefined {
  if (!isFiniteSamples(input.frameTimeSamplesMs, 1)
    || !isFiniteSamples(input.processRssSamplesBytes, 10)
    || !isFiniteSamples(input.gpuMemoryUsageRatioSamples, 10)
    || !isFiniteSamples(input.gpuMemoryHeadroomSamplesBytes, 10)
    || !Number.isSafeInteger(input.durationMs) || input.durationMs <= 0
    || !Number.isSafeInteger(input.droppedFrameCount) || input.droppedFrameCount < 0
    || !Number.isSafeInteger(input.maximumConsecutiveDroppedFrames)
    || input.maximumConsecutiveDroppedFrames < 0) {
    return undefined;
  }
  const totalFrameOpportunities = input.frameTimeSamplesMs.length + input.droppedFrameCount;
  return Object.freeze({
    observedFrameRateHz: input.frameTimeSamplesMs.length / (input.durationMs / 1_000),
    p95FrameTimeMs: percentile(input.frameTimeSamplesMs, 0.95),
    droppedFrameRatio: totalFrameOpportunities === 0
      ? 1
      : input.droppedFrameCount / totalFrameOpportunities,
    maximumConsecutiveDroppedFrames: input.maximumConsecutiveDroppedFrames,
    maximumProcessRssBytes: maximum(input.processRssSamplesBytes),
    maximumGpuMemoryUsageRatio: maximum(input.gpuMemoryUsageRatioSamples),
    minimumGpuMemoryHeadroomBytes: minimum(input.gpuMemoryHeadroomSamplesBytes),
  });
}

/** Evaluates a bounded physical PCVR benchmark; names/spec sheets cannot pass it. */
export async function evaluateUltraRuntimeBenchmark(
  input: UltraRuntimeBenchmarkInput,
  now = Date.now(),
): Promise<UltraRuntimeBenchmarkEvaluation> {
  const failures: UltraBenchmarkFailureCode[] = [];
  const metrics = metricsFor(input);
  if (!metrics || input.version !== 1 || !Number.isSafeInteger(now) || now < 0
    || (input.transport !== "link_cable" && input.transport !== "air_link")
    || !Number.isFinite(input.targetFrameRateHz)
    || input.targetFrameRateHz <= 0
    || !Number.isSafeInteger(input.runtimeDisconnectCount)
    || input.runtimeDisconnectCount < 0
    || typeof input.thermalThrottleObserved !== "boolean"
    || canonicalTimestamp(input.completedAt) === undefined) {
    failures.push("invalid_benchmark");
  }
  if (input.policyVersion !== ULTRA_POLICY_VERSION) failures.push("policy_mismatch");
  if (input.workloadId !== ULTRA_BENCHMARK_WORKLOAD_ID) failures.push("workload_mismatch");
  if (input.durationMs < ULTRA_MINIMUM_BENCHMARK_DURATION_MS) failures.push("duration_below_minimum");
  if (input.durationMs > ULTRA_MAXIMUM_BENCHMARK_DURATION_MS) failures.push("duration_above_maximum");
  if (input.targetFrameRateHz !== ULTRA_REQUIRED_FRAME_RATE_HZ) failures.push("target_frame_rate_mismatch");

  const expectedFrames = input.targetFrameRateHz * input.durationMs / 1_000;
  if (input.frameTimeSamplesMs.length + input.droppedFrameCount < expectedFrames * 0.9) {
    failures.push("insufficient_frame_samples");
  }
  if (input.processRssSamplesBytes.length < 10
    || input.gpuMemoryUsageRatioSamples.length < 10
    || input.gpuMemoryHeadroomSamplesBytes.length < 10) {
    failures.push("insufficient_memory_samples");
  }

  const completedAt = canonicalTimestamp(input.completedAt);
  if (completedAt !== undefined && Number.isSafeInteger(now) && now >= 0) {
    if (completedAt > now + ULTRA_CLOCK_SKEW_MS) failures.push("benchmark_from_future");
    if (now - completedAt > ULTRA_BENCHMARK_MAXIMUM_AGE_MS) failures.push("benchmark_stale");
  }

  if (metrics) {
    if (metrics.p95FrameTimeMs > ULTRA_MAXIMUM_P95_FRAME_TIME_MS) {
      failures.push("frame_time_above_limit");
    }
    if (metrics.observedFrameRateHz < ULTRA_REQUIRED_FRAME_RATE_HZ * (1 - ULTRA_MAXIMUM_DROPPED_FRAME_RATIO)) {
      failures.push("frame_rate_below_limit");
    }
    if (metrics.droppedFrameRatio > ULTRA_MAXIMUM_DROPPED_FRAME_RATIO) {
      failures.push("dropped_frame_ratio_above_limit");
    }
    if (metrics.maximumConsecutiveDroppedFrames > ULTRA_MAXIMUM_CONSECUTIVE_DROPPED_FRAMES) {
      failures.push("consecutive_dropped_frames_above_limit");
    }
    if (metrics.maximumProcessRssBytes > ULTRA_MAXIMUM_PROCESS_RSS_BYTES) {
      failures.push("process_rss_above_limit");
    }
    if (metrics.maximumGpuMemoryUsageRatio > ULTRA_MAXIMUM_GPU_MEMORY_USAGE_RATIO) {
      failures.push("gpu_memory_usage_above_limit");
    }
    if (metrics.minimumGpuMemoryHeadroomBytes < ULTRA_MINIMUM_GPU_HEADROOM_BYTES) {
      failures.push("gpu_memory_headroom_below_limit");
    }
  }
  if (input.thermalThrottleObserved) failures.push("thermal_throttling_observed");
  if (input.runtimeDisconnectCount > 0) failures.push("runtime_disconnect_observed");

  return Object.freeze({
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    passed: failures.length === 0,
    failures: Object.freeze([...new Set(failures)]),
    ...(metrics ? { metrics } : {}),
    fingerprint: await fingerprintUltraValue(input),
    evaluatedAt: new Date(now).toISOString(),
  });
}
