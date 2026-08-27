import type {
  AnonymousDiagnosticAdmission,
  AnonymousDiagnosticRateLimiter,
  DiagnosticTransportMetadata,
} from "./contracts";

/**
 * This is the only transport-identifying seam. It returns an anonymous
 * admission decision and deliberately drops both IP and User-Agent values.
 */
export async function admitAndDiscardDiagnosticTransportMetadata(
  metadata: DiagnosticTransportMetadata,
  rateLimiter: AnonymousDiagnosticRateLimiter,
  nowMs = Date.now(),
): Promise<AnonymousDiagnosticAdmission> {
  return rateLimiter.consume(metadata.ipAddress, nowMs);
}

function ephemeralHash(value: string, salt: number): number {
  let hash = 0x811c9dc5 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Process-local, window-scoped buckets: raw addresses and User-Agent are never retained. */
export class InMemoryAnonymousDiagnosticRateLimiter implements AnonymousDiagnosticRateLimiter {
  readonly #buckets = new Map<string, number>();
  readonly #salt = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  #activeWindow: number | undefined;

  constructor(
    readonly limit = 60,
    readonly windowMs = 60_000,
    readonly maximumBuckets = 10_000,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError("windowMs must be a positive integer");
    if (!Number.isSafeInteger(maximumBuckets) || maximumBuckets < 1 || maximumBuckets > 1_000_000) {
      throw new TypeError("maximumBuckets must be between 1 and 1000000");
    }
  }

  async consume(ipAddress: string | undefined, nowMs: number): Promise<AnonymousDiagnosticAdmission> {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError("nowMs must be a non-negative finite number");
    const window = Math.floor(nowMs / this.windowMs);
    if (this.#activeWindow !== window) {
      this.#buckets.clear();
      this.#activeWindow = window;
    }
    const source = ipAddress && ipAddress.length <= 128 ? ipAddress : "unknown";
    const key = `${window}:${ephemeralHash(source, this.#salt)}`;
    if (!this.#buckets.has(key) && this.#buckets.size >= this.maximumBuckets) {
      return Object.freeze({ allowed: false, retryAfterMs: (window + 1) * this.windowMs - nowMs });
    }
    const count = (this.#buckets.get(key) ?? 0) + 1;
    this.#buckets.set(key, count);
    if (count <= this.limit) return Object.freeze({ allowed: true });
    return Object.freeze({ allowed: false, retryAfterMs: (window + 1) * this.windowMs - nowMs });
  }
}
