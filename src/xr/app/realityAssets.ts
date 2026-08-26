import { parseRealityAssetDescriptor } from "../../workspace/assets/validation";
import type { XrWorkspaceProjection } from "../authority";
import {
  BrowserXrAssetCache,
  createXrAssetDescriptor,
  parseXrAssetPerformanceBudget,
  selectXrAssetLodTier,
  type XrAssetFormat,
  type XrAssetPerformanceBudget,
  type XrAssetTierRejectionReason,
} from "../assets";
import type { XrViewerTransportSession } from "./contracts";

const XR_FORMAT_BY_HOST_FORMAT = Object.freeze({
  ply: "gaussian-ply",
  "spz-v4": "gaussian-spz-v4",
  "sog-v2": "gaussian-sog-v2",
} as const satisfies Readonly<Record<string, XrAssetFormat>>);

function abortError(): DOMException {
  return new DOMException("XR asset read was cancelled.", "AbortError");
}

export type XrViewerRealityAssetBudgetReason =
  | "format_unsupported"
  | "asset_bytes_exceeded"
  | "gpu_bytes_exceeded"
  | "splat_budget_exceeded"
  | "spherical_harmonics_unknown"
  | "spherical_harmonics_budget_exceeded";

export class XrViewerRealityAssetBudgetError extends Error {
  readonly code = "performance_budget_exceeded" as const;

  constructor(readonly reasons: readonly XrViewerRealityAssetBudgetReason[]) {
    super(`The RealityAsset exceeds the active XR performance budget (${reasons.join(", ")}).`);
    this.name = "XrViewerRealityAssetBudgetError";
  }
}

function enforceRealityAssetBudget(
  descriptor: ReturnType<typeof parseRealityAssetDescriptor>,
  format: XrAssetFormat,
  budgetValue: XrAssetPerformanceBudget,
): void {
  // Treat the render profile as an untyped trust-boundary value. A forged or
  // partially populated budget must not turn missing limits into permission.
  const budget = parseXrAssetPerformanceBudget(budgetValue);
  if (descriptor.sphericalHarmonicsDegree === null) {
    throw new XrViewerRealityAssetBudgetError(Object.freeze(["spherical_harmonics_unknown"]));
  }
  const coefficientCount = (descriptor.sphericalHarmonicsDegree + 1) ** 2;
  const bytesPerSplat = 48 + coefficientCount * 3 * 4;
  const estimatedGpuBytes = Math.max(
    descriptor.byteLength,
    Math.min(Number.MAX_SAFE_INTEGER, descriptor.splatCount * bytesPerSplat),
  );
  const selection = selectXrAssetLodTier({
    version: 1,
    modelId: descriptor.assetId,
    representation: "gaussian_splat",
    defaultTierId: descriptor.assetId,
    tiers: [{
      tierId: descriptor.assetId,
      quality: 1,
      digest: descriptor.digest,
      byteLength: descriptor.byteLength,
      estimatedGpuBytes,
      representation: "gaussian_splat",
      format,
      splatCount: descriptor.splatCount,
      sphericalHarmonicsDegree: descriptor.sphericalHarmonicsDegree,
    }],
  }, budget);
  const reasons = selection.status === "placeholder"
    ? selection.rejected.flatMap((entry) => entry.reasons)
    : [];
  if (reasons.length > 0) {
    throw new XrViewerRealityAssetBudgetError(Object.freeze(
      [...new Set(reasons)] as XrViewerRealityAssetBudgetReason[],
    ));
  }
}

/**
 * Resolves a renderer request only through a descriptor contained in the
 * currently validated authority projection. The session keeps its credential
 * private and receives immutable content identity instead of a URL.
 */
