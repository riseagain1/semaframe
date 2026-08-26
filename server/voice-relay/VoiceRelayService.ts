import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  VoiceRelayArmResult,
  VoiceRelayCancelResult,
  VoiceRelayConfirmResult,
  VoiceRelayDiagnosticCheck,
  VoiceRelayDiagnosticRequest,
  VoiceRelayDiagnosticReport,
  VoiceRelayReplySnapshot,
  VoiceRelaySetupPreparation,
  VoiceRelayStageReceipt,
  VoiceRelayStageRequest,
  VoiceRelayStatus,
  VoiceRelayTargetCandidate,
  VoiceRelayTargetSelection,
  VoiceRelayTargetSummary,
} from "../../src/voice-relay/contracts";
import {
  parseVoiceRelayIdentifier,
  parseVoiceRelayLabel,
  parseVoiceRelayReply,
  parseVoiceRelayStageTtl,
  parseVoiceRelayTranscript,
} from "../../src/voice-relay/contracts";
import type { VoiceRelayNativePort } from "./VoiceRelayNativePort";

type StageState =
  | "awaiting_confirmation"
  | "sending"
  | "sent"
  | "send_outcome_unknown"
  | "cancelled"
  | "draft_changed";

type StageRecord = {
  stageId: string;
  utteranceId: string;
  requestDigest: string;
  draftDigest: string;
  transcript?: string;
  targetId: string;
  targetLabel: string;
  /** Opaque helper generation binding this stage to one exact native profile. */
  targetGeneration: string;
  /** Undefined is reserved for the trusted local desktop surface. */
  ownerId?: string;
  expiresAtMs: number;
  state: StageState;
  observationId?: string;
  lastReplySequence: number;
};

type UtteranceTombstone = Readonly<{
  requestDigest: string;
  expiresAtMs: number;
}>;

// The headset polls replies for at most 120 seconds after Send. Draft expiry
// protects an unsent composer; once Send succeeds, reply records get their own
// complete observation window instead of inheriting the shorter draft TTL.
const REPLY_OBSERVATION_RETENTION_MS = 120_000;
const IDEMPOTENCY_TOMBSTONE_RETENTION_MS = 10 * 60_000;
const MAXIMUM_IDEMPOTENCY_TOMBSTONES = 512;

export type VoiceRelayServiceOptions = Readonly<{
  now?: () => number;
  stageIdFactory?: () => string;
  requestDigestKey?: Uint8Array;
}>;

export type VoiceRelayOwnerContext = Readonly<{
  /** Opaque authenticated XR renderer/session identity. */
  ownerId: string;
}>;

export class VoiceRelayServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "VoiceRelayServiceError";
  }
}

function serviceError(code: string, message: string, status = 400, recoverable = true): VoiceRelayServiceError {
  return new VoiceRelayServiceError(code, message, status, recoverable);
}

function checkedNow(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Voice Relay clock returned an invalid time.");
  return value;
}

function publicTarget(target: VoiceRelayTargetSummary): VoiceRelayTargetSummary {
  if (typeof target.capabilities?.draftInsertion !== "boolean"
    || typeof target.capabilities?.explicitSend !== "boolean"
    || typeof target.capabilities?.replyObservation !== "boolean") {
    throw serviceError("target_invalid", "Voice Relay helper returned invalid target capabilities.", 502, false);
  }
  return Object.freeze({
    targetId: parseVoiceRelayIdentifier(target.targetId, "targetId"),
    label: parseVoiceRelayLabel(target.label, "target label"),
    capabilities: Object.freeze({ ...target.capabilities }),
  });
}

/**
 * Volatile, single-composer Voice Relay coordinator.
 *
 * Transcript and reply text are never persisted or logged. A transcript lives
 * only until confirmation/cancellation/expiry; terminal records retain only
 * keyed digests needed for safe retry handling.
 */
export class VoiceRelayService {
  readonly #native: VoiceRelayNativePort;
  readonly #now: () => number;
  readonly #stageIdFactory: () => string;
  readonly #requestDigestKey: Uint8Array;
  readonly #stages = new Map<string, StageRecord>();
  readonly #stageIdByUtterance = new Map<string, string>();
  readonly #utteranceTombstones = new Map<string, UtteranceTombstone>();
  readonly #expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #enabled = false;
  #armed = false;
  #configuredTarget?: VoiceRelayTargetSummary;
  #nativeTargetGeneration?: string;
  #activeStageId?: string;
  #closed = false;
  #serial: Promise<void> = Promise.resolve();

