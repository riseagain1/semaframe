import type * as THREE from "three";
import { DEFAULT_COMPONENT_VISUAL_EFFECTS } from "../components/componentTypes";
import type {
  AppearancePatch,
  AnimationClip,
  CameraState,
  CharacterState,
  EffectState,
  EntityKind,
  EntityState,
  EnvironmentState,
  GenericState,
  JSONScalar,
  LightingState,
  LightState,
  PropState,
  SceneDelta,
  SceneOperation,
  SceneState,
} from "../../renderer/sceneRenderTypes";
import type { WorkspaceOperation } from "../protocol/workspaceTypes";
import {
  parametricGeometryDigest,
  parseParametricPrimitive,
} from "../modeling/parametricGeometry";
import type { ParametricRenderMaterial } from "../../renderer/sceneRenderTypes";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";
import {
  computeSceneDelta,
  createEnvironmentState,
  createInitialScene,
} from "../../renderer/sceneRenderState";
import {
  type AnimationCompletionRequest,
  isRecord,
  type CameraProjectionState,
  type WorkspacePlacement,
  type WorkspaceRenderComponent,
  type WorkspaceRenderSnapshot,
} from "./contracts";

export const EMPTY_WORKSPACE_ENVIRONMENT_PRESET = "__workspace_empty__";

export interface ThreeRendererPort {
  initialize(container: HTMLElement): Promise<void>;
  renderState(state: Readonly<SceneState>): Promise<void>;
  applyDelta(
    delta: SceneDelta,
    state?: Readonly<SceneState>,
    operations?: readonly SceneOperation[],
  ): Promise<void>;
  resize(): void;
  dispose(): void;
  getEntityObject?(entityId: string): THREE.Object3D | undefined;
  setSelectedEntity?(entityId: string | null, notify?: boolean): void;
  getProjectionCameraState?(): CameraProjectionState | null;
  frameAll?(): void;
  resetView?(): void;
  zoomBy?(magnification: number): void;
}

export type ThreeComponentRendererOptions = Readonly<{
  renderer?: ThreeRendererPort;
  onSelect?: (componentId: string | null) => void;
  onActivate?: (componentId: string) => void;
  onAnimationComplete?: (request: AnimationCompletionRequest) => void;
  reducedMotion?: boolean;
}>;

/** Adapts Workspace spatial components to the existing deterministic ThreeRenderer. */
export class ThreeComponentRenderer {
  private readonly renderer: ThreeRendererPort;
  private currentScene: SceneState | null = null;
  private initialized = false;
  private lifecycleToken = 0;
  private renderQueue: Promise<void> = Promise.resolve();
  private animationCompletionHandler: ThreeComponentRendererOptions["onAnimationComplete"];

  constructor(options: ThreeComponentRendererOptions = {}) {
    this.animationCompletionHandler = options.onAnimationComplete;
    this.renderer = options.renderer ?? new ThreeRenderer({
      onSelectEntity: options.onSelect,
      onActivateEntity: options.onActivate,
      onAnimationComplete: (completion) => this.animationCompletionHandler?.({
        componentId: completion.entityId,
        clip: completion.clip,
        generation: completion.generation,
      }),
      reducedMotion: options.reducedMotion,
    });
  }

  setAnimationCompletionHandler(
    handler: ThreeComponentRendererOptions["onAnimationComplete"],
  ): void {
    this.animationCompletionHandler = handler;
  }

  async initialize(container: HTMLElement): Promise<void> {
    if (this.initialized) return;
    const lifecycleToken = ++this.lifecycleToken;
    await this.renderer.initialize(container);
    if (lifecycleToken !== this.lifecycleToken) return;
    this.initialized = true;
  }

  async render(
    snapshot: WorkspaceRenderSnapshot,
    operations: readonly WorkspaceOperation[] = [],
  ): Promise<void> {
    if (!this.initialized) throw new Error("ThreeComponentRenderer must be initialized before render().");
    const scene = workspaceToSceneState(snapshot);
    const lifecycleToken = this.lifecycleToken;
    const queued = this.renderQueue.then(async () => {
      if (!this.initialized || lifecycleToken !== this.lifecycleToken) return;
      const previous = this.currentScene;
      if (!previous) await this.renderer.renderState(scene);
      else {
        await this.renderer.applyDelta(
          computeSceneDelta(previous, scene),
          scene,
          workspaceOperationsToSceneOperations(operations, snapshot),
        );
      }
      if (this.initialized && lifecycleToken === this.lifecycleToken) this.currentScene = scene;
    });
    this.renderQueue = queued.catch(() => undefined);
    return queued;
  }

