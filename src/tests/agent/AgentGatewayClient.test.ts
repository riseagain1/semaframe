import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_GATEWAY_COMMAND_NAMES,
  AgentGatewayClient,
  AgentGatewayCommandError,
  AgentGatewayError,
} from "../../agent/AgentGatewayClient";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: status === 204 ? undefined : { "Content-Type": "application/json" },
  });
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    gatewayInstanceId: "gateway-instance-default",
    configRevision: 1,
    enabled: true,
    connected: false,
    engineConnected: false,
    instructionVersion: "2.0",
    csrfToken: "csrf-memory-only",
    ...overrides,
  };
}

const feedRetrievedAt = "2026-08-15T03:04:05.000Z";

function hostFeedResponse(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    requestedUrl: "https://feeds.example.test/market.json",
    finalUrl: "https://cdn.example.test/market.json",
    format: "json",
    contentType: "application/json",
    retrievedAt: feedRetrievedAt,
    outputSchema: { type: "object" },
    snapshot: {
      data: { quote: { price: 188.4 } },
      contentHash: "sha256:test",
      retrievedAt: feedRetrievedAt,
      stale: false,
      provenance: [{
        publisher: "Example Exchange",
        uri: "https://cdn.example.test/market.json",
        retrievedAt: feedRetrievedAt,
      }],
    },
    ...overrides,
  };
}

function feedApproval(
  format: "auto" | "json" | "csv" | "rss" = "auto",
  approvalToken = "a".repeat(43),
) {
  return {
    version: 1,
    approvalToken,
    expiresAt: "2026-08-15T03:04:35.000Z",
    request: {
      url: "https://feeds.example.test/market.json",
      format,
    },
  };
}

const assetDigest = `sha256:${"a".repeat(64)}`;
const assetCandidateHandle = "c".repeat(43);

