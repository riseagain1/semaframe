import type {
  XRControllerRay,
  XRInputFramePort,
  XRNormalizedInputFrame,
  XRPose,
} from "./contracts";
import { finiteNumber, finiteVec3, normalizePose, normalizeVec3 } from "./math";

export type DesktopSimulatorCapabilities = Readonly<{
  source: "desktop-simulator";
  immersive: false;
  sixDegreesOfFreedom: true;
  pointerRay: true;
  pushToTalk: true;
}>;

export type DesktopSimulatorBindings = Readonly<{
  moveForward: string;
  moveBackward: string;
  moveLeft: string;
  moveRight: string;
  snapLeft: string;
  snapRight: string;
  pushToTalk: string;
  select: string;
  cancel: string;
}>;

export type DesktopSimulatorInput =
  | Readonly<{ type: "key"; code: string; pressed: boolean; repeat?: boolean }>
  | Readonly<{ type: "head-pose"; pose: XRPose }>
  | Readonly<{ type: "pointer-ray"; ray?: XRControllerRay }>;

export const DEFAULT_DESKTOP_SIMULATOR_BINDINGS: DesktopSimulatorBindings = Object.freeze({
  moveForward: "KeyW",
  moveBackward: "KeyS",
  moveLeft: "KeyA",
  moveRight: "KeyD",
  snapLeft: "ArrowLeft",
  snapRight: "ArrowRight",
  pushToTalk: "Space",
  select: "Enter",
  cancel: "Escape",
});

const IDENTITY_POSE: XRPose = Object.freeze({
  position: Object.freeze({ x: 0, y: 1.6, z: 0 }),
  orientation: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }),
});

/**
 * Input-only desktop fallback. It intentionally reports `immersive: false` and
 * never installs or imitates browser WebXR globals.
 */
export class DesktopXRSimulator implements XRInputFramePort {
  readonly capabilities: DesktopSimulatorCapabilities = Object.freeze({
    source: "desktop-simulator",
    immersive: false,
    sixDegreesOfFreedom: true,
    pointerRay: true,
    pushToTalk: true,
  });

  private readonly pressedKeys = new Set<string>();
  private headPose: XRPose = IDENTITY_POSE;
  private primaryRay?: XRControllerRay;
  private pendingSnapTurn: -1 | 0 | 1 = 0;
  private pendingSelect = false;
  private pendingCancel = false;

  constructor(private readonly bindings: DesktopSimulatorBindings = DEFAULT_DESKTOP_SIMULATOR_BINDINGS) {}

  handle(input: DesktopSimulatorInput): void {
    if (input.type === "head-pose") {
      this.headPose = normalizePose(input.pose, "desktop.headPose");
      return;
    }
    if (input.type === "pointer-ray") {
      if (!input.ray) {
        this.primaryRay = undefined;
        return;
      }
      const maxDistance = finiteNumber(input.ray.maxDistance, "desktop.pointerRay.maxDistance");
      if (maxDistance <= 0 || maxDistance > 1_000) {
        throw new RangeError("desktop.pointerRay.maxDistance must be in (0, 1000]");
      }
      this.primaryRay = Object.freeze({
        origin: finiteVec3(input.ray.origin, "desktop.pointerRay.origin"),
        direction: normalizeVec3(input.ray.direction, "desktop.pointerRay.direction"),
        maxDistance,
      });
      return;
    }
    const wasPressed = this.pressedKeys.has(input.code);
    if (input.pressed) this.pressedKeys.add(input.code);
    else this.pressedKeys.delete(input.code);
    if (!input.pressed || wasPressed || input.repeat) return;
    if (input.code === this.bindings.snapLeft) this.pendingSnapTurn = -1;
    if (input.code === this.bindings.snapRight) this.pendingSnapTurn = 1;
    if (input.code === this.bindings.select) this.pendingSelect = true;
    if (input.code === this.bindings.cancel) this.pendingCancel = true;
  }

  readFrame(timestampMs: number): XRNormalizedInputFrame {
    const timestamp = finiteNumber(timestampMs, "timestampMs");
    if (timestamp < 0) throw new RangeError("timestampMs must be non-negative");
    let x = Number(this.pressedKeys.has(this.bindings.moveRight))
      - Number(this.pressedKeys.has(this.bindings.moveLeft));
    let y = Number(this.pressedKeys.has(this.bindings.moveForward))
      - Number(this.pressedKeys.has(this.bindings.moveBackward));
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    const frame = Object.freeze({
      source: "desktop-simulator" as const,
      timestampMs: timestamp,
      headPose: this.headPose,
      ...(this.primaryRay ? { primaryRay: this.primaryRay } : {}),
      move: Object.freeze({ x, y }),
      snapTurn: this.pendingSnapTurn,
      pushToTalkPressed: this.pressedKeys.has(this.bindings.pushToTalk),
      selectPressed: this.pendingSelect,
      cancelPressed: this.pendingCancel,
    });
    this.pendingSnapTurn = 0;
    this.pendingSelect = false;
    this.pendingCancel = false;
    return frame;
  }

  reset(): void {
    this.pressedKeys.clear();
    this.headPose = IDENTITY_POSE;
    this.primaryRay = undefined;
    this.pendingSnapTurn = 0;
    this.pendingSelect = false;
    this.pendingCancel = false;
  }
}
