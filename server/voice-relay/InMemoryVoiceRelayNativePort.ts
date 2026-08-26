import { createHash } from "node:crypto";
import type {
  VoiceRelayTargetCandidate,
  VoiceRelayTargetSummary,
} from "../../src/voice-relay/contracts";
import type {
  VoiceRelayNativeAbortResult,
  VoiceRelayNativeCancelResult,
  VoiceRelayNativeConfirmResult,
  VoiceRelayNativeConfiguredTarget,
  VoiceRelayNativeDraftProbeResult,
  VoiceRelayNativeHealth,
  VoiceRelayNativePort,
  VoiceRelayNativeReplyResult,
  VoiceRelayNativeStageResult,
} from "./VoiceRelayNativePort";
import { VOICE_RELAY_NATIVE_PROTOCOL_VERSION } from "./VoiceRelayNativePort";

const DEFAULT_TARGET: VoiceRelayTargetSummary = Object.freeze({
  targetId: "mock-agent-main",
  label: "Mock Agent",
  capabilities: Object.freeze({
    draftInsertion: true,
    explicitSend: true,
    replyObservation: true,
  }),
});

const DEFAULT_CANDIDATE: VoiceRelayTargetCandidate = Object.freeze({
  candidateId: "mock-candidate-main",
  label: "Mock Agent — Conversation",
  applicationLabel: "Mock Agent",
  compatible: true,
});

export type InMemoryVoiceRelayNativeOptions = Readonly<{
  accessibility?: VoiceRelayNativeHealth["accessibility"];
  target?: VoiceRelayTargetSummary;
  candidate?: VoiceRelayTargetCandidate;
}>;

/** Deterministic non-persistent native double used by service and E2E tests. */
export class InMemoryVoiceRelayNativePort implements VoiceRelayNativePort {
  readonly target: VoiceRelayTargetSummary;
  readonly candidate: VoiceRelayTargetCandidate;
  accessibility: VoiceRelayNativeHealth["accessibility"];
  draft = "";
  sendCount = 0;
  stageCount = 0;
  cancelCount = 0;
  abortCount = 0;
  probeCount = 0;
  prepareAccessibilityCount = 0;
  closed = false;
  #configured = false;
  #armed = false;
  #activeStageId?: string;
  #activeDraftDigest?: string;
  #replyText = "";
  #replyPhase: VoiceRelayNativeReplyResult["phase"] = "waiting";
  #replySequence = 0;
  #failConfirmAfterSend = false;

  constructor(options: InMemoryVoiceRelayNativeOptions = {}) {
    this.accessibility = options.accessibility ?? "authorized";
    this.target = options.target ?? DEFAULT_TARGET;
    this.candidate = options.candidate ?? DEFAULT_CANDIDATE;
  }

  async health(): Promise<VoiceRelayNativeHealth> {
    this.#assertOpen();
    return Object.freeze({
      protocolVersion: VOICE_RELAY_NATIVE_PROTOCOL_VERSION,
      platform: "mock",
      accessibility: this.accessibility,
    });
  }

  async prepareAccessibility(): Promise<VoiceRelayNativeHealth> {
    this.prepareAccessibilityCount += 1;
    return this.health();
  }

  async discoverTargets(): Promise<readonly VoiceRelayTargetCandidate[]> {
    this.#assertOpen();
    return this.accessibility === "authorized" ? Object.freeze([this.candidate]) : Object.freeze([]);
  }

  async configureTarget(candidateId: string): Promise<VoiceRelayNativeConfiguredTarget> {
    this.#assertOpen();
    if (this.accessibility !== "authorized") throw new Error("Accessibility permission is not authorized.");
    if (candidateId !== this.candidate.candidateId || !this.candidate.compatible) throw new Error("Target is incompatible.");
    this.#configured = true;
    return Object.freeze({ ...this.target, targetGeneration: "mock-generation-1" });
  }

