// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  exportCadHandoffAssemblyWithOcct,
  type CadHandoffOcctDocument,
} from "../../workspace/modeling/cadHandoffOcct";

const identity = Object.freeze({
  translationM: Object.freeze({ x: 0, y: 0, z: 0 }),
  rotationQuaternion: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }),
});

function overlappingAssembly(): CadHandoffOcctDocument {
  return {
    documentName: "SemaFrame deterministic handoff fixture",
    containerName: "Overlap fixture handoff",
    rootNodeId: "ROOT",
    assemblies: [{ nodeId: "ROOT", definitionName: "Root assembly [SF:ROOT]", visible: true }],
    parts: [{
      nodeId: "LEFT",
      definitionName: "Left block [SF:LEFT]",
      sourceKind: "primitive",
      primitive: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } },
      bakedUniformScale: 1,
      color: { red: 1, green: 0, blue: 0, alpha: 1 },
      visible: true,
    }, {
      nodeId: "RIGHT",
      definitionName: "Right block [SF:RIGHT]",
      sourceKind: "primitive",
      primitive: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } },
      bakedUniformScale: 1,
      color: { red: 0, green: 0, blue: 1, alpha: 1 },
      visible: true,
    }],
    occurrences: [{
      nodeId: "LEFT",
      parentAssemblyNodeId: "ROOT",
      childNodeId: "LEFT",
      occurrenceName: "Left occurrence [SF:LEFT]",
      transform: {
        translationM: { x: -0.25, y: 0, z: 0 },
        rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
      },
    }, {
      nodeId: "RIGHT",
      parentAssemblyNodeId: "ROOT",
      childNodeId: "RIGHT",
      occurrenceName: "Right occurrence [SF:RIGHT]",
      transform: {
        translationM: { x: 0.25, y: 0, z: 0 },
        rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
      },
    }],
    rootOccurrence: {
      occurrenceName: "Root occurrence [SF:ROOT]",
      transform: identity,
    },
  };
}

describe("OCCT AP242 assembly handoff", () => {
  it("preserves overlapping parts as named, colored, non-unioned assembly solids", async () => {
    const first = await exportCadHandoffAssemblyWithOcct(overlappingAssembly(), {
      expectedVolumeM3: 2,
    });
    const second = await exportCadHandoffAssemblyWithOcct(overlappingAssembly(), {
      expectedVolumeM3: 2,
    });

    expect(first.stepText).toBe(second.stepText);
    expect(first.stepText).toContain("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING");
    expect(first.stepText).toMatch(/SI_UNIT\(\$,.METRE\.\)/u);
    expect(first.stepText).toContain("Left block [SF:LEFT]");
    expect(first.stepText).toContain("Right block [SF:RIGHT]");
    expect(first.stepText).toMatch(/(?:COLOUR_RGB|DRAUGHTING_PRE_DEFINED_COLOUR)/u);
    expect(first.verification).toMatchObject({
      passed: true,
      rootCount: 1,
      solidCount: 2,
      expectedPartCount: 2,
      validBrep: true,
      assemblyOccurrenceCount: 3,
      expectedOccurrenceCount: 3,
      expectedVolumeM3: 2,
    });
    expect(first.verification.importedVolumeM3).toBeCloseTo(2, 12);
    expect(first.verification.boundsMatch).toBe(true);
    expect(first.verification.boundsAbsoluteToleranceM).toBe(1e-6);
    expect(first.verification.boundsMaximumAbsoluteErrorM)
      .toBeLessThanOrEqual(first.verification.boundsAbsoluteToleranceM);
    expect(first.verification.expectedBoundsM).toEqual(first.verification.boundsM);
    expect(first.verification.boundsM.size.x).toBeCloseTo(1.5, 5);
    expect(first.verification.boundsM.size.y).toBeCloseTo(1, 5);
    expect(first.verification.boundsM.size.z).toBeCloseTo(1, 5);
  }, 60_000);

  it("centres exact cylinder geometry on its declared primitive origin", async () => {
    const document: CadHandoffOcctDocument = {
      documentName: "Centred cylinder fixture",
      containerName: "Centred cylinder handoff",
      rootNodeId: "ROOT",
      assemblies: [{ nodeId: "ROOT", definitionName: "Root assembly", visible: true }],
      parts: [{
        nodeId: "SHAFT",
        definitionName: "Shaft",
        sourceKind: "primitive",
        primitive: { kind: "cylinder", radiusM: 0.25, heightM: 2, axis: "x" },
        bakedUniformScale: 1,
        color: { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 },
        visible: true,
      }],
      occurrences: [{
        nodeId: "SHAFT",
        parentAssemblyNodeId: "ROOT",
        childNodeId: "SHAFT",
        occurrenceName: "Shaft occurrence",
        transform: identity,
      }],
      rootOccurrence: { occurrenceName: "Root occurrence", transform: identity },
    };
    const result = await exportCadHandoffAssemblyWithOcct(document, {
      expectedVolumeM3: Math.PI * 0.25 ** 2 * 2,
    });

    expect(result.verification.boundsM.min.x).toBeCloseTo(-1, 5);
    expect(result.verification.boundsM.max.x).toBeCloseTo(1, 5);
    expect(result.verification.boundsM.size.y).toBeCloseTo(0.5, 5);
    expect(result.verification.boundsM.size.z).toBeCloseTo(0.5, 5);
  }, 60_000);

  it("fails closed when an occurrence transform drifts outside independently expected bounds", async () => {
    const document = overlappingAssembly();
    const drifted: CadHandoffOcctDocument = {
      ...document,
      occurrences: document.occurrences.map((occurrence) => occurrence.nodeId === "RIGHT"
        ? {
            ...occurrence,
            transform: {
              ...occurrence.transform,
              translationM: { x: 1.25, y: 0, z: 0 },
            },
          }
        : occurrence),
    };
    const expectedBoundsM = {
      min: { x: -0.75, y: -0.5, z: -0.5 },
      max: { x: 0.75, y: 0.5, z: 0.5 },
      size: { x: 1.5, y: 1, z: 1 },
    };

    const error = await exportCadHandoffAssemblyWithOcct(drifted, {
      expectedVolumeM3: 2,
      expectedBoundsM,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("CAD AP242/XCAF handoff failed");
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message)
      .toContain("CAD source bounds do not match the independent expectation");
  }, 60_000);
});
