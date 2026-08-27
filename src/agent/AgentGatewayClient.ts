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
import {
  AGENT_HOST_CONTROL_COMMAND_NAMES,
  type AgentHostControlCommandName,
} from "./hostControlContracts";
import {
  parseSemaFrameBridgeChangeProposal,
  type SemaFrameBridgeChangeProposal,
  type SemaFrameBridgeTarget,
  type SemaFrameExchangePackage,
} from "../bridge";

export const AGENT_GATEWAY_COMMAND_NAMES = [
  "get_workspace_instructions",
  "inspect_workspace",
  "inspect_workspace_component",
  "read_workspace_resource_snapshot",
  "inspect_workspace_asset",
  "inspect_workspace_model",
  "inspect_workspace_space",
  "query_spatial_placement",
  "query_layout_placement",
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
  ...AGENT_HOST_CONTROL_COMMAND_NAMES,
  // Host-internal attested handoff. It is never exposed as an MCP/REST tool.
  "complete_workspace_reconstruction_asset",
] as const;

export type AgentGatewayCommandName = (typeof AGENT_GATEWAY_COMMAND_NAMES)[number] | AgentHostControlCommandName;

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

export type VoiceRelayConfirmedHostAction =
  | "voice_relay_accessibility"
  | "voice_relay_configure_target"
  | "voice_relay_draft_round_trip"
  | "voice_relay_arm";

export type VoiceRelayHostActionGrant = Readonly<{
  token: string;
  expiresAtMs: number;
}>;

export type AgentBridgeSessionAccess = Readonly<{
  sessionId: string;
  bearer: string;
  target: SemaFrameBridgeTarget;
  expiresAt: string;
  pullUrl: string;
  exchangeUrl: string;
}>;

export type AgentBridgeProposalRecord = Readonly<{
  cursor: number;
  receivedAt: string;
  proposal: SemaFrameBridgeChangeProposal;
}>;

export type AgentInstallationClient = "codex" | "claude";
export type AgentInstallationAction = "install" | "update" | "remove";
export type AgentInstallationState =
  | "installed"
  | "not_installed"
  | "outdated"
  | "conflict"
  | "client_unavailable"
  | "error";

export type AgentClientInstallationView = Readonly<{
  client: AgentInstallationClient;
  displayName: "Codex" | "Claude Code";
  state: AgentInstallationState;
  changed: boolean;
  restartRequired: boolean;
  detail: string;
}>;

export type AgentClientInstallationSnapshot = Readonly<{
  version: 1;
  clients: readonly AgentClientInstallationView[];
}>;

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
  installationStatus: string;
  installationInstall: string;
  installationUpdate: string;
  installationRemove: string;
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
  voiceRelayHostActionMint: string;
  bridgeSessions: string;
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
  installationStatus: "/api/agent/browser/installations/status",
  installationInstall: "/api/agent/browser/installations/install",
  installationUpdate: "/api/agent/browser/installations/update",
  installationRemove: "/api/agent/browser/installations/remove",
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
  voiceRelayHostActionMint: "/api/agent/host-actions/voice-relay/mint",
  bridgeSessions: "/api/agent/bridge/sessions",
};

const CLIENT_INSTANCE_ID_PATTERN = /^[A-Za-z0-9._~-]{8,128}$/;
const BRIDGE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CSRF_HEADER = "X-SemaFrame-Agent-CSRF";
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
// The production Gateway deliberately holds an idle browser poll for 25s.
// Keep that transport wait independent from the shorter UI-request budget so
// a quiet, healthy Agent session cannot relock the Workspace between commands.
const BROWSER_POLL_REQUEST_TIMEOUT_MS = 60_000;
// A transactional Claude update can perform seven bounded official CLI
// operations when it must verify and roll back a bad replacement. Each command
// has a 10-second bound plus a 1-second forced-kill grace, so keep the browser
// alive through the complete rollback while retaining a finite request bound.
const AGENT_INSTALLATION_REQUEST_TIMEOUT_MS = 95_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AGENT_INSTALLATION_DETAILS = Object.freeze({
  installed: "The stable SemaFrame launcher is installed for this client.",
  not_installed: "SemaFrame is not installed for this client yet.",
  outdated: "This client has an older SemaFrame launcher configuration.",
  conflict: "A different SemaFrame configuration already uses the managed client entry.",
  client_unavailable: "This client is not available on this computer.",
  error: "The client installation could not be inspected safely.",
} satisfies Record<AgentInstallationState, string>);

