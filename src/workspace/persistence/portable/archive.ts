import {
  PORTABLE_PROJECT_LIMITS,
  PORTABLE_PROJECT_MEDIA_TYPE,
} from "./constants";
import { crc32Blob, IncrementalCrc32, readPortableBlobRange } from "./crc32";
import { PortableProjectError, throwIfPortableProjectAborted } from "./errors";

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP32_MAX = 0xffffffff;
const ZIP16_MAX = 0xffff;
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
const DOS_TIME_MIDNIGHT = 0;
const DOS_DATE_1980_01_01 = 33;
const VERSION_ZIP32 = 20;
const VERSION_ZIP64 = 45;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type PortableArchiveSourceEntry = Readonly<{
  path: string;
  blob: Blob;
  crc32: number;
}>;

export type PortableArchiveEntry = Readonly<{
  path: string;
  crc32: number;
  byteLength: number;
  localHeaderOffset: number;
  dataOffset: number;
  dataEnd: number;
}>;

export type PortableArchiveLayout = Readonly<{
  byteLength: number;
  zip64: boolean;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entries: readonly PortableArchiveEntry[];
}>;

type PlannedEntry = PortableArchiveSourceEntry & Readonly<{
  nameBytes: Uint8Array;
  localHeaderOffset: number;
  dataOffset: number;
  dataEnd: number;
  zip64Offset: boolean;
  centralHeaderLength: number;
}>;

export type PortableArchivePlan = Readonly<{
  entries: readonly PlannedEntry[];
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  zip64: boolean;
  byteLength: number;
}>;

function checkedAdd(left: number, right: number, message: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) {
    throw new PortableProjectError("size_limit_exceeded", message);
  }
  return result;
}

function boundedUint64(view: DataView, offset: number, maximum: number, message: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(maximum)) throw new PortableProjectError("size_limit_exceeded", message);
  return Number(value);
}

function writeUint64(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PortableProjectError("size_limit_exceeded", "Portable ZIP64 value is outside the safe integer range");
  }
  view.setBigUint64(offset, BigInt(value), true);
}

export function assertPortableArchivePath(path: string): void {
  const bytes = encoder.encode(path);
  if (
    path.length === 0
    || bytes.byteLength > PORTABLE_PROJECT_LIMITS.maximumPathBytes
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || path.includes(":")
    || path.normalize("NFC") !== path
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || !/^[a-z0-9._/-]+$/.test(path)
  ) {
    throw new PortableProjectError("invalid_path", `Portable archive entry path is unsafe: ${path}`);
  }
}

function validateSources(entries: readonly PortableArchiveSourceEntry[]): void {
  if (entries.length < 2 || entries.length > PORTABLE_PROJECT_LIMITS.maximumEntries) {
    throw new PortableProjectError("size_limit_exceeded", "Portable archive entry count is outside the supported range");
  }
  const paths = new Set<string>();
  const folded = new Set<string>();
  for (const entry of entries) {
    assertPortableArchivePath(entry.path);
    const lower = entry.path.toLowerCase();
    if (paths.has(entry.path) || folded.has(lower)) {
      throw new PortableProjectError("duplicate_entry", `Portable archive repeats entry ${entry.path}`);
    }
    paths.add(entry.path);
    folded.add(lower);
    if (!Number.isSafeInteger(entry.blob.size) || entry.blob.size < 1 || entry.blob.size > PORTABLE_PROJECT_LIMITS.maximumAssetBytes) {
      throw new PortableProjectError("size_limit_exceeded", `Portable archive entry ${entry.path} is too large`);
    }
    if (!Number.isInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > ZIP32_MAX) {
      throw new PortableProjectError("archive_corrupt", `Portable archive entry ${entry.path} has an invalid CRC`);
    }
  }
}

