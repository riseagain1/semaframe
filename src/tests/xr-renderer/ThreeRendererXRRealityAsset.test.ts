// @vitest-environment node

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";
import type { EntityState } from "../../renderer/sceneRenderTypes";
import { assetIdFromDigest, type RealityAssetDescriptor } from "../../workspace/assets";
import { sha256DigestBytes } from "../../workspace/assets/digest";
import { toXrWorkspaceProjection } from "../../xr/authority";
import {
  XrViewerRealityAssetRuntime,
  type XrViewerTransportSession,
} from "../../xr/app";
import { xrRenderProfileForGate } from "../../xr/ultra";
import { binaryPly, VALID_ROW } from "../workspace-assets/fixtures";

type RealityRuntimeDouble = Readonly<{
  load: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
}>;

type ThreeRendererRealityAccess = {
  realityRuntime: RealityRuntimeDouble | null;
  createRealityEntity(entity: EntityState, signal: AbortSignal): Promise<THREE.Group>;
};

async function applePlyFixture(splatCount = 1): Promise<Readonly<{
  blob: Blob;
  descriptor: RealityAssetDescriptor;
}>> {
  const source = binaryPly([VALID_ROW]);
  const bytes = new Uint8Array(await source.arrayBuffer());
  const blob = new Blob([bytes], { type: "application/ply" });
  const digest = sha256DigestBytes(bytes) as `sha256:${string}`;
  return Object.freeze({
    blob,
    descriptor: Object.freeze({
      version: 1,
      assetId: assetIdFromDigest(digest),
      digest,
      format: "ply",
      formatVersion: 1,
      mediaType: "application/ply",
      byteLength: blob.size,
      splatCount,
      sphericalHarmonicsDegree: 0,
      model: "gaussian-3d",
      antialiased: null,
      coordinateSystem: Object.freeze({ system: "UNKNOWN", provenance: "unknown" }),
      engineeringAuthority: "visual_only",
    }),
  });
}

function entity(descriptor: RealityAssetDescriptor): EntityState {
  return {
    id: "apple-reconstruction",
    kind: "effect",
    assetId: `reality:${descriptor.assetId}`,
    label: "Apple Object Capture reconstruction",
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    appearance: {},
    state: { type: "effect", enabled: true },
    renderGeometry: {
      kind: "reality",
      asset: {
        assetId: descriptor.assetId,
        digest: descriptor.digest,
        format: "ply",
        byteLength: descriptor.byteLength,
        splatCount: descriptor.splatCount,
      },
      bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
      sourceAxisSigns: { x: 1, y: 1, z: 1 },
      metersPerSourceUnit: 1,
      quality: "auto",
      engineeringAuthority: "visual_only",
    },
    tags: [],
    locked: false,
  };
}

function harness(fixture: Awaited<ReturnType<typeof applePlyFixture>>) {
  const projection = toXrWorkspaceProjection({
    workspaceId: "workspace-apple-ply",
    revision: 1,
    components: [],
    realityAssets: [fixture.descriptor],
  });
  const openAsset = vi.fn(async () => fixture.blob);
  const session: XrViewerTransportSession = {
    identity: {
      workspaceId: projection.workspaceId,
      authorityEpoch: "authority-apple-ply",
      sessionId: "viewer-apple-ply",
    },
    send: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    openAsset,
    close: vi.fn(async () => undefined),
  };
  const assets = new XrViewerRealityAssetRuntime();
  const profile = xrRenderProfileForGate();
  const statuses: unknown[] = [];
  const renderer = new ThreeRenderer({
    openRealityAsset: (assetId, digest, signal) => assets.open({
      session,
      projection,
      assetId,
      digest,
      budget: profile.assetBudget,
      ...(signal ? { signal } : {}),
    }),
    onStatus: (status) => statuses.push(status),
  });
  const loadedRoot = new THREE.Group();
  const runtime: RealityRuntimeDouble = {
    load: vi.fn(async () => ({ root: loadedRoot })),
    remove: vi.fn(() => false),
    snapshot: vi.fn(() => ({ contextLost: false })),
  };
  const access = renderer as unknown as ThreeRendererRealityAccess;
  access.realityRuntime = runtime;
  return { access, assets, loadedRoot, openAsset, profile, runtime, statuses };
}

describe("ThreeRenderer Balanced XR Apple PLY loading", () => {
  it("loads an under-budget Apple Gaussian PLY through the live viewer asset service", async () => {
    const fixture = await applePlyFixture();
    const { access, assets, loadedRoot, openAsset, profile, runtime, statuses } = harness(fixture);

    expect(profile.mode).toBe("balanced");
    expect(profile.assetBudget.supportedFormats).toContain("gaussian-ply");
    const root = await access.createRealityEntity(entity(fixture.descriptor), new AbortController().signal);

    expect(root).toBe(loadedRoot);
    expect(root.userData.realityRuntime).toBe(true);
    expect(root.userData.realityAssetMissing).toBeUndefined();
    expect(openAsset).toHaveBeenCalledWith(
      fixture.descriptor.digest,
      "gaussian-ply",
      fixture.descriptor.byteLength,
      expect.any(AbortSignal),
    );
    expect(runtime.load).toHaveBeenCalledWith(expect.objectContaining({
      instance: expect.objectContaining({
        asset: expect.objectContaining({ format: "ply", splatCount: 1 }),
      }),
      bytes: expect.any(ArrayBuffer),
    }), expect.any(AbortSignal));
    expect(assets.stats()).toMatchObject({
      entryCount: 1,
      totalBytes: fixture.descriptor.byteLength,
    });
    expect(statuses).toEqual([]);
    assets.clear();
  });

  it("keeps an over-budget Apple PLY as a deterministic placeholder without downloading it", async () => {
    const balanced = xrRenderProfileForGate();
    const fixture = await applePlyFixture(balanced.assetBudget.maximumSplats + 1);
    const { access, assets, openAsset, runtime, statuses } = harness(fixture);

    const root = await access.createRealityEntity(entity(fixture.descriptor), new AbortController().signal);

    expect(openAsset).not.toHaveBeenCalled();
    expect(runtime.load).not.toHaveBeenCalled();
    expect(root.userData.realityAssetMissing).toBe(true);
    expect(root.userData.realityFallbackMessage).toMatch(/splat_budget_exceeded/u);
    expect(statuses).toEqual([expect.objectContaining({
      kind: "asset-fallback",
      assetId: fixture.descriptor.assetId,
      note: expect.objectContaining({ code: "asset_load_failed", entityId: "apple-reconstruction" }),
    })]);
    assets.clear();
  });
});
