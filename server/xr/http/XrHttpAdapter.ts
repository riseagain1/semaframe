import {
  XR_PROTOCOL_LIMITS,
  XrProtocolValidationError,
} from "../../../src/xr/protocol";
import {
  XrRelay,
  XrRelayControlError,
  type XrRelayCredential,
  type XrRelayDelivery,
} from "../XrRelay";
import {
  XrAssetRelayCache,
  XrAssetRelayError,
} from "../assets/XrAssetRelayCache";
import {
  XR_ASSET_CONTRACT_VERSION,
  XR_ASSET_LIMITS,
  XR_ASSET_HTTP_COLLECTION_PATH,
  XR_ASSET_HTTP_DIGEST_HEADER,
  XR_ASSET_HTTP_FORMAT_HEADER,
  XR_ASSET_HTTP_LENGTH_HEADER,
  XR_ASSET_HTTP_TTL_HEADER,
  XrAssetValidationError,
  parseXrAssetFormat,
  xrAssetDigestFromHttpPath,
  type XrAssetDigest,
} from "../../../src/xr/assets";
import type {
  UltraBrowserProbeEvidence,
  WindowsUltraEvidenceProvider,
} from "../ultra";

export const XR_HTTP_API_PREFIX = "/api/xr/v1" as const;
export const XR_HTTP_SESSION_HEADER = "x-semaframe-xr-session" as const;
export const XR_HTTP_POLL_MODE = "immediate" as const;
const DEFAULT_ULTRA_REQUEST_COOLDOWN_MS = 5_000;
const DEFAULT_ULTRA_MAXIMUM_TRACKED_SESSIONS = 64;

export const XR_HTTP_PATHS = Object.freeze({
  authorityConnect: `${XR_HTTP_API_PREFIX}/authority/connect`,
  authorityPairings: `${XR_HTTP_API_PREFIX}/authority/pairings`,
  authorityPairingsRevoke: `${XR_HTTP_API_PREFIX}/authority/pairings/revoke`,
  rendererConnect: `${XR_HTTP_API_PREFIX}/renderer/connect`,
  sessionSend: `${XR_HTTP_API_PREFIX}/session/send`,
  sessionPoll: `${XR_HTTP_API_PREFIX}/session/poll`,
  rendererReconnect: `${XR_HTTP_API_PREFIX}/renderer/reconnect`,
  rendererUltraProbe: `${XR_HTTP_API_PREFIX}/renderer/ultra/probe`,
  rendererUltraSample: `${XR_HTTP_API_PREFIX}/renderer/ultra/sample`,
  sessionDisconnect: `${XR_HTTP_API_PREFIX}/session/disconnect`,
} as const);

type XrHttpPath = (typeof XR_HTTP_PATHS)[keyof typeof XR_HTTP_PATHS];

export type XrHttpAdapterOptions = Readonly<{
  /**
   * The embedding host must authenticate the local authority bootstrap using
   * transport facts unavailable to this Fetch-only layer (for example a
   * loopback socket plus a host bootstrap secret). It must not consume the
   * request body.
   */
  trustedLocalAuthority(request: Request): boolean | Promise<boolean>;
  /** Exact, canonical browser origins allowed to call renderer/session routes. */
  rendererOrigins?: readonly string[];
  /** May lower, but never raise, the protocol control-body ceiling. */
  controlBodyLimitBytes?: number;
  /** May lower, but never raise, the snapshot-capable send-body ceiling. */
  messageBodyLimitBytes?: number;
  /** Shared bounded content cache for immutable XR mesh/splat payloads. */
  assetCache?: XrAssetRelayCache;
  /** Optional, explicitly configured Windows-native Ultra telemetry provider. */
  ultraEvidence?: WindowsUltraEvidenceProvider;
  /** Injectable clock/bounds for the authenticated Ultra abuse guard. */
  ultraRateLimit?: Readonly<{
    now?: () => number;
    cooldownMs?: number;
    maximumTrackedSessions?: number;
  }>;
}>;

export type XrHttpHandler = (request: Request) => Promise<Response>;

const MAXIMUM_MESSAGE_BODY_BYTES = XR_PROTOCOL_LIMITS.maximumSnapshotBytes
  + XR_PROTOCOL_LIMITS.maximumControlBytes;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/u;
