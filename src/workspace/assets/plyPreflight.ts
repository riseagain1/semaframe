import { checkedMultiply, readBlobRange } from "./blobIO";
import { RealityAssetError, throwIfRealityAssetAborted } from "./errors";
import type { RealityAssetFormatPreflight } from "./formatTypes";
import { REALITY_ASSET_LIMITS } from "./limits";
import type { RealityAssetBounds, RealityAssetModel } from "./types";

type PlyScalarType =
  | "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float32" | "float64";

type PlyProperty = Readonly<{
  name: string;
  type: PlyScalarType;
  byteOffset: number;
  byteLength: number;
}>;

type ParsedPlyHeader = Readonly<{
  bodyOffset: number;
  encoding: "ascii" | "binary_little_endian" | "binary_big_endian";
  splatCount: number;
  properties: readonly PlyProperty[];
  recordBytes: number;
  sphericalHarmonicsDegree: 0 | 1 | 2 | 3 | 4;
  model: RealityAssetModel;
  antialiased: boolean | null;
}>;

const TYPE_ALIASES: Readonly<Record<string, PlyScalarType>> = Object.freeze({
  char: "int8", int8: "int8",
  uchar: "uint8", uint8: "uint8",
  short: "int16", int16: "int16",
  ushort: "uint16", uint16: "uint16",
  int: "int32", int32: "int32",
  uint: "uint32", uint32: "uint32",
  float: "float32", float32: "float32",
  double: "float64", float64: "float64",
});

const TYPE_BYTES: Readonly<Record<PlyScalarType, number>> = Object.freeze({
  int8: 1, uint8: 1, int16: 2, uint16: 2,
  int32: 4, uint32: 4, float32: 4, float64: 8,
});

const REQUIRED_BASE_PROPERTIES = [
  "x", "y", "z", "opacity", "scale_0", "scale_1",
  "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2",
] as const;

function findPlyHeaderEnd(bytes: Uint8Array): number {
  const marker = new TextEncoder().encode("end_header");
  outer: for (let start = 0; start <= bytes.byteLength - marker.byteLength; start += 1) {
    for (let offset = 0; offset < marker.byteLength; offset += 1) {
      if (bytes[start + offset] !== marker[offset]) continue outer;
    }
    const before = start === 0 ? 0x0a : bytes[start - 1];
    const end = start + marker.byteLength;
    if (before !== 0x0a || end >= bytes.byteLength) continue;
    if (bytes[end] === 0x0a) return end + 1;
    if (bytes[end] === 0x0d && bytes[end + 1] === 0x0a) return end + 2;
  }
  return -1;
}

