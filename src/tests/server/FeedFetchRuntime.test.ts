import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  FeedFetchError,
  FeedFetchRuntime,
  isPublicAddress,
} from "../../../server/feed/FeedFetchRuntime";
import { deterministicDigest } from "../../workspace/components/manifestDigest";
import { parseHostFeedFetchResponse } from "../../workspace/data/hostFeedContracts";
import { assertWorkspaceResourceSafe } from "../../workspace/data/resourceSecurity";

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 as const };
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function body(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function nestedRedirectUrl(depth: number, leaf: string): string {
  let nested = leaf;
  for (let index = 0; index < depth; index += 1) {
    nested = `https://redirect-${index}.example.org/continue?next=${encodeURIComponent(nested)}`;
  }
  return nested;
}

function successfulRuntime(
  response: Readonly<{
    status?: number;
    headers?: Readonly<Record<string, string | undefined>>;
    body: Uint8Array;
  }>,
  options: Readonly<{ now?: number }> = {},
) {
  const request = vi.fn(async () => ({
    status: response.status ?? 200,
    headers: response.headers ?? JSON_HEADERS,
    body: response.body,
  }));
  const lookup = vi.fn(async () => [PUBLIC_V4]);
  const runtime = new FeedFetchRuntime({
    lookup,
    request,
    now: () => options.now ?? 1_765_765_323_000,
  });
  return { runtime, lookup, request };
}

describe("FeedFetchRuntime target policy", () => {
  it("classifies private, link-local, metadata, transition, and public addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.1.2.3")).toBe(false);
    expect(isPublicAddress("100.100.100.200")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("168.63.129.16")).toBe(false);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
    expect(isPublicAddress("fc00::1")).toBe(false);
    expect(isPublicAddress("2001:db8::1")).toBe(false);
    expect(isPublicAddress("2001:2::1")).toBe(false);
    expect(isPublicAddress("2001:10::1")).toBe(false);
    expect(isPublicAddress("2002:5db8:d822::1")).toBe(false);
    expect(isPublicAddress("3fff::1")).toBe(false);
  });

  it.each([
    "http://example.com/feed.json",
    "https://user:password@example.com/feed.json",
    "https://example.com:8443/feed.json",
    "https://example.com/feed.json#fragment",
    "https://localhost/feed.json",
    "https://metadata/feed.json",
    "https://metadata.google.internal/feed.json",
    "https://127.0.0.1/feed.json",
    "https://[::1]/feed.json",
    "https://example.com/feed.json?api_key=secret",
    "https://example.com/feed.json?X-Amz-Signature=secret",
    "https://example.com/feed.json?q=Bearer%20abcdefghijk",
    "https://example.com/ghp_abcdefghijklmnopqrstuvwxyz/feed.json",
    "https://example.com/feed.json?code=SuperSecretOAuthCode123456",
    "https://example.com/feed.json?authorization_code=0123456789abcdef0123456789abcdef",
    "https://example.com/invite/0123456789abcdef0123456789abcdef/feed.json",
    "https://example.com/magic-login/SuperSecretOAuthCode123456",
    `https://example.com/continue?next=${encodeURIComponent("https://accounts.example.org/invite/0123456789abcdef0123456789abcdef")}`,
    `https://example.com/continue?next=${encodeURIComponent(encodeURIComponent("https://accounts.example.org/magic-login/SuperSecretOAuthCode123456"))}`,
    "https://example.com/feed.json?api%255Fkey=secret",
    "https://example.com/invite/0123456789abcdef0123456789abcdef;mode=preview/feed.json",
    "https://example.com/feed.json?view=full;code=SuperSecretOAuthCode123456",
  ])("rejects unsafe URL %s before any network request", async (url) => {
    const { runtime, request } = successfulRuntime({ body: body("{}") });
    await expect(runtime.fetch({ url })).rejects.toBeInstanceOf(FeedFetchError);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/feed.json?code=US",
    "https://example.com/login/enterprise-dashboard/feed.json",
    "https://example.com/invite/project-alpha/feed.json",
    `https://example.com/continue?next=${encodeURIComponent("https://docs.example.org/login/enterprise-dashboard")}`,
  ])("allows ordinary readable URL %s", async (url) => {
    const { runtime, request } = successfulRuntime({ body: body("{}") });
    await expect(runtime.fetch({ url })).resolves.toMatchObject({ requestedUrl: url });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects the entire DNS answer set when even one answer is unsafe", async () => {
    const request = vi.fn();
    const runtime = new FeedFetchRuntime({
      lookup: async () => [PUBLIC_V4, { address: "169.254.169.254", family: 4 }],
      request,
    });
    await expect(runtime.fetch({ url: "https://feeds.example.org/data.json" })).rejects.toMatchObject({
      code: "unsafe_feed_target",
      status: 403,
    });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("FeedFetchRuntime parsing and provenance", () => {
  it("pins JSON requests to a validated address and returns a host-stamped snapshot", async () => {
    const data = { prices: [187.4, 188.1], symbol: "ACME" };
    const { runtime, lookup, request } = successfulRuntime({ body: body(JSON.stringify(data)) });
    const result = await runtime.fetch({ url: "https://feeds.example.org/quotes.json?symbol=ACME" });

    expect(lookup).toHaveBeenCalledWith("feeds.example.org", expect.any(AbortSignal));
    expect(request).toHaveBeenCalledWith(
      new URL("https://feeds.example.org/quotes.json?symbol=ACME"),
      PUBLIC_V4,
      expect.any(Number),
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      version: 1,
      requestedUrl: "https://feeds.example.org/quotes.json?symbol=ACME",
      finalUrl: "https://feeds.example.org/quotes.json?symbol=ACME",
      format: "json",
      contentType: "application/json",
      retrievedAt: "2025-12-15T02:22:03.000Z",
      outputSchema: { type: "object" },
      snapshot: {
        data,
        contentHash: deterministicDigest(data),
        retrievedAt: "2025-12-15T02:22:03.000Z",
        stale: false,
        provenance: [{
          uri: "https://feeds.example.org/quotes.json?symbol=ACME",
          publisher: "feeds.example.org",
          retrievedAt: "2025-12-15T02:22:03.000Z",
          citation: "https://feeds.example.org/quotes.json?symbol=ACME",
        }],
      },
    });
  });

  it("produces a response that crosses the browser parser and canonical Workspace boundary unchanged", async () => {
    const { runtime } = successfulRuntime({ body: body('{"value":42}') });
    const result = await runtime.fetch({ url: "https://feeds.example.org/data.json" });
    const parsed = parseHostFeedFetchResponse(structuredClone(result));
    expect(parsed).toEqual(result);
    expect(() => assertWorkspaceResourceSafe({
      id: "RES_feed_test",
      label: "Test feed",
      connectorType: "http.feed",
      connectorVersion: "1.0.0",
      outputSchema: structuredClone(parsed.outputSchema),
      config: { url: parsed.requestedUrl, format: "auto" },
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: structuredClone(parsed.snapshot),
      status: "ready",
    })).not.toThrow();
  });

  it("parses gzip-compressed CSV into bounded chart data", async () => {
    const csv = "Time,Price,Volume\n09:30,187.4,100\n10:30,188.1,120\n";
    const { runtime } = successfulRuntime({
      headers: { "content-type": "text/csv", "content-encoding": "gzip" },
      body: gzipSync(csv),
    });
    const result = await runtime.fetch({ url: "https://feeds.example.org/chart.csv" });
    expect(result.format).toBe("csv");
    expect(result.snapshot.data).toEqual({
      labels: ["09:30", "10:30"],
      series: [
        { id: "price", label: "Price", values: [187.4, 188.1] },
        { id: "volume", label: "Volume", values: [100, 120] },
      ],
    });
    expect(JSON.stringify(result.outputSchema)).not.toMatch(/pattern|anyOf|oneOf|\$ref/u);
  });

  it("normalizes RSS and Atom without executing embedded content", async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
        <title>Market Wire</title><link>https://news.example.org/</link>
        <description>Latest market news</description>
        <item><guid>one</guid><title>Stocks rise</title>
          <link>https://news.example.org/one</link><pubDate>Fri, 15 Aug 2026 10:00:00 GMT</pubDate>
          <description><![CDATA[<b>Broad</b> gains]]></description>
        </item>
        <item><title>Unsafe link omitted</title><link>javascript:alert(1)</link></item>
      </channel></rss>`;
    const { runtime } = successfulRuntime({
      headers: { "content-type": "application/rss+xml; charset=utf-8" },
      body: body(rss),
    });
    const result = await runtime.fetch({ url: "https://feeds.example.org/market.xml" });
    expect(result.format).toBe("rss");
    expect(result.snapshot.provenance[0]).toMatchObject({ title: "Market Wire" });
    expect(result.snapshot.data).toEqual({
      feed: {
        title: "Market Wire",
        description: "Latest market news",
        link: "https://news.example.org/",
      },
      items: [
        {
          id: "one",
          title: "Stocks rise",
          link: "https://news.example.org/one",
          publishedAt: "Fri, 15 Aug 2026 10:00:00 GMT",
          summary: "Broad gains",
        },
        { title: "Unsafe link omitted" },
      ],
    });
  });

  it("normalizes namespaced Atom entries and HTTPS href links", async () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Release feed</title><link href="https://updates.example.org/"/>
        <updated>2026-08-15T01:02:03Z</updated>
        <entry><id>tag:updates.example.org,2026:1</id><title>Version 1</title>
          <link href="https://updates.example.org/v1"/><updated>2026-08-15T01:02:03Z</updated>
          <author><name>Release bot</name></author><summary>Ready</summary>
        </entry>
      </feed>`;
    const { runtime } = successfulRuntime({
      headers: { "content-type": "application/atom+xml" },
      body: body(atom),
    });
    const result = await runtime.fetch({ url: "https://feeds.example.org/releases.atom" });
    expect(result.snapshot.data).toEqual({
      feed: {
        title: "Release feed",
        link: "https://updates.example.org/",
        updatedAt: "2026-08-15T01:02:03Z",
      },
      items: [{
        id: "tag:updates.example.org,2026:1",
        title: "Version 1",
        link: "https://updates.example.org/v1",
        publishedAt: "2026-08-15T01:02:03Z",
        author: "Release bot",
        summary: "Ready",
      }],
    });
  });

  it("bounds and sanitizes RSS provenance titles for the browser and durable resource boundary", async () => {
    const longTitle = `${"x".repeat(2_100)}&#x7f;`;
    const { runtime } = successfulRuntime({
      headers: { "content-type": "application/rss+xml" },
      body: body(`<rss><channel><title>${longTitle}</title></channel></rss>`),
    });
    const result = await runtime.fetch({ url: "https://feeds.example.org/long-title.xml" });
    expect(result.snapshot.provenance[0]?.title).toHaveLength(2_000);
    const parsed = parseHostFeedFetchResponse(structuredClone(result));
    expect(() => assertWorkspaceResourceSafe({
      id: "RES_feed_long_title",
      label: "Long title feed",
      connectorType: "http.feed",
      connectorVersion: "1.0.0",
      outputSchema: structuredClone(parsed.outputSchema),
      config: { url: parsed.requestedUrl, format: "auto" },
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: structuredClone(parsed.snapshot),
      status: "ready",
    })).not.toThrow();
  });

  it("rejects DTD and entity declarations before XML parsing", async () => {
    const { runtime } = successfulRuntime({
      headers: { "content-type": "application/rss+xml" },
      body: body(`<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>&xxe;</title></channel></rss>`),
    });
    await expect(runtime.fetch({ url: "https://feeds.example.org/unsafe.xml" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
    });
  });

  it("rejects oversized RSS item sets instead of silently truncating them", async () => {
    const items = Array.from({ length: 1_001 }, (_, index) => `<item><title>${index}</title></item>`).join("");
    const { runtime } = successfulRuntime({
      headers: { "content-type": "application/rss+xml" },
      body: body(`<rss><channel><title>Too many</title>${items}</channel></rss>`),
    });
    await expect(runtime.fetch({ url: "https://feeds.example.org/large.xml" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
    });
  });

  it.each([
    '{"apiKey":"public-response-must-not-persist-this"}',
    '{"download":"https://files.example.org/item?signature=abc123"}',
    '{"note":"Bearer abcdefghijklmnop"}',
  ])("rejects credential-like material in fetched data: %s", async (payload) => {
    const { runtime } = successfulRuntime({ body: body(payload) });
    await expect(runtime.fetch({ url: "https://feeds.example.org/credential.json" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
      details: { path: expect.stringMatching(/^\$/u) },
    });
  });

  it.each([
    JSON.stringify({
      description: "Use https://accounts.example.org/invite/0123456789abcdef0123456789abcdef/feed.json to continue.",
    }),
    JSON.stringify({
      html: '<p>Continue at <a href="https://accounts.example.org/magic-login/SuperSecretOAuthCode123456">sign in</a></p>',
    }),
    JSON.stringify({
      html: '<a href="https&colon;&sol;&sol;accounts.example.org/callback/start?view=full&amp;code=SuperSecretOAuthCode123456">continue</a>',
    }),
    JSON.stringify({
      links: "Docs: https://docs.example.org/guide; then (https://accounts.example.org/invite/0123456789abcdef0123456789abcdef), please continue.",
    }),
    JSON.stringify({
      links: "https://docs.example.org/guide,https://user:password@accounts.example.org/profile",
    }),
    JSON.stringify({
      redirect: `Open https://outer.example.org/continue?next=${encodeURIComponent("https://accounts.example.org/invite/0123456789abcdef0123456789abcdef")}`,
    }),
    JSON.stringify({
      redirect: `https://outer.example.org/continue?next=${encodeURIComponent(encodeURIComponent("https://accounts.example.org/magic-login/SuperSecretOAuthCode123456"))}`,
    }),
    JSON.stringify({
      fragment: "https://outer.example.org/#access_token=abcdefghijklmnopqrstuvwxyz012345",
    }),
    JSON.stringify({
      fragment: "https://outer.example.org/#/callback?code=SuperSecretOAuthCode123456",
    }),
    JSON.stringify({
      fragment: `https://outer.example.org/#next=${encodeURIComponent("https://accounts.example.org/invite/0123456789abcdef0123456789abcdef")}`,
    }),
    JSON.stringify({
      html: "<a href=\"&#104;ttps&#58;&#47;&#47;accounts.example.org/invite/0123456789abcdef0123456789abcdef\">join</a>",
    }),
    JSON.stringify({
      text: "Use https:\\\\accounts.example.org\\invite\\0123456789abcdef0123456789abcdef now",
    }),
    JSON.stringify({
      text: "Use h\tttps://accounts.example.org/invite/0123456789abcdef0123456789abcdef now",
    }),
    JSON.stringify({
      links: "https://outer.example.org/feed?api%255Fkey=secret",
    }),
    JSON.stringify({
      links: "https://outer.example.org/invite/0123456789abcdef0123456789abcdef;mode=preview",
    }),
    JSON.stringify({
      links: "https://outer.example.org/feed?view=full;code=SuperSecretOAuthCode123456",
    }),
  ])("rejects credential or capability URLs embedded in bounded text: %s", async (payload) => {
    const { runtime } = successfulRuntime({ body: body(payload) });
    await expect(runtime.fetch({ url: "https://feeds.example.org/embedded.json" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
      details: { path: expect.stringMatching(/^\$/u) },
    });
  });

  it("allows multiple ordinary links, HTML hrefs, punctuation, parentheses, and readable routes", async () => {
    const data = {
      description: "See https://docs.example.org/guide, (https://example.org/login/enterprise-dashboard).",
      html: '<a href="https://example.org/invite/project-alpha">team docs</a>',
      links: "https://one.example.org/a;https://two.example.org/b?code=US",
      fragments: "https://example.org/#section-overview https://example.org/#/login/enterprise-dashboard https://example.org/#code=US",
      nested: `https://outer.example.org/?next=${encodeURIComponent("https://docs.example.org/login/enterprise-dashboard")}`,
    };
    const { runtime } = successfulRuntime({ body: body(JSON.stringify(data)) });
    await expect(runtime.fetch({ url: "https://feeds.example.org/ordinary-links.json" })).resolves.toMatchObject({
      snapshot: { data },
    });
  });

  it("fails closed when one string exceeds its embedded URL candidate budget", async () => {
    const linksAtLimit = Array.from(
      { length: 128 },
      (_, index) => `https://docs.example.org/page-${index}`,
    ).join(" ");
    const allowed = successfulRuntime({ body: body(JSON.stringify({ links: linksAtLimit })) }).runtime;
    await expect(allowed.fetch({ url: "https://feeds.example.org/link-limit.json" })).resolves.toMatchObject({
      snapshot: { data: { links: linksAtLimit } },
    });

    const links = `${linksAtLimit} https://docs.example.org/page-128`;
    const { runtime } = successfulRuntime({ body: body(JSON.stringify({ links })) });
    await expect(runtime.fetch({ url: "https://feeds.example.org/too-many-links.json" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
    });
  });

  it("accepts the exact candidate length limit and fails closed one character beyond it", async () => {
    const prefix = "https://docs.example.org/";
    const atLimit = `${prefix}${"a".repeat(8_192 - prefix.length)}`;
    const allowed = successfulRuntime({ body: body(JSON.stringify({ link: atLimit })) }).runtime;
    await expect(allowed.fetch({ url: "https://feeds.example.org/link-length-limit.json" })).resolves.toMatchObject({
      snapshot: { data: { link: atLimit } },
    });

    const link = `${atLimit}a`;
    const { runtime } = successfulRuntime({ body: body(JSON.stringify({ link })) });
    await expect(runtime.fetch({ url: "https://feeds.example.org/long-link.json" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
    });
  });

  it("allows four safe nested URL levels and fails closed beyond the nesting budget", async () => {
    const safeLeaf = "https://docs.example.org/login/enterprise-dashboard";
    const atLimit = nestedRedirectUrl(4, safeLeaf);
    const allowed = successfulRuntime({ body: body(JSON.stringify({ link: atLimit })) }).runtime;
    await expect(allowed.fetch({ url: "https://feeds.example.org/nested-limit.json" })).resolves.toMatchObject({
      snapshot: { data: { link: atLimit } },
    });

    const beyondLimit = nestedRedirectUrl(5, safeLeaf);
    const rejected = successfulRuntime({ body: body(JSON.stringify({ link: beyondLimit })) }).runtime;
    await expect(rejected.fetch({ url: "https://feeds.example.org/nested-overflow.json" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
    });
  });

  it("rejects a capability at the fourth nested URL level", async () => {
    const capability = "https://accounts.example.org/invite/0123456789abcdef0123456789abcdef";
    const link = nestedRedirectUrl(4, capability);
    const { runtime } = successfulRuntime({ body: body(JSON.stringify({ link })) });
    await expect(runtime.fetch({ url: "https://feeds.example.org/nested-capability.json" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
    });
  });

  it("requires explicit format for text/plain and rejects mismatched content types", async () => {
    const plain = successfulRuntime({
      headers: { "content-type": "text/plain" },
      body: body("{\"ok\":true}"),
    }).runtime;
    await expect(plain.fetch({ url: "https://feeds.example.org/plain" })).rejects.toMatchObject({
      code: "unsupported_feed_content",
      status: 415,
    });
    await expect(plain.fetch({ url: "https://feeds.example.org/plain", format: "json" })).resolves.toMatchObject({
      format: "json",
      snapshot: { data: { ok: true } },
    });

    const mismatch = successfulRuntime({
      headers: { "content-type": "text/csv" },
      body: body("a,b\n1,2"),
    }).runtime;
    await expect(mismatch.fetch({ url: "https://feeds.example.org/data", format: "json" })).rejects.toMatchObject({
      code: "unsupported_feed_content",
    });
  });
});

describe("FeedFetchRuntime network bounds", () => {
  it("revalidates and pins every redirect hop", async () => {
    const lookup = vi.fn(async (hostname: string) => hostname === "one.example.org"
      ? [PUBLIC_V4]
      : [{ address: "104.16.132.229", family: 4 as const }]);
    const request = vi.fn(async (
      url: URL,
      _address: Readonly<{ address: string; family: 4 | 6 }>,
      _timeoutMs: number,
    ) => url.hostname === "one.example.org"
      ? {
          status: 302,
          headers: { location: "https://two.example.org/final.json" },
          body: new Uint8Array(),
        }
      : {
          status: 200,
          headers: JSON_HEADERS,
          body: body("{\"value\":42}"),
        });
    const runtime = new FeedFetchRuntime({ lookup, request });
    const result = await runtime.fetch({ url: "https://one.example.org/start" });
    expect(lookup.mock.calls.map(([hostname]) => hostname)).toEqual(["one.example.org", "two.example.org"]);
    expect(request.mock.calls[0]![1]).toEqual(PUBLIC_V4);
    expect(request.mock.calls[1]![1]).toEqual({ address: "104.16.132.229", family: 4 });
    expect(result.finalUrl).toBe("https://two.example.org/final.json");
    expect(result.snapshot.provenance[0]?.uri).toBe(result.finalUrl);
  });

  it("rejects an unsafe redirect before its DNS lookup", async () => {
    const lookup = vi.fn(async () => [PUBLIC_V4]);
    const runtime = new FeedFetchRuntime({
      lookup,
      request: async () => ({
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
        body: new Uint8Array(),
      }),
    });
    await expect(runtime.fetch({ url: "https://feeds.example.org/start" })).rejects.toMatchObject({
      code: "unsafe_feed_target",
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to an authorization capability before its DNS lookup", async () => {
    const lookup = vi.fn(async () => [PUBLIC_V4]);
    const runtime = new FeedFetchRuntime({
      lookup,
      request: async () => ({
        status: 302,
        headers: { location: "https://accounts.example.org/invite/0123456789abcdef0123456789abcdef/feed.json" },
        body: new Uint8Array(),
      }),
    });
    await expect(runtime.fetch({ url: "https://feeds.example.org/start" })).rejects.toMatchObject({
      code: "unsafe_feed_target",
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("bounds compressed and decompressed response sizes", async () => {
    const oversizedCompressed = successfulRuntime({
      headers: JSON_HEADERS,
      body: new Uint8Array(500_001),
    }).runtime;
    await expect(oversizedCompressed.fetch({ url: "https://feeds.example.org/large.json" })).rejects.toMatchObject({
      code: "feed_upstream_error",
      status: 502,
    });

    const decompressionBomb = successfulRuntime({
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(`"${"x".repeat(500_001)}"`),
    }).runtime;
    await expect(decompressionBomb.fetch({ url: "https://feeds.example.org/bomb.json" })).rejects.toMatchObject({
      code: "invalid_feed_payload",
      status: 422,
    });
  });

  it("fails closed at the concurrency limit", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new FeedFetchRuntime({
      lookup: async () => [PUBLIC_V4],
      request: async () => {
        started();
        await blocked;
        return { status: 200, headers: JSON_HEADERS, body: body("{}") };
      },
    }, { maxConcurrency: 1 });
    const first = runtime.fetch({ url: "https://feeds.example.org/one.json" });
    await startedPromise;
    await expect(runtime.fetch({ url: "https://feeds.example.org/two.json" })).rejects.toMatchObject({
      code: "feed_concurrency_limit",
      status: 429,
    });
    release();
    await expect(first).resolves.toMatchObject({ format: "json" });
  });

  it("applies one total deadline to DNS and request work", async () => {
    let lookupSignal: AbortSignal | undefined;
    const runtime = new FeedFetchRuntime({
      lookup: async (_hostname, signal) => {
        lookupSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      request: vi.fn(),
    }, { timeoutMs: 100 });
    await expect(runtime.fetch({ url: "https://feeds.example.org/slow.json" })).rejects.toMatchObject({
      code: "feed_timeout",
      status: 504,
    });
    expect(lookupSignal?.aborted).toBe(true);
  });

  it("aborts an in-flight response body at the total deadline before releasing concurrency", async () => {
    let requestSignal: AbortSignal | undefined;
    let aborted = false;
    const runtime = new FeedFetchRuntime({
      lookup: async () => [PUBLIC_V4],
      request: async (_url, _address, _timeout, signal) => {
        requestSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    }, { timeoutMs: 100, maxConcurrency: 1 });

    const first = runtime.fetch({ url: "https://feeds.example.org/drip.json" });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await expect(runtime.fetch({ url: "https://feeds.example.org/blocked.json" })).rejects.toMatchObject({
      code: "feed_concurrency_limit",
    });
    await expect(first).rejects.toMatchObject({ code: "feed_timeout", status: 504 });
    expect(aborted).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  });
});
