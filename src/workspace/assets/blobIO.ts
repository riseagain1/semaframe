import { RealityAssetError, throwIfRealityAssetAborted } from "./errors";

export async function readBlobRange(
  blob: Blob,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > blob.size) {
    throw new RealityAssetError("invalid_format", "Reality asset contains an invalid byte range");
  }
  throwIfRealityAssetAborted(signal);
  const slice = blob.slice(start, end);
  let buffer: ArrayBuffer;
  if (typeof slice.arrayBuffer === "function") {
    buffer = await slice.arrayBuffer();
  } else if (typeof FileReader !== "undefined") {
    buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      let settled = false;
      const cleanup = (): void => signal?.removeEventListener("abort", abort);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const abort = (): void => {
        try { reader.abort(); } catch { /* FileReader may not have started. */ }
        finish(() => reject(new RealityAssetError("aborted", "Reality asset operation was cancelled")));
      };
      reader.onload = () => finish(() => {
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new RealityAssetError("invalid_format", "Reality asset bytes could not be read"));
          return;
        }
        resolve(reader.result);
      });
      reader.onerror = () => finish(() => reject(new RealityAssetError(
        "invalid_format",
        "Reality asset bytes could not be read",
        { cause: reader.error ?? undefined },
      )));
      reader.onabort = () => finish(() => reject(new RealityAssetError("aborted", "Reality asset operation was cancelled")));
      signal?.addEventListener("abort", abort, { once: true });
      reader.readAsArrayBuffer(slice);
    });
  } else {
    throw new RealityAssetError("invalid_format", "This runtime cannot read Reality asset bytes");
  }
  const bytes = new Uint8Array(buffer);
  throwIfRealityAssetAborted(signal);
  if (bytes.byteLength !== end - start) {
    throw new RealityAssetError("invalid_format", "Reality asset ended unexpectedly");
  }
  return bytes;
}

export function checkedAdd(left: number, right: number, message: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) {
    throw new RealityAssetError("invalid_format", message);
  }
  return result;
}

export function checkedMultiply(left: number, right: number, message: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || (left !== 0 && result / left !== right)) {
    throw new RealityAssetError("invalid_format", message);
  }
  return result;
}

export function boundedUint64(view: DataView, offset: number, maximum: number, message: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(maximum)) throw new RealityAssetError("invalid_format", message);
  return Number(value);
}
