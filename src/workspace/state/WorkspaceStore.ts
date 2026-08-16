import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { DEFAULT_ASSET_REGISTRY } from "../../assets/AssetRegistry";
import {
  ComponentRegistry,
  ComponentRegistryError,
  DEFAULT_COMPONENT_REGISTRY,
  WORKSPACE_BOX_SIZE_MAX,
  WORKSPACE_BOX_SIZE_MIN,
  WORKSPACE_SCALE_MAX,
  WORKSPACE_SCALE_MIN,
} from "../components/ComponentRegistry";
import {
  COMPONENT_VISUAL_EFFECT_LIMITS,
  DEFAULT_DECLARATIVE_COMPONENT_SIZE,
  DEFAULT_COMPONENT_LOCKS,
  DEFAULT_COMPONENT_VISUAL_EFFECTS,
  type ComponentInstance,
  type ComponentActionManifest,
  type ComponentManifest,
  type ComponentPlacement,
  type ComponentRecipe,
  type ComponentResize,
  type ComponentResizePolicy,
  type ComponentVisualEffects,
  type JSONSchema,
  type JSONObject,
  type JSONValue,
  resizePolicyForPlacement,
} from "../components/componentTypes";
import { stableStringify } from "../components/manifestDigest";
import { resolveWebPanelSource } from "../components/webPanelSecurity";
import {
  assertWorkspaceResourceAgentWriteSafe,
  assertWorkspaceResourceSafe,
  normalizeInlineSnapshotResource,
  WorkspaceResourceValidationError,
} from "../data/resourceSecurity";
import { resolveWorkspaceResourceBindings } from "../data/bindingResolver";
import type { EventConnection, ResourceBinding, WorkspaceConnection } from "../data/dataTypes";
import {
  resolveComponentAction,
  type ActionEventDraft,
} from "../runtime/componentActions";
import {
  findBlockingSpatialCollisions,
  MAX_WORKSPACE_SPATIAL_NODES,
  spatialCollisionConfigFromProps,
  type SpatialCollisionConflict,
} from "../spatial";
import {
  enforcedPhysicsIssues,
  spatialPhysicsConfigFromProps,
  type PhysicsIssue,
} from "../physics";
import {
  LEGACY_WORKSPACE_PROTOCOL_VERSION,
  LEGACY_WORKSPACE_SCHEMA_VERSION,
  MAX_WORKSPACE_OPERATIONS,
  PREVIOUS_WORKSPACE_PROTOCOL_VERSION,
  PREVIOUS_WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_PROTOCOL_VERSION,
  WORKSPACE_SCHEMA_VERSION,
  type WorkspaceActor,
  type WorkspaceAuthorization,
  type WorkspaceCommandBatch,
  type WorkspaceCommandRecord,
  type WorkspaceDelta,
  type WorkspaceEvent,
  type WorkspaceOperation,
  type WorkspacePermission,
  type TransitionSpec,
} from "../protocol/workspaceTypes";
import {
  validateComponentRecipe,
  validateWorkspaceCommandBatch,
} from "../protocol/validateWorkspaceBatch";
import { createInitialWorkspace } from "./createInitialWorkspace";
import type { WorkspaceState } from "./workspaceState";
import {
  buildEffectiveRegistry,
  cloneWorkspaceState,
  ComponentIdAllocator,
  computeWorkspaceDelta,
  validateWorkspaceGraphs,
} from "./workspaceUtils";
import {
  MAX_WORKSPACE_ALIASES,
  MAX_WORKSPACE_COMPONENTS,
  MAX_WORKSPACE_CONNECTIONS,
  MAX_WORKSPACE_HISTORY_SUMMARIES,
  MAX_WORKSPACE_IDEMPOTENCY_ENTRIES,
  MAX_WORKSPACE_RECIPES,
  MAX_WORKSPACE_RESOURCES,
  MAX_WORKSPACE_SHARED_VIEWS,
  MAX_WORKSPACE_UNDO_ENTRIES,
} from "./workspaceLimits";

export class WorkspaceStoreError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WorkspaceStoreError";
  }
}

export class SpatialCollisionStoreError extends WorkspaceStoreError {
  constructor(readonly conflicts: readonly SpatialCollisionConflict[]) {
    const first = conflicts[0]!;
    super(
      `Spatial collision: ${first.componentId} intersects ${first.conflictsWith}`,
      "spatial_collision",
    );
    this.name = "SpatialCollisionStoreError";
  }
}

export class PhysicsValidationStoreError extends WorkspaceStoreError {
  constructor(readonly issues: readonly PhysicsIssue[]) {
    const first = issues[0]!;
    super(
      `Physics validation: ${first.message}`,
      "physics_validation_failed",
    );
    this.name = "PhysicsValidationStoreError";
  }
}

export class StaleWorkspaceRevisionError extends WorkspaceStoreError {
  constructor(readonly expected: number, readonly received: number) {
    super(`Stale workspace revision: current=${expected}, batch base=${received}`, "stale_workspace_revision");
    this.name = "StaleWorkspaceRevisionError";
  }
}

export class StaleRegistryDigestError extends WorkspaceStoreError {
  constructor(readonly expected: string, readonly received: string) {
    super(`Stale registry digest: current=${expected}, batch registry=${received}`, "stale_registry_digest");
    this.name = "StaleRegistryDigestError";
  }
}

export class WorkspacePermissionError extends WorkspaceStoreError {
  constructor(readonly permission: string) {
    super(`Missing workspace permission: ${permission}`, "permission_denied");
    this.name = "WorkspacePermissionError";
  }
}

export type WorkspaceCommitResult = {
  delta: WorkspaceDelta;
  state: Readonly<WorkspaceState>;
  deduplicated: boolean;
  command: WorkspaceCommandRecord;
  events: WorkspaceEvent[];
};

export type WorkspaceStoreOptions = {
  initialState?: WorkspaceState;
  checkpointState?: WorkspaceState;
  registry?: ComponentRegistry;
  nextComponentSequence?: number;
  checkpointNextComponentSequence?: number;
  nextEventCursor?: number;
  checkpointNextEventCursor?: number;
  commandHistory?: WorkspaceCommandRecord[];
  clock?: () => number;
};

export type WorkspaceStoreListener = (
  state: Readonly<WorkspaceState>,
  delta: WorkspaceDelta,
  events: readonly WorkspaceEvent[],
) => void;

type CommittedRequest = {
  fingerprint: string;
  delta: WorkspaceDelta;
  command: WorkspaceCommandRecord;
  events: WorkspaceEvent[];
};

type HistoryEntry = {
  requestId: string;
  fingerprint: string;
  before: WorkspaceState;
  after: WorkspaceState;
  delta: WorkspaceDelta;
  command: WorkspaceCommandRecord;
  events: WorkspaceEvent[];
  nextComponentSequence: number;
  nextEventCursor: number;
};

type ResolvedActionEffect = NonNullable<WorkspaceCommandRecord["resolvedActionEffects"]>[number];
type EventCausation = NonNullable<WorkspaceEvent["causedBy"]>;

/** Bounds explicit and connection-routed actions inside one atomic revision. */
export const MAX_ACTION_EFFECTS_PER_COMMIT = 100;

const TRUSTED_USER: WorkspaceAuthorization = { actor: "user", permissions: ["*"] };
const domainAjv = new Ajv2020({ allErrors: true, strict: false, strictNumbers: true });
const WORKSPACE_SPATIAL_ENTITY_KINDS = new Set([
  "character",
  "animal",
  "prop",
  "structure",
  "effect",
  "primitive",
]);

function isWorkspaceSpatialEntityKind(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_SPATIAL_ENTITY_KINDS.has(value);
}

function assertSchemaValue(schema: Readonly<Record<string, unknown>>, value: unknown, context: string): void {
  const validate: ValidateFunction = domainAjv.compile(structuredClone(schema));
  if (!validate(value)) {
    throw new WorkspaceStoreError(
      `${context}: ${domainAjv.errorsText(validate.errors)}`,
      "schema_validation_failed",
    );
  }
}

function hasPermission(authorization: WorkspaceAuthorization, permission: string): boolean {
  return authorization.permissions.includes("*") || authorization.permissions.includes(permission as WorkspacePermission);
}

function requirePermission(authorization: WorkspaceAuthorization, permission: string): void {
  if (!hasPermission(authorization, permission)) throw new WorkspacePermissionError(permission);
}

function assertRoutableEffectClass(action: ComponentActionManifest, context: string): void {
  if (action.routable === false) {
    throw new WorkspaceStoreError(
      `${context} targets a host-only action that cannot be event-routed`,
      "event_action_not_routable",
    );
  }
  if (action.effectClass !== "none" && action.effectClass !== "semantic") {
    throw new WorkspaceStoreError(
      `${context} cannot route ${action.effectClass} effects`,
      "event_effect_not_allowed",
    );
  }
}

function assertRoutableActionAuthorized(
  action: ComponentActionManifest,
  authorization: WorkspaceAuthorization,
  context: string,
): void {
  assertRoutableEffectClass(action, context);
  requirePermission(authorization, "component:invoke");
  for (const permission of action.requiredPermissions ?? []) {
    requirePermission(authorization, permission);
  }
}

function assertEventConnectionTransition(transition: TransitionSpec | undefined, context: string): void {
  if (!transition) return;
  const keys = Object.keys(transition);
  if (keys.some((key) => key !== "durationMs" && key !== "delayMs" && key !== "easing")
    || !Number.isSafeInteger(transition.durationMs)
    || transition.durationMs < 0
    || transition.durationMs > 60_000
    || (transition.delayMs !== undefined && (
      !Number.isSafeInteger(transition.delayMs) || transition.delayMs < 0 || transition.delayMs > 60_000
    ))
    || !["linear", "ease_in", "ease_out", "ease_in_out"].includes(transition.easing)) {
    throw new WorkspaceStoreError(`${context} has an invalid transition`, "invalid_transition");
  }
}

function assertEventConnectionInputContract(
  connection: EventConnection,
  sourceEventSchema: JSONSchema,
  targetAction: ComponentActionManifest,
  context: string,
): void {
  const inputMode = connection.inputMode ?? "static";
  if (inputMode !== "static" && inputMode !== "event_payload") {
    throw new WorkspaceStoreError(`${context} has an invalid input mode`, "invalid_event_input_mode");
  }
  if (inputMode === "event_payload") {
    if (connection.input !== undefined) {
      throw new WorkspaceStoreError(
        `${context} cannot combine static input with event-payload forwarding`,
        "event_input_mode_conflict",
      );
    }
    // Exact schema identity is intentionally conservative: it statically
    // proves every validated source payload is valid target input without an
    // expression evaluator or partial-schema/subsumption ambiguity.
    if (stableStringify(sourceEventSchema) !== stableStringify(targetAction.inputSchema)) {
      throw new WorkspaceStoreError(
        `${context} requires identical source-event and target-action schemas for event-payload forwarding`,
        "event_payload_schema_mismatch",
      );
    }
    return;
  }
  assertSchemaValue(
    targetAction.inputSchema,
    connection.input ?? {},
    `${context} has invalid static action input`,
  );
}

function operationPermission(operation: WorkspaceOperation): WorkspacePermission {
  switch (operation.op) {
    case "define_component_recipe": return "component:recipe_define";
    case "create_component": return "component:create";
    case "update_component":
    case "upgrade_component_manifest":
    case "place_component":
    case "resize_component":
    case "set_component_visual_effects":
    case "attach_component":
    case "detach_component": return "component:update";
    case "delete_component": return "component:delete";
    case "invoke_component_action": return "component:invoke";
    case "upsert_resource": return "connector:write";
    case "delete_resource": return "connector:delete";
    case "bind_resource":
    case "unbind_resource": return "connector:bind";
    case "connect_event":
    case "disconnect_event": return "event:connect";
    case "present_view": return "view:present";
    case "clear_workspace": return "workspace:clear";
  }
}

function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return structuredClone(entry);
}

function isUserUndoEntry(entry: HistoryEntry): boolean {
  return entry.command.actor !== "system";
}

/**
 * Host-feed snapshots are independent observations of external public data.
 * Unlike timer settlement, they do not derive from the latest user command and
 * must not disappear merely because an unrelated component edit is undone.
 */
function independentFeedObservationResourceIds(entry: HistoryEntry): ReadonlySet<string> | null {
  if (entry.command.actor !== "system" || entry.command.resolvedOperations.length === 0) return null;
  const resourceIds = new Set<string>();
  for (const operation of entry.command.resolvedOperations) {
    if (operation.op !== "upsert_resource"
      || operation.resource.connectorType !== "http.feed"
      || operation.resource.connectorVersion !== "1.0.0") return null;
    resourceIds.add(operation.resource.id);
  }
  return resourceIds;
}

