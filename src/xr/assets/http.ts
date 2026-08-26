import type { XrAssetDigest } from "./contracts";
import { parseXrAssetDigest } from "./validation";

export const XR_ASSET_HTTP_COLLECTION_PATH = "/api/xr/v1/assets" as const;
export const XR_ASSET_HTTP_SESSION_HEADER = "x-semaframe-xr-session" as const;
export const XR_ASSET_HTTP_DIGEST_HEADER = "x-semaframe-xr-asset-digest" as const;
export const XR_ASSET_HTTP_FORMAT_HEADER = "x-semaframe-xr-asset-format" as const;
export const XR_ASSET_HTTP_LENGTH_HEADER = "x-semaframe-xr-asset-length" as const;
export const XR_ASSET_HTTP_TTL_HEADER = "x-semaframe-xr-asset-ttl-ms" as const;

const ASSET_PATH_PATTERN = /^\/api\/xr\/v1\/assets\/sha256\/([a-f0-9]{64})$/u;

export function xrAssetHttpPath(digestValue: unknown): string {
  const digest = parseXrAssetDigest(digestValue);
  return `${XR_ASSET_HTTP_COLLECTION_PATH}/sha256/${digest.slice("sha256:".length)}`;
}

export function xrAssetDigestFromHttpPath(pathname: string): XrAssetDigest | undefined {
  const match = ASSET_PATH_PATTERN.exec(pathname);
  return match ? `sha256:${match[1]}` : undefined;
}
