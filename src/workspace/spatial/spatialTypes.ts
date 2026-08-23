import type { ComponentPlacement, Vec3 } from "../components/componentTypes";
import type {
  CadEvaluationEvidenceV1,
  CadPartDefinitionV1,
} from "../modeling/cad";
import type { ModelDefinitionRef } from "../modeling/modelDefinitions";
import type { ParametricCollider, ParametricPrimitive } from "../modeling/parametricGeometry";

export const SEMAFRAME_SPATIAL_GRAPH_VERSION = "3.2" as const;
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
  source: "asset_bounds" | "parametric_bounds" | "cad_bounds" | "explicit_box" | "compound_part";
  center: Vec3;
  halfExtents: Vec3;
  axes: readonly [Vec3, Vec3, Vec3];
  aabb: SpatialBounds;
}>;

export type SpatialResolvedCollision = Readonly<{
  enabled: boolean;
  role: SpatialCollisionRole;
  shape: "box" | "compound";
  source: "asset_bounds" | "parametric_bounds" | "cad_bounds" | "explicit_box" | "compound";
  margin: number;
  parts: readonly SpatialResolvedCollisionPart[];
  /** Backwards-compatible envelope fields; exact tests use parts. */
  center: Vec3;
  halfExtents: Vec3;
  axes: readonly [Vec3, Vec3, Vec3];
  aabb: SpatialBounds;
}>;

export type SpatialAssemblyCollisionPolicy = "external_only" | "all" | "none";

export type SpatialAssemblySummary = Readonly<{
  collisionPolicy: SpatialAssemblyCollisionPolicy;
  modelRef?: ModelDefinitionRef;
}>;

/** Outermost-to-nearest assembly ancestry, bounded by the component hierarchy. */
export type SpatialAssemblyAncestor = SpatialAssemblySummary & Readonly<{ id: string }>;

export type SpatialParametricMaterialSummary = Readonly<{
  baseColor: string;
  metallic: number;
  roughness: number;
  opacity: number;
  emissiveColor: string;
  emissiveIntensity: number;
}>;

/** Exact, prompt-safe parametric evidence derived from one validated descriptor. */
export type SpatialParametricGeometrySummary = Readonly<{
  kind: ParametricPrimitive["kind"];
  digest: string;
  parameters: ParametricPrimitive;
  dimensionsM: Vec3;
  localBounds: SpatialBounds;
  volumeM3: number;
  collider: ParametricCollider;
  material?: SpatialParametricMaterialSummary;
}>;

/** Exact compact evidence from the OCCT evaluation of one editable CAD document. */
export type SpatialCadGeometrySummary = Readonly<{
  definitionDigest: string;
  evaluatorVersion: string;
  exactness: "brep";
  bodyCount: number;
  localBounds: SpatialBounds;
  volumeM3: number;
  surfaceAreaM2: number;
  /** Volume-weighted local center of mass from the evaluated OCCT solids. */
  centerOfMassM: Vec3;
  diagnostics: readonly Readonly<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    featureId?: string;
  }>[];
}>;

export type SpatialRealitySummary = Readonly<{
  assetId?: string;
  digest?: string;
  descriptorAvailable: boolean;
  binaryAvailability: "host_local_unknown";
  format?: "spz-v4" | "ply" | "sog-v2";
  splatCount?: number;
  engineeringAuthority: "visual_only";
  calibrationStatus: "uncalibrated" | "metadata-declared" | "reference-distance";
  sourceCoordinateSystem: string;
  targetCoordinateSystem: "RUB";
  metersPerSourceUnit?: number;
  boundsAreMetric: boolean;
  semanticProxyIds: readonly string[];
}>;

export type SemaFrameSpatialGraphNode = Readonly<{
  id: string;
  primPath: string;
  label: string;
  parentId?: string;
  nodeKind: "asset" | "primitive" | "cad" | "assembly" | "reality";
  assetId?: string;
  entityKind: string;
  geometry?: SpatialParametricGeometrySummary;
  cad?: SpatialCadGeometrySummary;
  assembly?: SpatialAssemblySummary;
  reality?: SpatialRealitySummary;
  assemblyAncestry: readonly SpatialAssemblyAncestor[];
  visibility: "visible" | "hidden" | "collapsed";
  localPlacement: ComponentPlacement;
  worldTransform: SpatialTransform;
  worldBounds: SpatialBounds;
  collision?: SpatialResolvedCollision;
  physics?: Readonly<{
    enabled: boolean;
    bodyType: "static" | "dynamic" | "kinematic";
    massKg: number;
    massSource: "explicit";
    geometryVolumeM3?: number;
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

export type SemaFrameSpatialGraphSnapshot = Readonly<{
  format: "semaframe-spatial-graph";
  version: typeof SEMAFRAME_SPATIAL_GRAPH_VERSION;
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
  nodes: readonly SemaFrameSpatialGraphNode[];
  removedNodeIds: readonly string[];
  collisionConflicts: readonly SpatialCollisionConflict[];
  collisionConflictsTruncated: boolean;
  omittedNodeCount: number;
}>;

export type SpatialPlacementCandidate = Readonly<{
  componentId?: string;
  assetId?: string;
  entityKind?: string;
  geometry?: ParametricPrimitive;
  /** Host-evaluated, compact CAD input; external callers provide only the definition. */
  cad?: Readonly<{
    definition: CadPartDefinitionV1;
    evaluation: CadEvaluationEvidenceV1;
  }>;
  placement: ComponentPlacement;
  collision?: SpatialCollisionConfig;
}>;

export type SpatialPlacementCheck = Readonly<{
  valid: boolean;
  candidateId: string;
  conflicts: readonly SpatialCollisionConflict[];
  suggestedPlacements: readonly ComponentPlacement[];
}>;