function commandTouchesObservedFeed(
  target: HistoryEntry,
  resourceIds: ReadonlySet<string>,
): boolean {
  for (const operation of target.command.resolvedOperations) {
    if (operation.op === "clear_workspace" && operation.include_resources) return true;
    if (operation.op === "upsert_resource" && resourceIds.has(operation.resource.id)) return true;
    if (operation.op === "delete_resource" && resourceIds.has(operation.resource_id)) return true;
    if (operation.op === "bind_resource" && resourceIds.has(operation.binding.resourceId)) return true;
    if (operation.op === "unbind_resource") {
      const connection = target.before.connections.get(operation.binding_id)
        ?? target.after.connections.get(operation.binding_id);
      if (connection?.kind === "resource_binding" && resourceIds.has(connection.resourceId)) return true;
    }
  }
  return false;
}

function defaultLabel(manifest: ComponentManifest, id: string): string {
  return `${manifest.displayName} ${id}`;
}

function assertSpatialAssetProps(manifest: ComponentManifest, props: JSONObject): void {
  if (manifest.typeId !== "spatial-entity") return;
  const assetId = props.assetId;
  const entityKind = props.entityKind;
  const asset = typeof assetId === "string" ? DEFAULT_ASSET_REGISTRY.get(assetId) : null;
  if (!asset) {
    throw new WorkspaceStoreError(
      `Unknown spatial assetId ${String(assetId)}`,
      "unknown_asset",
    );
  }
  if (!isWorkspaceSpatialEntityKind(entityKind) || asset.kind !== entityKind) {
    throw new WorkspaceStoreError(
      `Asset ${asset.assetId} has kind ${asset.kind}; spatial entity declares ${String(entityKind)}`,
      "asset_kind_mismatch",
    );
  }
}

function normalizeWebPanelProps(manifest: ComponentManifest, props: JSONObject): void {
  if (manifest.typeId !== "web-panel") return;
  const source = resolveWebPanelSource(typeof props.sourceUrl === "string" ? props.sourceUrl : "");
  if (!source.ok) {
    throw new WorkspaceStoreError(source.reason, "invalid_web_panel_source");
  }
  props.sourceUrl = source.normalizedUrl;
}

function placementTarget(placement: ComponentPlacement): string | undefined {
  return placement.space === "surface" || placement.space === "billboard"
    ? placement.targetId
    : undefined;
}

function placementRequiresStage(placement: ComponentPlacement): boolean {
  return placement.space === "world3d"
    || placement.space === "surface"
    || placement.space === "billboard";
}

function stageComponent(state: WorkspaceState): ComponentInstance | undefined {
  return [...state.components.values()].find((component) => component.type.typeId === "stage-3d");
}

function isPlayingSpatialComponent(component: ComponentInstance): boolean {
  if (component.type.typeId !== "spatial-entity") return false;
  const playback = component.durableState.playback;
  return Boolean(playback && typeof playback === "object" && !Array.isArray(playback)
    && (playback as Record<string, unknown>).playing === true);
}

function visibilityMutationTarget(operation: WorkspaceOperation): string | undefined {
  if (operation.op === "create_component") return operation.id;
  if (operation.op === "upgrade_component_manifest") return operation.id;
  if (operation.op === "update_component" && operation.patch.visibility !== undefined) return operation.id;
  if (
    operation.op === "invoke_component_action"
    && (operation.action === "show" || operation.action === "hide" || operation.action === "toggle_visibility")
  ) return operation.id;
  return undefined;
}

function visibilityCancellationTargets(
  state: WorkspaceState,
  operation: WorkspaceOperation,
): ComponentInstance[] {
  const targetId = visibilityMutationTarget(operation);
  if (!targetId) return [];
  const target = state.components.get(targetId);
  if (!target) return [];
  if (target.type.typeId === "spatial-entity") {
    const stage = stageComponent(state);
    return isPlayingSpatialComponent(target)
      && (target.visibility !== "visible" || !stage || stage.visibility !== "visible")
      ? [target]
      : [];
  }
  if (target.type.typeId !== "stage-3d" || target.visibility === "visible") return [];
  return [...state.components.values()]
    .filter(isPlayingSpatialComponent)
    .sort((left, right) => left.id.localeCompare(right.id));
}

const VISIBILITY_STOP_OPERATION_PREFIX = "host_visibility_stop:";

function isVisibilityStopOperation(operation: WorkspaceOperation): boolean {
  return operation.op === "invoke_component_action"
    && operation.action === "stop_animation"
    && operation.op_id.startsWith(VISIBILITY_STOP_OPERATION_PREFIX);
}

function recipeKey(recipe: Pick<ComponentRecipe, "typeId" | "version">): string {
  return `${recipe.typeId}@${recipe.version}`;
}

function fingerprintBatch(batch: WorkspaceCommandBatch): string {
  // Compatible protocol versions encode their shared operations identically. Treat
  // a legacy retry of an already-loaded command as the same idempotency key.
  return stableStringify({ ...batch, protocol_version: WORKSPACE_PROTOCOL_VERSION });
}

function assertComponentVisualEffects(value: ComponentVisualEffects): void {
  const assertRange = (candidate: number, min: number, max: number, path: string) => {
    if (!Number.isFinite(candidate) || candidate < min || candidate > max) {
      throw new WorkspaceStoreError(`${path} must be between ${min} and ${max}`, "visual_effect_out_of_bounds");
    }
  };
  const assertColor = (candidate: string, path: string) => {
    if (!/^#[0-9A-F]{6}$/iu.test(candidate)) {
      throw new WorkspaceStoreError(`${path} must be a six-digit hex color`, "invalid_visual_effect_color");
    }
  };
  assertRange(value.opacity, COMPONENT_VISUAL_EFFECT_LIMITS.opacity.min, COMPONENT_VISUAL_EFFECT_LIMITS.opacity.max, "visual_effects.opacity");
  assertColor(value.emissive.color, "visual_effects.emissive.color");
  assertRange(value.emissive.intensity, COMPONENT_VISUAL_EFFECT_LIMITS.emissiveIntensity.min, COMPONENT_VISUAL_EFFECT_LIMITS.emissiveIntensity.max, "visual_effects.emissive.intensity");
  assertColor(value.glow.color, "visual_effects.glow.color");
  assertRange(value.glow.intensity, COMPONENT_VISUAL_EFFECT_LIMITS.glowIntensity.min, COMPONENT_VISUAL_EFFECT_LIMITS.glowIntensity.max, "visual_effects.glow.intensity");
  assertRange(value.glow.spread, COMPONENT_VISUAL_EFFECT_LIMITS.glowSpread.min, COMPONENT_VISUAL_EFFECT_LIMITS.glowSpread.max, "visual_effects.glow.spread");
}

function loadedCommandFingerprint(command: WorkspaceCommandRecord, workspaceId: string): string {
  return fingerprintBatch({
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    request_id: command.requestId,
    workspace_id: workspaceId,
    input_revision: command.inputRevision,
    base_workspace_revision: command.baseWorkspaceRevision,
    registry_digest: command.inputRegistryDigest,
    mode: "commit",
    operations: structuredClone(command.resolvedOperations),
  });
}

function validateLegacyHistoryExecution(
  batch: WorkspaceCommandBatch,
  operations: readonly WorkspaceOperation[],
): WorkspaceOperation[] {
  // A locked legacy Stage update can expand to unlock, resize, and restore.
  // Validate generated execution in normal protocol-sized slices while the
  // original, persisted command remains subject to the public 100-op limit.
  if (!operations.length || operations.length > MAX_WORKSPACE_OPERATIONS * 3) {
    throw new WorkspaceStoreError(
      `Legacy history expands beyond ${MAX_WORKSPACE_OPERATIONS * 3} internal operations`,
      "invalid_legacy_history",
    );
  }
  const validated: WorkspaceOperation[] = [];
  const operationIds = new Set<string>();
  for (let start = 0; start < operations.length; start += MAX_WORKSPACE_OPERATIONS) {
    const slice = validateWorkspaceCommandBatch({
      ...structuredClone(batch),
      operations: structuredClone(operations.slice(start, start + MAX_WORKSPACE_OPERATIONS)),
    });
    for (const operation of slice.operations) {
      if (operationIds.has(operation.op_id)) {
        throw new WorkspaceStoreError(
          `Duplicate legacy execution op_id ${operation.op_id}`,
          "duplicate_operation_id",
        );
      }
      operationIds.add(operation.op_id);
      validated.push(operation);
    }
  }
  return validated;
}

function assertSafeTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceStoreError(`Invalid engine effective time ${value}`, "invalid_effective_time");
  }
  return value;
}

const RESIZE_EPSILON = 1e-6;
const IDENTITY_WORLD_SCALE = Object.freeze({ x: 1, y: 1, z: 1 });

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= RESIZE_EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function isIdentityWorldScale(scale: { x: number; y: number; z: number }): boolean {
  return nearlyEqual(scale.x, 1) && nearlyEqual(scale.y, 1) && nearlyEqual(scale.z, 1);
}

function assertFiniteBounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new WorkspaceStoreError(
      `${label} must be finite and between ${minimum} and ${maximum}; received ${value}`,
      "resize_out_of_bounds",
    );
  }
}

function resizeKindMismatch(policy: ComponentResizePolicy, resize: ComponentResize): never {
  throw new WorkspaceStoreError(
    `Resize kind ${resize.kind} does not match ${policy.kind}`,
    "resize_kind_mismatch",
  );
}

function assertResizeValue(
  policy: ComponentResizePolicy,
  resize: ComponentResize,
  current?: ComponentResize,
): void {
  if (policy.kind === "none") {
    throw new WorkspaceStoreError("Component is not resizable in its current placement", "resize_not_supported");
  }
  if (policy.kind !== resize.kind) resizeKindMismatch(policy, resize);

  if (policy.kind === "box2d" && resize.kind === "box2d") {
    assertFiniteBounded(resize.size.width, policy.minSize.width, policy.maxSize.width, "width");
    assertFiniteBounded(resize.size.height, policy.minSize.height, policy.maxSize.height, "height");
    if (current?.kind === "box2d") {
      for (const axis of ["width", "height"] as const) {
        if (!policy.allowedAxes.includes(axis) && !nearlyEqual(resize.size[axis], current.size[axis])) {
          throw new WorkspaceStoreError(`Resize axis ${axis} is not allowed`, "resize_constraint_violation");
        }
      }
    }
    if (policy.mode === "aspect_locked") {
      const expected = policy.aspectRatio;
      if (!expected || !Number.isFinite(expected) || !nearlyEqual(resize.size.width / resize.size.height, expected)) {
        throw new WorkspaceStoreError(
          `Resize must preserve aspect ratio ${expected ?? "declared by the manifest"}`,
          "resize_constraint_violation",
        );
      }
    }
    return;
  }

  if (policy.kind === "scale3d" && resize.kind === "scale3d") {
    for (const axis of ["x", "y", "z"] as const) {
      assertFiniteBounded(resize.scale[axis], policy.minScale[axis], policy.maxScale[axis], `scale.${axis}`);
      if (
        current?.kind === "scale3d"
        && !policy.allowedAxes.includes(axis)
        && !nearlyEqual(resize.scale[axis], current.scale[axis])
      ) {
        throw new WorkspaceStoreError(`Resize axis ${axis} is not allowed`, "resize_constraint_violation");
      }
    }
    if (
      policy.mode === "uniform"
      && (!nearlyEqual(resize.scale.x, resize.scale.y) || !nearlyEqual(resize.scale.y, resize.scale.z))
    ) {
      throw new WorkspaceStoreError("Resize must preserve uniform 3D scale", "resize_constraint_violation");
    }
    return;
  }

  if (policy.kind === "stage_dimensions" && resize.kind === "stage_dimensions") {
    for (const axis of ["width", "height", "depth"] as const) {
      assertFiniteBounded(
        resize.dimensions[axis],
        policy.minDimensions[axis],
        policy.maxDimensions[axis],
        `dimensions.${axis}`,
      );
      if (
        current?.kind === "stage_dimensions"
        && !policy.allowedAxes.includes(axis)
        && !nearlyEqual(resize.dimensions[axis], current.dimensions[axis])
      ) {
        throw new WorkspaceStoreError(`Resize axis ${axis} is not allowed`, "resize_constraint_violation");
      }
    }
    if (
      policy.mode === "uniform"
      && (!nearlyEqual(resize.dimensions.width, resize.dimensions.height)
        || !nearlyEqual(resize.dimensions.height, resize.dimensions.depth))
    ) {
      throw new WorkspaceStoreError("Resize must preserve uniform stage dimensions", "resize_constraint_violation");
    }
    return;
  }

  resizeKindMismatch(policy, resize);
}

function stageDimensions(component: ComponentInstance): ComponentResize | undefined {
  const dimensions = component.props.dimensions;
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) return undefined;
  const record = dimensions as Record<string, JSONValue>;
  if (
    typeof record.width !== "number"
    || typeof record.height !== "number"
    || typeof record.depth !== "number"
  ) return undefined;
  return {
    kind: "stage_dimensions",
    dimensions: { width: record.width, height: record.height, depth: record.depth },
  };
}

