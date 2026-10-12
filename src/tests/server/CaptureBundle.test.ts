// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCaptureBundle } from "../../../server/reconstruction/createCaptureBundle";
import { inspectCaptureBundle, parseCaptureBundleManifest } from "../../reconstruction/captureBundle";
import { digestBlobSha256 } from "../../workspace/assets/digest";
import { MemoryPrecisionEvidenceVault } from "../../workspace/precision/evidenceVault";
import { authenticatePrecisionEvidence } from "../../workspace/precision/evidenceAuthentication";
import { createPrecisionStudy } from "../../workspace/precision/validation";
import { importMeasurementGeometry } from "../../workspace/precision/geometryImport";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "semaframe-capture-bundle-test-"));
  roots.push(root);
  const outputDirectory = join(root, "output");
  await mkdir(outputDirectory);
  const objPath = join(outputDirectory, "model.obj");
  const materialPath = join(outputDirectory, "model.mtl");
  const texturePath = join(outputDirectory, "Texture.png");
  const visualPath = join(outputDirectory, "visual.ply");
  const outputPath = join(outputDirectory, "measurement.capture.zip");
  await writeFile(objPath, "mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  await writeFile(materialPath, "newmtl surface\nmap_Kd Texture.png\n");
  await writeFile(texturePath, new Uint8Array([1, 2, 3]));
  await writeFile(visualPath, "visual-output");
  const options = {
    outputDirectory, objPath, artifacts: [objPath, materialPath, texturePath], outputPath, visualPath,
    backend: { id: "test-backend", version: "1" }, profile: "preview" as const,
    inputPhotoCount: 2, registeredPhotoCount: 2,
    signal: new AbortController().signal,
    reserveOutputBytes: async () => undefined,
  };
  return { root, options };
}

describe("content-addressed retained measurement capture", () => {
  it("authenticates normalized geometry against the nested OBJ digest, not the outer archive digest", async () => {
    const { options } = await fixture();
    await createCaptureBundle(options);
    const blob = new Blob([new Uint8Array(await readFile(options.outputPath))]);
    const ref = { digest: await digestBlobSha256(blob), byteLength: blob.size, kind: "capture-bundle" as const, mediaType: "application/vnd.semaframe.capture+zip" };
    const vault = new MemoryPrecisionEvidenceVault();
    await vault.put(ref, blob);
    const study = createPrecisionStudy(importMeasurementGeometry({ data: await readFile(options.objPath, "utf8"), format: "obj",
      units: "unknown", coordinateBasis: "RUB", geometryId: "native_mesh", provenance: "Unverified native photo reconstruction" }));
    expect(study.geometry.source.sha256).not.toBe(ref.digest);
    expect(await authenticatePrecisionEvidence(study, [ref], vault)).toMatchObject({ sourceBytesAuthenticated: true, physicalAccuracyCertified: false });
    await expect(authenticatePrecisionEvidence({ ...study, geometry: { ...study.geometry, positions: [[0, 0, 0], [10, 0, 0], [0, 1, 0]] } }, [ref], vault))
      .rejects.toMatchObject({ code: "precision_source_geometry_mismatch" });
    await expect(authenticatePrecisionEvidence(study, { fake: ref }, vault)).rejects.toMatchObject({ code: "precision_source_unavailable" });
  });
  it("retains exact native mesh/material/texture bytes without source photos or metric authority", async () => {
    const { root, options } = await fixture();
    await writeFile(join(root, "private-source-photo.jpg"), "never retained");
    await createCaptureBundle(options);
    const blob = new Blob([new Uint8Array(await readFile(options.outputPath))]);
    const output = await inspectCaptureBundle(blob, { expectedSha256: await digestBlobSha256(blob) });
    expect(await output.mesh.text()).toBe(await readFile(options.objPath, "utf8"));
    expect(output.files.size).toBe(3);
    expect(new Uint8Array(await output.files.get("Texture.png")!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(output.manifest).toMatchObject({ sourcePhotosRetained: false, units: "unknown", axes: "unknown",
      engineeringAuthority: "unverified_measurement", geometryPath: "model.obj" });
    expect(JSON.stringify(output.manifest)).not.toContain(root);
    expect(JSON.stringify(output.manifest)).not.toContain("private-source-photo");
    await expect(inspectCaptureBundle(blob, { expectedSha256: `sha256:${"f".repeat(64)}` })).rejects.toThrow("digest mismatch");
    await expect(inspectCaptureBundle(blob, { expectedVisualSha256: `sha256:${"f".repeat(64)}` })).rejects.toThrow("visual digest mismatch");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    bytes[60] ^= 1;
    await expect(inspectCaptureBundle(new Blob([bytes]))).rejects.toThrow();
  });

  it("rejects hidden paths, forged measurement authority, photo retention and duplicate native names", async () => {
    const { options } = await fixture();
    await createCaptureBundle(options);
    const { manifest } = await inspectCaptureBundle(new Blob([new Uint8Array(await readFile(options.outputPath))]));
    expect(() => parseCaptureBundleManifest({ ...manifest, units: "metre" })).toThrow();
    expect(() => parseCaptureBundleManifest({ ...manifest, sourcePhotosRetained: true })).toThrow();
    expect(() => parseCaptureBundleManifest({ ...manifest, files: [{ ...manifest.files[0], path: "../private.obj" }] })).toThrow();
    expect(() => parseCaptureBundleManifest({ ...manifest, files: [...manifest.files, manifest.files[0]] })).toThrow();
    expect(() => parseCaptureBundleManifest({ ...manifest, fileSystemPath: "/secret" })).toThrow();
  });

  it("rejects symlink/out-of-root artifacts and never writes an unapproved output bundle", async () => {
    const { root, options } = await fixture();
    const outside = join(root, "source.obj");
    await writeFile(outside, "v 0 0 0");
    const linked = join(options.outputDirectory, "linked.obj");
    await symlink(outside, linked);
    await expect(createCaptureBundle({ ...options, artifacts: [...options.artifacts, linked] })).rejects.toThrow("Unsafe");
    await expect(readFile(options.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(createCaptureBundle({ ...options, artifacts: [...options.artifacts, outside] })).rejects.toThrow("Unsafe");
    await expect(createCaptureBundle({ ...options, outputPath: join(root, "escaped.zip") })).rejects.toThrow("Unsafe");
  });

  it("removes a partially written bundle on cancellation or reserve failure", async () => {
    const { options } = await fixture();
    let checks = 0;
    await expect(createCaptureBundle({ ...options, reserveOutputBytes: async () => {
      checks += 1;
      if (checks > 1) throw new Error("reserve depleted");
    } })).rejects.toThrow("reserve depleted");
    await expect(readFile(options.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    const abort = new AbortController();
    abort.abort();
    await expect(createCaptureBundle({ ...options, signal: abort.signal })).rejects.toThrow();
  });
});
