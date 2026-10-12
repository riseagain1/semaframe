// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway, AgentGatewayError } from "../../../server/agent/AgentGateway";
import { AgentAssetIngress, AgentAssetIngressError } from "../../../server/agent/AgentAssetIngress";
import { PhotoReconstructionService, PhotoReconstructionServiceError } from "../../../server/reconstruction/PhotoReconstructionService";
import { createAgentGatewayHttpHandler, createNodeAgentGatewayHttpHandler, type AgentGatewayFetchHandler, type NodeRequestLike, type NodeResponseLike } from "../../../server/agent/AgentGatewayHttpHandler";

const base = "http://127.0.0.1:8788";
const origin = "http://127.0.0.1:4173";
const token = "b".repeat(43);
const assetPath = "/v1/assets/uploads/asset";
const photoPath = "/v1/reconstructions/photo-uploads/photo";
const browserPhotoPath = "/api/agent/reconstructions/photo-uploads/00000000-0000-4000-8000-000000000000";
const cleanup: Array<() => Promise<unknown> | void> = [];
const descriptor = { version: 1, candidateHandle: "c".repeat(43), requestId: "request-id", workspaceId: "workspace", displayName: "scan", format: "obj", mediaType: "text/plain", byteLength: 1, sha256: `sha256:${"a".repeat(64)}`, purpose: "generic_import", status: "ready", expiresAt: "tomorrow" };

function setup() {
  const gateway = new AgentGateway({ publicBaseUrl: base, workspaceRoot: process.cwd(), pollTimeoutMs: 1 });
  const ingress = {
    matchesUploadPath: (path: string) => path === assetPath,
    upload: vi.fn().mockResolvedValue(descriptor), close: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(), inspect: vi.fn(), complete: vi.fn(), cancelFromBrowser: vi.fn(),
    revokeAllExceptAuthorization: vi.fn().mockResolvedValue(undefined),
  };
  const photo = {
    matchesUploadPath: (path: string) => path === photoPath,
    upload: vi.fn().mockResolvedValue({ accepted: true }), close: vi.fn().mockResolvedValue(undefined),
    revokeAllExceptAuthorization: vi.fn().mockResolvedValue(undefined),
  };
  const options = { allowedOrigins: [origin], publicBaseUrl: base, browserBootstrapToken: token, assetIngress: ingress as unknown as AgentAssetIngress, photoReconstruction: photo as unknown as PhotoReconstructionService };
  const handle = createAgentGatewayHttpHandler(gateway, options);
  cleanup.push(async () => {
    try { await handle.close(); }
    finally { gateway.close(); }
  });
  return { gateway, ingress, photo, options, handle };
}
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map((close) => close())); vi.restoreAllMocks(); });

