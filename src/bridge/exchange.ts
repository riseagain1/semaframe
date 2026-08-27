import type {
  ComponentManifest,
  JSONObject,
  JSONSchema,
  World3DPlacement,
} from "../workspace/components/componentTypes";
import { ComponentRegistry, DEFAULT_COMPONENT_REGISTRY } from "../workspace/components/ComponentRegistry";
import {
  MAX_UNTRUSTED_JSON_SCHEMA_BYTES,
  MAX_UNTRUSTED_JSON_SCHEMA_NODES,
} from "../workspace/components/jsonSchemaSafety";
import { stableStringify } from "../workspace/components/manifestDigest";
import type { WorkspaceConnection } from "../workspace/data/dataTypes";
import { createDeterministicCadHandoffArchive } from "../workspace/modeling/cadHandoffArchive";
import {
  exportParametricModelToUsda,
  type OpenUsdExportMaterial,
  type OpenUsdExportNode,
} from "../workspace/modeling/openUsdExporter";
import { parseParametricPrimitive, type ParametricPrimitive } from "../workspace/modeling/parametricGeometry";
import type { WorkspaceState } from "../workspace/state/workspaceState";
import { bridgeJsonBytes, sha256BridgeBytes, sha256BridgeJson } from "./canonical";
import {
  SEMAFRAME_EXCHANGE_LIMITS,
  SEMAFRAME_EXCHANGE_PATHS,
  SEMAFRAME_EXCHANGE_VERSION,
  SEMAFRAME_EXCHANGE_FORMAT,
  type SemaFrameExchangeArtifact,
  type SemaFrameExchangeConnection,
  type SemaFrameExchangeFile,
  type SemaFrameExchangeManifest,
  type SemaFrameExchangeNode,
  type SemaFrameExchangePackage,
  type SemaFrameExchangeResource,
  type SemaFrameFidelityItem,
  type SemaFrameFidelityReport,
} from "./contracts";
import { createSemaFrameGlb, type SemaFrameGlbNode } from "./glb";

export type CreateSemaFrameExchangeOptions = Readonly<{
  generatorVersion?: string;
  registry?: ComponentRegistry;
  exactStep?: Readonly<{
    bytes: Uint8Array;
    componentIds: readonly string[];
  }>;
}>;

const encoder = new TextEncoder();
const SCHEMA_ANNOTATION_KEYWORDS = new Set([
  "$comment", "default", "description", "example", "examples", "title",
]);
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs", "definitions", "dependentSchemas", "patternProperties", "properties",
]);
const SCHEMA_SINGLE_KEYWORDS = new Set([
  "additionalItems", "additionalProperties", "contains", "contentSchema", "else", "if", "items",
  "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_NUMERIC_KEYWORDS = new Set([
  "exclusiveMaximum", "exclusiveMinimum", "maxContains", "maximum", "maxItems", "maxLength",
  "maxProperties", "minContains", "minimum", "minItems", "minLength", "minProperties", "multipleOf",
]);
const SCHEMA_BOOLEAN_KEYWORDS = new Set([
  "deprecated", "readOnly", "uniqueItems", "writeOnly",
]);
const SCHEMA_TEXT_KEYWORDS = new Set(["contentEncoding", "contentMediaType", "format", "pattern"]);
const SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const CREDENTIAL_QUERY_KEY = /(?:^|[_-])(?:api[_-]?key|authorization|bearer|credential|password|secret|token)(?:$|[_-])/iu;
const RAW_CREDENTIAL_TEXT = /(?:\b(?:bearer|basic)\s+\S{8,}|(?:^|[^A-Za-z0-9])(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._~-]{8,}|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b)/iu;
const LOCAL_PATH_TEXT = /(?:^|[\s"'(])(?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/u;

type ExchangeSchemaSanitizer = (schema: JSONSchema) => JSONSchema;

function normalizedCredentialKey(value: string): string {
  return value.normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function credentialDataKey(value: string): boolean {
  const normalized = normalizedCredentialKey(value);
  const tokens = normalized.split("_").filter(Boolean);
  return tokens.some((token) => [
    "authorization", "bearer", "credential", "password", "secret", "token",
  ].includes(token)) || /(?:^|_)(?:api_key|auth_header|client_secret|private_key)(?:_|$)/u.test(normalized);
}

function privateNetworkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")
    || normalized.endsWith(".local") || normalized.endsWith(".internal")
    || normalized.endsWith(".lan")) {
    return true;
  }
  if (normalized.includes(":")) {
    if (normalized === "::" || normalized === "::1" || normalized.endsWith(":0:0:0:0:0:1")
      || normalized.startsWith("::ffff:")) {
      return true;
    }
    const firstHextet = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
    return Number.isInteger(firstHextet)
      && ((firstHextet & 0xfe00) === 0xfc00
        || (firstHextet & 0xffc0) === 0xfe80
        || (firstHextet & 0xffc0) === 0xfec0);
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
    || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19))
    || octets[0]! >= 224;
}