function assetCandidate(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    candidateHandle: assetCandidateHandle,
    requestId: "asset-request-client-01",
    workspaceId: "workspace_main",
    displayName: "utility-pole.spz",
    format: "spz",
    mediaType: "model/spz",
    byteLength: 4,
    sha256: assetDigest,
    purpose: "generic_import",
    status: "ready",
    expiresAt: "2026-08-21T03:04:35.000Z",
    ...overrides,
  };
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentGatewayClient", () => {
  it("accepts all 34 public commands plus the reconstruction-only internal completion command", () => {
    expect(AGENT_GATEWAY_COMMAND_NAMES).toHaveLength(35);
    expect(AGENT_GATEWAY_COMMAND_NAMES).toContain("read_workspace_resource_snapshot");
    expect(AGENT_GATEWAY_COMMAND_NAMES).toContain("begin_workspace_photo_reconstruction");
    expect(AGENT_GATEWAY_COMMAND_NAMES).toContain("finalize_workspace_photo_reconstruction");
  });

  it("binds the browser-owned Fetch implementation before storing it", async () => {
    const receiverAwareFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse(config({ enabled: false })));
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", receiverAwareFetch);
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-native-fetch",
      handler: vi.fn(),
    });

    await expect(client.fetchConfig()).resolves.toMatchObject({ enabled: false });
    expect(receiverAwareFetch).toHaveBeenCalledOnce();
  });

  it("bounds UI requests that do not carry a caller cancellation signal", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-timeout",
      requestTimeoutMs: 5,
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await expect(client.fetchConfig()).rejects.toMatchObject({
      code: "request_failed",
      message: "The local agent gateway request timed out.",
    });
  });

  it("fetches an explicitly approved host feed with the configured CSRF token without enabling Agent control", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })))
      .mockResolvedValueOnce(jsonResponse(feedApproval()))
      .mockResolvedValueOnce(jsonResponse(hostFeedResponse()));
    const handler = vi.fn();
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-feed-fetch",
      fetch: fetchMock as typeof fetch,
      handler,
    });

    await expect(client.fetchHostFeed({
      url: "  https://feeds.example.test/market.json  ",
      format: "auto",
    })).resolves.toMatchObject({
      version: 1,
      finalUrl: "https://cdn.example.test/market.json",
      snapshot: {
        data: { quote: { price: 188.4 } },
        stale: false,
      },
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/feeds/approval/mint",
      "/api/agent/feeds/fetch",
    ]);
    expect(requestBody(fetchMock, 1)).toEqual({
      url: "https://feeds.example.test/market.json",
      format: "auto",
    });
    expect(requestBody(fetchMock, 2)).toEqual({
      url: "https://feeds.example.test/market.json",
      format: "auto",
      approvalToken: "a".repeat(43),
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-SemaFrame-Agent-CSRF": "csrf-memory-only",
      },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/agent/browser/enable",
      expect.anything(),
    );
  });

  it("refreshes stale CSRF state and retries a host feed exactly once without enabling Agent control", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-before-feed-restart",
        configRevision: 8,
        csrfToken: "csrf-before-feed-restart",
        enabled: false,
      })))
      .mockResolvedValueOnce(jsonResponse(feedApproval("json", "a".repeat(43))))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "csrf_invalid", message: "Browser session expired." },
      }, 403))
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-after-feed-restart",
        configRevision: 1,
        csrfToken: "csrf-after-feed-restart",
        enabled: false,
      })))
      .mockResolvedValueOnce(jsonResponse(feedApproval("json", "b".repeat(43))))
      .mockResolvedValueOnce(jsonResponse(hostFeedResponse()));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-feed-retry",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await expect(client.fetchHostFeed({
      url: "https://feeds.example.test/market.json",
      format: "json",
    })).resolves.toMatchObject({ finalUrl: "https://cdn.example.test/market.json" });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/feeds/approval/mint",
      "/api/agent/feeds/fetch",
      "/api/agent/config",
      "/api/agent/feeds/approval/mint",
      "/api/agent/feeds/fetch",
    ]);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      "X-SemaFrame-Agent-CSRF": "csrf-before-feed-restart",
    });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      "X-SemaFrame-Agent-CSRF": "csrf-before-feed-restart",
    });
    expect((fetchMock.mock.calls[4]?.[1] as RequestInit).headers).toMatchObject({
      "X-SemaFrame-Agent-CSRF": "csrf-after-feed-restart",
    });
    expect((fetchMock.mock.calls[5]?.[1] as RequestInit).headers).toMatchObject({
      "X-SemaFrame-Agent-CSRF": "csrf-after-feed-restart",
    });
    expect(requestBody(fetchMock, 2)).toMatchObject({ approvalToken: "a".repeat(43) });
    expect(requestBody(fetchMock, 5)).toMatchObject({ approvalToken: "b".repeat(43) });
    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/agent/browser/enable")).toHaveLength(0);
  });

  it("rejects a malformed host-feed response before it crosses into workspace state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })))
      .mockResolvedValueOnce(jsonResponse(feedApproval()))
      .mockResolvedValueOnce(jsonResponse(hostFeedResponse({ unexpected: "contract drift" })));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-feed-invalid",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await expect(client.fetchHostFeed({
      url: "https://feeds.example.test/market.json",
    })).rejects.toMatchObject({
      name: "HostFeedContractError",
      message: "feed response contains unsupported field unexpected",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("streams an inspected opaque asset candidate and completes it only after the caller persists it", async () => {
    const bytes = new Uint8Array([0x53, 0x50, 0x5a, 0x04]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({ enabled: true })))
      .mockResolvedValueOnce(jsonResponse(assetCandidate()))
      .mockResolvedValueOnce(new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "model/spz",
          "content-length": "4",
          "x-semaframe-asset-digest": assetDigest,
          "x-semaframe-asset-media-type": "model/spz",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ completed: true }));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-asset-ingress",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    const opened = await client.openAssetCandidate(assetCandidateHandle, "workspace_main");
    expect(opened.descriptor).toEqual(assetCandidate());
    expect(Array.from(new Uint8Array(await new Response(opened.body).arrayBuffer()))).toEqual(Array.from(bytes));
    await client.completeAssetCandidate(assetCandidateHandle, "workspace_main");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/assets/candidates/inspect",
      "/api/agent/assets/candidates/open",
      "/api/agent/assets/candidates/complete",
    ]);
    expect(requestBody(fetchMock, 1)).toEqual({
      candidateHandle: assetCandidateHandle,
      workspaceId: "workspace_main",
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-SemaFrame-Agent-CSRF": "csrf-memory-only",
      },
    });
  });

  it("rejects an asset stream whose digest-bearing headers drift from its inspected descriptor", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    const cancel = vi.spyOn(stream, "cancel");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({ enabled: true })))
      .mockResolvedValueOnce(jsonResponse(assetCandidate()))
      .mockResolvedValueOnce(new Response(stream, {
        headers: {
          "content-type": "model/spz",
          "content-length": "4",
          "x-semaframe-asset-digest": `sha256:${"b".repeat(64)}`,
          "x-semaframe-asset-media-type": "model/spz",
        },
      }));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-asset-header-drift",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await expect(client.openAssetCandidate(assetCandidateHandle, "workspace_main")).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("probes photo reconstruction through the browser-bound CSRF POST route", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })))
      .mockResolvedValueOnce(jsonResponse({
        backend: { id: "apple-object-capture", version: "1" },
        available: true,
      }));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-reconstruction-probe",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await expect(client.getPhotoReconstructionCapability()).resolves.toEqual({
      backend: { id: "apple-object-capture", version: "1" },
      available: true,
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/reconstructions/capability",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-SemaFrame-Agent-CSRF": "csrf-memory-only",
      },
      body: "{}",
    });
  });

  it("serializes overlapping config reads so browser start order cannot invert server observation order", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    let resolveSecond: (response: Response) => void = () => undefined;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondResponse = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockImplementationOnce(() => secondResponse);
    const onConfig = vi.fn();
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-config-order",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
      onConfig,
    });

    const first = client.fetchConfig();
    const second = client.fetchConfig();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    resolveFirst(jsonResponse(config({
      configRevision: 1,
      connectionUrl: "https://scene.test/mcp/connect/first",
      offerExpiresAt: "2099-08-14T08:10:00.000Z",
      offerStatus: "waiting",
    })));
    await expect(first).resolves.toMatchObject({ connectionUrl: "https://scene.test/mcp/connect/first" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    resolveSecond(jsonResponse(config({
      configRevision: 2,
      connectionUrl: "https://scene.test/mcp/connect/second",
      offerExpiresAt: "2099-08-14T08:20:00.000Z",
      offerStatus: "approval_granted",
    })));

    await expect(second).resolves.toMatchObject({ connectionUrl: "https://scene.test/mcp/connect/second" });
    expect(client.config?.connectionUrl).toBe("https://scene.test/mcp/connect/second");
    expect(onConfig).toHaveBeenCalledTimes(2);
  });

  it("does not apply a lower revision from the same gateway instance", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({
        configRevision: 8,
        connectionUrl: "https://scene.test/mcp/connect/fresh",
      })))
      .mockResolvedValueOnce(jsonResponse(config({
        configRevision: 7,
        connectionUrl: "https://scene.test/mcp/connect/stale",
      })));
    const onConfig = vi.fn();
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-server-revision",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
      onConfig,
    });

    await expect(client.fetchConfig()).resolves.toMatchObject({
      configRevision: 8,
      connectionUrl: "https://scene.test/mcp/connect/fresh",
    });
    await expect(client.fetchConfig()).resolves.toMatchObject({
      configRevision: 8,
      connectionUrl: "https://scene.test/mcp/connect/fresh",
    });
    expect(client.config?.connectionUrl).toBe("https://scene.test/mcp/connect/fresh");
    expect(onConfig).toHaveBeenCalledOnce();
  });

  it("adopts a restarted gateway instance and permanently retires the old instance", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-before-restart",
        configRevision: 8,
        connectionUrl: "https://scene.test/mcp/connect/before-restart",
      })))
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-after-restart",
        configRevision: 1,
        csrfToken: "csrf-after-restart",
        connectionUrl: "https://scene.test/mcp/connect/after-restart",
      })))
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-before-restart",
        configRevision: 9,
        connectionUrl: "https://scene.test/mcp/connect/retired-old-gateway",
      })));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-gateway-restart",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await client.fetchConfig();
    await expect(client.fetchConfig()).resolves.toMatchObject({
      gatewayInstanceId: "gateway-after-restart",
      configRevision: 1,
      connectionUrl: "https://scene.test/mcp/connect/after-restart",
    });
    await expect(client.fetchConfig()).resolves.toMatchObject({
      gatewayInstanceId: "gateway-after-restart",
      connectionUrl: "https://scene.test/mcp/connect/after-restart",
    });
    expect(client.config?.csrfToken).toBe("csrf-after-restart");
  });

  it("does not register or poll while external control is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(config({ enabled: false })));
    const handler = vi.fn();
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-01",
      fetch: fetchMock as typeof fetch,
      handler,
    });

    await client.start();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/agent/config");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(client.status).toBe("disabled");
    expect(client.running).toBe(false);
  });

  it("registers, dispatches exact command input, and returns a structured result", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config()))
      .mockResolvedValueOnce(jsonResponse({ browserConnectionId: "browser-connection" }))
      .mockResolvedValueOnce(jsonResponse({
        kind: "command",
        command: {
          id: "command-1",
          name: "inspect_workspace",
          input: { session_token: "session", instruction_digest: "digest" },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ accepted: true }))
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })));
    const handler = vi.fn().mockResolvedValue({ ok: true, data: { workspace_revision: 4 } });
    const statuses: string[] = [];
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-01",
      fetch: fetchMock as typeof fetch,
      handler,
      onStatus: (status) => statuses.push(status),
    });

    await client.start();

    expect(handler).toHaveBeenCalledWith(
      "inspect_workspace",
      { session_token: "session", instruction_digest: "digest" },
      { signal: expect.any(AbortSignal) },
    );
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/browser/register",
      "/api/agent/browser/poll",
      "/api/agent/browser/result",
      "/api/agent/config",
    ]);
    expect(requestBody(fetchMock, 1)).toEqual({ clientInstanceId: "browser-client-01" });
    expect(requestBody(fetchMock, 2)).toEqual({ browserConnectionId: "browser-connection" });
    expect(requestBody(fetchMock, 3)).toEqual({
      browserConnectionId: "browser-connection",
      commandId: "command-1",
      ok: true,
      result: { ok: true, data: { workspace_revision: 4 } },
    });
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      "X-SemaFrame-Agent-CSRF": "csrf-memory-only",
    });
    expect(statuses).toEqual(["waiting", "disabled"]);
  });

  it("returns only safe command failures to the gateway", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({ connected: true, engineConnected: true, clientName: "Codex" })))
      .mockResolvedValueOnce(jsonResponse({ browserConnectionId: "browser-connection" }))
      .mockResolvedValueOnce(jsonResponse({
        kind: "command",
        command: { id: "command-2", name: "submit_workspace_batch", input: {} },
      }))
      .mockResolvedValueOnce(jsonResponse({ accepted: true }))
      .mockResolvedValueOnce(jsonResponse(config({ connected: true, engineConnected: true, clientName: "Codex" })))
      .mockResolvedValueOnce(jsonResponse({ kind: "idle" }))
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })));
    const statuses: string[] = [];
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-02",
      fetch: fetchMock as typeof fetch,
      handler: async () => { throw new Error("private session_token=never-send"); },
      onStatus: (status) => statuses.push(status),
    });

    await client.start();

    const failure = requestBody(fetchMock, 3);
    expect(failure).toEqual({
      browserConnectionId: "browser-connection",
      commandId: "command-2",
      ok: false,
      error: {
        code: "command_failed",
        message: "The browser could not apply the agent command.",
      },
    });
    expect(JSON.stringify(failure)).not.toContain("never-send");
    expect(statuses).toEqual(["connected", "applying", "connected", "disabled"]);
  });

  it("supports explicit safe command errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config()))
      .mockResolvedValueOnce(jsonResponse({ browserConnectionId: "browser-connection" }))
      .mockResolvedValueOnce(jsonResponse({
        kind: "command",
        command: { id: "command-3", name: "begin_workspace_update", input: {} },
      }))
      .mockResolvedValueOnce(jsonResponse({ accepted: true }))
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-03",
      fetch: fetchMock as typeof fetch,
      handler: () => { throw new AgentGatewayCommandError("instructions_required", "Read instructions first."); },
    });

    await client.start();

    expect(requestBody(fetchMock, 3)).toMatchObject({
      ok: false,
      error: { code: "instructions_required", message: "Read instructions first." },
    });
  });

  it("releases a pending long-poll lease on pagehide and clears in-memory connection state", async () => {
    let pollStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { pollStarted = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config()))
      .mockResolvedValueOnce(jsonResponse({ browserConnectionId: "browser-connection" }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        pollStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      });
    const handler = vi.fn();
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-04",
      fetch: fetchMock as typeof fetch,
      handler,
    });

    const running = client.start();
    await started;
    globalThis.dispatchEvent(new Event("pagehide"));
    await running;

    expect(handler).not.toHaveBeenCalled();
    expect(client.status).toBe("disconnected");
    expect(client.config).toBeUndefined();
    expect(client.running).toBe(false);
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/agent/browser/unregister");
    expect(requestBody(fetchMock, 3)).toEqual({ browserConnectionId: "browser-connection" });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
    });
  });

  it("supports finite normal claim and explicit takeover before starting the poll loop", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config()))
      .mockResolvedValueOnce(jsonResponse({ browserConnectionId: "claimed-browser-connection" }))
      .mockResolvedValueOnce(jsonResponse(config({ engineConnected: true })))
      .mockResolvedValueOnce(jsonResponse(config({ engineConnected: true })))
      .mockResolvedValueOnce(jsonResponse({ kind: "idle" }))
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })))
      .mockResolvedValueOnce(jsonResponse(config()))
      .mockResolvedValueOnce(jsonResponse({ browserConnectionId: "takeover-browser-connection" }))
      .mockResolvedValueOnce(jsonResponse(config({ engineConnected: true })));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-claim",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await expect(client.claimBrowser()).resolves.toMatchObject({ engineConnected: true });
    await client.start();
    await client.fetchConfig();
    await expect(client.takeover()).resolves.toMatchObject({ engineConnected: true });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/browser/register",
      "/api/agent/config",
      "/api/agent/config",
      "/api/agent/browser/poll",
      "/api/agent/config",
      "/api/agent/config",
      "/api/agent/browser/takeover",
      "/api/agent/config",
    ]);
    expect(requestBody(fetchMock, 1)).toEqual({ clientInstanceId: "browser-client-claim" });
    expect(requestBody(fetchMock, 7)).toEqual({ clientInstanceId: "browser-client-claim" });
  });

  it("coalesces concurrent normal claims before starting one poll loop", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config()))
      .mockResolvedValueOnce(jsonResponse({ browserConnectionId: "claimed-browser-connection" }))
      .mockResolvedValueOnce(jsonResponse(config({ engineConnected: true })))
      .mockResolvedValueOnce(jsonResponse(config({ engineConnected: true })))
      .mockResolvedValueOnce(jsonResponse({ kind: "idle" }))
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-single-flight",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    const [first, second] = await Promise.all([client.claimBrowser(), client.claimBrowser()]);
    expect(first).toEqual(second);
    await Promise.all([client.start(), client.start()]);

    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/agent/browser/register")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/agent/browser/poll")).toHaveLength(1);
  });

  it("exposes the gateway error code so an active-tab conflict is not confused with every 409", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config()))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "browser_already_connected",
          message: "Another tab owns the browser engine.",
        },
      }, 409));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-conflict",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await expect(client.claimBrowser()).rejects.toMatchObject({
      code: "request_failed",
      status: 409,
      gatewayCode: "browser_already_connected",
    });
  });

  it("enables through a CSRF-protected POST before exposing setup", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({ enabled: false })))
      .mockResolvedValueOnce(jsonResponse({ enabled: true }))
      .mockResolvedValueOnce(jsonResponse(config({ enabled: true })))
      .mockResolvedValueOnce(jsonResponse({
        pairingBearer: "pair-secret",
        mcpConfig: "secret ready-to-paste config",
        restConfig: "secret REST config",
        restEndpoint: "https://scene.test/mcp",
      }));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-05",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await client.enable();
    const pairing = await client.revealPairing();

    expect(pairing.mcpConfig).toBe("secret ready-to-paste config");
    expect(pairing.restConfig).toBe("secret REST config");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/browser/enable",
      "/api/agent/config",
      "/api/agent/browser/reveal",
    ]);
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("csrf-memory-only");
    expect(String(fetchMock.mock.calls[3]?.[0])).not.toContain("pair-secret");
    expect(storageSpy).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("atomically adopts the complete config returned by pairing rotation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({
        connected: true,
        clientName: "Connected client",
        clientScopes: ["workspace:read"],
        connectionUrl: "https://scene.test/mcp/connect/old-pairing",
        offerExpiresAt: "2026-08-14T08:10:00.000Z",
        offerStatus: "approved",
      })))
      .mockResolvedValueOnce(jsonResponse({
        ...config({
          configRevision: 2,
          connectionUrl: "https://scene.test/mcp/connect/new-pairing",
          offerExpiresAt: "2026-08-14T08:20:00.000Z",
          offerStatus: "waiting",
        }),
        pairingBearer: "rotated-pair-secret",
        mcpConfig: "rotated ready-to-paste config",
        restConfig: "rotated REST config",
        restEndpoint: "https://scene.test/v1",
      }));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-pairing-rotation",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await client.fetchConfig();
    const rotation = await client.rotatePairing();

    expect(rotation.pairingBearer).toBe("rotated-pair-secret");
    expect(rotation.config).toMatchObject({
      connected: false,
      connectionUrl: "https://scene.test/mcp/connect/new-pairing",
      offerStatus: "waiting",
    });
    expect(client.config).not.toHaveProperty("clientName");
    expect(client.config).not.toHaveProperty("clientScopes");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/browser/rotate",
    ]);
  });

  it("refreshes an expiring connection offer and approves an exact pending claim", async () => {
    const pendingApproval = {
      claimId: "claim-01",
      clientId: "client-01",
      clientName: "Codex",
      scopes: ["workspace:read", "workspace:write"],
      fingerprint: "9e:12:ab",
      requestedAt: "2026-08-14T08:00:00.000Z",
      expiresAt: "2026-08-14T08:05:00.000Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({
        connectionUrl: "https://relay.test/p/offer-1/mcp",
        offerExpiresAt: "2026-08-14T08:10:00.000Z",
        offerStatus: "approval_pending",
        pendingApproval,
      })))
      .mockResolvedValueOnce(jsonResponse(config({
        configRevision: 2,
        connectionUrl: "https://relay.test/p/offer-2/mcp",
        offerExpiresAt: "2026-08-14T08:20:00.000Z",
        offerStatus: "waiting",
      })))
      .mockResolvedValueOnce(jsonResponse({ offerStatus: "approved" }))
      .mockResolvedValueOnce(jsonResponse(config({
        configRevision: 3,
        connectionUrl: "https://relay.test/p/offer-2/mcp",
        offerExpiresAt: "2026-08-14T08:20:00.000Z",
        offerStatus: "approved",
        clientScopes: ["workspace:read", "workspace:write"],
      })));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-offer",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    const initial = await client.fetchConfig();
    expect(initial.pendingApproval).toEqual(pendingApproval);
    await expect(client.refreshOffer()).resolves.toMatchObject({
      connectionUrl: "https://relay.test/p/offer-2/mcp",
      offerStatus: "waiting",
    });
    expect(client.config).not.toHaveProperty("pendingApproval");
    await expect(client.approveClaim("claim-01")).resolves.toMatchObject({
      offerStatus: "approved",
      clientScopes: ["workspace:read", "workspace:write"],
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/browser/offer/refresh",
      "/api/agent/browser/approval/approve",
      "/api/agent/config",
    ]);
    expect(requestBody(fetchMock, 2)).toEqual({ claimId: "claim-01" });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      "X-SemaFrame-Agent-CSRF": "csrf-memory-only",
    });
  });

  it("atomically replaces an established connection without a follow-up config read", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({
        connected: true,
        engineConnected: true,
        clientName: "Established client",
        clientScopes: ["workspace:read", "workspace:write"],
        connectionUrl: "https://relay.test/mcp/connect/offer-old",
        offerExpiresAt: "2026-08-14T08:10:00.000Z",
        offerStatus: "approved",
      })))
      .mockResolvedValueOnce(jsonResponse(config({
        configRevision: 2,
        connectionUrl: "https://relay.test/mcp/connect/offer-fresh",
        offerExpiresAt: "2026-08-14T08:20:00.000Z",
        offerStatus: "waiting",
      })));
    const onConfig = vi.fn();
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-refresh-failure",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
      onConfig,
    });

    await client.fetchConfig();
    await expect(client.refreshOffer()).resolves.toMatchObject({
      connected: false,
      connectionUrl: "https://relay.test/mcp/connect/offer-fresh",
    });

    expect(client.config).toMatchObject({
      connected: false,
      connectionUrl: "https://relay.test/mcp/connect/offer-fresh",
      offerExpiresAt: "2026-08-14T08:20:00.000Z",
      offerStatus: "waiting",
    });
    expect(client.config).not.toHaveProperty("pendingApproval");
    expect(client.config).not.toHaveProperty("clientName");
    expect(client.config).not.toHaveProperty("clientScopes");
    expect(onConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      connectionUrl: "https://relay.test/mcp/connect/offer-fresh",
    }));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/browser/offer/refresh",
    ]);
  });

  it("recovers one refresh action across a gateway restart and stale CSRF token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-before-restart",
        configRevision: 8,
        connectionUrl: "https://scene.test/mcp/connect/dead-after-restart",
        offerExpiresAt: "2026-08-14T08:10:00.000Z",
        offerStatus: "waiting",
      })))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "csrf_invalid", message: "Browser session expired." },
      }, 403))
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-after-restart",
        configRevision: 1,
        csrfToken: "csrf-after-restart",
        enabled: false,
      })))
      .mockResolvedValueOnce(jsonResponse({ enabled: true }))
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-after-restart",
        configRevision: 2,
        csrfToken: "csrf-after-restart",
        connectionUrl: "https://scene.test/mcp/connect/restarted-initial",
        offerExpiresAt: "2026-08-14T08:20:00.000Z",
        offerStatus: "waiting",
      })))
      .mockResolvedValueOnce(jsonResponse(config({
        gatewayInstanceId: "gateway-after-restart",
        configRevision: 3,
        csrfToken: "csrf-after-restart",
        connectionUrl: "https://scene.test/mcp/connect/restarted-fresh",
        offerExpiresAt: "2026-08-14T08:30:00.000Z",
        offerStatus: "waiting",
      })));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-restart-refresh",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await client.fetchConfig();
    await expect(client.refreshOffer()).resolves.toMatchObject({
      gatewayInstanceId: "gateway-after-restart",
      configRevision: 3,
      connectionUrl: "https://scene.test/mcp/connect/restarted-fresh",
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/browser/offer/refresh",
      "/api/agent/config",
      "/api/agent/browser/enable",
      "/api/agent/config",
      "/api/agent/browser/offer/refresh",
    ]);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      "X-SemaFrame-Agent-CSRF": "csrf-memory-only",
    });
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).headers).toMatchObject({
      "X-SemaFrame-Agent-CSRF": "csrf-after-restart",
    });
    expect((fetchMock.mock.calls[5]?.[1] as RequestInit).headers).toMatchObject({
      "X-SemaFrame-Agent-CSRF": "csrf-after-restart",
    });
  });

  it("rejects cross-origin endpoints and malformed configuration responses", async () => {
    expect(() => new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-06",
      fetch: vi.fn() as typeof fetch,
      handler: vi.fn(),
      endpoints: { poll: "https://attacker.test/poll" },
    })).toThrow(AgentGatewayError);

    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-07",
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        ...config(),
        engineConnected: undefined,
      })) as typeof fetch,
      handler: vi.fn(),
    });
    await expect(client.fetchConfig()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("mints the explicit Accessibility HostAction proof without broadening the action allowlist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config()))
      .mockResolvedValueOnce(jsonResponse({
        token: "h".repeat(43),
        expiresAtMs: Date.now() + 30_000,
      }));
    const client = new AgentGatewayClient({
      origin: "https://scene.test",
      clientInstanceId: "browser-client-accessibility-host-action",
      fetch: fetchMock as typeof fetch,
      handler: vi.fn(),
    });

    await expect(client.mintVoiceRelayHostAction("voice_relay_accessibility")).resolves.toMatchObject({
      token: "h".repeat(43),
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/agent/config",
      "/api/agent/host-actions/voice-relay/mint",
    ]);
    expect(requestBody(fetchMock, 1)).toEqual({ action: "voice_relay_accessibility" });
    await expect(client.mintVoiceRelayHostAction("forged" as "voice_relay_arm"))
      .rejects.toMatchObject({ code: "invalid_configuration" });
  });
});
