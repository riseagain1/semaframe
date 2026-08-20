import type { ComponentInstance, ComponentPlacement, JSONObject, Vec3, World3DPlacement } from "../components/componentTypes";
import {
  buildSemaFrameSpatialGraph,
  cloneStateWithSpatialCandidate,
  convexHull2,
  groundContactPatches,
  horizontalExtremeFace,
  intersectConvexPolygons,
  partIntersectsGroundVolume,
  polygonArea2,
  querySpatialPlacement,
  supportContactPatches,
  verticalSupportGaps,
  type SpatialPlacementCandidate,
  type SpatialPoint2,
  type SemaFrameSpatialGraphNode,
} from "../spatial";
import type { WorkspaceState } from "../state/workspaceState";
import { effectiveSpatialPhysicsConfig } from "./physicsConfig";
import {
  WORKSPACE_PHYSICS_VERSION,
  type PhysicsBodyReport,
  type PhysicsConstraint,
  type PhysicsIssue,
  type PhysicsSettleProposal,
  type PhysicsSettleResult,
  type PhysicsValidationReport,
  type SpatialPhysicsConfig,
} from "./physicsTypes";

const CONTACT_TOLERANCE_M = 0.03;
const CONSTRAINT_ANCHOR_TOLERANCE_M = 0.05;
const EPSILON = 1e-7;
const GRAVITY_M_S2 = 9.81;

type Point2 = SpatialPoint2;

type GroundSurface = Readonly<{
  height: number;
  polygon: readonly Point2[];
}>;

function add(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value: Vec3, amount: number): Vec3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function multiply(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x * right.x, y: left.y * right.y, z: left.z * right.z };
}

function length(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function rotate(quaternion: Readonly<{ x: number; y: number; z: number; w: number }>, value: Vec3): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = quaternion;
  const ix = qw * value.x + qy * value.z - qz * value.y;
  const iy = qw * value.y + qz * value.x - qx * value.z;
  const iz = qw * value.z + qx * value.y - qy * value.x;
  const iw = -qx * value.x - qy * value.y - qz * value.z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

function signedMargin(point: Point2, polygon: readonly Point2[]): number | null {
  if (polygon.length < 3) return null;
  let inside = true;
  let margin = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]!;
    const end = polygon[(index + 1) % polygon.length]!;
    const edgeX = end.x - start.x;
    const edgeZ = end.z - start.z;
    const edgeLength = Math.hypot(edgeX, edgeZ);
    if (edgeLength <= EPSILON) continue;
    const signed = (edgeX * (point.z - start.z) - edgeZ * (point.x - start.x)) / edgeLength;
    if (signed < -EPSILON) inside = false;
    margin = Math.min(margin, Math.abs(signed));
  }
  return Number.isFinite(margin) ? (inside ? margin : -margin) : null;
}

function stageGroundSurface(state: Readonly<WorkspaceState>): GroundSurface | undefined {
  const stage = [...state.components.values()].find((component) =>
    component.type.typeId === "stage-3d" && component.visibility === "visible");
  if (!stage) return undefined;
  const dimensions = stage.props.dimensions;
  const record = dimensions && typeof dimensions === "object" && !Array.isArray(dimensions)
    ? dimensions as Record<string, unknown>
    : undefined;
  const width = typeof record?.width === "number" && Number.isFinite(record.width) && record.width > 0
    ? record.width
    : 12;
  const depth = typeof record?.depth === "number" && Number.isFinite(record.depth) && record.depth > 0
    ? record.depth
    : 10;
  // The renderer treats Stage as the Workspace world basis at y=0; Stage
  // placement is not a movable physical object.
  return {
    height: 0,
    polygon: [
      { x: -width / 2, z: -depth / 2 },
      { x: width / 2, z: -depth / 2 },
      { x: width / 2, z: depth / 2 },
      { x: -width / 2, z: depth / 2 },
    ],
  };
}

function hasSolidPhysicsCollider(node: SemaFrameSpatialGraphNode): boolean {
  return node.visibility === "visible"
    && node.physics?.enabled === true
    && node.collision?.enabled === true
    && node.collision.role === "solid";
}

