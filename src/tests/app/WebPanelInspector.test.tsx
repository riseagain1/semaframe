import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceInspector } from "../../app/components/workspace/WorkspaceInspector";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

afterEach(cleanup);

describe("website panel Inspector", () => {
  it("validates and saves a canonical HTTPS target as one component update", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={webPanel()} onUpdate={onUpdate} />);

    expect(screen.getByRole("heading", { name: "Website setup" })).toBeVisible();
    const source = screen.getByRole("textbox", { name: "Website URL" });
    const title = screen.getByRole("textbox", { name: "Panel title" });

    await user.clear(source);
    await user.type(source, "http://example.com/private");
    await user.click(screen.getByRole("button", { name: "Save website" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Only HTTPS");
    expect(onUpdate).not.toHaveBeenCalled();

    await user.clear(source);
    await user.type(source, "https://EXAMPLE.com:443/markets?q=close");
    await user.clear(title);
    await user.type(title, "Market overview");
    await user.click(screen.getByRole("button", { name: "Save website" }));

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith({
      componentId: "CMP_WEB",
      label: "Market overview",
      props: {
        sourceUrl: "https://example.com/markets?q=close",
        title: "Market overview",
      },
    });
  });

  it("rejects durable signed URLs and respects the component property lock", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const view = render(<WorkspaceInspector component={webPanel()} onUpdate={onUpdate} />);
    const source = screen.getByRole("textbox", { name: "Website URL" });
    await user.clear(source);
    await user.type(source, "https://example.com/report?signature=abc123");
    await user.click(screen.getByRole("button", { name: "Save website" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/query parameters/i);
    expect(onUpdate).not.toHaveBeenCalled();

    view.rerender(<WorkspaceInspector
      component={{ ...webPanel(), locks: { ...webPanel().locks, props: true } }}
      onUpdate={onUpdate}
    />);
    expect(screen.getByRole("textbox", { name: "Website URL" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Panel title" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save website" })).toBeDisabled();
  });
});

function webPanel(): WorkspaceRenderComponent {
  return {
    id: "CMP_WEB",
    type: { typeId: "web-panel", version: "1.2.0", digest: "web-panel-digest" },
    label: "Website",
    props: { sourceUrl: "https://example.com/", title: "Website" },
    durableState: {},
    placement: {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: { width: 560, height: 420 },
    },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}
