import {
  DEFAULT_DECLARATIVE_COMPONENT_SIZE,
  type Canvas2DPlacement,
  type ComponentInstance,
  type ComponentPlacement,
  type Size2,
  type Vec2,
  type ViewportPlacement,
} from "../components/componentTypes";
import { spatialComponentKind } from "../spatial/spatialComponentKinds";
import type { WorkspaceState } from "../state/workspaceState";
import {
  CANONICAL_LAYOUT_FRAME,
  MAX_WORKSPACE_LAYOUT_CONFLICTS,
  MAX_WORKSPACE_LAYOUT_NODES,
  SEMAFRAME_LAYOUT_GRAPH_VERSION,
  type CanonicalLayoutPlacement,
  type LayoutBounds2D,
  type LayoutFrame2D,
  type LayoutOverlapConflict,
  type LayoutPlacementCandidate,
  type LayoutPlacementCheck,
  type LayoutPolygon2D,
  type SemaFrameLayoutGraphNode,
  type SemaFrameLayoutGraphOptions,
  type SemaFrameLayoutGraphSnapshot,
} from "./layoutTypes";

const EPSILON = 1e-7;
const CANDIDATE_ID = "__LAYOUT_CANDIDATE__";
const SUGGESTION_CLEARANCE = 8;
const MAX_LAYOUT_SUGGESTIONS = 4;

const FALLBACK_SIZES: Readonly<Record<string, Readonly<Size2>>> = Object.freeze({
  text: Object.freeze({ width: 280, height: 72 }),
  annotation: Object.freeze({ width: 260, height: 128 }),
  timer: Object.freeze({ width: 210, height: 112 }),
  checklist: Object.freeze({ width: 280, height: 240 }),
  chart: Object.freeze({ width: 360, height: 240 }),
  table: Object.freeze({ width: 420, height: 260 }),
  document: Object.freeze({ width: 420, height: 520 }),
  image: Object.freeze({ width: 320, height: 220 }),
  "video-player": Object.freeze({ width: 480, height: 306 }),
  "web-panel": Object.freeze({ width: 560, height: 420 }),
  "data-panel": Object.freeze({ width: 520, height: 340 }),
  panel: Object.freeze({ width: 320, height: 220 }),
});

/** Shared fallback used by both canonical layout reasoning and DOM projection. */
export function componentFallbackSize(typeId: string, defaultSize?: Readonly<Size2>): Size2 {
  const rendererFallback = defaultSize
    && positiveFinite(defaultSize.width)
    && positiveFinite(defaultSize.height)
    ? defaultSize
    : DEFAULT_DECLARATIVE_COMPONENT_SIZE;
  return structuredClone(FALLBACK_SIZES[typeId] ?? rendererFallback);
}

/** Resolve authored size without consulting DOM layout or rendered content. */
export function componentLayoutSize(
  component: Pick<ComponentInstance, "type" | "placement">,
  defaultSize?: Readonly<Size2>,
): Size2 {
  const authored = "size" in component.placement ? component.placement.size : undefined;
  if (authored && positiveFinite(authored.width) && positiveFinite(authored.height)) {
    return { width: authored.width, height: authored.height };
  }
  return componentFallbackSize(component.type.typeId, defaultSize);
}

/** Existing viewport-anchor semantics expressed as a pure canonical-frame function. */
export function viewportAnchorTopLeft(
  anchor: ViewportPlacement["anchor"],
  size: Readonly<Size2>,
  frame: LayoutFrame2D = CANONICAL_LAYOUT_FRAME,
): Vec2 {
  const left = frame.safeInset;
  const centerX = (frame.width - size.width) / 2;
  const right = frame.width - size.width - frame.safeInset;
  const top = frame.safeInset;
  const centerY = (frame.height - size.height) / 2;
  const bottom = frame.height - size.height - frame.safeInset;
  const points: Record<ViewportPlacement["anchor"], Vec2> = {
    top_left: { x: left, y: top },
    top: { x: centerX, y: top },
    top_right: { x: right, y: top },
    left: { x: left, y: centerY },
    center: { x: centerX, y: centerY },
    right: { x: right, y: centerY },
    bottom_left: { x: left, y: bottom },
    bottom: { x: centerX, y: bottom },
    bottom_right: { x: right, y: bottom },
  };
  return { ...points[anchor] };
}

