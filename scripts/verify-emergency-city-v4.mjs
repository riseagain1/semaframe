import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { analyzeSampleBuffer, readTopLevelMp4Atoms } from "./verify-emergency-city-v3.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const captureRoot = join(repositoryRoot, "video/public/emergency-city");
const evidencePath = join(captureRoot, "evidence.json");
const plannerRoot = join(captureRoot, "planner/final");
const schemaPath = join(repositoryRoot, "scripts/emergency-city-plan.schema.json");
const plannerSourcePath = join(repositoryRoot, "scripts/emergency-city-real-planner.mjs");
const compositionSourcePath = join(repositoryRoot, "video/src/EmergencyCityProofV3.tsx");
const semanticOverlaySourcePath = join(repositoryRoot, "video/src/EmergencyCitySemanticLens.tsx");
const visualContractPath = join(repositoryRoot, "video/emergency-city-v4.visual-contract.json");
const verificationPath = join(repositoryRoot, "artifacts/semaframe-emergency-city-v4-verification.json");

const FRAME_CONTRACT = Object.freeze({
  "crisis-frames": 120,
  "prompt-frames": 60,
  "understand-frames": 90,
  "collision-frames": 120,
  "plan-frames": 90,
  "response-frames": 300,
  "undo-redo-frames": 90,
  "reopen-frames": 90,
  "final-frames": 150,
});

const OUTPUT_CONTRACT = Object.freeze({
  landscape: {
    videoPath: join(repositoryRoot, "artifacts/semaframe-emergency-city-v4.mp4"),
    posterPath: join(repositoryRoot, "artifacts/semaframe-emergency-city-v4-poster.png"),
    width: 1920,
    height: 1080,
    durationSeconds: 32,
    durationFrames: 960,
    productDeadlineFrame: 150,
    minimumSafeArea: { top: 54, right: 72, bottom: 54, left: 72 },
  },
  vertical: {
    videoPath: join(repositoryRoot, "artifacts/semaframe-emergency-city-v4-vertical.mp4"),
    posterPath: join(repositoryRoot, "artifacts/semaframe-emergency-city-v4-vertical-poster.png"),
    width: 1080,
    height: 1920,
    durationSeconds: 28,
    durationFrames: 840,
    productDeadlineFrame: 120,
    minimumSafeArea: { top: 120, right: 60, bottom: 180, left: 60 },
  },
});

const TIMED_TRANSCRIPT_CONTRACT = Object.freeze([
  { id: "landscape-en", path: join(repositoryRoot, "video/captions/semaframe-emergency-city-v4.en-US.srt"), variant: "landscape", durationSeconds: 32, language: "en" },
  { id: "landscape-zh", path: join(repositoryRoot, "video/captions/semaframe-emergency-city-v4.zh-CN.srt"), variant: "landscape", durationSeconds: 32, language: "zh" },
  { id: "vertical-en", path: join(repositoryRoot, "video/captions/semaframe-emergency-city-v4-vertical.en-US.srt"), variant: "vertical", durationSeconds: 28, language: "en" },
  { id: "vertical-zh", path: join(repositoryRoot, "video/captions/semaframe-emergency-city-v4-vertical.zh-CN.srt"), variant: "vertical", durationSeconds: 28, language: "zh" },
]);

const REQUIRED_COMPREHENSION_BEATS = Object.freeze([
  "crisis",
  "product_definition",
  "goal",
  "data_read",
  "space_read",
  "collision",
  "safe_plan",
  "confirm",
  "response",
  "resolution",
  "editability",
  "identity",
]);

const REQUIRED_NON_TEXT_OVERLAYS = Object.freeze([
  "semantic-model",
  "data-readout",
  "space-scan",
  "collision-mark",
  "safe-plan-checks",
  "confirm-pointer",
  "action-fanout",
  "history-states",
]);

const EXPECTED_BEAT_RANGES = Object.freeze({
  landscape: Object.freeze([
    ["crisis", 0, 75], ["product_definition", 75, 150], ["goal", 150, 210],
    ["data_read", 210, 285], ["space_read", 285, 360], ["collision", 360, 450],
    ["safe_plan", 450, 525], ["confirm", 525, 585], ["response", 585, 735],
    ["resolution", 735, 795], ["editability", 795, 885], ["identity", 885, 960],
  ]),
  vertical: Object.freeze([
    ["crisis", 0, 60], ["product_definition", 60, 120], ["goal", 120, 180],
    ["data_read", 180, 240], ["space_read", 240, 300], ["collision", 300, 375],
    ["safe_plan", 375, 435], ["confirm", 435, 495], ["response", 495, 615],
    ["resolution", 615, 675], ["editability", 675, 765], ["identity", 765, 840],
  ]),
});

const EXPECTED_SOURCE_RANGES = Object.freeze({
  landscape: Object.freeze([
    ["crisis", 0, 75, "crisis-frames", 0, 119],
    ["product_definition", 75, 150, "understand-frames", 0, 44],
    ["goal", 150, 210, "prompt-frames", 0, 59],
    ["data_read", 210, 285, "understand-frames", 0, 44],
    ["space_read", 285, 360, "understand-frames", 45, 89],
    ["collision", 360, 450, "collision-frames", 0, 119],
    ["safe_plan", 450, 525, "plan-frames", 0, 89],
    ["confirm", 525, 585, "response-frames", 0, 44],
    ["response", 585, 735, "response-frames", 45, 219],
    ["resolution", 735, 795, "final-frames", 0, 74],
    ["undo", 795, 825, "undo-redo-frames", 0, 39],
    ["redo", 825, 855, "undo-redo-frames", 40, 89],
    ["reopen", 855, 885, "reopen-frames", 0, 89],
    ["identity", 885, 960, "final-frames", 30, 149],
  ]),
  vertical: Object.freeze([
    ["crisis", 0, 60, "crisis-frames", 0, 119],
    ["product_definition", 60, 120, "understand-frames", 0, 44],
    ["goal", 120, 180, "prompt-frames", 0, 59],
    ["data_read", 180, 240, "understand-frames", 0, 44],
    ["space_read", 240, 300, "understand-frames", 45, 89],
    ["collision", 300, 375, "collision-frames", 0, 119],
    ["safe_plan", 375, 435, "plan-frames", 0, 89],
    ["confirm", 435, 495, "response-frames", 0, 44],
    ["response", 495, 615, "response-frames", 45, 219],
    ["resolution", 615, 675, "final-frames", 0, 74],
    ["undo", 675, 705, "undo-redo-frames", 0, 39],
    ["redo", 705, 735, "undo-redo-frames", 40, 89],
    ["reopen", 735, 765, "reopen-frames", 0, 89],
    ["identity", 765, 840, "final-frames", 30, 149],
  ]),
});

const CLAIM_BOUNDARIES = Object.freeze({
  dataSource: "deterministic_host_normalized_inline_snapshot_not_live_network",
  collisionScope: "endpoint_preflight_and_final_state_not_continuous_path",
  rejectedCandidateAttribution: "host_scenario_candidate_not_model_first_attempt",
  physicsScope: "bounded_quasi_static_preflight_not_certification",
});

const SEMANTIC_TRUTH_CONTRACT = Object.freeze({
  dataReadout: Object.freeze({
    snapshotSecondary: "SOURCE DATA",
    roadSecondary: "PLANNER CONSTRAINT",
  }),
  actionFanOut: Object.freeze({
    landscapeLocalVisibleRange: Object.freeze({ startFrame: 0, endFrame: 42 }),
    verticalLocalVisibleRange: Object.freeze({ startFrame: 0, endFrame: 34 }),
    retiresBeforeCameraDrift: true,
  }),
  historyHighlight: Object.freeze({
    localTransitionFrames: Object.freeze([12, 40, 60]),
    states: Object.freeze(["OPEN", "BLOCKED", "OPEN", "REOPEN VERIFIED"]),
    labelsRevealTogether: true,
  }),
});

const OVERLAY_BEAT_BINDINGS = Object.freeze({
  "semantic-model": "product_definition",
  "data-readout": "data_read",
  "space-scan": "space_read",
  "collision-mark": "collision",
  "safe-plan-checks": "safe_plan",
  "confirm-pointer": "confirm",
});

const EXPECTED_ACTION_FAN_OUT_RANGES = Object.freeze({
  landscape: Object.freeze([585, 627]),
  vertical: Object.freeze([495, 529]),
});

const EXPECTED_HISTORY_HIGHLIGHT_RANGES = Object.freeze({
  landscape: Object.freeze([
    ["before-undo-open", 795, 807],
    ["undo-blocked", 807, 835],
    ["redo-open", 835, 855],
    ["reopen-verified", 855, 885],
  ]),
  vertical: Object.freeze([
    ["before-undo-open", 675, 687],
    ["undo-blocked", 687, 715],
    ["redo-open", 715, 735],
    ["reopen-verified", 735, 765],
  ]),
});

