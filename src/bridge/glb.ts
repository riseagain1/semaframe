import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  PlaneGeometry,
  SphereGeometry,
  type BufferGeometry,
} from "three";
import type { JSONObject, World3DPlacement } from "../workspace/components/componentTypes";
import type { ParametricPrimitive } from "../workspace/modeling/parametricGeometry";

export type SemaFrameGlbNode = Readonly<{
  id: string;
  label: string;
  parentId?: string;
  componentType: string;
  placement: World3DPlacement;
  primitive?: ParametricPrimitive;
  material?: JSONObject;
  visible: boolean;
}>;

export type SemaFrameGlbResult = Readonly<{
  bytes: Uint8Array;
  nodeIndexes: Readonly<Record<string, number>>;
}>;

type GltfAccessor = {
  bufferView: number;
  componentType: number;
  count: number;
  type: "SCALAR" | "VEC3";
  min?: number[];
  max?: number[];
};

type GltfNode = {
  name: string;
  translation: number[];
  rotation: number[];
  scale: number[];
  children?: number[];
  mesh?: number;
  extras: Readonly<Record<string, unknown>>;
};

type GltfMaterial = {
  name: string;
  pbrMetallicRoughness: {
    baseColorFactor: number[];
    metallicFactor: number;
    roughnessFactor: number;
  };
  emissiveFactor: number[];
  alphaMode?: "BLEND";
  doubleSided: boolean;
};

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const ARRAY_BUFFER_TARGET = 34962;
const ELEMENT_ARRAY_BUFFER_TARGET = 34963;
const FLOAT_COMPONENT = 5126;
const UNSIGNED_SHORT_COMPONENT = 5123;
const UNSIGNED_INT_COMPONENT = 5125;

function alignedLength(length: number): number {
  return (length + 3) & ~3;
}

function quaternionFromEuler(rotation: World3DPlacement["rotation"]): number[] {
  const cx = Math.cos(rotation.x / 2);
  const sx = Math.sin(rotation.x / 2);
  const cy = Math.cos(rotation.y / 2);
  const sy = Math.sin(rotation.y / 2);
  const cz = Math.cos(rotation.z / 2);
  const sz = Math.sin(rotation.z / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

function geometryFor(primitive: ParametricPrimitive): BufferGeometry {
  let geometry: BufferGeometry;
  switch (primitive.kind) {
    case "box":
      geometry = new BoxGeometry(primitive.sizeM.x, primitive.sizeM.y, primitive.sizeM.z);
      break;
    case "sphere":
      geometry = new SphereGeometry(primitive.radiusM, 32, 20);
      break;
    case "cylinder":
      geometry = new CylinderGeometry(primitive.radiusM, primitive.radiusM, primitive.heightM, 32, 1, false);
      if (primitive.axis === "x") geometry.rotateZ(-Math.PI / 2);
      if (primitive.axis === "z") geometry.rotateX(Math.PI / 2);
      break;
    case "cone":
      geometry = new ConeGeometry(primitive.radiusM, primitive.heightM, 32, 1, false);
      if (primitive.axis === "x") geometry.rotateZ(-Math.PI / 2);
      if (primitive.axis === "z") geometry.rotateX(Math.PI / 2);
      break;
    case "capsule":
      geometry = new CapsuleGeometry(primitive.radiusM, primitive.cylinderHeightM, 8, 20);
      if (primitive.axis === "x") geometry.rotateZ(-Math.PI / 2);
      if (primitive.axis === "z") geometry.rotateX(Math.PI / 2);
      break;
    case "plane":
      geometry = new PlaneGeometry(primitive.sizeM.x, primitive.sizeM.y);
      if (primitive.normalAxis === "x") geometry.rotateY(Math.PI / 2);
      if (primitive.normalAxis === "y") geometry.rotateX(-Math.PI / 2);
      break;
  }
  return geometry;
}

function finiteUnit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function color(value: unknown, fallback: string): [number, number, number] {
  const text = typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
  return [
    linearChannel(Number.parseInt(text.slice(1, 3), 16)),
    linearChannel(Number.parseInt(text.slice(3, 5), 16)),
    linearChannel(Number.parseInt(text.slice(5, 7), 16)),
  ];
}

function gltfMaterial(id: string, props: JSONObject | undefined): GltfMaterial {
  const material = props ?? {};
  const base = color(material.baseColor, "#68D5FF");
  const emissive = color(material.emissiveColor, "#000000");
  const opacity = finiteUnit(material.opacity, 1);
  return {
    name: `${id} material`,
    pbrMetallicRoughness: {
      baseColorFactor: [...base, opacity],
      metallicFactor: finiteUnit(material.metallic, 0),
      roughnessFactor: finiteUnit(material.roughness, 0.55),
    },
    emissiveFactor: emissive,
    ...(opacity < 1 ? { alphaMode: "BLEND" as const } : {}),
    doubleSided: true,
  };
}

function floatAttribute(geometry: BufferGeometry, name: "position" | "normal"): Float32Array {
  const attribute = geometry.getAttribute(name);
  if (!attribute || attribute.itemSize !== 3) throw new TypeError(`Geometry is missing ${name}`);
  const values = new Float32Array(attribute.count * 3);
  for (let index = 0; index < attribute.count; index += 1) {
    values[index * 3] = attribute.getX(index);
    values[index * 3 + 1] = attribute.getY(index);
    values[index * 3 + 2] = attribute.getZ(index);
  }
  return values;
}

function indexAttribute(geometry: BufferGeometry, vertexCount: number): Uint16Array | Uint32Array {
  const source = geometry.getIndex();
  const count = source?.count ?? vertexCount;
  const maximum = source
    ? Array.from({ length: count }, (_, index) => source.getX(index)).reduce((left, right) => Math.max(left, right), 0)
    : vertexCount - 1;
  const values = maximum <= 0xffff ? new Uint16Array(count) : new Uint32Array(count);
  for (let index = 0; index < count; index += 1) values[index] = source?.getX(index) ?? index;
  return values;
}

function vectorBounds(values: Float32Array): { min: number[]; max: number[] } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < values.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], values[index + axis]);
      max[axis] = Math.max(max[axis], values[index + axis]);
    }
  }
  return { min, max };
}

