import { afterEach, describe, expect, it } from "vitest";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import { createAgentGatewayHttpHandler } from "../../../server/agent/AgentGatewayHttpHandler";

const ORIGIN = "http://127.0.0.1:4173";
const PUBLIC_URL = "http://127.0.0.1:8788";
const gateways: AgentGateway[] = [];

function setup(options: {
  commandTimeoutMs?: number;
  browserTtlMs?: number;
  now?: () => number;
} = {}) {
  const gateway = new AgentGateway({
    publicBaseUrl: PUBLIC_URL,
    workspaceRoot: "/workspace/SemaFrame",
    commandTimeoutMs: options.commandTimeoutMs ?? 1_000,
    pollTimeoutMs: 1_000,
    browserTtlMs: options.browserTtlMs ?? 5_000,
    ...(options.now ? { now: options.now } : {}),
  });
  gateways.push(gateway);
  return {
    gateway,
    handle: createAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
    }),
  };
}

function jsonRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function browserPost(
  handle: (request: Request) => Promise<Response>,
  csrfToken: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return handle(jsonRequest(path, body, { origin: ORIGIN, "x-semaframe-agent-csrf": csrfToken }));
}

async function browserSetup(handle: (request: Request) => Promise<Response>) {
  const configResponse = await handle(new Request(`${PUBLIC_URL}/api/agent/config`));
  const config = await json(configResponse);
  const csrfToken = String(config.csrfToken);
  await browserPost(handle, csrfToken, "/api/agent/browser/enable", {});
  const pairing = await json(await browserPost(handle, csrfToken, "/api/agent/browser/reveal", {}));
  const registration = await json(await browserPost(handle, csrfToken, "/api/agent/browser/register", {
    clientInstanceId: "browser-test-1234",
  }));
  return {
    csrfToken,
    bearer: String(pairing.pairingBearer),
    pairing,
    browserConnectionId: String(registration.browserConnectionId),
  };
}

afterEach(() => {
  gateways.splice(0).forEach((gateway) => gateway.close());
});

