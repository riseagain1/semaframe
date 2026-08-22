import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  analyzeSampleBuffer,
  readTopLevelMp4Atoms,
} from "./verify-emergency-city-v3.mjs";
import {
  publishedModelReceipts,
  stableCanonicalJson,
} from "./reality-twin-capture-core.mjs";

const CONTRACT_PATH = "video/reality-twin-v1.visual-contract.json";
const COMPOSITION_PATH = "video/src/RealityTwinProofV1.tsx";
const ROOT_SOURCE_PATH = "video/src/Root.tsx";
const ASSET_EVIDENCE_PATH = "video/public/reality-twin/asset-evidence.json";
const CAPTURE_EVIDENCE_PATH = "video/public/reality-twin/evidence.json";
const CAPTURE_FIXTURE_PATH = "scripts/fixtures/reality-twin-demo.fixture.json";
const ASSET_VERIFIER_PATH = "scripts/verify-reality-twin-asset.mjs";
const RECEIPT_PATH = "artifacts/semaframe-reality-twin-v1-verification.json";
const MAX_BUFFER = 256 * 1024 * 1024;
const SAMPLE_FPS = 5;
const SAMPLE_LANDSCAPE = { width: 160, height: 90 };
const SAMPLE_VERTICAL = { width: 90, height: 160 };
const MAX_BLACK_RUN_SECONDS = 0.4;
const MAX_FROZEN_RUN_SECONDS = 2.2;
const EXPECTED_CAPTURE_FOLDERS = Object.freeze({
  "orbit-frames": 60,
  "import-frames": 60,
  "calibration-frames": 90,
  "verification-frames": 60,
  "spatial-read-frames": 60,
  "proxy-build-frames": 90,
  "proxy-edit-frames": 90,
  "export-frames": 60,
  "reopen-frames": 60,
  "final-frames": 60,
});
const EXPECTED_DELIVERIES = Object.freeze({
  landscape: Object.freeze({
    compositionId: "SemaFrameRealityTwinProofV1",
    componentExport: "SemaFrameRealityTwinProofV1",
    posterCompositionId: "SemaFrameRealityTwinProofV1Poster",
    posterComponentExport: "SemaFrameRealityTwinProofV1Poster",
    durationConstant: "REALITY_TWIN_PROOF_V1_LANDSCAPE_DURATION",
    width: 1920,
    height: 1080,
    fps: 30,
    durationFrames: 960,
    durationSeconds: 32,
  }),
  vertical: Object.freeze({
    compositionId: "SemaFrameRealityTwinProofV1Vertical",
    componentExport: "SemaFrameRealityTwinProofV1Vertical",
    posterCompositionId: "SemaFrameRealityTwinProofV1VerticalPoster",
    posterComponentExport: "SemaFrameRealityTwinProofV1VerticalPoster",
    durationConstant: "REALITY_TWIN_PROOF_V1_VERTICAL_DURATION",
    width: 1080,
    height: 1920,
    fps: 30,
    durationFrames: 900,
    durationSeconds: 30,
  }),
});
const REQUIRED_BEATS = Object.freeze([
  "hook",
  "product",
  "import",
  "calibrate",
  "verify",
  "bounds",
  "proxy",
  "edit",
  "export",
  "persist",
  "identity",
]);
const REQUIRED_ROOT_IMPORTS = Object.freeze([
  "REALITY_TWIN_PROOF_V1_LANDSCAPE_DURATION",
  "REALITY_TWIN_PROOF_V1_VERTICAL_DURATION",
  "SemaFrameRealityTwinProofV1",
  "SemaFrameRealityTwinProofV1Poster",
  "SemaFrameRealityTwinProofV1Vertical",
  "SemaFrameRealityTwinProofV1VerticalPoster",
]);

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateRealityTwinArtifactRelativePath(value, suffix, label) {
  invariant(typeof value === "string", `${label} is invalid.`);
  const segments = value.split("/");
  invariant(segments.length >= 3
    && segments[0] === "artifacts"
    && segments[1] === "reality-twin"
    && segments.slice(2).every((segment) => segment !== "."
      && segment !== ".."
      && /^[A-Za-z0-9._-]+$/u.test(segment))
    && segments.at(-1).length > suffix.length
    && segments.at(-1).endsWith(suffix),
  `${label} is invalid.`);
  return value;
}

export function resolveRealityTwinArtifactPath(root, value, suffix, label) {
  validateRealityTwinArtifactRelativePath(value, suffix, label);
  const artifactRoot = resolve(root, "artifacts/reality-twin");
  const path = resolve(root, value);
  const containedPath = relative(artifactRoot, path);
  invariant(containedPath !== ""
    && containedPath !== ".."
    && !containedPath.startsWith(`..${sep}`)
    && !isAbsolute(containedPath),
  `${label} escapes the Reality Twin artifact root.`);
  return path;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    timeout: options.timeout ?? 180_000,
  });
  invariant(!result.error, `${label} could not start: ${result.error?.message ?? "unknown error"}.`);
  invariant(result.status === 0, `${label} failed (${result.status}): ${String(result.stderr || result.stdout).trim()}`);
  return result;
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function snapshotProtectedFiles(paths) {
  return [...new Set(paths.map((path) => resolve(path)))].map((path) => {
    if (!existsSync(path)) return { path, exists: false };
    const stats = statSync(path, { bigint: true });
    invariant(stats.isFile(), `Protected dependency is not a file: ${path}.`);
    return {
      path,
      exists: true,
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      sha256: sha256File(path),
    };
  });
}

export function assertProtectedFilesUnchanged(snapshot) {
  invariant(Array.isArray(snapshot), "Protected dependency snapshot is missing.");
  for (const before of snapshot) {
    const after = snapshotProtectedFiles([before.path])[0];
    invariant(JSON.stringify(after) === JSON.stringify(before),
      `Asset check-only mutated protected dependency ${before.path}.`);
  }
  return snapshot;
}

export function verificationReceiptPath(root = process.cwd()) {
  return resolve(root, RECEIPT_PATH);
}

/** A new verification attempt may never inherit a previous passed receipt. */
export function invalidateVerificationReceipt(root = process.cwd()) {
  const path = verificationReceiptPath(root);
  if (existsSync(path)) unlinkSync(path);
  return path;
}

/** Write a complete receipt in one same-directory rename and clean failed temporaries. */
export function writeVerificationReceiptAtomic(root, receipt) {
  const path = verificationReceiptPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return path;
}

function normalizeSha256(value, label) {
  invariant(typeof value === "string", `${label} must be a SHA-256 string.`);
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  invariant(/^sha256:[0-9a-f]{64}$/u.test(normalized), `${label} must be a concrete lowercase SHA-256 value.`);
  return normalized;
}

function requiredObject(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} is missing.`);
  return value;
}

function finiteNumber(value, label, options = {}) {
  invariant(Number.isFinite(value), `${label} must be finite.`);
  if (options.positive) invariant(value > 0, `${label} must be positive.`);
  if (options.nonNegative) invariant(value >= 0, `${label} must be non-negative.`);
  return value;
}

function finiteVector(value, label) {
  requiredObject(value, label);
  for (const axis of ["x", "y", "z"]) finiteNumber(value[axis], `${label}.${axis}`);
  return value;
}

function vectorDistance(left, right) {
  finiteVector(left, "left point");
  finiteVector(right, "right point");
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function approximatelyEqual(left, right, tolerance = 1e-9) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

const CALIBRATION_REJECTION_REASON_CODES = Object.freeze([
  "source_span_below_minimum",
  "source_span_above_maximum",
  "source_y_not_dominant",
  "source_y_below_90_percent_of_aabb_height",
  "non_y_path_exceeds_ratio_limit",
  "source_span_differs_from_aabb_height",
  "implied_catalog_height_residual_exceeds_tolerance",
  "calibrated_scan_aabb_residual_exceeds_tolerance",
]);

function isoTimestamp(value, label) {
  invariant(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value), `${label} must be an ISO-8601 UTC timestamp.`);
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed), `${label} is invalid.`);
  return parsed;
}

function rectanglesIntersect(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function insideSafeArea(rect, delivery) {
  return rect.x >= delivery.safeArea.left
    && rect.y >= delivery.safeArea.top
    && rect.x + rect.width <= delivery.width - delivery.safeArea.right
    && rect.y + rect.height <= delivery.height - delivery.safeArea.bottom;
}

function expectedFrameNames(frameCount) {
  return Array.from({ length: frameCount }, (_, index) => `frame-${String(index).padStart(4, "0")}.jpg`);
}

function parseRequiredFrameRange(value, label) {
  const match = /^(\d{4})\.\.(\d{4})$/u.exec(value ?? "");
  invariant(match, `${label} must use a zero-padded ####..#### frame range.`);
  const first = Number(match[1]);
  const last = Number(match[2]);
  invariant(first === 0 && last >= first, `${label} must start at frame 0000.`);
  return last - first + 1;
}

function parseTimelineSource(value, label) {
  const match = /^([a-z0-9-]+):(\d+)\.\.(\d+)$/u.exec(value ?? "");
  invariant(match, `${label} has an invalid source frame range.`);
  const from = Number(match[2]);
  const to = Number(match[3]);
  invariant(to >= from, `${label} source frame range is reversed.`);
  return { folder: match[1], from, to };
}

export function assertTruthfulCopy(text, label = "Reality Twin copy") {
  const forbidden = [
    /(?:native|direct) Gaussian capture/iu,
    /(?:captured|reconstructed|trained) (?:inside|in) SemaFrame/iu,
    /photos? (?:to|into|→) (?:CAD|Gaussian|3D)/iu,
    /(?:survey|metrology|manufacturing|engineering) (?:accurate|grade|certified)/iu,
    /(?:complete|whole|entire) (?:scene|workspace).*OpenUSD/iu,
    /Gaussian(?: representation)? owns (?:collision|physics|engineering)/iu,
    /Agent (?:sees|reads|receives) (?:raw )?(?:pixels|splats|GLB)/iu,
  ];
  for (const pattern of forbidden) {
    invariant(!pattern.test(text), `${label} contains unsupported claim ${pattern}.`);
  }
}

