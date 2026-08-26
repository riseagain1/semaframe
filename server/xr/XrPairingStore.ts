import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import {
  parseXrOpaqueId,
  parseXrWorkspaceId,
} from "../../src/xr/protocol";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CODE_PATTERN = /^[0-9]{6}$/u;
const PAIRING_CODE_SPACE = 1_000_000;
const MAXIMUM_CODE_GENERATION_ATTEMPTS = 64;
const DEFAULT_PAIRING_TTL_MS = 2 * 60_000;
const MAXIMUM_PAIRING_TTL_MS = 10 * 60_000;
const DEFAULT_MAXIMUM_PAIRINGS = 128;

export type XrPairingGrant = Readonly<{
  pairingId: string;
  pairingToken: string;
  pairingCode: string;
  workspaceId: string;
  authorityEpoch: string;
  expiresAtMs: number;
}>;

export type XrConsumedPairing = Readonly<{
  pairingId: string;
  workspaceId: string;
  authorityEpoch: string;
  expiresAtMs: number;
}>;

type PairingRecord = {
  pairingId: string;
  tokenDigest: string;
  codeDigest: string;
  workspaceId: string;
  authorityEpoch: string;
  createdAtMs: number;
  expiresAtMs: number;
  state: "active" | "consumed" | "revoked";
};

export type XrPairingStoreOptions = Readonly<{
  now?: () => number;
  tokenFactory?: () => string;
  pairingCodeFactory?: () => string;
  idFactory?: () => string;
  defaultTtlMs?: number;
  maximumPairings?: number;
}>;

export class XrPairingError extends Error {
  constructor(
    readonly code:
      | "invalid_pairing_request"
      | "pairing_invalid"
      | "pairing_expired"
      | "pairing_consumed"
      | "pairing_revoked"
      | "pairing_capacity",
    message: string,
  ) {
    super(message);
    this.name = "XrPairingError";
  }
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new XrPairingError("invalid_pairing_request", "XR pairing input must be an object.");
  }
  const body = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedSet.has(key))) {
    throw new XrPairingError("invalid_pairing_request", "XR pairing input contains an unknown field.");
  }
  if (required.some((key) => !Object.hasOwn(body, key))) {
    throw new XrPairingError("invalid_pairing_request", "XR pairing input is missing a required field.");
  }
  return body;
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("XR pairing clock returned an invalid time.");
  return value;
}

function checkedTtl(value: unknown, fallback: number): number {
  const ttlMs = value === undefined ? fallback : value;
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs)
    || ttlMs < 1 || ttlMs > MAXIMUM_PAIRING_TTL_MS) {
    throw new XrPairingError(
      "invalid_pairing_request",
      `XR pairing ttlMs must be an integer between 1 and ${MAXIMUM_PAIRING_TTL_MS}.`,
    );
  }
  return ttlMs;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function codeDigest(code: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(code, "utf8").digest("hex");
}

function checkedToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new XrPairingError("pairing_invalid", "XR pairing capability is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new XrPairingError("pairing_invalid", "XR pairing capability is invalid.");
  }
  return value;
}

function checkedCode(value: unknown): string {
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    throw new XrPairingError("pairing_invalid", "XR pairing code is invalid.");
  }
  return value;
}

export class XrPairingStore {
  readonly #now: () => number;
  readonly #tokenFactory: () => string;
  readonly #pairingCodeFactory: () => string;
  readonly #idFactory: () => string;
  readonly #defaultTtlMs: number;
  readonly #maximumPairings: number;
  readonly #recordsById = new Map<string, PairingRecord>();
  readonly #pairingIdByTokenDigest = new Map<string, string>();
  readonly #pairingIdByCodeDigest = new Map<string, string>();
  readonly #codeDigestSecret = randomBytes(32);

