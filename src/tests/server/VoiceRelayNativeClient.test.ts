import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VoiceRelayNativeClient,
  VoiceRelayNativeClientError,
} from "../../../server/voice-relay";

describe("VoiceRelayNativeClient", () => {
  it("uses a private framed child-process channel with a capability handshake", async () => {
    const client = new VoiceRelayNativeClient({
      command: process.execPath,
      args: [resolve("src/tests/fixtures/voiceRelayNativeHelper.mjs")],
      requestTimeoutMs: 2_000,
    });
    await expect(client.health()).resolves.toEqual({
      protocolVersion: 2,
      platform: "mock",
      accessibility: "authorized",
    });
    await expect(client.prepareAccessibility()).resolves.toEqual({
      protocolVersion: 2,
      platform: "mock",
      accessibility: "authorized",
    });
    await client.close();
    await expect(client.health()).rejects.toBeInstanceOf(VoiceRelayNativeClientError);
  });

  it("refuses PATH lookup and shell command strings", () => {
    expect(() => new VoiceRelayNativeClient({ command: "helper --unsafe" }))
      .toThrow(expect.objectContaining({ code: "helper_unavailable" }));
  });

  it("surfaces a helper shutdown whose exact cleanup remains unresolved", async () => {
    const client = new VoiceRelayNativeClient({
      command: process.execPath,
      args: [resolve("src/tests/fixtures/voiceRelayNativeHelper.mjs"), "--unresolved-shutdown"],
      requestTimeoutMs: 2_000,
    });
    await expect(client.health()).resolves.toMatchObject({ accessibility: "authorized" });
    await expect(client.close()).rejects.toMatchObject({ code: "helper_cleanup_unresolved" });
  });

  it("owns an input-pipe EPIPE when the helper closes stdin after acknowledging shutdown", async () => {
    const client = new VoiceRelayNativeClient({
      command: process.execPath,
      args: [resolve("src/tests/fixtures/voiceRelayNativeHelper.mjs"), "--close-input-on-shutdown"],
      requestTimeoutMs: 2_000,
    });
    await expect(client.health()).resolves.toMatchObject({ accessibility: "authorized" });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("fails closed when disarm cannot prove exact draft cleanup", async () => {
    const client = new VoiceRelayNativeClient({
      command: process.execPath,
      args: [resolve("src/tests/fixtures/voiceRelayNativeHelper.mjs"), "--unresolved-disarm"],
      requestTimeoutMs: 2_000,
    });
    await expect(client.health()).resolves.toMatchObject({ accessibility: "authorized" });
    await expect(client.disarm()).rejects.toMatchObject({ code: "helper_cleanup_unresolved" });
    await client.close();
  });

  it("force-kills only after a non-exiting helper exhausts the natural-exit grace", async () => {
    const client = new VoiceRelayNativeClient({
      command: process.execPath,
      args: [resolve("src/tests/fixtures/voiceRelayNativeHelper.mjs"), "--hang-shutdown"],
      requestTimeoutMs: 2_000,
    });
    await expect(client.health()).resolves.toMatchObject({ accessibility: "authorized" });
    await expect(client.close()).rejects.toMatchObject({ code: "helper_cleanup_unresolved" });
  });

  it.each(["timeout", "abort"] as const)(
    "can issue an exact abort after a lost stage %s acknowledgement",
    async (interruption) => {
      const client = new VoiceRelayNativeClient({
        command: process.execPath,
        args: [resolve("src/tests/fixtures/voiceRelayNativeHelper.mjs")],
        requestTimeoutMs: interruption === "timeout" ? 100 : 2_000,
      });
      await expect(client.health()).resolves.toMatchObject({ accessibility: "authorized" });
      const text = `ambiguous stage ${interruption}`;
      const input = {
        targetId: "target-fixture",
        stageId: `stage-${interruption}`,
        text,
        expectedDraftDigest: createHash("sha256").update(text, "utf8").digest("hex"),
        targetGeneration: "generation-fixture",
      } as const;
      const controller = new AbortController();
      if (interruption === "abort") setTimeout(() => controller.abort(), 25);

      await expect(client.stageDraft(
        input,
        interruption === "abort" ? controller.signal : undefined,
      )).rejects.toMatchObject({
        code: interruption === "abort" ? "helper_request_aborted" : "helper_timeout",
      });
      await expect(client.abortStage(input)).resolves.toEqual({ outcome: "cancelled" });
      await expect(client.health()).resolves.toMatchObject({ accessibility: "authorized" });
      await client.close();
    },
  );
});