export function validateVisualContract(contract, options = {}) {
  invariant(contract?.format === "semaframe-reality-twin-proof-visual-contract", "Reality Twin contract format is invalid.");
  invariant(contract.version === 1, "Reality Twin contract version must be 1.");
  invariant(contract.product === "SemaFrame Reality Twin Proof V1", "Reality Twin product identity changed.");
  invariant(contract.locale === "en-US", "Reality Twin V1 must remain English-only.");
  invariant(contract.status === "local_proof", "Reality Twin V1 must remain an explicitly local proof until publication is authorized.");
  invariant(contract.silentFirst === true && contract.audioRequiredForComprehension === false, "Reality Twin must remain silent-first with optional audio.");
  invariant(contract.narration === "none", "Reality Twin V1 must not require narration.");
  invariant(contract.source?.composition === COMPOSITION_PATH, "Reality Twin composition path changed.");
  invariant(contract.source?.assetRoot === "video/public/reality-twin", "Reality Twin capture root changed.");
  invariant(contract.source?.evidence === CAPTURE_EVIDENCE_PATH, "Reality Twin evidence path must be the aggregate evidence.json.");
  invariant(contract.source?.captureDimensions?.width === 1920 && contract.source.captureDimensions.height === 1080, "Reality Twin source captures must be 1920x1080.");
  invariant(JSON.stringify(Object.keys(contract.source.captureFolders)) === JSON.stringify(Object.keys(EXPECTED_CAPTURE_FOLDERS)), "Reality Twin capture-folder order or identity changed.");
  for (const [folder, count] of Object.entries(EXPECTED_CAPTURE_FOLDERS)) {
    const descriptor = contract.source.captureFolders[folder];
    invariant(parseRequiredFrameRange(descriptor?.requiredFrames, `${folder}.requiredFrames`) === count, `${folder} must declare exactly ${count} frames.`);
    invariant(typeof descriptor?.purpose === "string" && descriptor.purpose.length >= 24, `${folder} must state its evidence purpose.`);
  }
  invariant(JSON.stringify(contract.requiredBeats) === JSON.stringify(REQUIRED_BEATS), "Reality Twin beat order is frozen.");

  const boundary = requiredObject(contract.claimBoundary, "claimBoundary");
  for (const key of ["captureSource", "measurement", "verification", "agentVision", "engineeringAuthority", "precision", "export", "persistence", "certification"]) {
    invariant(typeof boundary[key] === "string" && boundary[key].length >= 30, `claimBoundary.${key} is incomplete.`);
    assertTruthfulCopy(boundary[key], `claimBoundary.${key}`);
  }
  invariant(/Smithsonian museum 3D scan/iu.test(boundary.captureSource) && /converted offline/iu.test(boundary.captureSource), "Capture boundary must identify the Smithsonian GLB scan and offline conversion.");
  invariant(/neither the GLB conversion nor reconstruction from photos or video/iu.test(boundary.captureSource), "Capture boundary must deny in-app conversion and reconstruction.");
  invariant(/visual estimate, not survey or CAD measurement/iu.test(boundary.measurement), "Measurement boundary must deny survey/CAD accuracy.");
  invariant(/capture automation/iu.test(boundary.measurement) && /same Inspector pointer controls available to a person/iu.test(boundary.measurement), "Measurement boundary must disclose automated use of the ordinary Inspector controls.");
  invariant(/second, distinct A\/B session/iu.test(boundary.verification) && /not a blind or metrological validation/iu.test(boundary.verification), "Second-span boundary must disclose the distinct expected-aware, non-blind check.");
  invariant(/deterministic authorized Agent run/iu.test(boundary.agentVision) && /no model-autonomy claim/iu.test(boundary.agentVision), "Agent boundary must disclose deterministic execution without model autonomy.");
  invariant(/visual evidence only/iu.test(boundary.engineeringAuthority) && /sole source of collision/iu.test(boundary.engineeringAuthority), "Proxy engineering authority boundary is missing.");
  invariant(/protective-case model only/iu.test(boundary.export) && /does not include the semantic proxy, Gaussian/iu.test(boundary.export), "Case-only OpenUSD boundary is missing.");

  for (const [variant, expected] of Object.entries(EXPECTED_DELIVERIES)) {
    const delivery = requiredObject(contract.delivery?.[variant], `delivery.${variant}`);
    for (const key of ["compositionId", "componentExport", "posterCompositionId", "posterComponentExport", "width", "height", "fps", "durationFrames", "durationSeconds"]) {
      invariant(delivery[key] === expected[key], `${variant} ${key} differs from the frozen delivery contract.`);
    }
    invariant(typeof delivery.captionPath === "string" && delivery.captionPath.endsWith(".en-US.srt"), `${variant} must declare one English SRT.`);
    invariant(typeof delivery.suggestedVideoPath === "string" && delivery.suggestedVideoPath.endsWith(".mp4"), `${variant} MP4 path is invalid.`);
    invariant(typeof delivery.suggestedPosterPath === "string" && delivery.suggestedPosterPath.endsWith(".png"), `${variant} poster path is invalid.`);
    invariant(Array.isArray(delivery.timeline) && delivery.timeline.length === REQUIRED_BEATS.length, `${variant} must contain all 11 beats.`);
    let cursor = 0;
    for (const [index, beat] of delivery.timeline.entries()) {
      invariant(beat.id === REQUIRED_BEATS[index], `${variant} beat ${index + 1} must be ${REQUIRED_BEATS[index]}.`);
      invariant(beat.from === cursor, `${variant} beat ${beat.id} must begin at frame ${cursor}.`);
      invariant(Number.isSafeInteger(beat.duration) && beat.duration >= 60, `${variant} beat ${beat.id} is too short for silent comprehension.`);
      const source = parseTimelineSource(beat.source, `${variant}.${beat.id}`);
      invariant(Object.hasOwn(EXPECTED_CAPTURE_FOLDERS, source.folder), `${variant}.${beat.id} references an unknown capture folder.`);
      invariant(source.to < EXPECTED_CAPTURE_FOLDERS[source.folder], `${variant}.${beat.id} references a missing source frame.`);
      if (beat.secondarySource !== undefined) {
        const secondary = parseTimelineSource(beat.secondarySource, `${variant}.${beat.id}.secondarySource`);
        invariant(Object.hasOwn(EXPECTED_CAPTURE_FOLDERS, secondary.folder), `${variant}.${beat.id} references an unknown secondary capture folder.`);
        invariant(secondary.to < EXPECTED_CAPTURE_FOLDERS[secondary.folder], `${variant}.${beat.id} references a missing secondary source frame.`);
        invariant(beat.transition === "crossfade-to-verified-result", `${variant}.${beat.id} must identify its result-first crossfade.`);
      } else {
        invariant(beat.transition === undefined, `${variant}.${beat.id} declares a transition without a secondary source.`);
      }
      cursor += beat.duration;
    }
    const hook = delivery.timeline[0];
    invariant(hook.source === "orbit-frames:0..47"
      && hook.secondarySource === "final-frames:0..47"
      && hook.transition === "crossfade-to-verified-result",
    `${variant} hook must crossfade the real scan orbit into the verified final result.`);
    invariant(delivery.timeline[1].source === "final-frames:12..59", `${variant} product beat must hold on the verified final result.`);
    invariant(delivery.timeline.slice(1).every((beat) => beat.secondarySource === undefined), `${variant} may only use a secondary capture source in the truth-declared hook.`);
    invariant(cursor === expected.durationFrames, `${variant} timeline must cover the complete composition.`);
    for (const [name, rect] of [
      ["title", delivery.titleBounds],
      ["proof", delivery.proofBounds],
      ["boundary note", delivery.boundaryNoteBounds],
    ]) {
      requiredObject(rect, `${variant} ${name} bounds`);
      invariant(insideSafeArea(rect, delivery), `${variant} ${name} leaves the declared safe area.`);
    }
    invariant(!rectanglesIntersect(delivery.titleBounds, delivery.proofBounds), `${variant} title and proof overlap.`);
    invariant(!rectanglesIntersect(delivery.proofBounds, delivery.boundaryNoteBounds), `${variant} proof and boundary note overlap.`);
    if (variant === "vertical") {
      invariant(delivery.safeArea.right >= 140 && delivery.safeArea.bottom >= 240, "Vertical delivery must reserve the social action rail and bottom caption zone.");
      invariant(JSON.stringify(delivery.heroBeats) === JSON.stringify(["hook", "product", "identity"]), "Vertical hero-board beat set changed.");
      requiredObject(delivery.heroBoard, "Vertical hero board");
      invariant(insideSafeArea(delivery.heroBoard, delivery), "Vertical hero board leaves the safe area.");
      invariant(!rectanglesIntersect(delivery.titleBounds, delivery.heroBoard), "Vertical title overlaps the hero board.");
      invariant(!rectanglesIntersect(delivery.heroBoard, delivery.proofBounds), "Vertical hero board overlaps the proof chip.");
      invariant(Array.isArray(delivery.evidenceBoards) && delivery.evidenceBoards.length === 2, "Vertical delivery must have independent full-capture and detail boards.");
      for (const board of delivery.evidenceBoards) invariant(insideSafeArea(board, delivery), `Vertical ${board.role} board leaves the safe area.`);
      invariant(!rectanglesIntersect(delivery.evidenceBoards[0], delivery.evidenceBoards[1]), "Vertical evidence boards overlap.");
      invariant(delivery.evidenceBoards.every((board) => !rectanglesIntersect(board, delivery.proofBounds)), "Vertical evidence board overlaps the proof chip.");
    }
  }
  invariant(Array.isArray(contract.truthGatesBeforeRender) && contract.truthGatesBeforeRender.length >= 13, "Reality Twin truth gates are incomplete.");

  if (options.compositionSource) {
    const source = options.compositionSource;
    for (const required of [
      "useCurrentFrame",
      "staticFile",
      "<Img",
      "premountFor={fps}",
      "A real 3D scan.",
      "Can an Agent work with it?",
      "SEMAFRAME LINKS SCANS",
      "Bring in the prepared museum scan",
      "Pick two points. Enter one known length.",
      "A second span checks the scale",
      "Now the Agent can read scale and placement",
      "The Agent creates an editable model around the scan",
      "Reusable. Collision-aware. Still editable.",
      "Send the reusable case model to other 3D tools",
      "Undo. Save. Reopen. Keep editing.",
      "Real-world context.",
      "SMITHSONIAN MUSEUM SCAN · PREPARED OFFLINE",
      "SCAN = VISUAL ONLY",
      "PROXY = EXACT GEOMETRY",
      "NOT SURVEY OR CAD MEASUREMENT",
      "A real scan.<br />",
      "An editable model built around it.",
      "data-calibration-receipt=\"non-spatial-summary\"",
      "REAL CAPTURE RECEIPT",
      "PICK ON LIVE GAUSSIAN SURFACE",
      "REAL A/B PICK RECEIPT",
      "KNOWN LENGTH APPLIED IN THE APP",
      "data-calibration-stage={stage}",
      "data-collision-receipt=\"captured-workspace-summary\"",
      "MODEL PUBLISHED",
      "COLLISION BLOCKED",
      "FIT CORRECTED · 40 MM",
      "8 → 10 MM · UNDO / REDO",
      "data-collision-stage={stage}",
      "CrossfadeCaptureImage",
      "secondarySource: {folder: \"final-frames\", fromFrame: 0, toFrame: 47}",
    ]) invariant(source.includes(required), `Reality Twin composition source is missing ${required}.`);
    invariant(!/const\s+CalibrationOverlay\b/gu.test(source), "Reality Twin must not restore the fixed-position CalibrationOverlay.");
    invariant(!/<svg[\s\S]*?(?:\bx1=|\bcx=)[\s\S]*?(?:>A<|>B<|A\/B)[\s\S]*?<\/svg>/gu.test(source), "Reality Twin must not draw fixed A/B SVG points or lines over the real capture.");
    const calibrationReceiptSource = /const CalibrationReceipt\b[\s\S]*?(?=\nconst VerificationOverlay\b)/u.exec(source)?.[0] ?? "";
    const editOverlaySource = /const EditOverlay\b[\s\S]*?(?=\nconst ExportOverlay\b)/u.exec(source)?.[0] ?? "";
    invariant(calibrationReceiptSource.includes("Math.ceil(duration / 3)")
      && calibrationReceiptSource.includes("Math.min(2, Math.floor(frame / segmentDuration))")
      && calibrationReceiptSource.includes("frame: frame - stage * segmentDuration"),
    "Reality Twin calibration receipt must follow the three real capture stages.");
    invariant(editOverlaySource.includes('folder: "proxy-edit-frames"')
      && editOverlaySource.includes("sourceFrame < 26 ? 0 : sourceFrame < 39 ? 1 : sourceFrame < 52 ? 2 : 3")
      && editOverlaySource.includes("const stageSourceStarts = [0, 26, 39, 52] as const")
      && editOverlaySource.includes("frame: frame - stageStart"),
    "Reality Twin edit overlay must follow the publish, blocked, corrected, and numeric-edit source-frame ranges.");
    invariant(!source.includes('proof: "COLLISION BLOCKED → FIT CORRECTED"'), "Reality Twin proof chip must not announce collision outcomes before the captured edit stage.");
    invariant(!source.includes("A/B PICK + KNOWN LENGTH APPLIED"), "Reality Twin calibration receipt must not announce Apply before the captured final stage.");
    invariant(!/(?:animation|transition)\s*:/gu.test(source) && !/@keyframes/gu.test(source), "Reality Twin source must not use CSS animations or transitions.");
    invariant(!/<img\b/gu.test(source), "Reality Twin source must use Remotion Img instead of native img.");
    assertTruthfulCopy(source, "Reality Twin composition source");
    for (const [variant, expected] of Object.entries(EXPECTED_DELIVERIES)) {
      invariant(source.includes(`export const ${expected.durationConstant} = ${expected.durationFrames};`), `${variant} duration constant is missing or stale.`);
      for (const component of [expected.componentExport, expected.posterComponentExport]) {
        invariant(new RegExp(`export const ${component}\\b`, "u").test(source), `${component} export is missing.`);
      }
    }
  }
  return {
    beatCount: REQUIRED_BEATS.length,
    captureFrameCount: Object.values(EXPECTED_CAPTURE_FOLDERS).reduce((sum, count) => sum + count, 0),
    landscapeFrames: contract.delivery.landscape.durationFrames,
    verticalFrames: contract.delivery.vertical.durationFrames,
  };
}

function jsxAttribute(block, name) {
  const braced = new RegExp(`\\b${name}=\\{([^}]+)\\}`, "u").exec(block)?.[1]?.trim();
  if (braced !== undefined) return braced;
  return new RegExp(`\\b${name}=["']([^"']+)["']`, "u").exec(block)?.[1]?.trim();
}

