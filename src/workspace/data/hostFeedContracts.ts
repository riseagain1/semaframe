import type { JSONSchema, JSONObject, JSONValue } from "../components/componentTypes";
import { detectUrlCapabilityRisk } from "../security/urlCapabilitySecurity";
import type { ResourceProvenance, ResourceRefreshPolicy, ResourceSnapshot } from "./dataTypes";

export const HOST_FEED_CONNECTOR_TYPE = "http.feed";
export const HOST_FEED_CONNECTOR_VERSION = "1.0.0";

export type HostFeedFormat = "auto" | "json" | "csv" | "rss";
export type ResolvedHostFeedFormat = Exclude<HostFeedFormat, "auto">;
export type HostFeedTargetType = "data-panel" | "chart" | "table" | "text" | "document";

/** Exact body accepted by POST /api/agent/feeds/fetch. */
export type HostFeedFetchRequest = Readonly<{
  url: string;
  format?: HostFeedFormat;
}>;

/**
 * Human UI preview intent. The refresh policy is consent metadata for the
 * browser host and is deliberately not forwarded to the feed broker request.
 */
export type WorkspaceHostFeedPreviewRequest = Readonly<{
  url: string;
  format: HostFeedFormat;
  policy: ResourceRefreshPolicy;
}>;

/** Host-normalized response returned by POST /api/agent/feeds/fetch. */
export type HostFeedFetchResponse = Readonly<{
  version: 1;
  requestedUrl: string;
  finalUrl: string;
  format: ResolvedHostFeedFormat;
  contentType: string;
  retrievedAt: string;
  outputSchema: JSONSchema;
  snapshot: ResourceSnapshot;
}>;

/** One closed resource-path projection. There is no expression/eval field. */
export type HostFeedMappingBinding = Readonly<{
  targetProp: string;
  sourcePath: string;
  transform: Readonly<{ kind: "identity" }>;
}>;

/**
 * A deterministic mapping derived from the fetched JSON value.
 * `initialProps` is limited to inert component props such as generated table
 * columns; the host still validates it against the pinned component manifest.
 */
export type HostFeedMappingPreset = Readonly<{
  id: string;
  label: string;
  targetType: HostFeedTargetType;
  bindings: readonly HostFeedMappingBinding[];
  initialProps?: Readonly<JSONObject>;
}>;

/** UI-to-host handoff after a successful preview. */
export type WorkspaceHostFeedSaveRequest = Readonly<{
  /** Existing host-owned feed to re-preview and update in place. */
  resourceId?: string;
  label: string;
  requestedFormat: HostFeedFormat;
  policy: ResourceRefreshPolicy;
  feed: HostFeedFetchResponse;
  targetComponentId?: string;
  mapping?: HostFeedMappingPreset;
}>;

const CREDENTIAL_QUERY_KEY = /(?:^|[_-])(?:api[_-]?key|authorization|bearer|credential|password|secret|token)(?:$|[_-])/iu;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_FEED_URL_LENGTH = 8_192;
const MAX_FEED_DATA_DEPTH = 32;
const MAX_FEED_DATA_NODES = 100_000;

export class HostFeedContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostFeedContractError";
  }
}

/** Browser-side syntax check only; the host remains authoritative for SSRF policy. */
export function normalizeHostFeedUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_FEED_URL_LENGTH) {
    throw new HostFeedContractError(`Feed URL must contain 1–${MAX_FEED_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HostFeedContractError("Feed URL is invalid");
  }
  if (url.protocol !== "https:") throw new HostFeedContractError("Feed URL must use HTTPS");
  if (url.username || url.password) throw new HostFeedContractError("Feed URL cannot contain credentials");
  if (url.port && url.port !== "443") throw new HostFeedContractError("Feed URL cannot use a custom port");
  if (url.hash) throw new HostFeedContractError("Feed URL cannot contain a fragment");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new HostFeedContractError("Feed URL must use a public hostname");
  }
  if (detectUrlCapabilityRisk(url)) {
    throw new HostFeedContractError("Feed URL cannot contain login, invitation, verification, or authorization capabilities");
  }
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEY.test(key.normalize("NFKC"))) {
      throw new HostFeedContractError("Feed URL cannot contain credential-like query parameters");
    }
  }
  return url.toString();
}

function exactRecord(
  value: unknown,
  name: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostFeedContractError(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new HostFeedContractError(`${name} contains unsupported field ${unknown}`);
  const missing = required.find((key) => !Object.hasOwn(record, key));
  if (missing) throw new HostFeedContractError(`${name} is missing ${missing}`);
  return record;
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new HostFeedContractError(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function isoTimestamp(value: unknown, name: string): string {
  const timestamp = boundedString(value, name, 100);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new HostFeedContractError(`${name} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function assertJsonValue(value: unknown): asserts value is JSONValue {
  let nodes = 0;
  const inspect = (candidate: unknown, depth: number, path: string): void => {
    nodes += 1;
    if (nodes > MAX_FEED_DATA_NODES) throw new HostFeedContractError(`Feed data exceeds ${MAX_FEED_DATA_NODES} values`);
    if (depth > MAX_FEED_DATA_DEPTH) throw new HostFeedContractError(`Feed data exceeds depth ${MAX_FEED_DATA_DEPTH} at ${path}`);
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new HostFeedContractError(`Feed data contains a non-finite number at ${path}`);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => inspect(entry, depth + 1, `${path}[${index}]`));
      return;
    }
    if (!candidate || typeof candidate !== "object") throw new HostFeedContractError(`Feed data contains a non-JSON value at ${path}`);
    for (const [key, entry] of Object.entries(candidate)) {
      if (DANGEROUS_KEYS.has(key)) throw new HostFeedContractError(`Feed data contains forbidden key ${key} at ${path}`);
      inspect(entry, depth + 1, `${path}.${key}`);
    }
  };
  inspect(value, 0, "$" );
}

