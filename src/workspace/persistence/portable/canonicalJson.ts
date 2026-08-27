import { PortableProjectError } from "./errors";

function canonicalValue(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PortableProjectError("invalid_manifest", "Portable manifest numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) {
      throw new PortableProjectError("invalid_manifest", "Portable manifest cannot contain cycles");
    }
    stack.add(value);
    const serialized = `[${value.map((item) => canonicalValue(item, stack)).join(",")}]`;
    stack.delete(value);
    return serialized;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (stack.has(object)) {
      throw new PortableProjectError("invalid_manifest", "Portable manifest cannot contain cycles");
    }
    stack.add(object);
    const parts = Object.keys(object).sort().map((key) => {
      const item = object[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new PortableProjectError("invalid_manifest", `Portable manifest field ${key} is not JSON`);
      }
      return `${JSON.stringify(key)}:${canonicalValue(item, stack)}`;
    });
    stack.delete(object);
    return `{${parts.join(",")}}`;
  }
  throw new PortableProjectError("invalid_manifest", "Portable manifest contains a non-JSON value");
}

/** Stable UTF-8 source form used for manifest identity and deterministic ZIPs. */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set<object>());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}
