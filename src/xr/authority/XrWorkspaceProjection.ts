import type { WorkspaceRenderComponent, WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import type { XrJsonObject, XrJsonValue } from "../protocol";
import { parseXrRevision, parseXrWorkspaceId } from "../protocol";

export const XR_WORKSPACE_PROJECTION_FORMAT = "semaframe-xr-workspace" as const;
export const XR_WORKSPACE_DELTA_FORMAT = "semaframe-xr-workspace-delta" as const;

export type XrWorkspaceProjection = Readonly<{
  format: typeof XR_WORKSPACE_PROJECTION_FORMAT;
  version: 1;
  workspaceId: string;
  revision: number;
  components: readonly WorkspaceRenderComponent[];
  recipes?: NonNullable<WorkspaceRenderSnapshot["recipes"]>;
  realityAssets?: NonNullable<WorkspaceRenderSnapshot["realityAssets"]>;
  bindingDiagnostics?: NonNullable<WorkspaceRenderSnapshot["bindingDiagnostics"]>;
}>;

export type XrWorkspaceProjectionDelta = Readonly<{
  format: typeof XR_WORKSPACE_DELTA_FORMAT;
  version: 1;
  workspaceId: string;
  baseRevision: number;
  revision: number;
  added: readonly WorkspaceRenderComponent[];
  updated: readonly WorkspaceRenderComponent[];
  removed: readonly string[];
  componentOrder: readonly string[];
  recipes?: NonNullable<WorkspaceRenderSnapshot["recipes"]>;
  realityAssets?: NonNullable<WorkspaceRenderSnapshot["realityAssets"]>;
  bindingDiagnostics?: NonNullable<WorkspaceRenderSnapshot["bindingDiagnostics"]>;
}>;

const PROJECTION_KEYS = Object.freeze([
  "bindingDiagnostics",
  "components",
  "format",
  "realityAssets",
  "recipes",
  "revision",
  "version",
  "workspaceId",
] as const);

const DELTA_KEYS = Object.freeze([
  "added",
  "baseRevision",
  "bindingDiagnostics",
  "componentOrder",
  "format",
  "realityAssets",
  "recipes",
  "removed",
  "revision",
  "updated",
  "version",
  "workspaceId",
] as const);

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path = "XR Workspace projection",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${path} contains an unknown field`);
  }
  if (required.some((key) => !Object.hasOwn(body, key))) {
    throw new TypeError(`${path} is missing a required field`);
  }
  return body;
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.length)) {
    throw new TypeError(`XR Workspace ${field} must be a string array`);
  }
  return Object.freeze([...value]);
}

function boundedString(value: unknown, path: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${path} must be a bounded string`);
  }
  return value;
}

function finiteObject<K extends string>(
  value: unknown,
  keys: readonly K[],
  path: string,
  positive = false,
): Record<K, number> {
  const body = exactRecord(value, keys, keys, path);
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const entry = body[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || (positive && entry <= 0)) {
      throw new TypeError(`${path}.${key} must be ${positive ? "positive and " : ""}finite`);
    }
    result[key] = entry;
  }
  return result;
}

