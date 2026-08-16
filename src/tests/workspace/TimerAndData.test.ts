import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { projectTimer } from "../../workspace/runtime";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

describe("timer domain and data resources", () => {
  it("projects running time without per-tick commits and records effective action time", () => {
    const store = new WorkspaceStore({ clock: () => 1_000 });
    // The 3D basis and target must exist before their dependents in an ordered transaction.
    store.apply(workspaceBatch(store, "desk", [{
      op: "create_component", op_id: "stage", id: "CMP_000003",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: { space: "world3d", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    }, {
      op: "create_component", op_id: "desk", id: "CMP_000002",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: { space: "world3d", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      props: { assetId: "table_wood_simple_01", entityKind: "prop", appearance: {}, state: {} },
    }, {
      op: "create_component", op_id: "timer", id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "billboard", targetId: "CMP_000002", offset: { x: 0, y: 2, z: 0 } },
      props: { durationMs: 10_000 },
    }]));
    store.apply(workspaceBatch(store, "start", [{
      op: "invoke_component_action", op_id: "start", id: "CMP_000001", action: "start", input: {},
    }]));
    const revision = store.getRevision();
    const timer = store.getState().components.get("CMP_000001")!;
    expect(projectTimer(timer, 4_000).remainingMs).toBe(7_000);
    expect(projectTimer(timer, 12_000)).toMatchObject({ phase: "completed", remainingMs: 0 });
    expect(store.getRevision()).toBe(revision);
    expect(store.getCommandHistory().at(-1)?.resolvedOperations[0]).toMatchObject({ effective_time_ms: 1_000 });
  });

  it("pauses/resumes deterministically and emits a stable finish event at most once", () => {
    let time = 1_000;
    const store = new WorkspaceStore({ clock: () => time });
    store.apply(workspaceBatch(store, "timer", [{
      op: "create_component", op_id: "timer", id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport", anchor: "top_right", offset: { x: 0, y: 0 } },
      props: { durationMs: 2_000 },
    }]));
    store.apply(workspaceBatch(store, "start", [{ op: "invoke_component_action", op_id: "start", id: "CMP_000001", action: "start", input: {} }]));
    time = 2_000;
    store.apply(workspaceBatch(store, "pause", [{ op: "invoke_component_action", op_id: "pause", id: "CMP_000001", action: "pause", input: {} }]));
    expect(store.getState().components.get("CMP_000001")?.durableState).toMatchObject({ phase: "paused", remainingMs: 1_000 });
    time = 5_000;
    store.apply(workspaceBatch(store, "resume", [{ op: "invoke_component_action", op_id: "resume", id: "CMP_000001", action: "resume", input: {} }]));
    time = 7_000;
    const finished = store.applyDetailed(workspaceBatch(store, "finish", [{ op: "invoke_component_action", op_id: "finish", id: "CMP_000001", action: "pause", input: {} }]));
    expect(finished.events.map((event) => event.id)).toEqual(["EVT_00000004"]);
    expect(store.getState().components.get("CMP_000001")?.durableState.phase).toBe("completed");
  });

  it("stores secret references but rejects credential-like values in resource data", () => {
    const store = new WorkspaceStore();
    const resource = {
      id: "RES_weather", label: "Weather", connectorType: "http-json", connectorVersion: "1",
      outputSchema: { type: "object" }, config: { city: "London" }, secretRef: "vault:weather",
      policy: { mode: "manual" as const, offline: "keep_last_good" as const }, status: "unconfigured" as const,
    };
    store.apply(workspaceBatch(store, "resource", [{ op: "upsert_resource", op_id: "resource", resource }]));
    expect(store.getState().resources.get("RES_weather")?.secretRef).toBe("vault:weather");
    expect(() => store.apply(workspaceBatch(store, "leak", [{
      op: "upsert_resource", op_id: "leak",
      resource: { ...resource, id: "RES_leak", config: { api_key: "should-not-persist" } },
    }]))).toThrow(/Embedded credential-like field/);
    expect(store.getRevision()).toBe(1);
  });
});
