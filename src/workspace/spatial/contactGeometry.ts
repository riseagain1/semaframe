import type { Vec3 } from "../components/componentTypes";
import type { SpatialResolvedCollisionPart, UniversalSpaceDataNode } from "./spatialTypes";

export type SpatialPoint2 = Readonly<{ x: number; z: number }>;

export type SpatialContactPatch = Readonly<{
  points: readonly SpatialPoint2[];
  areaM2: number;
  height: number;
}>;

const EPSILON = 1e-8;
const FACE_TOLERANCE = 1e-6;

function add(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function scale(value: Vec3, amount: number): Vec3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function cross(origin: SpatialPoint2, left: SpatialPoint2, right: SpatialPoint2): number {
  return (left.x - origin.x) * (right.z - origin.z)
    - (left.z - origin.z) * (right.x - origin.x);
}

export function convexHull2(points: readonly SpatialPoint2[]): SpatialPoint2[] {
  const unique = [...new Map(points.map((point) => [`${point.x}:${point.z}`, point])).values()]
    .sort((left, right) => left.x - right.x || left.z - right.z);
  if (unique.length <= 2) return unique;
  const lower: SpatialPoint2[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= EPSILON) lower.pop();
    lower.push(point);
  }
  const upper: SpatialPoint2[] = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= EPSILON) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export function polygonArea2(points: readonly SpatialPoint2[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.z - next.x * current.z;
  }
  return Math.abs(twiceArea) / 2;
}

function lineIntersection(
  start: SpatialPoint2,
  end: SpatialPoint2,
  clipStart: SpatialPoint2,
  clipEnd: SpatialPoint2,
): SpatialPoint2 {
  const segment = { x: end.x - start.x, z: end.z - start.z };
  const clip = { x: clipEnd.x - clipStart.x, z: clipEnd.z - clipStart.z };
  const denominator = segment.x * clip.z - segment.z * clip.x;
  if (Math.abs(denominator) <= EPSILON) return end;
  const offset = { x: clipStart.x - start.x, z: clipStart.z - start.z };
  const amount = (offset.x * clip.z - offset.z * clip.x) / denominator;
  return { x: start.x + segment.x * amount, z: start.z + segment.z * amount };
}

/** Intersects two convex, counter-clockwise polygons. */
export function intersectConvexPolygons(
  subject: readonly SpatialPoint2[],
  clip: readonly SpatialPoint2[],
): SpatialPoint2[] {
  if (subject.length < 3 || clip.length < 3) return [];
  let output = [...subject];
  for (let edge = 0; edge < clip.length && output.length; edge += 1) {
    const clipStart = clip[edge]!;
    const clipEnd = clip[(edge + 1) % clip.length]!;
    const input = output;
    output = [];
    let start = input.at(-1)!;
    for (const end of input) {
      const endInside = cross(clipStart, clipEnd, end) >= -EPSILON;
      const startInside = cross(clipStart, clipEnd, start) >= -EPSILON;
      if (endInside) {
        if (!startInside) output.push(lineIntersection(start, end, clipStart, clipEnd));
        output.push(end);
      } else if (startInside) {
        output.push(lineIntersection(start, end, clipStart, clipEnd));
      }
      start = end;
    }
  }
  const hull = convexHull2(output);
  return polygonArea2(hull) > EPSILON ? hull : [];
}

export function collisionPartVertices(part: SpatialResolvedCollisionPart): Vec3[] {
  const vertices: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    vertices.push(add(part.center, add(
      add(scale(part.axes[0], x * part.halfExtents.x), scale(part.axes[1], y * part.halfExtents.y)),
      scale(part.axes[2], z * part.halfExtents.z),
    )));
  }
  return vertices;
}

export function projectedPartFootprint(part: SpatialResolvedCollisionPart): SpatialPoint2[] {
  return convexHull2(collisionPartVertices(part).map((point) => ({ x: point.x, z: point.z })));
}

