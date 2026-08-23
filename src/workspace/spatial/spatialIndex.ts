import { DEFAULT_ASSET_REGISTRY } from "../../assets/AssetRegistry";
import type { AssetRecord } from "../../assets/assetManifest";
import type {
  ComponentInstance,
  ComponentPlacement,
  JSONObject,
  Vec3,
  World3DPlacement,
} from "../components/componentTypes";
import {
  evaluateParametricGeometry,
  type ParametricPrimitive,
} from "../modeling/parametricGeometry";
import {
  parseCadEvaluationEvidence,
  parseCadPartDefinition,
} from "../modeling/cad";
import type { WorkspaceState } from "../state/workspaceState";
import { isSpatialRenderTypeId } from "./spatialComponentKinds";
import { effectiveSpatialPhysicsConfig } from "../physics";
import { supportContactPatches } from "./contactGeometry";
import {
  DEFAULT_SPATIAL_COLLISION,
  MAX_WORKSPACE_SPATIAL_NODES,
  SEMAFRAME_SPATIAL_GRAPH_VERSION,
  type SpatialBounds,
  type SpatialAssemblyAncestor,
  type SpatialAssemblyCollisionPolicy,
  type SpatialAssemblySummary,
  type SpatialCollisionConfig,
  type SpatialCollisionConflict,
  type SpatialPlacementCandidate,
  type SpatialPlacementCheck,
  type SpatialResolvedCollision,
  type SpatialResolvedCollisionPart,
  type SpatialParametricMaterialSummary,
  type SpatialCadGeometrySummary,
  type SpatialTransform,
  type SemaFrameSpatialGraphNode,
  type SemaFrameSpatialGraphSnapshot,
} from "./spatialTypes";

type Quaternion = { x: number; y: number; z: number; w: number };
type MutableNode = Omit<SemaFrameSpatialGraphNode, "relations"> & { relations: string[] };

const EPSILON = 1e-6;
const MAX_COLLISION_MARGIN = 10;
const CANDIDATE_ID = "__SPATIAL_CANDIDATE__";

function add(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function multiply(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x * right.x, y: left.y * right.y, z: left.z * right.z };
}

