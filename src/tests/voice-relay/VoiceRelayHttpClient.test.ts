import { describe, expect, it } from "vitest";
import {
  createVoiceRelayHttpHandler,
  InMemoryVoiceRelayNativePort,
  VoiceRelayService,
} from "../../../server/voice-relay";
import { VoiceRelayHttpClient } from "../../voice-relay";

describe("VoiceRelayHttpClient", () => {
  it("accepts only exact same-origin relay paths or a canonical absolute XR gateway URL", () => {
    expect(() => new VoiceRelayHttpClient({
      baseUrl: "https://gateway.semaframe.test/api/xr/voice-relay/",
      fetchImpl: async () => new Response(),
    })).not.toThrow();
    for (const baseUrl of [
      "https://gateway.semaframe.test/api/agent/voice-relay",
      "https://user@gateway.semaframe.test/api/xr/voice-relay",
      "https://gateway.semaframe.test/api/xr/voice-relay?token=secret",
      "/api/xr/voice-relay/other",
    ]) {
      expect(() => new VoiceRelayHttpClient({
        baseUrl,
        fetchImpl: async () => new Response(),
      })).toThrow(/canonical XR gateway URL/u);
    }
  });

  it("preserves sanitized status error details for recovery UI", async () => {
    const client = new VoiceRelayHttpClient({
      fetchImpl: async () => new Response(JSON.stringify({
        enabled: true,
        armed: false,
        phase: "error",
        error: {
          code: "target_lost",
          message: "The confirmed Agent window is no longer available.",
          recoverable: true,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    await expect(client.inspect()).resolves.toMatchObject({
      phase: "error",
      error: {
        code: "target_lost",
        message: "The confirmed Agent window is no longer available.",
        recoverable: true,
      },
    });
  });

  it("runs the paired-XR stage/confirm/reply flow and acknowledges reply sequences", async () => {
    const native = new InMemoryVoiceRelayNativePort();
    const service = new VoiceRelayService(native, {
      requestDigestKey: new Uint8Array(32).fill(5),
      stageIdFactory: () => "relay-stage-client-1",
    });
    const prepared = await service.prepareSetup();
    const target = await service.configureTarget({ candidateId: prepared.candidates[0]!.candidateId });
    await service.arm(target.targetId);
    const handler = createVoiceRelayHttpHandler({
      service,
      authorize: (request, surface) => surface === "xr" && request.headers.get("x-xr-session") === "paired"
        ? { ownerId: "xr-session-paired" }
        : false,
      consumeDesktopHostAction: () => false,
    });
    const client = new VoiceRelayHttpClient({
      requestHeaders: () => ({ "x-xr-session": "paired" }),
      fetchImpl: (input, init) => handler.fetch(new Request(new URL(String(input), "http://127.0.0.1:8788"), init)),
    });

    await expect(client.inspect()).resolves.toMatchObject({ armed: true, phase: "ready" });
    const staged = await client.stage({ utteranceId: "utterance-client", text: "Build a bridge" });
    expect(native.sendCount).toBe(0);
    await expect(client.confirm(staged.stageId)).resolves.toMatchObject({ status: "sent" });
    expect(native.sendCount).toBe(1);

    native.setReply("Building the bridge…", "streaming");
    await expect(client.readReply(staged.stageId)).resolves.toMatchObject({
      phase: "streaming",
      sequence: 1,
      text: "Building the bridge…",
    });
    // The client acknowledges sequence 1 only after parsing it successfully.
    await expect(client.readReply(staged.stageId)).resolves.toEqual({
      stageId: staged.stageId,
      phase: "streaming",
      sequence: 1,
    });
    native.setReply("The bridge is ready.", "complete");
    await expect(client.readReply(staged.stageId)).resolves.toMatchObject({
      phase: "complete",
      sequence: 2,
      text: "The bridge is ready.",
    });
  });
});
