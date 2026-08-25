import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";
import {
  PHOTO_RECONSTRUCTION_CONTRACT_VERSION,
  PHOTO_RECONSTRUCTION_LIMITS,
  extensionForPhotoMediaType,
  parseBeginPhotoReconstructionInput,
  photoSignatureMatches,
  type BeginPhotoReconstructionInput,
  type BeginPhotoReconstructionResult,
  type PhotoReconstructionBackendIdentity,
  type PhotoReconstructionFailure,
  type PhotoReconstructionJobView,
  type PhotoReconstructionMediaType,
  type PhotoReconstructionPhase,
  type PhotoReconstructionProfile,
  type PhotoReconstructionResultCandidate,
  type PhotoReconstructionWarningCode,
  type PhotoUploadGrant,
} from "../../src/reconstruction/contracts";
import {
  AgentAssetIngress,
  AgentAssetIngressError,
  MAX_AGENT_ASSET_RESERVATION_TTL_MS,
  type AgentAssetFormat,
  type ApprovedAssetImporter,
} from "../agent/AgentAssetIngress";

export type PhotoReconstructionProgress = Readonly<{
  phase: "camera_solving" | "training" | "packing";
  progress: number;
  registeredPhotoCount?: number;
  warnings?: readonly PhotoReconstructionWarningCode[];
}>;

export type PhotoReconstructionBackendRequest = Readonly<{
  jobId: string;
  workspaceId: string;
  profile: PhotoReconstructionProfile;
  inputDirectory: string;
  outputDirectory: string;
  aggregatePixelCount: number;
  photos: readonly Readonly<{
    photoId: string;
    mediaType: PhotoReconstructionMediaType;
    byteLength: number;
    sha256: `sha256:${string}`;
    path: string;
  }>[];
  signal: AbortSignal;
  onProgress(update: PhotoReconstructionProgress): void;
}>;

export type PhotoReconstructionBackendResult = Readonly<{
  outputPath: string;
  format: AgentAssetFormat;
  registeredPhotoCount?: number;
  warnings?: readonly PhotoReconstructionWarningCode[];
}>;

export interface PhotoReconstructionBackend {
  readonly identity: PhotoReconstructionBackendIdentity;
  probe?(signal?: AbortSignal): Promise<Readonly<{ available: boolean; reason?: string }>>;
  run(request: PhotoReconstructionBackendRequest): Promise<PhotoReconstructionBackendResult>;
}

export class PhotoReconstructionBackendError extends Error {
  constructor(
    readonly code:
      | "backend_unavailable"
      | "insufficient_camera_overlap"
      | "input_decode_failed"
      | "resource_exhausted"
      | "output_invalid",
    readonly retryable = false,
  ) {
    super(code);
    this.name = "PhotoReconstructionBackendError";
  }
}

export class PhotoReconstructionServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PhotoReconstructionServiceError";
  }
}

export type PhotoReconstructionServiceOptions = Readonly<{
  publicBaseUrl: string;
  assetIngress: AgentAssetIngress;
  backend: PhotoReconstructionBackend;
  temporaryDirectory?: string;
  maximumJobs?: number;
  maximumStagedBytes?: number;
  maximumConcurrentUploads?: number;
  maximumConcurrentJobs?: number;
  maximumPhotoSetPixelCount?: number;
  uploadTtlMs?: number;
  jobTimeoutMs?: number;
  readyTtlMs?: number;
  sweepIntervalMs?: number;
  capabilityCacheTtlMs?: number;
  minimumFreeBytesAfterUpload?: number;
  availableTemporaryBytes?: (path: string) => Promise<bigint>;
  now?: () => number;
  removeDirectory?: (directory: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
}>;

type PhotoUploadState = "awaiting_upload" | "uploading" | "ready";

type PhotoGrantRecord = {
  grantId: string;
  uploadToken?: string;
  uploadTokenHash: Buffer;
  state: PhotoUploadState;
  input: BeginPhotoReconstructionInput["photos"][number];
  expiresAt: number;
  partialPath?: string;
  filePath?: string;
  pixelCount?: number;
  abortController: AbortController;
};

type JobRecord = {
  jobId: string;
  requestKey: string;
  principal: ApprovedAssetImporter;
  input: BeginPhotoReconstructionInput;
  photoSetDigest: `sha256:${string}`;
  inputDirectory: string;
  outputDirectory: string;
  grants: Map<string, PhotoGrantRecord>;
  status: PhotoReconstructionPhase;
  progress: number;
  registeredPhotoCount?: number;
  warnings: Set<PhotoReconstructionWarningCode>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  abortController: AbortController;
  activeUploads: Set<Promise<unknown>>;
  result?: PhotoReconstructionResultCandidate;
  error?: PhotoReconstructionFailure;
  execution?: Promise<void>;
  finalizationLeaseUntil?: number;
  finalizedDisplayName?: string;
  directoryCleaned: boolean;
  verifiedPixelCount: number;
};

type PhotoReconstructionCapabilityView = Readonly<{
  backend: PhotoReconstructionBackendIdentity;
  available: boolean;
  reason?: string;
}>;

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const RECONSTRUCTION_ROOT_NAME_PATTERN = /^semaframe-photo-reconstruction-[A-Za-z0-9_-]{6,64}$/u;
const ORPHAN_SAFE_AGE_MS = 5 * 60_000;
const MAX_ORPHAN_DIRECTORY_ENTRIES_PER_PASS = 1_024;
const MAX_ORPHAN_REMOVALS_PER_PASS = 32;
const OWNER_MARKER_NAME = ".semaframe-owner-v1.json";
const OWNER_HEARTBEAT_MS = 60_000;
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1_000);
const MEDIA_TYPE_BY_OUTPUT: Readonly<Record<AgentAssetFormat, string>> = Object.freeze({
  ply: "application/ply",
  spz: "application/x-spz",
  sog: "model/vnd.sog",
});
const OUTPUT_EXTENSION: Readonly<Record<AgentAssetFormat, string>> = Object.freeze({
  ply: "ply",
  spz: "spz",
  sog: "sog",
});
const PHASE_RANK: Readonly<Record<PhotoReconstructionPhase, number>> = Object.freeze({
  awaiting_upload: 0,
  queued: 1,
  camera_solving: 2,
  training: 3,
  packing: 4,
  ready: 5,
  failed: 5,
  cancelled: 5,
});
const BACKEND_FAILURES: Readonly<Record<PhotoReconstructionBackendError["code"], string>> = Object.freeze({
  backend_unavailable: "The configured photo reconstruction backend is unavailable.",
  insufficient_camera_overlap: "The photos did not contain enough overlapping views for reconstruction.",
  input_decode_failed: "One or more uploaded photos could not be decoded by the reconstruction backend.",
  resource_exhausted: "The reconstruction backend exhausted its bounded compute or storage budget.",
  output_invalid: "The reconstruction backend did not produce an acceptable Reality Asset candidate.",
});
const WARNING_CODES = new Set<PhotoReconstructionWarningCode>([
  "low_photo_count",
  "duplicate_content_removed",
  "partial_camera_registration",
  "source_scale_unknown",
  "source_coordinates_unknown",
]);

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function tokenMatches(token: string, expected: Buffer): boolean {
  const actual = tokenHash(token);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Photo reconstruction publicBaseUrl must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  return url.href.replace(/\/$/u, "");
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer.`);
  return value;
}

async function availableFilesystemBytes(path: string): Promise<bigint> {
  const stats = await statfs(path, { bigint: true });
  return stats.bavail * stats.bsize;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

type ReconstructionRootOwner = Readonly<{
  version: 1;
  pid: number;
  processStartedAt: number;
  lease: string;
}>;

function parseReconstructionRootOwner(value: string): ReconstructionRootOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "lease,pid,processStartedAt,version"
    || record.version !== 1
    || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || !Number.isSafeInteger(record.processStartedAt) || Number(record.processStartedAt) <= 0
    || typeof record.lease !== "string" || !HANDLE_PATTERN.test(record.lease)) {
    return undefined;
  }
  return Object.freeze({
    version: 1,
    pid: Number(record.pid),
    processStartedAt: Number(record.processStartedAt),
    lease: record.lease,
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    // EPERM proves that a process exists but is owned by another principal.
    return code !== "ESRCH";
  }
}

function canonicalInput(input: BeginPhotoReconstructionInput): string {
  return JSON.stringify({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    profile: input.profile,
    photos: [...input.photos]
      .map((photo) => ({ ...photo }))
      .sort((left, right) => left.photoId.localeCompare(right.photoId)),
  });
}

function photoSetDigest(input: BeginPhotoReconstructionInput): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalInput(input), "utf8").digest("hex")}`;
}

function inputsMatch(left: BeginPhotoReconstructionInput, right: BeginPhotoReconstructionInput): boolean {
  return canonicalInput(left) === canonicalInput(right);
}

