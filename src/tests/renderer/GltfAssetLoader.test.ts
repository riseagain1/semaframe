import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { AssetRecord } from "../../assets/assetManifest";
import type { EntityState } from "../../renderer/sceneRenderTypes";
import { GltfAssetLoader } from "../../renderer/GltfAssetLoader";
import { findSocket } from "../../renderer/proceduralAssets";

const record: AssetRecord = {
  assetId: "bundled_test_prop",
  kind: "prop",
  displayName: "Bundled test prop",
  tags: ["test"],
  styleFamily: "neutral_low_poly_v1",
  runtime: {
    uri: "assets/test.glb",
    format: "glb",
    unitScaleMeters: 1,
    upAxis: "+Y",
    forwardAxis: "+Z",
    originRule: "ground_center",
  },
  bounds: { width: 0.5, height: 1, depth: 0.4 },
  defaultScale: 1,
  anchors: ["top"],
  sockets: ["right_hand", "torso"],
  animations: [],
  supportedStates: [],
  variants: [],
  source: "bundled",
  license: "project_owned_or_permissive",
  renderHint: { shape: "box", primaryColor: "#667788" },
};

function entity(id: string): EntityState {
  return {
    id,
    kind: "prop",
    assetId: record.assetId,
    label: "test prop",
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    appearance: {},
    state: { type: "prop" },
    tags: [],
    locked: false,
  };
}

describe("GltfAssetLoader", () => {
  it("loads once, clones safely, and exposes authored or deterministic contract nodes", async () => {
    const scene = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0x667788 });
    const visual = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.4), material);
    scene.add(visual);
    const authoredSocket = new THREE.Object3D();
    authoredSocket.name = "socket_right_hand";
    authoredSocket.position.set(0.3, 0.55, 0);
    scene.add(authoredSocket);
    const load = vi.fn(async (_uri: string) => ({ scene, animations: [] }));
    const loader = new GltfAssetLoader(load);

    const first = await loader.instantiate(record, entity("PROP_0001"));
    const second = await loader.instantiate(record, entity("PROP_0002"));

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toMatch(/\/assets\/test\.glb$/);
    expect(first).not.toBe(second);
    const firstMesh = first.getObjectByProperty("isMesh", true) as THREE.Mesh;
    const secondMesh = second.getObjectByProperty("isMesh", true) as THREE.Mesh;
    expect(firstMesh.geometry).not.toBe(secondMesh.geometry);
    expect(firstMesh.material).not.toBe(secondMesh.material);
    expect(findSocket(first, "right_hand").name).toBe("socket:right_hand");
    expect(findSocket(first, "torso").name).toBe("socket:torso");
    expect(first.getObjectByName("anchor:top")).toBeTruthy();
    expect(firstMesh.userData.entityId).toBe("PROP_0001");
  });

  it("keeps rejected loads deterministic in the cache", async () => {
    const load = vi.fn(async (_uri: string) => { throw new Error("missing file"); });
    const loader = new GltfAssetLoader(load);
    await expect(loader.instantiate(record, entity("PROP_0001"))).rejects.toThrow("missing file");
    await expect(loader.instantiate(record, entity("PROP_0002"))).rejects.toThrow("missing file");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
