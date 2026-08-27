import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { resolveNpmLaunch } from "./lib/npm-launcher.mjs";
import { spawnOwnedProcessTree } from "./lib/owned-process-tree.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "semaframe-package-"));
const configuredNpmCache = process.env.SEMAFRAME_PACKAGE_VERIFY_NPM_CACHE?.trim();
if (configuredNpmCache && (!isAbsolute(configuredNpmCache) || configuredNpmCache.includes("\0"))) {
  throw new TypeError("SEMAFRAME_PACKAGE_VERIFY_NPM_CACHE must be an absolute path without NUL bytes.");
}
// CI may reuse setup-node's content-addressed download cache. Runtime
// isolation still comes from the fresh install root, --omit=dev, and the
// canonical realpath assertions below; no node_modules directory is shared.
const verificationNpmCache = configuredNpmCache || join(temporaryRoot, "npm-cache");

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code ?? "unknown"}).\n${stderr || stdout}`));
    });
  });
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((cause) => cause ? reject(cause) : resolvePort(port));
    });
  });
}

async function waitForHttp(url, child, output, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged CLI stopped before ${url} became ready.\n${output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The two packaged services start independently; retry within the bound.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}.\n${output()}`);
}

async function runNpm(args, options) {
  const launch = resolveNpmLaunch(args);
  return run(launch.command, launch.args, options);
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ""
    && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && fromRoot !== ".."
    && !isAbsolute(fromRoot);
}

async function withTimeout(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyPackedAgentInstaller(installedRoot) {
  const installationModuleUrl = pathToFileURL(join(
    installedRoot,
    "scripts",
    "lib",
    "agent-installation.mjs",
  )).href;
  const { createAgentInstallationService } = await import(installationModuleUrl);
  const installedRequire = createRequire(join(installedRoot, "package.json"));
  const expectedLoaderPath = installedRequire.resolve("tsx");
  let addInvocation;

  const service = createAgentInstallationService({
    packageRoot: installedRoot,
    environment: { SEMAFRAME_AGENT_GATEWAY_PORT: "48788" },
    nodeExecutable: process.execPath,
    spawnCommand: async (command, args) => {
      assert.equal(command, "codex");
      if (args[0] === "mcp" && args[1] === "get") {
        return Object.freeze({
          code: 1,
          stdout: "",
          stderr: "Error: No MCP server named 'semaframe' found.",
          errorCode: undefined,
          timedOut: false,
        });
      }
      if (args[0] === "mcp" && args[1] === "add") {
        addInvocation = [...args];
        return Object.freeze({
          code: 1,
          stdout: "",
          stderr: "Intentional packed verifier write refusal.",
          errorCode: undefined,
          timedOut: false,
        });
      }
      assert.fail(`Unexpected packed installer command: ${args.join(" ")}`);
    },
  });

  const outcome = await service.install("codex");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, "error");
  assert.ok(addInvocation, "The packed installer did not reach the official Codex add command.");
  const separator = addInvocation.indexOf("--");
  assert.notEqual(separator, -1, "The packed installer did not create a stdio launcher.");
  assert.equal(addInvocation[separator + 1], process.execPath);
  assert.equal(addInvocation[separator + 2], "--import");
  const configuredLoaderPath = fileURLToPath(addInvocation[separator + 3]);
  assert.equal(configuredLoaderPath, expectedLoaderPath);
  assert.equal(addInvocation[separator + 4], join(installedRoot, "scripts", "agent-mcp.ts"));

  await access(configuredLoaderPath, fsConstants.R_OK);
  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const canonicalLoaderPath = await realpath(configuredLoaderPath);
  assert.ok(
    pathIsInside(canonicalTemporaryRoot, canonicalLoaderPath),
    "The packed installer configured a loader outside the isolated production install.",
  );
}

/**
 * Exercise the exact TypeScript bridge shipped by the tarball after an
 * `--omit=dev` install. Merely checking package.json would miss a runtime-only
 * import accidentally left in devDependencies; spawning the bridge forces Node
 * to resolve every top-level import from the isolated production tree.
 */
