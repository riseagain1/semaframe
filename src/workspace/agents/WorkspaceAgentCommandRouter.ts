import {
  type WorkspaceAgentResult,
  type WorkspaceAgentToolName,
  isWorkspaceAgentToolName,
} from "./contracts";

export type WorkspaceBrowserCommand = Readonly<{
  id: string;
  name: string;
  input: unknown;
}>;

export type WorkspaceAgentCommandController = Readonly<{
  dispatch(name: unknown, input: unknown): Promise<WorkspaceAgentResult<unknown>>;
}>;

/**
 * Browser-side integration seam for the Agent Gateway bridge. The app routes
 * every advertised command through this Workspace-only controller.
 */
export class WorkspaceAgentCommandRouter {
  constructor(private readonly controller: WorkspaceAgentCommandController) {}

  handles(name: unknown): name is WorkspaceAgentToolName {
    return isWorkspaceAgentToolName(name);
  }

  async handle(command: WorkspaceBrowserCommand): Promise<WorkspaceAgentResult<unknown>> {
    if (!this.handles(command.name)) {
      return {
        ok: false,
        error: {
          code: "unsupported_workspace_tool",
          message: `Unsupported Workspace tool: ${command.name}`,
          retryable: false,
        },
      };
    }
    return this.controller.dispatch(command.name, command.input);
  }
}

export function createWorkspaceAgentCommandRouter(
  controller: WorkspaceAgentCommandController,
): WorkspaceAgentCommandRouter {
  return new WorkspaceAgentCommandRouter(controller);
}
