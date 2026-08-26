export const XR_ASSET_CONTRACT_VERSION = 1 as const;
export const XR_ASSET_MANIFEST_VERSION = 1 as const;
export const XR_ASSET_PERFORMANCE_BUDGET_VERSION = 1 as const;

export const XR_ASSET_FORMATS = [
  "mesh-glb",
  "gaussian-spz-v4",
  "gaussian-ply",
  "gaussian-sog-v2",
] as const;

export type XrAssetFormat = (typeof XR_ASSET_FORMATS)[number];
export type XrAssetDigest = `sha256:${string}`;
export type XrAssetRepresentation = "mesh" | "gaussian_splat";
export type XrAssetMediaType =
  | "model/gltf-binary"
  | "application/x-spz"
  | "application/ply"
  | "model/vnd.sog";

export const XR_ASSET_LIMITS = Object.freeze({
  /** One immutable payload must fit the production relay and Ultra profile. */
  maximumAssetBytes: 256 * 1024 * 1024,
  maximumEstimatedGpuBytes: 8 * 1024 * 1024 * 1024,
  maximumManifestTiers: 8,
  maximumTriangles: 50_000_000,
  maximumTexturePixels: 1_000_000_000,
  maximumSplats: 20_000_000,
  maximumSphericalHarmonicsDegree: 4,
  maximumIdentifierLength: 128,
});

/**
 * Shared deployment/runtime budgets. Keeping these beside the protocol ceiling
 * prevents the host, relay, and renderer profiles from silently advertising
 * mutually impossible payload sizes.
 */
export const XR_ASSET_RUNTIME_LIMITS = Object.freeze({
  balancedMaximumAssetBytes: 96 * 1024 * 1024,
  browserCacheMaximumBytes: 128 * 1024 * 1024,
  relayMaximumAssetBytes: XR_ASSET_LIMITS.maximumAssetBytes,
  relayMaximumAggregateBytes: 512 * 1024 * 1024,
  downloadRangeBytes: 4 * 1024 * 1024,
  downloadProgressTimeoutMs: 10_000,
  downloadMaximumRetries: 3,
  minimumUploadBytesPerSecond: 256 * 1024,
});

export const XR_ASSET_MEDIA_TYPE_BY_FORMAT: Readonly<Record<XrAssetFormat, XrAssetMediaType>> =
  Object.freeze({
    "mesh-glb": "model/gltf-binary",
    "gaussian-spz-v4": "application/x-spz",
    "gaussian-ply": "application/ply",
    "gaussian-sog-v2": "model/vnd.sog",
  });

export const XR_ASSET_REPRESENTATION_BY_FORMAT:
Readonly<Record<XrAssetFormat, XrAssetRepresentation>> = Object.freeze({
  "mesh-glb": "mesh",
  "gaussian-spz-v4": "gaussian_splat",
  "gaussian-ply": "gaussian_splat",
  "gaussian-sog-v2": "gaussian_splat",
});

export type XrAssetDescriptor = Readonly<{
  version: typeof XR_ASSET_CONTRACT_VERSION;
  digest: XrAssetDigest;
  representation: XrAssetRepresentation;
  format: XrAssetFormat;
  mediaType: XrAssetMediaType;
  byteLength: number;
}>;

type XrAssetLodTierBase = Readonly<{
  tierId: string;
  quality: number;
  digest: XrAssetDigest;
  byteLength: number;
  estimatedGpuBytes: number;
}>;

export type XrMeshAssetLodTier = XrAssetLodTierBase & Readonly<{
  representation: "mesh";
  format: "mesh-glb";
  triangleCount: number;
  texturePixelCount: number;
}>;

export type XrGaussianAssetLodTier = XrAssetLodTierBase & Readonly<{
  representation: "gaussian_splat";
  format: "gaussian-spz-v4" | "gaussian-ply" | "gaussian-sog-v2";
  splatCount: number;
  sphericalHarmonicsDegree: 0 | 1 | 2 | 3 | 4;
}>;

export type XrAssetLodTier = XrMeshAssetLodTier | XrGaussianAssetLodTier;

/**
 * A manifest contains immutable content identities only. Deliberately absent:
 * URLs, file paths, authorization material, and caller-supplied MIME strings.
 */
export type XrAssetLodManifest = Readonly<{
  version: typeof XR_ASSET_MANIFEST_VERSION;
  modelId: string;
  representation: XrAssetRepresentation;
  defaultTierId: string;
  tiers: readonly XrAssetLodTier[];
}>;

export type XrAssetPerformanceBudget = Readonly<{
  version: typeof XR_ASSET_PERFORMANCE_BUDGET_VERSION;
  supportedFormats: readonly XrAssetFormat[];
  maximumAssetBytes: number;
  maximumEstimatedGpuBytes: number;
  maximumTriangles: number;
  maximumTexturePixels: number;
  maximumSplats: number;
  maximumSphericalHarmonicsDegree: 0 | 1 | 2 | 3 | 4;
}>;

export type XrAssetTierRejectionReason =
  | "format_unsupported"
  | "asset_bytes_exceeded"
  | "gpu_bytes_exceeded"
  | "triangle_budget_exceeded"
  | "texture_budget_exceeded"
  | "splat_budget_exceeded"
  | "spherical_harmonics_budget_exceeded";

export type XrAssetTierRejection = Readonly<{
  tierId: string;
  reasons: readonly XrAssetTierRejectionReason[];
}>;

export type XrAssetTierSelection =
  | Readonly<{
      status: "selected";
      mode: "full" | "degraded";
      tier: XrAssetLodTier;
      rejected: readonly XrAssetTierRejection[];
    }>
  | Readonly<{
      status: "placeholder";
      reason: "no_supported_format" | "performance_budget_exceeded";
      rejected: readonly XrAssetTierRejection[];
    }>;

export type XrAssetPutRequest = Readonly<{
  version: typeof XR_ASSET_CONTRACT_VERSION;
  digest: XrAssetDigest;
  format: XrAssetFormat;
  byteLength: number;
  ttlMs: number;
}>;

export type XrAssetByteRange = Readonly<{
  start: number;
  endExclusive: number;
}>;

export type XrAssetReadRequest = Readonly<{
  digest: XrAssetDigest;
  range?: XrAssetByteRange;
}>;
