import type { AssetVault } from "../../assets/AssetVault";
import { digestBlobSha256 } from "../../assets/digest";
import { inspectRealityAsset } from "../../assets/inspectRealityAsset";
import type { RealityAssetCandidate, RealityAssetDescriptor } from "../../assets/types";
import {
  WorkspaceProjectSerializer,
  type WorkspaceProjectFile,
} from "../WorkspaceProjectSerializer";
import { verifyWorkspaceProjectCadEvidence } from "../cadProjectEvidenceVerification";
import {
  inspectPortableArchive,
  materializePortableArchive,
  planPortableArchive,
  portableArchiveEntryBlob,
  streamPortableArchive,
  verifyPortableArchiveEntryCrc,
  type PortableArchiveEntry,
  type PortableArchiveLayout,
  type PortableArchivePlan,
} from "./archive";
import { canonicalJsonBytes } from "./canonicalJson";
import { collectPortableRealityAssetClosure } from "./closure";
import {
  PORTABLE_PROJECT_LIMITS,
  PORTABLE_PROJECT_MANIFEST_PATH,
  PORTABLE_PROJECT_WORKSPACE_PATH,
} from "./constants";
import { crc32Blob, readPortableBlobRange } from "./crc32";
import {
  PortableProjectError,
  portableProjectError,
  throwIfPortableProjectAborted,
} from "./errors";
import {
  assertPortableManifestMatchesProject,
  createPortableProjectManifest,
  parseCanonicalPortableProjectManifestBytes,
  portableManifestEntryPaths,
  samePortableRealityDescriptor,
  type PortableProjectManifest,
} from "./manifest";

export type CreatePortableProjectBundleOptions = Readonly<{
  serializer?: WorkspaceProjectSerializer;
  signal?: AbortSignal;
  verifyProject?: PortableProjectVerifier;
}>;

export type PortableProjectVerifier = (project: WorkspaceProjectFile) => Promise<void>;

export type PortableProjectBundleExport = Readonly<{
  manifest: PortableProjectManifest;
  manifestDigest: string;
  project: WorkspaceProjectFile;
  byteLength: number;
  stream: (signal?: AbortSignal) => ReadableStream<Uint8Array>;
  toBlob: (options?: Readonly<{ signal?: AbortSignal; maximumBytes?: number }>) => Promise<Blob>;
}>;

export type PortableProjectBundleRead = Readonly<{
  manifest: PortableProjectManifest;
  manifestDigest: string;
  project: WorkspaceProjectFile;
  serializedProject: string;
  layout: PortableArchiveLayout;
  assetEntries: ReadonlyMap<string, PortableArchiveEntry>;
}>;

function blobFromBytes(bytes: Uint8Array, mediaType: string): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: mediaType });
}

function textBlob(text: string, mediaType = "application/json"): Blob {
  return new Blob([text], { type: mediaType });
}

async function digestPortableBlob(
  blob: Blob,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  code: "invalid_manifest" | "project_corrupt",
): Promise<string> {
  try {
    return await digestBlobSha256(blob, { signal, maximumBytes });
  } catch (error) {
    throw portableProjectError(error, code, "Portable project SHA-256 verification failed");
  }
}

async function verifyRealityBlob(
  blob: Blob,
  descriptor: RealityAssetDescriptor,
  signal?: AbortSignal,
  code: "asset_corrupt" | "cached_asset_corrupt" = "asset_corrupt",
): Promise<RealityAssetCandidate> {
  if (blob.size !== descriptor.byteLength) {
    throw new PortableProjectError(code, `Reality bytes for ${descriptor.assetId} have the wrong length`);
  }
  let candidate: RealityAssetCandidate;
  try {
    candidate = await inspectRealityAsset(blob, { signal });
  } catch (error) {
    throw portableProjectError(error, code, `Reality bytes for ${descriptor.assetId} failed format preflight`);
  }
  if (!samePortableRealityDescriptor(candidate.descriptor, descriptor)) {
    throw new PortableProjectError(code, `Reality bytes for ${descriptor.assetId} do not match their descriptor`);
  }
  return candidate;
}

async function openVerifiedSourceAsset(
  vault: AssetVault,
  descriptor: RealityAssetDescriptor,
  signal?: AbortSignal,
): Promise<Readonly<{ blob: Blob; crc32: number }>> {
  throwIfPortableProjectAborted(signal);
  let blob: Blob;
  try {
    blob = await vault.open(descriptor.assetId);
  } catch (error) {
    throwIfPortableProjectAborted(signal);
    throw new PortableProjectError(
      "missing_asset",
      `Portable export requires local bytes for ${descriptor.assetId}`,
      { cause: error },
    );
  }
  await verifyRealityBlob(blob, descriptor, signal);
  const checksum = await crc32Blob(blob, { signal });
  return Object.freeze({ blob: blob.slice(0, blob.size, descriptor.mediaType), crc32: checksum });
}

