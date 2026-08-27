import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  artifactProviderDescriptorSha256V1,
  type ArtifactProviderDescriptorDocumentV1,
  type ArtifactProviderRegistrationV1,
} from "../../workspace/artifacts";
import {
  ArtifactJobService,
  ArtifactJobServiceError,
  type ArtifactJobServiceOptions,
} from "../../../server/artifacts";

async function provider(
  run: ArtifactProviderRegistrationV1["run"],
  overrides: Partial<ArtifactProviderDescriptorDocumentV1> = {},
): Promise<ArtifactProviderRegistrationV1> {
  const descriptor: ArtifactProviderDescriptorDocumentV1 = {
    schemaVersion: "1.0",
    kind: "exporter",
    providerId: "semaframe.scene.exchange",
    providerVersion: "1.0.0",
    displayName: "SemaFrame Scene Exchange",
    origin: {
      kind: "builtin",
      hostProviderId: "semaframe.host",
      hostProviderVersion: "1.0.0",
    },
    ...overrides,
  };
  return {
    descriptor: {
      ...descriptor,
      descriptorSha256: await artifactProviderDescriptorSha256V1(descriptor),
    },
    run,
  };
}

async function service(
  registration: ArtifactProviderRegistrationV1,
  options: Partial<Omit<ArtifactJobServiceOptions, "providers">> = {},
) {
  let nextId = 1;
  return ArtifactJobService.create({
    providers: [registration],
    createId: () => `job-${nextId++}`,
    ...options,
  });
}

const scope = {
  ownerId: "owner-a",
  workspaceId: "workspace-1",
  providerId: "semaframe.scene.exchange",
} as const;