function componentResizeValue(
  component: ComponentInstance,
  policy: ComponentResizePolicy,
): ComponentResize | undefined {
  if (policy.kind === "none") return undefined;
  if (policy.kind === "box2d") {
    const size = component.placement.size;
    return size ? { kind: "box2d", size: structuredClone(size) } : undefined;
  }
  if (policy.kind === "scale3d") {
    return component.placement.space === "world3d"
      ? { kind: "scale3d", scale: structuredClone(component.placement.scale) }
      : undefined;
  }
  return stageDimensions(component);
}

type ComponentGeometrySnapshot = {
  canonical: ComponentResize | null;
  rawSize: { width: number; height: number } | null;
  rawWorldScale: { x: number; y: number; z: number };
};

function componentGeometrySnapshot(
  component: ComponentInstance,
  policy: ComponentResizePolicy,
): ComponentGeometrySnapshot {
  return {
    canonical: policy.kind === "none" ? null : componentResizeValue(component, policy) ?? null,
    rawSize: component.placement.size ? structuredClone(component.placement.size) : null,
    rawWorldScale: component.placement.space === "world3d"
      ? structuredClone(component.placement.scale)
      : structuredClone(IDENTITY_WORLD_SCALE),
  };
}

function resizePoliciesEqual(
  left: ComponentResizePolicy,
  right: ComponentResizePolicy,
): boolean {
  const canonical = (policy: ComponentResizePolicy): ComponentResizePolicy => {
    if (policy.kind === "none") return structuredClone(policy);
    return {
      ...structuredClone(policy),
      allowedAxes: [...policy.allowedAxes].sort() as never,
    };
  };
  return stableStringify(canonical(left)) === stableStringify(canonical(right));
}

function defaultResizeValue(policy: ComponentResizePolicy): ComponentResize | undefined {
  if (policy.kind === "box2d") return { kind: "box2d", size: structuredClone(policy.defaultSize) };
  if (policy.kind === "scale3d") return { kind: "scale3d", scale: structuredClone(policy.defaultScale) };
  if (policy.kind === "stage_dimensions") {
    return { kind: "stage_dimensions", dimensions: structuredClone(policy.defaultDimensions) };
  }
  return undefined;
}

function materializePlacementGeometry(
  manifest: ComponentManifest,
  placement: ComponentPlacement,
  prior?: ComponentInstance,
): ComponentPlacement {
  const resolved = structuredClone(placement);
  const policy = resizePolicyForPlacement(manifest, resolved);
  const priorPolicy = prior ? resizePolicyForPlacement(manifest, prior.placement) : undefined;
  const policyChanged = priorPolicy ? !resizePoliciesEqual(priorPolicy, policy) : false;
  if (prior && policyChanged) {
    if (policy.kind === "box2d") {
      resolved.size = structuredClone(policy.defaultSize);
    } else if (policy.kind === "none") {
      if (prior.placement.size) resolved.size = structuredClone(prior.placement.size);
      else delete resolved.size;
    } else if (policy.kind === "scale3d" && resolved.space === "world3d") {
      resolved.scale = structuredClone(policy.defaultScale);
      delete resolved.size;
    }
    return resolved;
  }
  if (policy.kind === "box2d" && !resolved.size) {
    const priorSize = prior && priorPolicy?.kind === "box2d"
      ? prior.placement.size
      : undefined;
    resolved.size = structuredClone(priorSize ?? policy.defaultSize);
  } else if (policy.kind === "none" && prior?.placement.size && !resolved.size) {
    // A fixed component retains its authored box while it moves. A transition
    // from a resizable placement to a fixed placement freezes the prior box.
    resolved.size = structuredClone(prior.placement.size);
  } else if (policy.kind === "none" && manifest.trustTier === "declarative" && !resolved.size) {
    // Fixed declarative components still need authored DOM geometry. Persist
    // the projection's generic intrinsic size so Store, inspection, replay,
    // and rendering all report the same box.
    resolved.size = structuredClone(DEFAULT_DECLARATIVE_COMPONENT_SIZE);
  }
  return resolved;
}

function normalizeLegacyPlacementGeometry(
  manifest: ComponentManifest,
  placement: ComponentPlacement,
): ComponentPlacement {
  const resolved = structuredClone(placement);
  const policy = resizePolicyForPlacement(manifest, resolved);
  if (policy.kind === "box2d") {
    const size = resolved.size ?? policy.defaultSize;
    resolved.size = {
      width: Math.min(policy.maxSize.width, Math.max(policy.minSize.width, size.width)),
      height: Math.min(policy.maxSize.height, Math.max(policy.minSize.height, size.height)),
    };
  } else if (policy.kind === "scale3d" && resolved.space === "world3d") {
    resolved.scale = {
      x: Math.min(policy.maxScale.x, Math.max(policy.minScale.x, resolved.scale.x)),
      y: Math.min(policy.maxScale.y, Math.max(policy.minScale.y, resolved.scale.y)),
      z: Math.min(policy.maxScale.z, Math.max(policy.minScale.z, resolved.scale.z)),
    };
    delete resolved.size;
  }
  return resolved;
}

function explicitPlacementGeometryMatches(
  supplied: ComponentPlacement,
  resolved: ComponentPlacement,
): boolean {
  if (supplied.size) {
    if (
      !resolved.size
      || !nearlyEqual(supplied.size.width, resolved.size.width)
      || !nearlyEqual(supplied.size.height, resolved.size.height)
    ) return false;
  }
  if (supplied.space === "world3d" && resolved.space === "world3d") {
    return nearlyEqual(supplied.scale.x, resolved.scale.x)
      && nearlyEqual(supplied.scale.y, resolved.scale.y)
      && nearlyEqual(supplied.scale.z, resolved.scale.z);
  }
  return true;
}

function materializeStageDimensions(
  manifest: ComponentManifest,
  placement: ComponentPlacement,
  props: JSONObject,
): JSONObject {
  const resolved = structuredClone(props);
  const policy = resizePolicyForPlacement(manifest, placement);
  if (policy.kind === "stage_dimensions" && resolved.dimensions === undefined) {
    resolved.dimensions = structuredClone(policy.defaultDimensions);
  }
  return resolved;
}

function assertComponentResizeGeometry(
  component: ComponentInstance,
  manifest: ComponentManifest,
  compareWithDefault = false,
): void {
  const policy = resizePolicyForPlacement(manifest, component.placement);
  if (component.placement.space === "world3d") {
    if (policy.kind === "scale3d") {
      if (component.placement.size) {
        throw new WorkspaceStoreError(
          "scale3d components cannot carry an independent placement size",
          "noncanonical_component_geometry",
        );
      }
    } else if (!isIdentityWorldScale(component.placement.scale)) {
      throw new WorkspaceStoreError(
        `${policy.kind} components must keep world3d placement scale at identity`,
        "noncanonical_component_geometry",
      );
    }
    if (policy.kind === "stage_dimensions" && component.placement.size) {
      throw new WorkspaceStoreError(
        "3D Stage cannot carry an independent placement size",
        "noncanonical_component_geometry",
      );
    }
  }
  if (policy.kind === "none") {
    if (manifest.trustTier === "declarative") {
      const size = component.placement.size;
      if (
        !size
        || !Number.isFinite(size.width)
        || !Number.isFinite(size.height)
        || size.width < WORKSPACE_BOX_SIZE_MIN
        || size.height < WORKSPACE_BOX_SIZE_MIN
        || size.width > WORKSPACE_BOX_SIZE_MAX
        || size.height > WORKSPACE_BOX_SIZE_MAX
      ) {
        throw new WorkspaceStoreError(
          `Fixed declarative component ${component.id} is missing bounded authored geometry`,
          "invalid_component_size",
        );
      }
    }
    return;
  }
  const geometry = componentResizeValue(component, policy);
  if (!geometry) {
    throw new WorkspaceStoreError(
      `Component ${component.id} is missing explicit ${policy.kind} geometry`,
      "invalid_component_size",
    );
  }
  assertResizeValue(policy, geometry, compareWithDefault ? defaultResizeValue(policy) : undefined);
}

/**
 * Deterministic in-memory migration for 1.0 project snapshots. Pinned 1.0
 * built-in references remain unchanged; the serializer repins pre-resize
 * declarative recipes before this state pass. The 1.1 registry then exposes
 * host-owned compatibility policies while this pass materializes canonical
 * geometry and the resize lock for stable command replay.
 */
export function migrateWorkspaceStateToCurrent(
  input: WorkspaceState,
  baseRegistry: ComponentRegistry = DEFAULT_COMPONENT_REGISTRY,
): WorkspaceState {
  const isLegacyInput = input.protocolVersion === LEGACY_WORKSPACE_PROTOCOL_VERSION
    && input.workspaceSchemaVersion === LEGACY_WORKSPACE_SCHEMA_VERSION;
  if (
    input.protocolVersion !== LEGACY_WORKSPACE_PROTOCOL_VERSION
    && input.protocolVersion !== PREVIOUS_WORKSPACE_PROTOCOL_VERSION
    && input.protocolVersion !== WORKSPACE_PROTOCOL_VERSION
  ) {
    throw new WorkspaceStoreError(
      `Unsupported workspace protocol ${String(input.protocolVersion)}`,
      "protocol_version_mismatch",
    );
  }
  if (
    input.workspaceSchemaVersion !== LEGACY_WORKSPACE_SCHEMA_VERSION
    && input.workspaceSchemaVersion !== PREVIOUS_WORKSPACE_SCHEMA_VERSION
    && input.workspaceSchemaVersion !== WORKSPACE_SCHEMA_VERSION
  ) {
    throw new WorkspaceStoreError(
      `Unsupported workspace schema ${String(input.workspaceSchemaVersion)}`,
      "schema_version_mismatch",
    );
  }
  if (input.protocolVersion !== input.workspaceSchemaVersion) {
    throw new WorkspaceStoreError(
      `Workspace protocol ${input.protocolVersion} and schema ${input.workspaceSchemaVersion} do not match`,
      "schema_version_mismatch",
    );
  }
  const state = cloneWorkspaceState(input);
  const registry = buildEffectiveRegistry(baseRegistry, state.recipes);
  for (const component of state.components.values()) {
    component.locks = { ...DEFAULT_COMPONENT_LOCKS, ...component.locks };
    component.visualEffects = structuredClone(
      component.visualEffects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS,
    );
    assertComponentVisualEffects(component.visualEffects);
    const manifest = registry.resolve(component.type);
    component.placement = materializePlacementGeometry(manifest, component.placement, component);
    if (isLegacyInput) {
      // Protocol 1.0 accepted positive boxes without an upper limit and any
      // finite world scale. Clamp those historical values into the explicit
      // 1.1 host policy before current-state validation and history replay.
      component.placement = normalizeLegacyPlacementGeometry(manifest, component.placement);
    }
    if (isLegacyInput && component.placement.space === "world3d") {
      const policy = resizePolicyForPlacement(manifest, component.placement);
      if (policy.kind !== "scale3d") {
        component.placement.scale = structuredClone(IDENTITY_WORLD_SCALE);
      }
      if (policy.kind === "scale3d" || policy.kind === "stage_dimensions") {
        delete component.placement.size;
      }
    }
    component.props = materializeStageDimensions(manifest, component.placement, component.props);
  }
  if (isLegacyInput) {
    for (const [connectionId, connection] of state.connections) {
      if (connection.kind !== "resource_binding" || connection.targetProp !== "dimensions") continue;
      const component = state.components.get(connection.componentId);
      if (!component) continue;
      const manifest = registry.resolve(component.type);
      if (resizePolicyForPlacement(manifest, component.placement).kind !== "stage_dimensions") continue;
      // Protocol 1.1 makes Stage dimensions authoritative geometry and forbids
      // future live bindings from mutating it. Freeze the already-materialized
      // legacy snapshot and remove only the unsafe geometry connection.
      state.connections.delete(connectionId);
      component.bindings = component.bindings.filter((bindingId) => bindingId !== connectionId);
    }
  }
  state.protocolVersion = WORKSPACE_PROTOCOL_VERSION;
  state.workspaceSchemaVersion = WORKSPACE_SCHEMA_VERSION;
  state.registryDigest = registry.digest;
  return state;
}

export class WorkspaceStore {
  private state: WorkspaceState;
  private checkpointState: WorkspaceState;
  private checkpointNextComponentSequence: number;
  private checkpointNextEventCursor: number;
  private readonly baseRegistry: ComponentRegistry;
  private allocator: ComponentIdAllocator;
  private nextEventCursor: number;
  private readonly clock: () => number;
  private commandHistory: WorkspaceCommandRecord[];
  private eventHistory: WorkspaceEvent[];
  private readonly committedRequests = new Map<string, CommittedRequest>();
  private readonly undoEntries: HistoryEntry[] = [];
  private readonly redoEntries: HistoryEntry[] = [];
  private readonly listeners = new Set<WorkspaceStoreListener>();

