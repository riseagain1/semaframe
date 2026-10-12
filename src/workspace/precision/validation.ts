import { z } from "zod";
import {
  PRECISION_LIMITS,
  type MeasurementGeometry,
  type PrecisionStudyV1,
} from "./types";

const finite = z.number().finite();
const coordinate = finite
  .min(-PRECISION_LIMITS.maximumCoordinateMagnitude)
  .max(PRECISION_LIMITS.maximumCoordinateMagnitude);
const vec = z.tuple([coordinate, coordinate, coordinate]);
const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(2048);
const index = z
  .number()
  .int()
  .nonnegative()
  .max(PRECISION_LIMITS.maximumVertices - 1);
const uncertainty = finite.nonnegative().max(1e9).nullable();
export const MeasurementGeometrySchema = z
  .object({
    geometryId: id,
    positions: z.array(vec).min(1).max(PRECISION_LIMITS.maximumVertices),
    triangles: z
      .array(z.tuple([index, index, index]))
      .max(PRECISION_LIMITS.maximumTriangles)
      .optional(),
    units: z.enum(["metre", "millimetre", "centimetre", "inch", "unknown"]),
    coordinateBasis: z.literal("RUB"),
    source: z
      .object({
        sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        format: id,
        provenance: text,
      })
      .strict(),
  })
  .strict()
  .superRefine((geometry, context) => {
    geometry.triangles?.forEach((triangle, i) => {
      if (
        triangle.some((vertex) => vertex >= geometry.positions.length) ||
        new Set(triangle).size !== 3
      ) {
        context.addIssue({
          code: "custom",
          path: ["triangles", i],
          message:
            "Triangle must contain three distinct in-range vertex indices",
        });
      }
    });
  });
const point = z
  .object({
    id,
    vertexIndex: index,
    referencePointM: vec,
    uncertaintyM: uncertainty,
    provenance: text,
    regionId: id,
  })
  .strict();
const dimension = z
  .object({
    id,
    aIndex: index,
    bIndex: index,
    referenceDistanceM: finite.positive().max(1e9),
    uncertaintyM: uncertainty,
    provenance: text,
    regionId: id,
  })
  .strict();
