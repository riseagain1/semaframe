import { InteractionRouter } from "../interaction/InteractionRouter";
import { SelectionCoordinator } from "../interaction/SelectionCoordinator";
import type { TransitionSpec, WorkspaceOperation } from "../protocol/workspaceTypes";
import {
  clonePlacement,
  toRenderSnapshot,
  type AnimationCompletionRequest,
  type CanvasViewTransform,
  type ComponentActivationRequest,
  type ComponentActionRequest,
  type HybridRendererStatus,
  type PlacementCommitRequest,
  type PlacementPreview,
  type ResizeCommitRequest,
  type ResizePolicyResolver,
  type ResizePreview,
  type WorkspaceComponentTransitions,
  type WorkspaceRenderComponent,
  type WorkspaceRenderCommit,
  type WorkspaceRenderSnapshot,
  type WorkspaceStateLike,
} from "./contracts";
import { Overlay2DRenderer } from "./Overlay2DRenderer";
import { ProjectionBridge } from "./ProjectionBridge";
import { ThreeComponentRenderer, type ThreeComponentRendererOptions } from "./ThreeComponentRenderer";

export type HybridCanvasRendererOptions = Readonly<{
  three?: ThreeComponentRenderer;
  threeOptions?: ThreeComponentRendererOptions;
  projection?: ProjectionBridge;
  selection?: SelectionCoordinator;
  now?: () => number;
  onSelect?: (componentId: string | null) => void;
  onActivate?: (request: ComponentActivationRequest) => void | Promise<void>;
  onAnimationComplete?: (request: AnimationCompletionRequest) => void | Promise<void>;
  onAction?: (request: ComponentActionRequest) => void | Promise<void>;
  reducedMotion?: boolean;
  onPreviewPlacement?: (preview: PlacementPreview) => void;
  onCancelPreview?: (preview: PlacementPreview) => void;
  onCommitPlacement?: (request: PlacementCommitRequest) => void | Promise<void>;
  getResizePolicy?: ResizePolicyResolver;
  onPreviewResize?: (preview: ResizePreview) => void;
  onCancelResize?: (preview: ResizePreview) => void;
  onCommitResize?: (request: ResizeCommitRequest) => void | Promise<void>;
  onStatus?: (status: HybridRendererStatus) => void;
}>;

/**
 * Coordinates the WebGL and accessible DOM/SVG projections without becoming
 * an authoritative state writer.
 */
export class HybridCanvasRenderer {
  readonly selection: SelectionCoordinator;
  readonly projection: ProjectionBridge;
  readonly three: ThreeComponentRenderer;
  readonly overlay: Overlay2DRenderer;

  private readonly options: HybridCanvasRendererOptions;
  private readonly interaction: InteractionRouter;
  private container: HTMLElement | null = null;
  private threeHost: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private selectionUnsubscribe: (() => void) | null = null;
  private committed: WorkspaceRenderSnapshot | null = null;
  private previews = new Map<string, PlacementPreview>();
  private resizePreviews = new Map<string, ResizePreview>();
  private initialized = false;
  private threeReady = false;
  private frameId: number | null = null;
  private lastCameraSignature = "";
  private lifecycleToken = 0;
  private renderQueue: Promise<void> = Promise.resolve();
  private readyStatusPublished = false;
  private readonly touchPoints = new Map<number, Readonly<{ x: number; y: number }>>();
  private lastPinchDistance: number | null = null;

