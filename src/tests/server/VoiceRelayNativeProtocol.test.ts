import { describe, expect, it } from "vitest";
import {
  encodeVoiceRelayFrame,
  VoiceRelayFrameDecoder,
  VoiceRelayFrameError,
  VOICE_RELAY_MAXIMUM_FRAME_BYTES,
} from "../../../server/voice-relay";

describe("Voice Relay native framing", () => {
  it("decodes split and coalesced length-prefixed JSON frames", () => {
    const first = encodeVoiceRelayFrame({ id: 1, result: { ok: true } });
    const second = encodeVoiceRelayFrame({ id: 2, result: "done" });
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first);
    combined.set(second, first.length);
    const decoder = new VoiceRelayFrameDecoder();

    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    expect(decoder.push(combined.subarray(3, first.length + 2))).toEqual([{ id: 1, result: { ok: true } }]);
    expect(decoder.push(combined.subarray(first.length + 2))).toEqual([{ id: 2, result: "done" }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects oversized or partial frames", () => {
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(VOICE_RELAY_MAXIMUM_FRAME_BYTES + 1);
    expect(() => new VoiceRelayFrameDecoder().push(oversizedHeader)).toThrow(VoiceRelayFrameError);

    const decoder = new VoiceRelayFrameDecoder();
    decoder.push(encodeVoiceRelayFrame({ ok: true }).subarray(0, 6));
    expect(() => decoder.finish()).toThrow(expect.objectContaining({ code: "invalid_frame" }));
  });
});
