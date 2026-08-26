import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";

type DispatchableController = THREE.Group & Readonly<{
  dispatchEvent(event: { type: string; data?: XRInputSource }): void;
}>;

describe("ThreeRenderer immersive push-to-talk bindings", () => {
  it("uses controller squeeze and hand pinch with deterministic release/cancel events", () => {
    const onXRPushToTalk = vi.fn();
    const renderer = new ThreeRenderer({ onXRPushToTalk });
    const controllers = [new THREE.Group(), new THREE.Group()] as DispatchableController[];
    const internal = renderer as unknown as {
      renderer: { xr: { getController(index: number): DispatchableController } };
      scene: THREE.Scene;
      installXRControllers(): void;
    };
    internal.renderer = { xr: { getController: (index) => controllers[index]! } };
    internal.scene = new THREE.Scene();
    internal.installXRControllers();

    controllers[0]!.dispatchEvent({
      type: "connected",
      data: { handedness: "right" } as XRInputSource,
    });
    controllers[0]!.dispatchEvent({ type: "squeezestart" });
    controllers[0]!.dispatchEvent({ type: "squeezeend" });

    controllers[1]!.dispatchEvent({
      type: "connected",
      data: { handedness: "left", hand: {} } as XRInputSource,
    });
    controllers[1]!.dispatchEvent({ type: "selectstart" });
    controllers[1]!.dispatchEvent({ type: "disconnected" });

    expect(onXRPushToTalk.mock.calls.map(([event]) => event)).toEqual([
      { phase: "pressed", input: "controller", handedness: "right" },
      { phase: "released", input: "controller", handedness: "right" },
      { phase: "pressed", input: "hand", handedness: "left" },
      { phase: "cancelled", input: "hand", handedness: "left" },
    ]);
  });

  it("consumes confirmation controls as a voice modal before world interaction", () => {
    const onXRPushToTalk = vi.fn();
    const renderer = new ThreeRenderer({ onXRPushToTalk });
    const controller = new THREE.Group() as DispatchableController;
    const internal = renderer as unknown as {
      xrControllerMetadata: Map<DispatchableController, Readonly<{ input: "controller"; handedness: "right" }>>;
      dispatchXRVoiceModalAction(
        value: DispatchableController,
        source: "select" | "confirm_button" | "cancel_button" | "hand_select",
      ): boolean;
    };
    internal.xrControllerMetadata.set(controller, { input: "controller", handedness: "right" });
    renderer.setXRVoiceFeedback({
      phase: "awaiting_confirmation",
      actions: ["confirm", "cancel"],
    });

    expect(internal.dispatchXRVoiceModalAction(controller, "select")).toBe(true);
    expect(internal.dispatchXRVoiceModalAction(controller, "cancel_button")).toBe(true);
    expect(onXRPushToTalk.mock.calls.map(([event]) => event.phase)).toEqual(["confirmed", "cancelled"]);

    renderer.setXRVoiceFeedback({ phase: "ready" });
    expect(internal.dispatchXRVoiceModalAction(controller, "select")).toBe(false);
  });

  it("maps right and left hand pinches to explicit confirm and cancel actions", () => {
    const onXRPushToTalk = vi.fn();
    const renderer = new ThreeRenderer({ onXRPushToTalk });
    const controllers = [new THREE.Group(), new THREE.Group()] as DispatchableController[];
    const internal = renderer as unknown as {
      renderer: { xr: { getController(index: number): DispatchableController } };
      scene: THREE.Scene;
      installXRControllers(): void;
    };
    internal.renderer = { xr: { getController: (index) => controllers[index]! } };
    internal.scene = new THREE.Scene();
    internal.installXRControllers();
    controllers[0]!.dispatchEvent({
      type: "connected",
      data: { handedness: "right", hand: {} } as XRInputSource,
    });
    controllers[1]!.dispatchEvent({
      type: "connected",
      data: { handedness: "left", hand: {} } as XRInputSource,
    });
    renderer.setXRVoiceFeedback({
      phase: "awaiting_confirmation",
      actions: ["confirm", "cancel"],
    });

    controllers[0]!.dispatchEvent({ type: "selectstart" });
    controllers[0]!.dispatchEvent({ type: "selectend" });
    controllers[1]!.dispatchEvent({ type: "selectstart" });
    controllers[1]!.dispatchEvent({ type: "selectend" });

    expect(onXRPushToTalk.mock.calls.map(([event]) => event)).toEqual([
      { phase: "confirmed", input: "hand", handedness: "right" },
      { phase: "cancelled", input: "hand", handedness: "left" },
    ]);
  });

  it("emits best-effort controller haptics without making them authoritative", async () => {
    vi.useFakeTimers();
    const pulse = vi.fn(async () => true);
    const renderer = new ThreeRenderer();
    (renderer as unknown as { xrSession: XRSession }).xrSession = {
      inputSources: [{ gamepad: { hapticActuators: [{ pulse }] } }],
    } as unknown as XRSession;
    renderer.pulseXRVoiceHaptics("draft_ready");
    await vi.runAllTimersAsync();
    expect(pulse).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
