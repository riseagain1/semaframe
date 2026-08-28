import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveNpmLaunch } from "./lib/npm-launcher.mjs";
import {
  createOwnedProcessSupervisor,
  spawnOwnedProcessTree,
  stopOwnedProcessTrees,
} from "./lib/owned-process-tree.mjs";
import { loadRootEnvironment } from "./lib/root-env.mjs";
import { buildVoiceRelayNativeHelper } from "./build-voice-relay.mjs";

loadRootEnvironment();
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
let builtVoiceRelayHelperSha256;
if (process.env.SEMAFRAME_VOICE_RELAY_SKIP_BUILD !== "1") {
  const helper = buildVoiceRelayNativeHelper({ optional: true });
  if ("output" in helper && helper.output) {
    builtVoiceRelayHelperSha256 = createHash("sha256").update(readFileSync(helper.output)).digest("hex");
  }
}

const vitePort = process.env.SEMAFRAME_AGENT_VITE_PORT?.trim() || "4173";
const viteArguments = ["run", "dev:local", "--", "--port", vitePort];
const startXrRenderer = process.argv.includes("--xr");
const browserOrigins = `http://127.0.0.1:${vitePort},http://localhost:${vitePort}`;
const xrVitePort = process.env.SEMAFRAME_XR_VITE_PORT?.trim() || "4174";
const xrRendererOrigins = process.env.SEMAFRAME_XR_ALLOWED_ORIGINS
  || `http://127.0.0.1:${xrVitePort},http://localhost:${xrVitePort}`;
const gatewayPort = process.env.SEMAFRAME_AGENT_GATEWAY_PORT?.trim() || "8788";
const gatewayHost = process.env.SEMAFRAME_AGENT_GATEWAY_HOST?.trim() || "127.0.0.1";
const gatewayPublicHost = gatewayHost === "::1" ? "[::1]" : gatewayHost;
const gatewayInternalUrl = `http://${gatewayPublicHost}:${gatewayPort}`;
const browserBootstrapToken = process.env.SEMAFRAME_AGENT_BROWSER_TOKEN?.trim()
  || randomBytes(32).toString("base64url");
if (!/^[A-Za-z0-9_-]{43}$/u.test(browserBootstrapToken)) {
  throw new Error("SEMAFRAME_AGENT_BROWSER_TOKEN must be a 256-bit base64url capability.");
}
const gatewayEnvironment = {
  ...process.env,
  SEMAFRAME_AGENT_ALLOWED_ORIGINS: process.env.SEMAFRAME_AGENT_ALLOWED_ORIGINS || browserOrigins,
  SEMAFRAME_AGENT_BROWSER_TOKEN: browserBootstrapToken,
  SEMAFRAME_XR_ALLOWED_ORIGINS: xrRendererOrigins,
  ...(process.env.SEMAFRAME_VOICE_RELAY_HELPER_SHA256?.trim()
    ? { SEMAFRAME_VOICE_RELAY_HELPER_SHA256: process.env.SEMAFRAME_VOICE_RELAY_HELPER_SHA256.trim() }
    : builtVoiceRelayHelperSha256
      ? { SEMAFRAME_VOICE_RELAY_HELPER_SHA256: builtVoiceRelayHelperSha256 }
      : {}),
  ...(process.env.SEMAFRAME_VOICE_RELAY_ALLOW_UNSIGNED_HELPER?.trim()
    ? { SEMAFRAME_VOICE_RELAY_ALLOW_UNSIGNED_HELPER: process.env.SEMAFRAME_VOICE_RELAY_ALLOW_UNSIGNED_HELPER.trim() }
    : {}),
};
const viteEnvironment = {
  ...process.env,
  VITE_AGENT_CONTROL_ENDPOINT: "/api/agent",
  // Browser-authority routes always travel to the loopback listener. The
  // separately advertised HTTPS origin is only for external MCP/upload links.
  SEMAFRAME_AGENT_GATEWAY_URL: gatewayInternalUrl,
  SEMAFRAME_AGENT_BROWSER_TOKEN: browserBootstrapToken,
};

function spawnNpm(args, environment, termGraceMs = 5_000) {
  const launch = resolveNpmLaunch(args);
  return spawnOwnedProcessTree(launch.command, launch.args, {
    cwd: packageRoot,
    stdio: "inherit",
    env: environment,
    shell: false,
    windowsHide: true,
  }, {
    termGraceMs,
    forceGraceMs: 5_000,
  });
}

const processTrees = [];
try {
  // Keep the browser UI and gateway on the same source revision during local
  // development. The one-shot agent:gateway script remains available for
  // production-style and manual launches. The Gateway may need its documented
  // shutdown window to finish or roll back an accepted configuration update.
  processTrees.push(spawnNpm(["run", "agent:gateway:watch"], gatewayEnvironment, 110_000));
  processTrees.push(spawnNpm(viteArguments, viteEnvironment));
  if (startXrRenderer) {
    processTrees.push(spawnNpm(["run", "dev:xr:client"], viteEnvironment));
  }
} catch (startupCause) {
  try {
    await stopOwnedProcessTrees(processTrees);
  } catch (cleanupCause) {
    throw new AggregateError(
      [startupCause, cleanupCause],
      "SemaFrame startup and owned-process cleanup both failed.",
    );
  }
  throw startupCause;
}

const supervisor = createOwnedProcessSupervisor(processTrees, {
  reportFailure: () => {
    // Avoid printing commands, paths, environment, or child output here.
    console.error("SemaFrame could not stop every owned development process.");
  },
});

for (const { child } of processTrees) {
  child.on("exit", (code, signal) => {
    if (!supervisor.stopping) {
      console.error(`SemaFrame development process stopped (${signal ?? code ?? "unknown"}).`);
      void supervisor.stop(code ?? 1);
    }
  });
  child.on("error", (error) => {
    console.error(error.message);
    void supervisor.stop(1);
  });
}

const alreadyExited = processTrees.find((tree) => tree.exited);
if (alreadyExited && !supervisor.stopping) {
  console.error("SemaFrame development process stopped during startup.");
  void supervisor.stop(alreadyExited.child.exitCode ?? 1);
}

process.on("SIGINT", () => { void supervisor.stop(0); });
process.on("SIGTERM", () => { void supervisor.stop(0); });
