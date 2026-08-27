import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SERVER_NAME = "semaframe";
const DEFAULT_GATEWAY_PORT = 8788;
// Official MCP configuration commands are local config operations. Keeping the
// per-command budget below the browser operation budget means even the longest
// supported mutation (Claude update plus verified rollback: seven commands) has
// time to complete before the browser's bounded installation request expires.
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT = 256 * 1024;
const CLIENTS = Object.freeze({
  codex: Object.freeze({ executable: "codex", displayName: "Codex" }),
  claude: Object.freeze({ executable: "claude", displayName: "Claude Code" }),
});
const ACTIONS = new Set(["install", "status", "update", "remove"]);
const MANAGED_ENV_KEYS = new Set([
  "SEMAFRAME_AGENT_GATEWAY_URL",
  "SEMAFRAME_AGENT_MCP_URL",
  "SEMAFRAME_AGENT_NAME",
]);
const CLAUDE_RESTORE_CONFIGURATION = Symbol("claudeRestoreConfiguration");

function immutableResult(value) {
  return Object.freeze(value);
}

function result(client, action, state, {
  ok = true,
  changed = false,
  detail,
  restartRequired = false,
  claudeRestoreConfiguration,
} = {}) {
  const value = {
    ok,
    client,
    action,
    state,
    changed,
    detail,
    restartRequired,
  };
  if (claudeRestoreConfiguration) {
    Object.defineProperty(value, CLAUDE_RESTORE_CONFIGURATION, {
      value: claudeRestoreConfiguration,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return immutableResult(value);
}

function assertClient(client) {
  if (!Object.hasOwn(CLIENTS, client)) {
    throw new Error("Agent client must be codex or claude.");
  }
  return CLIENTS[client];
}

function assertAction(action) {
  if (!ACTIONS.has(action)) {
    throw new Error("Agent action must be install, status, update, or remove.");
  }
}

function stableGatewayUrl(environment, exactGatewayUrl) {
  const configuredPort = environment.SEMAFRAME_AGENT_GATEWAY_PORT?.trim();
  if (configuredPort && (!/^[0-9]{1,5}$/u.test(configuredPort)
    || Number(configuredPort) < 1
    || Number(configuredPort) > 65_535)) {
    throw new Error("SEMAFRAME_AGENT_GATEWAY_PORT must be a port from 1 to 65535.");
  }
  const configuredHost = environment.SEMAFRAME_AGENT_GATEWAY_HOST?.trim();
  const defaultHost = configuredHost === "::1"
    ? "[::1]"
    : configuredHost === "localhost"
      ? "localhost"
      : "127.0.0.1";
  const raw = exactGatewayUrl?.trim()
    || environment.SEMAFRAME_AGENT_GATEWAY_URL?.trim()
    || `http://${defaultHost}:${configuredPort || DEFAULT_GATEWAY_PORT}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SEMAFRAME_AGENT_GATEWAY_URL must be a loopback HTTP origin.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost"
    || hostname === "::1"
    || hostname === "0:0:0:0:0:0:0:1"
    || hostname === "127.0.0.1";
  if (
    url.protocol !== "http:"
    || !loopback
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("SEMAFRAME_AGENT_GATEWAY_URL must be a loopback HTTP origin.");
  }
  // Production passes the exact listener entrance because discovery validates
  // Host byte-for-byte. The standalone CLI otherwise follows an explicitly
  // configured bind host; aliases without that evidence normalize to the
  // packaged 127.0.0.1 default.
  if (exactGatewayUrl
    || (configuredHost === "::1" && (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1"))
    || (configuredHost === "localhost" && hostname === "localhost")) {
    return url.origin;
  }
  return `http://127.0.0.1${url.port ? `:${url.port}` : ""}`;
}

function safeAgentName(value, fallback) {
  const normalized = value
    ?.trim()
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
  return normalized || fallback;
}

function createLauncherConfig({
  packageRoot,
  environment,
  nodeExecutable,
  client,
  gatewayUrl,
  resolveModule,
}) {
  const descriptor = assertClient(client);
  const loaderPath = resolveModule("tsx");
  if (typeof loaderPath !== "string" || !isAbsolute(loaderPath) || loaderPath.includes("\u0000")) {
    throw new Error("The installed tsx runtime could not be resolved safely.");
  }
  const bridgePath = resolve(packageRoot, "scripts", "agent-mcp.ts");
  return Object.freeze({
    command: nodeExecutable,
    args: Object.freeze([
      "--import",
      pathToFileURL(loaderPath).href,
      bridgePath,
    ]),
    env: Object.freeze({
      SEMAFRAME_AGENT_GATEWAY_URL: stableGatewayUrl(environment, gatewayUrl),
      SEMAFRAME_AGENT_NAME: safeAgentName(environment.SEMAFRAME_AGENT_NAME, descriptor.displayName),
    }),
    requiredFiles: Object.freeze([loaderPath, bridgePath]),
  });
}

function appendOutput(current, chunk) {
  if (current.length >= MAX_COMMAND_OUTPUT) return current;
  return `${current}${chunk}`.slice(0, MAX_COMMAND_OUTPUT);
}

/**
 * Capture a short-lived official client command without invoking a shell. Raw
 * output remains private to the installation service and is never returned to
 * the UI or printed by the SemaFrame CLI.
 */
export function runCapturedCommand(command, args, {
  environment = process.env,
  timeoutMs = COMMAND_TIMEOUT_MS,
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolveCommand) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (cause) {
      resolveCommand(Object.freeze({
        code: null,
        stdout: "",
        stderr: "",
        errorCode: cause && typeof cause === "object" && "code" in cause
          ? String(cause.code)
          : "SPAWN_ERROR",
        timedOut: false,
      }));
      return;
    }
    let stdout = "";
    let stderr = "";
    let errorCode;
    let timedOut = false;
    let settled = false;
    let forceKill;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.once("error", (cause) => {
      errorCode = cause && typeof cause === "object" && "code" in cause
        ? String(cause.code)
        : "SPAWN_ERROR";
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolveCommand(Object.freeze({ code, stdout, stderr, errorCode, timedOut }));
    });
  });
}

function notFoundOutput(output) {
  return /(?:no mcp server[^\n]*(?:found|named)|not found|does not exist|unknown (?:mcp )?server)/iu.test(output);
}

function transportFromJson(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = payload.transport && typeof payload.transport === "object"
    ? payload.transport
    : payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const args = Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string")
    ? value.args
    : [];
  const env = value.env && typeof value.env === "object" && !Array.isArray(value.env)
    ? Object.fromEntries(Object.entries(value.env).filter(([, entry]) => typeof entry === "string"))
    : {};
  if (!command) return undefined;
  return {
    type: value.type,
    command,
    args,
    env,
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : undefined,
  };
}

function parseJsonOutput(output) {
  try {
    return transportFromJson(JSON.parse(output));
  } catch {
    return undefined;
  }
}

function normalizedPath(value) {
  return value.replace(/\\/gu, "/");
}

function nodeCommand(value) {
  const normalized = normalizedPath(value).toLowerCase();
  return normalized === "node" || normalized.endsWith("/node") || normalized.endsWith("/node.exe");
}

function loaderArgument(value) {
  try {
    const url = new URL(value);
    return url.protocol === "file:"
      && normalizedPath(decodeURIComponent(url.pathname)).endsWith("/node_modules/tsx/dist/loader.mjs");
  } catch {
    return false;
  }
}

function canonicalLauncherShape(transport) {
  const keys = Object.keys(transport.env);
  return nodeCommand(transport.command)
    && transport.args.length === 3
    && transport.args[0] === "--import"
    && loaderArgument(transport.args[1])
    && normalizedPath(transport.args[2]).endsWith("/scripts/agent-mcp.ts")
    && keys.length > 0
    && keys.every((key) => MANAGED_ENV_KEYS.has(key))
    && Boolean(
      transport.env.SEMAFRAME_AGENT_GATEWAY_URL
      || transport.env.SEMAFRAME_AGENT_MCP_URL,
    );
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function classifyTransport(transport, expected) {
  if (!canonicalLauncherShape(transport)) return "conflict";
  const stableEnvironment = transport.env.SEMAFRAME_AGENT_GATEWAY_URL === expected.env.SEMAFRAME_AGENT_GATEWAY_URL
    && transport.env.SEMAFRAME_AGENT_NAME === expected.env.SEMAFRAME_AGENT_NAME
    && !transport.env.SEMAFRAME_AGENT_MCP_URL;
  const exact = (transport.type === undefined || transport.type === "stdio")
    && transport.enabled !== false
    && transport.command === expected.command
    && arraysEqual(transport.args, expected.args)
    && stableEnvironment;
  return exact ? "installed" : "outdated";
}

function singleClaudeField(lines, label) {
  const prefix = `${label.toLowerCase()}:`;
  const matches = lines
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(prefix));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(matches[0].indexOf(":") + 1).trim();
  return value || undefined;
}

/**
 * Parse only the exact, generated stdio shape that SemaFrame knows how to
 * restore through Claude's official `mcp add-json` command. The loader URL is
 * a file URL (so spaces are percent-encoded) and the final script path consumes
 * the remainder of the Args line, preserving ordinary spaces in package paths.
 * Any ambiguous field fails closed before the existing entry is removed.
 */
function parseClaudeUserStdioConfiguration(output) {
  if (typeof output !== "string" || output.length > MAX_COMMAND_OUTPUT) return undefined;
  const lines = output.replace(/\r\n?/gu, "\n").split("\n");
  const scope = singleClaudeField(lines, "scope")?.toLowerCase();
  const type = singleClaudeField(lines, "type")?.toLowerCase();
  const command = singleClaudeField(lines, "command");
  const argsText = singleClaudeField(lines, "args");
  // Claude's documented user-scope detail line currently includes the
  // explanatory suffix below. Keep this an exact vocabulary: accepting a
  // prefix such as `User config ...` would let a project/local or otherwise
  // ambiguous entry pass the ownership check and become removable.
  const userScope = scope === "user"
    || scope === "user config"
    || scope === "user scope"
    || scope === "user config (available in all your projects)";
  if (!userScope
    || type !== "stdio" || !command || !nodeCommand(command) || !argsText?.startsWith("--import ")) {
    return undefined;
  }

  const argumentRemainder = argsText.slice("--import ".length);
  const separator = argumentRemainder.indexOf(" ");
  if (separator <= 0) return undefined;
  const loader = argumentRemainder.slice(0, separator);
  const bridge = argumentRemainder.slice(separator + 1).trim();
  if (!loaderArgument(loader) || !bridge || /[\u0000-\u001f\u007f]/u.test(bridge)) return undefined;

  const environmentHeaders = lines
    .map((line, index) => line.trim().toLowerCase() === "environment:" ? index : -1)
    .filter((index) => index >= 0);
  if (environmentHeaders.length !== 1) return undefined;
  const [environmentHeader] = environmentHeaders;
  const env = {};
  for (let index = environmentHeader + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (!/^\s/u.test(line)) break;
    const entry = line.trim();
    const equals = entry.indexOf("=");
    if (equals <= 0) return undefined;
    const key = entry.slice(0, equals);
    const value = entry.slice(equals + 1);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) || Object.hasOwn(env, key)) return undefined;
    env[key] = value;
  }

  const configuration = {
    type: "stdio",
    command,
    args: ["--import", loader, bridge],
    env,
  };
  return canonicalLauncherShape(configuration) ? configuration : undefined;
}

