import { describe, expect, it } from "vitest";
import {
  FallbackWorkspaceRecoveryRepository,
  IndexedDbWorkspaceRecoveryRepository,
  WorkspaceRecoveryCoordinator,
  legacyWorkspaceRecoverySnapshot,
  migrateLegacyWorkspaceRecovery,
  type WorkspaceRecoveryRecord,
  type WorkspaceRecoveryRepository,
  type WorkspaceRecoverySnapshot,
} from "../../app/recovery";

const digest = async (value: string): Promise<`sha256:${string}`> =>
  `sha256:${value.length.toString(16).padStart(64, "0")}`;

function snapshot(overrides: Partial<WorkspaceRecoverySnapshot> = {}): WorkspaceRecoverySnapshot {
  return Object.freeze({
    projectName: "Recovery test",
    serializedProject: JSON.stringify({ projectId: "project-recovery", workspace: { revision: 3 } }),
    projectId: "project-recovery",
    workspaceRevision: 3,
    generation: 0,
    sequence: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  });
}

class FakeRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => unknown) | null = null;
  onblocked: ((event: IDBVersionChangeEvent) => unknown) | null = null;
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onabort: ((event: Event) => unknown) | null = null;
  private pending = 0;
  private completionQueued = false;
  private aborted = false;
  private readonly staged: Map<string, unknown>;

  constructor(
    private readonly records: Map<string, unknown>,
    private readonly mode: IDBTransactionMode,
    private readonly failWrite: () => boolean,
  ) {
    this.staged = new Map(records);
  }

  objectStore(): IDBObjectStore {
    const begin = (): void => { this.pending += 1; };
    const finish = (): void => { this.pending -= 1; this.queueCompletion(); };
    return {
      get: (key: IDBValidKey) => {
        const request = new FakeRequest<unknown>();
        begin();
        queueMicrotask(() => {
          if (this.aborted) return;
          request.result = this.staged.get(String(key));
          request.onsuccess?.(new Event("success"));
          finish();
        });
        return request as unknown as IDBRequest;
      },
      put: (value: unknown) => {
        const request = new FakeRequest();
        begin();
        queueMicrotask(() => {
          if (this.aborted) return;
          if (this.failWrite()) {
            this.error = new DOMException("Quota exceeded", "QuotaExceededError");
            request.error = this.error;
            request.onerror?.(new Event("error"));
            this.abort();
            return;
          }
          const slot = (value as { slot?: unknown }).slot;
          if (typeof slot !== "string") throw new Error("Fake record has no slot");
          this.staged.set(slot, value);
          request.result = undefined;
          request.onsuccess?.(new Event("success"));
          finish();
        });
        return request as unknown as IDBRequest;
      },
      delete: (key: IDBValidKey) => {
        const request = new FakeRequest();
        begin();
        queueMicrotask(() => {
          if (this.aborted) return;
          this.staged.delete(String(key));
          request.onsuccess?.(new Event("success"));
          finish();
        });
        return request as unknown as IDBRequest;
      },
    } as unknown as IDBObjectStore;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.onabort?.(new Event("abort")));
  }

  private queueCompletion(): void {
    if (this.pending !== 0 || this.completionQueued || this.aborted) return;
    this.completionQueued = true;
    queueMicrotask(() => queueMicrotask(() => {
      this.completionQueued = false;
      if (this.pending !== 0 || this.aborted) return;
      if (this.mode === "readwrite") {
        this.records.clear();
        for (const [key, value] of this.staged) this.records.set(key, value);
      }
      this.oncomplete?.(new Event("complete"));
    }));
  }
}

class FakeDatabase {
  readonly records = new Map<string, unknown>();
  readonly objectStoreNames = { contains: () => this.created } as unknown as DOMStringList;
  failWrites = 0;
  private created = false;

  createObjectStore(): IDBObjectStore {
    this.created = true;
    return {} as IDBObjectStore;
  }

  transaction(_name: string, mode: IDBTransactionMode = "readonly"): IDBTransaction {
    return new FakeTransaction(this.records, mode, () => {
      if (this.failWrites <= 0) return false;
      this.failWrites -= 1;
      return true;
    }) as unknown as IDBTransaction;
  }

  close(): void {}
}

class FakeFactory {
  readonly database = new FakeDatabase();

