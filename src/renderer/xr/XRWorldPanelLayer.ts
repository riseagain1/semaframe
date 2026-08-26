import * as THREE from "three";
import type {
  XRPanelPresentation,
  XRPanelTypedAction,
} from "../../xr/panels";
import { isXRPanelPresentation } from "../../xr/panels";

export type ThreeRendererXRWorldPanelTransform = Readonly<{
  position: Readonly<{ x: number; y: number; z: number }>;
  rotation: Readonly<{ x: number; y: number; z: number }>;
  scale: Readonly<{ x: number; y: number; z: number }>;
}>;

/**
 * Renderer-side structural copy of the standalone viewer DTO. Keeping this
 * boundary independent from `xr/app` prevents the low-level renderer from
 * importing a React application module.
 */
export type ThreeRendererXRWorldPanel = Readonly<{
  format: "semaframe-xr-world-panel";
  version: "1.0";
  rendererNeutral: true;
  workspaceRevision: number;
  sourcePlacementSpace: string;
  transform: ThreeRendererXRWorldPanelTransform;
  panel: XRPanelPresentation;
}>;

export type ThreeRendererXRPanelAction = Readonly<{
  panelId: string;
  componentId: string;
  workspaceRevision: number;
  action: XRPanelTypedAction;
}>;

export type ThreeRendererXRPanelWarning = Readonly<{
  code: "invalid_panel" | "panel_limit" | "stale_revision";
  message: string;
  panelId?: string;
  componentId?: string;
}>;

export type XRWorldPanelLayerOptions = Readonly<{
  document?: Document;
  maxPanels?: number;
  createCanvas?: () => HTMLCanvasElement;
  onAction?: (event: ThreeRendererXRPanelAction) => void;
  onWarning?: (warning: ThreeRendererXRPanelWarning) => void;
}>;

type ManagedPanel = {
  value: ThreeRendererXRWorldPanel;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  visualDigest: string;
  widthM: number;
  heightM: number;
};

const DEFAULT_MAX_PANELS = 64;
const MAX_TITLE_CHARACTERS = 160;
const MAX_TEXT_CHARACTERS = 2_048;
const MAX_CHART_SERIES = 8;
const MAX_CHART_POINTS_PER_SERIES = 512;
const CANVAS_HEIGHT = 384;
const MIN_CANVAS_WIDTH = 256;
const MAX_CANVAS_WIDTH = 768;
const MIN_PANEL_WIDTH_M = 0.2;
const MAX_PANEL_WIDTH_M = 2.4;
const MIN_PANEL_HEIGHT_M = 0.12;
const MAX_PANEL_HEIGHT_M = 1.6;
const MIN_PANEL_SCALE = 0.05;
const MAX_PANEL_SCALE = 20;

/**
 * GPU-managed CanvasTexture panel layer shared by the desktop renderer and
 * the standalone headset viewer. It owns no Workspace state; callers replace
 * its immutable projection whenever the authority revision advances.
 */
export class XRWorldPanelLayer {
  readonly worldRoot = new THREE.Group();
  readonly viewerRoot = new THREE.Group();

  private readonly options: XRWorldPanelLayerOptions;
  private readonly maxPanels: number;
  private readonly entries = new Map<string, ManagedPanel>();
  private activeWorkspaceRevision: number | undefined;
  private visible = false;
  private disposed = false;

