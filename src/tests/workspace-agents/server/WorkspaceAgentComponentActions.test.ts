import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import type { Box2DResizePolicy, ComponentResizePolicies } from "../../../workspace/components/componentTypes";
import { prepareComponentRecipe, type WorkspaceOperation } from "../../../workspace/protocol";
import {
  WorkspaceAgentController,
  type BeginWorkspaceUpdateData,
  type WorkspaceInstructionsData,
} from "../../../workspace/agents/WorkspaceAgentController";
import type { WorkspaceAgentResult } from "../../../workspace/agents/contracts";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import { WorkspaceStore } from "../../../workspace/state";

describe("external agent component actions", () => {
  it("uses the same controller dispatch exposed by MCP to update a source and request playback", async () => {
    const store = new WorkspaceStore({ clock: () => 12_000 });
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: (inputRevision) => `agent_component_action_${inputRevision}`,
    });
    let token = 0;
    const controller = new WorkspaceAgentController(adapter, {
      randomToken: (prefix) => `${prefix}_${String(++token).padStart(32, "0")}`,
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
    });
    const instructions = unwrap<WorkspaceInstructionsData>(await controller.dispatch(
      "get_workspace_instructions",
      {
        client_id: "jarvis",
        client_name: "JARVIS",
        requested_scopes: [
          "workspace:read", "workspace:write", "component:create",
          "component:update", "component:invoke",
        ],
      },
    ));
    const session = {
      session_token: instructions.session_token,
      instruction_digest: instructions.guide_digest,
    };

    const create = await begin(controller, session, "Create a controllable video", 1);
    const videoId = create.reserved_component_ids[0]!;
    await submit(controller, session, create, [{
      op: "create_component", op_id: "create_video", id: videoId,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("video-player"),
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 480, height: 306 },
      },
    }]);

    const update = await begin(controller, session, "Switch the video source", 1);
    await submit(controller, session, update, [{
      op: "update_component", op_id: "set_video_source", id: videoId,
      patch: { props: {
        sourceUrl: "https://vimeo.com/76979871",
        sourceKind: "vimeo",
        title: "Agent-selected briefing",
      } },
    }]);

    const play = await begin(controller, session, "Play the video", 1);
    await submit(controller, session, play, [{
      op: "invoke_component_action", op_id: "play_video", id: videoId,
      action: "play", input: {},
    }]);
    const seek = await begin(controller, session, "Seek the video", 1);
    await submit(controller, session, seek, [{
      op: "invoke_component_action", op_id: "seek_video", id: videoId,
      action: "seek", input: { timeSeconds: 18 },
    }]);
    const pause = await begin(controller, session, "Pause the video", 1);
    await submit(controller, session, pause, [{
      op: "invoke_component_action", op_id: "pause_video", id: videoId,
      action: "pause", input: {},
    }]);
    const stop = await begin(controller, session, "Stop the video", 1);
    await submit(controller, session, stop, [{
      op: "invoke_component_action", op_id: "stop_video", id: videoId,
      action: "stop", input: {},
    }]);

    expect(store.getState().components.get(videoId)).toMatchObject({
      props: {
        sourceUrl: "https://vimeo.com/76979871",
        sourceKind: "vimeo",
        title: "Agent-selected briefing",
      },
      durableState: {
        desiredPlayback: "stopped",
        lastCommand: "stop",
        requestedTimeSeconds: 0,
        commandGeneration: 4,
      },
      provenance: { createdBy: "agent" },
    });
    expect(store.getEventHistory().map(({ event, source }) => ({ event, source }))).toEqual([
      { event: "play_requested", source: "agent" },
      { event: "seek_requested", source: "agent" },
      { event: "pause_requested", source: "agent" },
      { event: "stop_requested", source: "agent" },
    ]);
  });

  it("routes every timer/checklist action and declarative fill through controller transactions", async () => {
    const store = new WorkspaceStore({ clock: () => 20_000 });
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: (inputRevision) => `agent_stateful_action_${inputRevision}`,
    });
    let token = 0;
    const controller = new WorkspaceAgentController(adapter, {
      randomToken: (prefix) => `${prefix}_${String(++token).padStart(32, "0")}`,
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
    });
    const instructions = unwrap<WorkspaceInstructionsData>(await controller.dispatch(
      "get_workspace_instructions",
      {
        client_id: "jarvis",
        requested_scopes: [
          "workspace:read", "workspace:write", "component:create",
          "component:invoke", "component:recipe_define",
        ],
      },
    ));
    const session = {
      session_token: instructions.session_token,
      instruction_digest: instructions.guide_digest,
    };
    const recipe = interactiveRecipe();

    const definition = await begin(controller, session, "Define an editable status control", 1);
    await submit(controller, session, definition, [{
      op: "define_component_recipe",
      op_id: "define_editable_status",
      recipe: { ...recipe, digest: "auto" },
    }]);

    const creation = await begin(controller, session, "Create stateful controls", 3);
    const [timerId, checklistId, recipeId] = creation.reserved_component_ids;
    await submit(controller, session, creation, [{
      op: "create_component", op_id: "create_timer", id: timerId!,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport", anchor: "top_left", offset: { x: 16, y: 16 } },
    }, {
      op: "create_component", op_id: "create_checklist", id: checklistId!,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("checklist"),
      placement: { space: "viewport", anchor: "top_right", offset: { x: -16, y: 16 } },
    }, {
      op: "create_component", op_id: "create_editable_status", id: recipeId!,
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: { space: "viewport", anchor: "bottom_left", offset: { x: 16, y: -16 } },
    }]);

    const actions = await begin(controller, session, "Exercise all stateful controls", 1);
    await submit(controller, session, actions, [{
      op: "invoke_component_action", op_id: "timer_start", id: timerId!,
      action: "start", input: { durationMs: 10_000 },
    }, {
      op: "invoke_component_action", op_id: "timer_add_time", id: timerId!,
      action: "add_time", input: { amountMs: 5_000 },
    }, {
      op: "invoke_component_action", op_id: "timer_pause", id: timerId!,
      action: "pause", input: {},
    }, {
      op: "invoke_component_action", op_id: "timer_resume", id: timerId!,
      action: "resume", input: {},
    }, {
      op: "invoke_component_action", op_id: "timer_reset", id: timerId!,
      action: "reset", input: { durationMs: 4_000 },
    }, {
      op: "invoke_component_action", op_id: "checklist_add_a", id: checklistId!,
      action: "add_item", input: { id: "a", text: "First" },
    }, {
      op: "invoke_component_action", op_id: "checklist_toggle_a", id: checklistId!,
      action: "toggle_item", input: { id: "a" },
    }, {
      op: "invoke_component_action", op_id: "checklist_add_b", id: checklistId!,
      action: "add_item", input: { id: "b", text: "Second" },
    }, {
      op: "invoke_component_action", op_id: "checklist_clear", id: checklistId!,
      action: "clear_completed", input: {},
    }, {
      op: "invoke_component_action", op_id: "checklist_remove_b", id: checklistId!,
      action: "remove_item", input: { id: "b" },
    }, {
      op: "invoke_component_action", op_id: "fill_status", id: recipeId!,
      action: "set_value", input: { key: "status", value: "Ready" },
    }, {
      op: "invoke_component_action", op_id: "press_acknowledge", id: recipeId!,
      action: "acknowledge", input: { source: "agent" },
    }]);

    expect(store.getState().components.get(timerId!)?.durableState).toMatchObject({
      phase: "idle", durationMs: 4_000, remainingMs: 4_000, runGeneration: 2,
    });
    expect(store.getState().components.get(checklistId!)?.durableState).toEqual({ items: [] });
    expect(store.getState().components.get(recipeId!)?.durableState).toEqual({ status: "Ready" });
    expect(store.getEventHistory().map(({ event }) => event)).toEqual([
      "started", "paused", "resumed", "reset",
      "changed", "changed", "changed", "changed", "changed",
      "set_value", "acknowledge",
    ]);
    expect(store.getEventHistory().every(({ source }) => source === "agent")).toBe(true);
  }, 20_000);
});

