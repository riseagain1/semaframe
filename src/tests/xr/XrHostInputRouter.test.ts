import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import { createXRContextEnvelope } from "../../xr/client";
import { XrHostInputRouter } from "../../xr/authority";
import type { XrInputMessage, XrInputType, XrJsonObject } from "../../xr/protocol";

const workspace: WorkspaceRenderSnapshot = {
  workspaceId: "workspace_input_router",
  revision: 12,
  components: [{
    id: "button",
    type: { typeId: "button", version: "1", digest: "digest" },
    label: "Run",
    props: {},
    durableState: {},
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 }, size: { width: 120, height: 44 }, zIndex: 1 },
    tags: [],
    visibility: "visible",
    locks: { placement: false },
  }],
};
const authenticatedSource = Object.freeze({
  rendererSessionId: "authenticated-renderer-session",
  serverReceivedAtMs: 1_000,
  serverQueueAgeMs: 25,
});

function message(inputType: XrInputType, payload: XrJsonObject, revision = 12): XrInputMessage {
  return {
    protocolVersion: 1,
    messageType: "input",
    sessionId: "renderer-session",
    authorityEpoch: "authority-epoch",
    workspaceId: workspace.workspaceId,
    revision,
    requestId: `request-${inputType}`,
    inputType,
    payload,
  };
}

