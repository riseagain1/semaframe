import type {
  ComponentId,
  ComponentLocks,
  ComponentPlacement,
  ComponentRecipe,
  ComponentResize,
  ComponentVisualEffects,
  ComponentTypeRef,
  ComponentVisibility,
  JSONObject,
  World3DPlacement,
} from "../components/componentTypes";
import type { ModelDefinitionRef } from "../modeling/modelDefinitions";
import type {
  EventConnection,
  ResourceBinding,
  ResourceId,
  WorkspaceResource,
} from "../data/dataTypes";

export const LEGACY_WORKSPACE_PROTOCOL_VERSION = "1.0" as const;
export const LEGACY_WORKSPACE_SCHEMA_VERSION = "1.0" as const;
export const PREVIOUS_WORKSPACE_PROTOCOL_VERSION = "1.1" as const;
export const PREVIOUS_WORKSPACE_SCHEMA_VERSION = "1.1" as const;
export const WORKSPACE_PROTOCOL_VERSION = "1.2" as const;
export const WORKSPACE_SCHEMA_VERSION = "1.2" as const;
export const MAX_WORKSPACE_OPERATIONS = 100;
export const MAX_WORKSPACE_BATCH_BYTES = 1_048_576;
export const MAX_WORKSPACE_JSON_DEPTH = 32;

export type WorkspaceProtocolVersion =
  | typeof LEGACY_WORKSPACE_PROTOCOL_VERSION
  | typeof PREVIOUS_WORKSPACE_PROTOCOL_VERSION
  | typeof WORKSPACE_PROTOCOL_VERSION;
export type WorkspaceSchemaVersion =
  | typeof LEGACY_WORKSPACE_SCHEMA_VERSION
  | typeof PREVIOUS_WORKSPACE_SCHEMA_VERSION
  | typeof WORKSPACE_SCHEMA_VERSION;

export type WorkspaceActor = "user" | "agent" | "system" | "migration";

export type WorkspacePermission =
  | "workspace:write"
  | "component:create"
  | "component:update"
  | "component:delete"
  | "component:invoke"
  | "component:recipe_define"
  | "connector:write"
  | "connector:delete"
  | "connector:bind"
  | "event:connect"
  | "view:present"
  | "workspace:clear"
  | "effect:data_read"
  | "effect:external_write"
  | "extension:install";

export type WorkspaceAuthorization = {
  actor: WorkspaceActor;
  permissions: readonly (WorkspacePermission | "*")[];
};

export interface WorkspaceOperationBase {
  op_id: string;
}

/**
 * Declarative presentation timing for a single committed operation.
 *
 * Transitions are renderer hints only: the store still commits the final
 * semantic value once, and renderers interpolate without producing per-frame
 * Workspace revisions.
 */
export type WorkspaceTransitionEasing = "linear" | "ease_in" | "ease_out" | "ease_in_out";

export type TransitionSpec = {
  durationMs: number;
  delayMs?: number;
  easing: WorkspaceTransitionEasing;
};

export interface DefineComponentRecipeOperation extends WorkspaceOperationBase {
  op: "define_component_recipe";
  recipe: ComponentRecipe;
}

export interface CreateComponentOperation extends WorkspaceOperationBase {
  op: "create_component";
  id: ComponentId;
  component_type: ComponentTypeRef;
  label?: string;
  props?: JSONObject;
  durable_state?: JSONObject;
  placement: ComponentPlacement;
  parent_id?: ComponentId;
  tags?: string[];
  visibility?: ComponentVisibility;
  visual_effects?: ComponentVisualEffects;
  locks?: Partial<ComponentLocks>;
  transition?: TransitionSpec;
}

export type ComponentUpdatePatch = {
  label?: string;
  props?: JSONObject;
  tags?: string[];
  visibility?: ComponentVisibility;
  locks?: Partial<ComponentLocks>;
};

export interface UpdateComponentOperation extends WorkspaceOperationBase {
  op: "update_component";
  id: ComponentId;
  patch: ComponentUpdatePatch;
  transition?: TransitionSpec;
}

/** Explicitly repin one legacy built-in to its exact current built-in manifest. */
export interface UpgradeComponentManifestOperation extends WorkspaceOperationBase {
  op: "upgrade_component_manifest";
  id: ComponentId;
  component_type: ComponentTypeRef;
}

export interface DeleteComponentOperation extends WorkspaceOperationBase {
  op: "delete_component";
  id: ComponentId;
  policy?: "reject_if_referenced" | "cascade" | "orphan";
  confirm?: true;
}

export interface PlaceComponentOperation extends WorkspaceOperationBase {
  op: "place_component";
  id: ComponentId;
  placement: ComponentPlacement;
  transition?: TransitionSpec;
}

export interface ResizeComponentOperation extends WorkspaceOperationBase {
  op: "resize_component";
  id: ComponentId;
  /** Absolute canonical geometry; relative deltas are intentionally unsupported. */
  resize: ComponentResize;
  transition?: TransitionSpec;
}

export interface SetComponentVisualEffectsOperation extends WorkspaceOperationBase {
  op: "set_component_visual_effects";
  id: ComponentId;
  /** Absolute canonical presentation; partial/delta updates are unsupported. */
  visual_effects: ComponentVisualEffects;
  transition?: TransitionSpec;
}

export type ComponentReparentTransformMode = "preserve_local" | "preserve_world";

export interface AttachComponentOperation extends WorkspaceOperationBase {
  op: "attach_component";
  child_id: ComponentId;
  parent_id: ComponentId;
  /** Defaults to preserve_local for protocol compatibility. */
  transform_mode?: ComponentReparentTransformMode;
  transition?: TransitionSpec;
}

