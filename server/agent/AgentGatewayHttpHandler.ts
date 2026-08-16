import type { AgentGateway, PairingReveal } from "./AgentGateway";
import { AgentGatewayError } from "./AgentGateway";
import type { AgentCommandName, BrowserCommandResult } from "./contracts";
import {
  FeedFetchError,
  FeedFetchRuntime,
  type FeedFormat,
} from "../feed/FeedFetchRuntime";
import {
  FeedFetchApprovalError,
  FeedFetchApprovalStore,
} from "../feed/FeedFetchApprovalStore";
import { createAgentMcpHttpHandler } from "./AgentMcpHttpHandler";
import { createAgentGatewayOpenApi } from "./openapi";

const DEFAULT_BODY_LIMIT_BYTES = 512 * 1024;

export type AgentGatewayHttpOptions = Readonly<{
  allowedOrigins: readonly string[];
  publicBaseUrl: string;
  bodyLimitBytes?: number;
  feedRuntime?: FeedFetchRuntime;
  feedApprovalStore?: FeedFetchApprovalStore;
}>;

export type NodeRequestLike = AsyncIterable<Uint8Array | string> & {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on?(event: "aborted", listener: () => void): void;
  off?(event: "aborted", listener: () => void): void;
};

export type NodeResponseLike = {
  statusCode: number;
  writableEnded?: boolean;
  destroyed?: boolean;
  setHeader(name: string, value: string): void;
  write?(body: string | Uint8Array): boolean;
  end(body?: string): void;
  on?(event: "close", listener: () => void): void;
  off?(event: "close", listener: () => void): void;
};

export type AgentGatewayFetchHandler = ((request: Request) => Promise<Response>) & {
  close(): Promise<void>;
};

export type AgentGatewayNodeHandler = ((request: NodeRequestLike, response: NodeResponseLike) => Promise<void>) & {
  close(): Promise<void>;
};

class BodyTooLargeError extends Error {}
class InvalidRequestError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (!isObject(value)) throw new InvalidRequestError("Request body must be a JSON object.");
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new InvalidRequestError("Request body contains unsupported fields.");
  }
  if (required.some((key) => !(key in value))) {
    throw new InvalidRequestError(`Request body requires ${required.join(", ") || "no fields"}.`);
  }
  return value;
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new InvalidRequestError(`${name} must contain ${minimum}-${maximum} characters.`);
  }
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new InvalidRequestError(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function parseAuthorization(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(value);
  return match?.[1];
}

function corsHeaders(origin: string, allowedOrigins: readonly string[]): Record<string, string> {
  if (!allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-ttv-agent-csrf",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  extraHeaders: HeadersInit = {},
): Response {
  return jsonResponse(status, {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }, extraHeaders);
}

function statusFor(error: AgentGatewayError): number {
  switch (error.code) {
    case "agent_mode_disabled":
    case "engine_unavailable":
    case "gateway_closed":
      return 503;
    case "engine_timeout":
      return 504;
    case "engine_busy":
    case "browser_replaced":
    case "browser_already_connected":
    case "connection_invalid":
    case "command_not_found":
    case "pairing_rotated":
      return 409;
    case "invalid_request":
      return 400;
    case "unsupported_media_type":
      return 415;
    default:
      if (/stale|revision|transaction_(?:expired|invalid)|confirmation_required/u.test(error.code)) return 409;
      if (/validation|schema|reference|reserved|unsupported|invalid/u.test(error.code)) return 422;
      return 422;
  }
}

async function readBoundedBody(request: Request, limit: number): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > limit) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readJson(request: Request, bodyLimitBytes: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AgentGatewayError("unsupported_media_type", "Use application/json.");
  }
  try {
    return JSON.parse(await readBoundedBody(request, bodyLimitBytes)) as unknown;
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    if (error instanceof AgentGatewayError) throw error;
    throw new InvalidRequestError("Request body must be valid JSON.");
  }
}

