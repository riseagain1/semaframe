import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";

export const AGENT_ASSET_IMPORT_SCOPE = "asset:import" as const;
export const DEFAULT_AGENT_ASSET_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_AGENT_ASSET_STAGED_BYTES = 512 * 1024 * 1024;

export type AgentAssetFormat = "ply" | "spz" | "sog";

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

export class AgentAssetIngressError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
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
  state: GrantState;
  expiresAt: number;
  partialPath?: string;
  filePath?: string;
  abortController: AbortController;
  activeReaders: number;
  readStreams: Set<ReadStream>;
};

type CompletedImport = {
  authorizationId: string;
  requestKey: string;
  candidateHandle: string;
  workspaceId: string;
  input: BeginAgentAssetImportInput;
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
  return Object.freeze({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    displayName: safeDisplayName(input.displayName),
    format: input.format,
    mediaType,
    byteLength: input.byteLength,
    sha256: digest,
  });
}

function inputsMatch(left: BeginAgentAssetImportInput, right: BeginAgentAssetImportInput): boolean {
  return left.requestId === right.requestId &&
    left.workspaceId === right.workspaceId &&
    left.displayName === right.displayName &&
    left.format === right.format &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256;
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
  readonly #byGrantId = new Map<string, AssetGrantRecord>();
  readonly #byCandidate = new Map<string, AssetGrantRecord>();
  readonly #byRequest = new Map<string, AssetGrantRecord>();
  readonly #completedByRequest = new Map<string, CompletedImport>();
  readonly #completedByCandidate = new Map<string, CompletedImport>();
  readonly #activeUploads = new Set<Promise<unknown>>();
  readonly #sweepTimer?: ReturnType<typeof setInterval>;
  #rootPromise?: Promise<string>;
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
    if (!isAbsolute(this.#temporaryDirectory) || this.#temporaryDirectory.includes("\u0000")) {
      throw new Error("temporaryDirectory must be an absolute path.");
    }
    const sweepIntervalMs = options.sweepIntervalMs ?? Math.min(30_000, this.#grantTtlMs);
    if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 0) {
      throw new RangeError("sweepIntervalMs must be a non-negative integer.");
    }
    if (sweepIntervalMs > 0) {
      this.#sweepTimer = setInterval(() => { void this.sweepExpired(); }, sweepIntervalMs);
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
    const existing = this.#byRequest.get(requestKey);
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
  ): Promise<AgentAssetCandidateDescriptor> {
    const operation = this.#performUpload(
      grantId,
      uploadToken,
      mediaType,
      contentLength,
      body,
      signal,
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
        written += bytes.byteLength;
        if (written > record.input.byteLength || written > this.#maxBytes) {
          throw new AgentAssetIngressError(413, "asset_body_too_large", "The upload body exceeds its granted byte_length.");
        }
        digest.update(bytes);
        await writeAll(file, bytes);
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
      await file.close();
      file = undefined;
      if (record.abortController.signal.aborted || !this.#byGrantId.has(record.grantId)) {
        throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled.");
      }
      await rename(partialPath, filePath);
      record.partialPath = undefined;
      if (record.abortController.signal.aborted || !this.#byGrantId.has(record.grantId)) {
        await unlink(filePath).catch(() => undefined);
        throw new AgentAssetIngressError(410, "asset_upload_cancelled", "The asset upload was cancelled.");
      }
      record.filePath = filePath;
      record.state = "ready";
      record.expiresAt = this.#now() + this.#candidateTtlMs;
      return this.#descriptor(record);
    } catch (error) {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      await file?.close().catch(() => undefined);
      await unlink(partialPath).catch(() => undefined);
      record.partialPath = undefined;
      record.state = this.#byGrantId.has(record.grantId) ? "awaiting_upload" : "cancelled";
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  async inspect(candidateHandle: string, workspaceId: string): Promise<AgentAssetCandidateDescriptor> {
    const record = await this.#readyCandidate(candidateHandle, workspaceId);
    return this.#descriptor(record);
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
    const tombstone: CompletedImport = {
      authorizationId: record.authorizationId,
      requestKey: record.requestKey,
      candidateHandle: record.candidateHandle,
      workspaceId: record.input.workspaceId,
      input: record.input,
      expiresAt: this.#now() + this.#candidateTtlMs,
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
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    await Promise.all([...this.#byGrantId.values()].map((record) => this.#discard(record)));
    await Promise.allSettled([...this.#activeUploads]);
    this.#completedByRequest.clear();
    this.#completedByCandidate.clear();
    const root = await this.#rootPromise?.catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  #assertOpen(): void {
    if (this.#closed) throw new AgentAssetIngressError(503, "asset_ingress_closed", "The asset ingress is shutting down.");
  }

  #root(): Promise<string> {
    if (!this.#rootPromise) {
      this.#rootPromise = mkdir(this.#temporaryDirectory, { recursive: true })
        .then(() => mkdtemp(join(this.#temporaryDirectory, "semaframe-agent-assets-")));
    }
    return this.#rootPromise;
  }

  #candidate(candidateHandle: string, workspaceId: string): AssetGrantRecord {
    if (!HANDLE_PATTERN.test(candidateHandle) || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new AgentAssetIngressError(404, "asset_candidate_not_found", "The asset candidate is invalid or expired.");
    }
    const record = this.#byCandidate.get(candidateHandle);
    if (!record || record.input.workspaceId !== workspaceId || record.state === "cancelled") {
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
      displayName: record.input.displayName,
      format: record.input.format,
      mediaType: record.input.mediaType,
      byteLength: record.input.byteLength,
      sha256: record.input.sha256,
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
    if (record.state === "cancelled" && !this.#byGrantId.has(record.grantId)) return;
    record.state = "cancelled";
    record.abortController.abort();
    for (const reader of record.readStreams) reader.destroy();
    record.readStreams.clear();
    record.activeReaders = 0;
    this.#byGrantId.delete(record.grantId);
    this.#byCandidate.delete(record.candidateHandle);
    this.#byRequest.delete(record.requestKey);
    await Promise.all([
      record.partialPath ? unlink(record.partialPath).catch(() => undefined) : Promise.resolve(),
      record.filePath ? unlink(record.filePath).catch(() => undefined) : Promise.resolve(),
    ]);
    record.partialPath = undefined;
    record.filePath = undefined;
  }
}
