import {
  XrNetworkError,
  type XrAssetDownloadProgress,
  type XrHttpTransportBaseOptions,
  type XrNetworkFetch,
  type XrNetworkTimerHandle,
  type XrNetworkTimers,
} from "./contracts";
import {
  XR_HTTP_SESSION_HEADER,
  type XrHttpPath,
} from "./paths";
import {
  XR_ASSET_HTTP_COLLECTION_PATH,
  XR_ASSET_HTTP_DIGEST_HEADER,
  XR_ASSET_HTTP_FORMAT_HEADER,
  XR_ASSET_HTTP_LENGTH_HEADER,
  XR_ASSET_HTTP_TTL_HEADER,
} from "../assets/http";
import {
  XR_ASSET_RUNTIME_LIMITS,
  type XrAssetDigest,
  type XrAssetFormat,
  type XrAssetMediaType,
} from "../assets/contracts";
import { XR_PROTOCOL_LIMITS } from "../protocol";
import {
  parseHttpEnvelope,
  strictResponse,
  type XrPrivateCredential,
} from "./validation";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAXIMUM_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = XR_PROTOCOL_LIMITS.maximumControlResponseBytes;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024 * 1024;
const MINIMUM_ASSET_RANGE_BYTES = 64 * 1024;
const MAXIMUM_ASSET_RANGE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ASSET_PROGRESS_TIMEOUT_MS = 120_000;
const MAXIMUM_ASSET_RETRIES = 8;
const MINIMUM_UPLOAD_BYTES_PER_SECOND = 64 * 1024;
const MAXIMUM_UPLOAD_BYTES_PER_SECOND = 1024 * 1024 * 1024;

const DEFAULT_TIMERS: XrNetworkTimers = Object.freeze({
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

class XrOperationAborted extends Error {}

type OperationContext = Readonly<{
  signal: AbortSignal;
  race<T>(promise: Promise<T>): Promise<T>;
  timedOut(): boolean;
  externallyAborted(): boolean;
  cleanup(): void;
}>;

type ProgressOperationContext = OperationContext & Readonly<{
  progress(): void;
}>;

function checkedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return result;
}

function checkedIntegerBetween(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

function canonicalOrigin(input: string | URL): string {
  let url: URL;
  try {
    url = new URL(input.toString());
  } catch {
    throw new TypeError("baseUrl must be a canonical HTTP(S) origin.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== "") {
    throw new TypeError("baseUrl must be a canonical HTTP(S) origin.");
  }
  return url.origin;
}

function checkedFetch(value: XrNetworkFetch | undefined): XrNetworkFetch {
  const implementation = value ?? globalThis.fetch?.bind(globalThis);
  if (typeof implementation !== "function") throw new TypeError("A Fetch implementation is required.");
  return implementation;
}

function checkedTimers(value: XrNetworkTimers | undefined): XrNetworkTimers {
  const timers = value ?? DEFAULT_TIMERS;
  if (typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function") {
    throw new TypeError("timers must provide setTimeout and clearTimeout.");
  }
  return timers;
}

function operation(
  timers: XrNetworkTimers,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): OperationContext {
  if (externalSignal?.aborted) {
    throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
  }
  const controller = new AbortController();
  let timeoutReached = false;
  let externalReached = false;
  const externalAbort = () => {
    externalReached = true;
    controller.abort();
  };
  externalSignal?.addEventListener("abort", externalAbort, { once: true });
  const timeoutHandle = timers.setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new XrOperationAborted()), { once: true });
  });
  return Object.freeze({
    signal: controller.signal,
    race<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, aborted]);
    },
    timedOut: () => timeoutReached,
    externallyAborted: () => externalReached,
    cleanup() {
      timers.clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener("abort", externalAbort);
    },
  });
}

function progressOperation(
  timers: XrNetworkTimers,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): ProgressOperationContext {
  if (externalSignal?.aborted) {
    throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
  }
  const controller = new AbortController();
  let timeoutReached = false;
  let externalReached = false;
  let timeoutHandle: XrNetworkTimerHandle | undefined;
  const arm = () => {
    if (timeoutHandle !== undefined) timers.clearTimeout(timeoutHandle);
    timeoutHandle = timers.setTimeout(() => {
      timeoutReached = true;
      controller.abort();
    }, timeoutMs);
  };
  const externalAbort = () => {
    externalReached = true;
    controller.abort();
  };
  externalSignal?.addEventListener("abort", externalAbort, { once: true });
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new XrOperationAborted()), { once: true });
  });
  arm();
  return Object.freeze({
    signal: controller.signal,
    race<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, aborted]);
    },
    progress: arm,
    timedOut: () => timeoutReached,
    externallyAborted: () => externalReached,
    cleanup() {
      if (timeoutHandle !== undefined) timers.clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
      externalSignal?.removeEventListener("abort", externalAbort);
    },
  });
}

