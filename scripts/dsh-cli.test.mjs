import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, readdir, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDshLauncherPatch, launchDshAgent, resolveDshLaunchCommand } from "./lib/dsh-launcher.mjs";
import { parseSemaFrameCliArguments, runSemaFrameCli } from "./lib/semaframe-cli.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const mockRoot = "/Applications/Sema Frame";

function sink() {
  let value = "";
  return { stream: { write: (chunk) => { value += chunk; } }, read: () => value };
}

function patchOptions(environment = {}) {
  return {
    packageRoot: mockRoot,
    nodeExecutable: "/usr/local/bin/node",
    environment,
    resolveModule: () => `${mockRoot}/node_modules/tsx/dist/loader.mjs`,
    accessFile: async () => undefined,
  };
}

function childFixture() {
  const child = new EventEmitter();
  child.pid = 43210;
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  child.close = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  return child;
}

function missingGroup() {
  throw Object.assign(new Error("gone"), { code: "ESRCH" });
}

const mockCommand = async () => ({ command: "dsh", leadingArgs: [] });

function missingFile() {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
}

test("DSH config and launch are explicit and never enter the Codex/Claude installer", async () => {
  for (const action of ["config", "launch"]) {
    assert.deepEqual(parseSemaFrameCliArguments(["agent", action, "--client", "dsh"]), {
      command: "agent", action, client: "dsh",
    });
    assert.throws(() => parseSemaFrameCliArguments(["agent", action, "--client", "codex"]), /require --client dsh/u);
  }
  for (const action of ["install", "status", "update", "remove"]) {
    assert.throws(() => parseSemaFrameCliArguments(["agent", action, "--client", "dsh"]), /agent config or agent launch/u);
  }
  assert.throws(() => parseSemaFrameCliArguments(["agent", "launch", "--client", "dsh", "--command", "other"]), /Unknown option/u);
  assert.throws(() => parseSemaFrameCliArguments(["agent", "launch", "--client", "dsh; echo hi"]), /require --client dsh/u);
  assert.throws(() => parseSemaFrameCliArguments(["agent", "config", "--client=dsh", "--client=dsh"]), /only once/u);
  const output = sink();
  const errorOutput = sink();
  const code = await runSemaFrameCli(["agent", "config", "--client=dsh"], {
    packageRoot, output: output.stream, errorOutput: errorOutput.stream,
    environment: { DEEPSEEK_API_KEY: "never-export-test-secret" },
    agentAction: () => assert.fail("must not run installer"),
    inspect: () => assert.fail("must not inspect occupied service ports"),
  });
  assert.equal(code, 0);
  const entry = JSON.parse(output.read())[0].insert[0];
  assert.equal(entry.name, "@deepseek-ai/dsh-mcp-client");
  assert.equal(entry.config.command, process.execPath);
  assert.equal(entry.config.env.SEMAFRAME_AGENT_NAME, "DeepSeek Harness");
  assert.doesNotMatch(output.read(), /never-export-test-secret/u);
  assert.equal(errorOutput.read(), "");
});