export interface DetachComponentOperation extends WorkspaceOperationBase {
  op: "detach_component";
  child_id: ComponentId;
  /** Defaults to preserve_local for protocol compatibility. */
  transform_mode?: ComponentReparentTransformMode;
  transition?: TransitionSpec;
}

export interface InvokeComponentActionOperation extends WorkspaceOperationBase {
  op: "invoke_component_action";
  id: ComponentId;
  action: string;
  input: JSONObject;
  /** Resolved by the engine on first commit and retained for deterministic replay. */
  effective_time_ms?: number;
  transition?: TransitionSpec;
}

export interface UpsertResourceOperation extends WorkspaceOperationBase {
  op: "upsert_resource";
  resource: WorkspaceResource;
}

export interface DeleteResourceOperation extends WorkspaceOperationBase {
  op: "delete_resource";
  resource_id: ResourceId;
  cascade?: boolean;
}

export interface BindResourceOperation extends WorkspaceOperationBase {
  op: "bind_resource";
  binding: ResourceBinding;
}

export interface UnbindResourceOperation extends WorkspaceOperationBase {
  op: "unbind_resource";
  binding_id: string;
}

export interface ConnectEventOperation extends WorkspaceOperationBase {
  op: "connect_event";
  connection: EventConnection;
}

export interface DisconnectEventOperation extends WorkspaceOperationBase {
  op: "disconnect_event";
  connection_id: string;
}

export type SharedView = {
  id: string;
  label: string;
  componentIds: ComponentId[];
  camera?: JSONObject;
};

export interface PresentViewOperation extends WorkspaceOperationBase {
  op: "present_view";
  view: SharedView;
}

export interface ClearWorkspaceOperation extends WorkspaceOperationBase {
  op: "clear_workspace";
  confirm: true;
  /** Resources are retained unless explicitly included. */
  include_resources?: boolean;
}

export interface PublishModelOperation extends WorkspaceOperationBase {
  op: "publish_model";
  model_id: string;
  version: string;
  display_name: string;
  root_id: ComponentId;
}

export interface InstantiateModelOperation extends WorkspaceOperationBase {
  op: "instantiate_model";
  model: ModelDefinitionRef;
  /** Exact source-node ID to reserved Workspace component ID mapping. */
  id_map: Readonly<Record<string, string>>;
  root_placement: World3DPlacement;
}

export interface DeleteModelDefinitionOperation extends WorkspaceOperationBase {
  op: "delete_model_definition";
  model: ModelDefinitionRef;
  confirm: true;
}

export type WorkspaceOperation =
  | DefineComponentRecipeOperation
  | CreateComponentOperation
  | UpdateComponentOperation
  | UpgradeComponentManifestOperation
  | DeleteComponentOperation
  | PlaceComponentOperation
  | ResizeComponentOperation
  | SetComponentVisualEffectsOperation
  | AttachComponentOperation
  | DetachComponentOperation
  | InvokeComponentActionOperation
  | UpsertResourceOperation
  | DeleteResourceOperation
  | BindResourceOperation
  | UnbindResourceOperation
  | ConnectEventOperation
  | DisconnectEventOperation
  | PresentViewOperation
  | PublishModelOperation
  | InstantiateModelOperation
  | DeleteModelDefinitionOperation
  | ClearWorkspaceOperation;

export type WorkspaceOperationName = WorkspaceOperation["op"];

export type WorkspaceCommandBatch = {
  protocol_version: WorkspaceProtocolVersion;
  request_id: string;
  workspace_id: string;
  input_revision: number;
  base_workspace_revision: number;
  registry_digest: string;
  mode: "commit";
  operations: WorkspaceOperation[];
};

export type WorkspaceEvent = {
  id: string;
  cursor: number;
  workspaceRevision: number;
  componentId?: ComponentId;
  event: string;
  payload: JSONObject;
  source: WorkspaceActor | "binding";
  effectiveTimeMs: number;
  /** Present when an event was emitted by an action reached through an event connection. */
  causedBy?: {
    eventId: string;
    connectionId: string;
  };
};

export type WorkspaceAppliedBatchSummary = {
  requestId: string;
  inputRevision: number;
  baseWorkspaceRevision: number;
  resultingWorkspaceRevision: number;
  resultingRegistryDigest: string;
  operationIds: string[];
  eventIds: string[];
};

export type WorkspaceCommandRecord = {
  requestId: string;
  actor: WorkspaceActor;
  inputRevision: number;
  baseWorkspaceRevision: number;
  inputRegistryDigest: string;
  resultingRegistryDigest: string;
  resolvedOperations: WorkspaceOperation[];
  resolvedEvents: WorkspaceEvent[];
  /** Resolved host effects make action replay independent of clocks or component code. */
  resolvedActionEffects?: Array<{
    opId: string;
    componentId: ComponentId;
    durableState: JSONObject;
    visibility?: ComponentVisibility;
    causedBy?: {
      eventId: string;
      connectionId: string;
    };
    events: Array<{ id: string; event: string; payload: JSONObject }>;
  }>;
  resultingWorkspaceRevision: number;
};

export type WorkspaceDelta = {
  fromRevision: number;
  toRevision: number;
  added: ComponentId[];
  updated: ComponentId[];
  removed: ComponentId[];
  resourcesChanged: string[];
  connectionsChanged: string[];
  viewsChanged: string[];
  modelsChanged: string[];
  registryChanged: boolean;
};