export function canonicalLayoutPolygon(
  placement: Canvas2DPlacement | ViewportPlacement,
  size: Readonly<Size2>,
  frame: LayoutFrame2D = CANONICAL_LAYOUT_FRAME,
): LayoutPolygon2D {
  let center: Vec2;
  let rotationDeg = 0;
  if (placement.space === "canvas2d") {
    center = {
      x: frame.width / 2 + placement.position.x,
      y: frame.height / 2 + placement.position.y,
    };
    rotationDeg = finite(placement.rotationDeg, 0);
  } else {
    const topLeft = viewportAnchorTopLeft(placement.anchor, size, frame);
    center = {
      x: topLeft.x + placement.offset.x + size.width / 2,
      y: topLeft.y + placement.offset.y + size.height / 2,
    };
  }
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  const radians = rotationDeg * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return Object.freeze([
    rotateAround(center, -halfWidth, -halfHeight, cosine, sine),
    rotateAround(center, halfWidth, -halfHeight, cosine, sine),
    rotateAround(center, halfWidth, halfHeight, cosine, sine),
    rotateAround(center, -halfWidth, halfHeight, cosine, sine),
  ]);
}

export function layoutBoundsForPolygon(polygon: LayoutPolygon2D): LayoutBounds2D {
  if (!polygon.length) {
    const zero = Object.freeze({ x: 0, y: 0 });
    return Object.freeze({ min: zero, max: zero, center: zero, size: Object.freeze({ width: 0, height: 0 }) });
  }
  const min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  const max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY };
  for (const point of polygon) {
    min.x = Math.min(min.x, point.x);
    min.y = Math.min(min.y, point.y);
    max.x = Math.max(max.x, point.x);
    max.y = Math.max(max.y, point.y);
  }
  return Object.freeze({
    min: Object.freeze(min),
    max: Object.freeze(max),
    center: Object.freeze({ x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 }),
    size: Object.freeze({ width: max.x - min.x, height: max.y - min.y }),
  });
}

export function buildSemaFrameLayoutGraph(
  state: Readonly<WorkspaceState>,
  options: SemaFrameLayoutGraphOptions = {},
): SemaFrameLayoutGraphSnapshot {
  const allNodes = createLayoutNodes(state);
  const filtered = options.mode === "delta" && options.changedNodeIds
    ? allNodes.filter((node) => options.changedNodeIds!.has(node.id))
    : allNodes;
  const maxNodes = boundedInteger(
    options.maxNodes,
    MAX_WORKSPACE_LAYOUT_NODES,
    1,
    MAX_WORKSPACE_LAYOUT_NODES,
  );
  const nodes = filtered.slice(0, maxNodes);
  const returnedIds = new Set(nodes.map((node) => node.id));
  const analysisNodes = options.mode === "delta"
    ? [...nodes, ...allNodes.filter((node) => !returnedIds.has(node.id))].slice(0, MAX_WORKSPACE_LAYOUT_NODES)
    : nodes;
  const maxConflicts = boundedInteger(
    options.maxConflicts,
    MAX_WORKSPACE_LAYOUT_CONFLICTS,
    1,
    MAX_WORKSPACE_LAYOUT_CONFLICTS,
  );
  const relevantConflicts = overlapPairs(
    analysisNodes,
    maxConflicts + 1,
    options.mode === "delta" ? returnedIds : undefined,
  );
  const overlapConflictsTruncated = relevantConflicts.length > maxConflicts;
  const overlapConflicts = relevantConflicts.slice(0, maxConflicts);
  decorateRelations(nodes, overlapConflicts);
  return Object.freeze({
    format: "semaframe-layout-graph" as const,
    version: SEMAFRAME_LAYOUT_GRAPH_VERSION,
    dimensionDomain: "ui2d" as const,
    workspaceId: state.workspaceId,
    workspaceRevision: state.revision,
    coordinateSystem: Object.freeze({
      units: "logical_px" as const,
      origin: "top_left" as const,
      width: CANONICAL_LAYOUT_FRAME.width,
      height: CANONICAL_LAYOUT_FRAME.height,
      safeInset: CANONICAL_LAYOUT_FRAME.safeInset,
    }),
    mode: options.mode ?? "full",
    ...(options.sinceRevision === undefined ? {} : { sinceRevision: options.sinceRevision }),
    nodes: Object.freeze(nodes),
    removedNodeIds: Object.freeze([...(options.removedNodeIds ?? [])]
      .sort((left, right) => left.localeCompare(right))),
    overlapConflicts: Object.freeze(overlapConflicts),
    overlapConflictsTruncated,
    omittedNodeCount: filtered.length - nodes.length,
  });
}

