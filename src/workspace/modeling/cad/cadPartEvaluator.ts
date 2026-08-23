import type { Face, Shape3D, Wire } from "replicad";
import type { CadIndexedMesh, CadRuntime } from "../cadKernel";
import {
  CAD_PART_EVALUATOR_VERSION,
  CAD_PART_LIMITS,
  CAD_EVALUATION_EVIDENCE_FORMAT_VERSION,
  cadPartDefinitionDigest,
  parseCadPartDefinition,
  parseCadEvaluationEvidence,
  type CadBoundsV1,
  type CadEvaluationBodyEvidenceV1,
  type CadEvaluationDiagnosticV1,
  type CadEvaluationEvidenceV1,
  type CadPartDefinitionV1,
} from "./cadDocument";
import type { CadFeature, CadProfileOperation, CadProfileRef } from "./cadFeatures";
import {
  evaluateCadAngle,
  evaluateCadExpression,
  evaluateCadLength,
  evaluateCadParameters,
} from "./cadParameters";
import {
  CAD_SKETCH_SOLVER_VERSION,
  solveCadSketch,
  type CadPoint2,
  type CadSketchEntity,
  type CadSketchPlane,
  type CadVector3,
} from "./cadSketch";

export type CadEvaluatedBodyMeshV1 = Readonly<{
  bodyId: string;
  mesh: CadIndexedMesh;
}>;

export type CadPartEvaluationResultV1 = Readonly<{
  evidence: CadEvaluationEvidenceV1;
  meshes: readonly CadEvaluatedBodyMeshV1[];
}>;

export type CadPartEvaluationOptions = Readonly<{
  linearDeflectionM?: number;
  angularDeflectionRad?: number;
  /** Evidence-only callers can skip all tessellation and transferable buffers. */
  includeMeshes?: boolean;
}>;

/** Borrowed OCCT wrapper. It is valid only during withEvaluatedCadPartShapes' callback. */
export type CadEvaluatedBodyShapeInternal = Readonly<{
  bodyId: string;
  shape: Shape3D;
}>;

export class CadPartEvaluationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_cad_part"
      | "invalid_sketch_profile"
      | "feature_evaluation_failed"
      | "unsupported_cad_feature"
      | "invalid_brep"
      | "active_body_not_single_solid"
      | "cad_operation_no_effect"
      | "cad_operation_empty_result"
      | "mesh_limit_exceeded",
    readonly featureId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CadPartEvaluationError";
  }
}

type SketchFeature = Extract<CadFeature, { kind: "sketch" }>;

function tuple(value: CadVector3): [number, number, number] {
  return [value.x, value.y, value.z];
}

function normalize(value: CadVector3, context: string): CadVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length < 1e-12) {
    throw new CadPartEvaluationError(`${context} axis is degenerate`, "feature_evaluation_failed", context);
  }
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function localPoint(plane: CadSketchPlane, point: CadPoint2): [number, number, number] {
  return [
    plane.originM.x + plane.xAxis.x * point.x + plane.yAxis.x * point.y,
    plane.originM.y + plane.xAxis.y * point.x + plane.yAxis.y * point.y,
    plane.originM.z + plane.xAxis.z * point.x + plane.yAxis.z * point.y,
  ];
}

function safeDelete(value: { delete(): void } | undefined): void {
  if (!value) return;
  try { value.delete(); } catch { /* A failed OCCT operation can consume wrappers. */ }
}

function entityEdge(
  runtime: CadRuntime,
  plane: CadSketchPlane,
  entity: CadSketchEntity,
) {
  if (entity.kind === "line") {
    return runtime.replicad.makeLine(localPoint(plane, entity.start), localPoint(plane, entity.end));
  }
  if (entity.kind === "circle") {
    return runtime.replicad.makeCircle(
      entity.radiusM,
      localPoint(plane, entity.center),
      tuple(plane.normal),
    );
  }
  return runtime.replicad.makeThreePointArc(
    localPoint(plane, entity.start),
    localPoint(plane, entity.mid),
    localPoint(plane, entity.end),
  );
}

