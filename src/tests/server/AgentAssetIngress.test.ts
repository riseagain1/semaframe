import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentAssetIngress,
  AgentAssetIngressError,
  type BeginAgentAssetImportInput,
} from "../../../server/agent/AgentAssetIngress";

const PUBLIC_URL = "http://127.0.0.1:8788";
const principal = {
  authorizationId: "approved-claim-asset-import-01",
  clientId: "agent-reality-test",
  clientName: "Reality Test Agent",
};

const managers: AgentAssetIngress[] = [];
const temporaryParents: string[] = [];

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function body(bytes: Uint8Array, splitAt = bytes.byteLength): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes.slice(0, splitAt);
      if (splitAt < bytes.byteLength) yield bytes.slice(splitAt);
    },
  };
}

async function setup(overrides: {
  maxBytes?: number;
  maxStagedBytes?: number;
  maxPendingGrants?: number;
  maxConcurrentUploads?: number;
  grantTtlMs?: number;
  candidateTtlMs?: number;
  now?: () => number;
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), "semaframe-asset-ingress-test-"));
  temporaryParents.push(parent);
  const manager = new AgentAssetIngress({
    publicBaseUrl: PUBLIC_URL,
    temporaryDirectory: parent,
    sweepIntervalMs: 0,
    ...overrides,
  });
  managers.push(manager);
  return { manager, parent };
}

