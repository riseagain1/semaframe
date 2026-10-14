import type { ComponentInstance, ComponentTypeRef, Vec2 } from "../components/componentTypes";
import type { WorkspaceState } from "../state/workspaceState";
import { ProjectionBridge } from "../renderer/ProjectionBridge";
import { isSpatialComponent, toRenderSnapshot, type CameraProjectionState, type CanvasViewTransform } from "../renderer/contracts";
import { canonicalLayoutPolygon, findWorsenedLayoutOverlaps, layoutBoundsForPolygon, queryLayoutPlacement } from "./layoutGraph";
import { CANONICAL_LAYOUT_FRAME, type CanonicalLayoutPlacement, type LayoutPlacementCandidate, type LayoutPolygon2D } from "./layoutTypes";

export type RuntimeViewRect = Readonly<{ left: number; top: number; width: number; height: number }>;
/** Host-owned, session-ephemeral input. Never serialize into a project or command. */
export type RuntimeViewContext = Readonly<{
  viewId: string;
  epoch: number;
  workspaceId: string;
  workspaceRevision: number;
  sampledAt: number;
  status: "ready" | "settling" | "unavailable";
  viewport: Readonly<{ width: number; height: number }>;
  camera: CameraProjectionState;
  canvasView: CanvasViewTransform;
  occluders: readonly Readonly<{ id: string; kind: string; bounds: RuntimeViewRect }>[];
  reason?: string;
}>;

export type RuntimeViewOptions = Readonly<{ now?: number; maximumAgeMs?: number }>;
export type RuntimeLayoutCandidate = LayoutPlacementCandidate & Readonly<{ componentType?: ComponentTypeRef }>;
export type RuntimeViewStatus = RuntimeViewContext["status"] | "stale";
export type RuntimeViewIssue = Readonly<{
  kind: "layout_overlap" | "host_occlusion" | "viewport_clipping";
  component_id: string;
  conflicts_with?: string;
  blocking: boolean;
  overlap_area: number;
  bounds: RuntimeViewRect;
}>;
export type RuntimeViewNode = Readonly<{
  component_id: string;
  type_id: string;
  placement_space: ComponentInstance["placement"]["space"];
  visible: boolean;
  bounds: RuntimeViewRect;
  polygon: LayoutPolygon2D;
  clipped_polygon: LayoutPolygon2D;
  clipped_area: number;
  z_index: number;
}>;
export type RuntimeLayoutCheck = Readonly<{
  status: RuntimeViewStatus;
  reason?: string;
  view_id: string | null;
  view_epoch: number | null;
  workspace_id: string;
  workspace_revision: number;
  valid: boolean | null;
  canonical_valid: boolean;
  current_view_valid: boolean | null;
  checked_component_ids: readonly string[];
  issues: readonly RuntimeViewIssue[];
  issue_count: number;
  issues_truncated: boolean;
  suggested_placements: readonly CanonicalLayoutPlacement[];
}>;

const EPSILON = 1e-6;
const MAX_NODES = 2_000;
const MAX_OCCLUDERS = 128;
const MAX_REPORTED_ISSUES = 100;
export const MAX_RUNTIME_VIEW_GRAPH_BYTES = 192 * 1_024;
const CANDIDATE_ID = "__RUNTIME_LAYOUT_CANDIDATE__";