function parseAgentClientInstallationView(value: unknown): AgentClientInstallationView {
  if (!isRecord(value) || !exactKeys(value, [
    "client", "displayName", "state", "changed", "restartRequired", "detail",
  ])) {
    throw new AgentGatewayError("invalid_response", "The gateway returned invalid Agent client installation data.");
  }
  const client = value.client;
  const state = value.state;
  const displayName = client === "codex" ? "Codex" : "Claude Code";
  if ((client !== "codex" && client !== "claude")
    || value.displayName !== displayName
    || typeof state !== "string" || !(state in AGENT_INSTALLATION_DETAILS)
    || typeof value.changed !== "boolean" || typeof value.restartRequired !== "boolean"
    || value.detail !== AGENT_INSTALLATION_DETAILS[state as AgentInstallationState]) {
    throw new AgentGatewayError("invalid_response", "The gateway returned invalid Agent client installation data.");
  }
  return Object.freeze({
    client,
    displayName,
    state: state as AgentInstallationState,
    changed: value.changed,
    restartRequired: value.restartRequired,
    detail: value.detail,
  });
}

function parseAgentClientInstallationSnapshot(value: unknown): AgentClientInstallationSnapshot {
  if (!isRecord(value) || !exactKeys(value, ["version", "clients"])
    || value.version !== 1 || !Array.isArray(value.clients) || value.clients.length !== 2) {
    throw new AgentGatewayError("invalid_response", "The gateway returned invalid Agent client installation health.");
  }
  const clients = value.clients.map(parseAgentClientInstallationView);
  if (clients[0]?.client !== "codex" || clients[1]?.client !== "claude") {
    throw new AgentGatewayError("invalid_response", "The gateway returned invalid Agent client installation health.");
  }
  return Object.freeze({ version: 1, clients: Object.freeze(clients) });
}

function parseVoiceRelayHostActionGrant(value: unknown): VoiceRelayHostActionGrant {
  if (!isRecord(value) || !exactKeys(value, ["token", "expiresAtMs"])
    || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.token)
    || !Number.isSafeInteger(value.expiresAtMs) || Number(value.expiresAtMs) < Date.now()) {
    throw new AgentGatewayError("invalid_response", "The gateway returned an invalid Voice Relay confirmation grant.");
  }
  return Object.freeze({ token: value.token, expiresAtMs: Number(value.expiresAtMs) });
}

function parseBridgeSessionAccess(value: unknown): AgentBridgeSessionAccess {
  if (!isRecord(value) || !exactKeys(value, [
    "sessionId", "bearer", "target", "expiresAt", "pullUrl", "exchangeUrl",
  ]) || typeof value.sessionId !== "string" || !BRIDGE_SESSION_ID_PATTERN.test(value.sessionId)
    || typeof value.bearer !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.bearer)
    || !["blender", "freecad", "unity", "unreal", "custom"].includes(String(value.target))
    || typeof value.expiresAt !== "string" || typeof value.pullUrl !== "string"
    || typeof value.exchangeUrl !== "string") {
    throw new AgentGatewayError("invalid_response", "The gateway returned an invalid Bridge session.");
  }
  const expiresAt = new Date(value.expiresAt);
  let pullUrl: URL;
  let exchangeUrl: URL;
  try {
    pullUrl = new URL(value.pullUrl);
    exchangeUrl = new URL(value.exchangeUrl);
  } catch (cause) {
    throw new AgentGatewayError("invalid_response", "The gateway returned invalid Bridge URLs.", { cause });
  }
  const expectedPullPath = `/v1/bridge/sessions/${value.sessionId}`;
  if (Number.isNaN(expiresAt.valueOf()) || expiresAt.toISOString() !== value.expiresAt
    || !["http:", "https:"].includes(pullUrl.protocol)
    || pullUrl.username || pullUrl.password || pullUrl.pathname !== expectedPullPath || pullUrl.search || pullUrl.hash
    || exchangeUrl.origin !== pullUrl.origin || exchangeUrl.username || exchangeUrl.password
    || exchangeUrl.pathname !== `${expectedPullPath}/exchange` || exchangeUrl.search || exchangeUrl.hash) {
    throw new AgentGatewayError("invalid_response", "The gateway returned inconsistent Bridge session metadata.");
  }
  return Object.freeze({
    sessionId: value.sessionId,
    bearer: value.bearer,
    target: value.target as SemaFrameBridgeTarget,
    expiresAt: value.expiresAt,
    pullUrl: pullUrl.toString(),
    exchangeUrl: exchangeUrl.toString(),
  });
}

