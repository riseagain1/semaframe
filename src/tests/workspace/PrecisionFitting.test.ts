// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256DigestBytes } from "../../workspace/assets/digest";
import { fitCircle, fitCylinder, fitMeasurementPlane, fitPlane, proposePlateCad, proposeShaftCad, type FitPoint } from "../../workspace/precision/fitting";
import { loadCadKernel, type CadKernel } from "../../workspace/modeling/cadKernel";
import { parseCadPartDefinition, type CadPartDefinitionV1 } from "../../workspace/modeling/cad";
import { exportCadHandoffAssemblyWithOcct } from "../../workspace/modeling/cadHandoffOcct";

const sourceGeometryDigest = sha256DigestBytes(new TextEncoder().encode("known synthetic geometry, not a real-world accuracy experiment"));
const options = { sourceGeometryDigest, frameId: "fixture_metric_frame", toleranceM: 0.0001 };
const angle = 0.55;
function move(point: FitPoint): FitPoint {
  return [10 + Math.cos(angle) * point[0] - Math.sin(angle) * point[1], 20 + Math.sin(angle) * point[0] + Math.cos(angle) * point[1], 30 + point[2]];
}
function cylinder(): FitPoint[] {
  return Array.from({ length: 5 }, (_, ring) => Array.from({ length: 72 }, (_, index): FitPoint => {
    const a = index / 72 * Math.PI * 2;
    return move([Math.cos(a) * 0.2, (ring - 2) * 0.5, Math.sin(a) * 0.2]);
  })).flat();
}
let kernel: CadKernel;
beforeAll(async () => { kernel = await loadCadKernel(); }, 30_000);
afterAll(async () => { await kernel.dispose(); });

