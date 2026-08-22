import assert from "node:assert/strict";
import test from "node:test";
import {
  isWithinRealityTwinImportLimits,
  REALITY_TWIN_MAX_ASSET_BYTES,
  REALITY_TWIN_MAX_SPLAT_COUNT,
} from "./reality-twin-import-limits.mjs";

test("accepts the exact Reality host limits", () => {
  assert.equal(isWithinRealityTwinImportLimits({
    byteLength: REALITY_TWIN_MAX_ASSET_BYTES,
    splatCount: REALITY_TWIN_MAX_SPLAT_COUNT,
  }), true);
});

test("rejects invalid values and values above either Reality host limit", () => {
  assert.equal(isWithinRealityTwinImportLimits({
    byteLength: REALITY_TWIN_MAX_ASSET_BYTES + 1,
    splatCount: REALITY_TWIN_MAX_SPLAT_COUNT,
  }), false);
  assert.equal(isWithinRealityTwinImportLimits({
    byteLength: REALITY_TWIN_MAX_ASSET_BYTES,
    splatCount: REALITY_TWIN_MAX_SPLAT_COUNT + 1,
  }), false);
  assert.equal(isWithinRealityTwinImportLimits({ byteLength: 0, splatCount: 1 }), false);
  assert.equal(isWithinRealityTwinImportLimits({ byteLength: 1, splatCount: 1.5 }), false);
});