  async arm(targetId: string): Promise<void> {
    this.#assertOpen();
    if (!this.#configured || targetId !== this.target.targetId) throw new Error("Target is unavailable.");
    this.#armed = true;
  }

  async disarm(): Promise<void> {
    this.#assertOpen();
    this.#cleanupActiveDraftIfUnchanged();
    this.#armed = false;
  }

  async testDraftRoundTrip(input: Readonly<{
    targetId: string;
    probeId: string;
    text: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>): Promise<VoiceRelayNativeDraftProbeResult> {
    this.#assertOpen();
    if (!this.#configured
      || input.targetId !== this.target.targetId
      || input.targetGeneration !== "mock-generation-1") {
      return Object.freeze({ outcome: "blocked", reason: "target_lost" });
    }
    if (this.draft !== "") return Object.freeze({ outcome: "blocked", reason: "composer_not_empty" });
    const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    this.draft = input.text;
    if (digest(this.draft) !== input.expectedDraftDigest) {
      return Object.freeze({ outcome: "blocked", reason: "draft_mismatch" });
    }
    // Removal is conditional on the exact probe still being present.
    if (digest(this.draft) !== input.expectedDraftDigest) {
      return Object.freeze({ outcome: "blocked", reason: "cleanup_failed" });
    }
    this.draft = "";
    this.probeCount += 1;
    return Object.freeze({ outcome: "passed" });
  }

  async stageDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    text: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, _signal?: AbortSignal): Promise<VoiceRelayNativeStageResult> {
    this.#assertArmed(input.targetId);
    if (input.targetGeneration !== "mock-generation-1") {
      return Object.freeze({ outcome: "blocked", verified: false, reason: "target_lost" });
    }
    if (this.draft !== "") {
      return Object.freeze({ outcome: "blocked", verified: false, reason: "composer_not_empty" });
    }
    const actual = createHash("sha256").update(input.text, "utf8").digest("hex");
    if (actual !== input.expectedDraftDigest) {
      return Object.freeze({ outcome: "blocked", verified: false, reason: "draft_mismatch" });
    }
    this.draft = input.text;
    this.#activeStageId = input.stageId;
    this.#activeDraftDigest = input.expectedDraftDigest;
    this.stageCount += 1;
    return Object.freeze({
      outcome: "staged",
      verified: createHash("sha256").update(this.draft, "utf8").digest("hex") === input.expectedDraftDigest,
      targetGeneration: "mock-generation-1",
    });
  }

  async abortStage(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>): Promise<VoiceRelayNativeAbortResult> {
    this.#assertOpen();
    this.abortCount += 1;
    if (!this.#armed
      || input.targetId !== this.target.targetId
      || input.targetGeneration !== "mock-generation-1") {
      return Object.freeze({ outcome: "target_lost" });
    }
    if (this.#activeStageId !== input.stageId || this.#activeDraftDigest !== input.expectedDraftDigest) {
      return Object.freeze({ outcome: "not_found" });
    }
    this.#activeStageId = undefined;
    this.#activeDraftDigest = undefined;
    if (createHash("sha256").update(this.draft, "utf8").digest("hex") !== input.expectedDraftDigest) {
      return Object.freeze({ outcome: "draft_changed" });
    }
    this.draft = "";
    return Object.freeze({ outcome: "cancelled" });
  }

  async confirmDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>): Promise<VoiceRelayNativeConfirmResult> {
    this.#assertArmed(input.targetId);
    if (this.#activeStageId !== input.stageId
      || input.targetGeneration !== "mock-generation-1"
      || createHash("sha256").update(this.draft, "utf8").digest("hex") !== input.expectedDraftDigest) {
      return Object.freeze({ outcome: "blocked", reason: "draft_changed" });
    }
    this.sendCount += 1;
    this.draft = "";
    this.#activeStageId = undefined;
    this.#activeDraftDigest = undefined;
    const observationId = `mock-observation-${input.stageId}`;
    if (this.#failConfirmAfterSend) {
      this.#failConfirmAfterSend = false;
      throw new Error("Simulated acknowledgement loss after Send.");
    }
    return Object.freeze({
      outcome: "sent",
      ...(this.target.capabilities.replyObservation ? { observationId } : {}),
    });
  }

  async cancelDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>): Promise<VoiceRelayNativeCancelResult> {
    this.#assertArmed(input.targetId);
    if (this.#activeStageId !== input.stageId
      || input.targetGeneration !== "mock-generation-1"
      || createHash("sha256").update(this.draft, "utf8").digest("hex") !== input.expectedDraftDigest) {
      return Object.freeze({ outcome: "draft_changed" });
    }
    this.draft = "";
    this.#activeStageId = undefined;
    this.#activeDraftDigest = undefined;
    this.cancelCount += 1;
    return Object.freeze({ outcome: "cancelled" });
  }

  async readReply(input: Readonly<{
    targetId: string;
    observationId: string;
    afterSequence: number;
  }>): Promise<VoiceRelayNativeReplyResult> {
    this.#assertArmed(input.targetId);
    if (!input.observationId.startsWith("mock-observation-")) {
      return Object.freeze({ phase: "unavailable", sequence: input.afterSequence });
    }
    return Object.freeze({
      phase: this.#replyPhase,
      sequence: this.#replySequence,
      ...(this.#replySequence > input.afterSequence && this.#replyText ? { text: this.#replyText } : {}),
    });
  }

  setReply(text: string, phase: "streaming" | "complete" = "complete"): void {
    this.#replyText = text;
    this.#replyPhase = phase;
    this.#replySequence += 1;
  }

  editDraft(text: string): void {
    this.draft = text;
  }

  failNextConfirmAfterSend(): void {
    this.#failConfirmAfterSend = true;
  }

  async close(): Promise<void> {
    this.#cleanupActiveDraftIfUnchanged();
    this.closed = true;
    this.#configured = false;
    this.#armed = false;
    this.#replyText = "";
  }

  #cleanupActiveDraftIfUnchanged(): void {
    if (this.#activeStageId !== undefined
      && this.#activeDraftDigest !== undefined
      && createHash("sha256").update(this.draft, "utf8").digest("hex") === this.#activeDraftDigest) {
      this.draft = "";
    }
    this.#activeStageId = undefined;
    this.#activeDraftDigest = undefined;
  }

  #assertOpen(): void {
    if (this.closed) throw new Error("Mock Voice Relay helper is closed.");
  }

  #assertArmed(targetId: string): void {
    this.#assertOpen();
    if (!this.#armed || targetId !== this.target.targetId) throw new Error("Mock Voice Relay target is not armed.");
  }
}
