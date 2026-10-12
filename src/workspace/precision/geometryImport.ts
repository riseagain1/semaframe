import { sha256DigestBytes } from "../assets/digest";
import type { MeasurementGeometry, PrecisionUnit } from "./types";

/** These limits bound the inspectable V1 geometry, not the retained source artifact. */
export const MEASUREMENT_IMPORT_LIMITS = Object.freeze({
  maximumBytes: 16 * 1024 * 1024,
  maximumVertices: 25_000,
  maximumTriangles: 50_000,
  maximumPolygonVertices: 32,
});

export type MeasurementImportFormat = "obj" | "ply" | "xyz-csv";
export type MeasurementImportUnits = PrecisionUnit;
type Point = readonly [number, number, number];
type Triangle = readonly [number, number, number];
type RawGeometry = { positions: Point[]; triangles: Triangle[]; warnings: string[] };

export class MeasurementImportError extends Error {
  constructor(readonly code: "invalid_geometry" | "unsupported_format" | "limit_exceeded" | "gaussian_not_measurement", message: string) {
    super(message);
    this.name = "MeasurementImportError";
  }
}

function invalid(message: string): never { throw new MeasurementImportError("invalid_geometry", message); }
function limited(message: string): never { throw new MeasurementImportError("limit_exceeded", message); }
function number(token: string): number {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(token)) invalid("Invalid numeric token");
  const value = Number(token);
  if (!Number.isFinite(value) || Math.abs(value) > 1e9) invalid("Geometry coordinates must be finite and bounded");
  return value;
}
function integer(token: string): number {
  if (!/^[+-]?\d+$/u.test(token)) invalid("Invalid integer token");
  const value = Number(token);
  if (!Number.isSafeInteger(value)) invalid("Integer is outside the supported range");
  return value;
}
const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function addPoint(raw: RawGeometry, point: Point): void {
  if (raw.positions.length >= MEASUREMENT_IMPORT_LIMITS.maximumVertices) limited("Source exceeds 25000 vertices; no automatic downsampling is performed");
  if (point.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e9)) invalid("Invalid geometry coordinate");
  raw.positions.push(point);
}

/** Fan triangulation is allowed only after proving a convex, planar polygon. */
function addPolygon(raw: RawGeometry, indices: readonly number[]): void {
  if (indices.length < 3 || indices.length > MEASUREMENT_IMPORT_LIMITS.maximumPolygonVertices) invalid("Faces must have 3 to 32 vertices");
  if (new Set(indices).size !== indices.length || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= raw.positions.length)) invalid("Invalid or repeated face index");
  const points = indices.map((index) => raw.positions[index]!);
  const origin = points[0]!;
  const normal = cross(subtract(points[1]!, origin), subtract(points[2]!, origin));
  const normalLength = Math.hypot(...normal);
  const extent = Math.max(...points.map((point) => Math.hypot(...subtract(point, origin))));
  if (!(extent > 0) || normalLength <= 1e-12 * extent * extent) invalid("Degenerate face");
  const unit: Point = [normal[0] / normalLength, normal[1] / normalLength, normal[2] / normalLength];
  for (let index = 0; index < points.length; index += 1) {
    if (Math.abs(dot(subtract(points[index]!, origin), unit)) > Math.max(1e-10, extent * 1e-8)) invalid("Non-planar polygon requires explicit triangulation");
    const a = subtract(points[(index + 1) % points.length]!, points[index]!);
    const b = subtract(points[(index + 2) % points.length]!, points[(index + 1) % points.length]!);
    if (dot(cross(a, b), unit) <= 1e-12 * extent * extent) invalid("Concave or degenerate polygon requires explicit triangulation");
  }
  // Consistent local turns alone do not exclude star polygons.
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 2; second < points.length; second += 1) {
      if (first === 0 && second === points.length - 1) continue;
      const a = points[first]!; const b = points[(first + 1) % points.length]!;
      const c = points[second]!; const d = points[(second + 1) % points.length]!;
      const ab = subtract(b, a); const cd = subtract(d, c);
      const sideC = dot(cross(ab, subtract(c, a)), unit);
      const sideD = dot(cross(ab, subtract(d, a)), unit);
      const sideA = dot(cross(cd, subtract(a, c)), unit);
      const sideB = dot(cross(cd, subtract(b, c)), unit);
      if (sideC * sideD <= 0 && sideA * sideB <= 0) invalid("Self-intersecting polygon requires explicit repair");
    }
  }
  if (raw.triangles.length + indices.length - 2 > MEASUREMENT_IMPORT_LIMITS.maximumTriangles) limited("Source exceeds 50000 triangles");
  for (let index = 1; index < indices.length - 1; index += 1) raw.triangles.push([indices[0]!, indices[index]!, indices[index + 1]!]);
}


