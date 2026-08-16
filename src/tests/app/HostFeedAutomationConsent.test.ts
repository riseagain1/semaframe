import { describe, expect, it } from "vitest";
import {
  HostFeedAutomationConsentLedger,
  hostFeedAutomationPaused,
  hostFeedRefreshAllowed,
  type HostFeedAutomationDescriptor,
} from "../../app/hostFeedAutomationConsent";
import type {
  HostFeedFetchResponse,
  ResourceRefreshPolicy,
  WorkspaceHostFeedPreviewRequest,
  WorkspaceHostFeedSaveRequest,
} from "../../workspace/data";

const URL_A = "https://feeds.example.test/market.json";
const URL_B = "https://feeds.example.test/weather.json";

function feed(url = URL_A): HostFeedFetchResponse {
  const retrievedAt = "2026-08-15T05:06:07.000Z";
  return {
    version: 1,
    requestedUrl: url,
    finalUrl: url,
    format: "json",
    contentType: "application/json",
    retrievedAt,
    outputSchema: { type: "object" },
    snapshot: {
      data: { price: 188.4 },
      contentHash: "sha256:preview",
      retrievedAt,
      stale: false,
      provenance: [{ retrievedAt }],
    },
  };
}

function previewRequest(
  policy: ResourceRefreshPolicy,
  url = URL_A,
): WorkspaceHostFeedPreviewRequest {
  return { url, format: "json", policy };
}

function saveRequest(
  response: HostFeedFetchResponse,
  policy: ResourceRefreshPolicy,
): WorkspaceHostFeedSaveRequest {
  return {
    label: "Market",
    requestedFormat: "json",
    policy,
    feed: response,
  };
}

function descriptor(
  policy: ResourceRefreshPolicy,
  url = URL_A,
): HostFeedAutomationDescriptor {
  return { resourceId: "RES_feed", url, format: "json", policy };
}

describe("host feed automation consent", () => {
  it("keeps imported on-open and recovered interval policies paused without current UI consent", () => {
    const ledger = new HostFeedAutomationConsentLedger();
    const policies: ResourceRefreshPolicy[] = [
      { mode: "on_open", offline: "keep_last_good" },
      { mode: "interval", intervalMs: 30_000, offline: "keep_last_good" },
    ];

    for (const policy of policies) {
      // Supplying canonical project/resource state to App reconciliation can
      // only revoke. It must never infer network authority from that state.
      ledger.reconcile([descriptor(policy)]);
      expect(ledger.isAuthorized(descriptor(policy))).toBe(false);
      expect(hostFeedAutomationPaused(descriptor(policy), ledger)).toBe(true);
    }
  });

  it("allows an explicit manual Refresh while denying unapproved on-open and interval execution", () => {
    const ledger = new HostFeedAutomationConsentLedger();
    const importedInterval = descriptor({
      mode: "interval",
      intervalMs: 30_000,
      offline: "keep_last_good",
    });

    expect(hostFeedRefreshAllowed("manual", importedInterval, ledger)).toBe(true);
    expect(hostFeedRefreshAllowed("interval", importedInterval, ledger)).toBe(false);
    expect(hostFeedRefreshAllowed("on_open", importedInterval, ledger)).toBe(false);
  });

  it.each([
    { mode: "on_open", offline: "keep_last_good" } as const,
    { mode: "interval", intervalMs: 45_000, offline: "keep_last_good" } as const,
  ])("enables $mode only after the exact Preview plus Save sequence", (policy) => {
    const ledger = new HostFeedAutomationConsentLedger();
    const response = feed();
    const save = saveRequest(response, policy);

    expect(ledger.matchesPreview(save)).toBe(false);
    ledger.recordPreview(previewRequest(policy), response);
    expect(ledger.matchesPreview(save)).toBe(true);
    expect(ledger.authorizePreviewedSave("RES_feed", save)).toBe(true);
    expect(ledger.isAuthorized(descriptor(policy))).toBe(true);
    expect(hostFeedAutomationPaused(descriptor(policy), ledger)).toBe(false);

    // The approval is one-shot; project data or a repeated call cannot mint a
    // second resource authorization from the same response.
    expect(ledger.authorizePreviewedSave("RES_copy", save)).toBe(false);
  });

  it("revokes URL, format, and policy changes and does not revive an old grant when state changes back", () => {
    const policy: ResourceRefreshPolicy = {
      mode: "interval",
      intervalMs: 45_000,
      offline: "keep_last_good",
    };
    const ledger = new HostFeedAutomationConsentLedger();
    const response = feed();
    const save = saveRequest(response, policy);
    ledger.recordPreview(previewRequest(policy), response);
    expect(ledger.authorizePreviewedSave("RES_feed", save)).toBe(true);

    const changedUrl = descriptor(policy, URL_B);
    ledger.reconcile([changedUrl]);
    expect(hostFeedAutomationPaused(changedUrl, ledger)).toBe(true);
    ledger.reconcile([descriptor(policy)]);
    expect(hostFeedAutomationPaused(descriptor(policy), ledger)).toBe(true);

    const response2 = feed();
    ledger.recordPreview(previewRequest(policy), response2);
    expect(ledger.authorizePreviewedSave("RES_feed", saveRequest(response2, policy))).toBe(true);
    const changedFormat = { ...descriptor(policy), format: "csv" as const };
    ledger.reconcile([changedFormat]);
    expect(hostFeedAutomationPaused(changedFormat, ledger)).toBe(true);

    const response3 = feed();
    ledger.recordPreview(previewRequest(policy), response3);
    expect(ledger.authorizePreviewedSave("RES_feed", saveRequest(response3, policy))).toBe(true);
    const changedPolicy = descriptor({ mode: "on_open", offline: "keep_last_good" });
    ledger.reconcile([changedPolicy]);
    expect(hostFeedAutomationPaused(changedPolicy, ledger)).toBe(true);
  });

  it("clears both approvals and pending previews at every open/recovery/new Store generation", () => {
    const policy: ResourceRefreshPolicy = {
      mode: "interval",
      intervalMs: 45_000,
      offline: "keep_last_good",
    };
    const ledger = new HostFeedAutomationConsentLedger();
    const approvedResponse = feed();
    const approvedSave = saveRequest(approvedResponse, policy);
    ledger.recordPreview(previewRequest(policy), approvedResponse);
    expect(ledger.authorizePreviewedSave("RES_feed", approvedSave)).toBe(true);

    const pendingResponse = feed();
    const pendingSave = saveRequest(pendingResponse, policy);
    ledger.recordPreview(previewRequest(policy), pendingResponse);
    ledger.reset();

    expect(ledger.isAuthorized(descriptor(policy))).toBe(false);
    expect(ledger.matchesPreview(pendingSave)).toBe(false);
    expect(ledger.authorizePreviewedSave("RES_feed", pendingSave)).toBe(false);
    expect(hostFeedAutomationPaused(descriptor(policy), ledger)).toBe(true);
  });

  it("rejects a cloned or policy-changed response that did not come from the current exact preview", () => {
    const interval: ResourceRefreshPolicy = {
      mode: "interval",
      intervalMs: 45_000,
      offline: "keep_last_good",
    };
    const response = feed();
    const ledger = new HostFeedAutomationConsentLedger();
    ledger.recordPreview(previewRequest(interval), response);

    expect(ledger.matchesPreview(saveRequest(structuredClone(response), interval))).toBe(false);
    expect(ledger.matchesPreview(saveRequest(response, {
      mode: "interval",
      intervalMs: 60_000,
      offline: "keep_last_good",
    }))).toBe(false);
  });
});