function scale(value: Vec3, amount: number): Vec3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function length(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize(value: Vec3): Vec3 {
  const magnitude = length(value);
  return magnitude <= EPSILON ? { x: 0, y: 0, z: 0 } : scale(value, 1 / magnitude);
}

function quaternionFromEulerXYZ(rotation: Vec3): Quaternion {
  const c1 = Math.cos(rotation.x / 2);
  const c2 = Math.cos(rotation.y / 2);
  const c3 = Math.cos(rotation.z / 2);
  const s1 = Math.sin(rotation.x / 2);
  const s2 = Math.sin(rotation.y / 2);
  const s3 = Math.sin(rotation.z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

function multiplyQuaternion(left: Quaternion, right: Quaternion): Quaternion {
  return normalizeQuaternion({
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  });
}

function normalizeQuaternion(value: Quaternion): Quaternion {
  const magnitude = Math.hypot(value.x, value.y, value.z, value.w);
  if (magnitude <= EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: value.x / magnitude,
    y: value.y / magnitude,
    z: value.z / magnitude,
    w: value.w / magnitude,
  };
}

function rotateVector(quaternion: Quaternion, value: Vec3): Vec3 {
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

function transformMatrix(position: Vec3, rotation: Quaternion, worldScale: Vec3): number[] {
  const { x, y, z, w } = rotation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * worldScale.x, (xy - wz) * worldScale.y, (xz + wy) * worldScale.z, position.x,
    (xy + wz) * worldScale.x, (1 - (xx + zz)) * worldScale.y, (yz - wx) * worldScale.z, position.y,
    (xz - wy) * worldScale.x, (yz + wx) * worldScale.y, (1 - (xx + yy)) * worldScale.z, position.z,
    0, 0, 0, 1,
  ];
}

function transformForPlacement(
  placement: World3DPlacement,
  parent: SpatialTransform | undefined,
): SpatialTransform {
  const localRotation = quaternionFromEulerXYZ(placement.rotation);
  const worldScale = parent ? multiply(parent.scale, placement.scale) : { ...placement.scale };
  const worldRotation = parent
    ? multiplyQuaternion(parent.rotationQuaternion, localRotation)
    : localRotation;
  const worldPosition = parent
    ? add(parent.position, rotateVector(parent.rotationQuaternion, multiply(parent.scale, placement.position)))
    : { ...placement.position };
  return {
    position: worldPosition,
    rotationQuaternion: worldRotation,
    scale: worldScale,
    matrix: transformMatrix(worldPosition, worldRotation, worldScale),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseSpatialCollisionConfig(value: unknown): SpatialCollisionConfig | undefined {
  if (!isObject(value)) return undefined;
  if (
    typeof value.enabled !== "boolean"
    || (value.role !== "solid" && value.role !== "trigger" && value.role !== "none")
    || (value.shape !== "asset_bounds" && value.shape !== "box" && value.shape !== "compound")
    || typeof value.margin !== "number"
    || !Number.isFinite(value.margin)
    || value.margin < 0
    || value.margin > MAX_COLLISION_MARGIN
  ) return undefined;
  const base = {
    enabled: value.enabled,
    role: value.role as SpatialCollisionConfig["role"],
    margin: value.margin,
  };
  if (value.shape === "asset_bounds") return { ...base, shape: "asset_bounds" };
  const parseVector = (candidate: unknown, positive: boolean): Vec3 | undefined => {
    if (!isObject(candidate) || Object.keys(candidate).some((key) => key !== "x" && key !== "y" && key !== "z")) return undefined;
    const result = candidate as Record<string, unknown>;
    for (const axis of ["x", "y", "z"] as const) {
      const coordinate = result[axis];
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)
        || Math.abs(coordinate) > 1_000 || (positive && coordinate <= 0)) return undefined;
    }
    return { x: result.x as number, y: result.y as number, z: result.z as number };
  };
  if (value.shape === "box") {
    if (Object.keys(value).some((key) => !["enabled", "role", "shape", "margin", "center", "size"].includes(key))) return undefined;
    const center = parseVector(value.center, false);
    const size = parseVector(value.size, true);
    return center && size ? { ...base, shape: "box", center, size } : undefined;
  }
  if (Object.keys(value).some((key) => !["enabled", "role", "shape", "margin", "parts"].includes(key))
    || !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 16) return undefined;
  const ids = new Set<string>();
  const parts = value.parts.map((candidate) => {
    if (!isObject(candidate) || Object.keys(candidate).some((key) => !["id", "center", "size", "rotation"].includes(key))
      || typeof candidate.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(candidate.id)
      || ids.has(candidate.id)) return undefined;
    const center = parseVector(candidate.center, false);
    const size = parseVector(candidate.size, true);
    const rotation = parseVector(candidate.rotation, false);
    if (!center || !size || !rotation) return undefined;
    ids.add(candidate.id);
    return { id: candidate.id, center, size, rotation };
  });
  return parts.some((part) => !part)
    ? undefined
    : { ...base, shape: "compound", parts: parts as NonNullable<typeof parts[number]>[] };
}

export function spatialCollisionConfigFromProps(props: Readonly<JSONObject>): SpatialCollisionConfig | undefined {
  return props.collision === undefined ? undefined : parseSpatialCollisionConfig(props.collision);
}

function boundsFromPoints(points: readonly Vec3[]): SpatialBounds {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const point of points) {
    min.x = Math.min(min.x, point.x);
    min.y = Math.min(min.y, point.y);
    min.z = Math.min(min.z, point.z);
    max.x = Math.max(max.x, point.x);
    max.y = Math.max(max.y, point.y);
    max.z = Math.max(max.z, point.z);
  }
  const size = subtract(max, min);
  return { min, max, center: scale(add(min, max), 0.5), size };
}

function localBoundsCenter(asset: AssetRecord): Vec3 {
  const originRule = asset.runtime?.originRule ?? "ground_center";
  return originRule === "ground_center"
    ? { x: 0, y: asset.bounds.height / 2, z: 0 }
    : { x: 0, y: 0, z: 0 };
}

type LocalBoundsSource = Readonly<{
  center: Vec3;
  size: Vec3;
  source: "asset_bounds" | "parametric_bounds" | "cad_bounds";
}>;

function localBoundsForAsset(asset: AssetRecord): LocalBoundsSource {
  return {
    center: localBoundsCenter(asset),
    size: { x: asset.bounds.width, y: asset.bounds.height, z: asset.bounds.depth },
    source: "asset_bounds",
  };
}

function resolvedBoxPart(
  id: string,
  source: SpatialResolvedCollisionPart["source"],
  localCenter: Vec3,
  localSize: Vec3,
  localRotation: Vec3,
  transform: SpatialTransform,
  margin: number,
): SpatialResolvedCollisionPart {
  const center = add(
    transform.position,
    rotateVector(transform.rotationQuaternion, multiply(localCenter, transform.scale)),
  );
  const rotation = multiplyQuaternion(transform.rotationQuaternion, quaternionFromEulerXYZ(localRotation));
  const halfExtents = {
    x: Math.abs(localSize.x * transform.scale.x) / 2 + margin,
    y: Math.abs(localSize.y * transform.scale.y) / 2 + margin,
    z: Math.abs(localSize.z * transform.scale.z) / 2 + margin,
  };
  const axes: [Vec3, Vec3, Vec3] = [
    normalize(rotateVector(rotation, { x: 1, y: 0, z: 0 })),
    normalize(rotateVector(rotation, { x: 0, y: 1, z: 0 })),
    normalize(rotateVector(rotation, { x: 0, y: 0, z: 1 })),
  ];
  const corners: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    corners.push(add(center, add(
      add(scale(axes[0], x * halfExtents.x), scale(axes[1], y * halfExtents.y)),
      scale(axes[2], z * halfExtents.z),
    )));
  }
  return { id, source, center, halfExtents, axes, aabb: boundsFromPoints(corners) };
}

function mergeBounds(bounds: readonly SpatialBounds[]): SpatialBounds {
  return boundsFromPoints(bounds.flatMap((bound) => [bound.min, bound.max]));
}

function resolvedCollision(
  localBounds: LocalBoundsSource,
  transform: SpatialTransform,
  config: SpatialCollisionConfig | undefined,
): SpatialResolvedCollision | undefined {
  if (!config || !config.enabled || config.role === "none") return undefined;
  const parts: SpatialResolvedCollisionPart[] = config.shape === "asset_bounds"
    ? [resolvedBoxPart(
      localBounds.source,
      localBounds.source,
      localBounds.center,
      localBounds.size,
      { x: 0, y: 0, z: 0 },
      transform,
      config.margin,
    )]
    : config.shape === "box"
      ? [resolvedBoxPart("box", "explicit_box", config.center, config.size, { x: 0, y: 0, z: 0 }, transform, config.margin)]
      : config.parts.map((part) => resolvedBoxPart(
        part.id,
        "compound_part",
        part.center,
        part.size,
        part.rotation,
        transform,
        config.margin,
      ));
  const aabb = mergeBounds(parts.map((part) => part.aabb));
  const envelopeAxes: [Vec3, Vec3, Vec3] = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
  ];
  return {
    enabled: config.enabled,
    role: config.role,
    shape: parts.length === 1 ? "box" : "compound",
    source: config.shape === "asset_bounds"
      ? localBounds.source
      : config.shape === "box"
        ? "explicit_box"
        : "compound",
    margin: config.margin,
    parts,
    center: aabb.center,
    halfExtents: scale(aabb.size, 0.5),
    axes: envelopeAxes,
    aabb,
  };
}

function primSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_]/gu, "_").replace(/^([^A-Za-z_])/u, "_$1");
  return safe || "Unnamed";
}

function isSpatialComponent(component: ComponentInstance | undefined): component is ComponentInstance {
  return component !== undefined
    && isSpatialRenderTypeId(component.type.typeId)
    && component.placement.space === "world3d";
}

function spatialNodeKind(component: ComponentInstance): SemaFrameSpatialGraphNode["nodeKind"] {
  if (component.type.typeId === "spatial-primitive") return "primitive";
  if (component.type.typeId === "cad-part") return "cad";
  if (component.type.typeId === "model-assembly") return "assembly";
  if (component.type.typeId === "gaussian-splat") return "reality";
  return "asset";
}

function assemblyCollisionPolicy(value: unknown): SpatialAssemblyCollisionPolicy {
  return value === "all" || value === "none" || value === "external_only"
    ? value
    : "external_only";
}

function safeModelRef(value: unknown): SpatialAssemblySummary["modelRef"] {
  if (!isObject(value)) return undefined;
  const { modelId, version, digest } = value;
  if (typeof modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(modelId)
    || typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/u.test(version)
    || typeof digest !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u.test(digest)) {
    return undefined;
  }
  return { modelId, version, digest };
}

function assemblySummary(component: ComponentInstance): SpatialAssemblySummary {
  const modelRef = safeModelRef(component.props.modelRef);
  return {
    collisionPolicy: assemblyCollisionPolicy(component.props.collisionPolicy),
    ...(modelRef ? { modelRef } : {}),
  };
}

