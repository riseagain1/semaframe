import type { XRPanelTypedAction } from "../panels";
import type { XrWorldPanelPresentation } from "./contracts";

export type XrPanelFallbackProps = Readonly<{
  panels: readonly XrWorldPanelPresentation[];
  onAction(action: XRPanelTypedAction, panelId: string): void;
}>;

const cardStyle = {
  border: "1px solid rgba(151, 176, 205, 0.28)",
  borderRadius: 14,
  background: "rgba(10, 18, 29, 0.92)",
  color: "#f4f8fc",
  padding: 14,
  minWidth: 220,
} as const;

function chartPoints(series: readonly Readonly<{ x: number; y: number }>[]): string {
  if (!series.length) return "";
  const xs = series.map(({ x }) => x);
  const ys = series.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return series.map(({ x, y }) => {
    const px = maxX === minX ? 50 : 4 + ((x - minX) / (maxX - minX)) * 92;
    const py = maxY === minY ? 25 : 46 - ((y - minY) / (maxY - minY)) * 42;
    return `${px},${py}`;
  }).join(" ");
}

export function XrPanelFallback({ panels, onAction }: XrPanelFallbackProps) {
  if (!panels.length) return <p style={{ color: "#9eb0c3", margin: 0 }}>No compatible panels in this revision.</p>;
  return <div style={{ display: "grid", gap: 10 }}>
    {panels.map(({ panel }) => <article
      key={panel.panelId}
      style={cardStyle}
      aria-label={panel.accessibilityLabel}
      data-xr-world-panel={panel.panelId}
      data-xr-panel-kind={panel.kind}
    >
      {panel.title && <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "#9eb0c3" }}>{panel.title}</h3>}
      {panel.kind === "text" && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{panel.content.text}</p>}
      {panel.kind === "number" && <p style={{ margin: 0, fontSize: 28, fontVariantNumeric: "tabular-nums" }}>
        {panel.content.formattedValue}{panel.content.unit ? ` ${panel.content.unit}` : ""}
        <span aria-label={`trend ${panel.content.trend}`} style={{ fontSize: 14, marginLeft: 8, color: "#9eb0c3" }}>
          {panel.content.trend === "up" ? "↑" : panel.content.trend === "down" ? "↓" : "→"}
        </span>
      </p>}
      {panel.kind === "button" && <button
        type="button"
        disabled={panel.content.state !== "enabled"}
        onClick={() => onAction(panel.content.action, panel.panelId)}
        style={{
          border: 0,
          borderRadius: 10,
          background: "#6ae4ff",
          color: "#061018",
          fontWeight: 700,
          padding: "10px 14px",
          cursor: panel.content.state === "enabled" ? "pointer" : "not-allowed",
        }}
      >{panel.content.label}</button>}
      {panel.kind === "chart" && <figure style={{ margin: 0 }}>
        <svg viewBox="0 0 100 50" role="img" aria-label={`${panel.accessibilityLabel} chart`} style={{ width: "100%", minHeight: 90 }}>
          <line x1="4" y1="46" x2="96" y2="46" stroke="rgba(255,255,255,.25)" />
          <line x1="4" y1="4" x2="4" y2="46" stroke="rgba(255,255,255,.25)" />
          {panel.content.series.map((series, index) => <polyline
            key={series.id}
            fill="none"
            stroke={series.color ?? ["#6ae4ff", "#be8cff", "#7ce6a3", "#ffc66d"][index % 4]}
            strokeWidth="2"
            points={chartPoints(series.points)}
          />)}
        </svg>
        <figcaption style={{ display: "flex", flexWrap: "wrap", gap: 8, color: "#9eb0c3", fontSize: 12 }}>
          {panel.content.series.map((series) => <span key={series.id}>{series.label}</span>)}
        </figcaption>
      </figure>}
    </article>)}
  </div>;
}