function streamRequest(path: string, method = "PUT", headers: Record<string, string> = {}, failCancel = true) {
  const cancel = vi.fn(() => failCancel ? Promise.reject(new Error("cancel failed")) : Promise.resolve());
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel });
  const request = new Request(`${base}${path}`, { method, headers, body, duplex: "half" } as RequestInit);
  return { request, cancel };
}
function browserPost(handle: AgentGatewayFetchHandler, gateway: AgentGateway, path: string, body: unknown) {
  return handle(new Request(`${base}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-semaframe-browser-bootstrap": token, "x-semaframe-agent-csrf": gateway.csrfToken }, body: JSON.stringify(body) }));
}

describe("gateway upload and response cleanup boundaries", () => {
  it.each([
    [assetPath + "?token=forbidden", "PUT", {}, 404], [assetPath, "POST", {}, 405],
    [photoPath + "#secret", "PUT", {}, 404], [photoPath, "POST", {}, 405],
    [browserPhotoPath, "PUT", { "x-semaframe-browser-bootstrap": token, origin: "https://evil.example" }, 403],
    ["/api/agent/config", "POST", {}, 403],
    ["/api/xr/voice-relay/state", "OPTIONS", { origin, "access-control-request-method": "POST" }, 204],
    ["/api/xr/voice-relay/state", "OPTIONS", { origin, "access-control-request-method": "GET" }, 405],
    ["/api/agent/voice-relay/state", "OPTIONS", { origin, "x-semaframe-browser-bootstrap": token }, 403],
  ])("rejects or completes %s without leaking failed body cancellation", async (path, method, headers, status) => {
    const { handle, ingress, photo } = setup();
    const { request, cancel } = streamRequest(path, method, headers);
    expect((await handle(request)).status).toBe(status);
    expect(cancel).toHaveBeenCalledOnce();
    expect(ingress.upload).not.toHaveBeenCalled();
    expect(photo.upload).not.toHaveBeenCalled();
  });

  it.each([401, 413])("preserves safe asset errors and the authentication challenge for %s", async (status) => {
    const { ingress, handle } = setup();
    ingress.upload.mockRejectedValue(new AgentAssetIngressError(status, "asset_rejected", "Safe error"));
    const { request, cancel } = streamRequest(assetPath);
    const response = await handle(request);
    expect(response.status).toBe(status);
    expect(response.headers.get("www-authenticate")).toBe(status === 401 ? "Bearer" : null);
    expect(await response.json()).toEqual({ error: { code: "asset_rejected", message: "Safe error" } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["asset", "photo"] as const)("sanitizes unexpected %s upload failures and finishes cancellation", async (kind) => {
    const { ingress, photo, handle } = setup();
    (kind === "asset" ? ingress : photo).upload.mockRejectedValue(new Error("secret filepath"));
    const { request, cancel } = streamRequest(kind === "asset" ? assetPath : photoPath);
    const response = await handle(request);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret filepath");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("adds a photo upload authentication challenge and tolerates broken cancellation", async () => {
    const { photo, handle } = setup();
    photo.upload.mockRejectedValue(new PhotoReconstructionServiceError(401, "photo_unauthorized", "Not authorized"));
    const { request, cancel } = streamRequest(photoPath);
    const response = await handle(request);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns the source iterator when a streaming consumer stops early, even if its cancellation fails", async () => {
    const { ingress, handle } = setup();
    ingress.upload.mockImplementation(async (_id, _auth, _type, _length, body: AsyncIterable<Uint8Array>) => {
      for await (const chunk of body) { expect(chunk).toEqual(new Uint8Array([1])); break; }
      return descriptor;
    });
    const { request, cancel } = streamRequest(assetPath, "PUT", { authorization: "not-bearer", "content-length": "9007199254740992" });
    expect((await handle(request)).status).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
    expect(ingress.upload.mock.calls[0]!.slice(1, 4)).toEqual([undefined, undefined, undefined]);
  });

  it("releases binary candidates exactly once on source errors", async () => {
    const { ingress, handle, gateway } = setup();
    const release = vi.fn();
    ingress.open.mockResolvedValue({ descriptor, body: new ReadableStream({ pull(controller) { controller.error(new Error("source failed")); } }), release });
    const response = await browserPost(handle, gateway, "/api/agent/assets/candidates/open", { candidateHandle: descriptor.candidateHandle, workspaceId: "workspace" });
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("source failed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("continues teardown after reconstruction fails and aggregates independent failures", async () => {
    const { handle, ingress, photo } = setup();
    const first = new Error("reconstruction cleanup"), second = new Error("ingress cleanup");
    photo.close.mockRejectedValue(first);
    ingress.close.mockRejectedValue(second);
    await expect(handle.close()).rejects.toMatchObject({ errors: [first, second] });
    expect(ingress.close).toHaveBeenCalledOnce();
  });
});

describe("browser request and native HTTP adapter guards", () => {
  it.each(["voice_relay_accessibility", "voice_relay_configure_target", "voice_relay_arm", "voice_relay_draft_round_trip"])("mints one-shot %s actions only on the authenticated desktop surface", async (action) => {
    const { handle, gateway } = setup();
    expect((await browserPost(handle, gateway, "/api/agent/host-actions/voice-relay/mint", { action })).status).toBe(200);
    expect((await browserPost(handle, gateway, "/api/agent/host-actions/voice-relay/mint", { action: "arbitrary_native_execution" })).status).toBe(400);
  });

  it.each([
    ["instructions_required", 403], ["engine_timeout", 504], ["pairing_rotated", 409],
    ["invalid_request", 400], ["schema_validation", 422], ["revision_stale", 409], ["unclassified", 422],
  ])("maps browser errors %s to safe status %s", async (code, status) => {
    const { gateway, handle } = setup();
    vi.spyOn(gateway, "revealPairing").mockImplementation(() => { throw new AgentGatewayError(code, "Safe", { retry: true }); });
    const response = await browserPost(handle, gateway, "/api/agent/browser/reveal", {});
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, details: { retry: true } } });
  });

  it("cancels Node's incoming iterator on early upload rejection and normalizes header arrays", async () => {
    const { gateway, options, ingress } = setup();
    const node = createNodeAgentGatewayHttpHandler(gateway, options);
    cleanup.push(() => node.close());
    const iterator = { next: vi.fn().mockResolvedValue({ done: false, value: "data" }), return: vi.fn().mockResolvedValue({ done: true }) };
    const request: NodeRequestLike = { method: "PUT", url: assetPath + "?reject", headers: { "x-test": ["a", "b"], unused: undefined }, [Symbol.asyncIterator]: () => iterator };
    const response: NodeResponseLike = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await node(request, response);
    expect(response.statusCode).toBe(404);
    expect(iterator.return).toHaveBeenCalledOnce();
    expect(ingress.upload).not.toHaveBeenCalled();
  });

  it("rejects oversized native JSON before dispatch and never writes after disconnect", async () => {
    const { gateway, options } = setup();
    const node = createNodeAgentGatewayHttpHandler(gateway, { ...options, bodyLimitBytes: 2 });
    cleanup.push(() => node.close());
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await node({ method: "POST", url: "/v1/workspace/inspect", headers: {}, async *[Symbol.asyncIterator]() { yield "123"; } }, response);
    expect(response.statusCode).toBe(413);
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining("body_too_large"));
    const closed = { ...response, destroyed: true, end: vi.fn() };
    await node({ url: "http://[", headers: {}, async *[Symbol.asyncIterator]() { yield ""; } }, closed);
    expect(closed.end).not.toHaveBeenCalled();
    await node({ url: "http://[", headers: {}, async *[Symbol.asyncIterator]() { yield ""; } }, response);
    expect(response.statusCode).toBe(500);
  });
});