function emptyInput(value: unknown): Record<string, never> {
  exactObject(value, [], []);
  return {};
}

function externalCommand(pathname: string, method: string, value?: unknown): {
  name: AgentCommandName;
  input: unknown;
} | null {
  if (pathname === "/v1/workspace/instructions" && method === "POST") {
    const body = exactObject(value, ["client_id", "client_name", "requested_scopes"], []);
    const requestedScopes = body.requested_scopes;
    if (requestedScopes !== undefined && (!Array.isArray(requestedScopes) || requestedScopes.length > 20 || requestedScopes.some((scope) => typeof scope !== "string"))) {
      throw new InvalidRequestError("requested_scopes must be an array of at most 20 strings.");
    }
    return {
      name: "get_workspace_instructions",
      input: {
        ...(body.client_id === undefined ? {} : { client_id: boundedString(body.client_id, "client_id", 1, 128) }),
        ...(body.client_name === undefined ? {} : { client_name: boundedString(body.client_name, "client_name", 1, 160) }),
        ...(requestedScopes === undefined ? {} : { requested_scopes: requestedScopes }),
      },
    };
  }
  if (pathname === "/v1/workspace/inspect" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest"]);
    return {
      name: "inspect_workspace",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
      },
    };
  }
  if (pathname === "/v1/workspace/components/inspect" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "component_id"]);
    const componentId = boundedString(body.component_id, "component_id", 1, 256);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/u.test(componentId)) {
      throw new InvalidRequestError("component_id must be a valid Workspace identifier.");
    }
    return {
      name: "inspect_workspace_component",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        component_id: componentId,
      },
    };
  }
  if (pathname === "/v1/workspace/space/inspect" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "since_revision"], [
      "session_token", "instruction_digest",
    ]);
    return {
      name: "inspect_workspace_space",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        ...(body.since_revision === undefined ? {} : {
          since_revision: safeInteger(body.since_revision, "since_revision"),
        }),
      },
    };
  }
  if (pathname === "/v1/workspace/space/query" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "candidate"]);
    return {
      name: "query_spatial_placement",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        candidate: body.candidate,
      },
    };
  }
  if (pathname === "/v1/workspace/physics/inspect" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "component_ids"], [
      "session_token", "instruction_digest",
    ]);
    return {
      name: "inspect_workspace_physics",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        ...(body.component_ids === undefined ? {} : { component_ids: body.component_ids }),
      },
    };
  }
  if (pathname === "/v1/workspace/physics/placement/query" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "candidate"]);
    return {
      name: "query_stable_placement",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        candidate: body.candidate,
      },
    };
  }
  if (pathname === "/v1/workspace/physics/simulate" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "component_ids", "duration_ms", "time_step_ms"], [
      "session_token", "instruction_digest",
    ]);
    return {
      name: "simulate_workspace_physics",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        ...(body.component_ids === undefined ? {} : { component_ids: body.component_ids }),
        ...(body.duration_ms === undefined ? {} : { duration_ms: safeInteger(body.duration_ms, "duration_ms") }),
        ...(body.time_step_ms === undefined ? {} : { time_step_ms: safeInteger(body.time_step_ms, "time_step_ms") }),
      },
    };
  }
  if (pathname === "/v1/workspace/updates/begin" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "intent", "requested_component_ids"], [
      "session_token", "instruction_digest", "intent",
    ]);
    return {
      name: "begin_workspace_update",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        intent: boundedString(body.intent, "intent", 1, 4_000),
        ...(body.requested_component_ids === undefined
          ? {}
          : { requested_component_ids: safeInteger(body.requested_component_ids, "requested_component_ids") }),
      },
    };
  }
  if (pathname === "/v1/workspace/updates/submit" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "transaction_token", "batch"]);
    if (!isObject(body.batch)) throw new InvalidRequestError("batch must be a WorkspaceCommandBatch object.");
    return {
      name: "submit_workspace_batch",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        transaction_token: boundedString(body.transaction_token, "transaction_token", 8, 256),
        batch: body.batch,
      },
    };
  }
  if ((pathname === "/v1/workspace/undo" || pathname === "/v1/workspace/redo") && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "expected_workspace_revision"]);
    return {
      name: pathname.endsWith("undo") ? "undo_workspace_batch" : "redo_workspace_batch",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        expected_workspace_revision: safeInteger(body.expected_workspace_revision, "expected_workspace_revision"),
      },
    };
  }
  if (pathname === "/v1/workspace/events" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "after_cursor", "limit"], [
      "session_token", "instruction_digest",
    ]);
    return {
      name: "read_workspace_events",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        ...(body.after_cursor === undefined ? {} : { after_cursor: boundedString(body.after_cursor, "after_cursor", 1, 256) }),
        ...(body.limit === undefined ? {} : { limit: safeInteger(body.limit, "limit") }),
      },
    };
  }
  return null;
}

