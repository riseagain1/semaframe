import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAssetIngress } from "../../../server/agent/AgentAssetIngress";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import {
  createAgentGatewayHttpHandler,
  type AgentGatewayFetchHandler,
} from "../../../server/agent/AgentGatewayHttpHandler";
import {
  PhotoReconstructionService,
  type PhotoReconstructionBackend,
  type PhotoReconstructionBackendRequest,
} from "../../../server/reconstruction/PhotoReconstructionService";
import type {
  BeginPhotoReconstructionResult,
  PhotoReconstructionJobView,
  PhotoUploadGrant,
} from "../../reconstruction/contracts";

const PUBLIC_URL = "http://127.0.0.1:8788";
const ORIGIN = "http://127.0.0.1:4173";
const WORKSPACE_ID = "workspace_main";
const BROWSER_BOOTSTRAP_TOKEN = "b".repeat(43);

const OUTPUT = new TextEncoder().encode([
  "ply",
  "format ascii 1.0",
  "element vertex 1",
  "property float x",
  "property float y",
  "property float z",
  "property float opacity",
  "property float scale_0",
  "property float scale_1",
  "property float scale_2",
  "property float rot_0",
  "property float rot_1",
  "property float rot_2",
  "property float rot_3",
  "property float f_dc_0",
  "property float f_dc_1",
  "property float f_dc_2",
  "end_header",
  "0 0 0 1 0 0 0 1 0 0 0 0.5 0.5 0.5",
  "",
].join("\n"));

const PHOTOS = Object.freeze([
  Object.freeze({
    photoId: "front",
    mediaType: "image/png" as const,
    bytes: new Uint8Array(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==",
      "base64",
    )),
  }),
  Object.freeze({
    photoId: "rear",
    mediaType: "image/png" as const,
    bytes: new Uint8Array(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNg+M8AQhAKABvyA/3vqwwGAAAAAElFTkSuQmCC",
      "base64",
    )),
  }),
]);

class FakePhotoBackend implements PhotoReconstructionBackend {
  readonly identity = Object.freeze({ id: "fake-photo-backend", version: "1.0.0" });
  readonly requests: PhotoReconstructionBackendRequest[] = [];

  constructor(readonly hangUntilCancelled = false) {}

  async probe() {
    return { available: true } as const;
  }

  async run(request: PhotoReconstructionBackendRequest) {
    this.requests.push(request);
    request.onProgress({
      phase: "camera_solving",
      progress: 0.25,
      registeredPhotoCount: request.photos.length,
    });
    if (this.hangUntilCancelled) {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new DOMException("cancelled", "AbortError"));
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
    }
    request.onProgress({ phase: "training", progress: 0.75 });
    const outputPath = join(request.outputDirectory, "gateway-reconstruction.ply");
    await writeFile(outputPath, OUTPUT, { mode: 0o600 });
    request.onProgress({ phase: "packing", progress: 0.95 });
    return {
      outputPath,
      format: "ply" as const,
      registeredPhotoCount: request.photos.length,
      warnings: ["source_scale_unknown", "source_coordinates_unknown"] as const,
    };
  }
}

type TestRig = Readonly<{
  gateway: AgentGateway;
  handle: AgentGatewayFetchHandler;
  service: PhotoReconstructionService;
  assetIngress: AgentAssetIngress;
  backend: FakePhotoBackend;
}>;

const rigs: TestRig[] = [];
const clients: Client[] = [];
const temporaryParents: string[] = [];

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function camelBegin(requestId: string) {
  return {
    requestId,
    workspaceId: WORKSPACE_ID,
    profile: "balanced" as const,
    photos: PHOTOS.map((photo) => ({
      photoId: photo.photoId,
      mediaType: photo.mediaType,
      byteLength: photo.bytes.byteLength,
      sha256: digest(photo.bytes),
    })),
  };
}

function snakeBegin(requestId: string) {
  return {
    session_token: "session_reconstruction_gateway",
    instruction_digest: "sha256:reconstruction-gateway-guide",
    request_id: requestId,
    workspace_id: WORKSPACE_ID,
    profile: "balanced" as const,
    photos: PHOTOS.map((photo) => ({
      photo_id: photo.photoId,
      media_type: photo.mediaType,
      byte_length: photo.bytes.byteLength,
      sha256: digest(photo.bytes),
    })),
  };
}