describe("metric primitive fitting and CAD proposals", () => {
  it("fits a rotated translated plane while retaining outlier evidence", () => {
    const points = Array.from({ length: 9 }, (_, row) => Array.from({ length: 12 }, (_, column) => move([column * 0.1, row * 0.1, 0]))).flat();
    points.push([100, 100, 100], [101, 101, 101]);
    const fit = fitPlane(points, options);
    expect(fit.normal[2]).toBeCloseTo(1, 8);
    expect(fit.evidence.outlierIndices).toEqual([108, 109]);
    expect(fit.evidence.inlierRmsM).toBeLessThan(1e-10);
    expect(fit.evidence.allSampleRmsM).toBeGreaterThan(1);
    expect(fit.evidence.status).toBe("fit_only_not_independent_validation");
  });

  it("fits a 3D circle and rejects collinear or short-arc support", () => {
    const points = Array.from({ length: 72 }, (_, index): FitPoint => move([Math.cos(index / 72 * Math.PI * 2), 0, Math.sin(index / 72 * Math.PI * 2)]));
    expect(fitCircle(points, options).radiusM).toBeCloseTo(1, 9);
    expect(() => fitPlane(Array.from({ length: 10 }, (_, index): FitPoint => [index, 0, 0]), options)).toThrow();
    expect(() => fitCircle(points.slice(0, 20), options)).toThrow(/270/);
  });

  it("recovers a rotated cylinder's radius/axis/span and rejects incomplete geometry", () => {
    const points = cylinder(); points.push([200, -100, 60], [250, -110, 90]);
    const fit = fitCylinder(points, options);
    expect(fit.radiusM).toBeCloseTo(0.2, 8);
    expect(fit.axisDirection[0]).toBeCloseTo(-Math.sin(angle), 8);
    expect(fit.axisDirection[1]).toBeCloseTo(Math.cos(angle), 8);
    expect(fit.axialRangeM[1] - fit.axialRangeM[0]).toBeCloseTo(2, 8);
    expect(fit.evidence.outlierIndices).toEqual([360, 361]);
    expect(() => fitCylinder(cylinder().filter((_, index) => index % 72 < 16), { ...options, axisHint: { direction: [-Math.sin(angle), Math.cos(angle), 0], provenance: "independent axis measurement" } })).toThrow(/support/);
    expect(() => fitCylinder(cylinder(), { ...options, axisHint: { direction: [0, 1, 0], provenance: "" } })).toThrow(/provenance/);
  });

  it("creates a real editable CAD shaft definition evaluatable by OCCT", async () => {
    const proposal = proposeShaftCad(cylinder(), { ...options, partId: "shaft_fixture" });
    expect(proposal.status).toBe("proposal_not_validated");
    const result = await kernel.evaluatePart(proposal.definition, { includeMeshes: false });
    expect(result.evidence.bodies[0]!.volumeM3).toBeCloseTo(Math.PI * 0.2 ** 2 * 2, 7);
    const edited = { ...proposal.definition, parameters: proposal.definition.parameters.map((parameter) => parameter.id === "shaft_length" ? { ...parameter, expression: { kind: "constant" as const, dimension: "length" as const, value: 3 } } : parameter) };
    const next = await kernel.evaluatePart(edited, { includeMeshes: false });
    expect(next.evidence.bodies[0]!.volumeM3).toBeCloseTo(Math.PI * 0.2 ** 2 * 3, 7);
  });

  it("reopens a fitted editable recipe and preserves metre dimensions through real STEP export/import before and after edits", async () => {
    const proposal = proposeShaftCad(cylinder(), { ...options, partId: "shaft_step_fixture" });
    const reopened = parseCadPartDefinition(JSON.parse(JSON.stringify(proposal.definition)));
    const identity = {
      translationM: { x: 0, y: 0, z: 0 },
      rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    };
    async function roundTrip(definition: CadPartDefinitionV1, radiusM: number, heightM: number) {
      // Independent analytic expectations, not the CAD kernel's own source measurements.
      // Extrusion begins at the original fitted shaft's lower cap, even after a length edit.
      const center = {
        x: 10 - Math.sin(angle) * (heightM / 2 - 1),
        y: 20 + Math.cos(angle) * (heightM / 2 - 1),
        z: 30,
      };
      const size = {
        x: Math.sin(angle) * heightM + 2 * radiusM * Math.cos(angle),
        y: Math.cos(angle) * heightM + 2 * radiusM * Math.sin(angle),
        z: 2 * radiusM,
      };
      const expectedBoundsM = {
        min: { x: center.x - size.x / 2, y: center.y - size.y / 2, z: center.z - size.z / 2 },
        max: { x: center.x + size.x / 2, y: center.y + size.y / 2, z: center.z + size.z / 2 },
        size,
      };
      const expectedVolumeM3 = Math.PI * radiusM ** 2 * heightM;
      const exported = await exportCadHandoffAssemblyWithOcct({
        documentName: "Scan-derived shaft precision fixture",
        containerName: "Exact CAD handoff",
        rootNodeId: "ROOT",
        assemblies: [{ nodeId: "ROOT", definitionName: "Root", visible: true }],
        parts: [{
          nodeId: "SHAFT",
          definitionName: "Scan-derived editable shaft",
          sourceKind: "cad-part-body",
          sourceComponentNodeId: "CAD_SCAN_SHAFT",
          bodyId: "shaft_body",
          definition,
          bakedUniformScale: 1,
          color: { red: 0.5, green: 0.7, blue: 0.8, alpha: 1 },
          visible: true,
        }],
        occurrences: [{
          nodeId: "SHAFT_INSTANCE",
          parentAssemblyNodeId: "ROOT",
          childNodeId: "SHAFT",
          occurrenceName: "Fitted shaft occurrence",
          transform: identity,
        }],
        rootOccurrence: { occurrenceName: "Root occurrence", transform: identity },
      }, { expectedVolumeM3, expectedBoundsM });
      expect(exported.stepText).toContain("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING");
      expect(exported.stepText).toMatch(/SI_UNIT\(\$,.METRE\.\)/u);
      expect(exported.verification).toMatchObject({
        passed: true, validBrep: true, solidCount: 1, units: "metre", boundsMatch: true,
      });
      expect(exported.verification.importedVolumeM3).toBeCloseTo(expectedVolumeM3, 8);
      expect(exported.verification.boundsMaximumAbsoluteErrorM).toBeLessThanOrEqual(1e-6);

      // Reopen the actual delivered STEP bytes independently of the exporter's verification.
      const replicad = await import("replicad");
      const imported = await replicad.importSTEP(new Blob([exported.stepText], { type: "application/step" }));
      try {
        expect(replicad.isShape3D(imported)).toBe(true);
        if (!replicad.isShape3D(imported)) throw new Error("Fitted shaft STEP did not reopen as a 3D shape");
        expect(replicad.measureVolume(imported)).toBeCloseTo(expectedVolumeM3, 8);
        expect(imported.boundingBox.width).toBeCloseTo(size.x, 5);
        expect(imported.boundingBox.height).toBeCloseTo(size.y, 5);
        expect(imported.boundingBox.depth).toBeCloseTo(size.z, 5);
      } finally {
        imported.delete();
      }
      return exported;
    }

    const original = await roundTrip(reopened, 0.2, 2);
    const edited = parseCadPartDefinition(JSON.parse(JSON.stringify({
      ...reopened,
      parameters: reopened.parameters.map((parameter) => {
        if (parameter.id === "shaft_length" || parameter.id === "shaft_radius") {
          return { ...parameter, expression: {
            kind: "constant", dimension: "length", value: parameter.id === "shaft_length" ? 3 : 0.15,
          } };
        }
        return parameter;
      }),
    })));
    const updated = await roundTrip(edited, 0.15, 3);
    expect(updated.stepText).not.toBe(original.stepText);
    expect(updated.verification.importedVolumeM3).not.toBeCloseTo(original.verification.importedVolumeM3, 6);
    expect(reopened.parameters.find((parameter) => parameter.id === "shaft_radius")?.expression)
      .toEqual(proposal.definition.parameters.find((parameter) => parameter.id === "shaft_radius")?.expression);
    expect(edited.parameters.find((parameter) => parameter.id === "shaft_radius")?.expression)
      .toMatchObject({ kind: "constant", value: 0.15 });
  }, 60_000);

  it("requires independent thickness for planar data and emits a parameter-editable plate proposal", async () => {
    const points = Array.from({ length: 7 }, (_, row) => Array.from({ length: 11 }, (_, column) => move([column * 0.2, row * 0.2, 0]))).flat();
    expect(() => proposePlateCad(points, { ...options, partId: "plate", thicknessM: 0, thicknessProvenance: "" })).toThrow(/thickness/);
    const proposal = proposePlateCad(points, { ...options, partId: "plate", thicknessM: 0.03, thicknessProvenance: "independent caliper measurement" });
    const result = await kernel.evaluatePart(proposal.definition, { includeMeshes: false });
    expect(result.evidence.bodies[0]!.volumeM3).toBeCloseTo(2 * 1.2 * 0.03, 6);
    const edited = { ...proposal.definition, parameters: proposal.definition.parameters.map((parameter) => parameter.id === "plate_width" ? { ...parameter, expression: { kind: "constant" as const, dimension: "length" as const, value: 2.5 } } : parameter) };
    const next = await kernel.evaluatePart(edited, { includeMeshes: false });
    expect(next.evidence.bodies[0]!.volumeM3).toBeCloseTo(2.5 * 1.2 * 0.03, 5);
  });

  it("refuses unknown-scale modeling and binds evidence to actual metric coordinates", () => {
    const positions = Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column): FitPoint => [column, row, 0])).flat();
    const geometry = { geometryId: "metric", positions, units: "metre" as const, coordinateBasis: "RUB" as const, source: { sha256: sourceGeometryDigest, format: "synthetic", provenance: "Known fixture, not real-world validation" } };
    const fit = fitMeasurementPlane(geometry, { toleranceM: 0.001 });
    const next = fitMeasurementPlane({ ...geometry, positions: positions.map((point): FitPoint => [point[0] + 1, point[1], point[2]]) }, { toleranceM: 0.001 });
    expect(fit.evidence.sourceGeometryDigest).not.toBe(next.evidence.sourceGeometryDigest);
    expect(() => fitMeasurementPlane({ ...geometry, units: "unknown" }, { toleranceM: 0.001 })).toThrow(/calibration/);
  });
});
