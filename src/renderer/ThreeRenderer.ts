import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { DEFAULT_ASSET_REGISTRY, type AssetRegistry } from "../assets/AssetRegistry";
import type {
  CameraShot,
  CameraState,
  EntityId,
  EntityState,
  SceneDelta,
  SceneOperation,
  SceneState,
  Transform,
  Vec3,
} from "./sceneRenderTypes";
import { createEnvironment, createLighting } from "./environmentPresets";
import { GltfAssetLoader } from "./GltfAssetLoader";
import {
  applyEntityAppearance,
  applyEntityState,
  createProceduralEntity,
  disposeObject,
  findSocket,
  type AnimationCompletion,
  type ProceduralEntity,
  updateEntityAnimation,
} from "./proceduralAssets";
import type { RendererAdapter, RendererStatus } from "./RendererAdapter";
import {
  easeProgress,
  resolveVisualTiming,
  timingForEntity,
  type ResolvedVisualTiming,
} from "./rendererTiming";
import {
  applyObjectVisualEffects,
  restoreObjectVisualEffects,
  visualEffectsFromEnvironment,
  type RenderVisualEffects,
} from "./visualEffects";
import {
  adaptiveClipPlanes,
  cameraDistanceLimits,
  floatingOriginFor,
} from "./infiniteNavigation";

export type ThreeRendererOptions = {
  getSceneState?: () => Readonly<SceneState>;
  onSelectEntity?: (entityId: EntityId | null) => void;
  onActivateEntity?: (entityId: EntityId) => void;
  onAnimationComplete?: (completion: AnimationCompletion) => void;
  onStatus?: (status: RendererStatus) => void;
  pixelRatioCap?: number;
  shadows?: boolean;
  reducedMotion?: boolean;
  assetRegistry?: AssetRegistry;
  gltfAssetLoader?: GltfAssetLoader;
};

type ActiveTween = {
  key?: string;
  startedAt: number;
  durationMs: number;
  easing: ResolvedVisualTiming["easing"];
  update: (progress: number) => void;
  complete?: () => void;
  cancel?: () => void;
};

type PointerOrigin = { x: number; y: number };

const DEFAULT_CAMERA_POSITION = new THREE.Vector3(7.5, 5.2, 8.5);
const DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 0.8, 0);

export class ThreeRenderer implements RendererAdapter {
  private readonly options: ThreeRendererOptions;
  private readonly assets: AssetRegistry;
  private readonly gltfAssets: GltfAssetLoader;
  private container: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private entityLayer = new THREE.Group();
  private environmentRoot: THREE.Group | null = null;
  private readonly fadingEnvironmentRoots = new Set<THREE.Group>();
  private lightingRoot: THREE.Group | null = null;
  private readonly entities = new Map<EntityId, ProceduralEntity>();
  private readonly replacedEntityIds = new Set<EntityId>();
  private currentState: Readonly<SceneState> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private keyboardTarget: HTMLElement | null = null;
  private readonly clock = new THREE.Clock();
  private readonly tweens = new Set<ActiveTween>();
  private selectedEntityId: EntityId | null = null;
  private selectionHelper: THREE.BoxHelper | null = null;
  private pointerOrigin: PointerOrigin | null = null;
  private reducedMotion = false;
  private reducedMotionQuery: MediaQueryList | null = null;
  private disposed = false;
  private lifecycleToken = 0;
  private stateRenderQueue: Promise<void> = Promise.resolve();
  private readonly renderOrigin = new THREE.Vector3();
  private readonly navigationBoundsCenter = DEFAULT_CAMERA_TARGET.clone();
  private navigationBoundsRadius = 2;

