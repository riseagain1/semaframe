import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { resolveNpmLaunch } from "./lib/npm-launcher.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "semaframe-package-"));

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

try {
  const packed = await runNpm(["pack", "--json", "--pack-destination", temporaryRoot]);
  const [packReport] = JSON.parse(packed.stdout);
  assert.equal(packReport.name, "semaframe");
  assert.ok(packReport.files.some(({ path }) => path === "bin/semaframe.mjs"));
  assert.ok(packReport.files.some(({ path }) => path === "scripts/dev-agent.mjs"));
  assert.ok(packReport.files.some(({ path }) => path === "server/agent/start.ts"));
  assert.ok(packReport.files.some(({ path }) => path === "src/main.tsx"));
  assert.ok(packReport.files.some(({ path }) => path === "xr.html"));
  assert.ok(packReport.entryCount < 700, `Package contains an unexpected ${packReport.entryCount} files.`);
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
      npm_config_cache: join(temporaryRoot, "npm-cache"),
    },
  });

  const installedRoot = join(temporaryRoot, "node_modules", "semaframe");
  const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  assert.equal(manifest.bin.semaframe, "./bin/semaframe.mjs");
  for (const runtimeDependency of ["vite", "tsx", "@vitejs/plugin-react"]) {
    assert.ok(manifest.dependencies[runtimeDependency], `${runtimeDependency} must be a production dependency.`);
  }

  const version = await run(process.execPath, [join(installedRoot, "bin", "semaframe.mjs"), "--version"], {
    cwd: temporaryRoot,
  });
  assert.equal(version.stdout.trim(), manifest.version);
  const npmExecVersion = await runNpm(["exec", "--", "semaframe", "--version"], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      npm_config_cache: join(temporaryRoot, "npm-cache"),
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
  const launched = spawn(process.execPath, [join(installedRoot, "bin", "semaframe.mjs"), "xr"], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      npm_config_cache: join(temporaryRoot, "npm-cache"),
      SEMAFRAME_AGENT_VITE_PORT: String(workspacePort),
      SEMAFRAME_AGENT_GATEWAY_PORT: String(gatewayPort),
      SEMAFRAME_XR_VITE_PORT: String(xrPort),
      SEMAFRAME_VOICE_RELAY_SKIP_BUILD: "1",
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  } finally {
    const exited = launched.exitCode !== null || launched.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolveExit) => launched.once("exit", resolveExit));
    launched.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
    if (launched.exitCode === null && launched.signalCode === null) launched.kill("SIGKILL");
  }
  console.log(`Verified packed CLI ${manifest.version}: ${packReport.entryCount} files, ${packReport.unpackedSize} bytes unpacked.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