  constructor(options: WorkspaceStoreOptions = {}) {
    this.baseRegistry = options.registry ?? DEFAULT_COMPONENT_REGISTRY;
    this.state = migrateWorkspaceStateToCurrent(
      options.initialState ?? createInitialWorkspace("workspace_main", this.baseRegistry),
      this.baseRegistry,
    );
    this.checkpointState = migrateWorkspaceStateToCurrent(
      options.checkpointState ?? this.state,
      this.baseRegistry,
    );
    this.allocator = new ComponentIdAllocator(options.nextComponentSequence ?? 1);
    this.allocator.observeState(this.state);
    this.checkpointNextComponentSequence = options.checkpointNextComponentSequence
      ?? (options.checkpointState ? 1 : options.nextComponentSequence ?? 1);
    this.checkpointNextEventCursor = options.checkpointNextEventCursor ?? 1;
    this.clock = options.clock ?? Date.now;
    this.commandHistory = structuredClone(options.commandHistory ?? []);
    this.eventHistory = this.commandHistory.flatMap((command) => structuredClone(command.resolvedEvents));
    const maximumCursor = this.eventHistory.reduce((maximum, event) => Math.max(maximum, event.cursor), 0);
    this.nextEventCursor = options.nextEventCursor ?? maximumCursor + 1;
    if (!Number.isSafeInteger(this.nextEventCursor) || this.nextEventCursor < maximumCursor + 1) {
      throw new WorkspaceStoreError("nextEventCursor would reuse an event cursor", "invalid_event_cursor");
    }
    this.validateState(this.state);
    this.validateState(this.checkpointState);
    for (const command of this.commandHistory) {
      const delta: WorkspaceDelta = {
        fromRevision: command.baseWorkspaceRevision,
        toRevision: command.resultingWorkspaceRevision,
        added: [], updated: [], removed: [], resourcesChanged: [], connectionsChanged: [], viewsChanged: [],
        registryChanged: command.inputRegistryDigest !== command.resultingRegistryDigest,
      };
      this.committedRequests.set(command.requestId, {
        fingerprint: loadedCommandFingerprint(command, this.state.workspaceId),
        delta,
        command: structuredClone(command),
        events: structuredClone(command.resolvedEvents),
      });
    }
  }

  getState(): Readonly<WorkspaceState> {
    return cloneWorkspaceState(this.state);
  }

  getCheckpointState(): Readonly<WorkspaceState> {
    return cloneWorkspaceState(this.checkpointState);
  }

  getCheckpointNextComponentSequence(): number {
    return this.checkpointNextComponentSequence;
  }

  getCheckpointNextEventCursor(): number {
    return this.checkpointNextEventCursor;
  }

  getRevision(): number {
    return this.state.revision;
  }

  getRegistryDigest(): string {
    return this.state.registryDigest;
  }

  getComponentCatalog(): ComponentManifest[] {
    return this.effectiveRegistry(this.state).listLatest();
  }

  getComponentManifest(typeId: string, version?: string): ComponentManifest | undefined {
    return this.effectiveRegistry(this.state).get(typeId, version);
  }

  getCommandHistory(): WorkspaceCommandRecord[] {
    return structuredClone(this.commandHistory);
  }

  getEventHistory(afterCursor = 0): WorkspaceEvent[] {
    return this.eventHistory.filter((event) => event.cursor > afterCursor).map((event) => structuredClone(event));
  }

  getAllocatorSnapshot(): number {
    return this.allocator.snapshot();
  }

  getNextEventCursor(): number {
    return this.nextEventCursor;
  }

  restoreMonotonicCounters(nextComponentSequence: number, nextEventCursor: number): void {
    this.allocator.advanceTo(nextComponentSequence);
    if (!Number.isSafeInteger(nextEventCursor) || nextEventCursor < this.nextEventCursor) {
      throw new WorkspaceStoreError("Event cursor cannot move backwards", "invalid_event_cursor");
    }
    this.nextEventCursor = nextEventCursor;
  }

  reserveComponentIds(count = 1): string[] {
    return this.allocator.reserve(count);
  }

  subscribe(listener: WorkspaceStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canUndo(): boolean {
    return this.undoEntries.length > 0;
  }

  canRedo(): boolean {
    return this.redoEntries.length > 0;
  }

  canUndoUserCommand(): boolean {
    return this.undoEntries.some(isUserUndoEntry);
  }

  canRedoUserCommand(): boolean {
    return this.redoEntries.some(isUserUndoEntry);
  }

  /** Undoes the latest user/agent command while discarding dependent host effects. */
  undoUserCommand(): WorkspaceDelta | null {
    return this.undoUserCommandFromBaseline();
  }

  private undoUserCommandFromBaseline(): WorkspaceDelta | null {
    const undoEntries = this.undoEntries.map(cloneHistoryEntry);
    let targetIndex = -1;
    for (let index = undoEntries.length - 1; index >= 0; index -= 1) {
      if (isUserUndoEntry(undoEntries[index]!)) {
        targetIndex = index;
        break;
      }
    }
    if (targetIndex < 0) return null;
    const target = undoEntries[targetIndex]!;
    // Derived host effects (for example an overdue timer settling) are
    // discarded with the user command they followed. Independent public-feed
    // observations survive an unrelated undo, but are discarded when the
    // target command created, changed, deleted, or bound that same feed.
    const independentObservations = undoEntries.slice(targetIndex + 1).filter((entry) => {
      const resourceIds = independentFeedObservationResourceIds(entry);
      return resourceIds !== null && !commandTouchesObservedFeed(target, resourceIds);
    });
    const replayEntries = [
      ...undoEntries.slice(0, targetIndex),
      ...independentObservations,
    ];
    if (!target) return null;
    const priorState = cloneWorkspaceState(this.state);
    const retainedRedo = this.redoEntries
      .filter(isUserUndoEntry)
      .map(cloneHistoryEntry);

    this.rebuildHistory(replayEntries);
    this.redoEntries.splice(
      0,
      this.redoEntries.length,
      ...retainedRedo,
      cloneHistoryEntry(target),
    );
    const delta = computeWorkspaceDelta(priorState, this.state);
    this.emit(delta, []);
    return structuredClone(delta);
  }

  /** Redoes the latest user/agent command against the current Workspace state. */
  redoUserCommand(): WorkspaceDelta | null {
    return this.redoUserCommandFromBaseline();
  }

  private redoUserCommandFromBaseline(): WorkspaceDelta | null {
    const userRedo = this.redoEntries.filter(isUserUndoEntry);
    const target = userRedo.pop();
    if (!target) return null;
    this.rebuildHistory(this.undoEntries);

    const batch: WorkspaceCommandBatch = {
      protocol_version: WORKSPACE_PROTOCOL_VERSION,
      request_id: target.command.requestId,
      workspace_id: this.state.workspaceId,
      input_revision: this.state.revision,
      base_workspace_revision: this.state.revision,
      registry_digest: this.state.registryDigest,
      mode: "commit",
      operations: structuredClone(target.command.resolvedOperations),
    };
    const authorization = { actor: target.command.actor, permissions: ["*"] } as const;
    const result = this.applyResolvedHistoryDetailed(
      batch,
      authorization,
      target.command.resolvedActionEffects,
    );
    // applyDetailed correctly creates a fresh rebased undo entry, but normal
    // branching clears redo. Restore only the older user redo templates.
    this.redoEntries.splice(
      0,
      this.redoEntries.length,
      ...userRedo.map(cloneHistoryEntry),
    );
    return structuredClone(result.delta);
  }

  getCommittedResult(requestId: string): WorkspaceCommitResult | null {
    const prior = this.committedRequests.get(requestId);
    if (!prior) return null;
    return {
      delta: structuredClone(prior.delta),
      state: this.getState(),
      deduplicated: true,
      command: structuredClone(prior.command),
      events: structuredClone(prior.events),
    };
  }

  apply(batch: WorkspaceCommandBatch, authorization: WorkspaceAuthorization = TRUSTED_USER): WorkspaceDelta {
    return this.applyDetailed(batch, authorization).delta;
  }

  applyDetailed(
    untrustedBatch: WorkspaceCommandBatch,
    authorization: WorkspaceAuthorization = TRUSTED_USER,
  ): WorkspaceCommitResult {
    const batch = validateWorkspaceCommandBatch(untrustedBatch);
    return this.applyValidatedDetailed(batch, authorization);
  }

  /**
   * Host-only replay lane for canonicalized project history. External command
   * batches remain capped at 100 operations; a migrated resolved command may
   * contain up to 300 operations and still executes as one revision/undo item.
   */
  applyResolvedHistoryDetailed(
    untrustedBatch: WorkspaceCommandBatch,
    authorization: WorkspaceAuthorization,
    replayActionEffects?: readonly ResolvedActionEffect[],
  ): WorkspaceCommitResult {
    const operations = validateLegacyHistoryExecution(untrustedBatch, untrustedBatch.operations);
    const batch = { ...structuredClone(untrustedBatch), operations };
    return this.applyValidatedDetailed(batch, authorization, replayActionEffects, operations, true);
  }

  private applyValidatedDetailed(
    batch: WorkspaceCommandBatch,
    authorization: WorkspaceAuthorization,
    replayActionEffects?: readonly ResolvedActionEffect[],
    executionOperations: readonly WorkspaceOperation[] = batch.operations,
    replayingResolvedOperations = false,
  ): WorkspaceCommitResult {
    const fingerprint = fingerprintBatch(batch);
    const prior = this.committedRequests.get(batch.request_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new WorkspaceStoreError(
          `Request ${batch.request_id} was already committed with different content`,
          "idempotency_conflict",
        );
      }
      return {
        delta: structuredClone(prior.delta), state: this.getState(), deduplicated: true,
        command: structuredClone(prior.command), events: structuredClone(prior.events),
      };
    }
    if (batch.workspace_id !== this.state.workspaceId) {
      throw new WorkspaceStoreError(
        `Batch targets ${batch.workspace_id}; active workspace is ${this.state.workspaceId}`,
        "workspace_id_mismatch",
      );
    }
    if (batch.base_workspace_revision !== this.state.revision) {
      throw new StaleWorkspaceRevisionError(this.state.revision, batch.base_workspace_revision);
    }
    if (batch.registry_digest !== this.state.registryDigest) {
      throw new StaleRegistryDigestError(this.state.registryDigest, batch.registry_digest);
    }
    requirePermission(authorization, "workspace:write");

    const before = cloneWorkspaceState(this.state);
    const draft = cloneWorkspaceState(this.state);
    const draftAllocator = this.allocator.clone();
    const resolvedOperations: WorkspaceOperation[] = [];
    const resolvedActionEffects: ResolvedActionEffect[] = [];
    const replayEffectsByOpId = new Map(
      (replayActionEffects ?? []).map((effect) => [effect.opId, structuredClone(effect)]),
    );
    if (replayEffectsByOpId.size !== (replayActionEffects?.length ?? 0)) {
      throw new WorkspaceStoreError("Duplicate resolved action effect opId", "invalid_resolved_effect");
    }
    const events: WorkspaceEvent[] = [];
    const shouldRouteEvents = !replayingResolvedOperations;
    const routingQueue: WorkspaceEvent[] = [];
    const reservedOperationIds = new Set(executionOperations.map((operation) => operation.op_id));
    let routedOperationOrdinal = 0;
    let eventCursor = this.nextEventCursor;
    const resultingRevision = before.revision + 1;

    const appendEvents = (
      componentId: string | undefined,
      drafts: ActionEventDraft[],
      effectiveTimeMs: number,
      source: WorkspaceEvent["source"],
      causedBy?: EventCausation,
    ): WorkspaceEvent[] => {
      const appended: WorkspaceEvent[] = [];
      const existing = new Set([...this.eventHistory, ...events].map((event) => event.id));
      for (const item of drafts) {
        const id = item.id ?? `EVT_${String(eventCursor).padStart(8, "0")}`;
        if (existing.has(id)) continue;
        const event: WorkspaceEvent = {
          id,
          cursor: eventCursor,
          workspaceRevision: resultingRevision,
          ...(componentId ? { componentId } : {}),
          event: item.event,
          payload: structuredClone(item.payload),
          source,
          effectiveTimeMs,
          ...(causedBy ? { causedBy: structuredClone(causedBy) } : {}),
        };
        events.push(event);
        appended.push(structuredClone(event));
        if (shouldRouteEvents) routingQueue.push(structuredClone(event));
        existing.add(id);
        eventCursor += 1;
      }
      return appended;
    };

    const applyResolvedOperation = (
      operation: WorkspaceOperation,
      eventSource: WorkspaceEvent["source"],
      replayEffect?: ResolvedActionEffect,
      causedBy?: EventCausation,
      internalVisibilityCancellation = false,
    ): void => {
      if (!internalVisibilityCancellation) {
        requirePermission(authorization, operationPermission(operation));
      }
      this.applyOperation(
        draft,
        operation,
        authorization,
        resultingRevision,
        draftAllocator,
        appendEvents,
        resolvedActionEffects,
        replayEffect,
        eventSource,
        causedBy,
        replayingResolvedOperations,
        internalVisibilityCancellation,
      );
      resolvedOperations.push(operation);
    };

    const applyWithVisibilityCancellations = (
      operation: WorkspaceOperation,
      eventSource: WorkspaceEvent["source"],
      replayEffect?: ResolvedActionEffect,
      causedBy?: EventCausation,
    ): void => {
      const replayedVisibilityCancellation = replayingResolvedOperations
        && replayEffect !== undefined
        && isVisibilityStopOperation(operation);
      applyResolvedOperation(
        operation,
        eventSource,
        replayEffect,
        causedBy,
        replayedVisibilityCancellation,
      );
      if (replayingResolvedOperations) return;
      for (const component of visibilityCancellationTargets(draft, operation)) {
        let opId: string;
        do {
          routedOperationOrdinal += 1;
          opId = `${VISIBILITY_STOP_OPERATION_PREFIX}${routedOperationOrdinal}:${component.id.slice(0, 96)}`;
        } while (reservedOperationIds.has(opId));
        reservedOperationIds.add(opId);
        applyResolvedOperation({
          op: "invoke_component_action",
          op_id: opId,
          id: component.id,
          action: "stop_animation",
          input: {},
        }, eventSource, undefined, causedBy, true);
      }
    };

    const drainEventRoutes = (): void => {
      while (routingQueue.length) {
        const sourceEvent = routingQueue.shift()!;
        if (!sourceEvent.componentId) continue;
        const matching = [...draft.connections.values()]
          .filter((connection): connection is EventConnection =>
            connection.kind === "event_connection"
            && connection.enabled
            && connection.sourceComponentId === sourceEvent.componentId
            && connection.event === sourceEvent.event)
          .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        for (const connection of matching) {
          const target = this.assertComponent(draft, connection.targetComponentId);
          const targetManifest = this.manifestFor(draft, target);
          const targetAction = targetManifest.actions[connection.action];
          if (!targetAction) {
            throw new WorkspaceStoreError(
              `Unknown action ${connection.action} for ${targetManifest.typeId}`,
              "unknown_component_action",
            );
          }
          assertRoutableActionAuthorized(
            targetAction,
            authorization,
            `Event connection ${connection.id}`,
          );
          let opId: string;
          do {
            routedOperationOrdinal += 1;
            opId = `binding_route:${sourceEvent.cursor}:${routedOperationOrdinal}:${connection.id.slice(0, 96)}`;
          } while (reservedOperationIds.has(opId));
          reservedOperationIds.add(opId);
          const causedBy: EventCausation = {
            eventId: sourceEvent.id,
            connectionId: connection.id,
          };
          const routedOperation: WorkspaceOperation = {
            op: "invoke_component_action",
            op_id: opId,
            id: connection.targetComponentId,
            action: connection.action,
            input: structuredClone(
              connection.inputMode === "event_payload" ? sourceEvent.payload : (connection.input ?? {}),
            ),
            effective_time_ms: sourceEvent.effectiveTimeMs,
            ...(connection.transition ? { transition: structuredClone(connection.transition) } : {}),
          };
          applyWithVisibilityCancellations(routedOperation, "binding", undefined, causedBy);
        }
      }
    };

    // Every operation reduces against drafts. Exceptions cannot mutate live state, history, or IDs.
    for (const supplied of executionOperations) {
      const operation = structuredClone(supplied);
      const replayEffect = replayEffectsByOpId.get(operation.op_id);
      applyWithVisibilityCancellations(
        operation,
        replayEffect?.causedBy ? "binding" : authorization.actor,
        replayEffect,
        replayEffect?.causedBy,
      );
      replayEffectsByOpId.delete(operation.op_id);
      if (shouldRouteEvents) drainEventRoutes();
    }
    if (replayEffectsByOpId.size) {
      throw new WorkspaceStoreError(
        `Resolved action effect has no matching operation: ${[...replayEffectsByOpId.keys()][0]}`,
        "invalid_resolved_effect",
      );
    }

    this.validateState(draft);
    draft.revision = resultingRevision;
    const durableOperations = structuredClone(resolvedOperations);
    const command: WorkspaceCommandRecord = {
      requestId: batch.request_id,
      actor: authorization.actor,
      inputRevision: batch.input_revision,
      baseWorkspaceRevision: batch.base_workspace_revision,
      inputRegistryDigest: batch.registry_digest,
      resultingRegistryDigest: draft.registryDigest,
      resolvedOperations: durableOperations,
      resolvedEvents: structuredClone(events),
      ...(resolvedActionEffects.length ? { resolvedActionEffects: structuredClone(resolvedActionEffects) } : {}),
      resultingWorkspaceRevision: resultingRevision,
    };
    draft.history.push({
      requestId: batch.request_id,
      inputRevision: batch.input_revision,
      baseWorkspaceRevision: batch.base_workspace_revision,
      resultingWorkspaceRevision: resultingRevision,
      resultingRegistryDigest: draft.registryDigest,
      operationIds: durableOperations.map((operation) => operation.op_id),
      eventIds: events.map((event) => event.id),
    });
    if (draft.history.length > MAX_WORKSPACE_HISTORY_SUMMARIES) {
      draft.history.splice(0, draft.history.length - MAX_WORKSPACE_HISTORY_SUMMARIES);
    }
    const delta = computeWorkspaceDelta(before, draft);

    this.state = draft;
    this.allocator = draftAllocator;
    this.nextEventCursor = eventCursor;
    this.commandHistory.push(structuredClone(command));
    this.eventHistory.push(...structuredClone(events));
    const committed: CommittedRequest = {
      fingerprint,
      delta: structuredClone(delta),
      command: structuredClone(command),
      events: structuredClone(events),
    };
    this.committedRequests.set(batch.request_id, committed);
    while (this.committedRequests.size > MAX_WORKSPACE_IDEMPOTENCY_ENTRIES) {
      const oldestRequestId = this.committedRequests.keys().next().value as string | undefined;
      if (!oldestRequestId) break;
      this.committedRequests.delete(oldestRequestId);
    }
    this.undoEntries.push({
      requestId: batch.request_id, fingerprint,
      before, after: cloneWorkspaceState(draft), delta: structuredClone(delta),
      command: structuredClone(command), events: structuredClone(events),
      nextComponentSequence: draftAllocator.snapshot(),
      nextEventCursor: eventCursor,
    });
    this.compactUndoHistory();
    if (authorization.actor === "system") {
      // Deterministic host acknowledgements are derived state, not a new user
      // branch. Preserve any pending user/agent redo templates.
      const userRedo = this.redoEntries.filter(isUserUndoEntry).map(cloneHistoryEntry);
      this.redoEntries.splice(0, this.redoEntries.length, ...userRedo);
    } else {
      this.redoEntries.length = 0;
    }
    this.emit(delta, events);
    return {
      delta: structuredClone(delta), state: this.getState(), deduplicated: false,
      command: structuredClone(command), events: structuredClone(events),
    };
  }