function parseObj(text: string): RawGeometry {
  const raw: RawGeometry = { positions: [], triangles: [], warnings: [] };
  const ignored = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line.length > 32_768) limited("OBJ line exceeds supported length");
    const tokens = line.replace(/#.*/u, "").trim().split(/\s+/u);
    const command = tokens.shift();
    if (!command) continue;
    if (command === "v") {
      if (tokens.length !== 3) invalid("OBJ supports three-dimensional vertices without homogeneous coordinates or inline colors");
      addPoint(raw, [number(tokens[0]!), number(tokens[1]!), number(tokens[2]!)]);
    } else if (command === "f") {
      const indices = tokens.map((token) => {
        const parts = token.split("/");
        if (parts.length > 3 || parts[0] === "" || parts.slice(1).some((part) => part !== "" && !/^[+-]?\d+$/u.test(part))) invalid("Invalid OBJ face token");
        const index = integer(parts[0]!);
        if (index === 0) invalid("OBJ indices are one-based");
        return index > 0 ? index - 1 : raw.positions.length + index;
      });
      addPolygon(raw, indices);
    } else if (["vn", "vt", "o", "g", "s", "usemtl", "mtllib"].includes(command)) {
      ignored.add(command);
    } else invalid(`Unsupported OBJ statement: ${command}`);
  }
  if (ignored.has("mtllib") || ignored.has("usemtl")) raw.warnings.push("Materials and external references were ignored; no paths or URLs were loaded.");
  if (ignored.has("vn") || ignored.has("vt")) raw.warnings.push("Input normals and texture coordinates are not measurement positions and were ignored.");
  return raw;
}

