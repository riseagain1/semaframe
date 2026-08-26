import { describe, expect, it } from "vitest";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import { toXrWorkspaceProjection } from "../../xr/authority";
import { deriveXrViewerPanelModels, presentXrWorldPanels } from "../../xr/app";

function projection() {
  const components: WorkspaceRenderSnapshot["components"] = [
    component("text", "copy", { text: "Emergency route clear" }, 0),
    component("data-panel", "metric", { title: "Clearance", data: 2.4, unit: "m" }, 1),
    component("button", "dispatch", { label: "Dispatch", variant: "primary" }, 2),
    component("chart", "flow", {
      title: "Flow",
      xLabel: "min",
      yLabel: "vehicles",
      series: [{ id: "traffic", label: "Traffic", values: [2, 5, 3], color: "#00ccff" }],
    }, 3),
  ];
  return toXrWorkspaceProjection({ workspaceId: "workspace-panels", revision: 12, components });
}

function component(typeId: string, id: string, props: Record<string, unknown>, x: number) {
  return {
    id,
    type: { typeId, version: "1.0.0", digest: "fixture" },
    label: id,
    props,
    durableState: {},
    placement: {
      space: "world3d" as const,
      position: { x, y: 1, z: -2 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    tags: [],
    visibility: "visible" as const,
    locks: { placement: false },
  };
}

describe("XR world panel projection", () => {
  it("presents text, number, button, and chart as renderer-neutral world DTOs", () => {
    const source = projection();
    const models = deriveXrViewerPanelModels(source);
    expect(models.map(({ kind }) => kind).sort()).toEqual(["button", "chart", "number", "text"]);

    const panels = presentXrWorldPanels(source, models);
    expect(panels.map(({ panel }) => panel.kind).sort()).toEqual(["button", "chart", "number", "text"]);
    expect(panels.every(({ rendererNeutral, format, workspaceRevision }) => (
      rendererNeutral && format === "semaframe-xr-world-panel" && workspaceRevision === 12
    ))).toBe(true);
    expect(panels.find(({ panel }) => panel.kind === "button")).toMatchObject({
      sourcePlacementSpace: "world3d",
      transform: { position: { x: 2, y: 1, z: -2 } },
      panel: {
        kind: "button",
        content: { action: { targetComponentId: "dispatch", expectedWorkspaceRevision: 12 } },
      },
    });
  });

  it("assigns a deterministic immersive layout to non-world placements", () => {
    const source = projection();
    const moved = {
      ...source,
      components: source.components.map((entry, index) => index === 0 ? {
        ...entry,
        placement: { space: "viewport" as const, anchor: "top_left" as const, offset: { x: 0, y: 0 } },
      } : entry),
    };
    expect(presentXrWorldPanels(moved)[0]).toMatchObject({
      sourcePlacementSpace: "viewport",
      transform: { position: { x: 0, y: 1.75, z: -2.2 } },
    });
  });

  it("keeps the maximum viewer-layout panel set in an above-floor carousel", () => {
    const source = projection();
    const models = Array.from({ length: 64 }, (_, index) => ({
      kind: "text" as const,
      panelId: `panel-${index}`,
      componentId: `detached-${index}`,
      text: `Panel ${index}`,
    }));
    const panels = presentXrWorldPanels(source, models);
    expect(panels).toHaveLength(64);
    expect(panels.every(({ transform }) => transform.position.y >= 0.75)).toBe(true);
    expect(panels.every(({ transform }) => Math.abs(
      Math.hypot(transform.position.x, transform.position.z) - 2.2,
    ) < 1e-10)).toBe(true);
    expect(new Set(panels.map(({ transform }) => transform.rotation.y)).size).toBeGreaterThan(20);
  });
});