async function readResponseJson(
  response: Response,
  maximumBytes: number,
  context: OperationContext,
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new XrNetworkError("invalid_response", "The XR relay returned an invalid response.", false);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(declared) || Number(declared) > maximumBytes) {
      throw new XrNetworkError("response_too_large", "The XR relay response is too large.", false);
    }
  }
  if (!response.body) {
    throw new XrNetworkError("invalid_response", "The XR relay returned an invalid response.", false);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await context.race(reader.read());
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new XrNetworkError("response_too_large", "The XR relay response is too large.", false);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof XrNetworkError || error instanceof XrOperationAborted) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    throw new XrNetworkError("invalid_response", "The XR relay returned an invalid response.", false);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation owns cleanup while an underlying read is still settling.
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new XrNetworkError("invalid_response", "The XR relay returned an invalid response.", false);
  }
}

type XrExpectedAsset = Readonly<{
  digest: XrAssetDigest;
  format: XrAssetFormat;
  mediaType: XrAssetMediaType;
  byteLength: number;
}>;

function assetHttpFailure(response: Response): XrNetworkError {
  if (response.status === 401) {
    return new XrNetworkError("unauthorized", "XR authentication failed.", false, 401);
  }
  if (response.status === 403) {
    return new XrNetworkError("forbidden", "The XR operation is not allowed.", false, 403);
  }
  if (response.status === 404) {
    return new XrNetworkError("asset_not_found", "The XR asset is unavailable.", false, 404);
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return new XrNetworkError(
      "asset_interrupted",
      "The XR asset transfer was interrupted.",
      true,
      response.status,
    );
  }
  return new XrNetworkError(
    "invalid_response",
    "The XR relay returned an invalid response.",
    false,
    response.status,
  );
}

function validAssetRangeResponse(
  response: Response,
  expected: XrExpectedAsset,
  start: number,
  endExclusive: number,
): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentRange = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/u.exec(
    response.headers.get("content-range") ?? "",
  );
  return response.status === 206
    && contentType === expected.mediaType
    && response.headers.get("accept-ranges") === "bytes"
    && response.headers.get("content-length") === String(endExclusive - start)
    && contentRange?.[1] === String(start)
    && contentRange[2] === String(endExclusive - 1)
    && contentRange[3] === String(expected.byteLength)
    && response.headers.get(XR_ASSET_HTTP_DIGEST_HEADER) === expected.digest
    && response.headers.get(XR_ASSET_HTTP_FORMAT_HEADER) === expected.format
    && response.headers.get(XR_ASSET_HTTP_LENGTH_HEADER) === String(expected.byteLength)
    && response.headers.get("etag") === `"${expected.digest}"`
    && response.body !== null;
}

export class XrHttpJsonClient {
  readonly #origin: string;
  readonly #fetch: XrNetworkFetch;
  readonly #timers: XrNetworkTimers;
  readonly #requestTimeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #assetRangeBytes: number;
  readonly #assetProgressTimeoutMs: number;
  readonly #assetMaximumRetries: number;
  readonly #minimumAssetUploadBytesPerSecond: number;
  readonly #onAssetDownloadProgress: ((progress: XrAssetDownloadProgress) => void) | undefined;

