import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAssetIngress } from "../../../server/agent/AgentAssetIngress";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import {
  createAgentGatewayHttpHandler,
  createNodeAgentGatewayHttpHandler,
  type AgentGatewayFetchHandler,
  type AgentGatewayNodeHandler,
  type NodeResponseLike,
} from "../../../server/agent/AgentGatewayHttpHandler";

const PUBLIC_URL = "http://127.0.0.1:8788";
const ORIGIN = "http://127.0.0.1:4173";
const BROWSER_BOOTSTRAP_TOKEN = "b".repeat(43);

const gateways: AgentGateway[] = [];
const handlers: AgentGatewayFetchHandler[] = [];
const nodeHandlers: AgentGatewayNodeHandler[] = [];
const temporaryParents: string[] = [];

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonRequest(path: string, value: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function setup() {
  const temporaryParent = await mkdtemp(join(tmpdir(), "semaframe-asset-http-test-"));
  temporaryParents.push(temporaryParent);
  const gateway = new AgentGateway({
    publicBaseUrl: PUBLIC_URL,
    workspaceRoot: "/workspace/SemaFrame",
    commandTimeoutMs: 1_000,
    pollTimeoutMs: 10,
    browserTtlMs: 5_000,
  });
  const assetIngress = new AgentAssetIngress({
    publicBaseUrl: PUBLIC_URL,
    temporaryDirectory: temporaryParent,
    sweepIntervalMs: 0,
    maxBytes: 1_024,
  });
  const handle = createAgentGatewayHttpHandler(gateway, {
    allowedOrigins: [ORIGIN],
    publicBaseUrl: PUBLIC_URL,
    browserBootstrapToken: BROWSER_BOOTSTRAP_TOKEN,
    assetIngress,
  });
  gateways.push(gateway);
  handlers.push(handle);
  return { gateway, handle };
}

async function approveAssetImporter(
  gateway: AgentGateway,
  grantedScopes: readonly string[] = ["workspace:read", "asset:import"],
): Promise<{
  bearer: string;
  csrfToken: string;
  browserConnectionId: string;
  sessionToken: string;
  instructionDigest: string;
}> {
  gateway.setEnabled(true);
  const reveal = gateway.revealPairing();
  const pathname = new URL(reveal.connectionUrl).pathname;
  const registration = gateway.registerBrowser("browser-asset-http-test");
  const claim = await gateway.dispatchOffer(pathname, "get_workspace_instructions", {
    client_id: "asset-import-agent",
    client_name: "Asset Import Agent",
    requested_scopes: ["workspace:read", "asset:import"],
  }, { clientId: "asset-import-agent", clientName: "Asset Import Agent" });
  const claimPayload = claim.payload as {
    error: { details: { approval_token: string; claim_id: string } };
  };
  gateway.approveClaim(claimPayload.error.details.claim_id);

  const instructions = gateway.dispatchOffer(pathname, "get_workspace_instructions", {
    approval_token: claimPayload.error.details.approval_token,
  }, { clientId: "asset-import-agent", clientName: "Asset Import Agent" });
  let polled = await gateway.pollBrowser(registration.browserConnectionId);
  if (polled.kind === "idle") polled = await gateway.pollBrowser(registration.browserConnectionId);
  if (polled.kind !== "command") throw new Error("Expected the approved instruction command.");
  gateway.submitBrowserResult({
    browserConnectionId: registration.browserConnectionId,
    commandId: polled.command.id,
    ok: true,
    result: {
      ok: true,
      data: {
        session_token: "session_asset_http",
        guide_digest: "sha256:asset-guide",
        granted_scopes: grantedScopes,
      },
    },
  });
  await instructions;
  return {
    bearer: reveal.pairingBearer,
    csrfToken: gateway.csrfToken,
    browserConnectionId: registration.browserConnectionId,
    sessionToken: "session_asset_http",
    instructionDigest: "sha256:asset-guide",
  };
}

async function completeBrowserValidation(
  gateway: AgentGateway,
  browserConnectionId: string,
  responsePromise: Promise<Response>,
): Promise<Response> {
  let polled = await gateway.pollBrowser(browserConnectionId);
  for (let attempt = 0; polled.kind === "idle" && attempt < 4; attempt += 1) {
    polled = await gateway.pollBrowser(browserConnectionId);
  }
  if (polled.kind !== "command") throw new Error("Expected a browser validation command.");
  gateway.submitBrowserResult({
    browserConnectionId,
    commandId: polled.command.id,
    ok: true,
    result: {
      ok: true,
      data: {
        client_id: "asset-import-agent",
        client_name: "Asset Import Agent",
        workspace_id: "workspace_main",
      },
    },
  });
  return responsePromise;
}

afterEach(async () => {
  await Promise.allSettled(handlers.splice(0).map((handler) => handler.close()));
  await Promise.allSettled(nodeHandlers.splice(0).map((handler) => handler.close()));
  gateways.splice(0).forEach((gateway) => gateway.close());
  await Promise.allSettled(temporaryParents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
});

describe("Agent asset ingress HTTP boundary", () => {
  it("binds stdio/REST imports to the validated Workspace session without borrowing an offer claim", async () => {
    const { gateway, handle } = await setup();
    gateway.setEnabled(true);
    const pairing = gateway.revealPairing();
    const browser = gateway.registerBrowser("browser-stdio-asset-test");
    const sessionInput = {
      session_token: "session_stdio_asset",
      instruction_digest: "sha256:stdio-asset-guide",
    };
    const pairingOnly = await handle(jsonRequest("/v1/assets/imports/begin", {
      request_id: "asset-pairing-only-01",
      workspace_id: "workspace_main",
      display_name: "pairing-only.ply",
      format: "ply",
      media_type: "application/ply",
      byte_length: 4,
      sha256: `sha256:${"c".repeat(64)}`,
    }, { authorization: `Bearer ${pairing.pairingBearer}` }));
    expect(pairingOnly.status).toBe(400);

    const beginPromise = handle(jsonRequest("/v1/assets/imports/begin", {
      ...sessionInput,
      request_id: "asset-stdio-request-01",
      workspace_id: "workspace_main",
      display_name: "stdio.ply",
      format: "ply",
      media_type: "application/ply",
      byte_length: 4,
      sha256: `sha256:${"a".repeat(64)}`,
    }, { authorization: `Bearer ${pairing.pairingBearer}` }));
    const beginCommand = await gateway.pollBrowser(browser.browserConnectionId);
    expect(beginCommand).toMatchObject({
      kind: "command",
      command: { name: "begin_workspace_asset_import" },
    });
    if (beginCommand.kind !== "command") throw new Error("Expected begin validation command.");
    gateway.submitBrowserResult({
      browserConnectionId: browser.browserConnectionId,
      commandId: beginCommand.command.id,
      ok: true,
      result: {
        ok: true,
        data: {
          client_id: "stdio-asset-client",
          client_name: "Stdio Asset Client",
          workspace_id: "workspace_main",
        },
      },
    });
    const begin = await beginPromise;
    expect(begin.status).toBe(200);
    const beginResult = await json(begin) as {
      ok: true;
      data: { candidate_handle: string };
    };
    expect(beginResult).toMatchObject({ ok: true, data: { candidate_handle: expect.any(String) } });

    const cancelPromise = handle(jsonRequest("/v1/assets/imports/cancel", {
      ...sessionInput,
      candidate_handle: beginResult.data.candidate_handle,
    }, { authorization: `Bearer ${pairing.pairingBearer}` }));
    const cancelCommand = await gateway.pollBrowser(browser.browserConnectionId);
    expect(cancelCommand).toMatchObject({
      kind: "command",
      command: { name: "cancel_workspace_asset_import" },
    });
    if (cancelCommand.kind !== "command") throw new Error("Expected cancel validation command.");
    gateway.submitBrowserResult({
      browserConnectionId: browser.browserConnectionId,
      commandId: cancelCommand.command.id,
      ok: true,
      result: {
        ok: true,
        data: {
          client_id: "stdio-asset-client",
          client_name: "Stdio Asset Client",
          workspace_id: "workspace_main",
        },
      },
    });
    const cancelled = await cancelPromise;
    expect(cancelled.status).toBe(200);
    expect(await json(cancelled)).toEqual({ ok: true, data: { cancelled: true } });
  });

  it("fails closed when asset:import was requested and approved but the browser core did not grant it", async () => {
    const { gateway, handle } = await setup();
    const connection = await approveAssetImporter(gateway, ["workspace:read"]);
    const responsePromise = handle(jsonRequest("/v1/assets/imports/begin", {
      session_token: connection.sessionToken,
      instruction_digest: connection.instructionDigest,
      request_id: "asset-scope-denied-01",
      workspace_id: "workspace_main",
      display_name: "denied.spz",
      format: "spz",
      media_type: "model/spz",
      byte_length: 4,
      sha256: `sha256:${"0".repeat(64)}`,
    }, { authorization: `Bearer ${connection.bearer}` }));
    let polled = await gateway.pollBrowser(connection.browserConnectionId);
    for (let attempt = 0; polled.kind === "idle" && attempt < 4; attempt += 1) {
      polled = await gateway.pollBrowser(connection.browserConnectionId);
    }
    expect(polled).toMatchObject({ kind: "command", command: { name: "begin_workspace_asset_import" } });
    if (polled.kind !== "command") throw new Error("Expected asset-import validation command.");
    gateway.submitBrowserResult({
      browserConnectionId: connection.browserConnectionId,
      commandId: polled.command.id,
      ok: true,
      result: {
        ok: false,
        error: {
          code: "insufficient_scope",
          message: "The Agent session does not include asset:import.",
          retryable: false,
        },
      },
    });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: false, error: { code: "insufficient_scope" } });
  });

  it("requires a claim-bound scope, streams without JSON/base64, and hands an opaque candidate to the browser", async () => {
    const { gateway, handle } = await setup();
    const connection = await approveAssetImporter(gateway);
    const bytes = new Uint8Array([0x53, 0x50, 0x5a, 0x04]);
    const beginPromise = handle(jsonRequest("/v1/assets/imports/begin", {
      session_token: connection.sessionToken,
      instruction_digest: connection.instructionDigest,
      request_id: "asset-http-request-01",
      workspace_id: "workspace_main",
      display_name: "pole.spz",
      format: "spz",
      media_type: "model/spz",
      byte_length: bytes.byteLength,
      sha256: sha256(bytes),
    }, { authorization: `Bearer ${connection.bearer}` }));
    const begin = await completeBrowserValidation(gateway, connection.browserConnectionId, beginPromise);
    expect(begin.status).toBe(200);
    const beginResult = await json(begin) as {
      ok: true;
      data: {
      candidate_handle: string;
      status: string;
      upload: { url: string; token: string; content_type: string; content_length: number };
      };
    };
    expect(beginResult.ok).toBe(true);
    const grant = beginResult.data;
    expect(grant).toEqual(expect.objectContaining({
      candidate_handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      status: "awaiting_upload",
    }));
    expect(JSON.stringify(grant)).not.toMatch(/base64|local_path|file:\/\//iu);

    const querySmuggling = await handle(new Request(`${grant.upload.url}?token=${grant.upload.token}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${grant.upload.token}`,
        "content-type": grant.upload.content_type,
        "content-length": String(grant.upload.content_length),
      },
      body: bytes,
    }));
    expect(querySmuggling.status).toBe(404);

    const uploaded = await handle(new Request(grant.upload.url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${grant.upload.token}`,
        "content-type": grant.upload.content_type,
        "content-length": String(grant.upload.content_length),
      },
      body: bytes,
    }));
    expect(uploaded.status).toBe(200);
    expect(await json(uploaded)).toEqual(expect.objectContaining({
      candidate_handle: grant.candidate_handle,
      status: "ready",
      sha256: sha256(bytes),
    }));

    const browserHeaders = {
      origin: ORIGIN,
      "x-semaframe-agent-csrf": connection.csrfToken,
      "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN,
    };
    const inspect = await handle(jsonRequest("/api/agent/assets/candidates/inspect", {
      candidateHandle: grant.candidate_handle,
      workspaceId: "workspace_main",
    }, browserHeaders));
    expect(inspect.status).toBe(200);
    expect(await json(inspect)).toEqual(expect.objectContaining({
      candidateHandle: grant.candidate_handle,
      status: "ready",
    }));

    const opened = await handle(jsonRequest("/api/agent/assets/candidates/open", {
      candidateHandle: grant.candidate_handle,
      workspaceId: "workspace_main",
    }, browserHeaders));
    expect(opened.headers.get("x-semaframe-asset-digest")).toBe(sha256(bytes));
    expect(Array.from(new Uint8Array(await opened.arrayBuffer()))).toEqual(Array.from(bytes));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const completed = await handle(jsonRequest("/api/agent/assets/candidates/complete", {
      candidateHandle: grant.candidate_handle,
      workspaceId: "workspace_main",
    }, browserHeaders));
    expect(completed.status).toBe(200);
    expect(await json(completed)).toEqual({ completed: true });
  });

  it("bypasses the JSON wrapper cap only for the exact streaming upload route", async () => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "semaframe-asset-node-http-test-"));
    temporaryParents.push(temporaryParent);
    const gateway = new AgentGateway({
      publicBaseUrl: PUBLIC_URL,
      workspaceRoot: "/workspace/SemaFrame",
      commandTimeoutMs: 1_000,
      pollTimeoutMs: 10,
      browserTtlMs: 5_000,
    });
    gateways.push(gateway);
    const assetIngress = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: temporaryParent,
      sweepIntervalMs: 0,
      maxBytes: 2_048,
    });
    const bytes = new Uint8Array(1_024).map((_, index) => index % 251);
    const grant = await assetIngress.begin({ authorizationId: "node-stream-test-claim" }, {
      requestId: "asset-node-stream-01",
      workspaceId: "workspace_main",
      displayName: "large-for-json-cap.spz",
      format: "spz",
      mediaType: "model/spz",
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
    const handler = createNodeAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
      browserBootstrapToken: BROWSER_BOOTSTRAP_TOKEN,
      bodyLimitBytes: 32,
      assetIngress,
    });
    nodeHandlers.push(handler);

    const responseChunks: Uint8Array[] = [];
    const responseHeaders = new Map<string, string>();
    const response: NodeResponseLike = {
      statusCode: 0,
      setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); },
      write(value) { responseChunks.push(typeof value === "string" ? new TextEncoder().encode(value) : value); return true; },
      end(value) { if (value) responseChunks.push(new TextEncoder().encode(value)); this.writableEnded = true; },
    };
    await handler({
      method: "PUT",
      url: new URL(grant.upload!.url).pathname,
      headers: {
        authorization: `Bearer ${grant.upload!.token}`,
        "content-type": "model/spz",
        "content-length": String(bytes.byteLength),
      },
      async *[Symbol.asyncIterator]() {
        yield bytes.slice(0, 600);
        yield bytes.slice(600);
      },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(responseHeaders.get("content-type")).toContain("application/json");
    const responseBody = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(responseChunks.flatMap((chunk) => Array.from(chunk))),
    )) as Record<string, unknown>;
    expect(responseBody).toEqual(expect.objectContaining({ status: "ready", sha256: sha256(bytes) }));
  });

  it("cancels the candidate reader when a browser disconnects during the Node response stream", async () => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "semaframe-asset-node-close-test-"));
    temporaryParents.push(temporaryParent);
    const gateway = new AgentGateway({
      publicBaseUrl: PUBLIC_URL,
      workspaceRoot: "/workspace/SemaFrame",
      commandTimeoutMs: 1_000,
      pollTimeoutMs: 10,
      browserTtlMs: 5_000,
    });
    gateways.push(gateway);
    const assetIngress = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: temporaryParent,
      sweepIntervalMs: 0,
      maxBytes: 1_048_576,
    });
    const bytes = new Uint8Array(700_000).map((_, index) => index % 251);
    const grant = await assetIngress.begin({ authorizationId: "node-close-test-claim" }, {
      requestId: "asset-node-close-01",
      workspaceId: "workspace_main",
      displayName: "disconnect.ply",
      format: "ply",
      mediaType: "application/ply",
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
    await assetIngress.upload(
      new URL(grant.upload!.url).pathname.split("/").at(-1)!,
      grant.upload!.token,
      grant.upload!.contentType,
      bytes.byteLength,
      { async *[Symbol.asyncIterator]() { yield bytes; } },
    );
    const handler = createNodeAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
      browserBootstrapToken: BROWSER_BOOTSTRAP_TOKEN,
      assetIngress,
    });
    nodeHandlers.push(handler);

    const requestBody = new TextEncoder().encode(JSON.stringify({
      candidateHandle: grant.candidateHandle,
      workspaceId: "workspace_main",
    }));
    const response: NodeResponseLike = {
      statusCode: 0,
      destroyed: false,
      setHeader() {},
      write() {
        this.destroyed = true;
        return false;
      },
      end() { this.writableEnded = true; },
    };
    await handler({
      method: "POST",
      url: "/api/agent/assets/candidates/open",
      headers: {
        origin: ORIGIN,
        "x-semaframe-agent-csrf": gateway.csrfToken,
        "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN,
        "content-type": "application/json",
        "content-length": String(requestBody.byteLength),
      },
      async *[Symbol.asyncIterator]() { yield requestBody; },
    }, response);

    await expect(assetIngress.complete(grant.candidateHandle, "workspace_main"))
      .resolves.toEqual({ completed: true });
  });

  it("honors Node response backpressure before pulling and writing the next candidate chunk", async () => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "semaframe-asset-node-drain-test-"));
    temporaryParents.push(temporaryParent);
    const gateway = new AgentGateway({
      publicBaseUrl: PUBLIC_URL,
      workspaceRoot: "/workspace/SemaFrame",
      commandTimeoutMs: 1_000,
      pollTimeoutMs: 10,
      browserTtlMs: 5_000,
    });
    gateways.push(gateway);
    const assetIngress = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: temporaryParent,
      sweepIntervalMs: 0,
      maxBytes: 1_048_576,
    });
    const bytes = new Uint8Array(700_000).map((_, index) => index % 251);
    const grant = await assetIngress.begin({ authorizationId: "node-drain-test-claim" }, {
      requestId: "asset-node-drain-01",
      workspaceId: "workspace_main",
      displayName: "backpressure.ply",
      format: "ply",
      mediaType: "application/ply",
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
    await assetIngress.upload(
      new URL(grant.upload!.url).pathname.split("/").at(-1)!,
      grant.upload!.token,
      grant.upload!.contentType,
      bytes.byteLength,
      { async *[Symbol.asyncIterator]() { yield bytes; } },
    );
    const handler = createNodeAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
      browserBootstrapToken: BROWSER_BOOTSTRAP_TOKEN,
      assetIngress,
    });
    nodeHandlers.push(handler);

    const requestBody = new TextEncoder().encode(JSON.stringify({
      candidateHandle: grant.candidateHandle,
      workspaceId: "workspace_main",
    }));
    const listeners = {
      close: new Set<() => void>(),
      drain: new Set<() => void>(),
    };
    let writes = 0;
    const response: NodeResponseLike = {
      statusCode: 0,
      setHeader() {},
      write() {
        writes += 1;
        return writes !== 1;
      },
      end() { this.writableEnded = true; },
      on(event, listener) { listeners[event].add(listener); },
      off(event, listener) { listeners[event].delete(listener); },
    };
    const handling = handler({
      method: "POST",
      url: "/api/agent/assets/candidates/open",
      headers: {
        origin: ORIGIN,
        "x-semaframe-agent-csrf": gateway.csrfToken,
        "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN,
        "content-type": "application/json",
        "content-length": String(requestBody.byteLength),
      },
      async *[Symbol.asyncIterator]() { yield requestBody; },
    }, response);

    for (let attempt = 0; writes === 0 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(writes).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writes).toBe(1);
    for (const listener of [...listeners.drain]) listener();
    await handling;
    expect(writes).toBeGreaterThan(1);
    await expect(assetIngress.complete(grant.candidateHandle, "workspace_main"))
      .resolves.toEqual({ completed: true });
  });
});
