import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentGateway } from "../../../../server/agent/AgentGateway";
import {
  createAgentGatewayHttpHandler,
  type AgentGatewayFetchHandler,
} from "../../../../server/agent/AgentGatewayHttpHandler";
import { DEFAULT_WORKSPACE_AGENT_SCOPES } from "../../../workspace/agents/contracts";

const ORIGIN = "http://127.0.0.1:4173";
const PUBLIC_URL = "http://127.0.0.1:8788";
const BROWSER_BOOTSTRAP_TOKEN = "b".repeat(43);
const clients: Client[] = [];
const handlers: AgentGatewayFetchHandler[] = [];
const gateways: AgentGateway[] = [];

function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
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

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(handlers.splice(0).map((handler) => handler.close()));
  gateways.splice(0).forEach((gateway) => gateway.close());
});

describe("Workspace MCP connection offer", () => {
  it.each([
    {
      label: "omitted scopes use the exact Workspace defaults",
      requestedScopes: undefined,
      expectedScopes: [...DEFAULT_WORKSPACE_AGENT_SCOPES].sort(),
    },
    {
      label: "an explicit Workspace subset remains exact",
      requestedScopes: ["workspace:read", "component:create"],
      expectedScopes: ["component:create", "workspace:read"],
    },
    {
      label: "an explicit empty scope list remains empty",
      requestedScopes: [],
      expectedScopes: [],
    },
  ])("completes approval when $label", async ({ requestedScopes, expectedScopes }) => {
    const gateway = new AgentGateway({
      publicBaseUrl: PUBLIC_URL,
      workspaceRoot: "/workspace/SemaFrame",
      commandTimeoutMs: 2_000,
      pollTimeoutMs: 100,
      browserTtlMs: 5_000,
      offerTtlMs: 10_000,
      approvalTtlMs: 5_000,
    });
    const handle = createAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
      browserBootstrapToken: BROWSER_BOOTSTRAP_TOKEN,
    });
    gateways.push(gateway);
    handlers.push(handle);

    const initial = await payload(await handle(browserConfigRequest()));
    const csrfToken = String(initial.csrfToken);
    await browserPost(handle, csrfToken, "/api/agent/browser/enable", {});
    const config = await payload(await handle(browserConfigRequest()));
    const registration = await payload(await browserPost(
      handle,
      csrfToken,
      "/api/agent/browser/register",
      { clientInstanceId: `workspace-offer-browser-${clients.length + 1}` },
    ));
    const browserConnectionId = String(registration.browserConnectionId);

    const client = new Client(
      { name: "workspace-offer-agent", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 2_000 } } },
    );
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(String(config.connectionUrl)), {
      fetch: (input, init) => {
        const { signal: _signal, ...requestInit } = init ?? {};
        return handle(new Request(input, requestInit));
      },
    });
    await client.connect(transport);

    const first = await client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "jarvis",
        client_name: "JARVIS",
        ...(requestedScopes === undefined ? {} : { requested_scopes: requestedScopes }),
      },
    });
    const firstError = (first.structuredContent as {
      error: {
        code: string;
        details: { approval_token: string; claim_id: string; requested_scopes: string[] };
      };
    }).error;
    expect(firstError.code).toBe("approval_pending");
    expect(firstError.details.approval_token.length).toBeGreaterThanOrEqual(32);
    expect(firstError.details.requested_scopes).toEqual(expectedScopes);

    await browserPost(handle, csrfToken, "/api/agent/browser/approval/approve", {
      claimId: firstError.details.claim_id,
    });
    const guidePromise = client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "attempted-identity-replacement",
        client_name: "Attempted replacement",
        approval_token: firstError.details.approval_token,
      },
    });

    let polled = await payload(await browserPost(handle, csrfToken, "/api/agent/browser/poll", {
      browserConnectionId,
    }));
    if (polled.kind === "idle") {
      polled = await payload(await browserPost(handle, csrfToken, "/api/agent/browser/poll", {
        browserConnectionId,
      }));
    }
    const command = polled.command as Record<string, unknown>;
    expect(command.name).toBe("get_workspace_instructions");
    expect(command.input).toEqual(expect.objectContaining({
      client_id: "jarvis",
      client_name: "JARVIS",
      requested_scopes: expectedScopes,
    }));
    expect(JSON.stringify(command.input)).not.toContain(firstError.details.approval_token);

    const coreResult = {
      ok: true,
      data: {
        session_token: "workspace_session_offer_test",
        guide_digest: "sha256:workspace-offer-guide",
        requested_scopes: expectedScopes,
        granted_scopes: expectedScopes,
        denied_scopes: [],
      },
    };
    await browserPost(handle, csrfToken, "/api/agent/browser/result", {
      browserConnectionId,
      commandId: command.id,
      ok: true,
      result: coreResult,
    });
    const guide = await guidePromise;
    expect(guide.isError).toBe(false);
    expect(guide.structuredContent).toEqual(coreResult);
    expect(await payload(await handle(browserConfigRequest()))).toEqual(
      expect.objectContaining({
        connected: true,
        clientName: "JARVIS",
        clientScopes: expectedScopes,
        offerStatus: "approved",
      }),
    );

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "begin_workspace_asset_import",
      "begin_workspace_photo_reconstruction",
      "begin_workspace_update",
      "cancel_workspace_asset_import",
      "cancel_workspace_photo_reconstruction",
      "complete_workspace_asset_import",
      "finalize_workspace_photo_reconstruction",
      "get_workspace_instructions",
      "inspect_workspace",
      "inspect_workspace_asset",
      "inspect_workspace_component",
      "inspect_workspace_model",
      "inspect_workspace_photo_reconstruction",
      "inspect_workspace_physics",
      "inspect_workspace_space",
      "query_spatial_placement",
      "query_stable_placement",
      "read_workspace_events",
      "read_workspace_resource_snapshot",
      "redo_workspace_batch",
      "simulate_workspace_physics",
      "start_workspace_photo_reconstruction",
      "submit_workspace_batch",
      "undo_workspace_batch",
    ]);
    expect(await payload(await browserPost(handle, csrfToken, "/api/agent/browser/poll", {
      browserConnectionId,
    }))).toEqual({ kind: "idle" });
  });
});
