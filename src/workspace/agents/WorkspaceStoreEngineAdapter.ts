import { DEFAULT_ASSET_REGISTRY } from "../../assets/AssetRegistry";
import {
  DEFAULT_COMPONENT_VISUAL_EFFECTS,
  bindablePropsForManifest,
  resizePolicyForPlacement,
  type ComponentInstance,
  type ComponentManifest,
  type ComponentResizePolicy,
  type JSONObject,
} from "../components/componentTypes";
import { ComponentRegistryError } from "../components/ComponentRegistry";
import { workspaceConnectorCapabilityManifest } from "../data/connectorCatalog";
import { parseParametricPrimitive } from "../modeling/parametricGeometry";
import {
  CadDocumentError,
  CadPartEvaluationError,
  cadPartDefinitionDigest,
  parseCadEvaluationEvidence,
  parseCadPartDefinition,
  type CadPartDefinitionV1,
} from "../modeling/cad";
import {
  CadKernelError,
  CAD_KERNEL_LIMITS,
  createCadWorkerKernel,
  type CadKernel,
} from "../modeling";
import {
  isCanonicalHostFeedResource,
  isCanonicalInlineSnapshotResource,
} from "../data/resourceSecurity";
import type { EventConnection } from "../data/dataTypes";
import {
  WORKSPACE_PROTOCOL_VERSION,
  type WorkspaceAuthorization,
  type WorkspaceCommandBatch,
  type WorkspaceEvent as CoreWorkspaceEvent,
  type WorkspaceOperationName,
  type WorkspacePermission,
} from "../protocol/workspaceTypes";
import {
  validateWorkspaceCommandBatch,
  WorkspaceValidationError,
} from "../protocol/validateWorkspaceBatch";
import { ComponentActionError } from "../runtime/componentActions";
import {
  buildSemaFrameSpatialGraph,
  SEMAFRAME_SPATIAL_GRAPH_VERSION,
  parseSpatialCollisionConfig,
  querySpatialPlacement,
  spatialCollisionConfigFromProps,
  type SpatialCollisionConfig,
  type SpatialPlacementCandidate,
} from "../spatial";
import {
  isPhysicalSpatialTypeId,
  isSpatialRenderTypeId,
} from "../spatial/spatialComponentKinds";
import {
  buildPhysicsValidationReport,
  parseSpatialPhysicsConfig,
  queryStablePlacement as queryPhysicsStablePlacement,
  simulatePhysicsSettle,
  type PhysicsPlacementCandidate,
  type PhysicsBodyReport,
  type PhysicsValidationReport,
} from "../physics";
import {
  StaleRegistryDigestError,
  StaleWorkspaceRevisionError,
  SpatialCollisionStoreError,
  PhysicsValidationStoreError,
  WorkspacePermissionError,
  WorkspaceStore,
  WorkspaceStoreError,
} from "../state/WorkspaceStore";
import type { WorkspaceState } from "../state/workspaceState";
import {
  WORKSPACE_PERMISSION_SCOPES,
  WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES,
  WORKSPACE_COMPONENT_INSPECTION_WRAPPER_RESERVE_BYTES,
  WORKSPACE_MODEL_INSPECTION_MAX_BYTES,
  WORKSPACE_MODEL_INSPECTION_WRAPPER_RESERVE_BYTES,
  WORKSPACE_RESOURCE_SNAPSHOT_MAX_BYTES,
  WORKSPACE_RESOURCE_SNAPSHOT_WRAPPER_RESERVE_BYTES,
  type JSONValue,
  type WorkspaceAgentPrincipal,
  type WorkspaceCommitReceipt,
  type WorkspaceComponentStateView,
  type WorkspaceEnginePort,
  WorkspaceEngineError,
  type WorkspaceEvent,
  type WorkspaceEventPage,
  type WorkspaceHistoryReceipt,
  type WorkspaceModelDefinitionView,
  type WorkspacePermissionScope,
  type WorkspacePreparedUpdate,
  type WorkspaceRealityAssetView,
  type WorkspaceResourceSnapshotView,
  type WorkspaceSpatialPlacementView,
  type WorkspaceSpatialStateView,
  type WorkspacePhysicsPlacementView,
  type WorkspacePhysicsSimulationView,
  type WorkspacePhysicsStateView,
  type WorkspaceStateView,
} from "./contracts";
import { stableJson } from "./guide";

const MAX_SUMMARY_COMPONENTS = 60;
const MAX_SUMMARY_RESOURCES = 20;
const MAX_SUMMARY_BYTES = 300_000;
const MAX_CAPABILITY_BYTES = 200_000;
const MAX_EVENT_PAGE = 200;
const MAX_COMPACT_NODES = 800;
const MAX_AGENT_CAD_EVALUATIONS_PER_BATCH = 8;
const MAX_AGENT_CAD_EVALUATION_BATCH_MS = 60_000;
const MAX_AGENT_CAD_EVALUATION_OPERATION_MS = 30_000;

export const WORKSPACE_OPERATION_NAMES = [
  "define_component_recipe",
  "create_component",
  "update_component",
  "upgrade_component_manifest",
  "delete_component",
  "place_component",
  "resize_component",
  "set_component_visual_effects",
  "attach_component",
  "detach_component",
  "invoke_component_action",
  "upsert_resource",
  "delete_resource",
  "bind_resource",
  "unbind_resource",
  "connect_event",
  "disconnect_event",
  "present_view",
  "publish_model",
  "instantiate_model",
  "delete_model_definition",
  "clear_workspace",
] as const satisfies readonly WorkspaceOperationName[];

const CORE_PERMISSIONS = new Set<WorkspacePermission>([
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
]);

export type WorkspaceStoreEngineAdapterOptions = Readonly<{
  requestId?: (inputRevision: number) => string;
  maxSummaryComponents?: number;
  maxSummaryResources?: number;
  maxSummaryBytes?: number;
  maxCapabilityBytes?: number;
  maxComponentInspectionBytes?: number;
  maxModelInspectionBytes?: number;
  maxResourceSnapshotBytes?: number;
  /** Test/controlled-host seam. Production browser CAD uses a disposable Worker. */
  cadKernelFactory?: () => Promise<CadKernel>;
}>;

type StoredPreparation = {
  value: WorkspacePreparedUpdate;
  fingerprint: string;
  principal?: Readonly<{ sessionId: string; clientId: string }>;
  batchFingerprint?: string;
  receipt?: WorkspaceCommitReceipt;
};