  previewPlacement(componentId: string, placement: WorkspacePlacement): void {
    if (placement.space !== "world3d") return;
    const object = this.renderer.getEntityObject?.(componentId);
    if (!object) return;
    object.position.set(placement.position.x, placement.position.y, placement.position.z);
    object.rotation.set(placement.rotation.x, placement.rotation.y, placement.rotation.z, "XYZ");
    object.scale.set(placement.scale.x, placement.scale.y, placement.scale.z);
    object.updateMatrixWorld(true);
  }

  clearPreview(componentId: string): void {
    const entity = this.currentScene?.entities.get(componentId);
    const object = this.renderer.getEntityObject?.(componentId);
    if (!entity || !object) return;
    const transform = entity.transform;
    object.position.set(transform.position.x, transform.position.y, transform.position.z);
    object.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z, "XYZ");
    object.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
    object.updateMatrixWorld(true);
  }

  setSelection(componentId: string | null): void {
    const spatialId = componentId && this.currentScene?.entities.has(componentId) ? componentId : null;
    // This is synchronization from the shared selection model. Three.js
    // pointer selection still notifies through its own callback, but syncing a
    // selected 2D component to a cleared 3D outline must not clear selection.
    this.renderer.setSelectedEntity?.(spatialId, false);
  }

  getProjectionCameraState(): CameraProjectionState | null {
    const live = this.renderer.getProjectionCameraState?.();
    if (live) return live;
    const camera = this.currentScene?.activeCamera;
    if (!camera || typeof camera.target === "string") return null;
    return {
      position: camera.position,
      target: camera.target,
      fovDeg: camera.fovDeg,
    };
  }

  resize(): void {
    this.renderer.resize();
  }

  frameAll(): void {
    this.renderer.frameAll?.();
  }

  resetView(): void {
    this.renderer.resetView?.();
  }

  zoomBy(magnification: number): void {
    this.renderer.zoomBy?.(magnification);
  }

  dispose(): void {
    this.lifecycleToken += 1;
    this.initialized = false;
    this.renderer.dispose();
    this.currentScene = null;
  }
}

/**
 * Convert revision-matched Workspace operations into the existing Scene
 * renderer's timing vocabulary. The synthetic patch is never reduced or
 * persisted; it only lets ThreeRenderer associate timing with an entity.
 */
export function workspaceOperationsToSceneOperations(
  operations: readonly WorkspaceOperation[],
  snapshot: WorkspaceRenderSnapshot,
): SceneOperation[] {
  const spatialIds = new Set(snapshot.components
    .filter((component) => isSpatialRenderType(component.type.typeId))
    .map((component) => component.id));
  const stageIds = new Set(snapshot.components
    .filter((component) => component.type.typeId === "stage-3d")
    .map((component) => component.id));
  return operations.flatMap((operation): SceneOperation[] => {
    const id = workspaceOperationTarget(operation);
    if (!id) return [];
    const transition = operationTransition(operation);
    const visualTiming = transition
      ? {
          startAfterMs: transition.delayMs ?? 0,
          durationMs: transition.durationMs,
          easing: transition.easing,
        }
      : undefined;
    if (stageIds.has(id)) {
      if (!visualTiming) return [];
      const stage = snapshot.components.find((component) => component.id === id);
      return [{
        op: "set_environment",
        op_id: `workspace:${operation.op_id}`,
        environmentPreset: stringValue(stage?.props.environmentPreset) ?? EMPTY_WORKSPACE_ENVIRONMENT_PRESET,
        ...(visualTiming ? { visualTiming } : {}),
      }];
    }
    if (!spatialIds.has(id)) return [];
    return [{
      op: "update_entity",
      op_id: `workspace:${operation.op_id}`,
      id,
      patch: {},
      ...(visualTiming ? { visualTiming } : {}),
    }];
  });
}

