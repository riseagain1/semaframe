import { parseCadPartDefinition, type CadPartDefinitionV1, type CadSketchPlane } from "../modeling/cad";
import { sha256DigestBytes } from "../assets/digest";
import type { MeasurementGeometry } from "./types";

export type FitPoint = readonly [number, number, number];
export type FitOptions = Readonly<{
  /** Coordinates passed to fitting must already be metric in this identified frame. */
  frameId: string;
  sourceGeometryDigest: string;
  toleranceM: number;
  minimumInlierRatio?: number;
}>;
export type FitEvidence = Readonly<{
  algorithm: "semaframe-robust-fit-v1";
  status: "fit_only_not_independent_validation";
  frameId: string;
  sourceGeometryDigest: string;
  toleranceM: number;
  sampleCount: number;
  inlierIndices: readonly number[];
  outlierIndices: readonly number[];
  inlierRmsM: number;
  allSampleRmsM: number;
  maximumResidualM: number;
  assumptions: readonly string[];
}>;
export type PlaneFit = Readonly<{ kind: "plane"; originM: FitPoint; normal: FitPoint; xAxis: FitPoint; yAxis: FitPoint; evidence: FitEvidence }>;
export type CircleFit = Readonly<{ kind: "circle"; centerM: FitPoint; normal: FitPoint; xAxis: FitPoint; yAxis: FitPoint; radiusM: number; angularCoverageRadians: number; evidence: FitEvidence }>;
export type CylinderFit = Readonly<{ kind: "cylinder"; axisOriginM: FitPoint; axisDirection: FitPoint; xAxis: FitPoint; yAxis: FitPoint; radiusM: number; axialRangeM: readonly [number, number]; angularCoverageRadians: number; evidence: FitEvidence }>;
export type CadFitProposal = Readonly<{
  status: "proposal_not_validated";
  definition: CadPartDefinitionV1;
  fit: PlaneFit | CylinderFit;
  assumptions: readonly string[];
}>;

export class PrecisionFittingError extends Error {
  constructor(readonly code: "invalid_fit_input" | "insufficient_support" | "ill_conditioned" | "incomplete_coverage", message: string) {
    super(message); this.name = "PrecisionFittingError";
  }
}
const add = (a: FitPoint, b: FitPoint): FitPoint => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: FitPoint, b: FitPoint): FitPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: FitPoint, s: number): FitPoint => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: FitPoint, b: FitPoint): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: FitPoint, b: FitPoint): FitPoint => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(value: FitPoint): FitPoint {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length < 1e-12) throw new PrecisionFittingError("ill_conditioned", "Cannot resolve a stable geometric direction");
  return scale(value, 1 / length);
}
function canonical(value: FitPoint): FitPoint {
  const unit = normalize(value);
  const largest = [0, 1, 2].sort((a, b) => Math.abs(unit[b]!) - Math.abs(unit[a]!))[0]!;
  return unit[largest]! < 0 ? scale(unit, -1) : unit;
}
function basis(normal: FitPoint): readonly [FitPoint, FitPoint] {
  const seed: FitPoint = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const first = normalize(cross(seed, normal));
  return [first, normalize(cross(normal, first))];
}
function centroid(points: readonly FitPoint[]): FitPoint {
  // Relative summation protects small geometry with large world offsets.
  const origin = points[0]!;
  return add(origin, scale(points.reduce<FitPoint>((sum, point) => add(sum, sub(point, origin)), [0, 0, 0]), 1 / points.length));
}
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.ceil((sorted.length - 1) / 2)]!) / 2;
}
function check(points: readonly FitPoint[], options: FitOptions, minimum: number): void {
  if (points.length < minimum || points.length > 25_000 || points.some((point) => point.length !== 3 || point.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e9))
    || !options.frameId || !/^sha256:[0-9a-f]{64}$/u.test(options.sourceGeometryDigest)
    || !Number.isFinite(options.toleranceM) || options.toleranceM <= 0 || options.toleranceM > 1_000
    || (options.minimumInlierRatio !== undefined && (!Number.isFinite(options.minimumInlierRatio) || options.minimumInlierRatio < 0.5 || options.minimumInlierRatio > 1))) {
    throw new PrecisionFittingError("invalid_fit_input", "Fit requires bounded finite metric points, a frame, SHA256 provenance, and positive tolerance");
  }
}

