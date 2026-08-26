import { createHash, timingSafeEqual } from "node:crypto";
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
import {
  AGENT_ASSET_IMPORT_SCOPE,
  AgentAssetIngress,
  AgentAssetIngressError,
  toAgentAssetImportGrantWire,
  type AgentAssetCandidateDescriptor,
  type AgentAssetFormat,
} from "./AgentAssetIngress";
import {
  PhotoReconstructionService,
  PhotoReconstructionServiceError,
} from "../reconstruction/PhotoReconstructionService";
import { createReconstructionBackendFactory } from "../reconstruction/ReconstructionBackendFactory";
import {
  XR_HTTP_PATHS,
  XrAssetRelayCache,
  XrRelay,
  createXrHttpHandler,
  type WindowsUltraEvidenceProvider,
} from "../xr";
import { XR_PROTOCOL_LIMITS } from "../../src/xr/protocol";
import {
  VoiceRelayHostActionStore,
  VoiceRelayService,
  createVoiceRelayHttpHandler,
  type VoiceRelayDesktopHostAction,
} from "../voice-relay";
import { VOICE_RELAY_HOST_ACTION_HEADER, VOICE_RELAY_HTTP_PATHS } from "../../src/voice-relay";
import { WORKSPACE_PERMISSION_SCOPE_REQUEST_LIMIT } from "../../src/workspace/agents/contracts";
import { XR_HTTP_SESSION_HEADER } from "../xr/http/XrHttpAdapter";

const DEFAULT_BODY_LIMIT_BYTES = 512 * 1024;
const AGENT_PHOTO_RECONSTRUCTION_SCOPE = "asset:reconstruct" as const;
export const AGENT_BROWSER_BOOTSTRAP_HEADER = "x-semaframe-browser-bootstrap" as const;

export type AgentGatewayHttpOptions = Readonly<{
  allowedOrigins: readonly string[];
  publicBaseUrl: string;
  bodyLimitBytes?: number;
  /** Required process-private capability injected by the trusted local UI proxy. */
  browserBootstrapToken: string;
  feedRuntime?: FeedFetchRuntime;
  feedApprovalStore?: FeedFetchApprovalStore;
  assetIngress?: AgentAssetIngress;
  photoReconstruction?: PhotoReconstructionService;
  /** Shared in-memory relay; injectable for tests and an embedding host. */
  xrRelay?: XrRelay;
  /** Shared bounded cache for immutable XR mesh/splat payloads. */
  xrAssetCache?: XrAssetRelayCache;
  /** Exact origins hosting the renderer-only XR client. */
  xrRendererOrigins?: readonly string[];
  /** Explicitly configured Windows-native Ultra telemetry provider. */
  xrUltraEvidence?: WindowsUltraEvidenceProvider;
  /** Optional native-backed Voice Relay. Omit for an authenticated disabled/off fallback. */
  voiceRelayService?: VoiceRelayService;
  /** Injectable volatile one-shot grant store. */
  voiceRelayHostActions?: VoiceRelayHostActionStore;
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
  on?(event: "close" | "drain", listener: () => void): void;
  off?(event: "close" | "drain", listener: () => void): void;
};

export type AgentGatewayFetchHandler = ((request: Request) => Promise<Response>) & {
  close(): Promise<void>;
};

export type AgentGatewayNodeHandler = ((request: NodeRequestLike, response: NodeResponseLike) => Promise<void>) & {
  close(): Promise<void>;
};

class BodyTooLargeError extends Error {}
class InvalidRequestError extends Error {}

