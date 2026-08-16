import { describe, expect, it } from "vitest";
import { deterministicDigest } from "../../workspace/components";
import {
  assertWorkspaceResourceAgentWriteSafe,
  assertWorkspaceResourceSafe,
  isCanonicalHostFeedResource,
  type ResourceRefreshPolicy,
  type WorkspaceResource,
} from "../../workspace/data";

const data = { quote: { price: 188.4 }, symbol: "ACME" };
const retrievedAt = "2026-08-15T01:02:03.000Z";

function hostFeedResource(
  overrides: Partial<WorkspaceResource> = {},
  policy: ResourceRefreshPolicy = { mode: "manual", offline: "keep_last_good" },
): WorkspaceResource {
  return {
    id: "RES_host_feed",
    label: "ACME quote",
    connectorType: "http.feed",
    connectorVersion: "1.0.0",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["quote", "symbol"],
      properties: {
        quote: {
          type: "object",
          additionalProperties: false,
          required: ["price"],
          properties: { price: { type: "number" } },
        },
        symbol: { type: "string" },
      },
    },
    config: { url: "https://feeds.example.org/quote.json?symbol=ACME", format: "auto" },
    policy,
    snapshot: {
      data: structuredClone(data),
      contentHash: deterministicDigest(data),
      retrievedAt,
      stale: false,
      provenance: [{
        uri: "https://cdn.example.org/quote.json?symbol=ACME",
        publisher: "cdn.example.org",
        retrievedAt,
        citation: "https://cdn.example.org/quote.json?symbol=ACME",
      }],
    },
    status: "ready",
    ...overrides,
  };
}

