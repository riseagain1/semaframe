import type {
  ComponentInstance,
  ComponentPlacement,
  ComponentTypeRef,
  ComponentVisibility,
  ComponentVisualEffects,
  JSONObject,
  World3DPlacement,
} from "../components/componentTypes";
import { deterministicDigest } from "../components/manifestDigest";

export const LEGACY_MODEL_DEFINITION_FORMAT_VERSION = "1.0" as const;
export const LEGACY_MODEL_DEFINITION_GENERATOR_VERSION = "1.0.0" as const;
export const MODEL_DEFINITION_FORMAT_VERSION = "2.0" as const;
export const MODEL_DEFINITION_GENERATOR_VERSION = "2.0.0" as const;
export const MAX_MODEL_DEFINITION_NODES = 256;

export type ModelDefinitionRef = Readonly<{
  modelId: string;
  version: string;
  digest: string;
}>;

export type ModelDefinitionNodeV1 = Readonly<{
  nodeId: string;
  sourceComponentId: string;
  parentNodeId?: string;
  componentType: ComponentTypeRef;
  label: string;
  props: JSONObject;
  durableState: JSONObject;
  placement: World3DPlacement;
  tags: readonly string[];
  visibility: ComponentVisibility;
  visualEffects?: ComponentVisualEffects;
}>;

export type ModelDefinitionNodeV2 = ModelDefinitionNodeV1 & Readonly<{
  /** Stable within one published model version and independent of instance IDs. */
  logicalNodeId: string;
  /** Optional manufacturing-facing identity retained in the CAD handoff sidecar. */
  partNumber?: string;
  materialName?: string;
}>;

export type ModelDefinitionNode = ModelDefinitionNodeV1 | ModelDefinitionNodeV2;

type ModelDefinitionBase<Node extends ModelDefinitionNode> = Readonly<{
  modelId: string;
  version: string;
  digest: string;
  displayName: string;
  rootNodeId: string;
  nodes: readonly Node[];
  sourceRevision: number;
}>;

export type ModelDefinitionV1 = ModelDefinitionBase<ModelDefinitionNodeV1> & Readonly<{
  formatVersion: typeof LEGACY_MODEL_DEFINITION_FORMAT_VERSION;
  generatorVersion: typeof LEGACY_MODEL_DEFINITION_GENERATOR_VERSION;
}>;

export type ModelDefinitionV2 = ModelDefinitionBase<ModelDefinitionNodeV2> & Readonly<{
  formatVersion: typeof MODEL_DEFINITION_FORMAT_VERSION;
  generatorVersion: typeof MODEL_DEFINITION_GENERATOR_VERSION;
}>;

export type ModelDefinition = ModelDefinitionV1 | ModelDefinitionV2;

export class ModelDefinitionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ModelDefinitionError";
  }
}

const MODEL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const COMPONENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;

function assertModelIdentity(modelId: string, version: string, displayName: string): void {
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw new ModelDefinitionError("Model ID must be a stable namespaced identifier", "invalid_model_id");
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new ModelDefinitionError("Model version must use semantic version syntax", "invalid_model_version");
  }
  if (!displayName.trim() || displayName.length > 256) {
    throw new ModelDefinitionError("Model display name must contain 1 to 256 characters", "invalid_model_name");
  }
}