function parseBrowserResult(value: unknown): BrowserCommandResult {
  const body = exactObject(value, ["browserConnectionId", "commandId", "ok", "result", "error"], [
    "browserConnectionId", "commandId", "ok",
  ]);
  const browserConnectionId = boundedString(body.browserConnectionId, "browserConnectionId", 32, 128);
  const commandId = boundedString(body.commandId, "commandId", 8, 128);
  if (body.ok === true) {
    if (!("result" in body) || "error" in body) {
      throw new InvalidRequestError("A successful command result requires result and cannot include error.");
    }
    return { browserConnectionId, commandId, ok: true, result: body.result };
  }
  if (body.ok !== false || !("error" in body) || "result" in body) {
    throw new InvalidRequestError("A failed command result requires error and cannot include result.");
  }
  const error = exactObject(body.error, ["code", "message", "details"], ["code", "message"]);
  return {
    browserConnectionId,
    commandId,
    ok: false,
    error: {
      code: boundedString(error.code, "error.code", 1, 100),
      message: boundedString(error.message, "error.message", 1, 2_000),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function createAgentGatewayHttpHandler(
  gateway: AgentGateway,
  options: AgentGatewayHttpOptions,
): AgentGatewayFetchHandler {
  const allowedOrigins = [...options.allowedOrigins];
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes <= 0) {
    throw new RangeError("bodyLimitBytes must be a positive integer.");
  }
  const openApi = createAgentGatewayOpenApi(options.publicBaseUrl);
  const mcp = createAgentMcpHttpHandler(gateway, { allowedOrigins });
  const feedRuntime = options.feedRuntime ?? new FeedFetchRuntime();
  const feedApprovals = options.feedApprovalStore ?? new FeedFetchApprovalStore();

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const isBrowserRoute = pathname.startsWith("/api/agent/");
    const origin = request.headers.get("origin") ?? "";
    const cors = isBrowserRoute ? corsHeaders(origin, allowedOrigins) : {};

    if (pathname === "/health" || pathname === "/healthz") {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET.");
      return jsonResponse(200, { ok: true });
    }
    if (pathname === "/openapi.json") {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET.");
      return jsonResponse(200, openApi);
    }
    if (mcp.matches(pathname)) return mcp.fetch(request);

    if (isBrowserRoute) {
      if (origin && !allowedOrigins.includes(origin)) {
        return errorResponse(403, "origin_not_allowed", "An allowed Scene Thread browser origin is required.");
      }
      if (request.method === "OPTIONS") {
        if (!origin) return errorResponse(403, "origin_required", "An allowed Scene Thread browser origin is required.");
        return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...cors } });
      }
      if (pathname === "/api/agent/config") {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET.");
        return jsonResponse(200, gateway.getConfig(), cors);
      }
      if (!origin) {
        return errorResponse(403, "origin_required", "An allowed Scene Thread browser origin is required.");
      }
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST.");
      if (request.headers.get("x-ttv-agent-csrf") !== gateway.csrfToken) {
        return errorResponse(403, "csrf_invalid", "The agent-control browser session expired. Refresh and try again.");
      }

      try {
        const value = await readJson(request, bodyLimitBytes);
        let result: unknown;
        if (pathname === "/api/agent/browser/reveal") {
          emptyInput(value);
          result = gateway.revealPairing();
        } else if (pathname === "/api/agent/browser/rotate") {
          emptyInput(value);
          result = gateway.rotatePairing();
        } else if (pathname === "/api/agent/browser/enable") {
          emptyInput(value);
          result = gateway.setEnabled(true);
        } else if (pathname === "/api/agent/browser/disable") {
          emptyInput(value);
          result = gateway.setEnabled(false);
        } else if (pathname === "/api/agent/browser/offer/refresh") {
          emptyInput(value);
          result = gateway.refreshOffer();
        } else if (pathname === "/api/agent/browser/approval/approve") {
          const body = exactObject(value, ["claimId"]);
          result = gateway.approveClaim(boundedString(body.claimId, "claimId", 36, 128));
        } else if (pathname === "/api/agent/browser/approval/deny") {
          const body = exactObject(value, ["claimId"]);
          result = gateway.denyClaim(boundedString(body.claimId, "claimId", 36, 128));
        } else if (pathname === "/api/agent/browser/register") {
          const body = exactObject(value, ["clientInstanceId"]);
          result = gateway.registerBrowser(boundedString(body.clientInstanceId, "clientInstanceId", 8, 128));
        } else if (pathname === "/api/agent/browser/takeover") {
          const body = exactObject(value, ["clientInstanceId"]);
          result = gateway.takeoverBrowser(boundedString(body.clientInstanceId, "clientInstanceId", 8, 128));
        } else if (pathname === "/api/agent/browser/unregister") {
          const body = exactObject(value, ["browserConnectionId"]);
          result = gateway.unregisterBrowser(
            boundedString(body.browserConnectionId, "browserConnectionId", 32, 128),
          );
        } else if (pathname === "/api/agent/browser/poll") {
          const body = exactObject(value, ["browserConnectionId"]);
          result = await gateway.pollBrowser(
            boundedString(body.browserConnectionId, "browserConnectionId", 32, 128),
            request.signal,
          );
        } else if (pathname === "/api/agent/browser/result") {
          result = gateway.submitBrowserResult(parseBrowserResult(value));
        } else if (pathname === "/api/agent/feeds/approval/mint") {
          const body = exactObject(value, ["url", "format"], ["url"]);
          const format = body.format === undefined
            ? undefined
            : boundedString(body.format, "format", 3, 4);
          if (format !== undefined && !["auto", "json", "csv", "rss"].includes(format)) {
            throw new InvalidRequestError("format must be auto, json, csv, or rss.");
          }
          result = feedApprovals.mint({
            url: boundedString(body.url, "url", 1, 8_192),
            ...(format === undefined ? {} : { format: format as FeedFormat }),
          });
        } else if (pathname === "/api/agent/feeds/fetch") {
          const body = exactObject(value, ["url", "format", "approvalToken"], ["url"]);
          const format = body.format === undefined
            ? undefined
            : boundedString(body.format, "format", 3, 4);
          if (format !== undefined && !["auto", "json", "csv", "rss"].includes(format)) {
            throw new InvalidRequestError("format must be auto, json, csv, or rss.");
          }
          const feedRequest = {
            url: boundedString(body.url, "url", 1, 8_192),
            ...(format === undefined ? {} : { format: format as FeedFormat }),
          };
          feedApprovals.consume(body.approvalToken, feedRequest);
          result = await feedRuntime.fetch(feedRequest, request.signal);
        } else {
          return errorResponse(404, "not_found", "Not found.");
        }
        return jsonResponse(200, result, cors);
      } catch (error) {
        if (error instanceof BodyTooLargeError) return errorResponse(413, "body_too_large", "Request body is too large.", undefined, cors);
        if (error instanceof InvalidRequestError) return errorResponse(400, "invalid_request", error.message, undefined, cors);
        if (error instanceof FeedFetchApprovalError) return errorResponse(error.status, error.code, error.message, undefined, cors);
        if (error instanceof FeedFetchError) return errorResponse(error.status, error.code, error.message, error.details, cors);
        if (error instanceof AgentGatewayError) return errorResponse(statusFor(error), error.code, error.message, error.details, cors);
        return errorResponse(500, "gateway_error", "The local agent gateway could not complete the browser request.", undefined, cors);
      }
    }

    if (!pathname.startsWith("/v1/")) return errorResponse(404, "not_found", "Not found.");
    if (!gateway.bearerMatches(parseAuthorization(request))) {
      return jsonResponse(401, {
        error: { code: "unauthorized", message: "A valid agent-control pairing bearer is required." },
      }, { "www-authenticate": "Bearer" });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Use the documented method.");
    }

    try {
      let value: unknown;
      if (request.method === "POST") value = await readJson(request, bodyLimitBytes);
      const command = externalCommand(pathname, request.method, value);
      if (!command) return errorResponse(404, "not_found", "Not found.");
      const instructionClientName = command.name === "get_workspace_instructions" && isObject(command.input)
        ? command.input.client_name
        : undefined;
      const result = await gateway.dispatch(command.name, command.input, {
        clientName: request.headers.get("x-ttv-agent-name") ??
          (typeof instructionClientName === "string" ? instructionClientName : undefined),
      });
      return jsonResponse(200, result);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return errorResponse(413, "body_too_large", "Request body is too large.");
      if (error instanceof InvalidRequestError) return errorResponse(400, "invalid_request", error.message);
      if (error instanceof AgentGatewayError) return errorResponse(statusFor(error), error.code, error.message, error.details);
      return errorResponse(500, "gateway_error", "The local agent gateway could not complete the request.");
    }
  };
  return Object.assign(handle, {
    close: async () => {
      feedApprovals.clear();
      await mcp.close();
    },
  });
}

