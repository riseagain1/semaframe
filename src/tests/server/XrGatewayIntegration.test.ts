// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import { createAgentGatewayHttpHandler } from "../../../server/agent/AgentGatewayHttpHandler";
import { InMemoryVoiceRelayNativePort, VoiceRelayService } from "../../../server/voice-relay";
import { XR_HTTP_PATHS, XrRelay } from "../../../server/xr";
import { VOICE_RELAY_HTTP_PATHS } from "../../voice-relay";
import { XR_HTTP_SESSION_HEADER } from "../../xr/network";

const PUBLIC_URL = "http://127.0.0.1:8788";
const APP_ORIGIN = "http://127.0.0.1:4173";
const XR_ORIGIN = "http://127.0.0.1:4174";
const BOOTSTRAP = "x".repeat(43);
const closeables: Array<{ close(): void | Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((entry) => entry.close()));
  vi.restoreAllMocks();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function stagedXrVoiceRelay(now: () => number, suffix: string) {
  const gateway = new AgentGateway({ publicBaseUrl: PUBLIC_URL, workspaceRoot: "/workspace/SemaFrame" });
  const relay = new XrRelay({ now });
  const native = new InMemoryVoiceRelayNativePort();
  const service = new VoiceRelayService(native, {
    now,
    requestDigestKey: new Uint8Array(32).fill(17),
    stageIdFactory: () => `relay-stage-${suffix}`,
  });
  const prepared = await service.prepareSetup();
  const target = await service.configureTarget({ candidateId: prepared.candidates[0]!.candidateId });
  await service.arm(target.targetId);
  const handle = createAgentGatewayHttpHandler(gateway, {
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [APP_ORIGIN],
    browserBootstrapToken: BOOTSTRAP,
    xrRelay: relay,
    xrRendererOrigins: [XR_ORIGIN],
    voiceRelayService: service,
  });
  closeables.push(handle, gateway);
  const authority = relay.connectAuthority({ workspaceId: `workspace_${suffix}` });
  const pairing = relay.createPairing({
    sessionId: authority.sessionId,
    sessionBearer: authority.sessionBearer,
  }, { voiceRelay: true });
  const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
  const text = `Delayed cleanup draft ${suffix}`;
  await service.stage({
    utteranceId: `utterance-${suffix}`,
    text,
  }, undefined, { ownerId: renderer.sessionId });
  return { handle, native, renderer, service, text };
}

function delayNativeCancel(native: InMemoryVoiceRelayNativePort) {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cancelDraft = native.cancelDraft.bind(native);
  vi.spyOn(native, "cancelDraft").mockImplementation(async (input) => {
    markStarted();
    await gate;
    return cancelDraft(input);
  });
  return { started, release };
}

