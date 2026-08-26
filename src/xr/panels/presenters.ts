import type { JSONObject, JSONValue } from "../../workspace/components/componentTypes";
import type {
  XRButtonPanelModel,
  XRButtonPanelPresentation,
  XRChartPanelModel,
  XRChartPanelPresentation,
  XRChartSeries,
  XRNumberPanelModel,
  XRNumberPanelPresentation,
  XRPanelDimensions,
  XRPanelKind,
  XRPanelModel,
  XRPanelPresentation,
  XRPanelPresenter,
  XRPanelTypedAction,
  XRTextPanelModel,
  XRTextPanelPresentation,
} from "./contracts";

const MAX_TEXT_LENGTH = 20_000;
const MAX_CHART_SERIES = 16;
const MAX_CHART_POINTS = 2_048;
const DEFAULT_DIMENSIONS: Readonly<Record<XRPanelKind, XRPanelDimensions>> = Object.freeze({
  text: Object.freeze({ widthM: 0.6, heightM: 0.32 }),
  number: Object.freeze({ widthM: 0.38, heightM: 0.2 }),
  button: Object.freeze({ widthM: 0.36, heightM: 0.16 }),
  chart: Object.freeze({ widthM: 0.72, heightM: 0.42 }),
});

function id(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function text(value: string, label: string, allowEmpty = false): string {
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function dimensions(value: XRPanelDimensions | undefined, kind: XRPanelKind): XRPanelDimensions {
  const result = value ?? DEFAULT_DIMENSIONS[kind];
  const widthM = finite(result.widthM, "dimensions.widthM");
  const heightM = finite(result.heightM, "dimensions.heightM");
  if (widthM < 0.05 || heightM < 0.05 || widthM > 5 || heightM > 5) {
    throw new RangeError("XR panel dimensions must be in [0.05, 5] metres");
  }
  return Object.freeze({ widthM, heightM });
}

function cloneJson(value: JSONValue, path = "input"): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((entry, index) => cloneJson(entry, `${path}[${index}]`))) as unknown as JSONValue;
  if (typeof value !== "object") throw new TypeError(`${path} must contain JSON values only`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain plain JSON objects only`);
  }
  const entries: Array<[string, JSONValue]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 256) throw new TypeError(`${path} contains an invalid key`);
    entries.push([key, cloneJson(entry, `${path}.${key}`)]);
  }
  return Object.freeze(Object.fromEntries(entries) as JSONObject);
}

function action(value: XRPanelTypedAction): XRPanelTypedAction {
  if (value.type !== "invoke_component_action") throw new TypeError("XR panel action type is invalid");
  if (value.confirmation !== "none" && value.confirmation !== "required") {
    throw new TypeError("XR panel action confirmation is invalid");
  }
  if (!Number.isSafeInteger(value.expectedWorkspaceRevision) || value.expectedWorkspaceRevision < 0) {
    throw new RangeError("expectedWorkspaceRevision must be a non-negative safe integer");
  }
  return Object.freeze({
    type: "invoke_component_action",
    targetComponentId: id(value.targetComponentId, "action.targetComponentId"),
    actionName: id(value.actionName, "action.actionName"),
    input: cloneJson(value.input) as JSONObject,
    expectedWorkspaceRevision: value.expectedWorkspaceRevision,
    confirmation: value.confirmation,
  });
}

function base(model: XRPanelModel, presenterId: string) {
  const panelId = id(model.panelId, "panelId");
  const componentId = id(model.componentId, "componentId");
  const title = model.title ? text(model.title, "title") : undefined;
  return {
    format: "semaframe-xr-panel" as const,
    version: "1.0" as const,
    rendererNeutral: true as const,
    presenterId,
    panelId,
    componentId,
    ...(title ? { title } : {}),
    dimensions: dimensions(model.dimensions, model.kind),
    accessibilityLabel: text(model.accessibilityLabel ?? model.title ?? panelId, "accessibilityLabel"),
  };
}

export const textPanelPresenter: XRPanelPresenter<"text"> = Object.freeze({
  id: "builtin.xr.text@1",
  kind: "text" as const,
  present(model: XRTextPanelModel): XRTextPanelPresentation {
    if (model.tone && !["default", "muted", "success", "warning", "danger"].includes(model.tone)) {
      throw new TypeError("text tone is invalid");
    }
    return Object.freeze({
      ...base(model, this.id),
      kind: "text",
      content: Object.freeze({
        text: text(model.text, "text", true),
        tone: model.tone ?? "default",
        wrap: true as const,
      }),
    });
  },
});

export const numberPanelPresenter: XRPanelPresenter<"number"> = Object.freeze({
  id: "builtin.xr.number@1",
  kind: "number" as const,
  present(model: XRNumberPanelModel): XRNumberPanelPresentation {
    if (model.trend && !["up", "down", "flat"].includes(model.trend)) {
      throw new TypeError("number trend is invalid");
    }
    const value = finite(model.value, "value");
    const formattedValue = text(model.formattedValue ?? String(value), "formattedValue");
    return Object.freeze({
      ...base(model, this.id),
      kind: "number",
      content: Object.freeze({
        value,
        formattedValue,
        ...(model.unit ? { unit: text(model.unit, "unit") } : {}),
        trend: model.trend ?? "flat",
      }),
    });
  },
});

export const buttonPanelPresenter: XRPanelPresenter<"button"> = Object.freeze({
  id: "builtin.xr.button@1",
  kind: "button" as const,
  present(model: XRButtonPanelModel): XRButtonPanelPresentation {
    if (model.state && !["enabled", "disabled", "busy"].includes(model.state)) {
      throw new TypeError("button state is invalid");
    }
    return Object.freeze({
      ...base(model, this.id),
      kind: "button",
      content: Object.freeze({
        label: text(model.label, "label"),
        state: model.state ?? "enabled",
        action: action(model.action),
      }),
    });
  },
});

function chartSeries(value: XRChartSeries, seriesIndex: number): XRChartSeries {
  if (value.points.length > MAX_CHART_POINTS) {
    throw new RangeError(`chart series cannot exceed ${MAX_CHART_POINTS} points`);
  }
  return Object.freeze({
    id: id(value.id, `series[${seriesIndex}].id`),
    label: text(value.label, `series[${seriesIndex}].label`),
    ...(value.color ? { color: text(value.color, `series[${seriesIndex}].color`) } : {}),
    points: Object.freeze(value.points.map((point, pointIndex) => Object.freeze({
      x: finite(point.x, `series[${seriesIndex}].points[${pointIndex}].x`),
      y: finite(point.y, `series[${seriesIndex}].points[${pointIndex}].y`),
    }))),
  });
}

export const chartPanelPresenter: XRPanelPresenter<"chart"> = Object.freeze({
  id: "builtin.xr.chart@1",
  kind: "chart" as const,
  present(model: XRChartPanelModel): XRChartPanelPresentation {
    if (model.series.length === 0 || model.series.length > MAX_CHART_SERIES) {
      throw new RangeError(`chart requires 1-${MAX_CHART_SERIES} series`);
    }
    const series = model.series.map(chartSeries);
    if (new Set(series.map(({ id: seriesId }) => seriesId)).size !== series.length) {
      throw new TypeError("chart series ids must be unique");
    }
    return Object.freeze({
      ...base(model, this.id),
      kind: "chart",
      content: Object.freeze({
        series: Object.freeze(series),
        ...(model.xLabel ? { xLabel: text(model.xLabel, "xLabel") } : {}),
        ...(model.yLabel ? { yLabel: text(model.yLabel, "yLabel") } : {}),
      }),
    });
  },
});

export const BUILTIN_XR_PANEL_PRESENTERS = Object.freeze([
  textPanelPresenter,
  numberPanelPresenter,
  buttonPanelPresenter,
  chartPanelPresenter,
] as const);

export function isXRPanelPresentation(value: unknown): value is XRPanelPresentation {
  if (!plainRecord(value)) return false;
  const panel = value as Record<string, unknown>;
  if (panel.format !== "semaframe-xr-panel" || panel.version !== "1.0"
    || panel.rendererNeutral !== true || !boundedRuntimeText(panel.presenterId, 160)
    || !boundedRuntimeText(panel.panelId, 256) || !boundedRuntimeText(panel.componentId, 256)
    || !boundedRuntimeText(panel.accessibilityLabel, 512)
    || (panel.title !== undefined && !boundedRuntimeText(panel.title, 160))
    || !plainRecord(panel.dimensions)
    || !finiteRange(panel.dimensions.widthM, 0.01, 100)
    || !finiteRange(panel.dimensions.heightM, 0.01, 100)
    || !plainRecord(panel.content)) return false;
  const content = panel.content as Record<string, unknown>;
  if (panel.kind === "text") {
    return boundedRuntimeText(content.text, 2_048, true)
      && ["default", "muted", "success", "warning", "danger"].includes(String(content.tone))
      && content.wrap === true;
  }
  if (panel.kind === "number") {
    return typeof content.value === "number" && Number.isFinite(content.value)
      && boundedRuntimeText(content.formattedValue, 80, true)
      && (content.unit === undefined || boundedRuntimeText(content.unit, 32, true))
      && ["up", "down", "flat"].includes(String(content.trend));
  }
  if (panel.kind === "button") {
    return boundedRuntimeText(content.label, 120, true)
      && ["enabled", "disabled", "busy"].includes(String(content.state))
      && validRuntimeAction(content.action);
  }
  if (panel.kind !== "chart" || !Array.isArray(content.series) || content.series.length > 8
    || (content.xLabel !== undefined && !boundedRuntimeText(content.xLabel, 80, true))
    || (content.yLabel !== undefined && !boundedRuntimeText(content.yLabel, 80, true))) return false;
  return content.series.every((candidate) => {
    if (!plainRecord(candidate) || !boundedRuntimeText(candidate.id, 128)
      || !boundedRuntimeText(candidate.label, 128, true)
      || (candidate.color !== undefined && !boundedRuntimeText(candidate.color, 32))
      || !Array.isArray(candidate.points) || candidate.points.length > 512) return false;
    return candidate.points.every((point) => plainRecord(point)
      && typeof point.x === "number" && Number.isFinite(point.x)
      && typeof point.y === "number" && Number.isFinite(point.y));
  });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedRuntimeText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0)
    && !/\p{Cc}/u.test(value);
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validRuntimeAction(value: unknown): boolean {
  if (!plainRecord(value) || value.type !== "invoke_component_action"
    || !boundedRuntimeText(value.targetComponentId, 256)
    || !boundedRuntimeText(value.actionName, 256)
    || !Number.isSafeInteger(value.expectedWorkspaceRevision) || Number(value.expectedWorkspaceRevision) < 0
    || (value.confirmation !== "none" && value.confirmation !== "required")
    || !plainRecord(value.input)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value.input)).byteLength <= 64 * 1024;
  } catch {
    return false;
  }
}
