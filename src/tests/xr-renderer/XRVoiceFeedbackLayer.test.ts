import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { XRVoiceFeedbackLayer } from "../../renderer/xr";

describe("XRVoiceFeedbackLayer", () => {
  it("renders explicit immersive voice states and follows the live HMD pose", () => {
    const context = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      roundRect: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fillText: vi.fn(),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      font: "",
      textBaseline: "alphabetic",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => (
      context as unknown as CanvasRenderingContext2D
    )) as never);
    const layer = new XRVoiceFeedbackLayer(document);
    layer.setFeedback({ phase: "listening" });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(2, 1.7, 3);
    camera.updateMatrixWorld(true);
    layer.updatePose(camera);

    expect(layer.root.visible).toBe(true);
    expect(layer.root.userData.phase).toBe("listening");
    expect(layer.root.position.toArray()).toEqual([2, 1.46, 2]);
    expect(context.fillText).toHaveBeenCalledWith("Listening… release to stage", 100, 80);

    layer.setFeedback({
      phase: "awaiting_confirmation",
      subtitle: "Build a blue wall",
      targetLabel: "Codex",
      actions: ["confirm", "cancel"],
    });
    expect(layer.root.userData.actions).toEqual(["confirm", "cancel"]);
    expect(context.fillText).toHaveBeenCalledWith("Build a blue wall", 36, 135);
    expect(context.fillText).toHaveBeenCalledWith(
      "Target: Codex  ·  Right pinch/Trigger: Send  ·  Left pinch/B: Cancel",
      36,
      195,
    );

    layer.setFeedback({ phase: "hidden" });
    expect(layer.root.visible).toBe(false);
    layer.dispose();
  });
});