  undo(): WorkspaceDelta | null {
    const source = this.undoEntries.pop();
    if (!source) return null;
    const entry = cloneHistoryEntry(source);
    const before = cloneWorkspaceState(this.state);
    this.state = cloneWorkspaceState(entry.before);
    const index = this.commandHistory.map((command) => command.requestId).lastIndexOf(entry.requestId);
    if (index >= 0) this.commandHistory.splice(index, 1);
    const ids = new Set(entry.events.map((event) => event.id));
    this.eventHistory = this.eventHistory.filter((event) => !ids.has(event.id));
    this.committedRequests.delete(entry.requestId);
    this.redoEntries.push(entry);
    const delta = computeWorkspaceDelta(before, this.state);
    this.emit(delta, []);
    return structuredClone(delta);
  }

  redo(): WorkspaceDelta | null {
    const source = this.redoEntries.pop();
    if (!source) return null;
    const entry = cloneHistoryEntry(source);
    const before = cloneWorkspaceState(this.state);
    this.state = cloneWorkspaceState(entry.after);
    this.commandHistory.push(structuredClone(entry.command));
    this.eventHistory.push(...structuredClone(entry.events));
    this.committedRequests.set(entry.requestId, {
      fingerprint: entry.fingerprint,
      delta: structuredClone(entry.delta),
      command: structuredClone(entry.command),
      events: structuredClone(entry.events),
    });
    this.undoEntries.push(entry);
    const delta = computeWorkspaceDelta(before, this.state);
    this.emit(delta, entry.events);
    return structuredClone(delta);
  }

  private effectiveRegistry(state: WorkspaceState): ComponentRegistry {
    return buildEffectiveRegistry(this.baseRegistry, state.recipes);
  }

  /**
   * Keep the live undo model bounded. The oldest committed state becomes the
   * new deterministic checkpoint, so save/reopen and recent undo remain exact
   * without retaining a full Workspace snapshot for every historical command.
   */
  private compactUndoHistory(): void {
    while (this.undoEntries.length > MAX_WORKSPACE_UNDO_ENTRIES) {
      const oldest = this.undoEntries.shift();
      if (!oldest) return;
      this.checkpointState = cloneWorkspaceState(oldest.after);
      this.checkpointNextComponentSequence = oldest.nextComponentSequence;
      this.checkpointNextEventCursor = oldest.nextEventCursor;
      const commandIndex = this.commandHistory.findIndex((command) => command.requestId === oldest.requestId);
      if (commandIndex >= 0) this.commandHistory.splice(commandIndex, 1);
      const oldEventIds = new Set(oldest.events.map((event) => event.id));
      this.eventHistory = this.eventHistory.filter((event) => !oldEventIds.has(event.id));
    }
  }

  private rebuildHistory(entries: readonly HistoryEntry[]): void {
    const baseline = cloneWorkspaceState(this.checkpointState);
    const finalAllocatorFloor = this.allocator.snapshot();
    const finalEventCursorFloor = this.nextEventCursor;
    const temp = new WorkspaceStore({
      initialState: baseline,
      checkpointState: baseline,
      registry: this.baseRegistry,
      nextComponentSequence: this.checkpointNextComponentSequence,
      checkpointNextComponentSequence: this.checkpointNextComponentSequence,
      nextEventCursor: this.checkpointNextEventCursor,
      checkpointNextEventCursor: this.checkpointNextEventCursor,
      clock: this.clock,
    });
    for (const entry of entries) {
      const command = entry.command;
      const batch: WorkspaceCommandBatch = {
        protocol_version: WORKSPACE_PROTOCOL_VERSION,
        request_id: command.requestId,
        workspace_id: baseline.workspaceId,
        input_revision: temp.getRevision(),
        base_workspace_revision: temp.getRevision(),
        registry_digest: temp.getRegistryDigest(),
        mode: "commit",
        operations: structuredClone(command.resolvedOperations),
      };
      const authorization = { actor: command.actor, permissions: ["*"] } as const;
      temp.applyResolvedHistoryDetailed(batch, authorization, command.resolvedActionEffects);
    }
    temp.restoreMonotonicCounters(
      Math.max(finalAllocatorFloor, temp.getAllocatorSnapshot()),
      Math.max(finalEventCursorFloor, temp.getNextEventCursor()),
    );

    this.state = cloneWorkspaceState(temp.state);
    this.checkpointState = cloneWorkspaceState(baseline);
    this.allocator = temp.allocator.clone();
    this.nextEventCursor = temp.nextEventCursor;
    this.commandHistory = structuredClone(temp.commandHistory);
    this.eventHistory = structuredClone(temp.eventHistory);
    this.committedRequests.clear();
    for (const [requestId, committed] of temp.committedRequests) {
      this.committedRequests.set(requestId, structuredClone(committed));
    }
    this.undoEntries.splice(
      0,
      this.undoEntries.length,
      ...temp.undoEntries.map(cloneHistoryEntry),
    );
    this.redoEntries.length = 0;
  }

  private manifestFor(state: WorkspaceState, component: ComponentInstance): ComponentManifest {
    return this.effectiveRegistry(state).resolve(component.type);
  }

  private assertPlacementAllowed(manifest: ComponentManifest, placement: ComponentPlacement): void {
    if (!manifest.allowedPlacements.includes(placement.space)) {
      throw new WorkspaceStoreError(
        `${manifest.typeId} cannot be placed in ${placement.space}`,
        "placement_not_allowed",
      );
    }
  }

  private assertComponent(state: WorkspaceState, id: string): ComponentInstance {
    const component = state.components.get(id);
    if (!component) throw new WorkspaceStoreError(`Unknown component ${id}`, "unknown_component");
    return component;
  }

