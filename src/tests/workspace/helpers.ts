import {
  WORKSPACE_PROTOCOL_VERSION,
  type WorkspaceCommandBatch,
  type WorkspaceOperation,
} from "../../workspace/protocol";
import type { WorkspaceStore } from "../../workspace/state";

export function workspaceBatch(
  store: WorkspaceStore,
  requestId: string,
  operations: WorkspaceOperation[],
): WorkspaceCommandBatch {
  return {
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    request_id: requestId,
    workspace_id: store.getState().workspaceId,
    input_revision: store.getRevision(),
    base_workspace_revision: store.getRevision(),
    registry_digest: store.getRegistryDigest(),
    mode: "commit",
    operations,
  };
}
