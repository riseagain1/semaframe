import {
  add3,
  assertNonCollinear,
  distance3,
  dot3,
  mean3,
  multiply3,
  scale3,
  sub3,
  symmetricEigen,
} from "./math";
import { parsePrecisionStudy } from "./validation";
import {
  PRECISION_LIMITS,
  type MeasurementGeometry,
  type PrecisionStudyV1,
  type PrecisionTransform,
  type PrecisionUnit,
  type PrecisionVec3,
} from "./types";

export function precisionUnitScale(unit: PrecisionUnit): number | null {
  return {
    metre: 1,
    millimetre: 0.001,
    centimetre: 0.01,
    inch: 0.0254,
    unknown: null,
  }[unit];
}
const identity: readonly PrecisionVec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
export function applyPrecisionTransform(
  transform: PrecisionTransform,
  point: PrecisionVec3,
): PrecisionVec3 {
  return add3(
    scale3(multiply3(transform.rotation, point), transform.scale),
    transform.translation,
  );
}
export function solvePrecisionCalibration(
  input: PrecisionStudyV1,
): PrecisionTransform {
  const study = parsePrecisionStudy(input);
  const unit = precisionUnitScale(study.geometry.units);
  if (study.calibration.mode === "declared-units") {
    if (unit === null)
      throw new Error(
        "Unknown source units require a measured similarity registration",
      );
    if (study.controls.length)
      throw new Error(
        "Declared-units mode cannot silently ignore fit controls",
      );
    return {
      scale: unit,
      rotation: identity,
      translation: [0, 0, 0],
      fitRmsM: 0,
      fitMaximumResidualM: 0,
      controlCount: 0,
    };
  }
  if (study.calibration.mode === "rigid" && unit === null)
    throw new Error("Rigid registration requires declared source units");
  const initialScale = unit ?? 1;
  const source = study.controls.map((control) =>
    scale3(study.geometry.positions[control.vertexIndex]!, initialScale),
  );
  const target = study.controls.map((control) => control.referencePointM);
  assertNonCollinear(source);
  assertNonCollinear(target);
  const sourceMean = mean3(source),
    targetMean = mean3(target);
  const x = source.map((p) => sub3(p, sourceMean)),
    y = target.map((p) => sub3(p, targetMean));
  const s = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let n = 0; n < x.length; n++)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) s[i]![j]! += x[n]![i]! * y[n]![j]!;
  const [a, b, c] = s as [number[], number[], number[]];
  const trace = a[0]! + b[1]! + c[2]!;
  // Horn's proper-rotation quaternion solution; reflection is never admitted.
  const n = [
    [trace, b[2]! - c[1]!, c[0]! - a[2]!, a[1]! - b[0]!],
    [b[2]! - c[1]!, a[0]! - b[1]! - c[2]!, a[1]! + b[0]!, c[0]! + a[2]!],
    [c[0]! - a[2]!, a[1]! + b[0]!, -a[0]! + b[1]! - c[2]!, b[2]! + c[1]!],
    [a[1]! - b[0]!, c[0]! + a[2]!, b[2]! + c[1]!, -a[0]! - b[1]! + c[2]!],
  ];
  const eig = symmetricEigen(n);
  const largest = eig.values.indexOf(Math.max(...eig.values));
  const q = eig.vectors.map((row) => row[largest]!);
  const qNorm = Math.hypot(...q);
  const [w, i, j, k] = q.map((v) => v / qNorm) as [
    number,
    number,
    number,
    number,
  ];
  const rotation: readonly PrecisionVec3[] = [
    [1 - 2 * (j * j + k * k), 2 * (i * j - k * w), 2 * (i * k + j * w)],
    [2 * (i * j + k * w), 1 - 2 * (i * i + k * k), 2 * (j * k - i * w)],
    [2 * (i * k - j * w), 2 * (j * k + i * w), 1 - 2 * (i * i + j * j)],
  ];
  const denominator = x.reduce((sum, p) => sum + dot3(p, p), 0);
  const scale =
    study.calibration.mode === "similarity"
      ? x.reduce(
          (sum, p, index) => sum + dot3(y[index]!, multiply3(rotation, p)),
          0,
        ) / denominator
      : 1;
  if (!Number.isFinite(scale) || scale < 1e-12 || scale > 1e12)
    throw new Error(
      "Registration scale is invalid or outside supported conditioning limits",
    );
  const translation = sub3(
    targetMean,
    scale3(multiply3(rotation, sourceMean), scale),
  );
  const transform: PrecisionTransform = {
    scale: scale * initialScale,
    rotation,
    translation,
    fitRmsM: 0,
    fitMaximumResidualM: 0,
    controlCount: source.length,
  };
  const fitRmsM = Math.sqrt(
    study.controls.reduce(
      (sum, control) =>
        sum +
        distance3(
          applyPrecisionTransform(
            transform,
            study.geometry.positions[control.vertexIndex]!,
          ),
          control.referencePointM,
        ) **
          2,
      0,
    ) / source.length,
  );
  if (!Number.isFinite(fitRmsM))
    throw new Error("Registration produced non-finite residuals");
  const fitMaximumResidualM = Math.max(
    ...study.controls.map((control) =>
      distance3(
        applyPrecisionTransform(
          transform,
          study.geometry.positions[control.vertexIndex]!,
        ),
        control.referencePointM,
      ),
    ),
  );
  return { ...transform, fitRmsM, fitMaximumResidualM };
}
export function calibratedGeometry(
  input: PrecisionStudyV1,
): MeasurementGeometry {
  const study = parsePrecisionStudy(input),
    transform = solvePrecisionCalibration(study);
  const positions = study.geometry.positions.map((point) =>
    applyPrecisionTransform(transform, point),
  );
  if (
    positions.some((point) =>
      point.some(
        (value) =>
          !Number.isFinite(value) ||
          Math.abs(value) > PRECISION_LIMITS.maximumCoordinateMagnitude,
      ),
    )
  )
    throw new Error("Calibrated geometry exceeds supported coordinate bounds");
  return { ...study.geometry, units: "metre", positions };
}
