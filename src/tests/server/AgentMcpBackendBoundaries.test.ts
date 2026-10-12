// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGateway, AgentGatewayError } from "../../../server/agent/AgentGateway";
import { AgentAssetIngress, AgentAssetIngressError } from "../../../server/agent/AgentAssetIngress";
import { PhotoReconstructionService, PhotoReconstructionServiceError } from "../../../server/reconstruction/PhotoReconstructionService";
import type { AgentMcpBackend } from "../../../server/agent/AgentMcpServer";
import { createAgentMcpHttpHandler } from "../../../server/agent/AgentMcpHttpHandler";

const transport = vi.hoisted(() => ({ factory: undefined as unknown, backend: undefined as unknown, fetch: vi.fn(), close: vi.fn() }));
vi.mock("@modelcontextprotocol/server", () => ({
  createMcpHandler: (factory: unknown) => {
    transport.factory = factory;
    return { fetch: transport.fetch, close: transport.close };
  },
}));
vi.mock("../../../server/agent/AgentMcpServer", () => ({
  AGENT_MCP_SERVER_INFO: { name: "test", version: "1" },
  createAgentMcpServer: (backend: unknown) => { transport.backend = backend; return {}; },
}));

const origin = "https://workspace.example";
const endpoint = "https://gateway.example/mcp/test";
const client = { protocolEra: "modern" as const };
const envelope = { session_token: "session-token", instruction_digest: "instruction-digest", workspace_id: "workspace" };
const ok = (data: unknown = { workspace_id: "workspace", client_id: "approved-agent" }) => ({ responseOk: true, status: 200, payload: { ok: true, data } });
const denied = { responseOk: false, status: 403, payload: { ok: false, error: { code: "denied" } } };

