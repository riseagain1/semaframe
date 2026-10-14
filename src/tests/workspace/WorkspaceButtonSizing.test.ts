import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMPONENT_MANIFESTS,
  ComponentRegistry,
  DEFAULT_COMPONENT_REGISTRY,
} from "../../workspace/components";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

describe("button authoring sizes and exact saved contracts", () => {
  it("reserves a 44 px target inside the host border for every new button placement", () => {
    const manifest = DEFAULT_COMPONENT_REGISTRY.require("button");
    expect(manifest.version).toBe("1.3.0");
    for (const space of manifest.allowedPlacements) {
      expect(manifest.resizePolicy[space]).toMatchObject({
        kind: "box2d",
        defaultSize: { width: 160, height: 48 },
        minSize: { width: 80, height: 46 },
      });
    }
    expect(DEFAULT_COMPONENT_REGISTRY.ref("button", "1.2.0")).toEqual({
      typeId: "button", version: "1.2.0", digest: "fnv1a32:4f1d976b",
    });
    expect(DEFAULT_COMPONENT_REGISTRY.require("button", "1.2.0").resizePolicy.viewport)
      .toMatchObject({ minSize: { width: 80, height: 32 } });
  });

  it("materializes the fitted default and rejects too-small creation and resize without mutation", () => {
    const store = new WorkspaceStore();
    const create = {
      op: "create_component" as const,
      op_id: "create_button",
      id: "BUTTON",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("button"),
      placement: { space: "viewport" as const, anchor: "center" as const, offset: { x: 0, y: 0 } },
    };
    expect(() => store.apply(workspaceBatch(store, "too_small", [{
      ...create, placement: { ...create.placement, size: { width: 160, height: 40 } },
    }]))).toThrow();
    expect(store.getRevision()).toBe(0);
    store.apply(workspaceBatch(store, "default", [create]));
    expect(store.getState().components.get("BUTTON")?.placement.size).toEqual({ width: 160, height: 48 });
    const before = store.getState();
    expect(() => store.apply(workspaceBatch(store, "resize_too_small", [{
      op: "resize_component", op_id: "resize_too_small", id: "BUTTON",
      resize: { kind: "box2d", size: { width: 80, height: 45 } },
    }]))).toThrow();
    expect(store.getState()).toEqual(before);
    store.apply(workspaceBatch(store, "resize_minimum", [{
      op: "resize_component", op_id: "resize_minimum", id: "BUTTON",
      resize: { kind: "box2d", size: { width: 80, height: 46 } },
    }]));
    expect(store.getState().components.get("BUTTON")?.placement.size).toEqual({ width: 80, height: 46 });
    store.undo();
    expect(store.getState().components.get("BUTTON")?.placement.size).toEqual({ width: 160, height: 48 });
    store.redo();
    expect(store.getState().components.get("BUTTON")?.placement.size).toEqual({ width: 80, height: 46 });
  });

  it.each([32, 40])("reopens, edits, presses and replays an old %i px button without changing its pinned size/ref", (height) => {
    const oldRegistry = new ComponentRegistry(BUILTIN_COMPONENT_MANIFESTS.filter((manifest) => !(
      manifest.typeId === "button" && manifest.version === "1.3.0"
    )));
    const oldStore = new WorkspaceStore({ registry: oldRegistry, clock: () => 1_000 });
    const oldRef = oldRegistry.ref("button");
    oldStore.apply(workspaceBatch(oldStore, "legacy_create", [{
      op: "create_component", op_id: "legacy_create", id: "BUTTON",
      component_type: oldRef,
      props: { label: "Pull chair out" },
      placement: {
        space: "viewport", anchor: "top_left", offset: { x: 20, y: 80 }, size: { width: 160, height },
      },
    }]));
    oldStore.apply(workspaceBatch(oldStore, "legacy_press", [{
      op: "invoke_component_action", op_id: "legacy_press", id: "BUTTON", action: "press", input: {},
    }]));
    const oldSerializer = new WorkspaceProjectSerializer(oldRegistry);
    const saved = oldSerializer.serialize(oldSerializer.fromStore("legacy-small-button", oldStore));
    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(saved));
    expect(reopened.getState().components.get("BUTTON")).toMatchObject({
      type: oldRef, placement: { size: { width: 160, height } }, durableState: { pressCount: 1 },
    });
    reopened.undo();
    expect(reopened.getState().components.get("BUTTON")?.durableState.pressCount).toBe(0);
    reopened.redo();
    expect(reopened.getState().components.get("BUTTON")?.durableState.pressCount).toBe(1);
    reopened.apply(workspaceBatch(reopened, "legacy_relabel", [{
      op: "update_component", op_id: "legacy_relabel", id: "BUTTON", patch: { props: { label: "Move chair" } },
    }]));
    const roundTrip = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("legacy-small-button", reopened),
    )));
    expect(roundTrip.getState().components.get("BUTTON")).toEqual(reopened.getState().components.get("BUTTON"));
    expect(roundTrip.getState().components.get("BUTTON")?.type).toEqual(oldRef);
  });
});