/** Symmetric covariance eigensystem using bounded Jacobi rotations. */
function covarianceEigen(points: readonly FitPoint[]): { center: FitPoint; values: number[]; axes: FitPoint[] } {
  const center = centroid(points);
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const point of points) {
    const relative = sub(point, center);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) matrix[i]![j]! += relative[i]! * relative[j]! / points.length;
  }
  const eigenvectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 40; iteration += 1) {
    let p = 0; let q = 1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) if (Math.abs(matrix[i!]![j!]!) > Math.abs(matrix[p]![q]!)) { p = i!; q = j!; }
    const diagonalScale = Math.max(...matrix.map((row, i) => Math.abs(row[i]!)), 1e-30);
    if (Math.abs(matrix[p]![q]!) < diagonalScale * 1e-14) break;
    const angle = 0.5 * Math.atan2(2 * matrix[p]![q]!, matrix[q]![q]! - matrix[p]![p]!);
    const c = Math.cos(angle); const s = Math.sin(angle);
    const pp = matrix[p]![p]!; const qq = matrix[q]![q]!; const pq = matrix[p]![q]!;
    for (let k = 0; k < 3; k += 1) {
      if (k !== p && k !== q) {
        const kp = matrix[k]![p]!; const kq = matrix[k]![q]!;
        matrix[k]![p] = matrix[p]![k] = c * kp - s * kq;
        matrix[k]![q] = matrix[q]![k] = s * kp + c * kq;
      }
      const vp = eigenvectors[k]![p]!; const vq = eigenvectors[k]![q]!;
      eigenvectors[k]![p] = c * vp - s * vq;
      eigenvectors[k]![q] = s * vp + c * vq;
    }
    matrix[p]![p] = c * c * pp - 2 * s * c * pq + s * s * qq;
    matrix[q]![q] = s * s * pp + 2 * s * c * pq + c * c * qq;
    matrix[p]![q] = matrix[q]![p] = 0;
  }
  const order = [0, 1, 2].sort((a, b) => matrix[a]![a]! - matrix[b]![b]!);
  return { center, values: order.map((i) => Math.max(0, matrix[i]![i]!)), axes: order.map((i) => canonical([eigenvectors[0]![i]!, eigenvectors[1]![i]!, eigenvectors[2]![i]!])) };
}
function rng(): () => number { let seed = 0x723fa91; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
function evidence(residuals: readonly number[], options: FitOptions, assumptions: readonly string[], minimum: number): FitEvidence {
  const inlierIndices = residuals.flatMap((value, index) => value <= options.toleranceM ? [index] : []);
  if (inlierIndices.length < Math.max(minimum, Math.ceil(residuals.length * (options.minimumInlierRatio ?? 0.75)))) {
    throw new PrecisionFittingError("insufficient_support", "No primitive explains enough source geometry within the requested fit tolerance");
  }
  return {
    algorithm: "semaframe-robust-fit-v1", status: "fit_only_not_independent_validation", frameId: options.frameId,
    sourceGeometryDigest: options.sourceGeometryDigest, toleranceM: options.toleranceM, sampleCount: residuals.length,
    inlierIndices, outlierIndices: residuals.flatMap((value, index) => value > options.toleranceM ? [index] : []),
    inlierRmsM: Math.sqrt(inlierIndices.reduce((sum, index) => sum + residuals[index]! ** 2, 0) / inlierIndices.length),
    allSampleRmsM: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length),
    maximumResidualM: Math.max(...residuals), assumptions,
  };
}

