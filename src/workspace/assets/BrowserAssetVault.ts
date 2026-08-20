import type { AssetVault, AssetVaultOperationOptions } from "./AssetVault";
import { RealityAssetError, throwIfRealityAssetAborted } from "./errors";
import type {
  PutRealityAssetResult,
  RealityAssetCandidate,
  RealityAssetDescriptor,
  RealityAssetId,
} from "./types";
import { parseRealityAssetDescriptor } from "./validation";
import { descriptorsEquivalent, verifyVaultPut } from "./vaultSafety";

const DEFAULT_DATABASE_NAME = "semaframe-reality-assets-v1";
const DEFAULT_STORE_NAME = "assets";
const OPFS_DIRECTORY_NAME = "semaframe-reality-assets-v1";

type StoredAssetRecord = Readonly<{
  assetId: RealityAssetId;
  descriptor: RealityAssetDescriptor;
  backend: "idb" | "opfs";
  blob?: Blob;
}>;

type StorageManagerWithOpfs = StorageManager & Readonly<{
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}>;

export type BrowserAssetVaultOptions = Readonly<{
  indexedDBFactory?: IDBFactory;
  storageManager?: StorageManagerWithOpfs;
  databaseName?: string;
  preferOpfs?: boolean;
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

function safeOpfsName(assetId: RealityAssetId): string {
  return `${assetId}.bin`;
}

/**
 * Persistent browser vault. Metadata always lives in IndexedDB. Bytes use
 * origin-private file storage when available and otherwise a sanitized Blob in
 * IndexedDB. No user-provided path or File name is ever persisted.
 */
export class BrowserAssetVault implements AssetVault {
  private readonly indexedDBFactory: IDBFactory;
  private readonly storageManager: StorageManagerWithOpfs | undefined;
  private readonly databaseName: string;
  private readonly preferOpfs: boolean;
  private databasePromise: Promise<IDBDatabase> | undefined;
  private opfsDirectoryPromise: Promise<FileSystemDirectoryHandle | undefined> | undefined;
  private disposed = false;

  constructor(options: BrowserAssetVaultOptions = {}) {
    const factory = options.indexedDBFactory ?? globalThis.indexedDB;
    if (!factory) throw new RealityAssetError("storage_unavailable", "IndexedDB is unavailable for Reality assets");
    if (options.databaseName !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(options.databaseName)) {
      throw new RealityAssetError("invalid_descriptor", "Reality asset database name is invalid");
    }
    this.indexedDBFactory = factory;
    this.storageManager = options.storageManager
      ?? (globalThis.navigator?.storage as StorageManagerWithOpfs | undefined);
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.preferOpfs = options.preferOpfs ?? true;
  }

  async put(
    candidate: RealityAssetCandidate,
    blob: Blob,
    options: AssetVaultOperationOptions = {},
  ): Promise<PutRealityAssetResult> {
    this.assertOpen();
    const verified = await verifyVaultPut(candidate, blob, options);
    const existing = await this.getRecord(verified.descriptor.assetId);
    if (existing) {
      if (!descriptorsEquivalent(existing.descriptor, verified.descriptor)) {
        throw new RealityAssetError("digest_mismatch", "Content-addressed asset metadata is inconsistent");
      }
      return Object.freeze({ descriptor: existing.descriptor, deduplicated: true });
    }
    throwIfRealityAssetAborted(options.signal);
    const directory = await this.opfsDirectory();
    let record: StoredAssetRecord;
    let opfsWritten = false;
    if (directory) {
      try {
        const handle = await directory.getFileHandle(safeOpfsName(verified.descriptor.assetId), { create: true });
        const writable = await handle.createWritable();
        try {
          throwIfRealityAssetAborted(options.signal);
          await writable.write(verified.sanitizedBlob);
          throwIfRealityAssetAborted(options.signal);
          await writable.close();
          opfsWritten = true;
        } catch (error) {
          await writable.abort(error).catch(() => undefined);
          await directory.removeEntry(safeOpfsName(verified.descriptor.assetId)).catch(() => undefined);
          throw error;
        }
        record = Object.freeze({
          assetId: verified.descriptor.assetId,
          descriptor: verified.descriptor,
          backend: "opfs",
        });
      } catch (error) {
        if (error instanceof RealityAssetError && error.code === "aborted") throw error;
        // A denied/quota-limited OPFS write safely falls back to IndexedDB.
        record = Object.freeze({
          assetId: verified.descriptor.assetId,
          descriptor: verified.descriptor,
          backend: "idb",
          blob: verified.sanitizedBlob,
        });
      }
    } else {
      record = Object.freeze({
        assetId: verified.descriptor.assetId,
        descriptor: verified.descriptor,
        backend: "idb",
        blob: verified.sanitizedBlob,
      });
    }

    try {
      await this.putRecord(record);
    } catch (error) {
      if (opfsWritten && directory) {
        await directory.removeEntry(safeOpfsName(verified.descriptor.assetId)).catch(() => undefined);
      }
      throw new RealityAssetError("storage_failure", "Reality asset metadata could not be persisted", { cause: error });
    }
    return Object.freeze({ descriptor: verified.descriptor, deduplicated: false });
  }

  async has(assetId: RealityAssetId): Promise<boolean> {
    this.assertOpen();
    return (await this.getRecord(assetId)) !== undefined;
  }

  async getDescriptor(assetId: RealityAssetId): Promise<RealityAssetDescriptor | undefined> {
    this.assertOpen();
    return (await this.getRecord(assetId))?.descriptor;
  }

  async open(assetId: RealityAssetId): Promise<Blob> {
    this.assertOpen();
    const record = await this.getRecord(assetId);
    if (!record) throw new RealityAssetError("not_found", "Reality asset is not available in the local vault");
    if (record.backend === "idb") {
      if (!(record.blob instanceof Blob) || record.blob.size !== record.descriptor.byteLength) {
        throw new RealityAssetError("storage_failure", "Reality asset bytes are unavailable");
      }
      return record.blob.slice(0, record.blob.size, record.descriptor.mediaType);
    }
    const directory = await this.opfsDirectory();
    if (!directory) throw new RealityAssetError("storage_failure", "Origin-private Reality asset storage is unavailable");
    try {
      const handle = await directory.getFileHandle(safeOpfsName(assetId));
      const file = await handle.getFile();
      if (file.size !== record.descriptor.byteLength) {
        throw new RealityAssetError("storage_failure", "Reality asset bytes are inconsistent");
      }
      return file.slice(0, file.size, record.descriptor.mediaType);
    } catch (error) {
      if (error instanceof RealityAssetError) throw error;
      throw new RealityAssetError("not_found", "Reality asset bytes are missing from local storage", { cause: error });
    }
  }

  async listDescriptors(): Promise<readonly RealityAssetDescriptor[]> {
    this.assertOpen();
    try {
      const database = await this.database();
      const transaction = database.transaction(DEFAULT_STORE_NAME, "readonly");
      const records = await requestResult(transaction.objectStore(DEFAULT_STORE_NAME).getAll()) as StoredAssetRecord[];
      return Object.freeze(records
        .map((record) => parseRealityAssetDescriptor(record.descriptor))
        .sort((left, right) => left.assetId.localeCompare(right.assetId)));
    } catch (error) {
      if (error instanceof RealityAssetError) throw error;
      throw new RealityAssetError("storage_failure", "Reality asset metadata could not be listed", { cause: error });
    }
  }

  async delete(assetId: RealityAssetId): Promise<boolean> {
    this.assertOpen();
    const record = await this.getRecord(assetId);
    if (!record) return false;
    try {
      const database = await this.database();
      const transaction = database.transaction(DEFAULT_STORE_NAME, "readwrite");
      transaction.objectStore(DEFAULT_STORE_NAME).delete(assetId);
      await transactionDone(transaction);
      if (record.backend === "opfs") {
        const directory = await this.opfsDirectory();
        await directory?.removeEntry(safeOpfsName(assetId)).catch(() => undefined);
      }
      return true;
    } catch (error) {
      throw new RealityAssetError("storage_failure", "Reality asset could not be deleted", { cause: error });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.databasePromise?.then((database) => database.close()).catch(() => undefined);
    this.databasePromise = undefined;
    this.opfsDirectoryPromise = undefined;
  }

  private assertOpen(): void {
    if (this.disposed) throw new RealityAssetError("storage_failure", "Reality asset vault has been disposed");
  }

  private database(): Promise<IDBDatabase> {
    this.assertOpen();
    this.databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDBFactory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DEFAULT_STORE_NAME)) {
          request.result.createObjectStore(DEFAULT_STORE_NAME, { keyPath: "assetId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB could not open"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade was blocked"));
    });
    return this.databasePromise;
  }

  private async opfsDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
    if (!this.preferOpfs || typeof this.storageManager?.getDirectory !== "function") return undefined;
    this.opfsDirectoryPromise ??= this.storageManager.getDirectory()
      .then((root) => root.getDirectoryHandle(OPFS_DIRECTORY_NAME, { create: true }))
      .catch(() => undefined);
    return this.opfsDirectoryPromise;
  }

  private async getRecord(assetId: RealityAssetId): Promise<StoredAssetRecord | undefined> {
    try {
      const database = await this.database();
      const transaction = database.transaction(DEFAULT_STORE_NAME, "readonly");
      const stored = await requestResult(transaction.objectStore(DEFAULT_STORE_NAME).get(assetId)) as StoredAssetRecord | undefined;
      if (!stored) return undefined;
      if (stored.assetId !== assetId || !["idb", "opfs"].includes(stored.backend)) {
        throw new RealityAssetError("storage_failure", "Reality asset metadata is corrupt");
      }
      return Object.freeze({ ...stored, descriptor: parseRealityAssetDescriptor(stored.descriptor) });
    } catch (error) {
      if (error instanceof RealityAssetError) throw error;
      throw new RealityAssetError("storage_failure", "Reality asset metadata could not be read", { cause: error });
    }
  }

  private async putRecord(record: StoredAssetRecord): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(DEFAULT_STORE_NAME, "readwrite");
    transaction.objectStore(DEFAULT_STORE_NAME).put(record);
    await transactionDone(transaction);
  }
}