async function recoverClaudeConfigurationAfterAmbiguousRemoval({
  previous,
  descriptor,
  config,
  commands,
  spawnCommand,
  environment,
}) {
  const inspected = await inspectInstallation({
    client: "claude",
    action: "update",
    descriptor,
    config,
    commands,
    spawnCommand,
    environment,
  });
  if (inspected.state !== "not_installed") {
    const current = inspected[CLAUDE_RESTORE_CONFIGURATION];
    // A different recognized entry can only be an external concurrent change:
    // the replacement add has not started yet (or the rollback remove was
    // ambiguous). Never overwrite it merely because it resembles SemaFrame.
    return Boolean(current && configurationsEqual(current, previous));
  }
  const restored = await spawnCommand(
    descriptor.executable,
    claudeRestoreArguments(previous),
    { environment },
  );
  if (restored.code !== 0 || restored.errorCode || restored.timedOut) return false;
  const verified = await inspectInstallation({
    client: "claude",
    action: "update",
    descriptor,
    config,
    commands,
    spawnCommand,
    environment,
  });
  const verifiedConfiguration = verified[CLAUDE_RESTORE_CONFIGURATION];
  return Boolean(verifiedConfiguration && configurationsEqual(verifiedConfiguration, previous));
}

function classifyClaudeConfiguration(configuration, expected) {
  if (!configuration || !canonicalLauncherShape(configuration)) return "conflict";
  const stableEnvironment = configuration.env.SEMAFRAME_AGENT_GATEWAY_URL === expected.env.SEMAFRAME_AGENT_GATEWAY_URL
    && configuration.env.SEMAFRAME_AGENT_NAME === expected.env.SEMAFRAME_AGENT_NAME
    && !configuration.env.SEMAFRAME_AGENT_MCP_URL;
  return configuration.command === expected.command
    && arraysEqual(configuration.args, expected.args)
    && stableEnvironment
    ? "installed"
    : "outdated";
}

