import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type {
  ComponentRecipe,
  ComponentRecipeNode,
  JSONObject,
  JSONValue,
} from "../../../workspace/components/componentTypes";
import {
  formatTimer,
  projectTimer,
} from "../../../workspace/renderer/timerProjection";
import type {
  ComponentActionRequest,
  WorkspaceRenderComponent,
} from "../../../workspace/renderer/contracts";

// These intentionally mirror the protocol validation limits. The renderer
// repeats them because loaded state and extension adapters are untrusted too.
export const MAX_RENDERED_RECIPE_NODES = 256;
export const MAX_RENDERED_RECIPE_DEPTH = 16;

export class RecipeProjectionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "RecipeProjectionError";
  }
}

export type DeclarativeRecipeViewProps = Readonly<{
  component: WorkspaceRenderComponent;
  recipe: ComponentRecipe;
  now?: () => number;
  onAction?: (request: ComponentActionRequest) => void;
}>;

type RenderContext = {
  component: WorkspaceRenderComponent;
  recipe: ComponentRecipe;
  now: () => number;
  onAction?: (request: ComponentActionRequest) => void;
  count: number;
  active: Set<ComponentRecipeNode>;
};

/** Renders the closed, data-only recipe vocabulary. No HTML/code evaluation occurs. */
export function DeclarativeRecipeView({
  component,
  recipe,
  now = Date.now,
  onAction,
}: DeclarativeRecipeViewProps) {
  const context: RenderContext = {
    component,
    recipe,
    now,
    onAction,
    count: 0,
    active: new Set(),
  };
  return (
    <section
      className="workspace-recipe"
      aria-label={`${component.label}, ${recipe.displayName}`}
      data-workspace-recipe={recipe.typeId}
    >
      {renderRecipeNode(recipe.root, 1, context)}
    </section>
  );
}

function renderRecipeNode(node: ComponentRecipeNode, depth: number, context: RenderContext): ReactNode {
  context.count += 1;
  if (context.count > MAX_RENDERED_RECIPE_NODES) {
    throw new RecipeProjectionError(`Recipe exceeds ${MAX_RENDERED_RECIPE_NODES} render nodes.`, "recipe_too_many_nodes");
  }
  if (depth > MAX_RENDERED_RECIPE_DEPTH) {
    throw new RecipeProjectionError(`Recipe exceeds render depth ${MAX_RENDERED_RECIPE_DEPTH}.`, "recipe_too_deep");
  }
  if (context.active.has(node)) {
    throw new RecipeProjectionError("Recipe contains a cyclic node graph.", "cyclic_recipe");
  }
  context.active.add(node);
  try {
    const props = resolveNodeProps(node.props ?? {}, context.component);
    const children = (node.children ?? []).map((child, index) => (
      <RecipeNodeKey key={`${child.id}:${index}`}>
        {renderRecipeNode(child, depth + 1, context)}
      </RecipeNodeKey>
    ));
    const attributes = {
      "data-recipe-node-id": node.id,
      "data-recipe-primitive": node.primitive,
    };

    switch (node.primitive) {
      case "stack":
        return <div {...attributes} className="workspace-recipe-stack" style={stackStyle(props)}>{children}</div>;
      case "grid":
        return <div {...attributes} className="workspace-recipe-grid" style={gridStyle(props)}>{children}</div>;
      case "overlay":
        return <div {...attributes} className="workspace-recipe-overlay">{children}</div>;
      case "scroll":
        return <div {...attributes} className="workspace-recipe-scroll" tabIndex={0}>{children}</div>;
      case "text":
        return <RecipeText attributes={attributes} props={props} />;
      case "shape":
        return <div {...attributes} className="workspace-recipe-shape" role="img" aria-label={text(props.label, "Decorative shape")} style={shapeStyle(props)}>{children}</div>;
      case "image":
        return <RecipeImage attributes={attributes} props={props} />;
      case "icon":
        return <RecipeIcon attributes={attributes} props={props} />;
      case "chart":
        return <RecipeChart attributes={attributes} props={props} />;
      case "table":
        return <RecipeTable attributes={attributes} props={props} />;
      case "asset3d":
        // A nested asset request is represented safely in the DOM recipe. The
        // hybrid host may replace this with a registry-approved projection;
        // the recipe itself never receives a loader, shader, or WebGL handle.
        return <div {...attributes} className="workspace-recipe-asset3d" role="img" aria-label={text(props.alt, text(props.label, "3D asset"))}><span aria-hidden="true">◇</span><small>{text(props.label, text(props.assetRef, "3D asset"))}</small></div>;
      case "button":
        return <RecipeButton attributes={attributes} props={props} context={context} />;
      case "slider":
        return <RecipeSlider attributes={attributes} props={props} context={context} />;
      case "toggle":
        return <RecipeToggle attributes={attributes} props={props} context={context} />;
      case "input":
        return <RecipeInput attributes={attributes} props={props} context={context} />;
      case "timer":
        return <RecipeTimer attributes={attributes} props={props} context={context} />;
      default:
        throw new RecipeProjectionError(`Unsupported recipe primitive: ${String(node.primitive)}`, "unsupported_recipe_primitive");
    }
  } finally {
    context.active.delete(node);
  }
}

