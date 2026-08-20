import { RealityAssetError, serializeRealityAssetError } from "./errors";
import { inspectRealityAsset } from "./inspectRealityAsset";
import type {
  RealityAssetWorkerInspectRequest,
  RealityAssetWorkerResponse,
} from "./preflightWorkerProtocol";

export type RealityAssetWorkerScope = Readonly<{
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: RealityAssetWorkerResponse): void;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export async function evaluateRealityAssetWorkerRequest(
  request: RealityAssetWorkerInspectRequest,
  signal?: AbortSignal,
): Promise<RealityAssetWorkerResponse> {
  const candidate = record(request);
  if (
    !candidate
    || candidate.type !== "reality-asset/inspect"
    || !validRequestId(candidate.requestId)
    || !(candidate.blob instanceof Blob)
    || !exactKeys(candidate, ["type", "requestId", "blob"])
  ) {
    throw new RealityAssetError("invalid_format", "Reality asset Worker request is invalid");
  }
  const inspected = await inspectRealityAsset(request.blob, { signal });
  return Object.freeze({ type: "reality-asset/result", requestId: request.requestId, candidate: inspected });
}

export function installRealityAssetWorkerHandler(scope: RealityAssetWorkerScope): () => void {
  const jobs = new Map<string, AbortController>();
  const onMessage = (event: MessageEvent<unknown>): void => {
    const request = record(event.data);
    if (!request || !validRequestId(request.requestId)) return;
    const requestId = request.requestId;
    if (request.type === "reality-asset/cancel") {
      if (!exactKeys(request, ["type", "requestId"])) return;
      jobs.get(requestId)?.abort();
      jobs.delete(requestId);
      scope.postMessage(Object.freeze({ type: "reality-asset/cancelled", requestId }));
      return;
    }
    if (request.type !== "reality-asset/inspect") return;
    if (jobs.has(requestId)) {
      scope.postMessage(Object.freeze({
        type: "reality-asset/error",
        requestId,
        error: serializeRealityAssetError(new RealityAssetError("invalid_format", "Duplicate Reality asset Worker request")),
      }));
      return;
    }
    const controller = new AbortController();
    jobs.set(requestId, controller);
    void evaluateRealityAssetWorkerRequest(request as unknown as RealityAssetWorkerInspectRequest, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) scope.postMessage(response);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          scope.postMessage(Object.freeze({
            type: "reality-asset/error",
            requestId,
            error: serializeRealityAssetError(error),
          }));
        }
      })
      .finally(() => jobs.delete(requestId));
  };
  scope.addEventListener("message", onMessage);
  return () => {
    scope.removeEventListener("message", onMessage);
    for (const controller of jobs.values()) controller.abort();
    jobs.clear();
  };
}