  private readonly handleWheel = (event: WheelEvent) => {
    if (!this.container || event.deltaY === 0) return;
    const target = event.target instanceof Element ? event.target : null;
    // Native controls and scrollable component content retain their wheel.
    // Ctrl/Meta explicitly opts into canvas zoom from anywhere.
    const overComponent = Boolean(target?.closest("[data-workspace-component-id]"));
    const overThreeLayer = Boolean(target?.closest("[data-workspace-three-layer]"));
    if ((!overThreeLayer || overComponent) && !event.ctrlKey && !event.metaKey) return;
    const rect = this.container.getBoundingClientRect();
    const step = Math.pow(0.95, 0.9);
    const magnification = event.deltaY < 0 ? 1 / step : step;
    if (!overThreeLayer && this.threeReady) this.three.zoomBy(magnification);
    this.zoomCanvasAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, magnification);
  };

  private readonly handleNavigationKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable)) return;
    const key = event.key.toLowerCase();
    if (key !== "+" && key !== "=" && key !== "-" && key !== "_") return;
    // ThreeRenderer handles the 3D half of this same bubbling key event.
    const magnification = key === "-" || key === "_" ? 1 / 1.14 : 1 / 0.86;
    this.zoomCanvasAt(this.viewportCenter(), magnification);
  };

  private readonly handleTouchPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !(event.target instanceof Element)
      || !event.target.closest("[data-workspace-three-layer]")) return;
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.lastPinchDistance = this.pinchGeometry()?.distance ?? null;
  };

  private readonly handleTouchPointerMove = (event: PointerEvent) => {
    if (!this.container || !this.touchPoints.has(event.pointerId)) return;
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = this.pinchGeometry();
    if (!pinch || !this.lastPinchDistance || pinch.distance <= 0) {
      this.lastPinchDistance = pinch?.distance ?? null;
      return;
    }
    const rect = this.container.getBoundingClientRect();
    this.zoomCanvasAt(
      { x: pinch.center.x - rect.left, y: pinch.center.y - rect.top },
      pinch.distance / this.lastPinchDistance,
    );
    this.lastPinchDistance = pinch.distance;
  };

  private readonly handleTouchPointerEnd = (event: PointerEvent) => {
    this.touchPoints.delete(event.pointerId);
    this.lastPinchDistance = this.pinchGeometry()?.distance ?? null;
  };

  constructor(options: HybridCanvasRendererOptions = {}) {
    this.options = options;
    this.selection = options.selection ?? new SelectionCoordinator();
    this.projection = options.projection ?? new ProjectionBridge();
    this.three = options.three ?? new ThreeComponentRenderer({
      ...options.threeOptions,
      ...(options.reducedMotion !== undefined ? { reducedMotion: options.reducedMotion } : {}),
      onSelect: (id) => this.selection.select(id, "three"),
      onActivate: (id) => {
        Promise.resolve(options.onActivate?.({ componentId: id })).catch((error) => options.onStatus?.({
          kind: "three-error",
          message: error instanceof Error ? error.message : "Component activation failed.",
        }));
      },
      onAnimationComplete: (request) => {
        Promise.resolve(options.onAnimationComplete?.(request)).catch((error) => options.onStatus?.({
          kind: "three-error",
          message: error instanceof Error ? error.message : "Animation completion failed.",
        }));
      },
    });
    if (options.onAnimationComplete) {
      this.three.setAnimationCompletionHandler((request) => {
        Promise.resolve(options.onAnimationComplete?.(request)).catch((error) => options.onStatus?.({
          kind: "three-error",
          message: error instanceof Error ? error.message : "Animation completion failed.",
        }));
      });
    }
    this.overlay = new Overlay2DRenderer({
      now: options.now,
      onSelect: (id) => this.selection.select(id, "canvas"),
      onActivate: (id) => {
        Promise.resolve(options.onActivate?.({ componentId: id })).catch((error) => options.onStatus?.({
          kind: "overlay-error",
          message: error instanceof Error ? error.message : "Component activation failed.",
        }));
      },
      onAction: (request) => {
        Promise.resolve(options.onAction?.(request)).catch((error) => options.onStatus?.({
          kind: "overlay-error",
          message: error instanceof Error ? error.message : "Component action failed.",
        }));
      },
      getResizePolicy: (component) => options.getResizePolicy?.(component),
      onStatus: options.onStatus,
      reducedMotion: options.reducedMotion ?? options.threeOptions?.reducedMotion,
    });
    this.interaction = new InteractionRouter({
      selection: this.selection,
      getBaseRevision: () => this.committed?.revision ?? 0,
      getPlacement: (id) => this.effectiveSnapshot()?.components.find((component) => component.id === id)?.placement,
      getResizePolicy: (id) => {
        const component = this.effectiveSnapshot()?.components.find((candidate) => candidate.id === id);
        return component ? this.options.getResizePolicy?.(component) : undefined;
      },
      previewPlacement: (componentId, placement, originalPlacement) => {
        const preview = { componentId, placement, originalPlacement } as const;
        this.previews.set(componentId, preview);
        this.three.previewPlacement(componentId, placement);
        this.renderOverlay();
        this.options.onPreviewPlacement?.(preview);
      },
      cancelPreview: (componentId, originalPlacement) => {
        const preview = this.previews.get(componentId) ?? {
          componentId,
          placement: originalPlacement,
          originalPlacement,
        };
        this.previews.delete(componentId);
        this.three.clearPreview(componentId);
        this.renderOverlay();
        this.options.onCancelPreview?.(preview);
      },
      commitPlacement: (request) => this.options.onCommitPlacement?.(request),
      previewResize: (componentId, resize, originalResize, placement, originalPlacement) => {
        const preview: ResizePreview = {
          componentId,
          resize,
          originalResize,
          ...(placement ? { placement: clonePlacement(placement) } : {}),
          ...(originalPlacement ? { originalPlacement: clonePlacement(originalPlacement) } : {}),
        };
        this.resizePreviews.set(componentId, preview);
        if (placement && originalPlacement) {
          this.previews.set(componentId, {
            componentId,
            placement: clonePlacement(placement),
            originalPlacement: clonePlacement(originalPlacement),
          });
        }
        const component = this.effectiveSnapshot()?.components.find((candidate) => candidate.id === componentId);
        if (component?.placement.space === "world3d") this.three.previewPlacement(componentId, component.placement);
        this.renderOverlay();
        this.options.onPreviewResize?.(preview);
      },
      cancelResizePreview: (componentId, originalResize) => {
        const preview = this.resizePreviews.get(componentId) ?? {
          componentId,
          resize: originalResize,
          originalResize,
        };
        this.resizePreviews.delete(componentId);
        this.previews.delete(componentId);
        this.three.clearPreview(componentId);
        this.renderOverlay();
        this.options.onCancelResize?.(preview);
      },
      commitResize: (request) => this.options.onCommitResize?.(request),
      announceResize: (message) => this.overlay.announceResize(message),
      getCanvasZoom: () => this.projection.getCanvasView().zoom,
      onError: (error) => this.options.onStatus?.({
        kind: "overlay-error",
        message: error instanceof Error ? error.message : "Placement commit failed.",
      }),
    });
  }

  async initialize(container: HTMLElement): Promise<void> {
    if (this.initialized) return;
    const lifecycleToken = ++this.lifecycleToken;
    this.initialized = true;
    this.container = container;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.style.overflow = container.style.overflow || "hidden";

    const threeHost = container.ownerDocument.createElement("div");
    threeHost.className = "workspace-three-layer";
    threeHost.setAttribute("data-workspace-three-layer", "true");
    Object.assign(threeHost.style, { position: "absolute", inset: "0" });
    container.appendChild(threeHost);
    this.threeHost = threeHost;

    try {
      await this.three.initialize(threeHost);
      if (!this.initialized || lifecycleToken !== this.lifecycleToken) {
        this.three.dispose();
        return;
      }
      this.threeReady = true;
    } catch (error) {
      if (!this.initialized || lifecycleToken !== this.lifecycleToken) return;
      this.threeReady = false;
      this.options.onStatus?.({
        kind: "three-error",
        message: error instanceof Error ? error.message : "The 3D projection could not initialize.",
      });
    }

    const overlayHost = this.overlay.initialize(container);
    this.interaction.attach(overlayHost);
    container.addEventListener("wheel", this.handleWheel, { capture: true, passive: true });
    container.addEventListener("keydown", this.handleNavigationKey, true);
    container.addEventListener("pointerdown", this.handleTouchPointerDown, true);
    container.addEventListener("pointermove", this.handleTouchPointerMove, true);
    container.addEventListener("pointerup", this.handleTouchPointerEnd, true);
    container.addEventListener("pointercancel", this.handleTouchPointerEnd, true);
    this.selectionUnsubscribe = this.selection.subscribe(({ componentId }) => {
      this.overlay.setSelection(componentId);
      if (this.threeReady) this.three.setSelection(componentId);
      this.options.onSelect?.(componentId);
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.resize();
    this.startProjectionLoop();
  }

  async render(
    state: WorkspaceRenderSnapshot | WorkspaceStateLike,
    commit?: WorkspaceRenderCommit,
  ): Promise<void> {
    if (!this.initialized) throw new Error("HybridCanvasRenderer must be initialized before render().");
    const snapshot = toRenderSnapshot(state);
    const lifecycleToken = this.lifecycleToken;
    const queued = this.renderQueue.then(() => this.renderNow(snapshot, commit, lifecycleToken));
    this.renderQueue = queued.catch(() => undefined);
    return queued;
  }

  private async renderNow(
    snapshot: WorkspaceRenderSnapshot,
    commit: WorkspaceRenderCommit | undefined,
    lifecycleToken: number,
  ): Promise<void> {
    if (!this.initialized || lifecycleToken !== this.lifecycleToken) return;
    const previous = this.committed;
    const operations = renderOperationsForCommit(previous, snapshot, commit);
    const snapshotChanged = !previous
      || previous.workspaceId !== snapshot.workspaceId
      || previous.revision !== snapshot.revision;
    const transitions = snapshotChanged ? componentTransitionsForOperations(operations) : undefined;
    const revisionChanged = previous?.revision !== snapshot.revision;
    if (revisionChanged) {
      for (const componentId of this.previews.keys()) this.three.clearPreview(componentId);
      for (const componentId of this.resizePreviews.keys()) this.three.clearPreview(componentId);
      this.previews.clear();
      this.resizePreviews.clear();
    }
    this.committed = snapshot;
    const selected = this.selection.getSelectedId();
    if (selected && !snapshot.components.some((component) => component.id === selected)) {
      this.selection.select(null, "programmatic");
    }
    this.renderOverlay(transitions);
    if (this.threeReady) {
      try {
        await this.three.render(snapshot, operations);
      } catch (error) {
        this.options.onStatus?.({
          kind: "three-error",
          message: error instanceof Error ? error.message : "The 3D projection failed to update.",
        });
      }
    }
    if (!this.initialized || lifecycleToken !== this.lifecycleToken) return;
    this.refreshProjectionCamera();
    if (!this.readyStatusPublished) {
      this.readyStatusPublished = true;
      this.options.onStatus?.({ kind: "ready" });
    }
  }

  setSelection(componentId: string | null): void {
    this.selection.select(componentId, "programmatic");
  }

  setCanvasView(view: CanvasViewTransform): void {
    this.projection.setCanvasView(view);
    this.renderOverlay();
    this.publishNavigationState();
  }

  getCanvasView(): CanvasViewTransform {
    return this.projection.getCanvasView();
  }

  getCommittedSnapshot(): WorkspaceRenderSnapshot | null {
    return this.committed;
  }

  getContainer(): HTMLElement | null {
    return this.container;
  }

  resize(): void {
    if (!this.container) return;
    const rect = this.container.getBoundingClientRect();
    const width = this.container.clientWidth || rect.width || 1;
    const height = this.container.clientHeight || rect.height || 1;
    this.projection.setViewport({ width, height });
    if (this.threeReady) this.three.resize();
    this.renderOverlay();
  }

  frameAll(): void {
    if (this.threeReady) this.three.frameAll();
    if (!this.projection.frameCanvasComponents()) this.projection.resetCanvasView();
    this.renderOverlay();
    this.publishNavigationState();
  }

  resetView(): void {
    if (this.threeReady) this.three.resetView();
    this.projection.resetCanvasView();
    this.renderOverlay();
    this.publishNavigationState();
  }

  /** Magnification greater than one zooms both 3D and authored canvas2d content in. */
  zoomBy(magnification: number): void {
    if (!Number.isFinite(magnification) || magnification <= 0) return;
    if (this.threeReady) this.three.zoomBy(magnification);
    this.zoomCanvasAt(this.viewportCenter(), magnification);
  }

  dispose(): void {
    if (!this.initialized) return;
    this.lifecycleToken += 1;
    this.initialized = false;
    const view = this.container?.ownerDocument.defaultView;
    if (this.frameId !== null && view?.cancelAnimationFrame) view.cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.selectionUnsubscribe?.();
    this.selectionUnsubscribe = null;
    this.interaction.dispose();
    this.container?.removeEventListener("wheel", this.handleWheel, true);
    this.container?.removeEventListener("keydown", this.handleNavigationKey, true);
    this.container?.removeEventListener("pointerdown", this.handleTouchPointerDown, true);
    this.container?.removeEventListener("pointermove", this.handleTouchPointerMove, true);
    this.container?.removeEventListener("pointerup", this.handleTouchPointerEnd, true);
    this.container?.removeEventListener("pointercancel", this.handleTouchPointerEnd, true);
    this.overlay.dispose();
    this.three.dispose();
    this.threeReady = false;
    this.threeHost?.remove();
    this.threeHost = null;
    this.container = null;
    this.committed = null;
    this.readyStatusPublished = false;
    this.previews.clear();
    this.resizePreviews.clear();
    this.touchPoints.clear();
    this.lastPinchDistance = null;
  }

  private effectiveSnapshot(): WorkspaceRenderSnapshot | null {
    if (!this.committed || (this.previews.size === 0 && this.resizePreviews.size === 0)) return this.committed;
    return {
      ...this.committed,
      components: this.committed.components.map((component) => {
        const placementPreview = this.previews.get(component.id);
        const resizePreview = this.resizePreviews.get(component.id);
        const placed = placementPreview
          ? { ...component, placement: clonePlacement(placementPreview.placement) }
          : component;
        return resizePreview ? applyComponentResize(placed, resizePreview.resize) : placed;
      }),
    };
  }

  private renderOverlay(transitions?: WorkspaceComponentTransitions): void {
    const snapshot = this.effectiveSnapshot();
    if (!snapshot || !this.overlay.getElement()) return;
    this.projection.setComponents(snapshot.components);
    const projections = this.projection.projectAll();
    this.overlay.render(snapshot, projections, this.selection.getSelectedId(), transitions);
  }

  private refreshProjectionCamera(): void {
    const camera = this.threeReady ? this.three.getProjectionCameraState() : null;
    if (!camera) return;
    const signature = [
      camera.position.x, camera.position.y, camera.position.z,
      camera.target.x, camera.target.y, camera.target.z,
      camera.fovDeg, camera.near ?? 0.04, camera.far ?? 300,
    ].map((value) => Number(value).toPrecision(12)).join(":");
    if (signature === this.lastCameraSignature) return;
    this.lastCameraSignature = signature;
    this.projection.setCamera(camera);
    this.renderOverlay();
    this.publishNavigationState(camera);
  }

  private startProjectionLoop(): void {
    const view = this.container?.ownerDocument.defaultView;
    if (!view?.requestAnimationFrame) return;
    const frame = () => {
      if (!this.initialized) return;
      this.refreshProjectionCamera();
      this.frameId = view.requestAnimationFrame(frame);
    };
    this.frameId = view.requestAnimationFrame(frame);
  }

  private zoomCanvasAt(point: Readonly<{ x: number; y: number }>, magnification: number): void {
    this.projection.zoomCanvasAt(point, magnification);
    this.renderOverlay();
    this.publishNavigationState();
  }

  private viewportCenter(): Readonly<{ x: number; y: number }> {
    if (!this.container) return { x: 0.5, y: 0.5 };
    return {
      x: Math.max(1, this.container.clientWidth) / 2,
      y: Math.max(1, this.container.clientHeight) / 2,
    };
  }

  private publishNavigationState(camera = this.threeReady ? this.three.getProjectionCameraState() : null): void {
    if (!this.container) return;
    const canvasView = this.projection.getCanvasView();
    this.container.dataset.canvasZoom = String(canvasView.zoom);
    if (camera) {
      const dx = camera.position.x - camera.target.x;
      const dy = camera.position.y - camera.target.y;
      const dz = camera.position.z - camera.target.z;
      this.container.dataset.cameraDistance = String(Math.hypot(dx, dy, dz));
      this.container.dataset.cameraNear = String(camera.near ?? 0);
      this.container.dataset.cameraFar = String(camera.far ?? 0);
    }
  }

  private pinchGeometry(): Readonly<{
    distance: number;
    center: Readonly<{ x: number; y: number }>;
  }> | null {
    const [first, second] = [...this.touchPoints.values()];
    if (!first || !second) return null;
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    };
  }
}

