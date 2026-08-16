import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  INFINITE_NAVIGATION_LIMITS,
  adaptiveClipPlanes,
  cameraDistanceLimits,
  floatingOriginFor,
} from "../../renderer/infiniteNavigation";
import { ProjectionBridge } from "../../workspace/renderer/ProjectionBridge";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

const locks = {
  placement: false,
  resize: false,
  visualEffects: false,
  props: false,
  deletion: false,
  actions: false,
};

function component(
  id: string,
  placement: WorkspaceRenderComponent["placement"],
): WorkspaceRenderComponent {
  return {
    id,
    type: { typeId: "panel", version: "1.1.0", digest: id },
    label: id,
    props: {},
    durableState: {},
    placement,
    tags: [],
    visibility: "visible",
    locks,
  };
}

describe("effectively infinite hybrid navigation", () => {
  it("keeps adaptive clipping finite across microscopic and planetary camera distances", () => {
    const microscopic = adaptiveClipPlanes(1e-5, 4, 8);
    const planetary = adaptiveClipPlanes(1e11, 3e11, 1e12);
    expect(microscopic.near).toBe(INFINITE_NAVIGATION_LIMITS.minNearPlane);
    expect(microscopic.far).toBeGreaterThan(10);
    expect(planetary.near).toBeCloseTo(1e6);
    expect(planetary.far).toBeGreaterThan(2e12);
    expect(planetary.far).toBeLessThanOrEqual(INFINITE_NAVIGATION_LIMITS.maxFarPlane);
    expect(cameraDistanceLimits(2)).toEqual({ min: 1e-5, max: 2e6 });
    expect(cameraDistanceLimits(1e10).max).toBe(1e15 * 0.1);
  });

  it("rebases distant semantic targets onto a stable render grid", () => {
    const current = new THREE.Vector3();
    expect(floatingOriginFor(new THREE.Vector3(9_999, 0, 0), current)).toBeNull();
    expect(floatingOriginFor(new THREE.Vector3(12_345, -98_765, 555), current)?.toArray())
      .toEqual([12_000, -99_000, 1_000]);
  });

  it("zooms canvas2d around the cursor across eight decades while viewport HUD stays fixed", () => {
    const bridge = new ProjectionBridge();
    bridge.setViewport({ width: 1_000, height: 800 });
    const canvas = component("canvas", {
      space: "canvas2d",
      position: { x: 200, y: -100 },
      size: { width: 300, height: 150 },
    });
    const hud = component("hud", {
      space: "viewport",
      anchor: "top_left",
      offset: { x: 24, y: 24 },
      size: { width: 240, height: 120 },
    });
    bridge.setComponents([canvas, hud]);
    const beforeCanvas = bridge.project(canvas);
    const beforeHud = bridge.project(hud);
    const anchor = {
      x: beforeCanvas.left + beforeCanvas.width / 2,
      y: beforeCanvas.top + beforeCanvas.height / 2,
    };
    bridge.zoomCanvasAt(anchor, 100);
    const afterCanvas = bridge.project(canvas);
    const afterHud = bridge.project(hud);
    expect(afterCanvas.left + afterCanvas.width / 2).toBeCloseTo(anchor.x);
    expect(afterCanvas.top + afterCanvas.height / 2).toBeCloseTo(anchor.y);
    expect(afterCanvas.width).toBeCloseTo(beforeCanvas.width * 100);
    expect(afterHud).toEqual(beforeHud);

    bridge.zoomCanvasAt(anchor, 1e20);
    expect(bridge.getCanvasView().zoom).toBe(INFINITE_NAVIGATION_LIMITS.maxCanvasZoom);
    bridge.zoomCanvasAt(anchor, 1e-30);
    expect(bridge.getCanvasView().zoom).toBe(INFINITE_NAVIGATION_LIMITS.minCanvasZoom);
  });

  it("frames authored canvas content and reset restores the canonical local view", () => {
    const bridge = new ProjectionBridge();
    bridge.setViewport({ width: 1_200, height: 800 });
    bridge.setComponents([
      component("left", {
        space: "canvas2d",
        position: { x: -20_000, y: 4_000 },
        size: { width: 400, height: 200 },
      }),
      component("right", {
        space: "canvas2d",
        position: { x: 30_000, y: -6_000 },
        size: { width: 600, height: 300 },
      }),
    ]);
    const framed = bridge.frameCanvasComponents();
    expect(framed).not.toBeNull();
    for (const projected of bridge.projectAll().values()) {
      expect(projected.left).toBeGreaterThanOrEqual(40);
      expect(projected.top).toBeGreaterThanOrEqual(40);
      expect(projected.left + projected.width).toBeLessThanOrEqual(1_160);
      expect(projected.top + projected.height).toBeLessThanOrEqual(760);
    }
    expect(bridge.resetCanvasView()).toEqual({ pan: { x: 0, y: 0 }, zoom: 1 });
  });
});
