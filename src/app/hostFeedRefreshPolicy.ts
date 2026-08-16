const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

/** Bounded exponential retry that never waits longer than the configured interval. */
export function hostFeedRetryDelayMs(intervalMs: number, failureCount: number): number {
  const safeInterval = Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.floor(intervalMs)
    : 30_000;
  const safeFailureCount = Number.isSafeInteger(failureCount) && failureCount > 0
    ? Math.min(failureCount, 30)
    : 1;
  const exponential = MIN_RETRY_MS * (2 ** Math.min(safeFailureCount - 1, 16));
  return Math.min(Math.max(MIN_RETRY_MS, exponential), safeInterval, MAX_RETRY_MS);
}

export function nextHostFeedRefreshDelayMs(input: Readonly<{
  now: number;
  intervalMs: number;
  retrievedAt?: string;
  nextRetryAt?: number;
}>): number {
  if (input.nextRetryAt !== undefined) return Math.max(0, input.nextRetryAt - input.now);
  const retrievedAt = input.retrievedAt ? Date.parse(input.retrievedAt) : Number.NaN;
  const elapsed = Number.isFinite(retrievedAt)
    ? Math.max(0, input.now - retrievedAt)
    : input.intervalMs;
  return Math.max(0, input.intervalMs - elapsed);
}
