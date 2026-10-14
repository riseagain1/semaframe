import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { AgentGateway } from "../../server/agent/AgentGateway";
import { createAgentBootstrapDiscoveryHandler } from "../../server/agent/AgentBootstrapDiscovery";
import { createAgentMcpHttpHandler } from "../../server/agent/AgentMcpHttpHandler";
import { WorkspaceAgentController } from "../../src/workspace/agents/WorkspaceAgentController";
import { WorkspaceStoreEngineAdapter } from "../../src/workspace/agents/WorkspaceStoreEngineAdapter";
import { WorkspaceStore } from "../../src/workspace/state/WorkspaceStore";

/** Dev-only, memory-only fixture. It never accesses an existing listener or project. */
export async function startDshGatewayFixture(repositoryRoot: string) {
  let clockOffsetMs = 0;
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  const server = createServer((request, response) => {
    if (handler) void handler(request, response);
    else { response.writeHead(503); response.end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = new AgentGateway({
    publicBaseUrl: origin,
    bootstrapBaseUrl: origin,
    workspaceRoot: repositoryRoot,
    commandTimeoutMs: 10_000,
    pollTimeoutMs: 100,
    browserTtlMs: 5 * 60_000,
    offerTtlMs: 60_000,
    approvalTtlMs: 30_000,
    now: () => Date.now() + clockOffsetMs,
  });
  const mcp = createAgentMcpHttpHandler(gateway, { allowedOrigins: [] });
  const bootstrap = createAgentBootstrapDiscoveryHandler(gateway, origin);
  handler = async (request, response) => {
    try {
      const target = new URL(request.url ?? "/", origin);
      if (!bootstrap.matches(target.pathname) && !mcp.matches(target.pathname)) {
        response.writeHead(404); response.end(); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 1024 * 1024) { response.writeHead(413); response.end(); return; }
        chunks.push(buffer);
      }
      const headers = new Headers();
      for (const [name, values] of Object.entries(request.headers)) {
        if (typeof values === "string") headers.set(name, values);
        else values?.forEach((value) => headers.append(name, value));
      }
      const method = request.method ?? "GET";
      const webRequest = new Request(target, {
        method, headers,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: Buffer.concat(chunks) }),
      });
      const result = bootstrap.matches(target.pathname)
        ? bootstrap.fetch(webRequest, request.socket.remoteAddress)
        : await mcp.fetch(webRequest);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) {
        const stream = Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]);
        stream.on("error", () => response.destroy());
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      } else response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end("Isolated DSH fixture request failed.");
    }
  };
  gateway.setEnabled(true);
  const browser = gateway.registerBrowser("isolated-dsh-browser-fixture");
  const store = new WorkspaceStore();
  const controller = new WorkspaceAgentController(new WorkspaceStoreEngineAdapter(store, {
    // Synthetic host facts belong ONLY to this isolated interoperability fixture.
    // The graphs themselves are derived by the production adapter and projector.
    getRuntimeView: () => ({
      viewId: "isolated-dsh-fixture-view",
      epoch: store.getRevision(),
      workspaceId: store.getState().workspaceId,
      workspaceRevision: store.getRevision(),
      sampledAt: Date.now(),
      status: "ready",
      viewport: { width: 1024, height: 768 },
      camera: { position: { x: 4, y: 3, z: 6 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 50 },
      canvasView: { pan: { x: 0, y: 0 }, zoom: 1 },
      occluders: [{ id: "fixture-toolbar", kind: "toolbar", bounds: { left: 300, top: 0, width: 400, height: 56 } }],
    }),
  }), {
    grantScopes: ({ requestedScopes }) => [...requestedScopes],
  });
  let running = true;
  let dispatchedCommands = 0;
  const pump = (async () => {
    while (running) {
      const reply = await gateway.pollBrowser(browser.browserConnectionId);
      if (reply.kind === "command") {
        dispatchedCommands += 1;
        const result = await controller.dispatch(reply.command.name, reply.command.input);
        gateway.submitBrowserResult({
          browserConnectionId: browser.browserConnectionId,
          commandId: reply.command.id,
          ok: true,
          result,
        });
      }
    }
  })();
  return {
    origin,
    // Real production setup generator: only its credential-free configuration leaves the fixture.
    mcpConfig: gateway.revealPairing().mcpConfig,
    dispatchedCommands: () => dispatchedCommands,
    approveFixtureClaim: (claimId: string) => gateway.approveClaim(claimId),
    // Injected time affects ONLY this memory fixture, never a user's Gateway.
    advanceClock: (milliseconds: number) => {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError("Invalid fixture clock advance.");
      clockOffsetMs += milliseconds;
    },
    async close() {
      running = false;
      try { await pump; } finally {
        await mcp.close();
        gateway.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
