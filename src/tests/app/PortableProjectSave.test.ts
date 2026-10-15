import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PortableProjectSaveCancelledError,
  savePortableProjectToBrowser,
  watchPortableProjectSnapshot,
  WORKSPACE_PROJECT_FILE_ACCEPT,
  workspaceProjectNameFromFilename,
  type PortableProjectPickerHost,
} from "../../app/portableProjectSave";
import {
  LEGACY_PORTABLE_PROJECT_EXTENSION,
  PORTABLE_PROJECT_EXTENSION,
  PORTABLE_PROJECT_LIMITS,
  PORTABLE_PROJECT_MEDIA_TYPE,
} from "../../workspace/persistence/portable/constants";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

const filename = `My-project${PORTABLE_PROJECT_EXTENSION}`;
const maximumBytes = PORTABLE_PROJECT_LIMITS.defaultMaximumMaterializedBytes;
type PickerOptions = Parameters<NonNullable<PortableProjectPickerHost["showSaveFilePicker"]>>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function bundleFixture(byteLength = 3) {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  const bundle = { byteLength, stream: vi.fn(() => stream), toBlob: vi.fn(async () => blob) };
  return { bundle, chunks, stream, blob, prepare: vi.fn(async () => bundle), download: vi.fn() };
}

function pickerFixture() {
  const writable = { write: vi.fn(async (_value: Uint8Array) => {}), close: vi.fn(async () => {}), abort: vi.fn(async (_reason?: unknown) => {}) };
  const handle = { createWritable: vi.fn(async () => writable) };
  const picker = vi.fn(async (_options: PickerOptions) => handle);
  const host: PortableProjectPickerHost = { showSaveFilePicker: picker };
  return { writable, handle, picker, host };
}

function liveStoreFixture() {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "initial_panel", [{
    op: "create_component", op_id: "create_panel", id: "PANEL",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
    placement: { space: "viewport", anchor: "top_left", offset: { x: 24, y: 24 } },
    label: "Original panel",
  }]));
  const edit = (label: string, requestId: string) => store.apply(workspaceBatch(store, requestId, [{
    op: "update_component", op_id: "label_panel", id: "PANEL", patch: { label },
  }]));
  return { store, edit };
}

afterEach(() => vi.restoreAllMocks());

