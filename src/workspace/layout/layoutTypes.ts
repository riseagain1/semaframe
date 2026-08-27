import type {
  Canvas2DPlacement,
  ComponentPlacement,
  Size2,
  Vec2,
  ViewportPlacement,
} from "../components/componentTypes";

export const SEMAFRAME_LAYOUT_GRAPH_VERSION = "1.0" as const;
export const MAX_WORKSPACE_LAYOUT_NODES = 2_000;
export const MAX_WORKSPACE_LAYOUT_CONFLICTS = 10_000;

/**
 * Durable UI placement is resolved in one renderer-independent logical frame.
 * A renderer may scale or letterbox this frame, but must not reinterpret its
 * authored coordinates.
 */
export const CANONICAL_LAYOUT_FRAME = Object.freeze({
  width: 1_440,
  height: 900,
  safeInset: 20,
  units: "logical_px" as const,
  origin: "top_left" as const,
});

export type LayoutFrame2D = Readonly<{
  width: number;
  height: number;
  safeInset: number;
  units: "logical_px";
  origin: "top_left";
}>;

export type CanonicalLayoutPlacement =
  | (Canvas2DPlacement & Readonly<{ size: Size2 }>)
  | (ViewportPlacement & Readonly<{ size: Size2 }>);

export type LayoutBounds2D = Readonly<{
  min: Vec2;
  max: Vec2;
  center: Vec2;
  size: Size2;
}>;

export type LayoutPolygon2D = readonly Vec2[];

export type SemaFrameLayoutGraphNode = Readonly<{
  id: string;
  label: string;
  typeId: string;
  dimensionDomain: "ui2d";
  resolution: "canonical" | "projection_dependent";
  collisionDomain?: "overlay2d:canonical";
  projectionDependency?: "camera_and_viewport" | "target_surface_and_viewport";
  visibility: "visible" | "hidden" | "collapsed";
  placement: ComponentPlacement;
  size: Size2;
  rotationDeg: number;
  zIndex: number;
  bounds?: LayoutBounds2D;
  polygon?: LayoutPolygon2D;
  relations: readonly string[];
}>;

export type LayoutOverlap = Readonly<{
  area: number;
  bounds: LayoutBounds2D;
  polygon: LayoutPolygon2D;
}>;

export type LayoutOverlapConflict = Readonly<{
  componentId: string;
  conflictsWith: string;
  collisionDomain: "overlay2d:canonical";
  overlap: LayoutOverlap;
}>;

export type SemaFrameLayoutGraphSnapshot = Readonly<{
  format: "semaframe-layout-graph";
  version: typeof SEMAFRAME_LAYOUT_GRAPH_VERSION;
  dimensionDomain: "ui2d";
  workspaceId: string;
  workspaceRevision: number;
  coordinateSystem: Readonly<{
    units: "logical_px";
    origin: "top_left";
    width: 1_440;
    height: 900;
    safeInset: 20;
  }>;
  mode: "full" | "delta";
  sinceRevision?: number;
  nodes: readonly SemaFrameLayoutGraphNode[];
  removedNodeIds: readonly string[];
  overlapConflicts: readonly LayoutOverlapConflict[];
  overlapConflictsTruncated: boolean;
  omittedNodeCount: number;
}>;

export type SemaFrameLayoutGraphOptions = Readonly<{
  mode?: "full" | "delta";
  sinceRevision?: number;
  changedNodeIds?: ReadonlySet<string>;
  removedNodeIds?: readonly string[];
  maxNodes?: number;
  maxConflicts?: number;
}>;

export type LayoutPlacementCandidate = Readonly<{
  componentId?: string;
  /** Candidate placement must carry an explicit, positive `size`. */
  placement: CanonicalLayoutPlacement;
}>;

export type LayoutPlacementCheck = Readonly<{
  valid: boolean;
  candidateId: string;
  conflicts: readonly LayoutOverlapConflict[];
  suggestedPlacements: readonly CanonicalLayoutPlacement[];
}>;
