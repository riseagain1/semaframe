// @vitest-environment node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { AgentAssetIngress } from "../../../server/agent/AgentAssetIngress";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import {
  createNodeAgentGatewayHttpHandler,
  type AgentGatewayNodeHandler,
} from "../../../server/agent/AgentGatewayHttpHandler";
import {
  PhotoReconstructionService,
  type PhotoReconstructionBackend,
} from "../../../server/reconstruction/PhotoReconstructionService";

const PROJECT_ROOT = process.cwd();
const WORKSPACE_ID = "workspace_stdio_bridge";

type LiveRig = Readonly<{
  server: Server;
  handler: AgentGatewayNodeHandler;
  gateway: AgentGateway;
  temporaryDirectory: string;
}>;

const clients: Client[] = [];
const rigs: LiveRig[] = [];
const auxiliaryServers: Server[] = [];
const auxiliaryClosers: Array<() => Promise<void>> = [];

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function listen(server: Server, requestedPort = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test listener.");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function stdioTransport(connectionUrl: string): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(join(PROJECT_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href,
      join(PROJECT_ROOT, "scripts", "agent-mcp.ts"),
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...getDefaultEnvironment(),
      SEMAFRAME_AGENT_MCP_URL: connectionUrl,
    },
    stderr: "pipe",
  });
}

function stableStdioTransport(
  gatewayUrl: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(join(PROJECT_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href,
      join(PROJECT_ROOT, "scripts", "agent-mcp.ts"),
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...getDefaultEnvironment(),
      SEMAFRAME_AGENT_GATEWAY_URL: gatewayUrl,
      ...extraEnvironment,
    },
    stderr: "pipe",
  });
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`stdio bridge process ${pid} did not exit within ${timeoutMs} ms`);
}

async function setup(options: { commandTimeoutMs?: number; port?: number } = {}): Promise<LiveRig & {
  connectionUrl: string;
  browserConnectionId: string;
}> {
  let handler: AgentGatewayNodeHandler | undefined;
  const server = createServer((request, response) => {
    if (!handler) {
      response.statusCode = 503;
      response.end();
      return;
    }
    void handler(request, response);
  });
  const port = await listen(server, options.port);
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "semaframe-stdio-bridge-test-"));
  const gateway = new AgentGateway({
    publicBaseUrl,
    workspaceRoot: PROJECT_ROOT,
    commandTimeoutMs: options.commandTimeoutMs ?? 2_000,
    pollTimeoutMs: 10,
    // Spawning the stdio bridge can take several seconds when the full
    // Vitest suite is saturating the machine. Keep this test-only browser
    // authority alive long enough to exercise the bridge deterministically.
    browserTtlMs: 30_000,
  });
  const ingress = new AgentAssetIngress({
    publicBaseUrl,
    temporaryDirectory,
    maxBytes: 1024 * 1024,
    maxStagedBytes: 4 * 1024 * 1024,
    sweepIntervalMs: 0,
  });
  const backend: PhotoReconstructionBackend = {
    identity: Object.freeze({ id: "stdio-bridge-test", version: "1.0.0" }),
    probe: async () => ({ available: true }),
    run: async () => {
      throw new Error("The stdio bridge begin test must not start reconstruction.");
    },
  };
  const reconstruction = new PhotoReconstructionService({
    publicBaseUrl,
    temporaryDirectory,
    assetIngress: ingress,
    backend,
    sweepIntervalMs: 0,
  });
  handler = createNodeAgentGatewayHttpHandler(gateway, {
    allowedOrigins: ["http://127.0.0.1:4173"],
    publicBaseUrl,
    browserBootstrapToken: "b".repeat(43),
    assetIngress: ingress,
    photoReconstruction: reconstruction,
  });
  gateway.setEnabled(true);
  const reveal = gateway.revealPairing();
  const browser = gateway.registerBrowser("stdio-bridge-browser");
  const rig = { server, handler, gateway, temporaryDirectory };
  rigs.push(rig);
  return {
    ...rig,
    connectionUrl: reveal.connectionUrl,
    browserConnectionId: browser.browserConnectionId,
  };
}