function worldPoint(node: SemaFrameSpatialGraphNode, local: Vec3): Vec3 {
  return add(node.worldTransform.position, rotate(
    node.worldTransform.rotationQuaternion,
    multiply(local, node.worldTransform.scale),
  ));
}

type ConstraintAnalysis = Readonly<{
  issues: readonly PhysicsIssue[];
  valid: readonly PhysicsConstraint[];
}>;

function analyzeConstraints(
  node: SemaFrameSpatialGraphNode,
  constraints: readonly PhysicsConstraint[],
  byId: ReadonlyMap<string, SemaFrameSpatialGraphNode>,
): ConstraintAnalysis {
  const issues: PhysicsIssue[] = [];
  const valid: PhysicsConstraint[] = [];
  for (const constraint of constraints.filter((entry) => entry.enabled).sort((a, b) => a.id.localeCompare(b.id))) {
    const target = byId.get(constraint.targetId);
    let invalid = false;
    if (!target || target.id === node.id) {
      issues.push({
        code: "constraint_target_missing",
        componentId: node.id,
        relatedComponentId: constraint.targetId,
        constraintId: constraint.id,
        message: `Constraint ${constraint.id} has no valid spatial target`,
      });
      continue;
    }
    if ((constraint.type === "hinge" || constraint.type === "slider")
      && Math.abs(length(constraint.axis) - 1) > 0.01) {
      issues.push({
        code: "constraint_axis_invalid",
        componentId: node.id,
        relatedComponentId: target.id,
        constraintId: constraint.id,
        message: `Constraint ${constraint.id} axis must be normalized`,
      });
      invalid = true;
    }
    const gap = length(subtract(worldPoint(node, constraint.anchor), worldPoint(target, constraint.targetAnchor)));
    if (gap > CONSTRAINT_ANCHOR_TOLERANCE_M) {
      issues.push({
        code: "constraint_anchor_gap",
        componentId: node.id,
        relatedComponentId: target.id,
        constraintId: constraint.id,
        message: `Constraint ${constraint.id} anchors are ${gap.toFixed(3)} m apart`,
      });
      invalid = true;
    }
    if (!invalid) valid.push(constraint);
  }
  return { issues, valid };
}

