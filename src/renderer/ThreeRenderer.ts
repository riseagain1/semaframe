/// <reference types="webxr" />

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
import { createCadWorkerKernel } from "../workspace/modeling/cadWorkerClient";
import type { CadKernel } from "../workspace/modeling/cadKernel";
import type { CadPartEvaluationResultV1 } from "../workspace/modeling/cad";
import type {
  XRControllerRay,
  XRInputActionState,
  XRInputTrackingState,
  XRPose,
  XRRayHit,
  XRSessionVisibilityState,
  XRSpatialPin,
  XRSpatialContextSnapshot,
  XRTargetRayMode,
  XRTrackedInput,
  XRUserTrackingState,
} from "../xr/client/contracts";
import {
  XRVoiceFeedbackLayer,
  XRSpatialPinLayer,
  XRWorldPanelLayer,
  type ThreeRendererXRPanelAction,
  type ThreeRendererXRPanelWarning,
  type ThreeRendererXRPushToTalkEvent,
  type ThreeRendererXRVoiceFeedback,
  type ThreeRendererXRVoiceHapticCue,
  type ThreeRendererXRWorldPanel,
} from "./xr";
import {
  isXRTeleportBlockingEntity,
  isXRTeleportWalkableEnvironmentObject,
  planThreeRendererTeleport,
} from "./xr/XRTeleportPlanner";
import {
  MaterializationController,
  MaterializationLayer,
  materializationAssetBounds,
  planMaterialization,
  type MaterializationMode,
  type RenderPresentationContext,
} from "./materialization";

export type {
  ThreeRendererXRPanelAction,
  ThreeRendererXRPanelWarning,
  ThreeRendererXRPushToTalkEvent,
  ThreeRendererXRVoiceFeedback,
  ThreeRendererXRVoiceHapticCue,
  ThreeRendererXRWorldPanel,
} from "./xr";

export type ThreeRendererXRConfig = Readonly<{
  referenceSpaceType?: "local" | "local-floor" | "bounded-floor";
  framebufferScaleFactor?: number;
  foveation?: number;
  targetFrameRateHz?: number;
  teleport?: boolean;
}>;

export type ThreeRendererXRTeleport = Readonly<{
  position: Readonly<{ x: number; y: number; z: number }>;
}>;

export type ThreeRendererXRSpatialPinEvent = Readonly<{
  action: "placed" | "cleared";
  pin?: XRSpatialPin;
}>;

