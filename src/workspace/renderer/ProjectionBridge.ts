import * as THREE from "three";
import { INFINITE_NAVIGATION_LIMITS } from "../../renderer/infiniteNavigation";
import { DEFAULT_DECLARATIVE_COMPONENT_SIZE } from "../components/componentTypes";
import {
  isSpatialComponent,
  type CameraProjectionState,
  type CanvasViewTransform,
  type ProjectedComponent,
  type ViewportAnchor,
  type WorkspacePlacement,
  type WorkspaceRenderComponent,
  type WorkspaceSize2D,
  type WorkspaceVec2,
  type WorkspaceVec3,
} from "./contracts";

export type ProjectionViewport = Readonly<{
  width: number;
  height: number;
}>;

export type ProjectionBridgeOptions = Readonly<{
  defaultSize?: WorkspaceSize2D;
  canvasView?: CanvasViewTransform;
  camera?: CameraProjectionState;
}>;

const DEFAULT_SIZE: WorkspaceSize2D = DEFAULT_DECLARATIVE_COMPONENT_SIZE;
const DEFAULT_CAMERA: CameraProjectionState = {
  position: { x: 7.5, y: 5.5, z: 9.5 },
  target: { x: 0, y: 1, z: 0 },
  fovDeg: 45,
};

/**
 * Single source of truth for translating all five placement spaces into DOM
 * coordinates. World anchors are resolved from semantic component placement,
 * so an attached billboard follows its target in the same preview frame.
 */
export class ProjectionBridge {
  private viewport: ProjectionViewport = { width: 1, height: 1 };
  private camera: CameraProjectionState;
  private canvasView: CanvasViewTransform;
  private components = new Map<string, WorkspaceRenderComponent>();
  private readonly defaultSize: WorkspaceSize2D;

  constructor(options: ProjectionBridgeOptions = {}) {
    this.defaultSize = options.defaultSize ?? DEFAULT_SIZE;
    this.camera = options.camera ?? DEFAULT_CAMERA;
    this.canvasView = options.canvasView ?? { pan: { x: 0, y: 0 }, zoom: 1 };
  }

  setViewport(viewport: ProjectionViewport): void {
    this.viewport = {
      width: Math.max(1, finite(viewport.width, 1)),
      height: Math.max(1, finite(viewport.height, 1)),
    };
  }

  setCamera(camera: CameraProjectionState): void {
    this.camera = camera;
  }

  getCamera(): CameraProjectionState {
    return this.camera;
  }

  setCanvasView(view: CanvasViewTransform): void {
    this.canvasView = {
      pan: { x: finite(view.pan.x), y: finite(view.pan.y) },
      zoom: clampCanvasZoom(finite(view.zoom, 1)),
    };
  }

  getCanvasView(): CanvasViewTransform {
    return this.canvasView;
  }

  /** Zoom the authored 2D plane around one viewport point without drift. */
  zoomCanvasAt(point: WorkspaceVec2, magnification: number): CanvasViewTransform {
    const oldZoom = this.canvasView.zoom;
    const nextZoom = clampCanvasZoom(oldZoom * positiveFinite(magnification, 1));
    const ratio = nextZoom / oldZoom;
    const anchor = {
      x: finite(point.x) - this.viewport.width / 2,
      y: finite(point.y) - this.viewport.height / 2,
    };
    this.canvasView = {
      zoom: nextZoom,
      pan: {
        x: anchor.x - (anchor.x - this.canvasView.pan.x) * ratio,
        y: anchor.y - (anchor.y - this.canvasView.pan.y) * ratio,
      },
    };
    return this.canvasView;
  }

  resetCanvasView(): CanvasViewTransform {
    this.canvasView = { pan: { x: 0, y: 0 }, zoom: 1 };
    return this.canvasView;
  }

