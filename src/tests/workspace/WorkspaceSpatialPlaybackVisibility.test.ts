import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENT_REGISTRY,
  type ComponentVisibility,
  type JSONObject,
} from "../../workspace/components";
import type { WorkspaceOperation } from "../../workspace/protocol";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

function stage(
  visibility: ComponentVisibility = "visible",
): WorkspaceOperation {
  return {
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
    visibility,
  };
}

function actor(
  id: string,
  visibility: ComponentVisibility = "visible",
  importedPlayingGeneration?: number,
  positionX = 0,
): WorkspaceOperation {
  return {
    op: "create_component",
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
    placement: {
      space: "world3d",
      position: { x: positionX, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    props: { assetId: "humanoid_adult_neutral_01", entityKind: "character" },
    visibility,
    ...(importedPlayingGeneration === undefined ? {} : {
      durable_state: {
        playback: {
          clip: "run",
          playing: true,
          loop: false,
          speed: 1,
          generation: importedPlayingGeneration,
        },
      },
    }),
  };
}

function invoke(
  opId: string,
  id: string,
  action: string,
  input: JSONObject = {},
): WorkspaceOperation {
  return {
    op: "invoke_component_action",
    op_id: opId,
    id,
    action,
    input,
  };
}

function play(opId: string, id: string, loop = false): WorkspaceOperation {
  return invoke(opId, id, "play_animation", { clip: "run", loop, speed: 1 });
}

function updateVisibility(
  opId: string,
  id: string,
  visibility: ComponentVisibility,
): WorkspaceOperation {
  return {
    op: "update_component",
    op_id: opId,
    id,
    patch: { visibility },
  };
}

function connect(
  id: string,
  sourceComponentId: string,
  event: string,
  targetComponentId: string,
  action: string,
  input: JSONObject,
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

function captureError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to be rejected");
}

describe("spatial playback visibility truth", () => {
  it.each(["hidden", "collapsed"] as const)(
    "rejects direct and routed playback when the spatial target is %s without partial effects",
    (visibility) => {
      const store = new WorkspaceStore({ clock: () => 1_000 });
      store.apply(workspaceBatch(store, "setup", [
        stage(),
        actor("ACTOR", visibility),
        {
          op: "create_component",
          op_id: "create_button",
          id: "BUTTON",
          component_type: DEFAULT_COMPONENT_REGISTRY.ref("button"),
          placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
        },
        connect(
          "PRESS_TO_PLAY",
          "BUTTON",
          "pressed",
          "ACTOR",
          "play_animation",
          { clip: "run", loop: false, speed: 1 },
        ),
      ]));
      const beforeRevision = store.getRevision();

      const directError = captureError(() => store.apply(workspaceBatch(store, "direct_play", [
        play("direct_play", "ACTOR"),
      ])));
      expect(directError).toMatchObject({ code: "spatial_animation_not_renderable" });
      expect(store.getRevision()).toBe(beforeRevision);
      expect(store.getState().components.get("ACTOR")?.durableState.playback).toBeUndefined();

      const routedError = captureError(() => store.apply(workspaceBatch(store, "routed_play", [
        invoke("press", "BUTTON", "press"),
      ])));
      expect(routedError).toMatchObject({ code: "spatial_animation_not_renderable" });
      expect(store.getRevision()).toBe(beforeRevision);
      expect(store.getState().components.get("BUTTON")?.durableState).toEqual({
        pressCount: 0,
      });
      expect(store.getEventHistory()).toEqual([]);
    },
  );

  it.each([
    { stageVisibility: "hidden", actorVisibility: "visible", label: "a hidden Stage" },
    { stageVisibility: "visible", actorVisibility: "hidden", label: "a hidden entity" },
    { stageVisibility: "visible", actorVisibility: "collapsed", label: "a collapsed entity" },
  ] as const)(
    "cancels imported playing state when creating beneath $label",
    ({ stageVisibility, actorVisibility }) => {
      const store = new WorkspaceStore({ clock: () => 1_500 });
      store.apply(workspaceBatch(store, "stage", [stage(stageVisibility)]));

      const created = store.applyDetailed(workspaceBatch(store, "create_playing", [
        actor("ACTOR", actorVisibility, 7),
      ]));
      expect(created.state.components.get("ACTOR")?.durableState.playback).toEqual({
        clip: "run",
        playing: false,
        loop: false,
        speed: 1,
        generation: 8,
      });
      expect(created.events.map((event) => [event.componentId, event.event])).toEqual([
        ["ACTOR", "animation_stopped"],
      ]);
      expect(created.command.resolvedOperations).toMatchObject([
        { op: "create_component", id: "ACTOR" },
        { op: "invoke_component_action", id: "ACTOR", action: "stop_animation" },
      ]);
    },
  );

  it("rejects persisted state that claims hidden spatial playback is still active", () => {
    const source = new WorkspaceStore();
    source.apply(workspaceBatch(source, "setup", [stage("hidden"), actor("ACTOR")]));
    const invalidState = source.getState();
    const persistedActor = invalidState.components.get("ACTOR");
    if (!persistedActor) throw new Error("Missing spatial fixture");
    persistedActor.durableState = {
      playback: {
        clip: "enter",
        playing: true,
        loop: false,
        speed: 1,
        generation: 4,
      },
    };

    const error = captureError(() => {
      new WorkspaceStore({ initialState: invalidState });
    });
    expect(error).toMatchObject({ code: "spatial_animation_not_renderable" });
  });

  it.each(["hidden", "collapsed"] as const)(
    "rejects playback beneath a %s Stage without advancing generation",
    (visibility) => {
      const store = new WorkspaceStore();
      store.apply(workspaceBatch(store, "setup", [stage(visibility), actor("ACTOR")]));
      const beforeRevision = store.getRevision();

      const error = captureError(() => store.apply(workspaceBatch(store, "play", [
        play("play", "ACTOR"),
      ])));
      expect(error).toMatchObject({ code: "spatial_animation_not_renderable" });
      expect(store.getRevision()).toBe(beforeRevision);
      expect(store.getState().components.get("ACTOR")?.durableState.playback).toBeUndefined();
      expect(store.getEventHistory()).toEqual([]);
    },
  );

  it("cancels playback and routes animation_stopped when an entity is hidden directly", () => {
    const store = new WorkspaceStore({ clock: () => 2_000 });
    store.apply(workspaceBatch(store, "setup", [
      stage(),
      actor("ACTOR"),
      {
        op: "create_component",
        op_id: "create_checklist",
        id: "CHECKLIST",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("checklist"),
        placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: 0 } },
      },
      connect(
        "STOP_TO_CHECKLIST",
        "ACTOR",
        "animation_stopped",
        "CHECKLIST",
        "add_item",
        { id: "stopped", text: "Animation stopped" },
      ),
    ]));
    store.apply(workspaceBatch(store, "play", [play("play", "ACTOR", true)]));

    const hidden = store.applyDetailed(workspaceBatch(store, "hide_directly", [
      updateVisibility("hide_directly", "ACTOR", "hidden"),
    ]));
    expect(hidden.state.components.get("ACTOR")).toMatchObject({
      visibility: "hidden",
      durableState: {
        playback: { clip: "run", playing: false, loop: true, speed: 1, generation: 2 },
      },
    });
    expect(hidden.events.map((event) => [event.componentId, event.event, event.source])).toEqual([
      ["ACTOR", "animation_stopped", "user"],
      ["CHECKLIST", "changed", "binding"],
    ]);
    expect(hidden.events[1]?.causedBy).toEqual({
      eventId: hidden.events[0]?.id,
      connectionId: "STOP_TO_CHECKLIST",
    });
    expect(hidden.command.resolvedOperations).toMatchObject([
      { op: "update_component", id: "ACTOR" },
      { op: "invoke_component_action", id: "ACTOR", action: "stop_animation" },
      { op: "invoke_component_action", id: "CHECKLIST", action: "add_item" },
    ]);
    expect(hidden.state.components.get("CHECKLIST")?.durableState.items).toEqual([
      { id: "stopped", text: "Animation stopped", completed: false },
    ]);
    expect(new Set(hidden.events.map((event) => event.workspaceRevision))).toEqual(
      new Set([hidden.state.revision]),
    );

    store.undo();
    expect(store.getState().components.get("ACTOR")).toMatchObject({
      visibility: "visible",
      durableState: { playback: { playing: true, generation: 1 } },
    });
    expect(store.getState().components.get("CHECKLIST")?.durableState.items).toEqual([]);
    store.redo();
    expect(store.getState().components.get("ACTOR")).toMatchObject({
      visibility: "hidden",
      durableState: { playback: { playing: false, generation: 2 } },
    });
  });

  it("cancels all active playback deterministically when Stage visibility is lost", () => {
    const store = new WorkspaceStore({ clock: () => 3_000 });
    store.apply(workspaceBatch(store, "setup", [
      stage(),
      actor("Z_ACTOR"),
      actor("A_ACTOR", "visible", undefined, 2),
    ]));
    store.apply(workspaceBatch(store, "play_both", [
      play("play_z", "Z_ACTOR", true),
      play("play_a", "A_ACTOR", false),
    ]));

    const hidden = store.applyDetailed(workspaceBatch(store, "hide_stage", [
      invoke("hide_stage", "STAGE", "hide"),
    ]));
    expect(hidden.state.components.get("STAGE")?.visibility).toBe("hidden");
    expect(hidden.state.components.get("A_ACTOR")?.durableState.playback).toMatchObject({
      playing: false,
      generation: 2,
    });
    expect(hidden.state.components.get("Z_ACTOR")?.durableState.playback).toMatchObject({
      playing: false,
      generation: 2,
    });
    expect(hidden.events.map((event) => [event.componentId, event.event])).toEqual([
      ["STAGE", "visibility_changed"],
      ["A_ACTOR", "animation_stopped"],
      ["Z_ACTOR", "animation_stopped"],
    ]);
    expect(hidden.command.resolvedOperations).toMatchObject([
      { op: "invoke_component_action", id: "STAGE", action: "hide" },
      { op: "invoke_component_action", id: "A_ACTOR", action: "stop_animation" },
      { op: "invoke_component_action", id: "Z_ACTOR", action: "stop_animation" },
    ]);

    const show = store.applyDetailed(workspaceBatch(store, "show_stage", [
      invoke("show_stage", "STAGE", "show"),
    ]));
    expect(show.events.map((event) => event.event)).toEqual(["visibility_changed"]);
    expect(show.state.components.get("A_ACTOR")?.durableState.playback).toMatchObject({
      playing: false,
      generation: 2,
    });

    store.apply(workspaceBatch(store, "play_again", [
      play("play_again", "A_ACTOR"),
    ]));
    const collapsed = store.applyDetailed(workspaceBatch(store, "collapse_stage", [
      updateVisibility("collapse_stage", "STAGE", "collapsed"),
    ]));
    expect(collapsed.events.map((event) => [event.componentId, event.event])).toEqual([
      ["A_ACTOR", "animation_stopped"],
    ]);
    expect(collapsed.state.components.get("A_ACTOR")?.durableState.playback).toMatchObject({
      playing: false,
      generation: 4,
    });
  });

  it("universal hide and toggle_visibility cancel an entity without resuming on show", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "setup", [stage(), actor("ACTOR")]));
    store.apply(workspaceBatch(store, "play_once", [play("play_once", "ACTOR")]));

    const hidden = store.applyDetailed(workspaceBatch(store, "hide", [
      invoke("hide", "ACTOR", "hide"),
    ]));
    expect(hidden.events.map((event) => event.event)).toEqual([
      "visibility_changed",
      "animation_stopped",
    ]);
    expect(hidden.state.components.get("ACTOR")?.durableState.playback).toMatchObject({
      playing: false,
      generation: 2,
    });

    store.apply(workspaceBatch(store, "show", [invoke("show", "ACTOR", "show")]));
    expect(store.getState().components.get("ACTOR")?.durableState.playback).toMatchObject({
      playing: false,
      generation: 2,
    });
    store.apply(workspaceBatch(store, "play_again", [play("play_again", "ACTOR")]));
    const toggled = store.applyDetailed(workspaceBatch(store, "toggle", [
      invoke("toggle", "ACTOR", "toggle_visibility"),
    ]));
    expect(toggled.events.map((event) => event.event)).toEqual([
      "visibility_changed",
      "animation_stopped",
    ]);
    expect(toggled.state.components.get("ACTOR")).toMatchObject({
      visibility: "hidden",
      durableState: { playback: { playing: false, generation: 4 } },
    });
  });
});
