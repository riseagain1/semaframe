import { describe, expect, it } from "vitest";
import {
  XR_ASSET_CONTRACT_VERSION,
  XR_ASSET_MANIFEST_VERSION,
  XR_ASSET_PERFORMANCE_BUDGET_VERSION,
  createXrAssetDescriptor,
  parseXrAssetDescriptor,
  parseXrAssetLodManifest,
  parseXrAssetPerformanceBudget,
  selectXrAssetLodTier,
  type XrAssetDigest,
  type XrAssetLodManifest,
  type XrAssetPerformanceBudget,
} from "../../xr/assets";

const DIGEST_HIGH = `sha256:${"a".repeat(64)}` as XrAssetDigest;
const DIGEST_LOW = `sha256:${"b".repeat(64)}` as XrAssetDigest;

function meshManifest(): XrAssetLodManifest {
  return {
    version: XR_ASSET_MANIFEST_VERSION,
    modelId: "machine.press.v1",
    representation: "mesh",
    defaultTierId: "high",
    tiers: [
      {
        tierId: "high",
        quality: 100,
        representation: "mesh",
        format: "mesh-glb",
        digest: DIGEST_HIGH,
        byteLength: 40_000_000,
        estimatedGpuBytes: 160_000_000,
        triangleCount: 2_000_000,
        texturePixelCount: 64_000_000,
      },
      {
        tierId: "preview",
        quality: 30,
        representation: "mesh",
        format: "mesh-glb",
        digest: DIGEST_LOW,
        byteLength: 2_000_000,
        estimatedGpuBytes: 8_000_000,
        triangleCount: 80_000,
        texturePixelCount: 4_000_000,
      },
    ],
  };
}

function budget(overrides: Partial<XrAssetPerformanceBudget> = {}): XrAssetPerformanceBudget {
  return {
    version: XR_ASSET_PERFORMANCE_BUDGET_VERSION,
    supportedFormats: ["mesh-glb", "gaussian-spz-v4"],
    maximumAssetBytes: 64_000_000,
    maximumEstimatedGpuBytes: 256_000_000,
    maximumTriangles: 4_000_000,
    maximumTexturePixels: 128_000_000,
    maximumSplats: 2_000_000,
    maximumSphericalHarmonicsDegree: 2,
    ...overrides,
  };
}

