import {
  DEFAULT_WORKSPACE_AGENT_SCOPES,
  WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES,
  WORKSPACE_PROTOCOL_VERSION,
  type JSONValue,
  type WorkspaceAgentError,
  type WorkspaceAgentPrincipal,
  type WorkspaceAgentResult,
  type WorkspaceAgentToolName,
  type WorkspaceCommitReceipt,
  type WorkspaceComponentStateView,
  type WorkspaceEnginePort,
  WorkspaceEngineError,
  type WorkspaceHistoryReceipt,
  type WorkspacePermissionScope,
  type WorkspacePreparedEnvelope,
  type WorkspacePreparedUpdate,
  type WorkspaceStateView,
  isWorkspaceAgentToolName,
  isWorkspacePermissionScope,
} from "./contracts";
import {
  WORKSPACE_AGENT_GUIDE,
  digestWorkspaceAgentValue,
  getWorkspaceAgentGuideDigest,
} from "./guide";

const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_TRANSACTION_TTL_MS = 2 * 60_000;
const DEFAULT_RESERVED_ID_COUNT = 8;
const MAX_RESERVED_ID_COUNT = 100;
const MAX_INTENT_LENGTH = 4_000;
const MAX_EVENT_LIMIT = 200;

type SessionRecord = {
  token: string;
  digest: string;
  clientId: string;
  clientName?: string;
  scopes: readonly WorkspacePermissionScope[];
  expiresAt: number;
};

type TransactionRecord = {
  token: string;
  sessionToken: string;
  digest: string;
  prepared: WorkspacePreparedUpdate;
  intent: string;
  expiresAt: number;
  state: "prepared" | "submitting" | "completed" | "expired";
  submissionDigest?: string;
  submission?: Promise<WorkspaceAgentResult<SubmitWorkspaceBatchData>>;
  result?: WorkspaceAgentResult<SubmitWorkspaceBatchData>;
};

export type WorkspaceScopeGrantRequest = Readonly<{
  clientId: string;
  clientName?: string;
  requestedScopes: readonly WorkspacePermissionScope[];
}>;

export type WorkspaceAgentControllerOptions = Readonly<{
  sessionTtlMs?: number;
  transactionTtlMs?: number;
  now?: () => number;
  randomToken?: (prefix: string) => string;
  grantScopes?: (
    request: WorkspaceScopeGrantRequest,
  ) => readonly WorkspacePermissionScope[] | Promise<readonly WorkspacePermissionScope[]>;
}>;

export type WorkspaceInstructionsData = Readonly<{
  session_token: string;
  session_expires_at: string;
  guide_digest: string;
  guide: typeof WORKSPACE_AGENT_GUIDE;
  client_id: string;
  client_name?: string;
  requested_scopes: readonly WorkspacePermissionScope[];
  granted_scopes: readonly WorkspacePermissionScope[];
  denied_scopes: readonly WorkspacePermissionScope[];
}>;

export type InspectWorkspaceData = Readonly<{
  client_id: string;
  client_name?: string;
  workspace_id: string;
  workspace_revision: number;
  registry_digest: string;
  workspace_summary: JSONValue;
  capability_manifest: JSONValue;
}>;

export type InspectWorkspaceComponentData = Readonly<{
  client_id: string;
  client_name?: string;
  workspace_id: string;
  workspace_revision: number;
  registry_digest: string;
  component: JSONValue;
  pinned_manifest: JSONValue;
  current_geometry: JSONValue;
  active_resize_policy: JSONValue;
  current_visual_effects: JSONValue;
  visual_effects_policy: JSONValue;
  redacted_fields: readonly string[];
  state_truncated: boolean;
  omitted_state_bytes: number;
  component_metadata_truncated: boolean;
  omitted_binding_count: number;
  omitted_tag_count: number;
  omitted_redacted_field_count: number;
  manifest_truncated: false;
}>;

export type InspectWorkspaceSpaceData = Readonly<{
  client_id: string;
  client_name?: string;
  workspace_id: string;
  workspace_revision: number;
  registry_digest: string;
  universal_space_data: JSONValue;
}>;

export type QuerySpatialPlacementData = Readonly<{
  client_id: string;
  client_name?: string;
  workspace_id: string;
  workspace_revision: number;
  registry_digest: string;
  placement_check: JSONValue;
}>;

export type InspectWorkspacePhysicsData = Readonly<{
  client_id: string;
  client_name?: string;
  workspace_id: string;
  workspace_revision: number;
  registry_digest: string;
  physics_validation: JSONValue;
}>;

export type QueryStablePlacementData = Readonly<{
  client_id: string;
  client_name?: string;
  workspace_id: string;
  workspace_revision: number;
  registry_digest: string;
  stability_check: JSONValue;
}>;

