import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY, deterministicDigest } from "../../workspace/components";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import {
  WORKSPACE_PROTOCOL_VERSION,
  WORKSPACE_SCHEMA_VERSION,
  prepareComponentRecipe,
  type WorkspaceOperation,
} from "../../workspace/protocol";
import { WorkspaceStore } from "../../workspace/state";

const LEGACY_REGISTRY_DIGEST = "fnv1a32:bab44e57";

function applyOperations(store: WorkspaceStore, requestId: string, operations: WorkspaceOperation[]): void {
  const state = store.getState();
  store.apply({
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    request_id: requestId,
    workspace_id: state.workspaceId,
    input_revision: state.revision,
    base_workspace_revision: state.revision,
    registry_digest: state.registryDigest,
    mode: "commit",
    operations,
  });
}

function downgradeBuiltinProject(project: unknown): any {
  const legacy = structuredClone(project) as any;
  legacy.protocolVersion = "1.0";
  legacy.workspaceSchemaVersion = "1.0";
  legacy.registryDigest = LEGACY_REGISTRY_DIGEST;
  for (const snapshot of [legacy.checkpoint, legacy.workspace]) {
    snapshot.protocolVersion = "1.0";
    snapshot.workspaceSchemaVersion = "1.0";
    snapshot.registryDigest = LEGACY_REGISTRY_DIGEST;
    for (const summary of snapshot.history) {
      summary.resultingRegistryDigest = LEGACY_REGISTRY_DIGEST;
    }
    for (const [, component] of snapshot.components) {
      component.type = DEFAULT_COMPONENT_REGISTRY.ref(component.type.typeId, "1.0.0");
      if (component.type.typeId === "spatial-entity") {
        delete component.props?.collision;
        delete component.props?.physics;
      }
      delete component.locks.resize;
    }
  }
  for (const command of legacy.commandHistory) {
    command.inputRegistryDigest = LEGACY_REGISTRY_DIGEST;
    command.resultingRegistryDigest = LEGACY_REGISTRY_DIGEST;
    for (const operation of command.resolvedOperations) {
      if (operation.op === "create_component") {
        operation.component_type = DEFAULT_COMPONENT_REGISTRY.ref(
          operation.component_type.typeId,
          "1.0.0",
        );
        delete operation.locks?.resize;
        if (operation.component_type.typeId === "spatial-entity") {
          delete operation.props?.collision;
          delete operation.props?.physics;
        }
      }
    }
  }
  return legacy;
}

