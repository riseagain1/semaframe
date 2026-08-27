import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  CallToolResult,
  RegisteredTool,
  Tool,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createAgentMcpServer,
  type AgentMcpBackendResult,
} from "../server/agent/AgentMcpServer";
import {
  AgentMcpToolCatalogRefreshCoordinator,
  executeAgentMcpUpstreamCall,
} from "../server/agent/AgentMcpBridgeReliability";
import type { AgentCommandName } from "../server/agent/contracts";
import {
  DEFAULT_AGENT_GATEWAY_URL,
  type AgentBootstrapDocument,
  discoverAgentMcpOffer,
  normalizeAgentGatewayUrl,
  normalizeAgentMcpConnectionUrl,
} from "../server/agent/AgentBootstrapDiscovery";
import {
  AgentMcpToolMirror,
  trackAgentMcpToolMirrorLifecycle,
} from "../server/agent/AgentMcpToolMirror";

const configuredGatewayUrl = process.env.SEMAFRAME_AGENT_GATEWAY_URL?.trim();
const configuredLegacyOfferUrl = process.env.SEMAFRAME_AGENT_MCP_URL?.trim();

function configuredTimeout(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 60_000) {
    throw new TypeError("SEMAFRAME_AGENT_CONNECT_TIMEOUT_MS must be an integer between 100 and 60000.");
  }
  return parsed;
}

const connectTimeoutMs = configuredTimeout(
  process.env.SEMAFRAME_AGENT_CONNECT_TIMEOUT_MS,
  10_000,
);

function normalizeLegacyConnectionUrl(value: string): URL {
  const url = new URL(value);
  const isLoopbackHttp = url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || isLoopbackHttp)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname === "/"
  ) {
    throw new TypeError(
      "SEMAFRAME_AGENT_MCP_URL must be an exact unauthenticated HTTPS or loopback HTTP MCP connection URL.",
    );
  }
  return url;
}

// A stable installation always supplies (or defaults to) the fixed loopback
// Gateway origin. The old one-off offer variable remains a compatibility path
// only when the stable variable is absent.
const gatewayUrl = configuredGatewayUrl
  ? normalizeAgentGatewayUrl(configuredGatewayUrl)
  : configuredLegacyOfferUrl
    ? undefined
    : DEFAULT_AGENT_GATEWAY_URL;
const legacyUpstreamUrl = gatewayUrl
  ? undefined
  : normalizeLegacyConnectionUrl(configuredLegacyOfferUrl!);

const configuredClientName = process.env.SEMAFRAME_AGENT_NAME
  ?.trim()
  .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, 100);

let upstreamClient: Client | undefined;
let upstreamConnection: Promise<Client> | undefined;
let upstreamAttemptClient: Client | undefined;
let upstreamAttemptTransport: StreamableHTTPClientTransport | undefined;
let upstreamAttemptAbort: AbortController | undefined;
let reconnectAbort: AbortController | undefined;
let reconnectPromise: Promise<void> | undefined;
let discoveryMonitorAbort: AbortController | undefined;
let discoveryMonitorPromise: Promise<void> | undefined;
let upstreamDiscovery: AgentBootstrapDocument | undefined;
let latestToolCatalog: readonly Tool[] | undefined;
const toolMirrors = new Set<AgentMcpToolMirror>();
const toolCatalogRefreshes = new AgentMcpToolCatalogRefreshCoordinator<Client>();
let closing = false;
let closePromise: Promise<void> | undefined;

async function resolveUpstream(signal: AbortSignal): Promise<Readonly<{
  url: URL;
  discovery?: AgentBootstrapDocument;
}>> {
  if (legacyUpstreamUrl) return Object.freeze({ url: new URL(legacyUpstreamUrl) });
  const discovery = await discoverAgentMcpOffer(gatewayUrl!, { signal });
  return Object.freeze({
    url: normalizeAgentMcpConnectionUrl(discovery.connection_url),
    discovery,
  });
}

function synchronizeToolCatalog(tools: readonly Tool[]): void {
  const snapshot = structuredClone(tools);
  for (const mirror of toolMirrors) mirror.synchronize(snapshot);
  latestToolCatalog = Object.freeze(snapshot);
}

