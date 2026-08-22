import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPersistedAssetVerificationMatchesFresh,
  parseAssetVerifierArguments,
  verifyRealityTwinAsset,
} from "./verify-reality-twin-asset.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(path) {
  const stats = statSync(path, { bigint: true });
  return {
    bytes: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    sha256: digest(readFileSync(path)),
  };
}

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "semaframe-asset-verifier-test-"));
  const evidencePath = join(root, "video/public/reality-twin/asset-evidence.json");
  const qaRoot = join(root, "artifacts/reality-twin/qa");
  const previewPath = join(qaRoot, "spark-render.png");
  const captureDependencyPath = join(root, "video/public/reality-twin/capture-bound.jpg");
  const assetPath = join(root, "artifacts/reality-twin/test.gaussian.ply");
  for (const path of [evidencePath, previewPath, captureDependencyPath, assetPath]) {
    mkdirSync(join(path, ".."), { recursive: true });
  }
  const assetBytes = Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 3\nend_header\nfixture");
  writeFileSync(assetPath, assetBytes);
  writeFileSync(evidencePath, `${JSON.stringify({
    schema: "semaframe.reality-twin-asset-evidence.v1",
    conversion: { splat_count: 3 },
    output: {
      relative_path: "artifacts/reality-twin/test.gaussian.ply",
      bytes: assetBytes.byteLength,
      sha256: digest(assetBytes),
    },
    validation: {
      status: "passed",
      sentinel: "canonical",
      semaframe_current_preflight: {
        descriptor: {
          sourceBounds: {
            min: { x: -1, y: 0, z: -1 },
            max: { x: 1, y: 2, z: 1 },
          },
        },
        warnings: ["source_coordinate_system_unknown", "source_units_unknown"],
      },
      spark_browser_import: {
        package: "@sparkjsdev/spark",
        version: "test-1.0.0",
        decoded_splats: 3,
        active_splats: 3,
        decoded_bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
      },
    },
  }, null, 2)}\n`);
  writeFileSync(previewPath, "canonical-preview");
  writeFileSync(captureDependencyPath, "capture-bound-dependency");
  return {
    root,
    evidencePath,
    qaRoot,
    previewPath,
    captureDependencyPath,
    assetPath,
    assetBytes,
    checkOnlyQaParent: join(root, "artifacts/reality-twin/check-only-runs"),
  };
}

function preflightFor(workspace) {
  return {
    descriptor: {
      format: "ply",
      model: "gaussian-3d",
      splatCount: 3,
      byteLength: workspace.assetBytes.byteLength,
      digest: `sha256:${digest(workspace.assetBytes)}`,
      sphericalHarmonicsDegree: 0,
      engineeringAuthority: "visual_only",
      sourceBounds: {
        min: { x: -1, y: 0, z: -1 },
        max: { x: 1, y: 2, z: 1 },
      },
    },
    warnings: ["source_units_unknown", "source_coordinate_system_unknown"],
  };
}

function sparkReceipt(previewPath) {
  const bytes = readFileSync(previewPath);
  return {
    initialized: true,
    numSplats: 3,
    activeSplats: 3,
    bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
    renderedFrames: 3,
    renderer: "Test WebGL2 Renderer",
    webglVersion: 2,
    rendered: true,
    screenshot: {
      relative_path: null,
      persisted: false,
      temporary: true,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
      width: 960,
      height: 960,
      rgb_standard_deviation: [20, 20, 20],
      subject_crop_rgb_standard_deviation: [20, 20, 20],
      subject_crop_non_background_fraction: 0.5,
    },
  };
}

function protectedIdentities(workspace) {
  return Object.fromEntries([
    workspace.evidencePath,
    workspace.previewPath,
    workspace.captureDependencyPath,
  ].map((path) => [path, identity(path)]));
}

test("asset verifier CLI accepts only the explicit non-mutating mode", () => {
  assert.deepEqual(parseAssetVerifierArguments([]), { checkOnly: false });
  assert.deepEqual(parseAssetVerifierArguments(["--check-only"]), { checkOnly: true });
  assert.throws(() => parseAssetVerifierArguments(["--check-only", "--write"]), /Unsupported asset-verifier arguments/u);
});

test("check-only stable receipt binding rejects preflight and Spark drift", () => {
  const persisted = {
    status: "passed",
    semaframe_current_preflight: {
      descriptor: { sourceBounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } } },
      warnings: ["source_units_unknown", "source_coordinate_system_unknown"],
    },
    spark_browser_import: {
      package: "@sparkjsdev/spark",
      version: "2.1.0",
      decoded_splats: 3,
      active_splats: 3,
      decoded_bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
    },
  };
  const fresh = structuredClone(persisted);
  assert.doesNotThrow(() => assertPersistedAssetVerificationMatchesFresh(persisted, fresh));

  const boundsDrift = structuredClone(fresh);
  boundsDrift.semaframe_current_preflight.descriptor.sourceBounds.max.x += 0.01;
  assert.throws(
    () => assertPersistedAssetVerificationMatchesFresh(persisted, boundsDrift),
    /sourceBounds\.max\.x differs/u,
  );
  const versionDrift = structuredClone(fresh);
  versionDrift.spark_browser_import.version = "2.2.0";
  assert.throws(
    () => assertPersistedAssetVerificationMatchesFresh(persisted, versionDrift),
    /Spark version differs/u,
  );
  const decodedBoundsDrift = structuredClone(fresh);
  decodedBoundsDrift.spark_browser_import.decoded_bounds.min[0] += 0.01;
  assert.throws(
    () => assertPersistedAssetVerificationMatchesFresh(persisted, decodedBoundsDrift),
    /decoded_bounds\.min\[0\] differs/u,
  );
});