  private readonly handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    this.setReducedMotion(event.matches);
  };

  constructor(options: ThreeRendererOptions = {}) {
    this.options = options;
    this.assets = options.assetRegistry ?? DEFAULT_ASSET_REGISTRY;
    this.gltfAssets = options.gltfAssetLoader ?? new GltfAssetLoader();
    this.reducedMotion = options.reducedMotion ?? false;
  }

  async initialize(container: HTMLElement): Promise<void> {
    if (this.renderer) return;
    this.lifecycleToken += 1;
    this.container = container;
    this.disposed = false;
    const view = container.ownerDocument.defaultView;
    this.reducedMotionQuery = this.options.reducedMotion === undefined
      ? view?.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null
      : null;
    this.reducedMotion = this.options.reducedMotion ?? this.reducedMotionQuery?.matches ?? false;
    this.reducedMotionQuery?.addEventListener?.("change", this.handleReducedMotionChange);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe1e5e1);
    this.scene = scene;
    this.entityLayer.name = "scene-entities";
    scene.add(this.entityLayer);

    const camera = new THREE.PerspectiveCamera(44, 1, 0.04, 300);
    camera.position.copy(DEFAULT_CAMERA_POSITION);
    this.camera = camera;

    try {
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        logarithmicDepthBuffer: true,
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = this.options.shadows ?? true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.options.pixelRatioCap ?? 2));
      const containerOwnsKeyboardFocus = container.tabIndex >= 0;
      renderer.domElement.tabIndex = containerOwnsKeyboardFocus ? -1 : 0;
      if (!containerOwnsKeyboardFocus) {
        renderer.domElement.setAttribute("role", "application");
        renderer.domElement.setAttribute(
          "aria-label",
          "3D scene viewport. Drag to orbit, Shift-drag or right-drag to pan, and scroll to zoom. Press F to frame the scene. Double-click an entity, or select it and press Enter, to activate it.",
        );
      }
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      container.appendChild(renderer.domElement);
      this.renderer = renderer;
      this.keyboardTarget = containerOwnsKeyboardFocus ? container : renderer.domElement;

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = !this.reducedMotion;
      controls.dampingFactor = 0.075;
      controls.screenSpacePanning = true;
      const distanceLimits = cameraDistanceLimits(this.navigationBoundsRadius);
      controls.minDistance = distanceLimits.min;
      controls.maxDistance = distanceLimits.max;
      controls.zoomToCursor = true;
      controls.zoomSpeed = 0.9;
      controls.maxPolarAngle = Math.PI * 0.495;
      controls.target.copy(DEFAULT_CAMERA_TARGET);
      controls.update();
      this.controls = controls;

      renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost);
      renderer.domElement.addEventListener("webglcontextrestored", this.handleContextRestored);
      renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
      renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
      renderer.domElement.addEventListener("dblclick", this.handleDoubleClick);
      this.keyboardTarget.addEventListener("keydown", this.handleKeyDown);
      renderer.domElement.addEventListener("contextmenu", this.preventContextMenu);

      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
      }
      this.resize();
      renderer.setAnimationLoop(this.renderFrame);

      const initial = this.options.getSceneState?.();
      if (initial) await this.renderState(initial);
      else {
        this.rebuildEnvironment({ preset: "blank_stage", anchors: {} });
        this.lightingRoot = createLighting(
          { preset: "neutral", exposure: 1 },
          { resolveTarget: () => undefined },
        );
        scene.add(this.lightingRoot);
      }
      this.options.onStatus?.({ kind: "ready" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "WebGL renderer could not initialize.";
      this.options.onStatus?.({ kind: "error", message });
      throw error;
    }
  }

  async renderState(state: Readonly<SceneState>): Promise<void> {
    return this.enqueueStateRender((isCurrent) => this.renderStateNow(state, isCurrent));
  }

  private async renderStateNow(
    state: Readonly<SceneState>,
    isCurrent: () => boolean,
  ): Promise<void> {
    this.requireInitialized();
    this.cancelTweens();
    for (const root of this.entities.values()) disposeObject(root);
    this.entities.clear();
    this.currentState = state;
    this.rebuildEnvironment(state.environment);
    await Promise.all([...state.entities.values()].map((entity) => this.ensureEntity(entity)));
    if (!isCurrent()) return;
    this.reconcileHierarchy(state);
    for (const entity of state.entities.values()) {
      const root = this.entities.get(entity.id);
      if (!root) continue;
      this.applyEntityPresentation(entity, root);
      this.setEntityTransform(root, this.targetTransform(entity), false);
    }
    this.rebuildLighting(state);
    this.refreshNavigationBounds();
    this.applyCameraState(state.activeCamera, undefined, true);
    this.refreshSelectionHelper();
    this.refreshPostProcessing();
  }

  async applyDelta(
    delta: SceneDelta,
    state?: Readonly<SceneState>,
    operations: readonly SceneOperation[] = [],
  ): Promise<void> {
    return this.enqueueStateRender((isCurrent) => this.applyDeltaNow(delta, state, operations, isCurrent));
  }

  private async applyDeltaNow(
    delta: SceneDelta,
    state?: Readonly<SceneState>,
    operations: readonly SceneOperation[] = [],
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    this.requireInitialized();
    this.replacedEntityIds.clear();
    const nextState = state ?? this.options.getSceneState?.();
    if (!nextState) {
      throw new Error("ThreeRenderer.applyDelta requires a SceneState or a getSceneState provider.");
    }
    const previousState = this.currentState;
    this.currentState = nextState;
    if (delta.environmentChanged) {
      const timing = timingForEnvironment(operations, this.reducedMotion);
      if (previousState && timing) {
        this.transitionEnvironment(previousState.environment, nextState.environment, timing);
      } else {
        this.rebuildEnvironment(nextState.environment);
      }
    }

    for (const id of delta.removed) {
      this.cancelTweensForEntity(id);
      const root = this.entities.get(id);
      if (!root) continue;
      if (this.selectedEntityId === id) this.setSelectedEntity(null);
      disposeObject(root);
      this.entities.delete(id);
    }

    await Promise.all(delta.added.map(async (id) => {
      const entity = nextState.entities.get(id);
      if (entity) await this.ensureEntity(entity);
    }));
    // Updated entities may change their authoritative render source (for
    // example an asset ID, or delete/recreate under the same component ID).
    await Promise.all(delta.updated.map(async (id) => {
      const entity = nextState.entities.get(id);
      if (entity) await this.ensureEntity(entity);
    }));
    // Defensive reconciliation also covers repaired/idempotent deltas from external stores.
    await Promise.all([...nextState.entities].map(async ([id, entity]) => {
      if (!this.entities.has(id)) await this.ensureEntity(entity);
    }));
    if (!isCurrent()) return;

    this.reconcileHierarchy(nextState);
    // Replacing a parent render root temporarily detaches managed descendants
    // so their GPU resources are not disposed with the parent. Restore their
    // authoritative local transforms after hierarchy reconciliation.
    if (this.replacedEntityIds.size) {
      for (const entity of nextState.entities.values()) {
        if (!hasReplacedAncestor(entity, nextState, this.replacedEntityIds)) continue;
        const root = this.entities.get(entity.id);
        if (root) this.setEntityTransform(root, this.targetTransform(entity), false);
      }
    }
    const changed = new Set([...delta.added, ...delta.updated]);
    for (const id of changed) {
      this.cancelTweensForEntity(id);
      const entity = nextState.entities.get(id);
      const root = this.entities.get(id);
      if (!entity || !root) continue;
      const timing = timingForEntity(operations, id, this.reducedMotion) ?? {
        startAfterMs: 0,
        durationMs: this.reducedMotion ? 0 : delta.added.includes(id) ? 180 : 220,
        easing: "ease_in_out" as const,
      };
      const previousEntity = previousState?.entities.get(id);
      this.applyEntityPresentation(entity, root, Boolean(previousEntity));
      if (!delta.added.includes(id) && previousEntity) {
        this.transitionEntityVisualEffects(root, previousEntity, entity, timing);
      }
      if (animationGeneration(previousEntity) !== animationGeneration(entity)) {
        root.userData.animationNotBeforeSeconds = this.clock.elapsedTime + timing.startAfterMs / 1_000;
      }
      if (delta.added.includes(id)) {
        const target = this.targetTransform(entity);
        this.setEntityTransform(root, target, false);
        root.visible = isEntityVisuallyPresent(entity);
        const desiredScale = root.scale.clone();
        root.scale.setScalar(0.001);
        this.scheduleTween(timing, (progress) => {
          root.scale.copy(desiredScale).multiplyScalar(progress);
        }, entityTweenKey(id, "transform"));
      } else {
        this.setEntityTransform(root, this.targetTransform(entity), true, timing);
      }
    }

    if (this.selectedEntityId && !isEntityVisuallyPresent(nextState.entities.get(this.selectedEntityId))) {
      this.setSelectedEntity(null);
    }

    if (delta.lightingChanged || delta.environmentChanged) this.rebuildLighting(nextState);
    this.refreshNavigationBounds();
    if (delta.cameraChanged) {
      this.applyCameraState(nextState.activeCamera, undefined, false);
    } else if (changed.size && !this.changedObjectsAreVisible([...changed])) {
      // Auto-frame only when changed content is offscreen.
      this.frameEntityIds([...changed], "medium_wide");
    }
    this.refreshSelectionHelper();
    this.refreshPostProcessing();
  }

  resize(): void {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(
      Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, this.options.pixelRatioCap ?? 2),
    );
    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  frameAll(shot: CameraShot = "wide"): void {
    this.frameEntityIds([...this.entities.keys()], shot);
  }

  resetView(): void {
    if (!this.camera || !this.controls) return;
    this.setRenderOrigin(new THREE.Vector3());
    this.transitionCamera(DEFAULT_CAMERA_POSITION, DEFAULT_CAMERA_TARGET, 44, {
      startAfterMs: 0,
      durationMs: this.reducedMotion ? 0 : 280,
      easing: "ease_in_out",
    });
  }

  getEntityObject(entityId: EntityId): THREE.Object3D | undefined {
    return this.entities.get(entityId);
  }

  /** Read-only camera snapshot used by the DOM projection bridge. */
  getProjectionCameraState(): {
    position: Vec3;
    target: Vec3;
    fovDeg: number;
    near: number;
    far: number;
  } | null {
    if (!this.camera || !this.controls) return null;
    return {
      position: {
        x: this.camera.position.x + this.renderOrigin.x,
        y: this.camera.position.y + this.renderOrigin.y,
        z: this.camera.position.z + this.renderOrigin.z,
      },
      target: {
        x: this.controls.target.x + this.renderOrigin.x,
        y: this.controls.target.y + this.renderOrigin.y,
        z: this.controls.target.z + this.renderOrigin.z,
      },
      fovDeg: this.camera.fov,
      near: this.camera.near,
      far: this.camera.far,
    };
  }

  /** Magnification greater than one moves closer; less than one moves away. */
  zoomBy(magnification: number): void {
    if (!this.camera || !this.controls || !Number.isFinite(magnification) || magnification <= 0) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const limits = cameraDistanceLimits(this.navigationBoundsRadius);
    const distance = THREE.MathUtils.clamp(offset.length() / magnification, limits.min, limits.max);
    if (offset.lengthSq() < 1e-20) offset.set(0.65, 0.42, 0.65);
    offset.setLength(distance);
    this.camera.position.copy(this.controls.target).add(offset);
    this.updateAdaptiveClipping();
    this.controls.update();
  }

  setSelectedEntity(entityId: EntityId | null, notify = true): void {
    if (entityId !== null && (!this.entities.has(entityId)
      || !isEntityVisuallyPresent(this.currentState?.entities.get(entityId)))) entityId = null;
    this.selectedEntityId = entityId;
    this.refreshSelectionHelper();
    if (notify) this.options.onSelectEntity?.(entityId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleToken += 1;
    this.cancelTweens();
    this.reducedMotionQuery?.removeEventListener?.("change", this.handleReducedMotionChange);
    this.reducedMotionQuery = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose();
    this.controls = null;
    if (this.renderer) {
      const canvas = this.renderer.domElement;
      canvas.removeEventListener("webglcontextlost", this.handleContextLost);
      canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
      canvas.removeEventListener("pointerdown", this.handlePointerDown);
      canvas.removeEventListener("pointerup", this.handlePointerUp);
      canvas.removeEventListener("dblclick", this.handleDoubleClick);
      this.keyboardTarget?.removeEventListener("keydown", this.handleKeyDown);
      canvas.removeEventListener("contextmenu", this.preventContextMenu);
      this.renderer.setAnimationLoop(null);
    }
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    for (const root of this.entities.values()) disposeObject(root);
    this.entities.clear();
    if (this.environmentRoot) disposeObject(this.environmentRoot);
    this.fadingEnvironmentRoots.clear();
    if (this.lightingRoot) disposeObject(this.lightingRoot);
    this.selectionHelper?.geometry.dispose();
    const helperMaterial = this.selectionHelper?.material;
    if (Array.isArray(helperMaterial)) helperMaterial.forEach((entry) => entry.dispose());
    else helperMaterial?.dispose();
    this.selectionHelper?.removeFromParent();
    this.selectionHelper = null;
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.container = null;
    this.keyboardTarget = null;
    this.currentState = null;
    this.gltfAssets.clear();
    this.renderOrigin.set(0, 0, 0);
    this.entityLayer.position.set(0, 0, 0);
    this.navigationBoundsCenter.copy(DEFAULT_CAMERA_TARGET);
    this.navigationBoundsRadius = 2;
  }

  private setReducedMotion(reduced: boolean): void {
    if (this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    if (this.controls) {
      this.controls.enableDamping = !reduced;
      this.controls.update();
    }
    if (!reduced) return;
    // A preference change is an instruction to stop interpolating now. Finish
    // every visual at its committed destination without creating semantic
    // Workspace revisions.
    for (const tween of [...this.tweens]) {
      tween.update(1);
      tween.complete?.();
      this.tweens.delete(tween);
    }
  }

  private requireInitialized(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.controls) {
      throw new Error("ThreeRenderer must be initialized before rendering scene state.");
    }
  }

  private enqueueStateRender(task: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const lifecycleToken = this.lifecycleToken;
    const isCurrent = () => !this.disposed && lifecycleToken === this.lifecycleToken;
    const queued = this.stateRenderQueue.then(async () => {
      if (!isCurrent()) return;
      await task(isCurrent);
    });
    this.stateRenderQueue = queued.catch(() => undefined);
    return queued;
  }

  private async ensureEntity(entity: EntityState): Promise<ProceduralEntity> {
    const existing = this.entities.get(entity.id);
    const identity = entityRenderIdentity(entity);
    if (existing?.userData.renderIdentity === identity) return existing;
    if (existing) {
      // A managed child may be parented under this root. Detach every managed
      // descendant before disposal so replacement never destroys another
      // component's geometry or animation state.
      for (const [otherId, otherRoot] of this.entities) {
        if (otherId === entity.id || !isObjectDescendantOf(otherRoot, existing)) continue;
        this.entityLayer.add(otherRoot);
      }
      if (this.selectedEntityId === entity.id) this.selectionHelper?.removeFromParent();
      disposeObject(existing);
      this.entities.delete(entity.id);
      this.replacedEntityIds.add(entity.id);
    }
    const record = this.assets.get(entity.assetId);
    let root: ProceduralEntity;
    if (record?.source === "bundled" && record.runtime) {
      try {
        root = await this.gltfAssets.instantiate(record, entity);
      } catch (error) {
        root = createProceduralEntity(entity);
        const reason = error instanceof Error ? error.message : "unknown asset loading error";
        this.options.onStatus?.({
          kind: "asset-fallback",
          assetId: entity.assetId,
          note: {
            code: "asset_load_failed",
            entityId: entity.id,
            message: `Could not load ${record.displayName}; a deterministic ${entity.kind} stand-in is shown. ${reason}`,
          },
        });
      }
    } else {
      root = createProceduralEntity(entity);
    }
    if (this.disposed) {
      disposeObject(root);
      return root;
    }
    root.userData.renderIdentity = identity;
    this.entityLayer.add(root);
    this.entities.set(entity.id, root);
    return root;
  }

  private applyEntityPresentation(
    entity: EntityState,
    root: ProceduralEntity,
    deferVisibility = false,
  ): void {
    root.userData.label = entity.label;
    root.userData.assetId = entity.assetId;
    root.userData.kind = entity.kind;
    root.userData.locked = entity.locked;
    restoreObjectVisualEffects(root);
    applyEntityAppearance(entity, root);
    applyEntityState(entity, root);
    applyObjectVisualEffects(root, {
      opacity: entity.appearance.opacity ?? 1,
      emissiveColor: entity.appearance.emissiveColor ?? "#FFFFFF",
      emissiveIntensity: entity.appearance.emissiveIntensity ?? 0,
      glowColor: entity.appearance.glowColor ?? "#68D5FF",
      glowIntensity: entity.appearance.glowIntensity ?? 0,
      glowSpread: entity.appearance.glowSpread ?? 0.5,
    });
    if (!deferVisibility) root.visible = isEntityVisuallyPresent(entity);
  }

  private transitionEntityVisualEffects(
    root: ProceduralEntity,
    previous: EntityState,
    next: EntityState,
    timing: ResolvedVisualTiming,
  ): void {
    const from = entityVisualEffects(previous);
    const to = entityVisualEffects(next);
    if (visualEffectsEqual(from, to) || (timing.durationMs === 0 && timing.startAfterMs === 0)) {
      applyObjectVisualEffects(root, to);
      root.visible = isEntityVisuallyPresent(next);
      return;
    }
    root.visible = entityHasEnabledState(next) && (from.opacity > 0.001 || to.opacity > 0.001);
    applyObjectVisualEffects(root, from);
    this.scheduleTween(timing, (progress) => {
      applyObjectVisualEffects(root, interpolateVisualEffects(from, to, progress));
    }, entityTweenKey(next.id, "effects"), () => {
      root.visible = isEntityVisuallyPresent(next);
    });
  }

  private reconcileHierarchy(state: Readonly<SceneState>): void {
    for (const entity of state.entities.values()) {
      const root = this.entities.get(entity.id);
      if (!root) continue;
      const parent = entity.parentId ? this.entities.get(entity.parentId) : undefined;
      const desiredParent = parent ? findSocket(parent, entity.parentSocket) : this.entityLayer;
      if (root.parent !== desiredParent) reparentPreservingWorldTransform(root, desiredParent);
    }
  }

  private targetTransform(entity: EntityState): Transform {
    // Workspace world3d placement is local to parent when parentId is set.
    // Applying the persisted position here keeps rendering identical to the
    // SemaFrame Spatial Graph world-transform composition and collision index.
    return entity.transform;
  }

  private setEntityTransform(
    root: THREE.Object3D,
    transform: Transform,
    animated: boolean,
    timing?: ResolvedVisualTiming,
  ): void {
    const targetPosition = vector(transform.position);
    const targetScale = vector(transform.scale);
    const targetQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z, "XYZ"),
    );
    if (!timing || !shouldScheduleTransformTween(animated, timing)) {
      root.position.copy(targetPosition);
      root.scale.copy(targetScale);
      root.quaternion.copy(targetQuaternion);
      return;
    }
    const startPosition = root.position.clone();
    const startScale = root.scale.clone();
    const startQuaternion = root.quaternion.clone();
    this.scheduleTween(timing, (progress) => {
      root.position.lerpVectors(startPosition, targetPosition, progress);
      root.scale.lerpVectors(startScale, targetScale, progress);
      root.quaternion.slerpQuaternions(startQuaternion, targetQuaternion, progress);
    }, typeof root.userData.entityId === "string"
      ? entityTweenKey(root.userData.entityId, "transform")
      : undefined);
  }

  private rebuildEnvironment(environment: SceneState["environment"]): void {
    if (!this.scene) return;
    this.cancelTween("environment");
    if (this.environmentRoot) disposeObject(this.environmentRoot);
    const built = createEnvironment(environment);
    this.environmentRoot = built.root;
    this.environmentRoot.position.copy(this.renderOrigin).multiplyScalar(-1);
    applyObjectVisualEffects(built.root, visualEffectsFromEnvironment(environment.properties));
    this.scene.add(built.root);
    this.scene.background = built.background;
    this.scene.fog = built.fog ?? null;
  }

  private transitionEnvironment(
    previous: SceneState["environment"],
    next: SceneState["environment"],
    timing: ResolvedVisualTiming,
  ): void {
    if (!this.scene || !this.environmentRoot
      || (timing.durationMs === 0 && timing.startAfterMs === 0)) {
      this.rebuildEnvironment(next);
      return;
    }
    const oldRoot = this.environmentRoot;
    this.fadingEnvironmentRoots.add(oldRoot);
    const oldEffects = visualEffectsFromEnvironment(previous.properties);
    const nextEffects = visualEffectsFromEnvironment(next.properties);
    const transparentOld = { ...oldEffects, opacity: 0, emissiveIntensity: 0, glowIntensity: 0 };
    const transparentNext = { ...nextEffects, opacity: 0, emissiveIntensity: 0, glowIntensity: 0 };
    const oldBackground = this.scene.background instanceof THREE.Color
      ? this.scene.background.clone()
      : null;
    const built = createEnvironment(next);
    const nextRoot = built.root;
    nextRoot.position.copy(this.renderOrigin).multiplyScalar(-1);
    applyObjectVisualEffects(nextRoot, transparentNext);
    this.scene.add(nextRoot);
    this.environmentRoot = nextRoot;
    this.scene.fog = built.fog ?? null;

    const disposeOld = () => {
      this.fadingEnvironmentRoots.delete(oldRoot);
      if (oldRoot.parent) disposeObject(oldRoot);
    };
    this.scheduleTween(timing, (progress) => {
      applyObjectVisualEffects(oldRoot, interpolateVisualEffects(oldEffects, transparentOld, progress));
      applyObjectVisualEffects(nextRoot, interpolateVisualEffects(transparentNext, nextEffects, progress));
      if (oldBackground && built.background instanceof THREE.Color && this.scene) {
        this.scene.background = oldBackground.clone().lerp(built.background, progress);
      }
    }, "environment", () => {
      if (this.scene) this.scene.background = built.background;
      disposeOld();
    }, disposeOld);
  }

  private rebuildLighting(state: Readonly<SceneState>): void {
    if (!this.scene || !this.renderer) return;
    if (this.lightingRoot) disposeObject(this.lightingRoot);
    this.lightingRoot = createLighting(state.lighting, {
      resolveTarget: (id) => {
        const rendered = this.worldPositionForEntity(id);
        return rendered?.add(this.renderOrigin);
      },
    });
    this.lightingRoot.position.copy(this.renderOrigin).multiplyScalar(-1);
    this.scene.add(this.lightingRoot);
    this.renderer.toneMappingExposure = state.lighting.exposure ?? 1;
  }

  private applyCameraState(
    state: CameraState,
    timing?: ResolvedVisualTiming,
    immediate = false,
  ): void {
    const semanticTarget =
      typeof state.target === "string"
        ? this.worldPositionForEntity(state.target)?.add(this.renderOrigin) ?? DEFAULT_CAMERA_TARGET.clone()
        : vector(state.target);
    this.ensureFloatingOriginNear(semanticTarget);
    const target = semanticTarget.clone().sub(this.renderOrigin);
    const position = vector(state.position).sub(this.renderOrigin);
    this.transitionCamera(
      position,
      target,
      state.fovDeg,
      immediate
        ? { startAfterMs: 0, durationMs: 0, easing: "linear" }
        : timing ?? {
            startAfterMs: 0,
            durationMs: this.reducedMotion ? 0 : 300,
            easing: "ease_in_out",
          },
    );
  }

  private frameEntityIds(
    ids: readonly EntityId[],
    shot: CameraShot,
    timing: ResolvedVisualTiming = {
      startAfterMs: 0,
      durationMs: this.reducedMotion ? 0 : 280,
      easing: "ease_in_out",
    },
  ): void {
    if (!this.camera || !this.controls) return;
    const bounds = new THREE.Box3();
    let hasBounds = false;
    // Camera intent is evaluated against the committed semantic state, not an
    // in-progress spawn/move tween. Otherwise a just-created object scaled
    // from zero produces a near-zero bound and an accidental extreme close-up.
    const savedTransforms: Array<{
      object: THREE.Object3D;
      position: THREE.Vector3;
      scale: THREE.Vector3;
      quaternion: THREE.Quaternion;
    }> = [];
    for (const id of ids) {
      const object = this.entities.get(id);
      const entity = this.currentState?.entities.get(id);
      if (!object || !entity) continue;
      savedTransforms.push({
        object,
        position: object.position.clone(),
        scale: object.scale.clone(),
        quaternion: object.quaternion.clone(),
      });
      const transform = this.targetTransform(entity);
      object.position.copy(vector(transform.position));
      object.scale.copy(vector(transform.scale));
      object.quaternion.setFromEuler(
        new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z, "XYZ"),
      );
    }
    for (const id of ids) {
      const object = this.entities.get(id);
      if (!object || !object.visible) continue;
      object.updateWorldMatrix(true, true);
      const objectBounds = new THREE.Box3().setFromObject(object);
      if (objectBounds.isEmpty()) continue;
      bounds.union(objectBounds);
      hasBounds = true;
    }
    for (const saved of savedTransforms) {
      saved.object.position.copy(saved.position);
      saved.object.scale.copy(saved.scale);
      saved.object.quaternion.copy(saved.quaternion);
      saved.object.updateWorldMatrix(true, true);
    }
    if (!hasBounds) {
      bounds.setFromCenterAndSize(
        DEFAULT_CAMERA_TARGET.clone().sub(this.renderOrigin),
        new THREE.Vector3(4, 2, 4),
      );
    }
    const semanticCenter = bounds.getCenter(new THREE.Vector3()).add(this.renderOrigin);
    this.ensureFloatingOriginNear(semanticCenter);
    const center = semanticCenter.clone().sub(this.renderOrigin);
    const size = bounds.getSize(new THREE.Vector3());
    const shotFactor: Record<CameraShot, number> = {
      wide: 1.8,
      medium_wide: 1.42,
      medium: 1.12,
      close_up: 0.78,
      overhead: 1.35,
    };
    const radius = Math.max(0.7, size.length() * 0.5);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = Math.max(
      cameraDistanceLimits(this.navigationBoundsRadius).min,
      (radius / Math.sin(fov / 2)) * shotFactor[shot],
    );
    let direction: THREE.Vector3;
    if (shot === "overhead") direction = new THREE.Vector3(0.12, 1, 0.12).normalize();
    else {
      direction = this.camera.position.clone().sub(this.controls.target).normalize();
      if (direction.lengthSq() < 0.01) direction.set(0.65, 0.42, 0.65).normalize();
      direction.y = Math.max(0.22, direction.y);
      direction.normalize();
    }
    this.transitionCamera(center.clone().addScaledVector(direction, distance), center, this.camera.fov, timing);
  }

  private transitionCamera(
    destination: THREE.Vector3,
    target: THREE.Vector3,
    fov: number,
    timing: ResolvedVisualTiming,
  ): void {
    if (!this.camera || !this.controls) return;
    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startFov = this.camera.fov;
    const update = (progress: number) => {
      if (!this.camera || !this.controls) return;
      this.camera.position.lerpVectors(startPosition, destination, progress);
      this.controls.target.lerpVectors(startTarget, target, progress);
      this.camera.fov = THREE.MathUtils.lerp(startFov, fov, progress);
      this.updateAdaptiveClipping();
      this.camera.updateProjectionMatrix();
      this.controls.update();
    };
    this.scheduleTween(timing, update, "camera");
  }

  private changedObjectsAreVisible(ids: readonly EntityId[]): boolean {
    if (!this.camera || !ids.length) return true;
    this.camera.updateMatrixWorld();
    const projection = new THREE.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projection);
    for (const id of ids) {
      const object = this.entities.get(id);
      if (!object || !object.visible) continue;
      object.updateWorldMatrix(true, true);
      if (!frustum.intersectsBox(new THREE.Box3().setFromObject(object))) return false;
    }
    return true;
  }

  private worldPositionForEntity(id: EntityId): THREE.Vector3 | undefined {
    const object = this.entities.get(id);
    if (!object) return undefined;
    object.updateWorldMatrix(true, false);
    return new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  }

  private refreshNavigationBounds(): void {
    const bounds = new THREE.Box3();
    let hasBounds = false;
    for (const object of [this.environmentRoot, this.entityLayer]) {
      if (!object || !object.visible) continue;
      object.updateWorldMatrix(true, true);
      const objectBounds = new THREE.Box3().setFromObject(object);
      if (objectBounds.isEmpty()) continue;
      bounds.union(objectBounds);
      hasBounds = true;
    }
    if (!hasBounds) {
      this.navigationBoundsCenter.copy(DEFAULT_CAMERA_TARGET);
      this.navigationBoundsRadius = 2;
    } else {
      bounds.getCenter(this.navigationBoundsCenter).add(this.renderOrigin);
      this.navigationBoundsRadius = Math.max(1e-6, bounds.getSize(new THREE.Vector3()).length() * 0.5);
    }
    if (this.controls) {
      const limits = cameraDistanceLimits(this.navigationBoundsRadius);
      this.controls.minDistance = limits.min;
      this.controls.maxDistance = limits.max;
    }
    this.updateAdaptiveClipping();
  }

  private ensureFloatingOriginNear(semanticTarget: THREE.Vector3): void {
    const next = floatingOriginFor(semanticTarget, this.renderOrigin);
    if (next) this.setRenderOrigin(next);
  }

  private setRenderOrigin(next: THREE.Vector3): void {
    if (next.equals(this.renderOrigin)) return;
    const delta = next.clone().sub(this.renderOrigin);
    this.camera?.position.sub(delta);
    this.controls?.target.sub(delta);
    this.renderOrigin.copy(next);
    const renderedOrigin = next.clone().multiplyScalar(-1);
    this.entityLayer.position.copy(renderedOrigin);
    this.environmentRoot?.position.copy(renderedOrigin);
    for (const root of this.fadingEnvironmentRoots) root.position.copy(renderedOrigin);
    this.lightingRoot?.position.copy(renderedOrigin);
    this.selectionHelper?.update();
  }

  private rebaseFromLiveTarget(): void {
    if (!this.controls) return;
    const semanticTarget = this.controls.target.clone().add(this.renderOrigin);
    this.ensureFloatingOriginNear(semanticTarget);
  }

  private updateAdaptiveClipping(): void {
    if (!this.camera || !this.controls) return;
    const cameraDistance = this.camera.position.distanceTo(this.controls.target);
    const semanticCamera = this.camera.position.clone().add(this.renderOrigin);
    const planes = adaptiveClipPlanes(
      cameraDistance,
      semanticCamera.distanceTo(this.navigationBoundsCenter),
      this.navigationBoundsRadius,
    );
    const changed = relativeDifference(this.camera.near, planes.near) > 0.01
      || relativeDifference(this.camera.far, planes.far) > 0.01;
    if (!changed) return;
    this.camera.near = planes.near;
    this.camera.far = planes.far;
    this.camera.updateProjectionMatrix();
  }

  private scheduleTween(
    timing: ResolvedVisualTiming,
    update: (progress: number) => void,
    key?: string,
    complete?: () => void,
    cancel?: () => void,
  ): void {
    if (key) this.cancelTween(key);
    if (timing.durationMs === 0 && timing.startAfterMs === 0) {
      update(1);
      complete?.();
      return;
    }
    this.tweens.add({
      ...(key ? { key } : {}),
      startedAt: performance.now() + timing.startAfterMs,
      durationMs: timing.durationMs,
      easing: timing.easing,
      update,
      ...(complete ? { complete } : {}),
      ...(cancel ? { cancel } : {}),
    });
  }

  private cancelTweens(): void {
    for (const tween of this.tweens) tween.cancel?.();
    this.tweens.clear();
  }

  private cancelTween(key: string): void {
    for (const tween of this.tweens) {
      if (tween.key !== key) continue;
      tween.cancel?.();
      this.tweens.delete(tween);
    }
  }

  private cancelTweensForEntity(entityId: EntityId): void {
    const prefix = `entity:${entityId}:`;
    for (const tween of this.tweens) {
      if (tween.key?.startsWith(prefix)) {
        tween.cancel?.();
        this.tweens.delete(tween);
      }
    }
  }

  private renderFrame = (time: number): void => {
    if (!this.renderer || !this.scene || !this.camera || !this.controls || this.disposed) return;
    for (const tween of [...this.tweens]) {
      if (time < tween.startedAt) continue;
      const rawProgress = tween.durationMs === 0 ? 1 : (time - tween.startedAt) / tween.durationMs;
      const progress = easeProgress(rawProgress, tween.easing);
      tween.update(progress);
      if (rawProgress >= 1) {
        this.tweens.delete(tween);
        tween.complete?.();
      }
    }
    const deltaSeconds = Math.min(0.1, this.clock.getDelta());
    const elapsed = this.clock.elapsedTime;
    if (this.currentState) {
      for (const [id, root] of this.entities) {
        const entity = this.currentState.entities.get(id);
        if (entity) {
          const notBefore = typeof root.userData.animationNotBeforeSeconds === "number"
            ? root.userData.animationNotBeforeSeconds
            : 0;
          const paused = elapsed < notBefore;
          if (!paused && notBefore > 0) delete root.userData.animationNotBeforeSeconds;
          updateEntityAnimation(
            entity,
            root,
            elapsed,
            deltaSeconds,
            this.reducedMotion,
            (completion) => this.options.onAnimationComplete?.(completion),
            paused,
          );
        }
      }
    }
    this.controls.update();
    this.rebaseFromLiveTarget();
    this.updateAdaptiveClipping();
    this.selectionHelper?.update();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  };

  private refreshPostProcessing(): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    const values = [
      ...[...(this.currentState?.entities.values() ?? [])].map((entity) => ({
        intensity: entity.appearance.glowIntensity ?? 0,
        spread: entity.appearance.glowSpread ?? 0.5,
      })),
      {
        intensity: Number(this.currentState?.environment.properties?.workspaceGlowIntensity ?? 0),
        spread: Number(this.currentState?.environment.properties?.workspaceGlowSpread ?? 0.5),
      },
    ];
    const semanticIntensity = Math.max(0, ...values.map((value) => value.intensity));
    // UnrealBloomPass strengths above ~1.5 quickly wash an entire room even
    // when the emitting material is the only threshold-qualified surface.
    // The stored 0–4 semantic range therefore maps to a perceptual renderer
    // range while remaining monotonic and reaching a deliberately strong max.
    const strength = Math.min(1.5, semanticIntensity * 0.45);
    if (strength <= 0) {
      this.composer?.dispose();
      this.composer = null;
      this.bloomPass = null;
      return;
    }
    if (!this.composer) {
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), strength, 0.5, 0.92);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      this.composer = composer;
      this.bloomPass = bloom;
      this.resize();
    }
    if (this.bloomPass) {
      this.bloomPass.strength = strength;
      this.bloomPass.radius = THREE.MathUtils.clamp(
        Math.max(...values.filter((value) => value.intensity > 0).map((value) => value.spread)),
        0,
        1,
      );
      this.bloomPass.threshold = 0.92;
    }
  }

  private refreshSelectionHelper(): void {
    this.selectionHelper?.geometry.dispose();
    const oldMaterial = this.selectionHelper?.material;
    if (Array.isArray(oldMaterial)) oldMaterial.forEach((entry) => entry.dispose());
    else oldMaterial?.dispose();
    this.selectionHelper?.removeFromParent();
    this.selectionHelper = null;
    if (!this.scene || !this.selectedEntityId) return;
    const root = this.entities.get(this.selectedEntityId);
    if (!root || !root.visible
      || !isEntityVisuallyPresent(this.currentState?.entities.get(this.selectedEntityId))) return;
    const helper = new THREE.BoxHelper(root, 0xe49a61);
    helper.name = "selection-outline";
    helper.raycast = () => undefined;
    this.scene.add(helper);
    this.selectionHelper = helper;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.keyboardTarget?.focus({ preventScroll: true });
    this.pointerOrigin = { x: event.clientX, y: event.clientY };
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.pointerOrigin) return;
    const distance = Math.hypot(event.clientX - this.pointerOrigin.x, event.clientY - this.pointerOrigin.y);
    this.pointerOrigin = null;
    if (distance > 5 || event.button !== 0) return;
    this.setSelectedEntity(this.entityIdAtPointer(event) ?? null);
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const id = this.entityIdAtPointer(event);
    if (id) this.options.onActivateEntity?.(id);
  };

  private entityIdAtPointer(event: MouseEvent | PointerEvent): EntityId | undefined {
    if (!this.renderer || !this.camera) return undefined;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const interactiveRoots = [...this.entities].flatMap(([id, root]) => root.visible
      && isEntityVisuallyPresent(this.currentState?.entities.get(id))
      ? [root]
      : []);
    const intersections = raycaster.intersectObjects(interactiveRoots, true);
    const id = intersections.find((entry) => typeof entry.object.userData.entityId === "string")?.object.userData
      .entityId as EntityId | undefined;
    return id;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.camera || !this.controls) return;
    const key = event.key.toLowerCase();
    if ((key === "enter" || key === " ") && this.selectedEntityId) {
      event.preventDefault();
      this.options.onActivateEntity?.(this.selectedEntityId);
      return;
    }
    if (key === "f") {
      event.preventDefault();
      this.frameAll();
      return;
    }
    if (key === "+" || key === "=" || key === "-" || key === "_") {
      event.preventDefault();
      this.zoomBy(key === "-" || key === "_" ? 1 / 1.14 : 1 / 0.86);
      return;
    }
    if (!key.startsWith("arrow")) return;
    event.preventDefault();
    if (event.shiftKey) {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const amount = Math.max(1e-6, this.camera.position.distanceTo(this.controls.target) * 0.03);
      const move = new THREE.Vector3();
      if (key === "arrowleft") move.addScaledVector(right, -amount);
      if (key === "arrowright") move.addScaledVector(right, amount);
      if (key === "arrowup") move.addScaledVector(up, amount);
      if (key === "arrowdown") move.addScaledVector(up, -amount);
      this.camera.position.add(move);
      this.controls.target.add(move);
    } else {
      const offset = this.camera.position.clone().sub(this.controls.target);
      if (key === "arrowleft" || key === "arrowright") {
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), key === "arrowleft" ? 0.08 : -0.08);
      } else {
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.phi = THREE.MathUtils.clamp(
          spherical.phi + (key === "arrowup" ? -0.07 : 0.07),
          0.08,
          Math.PI * 0.49,
        );
        offset.setFromSpherical(spherical);
      }
      this.camera.position.copy(this.controls.target).add(offset);
    }
    this.controls.update();
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.options.onStatus?.({ kind: "context-lost" });
  };

  private handleContextRestored = (): void => {
    this.options.onStatus?.({ kind: "context-restored" });
    if (this.currentState) void this.renderState(this.currentState);
  };

  private preventContextMenu = (event: Event): void => event.preventDefault();
}

