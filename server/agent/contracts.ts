import {
  WORKSPACE_AGENT_GUIDE_VERSION,
  WORKSPACE_AGENT_TOOL_NAMES,
  type WorkspaceAgentToolName,
} from "../../src/workspace/agents/contracts";

export const AGENT_GATEWAY_VERSION = 1 as const;
export const AGENT_INSTRUCTION_VERSION = WORKSPACE_AGENT_GUIDE_VERSION;
export const AGENT_INTERNAL_COMMAND_NAMES = [
  "complete_workspace_reconstruction_asset",
] as const;
export const AGENT_COMMAND_NAMES = [
  ...WORKSPACE_AGENT_TOOL_NAMES,
  ...AGENT_INTERNAL_COMMAND_NAMES,
] as const;
export type AgentInternalCommandName = typeof AGENT_INTERNAL_COMMAND_NAMES[number];
export type AgentCommandName = WorkspaceAgentToolName | AgentInternalCommandName;

export type BrowserAgentCommand = Readonly<{
  id: string;
  name: AgentCommandName;
  input: unknown;
}>;

export type BrowserPollResponse =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "command"; command: BrowserAgentCommand }>;

export type BrowserCommandFailure = Readonly<{
  code: string;
  message: string;
  details?: unknown;
}>;

export type BrowserCommandResult =
  | Readonly<{
      browserConnectionId: string;
      commandId: string;
      ok: true;
      result: unknown;
    }>
  | Readonly<{
      browserConnectionId: string;
      commandId: string;
      ok: false;
      error: BrowserCommandFailure;
    }>;

export function isAgentCommandName(value: unknown): value is AgentCommandName {
  return typeof value === "string" && (AGENT_COMMAND_NAMES as readonly string[]).includes(value);
}

export function isMutationCommand(name: AgentCommandName): boolean {
  return name === "begin_workspace_asset_import" ||
    name === "cancel_workspace_asset_import" ||
    name === "complete_workspace_asset_import" ||
    name === "begin_workspace_photo_reconstruction" ||
    name === "start_workspace_photo_reconstruction" ||
    name === "cancel_workspace_photo_reconstruction" ||
    name === "finalize_workspace_photo_reconstruction" ||
    name === "complete_workspace_reconstruction_asset" ||
    name === "begin_workspace_update" ||
    name === "submit_workspace_batch" ||
    name === "undo_workspace_batch" ||
    name === "redo_workspace_batch";
}
