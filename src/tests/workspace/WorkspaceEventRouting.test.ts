import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import {
  prepareComponentRecipe,
  type CreateComponentOperation,
  type WorkspaceOperation,
} from "../../workspace/protocol";
import {
  MAX_ACTION_EFFECTS_PER_COMMIT,
  WorkspaceStore,
} from "../../workspace/state";
import { workspaceBatch } from "./helpers";

function createButton(
  id: string,
  opId = `create_${id}`,
  layoutIndex = 0,
): CreateComponentOperation {
  const column = layoutIndex % 13;
  const row = Math.floor(layoutIndex / 13);
  return {
    op: "create_component",
    op_id: opId,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("button"),
    placement: {
      space: "viewport",
      anchor: "center",
      offset: { x: -576 + column * 96, y: -168 + row * 48 },
      size: { width: 80, height: 32 },
    },
  };
}

function createChecklist(id = "CHECKLIST"): CreateComponentOperation {
  return {
    op: "create_component",
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("checklist"),
    placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: 0 } },
  };
}

function connect(
  id: string,
  sourceComponentId: string,
  event: string,
  targetComponentId: string,
  action: string,
  input: Record<string, string> = {},
  enabled = true,
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
      enabled,
    },
  };
}

describe("Workspace deterministic event routing", () => {
  it("routes timer events atomically, records causation, deduplicates, persists, and undo/redoes", () => {
    const store = new WorkspaceStore({ clock: () => 1_234 });
    store.apply(workspaceBatch(store, "setup", [{
      op: "create_component",
      op_id: "create_timer",
      id: "TIMER",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport", anchor: "top", offset: { x: 0, y: 0 } },
      props: { durationMs: 5_000 },
    }, createChecklist(), connect(
      "CONN_TIMER_LIST",
      "TIMER",
      "started",
      "CHECKLIST",
      "add_item",
      { id: "started", text: "Timer started" },
    )]));

    const start = workspaceBatch(store, "start", [{
      op: "invoke_component_action",
      op_id: "start_timer",
      id: "TIMER",
      action: "start",
      input: {},
    }]);
    const result = store.applyDetailed(start);
    expect(store.getRevision()).toBe(2);
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toEqual([
      { id: "started", text: "Timer started", completed: false },
    ]);
    expect(result.command.resolvedOperations).toHaveLength(2);
    expect(result.command.resolvedOperations[1]).toMatchObject({
      op: "invoke_component_action",
      id: "CHECKLIST",
      action: "add_item",
      effective_time_ms: 1_234,
    });
    expect(result.events).toMatchObject([{
      componentId: "TIMER",
      event: "started",
      source: "user",
    }, {
      componentId: "CHECKLIST",
      event: "changed",
      source: "binding",
      causedBy: { connectionId: "CONN_TIMER_LIST" },
    }]);
    expect(result.command.resolvedActionEffects?.[1]?.causedBy).toEqual({
      eventId: result.events[0]!.id,
      connectionId: "CONN_TIMER_LIST",
    });

    const retry = store.applyDetailed(start);
    expect(retry.deduplicated).toBe(true);
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toHaveLength(1);

    store.undo();
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toEqual([]);
    store.redo();
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toHaveLength(1);

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("routing", store),
    )));
    expect(reopened.getState().components.get("CHECKLIST")?.durableState.items).toHaveLength(1);
    expect(reopened.getCommandHistory().at(-1)?.resolvedOperations).toEqual(
      store.getCommandHistory().at(-1)?.resolvedOperations,
    );
    expect(reopened.getEventHistory()).toEqual(store.getEventHistory());
  });

  it("ignores disabled connections", () => {
    const store = new WorkspaceStore({ clock: () => 10 });
    store.apply(workspaceBatch(store, "setup", [
      createButton("SOURCE"),
      createChecklist(),
      connect("CONN_DISABLED", "SOURCE", "pressed", "CHECKLIST", "add_item", {
        id: "unexpected", text: "Unexpected",
      }, false),
    ]));
    const result = store.applyDetailed(workspaceBatch(store, "press", [{
      op: "invoke_component_action", op_id: "press", id: "SOURCE", action: "press", input: {},
    }]));
    expect(result.command.resolvedOperations).toHaveLength(1);
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toEqual([]);
  });

  it("executes matching connections in stable connection-id order", () => {
    const store = new WorkspaceStore({ clock: () => 20 });
    store.apply(workspaceBatch(store, "setup", [
      createButton("SOURCE"),
      createChecklist(),
      connect("Z_LAST", "SOURCE", "pressed", "CHECKLIST", "add_item", { id: "z", text: "Z" }),
      connect("A_FIRST", "SOURCE", "pressed", "CHECKLIST", "add_item", { id: "a", text: "A" }),
    ]));
    store.apply(workspaceBatch(store, "press", [{
      op: "invoke_component_action", op_id: "press", id: "SOURCE", action: "press", input: {},
    }]));
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toEqual([
      { id: "a", text: "A", completed: false },
      { id: "z", text: "Z", completed: false },
    ]);
  });

  it("rejects a locked routed target and rolls the source action back", () => {
    const store = new WorkspaceStore({ clock: () => 30 });
    store.apply(workspaceBatch(store, "setup", [
      createButton("SOURCE"),
      createChecklist(),
      connect("CONN_LOCK", "SOURCE", "pressed", "CHECKLIST", "add_item", {
        id: "locked", text: "Locked",
      }),
    ]));
    store.apply(workspaceBatch(store, "lock", [{
      op: "update_component",
      op_id: "lock_target",
      id: "CHECKLIST",
      patch: { locks: { actions: true } },
    }]));
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "press", [{
      op: "invoke_component_action", op_id: "press", id: "SOURCE", action: "press", input: {},
    }]))).toThrow(/actions are locked/i);
    expect(store.getRevision()).toBe(revision);
    expect(store.getState().components.get("SOURCE")?.durableState.pressCount).toBe(0);
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toEqual([]);
  });

  it("caps routed action fan-out without committing a partial cascade", () => {
    const store = new WorkspaceStore({ clock: () => 40 });
    const targets = Array.from({ length: MAX_ACTION_EFFECTS_PER_COMMIT }, (_, index) =>
      createButton(`TARGET_${String(index).padStart(3, "0")}`, undefined, index + 1));
    store.apply(workspaceBatch(store, "buttons_a", [createButton("SOURCE"), ...targets.slice(0, 49)]));
    store.apply(workspaceBatch(store, "buttons_b", targets.slice(49)));
    store.apply(workspaceBatch(store, "connections", targets.map((target, index) => connect(
      `CONN_${String(index).padStart(3, "0")}`,
      "SOURCE",
      "pressed",
      target.id,
      "press",
    ))));
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "fanout", [{
      op: "invoke_component_action", op_id: "press", id: "SOURCE", action: "press", input: {},
    }]))).toThrow(/routing exceeds/i);
    expect(store.getRevision()).toBe(revision);
    expect(store.getState().components.get("SOURCE")?.durableState.pressCount).toBe(0);
    expect(store.getState().components.get("TARGET_000")?.durableState.pressCount).toBe(0);
  });

  it("refuses privileged target effects even for a fully trusted connector author", () => {
    const store = new WorkspaceStore();
    const recipe = prepareComponentRecipe({
      typeId: "recipe.external-target",
      version: "1.0.0",
      displayName: "External target",
      allowedPlacements: ["viewport"],
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {},
      defaultDurableState: {},
      writableProps: [],
      actions: {
        publish: {
          inputSchema: { type: "object", additionalProperties: false },
          effectClass: "external_write",
        },
      },
      events: {},
      root: { id: "root", primitive: "button" },
    });
    store.apply(workspaceBatch(store, "setup", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }, createButton("SOURCE"), {
      op: "create_component",
      op_id: "create_target",
      id: "TARGET",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: { space: "viewport", anchor: "center", offset: { x: 20, y: 20 } },
    }]));
    let rejection: unknown;
    try {
      store.apply(workspaceBatch(store, "connect", [
        connect("CONN_PRIVILEGED", "SOURCE", "pressed", "TARGET", "publish"),
      ]));
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ code: "event_effect_not_allowed" });
    expect(store.getState().connections.has("CONN_PRIVILEGED")).toBe(false);
  });

  it("bridges a spatial activation into a 2D visibility action and supports durable playback", () => {
    const store = new WorkspaceStore({ clock: () => 500 });
    store.apply(workspaceBatch(store, "setup", [{
      op: "create_component",
      op_id: "stage",
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
      op_id: "character",
      id: "CHARACTER",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      props: { assetId: "humanoid_adult_neutral_01", entityKind: "character" },
    }, {
      op: "create_component",
      op_id: "panel",
      id: "PANEL",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: { space: "viewport", anchor: "right", offset: { x: 20, y: 0 } },
      visibility: "hidden",
    }, connect("CONN_SPATIAL_PANEL", "CHARACTER", "activated", "PANEL", "show") ]));

    const activation = store.applyDetailed(workspaceBatch(store, "activate", [{
      op: "invoke_component_action",
      op_id: "activate",
      id: "CHARACTER",
      action: "activate",
      input: {},
    }]));
    expect(store.getState().components.get("PANEL")?.visibility).toBe("visible");
    expect(activation.events.map((event) => [event.event, event.source])).toEqual([
      ["activated", "user"],
      ["visibility_changed", "binding"],
    ]);

    store.apply(workspaceBatch(store, "play", [{
      op: "invoke_component_action",
      op_id: "play",
      id: "CHARACTER",
      action: "play_animation",
      input: { clip: "run", loop: true, speed: 1.5 },
    }]));
    expect(store.getState().components.get("CHARACTER")?.durableState.playback).toEqual({
      clip: "run", playing: true, loop: true, speed: 1.5, generation: 1,
    });
    store.apply(workspaceBatch(store, "stop", [{
      op: "invoke_component_action",
      op_id: "stop",
      id: "CHARACTER",
      action: "stop_animation",
      input: {},
    }]));
    expect(store.getState().components.get("CHARACTER")?.durableState.playback).toMatchObject({
      clip: "run", playing: false, generation: 2,
    });
  });

  it("enforces catalog asset identity, kind, and supported animation clips", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "stage", [{
      op: "create_component",
      op_id: "stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]));
    const spatialCreate = (assetId: string, entityKind: "character" | "prop") => ({
      op: "create_component" as const,
      op_id: "spatial",
      id: "SPATIAL",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: {
        space: "world3d" as const,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      props: { assetId, entityKind },
    });
    expect(() => store.apply(workspaceBatch(store, "unknown", [
      spatialCreate("not_in_catalog", "prop"),
    ]))).toThrow(/Unknown spatial assetId/);
    expect(() => store.apply(workspaceBatch(store, "wrong_kind", [
      spatialCreate("table_wood_simple_01", "character"),
    ]))).toThrow(/has kind prop/);

    store.apply(workspaceBatch(store, "valid", [
      spatialCreate("humanoid_adult_neutral_01", "character"),
    ]));
    expect(() => store.apply(workspaceBatch(store, "bad_update", [{
      op: "update_component",
      op_id: "bad_update",
      id: "SPATIAL",
      patch: { props: { assetId: "table_wood_simple_01" } },
    }]))).toThrow(/has kind prop/);
    expect(store.getState().components.get("SPATIAL")?.props.assetId)
      .toBe("humanoid_adult_neutral_01");

    store.apply(workspaceBatch(store, "prop", [{
      op: "update_component",
      op_id: "prop",
      id: "SPATIAL",
      patch: { props: { assetId: "table_wood_simple_01", entityKind: "prop" } },
    }]));
    expect(() => store.apply(workspaceBatch(store, "unsupported_clip", [{
      op: "invoke_component_action",
      op_id: "run_table",
      id: "SPATIAL",
      action: "play_animation",
      input: { clip: "run" },
    }]))).toThrow(/does not support animation run/);
  });
});