const ALLOWED_PREFLIGHT_HEADERS = new Set([
  "authorization",
  "content-type",
  "range",
  XR_HTTP_SESSION_HEADER,
]);
const ROUTES = new Set<XrHttpPath>(Object.values(XR_HTTP_PATHS));
const RENDERER_CORS_ROUTES = new Set<XrHttpPath>([
  XR_HTTP_PATHS.rendererConnect,
  XR_HTTP_PATHS.sessionSend,
  XR_HTTP_PATHS.sessionPoll,
  XR_HTTP_PATHS.rendererReconnect,
  XR_HTTP_PATHS.rendererUltraProbe,
  XR_HTTP_PATHS.rendererUltraSample,
  XR_HTTP_PATHS.sessionDisconnect,
]);

const BASE_RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

class XrHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "XrHttpError";
  }
}

class XrRequestAbortedError extends Error {
  constructor() {
    super("The request was aborted.");
    this.name = "XrRequestAbortedError";
  }
}

function checkedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return result;
}

function checkedIntegerBetween(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

type UltraRequestKind = "probe" | "sample";
type UltraRateEntry = {
  probeAtMs?: number;
  sampleAtMs?: number;
  lastSeenAtMs: number;
};

function createUltraRequestLimiter(options: XrHttpAdapterOptions["ultraRateLimit"]) {
  const now = options?.now ?? Date.now;
  const cooldownMs = checkedIntegerBetween(
    options?.cooldownMs,
    DEFAULT_ULTRA_REQUEST_COOLDOWN_MS,
    1_000,
    60_000,
    "ultraRateLimit.cooldownMs",
  );
  const maximumTrackedSessions = checkedIntegerBetween(
    options?.maximumTrackedSessions,
    DEFAULT_ULTRA_MAXIMUM_TRACKED_SESSIONS,
    1,
    256,
    "ultraRateLimit.maximumTrackedSessions",
  );
  const entries = new Map<string, UltraRateEntry>();
  return Object.freeze({
    take(sessionId: string, kind: UltraRequestKind): void {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new XrHttpError(503, "ultra_evidence_unavailable", "Windows Ultra native evidence failed.");
      }
      for (const [trackedSessionId, entry] of entries) {
        if (timestamp - entry.lastSeenAtMs >= cooldownMs) entries.delete(trackedSessionId);
      }
      let entry = entries.get(sessionId);
      if (!entry) {
        if (entries.size >= maximumTrackedSessions) {
          throw new XrHttpError(429, "ultra_rate_limited", "Windows Ultra evidence is temporarily rate limited.");
        }
        entry = { lastSeenAtMs: timestamp };
        entries.set(sessionId, entry);
      }
      const previous = kind === "probe" ? entry.probeAtMs : entry.sampleAtMs;
      if (previous !== undefined && timestamp - previous < cooldownMs) {
        throw new XrHttpError(429, "ultra_rate_limited", "Windows Ultra evidence is temporarily rate limited.");
      }
      if (kind === "probe") entry.probeAtMs = timestamp;
      else entry.sampleAtMs = timestamp;
      entry.lastSeenAtMs = timestamp;
    },
    forget(sessionId: string): void {
      entries.delete(sessionId);
    },
  });
}

function checkedOrigins(values: readonly string[] | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string" || value.length > 2_048 || value === "null") {
      throw new TypeError("rendererOrigins must contain canonical HTTP(S) origins.");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("rendererOrigins must contain canonical HTTP(S) origins.");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:")
      || url.origin !== value
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== "") {
      throw new TypeError("rendererOrigins must contain canonical HTTP(S) origins.");
    }
    result.add(value);
  }
  if (result.size > 64) throw new RangeError("rendererOrigins may contain at most 64 origins.");
  return result;
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new XrHttpError(400, "invalid_request", "Request body must be a JSON object.");
  }
  const result = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(result)) {
    if (!allowedSet.has(key)) {
      throw new XrHttpError(400, "invalid_request", "Request body contains an unknown field.");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) {
      throw new XrHttpError(400, "invalid_request", "Request body is missing a required field.");
    }
  }
  return result;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new XrRequestAbortedError();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new XrRequestAbortedError());
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new XrRequestAbortedError());
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function assertJsonMediaType(request: Request): void {
  const contentType = request.headers.get("content-type");
  const essence = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (essence !== "application/json") {
    throw new XrHttpError(415, "unsupported_media_type", "Use application/json.");
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new XrHttpError(415, "unsupported_media_type", "Encoded request bodies are not supported.");
  }
}

function declaredBodyLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(raw)) {
    throw new XrHttpError(400, "invalid_request", "Content-Length is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new XrHttpError(413, "body_too_large", "Request body is too large.");
  }
  return value;
}

