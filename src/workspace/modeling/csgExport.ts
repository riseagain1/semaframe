import {
  CSG_EVALUATION_LIMITS,
  CsgEvaluationError,
  type CsgIndexedMesh,
} from "./csgEvaluator";

export const CSG_EXPORT_LIMITS = Object.freeze({
  defaultMaximumBytes: 64 * 1024 * 1024,
  hardMaximumBytes: 128 * 1024 * 1024,
});

export type CsgMeshExportOptions = Readonly<{
  name?: string;
  maxBytes?: number;
}>;

function normalizeMaxBytes(value: number | undefined): number {
  const resolved = value ?? CSG_EXPORT_LIMITS.defaultMaximumBytes;
  if (!Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > CSG_EXPORT_LIMITS.hardMaximumBytes) {
    throw new CsgEvaluationError(
      "invalid_options",
      `maxBytes must be an integer between 1 and ${CSG_EXPORT_LIMITS.hardMaximumBytes}`,
    );
  }
  return resolved;
}

function validateMesh(mesh: CsgIndexedMesh): void {
  if (mesh.positions.length % 3 !== 0 || mesh.indices.length % 3 !== 0) {
    throw new CsgEvaluationError("kernel_error", "CSG mesh arrays must contain complete xyz/triangle tuples");
  }
  const vertexCount = mesh.positions.length / 3;
  const triangleCount = mesh.indices.length / 3;
  if (vertexCount !== mesh.vertexCount || triangleCount !== mesh.triangleCount) {
    throw new CsgEvaluationError("kernel_error", "CSG mesh counts disagree with its arrays");
  }
  if (vertexCount > CSG_EVALUATION_LIMITS.hardMaximumVertices
    || triangleCount > CSG_EVALUATION_LIMITS.hardMaximumTriangles) {
    throw new CsgEvaluationError("mesh_limit_exceeded", "CSG mesh exceeds hard export limits");
  }
  for (const value of mesh.positions) {
    if (!Number.isFinite(value)) {
      throw new CsgEvaluationError("kernel_error", "CSG mesh contains a non-finite vertex");
    }
  }
  for (const index of mesh.indices) {
    if (index >= vertexCount) {
      throw new CsgEvaluationError("kernel_error", "CSG mesh contains an out-of-range index");
    }
  }
}

function safeName(value: string | undefined): string {
  const normalized = (value ?? "semaframe-csg")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "semaframe-csg";
}

function objNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  return Number(value.toPrecision(9)).toString();
}

/** Export a deterministic, metre-scaled Wavefront OBJ string. */
export function exportCsgMeshToObj(
  mesh: CsgIndexedMesh,
  options: CsgMeshExportOptions = {},
): string {
  validateMesh(mesh);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const lines: string[] = [
    "# SemaFrame bounded CSG indexed mesh (metres)",
    `o ${safeName(options.name)}`,
  ];
  let approximateBytes = lines[0]!.length + lines[1]!.length + 2;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const line = `v ${objNumber(mesh.positions[index]!)} ${objNumber(mesh.positions[index + 1]!)} ${objNumber(mesh.positions[index + 2]!)}`;
    approximateBytes += line.length + 1;
    if (approximateBytes > maxBytes) {
      throw new CsgEvaluationError("mesh_limit_exceeded", "OBJ export exceeds maxBytes");
    }
    lines.push(line);
  }
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const line = `f ${mesh.indices[index]! + 1} ${mesh.indices[index + 1]! + 1} ${mesh.indices[index + 2]! + 1}`;
    approximateBytes += line.length + 1;
    if (approximateBytes > maxBytes) {
      throw new CsgEvaluationError("mesh_limit_exceeded", "OBJ export exceeds maxBytes");
    }
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

function faceNormal(
  positions: Float32Array,
  aIndex: number,
  bIndex: number,
  cIndex: number,
): readonly [number, number, number] {
  const ax = positions[aIndex * 3]!;
  const ay = positions[aIndex * 3 + 1]!;
  const az = positions[aIndex * 3 + 2]!;
  const abx = positions[bIndex * 3]! - ax;
  const aby = positions[bIndex * 3 + 1]! - ay;
  const abz = positions[bIndex * 3 + 2]! - az;
  const acx = positions[cIndex * 3]! - ax;
  const acy = positions[cIndex * 3 + 1]! - ay;
  const acz = positions[cIndex * 3 + 2]! - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz);
  if (length === 0) return [0, 0, 0];
  return [nx / length, ny / length, nz / length];
}

/**
 * Export standard little-endian binary STL in millimetres. STL has no
 * normative unit field and slicers conventionally interpret coordinates as
 * millimetres, so SI-metre evaluation coordinates are scaled by 1,000 here.
 */
export function exportCsgMeshToBinaryStl(
  mesh: CsgIndexedMesh,
  options: CsgMeshExportOptions = {},
): Uint8Array {
  validateMesh(mesh);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const byteLength = 84 + mesh.triangleCount * 50;
  if (byteLength > maxBytes) {
    throw new CsgEvaluationError("mesh_limit_exceeded", "Binary STL export exceeds maxBytes");
  }
  const bytes = new Uint8Array(byteLength);
  const header = new TextEncoder().encode(`SemaFrame CSG millimetres ${safeName(options.name)}`);
  bytes.set(header.subarray(0, 80), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, mesh.triangleCount, true);
  let offset = 84;
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const a = mesh.indices[triangle * 3]!;
    const b = mesh.indices[triangle * 3 + 1]!;
    const c = mesh.indices[triangle * 3 + 2]!;
    const normal = faceNormal(mesh.positions, a, b, c);
    for (const value of normal) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    for (const vertex of [a, b, c]) {
      view.setFloat32(offset, mesh.positions[vertex * 3]! * 1_000, true);
      view.setFloat32(offset + 4, mesh.positions[vertex * 3 + 1]! * 1_000, true);
      view.setFloat32(offset + 8, mesh.positions[vertex * 3 + 2]! * 1_000, true);
      offset += 12;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return bytes;
}
