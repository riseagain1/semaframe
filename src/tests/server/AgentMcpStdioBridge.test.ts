import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["--silent", "--prefix", PROJECT_ROOT, "run", "agent:mcp"],
    cwd: PROJECT_ROOT,
    env: {
      ...getDefaultEnvironment(),
      SEMAFRAME_AGENT_MCP_URL: connectionUrl,
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

async function setup(): Promise<LiveRig & { connectionUrl: string; browserConnectionId: string }> {
  let handler: AgentGatewayNodeHandler | undefined;
  const server = createServer((request, response) => {
    if (!handler) {
      response.statusCode = 503;
      response.end();
      return;
    }
    void handler(request, response);
  });
  const port = await listen(server);
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "semaframe-stdio-bridge-test-"));
  const gateway = new AgentGateway({
    publicBaseUrl,
    workspaceRoot: PROJECT_ROOT,
    commandTimeoutMs: 2_000,
    pollTimeoutMs: 10,
    // Spawning npm + the stdio bridge can take several seconds when the full
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
    const server = createServer((request, _response) => {
      sawRequest();
      request.once("aborted", requestClosed);
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
});