export function fitPlane(pointsM: readonly FitPoint[], options: FitOptions): PlaneFit {
  check(pointsM, options, 6);
  const random = rng();
  let best: number[] = [];
  let bestSum = Infinity;
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const indices = Array.from({ length: 3 }, () => Math.floor(random() * pointsM.length));
    const a = pointsM[indices[0]!]!;
    let normal: FitPoint;
    try { normal = normalize(cross(sub(pointsM[indices[1]!]!, a), sub(pointsM[indices[2]!]!, a))); } catch { continue; }
    const residuals = pointsM.map((point) => Math.abs(dot(sub(point, a), normal)));
    const inliers = residuals.flatMap((residual, index) => residual <= options.toleranceM ? [index] : []);
    const sum = inliers.reduce((total, index) => total + residuals[index]! ** 2, 0);
    if (inliers.length > best.length || (inliers.length === best.length && sum < bestSum)) { best = inliers; bestSum = sum; }
  }
  if (best.length < 6) throw new PrecisionFittingError("ill_conditioned", "Plane support is degenerate");
  let decomposition = covarianceEigen(best.map((index) => pointsM[index]!));
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const inliers = pointsM.filter((point) => Math.abs(dot(sub(point, decomposition.center), decomposition.axes[0]!)) <= options.toleranceM);
    if (inliers.length >= 6) decomposition = covarianceEigen(inliers);
  }
  if (decomposition.values[1]! <= Math.max(1e-18, decomposition.values[2]! * 1e-10)) throw new PrecisionFittingError("ill_conditioned", "Collinear points cannot determine a plane");
  const normal = decomposition.axes[0]!;
  const xAxis = decomposition.axes[2]!;
  const yAxis = normalize(cross(normal, xAxis));
  return { kind: "plane", originM: decomposition.center, normal, xAxis, yAxis,
    evidence: evidence(pointsM.map((point) => Math.abs(dot(sub(point, decomposition.center), normal))), options, ["Only the observed planar region is fitted; its boundary and thickness are not established."], 6) };
}

type Point2 = readonly [number, number];
type Circle2 = { x: number; y: number; radius: number };
function circleThrough(a: Point2, b: Point2, c: Point2): Circle2 | undefined {
  const bx = b[0] - a[0]; const by = b[1] - a[1]; const cx = c[0] - a[0]; const cy = c[1] - a[1];
  const determinant = 2 * (bx * cy - by * cx);
  const length = Math.max(Math.hypot(bx, by), Math.hypot(cx, cy));
  if (Math.abs(determinant) <= 1e-10 * length ** 2) return undefined;
  const x = ((bx * bx + by * by) * cy - (cx * cx + cy * cy) * by) / determinant;
  const y = (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / determinant;
  return { x: a[0] + x, y: a[1] + y, radius: Math.hypot(x, y) };
}
function solve3(matrix: number[][], rhs: number[]): number[] | undefined {
  const rows = matrix.map((row, index) => [...row, rhs[index]!]);
  const magnitude = Math.max(...matrix.flat().map(Math.abs));
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    if (Math.abs(rows[pivot]![column]!) < Math.max(1e-30, magnitude * 1e-14)) return undefined;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const denominator = rows[column]![column]!;
    for (let entry = column; entry < 4; entry += 1) rows[column]![entry]! /= denominator;
    for (let row = 0; row < 3; row += 1) if (row !== column) {
      const factor = rows[row]![column]!;
      for (let entry = column; entry < 4; entry += 1) rows[row]![entry]! -= factor * rows[column]![entry]!;
    }
  }
  return rows.map((row) => row[3]!);
}
function circleRefine(points: readonly Point2[]): Circle2 | undefined {
  const center: Point2 = [points.reduce((sum, point) => sum + point[0], 0) / points.length, points.reduce((sum, point) => sum + point[1], 0) / points.length];
  const size = Math.max(...points.map((point) => Math.hypot(point[0] - center[0], point[1] - center[1])));
  if (!(size > 1e-12)) return undefined;
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]); const rhs = [0, 0, 0];
  for (const point of points) {
    const x = (point[0] - center[0]) / size; const y = (point[1] - center[1]) / size;
    const row = [x, y, 1]; const target = -(x * x + y * y);
    for (let i = 0; i < 3; i += 1) { rhs[i]! += row[i]! * target; for (let j = 0; j < 3; j += 1) matrix[i]![j]! += row[i]! * row[j]!; }
  }
  const solution = solve3(matrix, rhs);
  if (!solution) return undefined;
  const radiusSquared = (solution[0]! ** 2 + solution[1]! ** 2) / 4 - solution[2]!;
  if (!(radiusSquared > 0)) return undefined;
  return { x: center[0] - solution[0]! * size / 2, y: center[1] - solution[1]! * size / 2, radius: Math.sqrt(radiusSquared) * size };
}
function robustCircle(points: readonly Point2[], tolerance: number): Circle2 | undefined {
  const random = rng(); let result: Circle2 | undefined; let best: number[] = []; let score = Infinity;
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const circle = circleThrough(points[Math.floor(random() * points.length)]!, points[Math.floor(random() * points.length)]!, points[Math.floor(random() * points.length)]!);
    if (!circle || !Number.isFinite(circle.radius) || circle.radius <= 0 || circle.radius > 1e6) continue;
    const residuals = points.map((point) => Math.abs(Math.hypot(point[0] - circle.x, point[1] - circle.y) - circle.radius));
    const inliers = residuals.flatMap((value, index) => value <= tolerance ? [index] : []);
    const sum = inliers.reduce((total, index) => total + residuals[index]! ** 2, 0);
    if (inliers.length > best.length || (inliers.length === best.length && sum < score)) { result = circle; best = inliers; score = sum; }
  }
  if (best.length < 6 || !result) return undefined;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const inliers = points.filter((point) => Math.abs(Math.hypot(point[0] - result!.x, point[1] - result!.y) - result!.radius) <= tolerance);
    result = circleRefine(inliers) ?? result;
  }
  return result;
}
function coverage(points: readonly Point2[], circle: Circle2): number {
  const angles = points.map((point) => Math.atan2(point[1] - circle.y, point[0] - circle.x)).sort((a, b) => a - b);
  let maximumGap = angles[0]! + 2 * Math.PI - angles.at(-1)!;
  for (let index = 1; index < angles.length; index += 1) maximumGap = Math.max(maximumGap, angles[index]! - angles[index - 1]!);
  return 2 * Math.PI - maximumGap;
}

