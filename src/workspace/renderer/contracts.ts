import { DEFAULT_COMPONENT_VISUAL_EFFECTS } from "../components/componentTypes";
import { DEFAULT_COMPONENT_REGISTRY } from "../components/ComponentRegistry";
import type {
  BillboardPlacement,
  Canvas2DPlacement,
  ComponentResize,
  ComponentResizePolicy,
  ComponentVisualEffects,
  ComponentPlacement,
  ComponentRecipe,
  ComponentTypeRef,
  Size2,
  SurfacePlacement,
  Vec2,
  Vec3,
  ViewportPlacement,
  World3DPlacement,
  JSONObject,
} from "../components/componentTypes";
import type { TransitionSpec, WorkspaceOperation } from "../protocol/workspaceTypes";
import {
  resolveWorkspaceResourceBindings,
  type ResourceBindingDiagnostic,
} from "../data/bindingResolver";
import type { ResourceBinding, WorkspaceConnection, WorkspaceResource } from "../data/dataTypes";

/**
 * Renderer-facing workspace contracts.
 *
 * These are intentionally a structural view of Workspace Protocol 1.2 rather
 * than a second state model. `toRenderSnapshot` accepts the canonical
 * `WorkspaceState` shape (Map-backed components) and produces the small,
 * immutable view needed by the hybrid renderer.
 */

export type WorkspaceComponentId = string;

export type WorkspaceVec2 = Readonly<Vec2>;
export type WorkspaceVec3 = Readonly<Vec3>;
export type WorkspaceSize2D = Readonly<Size2>;
export type WorkspacePlacement = Readonly<ComponentPlacement>;
export type WorkspaceComponentTypeRef = Readonly<ComponentTypeRef>;
export type WorkspaceWorld3DPlacement = Readonly<World3DPlacement>;
export type WorkspaceCanvas2DPlacement = Readonly<Canvas2DPlacement>;
export type WorkspaceSurfacePlacement = Readonly<SurfacePlacement>;
export type WorkspaceBillboardPlacement = Readonly<BillboardPlacement>;
export type WorkspaceViewportPlacement = Readonly<ViewportPlacement>;
export type ViewportAnchor = ViewportPlacement["anchor"];

export type WorkspaceRenderComponent = Readonly<{
  id: WorkspaceComponentId;
  /** Distinguishes a deleted/recreated instance that deliberately reuses an ID. */
  instanceRevision?: number;
  type: WorkspaceComponentTypeRef;
  label: string;
  props: Readonly<Record<string, unknown>>;
  durableState: Readonly<Record<string, unknown>>;
  placement: WorkspacePlacement;
  parentId?: WorkspaceComponentId;
  tags: readonly string[];
  visibility: "visible" | "hidden" | "collapsed";
  visualEffects?: Readonly<ComponentVisualEffects>;
  locks: Readonly<{
    placement: boolean;
    resize?: boolean;
    visualEffects?: boolean;
    props?: boolean;
    deletion?: boolean;
    actions?: boolean;
  }>;
}>;

export type WorkspaceRenderSnapshot = Readonly<{
  workspaceId: string;
  revision: number;
  components: readonly WorkspaceRenderComponent[];
  /** Exact version/digest-pinned declarative render definitions. */
  recipes?: readonly ComponentRecipe[];
  /** Projection-only failures/warnings; never persisted as component state. */
  bindingDiagnostics?: readonly ResourceBindingDiagnostic[];
}>;

/**
 * The resolved command that produced a render snapshot. A renderer consumes
 * this metadata only when both revisions match its previous and next semantic
 * snapshots, preventing transitions from replaying on ordinary React renders.
 */
export type WorkspaceRenderCommit = Readonly<{
  baseRevision: number;
  resultingRevision: number;
  operations: readonly WorkspaceOperation[];
}>;

export type WorkspaceComponentTransitions = ReadonlyMap<WorkspaceComponentId, TransitionSpec>;

export type CameraProjectionState = Readonly<{
  position: WorkspaceVec3;
  target: WorkspaceVec3;
  fovDeg: number;
  near?: number;
  far?: number;
}>;

export type CanvasViewTransform = Readonly<{
  pan: WorkspaceVec2;
  zoom: number;
}>;

