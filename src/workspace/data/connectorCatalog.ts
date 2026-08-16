import type { JSONSchema, JSONValue } from "../components/componentTypes";

export type WorkspaceConnectorCapability = Readonly<{
  connectorType: string;
  connectorVersion: string;
  displayName: string;
  execution: "none" | "host";
  snapshotAuthority: "host_normalized" | "caller_untrusted" | "test_fixture";
  /** Whether a newly submitted Agent command may create/update this connector. */
  agentWritePolicy: "allowed" | "host_approval_required" | "legacy_read_only" | "test_only";
  networkAccess: boolean;
  configSchema: JSONSchema;
  recommendedOutputSchemas?: readonly Readonly<{
    id: string;
    displayName: string;
    schema: JSONSchema;
  }>[];
  notes: readonly string[];
}>;

export const NORMALIZED_CHART_TIMESERIES_SCHEMA: JSONSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["labels", "series"],
  properties: {
    labels: {
      type: "array",
      maxItems: 10_000,
      items: { type: "string" },
    },
    series: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "values"],
        properties: {
          id: { type: "string", minLength: 1 },
          label: { type: "string" },
          values: {
            type: "array",
            maxItems: 10_000,
            items: { type: "number" },
          },
          color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$" },
        },
      },
    },
  },
});

const emptyConfigSchema: JSONSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
});

const hostFeedConfigSchema: JSONSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["url", "format"],
  properties: {
    url: { type: "string", minLength: 1, maxLength: 8_192, format: "uri" },
    format: { enum: ["auto", "json", "csv", "rss"] },
  },
});

/**
 * Bounded connector descriptors advertised to users and Agents.
 *
 * `http.feed@1.0.0` describes a host-brokered read path. Advertising it does
 * not give an Agent network authority: an exact host/origin approval is still
 * required before execution. `inline-json@1` and `fixture@1` describe
 * legacy/test project records; only `inline.snapshot@1.0.0` accepts new
 * caller-supplied snapshots without connector execution.
 */
export const WORKSPACE_CONNECTOR_CAPABILITIES: readonly WorkspaceConnectorCapability[] = Object.freeze([
  Object.freeze({
    connectorType: "inline.snapshot",
    connectorVersion: "1.0.0",
    displayName: "Inline snapshot",
    execution: "none",
    snapshotAuthority: "host_normalized",
    agentWritePolicy: "allowed",
    networkAccess: false,
    configSchema: emptyConfigSchema,
    recommendedOutputSchemas: Object.freeze([Object.freeze({
      id: "chart.timeseries.v1",
      displayName: "Normalized chart time series",
      schema: NORMALIZED_CHART_TIMESERIES_SCHEMA,
    })]),
    notes: Object.freeze([
      "The host validates snapshot data, stamps retrieval time, computes contentHash, and replaces claimed provenance.",
      "Bind $.labels to chart.labels and $.series to chart.series using snapshot mode.",
    ]),
  }),
  Object.freeze({
    connectorType: "http.feed",
    connectorVersion: "1.0.0",
    displayName: "HTTPS data feed",
    execution: "host",
    snapshotAuthority: "host_normalized",
    agentWritePolicy: "host_approval_required",
    networkAccess: true,
    configSchema: hostFeedConfigSchema,
    notes: Object.freeze([
      "The host performs an approved public-HTTPS read and returns a bounded immutable snapshot; the browser renderer never fetches this URL.",
      "Supported wire formats are auto, JSON, CSV, and RSS/Atom. Refresh remains an explicit host action.",
      "Credentials, arbitrary headers, request bodies, expressions, scripts, and private-network destinations are not connector configuration.",
    ]),
  }),
  Object.freeze({
    connectorType: "inline-json",
    connectorVersion: "1",
    displayName: "Legacy inline JSON snapshot",
    execution: "none",
    snapshotAuthority: "caller_untrusted",
    agentWritePolicy: "legacy_read_only",
    networkAccess: false,
    configSchema: emptyConfigSchema,
    notes: Object.freeze([
      "Compatibility descriptor only; it never fetches a URL or resolves credentials.",
      "New snapshots should use inline.snapshot@1.0.0.",
    ]),
  }),
  Object.freeze({
    connectorType: "fixture",
    connectorVersion: "1",
    displayName: "Test fixture snapshot",
    execution: "none",
    snapshotAuthority: "test_fixture",
    agentWritePolicy: "test_only",
    networkAccess: false,
    configSchema: emptyConfigSchema,
    notes: Object.freeze([
      "Test-only compatibility descriptor; production hosts must not execute it.",
    ]),
  }),
]);

export function findWorkspaceConnectorCapability(
  connectorType: string,
  connectorVersion: string,
): WorkspaceConnectorCapability | undefined {
  return WORKSPACE_CONNECTOR_CAPABILITIES.find((capability) =>
    capability.connectorType === connectorType && capability.connectorVersion === connectorVersion,
  );
}

/** JSON-safe bounded copy suitable for the public capability manifest. */
export function workspaceConnectorCapabilityManifest(): JSONValue {
  return structuredClone(WORKSPACE_CONNECTOR_CAPABILITIES) as unknown as JSONValue;
}
