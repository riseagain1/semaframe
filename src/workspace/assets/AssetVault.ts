import type {
  PutRealityAssetResult,
  RealityAssetCandidate,
  RealityAssetDescriptor,
  RealityAssetId,
} from "./types";

export type AssetVaultOperationOptions = Readonly<{
  signal?: AbortSignal;
}>;

/**
 * Content-addressed local binary storage. Agent-facing code should receive
 * descriptors only; `open` is a trusted renderer/host boundary.
 */
export interface AssetVault {
  put(
    candidate: RealityAssetCandidate,
    blob: Blob,
    options?: AssetVaultOperationOptions,
  ): Promise<PutRealityAssetResult>;
  has(assetId: RealityAssetId): Promise<boolean>;
  getDescriptor(assetId: RealityAssetId): Promise<RealityAssetDescriptor | undefined>;
  open(assetId: RealityAssetId): Promise<Blob>;
  listDescriptors(): Promise<readonly RealityAssetDescriptor[]>;
  delete(assetId: RealityAssetId): Promise<boolean>;
  dispose(): void;
}