  private applyOperation(
    state: WorkspaceState,
    operation: WorkspaceOperation,
    authorization: WorkspaceAuthorization,
    resultingRevision: number,
    allocator: ComponentIdAllocator,
    appendEvents: (
      componentId: string | undefined,
      events: ActionEventDraft[],
      time: number,
      source: WorkspaceEvent["source"],
      causedBy?: EventCausation,
    ) => WorkspaceEvent[],
    actionEffects: ResolvedActionEffect[],
    replayEffect?: ResolvedActionEffect,
    eventSource: WorkspaceEvent["source"] = authorization.actor,
    causedBy?: EventCausation,
    replayingResolvedOperations = false,
    internalVisibilityCancellation = false,
  ): void {
    switch (operation.op) {
      case "define_component_recipe": {
        validateComponentRecipe(operation.recipe);
        const key = recipeKey(operation.recipe);
        if (state.recipes.has(key) || this.baseRegistry.get(operation.recipe.typeId, operation.recipe.version)) {
          throw new WorkspaceStoreError(`Component type ${key} is already defined`, "duplicate_component_type");
        }
        state.recipes.set(key, structuredClone(operation.recipe));
        state.registryDigest = this.effectiveRegistry(state).digest;
        return;
      }
      case "create_component": {
        if (state.components.has(operation.id)) {
          throw new WorkspaceStoreError(`Component ${operation.id} already exists`, "duplicate_component_id");
        }
        const registry = this.effectiveRegistry(state);
        const manifest = registry.resolve(operation.component_type);
        this.assertPlacementAllowed(manifest, operation.placement);
        const resolvedPlacement = materializePlacementGeometry(manifest, operation.placement);
        const existingStage = stageComponent(state);
        if (manifest.typeId === "stage-3d") {
          if (existingStage) {
            throw new WorkspaceStoreError(
              `Workspace already has stage-3d basis ${existingStage.id}`,
              "duplicate_stage_basis",
            );
          }
          if (operation.parent_id) {
            throw new WorkspaceStoreError("stage-3d must be a root component", "invalid_stage_basis");
          }
        } else if (placementRequiresStage(resolvedPlacement) && !existingStage) {
          throw new WorkspaceStoreError(
            `${manifest.typeId} requires a stage-3d basis before ${resolvedPlacement.space} placement`,
            "stage_basis_required",
          );
        }
        const props = materializeStageDimensions(
          manifest,
          resolvedPlacement,
          { ...structuredClone(manifest.defaultProps), ...structuredClone(operation.props ?? {}) },
        );
        const durableState = { ...structuredClone(manifest.defaultDurableState), ...structuredClone(operation.durable_state ?? {}) };
        if (manifest.typeId === "timer" && operation.durable_state === undefined) {
          const durationMs = typeof props.durationMs === "number" ? props.durationMs : 0;
          durableState.durationMs = durationMs;
          durableState.remainingMs = durationMs;
        }
        registry.assertProps(operation.component_type, props);
        normalizeWebPanelProps(manifest, props);
        assertSpatialAssetProps(manifest, props);
        registry.assertDurableState(operation.component_type, durableState);
        if (operation.parent_id && !state.components.has(operation.parent_id)) {
          throw new WorkspaceStoreError(`Unknown parent ${operation.parent_id}`, "unknown_component");
        }
        const target = placementTarget(resolvedPlacement);
        if (target && !state.components.has(target)) {
          throw new WorkspaceStoreError(`Unknown placement target ${target}`, "unknown_component");
        }
        const component: ComponentInstance = {
          id: operation.id,
          type: structuredClone(operation.component_type),
          label: operation.label ?? defaultLabel(manifest, operation.id),
          props,
          durableState,
          placement: structuredClone(resolvedPlacement),
          ...(operation.parent_id ? { parentId: operation.parent_id } : {}),
          bindings: [],
          tags: structuredClone(operation.tags ?? []),
          visibility: operation.visibility ?? "visible",
          visualEffects: structuredClone(operation.visual_effects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS),
          locks: { ...DEFAULT_COMPONENT_LOCKS, ...structuredClone(operation.locks ?? {}) },
          provenance: { createdRevision: resultingRevision, createdBy: authorization.actor },
        };
        assertComponentResizeGeometry(component, manifest, true);
        state.components.set(component.id, component);
        allocator.observe(component.id);
        operation.label = component.label;
        operation.props = structuredClone(props);
        operation.durable_state = structuredClone(durableState);
        operation.placement = structuredClone(resolvedPlacement);
        operation.tags = structuredClone(component.tags);
        operation.visibility = component.visibility;
        operation.visual_effects = structuredClone(component.visualEffects);
        operation.locks = structuredClone(component.locks);
        return;
      }
      case "update_component": {
        const component = this.assertComponent(state, operation.id);
        const substantive = operation.patch.label !== undefined || operation.patch.props !== undefined
          || operation.patch.tags !== undefined || operation.patch.visibility !== undefined;
        if (component.locks.props && substantive) {
          throw new WorkspaceStoreError(`Component ${component.id} properties are locked`, "component_locked");
        }
        const registry = this.effectiveRegistry(state);
        const manifest = registry.resolve(component.type);
        if (operation.patch.props) {
          const resizePolicy = resizePolicyForPlacement(manifest, component.placement);
          if (resizePolicy.kind === "stage_dimensions" && operation.patch.props.dimensions !== undefined) {
            throw new WorkspaceStoreError(
              "Stage dimensions must be changed with resize_component",
              "resize_requires_resize_component",
            );
          }
          for (const key of Object.keys(operation.patch.props)) {
            if (!manifest.writableProps.includes(key)) {
              throw new WorkspaceStoreError(`Property ${key} is not writable on ${manifest.typeId}`, "property_not_writable");
            }
          }
          const props = { ...component.props, ...structuredClone(operation.patch.props) };
          registry.assertProps(component.type, props);
          normalizeWebPanelProps(manifest, props);
          assertSpatialAssetProps(manifest, props);
          if (manifest.typeId === "web-panel" && operation.patch.props.sourceUrl !== undefined) {
            operation.patch.props.sourceUrl = props.sourceUrl;
          }
          component.props = props;
          if (manifest.typeId === "timer" && typeof operation.patch.props.durationMs === "number"
            && component.durableState.phase === "idle") {
            component.durableState.durationMs = operation.patch.props.durationMs;
            component.durableState.remainingMs = operation.patch.props.durationMs;
            registry.assertDurableState(component.type, component.durableState);
          }
        }
        if (operation.patch.label !== undefined) component.label = operation.patch.label;
        if (operation.patch.tags !== undefined) component.tags = structuredClone(operation.patch.tags);
        if (operation.patch.visibility !== undefined) component.visibility = operation.patch.visibility;
        if (operation.patch.locks !== undefined) component.locks = { ...component.locks, ...operation.patch.locks };
        return;
      }
      case "upgrade_component_manifest": {
        const component = this.assertComponent(state, operation.id);
        if (component.locks.props || component.locks.actions) {
          throw new WorkspaceStoreError(
            `Component ${component.id} props/actions are locked`,
            "component_locked",
          );
        }
        if (operation.component_type.typeId !== component.type.typeId) {
          throw new WorkspaceStoreError(
            `Component ${component.id} cannot change typeId from ${component.type.typeId} to ${operation.component_type.typeId}`,
            "component_upgrade_type_mismatch",
          );
        }
        const registry = this.effectiveRegistry(state);
        const currentManifest = registry.resolve(component.type);
        const targetManifest = this.baseRegistry.get(
          operation.component_type.typeId,
          operation.component_type.version,
        );
        if (
          currentManifest.trustTier !== "builtin"
          || !targetManifest
          || targetManifest.trustTier !== "builtin"
          || targetManifest.digest !== operation.component_type.digest
        ) {
          throw new WorkspaceStoreError(
            `Component ${component.id} is not an upgradeable built-in`,
            "component_upgrade_builtin_only",
          );
        }
        const latest = this.baseRegistry.get(component.type.typeId);
        const targetMatchesLatest = latest
          && operation.component_type.typeId === latest.typeId
          && operation.component_type.version === latest.version
          && operation.component_type.digest === latest.digest;
        // Fresh authoring may only move to the current built-in. Trusted
        // resolved-history replay must retain the exact target that was
        // current when the command originally committed, even after a newer
        // built-in version is installed.
        if (!replayingResolvedOperations && !targetMatchesLatest) {
          throw new WorkspaceStoreError(
            `Component ${component.id} must upgrade to exact current manifest ${latest?.typeId ?? component.type.typeId}@${latest?.version ?? "unavailable"}`,
            "component_upgrade_target_not_current",
          );
        }
        if (
          component.type.version === targetManifest.version
          && component.type.digest === targetManifest.digest
        ) {
          throw new WorkspaceStoreError(
            `Component ${component.id} is already pinned to the requested manifest`,
            "component_manifest_already_current",
          );
        }
        this.assertPlacementAllowed(targetManifest, component.placement);
        const upgradedProps = { ...structuredClone(targetManifest.defaultProps), ...structuredClone(component.props) };
        // spatial-entity@1.5 adds a nested master switch. Upgrade is an
        // explicit migration boundary, so preserve the complete 1.4 physics
        // object while materializing the new default instead of letting the
        // ordinary top-level shallow merge drop it.
        if (component.type.typeId === "spatial-entity") {
          const targetPhysics = targetManifest.defaultProps.physics;
          const currentPhysics = component.props.physics;
          if (targetPhysics && typeof targetPhysics === "object" && !Array.isArray(targetPhysics)
            && currentPhysics && typeof currentPhysics === "object" && !Array.isArray(currentPhysics)) {
            upgradedProps.physics = {
              ...structuredClone(targetPhysics),
              ...structuredClone(currentPhysics),
            };
          }
        }
        const props = materializeStageDimensions(
          targetManifest,
          component.placement,
          upgradedProps,
        );
        const durableState = {
          ...structuredClone(targetManifest.defaultDurableState),
          ...structuredClone(component.durableState),
        };
        registry.assertProps(operation.component_type, props);
        normalizeWebPanelProps(targetManifest, props);
        assertSpatialAssetProps(targetManifest, props);
        registry.assertDurableState(operation.component_type, durableState);

        component.type = structuredClone(operation.component_type);
        component.props = props;
        component.durableState = durableState;
        assertComponentResizeGeometry(component, targetManifest);

        // Upgrade must leave every existing binding/route valid under the new
        // action, event, writable-prop, and data-projection contracts.
        for (const connection of state.connections.values()) {
          if (connection.kind === "resource_binding" && connection.componentId === component.id) {
            this.validateConnection(state, registry, connection);
            this.assertResourceBindingProjectable(state, component, targetManifest, connection);
          } else if (connection.kind === "event_connection" && (
            connection.sourceComponentId === component.id || connection.targetComponentId === component.id
          )) {
            this.validateConnection(state, registry, connection);
          }
        }
        return;
      }
      case "place_component": {
        const component = this.assertComponent(state, operation.id);
        if (component.locks.placement) throw new WorkspaceStoreError(`Component ${component.id} placement is locked`, "component_locked");
        const manifest = this.manifestFor(state, component);
        this.assertPlacementAllowed(manifest, operation.placement);
        const suppliedPlacement = structuredClone(operation.placement);
        const resolvedPlacement = materializePlacementGeometry(manifest, operation.placement, component);
        if (manifest.typeId !== "stage-3d" && placementRequiresStage(resolvedPlacement) && !stageComponent(state)) {
          throw new WorkspaceStoreError(
            `${manifest.typeId} requires a stage-3d basis before ${resolvedPlacement.space} placement`,
            "stage_basis_required",
          );
        }
        const target = placementTarget(resolvedPlacement);
        if (target && !state.components.has(target)) throw new WorkspaceStoreError(`Unknown placement target ${target}`, "unknown_component");
        const candidate = structuredClone(component);
        candidate.placement = structuredClone(resolvedPlacement);
        const currentPolicy = resizePolicyForPlacement(manifest, component.placement);
        const nextPolicy = resizePolicyForPlacement(manifest, candidate.placement);
        const policyChanged = !resizePoliciesEqual(currentPolicy, nextPolicy);
        if (policyChanged) {
          if (component.locks.resize) {
            throw new WorkspaceStoreError(`Component ${component.id} resize is locked`, "component_locked");
          }
          if (!explicitPlacementGeometryMatches(suppliedPlacement, resolvedPlacement)) {
            throw new WorkspaceStoreError(
              "Policy-changing placement must use target default or frozen geometry; resize separately",
              "resize_requires_resize_component",
            );
          }
        } else {
          const currentGeometry = componentGeometrySnapshot(component, currentPolicy);
          const nextGeometry = componentGeometrySnapshot(candidate, nextPolicy);
          const geometryChanged = stableStringify(currentGeometry) !== stableStringify(nextGeometry);
          if (!geometryChanged) {
            assertComponentResizeGeometry(candidate, manifest);
            component.placement = structuredClone(resolvedPlacement);
            operation.placement = structuredClone(resolvedPlacement);
            return;
          }
          if (component.locks.resize) {
            throw new WorkspaceStoreError(`Component ${component.id} resize is locked`, "component_locked");
          }
          if (nextPolicy.kind === "none") {
            throw new WorkspaceStoreError(
              "Fixed component geometry cannot be changed after creation",
              "resize_not_supported",
            );
          }
          throw new WorkspaceStoreError(
            "Geometry changes must use resize_component",
            "resize_requires_resize_component",
          );
        }
        assertComponentResizeGeometry(candidate, manifest, policyChanged);
        component.placement = structuredClone(resolvedPlacement);
        operation.placement = structuredClone(resolvedPlacement);
        return;
      }
      case "resize_component": {
        const component = this.assertComponent(state, operation.id);
        if (component.locks.placement || component.locks.resize) {
          throw new WorkspaceStoreError(`Component ${component.id} resize is locked`, "component_locked");
        }
        const manifest = this.manifestFor(state, component);
        const policy = resizePolicyForPlacement(manifest, component.placement);
        const current = componentResizeValue(component, policy);
        if (policy.kind !== "none" && !current) {
          throw new WorkspaceStoreError(
            `Component ${component.id} is missing explicit ${policy.kind} geometry`,
            "invalid_component_size",
          );
        }
        assertResizeValue(policy, operation.resize, current);
        if (operation.resize.kind === "box2d") {
          component.placement.size = structuredClone(operation.resize.size);
        } else if (operation.resize.kind === "scale3d") {
          if (component.placement.space !== "world3d") {
            throw new WorkspaceStoreError("scale3d requires world3d placement", "resize_kind_mismatch");
          }
          component.placement.scale = structuredClone(operation.resize.scale);
        } else {
          component.props.dimensions = structuredClone(operation.resize.dimensions);
          this.effectiveRegistry(state).assertProps(component.type, component.props);
        }
        return;
      }
      case "set_component_visual_effects": {
        const component = this.assertComponent(state, operation.id);
        if (component.locks.visualEffects) {
          throw new WorkspaceStoreError(`Component ${component.id} visual effects are locked`, "component_locked");
        }
        assertComponentVisualEffects(operation.visual_effects);
        component.visualEffects = structuredClone(operation.visual_effects);
        return;
      }
      case "attach_component": {
        const child = this.assertComponent(state, operation.child_id);
        this.assertComponent(state, operation.parent_id);
        if (child.locks.placement) throw new WorkspaceStoreError(`Component ${child.id} placement is locked`, "component_locked");
        child.parentId = operation.parent_id;
        return;
      }
      case "detach_component": {
        const child = this.assertComponent(state, operation.child_id);
        if (child.locks.placement) throw new WorkspaceStoreError(`Component ${child.id} placement is locked`, "component_locked");
        delete child.parentId;
        return;
      }
      case "delete_component": {
        const component = this.assertComponent(state, operation.id);
        if (component.locks.deletion) throw new WorkspaceStoreError(`Component ${component.id} deletion is locked`, "component_locked");
        const policy = operation.policy ?? "reject_if_referenced";
        operation.policy = policy;
        if (policy === "cascade" && operation.confirm !== true) {
          throw new WorkspaceStoreError("Cascade delete requires confirm: true", "confirmation_required");
        }
        this.deleteComponent(state, operation.id, policy);
        return;
      }
      case "invoke_component_action": {
        if (actionEffects.length >= MAX_ACTION_EFFECTS_PER_COMMIT) {
          throw new WorkspaceStoreError(
            `Workspace action routing exceeds ${MAX_ACTION_EFFECTS_PER_COMMIT} effects in one commit`,
            "event_routing_limit",
          );
        }
        const component = this.assertComponent(state, operation.id);
        const manifest = this.manifestFor(state, component);
        const action = manifest.actions[operation.action];
        if (!action) throw new WorkspaceStoreError(`Unknown action ${operation.action} for ${manifest.typeId}`, "unknown_component_action");
        const trustedHostSignal = manifest.trustTier === "builtin"
          && manifest.typeId === "spatial-entity"
          && operation.action === "complete_animation"
          && action.routable === false
          && (action.requiredPermissions ?? []).includes("host:signal")
          && hasPermission(authorization, "host:signal");
        const trustedVisibilityStop = internalVisibilityCancellation
          && manifest.trustTier === "builtin"
          && manifest.typeId === "spatial-entity"
          && operation.action === "stop_animation";
        if (component.locks.actions && !trustedHostSignal && !trustedVisibilityStop) {
          throw new WorkspaceStoreError(`Component ${component.id} actions are locked`, "component_locked");
        }
        if (manifest.typeId === "spatial-entity" && operation.action === "play_animation") {
          if (!replayingResolvedOperations) {
            const stage = stageComponent(state);
            if (component.visibility !== "visible" || !stage || stage.visibility !== "visible") {
              throw new WorkspaceStoreError(
                `Spatial animation ${component.id} requires both the entity and stage-3d to be visible`,
                "spatial_animation_not_renderable",
              );
            }
          }
          const assetId = component.props.assetId;
          const asset = typeof assetId === "string" ? DEFAULT_ASSET_REGISTRY.get(assetId) : null;
          const clip = operation.input.clip;
          if (!asset || typeof clip !== "string" || !asset.animations.includes(clip as never)) {
            throw new WorkspaceStoreError(
              `Asset ${String(assetId)} does not support animation ${String(clip)}`,
              "unsupported_asset_animation",
            );
          }
        }
        if (action.effectClass === "data_read") requirePermission(authorization, "effect:data_read");
        if (action.effectClass === "external_write") requirePermission(authorization, "effect:external_write");
        if (action.effectClass === "extension_install") requirePermission(authorization, "extension:install");
        for (const permission of action.requiredPermissions ?? []) requirePermission(authorization, permission);
        const effectiveTimeMs = assertSafeTime(operation.effective_time_ms ?? this.clock());
        operation.effective_time_ms = effectiveTimeMs;
        if (replayEffect && (replayEffect.componentId !== component.id || replayEffect.opId !== operation.op_id)) {
          throw new WorkspaceStoreError(`Resolved effect does not match ${operation.op_id}`, "invalid_resolved_effect");
        }
        const resolved = replayEffect
          ? {
            durableState: structuredClone(replayEffect.durableState),
            ...(replayEffect.visibility !== undefined
              ? { visibility: replayEffect.visibility }
              : {}),
            events: replayEffect.events.map((event) => ({
              id: event.id,
              event: event.event,
              payload: structuredClone(event.payload),
            })),
          }
          : resolveComponentAction(component, manifest, operation.action, operation.input, effectiveTimeMs);
        for (const event of resolved.events) {
          const eventSchema = manifest.events[event.event];
          if (!eventSchema) throw new WorkspaceStoreError(`Action emitted undeclared event ${event.event}`, "unknown_component_event");
          assertSchemaValue(eventSchema, event.payload, `Invalid ${manifest.typeId}.${event.event} event payload`);
        }
        this.effectiveRegistry(state).assertDurableState(component.type, resolved.durableState);
        component.durableState = structuredClone(resolved.durableState);
        if (resolved.visibility !== undefined) component.visibility = resolved.visibility;
        const effectCausation = causedBy ?? replayEffect?.causedBy;
        const appended = appendEvents(
          component.id,
          resolved.events,
          effectiveTimeMs,
          eventSource,
          effectCausation,
        );
        actionEffects.push({
          opId: operation.op_id,
          componentId: component.id,
          durableState: structuredClone(resolved.durableState),
          ...(resolved.visibility !== undefined ? { visibility: resolved.visibility } : {}),
          ...(effectCausation ? { causedBy: structuredClone(effectCausation) } : {}),
          events: appended.map((event) => ({
            id: event.id,
            event: event.event,
            payload: structuredClone(event.payload),
          })),
        });
        return;
      }
      case "upsert_resource": {
        try {
          if (!replayingResolvedOperations && authorization.actor === "agent") {
            assertWorkspaceResourceAgentWriteSafe(operation.resource);
          }
          if (
            !replayingResolvedOperations
            && operation.resource.connectorType === "inline.snapshot"
            && operation.resource.connectorVersion === "1.0.0"
          ) {
            operation.resource = normalizeInlineSnapshotResource(operation.resource, this.clock());
          }
          assertWorkspaceResourceSafe(operation.resource);
        } catch (error) {
          if (error instanceof WorkspaceResourceValidationError) {
            throw new WorkspaceStoreError(error.message, error.code);
          }
          throw error;
        }
        state.resources.set(operation.resource.id, structuredClone(operation.resource));
        return;
      }
      case "delete_resource": {
        if (!state.resources.has(operation.resource_id)) throw new WorkspaceStoreError(`Unknown resource ${operation.resource_id}`, "unknown_resource");
        const bindings = [...state.connections.values()].filter((connection) =>
          connection.kind === "resource_binding" && connection.resourceId === operation.resource_id,
        );
        for (const binding of bindings) {
          if (binding.kind !== "resource_binding") continue;
          this.assertComponent(state, binding.componentId);
        }
        if (bindings.length && !operation.cascade) {
          throw new WorkspaceStoreError(`Resource ${operation.resource_id} is still bound`, "resource_referenced");
        }
        for (const binding of bindings) this.removeConnection(state, binding.id);
        state.resources.delete(operation.resource_id);
        return;
      }
      case "bind_resource": {
        if (state.connections.has(operation.binding.id)) throw new WorkspaceStoreError(`Connection ${operation.binding.id} already exists`, "duplicate_connection_id");
        if (!state.resources.has(operation.binding.resourceId)) throw new WorkspaceStoreError(`Unknown resource ${operation.binding.resourceId}`, "unknown_resource");
        const component = this.assertComponent(state, operation.binding.componentId);
        if (component.locks.props) throw new WorkspaceStoreError(`Component ${component.id} properties are locked`, "component_locked");
        const manifest = this.manifestFor(state, component);
        if (
          resizePolicyForPlacement(manifest, component.placement).kind === "stage_dimensions"
          && operation.binding.targetProp === "dimensions"
        ) {
          throw new WorkspaceStoreError(
            "Stage dimensions cannot be changed by a resource binding; use resize_component",
            "resize_requires_resize_component",
          );
        }
        if (!manifest.writableProps.includes(operation.binding.targetProp)) {
          throw new WorkspaceStoreError(`Property ${operation.binding.targetProp} is not writable on ${manifest.typeId}`, "property_not_writable");
        }
        this.assertResourceBindingProjectable(state, component, manifest, operation.binding);
        state.connections.set(operation.binding.id, structuredClone(operation.binding));
        component.bindings.push(operation.binding.id);
        component.bindings.sort((left, right) => left.localeCompare(right));
        return;
      }
      case "unbind_resource": {
        const connection = state.connections.get(operation.binding_id);
        if (!connection || connection.kind !== "resource_binding") throw new WorkspaceStoreError(`Unknown binding ${operation.binding_id}`, "unknown_binding");
        this.assertComponent(state, connection.componentId);
        this.removeConnection(state, operation.binding_id);
        return;
      }
      case "connect_event": {
        if (state.connections.has(operation.connection.id)) throw new WorkspaceStoreError(`Connection ${operation.connection.id} already exists`, "duplicate_connection_id");
        const source = this.assertComponent(state, operation.connection.sourceComponentId);
        const target = this.assertComponent(state, operation.connection.targetComponentId);
        if (target.locks.actions) throw new WorkspaceStoreError(`Component ${target.id} actions are locked`, "component_locked");
        const sourceManifest = this.manifestFor(state, source);
        const targetManifest = this.manifestFor(state, target);
        const sourceEventSchema = sourceManifest.events[operation.connection.event];
        if (!sourceEventSchema) {
          throw new WorkspaceStoreError(`Unknown event ${operation.connection.event} for ${sourceManifest.typeId}`, "unknown_component_event");
        }
        if (!targetManifest.actions[operation.connection.action]) {
          throw new WorkspaceStoreError(`Unknown action ${operation.connection.action} for ${targetManifest.typeId}`, "unknown_component_action");
        }
        assertRoutableActionAuthorized(
          targetManifest.actions[operation.connection.action]!,
          authorization,
          `Event connection ${operation.connection.id}`,
        );
        assertEventConnectionTransition(
          operation.connection.transition,
          `Event connection ${operation.connection.id}`,
        );
        assertEventConnectionInputContract(
          operation.connection,
          sourceEventSchema,
          targetManifest.actions[operation.connection.action]!,
          `Event connection ${operation.connection.id} targeting ${targetManifest.typeId}.${operation.connection.action}`,
        );
        state.connections.set(operation.connection.id, structuredClone(operation.connection));
        try {
          validateWorkspaceGraphs(state);
        } catch (error) {
          throw new WorkspaceStoreError(
            error instanceof Error ? error.message : String(error),
            "graph_cycle",
          );
        }
        return;
      }
      case "disconnect_event": {
        const connection = state.connections.get(operation.connection_id);
        if (!connection || connection.kind !== "event_connection") throw new WorkspaceStoreError(`Unknown event connection ${operation.connection_id}`, "unknown_connection");
        state.connections.delete(operation.connection_id);
        return;
      }
      case "present_view": {
        for (const id of operation.view.componentIds) this.assertComponent(state, id);
        state.sharedViews.set(operation.view.id, structuredClone(operation.view));
        return;
      }
      case "clear_workspace": {
        for (const component of state.components.values()) {
          if (component.locks.deletion) throw new WorkspaceStoreError(`Component ${component.id} deletion is locked`, "component_locked");
        }
        state.components.clear();
        state.connections.clear();
        state.aliases.clear();
        state.sharedViews.clear();
        state.recipes.clear();
        if (operation.include_resources) state.resources.clear();
        state.registryDigest = this.effectiveRegistry(state).digest;
        return;
      }
    }
  }

