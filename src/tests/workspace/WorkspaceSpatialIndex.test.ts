import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  buildUniversalSpaceData,
  findBlockingSpatialCollisions,
  querySpatialPlacement,
} from "../../workspace/spatial";
import { WorkspaceStore } from "../../workspace/state";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { workspaceBatch } from "./helpers";

const transform = (
  x: number,
  y = 0,
  z = 0,
  rotationY = 0,
) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: rotationY, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

function createStage() {
  return {
    op: "create_component" as const,
    op_id: "create_stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: transform(0),
  };
}

function createSpatial(
  id: string,
  x: number,
  z = 0,
  options: { parentId?: string; rotationY?: number; role?: "solid" | "trigger" | "none" } = {},
) {
  return {
    op: "create_component" as const,
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
    ...(options.parentId ? { parent_id: options.parentId } : {}),
    placement: transform(x, 0, z, options.rotationY ?? 0),
    props: {
      assetId: "primitive_box",
      entityKind: "primitive" as const,
      ...(options.role ? {
        collision: { enabled: true, role: options.role, shape: "asset_bounds" as const, margin: 0 },
      } : {}),
    },
  };
}

describe("Universal Space Data spatial index", () => {
  it("projects deterministic world transforms, prim paths, bounds, and support relations", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "space", [
      createStage(),
      createSpatial("PARENT", 2, 3, { rotationY: Math.PI / 2 }),
      createSpatial("CHILD", 1, 0, { parentId: "PARENT" }),
    ]));

    const snapshot = buildUniversalSpaceData(store.getState());
    expect(snapshot).toMatchObject({
      format: "universal-space-data",
      version: "2.0",
      workspaceRevision: 1,
      coordinateSystem: { units: "meters", upAxis: "+Y", forwardAxis: "+Z" },
      stage: {
        componentId: "STAGE",
        visibility: "visible",
        dimensions: { width: 12, height: 4, depth: 10 },
        groundHeight: 0,
      },
      mode: "full",
      removedNodeIds: [],
      collisionConflictsTruncated: false,
      omittedNodeCount: 0,
    });
    expect(snapshot.nodes.map((node) => node.id)).toEqual(["CHILD", "PARENT"]);
    const child = snapshot.nodes.find((node) => node.id === "CHILD")!;
    expect(child.primPath).toBe("/World/PARENT/CHILD");
    expect(child.worldTransform.position.x).toBeCloseTo(2, 6);
    expect(child.worldTransform.position.z).toBeCloseTo(2, 6);
    expect(child.worldBounds.size).toMatchObject({ x: 1, y: 1, z: 1 });
  });

  it("uses oriented boxes, allows face touching, and ignores trigger volumes", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "space", [
      createStage(),
      createSpatial("A", 0),
      createSpatial("TOUCHING", 1.04),
      createSpatial("ROTATED", 2.5, 2.5, { rotationY: Math.PI / 4 }),
      createSpatial("TRIGGER", 0.2, 0, { role: "trigger" }),
    ]));
    const conflicts = findBlockingSpatialCollisions(store.getState());
    expect(conflicts).toEqual([]);

    const check = querySpatialPlacement(store.getState(), {
      assetId: "primitive_box",
      entityKind: "primitive",
      placement: transform(0.25),
    });
    expect(check.valid).toBe(false);
    expect(check.conflicts.some((conflict) => conflict.conflictsWith === "A")).toBe(true);
    expect(check.suggestedPlacements).toHaveLength(4);
  });

  it("checks updates without colliding an entity with itself and returns an empty delta", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "space", [createStage(), createSpatial("A", 0)]));
    expect(querySpatialPlacement(store.getState(), {
      componentId: "A",
      placement: transform(4),
    })).toMatchObject({ valid: true, candidateId: "A", conflicts: [] });
    expect(buildUniversalSpaceData(store.getState(), {
      mode: "delta",
      sinceRevision: 1,
      changedNodeIds: new Set(),
    })).toMatchObject({ mode: "delta", sinceRevision: 1, nodes: [] });
  });

  it("rejects overlaps atomically and preserves collision intent through undo, redo, and reopen", () => {
    const rejected = new WorkspaceStore();
    expect(() => rejected.apply(workspaceBatch(rejected, "overlap", [
      createStage(), createSpatial("A", 0), createSpatial("B", 0.5),
    ]))).toThrowError(expect.objectContaining({
      code: "spatial_collision",
      conflicts: [expect.objectContaining({ componentId: "A", conflictsWith: "B" })],
    }));
    expect(rejected.getRevision()).toBe(0);
    expect(rejected.getState().components.size).toBe(0);

    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "clear_space", [
      createStage(), createSpatial("A", 0), createSpatial("B", 3),
    ]));
    expect(() => store.apply(workspaceBatch(store, "bad_move", [{
      op: "place_component", op_id: "move_b", id: "B", placement: transform(0.2),
    }]))).toThrow(/spatial collision/i);
    expect(store.getRevision()).toBe(1);
    expect(store.getState().components.get("B")?.placement).toEqual(transform(3));

    store.apply(workspaceBatch(store, "good_move", [{
      op: "place_component", op_id: "move_b", id: "B", placement: transform(4),
    }]));
    store.undo();
    expect(store.getState().components.get("B")?.placement).toEqual(transform(3));
    store.redo();
    expect(store.getState().components.get("B")?.placement).toEqual(transform(4));
    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("collision", store),
    )));
    expect(reopened.getState().components.get("A")?.props.collision).toMatchObject({
      enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02,
    });
    expect(findBlockingSpatialCollisions(reopened.getState())).toEqual([]);
  });

  it("permits parent-child face attachment but detects actual hierarchical penetration", () => {
    const touching = new WorkspaceStore();
    touching.apply(workspaceBatch(touching, "attached_touch", [
      createStage(),
      createSpatial("PARENT", 0),
      createSpatial("CHILD", 1, 0, { parentId: "PARENT" }),
    ]));
    expect(findBlockingSpatialCollisions(touching.getState())).toEqual([]);

    const penetrating = new WorkspaceStore();
    expect(() => penetrating.apply(workspaceBatch(penetrating, "attached_overlap", [
      createStage(),
      createSpatial("PARENT", 0),
      createSpatial("CHILD", 0.5, 0, { parentId: "PARENT" }),
    ]))).toThrowError(expect.objectContaining({ code: "spatial_collision" }));
  });

  it("caps nodes before relationship analysis", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "bounded_analysis", [
      createStage(),
      createSpatial("A", -4),
      createSpatial("B", 0),
      createSpatial("C", 4),
    ]));
    const snapshot = buildUniversalSpaceData(store.getState(), { maxNodes: 1 });
    expect(snapshot.nodes.map((node) => node.id)).toEqual(["A"]);
    expect(snapshot.nodes[0]?.relations).toEqual([]);
    expect(snapshot.collisionConflicts).toEqual([]);
    expect(snapshot.omittedNodeCount).toBe(2);
  });

  it("rejects a persisted workspace above the spatial analysis capacity before collision work", () => {
    const base = new WorkspaceStore();
    base.apply(workspaceBatch(base, "capacity_base", [createStage(), createSpatial("BODY_0000", 0)]));
    const state = base.getState();
    const sample = state.components.get("BODY_0000")!;
    const components = new Map(state.components);
    for (let index = 1; index <= 2_000; index += 1) {
      const id = `BODY_${String(index).padStart(4, "0")}`;
      components.set(id, { ...structuredClone(sample), id, label: id });
    }
    expect(() => new WorkspaceStore({ initialState: { ...state, components } }))
      .toThrowError(expect.objectContaining({ code: "spatial_capacity_exceeded" }));
  });
});
