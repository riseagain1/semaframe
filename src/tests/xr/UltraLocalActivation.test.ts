import { describe, expect, it, vi } from "vitest";
import {
  SEMAFRAME_ULTRA_LOCAL_BRIDGE,
  ULTRA_BENCHMARK_WORKLOAD_ID,
  ULTRA_GIB,
  ULTRA_POLICY_VERSION,
  ULTRA_PROBE_MAXIMUM_AGE_MS,
  UltraLocalActivationController,
  ultraLocalEvidencePortFromHost,
  type UltraLocalEvidencePort,
  type UltraRuntimeBenchmarkInput,
  type UltraStaticProbe,
} from "../../xr/ultra";

const NOW = Date.parse("2026-08-25T08:00:00.000Z");

function probe(): UltraStaticProbe {
  return {
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    platform: "windows",
    architecture: "x64",
    operatingSystemVersion: "11.0.26100",
    logicalProcessorCount: 16,
    systemMemoryBytes: 32 * ULTRA_GIB,
    graphics: {
      adapterFingerprint: "local-adapter-fingerprint",
      driverVersion: "580.1",
      hardwareAccelerated: true,
      supportedByRuntime: true,
    },
    runtime: { kind: "meta_horizon_link", version: "80.0", openXrActive: true },
    webXr: { browserEngine: "chromium", secureContext: true, immersiveVrSupported: true },
    collectedAt: new Date(NOW).toISOString(),
  };
}

function benchmark(): UltraRuntimeBenchmarkInput {
  return {
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
    transport: "link_cable",
    targetFrameRateHz: 90,
    durationMs: 60_000,
    frameTimeSamplesMs: Array.from({ length: 5_400 }, () => 10),
    droppedFrameCount: 0,
    maximumConsecutiveDroppedFrames: 0,
    processRssSamplesBytes: Array.from({ length: 10 }, () => 2 * ULTRA_GIB),
    gpuMemoryUsageRatioSamples: Array.from({ length: 10 }, () => 0.6),
    gpuMemoryHeadroomSamplesBytes: Array.from({ length: 10 }, () => 3 * ULTRA_GIB),
    thermalThrottleObserved: false,
    runtimeDisconnectCount: 0,
    completedAt: new Date(NOW).toISOString(),
  };
}

function evidence(): UltraLocalEvidencePort {
  return {
    collectStaticProbe: vi.fn(async () => probe()),
    runPhysicalBenchmark: vi.fn(async () => benchmark()),
  };
}