export function planPortableArchive(entries: readonly PortableArchiveSourceEntry[]): PortableArchivePlan {
  validateSources(entries);
  const planned: PlannedEntry[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const dataOffset = checkedAdd(offset, 30 + nameBytes.byteLength, "Portable archive local header overflowed");
    const dataEnd = checkedAdd(dataOffset, entry.blob.size, "Portable archive entry range overflowed");
    const zip64Offset = offset > ZIP32_MAX;
    const centralHeaderLength = 46 + nameBytes.byteLength + (zip64Offset ? 12 : 0);
    centralSize = checkedAdd(centralSize, centralHeaderLength, "Portable archive central directory overflowed");
    planned.push(Object.freeze({
      ...entry,
      nameBytes,
      localHeaderOffset: offset,
      dataOffset,
      dataEnd,
      zip64Offset,
      centralHeaderLength,
    }));
    offset = dataEnd;
  }
  if (centralSize > PORTABLE_PROJECT_LIMITS.maximumCentralDirectoryBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Portable archive central directory is too large");
  }
  const centralOffset = offset;
  const centralEnd = checkedAdd(centralOffset, centralSize, "Portable archive central directory range overflowed");
  const zip64 = planned.some((entry) => entry.zip64Offset)
    || centralOffset > ZIP32_MAX
    || centralSize > ZIP32_MAX;
  const byteLength = checkedAdd(centralEnd, zip64 ? 98 : 22, "Portable archive length overflowed");
  if (byteLength > PORTABLE_PROJECT_LIMITS.maximumBundleBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Portable archive exceeds the supported bundle size");
  }
  return Object.freeze({
    entries: Object.freeze(planned),
    centralDirectoryOffset: centralOffset,
    centralDirectorySize: centralSize,
    zip64,
    byteLength,
  });
}

function localHeader(entry: PlannedEntry): Uint8Array {
  const header = new Uint8Array(30 + entry.nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_LOCAL_SIGNATURE, true);
  view.setUint16(4, VERSION_ZIP32, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, STORED_METHOD, true);
  view.setUint16(10, DOS_TIME_MIDNIGHT, true);
  view.setUint16(12, DOS_DATE_1980_01_01, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.blob.size, true);
  view.setUint32(22, entry.blob.size, true);
  view.setUint16(26, entry.nameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(entry.nameBytes, 30);
  return header;
}

function centralHeader(entry: PlannedEntry): Uint8Array {
  const extraLength = entry.zip64Offset ? 12 : 0;
  const version = entry.zip64Offset ? VERSION_ZIP64 : VERSION_ZIP32;
  const header = new Uint8Array(46 + entry.nameBytes.byteLength + extraLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_CENTRAL_SIGNATURE, true);
  view.setUint16(4, version, true);
  view.setUint16(6, version, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, STORED_METHOD, true);
  view.setUint16(12, DOS_TIME_MIDNIGHT, true);
  view.setUint16(14, DOS_DATE_1980_01_01, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.blob.size, true);
  view.setUint32(24, entry.blob.size, true);
  view.setUint16(28, entry.nameBytes.byteLength, true);
  view.setUint16(30, extraLength, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.zip64Offset ? ZIP32_MAX : entry.localHeaderOffset, true);
  header.set(entry.nameBytes, 46);
  if (entry.zip64Offset) {
    const extraOffset = 46 + entry.nameBytes.byteLength;
    view.setUint16(extraOffset, ZIP64_EXTRA_ID, true);
    view.setUint16(extraOffset + 2, 8, true);
    writeUint64(view, extraOffset + 4, entry.localHeaderOffset);
  }
  return header;
}

function endRecords(plan: PortableArchivePlan): Uint8Array {
  if (!plan.zip64) {
    const record = new Uint8Array(22);
    const view = new DataView(record.buffer);
    view.setUint32(0, ZIP_END_SIGNATURE, true);
    view.setUint16(8, plan.entries.length, true);
    view.setUint16(10, plan.entries.length, true);
    view.setUint32(12, plan.centralDirectorySize, true);
    view.setUint32(16, plan.centralDirectoryOffset, true);
    return record;
  }
  const records = new Uint8Array(98);
  const view = new DataView(records.buffer);
  view.setUint32(0, ZIP64_END_SIGNATURE, true);
  writeUint64(view, 4, 44);
  view.setUint16(12, VERSION_ZIP64, true);
  view.setUint16(14, VERSION_ZIP64, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  writeUint64(view, 24, plan.entries.length);
  writeUint64(view, 32, plan.entries.length);
  writeUint64(view, 40, plan.centralDirectorySize);
  writeUint64(view, 48, plan.centralDirectoryOffset);
  view.setUint32(56, ZIP64_LOCATOR_SIGNATURE, true);
  view.setUint32(60, 0, true);
  writeUint64(view, 64, plan.centralDirectoryOffset + plan.centralDirectorySize);
  view.setUint32(72, 1, true);
  view.setUint32(76, ZIP_END_SIGNATURE, true);
  view.setUint16(84, ZIP16_MAX, true);
  view.setUint16(86, ZIP16_MAX, true);
  view.setUint32(88, ZIP32_MAX, true);
  view.setUint32(92, ZIP32_MAX, true);
  return records;
}

async function* archiveChunks(plan: PortableArchivePlan, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  for (const entry of plan.entries) {
    throwIfPortableProjectAborted(signal);
    yield localHeader(entry);
    const crc = new IncrementalCrc32();
    let total = 0;
    for (let offset = 0; offset < entry.blob.size; offset += PORTABLE_PROJECT_LIMITS.ioChunkBytes) {
      const end = Math.min(entry.blob.size, offset + PORTABLE_PROJECT_LIMITS.ioChunkBytes);
      const bytes = await readPortableBlobRange(entry.blob, offset, end, signal);
      crc.update(bytes);
      total += bytes.byteLength;
      yield bytes;
    }
    if (total !== entry.blob.size || crc.value() !== entry.crc32) {
      throw new PortableProjectError("asset_corrupt", `Portable source changed while streaming ${entry.path}`);
    }
  }
  for (const entry of plan.entries) {
    throwIfPortableProjectAborted(signal);
    yield centralHeader(entry);
  }
  throwIfPortableProjectAborted(signal);
  yield endRecords(plan);
}

export function streamPortableArchive(
  plan: PortableArchivePlan,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = archiveChunks(plan, signal);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined).catch(() => undefined);
    },
  });
}

