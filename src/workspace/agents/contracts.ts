/**
 * Transport-neutral contracts for external agents that operate Workspace Protocol.
 *
 * This module intentionally has no React, renderer, MCP, provider, or server imports.
 * Wire-facing DTOs use snake_case; the engine port uses normal TypeScript names.
 */

export const WORKSPACE_PROTOCOL_VERSION = "1.2" as const;
export const WORKSPACE_AGENT_GUIDE_VERSION = "2.5" as const;
/** Final JSON cap for one public inspect_workspace_component result. */
export const WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES = 1_048_576;
export const WORKSPACE_MODEL_INSPECTION_MAX_BYTES = 1_048_576;
/**
 * Reserved for {ok,data}, snake_case key expansion, and maximum escaped
 * client_id/client_name values added by WorkspaceAgentController.
 */
export const WORKSPACE_COMPONENT_INSPECTION_WRAPPER_RESERVE_BYTES = 2_048;

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue =
  | JSONPrimitive
  | { readonly [key: string]: JSONValue }
  | readonly JSONValue[];

export const WORKSPACE_PERMISSION_SCOPES = [
  "workspace:read",
  "workspace:history",
  "workspace:write",
  "component:create",
  "component:update",
  "component:delete",
  "component:invoke",
  "component:recipe_define",
  "connector:write",
  "connector:delete",
  "connector:bind",
  "event:connect",
  "view:present",
  "workspace:clear",
  "effect:data_read",
  "effect:external_write",
  "extension:install",
] as const;

export type WorkspacePermissionScope = typeof WORKSPACE_PERMISSION_SCOPES[number];

export const DEFAULT_WORKSPACE_AGENT_SCOPES = [
  "workspace:read",
  "workspace:write",
  "workspace:history",
  "component:create",
  "component:update",
  "component:recipe_define",
  "component:invoke",
  // These capabilities are required for the standard data-backed and
  // cross-component interaction workflow. They do not grant connector
  // deletion, arbitrary network reads, external writes, or extensions.
  "connector:write",
  "connector:bind",
  "event:connect",
  "view:present",
] as const satisfies readonly WorkspacePermissionScope[];

export const WORKSPACE_AGENT_TOOL_NAMES = [
  "get_workspace_instructions",
  "inspect_workspace",
  "inspect_workspace_component",
  "inspect_workspace_model",
  "inspect_workspace_space",
  "query_spatial_placement",
  "inspect_workspace_physics",
  "query_stable_placement",
  "simulate_workspace_physics",
  "begin_workspace_update",
  "submit_workspace_batch",
  "undo_workspace_batch",
  "redo_workspace_batch",
  "read_workspace_events",
] as const;

export type WorkspaceAgentToolName = typeof WORKSPACE_AGENT_TOOL_NAMES[number];

export type WorkspaceAgentPrincipal = Readonly<{
  sessionId: string;
  clientId: string;
  clientName?: string;
  scopes: readonly WorkspacePermissionScope[];
}>;

export type WorkspacePreparedEnvelope = Readonly<{
  protocol_version: string;
  request_id: string;
  workspace_id: string;
  input_revision: number;
  base_workspace_revision: number;
  registry_digest: string;
  mode: "commit";
}>;

/**
 * A preparation produced by the authoritative Workspace core. The controller
 * retains this exact object and passes it back to submit; clients never supply
 * or reconstruct an engine preparation object.
 */
export type WorkspacePreparedUpdate = Readonly<{
  envelope: WorkspacePreparedEnvelope;
  workspace_summary: JSONValue;
  capability_manifest: JSONValue;
  reserved_component_ids: readonly string[];
}>;

export type WorkspaceStateView = Readonly<{
  workspaceId: string;
  revision: number;
  summary: JSONValue;
  capabilityManifest: JSONValue;
}>;

/**
 * Revision-exact public projection of one component. Identity, geometry, locks,
 * resize policy, and the full pinned public manifest are always present.
 * Oversized public props/state and non-control component metadata may be
 * compacted with explicit truncation and omitted-count metadata. The adapter
 * owns redaction; connector configuration and secret references are never
 * resolved into this view.
 */
export type WorkspaceComponentStateView = Readonly<{
  workspaceId: string;
  revision: number;
  registryDigest: string;
  component: JSONValue;
  pinnedManifest: JSONValue;
  interactionCompatibility: JSONValue;
  eventConnections: JSONValue;
  currentGeometry: JSONValue;
  activeResizePolicy: JSONValue;
  currentVisualEffects: JSONValue;
  visualEffectsPolicy: JSONValue;
  redactedFields: readonly string[];
  stateTruncated: boolean;
  omittedStateBytes: number;
  componentMetadataTruncated: boolean;
  omittedBindingCount: number;
  omittedEventConnectionCount: number;
  omittedTagCount: number;
  omittedRedactedFieldCount: number;
  /** Reserved compatibility flag; full pinned public manifest is always retained. */
  manifestTruncated: false;
}>;

export type WorkspaceModelDefinitionView = Readonly<{
  workspaceId: string;
  revision: number;
  registryDigest: string;
  modelDefinition: JSONValue;
}>;

export type WorkspaceSpatialStateView = Readonly<{
  workspaceId: string;
  revision: number;
  registryDigest: string;
  spatialGraph: JSONValue;
}>;

export type WorkspaceSpatialPlacementView = Readonly<{
  workspaceId: string;
  revision: number;
  registryDigest: string;
  placementCheck: JSONValue;
}>;

