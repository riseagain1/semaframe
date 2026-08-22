import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  analyzeCaptureSamples,
  assertArtifactFreshness,
  assertTruthfulCopy,
  buildVerificationReceipt,
  computeCaptureManifest,
  sha256,
  validateAssetEvidence,
  validateCaptureEvidence,
  validateLumaAnalysis,
  validateMediaProbe,
  validateRealityTwinArtifactRelativePath,
  validateRootRegistrations,
  validateTimedTranscript,
  validateVisualContract,
  verifyAssetFiles,
  verificationReceiptPath,
  resolveRealityTwinArtifactPath,
  writeVerificationReceiptAtomic,
} from "./verify-reality-twin-v1.mjs";
import {
  fnv1a32,
  publishedModelReceipts,
} from "./reality-twin-capture-core.mjs";

const root = resolve(import.meta.dirname, "..");
const loadText = (path) => readFileSync(resolve(root, path), "utf8");
const loadJson = (path) => JSON.parse(loadText(path));
const visualContract = loadJson("video/reality-twin-v1.visual-contract.json");
const compositionSource = loadText("video/src/RealityTwinProofV1.tsx");
const rootSource = loadText("video/src/Root.tsx");
const assetEvidence = loadJson("scripts/fixtures/reality-twin-asset-evidence.fixture.json");
const captureFixture = loadJson("scripts/fixtures/reality-twin-demo.fixture.json");
const captureFolders = Object.fromEntries(Object.entries(visualContract.source.captureFolders).map(([folder, value]) => {
  const [, last] = value.requiredFrames.split("..").map(Number);
  return [folder, last + 1];
}));

const clone = (value) => structuredClone(value);
const fixedSha = (character) => `sha256:${character.repeat(64)}`;

