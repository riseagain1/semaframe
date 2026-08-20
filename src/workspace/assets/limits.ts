/**
 * Reality assets are untrusted binary inputs. These limits are intentionally
 * host-owned and apply before any renderer or codec receives the bytes.
 */
export const REALITY_ASSET_LIMITS = Object.freeze({
  maximumAssetBytes: 256 * 1024 * 1024,
  maximumSplatCount: 4_000_000,
  maximumExpandedBytes: 512 * 1024 * 1024,
  maximumHeaderBytes: 1024 * 1024,
  maximumZipCentralDirectoryBytes: 2 * 1024 * 1024,
  maximumZipEntries: 64,
  maximumZipEntryNameBytes: 512,
  maximumZipExtraBytes: 4096,
  maximumZipCommentBytes: 4096,
  maximumSogMetadataBytes: 1024 * 1024,
  maximumPlyLineBytes: 16 * 1024,
  digestChunkBytes: 1024 * 1024,
  defaultWorkerTimeoutMs: 30_000,
  maximumWorkerTimeoutMs: 120_000,
});
