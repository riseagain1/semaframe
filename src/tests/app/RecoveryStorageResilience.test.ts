import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FallbackWorkspaceRecoveryRepository,
  IndexedDbWorkspaceRecoveryRepository,
  LocalStorageWorkspaceRecoveryRepository,
  legacyWorkspaceRecoverySnapshot,
  migrateLegacyWorkspaceRecovery,
  type WorkspaceRecoverySnapshot,
} from "../../app/recovery/WorkspaceRecoveryRepository";

const recoveryKey = "recovery-resilience";
const snapshot = (overrides: Partial<WorkspaceRecoverySnapshot> = {}): WorkspaceRecoverySnapshot => ({
  projectName: "测量 workspace", serializedProject: "测量 data", projectId: "project-1",
  workspaceRevision: 3, generation: 0, sequence: 1, createdAt: "2026-10-12T00:00:00.000Z", ...overrides,
});
const digest = async (value: string): Promise<`sha256:${string}`> =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("local recovery storage resilience", () => {
  it.each(["{broken", "null", "[]", "{}", "", '{"current":null}', '{"current":{"sha256":"bad"}}'])("reports present but invalid local recovery instead of empty: %s", async (raw) => {
    const repo = new LocalStorageWorkspaceRecoveryRepository({ key: recoveryKey, digest });
    localStorage.setItem(recoveryKey, raw);
    const inspection = await repo.inspectStartupRecovery();
    expect(inspection.candidates).toEqual([]);
    expect(inspection.issues[0]?.kind).toBe("invalid");
    expect(localStorage.getItem(recoveryKey)).toBe(raw);
  });

  it("reports local storage access failure separately from an absent key", async () => {
    const empty = new LocalStorageWorkspaceRecoveryRepository({ key: recoveryKey, digest });
    expect(await empty.inspectStartupRecovery()).toEqual({ candidates: [], issues: [] });
    const denied = new LocalStorageWorkspaceRecoveryRepository({ digest, storage: {
      getItem: () => { throw new Error("denied"); }, setItem: vi.fn(), removeItem: vi.fn(),
    } });
    expect(await denied.readCandidates()).toEqual([]);
    expect(await denied.inspectStartupRecovery()).toMatchObject({ candidates: [], issues: [{ kind: "unavailable" }] });
    const combined = new FallbackWorkspaceRecoveryRepository(denied, empty);
    expect(await combined.readCandidates()).toEqual([]);
    expect(await combined.inspectStartupRecovery()).toMatchObject({ candidates: [], issues: [{ kind: "unavailable" }] });
  });

  it("does not hide an unreadable primary when fallback has a valid scene", async () => {
    const primary = new LocalStorageWorkspaceRecoveryRepository({ digest, storage: {
      getItem: () => { throw new Error("denied"); }, setItem: vi.fn(), removeItem: vi.fn(),
    } });
    const fallback = new LocalStorageWorkspaceRecoveryRepository({ key: recoveryKey, digest });
    await fallback.write(snapshot());
    const result = await new FallbackWorkspaceRecoveryRepository(primary, fallback).inspectStartupRecovery();
    expect(result.candidates).toHaveLength(1);
    expect(result.issues).toMatchObject([{ kind: "unavailable" }]);
  });

  it("keeps the valid local previous snapshot during the first post-recovery write", async () => {
    const repo = new LocalStorageWorkspaceRecoveryRepository({ key: recoveryKey, digest });
    await repo.write(snapshot({ sequence: 1, serializedProject: "valid previous" }));
    await repo.write(snapshot({ sequence: 2, serializedProject: "corrupt head" }));
    const envelope = JSON.parse(localStorage.getItem(recoveryKey)!);
    envelope.current.sha256 = `sha256:${"f".repeat(64)}`;
    localStorage.setItem(recoveryKey, JSON.stringify(envelope));
    const result = await repo.inspectStartupRecovery();
    expect(result.candidates[0]?.source).toBe("previous");
    expect(result.issues).toMatchObject([{ kind: "invalid" }]);
    await repo.write(snapshot({ sequence: 3, serializedProject: "new edit" }));
    expect((await repo.readCandidates()).map(({ snapshot: value }) => value.serializedProject))
      .toEqual(["new edit", "valid previous"]);
  });

  it("stores UTF-8 byte lengths and real SHA-256, rotates only two distinct latest snapshots, then clears", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const repo = new LocalStorageWorkspaceRecoveryRepository({ key: recoveryKey });
    const first = snapshot();
    const record = await repo.write(first);
    expect(record.byteLength).toBe(new TextEncoder().encode(first.serializedProject).length);
    expect(record.sha256).toBe(await digest(first.serializedProject));
    await repo.write(snapshot({ sequence: 3, serializedProject: "newest" }));
    await repo.write(snapshot({ sequence: 2, serializedProject: "middle" }));
    const delayed = await repo.write(first);
    expect(delayed.sequence).toBe(3);
    await repo.write(snapshot({ sequence: 3, serializedProject: "newest" }));
    expect((await repo.readCandidates()).map(({ snapshot: value }) => value.sequence)).toEqual([3, 2]);
    expect(await repo.read()).toMatchObject({ source: "current", recoveredFromPrevious: false });
    await repo.clear();
    expect(localStorage.getItem(recoveryKey)).toBeNull();
    expect(await repo.read()).toBeUndefined();
    repo.dispose();
    await expect(repo.read()).rejects.toThrow("disposed");
    await expect(repo.write(first)).rejects.toThrow("disposed");
    await expect(repo.clear()).rejects.toThrow("disposed");
  });

  it("never restores modified payloads or invalid records and can replace malformed JSON", async () => {
    const repo = new LocalStorageWorkspaceRecoveryRepository({ key: recoveryKey, digest });
    await repo.write(snapshot());
    await repo.write(snapshot({ sequence: 2, serializedProject: "second" }));
    const original = JSON.parse(localStorage.getItem(recoveryKey)!);
    const badRecords = [null, [], { ...original.current, version: 2 },
      { ...original.current, byteLength: 0 }, { ...original.current, sha256: `sha256:${"0".repeat(64)}` },
      { ...original.current, projectId: "" }, { ...original.current, workspaceRevision: -1 },
      { ...original.current, sequence: 1.5 }, { ...original.current, createdAt: "bad date" }];
    for (const current of badRecords) {
      localStorage.setItem(recoveryKey, JSON.stringify({ ...original, current }));
      await expect(repo.read()).resolves.toMatchObject({ source: "previous", recoveredFromPrevious: true,
        snapshot: { sequence: 1 } });
    }
    localStorage.setItem(recoveryKey, "{broken json");
    expect(await repo.readCandidates()).toEqual([]);
    await repo.write(snapshot({ sequence: 3 }));
    expect((await repo.read())?.snapshot.sequence).toBe(3);
    await expect(repo.write(snapshot({ projectName: "x".repeat(257) }))).rejects.toThrow("invalid");
  });

  it("orders equal timestamps by generation, sequence, revision and stable identity", async () => {
    const repo = new LocalStorageWorkspaceRecoveryRepository({ key: recoveryKey, digest });
    await repo.write(snapshot({ generation: 1, sequence: 9 }));
    await repo.write(snapshot({ generation: 2, sequence: 0 }));
    expect((await repo.read())?.snapshot.generation).toBe(2);
    await repo.clear();
    await repo.write(snapshot({ workspaceRevision: 4, serializedProject: "low" }));
    await repo.write(snapshot({ workspaceRevision: 5, serializedProject: "high" }));
    expect((await repo.read())?.snapshot.workspaceRevision).toBe(5);
    await repo.clear();
    await repo.write(snapshot({ projectId: "a" }));
    await repo.write(snapshot({ projectId: "z" }));
    expect((await repo.readCandidates()).map(({ snapshot: value }) => value.projectId)).toEqual(["z", "a"]);
    await repo.write(snapshot({ projectId: "b" }));
    expect((await repo.readCandidates()).map(({ snapshot: value }) => value.projectId)).toEqual(["z", "b"]);
  });

  it("handles unavailable storage and SHA-256 without claiming a successful write", async () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => new LocalStorageWorkspaceRecoveryRepository()).toThrow("unavailable");
    const storage = { getItem: vi.fn(() => { throw new Error("denied"); }), setItem: vi.fn(), removeItem: vi.fn() };
    const repo = new LocalStorageWorkspaceRecoveryRepository({ storage, digest });
    expect(await repo.readCandidates()).toEqual([]);
    await repo.write(snapshot());
    expect(storage.setItem).toHaveBeenCalledOnce();
    vi.stubGlobal("crypto", undefined);
    const noCrypto = new LocalStorageWorkspaceRecoveryRepository({ storage });
    await expect(noCrypto.write(snapshot())).rejects.toThrow("SHA-256 is unavailable");
  });

  it("deduplicates cross-store copies in favor of current, tolerates unavailable primary reads and stops retrying failed writes", async () => {
    const primary = new LocalStorageWorkspaceRecoveryRepository({ key: "primary", digest });
    const fallback = new LocalStorageWorkspaceRecoveryRepository({ key: "fallback", digest });
    await primary.write(snapshot());
    await primary.write(snapshot({ sequence: 2 }));
    await fallback.write(snapshot());
    const combined = new FallbackWorkspaceRecoveryRepository(primary, fallback);
    expect(await combined.readCandidates()).toMatchObject([
      { snapshot: { sequence: 2 }, source: "current" },
      { snapshot: { sequence: 1 }, source: "current", recoveredFromPrevious: false },
    ]);
    const reads = vi.spyOn(primary, "readCandidates").mockRejectedValue(new Error("denied"));
    expect((await combined.read())?.snapshot.sequence).toBe(1);
    await combined.read();
    expect(reads).toHaveBeenCalledOnce();
    const writes = vi.spyOn(primary, "write").mockRejectedValue(new Error("quota"));
    await combined.write(snapshot({ sequence: 3 }));
    await combined.write(snapshot({ sequence: 4 }));
    expect(writes).toHaveBeenCalledOnce();
    expect((await combined.read())?.snapshot.sequence).toBe(4);
    await combined.clear();
    expect(await combined.readCandidates()).toEqual([]);
    combined.dispose();
    await expect(combined.write(snapshot())).rejects.toThrow("disposed");
  });

  it("keeps read errors visible when neither backend supplies candidates", async () => {
    const primary = new LocalStorageWorkspaceRecoveryRepository({ key: "primary", digest });
    const fallback = new LocalStorageWorkspaceRecoveryRepository({ key: "fallback", digest });
    vi.spyOn(fallback, "readCandidates").mockRejectedValue(new Error("fallback unreadable"));
    await expect(new FallbackWorkspaceRecoveryRepository(primary, fallback).read()).rejects.toThrow("fallback unreadable");
  });

  it("does not remove legacy data until a durable read verifies migration", async () => {
    const repo = new LocalStorageWorkspaceRecoveryRepository({ key: recoveryKey, digest });
    const remove = vi.fn();
    expect(legacyWorkspaceRecoverySnapshot("broken")).toBeUndefined();
    expect(legacyWorkspaceRecoverySnapshot('{"version":2}')).toBeUndefined();
    expect(legacyWorkspaceRecoverySnapshot(JSON.stringify({ version: 1, projectName: "a",
      project: { projectId: "a", workspace: { revision: -1 } } }))).toBeUndefined();
    expect(await migrateLegacyWorkspaceRecovery(repo, "{}", remove)).toBe(false);
    const raw = JSON.stringify({ version: 1, projectName: "Legacy", project: { projectId: "old", workspace: { revision: 1 } } });
    expect(legacyWorkspaceRecoverySnapshot(raw)?.createdAt).toBe(new Date(0).toISOString());
    vi.spyOn(repo, "read").mockResolvedValue(undefined);
    await expect(migrateLegacyWorkspaceRecovery(repo, raw, remove)).rejects.toThrow("could not be verified");
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("IndexedDB recovery opening failures", () => {
  it("rejects unavailable factories and invalid database names", () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(() => new IndexedDbWorkspaceRecoveryRepository()).toThrow("unavailable");
    expect(() => new IndexedDbWorkspaceRecoveryRepository({ indexedDBFactory: {} as IDBFactory, databaseName: "../invalid" }))
      .toThrow("database name is invalid");
  });

  it.each(["error", "blocked"] as const)("reports %s opening failures and safely disposes a rejected opening promise", async (kind) => {
    const request = {} as IDBOpenDBRequest;
    const open = vi.fn(() => {
      queueMicrotask(() => kind === "error"
        ? request.onerror?.call(request, new Event("error"))
        : request.onblocked?.call(request, new Event("blocked") as IDBVersionChangeEvent));
      return request;
    });
    const repo = new IndexedDbWorkspaceRecoveryRepository({ indexedDBFactory: { open } as unknown as IDBFactory, digest });
    await expect(repo.read()).rejects.toThrow(kind === "error" ? "could not open" : "blocked");
    repo.dispose();
    repo.dispose();
    await expect(repo.clear()).rejects.toThrow("disposed");
    await Promise.resolve();
  });

  it.each(["complete", "error", "abort"] as const)("clears both recovery slots in one transaction and handles %s", async (event) => {
    const remove = vi.fn();
    const close = vi.fn();
    const tx = { error: null, objectStore: vi.fn(() => ({ delete: remove })) } as unknown as IDBTransaction;
    const database = {
      objectStoreNames: { contains: () => true }, close,
      transaction: vi.fn(() => {
        queueMicrotask(() => {
          if (event === "complete") tx.oncomplete?.call(tx, new Event("complete"));
          else if (event === "error") tx.onerror?.call(tx, new Event("error"));
          else tx.onabort?.call(tx, new Event("abort"));
        });
        return tx;
      }),
    };
    const request = { result: database } as unknown as IDBOpenDBRequest;
    const open = vi.fn(() => {
      queueMicrotask(() => request.onsuccess?.call(request, new Event("success")));
      return request;
    });
    const repo = new IndexedDbWorkspaceRecoveryRepository({ indexedDBFactory: { open } as unknown as IDBFactory });
    if (event === "complete") await expect(repo.clear()).resolves.toBeUndefined();
    else await expect(repo.clear()).rejects.toThrow(event === "error" ? "transaction failed" : "transaction aborted");
    expect(open).toHaveBeenCalledWith("semaframe-workspace-recovery-v3", 1);
    expect(database.transaction).toHaveBeenCalledWith("snapshots", "readwrite");
    expect(remove.mock.calls).toEqual([["current"], ["previous"]]);
    repo.dispose();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    await expect(repo.write(snapshot())).rejects.toThrow("disposed");
  });
});
