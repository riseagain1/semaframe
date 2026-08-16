import type { ComponentPlacement, Vec3 } from "../components/componentTypes";

export const UNIVERSAL_SPACE_DATA_VERSION = "2.0" as const;
export const MAX_WORKSPACE_SPATIAL_NODES = 2_000;

export type SpatialCollisionRole = "solid" | "trigger" | "none";

export type SpatialCollisionBoxPart = Readonly<{
  id: string;
  center: Vec3;
  size: Vec3;
  rotation: Vec3;
}>;

/**
 * Durable, renderer-independent collision intent for a spatial component.
 * The actual volume is resolved from the pinned asset manifest so Agents
 * cannot silently invent geometry that disagrees with the rendered asset.
 */
type SpatialCollisionBase = Readonly<{
  enabled: boolean;
  role: SpatialCollisionRole;
  margin: number;
}>;

export type SpatialCollisionConfig =
  | (SpatialCollisionBase & Readonly<{ shape: "asset_bounds" }>)
  | (SpatialCollisionBase & Readonly<{ shape: "box"; center: Vec3; size: Vec3 }>)
  | (SpatialCollisionBase & Readonly<{ shape: "compound"; parts: readonly SpatialCollisionBoxPart[] }>);

export const DEFAULT_SPATIAL_COLLISION: SpatialCollisionConfig = Object.freeze({
  enabled: true,
  role: "solid",
  shape: "asset_bounds",
  margin: 0.02,
});

export type SpatialTransform = Readonly<{
  position: Vec3;
  rotationQuaternion: Readonly<{ x: number; y: number; z: number; w: number }>;
  scale: Vec3;
  /** Row-major local-to-world matrix. */
  matrix: readonly number[];
}>;

export type SpatialBounds = Readonly<{
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
}>;

export type SpatialResolvedCollisionPart = Readonly<{
  id: string;
  source: "asset_bounds" | "explicit_box" | "compound_part";
  center: Vec3;
  halfExtents: Vec3;
  axes: readonly [Vec3, Vec3, Vec3];
  aabb: SpatialBounds;
}>;

export type SpatialResolvedCollision = Readonly<{
  enabled: boolean;
  role: SpatialCollisionRole;
  shape: "box" | "compound";
  source: "asset_bounds" | "explicit_box" | "compound";
  margin: number;
  parts: readonly SpatialResolvedCollisionPart[];
  /** Backwards-compatible envelope fields; exact tests use parts. */
  center: Vec3;
  halfExtents: Vec3;
  axes: readonly [Vec3, Vec3, Vec3];
  aabb: SpatialBounds;
}>;

export type UniversalSpaceDataNode = Readonly<{
  id: string;
  primPath: string;
  label: string;
  parentId?: string;
  assetId: string;
  entityKind: string;
  visibility: "visible" | "hidden" | "collapsed";
  localPlacement: ComponentPlacement;
  worldTransform: SpatialTransform;
  worldBounds: SpatialBounds;
  collision?: SpatialResolvedCollision;
  physics?: Readonly<{
    enabled: boolean;
    bodyType: "static" | "dynamic" | "kinematic";
    massKg: number;
    centerOfMass: Vec3;
    friction: number;
    restitution: number;
    gravityScale: number;
    stabilityMode: "report" | "enforce";
    constraintCount: number;
  }>;
  relations: readonly string[];
}>;

export type SpatialCollisionConflict = Readonly<{
  componentId: string;
  conflictsWith: string;
  overlap: Vec3;
}>;

export type UniversalSpaceDataSnapshot = Readonly<{
  format: "universal-space-data";
  version: typeof UNIVERSAL_SPACE_DATA_VERSION;
  workspaceId: string;
  workspaceRevision: number;
  coordinateSystem: Readonly<{
    units: "meters";
    upAxis: "+Y";
    forwardAxis: "+Z";
  }>;
  stage?: Readonly<{
    componentId: string;
    visibility: "visible" | "hidden" | "collapsed";
    dimensions: Readonly<{ width: number; height: number; depth: number }>;
    groundHeight: 0;
    groundPolygon: readonly Readonly<{ x: number; z: number }>[];
  }>;
  mode: "full" | "delta";
  sinceRevision?: number;
  nodes: readonly UniversalSpaceDataNode[];
  removedNodeIds: readonly string[];
  collisionConflicts: readonly SpatialCollisionConflict[];
  collisionConflictsTruncated: boolean;
  omittedNodeCount: number;
}>;

export type SpatialPlacementCandidate = Readonly<{
  componentId?: string;
  assetId?: string;
  entityKind?: string;
  placement: ComponentPlacement;
  collision?: SpatialCollisionConfig;
}>;

export type SpatialPlacementCheck = Readonly<{
  valid: boolean;
  candidateId: string;
  conflicts: readonly SpatialCollisionConflict[];
  suggestedPlacements: readonly ComponentPlacement[];
}>;
