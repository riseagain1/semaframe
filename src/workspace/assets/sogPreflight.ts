import { checkedAdd, readBlobRange } from "./blobIO";
import { RealityAssetError, throwIfRealityAssetAborted } from "./errors";
import type { RealityAssetFormatPreflight } from "./formatTypes";
import { REALITY_ASSET_LIMITS } from "./limits";

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

type ZipEntry = Readonly<{
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  compressionMethod: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset?: number;
}>;

function decodeEntryName(bytes: Uint8Array): string {
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new RealityAssetError("invalid_format", "SOG contains an invalid ZIP entry name", { cause: error });
  }
  if (
    name.length === 0
    || name.includes("\0")
    || name.includes("\\")
    || name.includes("/")
    || name === "."
    || name === ".."
    || name.includes(":")
  ) {
    throw new RealityAssetError("invalid_format", "SOG ZIP entries must be safe root-relative files");
  }
  return name;
}

async function findEndOfCentralDirectory(blob: Blob, signal?: AbortSignal): Promise<Readonly<{
  entryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  eocdOffset: number;
}>> {
  const maximumTail = 22 + 0xffff;
  const tailStart = Math.max(0, blob.size - maximumTail);
  const tail = await readBlobRange(blob, tailStart, blob.size, signal);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength !== tail.byteLength) continue;
    const disk = view.getUint16(offset + 4, true);
    const centralDisk = view.getUint16(offset + 6, true);
    const diskEntries = view.getUint16(offset + 8, true);
    const entryCount = view.getUint16(offset + 10, true);
    const centralDirectorySize = view.getUint32(offset + 12, true);
    const centralDirectoryOffset = view.getUint32(offset + 16, true);
    if (
      disk !== 0
      || centralDisk !== 0
      || diskEntries !== entryCount
      || entryCount === ZIP64_SENTINEL_16
      || centralDirectorySize === ZIP64_SENTINEL_32
      || centralDirectoryOffset === ZIP64_SENTINEL_32
    ) {
      throw new RealityAssetError("unsupported_format", "SOG multi-disk and ZIP64 archives are not accepted");
    }
    if (entryCount < 2 || entryCount > REALITY_ASSET_LIMITS.maximumZipEntries) {
      throw new RealityAssetError("invalid_format", "SOG ZIP entry count is outside the allowed range");
    }
    if (centralDirectorySize > REALITY_ASSET_LIMITS.maximumZipCentralDirectoryBytes) {
      throw new RealityAssetError("invalid_format", "SOG ZIP central directory is too large");
    }
    const eocdOffset = tailStart + offset;
    if (centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
      throw new RealityAssetError("invalid_format", "SOG ZIP central directory boundaries are invalid");
    }
    return Object.freeze({ entryCount, centralDirectoryOffset, centralDirectorySize, eocdOffset });
  }
  throw new RealityAssetError("invalid_format", "SOG ZIP end record is missing");
}