function parseBridgeProposalRecords(value: unknown): readonly AgentBridgeProposalRecord[] {
  if (!isRecord(value) || !exactKeys(value, ["proposals"]) || !Array.isArray(value.proposals)) {
    throw new AgentGatewayError("invalid_response", "The gateway returned an invalid Bridge proposal queue.");
  }
  return Object.freeze(value.proposals.map((entry): AgentBridgeProposalRecord => {
    if (!isRecord(entry) || !exactKeys(entry, ["cursor", "receivedAt", "proposal"])
      || !Number.isSafeInteger(entry.cursor) || Number(entry.cursor) < 1 || typeof entry.receivedAt !== "string") {
      throw new AgentGatewayError("invalid_response", "The gateway returned an invalid Bridge proposal record.");
    }
    const receivedAt = new Date(entry.receivedAt);
    if (Number.isNaN(receivedAt.valueOf()) || receivedAt.toISOString() !== entry.receivedAt) {
      throw new AgentGatewayError("invalid_response", "The gateway returned an invalid Bridge proposal timestamp.");
    }
    return Object.freeze({
      cursor: Number(entry.cursor),
      receivedAt: entry.receivedAt,
      proposal: parseSemaFrameBridgeChangeProposal(entry.proposal),
    });
  }));
}

function bridgeSessionId(value: string): string {
  if (!BRIDGE_SESSION_ID_PATTERN.test(value)) {
    throw new AgentGatewayError("invalid_configuration", "The Bridge session identifier is invalid.");
  }
  return value;
}

function bridgePublicationForm(
  exchange: SemaFrameExchangePackage,
  sequence: number,
  target?: SemaFrameBridgeTarget,
  ttlMs?: number,
): FormData {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new AgentGatewayError("invalid_configuration", "The Bridge publication sequence is invalid.");
  }
  if (target !== undefined && !["blender", "freecad", "unity", "unreal", "custom"].includes(target)) {
    throw new AgentGatewayError("invalid_configuration", "The Bridge target is invalid.");
  }
  const archive = new Uint8Array(exchange.archive.bytes.byteLength);
  archive.set(exchange.archive.bytes);
  const metadata = {
    ...(target === undefined ? {} : { target }),
    sequence,
    workspaceId: exchange.manifest.source.workspaceId,
    revision: exchange.manifest.source.revision,
    exchangeDigest: exchange.archive.sha256,
    manifest: exchange.manifest,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("archive", new Blob([archive.buffer], { type: exchange.archive.mediaType }), "scene.semaframe-exchange");
  return form;
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

function abortSignalReason(signal?: AbortSignal | null): Error | DOMException {
  const reason = signal?.reason;
  return reason instanceof Error || isAbortError(reason)
    ? reason as Error | DOMException
    : new DOMException("Aborted", "AbortError");
}

type ResponseDeadline = Readonly<{
  signal: AbortSignal;
  release(): void;
}>;

const responseDeadlines = new WeakMap<Response, ResponseDeadline>();

function releaseResponseDeadline(response: Response): void {
  const deadline = responseDeadlines.get(response);
  if (!deadline) return;
  responseDeadlines.delete(response);
  deadline.release();
}

async function runResponseDeadlineOperation<Value>(
  response: Response,
  operation: () => Promise<Value>,
): Promise<Value> {
  const deadline = responseDeadlines.get(response);
  if (!deadline) return operation();
  let abortOperation: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abortOperation = () => reject(abortSignalReason(deadline.signal));
    deadline.signal.addEventListener("abort", abortOperation, { once: true });
    if (deadline.signal.aborted) abortOperation();
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    deadline.signal.removeEventListener("abort", abortOperation);
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await runResponseDeadlineOperation(response, async () => await response.json() as unknown);
  } finally {
    releaseResponseDeadline(response);
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await runResponseDeadlineOperation(response, async () => { await response.body?.cancel(); });
  } finally {
    releaseResponseDeadline(response);
  }
}

