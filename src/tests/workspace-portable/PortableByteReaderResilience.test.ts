import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32Blob, readPortableBlobRange } from "../../workspace/persistence/portable/crc32";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

class ControlledFileReader {
  static last: ControlledFileReader;
  result: ArrayBuffer | string | null = null;
  error: DOMException | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  abort = vi.fn(() => { this.onabort?.(); });
  constructor() { ControlledFileReader.last = this; }
  readAsArrayBuffer = vi.fn();
}

function legacyBlob(): Blob {
  return { size: 3, slice: vi.fn(() => ({})) } as unknown as Blob;
}

describe("portable byte reader failure boundaries", () => {
  it.each([[NaN, 1], [0, Infinity], [-1, 1], [2, 1], [0, 4]])("rejects invalid range %s..%s before reading", async (start, end) => {
    const blob = legacyBlob();
    await expect(readPortableBlobRange(blob, start!, end!)).rejects.toMatchObject({ code: "archive_corrupt" });
    expect(blob.slice).not.toHaveBeenCalled();
  });

  it("rejects unsupported readers and truncated arrayBuffer results", async () => {
    vi.stubGlobal("FileReader", undefined);
    await expect(readPortableBlobRange(legacyBlob(), 0, 3)).rejects.toMatchObject({ code: "unsupported_archive" });
    const truncated = { size: 3, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(2) }) } as unknown as Blob;
    await expect(readPortableBlobRange(truncated, 0, 3)).rejects.toThrow("ended unexpectedly");
  });

  it("rejects non-buffer FileReader results and ignores late terminal events", async () => {
    vi.stubGlobal("FileReader", ControlledFileReader);
    const pending = readPortableBlobRange(legacyBlob(), 0, 3);
    const assertion = expect(pending).rejects.toMatchObject({ code: "archive_corrupt" });
    ControlledFileReader.last.result = "unexpected text";
    ControlledFileReader.last.onload?.();
    ControlledFileReader.last.onerror?.();
    await assertion;
  });

  it.each([false, true])("preserves FileReader error semantics (provided error: %s)", async (hasError) => {
    vi.stubGlobal("FileReader", ControlledFileReader);
    const pending = readPortableBlobRange(legacyBlob(), 0, 3);
    const assertion = expect(pending).rejects.toMatchObject({ code: "archive_corrupt" });
    const error = hasError ? new DOMException("disk failed", "NotReadableError") : null;
    ControlledFileReader.last.error = error;
    ControlledFileReader.last.onerror?.();
    await assertion;
    await pending.catch((actual: Error) => expect(actual.cause).toBe(error ?? undefined));
  });

  it("cancels an in-flight FileReader, removes the listener, and ignores subsequent completion", async () => {
    vi.stubGlobal("FileReader", ControlledFileReader);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = readPortableBlobRange(legacyBlob(), 0, 3, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "aborted" });
    controller.abort();
    expect(ControlledFileReader.last.abort).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    ControlledFileReader.last.result = new ArrayBuffer(3);
    ControlledFileReader.last.onload?.();
    await assertion;
  });

  it("still rejects cancellation if the native abort method throws", async () => {
    vi.stubGlobal("FileReader", ControlledFileReader);
    const controller = new AbortController();
    const pending = readPortableBlobRange(legacyBlob(), 0, 3, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "aborted" });
    ControlledFileReader.last.abort.mockImplementation(() => { throw new Error("reader already closed"); });
    controller.abort();
    await assertion;
  });

  it("honors native read abort and cancellation during arrayBuffer reading", async () => {
    vi.stubGlobal("FileReader", ControlledFileReader);
    const nativePending = readPortableBlobRange(legacyBlob(), 0, 3);
    const assertion = expect(nativePending).rejects.toMatchObject({ code: "aborted" });
    ControlledFileReader.last.onabort?.();
    await assertion;
    const controller = new AbortController();
    const blob = { size: 3, slice: () => ({ arrayBuffer: async () => {
      controller.abort(); return new ArrayBuffer(3);
    } }) } as unknown as Blob;
    await expect(readPortableBlobRange(blob, 0, 3, controller.signal)).rejects.toMatchObject({ code: "aborted" });
  });

  it("validates CRC chunk sizes and checks cancellation even for an empty archive", async () => {
    for (const chunkBytes of [NaN, 1023, Number.MAX_SAFE_INTEGER]) {
      await expect(crc32Blob(new Blob(), { chunkBytes })).rejects.toMatchObject({ code: "size_limit_exceeded" });
    }
    await expect(crc32Blob(new Blob())).resolves.toBe(0);
    const controller = new AbortController();
    controller.abort();
    await expect(crc32Blob(new Blob(), { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  });
});