  constructor(options: XrPairingStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#pairingCodeFactory = options.pairingCodeFactory
      ?? (() => randomInt(PAIRING_CODE_SPACE).toString().padStart(6, "0"));
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#defaultTtlMs = checkedTtl(options.defaultTtlMs, DEFAULT_PAIRING_TTL_MS);
    this.#maximumPairings = options.maximumPairings ?? DEFAULT_MAXIMUM_PAIRINGS;
    if (!Number.isSafeInteger(this.#maximumPairings) || this.#maximumPairings < 1 || this.#maximumPairings > 10_000) {
      throw new RangeError("XR maximumPairings must be an integer between 1 and 10000.");
    }
  }

  create(value: unknown): XrPairingGrant {
    const body = exactRecord(value, ["workspaceId", "authorityEpoch", "ttlMs"], ["workspaceId", "authorityEpoch"]);
    let workspaceId: string;
    let authorityEpoch: string;
    try {
      workspaceId = parseXrWorkspaceId(body.workspaceId, "$.workspaceId");
      authorityEpoch = parseXrOpaqueId(body.authorityEpoch, "$.authorityEpoch");
    } catch (cause) {
      throw new XrPairingError(
        "invalid_pairing_request",
        cause instanceof Error ? cause.message : "XR pairing identity is invalid.",
      );
    }
    const ttlMs = checkedTtl(body.ttlMs, this.#defaultTtlMs);
    const now = checkedNow(this.#now);
    this.#pruneExpired(now);
    if (this.#recordsById.size >= this.#maximumPairings) {
      throw new XrPairingError("pairing_capacity", "XR pairing capacity is exhausted.");
    }
    const pairingId = parseXrOpaqueId(this.#idFactory(), "$.pairingId");
    const pairingToken = checkedToken(this.#tokenFactory());
    const tokenHash = tokenDigest(pairingToken);
    if (this.#recordsById.has(pairingId) || this.#pairingIdByTokenDigest.has(tokenHash)) {
      throw new Error("XR pairing identity factory returned a duplicate value.");
    }
    let pairingCode: string | undefined;
    let codeHash: string | undefined;
    for (let attempt = 0; attempt < MAXIMUM_CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = checkedCode(this.#pairingCodeFactory());
      const candidateHash = codeDigest(candidate, this.#codeDigestSecret);
      if (this.#pairingIdByCodeDigest.has(candidateHash)) continue;
      pairingCode = candidate;
      codeHash = candidateHash;
      break;
    }
    if (pairingCode === undefined || codeHash === undefined) {
      throw new Error("XR pairing code factory could not produce a unique value.");
    }
    const expiresAtMs = now + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new Error("XR pairing expiry exceeded the safe integer range.");
    const record: PairingRecord = {
      pairingId,
      tokenDigest: tokenHash,
      codeDigest: codeHash,
      workspaceId,
      authorityEpoch,
      createdAtMs: now,
      expiresAtMs,
      state: "active",
    };
    this.#recordsById.set(pairingId, record);
    this.#pairingIdByTokenDigest.set(tokenHash, pairingId);
    this.#pairingIdByCodeDigest.set(codeHash, pairingId);
    return Object.freeze({ pairingId, pairingToken, pairingCode, workspaceId, authorityEpoch, expiresAtMs });
  }

  consumeToken(value: unknown): XrConsumedPairing {
    const token = checkedToken(value);
    return this.#consume(this.#pairingIdByTokenDigest.get(tokenDigest(token)));
  }

  consumeCode(value: unknown): XrConsumedPairing {
    const code = checkedCode(value);
    return this.#consume(this.#pairingIdByCodeDigest.get(codeDigest(code, this.#codeDigestSecret)));
  }

  #consume(id: string | undefined): XrConsumedPairing {
    const record = id ? this.#recordsById.get(id) : undefined;
    if (!record) throw new XrPairingError("pairing_invalid", "XR pairing capability is invalid.");
    const now = checkedNow(this.#now);
    if (record.state === "revoked") throw new XrPairingError("pairing_revoked", "XR pairing capability was revoked.");
    if (record.state === "consumed") throw new XrPairingError("pairing_consumed", "XR pairing capability was already used.");
    if (now >= record.expiresAtMs) {
      record.state = "revoked";
      throw new XrPairingError("pairing_expired", "XR pairing capability expired.");
    }
    record.state = "consumed";
    return Object.freeze({
      pairingId: record.pairingId,
      workspaceId: record.workspaceId,
      authorityEpoch: record.authorityEpoch,
      expiresAtMs: record.expiresAtMs,
    });
  }

  revoke(pairingIdValue: unknown): boolean {
    let pairingId: string;
    try {
      pairingId = parseXrOpaqueId(pairingIdValue, "$.pairingId");
    } catch (cause) {
      throw new XrPairingError(
        "invalid_pairing_request",
        cause instanceof Error ? cause.message : "XR pairing identifier is invalid.",
      );
    }
    const record = this.#recordsById.get(pairingId);
    if (!record || record.state === "revoked") return false;
    record.state = "revoked";
    return true;
  }

  revokeAuthorityEpoch(authorityEpochValue: unknown): readonly string[] {
    let authorityEpoch: string;
    try {
      authorityEpoch = parseXrOpaqueId(authorityEpochValue, "$.authorityEpoch");
    } catch (cause) {
      throw new XrPairingError(
        "invalid_pairing_request",
        cause instanceof Error ? cause.message : "XR authority epoch is invalid.",
      );
    }
    const revoked: string[] = [];
    for (const record of this.#recordsById.values()) {
      if (record.authorityEpoch !== authorityEpoch || record.state === "revoked") continue;
      record.state = "revoked";
      revoked.push(record.pairingId);
    }
    return Object.freeze(revoked);
  }

  get(pairingIdValue: unknown): Readonly<{
    pairingId: string;
    workspaceId: string;
    authorityEpoch: string;
    expiresAtMs: number;
    state: PairingRecord["state"] | "expired";
  }> | undefined {
    let pairingId: string;
    try {
      pairingId = parseXrOpaqueId(pairingIdValue, "$.pairingId");
    } catch {
      return undefined;
    }
    const record = this.#recordsById.get(pairingId);
    if (!record) return undefined;
    const state = record.state === "active" && checkedNow(this.#now) >= record.expiresAtMs
      ? "expired"
      : record.state;
    return Object.freeze({
      pairingId,
      workspaceId: record.workspaceId,
      authorityEpoch: record.authorityEpoch,
      expiresAtMs: record.expiresAtMs,
      state,
    });
  }

  #pruneExpired(now: number): void {
    for (const [pairingId, record] of this.#recordsById) {
      if (now < record.expiresAtMs) continue;
      this.#recordsById.delete(pairingId);
      this.#pairingIdByTokenDigest.delete(record.tokenDigest);
      this.#pairingIdByCodeDigest.delete(record.codeDigest);
    }
  }
}