function parseCentralDirectory(bytes: Uint8Array, expectedEntries: number): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  let expandedTotal = 0;
  for (let index = 0; index < expectedEntries; index += 1) {
    if (bytes.byteLength - offset < 46 || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new RealityAssetError("invalid_format", "SOG ZIP central directory is truncated");
    }
    const flags = view.getUint16(offset + 8, true);
    if ((flags & 0x2041) !== 0) throw new RealityAssetError("unsupported_format", "Encrypted SOG archives are not accepted");
    const compressionMethod = view.getUint16(offset + 10, true);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new RealityAssetError("unsupported_compression", "SOG ZIP compression method is not supported");
    }
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (
      compressedSize === ZIP64_SENTINEL_32
      || uncompressedSize === ZIP64_SENTINEL_32
      || localHeaderOffset === ZIP64_SENTINEL_32
      || diskStart !== 0
    ) {
      throw new RealityAssetError("unsupported_format", "SOG ZIP64 entries are not accepted");
    }
    if (
      nameLength < 1
      || nameLength > REALITY_ASSET_LIMITS.maximumZipEntryNameBytes
      || extraLength > REALITY_ASSET_LIMITS.maximumZipExtraBytes
      || commentLength > REALITY_ASSET_LIMITS.maximumZipCommentBytes
    ) {
      throw new RealityAssetError("invalid_format", "SOG ZIP entry metadata is too large");
    }
    const entryEnd = checkedAdd(offset + 46, nameLength + extraLength + commentLength, "SOG ZIP entry length overflowed");
    if (entryEnd > bytes.byteLength) throw new RealityAssetError("invalid_format", "SOG ZIP entry is truncated");
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
    const name = decodeEntryName(nameBytes);
    if (names.has(name)) throw new RealityAssetError("invalid_format", "SOG ZIP contains duplicate entry names");
    names.add(name);
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType === 0xa000) throw new RealityAssetError("unsupported_format", "SOG ZIP symbolic links are not accepted");
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      throw new RealityAssetError("invalid_format", "Stored SOG ZIP entry sizes do not match");
    }
    expandedTotal = checkedAdd(expandedTotal, uncompressedSize, "SOG expanded sizes overflowed");
    if (expandedTotal > REALITY_ASSET_LIMITS.maximumExpandedBytes) {
      throw new RealityAssetError("expanded_limit_exceeded", "SOG expanded payload exceeds its memory budget");
    }
    entries.push(Object.freeze({
      name,
      nameBytes,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    }));
    offset = entryEnd;
  }
  if (offset !== bytes.byteLength) {
    throw new RealityAssetError("invalid_format", "SOG ZIP central directory has trailing bytes");
  }
  return Object.freeze(entries);
}

async function validateLocalEntries(
  blob: Blob,
  entries: readonly ZipEntry[],
  centralDirectoryOffset: number,
  signal?: AbortSignal,
): Promise<readonly (ZipEntry & Required<Pick<ZipEntry, "dataOffset">>)[]> {
  const withOffsets: (ZipEntry & Required<Pick<ZipEntry, "dataOffset">>)[] = [];
  const ranges: Array<readonly [number, number]> = [];
  for (const entry of entries) {
    if (entry.localHeaderOffset + 30 > centralDirectoryOffset) {
      throw new RealityAssetError("invalid_format", "SOG ZIP local header boundary is invalid");
    }
    const localHeader = await readBlobRange(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30, signal);
    const view = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
    if (view.getUint32(0, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new RealityAssetError("invalid_format", "SOG ZIP local header is invalid");
    }
    if (view.getUint16(6, true) !== entry.flags || view.getUint16(8, true) !== entry.compressionMethod) {
      throw new RealityAssetError("invalid_format", "SOG ZIP local and central headers disagree");
    }
    const usesDataDescriptor = (entry.flags & 0x8) !== 0;
    const localCrc = view.getUint32(14, true);
    const localCompressedSize = view.getUint32(18, true);
    const localUncompressedSize = view.getUint32(22, true);
    if (
      (!usesDataDescriptor && (
        localCrc !== entry.crc32
        || localCompressedSize !== entry.compressedSize
        || localUncompressedSize !== entry.uncompressedSize
      ))
      || (usesDataDescriptor && (
        (localCrc !== 0 && localCrc !== entry.crc32)
        || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)
      ))
    ) {
      throw new RealityAssetError("invalid_format", "SOG ZIP local entry sizes disagree with its central record");
    }
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    if (nameLength !== entry.nameBytes.byteLength || extraLength > REALITY_ASSET_LIMITS.maximumZipExtraBytes) {
      throw new RealityAssetError("invalid_format", "SOG ZIP local entry metadata is invalid");
    }
    const metadataEnd = checkedAdd(entry.localHeaderOffset + 30, nameLength + extraLength, "SOG ZIP local entry overflowed");
    if (metadataEnd > centralDirectoryOffset) {
      throw new RealityAssetError("invalid_format", "SOG ZIP local entry is truncated");
    }
    const localName = await readBlobRange(blob, entry.localHeaderOffset + 30, entry.localHeaderOffset + 30 + nameLength, signal);
    if (localName.some((byte, index) => byte !== entry.nameBytes[index])) {
      throw new RealityAssetError("invalid_format", "SOG ZIP local entry name disagrees with its central record");
    }
    const dataEnd = checkedAdd(metadataEnd, entry.compressedSize, "SOG ZIP data boundary overflowed");
    if (dataEnd > centralDirectoryOffset) {
      throw new RealityAssetError("invalid_format", "SOG ZIP entry data extends beyond the archive body");
    }
    ranges.push([entry.localHeaderOffset, dataEnd]);
    withOffsets.push(Object.freeze({ ...entry, dataOffset: metadataEnd }));
  }
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]![0] < ranges[index - 1]![1]) {
      throw new RealityAssetError("invalid_format", "SOG ZIP entries overlap");
    }
  }
  return Object.freeze(withOffsets);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes: Uint8Array, expectedBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const Decompression = globalThis.DecompressionStream as unknown as
    | (new (format: string) => TransformStream<Uint8Array, Uint8Array>)
    | undefined;
  if (!Decompression) {
    throw new RealityAssetError("unsupported_compression", "Deflated SOG metadata is not supported in this browser");
  }
  let transform: TransformStream<Uint8Array, Uint8Array>;
  try {
    transform = new Decompression("deflate-raw");
  } catch (error) {
    throw new RealityAssetError("unsupported_compression", "Deflated SOG metadata is not supported in this browser", { cause: error });
  }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const input = source.pipeThrough(transform);
  const reader = input.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfRealityAssetAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      total = checkedAdd(total, next.value.byteLength, "SOG metadata expanded size overflowed");
      if (total > expectedBytes || total > REALITY_ASSET_LIMITS.maximumSogMetadataBytes) {
        throw new RealityAssetError("expanded_limit_exceeded", "SOG metadata exceeds its declared size");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RealityAssetError) throw error;
    throw new RealityAssetError("invalid_format", "SOG metadata could not be decompressed", { cause: error });
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedBytes) throw new RealityAssetError("invalid_format", "SOG metadata expanded size is inconsistent");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteArray(value: unknown, length: number, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new RealityAssetError("invalid_format", `SOG ${label} is invalid`);
  }
  return value as number[];
}

