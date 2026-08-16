import type {
  ComponentId,
  ComponentInstance,
  ComponentRecipe,
} from "../components/componentTypes";
import type {
  WorkspaceConnection,
  WorkspaceResource,
} from "../data/dataTypes";
import type {
  SharedView,
  WorkspaceAppliedBatchSummary,
  WorkspaceProtocolVersion,
  WorkspaceSchemaVersion,
} from "../protocol/workspaceTypes";

export type WorkspaceState = {
  workspaceId: string;
  revision: number;
  protocolVersion: WorkspaceProtocolVersion;
  workspaceSchemaVersion: WorkspaceSchemaVersion;
  registryDigest: string;
  components: Map<ComponentId, ComponentInstance>;
  resources: Map<string, WorkspaceResource>;
  connections: Map<string, WorkspaceConnection>;
  aliases: Map<string, ComponentId>;
  sharedViews: Map<string, SharedView>;
  recipes: Map<string, ComponentRecipe>;
  history: WorkspaceAppliedBatchSummary[];
};
