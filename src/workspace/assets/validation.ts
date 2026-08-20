import { RealityAssetError } from "./errors";
import { REALITY_ASSET_LIMITS } from "./limits";
import {
  REALITY_ASSET_DESCRIPTOR_VERSION,
  REALITY_CALIBRATION_VERSION,
  REALITY_COORDINATE_SYSTEMS,
  type RealityAssetBounds,
  type RealityAssetCalibration,
  type RealityAssetCandidate,
  type RealityAssetDescriptor,
  type RealityAssetDigest,
  type RealityAssetFormat,
  type RealityAssetId,
  type RealityAssetModel,
  type RealityAssetValidationIssue,
  type RealityAssetValidationIssueCode,
  type RealityAssetWarningCode,
  type RealityCoordinateDeclaration,
  type RealityCoordinateSystem,
} from "./types";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ASSET_ID_PATTERN = /^ra_[0-9a-f]{64}$/;
const FORMATS = new Set<RealityAssetFormat>(["spz-v4", "ply", "sog-v2"]);
const MODELS = new Set<RealityAssetModel>(["gaussian-3d", "gaussian-2d", "unknown"]);
const WARNING_CODES = new Set<RealityAssetWarningCode>([
  "source_units_unknown",
  "source_coordinate_system_unknown",
  "compressed_payload_not_decoded",
  "unknown_spz_extensions",
  "sog_image_dimensions_not_verified",
]);
const COORDINATE_SYSTEMS = new Set<RealityCoordinateSystem>(REALITY_COORDINATE_SYSTEMS);
const MEDIA_TYPE_BY_FORMAT = Object.freeze({
  "spz-v4": "application/x-spz",
  ply: "application/ply",
  "sog-v2": "model/vnd.sog",
} as const);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function issue(
  path: string,
  code: RealityAssetValidationIssueCode,
  message: string,
): RealityAssetValidationIssue {
  return Object.freeze({ path, code, message });
}

function validateKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  issues: RealityAssetValidationIssue[],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      issues.push(issue(`${path}.${key}`, "missing_property", `${path}.${key} is required`));
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(issue(`${path}.${key}`, "unknown_property", `${path}.${key} is not allowed`));
    }
  }
}

function finiteInRange(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: RealityAssetValidationIssue[],
): value is number {
  if (typeof value !== "number") {
    issues.push(issue(path, "invalid_type", `${path} must be a number`));
    return false;
  }
  if (!Number.isFinite(value)) {
    issues.push(issue(path, "non_finite", `${path} must be finite`));
    return false;
  }
  if (value < minimum || value > maximum) {
    issues.push(issue(path, "out_of_range", `${path} is outside the allowed range`));
    return false;
  }
  return true;
}

function positiveInteger(
  value: unknown,
  path: string,
  maximum: number,
  issues: RealityAssetValidationIssue[],
): value is number {
  if (!finiteInRange(value, path, 1, maximum, issues)) return false;
  if (!Number.isSafeInteger(value)) {
    issues.push(issue(path, "invalid_value", `${path} must be an integer`));
    return false;
  }
  return true;
}

function validatePoint(
  value: unknown,
  path: string,
  issues: RealityAssetValidationIssue[],
): value is Readonly<{ x: number; y: number; z: number }> {
  const item = record(value);
  if (!item) {
    issues.push(issue(path, "invalid_type", `${path} must be an object`));
    return false;
  }
  validateKeys(item, ["x", "y", "z"], ["x", "y", "z"], path, issues);
  const x = finiteInRange(item.x, `${path}.x`, -1e12, 1e12, issues);
  const y = finiteInRange(item.y, `${path}.y`, -1e12, 1e12, issues);
  const z = finiteInRange(item.z, `${path}.z`, -1e12, 1e12, issues);
  return x && y && z;
}

function validateBounds(
  value: unknown,
  path: string,
  issues: RealityAssetValidationIssue[],
): value is RealityAssetBounds {
  const bounds = record(value);
  if (!bounds) {
    issues.push(issue(path, "invalid_type", `${path} must be an object`));
    return false;
  }
  validateKeys(bounds, ["min", "max"], ["min", "max"], path, issues);
  const minValid = validatePoint(bounds.min, `${path}.min`, issues);
  const maxValid = validatePoint(bounds.max, `${path}.max`, issues);
  if (minValid && maxValid) {
    const min = bounds.min as { x: number; y: number; z: number };
    const max = bounds.max as { x: number; y: number; z: number };
    if (min.x > max.x || min.y > max.y || min.z > max.z) {
      issues.push(issue(path, "inconsistent_value", `${path}.min must not exceed ${path}.max`));
      return false;
    }
  }
  return minValid && maxValid;
}

