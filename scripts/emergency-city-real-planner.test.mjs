import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptsDirectory, "..");
const planner = join(scriptsDirectory, "emergency-city-real-planner.mjs");
const contextFixture = join(scriptsDirectory, "fixtures", "emergency-city-planner-context.fixture.json");
const modelFixture = join(scriptsDirectory, "fixtures", "emergency-city-model-run.fixture.json");
const schemaPath = join(scriptsDirectory, "emergency-city-plan.schema.json");
const outputNames = [
  "emergency-plan.json",
  "codex-trace.raw.jsonl",
  "truth-window-events.json",
  "planner-run.json",
];

function runPlanner(outputDirectory, fixturePath = modelFixture) {
  return spawnSync(process.execPath, [
    planner,
    "--context", contextFixture,
    "--out", outputDirectory,
    "--offline-fixture", fixturePath,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("offline fixture mode is byte-deterministic and explicitly non-live", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "semaframe-planner-test-a-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "semaframe-planner-test-b-"));
  try {
    const first = runPlanner(firstRoot);
    const second = runPlanner(secondRoot);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    for (const name of outputNames) {
      assert.equal(
        readFileSync(join(firstRoot, name), "utf8"),
        readFileSync(join(secondRoot, name), "utf8"),
        `${name} must be deterministic`,
      );
    }

    const manifest = JSON.parse(readFileSync(join(firstRoot, "planner-run.json"), "utf8"));
    assert.equal(manifest.mode, "offline_fixture");
    assert.equal(manifest.live_model, false);
    assert.equal(manifest.hardcoded_fallback, false);
    assert.equal(manifest.safety.automatic_fixture_fallback, false);
    assert.equal(manifest.safety.endpoints_are_host_preflight_pending, true);
    assert.match(manifest.hashes.plan, /^sha256:[a-f0-9]{64}$/u);
    assert.match(manifest.run_hash, /^sha256:[a-f0-9]{64}$/u);

    const truth = JSON.parse(readFileSync(join(firstRoot, "truth-window-events.json"), "utf8"));
    assert.equal(truth.live_model, false);
    assert.ok(truth.events.some((event) => event.kind === "action" && event.status === "requires_preflight"));
    assert.ok(truth.events.every((event) => !/reasoning/iu.test(event.trace_type ?? "")));

    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const actionArray = schema.properties.control.properties.actions;
    assert.equal(actionArray.maxItems, undefined, "the plan schema must not fix an action count");
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("an invalid model target fails closed without writing delivery files", () => {
  const root = mkdtempSync(join(tmpdir(), "semaframe-planner-test-invalid-"));
  const outputDirectory = join(root, "output");
  const fixture = JSON.parse(readFileSync(modelFixture, "utf8"));
  fixture.plan.control.actions[0].target_component_id = "CMP_INVENTED_BY_MODEL";
  const invalidFixture = join(root, "invalid-fixture.json");
  writeFileSync(invalidFixture, `${JSON.stringify(fixture, null, 2)}\n`);
  try {
    const result = runPlanner(outputDirectory, invalidFixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed closed/iu);
    assert.match(result.stderr, /unknown action target/iu);
    for (const name of outputNames) {
      assert.throws(() => readFileSync(join(outputDirectory, name)), { code: "ENOENT" });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline mode is never selected implicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "semaframe-planner-test-no-fallback-"));
  try {
    const result = spawnSync(process.execPath, [
      planner,
      "--context", contextFixture,
      "--out", root,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires an explicit --model/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live Codex invocation contract is testable without a paid model run", () => {
  const root = mkdtempSync(join(tmpdir(), "semaframe-planner-test-codex-harness-"));
  const outputDirectory = join(root, "output");
  const fixture = JSON.parse(readFileSync(modelFixture, "utf8"));
  const fakeCodex = join(root, "codex-fixture.mjs");
  const fakeSource = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fixture\\n");
  process.exit(0);
}
const required = ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--output-schema", "--output-last-message", "-C"];
for (const entry of required) {
  if (!args.includes(entry)) throw new Error(\`missing Codex argument \${entry}\`);
}
if (!process.cwd().includes("semaframe-emergency-planner-")) throw new Error("planner was not isolated");
const prompt = await new Promise((resolveInput) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolveInput(value));
});
if (!prompt.includes("<authoritative_planner_context>")) throw new Error("missing authoritative context");
if (!prompt.includes("Do not assume or target any fixed action count")) throw new Error("missing variable action-count rule");
const finalIndex = args.indexOf("--output-last-message") + 1;
writeFileSync(args[finalIndex], JSON.stringify(${JSON.stringify(fixture.plan)}));
const trace = ${JSON.stringify(fixture.trace_events)};
process.stdout.write(trace.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
`;
  writeFileSync(fakeCodex, fakeSource);
  chmodSync(fakeCodex, 0o755);
  try {
    const result = spawnSync(process.execPath, [
      planner,
      "--context", contextFixture,
      "--out", outputDirectory,
      "--model", "fixture-codex-model",
      "--codex-bin", fakeCodex,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(outputDirectory, "planner-run.json"), "utf8"));
    assert.equal(manifest.mode, "live_codex");
    assert.equal(manifest.live_model, true);
    assert.equal(manifest.runtime_version, "codex-cli 0.0.0-fixture");
    assert.equal(manifest.hardcoded_fallback, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
