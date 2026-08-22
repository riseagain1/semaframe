import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CAPTURE_EVIDENCE_FORMAT,
  CAPTURE_EVIDENCE_VERSION,
  chromeGpuArguments,
  dimensionResidualWithin,
  dimensionsFromBounds,
  fnv1a32,
  loadRealityTwinFixture,
  maximumDimensionDelta,
  parseProcessTable,
  protectiveCaseGeometry,
  publishedModelReceipts,
  prepareCaptureOutputs,
  promoteCaptureOutputs,
  promoteCaptureOutputsAfterCleanup,
  profileRelatedProcessIds,
  resolveCaptureAsset,
  resolveCaptureOutputPlan,
  resolveUsdChecker,
  runUsdChecker,
  sha256,
  signedDimensionResidual,
  validateCaptureEvidence,
  validateRealityTwinFixture,
  writeFileAtomically,
} from "./reality-twin-capture-core.mjs";

const fixture = loadRealityTwinFixture();

function completeEvidence() {
  const frameCounts = structuredClone(fixture.capture.sequenceFrameCounts);
  const sourceBounds = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0.3252695652173913, y: 0.317, z: 0.14324 },
  };
  const calibrationScale = fixture.physicalTruth.calibration.knownDistanceM / 0.317;
  const rejectedScale = fixture.physicalTruth.calibration.knownDistanceM / 0.05;
  const rejectedAabb = dimensionsFromBounds(sourceBounds, rejectedScale);
  const rejectedResidual = signedDimensionResidual(rejectedAabb, fixture.physicalTruth.catalogDimensionsM);
  const scanAabb = dimensionsFromBounds(sourceBounds, calibrationScale);
  const scanResidual = signedDimensionResidual(scanAabb, fixture.physicalTruth.catalogDimensionsM);
  const modelContent = {
    formatVersion: "1.0",
    modelId: fixture.workspace.modelId,
    version: fixture.workspace.modelVersion,
    displayName: "Reality Twin Protective Display Case",
    rootNodeId: "source-root",
    nodes: Array.from({ length: 6 }, (_, index) => ({ nodeId: `source-node-${index}` })),
    sourceRevision: 5,
    generatorVersion: "1.0.0",
  };
  const canonicalModelDefinition = { ...modelContent, digest: fnv1a32(modelContent) };
  const modelReceipts = publishedModelReceipts(canonicalModelDefinition);
  return {
    format: CAPTURE_EVIDENCE_FORMAT,
    version: CAPTURE_EVIDENCE_VERSION,
    status: "complete",
    captureRunId: "reality-twin-test-run",
    startedAt: "2026-08-22T00:00:00.000Z",
    completedAt: "2026-08-22T00:01:00.000Z",
    source: { derivation: "smithsonian_glb_scan_to_gaussian_ply", nativeGaussianCapture: false },
    agentExecution: {
      kind: "deterministic_authorized_mcp_client",
      generativePlannerUsed: false,
      fixtureDriven: true,
    },
    assetImport: {
      browserAuthoritative: true,
      localBytesReady: true,
      upload: { httpStatus: 200 },
      assetRef: { assetId: `ra_${"a".repeat(64)}`, digest: `sha256:${"b".repeat(64)}` },
      descriptor: { engineeringAuthority: "visual_only", sourceBounds },
    },
    calibration: {
      measurementFidelity: "gaussian-lod",
      measurementCompleted: true,
      blindValidation: false,
      selectionPolicy: "target_guided_visible_candidate_search_with_aabb_residual_gate",
      rejectedCandidateCount: 1,
      rejectedCandidates: [{
        sequence: 1,
        controlKind: "visible_short_span",
        accepted: false,
        measurementFidelity: "gaussian-lod",
        pointA: {
          x: 0, y: 0.001, z: 0, pickedOnCurrentGaussianLod: true,
          pointId: "measurement-10-a", sessionId: 10, assetId: `ra_${"a".repeat(64)}`, assetDigest: `sha256:${"b".repeat(64)}`,
        },
        pointB: {
          x: 0, y: 0.051, z: 0, pickedOnCurrentGaussianLod: true,
          pointId: "measurement-10-b", sessionId: 10, assetId: `ra_${"a".repeat(64)}`, assetDigest: `sha256:${"b".repeat(64)}`,
        },
        sourceDistance: 0.05,
        sourceDelta: { x: 0, y: 0.05, z: 0 },
        candidateMetersPerSourceUnit: rejectedScale,
        calibratedScanAabbM: rejectedAabb,
        catalogResidualM: rejectedResidual,
        residualToleranceM: fixture.physicalTruth.scanResidualToleranceM,
        rejectionReasonCodes: [
          "source_span_below_minimum",
          "source_y_below_90_percent_of_aabb_height",
          "calibrated_scan_aabb_residual_exceeds_tolerance",
        ],
      }],
      appliedThroughInspectorUi: true,
      inputDriver: "automated_cdp_pointer_and_form_events",
      humanInputClaimed: false,
      assetDigest: `sha256:${"b".repeat(64)}`,
      sourceDistance: 0.317,
      knownDistanceM: 0.322,
      metersPerSourceUnit: calibrationScale,
      pointA: {
        x: 0, y: 0.001, z: 0, pickedOnCurrentGaussianLod: true,
        pointId: "measurement-11-a", sessionId: 11, assetId: `ra_${"a".repeat(64)}`, assetDigest: `sha256:${"b".repeat(64)}`,
      },
      pointB: {
        x: 0, y: 0.318, z: 0, pickedOnCurrentGaussianLod: true,
        pointId: "measurement-11-b", sessionId: 11, assetId: `ra_${"a".repeat(64)}`, assetDigest: `sha256:${"b".repeat(64)}`,
      },
    },
    scanAabbComparison: {
      expectedCatalogM: fixture.physicalTruth.catalogDimensionsM,
      calibratedScanAabbM: scanAabb,
      residualM: scanResidual,
      residualPercent: Object.fromEntries(["x", "y", "z"].map((axis) => [
        axis,
        scanResidual[axis] / fixture.physicalTruth.catalogDimensionsM[axis],
      ])),
      toleranceM: fixture.physicalTruth.scanResidualToleranceM,
      passed: dimensionResidualWithin(scanResidual, fixture.physicalTruth.scanResidualToleranceM),
      exactCatalogMatchClaimed: false,
    },
    independentDimensionCheck: {
      label: "second visible width pair",
      source: "live_calibrated_gaussian_measurement",
      displayedWithoutSubstitution: true,
      blindValidation: false,
      selectionPolicy: "target_guided_visible_candidate_search",
      viewPreparation: "automated_canvas_orbit_pointer_events",
      passed: true,
      sourceDistance: 0.3252695652173913,
      expectedM: 0.322,
      measuredM: 0.3304,
      residualM: 0.0084,
      toleranceM: fixture.physicalTruth.independentWidthToleranceM,
      toleranceSource: fixture.physicalTruth.toleranceSource,
      distinctFromCalibrationPair: true,
      pointA: {
        x: 0, y: 0.16, z: 0, pickedOnCurrentGaussianLod: true,
        pointId: "measurement-12-a", sessionId: 12, assetId: `ra_${"a".repeat(64)}`, assetDigest: `sha256:${"b".repeat(64)}`,
      },
      pointB: {
        x: 0.3252695652173913, y: 0.16, z: 0, pickedOnCurrentGaussianLod: true,
        pointId: "measurement-12-b", sessionId: 12, assetId: `ra_${"a".repeat(64)}`, assetDigest: `sha256:${"b".repeat(64)}`,
      },
    },
    semanticProxy: {
      linked: true,
      engineeringAuthority: "proxy",
      realityEngineeringAuthority: "visual_only",
      exactGeometry: true,
      exactGeometryParameters: { kind: "box", sizeM: fixture.physicalTruth.proxyDimensionsM },
    },
    collision: {
      preflightValid: false,
      rejectedBatchCode: "spatial_collision",
      revisionBeforeRejection: 5,
      revisionAfterRejection: 5,
      atomic: true,
      proxyColliderEnabled: true,
      realityColliderEnabled: false,
      correctedCollisionConflictCount: 0,
    },
    numericEdit: {
      beforeM: fixture.workspace.case.glassThicknessM,
      afterM: fixture.workspace.case.editedTopThicknessM,
      undoRestoredBefore: true,
      redoRestoredAfter: true,
    },
    persistence: {
      projectPath: "artifacts/reality-twin/capture/test.semaframe.json",
      preserved: true,
      savedRevision: 7,
      reopenedRevision: 7,
      savedComponentCount: 11,
      reopenedComponentCount: 11,
    },
    model: {
      modelId: fixture.workspace.modelId,
      version: fixture.workspace.modelVersion,
      toolDigest: modelReceipts.toolDigest,
      contentSha256: modelReceipts.contentSha256,
      canonicalDefinition: canonicalModelDefinition,
      publishedRevision: 5,
      published: true,
      editableInstance: true,
      nodeCount: 6,
      publishedSubtreeTypes: ["model-assembly", "spatial-primitive"],
      publishedSubtree: { excludesReality: true, contentClass: "protective_case_model", containsReality: false },
    },
    exports: {
      usda: {
        validOpenUsd: true,
        sha256: `sha256:${"c".repeat(64)}`,
        freshExport: true,
        captureRunId: "reality-twin-test-run",
        sourceModelToolDigest: modelReceipts.toolDigest,
        sourceModelContentSha256: modelReceipts.contentSha256,
        sourceWorkspaceRevision: 5,
        exportedAt: "2026-08-22T00:00:50.000Z",
        usdchecker: { exitCode: 0, stdout: "Success!" },
      },
    },
    captures: {
      viewport: { width: 1920, height: 1080, fps: 30 },
      browserGraphics: {
        api: "webgl2", webgl2: true, vendor: "Apple", renderer: "ANGLE Metal Renderer: Apple M4",
        hardwareAccelerated: true, softwareRenderer: false,
      },
      frameCounts,
    },
  };
}

