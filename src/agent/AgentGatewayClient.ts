import {
  normalizeHostFeedUrl,
  parseHostFeedFetchResponse,
  type HostFeedFetchRequest,
  type HostFeedFetchResponse,
} from "../workspace/data/hostFeedContracts";
import {
  PHOTO_RECONSTRUCTION_MEDIA_TYPES,
  type BeginPhotoReconstructionInput,
  type BeginPhotoReconstructionResult,
  type PhotoReconstructionMediaType,
  type PhotoReconstructionPhase,
  type PhotoReconstructionJobView,
  type PhotoReconstructionResultCandidate,
  type PhotoReconstructionWarningCode,
  type PhotoUploadGrant,
} from "../reconstruction/contracts";

export const AGENT_GATEWAY_COMMAND_NAMES = [
  "get_workspace_instructions",
  "inspect_workspace",
  "inspect_workspace_component",
  "read_workspace_resource_snapshot",
  "inspect_workspace_asset",
  "inspect_workspace_model",
  "inspect_workspace_space",
  "query_spatial_placement",
  "inspect_workspace_physics",
  "query_stable_placement",
  "simulate_workspace_physics",
  "begin_workspace_asset_import",
  "cancel_workspace_asset_import",
  "complete_workspace_asset_import",
  "begin_workspace_photo_reconstruction",
  "start_workspace_photo_reconstruction",
  "inspect_workspace_photo_reconstruction",
  "cancel_workspace_photo_reconstruction",
  "finalize_workspace_photo_reconstruction",
  "begin_workspace_update",
  "submit_workspace_batch",
  "undo_workspace_batch",
  "redo_workspace_batch",
  "read_workspace_events",
  // Host-internal attested handoff. It is never exposed as an MCP/REST tool.
  "complete_workspace_reconstruction_asset",
] as const;

export type AgentGatewayCommandName = (typeof AGENT_GATEWAY_COMMAND_NAMES)[number];

export type AgentGatewayCommand = Readonly<{
  id: string;
  name: AgentGatewayCommandName;
  input: unknown;
}>;

export type AgentGatewayOfferStatus =
  | "waiting"
  | "approval_pending"
  | "approval_granted"
  | "approved"
  | "denied"
  | "expired";

export type AgentGatewayPendingApproval = Readonly<{
  claimId: string;
  clientId?: string;
  clientName?: string;
  scopes: readonly string[];
  fingerprint: string;
  requestedAt: string;
  expiresAt: string;
}>;

export type AgentGatewayConfig = Readonly<{
  version: 1;
  gatewayInstanceId: string;
  configRevision: number;
  enabled: boolean;
  connected: boolean;
  engineConnected: boolean;
  clientName?: string;
  clientScopes?: readonly string[];
  instructionVersion: string;
  csrfToken: string;
  connectionUrl?: string;
  offerExpiresAt?: string;
  offerStatus?: AgentGatewayOfferStatus;
  pendingApproval?: AgentGatewayPendingApproval;
}>;

export type AgentGatewayPairing = Readonly<{
  pairingBearer: string;
  mcpConfig: string;
  restConfig: string;
  restEndpoint: string;
  connectionUrl?: string;
  offerExpiresAt?: string;
  offerStatus?: AgentGatewayOfferStatus;
}>;

export type AgentGatewayPairingRotation = AgentGatewayPairing & Readonly<{
  config: AgentGatewayConfig;
}>;

export type AgentAssetCandidateDescriptor = Readonly<{
  version: 1;
  candidateHandle: string;
  requestId: string;
  workspaceId: string;
  displayName: string;
  format: "ply" | "spz" | "sog";
  mediaType: string;
  byteLength: number;
  sha256: string;
  purpose: "generic_import" | "photo_reconstruction";
  status: "ready";
  expiresAt: string;
}>;

export type AgentAssetCandidateStream = Readonly<{
  descriptor: AgentAssetCandidateDescriptor;
  body: ReadableStream<Uint8Array>;
}>;

export type PhotoReconstructionCapability = Readonly<{
  backend: Readonly<{ id: string; version: string }>;
  available: boolean;
  reason?: string;
}>;

export type AgentGatewayStatus =
  | "disabled"
  | "waiting"
  | "connected"
  | "applying"
  | "disconnected";

export type AgentGatewayCommandContext = Readonly<{ signal: AbortSignal }>;

export type AgentGatewayCommandHandler = (
  name: AgentGatewayCommandName,
  input: unknown,
  context: AgentGatewayCommandContext,
) => unknown | Promise<unknown>;

export type AgentGatewayClientOptions = Readonly<{
  handler: AgentGatewayCommandHandler;
  fetch?: typeof globalThis.fetch;
  origin?: string;
  clientInstanceId?: string;
  requestTimeoutMs?: number;
  onStatus?: (status: AgentGatewayStatus) => void;
  onConfig?: (config: AgentGatewayConfig) => void;
  endpoints?: Partial<AgentGatewayEndpoints>;
}>;

export type AgentGatewayEndpoints = Readonly<{
  config: string;
  enable: string;
  disable: string;
  reveal: string;
  rotate: string;
  refreshOffer: string;
  approveClaim: string;
  denyClaim: string;
  register: string;
  takeover: string;
  unregister: string;
  poll: string;
  result: string;
  feedApprovalMint: string;
  feedFetch: string;
  assetCandidateInspect: string;
  assetCandidateOpen: string;
  assetCandidateComplete: string;
  assetCandidateCancel: string;
  photoReconstructionCapability: string;
  photoReconstructionBegin: string;
  photoReconstructionStart: string;
  photoReconstructionInspect: string;
  photoReconstructionCancel: string;
  photoReconstructionFinalize: string;
  photoReconstructionUploadPrefix: string;
}>;

export class AgentGatewayError extends Error {
  readonly code: "invalid_configuration" | "request_failed" | "invalid_response";
  readonly status?: number;
  readonly gatewayCode?: string;

