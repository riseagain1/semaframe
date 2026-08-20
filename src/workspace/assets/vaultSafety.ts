import { digestBlobSha256 } from "./digest";
import { RealityAssetError, throwIfRealityAssetAborted } from "./errors";
import type { AssetVaultOperationOptions } from "./AssetVault";
import type { RealityAssetCandidate, RealityAssetDescriptor } from "./types";
import { parseRealityAssetCandidate } from "./validation";

export async function verifyVaultPut(
  candidate: RealityAssetCandidate,
  blob: Blob,
  options: AssetVaultOperationOptions = {},
): Promise<Readonly<{ descriptor: RealityAssetDescriptor; sanitizedBlob: Blob }>> {
  const descriptor = parseRealityAssetCandidate(candidate).descriptor;
  if (blob.size !== descriptor.byteLength) {
    throw new RealityAssetError("digest_mismatch", "Reality asset byte length changed after inspection");
  }
  throwIfRealityAssetAborted(options.signal);
  const digest = await digestBlobSha256(blob, { signal: options.signal });
  if (digest !== descriptor.digest) {
    throw new RealityAssetError("digest_mismatch", "Reality asset content changed after inspection");
  }
  throwIfRealityAssetAborted(options.signal);
  // slice() deliberately strips File.name/lastModified and normalizes MIME type.
  const sanitizedBlob = blob.slice(0, blob.size, descriptor.mediaType);
  return Object.freeze({ descriptor, sanitizedBlob });
}

export function descriptorsEquivalent(left: RealityAssetDescriptor, right: RealityAssetDescriptor): boolean {
  const fingerprint = (descriptor: RealityAssetDescriptor): string => JSON.stringify([
    descriptor.version,
    descriptor.assetId,
    descriptor.digest,
    descriptor.format,
    descriptor.formatVersion,
    descriptor.mediaType,
    descriptor.byteLength,
    descriptor.splatCount,
    descriptor.sphericalHarmonicsDegree,
    descriptor.model,
    descriptor.antialiased,
    descriptor.coordinateSystem.system,
    descriptor.coordinateSystem.provenance,
    descriptor.sourceBounds?.min.x,
    descriptor.sourceBounds?.min.y,
    descriptor.sourceBounds?.min.z,
    descriptor.sourceBounds?.max.x,
    descriptor.sourceBounds?.max.y,
    descriptor.sourceBounds?.max.z,
    descriptor.engineeringAuthority,
  ]);
  return fingerprint(left) === fingerprint(right);
}
