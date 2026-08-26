import type { JSONObject } from "../../workspace/components/componentTypes";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import { parseXRContextEnvelope, type XRContextEnvelope } from "../client";
import type { XRPanelTypedAction } from "../panels";
import type { XrInputMessage } from "../protocol";

export type XrVoiceIntent = Readonly<{
  utteranceId: string;
  text: string;
  sequence: number;
  context: XRContextEnvelope;
  workspaceId: string;
  workspaceRevision: number;
}>;

export type XrPanelConfirmationProof = Readonly<{
  challengeId: string;
  decision: "confirmed" | "declined";
}>;

export type XrPanelConfirmationChallenge = Readonly<{
  challengeId: string;
  expiresInMs: number;
  panelId: string;
  actionLabel: string;
  targetComponentId: string;
  workspaceRevision: number;
}>;

export type XrPanelAuthorizationRequest = Readonly<{
  rendererSessionId: string;
  inputRequestId: string;
  panelId: string;
  confirmation?: XrPanelConfirmationProof;
}>;

/** Server-authenticated renderer provenance carried outside the routed message. */
export type XrAuthenticatedRendererSource = Readonly<{
  rendererSessionId: string;
  /** Relay-clock timestamp for provenance only; consumers must not subtract a browser clock from it. */
  serverReceivedAtMs: number;
  /** Relay-computed age of this delivery at the authority poll boundary. */
  serverQueueAgeMs: number;
}>;

export type XrHostInputRouteResult = Readonly<{
  status: "handled" | "ignored" | "rejected";
  message?: string;
  code:
    | "selected"
    | "activated"
    | "panel_action_invoked"
    | "voice_intent_forwarded"
    | "spatial_input_observed"
    | "voice_provider_not_configured"
    | "voice_agent_failed"
    | "unsupported_input"
    | "invalid_payload"
    | "stale_revision"
    | "component_not_found"
    | "confirmation_required"
    | "confirmation_denied"
    | "partial_voice_must_be_ephemeral";
  confirmationChallenge?: XrPanelConfirmationChallenge;
}>;

export type XrHostInputRouterOptions = Readonly<{
  onSelect(componentId: string | null): void | Promise<void>;
  onActivate(componentId: string): void | Promise<void>;
  onPanelAction(action: XRPanelTypedAction): void | Promise<void>;
  authorizePanelAction?(
    action: XRPanelTypedAction,
    request: XrPanelAuthorizationRequest,
  ): boolean | XrPanelConfirmationChallenge | Promise<boolean | XrPanelConfirmationChallenge>;
  onVoiceIntent?(intent: XrVoiceIntent, source: XrAuthenticatedRendererSource): void | Promise<void>;
  onSpatialInput?(message: XrInputMessage, source: XrAuthenticatedRendererSource): void | Promise<void>;
}>;

function exactRecord(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("XR input payload must be a plain object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(body, key))) {
    throw new TypeError("XR input payload fields are invalid");
  }
  return body;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new TypeError("XR input text is invalid");
  }
  return value;
}

function componentId(value: unknown, ids: ReadonlySet<string>): string {
  const id = boundedText(value, 256);
  if (!ids.has(id)) throw new XrHostInputError("component_not_found", `XR component ${id} is unavailable`);
  return id;
}

function panelAction(value: unknown, ids: ReadonlySet<string>, revision: number): XRPanelTypedAction {
  const body = exactRecord(value, [
    "type", "targetComponentId", "actionName", "input", "expectedWorkspaceRevision", "confirmation",
  ], ["type", "targetComponentId", "actionName", "input", "expectedWorkspaceRevision", "confirmation"]);
  if (body.type !== "invoke_component_action"
    || (body.confirmation !== "none" && body.confirmation !== "required")
    || body.expectedWorkspaceRevision !== revision) {
    throw new TypeError("XR panel action contract is invalid or stale");
  }
  const input = exactRecord(body.input, Object.keys(body.input as object), []);
  return Object.freeze({
    type: "invoke_component_action",
    targetComponentId: componentId(body.targetComponentId, ids),
    actionName: boundedText(body.actionName, 256),
    input: structuredClone(input) as JSONObject,
    expectedWorkspaceRevision: revision,
    confirmation: body.confirmation,
  });
}

function panelConfirmation(value: unknown): XrPanelConfirmationProof | undefined {
  if (value === undefined) return undefined;
  const body = exactRecord(value, ["challengeId", "decision"], ["challengeId", "decision"]);
  if (body.decision !== "confirmed" && body.decision !== "declined") {
    throw new TypeError("XR panel confirmation decision is invalid");
  }
  return Object.freeze({
    challengeId: boundedText(body.challengeId, 128),
    decision: body.decision,
  });
}

export class XrHostInputError extends Error {
  constructor(readonly code: XrHostInputRouteResult["code"], message: string) {
    super(message);
    this.name = "XrHostInputError";
  }
}

