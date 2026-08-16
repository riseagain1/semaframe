/** Renderer-independent component contracts for Workspace Protocol 1.2. */

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONObject | JSONValue[];
export type JSONObject = { [key: string]: JSONValue };

export type JSONSchema = Readonly<Record<string, unknown>>;

export type ComponentId = string;
export type ComponentTypeId = string;
export type PlacementSpace =
  | "world3d"
  | "canvas2d"
  | "surface"
  | "billboard"
  | "viewport";

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };
export type Size2 = { width: number; height: number };

export type World3DPlacement = {
  space: "world3d";
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  /** Pixel size for DOM-projected components anchored in world space. */
  size?: Size2;
};

export type Canvas2DPlacement = {
  space: "canvas2d";
  position: Vec2;
  size?: Size2;
  rotationDeg?: number;
  zIndex?: number;
};

export type SurfacePlacement = {
  space: "surface";
  targetId: ComponentId;
  surface: string;
  offset: Vec2;
  size?: Size2;
  zIndex?: number;
};

export type BillboardPlacement = {
  space: "billboard";
  targetId: ComponentId;
  offset: Vec3;
  size?: Size2;
  occlusion?: "visible" | "hide_when_occluded" | "fade_when_occluded";
};

export type ViewportPlacement = {
  space: "viewport";
  anchor:
    | "top_left"
    | "top"
    | "top_right"
    | "left"
    | "center"
    | "right"
    | "bottom_left"
    | "bottom"
    | "bottom_right";
  offset: Vec2;
  size?: Size2;
  zIndex?: number;
};

export type ComponentPlacement =
  | World3DPlacement
  | Canvas2DPlacement
  | SurfacePlacement
  | BillboardPlacement
  | ViewportPlacement;

export type ComponentTypeRef = {
  typeId: ComponentTypeId;
  version: string;
  digest: string;
};

export type ComponentTrustTier = "builtin" | "declarative" | "sandboxed";
export type EffectClass =
  | "none"
  | "semantic"
  | "data_read"
  | "external_write"
  | "extension_install";

export type ComponentActionManifest = {
  inputSchema: JSONSchema;
  effectClass: EffectClass;
  requiredPermissions?: string[];
  /** False for host acknowledgements that must never be triggered by a route. */
  routable?: boolean;
};

export type ResizeMode = "none" | "free" | "aspect_locked" | "uniform";
export type Box2DResizeAxis = "width" | "height";
export type Scale3DResizeAxis = "x" | "y" | "z";
export type StageDimensionResizeAxis = "width" | "height" | "depth";

export type NoResizePolicy = {
  kind: "none";
  mode: "none";
};

export type Box2DResizePolicy = {
  kind: "box2d";
  mode: "free" | "aspect_locked";
  defaultSize: Size2;
  minSize: Size2;
  maxSize: Size2;
  /** Required and authoritative when mode is aspect_locked. */
  aspectRatio?: number;
  allowedAxes: Box2DResizeAxis[];
  units: "px";
};

export type Scale3DResizePolicy = {
  kind: "scale3d";
  mode: "free" | "uniform";
  defaultScale: Vec3;
  minScale: Vec3;
  maxScale: Vec3;
  allowedAxes: Scale3DResizeAxis[];
  units: "ratio";
};

export type StageDimensionsResizePolicy = {
  kind: "stage_dimensions";
  mode: "free" | "uniform";
  defaultDimensions: { width: number; height: number; depth: number };
  minDimensions: { width: number; height: number; depth: number };
  maxDimensions: { width: number; height: number; depth: number };
  allowedAxes: StageDimensionResizeAxis[];
  units: "m";
};

export type ComponentResizePolicy =
  | NoResizePolicy
  | Box2DResizePolicy
  | Scale3DResizePolicy
  | StageDimensionsResizePolicy;

export type ComponentResizePolicies = Partial<Record<PlacementSpace, ComponentResizePolicy>>;

export const DEFAULT_DECLARATIVE_COMPONENT_SIZE: Readonly<Size2> = Object.freeze({
  width: 240,
  height: 144,
});

export type ComponentResize =
  | { kind: "box2d"; size: Size2 }
  | { kind: "scale3d"; scale: Vec3 }
  | { kind: "stage_dimensions"; dimensions: { width: number; height: number; depth: number } };

/**
 * Renderer-neutral presentation shared by every component type.
 *
 * `glow` is semantic: the 3D renderer maps it to bloom while the DOM renderer
 * maps it to an outer halo. This keeps persisted projects independent of a
 * particular rendering library or post-processing implementation.
 */
export type ComponentVisualEffects = {
  opacity: number;
  emissive: {
    color: `#${string}`;
    intensity: number;
  };
  glow: {
    color: `#${string}`;
    intensity: number;
    spread: number;
  };
};