export type ProjectedComponent = Readonly<{
  componentId: WorkspaceComponentId;
  space: WorkspacePlacement["space"];
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
  visible: boolean;
  /** True when the component is represented by Three.js rather than DOM. */
  spatialOnly: boolean;
}>;

export type PlacementPreview = Readonly<{
  componentId: WorkspaceComponentId;
  placement: WorkspacePlacement;
  originalPlacement: WorkspacePlacement;
}>;

export type PlacementCommitRequest = PlacementPreview & Readonly<{
  baseRevision: number;
}>;

/** Ephemeral resize geometry. It is never authoritative until committed. */
export type ResizePreview = Readonly<{
  componentId: WorkspaceComponentId;
  resize: ComponentResize;
  originalResize: ComponentResize;
  /**
   * Box resizing can also move the component so the edge opposite the active
   * handle stays fixed. The placement is complete (including the resized
   * geometry) so a durable resize + place batch can pass the store's strict
   * geometry checks without an intermediate placement rewrite.
   */
  placement?: WorkspacePlacement;
  originalPlacement?: WorkspacePlacement;
}>;

/** One absolute, revision-bound resize request returned to the App/store. */
export type ResizeCommitRequest = ResizePreview & Readonly<{
  baseRevision: number;
}>;

export type ResizePolicyResolver = (
  component: WorkspaceRenderComponent,
) => ComponentResizePolicy | undefined;

export type ComponentActionRequest = Readonly<{
  componentId: WorkspaceComponentId;
  action: string;
  input?: JSONObject;
}>;

/** Distinct from selection: activation asks the host to run primary behavior. */
export type ComponentActivationRequest = Readonly<{
  componentId: WorkspaceComponentId;
}>;

/**
 * Renderer-owned completion signal for a durable, non-looping spatial clip.
 * The host must re-check `generation` before committing semantic completion;
 * delayed callbacks from a superseded clip are intentionally harmless.
 */
export type AnimationCompletionRequest = Readonly<{
  componentId: WorkspaceComponentId;
  clip: "idle" | "walk" | "run" | "enter" | "exit";
  generation: number;
}>;

export type HybridRendererStatus =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "projection-warning"; componentId: string; message: string }>
  | Readonly<{ kind: "three-error"; message: string }>
  | Readonly<{ kind: "overlay-error"; message: string }>;

export type WorkspaceStateLike = Readonly<{
  workspaceId: string;
  revision: number;
  components:
    | ReadonlyMap<string, unknown>
    | readonly unknown[]
    | Readonly<Record<string, unknown>>;
  recipes?:
    | ReadonlyMap<string, unknown>
    | readonly unknown[]
    | Readonly<Record<string, unknown>>;
  resources?:
    | ReadonlyMap<string, unknown>
    | readonly unknown[]
    | Readonly<Record<string, unknown>>;
  connections?:
    | ReadonlyMap<string, unknown>
    | readonly unknown[]
    | Readonly<Record<string, unknown>>;
}>;

const DEFAULT_PLACEMENT: WorkspaceViewportPlacement = {
  space: "viewport",
  anchor: "center",
  offset: { x: 0, y: 0 },
};

/**
 * Convert canonical Map-backed workspace state into a renderer snapshot.
 * Invalid individual records are skipped so one damaged projection cannot
 * prevent the semantic workspace from opening.
 */