describe("local Windows PCVR Ultra activation", () => {
  it("requires an explicit confirmation before the physical benchmark", async () => {
    const port = evidence();
    const controller = new UltraLocalActivationController(port, () => NOW);
    await controller.probe(new AbortController().signal);
    const result = await controller.activate({
      signal: new AbortController().signal,
      confirm: () => false,
    });
    expect(result).toMatchObject({ phase: "available", profile: { mode: "balanced" } });
    expect(port.collectStaticProbe).toHaveBeenCalledOnce();
    expect(port.runPhysicalBenchmark).not.toHaveBeenCalled();
  });

  it("binds a fresh local probe to the benchmark and unlocks only its locally issued gate", async () => {
    const port = evidence();
    let benchmarkStartedInsideGesture = false;
    port.runPhysicalBenchmark = vi.fn(() => {
      benchmarkStartedInsideGesture = true;
      return Promise.resolve(benchmark());
    });
    const controller = new UltraLocalActivationController(port, () => NOW);
    await controller.probe(new AbortController().signal);
    const activation = controller.activate({
      signal: new AbortController().signal,
      confirm: () => true,
    });
    expect(benchmarkStartedInsideGesture).toBe(true);
    const result = await activation;
    expect(result).toMatchObject({
      phase: "eligible",
      profile: { mode: "ultra", targetFrameRateHz: 90 },
      probe: { eligible: true },
      benchmark: { passed: true },
      gate: { state: "eligible", effectiveMode: "ultra" },
    });
    expect(port.runPhysicalBenchmark).toHaveBeenCalledWith(expect.objectContaining({
      probeFingerprint: result.probe?.fingerprint,
      workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
      minimumDurationMs: 60_000,
      targetFrameRateHz: 90,
      signal: expect.any(AbortSignal),
    }));
    await expect(controller.profileForEntry()).resolves.toMatchObject({ mode: "ultra" });
  });

  it("refreshes a missing preflight without spending that click on a WebXR session", async () => {
    const port = evidence();
    const controller = new UltraLocalActivationController(port, () => NOW);
    const confirm = vi.fn(() => true);
    const first = await controller.activate({
      signal: new AbortController().signal,
      confirm,
    });
    expect(first).toMatchObject({
      phase: "available",
      message: expect.stringContaining("Start Ultra benchmark"),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(port.runPhysicalBenchmark).not.toHaveBeenCalled();

    await controller.activate({ signal: new AbortController().signal, confirm });
    expect(confirm).toHaveBeenCalledOnce();
    expect(port.runPhysicalBenchmark).toHaveBeenCalledOnce();
  });

  it("fails closed when the raw probe crosses its freshness boundary during the benchmark", async () => {
    let currentTime = NOW;
    const rawProbe: UltraStaticProbe = {
      ...probe(),
      collectedAt: new Date(NOW - ULTRA_PROBE_MAXIMUM_AGE_MS + 30_000).toISOString(),
    };
    const port: UltraLocalEvidencePort = {
      collectStaticProbe: vi.fn(async () => rawProbe),
      runPhysicalBenchmark: vi.fn(async () => {
        currentTime += 60_001;
        return { ...benchmark(), completedAt: new Date(currentTime).toISOString() };
      }),
    };
    const controller = new UltraLocalActivationController(port, () => currentTime);
    await expect(controller.probe(new AbortController().signal)).resolves.toMatchObject({
      phase: "available",
      probe: { eligible: true },
    });

    const result = await controller.activate({
      signal: new AbortController().signal,
      confirm: () => true,
    });

    expect(result).toMatchObject({
      phase: "locked",
      profile: { mode: "balanced" },
      probe: { eligible: false, failures: expect.arrayContaining(["probe_stale"]) },
      benchmark: { passed: true },
    });
    await expect(controller.profileForEntry()).resolves.toMatchObject({ mode: "balanced" });
  });

  it("re-evaluates raw evidence and updates the snapshot immediately before entry", async () => {
    let currentTime = NOW;
    const port = evidence();
    const controller = new UltraLocalActivationController(port, () => currentTime);
    await controller.probe(new AbortController().signal);
    await expect(controller.activate({
      signal: new AbortController().signal,
      confirm: () => true,
    })).resolves.toMatchObject({ phase: "eligible" });

    currentTime = NOW + ULTRA_PROBE_MAXIMUM_AGE_MS + 1;
    await expect(controller.profileForEntry()).resolves.toMatchObject({ mode: "balanced" });
    expect(controller.snapshot).toMatchObject({
      phase: "locked",
      profile: { mode: "balanced" },
      probe: { eligible: false, failures: expect.arrayContaining(["probe_stale"]) },
      benchmark: { passed: false, failures: expect.arrayContaining(["benchmark_stale"]) },
      gate: { state: "locked", effectiveMode: "balanced", reason: "probe_ineligible" },
    });
  });

  it("accepts only a function-valued host bridge, never plain evidence JSON", () => {
    expect(ultraLocalEvidencePortFromHost({
      [SEMAFRAME_ULTRA_LOCAL_BRIDGE]: { probe: probe(), benchmark: benchmark() },
    })).toBeUndefined();
    const port = evidence();
    expect(ultraLocalEvidencePortFromHost({ [SEMAFRAME_ULTRA_LOCAL_BRIDGE]: port }))
      .toMatchObject({
        collectStaticProbe: expect.any(Function),
        runPhysicalBenchmark: expect.any(Function),
      });
  });
});
