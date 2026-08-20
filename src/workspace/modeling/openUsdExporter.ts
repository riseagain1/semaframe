import {
  validateParametricPrimitive,
  type ParametricPrimitive,
} from "./parametricGeometry";

export const OPEN_USD_EXPORT_VERSION = "1.0" as const;

export const OPEN_USD_EXPORT_LIMITS = Object.freeze({
  maxNodes: 10_000,
  maxMaterials: 1_000,
  maxHierarchyDepth: 256,
  maxIdentifierLength: 512,
  maxLabelLength: 512,
  maxDistanceM: 1_000_000_000,
  minScaleMagnitude: 1e-12,
});

export type OpenUsdVector3 = Readonly<{ x: number; y: number; z: number }>;
export type OpenUsdQuaternion = Readonly<{ x: number; y: number; z: number; w: number }>;
export type OpenUsdLinearColor = Readonly<{ r: number; g: number; b: number }>;

export type OpenUsdNodeTransform = Readonly<{
  translationM?: OpenUsdVector3;
  rotationQuaternion?: OpenUsdQuaternion;
  scale?: OpenUsdVector3;
}>;

/**
 * A deliberately narrow, renderer-independent material contract. Colors are
 * linear RGB values. Texture assets and arbitrary shader networks are outside
 * the deterministic v1 exporter contract.
 */
export type OpenUsdExportMaterial = Readonly<{
  id: string;
  name: string;
  baseColorLinear: OpenUsdLinearColor;
  metallic?: number;
  roughness?: number;
  opacity?: number;
  emissiveColorLinear?: OpenUsdLinearColor;
}>;

/**
 * Nodes form a flat, ID-addressed tree so Workspace adapters do not need to
 * manufacture recursively nested DTOs. Each primitive remains centered at its
 * node origin and uses the local Xform supplied by the node.
 */
export type OpenUsdExportNode = Readonly<{
  id: string;
  name: string;
  parentId?: string;
  transform?: OpenUsdNodeTransform;
  primitive?: ParametricPrimitive;
  materialId?: string;
  visible?: boolean;
}>;

export type OpenUsdExportDocument = Readonly<{
  id: string;
  name: string;
  nodes: readonly OpenUsdExportNode[];
  materials?: readonly OpenUsdExportMaterial[];
}>;

export type OpenUsdExportResult = Readonly<{
  format: "usda";
  version: typeof OPEN_USD_EXPORT_VERSION;
  /** UTF-8 USDA text with no timestamps or platform-dependent line endings. */
  usda: string;
  nodePrimPaths: Readonly<Record<string, string>>;
  materialPrimPaths: Readonly<Record<string, string>>;
}>;

export type OpenUsdExportErrorCode =
  | "invalid_document"
  | "limit_exceeded"
  | "duplicate_id"
  | "missing_parent"
  | "hierarchy_cycle"
  | "missing_material"
  | "invalid_identifier"
  | "invalid_number"
  | "invalid_primitive";

export class OpenUsdExportError extends Error {
  readonly code: OpenUsdExportErrorCode;
  readonly path: string;

  constructor(code: OpenUsdExportErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "OpenUsdExportError";
    this.code = code;
    this.path = path;
  }
}

type ValidatedDocument = Readonly<{
  nodesById: ReadonlyMap<string, OpenUsdExportNode>;
  materialsById: ReadonlyMap<string, OpenUsdExportMaterial>;
  childrenByParentId: ReadonlyMap<string | undefined, readonly OpenUsdExportNode[]>;
}>;

type AllocatedNames = Readonly<{
  nodeNames: ReadonlyMap<string, string>;
  materialNames: ReadonlyMap<string, string>;
}>;

