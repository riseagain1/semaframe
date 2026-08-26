export const VOICE_RELAY_LIMITS = Object.freeze({
  maximumTranscriptCharacters: 4_000,
  maximumReplyCharacters: 20_000,
  minimumStageTtlMs: 5_000,
  maximumStageTtlMs: 60_000,
  defaultStageTtlMs: 60_000,
  maximumIdentifierCharacters: 160,
  maximumLabelCharacters: 160,
});

export type VoiceRelayPhase =
  | "off"
  | "unconfigured"
  | "ready"
  | "listening"
  | "transcribing"
  | "staging"
  | "awaiting_confirmation"
  | "sending"
  | "waiting_response"
  | "reply_ready"
  | "speaking"
  | "send_outcome_unknown"
  | "error";

export type VoiceRelayTargetCapabilities = Readonly<{
  draftInsertion: boolean;
  explicitSend: boolean;
  replyObservation: boolean;
}>;

/** Safe to show in XR. Native application/window locators never cross this boundary. */
export type VoiceRelayTargetSummary = Readonly<{
  targetId: string;
  label: string;
  capabilities: VoiceRelayTargetCapabilities;
}>;

export type VoiceRelayErrorDetails = Readonly<{
  code: string;
  message: string;
  recoverable: boolean;
}>;

export type VoiceRelayStatus = Readonly<{
  enabled: boolean;
  armed: boolean;
  phase: VoiceRelayPhase;
  target?: VoiceRelayTargetSummary;
  activeStage?: Readonly<{
    stageId: string;
    expiresAtMs: number;
    status: "awaiting_confirmation" | "sending" | "sent" | "send_outcome_unknown";
  }>;
  error?: VoiceRelayErrorDetails;
}>;

/** Sanitized setup discovery result. candidateId is meaningful only to the local helper. */
export type VoiceRelayTargetCandidate = Readonly<{
  candidateId: string;
  label: string;
  applicationLabel: string;
  compatible: boolean;
  incompatibilityReason?: string;
}>;

export type VoiceRelayTargetSelection = Readonly<{
  candidateId: string;
}>;

export type VoiceRelaySetupPreparation = Readonly<{
  phase: "permission_required" | "candidate_selection_required" | "ready";
  platform: "macos" | "windows" | "mock";
  accessibility: "authorized" | "denied" | "not_determined";
  candidates: readonly VoiceRelayTargetCandidate[];
  configuredTarget?: VoiceRelayTargetSummary;
}>;

export type VoiceRelayDiagnosticCheck = Readonly<{
  id: "helper" | "accessibility" | "target" | "draft_insertion" | "explicit_send" | "reply_observation";
  status: "pass" | "fail" | "not_run";
  message: string;
}>;

export type VoiceRelayDiagnosticReport = Readonly<{
  ready: boolean;
  checks: readonly VoiceRelayDiagnosticCheck[];
}>;

export type VoiceRelayDiagnosticRequest = Readonly<{
  /** Requires a separately confirmed desktop HostAction. Never invoke from XR. */
  performDraftRoundTrip?: boolean;
}>;

export type VoiceRelayArmResult = Readonly<{
  armed: boolean;
  status: VoiceRelayStatus;
}>;

export type VoiceRelayStageRequest = Readonly<{
  utteranceId: string;
  text: string;
  ttlMs?: number;
}>;

export type VoiceRelayStageReceipt = Readonly<{
  stageId: string;
  target: VoiceRelayTargetSummary;
  expiresAtMs: number;
  status: "awaiting_confirmation";
}>;

export type VoiceRelayConfirmResult = Readonly<{
  stageId: string;
  status: "sent" | "send_outcome_unknown";
  observationAvailable: boolean;
}>;

export type VoiceRelayCancelResult = Readonly<{
  stageId: string;
  status: "cancelled" | "draft_changed" | "already_sent" | "already_cancelled";
}>;

export type VoiceRelayReplySnapshot = Readonly<{
  stageId: string;
  phase: "waiting" | "streaming" | "complete" | "unavailable";
  sequence: number;
  text?: string;
}>;

/** Runtime-facing surface. It deliberately excludes target discovery/configuration. */
export interface VoiceRelayRuntimePort {
  inspect(): VoiceRelayStatus | Promise<VoiceRelayStatus>;
  stage(request: VoiceRelayStageRequest): Promise<VoiceRelayStageReceipt>;
  confirm(stageId: string): Promise<VoiceRelayConfirmResult>;
  cancel(stageId: string): Promise<VoiceRelayCancelResult>;
  readReply(stageId: string, afterSequence?: number): Promise<VoiceRelayReplySnapshot>;
}

export class VoiceRelayContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VoiceRelayContractError";
  }
}

const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export function parseVoiceRelayIdentifier(value: unknown, label = "identifier"): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > VOICE_RELAY_LIMITS.maximumIdentifierCharacters
    || !IDENTIFIER_PATTERN.test(value)) {
    throw new VoiceRelayContractError("invalid_identifier", `${label} is invalid.`);
  }
  return value;
}

export function parseVoiceRelayLabel(value: unknown, label = "label"): string {
  if (typeof value !== "string") {
    throw new VoiceRelayContractError("invalid_label", `${label} is invalid.`);
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized
    || normalized.length > VOICE_RELAY_LIMITS.maximumLabelCharacters
    || FORBIDDEN_CONTROL_CHARACTERS.test(normalized)) {
    throw new VoiceRelayContractError("invalid_label", `${label} is invalid.`);
  }
  return normalized;
}

export function parseVoiceRelayTranscript(value: unknown): string {
  if (typeof value !== "string") {
    throw new VoiceRelayContractError("invalid_transcript", "Voice Relay transcript must be text.");
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized
    || normalized.length > VOICE_RELAY_LIMITS.maximumTranscriptCharacters
    || FORBIDDEN_CONTROL_CHARACTERS.test(normalized)) {
    throw new VoiceRelayContractError(
      "invalid_transcript",
      `Voice Relay transcript must contain 1-${VOICE_RELAY_LIMITS.maximumTranscriptCharacters} safe characters.`,
    );
  }
  return normalized;
}

export function parseVoiceRelayReply(value: unknown): string {
  if (typeof value !== "string") {
    throw new VoiceRelayContractError("invalid_reply", "Voice Relay reply must be text.");
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > VOICE_RELAY_LIMITS.maximumReplyCharacters
    || FORBIDDEN_CONTROL_CHARACTERS.test(normalized)) {
    throw new VoiceRelayContractError(
      "invalid_reply",
      `Voice Relay reply exceeds ${VOICE_RELAY_LIMITS.maximumReplyCharacters} safe characters.`,
    );
  }
  return normalized;
}

export function parseVoiceRelayStageTtl(value: unknown): number {
  const ttl = value === undefined ? VOICE_RELAY_LIMITS.defaultStageTtlMs : value;
  if (typeof ttl !== "number"
    || !Number.isSafeInteger(ttl)
    || ttl < VOICE_RELAY_LIMITS.minimumStageTtlMs
    || ttl > VOICE_RELAY_LIMITS.maximumStageTtlMs) {
    throw new VoiceRelayContractError(
      "invalid_stage_ttl",
      `Voice Relay stage ttlMs must be an integer between ${VOICE_RELAY_LIMITS.minimumStageTtlMs} and ${VOICE_RELAY_LIMITS.maximumStageTtlMs}.`,
    );
  }
  return ttl;
}