export function fitCircle(pointsM: readonly FitPoint[], options: FitOptions): CircleFit {
  check(pointsM, options, 8);
  const plane = fitPlane(pointsM, options);
  const points = pointsM.map((point): Point2 => [dot(sub(point, plane.originM), plane.xAxis), dot(sub(point, plane.originM), plane.yAxis)]);
  const circle = robustCircle(plane.evidence.inlierIndices.map((index) => points[index]!), options.toleranceM);
  if (!circle) throw new PrecisionFittingError("ill_conditioned", "Cannot determine a stable circle");
  const residuals = pointsM.map((point, index) => Math.hypot(dot(sub(point, plane.originM), plane.normal), Math.hypot(points[index]![0] - circle.x, points[index]![1] - circle.y) - circle.radius));
  const fitEvidence = evidence(residuals, options, ["Circularity is fitted only to observed points; the fit is not independent metrological validation."], 8);
  const angularCoverageRadians = coverage(fitEvidence.inlierIndices.map((index) => points[index]!), circle);
  if (angularCoverageRadians < Math.PI * 1.5) throw new PrecisionFittingError("incomplete_coverage", "At least 270 degrees of observed circular support is required");
  return { kind: "circle", centerM: add(plane.originM, add(scale(plane.xAxis, circle.x), scale(plane.yAxis, circle.y))), normal: plane.normal, xAxis: plane.xAxis, yAxis: plane.yAxis, radiusM: circle.radius, angularCoverageRadians, evidence: fitEvidence };
}