function componentAssemblyAncestry(
  component: ComponentInstance,
  components: ReadonlyMap<string, ComponentInstance>,
): SpatialAssemblyAncestor[] {
  const ancestry: SpatialAssemblyAncestor[] = [];
  const seen = new Set([component.id]);
  let parentId = component.parentId;
  while (parentId && ancestry.length < MAX_WORKSPACE_SPATIAL_NODES) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = components.get(parentId);
    if (!parent) break;
    if (parent.type.typeId === "model-assembly") {
      ancestry.push({ id: parent.id, ...assemblySummary(parent) });
    }
    parentId = parent.parentId;
  }
  return ancestry.reverse();
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function parametricMaterialSummary(value: unknown): SpatialParametricMaterialSummary | undefined {
  if (!isObject(value)) return undefined;
  const color = (candidate: unknown): candidate is string => typeof candidate === "string"
    && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u.test(candidate);
  if (!color(value.baseColor) || !finiteRange(value.metallic, 0, 1)
    || !finiteRange(value.roughness, 0, 1) || !finiteRange(value.opacity, 0, 1)
    || !color(value.emissiveColor) || !finiteRange(value.emissiveIntensity, 0, 8)) {
    return undefined;
  }
  return {
    baseColor: value.baseColor,
    metallic: value.metallic,
    roughness: value.roughness,
    opacity: value.opacity,
    emissiveColor: value.emissiveColor,
    emissiveIntensity: value.emissiveIntensity,
  };
}

function cadGeometrySummary(component: ComponentInstance): SpatialCadGeometrySummary | undefined {
  if (component.type.typeId !== "cad-part" || component.props.evaluation === null) return undefined;
  const definition = parseCadPartDefinition(component.props.definition);
  if (!definition.activeBodyIds.length) return undefined;
  const evidence = parseCadEvaluationEvidence(component.props.evaluation, definition);
  const volumeM3 = evidence.bodies.reduce((sum, body) => sum + body.volumeM3, 0);
  const centerOfMassM = evidence.bodies.reduce((weighted, body) => add(
    weighted,
    scale(body.centerOfMassM, body.volumeM3),
  ), { x: 0, y: 0, z: 0 });
  return {
    definitionDigest: evidence.definitionDigest,
    evaluatorVersion: evidence.evaluatorVersion,
    exactness: evidence.exactness,
    bodyCount: evidence.bodies.length,
    localBounds: structuredClone(evidence.overallBounds),
    volumeM3,
    surfaceAreaM2: evidence.bodies.reduce((sum, body) => sum + body.surfaceAreaM2, 0),
    centerOfMassM: scale(centerOfMassM, 1 / volumeM3),
    diagnostics: structuredClone(evidence.diagnostics),
  };
}

function pointBounds(point: Vec3): SpatialBounds {
  return {
    min: { ...point },
    max: { ...point },
    center: { ...point },
    size: { x: 0, y: 0, z: 0 },
  };
}

function realityReference(value: unknown): { assetId: string; digest: string } | undefined {
  if (!isObject(value) || typeof value.assetId !== "string" || typeof value.digest !== "string") {
    return undefined;
  }
  return { assetId: value.assetId, digest: value.digest };
}

function realityCalibration(value: unknown): Readonly<{
  status: "uncalibrated" | "metadata-declared" | "reference-distance";
  sourceCoordinateSystem: string;
  metersPerSourceUnit?: number;
}> {
  if (!isObject(value)) {
    return { status: "uncalibrated", sourceCoordinateSystem: "UNKNOWN" };
  }
  const status = value.status === "metadata-declared" || value.status === "reference-distance"
    ? value.status
    : "uncalibrated";
  return {
    status,
    sourceCoordinateSystem: typeof value.sourceCoordinateSystem === "string"
      ? value.sourceCoordinateSystem
      : "UNKNOWN",
    ...(typeof value.metersPerSourceUnit === "number" && Number.isFinite(value.metersPerSourceUnit)
      && value.metersPerSourceUnit > 0
      ? { metersPerSourceUnit: value.metersPerSourceUnit }
      : {}),
  };
}

function coordinateSigns(system: string): Vec3 {
  if (!/^[LR][UD][BF]$/u.test(system)) return { x: 1, y: 1, z: 1 };
  return {
    x: system[0] === "R" ? 1 : -1,
    y: system[1] === "U" ? 1 : -1,
    z: system[2] === "B" ? 1 : -1,
  };
}

function realityLocalBounds(
  sourceBounds: Readonly<{ min: Vec3; max: Vec3 }> | undefined,
  sourceCoordinateSystem: string,
  metersPerSourceUnit: number | undefined,
): LocalBoundsSource | undefined {
  if (!sourceBounds) return undefined;
  const signs = coordinateSigns(sourceCoordinateSystem);
  const factor = metersPerSourceUnit ?? 1;
  const first = multiply(sourceBounds.min, scale(signs, factor));
  const second = multiply(sourceBounds.max, scale(signs, factor));
  const min = {
    x: Math.min(first.x, second.x),
    y: Math.min(first.y, second.y),
    z: Math.min(first.z, second.z),
  };
  const max = {
    x: Math.max(first.x, second.x),
    y: Math.max(first.y, second.y),
    z: Math.max(first.z, second.z),
  };
  return {
    center: scale(add(min, max), 0.5),
    size: subtract(max, min),
    source: "asset_bounds",
  };
}

function componentPrimPath(component: ComponentInstance, components: ReadonlyMap<string, ComponentInstance>): string {
  const segments: string[] = [primSegment(component.id)];
  const seen = new Set([component.id]);
  let parentId = component.parentId;
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = components.get(parentId);
    if (!parent) break;
    if (isSpatialComponent(parent)) segments.unshift(primSegment(parent.id));
    parentId = parent.parentId;
  }
  return `/World/${segments.join("/")}`;
}

