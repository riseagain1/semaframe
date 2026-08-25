import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, createReadStream, type ReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, statfs, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";

export const AGENT_ASSET_IMPORT_SCOPE = "asset:import" as const;
export const DEFAULT_AGENT_ASSET_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_AGENT_ASSET_STAGED_BYTES = 512 * 1024 * 1024;
export const DEFAULT_AGENT_ASSET_MINIMUM_FREE_RESERVE_BYTES = 512 * 1024 * 1024;
export const MAX_AGENT_ASSET_RESERVATION_TTL_MS = 30 * 60_000;

export type AgentAssetFormat = "ply" | "spz" | "sog";
export type AgentAssetPurpose = "generic_import" | "photo_reconstruction";

export type AgentAssetUploadStoragePolicy = Readonly<{
  /** Free bytes that must remain after the complete pending upload is staged. */
  minimumFreeBytesAfterWrite: number;
}>;

export type ApprovedAssetImporter = Readonly<{
  authorizationId: string;
  clientId?: string;
  clientName?: string;
}>;

export type BeginAgentAssetImportInput = Readonly<{
  requestId: string;
  workspaceId: string;
  displayName: string;
  format: AgentAssetFormat;
  mediaType: string;
  byteLength: number;
  sha256: string;
  purpose?: AgentAssetPurpose;
}>;

export type AgentAssetCandidateDescriptor = Readonly<{
  version: 1;
  candidateHandle: string;
  requestId: string;
  workspaceId: string;
  displayName: string;
  format: AgentAssetFormat;
  mediaType: string;
  byteLength: number;
  sha256: string;
  purpose: AgentAssetPurpose;
  status: "awaiting_upload" | "ready";
  expiresAt: string;
}>;

export type AgentAssetImportGrant = AgentAssetCandidateDescriptor & Readonly<{
  upload?: Readonly<{
    method: "PUT";
    url: string;
    authorization: "Bearer";
    token: string;
    contentType: string;
    contentLength: number;
  }>;
}>;

export type AgentAssetImportGrantWire = Readonly<{
  version: 1;
  candidate_handle: string;
  request_id: string;
  workspace_id: string;
  display_name: string;
  format: AgentAssetFormat;
  media_type: string;
  byte_length: number;
  sha256: string;
  purpose: AgentAssetPurpose;
  status: "awaiting_upload" | "ready";
  expires_at: string;
  upload?: Readonly<{
    method: "PUT";
    url: string;
    authorization: "Bearer";
    token: string;
    content_type: string;
    content_length: number;
  }>;
}>;

/** Canonical snake_case projection shared by REST and MCP tool results. */
export function toAgentAssetImportGrantWire(
  candidate: AgentAssetImportGrant | AgentAssetCandidateDescriptor,
): AgentAssetImportGrantWire {
  const upload = "upload" in candidate ? candidate.upload : undefined;
  return Object.freeze({
    version: candidate.version,
    candidate_handle: candidate.candidateHandle,
    request_id: candidate.requestId,
    workspace_id: candidate.workspaceId,
    display_name: candidate.displayName,
    format: candidate.format,
    media_type: candidate.mediaType,
    byte_length: candidate.byteLength,
    sha256: candidate.sha256,
    purpose: candidate.purpose,
    status: candidate.status,
    expires_at: candidate.expiresAt,
    ...(upload ? {
      upload: Object.freeze({
        method: upload.method,
        url: upload.url,
        authorization: upload.authorization,
        token: upload.token,
        content_type: upload.contentType,
        content_length: upload.contentLength,
      }),
    } : {}),
  });
}

export type OpenAgentAssetCandidate = Readonly<{
  descriptor: AgentAssetCandidateDescriptor;
  body: ReadableStream<Uint8Array>;
  release(): void;
}>;

export type AgentAssetCandidateReservation = Readonly<{
  candidateHandle: string;
  status: "ready" | "completed";
  expiresAt: string;
}>;

export class AgentAssetIngressError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentAssetIngressError";
  }
}

export type AgentAssetIngressOptions = Readonly<{
  publicBaseUrl: string;
  maxBytes?: number;
  maxStagedBytes?: number;
  maxPendingGrants?: number;
  maxConcurrentUploads?: number;
  grantTtlMs?: number;
  candidateTtlMs?: number;
  temporaryDirectory?: string;
  sweepIntervalMs?: number;
  now?: () => number;
  removeFile?: (path: string) => Promise<void>;
  removeDirectory?: (path: string) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  availableTemporaryBytes?: (path: string) => Promise<bigint>;
  minimumFreeBytesAfterUpload?: number;
}>;

type GrantState = "awaiting_upload" | "uploading" | "ready" | "cancelled";

type AssetGrantRecord = {
  grantId: string;
  uploadToken: string;
  uploadTokenHash: Buffer;
  candidateHandle: string;
  authorizationId: string;
  clientId?: string;
  clientName?: string;
  requestKey: string;
  input: BeginAgentAssetImportInput;
  displayName: string;
  state: GrantState;
  expiresAt: number;
  partialPath?: string;
  filePath?: string;
  abortController: AbortController;
  activeReaders: number;
  readStreams: Set<ReadStream>;
  discardPromise?: Promise<void>;
};