export type WorkspacePhysicsStateView = Readonly<{
  workspaceId: string;
  revision: number;
  registryDigest: string;
  physicsValidation: JSONValue;
}>;

export type WorkspacePhysicsPlacementView = Readonly<{
  workspaceId: string;
  revision: number;
  registryDigest: string;
  stabilityCheck: JSONValue;
}>;

export type WorkspacePhysicsSimulationView = Readonly<{
  workspaceId: string;
  revision: number;
  registryDigest: string;
  simulation: JSONValue;
}>;

export type WorkspaceCommitReceipt = Readonly<{
  requestId: string;
  baseWorkspaceRevision: number;
  resultingWorkspaceRevision: number;
  status: "committed" | "approximated" | "idempotent";
  summary: string;
  delta?: JSONValue;
  resolvedBatch?: JSONValue;
}>;

export type WorkspaceHistoryReceipt = Readonly<{
  action: "undo" | "redo";
  changed: boolean;
  workspaceRevision: number;
  delta: JSONValue | null;
}>;

export type WorkspaceEvent = Readonly<{
  id: string;
  cursor: string;
  type: string;
  source: "user" | "agent" | "binding" | "system" | "migration";
  workspaceRevision: number;
  occurredAt: string;
  componentId?: string;
  caused_by_event_id?: string;
  connection_id?: string;
  payload: JSONValue;
}>;

export type WorkspaceEventPage = Readonly<{
  events: readonly WorkspaceEvent[];
  nextCursor: string;
  hasMore: boolean;
}>;

/**
 * Adapter seam implemented by the universal Workspace core.
 *
 * Security is deliberately defense in depth: the controller performs session,
 * revision, registry, obvious operation-scope, and destructive checks. The
 * engine MUST repeat authoritative schema, reference, lock, permission, and
 * effect-class checks because a component action's effects cannot be inferred
 * safely from an untrusted batch alone.
 */
export interface WorkspaceEnginePort {
  getState(): WorkspaceStateView | Promise<WorkspaceStateView>;
  inspectComponent(
    componentId: string,
    principal: WorkspaceAgentPrincipal,
  ): WorkspaceComponentStateView | Promise<WorkspaceComponentStateView>;
  inspectModel(
    modelId: string,
    version: string,
    principal: WorkspaceAgentPrincipal,
  ): WorkspaceModelDefinitionView | Promise<WorkspaceModelDefinitionView>;
  inspectSpace(
    sinceRevision: number | undefined,
    principal: WorkspaceAgentPrincipal,
  ): WorkspaceSpatialStateView | Promise<WorkspaceSpatialStateView>;
  querySpatialPlacement(
    candidate: unknown,
    principal: WorkspaceAgentPrincipal,
  ): WorkspaceSpatialPlacementView | Promise<WorkspaceSpatialPlacementView>;
  inspectPhysics(
    componentIds: readonly string[] | undefined,
    principal: WorkspaceAgentPrincipal,
  ): WorkspacePhysicsStateView | Promise<WorkspacePhysicsStateView>;
  queryStablePlacement(
    candidate: unknown,
    principal: WorkspaceAgentPrincipal,
  ): WorkspacePhysicsPlacementView | Promise<WorkspacePhysicsPlacementView>;
  simulatePhysics(
    options: unknown,
    principal: WorkspaceAgentPrincipal,
  ): WorkspacePhysicsSimulationView | Promise<WorkspacePhysicsSimulationView>;
  getRevision(): number | Promise<number>;
  getRegistryDigest(): string | Promise<string>;
  prepare(
    intent: string,
    requestedIds?: number,
    principal?: WorkspaceAgentPrincipal,
  ): WorkspacePreparedUpdate | Promise<WorkspacePreparedUpdate>;
  submit(
    prepared: WorkspacePreparedUpdate,
    batch: unknown,
    principal: WorkspaceAgentPrincipal,
  ): WorkspaceCommitReceipt | Promise<WorkspaceCommitReceipt>;
  undo(
    expectedRevision: number,
    principal: WorkspaceAgentPrincipal,
  ): WorkspaceHistoryReceipt | Promise<WorkspaceHistoryReceipt>;
  redo(
    expectedRevision: number,
    principal: WorkspaceAgentPrincipal,
  ): WorkspaceHistoryReceipt | Promise<WorkspaceHistoryReceipt>;
  readEvents(cursor: string | undefined, limit: number): WorkspaceEventPage | Promise<WorkspaceEventPage>;
}

export type WorkspaceAgentError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  required_action?: WorkspaceAgentToolName | "request_user_approval";
  details?: JSONValue;
}>;

export type WorkspaceAgentResult<T> =
  | Readonly<{ ok: true; data: T }>
  | Readonly<{ ok: false; error: WorkspaceAgentError }>;

export class WorkspaceEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      retryable?: boolean;
      requiredAction?: WorkspaceAgentError["required_action"];
      details?: JSONValue;
    } = {},
  ) {
    super(message);
    this.name = "WorkspaceEngineError";
  }
}

export function isWorkspacePermissionScope(value: unknown): value is WorkspacePermissionScope {
  return typeof value === "string" &&
    (WORKSPACE_PERMISSION_SCOPES as readonly string[]).includes(value);
}

export function isWorkspaceAgentToolName(value: unknown): value is WorkspaceAgentToolName {
  return typeof value === "string" &&
    (WORKSPACE_AGENT_TOOL_NAMES as readonly string[]).includes(value);
}