function setup() {
  const gateway = {
    dispatchOffer: vi.fn().mockResolvedValue(ok()),
    requireApprovedClientScope: vi.fn().mockReturnValue({ authorizationId: "authorization", clientId: "approved-agent" }),
    connectionOffer: vi.fn().mockReturnValue({ connectionUrl: endpoint, offerStatus: "pending", offerExpiresAt: "tomorrow" }),
    isConnectionPath: vi.fn().mockReturnValue(true),
  };
  const ingress = { begin: vi.fn().mockResolvedValue({ candidateHandle: "candidate", purpose: "generic_import" }), cancelFromAgent: vi.fn().mockResolvedValue({ cancelled: true }) };
  const photo = {
    begin: vi.fn().mockResolvedValue({ job_id: "job" }), start: vi.fn().mockResolvedValue({ state: "running" }),
    inspect: vi.fn().mockResolvedValue({ state: "ready" }), cancel: vi.fn().mockResolvedValue({ state: "cancelled" }),
    finalize: vi.fn().mockResolvedValue({ candidateHandle: "candidate", measurementBundle: { bundle: true } }),
  };
  const handler = createAgentMcpHttpHandler(gateway as unknown as AgentGateway, {
    allowedOrigins: [origin], assetIngress: ingress as unknown as AgentAssetIngress,
    photoReconstruction: photo as unknown as PhotoReconstructionService,
  });
  (transport.factory as (value: unknown) => unknown)({ era: "modern", requestInfo: { url: endpoint } });
  return { gateway, ingress, photo, handler, backend: transport.backend as AgentMcpBackend };
}
beforeEach(() => {
  vi.clearAllMocks();
  transport.fetch.mockImplementation(async () => new Response("mcp", { headers: { vary: "accept, origin" } }));
  transport.close.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("MCP capability boundaries before native backend work", () => {
  it("forwards ordinary calls and enforces workspace plus scope checks before host control", async () => {
    const { backend, gateway } = setup();
    await backend.dispatch("inspect_workspace", envelope, client);
    expect(gateway.dispatchOffer).toHaveBeenCalledWith("/mcp/test", "inspect_workspace", envelope, client);
    await backend.hostControl!("inspect_xr_readiness", envelope, client);
    expect(gateway.requireApprovedClientScope).toHaveBeenCalledWith("workspace:read");
    expect(gateway.dispatchOffer).toHaveBeenLastCalledWith("/mcp/test", "inspect_xr_readiness", envelope, client);
    gateway.dispatchOffer.mockResolvedValueOnce(denied);
    expect(await backend.hostControl!("inspect_xr_readiness", envelope, client)).toBe(denied);
    for (const data of [null, [], {}, { workspace_id: "other" }]) {
      gateway.dispatchOffer.mockResolvedValueOnce(ok(data));
      expect(await backend.hostControl!("inspect_xr_readiness", envelope, client)).toMatchObject({ status: 409, payload: { error: { code: "host_workspace_mismatch" } } });
    }
    for (const invalid of [null, [], { ...envelope, session_token: 1 }, { ...envelope, instruction_digest: 2 }, { ...envelope, workspace_id: 3 }]) {
      await expect(backend.hostControl!("inspect_xr_readiness", invalid, client)).rejects.toThrow(AgentGatewayError);
    }
  });

  it("binds import cancellation to the approved authorization and never proceeds after browser denial", async () => {
    const { backend, gateway, ingress } = setup();
    expect(await backend.cancelAssetImport!({ candidate_handle: "candidate" }, client)).toMatchObject({ payload: { ok: true, data: { cancelled: true } } });
    expect(ingress.cancelFromAgent).toHaveBeenCalledWith("candidate", "authorization");
    gateway.dispatchOffer.mockResolvedValueOnce(denied);
    expect(await backend.cancelAssetImport!({}, client)).toBe(denied);
    expect(ingress.cancelFromAgent).toHaveBeenCalledOnce();
    gateway.dispatchOffer.mockResolvedValueOnce(denied);
    expect(await backend.beginAssetImport!({}, client)).toBe(denied);
    expect(ingress.begin).not.toHaveBeenCalled();
  });

  it.each([
    [new AgentAssetIngressError(413, "asset_limit", "Too large"), 413, "asset_limit"],
    [new AgentGatewayError("authorization_scope_missing", "Not approved"), 403, "authorization_scope_missing"],
    [new Error("private path /secret/token"), 500, "asset_ingress_error"],
  ])("sanitizes import backend errors %s", async (error, status, code) => {
    const { backend, ingress } = setup();
    ingress.cancelFromAgent.mockRejectedValue(error);
    const result = await backend.cancelAssetImport!({ candidate_handle: "candidate" }, client);
    expect(result).toMatchObject({ responseOk: false, status, payload: { ok: false, error: { code, retryable: false } } });
    expect(JSON.stringify(result)).not.toContain("/secret/token");
  });

  it("cannot mint service-owned purposes and preserves permitted measurement purpose", async () => {
    const { backend, ingress } = setup();
    const input = { request_id: "request", workspace_id: "workspace", display_name: "scan", format: "obj", media_type: "text/plain", byte_length: 20, sha256: "sha256:abc" };
    expect(await backend.beginAssetImport!({ ...input, purpose: "reconstruction_output" }, client)).toMatchObject({ status: 400, payload: { error: { code: "invalid_request" } } });
    expect(ingress.begin).not.toHaveBeenCalled();
    await backend.beginAssetImport!({ ...input, purpose: "measurement_source" }, client);
    expect(ingress.begin).toHaveBeenLastCalledWith(expect.objectContaining({ authorizationId: "authorization" }), expect.objectContaining({ purpose: "measurement_source" }));
    ingress.begin.mockRejectedValue(new AgentAssetIngressError(409, "request_conflict", "Conflict"));
    expect(await backend.beginAssetImport!(input, client)).toMatchObject({ status: 409 });
  });

  it.each([null, [], {}, { client_id: "" }, { client_id: "x".repeat(129) }, { client_id: "approved-agent", client_name: 3 }, { client_id: "approved-agent", client_name: "" }, { client_id: "approved-agent", client_name: "x".repeat(161) }, { client_id: "different-agent" }])("rejects invalid or substituted reconstruction identity %j", async (data) => {
    const { backend, gateway, photo } = setup();
    gateway.dispatchOffer.mockResolvedValueOnce(ok(data));
    expect(await backend.inspectPhotoReconstruction!({ ...envelope, job_id: "job" }, client)).toMatchObject({ payload: { error: { code: "invalid_response" } } });
    expect(photo.inspect).not.toHaveBeenCalled();
  });

  it("requires a stable approved identity and carries an optional validated client name", async () => {
    const { backend, gateway, photo } = setup();
    gateway.requireApprovedClientScope.mockReturnValueOnce({ authorizationId: "auth", clientId: undefined } as never);
    expect(await backend.inspectPhotoReconstruction!({ ...envelope, job_id: "job" }, client)).toMatchObject({ payload: { error: { code: "invalid_response" } } });
    gateway.dispatchOffer.mockResolvedValueOnce(ok({ client_id: "approved-agent", client_name: "Human-visible agent" }));
    await backend.beginPhotoReconstruction!({ ...envelope, request_id: "request", profile: "object", photos: [], retain_measurement_bundle: true } as never, client);
    expect(photo.begin).toHaveBeenCalledWith({ authorizationId: "authorization", clientId: "approved-agent", clientName: "Human-visible agent" }, expect.objectContaining({ retainMeasurementBundle: true }));
  });

  it.each(["startPhotoReconstruction", "inspectPhotoReconstruction", "cancelPhotoReconstruction", "finalizePhotoReconstruction"] as const)("preserves browser denial and maps failure for %s", async (method) => {
    const { backend, gateway, photo } = setup();
    gateway.dispatchOffer.mockResolvedValueOnce(denied);
    const input = { ...envelope, job_id: "job", display_name: "scan", expected_output_sha256: "digest", confirm: true as const };
    expect(await backend[method]!(input, client)).toBe(denied);
    const operation = { startPhotoReconstruction: "start", inspectPhotoReconstruction: "inspect", cancelPhotoReconstruction: "cancel", finalizePhotoReconstruction: "finalize" }[method] as "start";
    photo[operation].mockRejectedValue(new PhotoReconstructionServiceError(503, "backend_unavailable", "Unavailable"));
    expect(await backend[method]!(input, client)).toMatchObject({ status: 503, payload: { error: { retryable: true, code: "backend_unavailable" } } });
    photo[operation].mockRejectedValue(new Error("private token"));
    const result = await backend[method]!(input, client);
    expect(result).toMatchObject({ status: 500, payload: { error: { retryable: false, code: "photo_reconstruction_error" } } });
    expect(JSON.stringify(result)).not.toContain("private token");
  });

  it("forwards reconstruction completion through browser authority with retained evidence", async () => {
    const { backend, gateway } = setup();
    await backend.finalizePhotoReconstruction!({ ...envelope, job_id: "job", display_name: "scan", expected_output_sha256: "digest" }, client);
    expect(gateway.dispatchOffer).toHaveBeenLastCalledWith("/mcp/test", "complete_workspace_reconstruction_asset", { candidate_handle: "candidate", workspace_id: "workspace", measurement_bundle: { bundle: true } }, client);
  });
});

describe("MCP transport boundary and response headers", () => {
  it("merges Vary without duplicates, handles origin-free clients, and releases the transport", async () => {
    const { handler } = setup();
    const response = await handler.fetch(new Request(endpoint, { method: "POST", headers: { origin } }));
    expect(response.headers.get("vary")).toBe("accept, origin");
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("mcp");
    expect((await handler.fetch(new Request(endpoint, { method: "POST" }))).status).toBe(200);
    expect((await handler.fetch(new Request(endpoint, { method: "HEAD" }))).body).toBeNull();
    await handler.close();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(handler.matches("/mcp/test")).toBe(true);
  });
  it.each([
    ["connection_offer_expired", 410], ["authorization_scope_missing", 403], ["instructions_required", 403],
    ["approval_invalid", 403], ["agent_mode_disabled", 503], ["gateway_closed", 503], ["connection_invalid", 404], ["other", 409],
  ])("maps %s to %s without invoking MCP", async (code, status) => {
    const { handler, gateway } = setup();
    gateway.connectionOffer.mockImplementation(() => { throw new AgentGatewayError(code, "Safe error"); });
    expect((await handler.fetch(new Request(endpoint))).status).toBe(status);
    expect(transport.fetch).not.toHaveBeenCalled();
  });
  it("does not leak unexpected transport exceptions", async () => {
    const { handler } = setup();
    transport.fetch.mockRejectedValue(new Error("secret"));
    const response = await handler.fetch(new Request(endpoint, { method: "POST" }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });
});
