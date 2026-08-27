import { canonicalizeExtensionJson, type ExtensionJsonValue } from "../../src/extensions";

export const EXTENSION_NATIVE_PROTOCOL = "semaframe.extension.native/1" as const;
export const DEFAULT_EXTENSION_MAX_FRAME_BYTES = 1024 * 1024;

export type ExtensionRpcErrorV1 = Readonly<{
  code: string;
  message: string;
}>;

export type ExtensionRpcRequestV1 = Readonly<{
  protocol: typeof EXTENSION_NATIVE_PROTOCOL;
  type: "request";
  id: string;
  capability: string;
  method: string;
  params: ExtensionJsonValue;
}>;

export type ExtensionRpcResponseV1 = Readonly<{
  protocol: typeof EXTENSION_NATIVE_PROTOCOL;
  type: "response";
  id: string;
  capability: string;
  result?: ExtensionJsonValue;
  error?: ExtensionRpcErrorV1;
}>;

export type ExtensionRpcNotificationV1 = Readonly<{
  protocol: typeof EXTENSION_NATIVE_PROTOCOL;
  type: "notification";
  capability: string;
  method: "cancel";
  params: Readonly<{ requestId: string }>;
}>;

export type ExtensionRpcMessageV1 = ExtensionRpcRequestV1 | ExtensionRpcResponseV1 | ExtensionRpcNotificationV1;

export class ExtensionNativeProtocolError extends Error {
  constructor(
    readonly code: "invalid_frame" | "frame_too_large" | "invalid_json" | "invalid_message",
    message: string,
  ) {
    super(message);
    this.name = "ExtensionNativeProtocolError";
  }
}

function exactObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionNativeProtocolError("invalid_message", `${label} must be an object.`);
  }
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) throw new ExtensionNativeProtocolError("invalid_message", `${label} contains unknown field ${extra}.`);
  return body;
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new ExtensionNativeProtocolError("invalid_message", `${label} is invalid.`);
  }
  return value;
}

function safeCapability(value: unknown): string {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ExtensionNativeProtocolError("invalid_message", "Extension RPC capability is invalid.");
  }
  return value;
}

function safeJson(value: unknown, label: string): ExtensionJsonValue {
  try {
    canonicalizeExtensionJson(value);
  } catch {
    throw new ExtensionNativeProtocolError("invalid_message", `${label} is not bounded JSON.`);
  }
  return value as ExtensionJsonValue;
}

export function parseExtensionRpcMessageV1(value: unknown): ExtensionRpcMessageV1 {
  const envelope = exactObject(
    value,
    ["protocol", "type", "id", "capability", "method", "params", "result", "error"],
    "Extension RPC message",
  );
  if (envelope.protocol !== EXTENSION_NATIVE_PROTOCOL) {
    throw new ExtensionNativeProtocolError("invalid_message", "Extension RPC protocol version is invalid.");
  }
  const capability = safeCapability(envelope.capability);
  if (envelope.type === "request") {
    if (envelope.result !== undefined || envelope.error !== undefined) {
      throw new ExtensionNativeProtocolError("invalid_message", "Extension RPC request is ambiguous.");
    }
    return Object.freeze({
      protocol: EXTENSION_NATIVE_PROTOCOL,
      type: "request",
      id: safeIdentifier(envelope.id, "Extension RPC request id"),
      capability,
      method: safeIdentifier(envelope.method, "Extension RPC method"),
      params: safeJson(envelope.params, "Extension RPC params"),
    });
  }
  if (envelope.type === "response") {
    if (envelope.method !== undefined || envelope.params !== undefined || envelope.id === undefined) {
      throw new ExtensionNativeProtocolError("invalid_message", "Extension RPC response envelope is invalid.");
    }
    const hasResult = Object.hasOwn(envelope, "result");
    const hasError = Object.hasOwn(envelope, "error");
    if (hasResult === hasError) {
      throw new ExtensionNativeProtocolError("invalid_message", "Extension RPC response must contain exactly one result or error.");
    }
    if (hasError) {
      const error = exactObject(envelope.error, ["code", "message"], "Extension RPC error");
      const code = safeIdentifier(error.code, "Extension RPC error code");
      if (typeof error.message !== "string" || error.message.length < 1 || error.message.length > 500
        || /[\u0000-\u001f\u007f]/u.test(error.message)) {
        throw new ExtensionNativeProtocolError("invalid_message", "Extension RPC error message is invalid.");
      }
      return Object.freeze({
        protocol: EXTENSION_NATIVE_PROTOCOL,
        type: "response",
        id: safeIdentifier(envelope.id, "Extension RPC response id"),
        capability,
        error: Object.freeze({ code, message: error.message }),
      });
    }
    return Object.freeze({
      protocol: EXTENSION_NATIVE_PROTOCOL,
      type: "response",
      id: safeIdentifier(envelope.id, "Extension RPC response id"),
      capability,
      result: safeJson(envelope.result, "Extension RPC result"),
    });
  }
  if (envelope.type === "notification") {
    if (envelope.id !== undefined || envelope.result !== undefined || envelope.error !== undefined || envelope.method !== "cancel") {
      throw new ExtensionNativeProtocolError("invalid_message", "Extension RPC notification envelope is invalid.");
    }
    const params = exactObject(envelope.params, ["requestId"], "Extension cancellation");
    return Object.freeze({
      protocol: EXTENSION_NATIVE_PROTOCOL,
      type: "notification",
      capability,
      method: "cancel",
      params: Object.freeze({ requestId: safeIdentifier(params.requestId, "Extension cancellation request id") }),
    });
  }
  throw new ExtensionNativeProtocolError("invalid_message", "Extension RPC message type is invalid.");
}

