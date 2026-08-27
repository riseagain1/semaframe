import { stableStringify } from "../workspace/components/manifestDigest";

export function canonicalBridgeJson(value: unknown): string {
  return stableStringify(value);
}

export function bridgeJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalBridgeJson(value)}\n`);
}

export async function sha256BridgeBytes(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer));
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
