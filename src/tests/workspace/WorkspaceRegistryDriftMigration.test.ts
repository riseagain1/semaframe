import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMPONENT_MANIFESTS,
  ComponentRegistry,
  DEFAULT_COMPONENT_REGISTRY,
} from "../../workspace/components";
import {
  WorkspaceProjectSerializer,
} from "../../workspace/persistence";
import {
  prepareComponentRecipe,
  type WorkspaceCommandRecord,
  type WorkspaceOperation,
} from "../../workspace/protocol";
import { WorkspaceStore } from "../../workspace/state";
import { semanticWorkspaceEqual } from "../../workspace/state/workspaceUtils";
import { workspaceBatch } from "./helpers";

const PRE_MOVE_REGISTRY = new ComponentRegistry(BUILTIN_COMPONENT_MANIFESTS.filter((manifest) => !(
  (manifest.typeId === "spatial-entity" && manifest.version === "1.6.0")
  || (manifest.typeId === "spatial-primitive" && manifest.version === "1.1.0")
  || (manifest.typeId === "model-assembly" && manifest.version === "1.1.0")
)));

function recipe(typeId: string, displayName: string, rootId: string) {
  return prepareComponentRecipe({
    typeId,
    version: "1.0.0",
    displayName,
    allowedPlacements: ["viewport"],
    propsSchema: { type: "object", additionalProperties: false },
    durableStateSchema: { type: "object", additionalProperties: false },
    defaultProps: {},
    defaultDurableState: {},
    writableProps: [],
    actions: {},
    events: {},
    root: { id: rootId, primitive: "stack" },
  });
}

function apply(store: WorkspaceStore, requestId: string, operations: WorkspaceOperation[]): void {
  store.apply(workspaceBatch(store, requestId, operations));
}

function withoutRegistryDigests(command: WorkspaceCommandRecord) {
  const {
    inputRegistryDigest: _inputRegistryDigest,
    resultingRegistryDigest: _resultingRegistryDigest,
    ...rest
  } = structuredClone(command);
  return rest;
}

