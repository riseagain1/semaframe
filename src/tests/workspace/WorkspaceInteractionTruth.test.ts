import { describe, expect, it } from "vitest";
import { WorkspaceStoreEngineAdapter } from "../../workspace/agents/WorkspaceStoreEngineAdapter";
import type {
  WorkspaceAgentPrincipal,
  WorkspacePreparedUpdate,
} from "../../workspace/agents/contracts";
import {
  ComponentRegistry,
  DEFAULT_COMPONENT_REGISTRY,
  deterministicDigest,
  type ComponentManifest,
  type JSONObject,
} from "../../workspace/components";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import {
  prepareComponentRecipe,
  type WorkspaceCommandBatch,
  type WorkspaceOperation,
} from "../../workspace/protocol";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

function viewportComponent(
  typeId: "button" | "chart" | "table" | "timer" | "checklist",
  id: string,
  props?: JSONObject,
): WorkspaceOperation {
  return {
    op: "create_component",
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref(typeId),
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    ...(props ? { props } : {}),
  };
}

function connect(
  id: string,
  sourceComponentId: string,
  event: string,
  targetComponentId: string,
  action: string,
  input: JSONObject = {},
): WorkspaceOperation {
  return {
    op: "connect_event",
    op_id: `connect_${id}`,
    connection: {
      kind: "event_connection",
      id,
      sourceComponentId,
      event,
      targetComponentId,
      action,
      input,
      enabled: true,
    },
  };
}

function agentBatch(
  prepared: WorkspacePreparedUpdate,
  operations: WorkspaceOperation[],
): WorkspaceCommandBatch {
  return {
    ...prepared.envelope,
    protocol_version: "1.2",
    operations,
  };
}

const agent: WorkspaceAgentPrincipal = {
  sessionId: "interaction_truth_session",
  clientId: "interaction_truth_client",
  scopes: ["workspace:read", "workspace:write", "component:invoke", "event:connect"],
};

