import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  DEFAULT_COMPONENT_LOCKS,
  DEFAULT_COMPONENT_VISUAL_EFFECTS,
  resizePolicyForPlacement,
  type ComponentInstance,
  type ComponentLocks,
  type ComponentManifest,
  type ComponentPlacement,
  type ComponentRecipe,
  type ComponentTypeRef,
} from "../components/componentTypes";
import { ComponentRegistry, DEFAULT_COMPONENT_REGISTRY } from "../components/ComponentRegistry";
import { deterministicDigest, stableStringify } from "../components/manifestDigest";
import type { ResourceBinding, WorkspaceConnection, WorkspaceResource } from "../data/dataTypes";
import {
  parseRealityAssetDescriptor,
  type RealityAssetDescriptor,
} from "../assets";
import {
  assertWorkspaceResourceSafe,
  WorkspaceResourceValidationError,
} from "../data/resourceSecurity";
import {
  LEGACY_WORKSPACE_PROTOCOL_VERSION,
  LEGACY_WORKSPACE_SCHEMA_VERSION,
  PREVIOUS_WORKSPACE_PROTOCOL_VERSION,
  PREVIOUS_WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_PROTOCOL_VERSION,
  WORKSPACE_SCHEMA_VERSION,
  type SharedView,
  type WorkspaceAppliedBatchSummary,
  type WorkspaceCommandBatch,
  type WorkspaceCommandRecord,
  type WorkspaceOperation,
  type WorkspaceProtocolVersion,
  type WorkspaceSchemaVersion,
} from "../protocol/workspaceTypes";
import workspaceProtocolSchema from "../protocol/workspaceProtocol.schema.json";
import { prepareComponentRecipe } from "../protocol/validateWorkspaceBatch";
import {
  assertModelDefinition,
  modelDefinitionKey,
  type ModelDefinition,
} from "../modeling/modelDefinitions";
import {
  migrateWorkspaceStateToCurrent,
  WorkspaceStore,
} from "../state/WorkspaceStore";
import type { WorkspaceState } from "../state/workspaceState";
import { semanticWorkspaceEqual } from "../state/workspaceUtils";
import { MAX_WORKSPACE_PROJECT_BYTES } from "../state/workspaceLimits";
import workspaceProjectSchema from "./workspaceProject.schema.json";

export const WORKSPACE_PROJECT_FORMAT_VERSION = "1.0" as const;

function projectByteLength(serialized: string): number {
  return new TextEncoder().encode(serialized).byteLength;
}

function assertProjectByteLength(serialized: string): void {
  if (projectByteLength(serialized) > MAX_WORKSPACE_PROJECT_BYTES) {
    throw new WorkspaceProjectError(
      `Workspace project exceeds the ${MAX_WORKSPACE_PROJECT_BYTES} byte limit`,
      "project_too_large",
    );
  }
}

export type SerializableWorkspaceState = {
  workspaceId: string;
  revision: number;
  protocolVersion: WorkspaceProtocolVersion;
  workspaceSchemaVersion: WorkspaceSchemaVersion;
  registryDigest: string;
  components: Array<[string, ComponentInstance]>;
  resources: Array<[string, WorkspaceResource]>;
  /** Added in Workspace 1.3. Missing means an older project with no Reality Assets. */
  realityAssets?: Array<[string, RealityAssetDescriptor]>;
  connections: Array<[string, WorkspaceConnection]>;
  aliases: Array<[string, string]>;
  sharedViews: Array<[string, SharedView]>;
  recipes: Array<[string, ComponentRecipe]>;
  /** Added in the modeling extension. Missing means an older project with no models. */
  modelDefinitions?: Array<[string, ModelDefinition]>;
  history: WorkspaceAppliedBatchSummary[];
};

export type WorkspaceProjectFile = {
  formatVersion: typeof WORKSPACE_PROJECT_FORMAT_VERSION;
  protocolVersion: typeof WORKSPACE_PROTOCOL_VERSION;
  workspaceSchemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  registryDigest: string;
  checkpointNextComponentSequence: number;
  nextComponentSequence: number;
  checkpointNextEventCursor: number;
  nextEventCursor: number;
  checkpoint: SerializableWorkspaceState;
  workspace: SerializableWorkspaceState;
  commandHistory: WorkspaceCommandRecord[];
};

export type WorkspaceProjectInput = {
  projectId: string;
  workspace: WorkspaceState;
  checkpoint?: WorkspaceState;
  checkpointNextComponentSequence?: number;
  nextComponentSequence: number;
  checkpointNextEventCursor?: number;
  nextEventCursor: number;
  commandHistory?: WorkspaceCommandRecord[];
  createdAt?: string;
  updatedAt?: string;
};

export class WorkspaceProjectError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WorkspaceProjectError";
  }
}

export class WorkspaceMigrationRequiredError extends WorkspaceProjectError {
  constructor(message: string) {
    super(message, "migration_required");
    this.name = "WorkspaceMigrationRequiredError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictNumbers: true });
addFormats(ajv);
ajv.addSchema(workspaceProtocolSchema);
const projectValidator: ValidateFunction<WorkspaceProjectFile> =
  ajv.compile<WorkspaceProjectFile>(workspaceProjectSchema);

function errorText(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).slice(0, 16)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
    .join("; ");
}

function stableEntries<T>(map: ReadonlyMap<string, T>): Array<[string, T]> {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, structuredClone(value)]);
}

export function workspaceToSerializable(state: WorkspaceState): SerializableWorkspaceState {
  return {
    workspaceId: state.workspaceId,
    revision: state.revision,
    protocolVersion: state.protocolVersion,
    workspaceSchemaVersion: state.workspaceSchemaVersion,
    registryDigest: state.registryDigest,
    components: stableEntries(state.components),
    resources: stableEntries(state.resources),
    realityAssets: stableEntries(state.realityAssets),
    connections: stableEntries(state.connections),
    aliases: stableEntries(state.aliases),
    sharedViews: stableEntries(state.sharedViews),
    recipes: stableEntries(state.recipes),
    modelDefinitions: stableEntries(state.modelDefinitions),
    history: structuredClone(state.history),
  };
}

function entriesToMap<T extends { id?: string }>(
  name: string,
  entries: Array<[string, T]>,
  requireMatchingId: boolean,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const [key, value] of entries) {
    if (map.has(key)) throw new WorkspaceProjectError(`Duplicate ${name} key ${key}`, "invalid_project");
    if (requireMatchingId && value.id !== key) {
      throw new WorkspaceProjectError(`${name} key ${key} does not match payload ${String(value.id)}`, "invalid_project");
    }
    map.set(key, structuredClone(value));
  }
  return map;
}

