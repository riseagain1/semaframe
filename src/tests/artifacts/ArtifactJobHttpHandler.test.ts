import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  artifactProviderDescriptorSha256V1,
  type ArtifactProviderDescriptorDocumentV1,
  type ArtifactProviderRegistrationV1,
} from "../../workspace/artifacts";
import {
  ARTIFACT_JOB_HTTP_PREFIX,
  ArtifactJobService,
  createArtifactJobHttpHandler,
  type ArtifactJobHttpContext,
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

const context: ArtifactJobHttpContext = {
  ownerId: "owner-a",
  workspaceId: "workspace-1",
};

const providerId = "semaframe.scene.exchange";

function submitRequest(
  requestId: string,
  input: unknown = { revision: 7 },
  extraBody: Record<string, unknown> = {},
  headers: HeadersInit = {},
): Request {
  return new Request(`http://localhost${ARTIFACT_JOB_HTTP_PREFIX}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify({ requestId, providerId, input, ...extraBody }),
  });
}

function jobUrl(jobId: string, suffix = ""): string {
  return `http://localhost${ARTIFACT_JOB_HTTP_PREFIX}/${providerId}/${jobId}${suffix}`;
}

describe("ArtifactJobHttpHandler", () => {
  it("submits, waits, inspects, downloads verified binary bytes, and discards a job", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const jobs = await service(await provider(async (_request, operation) => {
      operation.updateProgress({ fraction: 0.5, message: "Writing exchange" });
      return [{
        fileName: "scene.semaframe-exchange",
        mediaType: "application/vnd.semaframe.exchange+zip",
        bytes,
      }];
    }));
    const handle = createArtifactJobHttpHandler(jobs, { maxWaitMs: 1_000 });

    const submitted = await handle(submitRequest("http-happy"), context);
    expect(submitted?.status).toBe(202);
    expect(submitted?.headers.get("location")).toBe(`${ARTIFACT_JOB_HTTP_PREFIX}/${providerId}/job-1`);
    expect(await submitted?.json()).toMatchObject({ ok: true, data: { jobId: "job-1", status: "queued" } });

    const waited = await handle(new Request(jobUrl("job-1", "/wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ waitMs: 1_000 }),
    }), context);
    expect(waited?.status).toBe(200);
    const completed = await waited?.json() as {
      data: { artifacts: Array<{ artifactId: string; sha256: string }> };
    };
    const expectedSha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect(completed.data.artifacts[0]).toMatchObject({ artifactId: expectedSha, sha256: expectedSha });

    const inspected = await handle(new Request(jobUrl("job-1")), context);
    expect(inspected?.status).toBe(200);
    expect(await inspected?.json()).toMatchObject({ ok: true, data: { status: "succeeded" } });

    const downloaded = await handle(new Request(jobUrl("job-1", `/artifacts/${expectedSha}`)), context);
    expect(downloaded?.status).toBe(200);
    expect(downloaded?.headers.get("content-type")).toBe("application/vnd.semaframe.exchange+zip");
    expect(downloaded?.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(downloaded?.headers.get("content-digest")).toBe(
      `sha-256=:${Buffer.from(expectedSha.slice("sha256:".length), "hex").toString("base64")}:`,
    );
    expect(downloaded?.headers.get("x-semaframe-content-sha256")).toBe(expectedSha);
    expect(downloaded?.headers.get("etag")).toBe(`"${expectedSha}"`);
    expect([...new Uint8Array(await downloaded!.arrayBuffer())]).toEqual([...bytes]);

    const discarded = await handle(new Request(jobUrl("job-1"), { method: "DELETE" }), context);
    expect(discarded?.status).toBe(204);
    expect((await handle(new Request(jobUrl("job-1")), context))?.status).toBe(404);
  });

  it("hides jobs and artifact existence across owner, workspace, and provider scopes", async () => {
    const jobs = await service(await provider(async () => [{
      fileName: "scene.usda",
      mediaType: "model/vnd.usda",
      bytes: new Uint8Array([35, 117, 115, 100, 97]),
    }]));
    const handle = createArtifactJobHttpHandler(jobs, { maxWaitMs: 1_000 });
    await handle(submitRequest("http-isolation"), context);
    const completed = await handle(new Request(jobUrl("job-1", "/wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), context);
    const completedBody = await completed?.json() as { data: { artifacts: Array<{ artifactId: string }> } };
    const artifactId = completedBody.data.artifacts[0]!.artifactId;

    const wrongOwner = { ...context, ownerId: "owner-b" };
    const wrongWorkspace = { ...context, workspaceId: "workspace-2" };
    const providerNarrowed = { ...context, providerId: "another.exporter" };
    for (const deniedContext of [wrongOwner, wrongWorkspace, providerNarrowed]) {
      const response = await handle(new Request(jobUrl("job-1")), deniedContext);
      expect(response?.status).toBe(404);
      expect(JSON.stringify(await response?.json())).not.toContain("owner-a");
    }
    const deniedArtifact = await handle(
      new Request(jobUrl("job-1", `/artifacts/${artifactId}`)),
      wrongOwner,
    );
    expect(deniedArtifact?.status).toBe(404);
  });

  it("preserves request-id idempotency and reports conflicting reuse", async () => {
    const run = vi.fn(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new TextEncoder().encode("{}"),
    }]);
    const jobs = await service(await provider(run));
    const handle = createArtifactJobHttpHandler(jobs);
    const first = await handle(submitRequest("http-idempotent", { revision: 1 }), context);
    const second = await handle(submitRequest("http-idempotent", { revision: 1 }), context);
    expect((await first?.json() as { data: { jobId: string } }).data.jobId).toBe("job-1");
    expect((await second?.json() as { data: { jobId: string } }).data.jobId).toBe("job-1");

    const conflicting = await handle(submitRequest("http-idempotent", { revision: 2 }), context);
    expect(conflicting?.status).toBe(409);
    expect(await conflicting?.json()).toMatchObject({ error: { code: "idempotency_mismatch" } });
    await jobs.waitForTerminal({ ...context, providerId }, "job-1");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels a running job and exposes the terminal cancellation through wait", async () => {
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const jobs = await service(await provider(async (_request, operation) => {
      announceStarted();
      await new Promise<void>((_resolve, reject) => {
        operation.signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
      });
      return [];
    }));
    const handle = createArtifactJobHttpHandler(jobs, { maxWaitMs: 1_000 });
    await handle(submitRequest("http-cancel"), context);
    await started;

    const canceled = await handle(new Request(jobUrl("job-1", "/cancel"), { method: "POST" }), context);
    expect([200, 202]).toContain(canceled?.status);
    const waited = await handle(new Request(jobUrl("job-1", "/wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ waitMs: 1_000 }),
    }), context);
    expect(waited?.status).toBe(200);
    expect(await waited?.json()).toMatchObject({
      ok: true,
      data: { status: "canceled", error: { code: "canceled" } },
    });
  });

  it("passes an outer extension grant without reflecting it in HTTP responses", async () => {
    const authorizeExtension = vi.fn(async () => undefined);
    const extensionOrigin = {
      kind: "extension",
      extensionId: "example.exporter",
      extensionVersion: "1.0.0",
      manifestSha256: `sha256:${"a".repeat(64)}` as const,
      requiredPermission: "exporter:execute",
    } as const;
    const jobs = await service(await provider(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new TextEncoder().encode("{}"),
    }], { origin: extensionOrigin }), { authorizeExtension });
    const handle = createArtifactJobHttpHandler(jobs, { maxWaitMs: 1_000 });
    const grant = "extension-grant-value-123456789";
    const scopedContext = { ...context, providerId, extensionGrantToken: grant };
    const submitted = await handle(submitRequest("http-extension"), scopedContext);
    expect(JSON.stringify(await submitted?.json())).not.toContain(grant);
    const waited = await handle(new Request(jobUrl("job-1", "/wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), scopedContext);
    expect(waited?.status).toBe(200);
    expect(JSON.stringify(await waited?.json())).not.toContain(grant);
    expect(authorizeExtension).toHaveBeenCalledWith(expect.objectContaining({
      grantToken: grant,
      ownerId: context.ownerId,
      workspaceId: context.workspaceId,
      providerId,
    }));
  });

  it("rejects malformed, oversized, compressed, and over-deep metadata bodies", async () => {
    const jobs = await service(await provider(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new TextEncoder().encode("{}"),
    }]));
    const handle = createArtifactJobHttpHandler(jobs, { maxJsonBodyBytes: 256 });

    const wrongType = await handle(new Request(`http://localhost${ARTIFACT_JOB_HTTP_PREFIX}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }), context);
    expect(wrongType?.status).toBe(415);

    const malformed = await handle(new Request(`http://localhost${ARTIFACT_JOB_HTTP_PREFIX}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }), context);
    expect(malformed?.status).toBe(400);

    const unknownField = await handle(submitRequest("http-unknown", {}, { ownerId: "injected" }), context);
    expect(unknownField?.status).toBe(400);

    const compressed = await handle(submitRequest("http-compressed", {}, {}, { "content-encoding": "gzip" }), context);
    expect(compressed?.status).toBe(415);

    const declaredOversize = await handle(submitRequest("http-large", {}, {}, { "content-length": "257" }), context);
    expect(declaredOversize?.status).toBe(413);

    let deep: unknown = null;
    for (let index = 0; index < 66; index += 1) deep = [deep];
    const deepHandler = createArtifactJobHttpHandler(jobs, { maxJsonBodyBytes: 4_096 });
    const overDeep = await deepHandler(submitRequest("http-deep", deep), context);
    expect(overDeep?.status).toBe(400);
    expect(await overDeep?.json()).toMatchObject({ error: { code: "invalid_request" } });

    const stringWait = await handle(new Request(jobUrl("missing-job", "/wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ waitMs: "10" }),
    }), context);
    expect(stringWait?.status).toBe(400);
  });

  it("uses strict paths and methods and returns undefined outside its route", async () => {
    const jobs = await service(await provider(async () => [{
      fileName: "result.json",
      mediaType: "application/json",
      bytes: new TextEncoder().encode("{}"),
    }]));
    const handle = createArtifactJobHttpHandler(jobs);
    expect(await handle(new Request("http://localhost/api/agent/elsewhere"), context)).toBeUndefined();
    const baseGet = await handle(new Request(`http://localhost${ARTIFACT_JOB_HTTP_PREFIX}`), context);
    expect(baseGet?.status).toBe(405);
    expect(baseGet?.headers.get("allow")).toBe("POST");
    const query = await handle(submitRequest("http-query"), context);
    expect(query?.status).toBe(202);
    const queried = await handle(new Request(`${jobUrl("job-1")}?provider=other`), context);
    expect(queried?.status).toBe(400);
    const badArtifact = await handle(new Request(jobUrl("job-1", "/artifacts/not-a-digest")), context);
    expect(badArtifact?.status).toBe(404);
  });
});
