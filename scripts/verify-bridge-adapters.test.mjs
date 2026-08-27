import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeArchiveEntry, verifyBridgeAdapters } from "./verify-bridge-adapters.mjs";

test("all first-party Bridge adapters satisfy pinned descriptors and protocol/security invariants", () => {
  assert.deepEqual(verifyBridgeAdapters(), {
    adapters: 4,
    protocolVersion: "1.0",
    executablePythonAdapterChecks: 3,
    staticHostSyntaxChecks: 4,
  });
});

test("safe archive paths accept only relative normalized non-colliding names", () => {
  const existing = new Set(["scene.usda"]);
  assert.equal(assertSafeArchiveEntry("exact/model.step", existing), "exact/model.step");
  for (const invalid of [
    "", "/scene.usda", "../scene.usda", "exact/../scene.usda", "./geometry.glb",
    "exact//model.step", "exact\\model.step", "scene.usda\u0000.txt", "SCENE.USDA",
  ]) {
    assert.throws(() => assertSafeArchiveEntry(invalid, existing));
  }
});

test("credential persistence regressions are absent from checked-in adapters", () => {
  const result = verifyBridgeAdapters();
  assert.equal(result.adapters, 4);
});
