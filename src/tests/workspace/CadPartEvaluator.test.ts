// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAD_PART_DEFINITION_FORMAT_VERSION,
  DEFAULT_CAD_SKETCH_PLANE,
  cadAngleExpression,
  cadLengthExpression,
  parseCadEvaluationEvidence,
  type CadFeature,
  type CadPartDefinitionV1,
  type CadSketchPlane,
} from "../../workspace/modeling/cad";
import {
  CadKernelError,
  loadCadKernel,
  type CadKernel,
} from "../../workspace/modeling/cadKernel";

let kernel: CadKernel;

function rectangleSketch(
  id: string,
  minimum: readonly [number, number],
  maximum: readonly [number, number],
  plane: CadSketchPlane = DEFAULT_CAD_SKETCH_PLANE,
): Extract<CadFeature, { kind: "sketch" }> {
  const [x0, y0] = minimum;
  const [x1, y1] = maximum;
  return {
    id,
    name: id,
    kind: "sketch",
    sketch: {
      plane,
      entities: [
        { id: `${id}_bottom`, kind: "line", start: { x: x0, y: y0 }, end: { x: x1, y: y0 } },
        { id: `${id}_right`, kind: "line", start: { x: x1, y: y0 }, end: { x: x1, y: y1 } },
        { id: `${id}_top`, kind: "line", start: { x: x1, y: y1 }, end: { x: x0, y: y1 } },
        { id: `${id}_left`, kind: "line", start: { x: x0, y: y1 }, end: { x: x0, y: y0 } },
      ],
      loops: [{
        id: "outer",
        role: "outer",
        entityIds: [`${id}_bottom`, `${id}_right`, `${id}_top`, `${id}_left`],
      }],
      constraints: [],
    },
  };
}

function part(
  partId: string,
  history: readonly CadFeature[],
  activeBodyIds: readonly string[],
): CadPartDefinitionV1 {
  return {
    formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
    partId,
    displayName: partId,
    units: "metre",
    parameters: [],
    history,
    activeBodyIds,
  };
}

function extrude(
  id: string,
  sketchFeatureId: string,
  resultBodyId: string,
): Extract<CadFeature, { kind: "extrude" }> {
  return {
    id,
    name: id,
    kind: "extrude",
    profile: { sketchFeatureId, loopIds: ["outer"] },
    distance: cadLengthExpression(0.5),
    operation: "new",
    resultBodyId,
  };
}

beforeAll(async () => {
  kernel = await loadCadKernel();
}, 30_000);

afterAll(async () => {
  await kernel.dispose();
});