function input(bytes: Uint8Array, overrides: Partial<BeginAgentAssetImportInput> = {}): BeginAgentAssetImportInput {
  return {
    requestId: "asset-request-0001",
    workspaceId: "workspace_main",
    displayName: "pole-scan.spz",
    format: "spz",
    mediaType: "model/spz",
    byteLength: bytes.byteLength,
    sha256: digest(bytes),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.allSettled(temporaryParents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
});

describe("AgentAssetIngress", () => {
  it("streams an exact digest-bound asset through a one-time opaque browser handoff", async () => {
    const { manager, parent } = await setup();
    const bytes = new TextEncoder().encode("SPZ reality bytes\u0000with binary-safe content");
    const grant = await manager.begin(principal, input(bytes));

    expect(grant).toEqual(expect.objectContaining({
      candidateHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      status: "awaiting_upload",
      upload: expect.objectContaining({
        method: "PUT",
        authorization: "Bearer",
        contentLength: bytes.byteLength,
        contentType: "model/spz",
      }),
    }));
    expect(grant.upload?.url).toMatch(/^http:\/\/127\.0\.0\.1:8788\/v1\/assets\/uploads\/[0-9a-f-]{36}$/u);
    expect(grant.upload?.url).not.toContain("pole-scan");

    const uploaded = await manager.upload(
      grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1),
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes, 7),
    );
    expect(uploaded).toMatchObject({ status: "ready", sha256: digest(bytes) });
    await expect(manager.inspect(grant.candidateHandle, "other_workspace")).rejects.toMatchObject({
      status: 404,
      code: "asset_candidate_not_found",
    });

    const opened = await manager.open(grant.candidateHandle, "workspace_main");
    expect(Array.from(new Uint8Array(await new Response(opened.body).arrayBuffer()))).toEqual(Array.from(bytes));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(manager.complete(grant.candidateHandle, "workspace_main")).resolves.toEqual({ completed: true });
    await expect(manager.complete(grant.candidateHandle, "workspace_main")).resolves.toEqual({ completed: true });
    await expect(manager.inspect(grant.candidateHandle, "workspace_main")).rejects.toMatchObject({ status: 404 });
    await expect(manager.begin(principal, input(bytes))).rejects.toMatchObject({
      status: 409,
      code: "asset_import_already_completed",
    });

    await manager.close();
    expect(await readdir(parent)).toEqual([]);
  });

  it("makes begin and completed PUT retries idempotent while rejecting request-id drift", async () => {
    const { manager } = await setup();
    const bytes = new TextEncoder().encode("idempotent upload");
    const first = await manager.begin(principal, input(bytes));
    const retry = await manager.begin(principal, input(bytes));
    expect(retry).toEqual(first);

    await expect(manager.begin(principal, input(bytes, { displayName: "different.spz" }))).rejects.toMatchObject({
      status: 409,
      code: "asset_import_idempotency_conflict",
    });

    const grantId = first.upload!.url.slice(first.upload!.url.lastIndexOf("/") + 1);
    const uploaded = await manager.upload(
      grantId,
      first.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes),
    );
    const replay = await manager.upload(
      grantId,
      first.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(new Uint8Array(bytes.byteLength).fill(255)),
    );
    expect(replay).toEqual(uploaded);
    expect((await manager.begin(principal, input(bytes))).upload).toBeUndefined();
  });

  it("fails closed on token, content type, size, and digest mismatches and permits a corrected retry", async () => {
    const { manager } = await setup({ maxBytes: 64 });
    const bytes = new TextEncoder().encode("correct bytes");
    const grant = await manager.begin(principal, input(bytes));
    const grantId = grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1);

    await expect(manager.upload(grantId, "wrong", "model/spz", bytes.byteLength, body(bytes))).rejects.toMatchObject({
      status: 401,
      code: "asset_upload_unauthorized",
    });
    await expect(manager.upload(grantId, grant.upload!.token, "application/zip", bytes.byteLength, body(bytes))).rejects.toMatchObject({
      status: 415,
      code: "asset_media_type_mismatch",
    });
    await expect(manager.upload(grantId, grant.upload!.token, "model/spz", bytes.byteLength + 1, body(bytes))).rejects.toMatchObject({
      status: 400,
      code: "asset_length_header_mismatch",
    });
    await expect(manager.upload(
      grantId,
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(new Uint8Array(bytes.byteLength).fill(1)),
    )).rejects.toMatchObject({ status: 422, code: "asset_digest_mismatch" });

    await expect(manager.upload(
      grantId,
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes),
    )).resolves.toMatchObject({ status: "ready" });

    await expect(manager.begin(principal, input(new Uint8Array(65), {
      requestId: "asset-request-too-large",
      byteLength: 65,
      sha256: digest(new Uint8Array(65)),
    }))).rejects.toMatchObject({ status: 413, code: "asset_too_large" });
  });

  it("rejects path and URL labels and removes cancelled or expired capabilities", async () => {
    let now = 1_000;
    const { manager } = await setup({ grantTtlMs: 50, candidateTtlMs: 50, now: () => now });
    const bytes = new Uint8Array([1, 2, 3, 4]);

    for (const displayName of ["../secret.spz", "/tmp/secret.spz", "https:scan.example/pole.spz"] ) {
      await expect(manager.begin(principal, input(bytes, {
        requestId: `asset-label-${displayName.length}`,
        displayName,
      }))).rejects.toBeInstanceOf(AgentAssetIngressError);
    }

    const cancelled = await manager.begin(principal, input(bytes, { requestId: "asset-request-cancel" }));
    await manager.cancelFromAgent(cancelled.candidateHandle, principal.authorizationId);
    await expect(manager.inspect(cancelled.candidateHandle, "workspace_main")).rejects.toMatchObject({ status: 404 });

    const expired = await manager.begin(principal, input(bytes, { requestId: "asset-request-expiry" }));
    now += 51;
    await manager.sweepExpired();
    await expect(manager.inspect(expired.candidateHandle, "workspace_main")).rejects.toMatchObject({ status: 404 });

    const revoked = await manager.begin(principal, input(bytes, { requestId: "asset-request-revoked" }));
    await expect(manager.revokeAuthorization(principal.authorizationId)).resolves.toEqual({ revoked: 1 });
    await expect(manager.inspect(revoked.candidateHandle, "workspace_main")).rejects.toMatchObject({ status: 404 });
  });

  it("terminates an in-flight upload when its candidate is cancelled", async () => {
    const { manager } = await setup();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const grant = await manager.begin(principal, input(bytes, { requestId: "asset-request-inflight-cancel" }));
    const grantId = grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1);
    let continueUpload!: () => void;
    let firstChunkSent!: () => void;
    const firstChunk = new Promise<void>((resolve) => { firstChunkSent = resolve; });
    const continuePromise = new Promise<void>((resolve) => { continueUpload = resolve; });
    const streamingBody: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield bytes.slice(0, 4);
        firstChunkSent();
        await continuePromise;
        yield bytes.slice(4);
      },
    };
    const uploading = manager.upload(
      grantId,
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      streamingBody,
    );
    await firstChunk;
    await manager.cancelFromAgent(grant.candidateHandle, principal.authorizationId);
    await expect(uploading).rejects.toMatchObject({ code: "asset_upload_cancelled" });
    continueUpload();
    await expect(manager.inspect(grant.candidateHandle, "workspace_main")).rejects.toMatchObject({ status: 404 });
  });

  it("aborts active uploads and removes its private temp root during shutdown", async () => {
    const { manager, parent } = await setup();
    const bytes = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
    const grant = await manager.begin(principal, input(bytes, { requestId: "asset-request-shutdown-clean" }));
    const grantId = grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1);
    let continueUpload!: () => void;
    let firstChunkSent!: () => void;
    const firstChunk = new Promise<void>((resolve) => { firstChunkSent = resolve; });
    const continuePromise = new Promise<void>((resolve) => { continueUpload = resolve; });
    const uploading = manager.upload(
      grantId,
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      {
        async *[Symbol.asyncIterator]() {
          yield bytes.slice(0, 4);
          firstChunkSent();
          await continuePromise;
          yield bytes.slice(4);
        },
      },
    );
    await firstChunk;
    const closing = manager.close();
    await expect(uploading).rejects.toMatchObject({ code: "asset_upload_cancelled" });
    await closing;
    continueUpload();
    expect(await readdir(parent)).toEqual([]);
  });

  it("bounds pending reservations and concurrent uploads before they can exhaust local storage", async () => {
    const { manager } = await setup({
      maxBytes: 16,
      maxStagedBytes: 16,
      maxPendingGrants: 2,
      maxConcurrentUploads: 1,
    });
    const firstBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const secondBytes = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);
    const first = await manager.begin(principal, input(firstBytes, { requestId: "asset-capacity-first" }));
    const second = await manager.begin(principal, input(secondBytes, { requestId: "asset-capacity-second", sha256: digest(secondBytes) }));
    await expect(manager.begin(principal, input(new Uint8Array([1]), {
      requestId: "asset-capacity-third",
      byteLength: 1,
      sha256: digest(new Uint8Array([1])),
    }))).rejects.toMatchObject({ status: 429, code: "asset_ingress_busy" });

    let continueFirst!: () => void;
    let firstChunkSent!: () => void;
    const firstChunk = new Promise<void>((resolve) => { firstChunkSent = resolve; });
    const continuePromise = new Promise<void>((resolve) => { continueFirst = resolve; });
    const firstUpload = manager.upload(
      first.upload!.url.slice(first.upload!.url.lastIndexOf("/") + 1),
      first.upload!.token,
      "model/spz",
      firstBytes.byteLength,
      {
        async *[Symbol.asyncIterator]() {
          yield firstBytes.slice(0, 4);
          firstChunkSent();
          await continuePromise;
          yield firstBytes.slice(4);
        },
      },
    );
    await firstChunk;
    await expect(manager.upload(
      second.upload!.url.slice(second.upload!.url.lastIndexOf("/") + 1),
      second.upload!.token,
      "model/spz",
      secondBytes.byteLength,
      body(secondBytes),
    )).rejects.toMatchObject({ status: 429, code: "asset_ingress_busy" });
    continueFirst();
    await expect(firstUpload).resolves.toMatchObject({ status: "ready" });
  });
});