describe("canonical durable host feed resources", () => {
  it.each<ResourceRefreshPolicy>([
    { mode: "manual", offline: "keep_last_good" },
    { mode: "on_open", offline: "show_error" },
    { mode: "interval", intervalMs: 30_000, offline: "keep_last_good" },
    { mode: "interval", intervalMs: 86_400_000, offline: "show_error" },
  ])("accepts a host-brokered snapshot with policy $mode", (policy) => {
    const resource = hostFeedResource({}, policy);
    expect(() => assertWorkspaceResourceSafe(resource)).not.toThrow();
    expect(isCanonicalHostFeedResource(resource)).toBe(true);
  });

  it("accepts one bounded inert provenance title", () => {
    const resource = hostFeedResource();
    resource.snapshot!.provenance[0]!.title = "Market Wire";
    expect(() => assertWorkspaceResourceSafe(resource)).not.toThrow();
  });

  it("rejects non-exact or non-canonical config without mutating it", () => {
    const variants: WorkspaceResource[] = [
      hostFeedResource({ config: { url: "https://feeds.example.org/quote.json", format: "auto", headers: {} } }),
      hostFeedResource({ config: { url: "https://feeds.example.org/quote.json" } }),
      hostFeedResource({ config: { url: "https://feeds.example.org:443/quote.json", format: "auto" } }),
      hostFeedResource({ config: { url: "http://feeds.example.org/quote.json", format: "auto" } }),
      hostFeedResource({ config: { url: "https://feeds.example.org/quote.json#section", format: "auto" } }),
      hostFeedResource({ config: { url: "https://feeds.example.org/quote.json?api_key=secret", format: "auto" } }),
      hostFeedResource({ config: { url: "https://feeds.example.org/quote.json?code=SuperSecretOAuthCode123456", format: "auto" } }),
      hostFeedResource({ config: { url: "https://feeds.example.org/invite/0123456789abcdef0123456789abcdef/feed.json", format: "auto" } }),
      hostFeedResource({ config: { url: "https://feeds.example.org/quote.json", format: "yaml" } }),
    ];
    const defaultPortUrl = variants[2]!.config.url;
    for (const variant of variants) {
      expect(() => assertWorkspaceResourceSafe(variant)).toThrow(/canonical host-owned form/u);
      expect(isCanonicalHostFeedResource(variant)).toBe(false);
    }
    expect(variants[2]!.config.url).toBe(defaultPortUrl);
  });

  it("rejects capability URLs in durable provenance while retaining readable routes", () => {
    const canonical = hostFeedResource();
    for (const url of [
      "https://cdn.example.org/quote.json?ticket=0123456789abcdef0123456789abcdef",
      "https://cdn.example.org/magic-link/SuperSecretOAuthCode123456/feed.json",
    ]) {
      const resource = hostFeedResource({ snapshot: {
        ...structuredClone(canonical.snapshot!),
        provenance: [{
          ...structuredClone(canonical.snapshot!.provenance[0]!),
          uri: url,
          citation: url,
        }],
      } });
      expect(() => assertWorkspaceResourceSafe(resource)).toThrow(/canonical host-owned form/u);
      expect(isCanonicalHostFeedResource(resource)).toBe(false);
    }

    const readable = hostFeedResource({
      config: { url: "https://feeds.example.org/login/enterprise-dashboard/feed.json", format: "auto" },
      snapshot: {
        ...structuredClone(canonical.snapshot!),
        provenance: [{
          ...structuredClone(canonical.snapshot!.provenance[0]!),
          uri: "https://cdn.example.org/invite/project-alpha/feed.json",
          citation: "https://cdn.example.org/invite/project-alpha/feed.json",
        }],
      },
    });
    expect(() => assertWorkspaceResourceSafe(readable)).not.toThrow();
    expect(isCanonicalHostFeedResource(readable)).toBe(true);
  });

  it("rejects unsupported versions, durable secrets, and non-canonical refresh policies", () => {
    const variants: WorkspaceResource[] = [
      hostFeedResource({ connectorVersion: "2.0.0" }),
      hostFeedResource({ secretRef: "SECRET_feed" }),
      hostFeedResource({}, { mode: "interval", intervalMs: 29_999, offline: "keep_last_good" }),
      hostFeedResource({}, { mode: "interval", intervalMs: 86_400_001, offline: "keep_last_good" }),
      hostFeedResource({}, { mode: "interval", intervalMs: 30_000.5, offline: "keep_last_good" }),
      hostFeedResource({}, { mode: "manual", intervalMs: 30_000, offline: "keep_last_good" }),
      hostFeedResource({}, { mode: "on_open", maxStaleMs: 60_000, offline: "show_error" }),
    ];
    for (const variant of variants) {
      expect(() => assertWorkspaceResourceSafe(variant)).toThrow(/canonical host-owned form/u);
    }
  });

  it("rejects missing or tampered host-owned snapshot fields", () => {
    const canonical = hostFeedResource();
    const variants: WorkspaceResource[] = [
      hostFeedResource({ snapshot: undefined }),
      hostFeedResource({ snapshot: { ...structuredClone(canonical.snapshot!), contentHash: "caller-hash" } }),
      hostFeedResource({ snapshot: { ...structuredClone(canonical.snapshot!), retrievedAt: "2026-08-15T01:02:03Z" } }),
      hostFeedResource({ snapshot: { ...structuredClone(canonical.snapshot!), stale: true } }),
      hostFeedResource({ snapshot: { ...structuredClone(canonical.snapshot!), provenance: [] } }),
      hostFeedResource({ snapshot: {
        ...structuredClone(canonical.snapshot!),
        provenance: [{ ...structuredClone(canonical.snapshot!.provenance[0]!), retrievedAt: "2026-08-15T01:02:04.000Z" }],
      } }),
      hostFeedResource({ snapshot: {
        ...structuredClone(canonical.snapshot!),
        provenance: [{ ...structuredClone(canonical.snapshot!.provenance[0]!), uri: "https://cdn.example.org:443/quote.json?symbol=ACME" }],
      } }),
      hostFeedResource({ snapshot: {
        ...structuredClone(canonical.snapshot!),
        provenance: [{ ...structuredClone(canonical.snapshot!.provenance[0]!), citation: "https://other.example.org/quote.json" }],
      } }),
      hostFeedResource({ snapshot: {
        ...structuredClone(canonical.snapshot!),
        provenance: [{ ...structuredClone(canonical.snapshot!.provenance[0]!), publisher: "CDN.EXAMPLE.ORG" }],
      } }),
      hostFeedResource({ snapshot: {
        ...structuredClone(canonical.snapshot!),
        provenance: [{ ...structuredClone(canonical.snapshot!.provenance[0]!), title: "unsafe\u0000title" }],
      } }),
      hostFeedResource({ status: "stale" }),
      hostFeedResource({ status: "error", lastError: "fetch failed" }),
      hostFeedResource({ lastError: "unexpected" }),
    ];
    for (const variant of variants) {
      expect(() => assertWorkspaceResourceSafe(variant)).toThrow();
      expect(isCanonicalHostFeedResource(variant)).toBe(false);
    }
  });

  it("keeps host-approved network execution unavailable to Agent writes", () => {
    expect(() => assertWorkspaceResourceAgentWriteSafe(hostFeedResource()))
      .toThrow(/not available for new Agent writes/u);
  });
});
