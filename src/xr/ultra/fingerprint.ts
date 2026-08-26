import type { UltraFingerprint } from "./contracts";

function canonicalJsonValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Ultra fingerprint input contains a non-finite number");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Ultra fingerprint input contains a cycle");
    seen.add(value);
    const result = `[${value.map((entry) => canonicalJsonValue(entry, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Ultra fingerprint input contains a cycle");
    seen.add(value);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const fields = keys.map((key) => {
      const entry = record[key];
      if (entry === undefined) throw new TypeError("Ultra fingerprint input contains undefined");
      return `${JSON.stringify(key)}:${canonicalJsonValue(entry, seen)}`;
    });
    seen.delete(value);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("Ultra fingerprint input contains an unsupported value");
}

export function canonicalUltraJson(value: unknown): string {
  return canonicalJsonValue(value, new Set());
}

export async function fingerprintUltraValue(value: unknown): Promise<UltraFingerprint> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable; Ultra eligibility must remain locked");
  }
  const bytes = new TextEncoder().encode(canonicalUltraJson(value));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