function createSpatialNodes(state: Readonly<WorkspaceState>): MutableNode[] {
  const spatialComponents = [...state.components.values()]
    .filter(isSpatialComponent)
    .sort((left, right) => left.id.localeCompare(right.id));
  const spatialIds = new Set(spatialComponents.map((component) => component.id));
  const transforms = new Map<string, SpatialTransform>();
  const visiting = new Set<string>();
  const resolveTransform = (component: ComponentInstance): SpatialTransform => {
    const cached = transforms.get(component.id);
    if (cached) return cached;
    if (visiting.has(component.id)) throw new Error(`Spatial hierarchy cycle includes ${component.id}`);
    visiting.add(component.id);
    const parentCandidate = component.parentId && spatialIds.has(component.parentId)
      ? state.components.get(component.parentId)
      : undefined;
    const parent = isSpatialComponent(parentCandidate) ? parentCandidate : undefined;
    const result = transformForPlacement(
      component.placement as World3DPlacement,
      parent ? resolveTransform(parent) : undefined,
    );
    visiting.delete(component.id);
    transforms.set(component.id, result);
    return result;
  };

  const baseNodes = spatialComponents.flatMap((component): MutableNode[] => {
    const transform = resolveTransform(component);
    const nodeKind = spatialNodeKind(component);
    const parentId = component.parentId && spatialIds.has(component.parentId)
      ? component.parentId
      : undefined;
    const ancestry = componentAssemblyAncestry(component, state.components);
    if (nodeKind === "assembly") {
      return [{
        id: component.id,
        primPath: componentPrimPath(component, state.components),
        label: component.label,
        ...(parentId ? { parentId } : {}),
        nodeKind,
        entityKind: "assembly",
        assembly: assemblySummary(component),
        assemblyAncestry: ancestry,
        visibility: component.visibility,
        localPlacement: structuredClone(component.placement),
        worldTransform: transform,
        worldBounds: pointBounds(transform.position),
        relations: [],
      }];
    }

    if (nodeKind === "reality") {
      const reference = realityReference(component.props.assetRef);
      const descriptor = reference ? state.realityAssets.get(reference.assetId) : undefined;
      const calibration = realityCalibration(component.props.calibration);
      const localBounds = realityLocalBounds(
        descriptor?.sourceBounds,
        calibration.sourceCoordinateSystem,
        calibration.metersPerSourceUnit,
      );
      const worldBounds = localBounds
        ? resolvedBoxPart(
            "reality_bounds",
            "asset_bounds",
            localBounds.center,
            localBounds.size,
            { x: 0, y: 0, z: 0 },
            transform,
            0,
          ).aabb
        : pointBounds(transform.position);
      const semanticProxyIds = Array.isArray(component.props.semanticProxyIds)
        ? component.props.semanticProxyIds.filter((id): id is string => typeof id === "string")
          .sort((left, right) => left.localeCompare(right))
        : [];
      return [{
        id: component.id,
        primPath: componentPrimPath(component, state.components),
        label: component.label,
        ...(parentId ? { parentId } : {}),
        nodeKind,
        entityKind: "gaussian-splat",
        reality: {
          ...(reference ? { assetId: reference.assetId, digest: reference.digest } : {}),
          descriptorAvailable: Boolean(descriptor),
          binaryAvailability: "host_local_unknown",
          ...(descriptor ? { format: descriptor.format, splatCount: descriptor.splatCount } : {}),
          engineeringAuthority: "visual_only",
          calibrationStatus: calibration.status,
          sourceCoordinateSystem: calibration.sourceCoordinateSystem,
          targetCoordinateSystem: "RUB",
          ...(calibration.metersPerSourceUnit === undefined
            ? {}
            : { metersPerSourceUnit: calibration.metersPerSourceUnit }),
          boundsAreMetric: calibration.metersPerSourceUnit !== undefined,
          semanticProxyIds,
        },
        assemblyAncestry: ancestry,
        visibility: component.visibility,
        localPlacement: structuredClone(component.placement),
        worldTransform: transform,
        worldBounds,
        relations: semanticProxyIds.map((id) => `represented_by:${id}`),
      }];
    }

    const physics = effectiveSpatialPhysicsConfig(component.props);
    if (nodeKind === "primitive") {
      const evaluated = evaluateParametricGeometry(component.props.geometry);
      const localBounds: LocalBoundsSource = {
        center: evaluated.bounds.center,
        size: evaluated.bounds.size,
        source: "parametric_bounds",
      };
      const collision = component.visibility === "visible"
        ? resolvedCollision(localBounds, transform, spatialCollisionConfigFromProps(component.props))
        : undefined;
      const visualBounds = resolvedCollision(localBounds, transform, {
        ...DEFAULT_SPATIAL_COLLISION,
        role: "trigger",
        margin: 0,
      })!;
      const material = parametricMaterialSummary(component.props.material);
      return [{
        id: component.id,
        primPath: componentPrimPath(component, state.components),
        label: component.label,
        ...(parentId ? { parentId } : {}),
        nodeKind,
        entityKind: "primitive",
        geometry: {
          kind: evaluated.primitive.kind,
          digest: evaluated.digest,
          parameters: evaluated.primitive,
          dimensionsM: evaluated.bounds.size,
          localBounds: evaluated.bounds,
          volumeM3: evaluated.volumeM3,
          collider: evaluated.collider,
          ...(material ? { material } : {}),
        },
        assemblyAncestry: ancestry,
        visibility: component.visibility,
        localPlacement: structuredClone(component.placement),
        worldTransform: transform,
        worldBounds: visualBounds.aabb,
        ...(collision ? { collision } : {}),
        physics: {
          enabled: physics.enabled,
          bodyType: physics.bodyType,
          massKg: physics.massKg,
          massSource: "explicit",
          geometryVolumeM3: evaluated.volumeM3 * Math.abs(
            transform.scale.x * transform.scale.y * transform.scale.z,
          ),
          centerOfMass: physics.centerOfMass,
          friction: physics.friction,
          restitution: physics.restitution,
          gravityScale: physics.gravityScale,
          stabilityMode: physics.stabilityMode,
          constraintCount: physics.constraints.length,
        },
        relations: [],
      }];
    }

    if (nodeKind === "cad") {
      const cad = cadGeometrySummary(component);
      if (!cad) {
        return [{
          id: component.id,
          primPath: componentPrimPath(component, state.components),
          label: component.label,
          ...(parentId ? { parentId } : {}),
          nodeKind,
          entityKind: "cad-part",
          assemblyAncestry: ancestry,
          visibility: component.visibility,
          localPlacement: structuredClone(component.placement),
          worldTransform: transform,
          worldBounds: pointBounds(transform.position),
          physics: {
            enabled: physics.enabled,
            bodyType: physics.bodyType,
            massKg: physics.massKg,
            massSource: "explicit",
            centerOfMass: physics.centerOfMass,
            friction: physics.friction,
            restitution: physics.restitution,
            gravityScale: physics.gravityScale,
            stabilityMode: physics.stabilityMode,
            constraintCount: physics.constraints.length,
          },
          relations: [],
        }];
      }
      const localBounds: LocalBoundsSource = {
        center: cad.localBounds.center,
        size: cad.localBounds.size,
        source: "cad_bounds",
      };
      const collision = component.visibility === "visible"
        ? resolvedCollision(localBounds, transform, spatialCollisionConfigFromProps(component.props))
        : undefined;
      const visualBounds = resolvedCollision(localBounds, transform, {
        ...DEFAULT_SPATIAL_COLLISION,
        role: "trigger",
        margin: 0,
      })!;
      return [{
        id: component.id,
        primPath: componentPrimPath(component, state.components),
        label: component.label,
        ...(parentId ? { parentId } : {}),
        nodeKind,
        entityKind: "cad-part",
        cad,
        assemblyAncestry: ancestry,
        visibility: component.visibility,
        localPlacement: structuredClone(component.placement),
        worldTransform: transform,
        worldBounds: visualBounds.aabb,
        ...(collision ? { collision } : {}),
        physics: {
          enabled: physics.enabled,
          bodyType: physics.bodyType,
          massKg: physics.massKg,
          massSource: "explicit",
          geometryVolumeM3: cad.volumeM3 * Math.abs(
            transform.scale.x * transform.scale.y * transform.scale.z,
          ),
          centerOfMass: physics.centerOfMass,
          friction: physics.friction,
          restitution: physics.restitution,
          gravityScale: physics.gravityScale,
          stabilityMode: physics.stabilityMode,
          constraintCount: physics.constraints.length,
        },
        relations: [],
      }];
    }

    const assetId = typeof component.props.assetId === "string" ? component.props.assetId : "";
    const asset = DEFAULT_ASSET_REGISTRY.get(assetId);
    if (!asset) return [];
    const localBounds = localBoundsForAsset(asset);
    const collision = component.visibility === "visible"
      ? resolvedCollision(localBounds, transform, spatialCollisionConfigFromProps(component.props))
      : undefined;
    const visualBounds = resolvedCollision(localBounds, transform, {
      ...DEFAULT_SPATIAL_COLLISION,
      role: "trigger",
      margin: 0,
    })!;
    return [{
      id: component.id,
      primPath: componentPrimPath(component, state.components),
      label: component.label,
      ...(parentId ? { parentId } : {}),
      nodeKind,
      assetId: asset.assetId,
      entityKind: typeof component.props.entityKind === "string" ? component.props.entityKind : asset.kind,
      assemblyAncestry: ancestry,
      visibility: component.visibility,
      localPlacement: structuredClone(component.placement),
      worldTransform: transform,
      worldBounds: visualBounds.aabb,
      ...(collision ? { collision } : {}),
      physics: {
        enabled: physics.enabled,
        bodyType: physics.bodyType,
        massKg: physics.massKg,
        massSource: "explicit",
        centerOfMass: physics.centerOfMass,
        friction: physics.friction,
        restitution: physics.restitution,
        gravityScale: physics.gravityScale,
        stabilityMode: physics.stabilityMode,
        constraintCount: physics.constraints.length,
      },
      relations: [],
    }];
  });

  const byParent = new Map<string, MutableNode[]>();
  for (const node of baseNodes) {
    if (!node.parentId) continue;
    const children = byParent.get(node.parentId) ?? [];
    children.push(node);
    byParent.set(node.parentId, children);
  }
  const aggregateCache = new Map<string, SpatialBounds>();
  const aggregateAssemblyBounds = (node: MutableNode, visiting = new Set<string>()): SpatialBounds => {
    const cached = aggregateCache.get(node.id);
    if (cached) return cached;
    if (visiting.has(node.id)) return pointBounds(node.worldTransform.position);
    const nextVisiting = new Set(visiting).add(node.id);
    const childBounds = (byParent.get(node.id) ?? []).map((child) => child.nodeKind === "assembly"
      ? aggregateAssemblyBounds(child, nextVisiting)
      : child.worldBounds);
    const bounds = childBounds.length ? mergeBounds(childBounds) : pointBounds(node.worldTransform.position);
    aggregateCache.set(node.id, bounds);
    return bounds;
  };
  const byId = new Map(baseNodes.map((node) => [node.id, node]));
  for (const node of baseNodes) {
    if (node.nodeKind !== "reality") continue;
    for (const proxyId of node.reality?.semanticProxyIds ?? []) {
      byId.get(proxyId)?.relations.push(`proxy_for:${node.id}`);
    }
  }
  return baseNodes.map((node): MutableNode => node.nodeKind === "assembly"
    ? { ...node, worldBounds: aggregateAssemblyBounds(node) }
    : node);
}