export function toRenderSnapshot(input: WorkspaceRenderSnapshot | WorkspaceStateLike): WorkspaceRenderSnapshot {
  const containsCanonicalBindings = ("resources" in input && input.resources !== undefined)
    || ("connections" in input && input.connections !== undefined);
  if (!containsCanonicalBindings && Array.isArray(input.components) && input.components.every(isRenderComponent)) {
    return input as WorkspaceRenderSnapshot;
  }

  const recipes = "recipes" in input && input.recipes
    ? componentRecords(input.recipes).flatMap(([, recipe]) => isComponentRecipe(recipe) ? [recipe] : [])
    : [];
  const records = componentRecords(input.components);
  let components: WorkspaceRenderComponent[] = [];
  for (const [fallbackId, value] of records) {
    const normalized = normalizeComponent(value, fallbackId);
    if (normalized) components.push(normalized);
  }
  components.sort((left, right) => left.id.localeCompare(right.id));

  let bindingDiagnostics: readonly ResourceBindingDiagnostic[] = [];
  if ("connections" in input && input.connections) {
    const resources = new Map<string, WorkspaceResource>();
    if ("resources" in input && input.resources) {
      for (const [, candidate] of componentRecords(input.resources)) {
        if (isWorkspaceResource(candidate)) resources.set(candidate.id, candidate);
      }
    }
    const connections = new Map<string, WorkspaceConnection>();
    for (const [, candidate] of componentRecords(input.connections)) {
      if (isResourceBinding(candidate)) connections.set(candidate.id, candidate);
    }
    const resolution = resolveWorkspaceResourceBindings({
      components: components.map((component) => {
        const contract = bindingContract(component, recipes);
        return {
          id: component.id,
          props: structuredClone(component.props) as JSONObject,
          ...(contract ? {
            propsSchema: contract.propsSchema,
            writableProps: contract.writableProps,
          } : {}),
        };
      }),
      resources,
      connections,
    });
    components = components.map((component) => ({
      ...component,
      props: resolution.effectiveProps.get(component.id) ?? component.props,
    }));
    bindingDiagnostics = resolution.diagnostics;
  }
  return {
    workspaceId: input.workspaceId,
    revision: input.revision,
    components,
    ...(recipes.length ? { recipes } : {}),
    ...(bindingDiagnostics.length ? { bindingDiagnostics } : {}),
  };
}

function bindingContract(
  component: WorkspaceRenderComponent,
  recipes: readonly ComponentRecipe[],
): Readonly<{ propsSchema: ComponentRecipe["propsSchema"]; writableProps: readonly string[] }> | undefined {
  const recipe = recipeForComponent(component, recipes);
  if (recipe) return { propsSchema: recipe.propsSchema, writableProps: recipe.writableProps };
  const manifest = DEFAULT_COMPONENT_REGISTRY.get(component.type.typeId, component.type.version);
  if (!manifest || manifest.digest !== component.type.digest) return undefined;
  return { propsSchema: manifest.propsSchema, writableProps: manifest.writableProps };
}

export function recipeForComponent(
  component: WorkspaceRenderComponent,
  recipes: readonly ComponentRecipe[] = [],
): ComponentRecipe | undefined {
  return recipes.find((recipe) => recipe.typeId === component.type.typeId
    && recipe.version === component.type.version
    && recipe.digest === component.type.digest);
}

export function componentTypeName(component: Pick<WorkspaceRenderComponent, "type">): string {
  const value = component.type.typeId.toLowerCase();
  const segment = value.split(/[/:.]/u).filter(Boolean).at(-1) ?? value;
  return segment.replace(/^workspace-/u, "");
}

export function isSpatialComponent(component: WorkspaceRenderComponent): boolean {
  const typeId = component.type.typeId;
  return typeId === "spatial-entity"
    || typeId === "spatial-primitive"
    || typeId === "model-assembly"
    || typeId === "stage-3d";
}

export function clonePlacement<T extends WorkspacePlacement>(placement: T): T {
  return structuredClone(placement);
}

function componentRecords(
  value: WorkspaceStateLike["components"] | NonNullable<WorkspaceStateLike["recipes" | "resources" | "connections"]>,
): Array<readonly [string, unknown]> {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) {
    return value.map((entry, index) => [recordString(entry, "id") ?? `component_${index}`, entry] as const);
  }
  return Object.entries(value);
}

function isWorkspaceResource(value: unknown): value is WorkspaceResource {
  if (!isRecord(value) || !isRecord(value.outputSchema) || !isRecord(value.config) || !isRecord(value.policy)) {
    return false;
  }
  if (!(typeof value.id === "string"
    && typeof value.label === "string"
    && typeof value.connectorType === "string"
    && typeof value.connectorVersion === "string"
    && ["unconfigured", "ready", "stale", "error"].includes(String(value.status)))) return false;
  if (value.snapshot === undefined) return true;
  return isRecord(value.snapshot)
    && "data" in value.snapshot
    && typeof value.snapshot.contentHash === "string"
    && typeof value.snapshot.retrievedAt === "string"
    && typeof value.snapshot.stale === "boolean"
    && Array.isArray(value.snapshot.provenance);
}