export function workspaceToSceneState(snapshot: WorkspaceRenderSnapshot): SceneState {
  // Host-owned spatial behavior is keyed by the exact registered type ID.
  // Suffix matching here would let a recipe such as `recipe.stage-3d`
  // accidentally become the workspace's privileged world basis.
  // Stage visibility owns the complete spatial projection. A hidden or
  // collapsed root removes both its environment and descendants from WebGL.
  const stage = snapshot.components.find((component) => component.type.typeId === "stage-3d"
    && component.visibility === "visible");
  const scene = createInitialScene();
  scene.revision = snapshot.revision;
  if (stage) applyStage(scene, stage);
  else scene.environment = createEnvironmentState(EMPTY_WORKSPACE_ENVIRONMENT_PRESET);

  const spatialIds = new Set((stage ? snapshot.components : [])
    .filter((component) => isSpatialRenderType(component.type.typeId) && component.visibility !== "collapsed")
    .map((component) => component.id));
  for (const component of snapshot.components) {
    if (!spatialIds.has(component.id) || component.placement.space !== "world3d") continue;
    scene.entities.set(component.id, toEntity(component, spatialIds));
  }
  return scene;
}

function applyStage(scene: SceneState, stage: WorkspaceRenderComponent): void {
  const visualEffects = stage.visualEffects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS;
  const nestedEnvironment = isRecord(stage.props.environment) ? stage.props.environment : undefined;
  // Flat Stage props are the canonical Workspace 1.1 geometry lane. Nested
  // environment data remains a legacy-safe source of optional anchors and
  // scalar properties, and a fallback only when an old Stage lacks flat props.
  const preset = stringValue(stage.props.environmentPreset)
    ?? stringValue(nestedEnvironment?.preset)
    ?? "blank_stage";
  const nestedDimensions = dimensionsValue(nestedEnvironment?.dimensions);
  const dimensions = dimensionsValue(stage.props.dimensions) ?? nestedDimensions;
  const environment = environmentValue(nestedEnvironment, preset, dimensions)
    ?? createEnvironmentState(preset, dimensions);
  const background = colorValue(stage.props.background);
  const gridVisible = booleanValue(stage.props.gridVisible);
  // Project the Stage's flat, manifest-validated presentation props into the
  // renderer-neutral scalar extension lane. Flat Workspace props stay
  // authoritative over optional nested properties.
  const presentationProperties = {
    ...(environment.properties ?? {}),
    ...(background ? { background } : {}),
    ...(gridVisible !== undefined ? { gridVisible } : {}),
    workspaceOpacity: visualEffects.opacity,
    workspaceEmissiveColor: visualEffects.emissive.color,
    workspaceEmissiveIntensity: visualEffects.emissive.intensity,
    workspaceGlowColor: visualEffects.glow.color,
    workspaceGlowIntensity: visualEffects.glow.intensity,
    workspaceGlowSpread: visualEffects.glow.spread,
  };
  scene.environment = {
    ...environment,
    ...(Object.keys(presentationProperties).length
      ? { properties: presentationProperties }
      : {}),
  };
  scene.lighting = lightingValue(stage.props.lighting) ?? scene.lighting;
  const camera = cameraValue(stage.props.activeCamera);
  if (camera) scene.activeCamera = camera;
}