export function findLayoutOverlaps(state: Readonly<WorkspaceState>): LayoutOverlapConflict[] {
  return overlapPairs(createLayoutNodes(state), MAX_WORKSPACE_LAYOUT_CONFLICTS);
}

/**
 * Compatibility gate for projects authored before strict 2D layout. Existing
 * conflicts may remain or improve, while any new pair or increased overlap is
 * returned as a worsening transaction.
 */
export function findWorsenedLayoutOverlaps(
  before: Readonly<WorkspaceState>,
  after: Readonly<WorkspaceState>,
): LayoutOverlapConflict[] {
  const beforeNodes = new Map(createLayoutNodes(before).map((node) => [node.id, node]));
  const afterNodes = createLayoutNodes(after);
  const comparableAfter = afterNodes.filter(isComparableLayoutNode);
  const changedAfter = comparableAfter.filter((node) => {
    const previous = beforeNodes.get(node.id);
    return !previous || layoutGeometrySignature(previous) !== layoutGeometrySignature(node);
  }).sort(nodeOrder);
  const checked = new Set<string>();
  const worsened: LayoutOverlapConflict[] = [];
  for (const changed of changedAfter) {
    for (const other of comparableAfter) {
      if (other.id === changed.id) continue;
      const key = pairKey(changed.id, other.id);
      if (checked.has(key)) continue;
      checked.add(key);
      if (!boundsHaveAreaOverlap(changed.bounds!, other.bounds!)) continue;
      const current = overlapConflict(changed, other);
      if (!current) continue;
      const previousLeft = beforeNodes.get(changed.id);
      const previousRight = beforeNodes.get(other.id);
      const prior = previousLeft && previousRight
        && isComparableLayoutNode(previousLeft) && isComparableLayoutNode(previousRight)
        && boundsHaveAreaOverlap(previousLeft.bounds, previousRight.bounds)
        ? overlapConflict(previousLeft, previousRight)
        : undefined;
      if (!prior || current.overlap.area > prior.overlap.area + EPSILON) worsened.push(current);
      // A transaction gate needs a complete practical diagnostic set, but it
      // must never scan a globally truncated legacy list to decide safety.
      if (worsened.length >= MAX_WORKSPACE_LAYOUT_CONFLICTS) return worsened;
    }
  }
  return worsened.sort((left, right) => left.componentId.localeCompare(right.componentId)
    || left.conflictsWith.localeCompare(right.conflictsWith));
}

export function queryLayoutPlacement(
  state: Readonly<WorkspaceState>,
  candidate: LayoutPlacementCandidate,
): LayoutPlacementCheck {
  assertCandidatePlacement(candidate.placement);
  const candidateId = candidate.componentId ?? CANDIDATE_ID;
  const existing = candidate.componentId ? state.components.get(candidate.componentId) : undefined;
  if (candidate.componentId && !existing) throw new TypeError(`Unknown layout component ${candidate.componentId}`);
  if (existing && spatialComponentKind(existing.type.typeId) !== undefined) {
    throw new TypeError(`Component ${existing.id} belongs to the 3D spatial domain`);
  }
  const candidateNode = nodeForCandidate(candidateId, candidate.placement, existing);
  const otherNodes = createLayoutNodes(state).filter((node) => node.id !== candidateId);
  const conflicts = overlapsForNode(candidateNode, otherNodes, MAX_WORKSPACE_LAYOUT_CONFLICTS);
  const suggestedPlacements = conflicts.length
    ? safePlacementSuggestions(otherNodes, candidateNode, candidate.placement)
    : [];
  return Object.freeze({
    valid: conflicts.length === 0,
    candidateId,
    conflicts: Object.freeze(conflicts),
    suggestedPlacements: Object.freeze(suggestedPlacements),
  });
}

export function findAvailableLayoutPlacement(
  state: Readonly<WorkspaceState>,
  candidate: LayoutPlacementCandidate,
): CanonicalLayoutPlacement | undefined {
  const check = queryLayoutPlacement(state, candidate);
  return check.valid ? structuredClone(candidate.placement) : structuredClone(check.suggestedPlacements[0]);
}

