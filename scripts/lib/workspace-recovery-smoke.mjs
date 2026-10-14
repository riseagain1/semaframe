const RECOVERY_IDENTITY_FIELDS = ["projectId", "projectName", "generation", "sequence", "workspaceRevision", "createdAt", "sha256"];

export function sameRecoveryHead(actual, expected) {
  return Boolean(actual && expected && RECOVERY_IDENTITY_FIELDS.every((field) => actual[field] === expected[field]));
}

/** Existing slots alone do not prove the requested asynchronous rename was saved. */
export function renamedRecoveryPair(state, previous, currentProjectName) {
  const current = state.slots.find((record) => record.slot === "current");
  const fallback = state.slots.find((record) => record.slot === "previous");
  return Boolean(current && sameRecoveryHead(fallback, previous)
    && current.projectName === currentProjectName
    && current.projectId === previous.projectId
    && current.generation === previous.generation
    && current.sequence > previous.sequence
    && current.workspaceRevision === previous.workspaceRevision
    && current.componentCount === previous.componentCount);
}

/** Runs only in the synthetic smoke page, never in application code. */
export function corruptRecoveryHeadInBrowser(expectedCurrent, expectedPrevious) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("semaframe-workspace-recovery-v3", 1);
    request.onerror = () => reject(new Error("Recovery database could not open"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("snapshots", "readwrite");
      const store = transaction.objectStore("snapshots");
      const current = store.get("current");
      const previous = store.get("previous");
      let remaining = 2;
      let failure;
      const finish = () => {
        remaining -= 1;
        if (remaining) return;
        const fields = ["projectId", "projectName", "generation", "sequence", "workspaceRevision", "createdAt", "sha256"];
        const matches = (actual, expected) => actual && expected && fields.every((field) => actual[field] === expected[field]);
        if (!matches(current.result, expectedCurrent) || !matches(previous.result, expectedPrevious)) {
          failure = new Error("Recovery fixture heads changed before corruption; no snapshot was modified.");
          transaction.abort();
          return;
        }
        store.put({ ...current.result, sha256: `sha256:${"f".repeat(64)}` });
      };
      current.onsuccess = finish;
      previous.onsuccess = finish;
      transaction.onerror = () => { database.close(); reject(failure ?? new Error("Recovery fixture transaction failed")); };
      transaction.onabort = () => { database.close(); reject(failure ?? new Error("Recovery fixture transaction aborted")); };
      transaction.oncomplete = () => { database.close(); resolve(true); };
    };
  });
}

/** Latch transient UI evidence before the separate, potentially slow re-pair. */
export function observeRecoveryNoticeInBrowser() {
  window.__workspaceRecoverySmokeNoticeSeen = false;
  const observer = new MutationObserver(check);
  function check() {
    if (!document.querySelector(".toast-stack")?.textContent?.includes("last-known-good Workspace snapshot")) return;
    window.__workspaceRecoverySmokeNoticeSeen = true;
    observer.disconnect();
  }
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  check();
  return true;
}