describe("Agent Gateway browser boundary", () => {
  it("allows originless same-origin config fetches but rejects a present foreign Origin", async () => {
    const { handle } = setup();
    const response = await handle(new Request(`${PUBLIC_URL}/api/agent/config`));
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual(expect.objectContaining({
      version: 1,
      gatewayInstanceId: expect.any(String),
      configRevision: expect.any(Number),
      enabled: false,
      connected: false,
      engineConnected: false,
      instructionVersion: "2.6",
      csrfToken: expect.any(String),
    }));
    expect(JSON.stringify(payload)).not.toMatch(/pairing|bearer|mcpServers/u);

    const foreign = await handle(new Request(`${PUBLIC_URL}/api/agent/config`, {
      headers: { origin: "https://attacker.example" },
    }));
    expect(foreign.status).toBe(403);
  });

  it("returns complete revisioned config snapshots from offer and pairing rotation", async () => {
    const { handle } = setup();
    const initial = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    const csrf = String(initial.csrfToken);
    await browserPost(handle, csrf, "/api/agent/browser/enable", {});
    const before = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));

    const refreshed = await json(await browserPost(handle, csrf, "/api/agent/browser/offer/refresh", {}));
    expect(Number(refreshed.configRevision)).toBeGreaterThan(Number(before.configRevision));
    expect(refreshed.connectionUrl).not.toBe(before.connectionUrl);

    const after = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    expect(after).toEqual(expect.objectContaining({
      configRevision: refreshed.configRevision,
      connectionUrl: refreshed.connectionUrl,
      offerStatus: "waiting",
    }));

    const rotated = await json(await browserPost(handle, csrf, "/api/agent/browser/rotate", {}));
    expect(rotated).toEqual(expect.objectContaining({
      pairingBearer: expect.any(String),
      gatewayInstanceId: before.gatewayInstanceId,
      enabled: true,
      connected: false,
      offerStatus: "waiting",
    }));
    expect(Number(rotated.configRevision)).toBeGreaterThan(Number(after.configRevision));
    expect(rotated.connectionUrl).not.toBe(after.connectionUrl);
    const afterRotation = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    expect(afterRotation).toEqual(expect.objectContaining({
      configRevision: rotated.configRevision,
      connectionUrl: rotated.connectionUrl,
    }));
  });

  it("reveals a ready-to-paste ephemeral setup only with exact Origin and CSRF", async () => {
    const { handle } = setup();
    const config = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    const csrf = String(config.csrfToken);

    expect((await handle(jsonRequest("/api/agent/browser/reveal", {}, {
      origin: ORIGIN,
    }))).status).toBe(403);
    expect((await handle(jsonRequest("/api/agent/browser/reveal", {}, {
      "x-semaframe-agent-csrf": csrf,
    }))).status).toBe(403);
    expect((await browserPost(handle, csrf, "/api/agent/browser/reveal", {})).status).toBe(503);
    expect((await browserPost(handle, csrf, "/api/agent/browser/register", {
      clientInstanceId: "browser-test-1234",
    })).status).toBe(503);
    await browserPost(handle, csrf, "/api/agent/browser/enable", {});

    const response = await browserPost(handle, csrf, "/api/agent/browser/reveal", {});
    const payload = await json(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.restEndpoint).toBe(`${PUBLIC_URL}/v1`);
    expect(String(payload.mcpConfig)).toContain('"--silent"');
    expect(String(payload.mcpConfig)).toContain('"/workspace/SemaFrame"');
    expect(String(payload.mcpConfig)).toContain(String(payload.pairingBearer));
    expect(response.url).not.toContain(String(payload.pairingBearer));
  });

  it("fails external calls closed while no browser engine is registered", async () => {
    const { handle } = setup();
    const config = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    await browserPost(handle, String(config.csrfToken), "/api/agent/browser/enable", {});
    const pairing = await json(await browserPost(
      handle,
      String(config.csrfToken),
      "/api/agent/browser/reveal",
      {},
    ));
    const response = await handle(jsonRequest("/v1/workspace/instructions", {}, {
      authorization: `Bearer ${String(pairing.pairingBearer)}`,
    }));
    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({
      error: {
        code: "engine_unavailable",
        message: "Open SemaFrame before calling Workspace tools.",
      },
    });
  });

  it("bridges one instruction-first REST call through browser poll/result", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);
    const waitingConfig = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    expect(waitingConfig).toEqual(expect.objectContaining({ engineConnected: true, connected: false }));
    const pollPromise = browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
      browserConnectionId: browser.browserConnectionId,
    });
    const externalPromise = handle(jsonRequest("/v1/workspace/instructions", {
      client_id: "test-agent",
      client_name: "Test Agent",
    }, {
      authorization: `Bearer ${browser.bearer}`,
    }));

    const poll = await json(await pollPromise);
    const connectedConfig = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    expect(connectedConfig).toEqual(expect.objectContaining({
      engineConnected: true,
      connected: false,
    }));
    expect(connectedConfig.clientName).toBeUndefined();
    expect(poll.kind).toBe("command");
    const command = poll.command as Record<string, unknown>;
    expect(command).toEqual(expect.objectContaining({
      id: expect.any(String),
      name: "get_workspace_instructions",
      input: { client_id: "test-agent", client_name: "Test Agent" },
    }));
    expect(JSON.stringify(command)).not.toContain(browser.bearer);

    const coreResult = {
      ok: true,
      data: {
        session_token: "agent_session_example",
        guide_digest: "sha256:guide",
      },
    };
    const resultResponse = await browserPost(handle, browser.csrfToken, "/api/agent/browser/result", {
      browserConnectionId: browser.browserConnectionId,
      commandId: command.id,
      ok: true,
      result: coreResult,
    });
    expect(resultResponse.status).toBe(200);
    const external = await externalPromise;
    expect(external.status).toBe(200);
    expect(await json(external)).toEqual(coreResult);
    const completedConfig = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    expect(completedConfig).toEqual(expect.objectContaining({
      engineConnected: true,
      connected: true,
      clientName: "Test Agent",
    }));
  });

  it("does not expose any retired Scene REST route", async () => {
    const { gateway, handle } = setup();
    gateway.setEnabled(true);
    const bearer = gateway.revealPairing().pairingBearer;
    for (const path of [
      "/v1/instructions",
      "/v1/updates/begin",
      "/v1/updates/submit",
      "/v1/scene/inspect",
      "/v1/scene/undo",
      "/v1/scene/redo",
    ]) {
      const response = await handle(jsonRequest(path, {}, {
        authorization: `Bearer ${bearer}`,
      }));
      expect(response.status, path).toBe(404);
    }
  });

  it("bridges exact targeted Workspace component inspection through the browser engine", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);
    const pollPromise = browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
      browserConnectionId: browser.browserConnectionId,
    });
    const externalPromise = handle(jsonRequest("/v1/workspace/components/inspect", {
      session_token: "workspace_session_example",
      instruction_digest: "workspace_guide_digest",
      component_id: "CMP_TARGET_061",
    }, {
      authorization: `Bearer ${browser.bearer}`,
    }));

    const poll = await json(await pollPromise);
    const command = poll.command as Record<string, unknown>;
    expect(command).toMatchObject({
      name: "inspect_workspace_component",
      input: {
        session_token: "workspace_session_example",
        instruction_digest: "workspace_guide_digest",
        component_id: "CMP_TARGET_061",
      },
    });
    const coreResult = {
      ok: true,
      data: {
        workspace_id: "workspace_main",
        workspace_revision: 17,
        component: { id: "CMP_TARGET_061" },
      },
    };
    await browserPost(handle, browser.csrfToken, "/api/agent/browser/result", {
      browserConnectionId: browser.browserConnectionId,
      commandId: command.id,
      ok: true,
      result: coreResult,
    });
    const external = await externalPromise;
    expect(external.status).toBe(200);
    expect(await json(external)).toEqual(coreResult);
  });

  it("bridges exact Reality Asset and model inspection through the public REST surface", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);
    const cases = [
      {
        path: "/v1/workspace/assets/inspect",
        body: {
          session_token: "workspace_session_example",
          instruction_digest: "workspace_guide_digest",
          asset_id: `ra_${"a".repeat(64)}`,
        },
        name: "inspect_workspace_asset",
      },
      {
        path: "/v1/workspace/models/inspect",
        body: {
          session_token: "workspace_session_example",
          instruction_digest: "workspace_guide_digest",
          model_id: "com.example.fixture",
          version: "1.0.0",
        },
        name: "inspect_workspace_model",
      },
    ] as const;

    for (const entry of cases) {
      const pollPromise = browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
        browserConnectionId: browser.browserConnectionId,
      });
      const externalPromise = handle(jsonRequest(entry.path, entry.body, {
        authorization: `Bearer ${browser.bearer}`,
      }));
      const poll = await json(await pollPromise);
      const command = poll.command as Record<string, unknown>;
      expect(command).toMatchObject({ name: entry.name, input: entry.body });
      const coreResult = { ok: true, data: { inspected: entry.name } };
      await browserPost(handle, browser.csrfToken, "/api/agent/browser/result", {
        browserConnectionId: browser.browserConnectionId,
        commandId: command.id,
        ok: true,
        result: coreResult,
      });
      const external = await externalPromise;
      expect(external.status).toBe(200);
      expect(await json(external)).toEqual(coreResult);
    }
  });

  it("requires explicit session and instruction tokens in closed update inputs", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);
    const missingHandshake = await handle(jsonRequest("/v1/workspace/updates/begin", {
      intent: "Add a table",
    }, { authorization: `Bearer ${browser.bearer}` }));
    expect(missingHandshake.status).toBe(400);
    expect((await json(missingHandshake)).error).toEqual(expect.objectContaining({ code: "invalid_request" }));

    const extra = await handle(jsonRequest("/v1/workspace/inspect", {
      session_token: "agent_session_example",
      instruction_digest: "sha256:guide",
      unexpected: true,
    }, { authorization: `Bearer ${browser.bearer}` }));
    expect(extra.status).toBe(400);

    const missingRevision = await handle(jsonRequest("/v1/workspace/undo", {
      session_token: "agent_session_example",
      instruction_digest: "sha256:guide",
    }, { authorization: `Bearer ${browser.bearer}` }));
    expect(missingRevision.status).toBe(400);

    const invalidComponentId = await handle(jsonRequest("/v1/workspace/components/inspect", {
      session_token: "workspace_session_example",
      instruction_digest: "workspace_guide_digest",
      component_id: "bad component id",
    }, { authorization: `Bearer ${browser.bearer}` }));
    expect(invalidComponentId.status).toBe(400);

    const invalidAssetId = await handle(jsonRequest("/v1/workspace/assets/inspect", {
      session_token: "workspace_session_example",
      instruction_digest: "workspace_guide_digest",
      asset_id: "ra_not-a-digest",
    }, { authorization: `Bearer ${browser.bearer}` }));
    expect(invalidAssetId.status).toBe(400);

    const invalidModelVersion = await handle(jsonRequest("/v1/workspace/models/inspect", {
      session_token: "workspace_session_example",
      instruction_digest: "workspace_guide_digest",
      model_id: "com.example.fixture",
      version: "latest",
    }, { authorization: `Bearer ${browser.bearer}` }));
    expect(invalidModelVersion.status).toBe(400);
  });

  it("expires stale browser registrations instead of resurrecting them", async () => {
    let currentTime = 10_000;
    const { handle } = setup({ browserTtlMs: 100, now: () => currentTime });
    const browser = await browserSetup(handle);
    currentTime += 101;

    const config = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    expect(config).toEqual(expect.objectContaining({ enabled: true, engineConnected: false }));
    const poll = await browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
      browserConnectionId: browser.browserConnectionId,
    });
    expect(poll.status).toBe(409);
    expect((await json(poll)).error).toEqual(expect.objectContaining({ code: "connection_invalid" }));
  });

  it("releases an aborted long-poll lease immediately so a closed tab cannot block a new one", async () => {
    let currentTime = 10_000;
    const { gateway, handle } = setup({ browserTtlMs: 60_000, now: () => currentTime });
    const browser = await browserSetup(handle);
    const controller = new AbortController();
    const abandonedPoll = gateway.pollBrowser(browser.browserConnectionId, controller.signal);

    controller.abort();
    await expect(abandonedPoll).resolves.toEqual({ kind: "idle" });

    // No fake-time advance: release comes from the closed HTTP poll rather
    // than waiting for the browser TTL.
    const replacement = await browserPost(handle, browser.csrfToken, "/api/agent/browser/register", {
      clientInstanceId: "replacement-browser-tab",
    });
    expect(replacement.status).toBe(200);
    expect(await json(replacement)).toEqual({ browserConnectionId: expect.any(String) });
    expect(currentTime).toBe(10_000);
  });

  it("rejects every implicit active-tab replacement, including a duplicated stable tab identity", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);

    const conflicting = await browserPost(handle, browser.csrfToken, "/api/agent/browser/register", {
      clientInstanceId: "different-browser-tab",
    });
    expect(conflicting.status).toBe(409);
    expect((await json(conflicting)).error).toEqual(expect.objectContaining({
      code: "browser_already_connected",
    }));

    const duplicatedIdentity = await browserPost(handle, browser.csrfToken, "/api/agent/browser/register", {
      clientInstanceId: "browser-test-1234",
    });
    expect(duplicatedIdentity.status).toBe(409);
    expect((await json(duplicatedIdentity)).error).toEqual(expect.objectContaining({
      code: "browser_already_connected",
    }));
  });

  it("unregisters only the exact browser lease and is idempotent for stale page-teardown requests", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);
    const unrelatedId = "x".repeat(43);

    const unrelated = await browserPost(handle, browser.csrfToken, "/api/agent/browser/unregister", {
      browserConnectionId: unrelatedId,
    });
    expect(unrelated.status).toBe(200);
    expect(await json(unrelated)).toEqual({ unregistered: false });
    expect(await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)))).toMatchObject({
      engineConnected: true,
    });

    const released = await browserPost(handle, browser.csrfToken, "/api/agent/browser/unregister", {
      browserConnectionId: browser.browserConnectionId,
    });
    expect(released.status).toBe(200);
    expect(await json(released)).toEqual({ unregistered: true });

    const repeated = await browserPost(handle, browser.csrfToken, "/api/agent/browser/unregister", {
      browserConnectionId: browser.browserConnectionId,
    });
    expect(await json(repeated)).toEqual({ unregistered: false });
  });

  it("allows an explicit CSRF-protected takeover without rotating agent access", async () => {
    const { gateway, handle } = setup();
    const browser = await browserSetup(handle);
    const originalOfferUrl = String(browser.pairing.connectionUrl);

    const withoutCsrf = await handle(jsonRequest("/api/agent/browser/takeover", {
      clientInstanceId: "replacement-browser-tab",
    }, { origin: ORIGIN }));
    expect(withoutCsrf.status).toBe(403);

    const takeover = await browserPost(handle, browser.csrfToken, "/api/agent/browser/takeover", {
      clientInstanceId: "replacement-browser-tab",
    });
    expect(takeover.status).toBe(200);
    const replacement = await json(takeover);
    expect(replacement.browserConnectionId).toEqual(expect.any(String));
    expect(replacement.browserConnectionId).not.toBe(browser.browserConnectionId);

    const oldPoll = await browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
      browserConnectionId: browser.browserConnectionId,
    });
    expect(oldPoll.status).toBe(409);
    expect(await json(oldPoll)).toMatchObject({ error: { code: "connection_invalid" } });

    const config = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    expect(config).toMatchObject({
      enabled: true,
      engineConnected: true,
      connectionUrl: originalOfferUrl,
    });
    expect(gateway.bearerMatches(browser.bearer)).toBe(true);

    // A delayed unload beacon from the replaced tab cannot release the new
    // id-scoped lease.
    expect(await json(await browserPost(handle, browser.csrfToken, "/api/agent/browser/unregister", {
      browserConnectionId: browser.browserConnectionId,
    }))).toEqual({ unregistered: false });
    expect(await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)))).toMatchObject({
      engineConnected: true,
    });
  });

  it("revokes the old bearer and clears connected-client status when pairing rotates", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);
    const externalPromise = handle(jsonRequest("/v1/workspace/instructions", {}, {
      authorization: `Bearer ${browser.bearer}`,
      "x-semaframe-agent-name": "Previously paired agent",
    }));
    const poll = await json(await browserPost(handle, browser.csrfToken, "/api/agent/browser/poll", {
      browserConnectionId: browser.browserConnectionId,
    }));
    const command = poll.command as Record<string, unknown>;
    await browserPost(handle, browser.csrfToken, "/api/agent/browser/result", {
      browserConnectionId: browser.browserConnectionId,
      commandId: command.id,
      ok: true,
      result: { ok: true, data: { guide_digest: "sha256:guide" } },
    });
    await externalPromise;

    const rotated = await json(await browserPost(handle, browser.csrfToken, "/api/agent/browser/rotate", {}));
    expect(rotated.pairingBearer).not.toBe(browser.bearer);
    const oldCredential = await handle(jsonRequest("/v1/workspace/instructions", {}, {
      authorization: `Bearer ${browser.bearer}`,
    }));
    expect(oldCredential.status).toBe(401);
    const config = await json(await handle(new Request(`${PUBLIC_URL}/api/agent/config`)));
    expect(config).toEqual(expect.objectContaining({
      enabled: true,
      engineConnected: true,
      connected: false,
    }));
    expect(config.clientName).toBeUndefined();
  });

  it("rejects non-JSON external command bodies with 415", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);
    const response = await handle(new Request(`${PUBLIC_URL}/v1/workspace/instructions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${browser.bearer}`,
        "content-type": "text/plain",
      },
      body: "{}",
    }));
    expect(response.status).toBe(415);
    expect((await json(response)).error).toEqual(expect.objectContaining({ code: "unsupported_media_type" }));
  });

  it("permits only one external command in flight", async () => {
    const { handle } = setup();
    const browser = await browserSetup(handle);
    const first = handle(jsonRequest("/v1/workspace/instructions", {}, {
      authorization: `Bearer ${browser.bearer}`,
    }));
    const second = await handle(jsonRequest("/v1/workspace/instructions", {}, {
      authorization: `Bearer ${browser.bearer}`,
    }));
    expect(second.status).toBe(409);
    expect((await json(second)).error).toEqual(expect.objectContaining({ code: "engine_busy" }));
    gateways.at(-1)?.close();
    await first;
  });

  it("publishes an OpenAPI 3.1 contract without a pairing secret", async () => {
    const { handle } = setup();
    const response = await handle(new Request(`${PUBLIC_URL}/openapi.json`));
    const payload = await json(response);
    expect(payload.openapi).toBe("3.1.0");
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("session_token");
    expect(serialized).toContain("instruction_digest");
    expect(serialized).toContain("transaction_token");
    expect(serialized).toContain("WorkspaceCommandBatch");
    expect(serialized).toContain("get_workspace_instructions");
    expect(serialized).toContain("inspect_workspace_component");
    expect(serialized).toContain("inspect_workspace_asset");
    expect(serialized).toContain("/workspace/components/inspect");
    expect(serialized).toContain("component_metadata_truncated");
    expect(serialized).toContain("omitted_binding_count");
    expect(serialized).toContain("omitted_tag_count");
    expect(serialized).toContain("omitted_redacted_field_count");
    expect(serialized).toContain("expected_workspace_revision");
    expect(serialized).toContain("AgentResult");
    expect(serialized).toContain("inspect_workspace_model");
    expect(serialized).toContain("/workspace/models/inspect");
    expect(Object.keys(payload.paths as Record<string, unknown>)).toHaveLength(19);
    expect(payload.paths).toEqual(expect.objectContaining({
      "/assets/imports/begin": expect.any(Object),
      "/assets/imports/cancel": expect.any(Object),
      "/assets/imports/complete": expect.any(Object),
      "/assets/uploads/{grant_id}": expect.any(Object),
    }));
    const paths = payload.paths as Record<string, {
      post?: { requestBody?: { content?: { "application/json"?: { schema?: { required?: unknown } } } } };
    }>;
    expect(paths["/assets/imports/begin"]?.post?.requestBody?.content?.["application/json"]?.schema?.required)
      .toEqual(expect.arrayContaining(["session_token", "instruction_digest"]));
    expect(paths["/assets/imports/cancel"]?.post?.requestBody?.content?.["application/json"]?.schema?.required)
      .toEqual(expect.arrayContaining(["session_token", "instruction_digest"]));
    const beginResponse = (paths["/assets/imports/begin"]?.post as {
      responses?: { "200"?: { content?: { "application/json"?: { schema?: unknown } } } };
    } | undefined)?.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(beginResponse).toEqual({ $ref: "#/components/schemas/AgentAssetImportResult" });
    expect(serialized).not.toMatch(/get_scene|inspect_scene|begin_scene|submit_scene|undo_scene|redo_scene|SceneCommandBatch|expected_scene_revision/u);
    expect(serialized).not.toContain("pairingBearer");
  });
});