function evidenceFixture() {
  const modelContent = {
    formatVersion: "1.0",
    modelId: "com.semaframe.reality-twin.protective-case",
    version: "1.0.0",
    displayName: "Reality Twin Protective Display Case",
    rootNodeId: "CMP_CASE_SOURCE",
    nodes: Array.from({ length: 6 }, (_, index) => ({ nodeId: `MODEL_NODE_${index}` })),
    sourceRevision: 14,
    generatorVersion: "1.0.0",
  };
  const canonicalModelDefinition = { ...modelContent, digest: fnv1a32(modelContent) };
  const modelReceipts = publishedModelReceipts(canonicalModelDefinition);
  const projectBytes = Buffer.from(JSON.stringify({
    workspace: {
      components: [
        { id: "CMP_REALITY_SCAN", props: { semanticProxyIds: ["CMP_CASE_PROXY"] } },
        { id: "CMP_CASE_PROXY", props: { topThicknessM: 0.01 } },
      ],
      modelDefinitions: [[
        "com.semaframe.reality-twin.protective-case@1.0.0",
        canonicalModelDefinition,
      ]],
    },
  }));
  const usdaBytes = Buffer.from([
    "#usda 1.0",
    "(",
    "    defaultPrim = \"ProtectiveCase\"",
    "    metersPerUnit = 1",
    "    upAxis = \"Y\"",
    ")",
    "def Xform \"ProtectiveCase\" {",
    "    def Cube \"TopPanel\" {}",
    "}",
    "",
  ].join("\n"));
  const integrity = {
    visualContractSha256: fixedSha("1"),
    compositionSourceSha256: fixedSha("2"),
    rootSourceSha256: fixedSha("3"),
    assetEvidenceSha256: fixedSha("4"),
    landscapeCaptionSha256: fixedSha("5"),
    verticalCaptionSha256: fixedSha("6"),
  };
  const captureManifest = { hash: fixedSha("7"), fileCount: 690 };
  const derivedDigest = `sha256:${assetEvidence.derivedAsset.sha256}`;
  const assetId = `ra_${assetEvidence.derivedAsset.sha256}`;
  const sourceBounds = clone(assetEvidence.validation.semaframe_current_preflight.descriptor.sourceBounds);
  const calibratedScanAabbM = {
    x: sourceBounds.max.x - sourceBounds.min.x,
    y: sourceBounds.max.y - sourceBounds.min.y,
    z: sourceBounds.max.z - sourceBounds.min.z,
  };
  const expectedCatalogM = {
    x: assetEvidence.subject.dimensions_metres.width,
    y: assetEvidence.subject.dimensions_metres.height,
    z: assetEvidence.subject.dimensions_metres.depth,
  };
  const buildRejectedCandidate = ({ sequence, controlKind, sessionId, pointA, pointB }) => {
    const sourceDistance = Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y, pointA.z - pointB.z);
    const sourceDelta = {
      x: Math.abs(pointA.x - pointB.x),
      y: Math.abs(pointA.y - pointB.y),
      z: Math.abs(pointA.z - pointB.z),
    };
    const candidateMetersPerSourceUnit = captureFixture.physicalTruth.calibration.knownDistanceM / sourceDistance;
    const candidateAabb = Object.fromEntries(["x", "y", "z"].map((axis) => [
      axis,
      (sourceBounds.max[axis] - sourceBounds.min[axis]) * candidateMetersPerSourceUnit,
    ]));
    const residual = Object.fromEntries(["x", "y", "z"].map((axis) => [axis, candidateAabb[axis] - expectedCatalogM[axis]]));
    const reasons = [];
    const policy = captureFixture.physicalTruth.calibration;
    const tolerance = captureFixture.physicalTruth.scanResidualToleranceM;
    const sourceHeight = sourceBounds.max.y - sourceBounds.min.y;
    if (sourceDistance < policy.minimumAcceptedSourceSpanM) reasons.push("source_span_below_minimum");
    if (sourceDistance > policy.maximumAcceptedSourceSpanM) reasons.push("source_span_above_maximum");
    if (sourceDelta.y < sourceDelta.x || sourceDelta.y < sourceDelta.z) reasons.push("source_y_not_dominant");
    if (sourceDelta.y < sourceHeight * 0.9) reasons.push("source_y_below_90_percent_of_aabb_height");
    if (sourceDistance / sourceDelta.y > 1.2) reasons.push("non_y_path_exceeds_ratio_limit");
    if (Math.abs(sourceDistance - sourceHeight) > 0.02) reasons.push("source_span_differs_from_aabb_height");
    const impliedMetricHeight = sourceHeight * policy.knownDistanceM / sourceDistance;
    if (Math.abs(impliedMetricHeight - expectedCatalogM.y) > tolerance.y) reasons.push("implied_catalog_height_residual_exceeds_tolerance");
    if (["x", "y", "z"].some((axis) => Math.abs(residual[axis]) > tolerance[axis])) reasons.push("calibrated_scan_aabb_residual_exceeds_tolerance");
    const bindPoint = (point, role) => ({
      ...point,
      pickedOnCurrentGaussianLod: true,
      sessionId,
      pointId: `measurement-${sessionId}-${role}`,
      assetId,
      assetDigest: derivedDigest,
    });
    return {
      sequence,
      controlKind,
      accepted: false,
      measurementFidelity: "gaussian-lod",
      pointA: bindPoint(pointA, "a"),
      pointB: bindPoint(pointB, "b"),
      sourceDistance,
      sourceDelta,
      candidateMetersPerSourceUnit,
      calibratedScanAabbM: candidateAabb,
      catalogResidualM: residual,
      residualToleranceM: clone(tolerance),
      rejectionReasonCodes: reasons,
    };
  };
  const rejectedCandidates = [
    buildRejectedCandidate({
      sequence: 1,
      controlKind: "visible_short_span",
      sessionId: 3,
      pointA: { x: 0, y: sourceBounds.min.y + 0.02, z: 0 },
      pointB: { x: 0, y: sourceBounds.min.y + 0.12, z: 0 },
    }),
    buildRejectedCandidate({
      sequence: 2,
      controlKind: "search_candidate",
      sessionId: 4,
      pointA: { x: sourceBounds.min.x + 0.01, y: 0.16, z: 0 },
      pointB: { x: sourceBounds.max.x - 0.01, y: 0.16, z: 0 },
    }),
  ];
  const evidence = {
    format: "semaframe-reality-twin-capture-evidence",
    version: 1,
    status: "complete",
    captureRunId: "reality-twin-run-0001",
    startedAt: "2026-08-22T12:00:00.000Z",
    completedAt: "2026-08-22T12:00:10.000Z",
    integrity: {
      ...integrity,
      captureAssetManifestSha256: captureManifest.hash,
      captureAssetCount: captureManifest.fileCount,
    },
    source: {
      derivation: "smithsonian_glb_scan_to_gaussian_ply",
      nativeGaussianCapture: false,
      assetEvidencePath: "video/public/reality-twin/asset-evidence.json",
      sourceGlbDigests: assetEvidence.retrieval.source_files.map((file) => `sha256:${file.sha256}`),
      derivedPlyDigest: derivedDigest,
    },
    agentExecution: {
      kind: "deterministic_authorized_mcp_client",
      generativePlannerUsed: false,
      fixtureDriven: true,
    },
    assetImport: {
      browserAuthoritative: true,
      requestId: "req_reality_twin_0001",
      upload: { httpStatus: 200, byteLength: assetEvidence.derivedAsset.byteLength },
      localBytesReady: true,
      assetRef: { assetId, digest: derivedDigest },
      descriptor: {
        version: 1,
        assetId,
        digest: derivedDigest,
        format: "ply",
        mediaType: "application/ply",
        byteLength: assetEvidence.derivedAsset.byteLength,
        splatCount: assetEvidence.derivedAsset.splatCount,
        sphericalHarmonicsDegree: 0,
        model: "gaussian-3d",
        engineeringAuthority: "visual_only",
        sourceBounds,
      },
    },
    calibration: {
      measurementFidelity: "gaussian-lod",
      measurementCompleted: true,
      appliedThroughInspectorUi: true,
      inputDriver: "automated_cdp_pointer_and_form_events",
      humanInputClaimed: false,
      blindValidation: false,
      selectionPolicy: "target_guided_visible_candidate_search_with_aabb_residual_gate",
      rejectedCandidateCount: rejectedCandidates.length,
      rejectedCandidates,
      pickedOnCurrentGaussianLod: true,
      pointA: {
        x: 0, y: 0, z: 0,
        pickedOnCurrentGaussianLod: true,
        sessionId: 1,
        pointId: "measurement-1-a",
        assetId,
        assetDigest: derivedDigest,
      },
      pointB: {
        x: 0, y: 0.322, z: 0,
        pickedOnCurrentGaussianLod: true,
        sessionId: 1,
        pointId: "measurement-1-b",
        assetId,
        assetDigest: derivedDigest,
      },
      sourceDistance: 0.322,
      knownDistanceM: 0.322,
      metersPerSourceUnit: 1,
      assetDigest: derivedDigest,
      componentReadback: { status: "reference-distance", metersPerSourceUnit: 1 },
      workspaceRevision: 8,
    },
    scanAabbComparison: {
      expectedCatalogM,
      calibratedScanAabbM,
      residualM: Object.fromEntries(["x", "y", "z"].map((axis) => [
        axis,
        calibratedScanAabbM[axis] - expectedCatalogM[axis],
      ])),
      toleranceM: { x: 0.02, y: 0.02, z: 0.02 },
      passed: true,
      exactCatalogMatchClaimed: false,
    },
    independentDimensionCheck: {
      source: "live_calibrated_gaussian_measurement",
      displayedWithoutSubstitution: true,
      blindValidation: false,
      selectionPolicy: "target_guided_visible_candidate_search",
      viewPreparation: "automated_canvas_orbit_pointer_events",
      distinctFromCalibrationPair: true,
      pointA: {
        x: -0.16521679566276495, y: 0.1, z: 0,
        pickedOnCurrentGaussianLod: true,
        sessionId: 2,
        pointId: "measurement-2-a",
        assetId,
        assetDigest: derivedDigest,
      },
      pointB: {
        x: 0.16521679566276495, y: 0.1, z: 0,
        pickedOnCurrentGaussianLod: true,
        sessionId: 2,
        pointId: "measurement-2-b",
        assetId,
        assetDigest: derivedDigest,
      },
      sourceDistance: 0.3304335913255299,
      expectedM: 0.322,
      measuredM: 0.3304335913255299,
      residualM: 0.008433591325529899,
      toleranceM: 0.02,
      toleranceSource: "asset-evidence.json derivedAsset.independentDimensionChecks.width",
      passed: true,
    },
    agentReadback: {
      tool: "inspect_workspace_space",
      safeDescriptorOnly: true,
      rawSplatsExposed: false,
      rawPixelsExposed: false,
      sourceGlbExposed: false,
      assetDigest: derivedDigest,
      calibration: { metersPerSourceUnit: 1 },
      worldBounds: {
        min: { x: -0.1652167957, y: 0, z: -0.0727760107 },
        max: { x: 0.1652167957, y: 0.322, z: 0.0727760107 },
        units: "metres",
      },
      semanticProxyIds: ["CMP_CASE_PROXY"],
    },
    semanticProxy: {
      linked: true,
      proxyId: "CMP_CASE_PROXY",
      realityId: "CMP_REALITY_SCAN",
      engineeringAuthority: "proxy",
      realityEngineeringAuthority: "visual_only",
      relations: ["CMP_REALITY_SCAN represented_by:CMP_CASE_PROXY"],
      exactGeometry: true,
    },
    collision: {
      preflightValid: false,
      preflightConflicts: [{ leftId: "CMP_CASE_PROXY", rightId: "CMP_PLINTH" }],
      rejectedBatchCode: "spatial_collision",
      revisionBeforeRejection: 10,
      revisionAfterRejection: 10,
      atomic: true,
      proxyColliderEnabled: true,
      realityColliderEnabled: false,
      correctedCollisionConflictCount: 0,
    },
    numericEdit: {
      componentId: "CMP_CASE_PROXY",
      property: "topThicknessM",
      beforeM: 0.008,
      afterM: 0.01,
      readbackAfterM: 0.01,
      undoRestoredBefore: true,
      redoRestoredAfter: true,
    },
    history: {
      undo: { applied: true, readbackM: 0.008 },
      redo: { applied: true, readbackM: 0.01 },
    },
    persistence: {
      preserved: true,
      savedRevision: 15,
      reopenedRevision: 15,
      savedComponentCount: 11,
      reopenedComponentCount: 11,
      projectPath: "artifacts/reality-twin/reality-twin-shang-gong.semaframe.json",
      projectSha256: sha256(projectBytes),
    },
    model: {
      published: true,
      modelId: "com.semaframe.reality-twin.protective-case",
      version: "1.0.0",
      toolDigest: modelReceipts.toolDigest,
      contentSha256: modelReceipts.contentSha256,
      canonicalDefinition: canonicalModelDefinition,
      publishedRevision: 14,
      nodeCount: 6,
      sourceRootId: "CMP_CASE_SOURCE",
      instanceRootId: "CMP_CASE_INSTANCE",
      editableInstance: true,
      publishedSubtree: {
        rootId: "CMP_CASE_SOURCE",
        rootType: "model-assembly",
        contentClass: "protective_case_model",
        excludesReality: true,
        containsReality: false,
      },
    },
    exports: {
      usda: {
        filename: "reality-twin-protective-case.usda",
        artifactPath: "artifacts/reality-twin/capture/reality-twin-protective-case.usda",
        byteLength: usdaBytes.byteLength,
        sha256: sha256(usdaBytes),
        validOpenUsd: true,
        freshExport: true,
        captureRunId: "reality-twin-run-0001",
        sourceModelToolDigest: modelReceipts.toolDigest,
        sourceModelContentSha256: modelReceipts.contentSha256,
        sourceWorkspaceRevision: 14,
        exportedAt: "2026-08-22T12:00:05.000Z",
        usdchecker: {
          executable: "/usr/bin/usdchecker",
          args: ["artifacts/reality-twin/reality-twin-protective-case.usda"],
          exitCode: 0,
          signal: null,
          stdout: "Success!",
          stderr: "",
        },
      },
    },
    captures: {
      viewport: { width: 1920, height: 1080, fps: 30 },
      browserGraphics: {
        api: "webgl2",
        webgl2: true,
        vendor: "Apple Inc.",
        renderer: "ANGLE Metal Renderer: Apple M3",
        hardwareAccelerated: true,
        softwareRenderer: false,
      },
      frameCounts: captureFolders,
      sequences: Object.keys(captureFolders),
    },
  };
  return {
    evidence,
    context: {
      assetEvidence,
      captureFixture,
      integrity,
      captureManifest,
      projectBytes,
      usdaBytes,
      usdaModifiedMs: Date.parse("2026-08-22T12:00:05.000Z"),
      usdaPath: "artifacts/reality-twin/capture/reality-twin-protective-case.usda",
    },
  };
}