function readiness(state: Readonly<WorkspaceState>, context: RuntimeViewContext | null, options: RuntimeViewOptions): { status: RuntimeViewStatus; reason?: string } {
  if (!context) return { status: "unavailable", reason: "no_active_renderer" };
  if (context.status !== "ready") return { status: context.status, reason: context.reason ?? "renderer_not_ready" };
  if (context.workspaceId !== state.workspaceId || context.workspaceRevision !== state.revision) {
    return { status: "stale", reason: "renderer_workspace_revision_mismatch" };
  }
  const numbers = [context.viewport.width, context.viewport.height, context.canvasView.pan.x, context.canvasView.pan.y,
    context.canvasView.zoom, ...Object.values(context.camera.position), ...Object.values(context.camera.target), context.camera.fovDeg,
    ...(context.camera.near === undefined ? [] : [context.camera.near]), ...(context.camera.far === undefined ? [] : [context.camera.far])];
  if (!context.viewId || context.viewId.length > 256 || !Number.isSafeInteger(context.epoch) || context.epoch < 0 || !numbers.every(Number.isFinite)
    || context.viewport.width <= 0 || context.viewport.height <= 0 || context.canvasView.zoom <= 0
    || context.camera.fovDeg <= 0 || context.camera.fovDeg >= 180
    || (context.camera.near !== undefined && context.camera.near <= 0)
    || (context.camera.far !== undefined && context.camera.far <= (context.camera.near ?? 0.04))
    || context.occluders.length > MAX_OCCLUDERS
    || new Set(context.occluders.map((item) => item.id)).size !== context.occluders.length
    || context.occluders.some((item) => !item.id || item.id.length > 128 || !item.kind || item.kind.length > 64
      || !Object.values(item.bounds).every(Number.isFinite) || item.bounds.width < 0 || item.bounds.height < 0)) {
    return { status: "unavailable", reason: "invalid_view_geometry" };
  }
  const age = (options.now ?? Date.now()) - context.sampledAt;
  if (!Number.isFinite(age) || age < -250 || age > (options.maximumAgeMs ?? 2_000)) {
    return { status: "stale", reason: "view_sample_expired" };
  }
  if ([...state.components.values()].filter((component) => !isSpatialComponent(component)).length > MAX_NODES) {
    return { status: "unavailable", reason: "runtime_view_node_limit" };
  }
  return { status: "ready" };
}

function binding(state: Readonly<WorkspaceState>, context: RuntimeViewContext | null) {
  return {
    view_id: context?.viewId ?? null,
    view_epoch: context?.epoch ?? null,
    workspace_id: state.workspaceId,
    workspace_revision: state.revision,
  };
}

function rectForPolygon(polygon: LayoutPolygon2D): RuntimeViewRect {
  const bounds = layoutBoundsForPolygon(polygon);
  return { left: bounds.min.x, top: bounds.min.y, width: bounds.size.width, height: bounds.size.height };
}

function rectangle(rect: RuntimeViewRect): Vec2[] {
  return [{ x: rect.left, y: rect.top }, { x: rect.left + rect.width, y: rect.top },
    { x: rect.left + rect.width, y: rect.top + rect.height }, { x: rect.left, y: rect.top + rect.height }];
}

