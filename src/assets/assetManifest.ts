import manifestJson from "./assetManifest.json";
import type {
  AnimationClip,
  Dimensions,
  EntityKind,
} from "../renderer/sceneRenderTypes";

export const NEUTRAL_LOW_POLY_STYLE = "neutral_low_poly_v1" as const;

export type AssetOriginRule = "ground_center" | "logical_center";
export type AssetRenderShape =
  | "box"
  | "sphere"
  | "capsule"
  | "cylinder"
  | "cone"
  | "plane"
  | "humanoid"
  | "quadruped"
  | "table"
  | "chair"
  | "door"
  | "window"
  | "lamp"
  | "tree"
  | "vehicle"
  | "effect";

export type AssetRuntime = {
  uri: string;
  format: "glb";
  unitScaleMeters: number;
  upAxis: "+Y";
  forwardAxis: "+Z";
  originRule: AssetOriginRule;
};

/**
 * Procedural render hints keep the starter product useful before the curated
 * GLB library is installed. They are renderer hints, never semantic identity.
 */
export type AssetRenderHint = {
  shape: AssetRenderShape;
  primaryColor: `#${string}`;
  accentColor?: `#${string}`;
};

export type AssetRecord = {
  assetId: string;
  kind: EntityKind;
  displayName: string;
  tags: string[];
  styleFamily: string;
  runtime?: AssetRuntime;
  bounds: Dimensions;
  defaultScale: number;
  anchors: string[];
  sockets: string[];
  animations: AnimationClip[];
  supportedStates: string[];
  variants: string[];
  source: "bundled" | "procedural";
  license: "project_owned_or_permissive";
  renderHint: AssetRenderHint;
  fallback?: boolean;
};

export type AssetManifest = {
  assetLibraryVersion: string;
  styleFamily: string;
  assets: AssetRecord[];
};

const ASSET_KINDS = new Set<EntityKind>([
  "character", "animal", "prop", "structure", "effect", "primitive",
]);
const ASSET_SHAPES = new Set<AssetRenderShape>([
  "box", "sphere", "capsule", "cylinder", "cone", "plane", "humanoid", "quadruped",
  "table", "chair", "door", "window", "lamp", "tree", "vehicle", "effect",
]);
const ANIMATION_CLIPS = new Set<AnimationClip>(["idle", "walk", "run", "enter", "exit"]);

function manifestError(path: string, message: string): never {
  throw new TypeError(`Asset manifest does not match assetManifest.schema.json: ${path} ${message}`);
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return manifestError(path, "must be an object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) return manifestError(`${path}/${unknown}`, "is not allowed");
  const missing = required.find((key) => !Object.hasOwn(record, key));
  if (missing) return manifestError(`${path}/${missing}`, "is required");
  return record;
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) return manifestError(path, "must be a non-empty string");
  return value;
}

function finiteNumber(value: unknown, path: string, minimumExclusive?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)
    || (minimumExclusive !== undefined && value <= minimumExclusive)) {
    return manifestError(path, "must be a finite number in range");
  }
  return value;
}

function uniqueStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return manifestError(path, "must be an array");
  const strings = value.map((entry, index) => nonemptyString(entry, `${path}/${index}`));
  if (new Set(strings).size !== strings.length) return manifestError(path, "must contain unique items");
  return strings;
}

function enumArray<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T[] {
  if (!Array.isArray(value)) return manifestError(path, "must be an array");
  const result = value.map((entry, index) => {
    if (typeof entry !== "string" || !allowed.has(entry as T)) {
      return manifestError(`${path}/${index}`, "contains an unsupported value");
    }
    return entry as T;
  });
  if (new Set(result).size !== result.length) return manifestError(path, "must contain unique items");
  return result;
}

function validateBounds(value: unknown, path: string): void {
  const bounds = exactObject(value, ["width", "height", "depth"], ["width", "height", "depth"], path);
  finiteNumber(bounds.width, `${path}/width`, 0);
  finiteNumber(bounds.height, `${path}/height`, 0);
  finiteNumber(bounds.depth, `${path}/depth`, 0);
}

function validateRuntime(value: unknown, path: string): void {
  const runtime = exactObject(
    value,
    ["uri", "format", "unitScaleMeters", "upAxis", "forwardAxis", "originRule"],
    ["uri", "format", "unitScaleMeters", "upAxis", "forwardAxis", "originRule"],
    path,
  );
  const uri = nonemptyString(runtime.uri, `${path}/uri`);
  if (!uri.endsWith(".glb")) manifestError(`${path}/uri`, "must end in .glb");
  if (runtime.format !== "glb" || runtime.upAxis !== "+Y" || runtime.forwardAxis !== "+Z"
    || (runtime.originRule !== "ground_center" && runtime.originRule !== "logical_center")) {
    manifestError(path, "uses an unsupported runtime contract");
  }
  finiteNumber(runtime.unitScaleMeters, `${path}/unitScaleMeters`, 0);
}

