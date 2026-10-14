import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { runCapturedCommand, stableGatewayUrl } from "./agent-installation.mjs";
import { createDshMcpPatch } from "./dsh-setup.mjs";
import { spawnOwnedProcessTree } from "./owned-process-tree.mjs";

/** Produce a credential-free overlay without reading or modifying DSH settings. */
export async function createDshLauncherPatch({
  packageRoot,
  environment = process.env,
  nodeExecutable = process.execPath,
  resolveModule,
  accessFile = access,
} = {}) {
  if (typeof packageRoot !== "string" || !isAbsolute(packageRoot)) {
    throw new TypeError("The SemaFrame package path must be absolute.");
  }
  const require = createRequire(resolve(packageRoot, "package.json"));
  const loader = (resolveModule ?? ((specifier) => require.resolve(specifier)))("tsx");
  if (typeof loader !== "string" || !isAbsolute(loader) || loader.includes("\u0000")) {
    throw new TypeError("The installed tsx runtime could not be resolved safely.");
  }
  const bridge = resolve(packageRoot, "scripts", "agent-mcp.ts");
  const patch = createDshMcpPatch(JSON.stringify({
    mcpServers: {
      semaframe: {
        command: nodeExecutable,
        args: ["--import", pathToFileURL(loader).href, bridge],
        env: { SEMAFRAME_AGENT_GATEWAY_URL: stableGatewayUrl(environment) },
      },
    },
  }));
  await Promise.all([loader, bridge].map((path) => accessFile(path, fsConstants.R_OK)));
  return patch;
}

function childExitCode(code, signal) {
  return Number.isInteger(code) ? code : (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1);
}

async function inspectDshBundleIdentifier(bundlePath) {
  const result = await runCapturedCommand("/usr/bin/plutil", [
    "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(bundlePath, "Contents", "Info.plist"),
  ], { timeoutMs: 3_000 });
  return result.code === 0 && !result.errorCode && !result.timedOut
    ? result.stdout.trim()
    : undefined;
}

/** Resolve installed launchers without changing PATH or evaluating npm shims. */
export async function resolveDshLaunchCommand({
  platform = process.platform,
  environment = process.env,
  nodeExecutable = process.execPath,
  cwd = process.cwd(),
  homeDirectory = homedir(),
  accessFile = access,
  readText = readFile,
  inspectFile = lstat,
  readBundleIdentifier = inspectDshBundleIdentifier,
} = {}) {
  if (platform === "darwin") {
    for (const directory of (environment.PATH ?? "/usr/bin:/bin").split(":")) {
      const command = resolve(cwd, directory, "dsh");
      try {
        // Prefer the explicitly configured PATH installation even if its
        // executable bit or interpreter is broken: report its startup error
        // rather than silently switching the user's DSH installation.
        await accessFile(command, fsConstants.F_OK);
        return { command, leadingArgs: [] };
      } catch (cause) {
        if (cause?.code === "EACCES" || cause?.code === "EPERM") return { command, leadingArgs: [] };
        if (cause?.code === "ENOENT") {
          try {
            // F_OK follows symlinks. A broken explicit PATH shim must also
            // fail visibly instead of switching to a different installation.
            await inspectFile(command);
            return { command, leadingArgs: [] };
          } catch { /* no entry at this PATH location */ }
        }
      }
    }
    const bundles = [
      "/Applications/DeepSeek Harness.app",
      ...(isAbsolute(homeDirectory) ? [join(homeDirectory, "Applications", "DeepSeek Harness.app")] : []),
    ];
    for (const bundle of bundles) {
      const command = join(bundle, "Contents", "Resources", "runtime", "cli", "bin", "dsh");
      try {
        await accessFile(command, fsConstants.X_OK);
        if (await readBundleIdentifier(bundle) === "com.deepseek.dsh") return { command, leadingArgs: [] };
      } catch { /* absent, inaccessible, or a bundle that cannot be identified */ }
    }
    return undefined;
  }
  if (platform !== "win32") return { command: "dsh", leadingArgs: [] };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
  const directories = (environment[pathKey] ?? "").split(";");
  const exists = async (path) => {
    try { await accessFile(path, fsConstants.R_OK); return true; } catch { return false; }
  };
  for (const raw of directories) {
    const directory = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    // Ignore implicit cwd entries and relative search paths. Only an installed
    // executable from an explicit absolute PATH directory is eligible.
    if (!win32.isAbsolute(directory) || directory.includes("\u0000")) continue;
    const executable = win32.join(directory, "dsh.exe");
    if (await exists(executable)) return { command: executable, leadingArgs: [] };
    if (!await exists(win32.join(directory, "dsh.cmd"))) continue;
    const packageRoots = [
      win32.join(directory, "node_modules", "@deepseek-ai", "dsh"),
      ...(win32.basename(directory).toLowerCase() === ".bin"
        ? [win32.resolve(directory, "..", "@deepseek-ai", "dsh")]
        : []),
    ];
    for (const root of packageRoots) {
      let manifest;
      try {
        const source = await readText(win32.join(root, "package.json"), "utf8");
        if (typeof source !== "string" || source.length > 65_536) continue;
        manifest = JSON.parse(source);
      } catch { continue; }
      if (manifest?.name !== "@deepseek-ai/dsh"
        || manifest?.bin?.dsh !== "lib/bin.js") continue;
      const entry = win32.join(root, "lib", "bin.js");
      if (await exists(entry)) return { command: nodeExecutable, leadingArgs: [entry] };
    }
    // Do not silently bypass the first DSH shim in PATH for another install.
    // Unknown package-manager layouts require the explicit manual overlay.
    return undefined;
  }
  return undefined;
}

