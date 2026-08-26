import type {
  VoiceRelayTargetCandidate,
  VoiceRelayTargetCapabilities,
  VoiceRelayTargetSummary,
} from "../../src/voice-relay/contracts";

export const VOICE_RELAY_NATIVE_PROTOCOL_VERSION = 2;

export type VoiceRelayNativeHealth = Readonly<{
  protocolVersion: typeof VOICE_RELAY_NATIVE_PROTOCOL_VERSION;
  platform: "macos" | "windows" | "mock";
  accessibility: "authorized" | "denied" | "not_determined";
}>;

export type VoiceRelayNativeStageResult = Readonly<{
  outcome: "staged" | "blocked";
  verified: boolean;
  targetGeneration?: string;
  reason?: "target_lost" | "composer_not_empty" | "composer_unavailable" | "draft_mismatch";
}>;

export type VoiceRelayNativeConfiguredTarget = VoiceRelayTargetSummary & Readonly<{
  /** Opaque helper profile generation. Never expose this on the public target. */
  targetGeneration: string;
}>;

export type VoiceRelayNativeAbortResult = Readonly<{
  outcome: "cancelled" | "not_found" | "draft_changed" | "target_lost";
}>;

export type VoiceRelayNativeConfirmResult = Readonly<{
  outcome: "sent" | "blocked";
  observationId?: string;
  reason?: "target_lost" | "draft_changed" | "send_unavailable";
}>;

export type VoiceRelayNativeCancelResult = Readonly<{
  outcome: "cancelled" | "draft_changed" | "target_lost";
}>;

export type VoiceRelayNativeReplyResult = Readonly<{
  phase: "waiting" | "streaming" | "complete" | "unavailable";
  sequence: number;
  text?: string;
}>;

export type VoiceRelayNativeDraftProbeResult = Readonly<{
  outcome: "passed" | "blocked";
  reason?: "target_lost" | "composer_not_empty" | "composer_unavailable" | "draft_mismatch" | "cleanup_failed";
}>;

/**
 * The only privileged boundary in Voice Relay. Implementations retain native
 * process/window/control locators internally and expose opaque target IDs.
 */
export interface VoiceRelayNativePort {
  /**
   * Explicit, user-initiated setup boundary. On macOS this is the only call
   * allowed to ask the OS to show its Accessibility trust prompt.
   */
  prepareAccessibility(signal?: AbortSignal): Promise<VoiceRelayNativeHealth>;
  /** Passive and non-prompting health inspection. */
  health(signal?: AbortSignal): Promise<VoiceRelayNativeHealth>;
  discoverTargets(signal?: AbortSignal): Promise<readonly VoiceRelayTargetCandidate[]>;
  configureTarget(candidateId: string, signal?: AbortSignal): Promise<VoiceRelayNativeConfiguredTarget>;
  arm(targetId: string, signal?: AbortSignal): Promise<void>;
  disarm(signal?: AbortSignal): Promise<void>;
  testDraftRoundTrip(input: Readonly<{
    targetId: string;
    probeId: string;
    text: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeDraftProbeResult>;
  stageDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    text: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeStageResult>;
  /** Idempotent compensation for a stage request whose response was lost. */
  abortStage(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeAbortResult>;
  confirmDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeConfirmResult>;
  cancelDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeCancelResult>;
  readReply(input: Readonly<{
    targetId: string;
    observationId: string;
    afterSequence: number;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeReplyResult>;
  /**
   * Requests digest-checked shutdown and waits for natural helper exit. May
   * reject when cleanup cannot be proven, even though the helper is disabled.
   */
  close(): void | Promise<void>;
}

export function nativeTargetCapabilities(value: unknown): VoiceRelayTargetCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Voice Relay native target capabilities are invalid.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.draftInsertion !== "boolean"
    || typeof body.explicitSend !== "boolean"
    || typeof body.replyObservation !== "boolean") {
    throw new TypeError("Voice Relay native target capabilities are invalid.");
  }
  return Object.freeze({
    draftInsertion: body.draftInsertion,
    explicitSend: body.explicitSend,
    replyObservation: body.replyObservation,
  });
}
