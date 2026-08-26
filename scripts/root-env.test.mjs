import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRootEnvironment } from "./lib/root-env.mjs";

const protectedKeys = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  "NPM_EXECPATH", "NPM_NODE_EXECPATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
]);

function protectedEntries() {
  return Object.entries(process.env)
    .filter(([key]) => protectedKeys.has(key.toUpperCase()))
    .sort(([left], [right]) => left.localeCompare(right));
}

function replaceProtectedEntries(entries) {
  for (const key of Object.keys(process.env)) {
    if (protectedKeys.has(key.toUpperCase())) delete process.env[key];
  }
  for (const [key, value] of entries) process.env[key] = value;
}

async function fixture(source) {
  const directory = await mkdtemp(join(tmpdir(), "semaframe-root-env-"));
  const file = join(directory, ".env");
  await writeFile(file, source, { encoding: "utf8", mode: 0o600 });
  return { directory, file };
}

test("loads a root env file without overriding shell values", async () => {
  const existingKey = "SEMAFRAME_TEST_ENV_EXISTING";
  const loadedKey = "SEMAFRAME_TEST_ENV_LOADED";
  const previousExisting = process.env[existingKey];
  const previousLoaded = process.env[loadedKey];
  const { directory, file } = await fixture([
    `${existingKey}=from-file`,
    `${loadedKey}="from root env"`,
  ].join("\n"));
  process.env[existingKey] = "from-shell";
  delete process.env[loadedKey];
  try {
    assert.deepEqual(loadRootEnvironment({ file }), { found: true });
    assert.equal(process.env[existingKey], "from-shell");
    assert.equal(process.env[loadedKey], "from root env");
  } finally {
    if (previousExisting === undefined) delete process.env[existingKey];
    else process.env[existingKey] = previousExisting;
    if (previousLoaded === undefined) delete process.env[loadedKey];
    else process.env[loadedKey] = previousLoaded;
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not introduce child-process control variables from the file", async () => {
  const previousEntries = protectedEntries();
  const { directory, file } = await fixture([
    "nOdE_oPtIoNs=--import=/tmp/untrusted.mjs",
    "NPM_EXECPATH=/tmp/untrusted-npm.js",
    "Path=/tmp/untrusted-bin",
    "pAtHeXt=.UNTRUSTED",
    "systemroot=C:\\untrusted-windows",
    "WINDIR=C:\\untrusted-windows",
    "comspec=C:\\untrusted-shell.exe",
  ].join("\n"));
  replaceProtectedEntries([
    ["PATH", "/trusted/bin"],
    ["SystemRoot", "C:\\Windows"],
    ["ComSpec", "C:\\Windows\\System32\\cmd.exe"],
    ["npm_execpath", "/trusted/npm-cli.js"],
  ]);
  const shellEntries = protectedEntries();
  try {
    assert.deepEqual(loadRootEnvironment({ file }), { found: true });
    assert.deepEqual(protectedEntries(), shellEntries);
  } finally {
    replaceProtectedEntries(previousEntries);
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores a missing root env file", () => {
  assert.deepEqual(loadRootEnvironment({
    file: join(tmpdir(), `semaframe-missing-${process.pid}-${Date.now()}`, ".env"),
  }), { found: false });
});