function configurationsEqual(left, right) {
  return left.type === right.type
    && left.command === right.command
    && arraysEqual(left.args, right.args)
    && Object.keys(left.env).sort().join("\n") === Object.keys(right.env).sort().join("\n")
    && Object.entries(left.env).every(([key, value]) => right.env[key] === value);
}

function statusDetail(state, displayName) {
  switch (state) {
    case "installed":
      return `The stable SemaFrame launcher is installed for ${displayName}.`;
    case "not_installed":
      return `SemaFrame is not installed in ${displayName}.`;
    case "outdated":
      return `A recognized SemaFrame launcher is installed in ${displayName}, but it needs an update.`;
    case "conflict":
      return `${displayName} already has an unrelated or differently scoped server named semaframe; it was not changed.`;
    default:
      return `The ${displayName} installation state could not be determined.`;
  }
}

function commandFailure(client, action, descriptor, commandResult) {
  if (commandResult.errorCode === "ENOENT") {
    return result(client, action, "client_unavailable", {
      ok: false,
      detail: `${descriptor.displayName} CLI is not installed or is not available on PATH. Install it, then retry.`,
    });
  }
  if (commandResult.timedOut) {
    return result(client, action, "error", {
      ok: false,
      detail: `${descriptor.displayName} did not finish the MCP configuration request in time.`,
    });
  }
  return result(client, action, "error", {
    ok: false,
    detail: `${descriptor.displayName} could not complete the MCP configuration request.`,
  });
}

