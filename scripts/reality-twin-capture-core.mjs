import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const CAPTURE_EVIDENCE_FORMAT = "semaframe-reality-twin-capture-evidence";
export const CAPTURE_EVIDENCE_VERSION = 1;

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseProcessTable(text) {
  invariant(typeof text === "string", "Process table must be text.");
  return text.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    }];
  });
}

export function profileRelatedProcessIds(rows, profile) {
  invariant(Array.isArray(rows), "Process rows must be an array.");
  invariant(typeof profile === "string" && profile.length > 0, "Browser profile path is required.");
  const exactArgument = `--user-data-dir=${profile}`;
  const roots = new Set(rows
    .filter((row) => typeof row?.command === "string" && row.command.includes(exactArgument))
    .map((row) => row.pid));
  const related = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!related.has(row.ppid) || related.has(row.pid)) continue;
      related.add(row.pid);
      changed = true;
    }
  }
  return [...related].filter((pid) => Number.isSafeInteger(pid) && pid > 0).sort((a, b) => a - b);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function stableCanonicalJson(value) {
  const canonicalize = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]));
    }
    invariant(candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
      || (typeof candidate === "number" && Number.isFinite(candidate)),
    "Canonical model payload contains a non-JSON value.");
    return candidate;
  };
  return JSON.stringify(canonicalize(value));
}

export function fnv1a32(value) {
  const input = stableCanonicalJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

export function publishedModelReceipts(definition) {
  const payload = requiredObject(definition, "canonical published model definition");
  const { digest, ...content } = payload;
  invariant(/^fnv1a32:[a-f0-9]{8}$/u.test(digest ?? ""), "Published model tool digest is invalid.");
  const toolDigest = fnv1a32(content);
  invariant(toolDigest === digest, "Published model tool digest does not match canonical definition content.");
  return Object.freeze({
    toolDigest,
    contentSha256: sha256(Buffer.from(stableCanonicalJson(payload), "utf8")),
  });
}

export function resolveCaptureOutputPlan(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? ".");
  const publicRoot = join(repositoryRoot, "video/public/reality-twin");
  const smoke = options.smokeFrameCount !== undefined;
  const runId = String(options.runId ?? "unscoped").replace(/[^a-z0-9._-]+/giu, "-");
  const stagingRoot = smoke
    ? join(repositoryRoot, "artifacts/reality-twin/smoke-capture")
    : join(repositoryRoot, "artifacts/reality-twin/capture-staging", runId);
  const captureRoot = smoke
    ? stagingRoot
    : join(stagingRoot, "public");
  return Object.freeze({
    smoke,
    runId,
    publicRoot,
    stagingRoot,
    captureRoot,
    artifactRoot: join(stagingRoot, "run-artifacts"),
    canonicalArtifactRoot: join(repositoryRoot, "artifacts/reality-twin/capture"),
    evidencePath: join(publicRoot, "evidence.json"),
    stagedEvidencePath: join(captureRoot, "evidence.json"),
    verificationReceiptPath: join(repositoryRoot, "artifacts/semaframe-reality-twin-v1-verification.json"),
  });
}

export function prepareCaptureOutputs(plan) {
  invariant(plan?.captureRoot && plan?.artifactRoot, "Capture output plan is invalid.");
  rmSync(plan.stagingRoot, { recursive: true, force: true });
  if (!plan.smoke) {
    // A partial canonical run must never coexist with an earlier complete receipt.
    rmSync(plan.evidencePath, { force: true });
    rmSync(plan.verificationReceiptPath, { force: true });
  }
  mkdirSync(plan.captureRoot, { recursive: true });
  mkdirSync(plan.artifactRoot, { recursive: true });
  return plan;
}

export function chromeGpuArguments(options = {}) {
  const platform = options.platform ?? process.platform;
  const override = options.angleBackend ?? process.env.REALITY_TWIN_CHROME_ANGLE_BACKEND;
  const args = [
    "--disable-gpu-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
  ];
  if (override !== undefined && override !== "" && override !== "auto") {
    invariant(/^[a-z0-9_-]+$/iu.test(override), "REALITY_TWIN_CHROME_ANGLE_BACKEND contains unsupported characters.");
    args.push(`--use-angle=${override}`);
  } else if (platform === "darwin") {
    args.push("--use-angle=metal");
  }
  return Object.freeze(args);
}

export function writeFileAtomically(path, contents, token = process.pid) {
  const temporaryPath = `${path}.tmp-${String(token).replace(/[^a-z0-9._-]+/giu, "-")}`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, path);
  return path;
}