export async function materializePortableArchive(
  plan: PortableArchivePlan,
  options: Readonly<{ signal?: AbortSignal; maximumBytes?: number }> = {},
): Promise<Blob> {
  const maximumBytes = options.maximumBytes ?? PORTABLE_PROJECT_LIMITS.defaultMaximumMaterializedBytes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || plan.byteLength > maximumBytes) {
    throw new PortableProjectError(
      "size_limit_exceeded",
      "Portable archive is too large to materialize; stream it to a file instead",
    );
  }
  const reader = streamPortableArchive(plan, options.signal).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total = checkedAdd(total, next.value.byteLength, "Portable archive materialization overflowed");
      if (total > maximumBytes) {
        throw new PortableProjectError("size_limit_exceeded", "Portable archive exceeded its materialization budget");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== plan.byteLength) {
    throw new PortableProjectError("archive_corrupt", "Portable archive writer produced an unexpected length");
  }
  return new Blob(chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer), {
    type: PORTABLE_PROJECT_MEDIA_TYPE,
  });
}

function decodePath(bytes: Uint8Array): string {
  let path: string;
  try {
    path = decoder.decode(bytes);
  } catch (error) {
    throw new PortableProjectError("invalid_path", "Portable archive entry path is not valid UTF-8", { cause: error });
  }
  assertPortableArchivePath(path);
  return path;
}

type EndDirectory = Readonly<{
  entryCount: number;
  centralOffset: number;
  centralSize: number;
  zip64: boolean;
}>;

