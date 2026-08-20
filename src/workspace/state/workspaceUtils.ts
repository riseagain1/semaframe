import type { ComponentInstance, ComponentRecipe } from "../components/componentTypes";
import type { EventConnection } from "../data/dataTypes";
import {
  ComponentRegistry,
  type ComponentRegistry as ComponentRegistryType,
} from "../components/ComponentRegistry";
import type { WorkspaceDelta } from "../protocol/workspaceTypes";
import type { WorkspaceState } from "./workspaceState";

export function cloneWorkspaceState(state: WorkspaceState): WorkspaceState {
  return structuredClone(state);
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, item]) => [key, canonicalize(item)]);
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function semanticWorkspaceEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function changedMapKeys<T>(before: ReadonlyMap<string, T>, after: ReadonlyMap<string, T>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .filter((key) => !semanticWorkspaceEqual(before.get(key), after.get(key)))
    .sort((left, right) => left.localeCompare(right));
}

export function computeWorkspaceDelta(before: WorkspaceState, after: WorkspaceState): WorkspaceDelta {
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const [id, component] of after.components) {
    const prior = before.components.get(id);
    if (!prior) added.push(id);
    else if (!semanticWorkspaceEqual(prior, component)) updated.push(id);
  }
  for (const id of before.components.keys()) if (!after.components.has(id)) removed.push(id);
  const sort = (items: string[]) => items.sort((left, right) => left.localeCompare(right));
  return {
    fromRevision: before.revision,
    toRevision: after.revision,
    added: sort(added),
    updated: sort(updated),
    removed: sort(removed),
    resourcesChanged: changedMapKeys(before.resources, after.resources),
    connectionsChanged: changedMapKeys(before.connections, after.connections),
    viewsChanged: changedMapKeys(before.sharedViews, after.sharedViews),
    modelsChanged: changedMapKeys(before.modelDefinitions, after.modelDefinitions),
    registryChanged: before.registryDigest !== after.registryDigest,
  };
}

export function buildEffectiveRegistry(
  base: ComponentRegistryType,
  recipes: ReadonlyMap<string, ComponentRecipe>,
): ComponentRegistryType {
  if (recipes.size === 0) return base;
  const recipeManifests = [...recipes.values()]
    .sort((left, right) => `${left.typeId}@${left.version}`.localeCompare(`${right.typeId}@${right.version}`))
    .map(ComponentRegistry.manifestFromRecipe);
  return new ComponentRegistry([...base.list(), ...recipeManifests]);
}

function anchoredTarget(component: ComponentInstance): string | undefined {
  return component.placement.space === "surface" || component.placement.space === "billboard"
    ? component.placement.targetId
    : undefined;
}

function assertAcyclic(
  nodes: Iterable<string>,
  edgesFrom: (id: string) => Iterable<string>,
  errorPrefix: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`${errorPrefix} cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of edgesFrom(id)) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes) visit(id);
}

export function validateWorkspaceGraphs(state: WorkspaceState): void {
  const stages = [...state.components.values()].filter(
    (component) => component.type.typeId === "stage-3d",
  );
  if (stages.length > 1) {
    throw new Error("Workspace supports exactly one stage-3d basis");
  }
  const stage = stages[0];
  if (stage?.parentId) {
    throw new Error(`Stage ${stage.id} must be a root component`);
  }
  for (const component of state.components.values()) {
    if (component === stage) continue;
    if (
      component.placement.space === "world3d"
      || component.placement.space === "surface"
      || component.placement.space === "billboard"
    ) {
      if (!stage) {
        throw new Error(
          `Component ${component.id} requires a stage-3d basis before ${component.placement.space} placement`,
        );
      }
    }
  }
  for (const component of state.components.values()) {
    if (component.parentId && !state.components.has(component.parentId)) {
      throw new Error(`Component ${component.id} has missing parent ${component.parentId}`);
    }
    const target = anchoredTarget(component);
    if (target && !state.components.has(target)) {
      throw new Error(`Component ${component.id} has missing placement target ${target}`);
    }
    if (component.parentId === component.id || target === component.id) {
      throw new Error(`Component ${component.id} cannot reference itself`);
    }
  }
  assertAcyclic(
    state.components.keys(),
    (id) => {
      const component = state.components.get(id);
      if (!component) return [];
      return [component.parentId, anchoredTarget(component)].filter((item): item is string => Boolean(item));
    },
    "Component attachment/anchor",
  );

  const eventConnections = [...state.connections.values()].filter(
    (connection): connection is EventConnection =>
      connection.kind === "event_connection" && connection.enabled,
  );
  const eventTargetsBySource = new Map<string, string[]>();
  for (const connection of eventConnections) {
    const targets = eventTargetsBySource.get(connection.sourceComponentId) ?? [];
    targets.push(connection.targetComponentId);
    eventTargetsBySource.set(connection.sourceComponentId, targets);
  }
  assertAcyclic(
    state.components.keys(),
    (id) => eventTargetsBySource.get(id) ?? [],
    "Event connection",
  );
}

export class ComponentIdAllocator {
  private nextSequence: number;

  constructor(nextSequence = 1) {
    if (!Number.isSafeInteger(nextSequence) || nextSequence < 1 || nextSequence > 999_999) {
      throw new RangeError(`Invalid next component sequence ${nextSequence}`);
    }
    this.nextSequence = nextSequence;
  }

  reserve(count = 1): string[] {
    if (!Number.isSafeInteger(count) || count < 0 || this.nextSequence + count - 1 > 999_999) {
      throw new RangeError("Invalid component ID reservation count");
    }
    const ids = Array.from({ length: count }, (_, index) =>
      `CMP_${String(this.nextSequence + index).padStart(6, "0")}`,
    );
    this.nextSequence += count;
    return ids;
  }

  observe(id: string): void {
    const match = /^CMP_(\d{6})$/.exec(id);
    if (!match) return;
    this.nextSequence = Math.max(this.nextSequence, Number(match[1]) + 1);
  }

  observeState(state: WorkspaceState): void {
    for (const id of state.components.keys()) this.observe(id);
  }

  snapshot(): number {
    return this.nextSequence;
  }

  advanceTo(nextSequence: number): void {
    if (!Number.isSafeInteger(nextSequence) || nextSequence < this.nextSequence || nextSequence > 999_999) {
      throw new RangeError(`Component sequence cannot move from ${this.nextSequence} to ${nextSequence}`);
    }
    this.nextSequence = nextSequence;
  }

  clone(): ComponentIdAllocator {
    return new ComponentIdAllocator(this.nextSequence);
  }
}