async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  throwIfAborted(request.signal);
  assertJsonMediaType(request);
  const declared = declaredBodyLength(request);
  if (declared !== undefined && declared > limit) {
    throw new XrHttpError(413, "body_too_large", "Request body is too large.");
  }
  if (!request.body) {
    throw new XrHttpError(400, "invalid_request", "Request body must contain JSON.");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), request.signal);
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > limit) {
        void reader.cancel().catch(() => undefined);
        throw new XrHttpError(413, "body_too_large", "Request body is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof XrRequestAbortedError) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    if (error instanceof XrHttpError) throw error;
    throw new XrHttpError(400, "invalid_request", "Request body must be valid UTF-8 JSON.");
  } finally {
    // A synthetic stream may still have a pending read while cancellation is
    // propagating. Never let releaseLock mask the safe aborted response.
    try {
      reader.releaseLock();
    } catch {
      // The cancellation above owns the remaining stream cleanup.
    }
  }
  throwIfAborted(request.signal);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new XrHttpError(400, "invalid_request", "Request body must be valid JSON.");
  }
}

function corsHeadersFor(request: Request, allowedOrigins: ReadonlySet<string>): HeadersInit {
  const origin = request.headers.get("origin");
  if (origin === null) return {};
  if (!allowedOrigins.has(origin)) {
    throw new XrHttpError(403, "origin_forbidden", "Origin is not allowed.");
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": `authorization, content-type, ${XR_HTTP_SESSION_HEADER}`,
    vary: "Origin",
  };
}

function assetCorsHeadersFor(request: Request, allowedOrigins: ReadonlySet<string>): HeadersInit {
  const headers = new Headers(corsHeadersFor(request, allowedOrigins));
  headers.set("access-control-allow-methods", "GET, HEAD");
  headers.set("access-control-allow-headers", `authorization, range, ${XR_HTTP_SESSION_HEADER}`);
  return Object.fromEntries(headers);
}

function preflightResponse(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): Response {
  const corsHeaders = corsHeadersFor(request, allowedOrigins);
  if (!request.headers.has("origin")
    || request.headers.get("access-control-request-method") !== "POST") {
    throw new XrHttpError(403, "origin_forbidden", "CORS preflight is not allowed.");
  }
  const requested = request.headers.get("access-control-request-headers");
  if (requested !== null) {
    const names = requested.split(",").map((name) => name.trim().toLowerCase());
    if (names.some((name) => name === "" || !ALLOWED_PREFLIGHT_HEADERS.has(name))) {
      throw new XrHttpError(403, "origin_forbidden", "CORS preflight is not allowed.");
    }
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_RESPONSE_HEADERS,
      ...Object.fromEntries(new Headers(corsHeaders)),
      "access-control-max-age": "300",
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
  });
}

function assetPreflightResponse(request: Request, allowedOrigins: ReadonlySet<string>): Response {
  const corsHeaders = assetCorsHeadersFor(request, allowedOrigins);
  const method = request.headers.get("access-control-request-method");
  if (!request.headers.has("origin") || (method !== "GET" && method !== "HEAD")) {
    throw new XrHttpError(403, "origin_forbidden", "CORS preflight is not allowed.");
  }
  const requested = request.headers.get("access-control-request-headers");
  if (requested !== null) {
    const names = requested.split(",").map((name) => name.trim().toLowerCase());
    if (names.some((name) => name === "" || !ALLOWED_PREFLIGHT_HEADERS.has(name))) {
      throw new XrHttpError(403, "origin_forbidden", "CORS preflight is not allowed.");
    }
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_RESPONSE_HEADERS,
      ...Object.fromEntries(new Headers(corsHeaders)),
      "access-control-allow-methods": "GET, HEAD",
      "access-control-allow-headers": `authorization, range, ${XR_HTTP_SESSION_HEADER}`,
      "access-control-max-age": "300",
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
  });
}