function parsePlacement(value: unknown, path: string): WorkspaceRenderComponent["placement"] {
  const base = exactRecord(value, [
    "space", "position", "rotation", "scale", "size", "rotationDeg", "zIndex", "targetId",
    "surface", "offset", "occlusion", "anchor",
  ], ["space"], path);
  const optionalNumber = (key: "rotationDeg" | "zIndex") => {
    const entry = base[key];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) {
      throw new TypeError(`${path}.${key} must be finite`);
    }
  };
  const size = base.size === undefined ? undefined : finiteObject(base.size, ["width", "height"], `${path}.size`, true);
  optionalNumber("rotationDeg");
  optionalNumber("zIndex");
  if (base.space === "world3d") {
    const position = finiteObject(base.position, ["x", "y", "z"], `${path}.position`);
    const rotation = finiteObject(base.rotation, ["x", "y", "z"], `${path}.rotation`);
    const scale = finiteObject(base.scale, ["x", "y", "z"], `${path}.scale`, true);
    return { space: "world3d", position, rotation, scale, ...(size ? { size } : {}) };
  }
  if (base.space === "canvas2d") {
    const position = finiteObject(base.position, ["x", "y"], `${path}.position`);
    return {
      space: "canvas2d",
      position,
      ...(size ? { size } : {}),
      ...(base.rotationDeg === undefined ? {} : { rotationDeg: base.rotationDeg as number }),
      ...(base.zIndex === undefined ? {} : { zIndex: base.zIndex as number }),
    };
  }
  if (base.space === "surface") {
    const offset = finiteObject(base.offset, ["x", "y"], `${path}.offset`);
    return {
      space: "surface",
      targetId: boundedString(base.targetId, `${path}.targetId`),
      surface: boundedString(base.surface, `${path}.surface`),
      offset,
      ...(size ? { size } : {}),
      ...(base.zIndex === undefined ? {} : { zIndex: base.zIndex as number }),
    };
  }
  if (base.space === "billboard") {
    const offset = finiteObject(base.offset, ["x", "y", "z"], `${path}.offset`);
    if (base.occlusion !== undefined
      && !["visible", "hide_when_occluded", "fade_when_occluded"].includes(String(base.occlusion))) {
      throw new TypeError(`${path}.occlusion is invalid`);
    }
    return {
      space: "billboard",
      targetId: boundedString(base.targetId, `${path}.targetId`),
      offset,
      ...(size ? { size } : {}),
      ...(base.occlusion === undefined ? {} : {
        occlusion: base.occlusion as "visible" | "hide_when_occluded" | "fade_when_occluded",
      }),
    };
  }
  if (base.space === "viewport") {
    if (!["top_left", "top", "top_right", "left", "center", "right", "bottom_left", "bottom", "bottom_right"]
      .includes(String(base.anchor))) throw new TypeError(`${path}.anchor is invalid`);
    const offset = finiteObject(base.offset, ["x", "y"], `${path}.offset`);
    return {
      space: "viewport",
      anchor: base.anchor as Extract<WorkspaceRenderComponent["placement"], { space: "viewport" }>["anchor"],
      offset,
      ...(size ? { size } : {}),
      ...(base.zIndex === undefined ? {} : { zIndex: base.zIndex as number }),
    };
  }
  throw new TypeError(`${path}.space is invalid`);
}

function parseVisualEffects(value: unknown, path: string): NonNullable<WorkspaceRenderComponent["visualEffects"]> {
  const body = exactRecord(value, ["opacity", "emissive", "glow"], ["opacity", "emissive", "glow"], path);
  const opacity = body.opacity;
  const emissive = exactRecord(body.emissive, ["color", "intensity"], ["color", "intensity"], `${path}.emissive`);
  const glow = exactRecord(body.glow, ["color", "intensity", "spread"], ["color", "intensity", "spread"], `${path}.glow`);
  const color = (entry: unknown, field: string) => {
    if (typeof entry !== "string" || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u.test(entry)) {
      throw new TypeError(`${field} is invalid`);
    }
    return entry as `#${string}`;
  };
  const number = (entry: unknown, field: string) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) throw new TypeError(`${field} must be finite`);
    return entry;
  };
  return {
    opacity: number(opacity, `${path}.opacity`),
    emissive: {
      color: color(emissive.color, `${path}.emissive.color`),
      intensity: number(emissive.intensity, `${path}.emissive.intensity`),
    },
    glow: {
      color: color(glow.color, `${path}.glow.color`),
      intensity: number(glow.intensity, `${path}.glow.intensity`),
      spread: number(glow.spread, `${path}.glow.spread`),
    },
  };
}