/**
 * Returns an actual horizontal extreme face. A tilted box normally produces
 * only an extreme edge or vertex and therefore deliberately returns no area.
 */
export function horizontalExtremeFace(
  part: SpatialResolvedCollisionPart,
  side: "bottom" | "top",
): SpatialPoint2[] {
  const vertices = collisionPartVertices(part);
  const extreme = side === "bottom"
    ? Math.min(...vertices.map((point) => point.y))
    : Math.max(...vertices.map((point) => point.y));
  const points = vertices
    .filter((point) => Math.abs(point.y - extreme) <= FACE_TOLERANCE)
    .map((point) => ({ x: point.x, z: point.z }));
  const hull = convexHull2(points);
  return polygonArea2(hull) > EPSILON ? hull : [];
}

export function supportContactPatches(
  upper: UniversalSpaceDataNode,
  lower: UniversalSpaceDataNode,
  toleranceM: number,
): SpatialContactPatch[] {
  if (!upper.collision || !lower.collision) return [];
  const patches: SpatialContactPatch[] = [];
  for (const upperPart of upper.collision.parts) for (const lowerPart of lower.collision.parts) {
    const gap = upperPart.aabb.min.y - lowerPart.aabb.max.y;
    if (Math.abs(gap) > toleranceM) continue;
    const intersection = intersectConvexPolygons(
      horizontalExtremeFace(upperPart, "bottom"),
      horizontalExtremeFace(lowerPart, "top"),
    );
    const areaM2 = polygonArea2(intersection);
    if (areaM2 <= EPSILON) continue;
    patches.push({ points: intersection, areaM2, height: lowerPart.aabb.max.y });
  }
  return patches;
}

export function groundContactPatches(
  node: UniversalSpaceDataNode,
  groundPolygon: readonly SpatialPoint2[],
  groundHeight: number,
  toleranceM: number,
): SpatialContactPatch[] {
  if (!node.collision) return [];
  const patches: SpatialContactPatch[] = [];
  for (const part of node.collision.parts) {
    if (Math.abs(part.aabb.min.y - groundHeight) > toleranceM) continue;
    const intersection = intersectConvexPolygons(horizontalExtremeFace(part, "bottom"), groundPolygon);
    const areaM2 = polygonArea2(intersection);
    if (areaM2 <= EPSILON) continue;
    patches.push({ points: intersection, areaM2, height: groundHeight });
  }
  return patches;
}

export function partIntersectsGroundVolume(
  part: SpatialResolvedCollisionPart,
  groundPolygon: readonly SpatialPoint2[],
  groundHeight: number,
  toleranceM: number,
): boolean {
  if (part.aabb.min.y >= groundHeight - toleranceM) return false;
  return polygonArea2(intersectConvexPolygons(projectedPartFootprint(part), groundPolygon)) > EPSILON;
}

/** Horizontal overlap used by the vertical-drop preview before faces touch. */
export function projectedSupportOverlap(
  upper: UniversalSpaceDataNode,
  lower: UniversalSpaceDataNode,
): boolean {
  return verticalSupportGaps(upper, lower).length > 0;
}

/** Candidate vertical gaps whose horizontal extreme faces overlap. */
export function verticalSupportGaps(
  upper: UniversalSpaceDataNode,
  lower: UniversalSpaceDataNode,
): number[] {
  if (!upper.collision || !lower.collision) return [];
  const gaps: number[] = [];
  for (const upperPart of upper.collision.parts) {
    const upperFace = horizontalExtremeFace(upperPart, "bottom");
    for (const lowerPart of lower.collision.parts) {
      if (polygonArea2(intersectConvexPolygons(upperFace, horizontalExtremeFace(lowerPart, "top"))) <= EPSILON) {
        continue;
      }
      gaps.push(upperPart.aabb.min.y - lowerPart.aabb.max.y);
    }
  }
  return gaps.sort((left, right) => left - right);
}