function validateCoordinateDeclaration(
  value: unknown,
  path: string,
  issues: RealityAssetValidationIssue[],
): value is RealityCoordinateDeclaration {
  const coordinate = record(value);
  if (!coordinate) {
    issues.push(issue(path, "invalid_type", `${path} must be an object`));
    return false;
  }
  validateKeys(coordinate, ["system", "provenance"], ["system", "provenance"], path, issues);
  if (typeof coordinate.system !== "string" || !COORDINATE_SYSTEMS.has(coordinate.system as RealityCoordinateSystem)) {
    issues.push(issue(`${path}.system`, "invalid_value", `${path}.system is not supported`));
  }
  if (!["embedded", "format-default", "unknown"].includes(String(coordinate.provenance))) {
    issues.push(issue(`${path}.provenance`, "invalid_value", `${path}.provenance is not supported`));
  }
  if (coordinate.system === "UNKNOWN" && coordinate.provenance !== "unknown") {
    issues.push(issue(path, "inconsistent_value", "UNKNOWN coordinates must have unknown provenance"));
  }
  if (coordinate.system !== "UNKNOWN" && coordinate.provenance === "unknown") {
    issues.push(issue(path, "inconsistent_value", "Named coordinates require declared provenance"));
  }
  return issues.length === 0;
}

export function validateRealityAssetDescriptor(value: unknown): readonly RealityAssetValidationIssue[] {
  const issues: RealityAssetValidationIssue[] = [];
  const descriptor = record(value);
  if (!descriptor) {
    return [issue("$", "invalid_type", "Reality asset descriptor must be an object")];
  }
  validateKeys(descriptor, [
    "version", "assetId", "digest", "format", "formatVersion", "mediaType",
    "byteLength", "splatCount", "sphericalHarmonicsDegree", "model", "antialiased",
    "coordinateSystem", "sourceBounds", "engineeringAuthority",
  ], [
    "version", "assetId", "digest", "format", "formatVersion", "mediaType",
    "byteLength", "splatCount", "sphericalHarmonicsDegree", "model", "antialiased",
    "coordinateSystem", "engineeringAuthority",
  ], "$", issues);

  if (descriptor.version !== REALITY_ASSET_DESCRIPTOR_VERSION) {
    issues.push(issue("$.version", "invalid_value", "Unsupported reality asset descriptor version"));
  }
  const digestValid = typeof descriptor.digest === "string" && DIGEST_PATTERN.test(descriptor.digest);
  if (!digestValid) issues.push(issue("$.digest", "invalid_value", "digest must be canonical SHA-256"));
  const assetIdValid = typeof descriptor.assetId === "string" && ASSET_ID_PATTERN.test(descriptor.assetId);
  if (!assetIdValid) issues.push(issue("$.assetId", "invalid_value", "assetId must be content-addressed"));
  if (digestValid && assetIdValid && descriptor.assetId !== `ra_${String(descriptor.digest).slice(7)}`) {
    issues.push(issue("$.assetId", "inconsistent_value", "assetId must match digest"));
  }
  const formatValid = typeof descriptor.format === "string" && FORMATS.has(descriptor.format as RealityAssetFormat);
  if (!formatValid) issues.push(issue("$.format", "invalid_value", "Unsupported reality asset format"));
  positiveInteger(descriptor.formatVersion, "$.formatVersion", 65_535, issues);
  if (
    formatValid
    && descriptor.formatVersion !== ({ "spz-v4": 4, ply: 1, "sog-v2": 2 } as const)[descriptor.format as RealityAssetFormat]
  ) {
    issues.push(issue("$.formatVersion", "inconsistent_value", "formatVersion does not match format"));
  }
  if (formatValid && descriptor.mediaType !== MEDIA_TYPE_BY_FORMAT[descriptor.format as RealityAssetFormat]) {
    issues.push(issue("$.mediaType", "inconsistent_value", "mediaType does not match format"));
  }
  positiveInteger(descriptor.byteLength, "$.byteLength", REALITY_ASSET_LIMITS.maximumAssetBytes, issues);
  positiveInteger(descriptor.splatCount, "$.splatCount", REALITY_ASSET_LIMITS.maximumSplatCount, issues);
  if (
    descriptor.sphericalHarmonicsDegree !== null
    && (
      typeof descriptor.sphericalHarmonicsDegree !== "number"
      || !Number.isInteger(descriptor.sphericalHarmonicsDegree)
      || ![0, 1, 2, 3, 4].includes(descriptor.sphericalHarmonicsDegree)
    )
  ) {
    issues.push(issue("$.sphericalHarmonicsDegree", "invalid_value", "SH degree must be 0..4 or null"));
  }
  if (typeof descriptor.model !== "string" || !MODELS.has(descriptor.model as RealityAssetModel)) {
    issues.push(issue("$.model", "invalid_value", "Unsupported gaussian model"));
  }
  if (descriptor.format === "spz-v4" && descriptor.model !== "gaussian-3d") {
    issues.push(issue("$.model", "inconsistent_value", "SPZ v4 cannot represent this gaussian model"));
  }
  if (descriptor.antialiased !== null && typeof descriptor.antialiased !== "boolean") {
    issues.push(issue("$.antialiased", "invalid_type", "antialiased must be boolean or null"));
  }
  validateCoordinateDeclaration(descriptor.coordinateSystem, "$.coordinateSystem", issues);
  if (descriptor.sourceBounds !== undefined) validateBounds(descriptor.sourceBounds, "$.sourceBounds", issues);
  if (descriptor.engineeringAuthority !== "visual_only") {
    issues.push(issue("$.engineeringAuthority", "invalid_value", "Reality assets are visual-only"));
  }
  return issues;
}

