import { sha256DigestBytes } from "../assets/digest";
import { stableStringify } from "../components/manifestDigest";
import { calibratedGeometry } from "./calibration";
import { add3, dot3, scale3, sub3 } from "./math";
import { parseMeasurementGeometry, parsePrecisionStudy } from "./validation";
import { evaluatePrecisionStudy } from "./verification";
import {
  PRECISION_LIMITS,
  type MeasurementGeometry,
  type PrecisionReport,
  type PrecisionStatus,
  type PrecisionStudyV1,
  type PrecisionVec3,
} from "./types";

type Bounds = { min: PrecisionVec3; max: PrecisionVec3 };
type Primitive = {
  bounds: Bounds;
  centre: PrecisionVec3;
  points: readonly PrecisionVec3[];
};
type Node = {
  bounds: Bounds;
  items?: readonly Primitive[];
  left?: Node;
  right?: Node;
};
type Budget = { operations: number };
export type PrecisionDeviationSummary = Readonly<{
  maximumM: number;
  rmsM: number;
  p95M: number;
  count: number;
  method: "point-to-triangle" | "nearest-vertex-diagnostic";
}>;
export type PrecisionCadComparison = Readonly<{
  status: PrecisionStatus;
  dependencyDigest: string;
  sourceReport: PrecisionReport;
  targetDefinitionDigest: string;
  tessellationBoundM: number;
  sourceToCad: PrecisionDeviationSummary | null;
  cadToSource: PrecisionDeviationSummary | null;
  conservativeMaximumM: number | null;
  uncertaintyAuthority: "supplied-not-certified";
  reasons: readonly string[];
  scope: "bidirectional-sampled-vertices-only";
  limitations: readonly string[];
}>;
const lengthSquared = (p: PrecisionVec3) => dot3(p, p);
function boundsOf(points: readonly PrecisionVec3[]): Bounds {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, p[axis]!);
      max[axis] = Math.max(max[axis]!, p[axis]!);
    }
  return {
    min: min as unknown as PrecisionVec3,
    max: max as unknown as PrecisionVec3,
  };
}
function nodeBounds(items: readonly Primitive[]): Bounds {
  return boundsOf(items.flatMap((item) => [item.bounds.min, item.bounds.max]));
}
function makeTree(items: Primitive[]): Node {
  const bounds = nodeBounds(items);
  if (items.length <= 8) return { bounds, items };
  const spans = sub3(bounds.max, bounds.min);
  const axis = spans.indexOf(Math.max(...spans));
  items.sort((a, b) => a.centre[axis]! - b.centre[axis]!);
  const split = Math.floor(items.length / 2);
  return {
    bounds,
    left: makeTree(items.slice(0, split)),
    right: makeTree(items.slice(split)),
  };
}
function boxDistanceSquared(point: PrecisionVec3, bounds: Bounds): number {
  let distance = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.max(
      bounds.min[i]! - point[i]!,
      0,
      point[i]! - bounds.max[i]!,
    );
    distance += d * d;
  }
  return distance;
}
function segmentDistanceSquared(
  p: PrecisionVec3,
  a: PrecisionVec3,
  b: PrecisionVec3,
): number {
  const ab = sub3(b, a),
    denominator = lengthSquared(ab);
  const t =
    denominator === 0
      ? 0
      : Math.max(0, Math.min(1, dot3(sub3(p, a), ab) / denominator));
  return lengthSquared(sub3(p, add3(a, scale3(ab, t))));
}
/** Exact closest point over a triangle, including robust degenerate-edge fallback. */
export function precisionPointTriangleDistanceSquared(
  p: PrecisionVec3,
  a: PrecisionVec3,
  b: PrecisionVec3,
  c: PrecisionVec3,
): number {
  const ab = sub3(b, a),
    ac = sub3(c, a),
    ap = sub3(p, a);
  const areaSquared = lengthSquared([
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ]);
  if (
    areaSquared <=
    Number.EPSILON *
      Number.EPSILON *
      Math.max(lengthSquared(ab) * lengthSquared(ac), Number.MIN_VALUE)
  )
    return Math.min(
      segmentDistanceSquared(p, a, b),
      segmentDistanceSquared(p, a, c),
      segmentDistanceSquared(p, b, c),
    );
  const d1 = dot3(ab, ap),
    d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return lengthSquared(ap);
  const bp = sub3(p, b),
    d3 = dot3(ab, bp),
    d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return lengthSquared(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0)
    return lengthSquared(sub3(p, add3(a, scale3(ab, d1 / (d1 - d3)))));
  const cp = sub3(p, c),
    d5 = dot3(ab, cp),
    d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return lengthSquared(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0)
    return lengthSquared(sub3(p, add3(a, scale3(ac, d2 / (d2 - d6)))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return lengthSquared(
      sub3(p, add3(b, scale3(sub3(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))))),
    );
  const denominator = 1 / (va + vb + vc);
  const projection = add3(
    a,
    add3(scale3(ab, vb * denominator), scale3(ac, vc * denominator)),
  );
  return Math.max(0, lengthSquared(sub3(p, projection)));
}
function makePrimitives(geometry: MeasurementGeometry): Primitive[] {
  const entries = geometry.triangles?.length
    ? geometry.triangles.map((triangle) =>
        triangle.map((index) => geometry.positions[index]!),
      )
    : geometry.positions.map((point) => [point]);
  return entries.map((points) => {
    const bounds = boundsOf(points);
    return {
      bounds,
      centre: scale3(add3(bounds.min, bounds.max), 0.5),
      points,
    };
  });
}
function hasDegenerateTriangles(geometry: MeasurementGeometry): boolean {
  return (
    geometry.triangles?.some((triangle) => {
      const a = geometry.positions[triangle[0]]!,
        ab = sub3(geometry.positions[triangle[1]]!, a),
        ac = sub3(geometry.positions[triangle[2]]!, a);
      const cross: PrecisionVec3 = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      return (
        lengthSquared(cross) <=
        Number.EPSILON *
          Number.EPSILON *
          Math.max(lengthSquared(ab) * lengthSquared(ac), Number.MIN_VALUE)
      );
    }) ?? false
  );
}
function nearestSquared(
  point: PrecisionVec3,
  node: Node,
  budget: Budget,
  best = Infinity,
): number {
  if (++budget.operations > PRECISION_LIMITS.maximumSurfaceComparisons)
    throw new Error(
      "Exact comparison budget exceeded; no vertices or triangles were downsampled",
    );
  if (boxDistanceSquared(point, node.bounds) > best) return best;
  if (node.items) {
    for (const item of node.items) {
      if (++budget.operations > PRECISION_LIMITS.maximumSurfaceComparisons)
        throw new Error(
          "Exact comparison budget exceeded; no vertices or triangles were downsampled",
        );
      if (boxDistanceSquared(point, item.bounds) > best) continue;
      const d =
        item.points.length === 3
          ? precisionPointTriangleDistanceSquared(
              point,
              item.points[0]!,
              item.points[1]!,
              item.points[2]!,
            )
          : lengthSquared(sub3(point, item.points[0]!));
      best = Math.min(best, d);
    }
    return best;
  }
  const left = node.left!,
    right = node.right!;
  const [first, second] =
    boxDistanceSquared(point, left.bounds) <=
    boxDistanceSquared(point, right.bounds)
      ? [left, right]
      : [right, left];
  best = nearestSquared(point, first, budget, best);
  return nearestSquared(point, second, budget, best);
}
function deviations(
  source: MeasurementGeometry,
  target: MeasurementGeometry,
  budget: Budget,
): PrecisionDeviationSummary {
  const tree = makeTree(makePrimitives(target));
  const distances = source.positions.map((point) =>
    Math.sqrt(nearestSquared(point, tree, budget)),
  );
  const sorted = [...distances].sort((a, b) => a - b);
  return {
    maximumM: sorted.at(-1)!,
    rmsM: Math.sqrt(
      distances.reduce((sum, v) => sum + v * v, 0) / distances.length,
    ),
    p95M: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!,
    count: distances.length,
    method: target.triangles?.length
      ? "point-to-triangle"
      : "nearest-vertex-diagnostic",
  };
}
export function compareMeasurementToCad(
  input: PrecisionStudyV1,
  targetInput: MeasurementGeometry,
  options: Readonly<{
    targetDefinitionDigest: string;
    tessellationBoundM: number;
  }>,
): PrecisionCadComparison {
  const study = parsePrecisionStudy(input),
    target = parseMeasurementGeometry(targetInput),
    sourceReport = evaluatePrecisionStudy(study);
  if (
    !options.targetDefinitionDigest ||
    options.targetDefinitionDigest.length > 256
  )
    throw new Error("Target definition digest is required and bounded");
  if (
    !Number.isFinite(options.tessellationBoundM) ||
    options.tessellationBoundM < 0 ||
    options.tessellationBoundM > 1e6
  )
    throw new Error(
      "A finite nonnegative tessellation error bound is required",
    );
  if (target.units !== "metre")
    throw new Error(
      "Host CAD geometry must be normalized to metre working coordinates",
    );
  const dependencyDigest = sha256DigestBytes(
    new TextEncoder().encode(
      stableStringify({
        source: sourceReport.dependencyDigest,
        target,
        options,
      }),
    ),
  );
  const reasons: string[] = [];
  const resultBase = {
    dependencyDigest,
    sourceReport,
    targetDefinitionDigest: options.targetDefinitionDigest,
    tessellationBoundM: options.tessellationBoundM,
    uncertaintyAuthority: "supplied-not-certified" as const,
    scope: "bidirectional-sampled-vertices-only" as const,
    limitations: [
      "Only supplied sampled vertices are compared against triangle surfaces; continuous surface extrema, unseen regions and manufacturing fitness are not certified.",
      "Source acceptance covers its independent observations, not a blanket transfer of real-world accuracy to CAD. A separate surface uncertainty bound and basis are supplied claims.",
      "Tessellation error bounds depend on host/kernel meshing guarantees; nearest-vertex fallback is diagnostic only. No inference of instrument calibration or statistical confidence is made.",
    ],
  };
  let sourceToCad: PrecisionDeviationSummary | null = null,
    cadToSource: PrecisionDeviationSummary | null = null;
  try {
    const source = calibratedGeometry(study),
      budget = { operations: 0 };
    if (hasDegenerateTriangles(source) || hasDegenerateTriangles(target))
      reasons.push(
        "Degenerate triangles prevent surface acceptance; edge-fallback distances are diagnostics only",
      );
    sourceToCad = deviations(source, target, budget);
    cadToSource = deviations(target, source, budget);
  } catch (error) {
    reasons.push(
      error instanceof Error ? error.message : "CAD comparison unavailable",
    );
  }
  if (sourceReport.status !== "pass_for_scope")
    reasons.push(
      "Source study has not passed its independent observation acceptance policy",
    );
  if (study.policy.surfaceUncertaintyM == null)
    reasons.push(
      "Surface uncertainty is unknown; sparse held-out checks do not establish a bound for every scan vertex",
    );
  const registration =
    study.calibration.mode === "declared-units"
      ? 0
      : (study.policy.registrationUncertaintyM ?? null);
  if (registration === null)
    reasons.push("Registration uncertainty is unknown");
  if (
    sourceToCad?.method !== "point-to-triangle" ||
    cadToSource?.method !== "point-to-triangle"
  )
    reasons.push(
      "Both directions require triangle surfaces for acceptance; nearest-vertex results are diagnostics only",
    );
  const bound =
    study.policy.surfaceUncertaintyM == null || registration === null
      ? null
      : study.policy.surfaceUncertaintyM +
        registration +
        options.tessellationBoundM;
  const observedMaximum =
    sourceToCad && cadToSource
      ? Math.max(sourceToCad.maximumM, cadToSource.maximumM)
      : null;
  const conservativeMaximumM =
    observedMaximum === null || bound === null ? null : observedMaximum + bound;
  const tolerance = study.policy.toleranceM;
  const triangleComparison =
    sourceToCad?.method === "point-to-triangle" &&
    cadToSource?.method === "point-to-triangle";
  const clearFailure =
    triangleComparison &&
    observedMaximum !== null &&
    bound !== null &&
    Math.max(0, observedMaximum - bound) > tolerance;
  if (conservativeMaximumM !== null && conservativeMaximumM > tolerance)
    reasons.push(
      "Sampled surface deviation plus supplied uncertainty and tessellation allowance exceeds target tolerance",
    );
  const status: PrecisionStatus =
    sourceReport.status === "fail" || clearFailure
      ? "fail"
      : reasons.length
        ? "inconclusive"
        : "pass_for_scope";
  return {
    ...resultBase,
    status,
    sourceToCad,
    cadToSource,
    conservativeMaximumM,
    reasons,
  };
}