// These rectangles are conservative envelopes derived from the coordinates in
// EmergencyCityProofV3.tsx and EmergencyCitySemanticLens.tsx.  Multi-region
// entries avoid claiming an oversized swept union that would intersect text or
// safe margins even though the actual paths do not.
const EXPECTED_SOURCE_DERIVED_OVERLAY_REGIONS = Object.freeze({
  landscape: Object.freeze({
    "semantic-model": Object.freeze([["full-beat", 75, 150, 600, 238, 1160, 654]]),
    "data-readout": Object.freeze([["full-beat", 210, 285, 600, 158, 960, 565]]),
    "space-scan": Object.freeze([["full-beat", 285, 360, 600, 233, 1160, 667]]),
    "collision-mark": Object.freeze([["full-beat", 360, 450, 700, 290, 620, 500]]),
    "safe-plan-checks": Object.freeze([["full-beat", 450, 525, 75, 280, 370, 100]]),
    "confirm-pointer": Object.freeze([
      ["approach-early", 525, 555, 912, 738, 144, 234],
      ["approach-late", 555, 577, 898, 878, 90, 124],
      ["landed-pulse", 577, 585, 900, 910, 95, 112],
    ]),
    "action-fanout": Object.freeze([
      ["topology-and-labels", 585, 627, 400, 300, 1075, 510],
      ["commit-source-and-stems", 585, 627, 890, 788, 178, 238],
    ]),
    "history-states": Object.freeze([
      ["before-undo-open", 795, 807, 360, 765, 910, 110],
      ["undo-blocked", 807, 835, 360, 765, 910, 110],
      ["redo-open", 835, 855, 360, 765, 910, 110],
      ["reopen-verified", 855, 885, 360, 765, 910, 110],
    ]),
  }),
  vertical: Object.freeze({
    "semantic-model": Object.freeze([["full-beat", 60, 120, 250, 480, 710, 390]]),
    "data-readout": Object.freeze([["full-beat", 180, 240, 220, 445, 630, 330]]),
    "space-scan": Object.freeze([["full-beat", 240, 300, 250, 475, 710, 395]]),
    "collision-mark": Object.freeze([["full-beat", 300, 375, 200, 930, 680, 560]]),
    "safe-plan-checks": Object.freeze([["full-beat", 375, 435, 60, 340, 440, 110]]),
    "confirm-pointer": Object.freeze([
      ["approach-early", 435, 465, 568, 1044, 262, 286],
      ["approach-late", 465, 487, 530, 1216, 128, 152],
      ["landed-pulse", 487, 495, 365, 1085, 350, 355],
    ]),
    "action-fanout": Object.freeze([["full-beat", 495, 529, 120, 530, 820, 410]]),
    "history-states": Object.freeze([
      ["before-undo-open", 675, 687, 120, 1410, 900, 140],
      ["undo-blocked", 687, 715, 120, 1410, 900, 140],
      ["redo-open", 715, 735, 120, 1410, 900, 140],
      ["reopen-verified", 735, 765, 120, 1410, 900, 140],
    ]),
  }),
});

const SAMPLE_FPS = 5;
const SAMPLE_WIDTH = 160;
const SAMPLE_HEIGHT = 90;
const MAX_BLACK_RUN_SECONDS = 0.6;
const MAX_FROZEN_RUN_SECONDS = 2;

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertArtifactFreshness({ artifactLabel, artifactModifiedMs, dependencies }) {
  invariant(Number.isFinite(artifactModifiedMs), `${artifactLabel} must expose a finite modification time.`);
  invariant(Array.isArray(dependencies) && dependencies.length > 0, `${artifactLabel} must declare render dependencies.`);
  for (const dependency of dependencies) {
    invariant(typeof dependency?.label === "string" && dependency.label.length > 0, `${artifactLabel} has an unnamed render dependency.`);
    invariant(Number.isFinite(dependency.modifiedMs), `${artifactLabel} dependency ${dependency.label} must expose a finite modification time.`);
    invariant(
      artifactModifiedMs >= dependency.modifiedMs,
      `${artifactLabel} predates ${dependency.label}; re-render before verification.`,
    );
  }
  return {
    artifactModifiedAt: new Date(artifactModifiedMs).toISOString(),
    dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency.label, new Date(dependency.modifiedMs).toISOString()])),
  };
}