/** Plan only placement changes; the caller decides how to commit one atomic batch. */
export function planAutoArrangeLayout(
  state: Readonly<WorkspaceState>,
): ReadonlyMap<string, ComponentPlacement> {
  const canonical = createLayoutNodes(state).filter((node) => node.resolution === "canonical"
    && node.visibility === "visible");
  const components = new Map([...state.components].map(([id, component]) => [id, component]));
  const locked = canonical.filter((node) => components.get(node.id)?.locks.placement === true)
    .sort(nodeOrder);
  const movable = canonical.filter((node) => components.get(node.id)?.locks.placement !== true)
    .sort(nodeOrder);
  const occupied = [...locked];
  const changes = new Map<string, ComponentPlacement>();
  for (const node of movable) {
    const component = components.get(node.id);
    if (!component || (component.placement.space !== "canvas2d" && component.placement.space !== "viewport")) continue;
    const placement = materializedCanonicalPlacement(component.placement, node.size);
    const collides = overlapsForNode(node, occupied, 1).length > 0;
    if (!collides) {
      occupied.push(node);
      continue;
    }
    const suggestions = safePlacementSuggestions(occupied, node, placement);
    const selected = suggestions[0];
    if (!selected) {
      occupied.push(node);
      continue;
    }
    const arranged = nodeForCandidate(node.id, selected, component);
    occupied.push(arranged);
    if (JSON.stringify(selected) !== JSON.stringify(placement)) changes.set(node.id, selected);
  }
  return changes;
}