export const PrecisionStudySchema = z
  .object({
    version: z.literal(1),
    geometry: MeasurementGeometrySchema,
    controls: z.array(point).max(PRECISION_LIMITS.maximumObservations),
    checks: z.array(point).max(PRECISION_LIMITS.maximumObservations),
    dimensions: z.array(dimension).max(PRECISION_LIMITS.maximumObservations),
    calibration: z
      .object({ mode: z.enum(["declared-units", "rigid", "similarity"]) })
      .strict(),
    policy: z
      .object({
        intendedUse: text,
        toleranceM: finite.positive().max(1e6),
        minimumIndependentChecks: z
          .number()
          .int()
          .min(3)
          .max(PRECISION_LIMITS.maximumObservations),
        requiredRegions: z.array(id).min(1).max(64),
        uncertaintyBasis: text,
        registrationUncertaintyM: uncertainty.optional(),
        surfaceUncertaintyM: uncertainty.optional(),
        surfaceUncertaintyBasis: text.optional(),
      })
      .strict(),
    referenceSurface: z
      .object({
        geometry: MeasurementGeometrySchema,
        uncertaintyM: uncertainty,
        provenance: text,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((study, context) => {
    const error = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const ids = new Set<string>();
    const controlVertices = new Set<number>();
    const controlReferences = new Set<string>();
    const controlLocations = new Set<string>();
    const checkVertices = new Set<number>();
    const checkReferences = new Set<string>();
    const dimensionPairs = new Set<string>();
    if (
      study.policy.surfaceUncertaintyM != null &&
      !study.policy.surfaceUncertaintyBasis
    )
      error(
        ["policy", "surfaceUncertaintyBasis"],
        "A supplied surface uncertainty bound requires its measurement/evidence basis",
      );
    if (
      new Set(study.policy.requiredRegions).size !==
      study.policy.requiredRegions.length
    )
      error(["policy", "requiredRegions"], "Region identifiers must be unique");
    for (const group of ["controls", "checks"] as const) {
      study[group].forEach((observation, i) => {
        if (ids.has(observation.id))
          error(
            [group, i, "id"],
            "Observation IDs must be unique across fit controls and held-out checks",
          );
        ids.add(observation.id);
        if (observation.vertexIndex >= study.geometry.positions.length)
          error(
            [group, i, "vertexIndex"],
            "Observation vertex is out of range",
          );
        const reference = JSON.stringify(observation.referencePointM);
        if (group === "controls") {
          if (
            controlVertices.has(observation.vertexIndex) ||
            controlReferences.has(reference)
          )
            error([group, i], "Duplicate fit control");
          controlVertices.add(observation.vertexIndex);
          controlReferences.add(reference);
          controlLocations.add(
            JSON.stringify(study.geometry.positions[observation.vertexIndex]),
          );
        } else {
          if (
            controlVertices.has(observation.vertexIndex) ||
            controlReferences.has(reference) ||
            controlLocations.has(
              JSON.stringify(study.geometry.positions[observation.vertexIndex]),
            )
          )
            error(
              [group, i],
              "A fit control cannot be reused as an independent check",
            );
          if (
            checkVertices.has(observation.vertexIndex) ||
            checkReferences.has(reference)
          )
            error(
              [group, i],
              "Duplicate check vertex does not add independent evidence",
            );
          checkVertices.add(observation.vertexIndex);
          checkReferences.add(reference);
        }
      });
    }
    study.dimensions.forEach((observation, i) => {
      if (ids.has(observation.id))
        error(["dimensions", i, "id"], "Observation IDs must be unique");
      ids.add(observation.id);
      if (
        observation.aIndex === observation.bIndex ||
        [observation.aIndex, observation.bIndex].some(
          (v) => v >= study.geometry.positions.length,
        )
      )
        error(
          ["dimensions", i],
          "Dimension requires distinct in-range vertices",
        );
      if (
        [observation.aIndex, observation.bIndex].some(
          (index) =>
            controlVertices.has(index) ||
            controlLocations.has(
              JSON.stringify(study.geometry.positions[index]),
            ),
        )
      )
        error(
          ["dimensions", i],
          "Reserved check dimensions must not reuse fitted control vertices",
        );
      const pair = [observation.aIndex, observation.bIndex]
        .sort((a, b) => a - b)
        .join(":");
      if (dimensionPairs.has(pair))
        error(
          ["dimensions", i],
          "Duplicate dimension does not add independent evidence",
        );
      dimensionPairs.add(pair);
    });
    if (
      study.controls.length + study.checks.length + study.dimensions.length >
      PRECISION_LIMITS.maximumObservations
    )
      error(["checks"], "Total observation limit exceeded");
    if (
      study.referenceSurface?.geometry.source.sha256 ===
      study.geometry.source.sha256
    )
      error(
        ["referenceSurface"],
        "The same source bytes cannot serve as independent reference geometry",
      );
  });
export function parseMeasurementGeometry(value: unknown): MeasurementGeometry {
  return MeasurementGeometrySchema.parse(value);
}
export function parsePrecisionStudy(value: unknown): PrecisionStudyV1 {
  return PrecisionStudySchema.parse(value);
}
export function createPrecisionStudy(
  geometry: MeasurementGeometry,
): PrecisionStudyV1 {
  return parsePrecisionStudy({
    version: 1,
    geometry,
    controls: [],
    checks: [],
    dimensions: [],
    calibration: { mode: "declared-units" },
    policy: {
      intendedUse:
        "Unspecified dimensional inspection; acceptance scope must be declared",
      toleranceM: 0.002,
      minimumIndependentChecks: 3,
      requiredRegions: ["declared-region"],
      uncertaintyBasis:
        "Unknown; independent measurement uncertainty must be supplied before acceptance",
    },
  });
}