test("check-only success removes its QA workdir and preserves canonical hashes and mtimes", async () => {
  const workspace = createWorkspace();
  try {
    const before = protectedIdentities(workspace);
    let temporaryQaRoot;
    const result = await verifyRealityTwinAsset({
      repositoryRoot: workspace.root,
      evidencePath: workspace.evidencePath,
      qaRoot: workspace.qaRoot,
      previewPath: workspace.previewPath,
      checkOnlyQaParent: workspace.checkOnlyQaParent,
      checkOnly: true,
      sparkPackageVersion: "test-1.0.0",
      preflightRunner: async (_assetPath, qaRoot) => {
        temporaryQaRoot = qaRoot;
        writeFileSync(join(qaRoot, "current-preflight.ts"), "temporary preflight");
        return preflightFor(workspace);
      },
      sparkRunner: async (_assetPath, _splats, options) => {
        assert.equal(options.qaRoot, temporaryQaRoot);
        assert.notEqual(options.previewPath, workspace.previewPath);
        assert.equal(options.previewPersisted, false);
        writeFileSync(options.previewPath, "temporary-spark-preview");
        return sparkReceipt(options.previewPath);
      },
    });

    assert.equal(result.mode, "check-only");
    assert.equal(result.evidenceModified, false);
    assert.equal(result.preview.persisted, false);
    assert.equal(result.checkOnlyQaWorkdirRemoved, true);
    assert.equal(existsSync(temporaryQaRoot), false);
    assert.deepEqual(protectedIdentities(workspace), before);
    assert.deepEqual(readdirSync(workspace.checkOnlyQaParent), []);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("check-only failure also removes temporary QA without touching canonical dependencies", async () => {
  const workspace = createWorkspace();
  try {
    const before = protectedIdentities(workspace);
    let temporaryQaRoot;
    await assert.rejects(() => verifyRealityTwinAsset({
      repositoryRoot: workspace.root,
      evidencePath: workspace.evidencePath,
      qaRoot: workspace.qaRoot,
      previewPath: workspace.previewPath,
      checkOnlyQaParent: workspace.checkOnlyQaParent,
      checkOnly: true,
      sparkPackageVersion: "test-1.0.0",
      preflightRunner: async (_assetPath, qaRoot) => {
        temporaryQaRoot = qaRoot;
        return preflightFor(workspace);
      },
      sparkRunner: async (_assetPath, _splats, options) => {
        writeFileSync(options.previewPath, "temporary-before-failure");
        throw new Error("intentional Spark failure");
      },
    }), /intentional Spark failure/u);

    assert.equal(existsSync(temporaryQaRoot), false);
    assert.deepEqual(protectedIdentities(workspace), before);
    assert.deepEqual(readdirSync(workspace.checkOnlyQaParent), []);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("default mode still updates canonical evidence and preview", async () => {
  const workspace = createWorkspace();
  try {
    const result = await verifyRealityTwinAsset({
      repositoryRoot: workspace.root,
      evidencePath: workspace.evidencePath,
      qaRoot: workspace.qaRoot,
      previewPath: workspace.previewPath,
      checkOnly: false,
      sparkPackageVersion: "test-1.0.0",
      preflightRunner: async () => preflightFor(workspace),
      sparkRunner: async (_assetPath, _splats, options) => {
        assert.equal(options.previewPath, workspace.previewPath);
        assert.equal(options.previewPersisted, true);
        writeFileSync(options.previewPath, "updated-canonical-preview");
        const receipt = sparkReceipt(options.previewPath);
        receipt.screenshot.relative_path = "artifacts/reality-twin/qa/spark-render.png";
        receipt.screenshot.persisted = true;
        receipt.screenshot.temporary = false;
        return receipt;
      },
    });
    const evidence = JSON.parse(readFileSync(workspace.evidencePath, "utf8"));
    assert.equal(result.mode, "update-evidence");
    assert.equal(result.evidenceModified, true);
    assert.equal(evidence.validation.command, "node scripts/verify-reality-twin-asset.mjs");
    assert.equal(evidence.validation.spark_browser_import.decoded_splats, 3);
    assert.equal(readFileSync(workspace.previewPath, "utf8"), "updated-canonical-preview");
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});