function sensitiveSchemaText(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/u.test(value) || RAW_CREDENTIAL_TEXT.test(value)
    || LOCAL_PATH_TEXT.test(value) || /^(?:keychain|secret|vault):\/\//iu.test(value.trim())) {
    return true;
  }
  const trimmed = value.trim();
  if (!/^https?:\/\//iu.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return Boolean(url.username || url.password || privateNetworkHost(url.hostname)
      || [...url.searchParams].some(([key, entry]) => CREDENTIAL_QUERY_KEY.test(key) || RAW_CREDENTIAL_TEXT.test(entry)));
  } catch {
    return false;
  }
}

function schemaDataIsPublic(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !sensitiveSchemaText(value);
  if (Array.isArray(value)) return value.every((entry) => schemaDataIsPublic(entry, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) =>
    !credentialDataKey(key) && !sensitiveSchemaText(key) && schemaDataIsPublic(entry, depth + 1));
}

function safeSchemaMemberName(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !sensitiveSchemaText(value);
}

function sanitizeSchemaNode(
  value: unknown,
  budget: { nodes: number },
  depth = 0,
): JSONSchema | boolean {
  if (value === true || value === false) return value;
  if (depth > 32 || !value || typeof value !== "object" || Array.isArray(value)) return {};
  budget.nodes += 1;
  if (budget.nodes > MAX_UNTRUSTED_JSON_SCHEMA_NODES) {
    throw new RangeError("Scene Exchange schema exceeds the bounded node limit");
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [keyword, entry] of Object.entries(record)) {
    if (SCHEMA_ANNOTATION_KEYWORDS.has(keyword)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const children = Object.entries(entry as Record<string, unknown>)
        .filter(([name]) => safeSchemaMemberName(name))
        .map(([name, child]) => [name, sanitizeSchemaNode(child, budget, depth + 1)] as const);
      sanitized[keyword] = Object.fromEntries(children);
      continue;
    }
    if (SCHEMA_SINGLE_KEYWORDS.has(keyword)) {
      if (typeof entry === "boolean") sanitized[keyword] = entry;
      else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        sanitized[keyword] = sanitizeSchemaNode(entry, budget, depth + 1);
      }
      continue;
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
      if (Array.isArray(entry)) sanitized[keyword] = entry.map((child) => sanitizeSchemaNode(child, budget, depth + 1));
      continue;
    }
    if (keyword === "dependencies") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const dependencies: Array<readonly [string, unknown]> = [];
      for (const [name, dependency] of Object.entries(entry as Record<string, unknown>)) {
        if (!safeSchemaMemberName(name)) continue;
        if (Array.isArray(dependency)) {
          dependencies.push([name, dependency
            .filter((item): item is string => typeof item === "string" && safeSchemaMemberName(item))]);
        } else if (dependency && typeof dependency === "object") {
          dependencies.push([name, sanitizeSchemaNode(dependency, budget, depth + 1)]);
        }
      }
      sanitized.dependencies = Object.fromEntries(dependencies);
      continue;
    }
    if (keyword === "dependentRequired") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      sanitized.dependentRequired = Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .filter(([name, names]) => safeSchemaMemberName(name) && Array.isArray(names))
        .map(([name, names]) => [name, (names as unknown[])
          .filter((item): item is string => typeof item === "string" && safeSchemaMemberName(item))]));
      continue;
    }
    if (keyword === "required") {
      if (Array.isArray(entry)) {
        sanitized.required = entry.filter((item): item is string => typeof item === "string" && safeSchemaMemberName(item));
      }
      continue;
    }
    if (keyword === "type") {
      if (typeof entry === "string" && SCHEMA_TYPES.has(entry)) sanitized.type = entry;
      else if (Array.isArray(entry)) {
        sanitized.type = entry.filter((item): item is string => typeof item === "string" && SCHEMA_TYPES.has(item));
      }
      continue;
    }
    if (keyword === "const" || keyword === "enum") {
      if (schemaDataIsPublic(entry)) sanitized[keyword] = structuredClone(entry);
      continue;
    }
    if (SCHEMA_NUMERIC_KEYWORDS.has(keyword)) {
      if (typeof entry === "number" && Number.isFinite(entry)) sanitized[keyword] = entry;
      continue;
    }
    if (SCHEMA_BOOLEAN_KEYWORDS.has(keyword)) {
      if (typeof entry === "boolean") sanitized[keyword] = entry;
      continue;
    }
    if (SCHEMA_TEXT_KEYWORDS.has(keyword)) {
      if (typeof entry === "string" && entry.length <= 8_192 && !sensitiveSchemaText(entry)) {
        sanitized[keyword] = entry;
      }
    }
  }
  return sanitized;
}