test("DSH overlay validates the stable loopback entrance, files, and argv boundaries", async () => {
  const patch = JSON.parse(await createDshLauncherPatch(patchOptions({
    SEMAFRAME_AGENT_GATEWAY_HOST: "::1", SEMAFRAME_AGENT_GATEWAY_PORT: "4991",
    SEMAFRAME_AGENT_MCP_URL: "https://never-export.example/private-offer",
    SEMAFRAME_AGENT_NAME: "not copied",
  })));
  const config = patch[0].insert[0].config;
  assert.equal(config.env.SEMAFRAME_AGENT_GATEWAY_URL, "http://[::1]:4991");
  assert.deepEqual(config.args, ["--import", "file:///Applications/Sema%20Frame/node_modules/tsx/dist/loader.mjs", `${mockRoot}/scripts/agent-mcp.ts`]);
  assert.deepEqual(Object.keys(config.env).sort(), ["SEMAFRAME_AGENT_GATEWAY_URL", "SEMAFRAME_AGENT_NAME"]);
  for (const gateway of ["https://127.0.0.1:8788", "http://attacker.example:8788", "http://127.0.0.1:8788/private", "http://user:secret@127.0.0.1:8788"]) {
    await assert.rejects(createDshLauncherPatch(patchOptions({ SEMAFRAME_AGENT_GATEWAY_URL: gateway })), /loopback HTTP origin/u);
  }
  await assert.rejects(createDshLauncherPatch({ ...patchOptions(), packageRoot: "relative" }), /absolute/u);
  await assert.rejects(createDshLauncherPatch({ ...patchOptions(), resolveModule: () => "relative" }), /runtime/u);
  await assert.rejects(createDshLauncherPatch({ ...patchOptions(), nodeExecutable: "/bin/sh" }), /stdio configuration/u);
  await assert.rejects(createDshLauncherPatch({ ...patchOptions(), accessFile: async () => { throw new Error("missing runtime"); } }), /missing runtime/u);
});

test("Windows DSH npm shims resolve only the fixed official entry without a command shell", async () => {
  for (const [directory, root] of [
    ["C:\\Users\\Test User\\npm", "C:\\Users\\Test User\\npm\\node_modules\\@deepseek-ai\\dsh"],
    ["C:\\work\\node_modules\\.bin", "C:\\work\\node_modules\\@deepseek-ai\\dsh"],
  ]) {
    const files = new Map([
      [`${directory}\\dsh.cmd`, "never read or execute the shim"],
      [`${root}\\package.json`, JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "lib/bin.js" } })],
      [`${root}\\lib\\bin.js`, ""],
    ]);
    const result = await resolveDshLaunchCommand({
      platform: "win32", environment: { Path: `relative;;"${directory}"` }, nodeExecutable: "C:\\node\\node.exe",
      accessFile: async (path) => { if (!files.has(path)) throw new Error("missing"); },
      readText: async (path) => { assert.ok(path.endsWith("package.json")); return files.get(path); },
    });
    assert.deepEqual(result, { command: "C:\\node\\node.exe", leadingArgs: [`${root}\\lib\\bin.js`] });
  }
});

