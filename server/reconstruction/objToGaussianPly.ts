import { constants as fsConstants, createReadStream } from "node:fs";
import { access, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import sharp from "sharp";

const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_SPLATS = 4_000_000;
const MAX_OBJ_BYTES = 256 * 1024 * 1024;
const MAX_MTL_BYTES = 16 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 256 * 1024 * 1024;
const MAX_TEXTURE_PIXELS = 64 * 1024 * 1024;
const MAX_LINE_CHARACTERS = 1024 * 1024;
const MAX_VERTICES = 5_000_000;
const MAX_TRIANGLES = 5_000_000;
const MAX_TEXTURE_COORDINATES = MAX_VERTICES * 2;
const MAX_NORMALS = MAX_VERTICES * 2;
const MAX_FACE_VERTICES = 65_536;
const MAX_MATERIALS = 65_536;
const MAX_MATERIAL_LIBRARIES = 256;
const MAX_DECODED_TEXTURE_BYTES = 256 * 1024 * 1024;
// OBJ byte size is not a useful upper bound for the retained parse graph. Keep
// the exact packed arrays below within a separate, explicit working-set budget.
// 192 MiB conservatively leaves separate headroom for the independently
// bounded decoded-texture pool, Sharp, the output batch, and the gateway.
const MAX_OBJ_STRUCTURAL_BYTES = 192 * 1024 * 1024;
const MAX_MATERIAL_NAME_CHARACTERS = 4_096;
const MAX_RETAINED_MATERIAL_NAME_CHARACTERS = 1024 * 1024;
const MAX_MATERIAL_LIBRARY_REFERENCE_CHARACTERS = 4_096;
const MAX_RETAINED_MATERIAL_LIBRARY_CHARACTERS = 64 * 1024;
const MAX_RETAINED_MTL_TEXTURE_REFERENCE_CHARACTERS = 1024 * 1024;
const PACKED_VERTEX_BYTES = 3 * Float64Array.BYTES_PER_ELEMENT
  + 3 * Float64Array.BYTES_PER_ELEMENT
  + Uint8Array.BYTES_PER_ELEMENT;
const PACKED_TEXTURE_COORDINATE_BYTES = 2 * Float64Array.BYTES_PER_ELEMENT;
const PACKED_TRIANGLE_BYTES = 3 * Uint32Array.BYTES_PER_ELEMENT
  + 3 * Int32Array.BYTES_PER_ELEMENT
  + Int32Array.BYTES_PER_ELEMENT
  + Float64Array.BYTES_PER_ELEMENT
  + 3 * Float64Array.BYTES_PER_ELEMENT
  + Uint32Array.BYTES_PER_ELEMENT; // per-triangle sample allocation
const BYTES_PER_SPLAT = 14 * 4;
const SH_C0 = 0.28209479177387814;

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
type Rgb = readonly [number, number, number];

type FaceVertex = Readonly<{
  vertex: number;
  texture?: number;
}>;

type MaterialDefinition = {
  color: Rgb;
  alpha: number;
  textureReference?: string;
};

type Texture = Readonly<{
  width: number;
  height: number;
  pixels: Buffer;
}>;

type Material = Readonly<{
  color: Rgb;
  alpha: number;
  texture?: Texture;
}>;

export type ObjToGaussianPlyOptions = Readonly<{
  objPath: string;
  outputPath: string;
  assetRoot?: string;
  targetSplatCount?: number;
  maxSplats?: number;
  maxBytes?: number;
  /** May lower, but never raise, the retained packed OBJ structural budget. */
  maxStructuralBytes?: number;
  defaultColor?: Rgb;
  /**
   * Optional host-owned storage reservation. It is called before every output
   * write with all bytes that still need to be committed, including that
   * write. A rejection fails closed and removes the partial PLY.
   */
  reserveOutputBytes?: (remainingOutputBytes: number) => Promise<void>;
  signal?: AbortSignal;
}>;

export type ObjToGaussianPlyResult = Readonly<{
  outputPath: string;
  splatCount: number;
  byteLength: number;
  sourceTriangleCount: number;
  skippedDegenerateTriangleCount: number;
  textureCount: number;
  bounds: Readonly<{ min: Vec3; max: Vec3 }>;
  units: "unknown";
  axes: "unknown";
}>;

export type ObjToGaussianPlyErrorCode =
  | "invalid_request"
  | "invalid_obj"
  | "unsafe_reference"
  | "resource_limit"
  | "texture_error"
  | "output_exists"
  | "aborted";

export class ObjToGaussianPlyError extends Error {
  readonly code: ObjToGaussianPlyErrorCode;

  constructor(code: ObjToGaussianPlyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ObjToGaussianPlyError";
    this.code = code;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ObjToGaussianPlyError("aborted", "OBJ conversion was aborted", { cause: signal.reason });
  }
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validPositiveInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new ObjToGaussianPlyError(
      "invalid_request",
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
  return candidate;
}

function finiteNumber(token: string, label: string): number {
  if (token.length === 0 || token.length > 128) {
    throw new ObjToGaussianPlyError("invalid_obj", `${label} is invalid`);
  }
  const value = Number(token);
  if (!Number.isFinite(value) || Math.abs(value) > 1e15) {
    throw new ObjToGaussianPlyError("invalid_obj", `${label} is not a finite coordinate`);
  }
  return value;
}

function pathContains(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function regularFile(path: string, maximumBytes: number, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    throw new ObjToGaussianPlyError("invalid_request", `${label} does not exist`, { cause });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ObjToGaussianPlyError("invalid_request", `${label} must be a regular non-symlink file`);
  }
  if (info.size > maximumBytes) {
    throw new ObjToGaussianPlyError("resource_limit", `${label} exceeds its byte limit`);
  }
}

async function resolveReference(assetRoot: string, baseDirectory: string, reference: string): Promise<string> {
  if (reference.includes("\0") || isAbsolute(reference)) {
    throw new ObjToGaussianPlyError("unsafe_reference", "OBJ asset reference must be relative");
  }
  const lexicalPath = resolve(baseDirectory, reference);
  if (!pathContains(assetRoot, lexicalPath)) {
    throw new ObjToGaussianPlyError("unsafe_reference", "OBJ asset reference escapes its asset root");
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (cause) {
    throw new ObjToGaussianPlyError("invalid_obj", "OBJ references a missing asset", { cause });
  }
  if (!pathContains(assetRoot, canonicalPath)) {
    throw new ObjToGaussianPlyError("unsafe_reference", "OBJ asset reference resolves outside its asset root");
  }
  return canonicalPath;
}

function parseIndex(token: string, count: number, label: string): number {
  if (!/^-?[1-9][0-9]*$/.test(token)) {
    throw new ObjToGaussianPlyError("invalid_obj", `${label} index is invalid`);
  }
  const raw = Number(token);
  if (!Number.isSafeInteger(raw)) {
    throw new ObjToGaussianPlyError("invalid_obj", `${label} index is invalid`);
  }
  const index = raw > 0 ? raw - 1 : count + raw;
  if (index < 0 || index >= count) {
    throw new ObjToGaussianPlyError("invalid_obj", `${label} index is out of range`);
  }
  return index;
}

function parseFaceVertex(
  token: string,
  vertexCount: number,
  textureCount: number,
  normalCount: number,
): FaceVertex {
  const parts = token.split("/");
  if (parts.length > 3 || !parts[0]) {
    throw new ObjToGaussianPlyError("invalid_obj", "OBJ face vertex is invalid");
  }
  const vertex = parseIndex(parts[0], vertexCount, "OBJ vertex");
  const texture = parts[1] ? parseIndex(parts[1], textureCount, "OBJ texture") : undefined;
  if (parts[2]) parseIndex(parts[2], normalCount, "OBJ normal");
  return Object.freeze({ vertex, ...(texture === undefined ? {} : { texture }) });
}

function triangleGeometry(a: Vec3, b: Vec3, c: Vec3): { area: number; normal: Vec3 } | undefined {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross: Vec3 = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const length = Math.hypot(cross[0], cross[1], cross[2]);
  if (!Number.isFinite(length) || length <= 1e-15) return undefined;
  return {
    area: length / 2,
    normal: Object.freeze([cross[0] / length, cross[1] / length, cross[2] / length]),
  };
}

function parseVertexColor(parts: readonly string[]): Rgb | undefined {
  if (parts.length < 6) return undefined;
  // The widely used vertex-color extension is `v x y z r g b [a]`.
  // Standard homogeneous `w` alone has only four values and is ignored.
  const raw: [number, number, number] = [
    finiteNumber(parts[3]!, "OBJ vertex color"),
    finiteNumber(parts[4]!, "OBJ vertex color"),
    finiteNumber(parts[5]!, "OBJ vertex color"),
  ];
  const divisor = Math.max(...raw) > 1 ? 255 : 1;
  return Object.freeze([
    clamp(raw[0] / divisor),
    clamp(raw[1] / divisor),
    clamp(raw[2] / divisor),
  ]);
}

type ObjStructureCounts = Readonly<{
  vertices: number;
  textureCoordinates: number;
  normals: number;
  candidateTriangles: number;
}>;

type PackedVertices = Readonly<{
  count: number;
  positions: Float64Array;
  colors: Float64Array;
  hasColor: Uint8Array;
}>;

type PackedTextureCoordinates = Readonly<{
  count: number;
  values: Float64Array;
}>;

type PackedTriangles = Readonly<{
  count: number;
  vertexIndices: Uint32Array;
  textureIndices: Int32Array;
  materialIndices: Int32Array;
  areas: Float64Array;
  normals: Float64Array;
}>;

type ParsedObj = Readonly<{
  vertices: PackedVertices;
  textureCoordinates: PackedTextureCoordinates;
  triangles: PackedTriangles;
  materialNames: readonly string[];
  materialLibraries: readonly string[];
  skippedDegenerateTriangleCount: number;
  bounds: Readonly<{ min: Vec3; max: Vec3 }>;
}>;

function structuralBytes(counts: ObjStructureCounts): number {
  return counts.vertices * PACKED_VERTEX_BYTES
    + counts.textureCoordinates * PACKED_TEXTURE_COORDINATE_BYTES
    + counts.candidateTriangles * PACKED_TRIANGLE_BYTES;
}

function assertStructuralBudget(counts: ObjStructureCounts, maximumBytes: number): void {
  if (structuralBytes(counts) > maximumBytes) {
    throw new ObjToGaussianPlyError(
      "resource_limit",
      `OBJ packed structural data exceeds its ${maximumBytes}-byte working-set limit`,
    );
  }
}

type ObjLineVisitor = (
  directive: string,
  remainder: string,
  parts: readonly string[],
) => void;

async function visitObjLines(path: string, signal: AbortSignal | undefined, visitor: ObjLineVisitor): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let lineNumber = 0;
    for await (const rawLine of lines) {
      lineNumber += 1;
      if ((lineNumber & 0x3fff) === 0) throwIfAborted(signal);
      if (rawLine.length > MAX_LINE_CHARACTERS) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ contains an oversized line");
      }
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const separator = line.search(/\s/);
      const directive = separator < 0 ? line : line.slice(0, separator);
      const remainder = separator < 0 ? "" : line.slice(separator).trim();
      const parts = remainder.length > 0 ? remainder.split(/\s+/) : [];
      visitor(directive, remainder, parts);
    }
  } catch (cause) {
    stream.destroy();
    if (cause instanceof ObjToGaussianPlyError) throw cause;
    throw new ObjToGaussianPlyError("invalid_obj", "Failed to parse OBJ", { cause });
  }
  throwIfAborted(signal);
}

