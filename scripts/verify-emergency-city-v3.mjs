import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const captureRoot = join(repositoryRoot, "video/public/emergency-city");
const evidencePath = join(captureRoot, "evidence.json");
const plannerRoot = join(captureRoot, "planner/final");
const schemaPath = join(repositoryRoot, "scripts/emergency-city-plan.schema.json");
const plannerSourcePath = join(repositoryRoot, "scripts/emergency-city-real-planner.mjs");
const compositionSourcePath = join(repositoryRoot, "video/src/EmergencyCityProofV3.tsx");
const visualContractPath = join(repositoryRoot, "video/emergency-city-v3.visual-contract.json");
const verificationPath = join(repositoryRoot, "artifacts/semaframe-emergency-city-v3-verification.json");

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
    videoPath: join(repositoryRoot, "artifacts/semaframe-emergency-city-v3.mp4"),
    posterPath: join(repositoryRoot, "artifacts/semaframe-emergency-city-v3-poster.png"),
    width: 1920,
    height: 1080,
    durationSeconds: 32,
    durationFrames: 960,
    minimumSafeArea: { top: 54, right: 72, bottom: 54, left: 72 },
  },
  vertical: {
    videoPath: join(repositoryRoot, "artifacts/semaframe-emergency-city-v3-vertical.mp4"),
    posterPath: join(repositoryRoot, "artifacts/semaframe-emergency-city-v3-vertical-poster.png"),
    width: 1080,
    height: 1920,
    durationSeconds: 28,
    durationFrames: 840,
    minimumSafeArea: { top: 120, right: 60, bottom: 180, left: 60 },
  },
});

const TIMED_TRANSCRIPT_CONTRACT = Object.freeze([
  { id: "landscape-en", path: join(repositoryRoot, "video/captions/semaframe-emergency-city-v3.en-US.srt"), durationSeconds: 32, language: "en" },
  { id: "landscape-zh", path: join(repositoryRoot, "video/captions/semaframe-emergency-city-v3.zh-CN.srt"), durationSeconds: 32, language: "zh" },
  { id: "vertical-en", path: join(repositoryRoot, "video/captions/semaframe-emergency-city-v3-vertical.en-US.srt"), durationSeconds: 28, language: "en" },
  { id: "vertical-zh", path: join(repositoryRoot, "video/captions/semaframe-emergency-city-v3-vertical.zh-CN.srt"), durationSeconds: 28, language: "zh" },
]);

const REQUIRED_COMPREHENSION_BEATS = Object.freeze([
  "crisis",
  "goal",
  "spatial_read",
  "collision_rejection",
  "safe_plan",
  "human_confirm",
  "response",
  "resolution",
  "editability",
  "identity",
]);

const REQUIRED_NON_TEXT_OVERLAYS = Object.freeze([
  "spatial-scan",
  "collision-mark",
  "safe-plan-checks",
  "confirm-pointer",
]);

const EXPECTED_SOURCE_RANGES = Object.freeze({
  landscape: Object.freeze([
    ["crisis", 0, 90, "crisis-frames", 0, 119],
    ["goal", 90, 165, "prompt-frames", 0, 59],
    ["spatial_read", 165, 255, "understand-frames", 0, 89],
    ["collision_rejection", 255, 360, "collision-frames", 0, 119],
    ["safe_plan", 360, 450, "plan-frames", 0, 89],
    ["human_confirm", 450, 510, "response-frames", 0, 44],
    ["response", 510, 675, "response-frames", 45, 219],
    ["resolution", 675, 750, "final-frames", 0, 74],
    ["undo", 750, 790, "undo-redo-frames", 0, 39],
    ["redo", 790, 830, "undo-redo-frames", 40, 89],
    ["reopen", 830, 870, "reopen-frames", 0, 89],
    ["identity", 870, 960, "final-frames", 30, 149],
  ]),
  vertical: Object.freeze([
    ["crisis", 0, 75, "crisis-frames", 0, 119],
    ["goal", 75, 135, "prompt-frames", 0, 59],
    ["spatial_read", 135, 210, "understand-frames", 0, 89],
    ["collision_rejection", 210, 300, "collision-frames", 0, 119],
    ["safe_plan", 300, 375, "plan-frames", 0, 89],
    ["human_confirm", 375, 435, "response-frames", 0, 44],
    ["response", 435, 575, "response-frames", 45, 219],
    ["resolution", 575, 645, "final-frames", 0, 74],
    ["undo", 645, 680, "undo-redo-frames", 0, 39],
    ["redo", 680, 715, "undo-redo-frames", 40, 89],
    ["reopen", 715, 750, "reopen-frames", 0, 89],
    ["identity", 750, 840, "final-frames", 30, 149],
  ]),
});

