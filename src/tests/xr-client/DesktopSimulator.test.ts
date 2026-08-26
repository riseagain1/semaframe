import { describe, expect, it } from "vitest";
import { DesktopXRSimulator } from "../../xr/client";

describe("DesktopXRSimulator", () => {
  it("is explicitly non-immersive while producing the shared input frame", () => {
    const simulator = new DesktopXRSimulator();
    expect(simulator.capabilities).toMatchObject({ source: "desktop-simulator", immersive: false });
    simulator.handle({ type: "key", code: "KeyW", pressed: true });
    simulator.handle({ type: "key", code: "KeyD", pressed: true });
    simulator.handle({ type: "key", code: "Space", pressed: true });
    simulator.handle({
      type: "pointer-ray",
      ray: { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: 0, z: -4 }, maxDistance: 12 },
    });

    const frame = simulator.readFrame(10);
    expect(frame).toMatchObject({
      source: "desktop-simulator",
      pushToTalkPressed: true,
      primaryRay: { direction: { x: 0, y: 0, z: -1 } },
    });
    expect(frame.move.x).toBeCloseTo(Math.SQRT1_2);
    expect(frame.move.y).toBeCloseTo(Math.SQRT1_2);
  });

  it("emits snap, select, and cancel as edge-triggered one-frame actions", () => {
    const simulator = new DesktopXRSimulator();
    simulator.handle({ type: "key", code: "ArrowLeft", pressed: true });
    simulator.handle({ type: "key", code: "ArrowLeft", pressed: true, repeat: true });
    simulator.handle({ type: "key", code: "Enter", pressed: true });
    simulator.handle({ type: "key", code: "Escape", pressed: true });

    expect(simulator.readFrame(1)).toMatchObject({ snapTurn: -1, selectPressed: true, cancelPressed: true });
    expect(simulator.readFrame(2)).toMatchObject({ snapTurn: 0, selectPressed: false, cancelPressed: false });
  });

  it("rejects an invalid pointer ray without replacing the last valid ray", () => {
    const simulator = new DesktopXRSimulator();
    simulator.handle({
      type: "pointer-ray",
      ray: { origin: { x: 1, y: 2, z: 3 }, direction: { x: 0, y: 0, z: -1 }, maxDistance: 8 },
    });
    expect(() => simulator.handle({
      type: "pointer-ray",
      ray: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, maxDistance: -1 },
    })).toThrow(/maxDistance/u);
    expect(simulator.readFrame(3).primaryRay).toMatchObject({
      origin: { x: 1, y: 2, z: 3 },
      maxDistance: 8,
    });
  });
});