  constructor(
    code: AgentGatewayError["code"],
    message: string,
    options: { status?: number; gatewayCode?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentGatewayError";
    this.code = code;
    this.status = options.status;
    this.gatewayCode = options.gatewayCode;
  }
}

/** A safe, public error that may be returned to the local gateway. */
export class AgentGatewayCommandError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AgentGatewayCommandError";
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_ENDPOINTS: AgentGatewayEndpoints = {
  config: "/api/agent/config",
  enable: "/api/agent/browser/enable",
  disable: "/api/agent/browser/disable",
  reveal: "/api/agent/browser/reveal",
  rotate: "/api/agent/browser/rotate",
  refreshOffer: "/api/agent/browser/offer/refresh",
  approveClaim: "/api/agent/browser/approval/approve",
  denyClaim: "/api/agent/browser/approval/deny",
  register: "/api/agent/browser/register",
  takeover: "/api/agent/browser/takeover",
  unregister: "/api/agent/browser/unregister",
  poll: "/api/agent/browser/poll",
  result: "/api/agent/browser/result",
  feedApprovalMint: "/api/agent/feeds/approval/mint",
  feedFetch: "/api/agent/feeds/fetch",
  assetCandidateInspect: "/api/agent/assets/candidates/inspect",
  assetCandidateOpen: "/api/agent/assets/candidates/open",
  assetCandidateComplete: "/api/agent/assets/candidates/complete",
  assetCandidateCancel: "/api/agent/assets/candidates/cancel",
  photoReconstructionCapability: "/api/agent/reconstructions/capability",
  photoReconstructionBegin: "/api/agent/reconstructions/begin",
  photoReconstructionStart: "/api/agent/reconstructions/start",
  photoReconstructionInspect: "/api/agent/reconstructions/inspect",
  photoReconstructionCancel: "/api/agent/reconstructions/cancel",
  photoReconstructionFinalize: "/api/agent/reconstructions/finalize",
  photoReconstructionUploadPrefix: "/api/agent/reconstructions/photo-uploads",
};

const CLIENT_INSTANCE_ID_PATTERN = /^[A-Za-z0-9._~-]{8,128}$/;
const CSRF_HEADER = "X-SemaFrame-Agent-CSRF";
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFeedApprovalToken(value: unknown, expected: HostFeedFetchRequest): string {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !["version", "approvalToken", "expiresAt", "request"].includes(key)) ||
    value.version !== 1 ||
    typeof value.approvalToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.approvalToken) ||
    typeof value.expiresAt !== "string" ||
    !isRecord(value.request) ||
    Object.keys(value.request).some((key) => !["url", "format"].includes(key)) ||
    typeof value.request.url !== "string" ||
    !["auto", "json", "csv", "rss"].includes(String(value.request.format))) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid feed approval.");
  }
  const expiresAt = new Date(value.expiresAt);
  if (Number.isNaN(expiresAt.valueOf()) || expiresAt.toISOString() !== value.expiresAt) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid feed approval expiry.");
  }
  const expectedUrl = normalizeHostFeedUrl(expected.url);
  const expectedFormat = expected.format ?? "auto";
  if (normalizeHostFeedUrl(value.request.url) !== expectedUrl || value.request.format !== expectedFormat) {
    throw new AgentGatewayError("invalid_response", "The feed approval does not match the requested URL and format.");
  }
  return value.approvalToken;
}

const ASSET_CANDIDATE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ASSET_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

function assetCandidateRequest(candidateHandle: string, workspaceId: string): {
  candidateHandle: string;
  workspaceId: string;
} {
  if (!ASSET_CANDIDATE_HANDLE_PATTERN.test(candidateHandle) || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new AgentGatewayError("invalid_configuration", "The asset candidate reference is invalid.");
  }
  return { candidateHandle, workspaceId };
}

function parseAssetCandidate(value: unknown): AgentAssetCandidateDescriptor {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "version", "candidateHandle", "requestId", "workspaceId", "displayName", "format",
    "mediaType", "byteLength", "sha256", "purpose", "status", "expiresAt",
  ].includes(key)) || value.version !== 1 ||
      typeof value.candidateHandle !== "string" || !ASSET_CANDIDATE_HANDLE_PATTERN.test(value.candidateHandle) ||
      typeof value.requestId !== "string" || value.requestId.length < 8 || value.requestId.length > 128 ||
      typeof value.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(value.workspaceId) ||
      typeof value.displayName !== "string" || value.displayName.length < 1 || value.displayName.length > 255 ||
      !["ply", "spz", "sog"].includes(String(value.format)) ||
      typeof value.mediaType !== "string" || value.mediaType.length < 3 || value.mediaType.length > 192 ||
      !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 ||
      typeof value.sha256 !== "string" || !ASSET_DIGEST_PATTERN.test(value.sha256) ||
      !["generic_import", "photo_reconstruction"].includes(String(value.purpose)) ||
      value.status !== "ready" || typeof value.expiresAt !== "string") {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid asset candidate.");
  }
  const expiresAt = new Date(value.expiresAt);
  if (Number.isNaN(expiresAt.valueOf()) || expiresAt.toISOString() !== value.expiresAt) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid asset candidate expiry.");
  }
  return Object.freeze({
    version: 1,
    candidateHandle: value.candidateHandle,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    displayName: value.displayName,
    format: value.format as "ply" | "spz" | "sog",
    mediaType: value.mediaType,
    byteLength: Number(value.byteLength),
    sha256: value.sha256,
    purpose: value.purpose as "generic_import" | "photo_reconstruction",
    status: "ready",
    expiresAt: value.expiresAt,
  });
}

const PHOTO_RECONSTRUCTION_JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHOTO_RECONSTRUCTION_PHASES = new Set<PhotoReconstructionPhase>([
  "awaiting_upload", "queued", "camera_solving", "training", "packing", "ready", "failed", "cancelled",
]);
const PHOTO_RECONSTRUCTION_WARNINGS = new Set<PhotoReconstructionWarningCode>([
  "low_photo_count",
  "duplicate_content_removed",
  "partial_camera_registration",
  "source_scale_unknown",
  "source_coordinates_unknown",
]);

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function parsePhotoReconstructionCandidate(value: unknown): PhotoReconstructionResultCandidate {
  if (!isRecord(value) || !exactKeys(value, ["candidateHandle", "format", "mediaType", "byteLength", "sha256"]) ||
      typeof value.candidateHandle !== "string" || !ASSET_CANDIDATE_HANDLE_PATTERN.test(value.candidateHandle) ||
      !["ply", "spz", "sog"].includes(String(value.format)) ||
      typeof value.mediaType !== "string" || value.mediaType.length < 3 || value.mediaType.length > 192 ||
      !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 ||
      typeof value.sha256 !== "string" || !ASSET_DIGEST_PATTERN.test(value.sha256)) {
    throw new AgentGatewayError("invalid_response", "The reconstruction gateway returned an invalid output candidate.");
  }
  return Object.freeze({
    candidateHandle: value.candidateHandle,
    format: value.format as "ply" | "spz" | "sog",
    mediaType: value.mediaType,
    byteLength: Number(value.byteLength),
    sha256: value.sha256 as `sha256:${string}`,
  });
}

