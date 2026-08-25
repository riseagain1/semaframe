/**
 * Keeps a browser-authoritative Reality import retryable across an ambiguous
 * gateway acknowledgement. The local Vault + Workspace commit is already the
 * source of truth at this point; a lost HTTP response must not roll it back
 * after the gateway has consumed and deleted its staged bytes.
 */
export class RealityAssetCompletionLedger<T> {
  readonly #pending = new Map<string, Readonly<{ contextKey: string; value: T }>>();
  readonly #completed = new Map<string, Readonly<{ contextKey: string; value: T }>>();

  constructor(readonly maximumCompletedEntries = 64) {
    if (!Number.isSafeInteger(maximumCompletedEntries) || maximumCompletedEntries < 1) {
      throw new TypeError("maximumCompletedEntries must be a positive safe integer.");
    }
  }

  clear(): void {
    this.#pending.clear();
    this.#completed.clear();
  }

  has(candidateHandle: string): boolean {
    return this.#pending.has(candidateHandle);
  }

  abandon(candidateHandle: string): void {
    this.#pending.delete(candidateHandle);
    this.#completed.delete(candidateHandle);
  }

  peek(candidateHandle: string, contextKey: string): T | undefined {
    const pending = this.#pending.get(candidateHandle);
    if (!pending) return undefined;
    if (pending.contextKey !== contextKey) {
      throw new Error("The pending Reality Asset completion belongs to a different Workspace generation.");
    }
    return pending.value;
  }

  peekCompleted(candidateHandle: string, contextKey: string): T | undefined {
    const completed = this.#completed.get(candidateHandle);
    if (!completed) return undefined;
    if (completed.contextKey !== contextKey) {
      throw new Error("The completed Reality Asset belongs to a different Workspace generation.");
    }
    // Refresh insertion order so the bounded cache evicts the least recently
    // used completion when a long-running browser imports many assets.
    this.#completed.delete(candidateHandle);
    this.#completed.set(candidateHandle, completed);
    return completed.value;
  }

  async acknowledgeFirst(
    candidateHandle: string,
    contextKey: string,
    value: T,
    acknowledge: () => Promise<void>,
  ): Promise<T> {
    const existing = this.#pending.get(candidateHandle);
    if (existing && existing.contextKey !== contextKey) {
      throw new Error("The pending Reality Asset completion belongs to a different Workspace generation.");
    }
    if (existing) return this.acknowledgeRetry(candidateHandle, contextKey, acknowledge) as Promise<T>;
    this.#pending.set(candidateHandle, { contextKey, value });
    try {
      await acknowledge();
    } catch (error) {
      // A concrete HTTP response proves the gateway rejected the request before
      // returning success. Status-less transport, timeout, abort, and malformed
      // success responses are ambiguous and retain the deterministic local
      // result for an identical retry.
      if (hasDefinitiveHttpStatus(error)) this.#pending.delete(candidateHandle);
      throw error;
    }
    this.#pending.delete(candidateHandle);
    this.#rememberCompleted(candidateHandle, contextKey, value);
    return value;
  }

  async acknowledgeRetry(
    candidateHandle: string,
    contextKey: string,
    acknowledge: () => Promise<void>,
  ): Promise<T | undefined> {
    const value = this.peek(candidateHandle, contextKey);
    if (value === undefined) return undefined;
    // Completion is idempotent server-side. Once the browser's exact bytes and
    // descriptor are durable, retry acknowledgement is cleanup-only: a second
    // network failure must not make the completed local import unusable.
    await acknowledge().catch(() => undefined);
    this.#pending.delete(candidateHandle);
    this.#rememberCompleted(candidateHandle, contextKey, value);
    return value;
  }

  #rememberCompleted(candidateHandle: string, contextKey: string, value: T): void {
    this.#completed.delete(candidateHandle);
    this.#completed.set(candidateHandle, { contextKey, value });
    while (this.#completed.size > this.maximumCompletedEntries) {
      const oldest = this.#completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#completed.delete(oldest);
    }
  }
}

export type RealityAssetCompletionSource = "agent" | "photo-reconstruction";

export type RealityAssetCandidatePurpose = "generic_import" | "photo_reconstruction";

/**
 * Signals that a completion attempt was rejected without consuming its staged
 * candidate. The same owner may retry through the correct, purpose-bound path
 * until the gateway TTL expires.
 */
export class RetainedRealityAssetCandidateError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RetainedRealityAssetCandidateError";
  }
}

export class RealityAssetCandidatePurposeError extends RetainedRealityAssetCandidateError {
  readonly expectedPurpose: RealityAssetCandidatePurpose;
  readonly actualPurpose: RealityAssetCandidatePurpose;

  constructor(expectedPurpose: RealityAssetCandidatePurpose, actualPurpose: RealityAssetCandidatePurpose) {
    super(`This completion path requires a ${expectedPurpose} candidate; received ${actualPurpose}.`);
    this.name = "RealityAssetCandidatePurposeError";
    this.expectedPurpose = expectedPurpose;
    this.actualPurpose = actualPurpose;
  }
}

export function expectedRealityAssetCandidatePurpose(
  source: RealityAssetCompletionSource,
): RealityAssetCandidatePurpose {
  return source === "agent" ? "generic_import" : "photo_reconstruction";
}

/** Fail closed before a caller is allowed to open candidate bytes. */
export function assertRealityAssetCandidatePurpose(
  actualPurpose: RealityAssetCandidatePurpose,
  source: RealityAssetCompletionSource,
): void {
  const expectedPurpose = expectedRealityAssetCandidatePurpose(source);
  if (actualPurpose !== expectedPurpose) {
    throw new RealityAssetCandidatePurposeError(expectedPurpose, actualPurpose);
  }
}

export type TrackedPhotoReconstruction = Readonly<{
  jobId: string;
  workspaceId: string;
}>;

type CancelledPhotoReconstruction = TrackedPhotoReconstruction & Readonly<{
  status: string;
}>;

/**
 * Coalesces concurrent cancellation requests and accepts only an exact,
 * terminal confirmation. A rejection is forgotten so an explicit retry can
 * contact the gateway again; successful application state cleanup remains the
 * caller's responsibility.
 */
export class PhotoReconstructionCancellationTracker<Job extends CancelledPhotoReconstruction> {
  readonly #inFlight = new Map<string, Promise<Job>>();

  confirm(
    active: TrackedPhotoReconstruction,
    cancel: (active: TrackedPhotoReconstruction) => Promise<Job>,
  ): Promise<Job> {
    const key = `${active.workspaceId}\u0000${active.jobId}`;
    const existing = this.#inFlight.get(key);
    if (existing) return existing;

    let request!: Promise<Job>;
    request = Promise.resolve()
      .then(() => cancel(active))
      .then((job) => {
        if (job.jobId !== active.jobId || job.workspaceId !== active.workspaceId || job.status !== "cancelled") {
          throw new Error("Photo reconstruction cancellation was not confirmed for the tracked job.");
        }
        return job;
      })
      .finally(() => {
        if (this.#inFlight.get(key) === request) this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, request);
    return request;
  }
}

function hasDefinitiveHttpStatus(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return typeof (error as { status?: unknown }).status === "number";
}