  private deleteComponent(
    state: WorkspaceState,
    id: string,
    policy: "reject_if_referenced" | "cascade" | "orphan",
  ): void {
    const component = this.assertComponent(state, id);
    const children = [...state.components.values()].filter((item) => item.parentId === id);
    const anchors = [...state.components.values()].filter((item) => placementTarget(item.placement) === id);
    const basisDependents = component.type.typeId === "stage-3d"
      ? [...state.components.values()].filter((item) => item.id !== id && placementRequiresStage(item.placement))
      : [];
    const structuralDependents = [...new Map(
      [...children, ...anchors, ...basisDependents].map((item) => [item.id, item] as const),
    ).values()];
    const connections = [...state.connections.values()].filter((connection) =>
      connection.kind === "resource_binding"
        ? connection.componentId === id
        : connection.sourceComponentId === id || connection.targetComponentId === id,
    );
    const referencedByView = [...state.sharedViews.values()].some((view) => view.componentIds.includes(id));
    if (policy === "reject_if_referenced" && (structuralDependents.length || connections.length || referencedByView)) {
      throw new WorkspaceStoreError(`Component ${id} is still referenced`, "component_referenced");
    }
    if (policy === "orphan" && (anchors.length || basisDependents.length)) {
      throw new WorkspaceStoreError(`3D and anchored components require cascade deletion`, "component_referenced");
    }
    if (policy === "cascade") {
      for (const dependent of structuralDependents) {
        if (!state.components.has(dependent.id)) continue;
        if (dependent.locks.deletion) throw new WorkspaceStoreError(`Component ${dependent.id} deletion is locked`, "component_locked");
        this.deleteComponent(state, dependent.id, "cascade");
      }
    } else {
      for (const child of children) {
        if (child.locks.placement) throw new WorkspaceStoreError(`Component ${child.id} placement is locked`, "component_locked");
        delete child.parentId;
      }
    }
    for (const connection of connections) this.removeConnection(state, connection.id);
    for (const [alias, target] of state.aliases) if (target === id) state.aliases.delete(alias);
    for (const view of state.sharedViews.values()) view.componentIds = view.componentIds.filter((item) => item !== id);
    state.components.delete(id);
  }

