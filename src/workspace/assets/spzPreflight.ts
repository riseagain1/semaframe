import { boundedUint64, checkedAdd, readBlobRange } from "./blobIO";
import { RealityAssetError } from "./errors";
import type { RealityAssetFormatPreflight } from "./formatTypes";
import { REALITY_ASSET_LIMITS } from "./limits";
import type { RealityAssetWarningCode, RealityCoordinateSystem } from "./types";

const SPZ_HEADER_BYTES = 32;
const SPZ_MAGIC = 0x5053474e;
const SPZ_VERSION = 4;
const SPZ_FLAG_ANTIALIASED = 0x1;
const SPZ_FLAG_EXTENSIONS = 0x2;
const SPZ_COORDINATE_EXTENSION = 0xadbe0003;
const SPZ_SAFE_ORBIT_EXTENSION = 0xadbe0002;

const SPZ_COORDINATE_VALUES: readonly RealityCoordinateSystem[] = [
  "UNKNOWN",
  "LDB", "RDB", "LUB", "RUB", "LDF", "RDF", "LUF", "RUF",
  "LFD", "RFD", "LFU", "RFU", "LBD", "RBD", "LBU", "RBU",
];

function shCoefficientCount(degree: number): number {
  return degree === 0 ? 0 : (((degree + 1) ** 2) - 1) * 3;
}

function expectedStreamSizes(splatCount: number, degree: number): number[] {
  return [
    splatCount * 9,
    splatCount,
    splatCount * 3,
    splatCount * 3,
    splatCount * 4,
    splatCount * shCoefficientCount(degree),
  ].filter((size) => size > 0);
}

type SpzExtensions = Readonly<{
  coordinateSystem: RealityCoordinateSystem;
  coordinateProvenance: "embedded" | "format-default" | "unknown";
  warnings: readonly RealityAssetWarningCode[];
}>;

function inspectExtensions(bytes: Uint8Array, flags: number): SpzExtensions {
  if ((flags & SPZ_FLAG_EXTENSIONS) === 0) {
    if (bytes.byteLength !== 0) {
      throw new RealityAssetError("invalid_format", "SPZ contains an undeclared extension zone");
    }
    return { coordinateSystem: "RUB", coordinateProvenance: "format-default", warnings: [] };
  }
  if (bytes.byteLength === 0) {
    throw new RealityAssetError("invalid_format", "SPZ declares extensions but has no extension records");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let coordinateSystem: RealityCoordinateSystem = "RUB";
  let coordinateProvenance: "embedded" | "format-default" | "unknown" = "format-default";
  let unknownExtensions = false;
  let coordinateSeen = false;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) {
      throw new RealityAssetError("invalid_format", "SPZ extension header is truncated");
    }
    const type = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    if (type === 0) throw new RealityAssetError("invalid_format", "SPZ extension type zero is reserved");
    offset += 8;
    const end = checkedAdd(offset, length, "SPZ extension length overflowed");
    if (end > bytes.byteLength) {
      throw new RealityAssetError("invalid_format", "SPZ extension payload is truncated");
    }
    if (type === SPZ_COORDINATE_EXTENSION) {
      if (coordinateSeen || length !== 4) {
        throw new RealityAssetError("invalid_format", "SPZ coordinate extension is invalid");
      }
      const value = view.getUint32(offset, true);
      if (value < 1 || value >= SPZ_COORDINATE_VALUES.length) {
        throw new RealityAssetError("invalid_format", "SPZ coordinate extension is unsupported");
      }
      coordinateSystem = SPZ_COORDINATE_VALUES[value] ?? "UNKNOWN";
      coordinateProvenance = "embedded";
      coordinateSeen = true;
    } else if (type === SPZ_SAFE_ORBIT_EXTENSION) {
      if (length !== 12) {
        throw new RealityAssetError("invalid_format", "SPZ safe-orbit extension is invalid");
      }
      const minimumElevation = view.getFloat32(offset, true);
      const maximumElevation = view.getFloat32(offset + 4, true);
      const minimumRadius = view.getFloat32(offset + 8, true);
      if (
        !Number.isFinite(minimumElevation)
        || !Number.isFinite(maximumElevation)
        || !Number.isFinite(minimumRadius)
        || minimumElevation > maximumElevation
        || minimumRadius < 0
      ) {
        throw new RealityAssetError("invalid_format", "SPZ safe-orbit values are invalid");
      }
    } else {
      unknownExtensions = true;
    }
    offset = end;
  }
  if (unknownExtensions) {
    // An unknown extension may alter coordinate interpretation. Do not silently
    // expose format-default or embedded coordinates as engineering evidence.
    coordinateSystem = "UNKNOWN";
    coordinateProvenance = "unknown";
  }
  return {
    coordinateSystem,
    coordinateProvenance,
    warnings: unknownExtensions ? ["unknown_spz_extensions"] : [],
  };
}