const ROOT_PRIM_NAME = "World";
const MATERIALS_SCOPE_NAME = "Materials";
const GEOMETRY_PRIM_NAME = "Geometry";
const ZERO_VECTOR: OpenUsdVector3 = Object.freeze({ x: 0, y: 0, z: 0 });
const UNIT_VECTOR: OpenUsdVector3 = Object.freeze({ x: 1, y: 1, z: 1 });
const IDENTITY_QUATERNION: OpenUsdQuaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function fail(code: OpenUsdExportErrorCode, path: string, message: string): never {
  throw new OpenUsdExportError(code, path, message);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_document", path, "must be an object");
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  path: string,
  allowedKeys: ReadonlySet<string>,
): void {
  const unknownKey = Object.keys(value).sort(compareStrings).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    fail("invalid_document", `${path}.${unknownKey}`, "is not part of the OpenUSD export contract");
  }
}

function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) fail("invalid_document", path, "must be an array");
}

function assertText(value: unknown, path: string, kind: "identifier" | "label"): asserts value is string {
  const maxLength = kind === "identifier"
    ? OPEN_USD_EXPORT_LIMITS.maxIdentifierLength
    : OPEN_USD_EXPORT_LIMITS.maxLabelLength;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("invalid_identifier", path, `must be a non-empty ${kind}`);
  }
  if (value.length > maxLength) {
    fail("limit_exceeded", path, `${kind} exceeds ${maxLength} characters`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    fail("invalid_identifier", path, `${kind} contains a control character`);
  }
}

function assertFiniteNumber(
  value: unknown,
  path: string,
  options: Readonly<{ min?: number; max?: number; exclusiveMin?: boolean }> = {},
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_number", path, "must be a finite number");
  }
  if (options.min !== undefined) {
    const invalid = options.exclusiveMin ? value <= options.min : value < options.min;
    if (invalid) {
      fail("invalid_number", path, `must be ${options.exclusiveMin ? ">" : ">="} ${options.min}`);
    }
  }
  if (options.max !== undefined && value > options.max) {
    fail("invalid_number", path, `must be <= ${options.max}`);
  }
}

function assertVector3(
  value: unknown,
  path: string,
  options: Readonly<{ positive?: boolean; nonZero?: boolean; absoluteMax?: number }> = {},
): asserts value is OpenUsdVector3 {
  assertRecord(value, path);
  assertOnlyKeys(value, path, new Set(["x", "y", "z"]));
  for (const axis of ["x", "y", "z"] as const) {
    const component = value[axis];
    assertFiniteNumber(component, `${path}.${axis}`);
    if (options.positive && component <= 0) {
      fail("invalid_number", `${path}.${axis}`, "must be > 0");
    }
    if (options.nonZero && Math.abs(component) < OPEN_USD_EXPORT_LIMITS.minScaleMagnitude) {
      fail(
        "invalid_number",
        `${path}.${axis}`,
        `absolute value must be >= ${OPEN_USD_EXPORT_LIMITS.minScaleMagnitude}`,
      );
    }
    if (options.absoluteMax !== undefined && Math.abs(component) > options.absoluteMax) {
      fail("invalid_number", `${path}.${axis}`, `absolute value must be <= ${options.absoluteMax}`);
    }
  }
}

function assertQuaternion(value: unknown, path: string): asserts value is OpenUsdQuaternion {
  assertRecord(value, path);
  assertOnlyKeys(value, path, new Set(["x", "y", "z", "w"]));
  for (const axis of ["x", "y", "z", "w"] as const) {
    assertFiniteNumber(value[axis], `${path}.${axis}`);
  }
  const quaternion = value as unknown as OpenUsdQuaternion;
  const lengthSquared = quaternion.x ** 2 + quaternion.y ** 2 + quaternion.z ** 2 + quaternion.w ** 2;
  if (lengthSquared < OPEN_USD_EXPORT_LIMITS.minScaleMagnitude ** 2) {
    fail("invalid_number", path, "must not be a zero-length quaternion");
  }
}