function freezeSchemaValue(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeSchemaValue(child);
  Object.freeze(value);
}

function freezeSchema(schema: JSONSchema): JSONSchema {
  freezeSchemaValue(schema);
  return schema;
}

function createExchangeSchemaSanitizer(): ExchangeSchemaSanitizer {
  const cache = new Map<string, JSONSchema>();
  return (schema) => {
    let canonical: string;
    try {
      canonical = stableStringify(schema);
    } catch {
      throw new TypeError("Scene Exchange schema must be acyclic JSON");
    }
    if (encoder.encode(canonical).byteLength > MAX_UNTRUSTED_JSON_SCHEMA_BYTES) {
      throw new RangeError("Scene Exchange schema exceeds the bounded byte limit");
    }
    const cached = cache.get(canonical);
    if (cached) return cached;
    const sanitized = sanitizeSchemaNode(schema, { nodes: 0 });
    const result = freezeSchema((typeof sanitized === "boolean" ? {} : sanitized) as JSONSchema);
    if (cache.size < 256) cache.set(canonical, result);
    return result;
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteProperty(props: JSONObject, name: string, fallback: number): number {
  const value = props[name];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearColor(value: unknown, fallback: string): { r: number; g: number; b: number } {
  const color = typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
  return {
    r: srgbToLinear(Number.parseInt(color.slice(1, 3), 16)),
    g: srgbToLinear(Number.parseInt(color.slice(3, 5), 16)),
    b: srgbToLinear(Number.parseInt(color.slice(5, 7), 16)),
  };
}

function quaternionFromEuler(rotation: World3DPlacement["rotation"]): { x: number; y: number; z: number; w: number } {
  const cx = Math.cos(rotation.x / 2);
  const sx = Math.sin(rotation.x / 2);
  const cy = Math.cos(rotation.y / 2);
  const sy = Math.sin(rotation.y / 2);
  const cz = Math.cos(rotation.z / 2);
  const sz = Math.sin(rotation.z / 2);
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  };
}

function materialFor(componentId: string, value: unknown): OpenUsdExportMaterial {
  const props = value && typeof value === "object" && !Array.isArray(value)
    ? value as JSONObject
    : {};
  return {
    id: `material_${componentId}`,
    name: `${componentId} material`,
    baseColorLinear: linearColor(props.baseColor, "#68D5FF"),
    metallic: finiteProperty(props, "metallic", 0),
    roughness: finiteProperty(props, "roughness", 0.55),
    opacity: finiteProperty(props, "opacity", 1),
    emissiveColorLinear: linearColor(props.emissiveColor, "#000000"),
  };
}

function primitiveFor(typeId: string, props: JSONObject): ParametricPrimitive | undefined {
  if (typeId !== "spatial-primitive") return undefined;
  try {
    return parseParametricPrimitive(props.geometry);
  } catch {
    return undefined;
  }
}

function manifestFor(
  state: Readonly<WorkspaceState>,
  registry: ComponentRegistry,
  typeId: string,
  version: string,
): ComponentManifest | undefined {
  const builtIn = registry.get(typeId, version);
  if (builtIn) return builtIn;
  const recipe = state.recipes.get(`${typeId}@${version}`);
  return recipe ? ComponentRegistry.manifestFromRecipe(recipe) : undefined;
}

function semanticNode(
  state: Readonly<WorkspaceState>,
  registry: ComponentRegistry,
  sanitizeSchema: ExchangeSchemaSanitizer,
  componentId: string,
  exactIds: ReadonlySet<string>,
  usdPrimPaths: Readonly<Record<string, string>>,
  gltfNodeIndexes: Readonly<Record<string, number>>,
): SemaFrameExchangeNode {
  const component = state.components.get(componentId);
  if (!component) throw new TypeError(`Unknown component ${componentId}`);
  const manifest = manifestFor(state, registry, component.type.typeId, component.type.version);
  const primitive = primitiveFor(component.type.typeId, component.props);
  const assetRef = component.type.typeId === "gaussian-splat" && component.props.assetRef
    ? component.props.assetRef
    : undefined;
  const representation = exactIds.has(component.id)
    ? "exact_brep" as const
    : primitive
      ? "parametric_mesh" as const
      : assetRef
        ? "reality_asset" as const
        : "semantic_only" as const;
  return Object.freeze({
    stableId: component.id,
    ...(component.parentId ? { parentStableId: component.parentId } : {}),
    componentType: structuredClone(component.type),
    label: component.label,
    placement: structuredClone(component.placement),
    visibility: component.visibility,
    tags: Object.freeze([...component.tags].sort(compareText)),
    actions: Object.freeze(Object.entries(manifest?.actions ?? {})
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, action]) => Object.freeze({
        name,
        inputSchema: sanitizeSchema(action.inputSchema),
        effectClass: action.effectClass,
        routable: action.routable !== false,
      }))),
    events: Object.freeze(Object.entries(manifest?.events ?? {})
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, payloadSchema]) => Object.freeze({
        name,
        payloadSchema: sanitizeSchema(payloadSchema),
      }))),
    representation,
    ...(usdPrimPaths[component.id] ? { usdPrimPath: usdPrimPaths[component.id] } : {}),
    ...(gltfNodeIndexes[component.id] === undefined ? {} : { gltfNodeIndex: gltfNodeIndexes[component.id] }),
  });
}

