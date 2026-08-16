/**
 * Internal, renderer-neutral DTOs for the Three.js projection.
 *
 * These are not an authoring protocol or a persisted project format. The
 * Workspace store is the sole semantic authority; this module only describes
 * the compact state and timing hints consumed by the renderer.
 */

export type JSONScalar = string | number | boolean | null;
export type EntityId = string;

export type EntityKind =
  | "character"
  | "animal"
  | "prop"
  | "structure"
  | "effect"
  | "primitive";

export type Vec3 = { x: number; y: number; z: number };
export type Dimensions = { width: number; height: number; depth: number };
export type Transform = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
};

export type Pose = "standing" | "sitting" | "lying" | "kneeling";
export type Emotion = "neutral" | "afraid" | "angry" | "happy" | "sad";
export type AnimationClip = "idle" | "walk" | "run" | "enter" | "exit";
export type CameraShot = "wide" | "medium_wide" | "medium" | "close_up" | "overhead";
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out";

export type VisualTiming = {
  startAfterMs?: number;
  durationMs?: number;
  easing?: Easing;
  syncGroup?: string;
};

export type AppearancePatch = {
  color?: `#${string}`;
  accessories?: string[];
  variant?: string;
  materialOverrides?: Record<string, string>;
  opacity?: number;
  emissiveColor?: `#${string}`;
  emissiveIntensity?: number;
  glowColor?: `#${string}`;
  glowIntensity?: number;
  glowSpread?: number;
};

export type CharacterState = {
  type: "character";
  pose?: Pose;
  emotion?: Emotion;
  animation?: AnimationClip;
  animationPlaying?: boolean;
  animationLoop?: boolean;
  animationSpeed?: number;
  animationGeneration?: number;
};

export type PropState = {
  type: "prop";
  open?: boolean;
  powered?: boolean;
  visible?: boolean;
  variantState?: string;
};

export type EffectState = {
  type: "effect";
  enabled: boolean;
  intensity?: number;
  animation?: AnimationClip;
  animationPlaying?: boolean;
  animationLoop?: boolean;
  animationSpeed?: number;
  animationGeneration?: number;
};

export type GenericState = {
  type: "generic";
  properties?: Record<string, JSONScalar>;
};

export type EntityState = {
  id: EntityId;
  kind: EntityKind;
  assetId: string;
  label: string;
  transform: Transform;
  appearance: AppearancePatch;
  state: CharacterState | PropState | EffectState | GenericState;
  parentId?: EntityId;
  parentSocket?: string;
  tags: string[];
  locked: boolean;
};

export type LightKind = "ambient" | "directional" | "point" | "spot";
export type LightState = {
  id?: string;
  kind: LightKind;
  intensity: number;
  color?: `#${string}`;
  position?: Vec3;
  target?: Vec3 | EntityId;
};

export type EnvironmentState = {
  preset: string;
  dimensions?: Dimensions;
  anchors: Record<string, Transform>;
  properties?: Record<string, JSONScalar>;
};

export type LightingState = {
  preset: string;
  lights?: LightState[];
  exposure?: number;
};

export type CameraState = {
  position: Vec3;
  target: Vec3 | EntityId;
  fovDeg: number;
  shot?: CameraShot;
};

export type SceneState = {
  revision: number;
  environment: EnvironmentState;
  lighting: LightingState;
  entities: Map<EntityId, EntityState>;
  activeCamera: CameraState;
};

export type SceneDelta = {
  fromRevision: number;
  toRevision: number;
  added: EntityId[];
  updated: EntityId[];
  removed: EntityId[];
  environmentChanged: boolean;
  lightingChanged: boolean;
  cameraChanged: boolean;
};

type RenderOperationBase = {
  op_id: string;
  visualTiming?: VisualTiming;
};

/** Renderer-only timing hints emitted by the Workspace-to-Three adapter. */
export type SceneOperation =
  | (RenderOperationBase & {
      op: "set_environment";
      environmentPreset: string;
    })
  | (RenderOperationBase & {
      op: "update_entity";
      id: EntityId;
      patch: Record<string, never>;
    });

export type ApproximationNote = {
  code: string;
  entityId?: EntityId;
  message: string;
};

export type AssetCandidate = {
  assetId: string;
  score: number;
};
