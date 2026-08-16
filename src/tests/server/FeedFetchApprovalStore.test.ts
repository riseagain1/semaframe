import { describe, expect, it } from "vitest";
import {
  FeedFetchApprovalError,
  FeedFetchApprovalStore,
} from "../../../server/feed/FeedFetchApprovalStore";

describe("FeedFetchApprovalStore", () => {
  it("bounds outstanding approvals and evicts the oldest capability", () => {
    const store = new FeedFetchApprovalStore({ maxApprovals: 1 });
    const first = store.mint({ url: "https://one.example.org/feed.json", format: "json" });
    const second = store.mint({ url: "https://two.example.org/feed.json", format: "json" });

    expect(() => store.consume(first.approvalToken, first.request)).toThrow(FeedFetchApprovalError);
    expect(() => store.consume(second.approvalToken, second.request)).not.toThrow();
  });

  it("uses one canonical URL identity and consumes a matching token once", () => {
    const store = new FeedFetchApprovalStore();
    const approval = store.mint({
      url: "  https://feeds.example.org/feed.json  ",
    });
    expect(approval.request).toEqual({
      url: "https://feeds.example.org/feed.json",
      format: "auto",
    });
    expect(() => store.consume(approval.approvalToken, approval.request)).not.toThrow();
    expect(() => store.consume(approval.approvalToken, approval.request)).toThrow(FeedFetchApprovalError);
  });

  it.each([
    "https://feeds.example.org/feed.json?code=SuperSecretOAuthCode123456",
    "https://feeds.example.org/invite/0123456789abcdef0123456789abcdef/feed.json",
  ])("refuses to mint approval for capability URL %s", (url) => {
    const store = new FeedFetchApprovalStore();
    expect(() => store.mint({ url, format: "json" })).toThrow(/capabilit/iu);
  });
});