async function readEndDirectory(blob: Blob, signal?: AbortSignal): Promise<EndDirectory> {
  if (blob.size < 22 || blob.size > PORTABLE_PROJECT_LIMITS.maximumBundleBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Portable archive size is outside the supported range");
  }
  const endOffset = blob.size - 22;
  const endBytes = await readPortableBlobRange(blob, endOffset, blob.size, signal);
  const end = new DataView(endBytes.buffer, endBytes.byteOffset, endBytes.byteLength);
  if (end.getUint32(0, true) !== ZIP_END_SIGNATURE || end.getUint16(20, true) !== 0) {
    throw new PortableProjectError("archive_corrupt", "Portable ZIP end record is missing or has a comment");
  }
  if (end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0) {
    throw new PortableProjectError("unsupported_archive", "Multi-disk portable archives are not supported");
  }
  const diskEntries = end.getUint16(8, true);
  const entryCount = end.getUint16(10, true);
  const centralSize32 = end.getUint32(12, true);
  const centralOffset32 = end.getUint32(16, true);
  const zip64 = diskEntries === ZIP16_MAX
    || entryCount === ZIP16_MAX
    || centralSize32 === ZIP32_MAX
    || centralOffset32 === ZIP32_MAX;
  let resolvedEntries: number;
  let centralSize: number;
  let centralOffset: number;
  if (!zip64) {
    if (diskEntries !== entryCount) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP entry counts disagree");
    }
    resolvedEntries = entryCount;
    centralSize = centralSize32;
    centralOffset = centralOffset32;
    if (checkedAdd(centralOffset, centralSize, "Portable central directory range overflowed") !== endOffset) {
      throw new PortableProjectError("archive_corrupt", "Portable central directory boundary is invalid");
    }
  } else {
    if (
      diskEntries !== ZIP16_MAX
      || entryCount !== ZIP16_MAX
      || centralSize32 !== ZIP32_MAX
      || centralOffset32 !== ZIP32_MAX
      || endOffset < 76
    ) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP64 sentinel fields are inconsistent");
    }
    const locatorOffset = endOffset - 20;
    const locatorBytes = await readPortableBlobRange(blob, locatorOffset, endOffset, signal);
    const locator = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, locatorBytes.byteLength);
    if (
      locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE
      || locator.getUint32(4, true) !== 0
      || locator.getUint32(16, true) !== 1
    ) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP64 locator is invalid");
    }
    const zip64Offset = boundedUint64(locator, 8, blob.size, "Portable ZIP64 end offset is too large");
    if (checkedAdd(zip64Offset, 56, "Portable ZIP64 end range overflowed") !== locatorOffset) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP64 records are not contiguous");
    }
    const zip64Bytes = await readPortableBlobRange(blob, zip64Offset, locatorOffset, signal);
    const record = new DataView(zip64Bytes.buffer, zip64Bytes.byteOffset, zip64Bytes.byteLength);
    if (
      record.getUint32(0, true) !== ZIP64_END_SIGNATURE
      || boundedUint64(record, 4, 44, "Portable ZIP64 end record is too large") !== 44
      || record.getUint16(12, true) !== VERSION_ZIP64
      || record.getUint16(14, true) !== VERSION_ZIP64
      || record.getUint32(16, true) !== 0
      || record.getUint32(20, true) !== 0
    ) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP64 end record is invalid");
    }
    const diskCount = boundedUint64(record, 24, PORTABLE_PROJECT_LIMITS.maximumEntries, "Portable ZIP64 entry count is too large");
    resolvedEntries = boundedUint64(record, 32, PORTABLE_PROJECT_LIMITS.maximumEntries, "Portable ZIP64 entry count is too large");
    if (diskCount !== resolvedEntries) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP64 entry counts disagree");
    }
    centralSize = boundedUint64(
      record,
      40,
      PORTABLE_PROJECT_LIMITS.maximumCentralDirectoryBytes,
      "Portable ZIP64 central directory is too large",
    );
    centralOffset = boundedUint64(record, 48, blob.size, "Portable ZIP64 central offset is too large");
    if (checkedAdd(centralOffset, centralSize, "Portable ZIP64 central range overflowed") !== zip64Offset) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP64 central directory boundary is invalid");
    }
  }
  if (resolvedEntries < 2 || resolvedEntries > PORTABLE_PROJECT_LIMITS.maximumEntries) {
    throw new PortableProjectError("size_limit_exceeded", "Portable archive entry count is outside the supported range");
  }
  if (centralSize < resolvedEntries * 47 || centralSize > PORTABLE_PROJECT_LIMITS.maximumCentralDirectoryBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Portable central directory size is outside the supported range");
  }
  return Object.freeze({ entryCount: resolvedEntries, centralOffset, centralSize, zip64 });
}