function areRelatedByHierarchy(
  left: SemaFrameSpatialGraphNode,
  right: SemaFrameSpatialGraphNode,
  byId: ReadonlyMap<string, SemaFrameSpatialGraphNode>,
): boolean {
  const isAncestor = (candidate: SemaFrameSpatialGraphNode, descendant: SemaFrameSpatialGraphNode): boolean => {
    const seen = new Set<string>();
    let current = descendant.parentId;
    while (current && !seen.has(current)) {
      if (current === candidate.id) return true;
      seen.add(current);
      current = byId.get(current)?.parentId;
    }
    return false;
  };
  return isAncestor(left, right) || isAncestor(right, left);
}

function collisionFeasibilityEnabled(node: SemaFrameSpatialGraphNode): boolean {
  return !node.assemblyAncestry.some((assembly) => assembly.collisionPolicy === "none");
}

function ignoredInternalAssemblyCollision(
  left: SemaFrameSpatialGraphNode,
  right: SemaFrameSpatialGraphNode,
): boolean {
  const leftNearest = left.assemblyAncestry.at(-1);
  const rightNearest = right.assemblyAncestry.at(-1);
  return Boolean(leftNearest
    && rightNearest
    && leftNearest.id === rightNearest.id
    && leftNearest.collisionPolicy === "external_only");
}

/** Full separating-axis test for two oriented boxes. Touching is permitted. */
function boxesIntersect(left: SpatialResolvedCollisionPart, right: SpatialResolvedCollisionPart): boolean {
  const a = left.axes;
  const b = right.axes;
  const ae = [left.halfExtents.x, left.halfExtents.y, left.halfExtents.z];
  const be = [right.halfExtents.x, right.halfExtents.y, right.halfExtents.z];
  const rotation = Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => dot(a[i]!, b[j]!)));
  const absolute = rotation.map((row) => row.map((value) => Math.abs(value) + 1e-10));
  const translated = subtract(right.center, left.center);
  const t = [dot(translated, a[0]), dot(translated, a[1]), dot(translated, a[2])];

  for (let i = 0; i < 3; i += 1) {
    const ra = ae[i]!;
    const rb = be[0]! * absolute[i]![0]! + be[1]! * absolute[i]![1]! + be[2]! * absolute[i]![2]!;
    if (Math.abs(t[i]!) >= ra + rb - EPSILON) return false;
  }
  for (let j = 0; j < 3; j += 1) {
    const ra = ae[0]! * absolute[0]![j]! + ae[1]! * absolute[1]![j]! + ae[2]! * absolute[2]![j]!;
    const rb = be[j]!;
    const distance = Math.abs(t[0]! * rotation[0]![j]! + t[1]! * rotation[1]![j]! + t[2]! * rotation[2]![j]!);
    if (distance >= ra + rb - EPSILON) return false;
  }
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    const ra = ae[(i + 1) % 3]! * absolute[(i + 2) % 3]![j]!
      + ae[(i + 2) % 3]! * absolute[(i + 1) % 3]![j]!;
    const rb = be[(j + 1) % 3]! * absolute[i]![(j + 2) % 3]!
      + be[(j + 2) % 3]! * absolute[i]![(j + 1) % 3]!;
    // Parallel box axes have a zero-length cross product and therefore do not
    // define a separating axis. Numerical padding alone must not turn that
    // degenerate axis into a false separation.
    if (ra + rb <= EPSILON) continue;
    const distance = Math.abs(
      t[(i + 2) % 3]! * rotation[(i + 1) % 3]![j]!
      - t[(i + 1) % 3]! * rotation[(i + 2) % 3]![j]!,
    );
    if (distance >= ra + rb - EPSILON) return false;
  }
  return true;
}

