import { describe, expect, it } from "vitest";
import {
  createExplicitHostFeedMapping,
  deriveHostFeedMappingPresets,
  discoverHostFeedValuePaths,
  HostFeedContractError,
  normalizeHostFeedUrl,
  parseHostFeedFetchResponse,
} from "../../workspace/data";

const retrievedAt = "2026-08-15T03:04:05.000Z";

function response(data: unknown) {
  return {
    version: 1,
    requestedUrl: "https://feeds.example.test/market.json",
    finalUrl: "https://cdn.example.test/market.json",
    format: "json",
    contentType: "application/json",
    retrievedAt,
    outputSchema: { type: "object" },
    snapshot: {
      data,
      contentHash: "sha256:test",
      retrievedAt,
      stale: false,
      provenance: [{
        title: "Market feed",
        uri: "https://cdn.example.test/market.json",
        publisher: "Example Exchange",
        retrievedAt,
      }],
    },
  };
}

describe("host feed contracts", () => {
  it("accepts the exact v1 host response and rejects unsafe URLs or response drift", () => {
    const parsed = parseHostFeedFetchResponse(response({ quote: { price: 188.4 } }));
    expect(parsed).toMatchObject({
      version: 1,
      format: "json",
      requestedUrl: "https://feeds.example.test/market.json",
      snapshot: { stale: false, provenance: [{ publisher: "Example Exchange" }] },
    });
    expect(() => normalizeHostFeedUrl("http://feeds.example.test/data.json")).toThrow(/HTTPS/u);
    expect(() => normalizeHostFeedUrl("https://feeds.example.test/data.json?api_key=secret")).toThrow(/credential-like/u);
    expect(() => parseHostFeedFetchResponse({ ...response({ ok: true }), unexpected: true })).toThrow(HostFeedContractError);
  });

  it.each([
    "https://feeds.example.test/data.json?code=SuperSecretOAuthCode123456",
    "https://feeds.example.test/data.json?ticket=0123456789abcdef0123456789abcdef",
    "https://feeds.example.test/data.json?authorization_code=0123456789abcdef0123456789abcdef",
    "https://feeds.example.test/data.json?loginCode=0123456789abcdef0123456789abcdef",
    "https://feeds.example.test/data.json?oauth-code=0123456789abcdef0123456789abcdef",
    "https://feeds.example.test/data.json?verification%255Fcode=0123456789abcdef0123456789abcdef",
    "https://feeds.example.test/invite/0123456789abcdef0123456789abcdef/feed.json",
    "https://feeds.example.test/magic-login/SuperSecretOAuthCode123456",
    "https://feeds.example.test/callback/89c1d3fa-b344-4db8-a926-79c88d72d18f",
    `https://feeds.example.test/data.json?next=${encodeURIComponent("https://accounts.example.test/invite/0123456789abcdef0123456789abcdef")}`,
  ])("rejects authorization capability URL %s", (url) => {
    expect(() => normalizeHostFeedUrl(url)).toThrow(/capabilit/iu);
  });

  it.each([
    "https://feeds.example.test/data.json?code=US",
    "https://feeds.example.test/login/enterprise-dashboard/feed.json",
    "https://feeds.example.test/invite/project-alpha/feed.json",
    `https://feeds.example.test/data.json?next=${encodeURIComponent("https://docs.example.test/login/enterprise-dashboard")}`,
  ])("keeps ordinary readable feed URL %s", (url) => {
    expect(normalizeHostFeedUrl(url)).toBe(url);
  });

  it("rejects capability URLs returned in host-normalized response fields", () => {
    expect(() => parseHostFeedFetchResponse({
      ...response({ ok: true }),
      finalUrl: "https://cdn.example.test/invite/0123456789abcdef0123456789abcdef/feed.json",
    })).toThrow(/capabilit/iu);
  });

  it("derives closed mappings for data panels, normalized charts, record tables, and text documents", () => {
    const data = {
      labels: ["09:30", "09:31"],
      series: [{ id: "close", label: "Close", values: [188.4, 189.1] }],
      headline: "Market opens higher",
      stories: [
        { title: "Alpha", score: 4 },
        { title: "Beta", score: 7 },
      ],
    };
    const presets = deriveHostFeedMappingPresets(data);
    expect(presets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetType: "data-panel",
        bindings: [expect.objectContaining({ targetProp: "data", sourcePath: "$" })],
      }),
      expect.objectContaining({
        targetType: "chart",
        bindings: [
          expect.objectContaining({ targetProp: "labels", sourcePath: "$.labels" }),
          expect.objectContaining({ targetProp: "series", sourcePath: "$.series" }),
        ],
      }),
      expect.objectContaining({
        targetType: "table",
        bindings: [expect.objectContaining({ targetProp: "rows", sourcePath: "$.stories" })],
        initialProps: { columns: [
          { key: "score", label: "score", align: "left" },
          { key: "title", label: "title", align: "left" },
        ] },
      }),
      expect.objectContaining({ targetType: "text", bindings: [expect.objectContaining({ sourcePath: "$.headline" })] }),
      expect.objectContaining({ targetType: "document", bindings: [expect.objectContaining({ sourcePath: "$.headline" })] }),
    ]));

    expect(discoverHostFeedValuePaths(data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$", kind: "object" }),
      expect.objectContaining({ path: "$.stories", kind: "array" }),
      expect.objectContaining({ path: "$.headline", kind: "string" }),
    ]));
    expect(createExplicitHostFeedMapping({
      targetType: "document",
      targetProp: "content",
      sourcePath: "$.headline",
    })).toMatchObject({
      targetType: "document",
      bindings: [{ targetProp: "content", sourcePath: "$.headline", transform: { kind: "identity" } }],
    });
  });
});