function interactiveRecipe() {
  const emptyObject = { type: "object", additionalProperties: false } as const;
  const setValueInput = {
    type: "object",
    additionalProperties: false,
    required: ["key", "value"],
    properties: {
      key: { const: "status" },
      value: { type: "string", maxLength: 1_000 },
    },
  } as const;
  const acknowledgeInput = {
    type: "object",
    additionalProperties: false,
    required: ["source"],
    properties: { source: { const: "agent" } },
  } as const;
  return prepareComponentRecipe({
    typeId: "recipe.agent-editable-status",
    version: "1.0.0",
    displayName: "Agent editable status",
    allowedPlacements: ["canvas2d", "surface", "billboard", "viewport"],
    resizePolicy: uiResizePolicy(),
    propsSchema: emptyObject,
    durableStateSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", maxLength: 1_000 } },
    },
    defaultProps: {},
    defaultDurableState: { status: "Waiting" },
    writableProps: [],
    actions: {
      set_value: { effectClass: "semantic", inputSchema: setValueInput },
      acknowledge: { effectClass: "semantic", inputSchema: acknowledgeInput },
    },
    events: { set_value: setValueInput, acknowledge: acknowledgeInput },
    root: {
      id: "root",
      primitive: "stack",
      children: [{
        id: "status",
        primitive: "input",
        props: {
          label: "Status", action: "set_value", actionInput: { key: "status" },
          valueKey: "value", value: { $bind: "state.status" },
        },
      }, {
        id: "acknowledge",
        primitive: "button",
        props: { label: "Acknowledge", action: "acknowledge", actionInput: { source: "agent" } },
      }],
    },
  });
}

function uiResizePolicy(): ComponentResizePolicies {
  const box = (): Box2DResizePolicy => ({
    kind: "box2d",
    mode: "free",
    defaultSize: { width: 320, height: 180 },
    minSize: { width: 160, height: 100 },
    maxSize: { width: 1_920, height: 1_080 },
    allowedAxes: ["width", "height"],
    units: "px",
  });
  return { canvas2d: box(), surface: box(), billboard: box(), viewport: box() };
}

type Session = Readonly<{ session_token: string; instruction_digest: string }>;

async function begin(
  controller: WorkspaceAgentController,
  session: Session,
  intent: string,
  requestedIds: number,
): Promise<BeginWorkspaceUpdateData> {
  return unwrap<BeginWorkspaceUpdateData>(await controller.dispatch("begin_workspace_update", {
    ...session,
    intent,
    requested_component_ids: requestedIds,
  }));
}

async function submit(
  controller: WorkspaceAgentController,
  session: Session,
  prepared: BeginWorkspaceUpdateData,
  operations: WorkspaceOperation[],
): Promise<void> {
  unwrap(await controller.dispatch("submit_workspace_batch", {
    ...session,
    transaction_token: prepared.transaction_token,
    batch: { ...prepared.envelope, operations },
  }));
}

function unwrap<T>(result: WorkspaceAgentResult<unknown>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data as T;
}
