// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ULTRA_BENCHMARK_WORKLOAD_ID,
  ULTRA_GIB,
  ULTRA_POLICY_VERSION,
  ULTRA_PROBE_MAXIMUM_AGE_MS,
  ULTRA_RECEIPT_REVALIDATION_MS,
  ULTRA_RECEIPT_TTL_MS,
  evaluateUltraRuntimeBenchmark,
  evaluateUltraStaticProbe,
  fingerprintUltraValue,
  issueUltraEligibilityReceipt,
  parseUltraActivationRequest,
  resolveUltraGate,
  ultraGracefulDegradation,
  validateUltraEligibilityReceipt,
  type UltraRuntimeBenchmarkInput,
  type UltraStaticProbe,
} from "../../xr/ultra";

const NOW = Date.parse("2026-08-25T08:00:00.000Z");

function validProbe(overrides: Partial<UltraStaticProbe> = {}): UltraStaticProbe {
  return {
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    platform: "windows",
    architecture: "x64",
    operatingSystemVersion: "Windows 11 24H2",
    logicalProcessorCount: 16,
    systemMemoryBytes: 32 * ULTRA_GIB,
    graphics: {
      adapterFingerprint: "adapter:approved-by-runtime",
      driverVersion: "1.2.3",
      hardwareAccelerated: true,
      supportedByRuntime: true,
    },
    runtime: {
      kind: "meta_horizon_link",
      version: "1.0.0",
      openXrActive: true,
    },
    webXr: {
      browserEngine: "chromium",
      secureContext: true,
      immersiveVrSupported: true,
    },
    collectedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function validBenchmark(overrides: Partial<UltraRuntimeBenchmarkInput> = {}): UltraRuntimeBenchmarkInput {
  return {
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
    transport: "link_cable",
    targetFrameRateHz: 90,
    durationMs: 60_000,
    frameTimeSamplesMs: Array.from({ length: 5_400 }, () => 11),
    droppedFrameCount: 0,
    maximumConsecutiveDroppedFrames: 0,
    processRssSamplesBytes: Array.from({ length: 60 }, () => 3 * ULTRA_GIB),
    gpuMemoryUsageRatioSamples: Array.from({ length: 60 }, () => 0.7),
    gpuMemoryHeadroomSamplesBytes: Array.from({ length: 60 }, () => 3 * ULTRA_GIB),
    thermalThrottleObserved: false,
    runtimeDisconnectCount: 0,
    completedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

async function eligibleEvidence() {
  const probe = await evaluateUltraStaticProbe(validProbe(), NOW);
  const benchmark = await evaluateUltraRuntimeBenchmark(validBenchmark(), NOW);
  return { probe, benchmark };
}

describe("Windows PCVR Ultra eligibility", () => {
  it("passes only observed Windows x64 Meta Horizon Link WebXR capability", async () => {
    const result = await evaluateUltraStaticProbe(validProbe(), NOW);
    expect(result).toMatchObject({ eligible: true, failures: [] });
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("does not claim that a Mac can host Meta Horizon Link PCVR", async () => {
    const result = await evaluateUltraStaticProbe(validProbe({
      platform: "macos",
      architecture: "arm64",
    }), NOW);
    expect(result.eligible).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(["windows_required", "x64_required"]));
  });

  it("fails closed for stale, insecure, or runtime-inferred probes", async () => {
    const result = await evaluateUltraStaticProbe(validProbe({
      collectedAt: new Date(NOW - 11 * 60_000).toISOString(),
      graphics: {
        ...validProbe().graphics,
        supportedByRuntime: false,
      },
      webXr: {
        ...validProbe().webXr,
        secureContext: false,
      },
    }), NOW);
    expect(result.failures).toEqual(expect.arrayContaining([
      "probe_stale",
      "graphics_runtime_unsupported",
      "secure_context_required",
    ]));
  });

  it("canonicalizes fingerprints independently of object key insertion order", async () => {
    await expect(Promise.all([
      fingerprintUltraValue({ b: 2, a: { y: 2, x: 1 } }),
      fingerprintUltraValue({ a: { x: 1, y: 2 }, b: 2 }),
    ])).resolves.toSatisfy(([left, right]) => left === right);
  });

  it("passes a fresh bounded physical benchmark", async () => {
    const result = await evaluateUltraRuntimeBenchmark(validBenchmark(), NOW);
    expect(result).toMatchObject({
      passed: true,
      failures: [],
      metrics: {
        observedFrameRateHz: 90,
        p95FrameTimeMs: 11,
        droppedFrameRatio: 0,
        maximumProcessRssBytes: 3 * ULTRA_GIB,
        maximumGpuMemoryUsageRatio: 0.7,
        minimumGpuMemoryHeadroomBytes: 3 * ULTRA_GIB,
      },
    });
  });

  it("rejects frame, memory, thermal, and disconnect regressions together", async () => {
    const result = await evaluateUltraRuntimeBenchmark(validBenchmark({
      frameTimeSamplesMs: Array.from({ length: 5_345 }, () => 12),
      droppedFrameCount: 55,
      maximumConsecutiveDroppedFrames: 3,
      processRssSamplesBytes: Array.from({ length: 60 }, () => 4 * ULTRA_GIB + 1),
      gpuMemoryUsageRatioSamples: Array.from({ length: 60 }, () => 0.81),
      gpuMemoryHeadroomSamplesBytes: Array.from({ length: 60 }, () => 2 * ULTRA_GIB - 1),
      thermalThrottleObserved: true,
      runtimeDisconnectCount: 1,
    }), NOW);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "frame_time_above_limit",
      "frame_rate_below_limit",
      "dropped_frame_ratio_above_limit",
      "consecutive_dropped_frames_above_limit",
      "process_rss_above_limit",
      "gpu_memory_usage_above_limit",
      "gpu_memory_headroom_below_limit",
      "thermal_throttling_observed",
      "runtime_disconnect_observed",
    ]));
  });

  it("fails closed for an unknown transport instead of treating it as Air Link", async () => {
    const input = {
      ...validBenchmark(),
      transport: "unknown_transport",
    } as unknown as UltraRuntimeBenchmarkInput;
    await expect(evaluateUltraRuntimeBenchmark(input, NOW)).resolves.toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["invalid_benchmark"]),
    });
  });

  it("issues a fingerprinted, expiring receipt with fixed revalidation windows", async () => {
    const { probe, benchmark } = await eligibleEvidence();
    const receipt = await issueUltraEligibilityReceipt(probe, benchmark, NOW);
    expect(Date.parse(receipt.revalidateAt) - Date.parse(receipt.issuedAt))
      .toBe(ULTRA_RECEIPT_REVALIDATION_MS);
    expect(ULTRA_RECEIPT_REVALIDATION_MS).toBe(ULTRA_PROBE_MAXIMUM_AGE_MS);
    expect(Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt)).toBe(ULTRA_RECEIPT_TTL_MS);
    await expect(validateUltraEligibilityReceipt(receipt, probe, benchmark, NOW + 1))
      .resolves.toEqual({ valid: true, status: "valid" });
  });

  it("requires revalidation, then expires, without an override path", async () => {
    const { probe, benchmark } = await eligibleEvidence();
    const receipt = await issueUltraEligibilityReceipt(probe, benchmark, NOW);
    await expect(validateUltraEligibilityReceipt(
      receipt,
      probe,
      benchmark,
      NOW + ULTRA_RECEIPT_REVALIDATION_MS,
    )).resolves.toEqual({ valid: false, status: "revalidation_required" });
    await expect(validateUltraEligibilityReceipt(
      receipt,
      probe,
      benchmark,
      NOW + ULTRA_RECEIPT_TTL_MS,
    )).resolves.toEqual({ valid: false, status: "expired" });
    expect(() => parseUltraActivationRequest({ version: 1, requestedMode: "ultra", force: true }))
      .toThrow("must contain only version and requestedMode");
  });

  it("revalidates the activation request at the public gate boundary", async () => {
    const { probe, benchmark } = await eligibleEvidence();
    const request = {
      version: 1,
      requestedMode: "ultra",
      force: true,
    } as unknown as Parameters<typeof resolveUltraGate>[0];
    await expect(resolveUltraGate(request, undefined, probe, benchmark, NOW))
      .rejects.toThrow("must contain only version and requestedMode");
  });

  it("detects receipt tampering and changed hardware fingerprints", async () => {
    const { probe, benchmark } = await eligibleEvidence();
    const receipt = await issueUltraEligibilityReceipt(probe, benchmark, NOW);
    await expect(validateUltraEligibilityReceipt({
      ...receipt,
      expiresAt: new Date(NOW + 7 * 24 * 60 * 60_000).toISOString(),
    }, probe, benchmark, NOW + 1)).resolves.toEqual({ valid: false, status: "invalid" });

    const changedProbe = await evaluateUltraStaticProbe(validProbe({
      graphics: { ...validProbe().graphics, adapterFingerprint: "adapter:changed" },
    }), NOW);
    await expect(validateUltraEligibilityReceipt(receipt, changedProbe, benchmark, NOW + 1))
      .resolves.toEqual({ valid: false, status: "probe_changed" });
  });

  it("rejects a structurally valid receipt after an untrusted JSON round trip", async () => {
    const { probe, benchmark } = await eligibleEvidence();
    const receipt = await issueUltraEligibilityReceipt(probe, benchmark, NOW);
    const parsed = JSON.parse(JSON.stringify(receipt));
    await expect(validateUltraEligibilityReceipt(parsed, probe, benchmark, NOW + 1))
      .resolves.toEqual({ valid: false, status: "invalid" });
    await expect(resolveUltraGate(
      parseUltraActivationRequest({ version: 1, requestedMode: "ultra" }),
      parsed,
      probe,
      benchmark,
      NOW + 1,
    )).resolves.toMatchObject({ state: "locked", effectiveMode: "balanced", reason: "invalid" });
  });

  it("is locked by default and degrades without discarding workspace state", async () => {
    const { probe, benchmark } = await eligibleEvidence();
    await expect(resolveUltraGate(
      parseUltraActivationRequest({ version: 1, requestedMode: "ultra" }),
      undefined,
      probe,
      benchmark,
      NOW,
    )).resolves.toMatchObject({
      effectiveMode: "balanced",
      state: "locked",
      reason: "missing",
      degradation: {
        preservesWorkspace: true,
        preservesCommittedState: true,
      },
    });
    expect(ultraGracefulDegradation("benchmark_failed").actions).toContain("disable_windows_pcvr_ultra");
  });

  it("unlocks Ultra only with current matching evidence and receipt", async () => {
    const { probe, benchmark } = await eligibleEvidence();
    const receipt = await issueUltraEligibilityReceipt(probe, benchmark, NOW);
    await expect(resolveUltraGate(
      parseUltraActivationRequest({ version: 1, requestedMode: "ultra" }),
      receipt,
      probe,
      benchmark,
      NOW + 1,
    )).resolves.toMatchObject({
      effectiveMode: "ultra",
      state: "eligible",
      reason: "valid",
      receiptFingerprint: receipt.fingerprint,
    });
  });
});