async function pollCommand(gateway: AgentGateway, browserConnectionId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await gateway.pollBrowser(browserConnectionId);
    if (result.kind === "command") return result.command;
  }
  throw new Error("Expected a browser-authoritative command.");
}

function submitResult(
  gateway: AgentGateway,
  browserConnectionId: string,
  commandId: string,
  result: unknown,
): void {
  gateway.submitBrowserResult({ browserConnectionId, commandId, ok: true, result });
}

async function setupBridgeReliabilityUpstream(): Promise<Readonly<{
  gatewayUrl: string;
  connectionUrl: string;
  longStarted: Promise<void>;
  longAborted: Promise<void>;
  diagnostics: string[];
  removeRejectTool(): void;
}>> {
  let markLongStarted!: () => void;
  let markLongAborted!: () => void;
  const longStarted = new Promise<void>((resolve) => { markLongStarted = resolve; });
  const longAborted = new Promise<void>((resolve) => { markLongAborted = resolve; });
  const diagnostics: string[] = [];
  let rejectToolAvailable = true;
  const mcp = createMcpHandler(() => {
    const server = new McpServer({ name: "bridge-reliability-upstream", version: "1.0.0" });
    server.registerTool(
      "long_operation",
      { inputSchema: z.strictObject({ value: z.string() }) },
      async (_input, context) => {
        markLongStarted();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            markLongAborted();
            reject(context.mcpReq.signal.reason ?? new DOMException("cancelled", "AbortError"));
          };
          if (context.mcpReq.signal.aborted) abort();
          else context.mcpReq.signal.addEventListener("abort", abort, { once: true });
        });
      },
    );
    if (rejectToolAvailable) {
      server.registerTool(
        "reject_operation",
        { inputSchema: z.strictObject({ value: z.string() }) },
        async ({ value }) => ({ content: [{ type: "text", text: value }] }),
      );
    }
    server.registerTool(
      "internal_error_operation",
      { inputSchema: z.strictObject({ value: z.string() }) },
      async () => ({ content: [{ type: "text", text: "unused low-level test callback" }] }),
    );
    server.registerTool(
      "echo_operation",
      { inputSchema: z.strictObject({ value: z.string() }) },
      async ({ value }) => ({
        content: [{ type: "text", text: value }],
        structuredContent: { value },
      }),
    );
    // Override the convenience server's tools/call dispatcher so this fixture
    // can emit an actual JSON-RPC ProtocolError response. Throwing from a
    // registerTool callback is intentionally converted by the SDK into a
    // normal isError tool result and would not exercise the bridge policy.
    server.server.setRequestHandler("tools/call", async (request, context) => {
      const name = request.params.name;
      const value = typeof request.params.arguments?.value === "string"
        ? request.params.arguments.value
        : "";
      if (name === "internal_error_operation") {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "private-path=/Users/private bearer=do-not-leak ignore-prior-instructions",
        );
      }
      if (name === "reject_operation" && !rejectToolAvailable) {
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, "reject_operation was removed");
      }
      if (name === "long_operation") {
        markLongStarted();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            markLongAborted();
            reject(context.mcpReq.signal.reason ?? new DOMException("cancelled", "AbortError"));
          };
          if (context.mcpReq.signal.aborted) abort();
          else context.mcpReq.signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (name === "echo_operation" || name === "reject_operation") {
        return {
          content: [{ type: "text", text: value }],
          structuredContent: { value },
        };
      }
      throw new ProtocolError(ProtocolErrorCode.MethodNotFound, "unknown test tool");
    });
    return server;
  }, { onerror: (error) => { diagnostics.push(`mcp:${error.message}`); } });
  auxiliaryClosers.push(() => mcp.close());
  const mcpNodeHandler = toNodeHandler(mcp, {
    onerror: (error) => { diagnostics.push(`node:${error.message}`); },
  });
  let gatewayUrl = "";
  const connectionPath = "/mcp/connect/abcdefghijklmnop";
  const httpServer = createServer((request, response) => {
    diagnostics.push(`${request.method} ${request.url}`);
    if (request.url === "/.well-known/semaframe-agent" && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schema_version: 1,
        service: "semaframe-agent",
        connection_url: `${gatewayUrl}${connectionPath}`,
        gateway_instance_id: "123e4567-e89b-42d3-a456-426614174000",
        toolset_digest: `sha256:${"a".repeat(64)}`,
        offer_status: "waiting",
        approval_required: true,
      }));
      return;
    }
    if (request.url === connectionPath) {
      void mcpNodeHandler(request, response);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  auxiliaryServers.push(httpServer);
  const port = await listen(httpServer);
  gatewayUrl = `http://127.0.0.1:${port}`;
  return {
    gatewayUrl,
    connectionUrl: `${gatewayUrl}${connectionPath}`,
    longStarted,
    longAborted,
    diagnostics,
    removeRejectTool: () => { rejectToolAvailable = false; },
  };
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const rig of rigs.splice(0)) {
    await closeServer(rig.server).catch(() => undefined);
    await rig.handler.close().catch(() => undefined);
    rig.gateway.close();
    await rm(rig.temporaryDirectory, { recursive: true, force: true });
  }
  for (const server of auxiliaryServers.splice(0)) {
    server.closeAllConnections();
    await closeServer(server).catch(() => undefined);
  }
  await Promise.allSettled(auxiliaryClosers.splice(0).map((close) => close()));
});