function rethrowRequestInterruption(
  cause: unknown,
  callerSignal?: AbortSignal | null,
): void {
  if (cause instanceof AgentGatewayError) throw cause;
  if (callerSignal?.aborted) {
    throw abortSignalReason(callerSignal);
  }
  if (isAbortError(cause)) throw cause;
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

  async getAgentClientInstallations(signal?: AbortSignal): Promise<AgentClientInstallationSnapshot> {
    await this.ensureConfig(signal);
    return parseAgentClientInstallationSnapshot(await this.postWithCsrfRecovery(
      this.endpoints.installationStatus,
      {},
      signal,
      AGENT_INSTALLATION_REQUEST_TIMEOUT_MS,
    ));
  }

  async manageAgentClientInstallation(
    client: AgentInstallationClient,
    action: AgentInstallationAction,
    signal?: AbortSignal,
  ): Promise<AgentClientInstallationView> {
    if (client !== "codex" && client !== "claude") {
      throw new AgentGatewayError("invalid_configuration", "The Agent client must be Codex or Claude Code.");
    }
    const endpoint = action === "install"
      ? this.endpoints.installationInstall
      : action === "update"
        ? this.endpoints.installationUpdate
        : action === "remove"
          ? this.endpoints.installationRemove
          : undefined;
    if (!endpoint) {
      throw new AgentGatewayError("invalid_configuration", "The Agent client installation action is invalid.");
    }
    await this.ensureConfig(signal);
    return parseAgentClientInstallationView(await this.postWithCsrfRecovery(
      endpoint,
      { client },
      signal,
      AGENT_INSTALLATION_REQUEST_TIMEOUT_MS,
    ));
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
   * Mints a short-lived, one-use proof after the desktop has displayed and the
   * human has confirmed the matching HostAction. The token is accepted only by
   * the exact Voice Relay action and is never exposed to an external Agent.
   */
  async mintVoiceRelayHostAction(
    action: VoiceRelayConfirmedHostAction,
    signal?: AbortSignal,
  ): Promise<VoiceRelayHostActionGrant> {
    if (action !== "voice_relay_accessibility"
      && action !== "voice_relay_configure_target"
      && action !== "voice_relay_arm"
      && action !== "voice_relay_draft_round_trip") {
      throw new AgentGatewayError("invalid_configuration", "The Voice Relay host action is invalid.");
    }
    await this.ensureConfig(signal);
    return parseVoiceRelayHostActionGrant(await this.postJson(
      this.endpoints.voiceRelayHostActionMint,
      { action },
      signal,
    ));
  }

  /**
   * Publishes a bounded immutable Scene Exchange to a scoped pull session.
   * The returned bearer authorizes only this session's native-tool endpoints.
   */
  async createBridgeSession(
    target: SemaFrameBridgeTarget,
    exchange: SemaFrameExchangePackage,
    options: Readonly<{ ttlMs?: number; signal?: AbortSignal }> = {},
  ): Promise<AgentBridgeSessionAccess> {
    await this.ensureConfig(options.signal);
    if (!this.csrfToken) {
      throw new AgentGatewayError("invalid_configuration", "The agent gateway CSRF token is unavailable.");
    }
    const response = await this.fetchResponse(this.endpoints.bridgeSessions, {
      method: "POST",
      headers: { [CSRF_HEADER]: this.csrfToken },
      body: bridgePublicationForm(exchange, 1, target, options.ttlMs),
      signal: options.signal,
    }, 2 * 60_000);
    try {
      return parseBridgeSessionAccess(await readResponseJson(response));
    } catch (cause) {
      rethrowRequestInterruption(cause, options.signal);
      throw new AgentGatewayError("invalid_response", "The gateway returned invalid Bridge session JSON.", { cause });
    }
  }

  async publishBridgeSession(
    sessionId: string,
    sequence: number,
    exchange: SemaFrameExchangePackage,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureConfig(signal);
    if (!this.csrfToken) {
      throw new AgentGatewayError("invalid_configuration", "The agent gateway CSRF token is unavailable.");
    }
    const endpoint = `${this.endpoints.bridgeSessions}/${bridgeSessionId(sessionId)}/publish`;
    const response = await this.fetchResponse(endpoint, {
      method: "POST",
      headers: { [CSRF_HEADER]: this.csrfToken },
      body: bridgePublicationForm(exchange, sequence),
      signal,
    }, 2 * 60_000);
    await discardResponseBody(response);
  }

  async readBridgeProposals(
    sessionId: string,
    afterCursor = 0,
    signal?: AbortSignal,
  ): Promise<readonly AgentBridgeProposalRecord[]> {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new AgentGatewayError("invalid_configuration", "The Bridge proposal cursor is invalid.");
    }
    await this.ensureConfig(signal);
    return parseBridgeProposalRecords(await this.postJson(
      `${this.endpoints.bridgeSessions}/${bridgeSessionId(sessionId)}/proposals/read`,
      { afterCursor },
      signal,
    ));
  }

  async discardBridgeProposals(
    sessionId: string,
    throughCursor: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(throughCursor) || throughCursor < 0) {
      throw new AgentGatewayError("invalid_configuration", "The Bridge proposal cursor is invalid.");
    }
    await this.ensureConfig(signal);
    const value = await this.postJson(
      `${this.endpoints.bridgeSessions}/${bridgeSessionId(sessionId)}/proposals/discard`,
      { throughCursor },
      signal,
    );
    if (!isRecord(value) || !exactKeys(value, ["discardedThroughCursor"])
      || value.discardedThroughCursor !== throughCursor) {
      throw new AgentGatewayError("invalid_response", "The gateway did not confirm Bridge proposal discard.");
    }
  }

  async closeBridgeSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.ensureConfig(signal);
    const value = await this.postJson(
      `${this.endpoints.bridgeSessions}/${bridgeSessionId(sessionId)}/close`,
      {},
      signal,
    );
    if (!isRecord(value) || !exactKeys(value, ["closed"]) || value.closed !== true) {
      throw new AgentGatewayError("invalid_response", "The gateway did not confirm Bridge session closure.");
    }
  }

  /**
   * Best-effort page-lifecycle revocation. This intentionally does not await a
   * response: `pagehide` may terminate the document immediately after the
   * request is queued, while the session TTL remains the final cleanup bound.
   */
  releaseBridgeSession(sessionId: string): void {
    const csrfToken = this.csrfToken;
    if (!csrfToken) return;
    let endpoint: string;
    try {
      endpoint = `${this.endpoints.bridgeSessions}/${bridgeSessionId(sessionId)}/close`;
    } catch {
      return;
    }
    try {
      const release = this.request(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrfToken,
        },
        body: "{}",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "same-origin",
        keepalive: true,
      });
      void Promise.resolve(release).catch(() => undefined);
    } catch {
      // Best effort only. Normal in-app closure still uses closeBridgeSession
      // and surfaces failures to the owner.
    }
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
      await discardResponseBody(response).catch(() => undefined);
      throw new AgentGatewayError("invalid_response", "The asset stream headers do not match its inspected descriptor.");
    }
    // Ownership transfers to the returned stream. Its wrapper retains the
    // request deadline until the caller consumes or cancels the full body.
    releaseResponseDeadline(response);
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
      value = await readResponseJson(response);
    } catch (cause) {
      rethrowRequestInterruption(cause, signal);
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
          BROWSER_POLL_REQUEST_TIMEOUT_MS,
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

  private async postJson(
    endpoint: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
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
    }, timeoutMs);
  }

  private async postWithCsrfRecovery(
    endpoint: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    try {
      return await this.postJson(endpoint, body, signal, timeoutMs);
    } catch (error) {
      if (!(error instanceof AgentGatewayError) || error.gatewayCode !== "csrf_invalid") throw error;
    }
    // A CSRF rejection happens before the host action is dispatched, so this
    // one bounded retry cannot duplicate an installation mutation.
    await this.fetchConfig(signal);
    return this.postJson(endpoint, body, signal, timeoutMs);
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

  private async fetchJson(
    endpoint: string,
    init: RequestInit,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const response = await this.fetchResponse(endpoint, init, timeoutMs);
    if (response.status === 204) {
      releaseResponseDeadline(response);
      return undefined;
    }
    try {
      return await readResponseJson(response);
    } catch (cause) {
      rethrowRequestInterruption(cause, init.signal);
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
    const requestController = new AbortController();
    let cleanedUp = false;
    // One hold belongs to the Response consumer. Streaming bodies add a
    // second hold so ownership can be transferred to an escaping stream while
    // JSON consumers keep the deadline through parsing, after stream EOF.
    let lifetimeHolds = 1;
    const timeoutError = () => new AgentGatewayError(
      "request_failed",
      "The local agent gateway request timed out.",
    );
    const abortReason = () => abortSignalReason(requestController.signal);
    const abortFromCaller = () => requestController.abort(abortSignalReason(callerSignal));
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = globalThis.setTimeout(() => {
      requestController.abort(timeoutError());
    }, timeoutMs);
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      globalThis.clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    };
    const releaseLifetimeHold = () => {
      if (lifetimeHolds <= 0) return;
      lifetimeHolds -= 1;
      if (lifetimeHolds === 0) cleanup();
    };
    try {
      response = await this.request(endpoint, {
        ...init,
        signal: requestController.signal,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "same-origin",
      });
    } catch (cause) {
      cleanup();
      if (requestController.signal.aborted) throw abortReason();
      if (isAbortError(cause)) throw cause;
      throw new AgentGatewayError(
        "request_failed",
        "The local agent gateway request failed.",
        { cause },
      );
    }

    if (response.body) {
      lifetimeHolds += 1;
      const source = response.body.getReader();
      let bodyFinished = false;
      let abortBody = () => undefined;
      const finishBody = () => {
        if (bodyFinished) return false;
        bodyFinished = true;
        requestController.signal.removeEventListener("abort", abortBody);
        releaseLifetimeHold();
        return true;
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          abortBody = () => {
            if (!finishBody()) return;
            const reason = abortReason();
            void source.cancel(reason).catch(() => undefined);
            controller.error(reason);
          };
          requestController.signal.addEventListener("abort", abortBody, { once: true });
          if (requestController.signal.aborted) abortBody();
        },
        async pull(controller) {
          if (bodyFinished) return;
          try {
            const chunk = await source.read();
            if (bodyFinished) return;
            if (chunk.done) {
              finishBody();
              source.releaseLock();
              controller.close();
              return;
            }
            controller.enqueue(chunk.value);
          } catch (cause) {
            if (!finishBody()) return;
            controller.error(requestController.signal.aborted ? abortReason() : cause);
          }
        },
        cancel(reason) {
          if (!finishBody()) return;
          void source.cancel(reason).catch(() => undefined);
        },
      });
      response = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    responseDeadlines.set(response, {
      signal: requestController.signal,
      release: releaseLifetimeHold,
    });

    if (!response.ok) {
      let gatewayCode: string | undefined;
      try {
        const payload = await runResponseDeadlineOperation(
          response,
          async () => await response.clone().json() as unknown,
        );
        if (
          isRecord(payload) && isRecord(payload.error) &&
          typeof payload.error.code === "string" && /^[a-z][a-z0-9_]{0,99}$/u.test(payload.error.code)
        ) {
          gatewayCode = payload.error.code;
        }
      } catch (cause) {
        if (requestController.signal.aborted) throw abortReason();
        // Error response bodies are optional; status remains authoritative.
      } finally {
        await discardResponseBody(response).catch(() => undefined);
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