async function scanObjStructure(
  path: string,
  maximumStructuralBytes: number,
  signal?: AbortSignal,
): Promise<ObjStructureCounts> {
  const mutable = { vertices: 0, textureCoordinates: 0, normals: 0, candidateTriangles: 0 };
  await visitObjLines(path, signal, (directive, _remainder, parts) => {
    if (directive === "v") {
      if (parts.length < 3) throw new ObjToGaussianPlyError("invalid_obj", "OBJ vertex is incomplete");
      mutable.vertices += 1;
      if (mutable.vertices > MAX_VERTICES) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ contains too many vertices");
      }
    } else if (directive === "vt") {
      if (parts.length < 2) throw new ObjToGaussianPlyError("invalid_obj", "OBJ texture coordinate is incomplete");
      mutable.textureCoordinates += 1;
      if (mutable.textureCoordinates > MAX_TEXTURE_COORDINATES) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ contains too many texture coordinates");
      }
    } else if (directive === "vn") {
      if (parts.length < 3) throw new ObjToGaussianPlyError("invalid_obj", "OBJ normal is incomplete");
      mutable.normals += 1;
      if (mutable.normals > MAX_NORMALS) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ contains too many normals");
      }
    } else if (directive === "f") {
      if (parts.length < 3) throw new ObjToGaussianPlyError("invalid_obj", "OBJ face has fewer than three vertices");
      if (parts.length > MAX_FACE_VERTICES) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ face contains too many vertices");
      }
      mutable.candidateTriangles += parts.length - 2;
      if (mutable.candidateTriangles > MAX_TRIANGLES) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ contains too many triangles");
      }
    }
    assertStructuralBudget(mutable, maximumStructuralBytes);
  });
  return Object.freeze({ ...mutable });
}