test("Reality Twin fixture separates exact catalog proxy dimensions from scan residual truth", () => {
  assert.equal(validateRealityTwinFixture(fixture), fixture);
  assert.deepEqual(fixture.physicalTruth.catalogDimensionsM, { x: 0.322, y: 0.322, z: 0.157 });
  assert.deepEqual(fixture.physicalTruth.proxyDimensionsM, fixture.physicalTruth.catalogDimensionsM);
  assert.equal(fixture.gaussian.sourceBounds, undefined);
});

test("dimension residual evidence preserves both observed-minus-catalog signs", () => {
  const expected = { x: 0.322, y: 0.322, z: 0.157 };
  assert.deepEqual(
    signedDimensionResidual({ x: 0.33, y: 0.322, z: 0.145 }, expected),
    { x: 0.008000000000000007, y: 0, z: -0.01200000000000001 },
  );
  assert.deepEqual(
    signedDimensionResidual({ x: 0.31, y: 0.325, z: 0.17 }, expected),
    { x: -0.01200000000000001, y: 0.0030000000000000027, z: 0.013000000000000012 },
  );
  assert.equal(dimensionResidualWithin({ x: -0.012, y: 0.003, z: 0.013 }, { x: 0.02, y: 0.02, z: 0.02 }), true);
});

