import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentAssetIngress,
  AgentAssetIngressError,
  DEFAULT_AGENT_ASSET_MINIMUM_FREE_RESERVE_BYTES,
  MAX_AGENT_ASSET_RESERVATION_TTL_MS,
  toAgentAssetImportGrantWire,
  type BeginAgentAssetImportInput,
  type AgentAssetIngressOptions,
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
  removeFile?: AgentAssetIngressOptions["removeFile"];
  removeDirectory?: AgentAssetIngressOptions["removeDirectory"];
  isProcessAlive?: AgentAssetIngressOptions["isProcessAlive"];
  availableTemporaryBytes?: AgentAssetIngressOptions["availableTemporaryBytes"];
  minimumFreeBytesAfterUpload?: AgentAssetIngressOptions["minimumFreeBytesAfterUpload"];
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

  it("reserves the complete pending staging copy and rechecks free space for every chunk", async () => {
    let capacityChecks = 0;
    let depleted = true;
    const { manager } = await setup({
      minimumFreeBytesAfterUpload: 0,
      availableTemporaryBytes: async () => {
        capacityChecks += 1;
        if (!depleted) return 1_024n;
        return capacityChecks === 1 ? 64n : 15n;
      },
    });
    const bytes = new TextEncoder().encode("sixteen-byte-ply");
    expect(bytes.byteLength).toBe(16);
    const grant = await manager.begin(principal, input(bytes, {
      requestId: "asset-storage-reserve-0001",
      format: "ply",
      mediaType: "application/ply",
    }));
    const grantId = grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1);

    await expect(manager.upload(
      grantId,
      grant.upload!.token,
      "application/ply",
      bytes.byteLength,
      body(bytes, 8),
      undefined,
      { minimumFreeBytesAfterWrite: 8 },
    )).rejects.toMatchObject({ status: 507, code: "asset_upload_storage_exhausted" });
    expect(capacityChecks).toBe(2);
    await expect(manager.inspect(grant.candidateHandle, "workspace_main"))
      .rejects.toMatchObject({ code: "asset_candidate_not_ready" });

    depleted = false;
    await expect(manager.upload(
      grantId,
      grant.upload!.token,
      "application/ply",
      bytes.byteLength,
      body(bytes, 8),
      undefined,
      { minimumFreeBytesAfterWrite: 8 },
    )).resolves.toMatchObject({ status: "ready" });
  });

  it("applies the 512 MiB reserve to ordinary staging uploads by default", async () => {
    const bytes = new TextEncoder().encode("default reserve");
    const { manager } = await setup({
      availableTemporaryBytes: async () => BigInt(
        DEFAULT_AGENT_ASSET_MINIMUM_FREE_RESERVE_BYTES + bytes.byteLength - 1,
      ),
    });
    const grant = await manager.begin(principal, input(bytes, {
      requestId: "asset-default-storage-reserve",
    }));

    await expect(manager.upload(
      grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1),
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes),
    )).rejects.toMatchObject({ status: 507, code: "asset_upload_storage_exhausted" });
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

  it("relabels only an owned ready candidate while preserving import idempotency", async () => {
    const { manager } = await setup();
    const bytes = new TextEncoder().encode("relabelled reconstruction candidate");
    const source = input(bytes, { requestId: "asset-request-relabel" });
    const grant = await manager.begin(principal, source);

    await expect(manager.relabelCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      source.workspaceId,
      "Room reconstruction.ply",
    )).rejects.toMatchObject({ status: 409, code: "asset_candidate_not_ready" });

    await manager.upload(
      grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1),
      grant.upload!.token,
      source.mediaType,
      bytes.byteLength,
      body(bytes),
    );
    await expect(manager.relabelCandidate(
      grant.candidateHandle,
      "another-authorization",
      source.workspaceId,
      "Room reconstruction.ply",
    )).rejects.toMatchObject({ status: 404, code: "asset_candidate_not_found" });
    await expect(manager.relabelCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      "another_workspace",
      "Room reconstruction.ply",
    )).rejects.toMatchObject({ status: 404, code: "asset_candidate_not_found" });
    await expect(manager.relabelCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      source.workspaceId,
      "../unsafe.ply",
    )).rejects.toMatchObject({ status: 400, code: "invalid_request" });

    await expect(manager.relabelCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      source.workspaceId,
      "  Room reconstruction.ply  ",
    )).resolves.toBeUndefined();
    await expect(manager.relabelCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      source.workspaceId,
      "Room reconstruction.ply",
    )).resolves.toBeUndefined();
    await expect(manager.inspect(grant.candidateHandle, source.workspaceId))
      .resolves.toMatchObject({ displayName: "Room reconstruction.ply" });

    await manager.complete(grant.candidateHandle, source.workspaceId);
    await expect(manager.relabelCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      source.workspaceId,
      "Room reconstruction.ply",
    )).resolves.toBeUndefined();
    await expect(manager.relabelCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      source.workspaceId,
      "Different label.ply",
    )).rejects.toMatchObject({ status: 409, code: "asset_candidate_already_completed" });
    await expect(manager.begin(principal, source)).rejects.toMatchObject({
      status: 409,
      code: "asset_import_already_completed",
    });
  });

  it("defaults generic purpose, preserves explicit reconstruction purpose, and binds it to idempotency", async () => {
    const { manager } = await setup();
    const bytes = new TextEncoder().encode("purpose-bound candidate");
    const generic = await manager.begin(principal, input(bytes, { requestId: "asset-purpose-generic" }));
    expect(generic.purpose).toBe("generic_import");
    expect(toAgentAssetImportGrantWire(generic)).toMatchObject({ purpose: "generic_import" });

    const reconstructionInput = input(bytes, {
      requestId: "asset-purpose-reconstruction",
      purpose: "photo_reconstruction",
    });
    const reconstruction = await manager.begin(principal, reconstructionInput);
    expect(reconstruction.purpose).toBe("photo_reconstruction");
    await expect(manager.begin(principal, reconstructionInput)).resolves.toEqual(reconstruction);
    await expect(manager.begin(principal, {
      ...reconstructionInput,
      purpose: "generic_import",
    })).rejects.toMatchObject({
      status: 409,
      code: "asset_import_idempotency_conflict",
    });
  });

  it("renews only owner-ready or owner-completed candidates without shortening their lease", async () => {
    let now = 1_000;
    const { manager } = await setup({ candidateTtlMs: 100, now: () => now });
    const bytes = new TextEncoder().encode("reserved reconstruction output");
    const reconstructionInput = input(bytes, {
      requestId: "asset-reservation-owner",
      purpose: "photo_reconstruction",
    });
    const grant = await manager.begin(principal, reconstructionInput);

    await expect(manager.reserveCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      "workspace_main",
      500,
    )).rejects.toMatchObject({ status: 409, code: "asset_candidate_not_ready" });
    await manager.upload(
      grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1),
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes),
    );

    const ready = await manager.reserveCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      "workspace_main",
      500,
    );
    expect(ready).toEqual({
      candidateHandle: grant.candidateHandle,
      status: "ready",
      expiresAt: new Date(1_500).toISOString(),
    });
    now = 1_200;
    await expect(manager.reserveCandidate(
      grant.candidateHandle,
      "different-authorization",
      "workspace_main",
      500,
    )).rejects.toMatchObject({ status: 404, code: "asset_candidate_not_found" });
    await expect(manager.reserveCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      "different_workspace",
      500,
    )).rejects.toMatchObject({ status: 404, code: "asset_candidate_not_found" });
    await expect(manager.reserveCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      "workspace_main",
      MAX_AGENT_ASSET_RESERVATION_TTL_MS + 1,
    )).rejects.toMatchObject({ status: 400, code: "asset_reservation_ttl_invalid" });

    // A smaller request preserves the actual 1500 expiry instead of
    // shortening the existing reservation.
    await expect(manager.reserveCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      "workspace_main",
      100,
    )).resolves.toMatchObject({ status: "ready", expiresAt: new Date(1_500).toISOString() });
    await manager.complete(grant.candidateHandle, "workspace_main");
    await expect(manager.revokeAllExceptAuthorization(principal.authorizationId))
      .resolves.toEqual({ revoked: 0 });
    const completed = await manager.reserveCandidate(
      grant.candidateHandle,
      principal.authorizationId,
      "workspace_main",
      1_000,
    );
    expect(completed).toEqual({
      candidateHandle: grant.candidateHandle,
      status: "completed",
      expiresAt: new Date(2_200).toISOString(),
    });
    await expect(manager.begin(principal, reconstructionInput))
      .rejects.toMatchObject({ status: 409, code: "asset_import_already_completed" });
    await expect(manager.begin(principal, { ...reconstructionInput, purpose: "generic_import" }))
      .rejects.toMatchObject({ status: 409, code: "asset_import_idempotency_conflict" });
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

  it("keeps a failed unlink tracked and lets the same cancellation retry finish cleanup", async () => {
    let failOnce = true;
    const removed: string[] = [];
    const { manager } = await setup({
      removeFile: async (path) => {
        removed.push(path);
        if (path.endsWith(".asset") && failOnce) {
          failOnce = false;
          throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
        }
        await unlink(path);
      },
    });
    const bytes = new TextEncoder().encode("retryable cleanup bytes");
    const grant = await manager.begin(principal, input(bytes, { requestId: "asset-cleanup-retry" }));
    await manager.upload(
      grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1),
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes),
    );

    await expect(manager.cancelFromBrowser(grant.candidateHandle, "workspace_main"))
      .rejects.toMatchObject({ status: 500, code: "asset_cleanup_failed" });
    // The capability is cancelled, but its tracking survives so an identical
    // cleanup request can retry the failed unlink.
    await expect(manager.cancelFromBrowser(grant.candidateHandle, "workspace_main"))
      .resolves.toEqual({ cancelled: true });
    expect(removed.filter((path) => path.endsWith(".asset"))).toHaveLength(2);
    await expect(manager.inspect(grant.candidateHandle, "workspace_main"))
      .rejects.toMatchObject({ status: 404, code: "asset_candidate_not_found" });
  });

  it("revokes external candidates while preserving the retained browser authorization", async () => {
    const { manager } = await setup();
    const retainedPrincipal = { ...principal, authorizationId: "browser-retained-authorization" };
    const externalPrincipal = { ...principal, authorizationId: "external-revoked-authorization" };
    const retainedBytes = new TextEncoder().encode("retained browser reconstruction");
    const externalBytes = new TextEncoder().encode("revoked external reconstruction");
    const retained = await manager.begin(retainedPrincipal, input(retainedBytes, {
      requestId: "asset-request-retained",
    }));
    const external = await manager.begin(externalPrincipal, input(externalBytes, {
      requestId: "asset-request-external",
    }));
    await manager.upload(
      retained.upload!.url.slice(retained.upload!.url.lastIndexOf("/") + 1),
      retained.upload!.token,
      "model/spz",
      retainedBytes.byteLength,
      body(retainedBytes),
    );

    await expect(manager.revokeAllExceptAuthorization(retainedPrincipal.authorizationId))
      .resolves.toEqual({ revoked: 1 });
    await expect(manager.inspect(retained.candidateHandle, "workspace_main"))
      .resolves.toMatchObject({ candidateHandle: retained.candidateHandle });
    await expect(manager.inspect(external.candidateHandle, "workspace_main"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("keeps two live ingress roots isolated in one temporary parent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "semaframe-asset-ingress-shared-"));
    temporaryParents.push(parent);
    const firstManager = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: parent,
      sweepIntervalMs: 0,
    });
    managers.push(firstManager);
    const firstBytes = new TextEncoder().encode("first live service");
    const first = await firstManager.begin(principal, input(firstBytes, { requestId: "asset-live-service-one" }));
    await firstManager.upload(
      first.upload!.url.slice(first.upload!.url.lastIndexOf("/") + 1),
      first.upload!.token,
      "model/spz",
      firstBytes.byteLength,
      body(firstBytes),
    );

    const secondManager = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: parent,
      sweepIntervalMs: 0,
    });
    managers.push(secondManager);
    const secondBytes = new TextEncoder().encode("second live service");
    const second = await secondManager.begin(principal, input(secondBytes, { requestId: "asset-live-service-two" }));
    await secondManager.upload(
      second.upload!.url.slice(second.upload!.url.lastIndexOf("/") + 1),
      second.upload!.token,
      "model/spz",
      secondBytes.byteLength,
      body(secondBytes),
    );

    expect((await readdir(parent)).filter((name) => /^semaframe-agent-assets-[0-9a-f-]{36}$/u.test(name)))
      .toHaveLength(2);
    await secondManager.close();
    await expect(firstManager.inspect(first.candidateHandle, "workspace_main"))
      .resolves.toMatchObject({ candidateHandle: first.candidateHandle });
    expect((await readdir(parent)).filter((name) => /^semaframe-agent-assets-[0-9a-f-]{36}$/u.test(name)))
      .toHaveLength(1);
  });

  it("atomically quarantines one dead leased root across concurrent startup collectors", async () => {
    const parent = await mkdtemp(join(tmpdir(), "semaframe-asset-ingress-orphan-"));
    temporaryParents.push(parent);
    const orphanName = "semaframe-agent-assets-dead-owner";
    const orphan = join(parent, orphanName);
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(join(orphan, ".semaframe-agent-assets.lease.json"), JSON.stringify({
      version: 1,
      pid: process.pid + 10_000,
      instanceId: randomUUID(),
      createdAt: "2026-08-25T00:00:00.000Z",
    }), { mode: 0o600 });
    await writeFile(join(orphan, "orphan.asset"), "stale bytes");
    const removedDirectories: string[] = [];
    const sharedOptions = {
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: parent,
      sweepIntervalMs: 0,
      isProcessAlive: (pid: number) => pid === process.pid,
      removeDirectory: async (path: string) => {
        removedDirectories.push(path);
        await rm(path, { recursive: true, force: true });
      },
    } as const;
    const firstManager = new AgentAssetIngress(sharedOptions);
    const secondManager = new AgentAssetIngress(sharedOptions);
    managers.push(firstManager, secondManager);
    const firstBytes = new TextEncoder().encode("collector one");
    const secondBytes = new TextEncoder().encode("collector two");
    const first = await firstManager.begin(principal, input(firstBytes, { requestId: "asset-orphan-collector-one" }));
    const second = await secondManager.begin(principal, input(secondBytes, { requestId: "asset-orphan-collector-two" }));

    await Promise.all([
      firstManager.upload(
        first.upload!.url.slice(first.upload!.url.lastIndexOf("/") + 1),
        first.upload!.token,
        "model/spz",
        firstBytes.byteLength,
        body(firstBytes),
      ),
      secondManager.upload(
        second.upload!.url.slice(second.upload!.url.lastIndexOf("/") + 1),
        second.upload!.token,
        "model/spz",
        secondBytes.byteLength,
        body(secondBytes),
      ),
    ]);

    const names = await readdir(parent);
    expect(names).not.toContain(orphanName);
    expect(names.some((name) => name.startsWith("semaframe-agent-assets-quarantine-"))).toBe(false);
    expect(removedDirectories.some((path) => path.includes("semaframe-agent-assets-quarantine-"))).toBe(true);
    expect(names.filter((name) => /^semaframe-agent-assets-[0-9a-f-]{36}$/u.test(name))).toHaveLength(2);
  });

  it("restores a quarantined root when its lease owner becomes live during the recheck", async () => {
    const parent = await mkdtemp(join(tmpdir(), "semaframe-asset-ingress-recheck-"));
    temporaryParents.push(parent);
    const orphanName = "semaframe-agent-assets-owner-race";
    const orphan = join(parent, orphanName);
    const leasePid = process.pid + 20_000;
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(join(orphan, ".semaframe-agent-assets.lease.json"), JSON.stringify({
      version: 1,
      pid: leasePid,
      instanceId: randomUUID(),
      createdAt: "2026-08-25T00:00:00.000Z",
    }), { mode: 0o600 });
    let leaseChecks = 0;
    const manager = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: parent,
      sweepIntervalMs: 0,
      isProcessAlive: (pid) => pid === leasePid ? ++leaseChecks > 1 : pid === process.pid,
    });
    managers.push(manager);
    const bytes = new TextEncoder().encode("force startup recovery");
    const grant = await manager.begin(principal, input(bytes, { requestId: "asset-owner-recheck" }));
    await manager.upload(
      grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1),
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes),
    );

    expect(leaseChecks).toBe(2);
    expect(await readdir(parent)).toContain(orphanName);
    expect((await readdir(parent)).some((name) => name.startsWith("semaframe-agent-assets-quarantine-")))
      .toBe(false);
  });

  it("does not infer orphan ownership from a matching name or old timestamp without a valid lease", async () => {
    const parent = await mkdtemp(join(tmpdir(), "semaframe-asset-ingress-unleased-"));
    temporaryParents.push(parent);
    const unleasedName = "semaframe-agent-assets-unleased-old-root";
    const unleased = join(parent, unleasedName);
    await mkdir(unleased, { mode: 0o700 });
    await writeFile(join(unleased, "unknown-owner.asset"), "must not delete");
    const manager = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: parent,
      sweepIntervalMs: 0,
      isProcessAlive: () => false,
    });
    managers.push(manager);
    const bytes = new TextEncoder().encode("start without deleting unknown owner");
    const grant = await manager.begin(principal, input(bytes, { requestId: "asset-unleased-safety" }));
    await manager.upload(
      grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1),
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes),
    );

    expect(await readdir(parent)).toContain(unleasedName);
  });

  it("handles startup-GC rejection immediately while exposing it to begin and close", async () => {
    const parent = await mkdtemp(join(tmpdir(), "semaframe-asset-ingress-startup-failure-"));
    temporaryParents.push(parent);
    const orphan = join(parent, "semaframe-agent-assets-dead-cleanup-failure");
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(join(orphan, ".semaframe-agent-assets.lease.json"), JSON.stringify({
      version: 1,
      pid: process.pid + 30_000,
      instanceId: randomUUID(),
      createdAt: "2026-08-25T00:00:00.000Z",
    }), { mode: 0o600 });
    const manager = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: parent,
      sweepIntervalMs: 0,
      isProcessAlive: () => false,
      removeDirectory: async () => {
        throw Object.assign(new Error("injected orphan cleanup failure"), { code: "EACCES" });
      },
    });
    managers.push(manager);
    const bytes = new TextEncoder().encode("startup must fail explicitly");

    await expect(manager.begin(principal, input(bytes, { requestId: "asset-startup-gc-failure" })))
      .rejects.toMatchObject({ name: "AggregateError" });
    await expect(manager.close()).rejects.toMatchObject({
      name: "AggregateError",
      message: "Agent asset ingress cleanup failed for 1 resource(s).",
    });
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

  it("treats successful recursive root removal as authoritative after a per-file unlink failure", async () => {
    let failOnce = true;
    const { manager, parent } = await setup({
      removeFile: async (path) => {
        if (path.endsWith(".asset") && failOnce) {
          failOnce = false;
          throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
        }
        await unlink(path);
      },
    });
    const bytes = new TextEncoder().encode("root cleanup is authoritative");
    const grant = await manager.begin(principal, input(bytes, { requestId: "asset-close-root-authority" }));
    await manager.upload(
      grant.upload!.url.slice(grant.upload!.url.lastIndexOf("/") + 1),
      grant.upload!.token,
      "model/spz",
      bytes.byteLength,
      body(bytes),
    );

    await expect(manager.close()).resolves.toBeUndefined();
    expect(failOnce).toBe(false);
    expect(await readdir(parent)).toEqual([]);
  });

  it("continues shutdown after per-file failures, reports every cleanup failure, and retries close", async () => {
    let fileFailureRemaining = true;
    let rootFailureRemaining = true;
    const removedFiles: string[] = [];
    const { manager, parent } = await setup({
      removeFile: async (path) => {
        removedFiles.push(path);
        if (path.endsWith(".asset") && fileFailureRemaining) {
          fileFailureRemaining = false;
          throw Object.assign(new Error("injected file cleanup failure"), { code: "EACCES" });
        }
        await unlink(path);
      },
      removeDirectory: async (path) => {
        if (path.includes("semaframe-agent-assets-") && rootFailureRemaining) {
          rootFailureRemaining = false;
          throw Object.assign(new Error("injected root cleanup failure"), { code: "EACCES" });
        }
        await rm(path, { recursive: true, force: true });
      },
    });
    const firstBytes = new TextEncoder().encode("first shutdown candidate");
    const secondBytes = new TextEncoder().encode("second shutdown candidate");
    const first = await manager.begin(principal, input(firstBytes, { requestId: "asset-close-first" }));
    const second = await manager.begin(principal, input(secondBytes, {
      requestId: "asset-close-second",
      sha256: digest(secondBytes),
    }));
    await manager.upload(
      first.upload!.url.slice(first.upload!.url.lastIndexOf("/") + 1),
      first.upload!.token,
      "model/spz",
      firstBytes.byteLength,
      body(firstBytes),
    );
    await manager.upload(
      second.upload!.url.slice(second.upload!.url.lastIndexOf("/") + 1),
      second.upload!.token,
      "model/spz",
      secondBytes.byteLength,
      body(secondBytes),
    );

    await expect(manager.close()).rejects.toMatchObject({
      name: "AggregateError",
      message: "Agent asset ingress cleanup failed for 2 resource(s).",
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "asset_cleanup_failed" }),
        expect.objectContaining({ code: "EACCES" }),
      ]),
    });
    // Both records were attempted even though one unlink failed.
    expect(removedFiles.filter((path) => path.endsWith(".asset")).length).toBeGreaterThanOrEqual(2);
    await expect(manager.close()).resolves.toBeUndefined();
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