const SAMPLE_FPS = 5;
const SAMPLE_WIDTH = 160;
const SAMPLE_HEIGHT = 90;
const MAX_BLACK_RUN_SECONDS = 0.6;
const MAX_FROZEN_RUN_SECONDS = 2;
const FROZEN_MAD_THRESHOLD = 0.35;

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
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
  const encoding = Object.prototype.hasOwnProperty.call(options, "encoding") ? options.encoding : "utf8";
  const result = spawnSync(command, args, {
    encoding,
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
    "-v", "error",
    ...(countFrames ? ["-count_frames"] : []),
    "-show_entries",
    "format=duration,format_name:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,sample_rate,channels,color_range,color_space,color_transfer,color_primaries",
    "-of", "json",
    path,
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
  return {
    integratedLufs: Number(integrated[1]),
    loudnessRangeLu: Number(range[1]),
    truePeakDbfs: Number(peak[1]),
  };
}

function readUInt64BE(buffer, offset) {
  const value = buffer.readBigUInt64BE(offset);
  invariant(value <= BigInt(Number.MAX_SAFE_INTEGER), "MP4 atom size exceeds JavaScript's safe integer range.");
  return Number(value);
}

export function readTopLevelMp4Atoms(path) {
  const fd = openSync(path, "r");
  const fileSize = fstatSync(fd).size;
  const atoms = [];
  let offset = 0;
  try {
    while (offset + 8 <= fileSize && atoms.length < 10_000) {
      const header = Buffer.alloc(16);
      const bytesRead = readSync(fd, header, 0, 16, offset);
      invariant(bytesRead >= 8, `Truncated MP4 atom header at byte ${offset}.`);
      let size = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerSize = 8;
      if (size === 1) {
        invariant(bytesRead >= 16, `Truncated extended MP4 atom header at byte ${offset}.`);
        size = readUInt64BE(header, 8);
        headerSize = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }
      invariant(size >= headerSize, `Invalid MP4 atom ${type} size ${size} at byte ${offset}.`);
      invariant(offset + size <= fileSize, `MP4 atom ${type} extends past end of file.`);
      atoms.push({ type, offset, size });
      offset += size;
    }
  } finally {
    closeSync(fd);
  }
  invariant(atoms.length > 0 && atoms[0].type === "ftyp", `${displayPath(path)} is not a conventional MP4 file.`);
  invariant(offset === fileSize, `${displayPath(path)} contains an unparsed MP4 tail.`);
  return atoms;
}

function verifyFastStart(path) {
  const atoms = readTopLevelMp4Atoms(path);
  const moov = atoms.find((atom) => atom.type === "moov");
  const mdat = atoms.find((atom) => atom.type === "mdat");
  invariant(moov && mdat, `${displayPath(path)} must contain moov and mdat atoms.`);
  invariant(moov.offset < mdat.offset, `${displayPath(path)} is not fast-start: moov must precede mdat.`);
  return atoms.map((atom) => atom.type);
}

function frameStats(frame) {
  let sum = 0;
  let squared = 0;
  let belowEight = 0;
  for (const value of frame) {
    sum += value;
    squared += value * value;
    if (value <= 8) belowEight += 1;
  }
  const mean = sum / frame.length;
  const variance = Math.max(0, squared / frame.length - mean * mean);
  return {
    mean,
    standardDeviation: Math.sqrt(variance),
    nearBlackRatio: belowEight / frame.length,
  };
}

function meanAbsoluteDifference(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / left.length;
}

function longestRun(items, predicate) {
  let current = 0;
  let longest = 0;
  for (const item of items) {
    if (predicate(item)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function analyzeSampleBuffer(buffer, frameSize, sampleFps = SAMPLE_FPS) {
  invariant(buffer.length > 0, "Decoded luma sample buffer is empty.");
  invariant(buffer.length % frameSize === 0, "Decoded luma sample buffer is not frame-aligned.");
  const sampleCount = buffer.length / frameSize;
  const frames = [];
  const stats = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const frame = buffer.subarray(index * frameSize, (index + 1) * frameSize);
    frames.push(frame);
    stats.push(frameStats(frame));
  }
  const differences = [];
  for (let index = 1; index < frames.length; index += 1) {
    differences.push(meanAbsoluteDifference(frames[index - 1], frames[index]));
  }
  const blackFlags = stats.map((entry) => entry.mean <= 5 && entry.standardDeviation <= 4 && entry.nearBlackRatio >= 0.98);
  const frozenFlags = differences.map((difference) => difference <= FROZEN_MAD_THRESHOLD);
  const blackRunSamples = longestRun(blackFlags, Boolean);
  const frozenRunTransitions = longestRun(frozenFlags, Boolean);
  return {
    sampleFps,
    sampleCount,
    meanLuma: {
      minimum: Math.min(...stats.map((entry) => entry.mean)),
      maximum: Math.max(...stats.map((entry) => entry.mean)),
      average: stats.reduce((sum, entry) => sum + entry.mean, 0) / stats.length,
    },
    minimumFrameStandardDeviation: Math.min(...stats.map((entry) => entry.standardDeviation)),
    blackSampleCount: blackFlags.filter(Boolean).length,
    maxBlackRunSeconds: blackRunSamples / sampleFps,
    maxFrozenRunSeconds: frozenRunTransitions / sampleFps,
    minimumAdjacentMad: differences.length > 0 ? Math.min(...differences) : null,
    averageAdjacentMad: differences.length > 0
      ? differences.reduce((sum, value) => sum + value, 0) / differences.length
      : null,
  };
}

function sampleVideoLuma(path, durationSeconds, sourceWidth, sourceHeight) {
  const sampleWidth = sourceWidth >= sourceHeight ? SAMPLE_WIDTH : SAMPLE_HEIGHT;
  const sampleHeight = sourceWidth >= sourceHeight ? SAMPLE_HEIGHT : SAMPLE_WIDTH;
  const result = run("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `fps=${SAMPLE_FPS},scale=${sampleWidth}:${sampleHeight}:flags=area,format=gray`,
    "-an", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { encoding: null, maxBuffer: 128 * 1024 * 1024 });
  const analysis = analyzeSampleBuffer(result.stdout, sampleWidth * sampleHeight);
  analysis.sampleWidth = sampleWidth;
  analysis.sampleHeight = sampleHeight;
  invariant(analysis.sampleCount >= durationSeconds * SAMPLE_FPS - 1, `${displayPath(path)} produced too few decoded luma samples.`);
  invariant(analysis.maxBlackRunSeconds < MAX_BLACK_RUN_SECONDS, `${displayPath(path)} contains a ${analysis.maxBlackRunSeconds.toFixed(1)}s black span.`);
  invariant(analysis.maxFrozenRunSeconds <= MAX_FROZEN_RUN_SECONDS, `${displayPath(path)} contains a ${analysis.maxFrozenRunSeconds.toFixed(1)}s frozen span.`);
  invariant(analysis.meanLuma.average >= 12 && analysis.meanLuma.average <= 243, `${displayPath(path)} has implausible average luma ${analysis.meanLuma.average.toFixed(1)}.`);
  invariant(analysis.meanLuma.maximum - analysis.meanLuma.minimum >= 5, `${displayPath(path)} lacks meaningful luma evolution.`);
  return analysis;
}

function sampleStillLuma(path, sourceWidth, sourceHeight) {
  const sampleWidth = sourceWidth >= sourceHeight ? SAMPLE_WIDTH : SAMPLE_HEIGHT;
  const sampleHeight = sourceWidth >= sourceHeight ? SAMPLE_HEIGHT : SAMPLE_WIDTH;
  const result = run("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `scale=${sampleWidth}:${sampleHeight}:flags=area,format=gray`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { encoding: null });
  const analysis = analyzeSampleBuffer(result.stdout, sampleWidth * sampleHeight);
  invariant(analysis.sampleCount === 1, `${displayPath(path)} must decode as exactly one poster frame.`);
  invariant(analysis.meanLuma.average >= 8 && analysis.meanLuma.average <= 247, `${displayPath(path)} poster has implausible average luma.`);
  invariant(analysis.minimumFrameStandardDeviation >= 8, `${displayPath(path)} poster is blank or visually flat.`);
  return {
    meanLuma: analysis.meanLuma.average,
    standardDeviation: analysis.minimumFrameStandardDeviation,
    sampleWidth,
    sampleHeight,
  };
}

function unicodeLength(value) {
  return Array.from(value.replace(/\s/gu, "")).length;
}

function srtTimestampSeconds(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u.exec(value);
  invariant(match, `Invalid SRT timestamp ${value}.`);
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1_000;
}

export function validateTimedTranscript(contents, options) {
  const blocks = contents.trim().split(/\r?\n\r?\n+/gu);
  invariant(blocks.length === 11, `${options.id} must contain exactly 11 timed cues.`);
  let previousEnd = 0;
  let maximumCps = 0;
  let longestLine = 0;
  const allText = [];
  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/gu);
    invariant(lines[0] === String(index + 1), `${options.id} cue numbers must be contiguous.`);
    const timing = lines[1]?.split(" --> ");
    invariant(timing?.length === 2, `${options.id} cue ${index + 1} has invalid timing.`);
    const start = srtTimestampSeconds(timing[0]);
    const end = srtTimestampSeconds(timing[1]);
    invariant(Math.abs(start - previousEnd) <= 0.002, `${options.id} has a gap or overlap before cue ${index + 1}.`);
    invariant(end > start, `${options.id} cue ${index + 1} must have positive duration.`);
    const textLines = lines.slice(2);
    invariant(textLines.length >= 1 && textLines.every((line) => line.trim().length > 0), `${options.id} cue ${index + 1} must contain visible text.`);
    const text = textLines.join(" ");
    maximumCps = Math.max(maximumCps, unicodeLength(text) / (end - start));
    longestLine = Math.max(longestLine, ...textLines.map((line) => Array.from(line).length));
    allText.push(text);
    previousEnd = end;
  }
  invariant(Math.abs(previousEnd - options.durationSeconds) <= 0.002, `${options.id} must cover the complete master duration.`);
  invariant(maximumCps <= 25, `${options.id} exceeds 25 non-whitespace characters per second.`);
  invariant(longestLine <= 40, `${options.id} contains a line longer than 40 characters.`);
  const transcript = allText.join(" ");
  if (options.language === "en") {
    invariant(!/\blive data\b/iu.test(transcript), `${options.id} must not overstate the snapshot as live data.`);
    invariant(/atomic commit/iu.test(transcript), `${options.id} must preserve atomic-commit evidence.`);
    invariant(/open source on github/iu.test(transcript), `${options.id} must preserve the GitHub callout.`);
  } else {
    invariant(/原子提交/u.test(transcript), `${options.id} must preserve atomic-commit evidence.`);
    invariant(/OPEN SOURCE ON GITHUB/iu.test(transcript), `${options.id} must preserve the GitHub callout.`);
  }
  return { cueCount: blocks.length, maximumCps, longestLine, durationSeconds: previousEnd };
}

function verifyTimedTranscripts() {
  return Object.fromEntries(TIMED_TRANSCRIPT_CONTRACT.map((entry) => [
    entry.id,
    validateTimedTranscript(readFileSync(entry.path, "utf8"), entry),
  ]));
}

function rectanglesIntersect(left, right) {
  return (
    left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  );
}

function activeRangesOverlap(left, right) {
  return left.startFrame < right.endFrame && right.startFrame < left.endFrame;
}

function normalizeBeatRange(beat, variantName) {
  if (beat.ranges?.[variantName]) return beat.ranges[variantName];
  if (Array.isArray(beat.variants) && beat.variants.includes(variantName)) {
    return { startFrame: beat.startFrame, endFrame: beat.endFrame };
  }
  return null;
}

export function validateVisualContract(contract, options = {}) {
  const expectedCompositionSourceHash = options.compositionSourceHash ?? hashFile(compositionSourcePath);
  const rejectedRevisionBefore = options.rejectedRevisionBefore;
  const rejectedRevisionAfter = options.rejectedRevisionAfter;
  invariant(contract && typeof contract === "object" && !Array.isArray(contract), "V3 visual contract must be an object.");
  invariant(contract.version === "3.0", "V3 visual contract version must be 3.0.");
  invariant(contract.rangeSemantics === "startInclusiveEndExclusive", "V3 output ranges must be start-inclusive/end-exclusive.");
  invariant(contract.sourceRangeSemantics === "sourceStartInclusiveSourceEndInclusive", "V3 source ranges must explicitly use inclusive source endpoints.");
  invariant(/^sha256:[a-f0-9]{64}$/u.test(contract.compositionSourceSha256 ?? ""), "V3 contract must declare a prefixed SHA-256 for its composition source.");
  invariant(contract.compositionSourceSha256 === expectedCompositionSourceHash, "V3 visual contract is stale relative to EmergencyCityProofV3.tsx.");
  invariant(contract.silentFirst === true, "V3 must declare silentFirst=true.");
  invariant(contract.audioRequiredForComprehension === false, "V3 must declare that audio is not required for comprehension.");
  invariant(contract.timedCaptionFilesAreTranscriptsOnly === true, "Timed caption files must be declared transcript-only, not required visual layers.");
  invariant(contract.masterRequiresTimedCaptions === false, "The silent-first master must not require an external caption track.");
  const textMotion = contract.textMotionContract;
  invariant(textMotion && [
    textMotion.titleEnterFrames,
    textMotion.titleExitFrames,
    textMotion.proofEnterFrames,
    textMotion.proofExitFrames,
    textMotion.goalTypingCompleteFrame,
    textMotion.minimumStableFrames,
  ].every((value) => Number.isInteger(value) && value >= 0), "V3 must declare a non-negative integer text motion contract.");
  invariant(textMotion.minimumStableFrames >= 45, "Every visible text layer must be fully stable for at least 45 frames.");
  invariant(contract.variants && typeof contract.variants === "object", "V3 visual contract must define variants.");
  invariant(Array.isArray(contract.comprehensionBeats), "V3 visual contract must define comprehensionBeats.");

  const beatIds = contract.comprehensionBeats.map((beat) => beat?.id);
  invariant(new Set(beatIds).size === beatIds.length, "Comprehension beat IDs must be unique.");
  for (const requiredBeat of REQUIRED_COMPREHENSION_BEATS) {
    invariant(beatIds.includes(requiredBeat), `Missing muted-first comprehension beat: ${requiredBeat}.`);
  }

  const report = {};
  for (const [variantName, expected] of Object.entries(OUTPUT_CONTRACT)) {
    const variant = contract.variants[variantName];
    invariant(variant && typeof variant === "object", `Visual contract is missing ${variantName}.`);
    invariant(variant.width === expected.width && variant.height === expected.height, `${variantName} contract dimensions are incorrect.`);
    invariant(variant.fps === 30, `${variantName} contract must use 30 fps.`);
    invariant(variant.durationFrames === expected.durationFrames, `${variantName} contract duration must be ${expected.durationFrames} frames.`);
    invariant(variant.safeArea && typeof variant.safeArea === "object", `${variantName} contract must declare safeArea insets.`);
    for (const side of ["top", "right", "bottom", "left"]) {
      invariant(Number.isFinite(variant.safeArea[side]), `${variantName} safeArea.${side} must be finite.`);
      invariant(variant.safeArea[side] >= expected.minimumSafeArea[side], `${variantName} safeArea.${side} is below the delivery minimum.`);
    }
    invariant(Array.isArray(variant.layers) && variant.layers.length > 0, `${variantName} must declare its text/proof layers.`);
    invariant(Array.isArray(variant.nonTextOverlays), `${variantName} must declare nonTextOverlays.`);
    invariant(Array.isArray(variant.sourceFrameRanges), `${variantName} must declare sourceFrameRanges.`);

    const layerIds = variant.layers.map((layer) => layer?.id);
    invariant(new Set(layerIds).size === layerIds.length, `${variantName} layer IDs must be unique.`);
    for (const layer of variant.layers) {
      invariant(typeof layer.id === "string" && layer.id.length > 0, `${variantName} has a layer without an ID.`);
      invariant(layer.kind === "primary" || layer.kind === "proof", `${variantName}/${layer.id} must be primary or proof.`);
      invariant(typeof layer.text === "string" && layer.text.trim().length > 0, `${variantName}/${layer.id} must declare visible text.`);
      if (layer.kind === "primary") {
        const length = unicodeLength(layer.text);
        invariant(length <= 18, `${variantName}/${layer.id} primary line has ${length} non-whitespace characters; maximum is 18.`);
        invariant(layer.endFrame - layer.startFrame >= 45, `${variantName}/${layer.id} primary line must remain visible for at least 45 frames.`);
      }
      invariant(Number.isInteger(layer.startFrame) && Number.isInteger(layer.endFrame), `${variantName}/${layer.id} frame range must use integers.`);
      invariant(layer.startFrame >= 0 && layer.endFrame > layer.startFrame && layer.endFrame <= expected.durationFrames, `${variantName}/${layer.id} frame range is outside the composition.`);
      const primaryEnterFrames = layer.id === "goal-primary"
        ? Math.max(textMotion.titleEnterFrames, textMotion.goalTypingCompleteFrame)
        : textMotion.titleEnterFrames;
      const transitionFrames = layer.kind === "primary"
        ? primaryEnterFrames + textMotion.titleExitFrames
        : textMotion.proofEnterFrames + textMotion.proofExitFrames;
      invariant(
        layer.endFrame - layer.startFrame - transitionFrames >= textMotion.minimumStableFrames,
        `${variantName}/${layer.id} does not provide ${textMotion.minimumStableFrames} fully stable frames after text motion.`,
      );
      const bounds = layer.bounds;
      invariant(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite), `${variantName}/${layer.id} must declare finite bounds.`);
      invariant(bounds.width > 0 && bounds.height > 0, `${variantName}/${layer.id} bounds must have positive dimensions.`);
      invariant(bounds.x >= variant.safeArea.left, `${variantName}/${layer.id} violates the left safe area.`);
      invariant(bounds.y >= variant.safeArea.top, `${variantName}/${layer.id} violates the top safe area.`);
      invariant(bounds.x + bounds.width <= expected.width - variant.safeArea.right, `${variantName}/${layer.id} violates the right safe area.`);
      invariant(bounds.y + bounds.height <= expected.height - variant.safeArea.bottom, `${variantName}/${layer.id} violates the bottom safe area.`);
    }

    if (Number.isInteger(rejectedRevisionBefore) && Number.isInteger(rejectedRevisionAfter)) {
      const collisionProof = variant.layers.find((layer) => layer.id === "collision-proof");
      invariant(collisionProof, `${variantName} must declare collision-proof when rejection evidence is available.`);
      const displayedRevisions = collisionProof.text.match(/\brev\s*(\d+)\s*(?:→|->)\s*(\d+)/iu);
      if (displayedRevisions) {
        invariant(
          Number(displayedRevisions[1]) === rejectedRevisionBefore
            && Number(displayedRevisions[2]) === rejectedRevisionAfter,
          `${variantName}/collision-proof displays stale revision evidence.`,
        );
      } else {
        invariant(
          /(?:修订[^\n]{0,12}(?:未改变|不变)|revision[^\n]{0,12}unchanged)/iu.test(collisionProof.text),
          `${variantName}/collision-proof must show matching numeric revisions or explicitly say the revision was unchanged.`,
        );
      }
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
        invariant(
          !activeRangesOverlap(left, right) || !rectanglesIntersect(left.bounds, right.bounds),
          `${variantName}/${left.id} overlaps ${right.id} in both time and screen space.`,
        );
      }
    }

    const overlayIds = variant.nonTextOverlays.map((overlay) => overlay?.id);
    invariant(new Set(overlayIds).size === overlayIds.length, `${variantName} non-text overlay IDs must be unique.`);
    for (const requiredOverlay of REQUIRED_NON_TEXT_OVERLAYS) {
      invariant(overlayIds.includes(requiredOverlay), `${variantName} is missing non-text overlay ${requiredOverlay}.`);
    }
    for (const overlay of variant.nonTextOverlays) {
      invariant(typeof overlay.id === "string" && overlay.id.length > 0, `${variantName} has a non-text overlay without an ID.`);
      invariant(overlay.safeAreaPolicy === "safe_area", `${variantName}/${overlay.id} must remain inside the declared safe area.`);
      const regions = Array.isArray(overlay.regions)
        ? overlay.regions
        : [{ startFrame: overlay.startFrame, endFrame: overlay.endFrame, bounds: overlay.bounds }];
      invariant(regions.length > 0, `${variantName}/${overlay.id} must declare at least one bounded time region.`);
      for (const [regionIndex, region] of regions.entries()) {
        const label = `${variantName}/${overlay.id}/region-${regionIndex + 1}`;
        invariant(Number.isInteger(region.startFrame) && Number.isInteger(region.endFrame), `${label} frame range must use integers.`);
        invariant(region.startFrame >= 0 && region.endFrame > region.startFrame && region.endFrame <= expected.durationFrames, `${label} frame range is outside the composition.`);
        const bounds = region.bounds;
        invariant(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite), `${label} must declare finite bounds.`);
        invariant(bounds.width > 0 && bounds.height > 0, `${label} bounds must have positive dimensions.`);
        invariant(bounds.x >= variant.safeArea.left, `${label} violates the left safe area.`);
        invariant(bounds.y >= variant.safeArea.top, `${label} violates the top safe area.`);
        invariant(bounds.x + bounds.width <= expected.width - variant.safeArea.right, `${label} violates the right safe area.`);
        invariant(bounds.y + bounds.height <= expected.height - variant.safeArea.bottom, `${label} violates the bottom safe area.`);
        for (const layer of variant.layers) {
          invariant(
            !activeRangesOverlap(region, layer) || !rectanglesIntersect(bounds, layer.bounds),
            `${label} overlaps declared text layer ${layer.id}.`,
          );
        }
      }
    }

    const expectedRanges = EXPECTED_SOURCE_RANGES[variantName];
    invariant(variant.sourceFrameRanges.length === expectedRanges.length, `${variantName} must declare exactly ${expectedRanges.length} source ranges.`);
    const normalizedSourceRanges = variant.sourceFrameRanges.map((range) => [
      range.id,
      range.startFrame,
      range.endFrame,
      range.folder,
      range.sourceStart,
      range.sourceEnd,
    ]);
    invariant(canonicalJSON(normalizedSourceRanges) === canonicalJSON(expectedRanges), `${variantName} source range order or endpoints differ from the frozen edit contract.`);
    for (const range of variant.sourceFrameRanges) {
      invariant(Object.hasOwn(FRAME_CONTRACT, range.folder), `${variantName}/${range.id} references an unknown source folder.`);
      invariant(Number.isInteger(range.sourceStart) && Number.isInteger(range.sourceEnd), `${variantName}/${range.id} source endpoints must use integers.`);
      invariant(range.sourceStart >= 0 && range.sourceEnd >= range.sourceStart && range.sourceEnd < FRAME_CONTRACT[range.folder], `${variantName}/${range.id} source endpoints are outside ${range.folder}.`);
    }

    for (const beat of contract.comprehensionBeats) {
      const range = normalizeBeatRange(beat, variantName);
      invariant(range, `${variantName} is missing comprehension beat ${beat.id}.`);
      invariant(Number.isInteger(range.startFrame) && Number.isInteger(range.endFrame), `${variantName}/${beat.id} beat range must use integers.`);
      invariant(range.startFrame >= 0 && range.endFrame > range.startFrame && range.endFrame <= expected.durationFrames, `${variantName}/${beat.id} beat range is outside the composition.`);
      invariant(
        variant.layers.some((layer) => activeRangesOverlap(range, layer)),
        `${variantName}/${beat.id} has no visible declared layer during its comprehension window.`,
      );
    }

    report[variantName] = {
      dimensions: `${variant.width}x${variant.height}`,
      durationFrames: variant.durationFrames,
      safeArea: variant.safeArea,
      layerCount: variant.layers.length,
      primaryLayerCount: variant.layers.filter((layer) => layer.kind === "primary").length,
      proofLayerCount: variant.layers.filter((layer) => layer.kind === "proof").length,
      nonTextOverlayCount: variant.nonTextOverlays.length,
      sourceRangeCount: variant.sourceFrameRanges.length,
      comprehensionBeatCount: REQUIRED_COMPREHENSION_BEATS.length,
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
  const hostValidationReceipt = readJSON(join(plannerRoot, "host-validation-receipt.json"));
  const schema = readJSON(schemaPath);
  const rawTrace = readFileSync(join(plannerRoot, "codex-trace.raw.jsonl"), "utf8");
  const traceEvents = rawTrace.trim().split(/\r?\n/gu).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid planner JSONL event ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  invariant(evidence.syntheticBaseline === true, "The city baseline must be explicitly synthetic.");
  invariant(evidence.workspace?.componentCount === 137, "The capture must contain exactly 137 editable stage, city, and preview components.");
  invariant(evidence.workspace?.foundationOperationCount === 37, "The foundation batch must contain exactly 37 operations.");
  invariant(evidence.workspace?.atomicBuildOperationCount === 98, "The main city batch must contain exactly 98 operations within the protocol cap.");
  const sessionLifecycle = evidence.agentSessionLifecycle;
  const sessionCheckpoints = sessionLifecycle?.checkpoints ?? [];
  invariant(sessionLifecycle?.strategy === "rotate_through_approved_offer", "Long capture must rotate short-lived sessions through the approved offer.");
  invariant(sessionLifecycle?.rotationCount === 3 && sessionCheckpoints.length === 4, "Long capture must record exactly three safe session rotations.");
  invariant(canonicalJSON(sessionCheckpoints.map((entry) => entry.phase)) === canonicalJSON([
    "initial",
    "before_live_planner",
    "after_live_planner",
    "after_response_capture",
  ]), "Session rotations must occur at the audited no-transaction checkpoints.");
  invariant(sessionCheckpoints.every((entry) => {
    const issuedAt = Date.parse(entry.issuedAt);
    const expiresAt = Date.parse(entry.expiresAt);
    return Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && expiresAt - issuedAt >= 25 * 60_000;
  }), "Every recorded Workspace session must retain the normal approximately 30-minute lifetime.");
  invariant(sessionLifecycle?.productDefaultTtlChanged === false, "The demo must not weaken the product session TTL.");
  invariant(sessionLifecycle?.approvalCredentialPersisted === false, "Approval credentials must remain memory-only.");
  invariant(!/(?:approval|session|transaction)_token|workspace_session_/iu.test(canonicalJSON(sessionLifecycle)), "Session lifecycle evidence must not persist private credentials.");
  invariant(evidence.dispatchSnapshot?.connectorType === "inline.snapshot", "The demo must use the deterministic inline snapshot connector.");
  invariant(evidence.dispatchSnapshot?.authorizedScope === true, "The capture must prove explicit effect:data_read authorization.");
  invariant(evidence.dispatchSnapshot?.snapshotAuthority === "host_normalized", "The dispatch snapshot must be host-normalized.");
  invariant(evidence.dispatchSnapshot?.readWasNonMutating === true, "The snapshot read must leave Workspace revision unchanged.");
  invariant(evidence.dispatchSnapshot?.initialEtaSeconds === 28, "The opening ETA must match the captured snapshot.");
  invariant(evidence.dispatchSnapshot?.initialClearanceM === 1.6, "The opening clearance must match the captured snapshot.");
  invariant(evidence.dispatchSnapshot?.requiredClearanceM === 3.2, "The required clearance must match the captured snapshot.");
  invariant(evidence.dispatchSnapshot?.finalEtaSeconds === 11, "The resolved ETA must match the final snapshot.");
  invariant(evidence.dispatchSnapshot?.finalClearanceM === 3.8, "The resolved clearance must match the final snapshot.");
  invariant(evidence.dispatchSnapshot?.finalOutcomeAuthority === "deterministic_synthetic_scenario", "The final feed state must identify its synthetic authority.");
  invariant(evidence.dispatchSnapshot?.finalOutcomeGeometryDerived === false, "The film must not claim that ETA/clearance were derived from vehicle dynamics.");

  invariant(evidence.rejectedEndpoint?.errorCode === "spatial_collision", "The unsafe endpoint must fail with spatial_collision.");
  invariant(Number.isInteger(evidence.rejectedEndpoint?.revisionBefore), "The rejected endpoint must record its source revision.");
  invariant(Number.isInteger(evidence.rejectedEndpoint?.revisionAfter), "The rejected endpoint must record its resulting revision.");
  invariant(evidence.rejectedEndpoint.revisionAfter === evidence.rejectedEndpoint.revisionBefore, "The rejected endpoint must leave the Workspace revision unchanged.");
  invariant(evidence.rejectedEndpoint?.atomic === true, "The rejected endpoint must not change Workspace revision.");
  invariant(evidence.rejectedEndpoint?.preflightValid === false, "The unsafe endpoint preflight must be invalid.");
  invariant((evidence.rejectedEndpoint?.conflicts ?? []).length > 0, "The rejected endpoint must record at least one real conflict.");
  const previewLifecycle = evidence.rejectedEndpoint?.previewLifecycle;
  invariant(Array.isArray(previewLifecycle?.componentIds) && previewLifecycle.componentIds.length === 4,
    "The rejected endpoint must retain exactly four auditable preview components.");
  invariant(new Set(previewLifecycle.componentIds).size === 4,
    "Rejected-preview component IDs must be unique.");
  invariant(previewLifecycle?.hostAuthoredCleanup === true && previewLifecycle?.partOfModelPlan === false,
    "Rejected-preview cleanup must remain a host lifecycle action outside the model's response plan.");
  invariant(previewLifecycle?.dismissalStatus === "committed",
    "Rejected-preview cleanup must commit before planning.");
  invariant(previewLifecycle?.dismissalRevision === evidence.rejectedEndpoint.revisionAfter + 1,
    "Rejected-preview cleanup must be the one revision immediately after atomic rejection.");
  invariant(previewLifecycle.planCameraRevision === previewLifecycle.dismissalRevision + 1,
    "The authored plan camera must be the only revision between preview cleanup and planner authority.");
  invariant(previewLifecycle.planCameraRevision === evidence.planner?.hostPreflightRevision,
    "The live planner must bind the exact revision after preview cleanup and the authored plan camera update.");
  for (const checkpoint of ["collapsedAfterDismissal", "collapsedAfterPlan", "collapsedAfterReopen"]) {
    const components = previewLifecycle?.[checkpoint];
    invariant(Array.isArray(components) && components.length === 4,
      `Rejected-preview ${checkpoint} evidence must contain all four components.`);
    invariant(components.every((entry) => previewLifecycle.componentIds.includes(entry.componentId)
      && entry.visibility === "collapsed"),
    `Every rejected-preview component must remain collapsed at ${checkpoint}.`);
  }
  invariant(previewLifecycle?.persistedAcrossSaveReopen === true,
    "Save/Open must preserve the collapsed rejected-preview lifecycle state.");

  invariant(plannerManifest.mode === "live_codex" && plannerManifest.live_model === true, "The delivered plan must come from a live Codex run.");
  invariant(plannerManifest.hardcoded_fallback === false, "The live planner must not have a hardcoded fallback.");
  invariant(plannerManifest.safety?.automatic_fixture_fallback === false, "The planner must prohibit automatic fixture fallback.");
  invariant(plannerManifest.safety?.model_working_directory_isolated_from_repository === true, "The planner run must be isolated from repository files.");
  invariant(plannerManifest.safety?.model_tool_use_allowed === false, "The model planner must not be allowed to use tools.");
  invariant(truthWindow.live_model === true, "The truth window must identify a live model run.");
  invariant(truthWindow.events?.some((event) => event.status === "schema_valid_preflight_pending"), "Planner truth must stop at schema acceptance pending host preflight.");
  const traceItemTypes = verifyTraceIsToolFree(traceEvents);

  const plannerSource = readFileSync(plannerSourcePath, "utf8");
  for (const requiredFlag of ["--ephemeral", "--json", "--sandbox", "read-only", "--output-schema"]) {
    invariant(plannerSource.includes(requiredFlag), `Planner implementation is missing required isolated CLI flag ${requiredFlag}.`);
  }

  invariant(plannerManifest.hashes.context === hashJSON(plannerContext), "Planner context SHA-256 mismatch.");
  invariant(plannerManifest.hashes.output_schema === hashJSON(schema), "Planner schema SHA-256 mismatch.");
  invariant(plannerManifest.hashes.plan === hashJSON(plan), "Planner plan SHA-256 mismatch.");
  invariant(plannerManifest.hashes.raw_trace === sha256(rawTrace), "Planner raw trace SHA-256 mismatch.");
  invariant(plannerManifest.hashes.truth_window_events === hashJSON(truthWindow), "Planner truth-window SHA-256 mismatch.");
  const recomputedRunHash = hashJSON({
    mode: plannerManifest.mode,
    live_model: plannerManifest.live_model,
    model: plannerManifest.model,
    context_hash: plannerManifest.hashes.context,
    schema_hash: plannerManifest.hashes.output_schema,
    prompt_hash: plannerManifest.hashes.prompt,
    plan_hash: plannerManifest.hashes.plan,
    trace_hash: plannerManifest.hashes.raw_trace,
  });
  invariant(plannerManifest.run_hash === recomputedRunHash, "Planner run hash mismatch.");
  invariant(canonicalJSON(plan.source) === canonicalJSON({
    workspace_id: plannerContext.authority.workspace_id,
    workspace_revision: plannerContext.authority.workspace_revision,
    registry_digest: plannerContext.authority.registry_digest,
    dispatch_snapshot_hash: plannerContext.authority.dispatch_snapshot_hash,
  }), "Plan source must exactly match the authoritative context.");

  invariant(evidence.planner?.mode === "live_codex" && evidence.planner?.liveModel === true, "Capture evidence must identify the live planner.");
  invariant(evidence.planner?.hardcodedFallback === false, "Capture evidence must prove there was no hardcoded fallback.");
  invariant(evidence.planner?.runId === plannerManifest.run_id, "Capture evidence planner run ID mismatch.");
  invariant(evidence.planner?.runHash === plannerManifest.run_hash, "Capture evidence planner run hash mismatch.");
  invariant(evidence.planner?.vehicleToBayAssignmentSupplied === false, "The host must not supply a vehicle-to-bay assignment.");
  invariant(evidence.planner?.safeBayCandidateRegionsSupplied === true, "Evidence must disclose host-supplied safe-bay regions.");
  invariant(evidence.planner?.endpointCoordinatesAuthoredByModelWithinHostRegions === true, "Evidence must identify model-authored coordinates within host regions.");
  invariant(evidence.planner?.requiredEffectsDefinedByHostMission === true, "Evidence must disclose the host-defined required effects.");
  invariant(evidence.planner?.actionCountWasNotPresentedAsAnOpenDecision === true, "Evidence must not overstate action-count autonomy.");
  invariant(evidence.planner?.hostMissionContractValidated === true, "The host mission contract must be validated.");
  invariant(evidence.planner?.hostPreflightRevision === plan.source.workspace_revision, "Every endpoint must be preflighted at the plan source revision.");
  invariant(evidence.planner?.preflightRevisionAfter === plan.source.workspace_revision, "Endpoint preflight must leave the plan revision unchanged.");
  invariant(evidence.planner?.dispatchSnapshotReadRevision === plan.source.workspace_revision, "Dispatch data must be re-read at the planner revision.");
  invariant(evidence.planner?.dispatchSnapshotReadRegistryDigest === plan.source.registry_digest, "Planner dispatch read must use the source registry digest.");
  invariant(evidence.planner?.successfulAttempt >= 1 && evidence.planner.successfulAttempt <= 3, "The successful live planner attempt must be bounded.");
  invariant(evidence.planner?.hostValidationReceiptHash === hashJSON(hostValidationReceipt), "Host validation receipt SHA-256 mismatch.");
  invariant(hostValidationReceipt.planner_run_id === plannerManifest.run_id, "Host validation receipt planner ID mismatch.");
  invariant(hostValidationReceipt.planner_plan_hash === plannerManifest.hashes.plan, "Host validation receipt plan hash mismatch.");
  invariant(hostValidationReceipt.validation_tool === "query_spatial_placement", "Host receipt must identify query_spatial_placement.");
  invariant(hostValidationReceipt.all_endpoints_valid === true, "Host validation receipt must accept every endpoint.");

  const actions = plan.control?.actions ?? [];
  const moveActions = actions.filter((action) => action.action === "move_to");
  const stateActions = actions.filter((action) => action.action === "show" || action.action === "hide");
  invariant(actions.length === 11, "The delivered emergency plan must contain exactly 11 routed actions.");
  invariant(moveActions.length === 5, "The delivered emergency plan must contain exactly five spatial moves.");
  invariant(stateActions.length === 6, "The delivered emergency plan must contain exactly six visibility changes.");
  const safePreflights = evidence.validatedPlan?.safePreflights ?? [];
  invariant(safePreflights.length === 5, "Every one of the five model endpoints must have one host preflight receipt.");
  invariant(canonicalJSON(hostValidationReceipt.endpoint_receipts) === canonicalJSON(safePreflights), "Capture evidence and host endpoint receipts must match exactly.");
  invariant(new Set(safePreflights.map((entry) => entry.actionId)).size === 5, "Endpoint preflight receipts must be unique by action.");
  invariant(safePreflights.every((entry) => (
    entry.valid === true
    && Array.isArray(entry.conflicts)
    && entry.conflicts.length === 0
    && entry.workspaceId === plan.source.workspace_id
    && entry.workspaceRevision === plan.source.workspace_revision
    && entry.registryDigest === plan.source.registry_digest
  )), "Every final model endpoint must pass same-revision spatial preflight.");
  invariant(evidence.validatedPlan?.authoringSource === "codex_cli_live", "Compiled routes must be sourced from the live Codex plan.");
  invariant(evidence.validatedPlan?.planActionCount === 11 && evidence.validatedPlan?.routeCount === 11, "All 11 model actions must compile one-to-one to routes.");

  invariant(evidence.oneClickResponse?.pointerInput === true, "The response must come from a real pointer click.");
  invariant(evidence.oneClickResponse?.revisionDelta === 1, "The entire response must commit in one revision.");
  invariant(evidence.oneClickResponse?.revisionAfter - evidence.oneClickResponse?.revisionBefore === 1, "One-click revision evidence is internally inconsistent.");
  invariant(evidence.oneClickResponse?.pressEventCount === 1, "The capture must contain exactly one source press event.");
  invariant(evidence.oneClickResponse?.movedEventCount === 5, "The click must route all five model moves.");
  invariant(evidence.oneClickResponse?.routedVisibilityEventCount === 6, "The click must route all six scene-state changes.");
  invariant(evidence.oneClickResponse?.routedActionCount === 11, "The real click fan-out must equal the 11-action model plan.");
  invariant(evidence.undoRedo?.undoRevision === evidence.oneClickResponse.revisionBefore, "Undo must restore the pre-click revision.");
  invariant(evidence.undoRedo?.redoRevision === evidence.oneClickResponse.revisionAfter, "Redo must restore the one-click revision.");
  invariant(evidence.undoRedo?.ambulanceRestored === true, "Undo/Redo must restore the model-selected ambulance endpoint.");

  invariant(evidence.saveReopen?.realUiSave === true && evidence.saveReopen?.realUiOpen === true, "Save/Reopen must use the real file UI path.");
  invariant(evidence.saveReopen?.savedRevision === evidence.saveReopen?.reopenedRevision, "Reopen must preserve revision.");
  invariant(evidence.saveReopen?.savedComponentCount === evidence.saveReopen?.reopenedComponentCount, "Reopen must preserve components.");
  invariant(evidence.saveReopen?.savedResourceCount === evidence.saveReopen?.reopenedResourceCount, "Reopen must preserve resources.");
  invariant(evidence.saveReopen?.savedConnectionCount === evidence.saveReopen?.reopenedConnectionCount, "Reopen must preserve connections.");
  invariant(evidence.saveReopen?.savedComponentCount === 137, "Saved project must contain the complete 137-component scene.");
  invariant(evidence.saveReopen?.savedResourceCount === 1, "Saved project must contain the one authorized dispatch resource.");
  invariant(evidence.saveReopen?.savedConnectionCount === 13, "Saved project must contain 11 event routes and two resource bindings.");
  invariant(evidence.saveReopen?.ambulanceEndpointRestored === true, "Reopen must restore the model-selected ambulance endpoint.");
  invariant(evidence.saveReopen?.dispatchSnapshotRestored === true, "Reopen must restore the resolved dispatch snapshot.");
  invariant(evidence.saveReopen?.modelRoutesRestoredExactly === true, "Reopen must preserve every compiled model route definition.");
  invariant(evidence.saveReopen?.modelRouteCount === 11, "Reopened route count must match the 11-action plan.");
  invariant(/^sha256:[a-f0-9]{64}$/u.test(evidence.saveReopen?.modelRoutesHash ?? ""), "Reopened route definitions must have an audit hash.");

  invariant(evidence.validation?.collisionConflictCount === 0, "The reopened city must have zero collision conflicts.");
  invariant(evidence.validation?.physicsFeasible === true, "The reopened bounded physics preflight must be feasible.");
  invariant(evidence.validation?.physicsEnabledBodyCount > 0, "The reopened physics preflight must exercise enabled bodies.");
  invariant(evidence.validation?.physicsKinematicBodyCount === 10, "The reopened physics preflight must include exactly 10 kinematic vehicle bodies.");
  invariant((evidence.validation?.physicsIssues ?? []).length === 0, "The reopened bounded physics preflight must have no issues.");

  invariant(evidence.capture?.width === 1920 && evidence.capture?.height === 1080, "V3 source capture must be native 1920x1080.");
  invariant(evidence.capture?.fps === 30, "Source capture must be 30 fps.");
  invariant(evidence.capture?.durationSeconds === 37, "Source capture must remain exactly 37 seconds.");
  invariant(evidence.capture?.totalSourceFrames === 1_110, "Source capture must contain exactly 1110 frames.");
  invariant(evidence.capture?.sourceFrameMapping === "one_source_image_per_30fps_output_frame", "The edit must use one source image per output frame.");
  invariant(evidence.capture?.nativeSourceResolution === true, "Capture evidence must identify native source resolution.");
  invariant(evidence.capture?.cameraStateAuthoredInWorkspace === true, "Capture evidence must identify Workspace-authored camera state.");
  invariant(evidence.capture?.projectedControlCropGuard === true, "Capture evidence must prove the projected-control crop guard ran.");
  invariant(evidence.capture?.webgl?.contextLost === false, "Source capture must finish with a healthy WebGL context.");
  invariant(evidence.capture?.stabilization === "two_requestAnimationFrame_then_webgl_finish_before_each_capture", "Every source frame must cross the render stabilization barrier.");
  invariant(canonicalJSON(evidence.capture?.frameCounts) === canonicalJSON(FRAME_CONTRACT), "Evidence frame counts must exactly match the 1110-frame capture contract.");
  const visualLayers = evidence.capture?.visualLayersM;
  invariant(visualLayers?.plinthTopY - visualLayers?.stageGroundTopY >= 0.2, "City plinth must be physically separated from stage ground.");
  invariant(visualLayers?.roadMainY - visualLayers?.plinthTopY >= visualLayers?.minimumOverlappingSurfaceGapM, "Main road must be separated from the plinth.");
  invariant(visualLayers?.safeBayY - visualLayers?.roadCrossY >= visualLayers?.minimumOverlappingSurfaceGapM, "Safe-bay overlays must be separated from the crossing road.");
  invariant(visualLayers?.routeBlockedY - visualLayers?.roadCrossY >= visualLayers?.minimumOverlappingSurfaceGapM, "Blocked route must be separated from the crossing road.");
  invariant(visualLayers?.routeOpenY - visualLayers?.routeBlockedY >= visualLayers?.minimumOverlappingSurfaceGapM, "Open and blocked route surfaces must not be coplanar.");

  for (const [folder, expectedCount] of Object.entries(FRAME_CONTRACT)) {
    const path = join(captureRoot, folder);
    invariant(existsSync(path), `Missing capture folder ${folder}.`);
    const frames = readdirSync(path).filter((name) => /^frame-\d{4}\.jpg$/u.test(name)).sort();
    invariant(frames.length === expectedCount, `${folder} has ${frames.length} frames; expected ${expectedCount}.`);
    frames.forEach((name, index) => invariant(name === `frame-${String(index).padStart(4, "0")}.jpg`, `${folder} is missing or misorders source frame ${index}.`));
    for (const sample of [frames[0], frames[Math.floor(frames.length / 2)], frames.at(-1)]) {
      const still = probe(join(path, sample));
      const stream = still.streams?.find((entry) => entry.codec_type === "video");
      invariant(stream?.codec_name === "mjpeg" && stream.width === 1920 && stream.height === 1080, `${folder}/${sample} must be a decodable 1920x1080 JPEG.`);
    }
    run("ffmpeg", [
      "-v", "error",
      "-framerate", "30",
      "-start_number", "0",
      "-i", join(path, "frame-%04d.jpg"),
      "-frames:v", String(expectedCount),
      "-f", "null", "-",
    ]);
  }

  return {
    evidence,
    plannerManifest,
    traceItemTypes,
    actionCount: actions.length,
    moveCount: moveActions.length,
    stateActionCount: stateActions.length,
    endpointPreflightCount: safePreflights.length,
  };
}

function verifyVideo(variantName, contract) {
  const expected = OUTPUT_CONTRACT[variantName];
  const video = probe(expected.videoPath, true);
  const videoStream = video.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = video.streams?.find((stream) => stream.codec_type === "audio");
  invariant(videoStream?.codec_name === "h264", `${variantName} video must use H.264.`);
  invariant(videoStream?.width === expected.width && videoStream?.height === expected.height, `${variantName} video dimensions are incorrect.`);
  invariant(videoStream?.pix_fmt === "yuv420p", `${variantName} video must use yuv420p.`);
  invariant(videoStream?.r_frame_rate === "30/1" && videoStream?.avg_frame_rate === "30/1", `${variantName} video must be constant 30 fps.`);
  invariant(Number(videoStream?.nb_read_frames) === expected.durationFrames, `${variantName} video must contain exactly ${expected.durationFrames} decoded frames.`);
  invariant(videoStream?.color_range === "tv", `${variantName} video must use limited-range video levels.`);
  invariant(videoStream?.color_space === "bt709" && videoStream?.color_transfer === "bt709" && videoStream?.color_primaries === "bt709", `${variantName} video must be fully tagged BT.709.`);
  invariant(Math.abs(Number(video.format?.duration) - expected.durationSeconds) < 0.08, `${variantName} video must be exactly ${expected.durationSeconds} seconds.`);
  const mp4Atoms = verifyFastStart(expected.videoPath);
  const luma = sampleVideoLuma(expected.videoPath, expected.durationSeconds, expected.width, expected.height);

  let audio = null;
  if (audioStream) {
    invariant(audioStream.sample_rate === "48000" && audioStream.channels === 2, `${variantName} audio, when present, must be 48 kHz stereo.`);
    const loudness = measureLoudness(expected.videoPath);
    invariant(loudness.integratedLufs >= -16.5 && loudness.integratedLufs <= -15.5, `${variantName} integrated loudness ${loudness.integratedLufs} LUFS is outside -16 ±0.5 LUFS.`);
    invariant(loudness.truePeakDbfs <= -1, `${variantName} true peak ${loudness.truePeakDbfs} dBFS exceeds -1 dBTP.`);
    audio = loudness;
  }

  const poster = probe(expected.posterPath);
  const posterStream = poster.streams?.find((stream) => stream.codec_type === "video");
  invariant(posterStream?.codec_name === "png", `${variantName} poster must be a PNG image.`);
  invariant(posterStream?.width === expected.width && posterStream?.height === expected.height, `${variantName} poster dimensions are incorrect.`);
  const posterLuma = sampleStillLuma(expected.posterPath, expected.width, expected.height);

  return {
    width: videoStream.width,
    height: videoStream.height,
    durationSeconds: Number(video.format.duration),
    decodedFrames: Number(videoStream.nb_read_frames),
    codec: videoStream.codec_name,
    pixelFormat: videoStream.pix_fmt,
    frameRate: videoStream.avg_frame_rate,
    color: {
      range: videoStream.color_range,
      space: videoStream.color_space,
      transfer: videoStream.color_transfer,
      primaries: videoStream.color_primaries,
    },
    fastStart: mp4Atoms.indexOf("moov") < mp4Atoms.indexOf("mdat"),
    audio,
    luma,
    poster: {
      width: posterStream.width,
      height: posterStream.height,
      luma: posterLuma,
    },
    visualLayers: contract[variantName],
  };
}

export function main() {
  if (existsSync(verificationPath)) unlinkSync(verificationPath);
  const proof = verifyPlannerAndWorkspace();
  const visualContract = readJSON(visualContractPath);
  const visualContractReport = validateVisualContract(visualContract, {
    rejectedRevisionBefore: proof.evidence.rejectedEndpoint.revisionBefore,
    rejectedRevisionAfter: proof.evidence.rejectedEndpoint.revisionAfter,
  });
  const timedTranscripts = verifyTimedTranscripts();
  const media = Object.fromEntries(Object.keys(OUTPUT_CONTRACT).map((variantName) => [
    variantName,
    verifyVideo(variantName, visualContractReport),
  ]));

  const verification = {
    verificationVersion: "3.0",
    result: "passed",
    verifiedAt: new Date().toISOString(),
    mutedFirst: {
      declared: true,
      audioRequiredForComprehension: false,
      comprehensionBeats: REQUIRED_COMPREHENSION_BEATS,
      visualContract: visualContractReport,
      compositionSourceSha256: visualContract.compositionSourceSha256,
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
  console.log("Emergency-city silent-first hero V3 verification passed.");
  console.log(JSON.stringify(verification, null, 2));
  return verification;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`Emergency-city V3 verification FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
