import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";
import type { XrWorkspaceProjection } from "../authority";
import {
  createDefaultXRPanelPresenterRegistry,
  type XRChartSeries,
  type XRPanelModel,
} from "../panels";
import type { XrViewerPanelModelFactory, XrWorldPanelPresentation } from "./contracts";

const MAX_WORLD_PANELS = 64;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function chartSeries(value: unknown): readonly XRChartSeries[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((candidate, seriesIndex) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    if (!Array.isArray(record.values)) return [];
    const values = record.values.slice(0, 2_048).flatMap((entry) => {
      const number = finite(entry);
      return number === undefined ? [] : [number];
    });
    return [{
      id: text(record.id, `series-${seriesIndex}`),
      label: text(record.label, `Series ${seriesIndex + 1}`),
      ...(typeof record.color === "string" ? { color: record.color } : {}),
      points: values.map((y, x) => ({ x, y })),
    }];
  });
}

function modelFor(component: WorkspaceRenderComponent, revision: number): XRPanelModel | undefined {
  const kind = component.type.typeId;
  const title = text(component.props.title, component.label);
  if (kind === "text" || kind === "annotation") return {
    kind: "text",
    panelId: `xr-panel:${component.id}`,
    componentId: component.id,
    title,
    text: text(component.props.text),
  };
  if (kind === "button") return {
    kind: "button",
    panelId: `xr-panel:${component.id}`,
    componentId: component.id,
    title,
    label: text(component.props.label, component.label),
    action: {
      type: "invoke_component_action",
      targetComponentId: component.id,
      actionName: "press",
      input: {},
      expectedWorkspaceRevision: revision,
      confirmation: component.props.variant === "danger" ? "required" : "none",
    },
  };
  if (kind === "chart") {
    const series = chartSeries(component.props.series);
    if (series.length === 0) return undefined;
    return {
      kind: "chart",
      panelId: `xr-panel:${component.id}`,
      componentId: component.id,
      title,
      series,
      ...(typeof component.props.xLabel === "string" ? { xLabel: component.props.xLabel } : {}),
      ...(typeof component.props.yLabel === "string" ? { yLabel: component.props.yLabel } : {}),
    };
  }
  const number = finite(component.props.value)
    ?? (kind === "data-panel" ? finite(component.props.data) : undefined);
  if (number !== undefined) return {
    kind: "number",
    panelId: `xr-panel:${component.id}`,
    componentId: component.id,
    title,
    value: number,
    ...(typeof component.props.formattedValue === "string" ? { formattedValue: component.props.formattedValue } : {}),
    ...(typeof component.props.unit === "string" ? { unit: component.props.unit } : {}),
  };
  return undefined;
}

export const deriveXrViewerPanelModels: XrViewerPanelModelFactory = (projection) => Object.freeze(
  projection.components.flatMap((component) => {
    if (component.visibility !== "visible") return [];
    const model = modelFor(component, projection.revision);
    return model ? [model] : [];
  }).slice(0, MAX_WORLD_PANELS),
);

function deterministicTransform(
  projection: XrWorkspaceProjection,
  model: XRPanelModel,
  index: number,
) {
  const component = projection.components.find(({ id }) => id === model.componentId);
  if (component?.placement.space === "world3d") return {
    sourcePlacementSpace: "world3d",
    transform: {
      position: component.placement.position,
      rotation: component.placement.rotation,
      scale: component.placement.scale,
    },
  } as const;
  // Viewer-space panels form a bounded three-level carousel around the user.
  // Unlike an unbounded downward grid, every one of the 64 allowed panels
  // remains above the floor and can be reached by turning in place.
  const row = index % 3;
  const angularSlot = Math.floor(index / 3);
  const angularSlotCount = Math.ceil(MAX_WORLD_PANELS / 3);
  const angle = angularSlot * (Math.PI * 2 / angularSlotCount);
  const radius = 2.2;
  return {
    sourcePlacementSpace: component?.placement.space ?? "viewer-layout",
    transform: {
      position: {
        x: Math.sin(angle) * radius,
        y: 1.75 - row * 0.5,
        z: -Math.cos(angle) * radius,
      },
      rotation: { x: 0, y: -angle, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  } as const;
}

export function presentXrWorldPanels(
  projection: XrWorkspaceProjection,
  models: readonly XRPanelModel[] = deriveXrViewerPanelModels(projection),
): readonly XrWorldPanelPresentation[] {
  const registry = createDefaultXRPanelPresenterRegistry();
  return Object.freeze(models.slice(0, MAX_WORLD_PANELS).map((model, index) => {
    const located = deterministicTransform(projection, model, index);
    return Object.freeze({
      format: "semaframe-xr-world-panel" as const,
      version: "1.0" as const,
      rendererNeutral: true as const,
      workspaceRevision: projection.revision,
      sourcePlacementSpace: located.sourcePlacementSpace,
      transform: Object.freeze({
        position: Object.freeze({ ...located.transform.position }),
        rotation: Object.freeze({ ...located.transform.rotation }),
        scale: Object.freeze({ ...located.transform.scale }),
      }),
      panel: registry.present(model),
    });
  }));
}