function toEntity(component: WorkspaceRenderComponent, spatialIds: ReadonlySet<string>): EntityState {
  const visualEffects = component.visualEffects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS;
  const placement = component.placement;
  if (placement.space !== "world3d") throw new Error("Spatial entities require world3d placement.");
  if (component.type.typeId === "model-assembly") {
    return {
      id: component.id,
      kind: "primitive",
      assetId: "__semaframe_model_assembly__",
      label: component.label,
      transform: {
        position: { ...placement.position },
        rotation: { ...placement.rotation },
        scale: { ...placement.scale },
      },
      appearance: {
        opacity: component.visibility === "visible" ? visualEffects.opacity : 0,
        emissiveColor: visualEffects.emissive.color,
        emissiveIntensity: visualEffects.emissive.intensity,
        glowColor: visualEffects.glow.color,
        glowIntensity: visualEffects.glow.intensity,
        glowSpread: visualEffects.glow.spread,
      },
      state: { type: "generic", properties: {} },
      renderGeometry: { kind: "assembly" },
      ...(component.parentId && spatialIds.has(component.parentId) ? { parentId: component.parentId } : {}),
      tags: [...component.tags],
      locked: Boolean(component.locks.placement || component.locks.props || component.locks.deletion),
    };
  }
  if (component.type.typeId === "spatial-primitive") {
    const definition = parseParametricPrimitive(component.props.geometry);
    const material = parametricMaterial(component.props.material);
    return {
      id: component.id,
      kind: "primitive",
      assetId: `parametric:${definition.kind}`,
      label: component.label,
      transform: {
        position: { ...placement.position },
        rotation: { ...placement.rotation },
        scale: { ...placement.scale },
      },
      appearance: {
        color: material.baseColor,
        opacity: component.visibility === "visible" ? material.opacity * visualEffects.opacity : 0,
        emissiveColor: material.emissiveColor,
        emissiveIntensity: material.emissiveIntensity + visualEffects.emissive.intensity,
        glowColor: visualEffects.glow.color,
        glowIntensity: visualEffects.glow.intensity,
        glowSpread: visualEffects.glow.spread,
      },
      state: { type: "generic", properties: {} },
      renderGeometry: {
        kind: "parametric",
        definition,
        digest: parametricGeometryDigest(definition),
        material,
        castShadow: component.props.castShadow !== false,
        receiveShadow: component.props.receiveShadow !== false,
      },
      ...(component.parentId && spatialIds.has(component.parentId) ? { parentId: component.parentId } : {}),
      tags: [...component.tags],
      locked: Boolean(component.locks.placement || component.locks.props || component.locks.deletion),
    };
  }
  const kind = entityKind(component.props.entityKind);
  return {
    id: component.id,
    kind,
    assetId: stringValue(component.props.assetId) ?? "primitive_box",
    label: component.label,
    transform: {
      position: { ...placement.position },
      rotation: { ...placement.rotation },
      scale: { ...placement.scale },
    },
    appearance: {
      ...appearanceValue(component.props.appearance),
      // Hidden spatial entities stay allocated so a later show can transition,
      // but opacity zero is also treated as non-interactive by ThreeRenderer.
      opacity: component.visibility === "visible" ? visualEffects.opacity : 0,
      emissiveColor: visualEffects.emissive.color,
      emissiveIntensity: visualEffects.emissive.intensity,
      glowColor: visualEffects.glow.color,
      glowIntensity: visualEffects.glow.intensity,
      glowSpread: visualEffects.glow.spread,
    },
    state: entityState(
      kind,
      component.props.state,
      component.durableState.playback,
      supportsDurablePlayback(component.type.version),
    ),
    ...(component.parentId && spatialIds.has(component.parentId) ? { parentId: component.parentId } : {}),
    ...(typeof component.props.parentSocket === "string" ? { parentSocket: component.props.parentSocket } : {}),
    tags: [...component.tags],
    locked: Boolean(component.locks.placement || component.locks.props || component.locks.deletion),
  };
}

function isSpatialRenderType(typeId: string): boolean {
  return typeId === "spatial-entity" || typeId === "spatial-primitive" || typeId === "model-assembly";
}

function parametricMaterial(value: unknown): ParametricRenderMaterial {
  const record = isRecord(value) ? value : {};
  return {
    baseColor: renderColor(record.baseColor, "#68D5FF"),
    metallic: boundedNumber(record.metallic, 0, 1, 0),
    roughness: boundedNumber(record.roughness, 0, 1, 0.55),
    opacity: boundedNumber(record.opacity, 0, 1, 1),
    emissiveColor: renderColor(record.emissiveColor, "#000000"),
    emissiveIntensity: boundedNumber(record.emissiveIntensity, 0, 8, 0),
  };
}