function area(polygon: LayoutPolygon2D): number {
  if (polygon.length < 3) return 0;
  // Translate to the first vertex to retain precision for distant canvas nodes.
  const origin = polygon[0]!;
  let result = 0;
  for (let index = 1; index + 1 < polygon.length; index += 1) {
    const first = polygon[index]!;
    const second = polygon[index + 1]!;
    result += (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
  }
  return Math.abs(result) / 2;
}

/** Convex clipping for the already-shared projected polygons, not a second projection implementation. */
function intersection(subject: LayoutPolygon2D, clip: LayoutPolygon2D): Vec2[] {
  if (subject.length < 3 || clip.length < 3) return [];
  let output = subject.map((point) => ({ ...point }));
  for (let index = 0; index < clip.length && output.length; index += 1) {
    const start = clip[index]!;
    const end = clip[(index + 1) % clip.length]!;
    const distance = (point: Vec2) => (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    const input = output;
    output = [];
    let previous = input.at(-1)!;
    let previousDistance = distance(previous);
    for (const point of input) {
      const pointDistance = distance(point);
      if ((pointDistance >= -EPSILON) !== (previousDistance >= -EPSILON)) {
        const ratio = previousDistance / (previousDistance - pointDistance);
        output.push({ x: previous.x + ratio * (point.x - previous.x), y: previous.y + ratio * (point.y - previous.y) });
      }
      if (pointDistance >= -EPSILON) output.push({ ...point });
      previous = point;
      previousDistance = pointDistance;
    }
  }
  return output;
}

function projectedNodes(state: Readonly<WorkspaceState>, context: RuntimeViewContext): RuntimeViewNode[] {
  const snapshot = toRenderSnapshot(state);
  const bridge = new ProjectionBridge({ camera: context.camera, canvasView: context.canvasView });
  bridge.setViewport(context.viewport);
  bridge.setComponents(snapshot.components);
  const viewport = rectangle({ left: 0, top: 0, ...context.viewport });
  return snapshot.components.filter((component) => !isSpatialComponent(component)).map((component) => {
    const projected = bridge.project(component);
    // Rotation lives in the DOM shell today; use the same canonical polygon math around the projected center.
    const polygon = canonicalLayoutPolygon({
      space: "canvas2d",
      position: { x: projected.left + projected.width / 2 - context.viewport.width / 2, y: projected.top + projected.height / 2 - context.viewport.height / 2 },
      rotationDeg: component.placement.space === "canvas2d" ? component.placement.rotationDeg : 0,
    }, { width: projected.width, height: projected.height }, { ...CANONICAL_LAYOUT_FRAME, ...context.viewport });
    const visible = projected.visible && (component.visualEffects?.opacity ?? 1) > 0.001;
    const clipped = visible ? intersection(polygon, viewport) : [];
    return {
      component_id: component.id, type_id: component.type.typeId, placement_space: component.placement.space,
      visible, bounds: rectForPolygon(polygon), polygon, clipped_polygon: clipped,
      clipped_area: Math.max(0, area(polygon) - area(clipped)), z_index: projected.zIndex,
    };
  });
}

function overlaps(left: RuntimeViewRect, right: RuntimeViewRect): boolean {
  return left.left < right.left + right.width && right.left < left.left + left.width
    && left.top < right.top + right.height && right.top < left.top + left.height;
}

type IssueCollection = Readonly<{ issues: readonly RuntimeViewIssue[]; count: number; blockingCount: number }>;

function issuesForNodes(nodes: readonly RuntimeViewNode[], context: RuntimeViewContext, relevant?: ReadonlySet<string>, accept: (issue: RuntimeViewIssue) => boolean = () => true): IssueCollection {
  const issues: RuntimeViewIssue[] = [];
  let count = 0;
  let blockingCount = 0;
  const record = (issue: RuntimeViewIssue) => {
    if (!accept(issue)) return;
    count += 1;
    if (issue.blocking) blockingCount += 1;
    if (issues.length < MAX_REPORTED_ISSUES) issues.push(issue);
    // Keep at least one blocking diagnostic even when many earlier canvas clipping warnings filled the budget.
    else if (issue.blocking && !issues.some((entry) => entry.blocking)) issues[issues.length - 1] = issue;
  };
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (!node.visible) continue;
    if (!relevant || relevant.has(node.component_id)) {
      if (node.clipped_area > EPSILON) record({
        kind: "viewport_clipping", component_id: node.component_id, blocking: node.placement_space === "viewport",
        overlap_area: node.clipped_area, bounds: node.bounds,
      });
      for (const occluder of context.occluders) {
        if (!overlaps(node.bounds, occluder.bounds)) continue;
        const polygon = intersection(node.clipped_polygon, rectangle(occluder.bounds));
        const overlapArea = area(polygon);
        if (overlapArea > EPSILON) record({
          kind: "host_occlusion", component_id: node.component_id, conflicts_with: occluder.id,
          blocking: true, overlap_area: overlapArea, bounds: rectForPolygon(polygon),
        });
      }
    }
    for (let otherIndex = index + 1; otherIndex < nodes.length; otherIndex += 1) {
      const other = nodes[otherIndex]!;
      if (!other.visible || (relevant && !relevant.has(node.component_id) && !relevant.has(other.component_id)) || !overlaps(node.bounds, other.bounds)) continue;
      const polygon = intersection(node.clipped_polygon, other.clipped_polygon);
      const overlapArea = area(polygon);
      if (overlapArea > EPSILON) record({
        kind: "layout_overlap", component_id: node.component_id, conflicts_with: other.component_id,
        blocking: true, overlap_area: overlapArea, bounds: rectForPolygon(polygon),
      });
    }
  }
  issues.sort((left, right) => Number(right.blocking) - Number(left.blocking));
  return { issues, count, blockingCount };
}

export function buildRuntimeViewGraph(state: Readonly<WorkspaceState>, context: RuntimeViewContext | null, options: RuntimeViewOptions & Readonly<{ detail?: "summary" | "full" }> = {}) {
  const availability = readiness(state, context, options);
  const nodes = availability.status === "ready" ? projectedNodes(state, context!) : [];
  const collection = availability.status === "ready" ? issuesForNodes(nodes, context!) : { issues: [], count: 0, blockingCount: 0 };
  const base = {
    format: "semaframe-runtime-view-graph" as const, version: "1.0" as const, ephemeral: true as const,
    dimension_domain: "ui2d" as const, collision_domain: "overlay2d:runtime" as const,
    ...binding(state, context), ...availability, sampled_at: context?.sampledAt ?? null,
    coordinate_system: { units: "css_px", origin: "viewport_top_left" },
    viewport: context ? { ...context.viewport } : null,
    camera: context ? structuredClone(context.camera) : null,
    canvas_view: context ? structuredClone(context.canvasView) : null,
    occluders: context ? structuredClone(context.occluders) : [],
    node_count: [...state.components.values()].filter((component) => !isSpatialComponent(component)).length,
    issue_count: availability.status === "ready" ? collection.count : null,
    blocking_issue_count: availability.status === "ready" ? collection.blockingCount : null,
    current_view_valid: availability.status === "ready" ? collection.blockingCount === 0 : null,
    issues: collection.issues.slice(0, options.detail === "full" ? MAX_REPORTED_ISSUES : 10),
    issues_truncated: collection.count > (options.detail === "full" ? MAX_REPORTED_ISSUES : 10),
  };
  const fullNodes: RuntimeViewNode[] = [];
  const encoder = new TextEncoder();
  let baseBytes = encoder.encode(JSON.stringify(base)).byteLength;
  if (baseBytes > MAX_RUNTIME_VIEW_GRAPH_BYTES - 256) {
    // Even a malformed/unavailable host sample must not turn this inspection into an unbounded response.
    base.status = "unavailable";
    base.reason = "runtime_view_response_limit";
    base.view_id = null;
    base.camera = null;
    base.canvas_view = null;
    base.occluders = [];
    base.issues = [];
    base.issue_count = null;
    base.blocking_issue_count = null;
    base.current_view_valid = null;
    baseBytes = encoder.encode(JSON.stringify(base)).byteLength;
  }
  if (options.detail === "full") {
    // Bound transport representation, not validation coverage: all nodes above were checked.
    let remaining = MAX_RUNTIME_VIEW_GRAPH_BYTES - baseBytes - 256;
    for (const node of base.status === "ready" ? nodes : []) {
      const bytes = encoder.encode(JSON.stringify(node)).byteLength + 1;
      if (bytes > remaining) break;
      fullNodes.push(node);
      remaining -= bytes;
    }
  }
  return {
    ...base,
    ...(options.detail === "full" ? {
      nodes: fullNodes,
      nodes_truncated: base.status === "ready" && fullNodes.length < nodes.length,
      omitted_node_count: base.status === "ready" ? nodes.length - fullNodes.length : null,
      max_response_bytes: MAX_RUNTIME_VIEW_GRAPH_BYTES,
    } : {}),
  };
}

function result(state: Readonly<WorkspaceState>, context: RuntimeViewContext | null, availability: { status: RuntimeViewStatus; reason?: string }, canonicalValid: boolean, ids: readonly string[], collection: IssueCollection = { issues: [], count: 0, blockingCount: 0 }, suggestions: readonly CanonicalLayoutPlacement[] = []): RuntimeLayoutCheck {
  const runtimeValid = availability.status === "ready" ? collection.blockingCount === 0 : null;
  return {
    ...binding(state, context), ...availability, canonical_valid: canonicalValid, current_view_valid: runtimeValid,
    valid: runtimeValid === null ? null : canonicalValid && runtimeValid, checked_component_ids: [...ids],
    issues: collection.issues, issue_count: collection.count, issues_truncated: collection.count > collection.issues.length,
    suggested_placements: suggestions,
  };
}

function candidateState(state: Readonly<WorkspaceState>, candidate: RuntimeLayoutCandidate): WorkspaceState | null {
  const existing = candidate.componentId ? state.components.get(candidate.componentId) : undefined;
  const type = existing?.type ?? candidate.componentType;
  if (!type) return null;
  if (existing && candidate.componentType && (existing.type.typeId !== candidate.componentType.typeId
    || existing.type.version !== candidate.componentType.version || existing.type.digest !== candidate.componentType.digest)) {
    throw new TypeError("candidate.componentType must match the existing component's exact binding");
  }
  const component: ComponentInstance = existing ? { ...existing, placement: structuredClone(candidate.placement) } : {
    id: CANDIDATE_ID, type: { ...type }, label: "Layout candidate", props: {}, durableState: {},
    placement: structuredClone(candidate.placement), bindings: [], tags: [], visibility: "visible",
    locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
    provenance: { createdRevision: state.revision, createdBy: "agent" },
  };
  if (isSpatialComponent(component)) throw new TypeError("Runtime layout candidates must belong to the ui2d domain");
  const components = new Map(state.components);
  components.set(component.id, component);
  return { ...state, components };
}

function candidateSuggestions(state: Readonly<WorkspaceState>, candidate: RuntimeLayoutCandidate, context: RuntimeViewContext, canonicalSuggestions: readonly CanonicalLayoutPlacement[]): CanonicalLayoutPlacement[] {
  const node = projectedNodes(candidateState(state, candidate)!, context).find((entry) => entry.component_id === (candidate.componentId ?? CANDIDATE_ID))!;
  const suggestions: CanonicalLayoutPlacement[] = [];
  const choices: CanonicalLayoutPlacement[] = [...canonicalSuggestions];
  // Bounded screen-space search; every suggestion must also pass durable canonical rules.
  for (const y of [20, context.viewport.height / 3, context.viewport.height * 2 / 3, context.viewport.height - node.bounds.height - 20]) {
    for (const x of [20, context.viewport.width / 3, context.viewport.width * 2 / 3, context.viewport.width - node.bounds.width - 20]) {
      const placement = structuredClone(candidate.placement);
      const dx = x - node.bounds.left;
      const dy = y - node.bounds.top;
      if (placement.space === "canvas2d") {
        placement.position.x += dx / context.canvasView.zoom;
        placement.position.y += dy / context.canvasView.zoom;
      } else {
        placement.offset.x += dx;
        placement.offset.y += dy;
      }
      choices.push(placement);
    }
  }
  const seen = new Set<string>();
  for (const placement of choices) {
    const key = JSON.stringify(placement);
    if (seen.has(key)) continue;
    seen.add(key);
    const proposal = { ...candidate, placement };
    if (!queryLayoutPlacement(state, proposal).valid) continue;
    const projected = projectedNodes(candidateState(state, proposal)!, context);
    const proposedNode = projected.find((entry) => entry.component_id === (candidate.componentId ?? CANDIDATE_ID))!;
    // Suggestions are visible even though an explicit offscreen canvas placement is legal.
    if (!proposedNode.visible || proposedNode.clipped_area > EPSILON) continue;
    if (issuesForNodes(projected, context, new Set([proposedNode.component_id])).blockingCount) continue;
    suggestions.push(placement);
    if (suggestions.length === 4) break;
  }
  return suggestions;
}

export function checkRuntimeLayoutPlacement(state: Readonly<WorkspaceState>, candidate: RuntimeLayoutCandidate, context: RuntimeViewContext | null, options: RuntimeViewOptions = {}): RuntimeLayoutCheck {
  const canonical = queryLayoutPlacement(state, candidate);
  const availability = readiness(state, context, options);
  const ids = [candidate.componentId ?? CANDIDATE_ID];
  if (availability.status !== "ready") return result(state, context, availability, canonical.valid, ids);
  const draft = candidateState(state, candidate);
  if (!draft) return result(state, context, { status: "unavailable", reason: "candidate_component_type_required" }, canonical.valid, ids);
  const draftAvailability = readiness(draft, context, options);
  if (draftAvailability.status !== "ready") return result(state, context, draftAvailability, canonical.valid, ids);
  const issues = issuesForNodes(projectedNodes(draft, context!), context!, new Set(ids));
  const suggestions = !canonical.valid || issues.blockingCount > 0
    ? candidateSuggestions(state, candidate, context!, canonical.suggestedPlacements) : [];
  return result(state, context, availability, canonical.valid, ids, issues, suggestions);
}

function semanticGeometry(state: Readonly<WorkspaceState>, id: string, seen = new Set<string>()): unknown {
  if (seen.has(id)) return "cycle";
  seen.add(id);
  const component = state.components.get(id);
  if (!component) return null;
  const placement = component.placement;
  const target = placement.space === "surface" || placement.space === "billboard" ? placement.targetId : component.parentId;
  return [component.type, placement, component.visibility, component.visualEffects?.opacity,
    target ? semanticGeometry(state, target, seen) : null];
}

/** Compare both states in one immutable view; unchanged legacy conflicts stay repairable. */
export function findWorsenedRuntimeIssues(before: Readonly<WorkspaceState>, after: Readonly<WorkspaceState>, context: RuntimeViewContext | null, options: RuntimeViewOptions = {}): RuntimeLayoutCheck {
  if (before.workspaceId !== after.workspaceId) throw new TypeError("Runtime draft must belong to the same Workspace");
  const canonicalValid = findWorsenedLayoutOverlaps(before, after).length === 0;
  const availability = readiness(before, context, options);
  const semanticChangedIds = [...after.components.values()].filter((component) => !isSpatialComponent(component)
    && JSON.stringify(semanticGeometry(before, component.id)) !== JSON.stringify(semanticGeometry(after, component.id))).map((component) => component.id);
  if (availability.status !== "ready") return result(before, context, availability, canonicalValid, semanticChangedIds);
  const draftAvailability = readiness({ ...after, revision: before.revision }, context, options);
  if (draftAvailability.status !== "ready") return result(before, context, draftAvailability, canonicalValid, semanticChangedIds);
  const beforeNodes = projectedNodes(before, context!);
  const afterNodes = projectedNodes(after, context!);
  const previous = new Map(beforeNodes.map((node) => [node.component_id, node]));
  const ids = afterNodes.filter((node) => JSON.stringify([node.visible, node.placement_space, node.polygon]) !== JSON.stringify([previous.get(node.component_id)?.visible, previous.get(node.component_id)?.placement_space, previous.get(node.component_id)?.polygon])).map((node) => node.component_id);
  const relevant = new Set(ids);
  const worsened = issuesForNodes(afterNodes, context!, relevant, (issue) => {
    const left = previous.get(issue.component_id);
    if (!left?.visible) return true;
    if (issue.kind === "viewport_clipping") {
      return (issue.blocking && left.placement_space !== "viewport") || issue.overlap_area > left.clipped_area + EPSILON;
    }
    const other = issue.kind === "host_occlusion"
      ? rectangle(context!.occluders.find((entry) => entry.id === issue.conflicts_with)!.bounds)
      : previous.get(issue.conflicts_with!)?.clipped_polygon ?? [];
    return issue.overlap_area > area(intersection(left.clipped_polygon, other)) + EPSILON;
  });
  return result(before, context, availability, canonicalValid, ids, worsened);
}
