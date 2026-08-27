import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceProjectError, WorkspaceProjectSerializer, workspaceStateDigest } from "../../workspace/persistence";
import {
  MAX_WORKSPACE_COMPONENTS,
  MAX_WORKSPACE_PROJECT_BYTES,
  MAX_WORKSPACE_UNDO_ENTRIES,
  WorkspaceStore,
  WorkspaceStoreError,
} from "../../workspace/state";
import { workspaceBatch } from "./helpers";

function capacityPanelPlacement(index: number) {
  const columns = 50;
  return {
    space: "viewport" as const,
    anchor: "top_left" as const,
    offset: {
      x: (index % columns) * 340,
      y: Math.floor(index / columns) * 240,
    },
  };
}

describe("Workspace application capacity", () => {
  it("folds old undo snapshots into a deterministic checkpoint", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create", [{
      op: "create_component",
      op_id: "create",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    for (let index = 0; index < MAX_WORKSPACE_UNDO_ENTRIES; index += 1) {
      store.apply(workspaceBatch(store, `update_${index}`, [{
        op: "update_component",
        op_id: `update_${index}`,
        id: "CMP_000001",
        patch: { label: `Panel ${index}` },
      }]));
    }

    expect(store.getCommandHistory()).toHaveLength(MAX_WORKSPACE_UNDO_ENTRIES);
    expect(store.getCheckpointState().revision).toBe(1);
    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("bounded_history", store),
    )));
    expect(workspaceStateDigest(reopened.getState() as never)).toBe(workspaceStateDigest(store.getState() as never));
    expect(reopened.getCommandHistory()).toHaveLength(MAX_WORKSPACE_UNDO_ENTRIES);

    for (let index = 0; index < MAX_WORKSPACE_UNDO_ENTRIES; index += 1) {
      expect(reopened.undoUserCommand()).not.toBeNull();
    }
    expect(reopened.undoUserCommand()).toBeNull();
    expect(reopened.getState().revision).toBe(1);
  }, 20_000);

  it("rejects oversized state collections before per-record validation", () => {
    const baseline = new WorkspaceStore().getState();
    const resources = new Map(baseline.resources);
    for (let index = 0; index <= 1_000; index += 1) {
      resources.set(`RES_${index}`, {} as never);
    }
    const oversized = { ...baseline, resources };
    expect(() => new WorkspaceStore({ initialState: oversized as never }))
      .toThrowError(expect.objectContaining<Partial<WorkspaceStoreError>>({ code: "workspace_capacity_exceeded" }));
  });

  it("rejects a normal commit beyond the component cap atomically", () => {
    const seed = new WorkspaceStore();
    seed.apply(workspaceBatch(seed, "seed", [{
      op: "create_component",
      op_id: "seed",
      id: "CMP_SEED",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    const initial = seed.getState();
    const sample = initial.components.get("CMP_SEED")!;
    const components = new Map<string, typeof sample>();
    for (let index = 0; index < MAX_WORKSPACE_COMPONENTS; index += 1) {
      const id = `CMP_LIMIT_${index}`;
      components.set(id, {
        ...structuredClone(sample),
        id,
        label: id,
        placement: capacityPanelPlacement(index),
      });
    }
    const store = new WorkspaceStore({ initialState: { ...initial, components } });
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "overflow", [{
      op: "create_component",
      op_id: "overflow",
      id: "CMP_OVERFLOW",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: capacityPanelPlacement(MAX_WORKSPACE_COMPONENTS),
    }]))).toThrowError(expect.objectContaining<Partial<WorkspaceStoreError>>({ code: "workspace_capacity_exceeded" }));
    expect(store.getRevision()).toBe(revision);
    expect(store.getState().components.size).toBe(MAX_WORKSPACE_COMPONENTS);
  });

  it("rejects project text before parsing when it exceeds the byte budget", () => {
    const serializer = new WorkspaceProjectSerializer();
    expect(() => serializer.deserialize(" ".repeat(MAX_WORKSPACE_PROJECT_BYTES + 1)))
      .toThrowError(expect.objectContaining<Partial<WorkspaceProjectError>>({ code: "project_too_large" }));
  });
});
