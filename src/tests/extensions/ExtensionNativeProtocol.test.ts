import { describe, expect, it } from "vitest";
import {
  encodeExtensionRpcFrameV1,
  EXTENSION_NATIVE_PROTOCOL,
  ExtensionRpcFrameDecoderV1,
  ExtensionNativeProtocolError,
  parseExtensionRpcMessageV1,
  type ExtensionRpcRequestV1,
} from "../../../server/extensions";

const capability = "a".repeat(43);

function request(id: string, text: string): ExtensionRpcRequestV1 {
  return {
    protocol: EXTENSION_NATIVE_PROTOCOL,
    type: "request",
    id,
    capability,
    method: "fixture.echo",
    params: { text },
  };
}

describe("Extension native protocol", () => {
  it("decodes fragmented frames and coalesced frames without retaining more than one bounded frame", () => {
    const first = encodeExtensionRpcFrameV1(request("h_1", "a".repeat(2_000)), 4_096);
    const second = encodeExtensionRpcFrameV1(request("h_2", "b".repeat(2_000)), 4_096);
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first, 0);
    combined.set(second, first.byteLength);
    const decoder = new ExtensionRpcFrameDecoderV1(4_096);
    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    const messages = decoder.push(combined.subarray(3));
    expect(messages.map((message) => message.type === "request" ? message.id : "other"))
      .toEqual(["h_1", "h_2"]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects unknown envelope fields and oversized output", () => {
    expect(() => parseExtensionRpcMessageV1({ ...request("h_1", "ok"), unexpected: true }))
      .toThrow(expect.objectContaining({ code: "invalid_message" }));
    expect(() => encodeExtensionRpcFrameV1(request("h_1", "x".repeat(5_000)), 4_096))
      .toThrow(ExtensionNativeProtocolError);
  });
});
