import { describe, expect, it, vi } from "vitest";
import {
  planWorkspaceModelInstance,
  WorkspaceModelExportGate,
} from "../../app/components/workspace";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { modelDefinitionRef } from "../../workspace/modeling";
import { findBlockingSpatialCollisions } from "../../workspace/spatial";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

const world = (x: number, y: number, z: number) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

function publishedModel(): WorkspaceStore {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "author", [{
    op: "create_component",
    op_id: "stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: world(0, 0, 0),
  }, {
    op: "create_component",
    op_id: "assembly",
    id: "ASSEMBLY",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
    props: { description: "Reusable bench", collisionPolicy: "external_only" },
    placement: world(0, 0, 0),
  }, {
    op: "create_component",
    op_id: "part",
    id: "PART",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
    props: {
      geometry: { kind: "box", sizeM: { x: 2, y: 1, z: 1 } },
    },
    placement: world(0, 0.5, 0),
    parent_id: "ASSEMBLY",
  }]));
  store.apply(workspaceBatch(store, "publish", [{
    op: "publish_model",
    op_id: "publish",
    model_id: "com.semaframe.bench",
    version: "1.0.0",
    display_name: "Bench",
    root_id: "ASSEMBLY",
  }]));
  return store;
}

describe("human model instance planning", () => {
  it("maps every node to a reserved ID and commits at an exact collision-free placement", () => {
    const store = publishedModel();
    const definition = store.getState().modelDefinitions.get("com.semaframe.bench@1.0.0")!;
    const reservedIds = store.reserveComponentIds(definition.nodes.length);
    const plan = planWorkspaceModelInstance(store.getState(), definition, reservedIds);

    expect(Object.keys(plan.idMap)).toEqual(definition.nodes.map((node) => node.nodeId));
    expect(new Set(Object.values(plan.idMap))).toEqual(new Set(reservedIds));
    expect(plan.rootPlacement.position.x).toBeGreaterThan(1);
    store.apply(workspaceBatch(store, "instantiate", [{
      op: "instantiate_model",
      op_id: "instantiate",
      model: modelDefinitionRef(definition),
      id_map: plan.idMap,
      root_placement: plan.rootPlacement,
    }]));

    expect(store.getState().components.get(plan.rootComponentId)).toMatchObject({
      placement: plan.rootPlacement,
      props: { modelRef: modelDefinitionRef(definition) },
    });
    expect(findBlockingSpatialCollisions(store.getState())).toEqual([]);
  });

  it("rejects an incomplete or duplicate reserved-ID map before any commit", () => {
    const store = publishedModel();
    const definition = store.getState().modelDefinitions.get("com.semaframe.bench@1.0.0")!;
    expect(() => planWorkspaceModelInstance(store.getState(), definition, ["ONLY_ONE"]))
      .toThrow(/requires 2 reserved component IDs/);
    expect(() => planWorkspaceModelInstance(store.getState(), definition, ["DUPLICATE", "DUPLICATE"]))
      .toThrow(/non-empty and unique/);
  });

  it("holds one app-level heavy-export lease until the worker settles", async () => {
    const gate = new WorkspaceModelExportGate();
    let finish: ((value: string) => void) | undefined;
    const worker = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = gate.run("STL export", worker);
    expect(gate.active).toBe("STL export");

    await expect(gate.run("STEP export", async () => "duplicate")).resolves.toEqual({
      started: false,
      activeLabel: "STL export",
    });
    expect(worker).toHaveBeenCalledTimes(1);
    finish?.("complete");
    await expect(first).resolves.toEqual({ started: true, value: "complete" });
    expect(gate.active).toBeUndefined();
    await expect(gate.run("STEP export", async () => "next")).resolves.toEqual({
      started: true,
      value: "next",
    });
  });

  it("releases an instance reference after safe cascade deletion so its definition can be removed", () => {
    const store = publishedModel();
    const definition = store.getState().modelDefinitions.get("com.semaframe.bench@1.0.0")!;
    const plan = planWorkspaceModelInstance(store.getState(), definition, store.reserveComponentIds(definition.nodes.length));
    store.apply(workspaceBatch(store, "instantiate-for-delete", [{
      op: "instantiate_model",
      op_id: "instantiate-for-delete",
      model: modelDefinitionRef(definition),
      id_map: plan.idMap,
      root_placement: plan.rootPlacement,
    }]));
    store.apply(workspaceBatch(store, "delete-instance", [{
      op: "delete_component",
      op_id: "delete-instance",
      id: plan.rootComponentId,
      policy: "cascade",
      confirm: true,
    }]));
    expect(store.getState().components.has(plan.rootComponentId)).toBe(false);
    store.apply(workspaceBatch(store, "delete-definition", [{
      op: "delete_model_definition",
      op_id: "delete-definition",
      model: modelDefinitionRef(definition),
      confirm: true,
    }]));
    expect(store.getState().modelDefinitions.has("com.semaframe.bench@1.0.0")).toBe(false);
  });
});