export const DEFAULT_COMPONENT_VISUAL_EFFECTS: Readonly<ComponentVisualEffects> = Object.freeze({
  opacity: 1,
  emissive: Object.freeze({ color: "#FFFFFF", intensity: 0 }),
  glow: Object.freeze({ color: "#68D5FF", intensity: 0, spread: 0.5 }),
});

export const COMPONENT_VISUAL_EFFECT_LIMITS = Object.freeze({
  opacity: Object.freeze({ min: 0, max: 1 }),
  emissiveIntensity: Object.freeze({ min: 0, max: 8 }),
  glowIntensity: Object.freeze({ min: 0, max: 4 }),
  glowSpread: Object.freeze({ min: 0, max: 1 }),
});

export function noResizePolicyForPlacements(
  placements: readonly PlacementSpace[],
): ComponentResizePolicies {
  return Object.fromEntries(
    placements.map((placement) => [placement, { kind: "none", mode: "none" }]),
  ) as ComponentResizePolicies;
}

/** Broad compatibility policy for recipes that predate an explicit resize contract. */
export function defaultRecipeResizePolicies(
  placements: readonly PlacementSpace[],
): ComponentResizePolicies {
  return Object.fromEntries(placements.map((placement) => [placement, {
    kind: "box2d",
    mode: "free",
    defaultSize: structuredClone(DEFAULT_DECLARATIVE_COMPONENT_SIZE),
    minSize: { width: 1, height: 1 },
    maxSize: { width: 4_096, height: 4_096 },
    allowedAxes: ["width", "height"],
    units: "px",
  }])) as ComponentResizePolicies;
}

export function resizePolicyForPlacement(
  manifest: Pick<ComponentManifest, "resizePolicy">,
  placement: ComponentPlacement | PlacementSpace,
): ComponentResizePolicy {
  const space = typeof placement === "string" ? placement : placement.space;
  return manifest.resizePolicy[space] ?? { kind: "none", mode: "none" };
}

export type ComponentManifest = {
  typeId: ComponentTypeId;
  version: string;
  digest: string;
  displayName: string;
  trustTier: ComponentTrustTier;
  allowedPlacements: PlacementSpace[];
  resizePolicy: ComponentResizePolicies;
  propsSchema: JSONSchema;
  durableStateSchema: JSONSchema;
  defaultProps: JSONObject;
  defaultDurableState: JSONObject;
  writableProps: string[];
  actions: Record<string, ComponentActionManifest>;
  events: Record<string, JSONSchema>;
  requiredPermissions: string[];
};

export type ComponentLocks = {
  placement: boolean;
  resize: boolean;
  visualEffects?: boolean;
  props: boolean;
  deletion: boolean;
  actions: boolean;
};

export type ComponentVisibility = "visible" | "hidden" | "collapsed";

export type ComponentProvenance = {
  createdRevision: number;
  createdBy: "user" | "agent" | "system" | "migration";
  legacyId?: string;
  sourceId?: string;
};

export type ComponentInstance = {
  id: ComponentId;
  type: ComponentTypeRef;
  label: string;
  props: JSONObject;
  durableState: JSONObject;
  placement: ComponentPlacement;
  parentId?: ComponentId;
  bindings: string[];
  tags: string[];
  visibility: ComponentVisibility;
  /** Always materialized by WorkspaceStore; optional only for pre-1.2 snapshots. */
  visualEffects?: ComponentVisualEffects;
  locks: ComponentLocks;
  provenance: ComponentProvenance;
};

export type RecipePrimitive =
  | "stack"
  | "grid"
  | "overlay"
  | "scroll"
  | "text"
  | "shape"
  | "image"
  | "icon"
  | "chart"
  | "table"
  | "asset3d"
  | "button"
  | "slider"
  | "toggle"
  | "input"
  | "timer";

export type ComponentRecipeNode = {
  id: string;
  primitive: RecipePrimitive;
  props?: JSONObject;
  children?: ComponentRecipeNode[];
};

export type ComponentRecipe = {
  typeId: ComponentTypeId;
  version: string;
  digest: string;
  displayName: string;
  allowedPlacements: PlacementSpace[];
  /** Optional only for legacy 1.0 recipes; canonical 1.1 recipes always include it. */
  resizePolicy?: ComponentResizePolicies;
  propsSchema: JSONSchema;
  durableStateSchema: JSONSchema;
  defaultProps: JSONObject;
  defaultDurableState: JSONObject;
  writableProps: string[];
  actions: Record<string, ComponentActionManifest>;
  events: Record<string, JSONSchema>;
  root: ComponentRecipeNode;
};

export const DEFAULT_COMPONENT_LOCKS: Readonly<ComponentLocks> = Object.freeze({
  placement: false,
  resize: false,
  visualEffects: false,
  props: false,
  deletion: false,
  actions: false,
});

export const DEFAULT_WORLD_PLACEMENT: Readonly<World3DPlacement> = Object.freeze({
  space: "world3d",
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  rotation: Object.freeze({ x: 0, y: 0, z: 0 }),
  scale: Object.freeze({ x: 1, y: 1, z: 1 }),
});