describe("ArtifactJobService", () => {
  it("runs an idempotent async export and stores immutable SHA-256 addressed bytes", async () => {
    const run = vi.fn(async (_request, context) => {
      context.updateProgress({ fraction: 0.5, message: "Writing exchange" });
      return [{
        fileName: "scene.semaframe-exchange",
        mediaType: "application/vnd.semaframe.exchange+zip",
        bytes: new Uint8Array([1, 2, 3, 4]),
        metadata: { target: "portable" },
      }];
    });
    const jobs = await service(await provider(run));
    const submitted = jobs.submit({
      ...scope,
      requestId: "request-1",
      providerId: "semaframe.scene.exchange",
      input: { revision: 7 },
    });
    expect(submitted.status).toBe("queued");
    const retried = jobs.submit({
      ...scope,
      requestId: "request-1",
      providerId: "semaframe.scene.exchange",
      input: { revision: 7 },
    });
    expect(retried.jobId).toBe(submitted.jobId);

    const completed = await jobs.waitForTerminal(scope, submitted.jobId);
    const expected = `sha256:${createHash("sha256").update(new Uint8Array([1, 2, 3, 4])).digest("hex")}`;
    expect(completed).toMatchObject({
      status: "succeeded",
      progress: { fraction: 1 },
      artifacts: [{
        artifactId: expected,
        sha256: expected,
        byteLength: 4,
        fileName: "scene.semaframe-exchange",
      }],
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.artifacts)).toBe(true);

    const firstRead = jobs.readArtifact(scope, submitted.jobId, expected);
    firstRead[0] = 99;
    expect([...jobs.readArtifact(scope, submitted.jobId, expected)]).toEqual([1, 2, 3, 4]);
    jobs.discard(scope, submitted.jobId);
    expect(() => jobs.get(scope, submitted.jobId)).toThrow(expect.objectContaining({ code: "job_not_found" }));
  });

  it("hides job and artifact existence across owner or workspace boundaries", async () => {
    const jobs = await service(await provider(async () => [{
      fileName: "scene.usda",
      mediaType: "model/vnd.usda",
      bytes: new Uint8Array([35, 117, 115, 100, 97]),
    }]));
    const submitted = jobs.submit({
      ...scope,
      requestId: "request-cross-owner",
      providerId: "semaframe.scene.exchange",
      input: {},
    });
    const completed = await jobs.waitForTerminal(scope, submitted.jobId);
    const artifactId = completed.artifacts[0]!.artifactId;
    const wrongOwner = { ...scope, ownerId: "owner-b" };
    const wrongWorkspace = { ...scope, workspaceId: "workspace-2" };
    const wrongProvider = { ...scope, providerId: "other.exporter" };
    expect(() => jobs.get(wrongOwner, submitted.jobId)).toThrow(expect.objectContaining({ code: "job_not_found" }));
    expect(() => jobs.readArtifact(wrongWorkspace, submitted.jobId, artifactId))
      .toThrow(expect.objectContaining({ code: "job_not_found" }));
    expect(() => jobs.discard(wrongOwner, submitted.jobId))
      .toThrow(expect.objectContaining({ code: "job_not_found" }));
    expect(() => jobs.get(wrongProvider, submitted.jobId))
      .toThrow(expect.objectContaining({ code: "job_not_found" }));
  });

  it("rejects reuse of an idempotency key with any different request fingerprint", async () => {
    const jobs = await service(await provider(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new Uint8Array([123, 125]),
    }]));
    jobs.submit({
      ...scope,
      requestId: "same-request",
      providerId: "semaframe.scene.exchange",
      input: { revision: 1 },
    });
    expect(() => jobs.submit({
      ...scope,
      requestId: "same-request",
      providerId: "semaframe.scene.exchange",
      input: { revision: 2 },
    })).toThrow(expect.objectContaining({ code: "idempotency_mismatch" }));
  });

  it("cancels a running provider and times out a provider that ignores abort", async () => {
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const cancellable = await service(await provider(async (_request, context) => {
      announceStarted();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return [];
    }));
    const canceledJob = cancellable.submit({
      ...scope,
      requestId: "cancel-running",
      providerId: "semaframe.scene.exchange",
      input: {},
    });
    await started;
    cancellable.cancel(scope, canceledJob.jobId);
    await expect(cancellable.waitForTerminal(scope, canceledJob.jobId)).resolves.toMatchObject({
      status: "canceled",
      error: { code: "canceled" },
    });

    const hanging = await service(await provider(async () => new Promise(() => {})), { maxRuntimeMs: 20 });
    const timedJob = hanging.submit({
      ...scope,
      requestId: "timeout-running",
      providerId: "semaframe.scene.exchange",
      input: {},
    });
    await expect(hanging.waitForTerminal(scope, timedJob.jobId, 500)).resolves.toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
  });

  it("enforces the configured queue bound while a provider occupies the concurrency slot", async () => {
    const releases: Array<() => void> = [];
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const jobs = await service(await provider(async () => {
      if (releases.length === 0) announceStarted();
      await new Promise<void>((resolve) => releases.push(resolve));
      return [{
        fileName: "result.json",
        mediaType: "application/json",
        bytes: new Uint8Array([123, 125]),
      }];
    }), { maxConcurrent: 1, maxQueued: 1 });
    const first = jobs.submit({
      ...scope,
      requestId: "queue-first",
      input: {},
    });
    await started;
    const second = jobs.submit({
      ...scope,
      requestId: "queue-second",
      input: {},
    });
    expect(() => jobs.submit({
      ...scope,
      requestId: "queue-overflow",
      input: {},
    })).toThrow(expect.objectContaining({ code: "capacity_exhausted" }));
    releases.shift()?.();
    await jobs.waitForTerminal(scope, first.jobId);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await expect(jobs.waitForTerminal(scope, second.jobId)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("bounds output and redacts provider errors without exposing local paths or credentials", async () => {
    const overflowing = await service(await provider(async () => [{
      fileName: "large.bin",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array([1, 2, 3, 4]),
    }]), { maxOutputBytes: 3 });
    const overflowJob = overflowing.submit({
      ...scope,
      requestId: "overflow",
      providerId: "semaframe.scene.exchange",
      input: {},
    });
    await expect(overflowing.waitForTerminal(scope, overflowJob.jobId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "output_limit_exceeded" },
    });

    const throwing = await service(await provider(async () => {
      throw new Error(
        "Failed at /Users/alice/private/model.step with Bearer secret-value-123456 and aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc",
      );
    }));
    const failedJob = throwing.submit({
      ...scope,
      requestId: "provider-throw",
      providerId: "semaframe.scene.exchange",
      input: {},
    });
    const failed = await throwing.waitForTerminal(scope, failedJob.jobId);
    expect(failed.error).toMatchObject({ code: "provider_failed" });
    expect(failed.error?.message).toContain("[redacted-path]");
    expect(failed.error?.message).toContain("[redacted-credential]");
    expect(JSON.stringify(failed)).not.toContain("/Users/alice");
    expect(JSON.stringify(failed)).not.toContain("secret-value");
    expect(JSON.stringify(failed)).not.toContain("aaaaaaaaaaaaaaaa");
  });

  it("rejects raw secrets and local paths in requests or result metadata", async () => {
    const run = vi.fn(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new Uint8Array([123, 125]),
      metadata: { githubToken: "plain-secret-value-123" },
    }]);
    const jobs = await service(await provider(run));
    expect(() => jobs.submit({
      ...scope,
      requestId: "raw-secret",
      providerId: "semaframe.scene.exchange",
      input: { apiKey: "sk-live-super-secret" },
    })).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => jobs.submit({
      ...scope,
      requestId: "normalized-secret-key",
      providerId: "semaframe.scene.exchange",
      input: { openaiApiKey: "plain-secret-value-123" },
    })).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => jobs.submit({
      ...scope,
      requestId: "raw-path",
      providerId: "semaframe.scene.exchange",
      input: { source: "/Users/alice/model.blend" },
    })).toThrow(expect.objectContaining({ code: "invalid_request" }));

    const metadataJob = jobs.submit({
      ...scope,
      requestId: "metadata-path",
      providerId: "semaframe.scene.exchange",
      input: {},
    });
    await expect(jobs.waitForTerminal(scope, metadataJob.jobId)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "invalid_provider_output",
        message: "Artifact metadata contains a raw credential or local path.",
      },
    });
  });

  it("charges canonical metadata bytes against the configured output limit", async () => {
    const jobs = await service(await provider(async () => [{
      fileName: "result.bin",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array([1]),
      metadata: { description: "metadata cannot bypass the byte budget" },
    }]), { maxOutputBytes: 16 });
    const submitted = jobs.submit({
      ...scope,
      requestId: "metadata-output-limit",
      input: {},
    });
    await expect(jobs.waitForTerminal(scope, submitted.jobId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "output_limit_exceeded" },
    });
  });

  it("authorizes extension providers with a scoped grant before invocation", async () => {
    const run = vi.fn(async () => [{
      fileName: "workspace.json",
      mediaType: "application/json",
      bytes: new Uint8Array([123, 125]),
    }]);
    const extension = await provider(run, {
      providerId: "example.extension.exporter",
      displayName: "Example exporter",
      origin: {
        kind: "extension",
        extensionId: "example.extension",
        extensionVersion: "1.0.0",
        manifestSha256: `sha256:${"c".repeat(64)}`,
        requiredPermission: "exporter:execute",
      },
    });
    const authorizeExtension = vi.fn();
    const jobs = await service(extension, { authorizeExtension });
    expect(() => jobs.submit({
      ...scope,
      requestId: "missing-grant",
      providerId: "example.extension.exporter",
      input: {},
    })).toThrow(expect.objectContaining({ code: "permission_required" }));
    const submitted = jobs.submit({
      ownerId: scope.ownerId,
      workspaceId: scope.workspaceId,
      requestId: "with-grant",
      providerId: "example.extension.exporter",
      input: {},
    }, { grantToken: "opaque-host-grant-token" });
    const extensionScope = { ...scope, providerId: "example.extension.exporter" };
    await jobs.waitForTerminal(extensionScope, submitted.jobId);
    expect(authorizeExtension).toHaveBeenCalledWith(expect.objectContaining({
      grantToken: "opaque-host-grant-token",
      ownerId: "owner-a",
      workspaceId: "workspace-1",
      extensionId: "example.extension",
      providerId: "example.extension.exporter",
      permission: "exporter:execute",
    }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(jobs.get(extensionScope, submitted.jobId))).not.toContain("opaque-host-grant-token");
  });

  it("rejects provider digest tampering and duplicate registrations before accepting jobs", async () => {
    const valid = await provider(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new Uint8Array([123, 125]),
    }]);
    await expect(ArtifactJobService.create({
      providers: [{
        ...valid,
        descriptor: { ...valid.descriptor, descriptorSha256: `sha256:${"f".repeat(64)}` },
      }],
    })).rejects.toMatchObject({ code: "provider_digest_mismatch" });
    await expect(ArtifactJobService.create({ providers: [valid, valid] }))
      .rejects.toMatchObject({ code: "provider_collision" });
    expect(Object.isFrozen(valid.descriptor)).toBe(false);
  });

  it("expires terminal jobs and releases their content-addressed results", async () => {
    let now = 1_000;
    const jobs = await service(await provider(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new Uint8Array([123, 125]),
    }]), { now: () => now, ttlMs: 100 });
    const submitted = jobs.submit({
      ...scope,
      requestId: "expires",
      providerId: "semaframe.scene.exchange",
      input: {},
    });
    const completed = await jobs.waitForTerminal(scope, submitted.jobId);
    now = 1_100;
    expect(() => jobs.get(scope, completed.jobId)).toThrow(expect.objectContaining({ code: "job_not_found" }));
  });

  it("uses not-found errors instead of exposing authorization distinctions", async () => {
    const jobs = await service(await provider(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new Uint8Array([123, 125]),
    }]));
    expect(() => jobs.get(scope, "missing-job")).toThrow(ArtifactJobServiceError);
    expect(() => jobs.get(scope, "missing-job")).toThrow(expect.objectContaining({ code: "job_not_found" }));
  });
});
