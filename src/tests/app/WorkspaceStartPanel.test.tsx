import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStartPanel } from "../../app/components/workspace/WorkspaceStartPanel";

afterEach(cleanup);

function handlers() {
  return {
    onBuildSpace: vi.fn(),
    onCreateDashboard: vi.fn(),
    onOpenReality: vi.fn(),
    onConnectData: vi.fn(),
    onTryExample: vi.fn(),
    onOpenProject: vi.fn(),
    onDismiss: vi.fn(),
  };
}

describe("WorkspaceStartPanel", () => {
  it("presents goal-first choices and emits each intent exactly once", async () => {
    const user = userEvent.setup();
    const actions = handlers();
    render(<WorkspaceStartPanel agentName="Codex" {...actions} />);

    expect(screen.getByRole("heading", { name: "What would you like to make?" })).toBeVisible();
    expect(screen.getByText(/Ask Codex in your own words/u)).toBeVisible();

    const labels = [
      "Build a 3D space",
      "Create a dashboard",
      "Bring in a real space",
      "Connect live data",
      "Try a working example",
      "Open existing project",
      "Start with an empty Workspace",
    ];
    for (const label of labels) await user.click(screen.getByRole("button", { name: new RegExp(label, "u") }));

    expect(actions.onBuildSpace).toHaveBeenCalledOnce();
    expect(actions.onCreateDashboard).toHaveBeenCalledOnce();
    expect(actions.onOpenReality).toHaveBeenCalledOnce();
    expect(actions.onConnectData).toHaveBeenCalledOnce();
    expect(actions.onTryExample).toHaveBeenCalledOnce();
    expect(actions.onOpenProject).toHaveBeenCalledOnce();
    // The close icon plus the explicit empty-Workspace action share this callback;
    // only the explicit action was used in this flow.
    expect(actions.onDismiss).toHaveBeenCalledOnce();
  });

  it("is non-modal, omits optional actions, and disables every available choice", () => {
    const actions = handlers();
    render(<WorkspaceStartPanel
      disabled
      onBuildSpace={actions.onBuildSpace}
      onCreateDashboard={actions.onCreateDashboard}
      onOpenReality={actions.onOpenReality}
      onConnectData={actions.onConnectData}
      onTryExample={actions.onTryExample}
    />);

    expect(screen.getByRole("region", { name: "What would you like to make?" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open existing project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close Start Center" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(5);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});
