import type { JSONSchema, JSONObject, JSONValue } from "../components/componentTypes";
import type { TransitionSpec } from "../protocol/workspaceTypes";

export type ResourceId = string;
export type ConnectionId = string;

export type ResourceProvenance = {
  title?: string;
  uri?: string;
  publisher?: string;
  retrievedAt: string;
  citation?: string;
};

export type ResourceSnapshot = {
  data: JSONValue;
  contentHash: string;
  retrievedAt: string;
  stale: boolean;
  provenance: ResourceProvenance[];
};

export type ResourceRefreshPolicy = {
  mode: "manual" | "interval" | "on_open";
  intervalMs?: number;
  maxStaleMs?: number;
  offline: "keep_last_good" | "show_error";
};

/** Credentials are referenced by opaque server-owned IDs and never embedded. */
export type WorkspaceResource = {
  id: ResourceId;
  label: string;
  connectorType: string;
  connectorVersion: string;
  outputSchema: JSONSchema;
  config: JSONObject;
  secretRef?: string;
  policy: ResourceRefreshPolicy;
  snapshot?: ResourceSnapshot;
  status: "unconfigured" | "ready" | "stale" | "error";
  lastError?: string;
};

export type BindingTransform =
  | { kind: "identity" }
  | { kind: "pick"; path: string }
  | { kind: "format_number"; decimals?: number; prefix?: string; suffix?: string }
  | { kind: "template"; template: string };

export type ResourceBinding = {
  kind: "resource_binding";
  id: ConnectionId;
  resourceId: ResourceId;
  componentId: string;
  targetProp: string;
  sourcePath?: string;
  mode: "snapshot" | "live";
  transform: BindingTransform;
  enabled: boolean;
};

export type EventConnection = {
  kind: "event_connection";
  id: ConnectionId;
  sourceComponentId: string;
  event: string;
  targetComponentId: string;
  action: string;
  input?: JSONObject;
  /** Static by default; exact-schema payload forwarding is deliberately opt-in. */
  inputMode?: "static" | "event_payload";
  /** Bounded renderer hint copied onto the resolved target action operation. */
  transition?: TransitionSpec;
  enabled: boolean;
};

export type WorkspaceConnection = ResourceBinding | EventConnection;