  constructor(options: XRWorldPanelLayerOptions = {}) {
    this.options = options;
    const requestedMax = Number.isFinite(options.maxPanels)
      ? Math.floor(options.maxPanels as number)
      : DEFAULT_MAX_PANELS;
    this.maxPanels = Math.max(1, Math.min(DEFAULT_MAX_PANELS, requestedMax));
    this.worldRoot.name = "semaframe-xr-world-panels";
    this.viewerRoot.name = "semaframe-xr-viewer-panels";
    this.worldRoot.visible = false;
    this.viewerRoot.visible = false;
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    this.worldRoot.visible = visible;
    this.viewerRoot.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  getPanelCount(): number {
    return this.entries.size;
  }

  getActiveWorkspaceRevision(): number | undefined {
    return this.activeWorkspaceRevision;
  }

  /** Exposed for renderer diagnostics and deterministic unit tests. */
  getPanelObject(panelId: string): THREE.Mesh | undefined {
    return this.entries.get(panelId)?.mesh;
  }

  setPanels(
    panels: readonly ThreeRendererXRWorldPanel[],
    workspaceRevision?: number,
  ): void {
    if (this.disposed) throw new Error("XRWorldPanelLayer has been disposed");
    this.activeWorkspaceRevision = resolveWorkspaceRevision(panels, workspaceRevision);
    const seen = new Set<string>();
    const accepted = panels.slice(0, this.maxPanels);
    if (panels.length > this.maxPanels) {
      this.warn({
        code: "panel_limit",
        message: `XR panel projection was bounded to ${this.maxPanels} panels.`,
      });
    }

    for (const value of accepted) {
      const panelId = value?.panel?.panelId;
      if (!isValidPanel(value) || seen.has(panelId)) {
        this.warn({
          code: "invalid_panel",
          message: seen.has(panelId)
            ? `Duplicate XR panel id ${panelId} was ignored.`
            : "An invalid XR world panel projection was ignored.",
          ...(typeof panelId === "string" ? { panelId } : {}),
          ...(typeof value?.panel?.componentId === "string" ? { componentId: value.panel.componentId } : {}),
        });
        continue;
      }
      seen.add(panelId);
      const dimensions = boundedDimensions(value.panel);
      const visualDigest = stableVisualDigest(value.panel, dimensions);
      const current = this.entries.get(panelId);
      if (!current) {
        const created = this.createPanel(value, dimensions.widthM, dimensions.heightM, visualDigest);
        this.entries.set(panelId, created);
        this.parentFor(value).add(created.mesh);
        continue;
      }

      current.value = value;
      const expectedParent = this.parentFor(value);
      if (current.mesh.parent !== expectedParent) expectedParent.add(current.mesh);
      applyTransform(current.mesh, value.transform);
      if (current.widthM !== dimensions.widthM || current.heightM !== dimensions.heightM) {
        current.mesh.geometry.dispose();
        current.mesh.geometry = new THREE.PlaneGeometry(dimensions.widthM, dimensions.heightM);
        current.widthM = dimensions.widthM;
        current.heightM = dimensions.heightM;
        resizeCanvas(current.canvas, dimensions.widthM, dimensions.heightM);
      }
      if (current.visualDigest !== visualDigest) {
        drawPanel(current.canvas, value.panel);
        current.texture.needsUpdate = true;
        current.visualDigest = visualDigest;
      }
    }

    for (const [panelId, entry] of this.entries) {
      if (seen.has(panelId)) continue;
      this.disposePanel(entry);
      this.entries.delete(panelId);
    }
    this.worldRoot.updateMatrixWorld(true);
    this.viewerRoot.updateMatrixWorld(true);
  }

  /**
   * Returns true whenever a panel was hit, including labels, disabled buttons,
   * and stale buttons. This lets the renderer consume the ray before any world
   * entity or teleport target behind the panel can receive it.
   */
  activateFirstHit(raycaster: THREE.Raycaster): boolean {
    if (this.disposed || !this.visible || this.entries.size === 0) return false;
    this.worldRoot.updateMatrixWorld(true);
    this.viewerRoot.updateMatrixWorld(true);
    const meshes = [...this.entries.values()].map(({ mesh }) => mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return false;
    const panelId = hit.object.userData.xrPanelId;
    const entry = typeof panelId === "string" ? this.entries.get(panelId) : undefined;
    if (!entry) return true;
    const presentation = entry.value.panel;
    if (presentation.kind !== "button" || presentation.content.state !== "enabled") return true;

    const expectedRevision = presentation.content.action.expectedWorkspaceRevision;
    const panelRevision = entry.value.workspaceRevision;
    if (this.activeWorkspaceRevision === undefined
      || expectedRevision !== panelRevision
      || panelRevision !== this.activeWorkspaceRevision) {
      this.warn({
        code: "stale_revision",
        panelId: presentation.panelId,
        componentId: presentation.componentId,
        message: `XR panel action was ignored because revision ${expectedRevision} does not match the active Workspace revision ${this.activeWorkspaceRevision ?? "unknown"}.`,
      });
      return true;
    }
    this.options.onAction?.(Object.freeze({
      panelId: presentation.panelId,
      componentId: presentation.componentId,
      workspaceRevision: panelRevision,
      action: presentation.content.action,
    }));
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) this.disposePanel(entry);
    this.entries.clear();
    this.worldRoot.removeFromParent();
    this.viewerRoot.removeFromParent();
    this.worldRoot.clear();
    this.viewerRoot.clear();
    this.activeWorkspaceRevision = undefined;
    this.visible = false;
  }

  private createPanel(
    value: ThreeRendererXRWorldPanel,
    widthM: number,
    heightM: number,
    visualDigest: string,
  ): ManagedPanel {
    const canvas = this.createCanvas();
    resizeCanvas(canvas, widthM, heightM);
    drawPanel(canvas, value.panel);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), material);
    mesh.name = `xr-panel:${value.panel.panelId}`;
    mesh.renderOrder = 10_000;
    mesh.userData.xrPanelId = value.panel.panelId;
    applyTransform(mesh, value.transform);
    return { value, mesh, canvas, texture, visualDigest, widthM, heightM };
  }

  private createCanvas(): HTMLCanvasElement {
    if (this.options.createCanvas) return this.options.createCanvas();
    const ownerDocument = this.options.document ?? globalThis.document;
    if (!ownerDocument) throw new Error("XR world panels require a Canvas document");
    return ownerDocument.createElement("canvas");
  }

  private parentFor(value: ThreeRendererXRWorldPanel): THREE.Group {
    return value.sourcePlacementSpace === "world3d" ? this.worldRoot : this.viewerRoot;
  }

  private disposePanel(entry: ManagedPanel): void {
    entry.mesh.removeFromParent();
    entry.mesh.geometry.dispose();
    entry.texture.dispose();
    entry.mesh.material.dispose();
    // Resetting the backing store releases the potentially large CPU bitmap.
    entry.canvas.width = 1;
    entry.canvas.height = 1;
  }

  private warn(warning: ThreeRendererXRPanelWarning): void {
    this.options.onWarning?.(Object.freeze(warning));
  }
}

