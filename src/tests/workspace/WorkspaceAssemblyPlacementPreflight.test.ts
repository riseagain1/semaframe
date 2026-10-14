import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { buildSemaFrameSpatialGraph, querySpatialPlacement } from "../../workspace/spatial";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const placement = (x = 0, y = 0, z = 0, rotationY = 0, uniformScale = 1) => ({
  space: "world3d" as const,
  position: { x, y, z }, rotation: { x: 0, y: rotationY, z: 0 },
  scale: { x: uniformScale, y: uniformScale, z: uniformScale },
});
const stage = () => ({
  op: "create_component" as const, op_id: "stage", id: "STAGE",
  component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: placement(),
});
const assembly = (id: string, at = placement(), parentId?: string, collisionPolicy = "all") => ({
  op: "create_component" as const, op_id: `create_${id}`, id,
  component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"), placement: at,
  props: { collisionPolicy }, ...(parentId ? { parent_id: parentId } : {}),
});
const part = (id: string, at = placement(), parentId?: string) => ({
  op: "create_component" as const, op_id: `create_${id}`, id,
  component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"), placement: at,
  props: { geometry: { kind: "box", sizeM: { x: 0.5, y: 0.5, z: 0.5 } } },
  ...(parentId ? { parent_id: parentId } : {}),
});

describe("Existing assembly collision preflight", () => {
  it("checks real descendant colliders, not a solid aggregate envelope, without leaving old-position ghosts", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "scene", [
      stage(), assembly("CHAIR"), part("LEFT", placement(-2), "CHAIR"),
      part("RIGHT", placement(2), "CHAIR"), part("OBSTACLE"),
    ]));
    const before = store.getState();
    const history = structuredClone(store.getCommandHistory());
    expect(querySpatialPlacement(before, { componentId: "CHAIR", placement: placement() }))
      .toMatchObject({ valid: true, coordinateFrame: "world", checkedComponentIds: ["CHAIR", "LEFT", "RIGHT"] });
    const collision = querySpatialPlacement(before, { componentId: "CHAIR", placement: placement(2) });
    expect(collision).toMatchObject({ valid: false, conflicts: [{ componentId: "LEFT", conflictsWith: "OBSTACLE" }] });
    expect(collision.suggestedPlacements.length).toBeGreaterThan(0);
    for (const suggestion of collision.suggestedPlacements) {
      expect(querySpatialPlacement(before, { componentId: "CHAIR", placement: suggestion }).valid).toBe(true);
    }
    expect(querySpatialPlacement(before, { componentId: "CHAIR", placement: placement(4) }).valid).toBe(true);
    expect(store.getRevision()).toBe(1);
    expect(store.getCommandHistory()).toEqual(history);
    expect(store.getState()).toEqual(before);
    expect(store.getState().components.get("CHAIR")?.placement).toEqual(placement());
  });

  it("moves nested children and converts safe suggestions back into a rotated/scaled parent's local frame", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "nested", [
      stage(), assembly("ROOT", placement(3, 0, 0, Math.PI / 2, 2)),
      assembly("NESTED", placement(1), "ROOT"), part("LEG", placement(), "NESTED"),
      part("OUTSIDE", placement(3, 0, -5)),
    ]));
    const state = store.getState();
    const result = querySpatialPlacement(state, { componentId: "NESTED", placement: placement(2.5) });
    expect(result).toMatchObject({
      valid: false, coordinateFrame: "parent_local", referenceComponentId: "ROOT",
      checkedComponentIds: ["LEG", "NESTED"],
      conflicts: [{ componentId: "LEG", conflictsWith: "OUTSIDE" }],
    });
    expect(result.worldTransform?.position.x).toBeCloseTo(3);
    expect(result.worldTransform?.position.z).toBeCloseTo(-5);
    expect(result.suggestedPlacements.length).toBeGreaterThan(0);
    for (const suggestion of result.suggestedPlacements) {
      expect(querySpatialPlacement(state, { componentId: "NESTED", placement: suggestion }).valid).toBe(true);
      expect(suggestion.space).toBe("world3d");
    }
    expect(buildSemaFrameSpatialGraph(state).nodes.find((node) => node.id === "LEG")?.worldTransform.position.z)
      .toBeCloseTo(-2);
  });

  it("retains internal all-policy collisions and never allows an assembly collider override to suppress them", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "external_only", [
      stage(), assembly("MODEL", placement(), undefined, "external_only"),
      part("A", placement(), "MODEL"), part("B", placement(), "MODEL"),
    ]));
    expect(querySpatialPlacement(store.getState(), { componentId: "MODEL", placement: placement(2) }).valid).toBe(true);
    const state = store.getState();
    const components = new Map(state.components);
    const model = components.get("MODEL")!;
    components.set("MODEL", { ...model, props: { ...model.props, collisionPolicy: "all" } });
    const result = querySpatialPlacement({ ...state, components }, { componentId: "MODEL", placement: placement(2) });
    expect(result).toMatchObject({ valid: false, conflicts: [{ componentId: "A", conflictsWith: "B" }], suggestedPlacements: [] });
    expect(() => querySpatialPlacement(state, {
      componentId: "MODEL", placement: placement(2),
      collision: { enabled: false, role: "none", shape: "asset_bounds", margin: 0 },
    })).toThrow(/actual descendant colliders and collision policies are preserved/);
    expect(() => querySpatialPlacement(state, {
      componentId: "MODEL", placement: placement(2), geometry: { kind: "sphere", radiusM: 0.5 },
    })).toThrow(/only component_id and placement/);
  });

  it("checks obstacles elsewhere under the same all-policy parent, and honors explicitly disabled assembly collision", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "siblings", [
      stage(), assembly("ROOT"), assembly("MOVING", placement(-2), "ROOT"),
      part("LEG", placement(), "MOVING"), part("SIBLING", placement(2), "ROOT"),
    ]));
    expect(querySpatialPlacement(store.getState(), { componentId: "MOVING", placement: placement(2) }))
      .toMatchObject({ valid: false, conflicts: [{ componentId: "LEG", conflictsWith: "SIBLING" }] });
    store.apply(workspaceBatch(store, "disable_intentionally", [{
      op: "update_component", op_id: "none", id: "ROOT", patch: { props: { collisionPolicy: "none" } },
    }]));
    expect(querySpatialPlacement(store.getState(), { componentId: "MOVING", placement: placement(2) }).valid).toBe(true);
  });

  it("fails explicitly for empty assemblies, unknown IDs, or nonspatial components", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "empty", [stage(), assembly("EMPTY")]));
    expect(() => querySpatialPlacement(store.getState(), { componentId: "EMPTY", placement: placement() }))
      .toThrow(/no evaluable descendant colliders/);
    expect(() => querySpatialPlacement(store.getState(), { componentId: "TYPO", placement: placement() }))
      .toThrow(/does not exist.*existing component_id/);
    expect(() => querySpatialPlacement(store.getState(), { componentId: "STAGE", placement: placement() }))
      .toThrow(/not a spatial placement candidate/);
  });
});