function parseRenderComponent(value: unknown, index: number): WorkspaceRenderComponent {
  const path = `XR Workspace components[${index}]`;
  const body = exactRecord(value, [
    "id", "instanceRevision", "type", "label", "props", "durableState", "placement", "parentId",
    "tags", "visibility", "visualEffects", "locks",
  ], ["id", "type", "label", "props", "durableState", "placement", "tags", "visibility", "locks"], path);
  const type = exactRecord(body.type, ["typeId", "version", "digest"], ["typeId", "version", "digest"], `${path}.type`);
  const props = plainRecord(body.props, `${path}.props`);
  const durableState = plainRecord(body.durableState, `${path}.durableState`);
  const locks = exactRecord(body.locks, [
    "placement", "resize", "visualEffects", "props", "deletion", "actions",
  ], ["placement"], `${path}.locks`);
  if (Object.values(locks).some((entry) => typeof entry !== "boolean")) {
    throw new TypeError(`${path}.locks must contain booleans`);
  }
  if (!Array.isArray(body.tags)
    || body.tags.some((entry) => typeof entry !== "string" || entry.length > 256)
    || new Set(body.tags).size !== body.tags.length) throw new TypeError(`${path}.tags is invalid`);
  if (body.visibility !== "visible" && body.visibility !== "hidden" && body.visibility !== "collapsed") {
    throw new TypeError(`${path}.visibility is invalid`);
  }
  if (body.instanceRevision !== undefined
    && (!Number.isSafeInteger(body.instanceRevision) || Number(body.instanceRevision) < 0)) {
    throw new TypeError(`${path}.instanceRevision is invalid`);
  }
  return Object.freeze({
    id: boundedString(body.id, `${path}.id`),
    ...(body.instanceRevision === undefined ? {} : { instanceRevision: Number(body.instanceRevision) }),
    type: Object.freeze({
      typeId: boundedString(type.typeId, `${path}.type.typeId`),
      version: boundedString(type.version, `${path}.type.version`),
      digest: boundedString(type.digest, `${path}.type.digest`, 512),
    }),
    label: boundedString(body.label, `${path}.label`, 2_000),
    props: structuredClone(props),
    durableState: structuredClone(durableState),
    placement: parsePlacement(body.placement, `${path}.placement`),
    ...(body.parentId === undefined ? {} : { parentId: boundedString(body.parentId, `${path}.parentId`) }),
    tags: Object.freeze([...(body.tags as string[])]),
    visibility: body.visibility,
    ...(body.visualEffects === undefined ? {} : { visualEffects: parseVisualEffects(body.visualEffects, `${path}.visualEffects`) }),
    locks: Object.freeze({ ...(locks as WorkspaceRenderComponent["locks"]) }),
  });
}

function parseComponents(
  value: unknown,
  workspaceId: string,
  revision: number,
  field: string,
): readonly WorkspaceRenderComponent[] {
  if (!Array.isArray(value)) throw new TypeError(`XR Workspace ${field} must be an array`);
  if (value.length > 2_000) throw new TypeError(`XR Workspace ${field} exceeds the component limit`);
  let components: WorkspaceRenderComponent[];
  try {
    components = value.map(parseRenderComponent);
  } catch (cause) {
    throw new TypeError(`XR Workspace ${field} contains an invalid component`, { cause });
  }
  if (new Set(components.map(({ id }) => id)).size !== components.length) {
    throw new TypeError(`XR Workspace ${field} contains duplicate component identities`);
  }
  void workspaceId;
  void revision;
  return Object.freeze(components);
}