function packedVec3(values: Float64Array, index: number): Vec3 {
  const offset = index * 3;
  return [values[offset]!, values[offset + 1]!, values[offset + 2]!];
}

function packedVec2(values: Float64Array, index: number): Vec2 {
  const offset = index * 2;
  return [values[offset]!, values[offset + 1]!];
}

async function parseObj(
  path: string,
  counts: ObjStructureCounts,
  signal?: AbortSignal,
): Promise<ParsedObj> {
  let positionValues: Float64Array;
  let colorValues: Float64Array;
  let hasColor: Uint8Array;
  let textureValues: Float64Array;
  let triangleVertexIndices: Uint32Array;
  let triangleTextureIndices: Int32Array;
  let triangleMaterialIndices: Int32Array;
  let triangleAreas: Float64Array;
  let triangleNormals: Float64Array;
  try {
    positionValues = new Float64Array(counts.vertices * 3);
    colorValues = new Float64Array(counts.vertices * 3);
    hasColor = new Uint8Array(counts.vertices);
    textureValues = new Float64Array(counts.textureCoordinates * 2);
    triangleVertexIndices = new Uint32Array(counts.candidateTriangles * 3);
    triangleTextureIndices = new Int32Array(counts.candidateTriangles * 3);
    triangleTextureIndices.fill(-1);
    triangleMaterialIndices = new Int32Array(counts.candidateTriangles);
    triangleMaterialIndices.fill(-1);
    triangleAreas = new Float64Array(counts.candidateTriangles);
    triangleNormals = new Float64Array(counts.candidateTriangles * 3);
  } catch (cause) {
    throw new ObjToGaussianPlyError("resource_limit", "Unable to allocate bounded OBJ structural storage", { cause });
  }

  const materialLibraries: string[] = [];
  const materialNames: string[] = [];
  const materialNameIndices = new Map<string, number>();
  let retainedMaterialNameCharacters = 0;
  let retainedMaterialLibraryCharacters = 0;
  let currentMaterialIndex = -1;
  let vertexCount = 0;
  let textureCoordinateCount = 0;
  let normalCount = 0;
  let triangleCount = 0;
  let skippedDegenerateTriangleCount = 0;
  const bounds = {
    min: [Infinity, Infinity, Infinity] as [number, number, number],
    max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
  };

  await visitObjLines(path, signal, (directive, remainder, parts) => {
    if (directive === "v") {
      if (parts.length < 3) throw new ObjToGaussianPlyError("invalid_obj", "OBJ vertex is incomplete");
      if (vertexCount >= counts.vertices) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ changed while it was being parsed");
      }
      const position: Vec3 = [
        finiteNumber(parts[0]!, "OBJ vertex"),
        finiteNumber(parts[1]!, "OBJ vertex"),
        finiteNumber(parts[2]!, "OBJ vertex"),
      ];
      const offset = vertexCount * 3;
      positionValues.set(position, offset);
      const color = parseVertexColor(parts);
      if (color) {
        colorValues.set(color, offset);
        hasColor[vertexCount] = 1;
      }
      for (let axis = 0; axis < 3; axis += 1) {
        bounds.min[axis] = Math.min(bounds.min[axis]!, position[axis]!);
        bounds.max[axis] = Math.max(bounds.max[axis]!, position[axis]!);
      }
      vertexCount += 1;
    } else if (directive === "vt") {
      if (parts.length < 2) throw new ObjToGaussianPlyError("invalid_obj", "OBJ texture coordinate is incomplete");
      if (textureCoordinateCount >= counts.textureCoordinates) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ changed while it was being parsed");
      }
      const offset = textureCoordinateCount * 2;
      textureValues[offset] = finiteNumber(parts[0]!, "OBJ texture coordinate");
      textureValues[offset + 1] = finiteNumber(parts[1]!, "OBJ texture coordinate");
      textureCoordinateCount += 1;
    } else if (directive === "f") {
      if (parts.length < 3) throw new ObjToGaussianPlyError("invalid_obj", "OBJ face has fewer than three vertices");
      if (parts.length > MAX_FACE_VERTICES) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ face contains too many vertices");
      }
      const faceVertices = new Uint32Array(parts.length);
      const faceTextures = new Int32Array(parts.length);
      faceTextures.fill(-1);
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const parsed = parseFaceVertex(parts[partIndex]!, vertexCount, textureCoordinateCount, normalCount);
        faceVertices[partIndex] = parsed.vertex;
        if (parsed.texture !== undefined) faceTextures[partIndex] = parsed.texture;
      }
      for (let index = 1; index < parts.length - 1; index += 1) {
        if (triangleCount + skippedDegenerateTriangleCount >= counts.candidateTriangles) {
          throw new ObjToGaussianPlyError("resource_limit", "OBJ changed while it was being parsed");
        }
        const first = faceVertices[0]!;
        const second = faceVertices[index]!;
        const third = faceVertices[index + 1]!;
        const geometry = triangleGeometry(
          packedVec3(positionValues, first),
          packedVec3(positionValues, second),
          packedVec3(positionValues, third),
        );
        if (!geometry) {
          skippedDegenerateTriangleCount += 1;
          continue;
        }
        const triangleOffset = triangleCount * 3;
        triangleVertexIndices[triangleOffset] = first;
        triangleVertexIndices[triangleOffset + 1] = second;
        triangleVertexIndices[triangleOffset + 2] = third;
        triangleTextureIndices[triangleOffset] = faceTextures[0]!;
        triangleTextureIndices[triangleOffset + 1] = faceTextures[index]!;
        triangleTextureIndices[triangleOffset + 2] = faceTextures[index + 1]!;
        triangleMaterialIndices[triangleCount] = currentMaterialIndex;
        triangleAreas[triangleCount] = geometry.area;
        triangleNormals.set(geometry.normal, triangleOffset);
        triangleCount += 1;
      }
    } else if (directive === "mtllib") {
      if (remainder.length === 0) throw new ObjToGaussianPlyError("invalid_obj", "OBJ material library is empty");
      if (materialLibraries.length >= MAX_MATERIAL_LIBRARIES) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ references too many material libraries");
      }
      if (remainder.length > MAX_MATERIAL_LIBRARY_REFERENCE_CHARACTERS ||
          retainedMaterialLibraryCharacters + remainder.length > MAX_RETAINED_MATERIAL_LIBRARY_CHARACTERS) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ material-library references exceed their character limit");
      }
      // Object Capture writes one library per declaration. Keeping the whole
      // remainder also supports unquoted file names containing spaces.
      materialLibraries.push(remainder);
      retainedMaterialLibraryCharacters += remainder.length;
    } else if (directive === "usemtl") {
      if (!remainder) {
        currentMaterialIndex = -1;
        return;
      }
      if (remainder.length > MAX_MATERIAL_NAME_CHARACTERS) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ material name exceeds its character limit");
      }
      const existing = materialNameIndices.get(remainder);
      if (existing !== undefined) {
        currentMaterialIndex = existing;
        return;
      }
      if (materialNames.length >= MAX_MATERIALS ||
          retainedMaterialNameCharacters + remainder.length > MAX_RETAINED_MATERIAL_NAME_CHARACTERS) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ material names exceed their retained-memory limit");
      }
      currentMaterialIndex = materialNames.length;
      materialNames.push(remainder);
      materialNameIndices.set(remainder, currentMaterialIndex);
      retainedMaterialNameCharacters += remainder.length;
    } else if (directive === "vn") {
      if (parts.length < 3) throw new ObjToGaussianPlyError("invalid_obj", "OBJ normal is incomplete");
      if (normalCount >= counts.normals) {
        throw new ObjToGaussianPlyError("resource_limit", "OBJ changed while it was being parsed");
      }
      finiteNumber(parts[0]!, "OBJ normal");
      finiteNumber(parts[1]!, "OBJ normal");
      finiteNumber(parts[2]!, "OBJ normal");
      normalCount += 1;
    }
  });

  if (vertexCount === 0 || triangleCount === 0) {
    throw new ObjToGaussianPlyError("invalid_obj", "OBJ contains no non-degenerate triangle surface");
  }
  return Object.freeze({
    vertices: Object.freeze({ count: vertexCount, positions: positionValues, colors: colorValues, hasColor }),
    textureCoordinates: Object.freeze({ count: textureCoordinateCount, values: textureValues }),
    triangles: Object.freeze({
      count: triangleCount,
      vertexIndices: triangleVertexIndices,
      textureIndices: triangleTextureIndices,
      materialIndices: triangleMaterialIndices,
      areas: triangleAreas,
      normals: triangleNormals,
    }),
    materialNames: Object.freeze(materialNames),
    materialLibraries: Object.freeze(materialLibraries),
    skippedDegenerateTriangleCount,
    bounds: Object.freeze({
      min: Object.freeze([...bounds.min]) as Vec3,
      max: Object.freeze([...bounds.max]) as Vec3,
    }),
  });
}

