const DEFAULT_DATABASE_NAME = "semaframe-workspace-recovery-v3";
const STORE_NAME = "snapshots";
const CURRENT_SLOT = "current";
const PREVIOUS_SLOT = "previous";

export const WORKSPACE_RECOVERY_RECORD_VERSION = 1 as const;

export type WorkspaceRecoverySnapshot = Readonly<{
  projectName: string;
  serializedProject: string;
  projectId: string;
  workspaceRevision: number;
  generation: number;
  sequence: number;
  createdAt: string;
}>;

export type WorkspaceRecoveryRecord = WorkspaceRecoverySnapshot & Readonly<{
  slot: typeof CURRENT_SLOT | typeof PREVIOUS_SLOT;
  version: typeof WORKSPACE_RECOVERY_RECORD_VERSION;
  byteLength: number;
  sha256: `sha256:${string}`;
}>;

export type WorkspaceRecoveryReadResult = Readonly<{
  snapshot: WorkspaceRecoverySnapshot;
  source: typeof CURRENT_SLOT | typeof PREVIOUS_SLOT;
  recoveredFromPrevious: boolean;
}>;

export interface WorkspaceRecoveryRepository {
  read(): Promise<WorkspaceRecoveryReadResult | undefined>;
  readCandidates(): Promise<readonly WorkspaceRecoveryReadResult[]>;
  write(snapshot: WorkspaceRecoverySnapshot): Promise<WorkspaceRecoveryRecord>;
  clear(): Promise<void>;
  dispose(): void;
}

export class FallbackWorkspaceRecoveryRepository implements WorkspaceRecoveryRepository {
  private primaryReadUnavailable = false;
  private primaryWriteUnavailable = false;

  constructor(
    private readonly primary: WorkspaceRecoveryRepository,
    private readonly fallback: WorkspaceRecoveryRepository,
  ) {}

  async read(): Promise<WorkspaceRecoveryReadResult | undefined> {
    return (await this.readCandidates())[0];
  }

  async readCandidates(): Promise<readonly WorkspaceRecoveryReadResult[]> {
    let primaryCandidates: readonly WorkspaceRecoveryReadResult[] = [];
    let fallbackCandidates: readonly WorkspaceRecoveryReadResult[] = [];
    if (!this.primaryReadUnavailable) {
      try { primaryCandidates = await this.primary.readCandidates(); }
      catch { this.primaryReadUnavailable = true; }
    }
    try { fallbackCandidates = await this.fallback.readCandidates(); }
    catch (error) {
      if (primaryCandidates.length === 0) throw error;
    }

    const unique = new Map<string, WorkspaceRecoveryReadResult>();
    for (const candidate of [...primaryCandidates, ...fallbackCandidates]) {
      const key = snapshotIdentity(candidate.snapshot);
      const existing = unique.get(key);
      if (!existing || (existing.recoveredFromPrevious && !candidate.recoveredFromPrevious)) {
        unique.set(key, candidate);
      }
    }
    return sortRecoveryReadResults([...unique.values()]);
  }

  async write(snapshot: WorkspaceRecoverySnapshot): Promise<WorkspaceRecoveryRecord> {
    if (!this.primaryWriteUnavailable) {
      try { return await this.primary.write(snapshot); }
      catch {
        const record = await this.fallback.write(snapshot);
        // Keep reading both stores so a last-known-good primary remains a
        // candidate, but do not retry a failing primary on every keystroke.
        this.primaryWriteUnavailable = true;
        return record;
      }
    }
    return this.fallback.write(snapshot);
  }

