import { describe, expect, it } from "vitest";
import { planWorkspaceSourceAtomicCreate } from "../../app/workspaceSourceAtomicCreate";
import type { WorkspaceSourceAtomicCreateRequest } from "../../app/components/workspace/WorkspaceSourcePanel";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WORKSPACE_PROTOCOL_VERSION, type WorkspaceCommandBatch } from "../../workspace/protocol";
import { toRenderSnapshot } from "../../workspace/renderer";
import { WorkspaceStore } from "../../workspace/state";

function localRequest(sourcePath = "$"): WorkspaceSourceAtomicCreateRequest {
  return {
    kind: "local",
    source: {
      label: "Operations snapshot",
      format: "json",
      text: JSON.stringify({ value: 42 }),
    },
    destination: {
      mode: "create",
      componentType: "data-panel",
      componentLabel: "Operations data",
      mapping: {
        id: "data-panel-root",
        label: "Show the complete feed",
        targetType: "data-panel",
        bindings: [{ targetProp: "data", sourcePath, transform: { kind: "identity" } }],
      },
    },
  };
}

function plan(store: WorkspaceStore, request = localRequest()) {
  const state = store.getState();
  const manifest = store.getComponentManifest("data-panel")!;
  let id = 0;
  return planWorkspaceSourceAtomicCreate({
    request,
    state,
    manifest,
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    componentId: "CMP_000001",
    resourceId: "RES_atomic",
    observedAt: "2026-08-26T12:00:00.000Z",
    id: (purpose) => `op_${purpose}_${++id}`,
  });
}

function batch(
  store: WorkspaceStore,
  operations: readonly WorkspaceCommandBatch["operations"][number][],
  baseRevision = store.getState().revision,
  requestId = "REQ_atomic",
): WorkspaceCommandBatch {
  const state = store.getState();
  return {
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    request_id: requestId,
    workspace_id: state.workspaceId,
    input_revision: state.revision + 1,
    base_workspace_revision: baseRevision,
    registry_digest: state.registryDigest,
    mode: "commit",
    operations: [...operations],
  };
}

describe("planWorkspaceSourceAtomicCreate", () => {
  it("creates the target, source, and binding in one revision and one undo entry", () => {
    const store = new WorkspaceStore();
    const planned = plan(store);

    store.applyDetailed(batch(store, planned.operations, planned.baseRevision));
    const committed = store.getState();
    expect(committed.revision).toBe(1);
    expect(committed.components.get(planned.componentId)).toMatchObject({
      label: "Operations data",
      props: { title: "Operations data", data: null },
    });
    expect(committed.resources.get(planned.resourceId)).toMatchObject({
      label: "Operations snapshot",
      connectorType: "inline.snapshot",
    });
    expect([...committed.connections.values()]).toEqual([
      expect.objectContaining({
        kind: "resource_binding",
        componentId: planned.componentId,
        resourceId: planned.resourceId,
        targetProp: "data",
        sourcePath: "$",
      }),
    ]);
    expect(toRenderSnapshot(committed).components.find(({ id }) => id === planned.componentId)?.props.data)
      .toEqual({ value: 42 });

    expect(store.canUndoUserCommand()).toBe(true);
    store.undoUserCommand();
    expect(store.getState()).toMatchObject({ revision: 0 });
    expect(store.getState().components.size).toBe(0);
    expect(store.getState().resources.size).toBe(0);
    expect(store.getState().connections.size).toBe(0);
  });

  it("leaves no component or source behind when Store validation rejects a binding", () => {
    const store = new WorkspaceStore();
    const planned = plan(store, localRequest("$.missing"));
    const before = store.getState();

    expect(() => store.applyDetailed(batch(store, planned.operations, planned.baseRevision)))
      .toThrow(/does not exist|path/iu);
    const after = store.getState();
    expect(after.revision).toBe(before.revision);
    expect(after.components.size).toBe(0);
    expect(after.resources.size).toBe(0);
    expect(after.connections.size).toBe(0);
    expect(store.canUndoUserCommand()).toBe(false);
  });

  it("rejects a stale plan without partially applying it", () => {
    const store = new WorkspaceStore();
    const planned = plan(store);
    store.applyDetailed(batch(store, [{
      op: "create_component",
      op_id: "op_other",
      id: "CMP_OTHER",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("annotation"),
      props: { text: "Concurrent edit" },
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }], 0, "REQ_other"));

    expect(() => store.applyDetailed(batch(store, planned.operations, planned.baseRevision, "REQ_stale")))
      .toThrow(/revision/iu);
    const state = store.getState();
    expect(state.revision).toBe(1);
    expect(state.components.has("CMP_OTHER")).toBe(true);
    expect(state.components.has(planned.componentId)).toBe(false);
    expect(state.resources.has(planned.resourceId)).toBe(false);
  });
});