async function refreshToolCatalog(
  client: Client,
  signal: AbortSignal,
  timeoutMs = Math.min(connectTimeoutMs, 5_000),
): Promise<void> {
  await toolCatalogRefreshes.refresh(
    client,
    async () => (await client.listTools(undefined, {
      cacheMode: "refresh",
      signal,
      timeout: timeoutMs,
    })).tools,
    (tools) => {
      if (upstreamClient !== client && upstreamAttemptClient !== client) return;
      synchronizeToolCatalog(tools);
    },
  );
}

async function invalidateUpstream(client: Client): Promise<void> {
  toolCatalogRefreshes.invalidate(client);
  if (upstreamClient === client) {
    upstreamClient = undefined;
    upstreamDiscovery = undefined;
  }
  await client.close().catch(() => undefined);
  beginReconnect();
}

async function connectUpstream(): Promise<Client> {
  if (upstreamClient) return upstreamClient;
  if (upstreamConnection) return upstreamConnection;
  const connection = (async () => {
    if (closing) throw new DOMException("The stdio bridge is closing", "AbortError");
    const client = new Client(
      {
        name: configuredClientName || "SemaFrame stdio bridge",
        version: "1.0.0",
      },
      {
        // Prefer the modern per-request HTTP transport so a cancelled stdio
        // call aborts only its matching upstream fetch. `auto` retains a
        // bounded legacy fallback for older MCP endpoints.
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: Math.min(connectTimeoutMs, 5_000) },
        },
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: (error) => {
              if (upstreamClient !== client && upstreamAttemptClient !== client) return;
              if (error) {
                void invalidateUpstream(client);
                return;
              }
              void refreshToolCatalog(client, AbortSignal.timeout(Math.min(connectTimeoutMs, 5_000)))
                .catch(() => invalidateUpstream(client));
            },
          },
        },
      },
    );
    const controller = new AbortController();
    upstreamAttemptClient = client;
    upstreamAttemptAbort = controller;
    let transport: StreamableHTTPClientTransport | undefined;
    let connectionTimeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(),
      connectTimeoutMs,
    );
    try {
      const resolved = await resolveUpstream(controller.signal);
      transport = new StreamableHTTPClientTransport(resolved.url, {
        fetch: (input, init) => {
          const requestSignal = init?.signal;
          const signal = requestSignal
            ? AbortSignal.any([requestSignal, controller.signal])
            : controller.signal;
          return fetch(input, { ...init, signal });
        },
      });
      upstreamAttemptTransport = transport;
      await client.connect(transport);
      if (closing) {
        await client.close().catch(() => undefined);
        throw new DOMException("The stdio bridge is closing", "AbortError");
      }
      await refreshToolCatalog(client, controller.signal, connectTimeoutMs);
      clearTimeout(connectionTimeout);
      connectionTimeout = undefined;
      upstreamClient = client;
      upstreamDiscovery = resolved.discovery;
      beginDiscoveryMonitor();
      return client;
    } catch (error) {
      toolCatalogRefreshes.invalidate(client);
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      if (connectionTimeout) clearTimeout(connectionTimeout);
      if (upstreamAttemptClient === client) upstreamAttemptClient = undefined;
      if (transport && upstreamAttemptTransport === transport) upstreamAttemptTransport = undefined;
      if (upstreamAttemptAbort === controller) upstreamAttemptAbort = undefined;
    }
  })();
  upstreamConnection = connection;
  try {
    return await connection;
  } finally {
    if (upstreamConnection === connection) upstreamConnection = undefined;
  }
}

function reconnectDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Reconnect stopped", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Reconnect stopped", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function beginDiscoveryMonitor(): void {
  if (!gatewayUrl || closing || discoveryMonitorPromise) return;
  const controller = new AbortController();
  discoveryMonitorAbort = controller;
  discoveryMonitorPromise = (async () => {
    while (!closing && !controller.signal.aborted) {
      try {
        await reconnectDelay(controller.signal, 750);
      } catch {
        return;
      }
      let discovered: AgentBootstrapDocument;
      try {
        discovered = await discoverAgentMcpOffer(gatewayUrl, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(Math.min(connectTimeoutMs, 5_000)),
          ]),
        });
      } catch {
        // A restart has an expected unavailable window. Keep the last public
        // catalog and let the next bounded poll discover its replacement.
        continue;
      }
      const previous = upstreamDiscovery;
      const client = upstreamClient;
      if (!previous || !client) continue;
      if (
        discovered.gateway_instance_id !== previous.gateway_instance_id
        || discovered.connection_url !== previous.connection_url
      ) {
        toolCatalogRefreshes.invalidate(client);
        upstreamClient = undefined;
        upstreamDiscovery = undefined;
        await client.close().catch(() => undefined);
        beginReconnect();
        continue;
      }
      if (discovered.toolset_digest !== previous.toolset_digest) {
        try {
          await refreshToolCatalog(
            client,
            AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(Math.min(connectTimeoutMs, 5_000)),
            ]),
          );
        } catch {
          await invalidateUpstream(client);
          continue;
        }
      }
      upstreamDiscovery = discovered;
    }
  })().finally(() => {
    if (discoveryMonitorAbort === controller) discoveryMonitorAbort = undefined;
    discoveryMonitorPromise = undefined;
  });
}

/**
 * Reconnect in the background without replaying the failed tool call. A
 * transport failure can have an ambiguous mutation outcome, so only the MCP
 * host/Agent may explicitly retry that transaction. The persistent launcher
 * itself nevertheless discovers the replacement offer and reconnects, which
 * keeps the installed MCP configuration valid across Gateway restarts.
 */
function beginReconnect(): void {
  if (legacyUpstreamUrl || closing || reconnectPromise || upstreamClient) return;
  const controller = new AbortController();
  reconnectAbort = controller;
  reconnectPromise = (async () => {
    let delay = 100;
    while (!closing && !controller.signal.aborted && !upstreamClient) {
      try {
        await connectUpstream();
        return;
      } catch {
        if (closing || controller.signal.aborted) return;
      }
      try {
        await reconnectDelay(controller.signal, delay);
      } catch {
        return;
      }
      delay = Math.min(delay * 2, 5_000);
    }
  })().finally(() => {
    if (reconnectAbort === controller) reconnectAbort = undefined;
    reconnectPromise = undefined;
  });
}

function upstreamHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const nested = (data as { status?: unknown }).status;
  return typeof nested === "number" ? nested : undefined;
}

function gatewayUnavailable(error: unknown): AgentMcpBackendResult {
  const status = upstreamHttpStatus(error);
  if (legacyUpstreamUrl && (status === 410 || status === 404)) {
    return {
      responseOk: false,
      status,
      payload: {
        ok: false,
        error: {
          code: status === 410 ? "connection_offer_expired" : "connection_invalid",
          message: "This SemaFrame MCP offer is no longer valid. Copy a fresh setup from the open app.",
          retryable: false,
        },
      },
    };
  }
  return {
    responseOk: false,
    status: 503,
    payload: {
      ok: false,
      error: {
        code: "gateway_unavailable",
        message: error instanceof Error && error.name === "AbortError"
          ? "The SemaFrame MCP connection timed out."
          : gatewayUrl
            ? "The SemaFrame MCP connection is unavailable. Open SemaFrame; the installed bridge will reconnect automatically."
            : "The SemaFrame MCP connection is unavailable. Open SemaFrame and copy a fresh MCP setup.",
        retryable: true,
        required_action: "get_workspace_instructions",
      },
    },
  };
}