function RecipeNodeKey({ children }: { children: ReactNode }) {
  return children;
}

function RecipeText({ attributes, props }: PrimitiveProps) {
  const value = text(props.text, "");
  const level = integer(props.level, 0, 6);
  if (level === 1) return <h1 {...attributes} className="workspace-recipe-text">{value}</h1>;
  if (level === 2) return <h2 {...attributes} className="workspace-recipe-text">{value}</h2>;
  if (level === 3) return <h3 {...attributes} className="workspace-recipe-text">{value}</h3>;
  if (level === 4) return <h4 {...attributes} className="workspace-recipe-text">{value}</h4>;
  if (level === 5) return <h5 {...attributes} className="workspace-recipe-text">{value}</h5>;
  if (level === 6) return <h6 {...attributes} className="workspace-recipe-text">{value}</h6>;
  return <p {...attributes} className="workspace-recipe-text">{value}</p>;
}

function RecipeImage({ attributes, props }: PrimitiveProps) {
  const source = safeAssetSource(text(props.assetRef, text(props.src, "")));
  const alt = text(props.alt, "");
  if (!source) return <div {...attributes} className="workspace-recipe-image is-missing" role="img" aria-label={alt || "Image unavailable"}>Image unavailable</div>;
  return <img {...attributes} className="workspace-recipe-image" src={source} alt={alt} draggable={false} />;
}

const SAFE_ICONS: Readonly<Record<string, string>> = Object.freeze({
  check: "✓", alert: "!", info: "i", clock: "◷", play: "▶", pause: "Ⅱ",
  stop: "■", star: "★", heart: "♥", location: "⌖", search: "⌕", spark: "✦",
});

function RecipeIcon({ attributes, props }: PrimitiveProps) {
  const name = text(props.name, "spark").toLowerCase();
  return <span {...attributes} className="workspace-recipe-icon" role="img" aria-label={text(props.label, name)}>{SAFE_ICONS[name] ?? SAFE_ICONS.spark}</span>;
}

function RecipeButton({ attributes, props, context }: ControlProps) {
  const action = text(props.action, "");
  const declared = isDeclaredAction(context.recipe, action);
  return (
    <button
      {...attributes}
      type="button"
      className="workspace-recipe-button"
      disabled={!declared || props.disabled === true || context.component.locks.actions === true}
      title={!declared && action ? `Action “${action}” is not declared by this component.` : undefined}
      onClick={() => emitAction(context, action, objectValue(props.actionInput))}
    >
      {text(props.label, "Action")}
    </button>
  );
}

