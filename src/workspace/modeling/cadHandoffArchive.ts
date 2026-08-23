export type CadHandoffArchiveEntry = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

const encoder = new TextEncoder();
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
const DOS_TIME_MIDNIGHT = 0;
const DOS_DATE_1980_01_01 = 33;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertEntry(entry: CadHandoffArchiveEntry): void {
  if (!entry.path || entry.path.startsWith("/") || entry.path.includes("\\")) {
    throw new TypeError(`Archive entry path must be relative POSIX text: ${entry.path}`);
  }
  const segments = entry.path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`Archive entry path is unsafe: ${entry.path}`);
  }
  if (encoder.encode(entry.path).byteLength > 0xffff) {
    throw new RangeError(`Archive entry path is too long: ${entry.path}`);
  }
  if (entry.bytes.byteLength > 0xffffffff) {
    throw new RangeError(`Archive entry exceeds the ZIP32 limit: ${entry.path}`);
  }
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

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (length > 0xffffffff) throw new RangeError("CAD handoff archive exceeds the ZIP32 limit");
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function localHeader(name: Uint8Array, bytes: Uint8Array, checksum: number): Uint8Array {
  const header = new Uint8Array(30 + name.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, STORED_METHOD, true);
  view.setUint16(10, DOS_TIME_MIDNIGHT, true);
  view.setUint16(12, DOS_DATE_1980_01_01, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, bytes.byteLength, true);
  view.setUint32(22, bytes.byteLength, true);
  view.setUint16(26, name.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(name, 30);
  return header;
}

function centralHeader(
  name: Uint8Array,
  bytes: Uint8Array,
  checksum: number,
  localOffset: number,
): Uint8Array {
  const header = new Uint8Array(46 + name.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, STORED_METHOD, true);
  view.setUint16(12, DOS_TIME_MIDNIGHT, true);
  view.setUint16(14, DOS_DATE_1980_01_01, true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, bytes.byteLength, true);
  view.setUint32(24, bytes.byteLength, true);
  view.setUint16(28, name.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  header.set(name, 46);
  return header;
}

function endRecord(entryCount: number, centralSize: number, centralOffset: number): Uint8Array {
  if (entryCount > 0xffff) throw new RangeError("CAD handoff archive has too many files");
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return record;
}

/** Build a reproducible, UTF-8, uncompressed ZIP with a fixed 1980 timestamp. */
export function createDeterministicCadHandoffArchive(
  entries: readonly CadHandoffArchiveEntry[],
): Uint8Array {
  if (entries.length === 0) throw new TypeError("CAD handoff archive must contain files");
  const ordered = [...entries].sort((left, right) => compareText(left.path, right.path));
  const seen = new Set<string>();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of ordered) {
    assertEntry(entry);
    if (seen.has(entry.path)) throw new TypeError(`Duplicate archive entry: ${entry.path}`);
    seen.add(entry.path);
    const name = encoder.encode(entry.path);
    const checksum = crc32(entry.bytes);
    const local = localHeader(name, entry.bytes, checksum);
    const central = centralHeader(name, entry.bytes, checksum, localOffset);
    localChunks.push(local, entry.bytes);
    centralChunks.push(central);
    localOffset += local.byteLength + entry.bytes.byteLength;
  }
  const central = concatenate(centralChunks);
  return concatenate([
    ...localChunks,
    central,
    endRecord(ordered.length, central.byteLength, localOffset),
  ]);
}
