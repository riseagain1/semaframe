export type ExtensionJsonPrimitive = string | number | boolean | null;
export type ExtensionJsonValue =
  | ExtensionJsonPrimitive
  | readonly ExtensionJsonValue[]
  | Readonly<{ [key: string]: ExtensionJsonValue }>;

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 100_000;

export class ExtensionJsonError extends Error {
  constructor(
    readonly code: "invalid_json" | "json_too_deep" | "json_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ExtensionJsonError";
  }
}

export type CanonicalJsonOptions = Readonly<{
  maxDepth?: number;
  maxNodes?: number;
}>;

export type BoundedCanonicalJsonOptions = CanonicalJsonOptions & Readonly<{
  maxBytes: number;
}>;

function assertSafeObject(value: object): asserts value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExtensionJsonError("invalid_json", "JSON objects must use a plain or null prototype.");
  }
}

/**
 * RFC 8785-style deterministic JSON for extension identity and evidence.
 * This deliberately accepts only JSON values, rejects cycles/non-finite
 * numbers, sorts object keys, and normalizes -0 through JSON.stringify.
 */
export function canonicalizeExtensionJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 256) {
    throw new RangeError("Canonical JSON maxDepth must be between 1 and 256.");
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1_000_000) {
    throw new RangeError("Canonical JSON maxNodes must be between 1 and 1000000.");
  }

  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new ExtensionJsonError("json_too_large", "JSON value exceeds its node limit.");
    }
    if (depth > maxDepth) {
      throw new ExtensionJsonError("json_too_deep", "JSON value exceeds its depth limit.");
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new ExtensionJsonError("invalid_json", "JSON numbers must be finite.");
      }
      return JSON.stringify(Object.is(candidate, -0) ? 0 : candidate);
    }
    if (typeof candidate !== "object") {
      throw new ExtensionJsonError("invalid_json", "Value is not JSON serializable.");
    }
    if (ancestors.has(candidate)) {
      throw new ExtensionJsonError("invalid_json", "JSON value contains a cycle.");
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return `[${candidate.map((entry) => visit(entry, depth + 1)).join(",")}]`;
      }
      assertSafeObject(candidate);
      const entries = Object.keys(candidate)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(candidate[key], depth + 1)}`);
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value, 0);
}

export function extensionJsonUtf8(value: unknown, options?: CanonicalJsonOptions): Uint8Array {
  return new TextEncoder().encode(canonicalizeExtensionJson(value, options));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256ExtensionBytes(bytes: Uint8Array): Promise<`sha256:${string}`> {
  if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) {
    throw new TypeError("SHA-256 input must be a Uint8Array.");
  }
  // Vitest/jsdom can expose Node's SubtleCrypto on a DOM realm whose typed
  // arrays are not accepted by Node 22's WebCrypto binding. A native Buffer is
  // the unambiguous Node BufferSource; browsers use a copy from their own
  // realm. Both branches own their bytes and reject SharedArrayBuffer aliasing.
  const nodeBuffer = (globalThis as typeof globalThis & {
    Buffer?: { from(value: Uint8Array): Uint8Array };
  }).Buffer;
  const input = nodeBuffer ? nodeBuffer.from(bytes) : Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function sha256ExtensionJson(value: unknown): Promise<`sha256:${string}`> {
  return sha256ExtensionBytes(extensionJsonUtf8(value));
}

export function extensionJsonByteLength(value: unknown): number {
  return extensionJsonUtf8(value).byteLength;
}

/**
 * Measures canonical JSON without first materializing the complete encoded
 * document. Individual strings are rejected by their UTF-16 length before
 * encoding when they cannot possibly fit, so an untrusted provider cannot
 * force a second unbounded output allocation merely to enforce a byte limit.
 */
export function boundedExtensionJsonByteLength(
  value: unknown,
  options: BoundedCanonicalJsonOptions,
): number {
  const { maxBytes } = options;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2_147_483_647) {
    throw new RangeError("Canonical JSON maxBytes must be between 1 and 2147483647.");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 256) {
    throw new RangeError("Canonical JSON maxDepth must be between 1 and 256.");
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1_000_000) {
    throw new RangeError("Canonical JSON maxNodes must be between 1 and 1000000.");
  }

  const encoder = new TextEncoder();
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const add = (amount: number): void => {
    if (amount > maxBytes - bytes) {
      throw new ExtensionJsonError("json_too_large", `JSON value exceeds its ${maxBytes}-byte limit.`);
    }
    bytes += amount;
  };
  const addEncoded = (text: string): void => {
    // JSON string encoding is never shorter in bytes than its input UTF-16
    // code-unit count. Avoid JSON.stringify/UTF-8 allocations that cannot fit.
    if (text.length > maxBytes - bytes) {
      throw new ExtensionJsonError("json_too_large", `JSON value exceeds its ${maxBytes}-byte limit.`);
    }
    add(encoder.encode(text).byteLength);
  };
  const addJsonString = (text: string): void => {
    if (text.length + 2 > maxBytes - bytes) {
      throw new ExtensionJsonError("json_too_large", `JSON value exceeds its ${maxBytes}-byte limit.`);
    }
    addEncoded(JSON.stringify(text));
  };
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new ExtensionJsonError("json_too_large", "JSON value exceeds its node limit.");
    }
    if (depth > maxDepth) {
      throw new ExtensionJsonError("json_too_deep", "JSON value exceeds its depth limit.");
    }
    if (candidate === null) {
      add(4);
      return;
    }
    if (typeof candidate === "boolean") {
      add(candidate ? 4 : 5);
      return;
    }
    if (typeof candidate === "string") {
      addJsonString(candidate);
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new ExtensionJsonError("invalid_json", "JSON numbers must be finite.");
      }
      addEncoded(JSON.stringify(Object.is(candidate, -0) ? 0 : candidate));
      return;
    }
    if (typeof candidate !== "object") {
      throw new ExtensionJsonError("invalid_json", "Value is not JSON serializable.");
    }
    if (ancestors.has(candidate)) {
      throw new ExtensionJsonError("invalid_json", "JSON value contains a cycle.");
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        add(1);
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) {
            throw new ExtensionJsonError("invalid_json", "Sparse arrays are not canonical JSON.");
          }
          if (index > 0) add(1);
          visit(candidate[index], depth + 1);
        }
        add(1);
        return;
      }
      assertSafeObject(candidate);
      add(1);
      const keys = Object.keys(candidate).sort();
      for (const [index, key] of keys.entries()) {
        if (index > 0) add(1);
        addJsonString(key);
        add(1);
        visit(candidate[key], depth + 1);
      }
      add(1);
    } finally {
      ancestors.delete(candidate);
    }
  };
  visit(value, 0);
  return bytes;
}

export function extensionJsonClone<T extends ExtensionJsonValue>(value: T): T {
  return JSON.parse(canonicalizeExtensionJson(value)) as T;
}
