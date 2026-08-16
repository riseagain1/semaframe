import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  isRecord,
  type ComponentActionRequest,
  type WorkspaceRenderComponent,
} from "../../../workspace/renderer/contracts";
import type { JSONObject } from "../../../workspace/components/componentTypes";
import type { ComponentRecipe } from "../../../workspace/components/componentTypes";
import { TimerView } from "./TimerView";
import { DeclarativeRecipeView } from "./DeclarativeRecipeView";
import { VideoPlayerView } from "./VideoPlayerView";
import { WebPanelView } from "./WebPanelView";
import { DataPanelView } from "./DataPanelView";

export type WorkspaceComponentViewProps = Readonly<{
  component: WorkspaceRenderComponent;
  recipe?: ComponentRecipe;
  now?: () => number;
  onAction?: (request: ComponentActionRequest) => void;
}>;

export function WorkspaceComponentView({ component, recipe, now, onAction }: WorkspaceComponentViewProps) {
  // Host behavior is reserved for exact registered built-in IDs. A custom or
  // malformed type whose suffix resembles a built-in must never inherit the
  // built-in renderer or its privileges.
  const typeName = component.type.typeId;
  const action = (name: string, input?: JSONObject) => {
    onAction?.({ componentId: component.id, action: name, ...(input ? { input } : {}) });
  };
  if (recipe) {
    return <DeclarativeRecipeView component={component} recipe={recipe} now={now} onAction={onAction} />;
  }
  switch (typeName) {
    case "panel": return <PanelView component={component} />;
    case "text": return <TextView component={component} />;
    case "image": return <ImageView component={component} />;
    case "video-player": return <VideoPlayerView component={component} />;
    case "web-panel": return <WebPanelView component={component} />;
    case "data-panel": return <DataPanelView component={component} />;
    case "annotation": return <AnnotationView component={component} />;
    case "button": return <ButtonView component={component} onAction={action} />;
    case "timer": return <TimerView component={component} now={now} onAction={action} />;
    case "checklist": return <ChecklistView component={component} onAction={action} />;
    case "chart": return <ChartView component={component} onAction={action} />;
    case "table": return <TableView component={component} onAction={action} />;
    case "document": return <DocumentView component={component} />;
    case "group": return <GroupView component={component} />;
    default: return <UnknownComponentView component={component} />;
  }
}

function ButtonView({
  component,
  onAction,
}: {
  component: WorkspaceRenderComponent;
  onAction: (action: string, input?: JSONObject) => void;
}) {
  const label = stringValue(component.props.label) ?? component.label;
  const variant = stringValue(component.props.variant) ?? "primary";
  const pressCount = numberValue(component.durableState.pressCount, 0);
  return (
    <div className="workspace-button-component">
      <button
        type="button"
        className={`workspace-button is-${variant}`}
        disabled={component.locks.actions}
        data-press-count={pressCount}
        onClick={() => onAction("press")}
      >
        {label}
      </button>
    </div>
  );
}

export class ComponentProjectionBoundary extends Component<
  Readonly<{ component: WorkspaceRenderComponent; children: ReactNode; onError?: (error: Error) => void }>,
  Readonly<{ error?: Error }>
