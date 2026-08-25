import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  ObjToGaussianPlyError,
  objToGaussianPly,
} from "../../../server/reconstruction/objToGaussianPly";
import { inspectRealityAsset } from "../../workspace/assets";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "semaframe-obj-gaussian-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function texturedSquare(root: string): Promise<{ assetRoot: string; objPath: string }> {
  const assetRoot = join(root, "capture");
  await mkdir(assetRoot);
  await sharp(Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]), { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(join(assetRoot, "albedo.png"));
  await writeFile(join(assetRoot, "model.mtl"), [
    "newmtl capture",
    "Kd 0.25 0.5 0.75",
    "map_Kd albedo.png",
    "",
  ].join("\n"));
  const objPath = join(assetRoot, "model.obj");
  await writeFile(objPath, [
    "mtllib model.mtl",
    "v 0 0 0",
    "v 1 0 0",
    "v 1 1 0",
    "v 0 1 0",
    "vt 0 0",
    "vt 1 0",
    "vt 1 1",
    "vt 0 1",
    "usemtl capture",
    "f 1/1 2/2 3/3 4/4",
    "",
  ].join("\n"));
  return { assetRoot, objPath };
}

describe("objToGaussianPly", () => {
  it("deterministically samples OBJ/MTL/texture data into an accepted binary Gaussian PLY", async () => {
    const root = await temporaryDirectory();
    const source = await texturedSquare(root);
    const firstPath = join(source.assetRoot, "first.ply");
    const secondPath = join(source.assetRoot, "second.ply");

    const first = await objToGaussianPly({
      ...source,
      outputPath: firstPath,
      targetSplatCount: 64,
    });
    const second = await objToGaussianPly({
      ...source,
      outputPath: secondPath,
      targetSplatCount: 64,
    });

    expect(first).toMatchObject({
      splatCount: 64,
      sourceTriangleCount: 2,
      textureCount: 1,
      units: "unknown",
      axes: "unknown",
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    });
    const firstBytes = await readFile(firstPath);
    const secondBytes = await readFile(secondPath);
    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(first.byteLength).toBe(firstBytes.byteLength);

    const candidate = await inspectRealityAsset(new Blob([new Uint8Array(firstBytes)]));
    expect(candidate.descriptor).toMatchObject({
      format: "ply",
      splatCount: 64,
      sphericalHarmonicsDegree: 0,
      model: "gaussian-3d",
      engineeringAuthority: "visual_only",
      sourceBounds: {
        min: { x: expect.any(Number), y: expect.any(Number), z: 0 },
        max: { x: expect.any(Number), y: expect.any(Number), z: 0 },
      },
    });
  });

  it("hard-bounds the emitted splat count and file bytes", async () => {
    const root = await temporaryDirectory();
    const source = await texturedSquare(root);
    const outputPath = join(source.assetRoot, "bounded.ply");
    const result = await objToGaussianPly({
      ...source,
      outputPath,
      targetSplatCount: 10_000,
      maxSplats: 3,
      maxBytes: 1_024,
    });
    expect(result.splatCount).toBe(3);
    expect(result.byteLength).toBeLessThanOrEqual(1_024);
    await expect(inspectRealityAsset(new Blob([new Uint8Array(await readFile(outputPath))])))
      .resolves.toMatchObject({ descriptor: { splatCount: 3 } });
  });

  it("reserves all remaining output before each write and removes a partial file on depletion", async () => {
    const root = await temporaryDirectory();
    const source = await texturedSquare(root);
    const outputPath = join(source.assetRoot, "reserve-depleted.ply");
    const reservations: number[] = [];

    await expect(objToGaussianPly({
      ...source,
      outputPath,
      targetSplatCount: 5_000,
      reserveOutputBytes: async (remainingOutputBytes) => {
        reservations.push(remainingOutputBytes);
        if (reservations.length === 2) throw new Error("temporary volume depleted");
      },
    })).rejects.toMatchObject({
      code: "resource_limit",
      message: expect.stringContaining("storage capacity"),
    });

    expect(reservations).toHaveLength(2);
    expect(reservations[0]).toBeGreaterThan(reservations[1]!);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects packed OBJ structural expansion before conversion and accepts the exact boundary", async () => {
    const root = await temporaryDirectory();
    const source = await texturedSquare(root);
    // Four vertices (4 * 49), four UVs (4 * 16), and two candidate
    // triangles (2 * 64, including their sample allocations) = 388 bytes.
    const exactBoundaryOutput = join(source.assetRoot, "structural-boundary.ply");
    await expect(objToGaussianPly({
      ...source,
      outputPath: exactBoundaryOutput,
      targetSplatCount: 4,
      maxStructuralBytes: 388,
    })).resolves.toMatchObject({ sourceTriangleCount: 2, splatCount: 4 });

    const rejectedOutput = join(source.assetRoot, "structural-over-budget.ply");
    await expect(objToGaussianPly({
      ...source,
      outputPath: rejectedOutput,
      targetSplatCount: 4,
      maxStructuralBytes: 387,
    })).rejects.toMatchObject({
      code: "resource_limit",
      message: expect.stringContaining("packed structural data"),
    });
    await expect(readFile(rejectedOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal references, existing outputs, and aborted work without overwriting", async () => {
    const root = await temporaryDirectory();
    const source = await texturedSquare(root);
    await writeFile(join(root, "outside.mtl"), "newmtl x\nKd 1 1 1\n");
    const escapingObj = join(source.assetRoot, "escaping.obj");
    await writeFile(escapingObj, [
      "mtllib ../outside.mtl",
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "f 1 2 3",
    ].join("\n"));
    await expect(objToGaussianPly({
      objPath: escapingObj,
      assetRoot: source.assetRoot,
      outputPath: join(source.assetRoot, "escaping.ply"),
      targetSplatCount: 1,
    })).rejects.toMatchObject({ code: "unsafe_reference" });

    const existing = join(source.assetRoot, "existing.ply");
    await writeFile(existing, "keep me");
    await expect(objToGaussianPly({ ...source, outputPath: existing, targetSplatCount: 1 }))
      .rejects.toBeInstanceOf(ObjToGaussianPlyError);
    expect(await readFile(existing, "utf8")).toBe("keep me");

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(objToGaussianPly({
      ...source,
      outputPath: join(source.assetRoot, "aborted.ply"),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "aborted" });
  });
});
