// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseAuthorityPoll, parseViewerPoll } from "../../xr/network/validation";
import {
  AUTHORITY_EPOCH,
  AUTHORITY_SESSION,
  VIEWER_SESSION,
  WORKSPACE_ID,
  input,
  snapshot,
} from "./fixtures";

const authorityIdentity = Object.freeze({
  sessionId: AUTHORITY_SESSION,
  authorityEpoch: AUTHORITY_EPOCH,
  workspaceId: WORKSPACE_ID,
});
const viewerIdentity = Object.freeze({
  sessionId: VIEWER_SESSION,
  authorityEpoch: AUTHORITY_EPOCH,
  workspaceId: WORKSPACE_ID,
});

function authorityDelivery(extra: Record<string, unknown> = {}) {
  return {
    deliveryId: "delivery-authority-timing-0001",
    message: input(AUTHORITY_SESSION),
    sourceSessionId: VIEWER_SESSION,
    serverReceivedAtMs: 10_000,
    serverQueueAgeMs: 275,
    ...extra,
  };
}

describe("XR poll delivery timing validation", () => {
  it("requires strict relay timing and authenticated provenance on authority deliveries", () => {
    expect(parseAuthorityPoll({
      mode: "immediate",
      deliveries: [authorityDelivery()],
    }, authorityIdentity)).toEqual([authorityDelivery()]);

    const { serverQueueAgeMs: _omittedQueueAge, ...missingQueueAge } = authorityDelivery();
    expect(() => parseAuthorityPoll({
      mode: "immediate",
      deliveries: [missingQueueAge],
    }, authorityIdentity)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
    expect(() => parseAuthorityPoll({
      mode: "immediate",
      deliveries: [authorityDelivery({ serverQueueAgeMs: -1 })],
    }, authorityIdentity)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
    expect(() => parseAuthorityPoll({
      mode: "immediate",
      deliveries: [authorityDelivery({ serverReceivedAtMs: 1.5 })],
    }, authorityIdentity)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });

  it("forbids authority-only timing and provenance fields on viewer deliveries", () => {
    const valid = {
      deliveryId: "delivery-viewer-timing-0001",
      message: snapshot(VIEWER_SESSION),
    };
    expect(parseViewerPoll({ mode: "immediate", deliveries: [valid] }, viewerIdentity)).toEqual([valid]);
    expect(() => parseViewerPoll({
      mode: "immediate",
      deliveries: [{
        ...valid,
        sourceSessionId: AUTHORITY_SESSION,
        serverReceivedAtMs: 10_000,
        serverQueueAgeMs: 0,
      }],
    }, viewerIdentity)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });
});
