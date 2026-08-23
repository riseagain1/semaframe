import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { inspectRealityAsset, MemoryAssetVault } from "../../workspace/assets";
import { WorkspaceProjectSerializer, workspaceStateDigest } from "../../workspace/persistence";
import { workspaceToSceneState } from "../../workspace/renderer/ThreeComponentRenderer";
import { toRenderSnapshot } from "../../workspace/renderer/contracts";
import { buildSemaFrameSpatialGraph, findBlockingSpatialCollisions } from "../../workspace/spatial";
import { WorkspaceStore } from "../../workspace/state";
import { binaryPly } from "../workspace-assets/fixtures";
import { workspaceBatch } from "./helpers";

const worldPlacement = (x: number, y: number, z: number) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

describe("Reality Layer Workspace integration", () => {
  it("keeps a Gaussian utility-pole scan visual-only while an editable proxy owns engineering truth", async () => {
    const blob = binaryPly([
      [-0.5, 0, -0.5, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
      [0.5, 8, 0.5, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
    ]);
    const candidate = await inspectRealityAsset(blob);
    const descriptor = candidate.descriptor;
    const store = new WorkspaceStore();

    store.apply(workspaceBatch(store, "utility_pole_reality", [{
      op: "register_reality_asset",
      op_id: "register_scan",
      asset: descriptor,
    }, {
      op: "create_component",
      op_id: "create_stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: worldPlacement(0, 0, 0),
    }, {
      op: "create_component",
      op_id: "create_proxy",
      id: "POLE_PROXY",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
      label: "Editable utility-pole engineering proxy",
      placement: worldPlacement(0, 4, 0),
      props: {
        geometry: { kind: "cylinder", radiusM: 0.25, heightM: 8, axis: "y" },
      },
    }, {
      op: "create_component",
      op_id: "create_scan",
      id: "POLE_SCAN",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("gaussian-splat"),
      label: "Utility-pole Reality scan",
      placement: worldPlacement(0, 0, 0),
      props: {
        assetRef: { assetId: descriptor.assetId, digest: descriptor.digest },
        calibration: {
          version: 1,
          status: "metadata-declared",
          sourceCoordinateSystem: "RUB",
          targetCoordinateSystem: "RUB",
          metersPerSourceUnit: 1,
          declaredUnit: "metre",
        },
        quality: "auto",
        semanticProxyIds: ["POLE_PROXY"],
      },
    }]));

    expect(store.getState().realityAssets.get(descriptor.assetId)).toEqual(descriptor);
    // The scan overlaps its semantic proxy by design but never participates in collision.
    expect(findBlockingSpatialCollisions(store.getState())).toEqual([]);

    const graph = buildSemaFrameSpatialGraph(store.getState());
    expect(graph.version).toBe("3.2");
    const reality = graph.nodes.find((node) => node.id === "POLE_SCAN");
    const proxy = graph.nodes.find((node) => node.id === "POLE_PROXY");
    expect(reality).toMatchObject({
      nodeKind: "reality",
      entityKind: "gaussian-splat",
      worldBounds: {
        min: { x: -0.5, y: 0, z: -0.5 },
        max: { x: 0.5, y: 8, z: 0.5 },
        size: { x: 1, y: 8, z: 1 },
      },
      reality: {
        assetId: descriptor.assetId,
        digest: descriptor.digest,
        descriptorAvailable: true,
        binaryAvailability: "host_local_unknown",
        engineeringAuthority: "visual_only",
        calibrationStatus: "metadata-declared",
        boundsAreMetric: true,
        semanticProxyIds: ["POLE_PROXY"],
      },
      relations: ["represented_by:POLE_PROXY"],
    });
    expect(reality).not.toHaveProperty("collision");
    expect(reality).not.toHaveProperty("physics");
    expect(proxy?.relations).toContain("proxy_for:POLE_SCAN");

    const scene = workspaceToSceneState(toRenderSnapshot(store.getState()));
    expect(scene.entities.get("POLE_SCAN")).toMatchObject({
      assetId: `reality:${descriptor.assetId}`,
      transform: { scale: { x: 1, y: 1, z: 1 } },
      renderGeometry: {
        kind: "reality",
        asset: {
          assetId: descriptor.assetId,
          digest: descriptor.digest,
          format: "ply",
          splatCount: 2,
        },
        bounds: descriptor.sourceBounds,
        sourceAxisSigns: { x: 1, y: 1, z: 1 },
        metersPerSourceUnit: 1,
        quality: "auto",
        engineeringAuthority: "visual_only",
      },
    });

    expect(() => store.apply(workspaceBatch(store, "delete_referenced_scan", [{
      op: "delete_reality_asset",
      op_id: "delete_referenced",
      asset_id: descriptor.assetId,
      confirm: true,
    }]))).toThrowError(expect.objectContaining({ code: "reality_asset_referenced" }));
  });

  it("survives undo, save/reopen, a missing local vault, and an exact same-digest relink", async () => {
    const blob = binaryPly([
      [0, 0, 0, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
      [2, 4, 6, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
    ]);
    const candidate = await inspectRealityAsset(blob);
    const descriptor = candidate.descriptor;
    const originalVault = new MemoryAssetVault();
    await originalVault.put(candidate, blob);
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "reality_setup", [{
      op: "register_reality_asset", op_id: "asset", asset: descriptor,
    }, {
      op: "create_component", op_id: "stage", id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: worldPlacement(0, 0, 0),
    }, {
      op: "create_component", op_id: "scan", id: "SCAN",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("gaussian-splat"),
      placement: worldPlacement(2, 0, 3),
      props: {
        assetRef: { assetId: descriptor.assetId, digest: descriptor.digest },
        calibration: {
          version: 1,
          status: "reference-distance",
          sourceCoordinateSystem: "RUF",
          targetCoordinateSystem: "RUB",
          metersPerSourceUnit: 0.5,
          sourceDistance: 2,
          referenceDistanceM: 1,
        },
        quality: "auto",
        semanticProxyIds: [],
      },
    }]));
    store.apply(workspaceBatch(store, "quality_high", [{
      op: "update_component", op_id: "quality", id: "SCAN", patch: { props: { quality: "high" } },
    }]));
    expect(store.getState().components.get("SCAN")?.props.quality).toBe("high");
    expect(store.undo()).not.toBeNull();
    expect(store.getState().components.get("SCAN")?.props.quality).toBe("auto");
    expect(store.redo()).not.toBeNull();
    expect(store.getState().components.get("SCAN")?.props.quality).toBe("high");

    const serializer = new WorkspaceProjectSerializer();
    const serialized = serializer.serialize(serializer.fromStore("reality_project", store));
    expect(serialized).not.toContain("end_header");
    expect(serialized).not.toContain("localPath");
    const reopened = serializer.openStore(serializer.deserialize(serialized));
    expect(workspaceStateDigest(reopened.getState() as never))
      .toBe(workspaceStateDigest(store.getState() as never));
    expect(reopened.getState().realityAssets.get(descriptor.assetId)).toEqual(descriptor);

    const graph = buildSemaFrameSpatialGraph(reopened.getState());
    expect(graph.nodes.find((node) => node.id === "SCAN")).toMatchObject({
      worldBounds: {
        min: { x: 2, y: 0, z: 0 },
        max: { x: 3, y: 2, z: 3 },
      },
      reality: {
        sourceCoordinateSystem: "RUF",
        targetCoordinateSystem: "RUB",
        metersPerSourceUnit: 0.5,
        binaryAvailability: "host_local_unknown",
      },
    });

    const reopenedVault = new MemoryAssetVault();
    expect(await reopenedVault.has(descriptor.assetId)).toBe(false);
    await expect(reopenedVault.put(candidate, blob)).resolves.toMatchObject({
      descriptor,
      deduplicated: false,
    });
    expect(await reopenedVault.has(descriptor.assetId)).toBe(true);
    await expect(reopenedVault.put(candidate, new Blob(["different bytes"]))).rejects.toMatchObject({
      code: "digest_mismatch",
    });

    originalVault.dispose();
    reopenedVault.dispose();
  });
});