function nodeHeaders(headers: NodeRequestLike["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((entry) => result.append(name, entry));
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}

export function createNodeAgentGatewayHttpHandler(
  gateway: AgentGateway,
  options: AgentGatewayHttpOptions,
): AgentGatewayNodeHandler {
  const fetchHandler = createAgentGatewayHttpHandler(gateway, options);
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const handle = async (request: NodeRequestLike, response: NodeResponseLike): Promise<void> => {
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    const abortClosedResponse = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.on?.("aborted", abortRequest);
    response.on?.("close", abortClosedResponse);
    try {
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      for await (const chunk of request) {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        byteLength += bytes.byteLength;
        if (byteLength > bodyLimitBytes) {
          response.statusCode = 413;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(JSON.stringify({ error: { code: "body_too_large", message: "Request body is too large." } }));
          return;
        }
        chunks.push(bytes);
      }
      if (controller.signal.aborted) return;
      const body = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const method = request.method ?? "GET";
      const fetchRequest = new Request(new URL(request.url ?? "/", `${options.publicBaseUrl}/`), {
        method,
        headers: nodeHeaders(request.headers),
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
        signal: controller.signal,
      });
      const result = await fetchHandler(fetchRequest);
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      if (!result.body) {
        response.end();
      } else if (response.write) {
        const reader = result.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done || response.destroyed || response.writableEnded) break;
          response.write(value);
        }
        if (!response.destroyed && !response.writableEnded) response.end();
      } else {
        response.end(await result.text());
      }
    } catch {
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ error: { code: "gateway_error", message: "The local agent gateway encountered an error." } }));
    } finally {
      request.off?.("aborted", abortRequest);
      response.off?.("close", abortClosedResponse);
    }
  };
  return Object.assign(handle, { close: () => fetchHandler.close() });
}

export type { PairingReveal };