function createLayoutNodes(state: Readonly<WorkspaceState>): SemaFrameLayoutGraphNode[] {
  return [...state.components.values()]
    .filter((component) => spatialComponentKind(component.type.typeId) === undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(nodeForComponent);
}

function nodeForComponent(component: ComponentInstance): SemaFrameLayoutGraphNode {
  const size = componentLayoutSize(component);
  const placement = component.placement;
  const base = {
    id: component.id,
    label: component.label,
    typeId: component.type.typeId,
    dimensionDomain: "ui2d" as const,
    visibility: component.visibility,
    placement: structuredClone(placement),
    size: Object.freeze({ ...size }),
    rotationDeg: placement.space === "canvas2d" ? finite(placement.rotationDeg, 0) : 0,
    zIndex: layoutZIndex(placement),
    relations: [] as string[],
  };
  if (placement.space === "canvas2d" || placement.space === "viewport") {
    const polygon = canonicalLayoutPolygon(placement, size);
    return {
      ...base,
      resolution: "canonical",
      collisionDomain: "overlay2d:canonical",
      polygon,
      bounds: layoutBoundsForPolygon(polygon),
    };
  }
  return {
    ...base,
    resolution: "projection_dependent",
    projectionDependency: placement.space === "surface"
      ? "target_surface_and_viewport"
      : "camera_and_viewport",
  };
}

function nodeForCandidate(
  id: string,
  placement: CanonicalLayoutPlacement,
  existing?: ComponentInstance,
): SemaFrameLayoutGraphNode {
  const component: ComponentInstance = existing ? {
    ...structuredClone(existing),
    placement: structuredClone(placement),
    visibility: "visible",
  } : {
    id,
    type: { typeId: "layout-candidate", version: "candidate", digest: "candidate" },
    label: "Layout placement candidate",
    props: {},
    durableState: {},
    placement: structuredClone(placement),
    bindings: [],
    tags: [],
    visibility: "visible",
    locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
    provenance: { createdRevision: 0, createdBy: "agent" },
  };
  return nodeForComponent(component);
}

function overlapPairs(
  nodes: readonly SemaFrameLayoutGraphNode[],
  maximum: number,
  relevantNodeIds?: ReadonlySet<string>,
): LayoutOverlapConflict[] {
  const canonical = nodes.filter((node) => node.resolution === "canonical"
    && node.visibility === "visible" && node.bounds && node.polygon)
    .sort((left, right) => left.bounds!.min.x - right.bounds!.min.x || left.id.localeCompare(right.id));
  const conflicts: LayoutOverlapConflict[] = [];
  outer: for (let leftIndex = 0; leftIndex < canonical.length; leftIndex += 1) {
    const left = canonical[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < canonical.length; rightIndex += 1) {
      const right = canonical[rightIndex]!;
      if (right.bounds!.min.x >= left.bounds!.max.x - EPSILON) break;
      if (right.bounds!.max.y <= left.bounds!.min.y + EPSILON
        || right.bounds!.min.y >= left.bounds!.max.y - EPSILON) continue;
      if (relevantNodeIds && !relevantNodeIds.has(left.id) && !relevantNodeIds.has(right.id)) continue;
      const polygon = clipConvexPolygon(left.polygon!, right.polygon!);
      const area = polygonArea(polygon);
      if (area <= EPSILON) continue;
      const [componentId, conflictsWith] = left.id.localeCompare(right.id) <= 0
        ? [left.id, right.id]
        : [right.id, left.id];
      conflicts.push(Object.freeze({
        componentId,
        conflictsWith,
        collisionDomain: "overlay2d:canonical" as const,
        overlap: Object.freeze({
          area,
          bounds: layoutBoundsForPolygon(polygon),
          polygon: Object.freeze(polygon.map((point) => Object.freeze({ ...point }))),
        }),
      }));
      if (conflicts.length >= maximum) break outer;
    }
  }
  return conflicts.sort((left, right) => left.componentId.localeCompare(right.componentId)
    || left.conflictsWith.localeCompare(right.conflictsWith));
}

function isComparableLayoutNode(
  node: SemaFrameLayoutGraphNode,
): node is SemaFrameLayoutGraphNode & Required<Pick<SemaFrameLayoutGraphNode, "bounds" | "polygon">> {
  return node.resolution === "canonical" && node.visibility === "visible"
    && node.bounds !== undefined && node.polygon !== undefined;
}

function layoutGeometrySignature(node: SemaFrameLayoutGraphNode): string {
  return JSON.stringify({
    resolution: node.resolution,
    visibility: node.visibility,
    polygon: node.polygon ?? null,
  });
}

function overlapsForNode(
  candidate: SemaFrameLayoutGraphNode,
  others: readonly SemaFrameLayoutGraphNode[],
  maximum: number,
): LayoutOverlapConflict[] {
  if (candidate.resolution !== "canonical" || candidate.visibility !== "visible"
    || !candidate.bounds || !candidate.polygon) return [];
  const conflicts: LayoutOverlapConflict[] = [];
  for (const other of [...others].sort((left, right) => left.id.localeCompare(right.id))) {
    if (other.id === candidate.id || other.resolution !== "canonical" || other.visibility !== "visible"
      || !other.bounds || !other.polygon || !boundsHaveAreaOverlap(candidate.bounds, other.bounds)) continue;
    const conflict = overlapConflict(candidate, other);
    if (conflict) conflicts.push(conflict);
    if (conflicts.length >= maximum) break;
  }
  return conflicts.sort((left, right) => left.componentId.localeCompare(right.componentId)
    || left.conflictsWith.localeCompare(right.conflictsWith));
}

function boundsHaveAreaOverlap(left: LayoutBounds2D, right: LayoutBounds2D): boolean {
  return right.min.x < left.max.x - EPSILON
    && right.max.x > left.min.x + EPSILON
    && right.min.y < left.max.y - EPSILON
    && right.max.y > left.min.y + EPSILON;
}

function overlapConflict(
  left: SemaFrameLayoutGraphNode,
  right: SemaFrameLayoutGraphNode,
): LayoutOverlapConflict | undefined {
  const polygon = clipConvexPolygon(left.polygon!, right.polygon!);
  const area = polygonArea(polygon);
  if (area <= EPSILON) return undefined;
  const [componentId, conflictsWith] = left.id.localeCompare(right.id) <= 0
    ? [left.id, right.id]
    : [right.id, left.id];
  return Object.freeze({
    componentId,
    conflictsWith,
    collisionDomain: "overlay2d:canonical" as const,
    overlap: Object.freeze({
      area,
      bounds: layoutBoundsForPolygon(polygon),
      polygon: Object.freeze(polygon.map((point) => Object.freeze({ ...point }))),
    }),
  });
}

function clipConvexPolygon(subject: LayoutPolygon2D, clip: LayoutPolygon2D): Vec2[] {
  let output = subject.map((point) => ({ ...point }));
  if (output.length < 3 || clip.length < 3) return [];
  const orientation = signedPolygonArea(clip) >= 0 ? 1 : -1;
  for (let index = 0; index < clip.length; index += 1) {
    const edgeStart = clip[index]!;
    const edgeEnd = clip[(index + 1) % clip.length]!;
    const input = output;
    output = [];
    if (!input.length) break;
    let previous = input.at(-1)!;
    let previousInside = insideEdge(previous, edgeStart, edgeEnd, orientation);
    for (const current of input) {
      const currentInside = insideEdge(current, edgeStart, edgeEnd, orientation);
      if (currentInside !== previousInside) {
        output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
      }
      if (currentInside) output.push({ ...current });
      previous = current;
      previousInside = currentInside;
    }
  }
  return deduplicatePolygon(output);
}

function insideEdge(point: Vec2, start: Vec2, end: Vec2, orientation: number): boolean {
  return orientation * cross(subtract(end, start), subtract(point, start)) >= -EPSILON;
}

function lineIntersection(first: Vec2, second: Vec2, edgeStart: Vec2, edgeEnd: Vec2): Vec2 {
  const segment = subtract(second, first);
  const edge = subtract(edgeEnd, edgeStart);
  const denominator = cross(segment, edge);
  if (Math.abs(denominator) <= EPSILON) return { ...second };
  const amount = cross(subtract(edgeStart, first), edge) / denominator;
  return { x: first.x + segment.x * amount, y: first.y + segment.y * amount };
}

function deduplicatePolygon(points: readonly Vec2[]): Vec2[] {
  const output: Vec2[] = [];
  for (const point of points) {
    const previous = output.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > EPSILON) output.push(point);
  }
  if (output.length > 1) {
    const first = output[0]!;
    const last = output.at(-1)!;
    if (Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON) output.pop();
  }
  return output;
}

