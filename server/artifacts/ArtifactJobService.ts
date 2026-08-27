import { createHash, randomUUID } from "node:crypto";
import {
  boundedExtensionJsonByteLength,
  canonicalizeExtensionJson,
  extensionJsonClone,
  type ExtensionJsonValue,
} from "../../src/extensions";
import {
  ARTIFACT_JOB_SCHEMA_VERSION,
  artifactProviderDescriptorSha256V1,
  type ArtifactCandidateV1,
  type ArtifactJobArtifactV1,
  type ArtifactJobErrorV1,
  type ArtifactJobProgressV1,
  type ArtifactJobScopeV1,
  type ArtifactJobSnapshotV1,
  type ArtifactJobStatusV1,
  type ArtifactJobSubmitRequestV1,
  type ArtifactProviderDescriptorV1,
  type ArtifactProviderRegistrationV1,
} from "../../src/workspace/artifacts";
import type { JSONValue } from "../../src/workspace/components/componentTypes";
import { assertNoEmbeddedSecrets } from "../../src/workspace/data/resourceSecurity";

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_FILE_NAME = /^(?!\.\.?$)(?!.*[\\/])[\x20-\x7e]{1,256}$/u;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/iu;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_RUNTIME_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 16;
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

type InternalErrorCode = ArtifactJobErrorV1["code"];

class ArtifactExecutionError extends Error {
  constructor(readonly publicCode: InternalErrorCode, message: string) {
    super(message);
    this.name = "ArtifactExecutionError";
  }
}

export class ArtifactJobServiceError extends Error {
  constructor(
    readonly code:
      | "invalid_configuration"
      | "invalid_request"
      | "provider_not_found"
      | "provider_collision"
      | "provider_digest_mismatch"
      | "capacity_exhausted"
      | "idempotency_mismatch"
      | "job_not_found"
      | "job_not_terminal"
      | "artifact_not_found"
      | "artifact_digest_mismatch"
      | "permission_required",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactJobServiceError";
  }
}

export type ArtifactExtensionAuthorizationV1 = Readonly<{
  grantToken: string;
  ownerId: string;
  workspaceId: string;
  providerId: string;
  extensionId: string;
  extensionVersion: string;
  manifestSha256: `sha256:${string}`;
  permission: "exporter:execute" | "bridge:push" | "bridge:pull";
}>;

export type ArtifactJobServiceOptions = Readonly<{
  providers: readonly ArtifactProviderRegistrationV1[];
  maxQueued?: number;
  maxConcurrent?: number;
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  maxArtifacts?: number;
  ttlMs?: number;
  now?: () => number;
  createId?: () => string;
  authorizeExtension?(request: ArtifactExtensionAuthorizationV1): void | Promise<void>;
}>;

type StoredArtifact = {
  bytes: Uint8Array;
  references: number;
};

type JobRecord = {
  jobId: string;
  requestId: string;
  ownerId: string;
  workspaceId: string;
  provider: ArtifactProviderRegistrationV1;
  requestSha256: `sha256:${string}`;
  input: ExtensionJsonValue;
  options?: ExtensionJsonValue;
  pendingGrantToken?: string;
  status: ArtifactJobStatusV1;
  progress: ArtifactJobProgressV1;
  artifacts: readonly ArtifactJobArtifactV1[];
  error?: ArtifactJobErrorV1;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  expiresAtMs: number;
  controller?: AbortController;
  cancelRequested: boolean;
  timedOut: boolean;
};

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new ArtifactJobServiceError("invalid_configuration", `${name} must be between ${min} and ${max}.`);
  }
  return resolved;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function jsonClone<T extends ExtensionJsonValue>(value: T): T {
  return deepFreeze(extensionJsonClone(value));
}