function entityRenderIdentity(entity: EntityState): string {
  if (entity.renderGeometry?.kind === "assembly") return "assembly";
  if (entity.renderGeometry?.kind === "parametric") return "parametric";
  return `asset:${entity.kind}:${entity.assetId}`;
}

function isObjectDescendantOf(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let current = object.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function hasReplacedAncestor(
  entity: EntityState,
  state: Readonly<SceneState>,
  replaced: ReadonlySet<EntityId>,
): boolean {
  let parentId = entity.parentId;
  const visited = new Set<EntityId>();
  while (parentId && !visited.has(parentId)) {
    if (replaced.has(parentId)) return true;
    visited.add(parentId);
    parentId = state.entities.get(parentId)?.parentId;
  }
  return false;
}

function vector(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}

export function reparentPreservingWorldTransform(
  object: THREE.Object3D,
  parent: THREE.Object3D,
): void {
  object.updateWorldMatrix(true, false);
  parent.updateWorldMatrix(true, false);
  parent.attach(object);
  object.updateWorldMatrix(false, true);
}

export function shouldScheduleTransformTween(
  animated: boolean,
  timing: ResolvedVisualTiming | undefined,
): boolean {
  return animated && Boolean(timing)
    && ((timing?.durationMs ?? 0) > 0 || (timing?.startAfterMs ?? 0) > 0);
}

function timingForEnvironment(
  operations: readonly SceneOperation[],
  reducedMotion: boolean,
): ResolvedVisualTiming | undefined {
  const operation = [...operations].reverse().find((candidate) => candidate.op === "set_environment");
  return operation ? resolveVisualTiming(operation, reducedMotion) : undefined;
}

function entityHasEnabledState(entity: EntityState | undefined): boolean {
  if (!entity) return false;
  if (entity.state.type === "prop") return entity.state.visible !== false;
  if (entity.state.type === "effect") return entity.state.enabled;
  if (entity.state.type === "generic") return entity.state.properties?.visible !== false;
  return true;
}

export function isEntityVisuallyPresent(entity: EntityState | undefined): boolean {
  return entityHasEnabledState(entity) && (entity?.appearance.opacity ?? 1) > 0.001;
}

function animationGeneration(entity: EntityState | undefined): number | undefined {
  if (entity?.state.type !== "character" && entity?.state.type !== "effect") return undefined;
  return entity.state.animationGeneration;
}

function relativeDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(1e-12, Math.abs(left), Math.abs(right));
}

