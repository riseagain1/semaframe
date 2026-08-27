import { describe, expect, it } from "vitest";
import { MemoryAssetVault } from "../../workspace/assets";
import {
  collectPortableRealityAssetClosure,
  createPortableProjectBundle,
  importPortableProjectBundle,
  importWorkspaceProjectArtifact,
  inspectPortableArchive,
  PORTABLE_PROJECT_MANIFEST_PATH,
  PORTABLE_PROJECT_WORKSPACE_PATH,
} from "../../workspace/persistence/portable";
import { workspaceStateDigest } from "../../workspace/persistence";
import { blobBytes, portableFixture } from "./helpers";

describe("Portable Reality Project bundle", () => {
  it("exports a deterministic replay-complete bundle and reopens it in an empty profile", async () => {
    const fixture = await portableFixture();
    expect(fixture.project.workspace.realityAssets?.map(([assetId]) => assetId))
      .toEqual([fixture.first.descriptor.assetId]);
    const closure = collectPortableRealityAssetClosure(fixture.project);
    expect(closure.map((descriptor) => descriptor.assetId).sort()).toEqual([
      fixture.first.descriptor.assetId,
      fixture.second.descriptor.assetId,
    ].sort());

    const firstExport = await createPortableProjectBundle(fixture.project, fixture.sourceVault);
    const secondExport = await createPortableProjectBundle(fixture.project, fixture.sourceVault);
    const firstBlob = await firstExport.toBlob();
    const secondBlob = await secondExport.toBlob();
    expect(await blobBytes(firstBlob)).toEqual(await blobBytes(secondBlob));
    expect(firstExport.manifestDigest).toBe(secondExport.manifestDigest);
    expect(firstExport.manifest.assets).toHaveLength(2);

    const layout = await inspectPortableArchive(firstBlob);
    expect(layout.entries.map((entry) => entry.path)).toEqual([
      PORTABLE_PROJECT_MANIFEST_PATH,
      PORTABLE_PROJECT_WORKSPACE_PATH,
      ...firstExport.manifest.assets.map((asset) => asset.objectPath),
    ]);
    expect(new Set(firstExport.manifest.assets.map((asset) => asset.digest)).size).toBe(2);

    const emptyProfile = new MemoryAssetVault();
    let committed = undefined as typeof fixture.project | undefined;
    const imported = await importPortableProjectBundle(firstBlob, {
      vault: emptyProfile,
      serializer: fixture.serializer,
      commitProject: (project) => { committed = project; },
    });
    expect([...imported.importedAssetIds].sort()).toEqual([
      fixture.first.descriptor.assetId,
      fixture.second.descriptor.assetId,
    ].sort());
    expect(imported.reusedAssetIds).toEqual([]);
    expect(await emptyProfile.listDescriptors()).toHaveLength(2);
    expect(committed).toBeDefined();
    const reopened = fixture.serializer.openStore(committed!);
    const original = fixture.serializer.openStore(fixture.project);
    expect(workspaceStateDigest(reopened.getState() as never))
      .toBe(workspaceStateDigest(original.getState() as never));
    expect(reopened.undo()).not.toBeNull();
    expect(reopened.getState().realityAssets.has(fixture.second.descriptor.assetId)).toBe(true);
    expect(await emptyProfile.has(fixture.second.descriptor.assetId)).toBe(true);

    const reused = await importPortableProjectBundle(firstBlob, {
      vault: emptyProfile,
      serializer: fixture.serializer,
    });
    expect(reused.importedAssetIds).toEqual([]);
    expect(reused.reusedAssetIds).toHaveLength(2);
  });

  it("keeps metadata-only Workspace JSON as an explicit compatibility path", async () => {
    const fixture = await portableFixture();
    const legacyJson = new Blob([fixture.serializer.serialize(fixture.project)], { type: "application/json" });
    const target = new MemoryAssetVault();
    let committed = false;
    const result = await importWorkspaceProjectArtifact(legacyJson, {
      vault: target,
      serializer: fixture.serializer,
      commitProject: () => { committed = true; },
    });
    expect(result.kind).toBe("legacy-json");
    expect(committed).toBe(true);
    expect(await target.listDescriptors()).toEqual([]);
  });

  it("streams the exact advertised length without materializing the archive", async () => {
    const fixture = await portableFixture();
    const exported = await createPortableProjectBundle(fixture.project, fixture.sourceVault);
    const reader = exported.stream().getReader();
    let streamedBytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      streamedBytes += next.value.byteLength;
    }
    expect(streamedBytes).toBe(exported.byteLength);
  });
});
