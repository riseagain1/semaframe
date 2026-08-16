import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceComponentView } from "../../app/components/workspace/WorkspaceComponentViews";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

afterEach(cleanup);

describe("built-in component projections", () => {
  it("projects a native button through its semantic press action", () => {
    const onAction = vi.fn();
    render(<WorkspaceComponentView
      component={component("button", { label: "Launch simulation", variant: "primary" }, {
        pressCount: 2,
        lastPressedAtMs: 1_000,
      })}
      onAction={onAction}
    />);

    const button = screen.getByRole("button", { name: "Launch simulation" });
    expect(button).toHaveAttribute("data-press-count", "2");
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith({ componentId: "button-1", action: "press" });
  });

  it("renders every initial 2D built-in with accessible content", () => {
    const { rerender } = render(<WorkspaceComponentView component={component("panel", { title: "Control panel" })} />);
    expect(screen.getByRole("region", { name: "Control panel" })).toBeInTheDocument();

    rerender(<WorkspaceComponentView component={component("text", { text: "System nominal", variant: "heading" })} />);
    expect(screen.getByRole("heading", { name: "System nominal" })).toBeInTheDocument();

    rerender(<WorkspaceComponentView component={component("image", {
      assetRef: "data:image/png;base64,iVBORw0KGgo=",
      alt: "Orbital map",
    })} />);
    expect(screen.getByRole("img", { name: "Orbital map" })).toBeInTheDocument();

    rerender(<WorkspaceComponentView component={component("video-player", {
      sourceUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
      sourceKind: "youtube",
      title: "Mission video",
    })} />);
    expect(screen.getByRole("region", { name: "Mission video video player" })).toHaveAttribute("data-video-loaded", "false");
    expect(screen.getByRole("button", { name: "Load Mission video" })).toBeInTheDocument();
    expect(document.querySelector("iframe, video")).not.toBeInTheDocument();

    rerender(<WorkspaceComponentView component={component("web-panel", {
      sourceUrl: "https://example.com/dashboard",
      title: "Mission dashboard",
    })} />);
    expect(screen.getByRole("region", { name: "Mission dashboard website panel" })).toHaveAttribute("data-web-panel-state", "facade");
    expect(screen.getByRole("button", { name: "Load Mission dashboard" })).toBeInTheDocument();
    expect(document.querySelector("iframe, video")).not.toBeInTheDocument();

    rerender(<WorkspaceComponentView component={component("annotation", { text: "Weather hold", tone: "warning" })} />);
    expect(screen.getByRole("complementary", { name: "warning annotation" })).toHaveTextContent("Weather hold");

    rerender(<WorkspaceComponentView component={component("timer", {
      label: "Launch",
      durationMs: 60_000,
    }, {
      phase: "paused",
      durationMs: 60_000,
      remainingMs: 45_000,
      runGeneration: 1,
    })} />);
    expect(screen.getByLabelText("00:45 remaining")).toBeInTheDocument();

    rerender(<WorkspaceComponentView component={component("checklist", { title: "Go/no-go" }, {
      items: [{ id: "item-1", text: "Fuel loaded", completed: true }],
    })} />);
    expect(screen.getByRole("checkbox", { name: "Fuel loaded" })).toBeChecked();

    rerender(<WorkspaceComponentView component={component("chart", {
      title: "Telemetry",
      chartType: "line",
      labels: ["T-2", "T-1"],
      series: [{ id: "temp", label: "Temperature", values: [20, 24], color: "#68D5FF" }],
    })} />);
    expect(screen.getByRole("img", { name: "line chart" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Chart data" })).toBeInTheDocument();

    rerender(<WorkspaceComponentView component={component("table", {
      title: "Crew",
      columns: [{ key: "name", label: "Name" }],
      rows: [{ id: "row-1", name: "Avery" }],
    })} />);
    expect(screen.getByRole("table", { name: "Crew" })).toHaveTextContent("Avery");

    rerender(<WorkspaceComponentView component={component("document", {
      title: "Briefing",
      content: "# Objective\nReach orbit.",
      format: "markdown",
    })} />);
    expect(screen.getByRole("article", { name: "Briefing" })).toHaveTextContent("Reach orbit.");
    expect(screen.queryByText(/Projection unavailable/i)).not.toBeInTheDocument();
  });

  it("renders all advertised chart forms and preserves a useful local stock-price domain", () => {
    const stock = component("chart", {
      title: "ACME close",
      chartType: "line",
      labels: ["09:30", "10:00"],
      series: [{ id: "close", label: "Close", values: [188.4, 189.1], color: "#68D5FF" }],
    });
    const { container, rerender } = render(<WorkspaceComponentView component={stock} />);
    const circles = [...container.querySelectorAll<SVGCircleElement>('[data-chart-mark="point"]')];
    expect(circles).toHaveLength(2);
    expect(Math.abs(Number(circles[0]!.getAttribute("cy")) - Number(circles[1]!.getAttribute("cy")))).toBeGreaterThan(100);

    const cases = [
      ["line", "line"],
      ["area", "area"],
      ["scatter", "point"],
      ["bar", "bar"],
      ["pie", "pie"],
    ] as const;
    for (const [chartType, mark] of cases) {
      rerender(<WorkspaceComponentView component={component("chart", {
        title: `${chartType} data`,
        chartType,
        labels: ["A", "B", "C"],
        series: [{ id: "value", label: "Value", values: [2, 4, 3], color: "#68D5FF" }],
      })} />);
      expect(container.querySelector(`[data-chart-mark="${mark}"]`)).not.toBeNull();
    }
  });

  it("routes chart and table interactions through declared semantic actions", () => {
    const chartAction = vi.fn();
    const { container, rerender } = render(<WorkspaceComponentView
      component={component("chart", {
        title: "Price",
        chartType: "line",
        labels: ["Open", "Close"],
        series: [{ id: "price", label: "Price", values: [10, 12], color: "#68D5FF" }],
      })}
      onAction={chartAction}
    />);
    fireEvent.change(container.querySelector('select[aria-label="Selected chart point"]')!, {
      target: { value: "price:1" },
    });
    expect(chartAction).toHaveBeenCalledWith({
      componentId: "chart-1",
      action: "select_point",
      input: { pointId: "price:1" },
    });

    const tableAction = vi.fn();
    rerender(<WorkspaceComponentView
      component={component("table", {
        title: "Positions",
        columns: [{ key: "symbol", label: "Symbol" }],
        rows: [{ id: "row-a", symbol: "ACME" }, { id: "row-b", symbol: "NOVA" }],
      })}
      onAction={tableAction}
    />);
    const acmeRow = container.querySelector('tr[data-row-id="row-a"]');
    expect(acmeRow).not.toBeNull();
    fireEvent.click(acmeRow!);
    fireEvent.keyDown(acmeRow!, { key: "Enter" });
    expect(tableAction).toHaveBeenNthCalledWith(1, {
      componentId: "table-1",
      action: "select_row",
      input: { rowId: "row-a" },
    });
    expect(tableAction).toHaveBeenNthCalledWith(2, {
      componentId: "table-1",
      action: "select_row",
      input: { rowId: "row-a" },
    });
  });

  it("disables chart selection while component actions are locked", () => {
    const onAction = vi.fn();
    const { container } = render(<WorkspaceComponentView
      component={{
        ...component("chart", {
          title: "Locked price",
          chartType: "line",
          labels: ["Open"],
          series: [{ id: "price", label: "Price", values: [10], color: "#68D5FF" }],
        }),
        locks: { placement: false, props: false, deletion: false, actions: true },
      }}
      onAction={onAction}
    />);
    expect(container.querySelector('select[aria-label="Selected chart point"]')).toBeDisabled();
    fireEvent.click(container.querySelector('[data-chart-mark="point"]')!);
    expect(onAction).not.toHaveBeenCalled();
  });
});

function component(
  typeId: string,
  props: Record<string, unknown>,
  durableState: Record<string, unknown> = {},
): WorkspaceRenderComponent {
  return {
    id: `${typeId}-1`,
    type: { typeId, version: "1.0.0", digest: "test" },
    label: typeId,
    props,
    durableState,
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}
