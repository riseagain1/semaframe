import { describe, expect, it, vi } from "vitest";
import { assetIdFromDigest, type RealityAssetDescriptor } from "../../workspace/assets";
import { sha256DigestBytes } from "../../workspace/assets/digest";
import { toXrWorkspaceProjection } from "../../xr/authority";
import {
  openXrViewerRealityAsset,
  XrViewerRealityAssetBudgetError,
  type XrViewerTransportSession,
} from "../../xr/app";
import { BrowserXrAssetCache, type XrAssetPerformanceBudget } from "../../xr/assets";

const digest = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" as const;

function descriptor(
  format: RealityAssetDescriptor["format"] = "ply",
  overrides: Partial<RealityAssetDescriptor> = {},
): RealityAssetDescriptor {
  return {
    version: 1,
    assetId: assetIdFromDigest(digest),
    digest,
    format,
    formatVersion: format === "spz-v4" ? 4 : format === "sog-v2" ? 2 : 1,
    mediaType: format === "spz-v4"
      ? "application/x-spz"
      : format === "sog-v2" ? "model/vnd.sog" : "application/ply",
    byteLength: 3,
    splatCount: 1,
    sphericalHarmonicsDegree: 0,
    model: "gaussian-3d",
    antialiased: null,
    coordinateSystem: { system: "UNKNOWN", provenance: "unknown" },
    engineeringAuthority: "visual_only",
    ...overrides,
  };
}

function projection(
  format: RealityAssetDescriptor["format"] = "ply",
  overrides: Partial<RealityAssetDescriptor> = {},
) {
  return toXrWorkspaceProjection({
    workspaceId: "workspace-xr-assets",
    revision: 4,
    components: [],
    realityAssets: [descriptor(format, overrides)],
  });
}

function budget(overrides: Partial<XrAssetPerformanceBudget> = {}): XrAssetPerformanceBudget {
  return {
    version: 1,
    supportedFormats: ["gaussian-ply", "gaussian-spz-v4", "gaussian-sog-v2"],
    maximumAssetBytes: 32,
    maximumEstimatedGpuBytes: 1_024,
    maximumTriangles: 0,
    maximumTexturePixels: 0,
    maximumSplats: 16,
    maximumSphericalHarmonicsDegree: 4,
    ...overrides,
  };
}

function session(openAsset: NonNullable<XrViewerTransportSession["openAsset"]>): XrViewerTransportSession {
  return {
    identity: {
      workspaceId: "workspace-xr-assets",
      authorityEpoch: "authority-epoch-assets",
      sessionId: "renderer-session-assets",
    },
    send: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    openAsset,
    close: vi.fn(async () => undefined),
  };
}

