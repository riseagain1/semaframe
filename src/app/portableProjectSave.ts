import {
  LEGACY_PORTABLE_PROJECT_EXTENSION,
  PORTABLE_PROJECT_EXTENSION,
  PORTABLE_PROJECT_LIMITS,
  PORTABLE_PROJECT_MEDIA_TYPE,
} from "../workspace/persistence/portable/constants";
import type { PortableProjectBundleExport } from "../workspace/persistence/portable/bundle";

type PortableBundle = Pick<PortableProjectBundleExport, "byteLength" | "stream" | "toBlob">;

export type PortableProjectWritable = Readonly<{
  write(value: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}>;

export type PortableProjectPickerHost = Readonly<{
  showSaveFilePicker?: (options: Readonly<{
    suggestedName: string;
    types: readonly Readonly<{
      description: string;
      accept: Readonly<Record<string, readonly string[]>>;
    }>[];
  }>) => Promise<Readonly<{
    createWritable(): Promise<PortableProjectWritable>;
  }>>;
}>;

export const WORKSPACE_PROJECT_FILE_ACCEPT = [
  PORTABLE_PROJECT_EXTENSION, LEGACY_PORTABLE_PROJECT_EXTENSION,
  ".json", ".semaframe.json", PORTABLE_PROJECT_MEDIA_TYPE, "application/zip", "application/json",
].join(",");

export function workspaceProjectNameFromFilename(filename: string): string {
  return filename.replace(/\.semaframe\.zip$|\.semaframe-project$|\.semaframe\.json$|\.json$/i, "");
}

/** Only rejection of the native picker is a quiet user cancellation. */
export class PortableProjectSaveCancelledError extends Error {
  constructor() {
    super("Portable project save cancelled");
    this.name = "PortableProjectSaveCancelledError";
  }
}

/** Track changes after a synchronous snapshot without blocking live Agent edits. */
export function watchPortableProjectSnapshot(
  subscribe: (onChange: () => void) => () => void,
  isCurrentContext: () => boolean = () => true,
): Readonly<{ isCurrent: () => boolean; dispose: () => void }> {
  let changed = false;
  let disposed = false;
  const unsubscribe = subscribe(() => { changed = true; });
  return {
    // A revision number is insufficient: undo/redo can revisit that revision.
    isCurrent: () => !changed && !disposed && isCurrentContext(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}

/**
 * Call directly from the user's save action, before preparing/hash-checking the
 * archive: native pickers require a transient user gesture. The .semaframe.zip
 * alias is valid in native extension filters. The old .semaframe-project suffix
 * is invalid there and Chromium can strip it even from an unfiltered filename.
 * No writable is opened until archive preparation has succeeded.
 */
export async function savePortableProjectToBrowser<T extends PortableBundle>(
  filename: string,
  prepareBundle: () => Promise<T>,
  options: Readonly<{
    pickerHost?: PortableProjectPickerHost;
    download: (filename: string, blob: Blob) => void | Promise<void>;
  }>,
): Promise<T> {
  const host = options.pickerHost ?? window as unknown as PortableProjectPickerHost;
  if (typeof host.showSaveFilePicker !== "function") {
    const bundle = await prepareBundle();
    const maximumBytes = PORTABLE_PROJECT_LIMITS.defaultMaximumMaterializedBytes;
    if (bundle.byteLength > maximumBytes) {
      throw new Error(
        "This browser cannot stream a portable project of this size. Use a Chromium browser with the system save picker, or download the smaller metadata-only project instead.",
      );
    }
    await options.download(filename, await bundle.toBlob({ maximumBytes }));
    return bundle;
  }

  // Invoke on its Window receiver, synchronously before the first await.
  // Cancellation, policy rejection, and picker failures must not trigger an
  // unsolicited download fallback or be reported as a successful save.
  let handle: Awaited<ReturnType<NonNullable<PortableProjectPickerHost["showSaveFilePicker"]>>>;
  try {
    handle = await host.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: "SemaFrame portable project",
        accept: { [PORTABLE_PROJECT_MEDIA_TYPE]: [PORTABLE_PROJECT_EXTENSION] },
      }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new PortableProjectSaveCancelledError();
    }
    throw error;
  }
  const bundle = await prepareBundle();
  const writable = await handle.createWritable();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = bundle.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
    }
    await writable.close();
    return bundle;
  } catch (error) {
    try { await reader?.cancel(error); } catch { /* Preserve the original failure. */ }
    try { await writable.abort?.(error); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
