export type XrNetworkFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type XrNetworkTimerHandle = unknown;

export type XrNetworkTimers = Readonly<{
  setTimeout(callback: () => void, delayMs: number): XrNetworkTimerHandle;
  clearTimeout(handle: XrNetworkTimerHandle): void;
}>;

export type XrAssetDownloadProgress = Readonly<{
  receivedBytes: number;
  totalBytes: number;
  rangeStart: number;
  rangeEndExclusive: number;
  resumeCount: number;
  /** Largest single JS-visible response chunk retained during this transfer. */
  peakResponseChunkBytes: number;
}>;

export type XrHttpTransportBaseOptions = Readonly<{
  /** Canonical HTTP(S) origin only. Protocol paths are fixed and never caller-provided. */
  baseUrl: string | URL;
  fetch?: XrNetworkFetch;
  timers?: XrNetworkTimers;
  requestTimeoutMs?: number;
  maximumResponseBytes?: number;
  /** Bounded HTTP Range size used for immutable asset downloads. */
  assetRangeBytes?: number;
  /** Idle deadline reset whenever another response byte chunk arrives. */
  assetProgressTimeoutMs?: number;
  /** Additional range attempts after a retryable interruption. */
  assetMaximumRetries?: number;
  /** Upload timeout is scaled by bytes at no less than this throughput. */
  minimumAssetUploadBytesPerSecond?: number;
  onAssetDownloadProgress?: (progress: XrAssetDownloadProgress) => void;
}>;

export type XrViewerHttpTransportOptions = XrHttpTransportBaseOptions & Readonly<{
  pollIntervalMs?: number;
  pollBackoffBaseMs?: number;
  pollBackoffMaximumMs?: number;
  maximumPollFailures?: number;
  requestId?: () => string;
}>;

export class XrNetworkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XrNetworkError";
  }
}