describe("OCCT CAD part feature evaluator", () => {
  it("evaluates sketch/extrude and through-hole history into B-rep evidence and a mesh", async () => {
    const definition = part("drilled_plate", [
      rectangleSketch("plate_profile", [0, 0], [2, 1]),
      extrude("plate_extrude", "plate_profile", "plate"),
      {
        id: "center_hole",
        name: "Center hole",
        kind: "hole",
        targetBodyId: "plate",
        resultBodyId: "drilled_plate",
        centerM: { x: 1, y: 0.5, z: 0.25 },
        axis: { x: 0, y: 0, z: 1 },
        diameter: cadLengthExpression(0.2),
        throughAll: true,
      },
    ], ["drilled_plate"]);
    const result = await kernel.evaluatePart(definition);

    expect(result.evidence.status).toBe("valid");
    expect(result.evidence.exactness).toBe("brep");
    expect(result.evidence.bodies[0]!.volumeM3).toBeCloseTo(1 - Math.PI * 0.1 ** 2 * 0.5, 6);
    expect(result.evidence.overallBounds.size).toMatchObject({
      x: expect.closeTo(2, 5),
      y: expect.closeTo(1, 5),
      z: expect.closeTo(0.5, 5),
    });
    expect(result.evidence.diagnostics).toContainEqual(expect.objectContaining({
      code: "sketch_under_constrained",
      featureId: "plate_profile",
    }));
    expect(result.meshes[0]!.mesh.positions).toBeInstanceOf(Float32Array);
    expect(result.meshes[0]!.mesh.indices.length).toBeGreaterThan(0);
    const evidenceOnly = await kernel.evaluatePart(definition, { includeMeshes: false });
    expect(evidenceOnly.evidence).toEqual(result.evidence);
    expect(evidenceOnly.meshes).toEqual([]);
    expect(parseCadEvaluationEvidence(result.evidence, definition)).toEqual(result.evidence);
    expect(() => parseCadEvaluationEvidence({
      ...result.evidence,
      definitionDigest: "fnv1a32:00000000",
    }, definition)).toThrowError(/definitionDigest/u);
    expect(() => parseCadEvaluationEvidence({
      ...result.evidence,
      overallBounds: {
        ...result.evidence.overallBounds,
        size: { ...result.evidence.overallBounds.size, x: 99 },
      },
    }, definition)).toThrowError(/internally inconsistent/u);
  });

  it("evaluates revolve and boolean histories with deterministic evidence", async () => {
    const revolved = part("revolved_ring", [
      rectangleSketch("ring_profile", [1, -0.5], [2, 0.5]),
      {
        id: "ring_revolve",
        name: "Ring revolve",
        kind: "revolve",
        profile: { sketchFeatureId: "ring_profile", loopIds: ["outer"] },
        axis: { originM: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
        angle: cadAngleExpression(Math.PI * 2),
        operation: "new",
        resultBodyId: "ring",
      },
    ], ["ring"]);
    const first = await kernel.evaluatePart(revolved);
    const second = await kernel.evaluatePart(revolved);
    expect(first.evidence.definitionDigest).toBe(second.evidence.definitionDigest);
    expect(first.evidence.bodies[0]!.volumeM3).toBeCloseTo(3 * Math.PI, 6);

    const union = await kernel.evaluatePart(part("union", [
      rectangleSketch("left_profile", [0, 0], [2, 2]),
      extrude("left_extrude", "left_profile", "left"),
      rectangleSketch("right_profile", [0, 0], [2, 2], {
        ...DEFAULT_CAD_SKETCH_PLANE,
        originM: { x: 1, y: 0, z: 0 },
      }),
      extrude("right_extrude", "right_profile", "right"),
      {
        id: "join",
        name: "Join",
        kind: "boolean",
        operation: "union",
        leftBodyId: "left",
        rightBodyId: "right",
        resultBodyId: "union",
      },
    ], ["union"]));
    expect(union.evidence.bodies[0]!.volumeM3).toBeCloseTo(3, 6);
  });

  it("rejects a disjoint boolean union because one active body must contain exactly one OCCT solid", async () => {
    const disjointUnion = part("disjoint_union", [
      rectangleSketch("left_profile", [0, 0], [1, 1]),
      extrude("left_extrude", "left_profile", "left"),
      rectangleSketch("right_profile", [0, 0], [1, 1], {
        ...DEFAULT_CAD_SKETCH_PLANE,
        originM: { x: 3, y: 0, z: 0 },
      }),
      extrude("right_extrude", "right_profile", "right"),
      {
        id: "disjoint_join",
        name: "Disjoint join",
        kind: "boolean",
        operation: "union",
        leftBodyId: "left",
        rightBodyId: "right",
        resultBodyId: "disjoint_body",
      },
    ], ["disjoint_body"]);

    const error = await kernel.evaluatePart(disjointUnion).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CadKernelError);
    expect((error as CadKernelError).code).toBe("cad_part_evaluation_failed");
    expect((error as Error).message).toContain(
      "Active body disjoint_body contains 2 OCCT solids; exactly one solid is required",
    );
  });

  it("rejects an off-body hole instead of accepting an unchanged target", async () => {
    const offBodyHole = part("off_body_hole", [
      rectangleSketch("plate_profile", [0, 0], [1, 1]),
      extrude("plate_extrude", "plate_profile", "plate"),
      {
        id: "missed_hole",
        name: "Missed hole",
        kind: "hole",
        targetBodyId: "plate",
        resultBodyId: "unchanged_plate",
        centerM: { x: 3, y: 2, z: 0.25 },
        axis: { x: 5, y: 0, z: 0 },
        diameter: cadLengthExpression(0.2),
        throughAll: true,
      },
    ], ["unchanged_plate"]);

    const error = await kernel.evaluatePart(offBodyHole).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CadKernelError);
    expect((error as CadKernelError).code).toBe("cad_part_evaluation_failed");
    expect((error as Error).message).toContain(
      "Hole missed_hole is off-body: cutter has no volumetric overlap with target body plate",
    );
  });

  it("spans the full target projection for a remote through-all hole center", async () => {
    const remoteCenterHole = part("remote_center_hole", [
      rectangleSketch("cube_profile", [0, 0], [1, 1]),
      {
        ...extrude("cube_extrude", "cube_profile", "cube"),
        distance: cadLengthExpression(1),
      },
      {
        id: "through_x",
        name: "Through X",
        kind: "hole",
        targetBodyId: "cube",
        resultBodyId: "drilled_cube",
        // This is the reported regression: the old centre-based tool began at
        // x≈0.4 and silently produced only a shallow cut.
        centerM: { x: 3, y: 0.5, z: 0.5 },
        axis: { x: 7, y: 0, z: 0 },
        diameter: cadLengthExpression(0.2),
        throughAll: true,
      },
    ], ["drilled_cube"]);

    const first = await kernel.evaluatePart(remoteCenterHole, { includeMeshes: false });
    const second = await kernel.evaluatePart(remoteCenterHole, { includeMeshes: false });
    const expectedVolume = 1 - Math.PI * 0.1 ** 2;
    expect(first.evidence.bodies[0]!.volumeM3).toBeCloseTo(expectedVolume, 8);
    expect(second.evidence).toEqual(first.evidence);
  });

  it("rejects disjoint subtract and empty intersection operations explicitly", async () => {
    const disjointHistory: CadFeature[] = [
      rectangleSketch("left_profile", [0, 0], [1, 1]),
      extrude("left_extrude", "left_profile", "left"),
      rectangleSketch("right_profile", [0, 0], [1, 1], {
        ...DEFAULT_CAD_SKETCH_PLANE,
        originM: { x: 3, y: 0, z: 0 },
      }),
      extrude("right_extrude", "right_profile", "right"),
    ];
    const disjointCut = part("disjoint_cut", [
      ...disjointHistory,
      {
        id: "missed_cut",
        name: "Missed cut",
        kind: "boolean",
        operation: "cut",
        leftBodyId: "left",
        rightBodyId: "right",
        resultBodyId: "unchanged_left",
      },
    ], ["unchanged_left"]);
    const cutError = await kernel.evaluatePart(disjointCut).catch((caught: unknown) => caught);
    expect(cutError).toBeInstanceOf(CadKernelError);
    expect((cutError as Error).message).toContain(
      "Boolean cut missed_cut is disjoint: bodies left and right have no volumetric overlap",
    );

    const disjointIntersection = part("disjoint_intersection", [
      ...disjointHistory,
      {
        id: "empty_intersection",
        name: "Empty intersection",
        kind: "boolean",
        operation: "intersect",
        leftBodyId: "left",
        rightBodyId: "right",
        resultBodyId: "empty",
      },
    ], ["empty"]);
    const intersectionError = await kernel.evaluatePart(disjointIntersection)
      .catch((caught: unknown) => caught);
    expect(intersectionError).toBeInstanceOf(CadKernelError);
    expect((intersectionError as Error).message).toContain(
      "Boolean intersection empty_intersection is empty: bodies left and right have no volumetric overlap",
    );
  });

  it("preserves valid subtract semantics at a sub-millimetre scale", async () => {
    const size = 1e-4;
    const depth = 5e-5;
    const diameter = 2e-5;
    const tinyDrilledPlate = part("tiny_drilled_plate", [
      rectangleSketch("tiny_profile", [0, 0], [size, size]),
      {
        ...extrude("tiny_extrude", "tiny_profile", "tiny_plate"),
        distance: cadLengthExpression(depth),
      },
      {
        id: "tiny_hole",
        name: "Tiny hole",
        kind: "hole",
        targetBodyId: "tiny_plate",
        resultBodyId: "tiny_drilled_plate",
        centerM: { x: size / 2, y: size / 2, z: depth / 2 },
        axis: { x: 0, y: 0, z: 1 },
        diameter: cadLengthExpression(diameter),
        throughAll: true,
      },
    ], ["tiny_drilled_plate"]);

    const result = await kernel.evaluatePart(tinyDrilledPlate, { includeMeshes: false });
    const expectedVolume = size * size * depth - Math.PI * (diameter / 2) ** 2 * depth;
    expect(result.evidence.bodies[0]!.volumeM3).toBeCloseTo(expectedVolume, 16);
  });

  it("evaluates bounded all-edge detail features and diagnoses unsupported topology work", async () => {
    const filleted = await kernel.evaluatePart(part("fillet", [
      rectangleSketch("profile", [0, 0], [2, 1]),
      extrude("base", "profile", "body"),
      {
        id: "round_all",
        name: "Round all",
        kind: "fillet",
        targetBodyId: "body",
        resultBodyId: "rounded",
        radius: cadLengthExpression(0.05),
        edges: [{
          bodyId: "body",
          producerFeatureId: "base",
          elementType: "edge",
          role: "all_edges",
        }],
      },
    ], ["rounded"]));
    expect(filleted.evidence.bodies[0]!.valid).toBe(true);
    expect(filleted.evidence.bodies[0]!.volumeM3).toBeLessThan(1);

    const unsupported = part("shell", [
      rectangleSketch("profile", [0, 0], [2, 1]),
      extrude("base", "profile", "body"),
      {
        id: "hollow",
        name: "Hollow",
        kind: "shell",
        targetBodyId: "body",
        resultBodyId: "hollowed",
        thickness: cadLengthExpression(0.05),
        removedFaces: [{
          bodyId: "body",
          producerFeatureId: "base",
          elementType: "face",
          role: "top_face",
        }],
      },
    ], ["hollowed"]);
    const error = await kernel.evaluatePart(unsupported).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CadKernelError);
    expect((error as CadKernelError).code).toBe("cad_part_evaluation_failed");
    expect((error as Error).message).toContain("hollow");
  });
});
