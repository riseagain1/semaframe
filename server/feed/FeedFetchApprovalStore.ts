import { createHash, randomBytes } from "node:crypto";
import {
  normalizeFeedFetchRequest,
  type FeedFetchRequest,
  type FeedFormat,
} from "./FeedFetchRuntime";

const DEFAULT_APPROVAL_TTL_MS = 30_000;
const DEFAULT_MAX_APPROVALS = 128;
const APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export class FeedFetchApprovalError extends Error {
  constructor(
    readonly code:
      | "feed_approval_required"
      | "feed_approval_invalid"
      | "feed_approval_expired",
    message: string,
    readonly status: 403 | 409,
  ) {
    super(message);
    this.name = "FeedFetchApprovalError";
  }
}

export type FeedFetchApproval = Readonly<{
  version: 1;
  approvalToken: string;
  expiresAt: string;
  request: Readonly<{
    url: string;
    format: FeedFormat;
  }>;
}>;

type ApprovalEntry = Readonly<{
  url: string;
  format: FeedFormat;
  expiresAt: number;
}>;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Server-held protocol capability for one exact feed read.
 *
 * The token is short-lived, single-use, and bound to the canonical URL/format.
 * It keeps remote MCP/REST clients out of the feed execution path; it is not an
 * OS-level attestation against a malicious process that can impersonate the
 * browser's loopback HTTP traffic.
 */
export class FeedFetchApprovalStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxApprovals: number;
  readonly #entries = new Map<string, ApprovalEntry>();

  constructor(options: Readonly<{
    now?: () => number;
    ttlMs?: number;
    maxApprovals?: number;
  }> = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.#maxApprovals = options.maxApprovals ?? DEFAULT_MAX_APPROVALS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1_000 || this.#ttlMs > 5 * 60_000) {
      throw new RangeError("Feed approval ttlMs must be an integer between 1000 and 300000.");
    }
    if (!Number.isSafeInteger(this.#maxApprovals) || this.#maxApprovals < 1 || this.#maxApprovals > 1_024) {
      throw new RangeError("Feed approval maxApprovals must be an integer between 1 and 1024.");
    }
  }

  mint(input: FeedFetchRequest): FeedFetchApproval {
    const request = normalizeFeedFetchRequest(input);
    const now = this.#now();
    this.#prune(now);
    while (this.#entries.size >= this.#maxApprovals) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const approvalToken = randomBytes(32).toString("base64url");
    const expiresAt = now + this.#ttlMs;
    this.#entries.set(tokenHash(approvalToken), {
      url: request.url,
      format: request.format,
      expiresAt,
    });
    return Object.freeze({
      version: 1,
      approvalToken,
      expiresAt: new Date(expiresAt).toISOString(),
      request,
    });
  }

  consume(approvalToken: unknown, input: FeedFetchRequest): void {
    if (approvalToken === undefined) {
      throw new FeedFetchApprovalError(
        "feed_approval_required",
        "Preview this exact feed in the open app before fetching it.",
        403,
      );
    }
    if (typeof approvalToken !== "string" || !APPROVAL_TOKEN_PATTERN.test(approvalToken)) {
      throw new FeedFetchApprovalError(
        "feed_approval_invalid",
        "The feed approval is invalid or was already used.",
        403,
      );
    }
    const request = normalizeFeedFetchRequest(input);
    const key = tokenHash(approvalToken);
    const entry = this.#entries.get(key);
    if (!entry) {
      throw new FeedFetchApprovalError(
        "feed_approval_invalid",
        "The feed approval is invalid or was already used.",
        403,
      );
    }
    const now = this.#now();
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      throw new FeedFetchApprovalError(
        "feed_approval_expired",
        "The feed approval expired. Preview the feed again.",
        409,
      );
    }
    if (entry.url !== request.url || entry.format !== request.format) {
      throw new FeedFetchApprovalError(
        "feed_approval_invalid",
        "The feed approval does not match this URL and format.",
        403,
      );
    }

    // Consume before network execution. Upstream failure never makes an old
    // capability reusable; the user can mint a fresh approval by retrying.
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}
