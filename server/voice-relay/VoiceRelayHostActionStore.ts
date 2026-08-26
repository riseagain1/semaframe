import { createHash, randomBytes } from "node:crypto";
import type { VoiceRelayDesktopHostAction } from "./VoiceRelayHttpAdapter";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAXIMUM_GRANTS = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type GrantRecord = Readonly<{
  action: VoiceRelayDesktopHostAction;
  expiresAtMs: number;
}>;

export type VoiceRelayHostActionGrant = Readonly<{
  token: string;
  expiresAtMs: number;
}>;

export type VoiceRelayHostActionStoreOptions = Readonly<{
  now?: () => number;
  tokenFactory?: () => string;
  ttlMs?: number;
  maximumGrants?: number;
}>;

function checkedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Volatile one-shot proof that a trusted desktop click confirmed a sensitive
 * Voice Relay action. Only its digest is retained and consumption is atomic.
 */
export class VoiceRelayHostActionStore {
  readonly #now: () => number;
  readonly #tokenFactory: () => string;
  readonly #ttlMs: number;
  readonly #maximumGrants: number;
  readonly #grants = new Map<string, GrantRecord>();

  constructor(options: VoiceRelayHostActionStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#ttlMs = checkedPositiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs", 120_000);
    this.#maximumGrants = checkedPositiveInteger(
      options.maximumGrants ?? DEFAULT_MAXIMUM_GRANTS,
      "maximumGrants",
      256,
    );
  }

  mint(action: VoiceRelayDesktopHostAction): VoiceRelayHostActionGrant {
    const now = this.#checkedNow();
    this.#prune(now);
    if (this.#grants.size >= this.#maximumGrants) {
      throw new Error("Too many Voice Relay host-action grants are pending.");
    }
    const token = this.#tokenFactory();
    if (!TOKEN_PATTERN.test(token) || Buffer.from(token, "base64url").byteLength !== 32) {
      throw new Error("Voice Relay host-action token generation failed.");
    }
    const digest = tokenDigest(token);
    if (this.#grants.has(digest)) throw new Error("Voice Relay host-action token generation collided.");
    const expiresAtMs = now + this.#ttlMs;
    this.#grants.set(digest, Object.freeze({ action, expiresAtMs }));
    return Object.freeze({ token, expiresAtMs });
  }

  consume(token: unknown, action: VoiceRelayDesktopHostAction): boolean {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
    const now = this.#checkedNow();
    const digest = tokenDigest(token);
    const grant = this.#grants.get(digest);
    // Any recognized proof is one-shot, even if it is replayed against the
    // wrong action or after expiry.
    if (grant) this.#grants.delete(digest);
    this.#prune(now);
    return Boolean(grant && grant.expiresAtMs > now && grant.action === action);
  }

  clear(): void {
    this.#grants.clear();
  }

  #checkedNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Voice Relay host-action clock is invalid.");
    return now;
  }

  #prune(now: number): void {
    for (const [digest, grant] of this.#grants) {
      if (grant.expiresAtMs <= now) this.#grants.delete(digest);
    }
  }
}
