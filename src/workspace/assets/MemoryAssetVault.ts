import type { AssetVault, AssetVaultOperationOptions } from "./AssetVault";
import { RealityAssetError } from "./errors";
import type {
  PutRealityAssetResult,
  RealityAssetCandidate,
  RealityAssetDescriptor,
  RealityAssetId,
} from "./types";
import { descriptorsEquivalent, verifyVaultPut } from "./vaultSafety";

type MemoryAssetRecord = Readonly<{
  descriptor: RealityAssetDescriptor;
  blob: Blob;
}>;

/** Deterministic in-memory implementation for tests, private sessions, and fallback hosts. */
export class MemoryAssetVault implements AssetVault {
  private readonly records = new Map<RealityAssetId, MemoryAssetRecord>();
  private disposed = false;

  async put(
    candidate: RealityAssetCandidate,
    blob: Blob,
    options: AssetVaultOperationOptions = {},
  ): Promise<PutRealityAssetResult> {
    this.assertOpen();
    const verified = await verifyVaultPut(candidate, blob, options);
    this.assertOpen();
    const existing = this.records.get(verified.descriptor.assetId);
    if (existing) {
      if (!descriptorsEquivalent(existing.descriptor, verified.descriptor)) {
        throw new RealityAssetError("digest_mismatch", "Content-addressed asset metadata is inconsistent");
      }
      return Object.freeze({ descriptor: existing.descriptor, deduplicated: true });
    }
    this.records.set(verified.descriptor.assetId, Object.freeze({
      descriptor: verified.descriptor,
      blob: verified.sanitizedBlob,
    }));
    return Object.freeze({ descriptor: verified.descriptor, deduplicated: false });
  }

  async has(assetId: RealityAssetId): Promise<boolean> {
    this.assertOpen();
    return this.records.has(assetId);
  }

  async getDescriptor(assetId: RealityAssetId): Promise<RealityAssetDescriptor | undefined> {
    this.assertOpen();
    return this.records.get(assetId)?.descriptor;
  }

  async open(assetId: RealityAssetId): Promise<Blob> {
    this.assertOpen();
    const record = this.records.get(assetId);
    if (!record) throw new RealityAssetError("not_found", "Reality asset is not available in the local vault");
    return record.blob.slice(0, record.blob.size, record.descriptor.mediaType);
  }

  async listDescriptors(): Promise<readonly RealityAssetDescriptor[]> {
    this.assertOpen();
    return Object.freeze([...this.records.values()]
      .map((record) => record.descriptor)
      .sort((left, right) => left.assetId.localeCompare(right.assetId)));
  }

  async delete(assetId: RealityAssetId): Promise<boolean> {
    this.assertOpen();
    return this.records.delete(assetId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.records.clear();
  }

  private assertOpen(): void {
    if (this.disposed) throw new RealityAssetError("storage_failure", "Reality asset vault has been disposed");
  }
}
