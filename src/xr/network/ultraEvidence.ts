import {
  ULTRA_POLICY_VERSION,
  type UltraRuntimeSystemSample,
  type UltraStaticProbe,
} from "../ultra";
import { XrNetworkError } from "./contracts";

function invalid(): never {
  throw new XrNetworkError("invalid_response", "The XR relay returned invalid Ultra evidence.", false);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\p{Cc}/u.test(value)) invalid();
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid();
  return Number(value);
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function timestamp(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(Date.parse(result)).toISOString() !== result) invalid();
  return result;
}

export function parseUltraStaticProbeResponse(value: unknown): UltraStaticProbe {
  const envelope = record(value, ["probe"]);
  const body = record(envelope.probe, [
    "version", "policyVersion", "platform", "architecture", "operatingSystemVersion",
    "logicalProcessorCount", "systemMemoryBytes", "graphics", "runtime", "webXr", "collectedAt",
  ]);
  const graphics = record(body.graphics, [
    "adapterFingerprint", "driverVersion", "hardwareAccelerated", "supportedByRuntime",
  ]);
  const runtime = record(body.runtime, ["kind", "version", "openXrActive"]);
  const webXr = record(body.webXr, ["browserEngine", "secureContext", "immersiveVrSupported"]);
  if (body.version !== 1 || body.policyVersion !== ULTRA_POLICY_VERSION
    || !["windows", "macos", "linux", "unknown"].includes(String(body.platform))
    || !["x64", "arm64", "unknown"].includes(String(body.architecture))
    || !["meta_horizon_link", "none", "unknown"].includes(String(runtime.kind))
    || !["chromium", "unknown"].includes(String(webXr.browserEngine))
    || (runtime.version !== null && typeof runtime.version !== "string")) invalid();
  return Object.freeze({
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    platform: body.platform as UltraStaticProbe["platform"],
    architecture: body.architecture as UltraStaticProbe["architecture"],
    operatingSystemVersion: text(body.operatingSystemVersion, 256),
    logicalProcessorCount: integer(body.logicalProcessorCount, 1),
    systemMemoryBytes: integer(body.systemMemoryBytes, 1),
    graphics: Object.freeze({
      adapterFingerprint: text(graphics.adapterFingerprint, 256),
      driverVersion: text(graphics.driverVersion, 256),
      hardwareAccelerated: bool(graphics.hardwareAccelerated),
      supportedByRuntime: bool(graphics.supportedByRuntime),
    }),
    runtime: Object.freeze({
      kind: runtime.kind as UltraStaticProbe["runtime"]["kind"],
      version: runtime.version === null ? null : text(runtime.version, 256),
      openXrActive: bool(runtime.openXrActive),
    }),
    webXr: Object.freeze({
      browserEngine: webXr.browserEngine as UltraStaticProbe["webXr"]["browserEngine"],
      secureContext: bool(webXr.secureContext),
      immersiveVrSupported: bool(webXr.immersiveVrSupported),
    }),
    collectedAt: timestamp(body.collectedAt),
  });
}

export function parseUltraRuntimeSampleResponse(value: unknown): UltraRuntimeSystemSample {
  const envelope = record(value, ["sample"]);
  const body = record(envelope.sample, [
    "version", "transport", "processRssBytes", "gpuMemoryUsageRatio",
    "gpuMemoryHeadroomBytes", "thermalThrottleObserved", "runtimeConnected", "sampledAt",
  ]);
  if (body.version !== 1 || (body.transport !== "link_cable" && body.transport !== "air_link")
    || typeof body.gpuMemoryUsageRatio !== "number" || !Number.isFinite(body.gpuMemoryUsageRatio)
    || body.gpuMemoryUsageRatio < 0 || body.gpuMemoryUsageRatio > 1) invalid();
  return Object.freeze({
    version: 1,
    transport: body.transport,
    processRssBytes: integer(body.processRssBytes),
    gpuMemoryUsageRatio: body.gpuMemoryUsageRatio,
    gpuMemoryHeadroomBytes: integer(body.gpuMemoryHeadroomBytes),
    thermalThrottleObserved: bool(body.thermalThrottleObserved),
    runtimeConnected: bool(body.runtimeConnected),
    sampledAt: timestamp(body.sampledAt),
  });
}
