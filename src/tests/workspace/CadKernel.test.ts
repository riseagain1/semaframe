// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAD_KERNEL_LIMITS,
  CadKernelError,
  loadCadKernel,
  type CadKernel,
  type CadShapeHandle,
} from "../../workspace/modeling/cadKernel";

let kernel: CadKernel;

async function releaseAll(handles: readonly CadShapeHandle[]): Promise<void> {
  for (const handle of handles) await kernel.release(handle);
}

async function expectCadError(
  promise: Promise<unknown>,
  code: CadKernelError["code"],
): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CadKernelError);
  expect((error as CadKernelError).code).toBe(code);
}

beforeAll(async () => {
  kernel = await loadCadKernel();
}, 30_000);

afterAll(async () => {
  await kernel.dispose();
});

describe("real OpenCascade browser CAD kernel", () => {
  it("constructs SI primitives with exact dimensional and mass properties", async () => {
    const box = await kernel.createBox({ sizeM: { x: 2, y: 4, z: 6 } });
    const cylinder = await kernel.createCylinder({ radiusM: 1, heightM: 2, axis: "x" });
    const sphere = await kernel.createSphere({ radiusM: 1 });

    expect(await kernel.validate(box)).toEqual({ valid: true, isNull: false });
    expect(await kernel.validate(cylinder)).toEqual({ valid: true, isNull: false });
    expect(await kernel.validate(sphere)).toEqual({ valid: true, isNull: false });

    const boxMass = await kernel.measure(box, 7_800);
    expect(boxMass.volumeM3).toBeCloseTo(48, 10);
    expect(boxMass.surfaceAreaM2).toBeCloseTo(88, 8);
    expect(boxMass.massKg).toBeCloseTo(374_400, 6);
    expect(boxMass.bounds.size.x).toBeCloseTo(2, 5);
    expect(boxMass.bounds.size.y).toBeCloseTo(4, 5);
    expect(boxMass.bounds.size.z).toBeCloseTo(6, 5);

    const cylinderMass = await kernel.measure(cylinder);
    expect(cylinderMass.volumeM3).toBeCloseTo(2 * Math.PI, 8);
    expect(cylinderMass.bounds.size.x).toBeCloseTo(2, 5);
    expect(cylinderMass.bounds.size.y).toBeCloseTo(2, 5);
    expect(cylinderMass.bounds.size.z).toBeCloseTo(2, 5);

    const sphereMass = await kernel.measure(sphere);
    expect(sphereMass.volumeM3).toBeCloseTo(4 * Math.PI / 3, 8);
    expect(sphereMass.bounds.size.x).toBeCloseTo(2, 5);

    await releaseAll([box, cylinder, sphere]);
  });

  it("applies bounded scale/axis-angle/translation transforms in documented order", async () => {
    const source = await kernel.createBox({ sizeM: { x: 2, y: 4, z: 6 } });
    const transformed = await kernel.transform(source, {
      uniformScale: 0.5,
      rotation: { axis: { x: 0, y: 0, z: 1 }, angleRad: Math.PI / 2 },
      translationM: { x: 10, y: -2, z: 3 },
    });

    const measured = await kernel.measure(transformed);
    expect(measured.volumeM3).toBeCloseTo(6, 8);
    expect(measured.bounds.size.x).toBeCloseTo(2, 5);
    expect(measured.bounds.size.y).toBeCloseTo(1, 5);
    expect(measured.bounds.size.z).toBeCloseTo(3, 5);
    expect(measured.bounds.center.x).toBeCloseTo(10, 5);
    expect(measured.bounds.center.y).toBeCloseTo(-2, 5);
    expect(measured.bounds.center.z).toBeCloseTo(3, 5);

    // The source remains immutable and reusable.
    expect((await kernel.measure(source)).volumeM3).toBeCloseTo(48, 8);
    await releaseAll([source, transformed]);
  });

  it("performs valid B-rep union, cut, and intersection", async () => {
    const left = await kernel.createBox({ sizeM: { x: 2, y: 2, z: 2 } });
    const rightSource = await kernel.createBox({ sizeM: { x: 2, y: 2, z: 2 } });
    const right = await kernel.transform(rightSource, {
      translationM: { x: 1, y: 0, z: 0 },
    });
    const union = await kernel.boolean("union", left, right);
    const cut = await kernel.boolean("cut", left, right);
    const intersection = await kernel.boolean("intersect", left, right);

    expect((await kernel.measure(union)).volumeM3).toBeCloseTo(12, 7);
    expect((await kernel.measure(cut)).volumeM3).toBeCloseTo(4, 7);
    expect((await kernel.measure(intersection)).volumeM3).toBeCloseTo(4, 7);
    expect(await kernel.validate(union)).toEqual({ valid: true, isNull: false });
    expect(await kernel.validate(cut)).toEqual({ valid: true, isNull: false });
    expect(await kernel.validate(intersection)).toEqual({ valid: true, isNull: false });

    await releaseAll([left, rightSource, right, union, cut, intersection]);
  });

  it("emits a bounded indexed mesh with finite positions, normals, and indices", async () => {
    const sphere = await kernel.createSphere({ radiusM: 1 });
    const mesh = await kernel.tessellate(sphere, {
      linearDeflectionM: 0.01,
      angularDeflectionRad: 0.2,
    });

    expect(mesh.positions).toBeInstanceOf(Float32Array);
    expect(mesh.normals).toBeInstanceOf(Float32Array);
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    expect(mesh.positions.length).toBeGreaterThan(300);
    expect(mesh.positions.length % 3).toBe(0);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.indices.length / 3).toBeLessThan(CAD_KERNEL_LIMITS.maximumMeshTriangles);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
    expect([...mesh.positions, ...mesh.normals].every(Number.isFinite)).toBe(true);
    expect(mesh.bounds.size.x).toBeCloseTo(2, 5);

    await kernel.release(sphere);
  });

  it("exports metre-authored, parseable STEP Part 21 output", async () => {
    const box = await kernel.createBox({ sizeM: { x: 2, y: 4, z: 6 } });
    const step = await kernel.exportStep(box, "Dimensional test block");

    expect(step.format).toBe("step");
    expect(step.units).toBe("metre");
    expect(step.byteLength).toBeGreaterThan(1_000);
    expect(step.byteLength).toBeLessThan(CAD_KERNEL_LIMITS.maximumStepBytes);
    expect(step.text).toContain("ISO-10303-21;");
    expect(step.text).toContain("FILE_SCHEMA((");
    expect(step.text).toContain("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING");
    expect(step.text).toMatch(/SI_UNIT\(\$,.METRE\.\)/u);
    expect(step.text.trimEnd()).toMatch(/END-ISO-10303-21;$/u);

    // Parse the emitted artifact with the same real OCCT STEP reader and
    // verify its metre dimensions survived a complete export/import cycle.
    const replicad = await import("replicad");
    const imported = await replicad.importSTEP(new Blob(
      [step.text],
      { type: "application/step" },
    ));
    try {
      expect(replicad.isShape3D(imported)).toBe(true);
      if (!replicad.isShape3D(imported)) throw new Error("STEP did not contain a 3D shape");
      expect(replicad.measureVolume(imported)).toBeCloseTo(48, 7);
      expect(imported.boundingBox.width).toBeCloseTo(2, 5);
      expect(imported.boundingBox.height).toBeCloseTo(4, 5);
      expect(imported.boundingBox.depth).toBeCloseTo(6, 5);
    } finally {
      imported.delete();
    }

    await kernel.release(box);
  });

  it("rejects invalid, oversized, over-precise, stale, and aborted work", async () => {
    await expectCadError(
      kernel.createBox({ sizeM: { x: 0, y: 1, z: 1 } }),
      "invalid_input",
    );
    await expectCadError(
      kernel.createSphere({ radiusM: 501 }),
      "limit_exceeded",
    );
    await expectCadError(
      kernel.validate({ id: "cad:not-from-this-kernel" }),
      "invalid_handle",
    );

    const box = await kernel.createBox({ sizeM: { x: 2, y: 2, z: 2 } });
    await expectCadError(
      kernel.tessellate(box, { linearDeflectionM: 1e-7 }),
      "limit_exceeded",
    );
    await expectCadError(
      kernel.transform(box, {
        translationM: {
          x: CAD_KERNEL_LIMITS.maximumCoordinateMagnitudeM + 1,
          y: 0,
          z: 0,
        },
      }),
      "limit_exceeded",
    );
    await expectCadError(
      kernel.measure(box, 1, { budgetMs: 0 }),
      "limit_exceeded",
    );

    const controller = new AbortController();
    controller.abort();
    await expectCadError(
      kernel.createBox(
        { sizeM: { x: 1, y: 1, z: 1 } },
        { signal: controller.signal },
      ),
      "aborted",
    );

    await kernel.release(box);
    await expectCadError(kernel.validate(box), "invalid_handle");

    const queued = await kernel.createBox({ sizeM: { x: 1, y: 1, z: 1 } });
    const release = kernel.release(queued);
    const operationAfterRelease = expectCadError(kernel.measure(queued), "invalid_handle");
    await Promise.all([release, operationAfterRelease]);
  });
});
