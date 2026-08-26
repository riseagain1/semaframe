import { createMcpHandler } from "@modelcontextprotocol/server";
import { WORKSPACE_AGENT_GUIDE } from "../../src/workspace/agents";
import { AgentGateway, AgentGatewayError } from "./AgentGateway";
import { AGENT_MCP_SERVER_INFO, createAgentMcpServer } from "./AgentMcpServer";
import {
  AGENT_ASSET_IMPORT_SCOPE,
  AgentAssetIngress,
  AgentAssetIngressError,
  toAgentAssetImportGrantWire,
  type AgentAssetFormat,
} from "./AgentAssetIngress";
import type {
  BeginWorkspacePhotoReconstructionInput,
  CancelWorkspacePhotoReconstructionInput,
  FinalizeWorkspacePhotoReconstructionInput,
  InspectWorkspacePhotoReconstructionInput,
  StartWorkspacePhotoReconstructionInput,
} from "../../src/workspace/agents";
import {
  PhotoReconstructionService,
  PhotoReconstructionServiceError,
} from "../reconstruction/PhotoReconstructionService";
import {
  hostControlScopeForCommand,
} from "../../src/agent/hostControlContracts";

const AGENT_PHOTO_RECONSTRUCTION_SCOPE = "asset:reconstruct" as const;

