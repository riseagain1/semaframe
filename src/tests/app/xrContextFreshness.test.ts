import { describe, expect, it } from "vitest";
import {
  isRemoteXrContextFresh,
  remoteXrContextKnownAgeMs,
} from "../../app/xrContextFreshness";

describe("remote XR context freshness", () => {
  it("uses the desktop receipt clock rather than the unrelated headset capture clock", () => {
    expect(isRemoteXrContextFresh({
      contextWorkspaceId: "workspace-a",
      contextWorkspaceRevision: 7,
      expectedWorkspaceId: "workspace-a",
      expectedWorkspaceRevision: 7,
      receivedAtMs: 99_500,
      nowMs: 100_000,
      relayQueueAgeMs: 300,
      sourceAgeMs: 20,
      trackingState: "tracked",
      maximumAgeMs: 1_000,
    })).toBe(true);
    expect(remoteXrContextKnownAgeMs({
      receivedAtMs: 99_500,
      nowMs: 100_000,
      relayQueueAgeMs: 300,
      sourceAgeMs: 20,
    })).toBe(820);
  });

  it("rejects stale, future, or wrong-revision desktop receipts", () => {
    const base = {
      contextWorkspaceId: "workspace-a",
      contextWorkspaceRevision: 7,
      expectedWorkspaceId: "workspace-a",
      expectedWorkspaceRevision: 7,
      receivedAtMs: 99_500,
      nowMs: 100_000,
      relayQueueAgeMs: 300,
      sourceAgeMs: 20,
      trackingState: "tracked" as const,
      maximumAgeMs: 1_000,
    } as const;
    expect(isRemoteXrContextFresh({ ...base, receivedAtMs: 98_999 })).toBe(false);
    expect(isRemoteXrContextFresh({ ...base, receivedAtMs: 100_001 })).toBe(false);
    expect(isRemoteXrContextFresh({ ...base, contextWorkspaceRevision: 8 })).toBe(false);
    expect(isRemoteXrContextFresh({ ...base, sourceAgeMs: 201 })).toBe(false);
    expect(isRemoteXrContextFresh({ ...base, relayQueueAgeMs: 501 })).toBe(false);
    expect(isRemoteXrContextFresh({ ...base, trackingState: "lost" })).toBe(false);
  });

  it("fails closed for invalid relay age and never compares relay and browser absolute timestamps", () => {
    const base = {
      contextWorkspaceId: "workspace-a",
      contextWorkspaceRevision: 7,
      expectedWorkspaceId: "workspace-a",
      expectedWorkspaceRevision: 7,
      receivedAtMs: 200_000,
      nowMs: 200_100,
      relayQueueAgeMs: 700,
      sourceAgeMs: 100,
      trackingState: "limited" as const,
      maximumAgeMs: 1_000,
    };
    expect(isRemoteXrContextFresh(base)).toBe(true);
    expect(isRemoteXrContextFresh({ ...base, relayQueueAgeMs: -1 })).toBe(false);
    expect(isRemoteXrContextFresh({ ...base, relayQueueAgeMs: 0.5 })).toBe(false);
    expect(remoteXrContextKnownAgeMs({
      receivedAtMs: base.receivedAtMs,
      nowMs: base.nowMs,
      relayQueueAgeMs: base.relayQueueAgeMs,
      sourceAgeMs: base.sourceAgeMs,
    })).toBe(900);
  });
});
