import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";
import type {
  RealityMeasurementEvent,
  RealitySplatHandle,
  RealitySplatRuntimeSnapshot,
  RealitySplatSurfaceHit,
} from "../../renderer/reality";
import { createInitialScene } from "../../renderer/sceneRenderState";
import type { EntityState, SceneState } from "../../renderer/sceneRenderTypes";

type RendererDouble = Readonly<{
  domElement: HTMLCanvasElement;
  setAnimationLoop: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}>;

type RealityRuntimeDouble = Readonly<{
  getHandle: ReturnType<typeof vi.fn<(instanceId: string) => RealitySplatHandle | undefined>>;
  raycastSurface: ReturnType<typeof vi.fn<(
    instanceId: string,
    raycaster: THREE.Raycaster,
  ) => RealitySplatSurfaceHit | undefined>>;
  snapshot: ReturnType<typeof vi.fn<() => RealitySplatRuntimeSnapshot>>;
  setSelected: ReturnType<typeof vi.fn<(instanceId: string, selected: boolean) => void>>;
  handleContextLost: ReturnType<typeof vi.fn<(event?: Event) => void>>;
  remove: ReturnType<typeof vi.fn<(instanceId: string) => boolean>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}>;

type ThreeRendererAccess = {
  renderer: RendererDouble | null;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  keyboardTarget: HTMLElement | null;
  currentState: Readonly<SceneState> | null;
  realityRuntime: RealityRuntimeDouble | null;
  entityLayer: THREE.Group;
  entities: Map<string, THREE.Object3D>;
  tweens: Set<Readonly<{ key?: string }>>;
  renderOrigin: THREE.Vector3;
  realityMeasurementOverlay: THREE.Group | null;
  realityMeasurementSession: Readonly<{
    componentId: string;
    sessionId: number;
    complete: boolean;
  }> | null;
  handlePointerDown: (event: PointerEvent) => void;
  handlePointerUp: (event: PointerEvent) => void;
  handlePointerCancel: (event: PointerEvent) => void;
  handleLostPointerCapture: (event: PointerEvent) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleContextLost: (event: Event) => void;
};

type Harness = Readonly<{
  renderer: ThreeRenderer;
  access: ThreeRendererAccess;
  canvas: HTMLCanvasElement;
  runtime: RealityRuntimeDouble;
  events: RealityMeasurementEvent[];
  realityRoot: THREE.Group;
}>;

