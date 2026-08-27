import {
  resizePolicyForPlacement,
  type ComponentPlacement,
  type JSONObject,
  type JSONValue,
  type World3DPlacement,
} from "../workspace/components/componentTypes";
import { ComponentRegistry, DEFAULT_COMPONENT_REGISTRY } from "../workspace/components/ComponentRegistry";
import { stableStringify } from "../workspace/components/manifestDigest";
import type { WorkspaceOperation } from "../workspace/protocol/workspaceTypes";
import type { WorkspaceState } from "../workspace/state/workspaceState";
import {
  SEMAFRAME_CHANGE_PROPOSAL_FORMAT,
  SEMAFRAME_CHANGE_PROPOSAL_VERSION,
  SEMAFRAME_EXCHANGE_LIMITS,
  type SemaFrameBridgeChange,
  type SemaFrameBridgeChangeProposal,
  type SemaFrameBridgeProposalReview,
  type SemaFrameBridgeTarget,
  type SemaFrameSha256,
} from "./contracts";

const CHANGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMPONENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TARGETS: readonly SemaFrameBridgeTarget[] = ["blender", "freecad", "unity", "unreal", "custom"];

function deepFreezeParsed<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreezeParsed(child, seen);
  return Object.freeze(value);
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknownKey) throw new TypeError(`${path}.${unknownKey} is not part of the contract`);
  const missingKey = required.find((key) => !Object.hasOwn(record, key));
  if (missingKey) throw new TypeError(`${path}.${missingKey} is required`);
  return record;
}

