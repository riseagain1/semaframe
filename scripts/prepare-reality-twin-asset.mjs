#!/usr/bin/env node

/**
 * Prepare the fourth-demo Reality Twin asset from Smithsonian CC0 source data.
 *
 * The output is a deterministic, textured 3D Gaussian PLY derived from two
 * official, non-Draco GLBs (body + lid). Large source/output files live under
 * git-ignored artifacts/. A compact provenance and conversion record is kept
 * under video/public/reality-twin/asset-evidence.json.
 *
 * Usage:
 *   node scripts/prepare-reality-twin-asset.mjs
 *   node scripts/prepare-reality-twin-asset.mjs --splats 1500000 --offline
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { realityTwinMetadataText } from "./reality-twin-metadata-text.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const ARTIFACT_ROOT = resolve(REPOSITORY_ROOT, "artifacts/reality-twin");
const SOURCE_ROOT = resolve(ARTIFACT_ROOT, "source");
const EVIDENCE_PATH = resolve(
  REPOSITORY_ROOT,
  "video/public/reality-twin/asset-evidence.json",
);

const PACKAGE_UUID = "d8c646aa-4ebc-11ea-b77f-2e728ce88125";
const RECORD_ID = "fsg_F1961.33a-b";
const ACCESSION = "F1961.33a-b";
const OBJECT_PAGE = `https://3d.si.edu/object/3d/ritual-wine-ewer-gong-masks-taotie-dragons-and-real-animals%3A${PACKAGE_UUID}`;
const RECORD_PAGE = "https://asia.si.edu/object/F1961.33a-b/";
const FILE_CATALOG_URL = `https://3d-api.si.edu/api/v1.0/content/file/search?model_url=${PACKAGE_UUID}&rows=1000`;
const OPEN_ACCESS_URL = `https://api.si.edu/openaccess/api/v1.0/search?q=${encodeURIComponent(ACCESSION)}&api_key=DEMO_KEY&rows=10`;

const SOURCE_SPECS = Object.freeze([
  Object.freeze({
    part: "lid",
    fileName: "ewer-part-01.glb",
    remoteFileName: "f1961_33-part_01-laser-ortery_texture-150k-4096_std.glb",
    bytes: 11_548_844,
    sha256: "80f28188353f11e3ceebd8cfe79c9e7159d9c5b511d1d0b2741f1458fbbd0e80",
  }),
  Object.freeze({
    part: "body",
    fileName: "ewer-part-02.glb",
    remoteFileName: "f1961_33-part_02-x_pol-ort_texture-150k-4096_std.glb",
    bytes: 12_736_888,
    sha256: "143277b0b40b82a7ee7f96fed09cfc85813de49dba14b6b1b3d1d239d63ad616",
  }),
]);

const PUBLISHED_METRES = Object.freeze({ height: 0.322, width: 0.322, depth: 0.157 });
const DEFAULT_SPLAT_COUNT = 1_500_000;
const MAXIMUM_SPLAT_COUNT = 4_000_000;
const MAXIMUM_OUTPUT_BYTES = 256 * 1024 * 1024;
const RECORD_FLOATS = 14;
const RECORD_BYTES = RECORD_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const SH_C0 = 0.28209479177387814;
const OPACITY = 0.97;
const LOGIT_OPACITY = Math.log(OPACITY / (1 - OPACITY));

function parseArguments(argv) {
  const parsed = { offline: false, splatCount: DEFAULT_SPLAT_COUNT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--offline") {
      parsed.offline = true;
      continue;
    }
    if (argument === "--splats") {
      const raw = argv[index + 1];
      if (!raw || !/^[0-9]+$/.test(raw)) throw new Error("--splats requires an integer");
      parsed.splatCount = Number(raw);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(parsed.splatCount) || parsed.splatCount < 1) {
    throw new Error("Splat count must be a positive safe integer");
  }
  if (parsed.splatCount > MAXIMUM_SPLAT_COUNT) {
    throw new Error(`Splat count exceeds Semaframe's ${MAXIMUM_SPLAT_COUNT} limit`);
  }
  return parsed;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

async function fetchJson(url, cachePath, offline) {
  if (offline) {
    if (!existsSync(cachePath)) throw new Error(`Offline cache is missing: ${cachePath}`);
    return JSON.parse(readFileSync(cachePath, "utf8"));
  }
  const response = await fetch(url, {
    headers: { "User-Agent": "Semaframe-Reality-Twin-Asset/1.0" },
  });
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${url}`);
  const value = await response.json();
  writeFileSync(cachePath, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function downloadFile(url, path, expectedBytes, expectedSha256, offline) {
  if (!existsSync(path)) {
    if (offline) throw new Error(`Offline source is missing: ${path}`);
    const response = await fetch(url, {
      headers: { "User-Agent": "Semaframe-Reality-Twin-Asset/1.0" },
    });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = statSync(path).size;
  const sha256 = sha256File(path);
  if (bytes !== expectedBytes || sha256 !== expectedSha256) {
    throw new Error(
      `Source integrity mismatch for ${basename(path)}: got ${bytes} B / ${sha256}`,
    );
  }
  return { bytes, sha256 };
}

function freetextValue(record, group, label) {
  const entry = record.content?.freetext?.[group]?.find((item) => item.label === label);
  if (!entry?.content) throw new Error(`Smithsonian record is missing ${group}/${label}`);
  return realityTwinMetadataText(entry.content);
}

function selectOfficialRecord(openAccess) {
  const rows = openAccess.response?.rows;
  if (!Array.isArray(rows)) throw new Error("Smithsonian Open Access response has no rows");
  const record = rows.find(
    (candidate) => candidate.content?.descriptiveNonRepeating?.record_ID === RECORD_ID,
  );
  if (!record) throw new Error(`Smithsonian record ${RECORD_ID} was not found`);
  const repeating = record.content.descriptiveNonRepeating;
  const media = repeating.online_media?.media?.find(
    (item) => item.id === `3d_package:${PACKAGE_UUID}`,
  );
  if (!media) throw new Error(`Smithsonian 3D package ${PACKAGE_UUID} was not found`);
  const metadataAccess = repeating.metadata_usage?.access;
  const objectAccess = freetextValue(record, "objectRights", "Restrictions & Rights");
  if (metadataAccess !== "CC0" || media.usage?.access !== "CC0" || objectAccess !== "CC0") {
    throw new Error("The Smithsonian record no longer reports CC0 on every required surface");
  }
  return { record, media };
}

function selectCatalogEntries(catalog, media) {
  if (!Array.isArray(catalog.rows)) throw new Error("Smithsonian 3D file catalog has no rows");
  return SOURCE_SPECS.map((spec) => {
    const row = catalog.rows.find(
      (candidate) => candidate.content?.usage === "Download3D"
        && candidate.content?.file_type === "GLB"
        && candidate.content?.uri?.endsWith(`/${spec.remoteFileName}`),
    );
    if (!row) throw new Error(`Catalog entry is missing: ${spec.remoteFileName}`);
    if (row.content.file_size !== spec.bytes) {
      throw new Error(`Catalog size changed for ${spec.remoteFileName}`);
    }
    const resource = media.resources?.find((item) => item.filename === spec.remoteFileName);
    const attributes = resource?.attributes?.flatMap((entry) => Object.entries(entry)) ?? [];
    const lookup = Object.fromEntries(attributes);
    if (
      lookup.UNITS !== "m"
      || lookup.MODEL_FILE_TYPE !== "GLB"
      || lookup.DRACO_COMPRESSED !== false
      || lookup.GLTF_STANDARDIZED !== true
      || lookup.FILE_SIZE !== spec.bytes
    ) {
      throw new Error(`Open Access resource metadata changed for ${spec.remoteFileName}`);
    }
    return { spec, url: row.content.uri, resourceTitle: resource.title };
  });
}

function assertIdentityMatrix(matrix, label) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let index = 0; index < identity.length; index += 1) {
    if (Math.abs(matrix[index] - identity[index]) > 1e-8) {
      throw new Error(`${label} has an unsupported non-identity world transform`);
    }
  }
}

function updateBounds(bounds, x, y, z) {
  bounds.min[0] = Math.min(bounds.min[0], x);
  bounds.min[1] = Math.min(bounds.min[1], y);
  bounds.min[2] = Math.min(bounds.min[2], z);
  bounds.max[0] = Math.max(bounds.max[0], x);
  bounds.max[1] = Math.max(bounds.max[1], y);
  bounds.max[2] = Math.max(bounds.max[2], z);
}

async function loadSourcePart(path, partName) {
  const document = await new NodeIO().read(path);
  const root = document.getRoot();
  const texturedPrimitives = [];
  let triangleCount = 0;
  let vertexCount = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    assertIdentityMatrix(node.getWorldMatrix(), `${partName}/${node.getName() || "node"}`);
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) throw new Error(`${partName} contains a non-triangle primitive`);
      const position = primitive.getAttribute("POSITION")?.getArray();
      const normal = primitive.getAttribute("NORMAL")?.getArray();
      const uv = primitive.getAttribute("TEXCOORD_0")?.getArray();
      const indices = primitive.getIndices()?.getArray();
      const material = primitive.getMaterial();
      const texture = material?.getBaseColorTexture();
      const textureInfo = material?.getBaseColorTextureInfo();
      if (!position || !normal || !uv || !indices || !texture || !textureInfo) {
        throw new Error(`${partName} is missing indexed positions, normals, UVs, or base-color texture`);
      }
      if (textureInfo.getTexCoord() !== 0) throw new Error(`${partName} uses an unsupported UV set`);
      if (textureInfo.getWrapS() !== 10497 || textureInfo.getWrapT() !== 10497) {
        throw new Error(`${partName} requires an unsupported texture wrap mode`);
      }
      const decoded = await sharp(texture.getImage())
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (decoded.info.channels !== 4) throw new Error(`${partName} texture did not decode as RGBA`);
      const baseColorFactor = material.getBaseColorFactor();
      texturedPrimitives.push(Object.freeze({
        partName,
        position,
        normal,
        uv,
        indices,
        texture: decoded.data,
        textureWidth: decoded.info.width,
        textureHeight: decoded.info.height,
        baseColorFactor,
      }));
      triangleCount += indices.length / 3;
      vertexCount += position.length / 3;
    }
  }
  if (texturedPrimitives.length === 0) throw new Error(`${partName} has no textured mesh primitives`);
  return Object.freeze({
    partName,
    texturedPrimitives: Object.freeze(texturedPrimitives),
    triangleCount,
    vertexCount,
    textureSummary: Object.freeze(root.listTextures().map((texture) => Object.freeze({
      name: texture.getName(),
      mimeType: texture.getMimeType(),
      dimensions: texture.getSize(),
      encodedBytes: texture.getImage()?.byteLength ?? 0,
    }))),
  });
}

function buildTriangleTable(parts) {
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  const primitives = parts.flatMap((part) => part.texturedPrimitives);
  const maximumTriangles = primitives.reduce((sum, primitive) => sum + primitive.indices.length / 3, 0);
  const cumulativeArea = new Float64Array(maximumTriangles);
  const primitiveIndex = new Uint16Array(maximumTriangles);
  const localTriangleIndex = new Uint32Array(maximumTriangles);
  let validTriangles = 0;
  let totalArea = 0;

  for (let primitiveOffset = 0; primitiveOffset < primitives.length; primitiveOffset += 1) {
    const primitive = primitives[primitiveOffset];
    const { indices, position } = primitive;
    for (let local = 0; local < indices.length / 3; local += 1) {
      const ia = indices[local * 3] * 3;
      const ib = indices[local * 3 + 1] * 3;
      const ic = indices[local * 3 + 2] * 3;
      const ax = position[ia]; const ay = position[ia + 1]; const az = position[ia + 2];
      const bx = position[ib]; const by = position[ib + 1]; const bz = position[ib + 2];
      const cx = position[ic]; const cy = position[ic + 1]; const cz = position[ic + 2];
      updateBounds(bounds, ax, ay, az);
      updateBounds(bounds, bx, by, bz);
      updateBounds(bounds, cx, cy, cz);
      const e1x = bx - ax; const e1y = by - ay; const e1z = bz - az;
      const e2x = cx - ax; const e2y = cy - ay; const e2z = cz - az;
      const crossX = e1y * e2z - e1z * e2y;
      const crossY = e1z * e2x - e1x * e2z;
      const crossZ = e1x * e2y - e1y * e2x;
      const area = 0.5 * Math.hypot(crossX, crossY, crossZ);
      if (!Number.isFinite(area) || area <= 1e-16) continue;
      totalArea += area;
      cumulativeArea[validTriangles] = totalArea;
      primitiveIndex[validTriangles] = primitiveOffset;
      localTriangleIndex[validTriangles] = local;
      validTriangles += 1;
    }
  }
  if (validTriangles === 0 || !Number.isFinite(totalArea)) throw new Error("Source mesh has no valid area");
  return Object.freeze({
    primitives,
    cumulativeArea: cumulativeArea.subarray(0, validTriangles),
    primitiveIndex: primitiveIndex.subarray(0, validTriangles),
    localTriangleIndex: localTriangleIndex.subarray(0, validTriangles),
    validTriangles,
    totalArea,
    bounds,
  });
}

function extent(bounds) {
  return bounds.max.map((value, index) => value - bounds.min[index]);
}

function xorshift32(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function normalize3(x, y, z) {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < 1e-14) return [0, 1, 0];
  return [x / length, y / length, z / length];
}

function quaternionFromBasis(tangent, bitangent, normal) {
  const m00 = tangent[0]; const m01 = bitangent[0]; const m02 = normal[0];
  const m10 = tangent[1]; const m11 = bitangent[1]; const m12 = normal[1];
  const m20 = tangent[2]; const m21 = bitangent[2]; const m22 = normal[2];
  const trace = m00 + m11 + m22;
  let x; let y; let z; let w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const normalized = normalize3(x, y, z);
  const vectorLength = Math.hypot(x, y, z);
  const fullLength = Math.hypot(vectorLength, w);
  if (!Number.isFinite(fullLength) || fullLength < 1e-14) return [1, 0, 0, 0];
  return [w / fullLength, normalized[0] * vectorLength / fullLength,
    normalized[1] * vectorLength / fullLength, normalized[2] * vectorLength / fullLength];
}

function wrapUnit(value) {
  return value - Math.floor(value);
}

function sampleTexture(primitive, u, v) {
  const width = primitive.textureWidth;
  const height = primitive.textureHeight;
  const x = wrapUnit(u) * width - 0.5;
  const y = wrapUnit(v) * height - 0.5;
  const x0Floor = Math.floor(x);
  const y0Floor = Math.floor(y);
  const tx = x - x0Floor;
  const ty = y - y0Floor;
  const x0 = ((x0Floor % width) + width) % width;
  const y0 = ((y0Floor % height) + height) % height;
  const x1 = (x0 + 1) % width;
  const y1 = (y0 + 1) % height;
  const sample = (sx, sy, channel) => primitive.texture[(sy * width + sx) * 4 + channel] / 255;
  const result = [];
  for (let channel = 0; channel < 3; channel += 1) {
    const top = sample(x0, y0, channel) * (1 - tx) + sample(x1, y0, channel) * tx;
    const bottom = sample(x0, y1, channel) * (1 - tx) + sample(x1, y1, channel) * tx;
    result.push(top * (1 - ty) + bottom * ty);
  }
  return result;
}

function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function writeFloatRecord(view, offset, values) {
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(offset + index * 4, values[index], true);
  }
}

function makeHeader(splatCount, sourceSha) {
  return Buffer.from([
    "ply",
    "format binary_little_endian 1.0",
    "comment Semaframe Reality Twin surface Gaussian asset v1",
    `comment Smithsonian source package ${PACKAGE_UUID}`,
    `comment source_sha256 ${sourceSha}`,
    "comment units metres",
    "comment axes right_up_back x_y_z",
    "comment origin base_center",
    `element vertex ${splatCount}`,
    "property float x",
    "property float y",
    "property float z",
    "property float f_dc_0",
    "property float f_dc_1",
    "property float f_dc_2",
    "property float opacity",
    "property float scale_0",
    "property float scale_1",
    "property float scale_2",
    "property float rot_0",
    "property float rot_1",
    "property float rot_2",
    "property float rot_3",
    "end_header",
    "",
  ].join("\n"), "ascii");
}

function generateGaussianPly(table, splatCount, sourceCombinedSha, outputPath) {
  const sourceExtents = extent(table.bounds);
  const uniformScale = PUBLISHED_METRES.height / sourceExtents[1];
  const sourceCenterX = (table.bounds.min[0] + table.bounds.max[0]) / 2;
  const sourceCenterZ = (table.bounds.min[2] + table.bounds.max[2]) / 2;
  const sourceBaseY = table.bounds.min[1];
  const outputExtents = Object.freeze({
    widthX: sourceExtents[2] * uniformScale,
    heightY: sourceExtents[1] * uniformScale,
    depthZ: sourceExtents[0] * uniformScale,
  });
  const transformedArea = table.totalArea * uniformScale * uniformScale;
  const areaPerSplat = transformedArea / splatCount;
  const tangentSigma = Math.sqrt(areaPerSplat / Math.PI) * 1.55;
  const normalSigma = tangentSigma * 0.18;
  const logTangentSigma = Math.log(tangentSigma);
  const logNormalSigma = Math.log(normalSigma);
  const seedMaterial = `${sourceCombinedSha}:${splatCount}:semaframe-reality-twin-v1`;
  const seed = Number.parseInt(sha256Bytes(seedMaterial).slice(0, 8), 16) >>> 0;
  const random = xorshift32(seed);
  const header = makeHeader(splatCount, sourceCombinedSha);
  const expectedBytes = header.length + splatCount * RECORD_BYTES;
  if (expectedBytes > MAXIMUM_OUTPUT_BYTES) {
    throw new Error(`Gaussian PLY would exceed Semaframe's ${MAXIMUM_OUTPUT_BYTES} byte limit`);
  }
  const body = Buffer.allocUnsafe(splatCount * RECORD_BYTES);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let trianglePointer = 0;
  const phase = random();

  for (let sampleIndex = 0; sampleIndex < splatCount; sampleIndex += 1) {
    const targetArea = ((sampleIndex + phase) / splatCount) * table.totalArea;
    while (
      trianglePointer < table.validTriangles - 1
      && table.cumulativeArea[trianglePointer] < targetArea
    ) trianglePointer += 1;
    const primitive = table.primitives[table.primitiveIndex[trianglePointer]];
    const localTriangle = table.localTriangleIndex[trianglePointer];
    const iaVertex = primitive.indices[localTriangle * 3];
    const ibVertex = primitive.indices[localTriangle * 3 + 1];
    const icVertex = primitive.indices[localTriangle * 3 + 2];
    const ia = iaVertex * 3; const ib = ibVertex * 3; const ic = icVertex * 3;
    const iua = iaVertex * 2; const iub = ibVertex * 2; const iuc = icVertex * 2;
    const sqrtR1 = Math.sqrt(random());
    const baryA = 1 - sqrtR1;
    const baryB = sqrtR1 * (1 - random());
    const baryC = 1 - baryA - baryB;
    const sourceX = primitive.position[ia] * baryA
      + primitive.position[ib] * baryB + primitive.position[ic] * baryC;
    const sourceY = primitive.position[ia + 1] * baryA
      + primitive.position[ib + 1] * baryB + primitive.position[ic + 1] * baryC;
    const sourceZ = primitive.position[ia + 2] * baryA
      + primitive.position[ib + 2] * baryB + primitive.position[ic + 2] * baryC;
    const x = (sourceZ - sourceCenterZ) * uniformScale;
    const y = (sourceY - sourceBaseY) * uniformScale;
    const z = -(sourceX - sourceCenterX) * uniformScale;

    const interpolatedNormal = normalize3(
      primitive.normal[ia] * baryA + primitive.normal[ib] * baryB + primitive.normal[ic] * baryC,
      primitive.normal[ia + 1] * baryA + primitive.normal[ib + 1] * baryB + primitive.normal[ic + 1] * baryC,
      primitive.normal[ia + 2] * baryA + primitive.normal[ib + 2] * baryB + primitive.normal[ic + 2] * baryC,
    );
    const targetNormal = normalize3(interpolatedNormal[2], interpolatedNormal[1], -interpolatedNormal[0]);
    const edgeSource = [
      primitive.position[ib] - primitive.position[ia],
      primitive.position[ib + 1] - primitive.position[ia + 1],
      primitive.position[ib + 2] - primitive.position[ia + 2],
    ];
    const edgeTarget = [edgeSource[2], edgeSource[1], -edgeSource[0]];
    const projectedDot = edgeTarget[0] * targetNormal[0]
      + edgeTarget[1] * targetNormal[1] + edgeTarget[2] * targetNormal[2];
    let tangent = normalize3(
      edgeTarget[0] - targetNormal[0] * projectedDot,
      edgeTarget[1] - targetNormal[1] * projectedDot,
      edgeTarget[2] - targetNormal[2] * projectedDot,
    );
    if (Math.abs(tangent[0] * targetNormal[0] + tangent[1] * targetNormal[1]
      + tangent[2] * targetNormal[2]) > 1e-4) {
      tangent = Math.abs(targetNormal[1]) < 0.9
        ? normalize3(targetNormal[2], 0, -targetNormal[0])
        : normalize3(1, 0, 0);
    }
    const bitangent = normalize3(
      targetNormal[1] * tangent[2] - targetNormal[2] * tangent[1],
      targetNormal[2] * tangent[0] - targetNormal[0] * tangent[2],
      targetNormal[0] * tangent[1] - targetNormal[1] * tangent[0],
    );
    const quaternion = quaternionFromBasis(tangent, bitangent, targetNormal);

    const u = primitive.uv[iua] * baryA + primitive.uv[iub] * baryB + primitive.uv[iuc] * baryC;
    const v = primitive.uv[iua + 1] * baryA
      + primitive.uv[iub + 1] * baryB + primitive.uv[iuc + 1] * baryC;
    const sampledSrgb = sampleTexture(primitive, u, v);
    const colorLinear = sampledSrgb.map((channel, channelIndex) => clamp(
      srgbToLinear(channel) * primitive.baseColorFactor[channelIndex], 0, 1,
    ));
    const fDc = colorLinear.map((channel) => (channel - 0.5) / SH_C0);

    writeFloatRecord(view, sampleIndex * RECORD_BYTES, [
      x, y, z,
      fDc[0], fDc[1], fDc[2],
      LOGIT_OPACITY,
      logTangentSigma, logTangentSigma, logNormalSigma,
      quaternion[0], quaternion[1], quaternion[2], quaternion[3],
    ]);
  }
  writeFileSync(outputPath, Buffer.concat([header, body]));
  return Object.freeze({
    outputPath,
    outputBytes: expectedBytes,
    outputSha256: sha256File(outputPath),
    splatCount,
    recordBytes: RECORD_BYTES,
    uniformScale,
    seed,
    sourceBounds: table.bounds,
    sourceExtents: Object.freeze({ x: sourceExtents[0], y: sourceExtents[1], z: sourceExtents[2] }),
    outputExtents,
    sourceSurfaceAreaSquareMetres: table.totalArea,
    outputSurfaceAreaSquareMetres: transformedArea,
    tangentSigmaMetres: tangentSigma,
    normalSigmaMetres: normalSigma,
    validTriangles: table.validTriangles,
  });
}

function relativePath(path) {
  return path.slice(REPOSITORY_ROOT.length + 1);
}

function relativeResidual(actual, expected) {
  return (actual - expected) / expected;
}

const options = parseArguments(process.argv.slice(2));
mkdirSync(SOURCE_ROOT, { recursive: true });
mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });

console.log("[1/5] Resolving Smithsonian CC0 metadata and 3D downloads...");
const [catalog, openAccess] = await Promise.all([
  fetchJson(FILE_CATALOG_URL, resolve(SOURCE_ROOT, "file-catalog.json"), options.offline),
  fetchJson(OPEN_ACCESS_URL, resolve(SOURCE_ROOT, "open-access-record.json"), options.offline),
]);
const { record, media } = selectOfficialRecord(openAccess);
const entries = selectCatalogEntries(catalog, media);

const sourceFiles = [];
for (const entry of entries) {
  const path = resolve(SOURCE_ROOT, entry.spec.fileName);
  const integrity = await downloadFile(
    entry.url,
    path,
    entry.spec.bytes,
    entry.spec.sha256,
    options.offline,
  );
  sourceFiles.push(Object.freeze({ ...entry, path, ...integrity }));
}
const sourceCombinedSha256 = sha256Bytes(sourceFiles.map((item) => item.sha256).join(":"));

console.log("[2/5] Decoding 4K base-color textures and standardized GLB meshes...");
const sourceParts = [];
for (const source of sourceFiles) sourceParts.push(await loadSourcePart(source.path, source.spec.part));

console.log("[3/5] Measuring mesh and building area-weighted surface sampler...");
const triangleTable = buildTriangleTable(sourceParts);
const outputPath = resolve(ARTIFACT_ROOT, "late-shang-gong.gaussian.ply");

console.log(`[4/5] Writing ${options.splatCount.toLocaleString("en-US")} textured Gaussian splats...`);
const generated = generateGaussianPly(
  triangleTable,
  options.splatCount,
  sourceCombinedSha256,
  outputPath,
);

const title = stripHtml(record.title);
const repeating = record.content.descriptiveNonRepeating;
const dimensionsText = freetextValue(record, "physicalDescription", "Dimensions");
const sourceResourceRows = sourceFiles.map((source, index) => Object.freeze({
  part: source.spec.part,
  file_name: source.spec.remoteFileName,
  url: source.url,
  catalog_title: source.resourceTitle,
  format: "GLB 2.0",
  units: "m",
  gltf_standardized: true,
  draco_compressed: false,
  bytes: source.bytes,
  sha256: source.sha256,
  mesh_vertices: sourceParts[index].vertexCount,
  mesh_triangles: sourceParts[index].triangleCount,
  textures: sourceParts[index].textureSummary,
}));
const evidence = {
  schema: "semaframe.reality-twin-asset-evidence.v1",
  source: {
    derivation: "smithsonian_glb_scan_to_gaussian_ply",
    nativeGaussianCapture: false,
    sourceClass: "official_museum_mesh_scan",
    conversionLocation: "offline",
    packageUuid: PACKAGE_UUID,
    accessionNumber: ACCESSION,
    objectUrl: OBJECT_PAGE,
    rights: "CC0",
    glbFiles: sourceResourceRows.map((item) => ({
      part: item.part,
      fileName: item.file_name,
      byteLength: item.bytes,
      sha256: item.sha256,
    })),
    catalogDimensionsMetres: {
      x: PUBLISHED_METRES.width,
      y: PUBLISHED_METRES.height,
      z: PUBLISHED_METRES.depth,
    },
    scanBoundsGlTFMetres: generated.sourceBounds,
    scanExtentsGlTFMetres: generated.sourceExtents,
  },
  derivedAsset: {
    relativePath: relativePath(generated.outputPath),
    fileName: basename(generated.outputPath),
    mediaType: "application/ply",
    format: "ply",
    encoding: "binary_little_endian",
    model: "gaussian-3d",
    sphericalHarmonicsDegree: 0,
    splatCount: generated.splatCount,
    byteLength: generated.outputBytes,
    sha256: generated.outputSha256,
    coordinateBasis: {
      axes: "RUB (+X right, +Y up, +Z back)",
      units: "metres",
      origin: "combined scan base centre",
    },
    calibrationReference: {
      label: "BASE to CREST",
      axis: "y",
      knownDistanceMetres: PUBLISHED_METRES.height,
      policy: "one uniform scale from scan height; no anisotropic deformation",
      uniformScale: generated.uniformScale,
    },
    independentDimensionChecks: {
      toleranceMetres: 0.02,
      acceptanceBasis: "demo registration tolerance only; not a metrology or manufacturing claim",
      width: {
        catalogMetres: PUBLISHED_METRES.width,
        scanAabbMetres: generated.outputExtents.widthX,
        residualMetres: generated.outputExtents.widthX - PUBLISHED_METRES.width,
        passed: Math.abs(generated.outputExtents.widthX - PUBLISHED_METRES.width) <= 0.02,
      },
      depth: {
        catalogMetres: PUBLISHED_METRES.depth,
        scanAabbMetres: generated.outputExtents.depthZ,
        residualMetres: generated.outputExtents.depthZ - PUBLISHED_METRES.depth,
        passed: Math.abs(generated.outputExtents.depthZ - PUBLISHED_METRES.depth) <= 0.02,
      },
    },
  },
  subject: {
    title,
    accession_number: ACCESSION,
    record_id: RECORD_ID,
    ark_guid: repeating.guid,
    collection: repeating.data_source,
    period: freetextValue(record, "date", "Period"),
    date: freetextValue(record, "date", "Date"),
    material: freetextValue(record, "physicalDescription", "Medium"),
    dimensions_as_published: dimensionsText,
    dimensions_metres: PUBLISHED_METRES,
    object_page: OBJECT_PAGE,
    collection_record: repeating.record_link || RECORD_PAGE,
    package_uuid: PACKAGE_UUID,
  },
  rights: {
    status: "CC0",
    verified_surfaces: {
      object_rights: freetextValue(record, "objectRights", "Restrictions & Rights"),
      metadata_usage: repeating.metadata_usage.access,
      package_media_usage: media.usage.access,
    },
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    smithsonian_terms_url: "https://www.si.edu/termsofuse",
    attribution: `Smithsonian National Museum of Asian Art, ${ACCESSION}`,
    credit_line: freetextValue(record, "creditLine", "Credit Line"),
  },
  retrieval: {
    file_catalog_api: FILE_CATALOG_URL,
    open_access_api: OPEN_ACCESS_URL.replace("api_key=DEMO_KEY", "api_key=REDACTED_PUBLIC_DEMO_KEY"),
    source_files: sourceResourceRows,
    combined_source_sha256: sourceCombinedSha256,
  },
  conversion: {
    script: "scripts/prepare-reality-twin-asset.mjs",
    algorithm: "deterministic area-weighted triangle surface sampling with bilinear 4K base-color lookup",
    color_pipeline: "GLB base-color JPEG sRGB -> linear RGB -> degree-0 spherical-harmonics coefficients",
    gaussian_model: "3D anisotropic surface Gaussians, SH degree 0",
    opacity_probability: OPACITY,
    splat_count: generated.splatCount,
    record_bytes: generated.recordBytes,
    random_seed_uint32: generated.seed,
    source_valid_triangles: generated.validTriangles,
    source_bounds_glTF_metres: generated.sourceBounds,
    source_extents_glTF_metres: generated.sourceExtents,
    source_surface_area_square_metres: generated.sourceSurfaceAreaSquareMetres,
    transform: {
      source_convention: "standard glTF 2.0 right-handed, +Y up, metres",
      target_convention: "Semaframe RUB: +X right, +Y up, +Z back, metres",
      axis_map: "target(x,y,z) = (source.z, source.y, -source.x)",
      origin: "combined scan base centre; min Y = 0; X/Z centred",
      calibration: "uniform scale from combined scan height to published 0.322 m height (BASE to CREST)",
      uniform_scale: generated.uniformScale,
      shape_policy: "uniform scale only; no anisotropic deformation",
    },
    resulting_extents_metres: generated.outputExtents,
    catalog_dimension_residual_fraction: {
      width_x: relativeResidual(generated.outputExtents.widthX, PUBLISHED_METRES.width),
      height_y: relativeResidual(generated.outputExtents.heightY, PUBLISHED_METRES.height),
      depth_z: relativeResidual(generated.outputExtents.depthZ, PUBLISHED_METRES.depth),
    },
    tangent_sigma_metres: generated.tangentSigmaMetres,
    normal_sigma_metres: generated.normalSigmaMetres,
    limitations: [
      "This is a surface-Gaussian derivative of the Smithsonian low-resolution 150k-per-part meshes, not a native photogrammetry-trained Gaussian capture.",
      "The 4K base-color textures preserve captured appearance; normal and occlusion maps are not baked into degree-0 spherical harmonics.",
      "The museum catalog dimensions and scan axis-aligned bounds differ. Height anchors the two-point uniform calibration; residual width/depth differences are recorded and the scan is not distorted.",
      "Gaussian geometry is visual evidence only. Collision, clearance, manufacturing, and metrology must use a separately authored semantic proxy or calibrated engineering model.",
    ],
  },
  output: {
    relative_path: relativePath(generated.outputPath),
    media_type: "application/ply",
    encoding: "binary_little_endian PLY 1.0",
    bytes: generated.outputBytes,
    sha256: generated.outputSha256,
    git_policy: "ignored artifact; regenerate locally from the pinned CC0 sources",
    semaframe_limits: {
      maximum_asset_bytes: MAXIMUM_OUTPUT_BYTES,
      maximum_splat_count: MAXIMUM_SPLAT_COUNT,
      within_limits: generated.outputBytes < MAXIMUM_OUTPUT_BYTES
        && generated.splatCount < MAXIMUM_SPLAT_COUNT,
    },
  },
  validation: {
    status: "pending",
    command: "node scripts/verify-reality-twin-asset.mjs",
  },
};

console.log("[5/5] Writing compact provenance evidence...");
writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({
  output: relativePath(outputPath),
  bytes: generated.outputBytes,
  sha256: generated.outputSha256,
  splats: generated.splatCount,
  evidence: relativePath(EVIDENCE_PATH),
}, null, 2));
