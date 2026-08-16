import { Resolver } from "node:dns/promises";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { SaxesParser } from "saxes";
import type { JSONSchema, JSONObject, JSONValue } from "../../src/workspace/components/componentTypes";
import { deterministicDigest } from "../../src/workspace/components/manifestDigest";
import { parseLocalInlineSource } from "../../src/workspace/data/localInlineSource";
import type { ResourceProvenance, ResourceSnapshot } from "../../src/workspace/data/dataTypes";
import { findEmbeddedSecretPath } from "../../src/workspace/data/resourceSecurity";
import { detectUrlCapabilityRisk } from "../../src/workspace/security/urlCapabilitySecurity";

export type FeedFormat = "auto" | "json" | "csv" | "rss";
export type ResolvedFeedFormat = Exclude<FeedFormat, "auto">;

export type FeedFetchRequest = Readonly<{
  url: string;
  format?: FeedFormat;
}>;

export type FeedFetchResult = Readonly<{
  version: 1;
  requestedUrl: string;
  finalUrl: string;
  format: ResolvedFeedFormat;
  contentType: string;
  retrievedAt: string;
  outputSchema: JSONSchema;
  snapshot: ResourceSnapshot;
}>;

export class FeedFetchError extends Error {
  constructor(
    readonly code:
      | "invalid_feed_request"
      | "unsafe_feed_target"
      | "unsupported_feed_content"
      | "invalid_feed_payload"
      | "feed_concurrency_limit"
      | "feed_upstream_error"
      | "feed_timeout",
    message: string,
    readonly status: 400 | 403 | 415 | 422 | 429 | 502 | 504,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "FeedFetchError";
  }
}

type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

type FeedHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}>;

export type FeedFetchRuntimeDependencies = Readonly<{
  /** Implementations must stop outstanding resolver work when signal aborts. */
  lookup?: (hostname: string, signal?: AbortSignal) => Promise<readonly ResolvedAddress[]>;
  /** Implementations must destroy outstanding sockets/body streams when signal aborts. */
  request?: (
    url: URL,
    address: ResolvedAddress,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<FeedHttpResponse>;
  now?: () => number;
}>;

const MAX_URL_CHARACTERS = 8_192;
const MAX_EMBEDDED_URL_SCAN_CHARACTERS = 500_000;
const MAX_EMBEDDED_URL_CANDIDATE_CHARACTERS = MAX_URL_CHARACTERS;
const MAX_EMBEDDED_URL_CANDIDATES_PER_STRING = 128;
const MAX_EMBEDDED_URL_NESTING_DEPTH = 4;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 500_000;
const MAX_DNS_ANSWERS = 16;
const MAX_XML_NODES = 5_000;
const MAX_XML_DEPTH = 64;
const MAX_FEED_ITEMS = 1_000;
const MAX_TEXT_CHARACTERS = 32_000;
const MAX_PROVENANCE_TITLE_CHARACTERS = 2_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENCY = 4;

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);

const RSS_OUTPUT_SCHEMA: JSONSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["feed", "items"],
  properties: {
    feed: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        link: { type: "string" },
        updatedAt: { type: "string" },
      },
    },
    items: {
      type: "array",
      maxItems: MAX_FEED_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          link: { type: "string" },
          publishedAt: { type: "string" },
          author: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
  },
});

const FEED_CHART_OUTPUT_SCHEMA: JSONSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["labels", "series"],
  properties: {
    labels: { type: "array", maxItems: 10_000, items: { type: "string" } },
    series: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "values"],
        properties: {
          id: { type: "string", minLength: 1 },
          label: { type: "string" },
          values: { type: "array", maxItems: 10_000, items: { type: "number" } },
          color: { type: "string" },
        },
      },
    },
  },
});

