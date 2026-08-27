import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  findLayoutOverlaps,
  planAutoArrangeLayout,
  queryLayoutPlacement,
} from "../../workspace/layout";
import {
  LayoutOverlapStoreError,
  SpatialCollisionStoreError,
  WorkspaceStore,
  type WorkspaceState,
} from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const canvasPanel = (id: string, x = 0, y = 0) => ({
  op: "create_component" as const,
  op_id: `create_${id}`,
  id,
  component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
  placement: {
    space: "canvas2d" as const,
    position: { x, y },
    size: { width: 320, height: 220 },
  },
});

const world = (x = 0) => ({
  space: "world3d" as const,
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

function legacyOverlappingState(): WorkspaceState {
  const seed = new WorkspaceStore();
  seed.apply(workspaceBatch(seed, "seed", [canvasPanel("PANEL_A", 0, 0)]));
  const state = structuredClone(seed.getState()) as WorkspaceState;
  const first = state.components.get("PANEL_A")!;
  state.components.set("PANEL_B", {
    ...structuredClone(first),
    id: "PANEL_B",
    label: "Legacy B",
    placement: {
      space: "canvas2d",
      position: { x: 250, y: 0 },
      size: { width: 320, height: 220 },
    },
  });
  return state;
}

describe("independent 2D layout and 3D collision domains", () => {
  it("rejects a new 2D/2D overlap atomically, including canvas-to-viewport", () => {
    const store = new WorkspaceStore();
    expect(() => store.apply(workspaceBatch(store, "overlap", [
      canvasPanel("PANEL_A"),
      {
        op: "create_component",
        op_id: "create_viewport",
        id: "PANEL_B",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
        placement: {
          space: "viewport",
          anchor: "center",
          offset: { x: 0, y: 0 },
          size: { width: 320, height: 220 },
        },
      },
    ]))).toThrow(LayoutOverlapStoreError);
    expect(store.getRevision()).toBe(0);
    expect(store.getState().components.size).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
  });

  it("allows a projected 2D card and a physical 3D object at the same world position", () => {
    const store = new WorkspaceStore();
    expect(() => store.apply(workspaceBatch(store, "mixed_domains", [{
      op: "create_component",
      op_id: "stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: world(),
    }, {
      op: "create_component",
      op_id: "solid",
      id: "SOLID",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: world(),
      props: { assetId: "primitive_box", entityKind: "primitive" },
    }, {
      op: "create_component",
      op_id: "card",
      id: "CARD",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("image"),
      placement: { ...world(), size: { width: 320, height: 220 } },
    }]))).not.toThrow();

    const graph = findLayoutOverlaps(store.getState());
    expect(graph).toEqual([]);
    expect(store.getRevision()).toBe(1);
  });

  it("keeps the existing 3D/3D solid collision gate independent", () => {
    const store = new WorkspaceStore();
    expect(() => store.apply(workspaceBatch(store, "solid_overlap", [{
      op: "create_component", op_id: "stage", id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world(),
    }, {
      op: "create_component", op_id: "left", id: "LEFT",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"), placement: world(),
      props: { assetId: "primitive_box", entityKind: "primitive" },
    }, {
      op: "create_component", op_id: "right", id: "RIGHT",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"), placement: world(0.1),
      props: { assetId: "primitive_box", entityKind: "primitive" },
    }]))).toThrow(SpatialCollisionStoreError);
    expect(store.getRevision()).toBe(0);
  });

  it("opens legacy overlaps, allows unrelated edits and repair, but blocks worsening", () => {
    const store = new WorkspaceStore({ initialState: legacyOverlappingState() });
    expect(findLayoutOverlaps(store.getState())).toHaveLength(1);

    expect(() => store.apply(workspaceBatch(store, "rename", [{
      op: "update_component",
      op_id: "rename",
      id: "PANEL_A",
      patch: { label: "Still editable" },
    }]))).not.toThrow();

    const revisionBeforeFailure = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "worsen", [{
      op: "place_component",
      op_id: "move_closer",
      id: "PANEL_B",
      placement: {
        space: "canvas2d",
        position: { x: 200, y: 0 },
        size: { width: 320, height: 220 },
      },
    }]))).toThrow(LayoutOverlapStoreError);
    expect(store.getRevision()).toBe(revisionBeforeFailure);

    store.apply(workspaceBatch(store, "repair", [{
      op: "place_component",
      op_id: "move_clear",
      id: "PANEL_B",
      placement: {
        space: "canvas2d",
        position: { x: 400, y: 0 },
        size: { width: 320, height: 220 },
      },
    }]));
    expect(findLayoutOverlaps(store.getState())).toEqual([]);
    store.undo();
    expect(findLayoutOverlaps(store.getState())).toHaveLength(1);
    store.redo();
    expect(findLayoutOverlaps(store.getState())).toEqual([]);
  });

  it("preflights and deterministically auto-arranges movable legacy panels", () => {
    const state = legacyOverlappingState();
    const first = queryLayoutPlacement(state, {
      componentId: "PANEL_B",
      placement: {
        space: "canvas2d",
        position: { x: 250, y: 0 },
        size: { width: 320, height: 220 },
      },
    });
    expect(first.valid).toBe(false);
    expect(first.suggestedPlacements.length).toBeGreaterThan(0);

    const firstPlan = planAutoArrangeLayout(state);
    const secondPlan = planAutoArrangeLayout(state);
    expect([...firstPlan]).toEqual([...secondPlan]);
    expect(firstPlan.size).toBeGreaterThan(0);

    const store = new WorkspaceStore({ initialState: state });
    store.apply(workspaceBatch(store, "auto_arrange", [...firstPlan].map(([id, placement], index) => ({
      op: "place_component" as const,
      op_id: `arrange_${index}`,
      id,
      placement,
    }))));
    expect(findLayoutOverlaps(store.getState())).toEqual([]);
    expect(store.getRevision()).toBe(state.revision + 1);
  });
});
