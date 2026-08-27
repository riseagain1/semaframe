import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceValidationPanel } from "../../app/components/workspace/WorkspaceValidationPanel";
import type { WorkspaceValidationView } from "../../app/validation/buildWorkspaceValidationView";

afterEach(cleanup);

const view = (overrides: Partial<WorkspaceValidationView> = {}): WorkspaceValidationView => ({
  workspaceId: "workspace-test",
  revision: 7,
  bounded: true,
  counts: { blocking: 1, warning: 1, info: 0, total: 2 },
  issues: [{
    id: "spatial:collision:A:B",
    domain: "spatial",
    severity: "blocking",
    code: "collision",
    title: "Objects intersect",
    detail: "A intersects B.",
    target: { surface: "inspector", componentId: "A", section: "collision" },
  }, {
    id: "data:source-stale:prices",
    domain: "data",
    severity: "warning",
    code: "source_stale",
    title: "Prices may be stale",
    detail: "The source is using its last snapshot.",
    target: { surface: "sources", resourceId: "prices", section: "source" },
  }],
  coverage: ["Current collision checks"],
  limitations: ["Not engineering certification"],
  ...overrides,
});

describe("WorkspaceValidationPanel", () => {
  it("shows current counts and delegates an exact navigation target", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<WorkspaceValidationPanel view={view()} onNavigate={onNavigate} />);

    expect(screen.getByRole("complementary", { name: "Workspace checks" })).toBeVisible();
    expect(screen.getByText("Revision 7")).toBeVisible();
    expect(screen.getByText(/^Bounded checks .*not engineering certification\.$/iu)).toBeVisible();
    expect(screen.getAllByRole("definition").map((node) => node.textContent)).toEqual(["1", "1", "0"]);

    await user.click(screen.getByRole("button", { name: "Review Objects intersect" }));
    expect(onNavigate).toHaveBeenCalledWith({
      surface: "inspector",
      componentId: "A",
      section: "collision",
    });
  });

  it("disables navigation without hiding the issue and exposes limits on demand", async () => {
    const user = userEvent.setup();
    render(<WorkspaceValidationPanel view={view()} disabled onNavigate={vi.fn()} />);

    expect(screen.getByText("Objects intersect")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review Objects intersect" })).toBeDisabled();
    await user.click(screen.getByText("What is checked—and what is not"));
    expect(screen.getByText("Current collision checks")).toBeVisible();
    expect(screen.getByText("Not engineering certification")).toBeVisible();
  });

  it("groups canonical panel conflicts and offers one explicit auto-arrange action", async () => {
    const user = userEvent.setup();
    const onAutoArrange2D = vi.fn();
    render(<WorkspaceValidationPanel view={view({
      counts: { blocking: 1, warning: 0, info: 0, total: 1 },
      issues: [{
        id: "layout:overlap:PANEL_A:PANEL_B",
        domain: "layout",
        severity: "blocking",
        code: "layout_overlap",
        title: "2D panels overlap",
        detail: "PANEL_A overlaps PANEL_B on the canonical authoring plane.",
        target: { surface: "inspector", componentId: "PANEL_A", section: "layout" },
      }],
    })} onAutoArrange2D={onAutoArrange2D} />);

    expect(screen.getByRole("heading", { name: "2D layout 1" })).toBeVisible();
    expect(screen.getByText("2D panels overlap")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Auto-arrange movable 2D panels" }));
    expect(onAutoArrange2D).toHaveBeenCalledOnce();
  });

  it("uses a bounded zero-state instead of claiming the Workspace is safe", () => {
    render(<WorkspaceValidationPanel view={view({
      counts: { blocking: 0, warning: 0, info: 0, total: 0 },
      issues: [],
    })} />);

    expect(screen.getByRole("status")).toHaveTextContent("No current issues found by these bounded checks");
    expect(screen.queryByText(/^safe$/iu)).not.toBeInTheDocument();
  });
});
