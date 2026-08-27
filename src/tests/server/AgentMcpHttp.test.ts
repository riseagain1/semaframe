import {
  Client,
  StreamableHTTPClientTransport,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import {
  createAgentGatewayHttpHandler,
  type AgentGatewayFetchHandler,
} from "../../../server/agent/AgentGatewayHttpHandler";
import { resolveAgentGatewayNetworkConfig } from "../../../server/agent/AgentGatewayNetworkConfig";

const ORIGIN = "http://127.0.0.1:4173";
const PUBLIC_URL = "http://127.0.0.1:8788";
const BROWSER_BOOTSTRAP_TOKEN = "b".repeat(43);
const expectedTools = [
  "begin_workspace_asset_import",
  "begin_workspace_photo_reconstruction",
  "begin_workspace_update",
  "cancel_workspace_asset_import",
  "cancel_workspace_photo_reconstruction",
  "complete_workspace_asset_import",
  "finalize_workspace_photo_reconstruction",
  "get_live_xr_context",
  "get_workspace_instructions",
  "inspect_voice_relay",
  "inspect_workspace",
  "inspect_workspace_asset",
  "inspect_workspace_component",
  "inspect_workspace_model",
  "inspect_workspace_photo_reconstruction",
  "inspect_workspace_physics",
  "inspect_workspace_space",
  "inspect_xr_readiness",
  "prepare_voice_relay_setup",
  "prepare_xr_session",
  "query_layout_placement",
  "query_spatial_placement",
  "query_stable_placement",
  "read_workspace_events",
  "read_workspace_resource_snapshot",
  "redo_workspace_batch",
  "request_enter_xr",
  "request_exit_xr",
  "request_voice_relay_arm",
  "run_voice_relay_diagnostics",
  "simulate_workspace_physics",
  "start_workspace_photo_reconstruction",
  "submit_workspace_batch",
  "undo_workspace_batch",
  "wait_for_xr_session_state",
];

const gateways: AgentGateway[] = [];
const handlers: AgentGatewayFetchHandler[] = [];
const clients: Client[] = [];

function setup(options: {
  now?: () => number;
  offerTtlMs?: number;
  approvalTtlMs?: number;
  pollTimeoutMs?: number;
} = {}) {
  const gateway = new AgentGateway({
    publicBaseUrl: PUBLIC_URL,
    workspaceRoot: "/workspace/SemaFrame",
    commandTimeoutMs: 1_000,
    pollTimeoutMs: options.pollTimeoutMs ?? 1_000,
    browserTtlMs: 5_000,
    offerTtlMs: options.offerTtlMs ?? 10_000,
    approvalTtlMs: options.approvalTtlMs ?? 5_000,
    ...(options.now ? { now: options.now } : {}),
  });
  const handle = createAgentGatewayHttpHandler(gateway, {
    allowedOrigins: [ORIGIN],
    publicBaseUrl: PUBLIC_URL,
    browserBootstrapToken: BROWSER_BOOTSTRAP_TOKEN,
  });
  gateways.push(gateway);
  handlers.push(handle);
  return { gateway, handle };
}

function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function browserPost(
  handle: AgentGatewayFetchHandler,
  csrfToken: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return handle(request(path, body, {
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

async function enableAndRegister(handle: AgentGatewayFetchHandler) {
  const initial = await payload(await handle(browserConfigRequest()));
  const csrfToken = String(initial.csrfToken);
  await browserPost(handle, csrfToken, "/api/agent/browser/enable", {});
  const config = await payload(await handle(browserConfigRequest()));
  const registration = await payload(await browserPost(handle, csrfToken, "/api/agent/browser/register", {
    clientInstanceId: "http-mcp-browser-01",
  }));
  return {
    csrfToken,
    connectionUrl: String(config.connectionUrl),
    browserConnectionId: String(registration.browserConnectionId),
  };
}

async function connect(
  handle: AgentGatewayFetchHandler,
  connectionUrl: string,
  mode: VersionNegotiationMode,
): Promise<Client> {
  const client = new Client(
    { name: "scene-http-transport-test", version: "1.0.0" },
    { versionNegotiation: { mode, probe: { timeoutMs: 2_000 } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(connectionUrl), {
    fetch: (input, init) => {
      // The SDK bundle and jsdom may provide distinct AbortSignal realms.
      // The in-process handler is immediate, so omit only that cross-realm field.
      const { signal: _signal, ...requestInit } = init ?? {};
      return handle(new Request(input, requestInit));
    },
  });
  clients.push(client);
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(handlers.splice(0).map((handler) => handler.close()));
  gateways.splice(0).forEach((gateway) => gateway.close());
});

describe("Agent MCP connection offers", () => {
  it.each([
    ["legacy", "legacy", /^2025-/u],
    ["modern", { pin: "2026-07-28" }, /^2026-07-28$/u],
  ] as const)("serves the same closed tool contract to %s clients", async (_label, mode, version) => {
    const { handle } = setup();
    const browser = await enableAndRegister(handle);
    const client = await connect(handle, browser.connectionUrl, mode);
    const { tools } = await client.listTools();

    expect(client.getNegotiatedProtocolVersion()).toMatch(version);
    expect(client.getServerVersion()).toEqual({
      name: "semaframe-workspace-engine",
      version: "1.10.0",
    });
    expect(expectedTools).toHaveLength(35);
    expect(tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(tools.every((tool) => Boolean(tool.outputSchema))).toBe(true);

    const liveXrTool = tools.find((tool) => tool.name === "get_live_xr_context");
    expect(liveXrTool?.title).toBe("Read live XR user state");
    expect(liveXrTool?.description).toContain("every tracked input");
    expect(liveXrTool?.description).toContain("conservative end-to-end age");
    const liveXrOutput = JSON.stringify(liveXrTool?.outputSchema);
    for (const discoverableField of [
      "sampleSequence",
      "tracking",
      "headPose",
      "playerCapsule",
      "trackedInputs",
      "primaryInputSourceId",
      "activeInputSourceId",
      "gripPose",
      "rayHit",
      "actions",
      "selectedComponentId",
      "spatialPin",
      "sourceAgeMs",
      "sourceTimestampBasis",
      "age_ms",
    ]) {
      expect(liveXrOutput).toContain(`\"${discoverableField}\"`);
    }
    expect(liveXrOutput).toContain("additionalProperties");
    expect(liveXrOutput).toContain("already includes renderer sourceAgeMs");

    const ordinaryHostOutput = JSON.stringify(
      tools.find((tool) => tool.name === "inspect_xr_readiness")?.outputSchema,
    );
    expect(ordinaryHostOutput).not.toContain("sampleSequence");
    expect(ordinaryHostOutput).not.toContain("trackedInputs");
  });

  it("publishes a secret-free document and requires explicit approval before releasing instructions", async () => {
    let now = Date.parse("2026-08-14T08:00:00.000Z");
    const { gateway, handle } = setup({ now: () => now, approvalTtlMs: 100, pollTimeoutMs: 1 });
    const browser = await enableAndRegister(handle);
    const reveal = await payload(await browserPost(handle, browser.csrfToken, "/api/agent/browser/reveal", {}));

    const documentResponse = await handle(new Request(browser.connectionUrl));
    const documentText = await documentResponse.text();
    expect(documentResponse.status).toBe(200);
    expect(documentResponse.headers.get("cache-control")).toBe("no-store");
    expect(documentText).toContain('"urlIsAuthorization": false');
    expect(documentText).toContain('"instructions"');
    expect(documentText).toContain("approval_fingerprint");
    expect(documentText).not.toMatch(/legacySceneInstructions|get_scene_instructions|Scene Protocol/u);
    expect(documentText).not.toContain(String(reveal.pairingBearer));
    expect(browser.connectionUrl).not.toMatch(/bearer|token|secret/iu);

    const client = await connect(handle, browser.connectionUrl, { pin: "2026-07-28" });
    const approvalWake = browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
      browserConnectionId: browser.browserConnectionId,
    });
    const first = await client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "agent-test-01",
        client_name: "Trusted\u202e Agent",
        requested_scopes: ["workspace:read", "workspace:write"],
      },
    });
    expect(await payload(await approvalWake)).toEqual({ kind: "idle" });
    const firstPayload = first.structuredContent as Record<string, unknown>;
    const firstError = firstPayload.error as Record<string, unknown>;
    const details = firstError.details as Record<string, unknown>;
    const approvalToken = String(details.approval_token);
    const approvalFingerprint = String(details.approval_fingerprint);
    const claimId = String(details.claim_id);

    expect(first.isError).toBe(true);
    expect(firstError).toEqual(expect.objectContaining({
      code: "approval_pending",
      required_action: "request_user_approval",
    }));
    expect(approvalToken.length).toBeGreaterThanOrEqual(32);
    expect(approvalFingerprint).toMatch(/^SHA-256 /u);

    const pending = await payload(await handle(browserConfigRequest()));
    expect(pending).toEqual(expect.objectContaining({
      connected: false,
      offerStatus: "approval_pending",
      pendingApproval: expect.objectContaining({
        claimId,
        clientId: "agent-test-01",
        clientName: "Trusted Agent",
        scopes: ["workspace:read", "workspace:write"],
        fingerprint: expect.stringMatching(/^SHA-256 /u),
      }),
    }));
    expect(JSON.stringify(pending)).not.toContain(approvalToken);
    expect((pending.pendingApproval as Record<string, unknown>).fingerprint).toBe(approvalFingerprint);

    const approved = await browserPost(handle, browser.csrfToken, "/api/agent/browser/approval/approve", { claimId });
    expect(approved.status).toBe(200);
    const afterApproval = await payload(await handle(browserConfigRequest()));
    expect(afterApproval).toEqual(expect.objectContaining({ connected: false, offerStatus: "approval_granted" }));
    expect(afterApproval.pendingApproval).toBeUndefined();

    const pollPromise = browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
      browserConnectionId: browser.browserConnectionId,
    });
    const guidePromise = client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "impostor-agent",
        client_name: "Impostor Agent",
        approval_token: approvalToken,
      },
    });
    let polled = await payload(await pollPromise);
    if (polled.kind === "idle") {
      polled = await payload(await browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
        browserConnectionId: browser.browserConnectionId,
      }));
    }
    const command = polled.command as Record<string, unknown>;
    expect(command).toEqual(expect.objectContaining({
      name: "get_workspace_instructions",
      input: {
        client_id: "agent-test-01",
        client_name: "Trusted Agent",
        requested_scopes: ["workspace:read", "workspace:write"],
      },
    }));
    expect(JSON.stringify(command)).not.toContain(approvalToken);

    now += 101;
    expect(await payload(await handle(browserConfigRequest()))).toEqual(
      expect.objectContaining({ connectionUrl: browser.connectionUrl, offerStatus: "approval_granted" }),
    );

    const coreResult = {
      ok: true,
      data: {
        session_token: "agent_session_http_test",
        guide_digest: "sha256:http-guide",
      },
    };
    await browserPost(handle, browser.csrfToken, "/api/agent/browser/result", {
      browserConnectionId: browser.browserConnectionId,
      commandId: command.id,
      ok: true,
      result: coreResult,
    });
    const guide = await guidePromise;
    expect(guide.isError).toBe(false);
    expect(guide.structuredContent).toEqual(coreResult);

    const connected = await payload(await handle(browserConfigRequest()));
    expect(connected).toEqual(expect.objectContaining({
      connected: true,
      clientName: "Trusted Agent",
      offerStatus: "approved",
    }));

    // HTTP approval is a durable connection state, not a 65-second activity
    // pulse. Keep the browser engine alive while external tool activity idles.
    for (const elapsed of [4_000, 8_000, 12_000]) {
      now = Date.parse("2026-08-14T08:00:00.000Z") + elapsed;
      await gateway.pollBrowser(browser.browserConnectionId);
    }
    expect(gateway.getConfig()).toEqual(expect.objectContaining({
      connected: true,
      engineConnected: true,
      clientName: "Trusted Agent",
    }));
    const activeDocument = await payload(await handle(new Request(browser.connectionUrl)));
    expect(activeDocument.offer).toEqual(expect.objectContaining({
      status: "approved",
      activeUntilRevoked: true,
      urlIsAuthorization: false,
    }));
    expect((activeDocument.offer as Record<string, unknown>).claimBy).toBeUndefined();
  });

  it("keeps the URL non-authorizing under hostile origins, altered URLs, wrong tokens, and denial", async () => {
    const { handle } = setup();
    const browser = await enableAndRegister(handle);

    expect((await handle(new Request(browser.connectionUrl, {
      headers: { origin: "https://attacker.example" },
    }))).status).toBe(403);
    expect((await handle(new Request(`${browser.connectionUrl}?approval_token=leak`))).status).toBe(404);

    const client = await connect(handle, browser.connectionUrl, { pin: "2026-07-28" });
    const premature = await client.callTool({
      name: "inspect_workspace",
      arguments: {
        session_token: "not-authorized",
        instruction_digest: "sha256:not-authorized",
      },
    });
    expect((premature.structuredContent as {
      error: { code: string };
    }).error.code).toBe("instructions_required");

    const claim = await client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "adversarial-test", client_name: "Claimed Agent" },
    });
    const claimError = (claim.structuredContent as {
      error: { details: { approval_token: string; claim_id: string } };
    }).error;

    const wrong = await client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "adversarial-test",
        client_name: "Claimed Agent",
        approval_token: "x".repeat(43),
      },
    });
    expect((wrong.structuredContent as { error: { code: string } }).error.code).toBe("approval_invalid");

    const denied = await browserPost(handle, browser.csrfToken, "/api/agent/browser/approval/deny", {
      claimId: claimError.details.claim_id,
    });
    expect(denied.status).toBe(200);
    const retry = await client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "adversarial-test",
        client_name: "Claimed Agent",
        approval_token: claimError.details.approval_token,
      },
    });
    expect((retry.structuredContent as { error: { code: string } }).error.code).toBe("approval_denied");
    expect((await payload(await handle(browserConfigRequest()))).connected).toBe(false);
  });

  it("replaces an approved-but-incomplete offer after a terminal instruction failure", async () => {
    const { handle } = setup();
    const browser = await enableAndRegister(handle);
    const client = await connect(handle, browser.connectionUrl, { pin: "2026-07-28" });
    const claim = await client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "failed-handshake", client_name: "Failed Handshake" },
    });
    const claimError = (claim.structuredContent as {
      error: { details: { approval_token: string; claim_id: string } };
    }).error;
    await browserPost(handle, browser.csrfToken, "/api/agent/browser/approval/approve", {
      claimId: claimError.details.claim_id,
    });

    const guidePromise = client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "failed-handshake",
        client_name: "Failed Handshake",
        approval_token: claimError.details.approval_token,
      },
    });
    let command: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 3 && !command; attempt += 1) {
      const poll = await payload(await browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
        browserConnectionId: browser.browserConnectionId,
      }));
      if (poll.kind === "command") command = poll.command as Record<string, unknown>;
    }
    expect(command).toEqual(expect.objectContaining({ name: "get_workspace_instructions" }));
    await browserPost(handle, browser.csrfToken, "/api/agent/browser/result", {
      browserConnectionId: browser.browserConnectionId,
      commandId: command?.id,
      ok: false,
      error: { code: "command_failed", message: "The instruction controller rejected the request." },
    });

    const failedGuide = await guidePromise;
    expect(failedGuide.isError).toBe(true);
    expect((failedGuide.structuredContent as { error: { code: string } }).error.code).toBe("command_failed");
    const recovered = await payload(await handle(browserConfigRequest()));
    expect(recovered).toEqual(expect.objectContaining({ offerStatus: "waiting" }));
    expect(recovered.connectionUrl).not.toBe(browser.connectionUrl);
    expect((await handle(new Request(browser.connectionUrl))).status).toBe(404);
  });

  it("keeps a transient incomplete claim retryable until the user requests a fresh URL", async () => {
    const { handle } = setup();
    const browser = await enableAndRegister(handle);
    const client = await connect(handle, browser.connectionUrl, { pin: "2026-07-28" });
    const claim = await client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "retry-handshake", client_name: "Retry Handshake" },
    });
    const claimError = (claim.structuredContent as {
      error: { details: { approval_token: string; claim_id: string } };
    }).error;
    await browserPost(handle, browser.csrfToken, "/api/agent/browser/approval/approve", {
      claimId: claimError.details.claim_id,
    });
    await browserPost(handle, browser.csrfToken, "/api/agent/browser/unregister", {
      browserConnectionId: browser.browserConnectionId,
    });

    const retryable = await client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "retry-handshake",
        client_name: "Retry Handshake",
        approval_token: claimError.details.approval_token,
      },
    });
    const retryableError = (retryable.structuredContent as {
      error: { code: string; retryable: boolean };
    }).error;
    expect(retryableError).toMatchObject({ code: "engine_unavailable", retryable: true });
    const recoverable = await payload(await handle(browserConfigRequest()));
    expect(recoverable).toEqual(expect.objectContaining({
      connectionUrl: browser.connectionUrl,
      offerStatus: "approval_granted",
    }));
  });

  it("rotates an abandoned approval claim when its private-token deadline expires", async () => {
    let now = Date.parse("2026-08-14T08:00:00.000Z");
    const { handle } = setup({ now: () => now, offerTtlMs: 1_000, approvalTtlMs: 100 });
    const browser = await enableAndRegister(handle);
    const client = await connect(handle, browser.connectionUrl, { pin: "2026-07-28" });
    await client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "abandoned-claim", client_name: "Abandoned Claim" },
    });
    expect(await payload(await handle(browserConfigRequest()))).toEqual(
      expect.objectContaining({ connectionUrl: browser.connectionUrl, offerStatus: "approval_pending" }),
    );

    now += 101;
    const refreshed = await payload(await handle(browserConfigRequest()));
    expect(refreshed).toEqual(expect.objectContaining({ offerStatus: "waiting" }));
    expect(refreshed.connectionUrl).not.toBe(browser.connectionUrl);
    expect((await handle(new Request(browser.connectionUrl))).status).toBe(404);
  });

  it("automatically replaces expired unclaimed links and accepts remote HTTPS advertisement", async () => {
    let now = Date.parse("2026-08-14T08:00:00.000Z");
    const { handle } = setup({ now: () => now, offerTtlMs: 100 });
    const browser = await enableAndRegister(handle);
    now += 101;

    const expired = await handle(new Request(browser.connectionUrl));
    expect(expired.status).toBe(410);
    const refreshed = await payload(await handle(browserConfigRequest()));
    expect(refreshed).toEqual(expect.objectContaining({ offerStatus: "waiting" }));
    expect(refreshed.connectionUrl).not.toBe(browser.connectionUrl);
    expect((await handle(new Request(browser.connectionUrl))).status).toBe(404);

    const remote = new AgentGateway({
      publicBaseUrl: "https://agent.example.test",
      workspaceRoot: "/workspace/SemaFrame",
      now: () => now,
    });
    gateways.push(remote);
    remote.setEnabled(true);
    expect(remote.getConfig().connectionUrl).toMatch(/^https:\/\/agent\.example\.test\/mcp\/connect\//u);

    const network = resolveAgentGatewayNetworkConfig({
      SEMAFRAME_AGENT_GATEWAY_HOST: "127.0.0.1",
      SEMAFRAME_AGENT_GATEWAY_PORT: "8788",
      SEMAFRAME_AGENT_GATEWAY_PUBLIC_URL: "https://agent.example.test",
    });
    expect(network).toEqual(expect.objectContaining({
      bindHost: "127.0.0.1",
      port: 8788,
      publicBaseUrl: "https://agent.example.test",
    }));
    expect(network.allowedHostnames).toEqual(expect.arrayContaining(["127.0.0.1", "agent.example.test"]));
    expect(() => resolveAgentGatewayNetworkConfig({
      SEMAFRAME_AGENT_GATEWAY_HOST: "0.0.0.0",
      SEMAFRAME_AGENT_GATEWAY_PUBLIC_URL: "https://agent.example.test",
    })).toThrow(/only bind to a loopback host/u);
  });
});