export function promoteCaptureOutputs(plan, assetEvidencePath) {
  invariant(plan && plan.smoke === false, "Only a full capture can be promoted.");
  invariant(existsSync(plan.captureRoot), "Staged capture directory is missing.");
  invariant(existsSync(plan.artifactRoot), "Staged capture artifact directory is missing.");
  invariant(existsSync(plan.stagedEvidencePath), "Validated staged evidence is missing.");
  invariant(existsSync(assetEvidencePath), "Asset evidence is missing during promotion.");
  copyFileSync(assetEvidencePath, join(plan.captureRoot, "asset-evidence.json"));

  const targets = [
    { source: plan.artifactRoot, destination: plan.canonicalArtifactRoot },
    { source: plan.captureRoot, destination: plan.publicRoot },
  ].map((entry) => ({
    ...entry,
    backup: `${entry.destination}.backup-${plan.runId}`,
    hadDestination: existsSync(entry.destination),
    promoted: false,
  }));

  try {
    for (const target of targets) {
      rmSync(target.backup, { recursive: true, force: true });
      if (target.hadDestination) renameSync(target.destination, target.backup);
    }
    for (const target of targets) {
      renameSync(target.source, target.destination);
      target.promoted = true;
    }
  } catch (error) {
    for (const target of [...targets].reverse()) {
      if (target.promoted && existsSync(target.destination) && !existsSync(target.source)) {
        renameSync(target.destination, target.source);
      }
      if (target.hadDestination && existsSync(target.backup) && !existsSync(target.destination)) {
        renameSync(target.backup, target.destination);
      }
    }
    throw error;
  }

  for (const target of targets) rmSync(target.backup, { recursive: true, force: true });
  rmSync(plan.stagingRoot, { recursive: true, force: true });
  return plan;
}

export function promoteCaptureOutputsAfterCleanup(
  plan,
  assetEvidencePath,
  options = {},
) {
  invariant(options.cleanupComplete === true,
    "A full Reality Twin capture cannot be promoted before cleanup completes.");
  const promote = options.promote ?? promoteCaptureOutputs;
  return promote(plan, assetEvidencePath);
}

export function loadRealityTwinFixture(
  path = resolve("scripts/fixtures/reality-twin-demo.fixture.json"),
) {
  const fixture = readJson(path);
  validateRealityTwinFixture(fixture);
  return fixture;
}

function finiteVector(candidate, label) {
  invariant(candidate && typeof candidate === "object", `${label} is missing.`);
  for (const axis of ["x", "y", "z"]) {
    invariant(Number.isFinite(candidate[axis]), `${label}.${axis} must be finite.`);
  }
}