export function workspaceFromSerializable(state: SerializableWorkspaceState): WorkspaceState {
  const aliases = new Map<string, string>();
  for (const [alias, id] of state.aliases) {
    if (aliases.has(alias)) throw new WorkspaceProjectError(`Duplicate alias ${alias}`, "invalid_project");
    aliases.set(alias, id);
  }
  const recipes = new Map<string, ComponentRecipe>();
  for (const [key, recipe] of state.recipes) {
    if (recipes.has(key)) throw new WorkspaceProjectError(`Duplicate recipe ${key}`, "invalid_project");
    if (key !== `${recipe.typeId}@${recipe.version}`) throw new WorkspaceProjectError(`Recipe key ${key} does not match payload`, "invalid_project");
    recipes.set(key, structuredClone(recipe));
  }
  const modelDefinitions = new Map<string, ModelDefinition>();
  for (const [key, definition] of state.modelDefinitions ?? []) {
    if (modelDefinitions.has(key)) {
      throw new WorkspaceProjectError(`Duplicate model definition ${key}`, "invalid_project");
    }
    if (key !== modelDefinitionKey(definition)) {
      throw new WorkspaceProjectError(`Model definition key ${key} does not match payload`, "invalid_project");
    }
    try {
      assertModelDefinition(definition);
    } catch (error) {
      throw new WorkspaceProjectError(
        `Invalid model definition ${key}: ${error instanceof Error ? error.message : String(error)}`,
        "invalid_project",
      );
    }
    modelDefinitions.set(key, structuredClone(definition));
  }
  const realityAssets = new Map<string, RealityAssetDescriptor>();
  for (const [key, descriptorValue] of state.realityAssets ?? []) {
    if (realityAssets.has(key)) {
      throw new WorkspaceProjectError(`Duplicate Reality Asset ${key}`, "invalid_project");
    }
    let descriptor: RealityAssetDescriptor;
    try {
      descriptor = parseRealityAssetDescriptor(descriptorValue);
    } catch (error) {
      throw new WorkspaceProjectError(
        `Invalid Reality Asset ${key}: ${error instanceof Error ? error.message : String(error)}`,
        "invalid_project",
      );
    }
    if (key !== descriptor.assetId) {
      throw new WorkspaceProjectError(
        `Reality Asset key ${key} does not match ${descriptor.assetId}`,
        "invalid_project",
      );
    }
    realityAssets.set(key, structuredClone(descriptor));
  }
  return {
    workspaceId: state.workspaceId,
    revision: state.revision,
    protocolVersion: state.protocolVersion,
    workspaceSchemaVersion: state.workspaceSchemaVersion,
    registryDigest: state.registryDigest,
    components: entriesToMap("component", state.components, true),
    resources: entriesToMap("resource", state.resources, true),
    realityAssets,
    connections: entriesToMap("connection", state.connections, true),
    aliases,
    sharedViews: entriesToMap("view", state.sharedViews, true),
    recipes,
    modelDefinitions,
    history: structuredClone(state.history),
  };
}

export function workspaceStateDigest(state: WorkspaceState): string {
  return deterministicDigest(workspaceToSerializable(state));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertProjectEnvelope(value: unknown): asserts value is WorkspaceProjectFile {
  if (!isObject(value)) throw new WorkspaceProjectError("Workspace project root must be an object", "invalid_project");
  for (const key of ["formatVersion", "protocolVersion", "workspaceSchemaVersion", "projectId", "createdAt", "updatedAt", "registryDigest"]) {
    if (typeof value[key] !== "string" || value[key] === "") {
      throw new WorkspaceProjectError(`Workspace project field ${key} must be a non-empty string`, "invalid_project");
    }
  }
}

function componentTypeKey(ref: Pick<ComponentTypeRef, "typeId" | "version">): string {
  return `${ref.typeId}@${ref.version}`;
}

function legacyStageDimensions(value: unknown): { width: number; height: number; depth: number } | undefined {
  if (!isObject(value)) return undefined;
  const { width, height, depth } = value;
  if (
    typeof width !== "number" || !Number.isFinite(width) || width <= 0
    || typeof height !== "number" || !Number.isFinite(height) || height <= 0
    || typeof depth !== "number" || !Number.isFinite(depth) || depth <= 0
  ) return undefined;
  return { width, height, depth };
}

function bindingPathSegments(path: string): Array<string | number> | undefined {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "$") return [];
  if (trimmed.startsWith("/")) {
    return trimmed.slice(1).split("/").map((segment) =>
      segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  let remaining = trimmed.startsWith("$") ? trimmed.slice(1) : `.${trimmed}`;
  const segments: Array<string | number> = [];
  while (remaining) {
    const property = /^\.([A-Za-z0-9_-]+)/.exec(remaining);
    if (property) {
      segments.push(property[1]!);
      remaining = remaining.slice(property[0].length);
      continue;
    }
    const index = /^\[(\d+)\]/.exec(remaining);
    if (index) {
      segments.push(Number(index[1]));
      remaining = remaining.slice(index[0].length);
      continue;
    }
    const quoted = /^\["((?:\\.|[^"\\])*)"\]/.exec(remaining);
    if (quoted) {
      try {
        segments.push(JSON.parse(`"${quoted[1]}"`) as string);
      } catch {
        return undefined;
      }
      remaining = remaining.slice(quoted[0].length);
      continue;
    }
    return undefined;
  }
  return segments;
}

function valueAtBindingPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  const segments = bindingPathSegments(path);
  if (!segments) return undefined;
  let current = value;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return undefined;
      current = current[segment];
    } else {
      if (!isObject(current) || !(segment in current)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

function resolveLegacyStageBindingDimensions(
  resource: WorkspaceResource | undefined,
  binding: ResourceBinding,
  current: { width: number; height: number; depth: number },
): { width: number; height: number; depth: number } {
  if (!binding.enabled || !resource?.snapshot) return structuredClone(current);
  if (binding.mode === "live") {
    throw new WorkspaceMigrationRequiredError(
      `Legacy live Stage dimensions binding ${binding.id} cannot be made replay-stable; freeze it to snapshot mode first`,
    );
  }
  let value = valueAtBindingPath(resource.snapshot.data, binding.sourcePath);
  if (binding.transform.kind === "pick") {
    value = valueAtBindingPath(value, binding.transform.path);
  } else if (binding.transform.kind !== "identity") {
    throw new WorkspaceMigrationRequiredError(
      `Legacy Stage dimensions binding ${binding.id} uses non-geometric transform ${binding.transform.kind}`,
    );
  }
  const dimensions = legacyStageDimensions(value);
  if (!dimensions) {
    throw new WorkspaceMigrationRequiredError(
      `Legacy Stage dimensions binding ${binding.id} snapshot does not resolve to width, height, and depth`,
    );
  }
  return dimensions;
}

function canonicalLegacyPlacement(
  manifest: ComponentManifest,
  placement: ComponentPlacement,
): ComponentPlacement {
  const canonical = structuredClone(placement);
  const policy = resizePolicyForPlacement(manifest, canonical);
  if (policy.kind === "box2d") {
    const size = canonical.size ?? policy.defaultSize;
    canonical.size = {
      width: Math.min(policy.maxSize.width, Math.max(policy.minSize.width, size.width)),
      height: Math.min(policy.maxSize.height, Math.max(policy.minSize.height, size.height)),
    };
  }
  if (canonical.space !== "world3d") return canonical;
  if (policy.kind === "scale3d") {
    canonical.scale = {
      x: Math.min(policy.maxScale.x, Math.max(policy.minScale.x, canonical.scale.x)),
      y: Math.min(policy.maxScale.y, Math.max(policy.minScale.y, canonical.scale.y)),
      z: Math.min(policy.maxScale.z, Math.max(policy.minScale.z, canonical.scale.z)),
    };
    delete canonical.size;
  } else {
    canonical.scale = { x: 1, y: 1, z: 1 };
    if (policy.kind === "stage_dimensions") delete canonical.size;
  }
  return canonical;
}

function sameSize(
  left: { width: number; height: number } | undefined,
  right: { width: number; height: number } | undefined,
): boolean {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function sameScale(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): boolean {
  return stableStringify(left) === stableStringify(right);
}

export class WorkspaceProjectSerializer {
  constructor(private readonly registry: ComponentRegistry = DEFAULT_COMPONENT_REGISTRY) {}

  create(input: WorkspaceProjectInput): WorkspaceProjectFile {
    const now = new Date().toISOString();
    const checkpoint = input.checkpoint ?? input.workspace;
    const commands = input.checkpoint ? structuredClone(input.commandHistory ?? []) : [];
    const project: WorkspaceProjectFile = {
      formatVersion: WORKSPACE_PROJECT_FORMAT_VERSION,
      protocolVersion: WORKSPACE_PROTOCOL_VERSION,
      workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
      projectId: input.projectId,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      registryDigest: input.workspace.registryDigest,
      checkpointNextComponentSequence: input.checkpointNextComponentSequence ?? input.nextComponentSequence,
      nextComponentSequence: input.nextComponentSequence,
      checkpointNextEventCursor: input.checkpointNextEventCursor ?? input.nextEventCursor,
      nextEventCursor: input.nextEventCursor,
      checkpoint: workspaceToSerializable(checkpoint),
      workspace: workspaceToSerializable(input.workspace),
      commandHistory: commands,
    };
    this.validate(project);
    assertProjectByteLength(JSON.stringify(project));
    return project;
  }

  fromStore(
    projectId: string,
    store: WorkspaceStore,
    metadata: Pick<WorkspaceProjectInput, "createdAt" | "updatedAt"> = {},
  ): WorkspaceProjectFile {
    return this.create({
      projectId,
      workspace: store.getState() as WorkspaceState,
      checkpoint: store.getCheckpointState() as WorkspaceState,
      checkpointNextComponentSequence: store.getCheckpointNextComponentSequence(),
      nextComponentSequence: store.getAllocatorSnapshot(),
      checkpointNextEventCursor: store.getCheckpointNextEventCursor(),
      nextEventCursor: store.getNextEventCursor(),
      commandHistory: store.getCommandHistory(),
      ...metadata,
    });
  }

  serialize(input: WorkspaceProjectFile | WorkspaceProjectInput): string {
    const project = "formatVersion" in input ? structuredClone(input) : this.create(input);
    this.validate(project);
    const serialized = JSON.stringify(project, null, 2);
    assertProjectByteLength(serialized);
    return serialized;
  }

  deserialize(serialized: string | unknown): WorkspaceProjectFile {
    if (typeof serialized === "string") assertProjectByteLength(serialized);
    let value: unknown;
    try {
      value = typeof serialized === "string" ? JSON.parse(serialized) : structuredClone(serialized);
    } catch (error) {
      throw new WorkspaceProjectError(
        `Workspace project JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        "invalid_json",
      );
    }
    assertProjectEnvelope(value);
    const validatedInput = this.isLegacyProject(value)
      ? this.canonicalizeLegacyProjectRecipes(value)
      : value;
    this.validate(validatedInput, true);
    const project = this.isLegacyProject(validatedInput)
      ? this.migrateLegacyProject(validatedInput)
      : this.isPreviousProject(validatedInput)
        ? this.migratePreviousProject(validatedInput)
        : this.materializeCurrentSnapshotGeometry(validatedInput);
    this.validate(project);
    return structuredClone(project);
  }

  private materializeCurrentSnapshotGeometry(project: WorkspaceProjectFile): WorkspaceProjectFile {
    const normalized = structuredClone(project);
    // Early 1.1 files could contain fixed declarative instances without an
    // authored placement.size while projection supplied an implicit 240x144
    // box. Materialize current snapshot/checkpoint geometry on open so saved
    // state and deterministic command replay converge without a format bump.
    const checkpoint = migrateWorkspaceStateToCurrent(
      workspaceFromSerializable(normalized.checkpoint),
      this.registry,
    );
    const workspace = migrateWorkspaceStateToCurrent(
      workspaceFromSerializable(normalized.workspace),
      this.registry,
    );
    // Protocol 1.2 projects have the same command semantics as 1.3, with an
    // empty Reality Asset catalog supplied by state migration. Promote the
    // envelope after both snapshots are normalized so save/reopen converges on
    // one current version instead of retaining mixed outer/inner versions.
    normalized.protocolVersion = WORKSPACE_PROTOCOL_VERSION;
    normalized.workspaceSchemaVersion = WORKSPACE_SCHEMA_VERSION;
    normalized.checkpoint = workspaceToSerializable(checkpoint);
    normalized.workspace = workspaceToSerializable(workspace);
    normalized.registryDigest = workspace.registryDigest;
    if (
      checkpoint.registryDigest !== project.checkpoint.registryDigest
      || workspace.registryDigest !== project.workspace.registryDigest
    ) {
      return this.rebaseCurrentRegistryHistory(normalized, checkpoint, workspace);
    }
    return normalized;
  }

  /**
   * Rebuild only registry-derived history metadata when the built-in registry
   * grows without a protocol/schema bump. Resolved operations and effects stay
   * authoritative; replay lets recipe definitions and clear_workspace derive
   * their own effective digest at the exact revision where they occurred.
   */
  private rebaseCurrentRegistryHistory(
    project: WorkspaceProjectFile,
    migratedCheckpoint: WorkspaceState,
    migratedWorkspace: WorkspaceState,
  ): WorkspaceProjectFile {
    const checkpoint = structuredClone(migratedCheckpoint);
    // Compacted commands are no longer present, so their individual registry
    // transitions cannot be replayed. Their summaries describe the checkpoint
    // baseline now governed by this exact current effective registry.
    checkpoint.history = checkpoint.history.map((summary) => ({
      ...structuredClone(summary),
      resultingRegistryDigest: checkpoint.registryDigest,
    }));
    const store = new WorkspaceStore({
      initialState: checkpoint,
      checkpointState: checkpoint,
      registry: this.registry,
      nextComponentSequence: project.checkpointNextComponentSequence,
      checkpointNextComponentSequence: project.checkpointNextComponentSequence,
      nextEventCursor: project.checkpointNextEventCursor,
      checkpointNextEventCursor: project.checkpointNextEventCursor,
    });

    try {
      for (const command of project.commandHistory) {
        const firstResolvedCursor = command.resolvedEvents[0]?.cursor;
        if (firstResolvedCursor !== undefined) {
          const currentCursor = store.getNextEventCursor();
          if (firstResolvedCursor < currentCursor) {
            throw new WorkspaceMigrationRequiredError(
              `Registry migration event cursor moved backward at ${command.requestId}`,
            );
          }
          if (firstResolvedCursor > currentCursor) {
            store.restoreMonotonicCounters(store.getAllocatorSnapshot(), firstResolvedCursor);
          }
        }
        const batch: WorkspaceCommandBatch = {
          protocol_version: WORKSPACE_PROTOCOL_VERSION,
          request_id: command.requestId,
          workspace_id: checkpoint.workspaceId,
          input_revision: command.inputRevision,
          base_workspace_revision: command.baseWorkspaceRevision,
          registry_digest: store.getRegistryDigest(),
          mode: "commit",
          operations: structuredClone(command.resolvedOperations),
        };
        const result = store.applyResolvedHistoryDetailed(
          batch,
          { actor: command.actor, permissions: ["*"] },
          command.resolvedActionEffects,
        );
        const expectedCommand: WorkspaceCommandRecord = {
          ...structuredClone(command),
          inputRegistryDigest: result.command.inputRegistryDigest,
          resultingRegistryDigest: result.command.resultingRegistryDigest,
        };
        if (!semanticWorkspaceEqual(result.command, expectedCommand)) {
          throw new WorkspaceMigrationRequiredError(
            `Registry migration changed resolved command ${command.requestId}`,
          );
        }
      }
      store.restoreMonotonicCounters(project.nextComponentSequence, project.nextEventCursor);
    } catch (error) {
      if (error instanceof WorkspaceMigrationRequiredError) throw error;
      throw new WorkspaceMigrationRequiredError(
        `Workspace registry history could not be migrated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const replayed = store.getState() as WorkspaceState;
    const expected = structuredClone(migratedWorkspace);
    // The old project was fully validated before this pass. Only registry and
    // history metadata may differ from its migrated final snapshot.
    expected.registryDigest = replayed.registryDigest;
    expected.history = structuredClone(replayed.history);
    if (!semanticWorkspaceEqual(replayed, expected)) {
      throw new WorkspaceMigrationRequiredError(
        "Workspace registry history does not reproduce its migrated saved state",
      );
    }

    return {
      ...structuredClone(project),
      registryDigest: replayed.registryDigest,
      checkpoint: workspaceToSerializable(checkpoint),
      workspace: workspaceToSerializable(replayed),
      commandHistory: store.getCommandHistory(),
    };
  }

  /** Upgrade a valid 1.1 project by materializing neutral universal effects. */
  private migratePreviousProject(project: WorkspaceProjectFile): WorkspaceProjectFile {
    const normalized = structuredClone(project);
    const checkpoint = migrateWorkspaceStateToCurrent(
      workspaceFromSerializable(normalized.checkpoint),
      this.registry,
    );
    const workspace = migrateWorkspaceStateToCurrent(
      workspaceFromSerializable(normalized.workspace),
      this.registry,
    );
    for (const command of normalized.commandHistory) {
      for (const operation of command.resolvedOperations) {
        if (operation.op !== "create_component") continue;
        operation.visual_effects = structuredClone(
          operation.visual_effects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS,
        );
        operation.locks = {
          ...DEFAULT_COMPONENT_LOCKS,
          ...structuredClone(operation.locks ?? {}),
        };
      }
    }
    const migrated: WorkspaceProjectFile = {
      ...normalized,
      protocolVersion: WORKSPACE_PROTOCOL_VERSION,
      workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
      registryDigest: workspace.registryDigest,
      checkpoint: workspaceToSerializable(checkpoint),
      workspace: workspaceToSerializable(workspace),
      commandHistory: normalized.commandHistory,
    };
    return checkpoint.registryDigest !== project.checkpoint.registryDigest
      || workspace.registryDigest !== project.workspace.registryDigest
      ? this.rebaseCurrentRegistryHistory(migrated, checkpoint, workspace)
      : migrated;
  }

  private canonicalizeLegacyProjectRecipes(project: WorkspaceProjectFile): WorkspaceProjectFile {
    const normalized = structuredClone(project);
    const canonicalize = (recipe: ComponentRecipe): ComponentRecipe => {
      if (recipe.resizePolicy !== undefined) return structuredClone(recipe);
      const { digest, ...legacyContent } = recipe;
      const legacyDigest = deterministicDigest(legacyContent);
      const canonical = prepareComponentRecipe(legacyContent);
      if (digest !== legacyDigest) {
        throw new WorkspaceMigrationRequiredError(
          `Legacy recipe ${recipe.typeId}@${recipe.version} has an invalid pre-resize digest`,
        );
      }
      return canonical;
    };
    type ActiveRecipe = { oldDigest: string; newRef: ComponentTypeRef };
    const identity = (value: Pick<ComponentTypeRef, "typeId" | "version">): string =>
      `${value.typeId}@${value.version}`;
    const rewriteRef = (
      ref: ComponentTypeRef,
      definitions: ReadonlyMap<string, ActiveRecipe>,
    ): ComponentTypeRef => {
      const definition = definitions.get(identity(ref));
      return definition?.oldDigest === ref.digest
        ? structuredClone(definition.newRef)
        : structuredClone(ref);
    };
    const rewriteSnapshot = (snapshot: SerializableWorkspaceState): Map<string, ActiveRecipe> => {
      const definitions = new Map<string, ActiveRecipe>();
      snapshot.recipes = snapshot.recipes.map(([key, recipe]) => {
        const oldDigest = recipe.digest;
        const canonical = canonicalize(recipe);
        definitions.set(identity(recipe), {
          oldDigest,
          newRef: {
            typeId: canonical.typeId,
            version: canonical.version,
            digest: canonical.digest,
          },
        });
        return [key, canonical];
      });
      for (const [, component] of snapshot.components) {
        component.type = rewriteRef(component.type, definitions);
      }
      return definitions;
    };

    // Snapshot references are resolved against definitions co-resident in that
    // snapshot. History is rewritten sequentially from the checkpoint so a
    // clear_workspace can legally retire one colliding digest before the same
    // type/version (or even the same old hash) is defined with new content.
    const activeRecipes = rewriteSnapshot(normalized.checkpoint);
    rewriteSnapshot(normalized.workspace);
    for (const command of normalized.commandHistory) {
      for (const operation of command.resolvedOperations) {
        if (operation.op === "define_component_recipe") {
          const oldDigest = operation.recipe.digest;
          operation.recipe = canonicalize(operation.recipe);
          activeRecipes.set(identity(operation.recipe), {
            oldDigest,
            newRef: {
              typeId: operation.recipe.typeId,
              version: operation.recipe.version,
              digest: operation.recipe.digest,
            },
          });
        } else if (operation.op === "create_component") {
          operation.component_type = rewriteRef(operation.component_type, activeRecipes);
        } else if (operation.op === "clear_workspace") {
          activeRecipes.clear();
        }
      }
    }
    return normalized;
  }

  openStore(project: WorkspaceProjectFile): WorkspaceStore {
    return this.replay(project, true);
  }

  replay(project: WorkspaceProjectFile, verifySavedState = true): WorkspaceStore {
    this.validate(project);
    const checkpoint = workspaceFromSerializable(project.checkpoint);
    const store = new WorkspaceStore({
      initialState: checkpoint,
      checkpointState: checkpoint,
      registry: this.registry,
      nextComponentSequence: project.checkpointNextComponentSequence,
      checkpointNextComponentSequence: project.checkpointNextComponentSequence,
      nextEventCursor: project.checkpointNextEventCursor,
      checkpointNextEventCursor: project.checkpointNextEventCursor,
    });
    for (const command of project.commandHistory) {
      const firstResolvedCursor = command.resolvedEvents[0]?.cursor;
      if (firstResolvedCursor !== undefined) {
        const currentCursor = store.getNextEventCursor();
        if (firstResolvedCursor < currentCursor) {
          throw new WorkspaceProjectError(
            `Event cursor moved backward at ${command.requestId}`,
            "replay_mismatch",
          );
        }
        if (firstResolvedCursor > currentCursor) {
          // Undo/rebase intentionally burns event cursors. The resolved command
          // record is authoritative for that gap; advancing before applying
          // reproduces its stored cursor without ever reusing a burned value.
          store.restoreMonotonicCounters(store.getAllocatorSnapshot(), firstResolvedCursor);
        }
      }
      const batch: WorkspaceCommandBatch = {
        protocol_version: WORKSPACE_PROTOCOL_VERSION,
        request_id: command.requestId,
        workspace_id: checkpoint.workspaceId,
        input_revision: command.inputRevision,
        base_workspace_revision: command.baseWorkspaceRevision,
        registry_digest: command.inputRegistryDigest,
        mode: "commit",
        operations: structuredClone(command.resolvedOperations),
      };
      const authorization = { actor: command.actor, permissions: ["*"] } as const;
      const result = store.applyResolvedHistoryDetailed(
        batch,
        authorization,
        command.resolvedActionEffects,
      );
      if (!semanticWorkspaceEqual(result.command, command)) {
        throw new WorkspaceProjectError(`Resolved replay mismatch at ${command.requestId}`, "replay_mismatch");
      }
    }
    store.restoreMonotonicCounters(project.nextComponentSequence, project.nextEventCursor);
    if (verifySavedState) {
      const saved = workspaceFromSerializable(project.workspace);
      if (!semanticWorkspaceEqual(store.getState(), saved)) {
        throw new WorkspaceProjectError("Command history does not reproduce the saved workspace", "replay_mismatch");
      }
    }
    return store;
  }

  private isLegacyProject(project: WorkspaceProjectFile): boolean {
    return String(project.protocolVersion) === LEGACY_WORKSPACE_PROTOCOL_VERSION
      && String(project.workspaceSchemaVersion) === LEGACY_WORKSPACE_SCHEMA_VERSION;
  }

  private isPreviousProject(project: WorkspaceProjectFile): boolean {
    return String(project.protocolVersion) === PREVIOUS_WORKSPACE_PROTOCOL_VERSION
      && String(project.workspaceSchemaVersion) === PREVIOUS_WORKSPACE_SCHEMA_VERSION;
  }

  private canonicalizeLegacyOperations(
    store: WorkspaceStore,
    operations: readonly WorkspaceOperation[],
    requestId: string,
    discardedStageBindings: Map<string, string>,
  ): WorkspaceOperation[] {
    const state = store.getState();
    const componentTypes = new Map<string, ComponentTypeRef>();
    const componentPlacements = new Map<string, ComponentPlacement>();
    const componentLocks = new Map<string, ComponentLocks>();
    const componentStageDimensions = new Map<string, { width: number; height: number; depth: number }>();
    const resources = new Map<string, WorkspaceResource>();
    for (const component of state.components.values()) {
      componentTypes.set(component.id, structuredClone(component.type));
      componentPlacements.set(component.id, structuredClone(component.placement));
      componentLocks.set(component.id, structuredClone(component.locks));
      const dimensions = legacyStageDimensions(component.props.dimensions);
      if (dimensions) componentStageDimensions.set(component.id, dimensions);
    }
    for (const resource of state.resources.values()) {
      resources.set(resource.id, structuredClone(resource));
    }

    const commandManifests = new Map<string, ComponentManifest>();
    const usedOperationIds = new Set(operations.map((operation) => operation.op_id));
    let generatedSequence = 1;
    const generatedOperationId = (purpose: string): string => {
      let candidate: string;
      do {
        candidate = `migration_${purpose}_${generatedSequence}`;
        generatedSequence += 1;
      } while (usedOperationIds.has(candidate));
      usedOperationIds.add(candidate);
      return candidate;
    };
    const manifestFor = (id: string): ComponentManifest => {
      const ref = componentTypes.get(id);
      if (!ref) {
        throw new WorkspaceMigrationRequiredError(
          `Legacy command ${requestId} references unknown component ${id}`,
        );
      }
      const manifest = commandManifests.get(componentTypeKey(ref))
        ?? store.getComponentManifest(ref.typeId, ref.version);
      if (!manifest || manifest.digest !== ref.digest) {
        throw new WorkspaceMigrationRequiredError(
          `Legacy command ${requestId} references unavailable component type ${componentTypeKey(ref)}`,
        );
      }
      return manifest;
    };

    const canonical: WorkspaceOperation[] = [];
    const pushLegacyStageResize = (
      opId: string,
      componentId: string,
      dimensions: { width: number; height: number; depth: number },
    ): void => {
      const locks = componentLocks.get(componentId) ?? structuredClone(DEFAULT_COMPONENT_LOCKS);
      if (locks.props) {
        throw new WorkspaceMigrationRequiredError(
          `Legacy Stage geometry operation ${opId} ran while props were locked`,
        );
      }
      if (locks.placement || locks.resize) {
        canonical.push({
          op: "update_component",
          op_id: generatedOperationId("stage_unlock"),
          id: componentId,
          patch: { locks: { placement: false, resize: false } },
        }, {
          op: "resize_component",
          op_id: opId,
          id: componentId,
          resize: { kind: "stage_dimensions", dimensions: structuredClone(dimensions) },
        }, {
          op: "update_component",
          op_id: generatedOperationId("stage_relock"),
          id: componentId,
          patch: { locks: { placement: locks.placement, resize: locks.resize } },
        });
      } else {
        canonical.push({
          op: "resize_component",
          op_id: opId,
          id: componentId,
          resize: { kind: "stage_dimensions", dimensions: structuredClone(dimensions) },
        });
      }
    };
    for (const source of operations) {
      const operation = structuredClone(source);
      if (operation.op === "define_component_recipe") {
        commandManifests.set(
          componentTypeKey(operation.recipe),
          ComponentRegistry.manifestFromRecipe(operation.recipe),
        );
        canonical.push(operation);
        continue;
      }
      if (operation.op === "create_component") {
        componentTypes.set(operation.id, structuredClone(operation.component_type));
        const manifest = manifestFor(operation.id);
        operation.placement = canonicalLegacyPlacement(manifest, operation.placement);
        componentPlacements.set(operation.id, structuredClone(operation.placement));
        componentLocks.set(operation.id, {
          ...structuredClone(DEFAULT_COMPONENT_LOCKS),
          ...structuredClone(operation.locks ?? {}),
        });
        const policy = resizePolicyForPlacement(manifest, operation.placement);
        const dimensions = legacyStageDimensions(operation.props?.dimensions)
          ?? (policy.kind === "stage_dimensions" ? structuredClone(policy.defaultDimensions) : undefined);
        if (dimensions) componentStageDimensions.set(operation.id, dimensions);
        canonical.push(operation);
        continue;
      }
      if (operation.op === "update_component") {
        const placement = componentPlacements.get(operation.id);
        const manifest = manifestFor(operation.id);
        const currentLocks = componentLocks.get(operation.id) ?? structuredClone(DEFAULT_COMPONENT_LOCKS);
        const finalLocks = { ...currentLocks, ...structuredClone(operation.patch.locks ?? {}) };
        const dimensions = legacyStageDimensions(operation.patch.props?.dimensions);
        const policy = placement ? resizePolicyForPlacement(manifest, placement) : undefined;
        if (dimensions && policy?.kind === "stage_dimensions") {
          if (currentLocks.props) {
            throw new WorkspaceMigrationRequiredError(
              `Legacy Stage update ${operation.op_id} changed dimensions while props were locked`,
            );
          }
          componentStageDimensions.set(operation.id, structuredClone(dimensions));
          const patch = structuredClone(operation.patch);
          const remainingProps = { ...structuredClone(patch.props ?? {}) };
          delete remainingProps.dimensions;
          if (Object.keys(remainingProps).length) patch.props = remainingProps;
          else delete patch.props;
          const hasRemainingPatch = Object.keys(patch).length > 0;
          if (currentLocks.placement || currentLocks.resize) {
            canonical.push({
              op: "update_component",
              op_id: generatedOperationId("stage_unlock"),
              id: operation.id,
              patch: { locks: { placement: false, resize: false } },
            }, {
              op: "resize_component",
              op_id: generatedOperationId("stage_resize"),
              id: operation.id,
              resize: { kind: "stage_dimensions", dimensions },
            });
            patch.locks = {
              ...structuredClone(patch.locks ?? {}),
              placement: finalLocks.placement,
              resize: finalLocks.resize,
            };
            canonical.push({ ...operation, patch });
          } else {
            canonical.push({
              op: "resize_component",
              op_id: hasRemainingPatch ? generatedOperationId("stage_resize") : operation.op_id,
              id: operation.id,
              resize: { kind: "stage_dimensions", dimensions },
            });
            if (hasRemainingPatch) canonical.push({ ...operation, patch });
          }
          componentLocks.set(operation.id, finalLocks);
          continue;
        }
        componentLocks.set(operation.id, finalLocks);
        canonical.push(operation);
        continue;
      }
      if (operation.op === "resize_component") {
        if (operation.resize.kind === "stage_dimensions") {
          componentStageDimensions.set(operation.id, structuredClone(operation.resize.dimensions));
        } else {
          const placement = componentPlacements.get(operation.id);
          if (placement && operation.resize.kind === "box2d") {
            placement.size = structuredClone(operation.resize.size);
          } else if (placement?.space === "world3d" && operation.resize.kind === "scale3d") {
            placement.scale = structuredClone(operation.resize.scale);
          }
        }
        canonical.push(operation);
        continue;
      }
      if (operation.op === "place_component") {
        const manifest = manifestFor(operation.id);
        const priorPlacement = componentPlacements.get(operation.id);
        const priorPolicy = priorPlacement
          ? resizePolicyForPlacement(manifest, priorPlacement)
          : undefined;
        const legacyPlacement = structuredClone(operation.placement);
        const canonicalPlacement = canonicalLegacyPlacement(manifest, legacyPlacement);
        const nextPolicy = resizePolicyForPlacement(manifest, canonicalPlacement);
        const samePolicy = priorPolicy
          ? stableStringify(priorPolicy) === stableStringify(nextPolicy)
          : false;
        if (samePolicy && nextPolicy.kind === "box2d") {
          const desiredSize = structuredClone(canonicalPlacement.size ?? nextPolicy.defaultSize);
          canonical.push({
            op: "resize_component",
            op_id: generatedOperationId("place_resize"),
            id: operation.id,
            resize: { kind: "box2d", size: desiredSize },
          });
          canonicalPlacement.size = structuredClone(desiredSize);
        } else if (
          samePolicy
          && nextPolicy.kind === "scale3d"
          && legacyPlacement.space === "world3d"
          && canonicalPlacement.space === "world3d"
        ) {
          const desiredScale = structuredClone(canonicalPlacement.scale);
          canonical.push({
            op: "resize_component",
            op_id: generatedOperationId("place_scale"),
            id: operation.id,
            resize: { kind: "scale3d", scale: desiredScale },
          });
          canonicalPlacement.scale = structuredClone(desiredScale);
        } else if (samePolicy && nextPolicy.kind === "none") {
          const frozenSize = priorPlacement?.size;
          if (legacyPlacement.size && !sameSize(legacyPlacement.size, frozenSize)) {
            throw new WorkspaceMigrationRequiredError(
              `Legacy fixed component ${operation.id} changed size through place_component`,
            );
          }
          if (frozenSize) canonicalPlacement.size = structuredClone(frozenSize);
          else delete canonicalPlacement.size;
        } else if (!samePolicy && nextPolicy.kind === "box2d") {
          const desiredSize = structuredClone(canonicalPlacement.size ?? nextPolicy.defaultSize);
          canonicalPlacement.size = structuredClone(nextPolicy.defaultSize);
          operation.placement = structuredClone(canonicalPlacement);
          canonical.push(operation);
          if (!sameSize(desiredSize, nextPolicy.defaultSize)) {
            canonical.push({
              op: "resize_component",
              op_id: generatedOperationId("place_resize"),
              id: operation.id,
              resize: { kind: "box2d", size: desiredSize },
            });
          }
          canonicalPlacement.size = structuredClone(desiredSize);
          componentPlacements.set(operation.id, structuredClone(canonicalPlacement));
          continue;
        } else if (
          !samePolicy
          && nextPolicy.kind === "scale3d"
          && legacyPlacement.space === "world3d"
          && canonicalPlacement.space === "world3d"
        ) {
          const desiredScale = structuredClone(canonicalPlacement.scale);
          canonicalPlacement.scale = structuredClone(nextPolicy.defaultScale);
          operation.placement = structuredClone(canonicalPlacement);
          canonical.push(operation);
          if (!sameScale(desiredScale, nextPolicy.defaultScale)) {
            canonical.push({
              op: "resize_component",
              op_id: generatedOperationId("place_scale"),
              id: operation.id,
              resize: { kind: "scale3d", scale: desiredScale },
            });
          }
          canonicalPlacement.scale = structuredClone(desiredScale);
          componentPlacements.set(operation.id, structuredClone(canonicalPlacement));
          continue;
        } else if (!samePolicy && nextPolicy.kind === "none") {
          let frozenSize = priorPlacement?.size ? structuredClone(priorPlacement.size) : undefined;
          if (legacyPlacement.size && priorPolicy?.kind === "box2d") {
            const normalizedSize = {
              width: Math.min(
                priorPolicy.maxSize.width,
                Math.max(priorPolicy.minSize.width, legacyPlacement.size.width),
              ),
              height: Math.min(
                priorPolicy.maxSize.height,
                Math.max(priorPolicy.minSize.height, legacyPlacement.size.height),
              ),
            };
            canonical.push({
              op: "resize_component",
              op_id: generatedOperationId("place_resize"),
              id: operation.id,
              resize: { kind: "box2d", size: structuredClone(normalizedSize) },
            });
            frozenSize = structuredClone(normalizedSize);
          } else if (legacyPlacement.size && !sameSize(legacyPlacement.size, frozenSize)) {
            throw new WorkspaceMigrationRequiredError(
              `Legacy transition to fixed component ${operation.id} has no canonical resize path`,
            );
          }
          if (frozenSize) canonicalPlacement.size = structuredClone(frozenSize);
          else delete canonicalPlacement.size;
        }
        operation.placement = structuredClone(canonicalPlacement);
        canonical.push(operation);
        componentPlacements.set(operation.id, structuredClone(canonicalPlacement));
        continue;
      }
      if (operation.op === "upsert_resource") {
        resources.set(operation.resource.id, structuredClone(operation.resource));
        canonical.push(operation);
        continue;
      }
      if (operation.op === "delete_resource") {
        resources.delete(operation.resource_id);
        canonical.push(operation);
        continue;
      }
      if (operation.op === "bind_resource") {
        const componentId = operation.binding.componentId;
        const placement = componentPlacements.get(componentId);
        const manifest = manifestFor(componentId);
        const policy = placement ? resizePolicyForPlacement(manifest, placement) : undefined;
        if (operation.binding.targetProp === "dimensions" && policy?.kind === "stage_dimensions") {
          const currentDimensions = componentStageDimensions.get(componentId);
          if (!currentDimensions) {
            throw new WorkspaceMigrationRequiredError(
              `Legacy Stage binding ${operation.binding.id} has no authoritative dimensions snapshot`,
            );
          }
          const dimensions = resolveLegacyStageBindingDimensions(
            resources.get(operation.binding.resourceId),
            operation.binding,
            currentDimensions,
          );
          componentStageDimensions.set(componentId, structuredClone(dimensions));
          discardedStageBindings.set(operation.binding.id, componentId);
          pushLegacyStageResize(operation.op_id, componentId, dimensions);
          continue;
        }
        canonical.push(operation);
        continue;
      }
      if (operation.op === "unbind_resource") {
        const componentId = discardedStageBindings.get(operation.binding_id);
        if (componentId) {
          const dimensions = componentStageDimensions.get(componentId);
          if (!dimensions) {
            throw new WorkspaceMigrationRequiredError(
              `Legacy Stage unbind ${operation.binding_id} has no authoritative dimensions snapshot`,
            );
          }
          discardedStageBindings.delete(operation.binding_id);
          const locks = componentLocks.get(componentId) ?? structuredClone(DEFAULT_COMPONENT_LOCKS);
          canonical.push({
            op: "update_component",
            op_id: operation.op_id,
            id: componentId,
            patch: { locks: { placement: locks.placement, resize: locks.resize } },
          });
          continue;
        }
        canonical.push(operation);
        continue;
      }
      if (operation.op === "delete_component") {
        componentTypes.delete(operation.id);
        componentPlacements.delete(operation.id);
        componentLocks.delete(operation.id);
        componentStageDimensions.delete(operation.id);
      } else if (operation.op === "clear_workspace") {
        componentTypes.clear();
        componentPlacements.clear();
        componentLocks.clear();
        componentStageDimensions.clear();
      }
      canonical.push(operation);
    }

    return canonical;
  }

  /**
   * Upgrade a validated 1.0 file by replaying its authoritative resolved
   * command history through the 1.1 engine. This refreshes registry digests,
   * materializes previously implicit geometry and records the resize lock
   * without interpreting user text or weakening replay verification.
   */
  private migrateLegacyProject(project: WorkspaceProjectFile): WorkspaceProjectFile {
    const legacyCheckpoint = workspaceFromSerializable(project.checkpoint);
    const discardedStageBindings = new Map<string, string>();
    for (const connection of legacyCheckpoint.connections.values()) {
      const component = connection.kind === "resource_binding"
        ? legacyCheckpoint.components.get(connection.componentId)
        : undefined;
      if (
        connection.kind === "resource_binding"
        && connection.targetProp === "dimensions"
        && component?.type.typeId === "stage-3d"
      ) {
        discardedStageBindings.set(connection.id, component.id);
      }
    }
    const checkpoint = migrateWorkspaceStateToCurrent(legacyCheckpoint, this.registry);
    checkpoint.history = checkpoint.history.map((summary) => ({
      ...structuredClone(summary),
      resultingRegistryDigest: checkpoint.registryDigest,
    }));
    const store = new WorkspaceStore({
      initialState: checkpoint,
      checkpointState: checkpoint,
      registry: this.registry,
      nextComponentSequence: project.checkpointNextComponentSequence,
      checkpointNextComponentSequence: project.checkpointNextComponentSequence,
      nextEventCursor: project.checkpointNextEventCursor,
      checkpointNextEventCursor: project.checkpointNextEventCursor,
    });

    for (const command of project.commandHistory) {
      const firstResolvedCursor = command.resolvedEvents[0]?.cursor;
      if (firstResolvedCursor !== undefined) {
        const currentCursor = store.getNextEventCursor();
        if (firstResolvedCursor < currentCursor) {
          throw new WorkspaceMigrationRequiredError(
            `Legacy event cursor moved backward at ${command.requestId}`,
          );
        }
        if (firstResolvedCursor > currentCursor) {
          store.restoreMonotonicCounters(store.getAllocatorSnapshot(), firstResolvedCursor);
        }
      }
      const batch: WorkspaceCommandBatch = {
        protocol_version: WORKSPACE_PROTOCOL_VERSION,
        request_id: command.requestId,
        workspace_id: checkpoint.workspaceId,
        input_revision: command.inputRevision,
        base_workspace_revision: command.baseWorkspaceRevision,
        registry_digest: store.getRegistryDigest(),
        mode: "commit",
        operations: this.canonicalizeLegacyOperations(
          store,
          command.resolvedOperations,
          command.requestId,
          discardedStageBindings,
        ),
      };
      store.applyResolvedHistoryDetailed(
        batch,
        { actor: command.actor, permissions: ["*"] },
        command.resolvedActionEffects,
      );
    }
    store.restoreMonotonicCounters(project.nextComponentSequence, project.nextEventCursor);

    const migratedState = store.getState() as WorkspaceState;
    const expected = migrateWorkspaceStateToCurrent(
      workspaceFromSerializable(project.workspace),
      this.registry,
    );
    // The raw 1.0 history was already validated above. Its registry digests
    // predate the 1.1 registry, so compare the semantic data against the
    // authoritative replay while using the replayed summary metadata.
    expected.history = structuredClone(migratedState.history);
    expected.registryDigest = migratedState.registryDigest;
    if (!semanticWorkspaceEqual(migratedState, expected)) {
      throw new WorkspaceMigrationRequiredError(
        "Workspace 1.0 history does not reproduce its migrated saved state",
      );
    }

    return {
      ...structuredClone(project),
      protocolVersion: WORKSPACE_PROTOCOL_VERSION,
      workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
      registryDigest: migratedState.registryDigest,
      checkpoint: workspaceToSerializable(checkpoint),
      workspace: workspaceToSerializable(migratedState),
      commandHistory: store.getCommandHistory(),
    };
  }

  private validate(project: WorkspaceProjectFile, allowLegacy = false): void {
    this.validateVersions(project, allowLegacy);
    if (!projectValidator(project)) {
      throw new WorkspaceProjectError(
        `Project does not match Workspace Project 1.0: ${errorText(projectValidator.errors)}`,
        "invalid_project",
      );
    }
    const checkpoint = workspaceFromSerializable(project.checkpoint);
    const workspace = workspaceFromSerializable(project.workspace);
    if (
      checkpoint.protocolVersion !== project.protocolVersion
      || workspace.protocolVersion !== project.protocolVersion
      || checkpoint.workspaceSchemaVersion !== project.workspaceSchemaVersion
      || workspace.workspaceSchemaVersion !== project.workspaceSchemaVersion
    ) {
      throw new WorkspaceProjectError(
        "Project and embedded Workspace protocol/schema versions disagree",
        "invalid_project",
      );
    }
    if (workspace.workspaceId !== checkpoint.workspaceId) throw new WorkspaceProjectError("Checkpoint and workspace IDs disagree", "invalid_project");
    if (workspace.registryDigest !== project.registryDigest) throw new WorkspaceProjectError("Project and workspace registry digests disagree", "invalid_project");
    try {
      for (const resource of checkpoint.resources.values()) assertWorkspaceResourceSafe(resource);
      for (const resource of workspace.resources.values()) assertWorkspaceResourceSafe(resource);
      for (const command of project.commandHistory) {
        for (const operation of command.resolvedOperations) {
          if (operation.op === "upsert_resource") assertWorkspaceResourceSafe(operation.resource);
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceResourceValidationError) {
        throw new WorkspaceProjectError(`Project contains an unsafe resource: ${error.message}`, "invalid_project");
      }
      throw error;
    }
    // Construction applies manifest, resource, secret, reference and graph validation.
    new WorkspaceStore({ initialState: checkpoint, registry: this.registry, nextComponentSequence: project.checkpointNextComponentSequence, nextEventCursor: project.checkpointNextEventCursor });
    new WorkspaceStore({ initialState: workspace, registry: this.registry, nextComponentSequence: project.nextComponentSequence, nextEventCursor: project.nextEventCursor, commandHistory: project.commandHistory });

    let revision = checkpoint.revision;
    let digest = checkpoint.registryDigest;
    let historyIndex = checkpoint.history.length;
    const requestIds = new Set<string>();
    const eventIds = new Set<string>();
    const cursors = new Set<number>();
    let nextReplayableEventCursor = project.checkpointNextEventCursor;
    for (const command of project.commandHistory) {
      if (requestIds.has(command.requestId)) throw new WorkspaceProjectError(`Duplicate request ${command.requestId}`, "invalid_command_history");
      requestIds.add(command.requestId);
      if (command.baseWorkspaceRevision !== revision || command.resultingWorkspaceRevision !== revision + 1) {
        throw new WorkspaceProjectError(`Command history gap at ${command.requestId}`, "invalid_command_history");
      }
      if (command.inputRegistryDigest !== digest) throw new WorkspaceProjectError(`Registry history gap at ${command.requestId}`, "invalid_command_history");
      if (command.resolvedOperations.length === 0) throw new WorkspaceProjectError(`Command ${command.requestId} has no resolved operations`, "invalid_command_history");
      const summary = workspace.history[historyIndex];
      if (!summary || summary.requestId !== command.requestId || summary.resultingWorkspaceRevision !== command.resultingWorkspaceRevision) {
        throw new WorkspaceProjectError(`Workspace history mismatch at ${command.requestId}`, "invalid_command_history");
      }
      for (const [eventIndex, event] of command.resolvedEvents.entries()) {
        if (eventIds.has(event.id) || cursors.has(event.cursor)) throw new WorkspaceProjectError(`Duplicate event identity at ${command.requestId}`, "invalid_command_history");
        if (event.workspaceRevision !== command.resultingWorkspaceRevision) {
          throw new WorkspaceProjectError(`Event revision mismatch at ${command.requestId}`, "invalid_command_history");
        }
        const minimumCursor = eventIndex === 0 ? nextReplayableEventCursor : command.resolvedEvents[eventIndex - 1]!.cursor + 1;
        if (event.cursor < minimumCursor || (eventIndex > 0 && event.cursor !== minimumCursor)) {
          throw new WorkspaceProjectError(`Event cursor ordering mismatch at ${command.requestId}`, "invalid_command_history");
        }
        eventIds.add(event.id);
        cursors.add(event.cursor);
      }
      if (command.resolvedEvents.length) {
        nextReplayableEventCursor = command.resolvedEvents.at(-1)!.cursor + 1;
      }
      revision = command.resultingWorkspaceRevision;
      digest = command.resultingRegistryDigest;
      historyIndex += 1;
    }
    if (revision !== workspace.revision || digest !== workspace.registryDigest || historyIndex !== workspace.history.length) {
      throw new WorkspaceProjectError("Checkpoint, command history, and saved workspace disagree", "invalid_command_history");
    }
    const maximumCursor = Math.max(0, ...cursors);
    if (project.nextEventCursor <= maximumCursor || project.nextEventCursor < project.checkpointNextEventCursor) {
      throw new WorkspaceProjectError("Event cursor would be reused", "invalid_project");
    }
    if (project.nextComponentSequence < project.checkpointNextComponentSequence) {
      throw new WorkspaceProjectError("Component ID sequence moved backwards", "invalid_project");
    }
  }

  private validateVersions(
    project: Pick<WorkspaceProjectFile, "formatVersion" | "protocolVersion" | "workspaceSchemaVersion" | "registryDigest">,
    allowLegacy = false,
  ): void {
    if (project.formatVersion !== WORKSPACE_PROJECT_FORMAT_VERSION) {
      throw new WorkspaceMigrationRequiredError(`Workspace project format ${project.formatVersion} is incompatible with ${WORKSPACE_PROJECT_FORMAT_VERSION}`);
    }
    const current = project.protocolVersion === WORKSPACE_PROTOCOL_VERSION
      && project.workspaceSchemaVersion === WORKSPACE_SCHEMA_VERSION;
    const legacy = String(project.protocolVersion) === LEGACY_WORKSPACE_PROTOCOL_VERSION
      && String(project.workspaceSchemaVersion) === LEGACY_WORKSPACE_SCHEMA_VERSION;
    const previous = String(project.protocolVersion) === PREVIOUS_WORKSPACE_PROTOCOL_VERSION
      && String(project.workspaceSchemaVersion) === PREVIOUS_WORKSPACE_SCHEMA_VERSION;
    if (!current && !(allowLegacy && (legacy || previous))) {
      throw new WorkspaceMigrationRequiredError(`Workspace protocol/schema is incompatible with ${WORKSPACE_PROTOCOL_VERSION}`);
    }
    // Exact registry equality is checked on each embedded state, including recipes.
    if (!project.registryDigest) throw new WorkspaceMigrationRequiredError("Workspace registry digest is missing");
  }
}

export function replayWorkspaceProject(
  project: WorkspaceProjectFile,
  registry?: ComponentRegistry,
): WorkspaceStore {
  return new WorkspaceProjectSerializer(registry).replay(project);
}