test("macOS prefers PATH DSH without falling back when that installation is inaccessible", async () => {
  for (const inaccessible of [false, true]) {
    const visited = [];
    const result = await resolveDshLaunchCommand({
      platform: "darwin", environment: { PATH: "/preferred/bin:/second/bin" },
      accessFile: async (path, mode) => {
        visited.push(path);
        assert.equal(mode, 0);
        if (inaccessible) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
      readBundleIdentifier: () => assert.fail("existing PATH installation wins"),
    });
    assert.deepEqual(result, { command: "/preferred/bin/dsh", leadingArgs: [] });
    assert.deepEqual(visited, ["/preferred/bin/dsh"]);
  }
  assert.deepEqual(await resolveDshLaunchCommand({
    platform: "darwin", environment: { PATH: "/broken/bin" },
    accessFile: async () => missingFile(),
    inspectFile: async (path) => { assert.equal(path, "/broken/bin/dsh"); return {}; },
    readBundleIdentifier: () => assert.fail("broken PATH symlink must not switch installations"),
  }), { command: "/broken/bin/dsh", leadingArgs: [] });
});

test("macOS discovers only executable official Desktop bundles at the two standard locations", async () => {
  for (const bundle of ["/Applications/DeepSeek Harness.app", "/Users/example/Applications/DeepSeek Harness.app"]) {
    const command = `${bundle}/Contents/Resources/runtime/cli/bin/dsh`;
    const result = await resolveDshLaunchCommand({
      platform: "darwin", environment: { PATH: "/missing/bin" }, homeDirectory: "/Users/example",
      accessFile: async (path, mode) => {
        if (path !== command) missingFile();
        assert.equal(mode, 1);
      },
      readBundleIdentifier: async (path) => { assert.equal(path, bundle); return "com.deepseek.dsh"; },
    });
    assert.deepEqual(result, { command, leadingArgs: [] });
  }
  for (const bundleIdentity of [undefined, "com.other.app"]) {
    assert.equal(await resolveDshLaunchCommand({
      platform: "darwin", environment: { PATH: "/missing/bin" }, homeDirectory: "/Users/example",
      accessFile: async (path) => { if (path === "/missing/bin/dsh") missingFile(); },
      readBundleIdentifier: async () => bundleIdentity,
    }), undefined);
  }
});

test("Windows DSH refuses unknown shims, forged package/bin paths, missing entries and cwd PATH", async () => {
  for (const manifest of [
    { name: "other", bin: { dsh: "lib/bin.js" } },
    { name: "@deepseek-ai/dsh", bin: { dsh: "../../evil.js" } },
    { name: "@deepseek-ai/dsh", bin: "lib/bin.js" },
    { name: "@deepseek-ai/dsh", bin: { dsh: "lib/bin.js" } },
  ]) {
    const inspected = [];
    const result = await resolveDshLaunchCommand({
      platform: "win32", environment: { PATH: ";relative;C:\\unknown" },
      accessFile: async (path) => {
        inspected.push(path);
        if (path !== "C:\\unknown\\dsh.cmd") throw new Error("missing");
      },
      readText: async () => JSON.stringify(manifest),
    });
    assert.equal(result, undefined);
    assert.ok(inspected.every((path) => path.startsWith("C:\\unknown\\")));
  }
  assert.deepEqual(await resolveDshLaunchCommand({
    platform: "win32", environment: { PATH: "C:\\bin" },
    accessFile: async (path) => assert.equal(path, "C:\\bin\\dsh.exe"),
    readText: () => assert.fail("must not read config for a real executable"),
  }), { command: "C:\\bin\\dsh.exe", leadingArgs: [] });
});

test("DSH launch retains cwd/provider env, uses a private owned patch, and removes it after nonzero exit", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "semaframe-dsh-test-"));
  const signalSource = new EventEmitter();
  const output = sink();
  const child = childFixture();
  const environment = { PATH: "/test/bin", DEEPSEEK_API_KEY: "do-not-export" };
  let launch;
  try {
    const pending = launchDshAgent({
      packageRoot, cwd: "/work/current project", environment, temporaryRoot, platform: "darwin",
      signalSource, errorOutput: output.stream, createPatch: async () => "[{\"safe\":true}]",
      resolveCommand: mockCommand,
      treeOptions: { killProcess: missingGroup },
      spawnProcess(command, args, options) {
        launch = { command, args, options };
        return child;
      },
    });
    while (!launch) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launch.command, "dsh");
    assert.deepEqual(launch.args.slice(0, 2), ["web", "--patch"]);
    assert.equal(launch.options.cwd, "/work/current project");
    assert.equal(launch.options.env, environment);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.detached, true);
    assert.equal(await readFile(launch.args[2], "utf8"), "[{\"safe\":true}]\n");
    if (process.platform !== "win32") assert.equal((await stat(launch.args[2])).mode & 0o777, 0o600);
    child.close(7);
    assert.equal(await pending, 7);
    assert.deepEqual(await readdir(temporaryRoot), []);
    assert.doesNotMatch(output.read(), /do-not-export/u);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  } finally {
    await rmdir(temporaryRoot);
  }
});

test("DSH launch reports a missing installed binary without auto-installing and cleans its patch", async () => {
  for (const synchronous of [false, true]) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "semaframe-dsh-test-"));
    const output = sink();
    try {
      const code = await launchDshAgent({
        packageRoot, temporaryRoot, errorOutput: output.stream,
        signalSource: new EventEmitter(), createPatch: async () => "[]",
        resolveCommand: mockCommand,
        spawnProcess(command) {
          assert.equal(command, "dsh");
          const error = Object.assign(new Error("private details"), { code: "ENOENT" });
          if (synchronous) throw error;
          const child = new EventEmitter();
          queueMicrotask(() => child.emit("error", error));
          return child;
        },
      });
      assert.equal(code, 1);
      assert.match(output.read(), /Install the official DeepSeek Harness CLI separately/u);
      assert.doesNotMatch(output.read(), /private details/u);
      assert.deepEqual(await readdir(temporaryRoot), []);
    } finally {
      await rmdir(temporaryRoot);
    }
  }
});

