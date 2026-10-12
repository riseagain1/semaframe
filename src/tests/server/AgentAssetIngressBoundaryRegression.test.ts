// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAssetIngress, type AgentAssetIngressOptions, type BeginAgentAssetImportInput } from "../../../server/agent/AgentAssetIngress";

const principal = { authorizationId: "boundary-authority" };
const bytes = new TextEncoder().encode("binary evidence");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const input = (overrides: Partial<BeginAgentAssetImportInput> = {}): BeginAgentAssetImportInput => ({
  requestId: "boundary-request-1", workspaceId: "workspace_main", displayName: "evidence.spz", format: "spz", mediaType: "model/spz", byteLength: bytes.length, sha256: digest, ...overrides,
});
const parents: string[] = [];
const managers: AgentAssetIngress[] = [];
async function setup(overrides: Partial<AgentAssetIngressOptions> = {}) {
  const parent = await mkdtemp(join(tmpdir(), "semaframe-ingress-boundary-")); parents.push(parent);
  const manager = new AgentAssetIngress({ publicBaseUrl: "http://127.0.0.1:8788", temporaryDirectory: parent, sweepIntervalMs: 0, minimumFreeBytesAfterUpload: 0, ...overrides });
  managers.push(manager); return { manager, parent };
}
async function ready(manager: AgentAssetIngress, requestId = "boundary-request-1", authorizationId = principal.authorizationId) {
  const grant = await manager.begin({ authorizationId }, input({ requestId }));
  await manager.upload(grant.upload!.url.split("/").at(-1)!, grant.upload!.token, "model/spz", bytes.length, {
    async *[Symbol.asyncIterator]() { yield "binary evidence"; },
  });
  return grant;
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
});