function polygonArea(polygon: readonly Vec2[]): number {
  return Math.abs(signedPolygonArea(polygon));
}

function signedPolygonArea(polygon: readonly Vec2[]): number {
  if (polygon.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    twiceArea += current.x * next.y - current.y * next.x;
  }
  return twiceArea / 2;
}

function safePlacementSuggestions(
  otherNodes: readonly SemaFrameLayoutGraphNode[],
  candidateNode: SemaFrameLayoutGraphNode,
  placement: CanonicalLayoutPlacement,
): CanonicalLayoutPlacement[] {
  if (!candidateNode.bounds) return [];
  const colliders = otherNodes.filter((node) => node.resolution === "canonical"
    && node.visibility === "visible" && node.bounds && node.polygon);
  const conflicts = colliders.filter((node) => overlapsForNode(candidateNode, [node], 1).length > 0);
  const deltas: Vec2[] = [];
  if (conflicts.length) {
    deltas.push(
      { x: Math.min(...conflicts.map((node) => node.bounds!.min.x)) - candidateNode.bounds.max.x - SUGGESTION_CLEARANCE, y: 0 },
      { x: Math.max(...conflicts.map((node) => node.bounds!.max.x)) - candidateNode.bounds.min.x + SUGGESTION_CLEARANCE, y: 0 },
      { x: 0, y: Math.min(...conflicts.map((node) => node.bounds!.min.y)) - candidateNode.bounds.max.y - SUGGESTION_CLEARANCE },
      { x: 0, y: Math.max(...conflicts.map((node) => node.bounds!.max.y)) - candidateNode.bounds.min.y + SUGGESTION_CLEARANCE },
    );
  }
  const step = 24;
  const minX = CANONICAL_LAYOUT_FRAME.safeInset;
  const minY = CANONICAL_LAYOUT_FRAME.safeInset;
  const maxX = CANONICAL_LAYOUT_FRAME.width - CANONICAL_LAYOUT_FRAME.safeInset - candidateNode.bounds.size.width;
  const maxY = CANONICAL_LAYOUT_FRAME.height - CANONICAL_LAYOUT_FRAME.safeInset - candidateNode.bounds.size.height;
  if (maxX >= minX && maxY >= minY) {
    for (let y = minY; y <= maxY + EPSILON; y += step) {
      for (let x = minX; x <= maxX + EPSILON; x += step) {
        deltas.push({ x: x - candidateNode.bounds.min.x, y: y - candidateNode.bounds.min.y });
      }
    }
  }
  const unique = new Map<string, Vec2>();
  for (const delta of deltas) unique.set(`${round(delta.x)}:${round(delta.y)}`, delta);
  const ordered = [...unique.values()].sort((left, right) => Math.hypot(left.x, left.y) - Math.hypot(right.x, right.y)
    || left.y - right.y || left.x - right.x);
  const suggestions: CanonicalLayoutPlacement[] = [];
  for (const delta of ordered) {
    const shifted = shiftPlacement(placement, delta);
    const shiftedNode = nodeForCandidate(candidateNode.id, shifted);
    if (!withinCanonicalFrame(shiftedNode.bounds!) || overlapsForNode(shiftedNode, colliders, 1).length) continue;
    if (!suggestions.some((entry) => JSON.stringify(entry) === JSON.stringify(shifted))) suggestions.push(shifted);
    if (suggestions.length >= MAX_LAYOUT_SUGGESTIONS) break;
  }
  return suggestions;
}