export type AgentMcpHttpOptions = Readonly<{
  allowedOrigins: readonly string[];
  assetIngress?: AgentAssetIngress;
  photoReconstruction?: PhotoReconstructionService;
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
  if (["authorization_scope_missing", "instructions_required", "approval_invalid"].includes(error.code)) return 403;
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
        hostControl: async (name, input, client) => {
          const body = hostControlInput(input);
          const validation = await gateway.dispatchOffer(
            pathname,
            "inspect_workspace",
            {
              session_token: body.session_token,
              instruction_digest: body.instruction_digest,
            },
            client,
          );
          if (!successfulWorkspaceResult(validation.payload)) return validation;
          if (!validation.payload.data || typeof validation.payload.data !== "object" ||
              Array.isArray(validation.payload.data) ||
              (validation.payload.data as Record<string, unknown>).workspace_id !== body.workspace_id) {
            return {
              responseOk: false,
              status: 409,
              payload: {
                ok: false,
                error: {
                  code: "host_workspace_mismatch",
                  message: "The host-control request does not match the open Workspace.",
                  retryable: true,
                  required_action: "inspect_workspace",
                },
              },
            };
          }
          gateway.requireApprovedClientScope(hostControlScopeForCommand(name));
          return gateway.dispatchOffer(pathname, name, input, client);
        },
        ...(options.assetIngress ? {
          beginAssetImport: async (input, client) => {
            const validation = await gateway.dispatchOffer(
              pathname,
              "begin_workspace_asset_import",
              input,
              client,
            );
            if (!successfulWorkspaceResult(validation.payload)) return validation;
            try {
              const body = assetImportInput(input);
              const principal = gateway.requireApprovedClientScope(AGENT_ASSET_IMPORT_SCOPE);
              const grant = await options.assetIngress!.begin(principal, {
                requestId: body.request_id,
                workspaceId: body.workspace_id,
                displayName: body.display_name,
                format: body.format,
                mediaType: body.media_type,
                byteLength: body.byte_length,
                sha256: body.sha256,
              });
              return {
                responseOk: true,
                status: 200,
                payload: { ok: true, data: toAgentAssetImportGrantWire(grant) },
              };
            } catch (error) {
              return assetImportBackendError(error);
            }
          },
          cancelAssetImport: async (input, client) => {
            const validation = await gateway.dispatchOffer(
              pathname,
              "cancel_workspace_asset_import",
              input,
              client,
            );
            if (!successfulWorkspaceResult(validation.payload)) return validation;
            try {
              const body = assetCancelInput(input);
              const principal = gateway.requireApprovedClientScope(AGENT_ASSET_IMPORT_SCOPE);
              const result = await options.assetIngress!.cancelFromAgent(
                body.candidate_handle,
                principal.authorizationId,
              );
              return { responseOk: true, status: 200, payload: { ok: true, data: result } };
            } catch (error) {
              return assetImportBackendError(error);
            }
          },
        } : {}),
        ...(options.photoReconstruction ? {
          beginPhotoReconstruction: async (input: BeginWorkspacePhotoReconstructionInput, client) => {
            const validation = await gateway.dispatchOffer(
              pathname,
              "begin_workspace_photo_reconstruction",
              input,
              client,
            );
            if (!successfulWorkspaceResult(validation.payload)) return validation;
            try {
              const principal = approvedPhotoReconstructionPrincipal(gateway, validation.payload);
              const result = await options.photoReconstruction!.begin(principal, {
                requestId: input.request_id,
                workspaceId: input.workspace_id,
                profile: input.profile,
                photos: input.photos.map((photo) => ({
                  photoId: photo.photo_id,
                  mediaType: photo.media_type,
                  byteLength: photo.byte_length,
                  sha256: photo.sha256,
                })),
              });
              return { responseOk: true, status: 200, payload: { ok: true, data: result } };
            } catch (error) {
              return photoReconstructionBackendError(error);
            }
          },
          startPhotoReconstruction: async (input: StartWorkspacePhotoReconstructionInput, client) => {
            const validation = await gateway.dispatchOffer(
              pathname,
              "start_workspace_photo_reconstruction",
              input,
              client,
            );
            if (!successfulWorkspaceResult(validation.payload)) return validation;
            try {
              const principal = approvedPhotoReconstructionPrincipal(gateway, validation.payload);
              const result = await options.photoReconstruction!.start(
                input.job_id,
                principal.authorizationId,
                input.workspace_id,
              );
              return { responseOk: true, status: 200, payload: { ok: true, data: result } };
            } catch (error) {
              return photoReconstructionBackendError(error);
            }
          },
          inspectPhotoReconstruction: async (input: InspectWorkspacePhotoReconstructionInput, client) => {
            const validation = await gateway.dispatchOffer(
              pathname,
              "inspect_workspace_photo_reconstruction",
              input,
              client,
            );
            if (!successfulWorkspaceResult(validation.payload)) return validation;
            try {
              const principal = approvedPhotoReconstructionPrincipal(gateway, validation.payload);
              const result = await options.photoReconstruction!.inspect(
                input.job_id,
                principal.authorizationId,
                input.workspace_id,
              );
              return { responseOk: true, status: 200, payload: { ok: true, data: result } };
            } catch (error) {
              return photoReconstructionBackendError(error);
            }
          },
          cancelPhotoReconstruction: async (input: CancelWorkspacePhotoReconstructionInput, client) => {
            const validation = await gateway.dispatchOffer(
              pathname,
              "cancel_workspace_photo_reconstruction",
              input,
              client,
            );
            if (!successfulWorkspaceResult(validation.payload)) return validation;
            try {
              const principal = approvedPhotoReconstructionPrincipal(gateway, validation.payload);
              const result = await options.photoReconstruction!.cancel(
                input.job_id,
                principal.authorizationId,
                input.workspace_id,
              );
              return { responseOk: true, status: 200, payload: { ok: true, data: result } };
            } catch (error) {
              return photoReconstructionBackendError(error);
            }
          },
          finalizePhotoReconstruction: async (input: FinalizeWorkspacePhotoReconstructionInput, client) => {
            const validation = await gateway.dispatchOffer(
              pathname,
              "finalize_workspace_photo_reconstruction",
              input,
              client,
            );
            if (!successfulWorkspaceResult(validation.payload)) return validation;
            try {
              const principal = approvedPhotoReconstructionPrincipal(gateway, validation.payload);
              const candidate = await options.photoReconstruction!.finalize(
                input.job_id,
                principal,
                input.workspace_id,
                {
                  displayName: input.display_name,
                  expectedOutputSha256: input.expected_output_sha256,
                },
              );
              // Finalization is browser-authoritative: the reconstructed bytes
              // traverse the same independent preflight/vault/register path as
              // every other approved Reality Asset candidate.
              return await gateway.dispatchOffer(
                pathname,
                "complete_workspace_reconstruction_asset",
                {
                  candidate_handle: candidate.candidateHandle,
                  workspace_id: input.workspace_id,
                },
                client,
              );
            } catch (error) {
              return photoReconstructionBackendError(error);
            }
          },
        } : {}),
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

function hostControlInput(value: unknown): Readonly<{
  session_token: string;
  instruction_digest: string;
  workspace_id: string;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentGatewayError("invalid_request", "The host-control input is invalid.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.session_token !== "string" || typeof body.instruction_digest !== "string" ||
      typeof body.workspace_id !== "string") {
    throw new AgentGatewayError("invalid_request", "The host-control capability envelope is invalid.");
  }
  return {
    session_token: body.session_token,
    instruction_digest: body.instruction_digest,
    workspace_id: body.workspace_id,
  };
}

type AssetImportMcpInput = Readonly<{
  request_id: string;
  workspace_id: string;
  display_name: string;
  format: AgentAssetFormat;
  media_type: string;
  byte_length: number;
  sha256: string;
}>;

function successfulWorkspaceResult(value: unknown): value is { ok: true; data: unknown } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (value as { ok?: unknown }).ok === true;
}

