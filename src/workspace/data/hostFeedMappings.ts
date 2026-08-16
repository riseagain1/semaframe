import type { JSONObject, JSONValue } from "../components/componentTypes";
import type {
  HostFeedMappingBinding,
  HostFeedMappingPreset,
  HostFeedTargetType,
} from "./hostFeedContracts";

export type HostFeedValueKind = "string" | "number" | "boolean" | "null" | "object" | "array";
export type HostFeedValuePath = Readonly<{
  path: string;
  label: string;
  kind: HostFeedValueKind;
}>;

const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_NODES = 512;
const MAX_DISCOVERED_PATHS = 128;
const MAX_MAPPING_PRESETS = 64;
const MAX_GENERATED_TABLE_COLUMNS = 24;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function valueKind(value: JSONValue): HostFeedValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Exclude<HostFeedValueKind, "null" | "array">;
}

function appendPath(parent: string, key: string): string {
  if (/^[A-Za-z0-9_-]+$/u.test(key) && !FORBIDDEN_PATH_SEGMENTS.has(key)) return `${parent}.${key}`;
  return `${parent}[${JSON.stringify(key)}]`;
}

function pathLabel(path: string): string {
  if (path === "$") return "Entire feed";
  return path.length > 72 ? `…${path.slice(-69)}` : path;
}

export function discoverHostFeedValuePaths(data: JSONValue): readonly HostFeedValuePath[] {
  const result: HostFeedValuePath[] = [];
  let visited = 0;
  const visit = (value: JSONValue, path: string, depth: number): void => {
    if (result.length >= MAX_DISCOVERED_PATHS || visited >= MAX_DISCOVERY_NODES) return;
    visited += 1;
    result.push({ path, label: pathLabel(path), kind: valueKind(value) });
    if (depth >= MAX_DISCOVERY_DEPTH || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      // Array indexes are intentionally not exposed as mapping choices. The
      // resource path can project the complete collection without pinning a
      // feed mapping to whichever record happened to be first at preview time.
      return;
    }
    for (const key of Object.keys(value).sort()) {
      if (FORBIDDEN_PATH_SEGMENTS.has(key)) continue;
      visit(value[key]!, appendPath(path, key), depth + 1);
      if (result.length >= MAX_DISCOVERED_PATHS || visited >= MAX_DISCOVERY_NODES) return;
    }
  };
  visit(data, "$", 0);
  return result;
}

function identity(targetProp: string, sourcePath: string): HostFeedMappingBinding {
  return { targetProp, sourcePath, transform: { kind: "identity" } };
}

function isObject(value: JSONValue | undefined): value is JSONObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isChartLabels(value: JSONValue | undefined): value is string[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every((entry) => typeof entry === "string");
}

function isChartSeries(value: JSONValue | undefined): boolean {
  return Array.isArray(value) && value.length <= 100 && value.every((entry) =>
    isObject(entry)
    && typeof entry.id === "string"
    && typeof entry.label === "string"
    && Array.isArray(entry.values)
    && entry.values.length <= 10_000
    && entry.values.every((point) => typeof point === "number" && Number.isFinite(point)),
  );
}

function isTableColumns(value: JSONValue | undefined): boolean {
  return Array.isArray(value) && value.length <= 200 && value.every((entry) =>
    isObject(entry)
    && typeof entry.key === "string"
    && typeof entry.label === "string"
    && (entry.align === undefined || entry.align === "left" || entry.align === "center" || entry.align === "right"),
  );
}

function isRecordArray(value: JSONValue | undefined): value is JSONObject[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every((entry) => isObject(entry));
}

function generatedColumns(rows: readonly JSONObject[]): JSONValue[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 100)) {
    for (const key of Object.keys(row).sort()) {
      if (FORBIDDEN_PATH_SEGMENTS.has(key)) continue;
      const value = row[key];
      if (value !== null && typeof value === "object") continue;
      keys.add(key);
      if (keys.size >= MAX_GENERATED_TABLE_COLUMNS) break;
    }
    if (keys.size >= MAX_GENERATED_TABLE_COLUMNS) break;
  }
  return [...keys].map((key) => ({ key, label: key, align: "left" }));
}

function targetLabel(target: HostFeedTargetType): string {
  if (target === "data-panel") return "Data panel";
  return `${target[0]!.toUpperCase()}${target.slice(1)}`;
}

/**
 * Derive only direct, schema-shaped projections. This deliberately does not
 * contain a query language, JavaScript expression, interpolation, or row map.
 */
export function deriveHostFeedMappingPresets(data: JSONValue): readonly HostFeedMappingPreset[] {
  const presets: HostFeedMappingPreset[] = [{
    id: "data-panel-root",
    label: "Show the complete feed",
    targetType: "data-panel",
    bindings: [identity("data", "$")],
  }];
  const seen = new Set<string>(["data-panel|data|$"]);
  let visited = 0;

  const add = (
    targetType: HostFeedTargetType,
    label: string,
    bindings: readonly HostFeedMappingBinding[],
    initialProps?: Readonly<JSONObject>,
  ): void => {
    if (presets.length >= MAX_MAPPING_PRESETS) return;
    const signature = `${targetType}|${bindings.map((binding) => `${binding.targetProp}:${binding.sourcePath}`).join("|")}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    presets.push({
      id: `feed-map-${targetType}-${presets.length + 1}`,
      label,
      targetType,
      bindings,
      ...(initialProps ? { initialProps } : {}),
    });
  };

  const visit = (value: JSONValue, path: string, depth: number): void => {
    if (visited >= MAX_DISCOVERY_NODES || presets.length >= MAX_MAPPING_PRESETS) return;
    visited += 1;
    if (typeof value === "string") {
      if (value.length <= 100_000) add("text", `Use ${pathLabel(path)} as text`, [identity("text", path)]);
      if (value.length <= 2_000_000) add("document", `Use ${pathLabel(path)} as document content`, [identity("content", path)]);
      return;
    }
    if (depth > MAX_DISCOVERY_DEPTH || value === null || typeof value !== "object") return;

    if (isObject(value)) {
      if (isChartLabels(value.labels) && isChartSeries(value.series)) {
        add("chart", `Chart from ${pathLabel(path)}`, [
          identity("labels", appendPath(path, "labels")),
          identity("series", appendPath(path, "series")),
        ]);
      }
      if (isTableColumns(value.columns) && isRecordArray(value.rows)) {
        add("table", `Table from ${pathLabel(path)}`, [
          identity("columns", appendPath(path, "columns")),
          identity("rows", appendPath(path, "rows")),
        ]);
      }
      for (const key of Object.keys(value).sort()) {
        if (FORBIDDEN_PATH_SEGMENTS.has(key)) continue;
        visit(value[key]!, appendPath(path, key), depth + 1);
      }
      return;
    }

    if (isRecordArray(value)) {
      const columns = generatedColumns(value);
      if (columns.length) {
        add("table", `Table rows from ${pathLabel(path)}`, [identity("rows", path)], { columns });
      }
    }
  };

  visit(data, "$", 0);
  return presets;
}

export function createExplicitHostFeedMapping(input: Readonly<{
  targetType: HostFeedTargetType;
  targetProp: string;
  sourcePath: string;
}>): HostFeedMappingPreset {
  return {
    id: `explicit-${input.targetType}-${input.targetProp}`,
    label: `${targetLabel(input.targetType)} ${input.targetProp} from ${pathLabel(input.sourcePath)}`,
    targetType: input.targetType,
    bindings: [identity(input.targetProp, input.sourcePath)],
  };
}