function jsonResponse(
  status: number,
  payload: unknown,
  extraHeaders: HeadersInit = {},
): Response {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > XR_PROTOCOL_LIMITS.maximumControlResponseBytes) {
    throw new XrHttpError(503, "response_too_large", "XR control response exceeds the client byte budget.");
  }
  return new Response(serialized, {
    status,
    headers: {
      ...BASE_RESPONSE_HEADERS,
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function successResponse(data: unknown, extraHeaders: HeadersInit): Response {
  return jsonResponse(200, { ok: true, data }, extraHeaders);
}

function boundedPollDeliveries(
  deliveries: readonly XrRelayDelivery[],
): readonly XrRelayDelivery[] {
  const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify({
    ok: true,
    data: { mode: XR_HTTP_POLL_MODE, deliveries: [] },
  }), "utf8");
  let encodedBytes = emptyEnvelopeBytes;
  const page: XrRelayDelivery[] = [];
  for (const delivery of deliveries) {
    const addition = Buffer.byteLength(JSON.stringify(delivery), "utf8") + (page.length ? 1 : 0);
    if (encodedBytes + addition > XR_PROTOCOL_LIMITS.maximumControlResponseBytes) break;
    encodedBytes += addition;
    page.push(delivery);
  }
  if (deliveries.length > 0 && page.length === 0) {
    // Every individual routable message is bounded far below the response
    // ceiling. Reaching this branch signals an internal invariant violation;
    // return a small retryable envelope instead of materializing oversized JSON.
    throw new XrHttpError(503, "response_too_large", "XR delivery exceeds the response byte budget.");
  }
  return Object.freeze(page);
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders: HeadersInit,
): Response {
  return jsonResponse(status, { ok: false, error: { code, message } }, extraHeaders);
}

function authorizationCredential(request: Request, body: Record<string, unknown>): XrRelayCredential {
  const authorization = request.headers.get("authorization");
  const match = authorization === null ? null : BEARER_PATTERN.exec(authorization);
  const headerSessionId = request.headers.get(XR_HTTP_SESSION_HEADER);
  const bodySessionId = body.sessionId;
  if (!match
    || (headerSessionId !== null && bodySessionId !== undefined && headerSessionId !== bodySessionId)
    || (headerSessionId === null && typeof bodySessionId !== "string")) {
    throw new XrHttpError(401, "unauthorized", "Authentication failed.");
  }
  return Object.freeze({
    sessionId: headerSessionId ?? bodySessionId as string,
    sessionBearer: match[1],
  });
}

function headerInteger(request: Request, name: string, minimum: number, maximum: number): number {
  const raw = request.headers.get(name);
  if (raw === null || !/^(?:0|[1-9][0-9]{0,15})$/u.test(raw)) {
    throw new XrHttpError(400, "invalid_request", "XR asset metadata is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new XrHttpError(400, "invalid_request", "XR asset metadata is invalid.");
  }
  return value;
}

function assetCredential(request: Request): XrRelayCredential {
  return authorizationCredential(request, {});
}

function assetRange(request: Request, totalBytes: number): Readonly<{ start: number; endExclusive: number }> | undefined {
  const raw = request.headers.get("range");
  if (raw === null) return undefined;
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(raw);
  if (!match) throw new XrHttpError(416, "range_not_satisfiable", "Use one explicit byte range.");
  const start = Number(match[1]);
  const inclusiveEnd = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(inclusiveEnd)
    || inclusiveEnd < start || inclusiveEnd >= totalBytes) {
    throw new XrHttpError(416, "range_not_satisfiable", "XR asset byte range is not satisfiable.");
  }
  return Object.freeze({ start, endExclusive: inclusiveEnd + 1 });
}

async function* requestByteSource(request: Request): AsyncIterable<Uint8Array> {
  if (!request.body) throw new XrHttpError(400, "invalid_request", "XR asset bytes are required.");
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), request.signal);
      if (done) return;
      yield value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Abort/cancellation owns the remaining stream cleanup.
    }
  }
}