function identityPlacement(): World3DPlacement {
  return {
    space: "world3d",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function worldPlacement(value: ComponentPlacement, id: string): World3DPlacement {
  if (value.space !== "world3d") {
    throw new ModelDefinitionError(`Model component ${id} must use world3d placement`, "model_component_space");
  }
  return structuredClone(value);
}

function definitionContent<T extends Omit<ModelDefinition, "digest">>(definition: T): T {
  return structuredClone(definition);
}

function assemblyHasCadSemantics(component: ComponentInstance): boolean {
  if (component.type.typeId !== "model-assembly") return false;
  return (Array.isArray(component.props.mates) && component.props.mates.length > 0)
    || optionalNonEmptyString(component.props.partNumber, 128) !== undefined
    || optionalNonEmptyString(component.props.materialName, 256) !== undefined;
}

function modelUsesV2(components: readonly ComponentInstance[]): boolean {
  return components.some((component) => component.type.typeId === "cad-part" || assemblyHasCadSemantics(component));
}

function optionalNonEmptyString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

export type CreateModelDefinitionInput = Readonly<{
  modelId: string;
  version: string;
  displayName: string;
  rootComponentId: string;
  sourceRevision: number;
}>;

/** Capture an authoritative world3d component subtree as an immutable model template. */
export function createModelDefinition(
  components: ReadonlyMap<string, ComponentInstance>,
  input: CreateModelDefinitionInput,
): ModelDefinition {
  assertModelIdentity(input.modelId, input.version, input.displayName);
  const root = components.get(input.rootComponentId);
  if (!root) throw new ModelDefinitionError(`Unknown model root ${input.rootComponentId}`, "unknown_model_root");
  if (root.type.typeId !== "model-assembly") {
    throw new ModelDefinitionError("Published models require a model-assembly root", "invalid_model_root");
  }
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0) {
    throw new ModelDefinitionError("Model source revision is invalid", "invalid_model_revision");
  }

  const children = new Map<string, ComponentInstance[]>();
  for (const component of components.values()) {
    if (!component.parentId) continue;
    const list = children.get(component.parentId) ?? [];
    list.push(component);
    children.set(component.parentId, list);
  }
  for (const list of children.values()) list.sort((left, right) => left.id.localeCompare(right.id));

  const ordered: ComponentInstance[] = [];
  const visit = (component: ComponentInstance): void => {
    if (ordered.length >= MAX_MODEL_DEFINITION_NODES) {
      throw new ModelDefinitionError(
        `A model definition supports at most ${MAX_MODEL_DEFINITION_NODES} nodes`,
        "model_too_many_nodes",
      );
    }
    if (component.type.typeId !== "model-assembly"
      && component.type.typeId !== "spatial-primitive"
      && component.type.typeId !== "cad-part") {
      throw new ModelDefinitionError(
        `Unsupported model component type ${component.type.typeId}`,
        "unsupported_model_component",
      );
    }
    worldPlacement(component.placement, component.id);
    ordered.push(component);
    for (const child of children.get(component.id) ?? []) visit(child);
  };
  visit(root);

  const included = new Set(ordered.map((component) => component.id));
  const useV2 = modelUsesV2(ordered);
  const commonNodes: ModelDefinitionNodeV1[] = ordered.map((component) => ({
    nodeId: component.id,
    sourceComponentId: component.id,
    ...(component.parentId && included.has(component.parentId) ? { parentNodeId: component.parentId } : {}),
    componentType: structuredClone(component.type),
    label: component.label,
    props: structuredClone(component.props),
    durableState: structuredClone(component.durableState),
    placement: component.id === root.id ? identityPlacement() : worldPlacement(component.placement, component.id),
    tags: [...component.tags].sort((left, right) => left.localeCompare(right)),
    visibility: component.visibility,
    ...(component.visualEffects ? { visualEffects: structuredClone(component.visualEffects) } : {}),
  }));
  if (!useV2) {
    const content: Omit<ModelDefinitionV1, "digest"> = {
      formatVersion: LEGACY_MODEL_DEFINITION_FORMAT_VERSION,
      modelId: input.modelId,
      version: input.version,
      displayName: input.displayName.trim(),
      rootNodeId: root.id,
      nodes: commonNodes,
      sourceRevision: input.sourceRevision,
      generatorVersion: LEGACY_MODEL_DEFINITION_GENERATOR_VERSION,
    };
    return Object.freeze({ ...content, digest: deterministicDigest(definitionContent(content)) });
  }
  const nodes: ModelDefinitionNodeV2[] = commonNodes.map((node) => {
    const source = components.get(node.sourceComponentId);
    const partNumber = optionalNonEmptyString(source?.props.partNumber, 128);
    const materialName = optionalNonEmptyString(source?.props.materialName, 256);
    return {
      ...node,
      logicalNodeId: node.nodeId,
      ...(partNumber ? { partNumber } : {}),
      ...(materialName ? { materialName } : {}),
    };
  });
  const content: Omit<ModelDefinitionV2, "digest"> = {
    formatVersion: MODEL_DEFINITION_FORMAT_VERSION,
    modelId: input.modelId,
    version: input.version,
    displayName: input.displayName.trim(),
    rootNodeId: root.id,
    nodes,
    sourceRevision: input.sourceRevision,
    generatorVersion: MODEL_DEFINITION_GENERATOR_VERSION,
  };
  return Object.freeze({ ...content, digest: deterministicDigest(definitionContent(content)) });
}

export function modelDefinitionKey(value: Pick<ModelDefinition, "modelId" | "version">): string {
  return `${value.modelId}@${value.version}`;
}

export function modelDefinitionRef(definition: ModelDefinition): ModelDefinitionRef {
  return { modelId: definition.modelId, version: definition.version, digest: definition.digest };
}

export function assertModelDefinition(definition: ModelDefinition): void {
  assertModelIdentity(definition.modelId, definition.version, definition.displayName);
  const isV1 = definition.formatVersion === LEGACY_MODEL_DEFINITION_FORMAT_VERSION
    && definition.generatorVersion === LEGACY_MODEL_DEFINITION_GENERATOR_VERSION;
  const isV2 = definition.formatVersion === MODEL_DEFINITION_FORMAT_VERSION
    && definition.generatorVersion === MODEL_DEFINITION_GENERATOR_VERSION;
  if (!isV1 && !isV2) {
    throw new ModelDefinitionError("Unsupported model definition generator or format", "unsupported_model_definition");
  }
  if (!definition.nodes.length || definition.nodes.length > MAX_MODEL_DEFINITION_NODES) {
    throw new ModelDefinitionError("Model definition node count is invalid", "invalid_model_nodes");
  }
  const byId = new Map<string, ModelDefinitionNode>();
  const logicalIds = new Set<string>();
  for (const node of definition.nodes) {
    if (byId.has(node.nodeId)) throw new ModelDefinitionError(`Duplicate model node ${node.nodeId}`, "duplicate_model_node");
    worldPlacement(node.placement, node.nodeId);
    if (isV2) {
      if (!("logicalNodeId" in node) || !COMPONENT_ID_PATTERN.test(node.logicalNodeId)) {
        throw new ModelDefinitionError(`Model node ${node.nodeId} has an invalid logical ID`, "invalid_model_logical_id");
      }
      if (logicalIds.has(node.logicalNodeId)) {
        throw new ModelDefinitionError(`Duplicate logical model node ${node.logicalNodeId}`, "duplicate_model_logical_id");
      }
      logicalIds.add(node.logicalNodeId);
      if (node.partNumber !== undefined && (!node.partNumber.trim() || node.partNumber.length > 128)) {
        throw new ModelDefinitionError(`Model node ${node.nodeId} has an invalid part number`, "invalid_model_part_number");
      }
      if (node.materialName !== undefined && (!node.materialName.trim() || node.materialName.length > 256)) {
        throw new ModelDefinitionError(`Model node ${node.nodeId} has an invalid material name`, "invalid_model_material");
      }
    } else if ("logicalNodeId" in node || "partNumber" in node || "materialName" in node) {
      throw new ModelDefinitionError(`Legacy model node ${node.nodeId} contains V2 metadata`, "invalid_legacy_model_node");
    }
    byId.set(node.nodeId, node);
  }
  if (!byId.has(definition.rootNodeId)) throw new ModelDefinitionError("Model root node is missing", "missing_model_root");
  for (const node of definition.nodes) {
    if (node.parentNodeId && !byId.has(node.parentNodeId)) {
      throw new ModelDefinitionError(`Model node ${node.nodeId} has a missing parent`, "missing_model_parent");
    }
  }
  const visit = (id: string, visiting = new Set<string>(), visited = new Set<string>()): void => {
    if (visiting.has(id)) throw new ModelDefinitionError(`Model hierarchy cycle includes ${id}`, "model_hierarchy_cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    const parent = byId.get(id)?.parentNodeId;
    if (parent) visit(parent, visiting, visited);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  const { digest: _digest, ...content } = definition;
  if (deterministicDigest(definitionContent(content)) !== definition.digest) {
    throw new ModelDefinitionError("Model definition digest does not match its content", "model_digest_mismatch");
  }
}

export type InstantiateModelInput = Readonly<{
  idMap: Readonly<Record<string, string>>;
  rootPlacement: World3DPlacement;
  createdRevision: number;
  createdBy: "user" | "agent" | "system" | "migration";
}>;

function rewriteAssemblyReferences(
  node: ModelDefinitionNode,
  idMap: Readonly<Record<string, string>>,
): JSONObject {
  const props = structuredClone(node.props);
  if (node.componentType.typeId !== "model-assembly" || !Array.isArray(props.mates)) return props;
  props.mates = props.mates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const mate = structuredClone(candidate) as JSONObject;
    for (const endpoint of ["a", "b"] as const) {
      const raw = mate[endpoint];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const value = structuredClone(raw) as JSONObject;
      if (typeof value.componentId === "string" && idMap[value.componentId]) {
        value.componentId = idMap[value.componentId]!;
      }
      mate[endpoint] = value;
    }
    return mate;
  });
  return props;
}

/** Materialize a digest-pinned definition as ordinary editable Workspace components. */
export function instantiateModelDefinition(
  definition: ModelDefinition,
  input: InstantiateModelInput,
): ComponentInstance[] {
  assertModelDefinition(definition);
  const nodeIds = new Set(definition.nodes.map((node) => node.nodeId));
  const supplied = Object.keys(input.idMap);
  if (supplied.length !== nodeIds.size || supplied.some((id) => !nodeIds.has(id))) {
    throw new ModelDefinitionError("Model instance requires exactly one component ID per model node", "invalid_model_id_map");
  }
  const componentIds = Object.values(input.idMap);
  if (new Set(componentIds).size !== componentIds.length || componentIds.some((id) => !id)) {
    throw new ModelDefinitionError("Model instance component IDs must be non-empty and unique", "invalid_model_id_map");
  }
  const ref = modelDefinitionRef(definition);
  return definition.nodes.map((node): ComponentInstance => {
    const id = input.idMap[node.nodeId]!;
    const isRoot = node.nodeId === definition.rootNodeId;
    const props = definition.formatVersion === MODEL_DEFINITION_FORMAT_VERSION
      ? rewriteAssemblyReferences(node, input.idMap)
      : structuredClone(node.props);
    if (isRoot) props.modelRef = structuredClone(ref) as unknown as JSONObject;
    return {
      id,
      type: structuredClone(node.componentType),
      label: node.label,
      props,
      durableState: structuredClone(node.durableState),
      placement: isRoot ? structuredClone(input.rootPlacement) : structuredClone(node.placement),
      ...(node.parentNodeId ? { parentId: input.idMap[node.parentNodeId] } : {}),
      bindings: [],
      tags: [...node.tags, `model-instance:${definition.modelId}@${definition.version}`]
        .filter((tag, index, tags) => tags.indexOf(tag) === index),
      visibility: node.visibility,
      ...(node.visualEffects ? { visualEffects: structuredClone(node.visualEffects) } : {}),
      locks: {
        placement: false,
        resize: false,
        visualEffects: false,
        props: false,
        deletion: false,
        actions: false,
      },
      provenance: {
        createdRevision: input.createdRevision,
        createdBy: input.createdBy,
        sourceId: node.sourceComponentId,
      },
    };
  });
}
