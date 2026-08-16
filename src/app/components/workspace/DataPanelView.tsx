import type { WorkspaceRenderComponent } from "../../../workspace/renderer/contracts";

const MAX_ROWS = 200;
const MAX_COLUMNS = 16;
const MAX_TEXT = 100_000;

type DataPanelMode = "auto" | "table" | "cards" | "json";

function stringProp(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return "—";
    return serialized.length > 500 ? `${serialized.slice(0, 499)}…` : serialized;
  } catch {
    return "Unavailable";
  }
}

function boundedJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized.length > MAX_TEXT ? `${serialized.slice(0, MAX_TEXT - 1)}…` : serialized;
  } catch {
    return "Data could not be serialized.";
  }
}

function recordRows(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value) && value.every(isRecord)) return value.slice(0, MAX_ROWS);
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.items) && value.items.every(isRecord)) return value.items.slice(0, MAX_ROWS);
  if (Array.isArray(value.rows) && value.rows.every(isRecord)) return value.rows.slice(0, MAX_ROWS);
  return undefined;
}

function columnsFor(rows: readonly Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
      if (columns.length === MAX_COLUMNS) return columns;
    }
  }
  return columns;
}

function cardTitle(row: Record<string, unknown>, index: number): string {
  for (const key of ["title", "name", "label", "id"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return `Item ${index + 1}`;
}

function cardSummary(row: Record<string, unknown>): string {
  for (const key of ["summary", "description", "content", "text", "value"]) {
    if (row[key] !== undefined) return displayValue(row[key]);
  }
  return boundedJson(row);
}

function safePublicLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8_192) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    for (const key of url.searchParams.keys()) {
      if (/(?:token|secret|password|credential|authorization|api[_-]?key|signature|session)/iu.test(key)) {
        return undefined;
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * A bounded, text-only projection for arbitrary feed payloads. It never
 * evaluates markup or trusts record keys as HTML, and caps DOM fan-out even
 * when the fetched snapshot itself is near the host response-size limit.
 */
export function DataPanelView({ component }: Readonly<{ component: WorkspaceRenderComponent }>) {
  const title = stringProp(component.props.title) ?? component.label;
  const modeValue = stringProp(component.props.view);
  const mode: DataPanelMode = modeValue === "table" || modeValue === "cards" || modeValue === "json"
    ? modeValue
    : "auto";
  const data = component.props.data ?? null;
  const rows = recordRows(data);
  const effectiveMode: DataPanelMode = mode === "auto"
    ? rows?.length ? "table" : "json"
    : mode;
  const emptyMessage = stringProp(component.props.emptyMessage) ?? "No feed data yet.";

  return (
    <section className={`workspace-data-panel is-${effectiveMode}`} aria-label={title}>
      <header>
        <strong>{title}</strong>
        <span>{rows ? `${rows.length}${rows.length === MAX_ROWS ? "+" : ""} items` : "Feed data"}</span>
      </header>
      {rows?.length === 0 ? <p className="workspace-empty-copy">{emptyMessage}</p> : null}
      {effectiveMode === "table" && rows?.length ? <DataTable rows={rows} /> : null}
      {effectiveMode === "cards" && rows?.length ? <DataCards rows={rows} /> : null}
      {effectiveMode === "json" ? <pre><code>{boundedJson(data)}</code></pre> : null}
    </section>
  );
}

function DataTable({ rows }: Readonly<{ rows: readonly Record<string, unknown>[] }>) {
  const columns = columnsFor(rows);
  if (!columns.length) return <p className="workspace-empty-copy">No displayable fields.</p>;
  return (
    <div className="workspace-data-panel__table-wrap">
      <table aria-label="Feed data">
        <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={typeof row.id === "string" ? row.id : index}>
          {columns.map((column) => <td key={column}>{displayValue(row[column])}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function DataCards({ rows }: Readonly<{ rows: readonly Record<string, unknown>[] }>) {
  return (
    <ul className="workspace-data-panel__cards">
      {rows.map((row, index) => {
        const link = safePublicLink(row.link);
        return <li key={typeof row.id === "string" ? row.id : index}>
          <strong>{cardTitle(row, index)}</strong>
          <p>{cardSummary(row)}</p>
          {link ? <a href={link} target="_blank" rel="noreferrer">Open source</a> : null}
        </li>;
      })}
    </ul>
  );
}
