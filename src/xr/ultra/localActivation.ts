import {
  ULTRA_BENCHMARK_WORKLOAD_ID,
  ULTRA_CLOCK_SKEW_MS,
  ULTRA_MINIMUM_BENCHMARK_DURATION_MS,
  ULTRA_PROBE_MAXIMUM_AGE_MS,
  ULTRA_REQUIRED_FRAME_RATE_HZ,
  type UltraGateDecision,
  type UltraRuntimeBenchmarkEvaluation,
  type UltraRuntimeBenchmarkInput,
  type UltraStaticProbe,
  type UltraStaticProbeEvaluation,
} from "./contracts";
import { evaluateUltraRuntimeBenchmark } from "./benchmark";
import { parseUltraActivationRequest, resolveUltraGate } from "./gate";
import { evaluateUltraStaticProbe } from "./probe";
import { issueUltraEligibilityReceipt } from "./receipt";
import { xrRenderProfileForGate, type XrRenderProfile } from "./renderProfile";

export const SEMAFRAME_ULTRA_LOCAL_BRIDGE = "__SEMAFRAME_ULTRA_LOCAL_EVIDENCE_V1__" as const;

export type UltraLocalBenchmarkRequest = Readonly<{
  signal: AbortSignal;
  probeFingerprint: `sha256:${string}`;
  workloadId: typeof ULTRA_BENCHMARK_WORKLOAD_ID;
  minimumDurationMs: typeof ULTRA_MINIMUM_BENCHMARK_DURATION_MS;
  targetFrameRateHz: typeof ULTRA_REQUIRED_FRAME_RATE_HZ;
}>;

/**
 * Trusted local/native evidence boundary. It returns raw observations only;
 * receipts and gates are always generated inside this browser realm.
 */
export interface UltraLocalEvidencePort {
  collectStaticProbe(request: Readonly<{ signal: AbortSignal }>): Promise<UltraStaticProbe>;
  runPhysicalBenchmark(request: UltraLocalBenchmarkRequest): Promise<UltraRuntimeBenchmarkInput>;
}

export type UltraLocalActivationPhase =
  | "unavailable"
  | "unprobed"
  | "probing"
  | "available"
  | "confirming"
  | "benchmarking"
  | "eligible"
  | "locked";

export type UltraLocalActivationSnapshot = Readonly<{
  phase: UltraLocalActivationPhase;
  message: string;
  profile: XrRenderProfile;
  probe?: UltraStaticProbeEvaluation;
  benchmark?: UltraRuntimeBenchmarkEvaluation;
  gate?: UltraGateDecision;
}>;

/** Must be synchronous so WebXR transient activation remains available. */
export type UltraActivationConfirmation = () => boolean;

const BALANCED = xrRenderProfileForGate();

function aborted(signal: AbortSignal): never {
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Ultra verification was cancelled", "AbortError");
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) aborted(signal);
}

function unavailableSnapshot(message: string): UltraLocalActivationSnapshot {
  return Object.freeze({ phase: "unavailable", message, profile: BALANCED });
}

/**
 * Reads only a function-valued host bridge. Plain JSON/configuration can never
 * become an evidence provider or supply a pre-issued receipt.
 */
export function ultraLocalEvidencePortFromHost(
  host: unknown = globalThis,
): UltraLocalEvidencePort | undefined {
  if (typeof host !== "object" || host === null) return undefined;
  const candidate = (host as Record<string, unknown>)[SEMAFRAME_ULTRA_LOCAL_BRIDGE];
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Partial<UltraLocalEvidencePort>;
  if (typeof value.collectStaticProbe !== "function"
    || typeof value.runPhysicalBenchmark !== "function") return undefined;
  const collectStaticProbe = value.collectStaticProbe.bind(candidate);
  const runPhysicalBenchmark = value.runPhysicalBenchmark.bind(candidate);
  return Object.freeze({ collectStaticProbe, runPhysicalBenchmark });
}

/** One in-memory probe → confirmation → benchmark → receipt → gate pipeline. */
export class UltraLocalActivationController {
  private current: UltraLocalActivationSnapshot;
  // Keep the trusted raw observations only inside this controller so their
  // source timestamps can be re-evaluated. An evaluation timestamp is not a
  // substitute for evidence freshness.
  private rawProbe?: UltraStaticProbe;
  private rawBenchmark?: UltraRuntimeBenchmarkInput;
  private probeEvaluation?: UltraStaticProbeEvaluation;
  private benchmarkEvaluation?: UltraRuntimeBenchmarkEvaluation;
  private receipt?: Awaited<ReturnType<typeof issueUltraEligibilityReceipt>>;
  private gate?: UltraGateDecision;