function safeBackendIdentity(identity: PhotoReconstructionBackendIdentity): PhotoReconstructionBackendIdentity {
  const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
  const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
  if (!idPattern.test(identity.id) || !versionPattern.test(identity.version)) {
    throw new Error("Photo reconstruction backend identity is invalid.");
  }
  return Object.freeze({ id: identity.id, version: identity.version });
}

function bodyBytes(body: AsyncIterable<Uint8Array | string>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of body) {
        yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      }
    },
  };
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("The temporary photo file stopped accepting data.");
    offset += bytesWritten;
  }
}

function abortError(): PhotoReconstructionServiceError {
  return new PhotoReconstructionServiceError(410, "photo_upload_cancelled", "The photo upload was cancelled or expired.");
}

function cleanupServiceError(): PhotoReconstructionServiceError {
  return new PhotoReconstructionServiceError(
    500,
    "photo_reconstruction_cleanup_failed",
    "The temporary photo set or staged candidate could not be removed. Retry cancellation or revoke the connection.",
  );
}

async function nextBodyChunk(
  iterator: AsyncIterator<Uint8Array>,
  signals: readonly AbortSignal[],
): Promise<IteratorResult<Uint8Array>> {
  if (signals.some((signal) => signal.aborted)) throw abortError();
  return new Promise<IteratorResult<Uint8Array>>((resolvePromise, reject) => {
    const cleanup = () => signals.forEach((signal) => signal.removeEventListener("abort", abort));
    const abort = () => {
      cleanup();
      reject(abortError());
    };
    signals.forEach((signal) => signal.addEventListener("abort", abort, { once: true }));
    void Promise.resolve(iterator.next()).then(
      (value) => { cleanup(); resolvePromise(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function outputPathIsContained(outputDirectory: string, outputPath: string): boolean {
  const relation = relative(resolve(outputDirectory), resolve(outputPath));
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

function uniqueWarnings(values: Iterable<PhotoReconstructionWarningCode>): readonly PhotoReconstructionWarningCode[] {
  return Object.freeze([...new Set(values)].sort().slice(0, PHOTO_RECONSTRUCTION_LIMITS.maximumWireWarnings));
}

function isWarningCode(value: unknown): value is PhotoReconstructionWarningCode {
  return typeof value === "string" && WARNING_CODES.has(value as PhotoReconstructionWarningCode);
}

function jobIsCancelled(job: JobRecord): boolean {
  return job.status === "cancelled";
}

class ReconstructionAbortedError extends Error {
  constructor() {
    super("reconstruction_aborted");
    this.name = "ReconstructionAbortedError";
  }
}

function raceBackendAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ReconstructionAbortedError());
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => {
      cleanup();
      reject(new ReconstructionAbortedError());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => { cleanup(); resolvePromise(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

class PhotoReconstructionCleanupError extends Error {
  constructor(readonly directory: string, options?: ErrorOptions) {
    super("The photo reconstruction temporary directory could not be removed.", options);
    this.name = "PhotoReconstructionCleanupError";
  }
}

class PhotoReconstructionCandidateCleanupError extends Error {
  constructor(options?: ErrorOptions) {
    super("The staged reconstruction candidate could not be removed.", options);
    this.name = "PhotoReconstructionCandidateCleanupError";
  }
}

async function validateUploadedPhotoMetadata(path: string): Promise<number> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(path, {
      failOn: "error",
      limitInputPixels: PHOTO_RECONSTRUCTION_LIMITS.maximumPixelCount,
      sequentialRead: true,
    }).metadata();
  } catch (cause) {
    const exceedsPixelLimit = cause instanceof Error && /pixel limit/iu.test(cause.message);
    throw new PhotoReconstructionServiceError(
      exceedsPixelLimit ? 413 : 422,
      exceedsPixelLimit ? "photo_pixel_limit_exceeded" : "photo_decode_failed",
      exceedsPixelLimit
        ? "The uploaded photo exceeds the decoded pixel limit."
        : "The uploaded photo could not be decoded.",
    );
  }
  const { width, height } = metadata;
  const pixelCount = Number(width) * Number(height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || Number(width) <= 0 || Number(height) <= 0 || !Number.isSafeInteger(pixelCount)) {
    throw new PhotoReconstructionServiceError(422, "photo_decode_failed", "The uploaded photo has invalid dimensions.");
  }
  if (pixelCount > PHOTO_RECONSTRUCTION_LIMITS.maximumPixelCount) {
    throw new PhotoReconstructionServiceError(
      413,
      "photo_pixel_limit_exceeded",
      "The uploaded photo exceeds the decoded pixel limit.",
    );
  }
  return pixelCount;
}

export class PhotoReconstructionService {
  readonly #publicBaseUrl: string;
  readonly #assetIngress: AgentAssetIngress;
  readonly #backend: PhotoReconstructionBackend;
  readonly #backendIdentity: PhotoReconstructionBackendIdentity;
  readonly #temporaryDirectory: string;
  readonly #maximumJobs: number;
  readonly #maximumStagedBytes: number;
  readonly #maximumConcurrentUploads: number;
  readonly #maximumConcurrentJobs: number;
  readonly #maximumPhotoSetPixelCount: number;
  readonly #uploadTtlMs: number;
  readonly #jobTimeoutMs: number;
  readonly #readyTtlMs: number;
  readonly #capabilityCacheTtlMs: number;
  readonly #minimumFreeBytesAfterUpload: number;
  readonly #availableTemporaryBytes: (path: string) => Promise<bigint>;
  readonly #now: () => number;
  readonly #removeDirectory: (directory: string) => Promise<void>;
  readonly #removeFile: (path: string) => Promise<void>;
  readonly #jobs = new Map<string, JobRecord>();
  readonly #byRequest = new Map<string, JobRecord>();
  readonly #byGrant = new Map<string, Readonly<{ job: JobRecord; grant: PhotoGrantRecord }>>();
  readonly #activeUploads = new Set<Promise<unknown>>();
  readonly #activeJobs = new Set<Promise<unknown>>();
  readonly #capabilityAbortController = new AbortController();
  readonly #startupCleanup: Promise<void>;
  readonly #sweepTimer?: ReturnType<typeof setInterval>;
  readonly #ownerLease = opaqueToken();
  #ownerHeartbeat?: ReturnType<typeof setInterval>;
  #ownerMarkerPath?: string;
  #rootPromise?: Promise<string>;
  #beginTail: Promise<void> = Promise.resolve();
  #uploadWriteTail: Promise<void> = Promise.resolve();
  #capabilityCache?: Readonly<{ expiresAt: number; value: PhotoReconstructionCapabilityView }>;
  #capabilityProbe?: Promise<PhotoReconstructionCapabilityView>;
  #closePromise?: Promise<void>;
  #closed = false;

  constructor(options: PhotoReconstructionServiceOptions) {
    this.#publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
    this.#assetIngress = options.assetIngress;
    this.#backend = options.backend;
    this.#backendIdentity = safeBackendIdentity(options.backend.identity);
    this.#temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    if (!isAbsolute(this.#temporaryDirectory) || this.#temporaryDirectory.includes("\u0000")) {
      throw new Error("temporaryDirectory must be an absolute path.");
    }
    this.#maximumJobs = positiveInteger("maximumJobs", options.maximumJobs ?? 8);
    this.#maximumStagedBytes = positiveInteger(
      "maximumStagedBytes",
      options.maximumStagedBytes ?? PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoSetBytes,
    );
    this.#maximumConcurrentUploads = positiveInteger(
      "maximumConcurrentUploads",
      options.maximumConcurrentUploads ?? 4,
    );
    this.#maximumConcurrentJobs = positiveInteger("maximumConcurrentJobs", options.maximumConcurrentJobs ?? 1);
    this.#maximumPhotoSetPixelCount = positiveInteger(
      "maximumPhotoSetPixelCount",
      options.maximumPhotoSetPixelCount ?? PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoSetPixelCount,
    );
    if (this.#maximumPhotoSetPixelCount > PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoSetPixelCount) {
      throw new RangeError("maximumPhotoSetPixelCount cannot exceed the host photo-set pixel limit.");
    }
    this.#uploadTtlMs = positiveInteger(
      "uploadTtlMs",
      options.uploadTtlMs ?? PHOTO_RECONSTRUCTION_LIMITS.defaultUploadTtlMs,
    );
    this.#jobTimeoutMs = positiveInteger(
      "jobTimeoutMs",
      options.jobTimeoutMs ?? PHOTO_RECONSTRUCTION_LIMITS.defaultJobTimeoutMs,
    );
    this.#readyTtlMs = positiveInteger(
      "readyTtlMs",
      options.readyTtlMs ?? PHOTO_RECONSTRUCTION_LIMITS.defaultReadyTtlMs,
    );
    this.#capabilityCacheTtlMs = positiveInteger(
      "capabilityCacheTtlMs",
      options.capabilityCacheTtlMs ?? 60_000,
    );
    this.#minimumFreeBytesAfterUpload = nonNegativeInteger(
      "minimumFreeBytesAfterUpload",
      options.minimumFreeBytesAfterUpload
        ?? PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeReserveBytes,
    );
    this.#availableTemporaryBytes = options.availableTemporaryBytes ?? availableFilesystemBytes;
    this.#now = options.now ?? Date.now;
    this.#removeDirectory = options.removeDirectory ?? ((directory) => rm(directory, { recursive: true, force: true }));
    this.#removeFile = options.removeFile ?? unlink;
    const sweepIntervalMs = options.sweepIntervalMs ?? Math.min(30_000, this.#uploadTtlMs, this.#readyTtlMs);
    if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 0) {
      throw new RangeError("sweepIntervalMs must be a non-negative integer.");
    }
    // Start orphan reclamation as soon as the service exists, without creating
    // either the configured parent or a new reconstruction root. Public entry
    // points await this same one-shot promise, while this handler prevents a
    // caller that never invokes them from causing an unhandled rejection.
    this.#startupCleanup = this.#cleanupStaleRootsAtStartup();
    void this.#startupCleanup.catch(() => undefined);
    if (sweepIntervalMs > 0) {
      this.#sweepTimer = setInterval(() => {
        // A failed physical cleanup remains attached to its job for the next
        // bounded sweep. Timer callbacks must never create an unhandled
        // rejection or log a private path.
        void this.sweepExpired().catch(() => undefined);
      }, sweepIntervalMs);
      this.#sweepTimer.unref?.();
    }
  }

  matchesUploadPath(pathname: string): boolean {
    return /^\/v1\/reconstructions\/photo-uploads\/[0-9a-f-]{36}$/iu.test(pathname);
  }

  capability(): Promise<PhotoReconstructionCapabilityView> {
    this.#assertOpen();
    const cached = this.#capabilityCache;
    if (cached && cached.expiresAt > this.#now()) return Promise.resolve(cached.value);
    if (this.#capabilityProbe) return this.#capabilityProbe;
    const operation = this.#probeCapability();
    this.#capabilityProbe = operation;
    void operation.finally(() => {
      if (this.#capabilityProbe === operation) this.#capabilityProbe = undefined;
    }).catch(() => undefined);
    return operation;
  }

  async #probeCapability(): Promise<PhotoReconstructionCapabilityView> {
    await this.#startupCleanup;
    this.#assertOpen();
    let value: PhotoReconstructionCapabilityView;
    if (!this.#backend.probe) {
      value = Object.freeze({ backend: this.#backendIdentity, available: true });
      this.#capabilityCache = Object.freeze({ expiresAt: this.#now() + this.#capabilityCacheTtlMs, value });
      return value;
    }
    try {
      const result = await this.#backend.probe(this.#capabilityAbortController.signal);
      value = Object.freeze({
        backend: this.#backendIdentity,
        available: result.available,
        ...(result.available || !result.reason ? {} : { reason: "The configured reconstruction backend is unavailable." }),
      });
    } catch {
      value = Object.freeze({
        backend: this.#backendIdentity,
        available: false,
        reason: "The configured reconstruction backend is unavailable.",
      });
    }
    this.#capabilityCache = Object.freeze({ expiresAt: this.#now() + this.#capabilityCacheTtlMs, value });
    return value;
  }

  capabilities(): ReturnType<PhotoReconstructionService["capability"]> {
    return this.capability();
  }

  probe(): ReturnType<PhotoReconstructionService["capability"]> {
    return this.capability();
  }

  begin(
    principal: ApprovedAssetImporter,
    rawInput: unknown,
  ): Promise<BeginPhotoReconstructionResult> {
    const previous = this.#beginTail;
    let release!: () => void;
    this.#beginTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    return previous.then(() => this.#beginExclusive(principal, rawInput)).finally(release);
  }

  async #beginExclusive(
    principal: ApprovedAssetImporter,
    rawInput: unknown,
  ): Promise<BeginPhotoReconstructionResult> {
    this.#assertOpen();
    await this.#startupCleanup;
    this.#assertOpen();
    await this.sweepExpired();
    this.#assertOpen();
    if (!principal.authorizationId || principal.authorizationId.length > 128) {
      throw new PhotoReconstructionServiceError(
        403,
        "photo_reconstruction_not_authorized",
        "An approved photo reconstruction connection is required.",
      );
    }
    let input: BeginPhotoReconstructionInput;
    try {
      input = parseBeginPhotoReconstructionInput(rawInput);
    } catch (error) {
      throw new PhotoReconstructionServiceError(
        400,
        "invalid_photo_set",
        error instanceof Error ? error.message : "Photo reconstruction input is invalid.",
      );
    }
    const requestKey = `${principal.authorizationId}\u0000${input.requestId}`;
    const existing = this.#byRequest.get(requestKey);
    if (existing) {
      if (!inputsMatch(existing.input, input)) {
        throw new PhotoReconstructionServiceError(
          409,
          "photo_reconstruction_idempotency_conflict",
          "requestId was already used with a different photo-set manifest.",
        );
      }
      return this.#beginView(existing);
    }
    if (this.#jobs.size >= this.#maximumJobs) {
      throw new PhotoReconstructionServiceError(429, "photo_reconstruction_busy", "Too many photo reconstruction jobs are pending.");
    }
    const declaredBytes = input.photos.reduce((total, photo) => total + photo.byteLength, 0);
    const reservedBytes = [...this.#jobs.values()]
      // A terminal state does not prove bytes are gone: explicit cleanup
      // failures remain tracked for retry and must continue consuming quota.
      .filter((job) => !job.directoryCleaned)
      .reduce((total, job) => total + job.input.photos.reduce((sum, photo) => sum + photo.byteLength, 0), 0);
    if (reservedBytes + declaredBytes > this.#maximumStagedBytes) {
      throw new PhotoReconstructionServiceError(
        429,
        "photo_reconstruction_capacity_exceeded",
        "The temporary photo-set staging capacity is exhausted.",
      );
    }
    const now = this.#now();
    const jobId = randomUUID();
    const root = await this.#root();
    this.#assertOpen();
    const jobDirectory = join(root, jobId);
    const inputDirectory = join(jobDirectory, "input");
    const outputDirectory = join(jobDirectory, "output");
    try {
      await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
      this.#assertOpen();
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      this.#assertOpen();
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const job: JobRecord = {
      jobId,
      requestKey,
      principal: Object.freeze({ ...principal }),
      input,
      photoSetDigest: photoSetDigest(input),
      inputDirectory,
      outputDirectory,
      grants: new Map(),
      status: "awaiting_upload",
      progress: 0,
      warnings: new Set(input.photos.length < 20 ? ["low_photo_count"] : []),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.#uploadTtlMs,
      abortController: new AbortController(),
      activeUploads: new Set(),
      directoryCleaned: false,
      verifiedPixelCount: 0,
    };
    for (const photo of input.photos) {
      const uploadToken = opaqueToken();
      const grant: PhotoGrantRecord = {
        grantId: randomUUID(),
        uploadToken,
        uploadTokenHash: tokenHash(uploadToken),
        state: "awaiting_upload",
        input: photo,
        expiresAt: job.expiresAt,
        abortController: new AbortController(),
      };
      job.grants.set(photo.photoId, grant);
      this.#byGrant.set(grant.grantId, { job, grant });
    }
    this.#jobs.set(job.jobId, job);
    this.#byRequest.set(requestKey, job);
    return this.#beginView(job);
  }

  upload(
    pathOrGrantId: string,
    uploadToken: string | undefined,
    mediaType: string | undefined,
    contentLength: number | undefined,
    body: AsyncIterable<Uint8Array | string> | undefined,
    signal?: AbortSignal,
  ): Promise<PhotoReconstructionJobView> {
    const grantId = pathOrGrantId.includes("/")
      ? pathOrGrantId.slice(pathOrGrantId.lastIndexOf("/") + 1)
      : pathOrGrantId;
    const operation = this.#performUpload(grantId, uploadToken, mediaType, contentLength, body, signal);
    const job = this.#byGrant.get(grantId)?.job;
    job?.activeUploads.add(operation);
    this.#activeUploads.add(operation);
    void operation.finally(() => {
      job?.activeUploads.delete(operation);
      this.#activeUploads.delete(operation);
    }).catch(() => undefined);
    return operation;
  }

  async #performUpload(
    grantId: string,
    uploadToken: string | undefined,
    mediaType: string | undefined,
    contentLength: number | undefined,
    body: AsyncIterable<Uint8Array | string> | undefined,
    signal?: AbortSignal,
  ): Promise<PhotoReconstructionJobView> {
    this.#assertOpen();
    await this.sweepExpired();
    const pair = this.#byGrant.get(grantId);
    if (!pair || pair.job.status !== "awaiting_upload") {
      throw new PhotoReconstructionServiceError(404, "photo_upload_not_found", "The photo upload grant is invalid or expired.");
    }
    const { job, grant } = pair;
    if (!uploadToken || !tokenMatches(uploadToken, grant.uploadTokenHash)) {
      throw new PhotoReconstructionServiceError(401, "photo_upload_unauthorized", "A valid one-time photo upload bearer is required.");
    }
    if (grant.state === "ready") return this.#jobView(job);
    if (grant.state === "uploading") {
      throw new PhotoReconstructionServiceError(409, "photo_upload_in_progress", "This photo upload is already in progress.");
    }
    if ([...this.#byGrant.values()].filter(({ grant: candidate }) => candidate.state === "uploading").length
      >= this.#maximumConcurrentUploads) {
      throw new PhotoReconstructionServiceError(429, "photo_upload_busy", "The photo upload concurrency limit is reached.");
    }
    if (grant.expiresAt <= this.#now()) {
      await this.#failJob(job, "photo_upload_expired", "The photo-set upload expired before completion.", true);
      throw new PhotoReconstructionServiceError(410, "photo_upload_expired", "The photo upload grant expired.");
    }
    if (mediaType?.toLowerCase() !== grant.input.mediaType) {
      throw new PhotoReconstructionServiceError(415, "photo_media_type_mismatch", "The upload Content-Type does not match its grant.");
    }
    if (contentLength !== grant.input.byteLength) {
      throw new PhotoReconstructionServiceError(400, "photo_length_header_mismatch", "Content-Length must match the granted byte length.");
    }
    if (!body) throw new PhotoReconstructionServiceError(400, "photo_body_required", "The granted photo request body is required.");

    // Reserve the one-use grant and concurrency slot before any awaited
    // cleanup. A retry may need to delete a retained .partial file, but a
    // second retry must observe that ownership rather than racing the same
    // path between cleanup and open("wx").
    grant.state = "uploading";
    if (grant.partialPath) {
      try {
        await this.#removeUploadFile(grant.partialPath);
        grant.partialPath = undefined;
      } catch {
        if (this.#byGrant.has(grantId) && job.status === "awaiting_upload") {
          grant.state = "awaiting_upload";
        }
        throw cleanupServiceError();
      }
    }
    const partialPath = join(job.inputDirectory, `${grant.grantId}.partial`);
    const finalPath = join(
      job.inputDirectory,
      `${grant.grantId}.${extensionForPhotoMediaType(grant.input.mediaType)}`,
    );
    grant.partialPath = partialPath;
    let file: FileHandle | undefined;
    let written = 0;
    let prefix = new Uint8Array(0);
    let reservedPixelCount = 0;
    let renamed = false;
    const digest = createHash("sha256");
    const iterator = bodyBytes(body)[Symbol.asyncIterator]();
    const deadline = setTimeout(
      () => grant.abortController.abort(),
      Math.max(1, grant.expiresAt - this.#now()),
    );
    deadline.unref?.();
    try {
      file = await open(partialPath, "wx", 0o600);
      while (true) {
        const signals = signal
          ? [grant.abortController.signal, job.abortController.signal, signal]
          : [grant.abortController.signal, job.abortController.signal];
        const next = await nextBodyChunk(iterator, signals);
        if (next.done) break;
        const bytes = next.value;
        written += bytes.byteLength;
        if (written > grant.input.byteLength || written > PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoBytes) {
          throw new PhotoReconstructionServiceError(413, "photo_body_too_large", "The upload exceeds its granted byte length.");
        }
        if (prefix.byteLength < PHOTO_RECONSTRUCTION_LIMITS.signatureBytes) {
          const needed = PHOTO_RECONSTRUCTION_LIMITS.signatureBytes - prefix.byteLength;
          const addition = bytes.subarray(0, needed);
          const combined = new Uint8Array(prefix.byteLength + addition.byteLength);
          combined.set(prefix);
          combined.set(addition, prefix.byteLength);
          prefix = combined;
        }
        digest.update(bytes);
        for (let offset = 0; offset < bytes.byteLength; offset += PHOTO_RECONSTRUCTION_LIMITS.digestChunkBytes) {
          const bounded = bytes.subarray(
            offset,
            Math.min(bytes.byteLength, offset + PHOTO_RECONSTRUCTION_LIMITS.digestChunkBytes),
          );
          await this.#writeUploadChunkWithReserve(file, job.inputDirectory, bounded, signals);
        }
      }
      if (written !== grant.input.byteLength) {
        throw new PhotoReconstructionServiceError(422, "photo_size_mismatch", "The uploaded photo does not match its declared byte length.");
      }
      const actualDigest = `sha256:${digest.digest("hex")}`;
      if (actualDigest !== grant.input.sha256) {
        throw new PhotoReconstructionServiceError(422, "photo_digest_mismatch", "The uploaded photo does not match its SHA-256 digest.");
      }
      if (!photoSignatureMatches(prefix, grant.input.mediaType)) {
        throw new PhotoReconstructionServiceError(415, "photo_signature_mismatch", "The uploaded bytes are not the declared photo format.");
      }
      await file.sync();
      await file.close();
      file = undefined;
      const pixelCount = await validateUploadedPhotoMetadata(partialPath);
      if (job.verifiedPixelCount + pixelCount > this.#maximumPhotoSetPixelCount) {
        throw new PhotoReconstructionServiceError(
          413,
          "photo_set_pixel_limit_exceeded",
          "The verified photo set exceeds the decoded pixel limit.",
        );
      }
      job.verifiedPixelCount += pixelCount;
      grant.pixelCount = pixelCount;
      reservedPixelCount = pixelCount;
      if (grant.abortController.signal.aborted || job.abortController.signal.aborted || !this.#byGrant.has(grantId)) {
        throw abortError();
      }
      await rename(partialPath, finalPath);
      renamed = true;
      grant.partialPath = undefined;
      grant.filePath = finalPath;
      grant.state = "ready";
      // The bearer only needs to remain in clear text while an idempotent begin
      // call may need to return an outstanding upload grant. Retain only the
      // digest once the upload is complete.
      grant.uploadToken = undefined;
      job.updatedAt = this.#now();
      return this.#jobView(job);
    } catch (error) {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      await file?.close().catch(() => undefined);
      if (reservedPixelCount > 0 && grant.state !== "ready") {
        job.verifiedPixelCount = Math.max(0, job.verifiedPixelCount - reservedPixelCount);
        grant.pixelCount = undefined;
      }
      const cleanupPath = renamed ? finalPath : partialPath;
      let cleanupFailed = false;
      try {
        await this.#removeUploadFile(cleanupPath);
        grant.partialPath = undefined;
      } catch {
        // Keep the exact generated path attached to the grant. A later upload
        // retries removal before opening with `wx`, while cancel/revoke can
        // still remove the containing private job directory.
        grant.partialPath = cleanupPath;
        cleanupFailed = true;
      }
      if (this.#byGrant.has(grantId) && job.status === "awaiting_upload") grant.state = "awaiting_upload";
      if (cleanupFailed) throw cleanupServiceError();
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  async #writeUploadChunkWithReserve(
    file: FileHandle,
    capacityPath: string,
    bytes: Uint8Array,
    signals: readonly AbortSignal[],
  ): Promise<void> {
    const previous = this.#uploadWriteTail;
    let release!: () => void;
    const turn = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.#uploadWriteTail = previous.then(() => turn);
    await previous;
    try {
      if (signals.some((signal) => signal.aborted)) throw abortError();
      let available: bigint;
      try {
        available = await this.#availableTemporaryBytes(capacityPath);
      } catch {
        throw new PhotoReconstructionServiceError(
          507,
          "photo_upload_storage_unavailable",
          "Temporary photo storage capacity could not be verified safely.",
        );
      }
      if (typeof available !== "bigint" || available < 0n) {
        throw new PhotoReconstructionServiceError(
          507,
          "photo_upload_storage_unavailable",
          "Temporary photo storage capacity could not be verified safely.",
        );
      }
      const required = BigInt(this.#minimumFreeBytesAfterUpload) + BigInt(bytes.byteLength);
      if (available < required) {
        throw new PhotoReconstructionServiceError(
          507,
          "photo_upload_storage_exhausted",
          "The temporary volume cannot accept this photo while preserving its free-space reserve.",
        );
      }
      if (signals.some((signal) => signal.aborted)) throw abortError();
      await writeAll(file, bytes);
    } finally {
      release();
    }
  }

  async inspect(
    jobId: string,
    authorizationId: string,
    workspaceId?: string,
  ): Promise<PhotoReconstructionJobView> {
    this.#assertOpen();
    await this.sweepExpired();
    this.#assertOpen();
    return this.#jobView(this.#ownedJob(jobId, authorizationId, workspaceId));
  }

  async start(jobId: string, authorizationId: string, workspaceId?: string): Promise<PhotoReconstructionJobView> {
    this.#assertOpen();
    await this.sweepExpired();
    this.#assertOpen();
    const job = this.#ownedJob(jobId, authorizationId, workspaceId);
    if (job.status === "awaiting_upload") {
      if (![...job.grants.values()].every((grant) => grant.state === "ready")) {
        throw new PhotoReconstructionServiceError(
          409,
          "photo_set_incomplete",
          "Every digest-bound photo must finish uploading before reconstruction can start.",
        );
      }
      const verifiedPixelCount = [...job.grants.values()].reduce(
        (total, grant) => total + (grant.pixelCount ?? 0),
        0,
      );
      if (!Number.isSafeInteger(verifiedPixelCount)
        || verifiedPixelCount !== job.verifiedPixelCount
        || [...job.grants.values()].some((grant) => !Number.isSafeInteger(grant.pixelCount))
        || verifiedPixelCount > this.#maximumPhotoSetPixelCount) {
        throw new PhotoReconstructionServiceError(
          413,
          "photo_set_pixel_limit_exceeded",
          "The verified photo set exceeds the decoded pixel limit.",
        );
      }
      job.status = "queued";
      job.progress = Math.max(job.progress, 0.01);
      job.updatedAt = this.#now();
      job.expiresAt = job.updatedAt + this.#jobTimeoutMs;
      this.#pumpQueue();
    }
    return this.#jobView(job);
  }

  async finalize(
    jobId: string,
    principalOrAuthorizationId: ApprovedAssetImporter | string,
    workspaceIdOrOptions?: string | Readonly<{ expectedOutputSha256?: string; displayName?: string }>,
    explicitOptions: Readonly<{ expectedOutputSha256?: string; displayName?: string }> = {},
  ): Promise<PhotoReconstructionResultCandidate> {
    this.#assertOpen();
    await this.sweepExpired();
    this.#assertOpen();
    const authorizationId = typeof principalOrAuthorizationId === "string"
      ? principalOrAuthorizationId
      : principalOrAuthorizationId.authorizationId;
    const workspaceId = typeof workspaceIdOrOptions === "string" ? workspaceIdOrOptions : undefined;
    const options = workspaceIdOrOptions !== null && typeof workspaceIdOrOptions === "object"
      ? workspaceIdOrOptions
      : explicitOptions;
    const job = this.#ownedJob(jobId, authorizationId, workspaceId);
    const normalizedDisplayName = typeof options.displayName === "string"
      ? options.displayName.normalize("NFC").trim()
      : undefined;
    if (options.displayName !== undefined && (normalizedDisplayName === undefined || (
      normalizedDisplayName.length < 1
      || normalizedDisplayName.length > 255
      || /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069/\\]/u.test(normalizedDisplayName)
      || normalizedDisplayName === "."
      || normalizedDisplayName === ".."
      || /^[a-z][a-z0-9+.-]*:/iu.test(normalizedDisplayName)
    ))) {
      throw new PhotoReconstructionServiceError(400, "invalid_display_name", "displayName must be a plain bounded label.");
    }
    if (job.status === "failed") {
      throw new PhotoReconstructionServiceError(
        422,
        "photo_reconstruction_failed",
        "Photo reconstruction completed without a usable asset candidate.",
      );
    }
    if (job.status === "ready" && !job.result) {
      throw new PhotoReconstructionServiceError(
        422,
        "photo_reconstruction_output_missing",
        "Photo reconstruction completed without a usable asset candidate.",
      );
    }
    if (job.status !== "ready" || !job.result) {
      throw new PhotoReconstructionServiceError(409, "photo_reconstruction_not_ready", "Photo reconstruction has not produced a ready asset candidate.");
    }
    if (options.expectedOutputSha256 !== undefined
      && !/^sha256:[a-f0-9]{64}$/u.test(options.expectedOutputSha256)) {
      throw new PhotoReconstructionServiceError(
        400,
        "invalid_output_digest",
        "expectedOutputSha256 must be a canonical SHA-256 digest.",
      );
    }
    if (options.expectedOutputSha256 !== undefined && options.expectedOutputSha256 !== job.result.sha256) {
      throw new PhotoReconstructionServiceError(409, "photo_reconstruction_digest_mismatch", "The completed output does not match the expected SHA-256 digest.");
    }
    if (normalizedDisplayName !== undefined) {
      if (job.finalizedDisplayName !== undefined && job.finalizedDisplayName !== normalizedDisplayName) {
        throw new PhotoReconstructionServiceError(
          409,
          "photo_reconstruction_finalization_conflict",
          "This reconstruction was already finalized with a different displayName.",
        );
      }
      // Claim the final label synchronously before any ingress await. Parallel
      // finalize retries can use the same normalized label, but cannot race two
      // different human-visible identities onto one content capability.
      job.finalizedDisplayName ??= normalizedDisplayName;
    }
    const now = this.#now();
    job.finalizationLeaseUntil ??= now + PHOTO_RECONSTRUCTION_LIMITS.defaultFinalizationLeaseMs;
    job.expiresAt = Math.max(job.expiresAt, job.finalizationLeaseUntil);
    job.updatedAt = now;
    try {
      if (job.finalizedDisplayName !== undefined) {
        await this.#assetIngress.relabelCandidate(
          job.result.candidateHandle,
          job.principal.authorizationId,
          job.input.workspaceId,
          job.finalizedDisplayName,
        );
      }
      await this.#assetIngress.reserveCandidate(
        job.result.candidateHandle,
        job.principal.authorizationId,
        job.input.workspaceId,
        Math.min(
          MAX_AGENT_ASSET_RESERVATION_TTL_MS,
          Math.max(1, job.finalizationLeaseUntil - now + 60_000),
        ),
      );
    } catch (error) {
      if (error instanceof AgentAssetIngressError && error.code === "asset_candidate_not_found") {
        job.result = undefined;
        job.status = "failed";
        job.error = Object.freeze({
          code: "photo_reconstruction_output_expired",
          message: "The reconstructed Reality Asset candidate expired before browser verification.",
          retryable: true,
        });
        job.expiresAt = now + this.#readyTtlMs;
        throw new PhotoReconstructionServiceError(
          410,
          "photo_reconstruction_output_expired",
          "The reconstructed Reality Asset candidate expired before browser verification.",
        );
      }
      throw error;
    }
    return Object.freeze({ ...job.result });
  }

  async cancel(
    jobId: string,
    authorizationId: string,
    workspaceId?: string,
  ): Promise<Readonly<{ cancelled: true; job: PhotoReconstructionJobView }>> {
    this.#assertOpen();
    await this.sweepExpired();
    this.#assertOpen();
    const job = this.#ownedJob(jobId, authorizationId, workspaceId);
    if (job.status !== "cancelled") {
      job.status = "cancelled";
      job.progress = Math.min(job.progress, 0.999999);
      job.error = undefined;
      job.updatedAt = this.#now();
      job.expiresAt = job.updatedAt + this.#readyTtlMs;
      job.abortController.abort();
      for (const grant of job.grants.values()) grant.abortController.abort();
      await Promise.allSettled([
        ...job.activeUploads,
        ...(job.execution ? [job.execution] : []),
      ]);
      this.#pumpQueue();
    }
    try {
      await this.#cleanupJobResources(job);
    } catch (error) {
      this.#recordCleanupFailure(job, error);
      throw cleanupServiceError();
    }
    job.status = "cancelled";
    job.result = undefined;
    job.error = undefined;
    job.updatedAt = this.#now();
    job.expiresAt = job.updatedAt + this.#readyTtlMs;
    return Object.freeze({ cancelled: true, job: this.#jobView(job) });
  }

  async sweepExpired(): Promise<void> {
    if (this.#closed) return;
    const now = this.#now();
    const failures: unknown[] = [];
    for (const job of [...this.#jobs.values()]) {
      if (job.finalizationLeaseUntil !== undefined && job.finalizationLeaseUntil > now) continue;
      if (job.expiresAt > now) continue;
      try {
        if (job.status === "awaiting_upload") {
          await this.#failJob(job, "photo_upload_expired", "The photo-set upload expired before completion.", true);
        } else if (job.status === "queued") {
          await this.#failJob(job, "reconstruction_timeout", "The photo reconstruction exceeded its time limit.", true);
        } else if (["camera_solving", "training", "packing"].includes(job.status)) {
          job.abortController.abort();
        } else if (["ready", "failed", "cancelled"].includes(job.status)) {
          await this.#discardJob(job);
        }
      } catch (error) {
        this.#recordCleanupFailure(job, error);
        failures.push(cleanupServiceError());
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Multiple expired photo reconstruction jobs could not be cleaned.");
    }
  }

  /** Immediately removes every job and staged candidate owned by a revoked pairing. */
  async revokeAuthorization(authorizationId: string): Promise<void> {
    this.#assertOpen();
    if (!authorizationId) return;
    await this.#beginTail;
    this.#assertOpen();
    await this.#revokeJobs(
      [...this.#jobs.values()].filter((job) => job.principal.authorizationId === authorizationId),
    );
  }

  /** Immediately removes all reconstruction jobs and candidates without closing the reusable service. */
  async revokeAll(): Promise<void> {
    this.#assertOpen();
    await this.#beginTail;
    this.#assertOpen();
    await this.#revokeJobs([...this.#jobs.values()]);
  }

  /** Revokes every job except one explicitly retained host authorization. */
  async revokeAllExceptAuthorization(retainedAuthorizationId: string): Promise<void> {
    this.#assertOpen();
    if (!retainedAuthorizationId) throw new TypeError("retainedAuthorizationId is required.");
    await this.#beginTail;
    this.#assertOpen();
    await this.#revokeJobs(
      [...this.#jobs.values()].filter(
        (job) => job.principal.authorizationId !== retainedAuthorizationId,
      ),
    );
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const operation = this.#performClose();
    this.#closePromise = operation;
    void operation.catch(() => {
      if (this.#closePromise === operation) this.#closePromise = undefined;
    });
    return operation;
  }

  async #performClose(): Promise<void> {
    this.#closed = true;
    this.#capabilityAbortController.abort();
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    if (this.#ownerHeartbeat) clearInterval(this.#ownerHeartbeat);
    await this.#beginTail;
    await this.#startupCleanup;
    await this.#revokeJobs([...this.#jobs.values()]);
    await Promise.allSettled([
      ...this.#activeUploads,
      ...this.#activeJobs,
      ...(this.#capabilityProbe ? [this.#capabilityProbe] : []),
    ]);
    const root = await this.#rootPromise;
    if (root) {
      try {
        await this.#removeDirectory(root);
      } catch {
        throw cleanupServiceError();
      }
    }
    this.#ownerMarkerPath = undefined;
    this.#jobs.clear();
    this.#byRequest.clear();
    this.#byGrant.clear();
  }

  async #revokeJobs(jobs: readonly JobRecord[]): Promise<void> {
    if (!jobs.length) return;
    for (const job of jobs) {
      job.status = "cancelled";
      job.error = undefined;
      job.abortController.abort();
      for (const grant of job.grants.values()) grant.abortController.abort();
    }
    await Promise.allSettled(jobs.flatMap((job) => [
      ...job.activeUploads,
      ...(job.execution ? [job.execution] : []),
    ]));
    const cleanupFailures: unknown[] = [];
    for (const job of jobs) {
      try {
        await this.#discardJob(job);
      } catch (error) {
        this.#recordCleanupFailure(job, error);
        cleanupFailures.push(cleanupServiceError());
      }
    }
    this.#pumpQueue();
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, "Multiple photo reconstruction directories could not be removed.");
    }
  }

  #pumpQueue(): void {
    if (this.#closed) return;
    const running = [...this.#jobs.values()].filter((job) =>
      ["camera_solving", "training", "packing"].includes(job.status)).length;
    let slots = this.#maximumConcurrentJobs - running;
    if (slots <= 0) return;
    const queued = [...this.#jobs.values()]
      .filter((job) => job.status === "queued" && !job.execution)
      .sort((left, right) => left.createdAt - right.createdAt || left.jobId.localeCompare(right.jobId));
    for (const job of queued) {
      if (slots <= 0) break;
      slots -= 1;
      const execution = this.#execute(job);
      job.execution = execution;
      this.#activeJobs.add(execution);
      void execution.finally(() => {
        this.#activeJobs.delete(execution);
        job.execution = undefined;
        this.#pumpQueue();
      }).catch(() => undefined);
    }
  }

  async #execute(job: JobRecord): Promise<void> {
    if (job.status !== "queued" || job.abortController.signal.aborted) return;
    const remainingMs = job.expiresAt - this.#now();
    if (remainingMs <= 0) {
      await this.#failJob(job, "reconstruction_timeout", "The photo reconstruction exceeded its time limit.", true);
      return;
    }
    job.status = "camera_solving";
    job.progress = Math.max(job.progress, 0.02);
    job.updatedAt = this.#now();
    const timeout = setTimeout(() => job.abortController.abort(), Math.max(1, remainingMs));
    timeout.unref?.();
    try {
      if (this.#backend.probe) {
        const capability = await raceBackendAbort(this.capability(), job.abortController.signal);
        if (!capability.available) throw new PhotoReconstructionBackendError("backend_unavailable", true);
      }
      // The backend owns abort-aware process termination and must settle before
      // we delete its private directories. Racing the signal here would let a
      // still-running Object Capture child write after confirmed cancellation.
      const result = await this.#backend.run({
        jobId: job.jobId,
        workspaceId: job.input.workspaceId,
        profile: job.input.profile,
        inputDirectory: job.inputDirectory,
        outputDirectory: job.outputDirectory,
        aggregatePixelCount: job.verifiedPixelCount,
        photos: Object.freeze(job.input.photos.map((photo) => {
          const grant = job.grants.get(photo.photoId);
          if (!grant?.filePath) throw new PhotoReconstructionBackendError("input_decode_failed");
          return Object.freeze({ ...photo, path: grant.filePath });
        })),
        signal: job.abortController.signal,
        onProgress: (update) => this.#acceptProgress(job, update),
      });
      if (job.abortController.signal.aborted || jobIsCancelled(job)) {
        if (!jobIsCancelled(job)) {
          await this.#failJob(job, "reconstruction_timeout", "The photo reconstruction exceeded its time limit.", true);
        }
        return;
      }
      if (!(["ply", "spz", "sog"] as const).includes(result.format)) {
        throw new PhotoReconstructionBackendError("output_invalid");
      }
      if (!outputPathIsContained(job.outputDirectory, result.outputPath)) {
        throw new PhotoReconstructionBackendError("output_invalid");
      }
      this.#acceptProgress(job, { phase: "packing", progress: 0.95 });
      if (result.registeredPhotoCount !== undefined) {
        if (Number.isSafeInteger(result.registeredPhotoCount)
          && result.registeredPhotoCount >= 0
          && result.registeredPhotoCount <= job.input.photos.length) {
          job.registeredPhotoCount = result.registeredPhotoCount;
        }
      }
      if (job.registeredPhotoCount !== undefined) {
        if (job.registeredPhotoCount < job.input.photos.length) job.warnings.add("partial_camera_registration");
        else job.warnings.delete("partial_camera_registration");
      }
      for (const warning of result.warnings ?? []) {
        if (isWarningCode(warning)) job.warnings.add(warning);
      }
      const candidate = await this.#stageOutput(job, result.outputPath, result.format);
      if (job.abortController.signal.aborted || jobIsCancelled(job)) {
        if (jobIsCancelled(job)) {
          try {
            await this.#cleanupJobCandidate(job);
          } catch (error) {
            this.#recordCleanupFailure(job, error);
          }
        } else {
          await this.#failJob(job, "reconstruction_timeout", "The photo reconstruction exceeded its time limit.", true);
        }
        return;
      }
      try {
        await this.#cleanupJobDirectory(job);
      } catch (error) {
        const failures: unknown[] = [error];
        try {
          await this.#cleanupJobCandidate(job);
        } catch (candidateError) {
          failures.push(candidateError);
        }
        this.#recordCleanupFailure(
          job,
          failures.length === 1 ? failures[0] : new AggregateError(failures, "Reconstruction cleanup failed."),
        );
        return;
      }
      try {
        await this.#assetIngress.reserveCandidate(
          candidate.candidateHandle,
          job.principal.authorizationId,
          job.input.workspaceId,
          Math.min(
            MAX_AGENT_ASSET_RESERVATION_TTL_MS,
            this.#readyTtlMs + PHOTO_RECONSTRUCTION_LIMITS.defaultFinalizationLeaseMs + 60_000,
          ),
        );
      } catch (error) {
        if (error instanceof AgentAssetIngressError && error.code === "asset_candidate_not_found") {
          await this.#failJob(
            job,
            "photo_reconstruction_output_expired",
            "The reconstructed Reality Asset candidate expired before it became ready.",
            true,
          );
          return;
        }
        throw error;
      }
      job.result = candidate;
      job.status = "ready";
      job.progress = 1;
      job.error = undefined;
      job.updatedAt = this.#now();
      job.expiresAt = job.updatedAt + this.#readyTtlMs;
    } catch (error) {
      if (jobIsCancelled(job)) return;
      if (job.abortController.signal.aborted) {
        await this.#failJob(job, "reconstruction_timeout", "The photo reconstruction exceeded its time limit.", true);
      } else if (error instanceof PhotoReconstructionBackendError) {
        await this.#failJob(job, error.code, BACKEND_FAILURES[error.code], error.retryable);
      } else {
        await this.#failJob(job, "reconstruction_failed", "The photo reconstruction backend failed.", true);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  #acceptProgress(job: JobRecord, update: PhotoReconstructionProgress): void {
    if (!["camera_solving", "training", "packing"].includes(job.status) || job.abortController.signal.aborted) return;
    if (!["camera_solving", "training", "packing"].includes(update.phase)) return;
    if (!Number.isFinite(update.progress) || update.progress < 0 || update.progress > 1) return;
    if (PHASE_RANK[update.phase] < PHASE_RANK[job.status]) return;
    job.status = update.phase;
    job.progress = Math.max(job.progress, Math.min(0.99, update.progress));
    if (update.registeredPhotoCount !== undefined) this.#setRegisteredPhotoCount(job, update.registeredPhotoCount);
    for (const warning of update.warnings ?? []) {
      if (isWarningCode(warning)) job.warnings.add(warning);
    }
    job.updatedAt = this.#now();
  }

  #setRegisteredPhotoCount(job: JobRecord, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > job.input.photos.length) return;
    job.registeredPhotoCount = Math.max(job.registeredPhotoCount ?? 0, value);
  }

  async #stageOutput(
    job: JobRecord,
    outputPath: string,
    format: AgentAssetFormat,
  ): Promise<PhotoReconstructionResultCandidate> {
    let canonicalOutputPath: string;
    let file: Awaited<ReturnType<typeof lstat>>;
    try {
      const [canonicalOutputDirectory, resolvedOutputPath, outputFile] = await Promise.all([
        realpath(job.outputDirectory),
        realpath(outputPath),
        lstat(outputPath),
      ]);
      if (!outputPathIsContained(canonicalOutputDirectory, resolvedOutputPath) || outputFile.isSymbolicLink()) {
        throw new Error("unsafe output path");
      }
      canonicalOutputPath = resolvedOutputPath;
      file = outputFile;
    } catch {
      throw new PhotoReconstructionBackendError("output_invalid");
    }
    if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size < 1
      || file.size > PHOTO_RECONSTRUCTION_LIMITS.maximumOutputBytes) {
      throw new PhotoReconstructionBackendError("output_invalid");
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(canonicalOutputPath, { highWaterMark: PHOTO_RECONSTRUCTION_LIMITS.digestChunkBytes })) {
      if (job.abortController.signal.aborted) throw abortError();
      digest.update(chunk);
    }
    const sha256 = `sha256:${digest.digest("hex")}` as const;
    const requestId = `reconstruction-${job.jobId}`;
    const mediaType = MEDIA_TYPE_BY_OUTPUT[format];
    const grant = await this.#assetIngress.begin(job.principal, {
      requestId,
      workspaceId: job.input.workspaceId,
      displayName: `reconstruction-${job.jobId.slice(0, 8)}.${OUTPUT_EXTENSION[format]}`,
      format,
      mediaType,
      byteLength: file.size,
      sha256,
      purpose: "photo_reconstruction",
    });
    const candidate = Object.freeze({
      candidateHandle: grant.candidateHandle,
      format,
      mediaType,
      byteLength: file.size,
      sha256,
    });
    // Track the capability immediately after ingress creates it. It remains
    // internal until the job is ready, but a failed upload/cancel can now be
    // retried without losing the only handle that can delete staged bytes.
    job.result = candidate;
    try {
      let ready = grant;
      if (grant.status !== "ready") {
        if (!grant.upload) throw new PhotoReconstructionBackendError("output_invalid");
        const grantId = new URL(grant.upload.url).pathname.split("/").at(-1);
        if (!grantId) throw new PhotoReconstructionBackendError("output_invalid");
        ready = await this.#assetIngress.upload(
          grantId,
          grant.upload.token,
          mediaType,
          file.size,
          createReadStream(canonicalOutputPath, {
            highWaterMark: PHOTO_RECONSTRUCTION_LIMITS.digestChunkBytes,
          }),
          job.abortController.signal,
          {
            minimumFreeBytesAfterWrite: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeReserveBytes,
          },
        );
      }
      if (ready.status !== "ready" || !HANDLE_PATTERN.test(ready.candidateHandle)) {
        throw new PhotoReconstructionBackendError("output_invalid");
      }
      await this.#assetIngress.reserveCandidate(
        candidate.candidateHandle,
        job.principal.authorizationId,
        job.input.workspaceId,
        MAX_AGENT_ASSET_RESERVATION_TTL_MS,
      );
      return candidate;
    } catch (error) {
      const mappedError = error instanceof AgentAssetIngressError
        && ["asset_upload_storage_exhausted", "asset_upload_storage_unavailable"].includes(error.code)
        ? new PhotoReconstructionBackendError("resource_exhausted", true)
        : error;
      try {
        await this.#cleanupJobCandidate(job);
      } catch (cause) {
        throw new PhotoReconstructionCandidateCleanupError({ cause });
      }
      throw mappedError;
    }
  }

  async #failJob(job: JobRecord, code: string, message: string, retryable: boolean): Promise<void> {
    if (!["ready", "failed", "cancelled"].includes(job.status)) {
      job.abortController.abort();
      for (const grant of job.grants.values()) grant.abortController.abort();
      job.status = "failed";
      job.progress = Math.min(job.progress, 0.999999);
      job.error = Object.freeze({ code, message, retryable });
      job.updatedAt = this.#now();
      job.expiresAt = job.updatedAt + this.#readyTtlMs;
    }
    try {
      await this.#cleanupJobResources(job);
    } catch (error) {
      this.#recordCleanupFailure(job, error);
      throw error;
    }
  }

  #recordCleanupFailure(job: JobRecord, _error: unknown): void {
    job.status = "failed";
    job.progress = Math.min(job.progress, 0.999999);
    job.error = Object.freeze({
      code: "photo_reconstruction_cleanup_failed",
      message: "The temporary photo set or staged candidate could not be removed. Retry cancellation or revoke the connection.",
      retryable: true,
    });
    job.updatedAt = this.#now();
    job.expiresAt = job.updatedAt + this.#readyTtlMs;
    job.abortController.abort();
    for (const grant of job.grants.values()) grant.abortController.abort();
  }

  #ownedJob(jobId: string, authorizationId: string, workspaceId?: string): JobRecord {
    if (!JOB_ID_PATTERN.test(jobId) || !authorizationId) {
      throw new PhotoReconstructionServiceError(404, "photo_reconstruction_not_found", "The photo reconstruction job is invalid or expired.");
    }
    const job = this.#jobs.get(jobId);
    if (!job || job.principal.authorizationId !== authorizationId
      || (workspaceId !== undefined && job.input.workspaceId !== workspaceId)) {
      throw new PhotoReconstructionServiceError(404, "photo_reconstruction_not_found", "The photo reconstruction job is invalid or expired.");
    }
    return job;
  }

  #beginView(job: JobRecord): BeginPhotoReconstructionResult {
    const uploads: PhotoUploadGrant[] = [];
    if (job.status === "awaiting_upload") {
      for (const grant of job.grants.values()) {
        if (grant.state === "ready" || !grant.uploadToken) continue;
        uploads.push(Object.freeze({
          photoId: grant.input.photoId,
          method: "PUT",
          url: `${this.#publicBaseUrl}/v1/reconstructions/photo-uploads/${grant.grantId}`,
          authorization: "Bearer",
          token: grant.uploadToken,
          contentType: grant.input.mediaType,
          contentLength: grant.input.byteLength,
          expiresAt: new Date(grant.expiresAt).toISOString(),
        }));
      }
    }
    uploads.sort((left, right) => left.photoId.localeCompare(right.photoId));
    return Object.freeze({ job: this.#jobView(job), uploads: Object.freeze(uploads) });
  }

  #jobView(job: JobRecord): PhotoReconstructionJobView {
    return Object.freeze({
      version: PHOTO_RECONSTRUCTION_CONTRACT_VERSION,
      jobId: job.jobId,
      requestId: job.input.requestId,
      workspaceId: job.input.workspaceId,
      photoSetDigest: job.photoSetDigest,
      profile: job.input.profile,
      status: job.status,
      progress: job.progress,
      inputPhotoCount: job.input.photos.length,
      uploadedPhotoCount: [...job.grants.values()].filter((grant) => grant.state === "ready").length,
      ...(job.registeredPhotoCount === undefined ? {} : { registeredPhotoCount: job.registeredPhotoCount }),
      backend: this.#backendIdentity,
      warnings: uniqueWarnings(job.warnings),
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      expiresAt: new Date(job.expiresAt).toISOString(),
      ...(job.status === "ready" && job.result ? { result: Object.freeze({ ...job.result }) } : {}),
      ...(job.error ? { error: Object.freeze({ ...job.error }) } : {}),
    });
  }

  async #cleanupJobDirectory(job: JobRecord): Promise<void> {
    if (job.directoryCleaned) return;
    const jobDirectory = resolve(job.inputDirectory, "..");
    try {
      await this.#removeDirectory(jobDirectory);
    } catch (cause) {
      throw new PhotoReconstructionCleanupError(jobDirectory, { cause });
    }
    for (const grant of job.grants.values()) {
      this.#byGrant.delete(grant.grantId);
      grant.abortController.abort();
      grant.uploadToken = undefined;
      grant.uploadTokenHash.fill(0);
      grant.partialPath = undefined;
      grant.filePath = undefined;
    }
    job.directoryCleaned = true;
  }

  async #cleanupJobCandidate(job: JobRecord): Promise<void> {
    const candidate = job.result;
    if (!candidate) return;
    try {
      await this.#assetIngress.cancelFromAgent(
        candidate.candidateHandle,
        job.principal.authorizationId,
      );
    } catch (error) {
      // Browser completion consumes the candidate before this service learns
      // about it. A scoped not-found therefore also proves there are no staged
      // bytes left for this capability; every other error stays retryable.
      if (!(error instanceof AgentAssetIngressError && error.code === "asset_candidate_not_found")) {
        throw new PhotoReconstructionCandidateCleanupError({ cause: error });
      }
    }
    if (job.result?.candidateHandle === candidate.candidateHandle) job.result = undefined;
  }

  async #cleanupJobResources(job: JobRecord): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#cleanupJobCandidate(job);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#cleanupJobDirectory(job);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Photo reconstruction resource cleanup failed.");
    }
  }

  async #removeUploadFile(path: string): Promise<void> {
    try {
      await this.#removeFile(path);
    } catch (error) {
      // A concurrent whole-job cleanup may already have removed the file.
      if (isMissingPathError(error)) return;
      throw error;
    }
  }

  async #discardJob(job: JobRecord): Promise<void> {
    await this.#cleanupJobResources(job);
    this.#jobs.delete(job.jobId);
    this.#byRequest.delete(job.requestKey);
  }

  #root(): Promise<string> {
    if (this.#rootPromise) return this.#rootPromise;
    const operation = this.#initializeRoot();
    this.#rootPromise = operation;
    void operation.catch(() => {
      if (this.#rootPromise === operation) this.#rootPromise = undefined;
    });
    return operation;
  }

  async #initializeRoot(): Promise<string> {
    await this.#startupCleanup;
    await mkdir(this.#temporaryDirectory, { recursive: true, mode: 0o700 });
    const parentStats = await lstat(this.#temporaryDirectory);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new Error("temporaryDirectory must resolve from a non-symbolic-link directory entry.");
    }
    const canonicalParent = await realpath(this.#temporaryDirectory);
    await this.#removeStaleOrphans(canonicalParent);
    const root = await mkdtemp(join(canonicalParent, "semaframe-photo-reconstruction-"));
    const markerPath = join(root, OWNER_MARKER_NAME);
    const owner: ReconstructionRootOwner = Object.freeze({
      version: 1,
      pid: process.pid,
      processStartedAt: PROCESS_STARTED_AT,
      lease: this.#ownerLease,
    });
    try {
      await writeFile(markerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    } catch (error) {
      try {
        await this.#removeDirectory(root);
      } catch {
        throw cleanupServiceError();
      }
      throw error;
    }
    this.#ownerMarkerPath = markerPath;
    this.#ownerHeartbeat = setInterval(() => { void this.#touchOwnerLease(); }, OWNER_HEARTBEAT_MS);
    this.#ownerHeartbeat.unref?.();
    return root;
  }

  async #cleanupStaleRootsAtStartup(): Promise<void> {
    let parentStats: Awaited<ReturnType<typeof lstat>>;
    try {
      parentStats = await lstat(this.#temporaryDirectory);
    } catch (error) {
      // Capability checks and clean shutdown must not materialize persistent
      // storage merely to discover that there is nothing to reclaim.
      if (isMissingPathError(error)) return;
      throw error;
    }
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new Error("temporaryDirectory must resolve from a non-symbolic-link directory entry.");
    }
    const canonicalParent = await realpath(this.#temporaryDirectory);
    const finalStats = await lstat(this.#temporaryDirectory);
    if (!finalStats.isDirectory() || finalStats.isSymbolicLink()
      || finalStats.dev !== parentStats.dev || finalStats.ino !== parentStats.ino) {
      throw new Error("temporaryDirectory changed during photo reconstruction startup cleanup.");
    }
    await this.#removeStaleOrphans(canonicalParent);
  }

  async #removeStaleOrphans(canonicalParent: string): Promise<void> {
    const cutoff = this.#now() - ORPHAN_SAFE_AGE_MS;
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const directory = await opendir(canonicalParent);
    let scannedEntries = 0;
    let removedRoots = 0;
    try {
      while (scannedEntries < MAX_ORPHAN_DIRECTORY_ENTRIES_PER_PASS
        && removedRoots < MAX_ORPHAN_REMOVALS_PER_PASS) {
        const entry = await directory.read();
        if (!entry) break;
        scannedEntries += 1;
        if (!RECONSTRUCTION_ROOT_NAME_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          continue;
        }
        const candidate = join(canonicalParent, entry.name);
        let firstStats: Awaited<ReturnType<typeof lstat>>;
        try {
          firstStats = await lstat(candidate);
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
        if (!firstStats.isDirectory() || firstStats.isSymbolicLink()
          || (currentUid !== undefined && firstStats.uid !== currentUid)
          || !Number.isFinite(firstStats.mtimeMs) || firstStats.mtimeMs > cutoff) {
          continue;
        }
        const markerPath = join(candidate, OWNER_MARKER_NAME);
        let markerStats: Awaited<ReturnType<typeof lstat>>;
        let owner: ReconstructionRootOwner | undefined;
        try {
          markerStats = await lstat(markerPath);
          if (!markerStats.isFile() || markerStats.isSymbolicLink() || markerStats.size < 1 || markerStats.size > 512
            || (currentUid !== undefined && markerStats.uid !== currentUid)
            || !Number.isFinite(markerStats.mtimeMs) || markerStats.mtimeMs > cutoff) {
            continue;
          }
          owner = parseReconstructionRootOwner(await readFile(markerPath, "utf8"));
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
        if (!owner) continue;
        if (owner.pid === process.pid && Math.abs(owner.processStartedAt - PROCESS_STARTED_AT) <= 5_000) continue;
        if (processIsAlive(owner.pid)) continue;
        let canonicalCandidate: string;
        try {
          canonicalCandidate = await realpath(candidate);
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
        if (relative(canonicalParent, canonicalCandidate) !== entry.name) continue;
        let finalStats: Awaited<ReturnType<typeof lstat>>;
        let finalMarkerStats: Awaited<ReturnType<typeof lstat>>;
        try {
          [finalStats, finalMarkerStats] = await Promise.all([
            lstat(candidate),
            lstat(markerPath),
          ]);
        } catch (error) {
          // Another service may have quarantined the same dead root between
          // our identity checks. That is successful reclamation, not a startup
          // failure for this service.
          if (isMissingPathError(error)) continue;
          throw error;
        }
        if (!finalStats.isDirectory() || finalStats.isSymbolicLink()
          || finalStats.dev !== firstStats.dev || finalStats.ino !== firstStats.ino
          || (currentUid !== undefined && finalStats.uid !== currentUid)
          || finalStats.mtimeMs > cutoff
          || !finalMarkerStats.isFile() || finalMarkerStats.isSymbolicLink()
          || finalMarkerStats.dev !== markerStats.dev || finalMarkerStats.ino !== markerStats.ino
          || finalMarkerStats.mtimeMs > cutoff) {
          continue;
        }
        const quarantine = join(
          canonicalParent,
          `semaframe-photo-reconstruction-quarantine-${randomUUID()}`,
        );
        try {
          await rename(candidate, quarantine);
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
        try {
          const [quarantineStats, canonicalQuarantine] = await Promise.all([
            lstat(quarantine),
            realpath(quarantine),
          ]);
          if (!quarantineStats.isDirectory() || quarantineStats.isSymbolicLink()
            || quarantineStats.dev !== firstStats.dev || quarantineStats.ino !== firstStats.ino
            || relative(canonicalParent, canonicalQuarantine) !== relative(canonicalParent, quarantine)) {
            throw new Error("Unsafe orphan quarantine boundary.");
          }
          await this.#removeDirectory(quarantine);
          removedRoots += 1;
        } catch {
          throw cleanupServiceError();
        }
      }
    } finally {
      await directory.close();
    }
  }

  async #touchOwnerLease(): Promise<void> {
    const markerPath = this.#ownerMarkerPath;
    if (!markerPath || this.#closed) return;
    try {
      const markerStats = await lstat(markerPath);
      if (!markerStats.isFile() || markerStats.isSymbolicLink() || markerStats.size < 1 || markerStats.size > 512) {
        return;
      }
      const owner = parseReconstructionRootOwner(await readFile(markerPath, "utf8"));
      if (!owner || owner.pid !== process.pid || owner.lease !== this.#ownerLease
        || Math.abs(owner.processStartedAt - PROCESS_STARTED_AT) > 5_000) {
        return;
      }
      const now = new Date(this.#now());
      await utimes(markerPath, now, now);
    } catch {
      // Failure to heartbeat never authorizes deletion: orphan GC also proves
      // that the recorded PID is no longer alive before quarantining a root.
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new PhotoReconstructionServiceError(503, "photo_reconstruction_closed", "Photo reconstruction is shutting down.");
    }
  }
}
