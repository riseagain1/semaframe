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

export const MODEL_DEFINITION_FORMAT_VERSION = "1.0" as const;
export const MODEL_DEFINITION_GENERATOR_VERSION = "1.0.0" as const;
export const MAX_MODEL_DEFINITION_NODES = 256;

export type ModelDefinitionRef = Readonly<{
  modelId: string;
  version: string;
  digest: string;
}>;

export type ModelDefinitionNode = Readonly<{
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

export type ModelDefinition = Readonly<{
  formatVersion: typeof MODEL_DEFINITION_FORMAT_VERSION;
  modelId: string;
  version: string;
  digest: string;
  displayName: string;
  rootNodeId: string;
  nodes: readonly ModelDefinitionNode[];
  sourceRevision: number;
  generatorVersion: typeof MODEL_DEFINITION_GENERATOR_VERSION;
}>;

export class ModelDefinitionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ModelDefinitionError";
  }
}

const MODEL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
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

function definitionContent(definition: Omit<ModelDefinition, "digest">): Omit<ModelDefinition, "digest"> {
  return structuredClone(definition);
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
    if (component.type.typeId !== "model-assembly" && component.type.typeId !== "spatial-primitive") {
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
  const nodes: ModelDefinitionNode[] = ordered.map((component) => ({
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
  const content: Omit<ModelDefinition, "digest"> = {
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
  if (definition.formatVersion !== MODEL_DEFINITION_FORMAT_VERSION
    || definition.generatorVersion !== MODEL_DEFINITION_GENERATOR_VERSION) {
    throw new ModelDefinitionError("Unsupported model definition generator or format", "unsupported_model_definition");
  }
  if (!definition.nodes.length || definition.nodes.length > MAX_MODEL_DEFINITION_NODES) {
    throw new ModelDefinitionError("Model definition node count is invalid", "invalid_model_nodes");
  }
  const byId = new Map<string, ModelDefinitionNode>();
  for (const node of definition.nodes) {
    if (byId.has(node.nodeId)) throw new ModelDefinitionError(`Duplicate model node ${node.nodeId}`, "duplicate_model_node");
    worldPlacement(node.placement, node.nodeId);
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
    const props = structuredClone(node.props);
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
