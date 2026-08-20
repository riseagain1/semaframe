import { describe, expect, it } from "vitest";
import {
  PARAMETRIC_GEOMETRY_LIMITS,
  PARAMETRIC_PRIMITIVE_JSON_SCHEMA,
  ParametricGeometryValidationError,
  deriveParametricBounds,
  deriveParametricCollider,
  deriveParametricVolumeM3,
  evaluateParametricGeometry,
  isParametricPrimitive,
  parametricGeometryDigest,
  parseParametricPrimitive,
  validateParametricPrimitive,
  type ParametricPrimitive,
} from "../../workspace/modeling/parametricGeometry";

const validPrimitives: readonly ParametricPrimitive[] = [
  { kind: "box", sizeM: { x: 2, y: 4, z: 6 } },
  { kind: "sphere", radiusM: 2 },
  { kind: "cylinder", radiusM: 2, heightM: 6, axis: "x" },
  { kind: "cone", radiusM: 3, heightM: 4, axis: "z" },
  { kind: "capsule", radiusM: 1, cylinderHeightM: 4, axis: "y" },
  { kind: "plane", sizeM: { x: 8, y: 6 }, normalAxis: "x" },
];

describe("parametric geometry validation", () => {
  it.each(validPrimitives)("accepts and canonicalizes $kind", (primitive) => {
    expect(validateParametricPrimitive(primitive)).toEqual([]);
    expect(isParametricPrimitive(primitive)).toBe(true);
    const parsed = parseParametricPrimitive(structuredClone(primitive));
    expect(parsed).toEqual(primitive);
    expect(Object.isFrozen(parsed)).toBe(true);
    if ("sizeM" in parsed) expect(Object.isFrozen(parsed.sizeM)).toBe(true);
  });

  it("publishes a closed six-shape command schema", () => {
    const variants = PARAMETRIC_PRIMITIVE_JSON_SCHEMA.oneOf as readonly unknown[];
    expect(variants).toHaveLength(6);
    expect(variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ additionalProperties: false }),
    ]));
  });

  it.each([
    ["null", null, "invalid_type"],
    ["array", [], "invalid_type"],
    ["missing kind", { radiusM: 1 }, "missing_property"],
    ["unknown kind", { kind: "torus", radiusM: 1 }, "invalid_value"],
    ["missing field", { kind: "box" }, "missing_property"],
    ["extra field", { kind: "sphere", radiusM: 1, segments: 64 }, "unknown_property"],
    ["zero dimension", { kind: "box", sizeM: { x: 1, y: 0, z: 1 } }, "out_of_range"],
    ["negative dimension", { kind: "plane", sizeM: { x: -1, y: 1 }, normalAxis: "y" }, "out_of_range"],
    ["NaN", { kind: "sphere", radiusM: Number.NaN }, "non_finite"],
    ["infinity", { kind: "cylinder", radiusM: 1, heightM: Infinity, axis: "y" }, "non_finite"],
    ["oversized radius", { kind: "sphere", radiusM: 500.000001 }, "out_of_range"],
    ["bad axis", { kind: "cone", radiusM: 1, heightM: 1, axis: "w" }, "invalid_value"],
    [
      "oversized capsule total extent",
      { kind: "capsule", radiusM: 100, cylinderHeightM: 900, axis: "z" },
      "extent_exceeded",
    ],
    [
      "extra vector coordinate",
      { kind: "box", sizeM: { x: 1, y: 1, z: 1, w: 1 } },
      "unknown_property",
    ],
  ] as const)("rejects %s", (_label, candidate, expectedCode) => {
    const issues = validateParametricPrimitive(candidate);
    expect(issues.some((entry) => entry.code === expectedCode)).toBe(true);
    expect(isParametricPrimitive(candidate)).toBe(false);
    expect(() => parseParametricPrimitive(candidate)).toThrow(ParametricGeometryValidationError);
  });

  it("accepts exact lower and upper boundaries", () => {
    const { minimumDimensionM, maximumExtentM, maximumRadiusM } = PARAMETRIC_GEOMETRY_LIMITS;
    expect(isParametricPrimitive({
      kind: "box",
      sizeM: { x: minimumDimensionM, y: maximumExtentM, z: 1 },
    })).toBe(true);
    expect(isParametricPrimitive({ kind: "sphere", radiusM: maximumRadiusM })).toBe(true);
    expect(isParametricPrimitive({
      kind: "capsule",
      radiusM: maximumRadiusM / 2,
      cylinderHeightM: maximumExtentM / 2,
      axis: "y",
    })).toBe(true);
  });
});