const PLY_TYPES: Readonly<Record<string, { bytes: number; integer: boolean; read(view: DataView, offset: number, little: boolean): number }>> = {
  char: { bytes: 1, integer: true, read: (v, o) => v.getInt8(o) },
  uchar: { bytes: 1, integer: true, read: (v, o) => v.getUint8(o) },
  short: { bytes: 2, integer: true, read: (v, o, le) => v.getInt16(o, le) },
  ushort: { bytes: 2, integer: true, read: (v, o, le) => v.getUint16(o, le) },
  int: { bytes: 4, integer: true, read: (v, o, le) => v.getInt32(o, le) },
  uint: { bytes: 4, integer: true, read: (v, o, le) => v.getUint32(o, le) },
  float: { bytes: 4, integer: false, read: (v, o, le) => v.getFloat32(o, le) },
  double: { bytes: 8, integer: false, read: (v, o, le) => v.getFloat64(o, le) },
};
const PLY_ALIASES: Readonly<Record<string, string>> = { int8: "char", uint8: "uchar", int16: "short", uint16: "ushort", int32: "int", uint32: "uint", float32: "float", float64: "double" };
type PlyProperty = { name: string; type: string; countType?: string };
function plyType(name: string): string {
  const key = PLY_ALIASES[name] ?? name;
  if (!Object.hasOwn(PLY_TYPES, key)) invalid("Unsupported PLY property type");
  return key;
}
function parsePly(bytes: Uint8Array): RawGeometry {
  let headerEnd = -1;
  for (let index = 0; index < Math.min(bytes.length, 16_384); index += 1) {
    if (bytes[index] === 10) {
      const prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, index + 1));
      if (/(?:^|\n)end_header\r?\n$/u.test(prefix)) { headerEnd = index + 1; break; }
    }
  }
  if (headerEnd < 0) invalid("Missing or oversized PLY header");
  const lines = new TextDecoder().decode(bytes.subarray(0, headerEnd)).trim().split(/\r?\n/u);
  if (lines.shift() !== "ply") invalid("Invalid PLY magic");
  const format = lines.shift();
  if (!["format ascii 1.0", "format binary_little_endian 1.0", "format binary_big_endian 1.0"].includes(format!)) invalid("Unsupported PLY encoding");
  const elements: { name: string; count: number; properties: PlyProperty[] }[] = [];
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/u);
    if (["comment", "obj_info", "end_header"].includes(tokens[0]!)) continue;
    if (tokens[0] === "element") {
      if (tokens.length !== 3 || !["vertex", "face"].includes(tokens[1]!) || elements.some((entry) => entry.name === tokens[1])) invalid("Unsupported or duplicate PLY element");
      const count = integer(tokens[2]!);
      if (count < 0 || count > (tokens[1] === "vertex" ? MEASUREMENT_IMPORT_LIMITS.maximumVertices : MEASUREMENT_IMPORT_LIMITS.maximumTriangles)) limited("PLY element count exceeds limits");
      elements.push({ name: tokens[1]!, count, properties: [] });
    } else if (tokens[0] === "property") {
      const element = elements.at(-1);
      if (!element || element.properties.length >= 64) invalid("Invalid PLY properties");
      const list = tokens[1] === "list";
      if (tokens.length !== (list ? 5 : 3)) invalid("Invalid PLY property declaration");
      const name = tokens[list ? 4 : 2]!;
      if (/^(?:f_dc_|f_rest_|scale_|rot_)|^opacity$/u.test(name)) throw new MeasurementImportError("gaussian_not_measurement", "Gaussian PLY is visual-only, not a measurement point cloud");
      if (element.properties.some((property) => property.name === name)) invalid("Duplicate PLY property");
      if (list && (element.name !== "face" || !["vertex_indices", "vertex_index"].includes(name))) invalid("Unsupported PLY list property");
      const type = plyType(tokens[list ? 3 : 1]!);
      const countType = list ? plyType(tokens[2]!) : undefined;
      if (countType && (!PLY_TYPES[countType]!.integer || !PLY_TYPES[type]!.integer)) invalid("Face indices and counts must be integers");
      element.properties.push({ name, type, ...(countType ? { countType } : {}) });
    } else invalid("Unsupported PLY header statement");
  }
  if (elements[0]?.name !== "vertex") invalid("PLY must declare vertices before faces");
  const vertex = elements[0];
  if (!["x", "y", "z"].every((axis) => vertex.properties.some((property) => property.name === axis && !property.countType))) invalid("PLY lacks x/y/z coordinates");
  const face = elements.find((element) => element.name === "face");
  if (face && face.properties.filter((property) => property.countType).length !== 1) invalid("PLY faces require exactly one vertex index list");
  const raw: RawGeometry = { positions: [], triangles: [], warnings: [] };
  const ascii = format === "format ascii 1.0";
  const tokens = ascii ? new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(headerEnd)).trim().split(/\s+/u).filter(Boolean) : [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = headerEnd;
  let cursor = 0;
  const read = (type: string): number => {
    const descriptor = PLY_TYPES[type]!;
    let value: number;
    if (ascii) {
      const token = tokens[cursor++];
      if (token === undefined) invalid("Truncated PLY payload");
      value = descriptor.integer ? integer(token) : number(token);
    } else {
      if (offset + descriptor.bytes > bytes.length) invalid("Truncated PLY payload");
      value = descriptor.read(view, offset, format === "format binary_little_endian 1.0");
      offset += descriptor.bytes;
    }
    if (!Number.isFinite(value)) invalid("PLY contains a non-finite value");
    return value;
  };
  for (const element of elements) {
    for (let row = 0; row < element.count; row += 1) {
      const coordinates: Record<string, number> = Object.create(null) as Record<string, number>;
      let indices: number[] | undefined;
      for (const property of element.properties) {
        if (property.countType) {
          const count = read(property.countType);
          if (count < 3 || count > MEASUREMENT_IMPORT_LIMITS.maximumPolygonVertices) invalid("Invalid PLY face size");
          indices = Array.from({ length: count }, () => read(property.type));
        } else {
          const value = read(property.type);
          if (["x", "y", "z"].includes(property.name)) coordinates[property.name] = value;
        }
      }
      if (element.name === "vertex") addPoint(raw, [coordinates.x!, coordinates.y!, coordinates.z!]);
      else addPolygon(raw, indices!);
    }
  }
  if (ascii ? cursor !== tokens.length : offset !== bytes.length) invalid("Unexpected trailing PLY payload");
  return raw;
}