const REALITY_ID = "REALITY_MEASURE";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ThreeRenderer Reality two-point measurement", () => {
  it("routes pointer NDC picks into source/world measurements and places floating-origin-safe A/B helpers", () => {
    const harness = createHarness({ renderOrigin: new THREE.Vector3(1_000, 20, -500) });
    const { renderer, access, canvas, runtime, events } = harness;
    runtime.raycastSurface
      .mockReturnValueOnce(surfaceHit(
        { x: 1, y: 2, z: 3 },
        { x: 0, y: 0, z: 0 },
        6,
      ))
      .mockReturnValueOnce(surfaceHit(
        { x: 5, y: 8, z: 6 },
        { x: 3, y: 4, z: 0 },
        7,
      ));

    expect(renderer.startRealityMeasurement(REALITY_ID)).toBe(true);
    expect(document.activeElement).toBe(canvas);
    expect(canvas.dataset.realityMeasurement).toBe("picking-point-a");
    expect(canvas.getAttribute("aria-description")).toMatch(/Two-point Reality measurement/);
    expect(events[0]).toMatchObject({
      kind: "started",
      componentId: REALITY_ID,
      assetId: "ra_test",
      assetDigest: "sha256:test",
    });

    clickAt(access, 100, 50);
    clickAt(access, 100, 50);

    expect(runtime.raycastSurface).toHaveBeenCalledTimes(2);
    const firstRaycaster = runtime.raycastSurface.mock.calls[0]?.[1];
    expect(firstRaycaster?.ray.origin.x).toBeCloseTo(0, 8);
    expect(firstRaycaster?.ray.origin.y).toBeCloseTo(0, 8);
    expect(firstRaycaster?.ray.origin.z).toBeCloseTo(5, 8);
    expect(firstRaycaster?.ray.direction.x).toBeCloseTo(0, 8);
    expect(firstRaycaster?.ray.direction.y).toBeCloseTo(0, 8);
    expect(firstRaycaster?.ray.direction.z).toBeCloseTo(-1, 8);

    expect(events.map((event) => event.kind)).toEqual(["started", "point", "point", "complete"]);
    const complete = events.at(-1);
    expect(complete?.kind).toBe("complete");
    if (complete?.kind !== "complete") throw new Error("Expected a completed Reality measurement.");
    expect(complete.sourceDistance).toBe(5);
    expect(complete.displayedDistance).toBeCloseTo(Math.sqrt(61), 12);
    expect(complete).toMatchObject({ assetId: "ra_test", assetDigest: "sha256:test" });
    expect(Object.isFrozen(complete.points)).toBe(true);
    expect(complete.points[0].worldPoint).toEqual({ x: 1_001, y: 22, z: -497 });
    expect(complete.points[1].worldPoint).toEqual({ x: 1_005, y: 28, z: -494 });

    const overlay = access.realityMeasurementOverlay;
    expect(overlay?.children.map((child) => child.name)).toEqual([
      "reality-measurement-point-a",
      "reality-measurement-point-b",
      "reality-measurement-line",
    ]);
    const firstMarker = overlay?.getObjectByName("reality-measurement-point-a");
    const secondMarker = overlay?.getObjectByName("reality-measurement-point-b");
    expect(firstMarker?.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([1, 2, 3]);
    expect(secondMarker?.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([5, 8, 6]);
    expect(access.realityMeasurementSession?.complete).toBe(true);
    expect(canvas.dataset.realityMeasurement).toBe("complete");
    expect(canvas.getAttribute("aria-description")).toBe(
      "Two-point Reality measurement complete. Markers A and B show the sampled span. Press Escape to clear them.",
    );

    const enterAfterCompletion = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    access.handleKeyDown(enterAfterCompletion);
    expect(enterAfterCompletion.defaultPrevented).toBe(true);
    expect(runtime.raycastSurface).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.kind)).toEqual(["started", "point", "point", "complete"]);

    const helperResources = overlay?.children.map((child) => {
      const renderable = child as THREE.Mesh | THREE.Line;
      return {
        geometry: vi.spyOn(renderable.geometry, "dispose"),
        material: vi.spyOn(renderable.material as THREE.Material, "dispose"),
      };
    }) ?? [];
    renderer.cancelRealityMeasurement();
    for (const resource of helperResources) {
      expect(resource.geometry).toHaveBeenCalledOnce();
      expect(resource.material).toHaveBeenCalledOnce();
    }
    expect(events.at(-1)).toMatchObject({ kind: "cancelled", componentId: REALITY_ID });
    expect(access.realityMeasurementOverlay).toBeNull();
  });

  it("focuses the viewport, supports center Enter picks, and makes Escape a real cancel path", () => {
    const { renderer, access, canvas, runtime, events } = createHarness();
    runtime.raycastSurface.mockReturnValue(surfaceHit(
      { x: 0, y: 0, z: 0 },
      { x: 0.25, y: 0.5, z: 0.75 },
      5,
    ));

    renderer.startRealityMeasurement(REALITY_ID);
    expect(document.activeElement).toBe(canvas);

    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    access.handleKeyDown(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(runtime.raycastSurface).toHaveBeenCalledOnce();
    const centerRay = runtime.raycastSurface.mock.calls[0]?.[1];
    expect(centerRay?.ray.direction.x).toBeCloseTo(0, 8);
    expect(centerRay?.ray.direction.y).toBeCloseTo(0, 8);
    expect(centerRay?.ray.direction.z).toBeCloseTo(-1, 8);
    expect(events.at(-1)).toMatchObject({ kind: "point", pointIndex: 1 });

    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    access.handleKeyDown(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "cancelled", componentId: REALITY_ID });
    expect(access.realityMeasurementSession).toBeNull();
    expect(access.realityMeasurementOverlay).toBeNull();
    expect(canvas.dataset.realityMeasurement).toBeUndefined();
    expect(canvas.hasAttribute("aria-description")).toBe(false);
  });

  it("fails closed for overlapping pointers instead of turning a pinch gesture into a surface pick", () => {
    const { renderer, access, runtime, events } = createHarness();
    runtime.raycastSurface.mockReturnValue(surfaceHit(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      5,
    ));
    renderer.startRealityMeasurement(REALITY_ID);
    const primary = {
      clientX: 90,
      clientY: 45,
      button: 0,
      pointerId: 1,
      isPrimary: true,
    } as PointerEvent;
    const secondary = {
      clientX: 110,
      clientY: 55,
      button: 0,
      pointerId: 2,
      isPrimary: false,
    } as PointerEvent;

    access.handlePointerDown(primary);
    access.handlePointerDown(secondary);
    access.handlePointerUp(secondary);
    access.handlePointerUp(primary);

    expect(runtime.raycastSurface).not.toHaveBeenCalled();
    expect(events.map((event) => event.kind)).toEqual(["started"]);
    clickAt(access, 100, 50);
    expect(runtime.raycastSurface).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ kind: "point", pointIndex: 1 });
  });

  it("rejects measurement while the Reality subject or any ancestor has an active transform tween", () => {
    const { renderer, access, events } = createHarness();

    access.tweens.add({ key: `entity:${REALITY_ID}:transform` });
    expect(renderer.startRealityMeasurement(REALITY_ID)).toBe(false);
    expect(events).toEqual([]);

    access.tweens.clear();
    const state = access.currentState;
    if (!state) throw new Error("Expected a current renderer state.");
    state.entities.set("PARENT", entity("PARENT", false));
    state.entities.set(REALITY_ID, {
      ...state.entities.get(REALITY_ID)!,
      parentId: "PARENT",
    });
    access.tweens.add({ key: "entity:PARENT:transform" });
    expect(renderer.startRealityMeasurement(REALITY_ID)).toBe(false);
    expect(events).toEqual([]);

    access.tweens.clear();
    expect(renderer.startRealityMeasurement(REALITY_ID)).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(["started"]);
  });

  it("drops cancelled and cross-session pointer gestures before they can pick a Reality surface", () => {
    const { renderer, access, runtime, events } = createHarness();
    runtime.raycastSurface.mockReturnValue(surfaceHit(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      5,
    ));
    const cancelledPointer = pointerAt(91, 46, 17);
    renderer.startRealityMeasurement(REALITY_ID);
    access.handlePointerDown(cancelledPointer);
    access.handlePointerCancel(cancelledPointer);
    access.handlePointerUp(cancelledPointer);
    expect(runtime.raycastSurface).not.toHaveBeenCalled();

    const stalePointer = pointerAt(103, 51, 23);
    access.handlePointerDown(stalePointer);
    renderer.cancelRealityMeasurement();
    expect(renderer.startRealityMeasurement(REALITY_ID)).toBe(true);
    access.handlePointerUp(stalePointer);
    expect(runtime.raycastSurface).not.toHaveBeenCalled();

    clickAt(access, 100, 50);
    expect(runtime.raycastSurface).toHaveBeenCalledOnce();
    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "cancelled",
      "started",
      "point",
    ]);
  });

  it("cancels a captured desktop gesture without ending the measurement or accepting its late pointer-up", () => {
    const { renderer, access, canvas, runtime, events } = createHarness();
    runtime.raycastSurface.mockReturnValue(surfaceHit(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      5,
    ));
    const pointerCancels: number[] = [];
    canvas.addEventListener("pointercancel", (event) => {
      pointerCancels.push((event as PointerEvent).pointerId);
    });
    renderer.startRealityMeasurement(REALITY_ID);
    const stalePointer = pointerAt(100, 50, 41);
    access.handlePointerDown(stalePointer);

    renderer.cancelDesktopInteractions();
    access.handlePointerUp(stalePointer);

    expect(pointerCancels).toEqual([41]);
    expect(runtime.raycastSurface).not.toHaveBeenCalled();
    expect(events.map((event) => event.kind)).toEqual(["started"]);
    clickAt(access, 100, 50);
    expect(runtime.raycastSurface).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ kind: "point", pointIndex: 1 });
  });

  it("clears an unmatched lost pointer capture before a later pointerup", async () => {
    const { renderer, access, canvas, runtime, events } = createHarness();
    const pointerCancels: number[] = [];
    canvas.addEventListener("pointercancel", (event) => {
      pointerCancels.push((event as PointerEvent).pointerId);
    });
    runtime.raycastSurface.mockReturnValue(surfaceHit(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      5,
    ));
    renderer.startRealityMeasurement(REALITY_ID);
    const lostPointer = pointerAt(100, 50, 31);
    access.handlePointerDown(lostPointer);
    access.handleLostPointerCapture(lostPointer);
    await Promise.resolve();
    access.handlePointerUp(lostPointer);

    expect(pointerCancels).toEqual([31]);
    expect(runtime.raycastSurface).not.toHaveBeenCalled();
    expect(events.map((event) => event.kind)).toEqual(["started"]);
  });

  it("disposes marker GPU helpers and cancels when selection leaves the measured capture", () => {
    const { renderer, access, canvas, runtime, events } = createHarness({ includeOtherEntity: true });
    runtime.raycastSurface.mockReturnValue(surfaceHit(
      { x: 0.5, y: 0.25, z: -0.75 },
      { x: 0.5, y: 0.25, z: -0.75 },
      5,
    ));
    renderer.startRealityMeasurement(REALITY_ID);
    clickAt(access, 100, 50);
    const marker = access.realityMeasurementOverlay
      ?.getObjectByName("reality-measurement-point-a") as THREE.Mesh;
    const geometryDispose = vi.spyOn(marker.geometry, "dispose");
    const materialDispose = vi.spyOn(marker.material as THREE.Material, "dispose");

    renderer.setSelectedEntity("OTHER", false);

    expect(events.at(-1)).toMatchObject({ kind: "cancelled", componentId: REALITY_ID });
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(access.realityMeasurementOverlay).toBeNull();
    expect(canvas.style.cursor).toBe("");
  });

  it("clears and announces an active session before delegating WebGL context loss", () => {
    const { renderer, access, canvas, runtime, events } = createHarness();
    runtime.raycastSurface.mockReturnValue(surfaceHit(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      5,
    ));
    renderer.startRealityMeasurement(REALITY_ID);
    clickAt(access, 100, 50);

    const contextLost = new Event("webglcontextlost", { cancelable: true });
    access.handleContextLost(contextLost);

    expect(contextLost.defaultPrevented).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "cancelled", componentId: REALITY_ID });
    expect(runtime.handleContextLost).toHaveBeenCalledWith(contextLost);
    expect(access.realityMeasurementSession).toBeNull();
    expect(access.realityMeasurementOverlay).toBeNull();
    expect(canvas.hasAttribute("aria-description")).toBe(false);
    expect(access.entities.has(REALITY_ID)).toBe(false);
  });

  it("silently releases measurement helpers when the renderer lifetime is disposed", () => {
    const { renderer, access, canvas, runtime, events } = createHarness();
    runtime.raycastSurface.mockReturnValue(surfaceHit(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      5,
    ));
    renderer.startRealityMeasurement(REALITY_ID);
    clickAt(access, 100, 50);
    const marker = access.realityMeasurementOverlay
      ?.getObjectByName("reality-measurement-point-a") as THREE.Mesh;
    const geometryDispose = vi.spyOn(marker.geometry, "dispose");
    const materialDispose = vi.spyOn(marker.material as THREE.Material, "dispose");

    renderer.dispose();

    expect(events.map((event) => event.kind)).toEqual(["started", "point"]);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(access.realityMeasurementSession).toBeNull();
    expect(access.realityMeasurementOverlay).toBeNull();
    expect(canvas.isConnected).toBe(false);
  });
});