function mediaProbe({ audio = null } = {}) {
  return {
    format: { duration: "32.000" },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
        nb_read_frames: "960",
        color_range: "tv",
        color_space: "bt709",
        color_transfer: "bt709",
        color_primaries: "bt709",
      },
      ...(audio ? [{ codec_type: "audio", sample_rate: "48000", channels: 2, ...audio }] : []),
    ],
  };
}

function minimalJpeg(width = 1920, height = 1080) {
  const bytes = Buffer.alloc(32);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  bytes.writeUInt16BE(17, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = 3;
  return bytes;
}

test("accepts the current 32s landscape and independent 30s vertical contract", () => {
  assert.deepEqual(validateVisualContract(clone(visualContract), { compositionSource }), {
    beatCount: 11,
    captureFrameCount: 690,
    landscapeFrames: 960,
    verticalFrames: 900,
  });
});

test("rejects a timeline gap and an unsafe truth boundary", () => {
  const gap = clone(visualContract);
  gap.delivery.vertical.timeline[4].from += 1;
  assert.throws(() => validateVisualContract(gap), /must begin/u);
  const unsafe = clone(visualContract);
  unsafe.delivery.vertical.boundaryNoteBounds.y = 1729;
  assert.throws(() => validateVisualContract(unsafe), /safe area/u);
  const socialRail = clone(visualContract);
  socialRail.delivery.vertical.safeArea.right = 120;
  assert.throws(() => validateVisualContract(socialRail), /social action rail/u);
  const bottomCaptions = clone(visualContract);
  bottomCaptions.delivery.vertical.safeArea.bottom = 200;
  assert.throws(() => validateVisualContract(bottomCaptions), /bottom caption zone/u);
});

test("binds the result-first hook to the real orbit and verified final capture", () => {
  for (const variant of ["landscape", "vertical"]) {
    const hook = visualContract.delivery[variant].timeline[0];
    assert.equal(hook.source, "orbit-frames:0..47");
    assert.equal(hook.secondarySource, "final-frames:0..47");
    assert.equal(hook.transition, "crossfade-to-verified-result");
    assert.equal(visualContract.delivery[variant].timeline[1].source, "final-frames:12..59");
  }
  const forged = clone(visualContract);
  forged.delivery.landscape.timeline[0].secondarySource = "proxy-build-frames:0..47";
  assert.throws(() => validateVisualContract(forged), /verified final result/u);
});

test("requires all four Root registrations exactly once with exact dimensions and duration constants", () => {
  assert.deepEqual(validateRootRegistrations(rootSource, visualContract), {
    registeredCompositions: 2,
    registeredPosters: 2,
  });
  assert.throws(() => validateRootRegistrations(`${rootSource}\n${rootSource.match(/<Still[\s\S]*?id="SemaFrameRealityTwinProofV1Poster"[\s\S]*?\/>/u)?.[0] ?? ""}`, visualContract), /exactly once/u);
  assert.throws(() => validateRootRegistrations(rootSource.replace(
    "durationInFrames={REALITY_TWIN_PROOF_V1_VERTICAL_DURATION}",
    "durationInFrames={900}",
  ), visualContract), /duration constant/u);
});

test("accepts both complete English-only SRTs at the 20 CPS readability ceiling", () => {
  for (const [variant, durationSeconds] of [["landscape", 32], ["vertical", 30]]) {
    const result = validateTimedTranscript(loadText(visualContract.delivery[variant].captionPath), {
      id: `${variant}-en-US`,
      durationSeconds,
    });
    assert.equal(result.cueCount, 11);
    assert.ok(result.maximumCps <= 20);
    assert.ok(result.maximumWordsPerSecond <= 4);
    assert.ok(result.longestLine <= 52);
  }
});

test("rejects SRT timing gaps, CJK leakage, and unreadable density", () => {
  const source = loadText(visualContract.delivery.landscape.captionPath);
  assert.throws(() => validateTimedTranscript(source.replace(
    "00:00:02,000 --> 00:00:04,000",
    "00:00:02,100 --> 00:00:04,000",
  ), { id: "gap", durationSeconds: 32 }), /gap or overlap/u);
  assert.throws(() => validateTimedTranscript(source.replace("SemaFrame is a spatial workspace for Agents.", "这是 SemaFrame："), {
    id: "cjk",
    durationSeconds: 32,
  }), /CJK/u);
  assert.throws(() => validateTimedTranscript(source.replace("SemaFrame is a spatial workspace for Agents.", "X".repeat(120)), {
    id: "dense",
    durationSeconds: 32,
  }), /characters per second|line longer/u);
});

test("forbids fixed A/B SVG guides and requires a non-spatial calibration receipt", () => {
  const fixedGuide = `${compositionSource}\nconst FixedPickGuide = () => <svg><line x1={10} y1={10} x2={20} y2={20} /><text>A</text><text>B</text></svg>;`;
  assert.throws(
    () => validateVisualContract(clone(visualContract), { compositionSource: fixedGuide }),
    /fixed A\/B SVG points or lines/u,
  );
  const oldOverlay = `${compositionSource}\nconst CalibrationOverlay = () => null;`;
  assert.throws(
    () => validateVisualContract(clone(visualContract), { compositionSource: oldOverlay }),
    /fixed-position CalibrationOverlay/u,
  );
  assert.throws(
    () => validateVisualContract(clone(visualContract), {
      compositionSource: compositionSource.replace(
        'data-calibration-receipt="non-spatial-summary"',
        'data-calibration-receipt="spatial-decoration"',
      ),
    }),
    /non-spatial-summary/u,
  );
});

test("requires calibration and edit summaries to follow their captured source stages", () => {
  const stageFormula = "Math.min(2, Math.floor(frame / segmentDuration))";
  assert.equal(compositionSource.split(stageFormula).length - 1, 1);

  const calibrationUnstaged = compositionSource.replace(stageFormula, "0");
  assert.throws(
    () => validateVisualContract(clone(visualContract), { compositionSource: calibrationUnstaged }),
    /calibration receipt must follow the three real capture stages/u,
  );

  const editStageFormula = "sourceFrame < 26 ? 0 : sourceFrame < 39 ? 1 : sourceFrame < 52 ? 2 : 3";
  assert.equal(compositionSource.split(editStageFormula).length - 1, 1);
  const editUnstaged = compositionSource.replace(editStageFormula, "0");
  assert.throws(
    () => validateVisualContract(clone(visualContract), { compositionSource: editUnstaged }),
    /edit overlay must follow the publish, blocked, corrected, and numeric-edit source-frame ranges/u,
  );

  assert.throws(
    () => validateVisualContract(clone(visualContract), {
      compositionSource: compositionSource.replace(
        'proof: "LIVE WORKSPACE RECEIPTS · PROXY OWNS COLLISION"',
        'proof: "COLLISION BLOCKED → FIT CORRECTED"',
      ),
    }),
    /must not announce collision outcomes/u,
  );
});

test("accepts authoritative Smithsonian GLB-to-Gaussian asset evidence", () => {
  const summary = validateAssetEvidence(clone(assetEvidence));
  assert.equal(summary.sourceGlbCount, 2);
  assert.equal(summary.splatCount, 1_500_000);
  assert.equal(summary.derivedAssetBytes, 84_000_660);
});

test("asset evidence rejects native-capture overclaims and hidden residual tolerance", () => {
  const native = clone(assetEvidence);
  native.source.nativeGaussianCapture = true;
  assert.throws(() => validateAssetEvidence(native), /not a native Gaussian capture/u);
  const permissive = clone(assetEvidence);
  permissive.derivedAsset.independentDimensionChecks.toleranceMetres = 0.2;
  assert.throws(() => validateAssetEvidence(permissive), /20 mm/u);
  const forgedResidual = clone(assetEvidence);
  forgedResidual.derivedAsset.independentDimensionChecks.depth.residualMetres = 0;
  assert.throws(() => validateAssetEvidence(forgedResidual), /observed signed residual/u);
  const blankSpark = clone(assetEvidence);
  blankSpark.validation.spark_browser_import.active_splats = 0;
  assert.throws(() => validateAssetEvidence(blankSpark), /decode and activate every/u);
});

test("accepts a complete end-to-end Reality Twin evidence fixture", () => {
  const { evidence, context } = evidenceFixture();
  const result = validateCaptureEvidence(evidence, context);
  assert.equal(result.importedDigest, `sha256:${assetEvidence.derivedAsset.sha256}`);
  assert.equal(result.rejectedRevision, 10);
  assert.equal(result.savedRevision, 15);
  assert.equal(result.modelId, "com.semaframe.reality-twin.protective-case");
});

test("rejects dot-segment and escaping Reality Twin artifact paths", () => {
  assert.equal(
    validateRealityTwinArtifactRelativePath(
      "artifacts/reality-twin/capture/model.semaframe.json",
      ".semaframe.json",
      "Saved project path",
    ),
    "artifacts/reality-twin/capture/model.semaframe.json",
  );
  assert.equal(
    resolveRealityTwinArtifactPath(
      "/tmp/semaframe-root",
      "artifacts/reality-twin/capture/model.usda",
      ".usda",
      "USDA artifact path",
    ),
    "/tmp/semaframe-root/artifacts/reality-twin/capture/model.usda",
  );
  for (const forgedPath of [
    "artifacts/reality-twin/../escape.semaframe.json",
    "artifacts/reality-twin/./capture/model.semaframe.json",
    "artifacts/reality-twin/capture/../../escape.semaframe.json",
    "/tmp/escape.semaframe.json",
  ]) {
    assert.throws(() => validateRealityTwinArtifactRelativePath(
      forgedPath,
      ".semaframe.json",
      "Saved project path",
    ), /Saved project path is invalid/u);
  }

  const forgedProject = evidenceFixture();
  forgedProject.evidence.persistence.projectPath = "artifacts/reality-twin/../../escape.semaframe.json";
  assert.throws(
    () => validateCaptureEvidence(forgedProject.evidence, forgedProject.context),
    /Saved project path is invalid/u,
  );

  const forgedUsda = evidenceFixture();
  forgedUsda.evidence.exports.usda.artifactPath = "artifacts/reality-twin/capture/../../escape.usda";
  assert.throws(
    () => validateCaptureEvidence(forgedUsda.evidence, forgedUsda.context),
    /USDA artifact path is invalid/u,
  );
});

test("fails closed unless capture evidence proves hardware WebGL2 without a software renderer", () => {
  const missing = evidenceFixture();
  delete missing.evidence.captures.browserGraphics;
  assert.throws(() => validateCaptureEvidence(missing.evidence, missing.context), /browserGraphics is missing/u);

  const webgl1 = evidenceFixture();
  webgl1.evidence.captures.browserGraphics.webgl2 = false;
  assert.throws(() => validateCaptureEvidence(webgl1.evidence, webgl1.context), /WebGL2/u);

  const mismatchedApi = evidenceFixture();
  mismatchedApi.evidence.captures.browserGraphics.api = "webgl";
  assert.throws(() => validateCaptureEvidence(mismatchedApi.evidence, mismatchedApi.context), /WebGL2/u);

  const noHardwareProof = evidenceFixture();
  noHardwareProof.evidence.captures.browserGraphics.hardwareAccelerated = false;
  assert.throws(() => validateCaptureEvidence(noHardwareProof.evidence, noHardwareProof.context), /hardware acceleration/u);

  const softwareFlag = evidenceFixture();
  softwareFlag.evidence.captures.browserGraphics.softwareRenderer = true;
  assert.throws(() => validateCaptureEvidence(softwareFlag.evidence, softwareFlag.context), /deny a software renderer/u);

  for (const renderer of ["ANGLE (Google, Vulkan 1.3 SwiftShader)", "Software Rasterizer"]) {
    const softwareIdentity = evidenceFixture();
    softwareIdentity.evidence.captures.browserGraphics.renderer = renderer;
    assert.throws(() => validateCaptureEvidence(softwareIdentity.evidence, softwareIdentity.context), /SwiftShader or software rendering/u);
  }
});

test("rejects stale source hashes and a forged browser import digest", () => {
  const stale = evidenceFixture();
  stale.evidence.integrity.compositionSourceSha256 = fixedSha("9");
  assert.throws(() => validateCaptureEvidence(stale.evidence, stale.context), /compositionSourceSha256 is stale/u);
  const forged = evidenceFixture();
  forged.evidence.assetImport.assetRef.digest = fixedSha("a");
  assert.throws(() => validateCaptureEvidence(forged.evidence, forged.context), /import digest differs/u);
});

test("rejects scripted calibration or independent-check substitutions", () => {
  const badPick = evidenceFixture();
  badPick.evidence.calibration.pointB.y = 0.3;
  assert.throws(() => validateCaptureEvidence(badPick.evidence, badPick.context), /does not match the recorded A\/B points/u);
  const substitution = evidenceFixture();
  substitution.evidence.independentDimensionCheck.displayedWithoutSubstitution = false;
  assert.throws(() => validateCaptureEvidence(substitution.evidence, substitution.context), /without numeric substitution/u);
  const residual = evidenceFixture();
  residual.evidence.independentDimensionCheck.residualM = 0;
  assert.throws(() => validateCaptureEvidence(residual.evidence, residual.context), /not the observed absolute residual/u);
});

test("rejects undisclosed execution and calibration points without immutable session and asset bindings", () => {
  const planner = evidenceFixture();
  planner.evidence.agentExecution.generativePlannerUsed = true;
  assert.throws(() => validateCaptureEvidence(planner.evidence, planner.context), /deterministic fixture-driven Agent execution/u);

  const humanClaim = evidenceFixture();
  humanClaim.evidence.calibration.humanInputClaimed = true;
  assert.throws(() => validateCaptureEvidence(humanClaim.evidence, humanClaim.context), /disclose automated Inspector pointer input/u);

  const blindCalibration = evidenceFixture();
  blindCalibration.evidence.calibration.blindValidation = true;
  assert.throws(() => validateCaptureEvidence(blindCalibration.evidence, blindCalibration.context), /expected-aware candidate policy/u);

  const staleLod = evidenceFixture();
  staleLod.evidence.calibration.pointA.pickedOnCurrentGaussianLod = false;
  assert.throws(() => validateCaptureEvidence(staleLod.evidence, staleLod.context), /current Gaussian LOD/u);

  const mixedSession = evidenceFixture();
  mixedSession.evidence.calibration.pointB.sessionId = 3;
  assert.throws(() => validateCaptureEvidence(mixedSession.evidence, mixedSession.context), /one concrete measurement session/u);

  const wrongAsset = evidenceFixture();
  wrongAsset.evidence.calibration.pointA.assetDigest = fixedSha("a");
  assert.throws(() => validateCaptureEvidence(wrongAsset.evidence, wrongAsset.context), /not bound to the imported Reality asset/u);
});

test("rejects forged rejected-candidate identity, measurement, math, tolerance, and reason receipts", () => {
  const missing = evidenceFixture();
  delete missing.evidence.calibration.rejectedCandidates;
  assert.throws(() => validateCaptureEvidence(missing.evidence, missing.context), /do not match the disclosed count/u);

  const badSequence = evidenceFixture();
  badSequence.evidence.calibration.rejectedCandidates[1].sequence = 3;
  assert.throws(() => validateCaptureEvidence(badSequence.evidence, badSequence.context), /invalid sequence receipt/u);

  const staleLod = evidenceFixture();
  staleLod.evidence.calibration.rejectedCandidates[0].pointA.pickedOnCurrentGaussianLod = false;
  assert.throws(() => validateCaptureEvidence(staleLod.evidence, staleLod.context), /not picked on the current Gaussian LOD/u);

  const wrongAsset = evidenceFixture();
  wrongAsset.evidence.calibration.rejectedCandidates[0].pointB.assetDigest = fixedSha("a");
  assert.throws(() => validateCaptureEvidence(wrongAsset.evidence, wrongAsset.context), /not bound to the current imported Reality asset/u);

  const unsafeSession = evidenceFixture();
  unsafeSession.evidence.calibration.rejectedCandidates[0].pointA.sessionId = Number.MAX_SAFE_INTEGER + 1;
  unsafeSession.evidence.calibration.rejectedCandidates[0].pointB.sessionId = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateCaptureEvidence(unsafeSession.evidence, unsafeSession.context), /no safe shared measurement session/u);

  const duplicateSession = evidenceFixture();
  duplicateSession.evidence.calibration.rejectedCandidates[1].pointA.sessionId = 3;
  duplicateSession.evidence.calibration.rejectedCandidates[1].pointB.sessionId = 3;
  duplicateSession.evidence.calibration.rejectedCandidates[1].pointA.pointId = "measurement-3-a";
  duplicateSession.evidence.calibration.rejectedCandidates[1].pointB.pointId = "measurement-3-b";
  assert.throws(() => validateCaptureEvidence(duplicateSession.evidence, duplicateSession.context), /reused another rejected measurement session/u);

  const reusedAcceptedSession = evidenceFixture();
  reusedAcceptedSession.evidence.calibration.rejectedCandidates[0].pointA.sessionId = 1;
  reusedAcceptedSession.evidence.calibration.rejectedCandidates[0].pointB.sessionId = 1;
  reusedAcceptedSession.evidence.calibration.rejectedCandidates[0].pointA.pointId = "measurement-1-a";
  reusedAcceptedSession.evidence.calibration.rejectedCandidates[0].pointB.pointId = "measurement-1-b";
  assert.throws(() => validateCaptureEvidence(reusedAcceptedSession.evidence, reusedAcceptedSession.context), /distinct from the accepted pair/u);

  const wrongPointRole = evidenceFixture();
  wrongPointRole.evidence.calibration.rejectedCandidates[0].pointA.pointId = "measurement-3-b";
  assert.throws(() => validateCaptureEvidence(wrongPointRole.evidence, wrongPointRole.context), /point IDs do not bind/u);

  const outsideCurrentLod = evidenceFixture();
  outsideCurrentLod.evidence.calibration.rejectedCandidates[0].pointA.x = 1;
  assert.throws(() => validateCaptureEvidence(outsideCurrentLod.evidence, outsideCurrentLod.context), /outside the verified current-LOD source bounds/u);

  const forgedSpan = evidenceFixture();
  forgedSpan.evidence.calibration.rejectedCandidates[0].sourceDistance += 0.01;
  assert.throws(() => validateCaptureEvidence(forgedSpan.evidence, forgedSpan.context), /source span does not match its actual A\/B points/u);

  const forgedDelta = evidenceFixture();
  forgedDelta.evidence.calibration.rejectedCandidates[0].sourceDelta.x = 0.01;
  assert.throws(() => validateCaptureEvidence(forgedDelta.evidence, forgedDelta.context), /sourceDelta\.x is not the actual A\/B delta/u);

  const forgedScale = evidenceFixture();
  forgedScale.evidence.calibration.rejectedCandidates[0].candidateMetersPerSourceUnit += 0.1;
  assert.throws(() => validateCaptureEvidence(forgedScale.evidence, forgedScale.context), /scale does not equal known\/source distance/u);

  const forgedAabb = evidenceFixture();
  forgedAabb.evidence.calibration.rejectedCandidates[0].calibratedScanAabbM.x += 0.1;
  assert.throws(() => validateCaptureEvidence(forgedAabb.evidence, forgedAabb.context), /calibrated AABB x is not source extent times candidate scale/u);

  const forgedResidual = evidenceFixture();
  forgedResidual.evidence.calibration.rejectedCandidates[0].catalogResidualM.z = 0;
  assert.throws(() => validateCaptureEvidence(forgedResidual.evidence, forgedResidual.context), /catalog residual z is not observed-minus-catalog/u);

  const forgedTolerance = evidenceFixture();
  forgedTolerance.evidence.calibration.rejectedCandidates[0].residualToleranceM.y = 0.03;
  assert.throws(() => validateCaptureEvidence(forgedTolerance.evidence, forgedTolerance.context), /residual tolerance y is not authoritative/u);

  const missingReason = evidenceFixture();
  missingReason.evidence.calibration.rejectedCandidates[0].rejectionReasonCodes.shift();
  assert.throws(() => validateCaptureEvidence(missingReason.evidence, missingReason.context), /reason codes do not match the observed negative-control math/u);

  const unknownReason = evidenceFixture();
  unknownReason.evidence.calibration.rejectedCandidates[0].rejectionReasonCodes.push("trust_me");
  assert.throws(() => validateCaptureEvidence(unknownReason.evidence, unknownReason.context), /duplicate or unknown rejection reason codes/u);

  const noNegativeControl = evidenceFixture();
  noNegativeControl.evidence.calibration.rejectedCandidates[0].controlKind = "search_candidate";
  assert.throws(() => validateCaptureEvidence(noNegativeControl.evidence, noNegativeControl.context), /no genuine first rejected visible short-span negative control/u);
});

