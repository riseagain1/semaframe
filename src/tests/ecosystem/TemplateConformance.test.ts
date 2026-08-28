import { describe, expect, it } from "vitest";
import {
  FIRST_PARTY_MODEL_TEMPLATES,
  FIRST_PARTY_PROJECT_TEMPLATES,
} from "../../ecosystem/templates";
import {
  parseTemplateDescriptor,
  planModelTemplateInstallation,
  planProjectTemplateInstallation,
} from "../../ecosystem/catalog";
import { WorkspaceStore } from "../../workspace/state";
import { SEMAFRAME_VERSION } from "../../version";

describe("template descriptor and installation proposal conformance", () => {
  it("validates the first-party project and model descriptors", () => {
    expect(FIRST_PARTY_PROJECT_TEMPLATES).toHaveLength(1);
    expect(FIRST_PARTY_MODEL_TEMPLATES).toHaveLength(1);
    expect(FIRST_PARTY_PROJECT_TEMPLATES[0]?.operations).toHaveLength(3);
    expect(FIRST_PARTY_MODEL_TEMPLATES[0]?.operations.map((operation) => operation.op))
      .toEqual(["create_component", "create_component", "create_component", "publish_model"]);
    expect(FIRST_PARTY_PROJECT_TEMPLATES[0]?.minimumAppVersion).toBe(SEMAFRAME_VERSION);
    expect(FIRST_PARTY_MODEL_TEMPLATES[0]?.minimumAppVersion).toBe(SEMAFRAME_VERSION);
  });

  it("returns an unexecuted new-project transaction proposal without granting permissions", () => {
    const store = new WorkspaceStore();
    const beforeRevision = store.getRevision();
    const proposal = planProjectTemplateInstallation(FIRST_PARTY_PROJECT_TEMPLATES[0]!, {
      requestId: "install_decision_board",
      proposedWorkspaceId: "PROPOSED_WORKSPACE",
      registryDigest: store.getRegistryDigest(),
      appVersion: SEMAFRAME_VERSION,
    });
    expect(proposal).toMatchObject({
      kind: "new_project_proposal",
      authorization: { status: "not_granted" },
      transaction: { base_workspace_revision: 0, workspace_id: "PROPOSED_WORKSPACE", mode: "commit" },
    });
    expect(store.getRevision()).toBe(beforeRevision);
    expect(store.getState().components.size).toBe(0);
  });

  it("pins an existing-workspace model proposal to the supplied revision", () => {
    const store = new WorkspaceStore();
    const proposal = planModelTemplateInstallation(FIRST_PARTY_MODEL_TEMPLATES[0]!, {
      requestId: "install_reference_block",
      workspaceId: store.getState().workspaceId,
      workspaceRevision: store.getRevision(),
      registryDigest: store.getRegistryDigest(),
      appVersion: SEMAFRAME_VERSION,
    });
    expect(proposal).toMatchObject({
      kind: "workspace_transaction_proposal",
      authorization: { status: "not_granted" },
      transaction: {
        workspace_id: store.getState().workspaceId,
        input_revision: store.getRevision(),
        base_workspace_revision: store.getRevision(),
      },
    });
    expect(store.getState().components.size).toBe(0);
  });

  it("keeps first-party transactions executable only through an explicit Store apply", () => {
    const projectStore = new WorkspaceStore();
    const projectProposal = planProjectTemplateInstallation(FIRST_PARTY_PROJECT_TEMPLATES[0]!, {
      requestId: "explicit_project_install",
      proposedWorkspaceId: projectStore.getState().workspaceId,
      registryDigest: projectStore.getRegistryDigest(),
      appVersion: SEMAFRAME_VERSION,
    });
    expect(projectStore.getState().components.size).toBe(0);
    projectStore.apply(projectProposal.transaction);
    expect([...projectStore.getState().components.keys()].sort()).toEqual(["CONTEXT", "DECISION", "NEXT_ACTIONS"]);

    const modelStore = new WorkspaceStore();
    const modelProposal = planModelTemplateInstallation(FIRST_PARTY_MODEL_TEMPLATES[0]!, {
      requestId: "explicit_model_install",
      workspaceId: modelStore.getState().workspaceId,
      workspaceRevision: modelStore.getRevision(),
      registryDigest: modelStore.getRegistryDigest(),
      appVersion: SEMAFRAME_VERSION,
    });
    expect(modelStore.getState().components.size).toBe(0);
    modelStore.apply(modelProposal.transaction);
    expect(modelStore.getState().components.has("REFERENCE_BLOCK")).toBe(true);
    expect(modelStore.getState().modelDefinitions.size).toBe(1);
  });

  it("rejects extra descriptor fields and wildcard authorization", () => {
    const valid = structuredClone(FIRST_PARTY_MODEL_TEMPLATES[0]!);
    expect(() => parseTemplateDescriptor({ ...valid, installerScript: "run me" })).toThrow(/not allowed/u);
    expect(() => parseTemplateDescriptor({ ...valid, requiredPermissions: ["*"] })).toThrow(/explicit permission/u);
  });

  it("refuses to plan a template that requires a newer application", () => {
    expect(() => planProjectTemplateInstallation(FIRST_PARTY_PROJECT_TEMPLATES[0]!, {
      requestId: "incompatible_template",
      proposedWorkspaceId: "PROPOSED_WORKSPACE",
      registryDigest: "registry-v1",
      appVersion: "0.3.9",
    })).toThrow(/requires SemaFrame/u);
  });
});
