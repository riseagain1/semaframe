import { DEFAULT_COMPONENT_REGISTRY, type ComponentRegistry } from "../components/ComponentRegistry";
import { WORKSPACE_PROTOCOL_VERSION, WORKSPACE_SCHEMA_VERSION } from "../protocol/workspaceTypes";
import type { WorkspaceState } from "./workspaceState";

export function createInitialWorkspace(
  workspaceId = "workspace_main",
  registry: ComponentRegistry = DEFAULT_COMPONENT_REGISTRY,
): WorkspaceState {
  if (!workspaceId) throw new RangeError("workspaceId must not be empty");
  return {
    workspaceId,
    revision: 0,
    protocolVersion: WORKSPACE_PROTOCOL_VERSION,
    workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
    registryDigest: registry.digest,
    components: new Map(),
    resources: new Map(),
    realityAssets: new Map(),
    connections: new Map(),
    aliases: new Map(),
    sharedViews: new Map(),
    recipes: new Map(),
    modelDefinitions: new Map(),
    history: [],
  };
}
