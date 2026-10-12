// @vitest-environment node
import { EventEmitter } from "node:events";
import { brotliCompressSync, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn(), cancel: vi.fn() }));
const requestHttps = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ Resolver: class {
  resolve4 = dns.resolve4; resolve6 = dns.resolve6; cancel = dns.cancel;
} }));
vi.mock("node:https", () => ({ request: requestHttps }));
import { FeedFetchRuntime, normalizeFeedFetchRequest, type FeedFetchRequest, type FeedFetchRuntimeDependencies } from "../../../server/feed/FeedFetchRuntime";

const url = "https://feeds.example.org/data";
const address = { address: "93.184.216.34", family: 4 as const };
const bytes = (text: string) => new TextEncoder().encode(text);
function runtime(text = "{}", headers: Record<string, string | undefined> = { "content-type": "application/json" }, status = 200) {
  return new FeedFetchRuntime({ lookup: async () => [address], request: async () => ({ status, headers, body: bytes(text) }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  dns.resolve4.mockResolvedValue([address.address]);
  dns.resolve6.mockResolvedValue(["2606:4700:4700::1111"]);
});
afterEach(() => vi.restoreAllMocks());

describe("feed input and decoder boundaries", () => {
  it.each([undefined, "", "x".repeat(8193), "not a url", `https://example.org/${"é".repeat(2000)}`])("rejects malformed or normalized oversized URL %s", (value) => {
    expect(() => normalizeFeedFetchRequest({ url: value } as FeedFetchRequest)).toThrow(/url/u);
  });
  it("rejects unknown format and invalid execution limits", () => {
    expect(() => normalizeFeedFetchRequest({ url, format: "html" } as unknown as FeedFetchRequest)).toThrow(/format/u);
    for (const timeoutMs of [0, 99, 60_001, 100.5]) expect(() => new FeedFetchRuntime({}, { timeoutMs })).toThrow(RangeError);
    for (const maxConcurrency of [0, 33, 1.5]) expect(() => new FeedFetchRuntime({}, { maxConcurrency })).toThrow(RangeError);
  });
  it.each([
    {}, { "content-type": "x".repeat(257) },
    { "content-type": "application/json;charset=utf-8;charset=us-ascii" },
    { "content-type": "application/json;charset=latin1" },
    { "content-type": "application/json", "content-encoding": "gzip, br" },
    { "content-type": "application/json", "content-encoding": "unknown" },
  ])("rejects ambiguous/unsupported content declarations %s", async (headers) => {
    await expect(runtime("{}", headers).fetch({ url })).rejects.toMatchObject({ code: "unsupported_feed_content", status: 415 });
  });
  it.each(["deflate", "br"])("decodes bounded %s data", async (encoding) => {
    const body = encoding === "br" ? brotliCompressSync(bytes('{"ok":true}')) : deflateSync(bytes('{"ok":true}'));
    const r = new FeedFetchRuntime({ lookup: async () => [address], request: async () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": encoding }, body }) });
    await expect(r.fetch({ url })).resolves.toMatchObject({ snapshot: { data: { ok: true } } });
  });
  it("rejects malformed UTF8 and invalid JSON separately", async () => {
    const r = new FeedFetchRuntime({ lookup: async () => [address], request: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: new Uint8Array([0xff]) }) });
    await expect(r.fetch({ url })).rejects.toMatchObject({ message: "Feed body is not valid UTF-8." });
    await expect(runtime("{").fetch({ url })).rejects.toMatchObject({ code: "invalid_feed_payload" });
  });
  it.each([undefined, "x".repeat(8193), "https://["])("rejects unusable redirect location %s", async (location) => {
    await expect(runtime("", { location }, 302).fetch({ url })).rejects.toMatchObject({ code: "feed_upstream_error" });
  });
  it("bounds redirect chains and upstream status", async () => {
    await expect(runtime("", { location: "/again" }, 302).fetch({ url })).rejects.toThrow(/exceeded 3 redirects/u);
    await expect(runtime("", {}, 503).fetch({ url })).rejects.toMatchObject({ details: { status: 503 } });
  });
  it.each([
    "<html/>", "<rss><channel></rss>",
    `<rss>${"<nested>".repeat(65)}${"</nested>".repeat(65)}</rss>`,
    `<rss>${"<x/>".repeat(5001)}</rss>`,
    `<rss><channel><title>${"x".repeat(32001)}</title></channel></rss>`,
    `<rss><channel><title>${"x".repeat(16000)}<b>${"y".repeat(16000)}</b></title></channel></rss>`,
  ])("rejects malformed and over-budget XML without partial results", async (xml) => {
    await expect(runtime(xml, { "content-type": "application/xml" }).fetch({ url })).rejects.toMatchObject({ code: "invalid_feed_payload" });
  });
  it("rejects non-UTF8 XML declarations and permits explicit plain-text feed formats", async () => {
    await expect(runtime('<?xml version="1.0" encoding="iso-8859-1"?><rss/>', { "content-type": "text/xml" }).fetch({ url })).rejects.toMatchObject({ code: "unsupported_feed_content" });
    await expect(runtime("{}", { "content-type": "text/plain;mode=plain;charset=utf8;charset=utf8" }).fetch({ url, format: "json" })).resolves.toMatchObject({ format: "json" });
    await expect(runtime("<rss><item/></rss>", { "content-type": "text/plain" }).fetch({ url, format: "rss" })).resolves.toMatchObject({ snapshot: { data: { feed: { title: "feeds.example.org" }, items: [{ title: "Item 1" }] } } });
  });
  it("releases concurrency after caller cancellation and classifies DNS/transport failures", async () => {
    const signal = new AbortController(); signal.abort();
    const r = runtime();
    await expect(r.fetch({ url }, signal.signal)).rejects.toMatchObject({ code: "feed_timeout" });
    await expect(r.fetch({ url })).resolves.toMatchObject({ format: "json" });
    for (const addresses of [[], Array.from({ length: 17 }, () => address)]) {
      await expect(new FeedFetchRuntime({ lookup: async () => addresses }).fetch({ url })).rejects.toMatchObject({ code: "feed_upstream_error" });
    }
    await expect(new FeedFetchRuntime({ lookup: async () => { throw new Error("DNS offline"); } }).fetch({ url })).rejects.toThrow(/could not be resolved/u);
    await expect(new FeedFetchRuntime({ lookup: async () => [address], request: async () => { throw new Error("TLS failure"); } }).fetch({ url })).rejects.toThrow(/could not be reached securely/u);
  });
});

describe("production DNS and HTTPS adapters", () => {
  it("uses an isolated dual-stack resolver, handles single-stack fallback and literal public addresses", async () => {
    const request = vi.fn<NonNullable<FeedFetchRuntimeDependencies["request"]>>(async () => ({ status: 200, headers: { "content-type": "application/json" }, body: bytes("{}") }));
    await new FeedFetchRuntime({ request }).fetch({ url });
    expect(dns.resolve4).toHaveBeenCalledWith("feeds.example.org");
    expect(dns.resolve6).toHaveBeenCalledWith("feeds.example.org");
    expect(request.mock.calls[0]?.[1]).toEqual(address);
    dns.resolve4.mockRejectedValueOnce(new Error("no A"));
    await new FeedFetchRuntime({ request }).fetch({ url });
    dns.resolve6.mockRejectedValueOnce(new Error("no AAAA"));
    await new FeedFetchRuntime({ request }).fetch({ url });
    await new FeedFetchRuntime({ request }).fetch({ url: "https://93.184.216.34/data" });
    expect(dns.resolve4).toHaveBeenCalledTimes(3);
  });
  it("fails closed on empty/broken DNS answers and cancels the resolver on caller abort", async () => {
    for (const broken4 of [false, true]) {
      dns.resolve4.mockImplementationOnce(() => broken4 ? Promise.reject(new Error("A failed")) : Promise.resolve([]));
      dns.resolve6.mockRejectedValueOnce(new Error("AAAA failed"));
      await expect(new FeedFetchRuntime().fetch({ url })).rejects.toMatchObject({ code: "feed_upstream_error" });
    }
    dns.resolve4.mockResolvedValueOnce([]); dns.resolve6.mockResolvedValueOnce([]);
    await expect(new FeedFetchRuntime().fetch({ url })).rejects.toMatchObject({ code: "feed_upstream_error" });
    let finish!: () => void;
    const pending = new Promise<string[]>((resolve) => { finish = () => resolve([]); });
    dns.resolve4.mockReturnValueOnce(pending); dns.resolve6.mockReturnValueOnce(pending);
    const caller = new AbortController();
    const operation = new FeedFetchRuntime().fetch({ url }, caller.signal);
    caller.abort(); finish();
    await expect(operation).rejects.toMatchObject({ code: "feed_timeout" });
    expect(dns.cancel).toHaveBeenCalledOnce();
  });
  it.each(["success", "declared-limit", "stream-limit", "timeout"])("enforces pinned lookup and socket %s lifecycle", async (scenario) => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": ["application/json"], "content-length": scenario === "declared-limit" ? "500001" : undefined }, destroy: vi.fn() });
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn(), end: vi.fn() });
    requestHttps.mockImplementation((options, callback) => {
      const all = vi.fn(); const single = vi.fn();
      options.lookup("ignored", { all: true }, all); options.lookup("ignored", {}, single);
      expect(all).toHaveBeenCalledWith(null, [address]); expect(single).toHaveBeenCalledWith(null, address.address, 4);
      request.end.mockImplementation(() => queueMicrotask(() => {
        callback(response);
        if (scenario === "timeout") request.setTimeout.mock.calls[0]![1]();
        else if (scenario !== "declared-limit") {
          response.emit("data", scenario === "stream-limit" ? new Uint8Array(500001) : "{}");
          if (scenario === "success") response.emit("end");
        }
      }));
      return request;
    });
    const operation = new FeedFetchRuntime({ lookup: async () => [address] }).fetch({ url });
    if (scenario === "success") await expect(operation).resolves.toMatchObject({ snapshot: { data: {} } });
    else await expect(operation).rejects.toMatchObject({ code: scenario === "timeout" ? "feed_timeout" : "feed_upstream_error" });
    if (scenario.includes("limit")) expect(response.destroy).toHaveBeenCalledOnce();
    if (scenario === "timeout") expect(request.destroy).toHaveBeenCalledOnce();
  });
});