function parsePhotoReconstructionJob(value: unknown): PhotoReconstructionJobView {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "jobId", "requestId", "workspaceId", "photoSetDigest", "profile", "status", "progress",
    "inputPhotoCount", "uploadedPhotoCount", "registeredPhotoCount", "backend", "warnings", "createdAt",
    "updatedAt", "expiresAt", "result", "error",
  ]) || value.version !== 1 ||
      typeof value.jobId !== "string" || !PHOTO_RECONSTRUCTION_JOB_ID_PATTERN.test(value.jobId) ||
      typeof value.requestId !== "string" || value.requestId.length < 8 || value.requestId.length > 128 ||
      typeof value.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(value.workspaceId) ||
      typeof value.photoSetDigest !== "string" || !ASSET_DIGEST_PATTERN.test(value.photoSetDigest) ||
      !["preview", "balanced", "quality"].includes(String(value.profile)) ||
      typeof value.status !== "string" || !PHOTO_RECONSTRUCTION_PHASES.has(value.status as PhotoReconstructionPhase) ||
      typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1 ||
      !Number.isSafeInteger(value.inputPhotoCount) || Number(value.inputPhotoCount) < 2 || Number(value.inputPhotoCount) > 400 ||
      !Number.isSafeInteger(value.uploadedPhotoCount) || Number(value.uploadedPhotoCount) < 0 ||
      Number(value.uploadedPhotoCount) > Number(value.inputPhotoCount) ||
      (value.registeredPhotoCount !== undefined && (!Number.isSafeInteger(value.registeredPhotoCount) ||
        Number(value.registeredPhotoCount) < 0 || Number(value.registeredPhotoCount) > Number(value.inputPhotoCount))) ||
      !isRecord(value.backend) || !exactKeys(value.backend, ["id", "version"]) ||
      typeof value.backend.id !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(value.backend.id) ||
      typeof value.backend.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value.backend.version) ||
      !Array.isArray(value.warnings) || value.warnings.length > 32 ||
      !value.warnings.every((warning) => typeof warning === "string" &&
        PHOTO_RECONSTRUCTION_WARNINGS.has(warning as PhotoReconstructionWarningCode)) ||
      !isCanonicalIsoDate(value.createdAt) || !isCanonicalIsoDate(value.updatedAt) || !isCanonicalIsoDate(value.expiresAt)) {
    throw new AgentGatewayError("invalid_response", "The reconstruction gateway returned an invalid job.");
  }
  const result = value.result === undefined ? undefined : parsePhotoReconstructionCandidate(value.result);
  let failure: PhotoReconstructionJobView["error"];
  if (value.error !== undefined) {
    if (!isRecord(value.error) || !exactKeys(value.error, ["code", "message", "retryable"]) ||
        typeof value.error.code !== "string" || value.error.code.length < 1 || value.error.code.length > 128 ||
        typeof value.error.message !== "string" || value.error.message.length < 1 || value.error.message.length > 2_000 ||
        typeof value.error.retryable !== "boolean") {
      throw new AgentGatewayError("invalid_response", "The reconstruction gateway returned an invalid job failure.");
    }
    failure = Object.freeze({
      code: value.error.code,
      message: value.error.message,
      retryable: value.error.retryable,
    });
  }
  if ((value.status === "ready") !== Boolean(result) || (value.status === "failed") !== Boolean(failure)) {
    throw new AgentGatewayError("invalid_response", "The reconstruction job terminal state is inconsistent.");
  }
  return Object.freeze({
    version: 1,
    jobId: value.jobId,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    photoSetDigest: value.photoSetDigest as `sha256:${string}`,
    profile: value.profile as PhotoReconstructionJobView["profile"],
    status: value.status as PhotoReconstructionPhase,
    progress: value.progress,
    inputPhotoCount: Number(value.inputPhotoCount),
    uploadedPhotoCount: Number(value.uploadedPhotoCount),
    ...(value.registeredPhotoCount === undefined ? {} : { registeredPhotoCount: Number(value.registeredPhotoCount) }),
    backend: Object.freeze({ id: value.backend.id, version: value.backend.version }),
    warnings: Object.freeze([...(value.warnings as PhotoReconstructionWarningCode[])]),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    ...(result ? { result } : {}),
    ...(failure ? { error: failure } : {}),
  });
}

function parsePhotoUploadGrant(value: unknown): PhotoUploadGrant {
  if (!isRecord(value) || !exactKeys(value, [
    "photoId", "method", "url", "authorization", "token", "contentType", "contentLength", "expiresAt",
  ]) || typeof value.photoId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u.test(value.photoId) ||
      value.method !== "PUT" || value.authorization !== "Bearer" ||
      typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.token) ||
      typeof value.contentType !== "string" ||
      !(PHOTO_RECONSTRUCTION_MEDIA_TYPES as readonly string[]).includes(value.contentType) ||
      !Number.isSafeInteger(value.contentLength) || Number(value.contentLength) < 1 ||
      typeof value.url !== "string" || !isCanonicalIsoDate(value.expiresAt)) {
    throw new AgentGatewayError("invalid_response", "The reconstruction gateway returned an invalid photo upload grant.");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch (cause) {
    throw new AgentGatewayError("invalid_response", "The photo upload grant URL is invalid.", { cause });
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      !/^\/v1\/reconstructions\/photo-uploads\/[0-9a-f-]{36}$/iu.test(url.pathname)) {
    throw new AgentGatewayError("invalid_response", "The photo upload grant URL is outside the reconstruction route.");
  }
  return Object.freeze({
    photoId: value.photoId,
    method: "PUT",
    url: value.url,
    authorization: "Bearer",
    token: value.token,
    contentType: value.contentType as PhotoReconstructionMediaType,
    contentLength: Number(value.contentLength),
    expiresAt: value.expiresAt,
  });
}

function parseBeginPhotoReconstructionResult(value: unknown): BeginPhotoReconstructionResult {
  if (!isRecord(value) || !exactKeys(value, ["job", "uploads"]) || !Array.isArray(value.uploads)) {
    throw new AgentGatewayError("invalid_response", "The reconstruction gateway returned an invalid begin response.");
  }
  const job = parsePhotoReconstructionJob(value.job);
  const uploads = value.uploads.map(parsePhotoUploadGrant);
  if (new Set(uploads.map((upload) => upload.photoId)).size !== uploads.length ||
      uploads.some((upload) => upload.contentLength < 1) || uploads.length > job.inputPhotoCount) {
    throw new AgentGatewayError("invalid_response", "The reconstruction upload grants are inconsistent with the job.");
  }
  return Object.freeze({ job, uploads: Object.freeze(uploads) });
}

function parsePhotoReconstructionCapability(value: unknown): PhotoReconstructionCapability {
  if (!isRecord(value) || !exactKeys(value, ["backend", "available", "reason"]) ||
      !isRecord(value.backend) || !exactKeys(value.backend, ["id", "version"]) ||
      typeof value.backend.id !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(value.backend.id) ||
      typeof value.backend.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value.backend.version) ||
      typeof value.available !== "boolean" ||
      (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 500))) {
    throw new AgentGatewayError("invalid_response", "The reconstruction gateway returned an invalid capability response.");
  }
  return Object.freeze({
    backend: Object.freeze({ id: value.backend.id, version: value.backend.version }),
    available: value.available,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  });
}

