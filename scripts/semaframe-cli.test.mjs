import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createAgentInstallationService,
  runCapturedCommand,
} from "./lib/agent-installation.mjs";
import {
  inspectSemaFrameHost,
  nodeVersionIsSupported,
  parseSemaFrameCliArguments,
  runSemaFrameCli,
  runSemaFrameCliEntrypoint,
} from "./lib/semaframe-cli.mjs";

function sink() {
  let value = "";
  return { stream: { write: (chunk) => { value += chunk; } }, read: () => value };
}

test("parses the concise Workspace and XR commands", () => {
  assert.deepEqual(parseSemaFrameCliArguments([]), { command: "start", xr: false, json: false });
  assert.deepEqual(parseSemaFrameCliArguments(["xr"]), { command: "start", xr: true, json: false });
  assert.deepEqual(parseSemaFrameCliArguments(["doctor", "--xr", "--json"]), {
    command: "doctor",
    xr: true,
    json: true,
  });
  assert.throws(() => parseSemaFrameCliArguments(["launch"]), /Unknown command/u);
  assert.throws(() => parseSemaFrameCliArguments(["start", "--json"]), /only with semaframe doctor/u);
});

test("parses explicit Agent onboarding commands without accepting ambiguous clients", () => {
  assert.deepEqual(parseSemaFrameCliArguments(["agent", "install", "--client", "codex"]), {
    command: "agent",
    action: "install",
    client: "codex",
  });
  assert.deepEqual(parseSemaFrameCliArguments(["agent", "status", "--client=claude"]), {
    command: "agent",
    action: "status",
    client: "claude",
  });
  assert.throws(() => parseSemaFrameCliArguments(["agent", "install"]), /--client requires/u);
  assert.throws(() => parseSemaFrameCliArguments(["agent", "install", "--client", "cursor"]), /codex or claude/u);
  assert.throws(() => parseSemaFrameCliArguments(["agent", "restart", "--client", "codex"]), /install, status, update, or remove/u);
  assert.throws(
    () => parseSemaFrameCliArguments(["agent", "status", "--client", "codex", "--client", "claude"]),
    /only once/u,
  );
});

test("the executable entrypoint loads root environment before doctor and Agent onboarding", async () => {
  const doctorEnvironment = {};
  let inspectedEnvironment;
  const doctorCode = await runSemaFrameCliEntrypoint(["doctor", "--json"], {
    environment: doctorEnvironment,
    loadEnvironment: () => {
      doctorEnvironment.SEMAFRAME_AGENT_GATEWAY_PORT = "4996";
    },
    inspect: async ({ environment }) => {
      inspectedEnvironment = { ...environment };
      return { ok: true, mode: "workspace", checks: [] };
    },
    output: sink().stream,
  });
  assert.equal(doctorCode, 0);
  assert.equal(inspectedEnvironment.SEMAFRAME_AGENT_GATEWAY_PORT, "4996");

  const agentEnvironment = {};
  let onboardingEnvironment;
  const agentCode = await runSemaFrameCliEntrypoint([
    "agent", "install", "--client", "codex",
  ], {
    environment: agentEnvironment,
    loadEnvironment: () => {
      agentEnvironment.SEMAFRAME_AGENT_GATEWAY_HOST = "::1";
      agentEnvironment.SEMAFRAME_AGENT_GATEWAY_PORT = "4995";
    },
    agentAction: async (_action, _client, { environment }) => {
      onboardingEnvironment = { ...environment };
      return {
        ok: true,
        client: "codex",
        action: "install",
        state: "installed",
        changed: true,
        detail: "Installed.",
        restartRequired: true,
      };
    },
    output: sink().stream,
    errorOutput: sink().stream,
  });
  assert.equal(agentCode, 0);
  assert.equal(onboardingEnvironment.SEMAFRAME_AGENT_GATEWAY_HOST, "::1");
  assert.equal(onboardingEnvironment.SEMAFRAME_AGENT_GATEWAY_PORT, "4995");
});

test("enforces the documented Node floor", () => {
  assert.equal(nodeVersionIsSupported("22.11.9"), false);
  assert.equal(nodeVersionIsSupported("22.12.0"), true);
  assert.equal(nodeVersionIsSupported("24.0.0"), true);
  assert.equal(nodeVersionIsSupported("invalid"), false);
});