function createHarness(options: Readonly<{
  renderOrigin?: THREE.Vector3;
  includeOtherEntity?: boolean;
}> = {}): Harness {
  const events: RealityMeasurementEvent[] = [];
  const renderer = new ThreeRenderer({
    reducedMotion: true,
    onRealityMeasurement: (event) => events.push(event),
  });
  const access = renderer as unknown as ThreeRendererAccess;
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    toJSON: () => undefined,
  });
  document.body.appendChild(canvas);
  const rendererDouble: RendererDouble = {
    domElement: canvas,
    setAnimationLoop: vi.fn(),
    dispose: vi.fn(),
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 2, 0.01, 1_000);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const state = createInitialScene();
  const realityEntity = entity(REALITY_ID, true);
  state.entities.set(REALITY_ID, realityEntity);

  const realityRoot = entityRoot(REALITY_ID, true);
  access.entityLayer.name = "scene-entities";
  scene.add(access.entityLayer);
  access.entityLayer.add(realityRoot);
  access.entities.set(REALITY_ID, realityRoot);
  if (options.includeOtherEntity) {
    const other = entity("OTHER", false);
    const otherRoot = entityRoot("OTHER", false);
    state.entities.set("OTHER", other);
    access.entityLayer.add(otherRoot);
    access.entities.set("OTHER", otherRoot);
  }

  const snapshot: RealitySplatRuntimeSnapshot = {
    disposed: false,
    contextLost: false,
    providerLoaded: true,
    instanceIds: [REALITY_ID],
    pendingInstanceIds: [],
  };
  const runtime: RealityRuntimeDouble = {
    getHandle: vi.fn((instanceId) => instanceId === REALITY_ID ? {
      instanceId,
      root: realityRoot,
      selectionObject: realityRoot,
    } : undefined),
    raycastSurface: vi.fn(),
    snapshot: vi.fn(() => snapshot),
    setSelected: vi.fn(),
    handleContextLost: vi.fn(),
    remove: vi.fn(() => true),
    dispose: vi.fn(),
  };

  access.renderer = rendererDouble;
  access.scene = scene;
  access.camera = camera;
  access.keyboardTarget = canvas;
  access.currentState = state;
  access.realityRuntime = runtime;
  access.renderOrigin.copy(options.renderOrigin ?? new THREE.Vector3());
  access.entityLayer.position.copy(access.renderOrigin).multiplyScalar(-1);
  scene.updateMatrixWorld(true);

  return { renderer, access, canvas, runtime, events, realityRoot };
}

