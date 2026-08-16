import {
  clonePlacement,
  type PlacementCommitRequest,
  type ResizeCommitRequest,
  type WorkspacePlacement,
} from "../renderer/contracts";
import type {
  Box2DResizePolicy,
  ComponentResize,
  ComponentResizePolicy,
  Size2,
} from "../components/componentTypes";
import { SelectionCoordinator } from "./SelectionCoordinator";

export type InteractionRouterOptions = Readonly<{
  selection: SelectionCoordinator;
  getBaseRevision: () => number;
  getPlacement: (componentId: string) => WorkspacePlacement | undefined;
  getResizePolicy?: (componentId: string) => ComponentResizePolicy | undefined;
  previewPlacement: (
    componentId: string,
    placement: WorkspacePlacement,
    originalPlacement: WorkspacePlacement,
  ) => void;
  cancelPreview: (componentId: string, originalPlacement: WorkspacePlacement) => void;
  commitPlacement: (request: PlacementCommitRequest) => void | Promise<void>;
  previewResize?: (
    componentId: string,
    resize: ComponentResize,
    originalResize: ComponentResize,
    placement?: WorkspacePlacement,
    originalPlacement?: WorkspacePlacement,
  ) => void;
  cancelResizePreview?: (
    componentId: string,
    originalResize: ComponentResize,
  ) => void;
  commitResize?: (request: ResizeCommitRequest) => void | Promise<void>;
  announceResize?: (message: string) => void;
  onError?: (error: unknown) => void;
  worldUnitsPerPixel?: number;
  getCanvasZoom?: () => number;
}>;

type ActiveDrag = {
  componentId: string;
  baseRevision: number;
  pointerId: number;
  startX: number;
  startY: number;
  originalPlacement: WorkspacePlacement;
  latestPlacement: WorkspacePlacement;
  moved: boolean;
  element: HTMLElement;
};

export type ResizeHandleDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

type ActiveResize = {
  componentId: string;
  componentLabel: string;
  baseRevision: number;
  pointerId: number;
  direction: ResizeHandleDirection;
  startX: number;
  startY: number;
  originalResize: Extract<ComponentResize, { kind: "box2d" }>;
  latestResize: Extract<ComponentResize, { kind: "box2d" }>;
  latestPlacement: WorkspacePlacement;
  policy: Box2DResizePolicy;
  placement: WorkspacePlacement;
  moved: boolean;
  element: HTMLElement;
};

const COMPONENT_SELECTOR = "[data-workspace-component-id]";
const RESIZE_HANDLE_SELECTOR = "[data-workspace-resize-handle]";

/**
 * Unified pointer/keyboard router for projected workspace components.
 *
 * Pointer movement can only call `previewPlacement`. The durable commit seam is
 * invoked once, on pointer-up, with the original placement and base revision.
 */
export class InteractionRouter {
  private readonly options: InteractionRouterOptions;
  private root: HTMLElement | null = null;
  private activeDrag: ActiveDrag | null = null;
  private activeResize: ActiveResize | null = null;

  constructor(options: InteractionRouterOptions) {
    this.options = options;
  }

  attach(root: HTMLElement): void {
    if (this.root === root) return;
    this.detach();
    this.root = root;
    root.addEventListener("pointerdown", this.onPointerDown);
    root.addEventListener("click", this.onClick);
    root.addEventListener("keydown", this.onKeyDown);
  }

  detach(): void {
    this.cancelActiveDrag();
    this.cancelActiveResize();
    if (!this.root) return;
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    this.root.removeEventListener("click", this.onClick);
    this.root.removeEventListener("keydown", this.onKeyDown);
    this.root = null;
  }

  dispose(): void {
    this.detach();
  }

  cancelActiveDrag(): void {
    const drag = this.activeDrag;
    if (!drag) return;
    this.activeDrag = null;
    this.removeDocumentDragListeners(drag.element.ownerDocument);
    drag.element.removeAttribute("data-dragging");
    this.options.cancelPreview(drag.componentId, clonePlacement(drag.originalPlacement));
  }