function profileFace(
  runtime: CadRuntime,
  feature: SketchFeature,
  solvedEntities: readonly CadSketchEntity[],
  profile: CadProfileRef,
): Face {
  const entities = new Map(solvedEntities.map((entity) => [entity.id, entity]));
  const requested = profile.loopIds.map((loopId) => {
    const loop = feature.sketch.loops.find((candidate) => candidate.id === loopId);
    if (!loop) throw new CadPartEvaluationError(`Unknown profile loop ${loopId}`, "invalid_sketch_profile", feature.id);
    return loop;
  });
  const outer = requested.filter((loop) => loop.role === "outer");
  if (outer.length !== 1) {
    throw new CadPartEvaluationError(
      `Profile ${feature.id} requires exactly one outer loop in CAD V1`,
      "invalid_sketch_profile",
      feature.id,
    );
  }
  const wires: Wire[] = [];
  try {
    for (const loop of [outer[0]!, ...requested.filter((candidate) => candidate.role === "hole")]) {
      const edges = loop.entityIds.map((entityId) => {
        const entity = entities.get(entityId);
        if (!entity) throw new CadPartEvaluationError(`Unknown loop entity ${entityId}`, "invalid_sketch_profile", feature.id);
        return entityEdge(runtime, feature.sketch.plane, entity);
      });
      try {
        wires.push(runtime.replicad.assembleWire(edges));
      } finally {
        for (const edge of edges) safeDelete(edge);
      }
    }
    return runtime.replicad.makeFace(wires[0]!, wires.slice(1));
  } catch (error) {
    if (error instanceof CadPartEvaluationError) throw error;
    throw new CadPartEvaluationError(
      `Sketch ${feature.id} could not produce a closed planar face`,
      "invalid_sketch_profile",
      feature.id,
      { cause: error },
    );
  } finally {
    for (const wire of wires) safeDelete(wire);
  }
}

function validShape(runtime: CadRuntime, shape: Shape3D): boolean {
  if (shape.isNull) return false;
  const analyzer = new runtime.oc.BRepCheck_Analyzer(shape.wrapped, true, false, true);
  try { return analyzer.IsValid(); } finally { analyzer.delete(); }
}

function solidCount(runtime: CadRuntime, shape: Shape3D): number {
  const explorer = new runtime.oc.TopExp_Explorer(
    shape.wrapped,
    runtime.oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    runtime.oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  try {
    let count = 0;
    while (explorer.More()) {
      count += 1;
      explorer.Next();
    }
    return count;
  } finally {
    explorer.delete();
  }
}

function assertSingleSolidActiveBody(
  runtime: CadRuntime,
  bodyId: string,
  shape: Shape3D,
): void {
  const count = solidCount(runtime, shape);
  if (count !== 1) {
    throw new CadPartEvaluationError(
      `Active body ${bodyId} contains ${count} OCCT solids; exactly one solid is required`,
      "active_body_not_single_solid",
    );
  }
}

function measuredVolume(runtime: CadRuntime, shape: Shape3D): number {
  const properties = runtime.replicad.measureShapeVolumeProperties(shape);
  try {
    return properties.volume;
  } finally {
    properties.delete();
  }
}

function hasVolumetricMaterial(runtime: CadRuntime, shape: Shape3D): boolean {
  if (shape.isNull || !validShape(runtime, shape) || solidCount(runtime, shape) === 0) return false;
  const volume = measuredVolume(runtime, shape);
  return Number.isFinite(volume) && volume > 0;
}

function assertVolumetricOverlap(
  runtime: CadRuntime,
  first: Shape3D,
  second: Shape3D,
  featureId: string,
  noOverlapMessage: string,
  code: "cad_operation_no_effect" | "cad_operation_empty_result",
): void {
  let overlap: Shape3D;
  try {
    overlap = first.intersect(second);
  } catch (error) {
    throw new CadPartEvaluationError(
      `Feature ${featureId} could not determine volumetric overlap`,
      "feature_evaluation_failed",
      featureId,
      { cause: error },
    );
  }
  try {
    if (!hasVolumetricMaterial(runtime, overlap)) {
      throw new CadPartEvaluationError(noOverlapMessage, code, featureId);
    }
  } finally {
    safeDelete(overlap);
  }
}

function assertCutChangedBody(
  runtime: CadRuntime,
  target: Shape3D,
  result: Shape3D,
  featureId: string,
  noEffectMessage: string,
): Shape3D {
  try {
    if (!hasVolumetricMaterial(runtime, result)) {
      throw new CadPartEvaluationError(
        `Feature ${featureId} subtract produced no solid body`,
        "cad_operation_empty_result",
        featureId,
      );
    }
    const targetVolume = measuredVolume(runtime, target);
    const resultVolume = measuredVolume(runtime, result);
    // Deliberately use a scale-free monotonic comparison here. An absolute
    // epsilon would incorrectly reject valid micron-scale CAD operations.
    if (!Number.isFinite(targetVolume)
      || !Number.isFinite(resultVolume)
      || !(resultVolume < targetVolume)) {
      throw new CadPartEvaluationError(noEffectMessage, "cad_operation_no_effect", featureId);
    }
    return result;
  } catch (error) {
    safeDelete(result);
    throw error;
  }
}

function assertIntersectionResult(
  runtime: CadRuntime,
  result: Shape3D,
  featureId: string,
  emptyMessage: string,
): Shape3D {
  try {
    if (hasVolumetricMaterial(runtime, result)) return result;
    throw new CadPartEvaluationError(emptyMessage, "cad_operation_empty_result", featureId);
  } catch (error) {
    safeDelete(result);
    throw error;
  }
}

function assertFeatureShape(
  runtime: CadRuntime,
  shape: Shape3D,
  featureId: string,
): Shape3D {
  if (validShape(runtime, shape)) return shape;
  safeDelete(shape);
  throw new CadPartEvaluationError(
    `Feature ${featureId} produced an invalid B-rep`,
    "invalid_brep",
    featureId,
  );
}

function boundsFor(shape: Shape3D): CadBoundsV1 {
  const box = shape.boundingBox;
  try {
    const [min, max] = box.bounds;
    const size = { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
    return {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] },
      size,
      center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
    };
  } finally {
    box.delete();
  }
}

