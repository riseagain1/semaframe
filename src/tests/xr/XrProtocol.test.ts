import { describe, expect, it } from "vitest";
import {
  XR_RELAY_PROTOCOL_VERSION,
  XrProtocolValidationError,
  parseXrReconnectCursor,
  parseXrRelayMessage,
  parseXrSessionRole,
} from "../../xr/protocol";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const envelope = {
  protocolVersion: XR_RELAY_PROTOCOL_VERSION,
  sessionId: "session-0001",
  authorityEpoch: "epoch-000001",
  workspaceId: "workspace-xr",
  revision: 4,
  requestId: "request-0001",
} as const;

const messages = [
  {
    ...envelope,
    messageType: "snapshot",
    registryDigest: DIGEST_A,
    snapshotDigest: DIGEST_B,
    snapshot: { components: [{ id: "CMP_1" }] },
  },
  {
    ...envelope,
    messageType: "delta",
    baseRevision: 3,
    baseSnapshotDigest: DIGEST_A,
    snapshotDigest: DIGEST_B,
    delta: { operations: [{ op: "replace" }] },
  },
  {
    ...envelope,
    messageType: "ephemeral",
    channel: "preview.transform",
    sequence: 7,
    payload: { componentId: "CMP_1" },
  },
  {
    ...envelope,
    messageType: "input",
    inputType: "panel_action",
    payload: { componentId: "CMP_1", actionId: "start" },
  },
  { ...envelope, messageType: "ack", status: "accepted" },
  {
    ...envelope,
    messageType: "error",
    code: "stale_revision",
    message: "Refresh the committed projection.",
    retryable: true,
    expectedRevision: 5,
    expectedAuthorityEpoch: "epoch-000002",
  },
] as const;

describe("XR Relay Protocol 1 exact validation", () => {
  it.each(messages)("accepts the closed $messageType message", (message) => {
    expect(parseXrRelayMessage(message)).toEqual(message);
  });

  it.each(messages)("rejects unknown fields on $messageType", (message) => {
    expect(() => parseXrRelayMessage({ ...message, surprise: true })).toThrow(/unknown field surprise/u);
  });

  it("rejects invalid roles, identifiers, revisions, enums, and digests", () => {
    expect(parseXrSessionRole("authority")).toBe("authority");
    expect(parseXrSessionRole("xr_renderer")).toBe("xr_renderer");
    expect(() => parseXrSessionRole("server")).toThrow(XrProtocolValidationError);
    expect(() => parseXrRelayMessage({ ...messages[0], sessionId: "short" })).toThrow(/opaque identifier/u);
    expect(() => parseXrRelayMessage({ ...messages[0], revision: -1 })).toThrow(/non-negative/u);
    expect(() => parseXrRelayMessage({ ...messages[0], registryDigest: `sha256:${"A".repeat(64)}` }))
      .toThrow(/lowercase sha256/u);
    expect(() => parseXrRelayMessage({ ...messages[3], inputType: "workspace_mutation" }))
      .toThrow(/must be one of/u);
  });

  it("deep-clones bounded JSON and rejects dangerous, non-finite, deep, and oversized payloads", () => {
    const source = { nested: { value: 1 } };
    const parsed = parseXrRelayMessage({ ...messages[3], payload: source });
    source.nested.value = 2;
    expect(parsed.messageType === "input" && parsed.payload.nested).toEqual({ value: 1 });
    expect(Object.isFrozen(parsed.messageType === "input" ? parsed.payload : {})).toBe(true);

    const poisoned = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => parseXrRelayMessage({ ...messages[3], payload: poisoned })).toThrow(/dangerous key/u);
    expect(() => parseXrRelayMessage({ ...messages[3], payload: { x: Number.NaN } })).toThrow(/finite/u);
    const sparse = new Array(2);
    sparse[1] = "present";
    expect(() => parseXrRelayMessage({ ...messages[3], payload: { sparse } })).toThrow(/dense/u);
    expect(() => parseXrRelayMessage({
      ...messages[3],
      payload: { [Symbol("hidden")]: true },
    })).toThrow(/symbol keys/u);

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 30; index += 1) deep = { nested: deep };
    expect(() => parseXrRelayMessage({ ...messages[3], payload: deep })).toThrow(/depth limit/u);
    expect(() => parseXrRelayMessage({ ...messages[3], payload: { text: "x".repeat(70 * 1024) } }))
      .toThrow(/encoded JSON exceeds/u);
  });

  it("validates reconnect cursors as a separate closed request", () => {
    const cursor = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      sessionId: "session-0001",
      authorityEpoch: "epoch-000001",
      workspaceId: "workspace-xr",
      revision: 4,
      snapshotDigest: DIGEST_B,
      requestId: "reconnect-0001",
    } as const;
    expect(parseXrReconnectCursor(cursor)).toEqual(cursor);
    expect(() => parseXrReconnectCursor({ ...cursor, takeover: true })).toThrow(/unknown field takeover/u);
    expect(() => parseXrReconnectCursor({ ...cursor, revision: 4.5 })).toThrow(/safe integer/u);
  });
});