type CentralEntry = Readonly<{
  path: string;
  crc32: number;
  byteLength: number;
  localHeaderOffset: number;
}>;

function parseCentralDirectory(bytes: Uint8Array, expectedCount: number, centralOffset: number): readonly CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: CentralEntry[] = [];
  const paths = new Set<string>();
  const folded = new Set<string>();
  let offset = 0;
  for (let index = 0; index < expectedCount; index += 1) {
    if (bytes.byteLength - offset < 46 || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new PortableProjectError("archive_corrupt", "Portable central directory is truncated");
    }
    const versionMadeBy = view.getUint16(offset + 4, true);
    const versionNeeded = view.getUint16(offset + 6, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const time = view.getUint16(offset + 12, true);
    const date = view.getUint16(offset + 14, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const internalAttributes = view.getUint16(offset + 36, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset32 = view.getUint32(offset + 42, true);
    if (
      flags !== UTF8_FLAG
      || method !== STORED_METHOD
      || time !== DOS_TIME_MIDNIGHT
      || date !== DOS_DATE_1980_01_01
      || diskStart !== 0
      || internalAttributes !== 0
      || externalAttributes !== 0
      || commentLength !== 0
      || compressedSize !== uncompressedSize
      || compressedSize > PORTABLE_PROJECT_LIMITS.maximumAssetBytes
      || nameLength < 1
      || nameLength > PORTABLE_PROJECT_LIMITS.maximumPathBytes
    ) {
      throw new PortableProjectError("unsupported_archive", "Portable ZIP entry uses unsupported or unsafe features");
    }
    const zip64Offset = localOffset32 === ZIP32_MAX;
    const expectedVersion = zip64Offset ? VERSION_ZIP64 : VERSION_ZIP32;
    if (versionMadeBy !== expectedVersion || versionNeeded !== expectedVersion || extraLength !== (zip64Offset ? 12 : 0)) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP entry version or extra data is inconsistent");
    }
    const end = checkedAdd(
      offset + 46,
      nameLength + extraLength,
      "Portable central entry length overflowed",
    );
    if (end > bytes.byteLength) {
      throw new PortableProjectError("archive_corrupt", "Portable central directory entry is truncated");
    }
    const path = decodePath(bytes.slice(offset + 46, offset + 46 + nameLength));
    const lower = path.toLowerCase();
    if (paths.has(path) || folded.has(lower)) {
      throw new PortableProjectError("duplicate_entry", `Portable archive repeats entry ${path}`);
    }
    paths.add(path);
    folded.add(lower);
    let localHeaderOffset = localOffset32;
    if (zip64Offset) {
      const extraOffset = offset + 46 + nameLength;
      if (
        view.getUint16(extraOffset, true) !== ZIP64_EXTRA_ID
        || view.getUint16(extraOffset + 2, true) !== 8
      ) {
        throw new PortableProjectError("archive_corrupt", "Portable ZIP64 offset field is invalid");
      }
      localHeaderOffset = boundedUint64(
        view,
        extraOffset + 4,
        centralOffset,
        "Portable ZIP64 local offset is too large",
      );
    }
    entries.push(Object.freeze({
      path,
      crc32: checksum,
      byteLength: uncompressedSize,
      localHeaderOffset,
    }));
    offset = end;
  }
  if (offset !== bytes.byteLength) {
    throw new PortableProjectError("archive_corrupt", "Portable central directory has trailing bytes");
  }
  return Object.freeze(entries);
}

async function resolveLocalEntries(
  blob: Blob,
  centralEntries: readonly CentralEntry[],
  centralOffset: number,
  signal?: AbortSignal,
): Promise<readonly PortableArchiveEntry[]> {
  const entries: PortableArchiveEntry[] = [];
  let expectedOffset = 0;
  for (const central of centralEntries) {
    if (central.localHeaderOffset !== expectedOffset) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP local entries contain gaps or are out of order");
    }
    const fixedEnd = checkedAdd(central.localHeaderOffset, 30, "Portable local header range overflowed");
    if (fixedEnd > centralOffset) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP local header overlaps its central directory");
    }
    const fixedBytes = await readPortableBlobRange(blob, central.localHeaderOffset, fixedEnd, signal);
    const fixed = new DataView(fixedBytes.buffer, fixedBytes.byteOffset, fixedBytes.byteLength);
    if (
      fixed.getUint32(0, true) !== ZIP_LOCAL_SIGNATURE
      || fixed.getUint16(4, true) !== VERSION_ZIP32
      || fixed.getUint16(6, true) !== UTF8_FLAG
      || fixed.getUint16(8, true) !== STORED_METHOD
      || fixed.getUint16(10, true) !== DOS_TIME_MIDNIGHT
      || fixed.getUint16(12, true) !== DOS_DATE_1980_01_01
      || fixed.getUint32(14, true) !== central.crc32
      || fixed.getUint32(18, true) !== central.byteLength
      || fixed.getUint32(22, true) !== central.byteLength
      || fixed.getUint16(28, true) !== 0
    ) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP local and central headers disagree");
    }
    const nameLength = fixed.getUint16(26, true);
    if (nameLength < 1 || nameLength > PORTABLE_PROJECT_LIMITS.maximumPathBytes) {
      throw new PortableProjectError("invalid_path", "Portable ZIP local entry path length is invalid");
    }
    const nameEnd = checkedAdd(fixedEnd, nameLength, "Portable local entry name overflowed");
    if (nameEnd > centralOffset) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP local entry name is truncated");
    }
    const name = decodePath(await readPortableBlobRange(blob, fixedEnd, nameEnd, signal));
    if (name !== central.path) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP local and central entry names disagree");
    }
    const dataEnd = checkedAdd(nameEnd, central.byteLength, "Portable ZIP entry data range overflowed");
    if (dataEnd > centralOffset) {
      throw new PortableProjectError("archive_corrupt", "Portable ZIP entry overlaps its central directory");
    }
    entries.push(Object.freeze({
      ...central,
      dataOffset: nameEnd,
      dataEnd,
    }));
    expectedOffset = dataEnd;
  }
  if (expectedOffset !== centralOffset) {
    throw new PortableProjectError("archive_corrupt", "Portable ZIP contains hidden bytes before its central directory");
  }
  return Object.freeze(entries);
}