function RecipeSlider({ attributes, props, context }: ControlProps) {
  const action = text(props.action, text(props.onChangeAction, ""));
  const declared = isDeclaredAction(context.recipe, action);
  const min = number(props.min, 0);
  const max = Math.max(min, number(props.max, 100));
  const value = clamp(number(props.value, min), min, max);
  const valueKey = safeInputKey(text(props.valueKey, "value"));
  const id = `${context.component.id}-${String(attributes["data-recipe-node-id"])}-slider`;
  return (
    <label {...attributes} className="workspace-recipe-control" htmlFor={id}>
      <span>{text(props.label, "Value")}</span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={Math.max(0.0001, number(props.step, 1))}
        value={value}
        disabled={!declared || props.disabled === true || context.component.locks.actions === true}
        onChange={(event) => emitAction(context, action, { ...objectValue(props.actionInput), [valueKey]: Number(event.currentTarget.value) })}
      />
    </label>
  );
}

function RecipeToggle({ attributes, props, context }: ControlProps) {
  const action = text(props.action, text(props.onChangeAction, ""));
  const declared = isDeclaredAction(context.recipe, action);
  const valueKey = safeInputKey(text(props.valueKey, "value"));
  return (
    <label {...attributes} className="workspace-recipe-control">
      <input
        type="checkbox"
        role="switch"
        checked={props.value === true || props.checked === true}
        disabled={!declared || props.disabled === true || context.component.locks.actions === true}
        onChange={(event) => emitAction(context, action, { ...objectValue(props.actionInput), [valueKey]: event.currentTarget.checked })}
      />
      <span>{text(props.label, "Toggle")}</span>
    </label>
  );
}

function RecipeInput({ attributes, props, context }: ControlProps) {
  const initial = text(props.value, "");
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const action = text(props.action, text(props.submitAction, ""));
  const declared = isDeclaredAction(context.recipe, action);
  const valueKey = safeInputKey(text(props.valueKey, "value"));
  const submit = () => emitAction(context, action, { ...objectValue(props.actionInput), [valueKey]: value });
  return (
    <label {...attributes} className="workspace-recipe-control">
      <span>{text(props.label, "Input")}</span>
      <input
        type={props.inputType === "number" ? "number" : "text"}
        value={value}
        placeholder={text(props.placeholder, "")}
        maxLength={Math.trunc(clamp(number(props.maxLength, 1_000), 1, 10_000))}
        disabled={!declared || props.disabled === true || context.component.locks.actions === true}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        onBlur={() => { if (props.submitOnBlur === true) submit(); }}
      />
    </label>
  );
}

function RecipeTimer({ attributes, props, context }: ControlProps) {
  const [observedAt, setObservedAt] = useState(context.now);
  const projection = useMemo(() => projectTimer({
    props,
    durableState: context.component.durableState,
    nowMs: observedAt,
  }), [context.component.durableState, observedAt, props]);
  useEffect(() => {
    if (projection.phase !== "running") return;
    const interval = window.setInterval(() => setObservedAt(context.now()), 250);
    return () => window.clearInterval(interval);
  }, [context, projection.phase, projection.runGeneration]);
  const action = projection.phase === "running" ? "pause"
    : projection.phase === "paused" ? "resume"
      : projection.phase === "completed" ? "reset" : "start";
  const declared = isDeclaredAction(context.recipe, action);
  return (
    <section {...attributes} className="workspace-recipe-timer" aria-label={text(props.label, "Timer")}>
      <output aria-label={`${formatTimer(projection.remainingMs, props.format)} remaining`}>
        {formatTimer(projection.remainingMs, props.format)}
      </output>
      {declared && (
        <button type="button" disabled={context.component.locks.actions === true} onClick={() => emitAction(context, action, {})}>
          {action}
        </button>
      )}
    </section>
  );
}