  constructor(options: XrHttpTransportBaseOptions) {
    this.#origin = canonicalOrigin(options.baseUrl);
    this.#fetch = checkedFetch(options.fetch);
    this.#timers = checkedTimers(options.timers);
    this.#requestTimeoutMs = checkedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MAXIMUM_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#maximumResponseBytes = checkedInteger(
      options.maximumResponseBytes,
      DEFAULT_MAXIMUM_RESPONSE_BYTES,
      MAXIMUM_RESPONSE_BYTES,
      "maximumResponseBytes",
    );
    this.#assetRangeBytes = checkedIntegerBetween(
      options.assetRangeBytes,
      XR_ASSET_RUNTIME_LIMITS.downloadRangeBytes,
      MINIMUM_ASSET_RANGE_BYTES,
      MAXIMUM_ASSET_RANGE_BYTES,
      "assetRangeBytes",
    );
    this.#assetProgressTimeoutMs = checkedInteger(
      options.assetProgressTimeoutMs,
      XR_ASSET_RUNTIME_LIMITS.downloadProgressTimeoutMs,
      MAXIMUM_ASSET_PROGRESS_TIMEOUT_MS,
      "assetProgressTimeoutMs",
    );
    this.#assetMaximumRetries = checkedIntegerBetween(
      options.assetMaximumRetries,
      XR_ASSET_RUNTIME_LIMITS.downloadMaximumRetries,
      0,
      MAXIMUM_ASSET_RETRIES,
      "assetMaximumRetries",
    );
    this.#minimumAssetUploadBytesPerSecond = checkedIntegerBetween(
      options.minimumAssetUploadBytesPerSecond,
      XR_ASSET_RUNTIME_LIMITS.minimumUploadBytesPerSecond,
      MINIMUM_UPLOAD_BYTES_PER_SECOND,
      MAXIMUM_UPLOAD_BYTES_PER_SECOND,
      "minimumAssetUploadBytesPerSecond",
    );
    if (options.onAssetDownloadProgress !== undefined
      && typeof options.onAssetDownloadProgress !== "function") {
      throw new TypeError("onAssetDownloadProgress must be a function.");
    }
    this.#onAssetDownloadProgress = options.onAssetDownloadProgress;
  }

  async post(
    path: XrHttpPath,
    body: unknown,
    credential?: XrPrivateCredential,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch {
      throw new XrNetworkError("invalid_request", "The XR request is invalid.", false);
    }
    const context = operation(this.#timers, this.#requestTimeoutMs, externalSignal);
    try {
      const headers = new Headers({ "content-type": "application/json" });
      if (credential) {
        headers.set("authorization", `Bearer ${credential.sessionBearer}`);
        headers.set(XR_HTTP_SESSION_HEADER, credential.sessionId);
      }
      const response = await context.race(this.#fetch(`${this.#origin}${path}`, {
        method: "POST",
        headers,
        body: serialized,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: context.signal,
      }));
      const value = await readResponseJson(response, this.#maximumResponseBytes, context);
      return strictResponse(() => parseHttpEnvelope(value, response.status));
    } catch (error) {
      if (error instanceof XrNetworkError) throw error;
      if (error instanceof XrOperationAborted || context.signal.aborted) {
        if (context.timedOut()) {
          throw new XrNetworkError("timeout", "The XR relay did not respond in time.", true);
        }
        if (context.externallyAborted()) {
          throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
        }
      }
      throw new XrNetworkError("network_unavailable", "The XR relay is temporarily unavailable.", true);
    } finally {
      serialized = "";
      context.cleanup();
    }
  }

  async getAsset(
    path: string,
    expected: XrExpectedAsset,
    credential: XrPrivateCredential,
    externalSignal?: AbortSignal,
  ): Promise<Blob> {
    if (!/^\/api\/xr\/v1\/assets\/sha256\/[a-f0-9]{64}$/u.test(path)) {
      throw new XrNetworkError("invalid_request", "The XR asset request is invalid.", false);
    }
    return this.#getAssetByRanges(path, expected, credential, externalSignal);
  }

  async #getAssetByRanges(
    path: string,
    expected: XrExpectedAsset,
    credential: XrPrivateCredential,
    externalSignal?: AbortSignal,
  ): Promise<Blob> {
    if (externalSignal?.aborted) {
      throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
    }
    let offset = 0;
    let rangeStart = 0;
    let rangeEndExclusive = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let attempt: ProgressOperationContext | undefined;
    let resumeCount = 0;
    let peakResponseChunkBytes = 0;
    const cleanupAttempt = async (cancel: boolean): Promise<void> => {
      const currentReader = reader;
      reader = undefined;
      // A broken Fetch/stream implementation may never settle cancel() after
      // its read was aborted. Cleanup must release our timers and allow the
      // bounded range retry to proceed independently of that foreign promise.
      if (cancel) void currentReader?.cancel().catch(() => undefined);
      try {
        currentReader?.releaseLock();
      } catch {
        // Cancellation can retain the lock until its read settles.
      }
      attempt?.cleanup();
      attempt = undefined;
    };

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (true) {
          if (externalSignal?.aborted) {
            await cleanupAttempt(true);
            throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
          }
          try {
            if (!reader) {
              rangeStart = offset;
              rangeEndExclusive = Math.min(expected.byteLength, offset + this.#assetRangeBytes);
              attempt = progressOperation(this.#timers, this.#assetProgressTimeoutMs, externalSignal);
              const response = await attempt.race(this.#fetch(`${this.#origin}${path}`, {
                method: "GET",
                headers: {
                  accept: expected.mediaType,
                  authorization: `Bearer ${credential.sessionBearer}`,
                  range: `bytes=${offset}-${rangeEndExclusive - 1}`,
                  [XR_HTTP_SESSION_HEADER]: credential.sessionId,
                },
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
                referrerPolicy: "no-referrer",
                signal: attempt.signal,
              }));
              if (!response.ok) throw assetHttpFailure(response);
              if (!validAssetRangeResponse(response, expected, offset, rangeEndExclusive)) {
                throw new XrNetworkError(
                  "invalid_response",
                  "The XR relay returned invalid asset range metadata.",
                  false,
                );
              }
              attempt.progress();
              reader = response.body!.getReader();
            }

            const result = await attempt!.race(reader.read());
            if (result.done) {
              if (offset !== rangeEndExclusive) {
                throw new XrNetworkError(
                  "asset_interrupted",
                  "The XR asset transfer ended before its declared range.",
                  true,
                );
              }
              await cleanupAttempt(false);
              if (offset === expected.byteLength) controller.close();
              return;
            }
            if (result.value.byteLength === 0) continue;
            if (result.value.byteLength > rangeEndExclusive - offset) {
              throw new XrNetworkError(
                "invalid_response",
                "The XR relay returned too many asset bytes.",
                false,
              );
            }
            offset += result.value.byteLength;
            peakResponseChunkBytes = Math.max(peakResponseChunkBytes, result.value.byteLength);
            attempt!.progress();
            try {
              this.#onAssetDownloadProgress?.(Object.freeze({
                receivedBytes: offset,
                totalBytes: expected.byteLength,
                rangeStart,
                rangeEndExclusive,
                resumeCount,
                peakResponseChunkBytes,
              }));
            } catch {
              // Diagnostics cannot break or retain a credentialed transfer.
            }
            controller.enqueue(result.value);
            return;
          } catch (cause) {
            const currentAttempt = attempt;
            let error: XrNetworkError;
            if (cause instanceof XrNetworkError) {
              error = cause;
            } else if (externalSignal?.aborted || currentAttempt?.externallyAborted()) {
              error = new XrNetworkError("aborted", "The XR request was cancelled.", false);
            } else if (cause instanceof XrOperationAborted || currentAttempt?.timedOut()) {
              error = new XrNetworkError(
                "timeout",
                "The XR asset transfer stopped making progress.",
                true,
              );
            } else {
              error = new XrNetworkError(
                "asset_interrupted",
                "The XR asset transfer was interrupted.",
                true,
              );
            }
            await cleanupAttempt(true);
            if (!error.retryable || resumeCount >= this.#assetMaximumRetries) throw error;
            resumeCount += 1;
          }
        }
      },
      cancel: async () => cleanupAttempt(true),
    });

    try {
      const blob = await new Response(stream, {
        headers: { "content-type": expected.mediaType },
      }).blob();
      if (blob.size !== expected.byteLength) {
        throw new XrNetworkError("invalid_response", "The XR relay returned invalid asset bytes.", false);
      }
      return blob;
    } catch (cause) {
      if (cause instanceof XrNetworkError) throw cause;
      if (externalSignal?.aborted) {
        throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
      }
      throw new XrNetworkError("asset_interrupted", "The XR asset transfer was interrupted.", true);
    } finally {
      await cleanupAttempt(true);
    }
  }

  /**
   * Checks immutable asset residency without exposing the retained credential
   * or downloading bytes. A scoped 404 is the only negative result; malformed
   * metadata and authorization failures remain hard errors.
   */
  async headAsset(
    path: string,
    expected: Readonly<{
      digest: XrAssetDigest;
      format: XrAssetFormat;
      mediaType: XrAssetMediaType;
      byteLength: number;
    }>,
    credential: XrPrivateCredential,
    externalSignal?: AbortSignal,
  ): Promise<boolean> {
    if (!/^\/api\/xr\/v1\/assets\/sha256\/[a-f0-9]{64}$/u.test(path)) {
      throw new XrNetworkError("invalid_request", "The XR asset request is invalid.", false);
    }
    const context = operation(this.#timers, this.#requestTimeoutMs, externalSignal);
    try {
      const response = await context.race(this.#fetch(`${this.#origin}${path}`, {
        method: "HEAD",
        headers: {
          accept: expected.mediaType,
          authorization: `Bearer ${credential.sessionBearer}`,
          [XR_HTTP_SESSION_HEADER]: credential.sessionId,
        },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: context.signal,
      }));
      if (response.status === 404) return false;
      if (!response.ok) {
        if (response.status === 401) {
          throw new XrNetworkError("unauthorized", "XR authentication failed.", false, 401);
        }
        if (response.status === 403) {
          throw new XrNetworkError("forbidden", "The XR operation is not allowed.", false, 403);
        }
        throw new XrNetworkError(
          "invalid_response",
          "The XR relay returned an invalid response.",
          response.status >= 500,
          response.status,
        );
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (response.status !== 200
        || contentType !== expected.mediaType
        || response.headers.get("content-length") !== String(expected.byteLength)
        || response.headers.get(XR_ASSET_HTTP_DIGEST_HEADER) !== expected.digest
        || response.headers.get(XR_ASSET_HTTP_FORMAT_HEADER) !== expected.format
        || response.headers.get(XR_ASSET_HTTP_LENGTH_HEADER) !== String(expected.byteLength)
        || response.headers.get("etag") !== `"${expected.digest}"`) {
        throw new XrNetworkError("invalid_response", "The XR relay returned invalid asset metadata.", false);
      }
      return true;
    } catch (error) {
      if (error instanceof XrNetworkError) throw error;
      if (error instanceof XrOperationAborted || context.signal.aborted) {
        if (context.timedOut()) {
          throw new XrNetworkError("timeout", "The XR relay did not respond in time.", true);
        }
        if (context.externallyAborted()) {
          throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
        }
      }
      throw new XrNetworkError("network_unavailable", "The XR relay is temporarily unavailable.", true);
    } finally {
      context.cleanup();
    }
  }

  async putAsset(
    blob: Blob,
    metadata: Readonly<{
      digest: XrAssetDigest;
      format: XrAssetFormat;
      mediaType: XrAssetMediaType;
      ttlMs: number;
    }>,
    credential: XrPrivateCredential,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const byteScaledTimeoutMs = Math.max(
      this.#requestTimeoutMs,
      this.#requestTimeoutMs + Math.ceil(
        (blob.size / this.#minimumAssetUploadBytesPerSecond) * 1_000,
      ),
    );
    const context = operation(this.#timers, byteScaledTimeoutMs, externalSignal);
    try {
      const response = await context.race(this.#fetch(
        `${this.#origin}${XR_ASSET_HTTP_COLLECTION_PATH}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${credential.sessionBearer}`,
            "content-type": metadata.mediaType,
            [XR_HTTP_SESSION_HEADER]: credential.sessionId,
            [XR_ASSET_HTTP_DIGEST_HEADER]: metadata.digest,
            [XR_ASSET_HTTP_FORMAT_HEADER]: metadata.format,
            [XR_ASSET_HTTP_LENGTH_HEADER]: String(blob.size),
            [XR_ASSET_HTTP_TTL_HEADER]: String(metadata.ttlMs),
          },
          body: blob,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: context.signal,
        },
      ));
      const value = await readResponseJson(response, this.#maximumResponseBytes, context);
      return strictResponse(() => parseHttpEnvelope(value, response.status));
    } catch (error) {
      if (error instanceof XrNetworkError) throw error;
      if (error instanceof XrOperationAborted || context.signal.aborted) {
        if (context.timedOut()) {
          throw new XrNetworkError("timeout", "The XR relay did not respond in time.", true);
        }
        if (context.externallyAborted()) {
          throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
        }
      }
      throw new XrNetworkError("network_unavailable", "The XR relay is temporarily unavailable.", true);
    } finally {
      context.cleanup();
    }
  }

  setTimer(callback: () => void, delayMs: number): XrNetworkTimerHandle {
    return this.#timers.setTimeout(callback, delayMs);
  }

  clearTimer(handle: XrNetworkTimerHandle): void {
    this.#timers.clearTimeout(handle);
  }

  delay(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new XrNetworkError("aborted", "The XR request was cancelled.", false));
    return new Promise<void>((resolve, reject) => {
      const handle = this.#timers.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delayMs);
      const abort = () => {
        this.#timers.clearTimeout(handle);
        reject(new XrNetworkError("aborted", "The XR request was cancelled.", false));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