test("rejects second-span policy, provenance, coordinate, and metric forgeries", () => {
  const blindClaim = evidenceFixture();
  blindClaim.evidence.independentDimensionCheck.blindValidation = true;
  assert.throws(() => validateCaptureEvidence(blindClaim.evidence, blindClaim.context), /expected-aware visible-pair search policy/u);

  const directCameraClaim = evidenceFixture();
  directCameraClaim.evidence.independentDimensionCheck.viewPreparation = "direct_camera_state_mutation";
  assert.throws(() => validateCaptureEvidence(directCameraClaim.evidence, directCameraClaim.context), /expected-aware visible-pair search policy/u);

  const reusedSession = evidenceFixture();
  reusedSession.evidence.independentDimensionCheck.pointA.sessionId = 1;
  reusedSession.evidence.independentDimensionCheck.pointB.sessionId = 1;
  reusedSession.evidence.independentDimensionCheck.pointA.pointId = "measurement-1-a";
  reusedSession.evidence.independentDimensionCheck.pointB.pointId = "measurement-1-b";
  assert.throws(() => validateCaptureEvidence(reusedSession.evidence, reusedSession.context), /fresh session distinct from calibration/u);

  const reusedRejectedSession = evidenceFixture();
  reusedRejectedSession.evidence.independentDimensionCheck.pointA.sessionId = 3;
  reusedRejectedSession.evidence.independentDimensionCheck.pointB.sessionId = 3;
  reusedRejectedSession.evidence.independentDimensionCheck.pointA.pointId = "measurement-3-a";
  reusedRejectedSession.evidence.independentDimensionCheck.pointB.pointId = "measurement-3-b";
  assert.throws(() => validateCaptureEvidence(reusedRejectedSession.evidence, reusedRejectedSession.context), /fresh session distinct from calibration/u);

  const wrongAsset = evidenceFixture();
  wrongAsset.evidence.independentDimensionCheck.pointB.assetId = "ra_wrong";
  assert.throws(() => validateCaptureEvidence(wrongAsset.evidence, wrongAsset.context), /not bound to the imported Reality asset/u);

  const coordinateForgery = evidenceFixture();
  coordinateForgery.evidence.independentDimensionCheck.pointB.x = 0.15;
  assert.throws(() => validateCaptureEvidence(coordinateForgery.evidence, coordinateForgery.context), /source distance does not match/u);

  const metricForgery = evidenceFixture();
  metricForgery.evidence.independentDimensionCheck.measuredM = 0.322;
  metricForgery.evidence.independentDimensionCheck.residualM = 0;
  assert.throws(() => validateCaptureEvidence(metricForgery.evidence, metricForgery.context), /does not equal source distance times/u);

  const expectedForgery = evidenceFixture();
  expectedForgery.evidence.independentDimensionCheck.expectedM = 0.157;
  assert.throws(() => validateCaptureEvidence(expectedForgery.evidence, expectedForgery.context), /expected width differs/u);

  const toleranceForgery = evidenceFixture();
  toleranceForgery.evidence.independentDimensionCheck.toleranceM = 0.03;
  assert.throws(() => validateCaptureEvidence(toleranceForgery.evidence, toleranceForgery.context), /tolerance differs/u);
});

