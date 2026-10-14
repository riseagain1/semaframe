import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectBar } from "../../app/components/ProjectBar";
import { collectRuntimeViewHost } from "../../workspace/renderer/runtimeViewHost";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("reserves the open project dropdown below an otherwise out-of-canvas header", () => {
  render(<div data-workspace-runtime-root="true">
    <ProjectBar projectName="Private project name" dirty={false} canUndo={false} canRedo={false} busy={false}
      onProjectName={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} onOpen={vi.fn()} onSave={vi.fn()} onNew={vi.fn()} />
    <div data-testid="canvas" />
  </div>);
  const canvas = screen.getByTestId("canvas");
  setRect(canvas, 0, 54, 501, 639);
  setRect(screen.getByRole("banner"), 0, 0, 501, 54);
  expect(collectRuntimeViewHost(canvas).occluders).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "More project actions" }));
  const menu = screen.getByRole("menu");
  expect(menu).toHaveAttribute("data-workspace-runtime-region", "project-menu");
  setRect(menu, 281, 45, 210, 200);
  expect(collectRuntimeViewHost(canvas).occluders).toEqual([
    { id: "project-menu", kind: "panel", bounds: { left: 281, top: 0, width: 210, height: 191 } },
  ]);
  expect(JSON.stringify(collectRuntimeViewHost(canvas))).not.toContain("Private project name");
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(collectRuntimeViewHost(canvas).occluders).toEqual([]);
});

function setRect(element: HTMLElement, left: number, top: number, width: number, height: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}),
  });
}
