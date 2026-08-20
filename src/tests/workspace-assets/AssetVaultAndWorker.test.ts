import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryAssetVault,
  BrowserAssetVault,
  digestBlobSha256,
  inspectRealityAsset,
  preflightRealityAssetInWorker,
  type RealityAssetWorkerRequest,
  type RealityAssetWorkerResponse,
} from "../../workspace/assets";
import { asciiPly, VALID_ROW } from "./fixtures";

class FakeWorker {
  onmessage: ((event: MessageEvent<RealityAssetWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  posted?: RealityAssetWorkerRequest;

  constructor(
    private readonly candidate?: Awaited<ReturnType<typeof inspectRealityAsset>>,
    private readonly respond = true,
  ) {}

  postMessage(request: RealityAssetWorkerRequest): void {
    this.posted = request;
    if (!this.respond || !this.candidate || request.type !== "reality-asset/inspect") return;
    queueMicrotask(() => this.onmessage?.({
      data: { type: "reality-asset/result", requestId: request.requestId, candidate: this.candidate! },
    } as MessageEvent<RealityAssetWorkerResponse>));
  }

  terminate(): void { this.terminated = true; }
}

class FakeIdbRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => unknown) | null = null;
  onblocked: ((event: IDBVersionChangeEvent) => unknown) | null = null;
}

class FakeIdbTransaction {
  error: DOMException | null = null;
  oncomplete: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onabort: ((event: Event) => unknown) | null = null;

  constructor(private readonly records: Map<string, unknown>) {}

  objectStore(): IDBObjectStore {
    const complete = (): void => queueMicrotask(() => this.oncomplete?.(new Event("complete")));
    return {
      get: (key: IDBValidKey) => {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
          request.result = this.records.get(String(key));
          request.onsuccess?.(new Event("success"));
        });
        return request as unknown as IDBRequest;
      },
      getAll: () => {
        const request = new FakeIdbRequest<unknown[]>();
        queueMicrotask(() => {
          request.result = [...this.records.values()];
          request.onsuccess?.(new Event("success"));
        });
        return request as unknown as IDBRequest;
      },
      put: (value: unknown) => {
        this.records.set((value as { assetId: string }).assetId, value);
        complete();
        return new FakeIdbRequest() as unknown as IDBRequest;
      },
      delete: (key: IDBValidKey) => {
        this.records.delete(String(key));
        complete();
        return new FakeIdbRequest() as unknown as IDBRequest;
      },
    } as unknown as IDBObjectStore;
  }
}

class FakeIdbDatabase {
  readonly records = new Map<string, unknown>();
  readonly objectStoreNames = { contains: () => this.created } as unknown as DOMStringList;
  private created = false;

  createObjectStore(): IDBObjectStore {
    this.created = true;
    return {} as IDBObjectStore;
  }

  transaction(): IDBTransaction {
    return new FakeIdbTransaction(this.records) as unknown as IDBTransaction;
  }

  close(): void {}
}

class FakeIdbFactory {
  readonly database = new FakeIdbDatabase();