function invalidDescriptor(kind: string, issues: readonly RealityAssetValidationIssue[]): RealityAssetError {
  const first = issues[0];
  return new RealityAssetError(
    "invalid_descriptor",
    first ? `Invalid ${kind}: ${first.path} ${first.message}` : `Invalid ${kind}`,
  );
}

export function parseRealityAssetDescriptor(value: unknown): RealityAssetDescriptor {
  const issues = validateRealityAssetDescriptor(value);
  if (issues.length > 0) throw invalidDescriptor("reality asset descriptor", issues);
  const descriptor = value as RealityAssetDescriptor;
  const frozen: RealityAssetDescriptor = {
    ...descriptor,
    coordinateSystem: Object.freeze({ ...descriptor.coordinateSystem }),
    ...(descriptor.sourceBounds === undefined ? {} : {
      sourceBounds: Object.freeze({
        min: Object.freeze({ ...descriptor.sourceBounds.min }),
        max: Object.freeze({ ...descriptor.sourceBounds.max }),
      }),
    }),
  };
  return Object.freeze(frozen);
}

export function parseRealityAssetCandidate(value: unknown): RealityAssetCandidate {
  const candidate = record(value);
  if (!candidate) throw invalidDescriptor("reality asset candidate", [
    issue("$", "invalid_type", "Reality asset candidate must be an object"),
  ]);
  const issues: RealityAssetValidationIssue[] = [];
  validateKeys(candidate, ["descriptor", "warnings"], ["descriptor", "warnings"], "$", issues);
  issues.push(...validateRealityAssetDescriptor(candidate.descriptor));
  if (!Array.isArray(candidate.warnings) || candidate.warnings.length > WARNING_CODES.size) {
    issues.push(issue("$.warnings", "invalid_type", "Reality asset warnings must be a bounded array"));
  } else {
    const seen = new Set<string>();
    for (const [index, warning] of candidate.warnings.entries()) {
      if (typeof warning !== "string" || !WARNING_CODES.has(warning as RealityAssetWarningCode)) {
        issues.push(issue(`$.warnings[${index}]`, "invalid_value", "Reality asset warning is not supported"));
      } else if (seen.has(warning)) {
        issues.push(issue(`$.warnings[${index}]`, "invalid_value", "Reality asset warning is duplicated"));
      }
      if (typeof warning === "string") seen.add(warning);
    }
  }
  if (issues.length > 0) throw invalidDescriptor("reality asset candidate", issues);
  return Object.freeze({
    descriptor: parseRealityAssetDescriptor(candidate.descriptor),
    warnings: Object.freeze([...(candidate.warnings as RealityAssetWarningCode[])]),
  });
}