function boundedString(value: unknown, path: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${path} must be bounded text`);
  }
  return value;
}

function componentId(value: unknown, path: string): string {
  const id = boundedString(value, path);
  if (!COMPONENT_ID_PATTERN.test(id)) throw new TypeError(`${path} is not a valid component ID`);
  return id;
}

function finiteNumber(value: unknown, path: string, positive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new TypeError(`${path} must be ${positive ? "positive and " : ""}finite`);
  }
  return value;
}

function vector<K extends string>(value: unknown, keys: readonly K[], path: string, positive = false): Record<K, number> {
  const record = exactRecord(value, keys, keys, path);
  return Object.fromEntries(keys.map((key) => [key, finiteNumber(record[key], `${path}.${key}`, positive)])) as Record<K, number>;
}

function optionalSize(value: unknown, path: string): { width: number; height: number } | undefined {
  return value === undefined ? undefined : vector(value, ["width", "height"], path, true);
}

function parsePlacement(value: unknown, path: string): ComponentPlacement {
  const body = exactRecord(value, [
    "space", "position", "rotation", "scale", "size", "rotationDeg", "zIndex",
    "targetId", "surface", "offset", "occlusion", "anchor",
  ], ["space"], path);
  const size = optionalSize(body.size, `${path}.size`);
  if (body.space === "world3d") {
    return {
      space: "world3d",
      position: vector(body.position, ["x", "y", "z"], `${path}.position`),
      rotation: vector(body.rotation, ["x", "y", "z"], `${path}.rotation`),
      scale: vector(body.scale, ["x", "y", "z"], `${path}.scale`, true),
      ...(size ? { size } : {}),
    };
  }
  if (body.space === "canvas2d") {
    return {
      space: "canvas2d",
      position: vector(body.position, ["x", "y"], `${path}.position`),
      ...(size ? { size } : {}),
      ...(body.rotationDeg === undefined ? {} : { rotationDeg: finiteNumber(body.rotationDeg, `${path}.rotationDeg`) }),
      ...(body.zIndex === undefined ? {} : { zIndex: finiteNumber(body.zIndex, `${path}.zIndex`) }),
    };
  }
  if (body.space === "surface") {
    return {
      space: "surface",
      targetId: componentId(body.targetId, `${path}.targetId`),
      surface: boundedString(body.surface, `${path}.surface`, 128),
      offset: vector(body.offset, ["x", "y"], `${path}.offset`),
      ...(size ? { size } : {}),
      ...(body.zIndex === undefined ? {} : { zIndex: finiteNumber(body.zIndex, `${path}.zIndex`) }),
    };
  }
  if (body.space === "billboard") {
    if (body.occlusion !== undefined
      && !["visible", "hide_when_occluded", "fade_when_occluded"].includes(String(body.occlusion))) {
      throw new TypeError(`${path}.occlusion is invalid`);
    }
    return {
      space: "billboard",
      targetId: componentId(body.targetId, `${path}.targetId`),
      offset: vector(body.offset, ["x", "y", "z"], `${path}.offset`),
      ...(size ? { size } : {}),
      ...(body.occlusion === undefined ? {} : {
        occlusion: body.occlusion as "visible" | "hide_when_occluded" | "fade_when_occluded",
      }),
    };
  }
  if (body.space === "viewport") {
    const anchors = [
      "top_left", "top", "top_right", "left", "center", "right",
      "bottom_left", "bottom", "bottom_right",
    ] as const;
    if (!anchors.includes(body.anchor as typeof anchors[number])) throw new TypeError(`${path}.anchor is invalid`);
    return {
      space: "viewport",
      anchor: body.anchor as typeof anchors[number],
      offset: vector(body.offset, ["x", "y"], `${path}.offset`),
      ...(size ? { size } : {}),
      ...(body.zIndex === undefined ? {} : { zIndex: finiteNumber(body.zIndex, `${path}.zIndex`) }),
    };
  }
  throw new TypeError(`${path}.space is invalid`);
}

function parseTransition(value: unknown, path: string): { durationMs: number; delayMs?: number; easing: "linear" | "ease_in" | "ease_out" | "ease_in_out" } {
  const body = exactRecord(value, ["durationMs", "delayMs", "easing"], ["durationMs", "easing"], path);
  if (!Number.isSafeInteger(body.durationMs) || Number(body.durationMs) < 0 || Number(body.durationMs) > 60_000) {
    throw new TypeError(`${path}.durationMs is invalid`);
  }
  if (body.delayMs !== undefined
    && (!Number.isSafeInteger(body.delayMs) || Number(body.delayMs) < 0 || Number(body.delayMs) > 60_000)) {
    throw new TypeError(`${path}.delayMs is invalid`);
  }
  const easing = body.easing;
  if (!["linear", "ease_in", "ease_out", "ease_in_out"].includes(String(easing))) {
    throw new TypeError(`${path}.easing is invalid`);
  }
  return {
    durationMs: Number(body.durationMs),
    ...(body.delayMs === undefined ? {} : { delayMs: Number(body.delayMs) }),
    easing: easing as "linear" | "ease_in" | "ease_out" | "ease_in_out",
  };
}

function jsonValue(value: unknown, path: string, depth = 0): JSONValue {
  if (depth > 32) throw new TypeError(`${path} exceeds the maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`, depth + 1));
  const body = exactRecord(value, Object.keys(value as Record<string, unknown>), [], path);
  return Object.fromEntries(Object.entries(body).map(([key, entry]) => [key, jsonValue(entry, `${path}.${key}`, depth + 1)]));
}

function jsonObject(value: unknown, path: string): JSONObject {
  const parsed = jsonValue(value, path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError(`${path} must be a JSON object`);
  return parsed;
}

function parseChange(value: unknown, index: number): SemaFrameBridgeChange {
  const path = `proposal.changes[${index}]`;
  const base = exactRecord(value, [
    "changeId", "kind", "componentId", "placement", "transition", "props",
    "label", "visibility", "tags", "parentComponentId", "transformMode",
  ], ["changeId", "kind", "componentId"], path);
  const changeId = boundedString(base.changeId, `${path}.changeId`, 128);
  if (!CHANGE_ID_PATTERN.test(changeId)) throw new TypeError(`${path}.changeId is invalid`);
  const targetId = componentId(base.componentId, `${path}.componentId`);
  if (base.kind === "transform") {
    exactRecord(value, ["changeId", "kind", "componentId", "placement", "transition"], ["changeId", "kind", "componentId", "placement"], path);
    return Object.freeze({
      changeId,
      kind: "transform",
      componentId: targetId,
      placement: parsePlacement(base.placement, `${path}.placement`),
      ...(base.transition === undefined ? {} : { transition: parseTransition(base.transition, `${path}.transition`) }),
    });
  }
  if (base.kind === "properties") {
    exactRecord(value, ["changeId", "kind", "componentId", "props"], ["changeId", "kind", "componentId", "props"], path);
    return Object.freeze({ changeId, kind: "properties", componentId: targetId, props: jsonObject(base.props, `${path}.props`) });
  }
  if (base.kind === "presentation") {
    exactRecord(value, ["changeId", "kind", "componentId", "label", "visibility", "tags"], ["changeId", "kind", "componentId"], path);
    if (base.label === undefined && base.visibility === undefined && base.tags === undefined) {
      throw new TypeError(`${path} must change label, visibility, or tags`);
    }
    if (base.visibility !== undefined && !["visible", "hidden", "collapsed"].includes(String(base.visibility))) {
      throw new TypeError(`${path}.visibility is invalid`);
    }
    if (base.tags !== undefined && (!Array.isArray(base.tags)
      || base.tags.length > 256
      || base.tags.some((tag) => typeof tag !== "string" || tag.length > 256 || /[\u0000-\u001f\u007f]/u.test(tag))
      || new Set(base.tags).size !== base.tags.length)) {
      throw new TypeError(`${path}.tags is invalid`);
    }
    return Object.freeze({
      changeId,
      kind: "presentation",
      componentId: targetId,
      ...(base.label === undefined ? {} : { label: boundedString(base.label, `${path}.label`, 2_000) }),
      ...(base.visibility === undefined ? {} : { visibility: base.visibility as "visible" | "hidden" | "collapsed" }),
      ...(base.tags === undefined ? {} : { tags: Object.freeze([...(base.tags as string[])]) }),
    });
  }
  if (base.kind === "hierarchy") {
    exactRecord(value, ["changeId", "kind", "componentId", "parentComponentId", "transformMode"], ["changeId", "kind", "componentId", "transformMode"], path);
    if (base.transformMode !== "preserve_local" && base.transformMode !== "preserve_world") {
      throw new TypeError(`${path}.transformMode is invalid`);
    }
    return Object.freeze({
      changeId,
      kind: "hierarchy",
      componentId: targetId,
      ...(base.parentComponentId === undefined ? {} : {
        parentComponentId: componentId(base.parentComponentId, `${path}.parentComponentId`),
      }),
      transformMode: base.transformMode,
    });
  }
  throw new TypeError(`${path}.kind is unsupported`);
}

export function parseSemaFrameBridgeChangeProposal(value: unknown): SemaFrameBridgeChangeProposal {
  let serialized: string;
  try {
    serialized = stableStringify(value);
  } catch {
    throw new TypeError("Bridge change proposal must be acyclic JSON");
  }
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > SEMAFRAME_EXCHANGE_LIMITS.maximumProposalBytes) {
    throw new RangeError("Bridge change proposal exceeds the byte limit");
  }
  const body = exactRecord(value, ["format", "version", "proposalId", "target", "source", "changes", "note"], [
    "format", "version", "proposalId", "target", "source", "changes",
  ], "proposal");
  if (body.format !== SEMAFRAME_CHANGE_PROPOSAL_FORMAT || body.version !== SEMAFRAME_CHANGE_PROPOSAL_VERSION) {
    throw new TypeError("Bridge change proposal format or version is unsupported");
  }
  const proposalId = boundedString(body.proposalId, "proposal.proposalId", 128);
  if (!CHANGE_ID_PATTERN.test(proposalId)) throw new TypeError("proposal.proposalId is invalid");
  if (!TARGETS.includes(body.target as SemaFrameBridgeTarget)) throw new TypeError("proposal.target is invalid");
  const source = exactRecord(body.source, ["workspaceId", "baseRevision", "exchangeDigest"], [
    "workspaceId", "baseRevision", "exchangeDigest",
  ], "proposal.source");
  if (!Number.isSafeInteger(source.baseRevision) || Number(source.baseRevision) < 0) {
    throw new TypeError("proposal.source.baseRevision is invalid");
  }
  if (typeof source.exchangeDigest !== "string" || !SHA256_PATTERN.test(source.exchangeDigest)) {
    throw new TypeError("proposal.source.exchangeDigest must be canonical SHA-256");
  }
  if (!Array.isArray(body.changes) || body.changes.length < 1
    || body.changes.length > SEMAFRAME_EXCHANGE_LIMITS.maximumProposalChanges) {
    throw new TypeError("proposal.changes is outside the supported bounds");
  }
  const changes = Object.freeze(body.changes.map(parseChange));
  if (new Set(changes.map((change) => change.changeId)).size !== changes.length) {
    throw new TypeError("proposal.changes contains duplicate change IDs");
  }
  const note = body.note === undefined
    ? undefined
    : boundedString(body.note, "proposal.note", SEMAFRAME_EXCHANGE_LIMITS.maximumTextLength);
  return deepFreezeParsed({
    format: SEMAFRAME_CHANGE_PROPOSAL_FORMAT,
    version: SEMAFRAME_CHANGE_PROPOSAL_VERSION,
    proposalId,
    target: body.target as SemaFrameBridgeTarget,
    source: Object.freeze({
      workspaceId: boundedString(source.workspaceId, "proposal.source.workspaceId"),
      baseRevision: Number(source.baseRevision),
      exchangeDigest: source.exchangeDigest as SemaFrameSha256,
    }),
    changes,
    ...(note ? { note } : {}),
  });
}

type ProposalIssue = SemaFrameBridgeProposalReview["issues"][number];

function cycleIssues(state: Readonly<WorkspaceState>, changes: readonly SemaFrameBridgeChange[]): ProposalIssue[] {
  const parents = new Map([...state.components.values()].map((component) => [component.id, component.parentId]));
  const hierarchyChanges = changes.filter((change) => change.kind === "hierarchy");
  for (const change of hierarchyChanges) parents.set(change.componentId, change.parentComponentId);
  const issues: ProposalIssue[] = [];
  for (const change of hierarchyChanges) {
    const visited = new Set<string>([change.componentId]);
    let cursor = change.parentComponentId;
    while (cursor) {
      if (visited.has(cursor)) {
        issues.push(Object.freeze({
          changeId: change.changeId,
          code: "hierarchy_cycle",
          message: "The proposed hierarchy contains a cycle.",
        }));
        break;
      }
      visited.add(cursor);
      cursor = parents.get(cursor);
    }
  }
  return issues;
}

const BRIDGE_GEOMETRY_RELATIVE_TOLERANCE = 1e-6;

function bridgeGeometryEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= BRIDGE_GEOMETRY_RELATIVE_TOLERANCE
    * Math.max(1, Math.abs(left), Math.abs(right));
}

function normalizePlacementGeometry(
  current: ComponentPlacement,
  proposed: ComponentPlacement,
): Readonly<{ changed: boolean; placement: ComponentPlacement }> {
  if (current.space !== proposed.space) return { changed: false, placement: structuredClone(proposed) };
  const placement = structuredClone(proposed);
  if (current.size !== undefined || proposed.size !== undefined) {
    if (!current.size || !proposed.size
      || !bridgeGeometryEqual(current.size.width, proposed.size.width)
      || !bridgeGeometryEqual(current.size.height, proposed.size.height)) {
      return { changed: true, placement };
    }
    placement.size = structuredClone(current.size);
  }
  if (current.space === "world3d" && proposed.space === "world3d") {
    if (!bridgeGeometryEqual(current.scale.x, proposed.scale.x)
      || !bridgeGeometryEqual(current.scale.y, proposed.scale.y)
      || !bridgeGeometryEqual(current.scale.z, proposed.scale.z)) {
      return { changed: true, placement };
    }
    (placement as World3DPlacement).scale = structuredClone(current.scale);
  }
  return { changed: false, placement };
}

function placementTargetId(placement: ComponentPlacement): string | undefined {
  return placement.space === "surface" || placement.space === "billboard"
    ? placement.targetId
    : undefined;
}

export type ReviewSemaFrameBridgeProposalOptions = Readonly<{
  expectedExchangeDigest: SemaFrameSha256;
  registry?: ComponentRegistry;
}>;

/** Produce a non-authoritative review. No Workspace state is mutated here. */
export function reviewSemaFrameBridgeProposal(
  value: unknown,
  state: Readonly<WorkspaceState>,
  options: ReviewSemaFrameBridgeProposalOptions,
): SemaFrameBridgeProposalReview {
  const proposal = parseSemaFrameBridgeChangeProposal(value);
  const registry = options.registry ?? DEFAULT_COMPONENT_REGISTRY;
  const issues: ProposalIssue[] = [];
  const normalizedTransformPlacements = new Map<string, ComponentPlacement>();
  const stale = proposal.source.workspaceId !== state.workspaceId
    || proposal.source.baseRevision !== state.revision
    || proposal.source.exchangeDigest !== options.expectedExchangeDigest;
  if (proposal.source.workspaceId !== state.workspaceId) {
    issues.push(Object.freeze({ code: "workspace_mismatch", message: "The proposal targets another Workspace." }));
  }
  if (proposal.source.baseRevision !== state.revision) {
    issues.push(Object.freeze({ code: "stale_revision", message: "The Workspace changed after this exchange was created." }));
  }
  if (proposal.source.exchangeDigest !== options.expectedExchangeDigest) {
    issues.push(Object.freeze({ code: "exchange_digest_mismatch", message: "The proposal does not match the selected exchange artifact." }));
  }
  for (const change of proposal.changes) {
    const component = state.components.get(change.componentId);
    if (!component) {
      issues.push(Object.freeze({ changeId: change.changeId, code: "component_missing", message: "The target component no longer exists." }));
      continue;
    }
    if (change.kind === "transform") {
      if (component.locks.placement) {
        issues.push(Object.freeze({ changeId: change.changeId, code: "placement_locked", message: "Component placement is locked." }));
      }
      if (change.placement.space !== component.placement.space) {
        issues.push(Object.freeze({ changeId: change.changeId, code: "placement_domain_change", message: "A bridge cannot move a component between 2D and 3D placement domains." }));
      }
      const geometry = normalizePlacementGeometry(component.placement, change.placement);
      if (geometry.changed) {
        issues.push(Object.freeze({
          changeId: change.changeId,
          code: "resize_requires_separate_change",
          message: "Scene Bridge transform proposals cannot resize components; keep the exported scale or size.",
        }));
      } else {
        normalizedTransformPlacements.set(change.changeId, geometry.placement);
      }
      const targetId = placementTargetId(change.placement);
      if (targetId && !state.components.has(targetId)) {
        issues.push(Object.freeze({
          changeId: change.changeId,
          code: "placement_target_missing",
          message: "The proposed placement target does not exist.",
        }));
      }
    }
    if (change.kind === "properties") {
      if (component.locks.props) {
        issues.push(Object.freeze({ changeId: change.changeId, code: "properties_locked", message: "Component properties are locked." }));
      } else {
        try {
          const recipe = state.recipes.get(`${component.type.typeId}@${component.type.version}`);
          const effectiveRegistry = recipe
            ? new ComponentRegistry([...registry.list(), ComponentRegistry.manifestFromRecipe(recipe)])
            : registry;
          const manifest = effectiveRegistry.resolve(component.type);
          const nonWritable = Object.keys(change.props).find((key) => !manifest.writableProps.includes(key));
          if (nonWritable) {
            issues.push(Object.freeze({
              changeId: change.changeId,
              code: "property_not_writable",
              message: `Property ${nonWritable} is not writable on ${manifest.typeId}.`,
            }));
          } else if (resizePolicyForPlacement(manifest, component.placement).kind === "stage_dimensions"
            && change.props.dimensions !== undefined) {
            issues.push(Object.freeze({
              changeId: change.changeId,
              code: "resize_requires_separate_change",
              message: "Stage dimensions must be changed with the authoritative resize workflow.",
            }));
          } else {
            effectiveRegistry.assertProps(component.type, {
              ...component.props,
              ...change.props,
            });
          }
        } catch (cause) {
          issues.push(Object.freeze({
            changeId: change.changeId,
            code: "invalid_properties",
            message: cause instanceof Error ? cause.message : "Proposed properties are invalid.",
          }));
        }
      }
    }
    if (change.kind === "presentation" && component.locks.props) {
      issues.push(Object.freeze({ changeId: change.changeId, code: "presentation_locked", message: "Component metadata is locked." }));
    }
    if (change.kind === "hierarchy") {
      if (component.locks.placement) {
        issues.push(Object.freeze({ changeId: change.changeId, code: "placement_locked", message: "Component hierarchy is placement-locked." }));
      }
      if (change.parentComponentId && !state.components.has(change.parentComponentId)) {
        issues.push(Object.freeze({ changeId: change.changeId, code: "parent_missing", message: "The proposed parent does not exist." }));
      }
      if (change.parentComponentId === change.componentId) {
        issues.push(Object.freeze({ changeId: change.changeId, code: "hierarchy_cycle", message: "A component cannot parent itself." }));
      }
      if (change.transformMode === "preserve_world") {
        const parent = change.parentComponentId
          ? state.components.get(change.parentComponentId)
          : undefined;
        if (component.placement.space !== "world3d"
          || (change.parentComponentId !== undefined && parent?.placement.space !== "world3d")) {
          issues.push(Object.freeze({
            changeId: change.changeId,
            code: "preserve_world_requires_3d",
            message: "Preserving world transforms requires a world3d child and, when attaching, a world3d parent.",
          }));
        }
      }
    }
  }
  issues.push(...cycleIssues(state, proposal.changes));
  const reviewedProposal: SemaFrameBridgeChangeProposal = normalizedTransformPlacements.size === 0
    ? proposal
    : Object.freeze({
        ...proposal,
        changes: Object.freeze(proposal.changes.map((change) => change.kind === "transform"
          && normalizedTransformPlacements.has(change.changeId)
          ? Object.freeze({
              ...change,
              placement: normalizedTransformPlacements.get(change.changeId)!,
            })
          : change)),
      });
  const ineligible = new Set(issues.flatMap((issue) => issue.changeId ? [issue.changeId] : []));
  const eligible = stale ? [] : proposal.changes.filter((change) => !ineligible.has(change.changeId)).map((change) => change.changeId);
  return deepFreezeParsed({
    proposal: reviewedProposal,
    status: "review_required",
    stale,
    issues: Object.freeze(issues),
    eligibleChangeIds: Object.freeze(eligible),
    ineligibleChangeIds: Object.freeze([...ineligible].sort()),
  });
}

/**
 * Translate only explicitly approved, eligible changes into normal Workspace
 * operations. The caller must still use begin_workspace_update and
 * submit_workspace_batch, so collision/layout/permission/revision checks remain
 * authoritative.
 */
export function approvedBridgeChangesToWorkspaceOperations(
  review: SemaFrameBridgeProposalReview,
  approvedChangeIds: readonly string[],
): readonly WorkspaceOperation[] {
  if (review.stale) throw new TypeError("A stale bridge proposal cannot be prepared for commit");
  if (new Set(approvedChangeIds).size !== approvedChangeIds.length) {
    throw new TypeError("Approved bridge change IDs must be unique");
  }
  const eligible = new Set(review.eligibleChangeIds);
  const unknown = approvedChangeIds.find((id) => !eligible.has(id));
  if (unknown) throw new TypeError(`Bridge change ${unknown} is not eligible for commit`);
  const approved = new Set(approvedChangeIds);
  return Object.freeze(review.proposal.changes
    .filter((change) => approved.has(change.changeId))
    .map((change, index): WorkspaceOperation => {
      const opId = `bridge:${review.proposal.proposalId}:${index + 1}`;
      if (change.kind === "transform") {
        return {
          op: "place_component",
          op_id: opId,
          id: change.componentId,
          placement: structuredClone(change.placement),
          ...(change.transition ? { transition: structuredClone(change.transition) } : {}),
        };
      }
      if (change.kind === "properties") {
        return {
          op: "update_component",
          op_id: opId,
          id: change.componentId,
          patch: { props: structuredClone(change.props) },
        };
      }
      if (change.kind === "presentation") {
        return {
          op: "update_component",
          op_id: opId,
          id: change.componentId,
          patch: {
            ...(change.label === undefined ? {} : { label: change.label }),
            ...(change.visibility === undefined ? {} : { visibility: change.visibility }),
            ...(change.tags === undefined ? {} : { tags: [...change.tags] }),
          },
        };
      }
      return change.parentComponentId
        ? {
            op: "attach_component",
            op_id: opId,
            child_id: change.componentId,
            parent_id: change.parentComponentId,
            transform_mode: change.transformMode,
          }
        : {
            op: "detach_component",
            op_id: opId,
            child_id: change.componentId,
            transform_mode: change.transformMode,
          };
    }));
}
