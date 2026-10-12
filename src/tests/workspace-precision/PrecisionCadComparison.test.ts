import { describe, expect, it } from "vitest";
import {
  compareMeasurementToCad,
  precisionPointTriangleDistanceSquared,
} from "../../workspace/precision/cadComparison";
import {
  createPrecisionStudy,
  parsePrecisionStudy,
} from "../../workspace/precision/validation";
import type {
  MeasurementGeometry,
  PrecisionStudyV1,
  PrecisionVec3,
} from "../../workspace/precision/types";
const positions: PrecisionVec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
];
function geometry(): MeasurementGeometry {
  return {
    geometryId: "plate",
    units: "metre",
    coordinateBasis: "RUB",
    positions,
    triangles: [
      [0, 1, 2],
      [1, 3, 2],
    ],
    source: {
      format: "obj",
      sha256: `sha256:${"1".repeat(64)}`,
      provenance: "Synthetic plate fixture",
    },
  };
}
function study(): PrecisionStudyV1 {
  const base = createPrecisionStudy(geometry());
  return {
    ...base,
    checks: [0, 1, 2].map((index) => ({
      id: `p${index}`,
      vertexIndex: index,
      referencePointM: positions[index]!,
      uncertaintyM: 0.0001,
      provenance: "Independent synthetic test observation",
      regionId: "plate",
    })),
    policy: {
      ...base.policy,
      requiredRegions: ["plate"],
      toleranceM: 0.01,
      surfaceUncertaintyM: 0.001,
      surfaceUncertaintyBasis:
        "Synthetic fixture bounded perturbation; no field claim",
    },
  };
}
const options = {
  targetDefinitionDigest: "cad-definition-1",
  tessellationBoundM: 0.0005,
};
describe("Host mesh comparison with separate physical accuracy scope", () => {
  it("finds triangle interior and edge closest points, not nearest vertices", () => {
    expect(
      precisionPointTriangleDistanceSquared(
        [0.25, 0.25, 1],
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ),
    ).toBeCloseTo(1, 12);
    expect(
      precisionPointTriangleDistanceSquared(
        [0.5, -1, 0],
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ),
    ).toBeCloseTo(1, 12);
    expect(
      precisionPointTriangleDistanceSquared(
        [1, 1, 0],
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ),
    ).toBeCloseTo(0.5, 12);
    expect(
      precisionPointTriangleDistanceSquared(
        [0.5, 1, 0],
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ),
    ).toBeCloseTo(1, 12);
  });
  it("passes only scoped all-vertex comparison with both source and uncertainty requirements", () => {
    const result = compareMeasurementToCad(study(), geometry(), options);
    expect(result.status).toBe("pass_for_scope");
    expect(result.scope).toBe("bidirectional-sampled-vertices-only");
    expect(result.sourceToCad).toEqual({
      maximumM: 0,
      rmsM: 0,
      p95M: 0,
      count: 4,
      method: "point-to-triangle",
    });
    expect(result.conservativeMaximumM).toBe(0.0015);
    expect(result.uncertaintyAuthority).toBe("supplied-not-certified");
  });
  it("does not transfer sparse check accuracy to the complete source surface", () => {
    const input = study();
    const result = compareMeasurementToCad(
      { ...input, policy: { ...input.policy, surfaceUncertaintyM: null } },
      geometry(),
      options,
    );
    expect(result.sourceReport.status).toBe("pass_for_scope");
    expect(result.status).toBe("inconclusive");
    expect(() =>
      parsePrecisionStudy({
        ...input,
        policy: { ...input.policy, surfaceUncertaintyBasis: undefined },
      }),
    ).toThrow();
  });
  it("does not pass an unverified source even when meshes match", () => {
    expect(
      compareMeasurementToCad({ ...study(), checks: [] }, geometry(), options)
        .status,
    ).toBe("inconclusive");
  });
  it("detects changed CAD surfaces and binds every target/allowance change", () => {
    const source = study(),
      first = compareMeasurementToCad(source, geometry(), options);
    const changed = {
      ...geometry(),
      positions: positions.map((p) => [p[0], p[1], 0.1] as PrecisionVec3),
    };
    const second = compareMeasurementToCad(source, changed, options);
    expect(second.status).toBe("fail");
    expect(second.sourceToCad?.maximumM).toBeCloseTo(0.1, 12);
    expect(first.dependencyDigest).not.toBe(second.dependencyDigest);
    expect(
      compareMeasurementToCad(source, geometry(), {
        ...options,
        tessellationBoundM: 0.02,
      }).status,
    ).toBe("inconclusive");
    expect(
      compareMeasurementToCad(source, geometry(), {
        ...options,
        targetDefinitionDigest: "updated",
      }).dependencyDigest,
    ).not.toBe(first.dependencyDigest);
  });
  it("keeps point clouds diagnostic without inventing a continuous surface", () => {
    const target = { ...geometry(), triangles: undefined };
    expect(compareMeasurementToCad(study(), target, options).status).toBe(
      "inconclusive",
    );
    expect(
      compareMeasurementToCad(study(), target, options).sourceToCad?.method,
    ).toBe("nearest-vertex-diagnostic");
  });
  it("does not accept degenerate triangles as measured surfaces", () => {
    const line = {
      ...geometry(),
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ] as const,
      triangles: [[0, 1, 2]] as const,
    };
    const input = {
      ...study(),
      geometry: line,
      checks: study().checks.map((check, i) => ({
        ...check,
        referencePointM: line.positions[i]!,
      })),
    };
    const report = compareMeasurementToCad(input, line, options);
    expect(report.status).toBe("inconclusive");
    expect(report.reasons.join(" ")).toContain("Degenerate");
  });
  it("compares interior vertices against triangles even with different tessellation", () => {
    const target = {
      ...geometry(),
      positions: [...positions, [0.5, 0.5, 0] as PrecisionVec3],
      triangles: [
        [0, 1, 4],
        [1, 3, 4],
        [3, 2, 4],
        [2, 0, 4],
      ] as const,
    };
    expect(compareMeasurementToCad(study(), target, options).status).toBe(
      "pass_for_scope",
    );
    expect(
      compareMeasurementToCad(study(), target, options).cadToSource?.maximumM,
    ).toBe(0);
  });
  it("uses exact spatial pruning without silently decimating the input", () => {
    const count = 100,
      vertices: PrecisionVec3[] = [],
      triangles: [number, number, number][] = [];
    for (let i = 0; i < count; i++) {
      const at = vertices.length;
      vertices.push([i * 2, 0, 0], [i * 2 + 1, 0, 0], [i * 2, 1, 0]);
      triangles.push([at, at + 1, at + 2]);
    }
    const dense = { ...geometry(), positions: vertices, triangles };
    const input = {
      ...study(),
      geometry: dense,
      checks: [0, 1, 2].map((i) => ({
        ...study().checks[i]!,
        referencePointM: vertices[i]!,
      })),
    };
    const result = compareMeasurementToCad(input, dense, options);
    expect(result.status).toBe("pass_for_scope");
    expect(result.sourceToCad?.count).toBe(300);
  });
  it("fails closed when exact traversal exhausts the budget", () => {
    const repeated = {
      ...geometry(),
      triangles: Array.from({ length: 50_000 }, () => [0, 1, 2] as const),
    };
    const large = {
      ...study(),
      geometry: {
        ...repeated,
        positions: [
          ...positions,
          ...Array.from({ length: 50 }, () => [0.25, 0.25, 0] as PrecisionVec3),
        ],
      },
    };
    const result = compareMeasurementToCad(large, repeated, options);
    expect(result.status).toBe("inconclusive");
    expect(result.reasons.join(" ")).toContain("budget");
  });
});