test("rejects source-bounds and all-axis calibrated AABB forgeries", () => {
  const boundsForgery = evidenceFixture();
  boundsForgery.evidence.assetImport.descriptor.sourceBounds.max.x += 0.01;
  assert.throws(() => validateCaptureEvidence(boundsForgery.evidence, boundsForgery.context), /differs from the verified PLY descriptor/u);

  const extentForgery = evidenceFixture();
  extentForgery.evidence.scanAabbComparison.calibratedScanAabbM.x = 0.322;
  assert.throws(() => validateCaptureEvidence(extentForgery.evidence, extentForgery.context), /not the calibrated verified source extent/u);

  const toleranceForgery = evidenceFixture();
  toleranceForgery.evidence.scanAabbComparison.toleranceM.z = 0.03;
  assert.throws(() => validateCaptureEvidence(toleranceForgery.evidence, toleranceForgery.context), /tolerance differs from asset evidence/u);

  const exactClaim = evidenceFixture();
  exactClaim.evidence.scanAabbComparison.exactCatalogMatchClaimed = true;
  assert.throws(() => validateCaptureEvidence(exactClaim.evidence, exactClaim.context), /without claiming an exact catalog match/u);
});

test("rejects Agent raw-pixel access and a missing safe proxy relation", () => {
  const raw = evidenceFixture();
  raw.evidence.agentReadback.rawPixelsExposed = true;
  assert.throws(() => validateCaptureEvidence(raw.evidence, raw.context), /must not expose raw splats, pixels, or source GLB/u);
  const unlinked = evidenceFixture();
  unlinked.evidence.agentReadback.semanticProxyIds = [];
  assert.throws(() => validateCaptureEvidence(unlinked.evidence, unlinked.context), /semanticProxyIds/u);
});

