import { describe, expect, it, vi } from "vitest";
import {
  AgentClientInstallationService,
  AgentClientInstallationServiceError,
  type AgentInstallationAction,
  type AgentInstallationBackend,
  type AgentInstallationBackendResult,
  type AgentInstallationClient,
  type AgentInstallationState,
} from "../../../server/agent/AgentClientInstallationService";

function result(
  client: AgentInstallationClient,
  action: AgentInstallationAction,
  state: AgentInstallationState,
  overrides: Partial<AgentInstallationBackendResult> = {},
): AgentInstallationBackendResult {
  return {
    ok: state !== "error" && state !== "conflict",
    client,
    action,
    state,
    changed: action !== "status",
    detail: "/Users/private/.codex/config.toml bearer=do-not-leak",
    restartRequired: action !== "status",
    ...overrides,
  };
}

function backend(): AgentInstallationBackend {
  return {
    status: vi.fn(async (client) => result(
      client,
      "status",
      client === "codex" ? "installed" : "not_installed",
      { changed: false, restartRequired: false },
    )),
    install: vi.fn(async (client) => result(client, "install", "installed")),
    update: vi.fn(async (client) => result(client, "update", "installed")),
    remove: vi.fn(async (client) => result(client, "remove", "not_installed")),
    close: vi.fn(async () => undefined),
  };
}