/**
 * Launch only an already-installed official DSH CLI. The caller's current
 * directory and provider environment remain DSH's, while the temporary patch
 * contains only the stable SemaFrame connection. Never write its home/profile.
 */
export async function launchDshAgent({
  packageRoot,
  environment = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  spawnProcess = spawn,
  errorOutput = process.stderr,
  signalSource = process,
  temporaryRoot = tmpdir(),
  createPatch = createDshLauncherPatch,
  resolveCommand = resolveDshLaunchCommand,
  treeOptions = {},
} = {}) {
  const patch = await createPatch({ packageRoot, environment });
  const launch = await resolveCommand({ platform, environment, cwd });
  if (!launch) {
    errorOutput.write("No supported installed DeepSeek Harness launcher was found. Install the official dsh CLI separately (or the macOS DeepSeek Harness app), or export `semaframe agent config --client dsh` and use `dsh web --patch <file>` manually. SemaFrame never downloads DSH or executes .cmd shim scripts.\n");
    return 1;
  }
  const directory = await mkdtemp(join(temporaryRoot, "semaframe-dsh-"));
  const patchPath = join(directory, "semaframe.patch.json");
  try {
    await writeFile(patchPath, `${patch}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    errorOutput.write("Launching DeepSeek Harness with the SemaFrame MCP overlay. Approve its connection in SemaFrame when requested.\n");
    return await new Promise((resolveExit) => {
      let child;
      let tree;
      let settled = false;
      let shutdown;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        signalSource.off("SIGINT", forwardInterrupt);
        signalSource.off("SIGTERM", forwardTerminate);
        resolveExit(code);
      };
      const drain = (code) => {
        if (shutdown) return shutdown;
        shutdown = (async () => {
          try {
            await tree?.stop();
            finish(code);
          } catch (cause) {
            errorOutput.write(cause?.code === "OWNED_WINDOWS_TREE_UNVERIFIED"
              ? "DeepSeek Harness exited before Windows process-tree cleanup could be confirmed. SemaFrame will not target an exited, reusable PID. Check Task Manager for remaining processes from this DSH launch before retrying; automatic cleanup after a natural Windows root exit is not supported.\n"
              : "DeepSeek Harness process cleanup failed. Check for remaining DSH processes before retrying.\n");
            finish(1);
          }
        })();
        return shutdown;
      };
      const forwardSignal = (signal) => {
        if (settled) return;
        // On Windows, terminating only the root first destroys taskkill's
        // safe tree target. Start bounded tree termination while it is alive.
        // POSIX descendants retain their owned process group after root exit.
        if (platform !== "win32") {
          try { child?.kill(signal); } catch { /* tree drain still runs */ }
        }
        void drain(childExitCode(null, signal));
      };
      const forwardInterrupt = () => forwardSignal("SIGINT");
      const forwardTerminate = () => forwardSignal("SIGTERM");
      const failed = (cause) => {
        errorOutput.write(cause?.code === "ENOENT"
          ? "DeepSeek Harness (dsh) or its required runtime could not be found. Install the official DeepSeek Harness CLI separately, then retry; SemaFrame will not download or install it automatically.\n"
          : "DeepSeek Harness could not start. Check its local installation and executable permissions.\n");
        void drain(1);
      };
      try {
        tree = spawnOwnedProcessTree(launch.command, [...launch.leadingArgs, "web", "--patch", patchPath], {
          cwd,
          env: environment,
          stdio: "inherit",
          shell: false,
          windowsHide: true,
        }, {
          platform,
          ...treeOptions,
          spawnProcess(command, args, options) {
            child = spawnProcess(command, args, options);
            // ENOENT has no PID: capture its error before the owned-tree
            // helper validates the spawn, without leaving an unhandled event.
            child.once("error", failed);
            return child;
          },
        });
      } catch (cause) {
        if (!child || child.pid) failed(cause);
        return;
      }
      signalSource.on("SIGINT", forwardInterrupt);
      signalSource.on("SIGTERM", forwardTerminate);
      // Begin drain at leader exit, before close. POSIX still owns the group;
      // Windows reports an unverified drain rather than targeting a dead PID.
      // Inherited stdio close alone never proves descendants have exited.
      child.once("exit", (code, signal) => { void drain(childExitCode(code, signal)); });
      child.once("close", (code, signal) => { void drain(childExitCode(code, signal)); });
    });
  } finally {
    // Only our single known file and unique directory are removed. Never
    // recursively remove a directory or delete anything created by the user.
    await unlink(patchPath).catch((cause) => { if (cause.code !== "ENOENT") throw cause; });
    await rmdir(directory);
  }
}
