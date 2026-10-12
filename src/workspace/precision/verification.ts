import { sha256DigestBytes } from "../assets/digest";
import { stableStringify } from "../components/manifestDigest";
import {
  applyPrecisionTransform,
  precisionUnitScale,
  solvePrecisionCalibration,
} from "./calibration";
import { distance3, scale3 } from "./math";
import { parsePrecisionStudy } from "./validation";
import {
  PRECISION_LIMITS,
  type PrecisionCheckResult,
  type PrecisionReport,
  type PrecisionStudyV1,
  type PrecisionVec3,
} from "./types";

export function precisionStudyDigest(input: PrecisionStudyV1): string {
  return sha256DigestBytes(
    new TextEncoder().encode(stableStringify(parsePrecisionStudy(input))),
  );
}
const limitations = [
  "Acceptance covers only the declared independent observations and regions, not unobserved surfaces, internal geometry, manufacturing fitness or physics.",
  "Reference accuracy, uncertainty bounds, regional coverage and independence are supplied claims, not instrument certification; hashes only protect content integrity.",
  "This pure evaluator checks the current geometry document; it does not prove that editable coordinates were derived unchanged from the source bytes named in provenance.",
  "Fit RMS is not independent accuracy. Source units and RUB are working-frame declarations, not geodetic or survey registration.",
  "No confidence level is inferred. Uncertainty inputs must be conservative bounds for the intended use; tuning against checks requires new independent checks.",
  "Surface diagnostics compare all supplied vertices in both directions, not continuous triangle surfaces; sampling gaps are not certified.",
] as const;
function classify(
  id: string,
  kind: PrecisionCheckResult["kind"],
  errorM: number,
  uncertaintyM: number | null,
  toleranceM: number,
): PrecisionCheckResult {
  const conservativeErrorM =
    uncertaintyM === null ? null : errorM + uncertaintyM;
  return {
    id,
    kind,
    errorM,
    uncertaintyM,
    conservativeErrorM,
    status:
      uncertaintyM === null
        ? "inconclusive"
        : conservativeErrorM! <= toleranceM
          ? "pass"
          : Math.max(0, errorM - uncertaintyM) > toleranceM
            ? "fail"
            : "inconclusive",
  };
}
function maximumNearestDistance(
  a: readonly PrecisionVec3[],
  b: readonly PrecisionVec3[],
): number {
  let max = 0;
  for (const point of a) {
    let minimum = Infinity;
    for (const target of b)
      minimum = Math.min(minimum, distance3(point, target));
    max = Math.max(max, minimum);
  }
  return max;
}
/** Host-derived assessment. No serialized status/report is accepted as input. */
export function evaluatePrecisionStudy(
  input: PrecisionStudyV1,
): PrecisionReport {
  const study = parsePrecisionStudy(input);
  const base = {
    version: 1 as const,
    evaluatorVersion: "precision-v1" as const,
    dependencyDigest: precisionStudyDigest(study),
    intendedUse: study.policy.intendedUse,
    toleranceM: study.policy.toleranceM,
    scope: "declared-independent-observations-only" as const,
    limitations,
  };
  const reasons: string[] = [];
  const checks: PrecisionCheckResult[] = [];
  let transform;
  try {
    transform = solvePrecisionCalibration(study);
  } catch (error) {
    return {
      ...base,
      status: "unverified",
      transform: null,
      checks: [],
      verifiedRegions: [],
      reasons: [
        error instanceof Error ? error.message : "Calibration unavailable",
      ],
    };
  }
  const positions = study.geometry.positions.map((point) =>
    applyPrecisionTransform(transform, point),
  );
  if (
    positions.some((point) =>
      point.some(
        (v) =>
          !Number.isFinite(v) ||
          Math.abs(v) > PRECISION_LIMITS.maximumCoordinateMagnitude,
      ),
    )
  ) {
    return {
      ...base,
      status: "unverified",
      transform: null,
      checks: [],
      verifiedRegions: [],
      reasons: [
        "Calibrated geometry is outside finite supported coordinate bounds",
      ],
    };
  }
  const maxMagnitude = positions.reduce(
    (m, p) => Math.max(m, ...p.map(Math.abs)),
    1,
  );
  const numericBound = 64 * Number.EPSILON * maxMagnitude;
  const usesRegistration = study.calibration.mode !== "declared-units";
  const registrationBound = usesRegistration
    ? (study.policy.registrationUncertaintyM ?? null)
    : 0;
  if (usesRegistration && registrationBound === null)
    reasons.push(
      "A conservative registration uncertainty bound over the check regions is required; fit RMS cannot substitute for it",
    );
  if (
    usesRegistration &&
    study.controls.some((control) => control.uncertaintyM === null)
  )
    reasons.push("Fit control measurement uncertainty is unknown");
  if (transform.fitMaximumResidualM > study.policy.toleranceM)
    reasons.push(
      "Fit controls disagree beyond the target tolerance; no controls were silently trimmed",
    );
  const totalUncertainty = (
    reference: number | null,
    multiplier = 1,
  ): number | null =>
    reference === null || registrationBound === null
      ? null
      : reference + multiplier * registrationBound + numericBound;
  for (const observation of study.checks)
    checks.push(
      classify(
        observation.id,
        "point",
        distance3(
          positions[observation.vertexIndex]!,
          observation.referencePointM,
        ),
        totalUncertainty(observation.uncertaintyM),
        study.policy.toleranceM,
      ),
    );
  for (const observation of study.dimensions)
    checks.push(
      classify(
        observation.id,
        "dimension",
        Math.abs(
          distance3(
            positions[observation.aIndex]!,
            positions[observation.bIndex]!,
          ) - observation.referenceDistanceM,
        ),
        totalUncertainty(observation.uncertaintyM, 2),
        study.policy.toleranceM,
      ),
    );
  if (study.referenceSurface) {
    const referenceScale = precisionUnitScale(
      study.referenceSurface.geometry.units,
    );
    if (referenceScale === null)
      reasons.push("Reference point-set units are unknown");
    else if (
      2 * positions.length * study.referenceSurface.geometry.positions.length >
      PRECISION_LIMITS.maximumSurfaceComparisons
    )
      reasons.push(
        "Bidirectional point-set comparison exceeds the bounded comparison budget; no implicit downsampling was performed",
      );
    else {
      const reference = study.referenceSurface.geometry.positions.map((p) =>
        scale3(p, referenceScale),
      );
      checks.push(
        classify(
          "surface:source-to-reference",
          "surface",
          maximumNearestDistance(positions, reference),
          totalUncertainty(study.referenceSurface.uncertaintyM),
          study.policy.toleranceM,
        ),
      );
      checks.push(
        classify(
          "surface:reference-to-source",
          "surface",
          maximumNearestDistance(reference, positions),
          totalUncertainty(study.referenceSurface.uncertaintyM),
          study.policy.toleranceM,
        ),
      );
    }
  }
  const independentCount = study.checks.length + study.dimensions.length;
  if (independentCount < study.policy.minimumIndependentChecks)
    reasons.push(
      `Need at least ${study.policy.minimumIndependentChecks} independent point/dimension checks; received ${independentCount}`,
    );
  const passingIds = new Set(
    checks.filter((check) => check.status === "pass").map((check) => check.id),
  );
  const verifiedRegions = [
    ...new Set(
      [...study.checks, ...study.dimensions]
        .filter((check) => passingIds.has(check.id))
        .map((check) => check.regionId),
    ),
  ];
  const missingRegions = study.policy.requiredRegions.filter(
    (region) => !verifiedRegions.includes(region),
  );
  if (missingRegions.length)
    reasons.push(
      `Required regions lack passing independent observations: ${missingRegions.join(", ")}`,
    );
  if (checks.some((check) => check.status === "inconclusive"))
    reasons.push(
      "Unknown uncertainty or tolerance-boundary overlap prevents acceptance of one or more checks",
    );
  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : independentCount === 0
      ? "unverified"
      : reasons.length
        ? "inconclusive"
        : "pass_for_scope";
  return { ...base, status, transform, checks, reasons, verifiedRegions };
}