  /** Fit all canvas2d components while leaving viewport/HUD components fixed. */
  frameCanvasComponents(padding = 48): CanvasViewTransform | null {
    const canvasComponents = [...this.components.values()].filter(
      (component) => component.placement.space === "canvas2d" && component.visibility === "visible",
    );
    if (!canvasComponents.length) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const component of canvasComponents) {
      if (component.placement.space !== "canvas2d") continue;
      const size = componentSize(component);
      minX = Math.min(minX, component.placement.position.x - size.width / 2);
      maxX = Math.max(maxX, component.placement.position.x + size.width / 2);
      minY = Math.min(minY, component.placement.position.y - size.height / 2);
      maxY = Math.max(maxY, component.placement.position.y + size.height / 2);
    }
    const availableWidth = Math.max(1, this.viewport.width - padding * 2);
    const availableHeight = Math.max(1, this.viewport.height - padding * 2);
    const width = Math.max(1e-9, maxX - minX);
    const height = Math.max(1e-9, maxY - minY);
    const zoom = clampCanvasZoom(Math.min(availableWidth / width, availableHeight / height));
    this.canvasView = {
      zoom,
      pan: {
        x: -((minX + maxX) / 2) * zoom,
        y: -((minY + maxY) / 2) * zoom,
      },
    };
    return this.canvasView;
  }

  setComponents(components: readonly WorkspaceRenderComponent[]): void {
    this.components = new Map(components.map((component) => [component.id, component]));
  }

  projectAll(): ReadonlyMap<string, ProjectedComponent> {
    const projected = new Map<string, ProjectedComponent>();
    for (const component of this.components.values()) {
      projected.set(component.id, this.project(component));
    }
    return projected;
  }

  project(component: WorkspaceRenderComponent): ProjectedComponent {
    const placement = component.placement;
    const intrinsicSize = componentSize(component);
    const size = placement.space === "viewport"
      ? responsiveViewportSize(component, intrinsicSize, this.viewport)
      : intrinsicSize;
    const zIndex = "zIndex" in placement ? finite(placement.zIndex, defaultZIndex(placement)) : defaultZIndex(placement);
    const spatialOnly = isSpatialComponent(component);
    let point: WorkspaceVec2;
    let visible = component.visibility === "visible";

    switch (placement.space) {
      case "canvas2d": {
        const zoom = this.canvasView.zoom;
        point = {
          x: this.viewport.width / 2 + this.canvasView.pan.x + placement.position.x * zoom,
          y: this.viewport.height / 2 + this.canvasView.pan.y + placement.position.y * zoom,
        };
        return centered(component.id, placement.space, point, scaleSize(size, zoom), zIndex, visible, spatialOnly);
      }
      case "viewport": {
        const offset = placement.offset;
        point = viewportAnchorPoint(placement.anchor, this.viewport, size);
        return {
          componentId: component.id,
          space: placement.space,
          left: point.x + offset.x,
          top: point.y + offset.y,
          width: size.width,
          height: size.height,
          zIndex,
          visible,
          spatialOnly,
        };
      }
      case "world3d": {
        const result = this.projectWorldPoint(placement.position);
        visible = visible && result.visible;
        point = result.point;
        return centered(component.id, placement.space, point, size, zIndex, visible, spatialOnly);
      }
      case "billboard": {
        const anchor = this.resolveWorldAnchor(placement.targetId);
        if (!anchor) {
          return centered(component.id, placement.space, { x: 0, y: 0 }, size, zIndex, false, spatialOnly);
        }
        const world = add3(anchor, placement.offset);
        const result = this.projectWorldPoint(world);
        point = result.point;
        visible = visible && result.visible;
        return centered(component.id, placement.space, point, size, zIndex, visible, spatialOnly);
      }
      case "surface": {
        const anchor = this.resolveWorldAnchor(placement.targetId);
        if (!anchor) {
          return centered(component.id, placement.space, { x: 0, y: 0 }, size, zIndex, false, spatialOnly);
        }
        // Surface offsets are semantic local units. Until a surface basis is
        // supplied by an asset socket, the deterministic fallback uses the
        // target's world X/Y plane rather than treating durable units as pixels.
        const result = this.projectWorldPoint({
          x: anchor.x + placement.offset.x,
          y: anchor.y + placement.offset.y,
          z: anchor.z,
        });
        point = result.point;
        visible = visible && result.visible;
        return centered(component.id, placement.space, point, size, zIndex, visible, spatialOnly);
      }
    }
  }

  projectWorldPoint(world: WorkspaceVec3): Readonly<{ point: WorkspaceVec2; visible: boolean; depth: number }> {
    const camera = new THREE.PerspectiveCamera(
      finite(this.camera.fovDeg, 45),
      this.viewport.width / this.viewport.height,
      finite(this.camera.near, 0.04),
      finite(this.camera.far, 300),
    );
    camera.position.set(this.camera.position.x, this.camera.position.y, this.camera.position.z);
    camera.lookAt(this.camera.target.x, this.camera.target.y, this.camera.target.z);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const projected = new THREE.Vector3(world.x, world.y, world.z).project(camera);
    const point = {
      x: (projected.x + 1) * 0.5 * this.viewport.width,
      y: (1 - projected.y) * 0.5 * this.viewport.height,
    };
    const finitePoint = Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(projected.z);
    return {
      point,
      visible: finitePoint && projected.z >= -1 && projected.z <= 1,
      depth: projected.z,
    };
  }

  resolveWorldAnchor(componentId: string): WorkspaceVec3 | undefined {
    return this.resolveWorldAnchorInner(componentId, new Set());
  }

  private resolveWorldAnchorInner(componentId: string, seen: Set<string>): WorkspaceVec3 | undefined {
    if (seen.has(componentId)) return undefined;
    seen.add(componentId);
    const component = this.components.get(componentId);
    if (!component) return undefined;
    const placement = component.placement;
    if (placement.space === "world3d") {
      if (!component.parentId) return placement.position;
      const parent = this.resolveWorldAnchorInner(component.parentId, seen);
      return parent ? add3(parent, placement.position) : placement.position;
    }
    if (placement.space === "billboard") {
      const parent = this.resolveWorldAnchorInner(placement.targetId, seen);
      return parent ? add3(parent, placement.offset) : undefined;
    }
    if (placement.space === "surface") {
      return this.resolveWorldAnchorInner(placement.targetId, seen);
    }
    return undefined;
  }
}

