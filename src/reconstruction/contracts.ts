export const PHOTO_RECONSTRUCTION_CONTRACT_VERSION = 1 as const;

/**
 * Host-owned limits for untrusted photo sets. The final Gaussian payload is
 * intentionally aligned with the existing Reality Asset ingress boundary.
 */
export const PHOTO_RECONSTRUCTION_LIMITS = Object.freeze({
  minimumPhotoCount: 2,
  maximumPhotoCount: 400,
  maximumPhotoBytes: 64 * 1024 * 1024,
  maximumPhotoSetBytes: 2 * 1024 * 1024 * 1024,
  /**
   * Logical bytes allowed in Apple Object Capture's recursive intermediate
   * output tree. This is deliberately larger than the accepted final Reality
   * asset while still bounding temporary disk consumption.
   */
  maximumObjectCaptureOutputBytes: 8 * 1024 * 1024 * 1024,
  objectCaptureOutputBytesByProfile: Object.freeze({
    preview: 1 * 1024 * 1024 * 1024,
    balanced: 4 * 1024 * 1024 * 1024,
    quality: 8 * 1024 * 1024 * 1024,
  }),
  objectCaptureMinimumFreeReserveBytes: 512 * 1024 * 1024,
  /**
   * Object Capture can decode substantially more data than the encoded upload
   * size suggests. Profiles therefore have independent aggregate-pixel and
   * process-tree RSS ceilings instead of relying only on the global ingress
   * pixel limit. The native runner also preserves the free-memory reserve
   * below while it is active.
   */
  objectCaptureMaximumPixelsByProfile: Object.freeze({
    preview: 250_000_000,
    balanced: 600_000_000,
    quality: 1_000_000_000,
  }),
  objectCaptureMaximumProcessRssBytesByProfile: Object.freeze({
    preview: 2 * 1024 * 1024 * 1024,
    balanced: 6 * 1024 * 1024 * 1024,
    quality: 8 * 1024 * 1024 * 1024,
  }),
  objectCaptureMinimumFreeMemoryReserveBytes: 1 * 1024 * 1024 * 1024,
  maximumOutputBytes: 256 * 1024 * 1024,
  maximumPixelCount: 100_000_000,
  maximumPhotoSetPixelCount: 1_000_000_000,
  signatureBytes: 64,
  digestChunkBytes: 1024 * 1024,
  defaultUploadTtlMs: 10 * 60_000,
  defaultJobTimeoutMs: 2 * 60 * 60_000,
  /**
   * A browser may need several minutes to stream, preflight, persist, and
   * acknowledge a ready result. The first finalize call leases the job for
   * this bounded interval so the expiry sweeper cannot race that handoff.
   */
  defaultFinalizationLeaseMs: 8 * 60_000,
  // The staged AgentAssetIngress candidate expires after ten minutes. Keep the
  // job's ready view shorter so it never advertises a handle that may already
  // have been discarded by the downstream browser handoff.
  defaultReadyTtlMs: 9 * 60_000,
  maximumWireWarnings: 32,
});

export const PHOTO_RECONSTRUCTION_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export type PhotoReconstructionMediaType = typeof PHOTO_RECONSTRUCTION_MEDIA_TYPES[number];
export type PhotoReconstructionFormat = "jpeg" | "png" | "webp" | "heic";
export type PhotoReconstructionProfile = "preview" | "balanced" | "quality";
export type PhotoReconstructionPhase =
  | "awaiting_upload"
  | "queued"
  | "camera_solving"
  | "training"
  | "packing"
  | "ready"
  | "failed"
  | "cancelled";

export type PhotoReconstructionWarningCode =
  | "low_photo_count"
  | "duplicate_content_removed"
  | "partial_camera_registration"
  | "source_scale_unknown"
  | "source_coordinates_unknown";

export type PhotoReconstructionInput = Readonly<{
  photoId: string;
  mediaType: PhotoReconstructionMediaType;
  byteLength: number;
  sha256: `sha256:${string}`;
}>;

export type BeginPhotoReconstructionInput = Readonly<{
  requestId: string;
  workspaceId: string;
  profile: PhotoReconstructionProfile;
  photos: readonly PhotoReconstructionInput[];
}>;

export type PhotoUploadGrant = Readonly<{
  photoId: string;
  method: "PUT";
  url: string;
  authorization: "Bearer";
  token: string;
  contentType: PhotoReconstructionMediaType;
  contentLength: number;
  expiresAt: string;
}>;

export type PhotoReconstructionBackendIdentity = Readonly<{
  id: string;
  version: string;
}>;

export type PhotoReconstructionResultCandidate = Readonly<{
  candidateHandle: string;
  format: "ply" | "spz" | "sog";
  mediaType: string;
  byteLength: number;
  sha256: `sha256:${string}`;
}>;

export type PhotoReconstructionFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

