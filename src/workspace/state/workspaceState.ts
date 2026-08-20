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
import type { ModelDefinition } from "../modeling/modelDefinitions";
import type { RealityAssetDescriptor } from "../assets";

export type WorkspaceState = {
  workspaceId: string;
  revision: number;
  protocolVersion: WorkspaceProtocolVersion;
  workspaceSchemaVersion: WorkspaceSchemaVersion;
  registryDigest: string;
  components: Map<ComponentId, ComponentInstance>;
  resources: Map<string, WorkspaceResource>;
  /** Content-addressed, visual-only Reality Asset metadata. Never contains bytes or paths. */
  realityAssets: Map<string, RealityAssetDescriptor>;
  connections: Map<string, WorkspaceConnection>;
  aliases: Map<string, ComponentId>;
  sharedViews: Map<string, SharedView>;
  recipes: Map<string, ComponentRecipe>;
  modelDefinitions: Map<string, ModelDefinition>;
  history: WorkspaceAppliedBatchSummary[];
};
