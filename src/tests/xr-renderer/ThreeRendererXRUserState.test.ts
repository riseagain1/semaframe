import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";

type DispatchableController = THREE.Group & Readonly<{
  dispatchEvent(event: { type: string; data?: XRInputSource }): void;
}>;

type RendererInternals = {
  renderer: {
    xr: {
      isPresenting: boolean;
      getCamera(): THREE.Camera;
      getController(index: number): DispatchableController;
      getControllerGrip(index: number): THREE.Group;
      getReferenceSpace(): XRReferenceSpace;
    };
  };
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  xrRig: THREE.Group;
  xrSession: XRSession;
  renderOrigin: THREE.Vector3;
  xrControllerByInputSource: Map<XRInputSource, DispatchableController>;
  xrInputTrackingStates: Map<XRInputSource, "tracked" | "emulated" | "unavailable" | "unknown">;
  installXRControllers(): void;
  recordXRFrameSample(time: number, frame: XRFrame): void;
};

const BUTTON = Object.freeze({ pressed: false, touched: false, value: 0 });

function gamepad(options: Readonly<{
  mapping?: string;
  buttons?: readonly Partial<GamepadButton>[];
  axes?: readonly number[];
}> = {}): Gamepad {
  const buttons = Array.from({ length: 6 }, (_, index) => Object.freeze({
    ...BUTTON,
    ...options.buttons?.[index],
  }));
  return {
    axes: options.axes ?? [0, 0, 0, 0],
    buttons,
    connected: true,
    hand: "",
    hapticActuators: [],
    id: "test-xr-controller",
    index: 0,
    mapping: options.mapping ?? "xr-standard",
    timestamp: 0,
    vibrationActuator: null,
  } as unknown as Gamepad;
}

function inputSource(
  handedness: XRHandedness,
  targetRaySpace: XRSpace,
  gripSpace: XRSpace | null,
  pad: Gamepad,
  targetRayMode: XRTargetRayMode = "tracked-pointer",
): XRInputSource {
  return {
    handedness,
    targetRayMode,
    targetRaySpace,
    gripSpace,
    gamepad: pad,
    profiles: ["generic-trigger-squeeze-thumbstick"],
  } as XRInputSource;
}

function session(inputSources: readonly XRInputSource[], visibilityState: XRVisibilityState = "visible"): XRSession {
  return { inputSources, visibilityState } as unknown as XRSession;
}

function frameWithTrackedSpaces(
  referenceSpace: XRReferenceSpace,
  unavailableSpaces: ReadonlySet<XRSpace> = new Set(),
): XRFrame {
  return {
    getViewerPose: (space: XRReferenceSpace) => space === referenceSpace
      ? { emulatedPosition: false }
      : null,
    getPose: (space: XRSpace, baseSpace: XRSpace) => (
      baseSpace === referenceSpace && !unavailableSpaces.has(space)
        ? { emulatedPosition: false }
        : null
    ),
  } as unknown as XRFrame;
}

