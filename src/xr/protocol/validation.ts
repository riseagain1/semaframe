import {
  XR_ACK_STATUSES,
  XR_ERROR_CODES,
  XR_INPUT_TYPES,
  XR_MESSAGE_TYPES,
  XR_PROTOCOL_LIMITS,
  XR_RELAY_PROTOCOL_VERSION,
  XR_SESSION_ROLES,
  type XrAckMessage,
  type XrAckStatus,
  type XrDeltaMessage,
  type XrEnvelope,
  type XrEphemeralMessage,
  type XrErrorCode,
  type XrErrorMessage,
  type XrInputMessage,
  type XrInputType,
  type XrJsonObject,
  type XrJsonValue,
  type XrMessageType,
  type XrReconnectCursor,
  type XrRelayMessage,
  type XrSessionRole,
  type XrSnapshotMessage,
} from "./contracts";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CHANNEL_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const COMMON_KEYS = [
  "protocolVersion",
  "messageType",
  "sessionId",
  "authorityEpoch",
  "workspaceId",
  "revision",
  "requestId",
] as const;

export class XrProtocolValidationError extends TypeError {
  constructor(
    message: string,
    readonly path = "$",
  ) {
    super(`${path}: ${message}`);
    this.name = "XrProtocolValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new XrProtocolValidationError("must be a plain object", path);
  return value;
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Record<string, unknown> {
  const result = record(value, path);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(result)) {
    if (!allowedSet.has(key)) throw new XrProtocolValidationError(`unknown field ${key}`, path);
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) throw new XrProtocolValidationError(`missing field ${key}`, path);
  }
  return result;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new XrProtocolValidationError(`must be one of ${values.join(", ")}`, path);
  }
  return value as T;
}

function boundedString(value: unknown, path: string, maximum = 2_000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new XrProtocolValidationError(`must be a string containing 1-${maximum} characters`, path);
  }
  if (/\p{Cc}/u.test(value)) throw new XrProtocolValidationError("must not contain control characters", path);
  return value;
}

export function parseXrOpaqueId(value: unknown, path = "$"): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new XrProtocolValidationError("must be an 8-128 character opaque identifier", path);
  }
  return value;
}

export function parseXrWorkspaceId(value: unknown, path = "$"): string {
  if (typeof value !== "string" || !WORKSPACE_ID_PATTERN.test(value)) {
    throw new XrProtocolValidationError("must be a valid Workspace identifier", path);
  }
  return value;
}

export function parseXrRevision(value: unknown, path = "$"): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new XrProtocolValidationError("must be a non-negative safe integer", path);
  }
  return Number(value);
}

export function parseXrSha256(value: unknown, path = "$"): `sha256:${string}` {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new XrProtocolValidationError("must be a lowercase sha256 digest", path);
  }
  return value as `sha256:${string}`;
}

export function parseXrSessionRole(value: unknown, path = "$"): XrSessionRole {
  return enumValue(value, XR_SESSION_ROLES, path);
}

type JsonBudget = { nodes: number };

function cloneJson(value: unknown, path: string, depth: number, budget: JsonBudget): XrJsonValue {
  budget.nodes += 1;
  if (budget.nodes > XR_PROTOCOL_LIMITS.maximumJsonNodes) {
    throw new XrProtocolValidationError("JSON node limit exceeded", path);
  }
  if (depth > XR_PROTOCOL_LIMITS.maximumJsonDepth) {
    throw new XrProtocolValidationError("JSON depth limit exceeded", path);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new XrProtocolValidationError("numbers must be finite", path);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > XR_PROTOCOL_LIMITS.maximumStringLength) {
      throw new XrProtocolValidationError("string limit exceeded", path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > XR_PROTOCOL_LIMITS.maximumArrayItems) {
      throw new XrProtocolValidationError("array item limit exceeded", path);
    }
    const arrayKeys = Object.keys(value);
    if (Object.getOwnPropertySymbols(value).length > 0
      || arrayKeys.length !== value.length
      || arrayKeys.some((key, index) => key !== String(index))) {
      throw new XrProtocolValidationError("arrays must be dense and contain no extra properties", path);
    }
    return Object.freeze(value.map((entry, index) => cloneJson(entry, `${path}[${index}]`, depth + 1, budget)));
  }
  if (!isRecord(value)) throw new XrProtocolValidationError("must contain JSON-compatible values", path);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new XrProtocolValidationError("symbol keys are not JSON-compatible", path);
  }
  const keys = Object.keys(value);
  if (keys.length > XR_PROTOCOL_LIMITS.maximumObjectKeys) {
    throw new XrProtocolValidationError("object key limit exceeded", path);
  }
  const result: Record<string, XrJsonValue> = Object.create(null) as Record<string, XrJsonValue>;
  for (const key of keys) {
    if (key.length < 1 || key.length > 128) throw new XrProtocolValidationError("object key length is invalid", path);
    if (DANGEROUS_KEYS.has(key)) throw new XrProtocolValidationError(`dangerous key ${key}`, path);
    result[key] = cloneJson(value[key], `${path}.${key}`, depth + 1, budget);
  }
  return Object.freeze(result);
}