function componentSize(component: WorkspaceRenderComponent): WorkspaceSize2D {
  const placement = component.placement;
  const placementSize = "size" in placement ? placement.size : undefined;
  const defaults = defaultsForType(component.type.typeId);
  return {
    width: positiveFinite(placementSize?.width, defaults.width),
    height: positiveFinite(placementSize?.height, defaults.height),
  };
}

function defaultsForType(typeName: string): WorkspaceSize2D {
  switch (typeName) {
    case "text": return { width: 280, height: 72 };
    case "annotation": return { width: 260, height: 128 };
    case "timer": return { width: 210, height: 112 };
    case "checklist": return { width: 280, height: 240 };
    case "chart": return { width: 360, height: 240 };
    case "table": return { width: 420, height: 260 };
    case "document": return { width: 420, height: 520 };
    case "image": return { width: 320, height: 220 };
    case "video-player": return { width: 480, height: 306 };
    case "web-panel": return { width: 560, height: 420 };
    case "data-panel": return { width: 520, height: 340 };
    case "panel": return { width: 320, height: 220 };
    default: return DEFAULT_SIZE;
  }
}

function responsiveViewportSize(
  component: WorkspaceRenderComponent,
  size: WorkspaceSize2D,
  viewport: ProjectionViewport,
): WorkspaceSize2D {
  if (component.type.typeId !== "video-player") return size;
  // Keep the persisted placement stable while fitting the visual projection on
  // narrow screens. A 356px 16:9 frame is the smallest standards-compliant
  // YouTube viewport (200px tall); wider screens retain the authored size.
  const width = Math.min(size.width, Math.max(356, viewport.width - 24));
  if (width === size.width) return size;
  const externalChromeHeight = Math.max(36, size.height - (size.width * 9) / 16);
  return {
    width,
    height: Math.min(size.height, externalChromeHeight + (width * 9) / 16),
  };
}

function viewportAnchorPoint(
  anchor: ViewportAnchor,
  viewport: ProjectionViewport,
  size: WorkspaceSize2D,
): WorkspaceVec2 {
  const padding = 20;
  const left = padding;
  const centerX = (viewport.width - size.width) / 2;
  const right = viewport.width - size.width - padding;
  const top = padding;
  const centerY = (viewport.height - size.height) / 2;
  const bottom = viewport.height - size.height - padding;
  const points: Record<ViewportAnchor, WorkspaceVec2> = {
    top_left: { x: left, y: top },
    top: { x: centerX, y: top },
    top_right: { x: right, y: top },
    left: { x: left, y: centerY },
    center: { x: centerX, y: centerY },
    right: { x: right, y: centerY },
    bottom_left: { x: left, y: bottom },
    bottom: { x: centerX, y: bottom },
    bottom_right: { x: right, y: bottom },
  };
  return points[anchor] ?? points.center;
}

function centered(
  componentId: string,
  space: WorkspacePlacement["space"],
  point: WorkspaceVec2,
  size: WorkspaceSize2D,
  zIndex: number,
  visible: boolean,
  spatialOnly: boolean,
): ProjectedComponent {
  return {
    componentId,
    space,
    left: point.x - size.width / 2,
    top: point.y - size.height / 2,
    width: size.width,
    height: size.height,
    zIndex,
    visible,
    spatialOnly,
  };
}

function defaultZIndex(placement: WorkspacePlacement): number {
  if (placement.space === "viewport") return 500;
  if (placement.space === "billboard") return 300;
  if (placement.space === "surface") return 250;
  if (placement.space === "canvas2d") return 200;
  return 100;
}

function scaleSize(size: WorkspaceSize2D, scale: number): WorkspaceSize2D {
  return { width: size.width * scale, height: size.height * scale };
}

function add3(left: WorkspaceVec3, right: WorkspaceVec3): WorkspaceVec3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampCanvasZoom(value: number): number {
  return THREE.MathUtils.clamp(
    value,
    INFINITE_NAVIGATION_LIMITS.minCanvasZoom,
    INFINITE_NAVIGATION_LIMITS.maxCanvasZoom,
  );
}