function approvedPhotoReconstructionPrincipal(
  gateway: AgentGateway,
  validation: { ok: true; data: unknown },
) {
  const approved = gateway.requireApprovedClientScope(AGENT_PHOTO_RECONSTRUCTION_SCOPE);
  const data = validation.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AgentGatewayError(
      "invalid_response",
      "The browser returned an invalid photo-reconstruction session validation.",
    );
  }
  const clientId = (data as Record<string, unknown>).client_id;
  const clientName = (data as Record<string, unknown>).client_name;
  if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 128
      || (clientName !== undefined && (
        typeof clientName !== "string" || clientName.length < 1 || clientName.length > 160
      ))) {
    throw new AgentGatewayError(
      "invalid_response",
      "The browser returned an invalid photo-reconstruction Agent identity.",
    );
  }
  if (approved.clientId === undefined) {
    throw new AgentGatewayError(
      "invalid_response",
      "Photo reconstruction requires a stable client_id in the approved connection claim.",
    );
  }
  if (approved.clientId !== clientId) {
    throw new AgentGatewayError(
      "invalid_response",
      "The approved Agent identity changed during photo-reconstruction validation.",
    );
  }
  return Object.freeze({
    authorizationId: approved.authorizationId,
    clientId: approved.clientId,
    ...(clientName === undefined ? {} : { clientName }),
  });
}

function assetImportInput(value: unknown): AssetImportMcpInput {
  const record = value as Record<string, unknown>;
  return {
    request_id: String(record.request_id),
    workspace_id: String(record.workspace_id),
    display_name: String(record.display_name),
    format: record.format as AgentAssetFormat,
    media_type: String(record.media_type),
    byte_length: Number(record.byte_length),
    sha256: String(record.sha256),
  };
}

function assetCancelInput(value: unknown): { candidate_handle: string } {
  return { candidate_handle: String((value as Record<string, unknown>).candidate_handle) };
}

function assetImportBackendError(error: unknown): {
  responseOk: boolean;
  status: number;
  payload: unknown;
} {
  if (error instanceof AgentAssetIngressError) {
    return {
      responseOk: false,
      status: error.status,
      payload: { ok: false, error: { code: error.code, message: error.message, retryable: false } },
    };
  }
  if (error instanceof AgentGatewayError) {
    return {
      responseOk: false,
      status: statusFor(error),
      payload: { ok: false, error: { code: error.code, message: error.message, retryable: false } },
    };
  }
  return {
    responseOk: false,
    status: 500,
    payload: {
      ok: false,
      error: { code: "asset_ingress_error", message: "The Reality Asset import could not begin.", retryable: false },
    },
  };
}

function photoReconstructionBackendError(error: unknown): {
  responseOk: boolean;
  status: number;
  payload: unknown;
} {
  if (error instanceof PhotoReconstructionServiceError) {
    return {
      responseOk: false,
      status: error.status,
      payload: { ok: false, error: { code: error.code, message: error.message, retryable: error.status >= 429 } },
    };
  }
  if (error instanceof AgentGatewayError) {
    return {
      responseOk: false,
      status: statusFor(error),
      payload: { ok: false, error: { code: error.code, message: error.message, retryable: false } },
    };
  }
  return {
    responseOk: false,
    status: 500,
    payload: {
      ok: false,
      error: {
        code: "photo_reconstruction_error",
        message: "The photo reconstruction request could not be completed.",
        retryable: false,
      },
    },
  };
}