describe("ThreeRenderer Agent-readable XR User State v2", () => {
  it("captures room-scale body position, stable source identity, grip poses, rays, and semantic actions", () => {
    const renderer = new ThreeRenderer();
    const internal = renderer as unknown as RendererInternals;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const controllers = [new THREE.Group(), new THREE.Group()] as DispatchableController[];
    const grips = [new THREE.Group(), new THREE.Group()];
    const referenceSpace = {} as XRReferenceSpace;
    const rightRaySpace = {} as XRSpace;
    const rightGripSpace = {} as XRSpace;
    const leftRaySpace = {} as XRSpace;
    const leftGripSpace = {} as XRSpace;
    const right = inputSource("right", rightRaySpace, rightGripSpace, gamepad({
      buttons: [
        { pressed: true, value: 1 },
        {},
        {},
        { pressed: true, value: 1 },
        { pressed: true, value: 1 },
      ],
      axes: [0, 0, 1.4, Number.NaN],
    }));
    const left = inputSource("left", leftRaySpace, leftGripSpace, gamepad());

    internal.renderer = {
      xr: {
        isPresenting: true,
        getCamera: () => camera,
        getController: (index: number) => controllers[index]!,
        getControllerGrip: (index: number) => grips[index]!,
        getReferenceSpace: () => referenceSpace,
      },
    };
    internal.scene = scene;
    internal.camera = camera;
    internal.xrSession = session([left, right]);
    internal.renderOrigin.set(100, 10, -50);
    internal.xrRig.position.set(2, 0, 3);
    camera.position.set(0.4, 1.8, -0.2);
    scene.add(internal.xrRig);
    internal.xrRig.add(camera);
    internal.installXRControllers();
    controllers[0]!.dispatchEvent({ type: "connected", data: right });
    controllers[1]!.dispatchEvent({ type: "connected", data: left });
    controllers[0]!.position.set(0.3, 1.25, -0.5);
    grips[0]!.position.set(0.25, 1.1, -0.45);
    controllers[1]!.position.set(-0.35, 1.2, -0.4);
    grips[1]!.position.set(-0.3, 1.05, -0.35);
    controllers[1]!.dispatchEvent({ type: "selectstart" });
    scene.updateMatrixWorld(true);

    internal.recordXRFrameSample(123.5, frameWithTrackedSpaces(referenceSpace));
    const context = renderer.captureXRSpatialContext();

    expect(context).toMatchObject({
      sampleSequence: 1,
      tracking: {
        state: "tracked",
        headPoseState: "tracked",
        sourceTimestampMs: 123.5,
        sourceTimestampBasis: "performance-time-origin",
        sessionVisibility: "visible",
      },
      primaryInputSourceId: "input-1-right",
      activeInputSourceId: "input-2-left",
      playerCapsule: {
        feet: { x: 102.4, y: 10, z: -47.2 },
        radius: 0.3,
      },
    });
    expect(context?.playerCapsule.height).toBeCloseTo(1.8, 10);
    expect(context?.tracking.sourceAgeMs).toBeGreaterThanOrEqual(0);
    expect(context?.trackedInputs).toHaveLength(2);
    expect(context?.trackedInputs[0]).toMatchObject({
      sourceId: "input-2-left",
      handedness: "left",
      trackingState: "tracked",
      targetRayMode: "tracked-pointer",
      targetRayPose: { position: { x: 101.65, y: 11.2, z: -47.4 } },
      gripPose: { position: { x: 101.7, y: 11.05, z: -47.35 } },
      actions: { available: true, selectPressed: true },
    });
    expect(context?.trackedInputs[1]).toMatchObject({
      sourceId: "input-1-right",
      handedness: "right",
      trackingState: "tracked",
      targetRayPose: { position: { x: 102.3, y: 11.25, z: -47.5 } },
      gripPose: { position: { x: 102.25, y: 11.1, z: -47.45 } },
      actions: {
        available: true,
        selectPressed: true,
        primaryButtonPressed: true,
        thumbstickPressed: true,
        thumbstick: { x: 1, y: 0 },
      },
    });
    expect(context?.trackedInputs[1]?.ray).toBe(context?.primaryRay);
  });

  it("fails closed for an unavailable pose and an unknown controller mapping", () => {
    const renderer = new ThreeRenderer();
    const internal = renderer as unknown as RendererInternals;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const controller = new THREE.Group() as DispatchableController;
    const grip = new THREE.Group();
    const referenceSpace = {} as XRReferenceSpace;
    const raySpace = {} as XRSpace;
    const gripSpace = {} as XRSpace;
    const source = inputSource("none", raySpace, gripSpace, gamepad({
      mapping: "vendor-layout",
      buttons: [{ pressed: true }],
      axes: [1, 1, 1, 1],
    }), "screen");

    internal.renderer = {
      xr: {
        isPresenting: true,
        getCamera: () => camera,
        getController: () => controller,
        getControllerGrip: () => grip,
        getReferenceSpace: () => referenceSpace,
      },
    };
    internal.scene = scene;
    internal.camera = camera;
    internal.xrSession = session([source]);
    scene.add(internal.xrRig);
    internal.xrRig.add(camera);
    internal.installXRControllers();
    controller.dispatchEvent({ type: "connected", data: source });
    scene.updateMatrixWorld(true);
    internal.recordXRFrameSample(
      456.75,
      frameWithTrackedSpaces(referenceSpace, new Set([raySpace, gripSpace])),
    );

    const context = renderer.captureXRSpatialContext();
    expect(context?.tracking.state).toBe("limited");
    expect(context?.trackedInputs[0]).toMatchObject({
      trackingState: "unavailable",
      targetRayMode: "screen",
      actions: {
        available: false,
        selectPressed: false,
        squeezePressed: false,
        primaryButtonPressed: false,
        secondaryButtonPressed: false,
        thumbstickPressed: false,
        thumbstick: { x: 0, y: 0 },
      },
    });
    expect(context?.trackedInputs[0]?.gripPose).toBeUndefined();
    expect(context?.trackedInputs[0]?.ray).toBeUndefined();
    expect(context?.primaryInputSourceId).toBeUndefined();
    expect(context?.primaryRay).toBeUndefined();
  });

  it("chooses a tracked left-hand ray over an unknown right-hand source", () => {
    const renderer = new ThreeRenderer();
    const internal = renderer as unknown as RendererInternals;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const rightController = new THREE.Group() as DispatchableController;
    const leftController = new THREE.Group() as DispatchableController;
    const referenceSpace = {} as XRReferenceSpace;
    const unknownRightSpace = {} as XRSpace;
    const trackedLeftSpace = {} as XRSpace;
    const right = inputSource("right", unknownRightSpace, null, gamepad());
    const left = inputSource("left", trackedLeftSpace, null, gamepad());

    internal.renderer = {
      xr: {
        isPresenting: true,
        getCamera: () => camera,
        getController: () => rightController,
        getControllerGrip: () => new THREE.Group(),
        getReferenceSpace: () => referenceSpace,
      },
    };
    internal.scene = scene;
    internal.camera = camera;
    internal.xrSession = session([right, left]);
    internal.xrRig.add(camera, rightController, leftController);
    scene.add(internal.xrRig);
    rightController.position.set(10, 1, 0);
    leftController.position.set(-2, 1.2, 0.5);
    internal.xrControllerByInputSource.set(right, rightController);
    internal.xrControllerByInputSource.set(left, leftController);
    scene.updateMatrixWorld(true);
    internal.recordXRFrameSample(
      600,
      frameWithTrackedSpaces(referenceSpace),
    );
    internal.xrInputTrackingStates.set(right, "unknown");

    const context = renderer.captureXRSpatialContext();
    expect(context?.tracking.state).toBe("limited");
    expect(context?.trackedInputs.map(({ handedness, trackingState }) => ({ handedness, trackingState })))
      .toEqual([
        { handedness: "right", trackingState: "unknown" },
        { handedness: "left", trackingState: "tracked" },
      ]);
    expect(context?.trackedInputs[0]?.ray).toBeUndefined();
    expect(context?.primaryInputSourceId).toBe("input-2-left");
    expect(context?.primaryRay?.origin).toEqual({ x: -2, y: 1.2, z: 0.5 });
  });

  it("switches active input to the latest significant thumbstick activity", () => {
    const renderer = new ThreeRenderer();
    const internal = renderer as unknown as RendererInternals;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const controllers = [new THREE.Group(), new THREE.Group()] as DispatchableController[];
    const grips = [new THREE.Group(), new THREE.Group()];
    const referenceSpace = {} as XRReferenceSpace;
    const rightAxes = [0, 0, 0, 0];
    const leftAxes = [0, 0, 0, 0];
    const right = inputSource("right", {} as XRSpace, null, gamepad({ axes: rightAxes }));
    const left = inputSource("left", {} as XRSpace, null, gamepad({ axes: leftAxes }));

    internal.renderer = {
      xr: {
        isPresenting: true,
        getCamera: () => camera,
        getController: (index: number) => controllers[index]!,
        getControllerGrip: (index: number) => grips[index]!,
        getReferenceSpace: () => referenceSpace,
      },
    };
    internal.scene = scene;
    internal.camera = camera;
    internal.xrSession = session([right, left]);
    scene.add(internal.xrRig);
    internal.xrRig.add(camera);
    internal.installXRControllers();
    controllers[0]!.dispatchEvent({ type: "connected", data: right });
    controllers[1]!.dispatchEvent({ type: "connected", data: left });
    scene.updateMatrixWorld(true);
    const frame = frameWithTrackedSpaces(referenceSpace);

    internal.recordXRFrameSample(700, frame);
    expect(renderer.captureXRSpatialContext()?.activeInputSourceId).toBeUndefined();

    rightAxes[2] = 0.5;
    internal.recordXRFrameSample(701, frame);
    expect(renderer.captureXRSpatialContext()?.activeInputSourceId).toBe("input-1-right");

    leftAxes[3] = -0.65;
    internal.recordXRFrameSample(702, frame);
    expect(renderer.captureXRSpatialContext()?.activeInputSourceId).toBe("input-2-left");

    // Sub-threshold jitter on the other stick is not a new intentional action.
    rightAxes[2] = 0.55;
    internal.recordXRFrameSample(703, frame);
    expect(renderer.captureXRSpatialContext()?.activeInputSourceId).toBe("input-2-left");
  });
});
