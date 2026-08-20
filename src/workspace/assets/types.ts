export const REALITY_ASSET_DESCRIPTOR_VERSION = 1 as const;
export const REALITY_CALIBRATION_VERSION = 1 as const;

export const REALITY_COORDINATE_SYSTEMS = [
  "UNKNOWN",
  "LDB", "RDB", "LUB", "RUB", "LDF", "RDF", "LUF", "RUF",
  "LFD", "RFD", "LFU", "RFU", "LBD", "RBD", "LBU", "RBU",
] as const;

export type RealityCoordinateSystem = (typeof REALITY_COORDINATE_SYSTEMS)[number];
export type RealityAssetFormat = "spz-v4" | "ply" | "sog-v2";
export type RealityAssetModel = "gaussian-3d" | "gaussian-2d" | "unknown";
export type RealityAssetDigest = `sha256:${string}`;
export type RealityAssetId = `ra_${string}`;

export type RealityAssetBounds = Readonly<{
  min: Readonly<{ x: number; y: number; z: number }>;
  max: Readonly<{ x: number; y: number; z: number }>;
}>;

export type RealityCoordinateDeclaration = Readonly<{
  system: RealityCoordinateSystem;
  provenance: "embedded" | "format-default" | "unknown";
}>;

/**
 * Durable, agent-safe metadata. It intentionally contains no File name, local
 * path, Blob URL, upload token, or raw bytes.
 */
export type RealityAssetDescriptor = Readonly<{
  version: typeof REALITY_ASSET_DESCRIPTOR_VERSION;
  assetId: RealityAssetId;
  digest: RealityAssetDigest;
  format: RealityAssetFormat;
  formatVersion: number;
  mediaType: "application/x-spz" | "application/ply" | "model/vnd.sog";
  byteLength: number;
  splatCount: number;
  sphericalHarmonicsDegree: 0 | 1 | 2 | 3 | 4 | null;
  model: RealityAssetModel;
  antialiased: boolean | null;
  coordinateSystem: RealityCoordinateDeclaration;
  sourceBounds?: RealityAssetBounds;
  engineeringAuthority: "visual_only";
}>;

export type RealityAssetWarningCode =
  | "source_units_unknown"
  | "source_coordinate_system_unknown"
  | "compressed_payload_not_decoded"
  | "unknown_spz_extensions"
  | "sog_image_dimensions_not_verified";

export type RealityAssetCandidate = Readonly<{
  descriptor: RealityAssetDescriptor;
  warnings: readonly RealityAssetWarningCode[];
}>;

type CalibrationBase = Readonly<{
  version: typeof REALITY_CALIBRATION_VERSION;
  sourceCoordinateSystem: RealityCoordinateSystem;
  targetCoordinateSystem: "RUB";
}>;

export type UncalibratedRealityAsset = CalibrationBase & Readonly<{
  status: "uncalibrated";
  metersPerSourceUnit: null;
}>;

export type MetadataDeclaredRealityAssetCalibration = CalibrationBase & Readonly<{
  status: "metadata-declared";
  metersPerSourceUnit: number;
  declaredUnit: "metre" | "centimetre" | "millimetre" | "inch" | "foot";
}>;

export type ReferenceDistanceRealityAssetCalibration = CalibrationBase & Readonly<{
  status: "reference-distance";
  metersPerSourceUnit: number;
  sourceDistance: number;
  referenceDistanceM: number;
}>;

export type RealityAssetCalibration =
  | UncalibratedRealityAsset
  | MetadataDeclaredRealityAssetCalibration
  | ReferenceDistanceRealityAssetCalibration;

export type RealityAssetValidationIssueCode =
  | "invalid_type"
  | "missing_property"
  | "unknown_property"
  | "invalid_value"
  | "non_finite"
  | "out_of_range"
  | "inconsistent_value";

export type RealityAssetValidationIssue = Readonly<{
  path: string;
  code: RealityAssetValidationIssueCode;
  message: string;
}>;

export type PutRealityAssetResult = Readonly<{
  descriptor: RealityAssetDescriptor;
  deduplicated: boolean;
}>;