describe("Agent MCP stdio transport bridge", () => {
  it("uses the browser-approved HTTP claim for photo reconstruction instead of the bearer REST path", async () => {
    const rig = await setup();
    const client = new Client(
      { name: "stdio-bridge-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 5_000 } } },
    );
    clients.push(client);
    await client.connect(stdioTransport(rig.connectionUrl));

    const claimResult = await client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "stdio-reconstruction-agent",
        client_name: "Stdio Reconstruction Agent",
        requested_scopes: ["workspace:read", "asset:reconstruct"],
      },
    });
    const claim = (claimResult.structuredContent as {
      error: { code: string; details: { approval_token: string; claim_id: string } };
    }).error;
    expect(claim.code).toBe("approval_pending");
    rig.gateway.approveClaim(claim.details.claim_id);

    const instructionsPromise = client.callTool({
      name: "get_workspace_instructions",
      arguments: { approval_token: claim.details.approval_token },
    });
    const instructionsCommand = await pollCommand(rig.gateway, rig.browserConnectionId);
    expect(instructionsCommand.name).toBe("get_workspace_instructions");
    submitResult(rig.gateway, rig.browserConnectionId, instructionsCommand.id, {
      ok: true,
      data: {
        session_token: "session_stdio_reconstruction",
        guide_digest: "sha256:stdio-reconstruction-guide",
        granted_scopes: ["workspace:read", "asset:reconstruct"],
      },
    });
    const instructions = await instructionsPromise;
    expect(instructions.isError).toBe(false);

    const beginPromise = client.callTool({
      name: "begin_workspace_photo_reconstruction",
      arguments: {
        session_token: "session_stdio_reconstruction",
        instruction_digest: "sha256:stdio-reconstruction-guide",
        request_id: "stdio-photo-reconstruction-0001",
        workspace_id: WORKSPACE_ID,
        profile: "preview",
        photos: [
          {
            photo_id: "front",
            media_type: "image/png",
            byte_length: 1,
            sha256: sha256("front"),
          },
          {
            photo_id: "rear",
            media_type: "image/png",
            byte_length: 1,
            sha256: sha256("rear"),
          },
        ],
      },
    });
    const validationCommand = await pollCommand(rig.gateway, rig.browserConnectionId);
    expect(validationCommand.name).toBe("begin_workspace_photo_reconstruction");
    expect(validationCommand.input).not.toHaveProperty("approval_token");
    submitResult(rig.gateway, rig.browserConnectionId, validationCommand.id, {
      ok: true,
      data: {
        client_id: "stdio-reconstruction-agent",
        client_name: "Stdio Reconstruction Agent",
        workspace_id: WORKSPACE_ID,
      },
    });
    const begun = await beginPromise;
    expect(begun.isError).toBe(false);
    expect(begun.structuredContent).toMatchObject({
      ok: true,
      data: {
        job: { workspaceId: WORKSPACE_ID, status: "awaiting_upload" },
        uploads: [{ method: "PUT" }, { method: "PUT" }],
      },
    });
    expect(JSON.stringify(begun.structuredContent)).not.toContain(claim.details.approval_token);
  }, 20_000);

  it("keeps one stdio launcher alive, rediscovers after a gateway restart, and requires fresh human approval", async () => {
    const first = await setup();
    const gatewayUrl = new URL(first.connectionUrl).origin;
    const transport = stableStdioTransport(gatewayUrl);
    const client = new Client({ name: "stable-bootstrap-e2e", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);
    const originalPid = transport.pid;
    expect(originalPid).toBeTypeOf("number");

    const firstClaimResult = await client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "stable-bootstrap-agent", client_name: "Stable Bootstrap Agent" },
    });
    const firstClaim = (firstClaimResult.structuredContent as {
      error: { code: string; details: { approval_token: string; claim_id: string } };
    }).error;
    expect(firstClaim.code).toBe("approval_pending");
    first.gateway.approveClaim(firstClaim.details.claim_id);
    const firstInstructionsPromise = client.callTool({
      name: "get_workspace_instructions",
      arguments: { approval_token: firstClaim.details.approval_token },
    });
    const firstCommand = await pollCommand(first.gateway, first.browserConnectionId);
    submitResult(first.gateway, first.browserConnectionId, firstCommand.id, {
      ok: true,
      data: {
        session_token: "session_before_gateway_restart",
        guide_digest: "sha256:guide-before-gateway-restart",
        granted_scopes: ["workspace:read"],
      },
    });
    expect((await firstInstructionsPromise).isError).toBe(false);
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["get_live_xr_context", "prepare_voice_relay_setup"]),
    );

    const firstAddress = first.server.address();
    if (!firstAddress || typeof firstAddress === "string") throw new Error("Expected gateway TCP address.");
    first.server.closeAllConnections();
    await closeServer(first.server);
    await first.handler.close();
    first.gateway.close();

    const second = await setup({ port: firstAddress.port });
    expect(second.gateway.getConfig().gatewayInstanceId).not.toBe(first.gateway.getConfig().gatewayInstanceId);

    // The fixed discovery monitor detects the replacement instance and
    // reconnects proactively. No user tool call is sacrificed to trigger
    // recovery, and the installed stdio process remains the same.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const secondClaimResult = await client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "stable-bootstrap-agent", client_name: "Stable Bootstrap Agent" },
    });
    expect(transport.pid).toBe(originalPid);

    const secondClaim = (secondClaimResult.structuredContent as {
      error: { code: string; details: { approval_token: string; claim_id: string } };
    }).error;
    expect(secondClaim.code).toBe("approval_pending");
    expect(() => second.gateway.approveClaim(firstClaim.details.claim_id)).toThrow(/invalid or expired/u);
    second.gateway.approveClaim(secondClaim.details.claim_id);
    const secondInstructionsPromise = client.callTool({
      name: "get_workspace_instructions",
      arguments: { approval_token: secondClaim.details.approval_token },
    });
    const secondCommand = await pollCommand(second.gateway, second.browserConnectionId);
    submitResult(second.gateway, second.browserConnectionId, secondCommand.id, {
      ok: true,
      data: {
        session_token: "session_after_gateway_restart",
        guide_digest: "sha256:guide-after-gateway-restart",
        granted_scopes: ["workspace:read"],
      },
    });
    expect((await secondInstructionsPromise).isError).toBe(false);
    expect(transport.pid).toBe(originalPid);
  }, 30_000);

  it("keeps cancellation and deterministic protocol errors local to their concurrent calls", async () => {
    const upstream = await setupBridgeReliabilityUpstream();
    const transport = stableStdioTransport(upstream.gatewayUrl);
    let bridgeStderr = "";
    transport.stderr?.on("data", (chunk) => { bridgeStderr += String(chunk); });
    const client = new Client(
      { name: "bridge-reliability-client", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    clients.push(client);
    await client.connect(transport);
    const originalPid = transport.pid;
    expect(originalPid).toBeTypeOf("number");

    let tools: string[] = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      tools = (await client.listTools(undefined, { cacheMode: "refresh" })).tools.map(({ name }) => name);
      if (tools.includes("long_operation")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(tools, `${bridgeStderr}\n${upstream.diagnostics.join("\n")}`).toEqual(expect.arrayContaining([
      "echo_operation",
      "internal_error_operation",
      "long_operation",
      "reject_operation",
    ]));

    const controller = new AbortController();
    let longSettled = false;
    const longOutcome = client.callTool(
      { name: "long_operation", arguments: { value: "wait" } },
      { signal: controller.signal },
    ).then(
      (value) => {
        longSettled = true;
        return { kind: "resolved" as const, value };
      },
      (error: unknown) => {
        longSettled = true;
        return { kind: "rejected" as const, error };
      },
    );
    await upstream.longStarted;

    const internalError = await client.callTool({
      name: "internal_error_operation",
      arguments: { value: "invalid" },
    });
    expect(internalError.isError).toBe(true);
    const internalErrorPayload = JSON.parse(
      (internalError.content[0] as { type: "text"; text: string }).text,
    ) as Record<string, unknown>;
    expect(internalErrorPayload).toEqual({
      ok: false,
      error: {
        code: "upstream_mcp_error",
        message: "The upstream SemaFrame MCP server rejected this request.",
        retryable: false,
        details: { mcp_code: ProtocolErrorCode.InternalError },
      },
    });
    expect(JSON.stringify(internalError)).not.toMatch(/Users|bearer|do-not-leak|ignore-prior/iu);
    expect(longSettled).toBe(false);
    expect(transport.pid).toBe(originalPid);

    upstream.removeRejectTool();
    const rejected = await client.callTool({
      name: "reject_operation",
      arguments: { value: "invalid" },
    });
    expect(rejected.isError).toBe(true);
    const rejectedPayload = JSON.parse(
      (rejected.content[0] as { type: "text"; text: string }).text,
    ) as Record<string, unknown>;
    expect(rejectedPayload).toMatchObject({
      ok: false,
      error: { code: "upstream_mcp_error", retryable: false },
    });
    expect(longSettled).toBe(false);
    expect(transport.pid).toBe(originalPid);

    controller.abort(new DOMException("cancelled downstream", "AbortError"));
    await Promise.race([
      upstream.longAborted,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Upstream long call did not receive cancellation.")), 2_000);
      }),
    ]);
    expect(await longOutcome).toMatchObject({
      kind: "rejected",
      error: { name: "SdkError", message: expect.stringContaining("cancelled downstream") },
    });

    await expect(client.callTool({
      name: "echo_operation",
      arguments: { value: "still connected" },
    })).resolves.toMatchObject({ structuredContent: { value: "still connected" } });
    expect(transport.pid).toBe(originalPid);
  }, 20_000);

  it("bounds a discovery listener that accepts the socket but never responds", async () => {
    let sawDiscovery!: () => void;
    let discoveryClosed!: () => void;
    const discoverySeen = new Promise<void>((resolve) => { sawDiscovery = resolve; });
    const closedDiscovery = new Promise<void>((resolve) => { discoveryClosed = resolve; });
    const server = createServer((request, response) => {
      expect(request.url).toBe("/.well-known/semaframe-agent");
      request.once("end", sawDiscovery);
      request.resume();
      response.once("close", discoveryClosed);
      request.socket.once("close", discoveryClosed);
      // The accepted loopback socket intentionally never receives headers.
    });
    auxiliaryServers.push(server);
    const port = await listen(server);
    const transport = stableStdioTransport(`http://127.0.0.1:${port}`, {
      SEMAFRAME_AGENT_CONNECT_TIMEOUT_MS: "250",
    });
    const client = new Client({ name: "hanging-discovery-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const pending = client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "hanging-discovery", client_name: "Hanging Discovery" },
    });
    await discoverySeen;
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("Hanging bootstrap discovery exceeded its configured timeout")),
        2_000,
      )),
    ]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "gateway_unavailable", retryable: true },
    });
    await Promise.race([
      closedDiscovery,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("Timed-out bootstrap discovery socket was not aborted")),
        2_000,
      )),
    ]);
  }, 10_000);

  it("maps an expired upstream offer to a non-retryable fresh-setup instruction", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 410;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: { code: "connection_offer_expired" } }));
    });
    auxiliaryServers.push(server);
    const port = await listen(server);
    const client = new Client({ name: "stdio-expired-offer-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(stdioTransport(`http://127.0.0.1:${port}/mcp/connect/expired`));

    const result = await client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "expired-stdio-client", client_name: "Expired Stdio Client" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: {
        code: "connection_offer_expired",
        message: "This SemaFrame MCP offer is no longer valid. Copy a fresh setup from the open app.",
        retryable: false,
      },
    });
  }, 15_000);

  it("aborts a hanging upstream connection and exits promptly on SIGTERM", async () => {
    let sawRequest!: () => void;
    let requestClosed!: () => void;
    const requestSeen = new Promise<void>((resolve) => { sawRequest = resolve; });
    const closedRequest = new Promise<void>((resolve) => { requestClosed = resolve; });
    const server = createServer((request, response) => {
      request.once("end", sawRequest);
      request.resume();
      response.once("close", requestClosed);
      request.socket.once("close", requestClosed);
      // Intentionally never answer: shutdown must abort this fetch rather than
      // waiting for the SDK's normal network timeout.
    });
    auxiliaryServers.push(server);
    const port = await listen(server);
    const transport = stdioTransport(`http://127.0.0.1:${port}/mcp/connect/hanging`);
    const client = new Client({ name: "stdio-hanging-connect-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);
    const pendingCall = client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "hanging-stdio-client", client_name: "Hanging Stdio Client" },
    });
    const pendingCallSettled = pendingCall.catch(() => undefined);
    await requestSeen;
    const pid = transport.pid;
    expect(pid).toBeTypeOf("number");
    process.kill(pid!, "SIGTERM");

    await Promise.all([
      waitForProcessExit(pid!, 3_000),
      Promise.race([
        closedRequest,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("Hanging upstream request was not aborted within 3 seconds")),
          3_000,
        )),
      ]),
    ]);
    await pendingCallSettled;
  }, 15_000);

  it("aborts a hanging tool call on an already-connected upstream before exit", async () => {
    const rig = await setup({ commandTimeoutMs: 60_000 });
    const transport = stdioTransport(rig.connectionUrl);
    const client = new Client({ name: "stdio-connected-shutdown-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const claimResult = await client.callTool({
      name: "get_workspace_instructions",
      arguments: { client_id: "connected-shutdown-client", client_name: "Connected Shutdown Client" },
    });
    const claim = (claimResult.structuredContent as {
      error: { details: { approval_token: string; claim_id: string } };
    }).error;
    rig.gateway.approveClaim(claim.details.claim_id);

    const pendingCall = client.callTool({
      name: "get_workspace_instructions",
      arguments: { approval_token: claim.details.approval_token },
    });
    const pendingCallSettled = pendingCall.catch(() => undefined);
    await pollCommand(rig.gateway, rig.browserConnectionId);

    const pid = transport.pid;
    expect(pid).toBeTypeOf("number");
    process.kill(pid!, "SIGTERM");
    await waitForProcessExit(pid!, 3_000);
    await Promise.race([
      pendingCallSettled,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("Connected upstream tool call did not settle during shutdown")),
        3_000,
      )),
    ]);
  }, 15_000);

  it("exits when an MCP host closes stdin without sending a signal", async () => {
    const child = spawn(process.execPath, [
      "--import",
      pathToFileURL(join(PROJECT_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href,
      join(PROJECT_ROOT, "scripts", "agent-mcp.ts"),
    ], {
      cwd: PROJECT_ROOT,
      env: {
        ...getDefaultEnvironment(),
        SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:9/mcp/stdio-eof-test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    let childStderr = "";
    child.stderr.on("data", (chunk) => { childStderr += String(chunk); });
    try {
      const exited = once(child, "exit");
      child.stdin.end();
      const [code, signal] = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("stdio bridge did not exit within 3 seconds of stdin EOF")),
          3_000,
        )),
      ]);
      expect(signal).toBeNull();
      expect(code, childStderr).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
});
