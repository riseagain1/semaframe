import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { createInitialWorkspace, WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const worldPlacement = {
  space: "world3d" as const,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

function stage(id = "CMP_000001") {
  return {
    op: "create_component" as const,
    op_id: `stage_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: worldPlacement,
  };
}

function spatial(id = "CMP_000002") {
  return {
    op: "create_component" as const,
    op_id: `spatial_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
    placement: worldPlacement,
    props: { assetId: "primitive_box", entityKind: "primitive" as const },
  };
}

describe("explicit 3D stage basis", () => {
  it("starts empty and requires an explicit stage before spatial creation", () => {
    const store = new WorkspaceStore();
    expect(store.getState().components.size).toBe(0);
    try {
      store.apply(workspaceBatch(store, "spatial_without_stage", [spatial()]));
      throw new Error("Expected spatial creation to require a stage");
    } catch (error) {
      expect(error).toMatchObject({ code: "stage_basis_required" });
    }
    expect(store.getRevision()).toBe(0);
    expect(store.getState().components.size).toBe(0);
  });

  it("accepts an ordered stage-plus-spatial transaction and enforces one-stage uniqueness", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "stage_then_spatial", [stage(), spatial()]));
    expect([...store.getState().components.values()].map((component) => component.type.typeId))
      .toEqual(["stage-3d", "spatial-entity"]);
    expect(() => store.apply(workspaceBatch(store, "second_stage", [stage("CMP_000003")])))
      .toThrow(/already has stage-3d basis/);
    expect(store.getRevision()).toBe(1);
  });

  it("clears the native stage and its dependents to zero and restores them through history", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "world", [stage(), spatial()]));
    store.apply(workspaceBatch(store, "clear", [{
      op: "clear_workspace",
      op_id: "clear",
      confirm: true,
    }]));
    expect(store.getState().components.size).toBe(0);
    store.undo();
    expect(store.getState().components.size).toBe(2);
    store.redo();
    expect(store.getState().components.size).toBe(0);
  });

  it("round-trips both an empty project and an explicit 3D project", () => {
    const serializer = new WorkspaceProjectSerializer();
    const empty = new WorkspaceStore();
    const reopenedEmpty = serializer.openStore(serializer.deserialize(
      serializer.serialize(serializer.fromStore("empty", empty)),
    ));
    expect(reopenedEmpty.getState().components.size).toBe(0);

    const world = new WorkspaceStore();
    world.apply(workspaceBatch(world, "world", [stage(), spatial()]));
    const reopenedWorld = serializer.openStore(serializer.deserialize(
      serializer.serialize(serializer.fromStore("world", world)),
    ));
    expect([...reopenedWorld.getState().components.values()].map((component) => component.type.typeId))
      .toEqual(["stage-3d", "spatial-entity"]);
  });

  it("rejects persisted spatial state without a stage and a non-root stage", () => {
    const missingStage = createInitialWorkspace();
    const valid = new WorkspaceStore();
    valid.apply(workspaceBatch(valid, "world", [stage(), spatial()]));
    missingStage.components.set("CMP_000002", structuredClone(valid.getState().components.get("CMP_000002")!));
    expect(() => new WorkspaceStore({ initialState: missingStage })).toThrow(/requires a stage-3d basis/);

    const nonRootStage = structuredClone(valid.getState());
    nonRootStage.components.get("CMP_000001")!.parentId = "CMP_000002";
    expect(() => new WorkspaceStore({ initialState: nonRootStage as never })).toThrow(/must be a root component/);
  });
});