export function fitCylinder(pointsM: readonly FitPoint[], options: FitOptions & Readonly<{ axisHint?: { direction: FitPoint; provenance: string } }>): CylinderFit {
  check(pointsM, options, 18);
  if (options.axisHint && (!options.axisHint.provenance.trim() || options.axisHint.direction.some((value) => !Number.isFinite(value)))) throw new PrecisionFittingError("invalid_fit_input", "An explicit cylinder axis requires provenance and finite coordinates");
  const middle: FitPoint = [0, 1, 2].map((axis) => median(pointsM.map((point) => point[axis]!))) as unknown as FitPoint;
  const distances = pointsM.map((point) => Math.hypot(...sub(point, middle)));
  const distanceMedian = median(distances);
  const mad = median(distances.map((value) => Math.abs(value - distanceMedian)));
  const central = pointsM.filter((_, index) => distances[index]! <= distanceMedian + Math.max(6 * mad, distanceMedian * 0.5, options.toleranceM * 4));
  const decomposition = covarianceEigen(central);
  const candidates = options.axisHint ? [canonical(options.axisHint.direction)] : decomposition.axes;
  let best: CylinderFit | undefined;
  for (const axis of candidates) {
    const [xAxis, yAxis] = basis(axis);
    const projected = pointsM.map((point): Point2 => [dot(sub(point, decomposition.center), xAxis), dot(sub(point, decomposition.center), yAxis)]);
    const circle = robustCircle(projected, options.toleranceM);
    if (!circle) continue;
    const residuals = projected.map((point) => Math.abs(Math.hypot(point[0] - circle.x, point[1] - circle.y) - circle.radius));
    let fitEvidence: FitEvidence;
    try { fitEvidence = evidence(residuals, options, [
      options.axisHint ? `Axis supplied explicitly: ${options.axisHint.provenance}` : "Axis selected from robust covariance candidates; arbitrary incomplete scans may require an independently observed axis.",
      "Axial bounds are the observed sample extent, not independently verified end faces. A cylindrical surface does not establish a solid interior.",
    ], 18); } catch { continue; }
    const angularCoverageRadians = coverage(fitEvidence.inlierIndices.map((index) => projected[index]!), circle);
    if (angularCoverageRadians < Math.PI * 1.5) continue;
    const axial = fitEvidence.inlierIndices.map((index) => dot(sub(pointsM[index]!, decomposition.center), axis));
    const minimum = Math.min(...axial); const maximum = Math.max(...axial);
    if (maximum - minimum < Math.max(options.toleranceM * 10, circle.radius * 0.01)) continue;
    const candidate: CylinderFit = { kind: "cylinder", axisOriginM: add(decomposition.center, add(scale(xAxis, circle.x), scale(yAxis, circle.y))), axisDirection: axis, xAxis, yAxis, radiusM: circle.radius, axialRangeM: [minimum, maximum], angularCoverageRadians, evidence: fitEvidence };
    if (!best || candidate.evidence.inlierIndices.length > best.evidence.inlierIndices.length || (candidate.evidence.inlierIndices.length === best.evidence.inlierIndices.length && candidate.evidence.inlierRmsM < best.evidence.inlierRmsM)) best = candidate;
  }
  if (!best) throw new PrecisionFittingError("incomplete_coverage", "A stable cylinder needs sufficient circumferential and axial support; supply an evidenced axis or capture more geometry");
  return best;
}

const vector = (point: FitPoint): { x: number; y: number; z: number } => ({ x: point[0], y: point[1], z: point[2] });
const length = (value: number) => ({ kind: "constant", dimension: "length", value }) as const;
const parameter = (parameterId: string) => ({ kind: "parameter", parameterId }) as const;
function sketchPlane(origin: FitPoint, xAxis: FitPoint, yAxis: FitPoint, normal: FitPoint): CadSketchPlane {
  return { originM: vector(origin), xAxis: vector(xAxis), yAxis: vector(yAxis), normal: vector(normal) };
}

