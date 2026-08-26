// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ULTRA_POLICY_VERSION,
  type UltraRuntimeSystemSample,
  type UltraStaticProbe,
} from "../../xr/ultra";
import { XrNetworkError } from "../../xr/network";
import {
  parseUltraRuntimeSampleResponse,
  parseUltraStaticProbeResponse,
} from "../../xr/network/ultraEvidence";

const COLLECTED_AT = "2026-08-25T09:00:00.000Z";

function probe(): UltraStaticProbe {
  return {
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    platform: "windows",
    architecture: "x64",
    operatingSystemVersion: "10.0.26100",
    logicalProcessorCount: 24,
    systemMemoryBytes: 32 * 1024 * 1024 * 1024,
    graphics: {
      adapterFingerprint: `sha256:${"d".repeat(64)}`,
      driverVersion: "32.0.15.9000",
      hardwareAccelerated: true,
      supportedByRuntime: true,
    },
    runtime: { kind: "meta_horizon_link", version: "1.100.0", openXrActive: true },
    webXr: { browserEngine: "chromium", secureContext: true, immersiveVrSupported: true },
    collectedAt: COLLECTED_AT,
  };
}

function sample(): UltraRuntimeSystemSample {
  return {
    version: 1,
    transport: "link_cable",
    processRssBytes: 2 * 1024 * 1024 * 1024,
    gpuMemoryUsageRatio: 0.5,
    gpuMemoryHeadroomBytes: 6 * 1024 * 1024 * 1024,
    thermalThrottleObserved: false,
    runtimeConnected: true,
    sampledAt: COLLECTED_AT,
  };
}

describe("XR Ultra HTTP evidence validation", () => {
  it("accepts the exact versioned probe and runtime-sample envelopes", () => {
    expect(parseUltraStaticProbeResponse({ probe: probe() })).toEqual(probe());
    expect(parseUltraRuntimeSampleResponse({ sample: sample() })).toEqual(sample());
  });

  it.each([
    { probe: { ...probe(), unexpected: true } },
    { probe: { ...probe(), policyVersion: "forged-policy" } },
    { probe: { ...probe(), collectedAt: "not-a-timestamp" } },
    { sample: { ...sample(), transport: "force" } },
    { sample: { ...sample(), gpuMemoryUsageRatio: Number.NaN } },
    { sample: { ...sample(), sampledAt: "2026-08-25" } },
  ])("fails closed on malformed or extended evidence: %#", (value) => {
    const parse = Object.hasOwn(value, "probe")
      ? parseUltraStaticProbeResponse
      : parseUltraRuntimeSampleResponse;
    expect(() => parse(value)).toThrow(XrNetworkError);
  });
});
