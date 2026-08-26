import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";

describe("ThreeRenderer XR panel routing", () => {
  it("consumes a panel ray before world selection or teleport routing", () => {
    const onSelectEntity = vi.fn();
    const onXRTeleport = vi.fn();
    const activateFirstHit = vi.fn(() => true);
    const renderer = new ThreeRenderer({ onSelectEntity, onXRTeleport });
    const internal = renderer as unknown as {
      scene: THREE.Scene;
      camera: THREE.PerspectiveCamera;
      renderer: { xr: { isPresenting: boolean } };
      xrWorldPanelLayer: { activateFirstHit(raycaster: THREE.Raycaster): boolean };
      handleXRSelect(controller: THREE.Object3D): void;
    };
    internal.scene = new THREE.Scene();
    internal.camera = new THREE.PerspectiveCamera();
    internal.renderer = { xr: { isPresenting: true } };
    internal.xrWorldPanelLayer = { activateFirstHit };
    const controller = new THREE.Object3D();
    controller.updateMatrixWorld(true);

    internal.handleXRSelect(controller);

    expect(activateFirstHit).toHaveBeenCalledOnce();
    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(onXRTeleport).not.toHaveBeenCalled();
  });
});