export function vectorDistance(left, right) {
  finiteVector(left, "left point");
  finiteVector(right, "right point");
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function dimensionsFromBounds(bounds, scale = 1) {
  invariant(Number.isFinite(scale) && scale > 0, "Metric scale must be positive and finite.");
  finiteVector(bounds?.min, "bounds.min");
  finiteVector(bounds?.max, "bounds.max");
  const result = {};
  for (const axis of ["x", "y", "z"]) {
    invariant(bounds.min[axis] <= bounds.max[axis], `Bounds are reversed on ${axis}.`);
    result[axis] = (bounds.max[axis] - bounds.min[axis]) * scale;
  }
  return result;
}

export function maximumDimensionDelta(actual, expected) {
  finiteVector(actual, "actual dimensions");
  finiteVector(expected, "expected dimensions");
  return Math.max(...["x", "y", "z"].map((axis) => Math.abs(actual[axis] - expected[axis])));
}

/** Residuals in evidence are always observed minus expected; tolerance uses magnitude. */
export function signedDimensionResidual(observed, expected) {
  finiteVector(observed, "observed dimensions");
  finiteVector(expected, "expected dimensions");
  return Object.fromEntries(["x", "y", "z"].map((axis) => [axis, observed[axis] - expected[axis]]));
}

export function dimensionResidualWithin(residual, tolerance) {
  finiteVector(residual, "dimension residual");
  finiteVector(tolerance, "dimension residual tolerance");
  return ["x", "y", "z"].every((axis) => Math.abs(residual[axis]) <= tolerance[axis] + 1e-12);
}

export function protectiveCaseGeometry(fixture, artifactDimensions = fixture.physicalTruth.proxyDimensionsM) {
  validateRealityTwinFixture(fixture);
  finiteVector(artifactDimensions, "protective-case artifact dimensions");
  const artifact = artifactDimensions;
  const clearance = fixture.workspace.case.clearanceM;
  const thickness = fixture.workspace.case.glassThicknessM;
  const inner = {
    x: artifact.x + clearance * 2,
    y: artifact.y + clearance,
    z: artifact.z + clearance * 2,
  };
  const outer = {
    x: inner.x + thickness * 2,
    y: inner.y + thickness,
    z: inner.z + thickness * 2,
  };
  return Object.freeze({
    inner: Object.freeze(inner),
    outer: Object.freeze(outer),
    panels: Object.freeze({
      left: Object.freeze({
        center: Object.freeze({ x: -(inner.x + thickness) / 2, y: inner.y / 2, z: 0 }),
        sizeM: Object.freeze({ x: thickness, y: inner.y, z: outer.z }),
      }),
      right: Object.freeze({
        center: Object.freeze({ x: (inner.x + thickness) / 2, y: inner.y / 2, z: 0 }),
        sizeM: Object.freeze({ x: thickness, y: inner.y, z: outer.z }),
      }),
      front: Object.freeze({
        center: Object.freeze({ x: 0, y: inner.y / 2, z: -(inner.z + thickness) / 2 }),
        sizeM: Object.freeze({ x: outer.x, y: inner.y, z: thickness }),
      }),
      back: Object.freeze({
        center: Object.freeze({ x: 0, y: inner.y / 2, z: (inner.z + thickness) / 2 }),
        sizeM: Object.freeze({ x: outer.x, y: inner.y, z: thickness }),
      }),
      top: Object.freeze({
        center: Object.freeze({ x: 0, y: inner.y + thickness / 2, z: 0 }),
        sizeM: Object.freeze({ x: outer.x, y: thickness, z: outer.z }),
      }),
    }),
  });
}

export function validateRealityTwinFixture(fixture) {
  invariant(fixture?.format === "semaframe-reality-twin-capture-fixture", "Unexpected Reality Twin fixture format.");
  invariant(fixture.version === 1, "Unsupported Reality Twin fixture version.");
  invariant(fixture.sceneKey === "reality-twin", "Reality Twin fixture scene key drifted.");
  invariant(fixture.subject?.sourceDerivation === "smithsonian_glb_scan_to_gaussian_ply", "Fixture must record the GLB-scan to Gaussian-PLY derivation.");
  invariant(fixture.subject?.nativeGaussianCapture === false, "Fixture must not claim a native Gaussian capture.");
  const gaussian = fixture.gaussian;
  invariant(gaussian?.format === "ply" && gaussian.mediaType === "application/ply", "Reality Twin delivery asset must be PLY.");
  invariant(gaussian.assetEvidenceSchema === "semaframe.reality-twin-asset-evidence.v1", "Asset evidence schema drifted.");
  invariant(Number.isSafeInteger(gaussian.minimumSplatCount) && gaussian.minimumSplatCount >= 1_500_000, "Delivery splat floor is invalid.");
  const physical = fixture.physicalTruth;
  finiteVector(physical?.catalogDimensionsM, "physicalTruth.catalogDimensionsM");
  finiteVector(physical?.proxyDimensionsM, "physicalTruth.proxyDimensionsM");
  finiteVector(physical?.scanResidualToleranceM, "physicalTruth.scanResidualToleranceM");
  invariant(physical.calibration?.axis === "y" && physical.calibration.knownDistanceM === physical.catalogDimensionsM.y, "Height calibration must use the published catalog height.");
  invariant(physical.calibration.minimumAcceptedSourceSpanM > 0
    && physical.calibration.maximumAcceptedSourceSpanM > physical.calibration.minimumAcceptedSourceSpanM,
  "Calibration source-span acceptance range is invalid.");
  const caseSpec = fixture.workspace?.case;
  invariant(Number.isFinite(caseSpec?.clearanceM) && caseSpec.clearanceM > 0, "Case clearance is invalid.");
  invariant(Number.isFinite(caseSpec?.glassThicknessM) && caseSpec.glassThicknessM > 0, "Glass thickness is invalid.");
  invariant(Array.isArray(fixture.requiredGates) && fixture.requiredGates.includes("usdchecker_exit_zero"), "usdchecker is not a required capture gate.");
  return fixture;
}

export function resolveCaptureAsset(options = {}) {
  const assetPath = resolve(options.assetPath
    ?? process.env.SEMAFRAME_REALITY_TWIN_PLY
    ?? "artifacts/reality-twin/late-shang-gong.gaussian.ply");
  const assetEvidencePath = resolve(options.assetEvidencePath
    ?? process.env.SEMAFRAME_REALITY_TWIN_ASSET_EVIDENCE
    ?? "video/public/reality-twin/asset-evidence.json");
  invariant(existsSync(assetPath), [
    `Reality Twin Gaussian is missing: ${assetPath}`,
    "Run scripts/prepare-reality-twin-asset.mjs first, or set SEMAFRAME_REALITY_TWIN_PLY.",
    "The capture intentionally has no procedural delivery fallback because that would misstate the source scan.",
  ].join("\n"));
  invariant(existsSync(assetEvidencePath), [
    `Reality Twin asset evidence is missing: ${assetEvidencePath}`,
    "Run the asset preparation and verification pipeline before browser capture.",
  ].join("\n"));
  const bytes = readFileSync(assetPath);
  const assetEvidence = readJson(assetEvidencePath);
  const digest = sha256(bytes);
  invariant(assetEvidence?.schema === "semaframe.reality-twin-asset-evidence.v1", "Asset evidence schema is invalid.");
  invariant(Array.isArray(assetEvidence?.retrieval?.source_files)
    && assetEvidence.retrieval.source_files.length === 2
    && assetEvidence.retrieval.source_files.every((entry) => entry.format === "GLB 2.0"),
  "Asset evidence does not pin the two Smithsonian GLB scan parts.");
  invariant(assetEvidence?.conversion?.algorithm?.includes("triangle surface sampling"), "Asset evidence does not record the GLB-scan to Gaussian-PLY conversion.");
  invariant(assetEvidence?.conversion?.limitations?.some((line) => /not a native .*Gaussian capture/iu.test(line)), "Asset evidence overclaims a native Gaussian capture.");
  invariant(`sha256:${assetEvidence?.output?.sha256}` === digest, "Prepared PLY digest does not match asset evidence.");
  invariant(assetEvidence?.output?.bytes === bytes.byteLength, "Prepared PLY byte length does not match asset evidence.");
  invariant(assetEvidence?.conversion?.splat_count >= 1_500_000, "Prepared PLY does not meet the delivery splat floor.");
  invariant(assetEvidence?.validation?.status === "passed", "Prepared PLY has not passed the asset verification gate.");
  return Object.freeze({ assetPath, assetEvidencePath, bytes, digest, assetEvidence });
}

export function resolveUsdChecker(explicitPath = process.env.SEMAFRAME_USDCHECKER) {
  const candidates = [explicitPath, "/usr/bin/usdchecker", "/usr/local/bin/usdchecker", "/opt/homebrew/bin/usdchecker"]
    .filter(Boolean);
  const checker = candidates.find((candidate) => existsSync(candidate));
  invariant(checker, "usdchecker is required. Set SEMAFRAME_USDCHECKER to an executable OpenUSD checker.");
  return checker;
}

export function runUsdChecker(usdaPath, checker = resolveUsdChecker()) {
  invariant(existsSync(usdaPath), `USDA artifact is missing: ${usdaPath}`);
  const result = spawnSync(checker, [usdaPath], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const receipt = Object.freeze({
    executable: checker,
    arguments: Object.freeze([usdaPath]),
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
  invariant(!result.error, `usdchecker could not run: ${result.error?.message}`);
  invariant(result.status === 0, `usdchecker rejected the USDA artifact:\n${receipt.stdout}\n${receipt.stderr}`);
  return receipt;
}

function requiredObject(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} is missing.`);
  return value;
}

export function validateCaptureEvidence(evidence, fixture = loadRealityTwinFixture()) {
  requiredObject(evidence, "capture evidence");
  invariant(evidence.format === CAPTURE_EVIDENCE_FORMAT, "Unexpected capture evidence format.");
  invariant(evidence.version === CAPTURE_EVIDENCE_VERSION, "Unsupported capture evidence version.");
  invariant(evidence.status === "complete", "Capture evidence is not complete.");
  invariant(typeof evidence.captureRunId === "string" && evidence.captureRunId.startsWith("reality-twin-"), "Capture run ID is missing.");
  invariant(Number.isFinite(Date.parse(evidence.startedAt)) && Number.isFinite(Date.parse(evidence.completedAt))
    && Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt), "Capture timestamps are invalid.");
  invariant(evidence.source?.derivation === "smithsonian_glb_scan_to_gaussian_ply", "Capture evidence lost the GLB-to-PLY derivation.");
  invariant(evidence.source?.nativeGaussianCapture === false, "Capture evidence overclaims a native Gaussian capture.");
  invariant(evidence.agentExecution?.kind === "deterministic_authorized_mcp_client"
    && evidence.agentExecution.generativePlannerUsed === false
    && evidence.agentExecution.fixtureDriven === true,
  "Capture evidence overclaims generative Agent planning.");

  const imported = requiredObject(evidence.assetImport, "assetImport");
  invariant(imported.browserAuthoritative === true, "Asset import was not browser-authoritative.");
  invariant(imported.localBytesReady === true, "Asset import did not prove browser-local bytes ready.");
  invariant(imported.upload?.httpStatus === 200, "Asset upload did not return HTTP 200.");
  invariant(/^ra_[a-f0-9]{64}$/u.test(imported.assetRef?.assetId ?? ""), "Asset import receipt has no valid asset ID.");
  invariant(/^sha256:[a-f0-9]{64}$/u.test(imported.assetRef?.digest ?? ""), "Asset import receipt has no valid digest.");
  invariant(imported.descriptor?.engineeringAuthority === "visual_only", "Reality authority must remain visual_only.");
  const descriptorBounds = requiredObject(imported.descriptor?.sourceBounds, "assetImport.descriptor.sourceBounds");
  dimensionsFromBounds(descriptorBounds);

  const calibration = requiredObject(evidence.calibration, "calibration");
  invariant(calibration.measurementFidelity === "gaussian-lod", "Calibration was not measured on the Gaussian LOD surface.");
  invariant(calibration.blindValidation === false
    && calibration.selectionPolicy === "target_guided_visible_candidate_search_with_aabb_residual_gate"
    && Number.isSafeInteger(calibration.rejectedCandidateCount)
    && calibration.rejectedCandidateCount > 0,
  "Calibration candidate search policy or rejected-candidate receipt is missing.");
  invariant(Array.isArray(calibration.rejectedCandidates)
    && calibration.rejectedCandidates.length === calibration.rejectedCandidateCount,
  "Calibration rejected-candidate receipts do not match the rejected count.");
  for (const candidate of calibration.rejectedCandidates) {
    invariant(candidate?.accepted === false
      && candidate.measurementFidelity === "gaussian-lod"
      && Array.isArray(candidate.rejectionReasonCodes)
      && candidate.rejectionReasonCodes.length > 0,
    "Calibration rejected candidate is missing its genuine LOD rejection receipt.");
    finiteVector(candidate.pointA, "rejected calibration pointA");
    finiteVector(candidate.pointB, "rejected calibration pointB");
    finiteVector(candidate.sourceDelta, "rejected calibration sourceDelta");
    finiteVector(candidate.calibratedScanAabbM, "rejected calibration calibratedScanAabbM");
    finiteVector(candidate.catalogResidualM, "rejected calibration catalogResidualM");
    finiteVector(candidate.residualToleranceM, "rejected calibration residualToleranceM");
    invariant(candidate.pointA.pickedOnCurrentGaussianLod === true
      && candidate.pointB.pickedOnCurrentGaussianLod === true,
    "Rejected calibration pair was not picked on the current Gaussian LOD.");
    invariant(Number.isSafeInteger(candidate.pointA.sessionId)
      && candidate.pointA.sessionId > 0
      && candidate.pointA.sessionId === candidate.pointB.sessionId
      && candidate.pointA.pointId === `measurement-${candidate.pointA.sessionId}-a`
      && candidate.pointB.pointId === `measurement-${candidate.pointB.sessionId}-b`,
    "Rejected calibration pair has no genuine measurement-session identity.");
    invariant(candidate.pointA.assetId === imported.assetRef.assetId
      && candidate.pointB.assetId === imported.assetRef.assetId
      && candidate.pointA.assetDigest === imported.assetRef.digest
      && candidate.pointB.assetDigest === imported.assetRef.digest,
    "Rejected calibration pair is not bound to the imported Reality asset.");
    invariant(Number.isFinite(candidate.sourceDistance)
      && Math.abs(vectorDistance(candidate.pointA, candidate.pointB) - candidate.sourceDistance)
        <= Math.max(1e-6, candidate.sourceDistance * 1e-4),
    "Rejected calibration source distance does not match its live A/B points.");
    const actualSourceDelta = Object.fromEntries(["x", "y", "z"].map((axis) => [
      axis,
      Math.abs(candidate.pointA[axis] - candidate.pointB[axis]),
    ]));
    for (const axis of ["x", "y", "z"]) {
      invariant(Math.abs(candidate.sourceDelta[axis] - actualSourceDelta[axis]) <= 1e-9,
        `Rejected calibration sourceDelta.${axis} is not the actual A/B delta.`);
    }
    invariant(Number.isFinite(candidate.candidateMetersPerSourceUnit)
      && Math.abs(candidate.candidateMetersPerSourceUnit
        - (fixture.physicalTruth.calibration.knownDistanceM / candidate.sourceDistance)) <= 1e-6,
    "Rejected calibration scale does not equal known/source distance.");
    const expectedCandidateAabb = dimensionsFromBounds(descriptorBounds, candidate.candidateMetersPerSourceUnit);
    const expectedCandidateResidual = signedDimensionResidual(
      expectedCandidateAabb,
      fixture.physicalTruth.catalogDimensionsM,
    );
    for (const axis of ["x", "y", "z"]) {
      invariant(Math.abs(candidate.calibratedScanAabbM[axis] - expectedCandidateAabb[axis]) <= 1e-6,
        `Rejected calibration AABB ${axis} is not source extent times candidate scale.`);
      invariant(Math.abs(candidate.catalogResidualM[axis] - expectedCandidateResidual[axis]) <= 1e-6,
        `Rejected calibration catalog residual ${axis} is not observed-minus-catalog.`);
      invariant(Math.abs(candidate.residualToleranceM[axis] - fixture.physicalTruth.scanResidualToleranceM[axis]) <= 1e-12,
        `Rejected calibration residual tolerance ${axis} differs from the fixture.`);
    }
  }
  invariant(calibration.rejectedCandidates[0]?.controlKind === "visible_short_span"
    && calibration.rejectedCandidates.filter((candidate) => candidate.controlKind === "visible_short_span").length === 1
    && calibration.rejectedCandidates[0].sourceDistance < fixture.physicalTruth.calibration.minimumAcceptedSourceSpanM
    && calibration.rejectedCandidates[0].rejectionReasonCodes.includes("source_span_below_minimum"),
  "Calibration evidence has no genuine rejected visible short-span negative control.");
  invariant(calibration.measurementCompleted === true
    && calibration.appliedThroughInspectorUi === true
    && calibration.inputDriver === "automated_cdp_pointer_and_form_events"
    && calibration.humanInputClaimed === false
    && calibration.appliedThroughHumanUi === undefined,
  "Two-point calibration input-driver evidence is inaccurate.");
  invariant(calibration.assetDigest === imported.assetRef.digest, "Calibration is not bound to the imported asset digest.");
  invariant(Number.isFinite(calibration.sourceDistance)
    && calibration.sourceDistance >= fixture.physicalTruth.calibration.minimumAcceptedSourceSpanM
    && calibration.sourceDistance <= fixture.physicalTruth.calibration.maximumAcceptedSourceSpanM,
  "Measured source distance is outside the full-height acceptance range.");
  invariant(Number.isFinite(calibration.knownDistanceM) && calibration.knownDistanceM === fixture.physicalTruth.calibration.knownDistanceM, "Known height reference drifted.");
  invariant(Number.isFinite(calibration.metersPerSourceUnit) && calibration.metersPerSourceUnit > 0, "Applied metric scale is invalid.");
  for (const name of ["pointA", "pointB"]) {
    finiteVector(calibration[name], `calibration.${name}`);
    invariant(calibration[name].pickedOnCurrentGaussianLod === true, `${name} was not picked on the current Gaussian LOD.`);
    const role = name === "pointA" ? "a" : "b";
    invariant(Number.isSafeInteger(calibration[name].sessionId) && calibration[name].sessionId > 0
      && calibration[name].pointId === `measurement-${calibration[name].sessionId}-${role}`,
    `${name} has no measurement-session identity.`);
    invariant(calibration[name].assetId === imported.assetRef.assetId
      && calibration[name].assetDigest === imported.assetRef.digest,
    `${name} is not bound to the imported Reality asset.`);
  }
  invariant(calibration.pointA.sessionId === calibration.pointB.sessionId, "Calibration points came from different measurement sessions.");
  invariant(calibration.rejectedCandidates.every((candidate) => candidate.pointA.sessionId !== calibration.pointA.sessionId),
    "Rejected calibration control reused the accepted calibration session.");
  invariant(vectorDistance(calibration.pointA, calibration.pointB) > 0, "Calibration points overlap.");
  invariant(Math.abs(vectorDistance(calibration.pointA, calibration.pointB) - calibration.sourceDistance)
    <= Math.max(1e-6, calibration.sourceDistance * 1e-4),
  "Calibration source distance does not match its A/B points.");
  invariant(Math.abs(calibration.metersPerSourceUnit - (calibration.knownDistanceM / calibration.sourceDistance)) <= 1e-6,
    "Calibration scale does not equal known/source distance.");

  const scanAabb = requiredObject(evidence.scanAabbComparison, "scanAabbComparison");
  finiteVector(scanAabb.expectedCatalogM, "scanAabbComparison.expectedCatalogM");
  finiteVector(scanAabb.calibratedScanAabbM, "scanAabbComparison.calibratedScanAabbM");
  finiteVector(scanAabb.residualM, "scanAabbComparison.residualM");
  finiteVector(scanAabb.residualPercent, "scanAabbComparison.residualPercent");
  finiteVector(scanAabb.toleranceM, "scanAabbComparison.toleranceM");
  const expectedScanAabb = dimensionsFromBounds(descriptorBounds, calibration.metersPerSourceUnit);
  const expectedScanResidual = signedDimensionResidual(expectedScanAabb, fixture.physicalTruth.catalogDimensionsM);
  for (const axis of ["x", "y", "z"]) {
    invariant(Math.abs(scanAabb.expectedCatalogM[axis] - fixture.physicalTruth.catalogDimensionsM[axis]) <= 1e-12,
      `Scan AABB ${axis} catalog dimension drifted.`);
    invariant(Math.abs(scanAabb.calibratedScanAabbM[axis] - expectedScanAabb[axis]) <= 1e-6,
      `Scan AABB ${axis} is not source extent times applied scale.`);
    invariant(Math.abs(scanAabb.residualM[axis] - expectedScanResidual[axis]) <= 1e-6,
      `Scan AABB ${axis} residual is not observed-minus-catalog.`);
    invariant(Math.abs(scanAabb.residualPercent[axis]
      - (expectedScanResidual[axis] / fixture.physicalTruth.catalogDimensionsM[axis])) <= 1e-6,
    `Scan AABB ${axis} residual percent is inconsistent.`);
    invariant(Math.abs(scanAabb.toleranceM[axis] - fixture.physicalTruth.scanResidualToleranceM[axis]) <= 1e-12,
      `Scan AABB ${axis} tolerance differs from the fixture.`);
  }
  invariant(scanAabb.passed === dimensionResidualWithin(expectedScanResidual, scanAabb.toleranceM)
    && scanAabb.passed === true
    && scanAabb.exactCatalogMatchClaimed === false,
  "Scan AABB comparison did not truthfully pass the signed residual gate.");

  const dimensions = requiredObject(evidence.independentDimensionCheck, "independentDimensionCheck");
  invariant(dimensions.source === "live_calibrated_gaussian_measurement" && dimensions.displayedWithoutSubstitution === true,
    "Independent dimension check did not come from the displayed live Gaussian measurement.");
  invariant(dimensions.label === "second visible width pair"
    && dimensions.blindValidation === false
    && dimensions.selectionPolicy === "target_guided_visible_candidate_search"
    && dimensions.viewPreparation === "automated_canvas_orbit_pointer_events",
  "Second-span selection policy is missing or overstated as blind validation.");
  invariant(dimensions.passed === true, "Independent dimensions did not pass.");
  invariant(Number.isFinite(dimensions.sourceDistance) && dimensions.sourceDistance > 0,
    "Second-span source distance is invalid.");
  for (const key of ["expectedM", "measuredM", "residualM", "toleranceM"]) {
    invariant(Number.isFinite(dimensions[key]) && dimensions[key] >= 0, `Independent ${key} is invalid.`);
  }
  invariant(Math.abs(dimensions.residualM - Math.abs(dimensions.measuredM - dimensions.expectedM)) <= 1e-9, "Independent residual is inconsistent.");
  invariant(dimensions.residualM <= dimensions.toleranceM, "Independent residual exceeds tolerance.");
  finiteVector(dimensions.pointA, "independent pointA");
  finiteVector(dimensions.pointB, "independent pointB");
  invariant(dimensions.pointA.pickedOnCurrentGaussianLod === true && dimensions.pointB.pickedOnCurrentGaussianLod === true,
    "Independent pair was not picked on the current Gaussian LOD.");
  for (const name of ["pointA", "pointB"]) {
    const role = name === "pointA" ? "a" : "b";
    invariant(Number.isSafeInteger(dimensions[name].sessionId) && dimensions[name].sessionId > 0
      && dimensions[name].pointId === `measurement-${dimensions[name].sessionId}-${role}`,
    `Second-span ${name} has no measurement-session identity.`);
    invariant(dimensions[name].assetId === imported.assetRef.assetId
      && dimensions[name].assetDigest === imported.assetRef.digest,
    `Second-span ${name} is not bound to the imported Reality asset.`);
  }
  invariant(dimensions.pointA.sessionId === dimensions.pointB.sessionId, "Second-span points came from different sessions.");
  invariant(dimensions.pointA.sessionId !== calibration.pointA.sessionId, "Second-span session reused the calibration session.");
  invariant(Math.abs(vectorDistance(dimensions.pointA, dimensions.pointB) - dimensions.sourceDistance)
    <= Math.max(1e-6, dimensions.sourceDistance * 1e-4),
  "Second-span source distance does not match its A/B points.");
  invariant(dimensions.expectedM === fixture.physicalTruth.catalogDimensionsM.x,
    "Second-span expected width differs from the catalog fixture.");
  invariant(dimensions.toleranceM === fixture.physicalTruth.independentWidthToleranceM,
    "Second-span tolerance differs from the asset-evidence fixture.");
  invariant(Math.abs(dimensions.measuredM - (dimensions.sourceDistance * calibration.metersPerSourceUnit)) <= 1e-6,
    "Second-span result does not equal source distance times calibration scale.");
  invariant(dimensions.distinctFromCalibrationPair === true, "Independent dimensions reused the calibration pair.");
  invariant(dimensions.toleranceSource === fixture.physicalTruth.toleranceSource, "Independent tolerance source drifted.");

  const semantic = requiredObject(evidence.semanticProxy, "semanticProxy");
  invariant(semantic.linked === true && semantic.engineeringAuthority === "proxy", "Exact semantic proxy was not linked.");
  invariant(semantic.realityEngineeringAuthority === "visual_only", "Reality layer incorrectly became engineering authority.");
  invariant(semantic.exactGeometry === true, "Proxy exact-geometry evidence is missing.");
  invariant(maximumDimensionDelta(semantic.exactGeometryParameters?.sizeM, fixture.physicalTruth.proxyDimensionsM) <= 1e-12, "Proxy does not use exact catalog dimensions.");

  const collision = requiredObject(evidence.collision, "collision");
  invariant(collision.preflightValid === false, "Unsafe placement preflight was not rejected.");
  invariant(collision.rejectedBatchCode === "spatial_collision", "Unsafe batch was not rejected by spatial_collision.");
  invariant(collision.revisionBeforeRejection === collision.revisionAfterRejection, "Rejected batch changed Workspace revision.");
  invariant(collision.atomic === true, "Collision rejection was not recorded as atomic.");
  invariant(collision.proxyColliderEnabled === true && collision.realityColliderEnabled === false,
    "Collision authority was not restricted to the semantic proxy.");
  invariant(collision.correctedCollisionConflictCount === 0, "Corrected Workspace retains a collision conflict.");

  const edit = requiredObject(evidence.numericEdit, "numericEdit");
  invariant(edit.beforeM !== edit.afterM && edit.afterM === fixture.workspace.case.editedTopThicknessM, "Numeric case edit was not proven.");
  invariant(edit.undoRestoredBefore === true && edit.redoRestoredAfter === true, "Undo/redo did not preserve the numeric edit.");

  const persistence = requiredObject(evidence.persistence, "persistence");
  invariant(persistence.preserved === true, "Save/reopen did not preserve Workspace state.");
  invariant(persistence.savedRevision === persistence.reopenedRevision, "Reopened revision differs from saved revision.");
  invariant(persistence.savedComponentCount === persistence.reopenedComponentCount, "Reopened component count differs from saved state.");
  invariant(typeof persistence.projectPath === "string" && persistence.projectPath.startsWith("artifacts/reality-twin/"),
    "Saved project artifact path is missing.");

  const model = requiredObject(evidence.model, "model");
  invariant(model.modelId === fixture.workspace.modelId && model.version === fixture.workspace.modelVersion, "Published model identity drifted.");
  const modelReceipts = publishedModelReceipts(model.canonicalDefinition);
  invariant(model.digest === undefined
    && model.toolDigest === modelReceipts.toolDigest
    && model.contentSha256 === modelReceipts.contentSha256,
  "Published model FNV tool digest or canonical SHA-256 receipt is inconsistent.");
  invariant(model.canonicalDefinition.modelId === model.modelId
    && model.canonicalDefinition.version === model.version
    && model.canonicalDefinition.nodes?.length === model.nodeCount,
  "Canonical published model payload differs from the model receipt.");
  invariant(model.published === true && model.editableInstance === true && Number.isSafeInteger(model.nodeCount) && model.nodeCount >= 6, "Published case did not yield an editable multipart instance.");
  invariant(Number.isSafeInteger(model.publishedRevision) && model.publishedRevision > 0, "Published model revision is missing.");
  invariant(Array.isArray(model.publishedSubtreeTypes) && model.publishedSubtreeTypes.includes("model-assembly")
    && model.publishedSubtreeTypes.includes("spatial-primitive"), "Published subtree types are incomplete.");
  invariant(model.publishedSubtree?.excludesReality === true
    && model.publishedSubtree?.contentClass === "protective_case_model"
    && model.publishedSubtree?.containsReality === false
    && model.publishedSubtree?.proxyOnly === undefined,
    "Published model did not exclude the Gaussian Reality layer.");

  const usda = requiredObject(evidence.exports?.usda, "exports.usda");
  invariant(usda.validOpenUsd === true && /^sha256:[a-f0-9]{64}$/u.test(usda.sha256 ?? ""), "USDA export receipt is invalid.");
  invariant(usda.freshExport === true && usda.captureRunId === evidence.captureRunId, "USDA was not freshly exported by this capture run.");
  invariant(usda.sourceModelDigest === undefined
    && usda.sourceModelToolDigest === model.toolDigest
    && usda.sourceModelContentSha256 === model.contentSha256
    && usda.sourceWorkspaceRevision === model.publishedRevision,
  "USDA source model/revision receipt is inconsistent.");
  invariant(Number.isFinite(Date.parse(usda.exportedAt)), "USDA export timestamp is missing.");
  invariant(usda.usdchecker?.exitCode === 0, "usdchecker did not exit zero.");
  invariant(typeof usda.usdchecker?.stdout === "string", "usdchecker stdout receipt is missing.");

  invariant(evidence.captures?.viewport?.width === 1920 && evidence.captures?.viewport?.height === 1080
    && evidence.captures?.viewport?.fps === 30, "Capture viewport must be 1920x1080 at 30 fps.");
  invariant(evidence.captures?.browserGraphics?.api === "webgl2"
    && evidence.captures.browserGraphics.webgl2 === true
    && evidence.captures.browserGraphics.hardwareAccelerated === true
    && evidence.captures.browserGraphics.softwareRenderer === false
    && !/swiftshader|software/iu.test(`${evidence.captures.browserGraphics.vendor} ${evidence.captures.browserGraphics.renderer}`),
  "Capture browser did not prove a hardware-accelerated graphics path.");

  const frames = requiredObject(evidence.captures?.frameCounts, "captures.frameCounts");
  for (const sequence of fixture.capture.sequences) {
    invariant(frames[sequence] === fixture.capture.sequenceFrameCounts[sequence], `${sequence} frame evidence is incomplete.`);
  }
  return evidence;
}
