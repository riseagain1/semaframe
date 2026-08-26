import type {
  XrAuthorityConnectionView,
  XrAuthorityPairingGrant,
} from "../authority/XrAuthorityController";
import type {
  XrAssetDescriptor,
  XrAssetDigest,
  XrAssetFormat,
} from "../assets/contracts";
import {
  parseXrAssetDescriptor,
  parseXrAssetDigest,
} from "../assets/validation";
import type {
  XrViewerReconnectDelivery,
  XrViewerIncomingMessage,
  XrViewerSessionIdentity,
} from "../app/contracts";
import {
  parseXrOpaqueId,
  parseXrReconnectCursor,
  parseXrRelayMessage,
  parseXrRevision,
  parseXrSha256,
  parseXrWorkspaceId,
  type XrAckMessage,
  type XrDeltaMessage,
  type XrEphemeralMessage,
  type XrErrorMessage,
  type XrInputMessage,
  type XrReconnectCursor,
  type XrRelayMessage,
  type XrRoutableMessage,
  type XrSnapshotMessage,
} from "../protocol";
import { XrNetworkError } from "./contracts";
import { XR_HTTP_POLL_MODE } from "./paths";

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type XrPrivateCredential = Readonly<{
  sessionId: string;
  sessionBearer: string;
}>;

export type XrParsedConnection = Readonly<{
  identity: XrViewerSessionIdentity;
  credential: XrPrivateCredential;
  role: "authority" | "xr_renderer";
  connectedAtMs: number;
  pairingId?: string;
  voiceRelayAllowed: boolean;
}>;

export type XrReconnectDelivery = XrViewerReconnectDelivery;

export type XrParsedAssetPutResult = Readonly<{
  descriptor: XrAssetDescriptor;
  createdAtMs: number;
  expiresAtMs: number;
  deduplicated: boolean;
  evictedDigests: readonly XrAssetDigest[];
}>;

export type XrPollDelivery<T extends XrRelayMessage = XrRoutableMessage> = Readonly<{
  deliveryId: string;
  message: T;
  sourceSessionId?: string;
}>;

type XrParsedAuthorityPollDelivery = XrPollDelivery<XrInputMessage | XrEphemeralMessage> & Readonly<{
  sourceSessionId: string;
  serverReceivedAtMs: number;
  serverQueueAgeMs: number;
}>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const result = record(value);
  const allowedSet = new Set(allowed);
  if (Object.keys(result).some((key) => !allowedSet.has(key))
    || required.some((key) => !Object.hasOwn(result, key))) {
    throw invalidResponse();
  }
  return result;
}

function invalidResponse(): XrNetworkError {
  return new XrNetworkError(
    "invalid_response",
    "The XR relay returned an invalid response.",
    false,
  );
}

export function strictResponse<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof XrNetworkError) throw error;
    throw invalidResponse();
  }
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalidResponse();
  return Number(value);
}

function boundedString(value: unknown, maximum = 2_000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function capability(value: unknown): string {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) throw invalidResponse();
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
    const decoded = globalThis.atob(padded);
    if (decoded.length !== 32) throw invalidResponse();
  } catch (error) {
    if (error instanceof XrNetworkError) throw error;
    throw invalidResponse();
  }
  return value;
}