function defaultRequestId(inputRevision: number): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new WorkspaceEngineError("engine_error", "Secure random UUID support is required");
  }
  return `workspace_req_${String(inputRevision).padStart(6, "0")}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

function asJSON(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function spatialConflictForAgent(conflict: {
  componentId: string;
  conflictsWith: string;
  overlap: unknown;
}) {
  return {
    component_id: conflict.componentId,
    conflicts_with: conflict.conflictsWith,
    overlap: conflict.overlap,
  };
}

function spatialGraphForAgent(snapshot: ReturnType<typeof buildSemaFrameSpatialGraph>): JSONValue {
  return asJSON({
    format: snapshot.format,
    version: snapshot.version,
    workspace_id: snapshot.workspaceId,
    workspace_revision: snapshot.workspaceRevision,
    coordinate_system: {
      units: snapshot.coordinateSystem.units,
      up_axis: snapshot.coordinateSystem.upAxis,
      forward_axis: snapshot.coordinateSystem.forwardAxis,
    },
    ...(snapshot.stage ? {
      stage: {
        component_id: snapshot.stage.componentId,
        visibility: snapshot.stage.visibility,
        dimensions: snapshot.stage.dimensions,
        ground_height: snapshot.stage.groundHeight,
        ground_polygon: snapshot.stage.groundPolygon,
      },
    } : {}),
    mode: snapshot.mode,
    ...(snapshot.sinceRevision === undefined ? {} : { since_revision: snapshot.sinceRevision }),
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      prim_path: node.primPath,
      label: node.label,
      ...(node.parentId ? { parent_id: node.parentId } : {}),
      node_kind: node.nodeKind,
      ...(node.assetId ? { asset_id: node.assetId } : {}),
      entity_kind: node.entityKind,
      ...(node.geometry ? {
        geometry: {
          kind: node.geometry.kind,
          digest: node.geometry.digest,
          parameters: node.geometry.parameters,
          dimensions_m: node.geometry.dimensionsM,
          local_bounds: node.geometry.localBounds,
          volume_m3: node.geometry.volumeM3,
          collider: node.geometry.collider,
          ...(node.geometry.material ? { material: node.geometry.material } : {}),
        },
      } : {}),
      ...(node.cad ? {
        cad: {
          definition_digest: node.cad.definitionDigest,
          evaluator_version: node.cad.evaluatorVersion,
          exactness: node.cad.exactness,
          body_count: node.cad.bodyCount,
          local_bounds: node.cad.localBounds,
          volume_m3: node.cad.volumeM3,
          surface_area_m2: node.cad.surfaceAreaM2,
          center_of_mass_m: node.cad.centerOfMassM,
          diagnostics: node.cad.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: diagnostic.message,
            ...(diagnostic.featureId ? { feature_id: diagnostic.featureId } : {}),
          })),
        },
      } : {}),
      ...(node.assembly ? {
        assembly: {
          collision_policy: node.assembly.collisionPolicy,
          ...(node.assembly.modelRef ? { model_ref: node.assembly.modelRef } : {}),
        },
      } : {}),
      ...(node.reality ? {
        reality: {
          ...(node.reality.assetId ? { asset_id: node.reality.assetId } : {}),
          ...(node.reality.digest ? { digest: node.reality.digest } : {}),
          descriptor_available: node.reality.descriptorAvailable,
          binary_availability: node.reality.binaryAvailability,
          ...(node.reality.format ? { format: node.reality.format } : {}),
          ...(node.reality.splatCount === undefined ? {} : { splat_count: node.reality.splatCount }),
          engineering_authority: node.reality.engineeringAuthority,
          calibration_status: node.reality.calibrationStatus,
          source_coordinate_system: node.reality.sourceCoordinateSystem,
          target_coordinate_system: node.reality.targetCoordinateSystem,
          ...(node.reality.metersPerSourceUnit === undefined
            ? {}
            : { meters_per_source_unit: node.reality.metersPerSourceUnit }),
          bounds_are_metric: node.reality.boundsAreMetric,
          semantic_proxy_ids: node.reality.semanticProxyIds,
        },
      } : {}),
      assembly_ancestry: node.assemblyAncestry.map((ancestor) => ({
        id: ancestor.id,
        collision_policy: ancestor.collisionPolicy,
        ...(ancestor.modelRef ? { model_ref: ancestor.modelRef } : {}),
      })),
      visibility: node.visibility,
      local_placement: node.localPlacement,
      world_transform: {
        position: node.worldTransform.position,
        rotation_quaternion: node.worldTransform.rotationQuaternion,
        scale: node.worldTransform.scale,
        matrix: node.worldTransform.matrix,
      },
      world_bounds: node.worldBounds,
      ...(node.collision ? {
        collision: {
          enabled: node.collision.enabled,
          role: node.collision.role,
          shape: node.collision.shape,
          source: node.collision.source,
          margin: node.collision.margin,
          center: node.collision.center,
          half_extents: node.collision.halfExtents,
          axes: node.collision.axes,
          aabb: node.collision.aabb,
          parts: node.collision.parts.map((part) => ({
            id: part.id,
            source: part.source,
            center: part.center,
            half_extents: part.halfExtents,
            axes: part.axes,
            aabb: part.aabb,
          })),
        },
      } : {}),
      ...(node.physics ? {
        physics: {
          enabled: node.physics.enabled,
          body_type: node.physics.bodyType,
          mass_kg: node.physics.massKg,
          mass_source: node.physics.massSource,
          ...(node.physics.geometryVolumeM3 === undefined
            ? {}
            : { geometry_volume_m3: node.physics.geometryVolumeM3 }),
          center_of_mass: node.physics.centerOfMass,
          friction: node.physics.friction,
          restitution: node.physics.restitution,
          gravity_scale: node.physics.gravityScale,
          stability_mode: node.physics.stabilityMode,
          constraint_count: node.physics.constraintCount,
        },
      } : {}),
      relations: node.relations,
    })),
    removed_node_ids: snapshot.removedNodeIds,
    collision_conflicts: snapshot.collisionConflicts.map(spatialConflictForAgent),
    collision_conflicts_truncated: snapshot.collisionConflictsTruncated,
    omitted_node_count: snapshot.omittedNodeCount,
  });
}

function physicsBodyForAgent(body: PhysicsBodyReport) {
  return {
      component_id: body.componentId,
      enabled: body.enabled,
      body_type: body.bodyType,
      mass_kg: body.massKg,
      ...(body.massSource ? { mass_source: body.massSource } : {}),
      ...(body.geometryVolumeM3 === undefined ? {} : { geometry_volume_m3: body.geometryVolumeM3 }),
      center_of_mass_world: body.centerOfMassWorld,
      friction: body.friction,
      restitution: body.restitution,
      gravity_scale: body.gravityScale,
      stability_mode: body.stabilityMode,
      stable: body.stable,
      grounded: body.grounded,
      stability_reason: body.stabilityReason,
      support_polygon: body.supportPolygon,
      stability_margin_m: body.stabilityMarginM,
      supports: body.supports.map((support) => ({
        component_id: support.componentId,
        kind: support.kind,
        ...(support.supportingComponentId ? { supporting_component_id: support.supportingComponentId } : {}),
        contact_height: support.contactHeight,
        contact_area_m2: support.contactAreaM2,
        grounded: support.grounded,
      })),
      constraints: body.constraints.map((constraint) => ({
        id: constraint.id,
        type: constraint.type,
        target_id: constraint.targetId,
        anchor: constraint.anchor,
        target_anchor: constraint.targetAnchor,
        axis: constraint.axis,
        ...(constraint.limits ? { limits: constraint.limits } : {}),
        enabled: constraint.enabled,
      })),
    };
}

function physicsReportForAgent(report: PhysicsValidationReport): JSONValue {
  const bodies = report.bodies.slice(0, 500);
  const issues = report.issues.slice(0, 500);
  return asJSON({
    format: report.format,
    version: report.version,
    model: report.model,
    workspace_id: report.workspaceId,
    workspace_revision: report.workspaceRevision,
    feasible: report.feasible,
    bodies: bodies.map(physicsBodyForAgent),
    issues: issues.map((issue) => ({
      code: issue.code,
      component_id: issue.componentId,
      ...(issue.relatedComponentId ? { related_component_id: issue.relatedComponentId } : {}),
      ...(issue.constraintId ? { constraint_id: issue.constraintId } : {}),
      message: issue.message,
    })),
    omitted_body_count: report.bodies.length - bodies.length,
    omitted_issue_count: report.issues.length - issues.length,
    complete: report.bodies.length === bodies.length && report.issues.length === issues.length,
  });
}

function physicsSettleForAgent(result: ReturnType<typeof simulatePhysicsSettle>): JSONValue {
  return asJSON({
    format: result.format,
    version: result.version,
    model: result.model,
    workspace_id: result.workspaceId,
    workspace_revision: result.workspaceRevision,
    duration_ms: result.durationMs,
    time_step_ms: result.timeStepMs,
    applied_steps: result.appliedSteps,
    modeled_properties: result.modeledProperties,
    ignored_properties: result.ignoredProperties,
    mutates_workspace: result.mutatesWorkspace,
    feasible: result.feasible,
    proposals: result.proposals.map((proposal) => ({
      component_id: proposal.componentId,
      from: proposal.from,
      to: proposal.to,
      drop_distance_m: proposal.dropDistanceM,
      settled: proposal.settled,
    })),
    report: physicsReportForAgent(result.report),
  });
}

type ParsedSpatialPlacementCandidate = Omit<SpatialPlacementCandidate, "cad"> & Readonly<{
  cadDefinition?: CadPartDefinitionV1;
}>;

function parseSpatialPlacementCandidate(value: unknown): ParsedSpatialPlacementCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceEngineError("invalid_spatial_candidate", "candidate must be an object", {
      retryable: true,
      requiredAction: "query_spatial_placement",
    });
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "component_id", "componentId", "asset_id", "assetId", "entity_kind", "entityKind",
    "geometry", "cad_definition", "cadDefinition", "placement", "collision", "physics",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new WorkspaceEngineError("invalid_spatial_candidate", "candidate contains unsupported fields", { retryable: true });
  }
  const placement = record.placement;
  if (!placement || typeof placement !== "object" || Array.isArray(placement)) {
    throw new WorkspaceEngineError("invalid_spatial_candidate", "candidate.placement must be world3d", { retryable: true });
  }
  const placementRecord = placement as Record<string, unknown>;
  const vector = (candidate: unknown, field: string, min: number, max: number) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new WorkspaceEngineError("invalid_spatial_candidate", `${field} must be a vector`, { retryable: true });
    }
    const result = candidate as Record<string, unknown>;
    if (Object.keys(result).some((key) => key !== "x" && key !== "y" && key !== "z")) {
      throw new WorkspaceEngineError("invalid_spatial_candidate", `${field} contains unsupported fields`, { retryable: true });
    }
    for (const axis of ["x", "y", "z"] as const) {
      if (typeof result[axis] !== "number" || !Number.isFinite(result[axis]) || result[axis] < min || result[axis] > max) {
        throw new WorkspaceEngineError("invalid_spatial_candidate", `${field}.${axis} is out of bounds`, { retryable: true });
      }
    }
    return { x: result.x as number, y: result.y as number, z: result.z as number };
  };
  if (placementRecord.space !== "world3d"
    || Object.keys(placementRecord).some((key) => !["space", "position", "rotation", "scale"].includes(key))) {
    throw new WorkspaceEngineError("invalid_spatial_candidate", "candidate.placement must be an exact world3d placement", { retryable: true });
  }
  let collision: SpatialCollisionConfig | undefined;
  if (record.collision !== undefined) {
    collision = parseSpatialCollisionConfig(record.collision);
    if (!collision) {
      throw new WorkspaceEngineError("invalid_spatial_candidate", "candidate.collision is invalid", { retryable: true });
    }
  }
  const componentId = record.component_id ?? record.componentId;
  const assetId = record.asset_id ?? record.assetId;
  const entityKind = record.entity_kind ?? record.entityKind;
  let geometry;
  if (record.geometry !== undefined) {
    try {
      geometry = parseParametricPrimitive(record.geometry);
    } catch (error) {
      throw new WorkspaceEngineError(
        "invalid_spatial_candidate",
        error instanceof Error ? `candidate.geometry is invalid: ${error.message}` : "candidate.geometry is invalid",
        { retryable: true, requiredAction: "query_spatial_placement" },
      );
    }
  }
  if (record.cad_definition !== undefined && record.cadDefinition !== undefined) {
    throw new WorkspaceEngineError(
      "invalid_spatial_candidate",
      "candidate must not provide both cad_definition and cadDefinition",
      { retryable: true, requiredAction: "query_spatial_placement" },
    );
  }
  const rawCadDefinition = record.cad_definition ?? record.cadDefinition;
  const cadDefinition = rawCadDefinition === undefined
    ? undefined
    : parseCadPartDefinition(rawCadDefinition);
  if (componentId !== undefined && (typeof componentId !== "string" || !componentId)) {
    throw new WorkspaceEngineError("invalid_spatial_candidate", "component_id must be a non-empty string", { retryable: true });
  }
  if (assetId !== undefined && (typeof assetId !== "string" || !assetId)) {
    throw new WorkspaceEngineError("invalid_spatial_candidate", "asset_id must be a non-empty string", { retryable: true });
  }
  if (entityKind !== undefined && (typeof entityKind !== "string" || !entityKind)) {
    throw new WorkspaceEngineError("invalid_spatial_candidate", "entity_kind must be a non-empty string", { retryable: true });
  }
  const hasAssetIdentity = assetId !== undefined || entityKind !== undefined;
  if ([geometry !== undefined, cadDefinition !== undefined, hasAssetIdentity].filter(Boolean).length > 1) {
    throw new WorkspaceEngineError(
      "invalid_spatial_candidate",
      "candidate must use exactly one of cad_definition, geometry, or asset_id/entity_kind",
      { retryable: true, requiredAction: "query_spatial_placement" },
    );
  }
  return {
    ...(componentId ? { componentId: componentId as string } : {}),
    ...(assetId ? { assetId: assetId as string } : {}),
    ...(entityKind ? { entityKind: entityKind as string } : {}),
    ...(geometry ? { geometry } : {}),
    ...(cadDefinition ? { cadDefinition } : {}),
    placement: {
      space: "world3d",
      position: vector(placementRecord.position, "candidate.placement.position", -1_000_000, 1_000_000),
      rotation: vector(placementRecord.rotation, "candidate.placement.rotation", -1_000_000, 1_000_000),
      scale: vector(placementRecord.scale, "candidate.placement.scale", 0.01, 100),
    },
    ...(collision ? { collision } : {}),
  };
}

type ParsedPhysicsPlacementCandidate = ParsedSpatialPlacementCandidate & Readonly<{
  physics?: NonNullable<PhysicsPlacementCandidate["physics"]>;
}>;

function parsePhysicsPlacementCandidate(value: unknown): ParsedPhysicsPlacementCandidate {
  const spatial = parseSpatialPlacementCandidate(value);
  const record = value as Record<string, unknown>;
  if (record.physics === undefined) return spatial;
  const physics = parseSpatialPhysicsConfig(record.physics);
  if (!physics) {
    throw new WorkspaceEngineError("invalid_physics_candidate", "candidate.physics is invalid", {
      retryable: true,
      requiredAction: "query_stable_placement",
    });
  }
  return { ...spatial, physics };
}

function compactJSON(
  value: unknown,
  depth = 0,
  budget: { remaining: number } = { remaining: MAX_COMPACT_NODES },
): JSONValue {
  if (budget.remaining <= 0) return "[truncated]";
  budget.remaining -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => compactJSON(entry, depth + 1, budget));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, entry]) => [key, compactJSON(entry, depth + 1, budget)]),
    );
  }
  return String(value);
}

const REDACTED_COMPONENT_FIELD = "[redacted]";
const CREDENTIAL_FIELD_NAMES = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "api_key_ref",
  "apikey",
  "authorization",
  "auth_token",
  "bearer",
  "client_secret",
  "clientsecret",
  "credential",
  "credential_ref",
  "credential_reference",
  "credentialref",
  "credentials",
  "id_token",
  "password",
  "password_ref",
  "private_key",
  "private_key_ref",
  "privatekey",
  "refresh_token",
  "refreshtoken",
  "secret",
  "secret_ref",
  "secret_reference",
  "secretref",
  "session_token",
  "token",
  "token_ref",
]);

function normalizeCredentialFieldName(key: string): string {
  return key
    .normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[.\s-]+/gu, "_")
    .toLowerCase();
}

function redactCredentialFields(
  value: JSONValue,
  path: string,
  redactedFields: string[],
): JSONValue {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactCredentialFields(entry, `${path}[${index}]`, redactedFields));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const normalized = normalizeCredentialFieldName(key);
    const childPath = `${path}.${key}`;
    if (CREDENTIAL_FIELD_NAMES.has(normalized)) {
      redactedFields.push(childPath);
      return [key, REDACTED_COMPONENT_FIELD];
    }
    return [key, redactCredentialFields(entry, childPath, redactedFields)];
  }));
}

function redactedComponentState(component: Readonly<ComponentInstance>): {
  props: JSONValue;
  durableState: JSONValue;
  redactedFields: readonly string[];
} {
  const redactedFields: string[] = [];
  const props = redactCredentialFields(component.props, "component.props", redactedFields);
  const durableState = redactCredentialFields(
    component.durableState,
    "component.durable_state",
    redactedFields,
  );
  return { props, durableState, redactedFields };
}

function componentForAgent(
  component: Readonly<ComponentInstance>,
  props: JSONValue,
  durableState: JSONValue,
  bindings: readonly ComponentInstance["bindings"][number][] = component.bindings,
  tags: readonly string[] = component.tags,
): JSONValue {
  return asJSON({
    id: component.id,
    type: component.type,
    label: component.label,
    props,
    durable_state: durableState,
    placement: component.placement,
    ...(component.parentId ? { parent_id: component.parentId } : {}),
    bindings,
    tags,
    visibility: component.visibility,
    visual_effects: component.visualEffects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS,
    locks: component.locks,
    provenance: component.provenance,
  });
}

function manifestForAgent(manifest: ComponentManifest): JSONValue {
  const redactedDefaultFields: string[] = [];
  const defaultProps = redactCredentialFields(
    manifest.defaultProps,
    "defaultProps",
    redactedDefaultFields,
  );
  const defaultDurableState = redactCredentialFields(
    manifest.defaultDurableState,
    "defaultDurableState",
    redactedDefaultFields,
  );
  return asJSON({
    typeId: manifest.typeId,
    version: manifest.version,
    digest: manifest.digest,
    displayName: manifest.displayName,
    trustTier: manifest.trustTier,
    allowedPlacements: manifest.allowedPlacements,
    resizePolicy: manifest.resizePolicy,
    propsSchema: manifest.propsSchema,
    durableStateSchema: manifest.durableStateSchema,
    defaultProps,
    defaultDurableState,
    defaultsRedacted: redactedDefaultFields.length > 0,
    redactedDefaultFields,
    writableProps: manifest.writableProps,
    bindableProps: bindablePropsForManifest(manifest),
    actions: manifest.actions,
    events: manifest.events,
    requiredPermissions: manifest.requiredPermissions,
  });
}

function capabilityManifest(
  store: WorkspaceStore,
  maxBytes: number,
): JSONValue {
  const catalog = store.getComponentCatalog();
  const assetCatalog = DEFAULT_ASSET_REGISTRY.all();
  const connectorTypes = workspaceConnectorCapabilityManifest();
  const componentTypes: JSONValue[] = [];
  const assets: JSONValue[] = [];
  const build = (types: readonly JSONValue[], includedAssets: readonly JSONValue[]) => ({
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    registry_digest: store.getRegistryDigest(),
    allowed_operations: WORKSPACE_OPERATION_NAMES,
    permission_scopes: WORKSPACE_PERMISSION_SCOPES,
    connector_types: connectorTypes,
    component_types: types,
    component_type_count: catalog.length,
    omitted_component_type_count: catalog.length - types.length,
    asset_library: {
      version: DEFAULT_ASSET_REGISTRY.libraryVersion,
      style_family: DEFAULT_ASSET_REGISTRY.styleFamily,
      assets: includedAssets,
      asset_count: assetCatalog.length,
      omitted_asset_count: assetCatalog.length - includedAssets.length,
    },
    numeric_limits: {
      max_operations_per_batch: 100,
      max_batch_bytes: 1_048_576,
      max_json_depth: 32,
      max_reserved_component_ids: 100,
      max_component_inspection_bytes: WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES,
    },
  });
  if (encodedBytes(build(componentTypes, assets)) > maxBytes) {
    throw new WorkspaceEngineError(
      "engine_contract_violation",
      `maxCapabilityBytes ${maxBytes} cannot hold the Workspace capability header`,
    );
  }
  for (const manifest of catalog) {
    const candidate = manifestForAgent(manifest);
    if (encodedBytes(build([...componentTypes, candidate], assets)) > maxBytes) break;
    componentTypes.push(candidate);
  }
  for (const asset of assetCatalog) {
    const candidate = asJSON({
      asset_id: asset.assetId,
      kind: asset.kind,
      display_name: asset.displayName,
      bounds: asset.bounds,
      default_scale: asset.defaultScale,
      anchors: asset.anchors,
      sockets: asset.sockets,
      animations: asset.animations,
      supported_states: asset.supportedStates,
      variants: asset.variants,
    });
    if (encodedBytes(build(componentTypes, [...assets, candidate])) > maxBytes) break;
    assets.push(candidate);
  }
  return asJSON(build(componentTypes, assets));
}

function currentGeometry(
  component: Readonly<ComponentInstance>,
  policy: Readonly<ComponentResizePolicy> | undefined,
): JSONValue {
  if (!policy || policy.kind === "none") return { kind: "none" };
  if (policy.kind === "box2d") {
    const size = "size" in component.placement && component.placement.size
      ? component.placement.size
      : policy.defaultSize;
    return asJSON({ kind: "box2d", size });
  }
  if (policy.kind === "scale3d") {
    const scale = component.placement.space === "world3d"
      ? component.placement.scale
      : policy.defaultScale;
    return asJSON({ kind: "scale3d", scale });
  }
  const dimensions = component.props.dimensions;
  return asJSON({
    kind: "stage_dimensions",
    dimensions: dimensions && typeof dimensions === "object" && !Array.isArray(dimensions)
      ? dimensions
      : policy.defaultDimensions,
  });
}

function workspaceSummary(
  store: WorkspaceStore,
  state: Readonly<WorkspaceState>,
  maxComponents: number,
  maxResources: number,
  maxBytes: number,
): JSONValue {
  const physicsReport = buildPhysicsValidationReport(state);
  const components = [...state.components.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const resources = [...state.resources.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const realityAssets = [...state.realityAssets.values()]
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const componentCandidates = components.slice(0, maxComponents).map((component) => {
    const manifest = store.getComponentManifest(component.type.typeId, component.type.version);
    const policy = manifest
      ? resizePolicyForPlacement(manifest, component.placement)
      : { kind: "none", mode: "none" } as const;
    const publicState = redactedComponentState(component);
    return ({
      id: component.id,
      type: component.type,
      label: component.label,
      placement: component.placement,
      active_resize_policy: asJSON(policy),
      current_geometry: currentGeometry(component, policy),
      current_visual_effects: component.visualEffects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS,
      visual_effects_policy: {
        opacity: { min: 0, max: 1 },
        emissive_intensity: { min: 0, max: 8 },
        glow_intensity: { min: 0, max: 4 },
        glow_spread: { min: 0, max: 1 },
        colors: "#RRGGBB",
      },
      props: compactJSON(publicState.props),
      durable_state: compactJSON(publicState.durableState),
      redacted_fields: publicState.redactedFields,
      parent_id: component.parentId,
      tags: component.tags.slice(0, 100),
      visibility: component.visibility,
      locks: component.locks,
      bindings: component.bindings.slice(0, 100),
    });
  });
    // Intentionally excludes config and secretRef. Agents receive public state,
    // schema, freshness, and provenance—not connector credentials.
  const resourceCandidates = resources.slice(0, maxResources).map((resource) => {
    const trustedProvenance = isCanonicalInlineSnapshotResource(resource)
      || isCanonicalHostFeedResource(resource);
    return ({
      id: resource.id,
      label: resource.label,
      connector_type: resource.connectorType,
      connector_version: resource.connectorVersion,
      output_schema: compactJSON(resource.outputSchema),
      status: resource.status,
      policy: resource.policy,
      snapshot: resource.snapshot ? {
        content_hash: resource.snapshot.contentHash,
        retrieved_at: resource.snapshot.retrievedAt,
        stale: resource.snapshot.stale,
        provenance: trustedProvenance
          ? compactJSON(resource.snapshot.provenance)
          : resource.snapshot.provenance.map((entry) => ({
              retrieved_at: entry.retrievedAt,
              redacted: true,
            })),
      } : undefined,
      last_error: resource.lastError ? "[redacted connector error]" : undefined,
    });
  });
  const realityAssetCandidates = realityAssets.slice(0, Math.min(maxResources, 50)).map((asset) => ({
    asset_id: asset.assetId,
    digest: asset.digest,
    format: asset.format,
    byte_length: asset.byteLength,
    splat_count: asset.splatCount,
    spherical_harmonics_degree: asset.sphericalHarmonicsDegree,
    model: asset.model,
    coordinate_system: asset.coordinateSystem,
    ...(asset.sourceBounds ? { source_bounds: asset.sourceBounds } : {}),
    engineering_authority: asset.engineeringAuthority,
  }));
  const connectionCandidates = [...state.connections.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 100)
    .map((connection) => connection.kind === "resource_binding"
      ? {
          kind: connection.kind,
          id: connection.id,
          resource_id: connection.resourceId,
          component_id: connection.componentId,
          target_prop: connection.targetProp,
          source_path: connection.sourcePath,
          mode: connection.mode,
          transform: compactJSON(connection.transform),
          enabled: connection.enabled,
        }
      : {
          kind: connection.kind,
          id: connection.id,
          source_component_id: connection.sourceComponentId,
          event: connection.event,
          target_component_id: connection.targetComponentId,
          action: connection.action,
          has_static_input: connection.input !== undefined,
          input_mode: connection.inputMode ?? "static",
          transition: connection.transition ? compactJSON(connection.transition) : undefined,
          enabled: connection.enabled,
        });
  const viewCandidates = [...state.sharedViews.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 20)
      .map((view) => ({ id: view.id, label: view.label, component_ids: view.componentIds.slice(0, 100) }));

  const includedComponents: typeof componentCandidates = [];
  const includedResources: typeof resourceCandidates = [];
  const includedRealityAssets: typeof realityAssetCandidates = [];
  const includedConnections: typeof connectionCandidates = [];
  const includedViews: typeof viewCandidates = [];
  const build = () => ({
    workspace_id: state.workspaceId,
    revision: state.revision,
    registry_digest: state.registryDigest,
    component_count: components.length,
    resource_count: resources.length,
    reality_asset_count: realityAssets.length,
    connection_count: state.connections.size,
    recipe_count: state.recipes.size,
    shared_view_count: state.sharedViews.size,
    model_definition_count: state.modelDefinitions.size,
    model_definitions: [...state.modelDefinitions.values()]
      .sort((left, right) => `${left.modelId}@${left.version}`.localeCompare(`${right.modelId}@${right.version}`))
      .slice(0, 50)
      .map((definition) => ({
        model_id: definition.modelId,
        version: definition.version,
        digest: definition.digest,
        display_name: definition.displayName,
        root_node_id: definition.rootNodeId,
        node_count: definition.nodes.length,
        source_revision: definition.sourceRevision,
      })),
    omitted_model_definition_count: Math.max(0, state.modelDefinitions.size - 50),
    spatial_graph: {
      format: "semaframe-spatial-graph",
      version: SEMAFRAME_SPATIAL_GRAPH_VERSION,
      workspace_revision: state.revision,
      spatial_node_count: components.filter((component) =>
        isSpatialRenderTypeId(component.type.typeId)).length,
      collision_enabled_node_count: components.filter((component) => {
        if (!isPhysicalSpatialTypeId(component.type.typeId)) return false;
        const collision = spatialCollisionConfigFromProps(component.props);
        return Boolean(collision?.enabled && collision.role !== "none");
      }).length,
      inspect_tool: "inspect_workspace_space",
      placement_preflight_tool: "query_spatial_placement",
    },
    physics_validation: {
      format: physicsReport.format,
      version: physicsReport.version,
      body_count: physicsReport.bodies.length,
      enabled_body_count: physicsReport.bodies.filter((body) => body.enabled).length,
      disabled_body_count: physicsReport.bodies.filter((body) => !body.enabled).length,
      dynamic_body_count: physicsReport.bodies.filter((body) => body.enabled && body.bodyType === "dynamic").length,
      constrained_body_count: physicsReport.bodies.filter((body) => body.enabled && body.constraints.some((constraint) => constraint.enabled)).length,
      issue_count: physicsReport.issues.length,
      feasible: physicsReport.feasible,
      inspect_tool: "inspect_workspace_physics",
      placement_preflight_tool: "query_stable_placement",
      simulation_tool: "simulate_workspace_physics",
    },
    components: includedComponents,
    omitted_component_count: components.length - includedComponents.length,
    resources: includedResources,
    omitted_resource_count: resources.length - includedResources.length,
    reality_assets: includedRealityAssets,
    omitted_reality_asset_count: realityAssets.length - includedRealityAssets.length,
    connections: includedConnections,
    omitted_connection_count: state.connections.size - includedConnections.length,
    shared_views: includedViews,
    omitted_shared_view_count: state.sharedViews.size - includedViews.length,
  });
  if (encodedBytes(build()) > maxBytes) {
    throw new WorkspaceEngineError(
      "engine_contract_violation",
      `maxSummaryBytes ${maxBytes} cannot hold the Workspace summary header`,
    );
  }
  for (const candidate of componentCandidates) {
    includedComponents.push(candidate);
    if (encodedBytes(build()) <= maxBytes) continue;
    includedComponents.pop();
    break;
  }
  for (const candidate of resourceCandidates) {
    includedResources.push(candidate);
    if (encodedBytes(build()) <= maxBytes) continue;
    includedResources.pop();
    break;
  }
  for (const candidate of realityAssetCandidates) {
    includedRealityAssets.push(candidate);
    if (encodedBytes(build()) <= maxBytes) continue;
    includedRealityAssets.pop();
    break;
  }
  for (const candidate of connectionCandidates) {
    includedConnections.push(candidate);
    if (encodedBytes(build()) <= maxBytes) continue;
    includedConnections.pop();
    break;
  }
  for (const candidate of viewCandidates) {
    includedViews.push(candidate);
    if (encodedBytes(build()) <= maxBytes) continue;
    includedViews.pop();
    break;
  }
  return asJSON(build());
}

function authorizationFor(principal: WorkspaceAgentPrincipal): WorkspaceAuthorization {
  return {
    actor: "agent",
    permissions: principal.scopes
      .filter((scope) => CORE_PERMISSIONS.has(scope as WorkspacePermission))
      .map((scope) => scope as WorkspacePermission),
  };
}

function requireAgentScope(principal: WorkspaceAgentPrincipal, scope: WorkspacePermissionScope): void {
  if (!principal.scopes.includes(scope)) {
    throw new WorkspaceEngineError(
      "permission_denied",
      `Missing Workspace agent permission: ${scope}`,
      { requiredAction: "request_user_approval", details: { missing_scopes: [scope] } },
    );
  }
}

function numericCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/u.test(cursor)) {
    throw new WorkspaceEngineError("invalid_event_cursor", "Event cursor must be a non-negative integer string", { retryable: true });
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) {
    throw new WorkspaceEngineError("invalid_event_cursor", "Event cursor exceeds the safe integer range", { retryable: true });
  }
  return value;
}

function publicEvent(event: CoreWorkspaceEvent): WorkspaceEvent {
  const date = new Date(event.effectiveTimeMs);
  if (Number.isNaN(date.getTime())) {
    throw new WorkspaceEngineError("engine_contract_violation", `Event ${event.id} has an invalid effective time`);
  }
  return {
    id: event.id,
    cursor: String(event.cursor),
    type: event.event,
    source: event.source,
    workspaceRevision: event.workspaceRevision,
    occurredAt: date.toISOString(),
    ...(event.componentId ? { componentId: event.componentId } : {}),
    ...(event.causedBy ? {
      caused_by_event_id: event.causedBy.eventId,
      connection_id: event.causedBy.connectionId,
    } : {}),
    payload: asJSON(event.payload),
  };
}

function createdComponentIds(batch: unknown): string[] {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return [];
  const operations = (batch as Record<string, unknown>).operations;
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((operation) =>
    operation && typeof operation === "object" && !Array.isArray(operation) &&
    (operation as Record<string, unknown>).op === "create_component" &&
    typeof (operation as Record<string, unknown>).id === "string"
      ? [(operation as Record<string, unknown>).id as string]
      : [],
  );
}

async function openCadEvaluationKernel(
  factory: (() => Promise<CadKernel>) | undefined,
): Promise<CadKernel> {
  if (factory) return factory();
  if (typeof globalThis.Worker === "function") return createCadWorkerKernel();
  throw new WorkspaceEngineError(
    "cad_evaluation_unavailable",
    "Agent CAD evaluation requires a disposable Worker in this host",
    {
      retryable: false,
      details: { hard_stop_required: true, in_process_fallback_used: false },
    },
  );
}

async function hostEvaluateCadProps(
  propsInput: JSONObject,
  budgetMs: number,
  factory: (() => Promise<CadKernel>) | undefined,
): Promise<JSONObject> {
  const props = structuredClone(propsInput);
  const definition = parseCadPartDefinition(props.definition);
  props.definition = structuredClone(definition) as unknown as JSONObject;
  props.definitionDigest = cadPartDefinitionDigest(definition);
  if (!definition.activeBodyIds.length) {
    props.evaluation = null;
    return props;
  }
  const kernel = await openCadEvaluationKernel(factory);
  try {
    const result = await kernel.evaluatePart(definition, {
      linearDeflectionM: 0.0005,
      angularDeflectionRad: 0.15,
      includeMeshes: false,
      budgetMs,
    });
    props.evaluation = structuredClone(result.evidence) as unknown as JSONObject;
    return props;
  } finally {
    await kernel.dispose();
  }
}

async function evaluateCadPlacementCandidate(
  store: WorkspaceStore,
  candidate: ParsedSpatialPlacementCandidate,
  factory: (() => Promise<CadKernel>) | undefined,
): Promise<SpatialPlacementCandidate> {
  const base: SpatialPlacementCandidate = {
    ...(candidate.componentId ? { componentId: candidate.componentId } : {}),
    ...(candidate.assetId ? { assetId: candidate.assetId } : {}),
    ...(candidate.entityKind ? { entityKind: candidate.entityKind } : {}),
    ...(candidate.geometry ? { geometry: candidate.geometry } : {}),
    placement: structuredClone(candidate.placement),
    ...(candidate.collision ? { collision: structuredClone(candidate.collision) } : {}),
  };
  if (!candidate.cadDefinition) return base;
  if (!candidate.cadDefinition.activeBodyIds.length) {
    throw new WorkspaceEngineError(
      "invalid_spatial_candidate",
      "candidate.cad_definition must evaluate at least one active body",
      { retryable: true, requiredAction: "query_spatial_placement" },
    );
  }
  const manifest = store.getComponentManifest("cad-part");
  if (!manifest) {
    throw new WorkspaceEngineError(
      "engine_contract_violation",
      "The authoritative cad-part manifest is unavailable",
    );
  }
  const evaluated = await hostEvaluateCadProps({
    ...structuredClone(manifest.defaultProps),
    definition: structuredClone(candidate.cadDefinition) as unknown as JSONObject,
  }, MAX_AGENT_CAD_EVALUATION_OPERATION_MS, factory);
  const definition = parseCadPartDefinition(evaluated.definition);
  const evaluation = parseCadEvaluationEvidence(evaluated.evaluation, definition);
  return {
    ...base,
    cad: { definition, evaluation },
  };
}

function countAgentCadEvaluations(
  state: Readonly<WorkspaceState>,
  batch: WorkspaceCommandBatch,
): number {
  const componentTypes = new Map(
    [...state.components].map(([id, component]) => [id, component.type.typeId] as const),
  );
  let count = 0;
  for (const operation of batch.operations) {
    if (operation.op === "create_component") {
      componentTypes.set(operation.id, operation.component_type.typeId);
      if (operation.component_type.typeId === "cad-part") count += 1;
      continue;
    }
    if (operation.op === "delete_component") {
      componentTypes.delete(operation.id);
      continue;
    }
    if (operation.op !== "update_component"
      || componentTypes.get(operation.id) !== "cad-part"
      || operation.patch.props === undefined) continue;
    if (operation.patch.props.definition !== undefined
      || operation.patch.props.definitionDigest !== undefined
      || operation.patch.props.evaluation !== undefined) count += 1;
  }
  return count;
}

/**
 * External Agents author semantic CAD documents; the host is the only party
 * that materializes their compact OCCT evidence. This keeps one invalid
 * feature from becoming a committed revision and overwrites forged evidence.
 */
async function prepareAgentCadBatch(
  store: WorkspaceStore,
  batchInput: unknown,
  cadKernelFactory: (() => Promise<CadKernel>) | undefined,
): Promise<WorkspaceCommandBatch> {
  const batch = structuredClone(validateWorkspaceCommandBatch(batchInput));
  const current = store.getState();
  const evaluationCount = countAgentCadEvaluations(current, batch);
  if (evaluationCount > MAX_AGENT_CAD_EVALUATIONS_PER_BATCH) {
    throw new WorkspaceEngineError(
      "cad_evaluation_failed",
      `One Workspace batch may evaluate at most ${MAX_AGENT_CAD_EVALUATIONS_PER_BATCH} CAD documents`,
      {
        retryable: true,
        requiredAction: "begin_workspace_update",
        details: {
          evaluation_count: evaluationCount,
          maximum_evaluations_per_batch: MAX_AGENT_CAD_EVALUATIONS_PER_BATCH,
        },
      },
    );
  }
  const evaluationStartedAt = Date.now();
  const nextCadBudget = (): number => {
    const remaining = MAX_AGENT_CAD_EVALUATION_BATCH_MS - (Date.now() - evaluationStartedAt);
    if (remaining < CAD_KERNEL_LIMITS.minimumOperationBudgetMs) {
      throw new WorkspaceEngineError(
        "cad_evaluation_failed",
        `CAD evaluation exceeded the ${MAX_AGENT_CAD_EVALUATION_BATCH_MS} ms batch budget`,
        { retryable: true, requiredAction: "begin_workspace_update" },
      );
    }
    return Math.min(MAX_AGENT_CAD_EVALUATION_OPERATION_MS, remaining);
  };
  const componentTypes = new Map(
    [...current.components].map(([id, component]) => [id, component.type.typeId] as const),
  );
  const cadProps = new Map(
    [...current.components]
      .filter(([, component]) => component.type.typeId === "cad-part")
      .map(([id, component]) => [id, structuredClone(component.props)] as const),
  );
  for (const operation of batch.operations) {
    if (operation.op === "create_component") {
      componentTypes.set(operation.id, operation.component_type.typeId);
      if (operation.component_type.typeId !== "cad-part") continue;
      const manifest = store.getComponentManifest("cad-part", operation.component_type.version);
      if (!manifest) continue;
      const combined = {
        ...structuredClone(manifest.defaultProps),
        ...structuredClone(operation.props ?? {}),
      };
      const evaluated = await hostEvaluateCadProps(combined, nextCadBudget(), cadKernelFactory);
      operation.props = structuredClone(evaluated);
      cadProps.set(operation.id, evaluated);
      continue;
    }
    if (operation.op === "delete_component") {
      componentTypes.delete(operation.id);
      cadProps.delete(operation.id);
      continue;
    }
    if (operation.op !== "update_component"
      || componentTypes.get(operation.id) !== "cad-part"
      || operation.patch.props === undefined) continue;
    const previous = cadProps.get(operation.id);
    if (!previous) continue;
    const combined = {
      ...structuredClone(previous),
      ...structuredClone(operation.patch.props),
    };
    const touchesDocument = operation.patch.props.definition !== undefined
      || operation.patch.props.definitionDigest !== undefined
      || operation.patch.props.evaluation !== undefined;
    const next = touchesDocument
      ? await hostEvaluateCadProps(combined, nextCadBudget(), cadKernelFactory)
      : combined;
    operation.patch.props = structuredClone(next);
    cadProps.set(operation.id, next);
  }
  return batch;
}

/** Concrete, serialized adapter from the v1 WorkspaceStore to external agent ports. */
export class WorkspaceStoreEngineAdapter implements WorkspaceEnginePort {
  private mutationTail: Promise<void> = Promise.resolve();
  private nextInputRevision: number;
  private readonly preparations = new Map<string, StoredPreparation>();
  private readonly preparationOrder: string[] = [];
  private readonly requestId: (inputRevision: number) => string;
  private readonly maxSummaryComponents: number;
  private readonly maxSummaryResources: number;
  private readonly maxSummaryBytes: number;
  private readonly maxCapabilityBytes: number;
  private readonly maxComponentInspectionBytes: number;
  private readonly maxModelInspectionBytes: number;
  private readonly maxResourceSnapshotBytes: number;
  private readonly cadKernelFactory: (() => Promise<CadKernel>) | undefined;

  constructor(
    readonly store: WorkspaceStore,
    options: WorkspaceStoreEngineAdapterOptions = {},
  ) {
    this.requestId = options.requestId ?? defaultRequestId;
    this.maxSummaryComponents = options.maxSummaryComponents ?? MAX_SUMMARY_COMPONENTS;
    this.maxSummaryResources = options.maxSummaryResources ?? MAX_SUMMARY_RESOURCES;
    this.maxSummaryBytes = options.maxSummaryBytes ?? MAX_SUMMARY_BYTES;
    this.maxCapabilityBytes = options.maxCapabilityBytes ?? MAX_CAPABILITY_BYTES;
    this.maxComponentInspectionBytes = options.maxComponentInspectionBytes
      ?? WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES;
    this.maxModelInspectionBytes = options.maxModelInspectionBytes
      ?? WORKSPACE_MODEL_INSPECTION_MAX_BYTES;
    this.maxResourceSnapshotBytes = options.maxResourceSnapshotBytes
      ?? WORKSPACE_RESOURCE_SNAPSHOT_MAX_BYTES;
    this.cadKernelFactory = options.cadKernelFactory;
    for (const [name, value] of [
      ["maxSummaryComponents", this.maxSummaryComponents],
      ["maxSummaryResources", this.maxSummaryResources],
      ["maxSummaryBytes", this.maxSummaryBytes],
      ["maxCapabilityBytes", this.maxCapabilityBytes],
      ["maxComponentInspectionBytes", this.maxComponentInspectionBytes],
      ["maxModelInspectionBytes", this.maxModelInspectionBytes],
      ["maxResourceSnapshotBytes", this.maxResourceSnapshotBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    }
    if (this.maxComponentInspectionBytes <= WORKSPACE_COMPONENT_INSPECTION_WRAPPER_RESERVE_BYTES) {
      throw new RangeError(
        `maxComponentInspectionBytes must exceed the ${WORKSPACE_COMPONENT_INSPECTION_WRAPPER_RESERVE_BYTES}-byte public wrapper reserve`,
      );
    }
    if (this.maxModelInspectionBytes <= WORKSPACE_MODEL_INSPECTION_WRAPPER_RESERVE_BYTES) {
      throw new RangeError(
        `maxModelInspectionBytes must exceed the ${WORKSPACE_MODEL_INSPECTION_WRAPPER_RESERVE_BYTES}-byte public wrapper reserve`,
      );
    }
    if (this.maxResourceSnapshotBytes <= WORKSPACE_RESOURCE_SNAPSHOT_WRAPPER_RESERVE_BYTES) {
      throw new RangeError(
        `maxResourceSnapshotBytes must exceed the ${WORKSPACE_RESOURCE_SNAPSHOT_WRAPPER_RESERVE_BYTES}-byte public wrapper reserve`,
      );
    }
    const historyInputRevision = store.getCommandHistory().reduce(
      (maximum, command) => Math.max(maximum, command.inputRevision),
      0,
    );
    this.nextInputRevision = Math.max(store.getRevision() + 1, historyInputRevision + 1);
  }

  getState(): WorkspaceStateView {
    const state = this.store.getState();
    return {
      workspaceId: state.workspaceId,
      revision: state.revision,
      summary: workspaceSummary(
        this.store,
        state,
        this.maxSummaryComponents,
        this.maxSummaryResources,
        this.maxSummaryBytes,
      ),
      capabilityManifest: capabilityManifest(this.store, this.maxCapabilityBytes),
    };
  }

  inspectRealityAsset(
    assetId: string,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceRealityAssetView> {
    return this.runSerialized(() => {
      requireAgentScope(principal, "workspace:read");
      const state = this.store.getState();
      const descriptor = state.realityAssets.get(assetId);
      if (!descriptor) {
        throw new WorkspaceEngineError(
          "reality_asset_not_found",
          `Reality Asset ${assetId} does not exist`,
          { retryable: true, requiredAction: "inspect_workspace" },
        );
      }
      return {
        workspaceId: state.workspaceId,
        revision: state.revision,
        registryDigest: state.registryDigest,
        descriptor: asJSON(descriptor),
        binaryAvailability: "host_local_unknown",
      };
    });
  }

  inspectModel(
    modelId: string,
    version: string,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceModelDefinitionView> {
    return this.runSerialized(() => {
      requireAgentScope(principal, "workspace:read");
      const state = this.store.getState();
      const key = `${modelId}@${version}`;
      const definition = state.modelDefinitions.get(key);
      if (!definition) {
        throw new WorkspaceEngineError(
          "model_definition_not_found",
          `Published model ${key} does not exist`,
          { retryable: true, requiredAction: "inspect_workspace" },
        );
      }
      const nodes = definition.nodes.map((node) => {
        const redactedFields: string[] = [];
        const props = redactCredentialFields(node.props, `model.nodes.${node.nodeId}.props`, redactedFields);
        const durableState = redactCredentialFields(
          node.durableState,
          `model.nodes.${node.nodeId}.durable_state`,
          redactedFields,
        );
        if (redactedFields.length) {
          throw new WorkspaceEngineError(
            "engine_contract_violation",
            `Published model ${key} contains a redacted capability field`,
          );
        }
        return {
          node_id: node.nodeId,
          source_component_id: node.sourceComponentId,
          ...(node.parentNodeId ? { parent_node_id: node.parentNodeId } : {}),
          ...("logicalNodeId" in node ? { logical_node_id: node.logicalNodeId } : {}),
          ...("partNumber" in node && node.partNumber ? { part_number: node.partNumber } : {}),
          ...("materialName" in node && node.materialName ? { material_name: node.materialName } : {}),
          component_type: node.componentType,
          label: node.label,
          props,
          durable_state: durableState,
          placement: node.placement,
          tags: node.tags,
          visibility: node.visibility,
          ...(node.visualEffects ? { visual_effects: node.visualEffects } : {}),
        };
      });
      const view: WorkspaceModelDefinitionView = {
        workspaceId: state.workspaceId,
        revision: state.revision,
        registryDigest: state.registryDigest,
        modelDefinition: asJSON({
          format_version: definition.formatVersion,
          model_id: definition.modelId,
          version: definition.version,
          digest: definition.digest,
          display_name: definition.displayName,
          root_node_id: definition.rootNodeId,
          source_revision: definition.sourceRevision,
          generator_version: definition.generatorVersion,
          node_count: nodes.length,
          id_map_keys: definition.nodes.map((node) => node.nodeId),
          nodes,
        }),
      };
      const responseLimit = Math.min(
        this.maxModelInspectionBytes,
        WORKSPACE_MODEL_INSPECTION_MAX_BYTES,
      );
      const payloadLimit = responseLimit - WORKSPACE_MODEL_INSPECTION_WRAPPER_RESERVE_BYTES;
      const payloadBytes = encodedBytes(view);
      if (payloadBytes > payloadLimit) {
        throw new WorkspaceEngineError(
          "model_inspection_too_large",
          `Published model ${key} exceeds the exact inspection response limit`,
          {
            retryable: false,
            details: {
              model_id: modelId,
              version,
              encoded_view_bytes: payloadBytes,
              max_response_bytes: responseLimit,
              wrapper_reserve_bytes: WORKSPACE_MODEL_INSPECTION_WRAPPER_RESERVE_BYTES,
              truncation_performed: false,
            },
          },
        );
      }
      return structuredClone(view);
    });
  }

  inspectComponent(
    componentId: string,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceComponentStateView> {
    return this.runSerialized(() => {
      requireAgentScope(principal, "workspace:read");
      const state = this.store.getState();
      const component = state.components.get(componentId);
      if (!component) {
        throw new WorkspaceEngineError(
          "component_not_found",
          `Workspace component ${componentId} does not exist`,
          { retryable: true, requiredAction: "inspect_workspace" },
        );
      }
      const manifest = this.store.getComponentManifest(component.type.typeId, component.type.version);
      if (!manifest || manifest.digest !== component.type.digest) {
        throw new WorkspaceEngineError(
          "engine_contract_violation",
          `Workspace component ${componentId} does not resolve to its pinned manifest`,
        );
      }
      const policy = resizePolicyForPlacement(manifest, component.placement);
      const currentManifest = this.store.getComponentManifest(component.type.typeId);
      const interactionCompatibility = asJSON({
        status: currentManifest?.digest === manifest.digest ? "current" : "legacy_pinned",
        pinned_version: manifest.version,
        current_version: currentManifest?.version ?? manifest.version,
        supports_current_interactions: currentManifest?.digest === manifest.digest,
        ...(currentManifest && currentManifest.digest !== manifest.digest ? {
          current_manifest: {
            typeId: currentManifest.typeId,
            version: currentManifest.version,
            digest: currentManifest.digest,
          },
        } : {}),
      });
      const publicState = redactedComponentState(component);
      let publicProps = publicState.props;
      let publicDurableState = publicState.durableState;
      const pinnedManifest = manifestForAgent(manifest);
      let publicBindings = [...component.bindings];
      let publicTags = [...component.tags];
      let publicRedactedFields = [...publicState.redactedFields];
      const allEventConnections = [...state.connections.values()]
        .filter((connection): connection is EventConnection => connection.kind === "event_connection" && (
          connection.sourceComponentId === component.id || connection.targetComponentId === component.id
        ))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((connection) => ({
          id: connection.id,
          direction: connection.sourceComponentId === component.id ? "outbound" : "inbound",
          source_component_id: connection.sourceComponentId,
          event: connection.event,
          target_component_id: connection.targetComponentId,
          action: connection.action,
          has_static_input: connection.input !== undefined,
          input_mode: connection.inputMode ?? "static",
          transition: connection.transition ? compactJSON(connection.transition) : undefined,
          enabled: connection.enabled,
        }));
      let publicEventConnections = [...allEventConnections];
      let stateTruncated = false;
      let omittedStateBytes = 0;
      let componentMetadataTruncated = false;
      let omittedBindingCount = 0;
      let omittedEventConnectionCount = 0;
      let omittedTagCount = 0;
      let omittedRedactedFieldCount = 0;
      const inspectionByteLimit = Math.min(
        this.maxComponentInspectionBytes,
        WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES,
      ) - WORKSPACE_COMPONENT_INSPECTION_WRAPPER_RESERVE_BYTES;
      const buildInspection = (): WorkspaceComponentStateView => ({
        workspaceId: state.workspaceId,
        revision: state.revision,
        registryDigest: state.registryDigest,
        component: componentForAgent(
          component,
          publicProps,
          publicDurableState,
          publicBindings,
          publicTags,
        ),
        pinnedManifest,
        interactionCompatibility,
        eventConnections: asJSON(publicEventConnections),
        currentGeometry: currentGeometry(component, policy),
        activeResizePolicy: asJSON(policy),
        currentVisualEffects: asJSON(component.visualEffects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS),
        visualEffectsPolicy: asJSON({
          opacity: { min: 0, max: 1 },
          emissive_intensity: { min: 0, max: 8 },
          glow_intensity: { min: 0, max: 4 },
          glow_spread: { min: 0, max: 1 },
          colors: "#RRGGBB",
        }),
        redactedFields: publicRedactedFields,
        stateTruncated,
        omittedStateBytes,
        componentMetadataTruncated,
        omittedBindingCount,
        omittedEventConnectionCount,
        omittedTagCount,
        omittedRedactedFieldCount,
        manifestTruncated: false,
      });

      let inspection = buildInspection();
      if (encodedBytes(inspection) > inspectionByteLimit) {
        const originalStateJson = JSON.stringify({
          props: publicProps,
          durable_state: publicDurableState,
        });
        publicProps = compactJSON(publicProps);
        publicDurableState = compactJSON(publicDurableState);
        const returnedStateJson = JSON.stringify({
          props: publicProps,
          durable_state: publicDurableState,
        });
        stateTruncated = originalStateJson !== returnedStateJson;
        omittedStateBytes = Math.max(
          0,
          new TextEncoder().encode(originalStateJson).byteLength
            - new TextEncoder().encode(returnedStateJson).byteLength,
        );
        inspection = buildInspection();
      }
      if (encodedBytes(inspection) > inspectionByteLimit) {
        const allBindings = publicBindings;
        const allTags = publicTags;
        const allRedactedFields = publicRedactedFields;
        publicBindings = [];
        publicEventConnections = [];
        publicTags = [];
        publicRedactedFields = [];
        componentMetadataTruncated = true;
        omittedBindingCount = allBindings.length;
        omittedEventConnectionCount = allEventConnections.length;
        omittedTagCount = allTags.length;
        omittedRedactedFieldCount = allRedactedFields.length;
        inspection = buildInspection();
        if (encodedBytes(inspection) > inspectionByteLimit) {
          throw new WorkspaceEngineError(
            "engine_contract_violation",
            `Component inspection payload budget ${inspectionByteLimit} cannot hold the exact control contract`,
          );
        }

        const fitPrefix = <T>(
          values: readonly T[],
          assign: (prefix: T[]) => void,
          updateOmitted: (count: number) => void,
        ): void => {
          let lower = 0;
          let upper = values.length;
          while (lower < upper) {
            const middle = Math.ceil((lower + upper) / 2);
            assign(values.slice(0, middle));
            const candidate = buildInspection();
            if (encodedBytes(candidate) <= inspectionByteLimit) lower = middle;
            else upper = middle - 1;
          }
          assign(values.slice(0, lower));
          updateOmitted(values.length - lower);
        };
        fitPrefix(allEventConnections, (value) => { publicEventConnections = value; }, (count) => {
          omittedEventConnectionCount = count;
        });
        fitPrefix(allBindings, (value) => { publicBindings = value; }, (count) => {
          omittedBindingCount = count;
        });
        fitPrefix(allTags, (value) => { publicTags = value; }, (count) => {
          omittedTagCount = count;
        });
        fitPrefix(allRedactedFields, (value) => { publicRedactedFields = value; }, (count) => {
          omittedRedactedFieldCount = count;
        });
        componentMetadataTruncated = omittedEventConnectionCount > 0
          || omittedBindingCount > 0
          || omittedTagCount > 0
          || omittedRedactedFieldCount > 0;
        inspection = buildInspection();
      }
      if (encodedBytes(inspection) > inspectionByteLimit) {
        throw new WorkspaceEngineError(
          "engine_contract_violation",
          "Component inspection exceeded its configured byte limit",
        );
      }
      return structuredClone(inspection);
    });
  }

  readResourceSnapshot(
    resourceId: string,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceResourceSnapshotView> {
    return this.runSerialized(() => {
      // This reads only the last persisted observation. It deliberately has no
      // connector execution, refresh, network, or revision-producing path.
      requireAgentScope(principal, "workspace:read");
      requireAgentScope(principal, "effect:data_read");
      const state = this.store.getState();
      const resource = state.resources.get(resourceId);
      if (!resource) {
        throw new WorkspaceEngineError(
          "resource_not_found",
          `Workspace resource ${resourceId} does not exist`,
          { retryable: true, requiredAction: "inspect_workspace" },
        );
      }
      const canonical = isCanonicalInlineSnapshotResource(resource)
        || isCanonicalHostFeedResource(resource);
      if (!canonical) {
        throw new WorkspaceEngineError(
          "resource_snapshot_not_readable",
          `Workspace resource ${resourceId} is not a canonical host-normalized snapshot`,
          {
            retryable: false,
            details: {
              resource_id: resourceId,
              readable_connector_types: ["inline.snapshot@1.0.0", "http.feed@1.0.0"],
            },
          },
        );
      }
      // Both canonical resource forms require a validated current snapshot.
      const snapshot = resource.snapshot!;
      const view: WorkspaceResourceSnapshotView = {
        workspaceId: state.workspaceId,
        revision: state.revision,
        registryDigest: state.registryDigest,
        resourceId: resource.id,
        label: resource.label,
        connectorType: resource.connectorType,
        connectorVersion: resource.connectorVersion,
        outputSchema: asJSON(resource.outputSchema),
        status: resource.status,
        snapshotAuthority: "host_normalized",
        data: asJSON(snapshot.data),
        contentHash: snapshot.contentHash,
        retrievedAt: snapshot.retrievedAt,
        stale: snapshot.stale,
        provenance: structuredClone(snapshot.provenance),
      };
      const responseLimit = Math.min(
        this.maxResourceSnapshotBytes,
        WORKSPACE_RESOURCE_SNAPSHOT_MAX_BYTES,
      );
      const payloadLimit = responseLimit - WORKSPACE_RESOURCE_SNAPSHOT_WRAPPER_RESERVE_BYTES;
      const payloadBytes = encodedBytes(view);
      if (payloadBytes > payloadLimit) {
        throw new WorkspaceEngineError(
          "resource_snapshot_too_large",
          `Workspace resource ${resourceId} snapshot exceeds the exact-read response limit`,
          {
            retryable: false,
            details: {
              resource_id: resourceId,
              encoded_view_bytes: payloadBytes,
              max_response_bytes: responseLimit,
              wrapper_reserve_bytes: WORKSPACE_RESOURCE_SNAPSHOT_WRAPPER_RESERVE_BYTES,
              truncation_performed: false,
            },
          },
        );
      }
      return structuredClone(view);
    });
  }

  inspectSpace(
    sinceRevision: number | undefined,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceSpatialStateView> {
    return this.runSerialized(() => {
      requireAgentScope(principal, "workspace:read");
      const state = this.store.getState();
      if (sinceRevision !== undefined && (
        !Number.isSafeInteger(sinceRevision) || sinceRevision < 0 || sinceRevision > state.revision
      )) {
        throw new WorkspaceEngineError(
          "invalid_spatial_revision",
          `since_revision must be between 0 and ${state.revision}`,
          { retryable: true, requiredAction: "inspect_workspace_space" },
        );
      }

      let space;
      if (sinceRevision === undefined || sinceRevision === 0) {
        space = buildSemaFrameSpatialGraph(state);
      } else if (sinceRevision === state.revision) {
        space = buildSemaFrameSpatialGraph(state, {
          mode: "delta",
          sinceRevision,
          changedNodeIds: new Set(),
        });
      } else {
        const changed = new Set<string>();
        let requireFull = false;
        for (const command of this.store.getCommandHistory()) {
          if (command.resultingWorkspaceRevision <= sinceRevision) continue;
          for (const operation of command.resolvedOperations) {
            if (operation.op === "clear_workspace" || operation.op === "delete_component") {
              requireFull = true;
              break;
            }
            if ("id" in operation && typeof operation.id === "string") changed.add(operation.id);
            if (operation.op === "attach_component" || operation.op === "detach_component") {
              changed.add(operation.child_id);
            }
          }
          if (requireFull) break;
        }
        if (!requireFull) {
          const stageChanged = [...changed].some((id) => state.components.get(id)?.type.typeId === "stage-3d");
          if (stageChanged) {
            for (const component of state.components.values()) {
              if (isSpatialRenderTypeId(component.type.typeId)) changed.add(component.id);
            }
          } else {
            let expanded = true;
            while (expanded) {
              expanded = false;
              for (const component of state.components.values()) {
                if (component.parentId && changed.has(component.parentId) && !changed.has(component.id)) {
                  changed.add(component.id);
                  expanded = true;
                }
              }
            }
          }
        }
        space = requireFull
          ? buildSemaFrameSpatialGraph(state)
          : buildSemaFrameSpatialGraph(state, { mode: "delta", sinceRevision, changedNodeIds: changed });
      }
      return {
        workspaceId: state.workspaceId,
        revision: state.revision,
        registryDigest: state.registryDigest,
        spatialGraph: spatialGraphForAgent(space),
      };
    });
  }

  querySpatialPlacement(
    candidate: unknown,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceSpatialPlacementView> {
    return this.runSerialized(async () => {
      requireAgentScope(principal, "workspace:read");
      const state = this.store.getState();
      try {
        const parsed = parseSpatialPlacementCandidate(candidate);
        const evaluated = await evaluateCadPlacementCandidate(
          this.store,
          parsed,
          this.cadKernelFactory,
        );
        const check = querySpatialPlacement(state, evaluated);
        return {
          workspaceId: state.workspaceId,
          revision: state.revision,
          registryDigest: state.registryDigest,
          placementCheck: asJSON({
            valid: check.valid,
            candidate_id: check.candidateId,
            conflicts: check.conflicts.map(spatialConflictForAgent),
            suggested_placements: check.suggestedPlacements,
          }),
        };
      } catch (cause) {
        if (cause instanceof WorkspaceEngineError) throw cause;
        if (cause instanceof CadDocumentError) {
          throw new WorkspaceEngineError(
            "invalid_spatial_candidate",
            cause.message,
            {
              retryable: true,
              requiredAction: "query_spatial_placement",
              details: {
                validation_code: cause.code,
                ...(cause.path ? { path: cause.path } : {}),
              },
            },
          );
        }
        if (cause instanceof CadPartEvaluationError || cause instanceof CadKernelError) {
          throw new WorkspaceEngineError(
            "cad_evaluation_failed",
            cause.message,
            {
              retryable: true,
              requiredAction: "query_spatial_placement",
              details: cause instanceof CadKernelError
                ? { kernel_code: cause.code, operation: cause.operation }
                : {
                  validation_code: cause.code,
                  ...(cause.featureId ? { feature_id: cause.featureId } : {}),
                },
            },
          );
        }
        throw new WorkspaceEngineError(
          "invalid_spatial_candidate",
          cause instanceof Error ? cause.message : "Spatial placement candidate is invalid",
          { retryable: true, requiredAction: "query_spatial_placement" },
        );
      }
    });
  }

  inspectPhysics(
    componentIds: readonly string[] | undefined,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspacePhysicsStateView> {
    return this.runSerialized(() => {
      requireAgentScope(principal, "workspace:read");
      const state = this.store.getState();
      const report = buildPhysicsValidationReport(state);
      if (componentIds) {
        const known = new Set(report.bodies.map((body) => body.componentId));
        const missing = componentIds.find((id) => !known.has(id));
        if (missing) {
          throw new WorkspaceEngineError("unknown_spatial_component", `Unknown spatial component ${missing}`, {
            retryable: true,
            requiredAction: "inspect_workspace_space",
          });
        }
      }
      const selected = componentIds ? new Set(componentIds) : undefined;
      const filteredIssues = selected ? report.issues.filter((issue) => selected.has(issue.componentId)
        || Boolean(issue.relatedComponentId && selected.has(issue.relatedComponentId))) : report.issues;
      const filtered: PhysicsValidationReport = selected ? {
        ...report,
        feasible: filteredIssues.length === 0,
        bodies: report.bodies.filter((body) => selected.has(body.componentId)),
        issues: filteredIssues,
      } : report;
      return {
        workspaceId: state.workspaceId,
        revision: state.revision,
        registryDigest: state.registryDigest,
        physicsValidation: physicsReportForAgent(filtered),
      };
    });
  }

  queryStablePlacement(
    candidate: unknown,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspacePhysicsPlacementView> {
    return this.runSerialized(async () => {
      requireAgentScope(principal, "workspace:read");
      const state = this.store.getState();
      try {
        const parsed = parsePhysicsPlacementCandidate(candidate);
        const evaluated = await evaluateCadPlacementCandidate(
          this.store,
          parsed,
          this.cadKernelFactory,
        );
        const check = queryPhysicsStablePlacement(state, {
          ...evaluated,
          ...(parsed.physics ? { physics: parsed.physics } : {}),
        });
        return {
          workspaceId: state.workspaceId,
          revision: state.revision,
          registryDigest: state.registryDigest,
          stabilityCheck: asJSON({
            valid: check.valid,
            candidate_id: check.candidateId,
            collision_check: {
              valid: check.collisionCheck.valid,
              conflicts: check.collisionCheck.conflicts.map(spatialConflictForAgent),
            },
            body: check.body ? physicsBodyForAgent(check.body) : null,
            issues: check.issues.map((issue) => ({
              code: issue.code,
              component_id: issue.componentId,
              ...(issue.relatedComponentId ? { related_component_id: issue.relatedComponentId } : {}),
              ...(issue.constraintId ? { constraint_id: issue.constraintId } : {}),
              message: issue.message,
            })),
            suggested_placements: check.suggestedPlacements,
          }),
        };
      } catch (cause) {
        if (cause instanceof WorkspaceEngineError) throw cause;
        if (cause instanceof CadDocumentError) {
          throw new WorkspaceEngineError("invalid_physics_candidate", cause.message, {
            retryable: true,
            requiredAction: "query_stable_placement",
            details: {
              validation_code: cause.code,
              ...(cause.path ? { path: cause.path } : {}),
            },
          });
        }
        if (cause instanceof CadPartEvaluationError || cause instanceof CadKernelError) {
          throw new WorkspaceEngineError("cad_evaluation_failed", cause.message, {
            retryable: true,
            requiredAction: "query_stable_placement",
            details: cause instanceof CadKernelError
              ? { kernel_code: cause.code, operation: cause.operation }
              : {
                validation_code: cause.code,
                ...(cause.featureId ? { feature_id: cause.featureId } : {}),
              },
          });
        }
        throw new WorkspaceEngineError(
          "invalid_physics_candidate",
          cause instanceof Error ? cause.message : "Physics placement candidate is invalid",
          { retryable: true, requiredAction: "query_stable_placement" },
        );
      }
    });
  }

  simulatePhysics(
    options: unknown,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspacePhysicsSimulationView> {
    return this.runSerialized(() => {
      requireAgentScope(principal, "workspace:read");
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new WorkspaceEngineError("invalid_physics_simulation", "Physics simulation options must be an object", { retryable: true });
      }
      const record = options as Record<string, unknown>;
      if (Object.keys(record).some((key) => !["componentIds", "durationMs", "timeStepMs"].includes(key))) {
        throw new WorkspaceEngineError("invalid_physics_simulation", "Physics simulation options contain unsupported fields", { retryable: true });
      }
      const componentIds = record.componentIds;
      if (componentIds !== undefined && (!Array.isArray(componentIds)
        || componentIds.length > 100
        || componentIds.some((id) => typeof id !== "string" || !id || id.length > 256))) {
        throw new WorkspaceEngineError("invalid_physics_simulation", "componentIds are invalid", { retryable: true });
      }
      const state = this.store.getState();
      const known = new Set(buildSemaFrameSpatialGraph(state, { maxNodes: 2_000 }).nodes.map((node) => node.id));
      const missing = (componentIds as string[] | undefined)?.find((id) => !known.has(id));
      if (missing) {
        throw new WorkspaceEngineError("unknown_spatial_component", `Unknown spatial component ${missing}`, {
          retryable: true,
          requiredAction: "inspect_workspace_space",
        });
      }
      if (!componentIds) {
        const dynamicCount = buildPhysicsValidationReport(state).bodies
          .filter((body) => body.enabled && body.bodyType === "dynamic").length;
        if (dynamicCount > 100) {
          throw new WorkspaceEngineError(
            "physics_simulation_scope_required",
            "More than 100 dynamic bodies exist; provide component_ids to bound the simulation",
            { retryable: true, requiredAction: "inspect_workspace_physics" },
          );
        }
      }
      const result = simulatePhysicsSettle(state, {
        ...(componentIds ? { componentIds: componentIds as string[] } : {}),
        ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
        ...(typeof record.timeStepMs === "number" ? { timeStepMs: record.timeStepMs } : {}),
      });
      return {
        workspaceId: state.workspaceId,
        revision: state.revision,
        registryDigest: state.registryDigest,
        simulation: physicsSettleForAgent(result),
      };
    });
  }

  getRevision(): number {
    return this.store.getRevision();
  }

  getRegistryDigest(): string {
    return this.store.getRegistryDigest();
  }

  prepare(
    intent: string,
    requestedIds = 8,
    principal?: WorkspaceAgentPrincipal,
  ): Promise<WorkspacePreparedUpdate> {
    return this.runSerialized(() => {
      if (typeof intent !== "string" || !intent.trim() || intent.length > 4_000) {
        throw new WorkspaceEngineError("invalid_request", "intent must contain 1-4000 characters", { retryable: true });
      }
      if (!Number.isSafeInteger(requestedIds) || requestedIds < 1 || requestedIds > 100) {
        throw new WorkspaceEngineError("invalid_request", "requestedIds must be between 1 and 100", { retryable: true });
      }
      const state = this.store.getState();
      const inputRevision = this.nextInputRevision++;
      const prepared: WorkspacePreparedUpdate = {
        envelope: {
          protocol_version: WORKSPACE_PROTOCOL_VERSION,
          request_id: this.requestId(inputRevision),
          workspace_id: state.workspaceId,
          input_revision: inputRevision,
          base_workspace_revision: state.revision,
          registry_digest: state.registryDigest,
          mode: "commit",
        },
        workspace_summary: workspaceSummary(
          this.store,
          state,
          this.maxSummaryComponents,
          this.maxSummaryResources,
          this.maxSummaryBytes,
        ),
        capability_manifest: capabilityManifest(this.store, this.maxCapabilityBytes),
        reserved_component_ids: this.store.reserveComponentIds(requestedIds),
      };
      const requestId = prepared.envelope.request_id;
      if (this.preparations.has(requestId)) {
        throw new WorkspaceEngineError("engine_contract_violation", `Duplicate generated request ID ${requestId}`);
      }
      this.preparations.set(requestId, {
        value: structuredClone(prepared),
        fingerprint: stableJson(prepared),
        ...(principal ? { principal: { sessionId: principal.sessionId, clientId: principal.clientId } } : {}),
      });
      this.preparationOrder.push(requestId);
      while (this.preparationOrder.length > 1_000) {
        const expired = this.preparationOrder.shift();
        if (expired) this.preparations.delete(expired);
      }
      return structuredClone(prepared);
    });
  }

  submit(
    prepared: WorkspacePreparedUpdate,
    batch: unknown,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceCommitReceipt> {
    return this.runSerialized(async () => {
      const known = this.preparations.get(prepared.envelope.request_id);
      if (!known || known.fingerprint !== stableJson(prepared)) {
        throw new WorkspaceEngineError(
          "transaction_not_found",
          "Workspace core does not recognize this exact preparation",
          { retryable: true, requiredAction: "begin_workspace_update" },
        );
      }
      if (
        known.principal &&
        (known.principal.sessionId !== principal.sessionId || known.principal.clientId !== principal.clientId)
      ) {
        throw new WorkspaceEngineError(
          "transaction_session_mismatch",
          "Workspace preparation belongs to another agent session",
          { requiredAction: "begin_workspace_update" },
        );
      }
      let batchFingerprint: string;
      try {
        batchFingerprint = stableJson(batch);
      } catch (cause) {
        throw new WorkspaceEngineError(
          "invalid_batch",
          cause instanceof Error ? cause.message : "Workspace batch must be bounded JSON",
          { retryable: true },
        );
      }
      if (known.batchFingerprint && known.batchFingerprint !== batchFingerprint) {
        throw new WorkspaceEngineError(
          "batch_retry_mismatch",
          "This Workspace preparation was already committed with different content",
          { requiredAction: "begin_workspace_update" },
        );
      }
      if (known.receipt) return { ...structuredClone(known.receipt), status: "idempotent" };
      const reserved = new Set(known.value.reserved_component_ids);
      const unreserved = createdComponentIds(batch).filter((id) => !reserved.has(id));
      if (unreserved.length) {
        throw new WorkspaceEngineError(
          "command_validation_failed",
          "create_component used IDs outside this transaction's reserved pool",
          { retryable: true, details: { unreserved_component_ids: unreserved } },
        );
      }
      try {
        const hostBatch = await prepareAgentCadBatch(this.store, batch, this.cadKernelFactory);
        const commit = this.store.applyDetailed(
          hostBatch,
          authorizationFor(principal),
        );
        const resolvedBatch = {
          ...known.value.envelope,
          operations: commit.command.resolvedOperations,
        };
        const receipt: WorkspaceCommitReceipt = {
          requestId: commit.command.requestId,
          baseWorkspaceRevision: commit.command.baseWorkspaceRevision,
          resultingWorkspaceRevision: commit.command.resultingWorkspaceRevision,
          status: commit.deduplicated ? "idempotent" : "committed",
          summary: summarizeDelta(commit.delta),
          delta: asJSON(commit.delta),
          resolvedBatch: asJSON(resolvedBatch),
        };
        known.batchFingerprint = batchFingerprint;
        known.receipt = structuredClone(receipt);
        return receipt;
      } catch (cause) {
        throw mapStoreError(cause);
      }
    });
  }

  undo(expectedRevision: number, principal: WorkspaceAgentPrincipal): Promise<WorkspaceHistoryReceipt> {
    return this.runSerialized(() => {
      requireAgentScope(principal, "workspace:history");
      if (this.store.getRevision() !== expectedRevision) {
        throw new WorkspaceEngineError(
          "stale_workspace_revision",
          `Expected revision ${expectedRevision}; current revision is ${this.store.getRevision()}`,
          { retryable: true, requiredAction: "inspect_workspace" },
        );
      }
      const delta = this.store.undoUserCommand();
      return {
        action: "undo",
        changed: delta !== null,
        workspaceRevision: this.store.getRevision(),
        delta: delta ? asJSON(delta) : null,
      };
    });
  }

  redo(expectedRevision: number, principal: WorkspaceAgentPrincipal): Promise<WorkspaceHistoryReceipt> {
    return this.runSerialized(() => {
      requireAgentScope(principal, "workspace:history");
      if (this.store.getRevision() !== expectedRevision) {
        throw new WorkspaceEngineError(
          "stale_workspace_revision",
          `Expected revision ${expectedRevision}; current revision is ${this.store.getRevision()}`,
          { retryable: true, requiredAction: "inspect_workspace" },
        );
      }
      const delta = this.store.redoUserCommand();
      return {
        action: "redo",
        changed: delta !== null,
        workspaceRevision: this.store.getRevision(),
        delta: delta ? asJSON(delta) : null,
      };
    });
  }

  readEvents(cursor: string | undefined, limit: number): Promise<WorkspaceEventPage> {
    return this.runSerialized(() => {
      const after = numericCursor(cursor);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) {
        throw new WorkspaceEngineError(
          "invalid_request",
          `Event limit must be an integer between 1 and ${MAX_EVENT_PAGE}`,
          { retryable: true },
        );
      }
      const boundedLimit = limit;
      const available = this.store.getEventHistory(after);
      const selected = available.slice(0, boundedLimit).map(publicEvent);
      return {
        events: selected,
        nextCursor: selected.at(-1)?.cursor ?? String(after),
        hasMore: available.length > selected.length,
      };
    });
  }

  private runSerialized<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function summarizeDelta(delta: {
  added: readonly string[];
  updated: readonly string[];
  removed: readonly string[];
  resourcesChanged: readonly string[];
  connectionsChanged: readonly string[];
  viewsChanged: readonly string[];
  registryChanged: boolean;
}): string {
  const parts = [
    delta.added.length ? `added ${delta.added.length}` : "",
    delta.updated.length ? `updated ${delta.updated.length}` : "",
    delta.removed.length ? `removed ${delta.removed.length}` : "",
    delta.resourcesChanged.length ? `resources ${delta.resourcesChanged.length}` : "",
    delta.connectionsChanged.length ? `connections ${delta.connectionsChanged.length}` : "",
    delta.viewsChanged.length ? `views ${delta.viewsChanged.length}` : "",
    delta.registryChanged ? "registry changed" : "",
  ].filter(Boolean);
  return parts.join(" · ") || "Workspace state confirmed";
}

function mapStoreError(cause: unknown): WorkspaceEngineError {
  if (cause instanceof WorkspaceEngineError) return cause;
  if (cause instanceof CadDocumentError || cause instanceof CadPartEvaluationError) {
    return new WorkspaceEngineError("cad_evaluation_failed", cause.message, {
      retryable: true,
      requiredAction: "begin_workspace_update",
      details: {
        validation_code: cause.code,
        ...(cause instanceof CadDocumentError && cause.path ? { path: cause.path } : {}),
        ...(cause instanceof CadPartEvaluationError && cause.featureId
          ? { feature_id: cause.featureId }
          : {}),
      },
    });
  }
  if (cause instanceof CadKernelError) {
    return new WorkspaceEngineError("cad_evaluation_failed", cause.message, {
      retryable: true,
      requiredAction: "begin_workspace_update",
      details: { kernel_code: cause.code, operation: cause.operation },
    });
  }
  if (cause instanceof StaleWorkspaceRevisionError) {
    return new WorkspaceEngineError(cause.code, cause.message, {
      retryable: true,
      requiredAction: "begin_workspace_update",
      details: { current_revision: cause.expected, submitted_revision: cause.received },
    });
  }
  if (cause instanceof StaleRegistryDigestError) {
    return new WorkspaceEngineError(cause.code, cause.message, {
      retryable: true,
      requiredAction: "begin_workspace_update",
      details: { current_registry_digest: cause.expected, submitted_registry_digest: cause.received },
    });
  }
  if (cause instanceof WorkspacePermissionError) {
    return new WorkspaceEngineError("permission_denied", cause.message, {
      requiredAction: "request_user_approval",
      details: { missing_permissions: [cause.permission] },
    });
  }
  if (cause instanceof SpatialCollisionStoreError) {
    return new WorkspaceEngineError("spatial_collision", cause.message, {
      retryable: true,
      requiredAction: "query_spatial_placement",
      details: {
        conflicts: cause.conflicts.map((conflict) => ({
          component_id: conflict.componentId,
          conflicts_with: conflict.conflictsWith,
          overlap: conflict.overlap,
        })),
      },
    });
  }
  if (cause instanceof PhysicsValidationStoreError) {
    return new WorkspaceEngineError("physics_validation_failed", cause.message, {
      retryable: true,
      requiredAction: "query_stable_placement",
      details: {
        issues: cause.issues.map((issue) => ({
          code: issue.code,
          component_id: issue.componentId,
          ...(issue.relatedComponentId ? { related_component_id: issue.relatedComponentId } : {}),
          ...(issue.constraintId ? { constraint_id: issue.constraintId } : {}),
          message: issue.message,
        })),
      },
    });
  }
  if (cause instanceof WorkspaceValidationError) {
    return new WorkspaceEngineError("command_validation_failed", cause.message, {
      retryable: true,
      details: { validation_code: cause.code, validation_errors: cause.details },
    });
  }
  if (cause instanceof ComponentRegistryError) {
    return new WorkspaceEngineError("command_validation_failed", cause.message, {
      retryable: true,
      details: { validation_code: cause.code },
    });
  }
  if (cause instanceof ComponentActionError) {
    return new WorkspaceEngineError("command_validation_failed", cause.message, {
      retryable: true,
      details: { validation_code: cause.code },
    });
  }
  if (cause instanceof WorkspaceStoreError) {
    if (cause.code === "idempotency_conflict") {
      return new WorkspaceEngineError("batch_retry_mismatch", cause.message, {
        requiredAction: "begin_workspace_update",
      });
    }
    return new WorkspaceEngineError("command_validation_failed", cause.message, {
      retryable: true,
      details: { validation_code: cause.code },
    });
  }
  if (cause instanceof Error && cause.message.startsWith("Embedded credential-like field is forbidden")) {
    return new WorkspaceEngineError("command_validation_failed", cause.message, {
      retryable: true,
      details: { validation_code: "embedded_secret" },
    });
  }
  return new WorkspaceEngineError(
    "engine_error",
    cause instanceof Error ? cause.message : "Workspace core failed",
    { retryable: true },
  );
}