function isResourceBinding(value: unknown): value is ResourceBinding {
  if (!isRecord(value) || value.kind !== "resource_binding" || !isRecord(value.transform)) return false;
  const transformValid = value.transform.kind === "identity"
    || (value.transform.kind === "pick" && typeof value.transform.path === "string")
    || value.transform.kind === "format_number"
    || (value.transform.kind === "template" && typeof value.transform.template === "string");
  return transformValid
    && typeof value.id === "string"
    && typeof value.resourceId === "string"
    && typeof value.componentId === "string"
    && typeof value.targetProp === "string"
    && (value.mode === "snapshot" || value.mode === "live")
    && typeof value.enabled === "boolean";
}

function normalizeComponent(value: unknown, fallbackId: string): WorkspaceRenderComponent | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id) ?? fallbackId;
  const rawType = value.type;
  const type = isRecord(rawType)
    ? {
        typeId: stringValue(rawType.typeId) ?? stringValue(rawType.id) ?? "builtin.unknown",
        version: stringValue(rawType.version) ?? "0.0.0",
        digest: stringValue(rawType.digest) ?? "unknown",
      }
    : {
        typeId: stringValue(rawType) ?? stringValue(value.typeId) ?? "builtin.unknown",
        version: "0.0.0",
        digest: "unknown",
      };
  const placement = isPlacement(value.placement) ? value.placement : DEFAULT_PLACEMENT;
  const locks = isRecord(value.locks) ? value.locks : {};
  const visibility = value.visibility === "hidden" || value.visibility === "collapsed"
    ? value.visibility
    : "visible";
  const provenance = isRecord(value.provenance) ? value.provenance : undefined;
  const instanceRevision = typeof provenance?.createdRevision === "number"
    && Number.isSafeInteger(provenance.createdRevision)
    && provenance.createdRevision >= 0
    ? provenance.createdRevision
    : undefined;
  return {
    id,
    ...(instanceRevision !== undefined ? { instanceRevision } : {}),
    type,
    label: stringValue(value.label) ?? id,
    props: isRecord(value.props) ? value.props : {},
    durableState: isRecord(value.durableState) ? value.durableState : {},
    placement,
    ...(stringValue(value.parentId) ? { parentId: stringValue(value.parentId) } : {}),
    tags: Array.isArray(value.tags) ? value.tags.filter((entry): entry is string => typeof entry === "string") : [],
    visibility,
    visualEffects: isVisualEffects(value.visualEffects)
      ? structuredClone(value.visualEffects)
      : structuredClone(DEFAULT_COMPONENT_VISUAL_EFFECTS),
    locks: {
      placement: locks.placement === true,
      resize: locks.resize === true,
      visualEffects: locks.visualEffects === true,
      props: locks.props === true,
      deletion: locks.deletion === true,
      actions: locks.actions === true,
    },
  };
}

function isVisualEffects(value: unknown): value is ComponentVisualEffects {
  if (!isRecord(value) || !isRecord(value.emissive) || !isRecord(value.glow)) return false;
  return typeof value.opacity === "number"
    && typeof value.emissive.color === "string"
    && typeof value.emissive.intensity === "number"
    && typeof value.glow.color === "string"
    && typeof value.glow.intensity === "number"
    && typeof value.glow.spread === "number";
}

function isRenderComponent(value: unknown): value is WorkspaceRenderComponent {
  return isRecord(value)
    && typeof value.id === "string"
    && isRecord(value.type)
    && typeof value.type.typeId === "string"
    && isVisualEffects(value.visualEffects)
    && isPlacement(value.placement);
}

function isComponentRecipe(value: unknown): value is ComponentRecipe {
  return isRecord(value)
    && typeof value.typeId === "string"
    && typeof value.version === "string"
    && typeof value.digest === "string"
    && typeof value.displayName === "string"
    && isRecord(value.root)
    && typeof value.root.id === "string"
    && typeof value.root.primitive === "string"
    && isRecord(value.actions);
}

function isPlacement(value: unknown): value is WorkspacePlacement {
  if (!isRecord(value) || typeof value.space !== "string") return false;
  return ["world3d", "canvas2d", "surface", "billboard", "viewport"].includes(value.space);
}

function recordString(value: unknown, key: string): string | undefined {
  return isRecord(value) ? stringValue(value[key]) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