function bodyEvidence(runtime: CadRuntime, bodyId: string, shape: Shape3D): CadEvaluationBodyEvidenceV1 {
  if (!validShape(runtime, shape)) throw new CadPartEvaluationError(`Body ${bodyId} is not a valid B-rep`, "invalid_brep");
  const volume = runtime.replicad.measureShapeVolumeProperties(shape);
  const surface = runtime.replicad.measureShapeSurfaceProperties(shape);
  try {
    const values = [volume.volume, surface.area, ...volume.centerOfMass];
    if (values.some((value) => !Number.isFinite(value)) || volume.volume <= 0 || surface.area <= 0) {
      throw new CadPartEvaluationError(`Body ${bodyId} has invalid physical properties`, "invalid_brep");
    }
    return Object.freeze({
      bodyId,
      bounds: boundsFor(shape),
      volumeM3: volume.volume,
      surfaceAreaM2: surface.area,
      centerOfMassM: {
        x: volume.centerOfMass[0],
        y: volume.centerOfMass[1],
        z: volume.centerOfMass[2],
      },
      valid: true,
    });
  } finally {
    volume.delete();
    surface.delete();
  }
}

function meshFor(shape: Shape3D, options: CadPartEvaluationOptions): CadIndexedMesh {
  const linear = options.linearDeflectionM ?? 0.001;
  const angular = options.angularDeflectionRad ?? 0.2;
  if (!Number.isFinite(linear) || linear < 1e-5 || linear > 100
    || !Number.isFinite(angular) || angular < 1e-3 || angular > Math.PI) {
    throw new CadPartEvaluationError("CAD tessellation tolerances are outside the bounded range", "mesh_limit_exceeded");
  }
  const bounds = boundsFor(shape);
  const largestExtent = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
  if (largestExtent / linear > 100_000) {
    throw new CadPartEvaluationError(
      "CAD tessellation deflection is too fine for the evaluated body extent",
      "mesh_limit_exceeded",
    );
  }
  const raw = shape.mesh({ tolerance: linear, angularTolerance: angular });
  const vertexCount = raw.vertices.length / 3;
  const triangleCount = raw.triangles.length / 3;
  if (vertexCount > CAD_PART_LIMITS.maximumMeshVertices
    || triangleCount > CAD_PART_LIMITS.maximumMeshTriangles
    || raw.faceGroups.length > CAD_PART_LIMITS.maximumMeshFaceGroups) {
    throw new CadPartEvaluationError("CAD tessellation exceeds the bounded mesh limits", "mesh_limit_exceeded");
  }
  return Object.freeze({
    positions: Float32Array.from(raw.vertices),
    normals: Float32Array.from(raw.normals),
    indices: Uint32Array.from(raw.triangles),
    groups: Object.freeze(raw.faceGroups.map((group) => Object.freeze({ ...group }))),
    bounds,
  });
}

