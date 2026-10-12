import type { PrecisionVec3 } from "./types";
export const add3 = (a: PrecisionVec3, b: PrecisionVec3): PrecisionVec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub3 = (a: PrecisionVec3, b: PrecisionVec3): PrecisionVec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale3 = (a: PrecisionVec3, s: number): PrecisionVec3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];
export const dot3 = (a: PrecisionVec3, b: PrecisionVec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm3 = (a: PrecisionVec3): number => Math.hypot(...a);
export const distance3 = (a: PrecisionVec3, b: PrecisionVec3): number =>
  norm3(sub3(a, b));
export function mean3(points: readonly PrecisionVec3[]): PrecisionVec3 {
  if (!points.length) throw new Error("Cannot average empty points");
  // Center first to avoid summing large world coordinates unnecessarily.
  const anchor = points[0]!;
  return add3(
    anchor,
    scale3(
      points.reduce<PrecisionVec3>(
        (sum, p) => add3(sum, sub3(p, anchor)),
        [0, 0, 0],
      ),
      1 / points.length,
    ),
  );
}
export function multiply3(
  matrix: readonly PrecisionVec3[],
  p: PrecisionVec3,
): PrecisionVec3 {
  return [dot3(matrix[0]!, p), dot3(matrix[1]!, p), dot3(matrix[2]!, p)];
}
/** Bounded Jacobi eigensolver for small symmetric matrices, columns are eigenvectors. */
export function symmetricEigen(input: readonly (readonly number[])[]): {
  values: number[];
  vectors: number[][];
} {
  const n = input.length;
  if (
    n < 2 ||
    n > 4 ||
    input.some(
      (row) => row.length !== n || row.some((v) => !Number.isFinite(v)),
    )
  )
    throw new Error("Invalid symmetric matrix");
  const a = input.map((row) => [...row]);
  const vectors: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let step = 0; step < 128; step++) {
    let p = 0,
      q = 1,
      largest = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (Math.abs(a[i]![j]!) > largest) {
          largest = Math.abs(a[i]![j]!);
          p = i;
          q = j;
        }
    const magnitude = Math.max(
      ...a.map((row, i) => Math.abs(row[i]!)),
      Number.MIN_VALUE,
    );
    if (largest <= magnitude * 1e-14) break;
    const angle = 0.5 * Math.atan2(2 * a[p]![q]!, a[q]![q]! - a[p]![p]!);
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const app = a[p]![p]!,
      aqq = a[q]![q]!,
      apq = a[p]![q]!;
    a[p]![p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q]![q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p]![q] = 0;
    a[q]![p] = 0;
    for (let k = 0; k < n; k++) {
      if (k !== p && k !== q) {
        const kp = a[k]![p]!,
          kq = a[k]![q]!;
        a[k]![p] = a[p]![k] = c * kp - s * kq;
        a[k]![q] = a[q]![k] = s * kp + c * kq;
      }
      const vp = vectors[k]![p]!,
        vq = vectors[k]![q]!;
      vectors[k]![p] = c * vp - s * vq;
      vectors[k]![q] = s * vp + c * vq;
    }
  }
  return { values: a.map((row, i) => row[i]!), vectors };
}
export function assertNonCollinear(points: readonly PrecisionVec3[]): void {
  if (points.length < 3)
    throw new Error(
      "Registration requires at least three non-collinear controls",
    );
  const centre = mean3(points);
  const a = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const point of points) {
    const p = sub3(point, centre);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) a[i]![j]! += p[i]! * p[j]!;
  }
  const eigen = symmetricEigen(a).values.sort((a, b) => b - a);
  if (!(eigen[0]! > 1e-20) || eigen[1]! / eigen[0]! < 1e-8)
    throw new Error(
      "Registration controls are coincident, collinear, or ill-conditioned",
    );
}