describe("Workspace current-project registry drift migration", () => {
  it("rebases a real pre-move 1.3 project by replaying recipe-changing history", () => {
    expect(PRE_MOVE_REGISTRY.digest).not.toBe(DEFAULT_COMPONENT_REGISTRY.digest);
    const recipeA = recipe("recipe.checkpoint-a", "Checkpoint A", "root-a");
    const recipeB = recipe("recipe.active", "Active B", "root-b");
    const recipeC = recipe("recipe.active", "Active C", "root-c");

    const checkpointStore = new WorkspaceStore({ registry: PRE_MOVE_REGISTRY, clock: () => 1_000 });
    apply(checkpointStore, "define_checkpoint_a", [{
      op: "define_component_recipe",
      op_id: "define_a",
      recipe: recipeA,
    }]);
    const checkpoint = checkpointStore.getState();

    const continuation = new WorkspaceStore({
      registry: PRE_MOVE_REGISTRY,
      initialState: checkpoint as never,
      checkpointState: checkpoint as never,
      nextComponentSequence: checkpointStore.getAllocatorSnapshot(),
      checkpointNextComponentSequence: checkpointStore.getAllocatorSnapshot(),
      nextEventCursor: checkpointStore.getNextEventCursor(),
      checkpointNextEventCursor: checkpointStore.getNextEventCursor(),
      clock: () => 2_000,
    });
    apply(continuation, "define_active_b", [{
      op: "define_component_recipe",
      op_id: "define_b",
      recipe: recipeB,
    }]);
    apply(continuation, "create_active_components", [{
      op: "create_component",
      op_id: "create_b",
      id: "RECIPE_B",
      component_type: {
        typeId: recipeB.typeId,
        version: recipeB.version,
        digest: recipeB.digest,
      },
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 240, height: 144 },
      },
    }, {
      op: "create_component",
      op_id: "create_button",
      id: "BUTTON",
      component_type: PRE_MOVE_REGISTRY.ref("button"),
      placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: 0 } },
    }]);
    apply(continuation, "press_before_clear", [{
      op: "invoke_component_action",
      op_id: "press_button",
      id: "BUTTON",
      action: "press",
      input: {},
    }]);
    apply(continuation, "clear_active_b", [{
      op: "clear_workspace",
      op_id: "clear",
      confirm: true,
    }]);
    apply(continuation, "define_active_c", [{
      op: "define_component_recipe",
      op_id: "define_c",
      recipe: recipeC,
    }]);
    apply(continuation, "create_active_c", [{
      op: "create_component",
      op_id: "create_c",
      id: "RECIPE_C",
      component_type: {
        typeId: recipeC.typeId,
        version: recipeC.version,
        digest: recipeC.digest,
      },
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 4, y: 5 },
        size: { width: 200, height: 120 },
      },
    }]);

    const oldSerializer = new WorkspaceProjectSerializer(PRE_MOVE_REGISTRY);
    const oldProject = oldSerializer.create({
      projectId: "pre-move-registry",
      checkpoint: checkpoint as never,
      workspace: continuation.getState() as never,
      checkpointNextComponentSequence: checkpointStore.getAllocatorSnapshot(),
      nextComponentSequence: continuation.getAllocatorSnapshot(),
      checkpointNextEventCursor: checkpointStore.getNextEventCursor(),
      nextEventCursor: continuation.getNextEventCursor(),
      commandHistory: continuation.getCommandHistory(),
    });
    const oldCommands = structuredClone(oldProject.commandHistory);
    const oldCheckpointDigest = oldProject.checkpoint.registryDigest;
    const oldFinalDigest = oldProject.workspace.registryDigest;

    const serializer = new WorkspaceProjectSerializer();
    const migrated = serializer.deserialize(oldSerializer.serialize(oldProject));
    expect(migrated.checkpoint.registryDigest).not.toBe(oldCheckpointDigest);
    expect(migrated.workspace.registryDigest).not.toBe(oldFinalDigest);
    expect(migrated.registryDigest).toBe(migrated.workspace.registryDigest);
    expect(migrated.checkpoint.history).toEqual([
      expect.objectContaining({ resultingRegistryDigest: migrated.checkpoint.registryDigest }),
    ]);

    expect(migrated.commandHistory.map(withoutRegistryDigests))
      .toEqual(oldCommands.map(withoutRegistryDigests));
    expect(migrated.commandHistory.map((command) => command.inputRegistryDigest))
      .toEqual([
        migrated.checkpoint.registryDigest,
        migrated.commandHistory[0]!.resultingRegistryDigest,
        migrated.commandHistory[1]!.resultingRegistryDigest,
        migrated.commandHistory[2]!.resultingRegistryDigest,
        migrated.commandHistory[3]!.resultingRegistryDigest,
        migrated.commandHistory[4]!.resultingRegistryDigest,
      ]);
    for (const [index, command] of migrated.commandHistory.entries()) {
      const summary = migrated.workspace.history[migrated.checkpoint.history.length + index];
      expect(summary?.resultingRegistryDigest).toBe(command.resultingRegistryDigest);
    }
    expect(new Set(migrated.commandHistory.flatMap((command) => [
      command.inputRegistryDigest,
      command.resultingRegistryDigest,
    ])).size).toBeGreaterThan(3);
    const clearCommand = migrated.commandHistory.find((command) => command.requestId === "clear_active_b")!;
    const defineCCommand = migrated.commandHistory.find((command) => command.requestId === "define_active_c")!;
    expect(clearCommand.resultingRegistryDigest).toBe(DEFAULT_COMPONENT_REGISTRY.digest);
    expect(defineCCommand.inputRegistryDigest).toBe(DEFAULT_COMPONENT_REGISTRY.digest);

    const reopened = serializer.openStore(migrated);
    const expectedState = continuation.getState() as never;
    const actualState = reopened.getState() as never;
    (expectedState as { registryDigest: string }).registryDigest =
      (actualState as { registryDigest: string }).registryDigest;
    (expectedState as { history: unknown[] }).history =
      structuredClone((actualState as { history: unknown[] }).history);
    expect(semanticWorkspaceEqual(expectedState, actualState)).toBe(true);
    expect(reopened.getCommandHistory()).toEqual(migrated.commandHistory);
    expect(reopened.undoUserCommand()).not.toBeNull();
    expect(reopened.getState().components.has("RECIPE_C")).toBe(false);
    expect(reopened.redoUserCommand()).not.toBeNull();
    expect(reopened.getState().components.has("RECIPE_C")).toBe(true);

    const migratedAgain = serializer.deserialize(serializer.serialize(migrated));
    expect(migratedAgain).toEqual(migrated);
    expect(serializer.openStore(migratedAgain).getState()).toEqual(
      serializer.openStore(migrated).getState(),
    );
  }, 60_000);
});