  private removeConnection(state: WorkspaceState, id: string): void {
    const connection = state.connections.get(id);
    if (!connection) return;
    if (connection.kind === "resource_binding") {
      const component = state.components.get(connection.componentId);
      if (component) component.bindings = component.bindings.filter((bindingId) => bindingId !== id);
    }
    state.connections.delete(id);
  }

  private validateState(state: WorkspaceState): void {
    const spatialNodeCount = [...state.components.values()]
      .filter((component) => component.type.typeId === "spatial-entity").length;
    if (spatialNodeCount > MAX_WORKSPACE_SPATIAL_NODES) {
      throw new WorkspaceStoreError(
        `Workspace exceeds the ${MAX_WORKSPACE_SPATIAL_NODES} spatial-body analysis limit`,
        "spatial_capacity_exceeded",
      );
    }
    const capacities = [
      ["components", state.components.size, MAX_WORKSPACE_COMPONENTS],
      ["resources", state.resources.size, MAX_WORKSPACE_RESOURCES],
      ["connections", state.connections.size, MAX_WORKSPACE_CONNECTIONS],
      ["aliases", state.aliases.size, MAX_WORKSPACE_ALIASES],
      ["shared views", state.sharedViews.size, MAX_WORKSPACE_SHARED_VIEWS],
      ["recipes", state.recipes.size, MAX_WORKSPACE_RECIPES],
      ["history summaries", state.history.length, MAX_WORKSPACE_HISTORY_SUMMARIES],
    ] as const;
    for (const [label, count, limit] of capacities) {
      if (count > limit) {
        throw new WorkspaceStoreError(
          `Workspace exceeds the ${limit} ${label} limit`,
          "workspace_capacity_exceeded",
        );
      }
    }
    if (state.protocolVersion !== WORKSPACE_PROTOCOL_VERSION) {
      throw new WorkspaceStoreError(`Unsupported workspace protocol ${state.protocolVersion}`, "protocol_version_mismatch");
    }
    if (state.workspaceSchemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new WorkspaceStoreError(
        `Unsupported workspace schema ${state.workspaceSchemaVersion}`,
        "schema_version_mismatch",
      );
    }
    for (const [key, recipe] of state.recipes) {
      validateComponentRecipe(recipe);
      if (key !== recipeKey(recipe)) {
        throw new WorkspaceStoreError(`Recipe key ${key} does not match ${recipeKey(recipe)}`, "invalid_recipe_key");
      }
    }
    const registry = this.effectiveRegistry(state);
    if (registry.digest !== state.registryDigest) {
      throw new StaleRegistryDigestError(registry.digest, state.registryDigest);
    }
    for (const component of state.components.values()) {
      const manifest = registry.resolve(component.type);
      for (const lock of ["placement", "resize", "visualEffects", "props", "deletion", "actions"] as const) {
        if (typeof component.locks[lock] !== "boolean") {
          throw new WorkspaceStoreError(
            `Component ${component.id} has invalid ${lock} lock`,
            "invalid_component_locks",
          );
        }
      }
      if (!component.visualEffects) {
        throw new WorkspaceStoreError(
          `Component ${component.id} is missing visual effects`,
          "invalid_component_visual_effects",
        );
      }
      assertComponentVisualEffects(component.visualEffects);
      registry.assertProps(component.type, component.props);
      normalizeWebPanelProps(manifest, component.props);
      assertSpatialAssetProps(manifest, component.props);
      if (component.type.typeId === "spatial-entity") {
        if (component.props.collision !== undefined && !spatialCollisionConfigFromProps(component.props)) {
          throw new WorkspaceStoreError(
            `Spatial component ${component.id} has an invalid or ambiguous collision configuration`,
            "invalid_spatial_collision",
          );
        }
        if (component.props.physics !== undefined && !spatialPhysicsConfigFromProps(component.props)) {
          throw new WorkspaceStoreError(
            `Spatial component ${component.id} has an invalid or ambiguous physics configuration`,
            "invalid_spatial_physics",
          );
        }
      }
      registry.assertDurableState(component.type, component.durableState);
      this.assertPlacementAllowed(manifest, component.placement);
      if (component.placement.space === "world3d") {
        for (const axis of ["x", "y", "z"] as const) {
          assertFiniteBounded(
            component.placement.scale[axis],
            WORKSPACE_SCALE_MIN,
            WORKSPACE_SCALE_MAX,
            `placement.scale.${axis}`,
          );
        }
      }
      if (component.placement.size) {
        assertFiniteBounded(
          component.placement.size.width,
          WORKSPACE_BOX_SIZE_MIN,
          WORKSPACE_BOX_SIZE_MAX,
          "placement.size.width",
        );
        assertFiniteBounded(
          component.placement.size.height,
          WORKSPACE_BOX_SIZE_MIN,
          WORKSPACE_BOX_SIZE_MAX,
          "placement.size.height",
        );
      }
      assertComponentResizeGeometry(component, manifest);
      if (component.id === "" || component.label.length > 1_000) {
        throw new WorkspaceStoreError(`Invalid component identity ${component.id}`, "invalid_component");
      }
    }
    const stage = stageComponent(state);
    for (const component of state.components.values()) {
      if (
        isPlayingSpatialComponent(component)
        && (component.visibility !== "visible" || !stage || stage.visibility !== "visible")
      ) {
        throw new WorkspaceStoreError(
          `Spatial animation ${component.id} requires both the entity and stage-3d to be visible`,
          "spatial_animation_not_renderable",
        );
      }
    }
    for (const resource of state.resources.values()) {
      assertWorkspaceResourceSafe(resource);
    }
    const expectedBindings = new Map<string, string[]>();
    for (const connection of state.connections.values()) {
      this.validateConnection(state, registry, connection);
      if (connection.kind === "resource_binding") {
        const ids = expectedBindings.get(connection.componentId) ?? [];
        ids.push(connection.id);
        expectedBindings.set(connection.componentId, ids);
      }
    }
    for (const component of state.components.values()) {
      const expected = (expectedBindings.get(component.id) ?? [])
        .sort((left, right) => left.localeCompare(right));
      const actual = [...component.bindings].sort((left, right) => left.localeCompare(right));
      if (stableStringify(actual) !== stableStringify(expected)) {
        throw new WorkspaceStoreError(`Component ${component.id} binding index is inconsistent`, "invalid_binding_index");
      }
    }
    for (const [alias, id] of state.aliases) {
      if (!alias || !state.components.has(id)) throw new WorkspaceStoreError(`Alias ${alias} is dangling`, "dangling_alias");
    }
    for (const view of state.sharedViews.values()) {
      for (const id of view.componentIds) if (!state.components.has(id)) throw new WorkspaceStoreError(`View ${view.id} references missing ${id}`, "dangling_view_reference");
    }
    try {
      validateWorkspaceGraphs(state);
    } catch (error) {
      throw new WorkspaceStoreError(error instanceof Error ? error.message : String(error), "graph_cycle");
    }
    const spatialConflicts = findBlockingSpatialCollisions(state);
    if (spatialConflicts.length) throw new SpatialCollisionStoreError(spatialConflicts.slice(0, 20));
    const physicsIssues = enforcedPhysicsIssues(state);
    if (physicsIssues.length) throw new PhysicsValidationStoreError(physicsIssues.slice(0, 20));
  }

  private validateConnection(
    state: WorkspaceState,
    registry: ComponentRegistry,
    connection: WorkspaceConnection,
  ): void {
    if (connection.kind === "resource_binding") {
      if (!state.resources.has(connection.resourceId)) throw new WorkspaceStoreError(`Binding ${connection.id} has missing resource`, "dangling_connection");
      const component = state.components.get(connection.componentId);
      if (!component) throw new WorkspaceStoreError(`Binding ${connection.id} has missing component`, "dangling_connection");
      const manifest = registry.resolve(component.type);
      if (
        resizePolicyForPlacement(manifest, component.placement).kind === "stage_dimensions"
        && connection.targetProp === "dimensions"
      ) {
        throw new WorkspaceStoreError(
          `Binding ${connection.id} cannot target resize geometry`,
          "resize_requires_resize_component",
        );
      }
      if (!manifest.writableProps.includes(connection.targetProp)) throw new WorkspaceStoreError(`Binding ${connection.id} targets non-writable prop`, "property_not_writable");
      return;
    }
    const source = state.components.get(connection.sourceComponentId);
    const target = state.components.get(connection.targetComponentId);
    if (!source || !target) throw new WorkspaceStoreError(`Event connection ${connection.id} is dangling`, "dangling_connection");
    const sourceEventSchema = registry.resolve(source.type).events[connection.event];
    if (!sourceEventSchema) throw new WorkspaceStoreError(`Event connection ${connection.id} has unknown event`, "unknown_component_event");
    const targetManifest = registry.resolve(target.type);
    const targetAction = targetManifest.actions[connection.action];
    if (!targetAction) throw new WorkspaceStoreError(`Event connection ${connection.id} has unknown action`, "unknown_component_action");
    assertRoutableEffectClass(targetAction, `Event connection ${connection.id}`);
    assertEventConnectionTransition(connection.transition, `Event connection ${connection.id}`);
    assertEventConnectionInputContract(
      connection,
      sourceEventSchema,
      targetAction,
      `Event connection ${connection.id} targeting ${targetManifest.typeId}.${connection.action}`,
    );
  }

  private assertResourceBindingProjectable(
    state: WorkspaceState,
    component: ComponentInstance,
    manifest: ComponentManifest,
    binding: ResourceBinding,
  ): void {
    if (binding.mode === "live") {
      throw new WorkspaceStoreError(
        `Live resource binding ${binding.id} is unavailable until a trusted connector runtime is configured`,
        "live_binding_unavailable",
      );
    }
    if (binding.enabled) {
      const duplicate = [...state.connections.values()].find((connection) =>
        connection.kind === "resource_binding"
        && connection.id !== binding.id
        && connection.enabled
        && connection.componentId === binding.componentId
        && connection.targetProp === binding.targetProp,
      );
      if (duplicate) {
        throw new WorkspaceStoreError(
          `Enabled binding ${duplicate.id} already targets ${binding.componentId}.${binding.targetProp}`,
          "duplicate_binding_target",
        );
      }
    }
    const resource = state.resources.get(binding.resourceId);
    if (!resource) {
      throw new WorkspaceStoreError(`Unknown resource ${binding.resourceId}`, "unknown_resource");
    }
    const validationBinding: ResourceBinding = { ...structuredClone(binding), enabled: true };
    const resolution = resolveWorkspaceResourceBindings({
      components: [{
        id: component.id,
        props: component.props,
        propsSchema: manifest.propsSchema,
        writableProps: manifest.writableProps,
      }],
      resources: new Map([[resource.id, resource]]),
      connections: new Map([[validationBinding.id, validationBinding]]),
    });
    const blocking = resolution.diagnostics.find((diagnostic) =>
      diagnostic.bindingId === binding.id && diagnostic.severity === "error",
    );
    if (blocking) {
      throw new WorkspaceStoreError(blocking.message, blocking.code);
    }
  }

  private emit(delta: WorkspaceDelta, events: readonly WorkspaceEvent[]): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state, structuredClone(delta), structuredClone(events));
    }
  }
}
