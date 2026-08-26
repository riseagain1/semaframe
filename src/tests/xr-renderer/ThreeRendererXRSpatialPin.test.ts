import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  ThreeRenderer,
  type ThreeRendererXRSpatialPinEvent,
} from "../../renderer/ThreeRenderer";
import type { XRSpatialPin } from "../../xr/client";

type DispatchableController = THREE.Group & Readonly<{
  dispatchEvent(event: { type: string; data?: XRInputSource }): void;
}>;

type SpatialPinLayerStub = Readonly<{
  setPin: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  showMiss: ReturnType<typeof vi.fn>;
}>;

type RendererInternals = {
  renderer: {
    xr: {
      isPresenting: boolean;
      enabled?: boolean;
      getCamera(): THREE.Camera;
      getController?(index: number): DispatchableController;
      getSession?(): XRSession | null;
      setSession?(session: XRSession | null): Promise<void>;
    };
  };
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls?: { enabled: boolean };
  environmentRoot?: THREE.Group;
  xrRig: THREE.Group;
  xrSession: XRSession | null;
  xrSpatialPin?: XRSpatialPin;
  xrSpatialPinLayer?: SpatialPinLayerStub;
  pendingXRWorkspaceRevision?: number;
  renderOrigin: THREE.Vector3;
  entities: Map<string, THREE.Object3D>;
  currentState?: Readonly<{
    entities: ReadonlyMap<string, Readonly<{
      state: Readonly<{ type: "generic"; properties: Readonly<Record<string, never>> }>;
      appearance: Readonly<Record<string, never>>;
      renderGeometry: Readonly<{ kind: "reality" }>;
    }>>;
  }>;
  realityRuntime?: Readonly<{
    raycastSurface(entityId: string, raycaster: THREE.Raycaster): undefined;
  }>;
  xrControllerByInputSource: Map<XRInputSource, DispatchableController>;
  xrInputSourceByController: Map<DispatchableController, XRInputSource>;
  xrInputTrackingStates: Map<XRInputSource, "tracked" | "emulated" | "unavailable" | "unknown">;
  installXRControllers(): void;
  placeXRSpatialPin(controller: DispatchableController, source: XRInputSource): boolean;
  cleanupXRSession(session: XRSession): Promise<void>;
};

function pinLayer(): SpatialPinLayerStub {
  return {
    setPin: vi.fn(),
    clear: vi.fn(),
    showMiss: vi.fn(),
  };
}

function inputSource(handedness: XRHandedness): XRInputSource {
  return { handedness } as XRInputSource;
}

function activeSession(inputSources: readonly XRInputSource[]): XRSession {
  const target = new EventTarget() as EventTarget & {
    inputSources: readonly XRInputSource[];
    end(): Promise<void>;
  };
  target.inputSources = inputSources;
  target.end = vi.fn(async () => undefined);
  return target as unknown as XRSession;
}

function seededPin(revision = 7): XRSpatialPin {
  return Object.freeze({
    pinId: "xr-pin-seeded",
    pinSequence: 1,
    workspacePositionM: Object.freeze({ x: 1.25, y: 0.75, z: -2.5 }),
    surfaceNormal: Object.freeze({ x: 0, y: 1, z: 0 }),
    hitKind: "ground",
    sourceId: "input-1-right",
    handedness: "right",
    placedAtMs: 100,
    placedAtWorkspaceRevision: revision,
    coordinateSpace: "workspace-world-rub",
    units: "metre",
    authority: "render-interaction-estimate",
  });
}