interface XmlNode {
  readonly local: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

function invalidRequest(message: string): never {
  throw new FeedFetchError("invalid_feed_request", message, 400);
}

function unsafeTarget(message: string): never {
  throw new FeedFetchError("unsafe_feed_target", message, 403);
}

function boundedRequestUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URL_CHARACTERS) {
    return invalidRequest(`url must contain 1-${MAX_URL_CHARACTERS} characters.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidRequest("url must be an absolute HTTPS URL.");
  }
  assertSafeFeedUrl(url);
  if (url.href.length > MAX_URL_CHARACTERS) {
    return invalidRequest(`Normalized url must contain at most ${MAX_URL_CHARACTERS} characters.`);
  }
  return url;
}

export type NormalizedFeedFetchRequest = Readonly<{
  url: string;
  format: FeedFormat;
}>;

/** Canonical request identity used by both approval binding and execution. */
export function normalizeFeedFetchRequest(input: FeedFetchRequest): NormalizedFeedFetchRequest {
  const url = boundedRequestUrl(input.url);
  const format = input.format ?? "auto";
  if (!["auto", "json", "csv", "rss"].includes(format)) {
    invalidRequest("format must be auto, json, csv, or rss.");
  }
  return Object.freeze({ url: url.href, format });
}

function normalizedCredentialKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function decodePercentRepeated(value: string): string {
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  return candidate;
}

function isCredentialQueryKey(key: string): boolean {
  const normalized = normalizedCredentialKey(decodePercentRepeated(key));
  const tokens = normalized.split("_").filter(Boolean);
  const collapsed = normalized.replace(/_/gu, "");
  return [
    "apikey", "accesstoken", "authtoken", "clientsecret", "idtoken",
    "privatekey", "refreshtoken", "sessiontoken",
  ].some((credential) => collapsed.includes(credential)) || tokens.some((token) => [
    "auth", "authorization", "bearer", "credential", "credentials", "key",
    "password", "secret", "sig", "signature", "token",
  ].includes(token));
}

function containsCredentialLikeValue(value: string): boolean {
  const trimmed = decodePercentRepeated(value.trim());
  return /^(?:bearer|basic)\s+\S{8,}$/iu.test(trimmed)
    || /^(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._~-]{8,}$/u.test(trimmed)
    || /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/u.test(trimmed);
}

function pathContainsCredentialLikeValue(url: URL): boolean {
  return url.pathname.split("/").some((rawSegment) => {
    return containsCredentialLikeValue(decodePercentRepeated(rawSegment).split(";", 1)[0] ?? "");
  });
}

function assertSafeFeedUrl(url: URL): void {
  if (url.protocol !== "https:") unsafeTarget("Feed URLs must use HTTPS.");
  if (url.username || url.password) unsafeTarget("Feed URLs cannot contain user credentials.");
  if (url.port && url.port !== "443") unsafeTarget("Feed URLs cannot use a custom port.");
  if (url.hash) unsafeTarget("Feed URLs cannot contain fragments.");
  const hostname = canonicalHostname(url);
  if (!hostname || hostname.length > 253) invalidRequest("Feed URL hostname is invalid.");
  if (
    hostname === "localhost"
    || (!isIP(hostname) && !hostname.includes("."))
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".test")
    || hostname.endsWith(".invalid")
    || hostname.endsWith(".example")
    || hostname.endsWith(".onion")
    || hostname.endsWith(".arpa")
  ) {
    unsafeTarget("Local and internal hostnames are not allowed for feeds.");
  }
  if (urlContainsCredentialLikeMaterial(url, {
    remainingCandidates: MAX_EMBEDDED_URL_CANDIDATES_PER_STRING,
    seenCandidates: new Set<string>(),
  }, 0)) {
    unsafeTarget("Feed URLs cannot contain credentials, signatures, or authorization capabilities.");
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    unsafeTarget("Feed targets must use a public Internet address.");
  }
}

function canonicalHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
}

function ipv4Bytes(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  const bytes = address.split(".").map(Number);
  return bytes.length === 4 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : null;
}

function ipv4InCidr(bytes: readonly number[], base: readonly number[], prefix: number): boolean {
  const addressValue = (((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!) >>> 0;
  const baseValue = (((base[0]! << 24) >>> 0) + (base[1]! << 16) + (base[2]! << 8) + base[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (addressValue & mask) === (baseValue & mask);
}

const BLOCKED_IPV4_RANGES: readonly Readonly<{ base: readonly number[]; prefix: number }>[] = Object.freeze([
  { base: [0, 0, 0, 0], prefix: 8 },
  { base: [10, 0, 0, 0], prefix: 8 },
  { base: [100, 64, 0, 0], prefix: 10 },
  { base: [127, 0, 0, 0], prefix: 8 },
  { base: [169, 254, 0, 0], prefix: 16 },
  { base: [168, 63, 129, 16], prefix: 32 },
  { base: [172, 16, 0, 0], prefix: 12 },
  { base: [192, 0, 0, 0], prefix: 24 },
  { base: [192, 0, 2, 0], prefix: 24 },
  { base: [192, 168, 0, 0], prefix: 16 },
  { base: [198, 18, 0, 0], prefix: 15 },
  { base: [198, 51, 100, 0], prefix: 24 },
  { base: [203, 0, 113, 0], prefix: 24 },
  { base: [224, 0, 0, 0], prefix: 4 },
  { base: [240, 0, 0, 0], prefix: 4 },
]);

function expandIpv6(address: string): readonly number[] | null {
  let normalized = address.toLowerCase().split("%")[0]!;
  const embeddedV4Index = normalized.lastIndexOf(":");
  const embeddedV4 = ipv4Bytes(normalized.slice(embeddedV4Index + 1));
  if (embeddedV4) {
    normalized = `${normalized.slice(0, embeddedV4Index)}:${((embeddedV4[0]! << 8) | embeddedV4[1]!).toString(16)}:${((embeddedV4[2]! << 8) | embeddedV4[3]!).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return null;
  const words = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

/** Public for focused policy tests; production requests still pin to a resolved address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address)!;
    return !BLOCKED_IPV4_RANGES.some((range) => ipv4InCidr(bytes, range.base, range.prefix));
  }
  if (family !== 6) return false;
  const words = expandIpv6(address);
  if (!words) return false;
  // Only global-unicast 2000::/3 is admitted. Transition, documentation,
  // benchmarking and ORCHID ranges inside it stay closed as well.
  if ((words[0]! & 0xe000) !== 0x2000) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words[0] === 0x2001 && words[1] === 0x0000) return false;
  if (words[0] === 0x2001 && words[1] === 0x0002 && words[2] === 0x0000) return false;
  if (words[0] === 0x2001 && (words[1]! & 0xfff0) === 0x0010) return false;
  if (words[0] === 0x2001 && (words[1]! & 0xfff0) === 0x0020) return false;
  if (words[0] === 0x2002) return false;
  if (words[0] === 0x3fff && (words[1]! & 0xf000) === 0x0000) return false;
  return true;
}

function feedTimeoutError(message = "Feed request timed out."): FeedFetchError {
  return new FeedFetchError("feed_timeout", message, 504);
}

function feedAbortError(signal: AbortSignal): FeedFetchError {
  return signal.reason instanceof FeedFetchError
    ? signal.reason
    : feedTimeoutError("Feed request was cancelled.");
}

function throwIfFeedAborted(signal: AbortSignal): void {
  if (signal.aborted) throw feedAbortError(signal);
}

async function defaultLookup(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]> {
  const family = isIP(hostname);
  if (family) return [{ address: hostname, family: family as 4 | 6 }];
  if (signal) throwIfFeedAborted(signal);

  // dns.lookup() delegates to getaddrinfo and cannot be cancelled. Use one
  // isolated Resolver per hop so the total feed deadline can actually stop
  // outstanding A/AAAA queries instead of only abandoning their promises.
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    if (signal) throwIfFeedAborted(signal);
    const addresses: ResolvedAddress[] = [];
    const ipv4 = results[0];
    const ipv6 = results[1];
    if (ipv4.status === "fulfilled") {
      addresses.push(...ipv4.value.map((address) => ({ address, family: 4 as const })));
    }
    if (ipv6.status === "fulfilled") {
      addresses.push(...ipv6.value.map((address) => ({ address, family: 6 as const })));
    }
    if (addresses.length) return addresses;
    throw ipv4.status === "rejected" ? ipv4.reason : ipv6.status === "rejected" ? ipv6.reason : new Error("DNS lookup failed");
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function requestHeaders(headers: import("node:http").IncomingHttpHeaders): Record<string, string | undefined> {
  const first = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;
  return {
    "content-type": first(headers["content-type"]),
    "content-encoding": first(headers["content-encoding"]),
    "content-length": first(headers["content-length"]),
    location: first(headers.location),
  };
}

async function defaultRequest(
  url: URL,
  address: ResolvedAddress,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FeedHttpResponse> {
  return await new Promise<FeedHttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (result: FeedHttpResponse) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const request = requestHttps({
      protocol: "https:",
      hostname: canonicalHostname(url),
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      // A concrete family disables Node's automatic dual-family selection,
      // keeping the TLS socket on exactly the validated/pinned address.
      family: address.family,
      servername: isIP(canonicalHostname(url)) ? undefined : canonicalHostname(url),
      headers: {
        accept: "application/json, text/csv;q=0.9, application/rss+xml;q=0.9, application/atom+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "SemaFrame-Feed-Runtime/1.0",
      },
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          (callback as (error: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void)(null, [address]);
        } else {
          (callback as (
            error: NodeJS.ErrnoException | null,
            resolvedAddress: string,
            family: number,
          ) => void)(null, address.address, address.family);
        }
      },
    }, (response) => {
      const status = response.statusCode ?? 502;
      response.on("error", fail);
      if (status < 200 || status >= 300) {
        const headers = requestHeaders(response.headers);
        // Redirect/error bodies are irrelevant and otherwise outlive this hop,
        // bypassing both the byte bound and the global concurrency deadline.
        response.destroy();
        finish({ status, headers, body: new Uint8Array() });
        return;
      }
      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        const error = new FeedFetchError(
          "feed_upstream_error",
          `Feed response exceeds ${MAX_RESPONSE_BYTES} compressed bytes.`,
          502,
        );
        response.destroy(error);
        fail(error);
        return;
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      response.on("data", (chunk: Buffer | Uint8Array | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          const error = new FeedFetchError(
            "feed_upstream_error",
            `Feed response exceeds ${MAX_RESPONSE_BYTES} compressed bytes.`,
            502,
          );
          response.destroy(error);
          fail(error);
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => finish({
        status,
        headers: requestHeaders(response.headers),
        body: Buffer.concat(chunks, byteLength),
      }));
    });
    const abort = () => {
      const error = signal ? feedAbortError(signal) : feedTimeoutError();
      request.destroy(error);
      fail(error);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.setTimeout(timeoutMs, () => {
      const error = feedTimeoutError();
      request.destroy(error);
      fail(error);
    });
    request.on("error", fail);
    request.end();
  });
}

function deadlineRemaining(deadline: number, controller: AbortController): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = feedTimeoutError();
    controller.abort(error);
    throw error;
  }
  return remaining;
}

async function withinAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfFeedAborted(signal);
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(feedAbortError(signal));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function decodeResponseBody(
  body: Uint8Array,
  contentEncoding: string | undefined,
  signal: AbortSignal,
): Promise<Uint8Array> {
  throwIfFeedAborted(signal);
  const encoding = (contentEncoding ?? "identity").trim().toLowerCase();
  if (encoding.includes(",")) {
    throw new FeedFetchError("unsupported_feed_content", "Multiple content encodings are not supported.", 415);
  }
  if (encoding === "" || encoding === "identity") return body;
  let decoded: Buffer;
  try {
    const options = { maxOutputLength: MAX_RESPONSE_BYTES, signal };
    if (encoding === "gzip" || encoding === "x-gzip") decoded = await gunzipAsync(body, options);
    else if (encoding === "deflate") decoded = await inflateAsync(body, options);
    else if (encoding === "br") decoded = await brotliDecompressAsync(body, options);
    else throw new FeedFetchError("unsupported_feed_content", `Unsupported content encoding ${encoding}.`, 415);
  } catch (error) {
    if (signal.aborted) throw feedAbortError(signal);
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError(
      "invalid_feed_payload",
      error instanceof Error && /maxOutputLength|larger than/u.test(error.message)
        ? `Decoded feed exceeds ${MAX_RESPONSE_BYTES} bytes.`
        : "Feed compression is invalid.",
      422,
    );
  }
  if (decoded.byteLength > MAX_RESPONSE_BYTES) {
    throw new FeedFetchError("invalid_feed_payload", `Decoded feed exceeds ${MAX_RESPONSE_BYTES} bytes.`, 422);
  }
  return decoded;
}

function normalizedContentType(value: string | undefined): { mediaType: string; charset?: string } {
  if (!value || value.length > 256) {
    throw new FeedFetchError("unsupported_feed_content", "Feed response requires a bounded Content-Type header.", 415);
  }
  const [rawMediaType, ...parameters] = value.split(";");
  const mediaType = rawMediaType!.trim().toLowerCase();
  let charset: string | undefined;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/iu.exec(parameter);
    if (match) {
      const nextCharset = match[1]!.toLowerCase();
      if (charset && charset !== nextCharset) {
        throw new FeedFetchError("unsupported_feed_content", "Feed Content-Type has conflicting charsets.", 415);
      }
      charset = nextCharset;
    }
  }
  if (charset && !["utf-8", "utf8", "us-ascii"].includes(charset)) {
    throw new FeedFetchError("unsupported_feed_content", `Unsupported feed charset ${charset}; use UTF-8.`, 415);
  }
  return { mediaType, ...(charset ? { charset } : {}) };
}

function resolveFormat(requested: FeedFormat, mediaType: string): ResolvedFeedFormat {
  const json = mediaType === "application/json" || mediaType.endsWith("+json");
  const csv = mediaType === "text/csv" || mediaType === "application/csv";
  const rss = ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml"].includes(mediaType)
    || mediaType.endsWith("+xml");
  if (requested === "auto") {
    if (json) return "json";
    if (csv) return "csv";
    if (rss) return "rss";
    throw new FeedFetchError("unsupported_feed_content", `Unsupported feed Content-Type ${mediaType}.`, 415);
  }
  const matches = requested === "json" ? json : requested === "csv" ? csv : rss;
  if (!matches && mediaType !== "text/plain") {
    throw new FeedFetchError(
      "unsupported_feed_content",
      `Content-Type ${mediaType} does not match requested ${requested} format.`,
      415,
    );
  }
  return requested;
}

function decodeUtf8(body: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new FeedFetchError("invalid_feed_payload", "Feed body is not valid UTF-8.", 422);
  }
}

function localName(value: string): string {
  return value.toLowerCase();
}

function parseXmlTree(text: string): XmlNode {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text)) {
    throw new FeedFetchError("invalid_feed_payload", "Feed XML cannot contain DTD or entity declarations.", 422);
  }
  const parser = new SaxesParser({ xmlns: true, position: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodeCount = 0;
  parser.on("doctype", () => {
    throw new FeedFetchError("invalid_feed_payload", "Feed XML cannot contain a DTD.", 422);
  });
  parser.on("opentag", (tag) => {
    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES) {
      throw new FeedFetchError("invalid_feed_payload", `Feed XML exceeds ${MAX_XML_NODES} elements.`, 422);
    }
    if (stack.length >= MAX_XML_DEPTH) {
      throw new FeedFetchError("invalid_feed_payload", `Feed XML exceeds depth ${MAX_XML_DEPTH}.`, 422);
    }
    const attributes: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes)) {
      attributes[localName(attribute.local)] = attribute.value.slice(0, MAX_TEXT_CHARACTERS);
    }
    const node: XmlNode = {
      local: localName(tag.local),
      attributes,
      children: [],
      text: "",
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    else throw new FeedFetchError("invalid_feed_payload", "Feed XML has multiple root elements.", 422);
    stack.push(node);
  });
  const appendText = (value: string) => {
    const current = stack.at(-1);
    if (!current || !value) return;
    const remaining = MAX_TEXT_CHARACTERS - current.text.length;
    if (value.length > remaining) {
      throw new FeedFetchError(
        "invalid_feed_payload",
        `Feed XML text exceeds ${MAX_TEXT_CHARACTERS} characters in one element.`,
        422,
      );
    }
    current.text += value;
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("closetag", () => {
    stack.pop();
  });
  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError(
      "invalid_feed_payload",
      `Feed XML is invalid: ${error instanceof Error ? error.message.slice(0, 300) : "parse error"}`,
      422,
    );
  }
  if (!root) throw new FeedFetchError("invalid_feed_payload", "Feed XML is empty.", 422);
  return root;
}

function firstChild(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  const allowed = new Set(names);
  return node?.children.find((child) => allowed.has(child.local));
}

function descendants(node: XmlNode, name: string, results: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.local === name) {
      results.push(child);
      if (results.length > MAX_FEED_ITEMS) {
        throw new FeedFetchError(
          "invalid_feed_payload",
          `Feed exceeds ${MAX_FEED_ITEMS} items.`,
          422,
        );
      }
    }
    descendants(child, name, results);
  }
  return results;
}

function textContent(node: XmlNode | undefined, maximum = MAX_TEXT_CHARACTERS): string {
  if (!node) return "";
  let output = node.text;
  for (const child of node.children) {
    const childText = textContent(child, maximum);
    if (output.length + childText.length + 1 > maximum) {
      throw new FeedFetchError(
        "invalid_feed_payload",
        `Feed field exceeds ${maximum} characters.`,
        422,
      );
    }
    output += ` ${childText}`;
  }
  return output
    .replace(/<[^>]{0,2000}>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function nodeText(node: XmlNode | undefined, ...names: string[]): string | undefined {
  const value = textContent(firstChild(node, ...names));
  return value || undefined;
}

function safeProvenanceTitle(value: string): string | undefined {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .slice(0, MAX_PROVENANCE_TITLE_CHARACTERS)
    .trim();
  return normalized || undefined;
}

function secureLinkedUrl(value: string | undefined, baseUrl: URL): string | undefined {
  if (!value) return undefined;
  try {
    const linked = new URL(value, baseUrl);
    assertSafeFeedUrl(linked);
    return linked.href.slice(0, MAX_URL_CHARACTERS);
  } catch {
    return undefined;
  }
}

function feedLink(node: XmlNode | undefined, baseUrl: URL): string | undefined {
  const linkNode = firstChild(node, "link");
  return secureLinkedUrl(linkNode?.attributes.href ?? textContent(linkNode), baseUrl);
}

function parseRssOrAtom(text: string, sourceUrl: URL): { data: JSONValue; outputSchema: JSONSchema; title?: string } {
  const root = parseXmlTree(text);
  if (!["rss", "rdf", "feed"].includes(root.local)) {
    throw new FeedFetchError("invalid_feed_payload", "XML document is not an RSS or Atom feed.", 422);
  }
  const atom = root.local === "feed";
  const channel = atom ? root : firstChild(root, "channel") ?? root;
  const title = nodeText(channel, "title") ?? sourceUrl.hostname;
  const feed: JSONObject = { title };
  const description = nodeText(channel, "description", "subtitle");
  const link = feedLink(channel, sourceUrl);
  const updatedAt = nodeText(channel, "lastbuilddate", "pubdate", "updated");
  if (description) feed.description = description;
  if (link) feed.link = link;
  if (updatedAt) feed.updatedAt = updatedAt;
  const itemNodes = descendants(channel, atom ? "entry" : "item");
  const items: JSONObject[] = itemNodes.map((item, index) => {
    const itemTitle = nodeText(item, "title") ?? `Item ${index + 1}`;
    const normalized: JSONObject = { title: itemTitle };
    const id = nodeText(item, "guid", "id");
    const itemLink = feedLink(item, sourceUrl);
    const publishedAt = nodeText(item, "pubdate", "published", "updated");
    const author = nodeText(item, "author", "creator");
    const summary = nodeText(item, "description", "summary", "content", "encoded");
    if (id) normalized.id = id;
    if (itemLink) normalized.link = itemLink;
    if (publishedAt) normalized.publishedAt = publishedAt;
    if (author) normalized.author = author;
    if (summary) normalized.summary = summary;
    return normalized;
  });
  return {
    data: { feed, items },
    outputSchema: structuredClone(RSS_OUTPUT_SCHEMA),
    title: safeProvenanceTitle(title),
  };
}

function responseLocation(currentUrl: URL, location: string | undefined): URL {
  if (!location || location.length > MAX_URL_CHARACTERS) {
    throw new FeedFetchError("feed_upstream_error", "Feed redirect is missing a valid Location header.", 502);
  }
  let redirected: URL;
  try {
    redirected = new URL(location, currentUrl);
  } catch {
    throw new FeedFetchError("feed_upstream_error", "Feed redirect Location is invalid.", 502);
  }
  assertSafeFeedUrl(redirected);
  return redirected;
}

function parseFeedBody(
  format: ResolvedFeedFormat,
  text: string,
  finalUrl: URL,
): { data: JSONValue; outputSchema: JSONSchema; title?: string } {
  try {
    if (format === "rss") return parseRssOrAtom(text, finalUrl);
    const parsed = parseLocalInlineSource(format, text);
    return {
      data: parsed.data,
      outputSchema: parsed.kind === "chart_timeseries"
        ? structuredClone(FEED_CHART_OUTPUT_SCHEMA)
        : genericFeedOutputSchema(parsed.data),
    };
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError(
      "invalid_feed_payload",
      `Feed ${format.toUpperCase()} is invalid: ${error instanceof Error ? error.message.slice(0, 300) : "parse error"}`,
      422,
    );
  }
}

function genericFeedOutputSchema(value: JSONValue): JSONSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", maxItems: 10_000, items: {} };
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "object" };
}

function decodeHtmlUrlSyntax(value: string): string {
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    const decoded = candidate
      .replace(/&(amp|#0*38|#x0*26);/giu, "&")
      .replace(/&(colon|#0*58|#x0*3a);/giu, ":")
      .replace(/&(sol|#0*47|#x0*2f);/giu, "/")
      .replace(/&(quot|#0*34|#x0*22);/giu, "\"")
      .replace(/&(apos|#0*39|#x0*27);/giu, "'")
      .replace(/&(lt|#0*60|#x0*3c);/giu, "<")
      .replace(/&(gt|#0*62|#x0*3e);/giu, ">")
      .replace(/&(?:tab);/giu, "\t")
      .replace(/&(?:newline);/giu, "\n")
      .replace(/&#(x[0-9a-f]{1,6}|[0-9]{1,7});/giu, (entity, numeric: string) => {
        const codePoint = numeric.toLowerCase().startsWith("x")
          ? Number.parseInt(numeric.slice(1), 16)
          : Number.parseInt(numeric, 10);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x7f
          ? String.fromCodePoint(codePoint)
          : entity;
      });
    if (decoded === candidate) break;
    candidate = decoded;
  }
  return candidate;
}

function embeddedUrlSecurityViews(value: string): readonly string[] {
  const views = new Set<string>();
  let candidate = decodeHtmlUrlSyntax(value)
    .replace(/[\t\r\n]/gu, "")
    .replace(/\\/gu, "/");
  views.add(candidate);
  for (let depth = 0; depth < 4; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      break;
    }
    if (decoded === candidate) break;
    candidate = decodeHtmlUrlSyntax(decoded)
      .replace(/[\t\r\n]/gu, "")
      .replace(/\\/gu, "/");
    views.add(candidate);
  }
  return [...views];
}

function trimEmbeddedUrlPunctuation(value: string): string {
  let candidate = value;
  let previous: string;
  do {
    previous = candidate;
    candidate = candidate.replace(/[.,;:!?，。；：！？、…“”‘’«»‹›]+$/gu, "");
    for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
      const openings = candidate.split(opening).length - 1;
      let closings = candidate.split(closing).length - 1;
      while (candidate.endsWith(closing) && closings > openings) {
        candidate = candidate.slice(0, -1);
        closings -= 1;
      }
    }
  } while (candidate !== previous);
  return candidate;
}

type EmbeddedUrlScanContext = {
  remainingCandidates: number;
  readonly seenCandidates: Set<string>;
};

function urlParameterViews(url: URL): readonly URLSearchParams[] {
  return url.search.includes(";")
    ? [url.searchParams, new URLSearchParams(url.search.slice(1).replace(/;/gu, "&"))]
    : [url.searchParams];
}

function fragmentParameterView(fragment: string): URLSearchParams {
  const queryIndex = fragment.indexOf("?");
  const query = fragment.startsWith("?")
    ? fragment.slice(1)
    : queryIndex >= 0
      ? fragment.slice(queryIndex + 1)
      : fragment;
  return new URLSearchParams(query.replace(/;/gu, "&"));
}

function urlContainsCredentialLikeMaterial(
  url: URL,
  context: EmbeddedUrlScanContext,
  depth: number,
): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return true;
  if (detectUrlCapabilityRisk(url)) return true;
  if (pathContainsCredentialLikeValue(url)) return true;
  for (const parameters of urlParameterViews(url)) {
    for (const [key, parameterValue] of parameters) {
      if (isCredentialQueryKey(key) || containsCredentialLikeValue(parameterValue)) return true;
      if (stringContainsCredentialLikeUrl(parameterValue, context, depth + 1)) return true;
    }
  }
  if (url.hash.length > 1) {
    const fragment = decodePercentRepeated(url.hash.slice(1));
    if (containsCredentialLikeValue(fragment)) return true;
    for (const [key, parameterValue] of fragmentParameterView(fragment)) {
      if (isCredentialQueryKey(key) || containsCredentialLikeValue(parameterValue)) return true;
      if (stringContainsCredentialLikeUrl(parameterValue, context, depth + 1)) return true;
    }
    if (stringContainsCredentialLikeUrl(fragment, context, depth + 1)) return true;
  }
  return false;
}

function stringContainsCredentialLikeUrl(
  value: string,
  context: EmbeddedUrlScanContext = {
    remainingCandidates: MAX_EMBEDDED_URL_CANDIDATES_PER_STRING,
    seenCandidates: new Set<string>(),
  },
  depth = 0,
): boolean {
  // The response body is already bounded to this size. Keep this helper
  // independently fail-closed so later callers cannot accidentally scan an
  // unbounded string or skip a credential hidden after a scan cutoff.
  if (value.length > MAX_EMBEDDED_URL_SCAN_CHARACTERS) return true;
  for (const source of embeddedUrlSecurityViews(value)) {
    // Stop at HTML/text delimiters and at a subsequent URL scheme. The latter
    // makes comma-adjacent URLs independent candidates rather than one path.
    const candidates = source.matchAll(/https?:\/\/(?:(?!https?:\/\/)[^\s<>"'`])+/giu);
    for (const match of candidates) {
      const rawCandidate = match[0] ?? "";
      if (rawCandidate.length > MAX_EMBEDDED_URL_CANDIDATE_CHARACTERS) return true;
      const candidate = trimEmbeddedUrlPunctuation(rawCandidate);
      if (!candidate || context.seenCandidates.has(candidate)) continue;
      context.seenCandidates.add(candidate);
      if (context.remainingCandidates <= 0 || depth > MAX_EMBEDDED_URL_NESTING_DEPTH) return true;
      context.remainingCandidates -= 1;
      try {
        if (urlContainsCredentialLikeMaterial(new URL(candidate), context, depth)) return true;
      } catch {
        // A malformed textual candidate is not navigable as an absolute URL.
      }
    }
  }
  return false;
}

function findCredentialLikeValuePath(value: JSONValue, path = "$"): string | undefined {
  if (typeof value === "string") {
    if (containsCredentialLikeValue(value)) return path;
    return stringContainsCredentialLikeUrl(value) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findCredentialLikeValuePath(entry, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, entry] of Object.entries(value)) {
    const found = findCredentialLikeValuePath(entry, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

function assertFeedDataCredentialFree(value: JSONValue): void {
  const path = findEmbeddedSecretPath(value) ?? findCredentialLikeValuePath(value);
  if (path) {
    const safePath = path.length <= 512 ? path : `${path.slice(0, 509)}...`;
    throw new FeedFetchError(
      "invalid_feed_payload",
      `Feed data contains credential-like material at ${safePath}; credentials are never imported or persisted.`,
      422,
      { path: safePath },
    );
  }
}

export class FeedFetchRuntime {
  readonly #lookup: NonNullable<FeedFetchRuntimeDependencies["lookup"]>;
  readonly #request: NonNullable<FeedFetchRuntimeDependencies["request"]>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #maxConcurrency: number;
  #active = 0;

  constructor(
    dependencies: FeedFetchRuntimeDependencies = {},
    options: Readonly<{ timeoutMs?: number; maxConcurrency?: number }> = {},
  ) {
    this.#lookup = dependencies.lookup ?? defaultLookup;
    this.#request = dependencies.request ?? defaultRequest;
    this.#now = dependencies.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 60_000) {
      throw new RangeError("Feed timeoutMs must be an integer between 100 and 60000.");
    }
    if (!Number.isSafeInteger(this.#maxConcurrency) || this.#maxConcurrency < 1 || this.#maxConcurrency > 32) {
      throw new RangeError("Feed maxConcurrency must be an integer between 1 and 32.");
    }
  }

  async fetch(input: FeedFetchRequest, callerSignal?: AbortSignal): Promise<FeedFetchResult> {
    if (this.#active >= this.#maxConcurrency) {
      throw new FeedFetchError("feed_concurrency_limit", "Too many feed requests are already running.", 429);
    }
    this.#active += 1;
    try {
      const normalizedRequest = normalizeFeedFetchRequest(input);
      const requestedUrl = new URL(normalizedRequest.url);
      const requestedFormat = normalizedRequest.format;
      const deadline = Date.now() + this.#timeoutMs;
      const operation = new AbortController();
      const cancelFromCaller = () => operation.abort(feedTimeoutError("Feed request was cancelled."));
      if (callerSignal?.aborted) cancelFromCaller();
      else callerSignal?.addEventListener("abort", cancelFromCaller, { once: true });
      const deadlineTimer = setTimeout(() => operation.abort(feedTimeoutError()), this.#timeoutMs);
      deadlineTimer.unref();
      try {
        throwIfFeedAborted(operation.signal);
        let currentUrl = requestedUrl;
        let response: FeedHttpResponse | undefined;
        for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
          assertSafeFeedUrl(currentUrl);
          let addresses: readonly ResolvedAddress[];
          try {
            addresses = await withinAbort(
              this.#lookup(canonicalHostname(currentUrl), operation.signal),
              operation.signal,
            );
          } catch (error) {
            if (error instanceof FeedFetchError) throw error;
            throw new FeedFetchError("feed_upstream_error", "Feed hostname could not be resolved.", 502);
          }
          if (!addresses.length || addresses.length > MAX_DNS_ANSWERS) {
            throw new FeedFetchError("feed_upstream_error", "Feed hostname returned no usable public addresses.", 502);
          }
          if (addresses.some((answer) => answer.family !== isIP(answer.address) || !isPublicAddress(answer.address))) {
            unsafeTarget("Feed hostname resolved to a non-public or mixed-safety address set.");
          }
          try {
            response = await withinAbort(
              this.#request(
                currentUrl,
                addresses[0]!,
                deadlineRemaining(deadline, operation),
                operation.signal,
              ),
              operation.signal,
            );
          } catch (error) {
            if (error instanceof FeedFetchError) throw error;
            throw new FeedFetchError("feed_upstream_error", "Feed server could not be reached securely.", 502);
          }
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirectCount === MAX_REDIRECTS) {
              throw new FeedFetchError("feed_upstream_error", `Feed exceeded ${MAX_REDIRECTS} redirects.`, 502);
            }
            currentUrl = responseLocation(currentUrl, response.headers.location);
            continue;
          }
          break;
        }
        if (!response || response.status < 200 || response.status >= 300) {
          throw new FeedFetchError(
            "feed_upstream_error",
            `Feed server returned HTTP ${response?.status ?? 502}.`,
            502,
            { status: response?.status ?? 502 },
          );
        }
        if (response.body.byteLength > MAX_RESPONSE_BYTES) {
          throw new FeedFetchError(
            "feed_upstream_error",
            `Feed response exceeds ${MAX_RESPONSE_BYTES} compressed bytes.`,
            502,
          );
        }
        const content = normalizedContentType(response.headers["content-type"]);
        const format = resolveFormat(requestedFormat, content.mediaType);
        const decoded = await withinAbort(
          decodeResponseBody(response.body, response.headers["content-encoding"], operation.signal),
          operation.signal,
        );
        const text = decodeUtf8(decoded);
        if (format === "rss" && /<\?xml[^>]+encoding\s*=\s*["'](?!utf-?8|us-ascii)[^"']+["']/iu.test(text.slice(0, 500))) {
          throw new FeedFetchError("unsupported_feed_content", "Feed XML declaration must use UTF-8.", 415);
        }
        const parsed = parseFeedBody(format, text, currentUrl);
        assertFeedDataCredentialFree(parsed.data);
        deadlineRemaining(deadline, operation);
        const retrievedAt = new Date(this.#now()).toISOString();
        const provenance: ResourceProvenance[] = [{
          ...(parsed.title ? { title: parsed.title } : {}),
          uri: currentUrl.href,
          publisher: canonicalHostname(currentUrl),
          retrievedAt,
          citation: currentUrl.href,
        }];
        const snapshot: ResourceSnapshot = {
          data: parsed.data,
          contentHash: deterministicDigest(parsed.data),
          retrievedAt,
          stale: false,
          provenance,
        };
        return {
          version: 1,
          requestedUrl: requestedUrl.href,
          finalUrl: currentUrl.href,
          format,
          contentType: content.mediaType,
          retrievedAt,
          outputSchema: parsed.outputSchema,
          snapshot,
        };
      } finally {
        clearTimeout(deadlineTimer);
        callerSignal?.removeEventListener("abort", cancelFromCaller);
      }
    } finally {
      this.#active -= 1;
    }
  }
}