export async function inspectPortableArchive(
  blob: Blob,
  signal?: AbortSignal,
): Promise<PortableArchiveLayout> {
  throwIfPortableProjectAborted(signal);
  const end = await readEndDirectory(blob, signal);
  const centralBytes = await readPortableBlobRange(
    blob,
    end.centralOffset,
    end.centralOffset + end.centralSize,
    signal,
  );
  const central = parseCentralDirectory(centralBytes, end.entryCount, end.centralOffset);
  const entries = await resolveLocalEntries(blob, central, end.centralOffset, signal);
  return Object.freeze({
    byteLength: blob.size,
    zip64: end.zip64,
    centralDirectoryOffset: end.centralOffset,
    centralDirectorySize: end.centralSize,
    entries,
  });
}

export function portableArchiveEntryBlob(blob: Blob, entry: PortableArchiveEntry, mediaType = ""): Blob {
  if (entry.dataOffset < 0 || entry.dataEnd > blob.size || entry.dataEnd - entry.dataOffset !== entry.byteLength) {
    throw new PortableProjectError("archive_corrupt", `Portable entry ${entry.path} has an invalid byte range`);
  }
  return blob.slice(entry.dataOffset, entry.dataEnd, mediaType);
}

export async function verifyPortableArchiveEntryCrc(
  blob: Blob,
  entry: PortableArchiveEntry,
  signal?: AbortSignal,
): Promise<Blob> {
  const entryBlob = portableArchiveEntryBlob(blob, entry);
  const actual = await crc32Blob(entryBlob, { signal });
  if (actual !== entry.crc32) {
    throw new PortableProjectError("archive_corrupt", `Portable entry ${entry.path} failed its CRC check`);
  }
  return entryBlob;
}