export async function preflightSpzV4(blob: Blob, signal?: AbortSignal): Promise<RealityAssetFormatPreflight> {
  if (blob.size < SPZ_HEADER_BYTES) {
    throw new RealityAssetError("invalid_format", "SPZ header is truncated");
  }
  const header = await readBlobRange(blob, 0, SPZ_HEADER_BYTES, signal);
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (headerView.getUint32(0, true) !== SPZ_MAGIC) {
    throw new RealityAssetError("invalid_format", "SPZ magic is invalid");
  }
  if (headerView.getUint32(4, true) !== SPZ_VERSION) {
    throw new RealityAssetError("unsupported_format", "Only SPZ version 4 is accepted");
  }
  const splatCount = headerView.getUint32(8, true);
  if (splatCount === 0) throw new RealityAssetError("invalid_format", "SPZ contains no splats");
  if (splatCount > REALITY_ASSET_LIMITS.maximumSplatCount) {
    throw new RealityAssetError("splat_limit_exceeded", `SPZ exceeds the ${REALITY_ASSET_LIMITS.maximumSplatCount} splat limit`);
  }
  const sphericalHarmonicsDegree = header[12] ?? 255;
  if (sphericalHarmonicsDegree > 4) {
    throw new RealityAssetError("invalid_format", "SPZ spherical-harmonics degree is invalid");
  }
  const fractionalBits = header[13] ?? 255;
  if (fractionalBits > 24) {
    throw new RealityAssetError("invalid_format", "SPZ fractional-bit count is invalid");
  }
  const flags = header[14] ?? 0;
  if ((flags & ~(SPZ_FLAG_ANTIALIASED | SPZ_FLAG_EXTENSIONS)) !== 0) {
    throw new RealityAssetError("invalid_format", "SPZ contains unsupported header flags");
  }
  const numberOfStreams = header[15] ?? 0;
  const expectedSizes = expectedStreamSizes(splatCount, sphericalHarmonicsDegree);
  if (numberOfStreams !== expectedSizes.length) {
    throw new RealityAssetError("invalid_format", "SPZ attribute stream count is invalid");
  }
  const tocOffset = headerView.getUint32(16, true);
  if (tocOffset < SPZ_HEADER_BYTES || tocOffset > REALITY_ASSET_LIMITS.maximumHeaderBytes) {
    throw new RealityAssetError("invalid_format", "SPZ table-of-contents offset is invalid");
  }
  for (let index = 20; index < SPZ_HEADER_BYTES; index += 1) {
    if (header[index] !== 0) throw new RealityAssetError("invalid_format", "SPZ reserved header bytes must be zero");
  }
  const tocEnd = checkedAdd(tocOffset, numberOfStreams * 16, "SPZ table size overflowed");
  if (tocEnd > blob.size) throw new RealityAssetError("invalid_format", "SPZ table of contents is truncated");
  const plaintext = await readBlobRange(blob, SPZ_HEADER_BYTES, tocEnd, signal);
  const extensionLength = tocOffset - SPZ_HEADER_BYTES;
  const extensions = inspectExtensions(plaintext.subarray(0, extensionLength), flags);
  const toc = plaintext.subarray(extensionLength);
  const tocView = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);
  let compressedTotal = 0;
  let expandedTotal = 0;
  const compressedSizes: number[] = [];
  for (let index = 0; index < numberOfStreams; index += 1) {
    const compressedSize = boundedUint64(tocView, index * 16, blob.size, "SPZ compressed stream is too large");
    const expandedSize = boundedUint64(
      tocView,
      index * 16 + 8,
      REALITY_ASSET_LIMITS.maximumExpandedBytes,
      "SPZ expanded stream is too large",
    );
    if (compressedSize < 4 || expandedSize !== expectedSizes[index]) {
      throw new RealityAssetError("invalid_format", "SPZ attribute stream sizes are inconsistent");
    }
    compressedSizes.push(compressedSize);
    compressedTotal = checkedAdd(compressedTotal, compressedSize, "SPZ compressed sizes overflowed");
    expandedTotal = checkedAdd(expandedTotal, expandedSize, "SPZ expanded sizes overflowed");
    if (expandedTotal > REALITY_ASSET_LIMITS.maximumExpandedBytes) {
      throw new RealityAssetError("expanded_limit_exceeded", "SPZ expanded payload exceeds its memory budget");
    }
  }
  if (compressedTotal !== blob.size - tocEnd) {
    throw new RealityAssetError("invalid_format", "SPZ compressed streams do not match the file boundary");
  }
  if (expandedTotal > compressedTotal * 1024) {
    throw new RealityAssetError("invalid_format", "SPZ claims an implausible compression ratio");
  }
  let streamOffset = tocEnd;
  for (const compressedSize of compressedSizes) {
    const magic = await readBlobRange(blob, streamOffset, streamOffset + 4, signal);
    if (magic[0] !== 0x28 || magic[1] !== 0xb5 || magic[2] !== 0x2f || magic[3] !== 0xfd) {
      throw new RealityAssetError("invalid_format", "SPZ attribute stream is not a Zstandard frame");
    }
    streamOffset += compressedSize;
  }

  return Object.freeze({
    format: "spz-v4",
    formatVersion: 4,
    mediaType: "application/x-spz",
    splatCount,
    sphericalHarmonicsDegree: sphericalHarmonicsDegree as 0 | 1 | 2 | 3 | 4,
    model: "gaussian-3d",
    antialiased: (flags & SPZ_FLAG_ANTIALIASED) !== 0,
    coordinateSystem: Object.freeze({
      system: extensions.coordinateSystem,
      provenance: extensions.coordinateProvenance,
    }),
    warnings: Object.freeze([
      ...extensions.warnings,
      "source_units_unknown",
      "compressed_payload_not_decoded",
    ] as const),
  });
}