export function encodeExtensionRpcFrameV1(
  value: ExtensionRpcMessageV1,
  maxFrameBytes = DEFAULT_EXTENSION_MAX_FRAME_BYTES,
): Uint8Array {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 16 * 1024 * 1024) {
    throw new RangeError("Extension max frame bytes must be between 1024 and 16777216.");
  }
  const parsed = parseExtensionRpcMessageV1(value);
  const payload = Buffer.from(canonicalizeExtensionJson(parsed), "utf8");
  if (payload.byteLength < 2 || payload.byteLength > maxFrameBytes) {
    throw new ExtensionNativeProtocolError("frame_too_large", "Extension RPC frame exceeds its byte limit.");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.set(payload, 4);
  return frame;
}

export class ExtensionRpcFrameDecoderV1 {
  readonly #maxFrameBytes: number;
  #buffer = Buffer.alloc(0);

  constructor(maxFrameBytes = DEFAULT_EXTENSION_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 16 * 1024 * 1024) {
      throw new RangeError("Extension max frame bytes must be between 1024 and 16777216.");
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): readonly ExtensionRpcMessageV1[] {
    if (!ArrayBuffer.isView(chunk) || chunk.BYTES_PER_ELEMENT !== 1 || chunk.byteLength === 0) return [];
    const incoming = Buffer.from(chunk);
    const messages: ExtensionRpcMessageV1[] = [];
    let offset = 0;
    while (offset < incoming.byteLength) {
      if (this.#buffer.byteLength < 4) {
        const headerBytes = Math.min(4 - this.#buffer.byteLength, incoming.byteLength - offset);
        this.#buffer = Buffer.concat([this.#buffer, incoming.subarray(offset, offset + headerBytes)]);
        offset += headerBytes;
        if (this.#buffer.byteLength < 4) break;
      }
      const length = this.#buffer.readUInt32BE(0);
      if (length < 2 || length > this.#maxFrameBytes) {
        this.#buffer = Buffer.alloc(0);
        throw new ExtensionNativeProtocolError("invalid_frame", "Extension RPC frame length is invalid.");
      }
      const remainingBytes = length + 4 - this.#buffer.byteLength;
      const payloadBytes = Math.min(remainingBytes, incoming.byteLength - offset);
      if (payloadBytes > 0) {
        this.#buffer = Buffer.concat([this.#buffer, incoming.subarray(offset, offset + payloadBytes)]);
        offset += payloadBytes;
      }
      if (this.#buffer.byteLength < length + 4) break;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = Buffer.alloc(0);
      let value: unknown;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch {
        throw new ExtensionNativeProtocolError("invalid_json", "Extension RPC frame contains malformed JSON.");
      }
      messages.push(parseExtensionRpcMessageV1(value));
    }
    return messages;
  }

  finish(): void {
    if (this.#buffer.byteLength > 0) {
      this.#buffer = Buffer.alloc(0);
      throw new ExtensionNativeProtocolError("invalid_frame", "Extension process closed with a partial RPC frame.");
    }
  }
}