describe("Workspace resize migration", () => {
  it("opens a 1.0 project, materializes geometry, and makes the pinned component resizable", () => {
    const store = new WorkspaceStore();
    const state = store.getState();
    store.apply({
      protocol_version: WORKSPACE_PROTOCOL_VERSION,
      request_id: "create_panel_current",
      workspace_id: state.workspaceId,
      input_revision: 0,
      base_workspace_revision: 0,
      registry_digest: state.registryDigest,
      mode: "commit",
      operations: [{
        op: "create_component",
        op_id: "create_panel",
        id: "CMP_000001",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
        placement: {
          space: "viewport",
          anchor: "center",
          offset: { x: 0, y: 0 },
        },
      }],
    });

    const serializer = new WorkspaceProjectSerializer();
    const legacy = structuredClone(serializer.fromStore("legacy_resize", store)) as unknown as {
      protocolVersion: string;
      workspaceSchemaVersion: string;
      registryDigest: string;
      checkpoint: Record<string, unknown> & { history: Array<Record<string, unknown>> };
      workspace: Record<string, unknown> & {
        components: Array<[string, {
          type: { typeId: string; version: string; digest: string };
          placement: Record<string, unknown>;
          locks: Record<string, boolean>;
        }]>;
        history: Array<Record<string, unknown>>;
      };
      commandHistory: Array<{
        inputRegistryDigest: string;
        resultingRegistryDigest: string;
        resolvedOperations: Array<{
          component_type: { typeId: string; version: string; digest: string };
          placement: Record<string, unknown>;
          locks: Record<string, boolean>;
        }>;
      }>;
    };
    const oldRef = DEFAULT_COMPONENT_REGISTRY.ref("panel", "1.0.0");
    legacy.protocolVersion = "1.0";
    legacy.workspaceSchemaVersion = "1.0";
    legacy.registryDigest = LEGACY_REGISTRY_DIGEST;
    for (const snapshot of [legacy.checkpoint, legacy.workspace]) {
      snapshot.protocolVersion = "1.0";
      snapshot.workspaceSchemaVersion = "1.0";
      snapshot.registryDigest = LEGACY_REGISTRY_DIGEST;
      for (const summary of snapshot.history) {
        summary.resultingRegistryDigest = LEGACY_REGISTRY_DIGEST;
      }
    }
    const component = legacy.workspace.components[0]![1];
    component.type = structuredClone(oldRef);
    delete component.placement.size;
    delete component.locks.resize;
    const command = legacy.commandHistory[0]!;
    command.inputRegistryDigest = LEGACY_REGISTRY_DIGEST;
    command.resultingRegistryDigest = LEGACY_REGISTRY_DIGEST;
    const create = command.resolvedOperations[0]!;
    create.component_type = structuredClone(oldRef);
    delete create.placement.size;
    delete create.locks.resize;

    const mixedVersion = structuredClone(legacy);
    mixedVersion.workspace.protocolVersion = "1.1";
    expect(() => serializer.deserialize(mixedVersion)).toThrow(/versions disagree/);

    const migrated = serializer.deserialize(legacy);
    expect(migrated.protocolVersion).toBe(WORKSPACE_PROTOCOL_VERSION);
    expect(migrated.workspaceSchemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    const reopened = serializer.openStore(migrated);
    expect(reopened.getState().components.get("CMP_000001")).toMatchObject({
      type: oldRef,
      placement: { size: { width: 320, height: 220 } },
      locks: { resize: false },
    });

    const beforeResize = reopened.getState();
    reopened.apply({
      protocol_version: WORKSPACE_PROTOCOL_VERSION,
      request_id: "resize_legacy_panel",
      workspace_id: beforeResize.workspaceId,
      input_revision: beforeResize.revision,
      base_workspace_revision: beforeResize.revision,
      registry_digest: beforeResize.registryDigest,
      mode: "commit",
      operations: [{
        op: "resize_component",
        op_id: "resize_panel",
        id: "CMP_000001",
        resize: { kind: "box2d", size: { width: 500, height: 300 } },
      }],
    });
    expect(reopened.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 500, height: 300 });
    expect(reopened.undo()).not.toBeNull();
    expect(reopened.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 320, height: 220 });
    expect(reopened.redo()).not.toBeNull();
    expect(reopened.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 500, height: 300 });
  });

  it("migrates arbitrary 1.0 placement, Stage update, and snapshot-bound geometry as canonical history", () => {
    const store = new WorkspaceStore();
    applyOperations(store, "legacy_create_basis", [{
      op: "create_component",
      op_id: "create_stage",
      id: "CMP_000010",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }, {
      op: "create_component",
      op_id: "create_image",
      id: "CMP_000011",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("image"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }, {
      op: "upsert_resource",
      op_id: "resource",
      resource: {
        id: "RES_stage",
        label: "Stage geometry",
        connectorType: "inline-json",
        connectorVersion: "1",
        outputSchema: { type: "object" },
        config: {},
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data: { stage: { width: 30, height: 6, depth: 22 }, background: "#101820" },
          contentHash: "stage-geometry-v1",
          retrievedAt: "2026-08-14T00:00:00.000Z",
          stale: false,
          provenance: [],
        },
        status: "ready",
      },
    }]);
    applyOperations(store, "legacy_place_image", [{
      op: "place_component",
      op_id: "place_image",
      id: "CMP_000011",
      placement: {
        space: "viewport", anchor: "top_left", offset: { x: 40, y: 50 },
        size: { width: 320, height: 220 },
      },
    }]);
    applyOperations(store, "legacy_stage_update", [{
      op: "resize_component",
      op_id: "stage_dimensions",
      id: "CMP_000010",
      resize: { kind: "stage_dimensions", dimensions: { width: 24, height: 8, depth: 20 } },
    }]);
    applyOperations(store, "legacy_bind_stage", [{
      op: "bind_resource",
      op_id: "bind_stage",
      binding: {
        kind: "resource_binding",
        id: "BIND_stage",
        resourceId: "RES_stage",
        componentId: "CMP_000010",
        targetProp: "background",
        sourcePath: "$.background",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      },
    }]);

    const serializer = new WorkspaceProjectSerializer();
    const legacy = downgradeBuiltinProject(serializer.fromStore("legacy_geometry_history", store));
    const image = legacy.workspace.components.find(([, value]: any[]) => value.id === "CMP_000011")[1];
    image.placement.size = { width: 400, height: 400 };
    const stage = legacy.workspace.components.find(([, value]: any[]) => value.id === "CMP_000010")[1];
    stage.props.dimensions = { width: 30, height: 6, depth: 22 };
    stage.locks.placement = true;
    const createStage = legacy.commandHistory[0].resolvedOperations
      .find((operation: any) => operation.op === "create_component" && operation.id === "CMP_000010");
    createStage.locks.placement = true;
    const binding = legacy.workspace.connections.find(([, value]: any[]) => value.id === "BIND_stage")[1];
    binding.targetProp = "dimensions";
    binding.sourcePath = "$.stage";

    legacy.commandHistory[1].resolvedOperations[0].placement.size = { width: 400, height: 400 };
    legacy.commandHistory[2].resolvedOperations[0] = {
      op: "update_component",
      op_id: "stage_dimensions",
      id: "CMP_000010",
      patch: { props: { dimensions: { width: 5_000, height: 0.5, depth: 2_000 } } },
    };
    legacy.commandHistory[3].resolvedOperations[0].binding.targetProp = "dimensions";
    legacy.commandHistory[3].resolvedOperations[0].binding.sourcePath = "$.stage";

    const migrated = serializer.deserialize(legacy);
    expect(migrated.commandHistory[1]?.resolvedOperations.map((operation) => operation.op))
      .toEqual(["resize_component", "place_component"]);
    expect(migrated.commandHistory[2]?.resolvedOperations.map((operation) => operation.op))
      .toEqual(["update_component", "resize_component", "update_component"]);
    expect(migrated.commandHistory[2]?.resolvedOperations[1]).toMatchObject({
      op: "resize_component",
      resize: { kind: "stage_dimensions", dimensions: { width: 5_000, height: 0.5, depth: 2_000 } },
    });
    expect(migrated.commandHistory[3]?.resolvedOperations.map((operation) => operation.op))
      .toEqual(["update_component", "resize_component", "update_component"]);
    expect(migrated.commandHistory[3]?.resolvedOperations[1]).toMatchObject({
      op: "resize_component",
      resize: { kind: "stage_dimensions", dimensions: { width: 30, height: 6, depth: 22 } },
    });

    const reopened = serializer.openStore(migrated);
    expect(reopened.getState().components.get("CMP_000011")?.placement).toMatchObject({
      offset: { x: 40, y: 50 },
      size: { width: 400, height: 400 },
    });
    expect(reopened.getState().components.get("CMP_000010")?.props.dimensions)
      .toEqual({ width: 30, height: 6, depth: 22 });
    expect(reopened.getState().components.get("CMP_000010")?.locks.placement).toBe(true);
    expect(reopened.getState().connections.has("BIND_stage")).toBe(false);
    expect(reopened.getState().components.get("CMP_000010")?.bindings).toEqual([]);

    reopened.undo();
    expect(reopened.getState().components.get("CMP_000010")?.props.dimensions)
      .toEqual({ width: 5_000, height: 0.5, depth: 2_000 });
    reopened.undo();
    expect(reopened.getState().components.get("CMP_000010")?.props.dimensions)
      .toEqual({ width: 12, height: 4, depth: 10 });
    reopened.undo();
    expect(reopened.getState().components.get("CMP_000011")?.placement.size)
      .toEqual({ width: 320, height: 220 });
    reopened.redo();
    expect(reopened.getState().components.get("CMP_000011")?.placement.size)
      .toEqual({ width: 400, height: 400 });

    const migratedAgain = serializer.deserialize(serializer.serialize(migrated));
    const reopenedAgain = serializer.openStore(migratedAgain);
    expect(reopenedAgain.getState().components.get("CMP_000010")?.props.dimensions)
      .toEqual({ width: 30, height: 6, depth: 22 });
    expect(reopenedAgain.getState().components.get("CMP_000011")?.placement.size)
      .toEqual({ width: 400, height: 400 });
  });

  it("safely normalizes unbounded 1.0 boxes and extreme world scales through replay", () => {
    const store = new WorkspaceStore();
    applyOperations(store, "legacy_extreme_create", [{
      op: "create_component",
      op_id: "create_stage",
      id: "CMP_000019",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }, {
      op: "create_component",
      op_id: "create_image",
      id: "CMP_000020",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("image"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }, {
      op: "create_component",
      op_id: "create_spatial",
      id: "CMP_000021",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]);
    applyOperations(store, "legacy_extreme_place", [{
      op: "place_component",
      op_id: "place_image",
      id: "CMP_000020",
      placement: {
        space: "viewport", anchor: "top_left", offset: { x: 12, y: 18 },
        size: { width: 320, height: 220 },
      },
    }, {
      op: "place_component",
      op_id: "place_spatial",
      id: "CMP_000021",
      placement: {
        space: "world3d",
        position: { x: 2, y: 3, z: 4 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]);

    const serializer = new WorkspaceProjectSerializer();
    const legacy = downgradeBuiltinProject(serializer.fromStore("legacy_extreme_geometry", store));
    const imagePlacement = legacy.workspace.components
      .find(([, component]: any[]) => component.id === "CMP_000020")[1].placement;
    imagePlacement.size = { width: 5_000, height: 0.25 };
    const spatialPlacement = legacy.workspace.components
      .find(([, component]: any[]) => component.id === "CMP_000021")[1].placement;
    spatialPlacement.scale = { x: -5, y: 0, z: 1_000 };
    const placeCommand = legacy.commandHistory
      .find((command: any) => command.requestId === "legacy_extreme_place");
    placeCommand.resolvedOperations
      .find((operation: any) => operation.op_id === "place_image").placement.size = {
        width: 5_000,
        height: 0.25,
      };
    placeCommand.resolvedOperations
      .find((operation: any) => operation.op_id === "place_spatial").placement.scale = {
        x: -5,
        y: 0,
        z: 1_000,
      };

    const migrated = serializer.deserialize(legacy);
    expect(migrated.commandHistory[1]?.resolvedOperations).toHaveLength(4);
    const reopened = serializer.openStore(migrated);
    expect(reopened.getState().components.get("CMP_000020")?.placement.size)
      .toEqual({ width: 4_096, height: 1 });
    expect(reopened.getState().components.get("CMP_000021")?.placement)
      .toMatchObject({ scale: { x: 0.01, y: 0.01, z: 100 } });

    reopened.undo();
    expect(reopened.getState().components.get("CMP_000020")?.placement.size)
      .toEqual({ width: 320, height: 220 });
    expect(reopened.getState().components.get("CMP_000021")?.placement)
      .toMatchObject({ scale: { x: 1, y: 1, z: 1 } });
    reopened.redo();
    expect(reopened.getState().components.get("CMP_000020")?.placement.size)
      .toEqual({ width: 4_096, height: 1 });
    expect(reopened.getState().components.get("CMP_000021")?.placement)
      .toMatchObject({ scale: { x: 0.01, y: 0.01, z: 100 } });

    const migratedAgain = serializer.deserialize(serializer.serialize(migrated));
    const reopenedAgain = serializer.openStore(migratedAgain);
    expect(reopenedAgain.getState().components.get("CMP_000020")?.placement.size)
      .toEqual({ width: 4_096, height: 1 });
    expect(reopenedAgain.getState().components.get("CMP_000021")?.placement)
      .toMatchObject({ scale: { x: 0.01, y: 0.01, z: 100 } });
  });

  it("repins a genuine pre-resize recipe digest across snapshots and resolved history", () => {
    const store = new WorkspaceStore();
    const recipe = prepareComponentRecipe({
      typeId: "recipe.legacy-card",
      version: "1.0.0",
      displayName: "Legacy card",
      allowedPlacements: ["viewport"],
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [], actions: {}, events: {},
      root: { id: "root", primitive: "stack" },
    });
    applyOperations(store, "legacy_recipe_define", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }]);
    applyOperations(store, "legacy_recipe_create", [{
      op: "create_component", op_id: "create", id: "CMP_000050",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 8, height: 9 },
      },
    }]);

    const serializer = new WorkspaceProjectSerializer();
    const legacy = structuredClone(serializer.fromStore("legacy_recipe_digest", store)) as any;
    const {
      digest: _canonicalDigest,
      resizePolicy: _canonicalPolicy,
      ...legacyContent
    } = recipe;
    const legacyDigest = deterministicDigest(legacyContent);
    const legacyRecipe = { ...legacyContent, digest: legacyDigest };
    const legacyBaseRegistry = "legacy_recipe_base_registry";
    const legacyCustomRegistry = "legacy_recipe_custom_registry";
    legacy.protocolVersion = "1.0";
    legacy.workspaceSchemaVersion = "1.0";
    legacy.registryDigest = legacyCustomRegistry;
    legacy.checkpoint.protocolVersion = "1.0";
    legacy.checkpoint.workspaceSchemaVersion = "1.0";
    legacy.checkpoint.registryDigest = legacyBaseRegistry;
    legacy.workspace.protocolVersion = "1.0";
    legacy.workspace.workspaceSchemaVersion = "1.0";
    legacy.workspace.registryDigest = legacyCustomRegistry;
    legacy.workspace.recipes[0][1] = structuredClone(legacyRecipe);
    const savedComponent = legacy.workspace.components
      .find(([, component]: any[]) => component.id === "CMP_000050")[1];
    savedComponent.type.digest = legacyDigest;
    delete savedComponent.locks.resize;
    for (const [index, command] of legacy.commandHistory.entries()) {
      command.inputRegistryDigest = index === 0 ? legacyBaseRegistry : legacyCustomRegistry;
      command.resultingRegistryDigest = legacyCustomRegistry;
      if (command.resolvedOperations[0].op === "define_component_recipe") {
        command.resolvedOperations[0].recipe = structuredClone(legacyRecipe);
      } else {
        command.resolvedOperations[0].component_type.digest = legacyDigest;
      }
    }
    for (const summary of legacy.workspace.history) {
      summary.resultingRegistryDigest = legacyCustomRegistry;
    }

    const migrated = serializer.deserialize(legacy);
    const migratedRecipe = migrated.workspace.recipes[0]?.[1];
    expect(migratedRecipe?.digest).toBe(recipe.digest);
    expect(migratedRecipe?.resizePolicy).toMatchObject({
      viewport: {
        kind: "box2d", mode: "free",
        minSize: { width: 1, height: 1 },
        maxSize: { width: 4_096, height: 4_096 },
      },
    });
    expect(migrated.workspace.components[0]?.[1].type.digest).toBe(recipe.digest);
    expect(migrated.commandHistory[0]?.resolvedOperations[0]).toMatchObject({
      op: "define_component_recipe", recipe: { digest: recipe.digest },
    });
    expect(migrated.commandHistory[1]?.resolvedOperations[0]).toMatchObject({
      op: "create_component", component_type: { digest: recipe.digest },
    });

    const reopened = serializer.openStore(migrated);
    expect(reopened.getState().components.get("CMP_000050")?.placement.size)
      .toEqual({ width: 8, height: 9 });
    reopened.undo();
    expect(reopened.getState().components.has("CMP_000050")).toBe(false);
    expect(reopened.getState().recipes.has("recipe.legacy-card@1.0.0")).toBe(true);
    reopened.undo();
    expect(reopened.getState().recipes.has("recipe.legacy-card@1.0.0")).toBe(false);
    reopened.redo();
    reopened.redo();
    expect(reopened.getState().components.get("CMP_000050")?.type.digest).toBe(recipe.digest);

    const migratedAgain = serializer.deserialize(serializer.serialize(migrated));
    expect(migratedAgain.workspace.recipes[0]?.[1].digest).toBe(recipe.digest);
    expect(serializer.openStore(migratedAgain).getState().components.get("CMP_000050")?.placement.size)
      .toEqual({ width: 8, height: 9 });

    const checkpointSeed = new WorkspaceStore();
    applyOperations(checkpointSeed, "checkpoint_recipe_define", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }]);
    const continuation = new WorkspaceStore({
      initialState: checkpointSeed.getState() as any,
      nextComponentSequence: checkpointSeed.getAllocatorSnapshot(),
      nextEventCursor: checkpointSeed.getNextEventCursor(),
    });
    applyOperations(continuation, "checkpoint_recipe_create", [{
      op: "create_component", op_id: "create", id: "CMP_000051",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 10, height: 11 },
      },
    }]);
    const checkpointLegacy = structuredClone(serializer.create({
      projectId: "legacy_checkpoint_recipe",
      checkpoint: checkpointSeed.getState() as any,
      workspace: continuation.getState() as any,
      checkpointNextComponentSequence: checkpointSeed.getAllocatorSnapshot(),
      nextComponentSequence: continuation.getAllocatorSnapshot(),
      checkpointNextEventCursor: checkpointSeed.getNextEventCursor(),
      nextEventCursor: continuation.getNextEventCursor(),
      commandHistory: continuation.getCommandHistory(),
    })) as any;
    checkpointLegacy.protocolVersion = "1.0";
    checkpointLegacy.workspaceSchemaVersion = "1.0";
    checkpointLegacy.registryDigest = legacyCustomRegistry;
    for (const snapshot of [checkpointLegacy.checkpoint, checkpointLegacy.workspace]) {
      snapshot.protocolVersion = "1.0";
      snapshot.workspaceSchemaVersion = "1.0";
      snapshot.registryDigest = legacyCustomRegistry;
      snapshot.recipes[0][1] = structuredClone(legacyRecipe);
      for (const summary of snapshot.history) summary.resultingRegistryDigest = legacyCustomRegistry;
      for (const [, component] of snapshot.components) {
        component.type.digest = legacyDigest;
        delete component.locks.resize;
      }
    }
    checkpointLegacy.commandHistory[0].inputRegistryDigest = legacyCustomRegistry;
    checkpointLegacy.commandHistory[0].resultingRegistryDigest = legacyCustomRegistry;
    checkpointLegacy.commandHistory[0].resolvedOperations[0].component_type.digest = legacyDigest;

    const migratedCheckpoint = serializer.deserialize(checkpointLegacy);
    expect(migratedCheckpoint.checkpoint.recipes[0]?.[1].digest).toBe(recipe.digest);
    expect(migratedCheckpoint.workspace.components[0]?.[1].type.digest).toBe(recipe.digest);
    expect(migratedCheckpoint.commandHistory[0]?.resolvedOperations[0]).toMatchObject({
      op: "create_component", component_type: { digest: recipe.digest },
    });
    expect(serializer.openStore(migratedCheckpoint).getState().components.get("CMP_000051")?.placement.size)
      .toEqual({ width: 10, height: 11 });

    const tampered = structuredClone(legacy);
    tampered.workspace.recipes[0][1].displayName = "Tampered";
    expect(() => serializer.deserialize(tampered)).toThrow(/invalid pre-resize digest/i);
  }, 30_000);

  it("migrates sequential legacy recipe redefinitions separated by clear_workspace", () => {
    const recipeA = prepareComponentRecipe({
      typeId: "recipe.redefined-card",
      version: "1.0.0",
      displayName: "Definition A",
      allowedPlacements: ["viewport"],
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [], actions: {}, events: {},
      root: { id: "root-a", primitive: "stack" },
    });
    const { digest: _recipeADigest, resizePolicy: _recipeAPolicy, ...recipeABase } = recipeA;
    const recipeB = prepareComponentRecipe({
      ...recipeABase,
      displayName: "Definition B",
      root: { id: "root-b", primitive: "grid" },
    });
    const store = new WorkspaceStore();
    applyOperations(store, "define_a", [{
      op: "define_component_recipe", op_id: "define_a", recipe: recipeA,
    }]);
    applyOperations(store, "create_a", [{
      op: "create_component", op_id: "create_a", id: "CMP_000060",
      component_type: { typeId: recipeA.typeId, version: recipeA.version, digest: recipeA.digest },
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 12, height: 13 },
      },
    }]);
    applyOperations(store, "clear_a", [{
      op: "clear_workspace", op_id: "clear", confirm: true,
    }]);
    applyOperations(store, "define_b", [{
      op: "define_component_recipe", op_id: "define_b", recipe: recipeB,
    }]);
    applyOperations(store, "create_b", [{
      op: "create_component", op_id: "create_b", id: "CMP_000061",
      component_type: { typeId: recipeB.typeId, version: recipeB.version, digest: recipeB.digest },
      placement: {
        space: "viewport", anchor: "center", offset: { x: 1, y: 2 },
        size: { width: 14, height: 15 },
      },
    }]);

    const legacyize = (recipe: typeof recipeA) => {
      const { digest: _digest, resizePolicy: _policy, ...content } = recipe;
      return { ...content, digest: deterministicDigest(content) };
    };
    const oldA = legacyize(recipeA);
    const oldB = legacyize(recipeB);
    const serializer = new WorkspaceProjectSerializer();
    const legacy = structuredClone(serializer.fromStore("legacy_recipe_redefinition", store)) as any;
    const registryBase = "legacy_redefine_base";
    const registryA = "legacy_redefine_a";
    const registryB = "legacy_redefine_b";
    legacy.protocolVersion = "1.0";
    legacy.workspaceSchemaVersion = "1.0";
    legacy.registryDigest = registryB;
    legacy.checkpoint.protocolVersion = "1.0";
    legacy.checkpoint.workspaceSchemaVersion = "1.0";
    legacy.checkpoint.registryDigest = registryBase;
    legacy.workspace.protocolVersion = "1.0";
    legacy.workspace.workspaceSchemaVersion = "1.0";
    legacy.workspace.registryDigest = registryB;
    legacy.workspace.recipes[0][1] = structuredClone(oldB);
    legacy.workspace.components[0][1].type.digest = oldB.digest;
    delete legacy.workspace.components[0][1].locks.resize;
    const registryTimeline = [
      [registryBase, registryA],
      [registryA, registryA],
      [registryA, registryBase],
      [registryBase, registryB],
      [registryB, registryB],
    ];
    for (const [index, command] of legacy.commandHistory.entries()) {
      [command.inputRegistryDigest, command.resultingRegistryDigest] = registryTimeline[index];
      const operation = command.resolvedOperations[0];
      if (operation.op === "define_component_recipe") {
        operation.recipe = structuredClone(index === 0 ? oldA : oldB);
      } else if (operation.op === "create_component") {
        operation.component_type.digest = index === 1 ? oldA.digest : oldB.digest;
      }
      legacy.workspace.history[index].resultingRegistryDigest = registryTimeline[index][1];
    }

    const migrated = serializer.deserialize(legacy);
    expect(migrated.commandHistory[0]?.resolvedOperations[0]).toMatchObject({
      op: "define_component_recipe", recipe: { digest: recipeA.digest },
    });
    expect(migrated.commandHistory[1]?.resolvedOperations[0]).toMatchObject({
      op: "create_component", component_type: { digest: recipeA.digest },
    });
    expect(migrated.commandHistory[3]?.resolvedOperations[0]).toMatchObject({
      op: "define_component_recipe", recipe: { digest: recipeB.digest },
    });
    expect(migrated.commandHistory[4]?.resolvedOperations[0]).toMatchObject({
      op: "create_component", component_type: { digest: recipeB.digest },
    });
    const reopened = serializer.openStore(migrated);
    expect(reopened.getState().components.get("CMP_000061")?.type.digest).toBe(recipeB.digest);
    reopened.undo();
    reopened.undo();
    expect(reopened.getState().recipes.size).toBe(0);
    reopened.undo();
    expect(reopened.getState().components.get("CMP_000060")?.type.digest).toBe(recipeA.digest);
    reopened.redo();
    reopened.redo();
    reopened.redo();
    expect(reopened.getState().components.get("CMP_000061")?.type.digest).toBe(recipeB.digest);

    const migratedAgain = serializer.deserialize(serializer.serialize(migrated));
    expect(serializer.openStore(migratedAgain).getState().components.get("CMP_000061")?.type.digest)
      .toBe(recipeB.digest);
  }, 30_000);

  it("keeps a maximum-size 1.0 batch atomic when 100 place operations expand to 200 resolved operations", () => {
    const store = new WorkspaceStore();
    applyOperations(store, "create_boundary_image", [{
      op: "create_component",
      op_id: "create_image",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("image"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]);
    applyOperations(store, "place_boundary_image", Array.from({ length: 100 }, (_, index) => ({
      op: "place_component" as const,
      op_id: `place_${index}`,
      id: "CMP_000001",
      placement: {
        space: "viewport" as const,
        anchor: "center" as const,
        offset: { x: index, y: -index },
        size: { width: 320, height: 220 },
      },
    })));

    const serializer = new WorkspaceProjectSerializer();
    const legacy = downgradeBuiltinProject(serializer.fromStore("legacy_max_batch", store));
    for (const [index, operation] of legacy.commandHistory[1].resolvedOperations.entries()) {
      operation.placement.size = { width: 200 + index, height: 200 + index };
    }
    const finalSize = { width: 299, height: 299 };
    legacy.workspace.components[0][1].placement.size = finalSize;

    const migrated = serializer.deserialize(legacy);
    expect(migrated.commandHistory[1]?.resolvedOperations).toHaveLength(200);
    expect(migrated.workspace.history[1]?.operationIds).toHaveLength(200);
    const reopened = serializer.openStore(migrated);
    expect(reopened.getRevision()).toBe(2);
    expect(reopened.getState().components.get("CMP_000001")?.placement).toMatchObject({
      offset: { x: 99, y: -99 },
      size: finalSize,
    });
    reopened.undo();
    expect(reopened.getRevision()).toBe(1);
    expect(reopened.getState().components.get("CMP_000001")?.placement).toMatchObject({
      offset: { x: 0, y: 0 },
      size: { width: 320, height: 220 },
    });
    reopened.redo();
    expect(reopened.getRevision()).toBe(2);
    expect(reopened.getState().components.get("CMP_000001")?.placement.size).toEqual(finalSize);

    const secondPass = serializer.deserialize(serializer.serialize(migrated));
    expect(secondPass.commandHistory[1]?.resolvedOperations).toHaveLength(200);
    expect(serializer.openStore(secondPass).getState().components.get("CMP_000001")?.placement.size)
      .toEqual(finalSize);
  });
});