function codexAddArguments(config) {
  return [
    "mcp",
    "add",
    SERVER_NAME,
    ...Object.entries(config.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--",
    config.command,
    ...config.args,
  ];
}

function claudeAddArguments(config) {
  return [
    "mcp",
    "add",
    "--scope",
    "user",
    ...Object.entries(config.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    // Keep a non-env option between the final --env value and the server name;
    // Claude otherwise consumes the name as another KEY=value pair.
    "--transport",
    "stdio",
    SERVER_NAME,
    "--",
    config.command,
    ...config.args,
  ];
}

function claudeRestoreArguments(config) {
  return [
    "mcp",
    "add-json",
    "--scope",
    "user",
    SERVER_NAME,
    JSON.stringify({
      type: "stdio",
      command: config.command,
      args: config.args,
      env: config.env,
    }),
  ];
}

function clientCommands(client, config) {
  if (client === "codex") {
    return Object.freeze({
      get: Object.freeze(["mcp", "get", SERVER_NAME, "--json"]),
      add: Object.freeze(codexAddArguments(config)),
      remove: Object.freeze(["mcp", "remove", SERVER_NAME]),
    });
  }
  return Object.freeze({
    get: Object.freeze(["mcp", "get", SERVER_NAME]),
    add: Object.freeze(claudeAddArguments(config)),
    remove: Object.freeze(["mcp", "remove", SERVER_NAME, "--scope", "user"]),
  });
}

async function inspectInstallation({ client, action, descriptor, config, commands, spawnCommand, environment }) {
  const commandResult = await spawnCommand(descriptor.executable, commands.get, { environment });
  if (commandResult.errorCode === "ENOENT" || commandResult.timedOut) {
    return commandFailure(client, action, descriptor, commandResult);
  }
  const combined = `${commandResult.stdout}\n${commandResult.stderr}`;
  if (commandResult.code !== 0) {
    if (notFoundOutput(combined)) {
      return result(client, action, "not_installed", {
        detail: statusDetail("not_installed", descriptor.displayName),
      });
    }
    return commandFailure(client, action, descriptor, commandResult);
  }
  const parsed = parseJsonOutput(commandResult.stdout);
  const claudeConfiguration = client === "claude" && !parsed
    ? parseClaudeUserStdioConfiguration(commandResult.stdout)
    : undefined;
  const state = parsed
    ? classifyTransport(parsed, config)
    : client === "claude"
      ? classifyClaudeConfiguration(claudeConfiguration, config)
      : "conflict";
  return result(client, action, state, {
    detail: statusDetail(state, descriptor.displayName),
    ...(claudeConfiguration && state !== "conflict"
      ? { claudeRestoreConfiguration: claudeConfiguration }
      : {}),
  });
}

async function restoreClaudeConfiguration({
  previous,
  currentInspection,
  descriptor,
  config,
  commands,
  spawnCommand,
  environment,
}) {
  const inspected = currentInspection ?? await inspectInstallation({
    client: "claude",
    action: "update",
    descriptor,
    config,
    commands,
    spawnCommand,
    environment,
  });
  if (inspected.state !== "not_installed") {
    const current = inspected[CLAUDE_RESTORE_CONFIGURATION];
    if (!current) return false;
    if (configurationsEqual(current, previous)) return true;
    // Only the same strict SemaFrame-owned shape accepted before the update may
    // be removed. An unparseable or differently shaped concurrent user change
    // is never overwritten by rollback.
    if (!canonicalLauncherShape(current)) return false;
    const removed = await spawnCommand(descriptor.executable, commands.remove, { environment });
    if (removed.code !== 0 || removed.errorCode || removed.timedOut) {
      return recoverClaudeConfigurationAfterAmbiguousRemoval({
        previous,
        descriptor,
        config,
        commands,
        spawnCommand,
        environment,
      });
    }
  }

  const restored = await spawnCommand(
    descriptor.executable,
    claudeRestoreArguments(previous),
    { environment },
  );
  if (restored.code !== 0 || restored.errorCode || restored.timedOut) return false;
  const verified = await inspectInstallation({
    client: "claude",
    action: "update",
    descriptor,
    config,
    commands,
    spawnCommand,
    environment,
  });
  const verifiedConfiguration = verified[CLAUDE_RESTORE_CONFIGURATION];
  return Boolean(verifiedConfiguration && configurationsEqual(verifiedConfiguration, previous));
}

async function validateLauncher(config, accessFile) {
  await Promise.all(config.requiredFiles.map((path) => accessFile(path, fsConstants.R_OK)));
}

function launcherMissingResult(client, action, descriptor) {
  return result(client, action, "error", {
    ok: false,
    detail: `This SemaFrame installation is incomplete, so ${descriptor.displayName} was not changed. Reinstall SemaFrame and retry.`,
  });
}

/**
 * Creates a programmatic installer used by both the CLI and the local UI host.
 * Mutations are serialized per client and always go through the client's
 * official MCP CLI rather than editing its configuration files directly.
 */
export function createAgentInstallationService({
  packageRoot,
  environment = process.env,
  nodeExecutable = process.execPath,
  gatewayUrl,
  resolveModule,
  spawnCommand = runCapturedCommand,
  accessFile = access,
} = {}) {
  if (!packageRoot) throw new Error("packageRoot is required.");
  const packageRequire = createRequire(resolve(packageRoot, "package.json"));
  const resolveRuntimeModule = resolveModule ?? ((specifier) => packageRequire.resolve(specifier));
  const queues = new Map();
  let closing = false;
  let closePromise;

  async function execute(action, client) {
    assertAction(action);
    const descriptor = assertClient(client);
    let config;
    try {
      config = createLauncherConfig({
        packageRoot,
        environment,
        nodeExecutable,
        client,
        gatewayUrl,
        resolveModule: resolveRuntimeModule,
      });
    } catch (cause) {
      return result(client, action, "error", {
        ok: false,
        detail: cause instanceof Error ? cause.message : "The stable Agent launcher configuration is invalid.",
      });
    }
    const commands = clientCommands(client, config);
    const before = await inspectInstallation({
      client,
      action,
      descriptor,
      config,
      commands,
      spawnCommand,
      environment,
    });
    if (action === "status" || before.state === "client_unavailable" || before.state === "error") {
      return before;
    }
    if (before.state === "conflict") {
      return result(client, action, "conflict", {
        ok: false,
        detail: before.detail,
      });
    }
    if (action === "remove") {
      if (before.state === "not_installed") return before;
      const removed = await spawnCommand(descriptor.executable, commands.remove, { environment });
      if (removed.code !== 0 || removed.errorCode || removed.timedOut) {
        return commandFailure(client, action, descriptor, removed);
      }
      const after = await inspectInstallation({
        client,
        action,
        descriptor,
        config,
        commands,
        spawnCommand,
        environment,
      });
      if (after.state !== "not_installed") {
        return result(client, action, "error", {
          ok: false,
          detail: `${descriptor.displayName} did not confirm removal of the SemaFrame launcher.`,
        });
      }
      return result(client, action, "not_installed", {
        changed: true,
        detail: `Removed the SemaFrame launcher from ${descriptor.displayName}.`,
        restartRequired: true,
      });
    }
    if (before.state === "installed") return before;
    try {
      await validateLauncher(config, accessFile);
    } catch {
      return launcherMissingResult(client, action, descriptor);
    }
    const previousClaudeConfiguration = client === "claude" && before.state === "outdated"
      ? before[CLAUDE_RESTORE_CONFIGURATION]
      : undefined;
    if (client === "claude" && before.state === "outdated") {
      if (!previousClaudeConfiguration) {
        return result(client, action, "conflict", {
          ok: false,
          detail: "Claude Code returned a SemaFrame entry that could not be restored losslessly, so it was not changed.",
        });
      }
      // Claude refuses a same-name add at the same scope. Only configurations
      // already classified and losslessly captured as SemaFrame-owned reach
      // this branch.
      const removed = await spawnCommand(descriptor.executable, commands.remove, { environment });
      if (removed.code !== 0 || removed.errorCode || removed.timedOut) {
        const restored = await recoverClaudeConfigurationAfterAmbiguousRemoval({
          previous: previousClaudeConfiguration,
          descriptor,
          config,
          commands,
          spawnCommand,
          environment,
        });
        return result(client, action, "error", {
          ok: false,
          detail: restored
            ? "Claude Code could not safely remove the previous launcher; its previous SemaFrame configuration was confirmed or restored."
            : "Claude Code could not safely remove the previous launcher, and its previous SemaFrame configuration could not be confirmed or restored automatically.",
        });
      }
    }
    const added = await spawnCommand(descriptor.executable, commands.add, { environment });
    if (added.code !== 0 || added.errorCode || added.timedOut) {
      if (previousClaudeConfiguration) {
        const restored = await restoreClaudeConfiguration({
          previous: previousClaudeConfiguration,
          descriptor,
          config,
          commands,
          spawnCommand,
          environment,
        });
        return result(client, action, "error", {
          ok: false,
          detail: restored
            ? "Claude Code could not install the updated launcher; the previous SemaFrame configuration was restored."
            : "Claude Code could not install the updated launcher, and the previous SemaFrame configuration could not be restored automatically.",
        });
      }
      return commandFailure(client, action, descriptor, added);
    }
    const after = await inspectInstallation({
      client,
      action,
      descriptor,
      config,
      commands,
      spawnCommand,
      environment,
    });
    if (after.state !== "installed") {
      if (previousClaudeConfiguration) {
        const restored = await restoreClaudeConfiguration({
          previous: previousClaudeConfiguration,
          currentInspection: after,
          descriptor,
          config,
          commands,
          spawnCommand,
          environment,
        });
        return result(client, action, "error", {
          ok: false,
          detail: restored
            ? "Claude Code did not verify the updated launcher; the previous SemaFrame configuration was restored."
            : "Claude Code did not verify the updated launcher, and the previous SemaFrame configuration could not be restored automatically.",
        });
      }
      return result(client, action, "error", {
        ok: false,
        detail: `${descriptor.displayName} wrote an MCP configuration, but it did not match the stable SemaFrame launcher.`,
      });
    }
    return result(client, action, "installed", {
      changed: true,
      detail: `${action === "update" || before.state === "outdated" ? "Updated" : "Installed"} the stable SemaFrame launcher for ${descriptor.displayName}.`,
      restartRequired: true,
    });
  }

  function serialized(action, client) {
    assertAction(action);
    assertClient(client);
    if (closing) {
      return Promise.reject(new Error("The Agent installation service is closing."));
    }
    const previous = queues.get(client) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => execute(action, client));
    queues.set(client, pending);
    const cleanup = () => {
      if (queues.get(client) === pending) queues.delete(client);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    // Each map value is the tail of one client's serialized queue. Snapshotting
    // after closing admission therefore covers every operation accepted before
    // shutdown without cancelling a config write halfway through.
    closePromise = Promise.allSettled([...queues.values()]).then(() => undefined);
    return closePromise;
  }

  return Object.freeze({
    status: (client) => serialized("status", client),
    install: (client) => serialized("install", client),
    update: (client) => serialized("update", client),
    remove: (client) => serialized("remove", client),
    close,
  });
}

export function runAgentInstallationAction(action, client, options) {
  assertAction(action);
  const service = createAgentInstallationService(options);
  return service[action](client);
}