export function validateRootRegistrations(rootSource, contract) {
  const importMatches = [...rootSource.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/RealityTwinProofV1["'];?/gu)];
  invariant(importMatches.length === 1, "Root must import RealityTwinProofV1 exactly once.");
  const imports = importMatches[0][1].split(",").map((value) => value.trim()).filter(Boolean).sort();
  invariant(JSON.stringify(imports) === JSON.stringify([...REQUIRED_ROOT_IMPORTS].sort()), "Root RealityTwinProofV1 import set is not exact.");

  const tags = [...rootSource.matchAll(/<(Composition|Still)\b[\s\S]*?\/>/gu)].map((match) => ({ kind: match[1], source: match[0] }));
  for (const [variant, expected] of Object.entries(EXPECTED_DELIVERIES)) {
    const composition = tags.filter((tag) => jsxAttribute(tag.source, "id") === expected.compositionId);
    invariant(composition.length === 1, `${expected.compositionId} must be registered exactly once.`);
    invariant(composition[0].kind === "Composition", `${expected.compositionId} must be a Composition.`);
    invariant(jsxAttribute(composition[0].source, "component") === expected.componentExport, `${expected.compositionId} component is incorrect.`);
    invariant(jsxAttribute(composition[0].source, "width") === String(expected.width), `${expected.compositionId} width is incorrect.`);
    invariant(jsxAttribute(composition[0].source, "height") === String(expected.height), `${expected.compositionId} height is incorrect.`);
    invariant(jsxAttribute(composition[0].source, "fps") === "FPS", `${expected.compositionId} must use FPS.`);
    invariant(jsxAttribute(composition[0].source, "durationInFrames") === expected.durationConstant, `${expected.compositionId} duration constant is incorrect.`);

    const poster = tags.filter((tag) => jsxAttribute(tag.source, "id") === expected.posterCompositionId);
    invariant(poster.length === 1, `${expected.posterCompositionId} must be registered exactly once.`);
    invariant(poster[0].kind === "Still", `${expected.posterCompositionId} must be a Still.`);
    invariant(jsxAttribute(poster[0].source, "component") === expected.posterComponentExport, `${expected.posterCompositionId} component is incorrect.`);
    invariant(jsxAttribute(poster[0].source, "width") === String(expected.width), `${expected.posterCompositionId} width is incorrect.`);
    invariant(jsxAttribute(poster[0].source, "height") === String(expected.height), `${expected.posterCompositionId} height is incorrect.`);
  }
  return { registeredCompositions: 2, registeredPosters: 2 };
}

function timestampSeconds(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u.exec(value ?? "");
  invariant(match, `Invalid SRT timestamp ${value}.`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function nonWhitespaceLength(value) {
  return Array.from(value.replace(/\s/gu, "")).length;
}

export function validateTimedTranscript(contents, options) {
  const blocks = contents.trim().split(/\r?\n\r?\n+/gu);
  invariant(blocks.length === REQUIRED_BEATS.length, `${options.id} must contain exactly 11 cues.`);
  let expectedStart = 0;
  let maximumCps = 0;
  let maximumWordsPerSecond = 0;
  let longestLine = 0;
  const transcriptParts = [];
  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/gu);
    invariant(lines[0] === String(index + 1), `${options.id} cue numbers must be contiguous.`);
    const timing = lines[1]?.split(" --> ");
    invariant(timing?.length === 2, `${options.id} cue ${index + 1} timing is invalid.`);
    const start = timestampSeconds(timing[0]);
    const end = timestampSeconds(timing[1]);
    invariant(Math.abs(start - expectedStart) <= 0.002, `${options.id} has a gap or overlap before cue ${index + 1}.`);
    invariant(end > start, `${options.id} cue ${index + 1} must have positive duration.`);
    const textLines = lines.slice(2);
    invariant(textLines.length >= 1 && textLines.length <= 2 && textLines.every((line) => line.trim()), `${options.id} cue ${index + 1} must use one or two non-empty lines.`);
    const cueText = textLines.join(" ");
    const duration = end - start;
    maximumCps = Math.max(maximumCps, nonWhitespaceLength(cueText) / duration);
    maximumWordsPerSecond = Math.max(maximumWordsPerSecond, cueText.trim().split(/\s+/gu).length / duration);
    longestLine = Math.max(longestLine, ...textLines.map((line) => Array.from(line).length));
    transcriptParts.push(cueText);
    expectedStart = end;
  }
  invariant(Math.abs(expectedStart - options.durationSeconds) <= 0.002, `${options.id} must cover the complete ${options.durationSeconds}s composition.`);
  const transcript = transcriptParts.join(" ");
  invariant(!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(transcript), `${options.id} contains CJK text in an English-only delivery.`);
  invariant(maximumCps <= 20, `${options.id} exceeds 20 non-whitespace characters per second.`);
  invariant(maximumWordsPerSecond <= 4, `${options.id} exceeds 4 words per second.`);
  invariant(longestLine <= 52, `${options.id} contains a line longer than 52 characters.`);
  invariant(/Smithsonian museum 3D scan/iu.test(transcript) && /converted offline/iu.test(transcript), `${options.id} must disclose the museum-scan conversion source.`);
  invariant(/SemaFrame/iu.test(transcript) && /proxy/iu.test(transcript) && /OpenUSD USDA/iu.test(transcript), `${options.id} omits required product, proxy, or export meaning.`);
  assertTruthfulCopy(transcript, options.id);
  return {
    cueCount: blocks.length,
    durationSeconds: expectedStart,
    maximumCps,
    maximumWordsPerSecond,
    longestLine,
  };
}

export function validateAssetEvidence(assetEvidence) {
  invariant(assetEvidence?.schema === "semaframe.reality-twin-asset-evidence.v1", "Reality Twin asset evidence schema is invalid.");
  const source = requiredObject(assetEvidence.source, "assetEvidence.source");
  invariant(source.derivation === "smithsonian_glb_scan_to_gaussian_ply" && source.nativeGaussianCapture === false, "Asset provenance must be Smithsonian GLB scan to offline Gaussian PLY, not a native Gaussian capture.");
  invariant(source.sourceClass === "official_museum_mesh_scan" && source.conversionLocation === "offline", "Asset source class or conversion location is invalid.");
  invariant(/^https:\/\/3d\.si\.edu\/object\/3d\//u.test(source.objectUrl ?? ""), "Asset evidence lacks the Smithsonian object URL.");
  invariant(source.rights === "CC0" && assetEvidence.rights?.status === "CC0", "Museum asset rights must be recorded as CC0.");
  invariant(/^https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\//u.test(assetEvidence.rights?.license_url ?? ""), "CC0 license URL is missing.");

  const files = assetEvidence.retrieval?.source_files;
  invariant(Array.isArray(files) && files.length === 2, "Asset evidence must bind exactly two Smithsonian source GLBs.");
  for (const [index, file] of files.entries()) {
    invariant(file.format === "GLB 2.0" && file.units === "m" && file.gltf_standardized === true, `Source GLB ${index + 1} metadata is invalid.`);
    invariant(/^https:\/\/3d-api\.si\.edu\//u.test(file.url ?? ""), `Source GLB ${index + 1} is not pinned to Smithsonian.`);
    finiteNumber(file.bytes, `Source GLB ${index + 1} bytes`, { positive: true });
    normalizeSha256(file.sha256, `Source GLB ${index + 1} digest`);
  }
  const combined = createHash("sha256").update(files.map((file) => file.sha256).join(":"), "utf8").digest("hex");
  invariant(assetEvidence.retrieval.combined_source_sha256 === combined, "Combined Smithsonian source digest is invalid.");

  const conversion = requiredObject(assetEvidence.conversion, "assetEvidence.conversion");
  invariant(/deterministic area-weighted triangle surface sampling/iu.test(conversion.algorithm ?? ""), "Offline Gaussian conversion algorithm is not recorded.");
  invariant(/Gaussian/iu.test(conversion.gaussian_model ?? "") && conversion.splat_count === 1_500_000, "Derived Gaussian model or splat count is invalid.");
  invariant(conversion.transform?.shape_policy === "uniform scale only; no anisotropic deformation", "Conversion must not hide anisotropic deformation.");
  invariant(/standard glTF 2\.0 right-handed/iu.test(conversion.transform?.source_convention ?? "") && /Semaframe RUB/iu.test(conversion.transform?.target_convention ?? ""), "Coordinate basis conversion is incomplete.");
  const limitations = (conversion.limitations ?? []).join(" ");
  invariant(/not a native photogrammetry-trained Gaussian capture/iu.test(limitations), "Asset limitations must deny a native Gaussian capture.");
  invariant(/visual evidence only/iu.test(limitations) && /metrology/iu.test(limitations), "Asset limitations must preserve the visual-only boundary.");

  const derived = requiredObject(assetEvidence.derivedAsset, "assetEvidence.derivedAsset");
  invariant(derived.format === "ply" && derived.mediaType === "application/ply" && derived.model === "gaussian-3d", "Derived asset must be a Gaussian PLY.");
  invariant(derived.sphericalHarmonicsDegree === 0 && derived.splatCount === conversion.splat_count, "Derived Gaussian SH degree or splat count changed.");
  finiteNumber(derived.byteLength, "derivedAsset.byteLength", { positive: true });
  invariant(derived.byteLength < 256 * 1024 * 1024 && derived.splatCount < 4_000_000, "Derived asset exceeds SemaFrame import limits.");
  const derivedDigest = normalizeSha256(derived.sha256, "derivedAsset.sha256");
  invariant(derived.coordinateBasis?.units === "metres" && /RUB/iu.test(derived.coordinateBasis?.axes ?? ""), "Derived coordinate basis must be RUB metres.");
  invariant(approximatelyEqual(derived.calibrationReference?.knownDistanceMetres, assetEvidence.subject?.dimensions_metres?.height, 1e-9), "Calibration reference must match the published museum height.");
  invariant(/no anisotropic deformation/iu.test(derived.calibrationReference?.policy ?? ""), "Calibration policy must deny anisotropic deformation.");

  const checks = requiredObject(derived.independentDimensionChecks, "derivedAsset.independentDimensionChecks");
  finiteNumber(checks.toleranceMetres, "independent dimension tolerance", { positive: true });
  invariant(checks.toleranceMetres <= 0.02, "Independent dimension tolerance may not exceed the disclosed 20 mm demo threshold.");
  invariant(/demo registration tolerance only/iu.test(checks.acceptanceBasis ?? "") && /not a metrology or manufacturing claim/iu.test(checks.acceptanceBasis ?? ""), "Independent dimension acceptance boundary is incomplete.");
  for (const axis of ["width", "depth"]) {
    const check = requiredObject(checks[axis], `${axis} independent dimension check`);
    finiteNumber(check.catalogMetres, `${axis}.catalogMetres`, { positive: true });
    finiteNumber(check.scanAabbMetres, `${axis}.scanAabbMetres`, { positive: true });
    finiteNumber(check.residualMetres, `${axis}.residualMetres`);
    invariant(approximatelyEqual(check.residualMetres, check.scanAabbMetres - check.catalogMetres, 1e-9), `${axis} residual is not the observed signed residual.`);
    invariant(check.passed === (Math.abs(check.residualMetres) <= checks.toleranceMetres), `${axis} pass flag does not match the disclosed tolerance.`);
  }

  const output = requiredObject(assetEvidence.output, "assetEvidence.output");
  invariant(output.relative_path === derived.relativePath && output.bytes === derived.byteLength, "Authoritative output and compatibility alias disagree.");
  invariant(normalizeSha256(output.sha256, "output.sha256") === derivedDigest, "Output and derived asset digests disagree.");
  invariant(output.semaframe_limits?.within_limits === true, "Asset evidence does not pass SemaFrame limits.");
  const validation = requiredObject(assetEvidence.validation, "assetEvidence.validation");
  invariant(validation.status === "passed", "Reality Twin asset verification has not passed.");
  const preflight = requiredObject(validation.semaframe_current_preflight?.descriptor, "assetEvidence.validation.semaframe_current_preflight.descriptor");
  invariant(normalizeSha256(preflight.digest, "asset preflight digest") === derivedDigest, "Current SemaFrame preflight used the wrong PLY digest.");
  invariant(preflight.byteLength === derived.byteLength && preflight.splatCount === derived.splatCount, "Current SemaFrame preflight counts differ from asset evidence.");
  invariant(preflight.format === "ply" && preflight.model === "gaussian-3d" && preflight.engineeringAuthority === "visual_only", "Current SemaFrame preflight classification is invalid.");
  const spark = requiredObject(validation.spark_browser_import, "assetEvidence.validation.spark_browser_import");
  invariant(spark.initialized === true && spark.rendered === true, "Spark did not initialize and render the derived PLY.");
  invariant(spark.decoded_splats === derived.splatCount && spark.active_splats === derived.splatCount, "Spark did not decode and activate every derived splat.");
  invariant(spark.screenshot?.bytes > 80_000 && /^[0-9a-f]{64}$/u.test(spark.screenshot?.sha256 ?? ""), "Spark render receipt is missing or too small.");
  invariant(spark.screenshot?.subject_crop_non_background_fraction >= 0.1, "Spark render did not contain a visible subject.");
  return {
    sourceGlbCount: files.length,
    sourceCombinedSha256: normalizeSha256(assetEvidence.retrieval.combined_source_sha256, "combined source digest"),
    derivedAssetSha256: derivedDigest,
    derivedAssetBytes: derived.byteLength,
    splatCount: derived.splatCount,
  };
}

function digestsFromSourceEvidence(source) {
  const values = source.sourceGlbDigests ?? source.sourceGlbs ?? [];
  invariant(Array.isArray(values), "source.sourceGlbDigests must be an array.");
  return values.map((value, index) => normalizeSha256(typeof value === "string" ? value : value?.sha256, `source GLB digest ${index + 1}`)).sort();
}

function conflictComponentIds(conflict) {
  const candidates = [
    conflict?.leftId,
    conflict?.rightId,
    conflict?.a,
    conflict?.b,
    conflict?.componentA,
    conflict?.componentB,
    conflict?.component_id,
    conflict?.conflicts_with,
    ...(Array.isArray(conflict?.componentIds) ? conflict.componentIds : []),
  ];
  return candidates.filter((value) => typeof value === "string");
}

function recursivelyContains(value, target) {
  if (value === target) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) => recursivelyContains(child, target));
}

export function validateCaptureEvidence(evidence, context) {
  invariant(evidence?.format === "semaframe-reality-twin-capture-evidence" && evidence.version === 1, "Reality Twin capture evidence identity is invalid.");
  invariant(evidence.status === "complete", "Reality Twin capture evidence is not complete.");
  invariant(typeof evidence.captureRunId === "string" && evidence.captureRunId.length >= 12, "Reality Twin capture run identity is missing.");
  const runStartedMs = isoTimestamp(evidence.startedAt, "evidence.startedAt");
  const runCompletedMs = isoTimestamp(evidence.completedAt, "evidence.completedAt");
  invariant(runCompletedMs >= runStartedMs, "Reality Twin capture completion precedes its start.");
  const assetEvidence = context.assetEvidence;
  const assetSummary = validateAssetEvidence(assetEvidence);

  const integrity = requiredObject(evidence.integrity, "evidence.integrity");
  for (const [key, expected] of Object.entries(context.integrity)) {
    invariant(normalizeSha256(integrity[key], `integrity.${key}`) === expected, `Reality Twin ${key} is stale or mismatched.`);
  }
  invariant(normalizeSha256(integrity.captureAssetManifestSha256, "integrity.captureAssetManifestSha256") === context.captureManifest.hash, "Capture asset manifest hash is stale or mismatched.");
  invariant(integrity.captureAssetCount === context.captureManifest.fileCount, "Capture asset count is stale or mismatched.");

  const source = requiredObject(evidence.source, "evidence.source");
  invariant(source.derivation === "smithsonian_glb_scan_to_gaussian_ply" && source.nativeGaussianCapture === false, "Capture evidence must preserve the Smithsonian GLB-to-Gaussian derivation boundary.");
  invariant(source.assetEvidencePath === ASSET_EVIDENCE_PATH, "Capture evidence must bind the authoritative asset-evidence.json.");
  const expectedGlbs = assetEvidence.retrieval.source_files.map((file) => normalizeSha256(file.sha256, "asset GLB digest")).sort();
  invariant(JSON.stringify(digestsFromSourceEvidence(source)) === JSON.stringify(expectedGlbs), "Capture evidence source GLB digests differ from asset evidence.");
  invariant(normalizeSha256(source.derivedPlyDigest, "source.derivedPlyDigest") === assetSummary.derivedAssetSha256, "Capture evidence imported the wrong derived PLY.");
  const agentExecution = requiredObject(evidence.agentExecution, "agentExecution");
  invariant(agentExecution.kind === "deterministic_authorized_mcp_client"
    && agentExecution.generativePlannerUsed === false
    && agentExecution.fixtureDriven === true,
  "Reality Twin capture must disclose its deterministic fixture-driven Agent execution.");

  const imported = requiredObject(evidence.assetImport, "assetImport");
  invariant(imported.browserAuthoritative === true, "Asset import was not browser authoritative.");
  invariant(typeof imported.requestId === "string" && imported.requestId.length >= 8, "Asset import request ID is missing.");
  invariant(imported.upload?.httpStatus === 200, "Asset import did not complete with HTTP 200.");
  invariant(imported.upload?.byteLength === assetSummary.derivedAssetBytes, "Uploaded byte length differs from the verified PLY.");
  invariant(imported.localBytesReady === true, "Browser local bytes were not proven ready.");
  const descriptor = requiredObject(imported.descriptor, "assetImport.descriptor");
  invariant(descriptor.version === 1 && descriptor.format === "ply" && descriptor.mediaType === "application/ply", "Browser PLY preflight descriptor is invalid.");
  invariant(descriptor.model === "gaussian-3d" && descriptor.sphericalHarmonicsDegree === 0, "Browser preflight did not identify the expected Gaussian model.");
  invariant(descriptor.splatCount === assetSummary.splatCount && descriptor.byteLength === assetSummary.derivedAssetBytes, "Browser preflight PLY counts differ from asset evidence.");
  invariant(descriptor.engineeringAuthority === "visual_only", "Imported Reality descriptor must remain visual_only.");
  const importedDigest = normalizeSha256(imported.assetRef?.digest, "assetImport.assetRef.digest");
  invariant(importedDigest === assetSummary.derivedAssetSha256 && normalizeSha256(descriptor.digest, "descriptor.digest") === importedDigest, "Browser import digest differs from the verified PLY.");
  invariant(descriptor.assetId === imported.assetRef?.assetId && /^ra_[a-f0-9]{64}$/u.test(descriptor.assetId ?? ""), "Browser import asset ID is invalid or inconsistent.");
  const authoritativeDescriptor = requiredObject(assetEvidence.validation?.semaframe_current_preflight?.descriptor, "asset evidence browser descriptor");
  for (const bound of ["min", "max"]) {
    finiteVector(descriptor.sourceBounds?.[bound], `assetImport.descriptor.sourceBounds.${bound}`);
    finiteVector(authoritativeDescriptor.sourceBounds?.[bound], `asset evidence sourceBounds.${bound}`);
    for (const axis of ["x", "y", "z"]) {
      invariant(approximatelyEqual(descriptor.sourceBounds[bound][axis], authoritativeDescriptor.sourceBounds[bound][axis], 1e-9),
        `Browser import sourceBounds.${bound}.${axis} differs from the verified PLY descriptor.`);
    }
  }

  const calibration = requiredObject(evidence.calibration, "calibration");
  invariant(calibration.measurementFidelity === "gaussian-lod" && calibration.measurementCompleted === true, "Calibration was not completed on the Gaussian LOD surface.");
  const calibrationPointA = calibration.pointA ?? calibration.sourcePointA;
  const calibrationPointB = calibration.pointB ?? calibration.sourcePointB;
  const pickedOnCurrentLod = calibration.pickedOnCurrentGaussianLod === true
    && calibrationPointA?.pickedOnCurrentGaussianLod === true
    && calibrationPointB?.pickedOnCurrentGaussianLod === true;
  invariant(calibration.appliedThroughInspectorUi === true
    && calibration.inputDriver === "automated_cdp_pointer_and_form_events"
    && calibration.humanInputClaimed === false
    && pickedOnCurrentLod,
  "Calibration must disclose automated Inspector pointer input on the current Gaussian LOD.");
  invariant(calibration.blindValidation === false
    && calibration.selectionPolicy === "target_guided_visible_candidate_search_with_aabb_residual_gate"
    && Number.isSafeInteger(calibration.rejectedCandidateCount)
    && calibration.rejectedCandidateCount > 0,
  "Calibration must disclose its expected-aware candidate policy and rejected candidates.");
  const captureTruth = requiredObject(context.captureFixture?.physicalTruth, "capture fixture physicalTruth");
  const calibrationPolicy = requiredObject(captureTruth.calibration, "capture fixture calibration policy");
  const catalogByAxis = requiredObject(captureTruth.catalogDimensionsM, "capture fixture catalogDimensionsM");
  const rejectionTolerance = requiredObject(captureTruth.scanResidualToleranceM, "capture fixture scanResidualToleranceM");
  finiteNumber(calibrationPolicy.minimumAcceptedSourceSpanM, "capture fixture minimumAcceptedSourceSpanM", { positive: true });
  finiteNumber(calibrationPolicy.maximumAcceptedSourceSpanM, "capture fixture maximumAcceptedSourceSpanM", { positive: true });
  invariant(calibrationPolicy.maximumAcceptedSourceSpanM > calibrationPolicy.minimumAcceptedSourceSpanM,
    "Capture fixture calibration span policy is invalid.");
  invariant(calibrationPolicy.axis === "y"
    && approximatelyEqual(calibrationPolicy.knownDistanceM, assetEvidence.derivedAsset.calibrationReference.knownDistanceMetres, 1e-9),
  "Capture fixture calibration reference differs from authoritative asset evidence.");
  finiteVector(catalogByAxis, "capture fixture catalogDimensionsM");
  finiteVector(rejectionTolerance, "capture fixture scanResidualToleranceM");
  const authoritativeCatalogByAxis = {
    x: assetEvidence.subject.dimensions_metres.width,
    y: assetEvidence.subject.dimensions_metres.height,
    z: assetEvidence.subject.dimensions_metres.depth,
  };
  const authoritativeResidualTolerance = assetEvidence.derivedAsset.independentDimensionChecks.toleranceMetres;
  for (const axis of ["x", "y", "z"]) {
    invariant(approximatelyEqual(catalogByAxis[axis], authoritativeCatalogByAxis[axis], 1e-9),
      `Capture fixture catalog ${axis} differs from authoritative asset evidence.`);
    invariant(approximatelyEqual(rejectionTolerance[axis], authoritativeResidualTolerance, 1e-12),
      `Capture fixture rejected-candidate ${axis} tolerance differs from authoritative asset evidence.`);
  }
  invariant(Array.isArray(calibration.rejectedCandidates)
    && calibration.rejectedCandidates.length === calibration.rejectedCandidateCount,
  "Calibration rejected-candidate receipts do not match the disclosed count.");
  const sourceExtents = Object.fromEntries(["x", "y", "z"].map((axis) => [
    axis,
    descriptor.sourceBounds.max[axis] - descriptor.sourceBounds.min[axis],
  ]));
  const acceptedSessionIds = new Set();
  const acceptedPointIds = new Set();
  const rejectedSessionIds = new Set();
  const rejectedPointIds = new Set();
  const rejectedControlKinds = [];
  for (const [index, candidate] of calibration.rejectedCandidates.entries()) {
    requiredObject(candidate, `calibration.rejectedCandidates[${index}]`);
    invariant(candidate.sequence === index + 1 && Number.isSafeInteger(candidate.sequence),
      `Rejected calibration candidate ${index + 1} has an invalid sequence receipt.`);
    invariant(candidate.accepted === false && candidate.measurementFidelity === "gaussian-lod",
      `Rejected calibration candidate ${index + 1} is not a rejected current-LOD measurement.`);
    invariant(candidate.controlKind === "visible_short_span" || candidate.controlKind === "search_candidate",
      `Rejected calibration candidate ${index + 1} has an invalid control kind.`);
    rejectedControlKinds.push(candidate.controlKind);
    const candidatePointA = finiteVector(candidate.pointA, `calibration.rejectedCandidates[${index}].pointA`);
    const candidatePointB = finiteVector(candidate.pointB, `calibration.rejectedCandidates[${index}].pointB`);
    invariant(candidatePointA.pickedOnCurrentGaussianLod === true && candidatePointB.pickedOnCurrentGaussianLod === true,
      `Rejected calibration candidate ${index + 1} was not picked on the current Gaussian LOD.`);
    invariant(Number.isSafeInteger(candidatePointA.sessionId)
      && candidatePointA.sessionId > 0
      && candidatePointB.sessionId === candidatePointA.sessionId,
    `Rejected calibration candidate ${index + 1} has no safe shared measurement session.`);
    invariant(candidatePointA.pointId === `measurement-${candidatePointA.sessionId}-a`
      && candidatePointB.pointId === `measurement-${candidatePointB.sessionId}-b`,
    `Rejected calibration candidate ${index + 1} point IDs do not bind to its session and A/B roles.`);
    invariant(!rejectedSessionIds.has(candidatePointA.sessionId),
      `Rejected calibration candidate ${index + 1} reused another rejected measurement session.`);
    invariant(!rejectedPointIds.has(candidatePointA.pointId) && !rejectedPointIds.has(candidatePointB.pointId),
      `Rejected calibration candidate ${index + 1} reused another rejected point identity.`);
    rejectedSessionIds.add(candidatePointA.sessionId);
    rejectedPointIds.add(candidatePointA.pointId);
    rejectedPointIds.add(candidatePointB.pointId);
    invariant(candidatePointA.assetId === descriptor.assetId && candidatePointB.assetId === descriptor.assetId
      && normalizeSha256(candidatePointA.assetDigest, `calibration.rejectedCandidates[${index}].pointA.assetDigest`) === importedDigest
      && normalizeSha256(candidatePointB.assetDigest, `calibration.rejectedCandidates[${index}].pointB.assetDigest`) === importedDigest,
    `Rejected calibration candidate ${index + 1} is not bound to the current imported Reality asset.`);
    for (const point of [candidatePointA, candidatePointB]) {
      for (const axis of ["x", "y", "z"]) {
        invariant(point[axis] >= descriptor.sourceBounds.min[axis] - 1e-6
          && point[axis] <= descriptor.sourceBounds.max[axis] + 1e-6,
        `Rejected calibration candidate ${index + 1} point lies outside the verified current-LOD source bounds.`);
      }
    }
    finiteNumber(candidate.sourceDistance, `calibration.rejectedCandidates[${index}].sourceDistance`, { positive: true });
    invariant(approximatelyEqual(
      vectorDistance(candidatePointA, candidatePointB),
      candidate.sourceDistance,
      Math.max(1e-6, candidate.sourceDistance * 1e-4),
    ), `Rejected calibration candidate ${index + 1} source span does not match its actual A/B points.`);
    const actualSourceDelta = {
      x: Math.abs(candidatePointA.x - candidatePointB.x),
      y: Math.abs(candidatePointA.y - candidatePointB.y),
      z: Math.abs(candidatePointA.z - candidatePointB.z),
    };
    finiteVector(candidate.sourceDelta, `calibration.rejectedCandidates[${index}].sourceDelta`);
    for (const axis of ["x", "y", "z"]) {
      invariant(approximatelyEqual(candidate.sourceDelta[axis], actualSourceDelta[axis], 1e-9),
        `Rejected calibration candidate ${index + 1} sourceDelta.${axis} is not the actual A/B delta.`);
    }
    finiteNumber(candidate.candidateMetersPerSourceUnit, `calibration.rejectedCandidates[${index}].candidateMetersPerSourceUnit`, { positive: true });
    const expectedCandidateScale = assetEvidence.derivedAsset.calibrationReference.knownDistanceMetres / candidate.sourceDistance;
    invariant(approximatelyEqual(candidate.candidateMetersPerSourceUnit, expectedCandidateScale, 1e-6),
      `Rejected calibration candidate ${index + 1} scale does not equal known/source distance.`);
    finiteVector(candidate.calibratedScanAabbM, `calibration.rejectedCandidates[${index}].calibratedScanAabbM`);
    finiteVector(candidate.catalogResidualM, `calibration.rejectedCandidates[${index}].catalogResidualM`);
    finiteVector(candidate.residualToleranceM, `calibration.rejectedCandidates[${index}].residualToleranceM`);
    const expectedCandidateAabb = {};
    const expectedCandidateResidual = {};
    for (const axis of ["x", "y", "z"]) {
      expectedCandidateAabb[axis] = sourceExtents[axis] * expectedCandidateScale;
      expectedCandidateResidual[axis] = expectedCandidateAabb[axis] - catalogByAxis[axis];
      invariant(approximatelyEqual(candidate.calibratedScanAabbM[axis], expectedCandidateAabb[axis], 1e-6),
        `Rejected calibration candidate ${index + 1} calibrated AABB ${axis} is not source extent times candidate scale.`);
      invariant(approximatelyEqual(candidate.catalogResidualM[axis], expectedCandidateResidual[axis], 1e-6),
        `Rejected calibration candidate ${index + 1} catalog residual ${axis} is not observed-minus-catalog.`);
      invariant(approximatelyEqual(candidate.residualToleranceM[axis], rejectionTolerance[axis], 1e-12),
        `Rejected calibration candidate ${index + 1} residual tolerance ${axis} is not authoritative.`);
    }
    invariant(Array.isArray(candidate.rejectionReasonCodes)
      && candidate.rejectionReasonCodes.length > 0
      && candidate.rejectionReasonCodes.every((code) => typeof code === "string"),
    `Rejected calibration candidate ${index + 1} has no explicit rejection reason codes.`);
    invariant(new Set(candidate.rejectionReasonCodes).size === candidate.rejectionReasonCodes.length
      && candidate.rejectionReasonCodes.every((code) => CALIBRATION_REJECTION_REASON_CODES.includes(code)),
    `Rejected calibration candidate ${index + 1} has duplicate or unknown rejection reason codes.`);
    const expectedReasonCodes = [];
    if (candidate.sourceDistance < calibrationPolicy.minimumAcceptedSourceSpanM) expectedReasonCodes.push("source_span_below_minimum");
    if (candidate.sourceDistance > calibrationPolicy.maximumAcceptedSourceSpanM) expectedReasonCodes.push("source_span_above_maximum");
    if (actualSourceDelta.y < actualSourceDelta.x || actualSourceDelta.y < actualSourceDelta.z) expectedReasonCodes.push("source_y_not_dominant");
    if (actualSourceDelta.y < sourceExtents.y * 0.9) expectedReasonCodes.push("source_y_below_90_percent_of_aabb_height");
    if (candidate.sourceDistance / actualSourceDelta.y > 1.2) expectedReasonCodes.push("non_y_path_exceeds_ratio_limit");
    if (Math.abs(candidate.sourceDistance - sourceExtents.y) > 0.02) expectedReasonCodes.push("source_span_differs_from_aabb_height");
    const impliedMetricHeight = sourceExtents.y * assetEvidence.derivedAsset.calibrationReference.knownDistanceMetres / candidate.sourceDistance;
    if (Math.abs(impliedMetricHeight - catalogByAxis.y) > rejectionTolerance.y) expectedReasonCodes.push("implied_catalog_height_residual_exceeds_tolerance");
    if (["x", "y", "z"].some((axis) => Math.abs(expectedCandidateResidual[axis]) > rejectionTolerance[axis])) {
      expectedReasonCodes.push("calibrated_scan_aabb_residual_exceeds_tolerance");
    }
    invariant(JSON.stringify(candidate.rejectionReasonCodes) === JSON.stringify(expectedReasonCodes),
      `Rejected calibration candidate ${index + 1} reason codes do not match the observed negative-control math.`);
  }
  invariant(rejectedControlKinds[0] === "visible_short_span"
    && rejectedControlKinds.filter((kind) => kind === "visible_short_span").length === 1
    && calibration.rejectedCandidates[0].sourceDistance < calibrationPolicy.minimumAcceptedSourceSpanM
    && calibration.rejectedCandidates[0].rejectionReasonCodes.includes("source_span_below_minimum"),
  "Calibration evidence has no genuine first rejected visible short-span negative control.");
  finiteVector(calibration.pointA ?? calibration.sourcePointA, "calibration.pointA");
  finiteVector(calibration.pointB ?? calibration.sourcePointB, "calibration.pointB");
  const pointA = calibrationPointA;
  const pointB = calibrationPointB;
  invariant(Number.isSafeInteger(pointA.sessionId) && pointA.sessionId > 0 && pointB.sessionId === pointA.sessionId,
    "Calibration A/B points must belong to one concrete measurement session.");
  invariant(pointA.pointId === `measurement-${pointA.sessionId}-a` && pointB.pointId === `measurement-${pointB.sessionId}-b`,
    "Calibration point IDs do not bind to their session and A/B roles.");
  acceptedSessionIds.add(pointA.sessionId);
  acceptedPointIds.add(pointA.pointId);
  acceptedPointIds.add(pointB.pointId);
  invariant(!rejectedSessionIds.has(pointA.sessionId)
    && !rejectedPointIds.has(pointA.pointId)
    && !rejectedPointIds.has(pointB.pointId),
  "Rejected calibration candidates must use sessions and point IDs distinct from the accepted pair.");
  invariant(pointA.assetId === descriptor.assetId && pointB.assetId === descriptor.assetId
    && normalizeSha256(pointA.assetDigest, "calibration.pointA.assetDigest") === importedDigest
    && normalizeSha256(pointB.assetDigest, "calibration.pointB.assetDigest") === importedDigest,
  "Calibration A/B points are not bound to the imported Reality asset.");
  finiteNumber(calibration.sourceDistance, "calibration.sourceDistance", { positive: true });
  invariant(approximatelyEqual(vectorDistance(pointA, pointB), calibration.sourceDistance, Math.max(1e-6, calibration.sourceDistance * 1e-4)), "Calibration source distance does not match the recorded A/B points.");
  finiteNumber(calibration.knownDistanceM, "calibration.knownDistanceM", { positive: true });
  invariant(approximatelyEqual(calibration.knownDistanceM, assetEvidence.derivedAsset.calibrationReference.knownDistanceMetres, 1e-6), "Calibration known distance differs from the Smithsonian reference.");
  finiteNumber(calibration.metersPerSourceUnit, "calibration.metersPerSourceUnit", { positive: true });
  invariant(approximatelyEqual(calibration.metersPerSourceUnit, calibration.knownDistanceM / calibration.sourceDistance, 1e-6), "Applied calibration scale does not equal known/source distance.");
  invariant(calibration.assetDigest === importedDigest, "Calibration is not bound to the imported PLY digest.");
  invariant(calibration.componentReadback?.status === "reference-distance", "Calibrated component readback is missing.");
  invariant(approximatelyEqual(calibration.componentReadback?.metersPerSourceUnit, calibration.metersPerSourceUnit, 1e-9), "Component calibration readback differs from the applied scale.");
  invariant(Number.isSafeInteger(calibration.workspaceRevision) && calibration.workspaceRevision > 0, "Calibration Workspace revision is invalid.");

  const scanAabb = requiredObject(evidence.scanAabbComparison, "scanAabbComparison");
  finiteVector(scanAabb.expectedCatalogM, "scanAabbComparison.expectedCatalogM");
  finiteVector(scanAabb.calibratedScanAabbM, "scanAabbComparison.calibratedScanAabbM");
  finiteVector(scanAabb.residualM, "scanAabbComparison.residualM");
  finiteVector(scanAabb.toleranceM, "scanAabbComparison.toleranceM");
  for (const axis of ["x", "y", "z"]) {
    const sourceExtent = descriptor.sourceBounds.max[axis] - descriptor.sourceBounds.min[axis];
    const calibratedExtent = sourceExtent * calibration.metersPerSourceUnit;
    invariant(approximatelyEqual(scanAabb.expectedCatalogM[axis], catalogByAxis[axis], 1e-9), `Scan AABB ${axis} catalog dimension drifted.`);
    invariant(approximatelyEqual(scanAabb.calibratedScanAabbM[axis], calibratedExtent, 1e-6), `Scan AABB ${axis} is not the calibrated verified source extent.`);
    invariant(approximatelyEqual(scanAabb.residualM[axis], calibratedExtent - catalogByAxis[axis], 1e-6), `Scan AABB ${axis} residual is not observed-minus-catalog.`);
    invariant(approximatelyEqual(scanAabb.toleranceM[axis], assetEvidence.derivedAsset.independentDimensionChecks.toleranceMetres, 1e-12), `Scan AABB ${axis} tolerance differs from asset evidence.`);
    invariant(Math.abs(scanAabb.residualM[axis]) <= scanAabb.toleranceM[axis], `Scan AABB ${axis} residual exceeds the disclosed tolerance.`);
  }
  invariant(scanAabb.passed === true && scanAabb.exactCatalogMatchClaimed === false, "Scan AABB comparison must pass without claiming an exact catalog match.");

  const independent = requiredObject(evidence.independentDimensionCheck, "independentDimensionCheck");
  invariant(independent.source === "live_calibrated_gaussian_measurement" && independent.displayedWithoutSubstitution === true, "Second-span check must come from the live calibrated Gaussian without numeric substitution.");
  invariant(independent.blindValidation === false
    && independent.selectionPolicy === "target_guided_visible_candidate_search"
    && independent.viewPreparation === "automated_canvas_orbit_pointer_events",
  "Second-span evidence must disclose its expected-aware visible-pair search policy and pointer-orbit view preparation.");
  invariant(independent.distinctFromCalibrationPair === true, "Second-span check must use a point pair distinct from calibration A/B.");
  finiteVector(independent.pointA, "independentDimensionCheck.pointA");
  finiteVector(independent.pointB, "independentDimensionCheck.pointB");
  invariant(independent.pointA.pickedOnCurrentGaussianLod === true && independent.pointB.pickedOnCurrentGaussianLod === true,
    "Second-span A/B points must be sampled from the current Gaussian LOD.");
  invariant(Number.isSafeInteger(independent.pointA.sessionId) && independent.pointA.sessionId > 0
    && independent.pointB.sessionId === independent.pointA.sessionId
    && !acceptedSessionIds.has(independent.pointA.sessionId)
    && !rejectedSessionIds.has(independent.pointA.sessionId),
  "Second-span A/B points must share a fresh session distinct from calibration, including its accepted and rejected measurements.");
  invariant(independent.pointA.pointId === `measurement-${independent.pointA.sessionId}-a`
    && independent.pointB.pointId === `measurement-${independent.pointB.sessionId}-b`
    && independent.pointA.pointId !== pointA.pointId
    && independent.pointB.pointId !== pointB.pointId,
  "Second-span point IDs do not bind to a distinct session and A/B roles.");
  invariant(independent.pointA.assetId === descriptor.assetId && independent.pointB.assetId === descriptor.assetId
    && normalizeSha256(independent.pointA.assetDigest, "independentDimensionCheck.pointA.assetDigest") === importedDigest
    && normalizeSha256(independent.pointB.assetDigest, "independentDimensionCheck.pointB.assetDigest") === importedDigest,
  "Second-span A/B points are not bound to the imported Reality asset.");
  finiteNumber(independent.sourceDistance, "independentDimensionCheck.sourceDistance", { positive: true });
  invariant(approximatelyEqual(
    vectorDistance(independent.pointA, independent.pointB),
    independent.sourceDistance,
    Math.max(1e-6, independent.sourceDistance * 1e-4),
  ), "Second-span source distance does not match the recorded A/B points.");
  finiteNumber(independent.expectedM, "independentDimensionCheck.expectedM", { positive: true });
  finiteNumber(independent.measuredM, "independentDimensionCheck.measuredM", { positive: true });
  finiteNumber(independent.residualM, "independentDimensionCheck.residualM", { nonNegative: true });
  finiteNumber(independent.toleranceM, "independentDimensionCheck.toleranceM", { positive: true });
  const authoritativeWidth = assetEvidence.derivedAsset.independentDimensionChecks.width.catalogMetres;
  const authoritativeTolerance = assetEvidence.derivedAsset.independentDimensionChecks.toleranceMetres;
  invariant(approximatelyEqual(independent.expectedM, authoritativeWidth, 1e-9), "Second-span expected width differs from authoritative asset evidence.");
  invariant(approximatelyEqual(independent.toleranceM, authoritativeTolerance, 1e-12), "Second-span tolerance differs from authoritative asset evidence.");
  invariant(approximatelyEqual(independent.measuredM, independent.sourceDistance * calibration.metersPerSourceUnit, 1e-6), "Second-span metric result does not equal source distance times the applied calibration scale.");
  invariant(approximatelyEqual(independent.residualM, Math.abs(independent.measuredM - independent.expectedM), 1e-6), "Second-span residual is not the observed absolute residual.");
  invariant(independent.toleranceM <= Math.max(0.02, independent.expectedM * 0.1), "Second-span tolerance is implausibly permissive.");
  invariant(independent.passed === (independent.residualM <= independent.toleranceM) && independent.passed === true, "Second-span pass flag does not match its residual and tolerance.");
  invariant(/asset-evidence/iu.test(independent.toleranceSource ?? ""), "Second-span check must bind its tolerance to asset evidence.");

  const agent = requiredObject(evidence.agentReadback, "agentReadback");
  invariant(agent.tool === "inspect_workspace_space" && agent.safeDescriptorOnly === true, "Agent safe spatial readback is missing.");
  invariant(agent.rawSplatsExposed === false && agent.rawPixelsExposed === false && agent.sourceGlbExposed === false, "Agent readback must not expose raw splats, pixels, or source GLB.");
  invariant(normalizeSha256(agent.assetDigest, "agentReadback.assetDigest") === importedDigest, "Agent readback is not bound to the imported PLY.");
  const agentScale = agent.calibration?.metersPerSourceUnit ?? agent.calibration?.meters_per_source_unit;
  invariant(approximatelyEqual(agentScale, calibration.metersPerSourceUnit, 1e-9), "Agent calibration readback differs from Workspace calibration.");
  finiteVector(agent.worldBounds?.min, "agentReadback.worldBounds.min");
  finiteVector(agent.worldBounds?.max, "agentReadback.worldBounds.max");
  invariant(agent.worldBounds?.units === "metres" || agent.worldBoundsUnits === "metres", "Agent world bounds must be explicitly metric.");
  invariant(Array.isArray(agent.semanticProxyIds) && agent.semanticProxyIds.length > 0, "Agent readback must include semanticProxyIds.");

  const semantic = requiredObject(evidence.semanticProxy, "semanticProxy");
  invariant(semantic.linked === true && semantic.engineeringAuthority === "proxy" && semantic.realityEngineeringAuthority === "visual_only", "Semantic proxy authority is invalid.");
  invariant(typeof semantic.proxyId === "string" && typeof semantic.realityId === "string" && semantic.proxyId !== semantic.realityId, "Reality/proxy identities are invalid.");
  invariant(agent.semanticProxyIds.includes(semantic.proxyId), "Agent readback does not contain the linked proxy ID.");
  invariant(Array.isArray(semantic.relations) && semantic.relations.some((relation) => {
    const text = String(relation);
    return text.includes(semantic.proxyId) || text.includes(semantic.realityId);
  }), "Reality-to-proxy relation evidence is missing.");
  invariant(semantic.exactGeometry === true
    || (semantic.exactGeometry && typeof semantic.exactGeometry === "object" && Object.keys(semantic.exactGeometry).length > 0), "Proxy exact-geometry evidence is missing.");

  const collision = requiredObject(evidence.collision, "collision");
  invariant(collision.preflightValid === false && collision.rejectedBatchCode === "spatial_collision", "Unsafe proxy placement was not rejected by spatial_collision.");
  invariant(Array.isArray(collision.preflightConflicts) && collision.preflightConflicts.length > 0, "Collision rejection contains no conflicts.");
  invariant(collision.atomic === true && collision.revisionBeforeRejection === collision.revisionAfterRejection, "Collision rejection did not preserve the Workspace revision atomically.");
  invariant(collision.proxyColliderEnabled === true && collision.realityColliderEnabled === false, "Collision authority must belong only to the proxy.");
  const conflictIds = new Set(collision.preflightConflicts.flatMap(conflictComponentIds));
  invariant(conflictIds.has(semantic.proxyId), "Collision evidence does not involve the semantic proxy.");
  invariant(!conflictIds.has(semantic.realityId), "Gaussian Reality incorrectly participated as a collider.");
  invariant(collision.correctedCollisionConflictCount === 0, "Corrected Workspace retains collision conflicts.");

  const edit = requiredObject(evidence.numericEdit, "numericEdit");
  invariant(typeof edit.componentId === "string" && typeof edit.property === "string", "Numeric edit target is missing.");
  finiteNumber(edit.beforeM, "numericEdit.beforeM", { positive: true });
  finiteNumber(edit.afterM, "numericEdit.afterM", { positive: true });
  finiteNumber(edit.readbackAfterM, "numericEdit.readbackAfterM", { positive: true });
  invariant(!approximatelyEqual(edit.beforeM, edit.afterM) && approximatelyEqual(edit.afterM, edit.readbackAfterM, 1e-9), "Numeric edit was not preserved in component readback.");
  invariant(edit.undoRestoredBefore === true && edit.redoRestoredAfter === true, "Numeric edit undo/redo proof is incomplete.");
  const history = requiredObject(evidence.history, "history");
  const undoApplied = history.undo?.applied === true || history.undo?.changed === true;
  const redoApplied = history.redo?.applied === true || history.redo?.changed === true;
  invariant(undoApplied && (history.undo?.readbackM === undefined || approximatelyEqual(history.undo.readbackM, edit.beforeM, 1e-9)), "Undo did not restore the prior numeric value.");
  invariant(redoApplied && (history.redo?.readbackM === undefined || approximatelyEqual(history.redo.readbackM, edit.afterM, 1e-9)), "Redo did not restore the edited numeric value.");

  const persistence = requiredObject(evidence.persistence, "persistence");
  invariant(persistence.preserved === true && persistence.savedRevision === persistence.reopenedRevision, "Save/reopen did not preserve the Workspace revision.");
  invariant(persistence.savedComponentCount === persistence.reopenedComponentCount && persistence.savedComponentCount > 0, "Save/reopen did not preserve component count.");
  validateRealityTwinArtifactRelativePath(
    persistence.projectPath,
    ".semaframe.json",
    "Saved project path",
  );
  invariant(normalizeSha256(persistence.projectSha256, "persistence.projectSha256") === sha256(context.projectBytes), "Saved project digest does not match the reopened project artifact.");
  const project = JSON.parse(context.projectBytes.toString("utf8"));
  invariant(recursivelyContains(project, semantic.proxyId) && recursivelyContains(project, semantic.realityId), "Saved project does not contain both Reality and proxy components.");
  invariant(recursivelyContains(project, edit.afterM), "Saved project does not preserve the edited numeric value.");

  const model = requiredObject(evidence.model, "model");
  invariant(model.published === true && typeof model.modelId === "string" && typeof model.version === "string", "Reusable model publication evidence is missing.");
  invariant(model.digest === undefined, "Ambiguous legacy model.digest must be replaced by explicit toolDigest and contentSha256 receipts.");
  const modelReceipts = publishedModelReceipts(model.canonicalDefinition);
  invariant(model.toolDigest === modelReceipts.toolDigest,
    "Published model FNV tool digest differs from its canonical payload.");
  invariant(normalizeSha256(model.contentSha256, "model.contentSha256") === modelReceipts.contentSha256,
    "Published model canonical SHA-256 differs from its canonical payload.");
  invariant(model.canonicalDefinition.modelId === model.modelId
    && model.canonicalDefinition.version === model.version
    && model.canonicalDefinition.nodes?.length === model.nodeCount,
  "Published model canonical payload differs from the publication receipt.");
  const projectDefinitions = project.workspace?.modelDefinitions;
  invariant(Array.isArray(projectDefinitions), "Saved project has no canonical model-definition table.");
  const projectModelEntry = projectDefinitions.find(([key]) => key === `${model.modelId}@${model.version}`);
  invariant(Array.isArray(projectModelEntry) && projectModelEntry.length === 2,
    "Saved project omitted the published model definition.");
  invariant(stableCanonicalJson(projectModelEntry[1]) === stableCanonicalJson(model.canonicalDefinition),
    "Published model canonical payload differs from the saved project definition.");
  invariant(Number.isSafeInteger(model.publishedRevision) && model.publishedRevision > 0, "Published model revision is invalid.");
  invariant(Number.isSafeInteger(model.nodeCount) && model.nodeCount >= 2, "Published model must be multipart.");
  invariant(model.sourceRootId !== model.instanceRootId && model.editableInstance === true, "Published model instance is not independently editable.");
  const publishedTypes = model.publishedSubtree?.rootType
    ? [model.publishedSubtree.rootType]
    : model.publishedSubtreeTypes;
  invariant(Array.isArray(publishedTypes) && publishedTypes.some((type) => ["model-assembly", "spatial-primitive"].includes(type)), "Published subtree is not a model assembly or spatial primitive.");
  const excludesReality = model.publishedSubtree?.excludesReality ?? model.excludesReality;
  const containsReality = model.publishedSubtree?.containsReality ?? model.containsReality;
  invariant(model.publishedSubtree?.contentClass === "protective_case_model"
    && model.sourceRootId !== semantic.proxyId
    && excludesReality === true
    && containsReality === false
    && !publishedTypes.includes("gaussian-splat"),
  "Published protective-case model must be distinguished from the semantic proxy and exclude Gaussian Reality.");

  const usda = requiredObject(evidence.exports?.usda, "exports.usda");
  invariant(usda.validOpenUsd === true && usda.freshExport === true, "USDA is not marked as a fresh valid OpenUSD export.");
  invariant(usda.captureRunId === evidence.captureRunId, "USDA export belongs to a different capture run.");
  invariant(usda.sourceModelDigest === undefined
    && usda.sourceModelToolDigest === model.toolDigest
    && normalizeSha256(usda.sourceModelContentSha256, "exports.usda.sourceModelContentSha256") === model.contentSha256,
  "USDA export is not bound to both published-model digest receipts.");
  invariant(usda.sourceWorkspaceRevision === model.publishedRevision, "USDA export is not bound to the published model revision.");
  const exportedMs = isoTimestamp(usda.exportedAt, "exports.usda.exportedAt");
  invariant(exportedMs >= runStartedMs && exportedMs <= runCompletedMs, "USDA export timestamp falls outside the capture run.");
  invariant(Number.isFinite(context.usdaModifiedMs) && Math.abs(context.usdaModifiedMs - exportedMs) <= 10_000, "USDA filesystem timestamp does not match the recorded fresh export.");
  invariant(typeof usda.filename === "string" && usda.filename.endsWith(".usda"), "USDA filename is invalid.");
  validateRealityTwinArtifactRelativePath(usda.artifactPath, ".usda", "USDA artifact path");
  invariant(usda.artifactPath.endsWith(`/${usda.filename}`), "USDA artifact path is invalid.");
  invariant(usda.artifactPath === context.usdaPath, "USDA evidence path differs from the verified artifact path.");
  invariant(usda.byteLength === context.usdaBytes.byteLength, "USDA byte length differs from the fresh artifact.");
  invariant(normalizeSha256(usda.sha256, "exports.usda.sha256") === sha256(context.usdaBytes), "USDA digest differs from the fresh artifact.");
  const usdaText = context.usdaBytes.toString("utf8");
  invariant(/^#usda 1\.0/mu.test(usdaText) && /metersPerUnit\s*=\s*1/iu.test(usdaText) && /upAxis\s*=\s*"Y"/u.test(usdaText), "USDA stage metadata is invalid.");
  invariant(/def (?:Xform|Scope|Cube|Mesh) /u.test(usdaText), "USDA contains no published protective-case model prims.");
  invariant(!/\.ply\b|Gaussian|splat/iu.test(usdaText), "USDA incorrectly contains the Gaussian representation.");
  const checker = requiredObject(usda.usdchecker, "exports.usda.usdchecker");
  invariant(typeof checker.executable === "string" && checker.executable.includes("usdchecker"), "Recorded usdchecker executable is missing.");
  const checkerArguments = checker.args ?? checker.arguments;
  invariant(Array.isArray(checkerArguments) && checkerArguments.some((argument) => String(argument).endsWith(".usda")), "Recorded usdchecker arguments do not identify the USDA.");
  invariant(checker.exitCode === 0 && (checker.signal === null || checker.signal === undefined), "Recorded usdchecker did not exit successfully.");
  invariant(typeof checker.stdout === "string" && typeof checker.stderr === "string", "Recorded usdchecker output is incomplete.");

  const captures = requiredObject(evidence.captures, "captures");
  invariant(captures.viewport?.width === 1920 && captures.viewport?.height === 1080 && captures.viewport?.fps === 30, "Capture viewport must be 1920x1080 at 30 fps.");
  const browserGraphics = requiredObject(captures.browserGraphics, "captures.browserGraphics");
  invariant(browserGraphics.webgl2 === true && browserGraphics.api === "webgl2", "Capture browser must explicitly prove a WebGL2 graphics context.");
  invariant(browserGraphics.hardwareAccelerated === true, "Capture browser must explicitly prove hardware acceleration.");
  invariant(browserGraphics.softwareRenderer === false, "Capture browser must explicitly deny a software renderer.");
  invariant(typeof browserGraphics.renderer === "string" && browserGraphics.renderer.trim().length > 0, "Capture browser renderer identity is missing.");
  invariant(!/swiftshader|software/iu.test(browserGraphics.renderer), "Capture browser renderer identity indicates SwiftShader or software rendering.");
  invariant(JSON.stringify(captures.frameCounts) === JSON.stringify(EXPECTED_CAPTURE_FOLDERS), "Capture evidence frame counts differ from the visual contract.");
  invariant(Array.isArray(captures.sequences) && JSON.stringify(captures.sequences) === JSON.stringify(Object.keys(EXPECTED_CAPTURE_FOLDERS)), "Capture evidence sequence order or identity changed.");
  return {
    importedDigest,
    calibrationRevision: calibration.workspaceRevision,
    independentResidualM: independent.residualM,
    rejectedRevision: collision.revisionBeforeRejection,
    savedRevision: persistence.savedRevision,
    modelId: model.modelId,
    usdaSha256: sha256(context.usdaBytes),
  };
}

function jpegDimensions(buffer) {
  invariant(buffer[0] === 0xff && buffer[1] === 0xd8, "Invalid JPEG signature.");
  let offset = 2;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = buffer.readUInt16BE(offset);
    invariant(length >= 2, "Invalid JPEG segment length.");
    if (sof.has(marker)) return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    offset += length;
  }
  throw new Error("JPEG dimensions were not found.");
}

function pngDimensions(buffer) {
  invariant(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Invalid PNG signature.");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function imageDimensions(path) {
  const bytes = readFileSync(path);
  return bytes[0] === 0x89 ? pngDimensions(bytes) : jpegDimensions(bytes);
}

export function analyzeCaptureSamples(buffer, frameSize, expectedFrames, label = "capture sequence") {
  invariant(buffer.length === frameSize * expectedFrames, `${label} decoded sample count is incomplete.`);
  const hashes = new Set();
  let changedTransitions = 0;
  let minimumStandardDeviation = Number.POSITIVE_INFINITY;
  let previous = null;
  for (let frame = 0; frame < expectedFrames; frame += 1) {
    const sample = buffer.subarray(frame * frameSize, (frame + 1) * frameSize);
    hashes.add(sha256(sample));
    let sum = 0;
    for (const value of sample) sum += value;
    const mean = sum / sample.length;
    let variance = 0;
    for (const value of sample) variance += (value - mean) ** 2;
    minimumStandardDeviation = Math.min(minimumStandardDeviation, Math.sqrt(variance / sample.length));
    if (previous) {
      let absoluteDifference = 0;
      for (let index = 0; index < sample.length; index += 1) absoluteDifference += Math.abs(sample[index] - previous[index]);
      if (absoluteDifference / sample.length >= 0.25) changedTransitions += 1;
    }
    previous = sample;
  }
  const minimumUniqueFrames = Math.max(3, Math.ceil(expectedFrames * 0.05));
  const minimumChangedTransitions = Math.max(2, Math.ceil((expectedFrames - 1) * 0.04));
  invariant(minimumStandardDeviation >= 4, `${label} contains a visually flat frame.`);
  invariant(hashes.size >= minimumUniqueFrames, `${label} lacks source-frame evolution.`);
  invariant(changedTransitions >= minimumChangedTransitions, `${label} contains too few meaningful frame changes.`);
  return { uniqueFrames: hashes.size, changedTransitions, minimumStandardDeviation };
}

export function computeCaptureManifest(root, contract, options = {}) {
  const entries = [];
  const analyses = {};
  const dimensions = contract.source.captureDimensions;
  for (const [folder, frameCount] of Object.entries(EXPECTED_CAPTURE_FOLDERS)) {
    const directory = resolve(root, contract.source.assetRoot, folder);
    invariant(existsSync(directory), `Missing Reality Twin capture folder ${relative(root, directory)}.`);
    const actual = readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".jpg")).sort();
    const expected = expectedFrameNames(frameCount);
    invariant(JSON.stringify(actual) === JSON.stringify(expected), `${folder} must contain exactly ${frameCount} contiguous JPEG frames.`);
    for (const name of actual) {
      const path = join(directory, name);
      const size = imageDimensions(path);
      invariant(size.width === dimensions.width && size.height === dimensions.height, `${folder}/${name} must be ${dimensions.width}x${dimensions.height}.`);
      const relativePath = relative(root, path);
      entries.push(`${relativePath}:${sha256File(path).slice("sha256:".length)}`);
    }
    if (options.analyzeFrames !== false) {
      const raw = run("ffmpeg", [
        "-v", "error",
        "-framerate", "30",
        "-start_number", "0",
        "-i", join(directory, "frame-%04d.jpg"),
        "-frames:v", String(frameCount),
        "-vf", "scale=96:54:flags=area,format=gray",
        "-f", "rawvideo",
        "-pix_fmt", "gray",
        "pipe:1",
      ], `${folder} source analysis`, { cwd: root, encoding: null }).stdout;
      analyses[folder] = analyzeCaptureSamples(raw, 96 * 54, frameCount, folder);
    }
  }
  return {
    fileCount: entries.length,
    hash: sha256(entries.join("\n")),
    files: entries.map((entry) => entry.slice(0, entry.lastIndexOf(":"))),
    analyses,
  };
}

export function validateMediaProbe(probe, expected, label = "video") {
  const streams = probe.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  invariant(video?.codec_name === "h264", `${label} must use H.264.`);
  invariant(video.width === expected.width && video.height === expected.height, `${label} dimensions are invalid.`);
  invariant(video.pix_fmt === "yuv420p", `${label} must use yuv420p.`);
  invariant(video.r_frame_rate === "30/1" && video.avg_frame_rate === "30/1", `${label} must be constant 30 fps.`);
  invariant(Number(video.nb_read_frames ?? video.nb_frames) === expected.durationFrames, `${label} decoded frame count is invalid.`);
  invariant(Math.abs(Number(probe.format?.duration) - expected.durationSeconds) <= 0.08, `${label} duration is invalid.`);
  invariant(video.color_range === "tv" && video.color_space === "bt709" && video.color_transfer === "bt709" && video.color_primaries === "bt709", `${label} must be limited-range BT.709.`);
  if (audio) {
    invariant(audio.codec_name === "aac", `${label} audio must be AAC when present.`);
    invariant(String(audio.sample_rate) === "48000" && audio.channels === 2, `${label} audio must be 48 kHz stereo when present.`);
  }
  return { video, audio: audio ?? null };
}

export function validateLumaAnalysis(analysis, label = "video") {
  invariant(analysis.blackSampleCount === 0 && analysis.maxBlackRunSeconds <= MAX_BLACK_RUN_SECONDS, `${label} contains a black run.`);
  invariant(analysis.maxFrozenRunSeconds <= MAX_FROZEN_RUN_SECONDS, `${label} contains a frozen run longer than ${MAX_FROZEN_RUN_SECONDS}s.`);
  invariant(analysis.meanLuma.average >= 10 && analysis.meanLuma.average <= 245, `${label} has implausible average luma.`);
  invariant(analysis.meanLuma.maximum - analysis.meanLuma.minimum >= 4, `${label} lacks meaningful visual evolution.`);
  invariant(analysis.minimumFrameStandardDeviation >= 6, `${label} contains a visually flat sampled frame.`);
  return analysis;
}

export function assertArtifactFreshness({ label, artifactModifiedMs, dependencies }) {
  for (const dependency of dependencies) {
    invariant(artifactModifiedMs >= dependency.modifiedMs, `${label} predates ${dependency.label}.`);
  }
}

function ffprobe(path) {
  return JSON.parse(run("ffprobe", [
    "-v", "error",
    "-count_frames",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,nb_frames,color_range,color_space,color_transfer,color_primaries,sample_rate,channels",
    "-of", "json",
    path,
  ], `${basename(path)} ffprobe`).stdout);
}

function verifyFastStart(path) {
  const atoms = readTopLevelMp4Atoms(path);
  const moov = atoms.findIndex((atom) => atom.type === "moov");
  const mdat = atoms.findIndex((atom) => atom.type === "mdat");
  invariant(moov >= 0 && mdat >= 0 && moov < mdat, `${basename(path)} must be a fast-start MP4.`);
  return true;
}

function sampleVideo(path, expected) {
  const sample = expected.width > expected.height ? SAMPLE_LANDSCAPE : SAMPLE_VERTICAL;
  const raw = run("ffmpeg", [
    "-v", "error",
    "-i", path,
    "-vf", `fps=${SAMPLE_FPS},scale=${sample.width}:${sample.height}:flags=area,format=gray`,
    "-an",
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "pipe:1",
  ], `${basename(path)} luma analysis`, { encoding: null }).stdout;
  const analysis = analyzeSampleBuffer(raw, sample.width * sample.height, SAMPLE_FPS);
  invariant(analysis.sampleCount >= expected.durationSeconds * SAMPLE_FPS - 1, `${basename(path)} produced too few luma samples.`);
  return validateLumaAnalysis(analysis, basename(path));
}

function samplePoster(path, expected) {
  const sample = expected.width > expected.height ? SAMPLE_LANDSCAPE : SAMPLE_VERTICAL;
  const raw = run("ffmpeg", [
    "-v", "error",
    "-i", path,
    "-vf", `scale=${sample.width}:${sample.height}:flags=area,format=gray`,
    "-frames:v", "1",
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "pipe:1",
  ], `${basename(path)} poster analysis`, { encoding: null }).stdout;
  const analysis = analyzeSampleBuffer(raw, sample.width * sample.height, 1);
  invariant(analysis.sampleCount === 1 && analysis.meanLuma.average >= 8 && analysis.meanLuma.average <= 247, `${basename(path)} poster luma is invalid.`);
  invariant(analysis.minimumFrameStandardDeviation >= 8, `${basename(path)} poster is visually flat.`);
  return analysis;
}

function verifyDelivery(root, variant, contract, dependencies) {
  const expected = EXPECTED_DELIVERIES[variant];
  const delivery = contract.delivery[variant];
  const videoPath = resolve(root, delivery.suggestedVideoPath);
  const posterPath = resolve(root, delivery.suggestedPosterPath);
  invariant(existsSync(videoPath), `${variant} Reality Twin MP4 is missing.`);
  invariant(existsSync(posterPath), `${variant} Reality Twin poster is missing.`);
  assertArtifactFreshness({
    label: relative(root, videoPath),
    artifactModifiedMs: statSync(videoPath).mtimeMs,
    dependencies: dependencies.video,
  });
  assertArtifactFreshness({
    label: relative(root, posterPath),
    artifactModifiedMs: statSync(posterPath).mtimeMs,
    dependencies: dependencies.poster,
  });
  const probe = ffprobe(videoPath);
  const streams = validateMediaProbe(probe, expected, `${variant} Reality Twin MP4`);
  const posterProbe = ffprobe(posterPath);
  const posterVideo = posterProbe.streams?.find((stream) => stream.codec_type === "video");
  invariant(posterVideo?.codec_name === "png" && posterVideo.width === expected.width && posterVideo.height === expected.height, `${variant} poster must be an exact-dimension PNG.`);
  return {
    video: {
      path: relative(root, videoPath),
      sha256: sha256File(videoPath),
      width: streams.video.width,
      height: streams.video.height,
      decodedFrames: Number(streams.video.nb_read_frames ?? streams.video.nb_frames),
      durationSeconds: Number(probe.format.duration),
      codec: streams.video.codec_name,
      audio: streams.audio ? { codec: streams.audio.codec_name, sampleRate: Number(streams.audio.sample_rate), channels: streams.audio.channels } : null,
      fastStart: verifyFastStart(videoPath),
      luma: sampleVideo(videoPath, expected),
    },
    poster: {
      path: relative(root, posterPath),
      sha256: sha256File(posterPath),
      width: posterVideo.width,
      height: posterVideo.height,
      luma: samplePoster(posterPath, expected),
    },
  };
}

export function verifyAssetFiles(root, assetEvidence, options = {}) {
  const sourceDirectory = resolve(root, "artifacts/reality-twin/source");
  invariant(existsSync(sourceDirectory), "Smithsonian source-GLB directory is missing.");
  const glbs = readdirSync(sourceDirectory).filter((name) => name.toLowerCase().endsWith(".glb")).sort();
  invariant(glbs.length === assetEvidence.retrieval.source_files.length, "Local source GLB count differs from asset evidence.");
  const actual = glbs.map((name) => {
    const path = join(sourceDirectory, name);
    return `${statSync(path).size}:${sha256File(path)}`;
  }).sort();
  const expected = assetEvidence.retrieval.source_files.map((file) => `${file.bytes}:${normalizeSha256(file.sha256, "source GLB digest")}`).sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected), "Local Smithsonian GLB bytes differ from asset evidence.");

  const plyPath = resolve(root, assetEvidence.derivedAsset.relativePath);
  invariant(existsSync(plyPath), "Derived Gaussian PLY is missing.");
  invariant(statSync(plyPath).size === assetEvidence.derivedAsset.byteLength, "Derived Gaussian PLY byte length changed.");
  invariant(sha256File(plyPath) === normalizeSha256(assetEvidence.derivedAsset.sha256, "derived PLY digest"), "Derived Gaussian PLY digest changed.");
  const header = readFileSync(plyPath).subarray(0, 4096).toString("ascii");
  invariant(/^ply\r?\nformat binary_little_endian 1\.0/mu.test(header), "Derived asset is not binary little-endian PLY 1.0.");
  invariant(new RegExp(`element vertex ${assetEvidence.derivedAsset.splatCount}\\b`, "u").test(header), "Derived PLY vertex count differs from asset evidence.");

  const persistedScreenshot = requiredObject(
    assetEvidence.validation?.spark_browser_import?.screenshot,
    "asset evidence persisted Spark screenshot",
  );
  invariant(persistedScreenshot.relative_path === "artifacts/reality-twin/qa/spark-render.png",
    "Asset evidence must bind the canonical Spark preview path.");
  const persistedPreviewPath = resolve(root, persistedScreenshot.relative_path);
  invariant(existsSync(persistedPreviewPath), "Canonical Spark preview is missing.");
  invariant(statSync(persistedPreviewPath).size === persistedScreenshot.bytes,
    "Canonical Spark preview byte length differs from asset evidence.");
  invariant(sha256File(persistedPreviewPath) === normalizeSha256(persistedScreenshot.sha256, "Spark preview digest"),
    "Canonical Spark preview digest differs from asset evidence.");

  const verifierPath = resolve(root, ASSET_VERIFIER_PATH);
  invariant(existsSync(verifierPath), "Reality Twin asset verifier is missing.");
  const protectedSnapshot = snapshotProtectedFiles([
    ...(options.protectedPaths ?? []),
    ...glbs.map((name) => join(sourceDirectory, name)),
    plyPath,
    persistedPreviewPath,
  ]);
  const verifierRunner = options.verifierRunner
    ?? ((command, args) => run(command, args, "Reality Twin asset verifier check-only", { cwd: root }));
  let verification;
  try {
    verification = verifierRunner(process.execPath, [verifierPath, "--check-only"]);
  } finally {
    assertProtectedFilesUnchanged(protectedSnapshot);
  }
  return { sourceGlbs: glbs.length, plyPath: relative(root, plyPath), verifierOutput: verification.stdout.trim() };
}