describe("Browser portable project save", () => {
  it("opens a genuinely valid picker request immediately on its Window receiver before any preparation", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const selection = deferred<typeof native.handle>();
    native.picker.mockImplementation(function (this: PortableProjectPickerHost, options) {
      expect(this).toBe(native.host);
      expect(filename).toBe("My-project.semaframe.zip");
      expect(options).toEqual({
        suggestedName: filename,
        types: [{
          description: "SemaFrame portable project",
          accept: { [PORTABLE_PROJECT_MEDIA_TYPE]: [PORTABLE_PROJECT_EXTENSION] },
        }],
      });
      // Validate the real native accept constraints, not just a permissive mock.
      for (const type of options.types) {
        for (const extension of Object.values(type.accept).flat()) {
          expect(extension).toMatch(/^\.[A-Za-z0-9+.]+$/u);
          expect(extension.length).toBeLessThanOrEqual(16);
          expect(extension.endsWith(".")).toBe(false);
          expect(extension).not.toBe(LEGACY_PORTABLE_PROJECT_EXTENSION);
        }
      }
      return selection.promise;
    });
    const pending = savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download });
    expect(native.picker).toHaveBeenCalledOnce();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(native.handle.createWritable).not.toHaveBeenCalled();
    selection.resolve(native.handle);
    await expect(pending).resolves.toBe(fixture.bundle);
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("waits for delayed bundle validation and the actual stream close before resolving success", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const preparation = deferred<typeof fixture.bundle>();
    const closing = deferred<void>();
    fixture.prepare.mockReturnValue(preparation.promise);
    native.writable.close.mockReturnValue(closing.promise);
    let succeeded = false;
    const pending = savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download })
      .then((bundle) => { succeeded = true; return bundle; });
    await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce());
    expect(native.handle.createWritable).not.toHaveBeenCalled();
    preparation.resolve(fixture.bundle);
    await vi.waitFor(() => expect(native.writable.close).toHaveBeenCalledOnce());
    expect(native.writable.write.mock.calls.map(([chunk]) => [...chunk])).toEqual([[1, 2], [3]]);
    expect(succeeded).toBe(false);
    closing.resolve();
    await expect(pending).resolves.toBe(fixture.bundle);
    expect(succeeded).toBe(true);
    expect(fixture.stream.locked).toBe(false);
    expect(fixture.bundle.toBlob).not.toHaveBeenCalled();
    expect(native.writable.abort).not.toHaveBeenCalled();
  });

  it("marks a picker AbortError as quiet cancellation without preparing or writing", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    native.picker.mockRejectedValue(new DOMException("User cancelled", "AbortError"));
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .rejects.toBeInstanceOf(PortableProjectSaveCancelledError);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(native.handle.createWritable).not.toHaveBeenCalled();
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it.each([
    new DOMException("User gesture unavailable", "SecurityError"),
    new TypeError("Invalid picker options"),
  ])("does not prepare, write or download after a picker rejection: %s", async (error) => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    native.picker.mockRejectedValue(error);
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .rejects.toBe(error);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(native.handle.createWritable).not.toHaveBeenCalled();
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it.each(["prepare", "open", "read", "write", "close"] as const)(
    "keeps a post-selection %s AbortError visible as a failed save", async (stage) => {
      const fixture = bundleFixture();
      const native = pickerFixture();
      const error = new DOMException("Export interrupted after selection", "AbortError");
      if (stage === "prepare") fixture.prepare.mockRejectedValue(error);
      if (stage === "open") native.handle.createWritable.mockRejectedValue(error);
      if (stage === "read") fixture.bundle.stream.mockReturnValue(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(error); },
      }));
      if (stage === "write") native.writable.write.mockRejectedValue(error);
      if (stage === "close") native.writable.close.mockRejectedValue(error);
      await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
        .rejects.toBe(error);
      expect(error).not.toBeInstanceOf(PortableProjectSaveCancelledError);
      expect(fixture.download).not.toHaveBeenCalled();
      if (stage !== "prepare" && stage !== "open") {
        expect(native.writable.abort).toHaveBeenCalledWith(error);
      }
    },
  );

  it("leaves the chosen file unopened when bundle validation fails", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const error = new Error("Missing retained Reality bytes");
    fixture.prepare.mockRejectedValue(error);
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .rejects.toBe(error);
    expect(native.handle.createWritable).not.toHaveBeenCalled();
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("does not stream or fall back when the writable cannot be opened", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const error = new DOMException("Write permission denied", "NotAllowedError");
    native.handle.createWritable.mockRejectedValue(error);
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .rejects.toBe(error);
    expect(fixture.bundle.stream).not.toHaveBeenCalled();
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("aborts an opened writable if obtaining the archive stream fails", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const error = new Error("Archive stream unavailable");
    fixture.bundle.stream.mockImplementation(() => { throw error; });
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .rejects.toBe(error);
    expect(native.writable.abort).toHaveBeenCalledWith(error);
    expect(native.writable.close).not.toHaveBeenCalled();
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("cancels the stream and aborts the file on a write error, preserving that error if cleanup fails", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const error = new Error("Disk full");
    const cancel = vi.fn(() => { throw new Error("Cancellation failed"); });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      cancel,
    });
    fixture.bundle.stream.mockReturnValue(stream);
    native.writable.write.mockRejectedValue(error);
    native.writable.abort.mockRejectedValue(new Error("Abort failed"));
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .rejects.toBe(error);
    expect(cancel).toHaveBeenCalledWith(error);
    expect(native.writable.abort).toHaveBeenCalledWith(error);
    expect(native.writable.close).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("aborts the file on a read error and releases the reader lock", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const error = new Error("Source read failed");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(error); } });
    fixture.bundle.stream.mockReturnValue(stream);
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .rejects.toBe(error);
    expect(native.writable.write).not.toHaveBeenCalled();
    expect(native.writable.abort).toHaveBeenCalledWith(error);
    expect(native.writable.close).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("does not report success when closing the file fails", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const error = new Error("Commit failed");
    native.writable.close.mockRejectedValue(error);
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .rejects.toBe(error);
    expect(native.writable.abort).toHaveBeenCalledWith(error);
    expect(fixture.stream.locked).toBe(false);
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("streams a large archive without invoking bounded Blob materialization", async () => {
    const fixture = bundleFixture(maximumBytes + 1);
    const native = pickerFixture();
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: native.host, download: fixture.download }))
      .resolves.toBe(fixture.bundle);
    expect(native.writable.close).toHaveBeenCalledOnce();
    expect(fixture.bundle.toBlob).not.toHaveBeenCalled();
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it.each([3, maximumBytes])("uses the bounded download path only when no native picker exists (%i bytes)", async (byteLength) => {
    const fixture = bundleFixture(byteLength);
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: {}, download: fixture.download }))
      .resolves.toBe(fixture.bundle);
    expect(fixture.bundle.toBlob).toHaveBeenCalledExactlyOnceWith({ maximumBytes });
    expect(fixture.download).toHaveBeenCalledExactlyOnceWith(filename, fixture.blob);
    expect(fixture.bundle.stream).not.toHaveBeenCalled();
  });

  it("rejects an oversized fallback before materializing or downloading", async () => {
    const fixture = bundleFixture(maximumBytes + 1);
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: {}, download: fixture.download }))
      .rejects.toThrow("cannot stream a portable project of this size");
    expect(fixture.bundle.toBlob).not.toHaveBeenCalled();
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("does not report success after materialization or download fails", async () => {
    const fixture = bundleFixture();
    const error = new Error("Materialization failed");
    fixture.bundle.toBlob.mockRejectedValue(error);
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: {}, download: fixture.download }))
      .rejects.toBe(error);
    expect(fixture.download).not.toHaveBeenCalled();
    fixture.bundle.toBlob.mockResolvedValue(fixture.blob);
    fixture.download.mockImplementation(() => { throw error; });
    await expect(savePortableProjectToBrowser(filename, fixture.prepare, { pickerHost: {}, download: fixture.download }))
      .rejects.toBe(error);
  });

  it("uses the real Window picker by default without losing its receiver", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const previous = Object.getOwnPropertyDescriptor(window, "showSaveFilePicker");
    const picker = vi.fn(function (this: Window, options: PickerOptions) {
      expect(this).toBe(window);
      expect(options.suggestedName).toBe(filename);
      return Promise.resolve(native.handle);
    });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: picker });
    try {
      await expect(savePortableProjectToBrowser(filename, fixture.prepare, { download: fixture.download }))
        .resolves.toBe(fixture.bundle);
      expect(picker).toHaveBeenCalledOnce();
    } finally {
      if (previous) Object.defineProperty(window, "showSaveFilePicker", previous);
      else Reflect.deleteProperty(window, "showSaveFilePicker");
    }
  });
});