function cross3(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

/** Conservative equilibrium check for the remaining joint degree of freedom. */
function constraintHoldsAgainstGravity(
  node: SemaFrameSpatialGraphNode,
  centerOfMassWorld: Vec3,
  physics: SpatialPhysicsConfig,
  constraint: PhysicsConstraint,
): boolean {
  if (physics.gravityScale === 0 || constraint.type === "fixed") return true;
  const anchor = worldPoint(node, constraint.anchor);
  const axis = rotate(node.worldTransform.rotationQuaternion, constraint.axis);
  const axisLength = length(axis);
  const normalizedAxis = axisLength <= EPSILON ? { x: 0, y: 0, z: 0 } : scale(axis, 1 / axisLength);
  if (constraint.type === "slider") {
    // A vertical component leaves an unconstrained gravity lane.
    return Math.abs(normalizedAxis.y) <= 0.01;
  }
  const lever = subtract(centerOfMassWorld, anchor);
  if (constraint.type === "ball") {
    // A ball joint is in static equilibrium only when COM is vertically below
    // the anchor. Otherwise it will rotate until that condition is reached.
    return Math.hypot(lever.x, lever.z) <= CONTACT_TOLERANCE_M;
  }
  const gravityForce = { x: 0, y: -physics.massKg * GRAVITY_M_S2 * physics.gravityScale, z: 0 };
  const torqueAboutHinge = Math.abs(dot(cross3(lever, gravityForce), normalizedAxis));
  const tolerance = Math.max(1e-6, physics.massKg * GRAVITY_M_S2 * 0.001);
  return torqueAboutHinge <= tolerance;
}

type RawBodyAnalysis = Readonly<{
  node: SemaFrameSpatialGraphNode;
  physics: SpatialPhysicsConfig;
  centerOfMassWorld: Vec3;
  constraintAnalysis: ConstraintAnalysis;
  groundPatches: ReturnType<typeof groundContactPatches>;
  supportPatches: ReadonlyMap<string, ReturnType<typeof supportContactPatches>>;
  penetratingGround: boolean;
}>;

type StabilityResolution = Readonly<{
  stable: boolean;
  grounded: boolean;
  stabilityReason: PhysicsBodyReport["stabilityReason"];
  supportPolygon: readonly Point2[];
  stabilityMarginM: number | null;
  supports: PhysicsBodyReport["supports"];
}>;

function lowerBoundByHeight(entries: readonly Readonly<{ height: number; id: string }>[], value: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]!.height < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function buildPhysicsValidationReport(state: Readonly<WorkspaceState>): PhysicsValidationReport {
  const space = buildSemaFrameSpatialGraph(state, { maxNodes: 2_000 });
  const nodes = [...space.nodes]
    .filter((node) => node.visibility === "visible" && node.physics !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ground = stageGroundSurface(state);
  const collisionIds = new Set(space.collisionConflicts.flatMap((conflict) => [conflict.componentId, conflict.conflictsWith]));
  const issues: PhysicsIssue[] = [];
  const issueKeys = new Set<string>();
  const pushIssue = (issue: PhysicsIssue): void => {
    const key = `${issue.componentId}:${issue.code}:${issue.relatedComponentId ?? ""}:${issue.constraintId ?? ""}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };
  for (const conflict of space.collisionConflicts) {
    pushIssue({
      code: "collision",
      componentId: conflict.componentId,
      relatedComponentId: conflict.conflictsWith,
      message: `${conflict.componentId} intersects ${conflict.conflictsWith}`,
    });
    pushIssue({
      code: "collision",
      componentId: conflict.conflictsWith,
      relatedComponentId: conflict.componentId,
      message: `${conflict.conflictsWith} intersects ${conflict.componentId}`,
    });
  }
  if (space.omittedNodeCount > 0) pushIssue({
    code: "capacity_exceeded",
    componentId: "__workspace__",
    message: `Physics validation is capped at 2000 spatial bodies; ${space.omittedNodeCount} were omitted`,
  });
  if (space.collisionConflictsTruncated) pushIssue({
    code: "capacity_exceeded",
    componentId: "__workspace__",
    message: "Physics collision reporting exceeded 10000 conflicts and was truncated",
  });

  const eligible = nodes.filter(hasSolidPhysicsCollider);
  const topEntries = eligible.flatMap((node) => node.collision!.parts.map((part) => ({
    id: node.id,
    height: part.aabb.max.y,
  }))).sort((left, right) => left.height - right.height || left.id.localeCompare(right.id));
  const analyses = new Map<string, RawBodyAnalysis>();

  for (const node of nodes) {
    const component = state.components.get(node.id)!;
    const physics = effectiveSpatialPhysicsConfig(component.props);
    const baseCenter = node.collision?.aabb.center ?? node.worldBounds.center;
    const centerOfMassWorld = add(baseCenter, rotate(
      node.worldTransform.rotationQuaternion,
      multiply(physics.centerOfMass, node.worldTransform.scale),
    ));
    const constraintAnalysis = physics.enabled
      ? analyzeConstraints(node, physics.constraints, byId)
      : { issues: [], valid: [] };
    for (const issue of constraintAnalysis.issues) pushIssue(issue);
    if (physics.enabled && !hasSolidPhysicsCollider(node)) pushIssue({
      code: "collider_missing",
      componentId: node.id,
      message: `${node.id} requires an enabled solid collider for physics validation`,
    });
    const penetratingGround = physics.enabled && Boolean(ground && node.collision?.parts.some((part) =>
      partIntersectsGroundVolume(part, ground.polygon, ground.height, CONTACT_TOLERANCE_M)));
    if (penetratingGround) pushIssue({
      code: "ground_penetration",
      componentId: node.id,
      message: `${node.id} penetrates the finite Stage ground volume`,
    });
    const groundPatches = physics.enabled && hasSolidPhysicsCollider(node) && ground && !penetratingGround
      ? groundContactPatches(node, ground.polygon, ground.height, CONTACT_TOLERANCE_M)
      : [];
    const lowerIds = new Set<string>();
    if (hasSolidPhysicsCollider(node)) {
      for (const part of node.collision!.parts) {
        const start = lowerBoundByHeight(topEntries, part.aabb.min.y - CONTACT_TOLERANCE_M);
        for (let index = start; index < topEntries.length; index += 1) {
          const entry = topEntries[index]!;
          if (entry.height > part.aabb.min.y + CONTACT_TOLERANCE_M) break;
          if (entry.id !== node.id) lowerIds.add(entry.id);
        }
      }
    }
    const supportPatches = new Map<string, ReturnType<typeof supportContactPatches>>();
    for (const lowerId of [...lowerIds].sort((left, right) => left.localeCompare(right))) {
      const lower = byId.get(lowerId)!;
      const patches = supportContactPatches(node, lower, CONTACT_TOLERANCE_M);
      if (patches.length) supportPatches.set(lowerId, patches);
    }
    analyses.set(node.id, {
      node,
      physics,
      centerOfMassWorld,
      constraintAnalysis,
      groundPatches,
      supportPatches,
      penetratingGround,
    });
  }

  const resolved = new Map<string, StabilityResolution>();
  const resolve = (id: string, visiting = new Set<string>()): StabilityResolution => {
    const existing = resolved.get(id);
    if (existing) return existing;
    const analysis = analyses.get(id)!;
    const { node, physics, centerOfMassWorld } = analysis;
    const empty: StabilityResolution = {
      stable: false,
      grounded: false,
      stabilityReason: "unsupported",
      supportPolygon: [],
      stabilityMarginM: null,
      supports: [],
    };
    if (visiting.has(id)) return empty;
    const nextVisiting = new Set(visiting).add(id);
    let result: StabilityResolution;
    if (collisionIds.has(id)) {
      result = { ...empty, stabilityReason: "collision" };
    } else if (!physics.enabled) {
      result = { ...empty, stable: true, stabilityReason: "disabled" };
    } else if (!hasSolidPhysicsCollider(node)) {
      result = { ...empty, stabilityReason: "collider_missing" };
    } else if (analysis.penetratingGround) {
      result = { ...empty, stabilityReason: "penetrating" };
    } else if (analysis.constraintAnalysis.issues.length) {
      result = empty;
    } else if (physics.bodyType === "static") {
      result = { ...empty, stable: true, grounded: true, stabilityReason: "anchored" };
    } else if (physics.bodyType === "kinematic") {
      result = { ...empty, stable: true, grounded: true, stabilityReason: "driven" };
    } else if (physics.gravityScale === 0) {
      result = { ...empty, stable: true, stabilityReason: "weightless" };
    } else {
      const supportPoints: Point2[] = [];
      const supports: PhysicsBodyReport["supports"][number][] = [];
      for (const patch of analysis.groundPatches) supportPoints.push(...patch.points);
      if (analysis.groundPatches.length) supports.push({
        componentId: id,
        kind: "ground",
        contactHeight: ground!.height,
        contactAreaM2: analysis.groundPatches.reduce((total, patch) => total + patch.areaM2, 0),
        grounded: true,
      });
      for (const [lowerId, patches] of analysis.supportPatches) {
        const lower = resolve(lowerId, nextVisiting);
        if (!lower.stable || !lower.grounded) continue;
        for (const patch of patches) supportPoints.push(...patch.points);
        supports.push({
          componentId: id,
          kind: "component",
          supportingComponentId: lowerId,
          contactHeight: Math.max(...patches.map((patch) => patch.height)),
          contactAreaM2: patches.reduce((total, patch) => total + patch.areaM2, 0),
          grounded: true,
        });
      }
      let constrained = false;
      const unstableConstraints: PhysicsConstraint[] = [];
      for (const constraint of analysis.constraintAnalysis.valid) {
        const target = resolve(constraint.targetId, nextVisiting);
        if (!target.stable || !target.grounded) continue;
        if (constraintHoldsAgainstGravity(node, centerOfMassWorld, physics, constraint)) constrained = true;
        else unstableConstraints.push(constraint);
      }
      const supportPolygon = convexHull2(supportPoints);
      const stabilityMarginM = signedMargin({ x: centerOfMassWorld.x, z: centerOfMassWorld.z }, supportPolygon);
      if (constrained) {
        result = { stable: true, grounded: true, stabilityReason: "constrained", supportPolygon, stabilityMarginM, supports };
      } else if (!supports.length || stabilityMarginM === null) {
        pushIssue({ code: "unsupported", componentId: id, message: `${id} has no grounded support load path` });
        for (const constraint of unstableConstraints) pushIssue({
          code: "constraint_unstable",
          componentId: id,
          relatedComponentId: constraint.targetId,
          constraintId: constraint.id,
          message: `Constraint ${constraint.id} leaves an unstable gravity degree of freedom`,
        });
        result = empty;
      } else if (stabilityMarginM < -EPSILON) {
        pushIssue({ code: "tip_risk", componentId: id, message: `${id} center of mass lies outside its grounded support polygon` });
        result = { stable: false, grounded: false, stabilityReason: "tip_risk", supportPolygon, stabilityMarginM, supports };
      } else {
        result = { stable: true, grounded: true, stabilityReason: "supported", supportPolygon, stabilityMarginM, supports };
      }
    }
    resolved.set(id, result);
    return result;
  };

  const bodies = nodes.map((node): PhysicsBodyReport => {
    const analysis = analyses.get(node.id)!;
    const stability = resolve(node.id);
    return {
      componentId: node.id,
      enabled: analysis.physics.enabled,
      bodyType: analysis.physics.bodyType,
      massKg: analysis.physics.massKg,
      massSource: "explicit",
      ...(node.physics?.geometryVolumeM3 === undefined
        ? {}
        : { geometryVolumeM3: node.physics.geometryVolumeM3 }),
      centerOfMassWorld: analysis.centerOfMassWorld,
      friction: analysis.physics.friction,
      restitution: analysis.physics.restitution,
      gravityScale: analysis.physics.gravityScale,
      stabilityMode: analysis.physics.stabilityMode,
      stable: stability.stable,
      grounded: stability.grounded,
      stabilityReason: stability.stabilityReason,
      supportPolygon: stability.supportPolygon,
      stabilityMarginM: stability.stabilityMarginM,
      supports: stability.supports,
      constraints: structuredClone(analysis.physics.constraints),
    };
  });
  const sortedIssues = issues.sort((left, right) => left.componentId.localeCompare(right.componentId)
    || left.code.localeCompare(right.code) || (left.constraintId ?? "").localeCompare(right.constraintId ?? ""));
  const report: PhysicsValidationReport = {
    format: "workspace-physics-report",
    version: WORKSPACE_PHYSICS_VERSION,
    model: "quasi_static_rigid_support_v2",
    workspaceId: state.workspaceId,
    workspaceRevision: state.revision,
    feasible: sortedIssues.length === 0,
    bodies,
    issues: sortedIssues,
  };
  return report;
}

function cloneState(state: Readonly<WorkspaceState>): WorkspaceState {
  return {
    ...state,
    components: new Map([...state.components].map(([id, component]) => [id, structuredClone(component)])),
    resources: new Map([...state.resources].map(([id, resource]) => [id, structuredClone(resource)])),
    connections: new Map([...state.connections].map(([id, connection]) => [id, structuredClone(connection)])),
    aliases: new Map(state.aliases),
    sharedViews: new Map([...state.sharedViews].map(([id, view]) => [id, structuredClone(view)])),
    recipes: new Map([...state.recipes].map(([id, recipe]) => [id, structuredClone(recipe)])),
    history: structuredClone(state.history),
  };
}

function minimumVerticalDropGap(
  node: SemaFrameSpatialGraphNode,
  groundedNodes: readonly SemaFrameSpatialGraphNode[],
  ground: GroundSurface | undefined,
): number | undefined {
  if (!node.collision) return undefined;
  const gaps: number[] = [];
  if (ground) {
    for (const part of node.collision.parts) {
      const face = horizontalExtremeFace(part, "bottom");
      if (polygonArea2(intersectConvexPolygons(face, ground.polygon)) <= EPSILON) continue;
      // Collision margin is contact tolerance around the rendered solid, not
      // a reason to leave a visible ground-centered asset hovering.
      const gap = part.aabb.min.y - (ground.height - node.collision.margin);
      if (gap >= -CONTACT_TOLERANCE_M) gaps.push(Math.max(0, gap));
    }
  }
  for (const lower of groundedNodes) {
    for (const gap of verticalSupportGaps(node, lower)) {
      if (gap >= -CONTACT_TOLERANCE_M) gaps.push(Math.max(0, gap));
    }
  }
  return gaps.length ? Math.min(...gaps) : undefined;
}

export function simulatePhysicsSettle(
  state: Readonly<WorkspaceState>,
  options: Readonly<{ componentIds?: readonly string[]; durationMs?: number; timeStepMs?: number }> = {},
): PhysicsSettleResult {
  const durationMs = Math.max(0, Math.min(5_000, Math.trunc(options.durationMs ?? 2_000)));
  const timeStepMs = Math.max(4, Math.min(100, Math.trunc(options.timeStepMs ?? 16)));
  const appliedSteps = durationMs === 0 ? 0 : Math.ceil(durationMs / timeStepMs);
  const selected = options.componentIds ? new Set(options.componentIds) : undefined;
  const working = cloneState(state);
  const proposals: PhysicsSettleProposal[] = [];
  const initialSpace = buildSemaFrameSpatialGraph(working);
  const nodes = [...initialSpace.nodes].filter((node) => node.physics !== undefined)
    .sort((left, right) => left.worldBounds.min.y - right.worldBounds.min.y
    || left.id.localeCompare(right.id));

  for (const node of nodes) {
    if (selected && !selected.has(node.id)) continue;
    const component = working.components.get(node.id)!;
    const physics = effectiveSpatialPhysicsConfig(component.props);
    if (!physics.enabled || physics.bodyType !== "dynamic" || component.placement.space !== "world3d") continue;
    const from = structuredClone(component.placement);
    const currentSpace = buildSemaFrameSpatialGraph(working, { maxNodes: 2_000 });
    const currentNode = currentSpace.nodes.find((entry) => entry.id === node.id);
    const currentReport = buildPhysicsValidationReport(working);
    const currentBody = currentReport.bodies.find((entry) => entry.componentId === node.id);
    if (!currentNode || !hasSolidPhysicsCollider(currentNode)) {
      proposals.push({ componentId: node.id, from, to: structuredClone(from), dropDistanceM: 0, settled: false });
      continue;
    }
    if (physics.gravityScale === 0 || currentBody?.stabilityReason === "constrained"
      || (currentBody?.stable && currentBody.grounded)) {
      proposals.push({ componentId: node.id, from, to: structuredClone(from), dropDistanceM: 0, settled: true });
      continue;
    }
    if (component.parentId) {
      // A local parent basis can rotate the gravity axis. This conservative
      // vertical preview refuses to invent a local-space correction.
      proposals.push({ componentId: node.id, from, to: structuredClone(from), dropDistanceM: 0, settled: false });
      continue;
    }
    const groundedIds = new Set(currentReport.bodies
      .filter((body) => body.componentId !== node.id && body.stable && body.grounded)
      .map((body) => body.componentId));
    const groundedNodes = currentSpace.nodes.filter((entry) => groundedIds.has(entry.id) && hasSolidPhysicsCollider(entry));
    const gap = minimumVerticalDropGap(currentNode, groundedNodes, stageGroundSurface(working));
    if (gap === undefined) {
      proposals.push({ componentId: node.id, from, to: structuredClone(from), dropDistanceM: 0, settled: false });
      continue;
    }
    let drop = 0;
    let velocity = 0;
    let settled = gap <= CONTACT_TOLERANCE_M;
    for (let step = 0; step < appliedSteps && !settled; step += 1) {
      const elapsedMs = step * timeStepMs;
      const dt = Math.min(timeStepMs, durationMs - elapsedMs) / 1_000;
      velocity += GRAVITY_M_S2 * physics.gravityScale * dt;
      const nextDrop = velocity * dt;
      if (drop + nextDrop >= gap) {
        drop = gap;
        settled = true;
      } else {
        drop += nextDrop;
      }
    }
    const to: World3DPlacement = {
      ...structuredClone(component.placement),
      position: { ...component.placement.position, y: component.placement.position.y - drop },
    };
    working.components.set(component.id, { ...component, placement: to });
    proposals.push({ componentId: node.id, from, to: structuredClone(to), dropDistanceM: drop, settled });
  }
  const report = buildPhysicsValidationReport(working);
  const incomplete = proposals.filter((proposal) => !proposal.settled).map((proposal): PhysicsIssue => ({
    code: "settle_incomplete",
    componentId: proposal.componentId,
    message: `${proposal.componentId} did not settle within ${durationMs} ms`,
  }));
  const mergedReport: PhysicsValidationReport = incomplete.length ? {
    ...report,
    feasible: false,
    issues: [...report.issues, ...incomplete],
  } : report;
  return {
    format: "workspace-physics-settle",
    version: WORKSPACE_PHYSICS_VERSION,
    model: "quasi_static_vertical_drop_v2",
    workspaceId: state.workspaceId,
    workspaceRevision: state.revision,
    durationMs,
    timeStepMs,
    appliedSteps,
    modeledProperties: ["gravity_scale", "solid_collision_geometry", "grounded_supports", "fixed_step_time"],
    ignoredProperties: ["mass_kg", "friction", "restitution", "angular_motion"],
    mutatesWorkspace: false,
    feasible: mergedReport.feasible,
    proposals,
    report: mergedReport,
  };
}

export type PhysicsPlacementCandidate = SpatialPlacementCandidate & Readonly<{ physics?: SpatialPhysicsConfig }>;

function stageContainmentSuggestion(
  state: Readonly<WorkspaceState>,
  componentId: string,
): ComponentPlacement | undefined {
  const component = state.components.get(componentId);
  if (!component || component.placement.space !== "world3d") return undefined;
  const snapshot = buildSemaFrameSpatialGraph(state, { maxNodes: 2_000 });
  const node = snapshot.nodes.find((entry) => entry.id === componentId);
  const stage = snapshot.stage;
  if (!node?.collision || !stage || stage.visibility !== "visible") return undefined;
  const stageMinX = Math.min(...stage.groundPolygon.map((point) => point.x));
  const stageMaxX = Math.max(...stage.groundPolygon.map((point) => point.x));
  const stageMinZ = Math.min(...stage.groundPolygon.map((point) => point.z));
  const stageMaxZ = Math.max(...stage.groundPolygon.map((point) => point.z));
  const bounds = node.collision.aabb;
  if (bounds.size.x > stageMaxX - stageMinX || bounds.size.z > stageMaxZ - stageMinZ) return undefined;
  let offsetX = 0;
  let offsetZ = 0;
  if (bounds.min.x < stageMinX) offsetX = stageMinX - bounds.min.x;
  else if (bounds.max.x > stageMaxX) offsetX = stageMaxX - bounds.max.x;
  if (bounds.min.z < stageMinZ) offsetZ = stageMinZ - bounds.min.z;
  else if (bounds.max.z > stageMaxZ) offsetZ = stageMaxZ - bounds.max.z;
  if (Math.abs(offsetX) <= EPSILON && Math.abs(offsetZ) <= EPSILON) return undefined;
  return {
    ...structuredClone(component.placement),
    position: {
      ...component.placement.position,
      x: component.placement.position.x + offsetX,
      z: component.placement.position.z + offsetZ,
    },
  };
}

export function queryStablePlacement(state: Readonly<WorkspaceState>, candidate: PhysicsPlacementCandidate) {
  const collisionCheck = querySpatialPlacement(state, candidate);
  const prepared = cloneStateWithSpatialCandidate(state, candidate);
  if (candidate.physics) {
    const component = prepared.state.components.get(prepared.candidateId)!;
    prepared.state.components.set(component.id, {
      ...component,
      props: { ...component.props, physics: structuredClone(candidate.physics) as unknown as JSONObject },
    });
  }
  const report = buildPhysicsValidationReport(prepared.state);
  const body = report.bodies.find((entry) => entry.componentId === prepared.candidateId);
  const settle = simulatePhysicsSettle(prepared.state, { componentIds: [prepared.candidateId] });
  const settleProposal = settle.proposals.find((entry) => entry.componentId === prepared.candidateId);
  const suggestedPlacements: ComponentPlacement[] = [];
  const addSuggestion = (placement: ComponentPlacement) => {
    if (!suggestedPlacements.some((entry) => JSON.stringify(entry) === JSON.stringify(placement))) {
      suggestedPlacements.push(structuredClone(placement));
    }
  };
  if (collisionCheck.valid && body && !body.stable && settleProposal?.settled
    && settle.report.bodies.find((entry) => entry.componentId === prepared.candidateId)?.stable
    && JSON.stringify(settleProposal.to) !== JSON.stringify(settleProposal.from)) {
    addSuggestion(settleProposal.to);
  }
  const placementCandidates = [...collisionCheck.suggestedPlacements];
  const stageSuggestion = stageContainmentSuggestion(prepared.state, prepared.candidateId);
  if (stageSuggestion) placementCandidates.push(stageSuggestion);
  for (const placement of placementCandidates) {
    const nextCandidate = { ...candidate, placement };
    const next = cloneStateWithSpatialCandidate(state, nextCandidate);
    if (candidate.physics) {
      const component = next.state.components.get(next.candidateId)!;
      next.state.components.set(component.id, {
        ...component,
        props: { ...component.props, physics: structuredClone(candidate.physics) as unknown as JSONObject },
      });
    }
    const immediate = buildPhysicsValidationReport(next.state).bodies.find((entry) => entry.componentId === next.candidateId);
    if (immediate?.stable) {
      addSuggestion(placement);
      continue;
    }
    const nextSettle = simulatePhysicsSettle(next.state, { componentIds: [next.candidateId] });
    const nextProposal = nextSettle.proposals.find((entry) => entry.componentId === next.candidateId);
    const settledBody = nextSettle.report.bodies.find((entry) => entry.componentId === next.candidateId);
    if (nextProposal?.settled && settledBody?.stable) addSuggestion(nextProposal.to);
  }
  return {
    valid: collisionCheck.valid && Boolean(body?.stable),
    candidateId: prepared.candidateId,
    collisionCheck,
    body,
    issues: report.issues.filter((issue) => issue.componentId === prepared.candidateId),
    suggestedPlacements: suggestedPlacements.slice(0, 4),
  };
}

export function enforcedPhysicsIssues(state: Readonly<WorkspaceState>): readonly PhysicsIssue[] {
  const hasEnforcedPhysics = [...state.components.values()].some((component) => {
    if (component.type.typeId !== "spatial-entity" && component.type.typeId !== "spatial-primitive") return false;
    const physics = effectiveSpatialPhysicsConfig(component.props);
    return physics.enabled && (physics.stabilityMode === "enforce" || physics.constraints.length > 0);
  });
  if (!hasEnforcedPhysics) return [];
  const report = buildPhysicsValidationReport(state);
  const enforced = new Set(report.bodies
    .filter((body) => body.enabled && body.stabilityMode === "enforce")
    .map((body) => body.componentId));
  return report.issues.filter((issue) =>
    issue.code === "capacity_exceeded" || issue.code.startsWith("constraint_") || enforced.has(issue.componentId));
}

export function physicsProps(config: SpatialPhysicsConfig): JSONObject {
  return structuredClone(config) as unknown as JSONObject;
}

export function physicsForComponent(component: Readonly<ComponentInstance>): SpatialPhysicsConfig {
  return effectiveSpatialPhysicsConfig(component.props);
}
