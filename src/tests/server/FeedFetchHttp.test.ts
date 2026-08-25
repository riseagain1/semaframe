import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import { createAgentGatewayHttpHandler } from "../../../server/agent/AgentGatewayHttpHandler";
import { FeedFetchApprovalStore } from "../../../server/feed/FeedFetchApprovalStore";
import { FeedFetchRuntime } from "../../../server/feed/FeedFetchRuntime";

const ORIGIN = "http://127.0.0.1:4173";
const PUBLIC_URL = "http://127.0.0.1:8788";
const BROWSER_BOOTSTRAP_TOKEN = "b".repeat(43);
const gateways: AgentGateway[] = [];

function setup(feedApprovalStore?: FeedFetchApprovalStore) {
  const gateway = new AgentGateway({
    publicBaseUrl: PUBLIC_URL,
    workspaceRoot: "/workspace/SemaFrame",
    commandTimeoutMs: 1_000,
    pollTimeoutMs: 1_000,
    browserTtlMs: 5_000,
  });
  gateways.push(gateway);
  const request = vi.fn(async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode("{\"value\":42}"),
  }));
  const feedRuntime = new FeedFetchRuntime({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request,
    now: () => 1_765_765_323_000,
  });
  return {
    gateway,
    request,
    handle: createAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
      browserBootstrapToken: BROWSER_BOOTSTRAP_TOKEN,
      feedRuntime,
      ...(feedApprovalStore ? { feedApprovalStore } : {}),
    }),
  };
}

function approvalRequest(csrfToken: string | undefined, origin = ORIGIN, body: unknown = {
  url: "https://feeds.example.org/data.json",
  format: "auto",
}): Request {
  return new Request(`${PUBLIC_URL}/api/agent/feeds/approval/mint`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN,
      ...(csrfToken ? { "x-semaframe-agent-csrf": csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

function feedRequest(csrfToken: string | undefined, origin = ORIGIN, body: unknown = {
  url: "https://feeds.example.org/data.json",
  format: "auto",
}): Request {
  return new Request(`${PUBLIC_URL}/api/agent/feeds/fetch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN,
      ...(csrfToken ? { "x-semaframe-agent-csrf": csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  gateways.splice(0).forEach((gateway) => gateway.close());
});

describe("Agent Gateway host feed boundary", () => {
  it("requires the existing exact browser Origin and CSRF token", async () => {
    const { handle, request } = setup();
    const configResponse = await handle(new Request(`${PUBLIC_URL}/api/agent/config`, {
      headers: { "x-semaframe-browser-bootstrap": BROWSER_BOOTSTRAP_TOKEN },
    }));
    const config = await configResponse.json() as Record<string, unknown>;
    const csrf = String(config.csrfToken);

    expect(JSON.stringify(config)).not.toContain("feeds.example.org");
    expect((await handle(feedRequest(undefined))).status).toBe(403);
    expect((await handle(approvalRequest(csrf, "https://attacker.example"))).status).toBe(403);
    expect(request).not.toHaveBeenCalled();

    const approvalResponse = await handle(approvalRequest(csrf));
    expect(approvalResponse.status).toBe(200);
    const approval = await approvalResponse.json() as { approvalToken: string };
    expect(approval.approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const response = await handle(feedRequest(csrf, ORIGIN, {
      url: "https://feeds.example.org/data.json",
      format: "auto",
      approvalToken: approval.approvalToken,
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      version: 1,
      finalUrl: "https://feeds.example.org/data.json",
      snapshot: {
        data: { value: 42 },
        stale: false,
        provenance: [{ publisher: "feeds.example.org" }],
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported body fields without reaching the network", async () => {
    const { gateway, handle, request } = setup();
    const response = await handle(feedRequest(gateway.csrfToken, ORIGIN, {
      url: "https://feeds.example.org/data.json",
      headers: { authorization: "Bearer secret" },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Request body contains unsupported fields." },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps host target failures to structured browser errors", async () => {
    const { gateway, handle, request } = setup();
    const response = await handle(approvalRequest(gateway.csrfToken, ORIGIN, {
      url: "https://169.254.169.254/latest/meta-data",
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await response.json()).toMatchObject({
      error: {
        code: "unsafe_feed_target",
        message: expect.any(String),
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("requires one exact single-use URL-and-format approval", async () => {
    const { gateway, handle, request } = setup();
    const missing = await handle(feedRequest(gateway.csrfToken));
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: { code: "feed_approval_required" } });

    const approvalResponse = await handle(approvalRequest(gateway.csrfToken, ORIGIN, {
      url: "https://feeds.example.org/data.json",
      format: "json",
    }));
    const approval = await approvalResponse.json() as { approvalToken: string };

    const mismatch = await handle(feedRequest(gateway.csrfToken, ORIGIN, {
      url: "https://feeds.example.org/other.json",
      format: "json",
      approvalToken: approval.approvalToken,
    }));
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({ error: { code: "feed_approval_invalid" } });
    expect(request).not.toHaveBeenCalled();

    const approvedBody = {
      url: "https://feeds.example.org/data.json",
      format: "json",
      approvalToken: approval.approvalToken,
    };
    expect((await handle(feedRequest(gateway.csrfToken, ORIGIN, approvedBody))).status).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);

    const replay = await handle(feedRequest(gateway.csrfToken, ORIGIN, approvedBody));
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ error: { code: "feed_approval_invalid" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("expires unused approvals before network execution", async () => {
    let now = 1_765_765_323_000;
    const approvals = new FeedFetchApprovalStore({ now: () => now, ttlMs: 1_000 });
    const { gateway, handle, request } = setup(approvals);
    const approvalResponse = await handle(approvalRequest(gateway.csrfToken));
    const approval = await approvalResponse.json() as { approvalToken: string };
    now += 1_000;

    const response = await handle(feedRequest(gateway.csrfToken, ORIGIN, {
      url: "https://feeds.example.org/data.json",
      format: "auto",
      approvalToken: approval.approvalToken,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "feed_approval_expired" } });
    const replay = await handle(feedRequest(gateway.csrfToken, ORIGIN, {
      url: "https://feeds.example.org/data.json",
      format: "auto",
      approvalToken: approval.approvalToken,
    }));
    expect(await replay.json()).toMatchObject({ error: { code: "feed_approval_invalid" } });
    expect(request).not.toHaveBeenCalled();
  });
});