export function validateSemanticOverlaySource(sourceText) {
  invariant(typeof sourceText === "string" && sourceText.length > 0, "Semantic-overlay source must be non-empty.");
  invariant(/secondary:\s*"PLANNER CONSTRAINT"/u.test(sourceText), "Semantic-overlay source must identify road clearance as PLANNER CONSTRAINT.");
  invariant(
    /const anchoredDuration = Math\.min\(localDuration\(duration\), variant === "landscape" \? 42 : 34\);/u.test(sourceText),
    "Semantic-overlay source must retire fan-out at exact local end frames 42/34.",
  );
  invariant(
    /const undoAppliedFrame = 12;[\s\S]*const redoAppliedFrame = 40;[\s\S]*const reopenLoadedFrame = 60;/u.test(sourceText),
    "Semantic-overlay source must switch history highlight at exact local frames 12, 40, and 60.",
  );
  invariant(
    /const activeIndex = frame < undoAppliedFrame[\s\S]*frame < redoAppliedFrame[\s\S]*frame < reopenLoadedFrame/u.test(sourceText),
    "Semantic-overlay source must drive history highlight from the audited transition constants.",
  );
  const historySource = sourceText.slice(sourceText.indexOf("export const EmergencyCityRevisionPersistenceCues"));
  invariant(
    /labels\.map\(\(datum, index\) => \{[\s\S]*const progress = revealProgress\(frame, fps\);[\s\S]*opacity=\{progress \* exit \* \(activeIndex === index \? 1 : 0\.58\)\}/u.test(historySource),
    "Semantic-overlay source must reveal every revision label together while using index only for active-state opacity.",
  );
  invariant(
    !/const progress = revealProgress\(frame, fps, index\);/u.test(historySource),
    "Semantic-overlay source must not stagger revision-label reveal by array index.",
  );
  return {
    roadSecondary: "PLANNER CONSTRAINT",
    actionFanOutLocalEndFrames: { landscape: 42, vertical: 34 },
    historyHighlightLocalTransitionFrames: [12, 40, 60],
    historyLabelsRevealTogether: true,
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashJSON(value) {
  return sha256(canonicalJSON(value));
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function displayPath(path) {
  return relative(repositoryRoot, path);
}

function readJSON(path) {
  invariant(existsSync(path), `Missing JSON artifact: ${displayPath(path)}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    cwd: repositoryRoot,
  });
  invariant(!result.error, `${command} could not start: ${result.error?.message ?? "unknown error"}`);
  invariant(result.status === 0, `${command} failed (${result.status}): ${String(result.stderr ?? "").trim()}`);
  return result;
}

function probe(path, countFrames = false) {
  invariant(existsSync(path), `Missing media artifact: ${displayPath(path)}`);
  const result = run("ffprobe", [
    "-v", "error", ...(countFrames ? ["-count_frames"] : []),
    "-show_entries",
    "format=duration,format_name:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,sample_rate,channels,color_range,color_space,color_transfer,color_primaries",
    "-of", "json", path,
  ]);
  return JSON.parse(result.stdout);
}

function measureLoudness(path) {
  const result = run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", path,
    "-vn", "-af", "ebur128=peak=true", "-f", "null", "-",
  ]);
  const integrated = [...result.stderr.matchAll(/I:\s*(-?[0-9.]+)\s+LUFS/gu)].at(-1);
  const range = [...result.stderr.matchAll(/LRA:\s*([0-9.]+)\s+LU/gu)].at(-1);
  const peak = [...result.stderr.matchAll(/Peak:\s*(-?[0-9.]+)\s+dBFS/gu)].at(-1);
  invariant(integrated && range && peak, `${displayPath(path)} did not produce complete EBU R128 measurements.`);
  return { integratedLufs: Number(integrated[1]), loudnessRangeLu: Number(range[1]), truePeakDbfs: Number(peak[1]) };
}

function verifyFastStart(path) {
  const atoms = readTopLevelMp4Atoms(path);
  const moov = atoms.find((atom) => atom.type === "moov");
  const mdat = atoms.find((atom) => atom.type === "mdat");
  invariant(moov && mdat && moov.offset < mdat.offset, `${displayPath(path)} must be a fast-start MP4 with moov before mdat.`);
  return atoms.map((atom) => atom.type);
}

function sampleVideoLuma(path, durationSeconds, sourceWidth, sourceHeight) {
  const width = sourceWidth >= sourceHeight ? SAMPLE_WIDTH : SAMPLE_HEIGHT;
  const height = sourceWidth >= sourceHeight ? SAMPLE_HEIGHT : SAMPLE_WIDTH;
  const result = run("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `fps=${SAMPLE_FPS},scale=${width}:${height}:flags=area,format=gray`,
    "-an", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { encoding: null, maxBuffer: 128 * 1024 * 1024 });
  const analysis = analyzeSampleBuffer(result.stdout, width * height, SAMPLE_FPS);
  Object.assign(analysis, { sampleWidth: width, sampleHeight: height });
  invariant(analysis.sampleCount >= durationSeconds * SAMPLE_FPS - 1, `${displayPath(path)} produced too few luma samples.`);
  invariant(analysis.maxBlackRunSeconds < MAX_BLACK_RUN_SECONDS, `${displayPath(path)} contains a ${analysis.maxBlackRunSeconds.toFixed(1)}s black span.`);
  invariant(analysis.maxFrozenRunSeconds <= MAX_FROZEN_RUN_SECONDS, `${displayPath(path)} contains a ${analysis.maxFrozenRunSeconds.toFixed(1)}s frozen span.`);
  invariant(analysis.meanLuma.average >= 12 && analysis.meanLuma.average <= 243, `${displayPath(path)} has implausible average luma.`);
  invariant(analysis.meanLuma.maximum - analysis.meanLuma.minimum >= 5, `${displayPath(path)} lacks meaningful luma evolution.`);
  return analysis;
}

function sampleStillLuma(path, sourceWidth, sourceHeight) {
  const width = sourceWidth >= sourceHeight ? SAMPLE_WIDTH : SAMPLE_HEIGHT;
  const height = sourceWidth >= sourceHeight ? SAMPLE_HEIGHT : SAMPLE_WIDTH;
  const result = run("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `scale=${width}:${height}:flags=area,format=gray`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { encoding: null });
  const analysis = analyzeSampleBuffer(result.stdout, width * height, SAMPLE_FPS);
  invariant(analysis.sampleCount === 1, `${displayPath(path)} must decode as one poster frame.`);
  invariant(analysis.meanLuma.average >= 8 && analysis.meanLuma.average <= 247, `${displayPath(path)} poster luma is implausible.`);
  invariant(analysis.minimumFrameStandardDeviation >= 8, `${displayPath(path)} poster is blank or visually flat.`);
  return { meanLuma: analysis.meanLuma.average, standardDeviation: analysis.minimumFrameStandardDeviation, sampleWidth: width, sampleHeight: height };
}

function unicodeLength(value) {
  return Array.from(value.replace(/\s/gu, "")).length;
}

const FORBIDDEN_CLAIM_PATTERNS = Object.freeze([
  { pattern: /\blive\s+(?:data|feed|stream)\b/iu, label: "fake live-network data" },
  { pattern: /\breal[- ]?time\s+(?:data|feed|stream)\b/iu, label: "fake real-time network data" },
  { pattern: /(?:实时数据|实时馈送|实时数据流|联网实时)/u, label: "fake live-network data" },
  { pattern: /\b(?:continuous|full[- ]path|swept[- ]path)[^\n.]{0,28}(?:collision[- ]free|physics|validated)\b/iu, label: "continuous-physics overclaim" },
  { pattern: /(?:全程避障|全程无碰撞|连续(?:路径|物理)[^。\n]{0,12}(?:无碰撞|避障|验证)|动态仿真已验证)/u, label: "continuous-physics overclaim" },
  { pattern: /(?:AI(?:的)?第(?:一|1)个(?:方案|候选|位置)|AI['’]s first (?:plan|candidate|position))/iu, label: "unsupported rejected-candidate attribution" },
]);

export function assertTruthfulClaims(text, label = "visible copy") {
  for (const entry of FORBIDDEN_CLAIM_PATTERNS) {
    invariant(!entry.pattern.test(text), `${label} contains a ${entry.label} claim.`);
  }
}

function srtTimestampSeconds(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u.exec(value);
  invariant(match, `Invalid SRT timestamp ${value}.`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function validateTimedTranscript(contents, options) {
  const expectedCues = options.expectedCues;
  invariant(Array.isArray(expectedCues) && expectedCues.length === 13, `${options.id} must bind the 13 V4 cue definitions.`);
  const blocks = contents.trim().split(/\r?\n\r?\n+/gu);
  invariant(blocks.length === expectedCues.length, `${options.id} must contain exactly ${expectedCues.length} timed cues.`);
  let previousEnd = 0;
  let maximumCps = 0;
  let longestLine = 0;
  const allText = [];
  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/gu);
    const expected = expectedCues[index];
    invariant(lines[0] === String(index + 1), `${options.id} cue numbers must be contiguous.`);
    const timing = lines[1]?.split(" --> ");
    invariant(timing?.length === 2, `${options.id} cue ${index + 1} has invalid timing.`);
    const start = srtTimestampSeconds(timing[0]);
    const end = srtTimestampSeconds(timing[1]);
    const expectedStart = expected.startFrame / 30;
    const expectedEnd = expected.endFrame / 30;
    invariant(Math.abs(start - expectedStart) <= 0.002 && Math.abs(end - expectedEnd) <= 0.002, `${options.id} cue ${expected.id} does not match the frozen V4 frame timing.`);
    invariant(Math.abs(start - previousEnd) <= 0.002, `${options.id} has a gap or overlap before cue ${index + 1}.`);
    const textLines = lines.slice(2);
    invariant(canonicalJSON(textLines) === canonicalJSON(expected.text[options.language]), `${options.id} cue ${expected.id} text differs from the V4 visual contract.`);
    const text = textLines.join(" ");
    maximumCps = Math.max(maximumCps, unicodeLength(text) / (end - start));
    longestLine = Math.max(longestLine, ...textLines.map((line) => Array.from(line).length));
    allText.push(text);
    previousEnd = end;
  }
  invariant(Math.abs(previousEnd - options.durationSeconds) <= 0.002, `${options.id} must cover the complete master duration.`);
  invariant(maximumCps <= 25, `${options.id} exceeds 25 non-whitespace characters per second.`);
  invariant(longestLine <= 40, `${options.id} contains a line longer than 40 characters.`);
  assertTruthfulClaims(allText.join(" "), options.id);
  return { cueCount: blocks.length, maximumCps, longestLine, durationSeconds: previousEnd };
}

function verifyTimedTranscripts(contract) {
  return Object.fromEntries(TIMED_TRANSCRIPT_CONTRACT.map((entry) => [
    entry.id,
    validateTimedTranscript(readFileSync(entry.path, "utf8"), {
      ...entry,
      expectedCues: contract.timedTranscriptCues?.[entry.variant],
    }),
  ]));
}

function rectanglesIntersect(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function activeRangesOverlap(left, right) {
  return left.startFrame < right.endFrame && right.startFrame < left.endFrame;
}

function normalizeOverlayRegions(overlay) {
  return Array.isArray(overlay.regions)
    ? overlay.regions
    : [{ id: "full-beat", startFrame: overlay.startFrame, endFrame: overlay.endFrame, bounds: overlay.bounds }];
}

function overlayRegionSignature(regions) {
  return regions.map((region) => [
    region.id,
    region.startFrame,
    region.endFrame,
    region.bounds?.x,
    region.bounds?.y,
    region.bounds?.width,
    region.bounds?.height,
  ]);
}

function normalizeBeatRange(beat, variantName) {
  return beat.ranges?.[variantName] ?? null;
}

function stableRange(layer, textMotion) {
  const enterFrames = layer.kind === "primary"
    ? (layer.id === "goal-primary" ? Math.max(textMotion.titleEnterFrames, textMotion.goalTypingCompleteFrame) : textMotion.titleEnterFrames)
    : textMotion.proofEnterFrames;
  const exitFrames = layer.kind === "primary" ? textMotion.titleExitFrames : textMotion.proofExitFrames;
  return { startFrame: layer.startFrame + enterFrames, endFrame: layer.endFrame - exitFrames };
}

function assertBoundsWithinSafeArea(bounds, variant, expected, label) {
  invariant(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite), `${label} must declare finite bounds.`);
  invariant(bounds.width > 0 && bounds.height > 0, `${label} bounds must have positive dimensions.`);
  invariant(bounds.x >= variant.safeArea.left, `${label} violates the left safe area.`);
  invariant(bounds.y >= variant.safeArea.top, `${label} violates the top safe area.`);
  invariant(bounds.x + bounds.width <= expected.width - variant.safeArea.right, `${label} violates the right safe area.`);
  invariant(bounds.y + bounds.height <= expected.height - variant.safeArea.bottom, `${label} violates the bottom safe area.`);
}

export function validateVisualContract(contract, options = {}) {
  const expectedCompositionSourceHash = options.compositionSourceHash ?? hashFile(compositionSourcePath);
  const expectedSemanticOverlaySourceHash = options.semanticOverlaySourceHash ?? hashFile(semanticOverlaySourcePath);
  validateSemanticOverlaySource(options.semanticOverlaySourceText ?? readFileSync(semanticOverlaySourcePath, "utf8"));
  invariant(contract && typeof contract === "object" && !Array.isArray(contract), "V4 visual contract must be an object.");
  invariant(contract.version === "4.0", "V4 visual contract version must be 4.0.");
  invariant(contract.rangeSemantics === "startInclusiveEndExclusive", "V4 output ranges must be start-inclusive/end-exclusive.");
  invariant(contract.sourceRangeSemantics === "sourceStartInclusiveSourceEndInclusive", "V4 source ranges must use inclusive source endpoints.");
  invariant(contract.compositionSourcePath === "video/src/EmergencyCityProofV3.tsx", "V4 must remain linked to the shared EmergencyCityProofV3.tsx source.");
  invariant(/^sha256:[a-f0-9]{64}$/u.test(contract.compositionSourceSha256 ?? ""), "V4 contract must declare a prefixed composition SHA-256.");
  invariant(contract.compositionSourceSha256 === expectedCompositionSourceHash, "V4 visual contract is stale relative to EmergencyCityProofV3.tsx.");
  invariant(contract.semanticOverlaySourcePath === "video/src/EmergencyCitySemanticLens.tsx", "V4 must remain linked to EmergencyCitySemanticLens.tsx.");
  invariant(/^sha256:[a-f0-9]{64}$/u.test(contract.semanticOverlaySourceSha256 ?? ""), "V4 contract must declare a prefixed semantic-overlay SHA-256.");
  invariant(contract.semanticOverlaySourceSha256 === expectedSemanticOverlaySourceHash, "V4 visual contract is stale relative to EmergencyCitySemanticLens.tsx.");
  invariant(contract.silentFirst === true && contract.audioRequiredForComprehension === false, "V4 must remain silent-first and understandable without audio.");
  invariant(contract.timedCaptionFilesAreTranscriptsOnly === true && contract.masterRequiresTimedCaptions === false, "V4 transcripts must not be required visual layers.");
  invariant(canonicalJSON(contract.claimBoundaries) === canonicalJSON(CLAIM_BOUNDARIES), "V4 claim boundaries must remain fail-closed and exact.");
  invariant(canonicalJSON(contract.semanticTruthContract) === canonicalJSON(SEMANTIC_TRUTH_CONTRACT), "V4 semantic truth contract must preserve planner-constraint, anchored fan-out, and exact history-highlight semantics.");

  const textMotion = contract.textMotionContract;
  invariant(textMotion && [
    textMotion.titleEnterFrames, textMotion.titleExitFrames, textMotion.proofEnterFrames,
    textMotion.proofExitFrames, textMotion.goalTypingCompleteFrame, textMotion.minimumStableFrames,
  ].every((value) => Number.isInteger(value) && value >= 0), "V4 must declare non-negative integer text-motion timings.");
  invariant(textMotion.minimumStableFrames >= 45, "Every independent V4 title must be fully stable for at least 45 frames.");
  invariant(Array.isArray(contract.comprehensionBeats), "V4 must declare comprehensionBeats.");
  invariant(canonicalJSON(contract.comprehensionBeats.map((beat) => beat.id)) === canonicalJSON(REQUIRED_COMPREHENSION_BEATS), "V4 comprehension beat order is frozen.");
  invariant(contract.variants && typeof contract.variants === "object", "V4 must declare both variants.");
  invariant(contract.timedTranscriptCues && typeof contract.timedTranscriptCues === "object", "V4 must declare exact timed transcript cues.");

  const report = {};
  for (const [variantName, expected] of Object.entries(OUTPUT_CONTRACT)) {
    const variant = contract.variants[variantName];
    invariant(variant && typeof variant === "object", `V4 is missing ${variantName}.`);
    invariant(variant.width === expected.width && variant.height === expected.height, `${variantName} dimensions are incorrect.`);
    invariant(variant.fps === 30 && variant.durationFrames === expected.durationFrames, `${variantName} timing must remain ${expected.durationFrames} frames at 30 fps.`);
    invariant(variant.productComprehensionDeadlineFrame === expected.productDeadlineFrame, `${variantName} product-comprehension deadline must be frame ${expected.productDeadlineFrame}.`);
    invariant(variant.safeArea && typeof variant.safeArea === "object", `${variantName} must declare safeArea.`);
    for (const side of ["top", "right", "bottom", "left"]) {
      invariant(Number.isFinite(variant.safeArea[side]) && variant.safeArea[side] >= expected.minimumSafeArea[side], `${variantName} safeArea.${side} is below the delivery minimum.`);
    }
    invariant(Array.isArray(variant.layers) && variant.layers.length > 0, `${variantName} must declare visible layers.`);
    invariant(Array.isArray(variant.nonTextOverlays), `${variantName} must declare nonTextOverlays.`);
    invariant(Array.isArray(variant.sourceFrameRanges), `${variantName} must declare sourceFrameRanges.`);

    const expectedBeats = EXPECTED_BEAT_RANGES[variantName];
    const actualBeats = contract.comprehensionBeats.map((beat) => {
      const range = normalizeBeatRange(beat, variantName);
      return [beat.id, range?.startFrame, range?.endFrame];
    });
    invariant(canonicalJSON(actualBeats) === canonicalJSON(expectedBeats), `${variantName} comprehension timeline differs from the frozen V4 edit.`);

    const layerIds = variant.layers.map((layer) => layer?.id);
    invariant(new Set(layerIds).size === layerIds.length, `${variantName} layer IDs must be unique.`);
    for (const requiredLayer of ["product-name", "product-definition", "data-primary", "space-primary", "response-click-primary", "response-world-primary", "editability-primary"]) {
      invariant(layerIds.includes(requiredLayer), `${variantName} is missing required semantic layer ${requiredLayer}.`);
    }
    const visibleCopy = [];
    for (const layer of variant.layers) {
      const label = `${variantName}/${layer.id}`;
      invariant(typeof layer.id === "string" && layer.id.length > 0, `${variantName} has a layer without an ID.`);
      invariant(layer.kind === "primary" || layer.kind === "proof", `${label} must be primary or proof.`);
      invariant(typeof layer.text === "string" && layer.text.trim().length > 0, `${label} must declare visible text.`);
      visibleCopy.push(layer.text);
      if (layer.kind === "primary") {
        invariant(
          layer.text.split("\n").every((line) => unicodeLength(line) <= 18),
          `${label} primary line exceeds the 18-character maximum.`,
        );
      }
      invariant(Number.isInteger(layer.startFrame) && Number.isInteger(layer.endFrame), `${label} range must use integers.`);
      invariant(layer.startFrame >= 0 && layer.endFrame > layer.startFrame && layer.endFrame <= expected.durationFrames, `${label} range is outside the composition.`);
      const stable = stableRange(layer, textMotion);
      invariant(stable.endFrame - stable.startFrame >= textMotion.minimumStableFrames, `${label} does not provide ${textMotion.minimumStableFrames} fully stable frames.`);
      assertBoundsWithinSafeArea(layer.bounds, variant, expected, label);
    }
    assertTruthfulClaims(visibleCopy.join(" "), `${variantName} visual contract`);

    const productName = variant.layers.find((layer) => layer.id === "product-name");
    const productDefinition = variant.layers.find((layer) => layer.id === "product-definition");
    invariant(/SEMAFRAME/iu.test(productName.text), `${variantName} must name SemaFrame in the product-definition beat.`);
    invariant(/(?:3D.*工作区|3D.*workspace)/iu.test(productDefinition.text), `${variantName} must visibly define SemaFrame as a 3D workspace.`);
    const nameStable = stableRange(productName, textMotion);
    const definitionStable = stableRange(productDefinition, textMotion);
    const sharedStableStart = Math.max(nameStable.startFrame, definitionStable.startFrame);
    const sharedStableEnd = Math.min(nameStable.endFrame, definitionStable.endFrame, expected.productDeadlineFrame);
    invariant(sharedStableEnd - sharedStableStart >= textMotion.minimumStableFrames, `${variantName} product name and definition are not simultaneously stable by ${expected.productDeadlineFrame / 30}s.`);
    invariant(productName.endFrame <= expected.productDeadlineFrame && productDefinition.endFrame <= expected.productDeadlineFrame, `${variantName} product definition must be visible by ${expected.productDeadlineFrame / 30}s.`);
    const requiredVisibleSemantics = [
      ["data-proof", /只读/u, "read-only data"],
      ["space-proof", /碰撞体/u, "collision-volume spatial semantics"],
      ["space-proof", /可执行动作/u, "executable-action spatial semantics"],
      ["response-proof", /原子提交/u, "atomic action evidence"],
      ["editability-proof", /(?:撤销|UNDO)[^\n]{0,24}(?:恢复|REDO)[^\n]{0,24}(?:保存|SAVE)/iu, "history and persistence evidence"],
    ];
    for (const [layerId, pattern, description] of requiredVisibleSemantics) {
      const layer = variant.layers.find((entry) => entry.id === layerId);
      invariant(layer && pattern.test(layer.text), `${variantName}/${layerId} must visibly communicate ${description}.`);
    }

    for (let frame = 0; frame < expected.durationFrames; frame += 1) {
      const active = variant.layers.filter((layer) => frame >= layer.startFrame && frame < layer.endFrame);
      invariant(active.filter((layer) => layer.kind === "primary").length <= 1, `${variantName} has multiple primary lines at frame ${frame}.`);
      invariant(active.filter((layer) => layer.kind === "proof").length <= 1, `${variantName} has multiple proof layers at frame ${frame}.`);
      invariant(active.length <= 2, `${variantName} exceeds two simultaneous information layers at frame ${frame}.`);
    }
    for (let leftIndex = 0; leftIndex < variant.layers.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < variant.layers.length; rightIndex += 1) {
        const left = variant.layers[leftIndex];
        const right = variant.layers[rightIndex];
        invariant(!activeRangesOverlap(left, right) || !rectanglesIntersect(left.bounds, right.bounds), `${variantName}/${left.id} overlaps ${right.id} in time and screen space.`);
      }
    }

    const overlayIds = variant.nonTextOverlays.map((overlay) => overlay?.id);
    invariant(new Set(overlayIds).size === overlayIds.length, `${variantName} overlay IDs must be unique.`);
    for (const requiredOverlay of REQUIRED_NON_TEXT_OVERLAYS) {
      invariant(overlayIds.includes(requiredOverlay), `${variantName} is missing required overlay ${requiredOverlay}.`);
    }
    for (const overlay of variant.nonTextOverlays) {
      const label = `${variantName}/${overlay.id}`;
      invariant(overlay.safeAreaPolicy === "safe_area", `${label} must remain inside the safe area.`);
      const regions = normalizeOverlayRegions(overlay);
      invariant(regions.length > 0, `${label} must declare bounded regions.`);
      invariant(regions.every((region) => typeof region.id === "string" && region.id.length > 0), `${label} regions must have source-traceable IDs.`);
      invariant(new Set(regions.map((region) => region.id)).size === regions.length, `${label} region IDs must be unique.`);
      for (const [index, region] of regions.entries()) {
        const regionLabel = `${label}/region-${index + 1}`;
        invariant(Number.isInteger(region.startFrame) && Number.isInteger(region.endFrame), `${regionLabel} range must use integers.`);
        invariant(region.startFrame >= 0 && region.endFrame > region.startFrame && region.endFrame <= expected.durationFrames, `${regionLabel} range is outside the composition.`);
        assertBoundsWithinSafeArea(region.bounds, variant, expected, regionLabel);
        for (const layer of variant.layers) {
          invariant(!activeRangesOverlap(region, layer) || !rectanglesIntersect(region.bounds, layer.bounds), `${regionLabel} overlaps text layer ${layer.id}.`);
        }
      }
    }

    for (const [overlayId, beatId] of Object.entries(OVERLAY_BEAT_BINDINGS)) {
      const overlay = variant.nonTextOverlays.find((entry) => entry.id === overlayId);
      const beat = expectedBeats.find((entry) => entry[0] === beatId);
      const regions = normalizeOverlayRegions(overlay);
      invariant(Math.min(...regions.map((region) => region.startFrame)) === beat[1]
        && Math.max(...regions.map((region) => region.endFrame)) === beat[2], `${variantName}/${overlayId} must span its complete ${beatId} beat.`);
    }
    const actionFanOut = variant.nonTextOverlays.find((overlay) => overlay.id === "action-fanout");
    const actionFanOutRegions = normalizeOverlayRegions(actionFanOut);
    invariant(
      canonicalJSON([
        Math.min(...actionFanOutRegions.map((region) => region.startFrame)),
        Math.max(...actionFanOutRegions.map((region) => region.endFrame)),
      ]) === canonicalJSON(EXPECTED_ACTION_FAN_OUT_RANGES[variantName]),
      `${variantName}/action-fanout must use its exact source-visible range and retire before camera drift.`,
    );
    const history = variant.nonTextOverlays.find((overlay) => overlay.id === "history-states");
    invariant(
      canonicalJSON(normalizeOverlayRegions(history).map((region) => [region.id, region.startFrame, region.endFrame])) === canonicalJSON(EXPECTED_HISTORY_HIGHLIGHT_RANGES[variantName]),
      `${variantName}/history-states must switch highlight at exact local frames 12, 40, and 60.`,
    );
    for (const overlay of variant.nonTextOverlays) {
      invariant(
        canonicalJSON(overlayRegionSignature(normalizeOverlayRegions(overlay))) === canonicalJSON(EXPECTED_SOURCE_DERIVED_OVERLAY_REGIONS[variantName][overlay.id]),
        `${variantName}/${overlay.id} bounds differ from the source-derived V4 overlay geometry.`,
      );
    }

    const normalizedSourceRanges = variant.sourceFrameRanges.map((range) => [
      range.id, range.startFrame, range.endFrame, range.folder, range.sourceStart, range.sourceEnd,
    ]);
    invariant(canonicalJSON(normalizedSourceRanges) === canonicalJSON(EXPECTED_SOURCE_RANGES[variantName]), `${variantName} source ranges differ from the frozen V4 edit contract.`);
    for (const range of variant.sourceFrameRanges) {
      invariant(Object.hasOwn(FRAME_CONTRACT, range.folder), `${variantName}/${range.id} references an unknown source folder.`);
      invariant(Number.isInteger(range.sourceStart) && Number.isInteger(range.sourceEnd)
        && range.sourceStart >= 0 && range.sourceEnd >= range.sourceStart
        && range.sourceEnd < FRAME_CONTRACT[range.folder], `${variantName}/${range.id} source endpoints are invalid.`);
    }

    const transcriptCues = contract.timedTranscriptCues[variantName];
    invariant(Array.isArray(transcriptCues) && transcriptCues.length === 13, `${variantName} must declare exactly 13 transcript cues.`);
    let cueCursor = 0;
    for (const cue of transcriptCues) {
      invariant(cue.startFrame === cueCursor && cue.endFrame > cue.startFrame, `${variantName}/${cue.id} transcript timing must be contiguous.`);
      invariant(cue.endFrame <= expected.durationFrames, `${variantName}/${cue.id} transcript timing exceeds the composition.`);
      for (const language of ["zh", "en"]) {
        invariant(Array.isArray(cue.text?.[language]) && cue.text[language].length === 2, `${variantName}/${cue.id} must have exactly two ${language} transcript lines.`);
        invariant(cue.text[language].every((line) => typeof line === "string" && line.length > 0 && Array.from(line).length <= 40), `${variantName}/${cue.id} ${language} transcript lines must be non-empty and at most 40 characters.`);
      }
      const activePrimary = variant.layers.find((layer) => layer.kind === "primary" && layer.startFrame <= cue.startFrame && layer.endFrame >= cue.endFrame);
      const activeProof = variant.layers.find((layer) => layer.kind === "proof" && layer.startFrame <= cue.startFrame && layer.endFrame >= cue.endFrame);
      invariant(activePrimary && activeProof, `${variantName}/${cue.id} transcript cue must bind one complete primary and proof layer.`);
      invariant(
        cue.text.zh.some((line) => Array.from(line.replace(/[，。：“”·\s/+]/gu, "")).length >= 4),
        `${variantName}/${cue.id} Chinese transcript must contain substantive visible semantics.`,
      );
      assertTruthfulClaims([...cue.text.zh, ...cue.text.en].join(" "), `${variantName}/${cue.id} transcript contract`);
      cueCursor = cue.endFrame;
    }
    invariant(cueCursor === expected.durationFrames, `${variantName} transcript cues must cover the complete master.`);
    const transcriptById = Object.fromEntries(transcriptCues.map((cue) => [cue.id, [...cue.text.zh, ...cue.text.en].join(" ")]));
    const requiredTranscriptSemantics = [
      ["product_definition", /SEMAFRAME/iu, "the product name"],
      ["product_definition", /(?:3D工作区|3D workspace)/iu, "the 3D-workspace definition"],
      ["data_read", /(?:只读|read-only)/iu, "read-only snapshot authority"],
      ["space_read", /(?:碰撞体|collider)/iu, "collision-volume semantics"],
      ["collision", /(?:拒绝|rejected)[^\n]{0,32}(?:不变|unchanged)/iu, "rejection without mutation"],
      ["safe_plan", /5\/5/u, "five-of-five endpoint preflight"],
      ["confirm", /(?:(?:人确认|human confirms)[^\n]{0,24}11|11[^\n]{0,24}(?:人确认|human confirms))/iu, "human confirmation with 11 pending changes"],
      ["response_click", /11[^\n]{0,30}(?:原子提交|atomic commit)/iu, "11-action atomic commit"],
      ["resolution", /(?:0冲突|0 conflicts)/iu, "final zero-conflict state"],
      ["editability", /(?:(?:撤销|undo)[^\n]{0,48}(?:重开|reopen)|(?:重开|reopen)[^\n]{0,48}(?:撤销|undo))/iu, "Undo through Reopen persistence"],
      ["identity", /OPEN SOURCE ON GITHUB/iu, "the GitHub open-source callout"],
    ];
    for (const [cueId, pattern, description] of requiredTranscriptSemantics) {
      invariant(pattern.test(transcriptById[cueId] ?? ""), `${variantName}/${cueId} transcript must preserve ${description}.`);
    }

    if (Number.isInteger(options.rejectedRevisionBefore) && Number.isInteger(options.rejectedRevisionAfter)) {
      const collisionProof = variant.layers.find((layer) => layer.id === "collision-proof");
      invariant(options.rejectedRevisionBefore === options.rejectedRevisionAfter, "Rejected revision evidence must remain atomic.");
      invariant(/(?:(?:修订|场景)[^\n]{0,12}(?:未改变|不变|未改)|revision[^\n]{0,12}unchanged)/iu.test(collisionProof.text), `${variantName}/collision-proof must state that the revision or original scene was unchanged.`);
    }

    report[variantName] = {
      dimensions: `${variant.width}x${variant.height}`,
      durationFrames: variant.durationFrames,
      productComprehensionDeadlineFrame: variant.productComprehensionDeadlineFrame,
      safeArea: variant.safeArea,
      layerCount: variant.layers.length,
      primaryLayerCount: variant.layers.filter((layer) => layer.kind === "primary").length,
      proofLayerCount: variant.layers.filter((layer) => layer.kind === "proof").length,
      nonTextOverlayCount: variant.nonTextOverlays.length,
      sourceRangeCount: variant.sourceFrameRanges.length,
      comprehensionBeatCount: REQUIRED_COMPREHENSION_BEATS.length,
      timedTranscriptCueCount: transcriptCues.length,
    };
  }
  return report;
}

function verifyTraceIsToolFree(traceEvents) {
  invariant(traceEvents.length > 0, "The live Codex JSONL trace must not be empty.");
  const itemTypes = traceEvents.flatMap((event) => event?.item?.type ? [event.item.type] : []);
  const disallowed = itemTypes.filter((type) => /(?:tool|command|shell|file_change|web_search|mcp|function_call|computer)/iu.test(type));
  invariant(disallowed.length === 0, `Planner trace contains tool-capable item types: ${[...new Set(disallowed)].join(", ")}.`);
  invariant(traceEvents.some((event) => event.type === "item.completed" && event.item?.type === "agent_message"), "Planner trace must contain a completed model response.");
  return [...new Set(itemTypes)].sort();
}

function verifyPlannerAndWorkspace() {
  const evidence = readJSON(evidencePath);
  const plannerContext = readJSON(join(plannerRoot, "planner-context.json"));
  const plan = readJSON(join(plannerRoot, "emergency-plan.json"));
  const plannerManifest = readJSON(join(plannerRoot, "planner-run.json"));
  const truthWindow = readJSON(join(plannerRoot, "truth-window-events.json"));
  const hostReceipt = readJSON(join(plannerRoot, "host-validation-receipt.json"));
  const schema = readJSON(schemaPath);
  const rawTrace = readFileSync(join(plannerRoot, "codex-trace.raw.jsonl"), "utf8");
  const traceEvents = rawTrace.trim().split(/\r?\n/gu).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`Invalid planner JSONL event ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });

  invariant(evidence.syntheticBaseline === true, "The miniature city baseline must be explicitly synthetic.");
  invariant(evidence.workspace?.componentCount === 137, "Capture must contain exactly 137 editable components.");
  invariant(evidence.workspace?.foundationOperationCount === 37 && evidence.workspace?.atomicBuildOperationCount === 98, "Foundation/main build operation counts must remain 37/98.");
  const lifecycle = evidence.agentSessionLifecycle;
  const checkpoints = lifecycle?.checkpoints ?? [];
  invariant(lifecycle?.strategy === "rotate_through_approved_offer" && lifecycle?.rotationCount === 3 && checkpoints.length === 4, "Long capture must use exactly three approved-offer session rotations.");
  invariant(canonicalJSON(checkpoints.map((entry) => entry.phase)) === canonicalJSON(["initial", "before_live_planner", "after_live_planner", "after_response_capture"]), "Session rotations must remain at audited no-transaction checkpoints.");
  invariant(checkpoints.every((entry) => Number.isFinite(Date.parse(entry.issuedAt)) && Date.parse(entry.expiresAt) - Date.parse(entry.issuedAt) >= 25 * 60_000), "Every Workspace session must retain the normal lifetime.");
  invariant(lifecycle?.productDefaultTtlChanged === false && lifecycle?.approvalCredentialPersisted === false, "Capture must not weaken TTL or persist approval credentials.");
  invariant(!/(?:approval|session|transaction)_token|workspace_session_/iu.test(canonicalJSON(lifecycle)), "Session lifecycle evidence must not contain private credentials.");

  const snapshot = evidence.dispatchSnapshot;
  invariant(snapshot?.connectorType === "inline.snapshot" && snapshot?.authorizedScope === true && snapshot?.snapshotAuthority === "host_normalized", "Dispatch input must remain an authorized host-normalized inline snapshot.");
  invariant(snapshot?.readWasNonMutating === true && snapshot?.revisionBeforeRead === snapshot?.revisionAfterRead, "Dispatch snapshot read must be non-mutating.");
  invariant(snapshot?.initialEtaSeconds === 28 && snapshot?.initialClearanceM === 1.6 && snapshot?.requiredClearanceM === 3.2, "Opening dispatch values are inconsistent.");
  invariant(snapshot?.finalEtaSeconds === 11 && snapshot?.finalClearanceM === 3.8, "Resolved dispatch values are inconsistent.");
  invariant(snapshot?.finalOutcomeAuthority === "deterministic_synthetic_scenario" && snapshot?.finalOutcomeGeometryDerived === false, "Final feed values must disclose deterministic synthetic authority and no geometry derivation.");

  const rejection = evidence.rejectedEndpoint;
  invariant(rejection?.errorCode === "spatial_collision" && rejection?.preflightValid === false && rejection?.atomic === true, "Unsafe endpoint must fail atomically with spatial_collision.");
  invariant(Number.isInteger(rejection?.revisionBefore) && rejection.revisionAfter === rejection.revisionBefore, "Rejected endpoint must leave revision unchanged.");
  invariant((rejection.conflicts ?? []).length > 0, "Rejected endpoint must retain a real conflict receipt.");
  const preview = rejection.previewLifecycle;
  invariant(Array.isArray(preview?.componentIds) && preview.componentIds.length === 4 && new Set(preview.componentIds).size === 4, "Rejected preview must retain four unique components.");
  invariant(preview?.hostAuthoredCleanup === true && preview?.partOfModelPlan === false && preview?.dismissalStatus === "committed", "Preview cleanup must be host-authored, committed, and outside the model plan.");
  invariant(preview.dismissalRevision === rejection.revisionAfter + 1 && preview.planCameraRevision === preview.dismissalRevision + 1, "Preview cleanup and plan camera revisions must remain consecutive.");
  invariant(preview.planCameraRevision === evidence.planner?.hostPreflightRevision, "Planner authority must bind the post-cleanup camera revision.");
  for (const checkpoint of ["collapsedAfterDismissal", "collapsedAfterPlan", "collapsedAfterReopen"]) {
    const components = preview[checkpoint];
    invariant(Array.isArray(components) && components.length === 4 && components.every((entry) => preview.componentIds.includes(entry.componentId) && entry.visibility === "collapsed"), `All rejected-preview components must remain collapsed at ${checkpoint}.`);
  }
  invariant(preview.persistedAcrossSaveReopen === true, "Save/Open must preserve rejected-preview cleanup.");

  invariant(plannerManifest.mode === "live_codex" && plannerManifest.live_model === true && plannerManifest.hardcoded_fallback === false, "Delivered plan must come from live Codex with no hardcoded fallback.");
  invariant(plannerManifest.safety?.automatic_fixture_fallback === false, "Planner must prohibit automatic fixture fallback.");
  invariant(plannerManifest.safety?.model_working_directory_isolated_from_repository === true && plannerManifest.safety?.model_tool_use_allowed === false, "Planner must be repository-isolated and tool-free.");
  invariant(truthWindow.live_model === true && truthWindow.events?.some((event) => event.status === "schema_valid_preflight_pending"), "Truth window must identify live model output stopping before host preflight.");
  const traceItemTypes = verifyTraceIsToolFree(traceEvents);
  const plannerSource = readFileSync(plannerSourcePath, "utf8");
  for (const flag of ["--ephemeral", "--json", "--sandbox", "read-only", "--output-schema"]) invariant(plannerSource.includes(flag), `Planner implementation is missing ${flag}.`);

  invariant(plannerManifest.hashes.context === hashJSON(plannerContext), "Planner context SHA-256 mismatch.");
  invariant(plannerManifest.hashes.output_schema === hashJSON(schema), "Planner schema SHA-256 mismatch.");
  invariant(plannerManifest.hashes.plan === hashJSON(plan), "Planner plan SHA-256 mismatch.");
  invariant(plannerManifest.hashes.raw_trace === sha256(rawTrace), "Planner trace SHA-256 mismatch.");
  invariant(plannerManifest.hashes.truth_window_events === hashJSON(truthWindow), "Truth-window SHA-256 mismatch.");
  invariant(plannerManifest.run_hash === hashJSON({
    mode: plannerManifest.mode,
    live_model: plannerManifest.live_model,
    model: plannerManifest.model,
    context_hash: plannerManifest.hashes.context,
    schema_hash: plannerManifest.hashes.output_schema,
    prompt_hash: plannerManifest.hashes.prompt,
    plan_hash: plannerManifest.hashes.plan,
    trace_hash: plannerManifest.hashes.raw_trace,
  }), "Planner run hash mismatch.");
  invariant(canonicalJSON(plan.source) === canonicalJSON({
    workspace_id: plannerContext.authority.workspace_id,
    workspace_revision: plannerContext.authority.workspace_revision,
    registry_digest: plannerContext.authority.registry_digest,
    dispatch_snapshot_hash: plannerContext.authority.dispatch_snapshot_hash,
  }), "Plan source must exactly match authoritative context.");

  invariant(evidence.planner?.mode === "live_codex" && evidence.planner?.liveModel === true && evidence.planner?.hardcodedFallback === false, "Capture evidence must identify live Codex with no fallback.");
  invariant(evidence.planner?.runId === plannerManifest.run_id && evidence.planner?.runHash === plannerManifest.run_hash, "Capture/planner run identity mismatch.");
  invariant(evidence.planner?.vehicleToBayAssignmentSupplied === false && evidence.planner?.safeBayCandidateRegionsSupplied === true, "Host/model assignment boundary must remain explicit.");
  invariant(evidence.planner?.endpointCoordinatesAuthoredByModelWithinHostRegions === true && evidence.planner?.requiredEffectsDefinedByHostMission === true, "Model-coordinate and host-mission authority must remain explicit.");
  invariant(evidence.planner?.actionCountWasNotPresentedAsAnOpenDecision === true && evidence.planner?.hostMissionContractValidated === true, "Demo must not overstate action-count autonomy.");
  invariant(evidence.planner?.hostPreflightRevision === plan.source.workspace_revision && evidence.planner?.preflightRevisionAfter === plan.source.workspace_revision, "All endpoint preflights must use and preserve the plan revision.");
  invariant(evidence.planner?.dispatchSnapshotReadRevision === plan.source.workspace_revision && evidence.planner?.dispatchSnapshotReadRegistryDigest === plan.source.registry_digest, "Planner dispatch read must use exact plan authority.");
  invariant(evidence.planner?.successfulAttempt >= 1 && evidence.planner.successfulAttempt <= 3, "Successful planner attempt must remain bounded.");
  invariant(evidence.planner?.hostValidationReceiptHash === hashJSON(hostReceipt), "Host receipt hash mismatch.");
  invariant(hostReceipt.planner_run_id === plannerManifest.run_id && hostReceipt.planner_plan_hash === plannerManifest.hashes.plan, "Host receipt planner identity mismatch.");
  invariant(hostReceipt.validation_tool === "query_spatial_placement" && hostReceipt.all_endpoints_valid === true, "Host receipt must accept all endpoints via query_spatial_placement.");

  const actions = plan.control?.actions ?? [];
  const moves = actions.filter((action) => action.action === "move_to");
  const states = actions.filter((action) => action.action === "show" || action.action === "hide");
  invariant(actions.length === 11 && moves.length === 5 && states.length === 6, "Plan must contain exactly 11 actions: five moves and six visibility changes.");
  const preflights = evidence.validatedPlan?.safePreflights ?? [];
  invariant(preflights.length === 5 && new Set(preflights.map((entry) => entry.actionId)).size === 5, "Five endpoint preflight receipts must be unique.");
  invariant(canonicalJSON(hostReceipt.endpoint_receipts) === canonicalJSON(preflights), "Host/capture endpoint receipts must match exactly.");
  invariant(preflights.every((entry) => entry.valid === true && Array.isArray(entry.conflicts) && entry.conflicts.length === 0
    && entry.workspaceId === plan.source.workspace_id && entry.workspaceRevision === plan.source.workspace_revision
    && entry.registryDigest === plan.source.registry_digest), "Every endpoint must pass same-revision host preflight.");
  invariant(evidence.validatedPlan?.authoringSource === "codex_cli_live" && evidence.validatedPlan?.planActionCount === 11 && evidence.validatedPlan?.routeCount === 11, "All live-model actions must compile one-to-one to 11 routes.");

  const response = evidence.oneClickResponse;
  invariant(response?.pointerInput === true && response?.pressEventCount === 1, "Response must originate from exactly one real pointer click.");
  invariant(response?.revisionDelta === 1 && response.revisionAfter - response.revisionBefore === 1, "All 11 response actions must commit in one revision.");
  invariant(response?.movedEventCount === 5 && response?.routedVisibilityEventCount === 6 && response?.routedActionCount === 11, "One click must route five moves and six visibility actions.");
  invariant(evidence.undoRedo?.undoRevision === response.revisionBefore && evidence.undoRedo?.redoRevision === response.revisionAfter && evidence.undoRedo?.ambulanceRestored === true, "Undo/Redo must restore both pre-click and one-click states.");

  const reopened = evidence.saveReopen;
  invariant(reopened?.realUiSave === true && reopened?.realUiOpen === true, "Save/Open must use the exact real UI routes.");
  invariant(reopened?.savedRevision === reopened?.reopenedRevision, "Reopen must preserve revision.");
  invariant(reopened?.savedComponentCount === 137 && reopened.reopenedComponentCount === 137, "Reopen must preserve all 137 components.");
  invariant(reopened?.savedResourceCount === 1 && reopened.reopenedResourceCount === 1, "Reopen must preserve the authorized resource.");
  invariant(reopened?.savedConnectionCount === 13 && reopened.reopenedConnectionCount === 13, "Reopen must preserve 11 routes plus two resource bindings.");
  invariant(reopened?.ambulanceEndpointRestored === true && reopened?.dispatchSnapshotRestored === true, "Reopen must restore model endpoint and dispatch snapshot.");
  invariant(reopened?.modelRoutesRestoredExactly === true && reopened?.modelRouteCount === 11 && /^sha256:[a-f0-9]{64}$/u.test(reopened?.modelRoutesHash ?? ""), "Reopen must preserve all 11 model routes with an audit hash.");

  invariant(evidence.validation?.collisionConflictCount === 0, "Reopened city must have zero collision conflicts.");
  invariant(evidence.validation?.physicsFeasible === true && (evidence.validation?.physicsIssues ?? []).length === 0, "Bounded reopened physics preflight must be feasible with no issues.");
  invariant(evidence.validation?.physicsEnabledBodyCount > 0 && evidence.validation?.physicsKinematicBodyCount === 10, "Physics preflight must exercise enabled bodies and exactly 10 kinematic vehicle bodies.");

  invariant(evidence.capture?.width === 1920 && evidence.capture?.height === 1080 && evidence.capture?.fps === 30, "V4 must reuse the native 1920x1080 30fps capture.");
  invariant(evidence.capture?.durationSeconds === 37 && evidence.capture?.totalSourceFrames === 1110, "Source capture must remain exactly 37 seconds/1110 frames.");
  invariant(evidence.capture?.sourceFrameMapping === "one_source_image_per_30fps_output_frame" && evidence.capture?.nativeSourceResolution === true, "Source capture must preserve native one-image-per-frame evidence.");
  invariant(evidence.capture?.cameraStateAuthoredInWorkspace === true && evidence.capture?.projectedControlCropGuard === true, "Capture must preserve Workspace camera and projected-control crop guard.");
  invariant(evidence.capture?.webgl?.contextLost === false && evidence.capture?.stabilization === "two_requestAnimationFrame_then_webgl_finish_before_each_capture", "Capture must finish with healthy stabilized WebGL.");
  invariant(canonicalJSON(evidence.capture?.frameCounts) === canonicalJSON(FRAME_CONTRACT), "Source frame counts must exactly match the 1110-frame contract.");
  const surfaces = evidence.capture?.visualLayersM;
  invariant(surfaces?.plinthTopY - surfaces?.stageGroundTopY >= 0.2, "City plinth must remain separated from stage ground.");
  invariant(surfaces?.roadMainY - surfaces?.plinthTopY >= surfaces?.minimumOverlappingSurfaceGapM, "Main road must remain separated from plinth.");
  invariant(surfaces?.safeBayY - surfaces?.roadCrossY >= surfaces?.minimumOverlappingSurfaceGapM, "Safe bay must remain separated from crossing road.");
  invariant(surfaces?.routeBlockedY - surfaces?.roadCrossY >= surfaces?.minimumOverlappingSurfaceGapM, "Blocked route must remain separated from crossing road.");
  invariant(surfaces?.routeOpenY - surfaces?.routeBlockedY >= surfaces?.minimumOverlappingSurfaceGapM, "Open/blocked routes must not be coplanar.");

  for (const [folder, count] of Object.entries(FRAME_CONTRACT)) {
    const path = join(captureRoot, folder);
    invariant(existsSync(path), `Missing capture folder ${folder}.`);
    const frames = readdirSync(path).filter((name) => /^frame-\d{4}\.jpg$/u.test(name)).sort();
    invariant(frames.length === count, `${folder} has ${frames.length} frames; expected ${count}.`);
    frames.forEach((name, index) => invariant(name === `frame-${String(index).padStart(4, "0")}.jpg`, `${folder} is missing frame ${index}.`));
    for (const sample of [frames[0], frames[Math.floor(frames.length / 2)], frames.at(-1)]) {
      const stream = probe(join(path, sample)).streams?.find((entry) => entry.codec_type === "video");
      invariant(stream?.codec_name === "mjpeg" && stream.width === 1920 && stream.height === 1080, `${folder}/${sample} must be a 1920x1080 JPEG.`);
    }
    run("ffmpeg", ["-v", "error", "-framerate", "30", "-start_number", "0", "-i", join(path, "frame-%04d.jpg"), "-frames:v", String(count), "-f", "null", "-"]);
  }

  return { evidence, plannerManifest, traceItemTypes, actionCount: actions.length, moveCount: moves.length, stateActionCount: states.length, endpointPreflightCount: preflights.length };
}

function verifyVideo(variantName, visualContractReport) {
  const expected = OUTPUT_CONTRACT[variantName];
  invariant(existsSync(expected.videoPath), `Missing media artifact: ${displayPath(expected.videoPath)}`);
  invariant(existsSync(expected.posterPath), `Missing poster artifact: ${displayPath(expected.posterPath)}`);
  const videoFreshness = assertArtifactFreshness({
    artifactLabel: displayPath(expected.videoPath),
    artifactModifiedMs: statSync(expected.videoPath).mtimeMs,
    dependencies: [
      { label: displayPath(compositionSourcePath), modifiedMs: statSync(compositionSourcePath).mtimeMs },
      { label: displayPath(semanticOverlaySourcePath), modifiedMs: statSync(semanticOverlaySourcePath).mtimeMs },
    ],
  });
  const posterFreshness = assertArtifactFreshness({
    artifactLabel: displayPath(expected.posterPath),
    artifactModifiedMs: statSync(expected.posterPath).mtimeMs,
    dependencies: [{ label: displayPath(compositionSourcePath), modifiedMs: statSync(compositionSourcePath).mtimeMs }],
  });
  const media = probe(expected.videoPath, true);
  const video = media.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = media.streams?.find((stream) => stream.codec_type === "audio");
  invariant(video?.codec_name === "h264", `${variantName} must use H.264.`);
  invariant(video?.width === expected.width && video?.height === expected.height, `${variantName} dimensions are incorrect.`);
  invariant(video?.pix_fmt === "yuv420p", `${variantName} must use yuv420p.`);
  invariant(video?.r_frame_rate === "30/1" && video?.avg_frame_rate === "30/1", `${variantName} must be CFR 30.`);
  invariant(Number(video?.nb_read_frames) === expected.durationFrames, `${variantName} must decode exactly ${expected.durationFrames} frames.`);
  invariant(video?.color_range === "tv", `${variantName} must use limited-range levels.`);
  invariant(video?.color_space === "bt709" && video?.color_transfer === "bt709" && video?.color_primaries === "bt709", `${variantName} must be fully tagged BT.709.`);
  invariant(Math.abs(Number(media.format?.duration) - expected.durationSeconds) < 0.08, `${variantName} duration must be ${expected.durationSeconds}s.`);
  const atoms = verifyFastStart(expected.videoPath);
  const luma = sampleVideoLuma(expected.videoPath, expected.durationSeconds, expected.width, expected.height);

  let audio = null;
  if (audioStream) {
    invariant(audioStream.sample_rate === "48000" && audioStream.channels === 2, `${variantName} audio must be 48kHz stereo when present.`);
    audio = measureLoudness(expected.videoPath);
    invariant(audio.integratedLufs >= -16.5 && audio.integratedLufs <= -15.5, `${variantName} loudness must be -16 ±0.5 LUFS.`);
    invariant(audio.truePeakDbfs <= -1, `${variantName} true peak must not exceed -1 dBTP.`);
  }

  const posterProbe = probe(expected.posterPath);
  const poster = posterProbe.streams?.find((stream) => stream.codec_type === "video");
  invariant(poster?.codec_name === "png" && poster.width === expected.width && poster.height === expected.height, `${variantName} poster must be an exact-dimension PNG.`);
  return {
    width: video.width,
    height: video.height,
    durationSeconds: Number(media.format.duration),
    decodedFrames: Number(video.nb_read_frames),
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    frameRate: video.avg_frame_rate,
    color: { range: video.color_range, space: video.color_space, transfer: video.color_transfer, primaries: video.color_primaries },
    fastStart: atoms.indexOf("moov") < atoms.indexOf("mdat"),
    audio,
    luma,
    poster: { width: poster.width, height: poster.height, luma: sampleStillLuma(expected.posterPath, expected.width, expected.height) },
    sourceFreshness: { video: videoFreshness, poster: posterFreshness },
    visualLayers: visualContractReport[variantName],
  };
}

export function main() {
  if (existsSync(verificationPath)) unlinkSync(verificationPath);
  const proof = verifyPlannerAndWorkspace();
  const contract = readJSON(visualContractPath);
  const visualContract = validateVisualContract(contract, {
    rejectedRevisionBefore: proof.evidence.rejectedEndpoint.revisionBefore,
    rejectedRevisionAfter: proof.evidence.rejectedEndpoint.revisionAfter,
  });
  const timedTranscripts = verifyTimedTranscripts(contract);
  const media = Object.fromEntries(Object.keys(OUTPUT_CONTRACT).map((variantName) => [variantName, verifyVideo(variantName, visualContract)]));

  const verification = {
    verificationVersion: "4.0",
    result: "passed",
    verifiedAt: new Date().toISOString(),
    mutedFirst: {
      declared: true,
      audioRequiredForComprehension: false,
      comprehensionBeats: REQUIRED_COMPREHENSION_BEATS,
      productDefinitionDeadlines: { landscapeSeconds: 5, verticalSeconds: 4 },
      visualContract,
      compositionSourceSha256: contract.compositionSourceSha256,
      semanticOverlaySourceSha256: contract.semanticOverlaySourceSha256,
      semanticTruthContract: contract.semanticTruthContract,
      timedTranscripts,
    },
    planner: {
      runId: proof.plannerManifest.run_id,
      runHash: proof.plannerManifest.run_hash,
      model: proof.plannerManifest.model,
      liveModel: true,
      hardcodedFallback: false,
      isolated: true,
      toolFreeTraceItemTypes: proof.traceItemTypes,
      actionCount: proof.actionCount,
      moveCount: proof.moveCount,
      stateActionCount: proof.stateActionCount,
      endpointPreflightCount: proof.endpointPreflightCount,
    },
    workspace: {
      revision: proof.evidence.workspace.revision,
      componentCount: proof.evidence.workspace.componentCount,
      oneClickRevisionDelta: proof.evidence.oneClickResponse.revisionDelta,
      collisionConflicts: proof.evidence.validation.collisionConflictCount,
      physicsFeasible: proof.evidence.validation.physicsFeasible,
      physicsEnabledBodyCount: proof.evidence.validation.physicsEnabledBodyCount,
      physicsKinematicBodyCount: proof.evidence.validation.physicsKinematicBodyCount,
      undoRedoRestored: true,
      saveReopenRoutesPreserved: true,
      rejectedPreviewLifecyclePreserved: true,
    },
    sourceCapture: {
      width: proof.evidence.capture.width,
      height: proof.evidence.capture.height,
      fps: proof.evidence.capture.fps,
      decodedSourceFrames: proof.evidence.capture.totalSourceFrames,
      frameCounts: proof.evidence.capture.frameCounts,
    },
    media,
    hashes: {
      captureEvidence: hashFile(evidencePath),
      plannerRun: hashFile(join(plannerRoot, "planner-run.json")),
      hostValidationReceipt: hashFile(join(plannerRoot, "host-validation-receipt.json")),
      compositionSource: hashFile(compositionSourcePath),
      semanticOverlaySource: hashFile(semanticOverlaySourcePath),
      visualContract: hashFile(visualContractPath),
      landscapeVideo: hashFile(OUTPUT_CONTRACT.landscape.videoPath),
      landscapePoster: hashFile(OUTPUT_CONTRACT.landscape.posterPath),
      verticalVideo: hashFile(OUTPUT_CONTRACT.vertical.videoPath),
      verticalPoster: hashFile(OUTPUT_CONTRACT.vertical.posterPath),
      timedTranscripts: Object.fromEntries(TIMED_TRANSCRIPT_CONTRACT.map((entry) => [entry.id, hashFile(entry.path)])),
    },
  };

  const temporaryPath = `${verificationPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(verification, null, 2)}\n`);
  renameSync(temporaryPath, verificationPath);
  console.log("Emergency-city silent-first hero V4 verification passed.");
  console.log(JSON.stringify(verification, null, 2));
  return verification;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`Emergency-city V4 verification FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
