import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";
import type { EntityState, SceneState } from "../../renderer/sceneRenderTypes";

function propEntity(id: string): EntityState {
  return {
    id,
    kind: "prop",
    assetId: "primitive_box",
    label: "Blocking prop",
    transform: {
      position: { x: 0.36, y: 0.5, z: -2 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    appearance: { opacity: 1 },
    state: { type: "prop", visible: true },
    collision: {
      enabled: true,
      role: "solid",
      shape: "asset_bounds",
      margin: 0.02,
    },
    tags: [],
    locked: false,
  };
}

describe("ThreeRenderer XR teleport integration", () => {
  it("does not mutate the rig or notify the host when the destination capsule overlaps an entity", () => {
    const onXRTeleport = vi.fn();
    const renderer = new ThreeRenderer({ onXRTeleport });
    const internal = renderer as unknown as {
      scene: THREE.Scene;
      camera: THREE.PerspectiveCamera;
      renderer: { xr: { isPresenting: boolean; getCamera(): THREE.Camera } };
      environmentRoot: THREE.Group;
      entities: Map<string, THREE.Object3D>;
      currentState: Readonly<SceneState>;
      xrRig: THREE.Group;
      xrWorldPanelLayer?: { activateFirstHit(raycaster: THREE.Raycaster): boolean };
      handleXRSelect(controller: THREE.Object3D): void;
    };

    const scene = new THREE.Scene();
    const rig = internal.xrRig;
    scene.add(rig);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    rig.add(camera);
    const environment = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.BoxGeometry(10, 0.08, 10));
    ground.name = "environment:ground";
    ground.position.y = -0.04;
    environment.add(ground);
    scene.add(environment);

    const blocker = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.2));
    blocker.position.set(0.36, 0.5, -2);
    blocker.userData.entityId = "SOFA_XR";
    scene.add(blocker);
    const stateEntity = propEntity("SOFA_XR");
    const state = {
      entities: new Map([[stateEntity.id, stateEntity]]),
    } as Readonly<SceneState>;

    internal.scene = scene;
    internal.camera = camera;
    internal.renderer = { xr: { isPresenting: true, getCamera: () => camera } };
    internal.environmentRoot = environment;
    internal.entities = new Map([[stateEntity.id, blocker]]);
    internal.currentState = state;
    internal.xrWorldPanelLayer = undefined;

    const controller = new THREE.Object3D();
    controller.position.set(0, 1.5, 0);
    const direction = new THREE.Vector3(0, -1.5, -2).normalize();
    controller.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction);
    rig.add(controller);
    scene.updateMatrixWorld(true);

    internal.handleXRSelect(controller);
    expect(rig.position.toArray()).toEqual([0, 0, 0]);
    expect(onXRTeleport).not.toHaveBeenCalled();

    internal.entities.clear();
    (internal.currentState.entities as Map<string, EntityState>).clear();
    blocker.removeFromParent();
    scene.updateMatrixWorld(true);
    internal.handleXRSelect(controller);
    expect(rig.position.x).toBeCloseTo(0, 6);
    expect(rig.position.y).toBeCloseTo(0, 6);
    expect(rig.position.z).toBeCloseTo(-2, 6);
    expect(onXRTeleport).toHaveBeenCalledOnce();
    expect(onXRTeleport).toHaveBeenCalledWith({
      position: {
        x: expect.closeTo(0, 6),
        y: expect.closeTo(0, 6),
        z: expect.closeTo(-2, 6),
      },
    });
  });
});
