import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createAgentMcpServer,
  type AgentMcpBackendResult,
} from "../server/agent/AgentMcpServer";
import type { AgentCommandName } from "../server/agent/contracts";

const upstreamUrl = (() => {
  const raw = process.env.SEMAFRAME_AGENT_MCP_URL?.trim();
  if (!raw) {
    throw new Error(
      "SEMAFRAME_AGENT_MCP_URL is required. Copy a fresh MCP setup from SemaFrame agent controls.",
    );
  }
  const url = new URL(raw);
  const isLoopbackHttp = url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || isLoopbackHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  ) {
    throw new Error(
      "SEMAFRAME_AGENT_MCP_URL must be an exact unauthenticated HTTPS or loopback HTTP MCP connection URL.",
    );
  }
  return url;
})();

const configuredClientName = process.env.SEMAFRAME_AGENT_NAME
  ?.trim()
  .replace(/[\u0000-\u001f\u007f]/gu, " ")
  .replace(/\s+/gu, " ")
  .slice(0, 100);

let upstreamClient: Client | undefined;
let upstreamConnection: Promise<Client> | undefined;
let upstreamAttemptClient: Client | undefined;
let upstreamAttemptTransport: StreamableHTTPClientTransport | undefined;
let upstreamAttemptAbort: AbortController | undefined;
let closing = false;

async function connectUpstream(): Promise<Client> {
  if (upstreamClient) return upstreamClient;
  if (upstreamConnection) return upstreamConnection;
  const connection = (async () => {
    if (closing) throw new DOMException("The stdio bridge is closing", "AbortError");
    const client = new Client({
      name: configuredClientName || "SemaFrame stdio bridge",
      version: "1.0.0",
    });
    const controller = new AbortController();
    const transport = new StreamableHTTPClientTransport(new URL(upstreamUrl), {
      fetch: (input, init) => {
        const requestSignal = init?.signal;
        const signal = requestSignal
          ? AbortSignal.any([requestSignal, controller.signal])
          : controller.signal;
        return fetch(input, { ...init, signal });
      },
    });
    upstreamAttemptClient = client;
    upstreamAttemptTransport = transport;
    upstreamAttemptAbort = controller;
    try {
      await client.connect(transport);
      if (closing) {
        await client.close().catch(() => undefined);
        throw new DOMException("The stdio bridge is closing", "AbortError");
      }
      upstreamClient = client;
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      if (upstreamAttemptClient === client) upstreamAttemptClient = undefined;
      if (upstreamAttemptTransport === transport) upstreamAttemptTransport = undefined;
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
  if (status === 410 || status === 404) {
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
          : "The SemaFrame MCP connection is unavailable. Open SemaFrame and copy a fresh MCP setup.",
        retryable: true,
        required_action: "get_workspace_instructions",
      },
    },
  };
}

/**
 * The stdio adapter is a transport bridge, not a second authority path. Every
 * tool call traverses the exact browser-approved Streamable HTTP MCP offer, so
 * non-default scopes and reconstruction principals are resolved by the same
 * gateway code as a direct HTTP client. Pairing bearers and approval tokens are
 * never invented, cached, or injected here.
 */
async function callUpstream(name: AgentCommandName, input: unknown): Promise<AgentMcpBackendResult> {
  try {
    const client = await connectUpstream();
    const result = await client.callTool({
      name,
      arguments: input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {},
    });
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
  } catch (error) {
    const failedClient = upstreamClient;
    upstreamClient = undefined;
    await failedClient?.close().catch(() => undefined);
    return gatewayUnavailable(error);
  }
}

const handle = serveStdio(
  ({ era }) => createAgentMcpServer(
    { dispatch: (name, input) => callUpstream(name, input) },
    { protocolEra: era },
  ),
);

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  const pending = upstreamConnection;
  const attemptClient = upstreamAttemptClient;
  const attemptTransport = upstreamAttemptTransport;
  upstreamAttemptAbort?.abort();
  await attemptTransport?.close().catch(() => undefined);
  await attemptClient?.close().catch(() => undefined);
  await handle.close().catch(() => undefined);
  await pending?.catch(() => undefined);
  await upstreamClient?.close().catch(() => undefined);
  upstreamClient = undefined;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void close(); });
}