describe("Agent Gateway XR boundary", () => {
  it("returns an authenticated disabled Relay status without a native helper and keeps XR CORS intact", async () => {
    const gateway = new AgentGateway({ publicBaseUrl: PUBLIC_URL, workspaceRoot: "/workspace/SemaFrame" });
    const relay = new XrRelay();
    const handle = createAgentGatewayHttpHandler(gateway, {
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [APP_ORIGIN],
      browserBootstrapToken: BOOTSTRAP,
      xrRelay: relay,
      xrRendererOrigins: [XR_ORIGIN],
    });
    closeables.push(handle, gateway);
    const authority = relay.connectAuthority({ workspaceId: "workspace_gateway_voice" });
    const disabledPairing = relay.createPairing({
      sessionId: authority.sessionId,
      sessionBearer: authority.sessionBearer,
    });
    const disabledRenderer = relay.connectRenderer({ pairingToken: disabledPairing.pairingToken });
    const statusPath = `${VOICE_RELAY_HTTP_PATHS.xrBase}${VOICE_RELAY_HTTP_PATHS.status}`;
    const disabledStatus = await handle(post(statusPath, {}, {
      origin: XR_ORIGIN,
      authorization: `Bearer ${disabledRenderer.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: disabledRenderer.sessionId,
    }));
    expect(disabledStatus.status).toBe(403);

    const pairing = relay.createPairing({
      sessionId: authority.sessionId,
      sessionBearer: authority.sessionBearer,
    }, { voiceRelay: true });
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const headers = {
      origin: XR_ORIGIN,
      authorization: `Bearer ${renderer.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: renderer.sessionId,
    };

    const preflight = await handle(new Request(`${PUBLIC_URL}${statusPath}`, {
      method: "OPTIONS",
      headers: {
        origin: XR_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": `authorization, content-type, ${XR_HTTP_SESSION_HEADER}`,
      },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);

    const status = await handle(post(statusPath, {}, headers));
    expect(status.status).toBe(200);
    expect(status.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);
    await expect(status.json()).resolves.toMatchObject({
      enabled: false,
      armed: false,
      phase: "off",
      error: { code: "voice_relay_unavailable", recoverable: false },
    });

    const stage = await handle(post(VOICE_RELAY_HTTP_PATHS.xrBase + VOICE_RELAY_HTTP_PATHS.stages, {
      utteranceId: "utterance-gateway-unavailable",
      text: "Build a bridge",
    }, headers));
    expect(stage.status).toBe(503);
    expect(stage.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);
    await expect(stage.json()).resolves.toMatchObject({ code: "voice_relay_unavailable" });
  });

  it("embeds one shared relay while keeping authority behind the local proxy capability", async () => {
    const gateway = new AgentGateway({
      publicBaseUrl: PUBLIC_URL,
      workspaceRoot: "/workspace/SemaFrame",
    });
    const relay = new XrRelay();
    const handle = createAgentGatewayHttpHandler(gateway, {
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [APP_ORIGIN],
      browserBootstrapToken: BOOTSTRAP,
      xrRelay: relay,
      xrRendererOrigins: [XR_ORIGIN],
    });
    closeables.push(handle, gateway);

    const rejected = await handle(post(XR_HTTP_PATHS.authorityConnect, {
      workspaceId: "workspace_gateway_xr",
    }));
    expect(rejected.status).toBe(401);
    expect(relay.authority).toBeUndefined();

    const foreignOrigin = await handle(post(XR_HTTP_PATHS.authorityConnect, {
      workspaceId: "workspace_gateway_xr",
    }, {
      "x-semaframe-browser-bootstrap": BOOTSTRAP,
      origin: "https://untrusted.example",
    }));
    expect(foreignOrigin.status).toBe(401);
    expect(relay.authority).toBeUndefined();

    const connected = await handle(post(XR_HTTP_PATHS.authorityConnect, {
      workspaceId: "workspace_gateway_xr",
    }, {
      "x-semaframe-browser-bootstrap": BOOTSTRAP,
      origin: APP_ORIGIN,
    }));
    expect(connected.status).toBe(200);
    const payload = await connected.json() as {
      data: {
        authorityEpoch: string;
        sessionId: string;
        sessionBearer: string;
        workspaceId: string;
      };
    };
    expect(payload.data.sessionBearer).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(relay.authority).toMatchObject({ workspaceId: "workspace_gateway_xr" });

    const authorityHeaders = {
      "x-semaframe-browser-bootstrap": BOOTSTRAP,
      origin: APP_ORIGIN,
      authorization: `Bearer ${payload.data.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: payload.data.sessionId,
    };
    const authoritySend = await handle(post(XR_HTTP_PATHS.sessionSend, {
      message: {
        protocolVersion: 1,
        messageType: "snapshot",
        sessionId: payload.data.sessionId,
        authorityEpoch: payload.data.authorityEpoch,
        workspaceId: payload.data.workspaceId,
        revision: 0,
        requestId: "gateway-authority-snapshot",
        registryDigest: `sha256:${"a".repeat(64)}`,
        snapshotDigest: `sha256:${"b".repeat(64)}`,
        snapshot: { revision: 0, components: [] },
      },
    }, authorityHeaders));
    expect(authoritySend.status).toBe(200);
    expect(authoritySend.headers.get("access-control-allow-origin")).toBeNull();

    const authorityPoll = await handle(post(XR_HTTP_PATHS.sessionPoll, {}, authorityHeaders));
    expect(authorityPoll.status).toBe(200);
    expect(authorityPoll.headers.get("access-control-allow-origin")).toBeNull();

    const authorityWithoutBootstrap = await handle(post(XR_HTTP_PATHS.sessionPoll, {}, {
      origin: APP_ORIGIN,
      authorization: `Bearer ${payload.data.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: payload.data.sessionId,
    }));
    expect(authorityWithoutBootstrap.status).toBe(403);

    const untrustedOrigin = await handle(post(XR_HTTP_PATHS.sessionPoll, {}, {
      "x-semaframe-browser-bootstrap": BOOTSTRAP,
      origin: "https://untrusted.example",
      authorization: `Bearer ${payload.data.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: payload.data.sessionId,
    }));
    expect(untrustedOrigin.status).toBe(403);

    const pairing = relay.createPairing({
      sessionId: payload.data.sessionId,
      sessionBearer: payload.data.sessionBearer,
    });
    const rendererFromApp = await handle(post(XR_HTTP_PATHS.rendererConnect, {
      pairingToken: pairing.pairingToken,
    }, { origin: APP_ORIGIN }));
    expect(rendererFromApp.status).toBe(403);

    const rendererConnected = await handle(post(XR_HTTP_PATHS.rendererConnect, {
      pairingToken: pairing.pairingToken,
    }, { origin: XR_ORIGIN }));
    expect(rendererConnected.status).toBe(200);
    expect(rendererConnected.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);
    const rendererPayload = await rendererConnected.json() as {
      data: { sessionId: string; sessionBearer: string };
    };
    const rendererHeaders = {
      origin: XR_ORIGIN,
      authorization: `Bearer ${rendererPayload.data.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: rendererPayload.data.sessionId,
    };

    const rendererPoll = await handle(post(XR_HTTP_PATHS.sessionPoll, {}, rendererHeaders));
    expect(rendererPoll.status).toBe(200);
    expect(rendererPoll.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);

    const rendererOnAuthoritySurface = await handle(post(XR_HTTP_PATHS.sessionPoll, {}, {
      ...rendererHeaders,
      "x-semaframe-browser-bootstrap": BOOTSTRAP,
      origin: APP_ORIGIN,
    }));
    expect(rendererOnAuthoritySurface.status).toBe(403);

    const authorityOnRendererSurface = await handle(post(XR_HTTP_PATHS.sessionPoll, {}, {
      origin: XR_ORIGIN,
      authorization: `Bearer ${payload.data.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: payload.data.sessionId,
    }));
    expect(authorityOnRendererSurface.status).toBe(403);
    expect(authorityOnRendererSurface.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);

    const rendererPreflight = await handle(new Request(`${PUBLIC_URL}${XR_HTTP_PATHS.sessionPoll}`, {
      method: "OPTIONS",
      headers: {
        origin: XR_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": `authorization, content-type, ${XR_HTTP_SESSION_HEADER}`,
      },
    }));
    expect(rendererPreflight.status).toBe(204);
    expect(rendererPreflight.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);

    const appPreflight = await handle(new Request(`${PUBLIC_URL}${XR_HTTP_PATHS.sessionPoll}`, {
      method: "OPTIONS",
      headers: {
        origin: APP_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": `authorization, content-type, ${XR_HTTP_SESSION_HEADER}`,
      },
    }));
    expect(appPreflight.status).toBe(403);

    const rendererDisconnect = await handle(post(XR_HTTP_PATHS.sessionDisconnect, {}, rendererHeaders));
    expect(rendererDisconnect.status).toBe(200);
    expect(rendererDisconnect.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);

    const authorityDisconnect = await handle(post(XR_HTTP_PATHS.sessionDisconnect, {}, authorityHeaders));
    expect(authorityDisconnect.status).toBe(200);
    expect(authorityDisconnect.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("awaits exact Voice Relay owner cleanup before acknowledging renderer disconnect", async () => {
    const gateway = new AgentGateway({ publicBaseUrl: PUBLIC_URL, workspaceRoot: "/workspace/SemaFrame" });
    const relay = new XrRelay();
    const native = new InMemoryVoiceRelayNativePort();
    const service = new VoiceRelayService(native, {
      requestDigestKey: new Uint8Array(32).fill(11),
      stageIdFactory: () => "relay-stage-gateway-disconnect",
    });
    const prepared = await service.prepareSetup();
    const target = await service.configureTarget({ candidateId: prepared.candidates[0]!.candidateId });
    await service.arm(target.targetId);
    const handle = createAgentGatewayHttpHandler(gateway, {
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [APP_ORIGIN],
      browserBootstrapToken: BOOTSTRAP,
      xrRelay: relay,
      xrRendererOrigins: [XR_ORIGIN],
      voiceRelayService: service,
    });
    closeables.push(handle, gateway);
    const authority = relay.connectAuthority({ workspaceId: "workspace_gateway_owner_cleanup" });
    const pairing = relay.createPairing({
      sessionId: authority.sessionId,
      sessionBearer: authority.sessionBearer,
    }, { voiceRelay: true });
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    await service.stage({
      utteranceId: "utterance-gateway-disconnect",
      text: "This exact unsent draft must be removed",
    }, undefined, { ownerId: renderer.sessionId });
    expect(native.draft).toBe("This exact unsent draft must be removed");

    const response = await handle(post(XR_HTTP_PATHS.sessionDisconnect, {
      sessionId: renderer.sessionId,
    }, {
      origin: XR_ORIGIN,
      authorization: `Bearer ${renderer.sessionBearer}`,
    }));

    expect(response.status).toBe(200);
    expect(native.draft).toBe("");
    expect(native.cancelCount).toBe(1);
    expect(service.inspect({ ownerId: renderer.sessionId })).not.toHaveProperty("activeStage");
  });

  it("awaits delayed owner cleanup before returning an expired renderer poll", async () => {
    let now = 1_000;
    const { handle, native, renderer, service, text } = await stagedXrVoiceRelay(
      () => now,
      "expired-poll",
    );
    expect(native.draft).toBe(text);
    const delayed = delayNativeCancel(native);
    now += 10_001;

    let responseSettled = false;
    const responsePromise = handle(post(XR_HTTP_PATHS.sessionPoll, {}, {
      origin: XR_ORIGIN,
      authorization: `Bearer ${renderer.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: renderer.sessionId,
    })).then((response) => {
      responseSettled = true;
      return response;
    });

    await delayed.started;
    await Promise.resolve();
    const settledBeforeRelease = responseSettled;
    const draftBeforeRelease = native.draft;
    delayed.release();
    const response = await responsePromise;
    expect(settledBeforeRelease).toBe(false);
    expect(draftBeforeRelease).toBe(text);
    expect(response.status).toBe(401);
    expect(native.cancelCount).toBe(1);
    expect(native.draft).toBe("");
    expect(service.inspect({ ownerId: renderer.sessionId })).not.toHaveProperty("activeStage");
  });

  it("awaits delayed owner cleanup before rejecting expired XR Voice Relay authorization", async () => {
    let now = 1_000;
    const { handle, native, renderer, service, text } = await stagedXrVoiceRelay(
      () => now,
      "expired-voice",
    );
    expect(native.draft).toBe(text);
    const delayed = delayNativeCancel(native);
    now += 10_001;
    const statusPath = `${VOICE_RELAY_HTTP_PATHS.xrBase}${VOICE_RELAY_HTTP_PATHS.status}`;

    let responseSettled = false;
    const responsePromise = handle(post(statusPath, {}, {
      origin: XR_ORIGIN,
      authorization: `Bearer ${renderer.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: renderer.sessionId,
    })).then((response) => {
      responseSettled = true;
      return response;
    });

    await delayed.started;
    await Promise.resolve();
    const settledBeforeRelease = responseSettled;
    const draftBeforeRelease = native.draft;
    delayed.release();
    const response = await responsePromise;
    expect(settledBeforeRelease).toBe(false);
    expect(draftBeforeRelease).toBe(text);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);
    expect(native.cancelCount).toBe(1);
    expect(native.draft).toBe("");
    expect(service.inspect({ ownerId: renderer.sessionId })).not.toHaveProperty("activeStage");
  });

  it("allows only the configured XR renderer origin without exposing Agent browser routes", async () => {
    const gateway = new AgentGateway({ publicBaseUrl: PUBLIC_URL, workspaceRoot: "/workspace/SemaFrame" });
    const handle = createAgentGatewayHttpHandler(gateway, {
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [APP_ORIGIN],
      browserBootstrapToken: BOOTSTRAP,
      xrRendererOrigins: [XR_ORIGIN],
    });
    closeables.push(handle, gateway);
    await handle(post(XR_HTTP_PATHS.authorityConnect, { workspaceId: "workspace_gateway_xr" }, {
      "x-semaframe-browser-bootstrap": BOOTSTRAP,
    }));

    const foreign = await handle(post(XR_HTTP_PATHS.rendererConnect, { pairingToken: "p".repeat(43) }, {
      origin: "https://attacker.example",
    }));
    expect(foreign.status).toBe(403);
    const allowed = await handle(post(XR_HTTP_PATHS.rendererConnect, { pairingToken: "p".repeat(43) }, {
      origin: XR_ORIGIN,
    }));
    expect(allowed.status).toBe(401);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);

    const agentRoute = await handle(new Request(`${PUBLIC_URL}/api/agent/config`, {
      headers: { origin: XR_ORIGIN },
    }));
    expect(agentRoute.status).toBe(403);
  });

});
