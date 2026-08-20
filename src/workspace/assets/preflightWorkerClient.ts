import { deserializeRealityAssetError, RealityAssetError } from "./errors";
import { REALITY_ASSET_LIMITS } from "./limits";
import type { RealityAssetWorkerResponse } from "./preflightWorkerProtocol";
import type { RealityAssetCandidate } from "./types";
import { parseRealityAssetCandidate } from "./validation";

export type RealityAssetWorkerFactory = () => Worker;

export type PreflightRealityAssetInWorkerOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  workerFactory?: RealityAssetWorkerFactory;
}>;

let requestCursor = 0;

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./preflight.worker.ts", import.meta.url), {
    type: "module",
    name: "semaframe-reality-asset-preflight",
  });
}

function validatedTimeout(value: number | undefined): number {
  const timeout = value ?? REALITY_ASSET_LIMITS.defaultWorkerTimeoutMs;
  if (
    !Number.isSafeInteger(timeout)
    || timeout < 1
    || timeout > REALITY_ASSET_LIMITS.maximumWorkerTimeoutMs
  ) {
    throw new RealityAssetError(
      "invalid_descriptor",
      `timeoutMs must be an integer between 1 and ${REALITY_ASSET_LIMITS.maximumWorkerTimeoutMs}`,
    );
  }
  return timeout;
}

/**
 * Inspect one asset in a disposable Worker. Abort and timeout terminate the
 * Worker, providing a hard stop even during synchronous parsing or hashing.
 */
export function preflightRealityAssetInWorker(
  blob: Blob,
  options: PreflightRealityAssetInWorkerOptions = {},
): Promise<RealityAssetCandidate> {
  if (options.signal?.aborted) {
    return Promise.reject(new RealityAssetError("aborted", "Reality asset operation was cancelled"));
  }
  if (blob.size === 0) return Promise.reject(new RealityAssetError("empty_file", "Reality asset file is empty"));
  if (blob.size > REALITY_ASSET_LIMITS.maximumAssetBytes) {
    return Promise.reject(new RealityAssetError("file_too_large", "Reality asset exceeds its byte limit"));
  }
  let timeoutMs: number;
  try {
    timeoutMs = validatedTimeout(options.timeoutMs);
  } catch (error) {
    return Promise.reject(error);
  }
  const worker = (options.workerFactory ?? defaultWorkerFactory)();
  requestCursor += 1;
  const requestId = `reality_${requestCursor.toString(36)}`;
  return new Promise<RealityAssetCandidate>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new RealityAssetError("aborted", "Reality asset operation was cancelled")));
    const timer = setTimeout(() => finish(() => reject(new RealityAssetError(
      "operation_timeout",
      `Reality asset Worker exceeded its ${timeoutMs} ms time limit`,
    ))), timeoutMs);
    worker.onmessage = (event: MessageEvent<RealityAssetWorkerResponse>) => {
      const response = event.data;
      if (!response || response.requestId !== requestId) return;
      if (response.type === "reality-asset/result") {
        finish(() => {
          try {
            resolve(parseRealityAssetCandidate(response.candidate));
          } catch (error) {
            reject(error);
          }
        });
      } else if (response.type === "reality-asset/error") {
        finish(() => reject(deserializeRealityAssetError(response.error)));
      } else {
        finish(() => reject(new RealityAssetError("aborted", "Reality asset operation was cancelled")));
      }
    };
    worker.onerror = (event) => finish(() => reject(new RealityAssetError(
      "invalid_format",
      event.message ? "Reality asset Worker crashed" : "Reality asset Worker failed",
    )));
    worker.onmessageerror = () => finish(() => reject(new RealityAssetError(
      "invalid_format",
      "Reality asset Worker returned an unreadable result",
    )));
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      worker.postMessage(Object.freeze({ type: "reality-asset/inspect", requestId, blob }));
    } catch (error) {
      finish(() => reject(new RealityAssetError("invalid_format", "Could not send asset to Reality asset Worker", { cause: error })));
    }
  });
}
