import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { resizeCommitOperations } from "../../workspace/interaction/interactionOperations";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

describe("human resize commit integration", () => {
  it("applies resize then anchored placement as one revision and one undoable history item", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_video", [{
      op: "create_component",
      op_id: "create_video",
      id: "CMP_VIDEO",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("video-player"),
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 480, height: 306 },
      },
    }]));
    const historyBefore = store.getCommandHistory().length;
    const revisionBefore = store.getRevision();
    const operations = resizeCommitOperations({
      componentId: "CMP_VIDEO",
      resize: { kind: "box2d", size: { width: 640, height: 408 } },
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: -80, y: -51 },
        size: { width: 640, height: 408 },
      },
    }, "resize_video", "anchor_video");

    expect(operations.map((operation) => operation.op)).toEqual([
      "resize_component",
      "place_component",
    ]);
    store.apply(workspaceBatch(store, "human_resize_video", operations));

    expect(store.getRevision()).toBe(revisionBefore + 1);
    expect(store.getCommandHistory()).toHaveLength(historyBefore + 1);
    expect(store.getState().components.get("CMP_VIDEO")?.placement).toEqual({
      space: "viewport",
      anchor: "center",
      offset: { x: -80, y: -51 },
      size: { width: 640, height: 408 },
    });

    store.undo();
    expect(store.getState().components.get("CMP_VIDEO")?.placement).toEqual({
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: { width: 480, height: 306 },
    });
    store.redo();
    expect(store.getState().components.get("CMP_VIDEO")?.placement).toEqual({
      space: "viewport",
      anchor: "center",
      offset: { x: -80, y: -51 },
      size: { width: 640, height: 408 },
    });
  });
});