describe("parametric geometry analytical derivation", () => {
  it("derives exact box bounds, volume, and collider from one descriptor", () => {
    const primitive = validPrimitives[0]!;
    expect(deriveParametricBounds(primitive)).toEqual({
      min: { x: -1, y: -2, z: -3 },
      max: { x: 1, y: 2, z: 3 },
      center: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 4, z: 6 },
    });
    expect(deriveParametricVolumeM3(primitive)).toBe(48);
    expect(deriveParametricCollider(primitive)).toEqual({
      shape: "box",
      centerM: { x: 0, y: 0, z: 0 },
      sizeM: { x: 2, y: 4, z: 6 },
    });
  });

  it("derives exact curved primitive volumes", () => {
    expect(deriveParametricVolumeM3(validPrimitives[1])).toBeCloseTo((32 / 3) * Math.PI, 12);
    expect(deriveParametricVolumeM3(validPrimitives[2])).toBeCloseTo(24 * Math.PI, 12);
    expect(deriveParametricVolumeM3(validPrimitives[3])).toBeCloseTo(12 * Math.PI, 12);
    expect(deriveParametricVolumeM3(validPrimitives[4])).toBeCloseTo((16 / 3) * Math.PI, 12);
    expect(deriveParametricVolumeM3(validPrimitives[5])).toBe(0);
  });

  it.each([
    ["x", { x: 6, y: 4, z: 4 }],
    ["y", { x: 4, y: 6, z: 4 }],
    ["z", { x: 4, y: 4, z: 6 }],
  ] as const)("maps a cylinder's %s axis deterministically", (axis, expectedSize) => {
    expect(deriveParametricBounds({
      kind: "cylinder",
      radiusM: 2,
      heightM: 6,
      axis,
    }).size).toEqual(expectedSize);
  });

  it.each([
    ["x", { x: 6, y: 2, z: 2 }],
    ["y", { x: 2, y: 6, z: 2 }],
    ["z", { x: 2, y: 2, z: 6 }],
  ] as const)("includes both hemispherical caps along %s", (axis, expectedSize) => {
    expect(deriveParametricBounds({
      kind: "capsule",
      radiusM: 1,
      cylinderHeightM: 4,
      axis,
    }).size).toEqual(expectedSize);
  });

  it.each([
    ["x", { x: 0, y: 8, z: 6 }],
    ["y", { x: 8, y: 0, z: 6 }],
    ["z", { x: 8, y: 6, z: 0 }],
  ] as const)("maps plane dimensions around the %s normal", (normalAxis, expectedSize) => {
    const plane = { kind: "plane", sizeM: { x: 8, y: 6 }, normalAxis } as const;
    expect(deriveParametricBounds(plane).size).toEqual(expectedSize);
    expect(deriveParametricCollider(plane)).toMatchObject({
      shape: "plane",
      normalAxis,
      twoSided: true,
    });
  });

  it("returns every authoritative projection in one immutable evaluation", () => {
    const result = evaluateParametricGeometry(validPrimitives[4]);
    expect(result).toMatchObject({
      primitive: validPrimitives[4],
      bounds: { size: { x: 2, y: 6, z: 2 } },
      collider: { shape: "capsule", axis: "y" },
    });
    expect(result.volumeM3).toBeCloseTo((16 / 3) * Math.PI, 12);
    expect(result.digest).toBe(parametricGeometryDigest(validPrimitives[4]));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bounds)).toBe(true);
  });
});

describe("parametric geometry digest", () => {
  it("is deterministic across object insertion order and input mutation", () => {
    const first = { kind: "box" as const, sizeM: { x: 2, y: 4, z: 6 } };
    const reordered = {
      sizeM: { z: 6, x: 2, y: 4 },
      kind: "box",
    } as unknown as ParametricPrimitive;
    const canonical = parseParametricPrimitive(first);
    const before = parametricGeometryDigest(first);
    expect(parametricGeometryDigest(reordered)).toBe(before);
    expect(parametricGeometryDigest(canonical)).toBe(before);

    first.sizeM.x = 3;
    expect(canonical).toEqual({ kind: "box", sizeM: { x: 2, y: 4, z: 6 } });
    expect(parametricGeometryDigest(first)).not.toBe(before);
  });

  it("pins the versioned canonical digest", () => {
    expect(parametricGeometryDigest({
      kind: "box",
      sizeM: { x: 2, y: 4, z: 6 },
    })).toBe("geometry-v1:fnv1a32:b5cc35fb");
  });
});
