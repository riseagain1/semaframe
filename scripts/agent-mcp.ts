import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  AGENT_REST_PATHS,
  createAgentMcpServer,
  type AgentMcpBackendResult,
} from "../server/agent/AgentMcpServer";
import type { AgentCommandName } from "../server/agent/contracts";

const gatewayUrl = (() => {
  const url = new URL(process.env.SEMAFRAME_AGENT_GATEWAY_URL?.trim() || "http://127.0.0.1:8788");
  const isLoopbackHttp = url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || isLoopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("SEMAFRAME_AGENT_GATEWAY_URL must be an unauthenticated HTTPS origin or loopback HTTP origin.");
  }
  return url.origin;
})();

const pairingToken = process.env.SEMAFRAME_AGENT_TOKEN?.trim();
if (!pairingToken) throw new Error("SEMAFRAME_AGENT_TOKEN is required. Copy the MCP setup from SemaFrame agent controls.");
const clientName = process.env.SEMAFRAME_AGENT_NAME
  ?.trim()
  .replace(/[\u0000-\u001f\u007f]/gu, " ")
  .slice(0, 100) || undefined;

function restInput(name: AgentCommandName, input: unknown): unknown {
  if (name !== "get_workspace_instructions" ||
      !input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const { approval_token: _approvalToken, ...body } = input as Record<string, unknown>;
  return body;
}

async function callGateway(name: AgentCommandName, input: unknown): Promise<AgentMcpBackendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch(`${gatewayUrl}${AGENT_REST_PATHS[name]}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairingToken}`,
        "content-type": "application/json",
        ...(clientName ? { "x-semaframe-agent-name": clientName } : {}),
      },
      body: JSON.stringify(restInput(name, input)),
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = {
        error: {
          code: "unreadable_gateway_response",
          message: `The local Agent Gateway returned an unreadable response (${response.status}).`,
        },
      };
    }
    return { responseOk: response.ok, status: response.status, payload };
  } catch (error) {
    return {
      responseOk: false,
      status: 503,
      payload: {
        error: {
          code: "gateway_unavailable",
          message: error instanceof Error && error.name === "AbortError"
            ? "The local Agent Gateway timed out."
            : "The local Agent Gateway is unavailable. Start SemaFrame and enable agent control.",
        },
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

const handle = serveStdio(
  ({ era }) => createAgentMcpServer(
    { dispatch: (name, input) => callGateway(name, input) },
    { protocolEra: era },
  ),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void handle.close(); });
}