function isCommandName(value: unknown): value is AgentGatewayCommandName {
  return typeof value === "string" &&
    (AGENT_GATEWAY_COMMAND_NAMES as readonly string[]).includes(value);
}

function isMutatingCommand(value: AgentGatewayCommandName): boolean {
  return value === "submit_workspace_batch" ||
    value === "undo_workspace_batch" ||
    value === "redo_workspace_batch" ||
    value === "complete_workspace_reconstruction_asset";
}

function isOfferStatus(value: unknown): value is AgentGatewayOfferStatus {
  return typeof value === "string" && [
    "waiting",
    "approval_pending",
    "approval_granted",
    "approved",
    "denied",
    "expired",
  ].includes(value);
}

function parsePendingApproval(value: unknown): AgentGatewayPendingApproval | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.claimId !== "string" || !value.claimId ||
      (value.clientId !== undefined && typeof value.clientId !== "string") ||
      (value.clientName !== undefined && typeof value.clientName !== "string") ||
      !Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string" && scope) ||
      typeof value.fingerprint !== "string" || !value.fingerprint ||
      typeof value.requestedAt !== "string" || !value.requestedAt ||
      typeof value.expiresAt !== "string" || !value.expiresAt) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid approval request.");
  }
  return {
    claimId: value.claimId,
    ...(value.clientId === undefined ? {} : { clientId: value.clientId }),
    ...(value.clientName === undefined ? {} : { clientName: value.clientName }),
    scopes: value.scopes,
    fingerprint: value.fingerprint,
    requestedAt: value.requestedAt,
    expiresAt: value.expiresAt,
  };
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (isRecord(error) && error.name === "AbortError");
}

function createClientInstanceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function validateClientInstanceId(value: string): string {
  if (!CLIENT_INSTANCE_ID_PATTERN.test(value)) {
    throw new AgentGatewayError(
      "invalid_configuration",
      "The browser client instance identifier is invalid.",
    );
  }
  return value;
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AgentGatewayError(
      "invalid_configuration",
      "The agent gateway origin is invalid.",
      { cause },
    );
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new AgentGatewayError(
      "invalid_configuration",
      "The agent gateway origin must be an HTTP origin without credentials, a path, or a query.",
    );
  }
  return url.origin;
}

function normalizeEndpoint(origin: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value, `${origin}/`);
  } catch (cause) {
    throw new AgentGatewayError(
      "invalid_configuration",
      "An agent gateway endpoint is invalid.",
      { cause },
    );
  }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) {
    throw new AgentGatewayError(
      "invalid_configuration",
      "Agent gateway endpoints must be same-origin paths without credentials, queries, or fragments.",
    );
  }
  return url.pathname;
}

function parseConfig(value: unknown): AgentGatewayConfig {
  if (!isRecord(value) || value.version !== 1 || typeof value.gatewayInstanceId !== "string" ||
      !/^[A-Za-z0-9._~-]{8,128}$/u.test(value.gatewayInstanceId) ||
      typeof value.configRevision !== "number" ||
      !Number.isSafeInteger(value.configRevision) || value.configRevision < 1 || typeof value.enabled !== "boolean" ||
      typeof value.connected !== "boolean" || typeof value.engineConnected !== "boolean" ||
      typeof value.instructionVersion !== "string" ||
      !value.instructionVersion || typeof value.csrfToken !== "string" || !value.csrfToken ||
      (value.clientName !== undefined && typeof value.clientName !== "string") ||
      (value.clientScopes !== undefined && (!Array.isArray(value.clientScopes) ||
        !value.clientScopes.every((scope) => typeof scope === "string" && scope))) ||
      (value.connectionUrl !== undefined && (typeof value.connectionUrl !== "string" || !value.connectionUrl)) ||
      (value.offerExpiresAt !== undefined && (typeof value.offerExpiresAt !== "string" || !value.offerExpiresAt)) ||
      (value.offerStatus !== undefined && !isOfferStatus(value.offerStatus))) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid configuration response.");
  }
  const pendingApproval = parsePendingApproval(value.pendingApproval);
  return {
    version: 1,
    gatewayInstanceId: value.gatewayInstanceId,
    configRevision: value.configRevision,
    enabled: value.enabled,
    connected: value.connected,
    engineConnected: value.engineConnected,
    ...(value.clientName === undefined ? {} : { clientName: value.clientName }),
    ...(value.clientScopes === undefined ? {} : { clientScopes: value.clientScopes as string[] }),
    instructionVersion: value.instructionVersion,
    csrfToken: value.csrfToken,
    ...(value.connectionUrl === undefined ? {} : { connectionUrl: value.connectionUrl }),
    ...(value.offerExpiresAt === undefined ? {} : { offerExpiresAt: value.offerExpiresAt }),
    ...(value.offerStatus === undefined ? {} : { offerStatus: value.offerStatus }),
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  };
}

function parsePairing(value: unknown): AgentGatewayPairing {
  if (!isRecord(value) || typeof value.pairingBearer !== "string" || !value.pairingBearer ||
      typeof value.mcpConfig !== "string" || !value.mcpConfig ||
      typeof value.restConfig !== "string" || !value.restConfig ||
      typeof value.restEndpoint !== "string" || !value.restEndpoint ||
      (value.connectionUrl !== undefined && (typeof value.connectionUrl !== "string" || !value.connectionUrl)) ||
      (value.offerExpiresAt !== undefined && (typeof value.offerExpiresAt !== "string" || !value.offerExpiresAt)) ||
      (value.offerStatus !== undefined && !isOfferStatus(value.offerStatus))) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid pairing response.");
  }
  return {
    pairingBearer: value.pairingBearer,
    mcpConfig: value.mcpConfig,
    restConfig: value.restConfig,
    restEndpoint: value.restEndpoint,
    ...(value.connectionUrl === undefined ? {} : { connectionUrl: value.connectionUrl }),
    ...(value.offerExpiresAt === undefined ? {} : { offerExpiresAt: value.offerExpiresAt }),
    ...(value.offerStatus === undefined ? {} : { offerStatus: value.offerStatus }),
  };
}

function parseRegistration(value: unknown): string {
  if (!isRecord(value) || typeof value.browserConnectionId !== "string" || !value.browserConnectionId) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid registration response.");
  }
  return value.browserConnectionId;
}