function combineBounds(bodies: readonly CadEvaluationBodyEvidenceV1[]): CadBoundsV1 {
  if (!bodies.length) throw new CadPartEvaluationError("CAD part has no active solid body", "invalid_cad_part");
  const min = {
    x: Math.min(...bodies.map((body) => body.bounds.min.x)),
    y: Math.min(...bodies.map((body) => body.bounds.min.y)),
    z: Math.min(...bodies.map((body) => body.bounds.min.z)),
  };
  const max = {
    x: Math.max(...bodies.map((body) => body.bounds.max.x)),
    y: Math.max(...bodies.map((body) => body.bounds.max.y)),
    z: Math.max(...bodies.map((body) => body.bounds.max.z)),
  };
  return {
    min,
    max,
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  };
}

function throughAllHoleTool(
  bounds: CadBoundsV1,
  direction: CadVector3,
  center: CadVector3,
  featureId: string,
): Readonly<{ depth: number; location: CadVector3 }> {
  // Project the target's AABB onto the normalized axis without materializing
  // all eight corners. The caller-provided center defines only the infinite
  // axis line; its longitudinal coordinate must not limit a through-all cut.
  let minimumProjection = 0;
  let maximumProjection = 0;
  for (const axis of ["x", "y", "z"] as const) {
    const first = direction[axis] * bounds.min[axis];
    const second = direction[axis] * bounds.max[axis];
    minimumProjection += Math.min(first, second);
    maximumProjection += Math.max(first, second);
  }
  const projectedSpan = maximumProjection - minimumProjection;
  if (!Number.isFinite(minimumProjection)
    || !Number.isFinite(maximumProjection)
    || !Number.isFinite(projectedSpan)
    || projectedSpan <= 0) {
    throw new CadPartEvaluationError(
      `Hole ${featureId} could not derive a bounded through-all interval`,
      "feature_evaluation_failed",
      featureId,
    );
  }

  // A small, scale-aware extension ensures the cutter clears both support
  // planes. Its total length stays tightly bounded by the target projection,
  // rather than growing with a remote caller center.
  const padding = Math.max(CAD_PART_LIMITS.minimumLengthM, projectedSpan * 1e-6);
  const startProjection = minimumProjection - padding;
  const depth = projectedSpan + padding * 2;
  const centerProjection = center.x * direction.x
    + center.y * direction.y
    + center.z * direction.z;
  const longitudinalOffset = startProjection - centerProjection;
  const location = {
    x: center.x + direction.x * longitudinalOffset,
    y: center.y + direction.y * longitudinalOffset,
    z: center.z + direction.z * longitudinalOffset,
  };
  if (!Number.isFinite(depth)
    || depth <= 0
    || Object.values(location).some((value) => !Number.isFinite(value))) {
    throw new CadPartEvaluationError(
      `Hole ${featureId} produced an invalid through-all tool interval`,
      "feature_evaluation_failed",
      featureId,
    );
  }
  return { depth, location };
}