describe("XR asset contracts", () => {
  it("parses immutable mesh and Gaussian LOD manifests", () => {
    const mesh = parseXrAssetLodManifest(meshManifest());
    expect(mesh).toEqual(meshManifest());
    expect(Object.isFrozen(mesh)).toBe(true);
    expect(Object.isFrozen(mesh.tiers)).toBe(true);

    const gaussian = parseXrAssetLodManifest({
      version: XR_ASSET_MANIFEST_VERSION,
      modelId: "scan.tower.v2",
      representation: "gaussian_splat",
      defaultTierId: "balanced",
      tiers: [{
        tierId: "balanced",
        quality: 80,
        representation: "gaussian_splat",
        format: "gaussian-spz-v4",
        digest: DIGEST_HIGH,
        byteLength: 24_000_000,
        estimatedGpuBytes: 120_000_000,
        splatCount: 1_200_000,
        sphericalHarmonicsDegree: 2,
      }],
    });
    expect(gaussian.tiers[0]).toMatchObject({
      representation: "gaussian_splat",
      format: "gaussian-spz-v4",
      splatCount: 1_200_000,
    });
  });

  it("derives MIME and representation rather than trusting caller metadata", () => {
    const descriptor = createXrAssetDescriptor({
      digest: DIGEST_HIGH,
      format: "mesh-glb",
      byteLength: 12,
    });
    expect(descriptor).toEqual({
      version: XR_ASSET_CONTRACT_VERSION,
      digest: DIGEST_HIGH,
      representation: "mesh",
      format: "mesh-glb",
      mediaType: "model/gltf-binary",
      byteLength: 12,
    });
    expect(() => parseXrAssetDescriptor({ ...descriptor, mediaType: "text/html" }))
      .toThrow(/media type derived/u);
    expect(() => parseXrAssetDescriptor({ ...descriptor, representation: "gaussian_splat" }))
      .toThrow(/does not match/u);
  });

  it("rejects URLs, paths, accessors, mixed tiers, and ambiguous defaults", () => {
    expect(() => parseXrAssetLodManifest({ ...meshManifest(), sourceUrl: "https://private.invalid/file" }))
      .toThrow(/unknown field/u);
    expect(() => parseXrAssetLodManifest({ ...meshManifest(), modelId: "../../private" }))
      .toThrow(/without path separators/u);
    expect(() => parseXrAssetLodManifest({
      ...meshManifest(),
      defaultTierId: "preview",
    })).toThrow(/highest-quality tier/u);
    expect(() => parseXrAssetLodManifest({
      ...meshManifest(),
      tiers: [{
        ...meshManifest().tiers[0],
        representation: "gaussian_splat",
        format: "gaussian-ply",
        splatCount: 100,
        sphericalHarmonicsDegree: 0,
      }],
    })).toThrow();

    const accessor = Object.defineProperty({}, "version", { get: () => 1, enumerable: true });
    expect(() => parseXrAssetLodManifest(accessor)).toThrow(/data properties only/u);
    const hiddenUrl = Object.defineProperty({ ...meshManifest() }, "url", {
      value: "https://example.invalid/private",
      enumerable: false,
    });
    expect(() => parseXrAssetLodManifest(hiddenUrl)).toThrow(/unknown field/u);
    const accessorTiers = [...meshManifest().tiers];
    Object.defineProperty(accessorTiers, "0", { get: () => meshManifest().tiers[0], enumerable: true });
    expect(() => parseXrAssetLodManifest({ ...meshManifest(), tiers: accessorTiers }))
      .toThrow(/dense array/u);
  });

  it("parses an exact bounded performance budget", () => {
    expect(parseXrAssetPerformanceBudget(budget())).toEqual(budget());
    expect(() => parseXrAssetPerformanceBudget({ ...budget(), supportedFormats: ["mesh-glb", "mesh-glb"] }))
      .toThrow(/duplicates/u);
    expect(() => parseXrAssetPerformanceBudget({ ...budget(), maximumSplats: Number.POSITIVE_INFINITY }))
      .toThrow(/safe integer/u);
    expect(() => parseXrAssetPerformanceBudget({ ...budget(), url: "https://example.invalid" }))
      .toThrow(/unknown field/u);
  });

  it("selects full quality, safely degrades, then uses a placeholder without exceeding budget", () => {
    expect(selectXrAssetLodTier(meshManifest(), budget())).toMatchObject({
      status: "selected",
      mode: "full",
      tier: { tierId: "high" },
    });
    const degraded = selectXrAssetLodTier(meshManifest(), budget({
      maximumAssetBytes: 4_000_000,
      maximumEstimatedGpuBytes: 16_000_000,
      maximumTriangles: 100_000,
      maximumTexturePixels: 8_000_000,
    }));
    expect(degraded).toMatchObject({
      status: "selected",
      mode: "degraded",
      tier: { tierId: "preview" },
      rejected: [{ tierId: "high" }],
    });

    expect(selectXrAssetLodTier(meshManifest(), budget({ supportedFormats: ["gaussian-spz-v4"] })))
      .toMatchObject({ status: "placeholder", reason: "no_supported_format" });
    expect(selectXrAssetLodTier(meshManifest(), budget({
      maximumAssetBytes: 1,
      maximumEstimatedGpuBytes: 1,
      maximumTriangles: 1,
      maximumTexturePixels: 1,
    }))).toMatchObject({ status: "placeholder", reason: "performance_budget_exceeded" });
  });
});
