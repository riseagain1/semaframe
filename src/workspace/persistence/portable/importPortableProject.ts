import type { AssetVault } from "../../assets/AssetVault";
import type { RealityAssetCandidate, RealityAssetDescriptor } from "../../assets/types";
import {
  WorkspaceProjectSerializer,
  type WorkspaceProjectFile,
} from "../WorkspaceProjectSerializer";
import { verifyWorkspaceProjectCadEvidence } from "../cadProjectEvidenceVerification";
import {
  readPortableProjectBundle,
  verifyPortableRealityBlob,
  verifyPortableRealityObject,
  type PortableProjectVerifier,
  type PortableProjectBundleRead,
} from "./bundle";
import { PORTABLE_PROJECT_LIMITS } from "./constants";
import { readPortableBlobRange } from "./crc32";
import {
  PortableProjectError,
  portableProjectError,
  throwIfPortableProjectAborted,
} from "./errors";
import { samePortableRealityDescriptor } from "./manifest";

export type PortableProjectCommit = (project: WorkspaceProjectFile) => void | Promise<void>;

export type ImportPortableProjectOptions = Readonly<{
  vault: AssetVault;
  serializer?: WorkspaceProjectSerializer;
  signal?: AbortSignal;
  verifyProject?: PortableProjectVerifier;
  /** Must either replace the host project completely or throw before mutation. */
  commitProject?: PortableProjectCommit;
}>;

export type PortableProjectImportResult = Readonly<{
  kind: "portable";
  project: WorkspaceProjectFile;
  bundle: PortableProjectBundleRead;
  importedAssetIds: readonly string[];
  reusedAssetIds: readonly string[];
}>;

export type LegacyProjectImportResult = Readonly<{
  kind: "legacy-json";
  project: WorkspaceProjectFile;
  importedAssetIds: readonly [];
  reusedAssetIds: readonly [];
}>;

export type WorkspaceProjectArtifactImportResult = PortableProjectImportResult | LegacyProjectImportResult;

type StagedAsset = Readonly<{
  descriptor: RealityAssetDescriptor;
  candidate: RealityAssetCandidate;
  blob: Blob;
}>;

async function verifyCachedAsset(
  vault: AssetVault,
  descriptor: RealityAssetDescriptor,
  signal?: AbortSignal,
): Promise<boolean> {
  const cachedDescriptor = await vault.getDescriptor(descriptor.assetId);
  if (!cachedDescriptor) return false;
  if (!samePortableRealityDescriptor(cachedDescriptor, descriptor)) {
    throw new PortableProjectError(
      "cached_asset_corrupt",
      `Cached Reality descriptor ${descriptor.assetId} conflicts with the portable project`,
    );
  }
  let cachedBlob: Blob;
  try {
    cachedBlob = await vault.open(descriptor.assetId);
  } catch (error) {
    throw new PortableProjectError(
      "cached_asset_corrupt",
      `Cached Reality bytes ${descriptor.assetId} are unavailable`,
      { cause: error },
    );
  }
  await verifyPortableRealityBlob(cachedBlob, descriptor, signal, "cached_asset_corrupt");
  return true;
}

async function rollbackInserted(vault: AssetVault, assetIds: readonly string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const assetId of [...assetIds].reverse()) {
    try {
      await vault.delete(assetId as `ra_${string}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new PortableProjectError("rollback_failed", "Portable import could not roll back staged Reality bytes", {
      cause: failures[0],
    });
  }
}

export async function importPortableProjectBundle(
  archive: Blob,
  options: ImportPortableProjectOptions,
): Promise<PortableProjectImportResult> {
  const bundle = await readPortableProjectBundle(archive, {
    serializer: options.serializer,
    signal: options.signal,
    verifyProject: options.verifyProject,
  });
  const staged: StagedAsset[] = [];
  const reused: string[] = [];
  for (const asset of bundle.manifest.assets) {
    throwIfPortableProjectAborted(options.signal);
    // A valid local CAS object can avoid a write, but it must not mask a
    // damaged portable artifact. Every bundled object is still CRC/SHA/format
    // checked before the import is accepted.
    const verified = await verifyPortableRealityObject(
      archive,
      bundle,
      asset.descriptor,
      options.signal,
    );
    if (await verifyCachedAsset(options.vault, asset.descriptor, options.signal)) {
      reused.push(asset.assetId);
      continue;
    }
    staged.push(Object.freeze({
      descriptor: asset.descriptor,
      candidate: verified.candidate,
      blob: verified.blob,
    }));
  }

  // No target mutation occurs until the complete project and every object have
  // passed path, CRC, SHA-256, format and replay validation.
  const inserted: string[] = [];
  try {
    for (const asset of staged) {
      throwIfPortableProjectAborted(options.signal);
      const result = await options.vault.put(asset.candidate, asset.blob, { signal: options.signal });
      if (!result.deduplicated) inserted.push(asset.descriptor.assetId);
    }
    throwIfPortableProjectAborted(options.signal);
    await options.commitProject?.(bundle.project);
  } catch (error) {
    try {
      await rollbackInserted(options.vault, inserted);
    } catch (rollbackError) {
      if (rollbackError instanceof PortableProjectError) throw rollbackError;
      throw new PortableProjectError("rollback_failed", "Portable import rollback failed", { cause: rollbackError });
    }
    throw portableProjectError(error, "asset_corrupt", "Portable project import could not be committed");
  }
  return Object.freeze({
    kind: "portable",
    project: bundle.project,
    bundle,
    importedAssetIds: Object.freeze([...inserted]),
    reusedAssetIds: Object.freeze([...reused]),
  });
}

async function decodeLegacyProject(
  source: Blob,
  serializer: WorkspaceProjectSerializer,
  signal?: AbortSignal,
  verifyProject?: PortableProjectVerifier,
): Promise<WorkspaceProjectFile> {
  if (source.size < 2 || source.size > PORTABLE_PROJECT_LIMITS.maximumProjectBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Workspace JSON project size is outside the supported range");
  }
  const bytes = await readPortableBlobRange(source, 0, source.size, signal);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PortableProjectError("legacy_project_invalid", "Workspace JSON project is not valid UTF-8", { cause: error });
  }
  try {
    const project = serializer.deserialize(text);
    await (verifyProject ?? verifyWorkspaceProjectCadEvidence)(project);
    return project;
  } catch (error) {
    throw new PortableProjectError("legacy_project_invalid", "Workspace JSON project failed validation", { cause: error });
  }
}

/** Magic-based compatibility seam: old metadata-only JSON remains supported. */
export async function importWorkspaceProjectArtifact(
  source: Blob,
  options: ImportPortableProjectOptions,
): Promise<WorkspaceProjectArtifactImportResult> {
  throwIfPortableProjectAborted(options.signal);
  const serializer = options.serializer ?? new WorkspaceProjectSerializer();
  const prefix = source.size >= 4
    ? await readPortableBlobRange(source, 0, 4, options.signal)
    : new Uint8Array();
  if (prefix[0] === 0x50 && prefix[1] === 0x4b && prefix[2] === 0x03 && prefix[3] === 0x04) {
    return importPortableProjectBundle(source, { ...options, serializer });
  }
  const project = await decodeLegacyProject(source, serializer, options.signal, options.verifyProject);
  throwIfPortableProjectAborted(options.signal);
  await options.commitProject?.(project);
  return Object.freeze({
    kind: "legacy-json",
    project,
    importedAssetIds: Object.freeze([]) as readonly [],
    reusedAssetIds: Object.freeze([]) as readonly [],
  });
}