describe("AgentClientInstallationService", () => {
  it("returns fixed public health copy for the two supported clients", async () => {
    const service = new AgentClientInstallationService(backend());

    await expect(service.status()).resolves.toEqual({
      version: 1,
      clients: [
        {
          client: "codex",
          displayName: "Codex",
          state: "installed",
          changed: false,
          restartRequired: false,
          detail: "The stable SemaFrame launcher is installed for this client.",
        },
        {
          client: "claude",
          displayName: "Claude Code",
          state: "not_installed",
          changed: false,
          restartRequired: false,
          detail: "SemaFrame is not installed for this client yet.",
        },
      ],
    });
  });

  it("never returns backend paths, credentials, or diagnostic output", async () => {
    const service = new AgentClientInstallationService(backend());
    const serialized = JSON.stringify([
      await service.status(),
      await service.run("codex", "update"),
    ]);

    expect(serialized).not.toMatch(/Users|config\.toml|bearer|do-not-leak/iu);
  });

  it("accepts only the closed client and action vocabulary", async () => {
    const service = new AgentClientInstallationService(backend());

    await expect(service.run("codex; rm -rf /", "install")).rejects.toMatchObject({
      code: "invalid_client",
    });
    await expect(service.run("codex", "status")).rejects.toMatchObject({
      code: "invalid_action",
    });
    await expect(service.run("codex", "exec"))
      .rejects.toBeInstanceOf(AgentClientInstallationServiceError);
  });

  it("rejects mismatched or malformed backend responses", async () => {
    const mocked = backend();
    vi.mocked(mocked.install).mockResolvedValueOnce(result("claude", "install", "installed"));
    const service = new AgentClientInstallationService(mocked);

    await expect(service.run("codex", "install")).rejects.toMatchObject({
      code: "backend_invalid",
    });
  });

  it("rejects a concurrent mutation instead of placing it in an unbounded queue", async () => {
    const release: Array<() => void> = [];
    const mocked = backend();
    vi.mocked(mocked.install).mockImplementation(async (client) => {
      await new Promise<void>((resolve) => release.push(resolve));
      return result(client, "install", "installed");
    });
    const service = new AgentClientInstallationService(mocked);

    const first = service.run("codex", "install");
    await vi.waitFor(() => expect(release).toHaveLength(1));
    await expect(service.run("claude", "update")).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    expect(mocked.update).not.toHaveBeenCalled();
    release[0]?.();
    await first;

    await expect(service.run("claude", "update")).resolves.toMatchObject({ state: "installed" });
    expect(mocked.update).toHaveBeenCalledTimes(1);
  });

  it("inspects both clients concurrently while preserving the mutation barrier", async () => {
    const statusRelease: Array<() => void> = [];
    const mutationRelease: Array<() => void> = [];
    const mocked = backend();
    vi.mocked(mocked.install).mockImplementation(async (client) => {
      await new Promise<void>((resolve) => mutationRelease.push(resolve));
      return result(client, "install", "installed");
    });
    vi.mocked(mocked.status).mockImplementation(async (client) => {
      await new Promise<void>((resolve) => statusRelease.push(resolve));
      return result(client, "status", "installed", {
        changed: false,
        restartRequired: false,
      });
    });
    const service = new AgentClientInstallationService(mocked);

    const mutation = service.run("codex", "install");
    const snapshot = service.status();
    const duplicateSnapshot = service.status();
    await vi.waitFor(() => expect(mutationRelease).toHaveLength(1));
    expect(mocked.status).not.toHaveBeenCalled();

    mutationRelease[0]?.();
    await mutation;
    await vi.waitFor(() => expect(statusRelease).toHaveLength(2));
    expect(mocked.status).toHaveBeenCalledTimes(2);

    statusRelease.forEach((release) => release());
    await Promise.all([
      expect(snapshot).resolves.toMatchObject({
        clients: [{ client: "codex" }, { client: "claude" }],
      }),
      expect(duplicateSnapshot).resolves.toMatchObject({
        clients: [{ client: "codex" }, { client: "claude" }],
      }),
    ]);
    expect(mocked.status).toHaveBeenCalledTimes(2);
  });

  it("bounds queue wait to one coalesced status snapshot on each side of a mutation", async () => {
    const statusReleases: Array<() => void> = [];
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const mocked = backend();
    vi.mocked(mocked.status).mockImplementation(async (client) => {
      await new Promise<void>((resolve) => statusReleases.push(resolve));
      return result(client, "status", "installed", { changed: false, restartRequired: false });
    });
    vi.mocked(mocked.install).mockImplementation(async (client) => {
      await installGate;
      return result(client, "install", "installed");
    });
    const service = new AgentClientInstallationService(mocked);

    const before = [service.status(), service.status()];
    await vi.waitFor(() => expect(statusReleases).toHaveLength(2));
    const mutation = service.run("codex", "install");
    const after = [service.status(), service.status()];
    expect(mocked.install).not.toHaveBeenCalled();
    expect(mocked.status).toHaveBeenCalledTimes(2);

    statusReleases.splice(0).forEach((release) => release());
    await Promise.all(before);
    await vi.waitFor(() => expect(mocked.install).toHaveBeenCalledTimes(1));
    expect(mocked.status).toHaveBeenCalledTimes(2);

    releaseInstall();
    await mutation;
    await vi.waitFor(() => expect(statusReleases).toHaveLength(2));
    expect(mocked.status).toHaveBeenCalledTimes(4);
    statusReleases.splice(0).forEach((release) => release());
    await Promise.all(after);
    expect(mocked.status).toHaveBeenCalledTimes(4);
  });

  it("degrades an individual status backend failure without leaking its error", async () => {
    const mocked = backend();
    vi.mocked(mocked.status).mockRejectedValueOnce(new Error("/private/path secret"));
    const service = new AgentClientInstallationService(mocked);

    const snapshot = await service.status();
    expect(snapshot.clients[0]).toEqual(expect.objectContaining({
      client: "codex",
      state: "error",
      detail: "The client installation could not be inspected safely.",
    }));
    expect(snapshot.clients[1]?.client).toBe("claude");
  });

  it("closes admission, drains the accepted global operation, then closes the backend", async () => {
    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mocked = backend();
    vi.mocked(mocked.install).mockImplementation(async (client) => {
      mutationStarted();
      await release;
      return result(client, "install", "installed");
    });
    const service = new AgentClientInstallationService(mocked);

    const mutation = service.run("codex", "install");
    await started;
    const closing = service.close();
    expect(service.close()).toBe(closing);
    expect(mocked.close).not.toHaveBeenCalled();
    await expect(service.status()).rejects.toMatchObject({ code: "service_closed" });
    await expect(service.run("claude", "update")).rejects.toMatchObject({ code: "service_closed" });

    releaseMutation();
    await expect(mutation).resolves.toMatchObject({ state: "installed" });
    await expect(closing).resolves.toBeUndefined();
    expect(mocked.close).toHaveBeenCalledTimes(1);
  });
});
