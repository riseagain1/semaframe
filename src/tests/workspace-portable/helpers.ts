import type {
  AssetVault,
  AssetVaultOperationOptions,
  PutRealityAssetResult,
  RealityAssetCandidate,
  RealityAssetDescriptor,
  RealityAssetId,
} from "../../workspace/assets";
import { inspectRealityAsset, MemoryAssetVault } from "../../workspace/assets";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  WorkspaceProjectSerializer,
  type WorkspaceProjectFile,
} from "../../workspace/persistence";
import { readPortableBlobRange } from "../../workspace/persistence/portable";
import type { PortableArchiveLayout } from "../../workspace/persistence/portable";
import { WorkspaceStore } from "../../workspace/state";
import { binaryPly } from "../workspace-assets/fixtures";
import { workspaceBatch } from "../workspace/helpers";

const worldPlacement = (x: number, y: number, z: number) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

const calibration = {
  version: 1,
  status: "uncalibrated",
  sourceCoordinateSystem: "UNKNOWN",
  targetCoordinateSystem: "RUB",
  metersPerSourceUnit: null,
} as const;

export type PortableFixture = Readonly<{
  serializer: WorkspaceProjectSerializer;
  project: WorkspaceProjectFile;
  sourceVault: MemoryAssetVault;
  first: RealityAssetCandidate;
  second: RealityAssetCandidate;
}>;

export async function portableFixture(): Promise<PortableFixture> {
  const firstBlob = binaryPly([
    [0, 0, 0, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
    [1, 2, 3, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
  ]);
  const secondBlob = binaryPly([
    [10, 20, 30, 1, -1, -1, -1, 0, 0, 0, 1, 0.25, 0.25, 0.25],
  ]);
  const first = await inspectRealityAsset(firstBlob);
  const second = await inspectRealityAsset(secondBlob);
  const sourceVault = new MemoryAssetVault();
  await sourceVault.put(first, firstBlob);
  await sourceVault.put(second, secondBlob);

  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "portable_reality_setup", [{
    op: "register_reality_asset",
    op_id: "register_first",
    asset: first.descriptor,
  }, {
    op: "register_reality_asset",
    op_id: "register_second",
    asset: second.descriptor,
  }, {
    op: "create_component",
    op_id: "stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: worldPlacement(0, 0, 0),
  }, {
    op: "create_component",
    op_id: "scan_one",
    id: "SCAN_ONE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("gaussian-splat"),
    label: "First Reality instance",
    placement: worldPlacement(0, 0, 0),
    props: {
      assetRef: { assetId: first.descriptor.assetId, digest: first.descriptor.digest },
      calibration,
      quality: "auto",
      semanticProxyIds: [],
    },
  }, {
    op: "create_component",
    op_id: "scan_two",
    id: "SCAN_TWO",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("gaussian-splat"),
    label: "Second instance of the same bytes",
    placement: worldPlacement(4, 0, 0),
    props: {
      assetRef: { assetId: first.descriptor.assetId, digest: first.descriptor.digest },
      calibration,
      quality: "high",
      semanticProxyIds: [],
    },
  }]));
  // The final catalog no longer contains this asset, but undo/replay can still
  // restore its registration, so a portable bundle must retain its bytes.
  store.apply(workspaceBatch(store, "portable_delete_second", [{
    op: "delete_reality_asset",
    op_id: "delete_second",
    asset_id: second.descriptor.assetId,
    confirm: true,
  }]));

  const serializer = new WorkspaceProjectSerializer();
  const project = serializer.fromStore("portable_reality_project", store, {
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  });
  return Object.freeze({ serializer, project, sourceVault, first, second });
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return readPortableBlobRange(blob, 0, blob.size);
}

export function replaceAllSameLength(
  bytes: Uint8Array,
  fromText: string,
  toText: string,
): number {
  const encoder = new TextEncoder();
  const from = encoder.encode(fromText);
  const to = encoder.encode(toText);
  if (from.byteLength !== to.byteLength) throw new Error("Replacement must preserve archive offsets");
  let replacements = 0;
  for (let offset = 0; offset <= bytes.byteLength - from.byteLength; offset += 1) {
    if (from.every((byte, index) => bytes[offset + index] === byte)) {
      bytes.set(to, offset);
      replacements += 1;
      offset += from.byteLength - 1;
    }
  }
  return replacements;
}

export function replaceArchiveEntryNames(
  bytes: Uint8Array,
  layout: PortableArchiveLayout,
  fromText: string,
  toText: string,
): void {
  const encoder = new TextEncoder();
  const from = encoder.encode(fromText);
  const to = encoder.encode(toText);
  if (from.byteLength !== to.byteLength) throw new Error("Replacement must preserve archive offsets");
  const entry = layout.entries.find((candidate) => candidate.path === fromText);
  if (!entry) throw new Error(`Archive does not contain ${fromText}`);
  bytes.set(to, entry.localHeaderOffset + 30);
  let centralMatch = -1;
  for (
    let offset = layout.centralDirectoryOffset;
    offset <= layout.centralDirectoryOffset + layout.centralDirectorySize - from.byteLength;
    offset += 1
  ) {
    if (from.every((byte, index) => bytes[offset + index] === byte)) {
      centralMatch = offset;
      break;
    }
  }
  if (centralMatch < 0) throw new Error(`Central directory does not contain ${fromText}`);
  bytes.set(to, centralMatch);
}

export class DelegatingAssetVault implements AssetVault {
  readonly inner = new MemoryAssetVault();

  put(
    candidate: RealityAssetCandidate,
    blob: Blob,
    options?: AssetVaultOperationOptions,
  ): Promise<PutRealityAssetResult> {
    return this.inner.put(candidate, blob, options);
  }

  has(assetId: RealityAssetId): Promise<boolean> { return this.inner.has(assetId); }
  getDescriptor(assetId: RealityAssetId): Promise<RealityAssetDescriptor | undefined> {
    return this.inner.getDescriptor(assetId);
  }
  open(assetId: RealityAssetId): Promise<Blob> { return this.inner.open(assetId); }
  listDescriptors(): Promise<readonly RealityAssetDescriptor[]> { return this.inner.listDescriptors(); }
  delete(assetId: RealityAssetId): Promise<boolean> { return this.inner.delete(assetId); }
  dispose(): void { this.inner.dispose(); }
}
