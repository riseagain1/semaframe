import { describe, expect, it } from "vitest";
import {
  calibratedGeometry,
  createPrecisionStudy,
  evaluatePrecisionStudy,
  parseMeasurementGeometry,
  parsePrecisionStudy,
  precisionStudyDigest,
  solvePrecisionCalibration,
} from "../../workspace/precision";
import type {
  MeasurementGeometry,
  PrecisionPointObservation,
  PrecisionStudyV1,
  PrecisionVec3,
} from "../../workspace/precision/types";

const positions: PrecisionVec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];
function geometry(): MeasurementGeometry {
  return {
    geometryId: "test",
    positions,
    units: "metre",
    coordinateBasis: "RUB",
    source: {
      sha256: `sha256:${"1".repeat(64)}`,
      format: "xyz",
      provenance: "Synthetic fixture; not field evidence",
    },
  };
}
function observation(
  vertexIndex: number,
  referencePointM = positions[vertexIndex]!,
): PrecisionPointObservation {
  return {
    id: `point-${vertexIndex}`,
    vertexIndex,
    referencePointM,
    uncertaintyM: 0.0001,
    provenance: "Independently measured test reference",
    regionId: "test",
  };
}
function study(): PrecisionStudyV1 {
  return {
    ...createPrecisionStudy(geometry()),
    checks: [observation(4), observation(5), observation(6)],
    policy: {
      intendedUse: "Synthetic dimensional inspection",
      toleranceM: 0.01,
      minimumIndependentChecks: 3,
      requiredRegions: ["test"],
      uncertaintyBasis: "Supplied conservative reference error bound",
    },
  };
}
const moved = (p: PrecisionVec3): PrecisionVec3 => [
  3 - 2 * p[1],
  4 + 2 * p[0],
  5 + 2 * p[2],
];
function registered(): PrecisionStudyV1 {
  const base = study();
  return {
    ...base,
    geometry: { ...base.geometry, units: "unknown" },
    calibration: { mode: "similarity" },
    controls: [0, 1, 2, 3].map((index) =>
      observation(index, moved(positions[index]!)),
    ),
    checks: [4, 5, 6].map((index) =>
      observation(index, moved(positions[index]!)),
    ),
    policy: { ...base.policy, registrationUncertaintyM: 0.0001 },
  };
}