function entityTweenKey(entityId: EntityId, lane: "transform" | "effects"): string {
  return `entity:${entityId}:${lane}`;
}

function entityVisualEffects(entity: EntityState): RenderVisualEffects {
  return {
    opacity: entity.appearance.opacity ?? 1,
    emissiveColor: entity.appearance.emissiveColor ?? "#FFFFFF",
    emissiveIntensity: entity.appearance.emissiveIntensity ?? 0,
    glowColor: entity.appearance.glowColor ?? "#68D5FF",
    glowIntensity: entity.appearance.glowIntensity ?? 0,
    glowSpread: entity.appearance.glowSpread ?? 0.5,
  };
}

function interpolateVisualEffects(
  from: RenderVisualEffects,
  to: RenderVisualEffects,
  progress: number,
): RenderVisualEffects {
  return {
    opacity: THREE.MathUtils.lerp(from.opacity, to.opacity, progress),
    emissiveColor: interpolateColor(from.emissiveColor, to.emissiveColor, progress),
    emissiveIntensity: THREE.MathUtils.lerp(from.emissiveIntensity, to.emissiveIntensity, progress),
    glowColor: interpolateColor(from.glowColor, to.glowColor, progress),
    glowIntensity: THREE.MathUtils.lerp(from.glowIntensity, to.glowIntensity, progress),
    glowSpread: THREE.MathUtils.lerp(from.glowSpread, to.glowSpread, progress),
  };
}

function interpolateColor(from: string, to: string, progress: number): string {
  return `#${new THREE.Color(from).lerp(new THREE.Color(to), progress).getHexString().toUpperCase()}`;
}

function visualEffectsEqual(left: RenderVisualEffects, right: RenderVisualEffects): boolean {
  return left.opacity === right.opacity
    && left.emissiveColor === right.emissiveColor
    && left.emissiveIntensity === right.emissiveIntensity
    && left.glowColor === right.glowColor
    && left.glowIntensity === right.glowIntensity
    && left.glowSpread === right.glowSpread;
}
