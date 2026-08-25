import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAssetIngress, AgentAssetIngressError } from "../../../server/agent/AgentAssetIngress";
import {
  PhotoReconstructionService,
  type PhotoReconstructionBackend,
  type PhotoReconstructionBackendRequest,
} from "../../../server/reconstruction/PhotoReconstructionService";
import {
  PHOTO_RECONSTRUCTION_LIMITS,
  type BeginPhotoReconstructionInput,
  type PhotoReconstructionJobView,
  type PhotoReconstructionMediaType,
} from "../../reconstruction/contracts";

const PUBLIC_URL = "http://127.0.0.1:8788";
const principal = Object.freeze({
  authorizationId: "approved-photo-reconstruction-01",
  clientId: "photo-reconstruction-agent",
  clientName: "Photo Reconstruction Agent",
});
const otherPrincipal = Object.freeze({
  authorizationId: "approved-photo-reconstruction-02",
  clientId: "second-photo-reconstruction-agent",
  clientName: "Second Photo Reconstruction Agent",
});

const services: PhotoReconstructionService[] = [];
const ingresses: AgentAssetIngress[] = [];
const temporaryParents: string[] = [];

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function body(bytes: Uint8Array, split = bytes.byteLength): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes.slice(0, split);
      if (split < bytes.byteLength) yield bytes.slice(split);
    },
  };
}

const PNG_FIXTURES = [
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNg+M8AQhAKABvyA/3vqwwGAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRmAKABf2A/38FIMyAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVQImWP4/5/h/38GEP7/nwEAO9IH+bGlfpgAAAAASUVORK5CYII=",
] as const;

function png(seed = 0): Uint8Array {
  return new Uint8Array(Buffer.from(PNG_FIXTURES[seed % PNG_FIXTURES.length]!, "base64"));
}

const OVER_LIMIT_PNG = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAJxEAACcQCAIAAADa7p5OAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==",
  "base64",
));

function signedButUndecodablePng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

const OUTPUT = new TextEncoder().encode([
  "ply",
  "format ascii 1.0",
  "element vertex 1",
  "property float x",
  "property float y",
  "property float z",
  "property float opacity",
  "property float scale_0",
  "property float scale_1",
  "property float scale_2",
  "property float rot_0",
  "property float rot_1",
  "property float rot_2",
  "property float rot_3",
  "property float f_dc_0",
  "property float f_dc_1",
  "property float f_dc_2",
  "end_header",
  "0 0 0 1 0 0 0 1 0 0 0 0.5 0.5 0.5",
  "",
].join("\n"));

class SuccessfulBackend implements PhotoReconstructionBackend {
  readonly identity = Object.freeze({ id: "test-gaussian", version: "1.0.0" });
  requests: PhotoReconstructionBackendRequest[] = [];

  async probe() {
    return { available: true } as const;
  }

  async run(request: PhotoReconstructionBackendRequest) {
    this.requests.push(request);
    request.onProgress({ phase: "camera_solving", progress: 0.2, registeredPhotoCount: request.photos.length - 1 });
    request.onProgress({ phase: "training", progress: 0.7 });
    const outputPath = join(request.outputDirectory, "reconstruction.ply");
    await writeFile(outputPath, OUTPUT, { mode: 0o600 });
    request.onProgress({ phase: "packing", progress: 0.96 });
    return {
      outputPath,
      format: "ply" as const,
      registeredPhotoCount: request.photos.length,
      warnings: ["source_scale_unknown", "source_coordinates_unknown"] as const,
    };
  }
}

class HangingBackend implements PhotoReconstructionBackend {
  readonly identity = Object.freeze({ id: "test-hanging", version: "1.0.0" });

