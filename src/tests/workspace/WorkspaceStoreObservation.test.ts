import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { MAX_WORKSPACE_UNDO_ENTRIES, WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

describe("Workspace observer and committed result lifecycle", () => {
  it("returns detached commit evidence and emits only while a subscriber is registered", () => {
    const store = new WorkspaceStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.getCommittedResult("create")).toBeNull();
    expect(store.canRedo()).toBe(false);
    store.apply(workspaceBatch(store, "create", [{ op: "create_component", op_id: "create", id: "TIMER",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    const result = store.getCommittedResult("create")!;
    expect(result.deduplicated).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    result.events.splice(0);
    result.command.resolvedOperations.splice(0);
    result.state.components.clear();
    expect(store.getCommittedResult("create")!.command.resolvedOperations).toHaveLength(1);
    expect(store.getState().components.has("TIMER")).toBe(true);
    store.undo();
    expect(store.canRedo()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.redo();
    expect(store.canRedo()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getCommittedResult("create")).toMatchObject({ deduplicated: true });
  });

  it("compacts emitted timer events with their old commands without losing the current timer", () => {
    const store = new WorkspaceStore({ clock: () => 1_000 });
    store.apply(workspaceBatch(store, "timer", [{ op: "create_component", op_id: "timer", id: "TIMER",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    for (let index = 0; index < MAX_WORKSPACE_UNDO_ENTRIES + 2; index += 1) {
      store.apply(workspaceBatch(store, `action_${index}`, [{ op: "invoke_component_action", op_id: "timer_action",
        id: "TIMER", action: index % 2 ? "reset" : "start", input: {},
      }]));
    }
    expect(store.getCommandHistory()).toHaveLength(MAX_WORKSPACE_UNDO_ENTRIES);
    const events = store.getEventHistory();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.workspaceRevision > store.getCheckpointState().revision)).toBe(true);
    expect(store.getCheckpointState().revision).toBe(3);
    expect(store.getState().components.has("TIMER")).toBe(true);
  });
});