  constructor(
    private readonly evidence: UltraLocalEvidencePort | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.current = evidence
      ? Object.freeze({
        phase: "unprobed",
        message: "Select Check Ultra to inspect local Windows, runtime, memory, and GPU eligibility.",
        profile: BALANCED,
      })
      : unavailableSnapshot("Windows PCVR Ultra requires a trusted local evidence bridge.");
  }

  get snapshot(): UltraLocalActivationSnapshot {
    return this.current;
  }

  async probe(signal: AbortSignal): Promise<UltraLocalActivationSnapshot> {
    if (!this.evidence) return this.current;
    this.publish({ phase: "probing", message: "Checking Windows PCVR Ultra support…", profile: BALANCED });
    ensureActive(signal);
    const raw = await this.evidence.collectStaticProbe({ signal });
    ensureActive(signal);
    const probe = await evaluateUltraStaticProbe(raw, this.now());
    ensureActive(signal);
    this.rawProbe = raw;
    this.rawBenchmark = undefined;
    this.probeEvaluation = probe;
    this.benchmarkEvaluation = undefined;
    this.receipt = undefined;
    this.gate = undefined;
    this.publish({
      phase: probe.eligible ? "available" : "locked",
      message: probe.eligible
        ? "Windows PCVR detected. A confirmed physical benchmark can enable Ultra."
        : `Windows PCVR Ultra unavailable: ${probe.failures.join(", ") || "probe rejected"}.`,
      profile: BALANCED,
      probe,
    });
    return this.current;
  }