async function verifyPackedAgentBridge(installedRoot) {
  const installedRequire = createRequire(join(installedRoot, "package.json"));
  const loaderPath = installedRequire.resolve("tsx");
  const clientEntry = installedRequire.resolve("@modelcontextprotocol/client");
  // macOS commonly exposes the same temporary directory through both
  // /var and /private/var (and /tmp through /private/tmp). Compare canonical
  // paths so that symlink aliases do not look like dependency leakage.
  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const canonicalLoaderPath = await realpath(loaderPath);
  const canonicalClientEntry = await realpath(clientEntry);
  assert.ok(
    pathIsInside(canonicalTemporaryRoot, canonicalLoaderPath),
    "The packed Agent bridge loader resolved outside the isolated production install.",
  );
  assert.ok(
    pathIsInside(canonicalTemporaryRoot, canonicalClientEntry),
    "The packed Agent MCP client resolved outside the isolated production install.",
  );

  const client = new Client({
    name: "semaframe-packed-production-verifier",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(loaderPath).href,
      join(installedRoot, "scripts", "agent-mcp.ts"),
    ],
    cwd: installedRoot,
    env: {
      ...getDefaultEnvironment(),
      // A legacy one-off URL avoids contacting a real Gateway while still
      // booting the complete bridge and serving its local tool catalog.
      SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:9/mcp/packed-production-verifier",
      SEMAFRAME_AGENT_CONNECT_TIMEOUT_MS: "500",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });

  try {
    await withTimeout(
      client.connect(transport),
      10_000,
      "Timed out starting the packed Agent MCP bridge.",
    );
    const catalog = await withTimeout(
      client.listTools(undefined, { timeout: 5_000 }),
      10_000,
      "Timed out listing tools from the packed Agent MCP bridge.",
    );
    assert.ok(
      catalog.tools.some(({ name }) => name === "get_workspace_instructions"),
      "The packed Agent MCP bridge did not expose its core workspace tools.",
    );
  } catch (cause) {
    const diagnostic = stderr.trim();
    throw new Error(
      `Packed Agent MCP bridge startup failed.${diagnostic ? `\n${diagnostic}` : ""}`,
      { cause },
    );
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function verifyPackedManualMcpSetup({
  installedRoot,
  gatewayUrl,
  workspaceOrigin,
  browserBootstrapToken,
}) {
  const bootstrapHeaders = {
    "x-semaframe-browser-bootstrap": browserBootstrapToken,
  };
  const configResponse = await fetch(`${gatewayUrl}/api/agent/config`, {
    headers: bootstrapHeaders,
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(configResponse.status, 200, "The packed Gateway did not expose browser bootstrap config.");
  const config = await configResponse.json();
  assert.equal(typeof config.csrfToken, "string");
  const mutationHeaders = {
    ...bootstrapHeaders,
    origin: workspaceOrigin,
    "content-type": "application/json",
    "x-semaframe-agent-csrf": config.csrfToken,
  };
  const enableResponse = await fetch(`${gatewayUrl}/api/agent/browser/enable`, {
    method: "POST",
    headers: mutationHeaders,
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(enableResponse.status, 200, "The packed Gateway could not enable Agent control.");
  const revealResponse = await fetch(`${gatewayUrl}/api/agent/browser/reveal`, {
    method: "POST",
    headers: mutationHeaders,
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(revealResponse.status, 200, "The packed Gateway could not reveal manual MCP setup.");
  const reveal = await revealResponse.json();
  const manualConfig = JSON.parse(reveal.mcpConfig);
  const launcher = manualConfig?.mcpServers?.semaframe;
  assert.equal(launcher?.command, process.execPath);
  assert.equal(launcher?.args?.[0], "--import");
  assert.equal(
    await realpath(launcher?.args?.[2]),
    await realpath(join(installedRoot, "scripts", "agent-mcp.ts")),
  );
  const installedRequire = createRequire(join(installedRoot, "package.json"));
  assert.equal(
    await realpath(fileURLToPath(launcher.args[1])),
    await realpath(installedRequire.resolve("tsx")),
    "The packed manual MCP setup did not use the production-resolved tsx loader.",
  );
  assert.deepEqual(launcher.env, { SEMAFRAME_AGENT_GATEWAY_URL: gatewayUrl });
}

try {
  const packed = await runNpm(["pack", "--json", "--pack-destination", temporaryRoot]);
  const [packReport] = JSON.parse(packed.stdout);
  assert.equal(packReport.name, "semaframe");
  assert.ok(packReport.files.some(({ path }) => path === "bin/semaframe.mjs"));
  assert.ok(packReport.files.some(({ path }) => path === "scripts/dev-agent.mjs"));
  assert.ok(packReport.files.some(({ path }) => path === "server/agent/start.ts"));
  assert.ok(packReport.files.some(({ path }) => path === "src/main.tsx"));
  assert.ok(packReport.files.some(({ path }) => path === "xr.html"));
  assert.ok(packReport.entryCount <= 700, `Package contains an unexpected ${packReport.entryCount} files.`);
  assert.ok(packReport.unpackedSize < 12 * 1024 * 1024, "Package source payload exceeds the 12 MiB budget.");

  const archive = join(temporaryRoot, packReport.filename);
  await runNpm([
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    archive,
  ], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      npm_config_cache: verificationNpmCache,
    },
  });

  const installedRoot = join(temporaryRoot, "node_modules", "semaframe");
  const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  assert.equal(manifest.bin.semaframe, "./bin/semaframe.mjs");
  for (const runtimeDependency of [
    "vite",
    "tsx",
    "@vitejs/plugin-react",
    "@modelcontextprotocol/client",
  ]) {
    assert.ok(manifest.dependencies[runtimeDependency], `${runtimeDependency} must be a production dependency.`);
  }

  await verifyPackedAgentInstaller(installedRoot);
  await verifyPackedAgentBridge(installedRoot);

  const version = await run(process.execPath, [join(installedRoot, "bin", "semaframe.mjs"), "--version"], {
    cwd: temporaryRoot,
  });
  assert.equal(version.stdout.trim(), manifest.version);
  const npmExecVersion = await runNpm(["exec", "--", "semaframe", "--version"], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      npm_config_cache: verificationNpmCache,
    },
  });
  assert.equal(npmExecVersion.stdout.trim(), manifest.version);

  const doctor = await run(process.execPath, [join(installedRoot, "bin", "semaframe.mjs"), "doctor", "--json"], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      SEMAFRAME_AGENT_VITE_PORT: "44173",
      SEMAFRAME_AGENT_GATEWAY_PORT: "48788",
      SEMAFRAME_XR_VITE_PORT: "44174",
    },
  });
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(({ id }) => id === "package")?.status, "pass");

  const workspacePort = await availablePort();
  let gatewayPort = await availablePort();
  while (gatewayPort === workspacePort) gatewayPort = await availablePort();
  let xrPort = await availablePort();
  while (xrPort === workspacePort || xrPort === gatewayPort) xrPort = await availablePort();
  let launchOutput = "";
  const browserBootstrapToken = "b".repeat(43);
  const launchedTree = spawnOwnedProcessTree(
    process.execPath,
    [join(installedRoot, "bin", "semaframe.mjs"), "xr"],
    {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        npm_config_cache: verificationNpmCache,
        SEMAFRAME_AGENT_VITE_PORT: String(workspacePort),
        SEMAFRAME_AGENT_GATEWAY_PORT: String(gatewayPort),
        SEMAFRAME_XR_VITE_PORT: String(xrPort),
        SEMAFRAME_AGENT_BROWSER_TOKEN: browserBootstrapToken,
        SEMAFRAME_VOICE_RELAY_SKIP_BUILD: "1",
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
    { termGraceMs: 10_000, forceGraceMs: 5_000 },
  );
  const { child: launched } = launchedTree;
  launched.stdout.setEncoding("utf8");
  launched.stderr.setEncoding("utf8");
  launched.stdout.on("data", (chunk) => { launchOutput += chunk; });
  launched.stderr.on("data", (chunk) => { launchOutput += chunk; });
  try {
    await Promise.all([
      waitForHttp(`http://127.0.0.1:${workspacePort}/`, launched, () => launchOutput),
      waitForHttp(`http://127.0.0.1:${gatewayPort}/openapi.json`, launched, () => launchOutput),
      waitForHttp(`http://127.0.0.1:${xrPort}/xr.html`, launched, () => launchOutput),
    ]);
    await verifyPackedManualMcpSetup({
      installedRoot,
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      workspaceOrigin: `http://127.0.0.1:${workspacePort}`,
      browserBootstrapToken,
    });
  } finally {
    try {
      // Waiting for ChildProcess `close`, not merely `exit`, proves every
      // descendant released the inherited output pipes. On POSIX the wrapper
      // is also an isolated process group, providing a verifier-side fallback.
      await launchedTree.stop();
    } finally {
      // If cleanup fails, release the verifier's own handles so it reports the
      // bounded failure instead of masking it with a CI job-level timeout.
      launched.stdout.destroy();
      launched.stderr.destroy();
    }
  }
  console.log(`Verified packed CLI ${manifest.version}: ${packReport.entryCount} files, ${packReport.unpackedSize} bytes unpacked.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
