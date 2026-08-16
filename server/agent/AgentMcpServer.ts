import { McpServer } from "@modelcontextprotocol/server";
import type { WorkspaceAgentToolName } from "../../src/workspace/agents";
import {
  WORKSPACE_MCP_SERVER_INFO,
  registerWorkspaceTools,
  type WorkspaceMcpBackendResult,
  type WorkspaceMcpClientContext,
} from "../workspace/WorkspaceMcpTools";
import type { AgentCommandName } from "./contracts";

export const AGENT_MCP_SERVER_INFO = WORKSPACE_MCP_SERVER_INFO;

export const AGENT_REST_PATHS = Object.freeze({
  get_workspace_instructions: "/v1/workspace/instructions",
  inspect_workspace: "/v1/workspace/inspect",
  inspect_workspace_component: "/v1/workspace/components/inspect",
  inspect_workspace_space: "/v1/workspace/space/inspect",
  query_spatial_placement: "/v1/workspace/space/query",
  inspect_workspace_physics: "/v1/workspace/physics/inspect",
  query_stable_placement: "/v1/workspace/physics/placement/query",
  simulate_workspace_physics: "/v1/workspace/physics/simulate",
  begin_workspace_update: "/v1/workspace/updates/begin",
  submit_workspace_batch: "/v1/workspace/updates/submit",
  undo_workspace_batch: "/v1/workspace/undo",
  redo_workspace_batch: "/v1/workspace/redo",
  read_workspace_events: "/v1/workspace/events",
} as const satisfies Record<AgentCommandName, string>);

export type AgentMcpBackendResult = WorkspaceMcpBackendResult;
export type AgentMcpClientContext = WorkspaceMcpClientContext;

export type AgentMcpBackend = Readonly<{
  dispatch(
    name: AgentCommandName,
    input: unknown,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
}>;

export type CreateAgentMcpServerOptions = Readonly<{
  protocolEra?: "legacy" | "modern";
}>;

/**
 * One transport-neutral Workspace MCP definition shared by the public HTTP
 * offer endpoint and the stdio adapter. Authorization stays in the gateway;
 * MCP protocol-era negotiation is independent from the retired Scene API.
 */
export function createAgentMcpServer(
  backend: AgentMcpBackend,
  options: CreateAgentMcpServerOptions = {},
): McpServer {
  const protocolEra = options.protocolEra ?? "legacy";
  const server = new McpServer(AGENT_MCP_SERVER_INFO, {
    instructions: "SemaFrame is a universal 2D/3D component workspace. Call get_workspace_instructions first and set instruction_digest in every later call to the returned data.guide_digest value. Before spatial work, inspect Universal Space Data and use collision plus physics placement preflights; inspect_workspace_physics and simulate_workspace_physics expose deterministic support, center-of-mass, constraints, and short settle proposals without mutating the Workspace. To create a component: inspect_workspace, begin_workspace_update, copy its exact envelope and one reserved component ID, copy an exact typeId/version/digest from its capability manifest, then submit one schema-valid batch. A remote HTTP connection requires explicit approval in the open app; the URL itself grants no authority.",
  });

  registerWorkspaceTools(server, {
    dispatch: (name: WorkspaceAgentToolName, input, client) => backend.dispatch(name, input, client),
  }, {
    protocolEra,
    registerGuideResource: true,
  });

  return server;
}