type CompletedImport = {
  authorizationId: string;
  requestKey: string;
  candidateHandle: string;
  workspaceId: string;
  input: BeginAgentAssetImportInput;
  displayName: string;
  expiresAt: number;
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const SAFE_MEDIA_TYPES: Readonly<Record<AgentAssetFormat, ReadonlySet<string>>> = {
  ply: new Set(["application/octet-stream", "application/ply", "model/ply"]),
  spz: new Set(["application/octet-stream", "application/x-spz", "application/vnd.google.spz", "model/spz", "model/vnd.spz"]),
  sog: new Set(["application/octet-stream", "application/zip", "application/vnd.playcanvas.sog", "model/sog", "model/vnd.sog"]),
};
const ASSET_ROOT_PREFIX = "semaframe-agent-assets-";
const ASSET_QUARANTINE_PREFIX = "semaframe-agent-assets-quarantine-";
const ASSET_STAGING_PREFIX = ".semaframe-agent-assets-create-";
const ASSET_LEASE_FILE = ".semaframe-agent-assets.lease.json";
const ASSET_ROOT_PATTERN = /^semaframe-agent-assets-(?!quarantine-)[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/u;
const ASSET_QUARANTINE_PATTERN = /^semaframe-agent-assets-quarantine-[0-9a-f-]{36}$/u;
const ASSET_STAGING_PATTERN = /^\.semaframe-agent-assets-create-[0-9]+-[0-9a-f-]{36}$/u;
const INSTANCE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_LEASE_BYTES = 4_096;

type AssetRootLease = Readonly<{
  version: 1;
  pid: number;
  instanceId: string;
  createdAt: string;
}>;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    // EPERM and unknown probe failures are treated as live. Orphan recovery
    // must prefer a leak over deleting another process's active staging root.
    return true;
  }
}

function parseAssetRootLease(value: unknown): AssetRootLease | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1
    || !Number.isSafeInteger(candidate.pid)
    || (candidate.pid as number) < 1
    || typeof candidate.instanceId !== "string"
    || !INSTANCE_ID_PATTERN.test(candidate.instanceId)
    || typeof candidate.createdAt !== "string"
    || !Number.isFinite(Date.parse(candidate.createdAt))
  ) return undefined;
  return Object.freeze({
    version: 1,
    pid: candidate.pid as number,
    instanceId: candidate.instanceId,
    createdAt: candidate.createdAt,
  });
}

function sameLease(left: AssetRootLease, right: AssetRootLease): boolean {
  return left.pid === right.pid
    && left.instanceId === right.instanceId
    && left.createdAt === right.createdAt;
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(value: string, expected: Buffer): boolean {
  const actual = tokenHash(value);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Agent asset publicBaseUrl must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  return url.href.replace(/\/$/u, "");
}

function safeDisplayName(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > 255 ||
    /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069/\\]/u.test(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    /^[a-z][a-z0-9+.-]*:/iu.test(normalized)
  ) {
    throw new AgentAssetIngressError(
      400,
      "invalid_request",
      "display_name must be a plain 1-255 character label, not a path or URL.",
    );
  }
  return normalized;
}

function normalizeInput(input: BeginAgentAssetImportInput, maxBytes: number): BeginAgentAssetImportInput {
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new AgentAssetIngressError(400, "invalid_request", "request_id must be a stable 8-128 character identifier.");
  }
  if (!WORKSPACE_ID_PATTERN.test(input.workspaceId)) {
    throw new AgentAssetIngressError(400, "invalid_request", "workspace_id must be a valid Workspace identifier.");
  }
  if (!(["ply", "spz", "sog"] as const).includes(input.format)) {
    throw new AgentAssetIngressError(415, "unsupported_asset_format", "format must be ply, spz, or sog.");
  }
  const mediaType = input.mediaType.toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(mediaType) || !SAFE_MEDIA_TYPES[input.format].has(mediaType)) {
    throw new AgentAssetIngressError(415, "unsupported_media_type", `media_type is not supported for ${input.format}.`);
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1) {
    throw new AgentAssetIngressError(400, "invalid_request", "byte_length must be a positive safe integer.");
  }
  if (input.byteLength > maxBytes) {
    throw new AgentAssetIngressError(413, "asset_too_large", `The asset exceeds the ${maxBytes}-byte import limit.`);
  }
  const digest = input.sha256.toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new AgentAssetIngressError(400, "invalid_request", "sha256 must use the sha256:<64 lowercase hex> form.");
  }
  const purpose = input.purpose ?? "generic_import";
  if (purpose !== "generic_import" && purpose !== "photo_reconstruction") {
    throw new AgentAssetIngressError(
      400,
      "invalid_request",
      "purpose must be generic_import or photo_reconstruction.",
    );
  }
  return Object.freeze({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    displayName: safeDisplayName(input.displayName),
    format: input.format,
    mediaType,
    byteLength: input.byteLength,
    sha256: digest,
    purpose,
  });
}

function inputsMatch(left: BeginAgentAssetImportInput, right: BeginAgentAssetImportInput): boolean {
  return left.requestId === right.requestId &&
    left.workspaceId === right.workspaceId &&
    left.displayName === right.displayName &&
    left.format === right.format &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    (left.purpose ?? "generic_import") === (right.purpose ?? "generic_import");
}

async function availableFilesystemBytes(path: string): Promise<bigint> {
  const stats = await statfs(path, { bigint: true });
  return stats.bavail * stats.bsize;
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("The temporary asset file stopped accepting data.");
    offset += bytesWritten;
  }
}

function asAsyncBytes(body: AsyncIterable<Uint8Array | string>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of body) {
        yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      }
    },
  };
}

