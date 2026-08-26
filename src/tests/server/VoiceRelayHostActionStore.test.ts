import { describe, expect, it } from "vitest";
import { VoiceRelayHostActionStore } from "../../../server/voice-relay/VoiceRelayHostActionStore";

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);

describe("VoiceRelayHostActionStore", () => {
  it("mints action-bound one-shot grants", () => {
    const store = new VoiceRelayHostActionStore({ now: () => 1_000, tokenFactory: () => TOKEN_A });
    expect(store.mint("voice_relay_arm")).toEqual({ token: TOKEN_A, expiresAtMs: 31_000 });
    expect(store.consume(TOKEN_A, "voice_relay_arm")).toBe(true);
    expect(store.consume(TOKEN_A, "voice_relay_arm")).toBe(false);
  });

  it("invalidates a recognized token used for the wrong action", () => {
    const store = new VoiceRelayHostActionStore({ now: () => 1_000, tokenFactory: () => TOKEN_B });
    store.mint("voice_relay_draft_round_trip");
    expect(store.consume(TOKEN_B, "voice_relay_arm")).toBe(false);
    expect(store.consume(TOKEN_B, "voice_relay_draft_round_trip")).toBe(false);
  });

  it("supports a separate one-shot grant for exact target configuration", () => {
    const store = new VoiceRelayHostActionStore({ now: () => 1_000, tokenFactory: () => TOKEN_A });
    expect(store.mint("voice_relay_configure_target")).toEqual({ token: TOKEN_A, expiresAtMs: 31_000 });
    expect(store.consume(TOKEN_A, "voice_relay_draft_round_trip")).toBe(false);
    expect(store.consume(TOKEN_A, "voice_relay_configure_target")).toBe(false);

    store.mint("voice_relay_configure_target");
    expect(store.consume(TOKEN_A, "voice_relay_configure_target")).toBe(true);
  });

  it("rejects expired and malformed grants", () => {
    let now = 1_000;
    const store = new VoiceRelayHostActionStore({ now: () => now, tokenFactory: () => TOKEN_A, ttlMs: 5 });
    store.mint("voice_relay_arm");
    now = 1_005;
    expect(store.consume(TOKEN_A, "voice_relay_arm")).toBe(false);
    expect(store.consume("not-a-token", "voice_relay_arm")).toBe(false);
  });
});