/**
 * Re-authorizes renderer input at the host/App boundary. A paired renderer can
 * request semantic behavior, but it cannot bypass revision or component checks.
 */
export class XrHostInputRouter {
  constructor(private readonly options: XrHostInputRouterOptions) {}

  async route(
    message: XrInputMessage,
    snapshot: WorkspaceRenderSnapshot,
    source: XrAuthenticatedRendererSource,
  ): Promise<XrHostInputRouteResult> {
    if (message.workspaceId !== snapshot.workspaceId || message.revision !== snapshot.revision) {
      return Object.freeze({ status: "rejected", code: "stale_revision" });
    }
    const ids = new Set(snapshot.components.map((component) => component.id));
    try {
      if (message.inputType === "select") {
        const body = exactRecord(message.payload, ["componentId", "source"], ["componentId"]);
        const id = body.componentId === null ? null : componentId(body.componentId, ids);
        await this.options.onSelect(id);
        return Object.freeze({ status: "handled", code: "selected" });
      }
      if (message.inputType === "activate") {
        const body = exactRecord(message.payload, ["componentId", "source"], ["componentId"]);
        await this.options.onActivate(componentId(body.componentId, ids));
        return Object.freeze({ status: "handled", code: "activated" });
      }
      if (message.inputType === "panel_action") {
        const body = exactRecord(message.payload, ["panelId", "action", "confirmation"], ["panelId", "action"]);
        const panelId = boundedText(body.panelId, 256);
        const action = panelAction(body.action, ids, snapshot.revision);
        const confirmation = panelConfirmation(body.confirmation);
        if (action.confirmation === "none" && confirmation) {
          throw new TypeError("A confirmation proof is not valid for this panel action");
        }
        if (action.confirmation === "required") {
          const authorization = await (this.options.authorizePanelAction?.(action, Object.freeze({
            rendererSessionId: source.rendererSessionId,
            inputRequestId: message.requestId,
            panelId,
            ...(confirmation ? { confirmation } : {}),
          })) ?? false);
          if (typeof authorization === "object") {
            return Object.freeze({
              status: "ignored",
              code: "confirmation_required",
              confirmationChallenge: authorization,
            });
          }
          if (!authorization) {
            return Object.freeze({ status: "rejected", code: "confirmation_denied" });
          }
        }
        await this.options.onPanelAction(action);
        return Object.freeze({ status: "handled", code: "panel_action_invoked" });
      }
      if (message.inputType === "voice_partial") {
        return Object.freeze({ status: "rejected", code: "partial_voice_must_be_ephemeral" });
      }
      if (message.inputType === "voice_final") {
        const body = exactRecord(message.payload, ["utteranceId", "text", "sequence", "context"], [
          "utteranceId", "text", "sequence", "context",
        ]);
        if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0) {
          throw new TypeError("XR voice sequence is invalid");
        }
        const context = parseXRContextEnvelope(body.context);
        if (context.workspaceId !== snapshot.workspaceId
          || context.workspaceRevision !== snapshot.revision) {
          return Object.freeze({ status: "rejected", code: "stale_revision" });
        }
        if (context.selectedComponentId !== undefined && !ids.has(context.selectedComponentId)) {
          throw new XrHostInputError(
            "component_not_found",
            `XR component ${context.selectedComponentId} is unavailable`,
          );
        }
        if (context.rayHit?.kind === "component"
          && context.rayHit.targetId !== undefined
          && !ids.has(context.rayHit.targetId)) {
          throw new XrHostInputError(
            "component_not_found",
            `XR component ${context.rayHit.targetId} is unavailable`,
          );
        }
        if (!this.options.onVoiceIntent) {
          return Object.freeze({ status: "ignored", code: "voice_provider_not_configured" });
        }
        await this.options.onVoiceIntent(Object.freeze({
          utteranceId: boundedText(body.utteranceId, 256),
          text: boundedText(body.text, 4_000),
          sequence: Number(body.sequence),
          context,
          workspaceId: snapshot.workspaceId,
          workspaceRevision: snapshot.revision,
        }), source);
        return Object.freeze({ status: "handled", code: "voice_intent_forwarded" });
      }
      if (["pose", "grab", "teleport"].includes(message.inputType)) {
        await this.options.onSpatialInput?.(message, source);
        return Object.freeze({ status: "handled", code: "spatial_input_observed" });
      }
      return Object.freeze({ status: "ignored", code: "unsupported_input" });
    } catch (cause) {
      if (cause instanceof XrHostInputError) {
        return Object.freeze({
          status: "rejected",
          code: cause.code,
          ...(cause.code.startsWith("voice_") ? { message: cause.message.slice(0, 1_000) } : {}),
        });
      }
      return Object.freeze({ status: "rejected", code: "invalid_payload" });
    }
  }
}
