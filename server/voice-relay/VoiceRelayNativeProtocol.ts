export const VOICE_RELAY_MAXIMUM_FRAME_BYTES = 1024 * 1024;

export class VoiceRelayFrameError extends Error {
  constructor(readonly code: "frame_too_large" | "invalid_json" | "invalid_frame", message: string) {
    super(message);
    this.name = "VoiceRelayFrameError";
  }
}

export type VoiceRelayRpcRequest = Readonly<{
  jsonrpc: "2.0";
  id: number;
  capability: string;
  method: string;
  params: Record<string, unknown>;
}>;

export type VoiceRelayRpcResponse = Readonly<{
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: Readonly<{ code: string; message: string }>;
}>;

export function encodeVoiceRelayFrame(value: unknown): Uint8Array {
  let payload: Uint8Array;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw new VoiceRelayFrameError("invalid_json", "Voice Relay frame is not JSON serializable.");
  }
  if (payload.byteLength < 2 || payload.byteLength > VOICE_RELAY_MAXIMUM_FRAME_BYTES) {
    throw new VoiceRelayFrameError("frame_too_large", "Voice Relay frame exceeds its size boundary.");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.set(payload, 4);
  return frame;
}

export class VoiceRelayFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): readonly unknown[] {
    if (!ArrayBuffer.isView(chunk) || chunk.byteLength === 0) return [];
    if (this.#buffer.byteLength + chunk.byteLength > VOICE_RELAY_MAXIMUM_FRAME_BYTES + 4) {
      this.#buffer = Buffer.alloc(0);
      throw new VoiceRelayFrameError("frame_too_large", "Voice Relay input exceeded its bounded frame buffer.");
    }
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length < 2 || length > VOICE_RELAY_MAXIMUM_FRAME_BYTES) {
        this.#buffer = Buffer.alloc(0);
        throw new VoiceRelayFrameError("invalid_frame", "Voice Relay frame length is invalid.");
      }
      if (this.#buffer.byteLength < length + 4) break;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      try {
        values.push(JSON.parse(payload.toString("utf8")) as unknown);
      } catch {
        throw new VoiceRelayFrameError("invalid_json", "Voice Relay helper returned malformed JSON.");
      }
    }
    return values;
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) {
      this.#buffer = Buffer.alloc(0);
      throw new VoiceRelayFrameError("invalid_frame", "Voice Relay helper closed with a partial frame.");
    }
  }
}