  open(): IDBOpenDBRequest {
    const request = new FakeRequest<IDBDatabase>();
    queueMicrotask(() => {
      request.result = this.database as unknown as IDBDatabase;
      request.onupgradeneeded?.({} as IDBVersionChangeEvent);
      request.onsuccess?.(new Event("success"));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

class MemoryRepository implements WorkspaceRecoveryRepository {
  records: WorkspaceRecoverySnapshot[] = [];
  clears = 0;
  disposed = false;
  writeGate: Promise<void> | undefined;

  async read() {
    const value = this.records.at(-1);
    return value ? { snapshot: value, source: "current" as const, recoveredFromPrevious: false } : undefined;
  }

  async readCandidates() {
    const value = await this.read();
    return value ? [value] : [];
  }

  async write(value: WorkspaceRecoverySnapshot): Promise<WorkspaceRecoveryRecord> {
    await this.writeGate;
    this.records.push(value);
    return {
      ...value,
      slot: "current",
      version: 1,
      byteLength: value.serializedProject.length,
      sha256: await digest(value.serializedProject),
    };
  }

  async clear(): Promise<void> { this.clears += 1; this.records = []; }
  dispose(): void { this.disposed = true; }
}

class ControllableRepository extends MemoryRepository {
  failReads = false;
  failWrites = false;
  failClears = false;

  override async read() {
    if (this.failReads) throw new Error("read unavailable");
    return super.read();
  }

  override async readCandidates() {
    if (this.failReads) throw new Error("read unavailable");
    return super.readCandidates();
  }

  override async write(value: WorkspaceRecoverySnapshot): Promise<WorkspaceRecoveryRecord> {
    if (this.failWrites) throw new Error("write unavailable");
    return super.write(value);
  }

  override async clear(): Promise<void> {
    if (this.failClears) throw new Error("clear unavailable");
    await super.clear();
  }
}

describe("Workspace recovery", () => {
  it("commits current and previous atomically and falls back from corrupt current", async () => {
    const factory = new FakeFactory();
    const repository = new IndexedDbWorkspaceRecoveryRepository({
      indexedDBFactory: factory as unknown as IDBFactory,
      databaseName: "recovery-fallback-test",
      digest,
    });
    await repository.write(snapshot({ sequence: 1, serializedProject: "first" }));
    await repository.write(snapshot({ sequence: 2, serializedProject: "second" }));
    await expect(repository.read()).resolves.toMatchObject({
      source: "current",
      snapshot: { sequence: 2, serializedProject: "second" },
    });
    const current = factory.database.records.get("current") as WorkspaceRecoveryRecord;
    factory.database.records.set("current", { ...current, sha256: `sha256:${"f".repeat(64)}` });
    await expect(repository.read()).resolves.toMatchObject({
      source: "previous",
      recoveredFromPrevious: true,
      snapshot: { sequence: 1, serializedProject: "first" },
    });
    repository.dispose();
  });

  it("leaves the last-known-good head intact when a transaction aborts", async () => {
    const factory = new FakeFactory();
    const repository = new IndexedDbWorkspaceRecoveryRepository({
      indexedDBFactory: factory as unknown as IDBFactory,
      databaseName: "recovery-abort-test",
      digest,
    });
    await repository.write(snapshot({ sequence: 1, serializedProject: "safe" }));
    factory.database.failWrites = 1;
    await expect(repository.write(snapshot({ sequence: 2, serializedProject: "unsafe" }))).rejects.toThrow();
    await expect(repository.read()).resolves.toMatchObject({ snapshot: { serializedProject: "safe" } });
  });

  it("orders a verified newer previous slot before an older current slot", async () => {
    const factory = new FakeFactory();
    const repository = new IndexedDbWorkspaceRecoveryRepository({
      indexedDBFactory: factory as unknown as IDBFactory,
      databaseName: "recovery-out-of-order-read-test",
      digest,
    });
    await repository.write(snapshot({
      sequence: 1,
      serializedProject: "older",
      createdAt: "2026-08-26T00:00:01.000Z",
    }));
    await repository.write(snapshot({
      sequence: 2,
      serializedProject: "newer",
      createdAt: "2026-08-26T00:00:02.000Z",
    }));
    const newer = factory.database.records.get("current") as WorkspaceRecoveryRecord;
    const older = factory.database.records.get("previous") as WorkspaceRecoveryRecord;
    factory.database.records.set("current", { ...older, slot: "current" });
    factory.database.records.set("previous", { ...newer, slot: "previous" });

    await expect(repository.readCandidates()).resolves.toMatchObject([
      { source: "previous", snapshot: { serializedProject: "newer" } },
      { source: "current", snapshot: { serializedProject: "older" } },
    ]);
  });

  it("does not let delayed multi-tab writers overwrite the two newest verified snapshots", async () => {
    const factory = new FakeFactory();
    const firstTab = new IndexedDbWorkspaceRecoveryRepository({
      indexedDBFactory: factory as unknown as IDBFactory,
      databaseName: "recovery-multi-writer-test",
      digest,
    });
    const delayedTab = new IndexedDbWorkspaceRecoveryRepository({
      indexedDBFactory: factory as unknown as IDBFactory,
      databaseName: "recovery-multi-writer-test",
      digest,
    });
    await firstTab.write(snapshot({
      sequence: 3,
      serializedProject: "newest",
      createdAt: "2026-08-26T00:00:03.000Z",
    }));
    await delayedTab.write(snapshot({
      sequence: 2,
      serializedProject: "delayed-middle",
      createdAt: "2026-08-26T00:00:02.000Z",
    }));
    await delayedTab.write(snapshot({
      sequence: 1,
      serializedProject: "delayed-oldest",
      createdAt: "2026-08-26T00:00:01.000Z",
    }));

    await expect(firstTab.readCandidates()).resolves.toMatchObject([
      { source: "current", snapshot: { serializedProject: "newest" } },
      { source: "previous", snapshot: { serializedProject: "delayed-middle" } },
    ]);
    expect([...factory.database.records.values()].map((value) =>
      (value as WorkspaceRecoveryRecord).serializedProject)).not.toContain("delayed-oldest");
  });

  it("coalesces pending writes and makes generation replacement a hard boundary", async () => {
    const repository = new MemoryRepository();
    let release!: () => void;
    repository.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new WorkspaceRecoveryCoordinator(repository);
    const first = coordinator.schedule(snapshot({ serializedProject: "one" }));
    const second = coordinator.schedule(snapshot({ serializedProject: "two" }));
    const third = coordinator.schedule(snapshot({ serializedProject: "three" }));
    await expect(second).resolves.toMatchObject({ status: "superseded" });
    const replacing = coordinator.replaceGeneration({ clear: true });
    release();
    await replacing;
    await expect(first).resolves.toMatchObject({ status: "stale" });
    await expect(third).resolves.toMatchObject({ status: "stale" });
    expect(repository.records).toEqual([]);
    expect(repository.clears).toBe(1);
    await expect(coordinator.schedule(snapshot({ serializedProject: "new" }))).resolves.toMatchObject({
      status: "stored",
      generation: 1,
    });
  });

  it("continues draining when a caller schedules from a completed write reaction", async () => {
    const repository = new MemoryRepository();
    const coordinator = new WorkspaceRecoveryCoordinator(repository);

    const first = coordinator.schedule(snapshot({ serializedProject: "one" }));
    const second = first.then(() => coordinator.schedule(snapshot({ serializedProject: "two" })));

    await expect(second).resolves.toMatchObject({ status: "stored", sequence: 2 });
    await coordinator.flush();
    expect(repository.records.map((record) => record.serializedProject)).toEqual(["one", "two"]);
  });

  it("exposes verified reads and closes the repository after an explicit clear", async () => {
    const repository = new MemoryRepository();
    repository.records.push(snapshot({ serializedProject: "verified" }));
    const coordinator = new WorkspaceRecoveryCoordinator(repository);

    expect(coordinator.currentGeneration()).toBe(0);
    await expect(coordinator.read()).resolves.toMatchObject({
      snapshot: { serializedProject: "verified" },
    });
    await expect(coordinator.readCandidates()).resolves.toMatchObject([
      { snapshot: { serializedProject: "verified" } },
    ]);

    await coordinator.clear();
    expect(coordinator.currentGeneration()).toBe(1);
    expect(repository.records).toEqual([]);
    await coordinator.dispose();
    expect(repository.disposed).toBe(true);
    expect(() => coordinator.schedule(snapshot())).toThrow("Workspace recovery coordinator is disposed");
  });

  it("reads the newer fallback snapshot after the primary write path fails", async () => {
    const primary = new ControllableRepository();
    const fallback = new ControllableRepository();
    await primary.write(snapshot({
      serializedProject: "old-primary",
      generation: 9,
      sequence: 99,
      createdAt: "2026-08-25T00:00:00.000Z",
    }));
    primary.failWrites = true;
    const repository = new FallbackWorkspaceRecoveryRepository(primary, fallback);

    await repository.write(snapshot({
      serializedProject: "new-fallback",
      generation: 0,
      sequence: 1,
      createdAt: "2026-08-26T00:00:00.000Z",
    }));

    await expect(repository.read()).resolves.toMatchObject({
      snapshot: { serializedProject: "new-fallback", sequence: 1 },
    });

    fallback.failReads = true;
    await expect(repository.read()).resolves.toMatchObject({
      snapshot: { serializedProject: "old-primary", sequence: 99 },
    });
  });

  it("reports a partial clear so stale recovery is never presented as dismissed", async () => {
    const primary = new ControllableRepository();
    const fallback = new ControllableRepository();
    await primary.write(snapshot({ serializedProject: "stale-primary" }));
    await fallback.write(snapshot({ serializedProject: "stale-fallback" }));
    primary.failClears = true;
    const repository = new FallbackWorkspaceRecoveryRepository(primary, fallback);

    await expect(repository.clear()).rejects.toThrow("clear unavailable");
    expect(fallback.records).toEqual([]);
    expect(primary.records).toHaveLength(1);
  });

  it("migrates legacy recovery only after verified readback", async () => {
    const repository = new MemoryRepository();
    const raw = JSON.stringify({
      version: 1,
      projectName: "Legacy",
      project: {
        projectId: "legacy-project",
        updatedAt: "2026-08-26T00:00:00.000Z",
        workspace: { revision: 8 },
      },
    });
    expect(legacyWorkspaceRecoverySnapshot(raw)).toMatchObject({
      projectName: "Legacy",
      projectId: "legacy-project",
      workspaceRevision: 8,
    });
    let removed = false;
    await expect(migrateLegacyWorkspaceRecovery(repository, raw, () => { removed = true; })).resolves.toBe(true);
    expect(removed).toBe(true);
    expect(repository.records).toHaveLength(1);
  });
});