test("doctor distinguishes required failures from optional XR and Relay warnings", async () => {
  const report = await inspectSemaFrameHost({
    xr: true,
    nodeVersion: "22.12.0",
    platform: "linux",
    environment: {},
    portProbe: async () => ({ available: true }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(({ id }) => id === "xr-transport")?.status, "warn");
  assert.equal(report.checks.find(({ id }) => id === "voice-relay")?.required, false);

  const loopbackXr = await inspectSemaFrameHost({
    xr: true,
    nodeVersion: "22.12.0",
    platform: "darwin",
    environment: { VITE_XR_PUBLIC_URL: "https://localhost:4174/xr.html" },
    portProbe: async () => ({ available: true }),
  });
  expectStatus(loopbackXr, "xr-transport", "warn");
  const remoteXr = await inspectSemaFrameHost({
    xr: true,
    nodeVersion: "22.12.0",
    platform: "darwin",
    environment: { VITE_XR_PUBLIC_URL: "https://192.168.8.240:4174/xr.html" },
    portProbe: async () => ({ available: true }),
  });
  expectStatus(remoteXr, "xr-transport", "pass");

  const blocked = await inspectSemaFrameHost({
    nodeVersion: "22.11.0",
    environment: {},
    portProbe: async ({ port }) => ({ available: port !== 4173 }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.checks.filter(({ status }) => status === "fail").length, 2);

  const probed = [];
  const ipv6Gateway = await inspectSemaFrameHost({
    nodeVersion: "22.12.0",
    environment: {
      SEMAFRAME_AGENT_GATEWAY_HOST: "::1",
      SEMAFRAME_AGENT_GATEWAY_PORT: "4994",
    },
    portProbe: async (target) => {
      probed.push(target);
      return { available: true };
    },
  });
  assert.equal(ipv6Gateway.ok, true);
  assert.deepEqual(probed, [
    { host: "127.0.0.1", port: 4173 },
    { host: "::1", port: 4994 },
  ]);
  assert.match(
    ipv6Gateway.checks.find(({ id }) => id === "port-gateway")?.detail ?? "",
    /\[::1\]:4994/u,
  );
  await assert.rejects(
    inspectSemaFrameHost({
      environment: { SEMAFRAME_AGENT_GATEWAY_HOST: "0.0.0.0" },
      portProbe: async () => ({ available: true }),
    }),
    /GATEWAY_HOST/u,
  );
});

function expectStatus(report, id, status) {
  assert.equal(report.checks.find((entry) => entry.id === id)?.status, status);
}

test("start refuses to spawn when required doctor checks fail", async () => {
  const output = sink();
  let spawned = false;
  const code = await runSemaFrameCli(["start"], {
    output: output.stream,
    errorOutput: output.stream,
    inspect: async () => ({
      ok: false,
      mode: "workspace",
      checks: [{ id: "node", label: "Node.js", status: "fail", detail: "unsupported", required: true }],
    }),
    spawnProcess: () => { spawned = true; },
  });
  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(output.read(), /was not started/u);
});

test("XR alias launches the packaged host from the package root", async () => {
  const output = sink();
  let launch;
  const child = new EventEmitter();
  child.kill = () => true;
  const pending = runSemaFrameCli(["xr"], {
    output: output.stream,
    errorOutput: output.stream,
    packageRoot: "/opt/semaframe/",
    inspect: async () => ({ ok: true, mode: "xr", checks: [] }),
    spawnProcess: (command, args, options) => {
      launch = { command, args, options };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.equal(await pending, 0);
  assert.equal(launch.options.cwd, "/opt/semaframe/");
  assert.deepEqual(launch.args.slice(-1), ["--xr"]);
});

test("Agent onboarding dispatches before host inspection and prints a restart instruction", async () => {
  const output = sink();
  let invocation;
  let inspected = false;
  const code = await runSemaFrameCli(["agent", "install", "--client", "codex"], {
    output: output.stream,
    errorOutput: output.stream,
    packageRoot: "/Applications/Sema Frame",
    environment: { SEMAFRAME_AGENT_GATEWAY_PORT: "8788" },
    inspect: async () => { inspected = true; },
    agentAction: async (action, client, options) => {
      invocation = { action, client, options };
      return {
        ok: true,
        client,
        action,
        state: "installed",
        changed: true,
        detail: "Installed the stable launcher.",
        restartRequired: true,
      };
    },
  });
  assert.equal(code, 0);
  assert.equal(inspected, false);
  assert.deepEqual(invocation, {
    action: "install",
    client: "codex",
    options: {
      packageRoot: "/Applications/Sema Frame",
      environment: { SEMAFRAME_AGENT_GATEWAY_PORT: "8788" },
    },
  });
  assert.match(output.read(), /\[INSTALLED\]/u);
  assert.match(output.read(), /Restart the Agent client/u);
});

test("official client commands preserve argv boundaries and never invoke a shell", async () => {
  let invocation;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => undefined;
  child.stderr.setEncoding = () => undefined;
  child.kill = () => true;
  const pending = runCapturedCommand(
    "/Applications/Agent CLI/bin/codex",
    ["mcp", "add", "semaframe", "--", "/path with spaces/node", "literal;not-a-command"],
    {
      spawnProcess: (command, args, options) => {
        invocation = { command, args, options };
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
    },
  );
  assert.equal((await pending).code, 0);
  assert.equal(invocation.command, "/Applications/Agent CLI/bin/codex");
  assert.deepEqual(invocation.args, [
    "mcp",
    "add",
    "semaframe",
    "--",
    "/path with spaces/node",
    "literal;not-a-command",
  ]);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "pipe"]);
});

function commandResult({ code = 0, stdout = "", stderr = "", errorCode, timedOut = false } = {}) {
  return Object.freeze({ code, stdout, stderr, errorCode, timedOut });
}

const CLAUDE_USER_SCOPE_OUTPUT = "User config (available in all your projects)";

function parseAddArguments(args, client) {
  const separator = args.indexOf("--");
  assert.notEqual(separator, -1);
  const env = {};
  for (let index = 0; index < separator; index += 1) {
    if (args[index] !== "--env") continue;
    const pair = args[index + 1];
    const equals = pair.indexOf("=");
    env[pair.slice(0, equals)] = pair.slice(equals + 1);
    index += 1;
  }
  return {
    type: "stdio",
    command: args[separator + 1],
    args: args.slice(separator + 2),
    env,
    ...(client === "claude" ? { scope: CLAUDE_USER_SCOPE_OUTPUT } : {}),
  };
}

function codexFixture(initialTransport, { enabled: initialEnabled = true } = {}) {
  let transport = initialTransport;
  let enabled = initialEnabled;
  const calls = [];
  return {
    calls,
    current: () => transport,
    spawnCommand: async (command, args) => {
      calls.push({ command, args: [...args] });
      assert.equal(command, "codex");
      if (args[0] === "mcp" && args[1] === "get") {
        return transport
          ? commandResult({ stdout: JSON.stringify({ name: "semaframe", enabled, transport }) })
          : commandResult({ code: 1, stderr: "Error: No MCP server named 'semaframe' found." });
      }
      if (args[0] === "mcp" && args[1] === "add") {
        transport = parseAddArguments(args, "codex");
        enabled = true;
        return commandResult();
      }
      if (args[0] === "mcp" && args[1] === "remove") {
        transport = undefined;
        return commandResult();
      }
      return commandResult({ code: 2, stderr: "unexpected fixture command" });
    },
  };
}

function claudeFixture(initialTransport, {
  failAdd = false,
  failRemoveAfterDelete,
  transformAdded = (value) => value,
} = {}) {
  let transport = initialTransport;
  const calls = [];
  return {
    calls,
    current: () => transport,
    spawnCommand: async (command, args) => {
      calls.push({ command, args: [...args] });
      assert.equal(command, "claude");
      if (args[0] === "mcp" && args[1] === "get") {
        if (!transport) return commandResult({ code: 1, stderr: "No MCP server named semaframe found" });
        return commandResult({
          stdout: [
            "Name: semaframe",
            `Scope: ${transport.scope ?? CLAUDE_USER_SCOPE_OUTPUT}`,
            `Type: ${transport.type ?? "stdio"}`,
            `Command: ${transport.command}`,
            `Args: ${transport.args.join(" ")}`,
            "Environment:",
            ...Object.entries(transport.env).map(([key, value]) => `  ${key}=${value}`),
          ].join("\n"),
        });
      }
      if (args[0] === "mcp" && args[1] === "add") {
        if (transport) return commandResult({ code: 1, stderr: "MCP server semaframe already exists in user config" });
        if (failAdd) return commandResult({ code: 1, stderr: "Claude Code could not write its user configuration" });
        transport = transformAdded(parseAddArguments(args, "claude"));
        return commandResult();
      }
      if (args[0] === "mcp" && args[1] === "add-json") {
        assert.deepEqual(args.slice(0, 5), ["mcp", "add-json", "--scope", "user", "semaframe"]);
        if (transport) return commandResult({ code: 1, stderr: "MCP server semaframe already exists in user config" });
        const restored = JSON.parse(args[5]);
        transport = { ...restored, scope: CLAUDE_USER_SCOPE_OUTPUT };
        return commandResult();
      }
      if (args[0] === "mcp" && args[1] === "remove") {
        transport = undefined;
        if (failRemoveAfterDelete) {
          const failure = failRemoveAfterDelete;
          failRemoveAfterDelete = undefined;
          return commandResult(failure);
        }
        return commandResult();
      }
      return commandResult({ code: 2, stderr: "unexpected fixture command" });
    },
  };
}

function installationService(clientFixture, overrides = {}) {
  return createAgentInstallationService({
    packageRoot: "/Applications/Sema Frame",
    nodeExecutable: "/Applications/Node JS/bin/node",
    environment: { SEMAFRAME_AGENT_GATEWAY_PORT: "4888" },
    resolveModule: (specifier) => {
      assert.equal(specifier, "tsx");
      return "/Applications/Sema Frame/node_modules/tsx/dist/loader.mjs";
    },
    spawnCommand: clientFixture.spawnCommand,
    accessFile: async () => undefined,
    ...overrides,
  });
}

test("Codex install uses a stable no-shell stdio launcher and is idempotent", async () => {
  const fixture = codexFixture();
  const service = installationService(fixture);
  const installed = await service.install("codex");
  assert.equal(installed.ok, true);
  assert.equal(installed.state, "installed");
  assert.equal(installed.changed, true);

  const add = fixture.calls.find(({ args }) => args[1] === "add");
  assert.deepEqual(add, {
    command: "codex",
    args: [
      "mcp",
      "add",
      "semaframe",
      "--env",
      "SEMAFRAME_AGENT_GATEWAY_URL=http://127.0.0.1:4888",
      "--env",
      "SEMAFRAME_AGENT_NAME=Codex",
      "--",
      "/Applications/Node JS/bin/node",
      "--import",
      "file:///Applications/Sema%20Frame/node_modules/tsx/dist/loader.mjs",
      "/Applications/Sema Frame/scripts/agent-mcp.ts",
    ],
  });
  assert.equal(add.args.some((entry) => entry.includes("SEMAFRAME_AGENT_MCP_URL")), false);

  const callCount = fixture.calls.length;
  const repeated = await service.install("codex");
  assert.equal(repeated.state, "installed");
  assert.equal(repeated.changed, false);
  assert.equal(fixture.calls.length, callCount + 1);
  assert.equal(fixture.calls.at(-1).args[1], "get");
});

test("Codex update replaces only a recognized legacy SemaFrame launcher", async () => {
  const legacy = {
    type: "stdio",
    command: "/old/node",
    args: ["--import", "file:///old/Sema%20Frame/node_modules/tsx/dist/loader.mjs", "/old/Sema Frame/scripts/agent-mcp.ts"],
    env: { SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:8788/mcp/connect/expired" },
  };
  const fixture = codexFixture(legacy);
  const updated = await installationService(fixture).update("codex");
  assert.equal(updated.state, "installed");
  assert.equal(updated.changed, true);
  assert.equal(fixture.calls.some(({ args }) => args[1] === "remove"), false);
  assert.equal(fixture.current().env.SEMAFRAME_AGENT_MCP_URL, undefined);
  assert.equal(fixture.current().env.SEMAFRAME_AGENT_GATEWAY_URL, "http://127.0.0.1:4888");
});

test("Codex status and update honor the real top-level disabled flag", async () => {
  const canonical = {
    type: "stdio",
    command: "/Applications/Node JS/bin/node",
    args: [
      "--import",
      "file:///Applications/Sema%20Frame/node_modules/tsx/dist/loader.mjs",
      "/Applications/Sema Frame/scripts/agent-mcp.ts",
    ],
    env: {
      SEMAFRAME_AGENT_GATEWAY_URL: "http://127.0.0.1:4888",
      SEMAFRAME_AGENT_NAME: "Codex",
    },
  };
  const fixture = codexFixture(canonical, { enabled: false });
  const service = installationService(fixture);
  const status = await service.status("codex");
  assert.equal(status.state, "outdated");

  const updated = await service.update("codex");
  assert.equal(updated.state, "installed");
  assert.equal(updated.changed, true);
  assert.equal(fixture.calls.some(({ args }) => args[1] === "add"), true);
});

test("Agent setup refuses to overwrite or remove an unrelated same-name server", async () => {
  const unrelated = {
    type: "stdio",
    command: "/usr/local/bin/team-tool",
    args: ["serve"],
    env: { TEAM_TOKEN_ENV: "TEAM_TOKEN" },
  };
  const fixture = codexFixture(unrelated);
  const service = installationService(fixture);
  const install = await service.install("codex");
  const remove = await service.remove("codex");
  assert.equal(install.state, "conflict");
  assert.equal(install.ok, false);
  assert.equal(remove.state, "conflict");
  assert.equal(remove.ok, false);
  assert.deepEqual(fixture.current(), unrelated);
  assert.equal(fixture.calls.every(({ args }) => args[1] === "get"), true);
});

test("canonical ownership rejects a lookalike agent-mcp argument", async () => {
  const lookalike = {
    type: "stdio",
    command: "/usr/local/bin/team-tool",
    args: ["/vendor/scripts/agent-mcp.ts"],
    env: { SEMAFRAME_AGENT_GATEWAY_URL: "http://127.0.0.1:4888" },
  };
  const fixture = codexFixture(lookalike);
  const updated = await installationService(fixture).update("codex");
  assert.equal(updated.state, "conflict");
  assert.equal(updated.ok, false);
  assert.deepEqual(fixture.current(), lookalike);
  assert.equal(fixture.calls.length, 1);
});

test("canonical ownership preserves a user-customized launcher with extra environment", async () => {
  const customized = {
    type: "stdio",
    command: "/usr/local/bin/node",
    args: [
      "--import",
      "file:///opt/semaframe/node_modules/tsx/dist/loader.mjs",
      "/opt/semaframe/scripts/agent-mcp.ts",
    ],
    env: {
      SEMAFRAME_AGENT_GATEWAY_URL: "http://127.0.0.1:4888",
      USER_CUSTOM_SETTING: "preserve-me",
    },
  };
  const fixture = codexFixture(customized);
  const removed = await installationService(fixture).remove("codex");
  assert.equal(removed.state, "conflict");
  assert.equal(removed.ok, false);
  assert.deepEqual(fixture.current(), customized);
  assert.equal(fixture.calls.length, 1);
});

test("Agent remove is verified and idempotent", async () => {
  const fixture = codexFixture();
  const service = installationService(fixture);
  await service.install("codex");
  const removed = await service.remove("codex");
  assert.equal(removed.state, "not_installed");
  assert.equal(removed.changed, true);
  const repeated = await service.remove("codex");
  assert.equal(repeated.state, "not_installed");
  assert.equal(repeated.changed, false);
});

test("Agent installer shutdown rejects new work and drains every accepted client queue", async () => {
  const transports = new Map();
  const releaseAdds = {};
  const addGates = Object.fromEntries(["codex", "claude"].map((client) => [
    client,
    new Promise((resolve) => { releaseAdds[client] = resolve; }),
  ]));
  let addStartCount = 0;
  let markAddsStarted;
  const addsStarted = new Promise((resolve) => { markAddsStarted = resolve; });
  const spawnCommand = async (command, args) => {
    assert.equal(command === "codex" || command === "claude", true);
    if (args[0] === "mcp" && args[1] === "get") {
      const transport = transports.get(command);
      return transport
        ? commandResult({ stdout: command === "codex"
          ? JSON.stringify({ name: "semaframe", enabled: true, transport })
          : [
              "Name: semaframe",
              `Scope: ${CLAUDE_USER_SCOPE_OUTPUT}`,
              `Type: ${transport.type}`,
              `Command: ${transport.command}`,
              `Args: ${transport.args.join(" ")}`,
              "Environment:",
              ...Object.entries(transport.env).map(([key, value]) => `  ${key}=${value}`),
            ].join("\n") })
        : commandResult({ code: 1, stderr: "Error: No MCP server named 'semaframe' found." });
    }
    if (args[0] === "mcp" && args[1] === "add") {
      transports.set(command, parseAddArguments(args, command));
      addStartCount += 1;
      if (addStartCount === 2) markAddsStarted();
      await addGates[command];
      return commandResult();
    }
    return commandResult({ code: 2, stderr: "unexpected fixture command" });
  };
  const service = installationService({ spawnCommand });

  const installingCodex = service.install("codex");
  const installingClaude = service.install("claude");
  await addsStarted;
  let closeSettled = false;
  const closeOperation = service.close();
  assert.equal(service.close(), closeOperation);
  const closing = closeOperation.then(() => { closeSettled = true; });
  await assert.rejects(service.status("claude"), /service is closing/u);
  await Promise.resolve();
  assert.equal(closeSettled, false);

  releaseAdds.codex();
  assert.equal((await installingCodex).state, "installed");
  await Promise.resolve();
  assert.equal(closeSettled, false);
  releaseAdds.claude();
  assert.equal((await installingClaude).state, "installed");
  await closing;
  assert.equal(closeSettled, true);
});

test("Claude install, status, and remove accept the exact official user-scope detail label", async () => {
  const fixture = claudeFixture();
  const service = installationService(fixture);

  assert.deepEqual(
    (({ ok, state, changed }) => ({ ok, state, changed }))(await service.install("claude")),
    { ok: true, state: "installed", changed: true },
  );
  assert.deepEqual(
    (({ ok, state, changed }) => ({ ok, state, changed }))(await service.status("claude")),
    { ok: true, state: "installed", changed: false },
  );
  assert.deepEqual(
    (({ ok, state, changed }) => ({ ok, state, changed }))(await service.remove("claude")),
    { ok: true, state: "not_installed", changed: true },
  );
  assert.equal(fixture.current(), undefined);
});

test("Claude update uses user scope and removes only its recognized legacy entry", async () => {
  const legacy = {
    type: "stdio",
    scope: CLAUDE_USER_SCOPE_OUTPUT,
    command: "/old/node",
    args: ["--import", "file:///old/Sema%20Frame/node_modules/tsx/dist/loader.mjs", "/old/Sema Frame/scripts/agent-mcp.ts"],
    env: { SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:8788/mcp/connect/expired" },
  };
  const fixture = claudeFixture(legacy);
  const updated = await installationService(fixture).update("claude");
  assert.equal(updated.state, "installed");
  assert.equal(updated.changed, true);
  assert.deepEqual(fixture.calls.map(({ args }) => args.slice(0, 3)), [
    ["mcp", "get", "semaframe"],
    ["mcp", "remove", "semaframe"],
    ["mcp", "add", "--scope"],
    ["mcp", "get", "semaframe"],
  ]);
  const add = fixture.calls[2].args;
  assert.deepEqual(add.slice(0, 5), ["mcp", "add", "--scope", "user", "--env"]);
  assert.deepEqual(add.slice(-5), [
    "--",
    "/Applications/Node JS/bin/node",
    "--import",
    "file:///Applications/Sema%20Frame/node_modules/tsx/dist/loader.mjs",
    "/Applications/Sema Frame/scripts/agent-mcp.ts",
  ]);
  assert.equal(add.includes("--transport"), true);
  assert.equal(add.includes("stdio"), true);
  assert.equal(add.some((entry) => entry.includes("SEMAFRAME_AGENT_MCP_URL")), false);
  assert.deepEqual(fixture.calls[1].args, ["mcp", "remove", "semaframe", "--scope", "user"]);
});

test("Claude update restores the exact previous config when the new add fails", async () => {
  const legacy = {
    type: "stdio",
    scope: CLAUDE_USER_SCOPE_OUTPUT,
    command: "/old/Node JS/bin/node",
    args: [
      "--import",
      "file:///old/Sema%20Frame/node_modules/tsx/dist/loader.mjs",
      "/old/Sema Frame/scripts/agent-mcp.ts",
    ],
    env: {
      SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:8788/mcp/connect/expired",
      SEMAFRAME_AGENT_NAME: "Claude Code",
    },
  };
  const fixture = claudeFixture(legacy, { failAdd: true });
  const updated = await installationService(fixture).update("claude");
  assert.equal(updated.ok, false);
  assert.equal(updated.state, "error");
  assert.match(updated.detail, /previous SemaFrame configuration was restored/u);
  assert.deepEqual(fixture.current(), legacy);
  assert.deepEqual(fixture.calls.map(({ args }) => args[1]), [
    "get", "remove", "add", "get", "add-json", "get",
  ]);
});

test("Claude update removes a mismatched new entry and rolls back after verification", async () => {
  const legacy = {
    type: "stdio",
    scope: CLAUDE_USER_SCOPE_OUTPUT,
    command: "/old/node",
    args: ["--import", "file:///old/node_modules/tsx/dist/loader.mjs", "/old/scripts/agent-mcp.ts"],
    env: { SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:8788/mcp/connect/expired" },
  };
  const fixture = claudeFixture(legacy, {
    transformAdded: (added) => ({
      ...added,
      env: { ...added.env, SEMAFRAME_AGENT_NAME: "stale verification value" },
    }),
  });
  const updated = await installationService(fixture).update("claude");
  assert.equal(updated.ok, false);
  assert.equal(updated.state, "error");
  assert.match(updated.detail, /previous SemaFrame configuration was restored/u);
  assert.deepEqual(fixture.current(), legacy);
  assert.deepEqual(fixture.calls.map(({ args }) => args[1]), [
    "get", "remove", "add", "get", "remove", "add-json", "get",
  ]);
});

test("Claude update fails closed before removal when the prior entry is not losslessly parseable", async () => {
  const ambiguous = {
    type: "stdio",
    scope: CLAUDE_USER_SCOPE_OUTPUT,
    command: "/old/node",
    args: [
      "--import",
      "file:///old/node_modules/tsx/dist/loader.mjs",
      "/old/scripts/agent-mcp.ts",
      "--unexpected-extra-argument",
    ],
    env: { SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:8788/mcp/connect/expired" },
  };
  const fixture = claudeFixture(ambiguous);
  const updated = await installationService(fixture).update("claude");
  assert.equal(updated.ok, false);
  assert.equal(updated.state, "conflict");
  assert.deepEqual(fixture.current(), ambiguous);
  assert.deepEqual(fixture.calls.map(({ args }) => args[1]), ["get"]);
});

test("Claude update restores a removed prior entry after an ambiguous remove error or timeout", async () => {
  for (const removeFailure of [
    { code: 1, stderr: "remove reported failure" },
    { code: null, timedOut: true, stderr: "remove timed out" },
  ]) {
    const legacy = {
      type: "stdio",
      scope: CLAUDE_USER_SCOPE_OUTPUT,
      command: "/old/node",
      args: ["--import", "file:///old/node_modules/tsx/dist/loader.mjs", "/old/scripts/agent-mcp.ts"],
      env: { SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:8788/mcp/connect/expired" },
    };
    const fixture = claudeFixture(legacy, { failRemoveAfterDelete: removeFailure });
    const updated = await installationService(fixture).update("claude");

    assert.deepEqual(
      (({ ok, state, changed }) => ({ ok, state, changed }))(updated),
      { ok: false, state: "error", changed: false },
    );
    assert.match(updated.detail, /confirmed or restored/u);
    assert.deepEqual(fixture.current(), legacy);
    assert.deepEqual(fixture.calls.map(({ args }) => args[1]), [
      "get", "remove", "get", "add-json", "get",
    ]);
  }
});

test("Claude scope ownership rejects suffix lookalikes instead of removing them", async () => {
  const lookalike = {
    type: "stdio",
    scope: `${CLAUDE_USER_SCOPE_OUTPUT} via project override`,
    command: "/old/node",
    args: ["--import", "file:///old/node_modules/tsx/dist/loader.mjs", "/old/scripts/agent-mcp.ts"],
    env: { SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:8788/mcp/connect/expired" },
  };
  const fixture = claudeFixture(lookalike);
  const removed = await installationService(fixture).remove("claude");

  assert.deepEqual(
    (({ ok, state, changed }) => ({ ok, state, changed }))(removed),
    { ok: false, state: "conflict", changed: false },
  );
  assert.deepEqual(fixture.current(), lookalike);
  assert.deepEqual(fixture.calls.map(({ args }) => args[1]), ["get"]);
});

test("Agent setup reports an absent host CLI and never edits configuration directly", async () => {
  const calls = [];
  const service = createAgentInstallationService({
    packageRoot: "/fixture/semaframe",
    resolveModule: () => "/fixture/semaframe/node_modules/tsx/dist/loader.mjs",
    spawnCommand: async (command, args) => {
      calls.push({ command, args });
      return commandResult({ code: null, errorCode: "ENOENT" });
    },
    accessFile: async () => undefined,
  });
  const status = await service.status("claude");
  const install = await service.install("claude");
  assert.equal(status.state, "client_unavailable");
  assert.equal(status.ok, false);
  assert.equal(install.state, "client_unavailable");
  assert.match(install.detail, /not installed or is not available on PATH/u);
  assert.deepEqual(calls.map(({ command }) => command), ["claude", "claude"]);
});

test("Agent setup validates the stable origin and packaged launcher before mutation", async () => {
  const fixture = codexFixture();
  const invalid = installationService(fixture, {
    environment: { SEMAFRAME_AGENT_GATEWAY_URL: "https://remote.example/mcp?token=secret" },
  });
  const invalidResult = await invalid.install("codex");
  assert.equal(invalidResult.state, "error");
  assert.equal(fixture.calls.length, 0);

  const aliasFixture = codexFixture();
  const alias = installationService(aliasFixture, {
    environment: {
      SEMAFRAME_AGENT_GATEWAY_URL: "http://localhost:4999",
      SEMAFRAME_AGENT_NAME: "Codex\u202e spoof",
    },
  });
  await alias.install("codex");
  assert.equal(aliasFixture.current().env.SEMAFRAME_AGENT_GATEWAY_URL, "http://127.0.0.1:4999");
  assert.equal(aliasFixture.current().env.SEMAFRAME_AGENT_NAME.includes("\u202e"), false);

  const ipv6Fixture = codexFixture();
  const ipv6 = installationService(ipv6Fixture, {
    environment: {
      SEMAFRAME_AGENT_GATEWAY_HOST: "::1",
      SEMAFRAME_AGENT_GATEWAY_PORT: "4998",
    },
  });
  await ipv6.install("codex");
  assert.equal(ipv6Fixture.current().env.SEMAFRAME_AGENT_GATEWAY_URL, "http://[::1]:4998");

  const exactHostFixture = codexFixture();
  const exactHost = installationService(exactHostFixture, {
    environment: {},
    gatewayUrl: "http://localhost:4997",
  });
  await exactHost.install("codex");
  assert.equal(exactHostFixture.current().env.SEMAFRAME_AGENT_GATEWAY_URL, "http://localhost:4997");

  const missingFixture = codexFixture();
  const missing = installationService(missingFixture, {
    accessFile: async () => { throw new Error("missing"); },
  });
  const missingResult = await missing.install("codex");
  assert.equal(missingResult.state, "error");
  assert.equal(missingFixture.calls.some(({ args }) => args[1] === "add"), false);
});