function upstreamMcpRequestError(error: unknown): CallToolResult {
  const rawCode = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  const code = typeof rawCode === "number" && Number.isSafeInteger(rawCode)
    ? rawCode
    : typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(rawCode)
      ? rawCode
      : undefined;
  const payload = {
    ok: false,
    error: {
      code: "upstream_mcp_error",
      // Protocol/SDK messages are upstream-controlled and can contain local
      // paths, credentials, or prompt-like text. Preserve only the bounded
      // standardized code and product-authored copy at the downstream boundary.
      message: "The upstream SemaFrame MCP server rejected this request.",
      retryable: false,
      ...(code === undefined ? {} : { details: { mcp_code: code } }),
    },
  } as const;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

/**
 * The stdio adapter is a transport bridge, not a second authority path. Every
 * tool call traverses the exact browser-approved Streamable HTTP MCP offer, so
 * non-default scopes and reconstruction principals are resolved by the same
 * gateway code as a direct HTTP client. Pairing bearers and approval tokens are
 * never invented, cached, or injected here.
 */
async function callUpstreamRaw(
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  let client: Client | undefined;
  try {
    client = await connectUpstream();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The request was cancelled", "AbortError");
    beginReconnect();
    const failure = gatewayUnavailable(error);
    return {
      content: [{ type: "text", text: JSON.stringify(failure.payload, null, 2) }],
      structuredContent: failure.payload as Record<string, unknown>,
      isError: true,
    };
  }
  return executeAgentMcpUpstreamCall({
    ...(signal ? { signal } : {}),
    invoke: async () => await client!.callTool(
      {
        name,
        arguments: input && typeof input === "object" && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {},
      },
      signal ? { signal } : undefined,
    ) as CallToolResult,
    onRequestError: upstreamMcpRequestError,
    onConnectionError: async (error) => {
      // A discovery monitor may already have installed a replacement while
      // this call was failing. Invalidate only the client that handled this
      // call; never clear or close a newer healthy connection.
      await invalidateUpstream(client!);
      const failure = gatewayUnavailable(error);
      return {
        content: [{ type: "text", text: JSON.stringify(failure.payload, null, 2) }],
        structuredContent: failure.payload as Record<string, unknown>,
        isError: true,
      };
    },
  });
}

async function callUpstream(name: AgentCommandName, input: unknown): Promise<AgentMcpBackendResult> {
  const result = await callUpstreamRaw(name, input);
  try {
    const payload = result.structuredContent;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {
        responseOk: false,
        status: 502,
        payload: {
          ok: false,
          error: {
            code: "gateway_error",
            message: "The upstream SemaFrame MCP server returned no structured result.",
            retryable: false,
          },
        },
      };
    }
    return {
      responseOk: result.isError !== true,
      status: result.isError === true ? 409 : 200,
      payload,
    };
  } catch {
    return {
      responseOk: false,
      status: 502,
      payload: {
        ok: false,
        error: {
          code: "gateway_error",
          message: "The upstream SemaFrame MCP server returned an invalid result.",
          retryable: false,
        },
      },
    };
  }
}

const handle = serveStdio(({ era }) => {
  const initialRegistrations: Array<readonly [string, RegisteredTool]> = [];
  const server = createAgentMcpServer(
    { dispatch: (name, input) => callUpstream(name, input) },
    {
      protocolEra: era,
      onToolRegistered: (name, registration) => {
        initialRegistrations.push([name, registration]);
      },
    },
  );
  const mirror = new AgentMcpToolMirror(
    server,
    (name, input, signal) => callUpstreamRaw(name, input, signal),
  );
  for (const [name, registration] of initialRegistrations) mirror.seed(name, registration);
  trackAgentMcpToolMirrorLifecycle(server, mirror, toolMirrors);
  if (latestToolCatalog) mirror.synchronize(latestToolCatalog);
  if (gatewayUrl) {
    queueMicrotask(() => {
      void connectUpstream().catch(() => beginReconnect());
    });
  }
  return server;
});

function close(): Promise<void> {
  if (closePromise) return closePromise;
  closing = true;
  closePromise = (async () => {
    const pending = upstreamConnection;
    const reconnecting = reconnectPromise;
    const monitoring = discoveryMonitorPromise;
    const attemptClient = upstreamAttemptClient;
    const attemptTransport = upstreamAttemptTransport;
    const connectedClient = upstreamClient;
    upstreamClient = undefined;
    if (attemptClient) toolCatalogRefreshes.invalidate(attemptClient);
    if (connectedClient) toolCatalogRefreshes.invalidate(connectedClient);
    discoveryMonitorAbort?.abort();
    reconnectAbort?.abort();
    upstreamAttemptAbort?.abort();
    await attemptTransport?.close().catch(() => undefined);
    await attemptClient?.close().catch(() => undefined);
    // Abort an already-connected upstream tool call before asking the stdio
    // server to drain its matching downstream request.
    await connectedClient?.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await pending?.catch(() => undefined);
    await reconnecting?.catch(() => undefined);
    await monitoring?.catch(() => undefined);
    toolMirrors.clear();
  })();
  return closePromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void close(); });
}
// Some MCP hosts close the stdio pipe without delivering a signal. Treat EOF
// as the same shutdown request so an in-flight upstream fetch is never left
// holding the bridge process open.
process.stdin.once("end", () => { void close(); });
process.stdin.once("close", () => { void close(); });