  cancelActiveResize(): void {
    const resize = this.activeResize;
    if (!resize) return;
    this.activeResize = null;
    this.removeDocumentResizeListeners(resize.element.ownerDocument);
    resize.element.removeAttribute("data-resizing");
    componentElementFromHandle(resize.element)?.removeAttribute("data-resizing");
    this.options.cancelResizePreview?.(
      resize.componentId,
      structuredClone(resize.originalResize),
    );
  }

  private onPointerDown = (event: PointerEvent): void => {
    // JSDOM and some assistive pointer synthesizers omit `button`; omitted is
    // equivalent to the primary pointer, while positive values are not.
    if (event.button > 0 || this.activeDrag || this.activeResize) return;
    const element = componentElement(event.target);
    if (!element) return;
    const componentId = element.dataset.workspaceComponentId;
    if (!componentId) return;
    this.options.selection.select(componentId, "canvas");
    const resizeHandle = resizeHandleElement(event.target);
    const resizeDirection = resizeHandle?.dataset.workspaceResizeHandle;
    if (resizeHandle && isResizeHandleDirection(resizeDirection)) {
      this.beginResize(event, element, resizeHandle, componentId, resizeDirection);
      return;
    }
    if (isInteractiveControl(event.target)) return;
    if (element.dataset.workspaceDraggable === "false") return;
    const originalPlacement = this.options.getPlacement(componentId);
    if (!originalPlacement) return;
    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 1;
    this.activeDrag = {
      componentId,
      baseRevision: this.options.getBaseRevision(),
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originalPlacement: clonePlacement(originalPlacement),
      latestPlacement: clonePlacement(originalPlacement),
      moved: false,
      element,
    };
    element.dataset.dragging = "true";
    element.focus({ preventScroll: true });
    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      // Synthetic pointer events and older engines may not support capture.
    }
    const document = element.ownerDocument;
    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("pointerup", this.onPointerUp);
    document.addEventListener("pointercancel", this.onPointerCancel);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.activeDrag;
    if (!drag || (Number.isFinite(event.pointerId) && event.pointerId !== drag.pointerId)) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    drag.latestPlacement = translatePlacement(
      drag.originalPlacement,
      dx,
      dy,
      this.options.worldUnitsPerPixel ?? 0.01,
      this.options.getCanvasZoom?.() ?? 1,
    );
    this.options.previewPlacement(
      drag.componentId,
      clonePlacement(drag.latestPlacement),
      clonePlacement(drag.originalPlacement),
    );
    event.preventDefault();
  };

  private onPointerUp = (event: PointerEvent): void => {
    const drag = this.activeDrag;
    if (!drag || (Number.isFinite(event.pointerId) && event.pointerId !== drag.pointerId)) return;
    this.activeDrag = null;
    this.removeDocumentDragListeners(drag.element.ownerDocument);
    drag.element.removeAttribute("data-dragging");
    try {
      drag.element.releasePointerCapture?.(drag.pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    if (!drag.moved) return;
    const request: PlacementCommitRequest = {
      componentId: drag.componentId,
      placement: clonePlacement(drag.latestPlacement),
      originalPlacement: clonePlacement(drag.originalPlacement),
      baseRevision: drag.baseRevision,
    };
    Promise.resolve(this.options.commitPlacement(request))
      .catch((error) => this.options.onError?.(error))
      .finally(() => this.options.cancelPreview(drag.componentId, clonePlacement(drag.originalPlacement)));
  };

  private onPointerCancel = (): void => this.cancelActiveDrag();

  private onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || (!this.activeDrag && !this.activeResize)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.activeResize) this.cancelActiveResize();
    else this.cancelActiveDrag();
  };

  private onClick = (event: MouseEvent): void => {
    const element = componentElement(event.target);
    const componentId = element?.dataset.workspaceComponentId;
    if (componentId) this.options.selection.select(componentId, "canvas");
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const element = componentElement(event.target);
    const componentId = element?.dataset.workspaceComponentId;
    if (!element || !componentId) return;
    const resizeHandle = resizeHandleElement(event.target);
    const resizeDirection = resizeHandle?.dataset.workspaceResizeHandle;
    if (resizeHandle && isResizeHandleDirection(resizeDirection) && event.key.startsWith("Arrow")) {
      this.resizeWithKeyboard(
        event,
        componentId,
        element.dataset.workspaceComponentLabel ?? componentId,
        resizeDirection,
      );
      return;
    }
    if (isInteractiveControl(event.target) && event.target !== element) return;
    if (event.key === "Enter" || event.key === " ") {
      this.options.selection.select(componentId, "tree");
      return;
    }
    if (!event.key.startsWith("Arrow") || element.dataset.workspaceDraggable === "false") return;
    const original = this.options.getPlacement(componentId);
    if (!original) return;
    event.preventDefault();
    const amount = event.shiftKey ? 24 : 8;
    const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
    const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
    const placement = translatePlacement(
      original,
      dx,
      dy,
      this.options.worldUnitsPerPixel ?? 0.01,
      this.options.getCanvasZoom?.() ?? 1,
    );
    const baseRevision = this.options.getBaseRevision();
    this.options.previewPlacement(componentId, placement, original);
    const request: PlacementCommitRequest = {
      componentId,
      placement: clonePlacement(placement),
      originalPlacement: clonePlacement(original),
      baseRevision,
    };
    Promise.resolve(this.options.commitPlacement(request))
      .catch((error) => this.options.onError?.(error))
      .finally(() => this.options.cancelPreview(componentId, clonePlacement(original)));
  };

  private removeDocumentDragListeners(document: Document): void {
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerup", this.onPointerUp);
    document.removeEventListener("pointercancel", this.onPointerCancel);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
  }

  private beginResize(
    event: PointerEvent,
    componentElement: HTMLElement,
    handle: HTMLElement,
    componentId: string,
    direction: ResizeHandleDirection,
  ): void {
    const placement = this.options.getPlacement(componentId);
    const policy = this.options.getResizePolicy?.(componentId);
    if (!placement || policy?.kind !== "box2d" || !this.options.commitResize
      || !supportsDirectEdgeResize(placement)) return;
    const originalResize = boxResizeForPlacement(placement, policy);
    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 1;
    this.activeResize = {
      componentId,
      componentLabel: componentElement.dataset.workspaceComponentLabel ?? componentId,
      baseRevision: this.options.getBaseRevision(),
      pointerId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      originalResize,
      latestResize: structuredClone(originalResize),
      latestPlacement: clonePlacement(placement),
      policy,
      placement: clonePlacement(placement),
      moved: false,
      element: handle,
    };
    componentElement.dataset.resizing = "true";
    handle.dataset.resizing = "true";
    handle.focus({ preventScroll: true });
    try {
      handle.setPointerCapture?.(pointerId);
    } catch {
      // Synthetic events and older engines may not support pointer capture.
    }
    const document = handle.ownerDocument;
    document.addEventListener("pointermove", this.onResizePointerMove);
    document.addEventListener("pointerup", this.onResizePointerUp);
    document.addEventListener("pointercancel", this.onResizePointerCancel);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    event.preventDefault();
    event.stopPropagation();
  }

  private onResizePointerMove = (event: PointerEvent): void => {
    const resize = this.activeResize;
    if (!resize || (Number.isFinite(event.pointerId) && event.pointerId !== resize.pointerId)) return;
    const dx = event.clientX - resize.startX;
    const dy = event.clientY - resize.startY;
    if (!resize.moved && Math.hypot(dx, dy) < 2) return;
    resize.moved = true;
    const delta = logicalResizeDeltas(
      resize.placement,
      dx,
      dy,
      this.options.getCanvasZoom?.() ?? 1,
    );
    const next = resizeBox(
      resize.originalResize.size,
      resize.direction,
      delta.x,
      delta.y,
      resize.policy,
    );
    resize.latestResize = { kind: "box2d", size: next };
    resize.latestPlacement = anchoredPlacementForBoxResize(
      resize.placement,
      resize.originalResize.size,
      next,
      resize.direction,
    );
    this.options.announceResize?.(resizeAnnouncement(resize.componentLabel, next, resize.policy.units));
    this.options.previewResize?.(
      resize.componentId,
      structuredClone(resize.latestResize),
      structuredClone(resize.originalResize),
      clonePlacement(resize.latestPlacement),
      clonePlacement(resize.placement),
    );
    event.preventDefault();
  };

  private onResizePointerUp = (event: PointerEvent): void => {
    const resize = this.activeResize;
    if (!resize || (Number.isFinite(event.pointerId) && event.pointerId !== resize.pointerId)) return;
    this.activeResize = null;
    this.removeDocumentResizeListeners(resize.element.ownerDocument);
    resize.element.removeAttribute("data-resizing");
    componentElementFromHandle(resize.element)?.removeAttribute("data-resizing");
    try {
      resize.element.releasePointerCapture?.(resize.pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    if (!resize.moved) return;
    if (sameSize(resize.latestResize.size, resize.originalResize.size)) {
      this.options.cancelResizePreview?.(resize.componentId, structuredClone(resize.originalResize));
      return;
    }
    const request: ResizeCommitRequest = {
      componentId: resize.componentId,
      resize: structuredClone(resize.latestResize),
      originalResize: structuredClone(resize.originalResize),
      placement: clonePlacement(resize.latestPlacement),
      originalPlacement: clonePlacement(resize.placement),
      baseRevision: resize.baseRevision,
    };
    Promise.resolve(this.options.commitResize?.(request))
      .catch((error) => this.options.onError?.(error))
      .finally(() => this.options.cancelResizePreview?.(
        resize.componentId,
        structuredClone(resize.originalResize),
      ));
  };

  private onResizePointerCancel = (): void => this.cancelActiveResize();

  private resizeWithKeyboard(
    event: KeyboardEvent,
    componentId: string,
    componentLabel: string,
    direction: ResizeHandleDirection,
  ): void {
    const originalPlacement = this.options.getPlacement(componentId);
    const policy = this.options.getResizePolicy?.(componentId);
    if (!originalPlacement || policy?.kind !== "box2d" || !this.options.commitResize
      || !supportsDirectEdgeResize(originalPlacement)) return;
    const original = boxResizeForPlacement(originalPlacement, policy);
    const amount = event.shiftKey ? 24 : 8;
    const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
    const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
    const delta = logicalResizeDeltas(
      originalPlacement,
      dx,
      dy,
      this.options.getCanvasZoom?.() ?? 1,
    );
    const size = resizeBox(
      original.size,
      direction,
      delta.x,
      delta.y,
      policy,
    );
    if (sameSize(size, original.size)) return;
    const baseRevision = this.options.getBaseRevision();
    event.preventDefault();
    event.stopPropagation();
    const resize: Extract<ComponentResize, { kind: "box2d" }> = { kind: "box2d", size };
    const placement = anchoredPlacementForBoxResize(
      originalPlacement,
      original.size,
      size,
      direction,
    );
    this.options.announceResize?.(resizeAnnouncement(componentLabel, size, policy.units));
    this.options.previewResize?.(
      componentId,
      structuredClone(resize),
      structuredClone(original),
      clonePlacement(placement),
      clonePlacement(originalPlacement),
    );
    const request: ResizeCommitRequest = {
      componentId,
      resize,
      originalResize: original,
      placement,
      originalPlacement: clonePlacement(originalPlacement),
      baseRevision,
    };
    Promise.resolve(this.options.commitResize(request))
      .catch((error) => this.options.onError?.(error))
      .finally(() => this.options.cancelResizePreview?.(componentId, structuredClone(original)));
  }

  private removeDocumentResizeListeners(document: Document): void {
    document.removeEventListener("pointermove", this.onResizePointerMove);
    document.removeEventListener("pointerup", this.onResizePointerUp);
    document.removeEventListener("pointercancel", this.onResizePointerCancel);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
  }
}

export function boxResizeForPlacement(
  placement: WorkspacePlacement,
  policy: Box2DResizePolicy,
): Extract<ComponentResize, { kind: "box2d" }> {
  const size = "size" in placement && placement.size
    ? placement.size
    : policy.defaultSize;
  return { kind: "box2d", size: { width: size.width, height: size.height } };
}

/** Resolve a human drag into a bounded absolute size without mutating state. */
export function resizeBox(
  original: Size2,
  direction: ResizeHandleDirection,
  dx: number,
  dy: number,
  policy: Box2DResizePolicy,
): Size2 {
  const horizontal = direction.includes("e") ? dx : direction.includes("w") ? -dx : 0;
  const vertical = direction.includes("s") ? dy : direction.includes("n") ? -dy : 0;
  const canWidth = policy.allowedAxes.includes("width") && horizontal !== 0;
  const canHeight = policy.allowedAxes.includes("height") && vertical !== 0;

  if (policy.mode === "aspect_locked") {
    const ratio = positive(policy.aspectRatio) ?? positive(original.width / original.height) ?? 1;
    const widthFromHorizontal = original.width + (canWidth ? horizontal : 0);
    const heightFromVertical = original.height + (canHeight ? vertical : 0);
    const horizontalWeight = canWidth ? Math.abs(horizontal / Math.max(1, original.width)) : -1;
    const verticalWeight = canHeight ? Math.abs(vertical / Math.max(1, original.height)) : -1;
    const preferredWidth = horizontalWeight >= verticalWeight
      ? widthFromHorizontal
      : heightFromVertical * ratio;
    const minWidth = Math.max(policy.minSize.width, policy.minSize.height * ratio);
    const maxWidth = Math.min(policy.maxSize.width, policy.maxSize.height * ratio);
    const width = clamp(preferredWidth, minWidth, Math.max(minWidth, maxWidth));
    return { width, height: width / ratio };
  }

  return {
    width: canWidth
      ? clamp(original.width + horizontal, policy.minSize.width, policy.maxSize.width)
      : original.width,
    height: canHeight
      ? clamp(original.height + vertical, policy.minSize.height, policy.maxSize.height)
      : original.height,
  };
}

/**
 * Build the full post-resize placement while keeping the edge opposite the
 * active handle stationary. Viewport anchors are size-aware and canvas geometry
 * is rotation-aware. Camera-projected placements deliberately use the exact
 * Inspector path instead of pretending a screen edge has a stable world offset.
 */
export function anchoredPlacementForBoxResize(
  placement: WorkspacePlacement,
  original: Size2,
  next: Size2,
  direction: ResizeHandleDirection,
): WorkspacePlacement {
  if (!supportsDirectEdgeResize(placement)) {
    throw new Error(`Direct edge resize is unavailable for ${placement.space} placement`);
  }
  const widthDelta = next.width - original.width;
  const heightDelta = next.height - original.height;
  const centerShift = resizeCenterShift(direction, widthDelta, heightDelta);
  let result: WorkspacePlacement;

  if (placement.space === "viewport") {
    const anchor = viewportAnchorFractions(placement.anchor);
    const desiredLeftShift = direction.includes("w")
      ? -widthDelta
      : direction.includes("e") ? 0 : -widthDelta / 2;
    const desiredTopShift = direction.includes("n")
      ? -heightDelta
      : direction.includes("s") ? 0 : -heightDelta / 2;
    result = {
      ...clonePlacement(placement),
      offset: {
        x: placement.offset.x + desiredLeftShift + anchor.x * widthDelta,
        y: placement.offset.y + desiredTopShift + anchor.y * heightDelta,
      },
    };
  } else if (placement.space === "canvas2d") {
    const radians = (placement.rotationDeg ?? 0) * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    result = {
      ...clonePlacement(placement),
      position: {
        x: placement.position.x + centerShift.x * cosine - centerShift.y * sine,
        y: placement.position.y + centerShift.x * sine + centerShift.y * cosine,
      },
    };
  } else result = clonePlacement(placement);

  return { ...result, size: { width: next.width, height: next.height } } as WorkspacePlacement;
}

export function supportsDirectEdgeResize(
  placement: WorkspacePlacement,
): placement is Extract<WorkspacePlacement, { space: "canvas2d" | "viewport" }> {
  return placement.space === "canvas2d" || placement.space === "viewport";
}

function resizeCenterShift(
  direction: ResizeHandleDirection,
  widthDelta: number,
  heightDelta: number,
): { x: number; y: number } {
  return {
    x: direction.includes("e") ? widthDelta / 2 : direction.includes("w") ? -widthDelta / 2 : 0,
    y: direction.includes("s") ? heightDelta / 2 : direction.includes("n") ? -heightDelta / 2 : 0,
  };
}

function viewportAnchorFractions(anchor: Extract<WorkspacePlacement, { space: "viewport" }>["anchor"]): {
  x: number;
  y: number;
} {
  const x = anchor.endsWith("_left") || anchor === "left"
    ? 0
    : anchor.endsWith("_right") || anchor === "right" ? 1 : 0.5;
  const y = anchor.startsWith("top")
    ? 0
    : anchor.startsWith("bottom") ? 1 : 0.5;
  return { x, y };
}

export function translatePlacement(
  placement: WorkspacePlacement,
  dx: number,
  dy: number,
  worldUnitsPerPixel = 0.01,
  canvasZoom = 1,
): WorkspacePlacement {
  switch (placement.space) {
    case "canvas2d":
      return {
        ...clonePlacement(placement),
        position: {
          x: placement.position.x + dx / Math.max(0.05, canvasZoom),
          y: placement.position.y + dy / Math.max(0.05, canvasZoom),
        },
      };
    case "viewport":
      return {
        ...clonePlacement(placement),
        offset: { x: placement.offset.x + dx, y: placement.offset.y + dy },
      };
    case "surface":
      return {
        ...clonePlacement(placement),
        offset: {
          x: placement.offset.x + dx * worldUnitsPerPixel,
          y: placement.offset.y - dy * worldUnitsPerPixel,
        },
      };
    case "billboard":
      return {
        ...clonePlacement(placement),
        offset: {
          x: placement.offset.x + dx * worldUnitsPerPixel,
          y: placement.offset.y - dy * worldUnitsPerPixel,
          z: placement.offset.z,
        },
      };
    case "world3d":
      return {
        ...clonePlacement(placement),
        position: {
          x: placement.position.x + dx * worldUnitsPerPixel,
          y: placement.position.y,
          z: placement.position.z + dy * worldUnitsPerPixel,
        },
      };
  }
}

function componentElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(COMPONENT_SELECTOR) : null;
}

