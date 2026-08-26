export const XR_RELAY_PROTOCOL_VERSION = 1 as const;

export const XR_SESSION_ROLES = ["authority", "xr_renderer"] as const;
export type XrSessionRole = (typeof XR_SESSION_ROLES)[number];

export const XR_MESSAGE_TYPES = [
  "snapshot",
  "delta",
  "ephemeral",
  "input",
  "ack",
  "error",
] as const;
export type XrMessageType = (typeof XR_MESSAGE_TYPES)[number];

export const XR_INPUT_TYPES = [
  "pose",
  "select",
  "activate",
  "grab",
  "teleport",
  "voice_partial",
  "voice_final",
  "panel_action",
] as const;
export type XrInputType = (typeof XR_INPUT_TYPES)[number];

export const XR_ACK_STATUSES = ["accepted", "duplicate"] as const;
export type XrAckStatus = (typeof XR_ACK_STATUSES)[number];

export const XR_ERROR_CODES = [
  "invalid_message",
  "session_not_found",
  "session_mismatch",
  "role_not_allowed",
  "authority_unavailable",
  "workspace_mismatch",
  "stale_epoch",
  "stale_revision",
  "future_revision",
  "out_of_order",
  "duplicate_conflict",
  "snapshot_required",
  "revision_conflict",
  "digest_mismatch",
  "capacity_exhausted",
] as const;
export type XrErrorCode = (typeof XR_ERROR_CODES)[number];

export type XrJsonScalar = string | number | boolean | null;
export type XrJsonValue = XrJsonScalar | XrJsonObject | readonly XrJsonValue[];
export type XrJsonObject = Readonly<{ [key: string]: XrJsonValue }>;

export type XrEnvelope = Readonly<{
  protocolVersion: typeof XR_RELAY_PROTOCOL_VERSION;
  messageType: XrMessageType;
  sessionId: string;
  authorityEpoch: string;
  workspaceId: string;
  revision: number;
  requestId: string;
}>;

export type XrSnapshotMessage = XrEnvelope & Readonly<{
  messageType: "snapshot";
  registryDigest: `sha256:${string}`;
  snapshotDigest: `sha256:${string}`;
  snapshot: XrJsonObject;
}>;

export type XrDeltaMessage = XrEnvelope & Readonly<{
  messageType: "delta";
  baseRevision: number;
  baseSnapshotDigest: `sha256:${string}`;
  snapshotDigest: `sha256:${string}`;
  delta: XrJsonObject;
}>;

export type XrEphemeralMessage = XrEnvelope & Readonly<{
  messageType: "ephemeral";
  channel: string;
  sequence: number;
  payload: XrJsonObject;
}>;

export type XrInputMessage = XrEnvelope & Readonly<{
  messageType: "input";
  inputType: XrInputType;
  payload: XrJsonObject;
}>;

export type XrAckMessage = XrEnvelope & Readonly<{
  messageType: "ack";
  status: XrAckStatus;
}>;

export type XrErrorMessage = XrEnvelope & Readonly<{
  messageType: "error";
  code: XrErrorCode;
  message: string;
  retryable: boolean;
  expectedRevision?: number;
  expectedAuthorityEpoch?: string;
}>;

export type XrRelayMessage =
  | XrSnapshotMessage
  | XrDeltaMessage
  | XrEphemeralMessage
  | XrInputMessage
  | XrAckMessage
  | XrErrorMessage;

export type XrRoutableMessage =
  | XrSnapshotMessage
  | XrDeltaMessage
  | XrEphemeralMessage
  | XrInputMessage;

export type XrReconnectCursor = Readonly<{
  protocolVersion: typeof XR_RELAY_PROTOCOL_VERSION;
  sessionId: string;
  authorityEpoch: string;
  workspaceId: string;
  revision: number;
  snapshotDigest: `sha256:${string}`;
  requestId: string;
}>;

export const XR_PROTOCOL_LIMITS = Object.freeze({
  maximumJsonDepth: 24,
  maximumJsonNodes: 20_000,
  maximumObjectKeys: 2_048,
  maximumArrayItems: 8_192,
  maximumStringLength: 256 * 1024,
  maximumSnapshotBytes: 4 * 1024 * 1024,
  maximumDeltaBytes: 512 * 1024,
  maximumEphemeralBytes: 64 * 1024,
  maximumInputBytes: 64 * 1024,
  maximumControlBytes: 16 * 1024,
  /** Shared default ceiling for JSON reconnect and poll response envelopes. */
  maximumControlResponseBytes: 16 * 1024 * 1024,
});