function assertLinearColor(
  value: unknown,
  path: string,
  options: Readonly<{ allowHdr?: boolean }> = {},
): asserts value is OpenUsdLinearColor {
  assertRecord(value, path);
  assertOnlyKeys(value, path, new Set(["r", "g", "b"]));
  for (const channel of ["r", "g", "b"] as const) {
    assertFiniteNumber(value[channel], `${path}.${channel}`, {
      min: 0,
      max: options.allowHdr ? 1_000_000 : 1,
    });
  }
}

function assertParametricPrimitive(value: unknown, path: string): asserts value is ParametricPrimitive {
  const issue = validateParametricPrimitive(value)[0];
  if (issue === undefined) return;
  const issuePath = issue.path === "$" ? path : `${path}${issue.path.slice(1)}`;
  const code: OpenUsdExportErrorCode = issue.code === "non_finite" || issue.code === "out_of_range"
    ? "invalid_number"
    : "invalid_primitive";
  fail(code, issuePath, issue.message.replace(/^\$\.?/u, ""));
}

function validateNode(value: unknown, path: string): asserts value is OpenUsdExportNode {
  assertRecord(value, path);
  assertOnlyKeys(
    value,
    path,
    new Set(["id", "name", "parentId", "transform", "primitive", "materialId", "visible"]),
  );
  assertText(value.id, `${path}.id`, "identifier");
  assertText(value.name, `${path}.name`, "label");
  if (value.parentId !== undefined) assertText(value.parentId, `${path}.parentId`, "identifier");
  if (value.visible !== undefined && typeof value.visible !== "boolean") {
    fail("invalid_document", `${path}.visible`, "must be a boolean");
  }
  if (value.transform !== undefined) {
    assertRecord(value.transform, `${path}.transform`);
    assertOnlyKeys(
      value.transform,
      `${path}.transform`,
      new Set(["translationM", "rotationQuaternion", "scale"]),
    );
    if (value.transform.translationM !== undefined) {
      assertVector3(value.transform.translationM, `${path}.transform.translationM`, {
        absoluteMax: OPEN_USD_EXPORT_LIMITS.maxDistanceM,
      });
    }
    if (value.transform.rotationQuaternion !== undefined) {
      assertQuaternion(value.transform.rotationQuaternion, `${path}.transform.rotationQuaternion`);
    }
    if (value.transform.scale !== undefined) {
      assertVector3(value.transform.scale, `${path}.transform.scale`, {
        nonZero: true,
        absoluteMax: OPEN_USD_EXPORT_LIMITS.maxDistanceM,
      });
    }
  }
  if (value.primitive !== undefined) assertParametricPrimitive(value.primitive, `${path}.primitive`);
  if (value.materialId !== undefined) {
    assertText(value.materialId, `${path}.materialId`, "identifier");
    if (value.primitive === undefined) {
      fail("invalid_document", `${path}.materialId`, "requires a primitive on the same node");
    }
  }
}

function validateMaterial(value: unknown, path: string): asserts value is OpenUsdExportMaterial {
  assertRecord(value, path);
  assertOnlyKeys(
    value,
    path,
    new Set([
      "id",
      "name",
      "baseColorLinear",
      "metallic",
      "roughness",
      "opacity",
      "emissiveColorLinear",
    ]),
  );
  assertText(value.id, `${path}.id`, "identifier");
  assertText(value.name, `${path}.name`, "label");
  assertLinearColor(value.baseColorLinear, `${path}.baseColorLinear`);
  for (const property of ["metallic", "roughness", "opacity"] as const) {
    if (value[property] !== undefined) {
      assertFiniteNumber(value[property], `${path}.${property}`, { min: 0, max: 1 });
    }
  }
  if (value.emissiveColorLinear !== undefined) {
    assertLinearColor(value.emissiveColorLinear, `${path}.emissiveColorLinear`, { allowHdr: true });
  }
}