function statusMessage(status: number): string {
  if (status === 401) return "XR authentication failed.";
  if (status === 403) return "The XR operation is not allowed.";
  if (status === 409) return "The XR session state changed.";
  if (status === 429) return "The XR relay is busy.";
  if (status >= 500) return "The XR relay is temporarily unavailable.";
  return "The XR relay rejected the request.";
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function parseHttpEnvelope(value: unknown, status: number): unknown {
  if (status >= 200 && status < 300) {
    const body = exact(value, ["ok", "data"], ["ok", "data"]);
    if (body.ok !== true) throw invalidResponse();
    return body.data;
  }
  const body = exact(value, ["ok", "error"], ["ok", "error"]);
  if (body.ok !== false) throw invalidResponse();
  const error = exact(body.error, ["code", "message"], ["code", "message"]);
  const code = boundedString(error.code, 64);
  boundedString(error.message, 500);
  if (!ERROR_CODE_PATTERN.test(code)) throw invalidResponse();
  throw new XrNetworkError(code, statusMessage(status), retryableStatus(status), status);
}

function parseConnection(value: unknown, expectedRole: "authority" | "xr_renderer"): XrParsedConnection {
  const allowed = [
    "sessionId",
    "role",
    "authorityEpoch",
    "workspaceId",
    "connectedAtMs",
    "sessionBearer",
    ...(expectedRole === "xr_renderer" ? ["pairingId", "capabilities"] : []),
  ];
  const body = exact(value, allowed, allowed);
  if (body.role !== expectedRole) throw invalidResponse();
  const identity = Object.freeze({
    sessionId: parseXrOpaqueId(body.sessionId, "$.sessionId"),
    authorityEpoch: parseXrOpaqueId(body.authorityEpoch, "$.authorityEpoch"),
    workspaceId: parseXrWorkspaceId(body.workspaceId, "$.workspaceId"),
  });
  const pairingId = expectedRole === "xr_renderer"
    ? parseXrOpaqueId(body.pairingId, "$.pairingId")
    : undefined;
  const capabilities = expectedRole === "xr_renderer"
    ? exact(body.capabilities, ["voiceRelay"], ["voiceRelay"])
    : undefined;
  if (capabilities && typeof capabilities.voiceRelay !== "boolean") throw invalidResponse();
  return Object.freeze({
    identity,
    credential: Object.freeze({
      sessionId: identity.sessionId,
      sessionBearer: capability(body.sessionBearer),
    }),
    role: expectedRole,
    connectedAtMs: safeInteger(body.connectedAtMs),
    ...(pairingId === undefined ? {} : { pairingId }),
    voiceRelayAllowed: capabilities?.voiceRelay === true,
  });
}

export function parseAuthorityConnection(value: unknown): XrParsedConnection {
  return parseConnection(value, "authority");
}

export function parseViewerConnection(value: unknown): XrParsedConnection {
  return parseConnection(value, "xr_renderer");
}

export function authorityConnectionView(value: XrParsedConnection): XrAuthorityConnectionView {
  return Object.freeze({ ...value.identity });
}

export function parsePairingGrant(
  value: unknown,
  authority: XrViewerSessionIdentity,
): XrAuthorityPairingGrant {
  const body = exact(
    value,
    ["pairingId", "pairingToken", "workspaceId", "authorityEpoch", "expiresAtMs"],
    ["pairingId", "pairingToken", "workspaceId", "authorityEpoch", "expiresAtMs"],
  );
  const grant = Object.freeze({
    pairingId: parseXrOpaqueId(body.pairingId, "$.pairingId"),
    pairingToken: capability(body.pairingToken),
    workspaceId: parseXrWorkspaceId(body.workspaceId, "$.workspaceId"),
    authorityEpoch: parseXrOpaqueId(body.authorityEpoch, "$.authorityEpoch"),
    expiresAtMs: safeInteger(body.expiresAtMs),
  });
  if (grant.workspaceId !== authority.workspaceId || grant.authorityEpoch !== authority.authorityEpoch) {
    throw invalidResponse();
  }
  return grant;
}

function assertOwnIdentity(
  message: XrRelayMessage,
  identity: XrViewerSessionIdentity,
): void {
  if (message.sessionId !== identity.sessionId
    || message.authorityEpoch !== identity.authorityEpoch
    || message.workspaceId !== identity.workspaceId) {
    throw new XrNetworkError(
      "session_mismatch",
      "The XR relay response belongs to another session.",
      false,
    );
  }
}

export function parseSendResponse(
  value: unknown,
  identity: XrViewerSessionIdentity,
): XrAckMessage | XrErrorMessage {
  const body = exact(value, ["response"], ["response"]);
  const response = parseXrRelayMessage(body.response);
  if (response.messageType !== "ack" && response.messageType !== "error") throw invalidResponse();
  assertOwnIdentity(response, identity);
  return response;
}

function parsePollEnvelope(
  value: unknown,
  sourceProvenance: "required" | "forbidden",
): readonly Readonly<{
  deliveryId: string;
  message: XrRelayMessage;
  sourceSessionId?: string;
  serverReceivedAtMs?: number;
  serverQueueAgeMs?: number;
}>[] {
  const body = exact(value, ["mode", "deliveries"], ["mode", "deliveries"]);
  if (body.mode !== XR_HTTP_POLL_MODE || !Array.isArray(body.deliveries) || body.deliveries.length > 512) {
    throw invalidResponse();
  }
  const deliveries = body.deliveries.map((value, index) => {
    const delivery = sourceProvenance === "required"
      ? exact(
          value,
          ["deliveryId", "message", "sourceSessionId", "serverReceivedAtMs", "serverQueueAgeMs"],
          ["deliveryId", "message", "sourceSessionId", "serverReceivedAtMs", "serverQueueAgeMs"],
        )
      : exact(value, ["deliveryId", "message"], ["deliveryId", "message"]);
    return Object.freeze({
      deliveryId: parseXrOpaqueId(delivery.deliveryId, `$.deliveries[${index}].deliveryId`),
      message: parseXrRelayMessage(delivery.message),
      ...(sourceProvenance === "required"
        ? {
            sourceSessionId: parseXrOpaqueId(delivery.sourceSessionId, `$.deliveries[${index}].sourceSessionId`),
            serverReceivedAtMs: safeInteger(delivery.serverReceivedAtMs),
            serverQueueAgeMs: safeInteger(delivery.serverQueueAgeMs),
          }
        : {}),
    });
  });
  if (new Set(deliveries.map(({ deliveryId }) => deliveryId)).size !== deliveries.length) {
    throw invalidResponse();
  }
  return Object.freeze(deliveries);
}

export function parseAuthorityPoll(
  value: unknown,
  identity: XrViewerSessionIdentity,
): readonly XrParsedAuthorityPollDelivery[] {
  const parsed = parsePollEnvelope(value, "required");
  for (const { message } of parsed) {
    if (message.messageType !== "input" && message.messageType !== "ephemeral") throw invalidResponse();
    assertOwnIdentity(message, identity);
  }
  return Object.freeze(parsed as XrParsedAuthorityPollDelivery[]);
}

export function parseViewerPoll(
  value: unknown,
  identity: XrViewerSessionIdentity,
): readonly XrPollDelivery<XrViewerIncomingMessage>[] {
  const parsed = parsePollEnvelope(value, "forbidden");
  for (const { message } of parsed) {
    if (message.messageType !== "snapshot"
      && message.messageType !== "delta"
      && message.messageType !== "ephemeral"
      && message.messageType !== "error") throw invalidResponse();
    assertOwnIdentity(message, identity);
  }
  return Object.freeze(parsed as XrPollDelivery<XrViewerIncomingMessage>[]);
}

export function parseRevocation(value: unknown): boolean {
  const body = exact(value, ["revoked"], ["revoked"]);
  if (typeof body.revoked !== "boolean") throw invalidResponse();
  return body.revoked;
}

export function parseDisconnect(value: unknown): void {
  const body = exact(value, ["disconnected"], ["disconnected"]);
  if (body.disconnected !== true) throw invalidResponse();
}

export function parseAssetPutResult(
  value: unknown,
  expected: Readonly<{
    digest: XrAssetDigest;
    format: XrAssetFormat;
    byteLength: number;
  }>,
): XrParsedAssetPutResult {
  const body = exact(
    value,
    ["descriptor", "createdAtMs", "expiresAtMs", "deduplicated", "evictedDigests"],
    ["descriptor", "createdAtMs", "expiresAtMs", "deduplicated", "evictedDigests"],
  );
  const descriptor = parseXrAssetDescriptor(body.descriptor);
  const createdAtMs = safeInteger(body.createdAtMs);
  const expiresAtMs = safeInteger(body.expiresAtMs);
  if (descriptor.digest !== expected.digest
    || descriptor.format !== expected.format
    || descriptor.byteLength !== expected.byteLength
    || expiresAtMs < createdAtMs
    || typeof body.deduplicated !== "boolean"
    || !Array.isArray(body.evictedDigests)
    || body.evictedDigests.length > 128) {
    throw invalidResponse();
  }
  const evictedDigests = body.evictedDigests.map((digest, index) => (
    parseXrAssetDigest(digest, `$.evictedDigests[${index}]`)
  ));
  if (new Set(evictedDigests).size !== evictedDigests.length) throw invalidResponse();
  return Object.freeze({
    descriptor,
    createdAtMs,
    expiresAtMs,
    deduplicated: body.deduplicated,
    evictedDigests: Object.freeze(evictedDigests),
  });
}

function parsePlanMetadata(
  body: Record<string, unknown>,
  identity: XrViewerSessionIdentity,
  requestId: string,
): Readonly<{ revision: number; snapshotDigest: `sha256:${string}` }> {
  if (parseXrOpaqueId(body.authorityEpoch, "$.authorityEpoch") !== identity.authorityEpoch
    || parseXrWorkspaceId(body.workspaceId, "$.workspaceId") !== identity.workspaceId
    || parseXrOpaqueId(body.requestId, "$.requestId") !== requestId) {
    throw new XrNetworkError(
      "session_mismatch",
      "The XR reconnect plan belongs to another session.",
      false,
    );
  }
  return Object.freeze({
    revision: parseXrRevision(body.revision, "$.revision"),
    snapshotDigest: parseXrSha256(body.snapshotDigest, "$.snapshotDigest"),
  });
}

function checkedDeltaChain(
  values: unknown,
  identity: XrViewerSessionIdentity,
  fromRevision: number,
  fromDigest: `sha256:${string}`,
  finalRevision: number,
  finalDigest: `sha256:${string}`,
): readonly XrDeltaMessage[] {
  if (!Array.isArray(values) || values.length > 128) throw invalidResponse();
  const deltas = values.map((entry) => parseXrRelayMessage(entry));
  let expectedRevision = fromRevision;
  let expectedDigest = fromDigest;
  for (const message of deltas) {
    if (message.messageType !== "delta") throw invalidResponse();
    assertOwnIdentity(message, identity);
    if (message.baseRevision !== expectedRevision
      || message.revision !== expectedRevision + 1
      || message.baseSnapshotDigest !== expectedDigest) {
      throw invalidResponse();
    }
    expectedRevision = message.revision;
    expectedDigest = message.snapshotDigest;
  }
  if (expectedRevision !== finalRevision || expectedDigest !== finalDigest) throw invalidResponse();
  return Object.freeze(deltas as XrDeltaMessage[]);
}

export function parseReconnectDelivery(
  value: unknown,
  identity: XrViewerSessionIdentity,
  cursor: XrReconnectCursor,
): XrReconnectDelivery {
  const envelope = exact(value, ["plan"], ["plan"]);
  const planRecord = record(envelope.plan);
  if (Object.hasOwn(planRecord, "messageType")) {
    const message = parseXrRelayMessage(planRecord);
    if (message.messageType !== "error") throw invalidResponse();
    assertOwnIdentity(message, identity);
    throw new XrNetworkError(
      message.code,
      "The XR relay rejected reconnect.",
      message.retryable,
    );
  }
  const kind = planRecord.kind;
  if (kind === "unavailable") {
    const plan = exact(
      planRecord,
      ["kind", "reason", "workspaceId", "requestId"],
      ["kind", "reason", "workspaceId", "requestId"],
    );
    if ((plan.reason !== "authority_unavailable" && plan.reason !== "awaiting_snapshot")
      || parseXrWorkspaceId(plan.workspaceId, "$.workspaceId") !== identity.workspaceId
      || parseXrOpaqueId(plan.requestId, "$.requestId") !== cursor.requestId) {
      throw invalidResponse();
    }
    throw new XrNetworkError(
      "authority_unavailable",
      "The XR authority is temporarily unavailable.",
      true,
    );
  }
  if (kind === "current") {
    const plan = exact(
      planRecord,
      ["kind", "authorityEpoch", "workspaceId", "revision", "snapshotDigest", "requestId"],
      ["kind", "authorityEpoch", "workspaceId", "revision", "snapshotDigest", "requestId"],
    );
    const metadata = parsePlanMetadata(plan, identity, cursor.requestId);
    if (metadata.revision !== cursor.revision || metadata.snapshotDigest !== cursor.snapshotDigest) {
      throw invalidResponse();
    }
    return Object.freeze({ kind: "current", messages: Object.freeze([]) });
  }
  if (kind === "deltas") {
    const plan = exact(
      planRecord,
      ["kind", "authorityEpoch", "workspaceId", "fromRevision", "revision", "snapshotDigest", "requestId", "deltas"],
      ["kind", "authorityEpoch", "workspaceId", "fromRevision", "revision", "snapshotDigest", "requestId", "deltas"],
    );
    const metadata = parsePlanMetadata(plan, identity, cursor.requestId);
    const fromRevision = parseXrRevision(plan.fromRevision, "$.fromRevision");
    if (fromRevision !== cursor.revision) throw invalidResponse();
    const deltas = checkedDeltaChain(
      plan.deltas,
      identity,
      fromRevision,
      cursor.snapshotDigest,
      metadata.revision,
      metadata.snapshotDigest,
    );
    return Object.freeze({ kind: "deltas", messages: deltas });
  }
  if (kind === "full_snapshot") {
    const plan = exact(
      planRecord,
      ["kind", "authorityEpoch", "workspaceId", "revision", "snapshotDigest", "requestId", "snapshot", "deltas"],
      ["kind", "authorityEpoch", "workspaceId", "revision", "snapshotDigest", "requestId", "snapshot", "deltas"],
    );
    const metadata = parsePlanMetadata(plan, identity, cursor.requestId);
    const snapshot = parseXrRelayMessage(plan.snapshot);
    if (snapshot.messageType !== "snapshot") throw invalidResponse();
    assertOwnIdentity(snapshot, identity);
    const deltas = checkedDeltaChain(
      plan.deltas,
      identity,
      snapshot.revision,
      snapshot.snapshotDigest,
      metadata.revision,
      metadata.snapshotDigest,
    );
    return Object.freeze({
      kind: "full_snapshot",
      messages: Object.freeze([snapshot, ...deltas]),
    });
  }
  throw invalidResponse();
}

export function parseReconnectCursorForIdentity(
  value: unknown,
  identity: XrViewerSessionIdentity,
): XrReconnectCursor {
  const cursor = parseXrReconnectCursor(value);
  if (cursor.sessionId !== identity.sessionId
    || cursor.authorityEpoch !== identity.authorityEpoch
    || cursor.workspaceId !== identity.workspaceId) {
    throw new XrNetworkError(
      "session_mismatch",
      "The XR reconnect cursor belongs to another session.",
      false,
    );
  }
  return cursor;
}

export function parseAuthorityOutgoing(
  value: unknown,
  identity: XrViewerSessionIdentity,
): XrRoutableMessage {
  const message = parseXrRelayMessage(value);
  if (message.messageType !== "snapshot"
    && message.messageType !== "delta"
    && message.messageType !== "ephemeral") throw invalidResponse();
  assertOwnIdentity(message, identity);
  return message;
}

export function parseViewerOutgoing(
  value: unknown,
  identity: XrViewerSessionIdentity,
): XrInputMessage {
  const message = parseXrRelayMessage(value);
  if (message.messageType !== "input") throw invalidResponse();
  assertOwnIdentity(message, identity);
  return message;
}
