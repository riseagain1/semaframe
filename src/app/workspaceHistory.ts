import type { WorkspaceCommandRecord } from "../workspace/protocol";
import { WorkspaceStore } from "../workspace/state";
import type { WorkspaceHistoryEntry } from "./uiTypes";

export function commandHistoryText(command: WorkspaceCommandRecord): string {
  const operations = command.resolvedOperations;
  if (operations.length !== 1) return `Applied ${operations.length} Workspace changes`;
  const operation = operations[0]!;
  switch (operation.op) {
    case "create_component": return `Created ${operation.id}`;
    case "update_component": return `Updated ${operation.id}`;
    case "upgrade_component_manifest": return `Upgraded ${operation.id}`;
    case "place_component": return `Moved ${operation.id}`;
    case "resize_component": return `Resized ${operation.id}`;
    case "set_component_visual_effects": return `Updated effects for ${operation.id}`;
    case "attach_component": return `Attached ${operation.child_id}`;
    case "detach_component": return `Detached ${operation.child_id}`;
    case "delete_component": return `Deleted ${operation.id}`;
    case "invoke_component_action": return `Invoked ${operation.action} on ${operation.id}`;
    case "upsert_resource": return `Updated data source ${operation.resource.id}`;
    case "delete_resource": return `Deleted data source ${operation.resource_id}`;
    case "bind_resource": return `Bound data source ${operation.binding.resourceId}`;
    case "unbind_resource": return `Removed binding ${operation.binding_id}`;
    case "connect_event": return `Connected event ${operation.connection.id}`;
    case "disconnect_event": return `Disconnected event ${operation.connection_id}`;
    case "present_view": return `Presented view ${operation.view.id}`;
    case "define_component_recipe": return `Defined component recipe ${operation.recipe.typeId}`;
    case "clear_workspace": return "Cleared the Workspace";
  }
}

/** Rebuild the visible project record from the persisted active command branch. */
export function historyEntriesForStore(store: WorkspaceStore): WorkspaceHistoryEntry[] {
  return store.getCommandHistory()
    .filter((command) => command.actor !== "system")
    .map((command) => {
      const text = commandHistoryText(command);
      return {
        id: command.requestId,
        inputRevision: command.resultingWorkspaceRevision,
        text,
        status: "committed" as const,
        source: command.actor === "agent" ? "agent" as const : "manual" as const,
        summary: text,
        traceId: command.requestId,
      };
    });
}