/**
 * Validates the DTO and returns lookup tables used by the exporter. Errors are
 * stable because ID sets and hierarchy walks are sorted before diagnostics.
 */
function validateDocument(value: unknown): ValidatedDocument {
  assertRecord(value, "document");
  assertOnlyKeys(value, "document", new Set(["id", "name", "nodes", "materials"]));
  assertText(value.id, "document.id", "identifier");
  assertText(value.name, "document.name", "label");
  assertArray(value.nodes, "document.nodes");
  if (value.nodes.length > OPEN_USD_EXPORT_LIMITS.maxNodes) {
    fail("limit_exceeded", "document.nodes", `contains more than ${OPEN_USD_EXPORT_LIMITS.maxNodes} nodes`);
  }

  const materialsValue = value.materials ?? [];
  assertArray(materialsValue, "document.materials");
  if (materialsValue.length > OPEN_USD_EXPORT_LIMITS.maxMaterials) {
    fail(
      "limit_exceeded",
      "document.materials",
      `contains more than ${OPEN_USD_EXPORT_LIMITS.maxMaterials} materials`,
    );
  }

  value.nodes.forEach((node, index) => validateNode(node, `document.nodes[${index}]`));
  materialsValue.forEach((material, index) => validateMaterial(material, `document.materials[${index}]`));
  const nodes = value.nodes as readonly OpenUsdExportNode[];
  const materials = materialsValue as readonly OpenUsdExportMaterial[];

  const sortedNodes = [...nodes].sort((left, right) => compareStrings(left.id, right.id));
  const sortedMaterials = [...materials].sort((left, right) => compareStrings(left.id, right.id));
  const nodesById = new Map<string, OpenUsdExportNode>();
  const materialsById = new Map<string, OpenUsdExportMaterial>();

  for (const node of sortedNodes) {
    if (nodesById.has(node.id)) fail("duplicate_id", `node:${node.id}`, "node ID is duplicated");
    nodesById.set(node.id, node);
  }
  for (const material of sortedMaterials) {
    if (materialsById.has(material.id)) {
      fail("duplicate_id", `material:${material.id}`, "material ID is duplicated");
    }
    materialsById.set(material.id, material);
  }

  for (const node of sortedNodes) {
    if (node.parentId !== undefined && !nodesById.has(node.parentId)) {
      fail("missing_parent", `node:${node.id}.parentId`, `references missing node ${node.parentId}`);
    }
    if (node.materialId !== undefined && !materialsById.has(node.materialId)) {
      fail("missing_material", `node:${node.id}.materialId`, `references missing material ${node.materialId}`);
    }
  }

  const globallyVisited = new Set<string>();
  for (const node of sortedNodes) {
    const chain: string[] = [];
    const chainSet = new Set<string>();
    let cursor: string | undefined = node.id;
    while (cursor !== undefined && !globallyVisited.has(cursor)) {
      if (chainSet.has(cursor)) {
        fail("hierarchy_cycle", `node:${cursor}.parentId`, "creates a hierarchy cycle");
      }
      chain.push(cursor);
      chainSet.add(cursor);
      if (chain.length > OPEN_USD_EXPORT_LIMITS.maxHierarchyDepth) {
        fail(
          "limit_exceeded",
          `node:${node.id}.parentId`,
          `hierarchy exceeds ${OPEN_USD_EXPORT_LIMITS.maxHierarchyDepth} levels`,
        );
      }
      cursor = nodesById.get(cursor)?.parentId;
    }
    for (const visitedId of chain) globallyVisited.add(visitedId);
  }

  const mutableChildren = new Map<string | undefined, OpenUsdExportNode[]>();
  for (const node of sortedNodes) {
    const siblings = mutableChildren.get(node.parentId) ?? [];
    siblings.push(node);
    mutableChildren.set(node.parentId, siblings);
  }
  const childrenByParentId = new Map<string | undefined, readonly OpenUsdExportNode[]>();
  for (const [parentId, children] of mutableChildren) {
    childrenByParentId.set(parentId, Object.freeze([...children]));
  }

  return { nodesById, materialsById, childrenByParentId };
}

