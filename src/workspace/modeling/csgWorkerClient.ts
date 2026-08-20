import {
  CsgEvaluationError,
  type CsgEvaluationResult,
} from "./csgEvaluator";
import type { CsgDefinition } from "./csgTypes";
import type {
  CsgWorkerEvaluationOptions,
  CsgWorkerResponse,
} from "./csgWorker";

export const CSG_WORKER_LIMITS = Object.freeze({
  defaultTimeoutMs: 30_000,
  maximumTimeoutMs: 120_000,
});

export type CsgWorkerFactory = () => Worker;

export type EvaluateCsgInWorkerOptions = CsgWorkerEvaluationOptions & Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  workerFactory?: CsgWorkerFactory;
}>;

let requestCursor = 0;

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./csgKernel.worker.ts", import.meta.url), {
    type: "module",
    name: "semaframe-csg-kernel",
  });
}

function timeoutMs(value: number | undefined): number {
  const result = value ?? CSG_WORKER_LIMITS.defaultTimeoutMs;
  if (!Number.isSafeInteger(result) || result < 1 || result > CSG_WORKER_LIMITS.maximumTimeoutMs) {
    throw new CsgEvaluationError(
      "invalid_options",
      `timeoutMs must be an integer between 1 and ${CSG_WORKER_LIMITS.maximumTimeoutMs}`,
    );
  }
  return result;
}

function workerError(response: Extract<CsgWorkerResponse, { type: "csg/error" }>): Error {
  const knownCodes = new Set([
    "aborted",
    "invalid_options",
    "kernel_error",
    "mesh_limit_exceeded",
    "coordinate_limit_exceeded",
    "operation_timeout",
  ]);
  if (knownCodes.has(response.error.code)) {
    return new CsgEvaluationError(
      response.error.code as CsgEvaluationError["code"],
      response.error.message,
    );
  }
  const error = new Error(response.error.message);
  error.name = response.error.name || "CsgWorkerError";
  return error;
}

/**
 * Evaluate one bounded CSG definition in a disposable Worker. Aborts and time
 * limits terminate the Worker, providing a hard stop even during synchronous
 * WebAssembly work.
 */
export function evaluateCsgInWorker(
  definition: CsgDefinition,
  options: EvaluateCsgInWorkerOptions = {},
): Promise<CsgEvaluationResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new CsgEvaluationError("aborted", "CSG evaluation was cancelled"));
  }
  let allowedMs: number;
  try {
    allowedMs = timeoutMs(options.timeoutMs);
  } catch (error) {
    return Promise.reject(error);
  }
  const worker = (options.workerFactory ?? defaultWorkerFactory)();
  requestCursor += 1;
  const requestId = `csg_${requestCursor.toString(36)}`;

  return new Promise<CsgEvaluationResult>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new CsgEvaluationError(
      "aborted",
      "CSG evaluation was cancelled",
    )));
    const timer = setTimeout(() => finish(() => reject(new CsgEvaluationError(
      "operation_timeout",
      `CSG worker exceeded its ${allowedMs} ms time limit`,
    ))), allowedMs);

    worker.onmessage = (event: MessageEvent<CsgWorkerResponse>) => {
      const response = event.data;
      if (!response || response.requestId !== requestId) return;
      if (response.type === "csg/result") {
        finish(() => resolve(response.result));
      } else if (response.type === "csg/error") {
        finish(() => reject(workerError(response)));
      } else if (response.type === "csg/cancelled") {
        finish(() => reject(new CsgEvaluationError("aborted", "CSG evaluation was cancelled")));
      }
    };
    worker.onerror = (event) => finish(() => reject(new CsgEvaluationError(
      "kernel_error",
      event.message || "CSG worker crashed",
    )));
    worker.onmessageerror = () => finish(() => reject(new CsgEvaluationError(
      "kernel_error",
      "CSG worker returned an unreadable result",
    )));
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({
      type: "csg/evaluate",
      requestId,
      definition,
      options: {
        ...(options.circularSegments === undefined ? {} : { circularSegments: options.circularSegments }),
        ...(options.maxVertices === undefined ? {} : { maxVertices: options.maxVertices }),
        ...(options.maxTriangles === undefined ? {} : { maxTriangles: options.maxTriangles }),
      },
    });
  });
}
