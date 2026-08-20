import type { World3DPlacement } from "../../../workspace/components";
import {
  instantiateModelDefinition,
  type ModelDefinition,
} from "../../../workspace/modeling";
import { buildSemaFrameSpatialGraph, findBlockingSpatialCollisions } from "../../../workspace/spatial";
import type { WorkspaceState } from "../../../workspace/state";

export type WorkspaceModelInstancePlan = Readonly<{
  idMap: Readonly<Record<string, string>>;
  rootPlacement: World3DPlacement;
  rootComponentId: string;
}>;

export type WorkspaceModelExportGateResult<T> =
  | Readonly<{ started: true; value: T }>
  | Readonly<{ started: false; activeLabel: string }>;

/**
 * App-lifetime mutual exclusion for geometry/CAD workers. Keeping this gate
 * outside the Models panel prevents close/reopen from launching a duplicate
 * heavy export while the first worker is still active.
 */
export class WorkspaceModelExportGate {
  private activeLabel?: string;

  get active(): string | undefined {
    return this.activeLabel;
  }

  async run<T>(label: string, operation: () => Promise<T>): Promise<WorkspaceModelExportGateResult<T>> {
    if (this.activeLabel) return { started: false, activeLabel: this.activeLabel };
    this.activeLabel = label;
    try {
      return { started: true, value: await operation() };
    } finally {
      this.activeLabel = undefined;
    }
  }
}

function identityAt(x: number): World3DPlacement {
  return {
    space: "world3d",
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function stateWithInstances(
  state: Readonly<WorkspaceState>,
  definition: ModelDefinition,
  idMap: Readonly<Record<string, string>>,
  rootPlacement: World3DPlacement,
): WorkspaceState {
  const components = new Map(state.components);
  for (const component of instantiateModelDefinition(definition, {
    idMap,
    rootPlacement,
    createdRevision: state.revision + 1,
    createdBy: "user",
  })) components.set(component.id, component);
  return { ...state, components };
}

/**
 * Plan a deterministic, collision-free model instance to the right of the
 * current spatial envelope. Store validation remains authoritative at commit.
 */
export function planWorkspaceModelInstance(
  state: Readonly<WorkspaceState>,
  definition: ModelDefinition,
  reservedIds: readonly string[],
): WorkspaceModelInstancePlan {
  if (reservedIds.length !== definition.nodes.length) {
    throw new Error(`Model ${definition.modelId}@${definition.version} requires ${definition.nodes.length} reserved component IDs.`);
  }
  if (new Set(reservedIds).size !== reservedIds.length || reservedIds.some((id) => !id)) {
    throw new Error("Reserved model instance IDs must be non-empty and unique.");
  }
  if (reservedIds.some((id) => state.components.has(id))) {
    throw new Error("A reserved model instance ID is already used by this workspace.");
  }
  const idMap = Object.fromEntries(definition.nodes.map((node, index) => [node.nodeId, reservedIds[index]!]));
  const candidateIds = new Set(reservedIds);

  // Evaluate the definition once at the origin so the placement offset uses
  // exact transformed primitive bounds instead of a guessed grid size.
  const originState = stateWithInstances({ ...state, components: new Map(
    [...state.components].filter(([, component]) => component.type.typeId === "stage-3d"),
  ) }, definition, idMap, identityAt(0));
  const originNodes = buildSemaFrameSpatialGraph(originState, { maxNodes: 2_000 }).nodes
    .filter((node) => candidateIds.has(node.id));
  const modelMinX = originNodes.length
    ? Math.min(...originNodes.map((node) => node.worldBounds.min.x))
    : 0;
  const modelMaxX = originNodes.length
    ? Math.max(...originNodes.map((node) => node.worldBounds.max.x))
    : 0;
  const existingNodes = buildSemaFrameSpatialGraph(state, { maxNodes: 2_000 }).nodes;
  const existingMaxX = existingNodes.length
    ? Math.max(...existingNodes.map((node) => node.worldBounds.max.x))
    : -0.25;
  const clearanceM = 0.25;
  const modelWidthM = Math.max(clearanceM, modelMaxX - modelMinX);
  const initialX = existingMaxX - modelMinX + clearanceM;

  // The first placement is separated on X by exact AABB bounds. A short,
  // bounded fallback handles unusual colliders whose collision envelope is
  // intentionally larger than the render geometry.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rootPlacement = identityAt(initialX + attempt * (modelWidthM + clearanceM));
    const preview = stateWithInstances(state, definition, idMap, rootPlacement);
    const conflict = findBlockingSpatialCollisions(preview).some((entry) =>
      candidateIds.has(entry.componentId) || candidateIds.has(entry.conflictsWith));
    if (!conflict) {
      return {
        idMap,
        rootPlacement,
        rootComponentId: idMap[definition.rootNodeId]!,
      };
    }
  }
  throw new Error(`No collision-free placement was found for ${definition.displayName}. Move nearby objects and try again.`);
}
