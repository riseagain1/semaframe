import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { buildSemaFrameSpatialGraph } from "../../workspace/spatial";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const placement = (
  position: { x: number; y: number; z: number },
  rotation = { x: 0, y: 0, z: 0 },
  scale = { x: 1, y: 1, z: 1 },
) => ({ space: "world3d" as const, position, rotation, scale });

const noCollision = {
  collision: { enabled: false, role: "none", shape: "asset_bounds", margin: 0 },
};

function setup(): WorkspaceStore {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "setup_reparent", [{
    op: "create_component",
    op_id: "stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: placement({ x: 0, y: 0, z: 0 }),
  }, {
    op: "create_component",
    op_id: "parent",
    id: "PARENT",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
    props: { assetId: "primitive_box", entityKind: "primitive", ...noCollision },
    placement: placement(
      { x: 4, y: 1, z: -3 },
      { x: 0.2, y: Math.PI / 3, z: -0.1 },
      { x: 2, y: 1.5, z: 0.75 },
    ),
  }, {
    op: "create_component",
    op_id: "child",
    id: "CHILD",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
    props: { assetId: "primitive_sphere", entityKind: "primitive", ...noCollision },
    placement: placement(
      { x: -2, y: 2.5, z: 5 },
      { x: -0.3, y: 0.4, z: 0.25 },
      { x: 0.8, y: 1.2, z: 0.6 },
    ),
  }]));
  return store;
}

function world(store: WorkspaceStore, id: string) {
  return buildSemaFrameSpatialGraph(store.getState()).nodes.find((node) => node.id === id)!.worldTransform;
}

function expectTransformClose(actual: ReturnType<typeof world>, expected: ReturnType<typeof world>) {
  for (const axis of ["x", "y", "z"] as const) {
    expect(actual.position[axis]).toBeCloseTo(expected.position[axis], 9);
    expect(actual.scale[axis]).toBeCloseTo(expected.scale[axis], 9);
    expect(Math.abs(actual.rotationQuaternion[axis])).toBeCloseTo(Math.abs(expected.rotationQuaternion[axis]), 9);
  }
  expect(Math.abs(actual.rotationQuaternion.w)).toBeCloseTo(Math.abs(expected.rotationQuaternion.w), 9);
}

describe("Workspace world-preserving reparenting", () => {
  it("attaches and detaches world3d components without visual movement", () => {
    const store = setup();
    const before = world(store, "CHILD");

    store.apply(workspaceBatch(store, "attach_world", [{
      op: "attach_component",
      op_id: "attach",
      child_id: "CHILD",
      parent_id: "PARENT",
      transform_mode: "preserve_world",
    }]));
    expect(store.getState().components.get("CHILD")?.parentId).toBe("PARENT");
    expectTransformClose(world(store, "CHILD"), before);

    store.apply(workspaceBatch(store, "detach_world", [{
      op: "detach_component",
      op_id: "detach",
      child_id: "CHILD",
      transform_mode: "preserve_world",
    }]));
    expect(store.getState().components.get("CHILD")?.parentId).toBeUndefined();
    expectTransformClose(world(store, "CHILD"), before);

    store.undo();
    expectTransformClose(world(store, "CHILD"), before);
    store.redo();
    expectTransformClose(world(store, "CHILD"), before);
  });

  it("keeps protocol-compatible preserve_local behavior and rejects cycles", () => {
    const store = setup();
    const before = world(store, "CHILD");
    store.apply(workspaceBatch(store, "attach_local", [{
      op: "attach_component",
      op_id: "attach",
      child_id: "CHILD",
      parent_id: "PARENT",
      transform_mode: "preserve_local",
    }]));
    expect(world(store, "CHILD").position).not.toEqual(before.position);
    expect(() => store.apply(workspaceBatch(store, "cycle", [{
      op: "attach_component",
      op_id: "cycle",
      child_id: "PARENT",
      parent_id: "CHILD",
      transform_mode: "preserve_world",
    }]))).toThrowError(expect.objectContaining({ code: "graph_cycle" }));
  });
});