function materializedCanonicalPlacement(
  placement: Canvas2DPlacement | ViewportPlacement,
  size: Size2,
): CanonicalLayoutPlacement {
  return { ...structuredClone(placement), size: structuredClone(size) } as CanonicalLayoutPlacement;
}

function shiftPlacement(placement: CanonicalLayoutPlacement, delta: Vec2): CanonicalLayoutPlacement {
  if (placement.space === "canvas2d") return {
    ...structuredClone(placement),
    position: { x: placement.position.x + delta.x, y: placement.position.y + delta.y },
  };
  return {
    ...structuredClone(placement),
    offset: { x: placement.offset.x + delta.x, y: placement.offset.y + delta.y },
  };
}

function withinCanonicalFrame(bounds: LayoutBounds2D): boolean {
  return bounds.min.x >= CANONICAL_LAYOUT_FRAME.safeInset - EPSILON
    && bounds.min.y >= CANONICAL_LAYOUT_FRAME.safeInset - EPSILON
    && bounds.max.x <= CANONICAL_LAYOUT_FRAME.width - CANONICAL_LAYOUT_FRAME.safeInset + EPSILON
    && bounds.max.y <= CANONICAL_LAYOUT_FRAME.height - CANONICAL_LAYOUT_FRAME.safeInset + EPSILON;
}

function assertCandidatePlacement(placement: CanonicalLayoutPlacement): void {
  if (placement.space !== "canvas2d" && placement.space !== "viewport") {
    throw new TypeError("Layout placement candidates require canvas2d or viewport placement");
  }
  if (!placement.size || !positiveFinite(placement.size.width) || !positiveFinite(placement.size.height)) {
    throw new TypeError("Layout placement candidates require an explicit positive size");
  }
}

function decorateRelations(
  nodes: readonly SemaFrameLayoutGraphNode[],
  conflicts: readonly LayoutOverlapConflict[],
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const conflict of conflicts) {
    const left = byId.get(conflict.componentId);
    const right = byId.get(conflict.conflictsWith);
    if (left) (left.relations as string[]).push(`overlaps:${conflict.conflictsWith}`);
    if (right) (right.relations as string[]).push(`overlaps:${conflict.componentId}`);
  }
  for (const node of nodes) (node.relations as string[]).sort((left, right) => left.localeCompare(right));
}

function layoutZIndex(placement: ComponentPlacement): number {
  if ("zIndex" in placement && Number.isFinite(placement.zIndex)) return placement.zIndex ?? 0;
  if (placement.space === "viewport") return 500;
  if (placement.space === "billboard") return 300;
  if (placement.space === "surface") return 250;
  if (placement.space === "canvas2d") return 200;
  return 100;
}

function nodeOrder(left: SemaFrameLayoutGraphNode, right: SemaFrameLayoutGraphNode): number {
  return left.zIndex - right.zIndex || left.id.localeCompare(right.id);
}

function pairKey(left: string, right: string): string {
  return left.localeCompare(right) <= 0 ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function rotateAround(center: Vec2, x: number, y: number, cosine: number, sine: number): Vec2 {
  return Object.freeze({
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  });
}

function subtract(left: Vec2, right: Vec2): Vec2 {
  return { x: left.x - right.x, y: left.y - right.y };
}

function cross(left: Vec2, right: Vec2): number {
  return left.x * right.y - left.y * right.x;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const finiteValue = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(minimum, Math.min(maximum, finiteValue));
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