  open(): IDBOpenDBRequest {
    const request = new FakeIdbRequest<IDBDatabase>();
    queueMicrotask(() => {
      request.result = this.database as unknown as IDBDatabase;
      request.onupgradeneeded?.({} as IDBVersionChangeEvent);
      request.onsuccess?.(new Event("success"));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

class FakeOpfsDirectory {
  readonly files = new Map<string, Blob>();

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    if (!options?.create && !this.files.has(name)) throw new DOMException("Missing", "NotFoundError");
    return {
      createWritable: async () => ({
        write: async (data: Blob) => { this.files.set(name, data); },
        close: async () => undefined,
        abort: async () => undefined,
      }),
      getFile: async () => this.files.get(name) as File,
    } as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }
}

afterEach(() => vi.useRealTimers());

describe("Reality AssetVault and disposable Worker seam", () => {
  it("stores by verified content address, deduplicates, and strips File identity", async () => {
    const original = asciiPly([VALID_ROW]);
    const file = new File([original], "private-site-scan.ply", { type: "application/octet-stream" });
    const candidate = await inspectRealityAsset(file);
    const vault = new MemoryAssetVault();
    await expect(vault.put(candidate, file)).resolves.toMatchObject({ deduplicated: false });
    await expect(vault.put(candidate, file)).resolves.toMatchObject({ deduplicated: true });
    const stored = await vault.open(candidate.descriptor.assetId);
    expect(stored).toBeInstanceOf(Blob);
    expect(stored).not.toBeInstanceOf(File);
    expect(stored.type).toBe("application/ply");
    expect(await digestBlobSha256(stored)).toBe(await digestBlobSha256(original));
    expect(await vault.listDescriptors()).toEqual([candidate.descriptor]);
    expect(await vault.delete(candidate.descriptor.assetId)).toBe(true);
    await expect(vault.open(candidate.descriptor.assetId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects bytes changed after host inspection and honors cancellation", async () => {
    const blob = asciiPly([VALID_ROW]);
    const candidate = await inspectRealityAsset(blob);
    const vault = new MemoryAssetVault();
    await expect(vault.put(candidate, new Blob([blob, " "])))
      .rejects.toMatchObject({ code: "digest_mismatch" });
    const controller = new AbortController();
    controller.abort();
    await expect(vault.put(candidate, blob, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "aborted" });
  });

  it("persists through IndexedDB fallback and OPFS without retaining File names", async () => {
    const file = new File([asciiPly([VALID_ROW])], "private-capture.ply");
    const candidate = await inspectRealityAsset(file);

    const fallbackFactory = new FakeIdbFactory();
    const fallback = new BrowserAssetVault({
      indexedDBFactory: fallbackFactory as unknown as IDBFactory,
      preferOpfs: false,
      databaseName: "test-reality-fallback",
    });
    await expect(fallback.put(candidate, file)).resolves.toMatchObject({ deduplicated: false });
    expect(await fallback.getDescriptor(candidate.descriptor.assetId)).toEqual(candidate.descriptor);
    expect(await fallback.open(candidate.descriptor.assetId)).not.toBeInstanceOf(File);
    expect(await fallback.listDescriptors()).toEqual([candidate.descriptor]);
    fallback.dispose();

    const opfsFactory = new FakeIdbFactory();
    const opfsDirectory = new FakeOpfsDirectory();
    const opfs = new BrowserAssetVault({
      indexedDBFactory: opfsFactory as unknown as IDBFactory,
      storageManager: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => opfsDirectory,
        } as unknown as FileSystemDirectoryHandle),
      } as StorageManager & { getDirectory: () => Promise<FileSystemDirectoryHandle> },
      databaseName: "test-reality-opfs",
    });
    await expect(opfs.put(candidate, file)).resolves.toMatchObject({ deduplicated: false });
    expect(opfsDirectory.files.size).toBe(1);
    expect(await opfs.open(candidate.descriptor.assetId)).not.toBeInstanceOf(File);
    expect(await opfs.delete(candidate.descriptor.assetId)).toBe(true);
    expect(opfsDirectory.files.size).toBe(0);
    opfs.dispose();
  });

  it("terminates its disposable Worker after success", async () => {
    const blob = asciiPly([VALID_ROW]);
    const candidate = await inspectRealityAsset(blob);
    const worker = new FakeWorker(candidate);
    await expect(preflightRealityAssetInWorker(blob, { workerFactory: () => worker as unknown as Worker }))
      .resolves.toEqual(candidate);
    expect(worker.posted).toMatchObject({ type: "reality-asset/inspect", blob });
    expect(worker.terminated).toBe(true);
  });

  it("hard-stops its Worker on abort and timeout", async () => {
    const blob = asciiPly([VALID_ROW]);
    const worker = new FakeWorker(undefined, false);
    const controller = new AbortController();
    const pending = preflightRealityAssetInWorker(blob, {
      signal: controller.signal,
      workerFactory: () => worker as unknown as Worker,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(worker.terminated).toBe(true);

    vi.useFakeTimers();
    const timeoutWorker = new FakeWorker(undefined, false);
    const timed = preflightRealityAssetInWorker(blob, {
      timeoutMs: 10,
      workerFactory: () => timeoutWorker as unknown as Worker,
    });
    const rejected = expect(timed).rejects.toMatchObject({ code: "operation_timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(timeoutWorker.terminated).toBe(true);
  });
});
