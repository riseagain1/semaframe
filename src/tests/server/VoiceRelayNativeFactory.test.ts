import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createVoiceRelayNativeClient,
  defaultVoiceRelayHelperPath,
  VoiceRelayNativeFactoryError,
} from "../../../server/voice-relay";

describe("VoiceRelayNativeFactory", () => {
  it("requires an integrity-pinned, owned executable and completes its handshake", async () => {
    const expectedSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const client = await createVoiceRelayNativeClient({
      workspaceRoot: process.cwd(),
      platform: "darwin",
      helperPath: process.execPath,
      helperArgs: [resolve("src/tests/fixtures/voiceRelayNativeHelper.mjs")],
      expectedSha256,
      requestTimeoutMs: 2_000,
    });
    await expect(client.health()).resolves.toMatchObject({ platform: "mock", protocolVersion: 2 });
    await client.close();
  });

  it("fails closed without a packaged digest", async () => {
    await expect(createVoiceRelayNativeClient({
      workspaceRoot: process.cwd(),
      platform: "darwin",
      helperPath: process.execPath,
      helperArgs: [resolve("src/tests/fixtures/voiceRelayNativeHelper.mjs")],
    })).rejects.toBeInstanceOf(VoiceRelayNativeFactoryError);
  });

  it("resolves only explicit supported-platform package paths", () => {
    expect(defaultVoiceRelayHelperPath("/tmp/semaframe", "darwin"))
      .toBe("/tmp/semaframe/native/voice-relay/macos/build/SemaFrameVoiceRelayHelper");
    expect(defaultVoiceRelayHelperPath("/tmp/semaframe", "win32"))
      .toBe("/tmp/semaframe/native/voice-relay/windows/build/SemaFrameVoiceRelayHelper.exe");
    expect(() => defaultVoiceRelayHelperPath("/tmp/semaframe", "linux"))
      .toThrow(expect.objectContaining({ code: "unsupported_platform" }));
  });
});
