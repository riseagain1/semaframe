import {
  parseVoiceRelayIdentifier,
  parseVoiceRelayLabel,
  parseVoiceRelayReply,
  type VoiceRelayArmResult,
  type VoiceRelayCancelResult,
  type VoiceRelayConfirmResult,
  type VoiceRelayDiagnosticCheck,
  type VoiceRelayDiagnosticRequest,
  type VoiceRelayDiagnosticReport,
  type VoiceRelayReplySnapshot,
  type VoiceRelayRuntimePort,
  type VoiceRelaySetupPreparation,
  type VoiceRelayStageReceipt,
  type VoiceRelayStageRequest,
  type VoiceRelayStatus,
  type VoiceRelayTargetCandidate,
  type VoiceRelayTargetSelection,
  type VoiceRelayTargetSummary,
} from "./contracts";
import { VOICE_RELAY_HTTP_PATHS, voiceRelayStageActionPath } from "./httpPaths";

const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

function canonicalVoiceRelayBaseUrl(value: string | undefined): string {
  const candidate = (value ?? VOICE_RELAY_HTTP_PATHS.xrBase).replace(/\/$/u, "");
  if (candidate === VOICE_RELAY_HTTP_PATHS.desktopBase
    || candidate === VOICE_RELAY_HTTP_PATHS.xrBase) {
    return candidate;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError(
      "Voice Relay HTTP base URL must be a same-origin relay path or a canonical XR gateway URL.",
    );
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== VOICE_RELAY_HTTP_PATHS.xrBase
    || url.search !== ""
    || url.hash !== "") {
    throw new TypeError(
      "Voice Relay HTTP base URL must be a same-origin relay path or a canonical XR gateway URL.",
    );
  }
  return `${url.origin}${VOICE_RELAY_HTTP_PATHS.xrBase}`;
}

export type VoiceRelayHttpClientOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestHeaders?: () => HeadersInit | Promise<HeadersInit>;
}>;

export class VoiceRelayHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "VoiceRelayHttpError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VoiceRelayHttpError("invalid_response", `${label} is invalid.`, 502, false);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new VoiceRelayHttpError("invalid_response", `${label} is invalid.`, 502, false);
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new VoiceRelayHttpError("invalid_response", `${label} is invalid.`, 502, false);
  }
  return value;
}

function target(value: unknown): VoiceRelayTargetSummary {
  const body = object(value, "Voice Relay target");
  const capabilities = object(body.capabilities, "Voice Relay target capabilities");
  return Object.freeze({
    targetId: parseVoiceRelayIdentifier(body.targetId, "targetId"),
    label: parseVoiceRelayLabel(body.label, "target label"),
    capabilities: Object.freeze({
      draftInsertion: boolean(capabilities.draftInsertion, "draftInsertion"),
      explicitSend: boolean(capabilities.explicitSend, "explicitSend"),
      replyObservation: boolean(capabilities.replyObservation, "replyObservation"),
    }),
  });
}