function parsePoll(value: unknown): { kind: "idle" } | { kind: "command"; command: AgentGatewayCommand } {
  if (!isRecord(value)) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid polling response.");
  }
  if (value.kind === "idle") return { kind: "idle" };
  const command = value.command;
  if (value.kind !== "command" || !isRecord(command) || typeof command.id !== "string" ||
      !command.id || !isCommandName(command.name) || !("input" in command)) {
    throw new AgentGatewayError("invalid_response", "The agent gateway returned an invalid command envelope.");
  }
  return {
    kind: "command",
    command: { id: command.id, name: command.name, input: command.input },
  };
}

export class AgentGatewayClient {
  readonly clientInstanceId: string;

  private readonly request: typeof globalThis.fetch;
  private readonly handler: AgentGatewayCommandHandler;
  private readonly onStatus?: (status: AgentGatewayStatus) => void;
  private readonly onConfig?: (config: AgentGatewayConfig) => void;
  private readonly endpoints: AgentGatewayEndpoints;
  private readonly requestTimeoutMs: number;
  private statusValue: AgentGatewayStatus = "disabled";
  private configValue?: AgentGatewayConfig;
  private configRequestSequence = 0;
  private appliedConfigRequestSequence = 0;
  private configOperationTail: Promise<void> = Promise.resolve();
  private readonly retiredGatewayInstanceIds = new Set<string>();
  private csrfToken?: string;
  private browserConnectionId?: string;
  private claimPromise?: Promise<AgentGatewayConfig>;
  private claimEndpoint?: string;
  private runController?: AbortController;
  private runPromise?: Promise<void>;
  private requestedStopStatus: AgentGatewayStatus = "disconnected";