function RecipeChart({ attributes, props }: PrimitiveProps) {
  const labels = array(props.labels).filter((value): value is string => typeof value === "string").slice(0, 1_000);
  const series = array(props.series).filter(record).slice(0, 32);
  const values = series.flatMap((entry) => array(entry.values).filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  const maximum = Math.max(1, ...values.map(Math.abs));
  return (
    <figure {...attributes} className="workspace-recipe-chart">
      <figcaption>{text(props.title, "Chart")}</figcaption>
      <svg viewBox="0 0 320 140" role="img" aria-label={text(props.ariaLabel, "Chart visualization")}>
        {series.map((entry, seriesIndex) => {
          const points = array(entry.values).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          return <polyline key={text(entry.id, String(seriesIndex))} fill="none" stroke={safeColor(entry.color, chartColor(seriesIndex))} strokeWidth="3" points={points.map((value, index) => `${20 + index * (280 / Math.max(1, points.length - 1))},${125 - value / maximum * 105}`).join(" ")} />;
        })}
      </svg>
      <table className="workspace-recipe-data-table"><caption>Chart data</caption><tbody>{labels.map((label, index) => <tr key={`${label}:${index}`}><th scope="row">{label}</th>{series.map((entry, seriesIndex) => <td key={seriesIndex}>{display(array(entry.values)[index])}</td>)}</tr>)}</tbody></table>
    </figure>
  );
}

function RecipeTable({ attributes, props }: PrimitiveProps) {
  const columns = array(props.columns).filter(record).slice(0, 100);
  const rows = array(props.rows).filter(record).slice(0, 5_000);
  return (
    <div {...attributes} className="workspace-recipe-table"><table>
      <caption>{text(props.title, "Table")}</caption>
      <thead><tr>{columns.map((column, index) => <th scope="col" key={text(column.key, String(index))}>{text(column.label, text(column.key, `Column ${index + 1}`))}</th>)}</tr></thead>
      <tbody>{rows.map((row, rowIndex) => <tr key={text(row.id, String(rowIndex))}>{columns.map((column, columnIndex) => <td key={columnIndex}>{display(row[text(column.key, "")])}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

type NodeAttributes = {
  "data-recipe-node-id": string;
  "data-recipe-primitive": string;
};
type PrimitiveProps = { attributes: NodeAttributes; props: Record<string, unknown> };
type ControlProps = PrimitiveProps & { context: RenderContext };

export function resolveNodeProps(
  props: JSONObject,
  component: WorkspaceRenderComponent,
): Record<string, unknown> {
  const budget = { count: 0 };
  return resolveValue(props, component, 0, budget) as Record<string, unknown>;
}

function resolveValue(
  value: JSONValue,
  component: WorkspaceRenderComponent,
  depth: number,
  budget: { count: number },
): unknown {
  budget.count += 1;
  if (budget.count > 4_096 || depth > MAX_RENDERED_RECIPE_DEPTH) {
    throw new RecipeProjectionError("Recipe property bindings exceed renderer limits.", "recipe_binding_limit");
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, component, depth + 1, budget));
  if (record(value)) {
    if (typeof value.$bind === "string") {
      const resolved = resolveBinding(value.$bind, component);
      return resolved === undefined && "fallback" in value
        ? resolveValue(value.fallback as JSONValue, component, depth + 1, budget)
        : resolved;
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "__proto__" && key !== "prototype" && key !== "constructor")
      .map(([key, item]) => [key, resolveValue(item, component, depth + 1, budget)]));
  }
  if (typeof value === "string") {
    const exact = /^\{\{\s*([^{}]+?)\s*\}\}$/u.exec(value);
    if (exact) return resolveBinding(exact[1]!, component);
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (_match, path: string) => {
      const resolved = resolveBinding(path, component);
      return resolved === null || typeof resolved === "string" || typeof resolved === "number" || typeof resolved === "boolean"
        ? String(resolved ?? "")
        : "";
    });
  }
  return value;
}

function resolveBinding(path: string, component: WorkspaceRenderComponent): unknown {
  const segments = path.trim().split(".");
  if (segments.length === 0 || segments.length > 12 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment))) return undefined;
  let current: unknown;
  const [root, ...rest] = segments;
  if (root === "props") current = component.props;
  else if (root === "state" || root === "durableState") current = component.durableState;
  else if (root === "component") current = { id: component.id, label: component.label, tags: component.tags, visibility: component.visibility };
  else return undefined;
  for (const segment of rest) {
    if (!record(current) || segment === "__proto__" || segment === "constructor" || segment === "prototype") return undefined;
    current = current[segment];
  }
  return cloneJSONValue(current);
}

function emitAction(context: RenderContext, action: string, input: JSONObject): void {
  if (!isDeclaredAction(context.recipe, action) || context.component.locks.actions === true) return;
  context.onAction?.({ componentId: context.component.id, action, input: structuredClone(input) });
}

function isDeclaredAction(recipe: ComponentRecipe, action: string): boolean {
  return Boolean(action) && Object.prototype.hasOwnProperty.call(recipe.actions, action);
}

function objectValue(value: unknown): JSONObject {
  if (!record(value)) return {};
  const result: JSONObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    const safe = cloneJSONValue(item);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function cloneJSONValue(value: unknown, depth = 0): JSONValue | undefined {
  if (depth > MAX_RENDERED_RECIPE_DEPTH) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.flatMap((item) => {
    const safe = cloneJSONValue(item, depth + 1);
    return safe === undefined ? [] : [safe];
  });
  if (!record(value)) return undefined;
  const result: JSONObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    const safe = cloneJSONValue(item, depth + 1);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function stackStyle(props: Record<string, unknown>): CSSProperties {
  return {
    flexDirection: props.direction === "row" ? "row" : "column",
    gap: `${clamp(number(props.gap, 8), 0, 128)}px`,
    alignItems: alignment(props.align),
    justifyContent: justification(props.justify),
  };
}

function gridStyle(props: Record<string, unknown>): CSSProperties {
  return {
    gridTemplateColumns: `repeat(${integer(props.columns, 1, 24)}, minmax(0, 1fr))`,
    gap: `${clamp(number(props.gap, 8), 0, 128)}px`,
  };
}

function shapeStyle(props: Record<string, unknown>): CSSProperties {
  const width = dimension(props.width, "100%");
  const height = dimension(props.height, "100%");
  return {
    width,
    height,
    backgroundColor: safeColor(props.color, "transparent"),
    borderColor: safeColor(props.borderColor, "transparent"),
    borderWidth: `${clamp(number(props.borderWidth, 0), 0, 24)}px`,
    borderStyle: "solid",
    borderRadius: `${clamp(number(props.radius, 0), 0, 999)}px`,
    opacity: clamp(number(props.opacity, 1), 0, 1),
  };
}

function safeAssetSource(value: string): string | undefined {
  return /^(?:data:image\/(?:png|jpeg|gif|webp);base64,|blob:|\/)/iu.test(value) ? value : undefined;
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^(?:#[0-9a-f]{3,8}|transparent)$/iu.test(value) ? value : fallback;
}

function dimension(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return `${clamp(value, 0, 4_096)}px`;
  if (typeof value === "string" && /^(?:\d+(?:\.\d+)?%|auto)$/u.test(value)) return value;
  return fallback;
}

function alignment(value: unknown): CSSProperties["alignItems"] {
  return value === "start" || value === "end" || value === "center" || value === "stretch" ? value : "stretch";
}

function justification(value: unknown): CSSProperties["justifyContent"] {
  return value === "start" || value === "end" || value === "center" || value === "space-between" || value === "space-around"
    ? value
    : "start";
}

function safeInputKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(value) && value !== "__proto__" && value !== "constructor" && value !== "prototype"
    ? value
    : "value";
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  return Math.trunc(clamp(number(value, minimum), minimum, maximum));
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "[value]";
}

function chartColor(index: number): string {
  return ["#68D5FF", "#FFB86B", "#9FE870", "#C9A7FF", "#FF7D9C"][index % 5]!;
}