function renderOperationsForCommit(
  previous: WorkspaceRenderSnapshot | null,
  next: WorkspaceRenderSnapshot,
  commit: WorkspaceRenderCommit | undefined,
): readonly WorkspaceOperation[] {
  if (!previous || !commit
    || previous.workspaceId !== next.workspaceId
    || previous.revision !== commit.baseRevision
    || next.revision !== commit.resultingRevision
    || commit.baseRevision === commit.resultingRevision) return [];
  return commit.operations;
}

function componentTransitionsForOperations(
  operations: readonly WorkspaceOperation[],
): WorkspaceComponentTransitions {
  const transitions = new Map<string, TransitionSpec>();
  for (const operation of operations) {
    if (!("transition" in operation) || !operation.transition) continue;
    let componentId: string | undefined;
    switch (operation.op) {
      case "create_component":
      case "update_component":
      case "place_component":
      case "resize_component":
      case "set_component_visual_effects":
      case "invoke_component_action":
        componentId = operation.id;
        break;
      case "attach_component":
      case "detach_component":
        componentId = operation.child_id;
        break;
      default:
        break;
    }
    if (componentId) transitions.set(componentId, operation.transition);
  }
  return transitions;
}

function applyComponentResize(
  component: WorkspaceRenderComponent,
  resize: ResizePreview["resize"],
): WorkspaceRenderComponent {
  if (resize.kind === "stage_dimensions") {
    return {
      ...component,
      props: { ...component.props, dimensions: structuredClone(resize.dimensions) },
    };
  }
  if (resize.kind === "scale3d" && component.placement.space === "world3d") {
    return {
      ...component,
      placement: { ...clonePlacement(component.placement), scale: structuredClone(resize.scale) },
    };
  }
  if (resize.kind === "box2d") {
    return {
      ...component,
      placement: { ...clonePlacement(component.placement), size: structuredClone(resize.size) },
    };
  }
  return component;
}
