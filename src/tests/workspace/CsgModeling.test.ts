import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  CSG_DEFINITION_JSON_SCHEMA,
  CsgDefinitionValidationError,
  csgDefinitionDigest,
  isCsgDefinition,
  parseCsgDefinition,
  validateCsgDefinition,
  type CsgDefinition,
  type CsgNode,
} from "../../workspace/modeling/csgTypes";
import {
  CSG_ENGINE,
  CsgEvaluationError,
  evaluateCsg,
} from "../../workspace/modeling/csgEvaluator";
import {
  exportCsgMeshToBinaryStl,
  exportCsgMeshToObj,
} from "../../workspace/modeling/csgExport";
import { evaluateCsgWorkerRequest } from "../../workspace/modeling/csgWorker";

function box(
  x: number,
  y: number,
  z: number,
  tx = 0,
  ty = 0,
  tz = 0,
): CsgNode {
  return {
    kind: "primitive",
    primitive: { kind: "box", sizeM: { x, y, z } },
    ...(tx === 0 && ty === 0 && tz === 0 ? {} : {
      transform: { translationM: { x: tx, y: ty, z: tz } },
    }),
  };
}

const tunnelDefinition: CsgDefinition = {
  version: 1,
  root: {
    kind: "subtract",
    left: box(4, 4, 4),
    right: box(2, 2, 6),
  },
};