> {
  state: Readonly<{ error?: Error }> = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  componentDidUpdate(previous: Readonly<{ component: WorkspaceRenderComponent }>): void {
    if (this.state.error && previous.component !== this.props.component) this.setState({ error: undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="workspace-component-placeholder" role="status">
        <strong>{this.props.component.label}</strong>
        <span>This component could not be displayed. Its data is still safe.</span>
      </div>
    );
  }
}

function PanelView({ component }: { component: WorkspaceRenderComponent }) {
  const title = stringValue(component.props.title) ?? component.label;
  const style = {
    backgroundColor: colorValue(component.props.backgroundColor),
    borderColor: colorValue(component.props.borderColor),
    opacity: numberValue(component.props.opacity, 1),
    padding: `${numberValue(component.props.padding, 16)}px`,
    borderRadius: `${numberValue(component.props.radius, 12)}px`,
  };
  return (
    <section className="workspace-panel-component" style={style} aria-label={title}>
      {title && <h3>{title}</h3>}
    </section>
  );
}

function TextView({ component }: { component: WorkspaceRenderComponent }) {
  const text = stringValue(component.props.text) ?? "";
  const variant = stringValue(component.props.variant) ?? "body";
  const style = {
    color: colorValue(component.props.color),
    textAlign: alignment(component.props.align),
    whiteSpace: component.props.wrap === false ? "nowrap" as const : "pre-wrap" as const,
  };
  if (variant === "display" || variant === "heading") {
    return <h2 className={`workspace-text is-${variant}`} style={style}>{text}</h2>;
  }
  if (variant === "code") return <pre className="workspace-text is-code" style={style}><code>{text}</code></pre>;
  return <p className={`workspace-text is-${variant}`} style={style}>{text}</p>;
}

function ImageView({ component }: { component: WorkspaceRenderComponent }) {
  const rawSource = stringValue(component.props.assetRef) ?? "";
  const source = safeImageSource(rawSource);
  const alt = stringValue(component.props.alt) ?? component.label;
  const caption = stringValue(component.props.caption);
  if (!source) {
    return (
      <figure className="workspace-image workspace-component-placeholder">
        <div role="img" aria-label={alt}>Image unavailable</div>
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    );
  }
  return (
    <figure className="workspace-image">
      <img
        src={source}
        alt={alt}
        style={{
          objectFit: imageFit(component.props.fit),
          opacity: numberValue(component.props.opacity, 1),
        }}
        draggable={false}
      />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function AnnotationView({ component }: { component: WorkspaceRenderComponent }) {
  const tone = stringValue(component.props.tone) ?? "neutral";
  return (
    <aside className={`workspace-annotation is-${tone}`} aria-label={`${tone} annotation`}>
      <p>{stringValue(component.props.text) ?? ""}</p>
      {stringValue(component.props.citation) && <cite>{stringValue(component.props.citation)}</cite>}
      {component.props.resolved === true && <span className="workspace-annotation__resolved">Resolved</span>}
    </aside>
  );
}

function ChecklistView({
  component,
  onAction,
}: {
  component: WorkspaceRenderComponent;
  onAction: (action: string, input?: JSONObject) => void;
}) {
  const rawItems = Array.isArray(component.durableState.items) ? component.durableState.items : [];
  const items = rawItems.filter(isChecklistItem);
  const visibleItems = component.props.showCompleted === false ? items.filter((item) => !item.completed) : items;
  return (
    <section className="workspace-checklist" aria-label={stringValue(component.props.title) ?? component.label}>
      <h3>{stringValue(component.props.title) ?? component.label}</h3>
      {visibleItems.length === 0 ? <p className="workspace-empty-copy">Nothing on this list yet.</p> : (
        <ul>
          {visibleItems.map((item) => (
            <li key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={item.completed}
                  disabled={component.locks.actions}
                  onChange={() => onAction("toggle_item", { id: item.id })}
                />
                <span>{item.text}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChartView({
  component,
  onAction,
}: {
  component: WorkspaceRenderComponent;
  onAction: (action: string, input?: JSONObject) => void;
}) {
  const labels = stringArray(component.props.labels);
  const series = chartSeries(component.props.series);
  const chartType = chartTypeValue(component.props.chartType);
  const width = 360;
  const height = 210;
  const plot = { left: 48, right: 14, top: 14, bottom: 42 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const pointCount = Math.max(labels.length, ...series.map((entry) => entry.values.length), 0);
  const visibleIndexes = sampleIndexes(pointCount, chartType === "bar" ? 80 : 240);
  const flat = series.flatMap((entry) => entry.values);
  const domain = chartDomain(flat, chartType === "bar");
  const xFor = (index: number) => plot.left + (pointCount <= 1 ? plotWidth / 2 : index / (pointCount - 1) * plotWidth);
  const yFor = (value: number) => plot.top + (domain.max - value) / (domain.max - domain.min) * plotHeight;
  const yTicks = Array.from({ length: 5 }, (_, index) => domain.max - index / 4 * (domain.max - domain.min));
  const xTicks = sampleIndexes(pointCount, 6);
  const selectedPoint = stringValue(component.durableState.selectedPoint);
  const pieSlices = chartType === "pie" ? chartPieSlices(series[0], labels) : [];
  const interactivePoints = (chartType === "pie"
    ? pieSlices.map((slice) => ({
      id: slice.id,
      label: slice.label,
      seriesLabel: series[0]?.label ?? "Value",
      value: slice.value,
    }))
    : series.flatMap((entry) => visibleIndexes.flatMap((index) => {
      const value = entry.values[index];
      return value === undefined ? [] : [{
        id: chartPointId(entry.id, index),
        label: labels[index] ?? `Point ${index + 1}`,
        seriesLabel: entry.label,
        value,
      }];
    }))).slice(0, 500);
  const selectPoint = (pointId: string) => {
    if (!component.locks.actions) onAction("select_point", { pointId });
  };
  return (
    <figure className={`workspace-chart is-${chartType}`} aria-label={stringValue(component.props.title) ?? component.label}>
      <figcaption>
        <span>{stringValue(component.props.title) ?? component.label}</span>
        <span className="workspace-chart__domain">{formatChartNumber(domain.min)} – {formatChartNumber(domain.max)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${chartType} chart`}>
        {chartType !== "pie" && <>
          {yTicks.map((tick) => {
            const y = yFor(tick);
            return <g key={tick}>
              <line x1={plot.left} y1={y} x2={width - plot.right} y2={y} className="workspace-chart__grid" />
              <text x={plot.left - 6} y={y} textAnchor="end" dominantBaseline="middle" className="workspace-chart__tick">{formatChartNumber(tick)}</text>
            </g>;
          })}
          <line x1={plot.left} y1={plot.top} x2={plot.left} y2={height - plot.bottom} className="workspace-chart__axis" />
          <line x1={plot.left} y1={height - plot.bottom} x2={width - plot.right} y2={height - plot.bottom} className="workspace-chart__axis" />
          {xTicks.map((index) => <text
            key={index}
            x={xFor(index)}
            y={height - plot.bottom + 17}
            textAnchor="middle"
            className="workspace-chart__tick"
          >{truncateChartLabel(labels[index] ?? String(index + 1))}</text>)}
          {stringValue(component.props.xLabel) && <text x={plot.left + plotWidth / 2} y={height - 5} textAnchor="middle" className="workspace-chart__axis-label">{stringValue(component.props.xLabel)}</text>}
          {stringValue(component.props.yLabel) && <text x="10" y={plot.top + plotHeight / 2} textAnchor="middle" transform={`rotate(-90 10 ${plot.top + plotHeight / 2})`} className="workspace-chart__axis-label">{stringValue(component.props.yLabel)}</text>}
        </>}

        {(chartType === "line" || chartType === "area" || chartType === "scatter") && series.map((entry, seriesIndex) => {
          const points = visibleIndexes.flatMap((index) => entry.values[index] === undefined
            ? []
            : [{ index, value: entry.values[index]! }]);
          const pointString = points.map(({ index, value }) => `${xFor(index)},${yFor(value)}`).join(" ");
          const areaBaseline = yFor(domain.min <= 0 && domain.max >= 0 ? 0 : domain.min);
          return <g key={entry.id} data-series-index={seriesIndex}>
            {chartType === "area" && points.length > 0 && <polygon
              points={`${xFor(points[0]!.index)},${areaBaseline} ${pointString} ${xFor(points.at(-1)!.index)},${areaBaseline}`}
              fill={entry.color}
              fillOpacity="0.2"
              data-chart-mark="area"
            />}
            {chartType !== "scatter" && <polyline
              fill="none"
              stroke={entry.color}
              strokeWidth="2.5"
              points={pointString}
              data-chart-mark="line"
            />}
            {points.map(({ index, value }) => {
              const pointId = chartPointId(entry.id, index);
              return <circle
                key={pointId}
                cx={xFor(index)}
                cy={yFor(value)}
                r={selectedPoint === pointId ? 5 : chartType === "scatter" ? 3.5 : 2.5}
                fill={entry.color}
                stroke={selectedPoint === pointId ? "#FFFFFF" : "none"}
                strokeWidth="2"
                data-chart-mark="point"
                data-point-id={pointId}
                onClick={() => selectPoint(pointId)}
              ><title>{`${entry.label}, ${labels[index] ?? index + 1}: ${formatChartNumber(value)}`}</title></circle>;
            })}
          </g>;
        })}

        {chartType === "bar" && visibleIndexes.flatMap((index, visibleIndex) => {
          const groupWidth = plotWidth / Math.max(1, visibleIndexes.length);
          const barWidth = Math.max(1, groupWidth * 0.78 / Math.max(1, series.length));
          const baseline = yFor(Math.min(domain.max, Math.max(domain.min, 0)));
          return series.flatMap((entry, seriesIndex) => {
            const value = entry.values[index];
            if (value === undefined) return [];
            const y = yFor(value);
            const pointId = chartPointId(entry.id, index);
            return <rect
              key={pointId}
              x={plot.left + visibleIndex * groupWidth + groupWidth * 0.11 + seriesIndex * barWidth}
              y={Math.min(y, baseline)}
              width={barWidth}
              height={Math.max(1, Math.abs(baseline - y))}
              fill={entry.color}
              stroke={selectedPoint === pointId ? "#FFFFFF" : "none"}
              strokeWidth="2"
              data-chart-mark="bar"
              data-point-id={pointId}
              onClick={() => selectPoint(pointId)}
            ><title>{`${entry.label}, ${labels[index] ?? index + 1}: ${formatChartNumber(value)}`}</title></rect>;
          });
        })}

        {chartType === "pie" && pieSlices.map((slice) => <path
          key={slice.id}
          d={pieSlicePath(width / 2, height / 2 - 6, 70, slice.startAngle, slice.endAngle)}
          fill={slice.color}
          stroke={selectedPoint === slice.id ? "#FFFFFF" : "#111820"}
          strokeWidth={selectedPoint === slice.id ? 4 : 1.5}
          data-chart-mark="pie"
          data-point-id={slice.id}
          onClick={() => selectPoint(slice.id)}
        ><title>{`${slice.label}: ${formatChartNumber(slice.value)}`}</title></path>)}
      </svg>
      {series.length > 0 && <ul className="workspace-chart__legend" aria-label="Chart legend">
        {series.map((entry) => <li key={entry.id}><span style={{ backgroundColor: entry.color }} />{entry.label}</li>)}
      </ul>}
      {interactivePoints.length > 0 && <label className="workspace-chart__point-picker">
        <span>Selected point</span>
        <select
          aria-label="Selected chart point"
          value={interactivePoints.some(({ id }) => id === selectedPoint) ? selectedPoint : ""}
          disabled={component.locks.actions}
          onChange={(event) => { if (event.currentTarget.value) selectPoint(event.currentTarget.value); }}
        >
          <option value="">Choose a point</option>
          {interactivePoints.map((point) => <option key={point.id} value={point.id}>{point.seriesLabel} · {point.label} · {formatChartNumber(point.value)}</option>)}
        </select>
      </label>}
      <table className="workspace-chart__data">
        <caption>Chart data</caption>
        <thead><tr><th scope="col">Label</th>{series.map((entry) => <th scope="col" key={entry.id}>{entry.label}</th>)}</tr></thead>
        <tbody>{Array.from({ length: Math.min(pointCount, 500) }, (_, index) => {
          const label = labels[index] ?? `Point ${index + 1}`;
          return <tr key={`${label}-${index}`}><th scope="row">{label}</th>{series.map((entry) => <td key={entry.id}>{entry.values[index] ?? "—"}</td>)}</tr>;
        })}</tbody>
      </table>
    </figure>
  );
}

function TableView({
  component,
  onAction,
}: {
  component: WorkspaceRenderComponent;
  onAction: (action: string, input?: JSONObject) => void;
}) {
  const columns = tableColumns(component.props.columns);
  const rows = Array.isArray(component.props.rows) ? component.props.rows.filter(isRecord) : [];
  const selectedRow = stringValue(component.durableState.selectedRow);
  return (
    <div className="workspace-table-wrap">
      <table className={component.props.striped === false ? "" : "is-striped"}>
        <caption>{stringValue(component.props.title) ?? component.label}</caption>
        <thead><tr>{columns.map((column) => <th key={column.key} scope="col" style={{ textAlign: column.align }}>{column.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const rowId = stringValue(row.id) ?? `row-${rowIndex + 1}`;
            const select = () => { if (!component.locks.actions) onAction("select_row", { rowId }); };
            return <tr
              key={rowId}
              tabIndex={component.locks.actions ? -1 : 0}
              aria-selected={selectedRow === rowId}
              data-row-id={rowId}
              onClick={select}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                select();
              }}
            >
              {columns.map((column) => <td key={column.key} style={{ textAlign: column.align }}>{displayValue(row[column.key])}</td>)}
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

function DocumentView({ component }: { component: WorkspaceRenderComponent }) {
  const content = stringValue(component.props.content) ?? "";
  const lines = content.split(/\r?\n/u);
  return (
    <article className="workspace-document" aria-label={stringValue(component.props.title) ?? component.label}>
      <h2>{stringValue(component.props.title) ?? component.label}</h2>
      <div className="workspace-document__body">
        {lines.map((line, index) => line.startsWith("# ")
          ? <h3 key={index}>{line.slice(2)}</h3>
          : <p key={index}>{line || "\u00a0"}</p>)}
      </div>
    </article>
  );
}

function GroupView({ component }: { component: WorkspaceRenderComponent }) {
  return <section className={`workspace-group is-${stringValue(component.props.layout) ?? "free"}`} aria-label={component.label} />;
}

function UnknownComponentView({ component }: { component: WorkspaceRenderComponent }) {
  return (
    <div className="workspace-component-placeholder" role="status">
      <strong>{component.label}</strong>
      <span>{component.type.typeId}</span>
      <small>Projection unavailable; component data is preserved.</small>
    </div>
  );
}

type ChecklistItem = { id: string; text: string; completed: boolean };
function isChecklistItem(value: unknown): value is ChecklistItem {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.text === "string"
    && typeof value.completed === "boolean";
}

type Series = { id: string; label: string; values: number[]; color: string };
function chartSeries(value: unknown): Series[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    return [{
      id: stringValue(entry.id) ?? `series-${index}`,
      label: stringValue(entry.label) ?? `Series ${index + 1}`,
      values: Array.isArray(entry.values) ? entry.values.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [],
      color: colorValue(entry.color, chartColor(index)),
    }];
  });
}

type ChartType = "line" | "bar" | "area" | "pie" | "scatter";

function chartTypeValue(value: unknown): ChartType {
  return value === "bar" || value === "area" || value === "pie" || value === "scatter" ? value : "line";
}

function chartPointId(seriesId: string, index: number): string {
  return `${seriesId}:${index}`;
}

function sampleIndexes(length: number, limit: number): number[] {
  if (length <= 0) return [];
  if (length <= limit) return Array.from({ length }, (_, index) => index);
  const result = new Set<number>([0, length - 1]);
  for (let index = 1; index < limit - 1; index += 1) {
    result.add(Math.round(index * (length - 1) / (limit - 1)));
  }
  return [...result].sort((left, right) => left - right);
}

function chartDomain(values: readonly number[], includeZero: boolean): { min: number; max: number } {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    const padding = Math.max(1, Math.abs(min) * 0.05);
    return { min: min - padding, max: max + padding };
  }
  const padding = (max - min) * 0.08;
  return { min: min - padding, max: max + padding };
}

function formatChartNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (absolute > 0 && absolute < 0.01) return value.toExponential(1);
  return Number(value.toFixed(2)).toLocaleString("en-US");
}

function truncateChartLabel(value: string): string {
  return value.length > 10 ? `${value.slice(0, 9)}…` : value;
}

type PieSlice = {
  id: string;
  label: string;
  value: number;
  color: string;
  startAngle: number;
  endAngle: number;
};

function chartPieSlices(series: Series | undefined, labels: readonly string[]): PieSlice[] {
  if (!series) return [];
  const entries = sampleIndexes(series.values.length, 40).flatMap((index) => {
    const value = series.values[index];
    return value !== undefined && value > 0 ? [{ index, value }] : [];
  });
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0) return [];
  let cursor = -Math.PI / 2;
  return entries.map(({ index, value }) => {
    const startAngle = cursor;
    cursor += value / total * Math.PI * 2;
    return {
      id: chartPointId(series.id, index),
      label: labels[index] ?? `Point ${index + 1}`,
      value,
      color: chartColor(index),
      startAngle,
      endAngle: cursor,
    };
  });
}

function pieSlicePath(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const boundedEnd = endAngle - startAngle >= Math.PI * 2 ? endAngle - 0.00001 : endAngle;
  const startX = centerX + Math.cos(startAngle) * radius;
  const startY = centerY + Math.sin(startAngle) * radius;
  const endX = centerX + Math.cos(boundedEnd) * radius;
  const endY = centerY + Math.sin(boundedEnd) * radius;
  const largeArc = boundedEnd - startAngle > Math.PI ? 1 : 0;
  return `M ${centerX} ${centerY} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
}

type Column = { key: string; label: string; align: "left" | "center" | "right" };
function tableColumns(value: unknown): Column[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.key !== "string") return [];
    const align = entry.align === "center" || entry.align === "right" ? entry.align : "left";
    return [{ key: entry.key, label: stringValue(entry.label) ?? entry.key, align }];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return "[value]"; }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function colorValue(value: unknown, fallback = "#161B22"): string {
  return typeof value === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value) ? value : fallback;
}

function alignment(value: unknown): "left" | "center" | "right" {
  return value === "center" || value === "right" ? value : "left";
}

function imageFit(value: unknown): "contain" | "cover" | "fill" | "none" {
  return value === "cover" || value === "fill" || value === "none" ? value : "contain";
}

function safeImageSource(value: string): string | undefined {
  // Remote URLs must first pass through the host connector/asset broker. A
  // declarative component never receives ambient network authority merely by
  // placing a URL in props.
  if (/^(?:data:image\/(?:png|jpeg|gif|webp);base64,|blob:|\/)/iu.test(value)) return value;
  return undefined;
}

function chartColor(index: number): string {
  return ["#68D5FF", "#FFB86B", "#9FE870", "#C9A7FF", "#FF7D9C"][index % 5]!;
}