function splitMtlMapReference(remainder: string): string {
  if (!remainder.startsWith("-")) return remainder.replace(/^"|"$/g, "");
  const tokens = remainder.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const argumentCounts: Readonly<Record<string, number>> = {
    "-blendu": 1,
    "-blendv": 1,
    "-boost": 1,
    "-bm": 1,
    "-cc": 1,
    "-clamp": 1,
    "-imfchan": 1,
    "-mm": 2,
    "-texres": 1,
    "-type": 1,
  };
  let index = 0;
  while (index < tokens.length && tokens[index]!.startsWith("-")) {
    const option = tokens[index]!.toLowerCase();
    if (option === "-o" || option === "-s" || option === "-t") {
      index += 1;
      let consumed = 0;
      while (index < tokens.length && consumed < 3 && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(tokens[index]!)) {
        index += 1;
        consumed += 1;
      }
      continue;
    }
    const count = argumentCounts[option];
    if (count === undefined || index + count >= tokens.length) {
      throw new ObjToGaussianPlyError("invalid_obj", "MTL texture map options are invalid");
    }
    index += count + 1;
  }
  const reference = tokens.slice(index).join(" ").replace(/^"|"$/g, "");
  if (!reference) throw new ObjToGaussianPlyError("invalid_obj", "MTL texture map path is empty");
  return reference;
}

