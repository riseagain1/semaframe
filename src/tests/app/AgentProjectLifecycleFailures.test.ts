import { describe, expect, it, vi } from "vitest";
import {
  quiesceAgentBridgeForProjectReplacement,
  restoreAgentBrowserBridge,
  stopXrSessionsForProjectReplacement,
} from "../../app/lifecycle/AgentProjectLifecycle";

describe("agent project replacement failure cleanup", () => {
  it("keeps an already connected running bridge without reclaiming it", async () => {
    const client = { running: true, start: vi.fn(), stop: vi.fn() };
    const claim = vi.fn();
    await expect(restoreAgentBrowserBridge(client, { engineConnected: true }, claim)).resolves.toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("drains a rejected old loop before claiming a replacement bridge", async () => {
    const calls: string[] = [];
    const client = { running: true, start: vi.fn(async () => { throw new Error("old connection lost"); }),
      stop: vi.fn(() => { calls.push("stop"); }) };
    await expect(restoreAgentBrowserBridge(client, { engineConnected: false }, async () => {
      calls.push("claim"); return true;
    })).resolves.toBe(true);
    expect(calls).toEqual(["stop", "claim"]);
  });

  it("revokes trust and forces local disable even if all remote cleanup operations reject", async () => {
    const client = { running: true, start: vi.fn(async () => { throw new Error("poll failed"); }),
      stop: vi.fn(), disable: vi.fn(async () => { throw new Error("gateway gone"); }) };
    const revoke = vi.fn();
    await expect(quiesceAgentBridgeForProjectReplacement({ client, occupied: false, revoke,
      waitForTrustRevocation: async () => { throw new Error("trust already removed"); },
    })).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledOnce();
    expect(client.stop.mock.calls).toEqual([["disabled"], ["disabled"]]);
  });

  it("can quiesce with no client and describes unconfirmed XR teardown without a backend error", async () => {
    const revoke = vi.fn();
    await quiesceAgentBridgeForProjectReplacement({ occupied: false, revoke, waitForTrustRevocation: async () => undefined });
    expect(revoke).toHaveBeenCalledOnce();
    expect(await stopXrSessionsForProjectReplacement(undefined, undefined)).toEqual([]);
    expect(await stopXrSessionsForProjectReplacement({ exitFromUserGesture: async () => ({
      locallyReleased: false, teardownConfirmed: false,
    }) }, undefined)).toEqual([{ target: "same_device", reason: "XR teardown was not fully confirmed." }]);
  });
});