function appendBinary(chunks: Uint8Array[], bytes: Uint8Array): { offset: number; length: number } {
  const offset = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const padded = new Uint8Array(alignedLength(bytes.byteLength));
  padded.set(bytes);
  chunks.push(padded);
  return { offset, length: bytes.byteLength };
}

function typedBytes(values: ArrayBufferView): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function buildGlb(json: Record<string, unknown>, binary: Uint8Array): Uint8Array {
  const jsonSource = new TextEncoder().encode(JSON.stringify(json));
  const jsonChunk = new Uint8Array(alignedLength(jsonSource.byteLength));
  jsonChunk.fill(0x20);
  jsonChunk.set(jsonSource);
  const binaryChunk = new Uint8Array(alignedLength(binary.byteLength));
  binaryChunk.set(binary);
  const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binaryChunk.byteLength;
  const result = new Uint8Array(totalLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonChunk.byteLength, true);
  view.setUint32(16, JSON_CHUNK_TYPE, true);
  result.set(jsonChunk, 20);
  const binaryHeader = 20 + jsonChunk.byteLength;
  view.setUint32(binaryHeader, binaryChunk.byteLength, true);
  view.setUint32(binaryHeader + 4, BIN_CHUNK_TYPE, true);
  result.set(binaryChunk, binaryHeader + 8);
  return result;
}

