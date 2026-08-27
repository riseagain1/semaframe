import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENT_REGISTRY,
  type ComponentInstance,
  type ComponentPlacement,
} from "../../workspace/components";
import {
  CANONICAL_LAYOUT_FRAME,
  buildSemaFrameLayoutGraph,
  componentFallbackSize,
  componentLayoutSize,
  findAvailableLayoutPlacement,
  findLayoutOverlaps,
  findWorsenedLayoutOverlaps,
  planAutoArrangeLayout,
  queryLayoutPlacement,
  type CanonicalLayoutPlacement,
  viewportAnchorTopLeft,
} from "../../workspace/layout";
import { createInitialWorkspace, type WorkspaceState } from "../../workspace/state";

function canvas(
  x: number,
  y: number,
  width = 100,
  height = 100,
  rotationDeg = 0,
  zIndex = 0,
): CanonicalLayoutPlacement {
  return {
    space: "canvas2d",
    position: { x, y },
    size: { width, height },
    rotationDeg,
    zIndex,
  };
}

function viewport(
  anchor: "top_left" | "center",
  x: number,
  y: number,
  width = 100,
  height = 100,
  zIndex = 0,
): CanonicalLayoutPlacement {
  return {
    space: "viewport",
    anchor,
    offset: { x, y },
    size: { width, height },
    zIndex,
  };
}

function component(
  id: string,
  placement: ComponentPlacement,
  options: Readonly<{
    typeId?: "panel" | "image" | "spatial-entity";
    visibility?: ComponentInstance["visibility"];
    locked?: boolean;
  }> = {},
): ComponentInstance {
  const typeId = options.typeId ?? "panel";
  return {
    id,
    type: DEFAULT_COMPONENT_REGISTRY.ref(typeId),
    label: id,
    props: {},
    durableState: {},
    placement,
    bindings: [],
    tags: [],
    visibility: options.visibility ?? "visible",
    locks: {
      placement: options.locked ?? false,
      resize: false,
      props: false,
      deletion: false,
      actions: false,
    },
    provenance: { createdRevision: 0, createdBy: "agent" },
  };
}

function stateWith(...components: ComponentInstance[]): WorkspaceState {
  const state = createInitialWorkspace("layout_test");
  for (const entry of components) state.components.set(entry.id, entry);
  return state;
}

function withPlacement(
  state: Readonly<WorkspaceState>,
  componentId: string,
  placement: ComponentPlacement,
): WorkspaceState {
  const next = structuredClone(state);
  const existing = next.components.get(componentId)!;
  next.components.set(componentId, { ...existing, placement: structuredClone(placement) });
  return next;
}

