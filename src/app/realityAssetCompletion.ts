/**
 * Keeps a browser-authoritative Reality import retryable across an ambiguous
 * gateway acknowledgement. The local Vault + Workspace commit is already the
 * source of truth at this point; a lost HTTP response must not roll it back
 * after the gateway has consumed and deleted its staged bytes.
 */
export class RealityAssetCompletionLedger<T> {
  readonly #pending = new Map<string, Readonly<{ contextKey: string; value: T }>>();

  clear(): void {
    this.#pending.clear();
  }

  has(candidateHandle: string): boolean {
    return this.#pending.has(candidateHandle);
  }

  abandon(candidateHandle: string): void {
    this.#pending.delete(candidateHandle);
  }

  peek(candidateHandle: string, contextKey: string): T | undefined {
    const pending = this.#pending.get(candidateHandle);
    if (!pending) return undefined;
    if (pending.contextKey !== contextKey) {
      throw new Error("The pending Reality Asset completion belongs to a different Workspace generation.");
    }
    return pending.value;
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
    return value;
  }
}

function hasDefinitiveHttpStatus(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return typeof (error as { status?: unknown }).status === "number";
}
