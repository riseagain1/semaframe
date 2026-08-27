import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_BOOTSTRAP_DISCOVERY_PATH,
  AGENT_TOOLSET_DIGEST,
  AgentBootstrapDiscoveryError,
  createAgentBootstrapDiscoveryHandler,
  discoverAgentMcpOffer,
  normalizeAgentGatewayUrl,
  normalizeAgentMcpConnectionUrl,
} from "../../../server/agent/AgentBootstrapDiscovery";
import { AgentGateway } from "../../../server/agent/AgentGateway";

const BASE_URL = "http://127.0.0.1:8788";
const gateways: AgentGateway[] = [];

function setup() {
  const gateway = new AgentGateway({
    publicBaseUrl: BASE_URL,
    bootstrapBaseUrl: BASE_URL,
    workspaceRoot: "/workspace/SemaFrame",
  });
  gateways.push(gateway);
  return {
    gateway,
    discovery: createAgentBootstrapDiscoveryHandler(gateway, BASE_URL),
  };
}

function request(
  suffix = "",
  headers: Record<string, string> = { host: "127.0.0.1:8788" },
  method = "GET",
): Request {
  return new Request(`${BASE_URL}${AGENT_BOOTSTRAP_DISCOVERY_PATH}${suffix}`, {
    method,
    headers,
  });
}

afterEach(() => {
  gateways.splice(0).forEach((gateway) => gateway.close());
  vi.restoreAllMocks();
});

describe("Agent bootstrap discovery", () => {
  it("returns only a fresh non-authorizing offer over an exact local request", async () => {
    const { gateway, discovery } = setup();
    expect(discovery.fetch(request(), "127.0.0.1").status).toBe(503);

    gateway.setEnabled(true);
    const response = discovery.fetch(request(), "::ffff:127.0.0.1");
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(payload).toEqual({
      schema_version: 1,
      service: "semaframe-agent",
      connection_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:8788\/mcp\/connect\/[A-Za-z0-9_-]+$/u),
      gateway_instance_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      toolset_digest: AGENT_TOOLSET_DIGEST,
      offer_status: "waiting",
      approval_required: true,
    });
    expect(JSON.stringify(payload)).not.toMatch(/bearer|approval_token|csrf|browserConnectionId|pairing/u);

    const head = discovery.fetch(request("", { host: "127.0.0.1:8788" }, "HEAD"), "::1");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it("keeps a local launcher on loopback when MCP is advertised through remote HTTPS", async () => {
    const gateway = new AgentGateway({
      publicBaseUrl: "https://agent.example.test",
      bootstrapBaseUrl: BASE_URL,
      workspaceRoot: "/workspace/SemaFrame",
    });
    gateways.push(gateway);
    gateway.setEnabled(true);
    const discovery = createAgentBootstrapDiscoveryHandler(gateway, BASE_URL);
    const payload = await discovery.fetch(request(), "127.0.0.1").json() as {
      connection_url: string;
    };

    expect(payload.connection_url).toMatch(
      /^http:\/\/127\.0\.0\.1:8788\/mcp\/connect\/[A-Za-z0-9_-]{32}$/u,
    );
    expect(payload.connection_url).not.toContain("agent.example.test");
    expect(gateway.getConfig().connectionUrl).toContain("agent.example.test");
  });

  it.each([
    ["foreign peer", "192.168.8.240", { host: "127.0.0.1:8788" }],
    ["host rebinding", "127.0.0.1", { host: "attacker.example" }],
    ["browser origin", "127.0.0.1", { host: "127.0.0.1:8788", origin: "https://attacker.example" }],
    ["forwarded peer", "127.0.0.1", { host: "127.0.0.1:8788", "x-forwarded-for": "127.0.0.1" }],
    ["reverse proxy", "127.0.0.1", { host: "127.0.0.1:8788", forwarded: "for=127.0.0.1" }],
  ])("rejects %s discovery attempts", async (_name, peer, headers) => {
    const { gateway, discovery } = setup();
    gateway.setEnabled(true);
    const response = discovery.fetch(request("", headers), peer);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "bootstrap_discovery_denied",
        message: "Local bootstrap discovery was denied.",
      },
    });
  });

  it("rejects alternate methods and non-exact URLs", () => {
    const { gateway, discovery } = setup();
    gateway.setEnabled(true);
    expect(discovery.fetch(request("", { host: "127.0.0.1:8788" }, "POST"), "127.0.0.1").status).toBe(405);
    expect(discovery.fetch(request("?redirect=https://attacker.example"), "127.0.0.1").status).toBe(404);
  });

  it("strictly validates loopback bases, offer URLs, response size, and response shape", async () => {
    expect(normalizeAgentGatewayUrl("http://localhost:8788/")).toBe("http://localhost:8788");
    expect(() => normalizeAgentGatewayUrl("https://127.0.0.1:8788")).toThrow(/loopback HTTP origin/u);
    expect(() => normalizeAgentGatewayUrl("http://192.168.8.240:8788")).toThrow(/loopback HTTP origin/u);
    expect(() => normalizeAgentGatewayUrl("http://127.0.0.1:8788/path")).toThrow(/loopback HTTP origin/u);
    expect(() => normalizeAgentMcpConnectionUrl("file:///tmp/agent.sock")).toThrow(/MCP offer URL/u);
    expect(() => normalizeAgentMcpConnectionUrl("http://127.0.0.1:8788/not-an-offer/short")).toThrow(/MCP offer URL/u);

    const oversized = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(20_000),
      },
    }));
    await expect(discoverAgentMcpOffer(BASE_URL, { fetch: oversized })).rejects.toMatchObject({
      code: "invalid_discovery_response",
    });

    const withSecret = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schema_version: 1,
      service: "semaframe-agent",
      connection_url: `${BASE_URL}/mcp/connect/${"a".repeat(32)}`,
      gateway_instance_id: "00000000-0000-4000-8000-000000000000",
      toolset_digest: AGENT_TOOLSET_DIGEST,
      offer_status: "waiting",
      approval_required: true,
      pairing_bearer: "must-not-be-accepted",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(discoverAgentMcpOffer(BASE_URL, { fetch: withSecret })).rejects.toBeInstanceOf(
      AgentBootstrapDiscoveryError,
    );

    const crossOriginOffer = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schema_version: 1,
      service: "semaframe-agent",
      connection_url: `https://attacker.example/mcp/connect/${"b".repeat(32)}`,
      gateway_instance_id: "00000000-0000-4000-8000-000000000000",
      toolset_digest: AGENT_TOOLSET_DIGEST,
      offer_status: "waiting",
      approval_required: true,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(discoverAgentMcpOffer(BASE_URL, { fetch: crossOriginOffer })).rejects.toMatchObject({
      code: "invalid_discovery_response",
      message: expect.stringContaining("configured local gateway origin"),
    });
  });

  it("preserves timeout classification when response headers arrive before a stalled body", async () => {
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const delayedBody = vi.fn<typeof fetch>(async (_input, init) => new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          bodyStarted();
          const signal = init?.signal;
          const abort = () => streamController.error(signal?.reason);
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const discovering = discoverAgentMcpOffer(BASE_URL, {
      fetch: delayedBody,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(discovering).rejects.toMatchObject({
      code: "gateway_unavailable",
      message: "SemaFrame discovery timed out.",
    });
  });
});