describe("portable filename compatibility", () => {
  it("allows new and legacy portable names in the browser import chooser", () => {
    expect(WORKSPACE_PROJECT_FILE_ACCEPT.split(",")).toEqual(expect.arrayContaining([
      ".semaframe.zip", ".semaframe-project", ".semaframe.json", ".json",
      PORTABLE_PROJECT_MEDIA_TYPE, "application/zip", "application/json",
    ]));
  });

  it.each([
    ["My-project.semaframe.zip", "My-project"],
    ["My-project.semaframe-project", "My-project"],
    ["My-project.SEMAFRAME.ZIP", "My-project"],
    ["My-project.SEMAFRAME-PROJECT", "My-project"],
    ["My-project.semaframe.json", "My-project"],
    ["My-project.json", "My-project"],
    ["My-project.semaframe.zip.backup", "My-project.semaframe.zip.backup"],
  ])("restores a project title from %s", (input, expected) => {
    expect(workspaceProjectNameFromFilename(input)).toBe(expected);
  });
});

describe("portable save snapshot freshness", () => {
  it("keeps newer edits unsaved when the live Store changes during stream close", async () => {
    const fixture = bundleFixture();
    const native = pickerFixture();
    const live = liveStoreFixture();
    const closing = deferred<void>();
    native.writable.close.mockReturnValue(closing.promise);
    let snapshot: ReturnType<typeof watchPortableProjectSnapshot> | undefined;
    let dirty = true;
    const pending = savePortableProjectToBrowser(filename, async () => {
      snapshot = watchPortableProjectSnapshot((listener) => live.store.subscribe(listener));
      return fixture.bundle;
    }, { pickerHost: native.host, download: fixture.download }).then(() => {
      dirty = !(snapshot?.isCurrent() ?? false);
    }).finally(() => snapshot?.dispose());
    await vi.waitFor(() => expect(native.writable.close).toHaveBeenCalledOnce());
    expect(snapshot?.isCurrent()).toBe(true);
    // Saving must not prevent an already-authorized Agent from editing.
    live.edit("Newer edit while saving", "concurrent_edit");
    expect(live.store.getState().components.get("PANEL")?.label).toBe("Newer edit while saving");
    closing.resolve();
    await pending;
    expect(dirty).toBe(true);
    expect(snapshot?.isCurrent()).toBe(false);
  });

  it("invalidates a snapshot after undo and a different edit reuse its revision", () => {
    const live = liveStoreFixture();
    live.edit("Captured branch", "captured_edit");
    const capturedRevision = live.store.getRevision();
    const snapshot = watchPortableProjectSnapshot((listener) => live.store.subscribe(listener));
    try {
      live.store.undoUserCommand();
      live.edit("Different branch at the same revision", "branched_edit");
      expect(live.store.getRevision()).toBe(capturedRevision);
      expect(snapshot.isCurrent()).toBe(false);
    } finally {
      snapshot.dispose();
    }
  });

  it("does not hide an undo/redo round trip even if it returns to the saved revision", () => {
    const live = liveStoreFixture();
    const capturedRevision = live.store.getRevision();
    const snapshot = watchPortableProjectSnapshot((listener) => live.store.subscribe(listener));
    try {
      live.store.undoUserCommand();
      live.store.redoUserCommand();
      expect(live.store.getRevision()).toBe(capturedRevision);
      expect(snapshot.isCurrent()).toBe(false);
    } finally {
      snapshot.dispose();
    }
  });

  it("checks current project identity and filename metadata even without a Store emission", () => {
    const live = liveStoreFixture();
    let currentStore = live.store;
    let currentName = filename;
    const snapshot = watchPortableProjectSnapshot(
      (listener) => live.store.subscribe(listener),
      () => currentStore === live.store && currentName === filename,
    );
    try {
      expect(snapshot.isCurrent()).toBe(true);
      currentName = "Renamed.semaframe.zip";
      expect(snapshot.isCurrent()).toBe(false);
      currentName = filename;
      currentStore = new WorkspaceStore();
      expect(snapshot.isCurrent()).toBe(false);
    } finally {
      snapshot.dispose();
    }
  });

  it("releases a save watcher once and cannot reuse a disposed success check", () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const snapshot = watchPortableProjectSnapshot(subscribe);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(snapshot.isCurrent()).toBe(true);
    snapshot.dispose();
    snapshot.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(snapshot.isCurrent()).toBe(false);
  });
});