  async clear(): Promise<void> {
    const results = await Promise.allSettled([this.primary.clear(), this.fallback.clear()]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  dispose(): void {
    this.primary.dispose();
    this.fallback.dispose();
  }
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type LocalStorageWorkspaceRecoveryRepositoryOptions = Readonly<{
  storage?: StorageLike;
  key?: string;
  digest?: (value: string) => Promise<`sha256:${string}`>;
}>;

export type IndexedDbWorkspaceRecoveryRepositoryOptions = Readonly<{
  indexedDBFactory?: IDBFactory;
  databaseName?: string;
  digest?: (value: string) => Promise<`sha256:${string}`>;
}>;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable for Workspace recovery");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...digest].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRecord(value: unknown): WorkspaceRecoveryRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<WorkspaceRecoveryRecord>;
  if (record.version !== WORKSPACE_RECOVERY_RECORD_VERSION ||
      ![CURRENT_SLOT, PREVIOUS_SLOT].includes(String(record.slot)) ||
      typeof record.projectName !== "string" || record.projectName.length > 256 ||
      typeof record.serializedProject !== "string" ||
      typeof record.projectId !== "string" || record.projectId.length === 0 || record.projectId.length > 256 ||
      !isFiniteNonNegativeInteger(record.workspaceRevision) ||
      !isFiniteNonNegativeInteger(record.generation) ||
      !isFiniteNonNegativeInteger(record.sequence) ||
      typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
      !isFiniteNonNegativeInteger(record.byteLength) ||
      typeof record.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.sha256)) return undefined;
  if (byteLength(record.serializedProject) !== record.byteLength) return undefined;
  return Object.freeze({ ...record }) as WorkspaceRecoveryRecord;
}

function publicSnapshot(record: WorkspaceRecoveryRecord): WorkspaceRecoverySnapshot {
  return Object.freeze({
    projectName: record.projectName,
    serializedProject: record.serializedProject,
    projectId: record.projectId,
    workspaceRevision: record.workspaceRevision,
    generation: record.generation,
    sequence: record.sequence,
    createdAt: record.createdAt,
  });
}

function compareRecoverySnapshotsNewestFirst(
  left: WorkspaceRecoverySnapshot,
  right: WorkspaceRecoverySnapshot,
): number {
  const capturedAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (capturedAt !== 0) return capturedAt;
  const generation = right.generation - left.generation;
  if (generation !== 0) return generation;
  const sequence = right.sequence - left.sequence;
  if (sequence !== 0) return sequence;
  const revision = right.workspaceRevision - left.workspaceRevision;
  if (revision !== 0) return revision;
  const leftIdentity = snapshotIdentity(left);
  const rightIdentity = snapshotIdentity(right);
  return leftIdentity === rightIdentity ? 0 : rightIdentity < leftIdentity ? -1 : 1;
}

function snapshotIdentity(snapshot: WorkspaceRecoverySnapshot): string {
  return [
    snapshot.projectId,
    snapshot.generation,
    snapshot.sequence,
    snapshot.createdAt,
    snapshot.projectName,
    snapshot.serializedProject,
  ].join("\u0000");
}

function recordIdentity(record: WorkspaceRecoveryRecord): string {
  return `${snapshotIdentity(record)}\u0000${record.sha256}`;
}

function newestDistinctRecords(records: readonly WorkspaceRecoveryRecord[]): readonly WorkspaceRecoveryRecord[] {
  const unique = new Map<string, WorkspaceRecoveryRecord>();
  for (const record of records) unique.set(recordIdentity(record), record);
  return [...unique.values()].sort(compareRecoverySnapshotsNewestFirst).slice(0, 2);
}

function sortRecoveryReadResults(
  candidates: readonly WorkspaceRecoveryReadResult[],
): readonly WorkspaceRecoveryReadResult[] {
  return Object.freeze([...candidates].sort((left, right) =>
    compareRecoverySnapshotsNewestFirst(left.snapshot, right.snapshot)));
}

export class LocalStorageWorkspaceRecoveryRepository implements WorkspaceRecoveryRepository {
  private readonly storage: StorageLike;
  private readonly key: string;
  private readonly digest: (value: string) => Promise<`sha256:${string}`>;
  private disposed = false;

  constructor(options: LocalStorageWorkspaceRecoveryRepositoryOptions = {}) {
    const storage = options.storage ?? globalThis.localStorage;
    if (!storage) throw new Error("Local storage is unavailable for Workspace recovery");
    this.storage = storage;
    this.key = options.key ?? "semaframe-workspace-recovery-v3-fallback";
    this.digest = options.digest ?? sha256;
  }

  async read(): Promise<WorkspaceRecoveryReadResult | undefined> {
    return (await this.readCandidates())[0];
  }

  async readCandidates(): Promise<readonly WorkspaceRecoveryReadResult[]> {
    this.assertOpen();
    let raw: string | null;
    try { raw = this.storage.getItem(this.key); } catch { return []; }
    if (!raw) return [];
    let envelope: { current?: unknown; previous?: unknown };
    try { envelope = JSON.parse(raw) as typeof envelope; } catch { return []; }
    const candidates: WorkspaceRecoveryReadResult[] = [];
    const current = await this.verifiedRecord(envelope.current);
    if (current) candidates.push(Object.freeze({ snapshot: publicSnapshot(current), source: CURRENT_SLOT, recoveredFromPrevious: false }));
    const previous = await this.verifiedRecord(envelope.previous);
    if (previous) candidates.push(Object.freeze({ snapshot: publicSnapshot(previous), source: PREVIOUS_SLOT, recoveredFromPrevious: true }));
    return sortRecoveryReadResults(candidates);
  }