/** Converts an arbitrary display name into a legal ASCII USD prim identifier. */
export function toOpenUsdIdentifier(value: string, fallback = "Prim"): string {
  const clean = (candidate: string): string => candidate
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const collapsed = clean(value);
  const cleanedFallback = clean(fallback);
  const withFallback = collapsed.length > 0
    ? collapsed
    : cleanedFallback.length > 0 ? cleanedFallback : "Prim";
  return /^[A-Za-z_]/u.test(withFallback) ? withFallback : `_${withFallback}`;
}

function stableSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function allocateNamespaceNames<T extends Readonly<{ id: string; name: string }>>(
  values: readonly T[],
  reservedNames: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const entries = values
    .map((value) => ({ value, base: toOpenUsdIdentifier(value.name) }))
    .sort((left, right) => compareStrings(left.base, right.base) || compareStrings(left.value.id, right.value.id));
  const baseCounts = new Map<string, number>();
  for (const entry of entries) baseCounts.set(entry.base, (baseCounts.get(entry.base) ?? 0) + 1);

  const allocated = new Map<string, string>();
  const used = new Set(reservedNames);
  for (const entry of entries) {
    let candidate = entry.base;
    if ((baseCounts.get(entry.base) ?? 0) > 1 || used.has(candidate)) {
      candidate = `${entry.base}_${stableSuffix(entry.value.id)}`;
    }
    let collisionIndex = 2;
    while (used.has(candidate)) {
      candidate = `${entry.base}_${stableSuffix(entry.value.id)}_${collisionIndex}`;
      collisionIndex += 1;
    }
    used.add(candidate);
    allocated.set(entry.value.id, candidate);
  }
  return allocated;
}

function allocateNames(document: OpenUsdExportDocument, validated: ValidatedDocument): AllocatedNames {
  const nodeNames = new Map<string, string>();
  for (const [parentId, children] of validated.childrenByParentId) {
    const reserved = new Set<string>();
    if (parentId === undefined && (document.materials?.length ?? 0) > 0) reserved.add(MATERIALS_SCOPE_NAME);
    if (parentId !== undefined && validated.nodesById.get(parentId)?.primitive !== undefined) {
      reserved.add(GEOMETRY_PRIM_NAME);
    }
    for (const [id, name] of allocateNamespaceNames(children, reserved)) nodeNames.set(id, name);
  }
  const materialNames = allocateNamespaceNames(document.materials ?? []);
  return { nodeNames, materialNames };
}

function formatNumber(value: number): string {
  const canonical = Object.is(value, -0) ? 0 : value;
  const text = String(canonical);
  return text.includes("e+") ? text.replace("e+", "e") : text;
}

function formatVector3(value: OpenUsdVector3): string {
  return `(${formatNumber(value.x)}, ${formatNumber(value.y)}, ${formatNumber(value.z)})`;
}

function formatColor(value: OpenUsdLinearColor): string {
  return `(${formatNumber(value.r)}, ${formatNumber(value.g)}, ${formatNumber(value.b)})`;
}

