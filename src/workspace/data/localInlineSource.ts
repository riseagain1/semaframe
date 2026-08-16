import Ajv2020 from "ajv/dist/2020.js";
import type { JSONSchema, JSONObject, JSONValue } from "../components/componentTypes";
import { NORMALIZED_CHART_TIMESERIES_SCHEMA } from "./connectorCatalog";

export type LocalInlineSourceFormat = "json" | "csv";

export type ParsedLocalInlineSource = Readonly<{
  data: JSONValue;
  outputSchema: JSONSchema;
  kind: "chart_timeseries" | "generic_json";
}>;

const MAX_LOCAL_SOURCE_CHARACTERS = 500_000;
const MAX_LOCAL_SOURCE_DEPTH = 32;
const MAX_CSV_ROWS = 10_000;
const MAX_CSV_COLUMNS = 101;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const localSourceAjv = new Ajv2020({ allErrors: true, strict: false, strictNumbers: true });
const chartTimeseriesValidator = localSourceAjv.compile(structuredClone(NORMALIZED_CHART_TIMESERIES_SCHEMA));

export class LocalInlineSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalInlineSourceError";
  }
}

function assertJSONValue(value: unknown, path = "$", depth = 0): asserts value is JSONValue {
  if (depth > MAX_LOCAL_SOURCE_DEPTH) {
    throw new LocalInlineSourceError(`Source JSON exceeds depth ${MAX_LOCAL_SOURCE_DEPTH} at ${path}`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LocalInlineSourceError(`Source JSON contains a non-finite number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CSV_ROWS) throw new LocalInlineSourceError(`Source array exceeds ${MAX_CSV_ROWS} items at ${path}`);
    value.forEach((entry, index) => assertJSONValue(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") {
    throw new LocalInlineSourceError(`Source JSON contains an unsupported value at ${path}`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_CSV_ROWS) throw new LocalInlineSourceError(`Source object is too large at ${path}`);
  for (const [key, entry] of entries) {
    if (DANGEROUS_KEYS.has(key)) throw new LocalInlineSourceError(`Source JSON contains forbidden key ${key} at ${path}`);
    assertJSONValue(entry, `${path}.${key}`, depth + 1);
  }
}

const INFERRED_SCHEMA_NODE_BUDGET = 220;
const INFERRED_SCHEMA_PROPERTY_LIMIT = 200;
const JSON_SCHEMA_TYPE_ORDER = ["null", "boolean", "number", "string", "array", "object"] as const;
type InferredJSONType = typeof JSON_SCHEMA_TYPE_ORDER[number];

function inferredType(value: JSONValue): InferredJSONType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Exclude<InferredJSONType, "null" | "array">;
}

/**
 * Infer a non-branching schema accepted by the untrusted-schema safety profile.
 * Heterogeneous arrays use JSON Schema's bounded `type` union or a merged object
 * shape rather than anyOf/oneOf, so inference never bypasses the synchronous
 * complexity guard.
 */
function inferJSONSchema(value: JSONValue): JSONSchema {
  const budget = { remaining: INFERRED_SCHEMA_NODE_BUDGET };
  const inferValues = (values: readonly JSONValue[]): JSONSchema => {
    if (budget.remaining <= 0 || values.length === 0) return {};
    budget.remaining -= 1;
    const types = new Set(values.map(inferredType));
    if (types.size > 1) {
      return { type: JSON_SCHEMA_TYPE_ORDER.filter((type) => types.has(type)) };
    }
    const type = inferredType(values[0]!);
    if (type !== "array" && type !== "object") return { type };
    if (type === "array") {
      const entries: JSONValue[] = [];
      for (const array of values as readonly JSONValue[][]) entries.push(...array);
      return {
        type: "array",
        maxItems: MAX_CSV_ROWS,
        items: inferValues(entries),
      };
    }

    const records = values as readonly JSONObject[];
    const keys = [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
    if (keys.length > INFERRED_SCHEMA_PROPERTY_LIMIT || keys.length > budget.remaining) {
      return { type: "object" };
    }
    const properties: Record<string, JSONSchema> = {};
    for (const key of keys) {
      properties[key] = inferValues(records.flatMap((record) =>
        Object.hasOwn(record, key) ? [record[key]!] : [],
      ));
    }
    const required = keys.filter((key) => records.every((record) => Object.hasOwn(record, key)));
    return {
      type: "object",
      additionalProperties: false,
      ...(required.length ? { required } : {}),
      properties,
    };
  };
  return inferValues([value]);
}

function parseCSVRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
      if (rows.length > MAX_CSV_ROWS + 1) throw new LocalInlineSourceError(`CSV exceeds ${MAX_CSV_ROWS} data rows`);
    } else {
      field += character;
    }
  }
  if (quoted) throw new LocalInlineSourceError("CSV contains an unterminated quoted field");
  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function seriesId(label: string, index: number, used: Set<string>): string {
  const base = label.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")
    || `series_${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function parseChartCSV(text: string): ParsedLocalInlineSource {
  const rows = parseCSVRows(text);
  if (rows.length < 2) throw new LocalInlineSourceError("CSV requires a header and at least one data row");
  const headers = rows[0]!.map((value) => value.trim());
  if (headers.length < 2 || headers.length > MAX_CSV_COLUMNS || headers.some((value) => !value)) {
    throw new LocalInlineSourceError(`CSV requires 2–${MAX_CSV_COLUMNS} non-empty columns`);
  }
  const labels: string[] = [];
  const values = headers.slice(1).map(() => [] as number[]);
  for (const [rowIndex, cells] of rows.slice(1).entries()) {
    if (cells.length !== headers.length) {
      throw new LocalInlineSourceError(`CSV row ${rowIndex + 2} has ${cells.length} columns; expected ${headers.length}`);
    }
    labels.push(cells[0]!.trim());
    for (let column = 1; column < cells.length; column += 1) {
      const raw = cells[column]!.trim();
      const numeric = Number(raw);
      if (!raw || !Number.isFinite(numeric)) {
        throw new LocalInlineSourceError(`CSV row ${rowIndex + 2}, column ${column + 1} must be a finite number`);
      }
      values[column - 1]!.push(numeric);
    }
  }
  const usedIds = new Set<string>();
  const data: JSONObject = {
    labels,
    series: headers.slice(1).map((label, index) => ({
      id: seriesId(label, index, usedIds),
      label,
      values: values[index]!,
    })),
  };
  return {
    data,
    outputSchema: structuredClone(NORMALIZED_CHART_TIMESERIES_SCHEMA),
    kind: "chart_timeseries",
  };
}

export function isNormalizedChartTimeseries(value: JSONValue): boolean {
  return chartTimeseriesValidator(value) === true;
}

export function parseLocalInlineSource(
  format: LocalInlineSourceFormat,
  text: string,
): ParsedLocalInlineSource {
  if (!text.trim()) throw new LocalInlineSourceError("Paste JSON or CSV data first");
  if (text.length > MAX_LOCAL_SOURCE_CHARACTERS) {
    throw new LocalInlineSourceError(`Local source exceeds ${MAX_LOCAL_SOURCE_CHARACTERS} characters`);
  }
  if (format === "csv") return parseChartCSV(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new LocalInlineSourceError(
      `Source JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertJSONValue(value);
  if (isNormalizedChartTimeseries(value)) {
    return {
      data: structuredClone(value),
      outputSchema: structuredClone(NORMALIZED_CHART_TIMESERIES_SCHEMA),
      kind: "chart_timeseries",
    };
  }
  return {
    data: structuredClone(value),
    outputSchema: inferJSONSchema(value),
    kind: "generic_json",
  };
}
