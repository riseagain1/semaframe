import { createMcpHandler } from "@modelcontextprotocol/server";
import { WORKSPACE_AGENT_GUIDE } from "../../src/workspace/agents";
import { AgentGateway, AgentGatewayError } from "./AgentGateway";
import { AGENT_MCP_SERVER_INFO, createAgentMcpServer } from "./AgentMcpServer";

export type AgentMcpHttpOptions = Readonly<{
  allowedOrigins: readonly string[];
}>;

export type AgentMcpHttpHandler = Readonly<{
  matches(pathname: string): boolean;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}>;

function jsonResponse(status: number, payload: unknown, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

function statusFor(error: AgentGatewayError): number {
  if (error.code === "connection_offer_expired") return 410;
  if (error.code === "agent_mode_disabled" || error.code === "gateway_closed") return 503;
  if (error.code === "connection_invalid") return 404;
  return 409;
}

function corsHeaders(origin: string, allowedOrigins: readonly string[]): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": [
      "accept",
      "content-type",
      "last-event-id",
      "mcp-method",
      "mcp-name",
      "mcp-protocol-version",
    ].join(", "),
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function withHeaders(response: Response, extraHeaders: HeadersInit): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  new Headers(extraHeaders).forEach((value, name) => {
    if (name.toLowerCase() === "vary" && headers.has("vary")) {
      const values = new Set(`${headers.get("vary")},${value}`.split(",").map((part) => part.trim()).filter(Boolean));
      headers.set("vary", [...values].join(", "));
    } else {
      headers.set(name, value);
    }
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Serves one non-authorizing connection URL as both a human-readable document
 * and the exact Streamable HTTP MCP endpoint advertised by that document.
 */
export function createAgentMcpHttpHandler(
  gateway: AgentGateway,
  options: AgentMcpHttpOptions,
): AgentMcpHttpHandler {
  const allowedOrigins = [...options.allowedOrigins];
  const mcp = createMcpHandler(
    ({ era, requestInfo }) => {
      const pathname = requestInfo ? new URL(requestInfo.url).pathname : "";
      return createAgentMcpServer({
        dispatch: (name, input, client) => gateway.dispatchOffer(pathname, name, input, client),
      }, { protocolEra: era });
    },
    {
      legacy: "stateless",
      responseMode: "auto",
    },
  );

  return Object.freeze({
    matches: (pathname: string) => gateway.isConnectionPath(pathname),
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const origin = request.headers.get("origin") ?? "";
      const cors = corsHeaders(origin, allowedOrigins);

      if (origin && !allowedOrigins.includes(origin)) {
        return errorResponse(403, "origin_not_allowed", "This browser Origin is not allowed to access the SemaFrame MCP endpoint.");
      }
      if (request.method === "OPTIONS") {
        if (!origin) return errorResponse(403, "origin_required", "An allowed browser Origin is required for preflight requests.");
        return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...cors } });
      }
      if (url.search || url.hash) {
        return errorResponse(404, "connection_invalid", "Use the exact connection URL without query parameters or a fragment.");
      }

      try {
        const offer = gateway.connectionOffer(url.pathname);
        if (request.method === "GET" || request.method === "HEAD") {
          const document = {
            schemaVersion: 1,
            server: AGENT_MCP_SERVER_INFO,
            title: "SemaFrame universal workspace controller",
            description: "A deterministic 2D/3D component workspace controlled through explicit in-app approval. This URL locates the engine but grants no authority by itself.",
            mcpEndpoint: offer.connectionUrl,
            transport: "streamable-http",
            protocolVersions: ["2026-07-28", "2025-11-25"],
            offer: {
              status: offer.offerStatus,
              ...(offer.offerStatus === "approved"
                ? { activeUntilRevoked: true }
                : { claimBy: offer.offerExpiresAt }),
              urlIsAuthorization: false,
            },
            handshake: [
              "Connect to mcpEndpoint using MCP Streamable HTTP.",
              "Read the server instructions and workspace://instructions/v1 resource.",
              "Call get_workspace_instructions with a stable client_id, human-readable client_name, and the minimum requested_scopes.",
              "The first call creates a request in the open SemaFrame app and returns a private approval_token.",
              "Present approval_fingerprint to the user and ask them to compare it with the code shown in SemaFrame before approving.",
              "After the user approves, retry get_workspace_instructions with that approval_token.",
              "Use the returned session_token on every later tool call, and set each instruction_digest field to the exact returned guide_digest value.",
            ],
            security: {
              approval: "A user must approve the displayed client claim in the open SemaFrame app before the guide and session capability are released.",
              verification: "The agent should display approval_fingerprint and the user should compare it with SemaFrame before approving.",
              identity: "client_id and client_name are self-reported labels, not authenticated identity.",
              authority: "An approval token is valid only for the exact connection offer and scoped Workspace request that created it.",
              secrets: "Never place approval_token, session_token, or pairing bearer values in a URL, log, or shared transcript.",
            },
            instructions: WORKSPACE_AGENT_GUIDE,
          };
          const response = request.method === "HEAD"
            ? new Response(null, {
                status: 200,
                headers: {
                  "content-type": "application/json; charset=utf-8",
                  "cache-control": "no-store",
                  "x-content-type-options": "nosniff",
                  ...cors,
                },
              })
            : jsonResponse(200, document, cors);
          return response;
        }
        if (request.method !== "POST") {
          return errorResponse(405, "method_not_allowed", "Use GET to read the connection document or POST for MCP.");
        }
        return withHeaders(await mcp.fetch(request), cors);
      } catch (error) {
        if (error instanceof AgentGatewayError) {
          return errorResponse(statusFor(error), error.code, error.message);
        }
        return errorResponse(500, "gateway_error", "The SemaFrame MCP endpoint could not complete the request.");
      }
    },
    close: () => mcp.close(),
  });
}
