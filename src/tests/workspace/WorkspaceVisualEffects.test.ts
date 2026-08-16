import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENT_REGISTRY,
  DEFAULT_COMPONENT_VISUAL_EFFECTS,
} from "../../workspace/components";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import {
  PREVIOUS_WORKSPACE_PROTOCOL_VERSION,
  PREVIOUS_WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_PROTOCOL_VERSION,
} from "../../workspace/protocol";
import { WorkspacePermissionError, WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const vivid = {
  opacity: 0.64,
  emissive: { color: "#FF8844" as const, intensity: 2.5 },
  glow: { color: "#36CFFF" as const, intensity: 1.4, spread: 0.7 },
};

function createTimer(store: WorkspaceStore, requestId = "create_timer") {
  return store.applyDetailed(workspaceBatch(store, requestId, [{
    op: "create_component",
    op_id: `${requestId}_op`,
    id: "CMP_000001",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
  }]));
}

describe("Workspace Protocol 1.2 universal visual effects", () => {
  it("materializes neutral defaults and commits one absolute idempotent undo step", () => {
    const store = new WorkspaceStore();
    createTimer(store);
    expect(store.getState().components.get("CMP_000001")?.visualEffects)
      .toEqual(DEFAULT_COMPONENT_VISUAL_EFFECTS);

    const command = workspaceBatch(store, "effects_timer", [{
      op: "set_component_visual_effects",
      op_id: "effects_timer_op",
      id: "CMP_000001",
      visual_effects: vivid,
    }]);
    const first = store.applyDetailed(command);
    const retry = store.applyDetailed(command);
    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(store.getRevision()).toBe(2);
    expect(store.getState().components.get("CMP_000001")?.visualEffects).toEqual(vivid);

    store.undo();
    expect(store.getState().components.get("CMP_000001")?.visualEffects)
      .toEqual(DEFAULT_COMPONENT_VISUAL_EFFECTS);
    store.redo();
    expect(store.getState().components.get("CMP_000001")?.visualEffects).toEqual(vivid);
  });

  it("enforces bounds, colors, locks, permissions, and the 1.2 protocol gate", () => {
    const store = new WorkspaceStore();
    createTimer(store);
    const invalid = workspaceBatch(store, "invalid_effects", [{
      op: "set_component_visual_effects",
      op_id: "invalid_effects_op",
      id: "CMP_000001",
      visual_effects: { ...vivid, opacity: 1.2 },
    }]);
    expect(() => store.apply(invalid)).toThrow(/match protocol|must be <= 1|between 0 and 1/i);
    expect(store.getRevision()).toBe(1);

    const denied = workspaceBatch(store, "denied_effects", [{
      op: "set_component_visual_effects",
      op_id: "denied_effects_op",
      id: "CMP_000001",
      visual_effects: vivid,
    }]);
    expect(() => store.apply(denied, { actor: "agent", permissions: ["workspace:write"] }))
      .toThrow(WorkspacePermissionError);

    store.apply(workspaceBatch(store, "lock_effects", [{
      op: "update_component",
      op_id: "lock_effects_op",
      id: "CMP_000001",
      patch: { locks: { visualEffects: true } },
    }]));
    expect(() => store.apply(workspaceBatch(store, "locked_effects", [{
      op: "set_component_visual_effects",
      op_id: "locked_effects_op",
      id: "CMP_000001",
      visual_effects: vivid,
    }]))).toThrow(/visual effects are locked/i);

    expect(() => store.apply({
      ...workspaceBatch(store, "old_protocol_effects", [{
        op: "set_component_visual_effects",
        op_id: "old_protocol_effects_op",
        id: "CMP_000001",
        visual_effects: vivid,
      }]),
      protocol_version: PREVIOUS_WORKSPACE_PROTOCOL_VERSION,
    })).toThrow(/requires Workspace Protocol 1.2/i);
  });

  it("opens a 1.1 project with neutral defaults and replays later effects exactly", () => {
    const store = new WorkspaceStore();
    createTimer(store);
    const serializer = new WorkspaceProjectSerializer();
    const current = serializer.fromStore("visual-effects-migration", store, {
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    const previous = structuredClone(current) as unknown as Record<string, any>;
    previous.protocolVersion = PREVIOUS_WORKSPACE_PROTOCOL_VERSION;
    previous.workspaceSchemaVersion = PREVIOUS_WORKSPACE_SCHEMA_VERSION;
    for (const snapshot of [previous.checkpoint, previous.workspace]) {
      snapshot.protocolVersion = PREVIOUS_WORKSPACE_PROTOCOL_VERSION;
      snapshot.workspaceSchemaVersion = PREVIOUS_WORKSPACE_SCHEMA_VERSION;
      for (const [, component] of snapshot.components) {
        delete component.visualEffects;
        delete component.locks.visualEffects;
      }
    }
    for (const command of previous.commandHistory) {
      for (const operation of command.resolvedOperations) {
        if (operation.op !== "create_component") continue;
        delete operation.visual_effects;
        delete operation.locks.visualEffects;
      }
    }

    const migrated = serializer.deserialize(previous);
    expect(migrated.protocolVersion).toBe(WORKSPACE_PROTOCOL_VERSION);
    const reopened = serializer.openStore(migrated);
    expect(reopened.getState().components.get("CMP_000001")?.visualEffects)
      .toEqual(DEFAULT_COMPONENT_VISUAL_EFFECTS);
    reopened.apply(workspaceBatch(reopened, "post_migration_effects", [{
      op: "set_component_visual_effects",
      op_id: "post_migration_effects_op",
      id: "CMP_000001",
      visual_effects: vivid,
    }]));
    const roundTrip = serializer.deserialize(serializer.serialize(
      serializer.fromStore("visual-effects-migration", reopened),
    ));
    expect(serializer.openStore(roundTrip).getState().components.get("CMP_000001")?.visualEffects)
      .toEqual(vivid);
  });
});
