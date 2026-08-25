import { describe, expect, it, vi } from "vitest";
import {
  assertRealityAssetCandidatePurpose,
  PhotoReconstructionCancellationTracker,
  RealityAssetCandidatePurposeError,
  RealityAssetCompletionLedger,
  RetainedRealityAssetCandidateError,
} from "../../app/realityAssetCompletion";

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

  it("returns the same completed result after a successful acknowledgement was already consumed", async () => {
    const ledger = new RealityAssetCompletionLedger<{ assetId: string }>();
    const value = { assetId: "ra_completed" };
    const acknowledge = vi.fn(async () => undefined);

    await expect(ledger.acknowledgeFirst("candidate_completed", "workspace:1", value, acknowledge))
      .resolves.toEqual(value);

    expect(ledger.has("candidate_completed")).toBe(false);
    expect(ledger.peekCompleted("candidate_completed", "workspace:1")).toEqual(value);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("bounds completed results and isolates them by Workspace generation", async () => {
    const ledger = new RealityAssetCompletionLedger<{ assetId: string }>(2);
    const acknowledge = async () => undefined;
    await ledger.acknowledgeFirst("candidate-1", "workspace:1", { assetId: "ra_1" }, acknowledge);
    await ledger.acknowledgeFirst("candidate-2", "workspace:1", { assetId: "ra_2" }, acknowledge);
    await ledger.acknowledgeFirst("candidate-3", "workspace:1", { assetId: "ra_3" }, acknowledge);

    expect(ledger.peekCompleted("candidate-1", "workspace:1")).toBeUndefined();
    expect(ledger.peekCompleted("candidate-2", "workspace:1")).toEqual({ assetId: "ra_2" });
    expect(() => ledger.peekCompleted("candidate-2", "workspace:2"))
      .toThrow(/different Workspace generation/u);
    ledger.clear();
    expect(ledger.peekCompleted("candidate-2", "workspace:1")).toBeUndefined();
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

  it("rejects a photo candidate on the generic path without consuming its pending dedicated retry", async () => {
    const ledger = new RealityAssetCompletionLedger<{ purpose: "photo_reconstruction"; assetId: string }>();
    await expect(ledger.acknowledgeFirst(
      "candidate-photo",
      "workspace:1",
      { purpose: "photo_reconstruction", assetId: "ra_photo" },
      async () => { throw new Error("lost acknowledgement"); },
    )).rejects.toThrow("lost acknowledgement");

    const pending = ledger.peek("candidate-photo", "workspace:1");
    expect(() => assertRealityAssetCandidatePurpose(pending!.purpose, "agent"))
      .toThrow(RealityAssetCandidatePurposeError);
    try {
      assertRealityAssetCandidatePurpose(pending!.purpose, "agent");
    } catch (error) {
      expect(error).toBeInstanceOf(RetainedRealityAssetCandidateError);
    }
    expect(ledger.has("candidate-photo")).toBe(true);
    expect(() => assertRealityAssetCandidatePurpose(pending!.purpose, "photo-reconstruction")).not.toThrow();
    await expect(ledger.acknowledgeRetry("candidate-photo", "workspace:1", async () => undefined))
      .resolves.toEqual(pending);
  });

  it("rejects a generic candidate on the dedicated path without cross-source reuse of a completed handle", async () => {
    const ledger = new RealityAssetCompletionLedger<{ purpose: "generic_import"; assetId: string }>();
    await ledger.acknowledgeFirst(
      "candidate-generic",
      "workspace:1",
      { purpose: "generic_import", assetId: "ra_generic" },
      async () => undefined,
    );

    const completed = ledger.peekCompleted("candidate-generic", "workspace:1");
    expect(() => assertRealityAssetCandidatePurpose(completed!.purpose, "photo-reconstruction"))
      .toThrow(RealityAssetCandidatePurposeError);
    expect(ledger.peekCompleted("candidate-generic", "workspace:1")).toEqual(completed);
    expect(() => assertRealityAssetCandidatePurpose(completed!.purpose, "agent")).not.toThrow();
  });
});

describe("PhotoReconstructionCancellationTracker", () => {
  const active = { jobId: "recon_1", workspaceId: "workspace_1" } as const;

  it("coalesces concurrent cancellation and requires an exact cancelled confirmation", async () => {
    const tracker = new PhotoReconstructionCancellationTracker<{
      jobId: string;
      workspaceId: string;
      status: string;
    }>();
    let resolveCancellation!: (job: { jobId: string; workspaceId: string; status: string }) => void;
    const cancel = vi.fn(() => new Promise<{ jobId: string; workspaceId: string; status: string }>((resolve) => {
      resolveCancellation = resolve;
    }));

    const first = tracker.confirm(active, cancel);
    const second = tracker.confirm(active, cancel);
    expect(first).toBe(second);
    await Promise.resolve();
    resolveCancellation({ ...active, status: "cancelled" });
    await expect(first).resolves.toMatchObject({ ...active, status: "cancelled" });
    expect(cancel).toHaveBeenCalledOnce();

    await expect(tracker.confirm(active, async () => ({ ...active, status: "running" })))
      .rejects.toThrow(/not confirmed/u);
  });

  it("forgets a failed request so an explicit cancellation retry can be confirmed", async () => {
    const tracker = new PhotoReconstructionCancellationTracker<{
      jobId: string;
      workspaceId: string;
      status: string;
    }>();
    const cancel = vi.fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ ...active, status: "cancelled" });

    await expect(tracker.confirm(active, cancel)).rejects.toThrow("gateway unavailable");
    await expect(tracker.confirm(active, cancel)).resolves.toMatchObject({ status: "cancelled" });
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
