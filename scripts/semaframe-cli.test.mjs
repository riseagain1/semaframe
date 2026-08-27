import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  inspectSemaFrameHost,
  nodeVersionIsSupported,
  parseSemaFrameCliArguments,
  runSemaFrameCli,
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
