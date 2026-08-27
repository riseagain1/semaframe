import { describe, expect, it } from "vitest";
import type {
  AssetVaultOperationOptions,
  PutRealityAssetResult,
  RealityAssetCandidate,
  RealityAssetDescriptor,
  RealityAssetId,
} from "../../workspace/assets";
import {
  createPortableProjectBundle,
  importPortableProjectBundle,
  inspectPortableArchive,
  planPortableArchive,
  PortableProjectError,
  readPortableProjectBundle,
} from "../../workspace/persistence/portable";
import { binaryPly } from "../workspace-assets/fixtures";
import {
  blobBytes,
  DelegatingAssetVault,
  portableFixture,
  replaceArchiveEntryNames,
} from "./helpers";

function archiveBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: "application/vnd.semaframe.project+zip",
  });
}

describe("Portable Reality Project security and atomicity", () => {
  it("rejects an object bit flip before any vault or project mutation", async () => {
    const fixture = await portableFixture();
    const exported = await createPortableProjectBundle(fixture.project, fixture.sourceVault);
    const good = await exported.toBlob();
    const layout = await inspectPortableArchive(good);
    const object = layout.entries.find((entry) => entry.path.startsWith("objects/"));
    if (!object) throw new Error("Expected a Reality object entry");
    const bytes = await blobBytes(good);
    bytes[object.dataOffset] ^= 0xff;
    const target = new DelegatingAssetVault();
    let committed = false;
    await expect(importPortableProjectBundle(archiveBlob(bytes), {
      vault: target,
      commitProject: () => { committed = true; },
    })).rejects.toMatchObject({ code: "archive_corrupt" });
    expect(committed).toBe(false);
    expect(await target.listDescriptors()).toEqual([]);
  });

  it("does not let a valid cached digest mask corruption in the supplied bundle", async () => {
    const fixture = await portableFixture();
    const exported = await createPortableProjectBundle(fixture.project, fixture.sourceVault);
    const good = await exported.toBlob();
    const target = new DelegatingAssetVault();
    await importPortableProjectBundle(good, { vault: target });
    const layout = await inspectPortableArchive(good);
    const object = layout.entries.find((entry) => entry.path.startsWith("objects/"));
    if (!object) throw new Error("Expected a Reality object entry");
    const bytes = await blobBytes(good);
    bytes[object.dataOffset] ^= 0xff;
    await expect(importPortableProjectBundle(archiveBlob(bytes), { vault: target }))
      .rejects.toMatchObject({ code: "archive_corrupt" });
    expect(await target.listDescriptors()).toHaveLength(2);
  });

  it("rejects path traversal in matching local and central names", async () => {
    const fixture = await portableFixture();
    const exported = await createPortableProjectBundle(fixture.project, fixture.sourceVault);
    const good = await exported.toBlob();
    const path = exported.manifest.assets[0]!.objectPath;
    const malicious = `../${"x".repeat(path.length - 3)}`;
    const bytes = await blobBytes(good);
    replaceArchiveEntryNames(bytes, await inspectPortableArchive(good), path, malicious);
    await expect(readPortableProjectBundle(archiveBlob(bytes)))
      .rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects duplicate archive names", async () => {
    const fixture = await portableFixture();
    const exported = await createPortableProjectBundle(fixture.project, fixture.sourceVault);
    const good = await exported.toBlob();
    const [first, second] = exported.manifest.assets.map((asset) => asset.objectPath);
    if (!first || !second) throw new Error("Expected two Reality object paths");
    const bytes = await blobBytes(good);
    replaceArchiveEntryNames(bytes, await inspectPortableArchive(good), second, first);
    await expect(readPortableProjectBundle(archiveBlob(bytes)))
      .rejects.toMatchObject({ code: "duplicate_entry" });
  });

  it("rejects inconsistent checked central offsets", async () => {
    const fixture = await portableFixture();
    const exported = await createPortableProjectBundle(fixture.project, fixture.sourceVault);
    const bytes = await blobBytes(await exported.toBlob());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(bytes.byteLength - 6, 0xffffffff, true);
    await expect(inspectPortableArchive(archiveBlob(bytes)))
      .rejects.toMatchObject({ code: "archive_corrupt" });
  });

  it("plans ZIP64 aggregate offsets without allocating a multi-gigabyte buffer", () => {
    const fakeBlob = (size: number) => ({ size } as Blob);
    const entries = [
      { path: "manifest.json", blob: fakeBlob(1024), crc32: 0 },
      { path: "project/workspace.semaframe.json", blob: fakeBlob(1024), crc32: 0 },
      ...Array.from({ length: 17 }, (_, index) => ({
        path: `objects/sha256/${index.toString(16).padStart(2, "0")}/${index.toString(16).padStart(64, "0")}`,
        blob: fakeBlob(256 * 1024 * 1024),
        crc32: 0,
      })),
    ];
    const plan = planPortableArchive(entries);
    expect(plan.byteLength).toBeGreaterThan(0xffffffff);
    expect(plan.zip64).toBe(true);
    expect(plan.entries.some((entry) => entry.zip64Offset)).toBe(true);
  });

  it("rolls back already-inserted objects when cancellation arrives during commit", async () => {
    const fixture = await portableFixture();
    const archive = await (await createPortableProjectBundle(fixture.project, fixture.sourceVault)).toBlob();
    const controller = new AbortController();
    class AbortingVault extends DelegatingAssetVault {
      private puts = 0;

      override async put(
        candidate: RealityAssetCandidate,
        blob: Blob,
        options?: AssetVaultOperationOptions,
      ): Promise<PutRealityAssetResult> {
        const result = await super.put(candidate, blob, options);
        this.puts += 1;
        if (this.puts === 1) controller.abort();
        return result;
      }
    }
    const target = new AbortingVault();
    let committed = false;
    await expect(importPortableProjectBundle(archive, {
      vault: target,
      signal: controller.signal,
      commitProject: () => { committed = true; },
    })).rejects.toMatchObject({ code: "aborted" });
    expect(committed).toBe(false);
    expect(await target.listDescriptors()).toEqual([]);
  });

  it("rolls back staged CAS objects when the atomic project replacement rejects", async () => {
    const fixture = await portableFixture();
    const archive = await (await createPortableProjectBundle(fixture.project, fixture.sourceVault)).toBlob();
    const target = new DelegatingAssetVault();
    await expect(importPortableProjectBundle(archive, {
      vault: target,
      commitProject: () => { throw new Error("host replacement failed before mutation"); },
    })).rejects.toThrow("Portable project import could not be committed");
    expect(await target.listDescriptors()).toEqual([]);
  });

  it("fails closed on same-length corrupt cached bytes", async () => {
    const fixture = await portableFixture();
    const archive = await (await createPortableProjectBundle(fixture.project, fixture.sourceVault)).toBlob();
    const descriptor = fixture.first.descriptor;
    const corrupt = binaryPly([
      [99, 98, 97, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
      [96, 95, 94, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
    ]);
    expect(corrupt.size).toBe(descriptor.byteLength);
    const target = {
      put: async (): Promise<PutRealityAssetResult> => {
        throw new Error("put must not run");
      },
      has: async (assetId: RealityAssetId) => assetId === descriptor.assetId,
      getDescriptor: async (assetId: RealityAssetId): Promise<RealityAssetDescriptor | undefined> => (
        assetId === descriptor.assetId ? descriptor : undefined
      ),
      open: async (assetId: RealityAssetId) => {
        if (assetId !== descriptor.assetId) throw new Error("missing");
        return corrupt;
      },
      listDescriptors: async () => [descriptor],
      delete: async () => false,
      dispose: () => undefined,
    };
    let committed = false;
    await expect(importPortableProjectBundle(archive, {
      vault: target,
      commitProject: () => { committed = true; },
    })).rejects.toMatchObject({ code: "cached_asset_corrupt" });
    expect(committed).toBe(false);
  });

  it("surfaces the typed error class for unsupported or corrupt archives", async () => {
    await expect(inspectPortableArchive(new Blob(["not a zip"])))
      .rejects.toBeInstanceOf(PortableProjectError);
  });
});