function status(value: unknown): VoiceRelayStatus {
  const body = object(value, "Voice Relay status");
  const phases = new Set([
    "off", "unconfigured", "ready", "listening", "transcribing", "staging",
    "awaiting_confirmation", "sending", "waiting_response", "reply_ready",
    "speaking", "send_outcome_unknown", "error",
  ]);
  if (typeof body.phase !== "string" || !phases.has(body.phase)) {
    throw new VoiceRelayHttpError("invalid_response", "Voice Relay status phase is invalid.", 502, false);
  }
  const parsed: VoiceRelayStatus = {
    enabled: boolean(body.enabled, "enabled"),
    armed: boolean(body.armed, "armed"),
    phase: body.phase as VoiceRelayStatus["phase"],
    ...(body.target === undefined ? {} : { target: target(body.target) }),
  };
  if (body.activeStage !== undefined) {
    const active = object(body.activeStage, "Voice Relay active stage");
    const stageStatuses = new Set(["awaiting_confirmation", "sending", "sent", "send_outcome_unknown"]);
    if (typeof active.status !== "string" || !stageStatuses.has(active.status)) {
      throw new VoiceRelayHttpError("invalid_response", "Voice Relay active stage status is invalid.", 502, false);
    }
    (parsed as { activeStage?: VoiceRelayStatus["activeStage"] }).activeStage = Object.freeze({
      stageId: parseVoiceRelayIdentifier(active.stageId, "stageId"),
      expiresAtMs: safeInteger(active.expiresAtMs, "expiresAtMs"),
      status: active.status as NonNullable<VoiceRelayStatus["activeStage"]>["status"],
    });
  }
  if (body.error !== undefined) {
    const relayError = object(body.error, "Voice Relay status error");
    (parsed as { error?: VoiceRelayStatus["error"] }).error = Object.freeze({
      code: parseVoiceRelayIdentifier(relayError.code, "error code"),
      message: parseVoiceRelayLabel(relayError.message, "error message"),
      recoverable: boolean(relayError.recoverable, "error recoverability"),
    });
  }
  return Object.freeze(parsed);
}

function candidate(value: unknown): VoiceRelayTargetCandidate {
  const body = object(value, "Voice Relay candidate");
  const compatible = boolean(body.compatible, "candidate compatibility");
  return Object.freeze({
    candidateId: parseVoiceRelayIdentifier(body.candidateId, "candidateId"),
    label: parseVoiceRelayLabel(body.label, "candidate label"),
    applicationLabel: parseVoiceRelayLabel(body.applicationLabel, "application label"),
    compatible,
    ...(body.incompatibilityReason === undefined
      ? {}
      : { incompatibilityReason: parseVoiceRelayLabel(body.incompatibilityReason, "incompatibility reason") }),
  });
}

function setupPreparation(value: unknown): VoiceRelaySetupPreparation {
  const body = object(value, "Voice Relay setup preparation");
  if (!Array.isArray(body.candidates) || body.candidates.length > 128
    || !["permission_required", "candidate_selection_required", "ready"].includes(String(body.phase))
    || !["macos", "windows", "mock"].includes(String(body.platform))
    || !["authorized", "denied", "not_determined"].includes(String(body.accessibility))) {
    throw new VoiceRelayHttpError("invalid_response", "Voice Relay setup response is invalid.", 502, false);
  }
  return Object.freeze({
    phase: body.phase as VoiceRelaySetupPreparation["phase"],
    platform: body.platform as VoiceRelaySetupPreparation["platform"],
    accessibility: body.accessibility as VoiceRelaySetupPreparation["accessibility"],
    candidates: Object.freeze(body.candidates.map(candidate)),
    ...(body.configuredTarget === undefined ? {} : { configuredTarget: target(body.configuredTarget) }),
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAXIMUM_RESPONSE_BYTES) {
    throw new VoiceRelayHttpError("response_too_large", "Voice Relay response exceeded its size limit.", 502, false);
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new VoiceRelayHttpError("response_too_large", "Voice Relay response exceeded its size limit.", 502, false);
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged)) as unknown;
  } catch {
    throw new VoiceRelayHttpError("invalid_response", "Voice Relay returned malformed JSON.", 502, false);
  }
}

/** Setup methods must only be wired to the trusted desktop surface. */
export class VoiceRelayHttpClient implements VoiceRelayRuntimePort {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  readonly #replySequences = new Map<string, number>();

  constructor(options: VoiceRelayHttpClientOptions = {}) {
    this.#baseUrl = canonicalVoiceRelayBaseUrl(options.baseUrl);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#requestHeaders = options.requestHeaders;
  }

  async inspect(): Promise<VoiceRelayStatus> {
    return status(await this.#request("POST", `${this.#baseUrl}${VOICE_RELAY_HTTP_PATHS.status}`, {}));
  }

  async prepareSetup(): Promise<VoiceRelaySetupPreparation> {
    return setupPreparation(await this.#request(
      "POST",
      `${this.#baseUrl}${VOICE_RELAY_HTTP_PATHS.prepareSetup}`,
      {},
    ));
  }