function fileArray(value: unknown, length: number, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== "string")) {
    throw new RealityAssetError("invalid_format", `SOG ${label} file list is invalid`);
  }
  return Object.freeze((value as string[]).map((name) => decodeEntryName(new TextEncoder().encode(name))));
}

type SogMetadataSummary = Readonly<{
  count: number;
  degree: 0 | 1 | 2 | 3;
  model: "gaussian-3d" | "gaussian-2d";
  antialiased: boolean | null;
  referencedFiles: readonly string[];
}>;

function parseSogMetadata(bytes: Uint8Array, availableEntries: ReadonlySet<string>): SogMetadataSummary {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new RealityAssetError("invalid_format", "SOG meta.json is invalid", { cause: error });
  }
  const meta = object(value);
  if (!meta || meta.version !== 2) throw new RealityAssetError("unsupported_format", "Only SOG metadata version 2 is accepted");
  if (!Number.isSafeInteger(meta.count) || (meta.count as number) < 1) {
    throw new RealityAssetError("invalid_format", "SOG splat count is invalid");
  }
  const count = meta.count as number;
  if (count > REALITY_ASSET_LIMITS.maximumSplatCount) {
    throw new RealityAssetError("splat_limit_exceeded", `SOG exceeds the ${REALITY_ASSET_LIMITS.maximumSplatCount} splat limit`);
  }
  if (meta.antialias !== undefined && typeof meta.antialias !== "boolean") {
    throw new RealityAssetError("invalid_format", "SOG antialias metadata is invalid");
  }
  if (meta.model !== undefined && !["antialiased", "2dgs", "default"].includes(String(meta.model))) {
    throw new RealityAssetError("invalid_format", "SOG model metadata is invalid");
  }
  const means = object(meta.means);
  const scales = object(meta.scales);
  const quats = object(meta.quats);
  const sh0 = object(meta.sh0);
  if (!means || !scales || !quats || !sh0) throw new RealityAssetError("invalid_format", "SOG property metadata is incomplete");
  const minimums = finiteArray(means.mins, 3, "means minimum");
  const maximums = finiteArray(means.maxs, 3, "means maximum");
  if (minimums.some((minimum, index) => minimum > maximums[index]!)) {
    throw new RealityAssetError("invalid_format", "SOG means ranges are invalid");
  }
  const referencedFiles = [
    ...fileArray(means.files, 2, "means"),
    ...fileArray(scales.files, 1, "scales"),
    ...fileArray(quats.files, 1, "quaternions"),
    ...fileArray(sh0.files, 1, "base color"),
  ];
  finiteArray(scales.codebook, 256, "scales codebook");
  finiteArray(sh0.codebook, 256, "base-color codebook");
  let degree: 0 | 1 | 2 | 3 = 0;
  if (meta.shN !== undefined) {
    const shN = object(meta.shN);
    if (
      !shN
      || !Number.isSafeInteger(shN.count)
      || (shN.count as number) < 1
      || (shN.count as number) > 65_536
      || !Number.isSafeInteger(shN.bands)
      || (shN.bands as number) < 1
      || (shN.bands as number) > 3
    ) {
      throw new RealityAssetError("invalid_format", "SOG higher-order SH metadata is invalid");
    }
    finiteArray(shN.codebook, 256, "higher-order SH codebook");
    referencedFiles.push(...fileArray(shN.files, 2, "higher-order SH"));
    degree = shN.bands as 1 | 2 | 3;
  }
  if (new Set(referencedFiles).size !== referencedFiles.length) {
    throw new RealityAssetError("invalid_format", "SOG metadata references a file more than once");
  }
  if (referencedFiles.some((name) => !availableEntries.has(name))) {
    // Missing names would otherwise be interpreted as external URLs by some
    // SOG runtimes. MVP imports are deliberately self-contained.
    throw new RealityAssetError("invalid_format", "SOG metadata references a file outside the bundle");
  }
  const allowedEntries = new Set(["meta.json", ...referencedFiles]);
  if ([...availableEntries].some((name) => !allowedEntries.has(name))) {
    throw new RealityAssetError("invalid_format", "SOG bundle contains unreferenced files");
  }
  return Object.freeze({
    count,
    degree,
    model: meta.model === "2dgs" ? "gaussian-2d" : "gaussian-3d",
    antialiased: meta.model === "antialiased" ? true : (meta.antialias as boolean | undefined) ?? null,
    referencedFiles: Object.freeze(referencedFiles),
  });
}

