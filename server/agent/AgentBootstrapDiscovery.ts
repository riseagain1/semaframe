import { createHash } from "node:crypto";
import { AGENT_HOST_CONTROL_COMMAND_NAMES } from "../../src/agent/hostControlContracts";
import { WORKSPACE_AGENT_TOOL_NAMES } from "../../src/workspace/agents/contracts";
import type { AgentGateway, AgentOfferStatus } from "./AgentGateway";
import { AGENT_MCP_SERVER_INFO } from "./AgentMcpServer";

export const AGENT_BOOTSTRAP_DISCOVERY_PATH = "/.well-known/semaframe-agent" as const;
export const DEFAULT_AGENT_GATEWAY_URL = "http://127.0.0.1:8788" as const;
export const AGENT_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

const MAXIMUM_DISCOVERY_BYTES = 16 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const OFFER_STATUSES = new Set<AgentOfferStatus>([
  "waiting",
  "approval_pending",
  "approval_granted",
  "approved",
  "denied",
  "expired",
]);
const FORWARDED_HEADER_NAMES = new Set([
  "forwarded",
  "via",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
]);

export const AGENT_TOOLSET_DIGEST = `sha256:${createHash("sha256")
  .update(JSON.stringify({
    serverVersion: AGENT_MCP_SERVER_INFO.version,
    tools: [...WORKSPACE_AGENT_TOOL_NAMES, ...AGENT_HOST_CONTROL_COMMAND_NAMES].sort(),
  }))
  .digest("hex")}` as const;

export type AgentBootstrapDocument = Readonly<{
  schema_version: typeof AGENT_BOOTSTRAP_SCHEMA_VERSION;
  service: "semaframe-agent";
  connection_url: string;
  gateway_instance_id: string;
  toolset_digest: typeof AGENT_TOOLSET_DIGEST | `sha256:${string}`;
  offer_status: AgentOfferStatus;
  approval_required: true;
}>;

export type AgentBootstrapDiscoveryHandler = Readonly<{
  matches(pathname: string): boolean;
  fetch(request: Request, peerAddress: string | undefined): Response;
}>;

export class AgentBootstrapDiscoveryError extends Error {
  constructor(
    readonly code: "gateway_unavailable" | "invalid_discovery_response",
    message: string,
  ) {
    super(message);
    this.name = "AgentBootstrapDiscoveryError";
  }
}