function resolveWorkspaceRevision(
  panels: readonly ThreeRendererXRWorldPanel[],
  explicit: number | undefined,
): number | undefined {
  if (Number.isSafeInteger(explicit) && (explicit ?? -1) >= 0) return explicit;
  const revisions = new Set(panels
    .map(({ workspaceRevision }) => workspaceRevision)
    .filter((revision) => Number.isSafeInteger(revision) && revision >= 0));
  return revisions.size === 1 ? revisions.values().next().value : undefined;
}

function isValidPanel(value: ThreeRendererXRWorldPanel | undefined): value is ThreeRendererXRWorldPanel {
  if (!value || value.format !== "semaframe-xr-world-panel" || value.version !== "1.0"
    || value.rendererNeutral !== true || !Number.isSafeInteger(value.workspaceRevision)
    || value.workspaceRevision < 0 || !value.panel || typeof value.panel.panelId !== "string"
    || value.panel.panelId.length === 0 || value.panel.panelId.length > 256
    || typeof value.panel.componentId !== "string" || value.panel.componentId.length === 0
    || !finiteTransform(value.transform) || !isXRPanelPresentation(value.panel)) return false;
  return true;
}

function finiteTransform(transform: ThreeRendererXRWorldPanelTransform): boolean {
  return [
    transform?.position?.x, transform?.position?.y, transform?.position?.z,
    transform?.rotation?.x, transform?.rotation?.y, transform?.rotation?.z,
    transform?.scale?.x, transform?.scale?.y, transform?.scale?.z,
  ].every((value) => typeof value === "number" && Number.isFinite(value));
}

function applyTransform(mesh: THREE.Object3D, transform: ThreeRendererXRWorldPanelTransform): void {
  mesh.position.set(transform.position.x, transform.position.y, transform.position.z);
  mesh.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z, "XYZ");
  mesh.scale.set(
    clampScale(transform.scale.x),
    clampScale(transform.scale.y),
    clampScale(transform.scale.z),
  );
  mesh.updateMatrixWorld(true);
}

function clampScale(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * THREE.MathUtils.clamp(Math.abs(value), MIN_PANEL_SCALE, MAX_PANEL_SCALE);
}

function boundedDimensions(panel: XRPanelPresentation): Readonly<{ widthM: number; heightM: number }> {
  return {
    widthM: THREE.MathUtils.clamp(panel.dimensions.widthM, MIN_PANEL_WIDTH_M, MAX_PANEL_WIDTH_M),
    heightM: THREE.MathUtils.clamp(panel.dimensions.heightM, MIN_PANEL_HEIGHT_M, MAX_PANEL_HEIGHT_M),
  };
}

function resizeCanvas(canvas: HTMLCanvasElement, widthM: number, heightM: number): void {
  canvas.height = CANVAS_HEIGHT;
  canvas.width = Math.round(THREE.MathUtils.clamp(
    CANVAS_HEIGHT * widthM / heightM,
    MIN_CANVAS_WIDTH,
    MAX_CANVAS_WIDTH,
  ));
}

