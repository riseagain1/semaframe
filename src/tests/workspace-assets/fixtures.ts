export const PLY_PROPERTIES = [
  "x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2",
  "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2",
] as const;

export function asciiPly(rows: readonly (readonly number[])[]): Blob {
  const header = [
    "ply",
    "format ascii 1.0",
    `element vertex ${rows.length}`,
    ...PLY_PROPERTIES.map((name) => `property float ${name}`),
    "end_header",
    "",
  ].join("\n");
  return new Blob([header, rows.map((row) => row.join(" ")).join("\n")], { type: "text/plain" });
}

export function binaryPly(rows: readonly (readonly number[])[]): Blob {
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${rows.length}`,
    ...PLY_PROPERTIES.map((name) => `property float ${name}`),
    "end_header",
    "",
  ].join("\n");
  const body = new ArrayBuffer(rows.length * PLY_PROPERTIES.length * 4);
  const view = new DataView(body);
  rows.forEach((row, rowIndex) => row.forEach((value, valueIndex) => {
    view.setFloat32((rowIndex * PLY_PROPERTIES.length + valueIndex) * 4, value, true);
  }));
  return new Blob([header, body]);
}

function writeUint64(view: DataView, offset: number, value: number): void {
  view.setBigUint64(offset, BigInt(value), true);
}

export function spzV4(options: Readonly<{
  splatCount?: number;
  degree?: 0 | 1 | 2 | 3 | 4;
  flags?: number;
  extensionBytes?: Uint8Array;
}> = {}): Blob {
  const count = options.splatCount ?? 1;
  const degree = options.degree ?? 0;
  const extensionBytes = options.extensionBytes ?? new Uint8Array();
  const coefficientCount = degree === 0 ? 0 : (((degree + 1) ** 2) - 1) * 3;
  const expandedSizes = [count * 9, count, count * 3, count * 3, count * 4, count * coefficientCount]
    .filter((size) => size > 0);
  const tocOffset = 32 + extensionBytes.byteLength;
  const headerAndToc = new Uint8Array(tocOffset + expandedSizes.length * 16);
  const view = new DataView(headerAndToc.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, count, true);
  headerAndToc[12] = degree;
  headerAndToc[13] = 12;
  headerAndToc[14] = options.flags ?? (extensionBytes.byteLength > 0 ? 0x2 : 0);
  headerAndToc[15] = expandedSizes.length;
  view.setUint32(16, tocOffset, true);
  headerAndToc.set(extensionBytes, 32);
  expandedSizes.forEach((expanded, index) => {
    writeUint64(view, tocOffset + index * 16, 4);
    writeUint64(view, tocOffset + index * 16 + 8, expanded);
  });
  const streams = expandedSizes.map(() => new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]));
  return new Blob([headerAndToc, ...streams]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function storedZip(entries: readonly Readonly<{ name: string; bytes: Uint8Array }>[]): Blob {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.byteLength + entry.bytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc32(entry.bytes), true);
    localView.setUint32(18, entry.bytes.byteLength, true);
    localView.setUint32(22, entry.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc32(entry.bytes), true);
    centralView.setUint32(20, entry.bytes.byteLength, true);
    centralView.setUint32(24, entry.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centrals.push(central);
    localOffset += local.byteLength;
  }
  const localBytes = concat(locals);
  const centralBytes = concat(centrals);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralBytes.byteLength, true);
  endView.setUint32(16, localBytes.byteLength, true);
  return new Blob([localBytes.slice().buffer, centralBytes.slice().buffer, end.buffer]);
}

export function sogV2(
  mutate?: (metadata: Record<string, unknown>) => void,
  extraEntries: readonly Readonly<{ name: string; bytes: Uint8Array }>[] = [],
): Blob {
  const codebook = Array.from({ length: 256 }, () => 0);
  const metadata: Record<string, unknown> = {
    version: 2,
    count: 2,
    means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ["means_l.webp", "means_u.webp"] },
    scales: { codebook, files: ["scales.webp"] },
    quats: { files: ["quats.webp"] },
    sh0: { codebook, files: ["sh0.webp"] },
  };
  mutate?.(metadata);
  const entries = [
    { name: "meta.json", bytes: new TextEncoder().encode(JSON.stringify(metadata)) },
    { name: "means_l.webp", bytes: new Uint8Array([1]) },
    { name: "means_u.webp", bytes: new Uint8Array([2]) },
    { name: "scales.webp", bytes: new Uint8Array([3]) },
    { name: "quats.webp", bytes: new Uint8Array([4]) },
    { name: "sh0.webp", bytes: new Uint8Array([5]) },
    ...extraEntries,
  ];
  return storedZip(entries);
}

export const VALID_ROW = [
  0, 0, 0, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5,
] as const;