async function parseMaterialLibraries(
  libraryPaths: readonly string[],
  assetRoot: string,
  signal?: AbortSignal,
): Promise<Map<string, MaterialDefinition>> {
  const materials = new Map<string, MaterialDefinition>();
  let retainedMaterialNameCharacters = 0;
  let retainedTextureReferenceCharacters = 0;
  for (const libraryPath of libraryPaths) {
    throwIfAborted(signal);
    await regularFile(libraryPath, MAX_MTL_BYTES, "MTL file");
    let text: string;
    try {
      text = await readFile(libraryPath, "utf8");
    } catch (cause) {
      throw new ObjToGaussianPlyError("invalid_obj", "Failed to read MTL file", { cause });
    }
    let current: MaterialDefinition | undefined;
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine.length > MAX_LINE_CHARACTERS) {
        throw new ObjToGaussianPlyError("resource_limit", "MTL contains an oversized line");
      }
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.search(/\s/);
      const directive = separator < 0 ? line : line.slice(0, separator);
      const remainder = separator < 0 ? "" : line.slice(separator).trim();
      const parts = remainder.split(/\s+/);
      if (directive === "newmtl") {
        if (!remainder) throw new ObjToGaussianPlyError("invalid_obj", "MTL material name is empty");
        if (remainder.length > MAX_MATERIAL_NAME_CHARACTERS) {
          throw new ObjToGaussianPlyError("resource_limit", "MTL material name exceeds its character limit");
        }
        if (!materials.has(remainder) && materials.size >= MAX_MATERIALS) {
          throw new ObjToGaussianPlyError("resource_limit", "MTL contains too many materials");
        }
        if (!materials.has(remainder)) {
          if (retainedMaterialNameCharacters + remainder.length > MAX_RETAINED_MATERIAL_NAME_CHARACTERS) {
            throw new ObjToGaussianPlyError("resource_limit", "MTL material names exceed their retained-memory limit");
          }
          retainedMaterialNameCharacters += remainder.length;
        }
        current = { color: Object.freeze([0.8, 0.8, 0.8]), alpha: 1 };
        materials.set(remainder, current);
      } else if (directive === "Kd" && current) {
        if (parts.length < 3) throw new ObjToGaussianPlyError("invalid_obj", "MTL diffuse color is incomplete");
        current.color = Object.freeze([
          clamp(finiteNumber(parts[0]!, "MTL diffuse color")),
          clamp(finiteNumber(parts[1]!, "MTL diffuse color")),
          clamp(finiteNumber(parts[2]!, "MTL diffuse color")),
        ]);
      } else if (directive === "d" && current) {
        current.alpha = clamp(finiteNumber(parts[0] ?? "", "MTL alpha"));
      } else if (directive === "Tr" && current) {
        current.alpha = 1 - clamp(finiteNumber(parts[0] ?? "", "MTL transparency"));
      } else if (directive === "map_Kd" && current) {
        const reference = splitMtlMapReference(remainder);
        if (reference.length > MAX_MATERIAL_LIBRARY_REFERENCE_CHARACTERS ||
            retainedTextureReferenceCharacters + reference.length > MAX_RETAINED_MTL_TEXTURE_REFERENCE_CHARACTERS) {
          throw new ObjToGaussianPlyError("resource_limit", "MTL texture references exceed their retained-memory limit");
        }
        current.textureReference = await resolveReference(assetRoot, dirname(libraryPath), reference);
        retainedTextureReferenceCharacters += reference.length;
      }
    }
  }
  return materials;
}

async function loadTexture(path: string, remainingDecodedBytes: number): Promise<Texture> {
  await regularFile(path, MAX_TEXTURE_BYTES, "Texture file");
  try {
    const decoderOptions = {
      failOn: "error",
      limitInputPixels: MAX_TEXTURE_PIXELS,
      sequentialRead: true,
    } as const;
    const metadata = await sharp(path, decoderOptions).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height * 4 > remainingDecodedBytes) {
      throw new ObjToGaussianPlyError("resource_limit", "Decoded OBJ textures exceed their byte limit");
    }
    const { data, info } = await sharp(path, decoderOptions)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width < 1 || info.height < 1 || info.channels !== 4 || data.byteLength > MAX_TEXTURE_BYTES) {
      throw new Error("decoded texture exceeded its limits");
    }
    return Object.freeze({ width: info.width, height: info.height, pixels: data });
  } catch (cause) {
    if (cause instanceof ObjToGaussianPlyError) throw cause;
    throw new ObjToGaussianPlyError("texture_error", "Failed to decode an OBJ texture", { cause });
  }
}