function gatewayUnavailableDiscoveryError(
  error: unknown,
  signal: AbortSignal | undefined,
): AgentBootstrapDiscoveryError {
  const errorName = error && typeof error === "object" && "name" in error
    ? (error as { name?: unknown }).name
    : undefined;
  // Some Response implementations wrap a stream abort in a generic TypeError
  // after headers have resolved. The supplied signal remains authoritative.
  const timedOut = signal?.aborted === true
    || errorName === "AbortError"
    || errorName === "TimeoutError";
  return new AgentBootstrapDiscoveryError(
    "gateway_unavailable",
    timedOut
      ? "SemaFrame discovery timed out."
      : "The local SemaFrame gateway is unavailable.",
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

export function normalizeAgentGatewayUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:"
    || !isLoopbackHostname(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new TypeError(
      "SEMAFRAME_AGENT_GATEWAY_URL must be an exact loopback HTTP origin without credentials, path, query, or fragment.",
    );
  }
  return parsed.origin;
}

export function normalizeAgentMcpConnectionUrl(value: string): URL {
  const parsed = new URL(value);
  const isLoopbackHttp = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (
    !(parsed.protocol === "https:" || isLoopbackHttp)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !/^\/mcp\/connect\/[A-Za-z0-9_-]{16,128}$/u.test(parsed.pathname)
  ) {
    throw new TypeError(
      "The discovered SemaFrame connection URL must be an exact HTTPS or loopback HTTP MCP offer URL.",
    );
  }
  return parsed;
}

function jsonResponse(status: number, payload: unknown, head = false, extraHeaders: HeadersInit = {}): Response {
  const body = JSON.stringify(payload);
  return new Response(head ? null : body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function isLoopbackPeer(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().split("%")[0];
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}

function containsForwardedIdentity(headers: Headers): boolean {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("x-forwarded-") || FORWARDED_HEADER_NAMES.has(normalized)) return true;
  }
  return false;
}

/**
 * Fixed, non-authorizing bootstrap discovery for a local stdio launcher.
 *
 * The listener itself is loopback-only, and this boundary independently
 * verifies both the socket peer and exact Host authority. Browser requests,
 * reverse-proxy identity headers, redirects, and alternate authorities fail
 * closed. The document exposes no bearer, approval token, CSRF capability, or
 * browser connection ID; possession of its offer URL grants no authority.
 */
export function createAgentBootstrapDiscoveryHandler(
  gateway: AgentGateway,
  gatewayBaseUrl: string,
): AgentBootstrapDiscoveryHandler {
  const normalizedBaseUrl = normalizeAgentGatewayUrl(gatewayBaseUrl);
  const expectedHost = new URL(normalizedBaseUrl).host.toLowerCase();

  return Object.freeze({
    matches: (pathname) => pathname === AGENT_BOOTSTRAP_DISCOVERY_PATH,
    fetch: (request, peerAddress) => {
      const url = new URL(request.url);
      const head = request.method === "HEAD";
      if (url.pathname !== AGENT_BOOTSTRAP_DISCOVERY_PATH || url.search || url.hash) {
        return jsonResponse(404, { error: { code: "not_found", message: "Not found." } }, head);
      }
      if (request.method !== "GET" && !head) {
        return jsonResponse(405, {
          error: { code: "method_not_allowed", message: "Use GET or HEAD." },
        }, false, { allow: "GET, HEAD" });
      }
      if (
        !isLoopbackPeer(peerAddress)
        || request.headers.get("host")?.trim().toLowerCase() !== expectedHost
        || request.headers.has("origin")
        || containsForwardedIdentity(request.headers)
      ) {
        return jsonResponse(403, {
          error: { code: "bootstrap_discovery_denied", message: "Local bootstrap discovery was denied." },
        }, head);
      }

      const config = gateway.getConfig();
      if (!config.enabled || !config.connectionUrl || !config.offerStatus) {
        return jsonResponse(503, {
          error: {
            code: "agent_mode_disabled",
            message: "Open SemaFrame and enable Agent control before connecting.",
          },
        }, head, { "retry-after": "1" });
      }
      const offerPathname = normalizeAgentMcpConnectionUrl(config.connectionUrl).pathname;
      const payload: AgentBootstrapDocument = Object.freeze({
        schema_version: AGENT_BOOTSTRAP_SCHEMA_VERSION,
        service: "semaframe-agent",
        // A local launcher must never be sent through an advertised reverse
        // proxy. Only the opaque, non-authorizing offer pathname is reused.
        connection_url: new URL(offerPathname, normalizedBaseUrl).href,
        gateway_instance_id: config.gatewayInstanceId,
        toolset_digest: AGENT_TOOLSET_DIGEST,
        offer_status: config.offerStatus,
        approval_required: true,
      });
      return jsonResponse(200, payload, head);
    },
  });
}

function exactBootstrapDocument(value: unknown): AgentBootstrapDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentBootstrapDiscoveryError("invalid_discovery_response", "SemaFrame discovery returned an invalid document.");
  }
  const document = value as Record<string, unknown>;
  const expectedKeys = [
    "approval_required",
    "connection_url",
    "gateway_instance_id",
    "offer_status",
    "schema_version",
    "service",
    "toolset_digest",
  ];
  if (Object.keys(document).sort().join("\n") !== expectedKeys.join("\n")) {
    throw new AgentBootstrapDiscoveryError("invalid_discovery_response", "SemaFrame discovery returned unsupported fields.");
  }
  if (
    document.schema_version !== AGENT_BOOTSTRAP_SCHEMA_VERSION
    || document.service !== "semaframe-agent"
    || document.approval_required !== true
    || typeof document.gateway_instance_id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(document.gateway_instance_id)
    || typeof document.toolset_digest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(document.toolset_digest)
    || typeof document.offer_status !== "string"
    || !OFFER_STATUSES.has(document.offer_status as AgentOfferStatus)
    || typeof document.connection_url !== "string"
  ) {
    throw new AgentBootstrapDiscoveryError("invalid_discovery_response", "SemaFrame discovery returned invalid field values.");
  }
  const connectionUrl = normalizeAgentMcpConnectionUrl(document.connection_url).href;
  return Object.freeze({
    schema_version: AGENT_BOOTSTRAP_SCHEMA_VERSION,
    service: "semaframe-agent",
    connection_url: connectionUrl,
    gateway_instance_id: document.gateway_instance_id,
    toolset_digest: document.toolset_digest as `sha256:${string}`,
    offer_status: document.offer_status as AgentOfferStatus,
    approval_required: true,
  });
}

async function readBoundedDiscoveryBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAXIMUM_DISCOVERY_BYTES) {
    throw new AgentBootstrapDiscoveryError("invalid_discovery_response", "SemaFrame discovery response was too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAXIMUM_DISCOVERY_BYTES) {
        await reader.cancel();
        throw new AgentBootstrapDiscoveryError("invalid_discovery_response", "SemaFrame discovery response was too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function discoverAgentMcpOffer(
  gatewayBaseUrl: string,
  options: Readonly<{
    fetch?: typeof fetch;
    signal?: AbortSignal;
  }> = {},
): Promise<AgentBootstrapDocument> {
  const baseUrl = normalizeAgentGatewayUrl(gatewayBaseUrl);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${baseUrl}${AGENT_BOOTSTRAP_DISCOVERY_PATH}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof AgentBootstrapDiscoveryError) throw error;
    throw gatewayUnavailableDiscoveryError(error, options.signal);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new AgentBootstrapDiscoveryError(
      "gateway_unavailable",
      response.status === 503
        ? "Open SemaFrame and enable Agent control before connecting."
        : "The local SemaFrame gateway refused bootstrap discovery.",
    );
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new AgentBootstrapDiscoveryError("invalid_discovery_response", "SemaFrame discovery did not return JSON.");
  }
  let body: string;
  try {
    body = await readBoundedDiscoveryBody(response);
  } catch (error) {
    if (error instanceof AgentBootstrapDiscoveryError) throw error;
    // A fetch promise may resolve as soon as response headers arrive. Preserve
    // transport/timeout classification when the body later stalls or fails;
    // only successfully read bytes can be classified as malformed JSON.
    throw gatewayUnavailableDiscoveryError(error, options.signal);
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new AgentBootstrapDiscoveryError("invalid_discovery_response", "SemaFrame discovery returned invalid JSON.");
  }
  const document = exactBootstrapDocument(value);
  if (new URL(document.connection_url).origin !== baseUrl) {
    throw new AgentBootstrapDiscoveryError(
      "invalid_discovery_response",
      "SemaFrame discovery returned an MCP offer outside the configured local gateway origin.",
    );
  }
  return document;
}