export type ThreeRendererOptions = {
  getSceneState?: () => Readonly<SceneState>;
  onSelectEntity?: (entityId: EntityId | null) => void;
  onActivateEntity?: (entityId: EntityId) => void;
  onRealityMeasurement?: (event: RealityMeasurementEvent) => void;
  onAnimationComplete?: (completion: AnimationCompletion) => void;
  onXRTeleport?: (event: ThreeRendererXRTeleport) => void;
  onXRPanelAction?: (event: ThreeRendererXRPanelAction) => void;
  onXRPanelWarning?: (warning: ThreeRendererXRPanelWarning) => void;
  onXRPushToTalk?: (event: ThreeRendererXRPushToTalkEvent) => void;
  /** Renderer-only XR reference changed; the host may publish a fresh context immediately. */
  onXRSpatialPinChange?: (event: ThreeRendererXRSpatialPinEvent) => void;
  onStatus?: (status: RendererStatus) => void;
  pixelRatioCap?: number;
  shadows?: boolean;
  /** Enables effects such as bloom that are intentionally omitted in bounded XR mode. */
  expensiveLighting?: boolean;
  reducedMotion?: boolean;
  /** Renderer-local live-commit reveal. It never changes Workspace state or export. */
  materializationMode?: MaterializationMode;
  /** Bounded shared proxy budget; individual assets never allocate their own effect material. */
  materializationMaxProxyInstances?: number;
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

type XRControllerEvent = Readonly<{ type?: string; data?: XRInputSource }>;
type XRControllerObject = THREE.Object3D & Readonly<{
  addEventListener(type: string, listener: (event: XRControllerEvent) => void): void;
  removeEventListener(type: string, listener: (event: XRControllerEvent) => void): void;
}>;

type XRControllerMetadata = Readonly<{
  input: "controller" | "hand";
  handedness: "left" | "right" | "none";
}>;

type XRGamepadHapticActuatorLike = Readonly<{
  pulse(value: number, duration: number): Promise<boolean> | boolean;
}>;

type XRGamepadLike = Gamepad & Readonly<{
  hapticActuators?: readonly XRGamepadHapticActuatorLike[];
  vibrationActuator?: XRGamepadHapticActuatorLike;
}>;

type XRControllerHandlers = Readonly<Record<
  "connected" | "disconnected" | "select" | "selectstart" | "selectend" | "squeezestart" | "squeezeend",
  (event: XRControllerEvent) => void
>>;

const DEFAULT_CAMERA_POSITION = new THREE.Vector3(7.5, 5.2, 8.5);
const DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 0.8, 0);
const ENTITY_LOAD_TIMEOUT_MS = 45_000;
const XR_ACTIVE_AXIS_DELTA = 0.15;
const EMPTY_XR_INPUT_ACTIONS: XRInputActionState = Object.freeze({
  available: false,
  selectPressed: false,
  squeezePressed: false,
  primaryButtonPressed: false,
  secondaryButtonPressed: false,
  thumbstickPressed: false,
  thumbstick: Object.freeze({ x: 0, y: 0 }),
});

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
  private materializationMode: MaterializationMode;
  private materializationLayer: MaterializationLayer | null = null;
  private materializationController: MaterializationController | null = null;
  private lastMaterializationBatchKey: string | null = null;
  private selectedEntityId: EntityId | null = null;
  private selectionHelper: THREE.BoxHelper | null = null;
  private pointerOrigin: PointerOrigin | null = null;
  private readonly activeDesktopPointerIds = new Set<number>();
  private reducedMotion = false;
  private reducedMotionQuery: MediaQueryList | null = null;
  private disposed = false;
  private lifecycleToken = 0;
  private stateRenderQueue: Promise<void> = Promise.resolve();
  private stateRenderGeneration = 0;
  private activeStateRenderAbort: AbortController | null = null;
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
  private readonly xrRig = new THREE.Group();
  private readonly xrControllers: XRControllerObject[] = [];
  private readonly xrControllerGrips: THREE.Object3D[] = [];
  private readonly xrControllerHandlers = new Map<XRControllerObject, XRControllerHandlers>();
  private readonly xrControllerMetadata = new Map<XRControllerObject, XRControllerMetadata>();
  private readonly xrControllerByInputSource = new Map<XRInputSource, XRControllerObject>();
  private readonly xrInputSourceByController = new Map<XRControllerObject, XRInputSource>();
  private readonly xrGripByInputSource = new Map<XRInputSource, THREE.Object3D>();
  private readonly xrGripByController = new Map<XRControllerObject, THREE.Object3D>();
  private readonly xrInputSourceIds = new Map<XRInputSource, string>();
  private readonly xrInputTrackingStates = new Map<XRInputSource, XRInputTrackingState>();
  private readonly xrGripTrackingStates = new Map<XRInputSource, XRInputTrackingState>();
  private readonly xrPreviousActionStates = new Map<XRInputSource, XRInputActionState>();
  private readonly xrSelectPressedSources = new Set<XRInputSource>();
  private readonly xrSqueezePressedSources = new Set<XRInputSource>();
  private xrInputSourceSequence = 0;
  private xrActiveInputSource: XRInputSource | null = null;
  private xrFrameSampleSequence = 0;
  private xrLastFrameTimestampMs = 0;
  private xrHeadPoseState: XRInputTrackingState = "unknown";
  private xrActivePushToTalk: Readonly<{ controller: XRControllerObject; metadata: XRControllerMetadata }> | null = null;
  private xrLifecycleQueue: Promise<void> = Promise.resolve();
  private xrSession: XRSession | null = null;
  private xrReferenceSpaceType: "local" | "local-floor" | "bounded-floor" = "local-floor";
  private xrTeleportEnabled = true;
  private xrLastEntitySelect: Readonly<{ entityId: EntityId; atMs: number }> | null = null;
  private xrCameraParent: THREE.Object3D | null = null;
  private xrCameraPosition: THREE.Vector3 | null = null;
  private xrCameraQuaternion: THREE.Quaternion | null = null;
  private xrWorldPanelLayer: XRWorldPanelLayer | null = null;
  private xrVoiceFeedbackLayer: XRVoiceFeedbackLayer | null = null;
  private xrSpatialPinLayer: XRSpatialPinLayer | null = null;
  private xrSpatialPin: XRSpatialPin | undefined;
  private xrSpatialPinSequence = 0;
  private pendingXRVoiceFeedback: ThreeRendererXRVoiceFeedback = Object.freeze({ phase: "hidden" });
  private xrVoiceButtonFrame: number | null = null;
  private readonly xrVoiceButtonStates = new Map<XRInputSource, Readonly<{ confirm: boolean; cancel: boolean }>>();
  private pendingXRWorldPanels: readonly ThreeRendererXRWorldPanel[] = Object.freeze([]);
  private pendingXRWorkspaceRevision: number | undefined;
  private xrPanelActionHandler: ThreeRendererOptions["onXRPanelAction"];
  private xrPanelWarningHandler: ThreeRendererOptions["onXRPanelWarning"];

  private readonly handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    this.setReducedMotion(event.matches);
  };

  constructor(options: ThreeRendererOptions = {}) {
    this.options = options;
    this.assets = options.assetRegistry ?? DEFAULT_ASSET_REGISTRY;
    this.gltfAssets = options.gltfAssetLoader ?? new GltfAssetLoader();
    this.reducedMotion = options.reducedMotion ?? false;
    this.materializationMode = options.materializationMode ?? "full";
    this.xrPanelActionHandler = options.onXRPanelAction;
    this.xrPanelWarningHandler = options.onXRPanelWarning;
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
    this.xrRig.name = "semaframe-xr-player-rig";
    this.entityLayer.name = "scene-entities";
    scene.add(this.entityLayer);
    const materializationLayer = new MaterializationLayer(
      this.entityLayer,
      optionsProxyBudget(this.options.materializationMaxProxyInstances),
    );
    this.materializationLayer = materializationLayer;
    this.materializationController = new MaterializationController(materializationLayer);
    const xrWorldPanelLayer = new XRWorldPanelLayer({
      document: container.ownerDocument,
      onAction: (event) => this.xrPanelActionHandler?.(event),
      onWarning: (warning) => {
        this.xrPanelWarningHandler?.(warning);
      },
    });
    this.xrWorldPanelLayer = xrWorldPanelLayer;
    xrWorldPanelLayer.worldRoot.position.copy(this.renderOrigin).multiplyScalar(-1);
    scene.add(xrWorldPanelLayer.worldRoot);
    this.xrRig.add(xrWorldPanelLayer.viewerRoot);
    xrWorldPanelLayer.setPanels(this.pendingXRWorldPanels, this.pendingXRWorkspaceRevision);
    const xrVoiceFeedbackLayer = new XRVoiceFeedbackLayer(container.ownerDocument);
    this.xrVoiceFeedbackLayer = xrVoiceFeedbackLayer;
    scene.add(xrVoiceFeedbackLayer.root);
    const xrSpatialPinLayer = new XRSpatialPinLayer(container.ownerDocument);
    this.xrSpatialPinLayer = xrSpatialPinLayer;
    this.entityLayer.add(xrSpatialPinLayer.root);
    scene.add(xrSpatialPinLayer.hudRoot);

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
    return this.enqueueStateRender((isCurrent, signal) => this.renderStateNow(state, isCurrent, signal));
  }

  private async renderStateNow(
    state: Readonly<SceneState>,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    this.requireInitialized();
    // Opening/loading a full state is not a live commit. Finish any superseded
    // pass and project the snapshot directly so reconnects never replay it.
    this.materializationController?.cancel(true);
    this.lastMaterializationBatchKey = null;
    this.clearRealityMeasurement(false);
    this.cancelTweens();
    for (const [id, root] of this.entities) this.disposeManagedEntity(id, root);
    this.entities.clear();
    this.currentState = state;
    this.rebuildEnvironment(state.environment);
    await Promise.all([...state.entities.values()].map((entity) => this.ensureEntity(entity, isCurrent, signal)));
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
    presentation?: RenderPresentationContext,
  ): Promise<void> {
    // A newer authoritative revision cancels the old presentation immediately,
    // even while an asynchronous asset from the prior queue entry is loading.
    if (sceneDeltaHasSemanticChange(delta)) this.materializationController?.cancel(true);
    return this.enqueueStateRender((isCurrent, signal) => this.applyDeltaNow(
      delta,
      state,
      operations,
      presentation,
      isCurrent,
      signal,
    ));
  }

  private async applyDeltaNow(
    delta: SceneDelta,
    state?: Readonly<SceneState>,
    operations: readonly SceneOperation[] = [],
    presentation?: RenderPresentationContext,
    isCurrent: () => boolean = () => true,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    this.requireInitialized();
    this.replacedEntityIds.clear();
    const nextState = state ?? this.options.getSceneState?.();
    if (!nextState) {
      throw new Error("ThreeRenderer.applyDelta requires a SceneState or a getSceneState provider.");
    }
    const previousState = this.currentState;
    this.currentState = nextState;
    const semanticChange = sceneDeltaHasSemanticChange(delta);
    if (semanticChange) this.materializationController?.cancel(true);
    const materializationBatchKey = presentation?.batchKey
      ?? `revision:${delta.fromRevision}->${delta.toRevision}`;
    const materializationMode = this.materializationMode;
    const shouldMaterialize = presentation?.delivery === "live_commit"
      && materializationMode !== "off"
      && !this.reducedMotion
      && delta.added.length > 0
      && materializationBatchKey !== this.lastMaterializationBatchKey;
    if (shouldMaterialize) {
      const plan = planMaterialization({
        state: nextState,
        addedEntityIds: delta.added,
        batchKey: materializationBatchKey,
        mode: materializationMode,
        resolveAssetBounds: (assetId) => {
          const record = this.assets.get(assetId);
          if (!record) return undefined;
          const originRule = record.runtime?.originRule ?? "ground_center";
          return materializationAssetBounds(
            { x: 0, y: originRule === "ground_center" ? record.bounds.height / 2 : 0, z: 0 },
            { x: record.bounds.width, y: record.bounds.height, z: record.bounds.depth },
          );
        },
      });
      if (plan.entries.length) {
        this.materializationController?.begin(plan);
        this.lastMaterializationBatchKey = materializationBatchKey;
      }
    } else if (semanticChange && presentation?.delivery !== "live_commit") {
      this.lastMaterializationBatchKey = null;
    }
    try {
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
      const timing = timingForEnvironment(operations, this.reducedMotion) ?? (shouldMaterialize
        ? { startAfterMs: 0, durationMs: 300, easing: "ease_out" as const }
        : undefined);
      if (previousState && timing) {
        this.transitionEnvironment(previousState.environment, nextState.environment, timing);
      } else {
        this.rebuildEnvironment(nextState.environment);
      }
    }

    for (const id of delta.removed) {
      if (this.realityMeasurementSession?.componentId === id) this.cancelRealityMeasurement();
      this.materializationController?.detach(id);
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
      if (!entity) return;
      const root = await this.ensureEntity(entity, isCurrent, signal);
      if (!isCurrent()) return;
      if (this.materializationController?.isActive()) root.visible = false;
      this.attachMaterializationRoots(nextState, delta.added, materializationBatchKey);
    }));
    // Updated entities may change their authoritative render source (for
    // example an asset ID, or delete/recreate under the same component ID).
    await Promise.all(delta.updated.map(async (id) => {
      const entity = nextState.entities.get(id);
      if (entity) await this.ensureEntity(entity, isCurrent, signal);
    }));
    // Defensive reconciliation also covers repaired/idempotent deltas from external stores.
    await Promise.all([...nextState.entities].map(async ([id, entity]) => {
      if (!this.entities.has(id)) await this.ensureEntity(entity, isCurrent, signal);
    }));
    if (!isCurrent()) return;

    this.reconcileHierarchy(nextState);
    this.attachMaterializationRoots(nextState, delta.added, materializationBatchKey);
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
      const added = delta.added.includes(id);
      const materializingAdded = added
        && this.materializationController?.isActive() === true
        && root.userData.materializationBatchKey === materializationBatchKey;
      if (!materializingAdded) this.applyEntityPresentation(entity, root, Boolean(previousEntity));
      if (!added && previousEntity) {
        this.transitionEntityVisualEffects(root, previousEntity, entity, timing);
      }
      if (animationGeneration(previousEntity) !== animationGeneration(entity)) {
        const materializationDelayMs = materializingAdded
          ? this.materializationController?.remainingRevealMs(id) ?? 0
          : 0;
        root.userData.animationNotBeforeSeconds = this.clock.elapsedTime
          + Math.max(timing.startAfterMs, materializationDelayMs) / 1_000;
      }
      if (added) {
        const target = this.targetTransform(entity);
        this.setEntityTransform(root, target, false);
        if (!materializingAdded) root.visible = isEntityVisuallyPresent(entity);
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
    } catch (error) {
      // The semantic commit is already authoritative. Presentation failures,
      // including an async asset decoder rejection, must restore every root and
      // remove renderer-only proxies before the error reaches the caller.
      if (shouldMaterialize) this.materializationController?.cancel(true);
      throw error;
    }
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

  /**
   * Attach a user-activated WebXR session to this renderer. The Workspace
   * remains authoritative outside the renderer; locomotion and rays are
   * presentation-only until a host callback commits a semantic action.
   */
  async enterXR(session: XRSession, config: ThreeRendererXRConfig = {}): Promise<void> {
    return this.enqueueXRLifecycle(() => this.enterXRNow(session, config));
  }

  private async enterXRNow(session: XRSession, config: ThreeRendererXRConfig): Promise<void> {
    if (!this.renderer || !this.scene || !this.camera || !this.controls || this.disposed) {
      throw new Error("ThreeRenderer must be initialized before entering XR");
    }
    if (this.xrSession === session && this.renderer.xr.isPresenting) return;
    if (this.xrSession) throw new Error("Another XR session is already active");

    const scale = config.framebufferScaleFactor ?? 0.85;
    if (!Number.isFinite(scale) || scale < 0.5 || scale > 1) {
      throw new RangeError("XR framebuffer scale factor must be between 0.5 and 1");
    }
    const foveation = config.foveation ?? 0.6;
    if (!Number.isFinite(foveation) || foveation < 0 || foveation > 1) {
      throw new RangeError("XR foveation must be between 0 and 1");
    }

    this.xrSession = session;
    this.xrReferenceSpaceType = config.referenceSpaceType ?? "local-floor";
    this.xrTeleportEnabled = config.teleport ?? true;
    this.xrFrameSampleSequence = 0;
    this.xrLastFrameTimestampMs = 0;
    this.xrHeadPoseState = "unknown";
    this.xrActiveInputSource = null;
    this.xrPreviousActionStates.clear();
    this.xrSelectPressedSources.clear();
    this.xrSqueezePressedSources.clear();
    this.xrCameraParent = this.camera.parent;
    this.xrCameraPosition = this.camera.position.clone();
    this.xrCameraQuaternion = this.camera.quaternion.clone();
    this.xrRig.position.set(0, 0, 0);
    this.xrRig.quaternion.identity();
    this.scene.add(this.xrRig);
    this.xrRig.attach(this.camera);
    this.controls.enabled = false;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType(this.xrReferenceSpaceType);
    this.renderer.xr.setFramebufferScaleFactor(scale);
    this.installXRControllers();
    this.xrWorldPanelLayer?.setVisible(true);
    session.addEventListener("end", this.handleXRSessionEnd, { once: true });
    try {
      await this.renderer.xr.setSession(session);
      this.renderer.xr.setFoveation(foveation);
      await requestXRTargetFrameRate(session, config.targetFrameRateHz);
      this.xrVoiceFeedbackLayer?.setFeedback(this.pendingXRVoiceFeedback);
      this.xrSpatialPinLayer?.showEntryHint();
      this.startXRVoiceButtonLoop(session);
    } catch (error) {
      await this.cleanupXRSession(session);
      throw error;
    }
  }

  async exitXR(): Promise<void> {
    return this.enqueueXRLifecycle(() => this.exitXRNow());
  }

  private async exitXRNow(): Promise<void> {
    const session = this.xrSession;
    if (!session) return;
    try {
      await session.end();
    } finally {
      await this.cleanupXRSession(session);
    }
  }

  isXRPresenting(): boolean {
    return Boolean(this.xrSession && this.renderer?.xr.isPresenting);
  }

  /** Capture semantic-space XR facts without persisting or mutating Workspace state. */
  captureXRSpatialContext(): XRSpatialContextSnapshot | undefined {
    if (!this.xrSession || !this.renderer?.xr.isPresenting || !this.camera) return undefined;
    const liveCamera = this.renderer.xr.getCamera();
    const headPosition = liveCamera.getWorldPosition(new THREE.Vector3()).add(this.renderOrigin);
    const headOrientation = liveCamera.getWorldQuaternion(new THREE.Quaternion());
    const headPose = xrPose(headPosition, headOrientation);
    const sources = Array.from(this.xrSession.inputSources);
    const trackedInputs: XRTrackedInput[] = [];
    const rayBySource = new Map<XRInputSource, ReturnType<ThreeRenderer["captureXRRay"]>>();
    for (const source of sources) {
      const controller = this.xrControllerByInputSource.get(source);
      if (!controller) continue;
      controller.updateWorldMatrix(true, false);
      const position = controller.getWorldPosition(new THREE.Vector3()).add(this.renderOrigin);
      const orientation = controller.getWorldQuaternion(new THREE.Quaternion());
      const trackingState = this.xrInputTrackingStates.get(source) ?? "unknown";
      const grip = this.xrGripByInputSource.get(source);
      const gripTrackingState = this.xrGripTrackingStates.get(source);
      const gripPose = grip && (gripTrackingState === "tracked" || gripTrackingState === "emulated")
        ? xrPose(
          grip.getWorldPosition(new THREE.Vector3()).add(this.renderOrigin),
          grip.getWorldQuaternion(new THREE.Quaternion()),
        )
        : undefined;
      const ray = trackingState === "tracked" || trackingState === "emulated"
        ? this.captureXRRay(controller)
        : undefined;
      if (ray) rayBySource.set(source, ray);
      const actions = this.captureXRInputActions(source);
      trackedInputs.push(Object.freeze({
        sourceId: this.xrSourceId(source),
        handedness: source.handedness || "none",
        trackingState,
        targetRayMode: xrTargetRayMode(source.targetRayMode),
        targetRayPose: xrPose(position, orientation),
        ...(gripPose ? { gripPose } : {}),
        ...(ray ? {
          ray: ray.primaryRay,
          ...(ray.rayHit ? { rayHit: ray.rayHit } : {}),
        } : {}),
        actions,
      }));
    }

    const mappedSources = sources.filter((source) => this.xrControllerByInputSource.has(source));
    const trackedSources = mappedSources.filter((source) => (
      this.xrInputTrackingStates.get(source) === "tracked" && rayBySource.has(source)
    ));
    const emulatedSources = mappedSources.filter((source) => (
      this.xrInputTrackingStates.get(source) === "emulated" && rayBySource.has(source)
    ));
    const primarySource = trackedSources.find(({ handedness }) => handedness === "right")
      ?? trackedSources[0]
      ?? emulatedSources.find(({ handedness }) => handedness === "right")
      ?? emulatedSources[0];
    const activeSource = this.xrActiveInputSource
      && mappedSources.includes(this.xrActiveInputSource)
      ? this.xrActiveInputSource
      : undefined;
    const ray = primarySource ? rayBySource.get(primarySource) : undefined;
    const rigFloor = this.xrRig.getWorldPosition(new THREE.Vector3()).add(this.renderOrigin);
    const playerHeight = THREE.MathUtils.clamp(headPosition.y - rigFloor.y, 1.2, 2.4);
    const sessionVisibility = xrSessionVisibility(this.xrSession.visibilityState);
    const sourceAgeMs = this.xrFrameSampleSequence === 0
      ? 0
      : Math.max(0, performanceNow() - this.xrLastFrameTimestampMs);
    const trackingState = xrUserTrackingState(
      this.xrHeadPoseState,
      trackedInputs.map((input) => input.trackingState),
      sessionVisibility,
    );
    return Object.freeze({
      sampleSequence: this.xrFrameSampleSequence,
      tracking: Object.freeze({
        state: trackingState,
        headPoseState: this.xrHeadPoseState,
        sourceTimestampMs: this.xrLastFrameTimestampMs,
        sourceTimestampBasis: this.xrFrameSampleSequence === 0 ? "unknown" : "performance-time-origin",
        sourceAgeMs,
        sessionVisibility,
      }),
      referenceSpace: this.xrReferenceSpaceType,
      headPose,
      trackedInputs: Object.freeze(trackedInputs),
      ...(primarySource ? { primaryInputSourceId: this.xrSourceId(primarySource) } : {}),
      ...(activeSource ? { activeInputSourceId: this.xrSourceId(activeSource) } : {}),
      ...(ray ? { primaryRay: ray.primaryRay, ...(ray.rayHit ? { rayHit: ray.rayHit } : {}) } : {}),
      ...(this.xrSpatialPin ? { spatialPin: this.xrSpatialPin } : {}),
      playerCapsule: Object.freeze({
        // Room-scale walking changes the HMD's X/Z independently of the rig.
        // The reference-space floor remains authoritative for Y.
        feet: Object.freeze({ x: headPosition.x, y: rigFloor.y, z: headPosition.z }),
        radius: 0.3,
        height: playerHeight,
      }),
    });
  }

  /** Preserve the runtime's own XR animation-frame clock and pose health. */
  private recordXRFrameSample(time: number, frame: XRFrame | undefined): void {
    if (!frame || !Number.isFinite(time) || time < 0 || !this.renderer || !this.xrSession) return;
    this.xrFrameSampleSequence += 1;
    this.xrLastFrameTimestampMs = time;
    const sources = Array.from(this.xrSession.inputSources);
    for (const source of sources) {
      this.updateXRInputActivity(source, this.captureXRInputActions(source));
    }
    for (const source of this.xrPreviousActionStates.keys()) {
      if (!sources.includes(source)) {
        this.xrPreviousActionStates.delete(source);
      }
    }
    if (this.xrActiveInputSource && !sources.includes(this.xrActiveInputSource)) {
      this.xrActiveInputSource = null;
    }
    const xrManager = this.renderer.xr as THREE.WebXRManager & Readonly<{
      getReferenceSpace?(): XRReferenceSpace | null;
    }>;
    const referenceSpace = xrManager.getReferenceSpace?.();
    if (!referenceSpace) {
      this.xrHeadPoseState = "unknown";
      return;
    }
    try {
      const viewerPose = frame.getViewerPose(referenceSpace);
      this.xrHeadPoseState = viewerPose
        ? viewerPose.emulatedPosition ? "emulated" : "tracked"
        : "unavailable";
    } catch {
      this.xrHeadPoseState = "unknown";
    }

    for (const source of sources) {
      this.xrInputTrackingStates.set(
        source,
        xrFramePoseState(frame, source.targetRaySpace, referenceSpace),
      );
      if (source.gripSpace) {
        this.xrGripTrackingStates.set(
          source,
          xrFramePoseState(frame, source.gripSpace, referenceSpace),
        );
      } else {
        this.xrGripTrackingStates.set(source, "unavailable");
      }
    }
    for (const source of this.xrInputTrackingStates.keys()) {
      if (!sources.includes(source)) this.xrInputTrackingStates.delete(source);
    }
    for (const source of this.xrGripTrackingStates.keys()) {
      if (!sources.includes(source)) this.xrGripTrackingStates.delete(source);
    }
  }

  private captureXRInputActions(source: XRInputSource): XRInputActionState {
    const gamepad = source.gamepad;
    // Only the WebXR standard mapping has stable semantic indices. Unknown
    // vendor layouts stay explicitly unavailable instead of being guessed.
    const available = Boolean(gamepad && String(gamepad.mapping) === "xr-standard");
    if (!gamepad || !available) return EMPTY_XR_INPUT_ACTIONS;
    return Object.freeze({
      available: true,
      selectPressed: this.xrSelectPressedSources.has(source) || xrButtonPressed(gamepad, 0),
      squeezePressed: this.xrSqueezePressedSources.has(source) || xrButtonPressed(gamepad, 1),
      primaryButtonPressed: xrButtonPressed(gamepad, 4),
      secondaryButtonPressed: xrButtonPressed(gamepad, 5),
      thumbstickPressed: xrButtonPressed(gamepad, 3),
      thumbstick: Object.freeze({
        x: xrAxis(gamepad, 2),
        y: xrAxis(gamepad, 3),
      }),
    });
  }

  private updateXRInputActivity(source: XRInputSource, actions: XRInputActionState): void {
    const previous = this.xrPreviousActionStates.get(source);
    this.xrPreviousActionStates.set(source, actions);
    if (previous && xrActionActivityChanged(previous, actions)) {
      this.xrActiveInputSource = source;
    }
  }

  /** Replace the renderer-only immersive projection for one Workspace revision. */
  setXRWorldPanels(
    panels: readonly ThreeRendererXRWorldPanel[],
    workspaceRevision?: number,
  ): void {
    if (this.xrSpatialPin && workspaceRevision !== this.xrSpatialPin.placedAtWorkspaceRevision) {
      this.clearXRSpatialPin(false, true);
    }
    this.pendingXRWorldPanels = Object.freeze([...panels]);
    this.pendingXRWorkspaceRevision = workspaceRevision;
    this.xrWorldPanelLayer?.setPanels(this.pendingXRWorldPanels, workspaceRevision);
  }

  setXRPanelActionHandler(handler: ThreeRendererOptions["onXRPanelAction"]): void {
    this.xrPanelActionHandler = handler;
  }

  setXRPanelWarningHandler(handler: ThreeRendererOptions["onXRPanelWarning"]): void {
    this.xrPanelWarningHandler = handler;
  }

  setXRVoiceFeedback(feedback: ThreeRendererXRVoiceFeedback): void {
    this.pendingXRVoiceFeedback = Object.freeze({ ...feedback });
    this.xrVoiceFeedbackLayer?.setFeedback(this.isXRPresenting()
      ? this.pendingXRVoiceFeedback
      : Object.freeze({ phase: "hidden" }));
  }

  setMaterializationMode(mode: MaterializationMode): void {
    this.materializationMode = mode;
    if (mode === "off") this.materializationController?.cancel(true);
  }

  /** Best-effort WebXR haptics. Visual feedback always remains authoritative. */
  pulseXRVoiceHaptics(cue: ThreeRendererXRVoiceHapticCue): void {
    if (!this.xrSession) return;
    const pattern = cue === "draft_ready"
      ? [{ intensity: 0.28, durationMs: 35, delayMs: 0 }, { intensity: 0.35, durationMs: 45, delayMs: 80 }]
      : cue === "error"
        ? [{ intensity: 0.5, durationMs: 45, delayMs: 0 }, { intensity: 0.5, durationMs: 45, delayMs: 70 }, { intensity: 0.5, durationMs: 55, delayMs: 140 }]
        : [{
            intensity: cue === "sent" || cue === "reply_ready" ? 0.42 : 0.25,
            durationMs: cue === "sent" || cue === "reply_ready" ? 75 : 35,
            delayMs: 0,
          }];
    for (const source of this.xrSession.inputSources) {
      const gamepad = source.gamepad as XRGamepadLike | undefined;
      const actuator = gamepad?.hapticActuators?.[0] ?? gamepad?.vibrationActuator;
      if (!actuator) continue;
      for (const pulse of pattern) {
        globalThis.setTimeout(() => {
          try {
            void Promise.resolve(actuator.pulse(pulse.intensity, pulse.durationMs)).catch(() => undefined);
          } catch {
            // Haptics are an optional cue; unsupported runtimes keep visual/audio feedback.
          }
        }, pulse.delayMs);
      }
    }
  }

  setSelectedEntity(entityId: EntityId | null, notify = true): void {
    if (entityId !== null && (!this.entities.has(entityId)
      || !isEntityVisuallyPresent(this.currentState?.entities.get(entityId))
      || this.materializationController?.isEntityInteractive(entityId) === false)) entityId = null;
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
      || this.materializationController?.isEntityInteractive(entityId) === false
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

  /** Cancel only desktop DOM gestures; an immersive WebXR session stays live. */
  cancelDesktopInteractions(): void {
    this.pointerOrigin = null;
    const canvas = this.renderer?.domElement;
    if (!canvas) {
      this.activeDesktopPointerIds.clear();
      return;
    }
    const PointerEventConstructor = canvas.ownerDocument.defaultView?.PointerEvent;
    for (const pointerId of [...this.activeDesktopPointerIds].reverse()) {
      let event: Event;
      if (PointerEventConstructor) {
        event = new PointerEventConstructor("pointercancel", {
          pointerId,
          bubbles: false,
          cancelable: true,
        });
      } else {
        event = new Event("pointercancel", { bubbles: false, cancelable: true });
        Object.defineProperty(event, "pointerId", { configurable: true, value: pointerId });
      }
      canvas.dispatchEvent(event);
      try {
        if (canvas.hasPointerCapture?.(pointerId) !== false) {
          canvas.releasePointerCapture?.(pointerId);
        }
      } catch {
        // OrbitControls may already have released capture while handling cancel.
      }
    }
    this.activeDesktopPointerIds.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const activeXRSession = this.xrSession;
    if (activeXRSession) {
      void activeXRSession.end().catch(() => undefined);
      void this.cleanupXRSession(activeXRSession);
    }
    this.xrWorldPanelLayer?.dispose();
    this.xrWorldPanelLayer = null;
    this.xrVoiceFeedbackLayer?.dispose();
    this.xrVoiceFeedbackLayer = null;
    this.xrSpatialPinLayer?.dispose();
    this.xrSpatialPinLayer = null;
    this.xrSpatialPin = undefined;
    this.pendingXRVoiceFeedback = Object.freeze({ phase: "hidden" });
    this.pendingXRWorldPanels = Object.freeze([]);
    this.pendingXRWorkspaceRevision = undefined;
    this.clearRealityMeasurement(false);
    this.lifecycleToken += 1;
    this.activeStateRenderAbort?.abort("renderer_disposed");
    this.activeStateRenderAbort = null;
    this.cancelTweens();
    this.materializationController?.dispose();
    this.materializationController = null;
    this.materializationLayer = null;
    this.lastMaterializationBatchKey = null;
    this.reducedMotionQuery?.removeEventListener?.("change", this.handleReducedMotionChange);
    this.reducedMotionQuery = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancelDesktopInteractions();
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
    this.materializationController?.cancel(true);
  }

  private requireInitialized(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.controls) {
      throw new Error("ThreeRenderer must be initialized before rendering scene state.");
    }
  }

  private enqueueStateRender(
    task: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const lifecycleToken = this.lifecycleToken;
    const generation = this.stateRenderGeneration + 1;
    this.stateRenderGeneration = generation;
    this.activeStateRenderAbort?.abort("superseded_state_render");
    for (const controller of this.realityLoads.values()) controller.abort("superseded_state_render");
    const abort = new AbortController();
    this.activeStateRenderAbort = abort;
    const isCurrent = () => !this.disposed
      && !abort.signal.aborted
      && lifecycleToken === this.lifecycleToken
      && generation === this.stateRenderGeneration;
    const queued = this.stateRenderQueue.then(async () => {
      if (!isCurrent()) return;
      try {
        await task(isCurrent, abort.signal);
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        if (this.activeStateRenderAbort === abort) this.activeStateRenderAbort = null;
      }
    });
    this.stateRenderQueue = queued.catch(() => undefined);
    return queued;
  }

  private async ensureEntity(
    entity: EntityState,
    isCurrent: () => boolean = () => !this.disposed,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProceduralEntity> {
    if (!isCurrent() || signal.aborted) throw new DOMException("Entity render was superseded.", "AbortError");
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
      const abortRealityLoad = () => controller.abort(signal.reason ?? "superseded_state_render");
      signal.addEventListener("abort", abortRealityLoad, { once: true });
      this.realityLoads.set(entity.id, controller);
      let root: ProceduralEntity;
      try {
        root = await this.waitForEntityRoot(
          entity,
          this.createRealityEntity(entity, controller.signal),
          signal,
          () => controller.abort("entity_load_deadline"),
        );
      } finally {
        signal.removeEventListener("abort", abortRealityLoad);
        if (this.realityLoads.get(entity.id) === controller) this.realityLoads.delete(entity.id);
      }
      if (this.disposed || controller.signal.aborted || !isCurrent()) {
        this.disposeAbandonedEntityRoot(entity, root);
        return root;
      }
      root.userData.renderIdentity = identity;
      this.entityLayer.add(root);
      this.entities.set(entity.id, root);
      return root;
    }
    if (entity.renderGeometry?.kind === "cad") {
      const root = await this.waitForEntityRoot(entity, this.createCadEntity(entity), signal);
      if (this.disposed || !isCurrent()) {
        this.disposeAbandonedEntityRoot(entity, root);
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
        root = await this.waitForEntityRoot(entity, this.gltfAssets.instantiate(record, entity), signal);
      } catch (error) {
        if (signal.aborted || !isCurrent()) throw error;
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
    if (this.disposed || !isCurrent()) {
      this.disposeAbandonedEntityRoot(entity, root);
      return root;
    }
    root.userData.renderIdentity = identity;
    this.entityLayer.add(root);
    this.entities.set(entity.id, root);
    return root;
  }

  private waitForEntityRoot(
    entity: EntityState,
    pending: Promise<ProceduralEntity>,
    signal: AbortSignal,
    onAbandon: () => void = () => undefined,
  ): Promise<ProceduralEntity> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        globalThis.clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abandon = (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        onAbandon();
        reject(cause);
      };
      const abort = () => abandon(new DOMException("Entity render was superseded.", "AbortError"));
      const timer = globalThis.setTimeout(() => {
        abandon(new Error(`Entity ${entity.id} did not finish rendering within ${ENTITY_LOAD_TIMEOUT_MS}ms.`));
      }, ENTITY_LOAD_TIMEOUT_MS);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      void pending.then((root) => {
        if (settled) {
          this.disposeAbandonedEntityRoot(entity, root);
          return;
        }
        settled = true;
        cleanup();
        resolve(root);
      }, (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      });
    });
  }

  private disposeAbandonedEntityRoot(entity: EntityState, root: ProceduralEntity): void {
    if (this.entities.get(entity.id) === root) return;
    if (entity.renderGeometry?.kind === "reality") {
      const handle = this.realityRuntime?.getHandle(entity.id);
      if (handle?.root === root) {
        this.realityRuntime?.remove(entity.id);
        return;
      }
    }
    disposeObject(root);
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

  /**
   * Attach ready roots only after their entire parent chain exists. This keeps
   * asynchronously loaded children at their authoritative local transform and
   * prevents a one-frame flash in the entity layer while a parent is loading.
   */
  private attachMaterializationRoots(
    state: Readonly<SceneState>,
    addedEntityIds: readonly EntityId[],
    batchKey: string,
  ): void {
    const controller = this.materializationController;
    if (!controller?.isActive()) return;
    this.reconcileHierarchy(state);
    for (const id of addedEntityIds) {
      const entity = state.entities.get(id);
      const root = this.entities.get(id);
      if (!entity || !root || !this.entityAncestorsAreReady(entity, state)) continue;
      this.setEntityTransform(root, this.targetTransform(entity), false);
      if (root.userData.materializationBatchKey === batchKey) continue;
      this.applyEntityPresentation(entity, root, true);
      root.userData.materializationBatchKey = batchKey;
      controller.attach(id, root, entityVisualEffects(entity), isEntityVisuallyPresent(entity));
    }
  }

  private entityAncestorsAreReady(entity: EntityState, state: Readonly<SceneState>): boolean {
    const visited = new Set<EntityId>([entity.id]);
    let parentId = entity.parentId;
    while (parentId) {
      if (visited.has(parentId) || !this.entities.has(parentId)) return false;
      visited.add(parentId);
      parentId = state.entities.get(parentId)?.parentId;
    }
    return true;
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

  private async reconcileRealityAfterContextRestore(
    isCurrent: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
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
        root = await this.ensureEntity(entity, isCurrent, signal);
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
    this.xrWorldPanelLayer?.worldRoot.position.copy(renderedOrigin);
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

  private renderFrame = (time: number, frame?: XRFrame): void => {
    if (!this.renderer || !this.scene || !this.camera || !this.controls || this.disposed) return;
    this.materializationController?.update(time);
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
    if (!this.renderer.xr.isPresenting) {
      this.controls.update();
      this.rebaseFromLiveTarget();
    } else {
      this.recordXRFrameSample(time, frame);
      this.xrVoiceFeedbackLayer?.updatePose(this.renderer.xr.getCamera());
      this.xrSpatialPinLayer?.update(this.renderer.xr.getCamera());
    }
    this.updateAdaptiveClipping();
    this.selectionHelper?.update();
    // EffectComposer is not assumed to be multiview-safe. XR uses the direct
    // renderer path; Standard desktop rendering retains the existing effects.
    if (this.composer && !this.renderer.xr.isPresenting) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  };

  private installXRControllers(): void {
    if (!this.renderer || !this.scene || this.xrControllers.length) return;
    for (let index = 0; index < 2; index += 1) {
      const controller = this.renderer.xr.getController(index) as XRControllerObject;
      const xrManager = this.renderer.xr as THREE.WebXRManager & Readonly<{
        getControllerGrip?(controllerIndex: number): THREE.Object3D;
      }>;
      const grip = xrManager.getControllerGrip?.(index);
      controller.name = `xr-controller-${index}`;
      if (grip) {
        grip.name = `xr-controller-grip-${index}`;
        this.xrGripByController.set(controller, grip);
        this.xrControllerGrips.push(grip);
        this.xrRig.add(grip);
      }
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ]);
      const material = new THREE.LineBasicMaterial({ color: 0x68d5ff, transparent: true, opacity: 0.85 });
      const ray = new THREE.Line(geometry, material);
      ray.name = "xr-target-ray";
      ray.scale.z = 5;
      ray.raycast = () => undefined;
      controller.add(ray);
      const handlers: XRControllerHandlers = {
        connected: (event) => {
          const source = event.data;
          const previousSource = this.xrInputSourceByController.get(controller);
          if (previousSource) {
            this.xrControllerByInputSource.delete(previousSource);
            this.xrGripByInputSource.delete(previousSource);
            this.xrInputTrackingStates.delete(previousSource);
            this.xrGripTrackingStates.delete(previousSource);
            this.xrPreviousActionStates.delete(previousSource);
            this.xrSelectPressedSources.delete(previousSource);
            this.xrSqueezePressedSources.delete(previousSource);
            if (this.xrActiveInputSource === previousSource) this.xrActiveInputSource = null;
          }
          if (source) {
            this.xrControllerByInputSource.set(source, controller);
            this.xrInputSourceByController.set(controller, source);
            if (grip) this.xrGripByInputSource.set(source, grip);
            this.xrSourceId(source);
          }
          this.xrControllerMetadata.set(controller, Object.freeze({
            input: source?.hand ? "hand" : "controller",
            handedness: source?.handedness === "left" || source?.handedness === "right"
              ? source.handedness
              : "none",
          }));
        },
        disconnected: () => {
          this.releaseXRPushToTalk(controller, "cancelled");
          const source = this.xrInputSourceByController.get(controller);
          if (source) {
            this.xrControllerByInputSource.delete(source);
            this.xrGripByInputSource.delete(source);
            this.xrInputSourceIds.delete(source);
            this.xrInputTrackingStates.delete(source);
            this.xrGripTrackingStates.delete(source);
            this.xrPreviousActionStates.delete(source);
            this.xrSelectPressedSources.delete(source);
            this.xrSqueezePressedSources.delete(source);
            if (this.xrActiveInputSource === source) this.xrActiveInputSource = null;
          }
          this.xrInputSourceByController.delete(controller);
          this.xrControllerMetadata.delete(controller);
        },
        select: () => {
          this.markXRInputActive(controller);
          if (this.xrControllerMetadata.get(controller)?.input !== "hand") this.handleXRSelect(controller);
        },
        selectstart: () => {
          this.markXRInputActive(controller, "select", true);
          if (this.xrControllerMetadata.get(controller)?.input === "hand") {
            if (this.dispatchXRVoiceModalAction(controller, "hand_select")) return;
            this.pressXRPushToTalk(controller);
          }
        },
        selectend: () => {
          this.markXRInputActive(controller, "select", false);
          if (this.xrControllerMetadata.get(controller)?.input === "hand") {
            this.releaseXRPushToTalk(controller, "released");
          }
        },
        squeezestart: () => {
          this.markXRInputActive(controller, "squeeze", true);
          if (this.xrControllerMetadata.get(controller)?.input !== "hand") {
            this.pressXRPushToTalk(controller);
          }
        },
        squeezeend: () => {
          this.markXRInputActive(controller, "squeeze", false);
          if (this.xrControllerMetadata.get(controller)?.input !== "hand") {
            this.releaseXRPushToTalk(controller, "released");
          }
        },
      };
      for (const [type, handler] of Object.entries(handlers)) {
        controller.addEventListener(type, handler);
      }
      this.xrControllerHandlers.set(controller, handlers);
      this.xrRig.add(controller);
      this.xrControllers.push(controller);
    }
  }

  private markXRInputActive(
    controller: XRControllerObject,
    action?: "select" | "squeeze",
    pressed?: boolean,
  ): void {
    const source = this.xrInputSourceByController.get(controller);
    if (!source) return;
    this.xrActiveInputSource = source;
    if (action === "select") {
      if (pressed) this.xrSelectPressedSources.add(source);
      else this.xrSelectPressedSources.delete(source);
    }
    if (action === "squeeze") {
      if (pressed) this.xrSqueezePressedSources.add(source);
      else this.xrSqueezePressedSources.delete(source);
    }
  }

  private pressXRPushToTalk(controller: XRControllerObject): void {
    if (this.xrActivePushToTalk) return;
    const metadata = this.xrControllerMetadata.get(controller)
      ?? Object.freeze({ input: "controller", handedness: "none" } as const);
    this.xrActivePushToTalk = Object.freeze({ controller, metadata });
    this.options.onXRPushToTalk?.(Object.freeze({ phase: "pressed", ...metadata }));
  }

  private releaseXRPushToTalk(
    controller: XRControllerObject,
    phase: "released" | "cancelled",
  ): void {
    const active = this.xrActivePushToTalk;
    if (!active || active.controller !== controller) return;
    this.xrActivePushToTalk = null;
    this.options.onXRPushToTalk?.(Object.freeze({ phase, ...active.metadata }));
  }

  private captureXRRay(controller: XRControllerObject): Readonly<{
    primaryRay: XRControllerRay;
    rayHit?: XRRayHit;
  }> {
    controller.updateWorldMatrix(true, false);
    const renderOrigin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
    const semanticOrigin = renderOrigin.clone().add(this.renderOrigin);
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(controller.matrixWorld).normalize();
    const maxDistance = 40;
    const primaryRay: XRControllerRay = Object.freeze({
      origin: xrVec3(semanticOrigin),
      direction: xrVec3(direction),
      maxDistance,
    });
    const raycaster = new THREE.Raycaster(renderOrigin, direction, 0, maxDistance);
    const interactiveRoots = [...this.entities].flatMap(([id, root]) => root.visible
      && isEntityVisuallyPresent(this.currentState?.entities.get(id))
      && this.materializationController?.isEntityInteractive(id) !== false ? [root] : []);
    const intersections = raycaster.intersectObjects(interactiveRoots, true);
    const candidates: XRRayHit[] = [];
    const entityHit = intersections.find((entry) => {
      const entityId = entry.object.userData.entityId;
      if (typeof entityId !== "string") return false;
      // A Reality layer's transparent bounds proxy is for cheap selection,
      // not a visible surface and therefore cannot authorize a coordinate pin.
      return this.currentState?.entities.get(entityId)?.renderGeometry?.kind !== "reality";
    });
    if (entityHit) {
      const normal = worldNormalForIntersection(entityHit);
      candidates.push(Object.freeze({
        kind: "component",
        targetId: entityHit.object.userData.entityId as EntityId,
        point: xrVec3(entityHit.point.clone().add(this.renderOrigin)),
        normal: xrVec3(normal),
        distance: entityHit.distance,
      }));
    }
    const realityCandidateIds = new Set(intersections.flatMap((entry) => {
      const entityId = entry.object.userData.entityId;
      return entry.object.userData.realitySelectionProxy === true && typeof entityId === "string"
        ? [entityId]
        : [];
    }));
    for (const entityId of realityCandidateIds) {
      try {
        const realityHit = this.realityRuntime?.raycastSurface(entityId, raycaster);
        if (!realityHit) continue;
        candidates.push(Object.freeze({
          kind: "component",
          targetId: entityId,
          point: xrVec3(new THREE.Vector3(
            realityHit.worldPoint.x,
            realityHit.worldPoint.y,
            realityHit.worldPoint.z,
          ).add(this.renderOrigin)),
          // Spark exposes a visual LOD hit point but no stable surface normal.
          // Facing the marker back toward the ray is an explicit presentation
          // estimate; the context remains render-interaction-estimate authority.
          normal: xrVec3(direction.clone().negate()),
          distance: realityHit.cameraDistance,
        }));
      } catch {
        // A failed visual-surface query is a miss. Never fall back to the
        // invisible bounds proxy or invent a point at an arbitrary ray depth.
      }
    }
    const surfaceHit = this.environmentRoot
      ? raycaster.intersectObject(this.environmentRoot, true)[0]
      : undefined;
    if (surfaceHit) {
      const normal = worldNormalForIntersection(surfaceHit);
      candidates.push(Object.freeze({
        kind: normal.y >= 0.55 ? "ground" : "surface",
        point: xrVec3(surfaceHit.point.clone().add(this.renderOrigin)),
        normal: xrVec3(normal),
        distance: surfaceHit.distance,
      }));
    }
    const rayHit = candidates.reduce<XRRayHit | undefined>((nearest, candidate) => (
      !nearest || candidate.distance < nearest.distance ? candidate : nearest
    ), undefined);
    // Empty space is deliberately a miss: maxDistance describes the query
    // bound, not a user-observed surface and not a substitute coordinate.
    if (!rayHit) return Object.freeze({ primaryRay });
    return Object.freeze({
      primaryRay,
      rayHit,
    });
  }

  private xrSourceId(source: XRInputSource): string {
    const current = this.xrInputSourceIds.get(source);
    if (current) return current;
    const id = `input-${++this.xrInputSourceSequence}-${source.handedness || "none"}`;
    this.xrInputSourceIds.set(source, id);
    return id;
  }

  private placeXRSpatialPin(controller: XRControllerObject, source: XRInputSource): boolean {
    const workspaceRevision = this.pendingXRWorkspaceRevision;
    const ray = this.captureXRRay(controller);
    if (!Number.isSafeInteger(workspaceRevision) || (workspaceRevision ?? -1) < 0 || !ray.rayHit) {
      this.xrSpatialPinLayer?.showMiss();
      this.pulseXRSpatialPin(source, false);
      return false;
    }
    const hit = ray.rayHit;
    const pinSequence = ++this.xrSpatialPinSequence;
    const pin: XRSpatialPin = Object.freeze({
      pinId: `xr-pin-${pinSequence.toString(36)}`,
      pinSequence,
      workspacePositionM: Object.freeze({ ...hit.point }),
      surfaceNormal: Object.freeze({ ...hit.normal }),
      hitKind: hit.kind,
      ...(hit.targetId ? { targetComponentId: hit.targetId } : {}),
      sourceId: this.xrSourceId(source),
      handedness: source.handedness || "none",
      placedAtMs: Date.now(),
      placedAtWorkspaceRevision: workspaceRevision!,
      coordinateSpace: "workspace-world-rub",
      units: "metre",
      authority: "render-interaction-estimate",
    });
    this.xrSpatialPin = pin;
    this.xrSpatialPinLayer?.setPin(pin);
    this.pulseXRSpatialPin(source, true);
    this.options.onXRSpatialPinChange?.(Object.freeze({ action: "placed", pin }));
    return true;
  }

  private clearXRSpatialPin(showFeedback: boolean, notify: boolean): boolean {
    if (!this.xrSpatialPin) return false;
    this.xrSpatialPin = undefined;
    this.xrSpatialPinLayer?.clear(showFeedback);
    if (notify) this.options.onXRSpatialPinChange?.(Object.freeze({ action: "cleared" }));
    return true;
  }

  private pulseXRSpatialPin(source: XRInputSource, success: boolean): void {
    const gamepad = source.gamepad as XRGamepadLike | undefined;
    const actuator = gamepad?.hapticActuators?.[0] ?? gamepad?.vibrationActuator;
    if (!actuator) return;
    try {
      void Promise.resolve(actuator.pulse(success ? 0.38 : 0.55, success ? 65 : 40)).catch(() => undefined);
    } catch {
      // The visible marker/status remains authoritative when haptics are absent.
    }
  }

  private handleXRSelect(controller: XRControllerObject): void {
    if (!this.scene || !this.camera || !this.renderer?.xr.isPresenting) return;
    if (this.dispatchXRVoiceModalAction(controller, "select")) return;
    controller.updateMatrixWorld(true);
    const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
    const direction = new THREE.Vector3(0, 0, -1)
      .transformDirection(controller.matrixWorld)
      .normalize();
    const raycaster = new THREE.Raycaster(origin, direction, 0, 40);
    // Immersive panels are a foreground interaction layer. Any panel hit is
    // consumed before selecting a world entity or teleporting through it.
    if (this.xrWorldPanelLayer?.activateFirstHit(raycaster)) return;
    const interactiveRoots = [...this.entities].flatMap(([id, root]) => root.visible
      && isEntityVisuallyPresent(this.currentState?.entities.get(id))
      && this.materializationController?.isEntityInteractive(id) !== false
      ? [root]
      : []);
    const entityHit = raycaster.intersectObjects(interactiveRoots, true)
      .find((entry) => typeof entry.object.userData.entityId === "string");
    if (entityHit) {
      const entityId = entityHit.object.userData.entityId as EntityId;
      const now = globalThis.performance?.now?.() ?? Date.now();
      const activate = this.xrLastEntitySelect?.entityId === entityId
        && now - this.xrLastEntitySelect.atMs <= 650;
      this.setSelectedEntity(entityId);
      if (activate) {
        this.xrLastEntitySelect = null;
        this.options.onActivateEntity?.(entityId);
      } else {
        this.xrLastEntitySelect = Object.freeze({ entityId, atMs: now });
      }
      return;
    }
    this.xrLastEntitySelect = null;
    this.setSelectedEntity(null);
    if (!this.xrTeleportEnabled
      || this.xrReferenceSpaceType === "local"
      || !this.environmentRoot
      || !this.currentState) return;
    const groundHit = raycaster.intersectObject(this.environmentRoot, true)
      .find((entry) => {
        if (!isXRTeleportWalkableEnvironmentObject(entry.object)) return false;
        return worldNormalForIntersection(entry).y >= 0.55;
      });
    if (!groundHit) return;

    const colliderEntities: Array<{
      id: string;
      root: THREE.Object3D;
      collision: NonNullable<EntityState["collision"]>;
    }> = [];
    for (const id of this.entities.keys()) {
      // A rendered root without matching semantic state is unsafe to omit.
      if (!this.currentState.entities.has(id)) return;
    }
    for (const [id, entity] of this.currentState.entities) {
      if (!isEntityVisuallyPresent(entity)
        || !isXRTeleportBlockingEntity(entity, this.currentState.entities)) continue;
      const root = this.entities.get(id) ?? this.materializationController?.getCollisionRoot(id);
      // A visible physical entity that has not produced render bounds yet is
      // still a potential collider, so teleport waits instead of guessing.
      if (!root?.visible) return;
      colliderEntities.push({ id, root, collision: entity.collision! });
    }
    // The WebXR camera carries the current HMD pose. The base perspective
    // camera can lag or omit the per-frame viewer offset on some runtimes.
    const cameraWorld = new THREE.Vector3();
    this.renderer.xr.getCamera().getWorldPosition(cameraWorld);
    const rigWorld = new THREE.Vector3();
    this.xrRig.getWorldPosition(rigWorld);
    const plan = planThreeRendererTeleport({
      rayOrigin: origin,
      rayDirection: direction,
      maxDistance: 40,
      headWorldPosition: cameraWorld,
      rigWorldPosition: rigWorld,
      renderOrigin: this.renderOrigin,
      walkableSurface: groundHit.object,
      environmentRoot: this.environmentRoot,
      entities: colliderEntities,
    });
    if (!plan.valid) return;
    this.xrRig.position.x += plan.rigDelta.x;
    this.xrRig.position.y += plan.rigDelta.y;
    this.xrRig.position.z += plan.rigDelta.z;
    this.options.onXRTeleport?.({
      position: plan.targetFeet,
    });
  }

  private dispatchXRVoiceModalAction(
    controller: XRControllerObject,
    source: "select" | "confirm_button" | "cancel_button" | "hand_select",
  ): boolean {
    const actions = this.pendingXRVoiceFeedback.actions ?? [];
    const metadata = this.xrControllerMetadata.get(controller)
      ?? Object.freeze({ input: "controller", handedness: "none" } as const);
    let phase: ThreeRendererXRPushToTalkEvent["phase"] | undefined;
    const hasCancel = actions.includes("cancel") || actions.includes("stop");
    const primaryPhase = actions.includes("confirm")
      ? "confirmed"
      : actions.includes("replay")
        ? "replay"
        : undefined;
    if (source === "hand_select" && hasCancel && primaryPhase) {
      // Hand tracking has no A/B buttons. Keep the staged-draft decision
      // unambiguous: right pinch performs the primary action; left pinch
      // cancels. A runtime that reports no handedness gets the primary action.
      phase = metadata.handedness === "left" ? "cancelled" : primaryPhase;
    } else if (source === "hand_select" && hasCancel) {
      phase = "cancelled";
    } else if (source === "hand_select" && primaryPhase) {
      phase = primaryPhase;
    } else if (source === "cancel_button" && hasCancel) {
      phase = "cancelled";
    } else if (source !== "cancel_button") {
      phase = primaryPhase;
    }
    if (!phase) return false;
    this.options.onXRPushToTalk?.(Object.freeze({ phase, ...metadata }));
    return true;
  }

  private startXRVoiceButtonLoop(session: XRSession): void {
    const animationSession = session as XRSession & Readonly<{
      requestAnimationFrame?(callback: XRFrameRequestCallback): number;
      cancelAnimationFrame?(handle: number): void;
    }>;
    if (!animationSession.requestAnimationFrame) return;
    if (this.xrVoiceButtonFrame !== null) animationSession.cancelAnimationFrame?.(this.xrVoiceButtonFrame);
    this.xrVoiceButtonStates.clear();
    const tick = () => {
      if (this.xrSession !== session) return;
      const sources = Array.from(session.inputSources);
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index]!;
        const gamepad = source.gamepad;
        if (!gamepad) continue;
        const next = Object.freeze({
          confirm: Boolean(gamepad.buttons[4]?.pressed),
          cancel: Boolean(gamepad.buttons[5]?.pressed),
        });
        const previous = this.xrVoiceButtonStates.get(source)
          ?? Object.freeze({ confirm: next.confirm, cancel: next.cancel });
        const controller = this.xrControllerByInputSource.get(source);
        if (controller && next.confirm && !previous.confirm) {
          this.markXRInputActive(controller);
          if (!this.dispatchXRVoiceModalAction(controller, "confirm_button")) {
            this.placeXRSpatialPin(controller, source);
          }
        }
        if (controller && next.cancel && !previous.cancel) {
          this.markXRInputActive(controller);
          if (!this.dispatchXRVoiceModalAction(controller, "cancel_button")
            && this.clearXRSpatialPin(true, true)) this.pulseXRSpatialPin(source, true);
        }
        this.xrVoiceButtonStates.set(source, next);
      }
      for (const source of this.xrVoiceButtonStates.keys()) {
        if (!sources.includes(source)) this.xrVoiceButtonStates.delete(source);
      }
      this.xrVoiceButtonFrame = animationSession.requestAnimationFrame!(tick);
    };
    this.xrVoiceButtonFrame = animationSession.requestAnimationFrame(tick);
  }

  private readonly handleXRSessionEnd = (): void => {
    const session = this.xrSession;
    if (session) void this.enqueueXRLifecycle(() => this.cleanupXRSession(session));
  };

  private async cleanupXRSession(session: XRSession): Promise<void> {
    if (this.xrSession !== session) return;
    if (this.xrVoiceButtonFrame !== null) {
      session.cancelAnimationFrame?.(this.xrVoiceButtonFrame);
      this.xrVoiceButtonFrame = null;
    }
    this.xrVoiceButtonStates.clear();
    this.clearXRSpatialPin(false, false);
    this.xrSpatialPinLayer?.clear(false);
    session.removeEventListener("end", this.handleXRSessionEnd);
    this.xrWorldPanelLayer?.setVisible(false);
    this.xrVoiceFeedbackLayer?.setFeedback(Object.freeze({ phase: "hidden" }));
    if (this.xrActivePushToTalk) {
      this.releaseXRPushToTalk(this.xrActivePushToTalk.controller, "cancelled");
    }
    for (const controller of this.xrControllers.splice(0)) {
      const handlers = this.xrControllerHandlers.get(controller);
      if (handlers) for (const [type, handler] of Object.entries(handlers)) {
        controller.removeEventListener(type, handler);
      }
      this.xrControllerHandlers.delete(controller);
      this.xrControllerMetadata.delete(controller);
      controller.traverse((object) => {
        if (object instanceof THREE.Line) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else material.dispose();
        }
      });
      controller.removeFromParent();
    }
    for (const grip of this.xrControllerGrips.splice(0)) grip.removeFromParent();
    this.xrControllerByInputSource.clear();
    this.xrInputSourceByController.clear();
    this.xrGripByInputSource.clear();
    this.xrGripByController.clear();
    this.xrInputSourceIds.clear();
    this.xrInputTrackingStates.clear();
    this.xrGripTrackingStates.clear();
    this.xrPreviousActionStates.clear();
    this.xrSelectPressedSources.clear();
    this.xrSqueezePressedSources.clear();
    this.xrActiveInputSource = null;
    this.xrFrameSampleSequence = 0;
    this.xrLastFrameTimestampMs = 0;
    this.xrHeadPoseState = "unknown";
    if (this.camera) {
      if (this.xrCameraParent) this.xrCameraParent.add(this.camera);
      else this.camera.removeFromParent();
      if (this.xrCameraPosition) this.camera.position.copy(this.xrCameraPosition);
      if (this.xrCameraQuaternion) this.camera.quaternion.copy(this.xrCameraQuaternion);
      this.camera.updateMatrixWorld(true);
    }
    this.xrRig.removeFromParent();
    this.controls && (this.controls.enabled = true);
    if (this.renderer) {
      this.renderer.xr.enabled = false;
      if (this.renderer.xr.getSession() === session) {
        await this.renderer.xr.setSession(null).catch(() => undefined);
      }
    }
    this.xrSession = null;
    this.xrLastEntitySelect = null;
    this.xrCameraParent = null;
    this.xrCameraPosition = null;
    this.xrCameraQuaternion = null;
  }

  private enqueueXRLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.xrLifecycleQueue.then(operation, operation);
    this.xrLifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private refreshPostProcessing(): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    if (this.options.expensiveLighting === false) {
      this.composer?.dispose();
      this.composer = null;
      this.bloomPass = null;
      return;
    }
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
    this.activeDesktopPointerIds.add(event.pointerId ?? 0);
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
    this.activeDesktopPointerIds.delete(event.pointerId ?? 0);
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
    this.activeDesktopPointerIds.delete(event.pointerId ?? 0);
    if (this.pointerOrigin?.pointerId === (event.pointerId ?? 0)) this.pointerOrigin = null;
  };

  private handleLostPointerCapture = (event: PointerEvent): void => {
    const pointerId = event.pointerId ?? 0;
    const origin = this.pointerOrigin;
    // OrbitControls releases pointer capture from its pointerup listener, which
    // may dispatch lostpointercapture before our pointerup listener runs. Defer
    // cleanup one microtask: a normal up/cancel removes the id in the same task;
    // an abnormal loss leaves it tracked, so synthesize cancel to reset the
    // controls' private pointer/state machine before the desktop can resume.
    queueMicrotask(() => {
      if (this.activeDesktopPointerIds.has(pointerId)) this.cancelDesktopInteractions();
      else if (origin && this.pointerOrigin === origin) this.pointerOrigin = null;
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
      && this.materializationController?.isEntityInteractive(id) !== false
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
    // GPU presentation helpers are not replayed after restoration. Semantic
    // roots are completed now and the restored context renders final state.
    this.materializationController?.cancel(true);
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
        : this.enqueueStateRender((isCurrent, signal) => this.reconcileRealityAfterContextRestore(isCurrent, signal)))
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

function xrVec3(value: THREE.Vector3): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function xrPose(position: THREE.Vector3, orientation: THREE.Quaternion): XRPose {
  return Object.freeze({
    position: xrVec3(position),
    orientation: Object.freeze({
      x: orientation.x,
      y: orientation.y,
      z: orientation.z,
      w: orientation.w,
    }),
  });
}

function xrFramePoseState(
  frame: XRFrame,
  space: XRSpace,
  referenceSpace: XRReferenceSpace,
): XRInputTrackingState {
  try {
    const pose = frame.getPose(space, referenceSpace);
    if (!pose) return "unavailable";
    return pose.emulatedPosition ? "emulated" : "tracked";
  } catch {
    return "unknown";
  }
}

function xrTargetRayMode(value: unknown): XRTargetRayMode {
  return value === "gaze"
    || value === "tracked-pointer"
    || value === "screen"
    || value === "transient-pointer"
    ? value
    : "unknown";
}

function xrSessionVisibility(value: unknown): XRSessionVisibilityState {
  return value === "visible" || value === "visible-blurred" || value === "hidden"
    ? value
    : "unknown";
}

function xrUserTrackingState(
  headPoseState: XRInputTrackingState,
  inputStates: readonly XRInputTrackingState[],
  visibility: XRSessionVisibilityState,
): XRUserTrackingState {
  if (visibility === "hidden" || headPoseState === "unavailable") return "lost";
  if (visibility === "visible-blurred"
    || headPoseState === "emulated"
    || inputStates.some((state) => state !== "tracked")) return "limited";
  if (headPoseState === "tracked" && visibility === "visible") return "tracked";
  if (headPoseState === "tracked") return "limited";
  return "unknown";
}

function xrButtonPressed(gamepad: Gamepad, index: number): boolean {
  return gamepad.buttons[index]?.pressed === true;
}

function xrAxis(gamepad: Gamepad, index: number): number {
  const value = gamepad.axes[index];
  return typeof value === "number" && Number.isFinite(value)
    ? THREE.MathUtils.clamp(value, -1, 1)
    : 0;
}

function xrActionActivityChanged(previous: XRInputActionState, next: XRInputActionState): boolean {
  if (!next.available) return false;
  return previous.selectPressed !== next.selectPressed
    || previous.squeezePressed !== next.squeezePressed
    || previous.primaryButtonPressed !== next.primaryButtonPressed
    || previous.secondaryButtonPressed !== next.secondaryButtonPressed
    || previous.thumbstickPressed !== next.thumbstickPressed
    || Math.abs(previous.thumbstick.x - next.thumbstick.x) >= XR_ACTIVE_AXIS_DELTA
    || Math.abs(previous.thumbstick.y - next.thumbstick.y) >= XR_ACTIVE_AXIS_DELTA;
}

function performanceNow(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

function worldNormalForIntersection(intersection: THREE.Intersection): THREE.Vector3 {
  const normal = intersection.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
  return normal.transformDirection(intersection.object.matrixWorld).normalize();
}

async function requestXRTargetFrameRate(session: XRSession, requested: number | undefined): Promise<void> {
  if (requested === undefined) return;
  if (!Number.isFinite(requested) || requested < 60 || requested > 144) {
    throw new RangeError("XR target frame rate must be between 60 and 144 Hz");
  }
  const adjustable = session as XRSession & Readonly<{
    supportedFrameRates?: Float32Array | readonly number[];
    updateTargetFrameRate?(rate: number): Promise<void>;
  }>;
  if (!adjustable.updateTargetFrameRate || !adjustable.supportedFrameRates) return;
  const supported = Array.from(adjustable.supportedFrameRates)
    .filter((rate) => Number.isFinite(rate) && rate >= 60 && rate <= requested)
    .sort((left, right) => right - left);
  const selected = supported[0];
  if (selected !== undefined) await adjustable.updateTargetFrameRate(selected);
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

function optionsProxyBudget(value: number | undefined): number {
  if (value === undefined) return 128;
  return Number.isFinite(value) ? Math.max(1, Math.min(512, Math.trunc(value))) : 128;
}

export function sceneDeltaHasSemanticChange(delta: SceneDelta): boolean {
  return delta.fromRevision !== delta.toRevision
    || delta.added.length > 0
    || delta.updated.length > 0
    || delta.removed.length > 0
    || delta.environmentChanged
    || delta.lightingChanged
    || delta.cameraChanged;
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
