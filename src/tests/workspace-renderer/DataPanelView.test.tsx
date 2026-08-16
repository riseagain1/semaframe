import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataPanelView } from "../../app/components/workspace/DataPanelView";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

afterEach(cleanup);

function component(data: unknown, view = "auto"): WorkspaceRenderComponent {
  return {
    id: "data-panel-1",
    type: { typeId: "data-panel", version: "1.2.0", digest: "digest" },
    label: "Live feed",
    props: { title: "Live feed", data, view },
    durableState: {},
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 }, size: { width: 480, height: 320 }, zIndex: 1 },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}

describe("DataPanelView", () => {
  it("renders arbitrary record arrays as a bounded accessible table", () => {
    render(<DataPanelView component={component([
      { symbol: "SFRM", price: 188.1 },
      { symbol: "OPEN", price: 192.4 },
    ])} />);

    expect(screen.getByRole("region", { name: "Live feed" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Feed data" })).toHaveTextContent("SFRM");
    expect(screen.getByRole("table", { name: "Feed data" })).toHaveTextContent("192.4");
  });

  it("recognizes RSS-style item envelopes and never interprets markup", () => {
    render(<DataPanelView component={component({
      title: "News",
      items: [{ title: "Launch", summary: "<img src=x onerror=alert(1)>", link: "https://example.com/item" }],
    }, "cards")} />);

    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute("rel", "noreferrer");
  });

  it("falls back to capped JSON for heterogeneous data", () => {
    render(<DataPanelView component={component({ values: [1, "two", false] }, "json")} />);
    expect(screen.getByText(/"two"/u)).toBeInTheDocument();
  });
});