describe("SemaFrame Layout Graph 1.0", () => {
  it("uses one canonical 1440x900 top-left logical-pixel frame and shared pure size helpers", () => {
    expect(CANONICAL_LAYOUT_FRAME).toMatchObject({
      width: 1_440,
      height: 900,
      safeInset: 20,
      origin: "top_left",
      units: "logical_px",
    });
    expect(buildSemaFrameLayoutGraph(stateWith()).coordinateSystem).toEqual({
      width: 1_440,
      height: 900,
      safeInset: 20,
      origin: "top_left",
      units: "logical_px",
    });
    expect(viewportAnchorTopLeft("center", { width: 200, height: 100 }))
      .toEqual({ x: 620, y: 400 });
    expect(viewportAnchorTopLeft("top_left", { width: 200, height: 100 }))
      .toEqual({ x: 20, y: 20 });
    expect(componentFallbackSize("chart")).toEqual({ width: 360, height: 240 });

    const custom = component("CUSTOM", { space: "canvas2d", position: { x: 0, y: 0 } });
    custom.type = { typeId: "custom-card", version: "1", digest: "custom" };
    expect(componentLayoutSize(custom, { width: 333, height: 222 }))
      .toEqual({ width: 333, height: 222 });
    custom.placement = canvas(0, 0, 444, 111);
    expect(componentLayoutSize(custom, { width: 333, height: 222 }))
      .toEqual({ width: 444, height: 111 });
  });

  it("detects exact canvas/canvas overlap while treating edge contact as non-conflicting", () => {
    const overlapping = stateWith(
      component("A", canvas(0, 0)),
      component("B", canvas(50, 0)),
    );
    expect(findLayoutOverlaps(overlapping)).toHaveLength(1);
    expect(findLayoutOverlaps(overlapping)[0]?.overlap.area).toBeCloseTo(5_000, 6);

    const touching = stateWith(
      component("A", canvas(0, 0)),
      component("B", canvas(100, 0)),
    );
    expect(findLayoutOverlaps(touching)).toEqual([]);
  });

  it("compares viewport/viewport and canvas/viewport in overlay2d:canonical", () => {
    const viewportState = stateWith(
      component("A", viewport("top_left", 0, 0)),
      component("B", viewport("top_left", 50, 0)),
    );
    expect(findLayoutOverlaps(viewportState)[0]).toMatchObject({
      componentId: "A",
      conflictsWith: "B",
      collisionDomain: "overlay2d:canonical",
      overlap: { area: 5_000 },
    });

    const mixed = stateWith(
      component("CANVAS", canvas(0, 0)),
      component("VIEWPORT", viewport("center", 0, 0)),
    );
    expect(findLayoutOverlaps(mixed)[0]).toMatchObject({
      componentId: "CANVAS",
      conflictsWith: "VIEWPORT",
      overlap: { area: 10_000 },
    });
  });

  it("clips rotated convex polygons instead of reporting their AABB as overlap", () => {
    const state = stateWith(
      component("AXIS", canvas(0, 0)),
      component("ROTATED", canvas(0, 0, 100, 100, 45)),
    );
    const overlap = findLayoutOverlaps(state)[0]!;
    expect(overlap.overlap.area).toBeCloseTo(8_284.271247, 4);
    expect(overlap.overlap.area).toBeLessThan(overlap.overlap.bounds.size.width
      * overlap.overlap.bounds.size.height);
    expect(overlap.overlap.polygon.length).toBe(8);
  });

  it("omits hidden 2D components and isolates all authoritative 3D component kinds", () => {
    const state = stateWith(
      component("VISIBLE", canvas(0, 0)),
      component("HIDDEN", canvas(0, 0), { visibility: "hidden" }),
      component("SPATIAL", {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      }, { typeId: "spatial-entity" }),
    );
    const graph = buildSemaFrameLayoutGraph(state);
    expect(graph.nodes.map((node) => node.id)).toEqual(["HIDDEN", "VISIBLE"]);
    expect(graph.overlapConflicts).toEqual([]);
    expect(findLayoutOverlaps(state)).toEqual([]);
  });

  it("keeps surface, billboard and non-spatial world placements projection-dependent and incomparable", () => {
    const state = stateWith(
      component("CANONICAL", canvas(0, 0)),
      component("SURFACE", {
        space: "surface",
        targetId: "SPATIAL",
        surface: "screen",
        offset: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
      }, { typeId: "image" }),
      component("BILLBOARD", {
        space: "billboard",
        targetId: "SPATIAL",
        offset: { x: 0, y: 0, z: 0 },
        size: { width: 100, height: 100 },
      }, { typeId: "image" }),
      component("WORLD_UI", {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        size: { width: 100, height: 100 },
      }, { typeId: "image" }),
    );
    const graph = buildSemaFrameLayoutGraph(state);
    expect(graph.nodes.filter((node) => node.resolution === "projection_dependent"))
      .toHaveLength(3);
    expect(graph.nodes.find((node) => node.id === "SURFACE")).toMatchObject({
      dimensionDomain: "ui2d",
      resolution: "projection_dependent",
      projectionDependency: "target_surface_and_viewport",
    });
    expect(graph.nodes.find((node) => node.id === "BILLBOARD")).toMatchObject({
      projectionDependency: "camera_and_viewport",
    });
    expect(graph.overlapConflicts).toEqual([]);
  });

  it("returns deterministic collision-free placement suggestions and ignores the edited component itself", () => {
    const state = stateWith(component("A", canvas(0, 0)));
    const candidate = { placement: canvas(0, 0) } as const;
    const first = queryLayoutPlacement(state, candidate);
    const second = queryLayoutPlacement(state, candidate);
    expect(first.valid).toBe(false);
    expect(first.conflicts).toHaveLength(1);
    expect(first.suggestedPlacements).toEqual(second.suggestedPlacements);
    expect(first.suggestedPlacements.length).toBeGreaterThan(0);
    expect(findAvailableLayoutPlacement(state, candidate)).toEqual(first.suggestedPlacements[0]);
    for (const placement of first.suggestedPlacements) {
      expect(queryLayoutPlacement(state, { placement }).valid).toBe(true);
    }
    expect(queryLayoutPlacement(state, { componentId: "A", placement: canvas(0, 0) }).valid)
      .toBe(true);
  });

  it("reports only new or increased overlap for legacy-compatible transaction gating", () => {
    const before = stateWith(
      component("A", canvas(0, 0)),
      component("B", canvas(50, 0)),
    );
    const worsened = withPlacement(before, "B", canvas(40, 0));
    const improved = withPlacement(before, "B", canvas(60, 0));
    expect(findWorsenedLayoutOverlaps(before, worsened)).toHaveLength(1);
    expect(findWorsenedLayoutOverlaps(before, improved)).toEqual([]);
  });

  it("cannot hide a new conflict behind more than ten thousand unrelated legacy pairs", () => {
    const legacy = Array.from({ length: 142 }, (_, index) =>
      component(`LEGACY_${String(index).padStart(3, "0")}`, canvas(0, 0)));
    const before = stateWith(...legacy);
    const after = structuredClone(before);
    after.components.set("Z_NEW", component("Z_NEW", canvas(0, 0)));
    const worsened = findWorsenedLayoutOverlaps(before, after);
    expect(worsened).toHaveLength(142);
    expect(worsened.every((conflict) => conflict.componentId === "Z_NEW"
      || conflict.conflictsWith === "Z_NEW")).toBe(true);
  });

  it("caps graph nodes and conflicts, marks truncation, and preserves delta conflicts despite unrelated legacy overlap", () => {
    const state = stateWith(
      component("A", canvas(0, 0)),
      component("B", canvas(0, 0)),
      component("C", canvas(0, 0)),
      component("Z", canvas(0, 0)),
    );
    const capped = buildSemaFrameLayoutGraph(state, { maxNodes: 3, maxConflicts: 2 });
    expect(capped.nodes).toHaveLength(3);
    expect(capped.omittedNodeCount).toBe(1);
    expect(capped.overlapConflicts).toHaveLength(2);
    expect(capped.overlapConflictsTruncated).toBe(true);

    const delta = buildSemaFrameLayoutGraph(state, {
      mode: "delta",
      sinceRevision: 2,
      changedNodeIds: new Set(["Z"]),
      maxConflicts: 1,
    });
    expect(delta.nodes.map((node) => node.id)).toEqual(["Z"]);
    expect(delta.overlapConflicts).toHaveLength(1);
    expect(delta.overlapConflicts[0]?.componentId === "Z"
      || delta.overlapConflicts[0]?.conflictsWith === "Z").toBe(true);
    expect(delta.overlapConflictsTruncated).toBe(true);
  });

  it("auto-arranges only conflicting unlocked canonical placements and tolerates locked legacy conflicts", () => {
    const state = stateWith(
      component("LOCK_A", canvas(0, 0), { locked: true }),
      component("LOCK_B", canvas(0, 0), { locked: true }),
      component("MOVE", canvas(0, 0, 100, 100, 0, 5)),
      component("FREE", canvas(500, 300, 100, 100, 0, 6)),
    );
    const plan = planAutoArrangeLayout(state);
    expect([...plan.keys()]).toEqual(["MOVE"]);
    const arranged = withPlacement(state, "MOVE", plan.get("MOVE")!);
    const remaining = findLayoutOverlaps(arranged);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ componentId: "LOCK_A", conflictsWith: "LOCK_B" });
    expect(planAutoArrangeLayout(state)).toEqual(plan);
  });
});