test("DSH launch forwards interrupts and drains its owned process tree before removing the patch", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "semaframe-dsh-test-"));
  const signalSource = new EventEmitter();
  const child = childFixture();
  let alive = true;
  let launch;
  const treeSignals = [];
  try {
    const pending = launchDshAgent({
      packageRoot, temporaryRoot, signalSource, errorOutput: sink().stream, createPatch: async () => "[]",
      resolveCommand: mockCommand,
      spawnProcess(_command, args) { launch = args; return child; },
      treeOptions: {
        platform: "darwin",
        killProcess(pid, signal) {
          assert.equal(pid, -child.pid);
          if (!alive) missingGroup();
          if (signal === 0) return;
          treeSignals.push(signal);
          alive = false;
          queueMicrotask(() => child.close(null, "SIGTERM"));
        },
      },
    });
    while (!launch) await new Promise((resolve) => setImmediate(resolve));
    signalSource.emit("SIGINT");
    assert.equal(await pending, 130);
    assert.deepEqual(child.signals, ["SIGINT"]);
    assert.deepEqual(treeSignals, ["SIGTERM"]);
    assert.deepEqual(await readdir(temporaryRoot), []);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
  } finally {
    await rmdir(temporaryRoot);
  }
});

test("Windows DSH launch invokes Node plus the verified entry, never cmd, and unsupported layouts create no temporary patch", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "semaframe-dsh-win-test-"));
  const child = childFixture();
  const output = sink();
  let launch;
  try {
    const pending = launchDshAgent({
      packageRoot, temporaryRoot, platform: "win32", signalSource: new EventEmitter(),
      errorOutput: output.stream, createPatch: async () => "[]",
      treeOptions: { taskkill: () => assert.fail("must not target a naturally exited root") },
      resolveCommand: async ({ platform }) => {
        assert.equal(platform, "win32");
        return { command: "C:\\node\\node.exe", leadingArgs: ["C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"] };
      },
      spawnProcess(command, args, options) { launch = { command, args, options }; return child; },
    });
    while (!launch) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launch.command, "C:\\node\\node.exe");
    assert.deepEqual(launch.args.slice(0, 3), ["C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js", "web", "--patch"]);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.detached, false);
    child.close(0);
    assert.equal(await pending, 1);
    assert.match(output.read(), /Windows process-tree cleanup could be confirmed/u);
    assert.match(output.read(), /Check Task Manager/u);
    assert.match(output.read(), /natural Windows root exit is not supported/u);
    assert.deepEqual(await readdir(temporaryRoot), []);
    const errorOutput = sink();
    assert.equal(await launchDshAgent({
      packageRoot, temporaryRoot, platform: "win32", errorOutput: errorOutput.stream,
      createPatch: async () => "[]", resolveCommand: async () => undefined,
      spawnProcess: () => assert.fail("unknown shim must not be run"),
    }), 1);
    assert.match(errorOutput.read(), /use `dsh web --patch <file>` manually/u);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rmdir(temporaryRoot);
  }
});