async function setup(backend = new FakePhotoBackend()): Promise<TestRig> {
  const temporaryParent = await mkdtemp(join(tmpdir(), "semaframe-reconstruction-gateway-test-"));
  temporaryParents.push(temporaryParent);
  const gateway = new AgentGateway({
    publicBaseUrl: PUBLIC_URL,
    workspaceRoot: "/workspace/SemaFrame",
    commandTimeoutMs: 2_000,
    pollTimeoutMs: 10,
    browserTtlMs: 5_000,
  });
  const assetIngress = new AgentAssetIngress({
    publicBaseUrl: PUBLIC_URL,
    temporaryDirectory: temporaryParent,
    maxBytes: 1024 * 1024,
    maxStagedBytes: 4 * 1024 * 1024,
    sweepIntervalMs: 0,
  });
  const service = new PhotoReconstructionService({
    publicBaseUrl: PUBLIC_URL,
    temporaryDirectory: temporaryParent,
    assetIngress,
    backend,
    sweepIntervalMs: 0,
  });
  const handle = createAgentGatewayHttpHandler(gateway, {
    allowedOrigins: [ORIGIN],
    publicBaseUrl: PUBLIC_URL,
    browserBootstrapToken: BROWSER_BOOTSTRAP_TOKEN,
    assetIngress,
    photoReconstruction: service,
  });
  const rig = { gateway, handle, service, assetIngress, backend };
  rigs.push(rig);
  return rig;
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function payload<T = Record<string, unknown>>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function browserPost(
  handle: AgentGatewayFetchHandler,
  csrfToken: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return handle(jsonRequest(path, body, {
    origin: ORIGIN,
    "x-semaframe-agent-csrf": csrfToken,
    "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN,
  }));
}

function browserConfigRequest(): Request {
  return new Request(`${PUBLIC_URL}/api/agent/config`, {
    headers: { "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN },
  });
}

async function uploadGrant(
  handle: AgentGatewayFetchHandler,
  grant: PhotoUploadGrant,
  throughBrowserAlias: boolean,
): Promise<Response> {
  const source = PHOTOS.find(({ photoId }) => photoId === grant.photoId);
  if (!source) throw new Error(`Missing source photo ${grant.photoId}`);
  const publicPath = new URL(grant.url).pathname;
  const grantId = publicPath.slice(publicPath.lastIndexOf("/") + 1);
  const path = throughBrowserAlias
    ? `/api/agent/reconstructions/photo-uploads/${grantId}`
    : publicPath;
  return handle(new Request(`${PUBLIC_URL}${path}`, {
    method: "PUT",
    headers: {
      ...(throughBrowserAlias ? {
        origin: ORIGIN,
        "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN,
      } : {}),
      authorization: `Bearer ${grant.token}`,
      "content-type": grant.contentType,
      "content-length": String(grant.contentLength),
    },
    body: source.bytes.slice(),
  }));
}

async function waitForBrowserReady(
  handle: AgentGatewayFetchHandler,
  csrfToken: string,
  jobId: string,
): Promise<PhotoReconstructionJobView> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await browserPost(handle, csrfToken, "/api/agent/reconstructions/inspect", {
      jobId,
      workspaceId: WORKSPACE_ID,
    });
    const job = await payload<PhotoReconstructionJobView>(response);
    if (job.status === "ready") return job;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`Reconstruction reached ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Reconstruction did not become ready");
}

async function pollCommand(gateway: AgentGateway, browserConnectionId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const polled = await gateway.pollBrowser(browserConnectionId);
    if (polled.kind === "command") return polled.command;
  }
  throw new Error("Expected a browser-authoritative command");
}

function submitWorkspaceResult(
  gateway: AgentGateway,
  browserConnectionId: string,
  commandId: string,
  result: unknown,
): void {
  gateway.submitBrowserResult({
    browserConnectionId,
    commandId,
    ok: true,
    result,
  });
}

async function restWithValidation(
  rig: TestRig,
  bearer: string,
  browserConnectionId: string,
  path: string,
  body: unknown,
  expectedCommand: string,
  validationIdentity: Readonly<{ clientId?: string; clientName?: string }> = {},
): Promise<Response> {
  const pending = rig.handle(jsonRequest(path, body, { authorization: `Bearer ${bearer}` }));
  const command = await pollCommand(rig.gateway, browserConnectionId);
  const { approval_token: approvalToken, ...browserInput } = body as Record<string, unknown>;
  expect(command).toMatchObject({ name: expectedCommand, input: browserInput });
  expect(command.input).not.toHaveProperty("approval_token");
  expect(JSON.stringify(command.input)).not.toContain(String(approvalToken));
  submitWorkspaceResult(rig.gateway, browserConnectionId, command.id, {
    ok: true,
    data: {
      client_id: validationIdentity.clientId ?? "rest-reconstruction-agent",
      client_name: validationIdentity.clientName ?? "REST Reconstruction Agent",
      workspace_id: WORKSPACE_ID,
    },
  });
  return pending;
}

async function connectMcp(rig: TestRig, connectionUrl: string): Promise<Client> {
  const client = new Client(
    { name: "reconstruction-gateway-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 2_000 } } },
  );
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(connectionUrl), {
    fetch: (input, init) => {
      const { signal: _signal, ...requestInit } = init ?? {};
      return rig.handle(new Request(input, requestInit));
    },
  }));
  return client;
}

async function approveMcp(
  rig: TestRig,
  client: Client,
  browserConnectionId: string,
  requestedScopes: readonly string[],
  grantedScopes: readonly string[],
  identity: Readonly<{ clientId?: string; clientName?: string }> = {
    clientId: "mcp-reconstruction-agent",
    clientName: "MCP Reconstruction Agent",
  },
) {
  const claim = await client.callTool({
    name: "get_workspace_instructions",
    arguments: {
      ...(identity.clientId ? { client_id: identity.clientId } : {}),
      client_name: identity.clientName ?? "MCP Reconstruction Agent",
      requested_scopes: requestedScopes,
    },
  });
  const claimError = (claim.structuredContent as {
    error: { details: { approval_token: string; claim_id: string } };
  }).error;
  rig.gateway.approveClaim(claimError.details.claim_id);
  const instructions = client.callTool({
    name: "get_workspace_instructions",
    arguments: { approval_token: claimError.details.approval_token },
  });
  const command = await pollCommand(rig.gateway, browserConnectionId);
  expect(command.name).toBe("get_workspace_instructions");
  submitWorkspaceResult(rig.gateway, browserConnectionId, command.id, {
    ok: true,
    data: {
      session_token: "session_mcp_reconstruction",
      guide_digest: "sha256:mcp-reconstruction-guide",
      granted_scopes: grantedScopes,
    },
  });
  const guide = await instructions;
  expect(guide.isError).toBe(false);
  return {
    session: Object.freeze({
      session_token: "session_mcp_reconstruction",
      instruction_digest: "sha256:mcp-reconstruction-guide",
    }),
    approvalToken: claimError.details.approval_token,
  };
}

async function mcpWithValidation(
  rig: TestRig,
  client: Client,
  browserConnectionId: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  validationIdentity: Readonly<{ clientId?: string; clientName?: string }> = {},
) {
  const pending = client.callTool({ name, arguments: argumentsValue });
  const command = await pollCommand(rig.gateway, browserConnectionId);
  expect(command).toMatchObject({ name, input: argumentsValue });
  submitWorkspaceResult(rig.gateway, browserConnectionId, command.id, {
    ok: true,
    data: {
      client_id: validationIdentity.clientId ?? "mcp-reconstruction-agent",
      client_name: validationIdentity.clientName ?? "MCP Reconstruction Agent",
      workspace_id: WORKSPACE_ID,
    },
  });
  return pending;
}

function toolPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(rigs.splice(0).map(({ handle }) => handle.close()));
  await Promise.allSettled(temporaryParents.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("photo reconstruction production Gateway integration", () => {
  it("runs the complete human browser route lifecycle while leaving candidate completion explicit", async () => {
    const rig = await setup();
    const config = await payload<{ csrfToken: string }>(await rig.handle(browserConfigRequest()));
    const capabilityWithoutOrigin = await rig.handle(jsonRequest(
      "/api/agent/reconstructions/capability",
      {},
      { "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN },
    ));
    expect(capabilityWithoutOrigin.status).toBe(403);
    expect(await payload(capabilityWithoutOrigin)).toMatchObject({ error: { code: "origin_required" } });
    const capabilityResponse = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/capability",
      {},
    );
    expect(capabilityResponse.status).toBe(200);
    expect(await payload(capabilityResponse)).toEqual({
      backend: rig.backend.identity,
      available: true,
    });

    const withoutCsrf = await rig.handle(jsonRequest(
      "/api/agent/reconstructions/begin",
      camelBegin("browser-reconstruction-no-csrf"),
      {
        origin: ORIGIN,
        "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN,
      },
    ));
    expect(withoutCsrf.status).toBe(403);

    const begunResponse = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/begin",
      camelBegin("browser-reconstruction-0001"),
    );
    expect(begunResponse.status).toBe(200);
    const begun = await payload<BeginPhotoReconstructionResult>(begunResponse);
    expect(begun).toMatchObject({
      job: {
        requestId: "browser-reconstruction-0001",
        workspaceId: WORKSPACE_ID,
        status: "awaiting_upload",
        uploadedPhotoCount: 0,
      },
      uploads: [{ method: "PUT" }, { method: "PUT" }],
    });
    expect(JSON.stringify(begun)).not.toMatch(/base64|local_path|file:\/\//iu);

    for (const grant of begun.uploads) {
      const uploaded = await uploadGrant(rig.handle, grant, true);
      expect(uploaded.status).toBe(200);
    }
    const started = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/start",
      { jobId: begun.job.jobId, workspaceId: WORKSPACE_ID },
    );
    expect(started.status).toBe(200);
    expect(await payload<PhotoReconstructionJobView>(started)).toMatchObject({
      jobId: begun.job.jobId,
      status: expect.stringMatching(/queued|camera_solving|training|packing|ready/u),
      uploadedPhotoCount: 2,
    });
    const ready = await waitForBrowserReady(rig.handle, config.csrfToken, begun.job.jobId);
    expect(ready).toMatchObject({
      result: { sha256: digest(OUTPUT), byteLength: OUTPUT.byteLength },
      registeredPhotoCount: 2,
    });
    expect(rig.backend.requests).toHaveLength(1);

    const finalized = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/finalize",
      {
        jobId: begun.job.jobId,
        workspaceId: WORKSPACE_ID,
        displayName: "Browser reconstructed room",
        expectedOutputSha256: digest(OUTPUT),
      },
    );
    expect(finalized.status).toBe(200);
    const candidate = await payload<{
      candidateHandle: string;
      sha256: string;
      byteLength: number;
    }>(finalized);
    expect(candidate).toMatchObject({ sha256: digest(OUTPUT), byteLength: OUTPUT.byteLength });

    // Finalize exposes only a staged candidate. The browser must still perform
    // the independent candidate preflight/vault/register completion boundary.
    const inspectCandidate = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/assets/candidates/inspect",
      { candidateHandle: candidate.candidateHandle, workspaceId: WORKSPACE_ID },
    );
    expect(inspectCandidate.status).toBe(200);
    expect(await payload(inspectCandidate)).toMatchObject({ status: "ready", sha256: digest(OUTPUT) });
    const opened = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/assets/candidates/open",
      { candidateHandle: candidate.candidateHandle, workspaceId: WORKSPACE_ID },
    );
    expect(Array.from(new Uint8Array(await opened.arrayBuffer()))).toEqual(Array.from(OUTPUT));
    const completed = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/assets/candidates/complete",
      { candidateHandle: candidate.candidateHandle, workspaceId: WORKSPACE_ID },
    );
    expect(await payload(completed)).toEqual({ completed: true });

    const cancelBegin = await payload<BeginPhotoReconstructionResult>(await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/begin",
      camelBegin("browser-reconstruction-cancel"),
    ));
    const cancelled = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/cancel",
      { jobId: cancelBegin.job.jobId, workspaceId: WORKSPACE_ID, confirm: true },
    );
    expect(cancelled.status).toBe(200);
    expect(await payload(cancelled)).toMatchObject({
      cancelled: true,
      job: { jobId: cancelBegin.job.jobId, status: "cancelled" },
    });
    const cancelledInspection = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/inspect",
      { jobId: cancelBegin.job.jobId, workspaceId: WORKSPACE_ID },
    );
    expect(await payload(cancelledInspection)).toMatchObject({ status: "cancelled" });
  });

  it("rejects REST reconstruction before service dispatch without an approved scoped claim or matching identity", async () => {
    const noClaimRig = await setup();
    noClaimRig.gateway.setEnabled(true);
    const noClaimReveal = noClaimRig.gateway.revealPairing();
    const noClaimBrowser = noClaimRig.gateway.registerBrowser("rest-reconstruction-no-claim-browser");
    const noClaimBegin = vi.spyOn(noClaimRig.service, "begin");
    const noClaim = await noClaimRig.handle(jsonRequest(
      "/v1/reconstructions/begin",
      { ...snakeBegin("rest-reconstruction-no-claim"), approval_token: "x".repeat(43) },
      { authorization: `Bearer ${noClaimReveal.pairingBearer}` },
    ));
    expect(noClaim.status).toBe(403);
    expect(await payload(noClaim)).toMatchObject({ error: { code: "instructions_required" } });
    expect(noClaimBegin).not.toHaveBeenCalled();
    expect(await noClaimRig.gateway.pollBrowser(noClaimBrowser.browserConnectionId)).toEqual({ kind: "idle" });

    const missingScopeRig = await setup();
    missingScopeRig.gateway.setEnabled(true);
    const missingScopeReveal = missingScopeRig.gateway.revealPairing();
    const missingScopeBrowser = missingScopeRig.gateway.registerBrowser("rest-reconstruction-missing-scope-browser");
    const missingScopeClient = await connectMcp(missingScopeRig, missingScopeReveal.connectionUrl);
    const missingScopeApproval = await approveMcp(
      missingScopeRig,
      missingScopeClient,
      missingScopeBrowser.browserConnectionId,
      ["workspace:read"],
      ["workspace:read"],
      { clientId: "rest-missing-scope-client", clientName: "REST Missing Scope Client" },
    );
    const missingScopeBegin = vi.spyOn(missingScopeRig.service, "begin");
    const missingScope = await missingScopeRig.handle(jsonRequest(
      "/v1/reconstructions/begin",
      {
        ...snakeBegin("rest-reconstruction-missing-scope"),
        approval_token: missingScopeApproval.approvalToken,
      },
      { authorization: `Bearer ${missingScopeReveal.pairingBearer}` },
    ));
    expect(missingScope.status).toBe(403);
    expect(await payload(missingScope)).toMatchObject({ error: { code: "authorization_scope_missing" } });
    expect(missingScopeBegin).not.toHaveBeenCalled();
    expect(await missingScopeRig.gateway.pollBrowser(missingScopeBrowser.browserConnectionId)).toEqual({ kind: "idle" });

    const approvedRig = await setup();
    approvedRig.gateway.setEnabled(true);
    const approvedReveal = approvedRig.gateway.revealPairing();
    const approvedBrowser = approvedRig.gateway.registerBrowser("rest-reconstruction-proof-browser");
    const approvedClient = await connectMcp(approvedRig, approvedReveal.connectionUrl);
    const approvedIdentity = { clientId: "rest-approved-client", clientName: "REST Approved Client" };
    const approved = await approveMcp(
      approvedRig,
      approvedClient,
      approvedBrowser.browserConnectionId,
      ["workspace:read", "asset:reconstruct"],
      ["workspace:read", "asset:reconstruct"],
      approvedIdentity,
    );
    const approvedBegin = vi.spyOn(approvedRig.service, "begin");
    const wrongToken = await approvedRig.handle(jsonRequest(
      "/v1/reconstructions/begin",
      { ...snakeBegin("rest-reconstruction-wrong-token"), approval_token: "z".repeat(43) },
      { authorization: `Bearer ${approvedReveal.pairingBearer}` },
    ));
    expect(wrongToken.status).toBe(403);
    expect(await payload(wrongToken)).toMatchObject({ error: { code: "approval_invalid" } });
    expect(approvedBegin).not.toHaveBeenCalled();
    expect(await approvedRig.gateway.pollBrowser(approvedBrowser.browserConnectionId)).toEqual({ kind: "idle" });

    const mismatchBody = {
      ...snakeBegin("rest-reconstruction-client-mismatch"),
      approval_token: approved.approvalToken,
    };
    const mismatchPending = approvedRig.handle(jsonRequest(
      "/v1/reconstructions/begin",
      mismatchBody,
      { authorization: `Bearer ${approvedReveal.pairingBearer}` },
    ));
    const mismatchCommand = await pollCommand(approvedRig.gateway, approvedBrowser.browserConnectionId);
    expect(mismatchCommand).toMatchObject({
      name: "begin_workspace_photo_reconstruction",
      input: Object.fromEntries(Object.entries(mismatchBody).filter(([key]) => key !== "approval_token")),
    });
    expect(mismatchCommand.input).not.toHaveProperty("approval_token");
    expect(JSON.stringify(mismatchCommand.input)).not.toContain(approved.approvalToken);
    submitWorkspaceResult(approvedRig.gateway, approvedBrowser.browserConnectionId, mismatchCommand.id, {
      ok: true,
      data: { client_id: "rest-mismatched-client", workspace_id: WORKSPACE_ID },
    });
    const mismatch = await mismatchPending;
    expect(mismatch.status).toBe(403);
    expect(await payload(mismatch)).toMatchObject({ error: { code: "approval_invalid" } });
    expect(approvedBegin).not.toHaveBeenCalled();
  });

  it("keeps approved Agent REST execution browser-owned and returns only the final browser completion", async () => {
    const rig = await setup();
    rig.gateway.setEnabled(true);
    const reveal = rig.gateway.revealPairing();
    const browser = rig.gateway.registerBrowser("rest-reconstruction-browser");
    const client = await connectMcp(rig, reveal.connectionUrl);
    const { approvalToken } = await approveMcp(
      rig,
      client,
      browser.browserConnectionId,
      ["workspace:read", "asset:reconstruct"],
      ["workspace:read", "asset:reconstruct"],
      { clientId: "rest-reconstruction-agent", clientName: "REST Reconstruction Agent" },
    );
    const beginSpy = vi.spyOn(rig.service, "begin");

    const beginResponse = await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/begin",
      { ...snakeBegin("rest-reconstruction-allowed"), approval_token: approvalToken },
      "begin_workspace_photo_reconstruction",
    );
    const beginEnvelope = await payload<{ ok: true; data: BeginPhotoReconstructionResult }>(beginResponse);
    expect(beginEnvelope.ok).toBe(true);
    expect(beginSpy).toHaveBeenCalledTimes(1);
    for (const grant of beginEnvelope.data.uploads) {
      expect((await uploadGrant(rig.handle, grant, false)).status).toBe(200);
    }

    const session = {
      session_token: "session_reconstruction_gateway",
      instruction_digest: "sha256:reconstruction-gateway-guide",
      workspace_id: WORKSPACE_ID,
      job_id: beginEnvelope.data.job.jobId,
      approval_token: approvalToken,
    };
    expect((await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/start",
      session,
      "start_workspace_photo_reconstruction",
    )).status).toBe(200);

    let ready: PhotoReconstructionJobView | undefined;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      const response = await restWithValidation(
        rig,
        reveal.pairingBearer,
        browser.browserConnectionId,
        "/v1/reconstructions/inspect",
        session,
        "inspect_workspace_photo_reconstruction",
      );
      const envelope = await payload<{ ok: true; data: PhotoReconstructionJobView }>(response);
      if (envelope.data.status === "ready") ready = envelope.data;
      else await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(ready?.result?.sha256).toBe(digest(OUTPUT));

    const finalInput = {
      ...session,
      display_name: "REST reconstructed room",
      expected_output_sha256: digest(OUTPUT),
    };
    const finalResponsePromise = rig.handle(jsonRequest(
      "/v1/reconstructions/finalize",
      finalInput,
      { authorization: `Bearer ${reveal.pairingBearer}` },
    ));
    const finalValidation = await pollCommand(rig.gateway, browser.browserConnectionId);
    expect(finalValidation).toMatchObject({
      name: "finalize_workspace_photo_reconstruction",
      input: Object.fromEntries(Object.entries(finalInput).filter(([key]) => key !== "approval_token")),
    });
    expect(finalValidation.input).not.toHaveProperty("approval_token");
    expect(JSON.stringify(finalValidation.input)).not.toContain(approvalToken);
    submitWorkspaceResult(rig.gateway, browser.browserConnectionId, finalValidation.id, {
      ok: true,
      data: { client_id: "rest-reconstruction-agent", workspace_id: WORKSPACE_ID },
    });

    const completionCommand = await pollCommand(rig.gateway, browser.browserConnectionId);
    expect(completionCommand).toMatchObject({
      name: "complete_workspace_reconstruction_asset",
      input: {
        candidate_handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        workspace_id: WORKSPACE_ID,
      },
    });
    const candidateHandle = String((completionCommand.input as Record<string, unknown>).candidate_handle);
    const opened = await rig.assetIngress.open(candidateHandle, WORKSPACE_ID);
    expect(opened.descriptor.sha256).toBe(digest(OUTPUT));
    await new Response(opened.body).arrayBuffer();
    await rig.assetIngress.complete(candidateHandle, WORKSPACE_ID);
    const authoritativeCompletion = {
      ok: true,
      data: {
        result: {
          asset_ref: { asset_id: `ra_${"a".repeat(64)}`, digest: digest(OUTPUT) },
          descriptor: { engineeringAuthority: "visual_only" },
        },
      },
    };
    submitWorkspaceResult(
      rig.gateway,
      browser.browserConnectionId,
      completionCommand.id,
      authoritativeCompletion,
    );
    const finalResponse = await finalResponsePromise;
    expect(finalResponse.status).toBe(200);
    expect(await payload(finalResponse)).toEqual(authoritativeCompletion);
    await expect(rig.assetIngress.inspect(candidateHandle, WORKSPACE_ID)).rejects.toMatchObject({ status: 404 });
  });

  it("binds REST jobs to the validated client across session renewal and rejects other clients", async () => {
    const backend = new FakePhotoBackend(true);
    const rig = await setup(backend);
    rig.gateway.setEnabled(true);
    const reveal = rig.gateway.revealPairing();
    const browser = rig.gateway.registerBrowser("rest-reconstruction-resume-browser");
    const stableClient = {
      clientId: "rest-stable-reconstruction-client",
      clientName: "Stable REST Reconstruction Client",
    };
    const client = await connectMcp(rig, reveal.connectionUrl);
    const { approvalToken } = await approveMcp(
      rig,
      client,
      browser.browserConnectionId,
      ["workspace:read", "asset:reconstruct"],
      ["workspace:read", "asset:reconstruct"],
      stableClient,
    );
    const begunResponse = await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/begin",
      { ...snakeBegin("rest-reconstruction-session-renewal"), approval_token: approvalToken },
      "begin_workspace_photo_reconstruction",
      stableClient,
    );
    const begun = (await payload<{ ok: true; data: BeginPhotoReconstructionResult }>(begunResponse)).data;
    for (const grant of begun.uploads) {
      expect((await uploadGrant(rig.handle, grant, false)).status).toBe(200);
    }

    const firstSessionJob = {
      session_token: "session_reconstruction_gateway",
      instruction_digest: "sha256:reconstruction-gateway-guide",
      workspace_id: WORKSPACE_ID,
      job_id: begun.job.jobId,
      approval_token: approvalToken,
    };
    expect((await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/start",
      firstSessionJob,
      "start_workspace_photo_reconstruction",
      stableClient,
    )).status).toBe(200);
    for (let attempt = 0; attempt < 20 && backend.requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(backend.requests).toHaveLength(1);

    const renewedSessionJob = {
      ...firstSessionJob,
      session_token: "session_reconstruction_gateway_renewed",
      instruction_digest: "sha256:reconstruction-gateway-guide-renewed",
    };
    const resumed = await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/inspect",
      renewedSessionJob,
      "inspect_workspace_photo_reconstruction",
      stableClient,
    );
    expect(resumed.status).toBe(200);
    expect(await payload(resumed)).toMatchObject({
      ok: true,
      data: {
        jobId: begun.job.jobId,
        status: expect.stringMatching(/queued|camera_solving|training|packing/u),
      },
    });

    const inspectSpy = vi.spyOn(rig.service, "inspect");
    const otherClient = await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/inspect",
      renewedSessionJob,
      "inspect_workspace_photo_reconstruction",
      { clientId: "different-rest-reconstruction-client" },
    );
    expect(otherClient.status).toBe(403);
    expect(await payload(otherClient)).toMatchObject({
      error: { code: "approval_invalid" },
    });
    expect(inspectSpy).not.toHaveBeenCalled();

    const cancelSpy = vi.spyOn(rig.service, "cancel");
    const unconfirmed = await rig.handle(jsonRequest(
      "/v1/reconstructions/cancel",
      { ...renewedSessionJob, confirm: false },
      { authorization: `Bearer ${reveal.pairingBearer}` },
    ));
    expect(unconfirmed.status).toBe(400);
    expect(await payload(unconfirmed)).toMatchObject({ error: { code: "invalid_request" } });
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await rig.gateway.pollBrowser(browser.browserConnectionId)).toEqual({ kind: "idle" });

    const cancelled = await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/cancel",
      { ...renewedSessionJob, confirm: true },
      "cancel_workspace_photo_reconstruction",
      stableClient,
    );
    expect(cancelled.status).toBe(200);
    expect(await payload(cancelled)).toMatchObject({
      ok: true,
      data: { cancelled: true, job: { jobId: begun.job.jobId, status: "cancelled" } },
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("resumes one client-owned REST reconstruction through MCP and keeps other clients isolated", async () => {
    const rig = await setup(new FakePhotoBackend(true));
    rig.gateway.setEnabled(true);
    const reveal = rig.gateway.revealPairing();
    const browser = rig.gateway.registerBrowser("cross-transport-reconstruction-browser");
    const stableClient = {
      clientId: "cross-transport-reconstruction-client",
      clientName: "Cross Transport Reconstruction Client",
    };
    const client = await connectMcp(rig, reveal.connectionUrl);
    const { session: mcpSession, approvalToken } = await approveMcp(
      rig,
      client,
      browser.browserConnectionId,
      ["workspace:read", "asset:reconstruct"],
      ["workspace:read", "asset:reconstruct"],
      stableClient,
    );
    const begunResponse = await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/begin",
      { ...snakeBegin("cross-transport-reconstruction-job"), approval_token: approvalToken },
      "begin_workspace_photo_reconstruction",
      stableClient,
    );
    const begun = (await payload<{ ok: true; data: BeginPhotoReconstructionResult }>(begunResponse)).data;
    for (const grant of begun.uploads) {
      expect((await uploadGrant(rig.handle, grant, false)).status).toBe(200);
    }
    const restJob = {
      session_token: "session_reconstruction_gateway",
      instruction_digest: "sha256:reconstruction-gateway-guide",
      workspace_id: WORKSPACE_ID,
      job_id: begun.job.jobId,
      approval_token: approvalToken,
    };
    await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/start",
      restJob,
      "start_workspace_photo_reconstruction",
      stableClient,
    );
    const otherClient = await restWithValidation(
      rig,
      reveal.pairingBearer,
      browser.browserConnectionId,
      "/v1/reconstructions/inspect",
      restJob,
      "inspect_workspace_photo_reconstruction",
      { clientId: "cross-transport-intruder" },
    );
    expect(otherClient.status).toBe(403);
    expect(await payload(otherClient)).toMatchObject({ error: { code: "approval_invalid" } });
    const mcpJob = {
      ...mcpSession,
      workspace_id: WORKSPACE_ID,
      job_id: begun.job.jobId,
    };
    const inspected = toolPayload(await mcpWithValidation(
      rig,
      client,
      browser.browserConnectionId,
      "inspect_workspace_photo_reconstruction",
      mcpJob,
      stableClient,
    ));
    expect(inspected).toMatchObject({
      ok: true,
      data: {
        jobId: begun.job.jobId,
        status: expect.stringMatching(/queued|camera_solving|training|packing/u),
      },
    });
    const cancelled = toolPayload(await mcpWithValidation(
      rig,
      client,
      browser.browserConnectionId,
      "cancel_workspace_photo_reconstruction",
      { ...mcpJob, confirm: true },
      stableClient,
    ));
    expect(cancelled).toMatchObject({
      ok: true,
      data: { cancelled: true, job: { jobId: begun.job.jobId, status: "cancelled" } },
    });
  });

  it("revokes external reconstruction jobs on pairing rotation without destroying a human browser job", async () => {
    const rig = await setup();
    const config = await payload<{ csrfToken: string }>(await rig.handle(browserConfigRequest()));
    expect((await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/browser/enable",
      {},
    )).status).toBe(200);
    const humanJob = await payload<BeginPhotoReconstructionResult>(await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/begin",
      camelBegin("browser-reconstruction-rotate-retain"),
    ));
    for (const grant of humanJob.uploads) {
      expect((await uploadGrant(rig.handle, grant, true)).status).toBe(200);
    }
    expect((await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/start",
      { jobId: humanJob.job.jobId, workspaceId: WORKSPACE_ID },
    )).status).toBe(200);
    const readyHumanJob = await waitForBrowserReady(
      rig.handle,
      config.csrfToken,
      humanJob.job.jobId,
    );
    const externalPrincipal = { authorizationId: "external-reconstruction-before-rotate" };
    const externalJob = await rig.service.begin(
      externalPrincipal,
      camelBegin("external-reconstruction-rotate-revoke"),
    );
    expect((await uploadGrant(rig.handle, externalJob.uploads[0]!, false)).status).toBe(200);
    const revokeAll = vi.spyOn(rig.service, "revokeAllExceptAuthorization");

    const rotated = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/browser/rotate",
      {},
    );
    expect(rotated.status).toBe(200);
    expect(revokeAll).toHaveBeenCalledTimes(1);

    const retainedHumanJob = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/inspect",
      { jobId: humanJob.job.jobId, workspaceId: WORKSPACE_ID },
    );
    expect(retainedHumanJob.status).toBe(200);
    expect(await payload(retainedHumanJob)).toMatchObject({
      jobId: humanJob.job.jobId,
      status: "ready",
      result: { sha256: digest(OUTPUT) },
    });

    const finalizedHuman = await payload<{ candidateHandle: string }>(await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/reconstructions/finalize",
      {
        jobId: humanJob.job.jobId,
        workspaceId: WORKSPACE_ID,
        displayName: "Retained browser reconstruction",
        expectedOutputSha256: readyHumanJob.result!.sha256,
      },
    ));
    const openedHuman = await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/assets/candidates/open",
      { candidateHandle: finalizedHuman.candidateHandle, workspaceId: WORKSPACE_ID },
    );
    expect(Array.from(new Uint8Array(await openedHuman.arrayBuffer()))).toEqual(Array.from(OUTPUT));
    expect(await payload(await browserPost(
      rig.handle,
      config.csrfToken,
      "/api/agent/assets/candidates/complete",
      { candidateHandle: finalizedHuman.candidateHandle, workspaceId: WORKSPACE_ID },
    ))).toEqual({ completed: true });

    await expect(rig.service.inspect(
      externalJob.job.jobId,
      externalPrincipal.authorizationId,
      WORKSPACE_ID,
    )).rejects.toMatchObject({ code: "photo_reconstruction_not_found" });

    // Both the external job's already-written temporary input and not-yet-used
    // capability become unreachable after rotation.
    const uploadedInputRetry = await uploadGrant(rig.handle, externalJob.uploads[0]!, false);
    expect(uploadedInputRetry.status).toBe(404);
    expect(await payload(uploadedInputRetry)).toMatchObject({
      error: { code: "photo_upload_not_found" },
    });
    const unusedGrant = await uploadGrant(rig.handle, externalJob.uploads[1]!, false);
    expect(unusedGrant.status).toBe(404);
    expect(await payload(unusedGrant)).toMatchObject({
      error: { code: "photo_upload_not_found" },
    });
    expect(rig.backend.requests).toHaveLength(1);
  });

  it("rejects MCP reconstruction after validation when the approved claim omitted the non-default scope", async () => {
    const rig = await setup();
    rig.gateway.setEnabled(true);
    const reveal = rig.gateway.revealPairing();
    const browser = rig.gateway.registerBrowser("mcp-reconstruction-denied-browser");
    const client = await connectMcp(rig, reveal.connectionUrl);
    const { session } = await approveMcp(
      rig,
      client,
      browser.browserConnectionId,
      ["workspace:read"],
      ["workspace:read"],
    );
    const beginSpy = vi.spyOn(rig.service, "begin");
    const resultPromise = client.callTool({
      name: "begin_workspace_photo_reconstruction",
      arguments: { ...session, ...snakeBegin("mcp-reconstruction-no-scope") },
    });
    const validation = await pollCommand(rig.gateway, browser.browserConnectionId);
    expect(validation.name).toBe("begin_workspace_photo_reconstruction");
    submitWorkspaceResult(rig.gateway, browser.browserConnectionId, validation.id, {
      ok: true,
      data: { client_id: "mcp-reconstruction-agent", workspace_id: WORKSPACE_ID },
    });
    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(toolPayload(result)).toMatchObject({
      ok: false,
      error: { code: "authorization_scope_missing" },
    });
    expect(beginSpy).not.toHaveBeenCalled();
  });

  it("rejects MCP reconstruction when the approved claim omitted a stable client_id", async () => {
    const rig = await setup();
    rig.gateway.setEnabled(true);
    const reveal = rig.gateway.revealPairing();
    const browser = rig.gateway.registerBrowser("mcp-reconstruction-no-client-id-browser");
    const client = await connectMcp(rig, reveal.connectionUrl);
    const { session } = await approveMcp(
      rig,
      client,
      browser.browserConnectionId,
      ["workspace:read", "asset:reconstruct"],
      ["workspace:read", "asset:reconstruct"],
      { clientName: "MCP Reconstruction Agent Without Stable ID" },
    );
    const beginSpy = vi.spyOn(rig.service, "begin");
    const resultPromise = client.callTool({
      name: "begin_workspace_photo_reconstruction",
      arguments: { ...session, ...snakeBegin("mcp-reconstruction-no-client-id") },
    });
    const validation = await pollCommand(rig.gateway, browser.browserConnectionId);
    expect(validation.name).toBe("begin_workspace_photo_reconstruction");
    submitWorkspaceResult(rig.gateway, browser.browserConnectionId, validation.id, {
      ok: true,
      data: { client_id: "browser-invented-client-id", workspace_id: WORKSPACE_ID },
    });
    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(toolPayload(result)).toMatchObject({ ok: false, error: { code: "invalid_response" } });
    expect(beginSpy).not.toHaveBeenCalled();
  });

  it("routes all MCP reconstruction hooks and delegates final registration back to the browser", async () => {
    const rig = await setup();
    rig.gateway.setEnabled(true);
    const reveal = rig.gateway.revealPairing();
    const browser = rig.gateway.registerBrowser("mcp-reconstruction-browser");
    const client = await connectMcp(rig, reveal.connectionUrl);
    const { session } = await approveMcp(
      rig,
      client,
      browser.browserConnectionId,
      ["workspace:read", "asset:reconstruct"],
      ["workspace:read", "asset:reconstruct"],
    );

    const beginInput = { ...session, ...snakeBegin("mcp-reconstruction-allowed") };
    const beginCall = await mcpWithValidation(
      rig,
      client,
      browser.browserConnectionId,
      "begin_workspace_photo_reconstruction",
      beginInput,
    );
    const beginResult = toolPayload(beginCall);
    expect(beginResult.ok).toBe(true);
    const begun = beginResult.data as BeginPhotoReconstructionResult;
    expect(begun.uploads).toHaveLength(2);
    expect(begun.uploads.every(({ token, url }) => token.length > 0 && url.startsWith(PUBLIC_URL))).toBe(true);
    const beginText = beginCall.content
      .map((item) => item.type === "text" ? item.text : "")
      .join("\n");
    expect(beginText).toContain("redacted_from_text_use_structuredContent");
    for (const grant of begun.uploads) {
      expect(beginText).not.toContain(grant.token);
      expect(beginText).not.toContain(grant.url);
    }
    for (const grant of begun.uploads) {
      expect((await uploadGrant(rig.handle, grant, false)).status).toBe(200);
    }

    const jobInput = {
      ...session,
      workspace_id: WORKSPACE_ID,
      job_id: begun.job.jobId,
    };
    expect(toolPayload(await mcpWithValidation(
      rig,
      client,
      browser.browserConnectionId,
      "start_workspace_photo_reconstruction",
      jobInput,
    ))).toMatchObject({ ok: true });

    let ready: PhotoReconstructionJobView | undefined;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      const inspected = toolPayload(await mcpWithValidation(
        rig,
        client,
        browser.browserConnectionId,
        "inspect_workspace_photo_reconstruction",
        jobInput,
      ));
      const job = inspected.data as PhotoReconstructionJobView;
      if (job.status === "ready") ready = job;
      else await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(ready?.result?.sha256).toBe(digest(OUTPUT));

    const finalizeInput = {
      ...jobInput,
      display_name: "MCP reconstructed room",
      expected_output_sha256: digest(OUTPUT),
    };
    const finalizedPromise = client.callTool({
      name: "finalize_workspace_photo_reconstruction",
      arguments: finalizeInput,
    });
    const finalValidation = await pollCommand(rig.gateway, browser.browserConnectionId);
    expect(finalValidation.name).toBe("finalize_workspace_photo_reconstruction");
    submitWorkspaceResult(rig.gateway, browser.browserConnectionId, finalValidation.id, {
      ok: true,
      data: { client_id: "mcp-reconstruction-agent", workspace_id: WORKSPACE_ID },
    });
    const completion = await pollCommand(rig.gateway, browser.browserConnectionId);
    expect(completion).toMatchObject({
      name: "complete_workspace_reconstruction_asset",
      input: {
        candidate_handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        workspace_id: WORKSPACE_ID,
      },
    });
    const candidateHandle = String((completion.input as Record<string, unknown>).candidate_handle);
    const opened = await rig.assetIngress.open(candidateHandle, WORKSPACE_ID);
    await new Response(opened.body).arrayBuffer();
    await rig.assetIngress.complete(candidateHandle, WORKSPACE_ID);
    const authoritative = {
      ok: true,
      data: {
        result: {
          asset_ref: { asset_id: `ra_${"b".repeat(64)}`, digest: digest(OUTPUT) },
          descriptor: { engineeringAuthority: "visual_only" },
        },
      },
    };
    submitWorkspaceResult(rig.gateway, browser.browserConnectionId, completion.id, authoritative);
    expect(toolPayload(await finalizedPromise)).toEqual(authoritative);

    const cancelBeginInput = { ...session, ...snakeBegin("mcp-reconstruction-cancel") };
    const cancelBegin = toolPayload(await mcpWithValidation(
      rig,
      client,
      browser.browserConnectionId,
      "begin_workspace_photo_reconstruction",
      cancelBeginInput,
    ));
    const cancelJob = (cancelBegin.data as BeginPhotoReconstructionResult).job;
    const cancelled = toolPayload(await mcpWithValidation(
      rig,
      client,
      browser.browserConnectionId,
      "cancel_workspace_photo_reconstruction",
      {
        ...session,
        workspace_id: WORKSPACE_ID,
        job_id: cancelJob.jobId,
        confirm: true,
      },
    ));
    expect(cancelled).toMatchObject({ ok: true, data: { cancelled: true, job: { status: "cancelled" } } });
  });
});
