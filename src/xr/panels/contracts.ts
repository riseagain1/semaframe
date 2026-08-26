import type { JSONObject } from "../../workspace/components/componentTypes";

export type XRPanelKind = "text" | "number" | "button" | "chart";

export type XRPanelDimensions = Readonly<{
  widthM: number;
  heightM: number;
}>;

export type XRPanelTypedAction = Readonly<{
  type: "invoke_component_action";
  targetComponentId: string;
  actionName: string;
  input: JSONObject;
  expectedWorkspaceRevision: number;
  confirmation: "none" | "required";
}>;

type XRPanelModelBase = Readonly<{
  panelId: string;
  componentId: string;
  title?: string;
  dimensions?: XRPanelDimensions;
  accessibilityLabel?: string;
}>;

export type XRTextPanelModel = XRPanelModelBase & Readonly<{
  kind: "text";
  text: string;
  tone?: "default" | "muted" | "success" | "warning" | "danger";
}>;

export type XRNumberPanelModel = XRPanelModelBase & Readonly<{
  kind: "number";
  value: number;
  formattedValue?: string;
  unit?: string;
  trend?: "up" | "down" | "flat";
}>;

export type XRButtonPanelModel = XRPanelModelBase & Readonly<{
  kind: "button";
  label: string;
  state?: "enabled" | "disabled" | "busy";
  action: XRPanelTypedAction;
}>;

export type XRChartPoint = Readonly<{ x: number; y: number }>;
export type XRChartSeries = Readonly<{
  id: string;
  label: string;
  color?: string;
  points: readonly XRChartPoint[];
}>;

export type XRChartPanelModel = XRPanelModelBase & Readonly<{
  kind: "chart";
  series: readonly XRChartSeries[];
  xLabel?: string;
  yLabel?: string;
}>;

export type XRPanelModel =
  | XRTextPanelModel
  | XRNumberPanelModel
  | XRButtonPanelModel
  | XRChartPanelModel;

type XRPanelPresentationBase = Readonly<{
  format: "semaframe-xr-panel";
  version: "1.0";
  rendererNeutral: true;
  presenterId: string;
  panelId: string;
  componentId: string;
  kind: XRPanelKind;
  title?: string;
  dimensions: XRPanelDimensions;
  accessibilityLabel: string;
}>;

export type XRTextPanelPresentation = XRPanelPresentationBase & Readonly<{
  kind: "text";
  content: Readonly<{
    text: string;
    tone: "default" | "muted" | "success" | "warning" | "danger";
    wrap: true;
  }>;
}>;

export type XRNumberPanelPresentation = XRPanelPresentationBase & Readonly<{
  kind: "number";
  content: Readonly<{
    value: number;
    formattedValue: string;
    unit?: string;
    trend: "up" | "down" | "flat";
  }>;
}>;

export type XRButtonPanelPresentation = XRPanelPresentationBase & Readonly<{
  kind: "button";
  content: Readonly<{
    label: string;
    state: "enabled" | "disabled" | "busy";
    action: XRPanelTypedAction;
  }>;
}>;

export type XRChartPanelPresentation = XRPanelPresentationBase & Readonly<{
  kind: "chart";
  content: Readonly<{
    series: readonly XRChartSeries[];
    xLabel?: string;
    yLabel?: string;
  }>;
}>;

export type XRPanelPresentation =
  | XRTextPanelPresentation
  | XRNumberPanelPresentation
  | XRButtonPanelPresentation
  | XRChartPanelPresentation;

export interface XRPanelPresenter<K extends XRPanelKind = XRPanelKind> {
  readonly id: string;
  readonly kind: K;
  present(model: Extract<XRPanelModel, { kind: K }>): Extract<XRPanelPresentation, { kind: K }>;
}

export interface XRPanelActionPort {
  invoke(action: XRPanelTypedAction): void | Promise<void>;
}
