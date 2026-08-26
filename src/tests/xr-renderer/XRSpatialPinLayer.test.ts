import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { XRSpatialPinLayer } from "../../renderer/xr";
import type { XRSpatialPin } from "../../xr/client";

function pin(): XRSpatialPin {
  return {
    pinId: "xr-pin-1",
    pinSequence: 1,
    workspacePositionM: { x: 1.23456, y: 0.75, z: -2.34567 },
    surfaceNormal: { x: 0, y: 1, z: 0 },
    hitKind: "ground",
    sourceId: "input-1-right",
    handedness: "right",
    placedAtMs: 100,
    placedAtWorkspaceRevision: 7,
    coordinateSpace: "workspace-world-rub",
    units: "metre",
    authority: "render-interaction-estimate",
  };
}

describe("XRSpatialPinLayer", () => {
  it("shows one non-interactive world marker while keeping full-precision pin data", () => {
    const fillText = vi.fn();
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as never);
    const layer = new XRSpatialPinLayer(document);
    const value = pin();
    layer.setPin(value);

    expect(layer.getPin()).toBe(value);
    expect(layer.root.visible).toBe(true);
    expect(layer.root.position.toArray()).toEqual([1.23456, 0.75, -2.34567]);
    expect(layer.root.userData.workspacePositionM).toEqual(value.workspacePositionM);
    expect(fillText).toHaveBeenCalledWith(
      "X 1.235   Y 0.750   Z -2.346 m",
      34,
      148,
    );

    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    camera.updateMatrixWorld(true);
    layer.update(camera, Date.now());
    expect(layer.hudRoot.visible).toBe(true);
    const intersections: THREE.Intersection[] = [];
    for (const child of layer.root.children) child.raycast(new THREE.Raycaster(), intersections);
    expect(intersections).toHaveLength(0);

    layer.clear(false);
    expect(layer.getPin()).toBeUndefined();
    expect(layer.root.visible).toBe(false);
    layer.dispose();
    expect(layer.root.children).toHaveLength(0);
    expect(layer.hudRoot.children).toHaveLength(0);
  });
});