describe("asset ingress fail-closed boundaries", () => {
  it.each([
    { requestId: "bad" }, { workspaceId: "../../workspace" }, { byteLength: 0 }, { byteLength: 1.2 },
    { sha256: "wrong" }, { purpose: "unrecognized" },
  ])("rejects invalid metadata before grant allocation: %s", async (overrides) => {
    const { manager, parent } = await setup();
    await expect(manager.begin(principal, input(overrides as Partial<BeginAgentAssetImportInput>))).rejects.toMatchObject({ code: "invalid_request" });
    expect(await readdir(parent)).toEqual([]);
  });
  it.each([{ format: "exe", mediaType: "application/exe" }, { format: "spz", mediaType: "image/png" }])("rejects unsupported format/media pairs %s", async (overrides) => {
    const { manager } = await setup();
    await expect(manager.begin(principal, input(overrides as Partial<BeginAgentAssetImportInput>))).rejects.toMatchObject({ status: 415 });
  });
  it("requires an approved principal and bounds total staging reservation", async () => {
    const { manager } = await setup({ maxStagedBytes: bytes.length });
    for (const authorizationId of ["", "x".repeat(129)]) await expect(manager.begin({ authorizationId }, input())).rejects.toMatchObject({ code: "asset_import_not_authorized" });
    await manager.begin(principal, input());
    await expect(manager.begin(principal, input({ requestId: "boundary-request-2" }))).rejects.toMatchObject({ code: "asset_ingress_capacity_exceeded" });
  });
  it.each([
    { publicBaseUrl: "ftp://example.org" }, { publicBaseUrl: "https://user@example.org" },
    { candidateTtlMs: 86_400_001 }, { minimumFreeBytesAfterUpload: -1 },
    { temporaryDirectory: "relative/path" }, { sweepIntervalMs: -1 },
  ])("rejects invalid ingress construction settings %s", (options) => {
    expect(() => new AgentAssetIngress({ publicBaseUrl: "https://example.org", ...options })).toThrow();
  });
  it("rejects missing bodies, invalid storage overrides and reuses a ready exact upload", async () => {
    const { manager } = await setup();
    const grant = await manager.begin(principal, input()); const id = grant.upload!.url.split("/").at(-1)!;
    await expect(manager.upload(id, grant.upload!.token, "model/spz", bytes.length, undefined)).rejects.toMatchObject({ code: "asset_body_required" });
    const body = { async *[Symbol.asyncIterator]() { yield bytes; } };
    await expect(manager.upload(id, grant.upload!.token, "model/spz", bytes.length, body, undefined, { minimumFreeBytesAfterWrite: -1 })).rejects.toMatchObject({ code: "invalid_request" });
    const candidate = await manager.upload(id, grant.upload!.token, "model/spz", bytes.length, body);
    await expect(manager.upload(id, grant.upload!.token, "model/spz", bytes.length, undefined)).resolves.toEqual(candidate);
  });
  it("handles a rejected body iterator without losing the retryable grant or leaking partial bytes", async () => {
    const { manager, parent } = await setup(); const grant = await manager.begin(principal, input());
    const failure = new Error("upstream stream disconnected");
    await expect(manager.upload(grant.upload!.url.split("/").at(-1)!, grant.upload!.token, "model/spz", bytes.length, {
      [Symbol.asyncIterator]() { return { next: async () => { throw failure; } }; },
    })).rejects.toBe(failure);
    const repeated = await manager.begin(principal, input()); expect(repeated.status).toBe("awaiting_upload");
    for (const directory of await readdir(parent)) expect((await readdir(join(parent, directory))).some((name) => name.endsWith(".partial"))).toBe(false);
    await ready(manager);
  });
  it("expires a stalled upload even without additional chunks", async () => {
    const { manager } = await setup({ grantTtlMs: 30 }); const grant = await manager.begin(principal, input());
    let settle!: () => void;
    const pending = new Promise<IteratorResult<Uint8Array>>((resolve) => { settle = () => resolve({ done: true, value: undefined }); });
    const upload = manager.upload(grant.upload!.url.split("/").at(-1)!, grant.upload!.token, "model/spz", bytes.length, {
      [Symbol.asyncIterator]() { return { next: () => pending }; },
    });
    try { await expect(upload).rejects.toMatchObject({ code: "asset_upload_cancelled" }); }
    finally { settle(); }
  });
  it("retains cancelled cleanup failures until a repeated begin safely retries deletion", async () => {
    let refuse = true;
    const { manager } = await setup({ removeFile: async (path) => { if (refuse) throw new Error("temporary unlink failure"); await unlink(path); } });
    const grant = await ready(manager);
    await expect(manager.cancelFromAgent(grant.candidateHandle, principal.authorizationId)).rejects.toMatchObject({ code: "asset_cleanup_failed" });
    refuse = false;
    await expect(manager.begin(principal, input())).resolves.toMatchObject({ status: "awaiting_upload" });
  });
  it("invalidates active grants and completed tombstones on revocation", async () => {
    const { manager } = await setup();
    const completed = await ready(manager); await manager.complete(completed.candidateHandle, "workspace_main");
    const pending = await manager.begin(principal, input({ requestId: "boundary-request-2" }));
    await expect(manager.revokeAll()).resolves.toEqual({ revoked: 1 });
    await expect(manager.inspect(pending.candidateHandle, "workspace_main")).rejects.toMatchObject({ code: "asset_candidate_not_found" });
    await expect(manager.reserveCandidate(completed.candidateHandle, principal.authorizationId, "workspace_main")).rejects.toMatchObject({ code: "asset_candidate_not_found" });
    await expect(manager.begin(principal, input())).resolves.toMatchObject({ status: "awaiting_upload" });
    await expect(manager.revokeAllExceptAuthorization("")).resolves.toEqual({ revoked: 1 });
  });
  it("revokes only matching completed tombstones and preserves retained authorization", async () => {
    const { manager } = await setup();
    const first = await ready(manager); await manager.complete(first.candidateHandle, "workspace_main");
    const other = await ready(manager, "boundary-request-2", "other-authority"); await manager.complete(other.candidateHandle, "workspace_main");
    await manager.revokeAuthorization(principal.authorizationId);
    await expect(manager.reserveCandidate(first.candidateHandle, principal.authorizationId, "workspace_main")).rejects.toMatchObject({ code: "asset_candidate_not_found" });
    await expect(manager.reserveCandidate(other.candidateHandle, "other-authority", "workspace_main")).resolves.toMatchObject({ status: "completed" });
    await manager.revokeAllExceptAuthorization(principal.authorizationId);
    await expect(manager.reserveCandidate(other.candidateHandle, "other-authority", "workspace_main")).rejects.toMatchObject({ code: "asset_candidate_not_found" });
  });
  it("does not mutate candidate labels while a reader is active and expires idle readers", async () => {
    const { manager } = await setup({ candidateTtlMs: 1000 }); const grant = await ready(manager);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opened = await manager.open(grant.candidateHandle, "workspace_main");
    await expect(manager.relabelCandidate(grant.candidateHandle, principal.authorizationId, "workspace_main", "changed.spz")).rejects.toMatchObject({ code: "asset_candidate_in_use" });
    await expect(manager.complete(grant.candidateHandle, "workspace_main")).rejects.toMatchObject({ code: "asset_candidate_in_use" });
    vi.advanceTimersByTime(1001); vi.useRealTimers();
    await opened.body.cancel().catch(() => undefined); opened.release(); opened.release();
    await expect(manager.relabelCandidate(grant.candidateHandle, principal.authorizationId, "workspace_main", "changed.spz")).resolves.toBeUndefined();
  });
  it("keeps background sweep rejection handled and stops periodic sweeps on shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { manager } = await setup({ sweepIntervalMs: 10 });
    const sweep = vi.spyOn(manager, "sweepExpired").mockRejectedValue(new Error("transient cleanup error"));
    await vi.advanceTimersByTimeAsync(10); expect(sweep).toHaveBeenCalledOnce();
    await manager.close(); await vi.advanceTimersByTimeAsync(100); expect(sweep).toHaveBeenCalledOnce();
  });
});
