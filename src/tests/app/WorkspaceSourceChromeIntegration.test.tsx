import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceChrome } from "../../app/components/workspace";

afterEach(cleanup);

describe("WorkspaceChrome source integration", () => {
  it("forwards the atomic destination callback and source generation scope", async () => {
    const user = userEvent.setup();
    const onCommitSourceWithNewTarget = vi.fn(async () => true);
    const common = {
      catalog: [],
      sources: [],
      panelState: "sources" as const,
      onCreate: vi.fn(),
      onUpdate: vi.fn(),
      onAction: vi.fn(),
      onCreateShowcase: vi.fn(),
      onSaveInlineSource: vi.fn(() => true),
      onCommitSourceWithNewTarget,
    };
    const { rerender } = render(<WorkspaceChrome {...common} sourceScopeKey="project-a:1" />);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /Local JSON \/ CSV/u }));
    await user.click(screen.getByRole("button", { name: "Preview snapshot" }));
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    expect(screen.getByRole("radio", { name: /Create a new component/u })).toBeEnabled();
    await user.click(screen.getByRole("radio", { name: /Create a new component/u }));
    await user.click(screen.getByRole("button", { name: "Save snapshot" }));
    expect(onCommitSourceWithNewTarget).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Add another source" }));
    expect(screen.getByRole("region", { name: "Source setup" })).toBeVisible();
    rerender(<WorkspaceChrome {...common} sourceScopeKey="project-b:2" />);
    expect(screen.queryByRole("region", { name: "Source setup" })).not.toBeInTheDocument();
  });
});