test("rejects non-atomic collision or Gaussian-owned collision", () => {
  const nonAtomic = evidenceFixture();
  nonAtomic.evidence.collision.revisionAfterRejection = 11;
  assert.throws(() => validateCaptureEvidence(nonAtomic.evidence, nonAtomic.context), /atomically/u);
  const gaussian = evidenceFixture();
  gaussian.evidence.collision.realityColliderEnabled = true;
  assert.throws(() => validateCaptureEvidence(gaussian.evidence, gaussian.context), /only to the proxy/u);
  const conflict = evidenceFixture();
  conflict.evidence.collision.preflightConflicts[0].leftId = "CMP_REALITY_SCAN";
  assert.throws(() => validateCaptureEvidence(conflict.evidence, conflict.context), /does not involve the semantic proxy|incorrectly participated/u);
});

test("rejects numeric-edit, reopen, model-publication, and USDA forgeries", () => {
  const edit = evidenceFixture();
  edit.evidence.numericEdit.readbackAfterM = 0.008;
  assert.throws(() => validateCaptureEvidence(edit.evidence, edit.context), /not preserved/u);
  const reopen = evidenceFixture();
  reopen.evidence.persistence.reopenedRevision = 14;
  assert.throws(() => validateCaptureEvidence(reopen.evidence, reopen.context), /Save\/reopen/u);
  const model = evidenceFixture();
  model.evidence.model.publishedSubtree.containsReality = true;
  assert.throws(() => validateCaptureEvidence(model.evidence, model.context), /exclude Gaussian Reality/u);
  const proxyMasqueradingAsCase = evidenceFixture();
  proxyMasqueradingAsCase.evidence.model.sourceRootId = "CMP_CASE_PROXY";
  assert.throws(() => validateCaptureEvidence(proxyMasqueradingAsCase.evidence, proxyMasqueradingAsCase.context), /distinguished from the semantic proxy/u);
  const fnvMismatch = evidenceFixture();
  fnvMismatch.evidence.model.toolDigest = "fnv1a32:00000000";
  assert.throws(() => validateCaptureEvidence(fnvMismatch.evidence, fnvMismatch.context), /FNV tool digest/u);
  const shaMismatch = evidenceFixture();
  shaMismatch.evidence.model.contentSha256 = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateCaptureEvidence(shaMismatch.evidence, shaMismatch.context), /canonical SHA-256/u);
  const payloadTamper = evidenceFixture();
  payloadTamper.evidence.model.canonicalDefinition.nodes[0].nodeId = "tampered-node";
  assert.throws(() => validateCaptureEvidence(payloadTamper.evidence, payloadTamper.context), /tool digest does not match canonical definition content/u);
  const usda = evidenceFixture();
  usda.evidence.exports.usda.usdchecker.exitCode = 1;
  assert.throws(() => validateCaptureEvidence(usda.evidence, usda.context), /usdchecker did not exit successfully/u);
  const staleUsda = evidenceFixture();
  staleUsda.context.usdaModifiedMs += 60_000;
  assert.throws(() => validateCaptureEvidence(staleUsda.evidence, staleUsda.context), /filesystem timestamp/u);
  const wrongRun = evidenceFixture();
  wrongRun.evidence.exports.usda.captureRunId = "another-reality-run";
  assert.throws(() => validateCaptureEvidence(wrongRun.evidence, wrongRun.context), /different capture run/u);
});