function entity(id: string, reality: boolean): EntityState {
  return {
    id,
    kind: "primitive",
    assetId: reality ? "reality:test" : "primitive_box",
    label: id,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    appearance: { opacity: 1 },
    state: { type: "generic", properties: {} },
    ...(reality ? {
      renderGeometry: {
        kind: "reality" as const,
        asset: {
          assetId: "ra_test",
          digest: "sha256:test",
          format: "ply" as const,
          byteLength: 4,
          splatCount: 1,
        },
        bounds: {
          min: { x: -1, y: -1, z: -1 },
          max: { x: 1, y: 1, z: 1 },
        },
        sourceAxisSigns: { x: 1, y: 1, z: 1 },
        metersPerSourceUnit: 1,
        quality: "auto" as const,
        engineeringAuthority: "visual_only" as const,
      },
    } : {}),
    tags: [],
    locked: false,
  };
}

function entityRoot(id: string, reality: boolean): THREE.Group {
  const root = new THREE.Group();
  root.userData.entityId = id;
  root.userData.realityRuntime = reality;
  const visual = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
  );
  visual.userData.entityId = id;
  root.add(visual);
  return root;
}

function surfaceHit(
  worldPoint: Readonly<{ x: number; y: number; z: number }>,
  sourcePoint: Readonly<{ x: number; y: number; z: number }>,
  cameraDistance: number,
): RealitySplatSurfaceHit {
  return {
    worldPoint,
    sourcePoint,
    cameraDistance,
    fidelity: "gaussian-lod",
  };
}

function clickAt(access: ThreeRendererAccess, clientX: number, clientY: number): void {
  const event = { clientX, clientY, button: 0 } as PointerEvent;
  access.handlePointerDown(event);
  access.handlePointerUp(event);
}

function pointerAt(clientX: number, clientY: number, pointerId: number): PointerEvent {
  return {
    clientX,
    clientY,
    button: 0,
    pointerId,
    isPrimary: true,
  } as PointerEvent;
}