  constructor(native: VoiceRelayNativePort, options: VoiceRelayServiceOptions = {}) {
    this.#native = native;
    this.#now = options.now ?? Date.now;
    this.#stageIdFactory = options.stageIdFactory ?? (() => `relay-stage-${randomUUID()}`);
    this.#requestDigestKey = options.requestDigestKey
      ? Uint8Array.from(options.requestDigestKey)
      : randomBytes(32);
    if (this.#requestDigestKey.byteLength < 32) {
      throw new RangeError("Voice Relay request digest key must contain at least 32 bytes.");
    }
  }

  inspect(owner?: VoiceRelayOwnerContext): VoiceRelayStatus {
    this.#sweepExpiredWithoutNative();
    const ownerId = this.#ownerId(owner);
    const globalActive = this.#activeStageId ? this.#stages.get(this.#activeStageId) : undefined;
    // The trusted desktop (no owner context) is the administrative surface and
    // may inspect/disarm all work. An XR caller sees only its own active stage.
    const active = globalActive && (ownerId === undefined || globalActive.ownerId === ownerId)
      ? globalActive
      : undefined;
    const phase = !this.#enabled
      ? "off"
      : !this.#configuredTarget
        ? "unconfigured"
        : !this.#armed
          ? "ready"
          : active?.state === "awaiting_confirmation"
            ? "awaiting_confirmation"
            : active?.state === "sending"
              ? "sending"
              : active?.state === "sent"
                ? "waiting_response"
                : active?.state === "send_outcome_unknown"
                  ? "send_outcome_unknown"
                  : "ready";
    return Object.freeze({
      enabled: this.#enabled,
      armed: this.#armed,
      phase,
      ...(this.#configuredTarget ? { target: this.#configuredTarget } : {}),
      ...(active && ["awaiting_confirmation", "sending", "sent", "send_outcome_unknown"].includes(active.state)
        ? {
          activeStage: Object.freeze({
            stageId: active.stageId,
            expiresAtMs: active.expiresAtMs,
            status: active.state as "awaiting_confirmation" | "sending" | "sent" | "send_outcome_unknown",
          }),
        }
        : {}),
    });
  }

  async prepareSetup(signal?: AbortSignal): Promise<VoiceRelaySetupPreparation> {
    return this.#exclusive(async () => {
      this.#assertOpen();
      // Passive preparation is safe for Agent inspection and must never cause
      // an operating-system consent prompt.
      return this.#setupPreparation(await this.#native.health(signal), signal);
    });
  }

  /**
   * Explicit desktop-user action boundary. On macOS this is the only Service
   * API that may ask the native helper to show the Accessibility prompt.
   */
  async requestAccessibility(signal?: AbortSignal): Promise<VoiceRelaySetupPreparation> {
    return this.#exclusive(async () => {
      this.#assertOpen();
      return this.#setupPreparation(await this.#native.prepareAccessibility(signal), signal);
    });
  }

  async discoverTargets(signal?: AbortSignal): Promise<readonly VoiceRelayTargetCandidate[]> {
    return this.#exclusive(async () => {
      this.#assertEnabled();
      const candidates = await this.#native.discoverTargets(signal);
      return Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate })));
    });
  }

  async configureTarget(selection: VoiceRelayTargetSelection, signal?: AbortSignal): Promise<VoiceRelayTargetSummary> {
    return this.#exclusive(async () => {
      this.#assertEnabled();
      if (this.#armed) throw serviceError("relay_armed", "Disarm Voice Relay before changing its target.", 409);
      const candidateId = parseVoiceRelayIdentifier(selection.candidateId, "candidateId");
      const nativeTarget = await this.#native.configureTarget(candidateId, signal);
      const target = publicTarget(nativeTarget);
      const targetGeneration = parseVoiceRelayIdentifier(nativeTarget.targetGeneration, "targetGeneration");
      if (!target.capabilities.draftInsertion || !target.capabilities.explicitSend) {
        throw serviceError(
          "target_incompatible",
          "The selected Agent window cannot safely stage and explicitly send a draft.",
          409,
        );
      }
      this.#configuredTarget = target;
      this.#nativeTargetGeneration = targetGeneration;
      return target;
    });
  }

  async runDiagnostics(
    request: VoiceRelayDiagnosticRequest = {},
    signal?: AbortSignal,
  ): Promise<VoiceRelayDiagnosticReport> {
    return this.#exclusive(async () => {
      this.#assertOpen();
      let helperStatus: "pass" | "fail" = "pass";
      let accessibility: "authorized" | "denied" | "not_determined" = "not_determined";
      try {
        accessibility = (await this.#native.health(signal)).accessibility;
      } catch {
        helperStatus = "fail";
      }
      const target = this.#configuredTarget;
      let draftProbe: "pass" | "fail" | "not_run" = "not_run";
      let draftProbeMessage = target?.capabilities.draftInsertion
        ? "Safe draft insertion is declared but has not been tested in this session."
        : "Safe draft insertion is unavailable.";
      if (request.performDraftRoundTrip && target && accessibility === "authorized") {
        const targetGeneration = this.#nativeTargetGeneration;
        if (!targetGeneration) {
          throw serviceError("target_generation_missing", "Voice Relay target generation is unavailable.", 503, false);
        }
        const probeText = `SemaFrame relay test ${randomBytes(12).toString("base64url")}`;
        const result = await this.#native.testDraftRoundTrip({
          targetId: target.targetId,
          probeId: `relay-probe-${randomUUID()}`,
          text: probeText,
          expectedDraftDigest: createHash("sha256").update(probeText, "utf8").digest("hex"),
          targetGeneration,
        }, signal);
        draftProbe = result.outcome === "passed" ? "pass" : "fail";
        draftProbeMessage = result.outcome === "passed"
          ? "A no-send nonce was inserted, read back exactly, and removed from the empty composer."
          : `The no-send draft test was blocked (${result.reason ?? "unknown"}).`;
      }
      const checks: VoiceRelayDiagnosticCheck[] = [
        Object.freeze({
          id: "helper",
          status: helperStatus,
          message: helperStatus === "pass" ? "Local Voice Relay helper is available." : "Local Voice Relay helper is unavailable.",
        }),
        Object.freeze({
          id: "accessibility",
          status: helperStatus === "fail" ? "not_run" : accessibility === "authorized" ? "pass" : "fail",
          message: accessibility === "authorized"
            ? "Accessibility permission is authorized."
            : "Accessibility permission must be authorized by the desktop user.",
        }),
        Object.freeze({
          id: "target",
          status: target ? "pass" : "not_run",
          message: target ? `Configured target: ${target.label}.` : "No Agent target has been configured.",
        }),
        Object.freeze({
          id: "draft_insertion",
          status: target ? draftProbe : "not_run",
          message: draftProbeMessage,
        }),
        Object.freeze({
          id: "explicit_send",
          status: !target
            ? "not_run"
            : !target.capabilities.explicitSend
              ? "fail"
              : draftProbe,
          message: !target?.capabilities.explicitSend
            ? "A locally bound explicit Send control is unavailable."
            : draftProbe === "pass"
              ? "The exact explicit Send identity and its local composer binding were revalidated without pressing Send."
              : draftProbe === "fail"
                ? "The exact explicit Send identity or its local composer binding could not be revalidated."
                : "The bound explicit Send identity was verified at configuration; run the safe no-send diagnostic to revalidate it.",
        }),
        Object.freeze({
          id: "reply_observation",
          status: target ? target.capabilities.replyObservation ? "pass" : "not_run" : "not_run",
          message: target?.capabilities.replyObservation
            ? "Bounded reply observation is available."
            : "Reply text-to-speech will remain unavailable for this target.",
        }),
      ];
      const required = new Set(["helper", "accessibility", "target", "draft_insertion", "explicit_send"]);
      return Object.freeze({
        ready: checks.every((check) => !required.has(check.id) || check.status === "pass"),
        checks: Object.freeze(checks),
      });
    });
  }

  async arm(targetIdValue?: string, signal?: AbortSignal): Promise<VoiceRelayArmResult> {
    return this.#exclusive(async () => {
      this.#assertEnabled();
      const target = this.#configuredTarget;
      if (!target) throw serviceError("target_unconfigured", "Configure an Agent target before arming Voice Relay.", 409);
      const targetId = targetIdValue === undefined
        ? target.targetId
        : parseVoiceRelayIdentifier(targetIdValue, "targetId");
      if (targetId !== target.targetId) {
        throw serviceError("target_mismatch", "Voice Relay can arm only the desktop-confirmed target.", 403, false);
      }
      await this.#native.arm(targetId, signal);
      this.#armed = true;
      return Object.freeze({ armed: true, status: this.inspect() });
    });
  }

  async disarm(signal?: AbortSignal): Promise<VoiceRelayArmResult> {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const active = this.#activeStageId ? this.#stages.get(this.#activeStageId) : undefined;
      if (active?.state === "awaiting_confirmation") await this.#releaseUnsentStage(active, signal);
      if (this.#closed) return Object.freeze({ armed: false, status: this.inspect() });
      try {
        await this.#native.disarm(signal);
      } catch {
        await this.#disableAfterUnresolvedNativeState();
        throw serviceError(
          "draft_cleanup_unresolved",
          "Voice Relay could not prove that its owned draft was removed while disarming; the native relay was closed.",
          503,
          false,
        );
      }
      this.#armed = false;
      this.#eraseAllStages();
      return Object.freeze({ armed: false, status: this.inspect() });
    });
  }

  async stage(
    request: VoiceRelayStageRequest,
    signal?: AbortSignal,
    owner?: VoiceRelayOwnerContext,
  ): Promise<VoiceRelayStageReceipt> {
    return this.#exclusive(async () => {
      this.#assertArmed();
      await this.#sweepExpired(signal);
      this.#assertArmed();
      const ownerId = this.#ownerId(owner);
      const utteranceId = parseVoiceRelayIdentifier(request.utteranceId, "utteranceId");
      const transcript = parseVoiceRelayTranscript(request.text);
      const ttlMs = parseVoiceRelayStageTtl(request.ttlMs);
      const requestDigest = this.#requestDigest(utteranceId, transcript);
      const utteranceKey = this.#utteranceKey(ownerId, utteranceId);
      const now = checkedNow(this.#now);
      this.#pruneTombstones(now);
      const tombstone = this.#utteranceTombstones.get(utteranceKey);
      if (tombstone) {
        if (tombstone.requestDigest !== requestDigest) {
          throw serviceError(
            "utterance_idempotency_conflict",
            "This utterance identifier was already used for different text.",
            409,
            false,
          );
        }
        throw serviceError("utterance_already_terminal", "This utterance has already been handled.", 409, false);
      }
      const priorId = this.#stageIdByUtterance.get(utteranceKey);
      const prior = priorId ? this.#stages.get(priorId) : undefined;
      if (prior) {
        if (prior.requestDigest !== requestDigest) {
          throw serviceError(
            "utterance_idempotency_conflict",
            "This utterance identifier was already used for different text.",
            409,
            false,
          );
        }
        if (prior.state === "awaiting_confirmation") return this.#receipt(prior);
        throw serviceError("utterance_already_terminal", "This utterance has already been handled.", 409, false);
      }
      const active = this.#activeStageId ? this.#stages.get(this.#activeStageId) : undefined;
      if (active && ["awaiting_confirmation", "sending", "sent", "send_outcome_unknown"].includes(active.state)) {
        throw serviceError("stage_already_active", "Complete or cancel the current Voice Relay request first.", 409);
      }
      const expiresAtMs = now + ttlMs;
      if (!Number.isSafeInteger(expiresAtMs)) throw new Error("Voice Relay stage expiry exceeded the safe integer range.");
      const stageId = parseVoiceRelayIdentifier(this.#stageIdFactory(), "stageId");
      if (this.#stages.has(stageId)) throw serviceError("stage_id_conflict", "Voice Relay stage identity collided.", 409);
      const target = this.#configuredTarget!;
      const targetGeneration = this.#nativeTargetGeneration;
      if (!targetGeneration) {
        this.#armed = false;
        throw serviceError("target_generation_missing", "Voice Relay target generation is unavailable.", 503, false);
      }
      const draftDigest = createHash("sha256").update(transcript, "utf8").digest("hex");
      const nativeStageInput = {
        targetId: target.targetId,
        stageId,
        text: transcript,
        expectedDraftDigest: draftDigest,
        targetGeneration,
      } as const;
      let staged: Awaited<ReturnType<VoiceRelayNativePort["stageDraft"]>>;
      try {
        staged = await this.#native.stageDraft(nativeStageInput, signal);
      } catch (cause) {
        const compensation = await this.#abortAmbiguousStage(nativeStageInput);
        if (compensation === "draft_changed") {
          throw serviceError(
            "draft_changed",
            "The Agent composer changed while an interrupted stage was being compensated; the human text was preserved and Voice Relay was disarmed.",
            409,
            false,
          );
        }
        if (compensation === "unresolved") {
          throw serviceError(
            "draft_staging_outcome_unknown",
            "Voice Relay could not prove that the interrupted draft was removed; the native relay was closed.",
            503,
            false,
          );
        }
        throw serviceError(
          "draft_staging_interrupted",
          cause instanceof Error && cause.name === "AbortError"
            ? "Voice Relay staging was aborted before acknowledgement; the exact draft was safely compensated."
            : "Voice Relay lost the staging acknowledgement; the exact draft was safely compensated.",
          409,
        );
      }
      if (staged.outcome !== "staged" || !staged.verified) {
        const compensation = await this.#abortAmbiguousStage(nativeStageInput);
        if (compensation === "unresolved") {
          throw serviceError("draft_staging_outcome_unknown", "Voice Relay could not prove that a rejected stage left no draft behind.", 503, false);
        }
        if (compensation === "draft_changed") {
          throw serviceError("draft_changed", "The Agent composer changed during stage rejection; the human text was preserved.", 409, false);
        }
        throw serviceError(
          staged.reason ?? "draft_staging_failed",
          "Voice Relay could not safely stage text in the configured Agent composer.",
          409,
        );
      }
      let returnedTargetGeneration: string;
      try {
        returnedTargetGeneration = parseVoiceRelayIdentifier(staged.targetGeneration, "targetGeneration");
        if (returnedTargetGeneration !== nativeStageInput.targetGeneration) throw new Error("target generation mismatch");
      } catch {
        const compensation = await this.#abortAmbiguousStage(nativeStageInput);
        if (compensation === "unresolved") {
          throw serviceError("draft_staging_outcome_unknown", "Voice Relay could not compensate an invalid target generation.", 503, false);
        }
        if (compensation === "draft_changed") {
          throw serviceError(
            "draft_changed",
            "The Agent composer changed while an invalid stage response was compensated; the human text was preserved.",
            409,
            false,
          );
        }
        // A malformed generation acknowledgement invalidates the configured
        // staging session even when the exact draft was removed successfully.
        try { await this.#native.disarm(); } catch { /* exact abort already proved no owned draft remains */ }
        this.#armed = false;
        throw serviceError(
          "target_generation_invalid",
          "Voice Relay helper did not bind the staged draft to a valid target generation.",
          502,
          false,
        );
      }
      const record: StageRecord = {
        stageId,
        utteranceId,
        requestDigest,
        draftDigest,
        transcript,
        targetId: target.targetId,
        targetLabel: target.label,
        targetGeneration: returnedTargetGeneration,
        ...(ownerId === undefined ? {} : { ownerId }),
        expiresAtMs,
        state: "awaiting_confirmation",
        lastReplySequence: 0,
      };
      this.#stages.set(stageId, record);
      this.#stageIdByUtterance.set(utteranceKey, stageId);
      this.#activeStageId = stageId;
      this.#scheduleExpiry(record, ttlMs);
      return this.#receipt(record);
    });
  }

  async confirm(
    stageIdValue: string,
    signal?: AbortSignal,
    owner?: VoiceRelayOwnerContext,
  ): Promise<VoiceRelayConfirmResult> {
    return this.#exclusive(async () => {
      this.#assertArmed();
      await this.#sweepExpired(signal);
      const record = this.#requireStage(stageIdValue, owner);
      if (record.state === "sent") {
        return Object.freeze({
          stageId: record.stageId,
          status: "sent",
          observationAvailable: record.observationId !== undefined,
        });
      }
      if (record.state === "send_outcome_unknown") {
        return Object.freeze({ stageId: record.stageId, status: "send_outcome_unknown", observationAvailable: false });
      }
      if (record.state !== "awaiting_confirmation") {
        throw serviceError("stage_not_confirmable", "Voice Relay stage cannot be confirmed.", 409, false);
      }
      record.state = "sending";
      try {
        const result = await this.#native.confirmDraft({
          targetId: record.targetId,
          stageId: record.stageId,
          expectedDraftDigest: record.draftDigest,
          targetGeneration: record.targetGeneration,
        }, signal);
        if (result.outcome !== "sent") {
          record.state = result.reason === "draft_changed" ? "draft_changed" : "cancelled";
          record.transcript = undefined;
          this.#activeStageId = undefined;
          throw serviceError(
            result.reason ?? "send_blocked",
            "The Agent composer changed or became unavailable before confirmation; nothing was sent.",
            409,
          );
        }
        record.state = "sent";
        record.observationId = result.observationId;
        record.transcript = undefined;
        if (result.observationId === undefined) {
          // A target without reply observation has no remaining serialized
          // work. Keep the terminal record only for bounded idempotency, but
          // let the next utterance stage immediately.
          if (this.#activeStageId === record.stageId) this.#activeStageId = undefined;
        } else {
          const now = checkedNow(this.#now);
          const expiresAtMs = now + REPLY_OBSERVATION_RETENTION_MS;
          if (!Number.isSafeInteger(expiresAtMs)) {
            throw new Error("Voice Relay reply observation expiry exceeded the safe integer range.");
          }
          record.expiresAtMs = expiresAtMs;
          this.#scheduleExpiry(record, REPLY_OBSERVATION_RETENTION_MS);
        }
        return Object.freeze({
          stageId: record.stageId,
          status: "sent",
          observationAvailable: result.observationId !== undefined,
        });
      } catch (cause) {
        if (cause instanceof VoiceRelayServiceError) throw cause;
        // Once confirm reaches the native boundary, transport failure is
        // intentionally never retried: the Send control may have fired.
        record.state = "send_outcome_unknown";
        record.transcript = undefined;
        return Object.freeze({ stageId: record.stageId, status: "send_outcome_unknown", observationAvailable: false });
      }
    });
  }

  async cancel(
    stageIdValue: string,
    signal?: AbortSignal,
    owner?: VoiceRelayOwnerContext,
  ): Promise<VoiceRelayCancelResult> {
    return this.#exclusive(async () => {
      this.#assertArmed();
      await this.#sweepExpired(signal);
      const record = this.#requireStage(stageIdValue, owner);
      if (record.state === "cancelled") {
        return Object.freeze({ stageId: record.stageId, status: "already_cancelled" });
      }
      if (record.state === "sent") {
        return Object.freeze({ stageId: record.stageId, status: "already_sent" });
      }
      if (record.state === "send_outcome_unknown" || record.state === "sending") {
        throw serviceError(
          "send_outcome_unknown",
          "Inspect the Agent window before taking another action; Send may already have fired.",
          409,
          false,
        );
      }
      if (record.state === "draft_changed") {
        return Object.freeze({ stageId: record.stageId, status: "draft_changed" });
      }
      const result = await this.#native.cancelDraft({
        targetId: record.targetId,
        stageId: record.stageId,
        expectedDraftDigest: record.draftDigest,
        targetGeneration: record.targetGeneration,
      }, signal);
      record.transcript = undefined;
      this.#activeStageId = undefined;
      if (result.outcome === "cancelled") {
        record.state = "cancelled";
        return Object.freeze({ stageId: record.stageId, status: "cancelled" });
      }
      record.state = "draft_changed";
      return Object.freeze({ stageId: record.stageId, status: "draft_changed" });
    });
  }

  async readReply(
    stageIdValue: string,
    afterSequenceValue = 0,
    signal?: AbortSignal,
    owner?: VoiceRelayOwnerContext,
  ): Promise<VoiceRelayReplySnapshot> {
    return this.#exclusive(async () => {
      this.#assertArmed();
      if (!Number.isSafeInteger(afterSequenceValue) || afterSequenceValue < 0) {
        throw serviceError("reply_sequence_invalid", "Voice Relay reply sequence must be a non-negative integer.");
      }
      await this.#sweepExpired(signal);
      const record = this.#requireStage(stageIdValue, owner);
      if (record.state === "send_outcome_unknown") {
        throw serviceError("send_outcome_unknown", "Reply observation is disabled because the Send outcome is unknown.", 409, false);
      }
      if (record.state !== "sent") {
        throw serviceError("reply_unavailable", "Voice Relay has not sent this stage.", 409);
      }
      if (!record.observationId) {
        if (this.#activeStageId === record.stageId) this.#activeStageId = undefined;
        return Object.freeze({ stageId: record.stageId, phase: "unavailable", sequence: afterSequenceValue });
      }
      const reply = await this.#native.readReply({
        targetId: record.targetId,
        observationId: record.observationId,
        afterSequence: afterSequenceValue,
      }, signal);
      if (!Number.isSafeInteger(reply.sequence)
        || reply.sequence < afterSequenceValue
        || reply.sequence < record.lastReplySequence) {
        throw serviceError("reply_sequence_invalid", "Voice Relay helper returned a stale reply sequence.", 502, false);
      }
      record.lastReplySequence = Math.max(record.lastReplySequence, reply.sequence);
      const text = reply.text === undefined ? undefined : parseVoiceRelayReply(reply.text);
      const snapshot = Object.freeze({
        stageId: record.stageId,
        phase: reply.phase,
        sequence: reply.sequence,
        ...(text === undefined ? {} : { text }),
      });
      if (reply.phase === "complete" || reply.phase === "unavailable") {
        if (this.#activeStageId === record.stageId) this.#activeStageId = undefined;
      }
      return snapshot;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#exclusive(async () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#eraseAllStages();
      this.#armed = false;
      this.#enabled = false;
      this.#configuredTarget = undefined;
      this.#nativeTargetGeneration = undefined;
      this.#clearExpiryTimers();
      await this.#native.close();
    });
  }

  /** Cancels and erases unsent state owned by one removed XR session only. */
  async cancelOwner(ownerIdValue: string, signal?: AbortSignal): Promise<number> {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const ownerId = parseVoiceRelayIdentifier(ownerIdValue, "Voice Relay ownerId");
      const owned = [...this.#stages.values()].filter((record) => record.ownerId === ownerId);
      for (const record of owned) {
        if (record.state === "awaiting_confirmation") await this.#releaseUnsentStage(record, signal);
        record.transcript = undefined;
        this.#rememberTombstone(record);
        this.#clearExpiryTimer(record.stageId);
        this.#stages.delete(record.stageId);
        this.#stageIdByUtterance.delete(this.#utteranceKey(record.ownerId, record.utteranceId));
        if (this.#activeStageId === record.stageId) this.#activeStageId = undefined;
      }
      return owned.length;
    });
  }

  #receipt(record: StageRecord): VoiceRelayStageReceipt {
    return Object.freeze({
      stageId: record.stageId,
      target: Object.freeze({
        targetId: record.targetId,
        label: record.targetLabel,
        capabilities: this.#configuredTarget!.capabilities,
      }),
      expiresAtMs: record.expiresAtMs,
      status: "awaiting_confirmation",
    });
  }

  async #abortAmbiguousStage(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>): Promise<"cancelled" | "not_found" | "draft_changed" | "unresolved"> {
    try {
      const result = await this.#native.abortStage({
        targetId: input.targetId,
        stageId: input.stageId,
        expectedDraftDigest: input.expectedDraftDigest,
        targetGeneration: input.targetGeneration,
      });
      if (result.outcome === "cancelled" || result.outcome === "not_found") return result.outcome;
      if (result.outcome === "draft_changed") {
        try { await this.#native.disarm(); } catch { /* the exact abort already released native stage ownership */ }
        this.#armed = false;
        return "draft_changed";
      }
    } catch {
      // Close below: no subsequent request may act on an unproven native stage.
    }
    await this.#disableAfterUnresolvedNativeState();
    return "unresolved";
  }

  async #releaseUnsentStage(record: StageRecord, signal?: AbortSignal): Promise<void> {
    try {
      const result = await this.#native.cancelDraft({
        targetId: record.targetId,
        stageId: record.stageId,
        expectedDraftDigest: record.draftDigest,
        targetGeneration: record.targetGeneration,
      }, signal);
      if (result.outcome === "cancelled") {
        record.transcript = undefined;
        record.state = "cancelled";
        return;
      }
      // A changed/lost target is never erased blindly. Disarm releases the
      // helper's stage ownership and its digest-checked cleanup preserves any
      // human replacement text.
      await this.#native.disarm();
      this.#armed = false;
      record.transcript = undefined;
      record.state = result.outcome === "draft_changed" ? "draft_changed" : "cancelled";
      return;
    } catch {
      // A dropped cancellation acknowledgement is ambiguous just like a
      // dropped stage acknowledgement. Make the helper unavailable; its EOF
      // cleanup is digest-checked and no later request can press Send.
      await this.#disableAfterUnresolvedNativeState();
    }
  }

  async #disableAfterUnresolvedNativeState(): Promise<void> {
    try { await this.#native.close(); } catch { /* the relay is disabled below even if teardown reports failure */ }
    this.#armed = false;
    this.#enabled = false;
    this.#configuredTarget = undefined;
    this.#nativeTargetGeneration = undefined;
    this.#closed = true;
    this.#eraseAllStages();
  }

  async #setupPreparation(
    health: Awaited<ReturnType<VoiceRelayNativePort["health"]>>,
    signal?: AbortSignal,
  ): Promise<VoiceRelaySetupPreparation> {
    this.#enabled = true;
    const candidates = health.accessibility === "authorized"
      ? await this.#native.discoverTargets(signal)
      : [];
    return Object.freeze({
      phase: health.accessibility !== "authorized"
        ? "permission_required"
        : this.#configuredTarget
          ? "ready"
          : "candidate_selection_required",
      platform: health.platform,
      accessibility: health.accessibility,
      candidates: Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate }))),
      ...(this.#configuredTarget ? { configuredTarget: this.#configuredTarget } : {}),
    });
  }

  #requireStage(stageIdValue: string, owner?: VoiceRelayOwnerContext): StageRecord {
    const stageId = parseVoiceRelayIdentifier(stageIdValue, "stageId");
    const record = this.#stages.get(stageId);
    const ownerId = this.#ownerId(owner);
    if (!record || (ownerId !== undefined && record.ownerId !== ownerId)) {
      // Deliberately identical for absent and foreign stages: authenticated XR
      // sessions cannot enumerate another session's stage identifiers.
      throw serviceError("stage_not_found", "Voice Relay stage is unavailable or expired.", 404);
    }
    if (record.targetId !== this.#configuredTarget?.targetId) {
      throw serviceError("target_mismatch", "Voice Relay stage does not belong to the armed target.", 403, false);
    }
    return record;
  }

  #requestDigest(utteranceId: string, transcript: string): string {
    return createHmac("sha256", this.#requestDigestKey)
      .update(utteranceId, "utf8")
      .update("\0", "utf8")
      .update(transcript, "utf8")
      .digest("hex");
  }

  #ownerId(owner?: VoiceRelayOwnerContext): string | undefined {
    return owner === undefined ? undefined : parseVoiceRelayIdentifier(owner.ownerId, "Voice Relay ownerId");
  }

  #utteranceKey(ownerId: string | undefined, utteranceId: string): string {
    return `${ownerId ?? "trusted-desktop"}\0${utteranceId}`;
  }

  async #sweepExpired(signal?: AbortSignal): Promise<void> {
    const now = checkedNow(this.#now);
    this.#pruneTombstones(now);
    for (const record of this.#stages.values()) {
      if (record.expiresAtMs > now) continue;
      if (record.state === "awaiting_confirmation") await this.#releaseUnsentStage(record, signal);
      record.transcript = undefined;
      this.#rememberTombstone(record, now);
      this.#clearExpiryTimer(record.stageId);
      this.#stages.delete(record.stageId);
      this.#stageIdByUtterance.delete(this.#utteranceKey(record.ownerId, record.utteranceId));
      if (this.#activeStageId === record.stageId) this.#activeStageId = undefined;
    }
  }

  #sweepExpiredWithoutNative(): void {
    const now = checkedNow(this.#now);
    this.#pruneTombstones(now);
    for (const record of this.#stages.values()) {
      if (record.expiresAtMs > now || record.state === "awaiting_confirmation") continue;
      record.transcript = undefined;
      this.#rememberTombstone(record, now);
      this.#clearExpiryTimer(record.stageId);
      this.#stages.delete(record.stageId);
      this.#stageIdByUtterance.delete(this.#utteranceKey(record.ownerId, record.utteranceId));
      if (this.#activeStageId === record.stageId) this.#activeStageId = undefined;
    }
  }

  #eraseAllStages(): void {
    for (const stage of this.#stages.values()) {
      stage.transcript = undefined;
      this.#rememberTombstone(stage);
    }
    this.#clearExpiryTimers();
    this.#stages.clear();
    this.#stageIdByUtterance.clear();
    this.#activeStageId = undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw serviceError("relay_closed", "Voice Relay is closed.", 503, false);
  }

  #scheduleExpiry(record: StageRecord, delayMs: number): void {
    this.#clearExpiryTimer(record.stageId);
    const timer = setTimeout(() => {
      void this.#exclusive(async () => {
        const current = this.#stages.get(record.stageId);
        if (!current || this.#closed) return;
        const remaining = current.expiresAtMs - checkedNow(this.#now);
        if (remaining > 0) {
          this.#scheduleExpiry(current, remaining);
          return;
        }
        if (current.state === "awaiting_confirmation") await this.#releaseUnsentStage(current);
        current.transcript = undefined;
        this.#rememberTombstone(current);
        this.#stages.delete(current.stageId);
        this.#stageIdByUtterance.delete(this.#utteranceKey(current.ownerId, current.utteranceId));
        this.#clearExpiryTimer(current.stageId);
        if (this.#activeStageId === current.stageId) this.#activeStageId = undefined;
      });
    }, Math.max(1, delayMs));
    timer.unref?.();
    this.#expiryTimers.set(record.stageId, timer);
  }

  #clearExpiryTimer(stageId: string): void {
    const timer = this.#expiryTimers.get(stageId);
    if (timer) clearTimeout(timer);
    this.#expiryTimers.delete(stageId);
  }

  #clearExpiryTimers(): void {
    for (const timer of this.#expiryTimers.values()) clearTimeout(timer);
    this.#expiryTimers.clear();
  }

  #rememberTombstone(record: StageRecord, now?: number): void {
    let timestamp = now;
    if (timestamp === undefined) {
      try { timestamp = checkedNow(this.#now); } catch { return; }
    }
    const key = this.#utteranceKey(record.ownerId, record.utteranceId);
    const expiresAtMs = timestamp + IDEMPOTENCY_TOMBSTONE_RETENTION_MS;
    if (!Number.isSafeInteger(expiresAtMs)) return;
    this.#utteranceTombstones.delete(key);
    this.#utteranceTombstones.set(key, Object.freeze({
      requestDigest: record.requestDigest,
      expiresAtMs,
    }));
    this.#pruneTombstones(timestamp);
    while (this.#utteranceTombstones.size > MAXIMUM_IDEMPOTENCY_TOMBSTONES) {
      const oldest = this.#utteranceTombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#utteranceTombstones.delete(oldest);
    }
  }

  #pruneTombstones(now: number): void {
    for (const [key, tombstone] of this.#utteranceTombstones) {
      if (tombstone.expiresAtMs <= now) this.#utteranceTombstones.delete(key);
    }
  }

  #assertEnabled(): void {
    this.#assertOpen();
    if (!this.#enabled) throw serviceError("relay_disabled", "Enable Voice Relay before using it.", 409);
  }

  #assertArmed(): void {
    this.#assertEnabled();
    if (!this.#armed || !this.#configuredTarget) {
      throw serviceError("relay_not_armed", "Voice Relay is not armed for a confirmed Agent target.", 409);
    }
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(work, work);
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }
}
