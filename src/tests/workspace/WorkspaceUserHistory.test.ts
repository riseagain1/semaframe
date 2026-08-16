import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY, deterministicDigest } from "../../workspace/components";
import { WorkspaceProjectSerializer, workspaceStateDigest } from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

function createTimer(store: WorkspaceStore, requestId = "user_create_timer"): void {
  store.apply(workspaceBatch(store, requestId, [{
    op: "create_component",
    op_id: "create_timer",
    id: "CMP_000001",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
    placement: { space: "viewport", anchor: "top_right", offset: { x: 16, y: 16 } },
    props: { durationMs: 60_000, label: "Launch" },
  }]));
}

describe("Workspace user history", () => {
  it("keeps host completions out of user undo and preserves redo across derived settlement", () => {
    let now = 1_000;
    const store = new WorkspaceStore({ clock: () => now });
    const timerRef = DEFAULT_COMPONENT_REGISTRY.ref("timer");
    store.apply(workspaceBatch(store, "user_create_start", [{
      op: "create_component",
      op_id: "create_timer",
      id: "CMP_TIMER",
      component_type: timerRef,
      label: "Initial timer",
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      props: { durationMs: 10, label: "Initial timer" },
    }, {
      op: "invoke_component_action",
      op_id: "start_timer",
      id: "CMP_TIMER",
      action: "start",
      input: {},
    }]));
    store.apply(workspaceBatch(store, "user_rename", [{
      op: "update_component",
      op_id: "rename_timer",
      id: "CMP_TIMER",
      patch: { label: "Renamed timer" },
    }]));
    now = 1_020;
    store.applyDetailed(workspaceBatch(store, "system_complete", [{
      op: "invoke_component_action",
      op_id: "complete_timer",
      id: "CMP_TIMER",
      action: "complete_if_due",
      input: {},
    }]), { actor: "system", permissions: ["*"] });

    expect(store.getState().components.get("CMP_TIMER")?.durableState.phase).toBe("completed");
    expect(store.getCommandHistory().at(-1)?.actor).toBe("system");

    // Undo targets the rename, not the automatic completion. Its dependent
    // host completion is discarded, restoring the preceding running state.
    expect(store.undoUserCommand()).not.toBeNull();
    expect(store.getState().components.get("CMP_TIMER")).toMatchObject({
      label: "Initial timer",
      durableState: { phase: "running" },
    });
    expect(store.canRedoUserCommand()).toBe(true);

    // The host immediately settles the overdue timer again, but that derived
    // commit must not erase the user's pending rename redo.
    store.applyDetailed(workspaceBatch(store, "system_complete_after_undo", [{
      op: "invoke_component_action",
      op_id: "complete_timer_after_undo",
      id: "CMP_TIMER",
      action: "complete_if_due",
      input: {},
    }]), { actor: "system", permissions: ["*"] });
    expect(store.canRedoUserCommand()).toBe(true);
    expect(store.redoUserCommand()).not.toBeNull();
    expect(store.getState().components.get("CMP_TIMER")).toMatchObject({
      label: "Renamed timer",
      durableState: { phase: "completed" },
    });

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("host_completion_history", store),
    )));
    expect(reopened.getCommandHistory()).toEqual(store.getCommandHistory());
    expect(workspaceStateDigest(reopened.getState() as never)).toBe(workspaceStateDigest(store.getState() as never));
  });

  it("preserves an independent host-feed observation across unrelated undo and redo", () => {
    const store = new WorkspaceStore();
    const feed = (price: number, retrievedAt: string) => ({
      id: "RES_feed",
      label: "Quote",
      connectorType: "http.feed",
      connectorVersion: "1.0.0",
      outputSchema: {
        type: "object" as const,
        additionalProperties: false,
        required: ["price"],
        properties: { price: { type: "number" as const } },
      },
      config: { url: "https://feeds.example.org/quote.json", format: "auto" },
      policy: { mode: "manual" as const, offline: "keep_last_good" as const },
      snapshot: {
        data: { price },
        contentHash: deterministicDigest({ price }),
        retrievedAt,
        stale: false,
        provenance: [{
          uri: "https://feeds.example.org/quote.json",
          publisher: "feeds.example.org",
          retrievedAt,
          citation: "https://feeds.example.org/quote.json",
        }],
      },
      status: "ready" as const,
    });

    store.apply(workspaceBatch(store, "create_feed", [{
      op: "upsert_resource",
      op_id: "create_feed",
      resource: feed(1, "2026-08-15T01:00:00.000Z"),
    }]));
    createTimer(store, "unrelated_timer");
    store.applyDetailed(workspaceBatch(store, "observe_feed", [{
      op: "upsert_resource",
      op_id: "observe_feed",
      resource: feed(2, "2026-08-15T01:01:00.000Z"),
    }]), { actor: "system", permissions: ["*"] });

    expect(store.undoUserCommand()).not.toBeNull();
    expect(store.getState().components.has("CMP_000001")).toBe(false);
    expect(store.getState().resources.get("RES_feed")?.snapshot?.data).toEqual({ price: 2 });

    expect(store.redoUserCommand()).not.toBeNull();
    expect(store.getState().components.has("CMP_000001")).toBe(true);
    expect(store.getState().resources.get("RES_feed")?.snapshot?.data).toEqual({ price: 2 });

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("independent_feed_history", store),
    )));
    expect(workspaceStateDigest(reopened.getState() as never)).toBe(
      workspaceStateDigest(store.getState() as never),
    );
  });

  it("discards a host-feed observation when undo removes the feed it depends on", () => {
    const data = { value: 1 };
    const retrievedAt = "2026-08-15T02:00:00.000Z";
    const resource = {
      id: "RES_feed",
      label: "Dependent feed",
      connectorType: "http.feed",
      connectorVersion: "1.0.0",
      outputSchema: {
        type: "object" as const,
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "number" as const } },
      },
      config: { url: "https://feeds.example.org/value.json", format: "json" },
      policy: { mode: "manual" as const, offline: "keep_last_good" as const },
      snapshot: {
        data,
        contentHash: deterministicDigest(data),
        retrievedAt,
        stale: false,
        provenance: [{
          uri: "https://feeds.example.org/value.json",
          publisher: "feeds.example.org",
          retrievedAt,
          citation: "https://feeds.example.org/value.json",
        }],
      },
      status: "ready" as const,
    };
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_feed", [{
      op: "upsert_resource", op_id: "create_feed", resource,
    }]));
    store.applyDetailed(workspaceBatch(store, "refresh_feed", [{
      op: "upsert_resource", op_id: "refresh_feed", resource: structuredClone(resource),
    }]), { actor: "system", permissions: ["*"] });

    expect(store.undoUserCommand()).not.toBeNull();
    expect(store.getState().resources.has(resource.id)).toBe(false);
  });
});
