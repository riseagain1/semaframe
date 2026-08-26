import {
  ULTRA_CLOCK_SKEW_MS,
  ULTRA_MINIMUM_SYSTEM_MEMORY_BYTES,
  ULTRA_POLICY_VERSION,
  ULTRA_PROBE_MAXIMUM_AGE_MS,
  type UltraStaticProbe,
  type UltraStaticProbeEvaluation,
  type UltraStaticProbeFailureCode,
} from "./contracts";
import { fingerprintUltraValue } from "./fingerprint";

function canonicalTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return undefined;
  return parsed;
}

function probeShapeIsValid(probe: UltraStaticProbe): boolean {
  return probe.version === 1
    && typeof probe.operatingSystemVersion === "string"
    && probe.operatingSystemVersion.length > 0
    && Number.isSafeInteger(probe.logicalProcessorCount)
    && probe.logicalProcessorCount > 0
    && Number.isSafeInteger(probe.systemMemoryBytes)
    && probe.systemMemoryBytes > 0
    && typeof probe.graphics?.adapterFingerprint === "string"
    && probe.graphics.adapterFingerprint.length > 0
    && typeof probe.graphics.driverVersion === "string"
    && probe.graphics.driverVersion.length > 0
    && typeof probe.graphics.hardwareAccelerated === "boolean"
    && typeof probe.graphics.supportedByRuntime === "boolean"
    && typeof probe.runtime?.openXrActive === "boolean"
    && typeof probe.webXr?.secureContext === "boolean"
    && typeof probe.webXr.immersiveVrSupported === "boolean"
    && canonicalTimestamp(probe.collectedAt) !== undefined;
}

/**
 * Evaluates only static, locally observed facts. It never infers Meta Horizon
 * Link support from a GPU name and it intentionally rejects macOS PCVR.
 */
export async function evaluateUltraStaticProbe(
  probe: UltraStaticProbe,
  now = Date.now(),
): Promise<UltraStaticProbeEvaluation> {
  const failures: UltraStaticProbeFailureCode[] = [];
  if (!probeShapeIsValid(probe) || !Number.isSafeInteger(now) || now < 0) {
    failures.push("invalid_probe");
  }
  if (probe.policyVersion !== ULTRA_POLICY_VERSION) failures.push("policy_mismatch");
  if (probe.platform !== "windows") failures.push("windows_required");
  if (probe.architecture !== "x64") failures.push("x64_required");
  if (probe.systemMemoryBytes < ULTRA_MINIMUM_SYSTEM_MEMORY_BYTES) {
    failures.push("system_memory_below_minimum");
  }
  if (!probe.graphics.hardwareAccelerated) failures.push("hardware_acceleration_required");
  if (!probe.graphics.supportedByRuntime) failures.push("graphics_runtime_unsupported");
  if (probe.runtime.kind !== "meta_horizon_link" || !probe.runtime.version) {
    failures.push("meta_horizon_link_required");
  }
  if (!probe.runtime.openXrActive) failures.push("openxr_runtime_inactive");
  if (probe.webXr.browserEngine !== "chromium") failures.push("chromium_required");
  if (!probe.webXr.secureContext) failures.push("secure_context_required");
  if (!probe.webXr.immersiveVrSupported) failures.push("immersive_webxr_unavailable");

  const collectedAt = canonicalTimestamp(probe.collectedAt);
  if (collectedAt !== undefined && Number.isSafeInteger(now) && now >= 0) {
    if (collectedAt > now + ULTRA_CLOCK_SKEW_MS) failures.push("probe_from_future");
    if (now - collectedAt > ULTRA_PROBE_MAXIMUM_AGE_MS) failures.push("probe_stale");
  }

  return Object.freeze({
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    eligible: failures.length === 0,
    failures: Object.freeze([...new Set(failures)]),
    fingerprint: await fingerprintUltraValue(probe),
    evaluatedAt: new Date(now).toISOString(),
  });
}