function canonicalQuaternion(value: OpenUsdQuaternion): OpenUsdQuaternion {
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  let x = value.x / length;
  let y = value.y / length;
  let z = value.z / length;
  let w = value.w / length;
  const firstNonZero = [w, x, y, z].find((component) => component !== 0) ?? 1;
  if (firstNonZero < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  return { x, y, z, w };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function axisToken(axis: "x" | "y" | "z"): "X" | "Y" | "Z" {
  return axis.toUpperCase() as "X" | "Y" | "Z";
}

function primitiveSchemaName(primitive: ParametricPrimitive): string {
  switch (primitive.kind) {
    case "box": return "Cube";
    case "sphere": return "Sphere";
    case "cylinder": return "Cylinder";
    case "cone": return "Cone";
    case "capsule": return "Capsule";
    case "plane": return "Plane";
  }
}

function renderPrimitiveProperties(primitive: ParametricPrimitive, indent: string): string[] {
  switch (primitive.kind) {
    case "box":
      return [
        `${indent}double size = 1`,
        `${indent}double3 xformOp:scale = ${formatVector3(primitive.sizeM)}`,
        `${indent}uniform token[] xformOpOrder = ["xformOp:scale"]`,
      ];
    case "sphere":
      return [`${indent}double radius = ${formatNumber(primitive.radiusM)}`];
    case "cylinder":
    case "cone":
      return [
        `${indent}uniform token axis = ${quote(axisToken(primitive.axis))}`,
        `${indent}double height = ${formatNumber(primitive.heightM)}`,
        `${indent}double radius = ${formatNumber(primitive.radiusM)}`,
      ];
    case "capsule":
      return [
        `${indent}uniform token axis = ${quote(axisToken(primitive.axis))}`,
        `${indent}double height = ${formatNumber(primitive.cylinderHeightM)}`,
        `${indent}double radius = ${formatNumber(primitive.radiusM)}`,
      ];
    case "plane":
      return [
        `${indent}uniform token axis = ${quote(axisToken(primitive.normalAxis))}`,
        `${indent}double length = ${formatNumber(primitive.sizeM.y)}`,
        `${indent}double width = ${formatNumber(primitive.sizeM.x)}`,
      ];
  }
}

function renderGeometry(
  node: OpenUsdExportNode,
  materialPath: string | undefined,
  depth: number,
): string[] {
  if (node.primitive === undefined) return [];
  const indent = "    ".repeat(depth);
  const bodyIndent = "    ".repeat(depth + 1);
  const lines = [`${indent}def ${primitiveSchemaName(node.primitive)} ${quote(GEOMETRY_PRIM_NAME)}`];
  if (materialPath !== undefined) {
    lines.push(`${indent}(`);
    lines.push(`${bodyIndent}prepend apiSchemas = ["MaterialBindingAPI"]`);
    lines.push(`${indent})`);
  }
  lines.push(`${indent}{`);
  lines.push(...renderPrimitiveProperties(node.primitive, bodyIndent));
  if (materialPath !== undefined) lines.push(`${bodyIndent}rel material:binding = <${materialPath}>`);
  lines.push(`${indent}}`);
  return lines;
}

function renderNode(
  node: OpenUsdExportNode,
  validated: ValidatedDocument,
  names: AllocatedNames,
  materialPaths: Readonly<Record<string, string>>,
  depth: number,
): string[] {
  const name = names.nodeNames.get(node.id);
  if (name === undefined) throw new Error(`Internal exporter error: missing allocated name for ${node.id}`);
  const indent = "    ".repeat(depth);
  const bodyIndent = "    ".repeat(depth + 1);
  const transform = node.transform ?? {};
  const translation = transform.translationM ?? ZERO_VECTOR;
  const rotation = canonicalQuaternion(transform.rotationQuaternion ?? IDENTITY_QUATERNION);
  const scale = transform.scale ?? UNIT_VECTOR;
  const lines = [
    `${indent}def Xform ${quote(name)} (`,
    `${bodyIndent}customData = {`,
    `${bodyIndent}    string "semaframe:id" = ${quote(node.id)}`,
    `${bodyIndent}    string "semaframe:label" = ${quote(node.name)}`,
    `${bodyIndent}}`,
    `${indent})`,
    `${indent}{`,
    `${bodyIndent}double3 xformOp:translate = ${formatVector3(translation)}`,
    `${bodyIndent}quatd xformOp:orient = (${formatNumber(rotation.w)}, ${formatNumber(rotation.x)}, ${formatNumber(rotation.y)}, ${formatNumber(rotation.z)})`,
    `${bodyIndent}double3 xformOp:scale = ${formatVector3(scale)}`,
    `${bodyIndent}uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]`,
  ];
  if (node.visible === false) lines.push(`${bodyIndent}token visibility = "invisible"`);

  const geometryLines = renderGeometry(
    node,
    node.materialId === undefined ? undefined : materialPaths[node.materialId],
    depth + 1,
  );
  const children = validated.childrenByParentId.get(node.id) ?? [];
  const orderedChildren = [...children].sort((left, right) => {
    const leftName = names.nodeNames.get(left.id) ?? "";
    const rightName = names.nodeNames.get(right.id) ?? "";
    return compareStrings(leftName, rightName) || compareStrings(left.id, right.id);
  });
  if (geometryLines.length > 0) {
    lines.push("");
    lines.push(...geometryLines);
  }
  for (const child of orderedChildren) {
    lines.push("");
    lines.push(...renderNode(child, validated, names, materialPaths, depth + 1));
  }
  lines.push(`${indent}}`);
  return lines;
}

function renderMaterials(
  materials: readonly OpenUsdExportMaterial[],
  names: AllocatedNames,
  depth: number,
): string[] {
  if (materials.length === 0) return [];
  const indent = "    ".repeat(depth);
  const materialIndent = "    ".repeat(depth + 1);
  const shaderIndent = "    ".repeat(depth + 2);
  const propertyIndent = "    ".repeat(depth + 3);
  const lines = [`${indent}def Scope ${quote(MATERIALS_SCOPE_NAME)}`, `${indent}{`];
  const ordered = [...materials].sort((left, right) => {
    const leftName = names.materialNames.get(left.id) ?? "";
    const rightName = names.materialNames.get(right.id) ?? "";
    return compareStrings(leftName, rightName) || compareStrings(left.id, right.id);
  });
  ordered.forEach((material, index) => {
    const name = names.materialNames.get(material.id);
    if (name === undefined) throw new Error(`Internal exporter error: missing material name for ${material.id}`);
    if (index > 0) lines.push("");
    lines.push(`${materialIndent}def Material ${quote(name)} (`);
    lines.push(`${shaderIndent}customData = {`);
    lines.push(`${shaderIndent}    string "semaframe:id" = ${quote(material.id)}`);
    lines.push(`${shaderIndent}    string "semaframe:label" = ${quote(material.name)}`);
    lines.push(`${shaderIndent}}`);
    lines.push(`${materialIndent})`);
    lines.push(`${materialIndent}{`);
    lines.push(`${shaderIndent}token outputs:surface.connect = </${ROOT_PRIM_NAME}/${MATERIALS_SCOPE_NAME}/${name}/PreviewSurface.outputs:surface>`);
    lines.push("");
    lines.push(`${shaderIndent}def Shader "PreviewSurface"`);
    lines.push(`${shaderIndent}{`);
    lines.push(`${propertyIndent}uniform token info:id = "UsdPreviewSurface"`);
    lines.push(`${propertyIndent}color3f inputs:diffuseColor = ${formatColor(material.baseColorLinear)}`);
    lines.push(`${propertyIndent}color3f inputs:emissiveColor = ${formatColor(material.emissiveColorLinear ?? { r: 0, g: 0, b: 0 })}`);
    lines.push(`${propertyIndent}float inputs:metallic = ${formatNumber(material.metallic ?? 0)}`);
    lines.push(`${propertyIndent}float inputs:opacity = ${formatNumber(material.opacity ?? 1)}`);
    lines.push(`${propertyIndent}float inputs:roughness = ${formatNumber(material.roughness ?? 0.5)}`);
    lines.push(`${propertyIndent}token outputs:surface`);
    lines.push(`${shaderIndent}}`);
    lines.push(`${materialIndent}}`);
  });
  lines.push(`${indent}}`);
  return lines;
}

function buildPaths(
  document: OpenUsdExportDocument,
  validated: ValidatedDocument,
  names: AllocatedNames,
): Readonly<{
  nodePrimPaths: Readonly<Record<string, string>>;
  materialPrimPaths: Readonly<Record<string, string>>;
}> {
  const nodePrimPaths: Record<string, string> = Object.create(null) as Record<string, string>;
  const materialPrimPaths: Record<string, string> = Object.create(null) as Record<string, string>;
  const pathForNode = (nodeId: string): string => {
    if (nodePrimPaths[nodeId] !== undefined) return nodePrimPaths[nodeId];
    const node = validated.nodesById.get(nodeId);
    const name = names.nodeNames.get(nodeId);
    if (node === undefined || name === undefined) throw new Error(`Internal exporter error: missing node ${nodeId}`);
    const parentPath = node.parentId === undefined ? `/${ROOT_PRIM_NAME}` : pathForNode(node.parentId);
    nodePrimPaths[nodeId] = `${parentPath}/${name}`;
    return nodePrimPaths[nodeId];
  };
  for (const nodeId of [...validated.nodesById.keys()].sort(compareStrings)) {
    pathForNode(nodeId);
  }
  for (const material of [...(document.materials ?? [])].sort((a, b) => compareStrings(a.id, b.id))) {
    const name = names.materialNames.get(material.id);
    if (name === undefined) throw new Error(`Internal exporter error: missing material ${material.id}`);
    materialPrimPaths[material.id] = `/${ROOT_PRIM_NAME}/${MATERIALS_SCOPE_NAME}/${name}`;
  }
  return {
    nodePrimPaths: Object.freeze(nodePrimPaths),
    materialPrimPaths: Object.freeze(materialPrimPaths),
  };
}

/** Throws an OpenUsdExportError if the narrow export document is invalid. */
export function assertOpenUsdExportDocument(value: unknown): asserts value is OpenUsdExportDocument {
  validateDocument(value);
}

/**
 * Emits one deterministic, self-contained ASCII USDA layer. This is an export
 * boundary only: it intentionally does not parse arbitrary USD, resolve remote
 * assets, flatten layers, or act as the Workspace transaction authority.
 */
export function exportParametricModelToUsda(document: OpenUsdExportDocument): OpenUsdExportResult {
  const validated = validateDocument(document);
  const names = allocateNames(document, validated);
  const { nodePrimPaths, materialPrimPaths } = buildPaths(document, validated, names);
  const lines = [
    "#usda 1.0",
    "(",
    `    defaultPrim = ${quote(ROOT_PRIM_NAME)}`,
    "    metersPerUnit = 1",
    '    upAxis = "Y"',
    ")",
    "",
    `def Xform ${quote(ROOT_PRIM_NAME)} (`,
    "    customData = {",
    `        string "semaframe:id" = ${quote(document.id)}`,
    `        string "semaframe:label" = ${quote(document.name)}`,
    "    }",
    ")",
    "{",
  ];
  const materialLines = renderMaterials(document.materials ?? [], names, 1);
  if (materialLines.length > 0) lines.push(...materialLines);
  const roots = [...(validated.childrenByParentId.get(undefined) ?? [])].sort((left, right) => {
    const leftName = names.nodeNames.get(left.id) ?? "";
    const rightName = names.nodeNames.get(right.id) ?? "";
    return compareStrings(leftName, rightName) || compareStrings(left.id, right.id);
  });
  for (const root of roots) {
    if (lines[lines.length - 1] !== "{") lines.push("");
    lines.push(...renderNode(root, validated, names, materialPrimPaths, 1));
  }
  lines.push("}", "");
  return {
    format: "usda",
    version: OPEN_USD_EXPORT_VERSION,
    usda: lines.join("\n"),
    nodePrimPaths,
    materialPrimPaths,
  };
}
