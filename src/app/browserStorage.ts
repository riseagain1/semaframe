type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(storage?: StorageLike): StorageLike {
  return storage ?? globalThis.localStorage;
}

export function safeStorageGet(key: string, storage?: StorageLike): string | null {
  try { return browserStorage(storage).getItem(key); } catch { return null; }
}

export function safeStorageSet(key: string, value: string, storage?: StorageLike): boolean {
  try { browserStorage(storage).setItem(key, value); return true; } catch { return false; }
}

export function safeStorageRemove(key: string, storage?: StorageLike): boolean {
  try { browserStorage(storage).removeItem(key); return true; } catch { return false; }
}