function parseJsonObject(value: unknown, path: string, maximumBytes: number): XrJsonObject {
  const cloned = cloneJson(value, path, 0, { nodes: 0 });
  if (Array.isArray(cloned) || cloned === null || typeof cloned !== "object") {
    throw new XrProtocolValidationError("must be a JSON object", path);
  }
  const encoded = new TextEncoder().encode(JSON.stringify(cloned));
  if (encoded.byteLength > maximumBytes) {
    throw new XrProtocolValidationError(`encoded JSON exceeds ${maximumBytes} bytes`, path);
  }
  return cloned as XrJsonObject;
}

function parseEnvelope(value: Record<string, unknown>): Omit<XrEnvelope, "messageType"> & { messageType: XrMessageType } {
  if (value.protocolVersion !== XR_RELAY_PROTOCOL_VERSION) {
    throw new XrProtocolValidationError(`must equal ${XR_RELAY_PROTOCOL_VERSION}`, "$.protocolVersion");
  }
  return Object.freeze({
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: enumValue(value.messageType, XR_MESSAGE_TYPES, "$.messageType"),
    sessionId: parseXrOpaqueId(value.sessionId, "$.sessionId"),
    authorityEpoch: parseXrOpaqueId(value.authorityEpoch, "$.authorityEpoch"),
    workspaceId: parseXrWorkspaceId(value.workspaceId, "$.workspaceId"),
    revision: parseXrRevision(value.revision, "$.revision"),
    requestId: parseXrOpaqueId(value.requestId, "$.requestId"),
  });
}

function parseSnapshot(value: unknown): XrSnapshotMessage {
  const body = exactObject(
    value,
    [...COMMON_KEYS, "registryDigest", "snapshotDigest", "snapshot"],
    [...COMMON_KEYS, "registryDigest", "snapshotDigest", "snapshot"],
    "$",
  );
  const envelope = parseEnvelope(body);
  if (envelope.messageType !== "snapshot") throw new XrProtocolValidationError("must equal snapshot", "$.messageType");
  return Object.freeze({
    ...envelope,
    messageType: "snapshot",
    registryDigest: parseXrSha256(body.registryDigest, "$.registryDigest"),
    snapshotDigest: parseXrSha256(body.snapshotDigest, "$.snapshotDigest"),
    snapshot: parseJsonObject(body.snapshot, "$.snapshot", XR_PROTOCOL_LIMITS.maximumSnapshotBytes),
  });
}

function parseDelta(value: unknown): XrDeltaMessage {
  const body = exactObject(
    value,
    [...COMMON_KEYS, "baseRevision", "baseSnapshotDigest", "snapshotDigest", "delta"],
    [...COMMON_KEYS, "baseRevision", "baseSnapshotDigest", "snapshotDigest", "delta"],
    "$",
  );
  const envelope = parseEnvelope(body);
  if (envelope.messageType !== "delta") throw new XrProtocolValidationError("must equal delta", "$.messageType");
  return Object.freeze({
    ...envelope,
    messageType: "delta",
    baseRevision: parseXrRevision(body.baseRevision, "$.baseRevision"),
    baseSnapshotDigest: parseXrSha256(body.baseSnapshotDigest, "$.baseSnapshotDigest"),
    snapshotDigest: parseXrSha256(body.snapshotDigest, "$.snapshotDigest"),
    delta: parseJsonObject(body.delta, "$.delta", XR_PROTOCOL_LIMITS.maximumDeltaBytes),
  });
}