export function proposeShaftCad(pointsM: readonly FitPoint[], options: FitOptions & Readonly<{ partId: string; axisHint?: { direction: FitPoint; provenance: string } }>): CadFitProposal {
  const fit = fitCylinder(pointsM, options);
  const height = fit.axialRangeM[1] - fit.axialRangeM[0];
  const definition: CadPartDefinitionV1 = {
    formatVersion: "1.0", partId: options.partId, displayName: "Fitted shaft proposal", units: "metre",
    parameters: [
      { id: "shaft_radius", name: "Fitted radius", dimension: "length", expression: length(fit.radiusM) },
      { id: "shaft_length", name: "Observed axial span", dimension: "length", expression: length(height) },
    ],
    history: [
      { id: "shaft_profile", name: "Fitted circular profile", kind: "sketch", sketch: {
        plane: sketchPlane(add(fit.axisOriginM, scale(fit.axisDirection, fit.axialRangeM[0])), fit.xAxis, fit.yAxis, fit.axisDirection),
        entities: [{ id: "rim", kind: "circle", center: { x: 0, y: 0 }, radiusM: fit.radiusM }],
        loops: [{ id: "outer", role: "outer", entityIds: ["rim"] }],
        constraints: [{ id: "center", kind: "fixed", point: { entityId: "rim", point: "center" }, position: { x: 0, y: 0 } }, { id: "radius", kind: "radius", entityId: "rim", value: parameter("shaft_radius") }],
      } },
      { id: "shaft_extrude", name: "Observed shaft span", kind: "extrude", profile: { sketchFeatureId: "shaft_profile", loopIds: ["outer"] }, distance: parameter("shaft_length"), operation: "new", resultBodyId: "shaft_body" },
    ], activeBodyIds: ["shaft_body"],
  };
  return { status: "proposal_not_validated", definition: parseCadPartDefinition(definition), fit, assumptions: [
    "A solid circular shaft is proposed from a fitted lateral surface; hidden cavities and end faces are not established.",
    "Observed sample extent is used for length and must be checked with independent end-face or length measurements before acceptance.",
  ] };
}

export function proposePlateCad(pointsM: readonly FitPoint[], options: FitOptions & Readonly<{ partId: string; thicknessM: number; thicknessProvenance: string }>): CadFitProposal {
  if (!Number.isFinite(options.thicknessM) || options.thicknessM <= 0 || options.thicknessM > 1_000 || !options.thicknessProvenance.trim()) throw new PrecisionFittingError("invalid_fit_input", "A planar scan cannot establish thickness; an explicit measured thickness and provenance are required");
  const fit = fitPlane(pointsM, options);
  const selected = fit.evidence.inlierIndices.map((index) => pointsM[index]!);
  const xs = selected.map((point) => dot(sub(point, fit.originM), fit.xAxis));
  const ys = selected.map((point) => dot(sub(point, fit.originM), fit.yAxis));
  const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
  if (Math.min(x1 - x0, y1 - y0) <= options.toleranceM * 10) throw new PrecisionFittingError("ill_conditioned", "Plate footprint is too narrow for the requested tolerance");
  const definition: CadPartDefinitionV1 = {
    formatVersion: "1.0", partId: options.partId, displayName: "Fitted plate proposal", units: "metre",
    parameters: [
      { id: "plate_width", name: "Observed width", dimension: "length", expression: length(x1 - x0) },
      { id: "plate_height", name: "Observed height", dimension: "length", expression: length(y1 - y0) },
      { id: "plate_thickness", name: "Declared measured thickness", dimension: "length", expression: length(options.thicknessM) },
    ],
    history: [
      { id: "plate_profile", name: "Observed rectangular envelope", kind: "sketch", sketch: {
        plane: sketchPlane(add(fit.originM, add(scale(fit.xAxis, x0), scale(fit.yAxis, y0))), fit.xAxis, fit.yAxis, fit.normal),
        entities: [
          { id: "bottom", kind: "line", start: { x: 0, y: 0 }, end: { x: x1 - x0, y: 0 } },
          { id: "right", kind: "line", start: { x: x1 - x0, y: 0 }, end: { x: x1 - x0, y: y1 - y0 } },
          { id: "top", kind: "line", start: { x: x1 - x0, y: y1 - y0 }, end: { x: 0, y: y1 - y0 } },
          { id: "left", kind: "line", start: { x: 0, y: y1 - y0 }, end: { x: 0, y: 0 } },
        ], loops: [{ id: "outer", role: "outer", entityIds: ["bottom", "right", "top", "left"] }],
        constraints: [
          { id: "bottom_left", kind: "coincident", first: { entityId: "bottom", point: "start" }, second: { entityId: "left", point: "end" } },
          { id: "bottom_right", kind: "coincident", first: { entityId: "bottom", point: "end" }, second: { entityId: "right", point: "start" } },
          { id: "top_right", kind: "coincident", first: { entityId: "right", point: "end" }, second: { entityId: "top", point: "start" } },
          { id: "top_left", kind: "coincident", first: { entityId: "top", point: "end" }, second: { entityId: "left", point: "start" } },
          { id: "h_bottom", kind: "horizontal", entityId: "bottom" }, { id: "h_top", kind: "horizontal", entityId: "top" },
          { id: "v_right", kind: "vertical", entityId: "right" }, { id: "v_left", kind: "vertical", entityId: "left" },
          { id: "origin", kind: "fixed", point: { entityId: "bottom", point: "start" }, position: { x: 0, y: 0 } },
          { id: "width", kind: "length", entityId: "bottom", value: parameter("plate_width") },
          { id: "height", kind: "length", entityId: "right", value: parameter("plate_height") },
        ],
      } },
      { id: "plate_extrude", name: "Declared measured thickness", kind: "extrude", profile: { sketchFeatureId: "plate_profile", loopIds: ["outer"] }, distance: parameter("plate_thickness"), operation: "new", resultBodyId: "plate_body" },
    ], activeBodyIds: ["plate_body"],
  };
  return { status: "proposal_not_validated", definition: parseCadPartDefinition(definition), fit, assumptions: [
    "The in-plane rectangular envelope is a proposed footprint, not evidence that the real boundary is rectangular or fully observed.",
    `Thickness supplied explicitly: ${options.thicknessProvenance}`,
    "Thickness is extruded along the fitted normal; the unobserved back face and hidden features require independent checks.",
  ] };
}

