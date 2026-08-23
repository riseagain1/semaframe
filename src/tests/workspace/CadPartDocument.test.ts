// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  CAD_PART_DEFINITION_FORMAT_VERSION,
  DEFAULT_CAD_SKETCH_PLANE,
  CadDocumentError,
  CadParameterError,
  applyCadDocumentEdits,
  cadLengthExpression,
  cadPartDefinitionDigest,
  defaultCadPartDefinition,
  evaluateCadParameters,
  parseCadPartDefinition,
  solveCadSketch,
  type CadPartDefinitionV1,
  type CadSketchDefinition,
} from "../../workspace/modeling/cad";

describe("versioned CAD part documents", () => {
  it("evaluates dimensional parameter dependencies and rejects cycles", () => {
    const evaluation = evaluateCadParameters([
      {
        id: "width",
        name: "Width",
        dimension: "length",
        expression: cadLengthExpression(0.4),
      },
      {
        id: "double_width",
        name: "Double width",
        dimension: "length",
        expression: {
          kind: "binary",
          operation: "multiply",
          left: { kind: "parameter", parameterId: "width" },
          right: { kind: "constant", value: 2, dimension: "integer" },
        },
      },
    ]);
    expect(evaluation.byId.get("double_width")).toEqual({ value: 0.8, dimension: "length" });

    expect(() => evaluateCadParameters([
      {
        id: "first",
        name: "First",
        dimension: "length",
        expression: { kind: "parameter", parameterId: "second" },
      },
      {
        id: "second",
        name: "Second",
        dimension: "length",
        expression: { kind: "parameter", parameterId: "first" },
      },
    ])).toThrowError(CadParameterError);
  });

  it("solves a small fully constrained sketch deterministically", () => {
    const sketch: CadSketchDefinition = {
      plane: DEFAULT_CAD_SKETCH_PLANE,
      entities: [{ id: "edge", kind: "line", start: { x: 0.2, y: 0.1 }, end: { x: 0.7, y: 0.3 } }],
      loops: [],
      constraints: [
        { id: "anchor", kind: "fixed", point: { entityId: "edge", point: "start" }, position: { x: 0, y: 0 } },
        { id: "horizontal", kind: "horizontal", entityId: "edge" },
        { id: "length", kind: "length", entityId: "edge", value: cadLengthExpression(2) },
      ],
    };
    const first = solveCadSketch(sketch);
    const second = solveCadSketch(sketch);
    expect(first).toEqual(second);
    expect(first.status).toBe("fully_constrained");
    expect(first.degreesOfFreedom).toBe(0);
    expect(first.maximumResidual).toBeLessThan(1e-7);
    expect(first.entities[0]).toMatchObject({
      kind: "line",
      start: { x: expect.closeTo(0, 6), y: expect.closeTo(0, 6) },
      end: { x: expect.closeTo(2, 6), y: expect.closeTo(0, 6) },
    });

    const conflicting = solveCadSketch({
      ...sketch,
      constraints: [
        ...sketch.constraints,
        { id: "fixed_end", kind: "fixed", point: { entityId: "edge", point: "end" }, position: { x: 1, y: 0 } },
      ],
    });
    expect(conflicting.status).toBe("over_constrained");
    expect(conflicting.conflictingConstraintIds.length).toBeGreaterThan(0);
  });

  it("applies semantic edits atomically and produces canonical digests", () => {
    const original = defaultCadPartDefinition("fixture", "Fixture");
    const updated = applyCadDocumentEdits(original, [
      { kind: "rename_part", displayName: "  Mounting Fixture  " },
      {
        kind: "set_parameter",
        parameter: {
          id: "height",
          name: "Height",
          dimension: "length",
          expression: cadLengthExpression(0.1),
        },
      },
    ]);
    expect(updated.displayName).toBe("Mounting Fixture");
    expect(original.displayName).toBe("Fixture");
    expect(original.parameters).toHaveLength(0);
    expect(cadPartDefinitionDigest(updated)).toBe(cadPartDefinitionDigest(structuredClone(updated)));

    expect(() => applyCadDocumentEdits(updated, [
      { kind: "delete_parameter", parameterId: "missing" },
    ])).toThrowError(CadDocumentError);
    expect(updated.parameters).toHaveLength(1);
  });

  it("rejects forward feature references and suppressed dependencies", () => {
    const invalid = {
      formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
      partId: "invalid",
      displayName: "Invalid",
      units: "metre",
      parameters: [],
      history: [
        {
          id: "make_body",
          name: "Make body",
          kind: "extrude",
          profile: { sketchFeatureId: "later_sketch", loopIds: ["outer"] },
          distance: cadLengthExpression(1),
          operation: "new",
          resultBodyId: "body",
        },
      ],
      activeBodyIds: ["body"],
    } satisfies CadPartDefinitionV1;
    expect(() => parseCadPartDefinition(invalid)).toThrowError(CadDocumentError);
  });
});
