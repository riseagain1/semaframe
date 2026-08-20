import { readBlobRange } from "./blobIO";
import { digestBlobSha256 } from "./digest";
import { RealityAssetError, throwIfRealityAssetAborted } from "./errors";
import type { RealityAssetFormatPreflight } from "./formatTypes";
import { REALITY_ASSET_LIMITS } from "./limits";
import { preflightPly } from "./plyPreflight";
import { preflightSogV2 } from "./sogPreflight";
import { preflightSpzV4 } from "./spzPreflight";
import type { RealityAssetCandidate, RealityAssetDescriptor } from "./types";
import { assetIdFromDigest, parseRealityAssetDescriptor } from "./validation";

export type InspectRealityAssetOptions = Readonly<{
  signal?: AbortSignal;
}>;

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[index] === byte);
}

/** Format detection is based on file bytes only; File names and MIME hints are ignored. */
export async function preflightRealityAssetFormat(
  blob: Blob,
  options: InspectRealityAssetOptions = {},
): Promise<RealityAssetFormatPreflight> {
  if (blob.size === 0) throw new RealityAssetError("empty_file", "Reality asset file is empty");
  if (blob.size > REALITY_ASSET_LIMITS.maximumAssetBytes) {
    throw new RealityAssetError(
      "file_too_large",
      `Reality asset exceeds the ${REALITY_ASSET_LIMITS.maximumAssetBytes} byte limit`,
    );
  }
  throwIfRealityAssetAborted(options.signal);
  const signature = await readBlobRange(blob, 0, Math.min(blob.size, 8), options.signal);
  if (startsWith(signature, [0x4e, 0x47, 0x53, 0x50])) {
    return preflightSpzV4(blob, options.signal);
  }
  if (startsWith(signature, [0x70, 0x6c, 0x79, 0x0a]) || startsWith(signature, [0x70, 0x6c, 0x79, 0x0d, 0x0a])) {
    return preflightPly(blob, options.signal);
  }
  if (startsWith(signature, [0x50, 0x4b, 0x03, 0x04])) {
    return preflightSogV2(blob, options.signal);
  }
  if (startsWith(signature, [0x1f, 0x8b])) {
    throw new RealityAssetError("unsupported_format", "Legacy compressed SPZ is not accepted; convert it to SPZ v4");
  }
  throw new RealityAssetError("unsupported_format", "Reality asset format is not supported");
}

export async function inspectRealityAsset(
  blob: Blob,
  options: InspectRealityAssetOptions = {},
): Promise<RealityAssetCandidate> {
  const preflight = await preflightRealityAssetFormat(blob, options);
  throwIfRealityAssetAborted(options.signal);
  const digest = await digestBlobSha256(blob, { signal: options.signal });
  const descriptor: RealityAssetDescriptor = parseRealityAssetDescriptor({
    version: 1,
    assetId: assetIdFromDigest(digest),
    digest,
    format: preflight.format,
    formatVersion: preflight.formatVersion,
    mediaType: preflight.mediaType,
    byteLength: blob.size,
    splatCount: preflight.splatCount,
    sphericalHarmonicsDegree: preflight.sphericalHarmonicsDegree,
    model: preflight.model,
    antialiased: preflight.antialiased,
    coordinateSystem: preflight.coordinateSystem,
    ...(preflight.sourceBounds === undefined ? {} : { sourceBounds: preflight.sourceBounds }),
    engineeringAuthority: "visual_only",
  });
  return Object.freeze({ descriptor, warnings: Object.freeze([...new Set(preflight.warnings)]) });
}
