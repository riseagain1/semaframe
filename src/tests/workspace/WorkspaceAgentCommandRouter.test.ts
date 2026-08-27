import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceAgentCommandRouter,
  type WorkspaceAgentCommandController,
} from "../../workspace/agents/WorkspaceAgentCommandRouter";

describe("WorkspaceAgentCommandRouter", () => {
  it("dispatches only advertised Workspace tools", async () => {
    const dispatch = vi.fn<WorkspaceAgentCommandController["dispatch"]>()
      .mockResolvedValue({ ok: true, data: { revision: 7 } });
    const router = createWorkspaceAgentCommandRouter({ dispatch });

    expect(router.handles("inspect_workspace")).toBe(true);
    expect(router.handles("run_arbitrary_code")).toBe(false);
    await expect(router.handle({
      id: "command-1",
      name: "inspect_workspace",
      input: { workspace_id: "workspace-1" },
    })).resolves.toEqual({ ok: true, data: { revision: 7 } });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("inspect_workspace", { workspace_id: "workspace-1" });

    await expect(router.handle({
      id: "command-2",
      name: "run_arbitrary_code",
      input: {},
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unsupported_workspace_tool",
        retryable: false,
      },
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
