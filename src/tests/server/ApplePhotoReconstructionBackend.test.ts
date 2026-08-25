import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ApplePhotoReconstructionBackend } from "../../../server/reconstruction/ApplePhotoReconstructionBackend";
import type {
  ReconstructionBackend,
  ReconstructionRequest,
} from "../../../server/reconstruction/ReconstructionBackend";
import { ReconstructionBackendError } from "../../../server/reconstruction/ReconstructionBackend";
import { inspectRealityAsset } from "../../workspace/assets";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "semaframe-apple-photo-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeObjectCaptureBackend implements ReconstructionBackend {
  readonly id = "fake-object-capture";
  detail?: string;
  aggregatePixelCount?: number;

  async probe() {
    return { version: 1 as const, backendId: this.id, supported: true };
  }

  async reconstruct(request: ReconstructionRequest) {
    this.detail = request.detail;
    this.aggregatePixelCount = request.aggregatePixelCount;
    await mkdir(request.outputDirectory, { recursive: true });
    const objPath = join(request.outputDirectory, "capture.obj");
    await writeFile(objPath, [
      "v 0 0 0 1 0 0",
      "v 1 0 0 0 1 0",
      "v 0 1 0 0 0 1",
      "f 1 2 3",
    ].join("\n"));
    request.onProgress?.({ version: 1, type: "started" });
    request.onProgress?.({ version: 1, type: "progress", progress: 0.5 });
    request.onProgress?.({ version: 1, type: "skipped_sample", sampleId: 1 });
    request.onProgress?.({ version: 1, type: "complete", progress: 1 });
    return {
      backendId: this.id,
      outputDirectory: request.outputDirectory,
      objPath,
      artifacts: [objPath],
    };
  }
}

