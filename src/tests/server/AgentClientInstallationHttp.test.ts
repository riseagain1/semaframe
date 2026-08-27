import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import {
  AgentClientInstallationService,
  type AgentInstallationAction,
  type AgentInstallationBackend,
  type AgentInstallationClient,
  type AgentInstallationState,
} from "../../../server/agent/AgentClientInstallationService";
import { createAgentGatewayHttpHandler } from "../../../server/agent/AgentGatewayHttpHandler";

const ORIGIN = "http://127.0.0.1:4173";
const PUBLIC_URL = "http://127.0.0.1:8788";
const BOOTSTRAP = "b".repeat(43);
const gateways: AgentGateway[] = [];

function response(
  client: AgentInstallationClient,
  action: AgentInstallationAction,
  state: AgentInstallationState,
) {
  return {
    ok: state !== "error" && state !== "conflict",
    client,
    action,
    state,
    changed: action !== "status",
    detail: "backend-only detail",
    restartRequired: action !== "status",
  } as const;
}

function backend(): AgentInstallationBackend {
  return {
    status: vi.fn(async (client) => response(client, "status", "not_installed")),
    install: vi.fn(async (client) => response(client, "install", "installed")),
    update: vi.fn(async (client) => response(client, "update", "installed")),
    remove: vi.fn(async (client) => response(client, "remove", "not_installed")),
    close: vi.fn(async () => undefined),
  };
}

function setup() {
  const installer = backend();
  const gateway = new AgentGateway({
    publicBaseUrl: PUBLIC_URL,
    workspaceRoot: "/workspace/SemaFrame",
    commandTimeoutMs: 1_000,
    pollTimeoutMs: 1_000,
    browserTtlMs: 5_000,
  });
  gateways.push(gateway);
  const handle = createAgentGatewayHttpHandler(gateway, {
    allowedOrigins: [ORIGIN],
    publicBaseUrl: PUBLIC_URL,
    browserBootstrapToken: BOOTSTRAP,
    clientInstallations: new AgentClientInstallationService(installer),
  });
  return { gateway, handle, installer };
}

async function payload(responseValue: Response): Promise<Record<string, unknown>> {
  return await responseValue.json() as Record<string, unknown>;
}

function request(
  path: string,
  csrf: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-semaframe-browser-bootstrap": BOOTSTRAP,
      "x-semaframe-agent-csrf": csrf,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => gateways.splice(0).forEach((gateway) => gateway.close()));

describe("Agent client installation browser routes", () => {
  it("returns sanitized installation health through an authenticated browser POST", async () => {
    const { gateway, handle, installer } = setup();
    const result = await handle(request(
      "/api/agent/browser/installations/status",
      gateway.csrfToken,
    ));

    expect(result.status).toBe(200);
    expect(result.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await payload(result)).toEqual({
      version: 1,
      clients: [
        expect.objectContaining({ client: "codex", state: "not_installed" }),
        expect.objectContaining({ client: "claude", state: "not_installed" }),
      ],
    });
    expect(installer.status).toHaveBeenCalledTimes(2);
  });

  it("requires bootstrap, exact Origin, and CSRF before inspecting or mutating host config", async () => {
    const { gateway, handle, installer } = setup();
    const path = "/api/agent/browser/installations/install";

    const missingBootstrap = request(path, gateway.csrfToken, { client: "codex" });
    missingBootstrap.headers.delete("x-semaframe-browser-bootstrap");
    expect((await handle(missingBootstrap)).status).toBe(403);
    const missingOrigin = request(path, gateway.csrfToken, { client: "codex" });
    missingOrigin.headers.delete("origin");
    expect((await handle(missingOrigin)).status).toBe(403);
    expect((await handle(request(path, gateway.csrfToken, { client: "codex" }, {
      origin: "https://attacker.example",
    }))).status).toBe(403);
    expect((await handle(request(path, "wrong", { client: "codex" }))).status).toBe(403);
    expect(installer.install).not.toHaveBeenCalled();
  });

  it("maps only the three exact actions to the shell-free service", async () => {
    const { gateway, handle, installer } = setup();
    for (const action of ["install", "update", "remove"] as const) {
      const result = await handle(request(
        `/api/agent/browser/installations/${action}`,
        gateway.csrfToken,
        { client: "claude" },
      ));
      expect(result.status).toBe(200);
      expect(await payload(result)).toEqual(expect.objectContaining({
        client: "claude",
        state: action === "remove" ? "not_installed" : "installed",
      }));
      expect(installer[action]).toHaveBeenCalledWith("claude");
    }

    expect((await handle(request(
      "/api/agent/browser/installations/exec",
      gateway.csrfToken,
      { client: "claude" },
    ))).status).toBe(404);
  });

  it("returns 409 immediately for a second-tab mutation while one change is active", async () => {
    const { gateway, handle, installer } = setup();
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => { releaseInstall = resolve; });
    vi.mocked(installer.install).mockImplementation(async (client) => {
      await installGate;
      return response(client, "install", "installed");
    });

    const first = handle(request(
      "/api/agent/browser/installations/install",
      gateway.csrfToken,
      { client: "codex" },
    ));
    await vi.waitFor(() => expect(installer.install).toHaveBeenCalledTimes(1));
    const competing = await handle(request(
      "/api/agent/browser/installations/update",
      gateway.csrfToken,
      { client: "claude" },
    ));
    expect(competing.status).toBe(409);
    expect(await payload(competing)).toEqual({
      error: {
        code: "operation_in_progress",
        message: "Another Agent client installation change is already in progress.",
      },
    });
    expect(installer.update).not.toHaveBeenCalled();

    releaseInstall();
    expect((await first).status).toBe(200);
  });

  it("rejects unsupported clients and extra command-like fields", async () => {
    const { gateway, handle, installer } = setup();
    const path = "/api/agent/browser/installations/install";

    const injected = await handle(request(path, gateway.csrfToken, {
      client: "codex; touch /tmp/pwned",
    }));
    expect(injected.status).toBe(400);
    expect((await payload(injected)).error).toEqual(expect.objectContaining({ code: "invalid_client" }));

    const extra = await handle(request(path, gateway.csrfToken, {
      client: "codex",
      command: "touch /tmp/pwned",
    }));
    expect(extra.status).toBe(400);
    expect((await payload(extra)).error).toEqual(expect.objectContaining({ code: "invalid_request" }));
    expect(installer.install).not.toHaveBeenCalled();
  });

  it("fails closed when the embedding host did not provide installation management", async () => {
    const gateway = new AgentGateway({
      publicBaseUrl: PUBLIC_URL,
      workspaceRoot: "/workspace/SemaFrame",
      commandTimeoutMs: 1_000,
      pollTimeoutMs: 1_000,
      browserTtlMs: 5_000,
    });
    gateways.push(gateway);
    const handle = createAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
      browserBootstrapToken: BOOTSTRAP,
    });

    const result = await handle(request(
      "/api/agent/browser/installations/status",
      gateway.csrfToken,
    ));
    expect(result.status).toBe(503);
    expect(await payload(result)).toEqual({
      error: {
        code: "agent_installations_unavailable",
        message: "Agent client installation management is unavailable in this host.",
      },
    });
  });

  it("starts and awaits installer drain during HTTP handler shutdown", async () => {
    const { handle, installer } = setup();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    vi.mocked(installer.close).mockImplementation(() => closeGate);

    let settled = false;
    const closing = handle.close().then(() => { settled = true; });
    await vi.waitFor(() => expect(installer.close).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseClose();
    await closing;
    expect(settled).toBe(true);
  });
});