function componentElementFromHandle(handle: HTMLElement): HTMLElement | null {
  return handle.closest<HTMLElement>(COMPONENT_SELECTOR);
}

function resizeHandleElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(RESIZE_HANDLE_SELECTOR) : null;
}

function isResizeHandleDirection(value: string | undefined): value is ResizeHandleDirection {
  return value === "n" || value === "ne" || value === "e" || value === "se"
    || value === "s" || value === "sw" || value === "w" || value === "nw";
}

function logicalResizeDeltas(
  placement: WorkspacePlacement,
  dx: number,
  dy: number,
  canvasZoom: number,
): { x: number; y: number } {
  if (placement.space !== "canvas2d") return { x: dx, y: dy };
  const radians = (placement.rotationDeg ?? 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const zoom = Math.max(0.05, canvasZoom);
  return {
    x: (dx * cosine + dy * sine) / zoom,
    y: (-dx * sine + dy * cosine) / zoom,
  };
}

function sameSize(left: Size2, right: Size2): boolean {
  return Math.abs(left.width - right.width) < 0.001 && Math.abs(left.height - right.height) < 0.001;
}

function resizeAnnouncement(componentId: string, size: Size2, units: string): string {
  return `${componentId} resized to ${Math.round(size.width)} by ${Math.round(size.height)} ${units}`;
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isInteractiveControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    // Embedded browsing/media surfaces own their pointer and keyboard input.
    // Treating their host element as a canvas drag handle makes playback
    // controls unreliable and can accidentally move a component when the user
    // meant to scrub or focus its player.
    "button, input, select, textarea, a[href], iframe, video, audio, [contenteditable='true'], [data-no-canvas-drag='true']",
  ));
}
