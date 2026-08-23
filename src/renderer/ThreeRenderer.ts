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
import {
  RealitySplatRuntime,
  type RealityMeasurementEvent,
  type RealityMeasurementPoint,
  type RealitySplatInstanceDescriptor,
} from "./reality";
import {
  createCadWorkerKernel,
  type CadKernel,
} from "../workspace/modeling";
import type { CadPartEvaluationResultV1 } from "../workspace/modeling/cad";

export type ThreeRendererOptions = {
  getSceneState?: () => Readonly<SceneState>;
  onSelectEntity?: (entityId: EntityId | null) => void;
  onActivateEntity?: (entityId: EntityId) => void;
  onRealityMeasurement?: (event: RealityMeasurementEvent) => void;
  onAnimationComplete?: (completion: AnimationCompletion) => void;
  onStatus?: (status: RendererStatus) => void;
  pixelRatioCap?: number;
  shadows?: boolean;
  reducedMotion?: boolean;
  assetRegistry?: AssetRegistry;
  gltfAssetLoader?: GltfAssetLoader;
  /** Host-owned immutable byte provider. Undefined means Reality layers render as placeholders. */
  openRealityAsset?: (
    assetId: string,
    digest: string,
    signal?: AbortSignal,
  ) => Promise<Blob | Uint8Array | ArrayBuffer | undefined>;
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

type PointerOrigin = { x: number; y: number; pointerId: number };

type RealityMeasurementSession = {
  componentId: EntityId;
  assetId: string;
  assetDigest: string;
  sessionId: number;
  points: RealityMeasurementPoint[];
  complete: boolean;
};

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
  private realityRuntime: RealitySplatRuntime | null = null;
  private readonly realityLoads = new Map<EntityId, AbortController>();
  private cadKernelPromise: Promise<CadKernel> | null = null;
  private readonly cadEvaluationCache = new Map<string, Promise<CadPartEvaluationResultV1>>();
  private realityMeasurementSession: RealityMeasurementSession | null = null;
  private realityMeasurementOverlay: THREE.Group | null = null;
  private realityMeasurementSequence = 0;

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
      this.realityRuntime = new RealitySplatRuntime({
        renderer,
        scene,
        onStatus: (status) => {
          if (status.kind !== "error") return;
          this.options.onStatus?.({
            kind: "asset-fallback",
            assetId: status.instanceId ?? "reality-asset",
            note: {
              code: "asset_load_failed",
              entityId: status.instanceId ?? "reality-asset",
              message: status.message,
            },
          });
        },
      });
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
      renderer.domElement.addEventListener("pointercancel", this.handlePointerCancel);
      renderer.domElement.addEventListener("lostpointercapture", this.handleLostPointerCapture);
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
    this.clearRealityMeasurement(false);
    this.cancelTweens();
    for (const [id, root] of this.entities) this.disposeManagedEntity(id, root);
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
    const measurement = this.realityMeasurementSession;
    if (measurement) {
      const changedSpatialIds = new Set<EntityId>([...delta.removed, ...delta.updated]);
      let currentId: EntityId | undefined = measurement.componentId;
      while (currentId) {
        if (changedSpatialIds.has(currentId)) {
          this.cancelRealityMeasurement();
          break;
        }
        currentId = nextState.entities.get(currentId)?.parentId;
      }
    }
    if (delta.environmentChanged) {
      const timing = timingForEnvironment(operations, this.reducedMotion);
      if (previousState && timing) {
        this.transitionEnvironment(previousState.environment, nextState.environment, timing);
      } else {
        this.rebuildEnvironment(nextState.environment);
      }
    }

    for (const id of delta.removed) {
      if (this.realityMeasurementSession?.componentId === id) this.cancelRealityMeasurement();
      this.cancelTweensForEntity(id);
      const root = this.entities.get(id);
      if (this.selectedEntityId === id) this.setSelectedEntity(null);
      if (root) this.disposeManagedEntity(id, root);
      else {
        this.realityLoads.get(id)?.abort();
        this.realityLoads.delete(id);
        // A loaded Reality root is deliberately absent from `entities` while
        // its WebGL resources are being restored. Removal must still cancel the
        // addressable restore record so stale geometry cannot be resurrected.
        this.realityRuntime?.remove(id);
      }
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
    if (this.realityMeasurementSession && this.realityMeasurementSession.componentId !== entityId) {
      this.cancelRealityMeasurement();
    }
    this.selectedEntityId = entityId;
    for (const id of this.realityRuntime?.snapshot().instanceIds ?? []) {
      this.realityRuntime?.setSelected(id, id === entityId);
    }
    this.refreshSelectionHelper();
    if (notify) this.options.onSelectEntity?.(entityId);
  }

  /** Begin an ephemeral two-point measurement against one loaded Reality layer. */
  startRealityMeasurement(entityId: EntityId): boolean {
    const entity = this.currentState?.entities.get(entityId);
    if (!this.renderer || !this.scene || !entity
      || !isEntityVisuallyPresent(entity)
      || entity.renderGeometry?.kind !== "reality"
      || !entity.renderGeometry.asset
      || !this.realityRuntime?.getHandle(entityId)
      || this.hasActiveTransformTween(entityId)) return false;

    this.cancelRealityMeasurement();
    const session: RealityMeasurementSession = {
      componentId: entityId,
      assetId: entity.renderGeometry.asset.assetId,
      assetDigest: entity.renderGeometry.asset.digest,
      sessionId: ++this.realityMeasurementSequence,
      points: [],
      complete: false,
    };
    this.realityMeasurementSession = session;
    const overlay = new THREE.Group();
    overlay.name = `reality-measurement:${entityId}`;
    overlay.userData.ephemeral = true;
    this.entityLayer.add(overlay);
    this.realityMeasurementOverlay = overlay;
    this.renderer.domElement.style.cursor = "crosshair";
    this.renderer.domElement.dataset.realityMeasurement = "picking-point-a";
    this.renderer.domElement.setAttribute(
      "aria-description",
      "Two-point Reality measurement. Click a visible surface, or aim it at the viewport center and press Enter. Press Escape to cancel.",
    );
    this.keyboardTarget?.focus({ preventScroll: true });
    this.setSelectedEntity(entityId, false);
    this.options.onRealityMeasurement?.({
      kind: "started",
      ...realityMeasurementSubject(session),
    });
    return true;
  }

  /** Cancel the active measurement and dispose every renderer-only helper. */
  cancelRealityMeasurement(): void {
    this.clearRealityMeasurement(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRealityMeasurement(false);
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
      canvas.removeEventListener("pointercancel", this.handlePointerCancel);
      canvas.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
      canvas.removeEventListener("dblclick", this.handleDoubleClick);
      this.keyboardTarget?.removeEventListener("keydown", this.handleKeyDown);
      canvas.removeEventListener("contextmenu", this.preventContextMenu);
      this.renderer.setAnimationLoop(null);
    }
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    for (const controller of this.realityLoads.values()) controller.abort();
    this.realityLoads.clear();
    this.realityRuntime?.dispose();
    this.realityRuntime = null;
    const cadKernel = this.cadKernelPromise;
    this.cadKernelPromise = null;
    this.cadEvaluationCache.clear();
    if (cadKernel) void cadKernel.then((kernel) => kernel.dispose()).catch(() => undefined);
    for (const [id, root] of this.entities) this.disposeManagedEntity(id, root);
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
    if (existing?.userData.renderIdentity === identity && existing.userData.realityAssetMissing !== true) {
      return existing;
    }
    if (existing) {
      // A managed child may be parented under this root. Detach every managed
      // descendant before disposal so replacement never destroys another
      // component's geometry or animation state.
      for (const [otherId, otherRoot] of this.entities) {
        if (otherId === entity.id || !isObjectDescendantOf(otherRoot, existing)) continue;
        this.entityLayer.add(otherRoot);
      }
      if (this.selectedEntityId === entity.id) this.selectionHelper?.removeFromParent();
      this.disposeManagedEntity(entity.id, existing);
      this.entities.delete(entity.id);
      this.replacedEntityIds.add(entity.id);
    }
    this.realityLoads.get(entity.id)?.abort();
    this.realityLoads.delete(entity.id);
    if (entity.renderGeometry?.kind === "reality") {
      // Also cancels a context-restore record when this authoritative entity is
      // being recreated while its old GPU root is temporarily absent.
      this.realityRuntime?.remove(entity.id);
      const controller = new AbortController();
      this.realityLoads.set(entity.id, controller);
      let root: ProceduralEntity;
      try {
        root = await this.createRealityEntity(entity, controller.signal);
      } finally {
        if (this.realityLoads.get(entity.id) === controller) this.realityLoads.delete(entity.id);
      }
      if (this.disposed || controller.signal.aborted) {
        this.disposeManagedEntity(entity.id, root);
        return root;
      }
      root.userData.renderIdentity = identity;
      this.entityLayer.add(root);
      this.entities.set(entity.id, root);
      return root;
    }
    if (entity.renderGeometry?.kind === "cad") {
      const root = await this.createCadEntity(entity);
      if (this.disposed) {
        disposeObject(root);
        return root;
      }
      root.userData.renderIdentity = identity;
      this.entityLayer.add(root);
      this.entities.set(entity.id, root);
      return root;
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
    if (entity.renderGeometry?.kind === "reality" && entity.renderGeometry.asset) {
      try {
        this.realityRuntime?.update(realityInstance(entity));
      } catch {
        // A missing/failed asset is represented by the deterministic placeholder.
      }
    }
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

  private async createRealityEntity(entity: EntityState, signal: AbortSignal): Promise<ProceduralEntity> {
    const geometry = entity.renderGeometry;
    if (geometry?.kind !== "reality" || !geometry.asset || !this.options.openRealityAsset || !this.realityRuntime) {
      return createRealityPlaceholder(entity, geometry?.kind === "reality" ? geometry : undefined);
    }
    const { assetId, digest } = geometry.asset;
    const read = async (readSignal?: AbortSignal): Promise<Uint8Array | ArrayBuffer> => {
      const value = await this.options.openRealityAsset?.(assetId, digest, readSignal);
      if (!value) throw new Error("Reality asset bytes are not present in this browser. Relink the same digest to render it.");
      return value instanceof Blob ? value.arrayBuffer() : value;
    };
    try {
      const bytes = await read(signal);
      if (signal.aborted) throw new DOMException("Reality asset load was cancelled.", "AbortError");
      const handle = await this.realityRuntime.load({
        instance: realityInstance(entity),
        bytes,
        reloadBytes: () => read(),
      }, signal);
      return this.prepareRealityRoot(entity, handle.root as ProceduralEntity);
    } catch (error) {
      this.realityRuntime.remove(entity.id);
      const contextLost = this.realityRuntime.snapshot().contextLost;
      if (signal.aborted || ((error instanceof DOMException && error.name === "AbortError") && !contextLost)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Reality asset could not be rendered.";
      this.options.onStatus?.({
        kind: "asset-fallback",
        assetId,
        note: {
          code: "asset_load_failed",
          entityId: entity.id,
          message,
        },
      });
      return createRealityPlaceholder(entity, geometry, message);
    }
  }

  private cadKernel(): Promise<CadKernel> {
    this.cadKernelPromise ??= createCadWorkerKernel();
    return this.cadKernelPromise;
  }

  private evaluateCadEntity(entity: EntityState): Promise<CadPartEvaluationResultV1> {
    const source = entity.renderGeometry;
    if (source?.kind !== "cad") throw new Error("CAD evaluation requires a CAD render source.");
    const cached = this.cadEvaluationCache.get(source.definitionDigest);
    if (cached) return cached;
    const evaluation = this.cadKernel()
      .then((kernel) => kernel.evaluatePart(source.definition, {
        linearDeflectionM: 0.0005,
        angularDeflectionRad: 0.15,
        budgetMs: 30_000,
      }))
      .catch(async (error) => {
        this.cadEvaluationCache.delete(source.definitionDigest);
        const failedKernel = this.cadKernelPromise;
        this.cadKernelPromise = null;
        if (failedKernel) await failedKernel.then((kernel) => kernel.dispose()).catch(() => undefined);
        throw error;
      });
    this.cadEvaluationCache.set(source.definitionDigest, evaluation);
    while (this.cadEvaluationCache.size > 16) {
      const oldest = this.cadEvaluationCache.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === source.definitionDigest) break;
      this.cadEvaluationCache.delete(oldest);
    }
    return evaluation;
  }

  private async createCadEntity(entity: EntityState): Promise<ProceduralEntity> {
    const source = entity.renderGeometry;
    if (source?.kind !== "cad") throw new Error("CAD render identity requires a CAD document.");
    const root = new THREE.Group() as ProceduralEntity;
    root.name = `entity:${entity.id}`;
    root.userData.entityId = entity.id;
    root.userData.cadDefinitionDigest = source.definitionDigest;
    if (!source.definition.activeBodyIds.length) {
      root.add(createCadPlaceholderMesh(entity.id, "empty"));
      root.traverse((object) => { object.userData.entityId = entity.id; });
      return root;
    }
    try {
      const result = await this.evaluateCadEntity(entity);
      for (const body of result.meshes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(body.mesh.positions, 3));
        geometry.setAttribute("normal", new THREE.BufferAttribute(body.mesh.normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(body.mesh.indices, 1));
        geometry.computeBoundingSphere();
        const material = new THREE.MeshStandardMaterial({
          color: source.material.baseColor,
          metalness: source.material.metallic,
          roughness: source.material.roughness,
          transparent: source.material.opacity < 1,
          opacity: source.material.opacity,
          depthWrite: source.material.opacity >= 1,
          emissive: source.material.emissiveColor,
          emissiveIntensity: source.material.emissiveIntensity,
        });
        material.userData.defaultColor = material.color.getHex();
        const primaryMaterials = root.userData.primaryMaterials as THREE.MeshStandardMaterial[] | undefined;
        root.userData.primaryMaterials = [...(primaryMaterials ?? []), material];
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `cad:body:${body.bodyId}`;
        mesh.castShadow = source.castShadow;
        mesh.receiveShadow = source.receiveShadow;
        mesh.userData.entityId = entity.id;
        mesh.userData.cadBodyId = body.bodyId;
        mesh.userData.cadFaceGroups = body.mesh.groups.map((group) => ({ ...group }));
        root.add(mesh);
      }
      root.userData.cadEvaluationEvidence = structuredClone(result.evidence);
    } catch (error) {
      const message = error instanceof Error ? error.message : "CAD part could not be evaluated.";
      root.add(createCadPlaceholderMesh(entity.id, "failed"));
      root.userData.cadEvaluationError = message;
      this.options.onStatus?.({
        kind: "asset-fallback",
        assetId: entity.assetId,
        note: {
          code: "asset_load_failed",
          entityId: entity.id,
          message: `CAD evaluation failed: ${message}`,
        },
      });
    }
    root.traverse((object) => { object.userData.entityId = entity.id; });
    return root;
  }

  private prepareRealityRoot(entity: EntityState, root: ProceduralEntity): ProceduralEntity {
    const geometry = entity.renderGeometry;
    if (geometry?.kind !== "reality") return root;
    const previousSigns = root.userData.realitySourceAxisSigns as Vec3 | undefined;
    const nextSigns = geometry.sourceAxisSigns;
    for (const child of root.children) {
      if (previousSigns) child.scale.multiply(vector(previousSigns));
      child.scale.multiply(vector(nextSigns));
    }
    root.userData.entityId = entity.id;
    root.userData.realityRuntime = true;
    root.userData.realitySourceAxisSigns = { ...nextSigns };
    return root;
  }

  private async reconcileRealityAfterContextRestore(isCurrent: () => boolean): Promise<void> {
    const runtime = this.realityRuntime;
    const state = this.currentState;
    if (!runtime || !state || !isCurrent() || runtime.snapshot().contextLost) return;

    for (const id of runtime.snapshot().instanceIds) {
      const entity = state.entities.get(id);
      if (entity?.renderGeometry?.kind !== "reality" || !entity.renderGeometry.asset) runtime.remove(id);
    }

    for (const entity of state.entities.values()) {
      if (!isCurrent() || entity.renderGeometry?.kind !== "reality") continue;
      const handle = runtime.getHandle(entity.id);
      let root: ProceduralEntity;
      if (handle) {
        const existing = this.entities.get(entity.id);
        if (existing && existing !== handle.root) disposeObject(existing);
        root = this.prepareRealityRoot(entity, handle.root as ProceduralEntity);
        root.userData.renderIdentity = entityRenderIdentity(entity);
        this.entityLayer.add(root);
        this.entities.set(entity.id, root);
      } else {
        root = await this.ensureEntity(entity);
      }
      if (!isCurrent()) return;
      this.applyEntityPresentation(entity, root);
      this.setEntityTransform(root, this.targetTransform(entity), false);
    }
    this.reconcileHierarchy(state);
    this.refreshNavigationBounds();
    this.refreshSelectionHelper();
  }

  private disposeManagedEntity(id: EntityId, root: THREE.Object3D): void {
    this.realityLoads.get(id)?.abort();
    this.realityLoads.delete(id);
    if (root.userData.realityRuntime === true) {
      this.realityRuntime?.remove(id);
      return;
    }
    disposeObject(root);
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

  private hasActiveTransformTween(entityId: EntityId): boolean {
    const activeKeys = new Set([...this.tweens].flatMap((tween) => tween.key ? [tween.key] : []));
    const visited = new Set<EntityId>();
    let currentId: EntityId | undefined = entityId;
    while (currentId && !visited.has(currentId)) {
      if (activeKeys.has(entityTweenKey(currentId, "transform"))) return true;
      visited.add(currentId);
      currentId = this.currentState?.entities.get(currentId)?.parentId;
    }
    return false;
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
    if (event.isPrimary === false) {
      this.pointerOrigin = null;
      return;
    }
    this.pointerOrigin = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId ?? 0,
    };
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.pointerOrigin) return;
    const origin = this.pointerOrigin;
    this.pointerOrigin = null;
    if (origin.pointerId !== (event.pointerId ?? 0)) return;
    const distance = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
    if (distance > 5 || event.button !== 0) return;
    if (this.realityMeasurementSession && !this.realityMeasurementSession.complete) {
      this.pickRealityMeasurementPoint(event);
      return;
    }
    this.setSelectedEntity(this.entityIdAtPointer(event) ?? null);
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    if (this.pointerOrigin?.pointerId === (event.pointerId ?? 0)) this.pointerOrigin = null;
  };

  private handleLostPointerCapture = (event: PointerEvent): void => {
    const origin = this.pointerOrigin;
    if (!origin || origin.pointerId !== (event.pointerId ?? 0)) return;
    // OrbitControls releases pointer capture from its pointerup listener, which
    // may dispatch lostpointercapture before our pointerup listener runs. Defer
    // the fail-closed reset one microtask so a matching, already-dispatched up
    // can complete, while a genuinely lost capture cannot leak into a later
    // measurement session.
    queueMicrotask(() => {
      if (this.pointerOrigin === origin) this.pointerOrigin = null;
    });
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.realityMeasurementSession) return;
    const id = this.entityIdAtPointer(event);
    if (id) this.options.onActivateEntity?.(id);
  };

  private raycasterAtPointer(event: MouseEvent | PointerEvent): THREE.Raycaster | undefined {
    if (!this.renderer || !this.camera) return undefined;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    return raycaster;
  }

  private entityIdAtPointer(event: MouseEvent | PointerEvent): EntityId | undefined {
    const raycaster = this.raycasterAtPointer(event);
    if (!raycaster) return undefined;
    const interactiveRoots = [...this.entities].flatMap(([id, root]) => root.visible
      && isEntityVisuallyPresent(this.currentState?.entities.get(id))
      ? [root]
      : []);
    const intersections = raycaster.intersectObjects(interactiveRoots, true);
    const id = intersections.find((entry) => typeof entry.object.userData.entityId === "string")?.object.userData
      .entityId as EntityId | undefined;
    return id;
  }

  private pickRealityMeasurementPoint(event: MouseEvent | PointerEvent): void {
    const raycaster = this.raycasterAtPointer(event);
    if (raycaster) this.pickRealityMeasurementWithRaycaster(raycaster);
  }

  private pickRealityMeasurementAtViewportCenter(): void {
    if (!this.camera) return;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.pickRealityMeasurementWithRaycaster(raycaster);
  }

  private pickRealityMeasurementWithRaycaster(raycaster: THREE.Raycaster): void {
    const session = this.realityMeasurementSession;
    if (!session || session.complete || !this.realityRuntime) return;
    let hit;
    try {
      hit = this.realityRuntime.raycastSurface(session.componentId, raycaster);
    } catch {
      this.options.onRealityMeasurement?.({
        kind: "miss",
        ...realityMeasurementSubject(session),
        pickedPoints: session.points.length === 0 ? 0 : 1,
        message: "The Gaussian surface could not be sampled. Try again or reload the capture.",
      });
      return;
    }
    if (!hit) {
      this.options.onRealityMeasurement?.({
        kind: "miss",
        ...realityMeasurementSubject(session),
        pickedPoints: session.points.length === 0 ? 0 : 1,
        message: "No Gaussian surface was found there. Click a visible part of the capture.",
      });
      return;
    }

    const semanticWorldPoint = new THREE.Vector3(
      hit.worldPoint.x,
      hit.worldPoint.y,
      hit.worldPoint.z,
    ).add(this.renderOrigin);
    const point: RealityMeasurementPoint = Object.freeze({
      sourcePoint: Object.freeze({ ...hit.sourcePoint }),
      worldPoint: Object.freeze({
        x: semanticWorldPoint.x,
        y: semanticWorldPoint.y,
        z: semanticWorldPoint.z,
      }),
      cameraDistance: hit.cameraDistance,
      fidelity: hit.fidelity,
    });
    const first = session.points[0];
    if (first && vectorDistance(first.sourcePoint, point.sourcePoint) <= 1e-12) {
      this.options.onRealityMeasurement?.({
        kind: "miss",
        ...realityMeasurementSubject(session),
        pickedPoints: 1,
        message: "The two points overlap. Choose a different second point.",
      });
      return;
    }

    session.points.push(point);
    const pointIndex = session.points.length as 1 | 2;
    this.addRealityMeasurementMarker(point, pointIndex);
    this.options.onRealityMeasurement?.({
      kind: "point",
      ...realityMeasurementSubject(session),
      pointIndex,
      point,
    });
    if (pointIndex === 1) {
      if (this.renderer) this.renderer.domElement.dataset.realityMeasurement = "picking-point-b";
      return;
    }

    const points = Object.freeze([
      session.points[0]!,
      session.points[1]!,
    ]) as readonly [RealityMeasurementPoint, RealityMeasurementPoint];
    const sourceDistance = vectorDistance(points[0].sourcePoint, points[1].sourcePoint);
    const displayedDistance = vectorDistance(points[0].worldPoint, points[1].worldPoint);
    this.addRealityMeasurementLine(points);
    session.complete = true;
    if (this.renderer) {
      this.renderer.domElement.style.cursor = "";
      this.renderer.domElement.dataset.realityMeasurement = "complete";
      this.renderer.domElement.setAttribute(
        "aria-description",
        "Two-point Reality measurement complete. Markers A and B show the sampled span. Press Escape to clear them.",
      );
    }
    this.options.onRealityMeasurement?.({
      kind: "complete",
      ...realityMeasurementSubject(session),
      points,
      sourceDistance,
      displayedDistance,
      fidelity: "gaussian-lod",
    });
  }

  private addRealityMeasurementMarker(point: RealityMeasurementPoint, pointIndex: 1 | 2): void {
    const overlay = this.realityMeasurementOverlay;
    if (!overlay) return;
    const radius = THREE.MathUtils.clamp(point.cameraDistance * 0.009, 0.008, 0.35);
    const geometry = new THREE.SphereGeometry(radius, 18, 12);
    const material = new THREE.MeshBasicMaterial({
      color: pointIndex === 1 ? 0x55e6ff : 0xffc568,
      depthTest: false,
      depthWrite: false,
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.name = `reality-measurement-point-${pointIndex === 1 ? "a" : "b"}`;
    marker.position.set(point.worldPoint.x, point.worldPoint.y, point.worldPoint.z);
    marker.renderOrder = 10_000;
    marker.raycast = () => undefined;
    overlay.add(marker);
  }

  private addRealityMeasurementLine(
    points: readonly [RealityMeasurementPoint, RealityMeasurementPoint],
  ): void {
    const overlay = this.realityMeasurementOverlay;
    if (!overlay) return;
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(
      point.worldPoint.x,
      point.worldPoint.y,
      point.worldPoint.z,
    )));
    const material = new THREE.LineBasicMaterial({
      color: 0x75eaff,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const line = new THREE.Line(geometry, material);
    line.name = "reality-measurement-line";
    line.renderOrder = 9_999;
    line.raycast = () => undefined;
    overlay.add(line);
  }

  private clearRealityMeasurement(notify: boolean): void {
    const session = this.realityMeasurementSession;
    this.realityMeasurementSession = null;
    this.pointerOrigin = null;
    if (this.realityMeasurementOverlay) disposeObject(this.realityMeasurementOverlay);
    this.realityMeasurementOverlay = null;
    if (this.renderer) {
      this.renderer.domElement.style.cursor = "";
      delete this.renderer.domElement.dataset.realityMeasurement;
      this.renderer.domElement.removeAttribute("aria-description");
    }
    if (notify && session) {
      this.options.onRealityMeasurement?.({
        kind: "cancelled",
        ...realityMeasurementSubject(session),
      });
    }
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (this.realityMeasurementSession) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelRealityMeasurement();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!this.realityMeasurementSession.complete) this.pickRealityMeasurementAtViewportCenter();
        return;
      }
    }
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
    this.cancelRealityMeasurement();
    this.realityRuntime?.handleContextLost(event);
    // Runtime disposal removes these roots from the scene immediately. Removing
    // the stale map entries makes every state update during recovery fail closed
    // to a placeholder/retry instead of mutating disposed GPU objects.
    for (const [id, root] of this.entities) {
      if (root.userData.realityRuntime === true) this.entities.delete(id);
    }
    this.refreshSelectionHelper();
    this.options.onStatus?.({ kind: "context-lost" });
  };

  private handleContextRestored = (): void => {
    const runtime = this.realityRuntime;
    if (!runtime) {
      this.options.onStatus?.({ kind: "context-restored" });
      return;
    }
    void runtime.handleContextRestored()
      .then(() => runtime.snapshot().contextLost
        ? undefined
        : this.enqueueStateRender((isCurrent) => this.reconcileRealityAfterContextRestore(isCurrent)))
      .catch((error) => {
        this.options.onStatus?.({
          kind: "error",
          message: error instanceof Error ? error.message : "Reality layers could not recover after WebGL restoration.",
        });
      })
      .finally(() => {
        // A second loss can interrupt the asynchronous reload. The browser will
        // emit another restored event for that context; do not announce success
        // or reconcile placeholders until that recovery actually completes.
        if (!runtime.snapshot().contextLost) this.options.onStatus?.({ kind: "context-restored" });
      });
  };

  private preventContextMenu = (event: Event): void => event.preventDefault();
}

