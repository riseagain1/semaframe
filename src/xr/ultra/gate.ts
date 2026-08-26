import {
  ULTRA_DEFAULT_MODE,
  type UltraActivationRequest,
  type UltraDegradationPlan,
  type UltraEligibilityReceipt,
  type UltraGateDecision,
  type UltraReceiptStatus,
  type UltraRuntimeBenchmarkEvaluation,
  type UltraStaticProbeEvaluation,
} from "./contracts";
import { validateUltraEligibilityReceipt } from "./receipt";

const ACTIVATION_KEYS = Object.freeze(["requestedMode", "version"]);
const locallyResolvedEligibleGates = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict parsing is deliberate: there is no force, ignore, development, or
 * release-channel override in this contract.
 */
export function parseUltraActivationRequest(value: unknown): UltraActivationRequest {
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== ACTIVATION_KEYS.join(",")
    || value.version !== 1
    || (value.requestedMode !== "balanced" && value.requestedMode !== "ultra")) {
    throw new TypeError("Ultra activation request must contain only version and requestedMode");
  }
  return Object.freeze({ version: 1, requestedMode: value.requestedMode });
}

export function ultraGracefulDegradation(status: UltraReceiptStatus): UltraDegradationPlan {
  return Object.freeze({
    version: 1,
    targetMode: ULTRA_DEFAULT_MODE,
    preservesWorkspace: true,
    preservesCommittedState: true,
    actions: Object.freeze([
      "keep_workspace_open",
      "preserve_committed_state",
      "disable_windows_pcvr_ultra",
      "select_balanced_render_profile",
      "cap_target_frame_rate_72",
      "reduce_reality_splat_budget",
      "reduce_expensive_lighting",
    ] as const),
    revalidationRequired: status !== "missing" && status !== "probe_ineligible",
  });
}

export async function resolveUltraGate(
  request: UltraActivationRequest,
  receipt: UltraEligibilityReceipt | undefined,
  probe: UltraStaticProbeEvaluation,
  benchmark: UltraRuntimeBenchmarkEvaluation,
  now = Date.now(),
): Promise<UltraGateDecision> {
  // Re-parse at the trust boundary even for typed callers. TypeScript types do
  // not exist at runtime, so an untyped JS caller must not be able to smuggle a
  // force/override field past the public resolver.
  const parsedRequest = parseUltraActivationRequest(request);
  if (parsedRequest.requestedMode === "balanced") {
    return Object.freeze({
      version: 1,
      requestedMode: "balanced",
      effectiveMode: ULTRA_DEFAULT_MODE,
      state: "default",
      reason: "balanced_requested",
    });
  }
  const validation = await validateUltraEligibilityReceipt(receipt, probe, benchmark, now);
  if (validation.valid && receipt) {
    const gate = Object.freeze({
      version: 1,
      requestedMode: "ultra",
      effectiveMode: "ultra",
      state: "eligible",
      reason: "valid",
      receiptFingerprint: receipt.fingerprint,
    });
    locallyResolvedEligibleGates.add(gate);
    return gate;
  }
  return Object.freeze({
    version: 1,
    requestedMode: "ultra",
    effectiveMode: ULTRA_DEFAULT_MODE,
    state: "locked",
    reason: validation.status,
    degradation: ultraGracefulDegradation(validation.status),
  });
}

/** Runtime provenance check used by the profile resolver; JSON gates cannot unlock budgets. */
export function isLocallyResolvedEligibleUltraGate(value: unknown): value is UltraGateDecision {
  return typeof value === "object" && value !== null && locallyResolvedEligibleGates.has(value);
}
