import { describe, expect, it } from "vitest";
import { historyEntriesForStore } from "../../app/workspaceHistory";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

describe("visible Workspace history", () => {
  it("rebuilds the active user and Agent record after save/reopen", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "user_create", [{
      op: "create_component",
      op_id: "create",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    store.apply(workspaceBatch(store, "agent_update", [{
      op: "update_component",
      op_id: "update",
      id: "CMP_000001",
      patch: { label: "Agent panel" },
    }]), { actor: "agent", permissions: ["*"] });

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("history_project", store),
    )));
    expect(historyEntriesForStore(reopened)).toEqual([
      expect.objectContaining({ id: "user_create", source: "manual", status: "committed", text: "Created CMP_000001" }),
      expect.objectContaining({ id: "agent_update", source: "agent", status: "committed", text: "Updated CMP_000001" }),
    ]);
  });
});