function entityRenderIdentity(entity: EntityState): string {
  if (entity.renderGeometry?.kind === "assembly") return "assembly";
  if (entity.renderGeometry?.kind === "parametric") return "parametric";
  if (entity.renderGeometry?.kind === "cad") {
    return cadEntityRenderIdentity(entity.renderGeometry);
  }
  if (entity.renderGeometry?.kind === "reality") {
    const asset = entity.renderGeometry.asset;
    const signs = entity.renderGeometry.sourceAxisSigns;
    return asset
      ? `reality:${asset.assetId}:${asset.digest}:${signs.x},${signs.y},${signs.z}`
      : "reality:unlinked";
  }
  return `asset:${entity.kind}:${entity.assetId}`;
}

/**
 * CAD meshes may reuse cached tessellation only while their complete visual
 * construction contract is unchanged. Material and shadow edits therefore
 * replace the Three.js root without re-running OCCT for the same definition.
 */
export function cadEntityRenderIdentity(
  source: Extract<NonNullable<EntityState["renderGeometry"]>, { kind: "cad" }>,
): string {
  const material = source.material;
  return [
    "cad",
    source.definitionDigest,
    material.baseColor,
    material.metallic,
    material.roughness,
    material.opacity,
    material.emissiveColor,
    material.emissiveIntensity,
    source.castShadow ? 1 : 0,
    source.receiveShadow ? 1 : 0,
  ].join(":");
}