  async write(snapshot: WorkspaceRecoverySnapshot): Promise<WorkspaceRecoveryRecord> {
    this.assertOpen();
    const record: WorkspaceRecoveryRecord = Object.freeze({
      ...snapshot,
      slot: CURRENT_SLOT,
      version: WORKSPACE_RECOVERY_RECORD_VERSION,
      byteLength: byteLength(snapshot.serializedProject),
      sha256: await this.digest(snapshot.serializedProject),
    });
    if (!parseRecord(record)) throw new Error("Workspace recovery snapshot is invalid");
    let envelope: { current?: unknown; previous?: unknown } = {};
    try {
      const raw = this.storage.getItem(this.key);
      if (raw) envelope = JSON.parse(raw) as typeof envelope;
    } catch { /* the new verified snapshot can still replace an unreadable envelope */ }
    const existing = [parseRecord(envelope.current), parseRecord(envelope.previous)]
      .filter((candidate): candidate is WorkspaceRecoveryRecord => Boolean(candidate));
    const ranked = newestDistinctRecords([record, ...existing]);
    const current = ranked[0] ? Object.freeze({ ...ranked[0], slot: CURRENT_SLOT }) : undefined;
    const previous = ranked[1] ? Object.freeze({ ...ranked[1], slot: PREVIOUS_SLOT }) : undefined;
    this.storage.setItem(this.key, JSON.stringify({ current, previous }));
    const recordIndex = ranked.findIndex((candidate) => recordIdentity(candidate) === recordIdentity(record));
    return recordIndex === 0 ? (current ?? record) : recordIndex === 1 ? (previous ?? record) : (current ?? record);
  }

  async clear(): Promise<void> {
    this.assertOpen();
    this.storage.removeItem(this.key);
  }

  dispose(): void { this.disposed = true; }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Workspace recovery repository is disposed");
  }

  private async verifiedRecord(value: unknown): Promise<WorkspaceRecoveryRecord | undefined> {
    const record = parseRecord(value);
    if (!record) return undefined;
    return await this.digest(record.serializedProject) === record.sha256 ? record : undefined;
  }
}

export class IndexedDbWorkspaceRecoveryRepository implements WorkspaceRecoveryRepository {
  private readonly indexedDBFactory: IDBFactory;
  private readonly databaseName: string;
  private readonly digest: (value: string) => Promise<`sha256:${string}`>;
  private databasePromise: Promise<IDBDatabase> | undefined;
  private disposed = false;

  constructor(options: IndexedDbWorkspaceRecoveryRepositoryOptions = {}) {
    const factory = options.indexedDBFactory ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is unavailable for Workspace recovery");
    if (options.databaseName !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/u.test(options.databaseName)) {
      throw new Error("Workspace recovery database name is invalid");
    }
    this.indexedDBFactory = factory;
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.digest = options.digest ?? sha256;
  }

  async read(): Promise<WorkspaceRecoveryReadResult | undefined> {
    return (await this.readCandidates())[0];
  }

  async readCandidates(): Promise<readonly WorkspaceRecoveryReadResult[]> {
    this.assertOpen();
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const [currentValue, previousValue] = await Promise.all([
      requestResult(store.get(CURRENT_SLOT)),
      requestResult(store.get(PREVIOUS_SLOT)),
    ]);
    await done;
    const candidates: WorkspaceRecoveryReadResult[] = [];
    const current = await this.verifiedRecord(currentValue);
    if (current) candidates.push(Object.freeze({
      snapshot: publicSnapshot(current), source: CURRENT_SLOT, recoveredFromPrevious: false,
    }));
    const previous = await this.verifiedRecord(previousValue);
    if (previous) candidates.push(Object.freeze({
      snapshot: publicSnapshot(previous), source: PREVIOUS_SLOT, recoveredFromPrevious: true,
    }));
    return sortRecoveryReadResults(candidates);
  }

