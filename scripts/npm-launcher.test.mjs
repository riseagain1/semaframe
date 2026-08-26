import assert from "node:assert/strict";
import test from "node:test";
import { resolveNpmLaunch } from "./lib/npm-launcher.mjs";

test("uses npm_execpath through the current Node executable on Windows", () => {
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const launch = resolveNpmLaunch(["run", "dev:xr"], {
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    npmExecPath: npmCli,
    fileExists: (value) => value === npmCli,
  });

  assert.deepEqual(launch, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: [npmCli, "run", "dev:xr"],
    source: "npm_execpath",
  });
});

test("finds the npm CLI beside Node on Windows when npm_execpath is absent", () => {
  const bundledCli = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
  const launch = resolveNpmLaunch(["--version"], {
    platform: "win32",
    nodeExecutable: "C:\\node\\node.exe",
    npmExecPath: undefined,
    fileExists: (value) => value === bundledCli,
  });

  assert.deepEqual(launch, {
    command: "C:\\node\\node.exe",
    args: [bundledCli, "--version"],
    source: "bundled_npm_cli",
  });
});

test("fails clearly instead of invoking npm.cmd through an unsafe shell", () => {
  assert.throws(() => resolveNpmLaunch(["run", "dev:xr"], {
    platform: "win32",
    nodeExecutable: "C:\\portable-node\\node.exe",
    npmExecPath: undefined,
    fileExists: () => false,
  }), /could not be located safely on Windows/u);
});

test("keeps a PATH fallback for direct non-Windows Node launches", () => {
  assert.deepEqual(resolveNpmLaunch(["run", "dev"], {
    platform: "linux",
    nodeExecutable: "/opt/node/bin/node",
    npmExecPath: undefined,
    fileExists: () => false,
  }), {
    command: "npm",
    args: ["run", "dev"],
    source: "path",
  });
});

test("rejects NUL-bearing arguments before process launch", () => {
  assert.throws(() => resolveNpmLaunch(["run", "dev\0xr"]), /without NUL bytes/u);
});