describe("openXrViewerRealityAsset", () => {
  it.each([
    ["ply", "gaussian-ply"],
    ["spz-v4", "gaussian-spz-v4"],
    ["sog-v2", "gaussian-sog-v2"],
  ] as const)("maps the validated host %s identity to the credential-private %s read", async (hostFormat, xrFormat) => {
    const openAsset = vi.fn(async () => new Blob(["abc"]));
    const result = await openXrViewerRealityAsset({
      session: session(openAsset),
      projection: projection(hostFormat),
      assetId: assetIdFromDigest(digest),
      digest,
      budget: budget({
        maximumAssetBytes: 3,
        maximumSplats: 1,
        maximumSphericalHarmonicsDegree: 0,
      }),
    });

    expect(result).toBeInstanceOf(Blob);
    expect(openAsset).toHaveBeenCalledWith(digest, xrFormat, 3, undefined);
    expect(openAsset.mock.calls.flat().join(" ")).not.toContain("Bearer");
  });

  it("rejects a renderer digest mismatch without opening an asset path", async () => {
    const openAsset = vi.fn(async () => new Blob(["abc"]));
    await expect(openXrViewerRealityAsset({
      session: session(openAsset),
      projection: projection(),
      assetId: assetIdFromDigest(digest),
      digest: `sha256:${"f".repeat(64)}`,
      budget: budget(),
    })).rejects.toThrow(/authoritative digest/i);
    expect(openAsset).not.toHaveBeenCalled();
  });

  it("fails closed on response length mismatch and forwards cancellation", async () => {
    const openAsset = vi.fn(async () => new Blob(["too-long"]));
    await expect(openXrViewerRealityAsset({
      session: session(openAsset),
      projection: projection(),
      assetId: assetIdFromDigest(digest),
      digest,
      budget: budget(),
    })).rejects.toThrow(/byte length/i);

    const abort = new AbortController();
    abort.abort();
    const neverOpen = vi.fn(async () => new Blob(["abc"]));
    await expect(openXrViewerRealityAsset({
      session: session(neverOpen),
      projection: projection(),
      assetId: assetIdFromDigest(digest),
      digest,
      budget: budget(),
      signal: abort.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(neverOpen).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "format_unsupported",
      projection: projection("ply"),
      budget: budget({ supportedFormats: ["gaussian-spz-v4"] }),
    },
    {
      reason: "asset_bytes_exceeded",
      projection: projection("spz-v4", { byteLength: 4 }),
      budget: budget({ maximumAssetBytes: 3 }),
    },
    {
      reason: "splat_budget_exceeded",
      projection: projection("spz-v4", { splatCount: 17 }),
      budget: budget({ maximumSplats: 16 }),
    },
    {
      reason: "spherical_harmonics_budget_exceeded",
      projection: projection("spz-v4", { sphericalHarmonicsDegree: 3 }),
      budget: budget({ maximumSphericalHarmonicsDegree: 2 }),
    },
    {
      reason: "spherical_harmonics_unknown",
      projection: projection("sog-v2", { sphericalHarmonicsDegree: null }),
      budget: budget(),
    },
  ] as const)("rejects $reason before opening the credential-private asset path", async ({
    reason,
    projection: overBudgetProjection,
    budget: performanceBudget,
  }) => {
    const openAsset = vi.fn(async () => new Blob(["bytes"]));
    await expect(openXrViewerRealityAsset({
      session: session(openAsset),
      projection: overBudgetProjection,
      assetId: assetIdFromDigest(digest),
      digest,
      budget: performanceBudget,
    })).rejects.toEqual(expect.objectContaining({
      name: XrViewerRealityAssetBudgetError.name,
      code: "performance_budget_exceeded",
      reasons: [reason],
    }));
    expect(openAsset).not.toHaveBeenCalled();
  });

  it("uses the runtime LOD selector's GPU estimate before download", async () => {
    const openAsset = vi.fn(async () => new Blob(["abc"]));
    await expect(openXrViewerRealityAsset({
      session: session(openAsset),
      projection: projection(),
      assetId: assetIdFromDigest(digest),
      digest,
      budget: budget({ maximumEstimatedGpuBytes: 1 }),
    })).rejects.toMatchObject({
      code: "performance_budget_exceeded",
      reasons: ["gpu_bytes_exceeded"],
    });
    expect(openAsset).not.toHaveBeenCalled();
  });

  it("serves repeated live-runtime reads from the bounded verified browser cache", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const contentDigest = sha256DigestBytes(bytes) as `sha256:${string}`;
    const contentAssetId = assetIdFromDigest(contentDigest);
    const currentProjection = projection("sog-v2", {
      assetId: contentAssetId,
      digest: contentDigest,
      byteLength: bytes.byteLength,
    });
    const openAsset = vi.fn(async () => new Blob([
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ], { type: "model/vnd.sog" }));
    const cache = new BrowserXrAssetCache({ maximumBytes: 32 });
    const request = {
      session: session(openAsset),
      projection: currentProjection,
      assetId: contentAssetId,
      digest: contentDigest,
      budget: budget(),
      cache,
    } as const;

    const first = await openXrViewerRealityAsset(request);
    const second = await openXrViewerRealityAsset(request);
    expect(first?.size).toBe(bytes.byteLength);
    expect(second?.size).toBe(bytes.byteLength);
    expect(openAsset).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({
      entryCount: 1,
      totalBytes: bytes.byteLength,
      peakRetainedBytes: bytes.byteLength,
    });
  });
});