async function nextBodyChunk(
  iterator: AsyncIterator<Uint8Array>,
  signals: readonly AbortSignal[],
): Promise<IteratorResult<Uint8Array>> {
  if (signals.some((signal) => signal.aborted)) {
    throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled or expired.");
  }
  return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
    const cleanup = () => signals.forEach((signal) => signal.removeEventListener("abort", abort));
    const abort = () => {
      cleanup();
      reject(new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled or expired."));
    };
    signals.forEach((signal) => signal.addEventListener("abort", abort, { once: true }));
    void Promise.resolve(iterator.next()).then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

export class AgentAssetIngress {
  readonly #publicBaseUrl: string;
  readonly #maxBytes: number;
  readonly #maxStagedBytes: number;
  readonly #maxPendingGrants: number;
  readonly #maxConcurrentUploads: number;
  readonly #grantTtlMs: number;
  readonly #candidateTtlMs: number;
  readonly #temporaryDirectory: string;
  readonly #now: () => number;
  readonly #removeFile: (path: string) => Promise<void>;
  readonly #removeDirectory: (path: string) => Promise<void>;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #availableTemporaryBytes: (path: string) => Promise<bigint>;
  readonly #minimumFreeBytesAfterUpload: number;
  readonly #instanceId = randomUUID();
  readonly #byGrantId = new Map<string, AssetGrantRecord>();
  readonly #byCandidate = new Map<string, AssetGrantRecord>();
  readonly #byRequest = new Map<string, AssetGrantRecord>();
  readonly #completedByRequest = new Map<string, CompletedImport>();
  readonly #completedByCandidate = new Map<string, CompletedImport>();
  readonly #activeUploads = new Set<Promise<unknown>>();
  readonly #sweepTimer?: ReturnType<typeof setInterval>;
  readonly #startupPromise: Promise<void>;
  #uploadWriteTail: Promise<void> = Promise.resolve();
  #rootPromise?: Promise<string>;
  #closePromise?: Promise<void>;
  #closeComplete = false;
  #closed = false;

  constructor(options: AgentAssetIngressOptions) {
    this.#publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
    this.#maxBytes = options.maxBytes ?? DEFAULT_AGENT_ASSET_MAX_BYTES;
    this.#maxStagedBytes = options.maxStagedBytes ?? DEFAULT_AGENT_ASSET_STAGED_BYTES;
    this.#maxPendingGrants = options.maxPendingGrants ?? 16;
    this.#maxConcurrentUploads = options.maxConcurrentUploads ?? 2;
    this.#grantTtlMs = options.grantTtlMs ?? 5 * 60_000;
    this.#candidateTtlMs = options.candidateTtlMs ?? 10 * 60_000;
    this.#temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    this.#now = options.now ?? Date.now;
    this.#removeFile = options.removeFile ?? unlink;
    this.#removeDirectory = options.removeDirectory
      ?? ((path) => rm(path, { recursive: true, force: true }));
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.#availableTemporaryBytes = options.availableTemporaryBytes ?? availableFilesystemBytes;
    this.#minimumFreeBytesAfterUpload = options.minimumFreeBytesAfterUpload
      ?? DEFAULT_AGENT_ASSET_MINIMUM_FREE_RESERVE_BYTES;
    for (const [name, value] of [
      ["maxBytes", this.#maxBytes],
      ["maxStagedBytes", this.#maxStagedBytes],
      ["maxPendingGrants", this.#maxPendingGrants],
      ["maxConcurrentUploads", this.#maxConcurrentUploads],
      ["grantTtlMs", this.#grantTtlMs],
      ["candidateTtlMs", this.#candidateTtlMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
    }
    if (this.#candidateTtlMs > MAX_AGENT_ASSET_RESERVATION_TTL_MS) {
      throw new RangeError(`candidateTtlMs must not exceed ${MAX_AGENT_ASSET_RESERVATION_TTL_MS}.`);
    }
    if (!Number.isSafeInteger(this.#minimumFreeBytesAfterUpload) || this.#minimumFreeBytesAfterUpload < 0) {
      throw new RangeError("minimumFreeBytesAfterUpload must be a non-negative integer.");
    }
    if (!isAbsolute(this.#temporaryDirectory) || this.#temporaryDirectory.includes("\u0000")) {
      throw new Error("temporaryDirectory must be an absolute path.");
    }
    const sweepIntervalMs = options.sweepIntervalMs ?? Math.min(30_000, this.#grantTtlMs);
    if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 0) {
      throw new RangeError("sweepIntervalMs must be a non-negative integer.");
    }
    this.#startupPromise = this.#collectStartupOrphans();
    void this.#startupPromise.catch(() => undefined);
    if (sweepIntervalMs > 0) {
      this.#sweepTimer = setInterval(() => {
        void this.sweepExpired().catch(() => undefined);
      }, sweepIntervalMs);
      this.#sweepTimer.unref?.();
    }
  }

  matchesUploadPath(pathname: string): boolean {
    return /^\/v1\/assets\/uploads\/[0-9a-f-]{36}$/iu.test(pathname);
  }

  async begin(
    principal: ApprovedAssetImporter,
    rawInput: BeginAgentAssetImportInput,
  ): Promise<AgentAssetImportGrant> {
    this.#assertOpen();
    await this.#startupPromise;
    await this.sweepExpired();
    if (!principal.authorizationId || principal.authorizationId.length > 128) {
      throw new AgentAssetIngressError(403, "asset_import_not_authorized", "An approved asset:import connection is required.");
    }
    const input = normalizeInput(rawInput, this.#maxBytes);
    const requestKey = `${principal.authorizationId}\u0000${input.requestId}`;
    const completed = this.#completedByRequest.get(requestKey);
    if (completed) {
      if (!inputsMatch(completed.input, input)) {
        throw new AgentAssetIngressError(
          409,
          "asset_import_idempotency_conflict",
          "request_id was already used with different asset metadata.",
        );
      }
      throw new AgentAssetIngressError(
        409,
        "asset_import_already_completed",
        "This idempotent asset import request was already consumed by the browser.",
      );
    }
    let existing = this.#byRequest.get(requestKey);
    if (existing?.state === "cancelled") {
      // A prior cleanup failure intentionally leaves the record tracked. A
      // repeat begin is also a safe opportunity to finish that deletion.
      await this.#discard(existing);
      existing = undefined;
    }
    if (existing) {
      if (!inputsMatch(existing.input, input)) {
        throw new AgentAssetIngressError(
          409,
          "asset_import_idempotency_conflict",
          "request_id was already used with different asset metadata.",
        );
      }
      return this.#grantView(existing);
    }
    if (this.#byGrantId.size >= this.#maxPendingGrants) {
      throw new AgentAssetIngressError(429, "asset_ingress_busy", "Too many asset imports are pending.");
    }
    const reservedBytes = [...this.#byGrantId.values()]
      .reduce((total, record) => total + record.input.byteLength, 0);
    if (reservedBytes + input.byteLength > this.#maxStagedBytes) {
      throw new AgentAssetIngressError(429, "asset_ingress_capacity_exceeded", "The temporary asset staging capacity is exhausted.");
    }
    const uploadToken = opaqueToken();
    const record: AssetGrantRecord = {
      grantId: randomUUID(),
      uploadToken,
      uploadTokenHash: tokenHash(uploadToken),
      candidateHandle: opaqueToken(),
      authorizationId: principal.authorizationId,
      ...(principal.clientId ? { clientId: principal.clientId } : {}),
      ...(principal.clientName ? { clientName: principal.clientName } : {}),
      requestKey,
      input,
      displayName: input.displayName,
      state: "awaiting_upload",
      expiresAt: this.#now() + this.#grantTtlMs,
      abortController: new AbortController(),
      activeReaders: 0,
      readStreams: new Set(),
    };
    this.#byGrantId.set(record.grantId, record);
    this.#byCandidate.set(record.candidateHandle, record);
    this.#byRequest.set(requestKey, record);
    return this.#grantView(record);
  }

  upload(
    grantId: string,
    uploadToken: string | undefined,
    mediaType: string | undefined,
    contentLength: number | undefined,
    body: AsyncIterable<Uint8Array | string> | undefined,
    signal?: AbortSignal,
    storagePolicy?: AgentAssetUploadStoragePolicy,
  ): Promise<AgentAssetCandidateDescriptor> {
    const operation = this.#performUpload(
      grantId,
      uploadToken,
      mediaType,
      contentLength,
      body,
      signal,
      storagePolicy,
    );
    this.#activeUploads.add(operation);
    void operation.finally(() => this.#activeUploads.delete(operation)).catch(() => undefined);
    return operation;
  }

  async #performUpload(
    grantId: string,
    uploadToken: string | undefined,
    mediaType: string | undefined,
    contentLength: number | undefined,
    body: AsyncIterable<Uint8Array | string> | undefined,
    signal?: AbortSignal,
    storagePolicy?: AgentAssetUploadStoragePolicy,
  ): Promise<AgentAssetCandidateDescriptor> {
    this.#assertOpen();
    await this.sweepExpired();
    const record = this.#byGrantId.get(grantId);
    if (!record || record.state === "cancelled") {
      throw new AgentAssetIngressError(404, "asset_upload_not_found", "The asset upload grant is invalid or expired.");
    }
    if (!uploadToken || !tokenMatches(uploadToken, record.uploadTokenHash)) {
      throw new AgentAssetIngressError(401, "asset_upload_unauthorized", "A valid one-use asset upload bearer is required.");
    }
    if (record.state === "ready") return this.#descriptor(record);
    if (record.state === "uploading") {
      throw new AgentAssetIngressError(409, "asset_upload_in_progress", "This asset upload is already in progress.");
    }
    if ([...this.#byGrantId.values()].filter((candidate) => candidate.state === "uploading").length >= this.#maxConcurrentUploads) {
      throw new AgentAssetIngressError(429, "asset_ingress_busy", "The asset upload concurrency limit is reached.");
    }
    if (record.expiresAt <= this.#now()) {
      await this.#discard(record);
      throw new AgentAssetIngressError(410, "asset_upload_expired", "The asset upload grant expired.");
    }
    if (mediaType?.toLowerCase() !== record.input.mediaType) {
      throw new AgentAssetIngressError(415, "asset_media_type_mismatch", "The upload Content-Type does not match its grant.");
    }
    if (contentLength !== record.input.byteLength) {
      throw new AgentAssetIngressError(400, "asset_length_header_mismatch", "Content-Length must exactly match the granted byte_length.");
    }
    if (!body) throw new AgentAssetIngressError(400, "asset_body_required", "The granted binary request body is required.");
    const requestedFreeBytesAfterWrite = storagePolicy?.minimumFreeBytesAfterWrite;
    if (requestedFreeBytesAfterWrite !== undefined
      && (!Number.isSafeInteger(requestedFreeBytesAfterWrite) || requestedFreeBytesAfterWrite < 0)) {
      throw new AgentAssetIngressError(
        400,
        "invalid_request",
        "minimumFreeBytesAfterWrite must be a non-negative safe integer.",
      );
    }
    const minimumFreeBytesAfterWrite = Math.max(
      this.#minimumFreeBytesAfterUpload,
      requestedFreeBytesAfterWrite ?? 0,
    );

    // Reserve the concurrency slot before any further await. Two PUTs can
    // otherwise both observe awaiting_upload and race into the same temp file.
    record.state = "uploading";
    let root: string;
    try {
      root = await this.#root();
    } catch (error) {
      record.state = "awaiting_upload";
      throw error;
    }
    const partialPath = join(root, `${record.grantId}.partial`);
    const filePath = join(root, `${record.grantId}.asset`);
    record.partialPath = partialPath;
    let file: FileHandle | undefined;
    let written = 0;
    const digest = createHash("sha256");
    const iterator = asAsyncBytes(body)[Symbol.asyncIterator]();
    const deadline = setTimeout(
      () => record.abortController.abort(),
      Math.max(1, record.expiresAt - this.#now()),
    );
    deadline.unref?.();
    try {
      file = await open(partialPath, "wx", 0o600);
      while (true) {
        const next = await nextBodyChunk(
          iterator,
          signal ? [record.abortController.signal, signal] : [record.abortController.signal],
        );
        if (next.done) break;
        const bytes = next.value;
        if (signal?.aborted || record.abortController.signal.aborted || record.expiresAt <= this.#now()) {
          throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled or expired.");
        }
        const previousWritten = written;
        written += bytes.byteLength;
        if (written > record.input.byteLength || written > this.#maxBytes) {
          throw new AgentAssetIngressError(413, "asset_body_too_large", "The upload body exceeds its granted byte_length.");
        }
        digest.update(bytes);
        await this.#writeUploadChunkWithReserve(
          file,
          root,
          bytes,
          record.input.byteLength - previousWritten,
          minimumFreeBytesAfterWrite,
          signal ? [record.abortController.signal, signal] : [record.abortController.signal],
        );
      }
      if (signal?.aborted || record.abortController.signal.aborted) {
        throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled.");
      }
      if (written !== record.input.byteLength) {
        throw new AgentAssetIngressError(422, "asset_size_mismatch", "The uploaded asset does not match its declared byte_length.");
      }
      const actualDigest = `sha256:${digest.digest("hex")}`;
      if (actualDigest !== record.input.sha256) {
        throw new AgentAssetIngressError(422, "asset_digest_mismatch", "The uploaded asset does not match its declared SHA-256 digest.");
      }
      await file.sync();
      await this.#writeUploadChunkWithReserve(
        file,
        root,
        new Uint8Array(0),
        0,
        minimumFreeBytesAfterWrite,
        signal ? [record.abortController.signal, signal] : [record.abortController.signal],
      );
      await file.close();
      file = undefined;
      if (record.abortController.signal.aborted || !this.#byGrantId.has(record.grantId)) {
        throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled.");
      }
      await rename(partialPath, filePath);
      record.partialPath = undefined;
      record.filePath = filePath;
      if (record.abortController.signal.aborted || !this.#byGrantId.has(record.grantId)) {
        await this.#discard(record);
        throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled.");
      }
      record.state = "ready";
      record.expiresAt = this.#now() + this.#candidateTtlMs;
      return this.#descriptor(record);
    } catch (error) {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      await file?.close().catch(() => undefined);
      try {
        await this.#removeTrackedFile(record, "partialPath");
      } catch (cleanupCause) {
        record.state = "cancelled";
        throw this.#cleanupError([error, cleanupCause]);
      }
      record.state = record.abortController.signal.aborted || !this.#byGrantId.has(record.grantId)
        ? "cancelled"
        : "awaiting_upload";
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  async #writeUploadChunkWithReserve(
    file: FileHandle,
    capacityPath: string,
    bytes: Uint8Array,
    remainingUploadBytes: number,
    minimumFreeBytesAfterWrite: number,
    signals: readonly AbortSignal[],
  ): Promise<void> {
    const previous = this.#uploadWriteTail;
    let release!: () => void;
    const turn = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.#uploadWriteTail = previous.then(() => turn);
    await previous;
    try {
      if (signals.some((candidate) => candidate.aborted)) {
        throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled or expired.");
      }
      let available: bigint;
      try {
        available = await this.#availableTemporaryBytes(capacityPath);
      } catch {
        throw new AgentAssetIngressError(
          507,
          "asset_upload_storage_unavailable",
          "Temporary asset storage capacity could not be verified safely.",
        );
      }
      if (typeof available !== "bigint" || available < 0n) {
        throw new AgentAssetIngressError(
          507,
          "asset_upload_storage_unavailable",
          "Temporary asset storage capacity could not be verified safely.",
        );
      }
      const required = BigInt(minimumFreeBytesAfterWrite) + BigInt(remainingUploadBytes);
      if (available < required) {
        throw new AgentAssetIngressError(
          507,
          "asset_upload_storage_exhausted",
          "The temporary volume cannot stage this asset while preserving its free-space reserve.",
        );
      }
      if (signals.some((candidate) => candidate.aborted)) {
        throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled or expired.");
      }
      await writeAll(file, bytes);
    } finally {
      release();
    }
  }

  async inspect(candidateHandle: string, workspaceId: string): Promise<AgentAssetCandidateDescriptor> {
    const record = await this.#readyCandidate(candidateHandle, workspaceId);
    return this.#descriptor(record);
  }

  /**
   * Internal metadata handoff for a trusted producer that still owns an exact
   * ready candidate. This is deliberately not exposed through REST or MCP:
   * browser readers must see one stable label for the bytes they preflight.
   */
  async relabelCandidate(
    candidateHandle: string,
    authorizationId: string,
    workspaceId: string,
    displayName: string,
  ): Promise<void> {
    this.#assertOpen();
    if (typeof displayName !== "string") {
      throw new AgentAssetIngressError(400, "invalid_request", "display_name must be a plain string label.");
    }
    const normalizedDisplayName = safeDisplayName(displayName);
    await this.sweepExpired();
    const record = this.#byCandidate.get(candidateHandle);
    if (record) {
      if (record.authorizationId !== authorizationId || record.input.workspaceId !== workspaceId) {
        throw new AgentAssetIngressError(404, "asset_candidate_not_found", "The asset candidate is invalid or expired.");
      }
      if (record.state !== "ready" || !record.filePath) {
        throw new AgentAssetIngressError(409, "asset_candidate_not_ready", "Only a ready asset candidate can be relabelled.");
      }
      if (record.displayName === normalizedDisplayName) return;
      if (record.activeReaders > 0) {
        throw new AgentAssetIngressError(409, "asset_candidate_in_use", "A candidate being read cannot be relabelled.");
      }
      record.displayName = normalizedDisplayName;
      return;
    }
    const completed = this.#completedByCandidate.get(candidateHandle);
    if (!completed || completed.authorizationId !== authorizationId || completed.workspaceId !== workspaceId) {
      throw new AgentAssetIngressError(404, "asset_candidate_not_found", "The asset candidate is invalid or expired.");
    }
    if (completed.displayName !== normalizedDisplayName) {
      throw new AgentAssetIngressError(
        409,
        "asset_candidate_already_completed",
        "A completed asset candidate cannot be relabelled retroactively.",
      );
    }
  }

  /**
   * Internal lease extension for a trusted producer that still owns the exact
   * Workspace candidate. This is intentionally not wired to REST or MCP.
   */
  async reserveCandidate(
    candidateHandle: string,
    authorizationId: string,
    workspaceId: string,
    minimumTtlMs = this.#candidateTtlMs,
  ): Promise<AgentAssetCandidateReservation> {
    this.#assertOpen();
    if (
      !Number.isSafeInteger(minimumTtlMs)
      || minimumTtlMs < 1
      || minimumTtlMs > MAX_AGENT_ASSET_RESERVATION_TTL_MS
    ) {
      throw new AgentAssetIngressError(
        400,
        "asset_reservation_ttl_invalid",
        `minimumTtlMs must be an integer between 1 and ${MAX_AGENT_ASSET_RESERVATION_TTL_MS}.`,
      );
    }
    await this.sweepExpired();
    const now = this.#now();
    const requestedExpiry = now + minimumTtlMs;
    const maximumExpiry = now + MAX_AGENT_ASSET_RESERVATION_TTL_MS;
    const record = this.#byCandidate.get(candidateHandle);
    if (record) {
      if (record.authorizationId !== authorizationId || record.input.workspaceId !== workspaceId) {
        throw new AgentAssetIngressError(404, "asset_candidate_not_found", "The asset candidate is invalid or expired.");
      }
      if (record.state !== "ready" || !record.filePath) {
        throw new AgentAssetIngressError(409, "asset_candidate_not_ready", "Only a ready asset candidate can be reserved.");
      }
      record.expiresAt = Math.min(maximumExpiry, Math.max(record.expiresAt, requestedExpiry));
      return Object.freeze({
        candidateHandle,
        status: "ready",
        expiresAt: new Date(record.expiresAt).toISOString(),
      });
    }
    const completed = this.#completedByCandidate.get(candidateHandle);
    if (
      !completed
      || completed.authorizationId !== authorizationId
      || completed.workspaceId !== workspaceId
    ) {
      throw new AgentAssetIngressError(404, "asset_candidate_not_found", "The asset candidate is invalid or expired.");
    }
    completed.expiresAt = Math.min(maximumExpiry, Math.max(completed.expiresAt, requestedExpiry));
    return Object.freeze({
      candidateHandle,
      status: "completed",
      expiresAt: new Date(completed.expiresAt).toISOString(),
    });
  }

  async open(candidateHandle: string, workspaceId: string): Promise<OpenAgentAssetCandidate> {
    const record = await this.#readyCandidate(candidateHandle, workspaceId);
    if (!record.filePath) throw new AgentAssetIngressError(409, "asset_candidate_not_ready", "The asset candidate is not ready.");
    const source = createReadStream(record.filePath, { highWaterMark: 256 * 1024 });
    record.activeReaders += 1;
    record.readStreams.add(source);
    let released = false;
    const readerDeadline = setTimeout(() => source.destroy(), Math.max(1, record.expiresAt - this.#now()));
    readerDeadline.unref?.();
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(readerDeadline);
      record.activeReaders = Math.max(0, record.activeReaders - 1);
      record.readStreams.delete(source);
    };
    source.once("end", release);
    source.once("close", release);
    source.once("error", release);
    const body = Readable.toWeb(source) as ReadableStream<Uint8Array>;
    return Object.freeze({ descriptor: this.#descriptor(record), body, release });
  }

  async complete(candidateHandle: string, workspaceId: string): Promise<{ completed: true }> {
    const completed = this.#completedByCandidate.get(candidateHandle);
    if (completed && completed.workspaceId === workspaceId && completed.expiresAt > this.#now()) {
      return { completed: true };
    }
    const record = await this.#readyCandidate(candidateHandle, workspaceId);
    if (record.activeReaders > 0) {
      throw new AgentAssetIngressError(409, "asset_candidate_in_use", "Finish reading the asset candidate before completing it.");
    }
    const completedAt = this.#now();
    const tombstone: CompletedImport = {
      authorizationId: record.authorizationId,
      requestKey: record.requestKey,
      candidateHandle: record.candidateHandle,
      workspaceId: record.input.workspaceId,
      input: record.input,
      displayName: record.displayName,
      expiresAt: Math.min(
        completedAt + MAX_AGENT_ASSET_RESERVATION_TTL_MS,
        Math.max(record.expiresAt, completedAt + this.#candidateTtlMs),
      ),
    };
    await this.#discard(record);
    this.#completedByRequest.set(tombstone.requestKey, tombstone);
    this.#completedByCandidate.set(tombstone.candidateHandle, tombstone);
    return { completed: true };
  }

  async cancelFromBrowser(candidateHandle: string, workspaceId: string): Promise<{ cancelled: true }> {
    const record = this.#candidate(candidateHandle, workspaceId);
    await this.#discard(record);
    return { cancelled: true };
  }

  async cancelFromAgent(
    candidateHandle: string,
    authorizationId: string,
  ): Promise<{ cancelled: true }> {
    const record = this.#byCandidate.get(candidateHandle);
    if (!record || record.authorizationId !== authorizationId) {
      throw new AgentAssetIngressError(404, "asset_candidate_not_found", "The asset candidate is invalid or expired.");
    }
    await this.#discard(record);
    return { cancelled: true };
  }

  async revokeAuthorization(authorizationId: string): Promise<{ revoked: number }> {
    const records = [...this.#byGrantId.values()]
      .filter((record) => record.authorizationId === authorizationId);
    await Promise.all(records.map((record) => this.#discard(record)));
    for (const completed of this.#completedByRequest.values()) {
      if (completed.authorizationId !== authorizationId) continue;
      this.#completedByRequest.delete(completed.requestKey);
      this.#completedByCandidate.delete(completed.candidateHandle);
    }
    return { revoked: records.length };
  }

  async revokeAll(): Promise<{ revoked: number }> {
    const records = [...this.#byGrantId.values()];
    await Promise.all(records.map((record) => this.#discard(record)));
    this.#completedByRequest.clear();
    this.#completedByCandidate.clear();
    return { revoked: records.length };
  }

  async revokeAllExceptAuthorization(retainedAuthorizationId: string): Promise<{ revoked: number }> {
    if (!retainedAuthorizationId) return this.revokeAll();
    const records = [...this.#byGrantId.values()]
      .filter((record) => record.authorizationId !== retainedAuthorizationId);
    await Promise.all(records.map((record) => this.#discard(record)));
    for (const completed of this.#completedByRequest.values()) {
      if (completed.authorizationId === retainedAuthorizationId) continue;
      this.#completedByRequest.delete(completed.requestKey);
      this.#completedByCandidate.delete(completed.candidateHandle);
    }
    return { revoked: records.length };
  }

  async sweepExpired(): Promise<void> {
    if (this.#closed) return;
    const now = this.#now();
    await Promise.all(
      [...this.#byGrantId.values()]
        .filter((record) => record.expiresAt <= now && record.activeReaders === 0)
        .map((record) => this.#discard(record)),
    );
    for (const completed of this.#completedByRequest.values()) {
      if (completed.expiresAt > now) continue;
      this.#completedByRequest.delete(completed.requestKey);
      this.#completedByCandidate.delete(completed.candidateHandle);
    }
  }

  async close(): Promise<void> {
    if (this.#closeComplete) return;
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    const operation = this.#closeResources();
    this.#closePromise = operation;
    try {
      await operation;
      this.#closeComplete = true;
    } finally {
      if (this.#closePromise === operation) this.#closePromise = undefined;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new AgentAssetIngressError(503, "asset_ingress_closed", "The asset ingress is shutting down.");
  }

  #root(): Promise<string> {
    if (!this.#rootPromise) {
      this.#rootPromise = this.#startupPromise.then(() => this.#createOwnedRoot());
    }
    return this.#rootPromise;
  }

  async #createOwnedRoot(): Promise<string> {
    await mkdir(this.#temporaryDirectory, { recursive: true });
    const staging = join(this.#temporaryDirectory, `${ASSET_STAGING_PREFIX}${process.pid}-${this.#instanceId}`);
    const root = join(this.#temporaryDirectory, `${ASSET_ROOT_PREFIX}${this.#instanceId}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const lease: AssetRootLease = Object.freeze({
        version: 1,
        pid: process.pid,
        instanceId: this.#instanceId,
        createdAt: new Date(this.#now()).toISOString(),
      });
      const leaseFile = await open(join(staging, ASSET_LEASE_FILE), "wx", 0o600);
      try {
        await writeAll(leaseFile, new TextEncoder().encode(JSON.stringify(lease)));
        await leaseFile.sync();
      } finally {
        await leaseFile.close();
      }
      await rename(staging, root);
      return root;
    } catch (error) {
      try {
        await this.#deleteDirectory(staging);
      } catch (cleanupCause) {
        throw new AggregateError([error, cleanupCause], "Agent asset root creation and cleanup both failed.");
      }
      throw error;
    }
  }

  async #collectStartupOrphans(): Promise<void> {
    await mkdir(this.#temporaryDirectory, { recursive: true });
    const entries = await readdir(this.#temporaryDirectory, { withFileTypes: true });
    const failures: unknown[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (
        !ASSET_ROOT_PATTERN.test(entry.name)
        && !ASSET_QUARANTINE_PATTERN.test(entry.name)
        && !ASSET_STAGING_PATTERN.test(entry.name)
      ) continue;
      try {
        await this.#recoverOrphan(join(this.#temporaryDirectory, entry.name));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to recover ${failures.length} orphaned Agent asset root(s).`);
    }
  }

  async #recoverOrphan(candidatePath: string): Promise<void> {
    let info;
    try {
      info = await lstat(candidatePath);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const firstLease = await this.#readLease(candidatePath);
    if (!firstLease || this.#leaseOwnerIsAlive(firstLease)) return;

    const quarantinePath = join(this.#temporaryDirectory, `${ASSET_QUARANTINE_PREFIX}${randomUUID()}`);
    try {
      await rename(candidatePath, quarantinePath);
    } catch (error) {
      // Another startup collector won the atomic quarantine race.
      if (isNotFound(error)) return;
      throw error;
    }

    const secondLease = await this.#readLease(quarantinePath);
    if (!secondLease) {
      try {
        await lstat(quarantinePath);
      } catch (error) {
        // A concurrent collector may have atomically moved this quarantine
        // again. It now owns the recheck and deletion attempt.
        if (isNotFound(error)) return;
        throw error;
      }
    }
    if (!secondLease || !sameLease(firstLease, secondLease) || this.#leaseOwnerIsAlive(secondLease)) {
      try {
        await rename(quarantinePath, candidatePath);
      } catch (restoreError) {
        if (isNotFound(restoreError)) return;
        throw new AggregateError(
          [restoreError],
          "An Agent asset root changed ownership during quarantine and could not be restored.",
        );
      }
      return;
    }
    await this.#deleteDirectory(quarantinePath);
  }

  async #readLease(root: string): Promise<AssetRootLease | undefined> {
    let leaseFile: FileHandle;
    try {
      leaseFile = await open(
        join(root, ASSET_LEASE_FILE),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isNotFound(error) || (typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP")) {
        return undefined;
      }
      throw error;
    }
    try {
      const info = await leaseFile.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_LEASE_BYTES) return undefined;
      const bytes = await leaseFile.readFile();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        return undefined;
      }
      return parseAssetRootLease(parsed);
    } finally {
      await leaseFile.close();
    }
  }

  #leaseOwnerIsAlive(lease: AssetRootLease): boolean {
    try {
      return this.#isProcessAlive(lease.pid);
    } catch {
      return true;
    }
  }

  async #deleteDirectory(path: string): Promise<void> {
    try {
      await this.#removeDirectory(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async #closeResources(): Promise<void> {
    const failures: unknown[] = [];
    const provisionalFileFailures: unknown[] = [];
    try {
      await this.#startupPromise;
    } catch (error) {
      failures.push(error);
    }

    for (const record of this.#byGrantId.values()) this.#cancelRecord(record);
    await Promise.allSettled([...this.#activeUploads]);

    const records = [...this.#byGrantId.values()];
    const discarded = await Promise.allSettled(records.map((record) => this.#discard(record)));
    for (const result of discarded) {
      if (result.status === "rejected") provisionalFileFailures.push(result.reason);
    }
    this.#completedByRequest.clear();
    this.#completedByCandidate.clear();

    let root: string | undefined;
    if (this.#rootPromise) {
      try {
        root = await this.#rootPromise;
      } catch (error) {
        failures.push(error);
      }
    }
    if (root) {
      try {
        await this.#deleteDirectory(root);
        // A successful recursive root deletion is authoritative even if an
        // earlier per-file unlink reported a failure.
        for (const record of [...this.#byGrantId.values()]) {
          record.partialPath = undefined;
          record.filePath = undefined;
          this.#forgetRecord(record);
        }
      } catch (error) {
        failures.push(...provisionalFileFailures);
        failures.push(error);
      }
    } else {
      failures.push(...provisionalFileFailures);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Agent asset ingress cleanup failed for ${failures.length} resource(s).`);
    }
  }

  #candidate(candidateHandle: string, workspaceId: string): AssetGrantRecord {
    if (!HANDLE_PATTERN.test(candidateHandle) || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new AgentAssetIngressError(404, "asset_candidate_not_found", "The asset candidate is invalid or expired.");
    }
    const record = this.#byCandidate.get(candidateHandle);
    if (!record || record.input.workspaceId !== workspaceId) {
      throw new AgentAssetIngressError(404, "asset_candidate_not_found", "The asset candidate is invalid or expired.");
    }
    return record;
  }

  async #readyCandidate(candidateHandle: string, workspaceId: string): Promise<AssetGrantRecord> {
    await this.sweepExpired();
    const record = this.#candidate(candidateHandle, workspaceId);
    if (record.state !== "ready" || !record.filePath) {
      throw new AgentAssetIngressError(409, "asset_candidate_not_ready", "The asset candidate has not finished uploading.");
    }
    return record;
  }

  #descriptor(record: AssetGrantRecord): AgentAssetCandidateDescriptor {
    return Object.freeze({
      version: 1,
      candidateHandle: record.candidateHandle,
      requestId: record.input.requestId,
      workspaceId: record.input.workspaceId,
      displayName: record.displayName,
      format: record.input.format,
      mediaType: record.input.mediaType,
      byteLength: record.input.byteLength,
      sha256: record.input.sha256,
      purpose: record.input.purpose ?? "generic_import",
      status: record.state === "ready" ? "ready" : "awaiting_upload",
      expiresAt: new Date(record.expiresAt).toISOString(),
    });
  }

  #grantView(record: AssetGrantRecord): AgentAssetImportGrant {
    const descriptor = this.#descriptor(record);
    if (record.state === "ready") return descriptor;
    return Object.freeze({
      ...descriptor,
      upload: Object.freeze({
        method: "PUT",
        url: `${this.#publicBaseUrl}/v1/assets/uploads/${record.grantId}`,
        authorization: "Bearer",
        token: record.uploadToken,
        contentType: record.input.mediaType,
        contentLength: record.input.byteLength,
      }),
    });
  }

  async #discard(record: AssetGrantRecord): Promise<void> {
    if (record.discardPromise) return record.discardPromise;
    if (!this.#byGrantId.has(record.grantId) && !record.partialPath && !record.filePath) return;
    const operation = this.#performDiscard(record);
    record.discardPromise = operation;
    try {
      await operation;
    } finally {
      if (record.discardPromise === operation) record.discardPromise = undefined;
    }
  }

  async #performDiscard(record: AssetGrantRecord): Promise<void> {
    this.#cancelRecord(record);
    const removed = await Promise.allSettled([
      this.#removeTrackedFile(record, "partialPath"),
      this.#removeTrackedFile(record, "filePath"),
    ]);
    const failures = removed
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw this.#cleanupError(failures);
    // Delete-before-forget: every tracked path is gone before the capability
    // leaves the indexes. A failed unlink therefore remains retryable.
    this.#forgetRecord(record);
  }

  #cancelRecord(record: AssetGrantRecord): void {
    record.state = "cancelled";
    record.abortController.abort();
    for (const reader of record.readStreams) reader.destroy();
    record.readStreams.clear();
    record.activeReaders = 0;
  }

  async #removeTrackedFile(
    record: AssetGrantRecord,
    key: "partialPath" | "filePath",
  ): Promise<void> {
    const path = record[key];
    if (!path) return;
    try {
      await this.#removeFile(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (record[key] === path) record[key] = undefined;
  }

  #forgetRecord(record: AssetGrantRecord): void {
    if (this.#byGrantId.get(record.grantId) === record) this.#byGrantId.delete(record.grantId);
    if (this.#byCandidate.get(record.candidateHandle) === record) {
      this.#byCandidate.delete(record.candidateHandle);
    }
    if (this.#byRequest.get(record.requestKey) === record) this.#byRequest.delete(record.requestKey);
  }

  #cleanupError(failures: readonly unknown[]): AgentAssetIngressError {
    return new AgentAssetIngressError(
      500,
      "asset_cleanup_failed",
      "The staged asset could not be removed; its cleanup capability remains tracked for retry.",
      { cause: new AggregateError(failures, "Agent asset file cleanup failed.") },
    );
  }
}