function validateRenderHint(value: unknown, path: string): void {
  const hint = exactObject(value, ["shape", "primaryColor", "accentColor"], ["shape", "primaryColor"], path);
  if (typeof hint.shape !== "string" || !ASSET_SHAPES.has(hint.shape as AssetRenderShape)) {
    manifestError(`${path}/shape`, "is unsupported");
  }
  for (const field of ["primaryColor", "accentColor"] as const) {
    const color = hint[field];
    if (color !== undefined && (typeof color !== "string" || !/^#[0-9A-F]{6}$/u.test(color))) {
      manifestError(`${path}/${field}`, "must be an uppercase six-digit color");
    }
  }
}

function validateAssetRecord(value: unknown, index: number): AssetRecord {
  const path = `/assets/${index}`;
  const record = exactObject(value, [
    "assetId", "kind", "displayName", "tags", "styleFamily", "runtime", "bounds", "defaultScale",
    "anchors", "sockets", "animations", "supportedStates", "variants", "source", "license",
    "renderHint", "fallback",
  ], [
    "assetId", "kind", "displayName", "tags", "styleFamily", "bounds", "defaultScale", "anchors",
    "sockets", "animations", "supportedStates", "variants", "source", "license", "renderHint",
  ], path);
  nonemptyString(record.assetId, `${path}/assetId`);
  nonemptyString(record.displayName, `${path}/displayName`);
  nonemptyString(record.styleFamily, `${path}/styleFamily`);
  if (typeof record.kind !== "string" || !ASSET_KINDS.has(record.kind as EntityKind)) {
    manifestError(`${path}/kind`, "is unsupported");
  }
  uniqueStrings(record.tags, `${path}/tags`);
  uniqueStrings(record.anchors, `${path}/anchors`);
  uniqueStrings(record.sockets, `${path}/sockets`);
  uniqueStrings(record.supportedStates, `${path}/supportedStates`);
  uniqueStrings(record.variants, `${path}/variants`);
  enumArray(record.animations, ANIMATION_CLIPS, `${path}/animations`);
  validateBounds(record.bounds, `${path}/bounds`);
  const defaultScale = finiteNumber(record.defaultScale, `${path}/defaultScale`);
  if (defaultScale < 0.01 || defaultScale > 100) manifestError(`${path}/defaultScale`, "must be in [0.01, 100]");
  if (record.source !== "bundled" && record.source !== "procedural") manifestError(`${path}/source`, "is unsupported");
  if (record.license !== "project_owned_or_permissive") manifestError(`${path}/license`, "is unsupported");
  if (record.fallback !== undefined && typeof record.fallback !== "boolean") manifestError(`${path}/fallback`, "must be boolean");
  validateRenderHint(record.renderHint, `${path}/renderHint`);
  if (record.source === "bundled") {
    if (record.runtime === undefined) manifestError(`${path}/runtime`, "is required for bundled assets");
    validateRuntime(record.runtime, `${path}/runtime`);
  } else if (record.runtime !== undefined) {
    manifestError(`${path}/runtime`, "is forbidden for procedural assets");
  }
  return record as unknown as AssetRecord;
}

/** Runtime gate for shipped and arbitrary caller-supplied asset manifests. */
export function assertAssetManifest(value: unknown): asserts value is AssetManifest {
  const manifest = exactObject(value, ["assetLibraryVersion", "styleFamily", "assets"], [
    "assetLibraryVersion", "styleFamily", "assets",
  ], "/");
  nonemptyString(manifest.assetLibraryVersion, "/assetLibraryVersion");
  const styleFamily = nonemptyString(manifest.styleFamily, "/styleFamily");
  if (!Array.isArray(manifest.assets)) manifestError("/assets", "must be an array");
  const assets = manifest.assets.map(validateAssetRecord);

  const ids = new Set<string>();
  for (const record of assets) {
    if (!record.assetId || ids.has(record.assetId)) {
      throw new TypeError(`Duplicate or empty assetId: ${record.assetId}`);
    }
    ids.add(record.assetId);
    if (record.styleFamily !== styleFamily) {
      throw new TypeError(
        `Asset ${record.assetId} uses style family ${record.styleFamily}; manifest declares ${styleFamily}`,
      );
    }
  }
}

assertAssetManifest(manifestJson);

export const ASSET_MANIFEST: AssetManifest = manifestJson;
export const ASSET_LIBRARY_VERSION = ASSET_MANIFEST.assetLibraryVersion;
