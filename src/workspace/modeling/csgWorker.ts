import {
  CsgEvaluationError,
  evaluateCsg,
  type CsgEvaluationResult,
} from "./csgEvaluator";

export type CsgWorkerEvaluationOptions = Readonly<{
  circularSegments?: number;
  maxVertices?: number;
  maxTriangles?: number;
}>;

export type CsgWorkerEvaluateRequest = Readonly<{
  type: "csg/evaluate";
  requestId: string;
  definition: unknown;
  options?: CsgWorkerEvaluationOptions;
}>;

export type CsgWorkerCancelRequest = Readonly<{
  type: "csg/cancel";
  requestId: string;
}>;

export type CsgWorkerRequest = CsgWorkerEvaluateRequest | CsgWorkerCancelRequest;

export type CsgWorkerSuccessResponse = Readonly<{
  type: "csg/result";
  requestId: string;
  result: CsgEvaluationResult;
}>;

export type CsgWorkerErrorResponse = Readonly<{
  type: "csg/error";
  requestId: string;
  error: Readonly<{
    name: string;
    code: string;
    message: string;
  }>;
}>;

export type CsgWorkerCancelledResponse = Readonly<{
  type: "csg/cancelled";
  requestId: string;
}>;

export type CsgWorkerResponse =
  | CsgWorkerSuccessResponse
  | CsgWorkerErrorResponse
  | CsgWorkerCancelledResponse;

export type CsgWorkerScope = Readonly<{
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: CsgWorkerResponse, transfer?: Transferable[]): void;
}>;

function validRequestId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function requestRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new CsgEvaluationError(
      "invalid_options",
      `${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

function errorResponse(requestId: string, error: unknown): CsgWorkerErrorResponse {
  const known = error instanceof CsgEvaluationError;
  return Object.freeze({
    type: "csg/error",
    requestId,
    error: Object.freeze({
      name: error instanceof Error ? error.name : "Error",
      code: known ? error.code : "worker_error",
      message: error instanceof Error ? error.message : "Unknown CSG worker error",
    }),
  });
}

/**
 * Pure request evaluator used by a dedicated Worker host. Callers that require
 * hard cancellation can terminate the Worker; AbortSignal handles cooperative
 * cancellation before and during kernel-supported phases.
 */
export async function evaluateCsgWorkerRequest(
  request: CsgWorkerEvaluateRequest,
  signal?: AbortSignal,
): Promise<CsgWorkerSuccessResponse> {
  const candidate = requestRecord(request);
  if (!candidate || candidate.type !== "csg/evaluate") {
    throw new CsgEvaluationError("invalid_options", "Invalid CSG worker evaluate request");
  }
  assertExactKeys(candidate, ["type", "requestId", "definition", "options"], "CSG worker request");
  if (!validRequestId(request.requestId)) {
    throw new CsgEvaluationError("invalid_options", "Invalid CSG worker requestId");
  }
  if (request.options !== undefined) {
    const optionRecord = requestRecord(request.options);
    if (!optionRecord) {
      throw new CsgEvaluationError("invalid_options", "CSG worker options must be an object");
    }
    assertExactKeys(
      optionRecord,
      ["circularSegments", "maxVertices", "maxTriangles"],
      "CSG worker options",
    );
  }
  const result = await evaluateCsg(request.definition, {
    ...request.options,
    ...(signal ? { signal } : {}),
  });
  return Object.freeze({ type: "csg/result", requestId: request.requestId, result });
}

/**
 * Install a bounded message protocol into a Worker-like scope.
 * Returns a disposer so tests/hosts can remove the listener and cancel jobs.
 */
export function installCsgWorkerHandler(scope: CsgWorkerScope): () => void {
  const jobs = new Map<string, AbortController>();

  const onMessage = (event: MessageEvent<unknown>): void => {
    const candidate = requestRecord(event.data);
    if (!candidate || !validRequestId(candidate.requestId)) return;
    const requestId = candidate.requestId;

    if (candidate.type === "csg/cancel") {
      try {
        assertExactKeys(candidate, ["type", "requestId"], "CSG worker cancel request");
      } catch (error) {
        scope.postMessage(errorResponse(requestId, error));
        return;
      }
      const controller = jobs.get(requestId);
      controller?.abort();
      scope.postMessage(Object.freeze({ type: "csg/cancelled", requestId }));
      return;
    }
    if (candidate.type !== "csg/evaluate") return;
    if (jobs.has(requestId)) {
      scope.postMessage(errorResponse(
        requestId,
        new CsgEvaluationError("invalid_options", `Duplicate CSG requestId: ${requestId}`),
      ));
      return;
    }

    const controller = new AbortController();
    jobs.set(requestId, controller);
    void evaluateCsgWorkerRequest(candidate as CsgWorkerEvaluateRequest, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const positionBuffer = response.result.mesh.positions.buffer as ArrayBuffer;
        const indexBuffer = response.result.mesh.indices.buffer as ArrayBuffer;
        scope.postMessage(response, [positionBuffer, indexBuffer]);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        scope.postMessage(errorResponse(requestId, error));
      })
      .finally(() => {
        jobs.delete(requestId);
      });
  };

  scope.addEventListener("message", onMessage);
  return () => {
    scope.removeEventListener("message", onMessage);
    for (const controller of jobs.values()) controller.abort();
    jobs.clear();
  };
}
