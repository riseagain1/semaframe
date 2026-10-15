import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { restoreWorkspaceOnStartup, type WorkspaceRecoveryReadResult } from "../../app/recovery";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";
import { portableFixture } from "../workspace-portable/helpers";

function fixture() {
  const serializer = new WorkspaceProjectSerializer();
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "agent_create", [{
    op: "create_component", op_id: "create", id: "CMP_000001",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
  }]), { actor: "agent", permissions: ["*"] });
  store.apply(workspaceBatch(store, "agent_edit", [{
    op: "update_component", op_id: "edit", id: "CMP_000001", patch: { label: "Preserved panel" },
  }]), { actor: "agent", permissions: ["*"] });
  const project = serializer.fromStore("startup-project", store);
  const candidate: WorkspaceRecoveryReadResult = {
    source: "current", recoveredFromPrevious: false,
    snapshot: {
      serializedProject: serializer.serialize(project), projectName: "My last scene",
      projectId: project.projectId, workspaceRevision: project.workspace.revision,
      createdAt: project.updatedAt, generation: 0, sequence: 2,
    },
  };
  return { serializer, project, store, candidate };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("automatic Workspace startup recovery", () => {
  it("restores the last validated scene and resolved edit history without a human Continue action or storage writes", async () => {
    const { serializer, project, candidate } = fixture();
    const coordinator = { readCandidates: vi.fn(async () => [candidate]), clear: vi.fn(), schedule: vi.fn() };
    const commit = vi.fn();
    expect(await restoreWorkspaceOnStartup({ coordinator, serializer, isCurrent: () => true, commit }))
      .toEqual({ status: "restored", recoveredFromPrevious: false });
    expect(commit).toHaveBeenCalledOnce();
    const [restoredProject, restoredStore, recovered] = commit.mock.calls[0];
    expect(restoredProject).toEqual(project);
    expect(recovered.snapshot.projectName).toBe("My last scene");
    expect(restoredStore.getState().revision).toBe(2);
    expect(restoredStore.getState().components.get("CMP_000001").label).toBe("Preserved panel");
    expect(restoredStore.getCommandHistory()).toEqual(project.commandHistory);
    expect(restoredStore.canUndoUserCommand()).toBe(true);
    restoredStore.undoUserCommand();
    expect(restoredStore.getState().components.get("CMP_000001").label).not.toBe("Preserved panel");
    restoredStore.redoUserCommand();
    expect(restoredStore.getState().components.get("CMP_000001").label).toBe("Preserved panel");
    expect(coordinator.schedule).not.toHaveBeenCalled();
    expect(coordinator.clear).not.toHaveBeenCalled();
  });

  it("falls back when a hash-valid head fails project replay, leaving both recovery slots intact", async () => {
    const { serializer, candidate } = fixture();
    const previous = { ...candidate, source: "previous" as const, recoveredFromPrevious: true };
    const corrupt = { ...candidate, snapshot: { ...candidate.snapshot, serializedProject: "{}" } };
    const coordinator = { readCandidates: async () => [corrupt, previous], clear: vi.fn(), schedule: vi.fn() };
    const commit = vi.fn();
    expect(await restoreWorkspaceOnStartup({ coordinator, serializer, isCurrent: () => true, commit }))
      .toMatchObject({ status: "restored", recoveredFromPrevious: true, writeProtection: expect.any(String) });
    expect(commit.mock.calls[0][2]).toBe(previous);
    expect(coordinator.clear).not.toHaveBeenCalled();
    expect(coordinator.schedule).not.toHaveBeenCalled();
  });

  it("preserves Reality descriptors, shared asset references, undo-only assets, and the existing vault", async () => {
    const { serializer, project, sourceVault, first, second } = await portableFixture();
    const candidate: WorkspaceRecoveryReadResult = {
      source: "current", recoveredFromPrevious: false,
      snapshot: { serializedProject: serializer.serialize(project), projectName: "Reality scene",
        projectId: project.projectId, workspaceRevision: project.workspace.revision,
        createdAt: project.updatedAt, generation: 0, sequence: 1 },
    };
    let restored: WorkspaceStore | undefined;
    await restoreWorkspaceOnStartup({ coordinator: { readCandidates: async () => [candidate] }, serializer,
      isCurrent: () => true, commit: (_, store) => { restored = store; } });
    expect(serializer.fromStore(project.projectId, restored!, { createdAt: project.createdAt, updatedAt: project.updatedAt }))
      .toEqual(project);
    expect(restored!.getState().components.get("SCAN_ONE")?.props.assetRef)
      .toEqual(restored!.getState().components.get("SCAN_TWO")?.props.assetRef);
    expect(await sourceVault.has(first.descriptor.assetId)).toBe(true);
    expect(await sourceVault.has(second.descriptor.assetId)).toBe(true);
    restored!.undoUserCommand();
    expect(restored!.getState().realityAssets.has(second.descriptor.assetId)).toBe(true);
    restored!.redoUserCommand();
    restored!.apply(workspaceBatch(restored!, "new_agent_after_refresh", [{
      op: "update_component", op_id: "edit", id: "SCAN_ONE", patch: { label: "Edited after refresh" },
    }]), { actor: "agent", permissions: ["*"] });
    const next = serializer.fromStore(project.projectId, restored!, { createdAt: project.createdAt });
    expect(next.projectId).toBe(project.projectId);
    expect(next.createdAt).toBe(project.createdAt);
    expect(next.commandHistory.slice(0, -1)).toEqual(project.commandHistory);
    expect(next.workspace.realityAssets).toEqual(project.workspace.realityAssets);
    sourceVault.dispose();
  });

  it("tries the previous scene when CAD evidence verification rejects the current one", async () => {
    const { serializer, candidate } = fixture();
    const previous = { ...candidate, source: "previous" as const, recoveredFromPrevious: true };
    const verifyProject = vi.fn().mockRejectedValueOnce(new Error("CAD digest mismatch")).mockResolvedValueOnce(undefined);
    expect(await restoreWorkspaceOnStartup({ coordinator: { readCandidates: async () => [candidate, previous] },
      serializer, isCurrent: () => true, commit: vi.fn(), verifyProject }))
      .toMatchObject({ status: "restored", recoveredFromPrevious: true, writeProtection: expect.any(String) });
    expect(verifyProject).toHaveBeenCalledTimes(2);
  });

  it("does not clear corrupt data when neither snapshot can be restored", async () => {
    const { serializer, candidate } = fixture();
    const coordinator = { readCandidates: async () => [{ ...candidate, snapshot: { ...candidate.snapshot, serializedProject: "invalid" } }], clear: vi.fn() };
    const commit = vi.fn();
    expect(await restoreWorkspaceOnStartup({ coordinator, serializer, isCurrent: () => true, commit }))
      .toMatchObject({ status: "invalid" });
    expect(commit).not.toHaveBeenCalled();
    expect(coordinator.clear).not.toHaveBeenCalled();
  });

  it("allows a clean first launch with no recovery", async () => {
    const commit = vi.fn();
    expect(await restoreWorkspaceOnStartup({ coordinator: { readCandidates: async () => [] },
      serializer: new WorkspaceProjectSerializer(), isCurrent: () => true, commit })).toEqual({ status: "empty" });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["invalid", "unavailable"] as const)("does not treat an inspected %s store as empty even when legacy readCandidates returns []", async (kind) => {
    const commit = vi.fn();
    const readCandidates = vi.fn(async () => []);
    const coordinator = { readCandidates, inspectStartupRecovery: async () => ({ candidates: [], issues: [{ kind, message: "Recovery needs attention" }] }) };
    expect(await restoreWorkspaceOnStartup({ coordinator, serializer: new WorkspaceProjectSerializer(), isCurrent: () => true, commit }))
      .toMatchObject({ status: kind });
    expect(commit).not.toHaveBeenCalled();
    expect(readCandidates).not.toHaveBeenCalled();
  });

  it("restores a known-good candidate but protects writes when another backend remains unreadable", async () => {
    const { serializer, candidate } = fixture();
    const coordinator = { readCandidates: async () => [candidate], inspectStartupRecovery: async () => ({
      candidates: [candidate], issues: [{ kind: "unavailable" as const, message: "Other backend denied" }],
    }) };
    const commit = vi.fn();
    expect(await restoreWorkspaceOnStartup({ coordinator, serializer, isCurrent: () => true, commit }))
      .toMatchObject({ status: "restored", writeProtection: expect.any(String) });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("allows writes after a verified previous snapshot replaces an excluded hash-invalid head", async () => {
    const { serializer, candidate } = fixture();
    const coordinator = { readCandidates: async () => [], inspectStartupRecovery: async () => ({
      candidates: [{ ...candidate, source: "previous" as const, recoveredFromPrevious: true }],
      issues: [{ kind: "invalid" as const, message: "Known-invalid hash excluded from future rotation" }],
    }) };
    expect(await restoreWorkspaceOnStartup({ coordinator, serializer, isCurrent: () => true, commit: vi.fn() }))
      .toEqual({ status: "restored", recoveredFromPrevious: true });
  });

  it("does not call malformed legacy recovery an empty first launch", async () => {
    expect(await restoreWorkspaceOnStartup({ coordinator: { readCandidates: async () => [] },
      serializer: new WorkspaceProjectSerializer(), isCurrent: () => true, commit: vi.fn(), legacy: "{broken" }))
      .toMatchObject({ status: "invalid" });
  });

  it.each(["missing", "denied"])("does not fail startup or erase snapshots when storage is %s", async (kind) => {
    const commit = vi.fn();
    const coordinator = kind === "missing" ? undefined : { readCandidates: async () => { throw new Error("Storage denied"); }, clear: vi.fn() };
    expect(await restoreWorkspaceOnStartup({ coordinator, serializer: new WorkspaceProjectSerializer(), isCurrent: () => true, commit }))
      .toMatchObject({ status: "unavailable" });
    expect(commit).not.toHaveBeenCalled();
    if (coordinator) expect(coordinator.clear).not.toHaveBeenCalled();
  });

  it.each(["New", "Open", "unmount"])("abandons the in-flight recovery when %s wins while reading", async () => {
    const { serializer, candidate } = fixture();
    const read = deferred<readonly WorkspaceRecoveryReadResult[]>();
    let current = true;
    const commit = vi.fn();
    const recovery = restoreWorkspaceOnStartup({ coordinator: { readCandidates: () => read.promise }, serializer,
      isCurrent: () => current, commit });
    current = false;
    read.resolve([candidate]);
    expect(await recovery).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("checks New/Open again after asynchronous evidence verification", async () => {
    const { serializer, candidate } = fixture();
    const verification = deferred<void>();
    let current = true;
    const commit = vi.fn();
    const verifyProject = vi.fn(() => verification.promise);
    const recovery = restoreWorkspaceOnStartup({ coordinator: { readCandidates: async () => [candidate] }, serializer,
      isCurrent: () => current, commit, verifyProject });
    await vi.waitFor(() => expect(verifyProject).toHaveBeenCalledOnce());
    current = false;
    verification.resolve();
    expect(await recovery).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("StrictMode replay commits only the active effect", async () => {
    const { serializer, candidate } = fixture();
    const read = deferred<readonly WorkspaceRecoveryReadResult[]>();
    const coordinator = { readCandidates: () => read.promise };
    let firstActive = true;
    const commit = vi.fn();
    const first = restoreWorkspaceOnStartup({ coordinator, serializer, isCurrent: () => firstActive, commit });
    firstActive = false;
    const second = restoreWorkspaceOnStartup({ coordinator, serializer, isCurrent: () => true, commit });
    read.resolve([candidate]);
    expect(await first).toEqual({ status: "cancelled" });
    expect(await second).toMatchObject({ status: "restored" });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("keeps legacy recovery usable without a startup migration write", async () => {
    const { serializer, project } = fixture();
    const commit = vi.fn();
    expect(await restoreWorkspaceOnStartup({ serializer, isCurrent: () => true, commit,
      legacy: JSON.stringify({ version: 1, projectName: "Legacy scene", project }) })).toMatchObject({ status: "restored" });
    expect(commit.mock.calls[0][2].snapshot.projectName).toBe("Legacy scene");
  });

  it("wires startup readiness ahead of Agent command polling and autosave, without restoring trust", () => {
    const source = readFileSync("src/app/App.tsx", "utf8");
    const startup = source.slice(source.indexOf("const initialStore = workspaceStoreRef.current"), source.indexOf("const storeRecoveryProject ="));
    expect(startup).toContain("installWorkspaceAgentController(nextStore)");
    expect(startup).toContain("projectIntentRef.current === intent");
    expect(startup).not.toContain("stopAgentForProjectChange");
    expect(startup).not.toContain("approveClaim");
    expect(startup).not.toContain("setAgentSessionReady(true)");
    expect(source).toContain("if (!AGENT_CONTROL_ENDPOINT || !startupRecoveryReady) return;");
    expect(source).toContain("if (!startupRecoveryReadyRef.current) return;");
    expect(source.match(/if \(busyRef.current \|\| !startupRecoveryReadyRef.current\) return;/g)).toHaveLength(3);
    expect(startup).toContain("protectRecoveryWrites(");
    expect(startup).not.toContain("resumeRecoveryWrites(");
    expect(source).toContain("new WorkspaceRecoveryCoordinator(repository, startupIssues)");
    const opening = source.slice(source.indexOf("const loadProject ="), source.indexOf("const resetProject ="));
    const commit = opening.slice(opening.indexOf("commitProject:"), opening.indexOf("await storeRecoveryProject"));
    expect(commit).toContain("resumeRecoveryWrites()");
    const failedOpen = opening.slice(opening.indexOf('notice(`This Workspace project could not be opened.'));
    expect(failedOpen).not.toContain("resumeRecoveryWrites()");
    expect(source).toContain('aria-label="Browser autosave paused"');
    expect(source.match(/await clearWorkspaceRecovery\(recoveryCoordinatorRef.current\)/g)).toHaveLength(2);
    expect(source).not.toContain("await recoveryCoordinatorRef.current?.clear()");
  });
});
