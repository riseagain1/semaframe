import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../app/components/ConfirmDialog";
import { ProjectBar } from "../../app/components/ProjectBar";
import { Viewport } from "../../app/components/Viewport";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open confirmation</button>
    <ConfirmDialog
      open={open}
      title="Clear this scene?"
      detail="This action can be undone."
      confirmLabel="Clear scene"
      onCancel={() => setOpen(false)}
      onConfirm={() => setOpen(false)}
    />
  </>;
}

describe("keyboard and assistive interaction", () => {
  it("contains modal focus, closes with Escape, and restores the opener", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Open confirmation" });
    await user.click(opener);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());

    await user.tab();
    expect(screen.getByRole("button", { name: "Clear scene" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("supports arrow-key project menu navigation and restores its trigger", async () => {
    const user = userEvent.setup();
    render(<ProjectBar
      projectName="Test world"
      dirty
      canUndo
      canRedo={false}
      busy={false}
      onProjectName={vi.fn()}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onOpen={vi.fn()}
      onSave={vi.fn()}
      onNew={vi.fn()}
    />);
    const trigger = screen.getByRole("button", { name: /more project actions, unsaved changes/i });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "New project" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: /download copy/i })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("prevents snapshot file actions while another project operation is active", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const view = render(<ProjectBar
      projectName="Busy world"
      dirty={false}
      canUndo
      canRedo
      busy
      onProjectName={vi.fn()}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onOpen={vi.fn()}
      onSave={onSave}
      onSavePortable={vi.fn()}
      onExportExchange={vi.fn()}
      onOpenBridge={vi.fn()}
      onNew={vi.fn()}
    />);

    const projectBar = within(view.container);
    expect(projectBar.getByRole("button", { name: "Save project" })).toBeDisabled();
    await user.click(projectBar.getByRole("button", { name: "More project actions" }));
    expect(projectBar.getByRole("menuitem", { name: /download copy/i })).toBeDisabled();
    expect(projectBar.getByRole("menuitem", { name: /download portable project/i })).toBeDisabled();
    expect(projectBar.getByRole("menuitem", { name: /export scene exchange/i })).toBeDisabled();
    expect(projectBar.getByRole("menuitem", { name: /open scene bridge/i })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("removes the covered viewport from assistive and keyboard interaction", () => {
    const { rerender } = render(<Viewport
      status="ready"
      entityCount={0}
      revision={0}
      interactionDisabled
      onFrameAll={vi.fn()}
      onResetView={vi.fn()}
    />);
    const viewportShell = document.querySelector(".viewport-shell");
    expect(viewportShell).toHaveAttribute("inert");
    expect(viewportShell).toHaveAttribute("aria-hidden", "true");

    rerender(<Viewport
      status="ready"
      entityCount={0}
      revision={0}
      interactionDisabled={false}
      onFrameAll={vi.fn()}
      onResetView={vi.fn()}
    />);
    expect(viewportShell).not.toHaveAttribute("inert");
    expect(viewportShell).not.toHaveAttribute("aria-hidden");
  });
});