describe("ThreeRenderer ephemeral XR Spatial Pin", () => {
  it("preserves the exact semantic ray-hit point in live context and clears it on revision change", () => {
    const changes: ThreeRendererXRSpatialPinEvent[] = [];
    const renderer = new ThreeRenderer({ onXRSpatialPinChange: (event) => changes.push(event) });
    const internal = renderer as unknown as RendererInternals;
    const layer = pinLayer();
    const source = inputSource("right");
    const session = activeSession([source]);
    const scene = new THREE.Scene();
    const rig = internal.xrRig;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.65, 0);
    const controller = new THREE.Group() as DispatchableController;
    controller.position.set(0.23456789, 1.5, 0.987654321);
    rig.add(camera, controller);
    scene.add(rig);

    const environment = new THREE.Group();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 0.1));
    wall.position.z = -3;
    environment.add(wall);
    scene.add(environment);

    internal.scene = scene;
    internal.camera = camera;
    internal.environmentRoot = environment;
    internal.xrSession = session;
    internal.xrSpatialPinLayer = layer;
    internal.pendingXRWorkspaceRevision = 12;
    internal.renderOrigin.set(1_000, 200, -500);
    internal.xrControllerByInputSource.set(source, controller);
    internal.xrInputSourceByController.set(controller, source);
    internal.xrInputTrackingStates.set(source, "tracked");
    internal.renderer = {
      xr: {
        isPresenting: true,
        getCamera: () => camera,
      },
    };
    scene.updateMatrixWorld(true);

    const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
    expect(internal.placeXRSpatialPin(controller, source)).toBe(true);
    now.mockRestore();

    const placed = changes[0]?.pin;
    expect(placed).toBeDefined();
    expect(placed?.workspacePositionM.x).toBeCloseTo(1_000.23456789, 10);
    expect(placed?.workspacePositionM.y).toBeCloseTo(201.5, 10);
    // Triangle intersection retains sub-nanometre floating-point noise while
    // still preserving far more precision than the three-decimal HUD label.
    expect(placed?.workspacePositionM.z).toBeCloseTo(-502.95, 8);
    expect(placed?.workspacePositionM.x).not.toBe(1_000.235);
    expect(placed).toMatchObject({
      hitKind: "surface",
      surfaceNormal: { x: 0, y: 0, z: 1 },
      sourceId: "input-1-right",
      handedness: "right",
      placedAtMs: 5_000,
      placedAtWorkspaceRevision: 12,
      coordinateSpace: "workspace-world-rub",
      units: "metre",
      authority: "render-interaction-estimate",
    });
    expect(layer.setPin).toHaveBeenCalledWith(placed);

    const context = renderer.captureXRSpatialContext();
    expect(context?.spatialPin).toBe(placed);
    expect(context?.spatialPin?.workspacePositionM).toEqual(context?.rayHit?.point);

    renderer.setXRWorldPanels([], 13);
    expect(changes.map(({ action }) => action)).toEqual(["placed", "cleared"]);
    expect(layer.clear).toHaveBeenCalledWith(false);
    expect(renderer.captureXRSpatialContext()?.spatialPin).toBeUndefined();
  });

  it("clears the renderer-owned pin during XR session cleanup without persisting it", async () => {
    const changes = vi.fn();
    const renderer = new ThreeRenderer({ onXRSpatialPinChange: changes });
    const internal = renderer as unknown as RendererInternals;
    const layer = pinLayer();
    const session = activeSession([]);
    const camera = new THREE.PerspectiveCamera();
    internal.camera = camera;
    internal.xrRig.add(camera);
    internal.xrSession = session;
    internal.xrSpatialPin = seededPin();
    internal.xrSpatialPinLayer = layer;
    internal.controls = { enabled: false };
    internal.renderer = {
      xr: {
        isPresenting: true,
        enabled: true,
        getCamera: () => camera,
        getSession: () => session,
        setSession: vi.fn(async () => undefined),
      },
    };

    await internal.cleanupXRSession(session);

    expect(internal.xrSpatialPin).toBeUndefined();
    expect(layer.clear).toHaveBeenCalledWith(false);
    expect(changes).not.toHaveBeenCalled();
    expect(internal.xrSession).toBeNull();
    expect(internal.controls.enabled).toBe(true);
  });

  it("never turns an invisible Reality bounds proxy into a coordinate", () => {
    const renderer = new ThreeRenderer();
    const internal = renderer as unknown as RendererInternals;
    const layer = pinLayer();
    const source = inputSource("right");
    const controller = new THREE.Group() as DispatchableController;
    const proxyGeometry = new THREE.BoxGeometry(2, 2, 2);
    const proxyMaterial = new THREE.MeshBasicMaterial();
    const proxy = new THREE.Mesh(proxyGeometry, proxyMaterial);
    proxy.position.z = -3;
    proxy.userData.entityId = "reality-1";
    proxy.userData.realitySelectionProxy = true;
    const scene = new THREE.Scene();
    scene.add(controller, proxy);
    scene.updateMatrixWorld(true);

    internal.scene = scene;
    internal.camera = new THREE.PerspectiveCamera();
    internal.xrSession = activeSession([source]);
    internal.xrSpatialPinLayer = layer;
    internal.pendingXRWorkspaceRevision = 2;
    internal.entities.set("reality-1", proxy);
    internal.currentState = {
      entities: new Map([[
        "reality-1",
        {
          state: { type: "generic", properties: {} },
          appearance: {},
          renderGeometry: { kind: "reality" },
        },
      ]]),
    };
    internal.realityRuntime = { raycastSurface: vi.fn(() => undefined) };
    internal.xrControllerByInputSource.set(source, controller);
    internal.xrInputSourceByController.set(controller, source);
    internal.renderer = {
      xr: {
        isPresenting: true,
        getCamera: () => internal.camera,
      },
    };

    expect(internal.placeXRSpatialPin(controller, source)).toBe(false);
    expect(internal.realityRuntime.raycastSurface).toHaveBeenCalledWith("reality-1", expect.any(THREE.Raycaster));
    expect(layer.showMiss).toHaveBeenCalledOnce();
    expect(layer.setPin).not.toHaveBeenCalled();
    expect(internal.xrSpatialPin).toBeUndefined();

    proxyGeometry.dispose();
    proxyMaterial.dispose();
  });

  it("keeps XRInputSource-to-controller identity exact when runtime source order changes", () => {
    const renderer = new ThreeRenderer();
    const internal = renderer as unknown as RendererInternals;
    const controllers = [new THREE.Group(), new THREE.Group()] as DispatchableController[];
    const right = inputSource("right");
    const left = inputSource("left");
    const camera = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();

    internal.renderer = {
      xr: {
        isPresenting: true,
        getCamera: () => camera,
        getController: (index) => controllers[index]!,
      },
    };
    internal.scene = scene;
    internal.camera = camera;
    scene.add(internal.xrRig);
    internal.xrRig.add(camera);
    internal.installXRControllers();
    controllers[0]!.dispatchEvent({ type: "connected", data: right });
    controllers[1]!.dispatchEvent({ type: "connected", data: left });
    controllers[0]!.position.set(4.25, 1.25, -0.5);
    controllers[1]!.position.set(-3.75, 1.4, 0.25);

    // The session has reordered sources relative to getController(index). The
    // explicit identity maps, not array indexes, must choose each pose/ray.
    internal.xrSession = activeSession([left, right]);
    internal.xrInputTrackingStates.set(left, "tracked");
    internal.xrInputTrackingStates.set(right, "tracked");
    scene.updateMatrixWorld(true);

    const context = renderer.captureXRSpatialContext();
    expect(context?.trackedInputs).toEqual([
      expect.objectContaining({
        sourceId: "input-2-left",
        handedness: "left",
        targetRayPose: expect.objectContaining({ position: { x: -3.75, y: 1.4, z: 0.25 } }),
      }),
      expect.objectContaining({
        sourceId: "input-1-right",
        handedness: "right",
        targetRayPose: expect.objectContaining({ position: { x: 4.25, y: 1.25, z: -0.5 } }),
      }),
    ]);
    expect(context?.primaryRay?.origin).toEqual({ x: 4.25, y: 1.25, z: -0.5 });
  });
});