export async function preflightSogV2(blob: Blob, signal?: AbortSignal): Promise<RealityAssetFormatPreflight> {
  const end = await findEndOfCentralDirectory(blob, signal);
  const centralBytes = await readBlobRange(
    blob,
    end.centralDirectoryOffset,
    end.centralDirectoryOffset + end.centralDirectorySize,
    signal,
  );
  const entries = parseCentralDirectory(centralBytes, end.entryCount);
  const localEntries = await validateLocalEntries(blob, entries, end.centralDirectoryOffset, signal);
  const metaEntry = localEntries.find((entry) => entry.name === "meta.json");
  if (!metaEntry || metaEntry.uncompressedSize < 2 || metaEntry.uncompressedSize > REALITY_ASSET_LIMITS.maximumSogMetadataBytes) {
    throw new RealityAssetError("invalid_format", "SOG bundle must contain bounded meta.json metadata");
  }
  const compressedMetadata = await readBlobRange(
    blob,
    metaEntry.dataOffset,
    metaEntry.dataOffset + metaEntry.compressedSize,
    signal,
  );
  const metadata = metaEntry.compressionMethod === 0
    ? compressedMetadata
    : await inflateRaw(compressedMetadata, metaEntry.uncompressedSize, signal);
  if (metadata.byteLength !== metaEntry.uncompressedSize || crc32(metadata) !== metaEntry.crc32) {
    throw new RealityAssetError("invalid_format", "SOG meta.json checksum is invalid");
  }
  const summary = parseSogMetadata(metadata, new Set(localEntries.map((entry) => entry.name)));
  return Object.freeze({
    format: "sog-v2",
    formatVersion: 2,
    mediaType: "model/vnd.sog",
    splatCount: summary.count,
    sphericalHarmonicsDegree: summary.degree,
    model: summary.model,
    antialiased: summary.antialiased,
    coordinateSystem: Object.freeze({ system: "RUB", provenance: "format-default" }),
    warnings: Object.freeze([
      "source_units_unknown",
      "sog_image_dimensions_not_verified",
      "compressed_payload_not_decoded",
    ] as const),
  });
}