function resolveUsdChecker(recordedExecutable) {
  const candidates = [
    process.env.SEMAFRAME_USDCHECKER,
    recordedExecutable,
    "/usr/bin/usdchecker",
    "/usr/local/bin/usdchecker",
    "/opt/homebrew/bin/usdchecker",
  ].filter(Boolean);
  const checker = candidates.find((candidate) => existsSync(candidate));
  invariant(checker, "usdchecker is required for the final Reality Twin gate.");
  return checker;
}

function runUsdChecker(path, recordedExecutable) {
  const checker = resolveUsdChecker(recordedExecutable);
  const result = spawnSync(checker, [path], { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  invariant(!result.error, `usdchecker could not start: ${result.error?.message ?? "unknown error"}.`);
  invariant(result.status === 0, `usdchecker rejected ${basename(path)}: ${String(result.stderr || result.stdout).trim()}`);
  return { executable: checker, exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function buildVerificationReceipt({
  captureRunId,
  captureEvidenceSha256,
  contract,
  registration,
  provenance,
  evidence,
  captures,
  captions,
  usdchecker,
  media,
  claimBoundary,
  verifiedAt = new Date().toISOString(),
}) {
  invariant(typeof captureRunId === "string" && captureRunId.length >= 12, "Verification receipt captureRunId is missing.");
  const evidenceDigest = normalizeSha256(captureEvidenceSha256, "verification receipt captureEvidenceSha256");
  isoTimestamp(verifiedAt, "verification receipt verifiedAt");
  return {
    format: "semaframe-reality-twin-v1-verification",
    version: 1,
    result: "passed",
    verifiedAt,
    captureRunId,
    captureEvidenceSha256: evidenceDigest,
    contract,
    registration,
    provenance,
    evidence,
    captures,
    captions,
    usdchecker,
    media,
    claimBoundary,
  };
}

export function verifyRealityTwinV1(root = process.cwd()) {
  // Invalidate before even checking dependencies. A failed or interrupted new
  // attempt must never leave an earlier "passed" receipt looking current.
  invalidateVerificationReceipt(root);
  const contractPath = resolve(root, CONTRACT_PATH);
  const compositionPath = resolve(root, COMPOSITION_PATH);
  const rootSourcePath = resolve(root, ROOT_SOURCE_PATH);
  const assetEvidencePath = resolve(root, ASSET_EVIDENCE_PATH);
  const captureEvidencePath = resolve(root, CAPTURE_EVIDENCE_PATH);
  const captureFixturePath = resolve(root, CAPTURE_FIXTURE_PATH);
  for (const path of [contractPath, compositionPath, rootSourcePath, assetEvidencePath, captureEvidencePath, captureFixturePath]) invariant(existsSync(path), `Missing Reality Twin dependency ${relative(root, path)}.`);

  const contract = readJson(contractPath);
  const compositionSource = readFileSync(compositionPath, "utf8");
  const rootSource = readFileSync(rootSourcePath, "utf8");
  const assetEvidence = readJson(assetEvidencePath);
  const evidence = readJson(captureEvidencePath);
  const captureFixture = readJson(captureFixturePath);
  const contractSummary = validateVisualContract(contract, { compositionSource });
  const registration = validateRootRegistrations(rootSource, contract);
  const assetSummary = validateAssetEvidence(assetEvidence);

  const captions = {};
  const captionPaths = [];
  for (const [variant, expected] of Object.entries(EXPECTED_DELIVERIES)) {
    const path = resolve(root, contract.delivery[variant].captionPath);
    invariant(existsSync(path), `${variant} English SRT is missing.`);
    captionPaths.push(path);
    captions[variant] = {
      ...validateTimedTranscript(readFileSync(path, "utf8"), { id: `${variant}-en-US`, durationSeconds: expected.durationSeconds }),
      sha256: sha256File(path),
    };
  }

  const captureManifest = computeCaptureManifest(root, contract);
  const projectRelativePath = evidence.persistence?.projectPath ?? "";
  const usdaRelativePath = evidence.exports?.usda?.artifactPath ?? "";
  const projectPath = resolveRealityTwinArtifactPath(
    root,
    projectRelativePath,
    ".semaframe.json",
    "Saved Reality Twin project path",
  );
  const usdaPath = resolveRealityTwinArtifactPath(
    root,
    usdaRelativePath,
    ".usda",
    "Fresh Reality Twin USDA path",
  );
  invariant(existsSync(projectPath), "Saved Reality Twin project artifact is missing.");
  invariant(existsSync(usdaPath), "Fresh Reality Twin USDA artifact is missing.");
  const assetFiles = verifyAssetFiles(root, assetEvidence, {
    protectedPaths: [
      contractPath,
      compositionPath,
      rootSourcePath,
      assetEvidencePath,
      captureEvidencePath,
      captureFixturePath,
      ...captionPaths,
      ...captureManifest.files.map((path) => resolve(root, path)),
      resolve(root, "artifacts/reality-twin/qa/spark-render.png"),
      projectPath,
      usdaPath,
    ],
  });
  const evidenceSummary = validateCaptureEvidence(evidence, {
    assetEvidence,
    captureFixture,
    integrity: {
      visualContractSha256: sha256File(contractPath),
      compositionSourceSha256: sha256File(compositionPath),
      rootSourceSha256: sha256File(rootSourcePath),
      assetEvidenceSha256: sha256File(assetEvidencePath),
      landscapeCaptionSha256: captions.landscape.sha256,
      verticalCaptionSha256: captions.vertical.sha256,
    },
    captureManifest,
    projectBytes: readFileSync(projectPath),
    usdaBytes: readFileSync(usdaPath),
    usdaModifiedMs: statSync(usdaPath).mtimeMs,
    usdaPath: usdaRelativePath,
  });
  const liveUsdChecker = runUsdChecker(usdaPath, evidence.exports.usda.usdchecker.executable);

  const renderDependencyPaths = [
    compositionPath,
    rootSourcePath,
    ...captureManifest.files.map((path) => resolve(root, path)),
  ];
  const posterDependencies = renderDependencyPaths.map((path) => ({ label: relative(root, path), modifiedMs: statSync(path).mtimeMs }));
  const audioPath = resolve(root, "video/public/audio/semaframe-original-bed.wav");
  const videoDependencies = [
    ...posterDependencies,
    ...(existsSync(audioPath) ? [{ label: relative(root, audioPath), modifiedMs: statSync(audioPath).mtimeMs }] : []),
  ];
  const dependencies = { video: videoDependencies, poster: posterDependencies };
  const media = Object.fromEntries(Object.keys(EXPECTED_DELIVERIES).map((variant) => [variant, verifyDelivery(root, variant, contract, dependencies)]));

  const receipt = buildVerificationReceipt({
    captureRunId: evidence.captureRunId,
    captureEvidenceSha256: sha256File(captureEvidencePath),
    contract: contractSummary,
    registration,
    provenance: { ...assetSummary, ...assetFiles },
    evidence: evidenceSummary,
    captures: { fileCount: captureManifest.fileCount, sha256: captureManifest.hash, analyses: captureManifest.analyses },
    captions,
    usdchecker: liveUsdChecker,
    media,
    claimBoundary: contract.claimBoundary,
  });
  writeVerificationReceiptAtomic(root, receipt);
  return receipt;
}

export function main() {
  const receipt = verifyRealityTwinV1();
  console.log("Reality Twin V1 end-to-end verification passed.");
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`Reality Twin V1 verification FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
