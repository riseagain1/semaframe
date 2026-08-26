import {
  XR_ASSET_CONTRACT_VERSION,
  XR_ASSET_FORMATS,
  XR_ASSET_LIMITS,
  XR_ASSET_MANIFEST_VERSION,
  XR_ASSET_MEDIA_TYPE_BY_FORMAT,
  XR_ASSET_PERFORMANCE_BUDGET_VERSION,
  XR_ASSET_REPRESENTATION_BY_FORMAT,
  type XrAssetByteRange,
  type XrAssetDescriptor,
  type XrAssetDigest,
  type XrAssetFormat,
  type XrAssetLodManifest,
  type XrAssetLodTier,
  type XrAssetPerformanceBudget,
  type XrAssetPutRequest,
  type XrAssetReadRequest,
  type XrAssetRepresentation,
} from "./contracts";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const FORMATS = new Set<XrAssetFormat>(XR_ASSET_FORMATS);
const REPRESENTATIONS = new Set<XrAssetRepresentation>(["mesh", "gaussian_splat"]);

export class XrAssetValidationError extends TypeError {
  constructor(
    readonly code:
      | "invalid_type"
      | "missing_field"
      | "unknown_field"
      | "invalid_value"
      | "limit_exceeded"
      | "inconsistent_value",
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "XrAssetValidationError";
  }
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new XrAssetValidationError("invalid_type", path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new XrAssetValidationError("invalid_type", path, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new XrAssetValidationError("invalid_type", path, "must not contain symbol properties");
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) {
      throw new XrAssetValidationError("invalid_type", path, "must contain data properties only");
    }
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Record<string, unknown> {
  const body = plainRecord(value, path);
  const allowedSet = new Set(allowed);
  if (Object.getOwnPropertyNames(body).some((key) => !allowedSet.has(key))) {
    throw new XrAssetValidationError("unknown_field", path, "contains an unknown field");
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) {
      throw new XrAssetValidationError("missing_field", `${path}.${key}`, "is required");
    }
  }
  return body;
}

function denseArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new XrAssetValidationError("invalid_type", path, "must be an array");
  }
  if (value.length > maximum) {
    throw new XrAssetValidationError("limit_exceeded", path, `cannot exceed ${maximum} items`);
  }
  const propertyNames = Object.getOwnPropertyNames(value);
  const expectedNames = [...value.keys()].map(String);
  if (Object.getOwnPropertySymbols(value).length > 0
    || propertyNames.length !== value.length + 1
    || propertyNames.some((key) => key !== "length" && !expectedNames.includes(key))
    || expectedNames.some((key) => !propertyNames.includes(key))
    || expectedNames.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined;
    })) {
    throw new XrAssetValidationError("invalid_type", path, "must be a dense array without extra properties");
  }
  return value;
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new XrAssetValidationError(
      "invalid_value",
      path,
      `must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return Number(value);
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new XrAssetValidationError(
      "invalid_value",
      path,
      "must be a bounded opaque identifier without path separators",
    );
  }
  return value;
}

export function parseXrAssetDigest(value: unknown, path = "$"): XrAssetDigest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new XrAssetValidationError("invalid_value", path, "must be a canonical lowercase SHA-256 digest");
  }
  return value as XrAssetDigest;
}

export function parseXrAssetFormat(value: unknown, path = "$"): XrAssetFormat {
  if (typeof value !== "string" || !FORMATS.has(value as XrAssetFormat)) {
    throw new XrAssetValidationError("invalid_value", path, "must be a supported XR asset format");
  }
  return value as XrAssetFormat;
}

function parseRepresentation(value: unknown, path: string): XrAssetRepresentation {
  if (typeof value !== "string" || !REPRESENTATIONS.has(value as XrAssetRepresentation)) {
    throw new XrAssetValidationError("invalid_value", path, "must be mesh or gaussian_splat");
  }
  return value as XrAssetRepresentation;
}

export function createXrAssetDescriptor(input: Readonly<{
  digest: XrAssetDigest;
  format: XrAssetFormat;
  byteLength: number;
}>): XrAssetDescriptor {
  return Object.freeze({
    version: XR_ASSET_CONTRACT_VERSION,
    digest: input.digest,
    representation: XR_ASSET_REPRESENTATION_BY_FORMAT[input.format],
    format: input.format,
    mediaType: XR_ASSET_MEDIA_TYPE_BY_FORMAT[input.format],
    byteLength: input.byteLength,
  });
}

export function parseXrAssetDescriptor(value: unknown): XrAssetDescriptor {
  const keys = ["version", "digest", "representation", "format", "mediaType", "byteLength"] as const;
  const body = exactObject(value, keys, keys, "$");
  if (body.version !== XR_ASSET_CONTRACT_VERSION) {
    throw new XrAssetValidationError("invalid_value", "$.version", `must equal ${XR_ASSET_CONTRACT_VERSION}`);
  }
  const digest = parseXrAssetDigest(body.digest, "$.digest");
  const format = parseXrAssetFormat(body.format, "$.format");
  const representation = parseRepresentation(body.representation, "$.representation");
  const byteLength = integer(body.byteLength, "$.byteLength", 1, XR_ASSET_LIMITS.maximumAssetBytes);
  if (representation !== XR_ASSET_REPRESENTATION_BY_FORMAT[format]) {
    throw new XrAssetValidationError("inconsistent_value", "$.representation", "does not match the format");
  }
  if (body.mediaType !== XR_ASSET_MEDIA_TYPE_BY_FORMAT[format]) {
    throw new XrAssetValidationError(
      "inconsistent_value",
      "$.mediaType",
      "must be the media type derived from the validated format",
    );
  }
  return createXrAssetDescriptor({ digest, format, byteLength });
}

function parseTier(value: unknown, path: string, representation: XrAssetRepresentation): XrAssetLodTier {
  const common = ["tierId", "quality", "digest", "format", "byteLength", "estimatedGpuBytes"] as const;
  const representationKeys = representation === "mesh"
    ? ["representation", "triangleCount", "texturePixelCount"] as const
    : ["representation", "splatCount", "sphericalHarmonicsDegree"] as const;
  const keys = [...common, ...representationKeys];
  const body = exactObject(value, keys, keys, path);
  const tierRepresentation = parseRepresentation(body.representation, `${path}.representation`);
  if (tierRepresentation !== representation) {
    throw new XrAssetValidationError(
      "inconsistent_value",
      `${path}.representation`,
      "must match the manifest representation",
    );
  }
  const format = parseXrAssetFormat(body.format, `${path}.format`);
  if (XR_ASSET_REPRESENTATION_BY_FORMAT[format] !== representation) {
    throw new XrAssetValidationError("inconsistent_value", `${path}.format`, "does not match the representation");
  }
  const base = {
    tierId: identifier(body.tierId, `${path}.tierId`),
    quality: integer(body.quality, `${path}.quality`, 0, 100),
    digest: parseXrAssetDigest(body.digest, `${path}.digest`),
    byteLength: integer(body.byteLength, `${path}.byteLength`, 1, XR_ASSET_LIMITS.maximumAssetBytes),
    estimatedGpuBytes: integer(
      body.estimatedGpuBytes,
      `${path}.estimatedGpuBytes`,
      1,
      XR_ASSET_LIMITS.maximumEstimatedGpuBytes,
    ),
  };
  if (representation === "mesh") {
    return Object.freeze({
      ...base,
      representation: "mesh",
      format: format as "mesh-glb",
      triangleCount: integer(body.triangleCount, `${path}.triangleCount`, 1, XR_ASSET_LIMITS.maximumTriangles),
      texturePixelCount: integer(
        body.texturePixelCount,
        `${path}.texturePixelCount`,
        0,
        XR_ASSET_LIMITS.maximumTexturePixels,
      ),
    });
  }
  return Object.freeze({
    ...base,
    representation: "gaussian_splat",
    format: format as "gaussian-spz-v4" | "gaussian-ply" | "gaussian-sog-v2",
    splatCount: integer(body.splatCount, `${path}.splatCount`, 1, XR_ASSET_LIMITS.maximumSplats),
    sphericalHarmonicsDegree: integer(
      body.sphericalHarmonicsDegree,
      `${path}.sphericalHarmonicsDegree`,
      0,
      XR_ASSET_LIMITS.maximumSphericalHarmonicsDegree,
    ) as 0 | 1 | 2 | 3 | 4,
  });
}

export function parseXrAssetLodManifest(value: unknown): XrAssetLodManifest {
  const keys = ["version", "modelId", "representation", "defaultTierId", "tiers"] as const;
  const body = exactObject(value, keys, keys, "$");
  if (body.version !== XR_ASSET_MANIFEST_VERSION) {
    throw new XrAssetValidationError("invalid_value", "$.version", `must equal ${XR_ASSET_MANIFEST_VERSION}`);
  }
  const modelId = identifier(body.modelId, "$.modelId");
  const representation = parseRepresentation(body.representation, "$.representation");
  const defaultTierId = identifier(body.defaultTierId, "$.defaultTierId");
  const tierValues = denseArray(body.tiers, "$.tiers", XR_ASSET_LIMITS.maximumManifestTiers);
  if (tierValues.length === 0) {
    throw new XrAssetValidationError("invalid_value", "$.tiers", "must contain at least one tier");
  }
  const tiers = Object.freeze(tierValues.map((tier, index) => parseTier(tier, `$.tiers[${index}]`, representation)));
  const tierIds = new Set<string>();
  const digests = new Set<XrAssetDigest>();
  const qualities = new Set<number>();
  for (const tier of tiers) {
    if (tierIds.has(tier.tierId)) {
      throw new XrAssetValidationError("inconsistent_value", "$.tiers", "tier identifiers must be unique");
    }
    if (digests.has(tier.digest)) {
      throw new XrAssetValidationError("inconsistent_value", "$.tiers", "tier digests must be unique");
    }
    if (qualities.has(tier.quality)) {
      throw new XrAssetValidationError("inconsistent_value", "$.tiers", "tier quality values must be unique");
    }
    tierIds.add(tier.tierId);
    digests.add(tier.digest);
    qualities.add(tier.quality);
  }
  const defaultTier = tiers.find((tier) => tier.tierId === defaultTierId);
  if (!defaultTier) {
    throw new XrAssetValidationError("inconsistent_value", "$.defaultTierId", "must reference a manifest tier");
  }
  const maximumQuality = Math.max(...tiers.map((tier) => tier.quality));
  if (defaultTier.quality !== maximumQuality) {
    throw new XrAssetValidationError(
      "inconsistent_value",
      "$.defaultTierId",
      "must reference the highest-quality tier",
    );
  }
  return Object.freeze({
    version: XR_ASSET_MANIFEST_VERSION,
    modelId,
    representation,
    defaultTierId,
    tiers,
  });
}

export function parseXrAssetPerformanceBudget(value: unknown): XrAssetPerformanceBudget {
  const keys = [
    "version",
    "supportedFormats",
    "maximumAssetBytes",
    "maximumEstimatedGpuBytes",
    "maximumTriangles",
    "maximumTexturePixels",
    "maximumSplats",
    "maximumSphericalHarmonicsDegree",
  ] as const;
  const body = exactObject(value, keys, keys, "$");
  if (body.version !== XR_ASSET_PERFORMANCE_BUDGET_VERSION) {
    throw new XrAssetValidationError(
      "invalid_value",
      "$.version",
      `must equal ${XR_ASSET_PERFORMANCE_BUDGET_VERSION}`,
    );
  }
  const rawFormats = denseArray(body.supportedFormats, "$.supportedFormats", XR_ASSET_FORMATS.length);
  const supportedFormats = rawFormats.map((format, index) => parseXrAssetFormat(format, `$.supportedFormats[${index}]`));
  if (new Set(supportedFormats).size !== supportedFormats.length) {
    throw new XrAssetValidationError("inconsistent_value", "$.supportedFormats", "must not contain duplicates");
  }
  return Object.freeze({
    version: XR_ASSET_PERFORMANCE_BUDGET_VERSION,
    supportedFormats: Object.freeze([...supportedFormats]),
    maximumAssetBytes: integer(body.maximumAssetBytes, "$.maximumAssetBytes", 0, XR_ASSET_LIMITS.maximumAssetBytes),
    maximumEstimatedGpuBytes: integer(
      body.maximumEstimatedGpuBytes,
      "$.maximumEstimatedGpuBytes",
      0,
      XR_ASSET_LIMITS.maximumEstimatedGpuBytes,
    ),
    maximumTriangles: integer(body.maximumTriangles, "$.maximumTriangles", 0, XR_ASSET_LIMITS.maximumTriangles),
    maximumTexturePixels: integer(
      body.maximumTexturePixels,
      "$.maximumTexturePixels",
      0,
      XR_ASSET_LIMITS.maximumTexturePixels,
    ),
    maximumSplats: integer(body.maximumSplats, "$.maximumSplats", 0, XR_ASSET_LIMITS.maximumSplats),
    maximumSphericalHarmonicsDegree: integer(
      body.maximumSphericalHarmonicsDegree,
      "$.maximumSphericalHarmonicsDegree",
      0,
      XR_ASSET_LIMITS.maximumSphericalHarmonicsDegree,
    ) as 0 | 1 | 2 | 3 | 4,
  });
}

export function parseXrAssetPutRequest(value: unknown, maximumTtlMs: number): XrAssetPutRequest {
  const keys = ["version", "digest", "format", "byteLength", "ttlMs"] as const;
  const body = exactObject(value, keys, keys, "$");
  if (!Number.isSafeInteger(maximumTtlMs) || maximumTtlMs < 1) {
    throw new RangeError("maximumTtlMs must be a positive safe integer");
  }
  if (body.version !== XR_ASSET_CONTRACT_VERSION) {
    throw new XrAssetValidationError("invalid_value", "$.version", `must equal ${XR_ASSET_CONTRACT_VERSION}`);
  }
  return Object.freeze({
    version: XR_ASSET_CONTRACT_VERSION,
    digest: parseXrAssetDigest(body.digest, "$.digest"),
    format: parseXrAssetFormat(body.format, "$.format"),
    byteLength: integer(body.byteLength, "$.byteLength", 1, XR_ASSET_LIMITS.maximumAssetBytes),
    ttlMs: integer(body.ttlMs, "$.ttlMs", 1, maximumTtlMs),
  });
}

function parseRange(value: unknown): XrAssetByteRange {
  const keys = ["start", "endExclusive"] as const;
  const body = exactObject(value, keys, keys, "$.range");
  const start = integer(body.start, "$.range.start", 0, XR_ASSET_LIMITS.maximumAssetBytes - 1);
  const endExclusive = integer(body.endExclusive, "$.range.endExclusive", 1, XR_ASSET_LIMITS.maximumAssetBytes);
  if (endExclusive <= start) {
    throw new XrAssetValidationError("invalid_value", "$.range", "endExclusive must be greater than start");
  }
  return Object.freeze({ start, endExclusive });
}

export function parseXrAssetReadRequest(value: unknown): XrAssetReadRequest {
  const body = exactObject(value, ["digest", "range"], ["digest"], "$");
  return Object.freeze({
    digest: parseXrAssetDigest(body.digest, "$.digest"),
    ...(body.range === undefined ? {} : { range: parseRange(body.range) }),
  });
}