test("capture-sample gate accepts evolving imagery and rejects flat or frozen sequences", () => {
  const frameSize = 32;
  const frameCount = 60;
  const evolving = Buffer.alloc(frameSize * frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let index = 0; index < frameSize; index += 1) evolving[frame * frameSize + index] = 20 + ((index * 7 + frame * 2) % 200);
  }
  const result = analyzeCaptureSamples(evolving, frameSize, frameCount, "evolving");
  assert.ok(result.uniqueFrames >= 3);
  assert.ok(result.changedTransitions >= 3);
  assert.throws(() => analyzeCaptureSamples(Buffer.alloc(frameSize * frameCount, 90), frameSize, frameCount, "flat"), /visually flat/u);
  const frozenFrame = Buffer.from(Array.from({ length: frameSize }, (_, index) => 20 + index * 5));
  assert.throws(() => analyzeCaptureSamples(Buffer.concat(Array.from({ length: frameCount }, () => frozenFrame)), frameSize, frameCount, "frozen"), /lacks source-frame evolution/u);
});

test("capture manifest enforces all 690 exact contiguous 1920x1080 JPEG paths", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-manifest-"));
  try {
    const contract = clone(visualContract);
    contract.source.assetRoot = "captures";
    for (const [folder, count] of Object.entries(captureFolders)) {
      const directory = join(temporary, "captures", folder);
      mkdirSync(directory, { recursive: true });
      for (let frame = 0; frame < count; frame += 1) {
        writeFileSync(join(directory, `frame-${String(frame).padStart(4, "0")}.jpg`), minimalJpeg());
      }
    }
    const manifest = computeCaptureManifest(temporary, contract, { analyzeFrames: false });
    assert.equal(manifest.fileCount, 690);
    unlinkSync(join(temporary, "captures", "orbit-frames", "frame-0059.jpg"));
    assert.throws(() => computeCaptureManifest(temporary, contract, { analyzeFrames: false }), /exactly 60 contiguous/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("media contract accepts silent or AAC delivery and rejects other audio codecs", () => {
  const expected = { width: 1920, height: 1080, durationFrames: 960, durationSeconds: 32 };
  assert.equal(validateMediaProbe(mediaProbe(), expected).audio, null);
  assert.equal(validateMediaProbe(mediaProbe({ audio: { codec_name: "aac" } }), expected).audio.codec_name, "aac");
  assert.throws(() => validateMediaProbe(mediaProbe({ audio: { codec_name: "mp3" } }), expected), /must be AAC/u);
  const wrongFrames = mediaProbe();
  wrongFrames.streams[0].nb_read_frames = "959";
  assert.throws(() => validateMediaProbe(wrongFrames, expected), /frame count/u);
});

test("black and frozen video gates fail closed", () => {
  const good = {
    blackSampleCount: 0,
    maxBlackRunSeconds: 0,
    maxFrozenRunSeconds: 1,
    meanLuma: { average: 80, minimum: 40, maximum: 130 },
    minimumFrameStandardDeviation: 12,
  };
  assert.equal(validateLumaAnalysis(good), good);
  assert.throws(() => validateLumaAnalysis({ ...good, blackSampleCount: 1 }), /black run/u);
  assert.throws(() => validateLumaAnalysis({ ...good, maxFrozenRunSeconds: 2.3 }), /frozen run/u);
  assert.throws(() => validateLumaAnalysis({ ...good, meanLuma: { average: 80, minimum: 79, maximum: 81 } }), /visual evolution/u);
});

test("rendered media must not predate contract, capture, or evidence dependencies", () => {
  assert.doesNotThrow(() => assertArtifactFreshness({
    label: "demo.mp4",
    artifactModifiedMs: 200,
    dependencies: [{ label: "capture frame", modifiedMs: 150 }, { label: "contract", modifiedMs: 199 }],
  }));
  assert.throws(() => assertArtifactFreshness({
    label: "demo.mp4",
    artifactModifiedMs: 198,
    dependencies: [{ label: "capture frame", modifiedMs: 150 }, { label: "contract", modifiedMs: 199 }],
  }), /predates contract/u);
});

test("verification receipts bind the capture run and exact capture-evidence bytes at top level", () => {
  const evidenceBytes = Buffer.from('{"captureRunId":"reality-twin-run-receipt"}\n');
  const receipt = buildVerificationReceipt({
    captureRunId: "reality-twin-run-receipt",
    captureEvidenceSha256: sha256(evidenceBytes),
    verifiedAt: "2026-08-22T12:30:00.000Z",
    contract: {},
    registration: {},
    provenance: {},
    evidence: {},
    captures: {},
    captions: {},
    usdchecker: {},
    media: {},
    claimBoundary: {},
  });

  assert.equal(receipt.captureRunId, "reality-twin-run-receipt");
  assert.equal(receipt.captureEvidenceSha256, sha256(evidenceBytes));
  assert.equal(Object.hasOwn(receipt, "captureRunId"), true);
  assert.equal(Object.hasOwn(receipt, "captureEvidenceSha256"), true);
  assert.throws(() => buildVerificationReceipt({
    ...receipt,
    captureEvidenceSha256: fixedSha("z"),
  }), /concrete lowercase SHA-256/u);
  assert.throws(() => buildVerificationReceipt({
    ...receipt,
    captureRunId: "short",
  }), /captureRunId is missing/u);
});

test("atomic receipt writes replace the old receipt without leaving a temporary file", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-receipt-"));
  try {
    const artifacts = join(temporary, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const receiptPath = verificationReceiptPath(temporary);
    writeFileSync(receiptPath, '{"result":"passed","captureRunId":"stale-run"}\n');
    const next = {
      format: "semaframe-reality-twin-v1-verification",
      version: 1,
      result: "passed",
      captureRunId: "reality-twin-run-fresh",
      captureEvidenceSha256: fixedSha("a"),
    };

    assert.equal(writeVerificationReceiptAtomic(temporary, next), receiptPath);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), next);
    assert.deepEqual(readdirSync(artifacts).filter((name) => name.includes(".tmp-")), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a failed CLI verification removes a stale passed receipt before dependency checks", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-failed-cli-"));
  try {
    const receiptPath = verificationReceiptPath(temporary);
    mkdirSync(join(temporary, "artifacts"), { recursive: true });
    writeFileSync(receiptPath, '{"result":"passed","captureRunId":"stale-run"}\n');

    const result = spawnSync(process.execPath, [resolve(root, "scripts/verify-reality-twin-v1.mjs")], {
      cwd: temporary,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /verification FAILED/u);
    assert.equal(existsSync(receiptPath), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("final verifier invokes the asset verifier in check-only mode and rejects protected-file mutation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-asset-check-only-"));
  try {
    const sourceDirectory = join(temporary, "artifacts/reality-twin/source");
    const plyPath = join(temporary, "artifacts/reality-twin/test.gaussian.ply");
    const verifierPath = join(temporary, "scripts/verify-reality-twin-asset.mjs");
    const protectedPath = join(temporary, "video/public/reality-twin/evidence.json");
    const previewPath = join(temporary, "artifacts/reality-twin/qa/spark-render.png");
    const projectPath = join(temporary, "artifacts/reality-twin/reality-twin.semaframe.json");
    const usdaPath = join(temporary, "artifacts/reality-twin/capture/reality-twin.usda");
    for (const directory of [sourceDirectory, join(temporary, "scripts"), join(temporary, "video/public/reality-twin"), join(temporary, "artifacts/reality-twin/qa")]) {
      mkdirSync(directory, { recursive: true });
    }
    mkdirSync(join(temporary, "artifacts/reality-twin/capture"), { recursive: true });
    const glbBytes = Buffer.from("fixture-glb");
    const plyBytes = Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 3\nend_header\nfixture");
    writeFileSync(join(sourceDirectory, "part.glb"), glbBytes);
    writeFileSync(plyPath, plyBytes);
    writeFileSync(verifierPath, "// fixture verifier\n");
    writeFileSync(protectedPath, "capture-bound-evidence");
    writeFileSync(projectPath, "capture-bound-project");
    writeFileSync(usdaPath, "capture-bound-usda");
    const previewBytes = Buffer.from("canonical-spark-preview");
    writeFileSync(previewPath, previewBytes);
    const minimalAssetEvidence = {
      retrieval: {
        source_files: [{ bytes: glbBytes.byteLength, sha256: sha256(glbBytes) }],
      },
      derivedAsset: {
        relativePath: "artifacts/reality-twin/test.gaussian.ply",
        byteLength: plyBytes.byteLength,
        splatCount: 3,
        sha256: sha256(plyBytes),
      },
      validation: {
        spark_browser_import: {
          screenshot: {
            relative_path: "artifacts/reality-twin/qa/spark-render.png",
            bytes: previewBytes.byteLength,
            sha256: sha256(previewBytes),
          },
        },
      },
    };

    let invoked;
    const result = verifyAssetFiles(temporary, minimalAssetEvidence, {
      protectedPaths: [protectedPath, projectPath, usdaPath],
      verifierRunner: (command, args) => {
        invoked = { command, args };
        return { stdout: '{"status":"passed","mode":"check-only"}\n' };
      },
    });
    assert.equal(invoked.command, process.execPath);
    assert.deepEqual(invoked.args, [verifierPath, "--check-only"]);
    assert.match(result.verifierOutput, /check-only/u);

    writeFileSync(previewPath, Buffer.alloc(previewBytes.byteLength, 0x78));
    assert.throws(() => verifyAssetFiles(temporary, minimalAssetEvidence, {
      protectedPaths: [protectedPath, projectPath, usdaPath],
      verifierRunner: () => {
        throw new Error("asset verifier must not run after a canonical-preview integrity failure");
      },
    }), /Canonical Spark preview digest differs from asset evidence/u);
    writeFileSync(previewPath, previewBytes);

    assert.throws(() => verifyAssetFiles(temporary, minimalAssetEvidence, {
      protectedPaths: [protectedPath, projectPath, usdaPath],
      verifierRunner: () => {
        const before = statSync(projectPath).mtimeMs;
        utimesSync(projectPath, new Date(before + 10_000), new Date(before + 10_000));
        return { stdout: "passed" };
      },
    }), /mutated protected dependency/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("truth-copy gate rejects photos-to-CAD and Gaussian collision claims", () => {
  assert.doesNotThrow(() => assertTruthfulCopy("Smithsonian museum GLB scan converted offline; proxy owns collision."));
  assert.throws(() => assertTruthfulCopy("Photos to CAD inside SemaFrame"), /unsupported claim/u);
  assert.throws(() => assertTruthfulCopy("Gaussian representation owns collision"), /unsupported claim/u);
});