function browserBootstrapMatches(received: string | null, expected: string): boolean {
  if (!received) return false;
  const actualDigest = createHash("sha256").update(received, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function requireBrowserBootstrapToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("browserBootstrapToken is required and must be a 256-bit base64url capability.");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSuccessfulWorkspaceResult(value: unknown): value is { ok: true; data: unknown } {
  return isObject(value) && value.ok === true && Object.hasOwn(value, "data");
}

function sessionBoundAssetImporter(
  validation: { ok: true; data: unknown },
  sessionToken: string,
): Readonly<{ authorizationId: string; clientId?: string; clientName?: string; scopes: readonly string[] }> {
  if (!isObject(validation.data) || typeof validation.data.client_id !== "string") {
    throw new AgentGatewayError(
      "invalid_response",
      "The browser returned an invalid asset-import session validation.",
    );
  }
  const clientId = boundedString(validation.data.client_id, "client_id", 1, 128);
  const clientName = validation.data.client_name === undefined
    ? undefined
    : boundedString(validation.data.client_name, "client_name", 1, 160);
  return Object.freeze({
    authorizationId: `session:${createHash("sha256").update(sessionToken).digest("hex")}`,
    clientId,
    ...(clientName ? { clientName } : {}),
    scopes: Object.freeze([AGENT_ASSET_IMPORT_SCOPE]),
  });
}

/**
 * REST photo jobs can outlive the browser controller's short-lived command
 * session. Bind them to the validated client identity instead of the session
 * token so the same paired client can renew instructions and resume a bounded
 * local job. Pairing/offer rotation revokes every reconstruction job.
 */
function validatedPhotoReconstructionPrincipal(
  validation: { ok: true; data: unknown },
  approved: Readonly<{ authorizationId: string; clientId?: string; clientName?: string }>,
): Readonly<{ authorizationId: string; clientId: string; clientName?: string }> {
  if (!isObject(validation.data) || typeof validation.data.client_id !== "string") {
    throw new AgentGatewayError(
      "invalid_response",
      "The browser returned an invalid photo-reconstruction session validation.",
    );
  }
  const clientId = boundedString(validation.data.client_id, "client_id", 1, 128);
  const clientName = validation.data.client_name === undefined
    ? undefined
    : boundedString(validation.data.client_name, "client_name", 1, 160);
  if (!approved.clientId || approved.clientId !== clientId) {
    throw new AgentGatewayError(
      "approval_invalid",
      "The REST Agent identity does not match the approved photo-reconstruction claim.",
    );
  }
  return Object.freeze({
    authorizationId: approved.authorizationId,
    clientId,
    ...(clientName ? { clientName } : {}),
  });
}

function browserPhotoReconstructionPrincipal(gateway: AgentGateway): Readonly<{
  authorizationId: string;
  clientId: string;
  clientName: string;
}> {
  const gatewayInstanceId = gateway.getConfig().gatewayInstanceId;
  return Object.freeze({
    authorizationId: `browser:${createHash("sha256").update(gatewayInstanceId).digest("hex")}`,
    clientId: "semaframe-browser",
    clientName: "SemaFrame human",
  });
}

function approvedRestPhotoReconstructionPrincipal(
  gateway: AgentGateway,
  body: Record<string, unknown>,
) {
  return gateway.requireApprovedClientScope(AGENT_PHOTO_RECONSTRUCTION_SCOPE, {
    approvalToken: boundedString(body.approval_token, "approval_token", 16, 256),
  });
}

function withoutApprovalProof(body: Record<string, unknown>): Record<string, unknown> {
  const result = { ...body };
  delete result.approval_token;
  return result;
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

function voiceRelayDesktopHostAction(value: unknown): VoiceRelayDesktopHostAction {
  if (value !== "voice_relay_accessibility"
    && value !== "voice_relay_configure_target"
    && value !== "voice_relay_arm"
    && value !== "voice_relay_draft_round_trip") {
    throw new InvalidRequestError(
      "action must be voice_relay_accessibility, voice_relay_configure_target, voice_relay_arm, or voice_relay_draft_round_trip.",
    );
  }
  return value;
}

function xrSessionCredential(request: Request): Readonly<{ sessionId: string; sessionBearer: string }> | undefined {
  const sessionId = request.headers.get(XR_HTTP_SESSION_HEADER);
  const authorization = request.headers.get("authorization");
  const bearer = authorization ? /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization)?.[1] : undefined;
  return sessionId && bearer ? Object.freeze({ sessionId, sessionBearer: bearer }) : undefined;
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
    "access-control-allow-headers": "content-type, x-semaframe-agent-csrf",
    "access-control-expose-headers": "content-length, x-semaframe-asset-digest, x-semaframe-asset-media-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function xrVoiceRelayCorsHeaders(origin: string, allowedOrigins: readonly string[]): Record<string, string> {
  if (!allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": `authorization, content-type, ${XR_HTTP_SESSION_HEADER}`,
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function withResponseHeaders(response: Response, extraHeaders: HeadersInit): Response {
  const headers = new Headers(response.headers);
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function contentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function assetErrorResponse(error: AgentAssetIngressError, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  if (error.status === 401) responseHeaders.set("www-authenticate", "Bearer");
  return errorResponse(error.status, error.code, error.message, undefined, responseHeaders);
}

function photoReconstructionErrorResponse(
  error: PhotoReconstructionServiceError,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  if (error.status === 401) responseHeaders.set("www-authenticate", "Bearer");
  return errorResponse(error.status, error.code, error.message, undefined, responseHeaders);
}

function readableBody(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> | undefined {
  if (!body) return undefined;
  return {
    async *[Symbol.asyncIterator]() {
      const reader = body.getReader();
      let finished = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            finished = true;
            return;
          }
          yield value;
        }
      } finally {
        if (!finished) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}

function binaryAssetResponse(
  candidate: AgentAssetCandidateDescriptor,
  body: ReadableStream<Uint8Array>,
  extraHeaders: HeadersInit,
  release: () => void,
): Response {
  const reader = body.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
    release();
  };
  const releasableBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          releaseOnce();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        releaseOnce();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseOnce();
      }
    },
  });
  return new Response(releasableBody, {
    status: 200,
    headers: {
      "content-type": candidate.mediaType,
      "content-length": String(candidate.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": "attachment",
      "x-semaframe-asset-digest": candidate.sha256,
      "x-semaframe-asset-media-type": candidate.mediaType,
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
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
    case "instructions_required":
    case "authorization_scope_missing":
    case "approval_invalid":
      return 403;
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
    if (requestedScopes !== undefined && (!Array.isArray(requestedScopes)
      || requestedScopes.length > WORKSPACE_PERMISSION_SCOPE_REQUEST_LIMIT
      || requestedScopes.some((scope) => typeof scope !== "string"))) {
      throw new InvalidRequestError(
        `requested_scopes must be an array of at most ${WORKSPACE_PERMISSION_SCOPE_REQUEST_LIMIT} strings.`,
      );
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
  if (pathname === "/v1/workspace/resources/snapshot/read" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "resource_id"]);
    const resourceId = boundedString(body.resource_id, "resource_id", 1, 256);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/u.test(resourceId)) {
      throw new InvalidRequestError("resource_id must be a valid Workspace identifier.");
    }
    return {
      name: "read_workspace_resource_snapshot",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        resource_id: resourceId,
      },
    };
  }
  if (pathname === "/v1/workspace/assets/inspect" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "asset_id"]);
    const assetId = boundedString(body.asset_id, "asset_id", 67, 67);
    if (!/^ra_[a-f0-9]{64}$/u.test(assetId)) {
      throw new InvalidRequestError("asset_id must be an exact content-addressed Reality Asset identifier.");
    }
    return {
      name: "inspect_workspace_asset",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        asset_id: assetId,
      },
    };
  }
  if (pathname === "/v1/workspace/models/inspect" && method === "POST") {
    const body = exactObject(value, ["session_token", "instruction_digest", "model_id", "version"]);
    const modelId = boundedString(body.model_id, "model_id", 1, 128);
    const version = boundedString(body.version, "version", 5, 64);
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(modelId)
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(version)) {
      throw new InvalidRequestError("model_id and version must identify an exact published model.");
    }
    return {
      name: "inspect_workspace_model",
      input: {
        session_token: boundedString(body.session_token, "session_token", 8, 256),
        instruction_digest: boundedString(body.instruction_digest, "instruction_digest", 8, 256),
        model_id: modelId,
        version,
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
  const browserBootstrapToken = requireBrowserBootstrapToken(options.browserBootstrapToken);
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes <= 0) {
    throw new RangeError("bodyLimitBytes must be a positive integer.");
  }
  const openApi = createAgentGatewayOpenApi(options.publicBaseUrl);
  const feedRuntime = options.feedRuntime ?? new FeedFetchRuntime();
  const feedApprovals = options.feedApprovalStore ?? new FeedFetchApprovalStore();
  const assetIngress = options.assetIngress ?? new AgentAssetIngress({
    publicBaseUrl: options.publicBaseUrl,
  });
  const photoReconstruction = options.photoReconstruction ?? new PhotoReconstructionService({
    publicBaseUrl: options.publicBaseUrl,
    assetIngress,
    backend: createReconstructionBackendFactory().backend,
  });
  const mcp = createAgentMcpHttpHandler(gateway, {
    allowedOrigins,
    assetIngress,
    photoReconstruction,
  });
  const xrRelay = options.xrRelay ?? new XrRelay();
  const removeVoiceRelayOwner = options.voiceRelayService
    ? xrRelay.onRendererSessionRemoved(async ({ session }) => {
      await options.voiceRelayService!.cancelOwner(session.sessionId);
    })
    : () => undefined;
  const xr = createXrHttpHandler(xrRelay, {
    trustedLocalAuthority: (request) => browserBootstrapMatches(
      request.headers.get(AGENT_BROWSER_BOOTSTRAP_HEADER),
      browserBootstrapToken,
    ),
    rendererOrigins: options.xrRendererOrigins ?? allowedOrigins,
    assetCache: options.xrAssetCache,
    ultraEvidence: options.xrUltraEvidence,
  });
  const voiceRelayHostActions = options.voiceRelayHostActions ?? new VoiceRelayHostActionStore();
  const xrRendererOrigins = options.xrRendererOrigins ?? allowedOrigins;
  const voiceRelay = createVoiceRelayHttpHandler({
    ...(options.voiceRelayService ? { service: options.voiceRelayService } : {}),
    authorize: async (request, surface) => {
      const origin = request.headers.get("origin") ?? "";
      if (surface === "desktop") {
        return browserBootstrapMatches(
          request.headers.get(AGENT_BROWSER_BOOTSTRAP_HEADER),
          browserBootstrapToken,
        ) && allowedOrigins.includes(origin)
          && request.headers.get("x-semaframe-agent-csrf") === gateway.csrfToken;
      }
      if (!xrRendererOrigins.includes(origin)) return false;
      const credential = xrSessionCredential(request);
      if (!credential) return false;
      try {
        const session = xrRelay.authorizeVoiceRelaySession(credential);
        return Object.freeze({ ownerId: session.sessionId });
      } catch {
        // Authorization may be the operation that discovers an expired XR
        // renderer. Its exact native draft cleanup must settle before this
        // terminal request is rejected.
        await xrRelay.drainRendererRemovals();
        return false;
      }
    },
    consumeDesktopHostAction: (request, action) => voiceRelayHostActions.consume(
      request.headers.get(VOICE_RELAY_HOST_ACTION_HEADER),
      action,
    ),
  });

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const isBrowserRoute = pathname.startsWith("/api/agent/");
    const isXrRoute = pathname.startsWith("/api/xr/v1/");
    const origin = request.headers.get("origin") ?? "";
    const cors = isBrowserRoute ? corsHeaders(origin, allowedOrigins) : {};

    if (isBrowserRoute && !browserBootstrapMatches(
      request.headers.get(AGENT_BROWSER_BOOTSTRAP_HEADER),
      browserBootstrapToken,
    )) {
      await request.body?.cancel().catch(() => undefined);
      return errorResponse(403, "browser_bootstrap_invalid", "The trusted local browser proxy capability is required.");
    }

    if (isXrRoute) return xr(request);
    if (voiceRelay.matches(pathname)) {
      const xrSurface = pathname === VOICE_RELAY_HTTP_PATHS.xrBase
        || pathname.startsWith(`${VOICE_RELAY_HTTP_PATHS.xrBase}/`);
      const relayCors = xrSurface ? xrVoiceRelayCorsHeaders(origin, xrRendererOrigins) : {};
      if (request.method === "OPTIONS") {
        await request.body?.cancel().catch(() => undefined);
        if (!xrSurface || !xrRendererOrigins.includes(origin)) {
          return errorResponse(403, "voice_relay_unauthorized", "Voice Relay authorization failed.", undefined, relayCors);
        }
        if (request.headers.get("access-control-request-method") !== "POST") {
          return errorResponse(405, "method_not_allowed", "Use POST.", undefined, relayCors);
        }
        return new Response(null, { status: 204, headers: relayCors });
      }
      const response = await voiceRelay.fetch(request);
      return xrSurface ? withResponseHeaders(response, relayCors) : response;
    }

    if (pathname === "/health" || pathname === "/healthz") {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET.");
      return jsonResponse(200, { ok: true });
    }
    if (pathname === "/openapi.json") {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET.");
      return jsonResponse(200, openApi);
    }
    if (mcp.matches(pathname)) return mcp.fetch(request);

    const browserPhotoUpload = /^\/api\/agent\/reconstructions\/photo-uploads\/[0-9a-f-]{36}$/iu.test(pathname);

    // Photo bytes use per-file one-time grants and never enter JSON, project
    // state, or browser history. The /api alias exists only so the local Vite
    // origin can stream a grant without widening CORS on public /v1 routes.
    if (photoReconstruction.matchesUploadPath(pathname) || browserPhotoUpload) {
      if (url.search || url.hash) {
        await request.body?.cancel().catch(() => undefined);
        return errorResponse(404, "photo_upload_not_found", "Use the exact upload URL without query parameters or a fragment.");
      }
      if (browserPhotoUpload && origin && !allowedOrigins.includes(origin)) {
        await request.body?.cancel().catch(() => undefined);
        return errorResponse(403, "origin_not_allowed", "An allowed SemaFrame browser origin is required.");
      }
      if (request.method !== "PUT") {
        await request.body?.cancel().catch(() => undefined);
        return errorResponse(405, "method_not_allowed", "Use PUT.");
      }
      try {
        const result = await photoReconstruction.upload(
          pathname,
          parseAuthorization(request),
          request.headers.get("content-type") ?? undefined,
          contentLength(request),
          readableBody(request.body),
          request.signal,
        );
        return jsonResponse(200, result);
      } catch (error) {
        await request.body?.cancel().catch(() => undefined);
        if (error instanceof PhotoReconstructionServiceError) {
          return photoReconstructionErrorResponse(error);
        }
        return errorResponse(500, "photo_reconstruction_error", "The local gateway could not receive the photo.");
      }
    }

    // Asset bytes use a dedicated, capability-bound streaming route. It must
    // run before normal /v1 bearer handling: the upload token is intentionally
    // distinct from the broad pairing bearer and cannot authorize any command.
    if (assetIngress.matchesUploadPath(pathname)) {
      if (url.search || url.hash) {
        await request.body?.cancel().catch(() => undefined);
        return errorResponse(404, "asset_upload_not_found", "Use the exact upload URL without query parameters or a fragment.");
      }
      if (request.method !== "PUT") {
        await request.body?.cancel().catch(() => undefined);
        return errorResponse(405, "method_not_allowed", "Use PUT.");
      }
      const grantId = pathname.slice(pathname.lastIndexOf("/") + 1);
      try {
        const descriptor = await assetIngress.upload(
          grantId,
          parseAuthorization(request),
          request.headers.get("content-type") ?? undefined,
          contentLength(request),
          readableBody(request.body),
          request.signal,
        );
        return jsonResponse(200, toAgentAssetImportGrantWire(descriptor));
      } catch (error) {
        await request.body?.cancel().catch(() => undefined);
        if (error instanceof AgentAssetIngressError) return assetErrorResponse(error);
        return errorResponse(500, "asset_ingress_error", "The local gateway could not receive the asset.");
      }
    }

    if (isBrowserRoute) {
      if (origin && !allowedOrigins.includes(origin)) {
        return errorResponse(403, "origin_not_allowed", "An allowed SemaFrame browser origin is required.");
      }
      if (request.method === "OPTIONS") {
        if (!origin) return errorResponse(403, "origin_required", "An allowed SemaFrame browser origin is required.");
        return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...cors } });
      }
      if (pathname === "/api/agent/config") {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET.");
        return jsonResponse(200, gateway.getConfig(), cors);
      }
      if (!origin) {
        return errorResponse(403, "origin_required", "An allowed SemaFrame browser origin is required.");
      }
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST.");
      if (request.headers.get("x-semaframe-agent-csrf") !== gateway.csrfToken) {
        return errorResponse(403, "csrf_invalid", "The agent-control browser session expired. Refresh and try again.");
      }

      try {
        const value = await readJson(request, bodyLimitBytes);
        let result: unknown;
        if (pathname === "/api/agent/host-actions/voice-relay/mint") {
          const body = exactObject(value, ["action"]);
          result = voiceRelayHostActions.mint(voiceRelayDesktopHostAction(body.action));
        } else if (pathname === "/api/agent/reconstructions/capability") {
          emptyInput(value);
          result = await photoReconstruction.capability();
        } else if (pathname === "/api/agent/browser/reveal") {
          emptyInput(value);
          result = gateway.revealPairing();
        } else if (pathname === "/api/agent/browser/rotate") {
          emptyInput(value);
          result = gateway.rotatePairing();
          const retainedBrowserAuthorizationId = browserPhotoReconstructionPrincipal(gateway).authorizationId;
          await Promise.all([
            assetIngress.revokeAllExceptAuthorization(retainedBrowserAuthorizationId),
            photoReconstruction.revokeAllExceptAuthorization(retainedBrowserAuthorizationId),
          ]);
        } else if (pathname === "/api/agent/browser/enable") {
          emptyInput(value);
          result = gateway.setEnabled(true);
        } else if (pathname === "/api/agent/browser/disable") {
          emptyInput(value);
          result = gateway.setEnabled(false);
          const retainedBrowserAuthorizationId = browserPhotoReconstructionPrincipal(gateway).authorizationId;
          await Promise.all([
            assetIngress.revokeAllExceptAuthorization(retainedBrowserAuthorizationId),
            photoReconstruction.revokeAllExceptAuthorization(retainedBrowserAuthorizationId),
          ]);
        } else if (pathname === "/api/agent/browser/offer/refresh") {
          emptyInput(value);
          result = gateway.refreshOffer();
          const retainedBrowserAuthorizationId = browserPhotoReconstructionPrincipal(gateway).authorizationId;
          await Promise.all([
            assetIngress.revokeAllExceptAuthorization(retainedBrowserAuthorizationId),
            photoReconstruction.revokeAllExceptAuthorization(retainedBrowserAuthorizationId),
          ]);
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
        } else if (pathname === "/api/agent/reconstructions/begin") {
          const body = exactObject(value, ["requestId", "workspaceId", "profile", "photos"]);
          result = await photoReconstruction.begin(
            browserPhotoReconstructionPrincipal(gateway),
            body,
          );
        } else if (pathname === "/api/agent/reconstructions/start") {
          const body = exactObject(value, ["jobId", "workspaceId"]);
          result = await photoReconstruction.start(
            boundedString(body.jobId, "jobId", 36, 36),
            browserPhotoReconstructionPrincipal(gateway).authorizationId,
            boundedString(body.workspaceId, "workspaceId", 1, 256),
          );
        } else if (pathname === "/api/agent/reconstructions/inspect") {
          const body = exactObject(value, ["jobId", "workspaceId"]);
          result = await photoReconstruction.inspect(
            boundedString(body.jobId, "jobId", 36, 36),
            browserPhotoReconstructionPrincipal(gateway).authorizationId,
            boundedString(body.workspaceId, "workspaceId", 1, 256),
          );
        } else if (pathname === "/api/agent/reconstructions/cancel") {
          const body = exactObject(value, ["jobId", "workspaceId", "confirm"]);
          if (body.confirm !== true) throw new InvalidRequestError("confirm must be true.");
          // Ownership is authorization-bound; workspaceId is still required so
          // stale UI state cannot silently target a different open project.
          await photoReconstruction.inspect(
            boundedString(body.jobId, "jobId", 36, 36),
            browserPhotoReconstructionPrincipal(gateway).authorizationId,
            boundedString(body.workspaceId, "workspaceId", 1, 256),
          );
          result = await photoReconstruction.cancel(
            boundedString(body.jobId, "jobId", 36, 36),
            browserPhotoReconstructionPrincipal(gateway).authorizationId,
            boundedString(body.workspaceId, "workspaceId", 1, 256),
          );
        } else if (pathname === "/api/agent/reconstructions/finalize") {
          const body = exactObject(value, ["jobId", "workspaceId", "displayName", "expectedOutputSha256"]);
          result = await photoReconstruction.finalize(
            boundedString(body.jobId, "jobId", 36, 36),
            browserPhotoReconstructionPrincipal(gateway),
            boundedString(body.workspaceId, "workspaceId", 1, 256),
            {
              displayName: boundedString(body.displayName, "displayName", 1, 255),
              expectedOutputSha256: boundedString(body.expectedOutputSha256, "expectedOutputSha256", 71, 71),
            },
          );
        } else if (pathname === "/api/agent/assets/candidates/inspect") {
          const body = exactObject(value, ["candidateHandle", "workspaceId"]);
          result = await assetIngress.inspect(
            boundedString(body.candidateHandle, "candidateHandle", 43, 43),
            boundedString(body.workspaceId, "workspaceId", 1, 256),
          );
        } else if (pathname === "/api/agent/assets/candidates/open") {
          const body = exactObject(value, ["candidateHandle", "workspaceId"]);
          const opened = await assetIngress.open(
            boundedString(body.candidateHandle, "candidateHandle", 43, 43),
            boundedString(body.workspaceId, "workspaceId", 1, 256),
          );
          return binaryAssetResponse(opened.descriptor, opened.body, cors, opened.release);
        } else if (pathname === "/api/agent/assets/candidates/complete") {
          const body = exactObject(value, ["candidateHandle", "workspaceId"]);
          result = await assetIngress.complete(
            boundedString(body.candidateHandle, "candidateHandle", 43, 43),
            boundedString(body.workspaceId, "workspaceId", 1, 256),
          );
        } else if (pathname === "/api/agent/assets/candidates/cancel") {
          const body = exactObject(value, ["candidateHandle", "workspaceId"]);
          result = await assetIngress.cancelFromBrowser(
            boundedString(body.candidateHandle, "candidateHandle", 43, 43),
            boundedString(body.workspaceId, "workspaceId", 1, 256),
          );
        } else {
          return errorResponse(404, "not_found", "Not found.");
        }
        return jsonResponse(200, result, cors);
      } catch (error) {
        if (error instanceof BodyTooLargeError) return errorResponse(413, "body_too_large", "Request body is too large.", undefined, cors);
        if (error instanceof InvalidRequestError) return errorResponse(400, "invalid_request", error.message, undefined, cors);
        if (error instanceof FeedFetchApprovalError) return errorResponse(error.status, error.code, error.message, undefined, cors);
        if (error instanceof FeedFetchError) return errorResponse(error.status, error.code, error.message, error.details, cors);
        if (error instanceof PhotoReconstructionServiceError) return photoReconstructionErrorResponse(error, cors);
        if (error instanceof AgentAssetIngressError) return assetErrorResponse(error, cors);
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
      if (pathname === "/v1/assets/imports/begin" && request.method === "POST") {
        const body = exactObject(value, [
          "session_token",
          "instruction_digest",
          "request_id",
          "workspace_id",
          "display_name",
          "format",
          "media_type",
          "byte_length",
          "sha256",
        ]);
        const validation = await gateway.dispatch("begin_workspace_asset_import", body, {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        if (!isSuccessfulWorkspaceResult(validation)) return jsonResponse(200, validation);
        const principal = sessionBoundAssetImporter(
          validation,
          boundedString(body.session_token, "session_token", 8, 256),
        );
        const result = await assetIngress.begin(principal, {
          requestId: boundedString(body.request_id, "request_id", 8, 128),
          workspaceId: boundedString(body.workspace_id, "workspace_id", 1, 256),
          displayName: boundedString(body.display_name, "display_name", 1, 255),
          format: boundedString(body.format, "format", 3, 3) as AgentAssetFormat,
          mediaType: boundedString(body.media_type, "media_type", 3, 192),
          byteLength: safeInteger(body.byte_length, "byte_length"),
          sha256: boundedString(body.sha256, "sha256", 71, 71),
        });
        const wire = toAgentAssetImportGrantWire(result);
        return jsonResponse(200, { ok: true, data: wire });
      }
      if (pathname === "/v1/assets/imports/cancel" && request.method === "POST") {
        const body = exactObject(
          value,
          ["session_token", "instruction_digest", "candidate_handle"],
        );
        const validation = await gateway.dispatch("cancel_workspace_asset_import", body, {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        if (!isSuccessfulWorkspaceResult(validation)) return jsonResponse(200, validation);
        const principal = sessionBoundAssetImporter(
          validation,
          boundedString(body.session_token, "session_token", 8, 256),
        );
        const result = await assetIngress.cancelFromAgent(
          boundedString(body.candidate_handle, "candidate_handle", 43, 43),
          principal.authorizationId,
        );
        return jsonResponse(200, { ok: true, data: result });
      }
      if (pathname === "/v1/assets/imports/complete" && request.method === "POST") {
        const body = exactObject(value, ["session_token", "instruction_digest", "candidate_handle"]);
        const result = await gateway.dispatch("complete_workspace_asset_import", body, {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        return jsonResponse(200, result);
      }
      if (pathname === "/v1/reconstructions/begin" && request.method === "POST") {
        const body = exactObject(value, [
          "session_token",
          "instruction_digest",
          "request_id",
          "workspace_id",
          "profile",
          "photos",
          "approval_token",
        ]);
        const approved = approvedRestPhotoReconstructionPrincipal(gateway, body);
        const validation = await gateway.dispatch("begin_workspace_photo_reconstruction", withoutApprovalProof(body), {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        if (!isSuccessfulWorkspaceResult(validation)) return jsonResponse(200, validation);
        const principal = validatedPhotoReconstructionPrincipal(validation, approved);
        const result = await photoReconstruction.begin(principal, {
          requestId: body.request_id,
          workspaceId: body.workspace_id,
          profile: body.profile,
          photos: Array.isArray(body.photos)
            ? body.photos.map((photo) => {
                const item = photo as Record<string, unknown>;
                return {
                  photoId: item.photo_id,
                  mediaType: item.media_type,
                  byteLength: item.byte_length,
                  sha256: item.sha256,
                };
              })
            : body.photos,
        });
        return jsonResponse(200, { ok: true, data: result });
      }
      if (pathname === "/v1/reconstructions/start" && request.method === "POST") {
        const body = exactObject(value, ["session_token", "instruction_digest", "workspace_id", "job_id", "approval_token"]);
        const approved = approvedRestPhotoReconstructionPrincipal(gateway, body);
        const validation = await gateway.dispatch("start_workspace_photo_reconstruction", withoutApprovalProof(body), {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        if (!isSuccessfulWorkspaceResult(validation)) return jsonResponse(200, validation);
        const principal = validatedPhotoReconstructionPrincipal(validation, approved);
        const result = await photoReconstruction.start(
          boundedString(body.job_id, "job_id", 36, 36),
          principal.authorizationId,
          boundedString(body.workspace_id, "workspace_id", 1, 256),
        );
        return jsonResponse(200, { ok: true, data: result });
      }
      if (pathname === "/v1/reconstructions/inspect" && request.method === "POST") {
        const body = exactObject(value, ["session_token", "instruction_digest", "workspace_id", "job_id", "approval_token"]);
        const approved = approvedRestPhotoReconstructionPrincipal(gateway, body);
        const validation = await gateway.dispatch("inspect_workspace_photo_reconstruction", withoutApprovalProof(body), {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        if (!isSuccessfulWorkspaceResult(validation)) return jsonResponse(200, validation);
        const principal = validatedPhotoReconstructionPrincipal(validation, approved);
        const result = await photoReconstruction.inspect(
          boundedString(body.job_id, "job_id", 36, 36),
          principal.authorizationId,
          boundedString(body.workspace_id, "workspace_id", 1, 256),
        );
        return jsonResponse(200, { ok: true, data: result });
      }
      if (pathname === "/v1/reconstructions/cancel" && request.method === "POST") {
        const body = exactObject(value, ["session_token", "instruction_digest", "workspace_id", "job_id", "confirm", "approval_token"]);
        if (body.confirm !== true) throw new InvalidRequestError("confirm must be true.");
        const approved = approvedRestPhotoReconstructionPrincipal(gateway, body);
        const validation = await gateway.dispatch("cancel_workspace_photo_reconstruction", withoutApprovalProof(body), {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        if (!isSuccessfulWorkspaceResult(validation)) return jsonResponse(200, validation);
        const principal = validatedPhotoReconstructionPrincipal(validation, approved);
        await photoReconstruction.inspect(
          boundedString(body.job_id, "job_id", 36, 36),
          principal.authorizationId,
          boundedString(body.workspace_id, "workspace_id", 1, 256),
        );
        const result = await photoReconstruction.cancel(
          boundedString(body.job_id, "job_id", 36, 36),
          principal.authorizationId,
          boundedString(body.workspace_id, "workspace_id", 1, 256),
        );
        return jsonResponse(200, { ok: true, data: result });
      }
      if (pathname === "/v1/reconstructions/finalize" && request.method === "POST") {
        const body = exactObject(value, [
          "session_token",
          "instruction_digest",
          "workspace_id",
          "job_id",
          "display_name",
          "expected_output_sha256",
          "approval_token",
        ]);
        const approved = approvedRestPhotoReconstructionPrincipal(gateway, body);
        const validation = await gateway.dispatch("finalize_workspace_photo_reconstruction", withoutApprovalProof(body), {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        if (!isSuccessfulWorkspaceResult(validation)) return jsonResponse(200, validation);
        const principal = validatedPhotoReconstructionPrincipal(validation, approved);
        const candidate = await photoReconstruction.finalize(
          boundedString(body.job_id, "job_id", 36, 36),
          principal,
          boundedString(body.workspace_id, "workspace_id", 1, 256),
          {
            displayName: boundedString(body.display_name, "display_name", 1, 255),
            expectedOutputSha256: boundedString(body.expected_output_sha256, "expected_output_sha256", 71, 71),
          },
        );
        const result = await gateway.dispatch("complete_workspace_reconstruction_asset", {
          candidate_handle: candidate.candidateHandle,
          workspace_id: body.workspace_id,
        }, {
          clientName: request.headers.get("x-semaframe-agent-name") ?? undefined,
        });
        return jsonResponse(200, result);
      }
      const command = externalCommand(pathname, request.method, value);
      if (!command) return errorResponse(404, "not_found", "Not found.");
      const instructionClientName = command.name === "get_workspace_instructions" && isObject(command.input)
        ? command.input.client_name
        : undefined;
      const result = await gateway.dispatch(command.name, command.input, {
        clientName: request.headers.get("x-semaframe-agent-name") ??
          (typeof instructionClientName === "string" ? instructionClientName : undefined),
      });
      return jsonResponse(200, result);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return errorResponse(413, "body_too_large", "Request body is too large.");
      if (error instanceof InvalidRequestError) return errorResponse(400, "invalid_request", error.message);
      if (error instanceof PhotoReconstructionServiceError) return photoReconstructionErrorResponse(error);
      if (error instanceof AgentAssetIngressError) return assetErrorResponse(error);
      if (error instanceof AgentGatewayError) return errorResponse(statusFor(error), error.code, error.message, error.details);
      return errorResponse(500, "gateway_error", "The local agent gateway could not complete the request.");
    }
  };
  return Object.assign(handle, {
    close: async () => {
      feedApprovals.clear();
      voiceRelayHostActions.clear();
      const failures: unknown[] = [];
      // Reconstruction teardown may still need to revoke staged candidates,
      // so keep AssetIngress alive until it has settled. A cleanup failure must
      // not skip the remaining MCP/ingress shutdown work.
      try {
        await photoReconstruction.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await xrRelay.drainRendererRemovals();
      } catch (error) {
        failures.push(error);
      }
      removeVoiceRelayOwner();
      const trailing = await Promise.allSettled([
        mcp.close(),
        assetIngress.close(),
        voiceRelay.close(),
      ]);
      for (const result of trailing) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "The local Agent Gateway could not cleanly release every resource.");
      }
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

async function waitForNodeResponseDrain(
  response: NodeResponseLike,
  signal: AbortSignal,
): Promise<boolean> {
  if (response.destroyed || response.writableEnded || signal.aborted) return false;
  // Real Node ServerResponse implements on/off. A minimal adapter without
  // lifecycle events cannot safely advertise backpressure, so fail closed and
  // cancel the remaining source stream instead of buffering ahead.
  if (!response.on || !response.off) return false;
  return new Promise<boolean>((resolve) => {
    const finish = (drained: boolean) => {
      response.off?.("drain", onDrain);
      response.off?.("close", onClose);
      signal.removeEventListener("abort", onAbort);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onAbort = () => finish(false);
    response.on?.("drain", onDrain);
    response.on?.("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (response.destroyed || response.writableEnded || signal.aborted) finish(false);
  });
}

function nodeFetchRequest(
  target: URL,
  init: RequestInit & { duplex?: "half" },
  signal: AbortSignal,
): Request {
  try {
    return new Request(target, { ...init, signal } as RequestInit & { duplex?: "half" });
  } catch (signalError) {
    // Test DOMs and embedded runtimes can expose Request and AbortSignal from
    // distinct Web IDL realms. Retry only if the otherwise-identical request is
    // valid; production Node uses the first, cancellable branch.
    try {
      return new Request(target, init as RequestInit);
    } catch {
      throw signalError;
    }
  }
}

export function createNodeAgentGatewayHttpHandler(
  gateway: AgentGateway,
  options: AgentGatewayHttpOptions,
): AgentGatewayNodeHandler {
  // Validate before allocating ingress/reconstruction resources. JavaScript
  // callers can bypass the TypeScript contract, so an omitted capability must
  // still fail closed at runtime rather than expose browser-authority routes.
  requireBrowserBootstrapToken(options.browserBootstrapToken);
  const assetIngress = options.assetIngress ?? new AgentAssetIngress({
    publicBaseUrl: options.publicBaseUrl,
  });
  const photoReconstruction = options.photoReconstruction ?? new PhotoReconstructionService({
    publicBaseUrl: options.publicBaseUrl,
    assetIngress,
    backend: createReconstructionBackendFactory().backend,
  });
  const fetchHandler = createAgentGatewayHttpHandler(gateway, {
    ...options,
    assetIngress,
    photoReconstruction,
  });
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
      const method = request.method ?? "GET";
      const target = new URL(request.url ?? "/", `${options.publicBaseUrl}/`);
      let fetchRequest: Request;
      if (
        assetIngress.matchesUploadPath(target.pathname)
        || photoReconstruction.matchesUploadPath(target.pathname)
        || /^\/api\/agent\/reconstructions\/photo-uploads\/[0-9a-f-]{36}$/iu.test(target.pathname)
        || target.pathname === "/api/xr/v1/assets"
      ) {
        const iterator = request[Symbol.asyncIterator]();
        const stream = new ReadableStream<Uint8Array>({
          async pull(streamController) {
            try {
              const next = await iterator.next();
              if (next.done) {
                streamController.close();
                return;
              }
              streamController.enqueue(
                typeof next.value === "string"
                  ? new TextEncoder().encode(next.value)
                  : next.value,
              );
            } catch (error) {
              streamController.error(error);
            }
          },
          async cancel() {
            await iterator.return?.();
          },
        });
        fetchRequest = nodeFetchRequest(target, {
          method,
          headers: nodeHeaders(request.headers),
          body: stream,
          // Node's Fetch implementation requires this flag for streaming
          // request bodies. It is intentionally kept at this adapter boundary.
          duplex: "half",
        }, controller.signal);
      } else {
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        const requestBodyLimitBytes = target.pathname === XR_HTTP_PATHS.sessionSend
          ? XR_PROTOCOL_LIMITS.maximumSnapshotBytes + XR_PROTOCOL_LIMITS.maximumControlBytes
          : bodyLimitBytes;
        for await (const chunk of request) {
          const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
          byteLength += bytes.byteLength;
          if (byteLength > requestBodyLimitBytes) {
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
        fetchRequest = nodeFetchRequest(target, {
          method,
          headers: nodeHeaders(request.headers),
          ...(method === "GET" || method === "HEAD" ? {} : { body }),
        }, controller.signal);
      }
      const result = await fetchHandler(fetchRequest);
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      if (!result.body) {
        response.end();
      } else if (response.write) {
        const reader = result.body.getReader();
        let consumed = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              consumed = true;
              break;
            }
            if (response.destroyed || response.writableEnded) break;
            const accepted = response.write(value);
            if (!accepted && !await waitForNodeResponseDrain(response, controller.signal)) break;
          }
        } finally {
          // A browser that disconnects mid-download must release the underlying
          // AgentAssetIngress reader immediately. Otherwise completion remains
          // blocked by activeReaders until the candidate's long expiry timer.
          if (!consumed) await reader.cancel().catch(() => undefined);
          reader.releaseLock();
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