export type SimulateWorkspacePhysicsData = Readonly<{
  client_id: string;
  client_name?: string;
  workspace_id: string;
  workspace_revision: number;
  registry_digest: string;
  simulation: JSONValue;
}>;

export type BeginWorkspaceUpdateData = Readonly<{
  client_id: string;
  client_name?: string;
  instruction_digest: string;
  transaction_token: string;
  transaction_expires_at: string;
  intent: string;
  envelope: WorkspacePreparedEnvelope;
  workspace_summary: JSONValue;
  capability_manifest: JSONValue;
  reserved_component_ids: readonly string[];
}>;

export type SubmitWorkspaceBatchData = Readonly<{
  client_id: string;
  client_name?: string;
  transaction_token: string;
  request_id: string;
  base_workspace_revision: number;
  resulting_workspace_revision: number;
  status: WorkspaceCommitReceipt["status"];
  summary: string;
  delta?: JSONValue;
  resolved_batch?: JSONValue;
}>;

export type WorkspaceHistoryData = Readonly<{
  client_id: string;
  client_name?: string;
  action: "undo" | "redo";
  changed: boolean;
  workspace_revision: number;
  delta: JSONValue | null;
}>;

export type WorkspaceEventsData = Readonly<{
  client_id: string;
  client_name?: string;
  events: Awaited<ReturnType<WorkspaceEnginePort["readEvents"]>>["events"];
  next_cursor: string;
  has_more: boolean;
}>;

