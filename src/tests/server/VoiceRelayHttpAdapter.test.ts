import { describe, expect, it } from "vitest";
import {
  createVoiceRelayHttpHandler,
  InMemoryVoiceRelayNativePort,
  VoiceRelayService,
  type VoiceRelayHttpSurface,
} from "../../../server/voice-relay";

function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  method = body === undefined ? "GET" : "POST",
) {
  return new Request(`http://127.0.0.1:8788${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function harness() {
  const native = new InMemoryVoiceRelayNativePort();
  const service = new VoiceRelayService(native, {
    requestDigestKey: new Uint8Array(32).fill(3),
    stageIdFactory: () => "relay-stage-http-1",
  });
  const authorized: VoiceRelayHttpSurface[] = [];
  const handler = createVoiceRelayHttpHandler({
    service,
    authorize: (incoming, surface) => {
      authorized.push(surface);
      return surface === "desktop"
        ? incoming.headers.get("x-desktop-auth") === "ok"
        : incoming.headers.get("x-xr-session") === "paired-renderer"
          ? { ownerId: "renderer-session-http-test" }
          : false;
    },
    consumeDesktopHostAction: (incoming, action) => incoming.headers.get("x-host-action") === action,
  });
  return { handler, native, service, authorized };
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("VoiceRelayHttpAdapter", () => {
  it("keeps authenticated status benign when the native helper is unavailable", async () => {
    const handler = createVoiceRelayHttpHandler({
      authorize: (incoming, surface) => surface === "xr"
        && incoming.headers.get("x-xr-session") === "paired-renderer"
        ? { ownerId: "renderer-session-unavailable-test" }
        : false,
      consumeDesktopHostAction: () => false,
    });
    const xr = { "x-xr-session": "paired-renderer" };

    const status = await handler.fetch(request("/api/xr/voice-relay/status", {}, xr));
    expect(status.status).toBe(200);
    expect(await json(status)).toEqual({
      enabled: false,
      armed: false,
      phase: "off",
      error: {
        code: "voice_relay_unavailable",
        message: "Voice Relay is unavailable because this host has no supported native helper.",
        recoverable: false,
      },
    });

    const stage = await handler.fetch(request(
      "/api/xr/voice-relay/stages",
      { utteranceId: "utterance-unavailable", text: "Build a bridge" },
      xr,
    ));
    expect(stage.status).toBe(503);
    expect(await json(stage)).toMatchObject({
      code: "voice_relay_unavailable",
      recoverable: false,
    });

    const unknown = await handler.fetch(request("/api/xr/voice-relay/not-a-route", {}, xr));
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ code: "not_found" });

    const unauthorized = await handler.fetch(request("/api/xr/voice-relay/status", {}));
    expect(unauthorized.status).toBe(403);
    await expect(handler.close()).resolves.toBeUndefined();
  });

  it("keeps target setup and arming on the authenticated desktop surface", async () => {
    const { handler, native } = harness();
    const desktop = { "x-desktop-auth": "ok" };

    const prepared = await handler.fetch(request("/api/agent/voice-relay/setup/prepare", {}, desktop));
    expect(prepared.status).toBe(200);
    const setup = await json(prepared);
    const candidates = setup.candidates as Array<{ candidateId: string }>;

    const configured = await handler.fetch(request(
      "/api/agent/voice-relay/setup/target",
      { candidateId: candidates[0]!.candidateId },
      { ...desktop, "x-host-action": "voice_relay_configure_target" },
    ));
    expect(configured.status).toBe(200);
    const target = await json(configured);

    const deniedProbe = await handler.fetch(request(
      "/api/agent/voice-relay/diagnostics",
      { performDraftRoundTrip: true },
      desktop,
    ));
    expect(deniedProbe.status).toBe(403);
    expect(await json(deniedProbe)).toMatchObject({ code: "host_action_confirmation_required" });

    const probed = await handler.fetch(request(
      "/api/agent/voice-relay/diagnostics",
      { performDraftRoundTrip: true },
      { ...desktop, "x-host-action": "voice_relay_draft_round_trip" },
    ));
    expect(probed.status).toBe(200);
    expect(await json(probed)).toMatchObject({ ready: true });
    expect(native.probeCount).toBe(1);
    expect(native.sendCount).toBe(0);

    const armed = await handler.fetch(request(
      "/api/agent/voice-relay/arm",
      { targetId: target.targetId },
      { ...desktop, "x-host-action": "voice_relay_arm" },
    ));
    expect(armed.status).toBe(200);
    expect(await json(armed)).toMatchObject({ armed: true, status: { phase: "ready" } });

    const xrSetup = await handler.fetch(request(
      "/api/xr/voice-relay/setup/prepare",
      {},
      { "x-xr-session": "paired-renderer" },
    ));
    expect(xrSetup.status).toBe(403);
    expect(await json(xrSetup)).toMatchObject({ code: "desktop_action_required" });
  });

  it("allows only a paired XR renderer to stage, confirm, cancel and read replies", async () => {
    const { handler, native, service } = harness();
    const prepared = await service.prepareSetup();
    const target = await service.configureTarget({ candidateId: prepared.candidates[0]!.candidateId });
    await service.arm(target.targetId);
    const xr = { "x-xr-session": "paired-renderer" };

    const unauthorized = await handler.fetch(request(
      "/api/xr/voice-relay/stages",
      { utteranceId: "utterance-http", text: "Create a table" },
    ));
    expect(unauthorized.status).toBe(403);

    const stagedResponse = await handler.fetch(request(
      "/api/xr/voice-relay/stages",
      { utteranceId: "utterance-http", text: "Create a table" },
      xr,
    ));
    expect(stagedResponse.status).toBe(200);
    const staged = await json(stagedResponse);
    expect(native.sendCount).toBe(0);

    const confirmed = await handler.fetch(request(
      `/api/xr/voice-relay/stages/${staged.stageId as string}/confirm`,
      {},
      xr,
    ));
    expect(confirmed.status).toBe(200);
    expect(await json(confirmed)).toMatchObject({ status: "sent" });
    expect(native.sendCount).toBe(1);

    native.setReply("Created a table.");
    const reply = await handler.fetch(request(
      `/api/xr/voice-relay/stages/${staged.stageId as string}/reply`,
      { afterSequence: 0 },
      xr,
    ));
    expect(reply.status).toBe(200);
    expect(await json(reply)).toMatchObject({ phase: "complete", text: "Created a table." });
  });

  it("rejects unsupported fields and media types before invoking the service", async () => {
    const { handler } = harness();
    const unauthorized = await handler.fetch(new Request(
      "http://127.0.0.1:8788/api/agent/voice-relay/setup/prepare",
      { method: "POST", headers: { "x-desktop-auth": "ok", "content-type": "text/plain" }, body: "{}" },
    ));
    expect(unauthorized.status).toBe(415);

    const unknown = await handler.fetch(request(
      "/api/agent/voice-relay/setup/prepare",
      { unexpected: true },
      { "x-desktop-auth": "ok" },
    ));
    expect(unknown.status).toBe(400);
  });
});
