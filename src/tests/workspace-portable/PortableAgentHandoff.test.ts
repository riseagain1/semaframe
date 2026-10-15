import { describe, expect, it } from "vitest";
import { MemoryAssetVault } from "../../workspace/assets";
import { WorkspaceAgentController } from "../../workspace/agents/WorkspaceAgentController";
import type { WorkspaceAgentResult } from "../../workspace/agents/contracts";
import { WorkspaceStoreEngineAdapter } from "../../workspace/agents/WorkspaceStoreEngineAdapter";
import { workspaceStateDigest } from "../../workspace/persistence";
import {
  createPortableProjectBundle,
  importWorkspaceProjectArtifact,
} from "../../workspace/persistence/portable";
import { MemoryPrecisionEvidenceVault } from "../../workspace/precision/evidenceVault";
import type { WorkspaceStore } from "../../workspace/state";
import { blobBytes, portableFixture } from "./helpers";

const SCOPES = ["workspace:read", "workspace:write", "component:update", "workspace:history"] as const;

function unwrap<T>(result: WorkspaceAgentResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function controllerFor(store: WorkspaceStore, clientId: string): WorkspaceAgentController {
  let sequence = 0;
  return new WorkspaceAgentController(new WorkspaceStoreEngineAdapter(store, {
    requestId: (revision) => `${clientId}_request_${revision}`,
  }), {
    now: () => 12_000,
    randomToken: (prefix) => `${prefix}_${clientId}_${String(++sequence).padStart(32, "0")}`,
    // This is an isolated controller fixture, not a browser approval or a
    // real-model acceptance test. Only the explicitly listed scopes exist.
    grantScopes: ({ requestedScopes }) => SCOPES.filter((scope) => requestedScopes.includes(scope)),
  });
}

async function sessionFor(controller: WorkspaceAgentController, clientId: string) {
  const instructions = unwrap(await controller.getWorkspaceInstructions({
    client_id: clientId,
    requested_scopes: [...SCOPES],
  }));
  expect(instructions.granted_scopes).toEqual([...SCOPES].sort());
  return { session_token: instructions.session_token, instruction_digest: instructions.guide_digest };
}

function sceneAndHistory(store: WorkspaceStore) {
  const state = store.getState();
  // Undo/redo legitimately rebase input revisions while preserving command
  // identity, resolved effects, output revisions, and the complete scene.
  return { ...state, history: state.history.map((entry) => ({ ...entry, inputRevision: 0 })) };
}

describe("portable project Agent handoff", () => {
  it("reopens real asset bytes and history for a fresh Agent without carrying old session authority", async () => {
    const fixture = await portableFixture();
    const source = fixture.serializer.openStore(fixture.project);
    const firstAgent = controllerFor(source, "first_agent");
    const firstSession = await sessionFor(firstAgent, "first_agent");
    const initialEdit = unwrap(await firstAgent.beginWorkspaceUpdate({
      ...firstSession, intent: "Label the captured object before handoff", requested_component_ids: 1,
    }));
    unwrap(await firstAgent.submitWorkspaceBatch({
      ...firstSession,
      transaction_token: initialEdit.transaction_token,
      batch: { ...initialEdit.envelope, operations: [{
        op: "update_component", op_id: "first_label", id: "SCAN_ONE",
        patch: { label: "Captured object approved by the first Agent" },
      }] },
    }));
    const savedRevision = source.getRevision();
    const savedState = source.getState();
    const savedDigest = workspaceStateDigest(savedState as never);
    const savedSceneAndHistory = sceneAndHistory(source);
    const savedIds = [...source.getState().components.keys()];
    const originalInspection = unwrap(await firstAgent.inspectWorkspaceComponent({
      ...firstSession, component_id: "SCAN_ONE",
    }));
    const originalSummary = unwrap(await firstAgent.inspectWorkspace(firstSession)).workspace_summary;

    // Even a fully prepared pre-handoff transaction must not survive project
    // replacement. Preparing it must not add it to the saved command history.
    const abandonedEdit = unwrap(await firstAgent.beginWorkspaceUpdate({
      ...firstSession, intent: "This old prepared edit must never be committed", requested_component_ids: 1,
    }));
    const abandonedBatch = { ...abandonedEdit.envelope, operations: [{
      op: "update_component", op_id: "abandoned_label", id: "SCAN_ONE",
      patch: { label: "This label must never appear" },
    }] };
    const project = fixture.serializer.fromStore(fixture.project.projectId, source);
    expect(project.commandHistory).toHaveLength(fixture.project.commandHistory.length + 1);
    const exported = await createPortableProjectBundle(project, fixture.sourceVault);
    // The second asset is absent from the current catalog but is still needed
    // to undo/replay its historical deletion. Both actual PLY payloads travel.
    expect(project.workspace.realityAssets).toHaveLength(1);
    expect(exported.manifest.assets).toHaveLength(2);
    const expectedBytes = new Map(await Promise.all(exported.manifest.assets.map(async ({ descriptor }) => [
      descriptor.assetId, await blobBytes(await fixture.sourceVault.open(descriptor.assetId)),
    ] as const)));
    const archive = await exported.toBlob();
    const archiveText = new TextDecoder().decode(await blobBytes(archive));
    expect(archiveText).not.toContain(firstSession.session_token);
    expect(archiveText).not.toContain(abandonedEdit.transaction_token);
    fixture.sourceVault.dispose();

    const emptyVault = new MemoryAssetVault();
    expect(await emptyVault.listDescriptors()).toEqual([]);
    let reopened: WorkspaceStore | undefined;
    const imported = await importWorkspaceProjectArtifact(archive, {
      vault: emptyVault,
      evidenceVault: new MemoryPrecisionEvidenceVault(),
      serializer: fixture.serializer,
      commitProject: (restored) => {
        // Mirrors the host's replacement boundary: revoke authority on the
        // old controller, then install the independently reopened Store.
        firstAgent.revokeAll();
        reopened = fixture.serializer.openStore(restored);
      },
    });
    expect(imported.kind).toBe("portable");
    expect(imported.reusedAssetIds).toEqual([]);
    expect([...imported.importedAssetIds].sort()).toEqual([...expectedBytes.keys()].sort());
    for (const [assetId, bytes] of expectedBytes) {
      expect(await blobBytes(await emptyVault.open(assetId))).toEqual(bytes);
    }
    expect(reopened).toBeDefined();
    const restored = reopened!;
    expect(workspaceStateDigest(restored.getState() as never)).toBe(savedDigest);
    expect([...restored.getState().components.keys()]).toEqual(savedIds);
    expect(restored.getCommandHistory()).toEqual(project.commandHistory);
    const secondAgent = controllerFor(restored, "second_agent");
    const oldSubmission = {
      ...firstSession, transaction_token: abandonedEdit.transaction_token, batch: abandonedBatch,
    };
    for (const controller of [firstAgent, secondAgent]) {
      expect(await controller.inspectWorkspace(firstSession))
        .toMatchObject({ ok: false, error: { code: "session_expired" } });
      expect(await controller.submitWorkspaceBatch(oldSubmission))
        .toMatchObject({ ok: false, error: { code: "session_expired" } });
    }
    expect(workspaceStateDigest(source.getState() as never)).toBe(savedDigest);
    expect(workspaceStateDigest(restored.getState() as never)).toBe(savedDigest);

    const secondSession = await sessionFor(secondAgent, "second_agent");
    expect(secondSession.session_token).not.toBe(firstSession.session_token);
    const readback = unwrap(await secondAgent.inspectWorkspace(secondSession));
    expect(readback.workspace_id).toBe(source.getState().workspaceId);
    expect(readback.workspace_revision).toBe(savedRevision);
    expect(readback.workspace_summary).toMatchObject({ component_count: savedIds.length });
    expect(readback.workspace_summary).toEqual(originalSummary);
    const restoredInspection = unwrap(await secondAgent.inspectWorkspaceComponent({
      ...secondSession, component_id: "SCAN_ONE",
    }));
    expect(restoredInspection.component).toEqual(originalInspection.component);
    expect(await secondAgent.submitWorkspaceBatch({ ...oldSubmission, ...secondSession }))
      .toMatchObject({ ok: false, error: { code: "transaction_not_found" } });

    const nextEdit = unwrap(await secondAgent.beginWorkspaceUpdate({
      ...secondSession, intent: "Continue editing the reopened capture", requested_component_ids: 1,
    }));
    unwrap(await secondAgent.submitWorkspaceBatch({
      ...secondSession,
      transaction_token: nextEdit.transaction_token,
      batch: { ...nextEdit.envelope, operations: [{
        op: "update_component", op_id: "second_label", id: "SCAN_ONE",
        patch: { label: "Continued by the second Agent" },
      }] },
    }));
    expect(restored.getState().components.get("SCAN_ONE")?.label).toBe("Continued by the second Agent");
    const editedSceneAndHistory = sceneAndHistory(restored);
    expect(unwrap(await secondAgent.undoWorkspaceBatch({
      ...secondSession, expected_workspace_revision: restored.getRevision(),
    })).changed).toBe(true);
    expect(sceneAndHistory(restored)).toEqual(savedSceneAndHistory);
    expect(unwrap(await secondAgent.redoWorkspaceBatch({
      ...secondSession, expected_workspace_revision: restored.getRevision(),
    })).changed).toBe(true);
    expect(sceneAndHistory(restored)).toEqual(editedSceneAndHistory);
    const editedDigest = workspaceStateDigest(restored.getState() as never);
    expect(workspaceStateDigest(source.getState() as never)).toBe(savedDigest);

    // A second export must retain the first Agent's history and both asset
    // payloads after the new Agent's edit and history round trip.
    const secondExport = await createPortableProjectBundle(
      fixture.serializer.fromStore(project.projectId, restored), emptyVault,
    );
    const finalVault = new MemoryAssetVault();
    const finalImport = await importWorkspaceProjectArtifact(await secondExport.toBlob(), {
      vault: finalVault, serializer: fixture.serializer, evidenceVault: new MemoryPrecisionEvidenceVault(),
    });
    expect(finalImport.importedAssetIds).toHaveLength(2);
    expect(finalImport.project.commandHistory).toHaveLength(project.commandHistory.length + 1);
    const finalStore = fixture.serializer.openStore(finalImport.project);
    expect(workspaceStateDigest(finalStore.getState() as never)).toBe(editedDigest);
  });
});