  /** Opens the OS Accessibility flow only when accompanied by a one-shot desktop HostAction. */
  async requestAccessibility(): Promise<VoiceRelaySetupPreparation> {
    return setupPreparation(await this.#request(
      "POST",
      `${this.#baseUrl}${VOICE_RELAY_HTTP_PATHS.requestAccessibility}`,
      {},
    ));
  }

  async runDiagnostics(request: VoiceRelayDiagnosticRequest = {}): Promise<VoiceRelayDiagnosticReport> {
    const body = object(
      await this.#request("POST", `${this.#baseUrl}${VOICE_RELAY_HTTP_PATHS.diagnostics}`, request),
      "Voice Relay diagnostics",
    );
    if (!Array.isArray(body.checks) || body.checks.length > 16) {
      throw new VoiceRelayHttpError("invalid_response", "Voice Relay diagnostic checks are invalid.", 502, false);
    }
    const checks = body.checks.map((value): VoiceRelayDiagnosticCheck => {
      const check = object(value, "Voice Relay diagnostic check");
      if (!["helper", "accessibility", "target", "draft_insertion", "explicit_send", "reply_observation"]
        .includes(String(check.id))
        || !["pass", "fail", "not_run"].includes(String(check.status))) {
        throw new VoiceRelayHttpError("invalid_response", "Voice Relay diagnostic check is invalid.", 502, false);
      }
      return Object.freeze({
        id: check.id as VoiceRelayDiagnosticCheck["id"],
        status: check.status as VoiceRelayDiagnosticCheck["status"],
        message: parseVoiceRelayLabel(check.message, "diagnostic message"),
      });
    });
    return Object.freeze({ ready: boolean(body.ready, "diagnostic readiness"), checks: Object.freeze(checks) });
  }

  async configureTarget(selection: VoiceRelayTargetSelection): Promise<VoiceRelayTargetSummary> {
    return target(await this.#request(
      "POST",
      `${this.#baseUrl}${VOICE_RELAY_HTTP_PATHS.configureTarget}`,
      { candidateId: parseVoiceRelayIdentifier(selection.candidateId, "candidateId") },
    ));
  }

  async requestArm(targetId?: string): Promise<VoiceRelayArmResult> {
    const body = object(
      await this.#request("POST", `${this.#baseUrl}${VOICE_RELAY_HTTP_PATHS.arm}`, targetId ? { targetId } : {}),
      "Voice Relay arm response",
    );
    return Object.freeze({ armed: boolean(body.armed, "armed"), status: status(body.status) });
  }

  async disarm(): Promise<VoiceRelayArmResult> {
    const body = object(
      await this.#request("POST", `${this.#baseUrl}${VOICE_RELAY_HTTP_PATHS.disarm}`, {}),
      "Voice Relay disarm response",
    );
    return Object.freeze({ armed: boolean(body.armed, "armed"), status: status(body.status) });
  }

  async stage(request: VoiceRelayStageRequest): Promise<VoiceRelayStageReceipt> {
    const body = object(
      await this.#request("POST", `${this.#baseUrl}${VOICE_RELAY_HTTP_PATHS.stages}`, request),
      "Voice Relay stage response",
    );
    if (body.status !== "awaiting_confirmation") {
      throw new VoiceRelayHttpError("invalid_response", "Voice Relay stage status is invalid.", 502, false);
    }
    const receipt = Object.freeze({
      stageId: parseVoiceRelayIdentifier(body.stageId, "stageId"),
      target: target(body.target),
      expiresAtMs: safeInteger(body.expiresAtMs, "expiresAtMs"),
      status: "awaiting_confirmation",
    } satisfies VoiceRelayStageReceipt);
    this.#replySequences.delete(receipt.stageId);
    return receipt;
  }

  async confirm(stageIdValue: string): Promise<VoiceRelayConfirmResult> {
    const stageId = parseVoiceRelayIdentifier(stageIdValue, "stageId");
    const body = object(
      await this.#request("POST", voiceRelayStageActionPath(this.#baseUrl, stageId, "confirm"), {}),
      "Voice Relay confirm response",
    );
    if (!["sent", "send_outcome_unknown"].includes(String(body.status))) {
      throw new VoiceRelayHttpError("invalid_response", "Voice Relay confirm status is invalid.", 502, false);
    }
    return Object.freeze({
      stageId: parseVoiceRelayIdentifier(body.stageId, "stageId"),
      status: body.status as VoiceRelayConfirmResult["status"],
      observationAvailable: boolean(body.observationAvailable, "observationAvailable"),
    });
  }

  async cancel(stageIdValue: string): Promise<VoiceRelayCancelResult> {
    const stageId = parseVoiceRelayIdentifier(stageIdValue, "stageId");
    const body = object(
      await this.#request("POST", voiceRelayStageActionPath(this.#baseUrl, stageId, "cancel"), {}),
      "Voice Relay cancel response",
    );
    if (!["cancelled", "draft_changed", "already_sent", "already_cancelled"].includes(String(body.status))) {
      throw new VoiceRelayHttpError("invalid_response", "Voice Relay cancel status is invalid.", 502, false);
    }
    const result = Object.freeze({
      stageId: parseVoiceRelayIdentifier(body.stageId, "stageId"),
      status: body.status as VoiceRelayCancelResult["status"],
    });
    this.#replySequences.delete(stageId);
    return result;
  }

  async readReply(stageIdValue: string, afterSequenceValue?: number): Promise<VoiceRelayReplySnapshot> {
    const stageId = parseVoiceRelayIdentifier(stageIdValue, "stageId");
    const afterSequence = afterSequenceValue ?? this.#replySequences.get(stageId) ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new VoiceRelayHttpError("invalid_reply_sequence", "Reply sequence must be non-negative.", 400, true);
    }
    const body = object(
      await this.#request(
        "POST",
        voiceRelayStageActionPath(this.#baseUrl, stageId, "reply"),
        { afterSequence },
      ),
      "Voice Relay reply response",
    );
    if (!["waiting", "streaming", "complete", "unavailable"].includes(String(body.phase))) {
      throw new VoiceRelayHttpError("invalid_response", "Voice Relay reply phase is invalid.", 502, false);
    }
    const text = body.text === undefined ? undefined : parseVoiceRelayReply(body.text);
    const snapshot = Object.freeze({
      stageId: parseVoiceRelayIdentifier(body.stageId, "stageId"),
      phase: body.phase as VoiceRelayReplySnapshot["phase"],
      sequence: safeInteger(body.sequence, "reply sequence"),
      ...(text === undefined ? {} : { text }),
    });
    if (snapshot.sequence < afterSequence) {
      throw new VoiceRelayHttpError("invalid_response", "Voice Relay returned a stale reply sequence.", 502, false);
    }
    if (snapshot.phase === "complete" || snapshot.phase === "unavailable") {
      this.#replySequences.delete(stageId);
    } else {
      this.#replySequences.set(stageId, snapshot.sequence);
    }
    return snapshot;
  }

  async #request(method: "GET" | "POST", url: string, body?: unknown): Promise<unknown> {
    const customHeaders = this.#requestHeaders ? await this.#requestHeaders() : undefined;
    const headers = new Headers(customHeaders);
    headers.set("accept", "application/json");
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const payload = await boundedJson(response);
    if (!response.ok) {
      const error = object(payload, "Voice Relay error response");
      throw new VoiceRelayHttpError(
        typeof error.code === "string" ? error.code.slice(0, 64) : "request_failed",
        typeof error.message === "string" ? error.message.slice(0, 300) : "Voice Relay request failed.",
        response.status,
        error.recoverable !== false,
      );
    }
    return payload;
  }
}