export type PhotoReconstructionJobView = Readonly<{
  version: typeof PHOTO_RECONSTRUCTION_CONTRACT_VERSION;
  jobId: string;
  requestId: string;
  workspaceId: string;
  photoSetDigest: `sha256:${string}`;
  profile: PhotoReconstructionProfile;
  status: PhotoReconstructionPhase;
  progress: number;
  inputPhotoCount: number;
  uploadedPhotoCount: number;
  registeredPhotoCount?: number;
  backend: PhotoReconstructionBackendIdentity;
  warnings: readonly PhotoReconstructionWarningCode[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  result?: PhotoReconstructionResultCandidate;
  error?: PhotoReconstructionFailure;
}>;

export type BeginPhotoReconstructionResult = Readonly<{
  job: PhotoReconstructionJobView;
  uploads: readonly PhotoUploadGrant[];
}>;

export type PhotoReconstructionValidationIssue = Readonly<{
  path: string;
  code: "invalid_type" | "invalid_value" | "duplicate" | "out_of_range" | "inconsistent_value";
  message: string;
}>;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const PHOTO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MEDIA_TYPES = new Set<string>(PHOTO_RECONSTRUCTION_MEDIA_TYPES);
const PROFILES = new Set<string>(["preview", "balanced", "quality"]);

function issue(
  path: string,
  code: PhotoReconstructionValidationIssue["code"],
  message: string,
): PhotoReconstructionValidationIssue {
  return Object.freeze({ path, code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function formatForPhotoMediaType(mediaType: PhotoReconstructionMediaType): PhotoReconstructionFormat {
  if (mediaType === "image/jpeg") return "jpeg";
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/webp") return "webp";
  return "heic";
}

export function extensionForPhotoMediaType(mediaType: PhotoReconstructionMediaType): string {
  return formatForPhotoMediaType(mediaType) === "jpeg" ? "jpg" : formatForPhotoMediaType(mediaType);
}

export function validateBeginPhotoReconstructionInput(
  value: unknown,
): readonly PhotoReconstructionValidationIssue[] {
  const issues: PhotoReconstructionValidationIssue[] = [];
  if (!isRecord(value)) return [issue("$", "invalid_type", "Photo reconstruction input must be an object")];
  const allowed = new Set(["requestId", "workspaceId", "profile", "photos"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(`$.${key}`, "invalid_value", `$.${key} is not allowed`));
  }
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
    issues.push(issue("$.requestId", "invalid_value", "requestId must be a stable 8-128 character identifier"));
  }
  if (typeof value.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(value.workspaceId)) {
    issues.push(issue("$.workspaceId", "invalid_value", "workspaceId is invalid"));
  }
  if (typeof value.profile !== "string" || !PROFILES.has(value.profile)) {
    issues.push(issue("$.profile", "invalid_value", "profile must be preview, balanced, or quality"));
  }
  if (!Array.isArray(value.photos)) {
    issues.push(issue("$.photos", "invalid_type", "photos must be an array"));
    return issues;
  }
  if (
    value.photos.length < PHOTO_RECONSTRUCTION_LIMITS.minimumPhotoCount
    || value.photos.length > PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount
  ) {
    issues.push(issue(
      "$.photos",
      "out_of_range",
      `photos must contain ${PHOTO_RECONSTRUCTION_LIMITS.minimumPhotoCount}-${PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount} items`,
    ));
  }
  const photoIds = new Set<string>();
  const digests = new Set<string>();
  let totalBytes = 0;
  value.photos.forEach((photo, index) => {
    const path = `$.photos[${index}]`;
    if (!isRecord(photo)) {
      issues.push(issue(path, "invalid_type", `${path} must be an object`));
      return;
    }
    const photoAllowed = new Set(["photoId", "mediaType", "byteLength", "sha256"]);
    for (const key of Object.keys(photo)) {
      if (!photoAllowed.has(key)) issues.push(issue(`${path}.${key}`, "invalid_value", `${path}.${key} is not allowed`));
    }
    if (typeof photo.photoId !== "string" || !PHOTO_ID_PATTERN.test(photo.photoId)) {
      issues.push(issue(`${path}.photoId`, "invalid_value", "photoId is invalid"));
    } else if (photoIds.has(photo.photoId)) {
      issues.push(issue(`${path}.photoId`, "duplicate", "photoId must be unique"));
    } else photoIds.add(photo.photoId);
    if (typeof photo.mediaType !== "string" || !MEDIA_TYPES.has(photo.mediaType)) {
      issues.push(issue(`${path}.mediaType`, "invalid_value", "photo media type is unsupported"));
    }
    if (
      typeof photo.byteLength !== "number"
      || !Number.isSafeInteger(photo.byteLength)
      || photo.byteLength < 1
      || photo.byteLength > PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoBytes
    ) {
      issues.push(issue(`${path}.byteLength`, "out_of_range", "photo byte length is outside the allowed range"));
    } else totalBytes += photo.byteLength;
    if (typeof photo.sha256 !== "string" || !DIGEST_PATTERN.test(photo.sha256)) {
      issues.push(issue(`${path}.sha256`, "invalid_value", "photo digest must be canonical SHA-256"));
    } else if (digests.has(photo.sha256)) {
      issues.push(issue(`${path}.sha256`, "duplicate", "duplicate photo content is not accepted"));
    } else digests.add(photo.sha256);
  });
  if (totalBytes > PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoSetBytes) {
    issues.push(issue("$.photos", "out_of_range", "photo set exceeds its total byte limit"));
  }
  return issues;
}

export function parseBeginPhotoReconstructionInput(value: unknown): BeginPhotoReconstructionInput {
  const issues = validateBeginPhotoReconstructionInput(value);
  if (issues.length) throw new TypeError(`${issues[0]!.path}: ${issues[0]!.message}`);
  const input = value as BeginPhotoReconstructionInput;
  return Object.freeze({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    profile: input.profile,
    photos: Object.freeze(input.photos.map((photo) => Object.freeze({ ...photo }))),
  });
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Byte-signature verification only. Filenames and caller MIME hints are never used as evidence. */
export function photoSignatureMatches(
  bytes: Uint8Array,
  mediaType: PhotoReconstructionMediaType,
): boolean {
  if (mediaType === "image/jpeg") {
    return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  }
  if (mediaType === "image/webp") {
    return bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
  }
  if (bytes.byteLength < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxBytes = view.getUint32(0, false);
  if (boxBytes < 16) return false;
  const acceptedBrands = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
  for (let offset = 8; offset + 4 <= Math.min(boxBytes, bytes.byteLength); offset += 4) {
    if (acceptedBrands.has(ascii(bytes, offset, offset + 4))) return true;
  }
  return false;
}