function aabbOverlap(left: SpatialBounds, right: SpatialBounds): Vec3 {
  return {
    x: Math.max(0, Math.min(left.max.x, right.max.x) - Math.max(left.min.x, right.min.x)),
    y: Math.max(0, Math.min(left.max.y, right.max.y) - Math.max(left.min.y, right.min.y)),
    z: Math.max(0, Math.min(left.max.z, right.max.z) - Math.max(left.min.z, right.min.z)),
  };
}

function collisionPairs(
  nodes: readonly SemaFrameSpatialGraphNode[],
  options: Readonly<{ maxConflicts?: number; targetIds?: ReadonlySet<string> }> = {},
): SpatialCollisionConflict[] {
  const conflicts: SpatialCollisionConflict[] = [];
  const maxConflicts = Math.max(1, Math.min(10_001, Math.trunc(options.maxConflicts ?? 10_000)));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const solids = nodes
    .filter((node) => node.collision?.role === "solid" && collisionFeasibilityEnabled(node))
    .sort((left, right) => left.collision!.aabb.min.x - right.collision!.aabb.min.x
      || left.id.localeCompare(right.id));
  // Sweep-and-prune on world X avoids an all-pairs SAT pass for normal scenes;
  // the full 15-axis OBB test remains authoritative for broad-phase candidates.
  outer: for (let i = 0; i < solids.length; i += 1) for (let j = i + 1; j < solids.length; j += 1) {
    const left = solids[i]!;
    const right = solids[j]!;
    if (right.collision!.aabb.min.x >= left.collision!.aabb.max.x - EPSILON) break;
    if (ignoredInternalAssemblyCollision(left, right)) continue;
    const aabb = aabbOverlap(left.collision!.aabb, right.collision!.aabb);
    if (aabb.x <= EPSILON || aabb.y <= EPSILON || aabb.z <= EPSILON) continue;
    const attached = areRelatedByHierarchy(left, right, byId);
    const intersects = left.collision!.parts.some((leftPart) =>
      right.collision!.parts.some((rightPart) => {
        if (!attached) return boxesIntersect(leftPart, rightPart);
        // Hierarchical attachment permits contact at the rendered solid, but
        // no longer grants a blanket collision exemption. Shrinking only the
        // configured safety margins preserves face attachment while detecting
        // actual parent/child penetration.
        return boxesIntersect(
          {
            ...leftPart,
            halfExtents: {
              x: Math.max(EPSILON, leftPart.halfExtents.x - left.collision!.margin),
              y: Math.max(EPSILON, leftPart.halfExtents.y - left.collision!.margin),
              z: Math.max(EPSILON, leftPart.halfExtents.z - left.collision!.margin),
            },
          },
          {
            ...rightPart,
            halfExtents: {
              x: Math.max(EPSILON, rightPart.halfExtents.x - right.collision!.margin),
              y: Math.max(EPSILON, rightPart.halfExtents.y - right.collision!.margin),
              z: Math.max(EPSILON, rightPart.halfExtents.z - right.collision!.margin),
            },
          },
        );
      }));
    if (!intersects) continue;
    const [componentId, conflictsWith] = left.id.localeCompare(right.id) <= 0
      ? [left.id, right.id]
      : [right.id, left.id];
    if (options.targetIds && !options.targetIds.has(componentId) && !options.targetIds.has(conflictsWith)) continue;
    conflicts.push({ componentId, conflictsWith, overlap: aabb });
    if (conflicts.length >= maxConflicts) break outer;
  }
  return conflicts.sort((left, right) => left.componentId.localeCompare(right.componentId)
    || left.conflictsWith.localeCompare(right.conflictsWith));
}