function ok<T>(data: T): WorkspaceAgentResult<T> {
  return { ok: true, data };
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function fail<T = never>(error: WorkspaceAgentError): WorkspaceAgentResult<T> {
  return { ok: false, error };
}

function agentError(
  code: string,
  message: string,
  options: {
    retryable?: boolean;
    requiredAction?: WorkspaceAgentError["required_action"];
    details?: JSONValue;
  } = {},
): WorkspaceAgentError {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.requiredAction ? { required_action: options.requiredAction } : {}),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

function defaultToken(prefix: string): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Cryptographically secure randomness is required for Workspace agent sessions");
  }
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${encoded}`;
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceEngineError("invalid_request", "Tool input must be a JSON object", { retryable: true });
  }
  const record = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new WorkspaceEngineError("invalid_request", "Tool input contains unsupported fields", { retryable: true });
  }
  if (required.some((key) => !Object.hasOwn(record, key))) {
    throw new WorkspaceEngineError(
      "invalid_request",
      `Tool input requires ${required.join(", ") || "no fields"}`,
      { retryable: true },
    );
  }
  return record;
}

function safeIdentity(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
  return normalized || undefined;
}

function requiredString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new WorkspaceEngineError(
      "invalid_request",
      `${field} must contain ${minimum}-${maximum} characters`,
      { retryable: true },
    );
  }
  return value;
}

function safeInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new WorkspaceEngineError(
      "invalid_request",
      `${field} must be an integer between ${minimum} and ${maximum}`,
      { retryable: true },
    );
  }
  return Number(value);
}

function uniqueScopes(values: readonly WorkspacePermissionScope[]): WorkspacePermissionScope[] {
  return [...new Set(values)].sort();
}

function requestedScopes(value: unknown): WorkspacePermissionScope[] {
  if (value === undefined) return [...DEFAULT_WORKSPACE_AGENT_SCOPES];
  if (!Array.isArray(value) || value.length > 20 || value.some((scope) => !isWorkspacePermissionScope(scope))) {
    throw new WorkspaceEngineError(
      "invalid_request",
      "requested_scopes contains an unsupported Workspace permission",
      { retryable: true },
    );
  }
  return uniqueScopes(value);
}

function principal(session: SessionRecord): WorkspaceAgentPrincipal {
  return {
    sessionId: session.token,
    clientId: session.clientId,
    ...(session.clientName ? { clientName: session.clientName } : {}),
    scopes: [...session.scopes],
  };
}

function publicIdentity(session: SessionRecord): { client_id: string; client_name?: string } {
  return {
    client_id: session.clientId,
    ...(session.clientName ? { client_name: session.clientName } : {}),
  };
}

function operationRecords(batch: unknown): Record<string, unknown>[] {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return [];
  const operations = (batch as Record<string, unknown>).operations;
  if (!Array.isArray(operations)) return [];
  return operations.filter(
    (operation): operation is Record<string, unknown> =>
      Boolean(operation) && typeof operation === "object" && !Array.isArray(operation),
  );
}

export function requiredScopesForWorkspaceBatch(batch: unknown): WorkspacePermissionScope[] {
  const required = new Set<WorkspacePermissionScope>(["workspace:write"]);
  for (const operation of operationRecords(batch)) {
    switch (operation.op) {
      case "create_component":
        required.add("component:create");
        break;
      case "update_component":
      case "upgrade_component_manifest":
      case "place_component":
      case "resize_component":
      case "set_component_visual_effects":
      case "attach_component":
      case "detach_component":
        required.add("component:update");
        break;
      case "delete_component":
        required.add("component:delete");
        break;
      case "invoke_component_action":
        required.add("component:invoke");
        break;
      case "upsert_resource":
        required.add("connector:write");
        break;
      case "delete_resource":
        required.add("connector:delete");
        break;
      case "bind_resource":
      case "unbind_resource":
        required.add("connector:bind");
        break;
      case "define_component_recipe":
        required.add("component:recipe_define");
        break;
      case "connect_event":
      case "disconnect_event":
        required.add("event:connect");
        break;
      case "present_view":
        required.add("view:present");
        break;
      case "clear_workspace":
        required.add("workspace:clear");
        break;
      default:
        break;
    }
  }
  return [...required].sort();
}

export function destructiveWorkspaceOperations(batch: unknown): JSONValue[] {
  return operationRecords(batch).flatMap((operation, index) => {
    if (
      operation.op !== "delete_component" &&
      operation.op !== "clear_workspace" &&
      operation.op !== "delete_resource"
    ) return [];
    return [{
      index,
      op: operation.op,
      ...(typeof operation.op_id === "string" ? { op_id: operation.op_id } : {}),
    } satisfies JSONValue];
  });
}

function envelopeMismatches(batch: unknown, envelope: WorkspacePreparedEnvelope): JSONValue[] {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
    return [{ field: "batch", expected: "object", received: typeof batch }];
  }
  const record = batch as Record<string, unknown>;
  return Object.entries(envelope).flatMap(([field, expected]) =>
    record[field] === expected ? [] : [{ field, expected: expected as JSONValue, received: toSafeDetail(record[field]) }],
  );
}

function toSafeDetail(value: unknown): JSONValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(toSafeDetail);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, entry]) => [key, toSafeDetail(entry)]),
    );
  }
  return String(value);
}

function validPrepared(prepared: WorkspacePreparedUpdate): boolean {
  const envelope = prepared?.envelope;
  return Boolean(
    envelope &&
    envelope.protocol_version === WORKSPACE_PROTOCOL_VERSION &&
    envelope.mode === "commit" &&
    typeof envelope.request_id === "string" && envelope.request_id.length > 0 &&
    typeof envelope.workspace_id === "string" && envelope.workspace_id.length > 0 &&
    Number.isSafeInteger(envelope.input_revision) && envelope.input_revision >= 0 &&
    Number.isSafeInteger(envelope.base_workspace_revision) && envelope.base_workspace_revision >= 0 &&
    typeof envelope.registry_digest === "string" && envelope.registry_digest.length >= 8 &&
    Array.isArray(prepared.reserved_component_ids) &&
    new Set(prepared.reserved_component_ids).size === prepared.reserved_component_ids.length &&
    prepared.reserved_component_ids.every((id) => typeof id === "string" && id.length > 0)
  );
}

export class WorkspaceAgentController {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly transactions = new Map<string, TransactionRecord>();
  private readonly sessionTtlMs: number;
  private readonly transactionTtlMs: number;
  private readonly now: () => number;
  private readonly randomToken: (prefix: string) => string;
  private readonly grantScopes: NonNullable<WorkspaceAgentControllerOptions["grantScopes"]>;

  constructor(
    private readonly engine: WorkspaceEnginePort,
    options: WorkspaceAgentControllerOptions = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.transactionTtlMs = options.transactionTtlMs ?? DEFAULT_TRANSACTION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? defaultToken;
    this.grantScopes = options.grantScopes ?? (() => ["workspace:read"]);
    for (const [name, value] of [
      ["sessionTtlMs", this.sessionTtlMs],
      ["transactionTtlMs", this.transactionTtlMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    }
  }

  async getWorkspaceInstructions(input: unknown = {}): Promise<WorkspaceAgentResult<WorkspaceInstructionsData>> {
    try {
      this.purgeExpired();
      const body = exactRecord(input, ["client_id", "client_name", "requested_scopes"], []);
      const requested = requestedScopes(body.requested_scopes);
      const clientId = safeIdentity(body.client_id, 128) ?? this.randomToken("workspace_client").slice(0, 128);
      const clientName = safeIdentity(body.client_name, 160);
      const grantedCandidate = await this.grantScopes({
        clientId,
        ...(clientName ? { clientName } : {}),
        requestedScopes: requested,
      });
      if (!Array.isArray(grantedCandidate) || grantedCandidate.some((scope) => !isWorkspacePermissionScope(scope))) {
        throw new WorkspaceEngineError("engine_error", "The scope grant callback returned invalid permissions");
      }
      const granted = uniqueScopes(grantedCandidate.filter((scope) => requested.includes(scope)));
      const digest = await getWorkspaceAgentGuideDigest();
      const token = this.randomToken("workspace_session");
      const expiresAt = this.now() + this.sessionTtlMs;
      const session: SessionRecord = {
        token,
        digest,
        clientId,
        ...(clientName ? { clientName } : {}),
        scopes: granted,
        expiresAt,
      };
      this.sessions.set(token, session);
      return ok({
        ...publicIdentity(session),
        session_token: token,
        session_expires_at: new Date(expiresAt).toISOString(),
        guide_digest: digest,
        guide: structuredClone(WORKSPACE_AGENT_GUIDE),
        requested_scopes: requested,
        granted_scopes: granted,
        denied_scopes: requested.filter((scope) => !granted.includes(scope)),
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async inspectWorkspace(input: unknown): Promise<WorkspaceAgentResult<InspectWorkspaceData>> {
    try {
      // Let the capability check, rather than shape validation, explain a
      // missing session. External agents need an actionable instruction-first
      // recovery path even when they call a later tool with an empty object.
      const body = exactRecord(input, ["session_token", "instruction_digest"], []);
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:read"]);
      const snapshot = await this.consistentState();
      const registryDigest = await this.engine.getRegistryDigest();
      return ok({
        ...publicIdentity(session),
        workspace_id: snapshot.workspaceId,
        workspace_revision: snapshot.revision,
        registry_digest: registryDigest,
        workspace_summary: structuredClone(snapshot.summary),
        capability_manifest: structuredClone(snapshot.capabilityManifest),
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async inspectWorkspaceComponent(
    input: unknown,
  ): Promise<WorkspaceAgentResult<InspectWorkspaceComponentData>> {
    try {
      const body = exactRecord(
        input,
        ["session_token", "instruction_digest", "component_id"],
        [],
      );
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:read"]);
      const componentId = requiredString(body.component_id, "component_id", 1, 256);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/u.test(componentId)) {
        throw new WorkspaceEngineError(
          "invalid_request",
          "component_id must be a valid Workspace identifier",
          { retryable: true },
        );
      }
      const inspection = await this.consistentComponentState(componentId, principal(session));
      const result = ok({
        ...publicIdentity(session),
        workspace_id: inspection.workspaceId,
        workspace_revision: inspection.revision,
        registry_digest: inspection.registryDigest,
        component: structuredClone(inspection.component),
        pinned_manifest: structuredClone(inspection.pinnedManifest),
        current_geometry: structuredClone(inspection.currentGeometry),
        active_resize_policy: structuredClone(inspection.activeResizePolicy),
        current_visual_effects: structuredClone(inspection.currentVisualEffects),
        visual_effects_policy: structuredClone(inspection.visualEffectsPolicy),
        redacted_fields: [...inspection.redactedFields],
        state_truncated: inspection.stateTruncated,
        omitted_state_bytes: inspection.omittedStateBytes,
        component_metadata_truncated: inspection.componentMetadataTruncated,
        omitted_binding_count: inspection.omittedBindingCount,
        omitted_tag_count: inspection.omittedTagCount,
        omitted_redacted_field_count: inspection.omittedRedactedFieldCount,
        manifest_truncated: inspection.manifestTruncated,
      });
      if (encodedBytes(result) > WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES) {
        throw new WorkspaceEngineError(
          "engine_contract_violation",
          "Public component inspection exceeded its maximum encoded size",
        );
      }
      return result;
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async inspectWorkspaceSpace(input: unknown): Promise<WorkspaceAgentResult<InspectWorkspaceSpaceData>> {
    try {
      const body = exactRecord(
        input,
        ["session_token", "instruction_digest", "since_revision"],
        [],
      );
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:read"]);
      const sinceRevision = body.since_revision === undefined
        ? undefined
        : safeInteger(body.since_revision, "since_revision", 0, Number.MAX_SAFE_INTEGER);
      const result = await this.engine.inspectSpace(sinceRevision, principal(session));
      return ok({
        ...publicIdentity(session),
        workspace_id: result.workspaceId,
        workspace_revision: result.revision,
        registry_digest: result.registryDigest,
        universal_space_data: structuredClone(result.universalSpaceData),
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async querySpatialPlacement(input: unknown): Promise<WorkspaceAgentResult<QuerySpatialPlacementData>> {
    try {
      const body = exactRecord(
        input,
        ["session_token", "instruction_digest", "candidate"],
        [],
      );
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:read"]);
      if (!Object.hasOwn(body, "candidate")) {
        throw new WorkspaceEngineError("invalid_request", "candidate is required", { retryable: true });
      }
      const result = await this.engine.querySpatialPlacement(body.candidate, principal(session));
      return ok({
        ...publicIdentity(session),
        workspace_id: result.workspaceId,
        workspace_revision: result.revision,
        registry_digest: result.registryDigest,
        placement_check: structuredClone(result.placementCheck),
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async inspectWorkspacePhysics(input: unknown): Promise<WorkspaceAgentResult<InspectWorkspacePhysicsData>> {
    try {
      const body = exactRecord(input, ["session_token", "instruction_digest", "component_ids"], []);
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:read"]);
      let componentIds: string[] | undefined;
      if (body.component_ids !== undefined) {
        if (!Array.isArray(body.component_ids) || body.component_ids.length > 100
          || body.component_ids.some((id) => typeof id !== "string" || !id || id.length > 256)) {
          throw new WorkspaceEngineError("invalid_request", "component_ids must contain at most 100 non-empty IDs", { retryable: true });
        }
        componentIds = [...new Set(body.component_ids as string[])].sort();
      }
      const result = await this.engine.inspectPhysics(componentIds, principal(session));
      return ok({
        ...publicIdentity(session),
        workspace_id: result.workspaceId,
        workspace_revision: result.revision,
        registry_digest: result.registryDigest,
        physics_validation: structuredClone(result.physicsValidation),
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async queryStablePlacement(input: unknown): Promise<WorkspaceAgentResult<QueryStablePlacementData>> {
    try {
      const body = exactRecord(input, ["session_token", "instruction_digest", "candidate"], []);
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:read"]);
      if (!Object.hasOwn(body, "candidate")) {
        throw new WorkspaceEngineError("invalid_request", "candidate is required", { retryable: true });
      }
      const result = await this.engine.queryStablePlacement(body.candidate, principal(session));
      return ok({
        ...publicIdentity(session),
        workspace_id: result.workspaceId,
        workspace_revision: result.revision,
        registry_digest: result.registryDigest,
        stability_check: structuredClone(result.stabilityCheck),
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async simulateWorkspacePhysics(input: unknown): Promise<WorkspaceAgentResult<SimulateWorkspacePhysicsData>> {
    try {
      const body = exactRecord(
        input,
        ["session_token", "instruction_digest", "component_ids", "duration_ms", "time_step_ms"],
        [],
      );
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:read"]);
      let componentIds: string[] | undefined;
      if (body.component_ids !== undefined) {
        if (!Array.isArray(body.component_ids) || body.component_ids.length > 100
          || body.component_ids.some((id) => typeof id !== "string" || !id || id.length > 256)) {
          throw new WorkspaceEngineError("invalid_request", "component_ids must contain at most 100 non-empty IDs", { retryable: true });
        }
        componentIds = [...new Set(body.component_ids as string[])].sort();
      }
      const durationMs = body.duration_ms === undefined
        ? undefined
        : safeInteger(body.duration_ms, "duration_ms", 0, 5_000);
      const timeStepMs = body.time_step_ms === undefined
        ? undefined
        : safeInteger(body.time_step_ms, "time_step_ms", 4, 100);
      const result = await this.engine.simulatePhysics({
        ...(componentIds ? { componentIds } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(timeStepMs === undefined ? {} : { timeStepMs }),
      }, principal(session));
      return ok({
        ...publicIdentity(session),
        workspace_id: result.workspaceId,
        workspace_revision: result.revision,
        registry_digest: result.registryDigest,
        simulation: structuredClone(result.simulation),
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async beginWorkspaceUpdate(input: unknown): Promise<WorkspaceAgentResult<BeginWorkspaceUpdateData>> {
    try {
      this.purgeExpired();
      const body = exactRecord(
        input,
        ["session_token", "instruction_digest", "intent", "requested_component_ids"],
        [],
      );
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:write"]);
      const intent = requiredString(body.intent, "intent", 1, MAX_INTENT_LENGTH).trim();
      if (!intent) throw new WorkspaceEngineError("invalid_request", "intent cannot be blank", { retryable: true });
      const requestedIds = body.requested_component_ids === undefined
        ? DEFAULT_RESERVED_ID_COUNT
        : safeInteger(body.requested_component_ids, "requested_component_ids", 1, MAX_RESERVED_ID_COUNT);
      const prepared = await this.engine.prepare(intent, requestedIds, principal(session));
      if (!validPrepared(prepared)) {
        throw new WorkspaceEngineError("engine_contract_violation", "Workspace core returned an invalid preparation");
      }
      const currentRevision = await this.engine.getRevision();
      const currentRegistryDigest = await this.engine.getRegistryDigest();
      if (
        prepared.envelope.base_workspace_revision !== currentRevision ||
        prepared.envelope.registry_digest !== currentRegistryDigest
      ) {
        throw new WorkspaceEngineError(
          "stale_workspace_revision",
          "Workspace state or component registry changed while the transaction was prepared",
          { retryable: true, requiredAction: "begin_workspace_update" },
        );
      }
      const token = this.randomToken("workspace_tx");
      const expiresAt = this.now() + this.transactionTtlMs;
      this.transactions.set(token, {
        token,
        sessionToken: session.token,
        digest: session.digest,
        prepared: structuredClone(prepared),
        intent,
        expiresAt,
        state: "prepared",
      });
      return ok({
        ...publicIdentity(session),
        instruction_digest: session.digest,
        transaction_token: token,
        transaction_expires_at: new Date(expiresAt).toISOString(),
        intent,
        envelope: structuredClone(prepared.envelope),
        workspace_summary: structuredClone(prepared.workspace_summary),
        capability_manifest: structuredClone(prepared.capability_manifest),
        reserved_component_ids: [...prepared.reserved_component_ids],
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async submitWorkspaceBatch(input: unknown): Promise<WorkspaceAgentResult<SubmitWorkspaceBatchData>> {
    try {
      this.purgeExpired();
      const body = exactRecord(
        input,
        ["session_token", "instruction_digest", "transaction_token", "batch"],
        [],
      );
      const session = this.requireSession(body.session_token, body.instruction_digest);
      const transactionToken = requiredString(body.transaction_token, "transaction_token", 8, 256);
      const transaction = this.transactions.get(transactionToken);
      if (!transaction) {
        throw new WorkspaceEngineError(
          "transaction_not_found",
          "No prepared Workspace transaction matches this token",
          { retryable: true, requiredAction: "begin_workspace_update" },
        );
      }
      if (transaction.sessionToken !== session.token) {
        throw new WorkspaceEngineError("transaction_session_mismatch", "The transaction belongs to another session");
      }
      if (transaction.digest !== session.digest || transaction.digest !== body.instruction_digest) {
        throw new WorkspaceEngineError(
          "instruction_digest_mismatch",
          "The transaction was prepared under a different controller guide",
          { requiredAction: "get_workspace_instructions" },
        );
      }
      if (transaction.state === "expired" || this.now() > transaction.expiresAt) {
        transaction.state = "expired";
        throw new WorkspaceEngineError(
          "transaction_expired",
          "The prepared Workspace transaction expired before submission",
          { retryable: true, requiredAction: "begin_workspace_update" },
        );
      }

      let submissionDigest: string;
      try {
        submissionDigest = await digestWorkspaceAgentValue(body.batch);
      } catch (cause) {
        throw new WorkspaceEngineError(
          "invalid_batch",
          cause instanceof Error ? cause.message : "Workspace batch must be bounded JSON",
          { retryable: true },
        );
      }
      if (transaction.submissionDigest && transaction.submissionDigest !== submissionDigest) {
        throw new WorkspaceEngineError(
          "batch_retry_mismatch",
          "This transaction is already bound to different batch content",
          { requiredAction: "begin_workspace_update" },
        );
      }
      if (transaction.result) return structuredClone(transaction.result);
      if (transaction.submission) return transaction.submission;

      const required = requiredScopesForWorkspaceBatch(body.batch);
      this.requireScopes(session, required, destructiveWorkspaceOperations(body.batch));
      const mismatches = envelopeMismatches(body.batch, transaction.prepared.envelope);
      if (mismatches.length) {
        throw new WorkspaceEngineError(
          "batch_envelope_mismatch",
          "The submitted batch does not match the prepared transaction envelope",
          { retryable: true, requiredAction: "begin_workspace_update", details: { mismatches } },
        );
      }
      const currentRevision = await this.engine.getRevision();
      if (currentRevision !== transaction.prepared.envelope.base_workspace_revision) {
        transaction.state = "expired";
        throw new WorkspaceEngineError(
          "stale_workspace_revision",
          `Prepared revision ${transaction.prepared.envelope.base_workspace_revision} is stale; current revision is ${currentRevision}`,
          { retryable: true, requiredAction: "begin_workspace_update" },
        );
      }
      const registryDigest = await this.engine.getRegistryDigest();
      if (registryDigest !== transaction.prepared.envelope.registry_digest) {
        transaction.state = "expired";
        throw new WorkspaceEngineError(
          "stale_registry_digest",
          "The component registry changed after this transaction was prepared",
          { retryable: true, requiredAction: "begin_workspace_update" },
        );
      }

      transaction.submissionDigest = submissionDigest;
      transaction.state = "submitting";
      const submission = this.executeSubmission(session, transaction, body.batch);
      transaction.submission = submission;
      return submission;
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  async undoWorkspaceBatch(input: unknown): Promise<WorkspaceAgentResult<WorkspaceHistoryData>> {
    return this.mutateHistory("undo", input);
  }

  async redoWorkspaceBatch(input: unknown): Promise<WorkspaceAgentResult<WorkspaceHistoryData>> {
    return this.mutateHistory("redo", input);
  }

  async readWorkspaceEvents(input: unknown): Promise<WorkspaceAgentResult<WorkspaceEventsData>> {
    try {
      const body = exactRecord(
        input,
        ["session_token", "instruction_digest", "after_cursor", "limit"],
        [],
      );
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:read"]);
      const cursor = body.after_cursor === undefined
        ? undefined
        : requiredString(body.after_cursor, "after_cursor", 1, 256);
      const limit = body.limit === undefined ? 50 : safeInteger(body.limit, "limit", 1, MAX_EVENT_LIMIT);
      const page = await this.engine.readEvents(cursor, limit);
      if (!page || !Array.isArray(page.events) || typeof page.nextCursor !== "string" || typeof page.hasMore !== "boolean") {
        throw new WorkspaceEngineError("engine_contract_violation", "Workspace core returned an invalid event page");
      }
      return ok({
        ...publicIdentity(session),
        events: structuredClone(page.events),
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  handleTool(name: WorkspaceAgentToolName, input: unknown): Promise<WorkspaceAgentResult<unknown>> {
    switch (name) {
      case "get_workspace_instructions":
        return this.getWorkspaceInstructions(input);
      case "inspect_workspace":
        return this.inspectWorkspace(input);
      case "inspect_workspace_component":
        return this.inspectWorkspaceComponent(input);
      case "inspect_workspace_space":
        return this.inspectWorkspaceSpace(input);
      case "query_spatial_placement":
        return this.querySpatialPlacement(input);
      case "inspect_workspace_physics":
        return this.inspectWorkspacePhysics(input);
      case "query_stable_placement":
        return this.queryStablePlacement(input);
      case "simulate_workspace_physics":
        return this.simulateWorkspacePhysics(input);
      case "begin_workspace_update":
        return this.beginWorkspaceUpdate(input);
      case "submit_workspace_batch":
        return this.submitWorkspaceBatch(input);
      case "undo_workspace_batch":
        return this.undoWorkspaceBatch(input);
      case "redo_workspace_batch":
        return this.redoWorkspaceBatch(input);
      case "read_workspace_events":
        return this.readWorkspaceEvents(input);
    }
  }

  dispatch(name: unknown, input: unknown): Promise<WorkspaceAgentResult<unknown>> {
    if (!isWorkspaceAgentToolName(name)) {
      return Promise.resolve(fail(agentError("invalid_request", `Unsupported Workspace tool: ${String(name)}`)));
    }
    return this.handleTool(name, input);
  }

  revokeAll(): void {
    this.sessions.clear();
    this.transactions.clear();
  }

  private async executeSubmission(
    session: SessionRecord,
    transaction: TransactionRecord,
    batch: unknown,
  ): Promise<WorkspaceAgentResult<SubmitWorkspaceBatchData>> {
    try {
      const receipt = await this.engine.submit(transaction.prepared, batch, principal(session));
      this.assertReceipt(receipt, transaction.prepared.envelope);
      const data: SubmitWorkspaceBatchData = {
        ...publicIdentity(session),
        transaction_token: transaction.token,
        request_id: receipt.requestId,
        base_workspace_revision: receipt.baseWorkspaceRevision,
        resulting_workspace_revision: receipt.resultingWorkspaceRevision,
        status: receipt.status,
        summary: receipt.summary,
        ...(receipt.delta === undefined ? {} : { delta: structuredClone(receipt.delta) }),
        ...(receipt.resolvedBatch === undefined
          ? {}
          : { resolved_batch: structuredClone(receipt.resolvedBatch) }),
      };
      const result = ok(data);
      transaction.state = "completed";
      transaction.result = result;
      transaction.submission = undefined;
      return structuredClone(result);
    } catch (cause) {
      const error = this.mapError(cause);
      transaction.submission = undefined;
      if (error.code === "command_validation_failed"
        || error.code === "invalid_batch"
        || error.code === "spatial_collision") {
        transaction.state = "prepared";
        transaction.submissionDigest = undefined;
      } else if (error.retryable && error.code === "engine_error") {
        // Keep the digest binding. A lost response may have followed a commit;
        // only an identical retry is safe.
        transaction.state = "prepared";
      } else {
        transaction.state = "expired";
      }
      return fail(error);
    }
  }

  private async mutateHistory(
    action: "undo" | "redo",
    input: unknown,
  ): Promise<WorkspaceAgentResult<WorkspaceHistoryData>> {
    try {
      const body = exactRecord(
        input,
        ["session_token", "instruction_digest", "expected_workspace_revision"],
        [],
      );
      const session = this.requireSession(body.session_token, body.instruction_digest);
      this.requireScopes(session, ["workspace:history"]);
      const expected = safeInteger(
        body.expected_workspace_revision,
        "expected_workspace_revision",
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const current = await this.engine.getRevision();
      if (current !== expected) {
        throw new WorkspaceEngineError(
          "stale_workspace_revision",
          `Expected workspace revision ${expected}; current revision is ${current}`,
          { retryable: true, requiredAction: "inspect_workspace" },
        );
      }
      const receipt: WorkspaceHistoryReceipt = action === "undo"
        ? await this.engine.undo(expected, principal(session))
        : await this.engine.redo(expected, principal(session));
      if (receipt.action !== action || !Number.isSafeInteger(receipt.workspaceRevision)) {
        throw new WorkspaceEngineError("engine_contract_violation", "Workspace core returned an invalid history receipt");
      }
      return ok({
        ...publicIdentity(session),
        action,
        changed: receipt.changed,
        workspace_revision: receipt.workspaceRevision,
        delta: structuredClone(receipt.delta),
      });
    } catch (cause) {
      return fail(this.mapError(cause));
    }
  }

  private requireSession(token: unknown, digest: unknown): SessionRecord {
    this.purgeExpired();
    if (typeof token !== "string" || !token || typeof digest !== "string" || !digest) {
      throw new WorkspaceEngineError(
        "instructions_required",
        "Call get_workspace_instructions, supply its session_token, and set instruction_digest to its returned guide_digest",
        { retryable: true, requiredAction: "get_workspace_instructions" },
      );
    }
    const session = this.sessions.get(token);
    if (!session) {
      throw new WorkspaceEngineError(
        "session_expired",
        "No active Workspace instruction session matches this token",
        { retryable: true, requiredAction: "get_workspace_instructions" },
      );
    }
    if (digest !== session.digest) {
      throw new WorkspaceEngineError(
        "instruction_digest_mismatch",
        "The supplied digest does not match the canonical Workspace guide",
        { requiredAction: "get_workspace_instructions" },
      );
    }
    return session;
  }

  private requireScopes(
    session: SessionRecord,
    required: readonly WorkspacePermissionScope[],
    destructiveOperations: readonly JSONValue[] = [],
  ): void {
    const missing = uniqueScopes(required.filter((scope) => !session.scopes.includes(scope)));
    if (!missing.length) return;
    const destructive = missing.some((scope) =>
      scope === "component:delete" || scope === "connector:delete" || scope === "workspace:clear"
    ) || destructiveOperations.length > 0;
    throw new WorkspaceEngineError(
      destructive ? "destructive_permission_required" : "permission_denied",
      destructive
        ? "This batch contains destructive operations that require explicit user permission"
        : `The instruction session lacks required scopes: ${missing.join(", ")}`,
      {
        requiredAction: "request_user_approval",
        details: {
          missing_scopes: missing,
          ...(destructiveOperations.length ? { destructive_operations: destructiveOperations } : {}),
        },
      },
    );
  }

  private async consistentState(): Promise<WorkspaceStateView> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await this.engine.getState();
      const revision = await this.engine.getRevision();
      if (state.revision === revision) return state;
    }
    throw new WorkspaceEngineError(
      "workspace_busy",
      "Workspace changed during inspection; retry inspection",
      { retryable: true, requiredAction: "inspect_workspace" },
    );
  }

  private async consistentComponentState(
    componentId: string,
    actor: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceComponentStateView> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inspection = await this.engine.inspectComponent(componentId, actor);
      const revision = await this.engine.getRevision();
      const registryDigest = await this.engine.getRegistryDigest();
      if (inspection.revision === revision && inspection.registryDigest === registryDigest) {
        return inspection;
      }
    }
    throw new WorkspaceEngineError(
      "workspace_busy",
      "Workspace changed during component inspection; retry the targeted inspection",
      { retryable: true, requiredAction: "inspect_workspace_component" },
    );
  }

  private assertReceipt(receipt: WorkspaceCommitReceipt, envelope: WorkspacePreparedEnvelope): void {
    if (
      receipt.requestId !== envelope.request_id ||
      receipt.baseWorkspaceRevision !== envelope.base_workspace_revision ||
      !Number.isSafeInteger(receipt.resultingWorkspaceRevision) ||
      receipt.resultingWorkspaceRevision < receipt.baseWorkspaceRevision ||
      !["committed", "approximated", "idempotent"].includes(receipt.status) ||
      typeof receipt.summary !== "string"
    ) {
      throw new WorkspaceEngineError(
        "engine_contract_violation",
        "Workspace core returned a receipt that does not match the prepared transaction",
      );
    }
  }

  private mapError(cause: unknown): WorkspaceAgentError {
    if (cause instanceof WorkspaceEngineError) {
      return agentError(cause.code, cause.message, cause.options);
    }
    return agentError(
      "engine_error",
      cause instanceof Error ? cause.message : "Workspace engine failed",
      { retryable: true },
    );
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (now <= session.expiresAt) continue;
      this.sessions.delete(token);
      for (const [transactionToken, transaction] of this.transactions) {
        if (transaction.sessionToken === token) this.transactions.delete(transactionToken);
      }
    }
    for (const [token, transaction] of this.transactions) {
      if (transaction.state !== "completed" && now > transaction.expiresAt) {
        this.transactions.delete(token);
      }
    }
  }
}
