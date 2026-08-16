import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENT_REGISTRY,
  type ComponentInstance,
  type JSONObject,
} from "../../workspace/components";
import {
  WORKSPACE_PROTOCOL_VERSION,
  type WorkspaceCommandBatch,
  type WorkspaceOperation,
} from "../../workspace/protocol";
import { createInitialWorkspace, WorkspaceStore } from "../../workspace/state";
import {
  planWorkspaceTimerSignals,
  workspaceAnimationCompletionAction,
} from "../../app/workspaceHostSignals";

describe("Workspace host signals", () => {
  it("plans the first due timer deterministically and schedules the next future one", () => {
    const state = createInitialWorkspace("host-signals", DEFAULT_COMPONENT_REGISTRY);
    state.components.set("TIMER_B", timer("TIMER_B", 900));
    state.components.set("TIMER_A", timer("TIMER_A", 800));
    state.components.set("TIMER_FUTURE", timer("TIMER_FUTURE", 1_500));
    state.components.set("TIMER_LOCKED", timer("TIMER_LOCKED", 700, true));

    expect(planWorkspaceTimerSignals(state, supportsCurrentAction, 1_000)).toEqual({
      due: [
        { componentId: "TIMER_A", action: "complete_if_due", input: {} },
      ],
      nextDeadlineAtMs: 1_500,
    });
  });

  it("never exceeds one atomic timer signal when more than the protocol limit are due", () => {
    const state = createInitialWorkspace("host-signals-many", DEFAULT_COMPONENT_REGISTRY);
    for (let index = 0; index < 130; index += 1) {
      const id = `TIMER_${String(index).padStart(3, "0")}`;
      state.components.set(id, timer(id, 900));
    }

    expect(planWorkspaceTimerSignals(state, supportsCurrentAction, 1_000).due).toEqual([
      { componentId: "TIMER_000", action: "complete_if_due", input: {} },
    ]);
  });

  it("accepts only a current, non-looping renderer animation completion", () => {
    const state = createInitialWorkspace("host-signals", DEFAULT_COMPONENT_REGISTRY);
    state.components.set("ACTOR", spatial({
      clip: "run",
      playing: true,
      loop: false,
      speed: 1,
      generation: 3,
    }));

    expect(workspaceAnimationCompletionAction(state, {
      componentId: "ACTOR",
      clip: "run",
      generation: 3,
    }, supportsCurrentAction)).toEqual({
      componentId: "ACTOR",
      action: "complete_animation",
      input: { generation: 3 },
    });
    state.components.get("ACTOR")!.locks.actions = true;
    expect(workspaceAnimationCompletionAction(state, {
      componentId: "ACTOR",
      clip: "run",
      generation: 3,
    }, supportsCurrentAction)).toEqual({
      componentId: "ACTOR",
      action: "complete_animation",
      input: { generation: 3 },
    });
    state.components.get("ACTOR")!.locks.actions = false;
    expect(workspaceAnimationCompletionAction(state, {
      componentId: "ACTOR",
      clip: "walk",
      generation: 3,
    }, supportsCurrentAction)).toBeUndefined();
    expect(workspaceAnimationCompletionAction(state, {
      componentId: "ACTOR",
      clip: "run",
      generation: 2,
    }, supportsCurrentAction)).toBeUndefined();

    state.components.set("ACTOR", spatial({
      clip: "run",
      playing: true,
      loop: true,
      speed: 1,
      generation: 3,
    }));
    expect(workspaceAnimationCompletionAction(state, {
      componentId: "ACTOR",
      clip: "run",
      generation: 3,
    }, supportsCurrentAction)).toBeUndefined();
  });

  it("settles a due timer through the ordinary atomic Store lane", () => {
    let now = 1_000;
    const store = new WorkspaceStore({ registry: DEFAULT_COMPONENT_REGISTRY, clock: () => now });
    const manifest = store.getComponentManifest("timer")!;
    const [id] = store.reserveComponentIds(1);
    store.apply(batch(store, "create_timer", [{
      op: "create_component",
      op_id: "create",
      id: id!,
      component_type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
      props: { durationMs: 20 },
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }, {
      op: "invoke_component_action",
      op_id: "start",
      id: id!,
      action: "start",
      input: {},
    }]));
    now = 1_021;
    const due = planWorkspaceTimerSignals(
      store.getState(),
      (component, action) => Boolean(store.getComponentManifest(
        component.type.typeId,
        component.type.version,
      )?.actions[action]),
      now,
    ).due;
    const result = store.applyDetailed(batch(store, "host_due", due.map((request, index) => ({
      op: "invoke_component_action",
      op_id: `due_${index}`,
      id: request.componentId,
      action: request.action,
      input: request.input ?? {},
    }))));

    expect(store.getState().components.get(id!)?.durableState.phase).toBe("completed");
    expect(result.events).toEqual([expect.objectContaining({ componentId: id, event: "finished" })]);
  });
});

function batch(
  store: WorkspaceStore,
  requestId: string,
  operations: WorkspaceOperation[],
): WorkspaceCommandBatch {
  const state = store.getState();
  return {
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    request_id: requestId,
    workspace_id: state.workspaceId,
    input_revision: state.revision + 1,
    base_workspace_revision: state.revision,
    registry_digest: state.registryDigest,
    mode: "commit",
    operations,
  };
}

function supportsCurrentAction(component: Readonly<ComponentInstance>, action: string): boolean {
  return Boolean(DEFAULT_COMPONENT_REGISTRY.get(component.type.typeId, component.type.version)?.actions[action]);
}

function timer(id: string, deadlineAtMs: number, locked = false): ComponentInstance {
  const manifest = DEFAULT_COMPONENT_REGISTRY.get("timer")!;
  return {
    id,
    type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
    label: id,
    props: { durationMs: 1_000, label: id, format: "clock", showProgress: true },
    durableState: {
      phase: "running",
      durationMs: 1_000,
      remainingMs: 1_000,
      startedAtMs: deadlineAtMs - 1_000,
      deadlineAtMs,
      runGeneration: 1,
    },
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    bindings: [],
    tags: [],
    visibility: "visible",
    locks: { placement: false, resize: false, props: false, deletion: false, actions: locked },
    provenance: { createdRevision: 1, createdBy: "user" },
  };
}

function spatial(playback: JSONObject): ComponentInstance {
  const manifest = DEFAULT_COMPONENT_REGISTRY.get("spatial-entity")!;
  return {
    id: "ACTOR",
    type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
    label: "Actor",
    props: {
      assetId: "builtin.primitive.person",
      entityKind: "person",
      appearance: {},
      state: {},
      castShadow: true,
      receiveShadow: true,
    },
    durableState: { playback },
    placement: {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    bindings: [],
    tags: [],
    visibility: "visible",
    locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
    provenance: { createdRevision: 1, createdBy: "user" },
  };
}