async function loadMaterials(
  definitions: Map<string, MaterialDefinition>,
  defaultColor: Rgb,
  signal?: AbortSignal,
): Promise<{ materials: Map<string, Material>; textureCount: number; fallback: Material }> {
  const textures = new Map<string, Texture>();
  const materials = new Map<string, Material>();
  let decodedTextureBytes = 0;
  for (const [name, definition] of definitions) {
    throwIfAborted(signal);
    let texture: Texture | undefined;
    if (definition.textureReference) {
      texture = textures.get(definition.textureReference);
      if (!texture) {
        texture = await loadTexture(
          definition.textureReference,
          MAX_DECODED_TEXTURE_BYTES - decodedTextureBytes,
        );
        textures.set(definition.textureReference, texture);
        decodedTextureBytes += texture.pixels.byteLength;
      }
    }
    materials.set(name, Object.freeze({
      color: definition.color,
      alpha: definition.alpha,
      ...(texture ? { texture } : {}),
    }));
  }
  return {
    materials,
    textureCount: textures.size,
    fallback: Object.freeze({ color: defaultColor, alpha: 1 }),
  };
}

function sampleTexture(texture: Texture, uv: Vec2): readonly [number, number, number, number] {
  const repeatedU = uv[0] - Math.floor(uv[0]);
  const repeatedV = uv[1] - Math.floor(uv[1]);
  const x = repeatedU * Math.max(0, texture.width - 1);
  const y = (1 - repeatedV) * Math.max(0, texture.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(texture.width - 1, x0 + 1);
  const y1 = Math.min(texture.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const pixel = (px: number, py: number, channel: number): number =>
    texture.pixels[(py * texture.width + px) * 4 + channel]! / 255;
  const channels = [0, 1, 2, 3].map((channel) => {
    const top = pixel(x0, y0, channel) * (1 - tx) + pixel(x1, y0, channel) * tx;
    const bottom = pixel(x0, y1, channel) * (1 - tx) + pixel(x1, y1, channel) * tx;
    return top * (1 - ty) + bottom * ty;
  });
  return [channels[0]!, channels[1]!, channels[2]!, channels[3]!];
}

function quaternionFromZ(normal: Vec3): readonly [number, number, number, number] {
  if (normal[2] < -0.999999) return [1, 0, 0, 0];
  const x = -normal[1];
  const y = normal[0];
  const z = 0;
  const w = 1 + normal[2];
  const length = Math.hypot(x, y, z, w);
  return [x / length, y / length, z, w / length];
}

function hash32(value: number): number {
  let hash = value | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return (hash ^ (hash >>> 15)) >>> 0;
}

function allocateSamples(triangles: PackedTriangles, target: number): Uint32Array {
  let totalArea = 0;
  for (let index = 0; index < triangles.count; index += 1) {
    totalArea += triangles.areas[index]!;
  }
  if (!Number.isFinite(totalArea) || totalArea <= 0) {
    throw new ObjToGaussianPlyError("invalid_obj", "OBJ surface area is invalid");
  }
  const counts = new Uint32Array(triangles.count);
  let cumulativeArea = 0;
  let allocated = 0;
  for (let index = 0; index < triangles.count; index += 1) {
    cumulativeArea += triangles.areas[index]!;
    const nextAllocated = index === triangles.count - 1
      ? target
      : Math.floor(cumulativeArea / totalArea * target);
    const count = nextAllocated - allocated;
    counts[index] = count;
    allocated = nextAllocated;
  }
  return counts;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) {
      throw new ObjToGaussianPlyError("invalid_request", "Gaussian PLY output stopped accepting bytes");
    }
    offset += bytesWritten;
  }
}

async function reserveOutputBytes(
  reserve: ObjToGaussianPlyOptions["reserveOutputBytes"],
  remainingOutputBytes: number,
): Promise<void> {
  if (!reserve) return;
  try {
    await reserve(remainingOutputBytes);
  } catch (cause) {
    if (cause instanceof ObjToGaussianPlyError) throw cause;
    throw new ObjToGaussianPlyError(
      "resource_limit",
      "Gaussian PLY storage capacity could not be reserved safely",
      { cause },
    );
  }
}

function validateDefaultColor(value: Rgb | undefined): Rgb {
  const color = value ?? [0.8, 0.8, 0.8];
  if (color.length !== 3 || color.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 1)) {
    throw new ObjToGaussianPlyError("invalid_request", "Default OBJ color must contain three values in [0, 1]");
  }
  return Object.freeze([color[0], color[1], color[2]]);
}

function plyHeader(splatCount: number): Buffer {
  const properties = [
    "x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2",
  ];
  return Buffer.from([
    "ply",
    "format binary_little_endian 1.0",
    "comment semaframe source_units unknown",
    "comment semaframe source_axes unknown",
    `element vertex ${splatCount}`,
    ...properties.map((name) => `property float ${name}`),
    "end_header",
    "",
  ].join("\n"), "ascii");
}

