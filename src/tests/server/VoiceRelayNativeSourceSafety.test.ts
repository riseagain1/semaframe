import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const macos = readFileSync(
  resolve("native/voice-relay/macos/SemaFrameVoiceRelayHelper.swift"),
  "utf8",
);
const windows = readFileSync(resolve("native/voice-relay/windows/Program.cs"), "utf8");
const client = readFileSync(resolve("server/voice-relay/VoiceRelayNativeClient.ts"), "utf8");

describe("Voice Relay native source safety invariants", () => {
  it.each([
    ["macOS", macos],
    ["Windows", windows],
  ])("pins a local composer/Send binding and generation on %s", (_platform, source) => {
    expect(source).toMatch(/interactionRoot/iu);
    expect(source).toMatch(/stableControlIdentity/iu);
    expect(source).toMatch(/targetGeneration/iu);
    expect(source).toMatch(/cleanupActiveDraftIfUnchanged/iu);
    expect(source).toMatch(/boundedTargetLabel/iu);
    expect(source).toMatch(/abort[_A-Z]?stage/iu);
    expect(source).toMatch(/expectedDraftDigest/iu);
    expect(source).toMatch(/ambiguityMargin/iu);
    expect(source).toMatch(/activeProbe/iu);
    expect(source).toMatch(/validateOwnedComposer/iu);
    expect(source).not.toMatch(/"send"\s*,\s*"submit"\s*,\s*"run"\s*,\s*"enter"/iu);
  });

  it("does not regress to broad window-prefix reply extraction", () => {
    expect(macos).toMatch(/responseSnapshot/iu);
    expect(macos).toMatch(/responseDelta/iu);
    expect(macos).toMatch(/retainedOrder/iu);
    expect(macos).not.toMatch(/private func replyRoot/iu);
    expect(macos).not.toMatch(/private func extractText/iu);

    expect(windows).toMatch(/ResponseSnapshot/iu);
    expect(windows).toMatch(/ResponseDeltaBetween/iu);
    expect(windows).toMatch(/retainedOrder/iu);
    expect(windows).not.toMatch(/private static string ExtractText/iu);
    expect(windows).not.toMatch(/current\.StartsWith\(observation\.Baseline/iu);
  });

  it("retains a cleanup opportunity across Windows framing failures", () => {
    expect(windows).toMatch(/finally\s*\{\s*runtime\.CleanupBeforeExit\(\)/isu);
    expect(windows).toMatch(/CleanupOwnedDraft/iu);
    expect(macos).toMatch(/cleanupOwnedDraft/iu);
    expect(windows).toMatch(/cleanupResolved/iu);
    expect(macos).toMatch(/cleanupResolved/iu);
    expect(windows).toMatch(/Disarm[\s\S]*cleanupResolved/iu);
    expect(macos).toMatch(/case "disarm"[\s\S]*cleanupResolved/iu);
    expect(macos).toMatch(/activeStage\s*=\s*ActiveStage[\s\S]{0,500}setStringValue\(profile\.composer,\s*text\)/u);
    expect(windows).toMatch(/_activeStage\s*=\s*new ActiveStage[\s\S]{0,500}WriteValue\(profile\.Composer,\s*text\)/u);
    expect(macos).not.toMatch(/self\.activeStage\s*=\s*nil\s*\n\s*guard validate\(profile\)/u);
    expect(windows).not.toMatch(/_activeStage\s*=\s*null;\s*\n\s*if \(!Validate\(profile\)\)/u);
  });

  it("waits for natural helper exit before the force-kill fallback", () => {
    expect(client).toMatch(/stdin\.end\(\)[\s\S]{0,500}#awaitExit\(NATURAL_EXIT_GRACE_MS\)/u);
    expect(client).toMatch(/if \(!exitedNaturally\)[\s\S]{0,500}#child\.kill\(\)/u);
    expect(client).toMatch(/helper_cleanup_unresolved/u);
  });

  it("keeps cleanup authority with the parent across console and broken-pipe signals", () => {
    expect(macos).toMatch(/signal\(SIGINT,\s*SIG_IGN\)/u);
    expect(macos).toMatch(/signal\(SIGTERM,\s*SIG_IGN\)/u);
    expect(macos).toMatch(/signal\(SIGPIPE,\s*SIG_IGN\)/u);
    expect(windows).toMatch(/Console\.CancelKeyPress[\s\S]*eventArgs\.Cancel\s*=\s*true/u);
  });
});