function streamResponse(source: AsyncIterable<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        throwIfAborted(signal);
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (cause) {
        controller.error(cause);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function assetFailure(error: XrAssetRelayError | XrAssetValidationError, headers: HeadersInit): Response {
  if (error instanceof XrAssetValidationError) {
    return errorResponse(400, "invalid_asset", "XR asset metadata or content is invalid.", headers);
  }
  switch (error.code) {
    case "not_found":
      return errorResponse(404, "asset_not_found", "XR asset is unavailable.", headers);
    case "range_not_satisfiable":
      return errorResponse(416, "range_not_satisfiable", "XR asset byte range is not satisfiable.", headers);
    case "asset_too_large":
      return errorResponse(413, "asset_too_large", "XR asset exceeds the relay budget.", headers);
    case "aborted":
      return errorResponse(408, "request_aborted", "Request was aborted.", headers);
    case "source_chunk_limit_exceeded":
      return errorResponse(413, "asset_too_large", "XR asset stream exceeds the relay budget.", headers);
    case "invalid_byte_source":
    case "byte_length_mismatch":
    case "digest_mismatch":
    case "metadata_conflict":
      return errorResponse(400, "invalid_asset", "XR asset metadata or content is invalid.", headers);
  }
}

function relayFailure(error: XrRelayControlError, headers: HeadersInit): Response {
  switch (error.code) {
    case "session_unauthorized":
    case "session_not_found":
    case "pairing_invalid":
      return errorResponse(401, "unauthorized", "Authentication failed.", headers);
    case "role_not_allowed":
      return errorResponse(403, "forbidden", "Operation is not allowed.", headers);
    case "authority_already_connected":
      return errorResponse(409, "conflict", "An authority is already connected.", headers);
    case "workspace_mismatch":
      return errorResponse(409, "conflict", "Workspace state changed.", headers);
    case "authority_required":
      return errorResponse(503, "authority_unavailable", "XR authority is unavailable.", headers);
    case "renderer_capacity":
      return errorResponse(429, "capacity_exhausted", "Renderer capacity is exhausted.", headers);
    case "invalid_control_request":
      return errorResponse(400, "invalid_request", "Request body is invalid.", headers);
  }
}

function routeFor(request: Request): XrHttpPath | undefined {
  const url = new URL(request.url);
  if (url.search !== "" || url.hash !== "") return undefined;
  return ROUTES.has(url.pathname as XrHttpPath) ? url.pathname as XrHttpPath : undefined;
}

function parseUltraBrowserEvidence(value: unknown): UltraBrowserProbeEvidence {
  const body = exactObject(
    value,
    ["browserEngine", "secureContext", "immersiveVrSupported"],
    ["browserEngine", "secureContext", "immersiveVrSupported"],
  );
  if ((body.browserEngine !== "chromium" && body.browserEngine !== "unknown")
    || typeof body.secureContext !== "boolean"
    || typeof body.immersiveVrSupported !== "boolean") {
    throw new XrHttpError(400, "invalid_request", "Windows Ultra browser evidence is invalid.");
  }
  return Object.freeze({
    browserEngine: body.browserEngine,
    secureContext: body.secureContext,
    immersiveVrSupported: body.immersiveVrSupported,
  });
}

/**
 * Creates a network-runtime-neutral Fetch handler around one shared XrRelay.
 * Polling is deliberately bounded and immediate: each call returns the
 * relay's already-bounded in-memory deliveries and never holds a socket open.
 * A delivery is removed only by an authenticated acknowledgement on a later
 * poll, so a lost HTTP response cannot discard an accepted renderer action.
 */
export function createXrHttpHandler(
  relay: XrRelay,
  options: XrHttpAdapterOptions,
): XrHttpHandler {
  if (!options || typeof options.trustedLocalAuthority !== "function") {
    throw new TypeError("trustedLocalAuthority is required.");
  }
  const origins = checkedOrigins(options.rendererOrigins);
  const controlLimit = checkedLimit(
    options.controlBodyLimitBytes,
    XR_PROTOCOL_LIMITS.maximumControlBytes,
    XR_PROTOCOL_LIMITS.maximumControlBytes,
    "controlBodyLimitBytes",
  );
  const messageLimit = checkedLimit(
    options.messageBodyLimitBytes,
    MAXIMUM_MESSAGE_BODY_BYTES,
    MAXIMUM_MESSAGE_BODY_BYTES,
    "messageBodyLimitBytes",
  );
  const assetCache = options.assetCache ?? new XrAssetRelayCache();
  const assetScopes = new Map<XrAssetDigest, Readonly<{ workspaceId: string; authorityEpoch: string }>>();
  const ultraRequestLimiter = createUltraRequestLimiter(options.ultraRateLimit);

  return async (request: Request): Promise<Response> => {
    let responseCorsHeaders: HeadersInit = {};
    try {
      throwIfAborted(request.signal);
      const url = new URL(request.url);
      const assetDigest = xrAssetDigestFromHttpPath(url.pathname);
      const isAssetCollection = url.pathname === XR_ASSET_HTTP_COLLECTION_PATH;
      const isAssetRoute = isAssetCollection || assetDigest !== undefined;
      if (isAssetRoute) {
        const residentDigests = new Set(assetCache.residentDigests());
        for (const scopedDigest of assetScopes.keys()) {
          if (!residentDigests.has(scopedDigest)) assetScopes.delete(scopedDigest);
        }
        if (url.search !== "" || url.hash !== "") {
          return errorResponse(404, "not_found", "Route not found.", responseCorsHeaders);
        }
        if (request.method === "OPTIONS") return assetPreflightResponse(request, origins);

        if (isAssetCollection) {
          if (request.method !== "PUT") {
            return errorResponse(405, "method_not_allowed", "Use PUT.", { allow: "PUT" });
          }
          let trusted = false;
          try {
            trusted = await abortable(Promise.resolve(options.trustedLocalAuthority(request)), request.signal);
          } catch (error) {
            if (error instanceof XrRequestAbortedError) throw error;
          }
          if (!trusted) throw new XrHttpError(401, "unauthorized", "Authentication failed.");
          const session = relay.authorizeSession(assetCredential(request));
          if (session.role !== "authority") throw new XrHttpError(403, "forbidden", "Operation is not allowed.");
          const digest = request.headers.get(XR_ASSET_HTTP_DIGEST_HEADER);
          const format = parseXrAssetFormat(request.headers.get(XR_ASSET_HTTP_FORMAT_HEADER));
          const byteLength = headerInteger(
            request,
            XR_ASSET_HTTP_LENGTH_HEADER,
            1,
            XR_ASSET_LIMITS.maximumAssetBytes,
          );
          const ttlMs = headerInteger(request, XR_ASSET_HTTP_TTL_HEADER, 1, 7 * 24 * 60 * 60_000);
          const stored = await assetCache.put({
            version: XR_ASSET_CONTRACT_VERSION,
            digest,
            format,
            byteLength,
            ttlMs,
          }, requestByteSource(request), { signal: request.signal });
          for (const evicted of stored.evictedDigests) assetScopes.delete(evicted);
          assetScopes.set(stored.descriptor.digest, Object.freeze({
            workspaceId: session.workspaceId,
            authorityEpoch: session.authorityEpoch,
          }));
          return successResponse(stored, {});
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          return errorResponse(405, "method_not_allowed", "Use GET or HEAD.", { allow: "GET, HEAD" });
        }
        const session = relay.authorizeSession(assetCredential(request));
        if (session.role === "authority") {
          if (request.method !== "HEAD") {
            throw new XrHttpError(403, "forbidden", "Operation is not allowed.");
          }
          let trusted = false;
          try {
            trusted = await abortable(Promise.resolve(options.trustedLocalAuthority(request)), request.signal);
          } catch (error) {
            if (error instanceof XrRequestAbortedError) throw error;
          }
          if (!trusted) throw new XrHttpError(401, "unauthorized", "Authentication failed.");
          const metadata = assetCache.head(assetDigest!);
          const scope = assetScopes.get(assetDigest!);
          if (!metadata || !scope) {
            assetScopes.delete(assetDigest!);
            return errorResponse(404, "asset_not_found", "XR asset is unavailable.", responseCorsHeaders);
          }
          if (scope.workspaceId !== session.workspaceId || scope.authorityEpoch !== session.authorityEpoch) {
            return errorResponse(404, "asset_not_found", "XR asset is unavailable.", responseCorsHeaders);
          }
          const headers = new Headers(BASE_RESPONSE_HEADERS);
          headers.set("content-length", String(metadata.descriptor.byteLength));
          headers.set("content-type", metadata.descriptor.mediaType);
          headers.set("etag", `"${metadata.descriptor.digest}"`);
          headers.set(XR_ASSET_HTTP_DIGEST_HEADER, metadata.descriptor.digest);
          headers.set(XR_ASSET_HTTP_FORMAT_HEADER, metadata.descriptor.format);
          headers.set(XR_ASSET_HTTP_LENGTH_HEADER, String(metadata.descriptor.byteLength));
          return new Response(null, { status: 200, headers });
        }
        if (session.role !== "xr_renderer") throw new XrHttpError(403, "forbidden", "Operation is not allowed.");
        responseCorsHeaders = assetCorsHeadersFor(request, origins);
        const metadata = assetCache.head(assetDigest!);
        const scope = assetScopes.get(assetDigest!);
        if (!metadata || !scope) {
          assetScopes.delete(assetDigest!);
          return errorResponse(404, "asset_not_found", "XR asset is unavailable.", responseCorsHeaders);
        }
        if (scope.workspaceId !== session.workspaceId || scope.authorityEpoch !== session.authorityEpoch) {
          return errorResponse(404, "asset_not_found", "XR asset is unavailable.", responseCorsHeaders);
        }
        const range = assetRange(request, metadata.descriptor.byteLength);
        const opened = assetCache.open({ digest: assetDigest!, ...(range ? { range } : {}) });
        const headers = new Headers(responseCorsHeaders);
        headers.set("access-control-expose-headers", [
          "content-length", "content-range", "etag", XR_ASSET_HTTP_DIGEST_HEADER,
          XR_ASSET_HTTP_FORMAT_HEADER, XR_ASSET_HTTP_LENGTH_HEADER,
        ].join(", "));
        headers.set("accept-ranges", opened.acceptRanges);
        headers.set("cache-control", opened.cacheControl);
        headers.set("content-length", String(opened.contentLength));
        headers.set("content-type", opened.descriptor.mediaType);
        headers.set("etag", opened.etag);
        headers.set("permissions-policy", BASE_RESPONSE_HEADERS["permissions-policy"]);
        headers.set("referrer-policy", BASE_RESPONSE_HEADERS["referrer-policy"]);
        headers.set("x-content-type-options", BASE_RESPONSE_HEADERS["x-content-type-options"]);
        headers.set(XR_ASSET_HTTP_DIGEST_HEADER, opened.descriptor.digest);
        headers.set(XR_ASSET_HTTP_FORMAT_HEADER, opened.descriptor.format);
        headers.set(XR_ASSET_HTTP_LENGTH_HEADER, String(opened.descriptor.byteLength));
        if (opened.status === "partial") {
          headers.set("content-range", `bytes ${opened.range.start}-${opened.range.endExclusive - 1}/${opened.range.totalBytes}`);
        }
        return new Response(request.method === "HEAD" ? null : streamResponse(opened.stream(), request.signal), {
          status: opened.status === "partial" ? 206 : 200,
          headers,
        });
      }
      const route = routeFor(request);
      if (!route) return errorResponse(404, "not_found", "Route not found.", responseCorsHeaders);

      if (request.method === "OPTIONS") {
        if (!RENDERER_CORS_ROUTES.has(route)) {
          return errorResponse(405, "method_not_allowed", "Use POST.", {
            allow: "POST",
          });
        }
        return preflightResponse(request, origins);
      }

      if (RENDERER_CORS_ROUTES.has(route)) {
        responseCorsHeaders = corsHeadersFor(request, origins);
      }
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "Use POST.", {
          ...Object.fromEntries(new Headers(responseCorsHeaders)),
          allow: "POST",
        });
      }

      if (route === XR_HTTP_PATHS.authorityConnect) {
        let trusted = false;
        try {
          trusted = await abortable(
            Promise.resolve(options.trustedLocalAuthority(request)),
            request.signal,
          );
        } catch (error) {
          if (error instanceof XrRequestAbortedError) throw error;
        }
        throwIfAborted(request.signal);
        if (!trusted) throw new XrHttpError(401, "unauthorized", "Authentication failed.");
      }

      const body = await readBoundedJson(
        request,
        route === XR_HTTP_PATHS.sessionSend ? messageLimit : controlLimit,
      );
      throwIfAborted(request.signal);

      switch (route) {
        case XR_HTTP_PATHS.authorityConnect: {
          const input = exactObject(body, ["workspaceId", "requestId"], ["workspaceId"]);
          return successResponse(relay.connectAuthority({
            workspaceId: input.workspaceId,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          }), responseCorsHeaders);
        }

        case XR_HTTP_PATHS.authorityPairings: {
          const input = exactObject(body, ["sessionId", "ttlMs", "voiceRelay"], []);
          if (input.voiceRelay !== undefined && typeof input.voiceRelay !== "boolean") {
            throw new XrHttpError(400, "invalid_request", "voiceRelay must be boolean.");
          }
          const credential = authorizationCredential(request, input);
          throwIfAborted(request.signal);
          return successResponse(relay.createPairing(credential, {
            ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
            ...(input.voiceRelay === undefined ? {} : { voiceRelay: input.voiceRelay }),
          }), responseCorsHeaders);
        }

        case XR_HTTP_PATHS.authorityPairingsRevoke: {
          const input = exactObject(body, ["sessionId", "pairingId"], ["pairingId"]);
          const credential = authorizationCredential(request, input);
          throwIfAborted(request.signal);
          const revoked = relay.revokePairing(credential, { pairingId: input.pairingId });
          await relay.drainRendererRemovals();
          return successResponse({ revoked }, responseCorsHeaders);
        }

        case XR_HTTP_PATHS.rendererConnect: {
          const input = exactObject(body, ["pairingToken"], ["pairingToken"]);
          throwIfAborted(request.signal);
          return successResponse(relay.connectRenderer({ pairingToken: input.pairingToken }), responseCorsHeaders);
        }

        case XR_HTTP_PATHS.sessionSend: {
          const input = exactObject(body, ["sessionId", "message"], ["message"]);
          const credential = authorizationCredential(request, input);
          throwIfAborted(request.signal);
          return successResponse({ response: relay.acceptMessage(credential, input.message) }, responseCorsHeaders);
        }

        case XR_HTTP_PATHS.sessionPoll: {
          const input = exactObject(body, ["sessionId", "acknowledgedDeliveryIds"], []);
          const credential = authorizationCredential(request, input);
          throwIfAborted(request.signal);
          const deliveries = relay.pollDeliveries(
            credential,
            input.acknowledgedDeliveryIds ?? [],
          );
          await relay.drainRendererRemovals();
          return successResponse({
            mode: XR_HTTP_POLL_MODE,
            deliveries: boundedPollDeliveries(deliveries),
          }, responseCorsHeaders);
        }

        case XR_HTTP_PATHS.rendererReconnect: {
          const input = exactObject(body, ["sessionId", "cursor"], ["cursor"]);
          const credential = authorizationCredential(request, input);
          throwIfAborted(request.signal);
          const plan = relay.planReconnect(credential, input.cursor);
          return successResponse({ plan }, responseCorsHeaders);
        }

        case XR_HTTP_PATHS.rendererUltraProbe: {
          const input = exactObject(body, ["sessionId", "browser"], ["browser"]);
          const credential = authorizationCredential(request, input);
          const session = relay.authorizeSession(credential);
          if (session.role !== "xr_renderer") {
            throw new XrHttpError(403, "forbidden", "Operation is not allowed.");
          }
          if (!options.ultraEvidence) {
            throw new XrHttpError(
              503,
              "ultra_evidence_unavailable",
              "Windows Ultra native evidence is not configured.",
            );
          }
          const browser = parseUltraBrowserEvidence(input.browser);
          ultraRequestLimiter.take(session.sessionId, "probe");
          try {
            const probe = await abortable(
              options.ultraEvidence.collectStaticProbe(
                Object.freeze({ rendererSessionId: session.sessionId }),
                browser,
                request.signal,
              ),
              request.signal,
            );
            return successResponse({ probe }, responseCorsHeaders);
          } catch (cause) {
            if (cause instanceof XrRequestAbortedError) throw cause;
            throw new XrHttpError(503, "ultra_evidence_unavailable", "Windows Ultra native evidence failed.");
          }
        }

        case XR_HTTP_PATHS.rendererUltraSample: {
          const input = exactObject(body, ["sessionId"], []);
          const credential = authorizationCredential(request, input);
          const session = relay.authorizeSession(credential);
          if (session.role !== "xr_renderer") {
            throw new XrHttpError(403, "forbidden", "Operation is not allowed.");
          }
          if (!options.ultraEvidence) {
            throw new XrHttpError(
              503,
              "ultra_evidence_unavailable",
              "Windows Ultra native evidence is not configured.",
            );
          }
          ultraRequestLimiter.take(session.sessionId, "sample");
          try {
            const sample = await abortable(
              options.ultraEvidence.sampleRuntime(
                Object.freeze({ rendererSessionId: session.sessionId }),
                request.signal,
              ),
              request.signal,
            );
            return successResponse({ sample }, responseCorsHeaders);
          } catch (cause) {
            if (cause instanceof XrRequestAbortedError) throw cause;
            throw new XrHttpError(503, "ultra_evidence_unavailable", "Windows Ultra native evidence failed.");
          }
        }

        case XR_HTTP_PATHS.sessionDisconnect: {
          const input = exactObject(body, ["sessionId"], []);
          const credential = authorizationCredential(request, input);
          throwIfAborted(request.signal);
          const disconnected = relay.disconnectSession(credential);
          await relay.drainRendererRemovals();
          if (disconnected) ultraRequestLimiter.forget(credential.sessionId);
          return successResponse({ disconnected }, responseCorsHeaders);
        }
      }
    } catch (error) {
      if (error instanceof XrRequestAbortedError) {
        return errorResponse(408, "request_aborted", "Request was aborted.", responseCorsHeaders);
      }
      if (error instanceof XrHttpError) {
        return errorResponse(error.status, error.code, error.message, responseCorsHeaders);
      }
      if (error instanceof XrRelayControlError) {
        // Session authorization can discover that a renderer lease expired.
        // XrRelay removes that renderer synchronously, but adjacent-service
        // cleanup (notably its unsent Voice Relay draft) is asynchronous. Never
        // acknowledge the terminal authorization result until that cleanup has
        // either completed or failed closed.
        try {
          await relay.drainRendererRemovals();
        } catch {
          return errorResponse(
            503,
            "renderer_cleanup_failed",
            "XR renderer cleanup could not be completed safely.",
            responseCorsHeaders,
          );
        }
        return relayFailure(error, responseCorsHeaders);
      }
      if (error instanceof XrAssetRelayError || error instanceof XrAssetValidationError) {
        return assetFailure(error, responseCorsHeaders);
      }
      if (error instanceof XrProtocolValidationError) {
        return errorResponse(400, "invalid_request", "Request body is invalid.", responseCorsHeaders);
      }
      return errorResponse(500, "internal_error", "Request failed.", responseCorsHeaders);
    }
  };
}