export async function openXrViewerRealityAsset(input: Readonly<{
  session: XrViewerTransportSession;
  projection: XrWorkspaceProjection;
  assetId: string;
  digest: string;
  budget: XrAssetPerformanceBudget;
  cache?: BrowserXrAssetCache;
  signal?: AbortSignal;
}>): Promise<Blob | undefined> {
  if (input.signal?.aborted) throw abortError();
  if (!Array.isArray(input.projection.realityAssets)) return undefined;

  const descriptors = input.projection.realityAssets.map((value) => parseRealityAssetDescriptor(value));
  const matches = descriptors.filter(({ assetId }) => assetId === input.assetId);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new Error("The XR projection contains an ambiguous RealityAsset identity.");

  const descriptor = matches[0];
  if (!descriptor || descriptor.digest !== input.digest) {
    throw new Error("The renderer RealityAsset reference does not match the authoritative digest.");
  }
  const format = XR_FORMAT_BY_HOST_FORMAT[descriptor.format];
  enforceRealityAssetBudget(descriptor, format, input.budget);
  const cached = input.cache?.readBlob({ digest: descriptor.digest });
  if (cached) {
    if (cached.descriptor.format === format
      && cached.descriptor.byteLength === descriptor.byteLength) {
      return cached.blob;
    }
    input.cache?.delete(descriptor.digest);
  }
  if (!input.session.openAsset) return undefined;

  const blob = await input.session.openAsset(
    descriptor.digest,
    format,
    descriptor.byteLength,
    input.signal,
  );
  if (input.signal?.aborted) throw abortError();
  if (!(blob instanceof Blob) || blob.size !== descriptor.byteLength) {
    throw new Error("The XR asset response does not match the authoritative byte length.");
  }
  if (input.cache) {
    const xrDescriptor = createXrAssetDescriptor({
      digest: descriptor.digest,
      format,
      byteLength: descriptor.byteLength,
    });
    const stored = await input.cache.putBlob(xrDescriptor, blob, input.signal);
    if (stored.cached) {
      const retained = input.cache.readBlob({ digest: descriptor.digest });
      if (!retained) throw new Error("The XR asset cache lost a verified entry before use.");
      return retained.blob;
    }
  }
  return blob;
}

type XrViewerRealityRuntimeInput = Omit<
  Parameters<typeof openXrViewerRealityAsset>[0],
  "cache" | "signal"
> & Readonly<{ signal?: AbortSignal }>;

function waitForAsset<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (cause: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(cause);
    });
  });
}

/** Session-scoped cache plus single-flight loader used by the live viewer. */
export class XrViewerRealityAssetRuntime {
  readonly #cache: BrowserXrAssetCache;
  readonly #inflight = new Map<string, Readonly<{
    abort: AbortController;
    promise: Promise<Blob | undefined>;
  }>>();

  constructor(cache = new BrowserXrAssetCache()) {
    this.#cache = cache;
  }

  open(input: XrViewerRealityRuntimeInput): Promise<Blob | undefined> {
    if (input.signal?.aborted) return Promise.reject(abortError());
    const key = [
      input.session.identity.workspaceId,
      input.session.identity.authorityEpoch,
      input.assetId,
      input.digest,
      input.budget.maximumAssetBytes,
      input.budget.maximumSplats,
    ].join("|");
    let flight = this.#inflight.get(key);
    if (!flight) {
      const abort = new AbortController();
      const promise = openXrViewerRealityAsset({
        session: input.session,
        projection: input.projection,
        assetId: input.assetId,
        digest: input.digest,
        budget: input.budget,
        cache: this.#cache,
        signal: abort.signal,
      }).finally(() => {
        if (this.#inflight.get(key)?.promise === promise) this.#inflight.delete(key);
      });
      flight = Object.freeze({ abort, promise });
      this.#inflight.set(key, flight);
    }
    return waitForAsset(flight.promise, input.signal);
  }

  clear(): void {
    for (const flight of this.#inflight.values()) flight.abort.abort("asset_runtime_cleared");
    this.#inflight.clear();
    this.#cache.clear();
  }

  stats(): ReturnType<BrowserXrAssetCache["stats"]> {
    return this.#cache.stats();
  }
}
