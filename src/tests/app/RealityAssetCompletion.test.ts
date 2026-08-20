import { describe, expect, it, vi } from "vitest";
import { RealityAssetCompletionLedger } from "../../app/realityAssetCompletion";

describe("RealityAssetCompletionLedger", () => {
  it("retains a locally committed import after a lost response and resolves an identical retry", async () => {
    const ledger = new RealityAssetCompletionLedger<{ assetId: string }>();
    const lostResponse = Object.assign(new Error("connection reset"), { code: "request_failed" });
    await expect(ledger.acknowledgeFirst(
      "candidate",
      "workspace:1",
      { assetId: "ra_exact" },
      async () => { throw lostResponse; },
    )).rejects.toBe(lostResponse);
    expect(ledger.has("candidate")).toBe(true);

    const retry = vi.fn(async () => { throw Object.assign(new Error("already consumed"), { status: 404 }); });
    await expect(ledger.acknowledgeRetry("candidate", "workspace:1", retry))
      .resolves.toEqual({ assetId: "ra_exact" });
    expect(retry).toHaveBeenCalledOnce();
    expect(ledger.has("candidate")).toBe(false);
  });

  it("clears a first-attempt definitive rejection so the caller can roll back", async () => {
    const ledger = new RealityAssetCompletionLedger<{ assetId: string }>();
    const rejection = Object.assign(new Error("expired"), { status: 410 });
    await expect(ledger.acknowledgeFirst(
      "candidate",
      "workspace:1",
      { assetId: "ra_exact" },
      async () => { throw rejection; },
    )).rejects.toBe(rejection);
    expect(ledger.has("candidate")).toBe(false);
  });

  it("never reuses a pending result across Workspace generations", async () => {
    const ledger = new RealityAssetCompletionLedger<{ assetId: string }>();
    await expect(ledger.acknowledgeFirst(
      "candidate",
      "workspace:1",
      { assetId: "ra_exact" },
      async () => { throw new Error("lost"); },
    )).rejects.toThrow("lost");
    expect(() => ledger.peek("candidate", "workspace:2")).toThrow(/different Workspace generation/u);
    ledger.clear();
    expect(ledger.has("candidate")).toBe(false);
  });
});