function parseNonnegativeInteger(value: string, label: string, maximum: number): number {
  if (!/^[0-9]+$/.test(value)) throw new RealityAssetError("invalid_format", `${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RealityAssetError("invalid_format", `${label} is invalid`);
  }
  if (parsed > maximum) {
    throw new RealityAssetError("splat_limit_exceeded", `${label} exceeds the allowed limit`);
  }
  return parsed;
}

function inferShDegree(propertyNames: Set<string>): 0 | 1 | 2 | 3 | 4 {
  const rest: number[] = [];
  for (const name of propertyNames) {
    const match = /^f_rest_([0-9]+)$/.exec(name);
    if (match) rest.push(Number(match[1]));
  }
  rest.sort((left, right) => left - right);
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== index) {
      throw new RealityAssetError("invalid_format", "PLY spherical-harmonics properties are not contiguous");
    }
  }
  const degreeByCount = new Map<number, 0 | 1 | 2 | 3 | 4>([
    [0, 0], [9, 1], [24, 2], [45, 3], [72, 4],
  ]);
  const degree = degreeByCount.get(rest.length);
  if (degree === undefined) {
    throw new RealityAssetError("invalid_format", "PLY spherical-harmonics property count is invalid");
  }
  return degree;
}

function parsePlyHeader(bytes: Uint8Array): ParsedPlyHeader {
  const bodyOffset = findPlyHeaderEnd(bytes);
  if (bodyOffset < 0) {
    throw new RealityAssetError("invalid_format", "PLY header is missing end_header within its size limit");
  }
  for (let index = 0; index < bodyOffset; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte > 0x7f || byte === 0) throw new RealityAssetError("invalid_format", "PLY header must be ASCII text");
  }
  const headerText = new TextDecoder().decode(bytes.subarray(0, bodyOffset));
  const lines = headerText.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "ply") throw new RealityAssetError("invalid_format", "PLY magic is invalid");
  const formatParts = lines[1]?.trim().split(/\s+/) ?? [];
  if (formatParts[0] !== "format" || formatParts[2] !== "1.0") {
    throw new RealityAssetError("unsupported_format", "Only PLY version 1.0 is accepted");
  }
  if (!["ascii", "binary_little_endian", "binary_big_endian"].includes(formatParts[1] ?? "")) {
    throw new RealityAssetError("unsupported_format", "PLY encoding is not supported");
  }
  const encoding = formatParts[1] as ParsedPlyHeader["encoding"];
  let vertexElementSeen = false;
  let currentElement: "vertex" | "other" | null = null;
  let splatCount = 0;
  let recordBytes = 0;
  const properties: PlyProperty[] = [];
  const propertyNames = new Set<string>();
  let antialiased: boolean | null = null;
  let explicit2d = false;

  for (let index = 2; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0 || line === "end_header") continue;
    if (line.length > REALITY_ASSET_LIMITS.maximumPlyLineBytes) {
      throw new RealityAssetError("invalid_format", "PLY header line is too long");
    }
    const parts = line.split(/\s+/);
    if (parts[0] === "comment" || parts[0] === "obj_info") {
      const comment = parts.slice(1).join(" ").toLowerCase();
      if (comment === "splat rendermode: 2dgs" || comment === "splatrendermode: 2dgs") explicit2d = true;
      const antialiasMatch = /(?:^|\s)antialiased\s+([01])(?:\s|$)/.exec(comment);
      if (antialiasMatch) antialiased = antialiasMatch[1] === "1";
      if (comment.includes("splatrendermode: mip")) antialiased = true;
      continue;
    }
    if (parts[0] === "element") {
      if (parts.length !== 3) throw new RealityAssetError("invalid_format", "PLY element declaration is invalid");
      const count = parseNonnegativeInteger(parts[2] ?? "", "PLY element count", Number.MAX_SAFE_INTEGER);
      if (parts[1] === "vertex") {
        if (vertexElementSeen) throw new RealityAssetError("invalid_format", "PLY has multiple vertex elements");
        vertexElementSeen = true;
        currentElement = "vertex";
        splatCount = count;
        if (splatCount === 0) throw new RealityAssetError("invalid_format", "PLY contains no splats");
        if (splatCount > REALITY_ASSET_LIMITS.maximumSplatCount) {
          throw new RealityAssetError("splat_limit_exceeded", `PLY exceeds the ${REALITY_ASSET_LIMITS.maximumSplatCount} splat limit`);
        }
      } else {
        // MVP accepts a pure Gaussian vertex table only. This avoids list-size
        // ambiguity and prevents non-splat PLY payloads entering the renderer.
        if (count !== 0) throw new RealityAssetError("unsupported_format", "PLY non-vertex elements are not accepted");
        currentElement = "other";
      }
      continue;
    }
    if (parts[0] === "property") {
      if (currentElement !== "vertex") continue;
      if (parts[1] === "list") throw new RealityAssetError("unsupported_format", "PLY list properties are not accepted");
      if (parts.length !== 3) throw new RealityAssetError("invalid_format", "PLY property declaration is invalid");
      const type = TYPE_ALIASES[parts[1] ?? ""];
      const name = parts[2] ?? "";
      if (!type || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || propertyNames.has(name)) {
        throw new RealityAssetError("invalid_format", "PLY property declaration is invalid");
      }
      const byteLength = TYPE_BYTES[type];
      properties.push(Object.freeze({ name, type, byteOffset: recordBytes, byteLength }));
      propertyNames.add(name);
      recordBytes += byteLength;
      if (recordBytes > REALITY_ASSET_LIMITS.maximumPlyLineBytes) {
        throw new RealityAssetError("invalid_format", "PLY vertex record is too large");
      }
      continue;
    }
    throw new RealityAssetError("invalid_format", "PLY header contains an unsupported directive");
  }

  if (!vertexElementSeen || splatCount === 0 || properties.length === 0) {
    throw new RealityAssetError("invalid_format", "PLY vertex table is missing");
  }
  for (const name of REQUIRED_BASE_PROPERTIES) {
    if (!propertyNames.has(name)) throw new RealityAssetError("invalid_format", "PLY is not a Gaussian splat vertex table");
  }
  const hasThirdScale = propertyNames.has("scale_2");
  if (!hasThirdScale && !explicit2d) {
    throw new RealityAssetError("invalid_format", "PLY Gaussian scale properties are incomplete");
  }
  if (hasThirdScale && explicit2d) {
    throw new RealityAssetError("invalid_format", "PLY 2DGS declaration conflicts with its scale properties");
  }
  return Object.freeze({
    bodyOffset,
    encoding,
    splatCount,
    properties: Object.freeze(properties),
    recordBytes,
    sphericalHarmonicsDegree: inferShDegree(propertyNames),
    model: explicit2d ? "gaussian-2d" : "gaussian-3d",
    antialiased,
  });
}

function readScalar(view: DataView, offset: number, type: PlyScalarType, littleEndian: boolean): number {
  switch (type) {
    case "int8": return view.getInt8(offset);
    case "uint8": return view.getUint8(offset);
    case "int16": return view.getInt16(offset, littleEndian);
    case "uint16": return view.getUint16(offset, littleEndian);
    case "int32": return view.getInt32(offset, littleEndian);
    case "uint32": return view.getUint32(offset, littleEndian);
    case "float32": return view.getFloat32(offset, littleEndian);
    case "float64": return view.getFloat64(offset, littleEndian);
  }
}

function updateBounds(
  bounds: { min: [number, number, number]; max: [number, number, number] },
  x: number,
  y: number,
  z: number,
): void {
  bounds.min[0] = Math.min(bounds.min[0], x);
  bounds.min[1] = Math.min(bounds.min[1], y);
  bounds.min[2] = Math.min(bounds.min[2], z);
  bounds.max[0] = Math.max(bounds.max[0], x);
  bounds.max[1] = Math.max(bounds.max[1], y);
  bounds.max[2] = Math.max(bounds.max[2], z);
}

function frozenBounds(bounds: { min: [number, number, number]; max: [number, number, number] }): RealityAssetBounds {
  return Object.freeze({
    min: Object.freeze({ x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] }),
    max: Object.freeze({ x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] }),
  });
}

async function inspectBinaryBody(
  blob: Blob,
  header: ParsedPlyHeader,
  signal?: AbortSignal,
): Promise<RealityAssetBounds> {
  const expectedBytes = checkedMultiply(header.splatCount, header.recordBytes, "PLY body size overflowed");
  if (blob.size - header.bodyOffset !== expectedBytes) {
    throw new RealityAssetError("invalid_format", "PLY binary body size does not match its header");
  }
  const xProperty = header.properties.find((property) => property.name === "x")!;
  const yProperty = header.properties.find((property) => property.name === "y")!;
  const zProperty = header.properties.find((property) => property.name === "z")!;
  const littleEndian = header.encoding === "binary_little_endian";
  const bounds = {
    min: [Infinity, Infinity, Infinity] as [number, number, number],
    max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
  };
  const recordsPerChunk = Math.max(1, Math.floor(REALITY_ASSET_LIMITS.digestChunkBytes / header.recordBytes));
  for (let firstRecord = 0; firstRecord < header.splatCount; firstRecord += recordsPerChunk) {
    throwIfRealityAssetAborted(signal);
    const recordCount = Math.min(recordsPerChunk, header.splatCount - firstRecord);
    const start = header.bodyOffset + firstRecord * header.recordBytes;
    const bytes = await readBlobRange(blob, start, start + recordCount * header.recordBytes, signal);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
      const recordOffset = recordIndex * header.recordBytes;
      for (const property of header.properties) {
        const value = readScalar(view, recordOffset + property.byteOffset, property.type, littleEndian);
        if (!Number.isFinite(value)) throw new RealityAssetError("invalid_format", "PLY contains a non-finite vertex value");
      }
      updateBounds(
        bounds,
        readScalar(view, recordOffset + xProperty.byteOffset, xProperty.type, littleEndian),
        readScalar(view, recordOffset + yProperty.byteOffset, yProperty.type, littleEndian),
        readScalar(view, recordOffset + zProperty.byteOffset, zProperty.type, littleEndian),
      );
    }
  }
  return frozenBounds(bounds);
}

function parseAsciiScalar(token: string, type: PlyScalarType): number {
  if (token.length === 0 || token.length > 128) {
    throw new RealityAssetError("invalid_format", "PLY contains an invalid scalar token");
  }
  const value = Number(token);
  if (!Number.isFinite(value)) throw new RealityAssetError("invalid_format", "PLY contains a non-finite vertex value");
  if (type.startsWith("int") || type.startsWith("uint")) {
    if (!Number.isInteger(value) || (type.startsWith("uint") && value < 0)) {
      throw new RealityAssetError("invalid_format", "PLY contains an invalid integer vertex value");
    }
    const ranges: Readonly<Record<PlyScalarType, readonly [number, number] | undefined>> = {
      int8: [-128, 127], uint8: [0, 255], int16: [-32_768, 32_767], uint16: [0, 65_535],
      int32: [-2_147_483_648, 2_147_483_647], uint32: [0, 4_294_967_295],
      float32: undefined, float64: undefined,
    };
    const range = ranges[type];
    if (range && (value < range[0] || value > range[1])) {
      throw new RealityAssetError("invalid_format", "PLY integer vertex value is out of range");
    }
  }
  return value;
}

async function inspectAsciiBody(
  blob: Blob,
  header: ParsedPlyHeader,
  signal?: AbortSignal,
): Promise<RealityAssetBounds> {
  const xIndex = header.properties.findIndex((property) => property.name === "x");
  const yIndex = header.properties.findIndex((property) => property.name === "y");
  const zIndex = header.properties.findIndex((property) => property.name === "z");
  const bounds = {
    min: [Infinity, Infinity, Infinity] as [number, number, number],
    max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let row = 0;
  const inspectLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length > REALITY_ASSET_LIMITS.maximumPlyLineBytes) {
      throw new RealityAssetError("invalid_format", "PLY vertex row is too long");
    }
    if (row >= header.splatCount) {
      if (line.trim().length !== 0) throw new RealityAssetError("invalid_format", "PLY contains trailing vertex data");
      return;
    }
    const tokens = line.trim().split(/\s+/);
    if (tokens.length !== header.properties.length) {
      throw new RealityAssetError("invalid_format", "PLY vertex row does not match its properties");
    }
    const values = tokens.map((token, index) => parseAsciiScalar(token, header.properties[index]!.type));
    updateBounds(bounds, values[xIndex]!, values[yIndex]!, values[zIndex]!);
    row += 1;
  };
  try {
    for (
      let offset = header.bodyOffset;
      offset < blob.size;
      offset += REALITY_ASSET_LIMITS.digestChunkBytes
    ) {
      throwIfRealityAssetAborted(signal);
      const bytes = await readBlobRange(
        blob,
        offset,
        Math.min(blob.size, offset + REALITY_ASSET_LIMITS.digestChunkBytes),
        signal,
      );
      pending += decoder.decode(bytes, { stream: true });
      if (pending.length > REALITY_ASSET_LIMITS.maximumPlyLineBytes * 2 && !pending.includes("\n")) {
        throw new RealityAssetError("invalid_format", "PLY vertex row is too long");
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        inspectLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) inspectLine(pending);
  } catch (error) {
    if (error instanceof RealityAssetError) throw error;
    throw new RealityAssetError("invalid_format", "PLY text body is invalid", { cause: error });
  }
  if (row !== header.splatCount) throw new RealityAssetError("invalid_format", "PLY vertex body is truncated");
  return frozenBounds(bounds);
}

export async function preflightPly(blob: Blob, signal?: AbortSignal): Promise<RealityAssetFormatPreflight> {
  const headerBytes = await readBlobRange(
    blob,
    0,
    Math.min(blob.size, REALITY_ASSET_LIMITS.maximumHeaderBytes),
    signal,
  );
  const header = parsePlyHeader(headerBytes);
  const sourceBounds = header.encoding === "ascii"
    ? await inspectAsciiBody(blob, header, signal)
    : await inspectBinaryBody(blob, header, signal);
  return Object.freeze({
    format: "ply",
    formatVersion: 1,
    mediaType: "application/ply",
    splatCount: header.splatCount,
    sphericalHarmonicsDegree: header.sphericalHarmonicsDegree,
    model: header.model,
    antialiased: header.antialiased,
    coordinateSystem: Object.freeze({ system: "UNKNOWN", provenance: "unknown" }),
    sourceBounds,
    warnings: Object.freeze(["source_units_unknown", "source_coordinate_system_unknown"] as const),
  });
}