function stableVisualDigest(
  panel: XRPanelPresentation,
  dimensions: Readonly<{ widthM: number; heightM: number }>,
): string {
  const content = panel.kind === "text"
    ? { text: panel.content.text.slice(0, MAX_TEXT_CHARACTERS), tone: panel.content.tone }
    : panel.kind === "number"
      ? {
          formattedValue: panel.content.formattedValue.slice(0, 80),
          unit: panel.content.unit?.slice(0, 32),
          trend: panel.content.trend,
        }
      : panel.kind === "button"
        ? { label: panel.content.label.slice(0, 120), state: panel.content.state }
        : {
            xLabel: panel.content.xLabel?.slice(0, 80),
            yLabel: panel.content.yLabel?.slice(0, 80),
            series: panel.content.series.slice(0, MAX_CHART_SERIES).map((series) => ({
              id: series.id.slice(0, 128),
              label: series.label.slice(0, 128),
              color: series.color?.slice(0, 32),
              points: series.points.slice(0, MAX_CHART_POINTS_PER_SERIES).flatMap((point) => (
                Number.isFinite(point.x) && Number.isFinite(point.y)
                  ? [{ x: point.x, y: point.y }]
                  : []
              )),
            })),
          };
  return stableStringify({
    panelId: panel.panelId,
    kind: panel.kind,
    title: panel.title?.slice(0, MAX_TITLE_CHARACTERS),
    dimensions,
    content,
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function drawPanel(canvas: HTMLCanvasElement, panel: XRPanelPresentation): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  const palette = panelPalette(panel);
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = palette.border;
  context.lineWidth = Math.max(2, height * 0.008);
  context.strokeRect(context.lineWidth / 2, context.lineWidth / 2, width - context.lineWidth, height - context.lineWidth);

  const padding = Math.round(height * 0.075);
  let contentTop = padding;
  if (panel.title) {
    context.fillStyle = "#a9b4c6";
    context.font = `600 ${Math.round(height * 0.055)}px system-ui, sans-serif`;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(panel.title.slice(0, MAX_TITLE_CHARACTERS), padding, padding, width - padding * 2);
    contentTop += Math.round(height * 0.1);
  }

  context.fillStyle = palette.foreground;
  if (panel.kind === "text") drawTextPanel(context, panel, width, height, padding, contentTop);
  else if (panel.kind === "number") drawNumberPanel(context, panel, width, height, padding, contentTop);
  else if (panel.kind === "button") drawButtonPanel(context, panel, width, height, padding, contentTop);
  else drawChartPanel(context, panel, width, height, padding, contentTop);
}

function panelPalette(panel: XRPanelPresentation): Readonly<{
  background: string;
  foreground: string;
  border: string;
  accent: string;
}> {
  if (panel.kind === "button" && panel.content.state !== "enabled") return {
    background: "#222832",
    foreground: "#8c96a6",
    border: "#4b5564",
    accent: "#4b5564",
  };
  if (panel.kind === "text" && panel.content.tone === "danger") return {
    background: "#291a1f",
    foreground: "#ffd6dc",
    border: "#e85c70",
    accent: "#e85c70",
  };
  if (panel.kind === "text" && panel.content.tone === "warning") return {
    background: "#2b2417",
    foreground: "#ffe5ad",
    border: "#e6a94a",
    accent: "#e6a94a",
  };
  if (panel.kind === "text" && panel.content.tone === "success") return {
    background: "#152821",
    foreground: "#c8ffe3",
    border: "#45d49b",
    accent: "#45d49b",
  };
  return {
    background: "#111720",
    foreground: "#f4f8ff",
    border: "#627188",
    accent: "#68d5ff",
  };
}

function drawTextPanel(
  context: CanvasRenderingContext2D,
  panel: Extract<XRPanelPresentation, { kind: "text" }>,
  width: number,
  height: number,
  padding: number,
  contentTop: number,
): void {
  const fontSize = Math.round(height * 0.075);
  context.font = `500 ${fontSize}px system-ui, sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "top";
  const lineHeight = Math.round(fontSize * 1.35);
  const maxLines = Math.max(1, Math.floor((height - contentTop - padding) / lineHeight));
  const lines = wrapText(context, panel.content.text.slice(0, MAX_TEXT_CHARACTERS), width - padding * 2, maxLines);
  lines.forEach((line, index) => context.fillText(line, padding, contentTop + index * lineHeight));
}

function drawNumberPanel(
  context: CanvasRenderingContext2D,
  panel: Extract<XRPanelPresentation, { kind: "number" }>,
  width: number,
  height: number,
  padding: number,
  contentTop: number,
): void {
  const trend = panel.content.trend === "up" ? "↗" : panel.content.trend === "down" ? "↘" : "→";
  context.font = `700 ${Math.round(height * 0.18)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const unit = panel.content.unit?.slice(0, 32) ?? "";
  const value = `${panel.content.formattedValue.slice(0, 80)}${unit ? ` ${unit}` : ""}`;
  context.fillText(value, width / 2, contentTop + (height - contentTop - padding) * 0.43, width - padding * 2);
  context.font = `600 ${Math.round(height * 0.085)}px system-ui, sans-serif`;
  context.fillStyle = panel.content.trend === "down" ? "#ff8fa0" : panel.content.trend === "up" ? "#75e8ba" : "#a9b4c6";
  context.fillText(trend, width / 2, height - padding * 1.25);
}

function drawButtonPanel(
  context: CanvasRenderingContext2D,
  panel: Extract<XRPanelPresentation, { kind: "button" }>,
  width: number,
  height: number,
  padding: number,
  contentTop: number,
): void {
  const enabled = panel.content.state === "enabled";
  const left = padding;
  const top = contentTop;
  const buttonWidth = width - padding * 2;
  const buttonHeight = height - top - padding;
  context.fillStyle = enabled ? "#167da3" : "#38414e";
  roundedRect(context, left, top, buttonWidth, buttonHeight, Math.min(28, buttonHeight * 0.18));
  context.fill();
  context.strokeStyle = enabled ? "#8be7ff" : "#5c6674";
  context.lineWidth = Math.max(2, height * 0.01);
  context.stroke();
  context.fillStyle = enabled ? "#ffffff" : "#9da6b3";
  context.font = `700 ${Math.round(height * 0.1)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(panel.content.label.slice(0, 120), width / 2, top + buttonHeight / 2, buttonWidth - padding);
}

function drawChartPanel(
  context: CanvasRenderingContext2D,
  panel: Extract<XRPanelPresentation, { kind: "chart" }>,
  width: number,
  height: number,
  padding: number,
  contentTop: number,
): void {
  const left = padding * 1.5;
  const right = width - padding;
  const top = contentTop + padding * 0.2;
  const bottom = height - padding * 1.25;
  context.strokeStyle = "#5c687a";
  context.lineWidth = Math.max(1, height * 0.005);
  context.beginPath();
  context.moveTo(left, top);
  context.lineTo(left, bottom);
  context.lineTo(right, bottom);
  context.stroke();

  const series = panel.content.series.slice(0, MAX_CHART_SERIES).map((entry) => ({
    ...entry,
    points: entry.points.slice(0, MAX_CHART_POINTS_PER_SERIES)
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
  })).filter((entry) => entry.points.length > 0);
  const points = series.flatMap((entry) => entry.points);
  if (points.length > 0) {
    const minX = Math.min(...points.map(({ x }) => x));
    const maxX = Math.max(...points.map(({ x }) => x));
    const minY = Math.min(...points.map(({ y }) => y));
    const maxY = Math.max(...points.map(({ y }) => y));
    const spanX = Math.max(1e-9, maxX - minX);
    const spanY = Math.max(1e-9, maxY - minY);
    series.forEach((entry, index) => {
      context.beginPath();
      context.strokeStyle = safeChartColor(entry.color, index);
      context.lineWidth = Math.max(2, height * 0.009);
      entry.points.forEach((point, pointIndex) => {
        const x = left + (point.x - minX) / spanX * (right - left);
        const y = bottom - (point.y - minY) / spanY * (bottom - top);
        if (pointIndex === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    });
  }
  context.font = `500 ${Math.round(height * 0.045)}px system-ui, sans-serif`;
  context.fillStyle = "#a9b4c6";
  context.textBaseline = "bottom";
  context.textAlign = "right";
  if (panel.content.xLabel) context.fillText(panel.content.xLabel.slice(0, 80), right, height - padding * 0.15);
  context.save();
  context.translate(padding * 0.45, top);
  context.rotate(-Math.PI / 2);
  context.textAlign = "right";
  if (panel.content.yLabel) context.fillText(panel.content.yLabel.slice(0, 80), 0, 0);
  context.restore();
}

function wrapText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1]?.slice(0, -1) ?? ""}…`;
  }
  return lines;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function safeChartColor(value: string | undefined, index: number): string {
  if (value && value.length <= 32 && (/^#[0-9a-f]{3,8}$/iu.test(value)
    || /^(?:rgb|hsl)a?\([\d\s.,%+-]+\)$/iu.test(value))) return value;
  return ["#68d5ff", "#ffb45e", "#75e8ba", "#d49bff", "#ff7890", "#f3e36d"][index % 6] ?? "#68d5ff";
}