function exchangeResource(
  resource: WorkspaceState["resources"] extends Map<string, infer T> ? T : never,
  sanitizeSchema: ExchangeSchemaSanitizer,
): SemaFrameExchangeResource {
  return Object.freeze({
    id: resource.id,
    label: resource.label,
    connectorType: resource.connectorType,
    connectorVersion: resource.connectorVersion,
    outputSchema: sanitizeSchema(resource.outputSchema),
    status: resource.status,
    exportedData: false,
  });
}

function exchangeConnection(connection: WorkspaceConnection): SemaFrameExchangeConnection {
  if (connection.kind === "resource_binding") {
    return Object.freeze({
      id: connection.id,
      kind: connection.kind,
      sourceId: connection.resourceId,
      targetComponentId: connection.componentId,
      sourceSignal: connection.sourcePath ?? "$",
      targetInput: connection.targetProp,
      enabled: connection.enabled,
    });
  }
  return Object.freeze({
    id: connection.id,
    kind: connection.kind,
    sourceId: connection.sourceComponentId,
    targetComponentId: connection.targetComponentId,
    sourceSignal: connection.event,
    targetInput: connection.action,
    enabled: connection.enabled,
  });
}

function fidelityItem(
  node: SemaFrameExchangeNode,
  exactAvailable: boolean,
): SemaFrameFidelityItem {
  if (node.representation === "exact_brep") {
    return Object.freeze({
      componentId: node.stableId,
      level: "exact",
      exportedTo: Object.freeze(["openusd", "glb", "step", "manifest"] as const),
      limitations: Object.freeze([
        "Native downstream feature history is not synthesized; SemaFrame semantic identity remains in the manifest.",
      ]),
    });
  }
  if (node.representation === "parametric_mesh") {
    return Object.freeze({
      componentId: node.stableId,
      level: "parametric",
      exportedTo: Object.freeze(["openusd", "glb", "manifest"] as const),
      limitations: Object.freeze([
        "The polygonal GLB is an interchange view; authoritative parametric values remain in SemaFrame.",
      ]),
    });
  }
  if (node.representation === "reality_asset") {
    return Object.freeze({
      componentId: node.stableId,
      level: "visual",
      exportedTo: Object.freeze(["openusd", "glb", "manifest"] as const),
      limitations: Object.freeze([
        "Reality Asset bytes remain in the host vault and are not embedded in the public scene exchange.",
      ]),
    });
  }
  return Object.freeze({
    componentId: node.stableId,
    level: "semantic",
    exportedTo: Object.freeze(["manifest"] as const),
    limitations: Object.freeze([
      node.placement.space === "world3d"
        ? "This component exports as an OpenUSD/GLB transform without generated geometry."
        : "2D layout and behavior are preserved semantically, not converted into 3D geometry.",
      ...(exactAvailable ? [] : ["No exact STEP artifact was supplied for this exchange."]),
    ]),
  });
}