describe("Bounded, independently checked precision studies", () => {
  it("never accepts a new study without declared independent checks", () => {
    expect(
      evaluatePrecisionStudy(createPrecisionStudy(geometry())).status,
    ).toBe("unverified");
    expect(evaluatePrecisionStudy(study()).status).toBe("pass_for_scope");
  });
  it("normalizes declared millimetres without claiming survey registration", () => {
    const input = {
      ...study(),
      geometry: {
        ...geometry(),
        units: "millimetre" as const,
        positions: positions.map(
          (p) => p.map((v) => v * 1000) as unknown as PrecisionVec3,
        ),
      },
    };
    expect(calibratedGeometry(input).positions[6]).toEqual([0, 1, 1]);
    expect(evaluatePrecisionStudy(input).status).toBe("pass_for_scope");
  });
  it("recovers proper similarity from separate controls and held-out checks", () => {
    const input = registered(),
      report = evaluatePrecisionStudy(input),
      transform = solvePrecisionCalibration(input);
    expect(transform.scale).toBeCloseTo(2, 11);
    expect(transform.translation[0]).toBeCloseTo(3, 11);
    expect(transform.translation[1]).toBeCloseTo(4, 11);
    expect(transform.fitRmsM).toBeLessThan(1e-12);
    expect(report.status).toBe("pass_for_scope");
    expect(report.checks.every((check) => check.errorM < 1e-12)).toBe(true);
  });
  it("supports rigid registration without silently estimating scale", () => {
    const base = registered();
    const rigid = {
      ...base,
      geometry: { ...base.geometry, units: "metre" as const },
      calibration: { mode: "rigid" as const },
    };
    expect(solvePrecisionCalibration(rigid).scale).toBe(1);
    expect(evaluatePrecisionStudy(rigid).status).not.toBe("pass_for_scope");
  });
  it("rejects coincident, collinear and almost collinear fit controls", () => {
    for (const points of [
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 1e-8, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    ] as PrecisionVec3[][]) {
      const base = registered(),
        input = {
          ...base,
          geometry: {
            ...base.geometry,
            positions: [...points, ...positions.slice(3)],
          },
          controls: [0, 1, 2].map((i) => observation(i, moved(points[i]!))),
        };
      expect(() => solvePrecisionCalibration(input)).toThrow();
    }
  });
  it("cannot pass unknown units, unknown reference uncertainty or missing registration bounds", () => {
    expect(
      evaluatePrecisionStudy({
        ...study(),
        geometry: { ...geometry(), units: "unknown" },
      }).status,
    ).toBe("unverified");
    expect(
      evaluatePrecisionStudy({
        ...study(),
        checks: study().checks.map((p) => ({ ...p, uncertaintyM: null })),
      }).status,
    ).toBe("inconclusive");
    const input = registered();
    expect(
      evaluatePrecisionStudy({
        ...input,
        policy: { ...input.policy, registrationUncertaintyM: null },
      }).status,
    ).toBe("inconclusive");
    expect(
      evaluatePrecisionStudy({
        ...input,
        controls: input.controls.map((p) => ({ ...p, uncertaintyM: null })),
      }).status,
    ).toBe("inconclusive");
  });
  it("distinguishes clear failure from tolerance-boundary uncertainty", () => {
    const input = study();
    expect(
      evaluatePrecisionStudy({
        ...input,
        checks: [
          { ...input.checks[0]!, referencePointM: [1.1, 1, 0] },
          ...input.checks.slice(1),
        ],
      }).status,
    ).toBe("fail");
    const ambiguous: PrecisionStudyV1 = {
      ...input,
      checks: [
        {
          ...input.checks[0]!,
          referencePointM: [1.01, 1, 0],
          uncertaintyM: 0.002,
        },
        ...input.checks.slice(1),
      ],
    };
    expect(evaluatePrecisionStudy(ambiguous).status).toBe("inconclusive");
  });
  it("does not hide outliers or accept incomplete regional coverage", () => {
    const input = study();
    expect(
      evaluatePrecisionStudy({
        ...input,
        policy: { ...input.policy, requiredRegions: ["test", "backside"] },
      }).status,
    ).toBe("inconclusive");
    expect(
      evaluatePrecisionStudy({ ...input, checks: input.checks.slice(0, 2) })
        .status,
    ).toBe("inconclusive");
  });
  it("rejects controls reused as checks including duplicate-coordinate aliases", () => {
    const input = registered();
    expect(() =>
      parsePrecisionStudy({
        ...input,
        checks: [input.controls[0]!, ...input.checks.slice(1)],
      }),
    ).toThrow();
    expect(() =>
      parsePrecisionStudy({
        ...input,
        geometry: {
          ...input.geometry,
          positions: [...positions, positions[0]!],
        },
        checks: [
          { ...observation(8), referencePointM: [2, 3, 4] },
          ...input.checks.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      parsePrecisionStudy({
        ...input,
        dimensions: [
          {
            id: "d",
            aIndex: 0,
            bIndex: 7,
            referenceDistanceM: 2,
            uncertaintyM: 0,
            provenance: "check",
            regionId: "test",
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects forged reports, nonfinite inputs, extra fields, invalid triangles and oversized geometry", () => {
    expect(() =>
      parsePrecisionStudy({ ...study(), report: { status: "pass_for_scope" } }),
    ).toThrow();
    expect(() =>
      parseMeasurementGeometry({
        ...geometry(),
        positions: [[Infinity, 0, 0]],
      }),
    ).toThrow();
    expect(() =>
      parseMeasurementGeometry({ ...geometry(), triangles: [[0, 1, 999]] }),
    ).toThrow();
    expect(() =>
      parseMeasurementGeometry({ ...geometry(), triangles: [[0, 0, 1]] }),
    ).toThrow();
    expect(() =>
      parseMeasurementGeometry({
        ...geometry(),
        positions: Array.from({ length: 25_001 }, () => [0, 0, 0]),
      }),
    ).toThrow();
    expect(() =>
      parsePrecisionStudy({
        ...study(),
        policy: { ...study().policy, minimumIndependentChecks: 0 },
      }),
    ).toThrow();
  });
  it("compares reference vertices in both directions and rejects self-reference", () => {
    const reference = {
      ...geometry(),
      source: { ...geometry().source, sha256: `sha256:${"2".repeat(64)}` },
      positions: [...positions, [4, 4, 4] as PrecisionVec3],
    };
    const report = evaluatePrecisionStudy({
      ...study(),
      referenceSurface: {
        geometry: reference,
        uncertaintyM: 0,
        provenance: "independent point cloud",
      },
    });
    expect(
      report.checks.find((c) => c.id === "surface:source-to-reference")?.errorM,
    ).toBe(0);
    expect(
      report.checks.find((c) => c.id === "surface:reference-to-source")?.errorM,
    ).toBeGreaterThan(1);
    expect(report.status).toBe("fail");
    expect(() =>
      parsePrecisionStudy({
        ...study(),
        referenceSurface: {
          geometry: geometry(),
          uncertaintyM: 0,
          provenance: "same source",
        },
      }),
    ).toThrow();
  });
  it("fails closed above surface comparison budget without hidden downsampling", () => {
    const reference = {
      ...geometry(),
      positions: Array.from(
        { length: 25_000 },
        () => [0, 0, 0] as PrecisionVec3,
      ),
      source: { ...geometry().source, sha256: `sha256:${"2".repeat(64)}` },
    };
    const input = {
      ...study(),
      geometry: {
        ...geometry(),
        positions: [
          ...positions,
          ...Array.from({ length: 100 }, () => [0, 0, 0] as PrecisionVec3),
        ],
      },
      referenceSurface: {
        geometry: reference,
        uncertaintyM: 0,
        provenance: "independent",
      },
    };
    expect(evaluatePrecisionStudy(input).status).toBe("inconclusive");
    expect(evaluatePrecisionStudy(input).reasons.join(" ")).toContain("budget");
  });
  it("binds reports to policy, observations and geometry and is key-order-independent", () => {
    const input = study(),
      digest = precisionStudyDigest(input);
    expect(precisionStudyDigest(JSON.parse(JSON.stringify(input)))).toBe(
      digest,
    );
    expect(
      precisionStudyDigest({
        ...input,
        policy: { ...input.policy, toleranceM: 0.02 },
      }),
    ).not.toBe(digest);
    expect(
      precisionStudyDigest({
        ...input,
        geometry: { ...input.geometry, positions: [...positions, [2, 2, 2]] },
      }),
    ).not.toBe(digest);
    expect(evaluatePrecisionStudy(input).dependencyDigest).toBe(digest);
  });
  it("does not turn reflections into proper rigid rotations", () => {
    const input = registered();
    const mirrored = (p: PrecisionVec3): PrecisionVec3 => [-p[0], p[1], p[2]];
    const reflected = {
      ...input,
      controls: [0, 1, 2, 3].map((i) =>
        observation(i, mirrored(positions[i]!)),
      ),
      checks: [4, 5, 6].map((i) => observation(i, mirrored(positions[i]!))),
    };
    expect(evaluatePrecisionStudy(reflected).status).not.toBe("pass_for_scope");
  });
  it("does not hide one bad fit control inside a small RMS", () => {
    const points: PrecisionVec3[] = Array.from({ length: 20 }, (_, index) => [
      index % 5,
      Math.floor(index / 5),
      (index % 3) * 0.5,
    ]);
    points.push([10, 10, 10], [10, 11, 10], [11, 10, 10]);
    const base = study();
    const input: PrecisionStudyV1 = {
      ...base,
      geometry: { ...geometry(), positions: points },
      calibration: { mode: "rigid" },
      controls: points
        .slice(0, 20)
        .map((point, index) =>
          observation(
            index,
            index === 19 ? [point[0], point[1], point[2] + 0.04] : point,
          ),
        ),
      checks: [20, 21, 22].map((index) => observation(index, points[index]!)),
      policy: { ...base.policy, registrationUncertaintyM: 0.0001 },
    };
    const report = evaluatePrecisionStudy(input);
    expect(report.transform!.fitRmsM).toBeLessThan(input.policy.toleranceM);
    expect(report.transform!.fitMaximumResidualM).toBeGreaterThan(
      input.policy.toleranceM,
    );
    expect(report.reasons.join(" ")).toContain("Fit controls disagree");
    expect(report.status).not.toBe("pass_for_scope");
  });
});