function interpolate3(values: readonly Vec3[], weights: readonly [number, number, number]): Vec3 {
  return [
    values[0]![0] * weights[0] + values[1]![0] * weights[1] + values[2]![0] * weights[2],
    values[0]![1] * weights[0] + values[1]![1] * weights[1] + values[2]![1] * weights[2],
    values[0]![2] * weights[0] + values[1]![2] * weights[1] + values[2]![2] * weights[2],
  ];
}

function interpolate2(values: readonly Vec2[], weights: readonly [number, number, number]): Vec2 {
  return [
    values[0]![0] * weights[0] + values[1]![0] * weights[1] + values[2]![0] * weights[2],
    values[0]![1] * weights[0] + values[1]![1] * weights[1] + values[2]![1] * weights[2],
  ];
}

export async function objToGaussianPly(options: ObjToGaussianPlyOptions): Promise<ObjToGaussianPlyResult> {
  throwIfAborted(options.signal);
  if ([options.objPath, options.outputPath, options.assetRoot].some((path) => path?.includes("\0"))) {
    throw new ObjToGaussianPlyError("invalid_request", "OBJ conversion paths must not contain NUL bytes");
  }
  if (!isAbsolute(options.objPath) || !isAbsolute(options.outputPath) ||
      (options.assetRoot !== undefined && !isAbsolute(options.assetRoot))) {
    throw new ObjToGaussianPlyError("invalid_request", "OBJ, output, and asset-root paths must be absolute");
  }
  const maxSplats = validPositiveInteger(options.maxSplats, MAX_SPLATS, MAX_SPLATS, "Maximum splat count");
  const maxBytes = validPositiveInteger(options.maxBytes, MAX_ASSET_BYTES, MAX_ASSET_BYTES, "Maximum PLY bytes");
  const maxStructuralBytes = validPositiveInteger(
    options.maxStructuralBytes,
    MAX_OBJ_STRUCTURAL_BYTES,
    MAX_OBJ_STRUCTURAL_BYTES,
    "Maximum packed OBJ structural bytes",
  );
  const defaultColor = validateDefaultColor(options.defaultColor);
  await regularFile(options.objPath, MAX_OBJ_BYTES, "OBJ file");

  const objPath = await realpath(options.objPath);
  const requestedAssetRoot = resolve(options.assetRoot ?? dirname(objPath));
  let requestedRootInfo;
  try {
    requestedRootInfo = await lstat(requestedAssetRoot);
  } catch (cause) {
    throw new ObjToGaussianPlyError("invalid_request", "OBJ asset root does not exist", { cause });
  }
  if (!requestedRootInfo.isDirectory() || requestedRootInfo.isSymbolicLink()) {
    throw new ObjToGaussianPlyError("unsafe_reference", "OBJ asset root must be a non-symlink directory");
  }
  const assetRoot = await realpath(requestedAssetRoot);
  const rootInfo = await lstat(assetRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !pathContains(assetRoot, objPath)) {
    throw new ObjToGaussianPlyError("unsafe_reference", "OBJ must be inside its non-symlink asset root");
  }
  const outputPath = resolve(options.outputPath);
  if (outputPath === objPath) {
    throw new ObjToGaussianPlyError(
      "invalid_request",
      "Gaussian PLY output must not overwrite its OBJ source",
    );
  }
  try {
    await access(outputPath, fsConstants.F_OK);
    throw new ObjToGaussianPlyError("output_exists", "Gaussian PLY output already exists");
  } catch (cause) {
    if (cause instanceof ObjToGaussianPlyError) throw cause;
  }

  // The first streaming pass rejects structural expansion before allocating any
  // retained vertex/UV/triangle buffers. The second pass fills exact-size packed
  // arrays, avoiding the multi-gigabyte boxed-object graph possible previously.
  const structure = await scanObjStructure(objPath, maxStructuralBytes, options.signal);
  const parsed = await parseObj(objPath, structure, options.signal);
  const libraryPaths: string[] = [];
  for (const reference of parsed.materialLibraries) {
    const path = await resolveReference(assetRoot, dirname(objPath), reference);
    if (!libraryPaths.includes(path)) libraryPaths.push(path);
  }
  const definitions = await parseMaterialLibraries(libraryPaths, assetRoot, options.signal);
  const loaded = await loadMaterials(definitions, defaultColor, options.signal);

  const headerForBudget = plyHeader(1);
  const byteBudgetSplats = Math.floor((maxBytes - headerForBudget.byteLength - 16) / BYTES_PER_SPLAT);
  const maximumOutputSplats = Math.min(maxSplats, byteBudgetSplats);
  if (maximumOutputSplats < 1) {
    throw new ObjToGaussianPlyError("resource_limit", "PLY byte limit cannot hold one Gaussian splat");
  }
  const defaultTarget = Math.max(4_096, Math.min(1_000_000, parsed.triangles.count * 4));
  const requestedTarget = options.targetSplatCount === undefined
    ? defaultTarget
    : validPositiveInteger(options.targetSplatCount, defaultTarget, MAX_SPLATS, "Target splat count");
  const splatCount = Math.min(requestedTarget, maximumOutputSplats);
  const header = plyHeader(splatCount);
  const byteLength = header.byteLength + splatCount * BYTES_PER_SPLAT;
  if (byteLength > maxBytes) {
    throw new ObjToGaussianPlyError("resource_limit", "Gaussian PLY exceeds its byte limit");
  }
  const allocations = allocateSamples(parsed.triangles, splatCount);

  let handle: FileHandle | undefined;
  let createdOutput = false;
  let writtenOutputBytes = 0;
  try {
    await reserveOutputBytes(options.reserveOutputBytes, byteLength);
    throwIfAborted(options.signal);
    handle = await open(outputPath, "wx", 0o600);
    createdOutput = true;
    await writeAll(handle, header);
    writtenOutputBytes += header.byteLength;
    const batchSplats = 4_096;
    let buffer = Buffer.allocUnsafe(Math.min(batchSplats, splatCount) * BYTES_PER_SPLAT);
    let rows = 0;
    let outputIndex = 0;
    const flush = async (): Promise<void> => {
      if (rows === 0) return;
      const bytes = buffer.subarray(0, rows * BYTES_PER_SPLAT);
      await reserveOutputBytes(options.reserveOutputBytes, byteLength - writtenOutputBytes);
      throwIfAborted(options.signal);
      await writeAll(handle!, bytes);
      writtenOutputBytes += bytes.byteLength;
      rows = 0;
    };

    for (let triangleIndex = 0; triangleIndex < parsed.triangles.count; triangleIndex += 1) {
      const count = allocations[triangleIndex]!;
      if (count === 0) continue;
      const triangleOffset = triangleIndex * 3;
      const vertexIndices = [
        parsed.triangles.vertexIndices[triangleOffset]!,
        parsed.triangles.vertexIndices[triangleOffset + 1]!,
        parsed.triangles.vertexIndices[triangleOffset + 2]!,
      ] as const;
      const positions = vertexIndices.map((index) => packedVec3(parsed.vertices.positions, index));
      const triangleTextureIndices = [
        parsed.triangles.textureIndices[triangleOffset]!,
        parsed.triangles.textureIndices[triangleOffset + 1]!,
        parsed.triangles.textureIndices[triangleOffset + 2]!,
      ] as const;
      const textureCoordinates = triangleTextureIndices.every((index) => index >= 0)
        ? triangleTextureIndices.map((index) => packedVec2(parsed.textureCoordinates.values, index))
        : undefined;
      const vertexColors = vertexIndices.every((index) => parsed.vertices.hasColor[index] === 1)
        ? vertexIndices.map((index) => packedVec3(parsed.vertices.colors, index))
        : undefined;
      const materialIndex = parsed.triangles.materialIndices[triangleIndex]!;
      const materialName = materialIndex >= 0 ? parsed.materialNames[materialIndex] : undefined;
      const material = materialName
        ? loaded.materials.get(materialName) ?? loaded.fallback
        : loaded.fallback;
      const quaternion = quaternionFromZ(packedVec3(parsed.triangles.normals, triangleIndex));
      const radius = Math.max(1e-9, Math.sqrt(parsed.triangles.areas[triangleIndex]! / count) * 0.65);
      const tangentScale = Math.log(radius);
      const normalScale = Math.log(Math.max(1e-10, radius * 0.2));

      for (let localIndex = 0; localIndex < count; localIndex += 1) {
        if ((outputIndex & 0xfff) === 0) throwIfAborted(options.signal);
        const first = (localIndex + 0.5) / count;
        const second = (hash32((triangleIndex + 1) * 0x1f123bb5 ^ localIndex) + 0.5) / 0x1_0000_0000;
        const root = Math.sqrt(first);
        const weights: readonly [number, number, number] = [
          1 - root,
          root * (1 - second),
          root * second,
        ];
        const position = interpolate3(positions, weights);
        let rgb: Rgb = material.color;
        let alpha = material.alpha;
        if (material.texture && textureCoordinates) {
          const sampled = sampleTexture(material.texture, interpolate2(textureCoordinates, weights));
          rgb = [sampled[0], sampled[1], sampled[2]];
          alpha *= sampled[3];
        } else if (vertexColors) {
          rgb = interpolate3(vertexColors, weights);
        }
        alpha = clamp(alpha, 0.01, 0.99);
        const opacity = Math.log(alpha / (1 - alpha));
        const values = [
          position[0], position[1], position[2], opacity,
          tangentScale, tangentScale, normalScale,
          quaternion[0], quaternion[1], quaternion[2], quaternion[3],
          (clamp(rgb[0]) - 0.5) / SH_C0,
          (clamp(rgb[1]) - 0.5) / SH_C0,
          (clamp(rgb[2]) - 0.5) / SH_C0,
        ];
        const rowOffset = rows * BYTES_PER_SPLAT;
        for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
          buffer.writeFloatLE(values[valueIndex]!, rowOffset + valueIndex * 4);
        }
        rows += 1;
        outputIndex += 1;
        if (rows === batchSplats) {
          await flush();
          const remaining = splatCount - outputIndex;
          if (remaining > 0 && remaining < batchSplats) {
            buffer = Buffer.allocUnsafe(remaining * BYTES_PER_SPLAT);
          }
        }
      }
    }
    await flush();
    if (outputIndex !== splatCount) {
      throw new ObjToGaussianPlyError("invalid_obj", "OBJ sample allocation was inconsistent");
    }
    if (writtenOutputBytes !== byteLength) {
      throw new ObjToGaussianPlyError("invalid_obj", "Gaussian PLY byte accounting was inconsistent");
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    if (createdOutput) await unlink(outputPath).catch(() => undefined);
    if (cause instanceof ObjToGaussianPlyError) throw cause;
    throw new ObjToGaussianPlyError("invalid_request", "Failed to write Gaussian PLY", { cause });
  }

  return Object.freeze({
    outputPath,
    splatCount,
    byteLength,
    sourceTriangleCount: parsed.triangles.count,
    skippedDegenerateTriangleCount: parsed.skippedDegenerateTriangleCount,
    textureCount: loaded.textureCount,
    bounds: parsed.bounds,
    units: "unknown",
    axes: "unknown",
  });
}