describe("bounded CSG definition", () => {
  it("publishes a closed recursive schema and canonical immutable value", () => {
    expect(CSG_DEFINITION_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["version", "root"],
    });
    const parsed = parseCsgDefinition(structuredClone(tunnelDefinition));
    expect(parsed).toEqual(tunnelDefinition);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.root)).toBe(true);
    expect(isCsgDefinition(parsed)).toBe(true);
    const validate = new Ajv2020({ allErrors: true, strict: true, strictNumbers: true })
      .compile(CSG_DEFINITION_JSON_SCHEMA);
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["plane leaf", {
      version: 1,
      root: {
        kind: "primitive",
        primitive: { kind: "plane", sizeM: { x: 1, y: 1 }, normalAxis: "z" },
      },
    }, "non_solid"],
    ["unknown property", {
      version: 1,
      root: { ...box(1, 1, 1), script: "network()" },
    }, "unknown_property"],
    ["non-unit quaternion", {
      version: 1,
      root: {
        ...box(1, 1, 1),
        transform: { rotationQuaternion: { x: 0, y: 0, z: 0, w: 2 } },
      },
    }, "out_of_range"],
    ["non-finite transform", {
      version: 1,
      root: {
        ...box(1, 1, 1),
        transform: { translationM: { x: Number.NaN, y: 0, z: 0 } },
      },
    }, "non_finite"],
    ["zero scale", {
      version: 1,
      root: {
        ...box(1, 1, 1),
        transform: { scale: { x: 0, y: 1, z: 1 } },
      },
    }, "out_of_range"],
  ] as const)("rejects %s", (_label, value, code) => {
    const issues = validateCsgDefinition(value);
    expect(issues.some((entry) => entry.code === code)).toBe(true);
    expect(() => parseCsgDefinition(value)).toThrow(CsgDefinitionValidationError);
  });

  it("rejects cyclic JS values and excessive tree depth without recursion hazards", () => {
    const cyclic: Record<string, unknown> = { kind: "union" };
    cyclic.left = box(1, 1, 1);
    cyclic.right = cyclic;
    const cyclicIssues = validateCsgDefinition({ version: 1, root: cyclic });
    expect(cyclicIssues).toContainEqual(expect.objectContaining({ code: "cyclic_value" }));

    let root: CsgNode = box(1, 1, 1);
    for (let index = 0; index < 13; index += 1) {
      root = { kind: "union", left: root, right: box(1, 1, 1, index + 2) };
    }
    expect(validateCsgDefinition({ version: 1, root })).toContainEqual(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
  });

  it("canonicalizes identity transforms and quaternion sign for stable digests", () => {
    const plain = { version: 1, root: box(1, 2, 3) };
    const identity = {
      version: 1,
      root: {
        ...box(1, 2, 3),
        transform: {
          translationM: { x: -0, y: 0, z: 0 },
          rotationQuaternion: { x: 0, y: 0, z: 0, w: -1 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
    };
    expect(parseCsgDefinition(identity)).toEqual(plain);
    expect(csgDefinitionDigest(identity)).toBe(csgDefinitionDigest(plain));
    expect(csgDefinitionDigest(tunnelDefinition)).toBe(
      "csg-definition-v1:fnv1a32:49df25cb",
    );
  });
});

describe("real Manifold WASM CSG evaluation", () => {
  it("subtracts an exact through-hole and reports production diagnostics", async () => {
    const progress: string[] = [];
    const result = await evaluateCsg(tunnelDefinition, {
      onProgress: ({ phase }) => progress.push(phase),
    });
    expect(result.volumeM3).toBeCloseTo(48, 12);
    expect(result.bounds).toEqual({
      min: { x: -2, y: -2, z: -2 },
      max: { x: 2, y: 2, z: 2 },
      center: { x: 0, y: 0, z: 0 },
      size: { x: 4, y: 4, z: 4 },
    });
    expect(result.diagnostics).toMatchObject({
      engine: CSG_ENGINE,
      status: "NoError",
      manifold: true,
      watertight: true,
      empty: false,
      genus: 1,
      surfaceAreaM2: 120,
    });
    expect(result.mesh.vertexCount).toBe(16);
    expect(result.mesh.triangleCount).toBe(32);
    expect(result.mesh.positions).toBeInstanceOf(Float32Array);
    expect(result.mesh.indices).toBeInstanceOf(Uint32Array);
    expect(progress.at(-1)).toBe("complete");
  });

  it("evaluates union/intersection, axis mapping, transforms, and valid empty solids", async () => {
    const union = await evaluateCsg({
      version: 1,
      root: { kind: "union", left: box(2, 2, 2, -0.5), right: box(2, 2, 2, 0.5) },
    });
    expect(union.volumeM3).toBeCloseTo(12, 12);
    expect(union.bounds?.size).toEqual({ x: 3, y: 2, z: 2 });

    const rotatedCylinder = await evaluateCsg({
      version: 1,
      root: {
        kind: "primitive",
        primitive: { kind: "cylinder", radiusM: 1, heightM: 4, axis: "x" },
        transform: {
          rotationQuaternion: {
            x: 0,
            y: 0,
            z: Math.SQRT1_2,
            w: Math.SQRT1_2,
          },
        },
      },
    });
    expect(rotatedCylinder.bounds?.size.x).toBeCloseTo(2, 6);
    expect(rotatedCylinder.bounds?.size.y).toBeCloseTo(4, 6);
    expect(rotatedCylinder.bounds?.size.z).toBeCloseTo(2, 6);

    const empty = await evaluateCsg({
      version: 1,
      root: { kind: "intersect", left: box(1, 1, 1), right: box(1, 1, 1, 10) },
    });
    expect(empty.bounds).toBeNull();
    expect(empty.volumeM3).toBe(0);
    expect(empty.mesh.vertexCount).toBe(0);
    expect(empty.diagnostics).toMatchObject({ empty: true, watertight: true, genus: null });
  });

  it("evaluates curved capsule leaves through the same bounded engine", async () => {
    const result = await evaluateCsg({
      version: 1,
      root: {
        kind: "primitive",
        primitive: { kind: "capsule", radiusM: 1, cylinderHeightM: 4, axis: "y" },
      },
    }, { circularSegments: 24 });
    expect(result.bounds?.size.x).toBeCloseTo(2, 6);
    expect(result.bounds?.size.y).toBeCloseTo(6, 6);
    expect(result.bounds?.size.z).toBeCloseTo(2, 6);
    expect(result.volumeM3).toBeGreaterThan(16);
    expect(result.volumeM3).toBeLessThan(17);
    expect(result.diagnostics.watertight).toBe(true);
  });

  it("is deterministic for a pinned engine/options contract", async () => {
    const first = await evaluateCsg(tunnelDefinition, { circularSegments: 24 });
    const second = await evaluateCsg(structuredClone(tunnelDefinition), { circularSegments: 24 });
    expect(second.definitionDigest).toBe(first.definitionDigest);
    expect(second.resultDigest).toBe(first.resultDigest);
    expect(first.resultDigest).toBe("csg-result-v1:fnv1a32:20790aee");
    expect(second.mesh.positions).toEqual(first.mesh.positions);
    expect(second.mesh.indices).toEqual(first.mesh.indices);
  });

  it("enforces mesh caps and cooperative cancellation", async () => {
    await expect(evaluateCsg(tunnelDefinition, { maxVertices: 1 })).rejects.toMatchObject({
      code: "mesh_limit_exceeded",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(evaluateCsg(tunnelDefinition, { signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => error instanceof CsgEvaluationError
        && error.code === "aborted"
        && error.name === "AbortError",
    );

    let level: CsgNode[] = Array.from(
      { length: 16 },
      (_, index) => box(1, 1, 1, index * 0.25),
    );
    while (level.length > 1) {
      const next: CsgNode[] = [];
      for (let index = 0; index < level.length; index += 2) {
        next.push({ kind: "union", left: level[index]!, right: level[index + 1]! });
      }
      level = next;
    }
    const broadTree = level[0]!;
    const inFlightController = new AbortController();
    const inFlight = evaluateCsg(
      { version: 1, root: broadTree },
      { signal: inFlightController.signal },
    );
    setTimeout(() => inFlightController.abort(), 0);
    await expect(inFlight).rejects.toMatchObject({ code: "aborted", name: "AbortError" });
  });
});

describe("CSG render/export and worker integration seams", () => {
  it("exports valid deterministic OBJ and binary STL from the indexed mesh", async () => {
    const result = await evaluateCsg(tunnelDefinition);
    const obj = exportCsgMeshToObj(result.mesh, { name: "Tunnel part" });
    expect(obj).toContain("o Tunnel_part\n");
    expect(obj.match(/^v /gm)).toHaveLength(result.mesh.vertexCount);
    expect(obj.match(/^f /gm)).toHaveLength(result.mesh.triangleCount);

    const stl = exportCsgMeshToBinaryStl(result.mesh, { name: "Tunnel part" });
    expect(stl.byteLength).toBe(84 + result.mesh.triangleCount * 50);
    const stlView = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    expect(stlView.getUint32(80, true)).toBe(result.mesh.triangleCount);
    expect(new TextDecoder().decode(stl.subarray(0, 80)).replace(/\0+$/u, ""))
      .toContain("SemaFrame CSG millimetres");
    const firstVertexIndex = result.mesh.indices[0]! * 3;
    expect(stlView.getFloat32(96, true)).toBeCloseTo(
      result.mesh.positions[firstVertexIndex]! * 1_000,
      4,
    );
    expect(stlView.getFloat32(100, true)).toBeCloseTo(
      result.mesh.positions[firstVertexIndex + 1]! * 1_000,
      4,
    );
    expect(stlView.getFloat32(104, true)).toBeCloseTo(
      result.mesh.positions[firstVertexIndex + 2]! * 1_000,
      4,
    );
    expect(exportCsgMeshToBinaryStl(result.mesh, { name: "Tunnel part" })).toEqual(stl);
  });

  it("returns transferable typed arrays through the worker request contract", async () => {
    const response = await evaluateCsgWorkerRequest({
      type: "csg/evaluate",
      requestId: "test:worker-1",
      definition: tunnelDefinition,
      options: { circularSegments: 16 },
    });
    expect(response).toMatchObject({ type: "csg/result", requestId: "test:worker-1" });
    expect(response.result.mesh.positions.buffer).toBeInstanceOf(ArrayBuffer);
    expect(response.result.mesh.indices.buffer).toBeInstanceOf(ArrayBuffer);
    await expect(evaluateCsgWorkerRequest({
      type: "csg/evaluate",
      requestId: "test:worker-2",
      definition: tunnelDefinition,
      options: { circularSegments: 16, arbitraryCode: "eval()" },
    } as never)).rejects.toMatchObject({ code: "invalid_options" });
  });
});