  async write(snapshot: WorkspaceRecoverySnapshot): Promise<WorkspaceRecoveryRecord> {
    this.assertOpen();
    const serializedProject = snapshot.serializedProject;
    const record: WorkspaceRecoveryRecord = Object.freeze({
      ...snapshot,
      slot: CURRENT_SLOT,
      version: WORKSPACE_RECOVERY_RECORD_VERSION,
      byteLength: byteLength(serializedProject),
      sha256: await this.digest(serializedProject),
    });
    const parsed = parseRecord(record);
    if (!parsed) throw new Error("Workspace recovery snapshot is invalid");
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const currentRequest = store.get(CURRENT_SLOT);
    const previousRequest = store.get(PREVIOUS_SLOT);
    let durableRecord: WorkspaceRecoveryRecord = record;
    await new Promise<void>((resolve, reject) => {
      let remaining = 2;
      const abort = (error: unknown): void => {
        reject(error);
        try { transaction.abort(); } catch { /* transaction may already be closing */ }
      };
      const rankAndWrite = (): void => {
        remaining -= 1;
        if (remaining > 0) return;
        try {
          const candidates = [
            record,
            parseRecord(currentRequest.result),
            parseRecord(previousRequest.result),
          ].filter((candidate): candidate is WorkspaceRecoveryRecord => Boolean(candidate));
          const ranked = newestDistinctRecords(candidates);
          const current = Object.freeze({ ...ranked[0]!, slot: CURRENT_SLOT });
          const previous = ranked[1] ? Object.freeze({ ...ranked[1], slot: PREVIOUS_SLOT }) : undefined;
          store.put(current);
          if (previous) store.put(previous);
          else store.delete(PREVIOUS_SLOT);
          const recordIndex = ranked.findIndex((candidate) => recordIdentity(candidate) === recordIdentity(record));
          durableRecord = recordIndex === 0 ? current : recordIndex === 1 ? previous! : current;
          resolve();
        } catch (error) {
          abort(error);
        }
      };
      currentRequest.onsuccess = rankAndWrite;
      previousRequest.onsuccess = rankAndWrite;
      currentRequest.onerror = () => abort(currentRequest.error ?? new Error("Workspace recovery head could not be read"));
      previousRequest.onerror = () => abort(previousRequest.error ?? new Error("Workspace recovery fallback could not be read"));
    });
    await done;
    return durableRecord;
  }

  async clear(): Promise<void> {
    this.assertOpen();
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    store.delete(CURRENT_SLOT);
    store.delete(PREVIOUS_SLOT);
    await done;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.databasePromise?.then((database) => database.close()).catch(() => undefined);
    this.databasePromise = undefined;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Workspace recovery repository is disposed");
  }

  private async verifiedRecord(value: unknown): Promise<WorkspaceRecoveryRecord | undefined> {
    const record = parseRecord(value);
    if (!record) return undefined;
    const digest = await this.digest(record.serializedProject);
    return digest === record.sha256 ? record : undefined;
  }

  private database(): Promise<IDBDatabase> {
    this.assertOpen();
    this.databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDBFactory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "slot" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Workspace recovery database could not open"));
      request.onblocked = () => reject(new Error("Workspace recovery database upgrade was blocked"));
    });
    return this.databasePromise;
  }
}

export function legacyWorkspaceRecoverySnapshot(raw: string): WorkspaceRecoverySnapshot | undefined {
  try {
    const value = JSON.parse(raw) as {
      version?: unknown;
      projectName?: unknown;
      project?: { projectId?: unknown; workspace?: { revision?: unknown }; updatedAt?: unknown };
    };
    if (value.version !== 1 || typeof value.projectName !== "string" || !value.project ||
        typeof value.project.projectId !== "string") return undefined;
    const revision = value.project.workspace?.revision;
    if (!isFiniteNonNegativeInteger(revision)) return undefined;
    return Object.freeze({
      projectName: value.projectName,
      serializedProject: JSON.stringify(value.project),
      projectId: value.project.projectId,
      workspaceRevision: revision,
      generation: 0,
      sequence: 0,
      createdAt: typeof value.project.updatedAt === "string" && Number.isFinite(Date.parse(value.project.updatedAt))
        ? value.project.updatedAt
        : new Date(0).toISOString(),
    });
  } catch {
    return undefined;
  }
}

export async function migrateLegacyWorkspaceRecovery(
  repository: WorkspaceRecoveryRepository,
  raw: string,
  removeLegacy: () => void | Promise<void>,
): Promise<boolean> {
  const legacy = legacyWorkspaceRecoverySnapshot(raw);
  if (!legacy) return false;
  const written = await repository.write(legacy);
  const verified = await repository.read();
  if (!verified || verified.snapshot.serializedProject !== legacy.serializedProject ||
      verified.snapshot.projectId !== legacy.projectId || verified.snapshot.projectName !== legacy.projectName ||
      verified.snapshot.sequence !== written.sequence) {
    throw new Error("Migrated Workspace recovery could not be verified");
  }
  await removeLegacy();
  return true;
}