describe("truthful built-in interactions", () => {
  it("advertises only semantic current interactions while preserving exact legacy manifests", () => {
    for (const typeId of ["spatial-entity", "panel", "text", "image", "annotation"]) {
      expect(DEFAULT_COMPONENT_REGISTRY.require(typeId).events.selected).toBeUndefined();
      expect(DEFAULT_COMPONENT_REGISTRY.require(typeId, "1.0.0").events.selected).toBeDefined();
    }

    const chart = DEFAULT_COMPONENT_REGISTRY.require("chart");
    const table = DEFAULT_COMPONENT_REGISTRY.require("table");
    const document = DEFAULT_COMPONENT_REGISTRY.require("document");
    const timer = DEFAULT_COMPONENT_REGISTRY.require("timer");
    const spatial = DEFAULT_COMPONENT_REGISTRY.require("spatial-entity");
    expect(chart.actions.select_point).toBeDefined();
    expect(chart.events.point_selected).toBeDefined();
    expect(table.actions.select_row).toBeDefined();
    expect(table.events.row_selected).toBeDefined();
    expect(document.events.citation_selected).toBeUndefined();
    expect(document.actions.select_citation).toBeUndefined();
    expect(timer.actions.complete_if_due).toBeDefined();
    expect(spatial.actions.complete_animation).toMatchObject({
      requiredPermissions: ["host:signal"],
      routable: false,
    });
    expect(spatial.events.animation_finished).toBeDefined();
  });

  it("routes chart selection into table selection and exposes public causality", async () => {
    const store = new WorkspaceStore({ clock: () => 5_000 });
    store.apply(workspaceBatch(store, "setup", [
      viewportComponent("chart", "CHART", {
        chartType: "line",
        labels: ["Mon"],
        series: [{ id: "price", label: "Price", values: [100] }],
      }),
      viewportComponent("table", "TABLE", {
        columns: [{ key: "name", label: "Name" }],
        rows: [{ id: "row_market", name: "Market" }],
      }),
      connect("CHART_TO_TABLE", "CHART", "point_selected", "TABLE", "select_row", {
        rowId: "row_market",
      }),
    ]));

    const result = store.applyDetailed(workspaceBatch(store, "select", [{
      op: "invoke_component_action",
      op_id: "select_point",
      id: "CHART",
      action: "select_point",
      input: { pointId: "price:0" },
    }]));

    expect(store.getState().components.get("CHART")?.durableState.selectedPoint).toBe("price:0");
    expect(store.getState().components.get("TABLE")?.durableState.selectedRow).toBe("row_market");
    expect(result.events).toMatchObject([{
      componentId: "CHART",
      event: "point_selected",
      source: "user",
    }, {
      componentId: "TABLE",
      event: "row_selected",
      source: "binding",
      causedBy: { connectionId: "CHART_TO_TABLE" },
    }]);

    const adapter = new WorkspaceStoreEngineAdapter(store);
    const publicEvents = await adapter.readEvents("0", 20);
    expect(publicEvents.events[1]).toMatchObject({
      type: "row_selected",
      caused_by_event_id: result.events[0]?.id,
      connection_id: "CHART_TO_TABLE",
    });
    const chartInspection = await adapter.inspectComponent("CHART", agent);
    expect(chartInspection.interactionCompatibility).toMatchObject({
      status: "current",
      supports_current_interactions: true,
    });
    expect(chartInspection.eventConnections).toEqual([
      expect.objectContaining({
        id: "CHART_TO_TABLE",
        direction: "outbound",
        target_component_id: "TABLE",
        action: "select_row",
      }),
    ]);
    const tableInspection = await adapter.inspectComponent("TABLE", agent);
    expect(tableInspection.eventConnections).toEqual([
      expect.objectContaining({ id: "CHART_TO_TABLE", direction: "inbound" }),
    ]);
  });

  it("reports legacy pinned interaction compatibility without silently repinning", async () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "legacy_panel", [{
      op: "create_component",
      op_id: "legacy_panel",
      id: "LEGACY_PANEL",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel", "1.1.0"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    const inspection = await new WorkspaceStoreEngineAdapter(store).inspectComponent("LEGACY_PANEL", agent);
    expect(inspection.interactionCompatibility).toMatchObject({
      status: "legacy_pinned",
      pinned_version: "1.1.0",
      current_version: "1.2.0",
      supports_current_interactions: false,
      current_manifest: { typeId: "panel", version: "1.2.0" },
    });
    expect(store.getState().components.get("LEGACY_PANEL")?.type.version).toBe("1.1.0");
  });

  it("explicitly upgrades a legacy built-in as one authorized undoable replayable operation", () => {
    const store = new WorkspaceStore();
    const legacyRef = DEFAULT_COMPONENT_REGISTRY.ref("panel", "1.1.0");
    const currentRef = DEFAULT_COMPONENT_REGISTRY.ref("panel");
    store.apply(workspaceBatch(store, "legacy_panel_for_upgrade", [{
      op: "create_component",
      op_id: "legacy_panel_for_upgrade",
      id: "UPGRADE_PANEL",
      component_type: legacyRef,
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      props: { title: "Keep me", backgroundColor: "#112233" },
    }]));
    const beforeUpgrade = store.getState().components.get("UPGRADE_PANEL")!;

    expect(() => store.apply(workspaceBatch(store, "upgrade_without_scope", [{
      op: "upgrade_component_manifest",
      op_id: "upgrade_without_scope",
      id: "UPGRADE_PANEL",
      component_type: currentRef,
    }]), { actor: "agent", permissions: ["workspace:write"] })).toThrow(/component:update/i);

    const upgraded = store.applyDetailed(workspaceBatch(store, "upgrade_panel", [{
      op: "upgrade_component_manifest",
      op_id: "upgrade_panel",
      id: "UPGRADE_PANEL",
      component_type: currentRef,
    }]), { actor: "agent", permissions: ["workspace:write", "component:update"] });
    expect(upgraded.command.resolvedOperations).toEqual([{
      op: "upgrade_component_manifest",
      op_id: "upgrade_panel",
      id: "UPGRADE_PANEL",
      component_type: currentRef,
    }]);
    expect(store.getState().components.get("UPGRADE_PANEL")).toMatchObject({
      type: currentRef,
      props: { title: "Keep me", backgroundColor: "#112233" },
    });
    expect(DEFAULT_COMPONENT_REGISTRY.resolve(currentRef).actions.hide).toBeDefined();

    store.undo();
    expect(store.getState().components.get("UPGRADE_PANEL")?.type).toEqual(legacyRef);
    expect(store.getState().components.get("UPGRADE_PANEL")?.props).toEqual(beforeUpgrade.props);
    store.redo();
    expect(store.getState().components.get("UPGRADE_PANEL")?.type).toEqual(currentRef);

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("explicit_manifest_upgrade", store),
    )));
    expect(reopened.getState().components.get("UPGRADE_PANEL")?.type).toEqual(currentRef);
    expect(reopened.getCommandHistory().at(-1)?.resolvedOperations).toEqual(
      store.getCommandHistory().at(-1)?.resolvedOperations,
    );
  });

  it("replays the exact historical upgrade target after a newer built-in is installed", () => {
    const currentPanel = DEFAULT_COMPONENT_REGISTRY.require("panel");
    const { digest: _currentDigest, ...currentContent } = structuredClone(currentPanel);
    const futureContent = { ...currentContent, version: "1.3.0" };
    const futurePanel: ComponentManifest = {
      ...futureContent,
      digest: deterministicDigest(futureContent),
    };
    const futureRegistry = new ComponentRegistry([
      ...DEFAULT_COMPONENT_REGISTRY.list(),
      futurePanel,
    ]);

    const checkpointSource = new WorkspaceStore({ registry: futureRegistry });
    checkpointSource.apply(workspaceBatch(checkpointSource, "future_legacy_panel", [{
      op: "create_component",
      op_id: "future_legacy_panel",
      id: "FUTURE_PANEL",
      component_type: futureRegistry.ref("panel", "1.1.0"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    const checkpoint = checkpointSource.getState();
    const store = new WorkspaceStore({
      registry: futureRegistry,
      initialState: checkpoint as never,
      checkpointState: checkpoint as never,
      nextComponentSequence: checkpointSource.getAllocatorSnapshot(),
      checkpointNextComponentSequence: checkpointSource.getAllocatorSnapshot(),
      nextEventCursor: checkpointSource.getNextEventCursor(),
      checkpointNextEventCursor: checkpointSource.getNextEventCursor(),
    });
    const historicalTarget = futureRegistry.ref("panel", "1.2.0");
    const historicalBatch = workspaceBatch(store, "historical_upgrade_target", [{
      op: "upgrade_component_manifest",
      op_id: "historical_upgrade_target",
      id: "FUTURE_PANEL",
      component_type: historicalTarget,
    }]);

    expect(() => store.apply(historicalBatch)).toThrow(/exact current manifest panel@1\.3\.0/i);
    const replayed = store.applyResolvedHistoryDetailed(historicalBatch, {
      actor: "user",
      permissions: ["*"],
    });
    expect(replayed.state.components.get("FUTURE_PANEL")?.type).toEqual(historicalTarget);

    const serializer = new WorkspaceProjectSerializer(futureRegistry);
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("future_registry_upgrade_replay", store),
    )));
    expect(reopened.getState().components.get("FUTURE_PANEL")?.type).toEqual(historicalTarget);
  });

  it("rejects unsafe, locked, recipe, already-current, and route-breaking upgrades atomically", () => {
    const currentPanel = DEFAULT_COMPONENT_REGISTRY.ref("panel");
    const legacyPanel = DEFAULT_COMPONENT_REGISTRY.ref("panel", "1.1.0");
    const createLegacyPanel = (id: string): WorkspaceOperation => ({
      op: "create_component",
      op_id: `create_${id}`,
      id,
      component_type: legacyPanel,
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    });

    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "upgrade_rejections", [
      createLegacyPanel("LEGACY"),
      viewportComponent("checklist", "ROUTE_TARGET"),
      connect("LEGACY_SELECTED", "LEGACY", "selected", "ROUTE_TARGET", "clear_completed"),
      {
        op: "create_component",
        op_id: "create_current",
        id: "CURRENT",
        component_type: currentPanel,
        placement: { space: "viewport", anchor: "center", offset: { x: 20, y: 20 } },
      },
      createLegacyPanel("LOCKED"),
      createLegacyPanel("PROPS_LOCKED"),
    ]));
    store.apply(workspaceBatch(store, "lock_upgrade", [{
      op: "update_component",
      op_id: "lock_upgrade",
      id: "LOCKED",
      patch: { locks: { actions: true } },
    }, {
      op: "update_component",
      op_id: "lock_props_upgrade",
      id: "PROPS_LOCKED",
      patch: { locks: { props: true } },
    }]));

    const rejected = (requestId: string, operation: WorkspaceOperation, pattern: RegExp) => {
      const revision = store.getRevision();
      expect(() => store.apply(workspaceBatch(store, requestId, [operation]))).toThrow(pattern);
      expect(store.getRevision()).toBe(revision);
    };
    rejected("wrong_type", {
      op: "upgrade_component_manifest", op_id: "wrong_type", id: "LEGACY",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("chart"),
    }, /cannot change typeId/i);
    rejected("not_current", {
      op: "upgrade_component_manifest", op_id: "not_current", id: "LEGACY",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel", "1.0.0"),
    }, /exact current manifest/i);
    rejected("already_current", {
      op: "upgrade_component_manifest", op_id: "already_current", id: "CURRENT",
      component_type: currentPanel,
    }, /already pinned/i);
    rejected("locked_upgrade", {
      op: "upgrade_component_manifest", op_id: "locked_upgrade", id: "LOCKED",
      component_type: currentPanel,
    }, /locked/i);
    rejected("props_locked_upgrade", {
      op: "upgrade_component_manifest", op_id: "props_locked_upgrade", id: "PROPS_LOCKED",
      component_type: currentPanel,
    }, /locked/i);
    rejected("break_legacy_route", {
      op: "upgrade_component_manifest", op_id: "break_legacy_route", id: "LEGACY",
      component_type: currentPanel,
    }, /unknown event/i);
    expect(store.getState().components.get("LEGACY")?.type).toEqual(legacyPanel);

    const recipe = prepareComponentRecipe({
      typeId: "recipe.upgrade-denied",
      version: "1.0.0",
      displayName: "Upgrade denied",
      allowedPlacements: ["viewport"],
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {},
      defaultDurableState: {},
      writableProps: [],
      actions: {},
      events: {},
      root: { id: "root", primitive: "text" },
    });
    store.apply(workspaceBatch(store, "recipe_component", [{
      op: "define_component_recipe", op_id: "define_recipe", recipe,
    }, {
      op: "create_component", op_id: "create_recipe", id: "RECIPE",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: { space: "viewport", anchor: "center", offset: { x: 40, y: 40 } },
    }]));
    rejected("recipe_upgrade", {
      op: "upgrade_component_manifest", op_id: "recipe_upgrade", id: "RECIPE",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
    }, /not an upgradeable built-in/i);
  });

  it("rejects an upgrade that would invalidate an existing resource binding", () => {
    const currentPanel = DEFAULT_COMPONENT_REGISTRY.require("panel");
    const { digest: _currentDigest, ...currentContent } = structuredClone(currentPanel);
    const futureContent = {
      ...currentContent,
      version: "1.3.0",
      writableProps: currentContent.writableProps.filter((prop) => prop !== "title"),
    };
    const futurePanel: ComponentManifest = {
      ...futureContent,
      digest: deterministicDigest(futureContent),
    };
    const registry = new ComponentRegistry([...DEFAULT_COMPONENT_REGISTRY.list(), futurePanel]);
    const store = new WorkspaceStore({ registry, clock: () => 1_000 });
    store.apply(workspaceBatch(store, "bound_panel", [{
      op: "create_component",
      op_id: "create_bound_panel",
      id: "BOUND_PANEL",
      component_type: registry.ref("panel", "1.2.0"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }, {
      op: "upsert_resource",
      op_id: "upsert_title",
      resource: {
        id: "PANEL_TITLE",
        label: "Panel title",
        connectorType: "inline.snapshot",
        connectorVersion: "1.0.0",
        outputSchema: { type: "string" },
        config: {},
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data: "Bound title",
          contentHash: "host-normalized",
          retrievedAt: "2026-08-15T00:00:00.000Z",
          stale: false,
          provenance: [],
        },
        status: "ready",
      },
    }, {
      op: "bind_resource",
      op_id: "bind_title",
      binding: {
        kind: "resource_binding",
        id: "BIND_PANEL_TITLE",
        resourceId: "PANEL_TITLE",
        componentId: "BOUND_PANEL",
        targetProp: "title",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      },
    }]));
    const revision = store.getRevision();

    expect(() => store.apply(workspaceBatch(store, "upgrade_bound_panel", [{
      op: "upgrade_component_manifest",
      op_id: "upgrade_bound_panel",
      id: "BOUND_PANEL",
      component_type: registry.ref("panel"),
    }]))).toThrow(/non-writable prop/i);
    expect(store.getRevision()).toBe(revision);
    expect(store.getState().components.get("BOUND_PANEL")?.type)
      .toEqual(registry.ref("panel", "1.2.0"));
    expect(store.getState().connections.has("BIND_PANEL_TITLE")).toBe(true);
  });

  it("rediscovers event routes without exposing their static input values", async () => {
    const sentinel = "Bearer MCP_CONNECTION_SENTINEL_83";
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "private_route", [
      viewportComponent("button", "PRIVATE_SOURCE"),
      viewportComponent("checklist", "PRIVATE_TARGET"),
      connect("PRIVATE_CONNECTION", "PRIVATE_SOURCE", "pressed", "PRIVATE_TARGET", "add_item", {
        id: "private_item",
        text: sentinel,
      }),
    ]));
    const adapter = new WorkspaceStoreEngineAdapter(store);
    expect(JSON.stringify(adapter.getState().summary)).not.toContain(sentinel);
    const inspection = await adapter.inspectComponent("PRIVATE_SOURCE", agent);
    expect(JSON.stringify(inspection)).not.toContain(sentinel);
    expect(inspection.eventConnections).toEqual([
      expect.objectContaining({
        id: "PRIVATE_CONNECTION",
        direction: "outbound",
        has_static_input: true,
        input_mode: "static",
      }),
    ]);
    expect(store.getState().connections.get("PRIVATE_CONNECTION")).toMatchObject({
      input: { text: sentinel },
    });
  });

  it("forwards only an exact-schema event payload and preserves routed transition hints", () => {
    const store = new WorkspaceStore({ clock: () => 6_000 });
    store.apply(workspaceBatch(store, "setup_payload_route", [
      viewportComponent("chart", "SOURCE_CHART", {
        chartType: "line",
        labels: ["Mon"],
        series: [{ id: "price", label: "Price", values: [100] }],
      }),
      viewportComponent("chart", "TARGET_CHART", {
        chartType: "line",
        labels: ["Mon"],
        series: [{ id: "price", label: "Price", values: [100] }],
      }),
      viewportComponent("table", "MISMATCH_TABLE", {
        columns: [{ key: "name", label: "Name" }],
        rows: [{ id: "price:0", name: "Price" }],
      }),
      {
        op: "connect_event",
        op_id: "connect_exact_payload",
        connection: {
          kind: "event_connection",
          id: "EXACT_PAYLOAD",
          sourceComponentId: "SOURCE_CHART",
          event: "point_selected",
          targetComponentId: "TARGET_CHART",
          action: "select_point",
          inputMode: "event_payload",
          transition: { durationMs: 240, delayMs: 20, easing: "ease_out" },
          enabled: true,
        },
      },
    ]));

    const result = store.applyDetailed(workspaceBatch(store, "forward_payload", [{
      op: "invoke_component_action",
      op_id: "source_select",
      id: "SOURCE_CHART",
      action: "select_point",
      input: { pointId: "price:0" },
    }]));
    expect(store.getState().components.get("TARGET_CHART")?.durableState.selectedPoint).toBe("price:0");
    expect(result.command.resolvedOperations[1]).toMatchObject({
      op: "invoke_component_action",
      id: "TARGET_CHART",
      input: { pointId: "price:0" },
      transition: { durationMs: 240, delayMs: 20, easing: "ease_out" },
    });

    expect(() => store.apply(workspaceBatch(store, "reject_mismatch", [{
      op: "connect_event",
      op_id: "connect_mismatch",
      connection: {
        kind: "event_connection",
        id: "MISMATCH_PAYLOAD",
        sourceComponentId: "SOURCE_CHART",
        event: "point_selected",
        targetComponentId: "MISMATCH_TABLE",
        action: "select_row",
        inputMode: "event_payload",
        enabled: true,
      },
    }]))).toThrow(/identical source-event and target-action schemas/i);

    expect(() => store.apply(workspaceBatch(store, "reject_mixed_input", [{
      op: "connect_event",
      op_id: "connect_mixed_input",
      connection: {
        kind: "event_connection",
        id: "MIXED_PAYLOAD",
        sourceComponentId: "SOURCE_CHART",
        event: "point_selected",
        targetComponentId: "TARGET_CHART",
        action: "select_point",
        inputMode: "event_payload",
        input: { pointId: "static" },
        enabled: true,
      },
    }]))).toThrow(/cannot combine static input/i);

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("payload_transition", store),
    )));
    expect(reopened.getState().connections.get("EXACT_PAYLOAD")).toMatchObject({
      inputMode: "event_payload",
      transition: { durationMs: 240, delayMs: 20, easing: "ease_out" },
    });
  });

  it("settles a due timer once and routes finished in the same atomic revision", () => {
    let now = 1_000;
    const store = new WorkspaceStore({ clock: () => now });
    store.apply(workspaceBatch(store, "setup", [
      viewportComponent("timer", "TIMER", { durationMs: 100 }),
      viewportComponent("checklist", "CHECKLIST"),
      connect("TIMER_FINISHED", "TIMER", "finished", "CHECKLIST", "add_item", {
        id: "complete",
        text: "Timer completed",
      }),
    ]));
    store.apply(workspaceBatch(store, "start", [{
      op: "invoke_component_action",
      op_id: "start_timer",
      id: "TIMER",
      action: "start",
      input: {},
    }]));

    now = 1_050;
    const early = store.applyDetailed(workspaceBatch(store, "settle_early", [{
      op: "invoke_component_action",
      op_id: "complete_early",
      id: "TIMER",
      action: "complete_if_due",
      input: {},
    }]));
    expect(early.events).toEqual([]);
    expect(store.getState().components.get("TIMER")?.durableState.phase).toBe("running");

    now = 1_100;
    const settled = store.applyDetailed(workspaceBatch(store, "settle_due", [{
      op: "invoke_component_action",
      op_id: "complete_due",
      id: "TIMER",
      action: "complete_if_due",
      input: {},
    }]));
    expect(settled.events.map((event) => event.event)).toEqual(["finished", "changed"]);
    expect(new Set(settled.events.map((event) => event.workspaceRevision))).toEqual(
      new Set([settled.state.revision]),
    );
    const finishedEventId = settled.events[0]?.id;
    expect(finishedEventId).toMatch(/^EVT_\d{8}$/u);
    expect(settled.events[1]?.causedBy).toEqual({
      eventId: finishedEventId,
      connectionId: "TIMER_FINISHED",
    });
    expect(store.getState().components.get("TIMER")?.durableState.phase).toBe("completed");
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toHaveLength(1);

    now = 1_200;
    const duplicate = store.applyDetailed(workspaceBatch(store, "settle_duplicate", [{
      op: "invoke_component_action",
      op_id: "complete_duplicate",
      id: "TIMER",
      action: "complete_if_due",
      input: {},
    }]));
    expect(duplicate.events).toEqual([]);
    expect(store.getEventHistory().filter((event) => event.event === "finished")).toHaveLength(1);
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toHaveLength(1);

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("timer_completion", store),
    )));
    expect(reopened.getEventHistory()).toEqual(store.getEventHistory());
    expect(reopened.getState().components.get("TIMER")?.durableState.phase).toBe("completed");
  });

  it("allocates a fresh completion event after deleting and recreating the same timer ID", () => {
    const store = new WorkspaceStore({ clock: () => 2_000 });
    const timerAndRoute = (): WorkspaceOperation[] => [
      viewportComponent("timer", "REUSED_TIMER", { durationMs: 0 }),
      connect("REUSED_TIMER_ROUTE", "REUSED_TIMER", "finished", "PRESS_TARGET", "press"),
    ];
    store.apply(workspaceBatch(store, "setup_reused_timer", [
      viewportComponent("button", "PRESS_TARGET"),
      ...timerAndRoute(),
    ]));

    const first = store.applyDetailed(workspaceBatch(store, "first_zero_timer", [{
      op: "invoke_component_action",
      op_id: "first_zero_timer",
      id: "REUSED_TIMER",
      action: "start",
      input: {},
    }]));
    const firstFinished = first.events.find((event) => event.event === "finished");
    expect(firstFinished).toBeDefined();
    expect(store.getState().components.get("PRESS_TARGET")?.durableState.pressCount).toBe(1);

    store.apply(workspaceBatch(store, "delete_reused_timer", [{
      op: "delete_component",
      op_id: "delete_reused_timer",
      id: "REUSED_TIMER",
      policy: "cascade",
      confirm: true,
    }]));
    store.apply(workspaceBatch(store, "recreate_reused_timer", timerAndRoute()));
    const second = store.applyDetailed(workspaceBatch(store, "second_zero_timer", [{
      op: "invoke_component_action",
      op_id: "second_zero_timer",
      id: "REUSED_TIMER",
      action: "start",
      input: {},
    }]));
    const secondFinished = second.events.find((event) => event.event === "finished");
    expect(secondFinished).toBeDefined();
    expect(secondFinished?.id).not.toBe(firstFinished?.id);
    expect(store.getEventHistory().filter((event) => event.event === "finished")).toHaveLength(2);
    expect(store.getState().components.get("PRESS_TARGET")?.durableState.pressCount).toBe(2);
    expect(second.events.find((event) => event.event === "pressed")?.causedBy).toEqual({
      eventId: secondFinished?.id,
      connectionId: "REUSED_TIMER_ROUTE",
    });
  });

  it("accepts animation completion only from the host and ignores stale or looping callbacks", async () => {
    const store = new WorkspaceStore({ clock: () => 8_000 });
    store.apply(workspaceBatch(store, "setup", [{
      op: "create_component",
      op_id: "create_stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }, {
      op: "create_component",
      op_id: "create_actor",
      id: "ACTOR",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      props: { assetId: "humanoid_adult_neutral_01", entityKind: "character" },
    }, viewportComponent("button", "BUTTON"), viewportComponent("checklist", "CHECKLIST"),
    connect("ANIMATION_FINISHED", "ACTOR", "animation_finished", "CHECKLIST", "add_item", {
      id: "animation",
      text: "Animation finished",
    })]));

    expect(() => store.apply(workspaceBatch(store, "forbidden_route", [
      connect("FORGED_COMPLETION", "BUTTON", "pressed", "ACTOR", "complete_animation", {
        generation: 1,
      }),
    ]))).toThrow(/host-only action/i);

    store.apply(workspaceBatch(store, "play_once", [{
      op: "invoke_component_action",
      op_id: "play_once",
      id: "ACTOR",
      action: "play_animation",
      input: { clip: "enter", loop: false },
    }]));
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: (revision) => `completion_agent_${revision}`,
    });
    const prepared = await adapter.prepare("Claim animation completion", 1, agent);
    await expect(adapter.submit(prepared, agentBatch(prepared, [{
      op: "invoke_component_action",
      op_id: "agent_completion",
      id: "ACTOR",
      action: "complete_animation",
      input: { generation: 1 },
    }]), agent)).rejects.toMatchObject({
      code: "permission_denied",
      options: { details: { missing_permissions: ["host:signal"] } },
    });
    expect(store.getState().components.get("ACTOR")?.durableState.playback).toMatchObject({
      playing: true,
      generation: 1,
    });
    store.apply(workspaceBatch(store, "lock_actor_actions", [{
      op: "update_component",
      op_id: "lock_actor_actions",
      id: "ACTOR",
      patch: { locks: { actions: true } },
    }]));
    expect(() => store.apply(workspaceBatch(store, "locked_stop", [{
      op: "invoke_component_action",
      op_id: "locked_stop",
      id: "ACTOR",
      action: "stop_animation",
      input: {},
    }]))).toThrow(/actions are locked/i);

    const completion = store.applyDetailed(workspaceBatch(store, "host_completion", [{
      op: "invoke_component_action",
      op_id: "host_completion",
      id: "ACTOR",
      action: "complete_animation",
      input: { generation: 1 },
    }]));
    expect(completion.events.map((event) => event.event)).toEqual(["animation_finished", "changed"]);
    expect(store.getState().components.get("ACTOR")?.durableState.playback).toMatchObject({
      clip: "enter",
      playing: false,
      generation: 1,
    });
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toHaveLength(1);

    const stale = store.applyDetailed(workspaceBatch(store, "stale_completion", [{
      op: "invoke_component_action",
      op_id: "stale_completion",
      id: "ACTOR",
      action: "complete_animation",
      input: { generation: 1 },
    }]));
    expect(stale.events).toEqual([]);

    store.apply(workspaceBatch(store, "unlock_actor_actions", [{
      op: "update_component",
      op_id: "unlock_actor_actions",
      id: "ACTOR",
      patch: { locks: { actions: false } },
    }]));
    store.apply(workspaceBatch(store, "play_loop", [{
      op: "invoke_component_action",
      op_id: "play_loop",
      id: "ACTOR",
      action: "play_animation",
      input: { clip: "run", loop: true },
    }]));
    const looping = store.applyDetailed(workspaceBatch(store, "loop_completion", [{
      op: "invoke_component_action",
      op_id: "loop_completion",
      id: "ACTOR",
      action: "complete_animation",
      input: { generation: 2 },
    }]));
    expect(looping.events).toEqual([]);
    expect(store.getState().components.get("ACTOR")?.durableState.playback).toMatchObject({
      playing: true,
      loop: true,
      generation: 2,
    });
  });
});