/** Build a deterministic, self-contained glTF 2.0 binary for world-space primitives. */
export function createSemaFrameGlb(input: readonly SemaFrameGlbNode[]): SemaFrameGlbResult {
  const ordered = [...input].sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(ordered.map((node) => node.id)).size !== ordered.length) {
    throw new TypeError("GLB nodes must have unique stable IDs");
  }
  const nodeIndexes = Object.freeze(Object.fromEntries(ordered.map((node, index) => [node.id, index])));
  const nodes: GltfNode[] = ordered.map((node) => ({
    name: node.label,
    translation: [node.placement.position.x, node.placement.position.y, node.placement.position.z],
    rotation: quaternionFromEuler(node.placement.rotation),
    scale: [node.placement.scale.x, node.placement.scale.y, node.placement.scale.z],
    extras: Object.freeze({
      semaframeStableId: node.id,
      semaframeComponentType: node.componentType,
      semaframeVisible: node.visible,
    }),
  }));
  for (const [index, node] of ordered.entries()) {
    const children = ordered
      .map((candidate, childIndex) => candidate.parentId === node.id ? childIndex : undefined)
      .filter((child): child is number => child !== undefined);
    if (children.length) nodes[index].children = children;
  }

  const binaryChunks: Uint8Array[] = [];
  const bufferViews: Array<{ buffer: 0; byteOffset: number; byteLength: number; target: number }> = [];
  const accessors: GltfAccessor[] = [];
  const meshes: Array<{ name: string; primitives: Array<{ attributes: { POSITION: number; NORMAL: number }; indices: number; material: number }> }> = [];
  const materials: GltfMaterial[] = [];
  for (const [nodeIndex, node] of ordered.entries()) {
    if (!node.primitive) continue;
    const geometry = geometryFor(node.primitive);
    try {
      const positions = floatAttribute(geometry, "position");
      const normals = floatAttribute(geometry, "normal");
      const indices = indexAttribute(geometry, positions.length / 3);
      const positionBlock = appendBinary(binaryChunks, typedBytes(positions));
      const normalBlock = appendBinary(binaryChunks, typedBytes(normals));
      const indexBlock = appendBinary(binaryChunks, typedBytes(indices));
      const positionView = bufferViews.push({ buffer: 0, byteOffset: positionBlock.offset, byteLength: positionBlock.length, target: ARRAY_BUFFER_TARGET }) - 1;
      const normalView = bufferViews.push({ buffer: 0, byteOffset: normalBlock.offset, byteLength: normalBlock.length, target: ARRAY_BUFFER_TARGET }) - 1;
      const indexView = bufferViews.push({ buffer: 0, byteOffset: indexBlock.offset, byteLength: indexBlock.length, target: ELEMENT_ARRAY_BUFFER_TARGET }) - 1;
      const bounds = vectorBounds(positions);
      const positionAccessor = accessors.push({
        bufferView: positionView,
        componentType: FLOAT_COMPONENT,
        count: positions.length / 3,
        type: "VEC3",
        min: bounds.min,
        max: bounds.max,
      }) - 1;
      const normalAccessor = accessors.push({
        bufferView: normalView,
        componentType: FLOAT_COMPONENT,
        count: normals.length / 3,
        type: "VEC3",
      }) - 1;
      const indexAccessor = accessors.push({
        bufferView: indexView,
        componentType: indices instanceof Uint16Array ? UNSIGNED_SHORT_COMPONENT : UNSIGNED_INT_COMPONENT,
        count: indices.length,
        type: "SCALAR",
      }) - 1;
      const material = materials.push(gltfMaterial(node.id, node.material)) - 1;
      const mesh = meshes.push({
        name: `${node.label} geometry`,
        primitives: [{
          attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
          indices: indexAccessor,
          material,
        }],
      }) - 1;
      nodes[nodeIndex].mesh = mesh;
    } finally {
      geometry.dispose();
    }
  }
  const binary = joinBytes(binaryChunks);
  const roots = ordered
    .map((node, index) => !node.parentId || nodeIndexes[node.parentId] === undefined ? index : undefined)
    .filter((index): index is number => index !== undefined);
  const json = {
    asset: { version: "2.0", generator: "SemaFrame Scene Exchange 1.0" },
    scene: 0,
    scenes: [{ name: "SemaFrame Workspace", nodes: roots }],
    nodes,
    ...(meshes.length ? { meshes, materials, bufferViews, accessors } : {}),
    buffers: [{ byteLength: binary.byteLength }],
  };
  return Object.freeze({ bytes: buildGlb(json, binary), nodeIndexes });
}
