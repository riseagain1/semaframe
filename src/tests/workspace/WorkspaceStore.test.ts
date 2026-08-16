import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { prepareComponentRecipe, type CreateComponentOperation, type WorkspaceOperation } from "../../workspace/protocol";
import {
  StaleRegistryDigestError,
  StaleWorkspaceRevisionError,
  WorkspacePermissionError,
  WorkspaceStore,
} from "../../workspace/state";
import { workspaceBatch } from "./helpers";

function createPanel(id = "CMP_000001"): CreateComponentOperation {
  return {
    op: "create_component",
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
    placement: { space: "viewport", anchor: "top_left", offset: { x: 24, y: 24 } },
    props: { title: "Panel" },
  };
}

describe("WorkspaceStore atomic kernel", () => {
  it("commits one mixed batch as one revision and deduplicates exact retries", () => {
    const store = new WorkspaceStore();
    const batch = workspaceBatch(store, "req_one", [
      createPanel(),
      {
        op: "create_component",
        op_id: "create_text",
        id: "CMP_000002",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("text"),
        placement: { space: "canvas2d", position: { x: 10, y: 20 } },
        parent_id: "CMP_000001",
        props: { text: "Universal canvas" },
      },
    ]);
    const first = store.applyDetailed(batch);
    const second = store.applyDetailed(batch);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(store.getRevision()).toBe(1);
    expect(first.delta.added).toEqual(["CMP_000001", "CMP_000002"]);
    expect(store.getState().components.get("CMP_000002")?.parentId).toBe("CMP_000001");
    expect(() => store.applyDetailed({ ...batch, operations: [createPanel("CMP_000009")] }))
      .toThrow(/different content/);
  });

  it("rolls back state, history, and ID observation when any later operation fails", () => {
    const store = new WorkspaceStore();
    const batch = workspaceBatch(store, "req_bad", [
      createPanel(),
      { op: "place_component", op_id: "missing", id: "CMP_999999", placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } } },
    ]);
    expect(() => store.apply(batch)).toThrow(/Unknown component/);
    expect(store.getRevision()).toBe(0);
    expect(store.getState().components.size).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
    expect(store.reserveComponentIds()).toEqual(["CMP_000001"]);
  });

  it("rejects stale workspace and registry bases without mutation", () => {
    const store = new WorkspaceStore();
    const stale = workspaceBatch(store, "stale", [createPanel()]);
    store.apply(workspaceBatch(store, "first", [{ op: "present_view", op_id: "view", view: { id: "VIEW_1", label: "Empty", componentIds: [] } }]));
    expect(() => store.apply(stale)).toThrow(StaleWorkspaceRevisionError);
    expect(() => store.apply({ ...workspaceBatch(store, "registry", [createPanel()]), registry_digest: "old" }))
      .toThrow(StaleRegistryDigestError);
    expect(store.getRevision()).toBe(1);
  });

  it("undoes and redoes whole transactions while never reusing burned IDs", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create", [createPanel()]));
    store.apply(workspaceBatch(store, "delete", [{
      op: "delete_component", op_id: "delete_panel", id: "CMP_000001",
    }]));
    expect(store.getState().components.size).toBe(0);
    store.undo();
    expect(store.getState().components.has("CMP_000001")).toBe(true);
    store.redo();
    expect(store.getState().components.size).toBe(0);
    expect(store.reserveComponentIds()).toEqual(["CMP_000002"]);
  });

  it("enforces locks and host-derived permissions", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "locked", [{
      ...createPanel(),
      locks: { placement: true, props: true, deletion: true, actions: true },
    }]));
    expect(() => store.apply(workspaceBatch(store, "move", [{
      op: "place_component", op_id: "move", id: "CMP_000001",
      placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: 0 } },
    }]))).toThrow(/locked/);
    const unauthorized = new WorkspaceStore();
    expect(() => unauthorized.apply(
      workspaceBatch(unauthorized, "no_create", [createPanel()]),
      { actor: "agent", permissions: ["workspace:write"] },
    )).toThrow(WorkspacePermissionError);
    expect(unauthorized.getRevision()).toBe(0);
  });

  it("rejects attachment and enabled event cycles atomically", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "components", [
      createPanel("CMP_000001"),
      createPanel("CMP_000002"),
    ]));
    expect(() => store.apply(workspaceBatch(store, "attach_cycle", [
      { op: "attach_component", op_id: "a", child_id: "CMP_000001", parent_id: "CMP_000002" },
      { op: "attach_component", op_id: "b", child_id: "CMP_000002", parent_id: "CMP_000001" },
    ]))).toThrow(/cycle/i);
    expect(store.getState().components.get("CMP_000001")?.parentId).toBeUndefined();

    const eventStore = new WorkspaceStore();
    eventStore.apply(workspaceBatch(eventStore, "event_components", [{
      op: "create_component", op_id: "timer", id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport", anchor: "top", offset: { x: 0, y: 0 } },
    }, {
      op: "create_component", op_id: "checklist", id: "CMP_000002",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("checklist"),
      placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: 0 } },
    }]));
    expect(() => eventStore.apply(workspaceBatch(eventStore, "event_cycle", [{
      op: "connect_event", op_id: "timer_to_list", connection: {
        kind: "event_connection", id: "CONN_1", sourceComponentId: "CMP_000001",
        event: "started", targetComponentId: "CMP_000002", action: "add_item",
        input: { id: "launch", text: "Launch" }, enabled: true,
      },
    }, {
      op: "connect_event", op_id: "list_to_timer", connection: {
        kind: "event_connection", id: "CONN_2", sourceComponentId: "CMP_000002",
        event: "changed", targetComponentId: "CMP_000001", action: "reset",
        input: {}, enabled: true,
      },
    }]))).toThrow(/Event connection cycle/i);
    expect(eventStore.getState().connections.size).toBe(0);
  });

  it("checks action effect classes at commit time", () => {
    const store = new WorkspaceStore();
    const recipe = prepareComponentRecipe({
      typeId: "recipe.external-control", version: "1.0.0", displayName: "External control",
      allowedPlacements: ["viewport"],
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [],
      actions: {
        publish: {
          inputSchema: { type: "object", additionalProperties: false },
          effectClass: "external_write",
        },
      },
      events: {},
      root: { id: "publish", primitive: "button" },
    });
    store.apply(workspaceBatch(store, "define", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }, {
      op: "create_component", op_id: "create", id: "CMP_000001",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    const invoke = workspaceBatch(store, "invoke", [{
      op: "invoke_component_action", op_id: "publish", id: "CMP_000001", action: "publish", input: {},
    }]);
    expect(() => store.apply(invoke, {
      actor: "agent", permissions: ["workspace:write", "component:invoke"],
    })).toThrow(/effect:external_write/);
    expect(store.getRevision()).toBe(1);
    expect(() => store.apply(invoke, {
      actor: "agent", permissions: ["workspace:write", "component:invoke", "effect:external_write"],
    })).not.toThrow();
  });
});
