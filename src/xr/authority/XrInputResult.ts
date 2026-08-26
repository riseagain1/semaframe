import type { XrHostInputRouteResult } from "./XrHostInputRouter";
import type { XrEphemeralMessage, XrInputMessage, XrJsonObject } from "../protocol";

export const XR_INPUT_RESULT_CHANNEL = "input.result" as const;
const XR_INPUT_RESULT_CODES = [
  "selected", "activated", "panel_action_invoked", "voice_intent_forwarded",
  "spatial_input_observed", "voice_provider_not_configured", "voice_agent_failed",
  "unsupported_input", "invalid_payload", "stale_revision", "component_not_found",
  "confirmation_required", "confirmation_denied", "partial_voice_must_be_ephemeral",
] as const satisfies readonly XrHostInputRouteResult["code"][];

export type XrInputResult = Readonly<{
  inputRequestId: string;
  inputType: XrInputMessage["inputType"];
  workspaceRevision: number;
  status: XrHostInputRouteResult["status"];
  code: XrHostInputRouteResult["code"];
  utteranceId?: string;
  message?: string;
  confirmationChallenge?: import("./XrHostInputRouter").XrPanelConfirmationChallenge;
}>;

export function createXrInputResultPayload(
  input: XrInputMessage,
  result: XrHostInputRouteResult,
): XrJsonObject {
  const utteranceId = input.inputType === "voice_final"
    && typeof input.payload.utteranceId === "string"
    && input.payload.utteranceId.length <= 256
    ? input.payload.utteranceId
    : undefined;
  return Object.freeze({
    inputRequestId: input.requestId,
    inputType: input.inputType,
    workspaceRevision: input.revision,
    status: result.status,
    code: result.code,
    ...(utteranceId ? { utteranceId } : {}),
    ...(result.message ? { message: result.message.slice(0, 1_000) } : {}),
    ...(result.confirmationChallenge ? { confirmationChallenge: result.confirmationChallenge } : {}),
  });
}

export function parseXrInputResult(message: XrEphemeralMessage): XrInputResult | undefined {
  if (message.channel !== XR_INPUT_RESULT_CHANNEL) return undefined;
  const body = message.payload as Record<string, unknown>;
  const allowed = new Set([
    "inputRequestId", "inputType", "workspaceRevision", "status", "code", "utteranceId", "message",
    "confirmationChallenge",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))
    || typeof body.inputRequestId !== "string" || body.inputRequestId.length < 8 || body.inputRequestId.length > 128
    || !["pose", "select", "activate", "grab", "teleport", "voice_partial", "voice_final", "panel_action"]
      .includes(String(body.inputType))
    || !Number.isSafeInteger(body.workspaceRevision) || Number(body.workspaceRevision) < 0
    || !["handled", "ignored", "rejected"].includes(String(body.status))
    || typeof body.code !== "string" || !(XR_INPUT_RESULT_CODES as readonly string[]).includes(body.code)
    || (body.utteranceId !== undefined && (
      typeof body.utteranceId !== "string" || body.utteranceId.length < 1 || body.utteranceId.length > 256
    ))
    || (body.message !== undefined && (
      typeof body.message !== "string" || body.message.length < 1 || body.message.length > 1_000
    ))) {
    throw new TypeError("XR input result payload is invalid");
  }
  let confirmationChallenge: XrInputResult["confirmationChallenge"];
  if (body.confirmationChallenge !== undefined) {
    if (body.code !== "confirmation_required"
      || !body.confirmationChallenge || typeof body.confirmationChallenge !== "object"
      || Array.isArray(body.confirmationChallenge)) {
      throw new TypeError("XR input confirmation challenge is invalid");
    }
    const challenge = body.confirmationChallenge as Record<string, unknown>;
    const keys = Object.keys(challenge);
    if (keys.length !== 6
      || !["challengeId", "expiresInMs", "panelId", "actionLabel", "targetComponentId", "workspaceRevision"]
        .every((key) => Object.hasOwn(challenge, key))
      || typeof challenge.challengeId !== "string" || challenge.challengeId.length < 8 || challenge.challengeId.length > 128
      || typeof challenge.panelId !== "string" || challenge.panelId.length < 1 || challenge.panelId.length > 256
      || typeof challenge.actionLabel !== "string" || challenge.actionLabel.length < 1 || challenge.actionLabel.length > 256
      || typeof challenge.targetComponentId !== "string" || challenge.targetComponentId.length < 1 || challenge.targetComponentId.length > 256
      || !Number.isSafeInteger(challenge.expiresInMs) || Number(challenge.expiresInMs) < 1_000 || Number(challenge.expiresInMs) > 60_000
      || challenge.workspaceRevision !== body.workspaceRevision) {
      throw new TypeError("XR input confirmation challenge is invalid");
    }
    confirmationChallenge = Object.freeze({
      challengeId: challenge.challengeId,
      expiresInMs: Number(challenge.expiresInMs),
      panelId: challenge.panelId,
      actionLabel: challenge.actionLabel,
      targetComponentId: challenge.targetComponentId,
      workspaceRevision: Number(challenge.workspaceRevision),
    });
  } else if (body.code === "confirmation_required") {
    throw new TypeError("XR input confirmation challenge is missing");
  }
  return Object.freeze({
    inputRequestId: body.inputRequestId,
    inputType: body.inputType as XrInputResult["inputType"],
    workspaceRevision: Number(body.workspaceRevision),
    status: body.status as XrInputResult["status"],
    code: body.code as XrInputResult["code"],
    ...(body.utteranceId === undefined ? {} : { utteranceId: body.utteranceId }),
    ...(body.message === undefined ? {} : { message: body.message }),
    ...(confirmationChallenge ? { confirmationChallenge } : {}),
  });
}