function sha256Bytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Text(text: string): `sha256:${string}` {
  return sha256Bytes(new TextEncoder().encode(text));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function requestKey(request: Pick<ArtifactJobSubmitRequestV1, "ownerId" | "workspaceId" | "requestId">): string {
  return `${request.ownerId}\u0000${request.workspaceId}\u0000${request.requestId}`;
}

function safeIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.length > 128 || !IDENTIFIER.test(value)) {
    throw new ArtifactJobServiceError("invalid_configuration", `${name} is invalid.`);
  }
}

function safeScopeText(value: string, name: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ArtifactJobServiceError("invalid_request", `${name} is invalid.`);
  }
}

function descriptorDocument(descriptor: ArtifactProviderDescriptorV1) {
  return {
    schemaVersion: descriptor.schemaVersion,
    kind: descriptor.kind,
    providerId: descriptor.providerId,
    providerVersion: descriptor.providerVersion,
    displayName: descriptor.displayName,
    origin: descriptor.origin,
  } as const;
}

function validateDescriptor(descriptor: ArtifactProviderDescriptorV1): void {
  if (descriptor.schemaVersion !== ARTIFACT_JOB_SCHEMA_VERSION) {
    throw new ArtifactJobServiceError("invalid_configuration", "Artifact provider schemaVersion is unsupported.");
  }
  safeIdentifier(descriptor.providerId, "Artifact provider id");
  if (!SEMVER.test(descriptor.providerVersion)) {
    throw new ArtifactJobServiceError("invalid_configuration", "Artifact provider version must be semantic.");
  }
  if (typeof descriptor.displayName !== "string" || descriptor.displayName.length < 1 || descriptor.displayName.length > 128) {
    throw new ArtifactJobServiceError("invalid_configuration", "Artifact provider display name is invalid.");
  }
  if (/[\u0000-\u001f\u007f]/u.test(descriptor.displayName)
    || LOCAL_PATH_VALUE.test(descriptor.displayName.trim())
    || SECRET_VALUE.test(descriptor.displayName.trim())) {
    throw new ArtifactJobServiceError("invalid_configuration", "Artifact provider display name contains private host material.");
  }
  if (!SHA256.test(descriptor.descriptorSha256)) {
    throw new ArtifactJobServiceError("invalid_configuration", "Artifact provider descriptor digest is invalid.");
  }
  if (descriptor.origin.kind === "builtin") {
    safeIdentifier(descriptor.origin.hostProviderId, "Artifact host provider id");
    if (!SEMVER.test(descriptor.origin.hostProviderVersion)) {
      throw new ArtifactJobServiceError("invalid_configuration", "Artifact host provider version must be semantic.");
    }
  } else {
    safeIdentifier(descriptor.origin.extensionId, "Artifact extension id");
    if (!SEMVER.test(descriptor.origin.extensionVersion) || !SHA256.test(descriptor.origin.manifestSha256)) {
      throw new ArtifactJobServiceError("invalid_configuration", "Artifact extension binding is invalid.");
    }
    const expected = descriptor.kind === "exporter"
      ? "exporter:execute"
      : ["bridge:push", "bridge:pull"].includes(descriptor.origin.requiredPermission)
        ? descriptor.origin.requiredPermission
        : undefined;
    if (!expected || descriptor.origin.requiredPermission !== expected) {
      throw new ArtifactJobServiceError("invalid_configuration", "Artifact extension permission does not match provider kind.");
    }
  }
}

const SECRET_KEY = /^(?:access[_-]?token|api[_-]?key|authorization|auth[_-]?token|bearer|client[_-]?secret|credential|credentials|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)$/iu;
const LOCAL_PATH_KEY = /^(?:cwd|file[_-]?path|local[_-]?path|output[_-]?path|path|source[_-]?path|temp[_-]?path|working[_-]?directory)$/iu;
const LOCAL_PATH_VALUE = /^(?:file:\/\/|\/(?:Users|home|private|tmp|var|etc|opt)(?:\/|$)|[A-Za-z]:[\\/])/u;
const SECRET_VALUE = /^(?:bearer|basic)\s+\S{8,}$|^(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._~-]{8,}$|^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/iu;

