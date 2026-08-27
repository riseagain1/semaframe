import { PORTABLE_PROJECT_LIMITS } from "./constants";
import { PortableProjectError, throwIfPortableProjectAborted } from "./errors";

export class IncrementalCrc32 {
  private state = 0xffffffff;

  update(bytes: Uint8Array): void {
    let crc = this.state;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    this.state = crc;
  }

  value(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }
}

async function readRange(blob: Blob, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfPortableProjectAborted(signal);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > blob.size) {
    throw new PortableProjectError("archive_corrupt", "Portable archive contains an invalid byte range");
  }
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
        try { reader.abort(); } catch { /* no-op */ }
        finish(() => reject(new PortableProjectError("aborted", "Portable project operation was cancelled")));
      };
      reader.onload = () => finish(() => {
        if (reader.result instanceof ArrayBuffer) resolve(reader.result);
        else reject(new PortableProjectError("archive_corrupt", "Portable archive bytes could not be read"));
      });
      reader.onerror = () => finish(() => reject(new PortableProjectError(
        "archive_corrupt",
        "Portable archive bytes could not be read",
        { cause: reader.error ?? undefined },
      )));
      reader.onabort = () => finish(() => reject(new PortableProjectError(
        "aborted",
        "Portable project operation was cancelled",
      )));
      signal?.addEventListener("abort", abort, { once: true });
      reader.readAsArrayBuffer(slice);
    });
  } else {
    throw new PortableProjectError("unsupported_archive", "This runtime cannot read portable project bytes");
  }
  throwIfPortableProjectAborted(signal);
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== end - start) {
    throw new PortableProjectError("archive_corrupt", "Portable archive ended unexpectedly");
  }
  return bytes;
}

export async function crc32Blob(
  blob: Blob,
  options: Readonly<{ signal?: AbortSignal; chunkBytes?: number }> = {},
): Promise<number> {
  const chunkBytes = options.chunkBytes ?? PORTABLE_PROJECT_LIMITS.ioChunkBytes;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > PORTABLE_PROJECT_LIMITS.maximumAssetBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Portable archive CRC chunk size is invalid");
  }
  const crc = new IncrementalCrc32();
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const end = Math.min(blob.size, offset + chunkBytes);
    crc.update(await readRange(blob, offset, end, options.signal));
  }
  throwIfPortableProjectAborted(options.signal);
  return crc.value();
}

export { readRange as readPortableBlobRange };