async function file(path: string, mediaType: string, bytes: Uint8Array): Promise<SemaFrameExchangeFile> {
  return Object.freeze({
    path,
    mediaType,
    bytes,
    byteLength: bytes.byteLength,
    sha256: await sha256BridgeBytes(bytes),
  });
}

function descriptor(value: SemaFrameExchangeFile): SemaFrameExchangeArtifact {
  return Object.freeze({
    path: value.path,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    sha256: value.sha256,
  });
}

function archiveName(workspaceId: string): string {
  const safe = workspaceId.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `${safe || "workspace"}.semaframe-exchange`;
}

/**
 * Export one immutable Workspace revision without leaking connector config,
 * credentials, snapshot data, local paths, or Reality Asset bytes.
 */
export async function createSemaFrameExchange(
  state: Readonly<WorkspaceState>,
  options: CreateSemaFrameExchangeOptions = {},
): Promise<SemaFrameExchangePackage> {
  if (state.components.size > SEMAFRAME_EXCHANGE_LIMITS.maximumComponents) {
    throw new RangeError("Workspace has too many components for Scene Exchange 1.0");
  }
  if (state.connections.size > SEMAFRAME_EXCHANGE_LIMITS.maximumConnections) {
    throw new RangeError("Workspace has too many connections for Scene Exchange 1.0");
  }
  if (state.resources.size > SEMAFRAME_EXCHANGE_LIMITS.maximumResources) {
    throw new RangeError("Workspace has too many resources for Scene Exchange 1.0");
  }
  if (options.exactStep && options.exactStep.bytes.byteLength < 1) {
    throw new TypeError("Exact STEP geometry must contain bytes");
  }
  if (options.exactStep
    && new Set(options.exactStep.componentIds).size !== options.exactStep.componentIds.length) {
    throw new TypeError("Exact STEP mapping contains duplicate component IDs");
  }
  const registry = options.registry ?? DEFAULT_COMPONENT_REGISTRY;
  const sanitizeSchema = createExchangeSchemaSanitizer();
  const worldComponents = [...state.components.values()]
    .filter((component) => component.placement.space === "world3d")
    .sort((left, right) => compareText(left.id, right.id));
  const worldIds = new Set(worldComponents.map((component) => component.id));
  const glbNodes: SemaFrameGlbNode[] = worldComponents.map((component) => {
    const placement = component.placement as World3DPlacement;
    const primitive = primitiveFor(component.type.typeId, component.props);
    return Object.freeze({
      id: component.id,
      label: component.label,
      ...(component.parentId && worldIds.has(component.parentId) ? { parentId: component.parentId } : {}),
      componentType: `${component.type.typeId}@${component.type.version}`,
      placement: structuredClone(placement),
      ...(primitive ? { primitive } : {}),
      ...(component.props.material && typeof component.props.material === "object" && !Array.isArray(component.props.material)
        ? { material: structuredClone(component.props.material as JSONObject) }
        : {}),
      visible: component.visibility === "visible",
    });
  });
  const glb = createSemaFrameGlb(glbNodes);

  const materials: OpenUsdExportMaterial[] = [];
  const usdNodes: OpenUsdExportNode[] = worldComponents.map((component) => {
    const placement = component.placement as World3DPlacement;
    const primitive = primitiveFor(component.type.typeId, component.props);
    const material = primitive ? materialFor(component.id, component.props.material) : undefined;
    if (material) materials.push(material);
    return Object.freeze({
      id: component.id,
      name: component.label,
      ...(component.parentId && worldIds.has(component.parentId) ? { parentId: component.parentId } : {}),
      transform: Object.freeze({
        translationM: Object.freeze({ ...placement.position }),
        rotationQuaternion: Object.freeze(quaternionFromEuler(placement.rotation)),
        scale: Object.freeze({ ...placement.scale }),
      }),
      ...(primitive ? { primitive } : {}),
      ...(material ? { materialId: material.id } : {}),
      visible: component.visibility === "visible",
    });
  });
  const usd = exportParametricModelToUsda({
    id: state.workspaceId,
    name: `SemaFrame workspace ${state.workspaceId}`,
    nodes: usdNodes,
    materials,
  });
  const usdFile = await file(SEMAFRAME_EXCHANGE_PATHS.openUsd, "model/vnd.usda", encoder.encode(usd.usda));
  const glbFile = await file(SEMAFRAME_EXCHANGE_PATHS.glb, "model/gltf-binary", glb.bytes);
  const optionalStep = options.exactStep
    ? await file(SEMAFRAME_EXCHANGE_PATHS.exactStep, "model/step", options.exactStep.bytes)
    : undefined;
  const exactIds = new Set(options.exactStep?.componentIds ?? []);
  const unknownExactId = [...exactIds].find((id) => !state.components.has(id));
  if (unknownExactId) throw new TypeError(`Exact STEP mapping references unknown component ${unknownExactId}`);
  const nonWorldExactId = [...exactIds].find((id) => state.components.get(id)?.placement.space !== "world3d");
  if (nonWorldExactId) throw new TypeError(`Exact STEP mapping requires a world3d component: ${nonWorldExactId}`);
  const nodes = Object.freeze([...state.components.keys()].sort(compareText).map((id) => semanticNode(
    state,
    registry,
    sanitizeSchema,
    id,
    exactIds,
    usd.nodePrimPaths,
    glb.nodeIndexes,
  )));
  const resources = Object.freeze([...state.resources.values()]
    .sort((left, right) => compareText(left.id, right.id))
    .map((resource) => exchangeResource(resource, sanitizeSchema)));
  const connections = Object.freeze([...state.connections.values()]
    .sort((left, right) => compareText(left.id, right.id))
    .map(exchangeConnection));
  const coordinateSystem = Object.freeze({
    units: "metre" as const,
    handedness: "right" as const,
    upAxis: "Y" as const,
    angles: "radian" as const,
  });
  // This digest is intentionally derived only from the public projection. A
  // full Workspace digest would fingerprint connector configuration, secret
  // handles, cached feed values, local paths, and private Reality metadata even
  // though those values never cross the exchange boundary.
  const workspaceDigest = await sha256BridgeJson({
    workspaceId: state.workspaceId,
    revision: state.revision,
    registryDigest: state.registryDigest,
    coordinateSystem,
    nodes,
    resources,
    connections,
    geometryArtifacts: [usdFile, glbFile, ...(optionalStep ? [optionalStep] : [])].map(descriptor),
  });
  const source = Object.freeze({
    workspaceId: state.workspaceId,
    revision: state.revision,
    workspaceDigest,
    registryDigest: state.registryDigest,
  });
  const items = Object.freeze(nodes.map((node) => fidelityItem(node, Boolean(optionalStep))));
  const summary = Object.freeze({
    exact: items.filter((item) => item.level === "exact").length,
    parametric: items.filter((item) => item.level === "parametric").length,
    visual: items.filter((item) => item.level === "visual").length,
    semantic: items.filter((item) => item.level === "semantic").length,
  });
  const limitations = Object.freeze([
    "Connector configuration, secret references, cached feed values, local paths and host-vault Reality Asset bytes are intentionally excluded.",
    "Downstream edits are never authoritative until returned as a reviewed change proposal and committed by WorkspaceStore.",
    ...(optionalStep ? [] : ["This package does not contain exact STEP B-rep geometry."]),
  ]);
  const report: SemaFrameFidelityReport = Object.freeze({
    format: "semaframe-fidelity-report",
    version: SEMAFRAME_EXCHANGE_VERSION,
    outcome: limitations.length ? "passed_with_limitations" : "passed",
    source,
    items,
    summary,
    limitations,
  });
  const reportFile = await file(SEMAFRAME_EXCHANGE_PATHS.report, "application/json", bridgeJsonBytes(report));
  const exchangeArtifacts = [usdFile, glbFile, ...(optionalStep ? [optionalStep] : []), reportFile]
    .sort((left, right) => compareText(left.path, right.path));
  const manifest: SemaFrameExchangeManifest = Object.freeze({
    format: SEMAFRAME_EXCHANGE_FORMAT,
    version: SEMAFRAME_EXCHANGE_VERSION,
    generator: Object.freeze({ name: "SemaFrame", version: options.generatorVersion ?? "0.4.0" }),
    source,
    coordinateSystem,
    nodes,
    resources,
    connections,
    files: Object.freeze(exchangeArtifacts.map(descriptor)),
    roundTrip: Object.freeze({
      stableIds: true,
      directMutation: false,
      editsReturnAs: "reviewable_change_proposal",
    }),
  });
  const manifestFile = await file(SEMAFRAME_EXCHANGE_PATHS.manifest, "application/json", bridgeJsonBytes(manifest));
  const files = Object.freeze([...exchangeArtifacts, manifestFile].sort((left, right) => compareText(left.path, right.path)));
  const archiveBytes = createDeterministicCadHandoffArchive(files.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
  })));
  const archive = await file(
    archiveName(state.workspaceId),
    "application/vnd.semaframe.exchange+zip",
    archiveBytes,
  );
  if (!stableStringify(manifest).includes(state.workspaceId)) {
    throw new TypeError("Scene Exchange manifest lost its source identity");
  }
  return Object.freeze({
    format: "semaframe-exchange-package",
    version: SEMAFRAME_EXCHANGE_VERSION,
    archive,
    files,
    manifest,
    report,
  });
}