  async activate(input: Readonly<{
    signal: AbortSignal;
    confirm: UltraActivationConfirmation;
  }>): Promise<UltraLocalActivationSnapshot> {
    if (!this.evidence) return this.current;
    // The explicit first-stage Check Ultra action collects the probe. Reuse
    // that eligible observation so the confirmed benchmark click can reach requestSession()
    // before transient WebXR user activation expires. Direct callers that did
    // not preflight still get the safe probe-first path, but may need a second
    // user gesture on browsers that enforce transient activation strictly.
    const evaluatedAt = this.probeEvaluation
      ? Date.parse(this.probeEvaluation.evaluatedAt)
      : Number.NaN;
    const now = this.now();
    const freshPreflight = Boolean(this.probeEvaluation)
      && Number.isFinite(evaluatedAt)
      && evaluatedAt <= now + ULTRA_CLOCK_SKEW_MS
      && now - evaluatedAt <= ULTRA_PROBE_MAXIMUM_AGE_MS;
    if (!freshPreflight) {
      const refreshed = await this.probe(input.signal);
      if (refreshed.probe?.eligible) {
        this.publish({
          ...refreshed,
          message: "Windows PCVR probe refreshed. Select Start Ultra benchmark to begin the physical measurement.",
        });
      }
      return this.current;
    }
    const probed = this.current;
    if (!probed.probe?.eligible) return probed;
    this.publish({ ...probed, phase: "confirming", message: "Waiting for benchmark confirmation…" });
    const confirmed = input.confirm();
    if (!confirmed) {
      this.publish({ ...probed, phase: "available", message: "Ultra benchmark was not confirmed." });
      return this.current;
    }
    ensureActive(input.signal);
    const probe = this.probeEvaluation!;
    const rawProbe = this.rawProbe;
    if (!rawProbe) {
      this.publish({
        phase: "locked",
        message: "Windows PCVR Ultra needs a fresh local probe.",
        profile: BALANCED,
      });
      return this.current;
    }
    this.publish({ ...probed, phase: "benchmarking", message: "Running the physical 90 Hz Ultra benchmark…" });
    // Calling the async evidence port before the next await lets its WebXR
    // adapter synchronously invoke navigator.xr.requestSession from the click.
    const benchmarkPromise = this.evidence.runPhysicalBenchmark({
      signal: input.signal,
      probeFingerprint: probe.fingerprint,
      workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
      minimumDurationMs: ULTRA_MINIMUM_BENCHMARK_DURATION_MS,
      targetFrameRateHz: ULTRA_REQUIRED_FRAME_RATE_HZ,
    });
    const rawBenchmark = await benchmarkPromise;
    ensureActive(input.signal);
    this.rawBenchmark = rawBenchmark;
    const completedAt = this.now();
    const [refreshedProbe, benchmark] = await Promise.all([
      evaluateUltraStaticProbe(rawProbe, completedAt),
      evaluateUltraRuntimeBenchmark(rawBenchmark, completedAt),
    ]);
    ensureActive(input.signal);
    this.probeEvaluation = refreshedProbe;
    this.benchmarkEvaluation = benchmark;
    if (!refreshedProbe.eligible || refreshedProbe.fingerprint !== probe.fingerprint) {
      this.receipt = undefined;
      this.gate = undefined;
      this.publish({
        phase: "locked",
        message: refreshedProbe.fingerprint !== probe.fingerprint
          ? "Windows PCVR Ultra probe changed during the benchmark. Run Check Ultra again."
          : `Windows PCVR Ultra probe expired during the benchmark: ${refreshedProbe.failures.join(", ") || "probe rejected"}.`,
        profile: BALANCED,
        probe: refreshedProbe,
        benchmark,
      });
      return this.current;
    }
    if (!benchmark.passed) {
      this.receipt = undefined;
      this.gate = undefined;
      this.publish({
        phase: "locked",
        message: `Ultra benchmark failed: ${benchmark.failures.join(", ") || "benchmark rejected"}.`,
        profile: BALANCED,
        probe: refreshedProbe,
        benchmark,
      });
      return this.current;
    }
    const receipt = await issueUltraEligibilityReceipt(refreshedProbe, benchmark, this.now());
    ensureActive(input.signal);
    const gate = await resolveUltraGate(
      parseUltraActivationRequest({ version: 1, requestedMode: "ultra" }),
      receipt,
      refreshedProbe,
      benchmark,
      this.now(),
    );
    const profile = xrRenderProfileForGate(gate);
    this.receipt = receipt;
    this.gate = gate;
    this.publish({
      phase: profile.mode === "ultra" ? "eligible" : "locked",
      message: profile.mode === "ultra"
        ? "Windows PCVR Ultra verified for this local session."
        : `Windows PCVR Ultra remained locked: ${gate.reason}.`,
      profile,
      probe: refreshedProbe,
      benchmark,
      gate,
    });
    return this.current;
  }

  /** Revalidates the exact in-memory evidence immediately before XR entry. */
  async profileForEntry(): Promise<XrRenderProfile> {
    const rawProbe = this.rawProbe;
    const rawBenchmark = this.rawBenchmark;
    const receipt = this.receipt;
    if (!rawProbe || !rawBenchmark || !receipt) return BALANCED;
    try {
      const now = this.now();
      const [probe, benchmark] = await Promise.all([
        evaluateUltraStaticProbe(rawProbe, now),
        evaluateUltraRuntimeBenchmark(rawBenchmark, now),
      ]);
      this.probeEvaluation = probe;
      this.benchmarkEvaluation = benchmark;
      const gate = await resolveUltraGate(
        parseUltraActivationRequest({ version: 1, requestedMode: "ultra" }),
        receipt,
        probe,
        benchmark,
        now,
      );
      const profile = xrRenderProfileForGate(gate);
      this.gate = gate;
      this.publish({
        phase: profile.mode === "ultra" ? "eligible" : "locked",
        message: profile.mode === "ultra"
          ? "Windows PCVR Ultra verified for this local session."
          : `Windows PCVR Ultra needs revalidation: ${gate.reason}.`,
        profile,
        probe,
        benchmark,
        gate,
      });
      return profile;
    } catch {
      this.receipt = undefined;
      this.gate = undefined;
      this.publish({
        phase: "locked",
        message: "Windows PCVR Ultra evidence could not be revalidated.",
        profile: BALANCED,
        ...(this.probeEvaluation ? { probe: this.probeEvaluation } : {}),
        ...(this.benchmarkEvaluation ? { benchmark: this.benchmarkEvaluation } : {}),
      });
      return BALANCED;
    }
  }

  private publish(snapshot: UltraLocalActivationSnapshot): void {
    this.current = Object.freeze({ ...snapshot });
  }
}
