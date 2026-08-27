import { stableStringify } from "../workspace/components/manifestDigest";

export function canonicalBridgeJson(value: unknown): string {
  return stableStringify(value);
}

export function bridgeJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalBridgeJson(value)}\n`);
}

export async function sha256BridgeBytes(bytes: Uint8Array): Promise<`sha256:${string}`> {
  if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) {
    throw new TypeError("SHA-256 input must be a Uint8Array.");
  }
  // Node 22 WebCrypto rejects jsdom-realm typed arrays even though they are
  // valid BufferSources. Use a native Buffer in Node and an owned realm-local
  // copy in browsers so hashing is portable without retaining caller storage.
  const nodeBuffer = (globalThis as typeof globalThis & {
    Buffer?: { from(value: Uint8Array): Uint8Array };
  }).Buffer;
  const input = nodeBuffer ? nodeBuffer.from(bytes) : Uint8Array.from(bytes);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", input as BufferSource),
  );
  return `sha256:${[...digest].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

export async function sha256BridgeJson(value: unknown): Promise<`sha256:${string}`> {
  return sha256BridgeBytes(bridgeJsonBytes(value));
}

export function assertSafeExchangePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new TypeError(`Exchange path is unsafe: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`Exchange path is unsafe: ${path}`);
  }
}