export async function createPortableProjectBundle(
  projectInput: WorkspaceProjectFile,
  vault: AssetVault,
  options: CreatePortableProjectBundleOptions = {},
): Promise<PortableProjectBundleExport> {
  const serializer = options.serializer ?? new WorkspaceProjectSerializer();
  throwIfPortableProjectAborted(options.signal);
  let serializedProject: string;
  let project: WorkspaceProjectFile;
  try {
    serializedProject = serializer.serialize(projectInput);
    project = serializer.deserialize(serializedProject);
    await (options.verifyProject ?? verifyWorkspaceProjectCadEvidence)(project);
  } catch (error) {
    throw new PortableProjectError("project_corrupt", "Workspace project is not valid for portable export", { cause: error });
  }
  const projectBlob = textBlob(serializedProject);
  if (projectBlob.size > PORTABLE_PROJECT_LIMITS.maximumProjectBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Workspace project exceeds the portable project limit");
  }
  const projectDigest = await digestPortableBlob(
    projectBlob,
    PORTABLE_PROJECT_LIMITS.maximumProjectBytes,
    options.signal,
    "project_corrupt",
  );
  const closure = collectPortableRealityAssetClosure(project);
  const verifiedAssets = new Map<string, Readonly<{ blob: Blob; crc32: number }>>();
  for (const descriptor of closure) {
    verifiedAssets.set(descriptor.assetId, await openVerifiedSourceAsset(vault, descriptor, options.signal));
  }
  const manifest = createPortableProjectManifest(project, projectDigest, projectBlob.size, closure);
  const manifestBytes = canonicalJsonBytes(manifest);
  if (manifestBytes.byteLength > PORTABLE_PROJECT_LIMITS.maximumManifestBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Portable manifest exceeds its size limit");
  }
  const manifestBlob = blobFromBytes(manifestBytes, "application/json");
  const manifestDigest = await digestPortableBlob(
    manifestBlob,
    PORTABLE_PROJECT_LIMITS.maximumManifestBytes,
    options.signal,
    "invalid_manifest",
  );
  const sourceEntries = [
    {
      path: PORTABLE_PROJECT_MANIFEST_PATH,
      blob: manifestBlob,
      crc32: await crc32Blob(manifestBlob, { signal: options.signal }),
    },
    {
      path: PORTABLE_PROJECT_WORKSPACE_PATH,
      blob: projectBlob,
      crc32: await crc32Blob(projectBlob, { signal: options.signal }),
    },
    ...manifest.assets.map((asset) => {
      const verified = verifiedAssets.get(asset.assetId);
      if (!verified) {
        throw new PortableProjectError("missing_asset", `Portable export lost Reality bytes for ${asset.assetId}`);
      }
      return { path: asset.objectPath, blob: verified.blob, crc32: verified.crc32 };
    }),
  ];
  const plan: PortableArchivePlan = planPortableArchive(sourceEntries);
  return Object.freeze({
    manifest,
    manifestDigest,
    project,
    byteLength: plan.byteLength,
    stream: (signal?: AbortSignal) => streamPortableArchive(plan, signal),
    toBlob: (materializeOptions = {}) => materializePortableArchive(plan, materializeOptions),
  });
}

function entryMap(layout: PortableArchiveLayout): Map<string, PortableArchiveEntry> {
  return new Map(layout.entries.map((entry) => [entry.path, entry]));
}

async function smallEntryBytes(
  archive: Blob,
  entry: PortableArchiveEntry,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (entry.byteLength < 1 || entry.byteLength > maximumBytes) {
    throw new PortableProjectError("size_limit_exceeded", `Portable entry ${entry.path} exceeds its size limit`);
  }
  await verifyPortableArchiveEntryCrc(archive, entry, signal);
  return readPortableBlobRange(archive, entry.dataOffset, entry.dataEnd, signal);
}

function decodeProject(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PortableProjectError("project_corrupt", "Embedded Workspace project is not valid UTF-8", { cause: error });
  }
}

function assertManifestClosure(
  manifest: PortableProjectManifest,
  project: WorkspaceProjectFile,
): void {
  const closure = collectPortableRealityAssetClosure(project);
  if (closure.length !== manifest.assets.length) {
    throw new PortableProjectError("closure_mismatch", "Portable manifest does not contain the complete Reality replay closure");
  }
  closure.forEach((descriptor, index) => {
    const asset = manifest.assets[index];
    if (!asset || !samePortableRealityDescriptor(descriptor, asset.descriptor)) {
      throw new PortableProjectError("closure_mismatch", "Portable Reality descriptor closure does not match the Workspace project");
    }
  });
}