  constructor(options: AgentGatewayClientOptions) {
    if (typeof options.handler !== "function") {
      throw new AgentGatewayError("invalid_configuration", "An agent command handler is required.");
    }
    const currentOrigin = options.origin ?? globalThis.location?.origin;
    if (!currentOrigin) {
      throw new AgentGatewayError("invalid_configuration", "A browser origin is required for the agent gateway.");
    }
    const origin = normalizeOrigin(currentOrigin);
    const configuredEndpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
    this.endpoints = Object.fromEntries(
      Object.entries(configuredEndpoints).map(([key, value]) => [key, normalizeEndpoint(origin, value)]),
    ) as unknown as AgentGatewayEndpoints;
    const request = options.fetch ?? globalThis.fetch;
    if (typeof request !== "function") {
      throw new AgentGatewayError("invalid_configuration", "The Fetch API is unavailable.");
    }
    // Browser fetch is a Web IDL method and may reject a foreign receiver. Keep
    // an injected test fetch untouched, but bind the native implementation to
    // its owning global before storing it on this client instance.
    this.request = options.fetch ? request : request.bind(globalThis);
    this.handler = options.handler;
    this.onStatus = options.onStatus;
    this.onConfig = options.onConfig;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 60_000) {
      throw new AgentGatewayError("invalid_configuration", "The agent gateway request timeout must be 1-60000 milliseconds.");
    }
    this.clientInstanceId = validateClientInstanceId(options.clientInstanceId ?? createClientInstanceId());
  }

  get status(): AgentGatewayStatus {
    return this.statusValue;
  }

  get config(): AgentGatewayConfig | undefined {
    return this.configValue;
  }

  get running(): boolean {
    return this.runPromise !== undefined;
  }

  fetchConfig(signal?: AbortSignal): Promise<AgentGatewayConfig> {
    return this.enqueueConfigOperation(async (requestSequence) => {
      const value = await this.fetchJson(this.endpoints.config, {
        method: "GET",
        signal,
      });
      return this.adoptConfig(parseConfig(value), requestSequence);
    });
  }

  async enable(signal?: AbortSignal): Promise<AgentGatewayConfig> {
    const config = await this.ensureConfig(signal);
    if (!config.enabled) {
      await this.postJson(this.endpoints.enable, {}, signal);
    }
    return this.fetchConfig(signal);
  }

  async disable(signal?: AbortSignal): Promise<void> {
    const config = await this.ensureConfig(signal);
    if (config.enabled) {
      await this.postJson(this.endpoints.disable, {}, signal);
    }
    this.stop("disabled");
  }

  async revealPairing(signal?: AbortSignal): Promise<AgentGatewayPairing> {
    const config = await this.ensureConfig(signal);
    if (!config.enabled) {
      throw new AgentGatewayError("request_failed", "External agent control must be enabled before copying setup.");
    }
    return parsePairing(await this.postJson(this.endpoints.reveal, {}, signal));
  }

  async rotatePairing(signal?: AbortSignal): Promise<AgentGatewayPairingRotation> {
    const config = await this.ensureConfig(signal);
    if (!config.enabled) {
      throw new AgentGatewayError("request_failed", "External agent control must be enabled before rotating pairing access.");
    }
    return this.enqueueConfigOperation(async (requestSequence) => {
      const value = await this.postConfigMutationWithRestartRecovery(
        this.endpoints.rotate,
        {},
        requestSequence,
        signal,
      );
      const pairing = parsePairing(value);
      const rotatedConfig = this.adoptConfig(parseConfig(value), requestSequence);
      return Object.freeze({ ...pairing, config: rotatedConfig });
    });
  }

  async refreshOffer(signal?: AbortSignal): Promise<AgentGatewayConfig> {
    const config = await this.ensureConfig(signal);
    if (!config.enabled) {
      throw new AgentGatewayError("request_failed", "External agent control must be enabled before refreshing its connection link.");
    }
    // Refresh returns the complete post-mutation snapshot. Applying that one
    // response atomically prevents a failed follow-up read from preserving
    // stale connection identity or session state alongside the new URL.
    return this.enqueueConfigOperation(async (requestSequence) => {
      const refreshedConfig = parseConfig(await this.postConfigMutationWithRestartRecovery(
        this.endpoints.refreshOffer,
        {},
        requestSequence,
        signal,
      ));
      return this.adoptConfig(refreshedConfig, requestSequence);
    });
  }

  async approveClaim(claimId: string, signal?: AbortSignal): Promise<AgentGatewayConfig> {
    if (!claimId) throw new AgentGatewayError("invalid_configuration", "An approval request identifier is required.");
    await this.ensureConfig(signal);
    await this.postJson(this.endpoints.approveClaim, { claimId }, signal);
    return this.fetchConfig(signal);
  }

  async denyClaim(claimId: string, signal?: AbortSignal): Promise<AgentGatewayConfig> {
    if (!claimId) throw new AgentGatewayError("invalid_configuration", "An approval request identifier is required.");
    await this.ensureConfig(signal);
    await this.postJson(this.endpoints.denyClaim, { claimId }, signal);
    return this.fetchConfig(signal);
  }

  /**
   * Ask the loopback host to retrieve one explicitly user-approved public feed.
   * The browser never contacts the remote origin and never supplies headers,
   * cookies, request bodies, or credentials.
   */
  async fetchHostFeed(request: HostFeedFetchRequest, signal?: AbortSignal): Promise<HostFeedFetchResponse> {
    const body: HostFeedFetchRequest = {
      url: normalizeHostFeedUrl(request.url),
      ...(request.format ? { format: request.format } : {}),
    };
    const approvedFetch = async (): Promise<HostFeedFetchResponse> => {
      const approvalToken = parseFeedApprovalToken(
        await this.postJson(this.endpoints.feedApprovalMint, body, signal),
        body,
      );
      return parseHostFeedFetchResponse(await this.postJson(this.endpoints.feedFetch, {
        ...body,
        approvalToken,
      }, signal));
    };
    await this.ensureConfig(signal);
    try {
      return await approvedFetch();
    } catch (error) {
      if (!(error instanceof AgentGatewayError) || error.gatewayCode !== "csrf_invalid") throw error;
    }
    // A restarted gateway invalidates both CSRF state and every server-held
    // feed approval. Refresh config, mint a new bound one-use capability, and
    // retry once without enabling external agent control.
    await this.fetchConfig(signal);
    return approvedFetch();
  }

  /**
   * Reads the bounded, host-authored descriptor for a candidate uploaded by an
   * approved Agent. No local path, upload bearer, or raw asset bytes cross this
   * metadata boundary.
   */
  async inspectAssetCandidate(
    candidateHandle: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<AgentAssetCandidateDescriptor> {
    const body = assetCandidateRequest(candidateHandle, workspaceId);
    await this.ensureConfig(signal);
    const descriptor = parseAssetCandidate(
      await this.postJson(this.endpoints.assetCandidateInspect, body, signal),
    );
    if (descriptor.candidateHandle !== candidateHandle || descriptor.workspaceId !== workspaceId) {
      throw new AgentGatewayError("invalid_response", "The returned asset candidate does not match the request.");
    }
    return descriptor;
  }

  /**
   * Opens a streaming, same-origin handoff into the browser-owned AssetVault.
   * Call completeAssetCandidate only after the durable browser write and its
   * own digest validation succeed; cancellation leaves no registered asset.
   */
  async openAssetCandidate(
    candidateHandle: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<AgentAssetCandidateStream> {
    const requestBody = assetCandidateRequest(candidateHandle, workspaceId);
    const descriptor = await this.inspectAssetCandidate(candidateHandle, workspaceId, signal);
    if (!this.csrfToken) {
      throw new AgentGatewayError("invalid_configuration", "The agent gateway CSRF token is unavailable.");
    }
    const response = await this.fetchResponse(this.endpoints.assetCandidateOpen, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CSRF_HEADER]: this.csrfToken,
      },
      body: JSON.stringify(requestBody),
      signal,
    });
    const byteLength = Number(response.headers.get("content-length"));
    if (
      !response.body ||
      response.headers.get("content-type") !== descriptor.mediaType ||
      response.headers.get("x-semaframe-asset-media-type") !== descriptor.mediaType ||
      response.headers.get("x-semaframe-asset-digest") !== descriptor.sha256 ||
      byteLength !== descriptor.byteLength
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new AgentGatewayError("invalid_response", "The asset stream headers do not match its inspected descriptor.");
    }
    return Object.freeze({ descriptor, body: response.body });
  }

  async completeAssetCandidate(
    candidateHandle: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureConfig(signal);
    const value = await this.postJson(
      this.endpoints.assetCandidateComplete,
      assetCandidateRequest(candidateHandle, workspaceId),
      signal,
    );
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "completed") || value.completed !== true) {
      throw new AgentGatewayError("invalid_response", "The agent gateway did not confirm asset completion.");
    }
  }

  async cancelAssetCandidate(
    candidateHandle: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureConfig(signal);
    const value = await this.postJson(
      this.endpoints.assetCandidateCancel,
      assetCandidateRequest(candidateHandle, workspaceId),
      signal,
    );
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "cancelled") || value.cancelled !== true) {
      throw new AgentGatewayError("invalid_response", "The agent gateway did not confirm asset cancellation.");
    }
  }

  /** Detects the host-owned reconstruction backend through the browser-bound control channel. */
  async getPhotoReconstructionCapability(signal?: AbortSignal): Promise<PhotoReconstructionCapability> {
    await this.ensureConfig(signal);
    return parsePhotoReconstructionCapability(await this.postJson(
      this.endpoints.photoReconstructionCapability,
      {},
      signal,
    ));
  }

  async beginPhotoReconstruction(
    input: BeginPhotoReconstructionInput,
    signal?: AbortSignal,
  ): Promise<BeginPhotoReconstructionResult> {
    await this.ensureConfig(signal);
    const result = parseBeginPhotoReconstructionResult(await this.postJson(
      this.endpoints.photoReconstructionBegin,
      input,
      signal,
    ));
    if (result.job.requestId !== input.requestId || result.job.workspaceId !== input.workspaceId ||
        result.job.profile !== input.profile || result.job.inputPhotoCount !== input.photos.length) {
      throw new AgentGatewayError("invalid_response", "The reconstruction job does not match its declared photo set.");
    }
    return result;
  }

  /**
   * Streams one exact photo through its one-use grant. The signed public URL is
   * used only as a capability description; bytes travel through a same-origin
   * local alias so no upload bearer is exposed to cross-origin redirects.
   */
  async uploadPhotoReconstructionGrant(
    grant: PhotoUploadGrant,
    photo: Blob,
    signal?: AbortSignal,
  ): Promise<PhotoReconstructionJobView> {
    const parsedGrant = parsePhotoUploadGrant(grant);
    if (photo.size !== parsedGrant.contentLength) {
      throw new AgentGatewayError("invalid_configuration", "The selected photo no longer matches its upload grant.");
    }
    const grantPath = new URL(parsedGrant.url).pathname;
    const grantId = grantPath.slice(grantPath.lastIndexOf("/") + 1);
    const endpoint = `${this.endpoints.photoReconstructionUploadPrefix}/${grantId}`;
    const response = await this.fetchResponse(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${parsedGrant.token}`,
        "Content-Type": parsedGrant.contentType,
      },
      body: photo,
      signal,
    }, 10 * 60_000);
    let value: unknown;
    try {
      value = await response.json() as unknown;
    } catch (cause) {
      throw new AgentGatewayError("invalid_response", "The photo upload returned invalid JSON.", { cause });
    }
    return parsePhotoReconstructionJob(value);
  }

  async startPhotoReconstruction(
    jobId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<PhotoReconstructionJobView> {
    await this.ensureConfig(signal);
    const job = parsePhotoReconstructionJob(await this.postJson(
      this.endpoints.photoReconstructionStart,
      { jobId, workspaceId },
      signal,
    ));
    if (job.jobId !== jobId || job.workspaceId !== workspaceId) {
      throw new AgentGatewayError("invalid_response", "The started reconstruction job does not match the request.");
    }
    return job;
  }

  async inspectPhotoReconstruction(
    jobId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<PhotoReconstructionJobView> {
    await this.ensureConfig(signal);
    const job = parsePhotoReconstructionJob(await this.postJson(
      this.endpoints.photoReconstructionInspect,
      { jobId, workspaceId },
      signal,
    ));
    if (job.jobId !== jobId || job.workspaceId !== workspaceId) {
      throw new AgentGatewayError("invalid_response", "The inspected reconstruction job does not match the request.");
    }
    return job;
  }

  async cancelPhotoReconstruction(
    jobId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<PhotoReconstructionJobView> {
    await this.ensureConfig(signal);
    const value = await this.postJson(
      this.endpoints.photoReconstructionCancel,
      { jobId, workspaceId, confirm: true },
      signal,
    );
    if (!isRecord(value) || !exactKeys(value, ["cancelled", "job"]) || value.cancelled !== true) {
      throw new AgentGatewayError("invalid_response", "The reconstruction gateway did not confirm cancellation.");
    }
    const job = parsePhotoReconstructionJob(value.job);
    if (job.jobId !== jobId || job.workspaceId !== workspaceId || job.status !== "cancelled") {
      throw new AgentGatewayError("invalid_response", "The cancelled reconstruction job does not match the request.");
    }
    return job;
  }

  async finalizePhotoReconstruction(
    jobId: string,
    workspaceId: string,
    displayName: string,
    expectedOutputSha256: string,
    signal?: AbortSignal,
  ): Promise<PhotoReconstructionResultCandidate> {
    await this.ensureConfig(signal);
    const candidate = parsePhotoReconstructionCandidate(await this.postJson(
      this.endpoints.photoReconstructionFinalize,
      { jobId, workspaceId, displayName, expectedOutputSha256 },
      signal,
    ));
    if (candidate.sha256 !== expectedOutputSha256) {
      throw new AgentGatewayError("invalid_response", "The finalized reconstruction digest changed unexpectedly.");
    }
    return candidate;
  }

  /**
   * Claims the browser engine only when no other active tab owns it. This finite
   * operation lets UI retry safely before starting the long-running poll loop.
   */
  async claimBrowser(signal?: AbortSignal): Promise<AgentGatewayConfig> {
    return this.claimBrowserAt(this.endpoints.register, signal);
  }

  /**
   * Explicitly moves the browser-authoritative engine lease to this tab.
   * The caller must invoke start() after this resolves; run() will consume the
   * pre-registered connection instead of performing a conflicting register.
   */
  async takeover(signal?: AbortSignal): Promise<AgentGatewayConfig> {
    return this.claimBrowserAt(this.endpoints.takeover, signal);
  }

  private claimBrowserAt(endpoint: string, signal?: AbortSignal): Promise<AgentGatewayConfig> {
    if (this.runPromise) {
      return Promise.reject(new AgentGatewayError(
        "invalid_configuration",
        "Stop the current agent bridge before claiming browser control.",
      ));
    }
    if (endpoint === this.endpoints.register && this.browserConnectionId) {
      return this.fetchConfig(signal);
    }
    if (this.claimPromise) {
      if (this.claimEndpoint === endpoint) return this.claimPromise;
      return Promise.reject(new AgentGatewayError(
        "invalid_configuration",
        "A browser control claim is already in progress.",
      ));
    }
    const pending = this.performBrowserClaim(endpoint, signal);
    this.claimPromise = pending;
    this.claimEndpoint = endpoint;
    return pending.finally(() => {
      if (this.claimPromise === pending) {
        this.claimPromise = undefined;
        this.claimEndpoint = undefined;
      }
    });
  }

  private async performBrowserClaim(endpoint: string, signal?: AbortSignal): Promise<AgentGatewayConfig> {
    const config = await this.ensureConfig(signal);
    if (!config.enabled) {
      throw new AgentGatewayError("request_failed", "Agent control must be enabled before taking control.");
    }
    const registration = await this.postJson(
      endpoint,
      { clientInstanceId: this.clientInstanceId },
      signal,
    );
    this.browserConnectionId = parseRegistration(registration);
    return this.fetchConfig(signal);
  }

  start(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    const controller = new AbortController();
    this.runController = controller;
    this.requestedStopStatus = "disconnected";
    const releaseOnPageHide = () => this.stop("disconnected");
    globalThis.addEventListener?.("pagehide", releaseOnPageHide, { once: true });
    const running = this.run(controller.signal);
    let tracked: Promise<void>;
    tracked = running.finally(() => {
      globalThis.removeEventListener?.("pagehide", releaseOnPageHide);
      if (this.runController === controller) this.runController = undefined;
      if (this.runPromise === tracked) this.runPromise = undefined;
      this.browserConnectionId = undefined;
    });
    this.runPromise = tracked;
    return this.runPromise;
  }

  stop(status: "disabled" | "disconnected" = "disconnected"): void {
    this.requestedStopStatus = status;
    this.releaseBrowserLease();
    this.runController?.abort();
    this.runController = undefined;
    this.configValue = undefined;
    this.csrfToken = undefined;
    this.setStatus(status);
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      let config = await this.fetchConfig(signal);
      if (!config.enabled || signal.aborted) return;

      if (!this.browserConnectionId) {
        const registration = await this.postJson(
          this.endpoints.register,
          { clientInstanceId: this.clientInstanceId },
          signal,
        );
        this.browserConnectionId = parseRegistration(registration);
      }

      while (!signal.aborted && config.enabled) {
        const browserConnectionId = this.browserConnectionId;
        if (!browserConnectionId) return;
        const poll = parsePoll(await this.postJson(
          this.endpoints.poll,
          { browserConnectionId },
          signal,
        ));
        if (signal.aborted) return;

        if (poll.kind === "command") {
          if (isMutatingCommand(poll.command.name)) this.setStatus("applying");
          try {
            const result = await this.handler(
              poll.command.name,
              poll.command.input,
              { signal },
            );
            if (signal.aborted) return;
            await this.postJson(this.endpoints.result, {
              browserConnectionId,
              commandId: poll.command.id,
              ok: true,
              result,
            }, signal);
          } catch (error) {
            if (signal.aborted || isAbortError(error)) return;
            const failure = error instanceof AgentGatewayCommandError
              ? {
                  code: error.code,
                  message: error.message,
                  ...(error.details === undefined ? {} : { details: error.details }),
                }
              : {
                  code: "command_failed",
                  message: "The browser could not apply the agent command.",
                };
            await this.postJson(this.endpoints.result, {
              browserConnectionId,
              commandId: poll.command.id,
              ok: false,
              error: failure,
            }, signal);
          }
        }

        if (signal.aborted) return;
        const mutationWasApplying = this.statusValue === "applying";
        config = await this.fetchConfig(signal);
        // Public status refreshes avoid hiding an in-flight mutation. This refresh
        // happens after the browser result is accepted, so the mutation is settled
        // and the UI must return to its actual connected/waiting state.
        if (mutationWasApplying && this.statusValue === "applying") {
          this.setStatus(config.connected ? "connected" : config.clientName ? "disconnected" : "waiting");
        }
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        this.setStatus(this.requestedStopStatus);
        return;
      }
      this.setStatus("disconnected");
      throw error;
    } finally {
      this.browserConnectionId = undefined;
    }
  }

  private async ensureConfig(signal?: AbortSignal): Promise<AgentGatewayConfig> {
    if (this.configValue && this.csrfToken) return this.configValue;
    return this.fetchConfig(signal);
  }

  private enqueueConfigOperation<T>(operation: (requestSequence: number) => Promise<T>): Promise<T> {
    const requestSequence = ++this.configRequestSequence;
    const result = this.configOperationTail.then(() => operation(requestSequence));
    this.configOperationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private adoptConfig(config: AgentGatewayConfig, requestSequence: number): AgentGatewayConfig {
    // Config-bearing operations are serialized, so response order is server
    // observation order. Revisions protect against a stale same-process
    // snapshot, while retired process identities can never restore an obsolete
    // URL or CSRF token after a gateway restart.
    if (this.configValue) {
      const sameGateway = config.gatewayInstanceId === this.configValue.gatewayInstanceId;
      if (
        this.retiredGatewayInstanceIds.has(config.gatewayInstanceId) ||
        (sameGateway && config.configRevision < this.configValue.configRevision) ||
        (sameGateway && config.configRevision === this.configValue.configRevision &&
          requestSequence < this.appliedConfigRequestSequence)
      ) {
        return this.configValue;
      }
      if (!sameGateway) {
        this.retiredGatewayInstanceIds.add(this.configValue.gatewayInstanceId);
      }
    }
    this.appliedConfigRequestSequence = Math.max(this.appliedConfigRequestSequence, requestSequence);
    this.configValue = config;
    this.csrfToken = config.csrfToken;
    this.onConfig?.(config);
    if (!config.enabled) this.setStatus("disabled");
    else if (this.statusValue !== "applying") {
      this.setStatus(config.connected ? "connected" : config.clientName ? "disconnected" : "waiting");
    }
    return config;
  }

  private releaseBrowserLease(): void {
    const browserConnectionId = this.browserConnectionId;
    const csrfToken = this.csrfToken;
    if (!browserConnectionId || !csrfToken) return;
    // Clear locally first so a late pagehide/stop cannot unregister a newer
    // connection created by this client instance.
    this.browserConnectionId = undefined;
    try {
      const release = this.request(this.endpoints.unregister, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify({ browserConnectionId }),
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "same-origin",
        keepalive: true,
      });
      void Promise.resolve(release).catch(() => undefined);
    } catch {
      // Unregister is best-effort during page teardown. The aborted long poll
      // and the server TTL remain independent cleanup fallbacks.
    }
  }

  private async postJson(endpoint: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.csrfToken) {
      throw new AgentGatewayError("invalid_configuration", "The agent gateway CSRF token is unavailable.");
    }
    return this.fetchJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CSRF_HEADER]: this.csrfToken,
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async postConfigMutationWithRestartRecovery(
    endpoint: string,
    body: unknown,
    requestSequence: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.postJson(endpoint, body, signal);
    } catch (error) {
      if (!(error instanceof AgentGatewayError) || error.gatewayCode !== "csrf_invalid") throw error;
    }

    // A restarted gateway has a new lifetime identity and CSRF token, and it
    // starts disabled. The user's explicit refresh/revoke action authorizes one
    // bounded recovery: adopt the new instance, restore agent control, then retry
    // the mutation exactly once with the new token.
    let recovered = this.adoptConfig(parseConfig(await this.fetchJson(this.endpoints.config, {
      method: "GET",
      signal,
    })), requestSequence);
    if (!recovered.enabled) {
      await this.postJson(this.endpoints.enable, {}, signal);
      recovered = this.adoptConfig(parseConfig(await this.fetchJson(this.endpoints.config, {
        method: "GET",
        signal,
      })), requestSequence);
    }
    if (!recovered.enabled) {
      throw new AgentGatewayError(
        "request_failed",
        "The restarted agent gateway could not restore agent control.",
      );
    }
    return this.postJson(endpoint, body, signal);
  }

  private async fetchJson(endpoint: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchResponse(endpoint, init);
    if (response.status === 204) return undefined;
    try {
      return await response.json() as unknown;
    } catch (cause) {
      throw new AgentGatewayError(
        "invalid_response",
        "The local agent gateway returned invalid JSON.",
        { cause },
      );
    }
  }

  private async fetchResponse(
    endpoint: string,
    init: RequestInit,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Response> {
    let response: Response;
    const callerSignal = init.signal ?? undefined;
    const timeoutController = callerSignal ? undefined : new AbortController();
    const timeout = timeoutController
      ? globalThis.setTimeout(() => timeoutController.abort(), timeoutMs)
      : undefined;
    try {
      response = await this.request(endpoint, {
        ...init,
        signal: callerSignal ?? timeoutController?.signal,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "same-origin",
      });
    } catch (cause) {
      if (timeoutController?.signal.aborted) {
        throw new AgentGatewayError(
          "request_failed",
          "The local agent gateway request timed out.",
          { cause },
        );
      }
      if (isAbortError(cause)) throw cause;
      throw new AgentGatewayError(
        "request_failed",
        "The local agent gateway request failed.",
        { cause },
      );
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
    if (!response.ok) {
      let gatewayCode: string | undefined;
      try {
        const payload = await response.clone().json() as unknown;
        if (
          isRecord(payload) && isRecord(payload.error) &&
          typeof payload.error.code === "string" && /^[a-z][a-z0-9_]{0,99}$/u.test(payload.error.code)
        ) {
          gatewayCode = payload.error.code;
        }
      } catch {
        // Error response bodies are optional; status remains authoritative.
      }
      throw new AgentGatewayError(
        "request_failed",
        `The local agent gateway rejected the request (${response.status}).`,
        { status: response.status, ...(gatewayCode ? { gatewayCode } : {}) },
      );
    }
    return response;
  }

  private setStatus(status: AgentGatewayStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.onStatus?.(status);
  }
}