export function validateRealityAssetCalibration(value: unknown): readonly RealityAssetValidationIssue[] {
  const issues: RealityAssetValidationIssue[] = [];
  const calibration = record(value);
  if (!calibration) return [issue("$", "invalid_type", "Calibration must be an object")];
  const status = calibration.status;
  const common = ["version", "status", "sourceCoordinateSystem", "targetCoordinateSystem", "metersPerSourceUnit"];
  const allowed = status === "metadata-declared"
    ? [...common, "declaredUnit"]
    : status === "reference-distance"
      ? [...common, "sourceDistance", "referenceDistanceM"]
      : common;
  validateKeys(calibration, allowed, common, "$", issues);
  if (calibration.version !== REALITY_CALIBRATION_VERSION) {
    issues.push(issue("$.version", "invalid_value", "Unsupported calibration version"));
  }
  if (!["uncalibrated", "metadata-declared", "reference-distance"].includes(String(status))) {
    issues.push(issue("$.status", "invalid_value", "Unsupported calibration status"));
  }
  const coordinateValid = typeof calibration.sourceCoordinateSystem === "string"
    && COORDINATE_SYSTEMS.has(calibration.sourceCoordinateSystem as RealityCoordinateSystem);
  if (!coordinateValid) {
    issues.push(issue("$.sourceCoordinateSystem", "invalid_value", "Unsupported source coordinate system"));
  }
  if (calibration.targetCoordinateSystem !== "RUB") {
    issues.push(issue("$.targetCoordinateSystem", "invalid_value", "Target coordinates must be RUB"));
  }

  if (status === "uncalibrated") {
    if (calibration.metersPerSourceUnit !== null) {
      issues.push(issue("$.metersPerSourceUnit", "inconsistent_value", "Uncalibrated assets cannot claim metric scale"));
    }
  } else if (status === "metadata-declared") {
    finiteInRange(calibration.metersPerSourceUnit, "$.metersPerSourceUnit", 1e-12, 1e12, issues);
    if (!["metre", "centimetre", "millimetre", "inch", "foot"].includes(String(calibration.declaredUnit))) {
      issues.push(issue("$.declaredUnit", "invalid_value", "Unsupported declared unit"));
    }
  } else if (status === "reference-distance") {
    const scaleValid = finiteInRange(calibration.metersPerSourceUnit, "$.metersPerSourceUnit", 1e-12, 1e12, issues);
    const sourceValid = finiteInRange(calibration.sourceDistance, "$.sourceDistance", 1e-12, 1e12, issues);
    const referenceValid = finiteInRange(calibration.referenceDistanceM, "$.referenceDistanceM", 1e-12, 1e12, issues);
    if (scaleValid && sourceValid && referenceValid) {
      const expected = (calibration.referenceDistanceM as number) / (calibration.sourceDistance as number);
      const actual = calibration.metersPerSourceUnit as number;
      if (Math.abs(expected - actual) > Math.max(1e-12, Math.abs(expected) * 1e-9)) {
        issues.push(issue("$.metersPerSourceUnit", "inconsistent_value", "Scale must match the reference-distance ratio"));
      }
    }
  }
  if (status !== "uncalibrated" && coordinateValid && calibration.sourceCoordinateSystem === "UNKNOWN") {
    issues.push(issue("$.sourceCoordinateSystem", "inconsistent_value", "Calibrated assets require an explicit coordinate system"));
  }
  return issues;
}

export function parseRealityAssetCalibration(value: unknown): RealityAssetCalibration {
  const issues = validateRealityAssetCalibration(value);
  if (issues.length > 0) throw invalidDescriptor("reality asset calibration", issues);
  return Object.freeze({ ...(value as RealityAssetCalibration) });
}

export function assetIdFromDigest(digest: RealityAssetDigest): RealityAssetId {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new RealityAssetError("invalid_descriptor", "digest must be canonical SHA-256");
  }
  return `ra_${digest.slice(7)}`;
}