function decorateRelations(nodes: MutableNode[], conflicts: readonly SpatialCollisionConflict[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const conflict of conflicts) {
    byId.get(conflict.componentId)?.relations.push(`intersects:${conflict.conflictsWith}`);
    byId.get(conflict.conflictsWith)?.relations.push(`intersects:${conflict.componentId}`);
  }
  const eligible = nodes.filter((node) => node.visibility === "visible"
    && node.physics?.enabled === true
    && node.collision?.role === "solid");
  const topEntries = eligible.flatMap((node) => node.collision!.parts.map((part) => ({
    id: node.id,
    height: part.aabb.max.y,
  }))).sort((left, right) => left.height - right.height || left.id.localeCompare(right.id));
  const lowerBound = (height: number): number => {
    let low = 0;
    let high = topEntries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (topEntries[middle]!.height < height) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  for (const upper of eligible) {
    const candidateIds = new Set<string>();
    for (const part of upper.collision!.parts) {
      const start = lowerBound(part.aabb.min.y - 0.03);
      for (let index = start; index < topEntries.length; index += 1) {
        const entry = topEntries[index]!;
        if (entry.height > part.aabb.min.y + 0.03) break;
        if (entry.id !== upper.id) candidateIds.add(entry.id);
      }
    }
    for (const lowerId of [...candidateIds].sort((left, right) => left.localeCompare(right))) {
      const lower = byId.get(lowerId);
      if (!lower || !supportContactPatches(upper, lower, 0.03).length) continue;
      lower.relations.push(`supports:${upper.id}`);
      upper.relations.push(`supported_by:${lower.id}`);
    }
  }
  for (const node of nodes) node.relations.sort((left, right) => left.localeCompare(right));
}

export type SemaFrameSpatialGraphOptions = Readonly<{
  mode?: "full" | "delta";
  sinceRevision?: number;
  changedNodeIds?: ReadonlySet<string>;
  removedNodeIds?: readonly string[];
  maxNodes?: number;
}>;

function stageDescriptor(state: Readonly<WorkspaceState>): SemaFrameSpatialGraphSnapshot["stage"] {
  const stage = [...state.components.values()].find((component) => component.type.typeId === "stage-3d");
  if (!stage) return undefined;
  const value = stage.props.dimensions;
  const dimensions = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const width = typeof dimensions?.width === "number" && Number.isFinite(dimensions.width) ? dimensions.width : 12;
  const height = typeof dimensions?.height === "number" && Number.isFinite(dimensions.height) ? dimensions.height : 4;
  const depth = typeof dimensions?.depth === "number" && Number.isFinite(dimensions.depth) ? dimensions.depth : 10;
  return {
    componentId: stage.id,
    visibility: stage.visibility,
    dimensions: { width, height, depth },
    groundHeight: 0,
    groundPolygon: [
      { x: -width / 2, z: -depth / 2 },
      { x: width / 2, z: -depth / 2 },
      { x: width / 2, z: depth / 2 },
      { x: -width / 2, z: depth / 2 },
    ],
  };
}

export function buildSemaFrameSpatialGraph(
  state: Readonly<WorkspaceState>,
  options: SemaFrameSpatialGraphOptions = {},
): SemaFrameSpatialGraphSnapshot {
  const allNodes = createSpatialNodes(state).sort((left, right) => left.id.localeCompare(right.id));
  let filtered = allNodes;
  if (options.mode === "delta" && options.changedNodeIds) {
    const explicitChanged = options.changedNodeIds;
    const expandedChanged = new Set(explicitChanged);
    for (const node of allNodes) {
      if (explicitChanged.has(node.id)) {
        for (const ancestor of node.assemblyAncestry) expandedChanged.add(ancestor.id);
      }
      if (node.assemblyAncestry.some((ancestor) => explicitChanged.has(ancestor.id))) {
        expandedChanged.add(node.id);
      }
    }
    filtered = allNodes.filter((node) => expandedChanged.has(node.id));
  }
  const maxNodes = Math.max(1, Math.min(MAX_WORKSPACE_SPATIAL_NODES, Math.trunc(options.maxNodes ?? 500)));
  const nodes = filtered.slice(0, maxNodes);
  // Apply the cap before collision/contact decoration. Delta snapshots include
  // a bounded context so changed nodes can still describe relationships to
  // unchanged neighbors without turning a tiny response into all-pairs work.
  const returnedIds = new Set(nodes.map((node) => node.id));
  const analysisNodes = options.mode === "delta"
    ? [...nodes, ...allNodes.filter((node) => !returnedIds.has(node.id))].slice(0, MAX_WORKSPACE_SPATIAL_NODES)
    : nodes;
  const rawConflicts = collisionPairs(analysisNodes, { maxConflicts: 10_001 });
  const collisionConflictsTruncated = rawConflicts.length > 10_000;
  const allConflicts = rawConflicts.slice(0, 10_000);
  const conflicts = (options.mode === "delta"
    ? allConflicts.filter((conflict) => returnedIds.has(conflict.componentId) || returnedIds.has(conflict.conflictsWith))
    : allConflicts).slice(0, 10_000);
  decorateRelations(analysisNodes, conflicts);
  const stage = stageDescriptor(state);
  return {
    format: "semaframe-spatial-graph",
    version: SEMAFRAME_SPATIAL_GRAPH_VERSION,
    workspaceId: state.workspaceId,
    workspaceRevision: state.revision,
    coordinateSystem: { units: "meters", upAxis: "+Y", forwardAxis: "+Z" },
    ...(stage ? { stage } : {}),
    mode: options.mode ?? "full",
    ...(options.sinceRevision === undefined ? {} : { sinceRevision: options.sinceRevision }),
    nodes,
    removedNodeIds: [...(options.removedNodeIds ?? [])].sort((left, right) => left.localeCompare(right)),
    collisionConflicts: conflicts,
    collisionConflictsTruncated,
    omittedNodeCount: filtered.length - nodes.length,
  };
}

export function findBlockingSpatialCollisions(
  state: Readonly<WorkspaceState>,
): SpatialCollisionConflict[] {
  return collisionPairs(createSpatialNodes(state), { maxConflicts: 20 });
}

export function cloneStateWithSpatialCandidate(
  state: Readonly<WorkspaceState>,
  candidate: SpatialPlacementCandidate,
): { state: WorkspaceState; candidateId: string } {
  if (candidate.placement.space !== "world3d") {
    throw new TypeError("Spatial placement candidates require world3d placement");
  }
  const components = new Map([...state.components].map(([id, component]) => [id, structuredClone(component)]));
  const existing = candidate.componentId ? components.get(candidate.componentId) : undefined;
  const candidateId = existing?.id ?? CANDIDATE_ID;
  const hasGeometry = candidate.geometry !== undefined;
  const hasAssetIdentity = candidate.assetId !== undefined || candidate.entityKind !== undefined;
  const hasCad = candidate.cad !== undefined;
  if (hasGeometry && hasAssetIdentity) {
    throw new TypeError("A parametric candidate cannot also declare assetId or entityKind");
  }
  if (hasCad && (hasGeometry || hasAssetIdentity)) {
    throw new TypeError("A placement candidate must use exactly one of CAD, parametric, or asset identity geometry");
  }
  if (existing && hasCad && existing.type.typeId !== "cad-part") {
    throw new TypeError(`Component ${existing.id} is not a CAD placement candidate`);
  }
  const collision = candidate.collision
    ?? (existing ? spatialCollisionConfigFromProps(existing.props) : DEFAULT_SPATIAL_COLLISION);
  if (!collision) throw new TypeError("Candidate collision configuration is invalid");

  let component: ComponentInstance;
  if (existing?.type.typeId === "cad-part") {
    if (hasGeometry || hasAssetIdentity) {
      throw new TypeError("A CAD part candidate keeps its evaluated feature document and cannot replace it with asset or primitive geometry");
    }
    component = {
      ...existing,
      placement: structuredClone(candidate.placement),
      props: {
        ...existing.props,
        ...(candidate.cad ? {
          definition: structuredClone(candidate.cad.definition) as unknown as JSONObject,
          definitionDigest: candidate.cad.evaluation.definitionDigest,
          evaluation: structuredClone(candidate.cad.evaluation) as unknown as JSONObject,
        } : {}),
        collision: structuredClone(collision) as unknown as JSONObject,
      },
    };
  } else if (!existing && candidate.cad) {
    component = {
      id: candidateId,
      type: { typeId: "cad-part", version: "candidate", digest: "candidate" },
      label: candidate.cad.definition.displayName,
      props: {
        definition: structuredClone(candidate.cad.definition) as unknown as JSONObject,
        definitionDigest: candidate.cad.evaluation.definitionDigest,
        evaluation: structuredClone(candidate.cad.evaluation) as unknown as JSONObject,
        collision: structuredClone(collision) as unknown as JSONObject,
      },
      durableState: {},
      placement: structuredClone(candidate.placement),
      bindings: [],
      tags: [],
      visibility: "visible",
      locks: { placement: false, resize: false, visualEffects: false, props: false, deletion: false, actions: false },
      provenance: { createdRevision: state.revision, createdBy: "agent" },
    };
  } else if (existing?.type.typeId === "spatial-primitive" || (!existing && hasGeometry)) {
    if (hasAssetIdentity) throw new TypeError("A parametric candidate cannot declare assetId or entityKind");
    const geometryInput = candidate.geometry ?? existing?.props.geometry;
    if (!geometryInput) throw new TypeError("A new parametric candidate requires geometry");
    const geometry: ParametricPrimitive = evaluateParametricGeometry(geometryInput).primitive;
    component = existing ? {
      ...existing,
      placement: structuredClone(candidate.placement),
      props: {
        ...existing.props,
        geometry: structuredClone(geometry) as unknown as JSONObject,
        collision: structuredClone(collision) as unknown as JSONObject,
      },
    } : {
      id: candidateId,
      type: { typeId: "spatial-primitive", version: "candidate", digest: "candidate" },
      label: "Parametric placement candidate",
      props: {
        geometry: structuredClone(geometry) as unknown as JSONObject,
        collision: structuredClone(collision) as unknown as JSONObject,
      },
      durableState: {},
      placement: structuredClone(candidate.placement),
      bindings: [],
      tags: [],
      visibility: "visible",
      locks: { placement: false, resize: false, visualEffects: false, props: false, deletion: false, actions: false },
      provenance: { createdRevision: state.revision, createdBy: "agent" },
    };
  } else {
    if (hasGeometry || hasCad) {
      throw new TypeError("Closed geometry can only create or update a matching spatial-primitive or CAD candidate");
    }
    if (existing && existing.type.typeId !== "spatial-entity") {
      throw new TypeError(`Component ${existing.id} is not a spatial placement candidate`);
    }
    const assetId = candidate.assetId
      ?? (typeof existing?.props.assetId === "string" ? existing.props.assetId : undefined);
    const entityKind = candidate.entityKind
      ?? (typeof existing?.props.entityKind === "string" ? existing.props.entityKind : undefined);
    if (!assetId || !entityKind) {
      throw new TypeError("A new asset candidate requires assetId and entityKind, or closed geometry");
    }
    const asset = DEFAULT_ASSET_REGISTRY.get(assetId);
    if (!asset || asset.kind !== entityKind) {
      throw new TypeError("Candidate asset and entity kind do not match the asset registry");
    }
    component = existing ? {
      ...existing,
      placement: structuredClone(candidate.placement),
      props: { ...existing.props, assetId, entityKind, collision: structuredClone(collision) as unknown as JSONObject },
    } : {
      id: candidateId,
      type: { typeId: "spatial-entity", version: "candidate", digest: "candidate" },
      label: "Placement candidate",
      props: { assetId, entityKind, collision: structuredClone(collision) as unknown as JSONObject },
      durableState: {},
      placement: structuredClone(candidate.placement),
      bindings: [],
      tags: [],
      visibility: "visible",
      locks: { placement: false, resize: false, visualEffects: false, props: false, deletion: false, actions: false },
      provenance: { createdRevision: state.revision, createdBy: "agent" },
    };
  }
  components.set(candidateId, component);
  return { state: { ...state, components }, candidateId };
}

function suggestedPlacements(
  placement: World3DPlacement,
  candidate: SemaFrameSpatialGraphNode,
  conflicts: readonly SemaFrameSpatialGraphNode[],
): ComponentPlacement[] {
  if (!conflicts.length) return [];
  const suggestions: Array<{ distance: number; placement: World3DPlacement }> = [];
  const candidateBounds = candidate.collision?.aabb ?? candidate.worldBounds;
  const clearance = 0.02;
  for (const axis of ["x", "z"] as const) {
    const positive = Math.max(...conflicts.map((conflict) => {
      const bounds = conflict.collision?.aabb ?? conflict.worldBounds;
      return bounds.max[axis] - candidateBounds.min[axis] + clearance;
    }));
    const negative = Math.max(...conflicts.map((conflict) => {
      const bounds = conflict.collision?.aabb ?? conflict.worldBounds;
      return candidateBounds.max[axis] - bounds.min[axis] + clearance;
    }));
    for (const delta of [positive, -negative]) {
      const position = { ...placement.position, [axis]: placement.position[axis] + delta };
      suggestions.push({
        distance: Math.abs(delta),
        placement: { ...structuredClone(placement), position },
      });
    }
  }
  return suggestions
    .sort((left, right) => left.distance - right.distance
      || JSON.stringify(left.placement).localeCompare(JSON.stringify(right.placement)))
    .slice(0, 4)
    .map((entry) => entry.placement);
}

export function querySpatialPlacement(
  state: Readonly<WorkspaceState>,
  candidate: SpatialPlacementCandidate,
): SpatialPlacementCheck {
  const prepared = cloneStateWithSpatialCandidate(state, candidate);
  const nodes = createSpatialNodes(prepared.state);
  const targets = new Set([prepared.candidateId]);
  const allConflicts = collisionPairs(nodes, { maxConflicts: 1_000, targetIds: targets });
  const conflicts = allConflicts.filter((conflict) =>
    conflict.componentId === prepared.candidateId || conflict.conflictsWith === prepared.candidateId);
  const candidateNode = nodes.find((node) => node.id === prepared.candidateId);
  const conflictIds = new Set(conflicts.flatMap((conflict) => [conflict.componentId, conflict.conflictsWith])
    .filter((id) => id !== prepared.candidateId));
  const conflictNodes = nodes.filter((node) => conflictIds.has(node.id));
  const rawSuggestions = candidateNode
    ? suggestedPlacements(candidate.placement as World3DPlacement, candidateNode, conflictNodes)
    : [];
  const safeSuggestions = rawSuggestions.filter((placement) => {
    const components = new Map(prepared.state.components);
    const component = components.get(prepared.candidateId);
    if (!component) return false;
    components.set(prepared.candidateId, { ...component, placement: structuredClone(placement) });
    return collisionPairs(createSpatialNodes({ ...prepared.state, components }), {
      maxConflicts: 1,
      targetIds: targets,
    }).length === 0;
  });
  return {
    valid: conflicts.length === 0,
    candidateId: prepared.candidateId,
    conflicts,
    suggestedPlacements: safeSuggestions,
  };
}