function jsonValue(value: unknown, path = "$", ancestors = new Set<object>()): XrJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
    ancestors.add(value);
    const result = value.map((entry, index) => jsonValue(entry, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return Object.freeze(result);
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
    ancestors.add(value);
    const result: Record<string, XrJsonValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      result[key] = jsonValue(entry, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  throw new TypeError(`${path} is not JSON-compatible`);
}

export function canonicalXrJson(value: unknown): string {
  return JSON.stringify(jsonValue(value));
}

export async function digestXrProjection(value: unknown): Promise<`sha256:${string}`> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is required for XR projection digests");
  const bytes = new TextEncoder().encode(canonicalXrJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("")}`;
}

export function toXrWorkspaceProjection(snapshot: WorkspaceRenderSnapshot): XrWorkspaceProjection {
  const components = parseComponents(snapshot.components, snapshot.workspaceId, snapshot.revision, "components");
  const projection: XrWorkspaceProjection = {
    format: XR_WORKSPACE_PROJECTION_FORMAT,
    version: 1,
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    components,
    ...(snapshot.recipes ? { recipes: snapshot.recipes } : {}),
    ...(snapshot.realityAssets ? { realityAssets: snapshot.realityAssets } : {}),
    ...(snapshot.bindingDiagnostics ? { bindingDiagnostics: snapshot.bindingDiagnostics } : {}),
  };
  // Validate before a transport receives it, and return an immutable detached
  // JSON value so later Store renders cannot mutate an in-flight projection.
  return jsonValue(projection) as unknown as XrWorkspaceProjection;
}

/** Strict, detached parser for a renderer received projection payload. */
export function parseXrWorkspaceProjection(value: unknown): XrWorkspaceProjection {
  const cloned = jsonValue(value);
  const body = exactRecord(cloned, PROJECTION_KEYS, ["format", "version", "workspaceId", "revision", "components"]);
  if (body.format !== XR_WORKSPACE_PROJECTION_FORMAT || body.version !== 1) {
    throw new TypeError("XR Workspace projection format is unsupported");
  }
  const workspaceId = parseXrWorkspaceId(body.workspaceId, "$.workspaceId");
  const revision = parseXrRevision(body.revision, "$.revision");
  const components = parseComponents(body.components, workspaceId, revision, "components");
  return Object.freeze({
    format: XR_WORKSPACE_PROJECTION_FORMAT,
    version: 1,
    workspaceId,
    revision,
    components,
    ...(body.recipes === undefined ? {} : { recipes: structuredClone(body.recipes) as NonNullable<WorkspaceRenderSnapshot["recipes"]> }),
    ...(body.realityAssets === undefined ? {} : { realityAssets: structuredClone(body.realityAssets) as NonNullable<WorkspaceRenderSnapshot["realityAssets"]> }),
    ...(body.bindingDiagnostics === undefined ? {} : { bindingDiagnostics: structuredClone(body.bindingDiagnostics) as NonNullable<WorkspaceRenderSnapshot["bindingDiagnostics"]> }),
  });
}

/** Strict, detached parser for a renderer received one-revision delta. */
export function parseXrWorkspaceProjectionDelta(value: unknown): XrWorkspaceProjectionDelta {
  const cloned = jsonValue(value);
  const body = exactRecord(cloned, DELTA_KEYS, [
    "format", "version", "workspaceId", "baseRevision", "revision",
    "added", "updated", "removed", "componentOrder",
  ]);
  if (body.format !== XR_WORKSPACE_DELTA_FORMAT || body.version !== 1) {
    throw new TypeError("XR Workspace delta format is unsupported");
  }
  const workspaceId = parseXrWorkspaceId(body.workspaceId, "$.workspaceId");
  const baseRevision = parseXrRevision(body.baseRevision, "$.baseRevision");
  const revision = parseXrRevision(body.revision, "$.revision");
  if (revision !== baseRevision + 1) throw new TypeError("XR Workspace delta must advance one revision");
  const added = parseComponents(body.added, workspaceId, revision, "added");
  const updated = parseComponents(body.updated, workspaceId, revision, "updated");
  const removed = stringArray(body.removed, "removed");
  const componentOrder = stringArray(body.componentOrder, "componentOrder");
  if (new Set([...added, ...updated].map((component) => component.id)).size !== added.length + updated.length
    || new Set(removed).size !== removed.length
    || new Set(componentOrder).size !== componentOrder.length) {
    throw new TypeError("XR Workspace delta contains duplicate component identities");
  }
  return Object.freeze({
    format: XR_WORKSPACE_DELTA_FORMAT,
    version: 1,
    workspaceId,
    baseRevision,
    revision,
    added,
    updated,
    removed,
    componentOrder,
    ...(body.recipes === undefined ? {} : { recipes: structuredClone(body.recipes) as NonNullable<WorkspaceRenderSnapshot["recipes"]> }),
    ...(body.realityAssets === undefined ? {} : { realityAssets: structuredClone(body.realityAssets) as NonNullable<WorkspaceRenderSnapshot["realityAssets"]> }),
    ...(body.bindingDiagnostics === undefined ? {} : { bindingDiagnostics: structuredClone(body.bindingDiagnostics) as NonNullable<WorkspaceRenderSnapshot["bindingDiagnostics"]> }),
  });
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return canonicalXrJson(left) === canonicalXrJson(right);
}

export function diffXrWorkspaceProjection(
  before: XrWorkspaceProjection,
  after: XrWorkspaceProjection,
): XrWorkspaceProjectionDelta {
  if (before.workspaceId !== after.workspaceId) throw new Error("XR projection Workspace changed");
  if (after.revision !== before.revision + 1) {
    throw new Error("XR projection delta must advance exactly one revision");
  }
  const previous = new Map(before.components.map((component) => [component.id, component]));
  const next = new Map(after.components.map((component) => [component.id, component]));
  const added = after.components.filter((component) => !previous.has(component.id));
  const updated = after.components.filter((component) => {
    const prior = previous.get(component.id);
    return Boolean(prior && !semanticEqual(prior, component));
  });
  const removed = before.components.filter((component) => !next.has(component.id)).map((component) => component.id);
  return jsonValue({
    format: XR_WORKSPACE_DELTA_FORMAT,
    version: 1,
    workspaceId: after.workspaceId,
    baseRevision: before.revision,
    revision: after.revision,
    added,
    updated,
    removed,
    componentOrder: after.components.map((component) => component.id),
    recipes: after.recipes,
    realityAssets: after.realityAssets,
    bindingDiagnostics: after.bindingDiagnostics,
  }) as unknown as XrWorkspaceProjectionDelta;
}

export function applyXrWorkspaceProjectionDelta(
  before: XrWorkspaceProjection,
  delta: XrWorkspaceProjectionDelta,
): XrWorkspaceProjection {
  if (delta.format !== XR_WORKSPACE_DELTA_FORMAT || delta.version !== 1
    || delta.workspaceId !== before.workspaceId || delta.baseRevision !== before.revision
    || delta.revision !== before.revision + 1) {
    throw new Error("XR projection delta does not extend the current projection");
  }
  const components = new Map(before.components.map((component) => [component.id, component]));
  for (const id of delta.removed) components.delete(id);
  for (const component of delta.added) {
    if (components.has(component.id)) throw new Error(`XR projection added duplicate component ${component.id}`);
    components.set(component.id, component);
  }
  for (const component of delta.updated) {
    if (!components.has(component.id)) throw new Error(`XR projection updated missing component ${component.id}`);
    components.set(component.id, component);
  }
  if (delta.componentOrder.length !== components.size || new Set(delta.componentOrder).size !== components.size) {
    throw new Error("XR projection component order is incomplete or duplicated");
  }
  const ordered = delta.componentOrder.map((id) => {
    const component = components.get(id);
    if (!component) throw new Error(`XR projection component order references missing component ${id}`);
    return component;
  });
  return toXrWorkspaceProjection({
    workspaceId: before.workspaceId,
    revision: delta.revision,
    components: ordered,
    recipes: delta.recipes,
    realityAssets: delta.realityAssets,
    bindingDiagnostics: delta.bindingDiagnostics,
  });
}

export function xrProjectionAsJsonObject(value: XrWorkspaceProjection | XrWorkspaceProjectionDelta): XrJsonObject {
  return jsonValue(value) as XrJsonObject;
}