/** Binds fitted results to exact metric coordinates, not merely an original-file hash. */
export function measurementGeometryDigest(geometry: MeasurementGeometry): `sha256:${string}` {
  return sha256DigestBytes(new TextEncoder().encode(JSON.stringify({
    geometryId: geometry.geometryId, positions: geometry.positions, triangles: geometry.triangles ?? [],
    units: geometry.units, coordinateBasis: geometry.coordinateBasis, source: geometry.source,
  })));
}
type MetricFitOptions = Omit<FitOptions, "frameId" | "sourceGeometryDigest"> & Readonly<{ frameId?: string }>;
function metricOptions(geometry: MeasurementGeometry, options: MetricFitOptions): FitOptions {
  if (geometry.units !== "metre" || geometry.coordinateBasis !== "RUB" || !/^sha256:[0-9a-f]{64}$/u.test(geometry.source.sha256)) {
    throw new PrecisionFittingError("invalid_fit_input", "Apply a solved metric calibration before fitting; unknown-scale geometry cannot produce metric CAD");
  }
  return { ...options, frameId: options.frameId ?? geometry.geometryId, sourceGeometryDigest: measurementGeometryDigest(geometry) };
}
export function fitMeasurementPlane(geometry: MeasurementGeometry, options: MetricFitOptions): PlaneFit {
  return fitPlane(geometry.positions, metricOptions(geometry, options));
}
export function fitMeasurementCircle(geometry: MeasurementGeometry, options: MetricFitOptions): CircleFit {
  return fitCircle(geometry.positions, metricOptions(geometry, options));
}
export function fitMeasurementCylinder(geometry: MeasurementGeometry, options: MetricFitOptions & Readonly<{ axisHint?: { direction: FitPoint; provenance: string } }>): CylinderFit {
  return fitCylinder(geometry.positions, { ...metricOptions(geometry, options), ...(options.axisHint ? { axisHint: options.axisHint } : {}) });
}
export function proposeMeasurementShaftCad(geometry: MeasurementGeometry, options: MetricFitOptions & Readonly<{ partId: string; axisHint?: { direction: FitPoint; provenance: string } }>): CadFitProposal {
  return proposeShaftCad(geometry.positions, { ...metricOptions(geometry, options), partId: options.partId, ...(options.axisHint ? { axisHint: options.axisHint } : {}) });
}
export function proposeMeasurementPlateCad(geometry: MeasurementGeometry, options: MetricFitOptions & Readonly<{ partId: string; thicknessM: number; thicknessProvenance: string }>): CadFitProposal {
  return proposePlateCad(geometry.positions, { ...metricOptions(geometry, options), partId: options.partId, thicknessM: options.thicknessM, thicknessProvenance: options.thicknessProvenance });
}