function parseProvenance(value: unknown): ResourceProvenance[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HostFeedContractError("snapshot.provenance must contain at most 100 entries");
  }
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      `snapshot.provenance[${index}]`,
      ["title", "uri", "publisher", "retrievedAt", "citation"],
      ["retrievedAt"],
    );
    const optional = (key: "title" | "uri" | "publisher" | "citation", maxLength: number) =>
      record[key] === undefined ? undefined : boundedString(record[key], `snapshot.provenance[${index}].${key}`, maxLength);
    return {
      ...(optional("title", 2_000) ? { title: optional("title", 2_000) } : {}),
      ...(optional("uri", MAX_FEED_URL_LENGTH) ? { uri: optional("uri", MAX_FEED_URL_LENGTH) } : {}),
      ...(optional("publisher", 2_000) ? { publisher: optional("publisher", 2_000) } : {}),
      retrievedAt: isoTimestamp(record.retrievedAt, `snapshot.provenance[${index}].retrievedAt`),
      ...(optional("citation", 10_000) ? { citation: optional("citation", 10_000) } : {}),
    };
  });
}

/** Parse the network response before it crosses into Workspace state/UI. */
export function parseHostFeedFetchResponse(value: unknown): HostFeedFetchResponse {
  const record = exactRecord(
    value,
    "feed response",
    ["version", "requestedUrl", "finalUrl", "format", "contentType", "retrievedAt", "outputSchema", "snapshot"],
    ["version", "requestedUrl", "finalUrl", "format", "contentType", "retrievedAt", "outputSchema", "snapshot"],
  );
  if (record.version !== 1) throw new HostFeedContractError("feed response version must be 1");
  const format = record.format;
  if (format !== "json" && format !== "csv" && format !== "rss") {
    throw new HostFeedContractError("feed response format is unsupported");
  }
  const requestedUrl = normalizeHostFeedUrl(boundedString(record.requestedUrl, "requestedUrl", MAX_FEED_URL_LENGTH));
  const finalUrl = normalizeHostFeedUrl(boundedString(record.finalUrl, "finalUrl", MAX_FEED_URL_LENGTH));
  const retrievedAt = isoTimestamp(record.retrievedAt, "retrievedAt");
  const outputSchema = record.outputSchema;
  if (!outputSchema || typeof outputSchema !== "object" || Array.isArray(outputSchema)) {
    throw new HostFeedContractError("outputSchema must be an object");
  }
  const snapshotRecord = exactRecord(
    record.snapshot,
    "snapshot",
    ["data", "contentHash", "retrievedAt", "stale", "provenance"],
    ["data", "contentHash", "retrievedAt", "stale", "provenance"],
  );
  assertJsonValue(snapshotRecord.data);
  const snapshotRetrievedAt = isoTimestamp(snapshotRecord.retrievedAt, "snapshot.retrievedAt");
  if (snapshotRetrievedAt !== retrievedAt) throw new HostFeedContractError("snapshot and response retrieval times differ");
  if (snapshotRecord.stale !== false) throw new HostFeedContractError("a fetched snapshot cannot already be stale");
  return {
    version: 1,
    requestedUrl,
    finalUrl,
    format,
    contentType: boundedString(record.contentType, "contentType", 256),
    retrievedAt,
    outputSchema: structuredClone(outputSchema) as JSONSchema,
    snapshot: {
      data: structuredClone(snapshotRecord.data),
      contentHash: boundedString(snapshotRecord.contentHash, "snapshot.contentHash", 512),
      retrievedAt: snapshotRetrievedAt,
      stale: false,
      provenance: parseProvenance(snapshotRecord.provenance),
    },
  };
}