export async function readPortableProjectBundle(
  archive: Blob,
  options: Readonly<{
    serializer?: WorkspaceProjectSerializer;
    signal?: AbortSignal;
    verifyProject?: PortableProjectVerifier;
  }> = {},
): Promise<PortableProjectBundleRead> {
  const serializer = options.serializer ?? new WorkspaceProjectSerializer();
  const layout = await inspectPortableArchive(archive, options.signal);
  const entries = entryMap(layout);
  const first = layout.entries[0];
  const second = layout.entries[1];
  if (first?.path !== PORTABLE_PROJECT_MANIFEST_PATH || second?.path !== PORTABLE_PROJECT_WORKSPACE_PATH) {
    throw new PortableProjectError("invalid_path", "Portable manifest and project entries must be first and canonical");
  }
  const manifestBytes = await smallEntryBytes(
    archive,
    first,
    PORTABLE_PROJECT_LIMITS.maximumManifestBytes,
    options.signal,
  );
  const manifest = parseCanonicalPortableProjectManifestBytes(manifestBytes);
  const expectedPaths = portableManifestEntryPaths(manifest);
  const actualPaths = layout.entries.map((entry) => entry.path);
  if (
    expectedPaths.length !== actualPaths.length
    || expectedPaths.some((path, index) => path !== actualPaths[index])
  ) {
    throw new PortableProjectError("closure_mismatch", "Portable archive entries do not exactly match its manifest");
  }
  const manifestDigest = await digestPortableBlob(
    blobFromBytes(manifestBytes, "application/json"),
    PORTABLE_PROJECT_LIMITS.maximumManifestBytes,
    options.signal,
    "invalid_manifest",
  );
  if (second.byteLength !== manifest.project.byteLength) {
    throw new PortableProjectError("project_corrupt", "Embedded Workspace project length does not match its manifest");
  }
  const projectBytes = await smallEntryBytes(
    archive,
    second,
    PORTABLE_PROJECT_LIMITS.maximumProjectBytes,
    options.signal,
  );
  const projectBlob = blobFromBytes(projectBytes, "application/json");
  const projectDigest = await digestPortableBlob(
    projectBlob,
    PORTABLE_PROJECT_LIMITS.maximumProjectBytes,
    options.signal,
    "project_corrupt",
  );
  if (projectDigest !== manifest.project.digest) {
    throw new PortableProjectError("project_corrupt", "Embedded Workspace project failed its SHA-256 check");
  }
  const serializedProject = decodeProject(projectBytes);
  let project: WorkspaceProjectFile;
  try {
    project = serializer.deserialize(serializedProject);
    await (options.verifyProject ?? verifyWorkspaceProjectCadEvidence)(project);
  } catch (error) {
    throw new PortableProjectError("project_corrupt", "Embedded Workspace project failed validation and replay checks", { cause: error });
  }
  assertPortableManifestMatchesProject(manifest, project);
  assertManifestClosure(manifest, project);
  const assetEntries = new Map<string, PortableArchiveEntry>();
  for (const asset of manifest.assets) {
    const entry = entries.get(asset.objectPath);
    if (!entry || entry.byteLength !== asset.byteLength) {
      throw new PortableProjectError("closure_mismatch", `Portable Reality object ${asset.assetId} is absent or has the wrong length`);
    }
    assetEntries.set(asset.assetId, entry);
  }
  return Object.freeze({
    manifest,
    manifestDigest,
    project,
    serializedProject,
    layout,
    assetEntries,
  });
}

export async function verifyPortableRealityObject(
  archive: Blob,
  bundle: PortableProjectBundleRead,
  descriptor: RealityAssetDescriptor,
  signal?: AbortSignal,
): Promise<Readonly<{ blob: Blob; candidate: RealityAssetCandidate }>> {
  const entry = bundle.assetEntries.get(descriptor.assetId);
  if (!entry) {
    throw new PortableProjectError("closure_mismatch", `Portable Reality object ${descriptor.assetId} is missing`);
  }
  await verifyPortableArchiveEntryCrc(archive, entry, signal);
  const blob = portableArchiveEntryBlob(archive, entry, descriptor.mediaType);
  const candidate = await verifyRealityBlob(blob, descriptor, signal);
  return Object.freeze({ blob, candidate });
}

export { verifyRealityBlob as verifyPortableRealityBlob };