test("Windows DSH interrupts terminate the owned tree before the root and preserve the signal exit code", async () => {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "semaframe-dsh-win-test-"));
    const child = childFixture();
    const signalSource = new EventEmitter();
    const output = sink();
    let launch;
    const calls = [];
    try {
      const pending = launchDshAgent({
        packageRoot, temporaryRoot, platform: "win32", signalSource,
        errorOutput: output.stream, createPatch: async () => "[]", resolveCommand: mockCommand,
        spawnProcess(_command, args) { launch = args; return child; },
        treeOptions: {
          taskkill: async (pid, options) => {
            assert.equal(pid, child.pid);
            assert.equal(child.exitCode, null, "tree ownership must still exist");
            assert.deepEqual(child.signals, [], "must not kill the root before taskkill");
            calls.push(options.force);
            queueMicrotask(() => child.close(null, signal));
            return { code: 0, timedOut: false };
          },
        },
      });
      while (!launch) await new Promise((resolve) => setImmediate(resolve));
      signalSource.emit(signal);
      assert.equal(await pending, exitCode);
      assert.deepEqual(calls, [false]);
      assert.deepEqual(child.signals, []);
      assert.doesNotMatch(output.read(), /cleanup.*(?:failed|not supported|could be confirmed)/u);
      assert.deepEqual(await readdir(temporaryRoot), []);
      assert.equal(signalSource.listenerCount("SIGINT"), 0);
      assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    } finally {
      await rmdir(temporaryRoot);
    }
  }
});

test("DSH config failures stay off stdout and launch dispatch stays outside installation", async () => {
  const output = sink();
  const errorOutput = sink();
  assert.equal(await runSemaFrameCli(["agent", "config", "--client", "dsh"], {
    output: output.stream, errorOutput: errorOutput.stream,
    dshConfig: () => { throw new Error("not public"); },
  }), 1);
  assert.equal(output.read(), "");
  assert.doesNotMatch(errorOutput.read(), /not public/u);
  let launched = false;
  assert.equal(await runSemaFrameCli(["agent", "launch", "--client", "dsh"], {
    environment: { TEST: "retained" },
    dshLaunch: async (options) => { launched = true; assert.equal(options.environment.TEST, "retained"); return 19; },
    agentAction: () => assert.fail("DSH is not an install target"),
  }), 19);
  assert.equal(launched, true);
});

for (const interrupt of [true, false]) {
test(`real DSH-shaped process and stubborn MCP descendant both terminate on ${interrupt ? "interrupt" : "natural root exit"}`, { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "semaframe-dsh-tree-test-"));
  const signalSource = new EventEmitter();
  let child;
  let descendant;
  let patchPath;
  try {
    const codePromise = launchDshAgent({
      packageRoot, temporaryRoot, signalSource, errorOutput: sink().stream, createPatch: async () => "[]",
      treeOptions: { termGraceMs: 100, forceGraceMs: 2_000, pollIntervalMs: 10 },
      spawnProcess(_command, args, options) {
        patchPath = args[2];
        child = spawn(process.execPath, ["--input-type=module", "-e", `
          import { spawn } from 'node:child_process';
          process.on('SIGINT', () => {});
          process.on('SIGTERM', () => {});
          const sub = spawn(process.execPath, ['--input-type=module', '-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
          sub.stdout.once('data', () => process.stdout.write(String(sub.pid) + '\\n'));
          ${interrupt ? "" : "sub.stdout.once('data', () => setTimeout(() => process.exit(7), 100));"}
          setInterval(() => {}, 1000);
        `], { ...options, stdio: ["ignore", "pipe", "ignore"] });
        child.stdout.once("data", (data) => { descendant = Number(String(data).trim()); });
        return child;
      },
    });
    const deadline = Date.now() + 4_000;
    while (!descendant && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(Number.isInteger(descendant) && descendant > 1, "fixture descendant ready");
    if (interrupt) signalSource.emit("SIGINT");
    assert.equal(await codePromise, interrupt ? 130 : 7);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const goneDeadline = Date.now() + 2_000;
    let descendantGone = false;
    while (!descendantGone && Date.now() < goneDeadline) {
      try { process.kill(descendant, 0); } catch (cause) { if (cause.code === "ESRCH") descendantGone = true; else throw cause; }
      if (!descendantGone) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(descendantGone, true);
    await assert.rejects(access(patchPath), { code: "ENOENT" });
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    // Own fixture launch only; never signal a PID obtained outside this test.
    if (child && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (cause) { assert.equal(cause.code, "ESRCH"); }
    }
    await rmdir(temporaryRoot);
  }
});
}