describe("ApplePhotoReconstructionBackend", () => {
  it("composes Object Capture and bounded OBJ conversion into a service backend", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "input");
    const outputDirectory = join(root, "output");
    await mkdir(inputDirectory);
    const objectCaptureBackend = new FakeObjectCaptureBackend();
    const backend = new ApplePhotoReconstructionBackend({
      objectCaptureBackend,
      profileSplatCounts: { balanced: 32 },
    });
    const updates: Array<{ phase: string; progress: number }> = [];
    const result = await backend.run({
      jobId: "job",
      workspaceId: "workspace",
      profile: "balanced",
      inputDirectory,
      outputDirectory,
      aggregatePixelCount: 123_456,
      photos: [
        { photoId: "a", mediaType: "image/jpeg", byteLength: 1, sha256: `sha256:${"a".repeat(64)}`, path: join(inputDirectory, "a.jpg") },
        { photoId: "b", mediaType: "image/jpeg", byteLength: 1, sha256: `sha256:${"b".repeat(64)}`, path: join(inputDirectory, "b.jpg") },
        { photoId: "c", mediaType: "image/jpeg", byteLength: 1, sha256: `sha256:${"c".repeat(64)}`, path: join(inputDirectory, "c.jpg") },
      ],
      signal: new AbortController().signal,
      onProgress: (update) => updates.push(update),
    });

    expect(objectCaptureBackend.detail).toBe("medium");
    expect(objectCaptureBackend.aggregatePixelCount).toBe(123_456);
    expect(result).toMatchObject({
      outputPath: join(outputDirectory, "reconstruction.ply"),
      format: "ply",
      registeredPhotoCount: 2,
      warnings: [
        "partial_camera_registration",
        "source_scale_unknown",
        "source_coordinates_unknown",
      ],
    });
    expect(updates.map((update) => update.phase)).toEqual([
      "camera_solving",
      "camera_solving",
      "camera_solving",
      "training",
      "packing",
    ]);
    const bytes = await readFile(result.outputPath);
    await expect(inspectRealityAsset(new Blob([new Uint8Array(bytes)]))).resolves.toMatchObject({
      descriptor: { format: "ply", splatCount: 32, engineeringAuthority: "visual_only" },
    });
  });

  it("reports the underlying local capability without leaking implementation paths", async () => {
    const backend = new ApplePhotoReconstructionBackend({
      objectCaptureBackend: {
        id: "unavailable",
        async probe() {
          return { version: 1, backendId: "unavailable", supported: false, reason: "Unsupported platform" };
        },
        async reconstruct() {
          throw new Error("not called");
        },
      },
    });
    await expect(backend.probe()).resolves.toEqual({ available: false, reason: "Unsupported platform" });
    expect(backend.identity).toEqual({ id: "apple-object-capture-gaussian", version: "1" });
  });

  it("maps an intermediate disk quota failure to the service resource boundary", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "input");
    const outputDirectory = join(root, "output");
    await mkdir(inputDirectory);
    const backend = new ApplePhotoReconstructionBackend({
      objectCaptureBackend: {
        id: "quota-exhausted",
        async probe() {
          return { version: 1, backendId: "quota-exhausted", supported: true };
        },
        async reconstruct() {
          throw new ReconstructionBackendError(
            "resource_exhausted",
            "Object Capture exceeded its bounded intermediate output budget",
          );
        },
      },
    });

    await expect(backend.run({
      jobId: "quota-job",
      workspaceId: "workspace",
      profile: "preview",
      inputDirectory,
      outputDirectory,
      aggregatePixelCount: 1,
      photos: [],
      signal: new AbortController().signal,
      onProgress() {},
    })).rejects.toMatchObject({ code: "resource_exhausted", retryable: true });
  });

  it("includes the final PLY in the selected profile's total output-tree budget", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "input");
    const outputDirectory = join(root, "output");
    await mkdir(inputDirectory);
    const delegate = new FakeObjectCaptureBackend();
    const profileBytes = 1024 * 1024 * 1024;
    const objectCaptureBackend: ReconstructionBackend = {
      id: "near-profile-cap",
      probe: delegate.probe.bind(delegate),
      async reconstruct(request) {
        const result = await delegate.reconstruct(request);
        const objBytes = Buffer.byteLength([
          "v 0 0 0 1 0 0",
          "v 1 0 0 0 1 0",
          "v 0 1 0 0 0 1",
          "f 1 2 3",
        ].join("\n"));
        const fillerPath = join(request.outputDirectory, "capture-intermediate.bin");
        const filler = await open(fillerPath, "w", 0o600);
        await filler.truncate(profileBytes - objBytes);
        await filler.close();
        return { ...result, artifacts: [...result.artifacts, fillerPath] };
      },
    };
    const backend = new ApplePhotoReconstructionBackend({
      objectCaptureBackend,
      availableOutputBytes: async () => BigInt(profileBytes * 2),
    });

    await expect(backend.run({
      jobId: "profile-tree-budget-job",
      workspaceId: "workspace",
      profile: "preview",
      inputDirectory,
      outputDirectory,
      aggregatePixelCount: 1,
      photos: [],
      signal: new AbortController().signal,
      onProgress() {},
    })).rejects.toMatchObject({ code: "resource_exhausted", retryable: true });
    await expect(readFile(join(outputDirectory, "reconstruction.ply")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the free-space reserve depletes during PLY conversion", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "input");
    const outputDirectory = join(root, "output");
    await mkdir(inputDirectory);
    let capacityChecks = 0;
    const reserve = 512 * 1024 * 1024;
    const backend = new ApplePhotoReconstructionBackend({
      objectCaptureBackend: new FakeObjectCaptureBackend(),
      profileSplatCounts: { preview: 5_000 },
      availableOutputBytes: async () => {
        capacityChecks += 1;
        return capacityChecks === 1 ? BigInt(reserve + 1024 * 1024) : BigInt(reserve - 1);
      },
    });

    await expect(backend.run({
      jobId: "conversion-reserve-job",
      workspaceId: "workspace",
      profile: "preview",
      inputDirectory,
      outputDirectory,
      aggregatePixelCount: 1,
      photos: [],
      signal: new AbortController().signal,
      onProgress() {},
    })).rejects.toMatchObject({ code: "resource_exhausted", retryable: true });
    expect(capacityChecks).toBeGreaterThanOrEqual(2);
    await expect(readFile(join(outputDirectory, "reconstruction.ply")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when conversion free-space capacity cannot be measured", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "input");
    const outputDirectory = join(root, "output");
    await mkdir(inputDirectory);
    const backend = new ApplePhotoReconstructionBackend({
      objectCaptureBackend: new FakeObjectCaptureBackend(),
      profileSplatCounts: { preview: 32 },
      availableOutputBytes: async () => { throw new Error("statfs unavailable"); },
    });

    await expect(backend.run({
      jobId: "conversion-capacity-unavailable-job",
      workspaceId: "workspace",
      profile: "preview",
      inputDirectory,
      outputDirectory,
      aggregatePixelCount: 1,
      photos: [],
      signal: new AbortController().signal,
      onProgress() {},
    })).rejects.toMatchObject({ code: "resource_exhausted", retryable: true });
    await expect(readFile(join(outputDirectory, "reconstruction.ply")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