function realityInstance(entity: EntityState): RealitySplatInstanceDescriptor {
  const geometry = entity.renderGeometry;
  if (geometry?.kind !== "reality" || !geometry.asset) {
    throw new Error("Reality render identity requires an exact RealityAsset reference.");
  }
  return {
    instanceId: entity.id,
    entityId: entity.id,
    asset: {
      ...geometry.asset,
      bounds: geometry.bounds,
    },
    visible: isEntityVisuallyPresent(entity),
    opacity: entity.appearance.opacity ?? 1,
    quality: geometry.quality,
  };
}

function createCadPlaceholderMesh(
  entityId: string,
  state: "empty" | "failed",
): THREE.Object3D {
  const group = new THREE.Group();
  group.name = `cad:placeholder:${state}`;
  const geometry = new THREE.BoxGeometry(0.24, 0.16, 0.2);
  const shell = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: state === "failed" ? 0xff6b7a : 0x68d5ff,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    }),
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: state === "failed" ? 0xff6b7a : 0x68d5ff }),
  );
  shell.userData.entityId = entityId;
  edges.userData.entityId = entityId;
  group.add(shell, edges);
  return group;
}

function createRealityPlaceholder(
  entity: EntityState,
  reality?: Extract<NonNullable<EntityState["renderGeometry"]>, { kind: "reality" }>,
  message?: string,
): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const signs = vector(reality?.sourceAxisSigns ?? { x: 1, y: 1, z: 1 });
  const first = reality ? vector(reality.bounds.min).multiply(signs) : new THREE.Vector3(-0.5, -0.5, -0.5);
  const second = reality ? vector(reality.bounds.max).multiply(signs) : new THREE.Vector3(0.5, 0.5, 0.5);
  const min = new THREE.Vector3(
    Math.min(first.x, second.x),
    Math.min(first.y, second.y),
    Math.min(first.z, second.z),
  );
  const max = new THREE.Vector3(
    Math.max(first.x, second.x),
    Math.max(first.y, second.y),
    Math.max(first.z, second.z),
  );
  const size = max.clone().sub(min);
  size.set(Math.max(1e-6, size.x), Math.max(1e-6, size.y), Math.max(1e-6, size.z));
  const center = min.clone().add(max).multiplyScalar(0.5);
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  const fill = new THREE.MeshBasicMaterial({
    color: 0x68d5ff,
    transparent: true,
    opacity: 0.08,
    depthWrite: false,
  });
  const shell = new THREE.Mesh(geometry, fill);
  shell.position.copy(center);
  shell.userData.entityId = entity.id;
  root.add(shell);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineDashedMaterial({ color: 0x68d5ff, dashSize: 0.08, gapSize: 0.045 }),
  );
  edges.position.copy(center);
  edges.computeLineDistances();
  edges.raycast = () => undefined;
  root.add(edges);
  root.userData.entityId = entity.id;
  root.userData.realityAssetMissing = true;
  root.userData.realityFallbackMessage = message ?? "Reality asset bytes are unavailable in this browser.";
  return root;
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

function vectorDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function realityMeasurementSubject(session: RealityMeasurementSession) {
  return {
    componentId: session.componentId,
    assetId: session.assetId,
    assetDigest: session.assetDigest,
    sessionId: session.sessionId,
  } as const;
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