function renderColor(value: unknown, fallback: `#${string}`): `#${string}` {
  const color = colorValue(value);
  return color?.startsWith("#") ? color as `#${string}` : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function entityState(
  kind: EntityKind,
  value: unknown,
  playbackValue: unknown,
  durablePlayback: boolean,
): CharacterState | PropState | EffectState | GenericState {
  const state = isRecord(value) ? value : {};
  if (kind === "character" || kind === "animal") {
    const playback = spatialPlayback(playbackValue) ?? (durablePlayback ? STOPPED_PLAYBACK : undefined);
    return {
      type: "character",
      ...(isPose(state.pose) ? { pose: state.pose } : {}),
      ...(isEmotion(state.emotion) ? { emotion: state.emotion } : {}),
      ...(isAnimation(state.animation) ? { animation: state.animation } : {}),
      ...(playback ? {
        animation: playback.clip,
        animationPlaying: playback.playing,
        animationLoop: playback.loop,
        animationSpeed: playback.speed,
        animationGeneration: playback.generation,
      } : {}),
    };
  }
  if (kind === "prop" || kind === "structure") {
    return {
      type: "prop",
      ...(typeof state.open === "boolean" ? { open: state.open } : {}),
      ...(typeof state.powered === "boolean" ? { powered: state.powered } : {}),
      ...(typeof state.visible === "boolean" ? { visible: state.visible } : {}),
      ...(typeof state.variantState === "string" ? { variantState: state.variantState } : {}),
    };
  }
  if (kind === "effect") {
    const playback = spatialPlayback(playbackValue) ?? (durablePlayback ? STOPPED_PLAYBACK : undefined);
    return {
      type: "effect",
      enabled: state.enabled !== false,
      ...(numberValue(state.intensity) !== undefined ? { intensity: numberValue(state.intensity) } : {}),
      ...(playback ? {
        animation: playback.clip,
        animationPlaying: playback.playing,
        animationLoop: playback.loop,
        animationSpeed: playback.speed,
        animationGeneration: playback.generation,
      } : {}),
    };
  }
  return { type: "generic", properties: scalarRecord(state) };
}

type SpatialPlayback = Readonly<{
  clip: AnimationClip;
  playing: boolean;
  loop: boolean;
  speed: number;
  generation: number;
}>;

const STOPPED_PLAYBACK: SpatialPlayback = Object.freeze({
  clip: "idle",
  playing: false,
  loop: true,
  speed: 1,
  generation: 0,
});

function supportsDurablePlayback(version: string): boolean {
  const match = /^(\d+)\.(\d+)\./u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 2);
}

function spatialPlayback(value: unknown): SpatialPlayback | undefined {
  if (!isRecord(value)
    || !isAnimation(value.clip)
    || typeof value.playing !== "boolean"
    || typeof value.loop !== "boolean"
    || typeof value.speed !== "number"
    || !Number.isFinite(value.speed)
    || value.speed <= 0
    || typeof value.generation !== "number"
    || !Number.isInteger(value.generation)
    || value.generation < 0) return undefined;
  return {
    clip: value.clip,
    playing: value.playing,
    loop: value.loop,
    speed: value.speed,
    generation: value.generation,
  };
}

function workspaceOperationTarget(operation: WorkspaceOperation): string | undefined {
  switch (operation.op) {
    case "create_component":
    case "update_component":
    case "place_component":
    case "resize_component":
    case "set_component_visual_effects":
    case "invoke_component_action":
      return operation.id;
    case "attach_component":
    case "detach_component":
      return operation.child_id;
    default:
      return undefined;
  }
}

function operationTransition(operation: WorkspaceOperation) {
  return "transition" in operation ? operation.transition : undefined;
}