function voiceContext() {
  return createXRContextEnvelope({
    source: "desktop-simulator",
    workspaceId: workspace.workspaceId,
    workspaceRevision: workspace.revision,
    capturedAtMs: 1_000,
    referenceSpace: "local-floor",
    headPose: {
      position: { x: 0, y: 1.65, z: 2 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
    trackedInputs: [],
    selectedComponentId: "button",
    playerCapsule: { feet: { x: 0, y: 0, z: 2 }, radius: 0.25, height: 1.65 },
  });
}

describe("XrHostInputRouter", () => {
  it("routes selection and activation only for current components", async () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    const router = new XrHostInputRouter({ onSelect, onActivate, onPanelAction: vi.fn() });
    await expect(router.route(message("select", { componentId: "button" }), workspace, authenticatedSource))
      .resolves.toEqual({ status: "handled", code: "selected" });
    await expect(router.route(message("activate", { componentId: "missing" }), workspace, authenticatedSource))
      .resolves.toEqual({ status: "rejected", code: "component_not_found" });
    expect(onSelect).toHaveBeenCalledWith("button");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("re-authorizes revision-bound panel actions and fails closed on confirmation", async () => {
    const onPanelAction = vi.fn();
    const router = new XrHostInputRouter({
      onSelect: vi.fn(),
      onActivate: vi.fn(),
      onPanelAction,
    });
    const action = {
      type: "invoke_component_action",
      targetComponentId: "button",
      actionName: "press",
      input: {},
      expectedWorkspaceRevision: 12,
      confirmation: "required",
    } as const;
    await expect(router.route(message("panel_action", { panelId: "panel-button", action }), workspace, authenticatedSource))
      .resolves.toEqual({ status: "rejected", code: "confirmation_denied" });
    expect(onPanelAction).not.toHaveBeenCalled();

    const allowed = new XrHostInputRouter({
      onSelect: vi.fn(),
      onActivate: vi.fn(),
      onPanelAction,
      authorizePanelAction: () => true,
    });
    await expect(allowed.route(message("panel_action", { panelId: "panel-button", action }), workspace, authenticatedSource))
      .resolves.toEqual({ status: "handled", code: "panel_action_invoked" });
    expect(onPanelAction).toHaveBeenCalledWith(action);
  });

  it("returns a host challenge and invokes only after the exact proof is re-authorized", async () => {
    const onPanelAction = vi.fn();
    const challenge = {
      challengeId: "challenge-router-0001",
      expiresInMs: 15_000,
      panelId: "panel-button",
      actionLabel: "press",
      targetComponentId: "button",
      workspaceRevision: 12,
    } as const;
    const authorizePanelAction = vi.fn((_action, request) => (
      request.confirmation?.challengeId === challenge.challengeId
        && request.confirmation.decision === "confirmed"
        ? true
        : challenge
    ));
    const router = new XrHostInputRouter({
      onSelect: vi.fn(),
      onActivate: vi.fn(),
      onPanelAction,
      authorizePanelAction,
    });
    const action = {
      type: "invoke_component_action",
      targetComponentId: "button",
      actionName: "press",
      input: {},
      expectedWorkspaceRevision: 12,
      confirmation: "required",
    } as const;

    await expect(router.route(message("panel_action", { panelId: "panel-button", action }), workspace, authenticatedSource))
      .resolves.toEqual({ status: "ignored", code: "confirmation_required", confirmationChallenge: challenge });
    expect(onPanelAction).not.toHaveBeenCalled();

    await expect(router.route(message("panel_action", {
      panelId: "panel-button",
      action,
      confirmation: { challengeId: challenge.challengeId, decision: "confirmed" },
    }), workspace, authenticatedSource)).resolves.toEqual({ status: "handled", code: "panel_action_invoked" });
    expect(onPanelAction).toHaveBeenCalledOnce();
    expect(authorizePanelAction).toHaveBeenLastCalledWith(action, expect.objectContaining({
      rendererSessionId: "authenticated-renderer-session",
      panelId: "panel-button",
      confirmation: { challengeId: challenge.challengeId, decision: "confirmed" },
    }));
  });

  it("forwards final voice with context but never accepts partial voice on the durable input path", async () => {
    const onVoiceIntent = vi.fn();
    const router = new XrHostInputRouter({
      onSelect: vi.fn(),
      onActivate: vi.fn(),
      onPanelAction: vi.fn(),
      onVoiceIntent,
    });
    await expect(router.route(message("voice_partial", { text: "build" }), workspace, authenticatedSource))
      .resolves.toEqual({ status: "rejected", code: "partial_voice_must_be_ephemeral" });
    await expect(router.route(message("voice_final", {
      utteranceId: "utterance-1",
      text: "Build a blue table here",
      sequence: 3,
      context: voiceContext() as unknown as XrJsonObject,
    }), workspace, authenticatedSource)).resolves.toEqual({ status: "handled", code: "voice_intent_forwarded" });
    expect(onVoiceIntent).toHaveBeenCalledWith(expect.objectContaining({
      text: "Build a blue table here",
      workspaceRevision: 12,
      context: expect.objectContaining({
        workspaceId: workspace.workspaceId,
        workspaceRevision: 12,
        selectedComponentId: "button",
      }),
    }), authenticatedSource);
  });

  it("strictly rejects forged or structurally incomplete spatial voice context", async () => {
    const onVoiceIntent = vi.fn();
    const router = new XrHostInputRouter({
      onSelect: vi.fn(),
      onActivate: vi.fn(),
      onPanelAction: vi.fn(),
      onVoiceIntent,
    });
    await expect(router.route(message("voice_final", {
      utteranceId: "utterance-invalid",
      text: "Put it here",
      sequence: 1,
      context: { ...voiceContext(), workspaceRevision: 11 } as unknown as XrJsonObject,
    }), workspace, authenticatedSource)).resolves.toEqual({ status: "rejected", code: "stale_revision" });
    await expect(router.route(message("voice_final", {
      utteranceId: "utterance-malformed",
      text: "Put it here",
      sequence: 1,
      context: { format: "semaframe-xr-context", selectedComponentId: "button" },
    }), workspace, authenticatedSource)).resolves.toEqual({ status: "rejected", code: "invalid_payload" });
    expect(onVoiceIntent).not.toHaveBeenCalled();
  });

  it("rejects stale input before any callback and exposes a clear provider boundary", async () => {
    const onSelect = vi.fn();
    const router = new XrHostInputRouter({ onSelect, onActivate: vi.fn(), onPanelAction: vi.fn() });
    await expect(router.route(message("select", { componentId: "button" }, 11), workspace, authenticatedSource))
      .resolves.toEqual({ status: "rejected", code: "stale_revision" });
    await expect(router.route(message("voice_final", {
      utteranceId: "utterance-2",
      text: "Build a chair",
      sequence: 1,
      context: voiceContext() as unknown as XrJsonObject,
    }), workspace, authenticatedSource)).resolves.toEqual({ status: "ignored", code: "voice_provider_not_configured" });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