function parseCsv(text: string): RawGeometry {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.shift() !== "x,y,z") invalid("XYZ CSV requires the explicit x,y,z header");
  const raw: RawGeometry = { positions: [], triangles: [], warnings: [] };
  for (const line of lines) {
    const tokens = line.split(",").map((token) => token.trim());
    if (tokens.length !== 3) invalid("XYZ CSV requires exactly three numeric columns");
    addPoint(raw, [number(tokens[0]!), number(tokens[1]!), number(tokens[2]!)]);
  }
  return raw;
}

/** Parses bytes only. This function never follows references or opens a path/URL. */
export function parseMeasurementGeometrySource(data: string | Uint8Array, format: MeasurementImportFormat): RawGeometry & { sourceDigest: `sha256:${string}`; byteLength: number } {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes.byteLength > MEASUREMENT_IMPORT_LIMITS.maximumBytes) limited("Measurement source exceeds 16 MiB");
  if (bytes.byteLength === 0) invalid("Empty measurement source");
  let raw: RawGeometry;
  if (format === "ply") raw = parsePly(bytes);
  else if (format === "obj" || format === "xyz-csv") {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { invalid("Source is not valid UTF-8"); }
    if (text.includes("\0")) invalid("Text geometry contains a NUL byte");
    raw = format === "obj" ? parseObj(text) : parseCsv(text);
  } else throw new MeasurementImportError("unsupported_format", "Unsupported measurement source format");
  if (raw.positions.length < 3) invalid("Measurement geometry requires at least three vertices");
  return { ...raw, sourceDigest: sha256DigestBytes(bytes), byteLength: bytes.byteLength };
}

/** Import preserves source coordinates and units. No axis or unit authority is inferred. */
export function importMeasurementGeometry(input: Readonly<{
  data: string | Uint8Array;
  format: MeasurementImportFormat;
  geometryId: string;
  units?: MeasurementImportUnits;
  /** Caller must establish this basis; uncalibrated native captures remain source artifacts. */
  coordinateBasis: "RUB";
  provenance: string;
}>): MeasurementGeometry {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(input.geometryId)
    || input.coordinateBasis !== "RUB"
    || !["unknown", "metre", "centimetre", "millimetre", "inch"].includes(input.units ?? "unknown")
    || !input.provenance.trim() || input.provenance.length > 2_048) invalid("An identified source, explicit RUB coordinate basis and provenance are required");
  const parsed = parseMeasurementGeometrySource(input.data, input.format);
  return {
    geometryId: input.geometryId, positions: parsed.positions,
    ...(parsed.triangles.length ? { triangles: parsed.triangles } : {}),
    units: input.units ?? "unknown", coordinateBasis: "RUB",
    source: { sha256: parsed.sourceDigest, format: input.format, provenance: input.provenance },
  };
}
