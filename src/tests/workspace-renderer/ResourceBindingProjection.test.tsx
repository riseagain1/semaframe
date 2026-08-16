import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceComponentView } from "../../app/components/workspace/WorkspaceComponentViews";
import { DEFAULT_COMPONENT_REGISTRY, deterministicDigest } from "../../workspace/components";
import { toRenderSnapshot } from "../../workspace/renderer/contracts";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

describe("resource-bound renderer projection", () => {
  it("renders a frozen time series in the stock chart window", () => {
    const store = new WorkspaceStore();
    const data = {
      labels: ["09:30", "09:31"],
      series: [{ id: "close", label: "Close", values: [188.4, 189.1], color: "#68D5FF" }],
    };
    store.apply(workspaceBatch(store, "bound_chart", [{
      op: "create_component",
      op_id: "chart",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("chart"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      props: { title: "ACME", chartType: "line", labels: [], series: [] },
    }, {
      op: "upsert_resource",
      op_id: "stock",
      resource: {
        id: "RES_stock",
        label: "ACME intraday",
        connectorType: "inline.snapshot",
        connectorVersion: "1.0.0",
        outputSchema: {
          type: "object",
          required: ["labels", "series"],
          properties: {
            labels: { type: "array", items: { type: "string" } },
            series: { type: "array", items: { type: "object" } },
          },
        },
        config: {},
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data,
          contentHash: deterministicDigest(data),
          retrievedAt: "2026-08-15T01:02:03.000Z",
          stale: false,
          provenance: [],
        },
        status: "ready",
      },
    }, ...(["labels", "series"] as const).map((targetProp) => ({
      op: "bind_resource" as const,
      op_id: `bind_${targetProp}`,
      binding: {
        kind: "resource_binding" as const,
        id: `BIND_${targetProp}`,
        resourceId: "RES_stock",
        componentId: "CMP_000001",
        targetProp,
        sourcePath: `$.${targetProp}`,
        mode: "snapshot" as const,
        transform: { kind: "identity" as const },
        enabled: true,
      },
    }))]));

    const component = toRenderSnapshot(store.getState()).components[0]!;
    render(<WorkspaceComponentView component={component} />);
    expect(screen.getByRole("figure", { name: "ACME" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Chart data" })).toHaveTextContent("09:30");
    expect(screen.getByRole("table", { name: "Chart data" })).toHaveTextContent("189.1");
    expect(store.getState().components.get("CMP_000001")?.props.labels).toEqual([]);
  });

  it("renders an arbitrary record feed through the generic Data Panel without mutating canonical props", () => {
    const store = new WorkspaceStore();
    const data = {
      items: [
        { id: "a", title: "Alpha", status: "ready", value: 12.4 },
        { id: "b", title: "Beta", status: "watch", value: 9.8 },
      ],
      source: "fixture",
    };
    store.apply(workspaceBatch(store, "bound_data_panel", [{
      op: "create_component",
      op_id: "panel",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("data-panel"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      props: { title: "Operations feed", data: null, view: "auto", emptyMessage: "No records" },
    }, {
      op: "upsert_resource",
      op_id: "source",
      resource: {
        id: "RES_data",
        label: "Operations",
        connectorType: "inline.snapshot",
        connectorVersion: "1.0.0",
        outputSchema: { type: "object" },
        config: {},
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data,
          contentHash: deterministicDigest(data),
          retrievedAt: "2026-08-15T01:02:03.000Z",
          stale: false,
          provenance: [],
        },
        status: "ready",
      },
    }, {
      op: "bind_resource",
      op_id: "bind",
      binding: {
        kind: "resource_binding",
        id: "BIND_data",
        resourceId: "RES_data",
        componentId: "CMP_000001",
        targetProp: "data",
        sourcePath: "$",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      },
    }]));

    const component = toRenderSnapshot(store.getState()).components[0]!;
    render(<WorkspaceComponentView component={component} />);
    expect(screen.getByRole("region", { name: "Operations feed" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Feed data" })).toHaveTextContent("Alpha");
    expect(screen.getByRole("table", { name: "Feed data" })).toHaveTextContent("9.8");
    expect(store.getState().components.get("CMP_000001")?.props.data).toBeNull();
  });
});
