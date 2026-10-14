import { describe, expect, it } from "vitest";
import { ProjectionBridge } from "../../workspace/renderer/ProjectionBridge";
import type { ComponentInstance, ComponentPlacement, ComponentTypeRef } from "../../workspace/components/componentTypes";
import { createInitialWorkspace } from "../../workspace/state/createInitialWorkspace";
import { queryLayoutPlacement } from "../../workspace/layout/layoutGraph";
import {
  buildRuntimeViewGraph, checkRuntimeLayoutPlacement, findWorsenedRuntimeIssues,
  MAX_RUNTIME_VIEW_GRAPH_BYTES,
  type RuntimeViewContext, type RuntimeLayoutCandidate,
} from "../../workspace/layout/runtimeView";

const now = 1_700_000_000_000;
const options = { now };
const panelType: ComponentTypeRef = { typeId: "panel", version: "1.1.0", digest: "test-panel" };
const viewportPlacement = (x = 0, y = 0, width = 100, height = 80): ComponentPlacement & { space: "viewport"; size: { width: number; height: number } } => ({
  space: "viewport", anchor: "top_left", offset: { x, y }, size: { width, height },
});
const canvasPlacement = (x = 0, y = 0, rotationDeg = 0): ComponentPlacement & { space: "canvas2d"; size: { width: number; height: number } } => ({
  space: "canvas2d", position: { x, y }, size: { width: 100, height: 80 }, rotationDeg,
});
const worldPlacement = (x = 0, y = 0, z = 0): ComponentPlacement => ({
  space: "world3d", position: { x, y, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
});
function component(id: string, placement: ComponentPlacement, type = panelType): ComponentInstance {
  return { id, type, label: id, props: {}, durableState: {}, placement, bindings: [], tags: [], visibility: "visible",
    locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
    provenance: { createdRevision: 0, createdBy: "agent" } };
}
function state(...components: ComponentInstance[]) {
  const workspace = createInitialWorkspace("runtime-test");
  components.forEach((item) => workspace.components.set(item.id, item));
  return workspace;
}
function context(overrides: Partial<RuntimeViewContext> = {}): RuntimeViewContext {
  return { viewId: "renderer-A", epoch: 3, workspaceId: "runtime-test", workspaceRevision: 0, sampledAt: now,
    status: "ready", viewport: { width: 500, height: 300 },
    camera: { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 45, near: 0.04, far: 300 },
    canvasView: { pan: { x: 0, y: 0 }, zoom: 1 }, occluders: [], ...overrides };
}
const full = { ...options, detail: "full" as const };

describe("ephemeral runtime view graph", () => {
  it("uses the production renderer projection for actual viewport, pan and zoom without persisting them", () => {
    const item = component("panel", canvasPlacement(40, -15));
    const workspace = state(item);
    const view = context({ canvasView: { pan: { x: 33, y: 18 }, zoom: 1.5 } });
    const baseline = structuredClone(workspace);
    const bridge = new ProjectionBridge({ camera: view.camera, canvasView: view.canvasView });
    bridge.setViewport(view.viewport);
    bridge.setComponents([item]);
    const projected = bridge.project(item);
    const graph = buildRuntimeViewGraph(workspace, view, full);
    expect(graph.nodes?.[0]?.bounds).toEqual({ left: projected.left, top: projected.top, width: projected.width, height: projected.height });
    expect(graph).toMatchObject({ status: "ready", view_id: "renderer-A", view_epoch: 3, coordinate_system: { units: "css_px" } });
    expect(workspace).toEqual(baseline);
    const moved = buildRuntimeViewGraph(workspace, { ...view, epoch: 4 }, options);
    expect(moved.workspace_revision).toBe(0);
    expect(moved).not.toHaveProperty("nodes");
  });

  it("detects actual cross-placement UI overlap even when canonical layout is clear", () => {
    const workspace = state(component("canvas", canvasPlacement()));
    const candidate = { componentType: panelType, placement: viewportPlacement(180, 90) };
    expect(queryLayoutPlacement(workspace, candidate).valid).toBe(true);
    expect(checkRuntimeLayoutPlacement(workspace, candidate, context(), options)).toMatchObject({
      status: "ready", canonical_valid: true, current_view_valid: false, valid: false,
      issues: [expect.objectContaining({ kind: "layout_overlap" })],
    });
  });

  it("keeps 3D nodes out of UI overlap and host occlusion checks", () => {
    const workspace = state(component("machine", worldPlacement(), { typeId: "spatial-primitive", version: "1.0.0", digest: "3d" }));
    const view = context();
    const candidate = { componentType: panelType, placement: viewportPlacement(180, 90) };
    expect(buildRuntimeViewGraph(workspace, view, full).nodes).toEqual([]);
    expect(checkRuntimeLayoutPlacement(workspace, candidate, view, options)).toMatchObject({ valid: true, issues: [] });
    expect(() => checkRuntimeLayoutPlacement(workspace, { componentId: "machine", placement: viewportPlacement() }, view, options)).toThrow(/3D spatial domain/u);
  });

  it("measures rotated polygons, not their over-conservative bounding boxes", () => {
    const placement = { ...canvasPlacement(0, 0, 45), size: { width: 100, height: 20 } };
    const workspace = state(component("rotated", placement));
    const clear = context({ occluders: [{ id: "toolbar", kind: "toolbar", bounds: { left: 208, top: 108, width: 3, height: 3 } }] });
    expect(buildRuntimeViewGraph(workspace, clear, full).issues).toEqual([]);
    const blocked = { ...clear, occluders: [{ id: "toolbar", kind: "toolbar", bounds: { left: 245, top: 145, width: 10, height: 10 } }] };
    expect(buildRuntimeViewGraph(workspace, blocked, full).issues).toEqual([expect.objectContaining({ kind: "host_occlusion", component_id: "rotated" })]);
  });

  it("uses exact video type sizing, and refuses to guess a new candidate's type", () => {
    const workspace = state();
    const candidate = { placement: viewportPlacement(0, 0, 560, 360) };
    const view = context({ viewport: { width: 400, height: 350 } });
    expect(checkRuntimeLayoutPlacement(workspace, candidate, view, options)).toMatchObject({ valid: null, current_view_valid: null, reason: "candidate_component_type_required" });
    const video = { ...candidate, componentType: { typeId: "video-player", version: "1.1.0", digest: "video" } };
    expect(checkRuntimeLayoutPlacement(workspace, video, view, options).valid).toBe(true);
    const graph = buildRuntimeViewGraph(state(component("video", video.placement, video.componentType)), view, full);
    expect(graph.nodes?.[0]?.bounds.width).toBe(376);
    expect(checkRuntimeLayoutPlacement(workspace, { ...candidate, componentType: panelType }, view, options).valid).toBe(false);
  });

  it("allows authored offscreen canvas content but rejects clipped viewport HUD", () => {
    const workspace = state();
    const canvas = checkRuntimeLayoutPlacement(workspace, { componentType: panelType, placement: canvasPlacement(10_000, 0) }, context(), options);
    expect(canvas).toMatchObject({ valid: true, issues: [expect.objectContaining({ kind: "viewport_clipping", blocking: false })] });
    const hud = checkRuntimeLayoutPlacement(workspace, { componentType: panelType, placement: viewportPlacement(470, 0) }, context(), options);
    expect(hud).toMatchObject({ valid: false, issues: [expect.objectContaining({ kind: "viewport_clipping", blocking: true })] });
  });

  it("does not treat offscreen polygons as visible collisions", () => {
    const workspace = state(component("outside", canvasPlacement(10_000, 0)));
    const checked = checkRuntimeLayoutPlacement(workspace, { componentType: panelType, placement: canvasPlacement(10_010, 0) }, context(), options);
    expect(checked.current_view_valid).toBe(true);
    expect(checked.canonical_valid).toBe(false);
    expect(checked.issues.every((issue) => issue.kind !== "layout_overlap")).toBe(true);
  });

  it.each([
    [null, "unavailable", "no_active_renderer"],
    [context({ status: "settling", reason: "drag_preview" }), "settling", "drag_preview"],
    [context({ workspaceRevision: 1 }), "stale", "renderer_workspace_revision_mismatch"],
    [context({ sampledAt: now - 2_001 }), "stale", "view_sample_expired"],
    [context({ viewport: { width: 0, height: 300 } }), "unavailable", "invalid_view_geometry"],
  ] as const)("never claims visual validation when the renderer is %s", (view, status, reason) => {
    const workspace = state();
    expect(buildRuntimeViewGraph(workspace, view, options)).toMatchObject({ status, reason, current_view_valid: null });
    expect(checkRuntimeLayoutPlacement(workspace, { componentType: panelType, placement: viewportPlacement() }, view, options)).toMatchObject({ status, reason, valid: null, current_view_valid: null });
  });

  it("excludes hidden, collapsed and fully transparent UI from visible conflicts", () => {
    const hidden = component("hidden", viewportPlacement());
    hidden.visibility = "hidden";
    const collapsed = component("collapsed", viewportPlacement());
    collapsed.visibility = "collapsed";
    const workspace = state(hidden, collapsed);
    expect(buildRuntimeViewGraph(workspace, context(), full).issues).toEqual([]);
    expect(checkRuntimeLayoutPlacement(workspace, { componentType: panelType, placement: viewportPlacement() }, context(), options).current_view_valid).toBe(true);
  });

  it("caps full graph bytes while declaring omitted detail and retaining complete validation", () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => component(`canvas-${index}`, canvasPlacement(10_000 + index * 200, 0)));
    const graph = buildRuntimeViewGraph(state(...nodes), context(), full);
    expect(new TextEncoder().encode(JSON.stringify(graph)).byteLength).toBeLessThanOrEqual(MAX_RUNTIME_VIEW_GRAPH_BYTES);
    expect(graph.node_count).toBe(1_000);
    expect(graph.nodes_truncated).toBe(true);
    expect(graph.omitted_node_count).toBe(1_000 - graph.nodes!.length);
    expect(graph.current_view_valid).toBe(true);
    expect(graph.issue_count).toBe(1_000);
  });
});

