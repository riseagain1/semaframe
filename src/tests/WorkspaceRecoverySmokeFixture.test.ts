import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The executable .mjs helper does not ship declarations.
import { corruptRecoveryHeadInBrowser, observeRecoveryNoticeInBrowser, renamedRecoveryPair } from "../../scripts/lib/workspace-recovery-smoke.mjs";

const baseline = {
  slot: "current", projectId: "smoke-project", projectName: "original", generation: 2,
  sequence: 7, workspaceRevision: 12, createdAt: "2026-10-14T00:00:00.000Z",
  sha256: `sha256:${"a".repeat(64)}`, componentCount: 5,
};
const renamed = {
  ...baseline, projectName: "renamed", sequence: 8,
  createdAt: "2026-10-14T00:00:01.000Z", sha256: `sha256:${"b".repeat(64)}`,
};
const fallback = { ...baseline, slot: "previous" };
type Head = typeof baseline;
type Request = { result?: unknown; onsuccess?: () => void };
type NoticeWindow = Window & { __workspaceRecoverySmokeNoticeSeen?: boolean };

// A narrow transaction fake: both reads happen before completion, and abort
// prevents writes. No browser is launched and no application database is used.
function mockRecoveryDatabase(current: Head, previous: Head) {
  const put = vi.fn();
  const close = vi.fn();
  let aborted = false;
  let completedReads = 0;
  const transaction = {
    onabort: undefined as (() => void) | undefined,
    oncomplete: undefined as (() => void) | undefined,
    abort: vi.fn(() => { aborted = true; queueMicrotask(() => transaction.onabort?.()); }),
    objectStore: vi.fn(() => ({
      get: (slot: string) => {
        const request: Request = { result: slot === "current" ? current : previous };
        queueMicrotask(() => {
          request.onsuccess?.();
          completedReads += 1;
          if (completedReads === 2 && !aborted) queueMicrotask(() => transaction.oncomplete?.());
        });
        return request;
      },
      put,
    })),
  };
  const database = { transaction: vi.fn(() => transaction), close };
  vi.stubGlobal("indexedDB", {
    open: vi.fn(() => {
      const request: Request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }),
  });
  return { database, transaction, put, close };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
  delete (window as NoticeWindow).__workspaceRecoverySmokeNoticeSeen;
});

describe("Workspace recovery smoke fixture", () => {
  it("does not accept pre-existing slots while an asynchronous rename is still pending", async () => {
    let slots = [baseline, { ...fallback, sequence: 6 }];
    let saveRename!: () => void;
    const pendingRename = new Promise<void>((resolve) => { saveRename = resolve; }).then(() => {
      slots = [renamed, fallback];
    });
    expect(renamedRecoveryPair({ slots }, baseline, "renamed")).toBe(false);
    saveRename();
    await pendingRename;
    expect(renamedRecoveryPair({ slots }, baseline, "renamed")).toBe(true);
  });

  it.each([
    { projectName: "original" }, { sequence: baseline.sequence },
    { projectId: "other-project" }, { generation: 3 },
    { workspaceRevision: 13 }, { componentCount: 4 },
  ])("rejects an incomplete or unrelated renamed head: %j", (change) => {
    expect(renamedRecoveryPair({ slots: [{ ...renamed, ...change }, fallback] }, baseline, "renamed")).toBe(false);
  });

  it("requires the previous snapshot to be the exact captured baseline", () => {
    expect(renamedRecoveryPair({ slots: [renamed, { ...fallback, sha256: "other" }] }, baseline, "renamed")).toBe(false);
  });

  it("corrupts only the expected current snapshot after comparing both heads in one transaction", async () => {
    const fixture = mockRecoveryDatabase(renamed, fallback);
    await expect(corruptRecoveryHeadInBrowser(renamed, fallback)).resolves.toBe(true);
    expect(fixture.database.transaction).toHaveBeenCalledExactlyOnceWith("snapshots", "readwrite");
    expect(fixture.put).toHaveBeenCalledExactlyOnceWith({ ...renamed, sha256: `sha256:${"f".repeat(64)}` });
    expect(fixture.transaction.abort).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it.each(["current", "previous"])("aborts without mutation if the %s head changed since the readiness check", async (slot) => {
    const fixture = mockRecoveryDatabase(
      slot === "current" ? { ...renamed, sequence: 9 } : renamed,
      slot === "previous" ? { ...fallback, sha256: "changed" } : fallback,
    );
    await expect(corruptRecoveryHeadInBrowser(renamed, fallback)).rejects.toThrow("no snapshot was modified");
    expect(fixture.put).not.toHaveBeenCalled();
    expect(fixture.transaction.abort).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("retains real recovery notice evidence after it expires during a slow agent re-pair", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.append(stack);
    observeRecoveryNoticeInBrowser();
    stack.textContent = "Agent connected";
    await Promise.resolve();
    expect((window as NoticeWindow).__workspaceRecoverySmokeNoticeSeen).toBe(false);
    stack.textContent = "Recovered the last-known-good Workspace snapshot because the current recovery was invalid or older.";
    await Promise.resolve();
    expect((window as NoticeWindow).__workspaceRecoverySmokeNoticeSeen).toBe(true);
    setTimeout(() => { stack.textContent = ""; }, 4_500);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(stack.textContent).toBe("");
    expect((window as NoticeWindow).__workspaceRecoverySmokeNoticeSeen).toBe(true);
  });

  it("latches the notice before re-pair in both runner paths without weakening the durable-state checks", () => {
    const source = readFileSync(resolve("scripts/workspace-smoke.mjs"), "utf8");
    for (const label of ["focused last-known-good recovery notice", "last-known-good recovery notice"]) {
      const index = source.indexOf(`\"${label}\"`);
      expect(index).toBeGreaterThan(0);
      const nextUnlock = source.indexOf("await unlockWorkspaceThroughAgent(", index);
      const nextRestoration = source.indexOf("previous recovery restoration", index);
      expect(nextUnlock).toBeGreaterThan(index);
      expect(nextRestoration).toBeGreaterThan(nextUnlock);
    }
    expect(source).toContain("renamedRecoveryPair(state, previous,");
    expect(source).toContain("renamedRecoveryPair(state, previousRecovery,");
    expect(source).toContain("'workspace-mixed-smoke' && document.querySelectorAll('.workspace-component-tree [role=treeitem]').length === 5");
    expect(source).not.toContain("document.querySelector('.toast-stack')?.textContent?.includes('last-known-good Workspace snapshot')");
  });
});