function profileOperation(
  runtime: CadRuntime,
  operation: CadProfileOperation,
  generated: Shape3D,
  target: Shape3D | undefined,
  targetBodyId: string | undefined,
  featureId: string,
): Shape3D {
  if (operation === "new") return generated;
  if (!target) {
    safeDelete(generated);
    throw new CadPartEvaluationError(
      `Feature ${featureId} has no target body`,
      "feature_evaluation_failed",
      featureId,
    );
  }
  try {
    if (operation === "cut") {
      assertVolumetricOverlap(
        runtime,
        target,
        generated,
        featureId,
        `Profile cut ${featureId} is off-body: generated solid has no volumetric overlap with target body ${targetBodyId}`,
        "cad_operation_no_effect",
      );
    }
    const result = operation === "join"
      ? target.fuse(generated)
      : operation === "cut"
        ? target.cut(generated)
        : target.intersect(generated);
    if (operation === "cut") {
      return assertCutChangedBody(
        runtime,
        target,
        result,
        featureId,
        `Profile cut ${featureId} did not remove material from target body ${targetBodyId}`,
      );
    }
    if (operation === "intersect") {
      return assertIntersectionResult(
        runtime,
        result,
        featureId,
        `Profile intersection ${featureId} is empty: generated solid has no volumetric overlap with target body ${targetBodyId}`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof CadPartEvaluationError) throw error;
    throw new CadPartEvaluationError(
      `Feature ${featureId} ${operation} failed`,
      "feature_evaluation_failed",
      featureId,
      { cause: error },
    );
  } finally {
    safeDelete(generated);
  }
}

function replaceBody(bodies: Map<string, Shape3D>, bodyId: string, shape: Shape3D): void {
  const previous = bodies.get(bodyId);
  if (previous && previous !== shape) safeDelete(previous);
  bodies.set(bodyId, shape);
}

/**
 * Internal same-runtime ownership seam for exact CAD handoff. Shape wrappers
 * are borrowed, must not escape the synchronous callback, and are always
 * deleted after it returns or throws.
 */
export function withEvaluatedCadPartShapes<T>(
  runtime: CadRuntime,
  definitionInput: CadPartDefinitionV1,
  callback: (
    bodies: readonly CadEvaluatedBodyShapeInternal[],
    evidence: CadEvaluationEvidenceV1,
  ) => T,
): T {
  const definition = parseCadPartDefinition(definitionInput);
  const parameters = evaluateCadParameters(definition.parameters).byId;
  const sketches = new Map<string, { feature: SketchFeature; entities: readonly CadSketchEntity[] }>();
  const bodies = new Map<string, Shape3D>();
  const diagnostics: CadEvaluationDiagnosticV1[] = [];
  try {
    for (const feature of definition.history) {
      if (feature.suppressed) {
        diagnostics.push({
          code: "feature_suppressed",
          severity: "info",
          message: `Feature ${feature.id} was suppressed`,
          featureId: feature.id,
        });
        continue;
      }
      try {
        if (feature.kind === "sketch") {
          const solved = solveCadSketch(feature.sketch, parameters);
          if (solved.status === "over_constrained") {
            throw new CadPartEvaluationError(
              `Sketch ${feature.id} is over-constrained (${solved.conflictingConstraintIds.join(", ")})`,
              "feature_evaluation_failed",
              feature.id,
            );
          }
          if (solved.status === "under_constrained") {
            diagnostics.push({
              code: "sketch_under_constrained",
              severity: "warning",
              message: `Sketch ${feature.id} has ${solved.degreesOfFreedom} remaining degrees of freedom`,
              featureId: feature.id,
            });
          }
          sketches.set(feature.id, { feature, entities: solved.entities });
          diagnostics.push({
            code: "sketch_solved",
            severity: "info",
            message: `Sketch ${feature.id} solved as ${solved.status}`,
            featureId: feature.id,
          });
          continue;
        }
        if (feature.kind === "extrude" || feature.kind === "revolve") {
          const sketch = sketches.get(feature.profile.sketchFeatureId);
          if (!sketch) throw new CadPartEvaluationError(`Missing sketch ${feature.profile.sketchFeatureId}`, "invalid_sketch_profile", feature.id);
          const face = profileFace(runtime, sketch.feature, sketch.entities, feature.profile);
          let generated: Shape3D;
          try {
            if (feature.kind === "extrude") {
              const distance = evaluateCadLength(feature.distance, parameters, feature.id);
              const normal = sketch.feature.sketch.plane.normal;
              const vector = new runtime.replicad.Vector([
                normal.x * distance,
                normal.y * distance,
                normal.z * distance,
              ]);
              try { generated = runtime.replicad.basicFaceExtrusion(face, vector); } finally { vector.delete(); }
              if (feature.symmetric) {
                generated = generated.translate([
                  -normal.x * distance / 2,
                  -normal.y * distance / 2,
                  -normal.z * distance / 2,
                ]);
              }
            } else {
              const angleDeg = evaluateCadAngle(feature.angle, parameters, feature.id) * 180 / Math.PI;
              generated = runtime.replicad.revolution(
                face,
                tuple(feature.axis.originM),
                tuple(normalize(feature.axis.direction, feature.id)),
                angleDeg,
              );
            }
          } finally {
            face.delete();
          }
          const result = profileOperation(
            runtime,
            feature.operation,
            generated,
            feature.targetBodyId ? bodies.get(feature.targetBodyId) : undefined,
            feature.targetBodyId,
            feature.id,
          );
          replaceBody(bodies, feature.resultBodyId, assertFeatureShape(runtime, result, feature.id));
          diagnostics.push({
            code: "feature_evaluated",
            severity: "info",
            message: `Feature ${feature.id} evaluated to body ${feature.resultBodyId}`,
            featureId: feature.id,
          });
          continue;
        }
        if (feature.kind === "boolean") {
          const left = bodies.get(feature.leftBodyId)!;
          const right = bodies.get(feature.rightBodyId)!;
          if (feature.operation === "cut") {
            assertVolumetricOverlap(
              runtime,
              left,
              right,
              feature.id,
              `Boolean cut ${feature.id} is disjoint: bodies ${feature.leftBodyId} and ${feature.rightBodyId} have no volumetric overlap`,
              "cad_operation_no_effect",
            );
          }
          const result = feature.operation === "union"
            ? left.fuse(right)
            : feature.operation === "cut"
              ? left.cut(right)
              : left.intersect(right);
          const semanticResult = feature.operation === "cut"
            ? assertCutChangedBody(
                runtime,
                left,
                result,
                feature.id,
                `Boolean cut ${feature.id} did not remove material from body ${feature.leftBodyId}`,
              )
            : feature.operation === "intersect"
              ? assertIntersectionResult(
                  runtime,
                  result,
                  feature.id,
                  `Boolean intersection ${feature.id} is empty: bodies ${feature.leftBodyId} and ${feature.rightBodyId} have no volumetric overlap`,
                )
              : result;
          replaceBody(bodies, feature.resultBodyId, assertFeatureShape(runtime, semanticResult, feature.id));
          diagnostics.push({
            code: "feature_evaluated",
            severity: "info",
            message: `Feature ${feature.id} evaluated to body ${feature.resultBodyId}`,
            featureId: feature.id,
          });
          continue;
        }
        if (feature.kind === "hole") {
          const target = bodies.get(feature.targetBodyId)!;
          const radius = evaluateCadLength(feature.diameter, parameters, feature.id) / 2;
          const direction = normalize(feature.axis, feature.id);
          const targetBounds = boundsFor(target);
          const throughAllTool = feature.throughAll
            ? throughAllHoleTool(targetBounds, direction, feature.centerM, feature.id)
            : undefined;
          const depth = throughAllTool?.depth
            ?? evaluateCadLength(feature.depth!, parameters, feature.id);
          const location = throughAllTool?.location ?? feature.centerM;
          const tool = runtime.replicad.makeCylinder(radius, depth, tuple(location), tuple(direction));
          let result: Shape3D;
          try {
            assertVolumetricOverlap(
              runtime,
              target,
              tool,
              feature.id,
              `Hole ${feature.id} is off-body: cutter has no volumetric overlap with target body ${feature.targetBodyId}`,
              "cad_operation_no_effect",
            );
            result = target.cut(tool);
          } finally {
            safeDelete(tool);
          }
          const semanticResult = assertCutChangedBody(
            runtime,
            target,
            result,
            feature.id,
            `Hole ${feature.id} did not remove material from target body ${feature.targetBodyId}`,
          );
          replaceBody(bodies, feature.resultBodyId, assertFeatureShape(runtime, semanticResult, feature.id));
          diagnostics.push({
            code: "feature_evaluated",
            severity: "info",
            message: `Feature ${feature.id} evaluated to body ${feature.resultBodyId}`,
            featureId: feature.id,
          });
          continue;
        }
        if (feature.kind === "fillet" || feature.kind === "chamfer") {
          if (!feature.edges.every((edge) => edge.role === "all_edges")) {
            throw new CadPartEvaluationError(
              `${feature.kind} ${feature.id} requires stable topology resolution; CAD V1 only accepts explicit all_edges selectors`,
              "unsupported_cad_feature",
              feature.id,
            );
          }
          const target = bodies.get(feature.targetBodyId)!;
          const amount = evaluateCadLength(
            feature.kind === "fillet" ? feature.radius : feature.distance,
            parameters,
            feature.id,
          );
          const result = feature.kind === "fillet" ? target.fillet(amount) : target.chamfer(amount);
          replaceBody(bodies, feature.resultBodyId, assertFeatureShape(runtime, result, feature.id));
          diagnostics.push({
            code: "feature_evaluated",
            severity: "info",
            message: `Feature ${feature.id} evaluated to body ${feature.resultBodyId}`,
            featureId: feature.id,
          });
          continue;
        }
        throw new CadPartEvaluationError(
          `Feature ${feature.id} (${feature.kind}) is declared but not evaluated by CAD V1`,
          "unsupported_cad_feature",
          feature.id,
        );
      } catch (error) {
        if (error instanceof CadPartEvaluationError) throw error;
        throw new CadPartEvaluationError(
          `Feature ${feature.id} (${feature.kind}) failed: ${error instanceof Error ? error.message : String(error)}`,
          "feature_evaluation_failed",
          feature.id,
          { cause: error },
        );
      }
    }

    const activeShapes = Object.freeze(definition.activeBodyIds.map((bodyId) => {
      const shape = bodies.get(bodyId);
      if (!shape) throw new CadPartEvaluationError(`Active body ${bodyId} was not evaluated`, "invalid_cad_part");
      assertSingleSolidActiveBody(runtime, bodyId, shape);
      return Object.freeze({ bodyId, shape });
    }));
    const evidenceBodies = activeShapes.map(({ bodyId, shape }) => bodyEvidence(runtime, bodyId, shape));
    const evidence = parseCadEvaluationEvidence({
      formatVersion: CAD_EVALUATION_EVIDENCE_FORMAT_VERSION,
      definitionDigest: cadPartDefinitionDigest(definition),
      evaluatorVersion: CAD_PART_EVALUATOR_VERSION,
      sketchSolverVersion: CAD_SKETCH_SOLVER_VERSION,
      exactness: "brep",
      status: "valid",
      bodies: Object.freeze(evidenceBodies),
      overallBounds: combineBounds(evidenceBodies),
      diagnostics: Object.freeze(diagnostics),
    }, definition);
    const result = callback(activeShapes, evidence);
    if ((typeof result === "object" && result !== null) || typeof result === "function") {
      if ("then" in result && typeof result.then === "function") {
        throw new CadPartEvaluationError(
          "Exact CAD shape callbacks must finish synchronously before OCCT wrappers are released",
          "invalid_cad_part",
        );
      }
    }
    return result;
  } finally {
    for (const shape of new Set(bodies.values())) safeDelete(shape);
    bodies.clear();
  }
}

/** Evaluate an immutable CAD document into transferable meshes and replay evidence. */
export function evaluateCadPartWithRuntime(
  runtime: CadRuntime,
  definitionInput: CadPartDefinitionV1,
  options: CadPartEvaluationOptions = {},
): CadPartEvaluationResultV1 {
  return withEvaluatedCadPartShapes(runtime, definitionInput, (bodies, evidence) => {
    if (options.includeMeshes === false) {
      return Object.freeze({ evidence, meshes: Object.freeze([]) });
    }
    let vertices = 0;
    let triangles = 0;
    let faceGroups = 0;
    let bytes = 0;
    const meshes = bodies.map(({ bodyId, shape }) => {
      const mesh = meshFor(shape, options);
      vertices += mesh.positions.length / 3;
      triangles += mesh.indices.length / 3;
      faceGroups += mesh.groups.length;
      bytes += mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength
        + mesh.groups.length * 12;
      if (vertices > CAD_PART_LIMITS.maximumMeshVertices
        || triangles > CAD_PART_LIMITS.maximumMeshTriangles
        || faceGroups > CAD_PART_LIMITS.maximumMeshFaceGroups
        || bytes > CAD_PART_LIMITS.maximumMeshBytes) {
        throw new CadPartEvaluationError(
          "CAD part tessellation exceeds the aggregate mesh limits",
          "mesh_limit_exceeded",
          bodyId,
        );
      }
      return Object.freeze({ bodyId, mesh });
    });
    return Object.freeze({ evidence, meshes: Object.freeze(meshes) });
  });
}