function appearanceValue(value: unknown): AppearancePatch {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.color === "string" && value.color.startsWith("#") ? { color: value.color as `#${string}` } : {}),
    ...(Array.isArray(value.accessories)
      ? { accessories: value.accessories.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
    ...(isRecord(value.materialOverrides)
      ? { materialOverrides: Object.fromEntries(Object.entries(value.materialOverrides).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
      : {}),
  };
}

function cameraValue(value: unknown): CameraState | undefined {
  if (!isRecord(value)) return undefined;
  const position = vec3Value(value.position);
  const target = typeof value.target === "string" ? value.target : vec3Value(value.target);
  const fovDeg = numberValue(value.fovDeg);
  if (!position || !target || fovDeg === undefined) return undefined;
  const shot = value.shot === "wide" || value.shot === "medium_wide" || value.shot === "medium"
    || value.shot === "close_up" || value.shot === "overhead"
    ? value.shot
    : undefined;
  return { position, target, fovDeg, ...(shot ? { shot } : {}) };
}

function environmentValue(
  value: unknown,
  preset: string,
  dimensions: EnvironmentState["dimensions"],
): EnvironmentState | undefined {
  if (!isRecord(value)) return undefined;
  const base = createEnvironmentState(preset, dimensions);
  const explicitAnchors: EnvironmentState["anchors"] = {};
  if (isRecord(value.anchors)) {
    for (const [name, raw] of Object.entries(value.anchors)) {
      const transform = transformValue(raw);
      if (transform) explicitAnchors[name] = transform;
    }
  }
  const properties = isRecord(value.properties) ? scalarRecord(value.properties) : undefined;
  return {
    ...base,
    ...(Object.keys(explicitAnchors).length
      // Named anchors derived by the canonical preset/dimensions must not be
      // replaced by a stale nested snapshot. Custom anchors remain.
      ? { anchors: { ...explicitAnchors, ...base.anchors } }
      : {}),
    ...(properties && Object.keys(properties).length ? { properties } : {}),
  };
}

function lightingValue(value: unknown): LightingState | undefined {
  if (!isRecord(value) || typeof value.preset !== "string") return undefined;
  const lights = Array.isArray(value.lights)
    ? value.lights.flatMap((entry) => {
        const light = lightValue(entry);
        return light ? [light] : [];
      })
    : undefined;
  return {
    preset: value.preset,
    ...(lights ? { lights } : {}),
    ...(numberValue(value.exposure) !== undefined ? { exposure: numberValue(value.exposure) } : {}),
  };
}

function lightValue(value: unknown): LightState | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind === "ambient" || value.kind === "directional" || value.kind === "point" || value.kind === "spot"
    ? value.kind
    : undefined;
  const intensity = numberValue(value.intensity);
  if (!kind || intensity === undefined) return undefined;
  const position = vec3Value(value.position);
  const target = typeof value.target === "string" ? value.target : vec3Value(value.target);
  return {
    kind,
    intensity,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.color === "string" && value.color.startsWith("#") ? { color: value.color as `#${string}` } : {}),
    ...(position ? { position } : {}),
    ...(target ? { target } : {}),
  };
}

function dimensionsValue(value: unknown): { width: number; height: number; depth: number } | undefined {
  if (!isRecord(value)) return undefined;
  const width = numberValue(value.width);
  const height = numberValue(value.height);
  const depth = numberValue(value.depth);
  return width !== undefined && height !== undefined && depth !== undefined ? { width, height, depth } : undefined;
}

function vec3Value(value: unknown): { x: number; y: number; z: number } | undefined {
  if (!isRecord(value)) return undefined;
  const x = numberValue(value.x);
  const y = numberValue(value.y);
  const z = numberValue(value.z);
  return x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : undefined;
}

function transformValue(value: unknown): SceneState["environment"]["anchors"][string] | undefined {
  if (!isRecord(value)) return undefined;
  const position = vec3Value(value.position);
  const rotation = vec3Value(value.rotation);
  const scale = vec3Value(value.scale);
  return position && rotation && scale ? { position, rotation, scale } : undefined;
}

function entityKind(value: unknown): EntityKind {
  return value === "character" || value === "animal" || value === "prop" || value === "structure" || value === "effect"
    ? value
    : "primitive";
}

function scalarRecord(record: Record<string, unknown>): Record<string, JSONScalar> {
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, JSONScalar] => {
    const value = entry[1];
    return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  }));
}

function isPose(value: unknown): value is "standing" | "sitting" | "lying" | "kneeling" {
  return value === "standing" || value === "sitting" || value === "lying" || value === "kneeling";
}

function isEmotion(value: unknown): value is "neutral" | "afraid" | "angry" | "happy" | "sad" {
  return value === "neutral" || value === "afraid" || value === "angry" || value === "happy" || value === "sad";
}

function isAnimation(value: unknown): value is "idle" | "walk" | "run" | "enter" | "exit" {
  return value === "idle" || value === "walk" || value === "run" || value === "enter" || value === "exit";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function colorValue(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
