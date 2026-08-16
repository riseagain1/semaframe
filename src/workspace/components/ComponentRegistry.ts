import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type {
  ComponentManifest,
  ComponentRecipe,
  ComponentTypeRef,
  JSONObject,
  PlacementSpace,
} from "./componentTypes";
import { defaultRecipeResizePolicies } from "./componentTypes";
import { BUILTIN_COMPONENT_MANIFESTS } from "./builtinManifests";
import { deterministicDigest } from "./manifestDigest";

export class ComponentRegistryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ComponentRegistryError";
  }
}

/** Hard geometry limits shared by manifest validation and workspace state validation. */
export const WORKSPACE_BOX_SIZE_MIN = 1;
export const WORKSPACE_BOX_SIZE_MAX = 4_096;
export const WORKSPACE_SCALE_MIN = 0.01;
export const WORKSPACE_SCALE_MAX = 100;

type Validators = { props: ValidateFunction; durableState: ValidateFunction };

function manifestKey(typeId: string, version: string): string {
  return `${typeId}@${version}`;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function assertResizePolicyShape(manifest: ComponentManifest): void {
  for (const placement of manifest.allowedPlacements) {
    const policy = manifest.resizePolicy[placement];
    if (!policy) {
      throw new ComponentRegistryError(`Missing ${placement} resize policy in ${manifest.typeId}`, "invalid_manifest");
    }
    if (policy.kind === "none") continue;
    if (policy.kind === "box2d") {
      const values = [
        policy.defaultSize.width, policy.defaultSize.height,
        policy.minSize.width, policy.minSize.height,
        policy.maxSize.width, policy.maxSize.height,
      ];
      if (
        values.some((value) => !finitePositive(value))
        || policy.minSize.width > policy.defaultSize.width
        || policy.defaultSize.width > policy.maxSize.width
        || policy.minSize.height > policy.defaultSize.height
        || policy.defaultSize.height > policy.maxSize.height
        || policy.minSize.width < WORKSPACE_BOX_SIZE_MIN
        || policy.minSize.height < WORKSPACE_BOX_SIZE_MIN
        || policy.maxSize.width > WORKSPACE_BOX_SIZE_MAX
        || policy.maxSize.height > WORKSPACE_BOX_SIZE_MAX
        || !policy.allowedAxes.length
        || new Set(policy.allowedAxes).size !== policy.allowedAxes.length
        || policy.allowedAxes.some((axis) => axis !== "width" && axis !== "height")
        || (policy.mode === "aspect_locked"
          && (!policy.aspectRatio || !finitePositive(policy.aspectRatio)
            || Math.abs(policy.defaultSize.width / policy.defaultSize.height - policy.aspectRatio) > 1e-9
            || !policy.allowedAxes.includes("width")
            || !policy.allowedAxes.includes("height")))
      ) {
        throw new ComponentRegistryError(`Invalid box2d resize policy in ${manifest.typeId}`, "invalid_manifest");
      }
      continue;
    }
    if (policy.kind === "scale3d") {
      const axes = ["x", "y", "z"] as const;
      if (
        axes.some((axis) => !finitePositive(policy.defaultScale[axis])
          || !finitePositive(policy.minScale[axis])
          || !finitePositive(policy.maxScale[axis])
          || policy.minScale[axis] > policy.defaultScale[axis]
          || policy.defaultScale[axis] > policy.maxScale[axis])
        || axes.some((axis) => policy.minScale[axis] < WORKSPACE_SCALE_MIN
          || policy.maxScale[axis] > WORKSPACE_SCALE_MAX)
        || !policy.allowedAxes.length
        || new Set(policy.allowedAxes).size !== policy.allowedAxes.length
        || policy.allowedAxes.some((axis) => axis !== "x" && axis !== "y" && axis !== "z")
        || placement !== "world3d"
        || manifest.trustTier !== "builtin"
        || manifest.typeId !== "spatial-entity"
        || (policy.mode === "uniform"
          && (policy.defaultScale.x !== policy.defaultScale.y
            || policy.defaultScale.y !== policy.defaultScale.z
            || axes.some((axis) => !policy.allowedAxes.includes(axis))))
      ) {
        throw new ComponentRegistryError(`Invalid scale3d resize policy in ${manifest.typeId}`, "invalid_manifest");
      }
      continue;
    }
    const axes = ["width", "height", "depth"] as const;
    if (
      axes.some((axis) => !finitePositive(policy.defaultDimensions[axis])
        || !finitePositive(policy.minDimensions[axis])
        || !finitePositive(policy.maxDimensions[axis])
        || policy.minDimensions[axis] > policy.defaultDimensions[axis]
        || policy.defaultDimensions[axis] > policy.maxDimensions[axis])
      || !policy.allowedAxes.length
      || new Set(policy.allowedAxes).size !== policy.allowedAxes.length
      || policy.allowedAxes.some((axis) => axis !== "width" && axis !== "height" && axis !== "depth")
      || placement !== "world3d"
      || manifest.trustTier !== "builtin"
      || manifest.typeId !== "stage-3d"
      || (policy.mode === "uniform"
        && (policy.defaultDimensions.width !== policy.defaultDimensions.height
          || policy.defaultDimensions.height !== policy.defaultDimensions.depth
          || axes.some((axis) => !policy.allowedAxes.includes(axis))))
    ) {
      throw new ComponentRegistryError(`Invalid stage resize policy in ${manifest.typeId}`, "invalid_manifest");
    }
  }
}

function validateManifestShape(manifest: ComponentManifest): void {
  if (!manifest.typeId || !manifest.version || !manifest.digest || !manifest.displayName) {
    throw new ComponentRegistryError("Component manifest identity fields must be non-empty", "invalid_manifest");
  }
  if (new Set(manifest.allowedPlacements).size !== manifest.allowedPlacements.length) {
    throw new ComponentRegistryError(`Duplicate placement in ${manifest.typeId}`, "invalid_manifest");
  }
  if (new Set(manifest.writableProps).size !== manifest.writableProps.length) {
    throw new ComponentRegistryError(`Duplicate writable prop in ${manifest.typeId}`, "invalid_manifest");
  }
  const policySpaces = Object.keys(manifest.resizePolicy);
  if (
    manifest.allowedPlacements.some((placement) => !manifest.resizePolicy[placement])
    || policySpaces.some((placement) => !manifest.allowedPlacements.includes(placement as PlacementSpace))
  ) {
    throw new ComponentRegistryError(
      `Resize policy placements do not match allowed placements in ${manifest.typeId}`,
      "invalid_manifest",
    );
  }
  assertResizePolicyShape(manifest);
}

export class ComponentRegistry {
  private readonly manifests = new Map<string, ComponentManifest>();
  private readonly latestByType = new Map<string, ComponentManifest>();
  private readonly validators = new Map<string, Validators>();
  readonly digest: string;

  constructor(input: readonly ComponentManifest[] = BUILTIN_COMPONENT_MANIFESTS) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, strictNumbers: true });
    for (const manifest of [...input].sort((left, right) =>
      manifestKey(left.typeId, left.version).localeCompare(manifestKey(right.typeId, right.version)))) {
      validateManifestShape(manifest);
      const key = manifestKey(manifest.typeId, manifest.version);
      if (this.manifests.has(key)) {
        throw new ComponentRegistryError(`Duplicate component manifest ${key}`, "duplicate_manifest");
      }
      const props = ajv.compile(structuredClone(manifest.propsSchema));
      const durableState = ajv.compile(structuredClone(manifest.durableStateSchema));
      if (!props(manifest.defaultProps)) {
        throw new ComponentRegistryError(`Invalid default props for ${key}: ${ajv.errorsText(props.errors)}`, "invalid_defaults");
      }
      if (!durableState(manifest.defaultDurableState)) {
        throw new ComponentRegistryError(`Invalid default state for ${key}: ${ajv.errorsText(durableState.errors)}`, "invalid_defaults");
      }
      const cloned = structuredClone(manifest);
      this.manifests.set(key, cloned);
      this.validators.set(key, { props, durableState });
      const prior = this.latestByType.get(manifest.typeId);
      if (!prior || prior.version.localeCompare(manifest.version, undefined, { numeric: true }) < 0) {
        this.latestByType.set(manifest.typeId, cloned);
      }
    }
    this.digest = deterministicDigest(this.list().map((item) => ({
      typeId: item.typeId,
      version: item.version,
      digest: item.digest,
    })));
  }

  list(): ComponentManifest[] {
    return [...this.manifests.values()]
      .sort((left, right) => manifestKey(left.typeId, left.version).localeCompare(manifestKey(right.typeId, right.version)))
      .map((item) => structuredClone(item));
  }

  listLatest(): ComponentManifest[] {
    return [...this.latestByType.values()]
      .sort((left, right) => left.typeId.localeCompare(right.typeId))
      .map((item) => structuredClone(item));
  }

  get(typeId: string, version?: string): ComponentManifest | undefined {
    const item = version
      ? this.manifests.get(manifestKey(typeId, version))
      : this.latestByType.get(typeId);
    return item ? structuredClone(item) : undefined;
  }

  require(typeId: string, version?: string): ComponentManifest {
    const manifest = this.get(typeId, version);
    if (!manifest) throw new ComponentRegistryError(`Unknown component type ${manifestKey(typeId, version ?? "latest")}`, "unknown_component_type");
    return manifest;
  }

  resolve(ref: ComponentTypeRef): ComponentManifest {
    const manifest = this.require(ref.typeId, ref.version);
    if (manifest.digest !== ref.digest) {
      throw new ComponentRegistryError(
        `Component digest mismatch for ${manifestKey(ref.typeId, ref.version)}`,
        "component_digest_mismatch",
      );
    }
    return manifest;
  }

  ref(typeId: string, version?: string): ComponentTypeRef {
    const manifest = this.require(typeId, version);
    return { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest };
  }

  assertProps(ref: ComponentTypeRef, props: JSONObject): void {
    this.resolve(ref);
    const validator = this.validators.get(manifestKey(ref.typeId, ref.version))!;
    if (!validator.props(props)) {
      throw new ComponentRegistryError(
        `Invalid props for ${ref.typeId}: ${validator.props.errors?.map((item) => `${item.instancePath || "/"} ${item.message}`).join("; ")}`,
        "invalid_component_props",
      );
    }
  }

  assertDurableState(ref: ComponentTypeRef, state: JSONObject): void {
    this.resolve(ref);
    const validator = this.validators.get(manifestKey(ref.typeId, ref.version))!;
    if (!validator.durableState(state)) {
      throw new ComponentRegistryError(
        `Invalid durable state for ${ref.typeId}: ${validator.durableState.errors?.map((item) => `${item.instancePath || "/"} ${item.message}`).join("; ")}`,
        "invalid_component_state",
      );
    }
  }

  static manifestFromRecipe(recipe: ComponentRecipe): ComponentManifest {
    return {
      typeId: recipe.typeId,
      version: recipe.version,
      digest: recipe.digest,
      displayName: recipe.displayName,
      trustTier: "declarative",
      allowedPlacements: structuredClone(recipe.allowedPlacements),
      resizePolicy: structuredClone(
        recipe.resizePolicy ?? defaultRecipeResizePolicies(recipe.allowedPlacements),
      ),
      propsSchema: structuredClone(recipe.propsSchema),
      durableStateSchema: structuredClone(recipe.durableStateSchema),
      defaultProps: structuredClone(recipe.defaultProps),
      defaultDurableState: structuredClone(recipe.defaultDurableState),
      writableProps: structuredClone(recipe.writableProps),
      actions: structuredClone(recipe.actions),
      events: structuredClone(recipe.events),
      requiredPermissions: [],
    };
  }
}

export const DEFAULT_COMPONENT_REGISTRY = new ComponentRegistry();