function parseEphemeral(value: unknown): XrEphemeralMessage {
  const body = exactObject(
    value,
    [...COMMON_KEYS, "channel", "sequence", "payload"],
    [...COMMON_KEYS, "channel", "sequence", "payload"],
    "$",
  );
  const envelope = parseEnvelope(body);
  if (envelope.messageType !== "ephemeral") throw new XrProtocolValidationError("must equal ephemeral", "$.messageType");
  if (typeof body.channel !== "string" || !CHANNEL_PATTERN.test(body.channel)) {
    throw new XrProtocolValidationError("must be a lowercase bounded channel identifier", "$.channel");
  }
  return Object.freeze({
    ...envelope,
    messageType: "ephemeral",
    channel: body.channel,
    sequence: parseXrRevision(body.sequence, "$.sequence"),
    payload: parseJsonObject(body.payload, "$.payload", XR_PROTOCOL_LIMITS.maximumEphemeralBytes),
  });
}

function parseInput(value: unknown): XrInputMessage {
  const body = exactObject(
    value,
    [...COMMON_KEYS, "inputType", "payload"],
    [...COMMON_KEYS, "inputType", "payload"],
    "$",
  );
  const envelope = parseEnvelope(body);
  if (envelope.messageType !== "input") throw new XrProtocolValidationError("must equal input", "$.messageType");
  return Object.freeze({
    ...envelope,
    messageType: "input",
    inputType: enumValue<XrInputType>(body.inputType, XR_INPUT_TYPES, "$.inputType"),
    payload: parseJsonObject(body.payload, "$.payload", XR_PROTOCOL_LIMITS.maximumInputBytes),
  });
}

function parseAck(value: unknown): XrAckMessage {
  const body = exactObject(value, [...COMMON_KEYS, "status"], [...COMMON_KEYS, "status"], "$");
  const envelope = parseEnvelope(body);
  if (envelope.messageType !== "ack") throw new XrProtocolValidationError("must equal ack", "$.messageType");
  return Object.freeze({
    ...envelope,
    messageType: "ack",
    status: enumValue<XrAckStatus>(body.status, XR_ACK_STATUSES, "$.status"),
  });
}

function parseError(value: unknown): XrErrorMessage {
  const required = [...COMMON_KEYS, "code", "message", "retryable"];
  const body = exactObject(
    value,
    [...required, "expectedRevision", "expectedAuthorityEpoch"],
    required,
    "$",
  );
  const envelope = parseEnvelope(body);
  if (envelope.messageType !== "error") throw new XrProtocolValidationError("must equal error", "$.messageType");
  if (typeof body.retryable !== "boolean") {
    throw new XrProtocolValidationError("must be a boolean", "$.retryable");
  }
  return Object.freeze({
    ...envelope,
    messageType: "error",
    code: enumValue<XrErrorCode>(body.code, XR_ERROR_CODES, "$.code"),
    message: boundedString(body.message, "$.message"),
    retryable: body.retryable,
    ...(body.expectedRevision === undefined
      ? {}
      : { expectedRevision: parseXrRevision(body.expectedRevision, "$.expectedRevision") }),
    ...(body.expectedAuthorityEpoch === undefined
      ? {}
      : { expectedAuthorityEpoch: parseXrOpaqueId(body.expectedAuthorityEpoch, "$.expectedAuthorityEpoch") }),
  });
}

export function parseXrRelayMessage(value: unknown): XrRelayMessage {
  const body = record(value, "$");
  const messageType = enumValue<XrMessageType>(body.messageType, XR_MESSAGE_TYPES, "$.messageType");
  switch (messageType) {
    case "snapshot": return parseSnapshot(value);
    case "delta": return parseDelta(value);
    case "ephemeral": return parseEphemeral(value);
    case "input": return parseInput(value);
    case "ack": return parseAck(value);
    case "error": return parseError(value);
  }
}

export function parseXrReconnectCursor(value: unknown): XrReconnectCursor {
  const keys = [
    "protocolVersion",
    "sessionId",
    "authorityEpoch",
    "workspaceId",
    "revision",
    "snapshotDigest",
    "requestId",
  ] as const;
  const body = exactObject(value, keys, keys, "$");
  if (body.protocolVersion !== XR_RELAY_PROTOCOL_VERSION) {
    throw new XrProtocolValidationError(`must equal ${XR_RELAY_PROTOCOL_VERSION}`, "$.protocolVersion");
  }
  return Object.freeze({
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    sessionId: parseXrOpaqueId(body.sessionId, "$.sessionId"),
    authorityEpoch: parseXrOpaqueId(body.authorityEpoch, "$.authorityEpoch"),
    workspaceId: parseXrWorkspaceId(body.workspaceId, "$.workspaceId"),
    revision: parseXrRevision(body.revision, "$.revision"),
    snapshotDigest: parseXrSha256(body.snapshotDigest, "$.snapshotDigest"),
    requestId: parseXrOpaqueId(body.requestId, "$.requestId"),
  });
}
