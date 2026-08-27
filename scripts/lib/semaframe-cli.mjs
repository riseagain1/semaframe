import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentInstallationAction } from "./agent-installation.mjs";
import { loadRootEnvironment } from "./root-env.mjs";

export const SEMAFRAME_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MINIMUM_NODE = Object.freeze({ major: 22, minor: 12 });
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORTS = Object.freeze({ workspace: 4173, gateway: 8788, xr: 4174 });

function parsePort(value, fallback, label) {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^[0-9]{1,5}$/u.test(value)) throw new Error(`${label} must be a port from 1 to 65535.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65_535) throw new Error(`${label} must be a port from 1 to 65535.`);
  return parsed;
}

function parseGatewayHost(value) {
  const host = value?.trim() || LOOPBACK_HOST;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("SEMAFRAME_AGENT_GATEWAY_HOST must be 127.0.0.1, localhost, or ::1.");
  }
  return host;
}

function hostPort(host, port) {
  return `${host === "::1" ? "[::1]" : host}:${port}`;
}

export function nodeVersionIsSupported(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MINIMUM_NODE.major
    || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor);
}

export function parseSemaFrameCliArguments(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return Object.freeze({ command: "help" });
  if (args.includes("--version") || args.includes("-v")) return Object.freeze({ command: "version" });
  const first = args.shift() ?? "start";
  if (first === "agent") {
    const action = args.shift();
    if (!action || !["install", "status", "update", "remove"].includes(action)) {
      throw new Error("Agent command must be install, status, update, or remove.");
    }
    let client;
    const unsupported = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--client") {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) throw new Error("--client requires codex or claude.");
        if (client !== undefined) throw new Error("--client may be specified only once.");
        client = value;
        index += 1;
      } else if (argument.startsWith("--client=")) {
        if (client !== undefined) throw new Error("--client may be specified only once.");
        client = argument.slice("--client=".length);
      } else {
        unsupported.push(argument);
      }
    }
    if (unsupported.length > 0) {
      throw new Error(`Unknown option “${unsupported[0]}”. Run semaframe --help for supported options.`);
    }
    if (client !== "codex" && client !== "claude") {
      throw new Error("--client requires codex or claude.");
    }
    return Object.freeze({ command: "agent", action, client });
  }
  const command = first === "xr" ? "start" : first;
  if (command !== "start" && command !== "doctor" && command !== "help" && command !== "version") {
    throw new Error(`Unknown command “${first}”. Run semaframe --help for supported commands.`);
  }
  const xr = first === "xr" || args.includes("--xr");
  const json = args.includes("--json");
  const unsupported = args.filter((arg) => arg !== "--xr" && arg !== "--json");
  if (unsupported.length > 0) {
    throw new Error(`Unknown option “${unsupported[0]}”. Run semaframe --help for supported options.`);
  }
  if (command === "start" && json) throw new Error("--json is available only with semaframe doctor.");
  return Object.freeze({ command, xr, json });
}

async function readable(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function probeTcpPort({ host = LOOPBACK_HOST, port }) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (cause) => resolve(Object.freeze({ available: false, cause })));
    server.listen({ host, port, exclusive: true }, () => {
      server.close((cause) => resolve(Object.freeze({ available: cause === undefined, cause })));
    });
  });
}

function check(id, label, status, detail, required = true) {
  return Object.freeze({ id, label, status, detail, required });
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

export async function inspectSemaFrameHost({
  xr = false,
  environment = process.env,
  platform = process.platform,
  nodeVersion = process.versions.node,
  packageRoot = SEMAFRAME_PACKAGE_ROOT,
  portProbe = probeTcpPort,
} = {}) {
  const ports = Object.freeze({
    workspace: parsePort(environment.SEMAFRAME_AGENT_VITE_PORT, DEFAULT_PORTS.workspace, "SEMAFRAME_AGENT_VITE_PORT"),
    gateway: parsePort(environment.SEMAFRAME_AGENT_GATEWAY_PORT, DEFAULT_PORTS.gateway, "SEMAFRAME_AGENT_GATEWAY_PORT"),
    xr: parsePort(environment.SEMAFRAME_XR_VITE_PORT, DEFAULT_PORTS.xr, "SEMAFRAME_XR_VITE_PORT"),
  });
  const gatewayHost = parseGatewayHost(environment.SEMAFRAME_AGENT_GATEWAY_HOST);
  const requiredFiles = [
    "package.json",
    "index.html",
    "scripts/dev-agent.mjs",
    "server/agent/start.ts",
    "src/main.tsx",
  ];
  const filesPresent = (await Promise.all(requiredFiles.map((path) => readable(resolve(packageRoot, path))))).every(Boolean);
  const portEntries = [
    ["workspace", "Workspace UI port", ports.workspace, LOOPBACK_HOST],
    ["gateway", "Agent gateway port", ports.gateway, gatewayHost],
    ...(xr ? [["xr", "XR renderer port", ports.xr, LOOPBACK_HOST]] : []),
  ];
  const portResults = await Promise.all(portEntries.map(async ([id, label, port, host]) => {
    const result = await portProbe({ host, port });
    return check(`port-${id}`, label, result.available ? "pass" : "fail", result.available
      ? `${hostPort(host, port)} is available.`
      : `${hostPort(host, port)} is already in use. Stop the other process or configure a different port.`);
  }));
  const xrPublicUrl = environment.VITE_XR_PUBLIC_URL?.trim();
  let xrTransportCheck;
  if (xr) {
    if (!xrPublicUrl) {
      xrTransportCheck = check(
        "xr-transport",
        "Remote-headset transport",
        "warn",
        "Local XR will start, but a separate headset needs a trusted HTTPS VITE_XR_PUBLIC_URL reachable on the LAN.",
        false,
      );
    } else {
      let remotelyConfigured = false;
      try {
        const parsed = new URL(xrPublicUrl);
        remotelyConfigured = parsed.protocol === "https:"
          && !parsed.username
          && !parsed.password
          && !parsed.search
          && !parsed.hash
          && !isLoopbackHostname(parsed.hostname)
          && parsed.hostname !== "0.0.0.0"
          && parsed.hostname !== "::";
      } catch {
        remotelyConfigured = false;
      }
      xrTransportCheck = check(
        "xr-transport",
        "Remote-headset transport",
        remotelyConfigured ? "pass" : "warn",
        remotelyConfigured
          ? `Headsets will be directed to ${xrPublicUrl}. Trust and LAN reachability still require a physical device check.`
          : "VITE_XR_PUBLIC_URL is not a valid non-loopback HTTPS viewer URL; remote headsets will reject pairing or immersive WebXR.",
        false,
      );
    }
  }
  const voiceRelayCheck = check(
    "voice-relay",
    "Optional Voice Relay",
    platform === "darwin" || platform === "win32" ? "pass" : "warn",
    platform === "darwin" || platform === "win32"
      ? "A native helper can be built on this host. Voice Relay remains off until a person configures and arms it."
      : "Native Voice Relay is unavailable on this platform; Workspace, Agent control, and XR remain available.",
    false,
  );
  const checks = Object.freeze([
    check(
      "node",
      "Node.js",
      nodeVersionIsSupported(nodeVersion) ? "pass" : "fail",
      nodeVersionIsSupported(nodeVersion)
        ? `${nodeVersion} satisfies the >=22.12 requirement.`
        : `${nodeVersion} is unsupported; install Node.js 22.12 or newer.`,
    ),
    check(
      "package",
      "Runtime package",
      filesPresent ? "pass" : "fail",
      filesPresent
        ? "Required host, gateway, and Workspace sources are present."
        : "The installation is incomplete; reinstall SemaFrame before launching.",
    ),
    ...portResults,
    ...(xrTransportCheck ? [xrTransportCheck] : []),
    voiceRelayCheck,
  ]);
  return Object.freeze({
    ok: checks.every((entry) => !entry.required || entry.status === "pass"),
    mode: xr ? "xr" : "workspace",
    platform,
    nodeVersion,
    ports,
    checks,
  });
}

function helpText() {
  return [
    "SemaFrame — semantic spatial workspace for people and AI agents",
    "",
    "Usage:",
    "  semaframe start          Start Workspace + local Agent gateway",
    "  semaframe xr             Start Workspace + gateway + XR renderer",
    "  semaframe doctor [--xr]  Check the host without starting services",
    "  semaframe agent install --client <codex|claude>",
    "  semaframe agent status  --client <codex|claude>",
    "  semaframe agent update  --client <codex|claude>",
    "  semaframe agent remove  --client <codex|claude>",
    "  semaframe --version      Print the installed version",
    "",
    "Voice Relay is optional and off by default. A voice-capable Agent may use",
    "the computer microphone directly; a headset microphone is not required.",
  ].join("\n");
}

function writeDoctor(report, output) {
  output.write(`SemaFrame doctor · ${report.mode}\n`);
  for (const entry of report.checks) {
    const marker = entry.status === "pass" ? "PASS" : entry.status === "warn" ? "WARN" : "FAIL";
    output.write(`[${marker}] ${entry.label}: ${entry.detail}\n`);
  }
  output.write(report.ok ? "Ready.\n" : "Required checks failed; SemaFrame was not started.\n");
}

function writeAgentResult(agentResult, output, errorOutput) {
  const marker = agentResult.ok ? agentResult.state.toUpperCase() : "ERROR";
  const destination = agentResult.ok ? output : errorOutput;
  destination.write(`[${marker}] ${agentResult.detail}\n`);
  if (agentResult.restartRequired) {
    destination.write("Restart the Agent client so it reloads the MCP configuration.\n");
  }
}

async function installedVersion(packageRoot) {
  const source = await readFile(resolve(packageRoot, "package.json"), "utf8");
  return JSON.parse(source).version;
}

function launchHost({ xr, packageRoot, environment, spawnProcess }) {
  const script = resolve(packageRoot, "scripts/dev-agent.mjs");
  return spawnProcess(process.execPath, [script, ...(xr ? ["--xr"] : [])], {
    cwd: packageRoot,
    env: environment,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
}

export async function runSemaFrameCli(argv, {
  output = process.stdout,
  errorOutput = process.stderr,
  environment = process.env,
  packageRoot = SEMAFRAME_PACKAGE_ROOT,
  inspect = inspectSemaFrameHost,
  spawnProcess = spawn,
  agentAction = runAgentInstallationAction,
} = {}) {
  let parsed;
  try {
    parsed = parseSemaFrameCliArguments(argv);
  } catch (cause) {
    errorOutput.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 2;
  }
  if (parsed.command === "help") {
    output.write(`${helpText()}\n`);
    return 0;
  }
  if (parsed.command === "version") {
    output.write(`${await installedVersion(packageRoot)}\n`);
    return 0;
  }
  if (parsed.command === "agent") {
    let agentResult;
    try {
      agentResult = await agentAction(parsed.action, parsed.client, {
        packageRoot,
        environment,
      });
    } catch (cause) {
      errorOutput.write(`Agent setup failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 1;
    }
    writeAgentResult(agentResult, output, errorOutput);
    return agentResult.ok ? 0 : 1;
  }
  let report;
  try {
    report = await inspect({ xr: parsed.xr, environment, packageRoot });
  } catch (cause) {
    errorOutput.write(`Doctor failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
  if (parsed.command === "doctor") {
    if (parsed.json) output.write(`${JSON.stringify(report, null, 2)}\n`);
    else writeDoctor(report, output);
    return report.ok ? 0 : 1;
  }
  writeDoctor(report, output);
  if (!report.ok) return 1;
  output.write(`Starting SemaFrame ${parsed.xr ? "with XR" : "Workspace"}…\n`);
  const child = launchHost({ xr: parsed.xr, packageRoot, environment, spawnProcess });
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
      resolve(code);
    };
    const forwardInterrupt = () => child.kill("SIGINT");
    const forwardTerminate = () => child.kill("SIGTERM");
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    child.once("error", (cause) => {
      errorOutput.write(`SemaFrame could not start: ${cause.message}\n`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      if (signal && signal !== "SIGINT" && signal !== "SIGTERM") {
        errorOutput.write(`SemaFrame stopped after signal ${signal}.\n`);
      }
      finish(code ?? (signal ? 0 : 1));
    });
  });
}

/**
 * Real executable boundary. Load the optional package-root environment before
 * taking the environment snapshot used by doctor, onboarding, and launch.
 * Keeping this separate from runSemaFrameCli preserves a side-effect-free
 * programmatic API for tests and embedders that supply their own environment.
 */
export async function runSemaFrameCliEntrypoint(argv, {
  loadEnvironment = loadRootEnvironment,
  ...options
} = {}) {
  loadEnvironment();
  return runSemaFrameCli(argv, {
    ...options,
    environment: options.environment ?? process.env,
  });
}