function assertNoAmbientAuthority(value: ExtensionJsonValue, path = "$", depth = 0): void {
  if (depth > 64) throw new ArtifactJobServiceError("invalid_request", "Artifact request exceeds its depth limit.");
  if (depth === 0) assertNoEmbeddedSecrets(value as JSONValue);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (LOCAL_PATH_VALUE.test(trimmed) || SECRET_VALUE.test(trimmed)) {
      throw new ArtifactJobServiceError(
        "invalid_request",
        `Artifact request contains raw credentials or a local path at ${path}; use a host-owned capability reference.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAmbientAuthority(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || LOCAL_PATH_KEY.test(key)) {
      throw new ArtifactJobServiceError(
        "invalid_request",
        `Artifact request contains forbidden authority field ${path}.${key}; use a host-owned capability reference.`,
      );
    }
    assertNoAmbientAuthority(entry, `${path}.${key}`, depth + 1);
  }
}

function sanitizePublicMessage(value: unknown, fallback: string): string {
  let message = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  message = message
    .replace(/file:\/\/[^\s"']+/giu, "[redacted-path]")
    .replace(/\/(?:Users|home|private|tmp|var|etc|opt)(?:\/[^\s:"']+)+/gu, "[redacted-path]")
    .replace(/[A-Za-z]:\\(?:[^\s:"']+\\)*[^\s:"']+/gu, "[redacted-path]")
    .replace(/(?:bearer|basic)\s+\S+/giu, "[redacted-credential]")
    .replace(/(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._~-]{8,}/gu, "[redacted-credential]")
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu, "[redacted-credential]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  return (message || fallback).slice(0, 500);
}

function terminal(status: ArtifactJobStatusV1): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function publicError(code: InternalErrorCode, message: unknown): ArtifactJobErrorV1 {
  const fallback = code === "permission_denied"
    ? "Artifact provider permission was denied."
    : code === "timeout"
      ? "Artifact provider exceeded its runtime limit."
      : code === "canceled"
        ? "Artifact job was canceled."
        : "Artifact provider failed.";
  return deepFreeze({ code, message: sanitizePublicMessage(message, fallback) });
}

/**
 * Bounded asynchronous artifact executor and content-addressed result store.
 * It owns scheduling and bytes; providers only receive frozen JSON, an abort
 * signal, limits, and progress. No filesystem path or raw secret API exists.
 */
export class ArtifactJobService {
  readonly #providers: ReadonlyMap<string, ArtifactProviderRegistrationV1>;
  readonly #jobs = new Map<string, JobRecord>();
  readonly #requestIndex = new Map<string, string>();
  readonly #queue: string[] = [];
  readonly #artifacts = new Map<`sha256:${string}`, StoredArtifact>();
  readonly #waiters = new Map<string, Set<(snapshot: ArtifactJobSnapshotV1) => void>>();
  readonly #maxQueued: number;
  readonly #maxConcurrent: number;
  readonly #maxRuntimeMs: number;
  readonly #maxOutputBytes: number;
  readonly #maxArtifacts: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #authorizeExtension: ArtifactJobServiceOptions["authorizeExtension"];
  #running = 0;
  #drainScheduled = false;

  static async create(options: ArtifactJobServiceOptions): Promise<ArtifactJobService> {
    if (!Array.isArray(options.providers) || options.providers.length > 256) {
      throw new ArtifactJobServiceError("invalid_configuration", "Artifact provider count is invalid.");
    }
    const providers = new Map<string, ArtifactProviderRegistrationV1>();
    for (const registration of options.providers) {
      if (!registration || typeof registration.run !== "function") {
        throw new ArtifactJobServiceError("invalid_configuration", "Artifact provider callback is invalid.");
      }
      validateDescriptor(registration.descriptor);
      const digest = await artifactProviderDescriptorSha256V1(descriptorDocument(registration.descriptor));
      if (digest !== registration.descriptor.descriptorSha256) {
        throw new ArtifactJobServiceError(
          "provider_digest_mismatch",
          `Artifact provider ${registration.descriptor.providerId} descriptor digest does not match its contents.`,
        );
      }
      if (providers.has(registration.descriptor.providerId)) {
        throw new ArtifactJobServiceError(
          "provider_collision",
          `Artifact provider ${registration.descriptor.providerId} is registered more than once.`,
        );
      }
      const descriptor = deepFreeze(structuredClone(registration.descriptor));
      providers.set(descriptor.providerId, Object.freeze({ descriptor, run: registration.run }));
    }
    return new ArtifactJobService(options, providers);
  }

  private constructor(
    options: ArtifactJobServiceOptions,
    providers: ReadonlyMap<string, ArtifactProviderRegistrationV1>,
  ) {
    this.#providers = providers;
    this.#maxQueued = boundedInteger(options.maxQueued, DEFAULT_MAX_QUEUED, 1, 10_000, "maxQueued");
    this.#maxConcurrent = boundedInteger(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, 64, "maxConcurrent");
    this.#maxRuntimeMs = boundedInteger(options.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS, 10, 10 * 60_000, "maxRuntimeMs");
    this.#maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1, 2_147_483_647, "maxOutputBytes");
    this.#maxArtifacts = boundedInteger(options.maxArtifacts, DEFAULT_MAX_ARTIFACTS, 1, 1_000, "maxArtifacts");
    this.#ttlMs = boundedInteger(options.ttlMs, DEFAULT_TTL_MS, 100, 7 * 24 * 60 * 60_000, "ttlMs");
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#authorizeExtension = options.authorizeExtension;
  }

  providers(): readonly ArtifactProviderDescriptorV1[] {
    return Object.freeze([...this.#providers.values()].map((provider) => provider.descriptor));
  }

  submit(
    request: ArtifactJobSubmitRequestV1,
    authorization?: Readonly<{ grantToken: string }>,
  ): ArtifactJobSnapshotV1 {
    this.#sweepExpired();
    safeScopeText(request.ownerId, "Artifact owner id");
    safeScopeText(request.workspaceId, "Artifact workspace id");
    if (!REQUEST_ID.test(request.requestId)) {
      throw new ArtifactJobServiceError("invalid_request", "Artifact requestId is invalid.");
    }
    const provider = this.#providers.get(request.providerId);
    if (!provider) throw new ArtifactJobServiceError("provider_not_found", "Artifact provider was not found.");
    const input = this.#safeRequestJson(request.input, "input");
    const options = request.options === undefined ? undefined : this.#safeRequestJson(request.options, "options");
    const requestSha256 = sha256Text(canonicalizeExtensionJson({
      schemaVersion: ARTIFACT_JOB_SCHEMA_VERSION,
      providerId: provider.descriptor.providerId,
      providerVersion: provider.descriptor.providerVersion,
      providerSha256: provider.descriptor.descriptorSha256,
      input,
      ...(options === undefined ? {} : { options }),
    }));
    const key = requestKey(request);
    const existingId = this.#requestIndex.get(key);
    if (existingId) {
      const existing = this.#jobs.get(existingId);
      if (existing) {
        if (existing.requestSha256 !== requestSha256) {
          throw new ArtifactJobServiceError(
            "idempotency_mismatch",
            "Artifact requestId was already used with a different provider or payload.",
          );
        }
        return this.#snapshot(existing);
      }
      this.#requestIndex.delete(key);
    }
    const queued = this.#queue.reduce((count, jobId) => {
      const record = this.#jobs.get(jobId);
      return count + (record?.status === "queued" ? 1 : 0);
    }, 0);
    if (queued >= this.#maxQueued) {
      throw new ArtifactJobServiceError("capacity_exhausted", "Artifact job queue is full.");
    }
    let grantToken: string | undefined;
    if (provider.descriptor.origin.kind === "extension") {
      grantToken = authorization?.grantToken;
      if (!grantToken || grantToken.length < 16 || grantToken.length > 256 || !this.#authorizeExtension) {
        throw new ArtifactJobServiceError(
          "permission_required",
          "Extension artifact providers require a host capability grant.",
        );
      }
    }
    const now = this.#now();
    const jobId = this.#createId();
    if (typeof jobId !== "string" || jobId.length < 1 || jobId.length > 256 || this.#jobs.has(jobId)) {
      throw new ArtifactJobServiceError("invalid_configuration", "Artifact job id generator returned an invalid or duplicate id.");
    }
    const record: JobRecord = {
      jobId,
      requestId: request.requestId,
      ownerId: request.ownerId,
      workspaceId: request.workspaceId,
      provider,
      requestSha256,
      input,
      ...(options === undefined ? {} : { options }),
      ...(grantToken === undefined ? {} : { pendingGrantToken: grantToken }),
      status: "queued",
      progress: deepFreeze({ fraction: 0 }),
      artifacts: Object.freeze([]),
      createdAtMs: now,
      expiresAtMs: now + this.#ttlMs,
      cancelRequested: false,
      timedOut: false,
    };
    this.#jobs.set(jobId, record);
    this.#requestIndex.set(key, jobId);
    this.#queue.push(jobId);
    this.#scheduleDrain();
    return this.#snapshot(record);
  }

  get(scope: ArtifactJobScopeV1, jobId: string): ArtifactJobSnapshotV1 {
    this.#sweepExpired();
    return this.#snapshot(this.#owned(scope, jobId));
  }

  list(scope: ArtifactJobScopeV1): readonly ArtifactJobSnapshotV1[] {
    this.#sweepExpired();
    safeScopeText(scope.ownerId, "Artifact owner id");
    safeScopeText(scope.workspaceId, "Artifact workspace id");
    safeIdentifier(scope.providerId, "Artifact provider id");
    return Object.freeze([...this.#jobs.values()]
      .filter((record) => record.ownerId === scope.ownerId
        && record.workspaceId === scope.workspaceId
        && record.provider.descriptor.providerId === scope.providerId)
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.jobId.localeCompare(right.jobId))
      .map((record) => this.#snapshot(record)));
  }

  cancel(scope: ArtifactJobScopeV1, jobId: string): ArtifactJobSnapshotV1 {
    const record = this.#owned(scope, jobId);
    if (terminal(record.status)) return this.#snapshot(record);
    record.cancelRequested = true;
    if (record.status === "queued") {
      this.#finish(record, "canceled", publicError("canceled", "Artifact job was canceled before execution."));
      this.#scheduleDrain();
    } else {
      record.controller?.abort(new Error("Artifact job canceled."));
    }
    return this.#snapshot(record);
  }

  async waitForTerminal(
    scope: ArtifactJobScopeV1,
    jobId: string,
    waitMs = this.#maxRuntimeMs + 1_000,
  ): Promise<ArtifactJobSnapshotV1> {
    const record = this.#owned(scope, jobId);
    if (terminal(record.status)) return this.#snapshot(record);
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 10 * 60_000) {
      throw new ArtifactJobServiceError("invalid_request", "Artifact wait duration is invalid.");
    }
    return new Promise<ArtifactJobSnapshotV1>((resolve, reject) => {
      const waiter = (snapshot: ArtifactJobSnapshotV1) => {
        clearTimeout(timer);
        this.#waiters.get(jobId)?.delete(waiter);
        resolve(snapshot);
      };
      const timer = setTimeout(() => {
        this.#waiters.get(jobId)?.delete(waiter);
        reject(new ArtifactJobServiceError("job_not_terminal", "Artifact job did not reach a terminal state in time."));
      }, waitMs);
      const waiters = this.#waiters.get(jobId) ?? new Set();
      waiters.add(waiter);
      this.#waiters.set(jobId, waiters);
    });
  }

  readArtifact(scope: ArtifactJobScopeV1, jobId: string, artifactId: string): Uint8Array {
    const record = this.#owned(scope, jobId);
    const linked = record.artifacts.find((artifact) => artifact.artifactId === artifactId);
    if (!linked) throw new ArtifactJobServiceError("artifact_not_found", "Artifact was not found for this job.");
    const stored = this.#artifacts.get(linked.sha256);
    if (!stored) throw new ArtifactJobServiceError("artifact_not_found", "Artifact content is unavailable.");
    if (sha256Bytes(stored.bytes) !== linked.sha256 || stored.bytes.byteLength !== linked.byteLength) {
      throw new ArtifactJobServiceError("artifact_digest_mismatch", "Artifact content failed digest verification.");
    }
    return Uint8Array.from(stored.bytes);
  }

  discard(scope: ArtifactJobScopeV1, jobId: string): void {
    const record = this.#owned(scope, jobId);
    if (!terminal(record.status)) {
      throw new ArtifactJobServiceError("job_not_terminal", "Cancel or wait for the artifact job before discarding it.");
    }
    this.#deleteRecord(record);
  }

  #safeRequestJson(value: ExtensionJsonValue, label: string): ExtensionJsonValue {
    let clone: ExtensionJsonValue;
    try {
      clone = jsonClone(value);
      boundedExtensionJsonByteLength(clone, { maxBytes: MAX_REQUEST_BYTES });
      assertNoAmbientAuthority(clone);
    } catch (error) {
      if (error instanceof ArtifactJobServiceError) throw error;
      throw new ArtifactJobServiceError(
        "invalid_request",
        `Artifact ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return clone;
  }

  #owned(scope: ArtifactJobScopeV1, jobId: string): JobRecord {
    this.#sweepExpired();
    safeScopeText(scope.ownerId, "Artifact owner id");
    safeScopeText(scope.workspaceId, "Artifact workspace id");
    safeIdentifier(scope.providerId, "Artifact provider id");
    const record = this.#jobs.get(jobId);
    if (!record
      || record.ownerId !== scope.ownerId
      || record.workspaceId !== scope.workspaceId
      || record.provider.descriptor.providerId !== scope.providerId) {
      throw new ArtifactJobServiceError("job_not_found", "Artifact job was not found.");
    }
    return record;
  }

  #snapshot(record: JobRecord): ArtifactJobSnapshotV1 {
    return deepFreeze({
      schemaVersion: ARTIFACT_JOB_SCHEMA_VERSION,
      jobId: record.jobId,
      requestId: record.requestId,
      ownerId: record.ownerId,
      workspaceId: record.workspaceId,
      provider: record.provider.descriptor,
      requestSha256: record.requestSha256,
      status: record.status,
      progress: record.progress,
      artifacts: record.artifacts,
      ...(record.error ? { error: record.error } : {}),
      createdAt: iso(record.createdAtMs),
      ...(record.startedAtMs === undefined ? {} : { startedAt: iso(record.startedAtMs) }),
      ...(record.completedAtMs === undefined ? {} : { completedAt: iso(record.completedAtMs) }),
      expiresAt: iso(record.expiresAtMs),
    });
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#running < this.#maxConcurrent) {
      const jobId = this.#queue.shift();
      if (!jobId) break;
      const record = this.#jobs.get(jobId);
      if (!record || record.status !== "queued") continue;
      this.#running += 1;
      void this.#run(record).finally(() => {
        this.#running -= 1;
        this.#scheduleDrain();
      });
    }
  }

  async #run(record: JobRecord): Promise<void> {
    record.status = "running";
    record.startedAtMs = this.#now();
    record.progress = deepFreeze({ fraction: 0 });
    const controller = new AbortController();
    record.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new ArtifactExecutionError(
        record.timedOut ? "timeout" : "canceled",
        record.timedOut ? "Artifact provider exceeded its runtime limit." : "Artifact job was canceled.",
      )), { once: true });
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        record.timedOut = true;
        controller.abort(new Error("Artifact provider timed out."));
        reject(new ArtifactExecutionError("timeout", "Artifact provider exceeded its runtime limit."));
      }, this.#maxRuntimeMs);
    });
    const providerPromise = (async () => {
      if (record.provider.descriptor.origin.kind === "extension") {
        try {
          await this.#authorizeExtension!({
            grantToken: record.pendingGrantToken!,
            ownerId: record.ownerId,
            workspaceId: record.workspaceId,
            providerId: record.provider.descriptor.providerId,
            extensionId: record.provider.descriptor.origin.extensionId,
            extensionVersion: record.provider.descriptor.origin.extensionVersion,
            manifestSha256: record.provider.descriptor.origin.manifestSha256,
            permission: record.provider.descriptor.origin.requiredPermission,
          });
        } catch {
          throw new ArtifactExecutionError("permission_denied", "Artifact provider permission was denied.");
        }
      }
      if (controller.signal.aborted) {
        throw new ArtifactExecutionError(
          record.timedOut ? "timeout" : "canceled",
          record.timedOut ? "Artifact provider exceeded its runtime limit." : "Artifact job was canceled.",
        );
      }
      const candidates = await record.provider.run(
        Object.freeze({
          input: record.input,
          ...(record.options === undefined ? {} : { options: record.options }),
        }),
        Object.freeze({
          operationId: record.jobId,
          workspaceId: record.workspaceId,
          signal: controller.signal,
          limits: Object.freeze({
            maxArtifacts: this.#maxArtifacts,
            maxOutputBytes: this.#maxOutputBytes,
            maxRuntimeMs: this.#maxRuntimeMs,
          }),
          updateProgress: (progress: ArtifactJobProgressV1) => this.#updateProgress(record, progress),
        }),
      );
      return this.#prepareArtifacts(candidates);
    })();
    try {
      const prepared = await Promise.race([providerPromise, timeoutPromise, abortPromise]);
      if (record.cancelRequested || record.timedOut) return;
      for (const artifact of prepared) {
        const existing = this.#artifacts.get(artifact.ref.sha256);
        if (existing
          && (existing.bytes.byteLength !== artifact.bytes.byteLength
            || sha256Bytes(existing.bytes) !== artifact.ref.sha256)) {
          throw new ArtifactExecutionError("invalid_provider_output", "Content-addressed artifact storage failed integrity verification.");
        }
      }
      for (const artifact of prepared) {
        const existing = this.#artifacts.get(artifact.ref.sha256);
        if (existing) {
          existing.references += 1;
        } else {
          this.#artifacts.set(artifact.ref.sha256, { bytes: artifact.bytes, references: 1 });
        }
      }
      record.artifacts = deepFreeze(prepared.map((artifact) => artifact.ref));
      this.#finish(record, "succeeded");
    } catch (error) {
      const code: InternalErrorCode = record.cancelRequested
        ? "canceled"
        : record.timedOut
          ? "timeout"
          : error instanceof ArtifactExecutionError
            ? error.publicCode
            : "provider_failed";
      this.#finish(record, code === "canceled" ? "canceled" : "failed", publicError(code, error));
    } finally {
      if (timeout) clearTimeout(timeout);
      record.pendingGrantToken = undefined;
      record.controller = undefined;
    }
  }

  #updateProgress(record: JobRecord, progress: ArtifactJobProgressV1): void {
    if (record.status !== "running" || record.controller?.signal.aborted) return;
    if (!Number.isFinite(progress.fraction) || progress.fraction < 0 || progress.fraction > 1) {
      throw new ArtifactExecutionError("invalid_provider_output", "Artifact provider progress is invalid.");
    }
    const message = progress.message === undefined
      ? undefined
      : sanitizePublicMessage(progress.message, "Artifact provider is running.").slice(0, 240);
    record.progress = deepFreeze({ fraction: progress.fraction, ...(message ? { message } : {}) });
  }

  #prepareArtifacts(candidates: readonly ArtifactCandidateV1[]): readonly Readonly<{
    ref: ArtifactJobArtifactV1;
    bytes: Uint8Array;
  }>[] {
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > this.#maxArtifacts) {
      throw new ArtifactExecutionError("invalid_provider_output", "Artifact provider returned an invalid artifact count.");
    }
    const names = new Set<string>();
    let outputBytes = 0;
    const prepared = candidates.map((candidate) => {
      if (!candidate || !SAFE_FILE_NAME.test(candidate.fileName) || names.has(candidate.fileName)) {
        throw new ArtifactExecutionError("invalid_provider_output", "Artifact provider returned an unsafe or duplicate filename.");
      }
      names.add(candidate.fileName);
      if (!MEDIA_TYPE.test(candidate.mediaType)) {
        throw new ArtifactExecutionError("invalid_provider_output", "Artifact provider returned an invalid media type.");
      }
      if (!(candidate.bytes instanceof Uint8Array)) {
        throw new ArtifactExecutionError("invalid_provider_output", "Artifact provider bytes must be a Uint8Array.");
      }
      if (candidate.bytes.byteLength > this.#maxOutputBytes - outputBytes) {
        throw new ArtifactExecutionError("output_limit_exceeded", "Artifact provider exceeded its output byte limit.");
      }
      let metadata: ExtensionJsonValue | undefined;
      let metadataBytes = 0;
      if (candidate.metadata !== undefined) {
        try {
          const safeMetadata = jsonClone(candidate.metadata);
          assertNoAmbientAuthority(safeMetadata);
          metadata = safeMetadata;
        } catch {
          throw new ArtifactExecutionError(
            "invalid_provider_output",
            "Artifact metadata contains a raw credential or local path.",
          );
        }
        try {
          metadataBytes = boundedExtensionJsonByteLength(metadata, {
            maxBytes: Math.max(1, this.#maxOutputBytes - outputBytes - candidate.bytes.byteLength),
          });
        } catch {
          throw new ArtifactExecutionError(
            "output_limit_exceeded",
            "Artifact provider exceeded its output byte limit with metadata.",
          );
        }
      }
      outputBytes += candidate.bytes.byteLength + metadataBytes;
      const bytes = Uint8Array.from(candidate.bytes);
      const sha256 = sha256Bytes(bytes);
      return deepFreeze({
        ref: {
          artifactId: sha256,
          fileName: candidate.fileName,
          mediaType: candidate.mediaType,
          byteLength: bytes.byteLength,
          sha256,
          ...(metadata === undefined ? {} : { metadata }),
        },
        bytes,
      });
    });
    return Object.freeze(prepared);
  }

  #finish(record: JobRecord, status: "succeeded" | "failed" | "canceled", error?: ArtifactJobErrorV1): void {
    record.pendingGrantToken = undefined;
    record.status = status;
    record.progress = status === "succeeded"
      ? deepFreeze({ fraction: 1 })
      : record.progress;
    record.error = error;
    record.completedAtMs = this.#now();
    record.expiresAtMs = record.completedAtMs + this.#ttlMs;
    const snapshot = this.#snapshot(record);
    const waiters = this.#waiters.get(record.jobId);
    if (waiters) {
      this.#waiters.delete(record.jobId);
      for (const waiter of waiters) waiter(snapshot);
    }
  }

  #sweepExpired(): void {
    const now = this.#now();
    for (const record of this.#jobs.values()) {
      if (terminal(record.status) && now >= record.expiresAtMs) this.#deleteRecord(record);
    }
  }

  #deleteRecord(record: JobRecord): void {
    this.#jobs.delete(record.jobId);
    this.#requestIndex.delete(requestKey(record));
    for (const artifact of record.artifacts) {
      const stored = this.#artifacts.get(artifact.sha256);
      if (!stored) continue;
      stored.references -= 1;
      if (stored.references <= 0) this.#artifacts.delete(artifact.sha256);
    }
    this.#waiters.delete(record.jobId);
  }
}