describe("runtime draft gate", () => {
  it("checks all new nodes together and catches same-batch overlap", () => {
    const before = state();
    const after = state(component("canvas", canvasPlacement()), component("hud", viewportPlacement(180, 90)));
    const checked = findWorsenedRuntimeIssues(before, after, context(), options);
    expect(checked).toMatchObject({ valid: false, canonical_valid: true, checked_component_ids: ["canvas", "hud"] });
    expect(checked.issues).toEqual([expect.objectContaining({ kind: "layout_overlap" })]);
  });

  it("preserves old conflicts and allows a repair without blocking a 3D-only update", () => {
    const first = component("first", viewportPlacement());
    const second = component("second", viewportPlacement(50, 0));
    const before = state(first, second);
    const unrelated = structuredClone(before);
    unrelated.components.set("machine", component("machine", worldPlacement(), { typeId: "spatial-primitive", version: "1.0.0", digest: "3d" }));
    expect(findWorsenedRuntimeIssues(before, unrelated, context(), options)).toMatchObject({ valid: true, checked_component_ids: [], issues: [] });
    expect(findWorsenedRuntimeIssues(before, unrelated, null, options).checked_component_ids).toEqual([]);
    const repaired = structuredClone(before);
    repaired.components.set("second", { ...second, placement: viewportPlacement(75, 0) });
    expect(findWorsenedRuntimeIssues(before, repaired, context(), options)).toMatchObject({ valid: true, checked_component_ids: ["second"], issues: [] });
  });

  it("compares before and after against the same current host geometry", () => {
    const before = state(component("panel", viewportPlacement()));
    const after = structuredClone(before);
    after.components.get("panel")!.label = "renamed";
    const view = context({ occluders: [{ id: "toolbar", kind: "toolbar", bounds: { left: 20, top: 20, width: 100, height: 80 } }] });
    expect(buildRuntimeViewGraph(before, view, full).current_view_valid).toBe(false);
    expect(findWorsenedRuntimeIssues(before, after, view, options)).toMatchObject({ valid: true, issues: [], checked_component_ids: [] });
  });

  it("includes attached UI affected by moving a 3D target even without renderer availability", () => {
    const target = component("target", worldPlacement(-4, 0, 0), { typeId: "spatial-primitive", version: "1.0.0", digest: "3d" });
    const label = component("label", { space: "billboard", targetId: "target", offset: { x: 0, y: 0, z: 0 }, size: { width: 100, height: 80 } });
    const before = state(target, label, component("hud", viewportPlacement(180, 90)));
    const after = structuredClone(before);
    after.components.get("target")!.placement = worldPlacement();
    expect(findWorsenedRuntimeIssues(before, after, null, options)).toMatchObject({ valid: null, checked_component_ids: ["label"] });
    expect(findWorsenedRuntimeIssues(before, after, context(), options)).toMatchObject({ valid: false, checked_component_ids: ["label"], issues: [expect.objectContaining({ kind: "layout_overlap" })] });
  });

  it("treats newly clipped viewport HUD as blocking even when its old canvas pixels were identical", () => {
    const before = state(component("panel", canvasPlacement(10_000, 0)));
    const after = structuredClone(before);
    after.components.get("panel")!.placement = viewportPlacement(10_180, 90);
    const checked = findWorsenedRuntimeIssues(before, after, context(), options);
    expect(checked).toMatchObject({ valid: false, checked_component_ids: ["panel"], issues: [expect.objectContaining({ kind: "viewport_clipping", blocking: true })] });
  });

  it("bounds diagnostic memory without allowing later blocking issues to be hidden by warnings", () => {
    const nodes = Array.from({ length: 105 }, (_, index) => component(`canvas-${index}`, canvasPlacement(10_000 + index * 200, 0)));
    nodes.push(component("z-hud", viewportPlacement()));
    const after = state(...nodes);
    const view = context({ occluders: [{ id: "toolbar", kind: "toolbar", bounds: { left: 20, top: 20, width: 100, height: 80 } }] });
    const graph = buildRuntimeViewGraph(after, view, options);
    expect(graph).toMatchObject({ current_view_valid: false, issues_truncated: true, issue_count: 106, blocking_issue_count: 1 });
    expect(graph.issues[0]).toMatchObject({ kind: "host_occlusion", blocking: true });
    const checked = findWorsenedRuntimeIssues(state(), after, view, options);
    expect(checked).toMatchObject({ valid: false, current_view_valid: false, issues_truncated: true, issue_count: 106 });
    expect(checked.issues).toHaveLength(100);
  });

  it("returns suggestions that pass canonical AND runtime checks with the exact type", () => {
    const workspace = state(component("canvas", canvasPlacement()));
    const view = context({ occluders: [{ id: "toolbar", kind: "toolbar", bounds: { left: 20, top: 20, width: 150, height: 60 } }] });
    const candidate: RuntimeLayoutCandidate = { componentType: panelType, placement: viewportPlacement() };
    const checked = checkRuntimeLayoutPlacement(workspace, candidate, view, options);
    expect(checked.valid).toBe(false);
    expect(checked.suggested_placements.length).toBeGreaterThan(0);
    for (const placement of checked.suggested_placements) {
      expect(queryLayoutPlacement(workspace, { placement }).valid).toBe(true);
      expect(checkRuntimeLayoutPlacement(workspace, { ...candidate, placement }, view, options)).toMatchObject({ valid: true, canonical_valid: true, current_view_valid: true });
    }
  });
});