test("protective case keeps 40 mm side, depth, and top clearance", () => {
  const geometry = protectiveCaseGeometry(fixture);
  assert.deepEqual(geometry.inner, { x: 0.402, y: 0.362, z: 0.237 });
  assert.deepEqual(geometry.outer, { x: 0.41800000000000004, y: 0.37, z: 0.253 });
  assert.equal(geometry.panels.top.center.y, 0.366);
  assert.equal(geometry.panels.top.sizeM.y, fixture.workspace.case.glassThicknessM);
});

test("smoke capture is isolated while full capture invalidates stale completion receipts", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-output-"));
  try {
    const canonical = resolveCaptureOutputPlan({ repositoryRoot: temporary, runId: "full-test" });
    mkdirSync(canonical.publicRoot, { recursive: true });
    mkdirSync(join(temporary, "artifacts"), { recursive: true });
    writeFileSync(canonical.evidencePath, "stale-evidence");
    writeFileSync(canonical.verificationReceiptPath, "stale-receipt");

    const smoke = resolveCaptureOutputPlan({ repositoryRoot: temporary, smokeFrameCount: 8 });
    mkdirSync(smoke.captureRoot, { recursive: true });
    writeFileSync(join(smoke.captureRoot, "old-smoke-frame.jpg"), "old");
    prepareCaptureOutputs(smoke);
    assert.equal(existsSync(join(smoke.captureRoot, "old-smoke-frame.jpg")), false);
    assert.equal(readFileSync(canonical.evidencePath, "utf8"), "stale-evidence");
    assert.equal(readFileSync(canonical.verificationReceiptPath, "utf8"), "stale-receipt");
    assert.notEqual(smoke.captureRoot, canonical.publicRoot);

    prepareCaptureOutputs(canonical);
    assert.equal(existsSync(canonical.evidencePath), false);
    assert.equal(existsSync(canonical.verificationReceiptPath), false);
    assert.equal(existsSync(canonical.captureRoot), true);
    assert.equal(existsSync(canonical.artifactRoot), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("full capture promotes a validated run-scoped bundle and preserves asset provenance", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-promote-"));
  try {
    const plan = resolveCaptureOutputPlan({ repositoryRoot: temporary, runId: "capture-42" });
    mkdirSync(plan.publicRoot, { recursive: true });
    mkdirSync(plan.canonicalArtifactRoot, { recursive: true });
    writeFileSync(join(plan.publicRoot, "old-frame.jpg"), "old-frame");
    writeFileSync(join(plan.canonicalArtifactRoot, "old.usda"), "old-usda");
    const assetEvidencePath = join(temporary, "asset-evidence-source.json");
    writeFileSync(assetEvidencePath, "asset-provenance");
    prepareCaptureOutputs(plan);
    writeFileSync(join(plan.captureRoot, "new-frame.jpg"), "new-frame");
    writeFileSync(join(plan.artifactRoot, "new.usda"), "new-usda");
    writeFileAtomically(plan.stagedEvidencePath, "validated-evidence", "capture-42");

    promoteCaptureOutputs(plan, assetEvidencePath);
    assert.equal(readFileSync(join(plan.publicRoot, "new-frame.jpg"), "utf8"), "new-frame");
    assert.equal(readFileSync(join(plan.publicRoot, "evidence.json"), "utf8"), "validated-evidence");
    assert.equal(readFileSync(join(plan.publicRoot, "asset-evidence.json"), "utf8"), "asset-provenance");
    assert.equal(readFileSync(join(plan.canonicalArtifactRoot, "new.usda"), "utf8"), "new-usda");
    assert.equal(existsSync(join(plan.publicRoot, "old-frame.jpg")), false);
    assert.equal(existsSync(join(plan.canonicalArtifactRoot, "old.usda")), false);
    assert.equal(existsSync(plan.stagingRoot), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("full capture promotion is blocked until cleanup succeeds", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-cleanup-gate-"));
  try {
    const plan = resolveCaptureOutputPlan({ repositoryRoot: temporary, runId: "capture-cleanup-gate" });
    mkdirSync(plan.publicRoot, { recursive: true });
    mkdirSync(plan.canonicalArtifactRoot, { recursive: true });
    writeFileSync(join(plan.publicRoot, "published-frame.jpg"), "published-frame");
    writeFileSync(join(plan.canonicalArtifactRoot, "published.usda"), "published-usda");
    const assetEvidencePath = join(temporary, "asset-evidence-source.json");
    writeFileSync(assetEvidencePath, "asset-provenance");
    prepareCaptureOutputs(plan);
    writeFileSync(join(plan.captureRoot, "staged-frame.jpg"), "staged-frame");
    writeFileSync(join(plan.artifactRoot, "staged.usda"), "staged-usda");
    writeFileAtomically(plan.stagedEvidencePath, "validated-evidence", "capture-cleanup-gate");

    let promoteCalls = 0;
    assert.throws(() => promoteCaptureOutputsAfterCleanup(
      plan,
      assetEvidencePath,
      {
        cleanupComplete: false,
        promote() { promoteCalls += 1; },
      },
    ), /cannot be promoted before cleanup completes/u);
    assert.equal(promoteCalls, 0);
    assert.equal(readFileSync(join(plan.publicRoot, "published-frame.jpg"), "utf8"), "published-frame");
    assert.equal(readFileSync(join(plan.canonicalArtifactRoot, "published.usda"), "utf8"), "published-usda");
    assert.equal(readFileSync(join(plan.captureRoot, "staged-frame.jpg"), "utf8"), "staged-frame");

    promoteCaptureOutputsAfterCleanup(plan, assetEvidencePath, { cleanupComplete: true });
    assert.equal(readFileSync(join(plan.publicRoot, "staged-frame.jpg"), "utf8"), "staged-frame");
    assert.equal(readFileSync(join(plan.canonicalArtifactRoot, "staged.usda"), "utf8"), "staged-usda");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Chrome GPU backend is Metal only on macOS unless explicitly overridden", () => {
  assert.equal(chromeGpuArguments({ platform: "darwin" }).includes("--use-angle=metal"), true);
  assert.equal(chromeGpuArguments({ platform: "linux" }).some((argument) => argument.startsWith("--use-angle=")), false);
  assert.equal(chromeGpuArguments({ platform: "linux", angleBackend: "vulkan" }).includes("--use-angle=vulkan"), true);
  assert.throws(() => chromeGpuArguments({ platform: "linux", angleBackend: "bad value" }), /unsupported characters/u);
});

test("profile-scoped browser cleanup targets only the capture tree", () => {
  const captureProfile = "/private/tmp/semaframe-reality-twin-capture-test";
  const rows = parseProcessTable([
    `  100     1   100 /Applications/Google Chrome --headless --user-data-dir=${captureProfile}`,
    "  101   100   100 /Applications/Google Chrome Helper --type=gpu-process",
    "  102   101   100 /Applications/Google Chrome Helper --type=renderer",
    "  200     1   200 /Applications/Google Chrome --user-data-dir=/Users/example/Chrome",
    "  201   200   200 /Applications/Google Chrome Helper --type=renderer",
    `  300     1   300 /bin/tool --note=${captureProfile}`,
    "",
  ].join("\n"));
  assert.deepEqual(profileRelatedProcessIds(rows, captureProfile), [100, 101, 102]);
  assert.deepEqual(profileRelatedProcessIds(rows, "/private/tmp/missing-profile"), []);
});

test("delivery asset resolver fails closed without a verified GLB-derived PLY", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-gate-"));
  try {
    assert.throws(
      () => resolveCaptureAsset({ assetPath: join(temporary, "missing.ply"), assetEvidencePath: join(temporary, "missing.json") }),
      /no procedural delivery fallback/u,
    );

    const assetPath = join(temporary, "scan.ply");
    const evidencePath = join(temporary, "asset-evidence.json");
    const bytes = Buffer.from("verified-museum-scan-derived-gaussian");
    writeFileSync(assetPath, bytes);
    writeFileSync(evidencePath, JSON.stringify({
      schema: "semaframe.reality-twin-asset-evidence.v1",
      retrieval: { source_files: [{ format: "GLB 2.0" }, { format: "GLB 2.0" }] },
      conversion: {
        algorithm: "deterministic area-weighted triangle surface sampling",
        splat_count: 1_500_000,
        limitations: ["This derivative is not a native Gaussian capture."],
      },
      output: { sha256: sha256(bytes).slice(7), bytes: bytes.byteLength },
      validation: { status: "passed" },
    }));
    assert.equal(resolveCaptureAsset({ assetPath, assetEvidencePath: evidencePath }).digest, sha256(bytes));

    writeFileSync(evidencePath, JSON.stringify({
      schema: "semaframe.reality-twin-asset-evidence.v1",
      retrieval: { source_files: [{ format: "GLB 2.0" }, { format: "GLB 2.0" }] },
      conversion: { algorithm: "native", splat_count: 1_500_000, limitations: [] },
      output: { sha256: sha256(bytes).slice(7), bytes: bytes.byteLength },
      validation: { status: "passed" },
    }));
    assert.throws(() => resolveCaptureAsset({ assetPath, assetEvidencePath: evidencePath }), /GLB-scan to Gaussian-PLY conversion/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("capture evidence validator rejects missing real receipts", () => {
  const valid = completeEvidence();
  assert.equal(validateCaptureEvidence(valid, fixture), valid);
  const forgedImport = structuredClone(valid);
  forgedImport.assetImport.browserAuthoritative = false;
  assert.throws(() => validateCaptureEvidence(forgedImport, fixture), /browser-authoritative/u);
  const generativeAgentClaim = structuredClone(valid);
  generativeAgentClaim.agentExecution.generativePlannerUsed = true;
  assert.throws(() => validateCaptureEvidence(generativeAgentClaim, fixture), /generative Agent planning/u);
  const humanInputClaim = structuredClone(valid);
  humanInputClaim.calibration.appliedThroughHumanUi = true;
  assert.throws(() => validateCaptureEvidence(humanInputClaim, fixture), /input-driver evidence/u);
  const blindCalibrationClaim = structuredClone(valid);
  blindCalibrationClaim.calibration.blindValidation = true;
  assert.throws(() => validateCaptureEvidence(blindCalibrationClaim, fixture), /candidate search policy/u);
  const hiddenCalibrationSearch = structuredClone(valid);
  hiddenCalibrationSearch.calibration.rejectedCandidateCount = 0;
  assert.throws(() => validateCaptureEvidence(hiddenCalibrationSearch, fixture), /rejected-candidate receipt/u);
  const missingNegativeControlReceipt = structuredClone(valid);
  missingNegativeControlReceipt.calibration.rejectedCandidates = [];
  assert.throws(() => validateCaptureEvidence(missingNegativeControlReceipt, fixture), /do not match the rejected count/u);
  const forgedNegativeControlDistance = structuredClone(valid);
  forgedNegativeControlDistance.calibration.rejectedCandidates[0].sourceDistance = 0.06;
  assert.throws(() => validateCaptureEvidence(forgedNegativeControlDistance, fixture), /does not match its live A\/B points/u);
  const forgedRejectedResidualSign = structuredClone(valid);
  forgedRejectedResidualSign.calibration.rejectedCandidates[0].catalogResidualM.z *= -1;
  assert.throws(() => validateCaptureEvidence(forgedRejectedResidualSign, fixture), /catalog residual z is not observed-minus-catalog/u);
  const forgedAcceptedResidualSign = structuredClone(valid);
  forgedAcceptedResidualSign.scanAabbComparison.residualM.z *= -1;
  assert.throws(() => validateCaptureEvidence(forgedAcceptedResidualSign, fixture), /Scan AABB z residual is not observed-minus-catalog/u);
  const detachedMeasurement = structuredClone(valid);
  detachedMeasurement.independentDimensionCheck.pointB.assetDigest = `sha256:${"e".repeat(64)}`;
  assert.throws(() => validateCaptureEvidence(detachedMeasurement, fixture), /not bound to the imported Reality asset/u);
  const wrongPointRole = structuredClone(valid);
  wrongPointRole.calibration.pointB.pointId = "measurement-11-a";
  assert.throws(() => validateCaptureEvidence(wrongPointRole, fixture), /measurement-session identity/u);
  const splitCalibrationSession = structuredClone(valid);
  splitCalibrationSession.calibration.pointB.sessionId = 13;
  splitCalibrationSession.calibration.pointB.pointId = "measurement-13-b";
  assert.throws(() => validateCaptureEvidence(splitCalibrationSession, fixture), /different measurement sessions/u);
  const forgedCalibrationCoordinate = structuredClone(valid);
  forgedCalibrationCoordinate.calibration.pointB.y += 0.01;
  assert.throws(() => validateCaptureEvidence(forgedCalibrationCoordinate, fixture), /source distance does not match/u);
  const blindSecondSpan = structuredClone(valid);
  blindSecondSpan.independentDimensionCheck.blindValidation = true;
  assert.throws(() => validateCaptureEvidence(blindSecondSpan, fixture), /overstated as blind validation/u);
  const forgedSecondSpanCoordinate = structuredClone(valid);
  forgedSecondSpanCoordinate.independentDimensionCheck.pointB.x += 0.01;
  assert.throws(() => validateCaptureEvidence(forgedSecondSpanCoordinate, fixture), /source distance does not match/u);
  const forgedSecondSpanMeasurement = structuredClone(valid);
  forgedSecondSpanMeasurement.independentDimensionCheck.measuredM += 0.005;
  forgedSecondSpanMeasurement.independentDimensionCheck.residualM = Math.abs(
    forgedSecondSpanMeasurement.independentDimensionCheck.measuredM
      - forgedSecondSpanMeasurement.independentDimensionCheck.expectedM,
  );
  assert.throws(() => validateCaptureEvidence(forgedSecondSpanMeasurement, fixture), /does not equal source distance times calibration scale/u);
  const forgedCollision = structuredClone(valid);
  forgedCollision.collision.revisionAfterRejection = 6;
  assert.throws(() => validateCaptureEvidence(forgedCollision, fixture), /changed Workspace revision/u);
  const skippedChecker = structuredClone(valid);
  skippedChecker.exports.usda.usdchecker.exitCode = null;
  assert.throws(() => validateCaptureEvidence(skippedChecker, fixture), /usdchecker did not exit zero/u);
  const softwareCapture = structuredClone(valid);
  softwareCapture.captures.browserGraphics.renderer = "ANGLE (Google, Vulkan SwiftShader device)";
  assert.throws(() => validateCaptureEvidence(softwareCapture, fixture), /hardware-accelerated graphics path/u);
  const mislabeledModel = structuredClone(valid);
  mislabeledModel.model.publishedSubtree = { proxyOnly: true, containsReality: false };
  assert.throws(() => validateCaptureEvidence(mislabeledModel, fixture), /exclude the Gaussian Reality layer/u);
  const forgedModelToolDigest = structuredClone(valid);
  forgedModelToolDigest.model.toolDigest = "fnv1a32:00000000";
  assert.throws(() => validateCaptureEvidence(forgedModelToolDigest, fixture), /FNV tool digest/u);
  const forgedModelContentSha = structuredClone(valid);
  forgedModelContentSha.model.contentSha256 = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateCaptureEvidence(forgedModelContentSha, fixture), /canonical SHA-256 receipt/u);
  const tamperedModelPayload = structuredClone(valid);
  tamperedModelPayload.model.canonicalDefinition.nodes[0].nodeId = "tampered-node";
  assert.throws(() => validateCaptureEvidence(tamperedModelPayload, fixture), /tool digest does not match canonical definition content/u);
});

test("smoke evidence uses the full validator with an isolated reduced-frame contract", () => {
  const smokeEvidence = completeEvidence();
  smokeEvidence.captureMode = "smoke";
  smokeEvidence.deliveryEvidence = false;
  for (const sequence of fixture.capture.sequences) smokeEvidence.captures.frameCounts[sequence] = 8;
  const smokeFixture = structuredClone(fixture);
  smokeFixture.capture.sequenceFrameCounts = Object.fromEntries(
    fixture.capture.sequences.map((sequence) => [sequence, 8]),
  );
  assert.equal(validateCaptureEvidence(smokeEvidence, smokeFixture), smokeEvidence);
  assert.throws(() => validateCaptureEvidence(smokeEvidence, fixture), /frame evidence is incomplete/u);
});

test("system usdchecker validates a real minimal USDA file", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-usd-"));
  try {
    const path = join(temporary, "minimal.usda");
    writeFileSync(path, [
      "#usda 1.0",
      "(",
      "    defaultPrim = \"World\"",
      "    metersPerUnit = 1",
      "    upAxis = \"Y\"",
      ")",
      "def Xform \"World\" {}",
      "",
    ].join("\n"));
    const receipt = runUsdChecker(path, resolveUsdChecker());
    assert.equal(receipt.exitCode, 0);
    assert.match(receipt.stdout, /Success!/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