  run(request: PhotoReconstructionBackendRequest): Promise<never> {
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("cancelled", "AbortError"));
      request.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class SlowAbortBackend implements PhotoReconstructionBackend {
  readonly identity = Object.freeze({ id: "test-slow-abort", version: "1.0.0" });
  request?: PhotoReconstructionBackendRequest;
  settled = false;

  run(request: PhotoReconstructionBackendRequest): Promise<never> {
    this.request = request;
    return new Promise((_resolve, reject) => {
      const abort = () => {
        setTimeout(() => {
          void (async () => {
            // Simulate a child process that needs a termination grace and can
            // still touch its output boundary before its close event settles.
            await mkdir(request.inputDirectory, { recursive: true });
            await writeFile(join(request.inputDirectory, "late-after-abort.tmp"), "late");
            this.settled = true;
            reject(new DOMException("cancelled after process close", "AbortError"));
          })().catch(reject);
        }, 30);
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
  }
}

type SourcePhoto = Readonly<{
  id: string;
  mediaType: PhotoReconstructionMediaType;
  bytes: Uint8Array;
}>;

function reconstructionInput(
  photos: readonly SourcePhoto[],
  overrides: Partial<Omit<BeginPhotoReconstructionInput, "photos">> = {},
): BeginPhotoReconstructionInput {
  return {
    requestId: "photo-reconstruction-request-0001",
    workspaceId: "workspace_main",
    profile: "balanced",
    photos: photos.map((photo) => ({
      photoId: photo.id,
      mediaType: photo.mediaType,
      byteLength: photo.bytes.byteLength,
      sha256: digest(photo.bytes),
    })),
    ...overrides,
  };
}

async function setup(
  backend: PhotoReconstructionBackend = new SuccessfulBackend(),
  overrides: Partial<ConstructorParameters<typeof PhotoReconstructionService>[0]> = {},
  existingParent?: string,
) {
  const parent = existingParent ?? await mkdtemp(join(tmpdir(), "semaframe-photo-reconstruction-test-"));
  if (!existingParent) temporaryParents.push(parent);
  const assetIngress = new AgentAssetIngress({
    publicBaseUrl: PUBLIC_URL,
    temporaryDirectory: parent,
    maxBytes: 1024 * 1024,
    maxStagedBytes: 4 * 1024 * 1024,
    sweepIntervalMs: 0,
  });
  ingresses.push(assetIngress);
  const service = new PhotoReconstructionService({
    publicBaseUrl: PUBLIC_URL,
    temporaryDirectory: parent,
    assetIngress,
    backend,
    sweepIntervalMs: 0,
    ...overrides,
  });
  services.push(service);
  return { service, assetIngress, parent };
}

async function uploadAll(
  service: PhotoReconstructionService,
  photos: readonly SourcePhoto[],
  result: Awaited<ReturnType<PhotoReconstructionService["begin"]>>,
): Promise<void> {
  for (const upload of result.uploads) {
    const source = photos.find((photo) => photo.id === upload.photoId)!;
    await service.upload(
      new URL(upload.url).pathname,
      upload.token,
      upload.contentType,
      upload.contentLength,
      body(source.bytes, 4),
    );
  }
}

async function waitForTerminal(
  service: PhotoReconstructionService,
  jobId: string,
  authorizationId: string = principal.authorizationId,
): Promise<PhotoReconstructionJobView> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await service.inspect(jobId, authorizationId);
    if (["ready", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Photo reconstruction did not reach a terminal state.");
}

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.allSettled(ingresses.splice(0).map((ingress) => ingress.close()));
  await Promise.allSettled(temporaryParents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
});

describe("PhotoReconstructionService", () => {
  it("coalesces parallel backend capability probes and serves the bounded cache", async () => {
    const backend = new SuccessfulBackend();
    const probe = vi.spyOn(backend, "probe");
    const { service } = await setup(backend, { capabilityCacheTtlMs: 1_000 });
    const capabilities = await Promise.all([
      service.capability(),
      service.capabilities(),
      service.probe(),
    ]);
    expect(capabilities).toEqual([
      { backend: backend.identity, available: true },
      { backend: backend.identity, available: true },
      { backend: backend.identity, available: true },
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(service.capability()).resolves.toEqual({ backend: backend.identity, available: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("aborts and joins an in-flight backend capability probe during shutdown", async () => {
    let probeStarted = false;
    let probeAborted = false;
    const backend: PhotoReconstructionBackend = {
      identity: Object.freeze({ id: "abortable-probe", version: "1" }),
      probe(signal) {
        probeStarted = true;
        return new Promise((_resolve, reject) => {
          const abort = () => {
            probeAborted = true;
            reject(new DOMException("probe aborted", "AbortError"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
      run() {
        throw new Error("not used");
      },
    };
    const { service } = await setup(backend);
    const pending = service.capability();
    await vi.waitFor(() => expect(probeStarted).toBe(true));

    await expect(service.close()).resolves.toBeUndefined();
    expect(probeAborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ available: false });
  });

  it("accepts independently decoded PNG inputs and stages a private output candidate", async () => {
    const backend = new SuccessfulBackend();
    const { service, assetIngress, parent } = await setup(backend);
    const photos: SourcePhoto[] = [
      { id: "front", mediaType: "image/png", bytes: png(0) },
      { id: "left", mediaType: "image/png", bytes: png(1) },
      { id: "right", mediaType: "image/png", bytes: png(2) },
      { id: "rear", mediaType: "image/png", bytes: png(3) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos));

    expect(begun.job).toMatchObject({
      status: "awaiting_upload",
      inputPhotoCount: 4,
      uploadedPhotoCount: 0,
      backend: backend.identity,
    });
    expect(begun.uploads).toHaveLength(4);
    expect(begun.uploads.every((grant) => service.matchesUploadPath(new URL(grant.url).pathname))).toBe(true);
    const wire = JSON.stringify(begun);
    expect(wire).not.toMatch(/IMG_|originalName|localPath|EXIF|\/tmp\//iu);

    await uploadAll(service, photos, begun);
    const uploaded = await service.inspect(begun.job.jobId, principal.authorizationId, "workspace_main");
    expect(uploaded).toMatchObject({ status: "awaiting_upload", uploadedPhotoCount: 4 });
    await service.start(begun.job.jobId, principal.authorizationId, "workspace_main");
    const ready = await waitForTerminal(service, begun.job.jobId);
    expect(ready).toMatchObject({
      status: "ready",
      progress: 1,
      registeredPhotoCount: 4,
      result: {
        candidateHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        format: "ply",
        mediaType: "application/ply",
        byteLength: OUTPUT.byteLength,
        sha256: digest(OUTPUT),
      },
    });
    expect(ready.warnings).toEqual(expect.arrayContaining(["source_scale_unknown", "source_coordinates_unknown"]));
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]!.aggregatePixelCount).toBe(16);
    expect(backend.requests[0]!.photos.every((photo) =>
      photo.path.startsWith(backend.requests[0]!.inputDirectory)
      && !photo.path.includes("IMG_"))).toBe(true);

    await expect(service.finalize(begun.job.jobId, principal, {
      expectedOutputSha256: `sha256:${"0".repeat(64)}`,
      displayName: "Private room reconstruction",
    })).rejects.toMatchObject({ code: "photo_reconstruction_digest_mismatch" });
    const candidate = await service.finalize(begun.job.jobId, principal, {
      expectedOutputSha256: digest(OUTPUT),
      displayName: "Private room reconstruction",
    });
    expect(candidate).toEqual(ready.result);

    const inspected = await assetIngress.inspect(candidate.candidateHandle, "workspace_main");
    expect(inspected).toMatchObject({
      displayName: "Private room reconstruction",
      sha256: digest(OUTPUT),
      byteLength: OUTPUT.byteLength,
      purpose: "photo_reconstruction",
      status: "ready",
    });
    await expect(service.finalize(begun.job.jobId, principal, {
      expectedOutputSha256: digest(OUTPUT),
      displayName: "A conflicting reconstruction label",
    })).rejects.toMatchObject({ status: 409, code: "photo_reconstruction_finalization_conflict" });
    const opened = await assetIngress.open(candidate.candidateHandle, "workspace_main");
    expect(Array.from(new Uint8Array(await new Response(opened.body).arrayBuffer()))).toEqual(Array.from(OUTPUT));

    await service.close();
    await assetIngress.close();
    expect(await readdir(parent)).toEqual([]);
  });

  it("maps candidate-staging reserve depletion to retryable resource exhaustion", async () => {
    const { service, assetIngress } = await setup(new SuccessfulBackend());
    const photos: SourcePhoto[] = [
      { id: "front", mediaType: "image/png", bytes: png(0) },
      { id: "rear", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-staging-reserve",
    }));
    await uploadAll(service, photos, begun);
    vi.spyOn(assetIngress, "upload").mockRejectedValueOnce(new AgentAssetIngressError(
      507,
      "asset_upload_storage_exhausted",
      "staging reserve depleted",
    ));

    await service.start(begun.job.jobId, principal.authorizationId, "workspace_main");
    await expect(waitForTerminal(service, begun.job.jobId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "resource_exhausted", retryable: true },
    });
  });

  it("leases a ready job while browser finalization is in flight, then expires it at the bounded lease", async () => {
    let now = Date.parse("2026-08-25T04:00:00.000Z");
    const { service, assetIngress } = await setup(new SuccessfulBackend(), {
      now: () => now,
      readyTtlMs: 1_000,
    });
    const photos: SourcePhoto[] = [
      { id: "front", mediaType: "image/png", bytes: png(0) },
      { id: "rear", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-finalize-lease",
    }));
    await uploadAll(service, photos, begun);
    await service.start(begun.job.jobId, principal.authorizationId, "workspace_main");
    const ready = await waitForTerminal(service, begun.job.jobId);
    const candidate = await service.finalize(begun.job.jobId, principal, {
      expectedOutputSha256: ready.result!.sha256,
      displayName: "Leased reconstruction",
    });

    now += 2_000;
    await service.sweepExpired();
    await expect(service.inspect(begun.job.jobId, principal.authorizationId, "workspace_main"))
      .resolves.toMatchObject({ status: "ready", result: candidate });
    await expect(assetIngress.inspect(candidate.candidateHandle, "workspace_main"))
      .resolves.toMatchObject({ purpose: "photo_reconstruction", status: "ready" });

    now += PHOTO_RECONSTRUCTION_LIMITS.defaultFinalizationLeaseMs;
    await service.sweepExpired();
    await expect(service.inspect(begun.job.jobId, principal.authorizationId, "workspace_main"))
      .rejects.toMatchObject({ code: "photo_reconstruction_not_found" });
    await expect(assetIngress.inspect(candidate.candidateHandle, "workspace_main"))
      .rejects.toMatchObject({ code: "asset_candidate_not_found" });
  });

  it("enforces ownership, idempotency, exact length/digest, and byte signatures while permitting safe retries", async () => {
    const { service } = await setup();
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const input = reconstructionInput(photos);
    const begun = await service.begin(principal, input);
    expect(await service.begin(principal, input)).toEqual(begun);
    await expect(service.begin(principal, { ...input, profile: "quality" })).rejects.toMatchObject({
      code: "photo_reconstruction_idempotency_conflict",
    });
    await expect(service.inspect(begun.job.jobId, "another-authorization")).rejects.toMatchObject({
      status: 404,
      code: "photo_reconstruction_not_found",
    });
    await expect(service.start(begun.job.jobId, principal.authorizationId)).rejects.toMatchObject({
      code: "photo_set_incomplete",
    });

    const first = begun.uploads.find((grant) => grant.photoId === "a")!;
    await expect(service.upload(first.url, "wrong", first.contentType, first.contentLength, body(photos[0]!.bytes)))
      .rejects.toMatchObject({ code: "photo_upload_unauthorized" });
    await expect(service.upload(first.url, first.token, first.contentType, first.contentLength + 1, body(photos[0]!.bytes)))
      .rejects.toMatchObject({ code: "photo_length_header_mismatch" });
    const corrupted = photos[0]!.bytes.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    await expect(service.upload(first.url, first.token, first.contentType, first.contentLength, body(corrupted)))
      .rejects.toMatchObject({ code: "photo_digest_mismatch" });
    await expect(service.upload(first.url, first.token, first.contentType, first.contentLength, body(photos[0]!.bytes)))
      .resolves.toMatchObject({ uploadedPhotoCount: 1 });

    const invalidSignature = new TextEncoder().encode("not-a-jpeg");
    const invalidPhotos: SourcePhoto[] = [
      { id: "bad", mediaType: "image/jpeg", bytes: invalidSignature },
      { id: "ok", mediaType: "image/png", bytes: png(2) },
    ];
    const invalidJob = await service.begin(principal, reconstructionInput(invalidPhotos, {
      requestId: "photo-reconstruction-invalid-signature",
    }));
    const badGrant = invalidJob.uploads.find((grant) => grant.photoId === "bad")!;
    await expect(service.upload(
      badGrant.url,
      badGrant.token,
      badGrant.contentType,
      badGrant.contentLength,
      body(invalidSignature),
    )).rejects.toMatchObject({ status: 415, code: "photo_signature_mismatch" });

    await expect(service.begin(principal, {
      ...input,
      requestId: "photo-reconstruction-private-field",
      photos: input.photos.map((photo) => ({ ...photo, originalName: "IMG_0001.JPG" })),
    })).rejects.toMatchObject({ status: 400, code: "invalid_photo_set" });
  });

  it("retains a raw upload after unlink failure so retry or whole-job cancellation can clean it safely", async () => {
    const removalAttempts: string[] = [];
    const failedPaths = new Set<string>();
    const removeFile = async (path: string) => {
      removalAttempts.push(path);
      if (!failedPaths.has(path)) {
        failedPaths.add(path);
        throw new Error("injected raw upload unlink failure");
      }
      await unlink(path);
    };
    const { service } = await setup(new HangingBackend(), { removeFile });
    const photos: SourcePhoto[] = [
      { id: "agent-front-photo", mediaType: "image/png", bytes: png(0) },
      { id: "agent-rear-photo", mediaType: "image/png", bytes: png(1) },
    ];
    const corrupted = photos[0]!.bytes.slice();
    corrupted[corrupted.length - 1] ^= 0xff;

    const retryJob = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-raw-cleanup-retry",
    }));
    const retryGrant = retryJob.uploads.find(({ photoId }) => photoId === photos[0]!.id)!;
    await expect(service.upload(
      retryGrant.url,
      retryGrant.token,
      retryGrant.contentType,
      retryGrant.contentLength,
      body(corrupted),
    )).rejects.toMatchObject({ status: 500, code: "photo_reconstruction_cleanup_failed" });
    const retainedRetryPath = removalAttempts.at(-1)!;
    await expect(lstat(retainedRetryPath)).resolves.toMatchObject({});
    expect(basename(retainedRetryPath)).toMatch(/^[0-9a-f-]{36}\.partial$/u);
    expect(retainedRetryPath).not.toMatch(/agent-front-photo|agent-rear-photo/u);

    await expect(service.upload(
      retryGrant.url,
      retryGrant.token,
      retryGrant.contentType,
      retryGrant.contentLength,
      body(photos[0]!.bytes),
    )).resolves.toMatchObject({ uploadedPhotoCount: 1 });
    await expect(lstat(retainedRetryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-raw-cleanup-retry",
    }))).uploads).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ photoId: photos[0]!.id }),
    ]));

    const cancelJob = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-raw-cleanup-cancel",
    }));
    const cancelGrant = cancelJob.uploads.find(({ photoId }) => photoId === photos[0]!.id)!;
    await expect(service.upload(
      cancelGrant.url,
      cancelGrant.token,
      cancelGrant.contentType,
      cancelGrant.contentLength,
      body(corrupted),
    )).rejects.toMatchObject({ status: 500, code: "photo_reconstruction_cleanup_failed" });
    const retainedCancelPath = removalAttempts.at(-1)!;
    await expect(lstat(retainedCancelPath)).resolves.toMatchObject({});
    await expect(service.cancel(cancelJob.job.jobId, principal.authorizationId)).resolves.toMatchObject({
      cancelled: true,
      job: { status: "cancelled" },
    });
    await expect(lstat(retainedCancelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically reserves a retained upload grant before awaited retry cleanup", async () => {
    let removalAttempt = 0;
    let cleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStartedPromise = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const cleanupReleasePromise = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const removeFile = async (path: string) => {
      removalAttempt += 1;
      if (removalAttempt === 1) throw new Error("retain the first failed upload");
      if (removalAttempt === 2) {
        cleanupStarted();
        await cleanupReleasePromise;
      }
      await unlink(path);
    };
    const { service } = await setup(new HangingBackend(), { removeFile });
    const photos: SourcePhoto[] = [
      { id: "front", mediaType: "image/png", bytes: png(0) },
      { id: "rear", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-atomic-upload-retry",
    }));
    const grant = begun.uploads.find(({ photoId }) => photoId === "front")!;
    const corrupted = photos[0]!.bytes.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    await expect(service.upload(
      grant.url,
      grant.token,
      grant.contentType,
      grant.contentLength,
      body(corrupted),
    )).rejects.toMatchObject({ code: "photo_reconstruction_cleanup_failed" });

    const firstRetry = service.upload(
      grant.url,
      grant.token,
      grant.contentType,
      grant.contentLength,
      body(photos[0]!.bytes),
    );
    await cleanupStartedPromise;
    await expect(service.upload(
      grant.url,
      grant.token,
      grant.contentType,
      grant.contentLength,
      body(photos[0]!.bytes),
    )).rejects.toMatchObject({ status: 409, code: "photo_upload_in_progress" });
    releaseCleanup();
    await expect(firstRetry).resolves.toMatchObject({ uploadedPhotoCount: 1 });
    expect(removalAttempt).toBe(2);
  });

  it("rechecks filesystem free space while streaming and preserves the configured reserve", async () => {
    let capacityChecks = 0;
    let depleted = true;
    const { service } = await setup(new HangingBackend(), {
      minimumFreeBytesAfterUpload: 32,
      availableTemporaryBytes: async () => {
        capacityChecks += 1;
        return depleted && capacityChecks > 1 ? 32n : 1_024n;
      },
    });
    const photos: SourcePhoto[] = [
      { id: "front", mediaType: "image/png", bytes: png(0) },
      { id: "rear", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-upload-free-space",
    }));
    const grant = begun.uploads.find(({ photoId }) => photoId === "front")!;
    await expect(service.upload(
      grant.url,
      grant.token,
      grant.contentType,
      grant.contentLength,
      body(photos[0]!.bytes, 4),
    )).rejects.toMatchObject({ status: 507, code: "photo_upload_storage_exhausted" });
    expect(capacityChecks).toBeGreaterThanOrEqual(2);
    await expect(service.inspect(begun.job.jobId, principal.authorizationId))
      .resolves.toMatchObject({ uploadedPhotoCount: 0 });

    depleted = false;
    await expect(service.upload(
      grant.url,
      grant.token,
      grant.contentType,
      grant.contentLength,
      body(photos[0]!.bytes, 4),
    )).resolves.toMatchObject({ uploadedPhotoCount: 1 });
  });

  it("fails closed when filesystem capacity cannot be verified", async () => {
    const { service } = await setup(new HangingBackend(), {
      minimumFreeBytesAfterUpload: 32,
      availableTemporaryBytes: async () => { throw new Error("statfs unavailable"); },
    });
    const photos: SourcePhoto[] = [
      { id: "front", mediaType: "image/png", bytes: png(0) },
      { id: "rear", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-upload-capacity-unavailable",
    }));
    const grant = begun.uploads.find(({ photoId }) => photoId === "front")!;
    await expect(service.upload(
      grant.url,
      grant.token,
      grant.contentType,
      grant.contentLength,
      body(photos[0]!.bytes),
    )).rejects.toMatchObject({ status: 507, code: "photo_upload_storage_unavailable" });
    await expect(service.inspect(begun.job.jobId, principal.authorizationId))
      .resolves.toMatchObject({ uploadedPhotoCount: 0 });
  });

  it("requires decodable metadata and enforces both per-photo and aggregate decoded-pixel limits", async () => {
    const { service } = await setup();
    const undecodable: SourcePhoto[] = [
      { id: "bad", mediaType: "image/png", bytes: signedButUndecodablePng() },
      { id: "ok", mediaType: "image/png", bytes: png(0) },
    ];
    const badJob = await service.begin(principal, reconstructionInput(undecodable, {
      requestId: "photo-reconstruction-undecodable",
    }));
    const badGrant = badJob.uploads.find(({ photoId }) => photoId === "bad")!;
    await expect(service.upload(
      badGrant.url,
      badGrant.token,
      badGrant.contentType,
      badGrant.contentLength,
      body(undecodable[0]!.bytes),
    )).rejects.toMatchObject({ status: 422, code: "photo_decode_failed" });
    expect(await service.inspect(badJob.job.jobId, principal.authorizationId)).toMatchObject({
      uploadedPhotoCount: 0,
    });

    const oversized: SourcePhoto[] = [
      { id: "huge", mediaType: "image/png", bytes: OVER_LIMIT_PNG },
      { id: "ok", mediaType: "image/png", bytes: png(1) },
    ];
    const oversizedJob = await service.begin(principal, reconstructionInput(oversized, {
      requestId: "photo-reconstruction-pixel-limit",
    }));
    const oversizedGrant = oversizedJob.uploads.find(({ photoId }) => photoId === "huge")!;
    await expect(service.upload(
      oversizedGrant.url,
      oversizedGrant.token,
      oversizedGrant.contentType,
      oversizedGrant.contentLength,
      body(OVER_LIMIT_PNG),
    )).rejects.toMatchObject({ status: 413, code: "photo_pixel_limit_exceeded" });

    const bounded = await setup(new HangingBackend(), { maximumPhotoSetPixelCount: 8 });
    const photos: SourcePhoto[] = [
      { id: "first", mediaType: "image/png", bytes: png(0) },
      { id: "second", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await bounded.service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-total-pixels",
    }));
    const first = begun.uploads.find(({ photoId }) => photoId === "first")!;
    const second = begun.uploads.find(({ photoId }) => photoId === "second")!;
    await bounded.service.upload(first.url, first.token, first.contentType, first.contentLength, body(photos[0]!.bytes));
    await expect(bounded.service.upload(
      first.url,
      first.token,
      first.contentType,
      first.contentLength,
      body(photos[0]!.bytes),
    )).resolves.toMatchObject({ uploadedPhotoCount: 1 });
    await bounded.service.upload(second.url, second.token, second.contentType, second.contentLength, body(photos[1]!.bytes));
    await expect(bounded.service.start(begun.job.jobId, principal.authorizationId))
      .resolves.toMatchObject({ uploadedPhotoCount: 2 });
    await bounded.service.cancel(begun.job.jobId, principal.authorizationId);

    const rejectedSet = await setup(new HangingBackend(), { maximumPhotoSetPixelCount: 7 });
    const rejected = await rejectedSet.service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-total-pixels-rejected",
    }));
    const rejectedFirst = rejected.uploads.find(({ photoId }) => photoId === "first")!;
    const rejectedSecond = rejected.uploads.find(({ photoId }) => photoId === "second")!;
    await rejectedSet.service.upload(
      rejectedFirst.url,
      rejectedFirst.token,
      rejectedFirst.contentType,
      rejectedFirst.contentLength,
      body(photos[0]!.bytes),
    );
    await expect(rejectedSet.service.upload(
      rejectedSecond.url,
      rejectedSecond.token,
      rejectedSecond.contentType,
      rejectedSecond.contentLength,
      body(photos[1]!.bytes),
    )).rejects.toMatchObject({ status: 413, code: "photo_set_pixel_limit_exceeded" });
    await expect(rejectedSet.service.start(rejected.job.jobId, principal.authorizationId))
      .rejects.toMatchObject({ code: "photo_set_incomplete" });
  });

  it("cancels an active backend, cleans private inputs, and revokes a ready candidate", async () => {
    const backend = new HangingBackend();
    const { service } = await setup(backend);
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos));
    await uploadAll(service, photos, begun);
    await service.start(begun.job.jobId, principal.authorizationId);
    const running = await service.inspect(begun.job.jobId, principal.authorizationId);
    expect(["queued", "camera_solving"]).toContain(running.status);
    const cancelled = await service.cancel(begun.job.jobId, principal.authorizationId);
    expect(cancelled.job).toMatchObject({ status: "cancelled" });
    expect((await service.cancel(begun.job.jobId, principal.authorizationId)).job.status).toBe("cancelled");

    const successfulBackend = new SuccessfulBackend();
    const second = await setup(successfulBackend);
    const readyBegin = await second.service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-ready-cancel",
    }));
    await uploadAll(second.service, photos, readyBegin);
    await second.service.start(readyBegin.job.jobId, principal.authorizationId);
    const ready = await waitForTerminal(second.service, readyBegin.job.jobId);
    const handle = ready.result!.candidateHandle;
    await second.service.cancel(readyBegin.job.jobId, principal.authorizationId);
    await expect(second.assetIngress.inspect(handle, "workspace_main")).rejects.toMatchObject({ status: 404 });
  });

  it("waits for abort-aware backend process settlement before confirming cleanup", async () => {
    const backend = new SlowAbortBackend();
    const { service } = await setup(backend);
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-slow-backend-abort",
    }));
    await uploadAll(service, photos, begun);
    await service.start(begun.job.jobId, principal.authorizationId);
    await vi.waitFor(() => expect(backend.request).toBeDefined());
    const jobDirectory = join(backend.request!.inputDirectory, "..");

    let cancellationResolved = false;
    const cancellation = service.cancel(begun.job.jobId, principal.authorizationId)
      .then((result) => {
        cancellationResolved = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cancellationResolved).toBe(false);
    expect(backend.settled).toBe(false);

    await expect(cancellation).resolves.toMatchObject({ cancelled: true, job: { status: "cancelled" } });
    expect(backend.settled).toBe(true);
    await expect(lstat(jobDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(lstat(jobDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a ready candidate capability when discard fails once and retries it on cancellation", async () => {
    const { service, assetIngress } = await setup(new SuccessfulBackend());
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-candidate-cleanup-retry",
    }));
    await uploadAll(service, photos, begun);
    await service.start(begun.job.jobId, principal.authorizationId);
    const ready = await waitForTerminal(service, begun.job.jobId);
    const candidateHandle = ready.result!.candidateHandle;
    const discard = vi.spyOn(assetIngress, "cancelFromAgent")
      .mockRejectedValueOnce(new Error("injected candidate discard failure"));

    await expect(service.cancel(begun.job.jobId, principal.authorizationId)).rejects.toMatchObject({
      status: 500,
      code: "photo_reconstruction_cleanup_failed",
    });
    await expect(assetIngress.inspect(candidateHandle, "workspace_main")).resolves.toMatchObject({ status: "ready" });
    await expect(service.inspect(begun.job.jobId, principal.authorizationId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "photo_reconstruction_cleanup_failed", retryable: true },
    });

    await expect(service.cancel(begun.job.jobId, principal.authorizationId)).resolves.toMatchObject({
      cancelled: true,
      job: { status: "cancelled" },
    });
    expect(discard).toHaveBeenCalledTimes(2);
    await expect(assetIngress.inspect(candidateHandle, "workspace_main")).rejects.toMatchObject({ status: 404 });
  });

  it("turns a hard job deadline into a bounded failure even when the backend only reacts to abort", async () => {
    const { service } = await setup(new HangingBackend(), { jobTimeoutMs: 15, readyTtlMs: 1_000 });
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos));
    await uploadAll(service, photos, begun);
    await service.start(begun.job.jobId, principal.authorizationId);
    const failed = await waitForTerminal(service, begun.job.jobId);
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "reconstruction_timeout",
        retryable: true,
      },
    });
    expect(failed.result).toBeUndefined();
  });

  it("never reports a ready reconstruction when private-input cleanup fails", async () => {
    let failJobRemoval = true;
    const removeDirectory = async (directory: string) => {
      if (failJobRemoval && /^[0-9a-f-]{36}$/u.test(basename(directory))) {
        failJobRemoval = false;
        throw new Error("injected ready cleanup failure");
      }
      await rm(directory, { recursive: true, force: true });
    };
    const { service } = await setup(new SuccessfulBackend(), { removeDirectory });
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-ready-cleanup-failure",
    }));
    await uploadAll(service, photos, begun);
    await service.start(begun.job.jobId, principal.authorizationId);
    const failed = await waitForTerminal(service, begun.job.jobId);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "photo_reconstruction_cleanup_failed", retryable: true },
    });
    expect(failed.result).toBeUndefined();
    await expect(service.finalize(begun.job.jobId, principal)).rejects.toMatchObject({
      code: "photo_reconstruction_failed",
    });
    await expect(service.cancel(begun.job.jobId, principal.authorizationId)).resolves.toMatchObject({
      cancelled: true,
      job: { status: "cancelled" },
    });
  });

  it("keeps grants and physical paths when cancel cleanup fails, then retries cleanup instead of misreporting success", async () => {
    const removed: string[] = [];
    let failJobRemoval = true;
    const removeDirectory = async (directory: string) => {
      removed.push(directory);
      if (failJobRemoval && /^[0-9a-f-]{36}$/u.test(basename(directory))) {
        failJobRemoval = false;
        throw new Error("injected remove failure");
      }
      await rm(directory, { recursive: true, force: true });
    };
    const { service } = await setup(new HangingBackend(), { removeDirectory });
    const photos: SourcePhoto[] = [
      { id: "agent-chosen-front", mediaType: "image/png", bytes: png(0) },
      { id: "agent-chosen-rear", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-cancel-cleanup-retry",
    }));
    await uploadAll(service, photos, begun);

    await expect(service.cancel(begun.job.jobId, principal.authorizationId)).rejects.toMatchObject({
      status: 500,
      code: "photo_reconstruction_cleanup_failed",
    });
    const retained = await service.inspect(begun.job.jobId, principal.authorizationId);
    expect(retained).toMatchObject({
      status: "failed",
      uploadedPhotoCount: 2,
      error: { code: "photo_reconstruction_cleanup_failed", retryable: true },
    });
    const jobDirectory = removed.find((directory) => /^[0-9a-f-]{36}$/u.test(basename(directory)))!;
    const retainedFiles = await readdir(join(jobDirectory, "input"));
    expect(retainedFiles).toHaveLength(2);
    expect(retainedFiles.every((name) => /^[0-9a-f-]{36}\.png$/u.test(name))).toBe(true);
    expect(retainedFiles.join(" ")).not.toMatch(/agent-chosen|front|rear/u);

    await expect(service.cancel(begun.job.jobId, principal.authorizationId)).resolves.toMatchObject({
      cancelled: true,
      job: { status: "cancelled" },
    });
    await expect(lstat(jobDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps failed-cleanup photo bytes charged against the staging quota until deletion succeeds", async () => {
    let failJobRemoval = true;
    const removeDirectory = async (directory: string) => {
      if (failJobRemoval && /^[0-9a-f-]{36}$/u.test(basename(directory))) {
        failJobRemoval = false;
        throw new Error("injected retained quota cleanup failure");
      }
      await rm(directory, { recursive: true, force: true });
    };
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const declaredBytes = photos.reduce((total, photo) => total + photo.bytes.byteLength, 0);
    const { service } = await setup(new HangingBackend(), {
      maximumStagedBytes: declaredBytes,
      removeDirectory,
    });
    const first = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-retained-quota-first",
    }));
    await expect(service.cancel(first.job.jobId, principal.authorizationId)).rejects.toMatchObject({
      code: "photo_reconstruction_cleanup_failed",
    });
    const secondInput = reconstructionInput(photos, {
      requestId: "photo-reconstruction-retained-quota-second",
    });
    await expect(service.begin(otherPrincipal, secondInput)).rejects.toMatchObject({
      code: "photo_reconstruction_capacity_exceeded",
    });

    await expect(service.cancel(first.job.jobId, principal.authorizationId)).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(service.begin(otherPrincipal, secondInput)).resolves.toMatchObject({
      job: { status: "awaiting_upload" },
    });
  });

  it("retains failed revoke cleanup for a reliable second revoke", async () => {
    let failJobRemoval = true;
    const removeDirectory = async (directory: string) => {
      if (failJobRemoval && /^[0-9a-f-]{36}$/u.test(basename(directory))) {
        failJobRemoval = false;
        throw new Error("injected revoke remove failure");
      }
      await rm(directory, { recursive: true, force: true });
    };
    const { service } = await setup(new HangingBackend(), { removeDirectory });
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const begun = await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-revoke-cleanup-retry",
    }));
    await uploadAll(service, photos, begun);

    await expect(service.revokeAll()).rejects.toMatchObject({
      status: 500,
      code: "photo_reconstruction_cleanup_failed",
    });
    expect(await service.inspect(begun.job.jobId, principal.authorizationId)).toMatchObject({
      status: "failed",
      error: { code: "photo_reconstruction_cleanup_failed" },
    });
    await expect(service.revokeAll()).resolves.toBeUndefined();
    await expect(service.inspect(begun.job.jobId, principal.authorizationId)).rejects.toMatchObject({
      status: 404,
      code: "photo_reconstruction_not_found",
    });
  });

  it("makes close retryable when physical cleanup fails", async () => {
    const removed: string[] = [];
    let failJobRemoval = true;
    const removeDirectory = async (directory: string) => {
      removed.push(directory);
      if (failJobRemoval && /^[0-9a-f-]{36}$/u.test(basename(directory))) {
        failJobRemoval = false;
        throw new Error("injected close remove failure");
      }
      await rm(directory, { recursive: true, force: true });
    };
    const { service } = await setup(new HangingBackend(), { removeDirectory });
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    await uploadAll(service, photos, await service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-close-cleanup-retry",
    })));

    await expect(service.close()).rejects.toMatchObject({
      status: 500,
      code: "photo_reconstruction_cleanup_failed",
    });
    const jobDirectory = removed.find((directory) => /^[0-9a-f-]{36}$/u.test(basename(directory)))!;
    expect((await readdir(join(jobDirectory, "input"))).length).toBe(2);
    await expect(service.close()).resolves.toBeUndefined();
    await expect(lstat(jobDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps every expired job before reporting cleanup failures and retries retained jobs later", async () => {
    let clock = 1_700_000_000_000;
    let failedJobId = "";
    let failOnce = true;
    const removals: string[] = [];
    const removeDirectory = async (directory: string) => {
      removals.push(directory);
      if (failOnce && basename(directory) === failedJobId) {
        failOnce = false;
        throw new Error("injected sweep cleanup failure");
      }
      await rm(directory, { recursive: true, force: true });
    };
    const { service } = await setup(new HangingBackend(), {
      now: () => clock,
      uploadTtlMs: 10,
      readyTtlMs: 10,
      removeDirectory,
    });
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const firstInput = reconstructionInput(photos, {
      requestId: "photo-reconstruction-sweep-first",
    });
    const first = await service.begin(principal, firstInput);
    failedJobId = first.job.jobId;
    const second = await service.begin(otherPrincipal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-sweep-second",
    }));

    clock += 11;
    await expect(service.sweepExpired()).rejects.toMatchObject({
      status: 500,
      code: "photo_reconstruction_cleanup_failed",
    });
    expect(removals.map((directory) => basename(directory))).toEqual(expect.arrayContaining([
      first.job.jobId,
      second.job.jobId,
    ]));
    await expect(service.inspect(first.job.jobId, principal.authorizationId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "photo_reconstruction_cleanup_failed", retryable: true },
    });
    await expect(service.inspect(second.job.jobId, otherPrincipal.authorizationId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "photo_upload_expired", retryable: true },
    });
    await expect(service.begin(principal, firstInput)).resolves.toEqual({
      job: expect.objectContaining({
        jobId: first.job.jobId,
        status: "failed",
        error: expect.objectContaining({ code: "photo_reconstruction_cleanup_failed" }),
      }),
      uploads: [],
    });

    clock += 11;
    await expect(service.sweepExpired()).resolves.toBeUndefined();
    await expect(service.inspect(first.job.jobId, principal.authorizationId)).rejects.toMatchObject({ code: "photo_reconstruction_not_found" });
    await expect(service.inspect(second.job.jobId, otherPrincipal.authorizationId)).rejects.toMatchObject({ code: "photo_reconstruction_not_found" });
  });

  it("contains timer-driven sweep cleanup failures without an unhandled rejection and retries them", async () => {
    let jobId = "";
    let failOnce = true;
    const jobRemovals: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const removeDirectory = async (directory: string) => {
        if (basename(directory) === jobId) {
          jobRemovals.push(directory);
          if (failOnce) {
            failOnce = false;
            throw new Error("injected timer sweep cleanup failure");
          }
        }
        await rm(directory, { recursive: true, force: true });
      };
      const { service } = await setup(new HangingBackend(), {
        uploadTtlMs: 5,
        readyTtlMs: 5,
        sweepIntervalMs: 2,
        removeDirectory,
      });
      const photos: SourcePhoto[] = [
        { id: "a", mediaType: "image/png", bytes: png(0) },
        { id: "b", mediaType: "image/png", bytes: png(1) },
      ];
      const begun = await service.begin(principal, reconstructionInput(photos, {
        requestId: "photo-reconstruction-timer-sweep",
      }));
      jobId = begun.job.jobId;
      for (let attempt = 0; attempt < 100 && jobRemovals.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(jobRemovals.length).toBeGreaterThanOrEqual(2);
      expect(unhandled).toEqual([]);
      await expect(service.inspect(jobId, principal.authorizationId)).rejects.toMatchObject({
        code: "photo_reconstruction_not_found",
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("eagerly reclaims an aged dead root after restart without beginning or materializing a live root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "semaframe-photo-reconstruction-restart-"));
    temporaryParents.push(parent);
    const deadRoot = join(parent, "semaframe-photo-reconstruction-dead03");
    await mkdir(deadRoot, { mode: 0o700 });
    await writeFile(join(deadRoot, ".semaframe-owner-v1.json"), JSON.stringify({
      version: 1,
      pid: 2_147_483_645,
      processStartedAt: 1,
      lease: "z".repeat(43),
    }), { mode: 0o600 });
    await writeFile(join(deadRoot, "orphaned-after-crash.bin"), "orphaned");
    const old = new Date(Date.now() - 6 * 60_000);
    await utimes(join(deadRoot, ".semaframe-owner-v1.json"), old, old);
    await utimes(deadRoot, old, old);

    const restarted = await setup(new SuccessfulBackend(), {}, parent);

    // Construction starts reclamation eagerly; no capability probe or begin is
    // needed to trigger removal of a safely aged, provably dead owner root.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await lstat(deadRoot);
      } catch (error) {
        if (error instanceof Error && "code" in error
          && (error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(lstat(deadRoot)).rejects.toMatchObject({ code: "ENOENT" });

    // Capability awaits the startup pass but remains cleanup-only: it must not
    // create this service's persistent reconstruction root.
    await expect(restarted.service.capability()).resolves.toMatchObject({ available: true });
    expect((await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()
        && /^semaframe-photo-reconstruction-[A-Za-z0-9_-]{6,64}$/u.test(entry.name)))
      .toHaveLength(0);
  });

  it("keeps capability probing and close cleanup-only when the temporary parent does not exist", async () => {
    const base = await mkdtemp(join(tmpdir(), "semaframe-photo-reconstruction-missing-parent-"));
    temporaryParents.push(base);
    const missingParent = join(base, "not-created");
    const assetIngress = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: base,
      maxBytes: 1024 * 1024,
      maxStagedBytes: 4 * 1024 * 1024,
      sweepIntervalMs: 0,
    });
    ingresses.push(assetIngress);
    const service = new PhotoReconstructionService({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: missingParent,
      assetIngress,
      backend: new SuccessfulBackend(),
      sweepIntervalMs: 0,
    });
    services.push(service);

    await expect(service.capability()).resolves.toMatchObject({ available: true });
    await expect(lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.close()).resolves.toBeUndefined();
    await expect(lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("garbage-collects only dead leased roots and never deletes an aged live root owned by another service", async () => {
    const parent = await mkdtemp(join(tmpdir(), "semaframe-photo-reconstruction-shared-"));
    temporaryParents.push(parent);
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const first = await setup(new HangingBackend(), {}, parent);
    const firstJob = await first.service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-live-root-1",
    }));
    const roots = (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^semaframe-photo-reconstruction-[A-Za-z0-9_-]{6,64}$/u.test(entry.name));
    expect(roots).toHaveLength(1);
    const liveRoot = join(parent, roots[0]!.name);
    const old = new Date(Date.now() - 6 * 60_000);
    await utimes(join(liveRoot, ".semaframe-owner-v1.json"), old, old);
    await utimes(liveRoot, old, old);

    const deadRoot = join(parent, "semaframe-photo-reconstruction-dead01");
    await mkdir(deadRoot, { mode: 0o700 });
    await writeFile(join(deadRoot, ".semaframe-owner-v1.json"), JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartedAt: 1,
      lease: "x".repeat(43),
    }), { mode: 0o600 });
    await writeFile(join(deadRoot, "orphaned-input.bin"), "orphaned");
    await utimes(join(deadRoot, ".semaframe-owner-v1.json"), old, old);
    await utimes(deadRoot, old, old);

    const freshDeadRoot = join(parent, "semaframe-photo-reconstruction-dead02");
    await mkdir(freshDeadRoot, { mode: 0o700 });
    await writeFile(join(freshDeadRoot, ".semaframe-owner-v1.json"), JSON.stringify({
      version: 1,
      pid: 2_147_483_646,
      processStartedAt: 1,
      lease: "y".repeat(43),
    }), { mode: 0o600 });
    await writeFile(join(freshDeadRoot, "fresh-orphaned-input.bin"), "still-within-grace-period");
    const fresh = new Date(Date.now() - 4 * 60_000);
    await utimes(join(freshDeadRoot, ".semaframe-owner-v1.json"), fresh, fresh);
    await utimes(freshDeadRoot, fresh, fresh);

    const protectedDirectory = join(parent, "protected-not-a-reconstruction-root");
    await mkdir(protectedDirectory);
    await writeFile(join(protectedDirectory, "keep.txt"), "keep");
    const symbolicRoot = join(parent, "semaframe-photo-reconstruction-link01");
    await symlink(protectedDirectory, symbolicRoot, "dir");

    const second = await setup(new HangingBackend(), {}, parent);
    await Promise.all([
      first.service.begin(principal, reconstructionInput(photos, {
        requestId: "photo-reconstruction-live-root-2",
      })),
      second.service.begin(otherPrincipal, reconstructionInput(photos, {
        requestId: "photo-reconstruction-second-service",
      })),
    ]);

    await expect(lstat(liveRoot)).resolves.toMatchObject({});
    await expect(first.service.inspect(firstJob.job.jobId, principal.authorizationId))
      .resolves.toMatchObject({ jobId: firstJob.job.jobId });
    await expect(lstat(deadRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(freshDeadRoot)).resolves.toMatchObject({});
    expect(await readdir(freshDeadRoot)).toEqual(expect.arrayContaining([
      ".semaframe-owner-v1.json",
      "fresh-orphaned-input.bin",
    ]));
    expect((await lstat(symbolicRoot)).isSymbolicLink()).toBe(true);
    expect(await readdir(protectedDirectory)).toEqual(["keep.txt"]);
  });

  it("revokes one pairing or all pairings, including staged candidates, and closes idempotently", async () => {
    const active = await setup(new HangingBackend());
    const photos: SourcePhoto[] = [
      { id: "a", mediaType: "image/png", bytes: png(0) },
      { id: "b", mediaType: "image/png", bytes: png(1) },
    ];
    const activeBegin = await active.service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-active-revoke",
    }));
    await uploadAll(active.service, photos, activeBegin);
    await active.service.start(activeBegin.job.jobId, principal.authorizationId);
    await active.service.revokeAuthorization(principal.authorizationId);
    await expect(active.service.inspect(activeBegin.job.jobId, principal.authorizationId)).rejects.toMatchObject({
      status: 404,
      code: "photo_reconstruction_not_found",
    });

    const ready = await setup(new SuccessfulBackend());
    const firstBegin = await ready.service.begin(principal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-ready-revoke-1",
    }));
    await uploadAll(ready.service, photos, firstBegin);
    await ready.service.start(firstBegin.job.jobId, principal.authorizationId);
    const firstReady = await waitForTerminal(ready.service, firstBegin.job.jobId);

    const secondBegin = await ready.service.begin(otherPrincipal, reconstructionInput(photos, {
      requestId: "photo-reconstruction-ready-revoke-2",
    }));
    await uploadAll(ready.service, photos, secondBegin);
    await ready.service.start(secondBegin.job.jobId, otherPrincipal.authorizationId);
    const secondReady = await waitForTerminal(ready.service, secondBegin.job.jobId, otherPrincipal.authorizationId);

    await ready.service.revokeAuthorization(principal.authorizationId);
    await expect(ready.assetIngress.inspect(firstReady.result!.candidateHandle, "workspace_main"))
      .rejects.toMatchObject({ status: 404 });
    await expect(ready.assetIngress.inspect(secondReady.result!.candidateHandle, "workspace_main"))
      .resolves.toMatchObject({ status: "ready" });

    await ready.service.revokeAll();
    await expect(ready.assetIngress.inspect(secondReady.result!.candidateHandle, "workspace_main"))
      .rejects.toMatchObject({ status: 404 });
    await expect(ready.service.inspect(secondBegin.job.jobId, otherPrincipal.authorizationId))
      .rejects.toMatchObject({ status: 404 });

    await Promise.all([ready.service.close(), ready.service.close()]);
    await ready.service.close();
  });
});
