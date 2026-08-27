import { REALITY_ASSET_LIMITS } from "../../assets/limits";
import {
  MAX_WORKSPACE_PROJECT_BYTES,
  MAX_WORKSPACE_REALITY_ASSETS,
} from "../../state/workspaceLimits";

export const PORTABLE_PROJECT_FORMAT = "semaframe-portable-project" as const;
export const PORTABLE_PROJECT_FORMAT_VERSION = "1.0" as const;
export const PORTABLE_PROJECT_EXTENSION = ".semaframe-project" as const;
export const PORTABLE_PROJECT_MEDIA_TYPE = "application/vnd.semaframe.project+zip" as const;

export const PORTABLE_PROJECT_MANIFEST_PATH = "manifest.json" as const;
export const PORTABLE_PROJECT_WORKSPACE_PATH = "project/workspace.semaframe.json" as const;

export const PORTABLE_PROJECT_LIMITS = Object.freeze({
  maximumManifestBytes: 1024 * 1024,
  maximumProjectBytes: MAX_WORKSPACE_PROJECT_BYTES,
  maximumAssets: MAX_WORKSPACE_REALITY_ASSETS,
  maximumAssetBytes: REALITY_ASSET_LIMITS.maximumAssetBytes,
  maximumEntries: MAX_WORKSPACE_REALITY_ASSETS + 2,
  maximumPathBytes: 256,
  maximumCentralDirectoryBytes: 1024 * 1024,
  ioChunkBytes: REALITY_ASSET_LIMITS.digestChunkBytes,
  /**
   * This follows the already-valid Workspace upper bound rather than adding a
   * smaller, surprising portability limit. Importers still perform a storage
   * quota check before committing bytes in their host integration.
   */
  maximumBundleBytes:
    MAX_WORKSPACE_REALITY_ASSETS * REALITY_ASSET_LIMITS.maximumAssetBytes
    + MAX_WORKSPACE_PROJECT_BYTES
    + 2 * 1024 * 1024,
  defaultMaximumMaterializedBytes: 512 * 1024 * 1024,
});

export function portableRealityObjectPath(digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError("Portable Reality object digest must be canonical SHA-256");
  }
  const hex = digest.slice(7);
  return `objects/sha256/${hex.slice(0, 2)}/${hex}`;
}
