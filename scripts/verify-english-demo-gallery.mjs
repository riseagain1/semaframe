import {createHash} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {basename, dirname, relative, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {isDeepStrictEqual} from "node:util";
import {
  analyzeSampleBuffer,
  readTopLevelMp4Atoms,
} from "./verify-emergency-city-v3.mjs";

const CONTRACT_PATH = "video/english-demo-gallery.visual-contract.json";
const README_PATH = "README.md";
const RECEIPT_PATH = "artifacts/semaframe-english-demo-gallery-verification.json";
const RELEASE_DOWNLOAD_BASE = "https://github.com/riseagain1/semaframe/releases/download/demo-gallery-v1";
const MAX_BUFFER = 256 * 1024 * 1024;
const SAMPLE_FPS = 5;
const SAMPLE_LONG_EDGE = 160;
const SAMPLE_SHORT_EDGE = 90;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const EXPECTED_SOURCES = Object.freeze({
  realityOps: "video/src/RealityOpsProofV2.tsx",
  livingRoom: "video/src/LivingRoomPublicDemo.tsx",
  emergencyCity: "video/src/EmergencyCityProofV3.tsx",
  emergencyCitySemanticLens: "video/src/EmergencyCitySemanticLens.tsx",
});

const EXPECTED_SUPPORTING_CONTRACTS = Object.freeze([
  "video/living-room-public-demo-en.visual-contract.json",
  "video/emergency-city-v4-english.visual-contract.json",
]);

const EXPECTED_CLAIM_BOUNDARIES = Object.freeze({
  pump: Object.freeze({
    sceneSource: "synthetic_scene_not_photo_or_scan",
    dataSource: "deterministic_snapshot_not_live_network",
    collisionScope: "endpoint_and_final_state_preflight_not_continuous_path",
    physicsScope: "bounded_preflight_not_engineering_certification",
    requiredVisibleCopy: Object.freeze([
      "SYNTHETIC SCENE · DETERMINISTIC SNAPSHOT · BOUNDED PREFLIGHT, NOT CERTIFICATION",
    ]),
  }),
  furniture: Object.freeze({
    sceneSource: "synthetic_procedural_room_not_real_home_scan",
    collisionScope: "deterministic_collision_preflight_not_continuous_path",
    physicsScope: "bounded_preflight_not_building_certification",
    controlScope: "workspace_event_routing_not_smart_home_network",
    requiredVisibleCopy: Object.freeze([
      "SYNTHETIC ROOM · COLLISION PREFLIGHT, NOT BUILDING CERTIFICATION",
    ]),
  }),
  traffic: Object.freeze({
    dataSource: "deterministic_host_normalized_inline_snapshot_not_live_network",
    collisionScope: "endpoint_preflight_and_final_state_not_continuous_path",
    rejectedCandidateAttribution: "host_scenario_candidate_not_model_first_attempt",
    physicsScope: "bounded_quasi_static_preflight_not_certification",
    requiredVisibleCopy: Object.freeze([
      "ETA 28s · 1.6m clear · read-only snapshot",
      "Endpoint preflight rejected · scene unchanged",
      "AI proposes. A human confirms.",
      "This is not a pre-rendered change",
    ]),
  }),
});

const EXPECTED_DELIVERIES = Object.freeze({
  "pump-landscape": Object.freeze({
    demo: "pump",
    variant: "landscape",
    sourceRefs: Object.freeze(["realityOps"]),
    componentExport: "SemaFrameRealityOpsProofV2English",
    compositionId: "SemaFrameRealityOpsProofV2English",
    posterComponentExport: "SemaFrameRealityOpsProofV2EnglishPoster",
    posterCompositionId: "SemaFrameRealityOpsProofV2EnglishPoster",
    durationExpression: "REALITY_OPS_PROOF_V2_LANDSCAPE_DURATION",
    width: 1920,
    height: 1080,
    fps: 30,
    durationFrames: 1080,
    captionPath: "video/captions/semaframe-realityops-v2.en-US.srt",
    captionCueCount: 12,
    videoPath: "artifacts/semaframe-realityops-v2-en.mp4",
    posterPath: "artifacts/semaframe-realityops-v2-en-poster.png",
    readmePosterPath: "docs/media/semaframe-realityops-v2-en-poster.jpg",
  }),
  "pump-vertical": Object.freeze({
    demo: "pump",
    variant: "vertical",
    sourceRefs: Object.freeze(["realityOps"]),
    componentExport: "SemaFrameRealityOpsProofV2VerticalEnglish",
    compositionId: "SemaFrameRealityOpsProofV2VerticalEnglish",
    posterComponentExport: "SemaFrameRealityOpsProofV2VerticalEnglishPoster",
    posterCompositionId: "SemaFrameRealityOpsProofV2VerticalEnglishPoster",
    durationExpression: "REALITY_OPS_PROOF_V2_VERTICAL_DURATION",
    width: 1080,
    height: 1920,
    fps: 30,
    durationFrames: 960,
    captionPath: "video/captions/semaframe-realityops-v2-vertical.en-US.srt",
    captionCueCount: 12,
    videoPath: "artifacts/semaframe-realityops-v2-en-vertical.mp4",
    posterPath: "artifacts/semaframe-realityops-v2-en-vertical-poster.png",
  }),
  "furniture-landscape": Object.freeze({
    demo: "furniture",
    variant: "landscape",
    sourceRefs: Object.freeze(["livingRoom"]),
    componentExport: "SemaFrameLivingRoomPublicDemoEnglish",
    compositionId: "SemaFrameLivingRoomPublicDemoEnglish",
    posterComponentExport: "SemaFrameLivingRoomPublicDemoEnglishPoster",
    posterCompositionId: "SemaFrameLivingRoomPublicDemoEnglishPoster",
    durationExpression: "LIVING_ROOM_PUBLIC_ENGLISH_DURATION",
    width: 1920,
    height: 1080,
    fps: 30,
    durationFrames: 1200,
    captionPath: "video/captions/semaframe-living-room-public-demo.en-US.srt",
    captionCueCount: 14,
    videoPath: "artifacts/semaframe-living-room-public-demo-en.mp4",
    posterPath: "artifacts/semaframe-living-room-public-demo-en-poster.png",
    readmePosterPath: "docs/media/semaframe-living-room-public-demo-en-poster.jpg",
  }),
  "traffic-landscape": Object.freeze({
    demo: "traffic",
    variant: "landscape",
    sourceRefs: Object.freeze(["emergencyCity", "emergencyCitySemanticLens"]),
    componentExport: "SemaFrameEmergencyCityProofV4English",
    compositionId: "SemaFrameEmergencyCityProofV4English",
    posterComponentExport: "SemaFrameEmergencyCityProofV4EnglishPoster",
    posterCompositionId: "SemaFrameEmergencyCityProofV4EnglishPoster",
    durationExpression: "EMERGENCY_CITY_PROOF_V4_LANDSCAPE_DURATION",
    width: 1920,
    height: 1080,
    fps: 30,
    durationFrames: 960,
    captionPath: "video/captions/semaframe-emergency-city-v4.en-US.srt",
    captionCueCount: 13,
    videoPath: "artifacts/semaframe-emergency-city-v4-en.mp4",
    posterPath: "artifacts/semaframe-emergency-city-v4-en-poster.png",
    readmePosterPath: "docs/media/semaframe-emergency-city-v4-en-poster.jpg",
  }),
  "traffic-vertical": Object.freeze({
    demo: "traffic",
    variant: "vertical",
    sourceRefs: Object.freeze(["emergencyCity", "emergencyCitySemanticLens"]),
    componentExport: "SemaFrameEmergencyCityProofV4EnglishVertical",
    compositionId: "SemaFrameEmergencyCityProofV4EnglishVertical",
    posterComponentExport: "SemaFrameEmergencyCityProofV4EnglishVerticalPoster",
    posterCompositionId: "SemaFrameEmergencyCityProofV4EnglishVerticalPoster",
    durationExpression: "EMERGENCY_CITY_PROOF_V4_VERTICAL_DURATION",
    width: 1080,
    height: 1920,
    fps: 30,
    durationFrames: 840,
    captionPath: "video/captions/semaframe-emergency-city-v4-vertical.en-US.srt",
    captionCueCount: 13,
    videoPath: "artifacts/semaframe-emergency-city-v4-en-vertical.mp4",
    posterPath: "artifacts/semaframe-emergency-city-v4-en-vertical-poster.png",
  }),
});

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function assertNoCjk(value, label = "English copy") {
  invariant(typeof value === "string", `${label} must be text.`);
  invariant(!CJK_PATTERN.test(value), `${label} contains CJK text.`);
}

export function assertTruthfulEnglishCopy(value, label = "English copy") {
  assertNoCjk(value, label);
  const forbidden = [
    /\b(?:live|real[- ]?time)\s+(?:(?:plant|factory|dispatch)\s+)?(?:data|telemetry|network feed)\b/iu,
    /\b(?:engineering|building|manufacturing|safety)\s+certified\b/iu,
    /\bcertified\s+(?:safe|collision[- ]free)\b/iu,
    /\bguarantees?\s+(?:safety|a collision[- ]free path)\b/iu,
    /\b(?:continuous(?:ly)?|full[- ]path)\s+(?:collision[- ]free|collision checking)\b/iu,
    /\bautonomously\s+(?:designed|engineered|certified)\b/iu,
    /\b(?:real|scanned)\s+(?:home|factory|city)\s+(?:scan|capture)\b/iu,
  ];
  for (const pattern of forbidden) {
    invariant(!pattern.test(value), `${label} contains an unsupported claim: ${pattern}.`);
  }
}

function assertExact(actual, expected, label) {
  invariant(isDeepStrictEqual(actual, expected), `${label} differs from the frozen English gallery specification.`);
}

export function validateGalleryContract(contract, options = {}) {
  invariant(contract?.format === "semaframe-english-demo-gallery-visual-contract", "English gallery contract format is invalid.");
  invariant(contract.version === 1, "English gallery contract version must be 1.");
  invariant(contract.locale === "en-US", "English gallery locale must be en-US.");
  invariant(contract.silentFirst === true, "English gallery must be silent-first.");
  invariant(contract.audioRequiredForComprehension === false, "English gallery audio must be optional for comprehension.");
  invariant(contract.rootRegistrationPath === "video/src/Root.tsx", "English gallery Root registration path changed.");
  invariant(contract.rootFolderName === "English-Demos", "English gallery compositions must remain grouped under English-Demos.");
  assertNoCjk(JSON.stringify(contract), "English gallery contract");
  if (options.contractText) assertNoCjk(options.contractText, "English gallery contract");

  invariant(contract.sources && typeof contract.sources === "object", "English gallery sources are missing.");
  assertExact(Object.keys(contract.sources).sort(), Object.keys(EXPECTED_SOURCES).sort(), "English gallery source keys");
  for (const [sourceRef, expectedPath] of Object.entries(EXPECTED_SOURCES)) {
    const source = contract.sources[sourceRef];
    invariant(source?.path === expectedPath, `${sourceRef} source path changed.`);
    invariant(SHA256_PATTERN.test(source.sha256), `${sourceRef} source hash must be a concrete SHA-256 value.`);
  }

  invariant(Array.isArray(contract.supportingContracts), "English gallery supporting contracts are missing.");
  assertExact(contract.supportingContracts.map((entry) => entry.path), EXPECTED_SUPPORTING_CONTRACTS, "English gallery supporting contract paths");
  for (const entry of contract.supportingContracts) {
    invariant(SHA256_PATTERN.test(entry.sha256), `${entry.path} hash must be a concrete SHA-256 value.`);
  }

  assertExact(contract.claimBoundaries, EXPECTED_CLAIM_BOUNDARIES, "English gallery claim boundaries");
  for (const [demo, boundary] of Object.entries(contract.claimBoundaries)) {
    invariant(Array.isArray(boundary.requiredVisibleCopy) && boundary.requiredVisibleCopy.length > 0, `${demo} must declare visible boundary copy.`);
    boundary.requiredVisibleCopy.forEach((copy) => assertTruthfulEnglishCopy(copy, `${demo} visible boundary copy`));
  }

  invariant(Array.isArray(contract.deliveries) && contract.deliveries.length === 5, "English gallery must declare exactly five deliveries.");
  invariant(new Set(contract.deliveries.map((delivery) => delivery.id)).size === 5, "English gallery delivery IDs must be unique.");
  invariant(new Set(contract.deliveries.map((delivery) => delivery.compositionId)).size === 5, "English gallery composition IDs must be unique.");
  invariant(new Set(contract.deliveries.map((delivery) => delivery.posterCompositionId)).size === 5, "English gallery poster IDs must be unique.");
  invariant(new Set(contract.deliveries.map((delivery) => delivery.videoPath)).size === 5, "English gallery output video paths must be unique.");
  invariant(new Set(contract.deliveries.map((delivery) => delivery.posterPath)).size === 5, "English gallery output poster paths must be unique.");
  const readmeDeliveries = contract.deliveries.filter((delivery) => delivery.readmePosterPath != null);
  invariant(readmeDeliveries.length === 3, "English gallery must declare exactly three README posters.");
  invariant(new Set(readmeDeliveries.map((delivery) => delivery.readmePosterPath)).size === 3, "English gallery README poster paths must be unique.");

  for (const delivery of contract.deliveries) {
    const expected = EXPECTED_DELIVERIES[delivery.id];
    invariant(expected, `Unknown English gallery delivery ${delivery.id}.`);
    for (const [field, expectedValue] of Object.entries(expected)) {
      assertExact(delivery[field], expectedValue, `${delivery.id} ${field}`);
    }
    invariant(SHA256_PATTERN.test(delivery.captionSha256), `${delivery.id} caption hash must be a concrete SHA-256 value.`);
    invariant(Number.isFinite(delivery.maxCaptionCps) && delivery.maxCaptionCps > 0, `${delivery.id} maxCaptionCps is invalid.`);
    invariant(Number.isFinite(delivery.maxCaptionGapSeconds) && delivery.maxCaptionGapSeconds >= 0, `${delivery.id} maxCaptionGapSeconds is invalid.`);
    invariant(delivery.videoPath.endsWith(".mp4"), `${delivery.id} video output must be MP4.`);
    invariant(delivery.posterPath.endsWith(".png"), `${delivery.id} poster output must be PNG.`);
    if (delivery.variant === "landscape") {
      invariant(delivery.readmePosterPath?.endsWith(".jpg"), `${delivery.id} must declare a JPEG README poster.`);
    } else {
      invariant(delivery.readmePosterPath == null, `${delivery.id} must not declare a vertical README poster.`);
    }
    invariant(contract.claimBoundaries[delivery.demo], `${delivery.id} has no claim boundary.`);
    for (const sourceRef of delivery.sourceRefs) invariant(contract.sources[sourceRef], `${delivery.id} references unknown source ${sourceRef}.`);
  }

  return {
    deliveryCount: contract.deliveries.length,
    compositionCount: contract.deliveries.length,
    posterCount: contract.deliveries.length,
    readmePosterCount: readmeDeliveries.length,
    locale: contract.locale,
  };
}

function timestampSeconds(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u.exec(value);
  invariant(match, `Invalid SRT timestamp ${value}.`);
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1_000;
}

export function validateEnglishSrt(contents, delivery) {
  assertNoCjk(contents, `${delivery.id} captions`);
  const blocks = contents.trim().split(/\r?\n\r?\n+/gu);
  invariant(blocks.length === delivery.captionCueCount, `${delivery.id} must contain exactly ${delivery.captionCueCount} caption cues.`);
  let previousEnd = 0;
  let maximumGapSeconds = 0;
  let maximumCps = 0;
  let longestLine = 0;
  const transcript = [];

  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/gu);
    invariant(lines[0] === String(index + 1), `${delivery.id} caption cue numbers must be contiguous.`);
    const timing = lines[1]?.split(" --> ");
    invariant(timing?.length === 2, `${delivery.id} cue ${index + 1} timing is invalid.`);
    const start = timestampSeconds(timing[0]);
    const end = timestampSeconds(timing[1]);
    invariant(index > 0 || Math.abs(start) <= 0.002, `${delivery.id} captions must begin at zero.`);
    invariant(start + 0.002 >= previousEnd, `${delivery.id} captions overlap before cue ${index + 1}.`);
    const gap = Math.max(0, start - previousEnd);
    invariant(gap <= delivery.maxCaptionGapSeconds + 0.002, `${delivery.id} has an excessive ${gap.toFixed(3)}s caption gap before cue ${index + 1}.`);
    invariant(end > start, `${delivery.id} cue ${index + 1} must have positive duration.`);
    const copyLines = lines.slice(2);
    invariant(copyLines.length >= 1 && copyLines.length <= 2 && copyLines.every((line) => line.trim()), `${delivery.id} cue ${index + 1} must contain one or two non-empty lines.`);
    for (const line of copyLines) {
      assertNoCjk(line, `${delivery.id} cue ${index + 1}`);
      longestLine = Math.max(longestLine, Array.from(line).length);
      invariant(Array.from(line).length <= 42, `${delivery.id} cue ${index + 1} has a line longer than 42 characters.`);
    }
    const cueText = copyLines.join(" ");
    const cps = Array.from(cueText.replace(/\s/gu, "")).length / (end - start);
    invariant(cps <= delivery.maxCaptionCps + 0.001, `${delivery.id} cue ${index + 1} exceeds ${delivery.maxCaptionCps} characters per second.`);
    maximumGapSeconds = Math.max(maximumGapSeconds, gap);
    maximumCps = Math.max(maximumCps, cps);
    transcript.push(cueText);
    previousEnd = end;
  }

  const durationSeconds = delivery.durationFrames / delivery.fps;
  invariant(Math.abs(previousEnd - durationSeconds) <= 0.002, `${delivery.id} captions must end at ${durationSeconds.toFixed(3)} seconds.`);
  assertTruthfulEnglishCopy(transcript.join(" "), `${delivery.id} caption transcript`);
  return {
    cueCount: blocks.length,
    durationSeconds: previousEnd,
    maximumGapSeconds,
    maximumCps,
    longestLine,
  };
}

function registrationTag(source, kind, id) {
  const pattern = new RegExp(`<${kind}\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(id)}["'][^>]*/>`, "gu");
  const matches = [...source.matchAll(pattern)];
  invariant(matches.length === 1, `${id} must be registered exactly once as ${kind}.`);
  return matches[0][0];
}

function assertJsxExpression(tag, attribute, expected, label) {
  const pattern = new RegExp(`\\b${escapeRegExp(attribute)}\\s*=\\s*\\{\\s*${escapeRegExp(String(expected))}\\s*\\}`, "u");
  invariant(pattern.test(tag), `${label} must set ${attribute}={${expected}}.`);
}

export function validateRootRegistrations(contract, rootSource, sourceTexts) {
  invariant(rootSource.includes(`<Folder name="${contract.rootFolderName}">`), `Root is missing the ${contract.rootFolderName} folder.`);
  invariant(/export const FPS\s*=\s*30\s*;/u.test(rootSource), "Root FPS must remain 30.");

  for (const delivery of contract.deliveries) {
    const sourceText = delivery.sourceRefs.map((sourceRef) => sourceTexts[sourceRef]).join("\n");
    invariant(new RegExp(`export const ${escapeRegExp(delivery.componentExport)}\\b`, "u").test(sourceText), `${delivery.componentExport} is not exported by its bound source.`);
    invariant(new RegExp(`export const ${escapeRegExp(delivery.posterComponentExport)}\\b`, "u").test(sourceText), `${delivery.posterComponentExport} is not exported by its bound source.`);
    invariant(new RegExp(`export const ${escapeRegExp(delivery.durationExpression)}\\b`, "u").test(sourceText), `${delivery.durationExpression} is not exported by its bound source.`);

    const composition = registrationTag(rootSource, "Composition", delivery.compositionId);
    assertJsxExpression(composition, "component", delivery.componentExport, delivery.compositionId);
    assertJsxExpression(composition, "width", delivery.width, delivery.compositionId);
    assertJsxExpression(composition, "height", delivery.height, delivery.compositionId);
    assertJsxExpression(composition, "fps", "FPS", delivery.compositionId);
    assertJsxExpression(composition, "durationInFrames", delivery.durationExpression, delivery.compositionId);

    const poster = registrationTag(rootSource, "Still", delivery.posterCompositionId);
    assertJsxExpression(poster, "component", delivery.posterComponentExport, delivery.posterCompositionId);
    assertJsxExpression(poster, "width", delivery.width, delivery.posterCompositionId);
    assertJsxExpression(poster, "height", delivery.height, delivery.posterCompositionId);
  }
  return {compositions: contract.deliveries.length, posters: contract.deliveries.length, fps: 30};
}

export function verifyStaticBindings(contract, root = process.cwd()) {
  const sourceTexts = {};
  const sourceHashes = {};
  for (const [sourceRef, source] of Object.entries(contract.sources)) {
    const path = resolve(root, source.path);
    invariant(existsSync(path), `Missing English gallery source ${source.path}.`);
    const actualHash = sha256File(path);
    invariant(actualHash === source.sha256, `${source.path} is stale relative to the English gallery contract.`);
    sourceTexts[sourceRef] = readFileSync(path, "utf8");
    sourceHashes[sourceRef] = actualHash;
  }

  const supportingContracts = {};
  for (const descriptor of contract.supportingContracts) {
    const path = resolve(root, descriptor.path);
    invariant(existsSync(path), `Missing supporting English contract ${descriptor.path}.`);
    const contents = readFileSync(path, "utf8");
    assertTruthfulEnglishCopy(contents, descriptor.path);
    const actualHash = sha256(contents);
    invariant(actualHash === descriptor.sha256, `${descriptor.path} is stale relative to the English gallery contract.`);
    const parsed = JSON.parse(contents);
    invariant(parsed.locale === "en-US", `${descriptor.path} must declare locale en-US.`);
    if (parsed.compositionSourcePath) {
      const source = Object.values(contract.sources).find((candidate) => candidate.path === parsed.compositionSourcePath);
      invariant(source, `${descriptor.path} references an unbound composition source.`);
      if (parsed.compositionSourceSha256) {
        invariant(parsed.compositionSourceSha256 === source.sha256, `${descriptor.path} composition source hash disagrees with the English gallery contract.`);
      }
    }
    if (parsed.semanticOverlaySourcePath) {
      const source = Object.values(contract.sources).find((candidate) => candidate.path === parsed.semanticOverlaySourcePath);
      invariant(source, `${descriptor.path} references an unbound semantic-overlay source.`);
      if (parsed.semanticOverlaySourceSha256) {
        invariant(parsed.semanticOverlaySourceSha256 === source.sha256, `${descriptor.path} semantic-overlay source hash disagrees with the English gallery contract.`);
      }
    }
    supportingContracts[descriptor.path] = actualHash;
  }

  for (const [demo, boundary] of Object.entries(contract.claimBoundaries)) {
    const delivery = contract.deliveries.find((candidate) => candidate.demo === demo);
    invariant(delivery, `${demo} has no bound delivery.`);
    const boundSource = delivery.sourceRefs.map((sourceRef) => sourceTexts[sourceRef]).join("\n");
    for (const copy of boundary.requiredVisibleCopy) {
      invariant(boundSource.includes(copy), `${demo} source is missing visible claim boundary: ${copy}`);
    }
  }

  const captions = {};
  for (const delivery of contract.deliveries) {
    const path = resolve(root, delivery.captionPath);
    invariant(existsSync(path), `Missing English caption artifact ${delivery.captionPath}.`);
    const actualHash = sha256File(path);
    invariant(actualHash === delivery.captionSha256, `${delivery.captionPath} is stale relative to the English gallery contract.`);
    captions[delivery.id] = {
      ...validateEnglishSrt(readFileSync(path, "utf8"), delivery),
      sha256: actualHash,
    };
  }

  const rootPath = resolve(root, contract.rootRegistrationPath);
  invariant(existsSync(rootPath), `Missing Remotion Root at ${contract.rootRegistrationPath}.`);
  const registrations = validateRootRegistrations(contract, readFileSync(rootPath, "utf8"), sourceTexts);
  const readmePath = resolve(root, README_PATH);
  invariant(existsSync(readmePath), `Missing ${README_PATH}.`);
  const readme = readFileSync(readmePath, "utf8");
  const readmeDeliveries = contract.deliveries.filter((delivery) => delivery.readmePosterPath != null);
  for (const delivery of readmeDeliveries) {
    const posterReference = `src="./${delivery.readmePosterPath}"`;
    const releaseReference = `${RELEASE_DOWNLOAD_BASE}/${basename(delivery.videoPath)}`;
    invariant(readme.includes(posterReference), `${README_PATH} does not show ${delivery.readmePosterPath}.`);
    invariant(readme.includes(releaseReference), `${README_PATH} does not link ${delivery.id} to its stable release asset.`);
  }
  return {
    sourceHashes,
    supportingContracts,
    captions,
    registrations,
    readmeGallery: {path: README_PATH, posterCount: readmeDeliveries.length, releaseTag: "demo-gallery-v1"},
  };
}

function run(command, args, root, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
  });
  invariant(!result.error, `${command} could not start: ${result.error?.message ?? "unknown error"}`);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
  invariant(result.status === 0, `${command} failed (${result.status}): ${(stderr || stdout || "unknown error").trim()}`);
  return result;
}

function probe(path, root, countFrames = false) {
  const result = run("ffprobe", [
    "-v", "error",
    ...(countFrames ? ["-count_frames"] : []),
    "-show_entries",
    "format=duration,format_name:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,nb_frames,sample_rate,channels,channel_layout,color_range,color_space,color_transfer,color_primaries",
    "-of", "json",
    path,
  ], root);
  return JSON.parse(result.stdout);
}

function rationalNumber(value) {
  const match = /^(\d+)\/(\d+)$/u.exec(value ?? "");
  return match && Number(match[2]) !== 0 ? Number(match[1]) / Number(match[2]) : Number.NaN;
}

export function validateMediaProbe(probeResult, delivery, atoms) {
  invariant(probeResult?.format?.format_name?.split(",").includes("mp4"), `${delivery.id} must use an MP4 container.`);
  const videoStreams = probeResult.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const audioStreams = probeResult.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  invariant(videoStreams.length === 1, `${delivery.id} must contain exactly one video stream.`);
  invariant(audioStreams.length === 1, `${delivery.id} must contain exactly one audio stream.`);
  const video = videoStreams[0];
  const audio = audioStreams[0];
  invariant(video.codec_name === "h264", `${delivery.id} video must use H.264.`);
  invariant(video.width === delivery.width && video.height === delivery.height, `${delivery.id} video dimensions are invalid.`);
  invariant(video.pix_fmt === "yuv420p", `${delivery.id} video must use yuv420p.`);
  invariant(Math.abs(rationalNumber(video.r_frame_rate) - delivery.fps) < 0.0001, `${delivery.id} r_frame_rate must be 30 fps.`);
  invariant(Math.abs(rationalNumber(video.avg_frame_rate) - delivery.fps) < 0.0001, `${delivery.id} avg_frame_rate must be 30 fps.`);
  const decodedFrames = Number(video.nb_read_frames ?? video.nb_frames);
  invariant(decodedFrames === delivery.durationFrames, `${delivery.id} must decode exactly ${delivery.durationFrames} frames.`);
  const durationSeconds = Number(probeResult.format.duration);
  invariant(Math.abs(durationSeconds - delivery.durationFrames / delivery.fps) <= 0.08, `${delivery.id} duration is invalid.`);
  invariant(video.color_range === "tv", `${delivery.id} must use limited-range video levels.`);
  invariant(video.color_space === "bt709" && video.color_transfer === "bt709" && video.color_primaries === "bt709", `${delivery.id} must be fully tagged BT.709.`);
  invariant(audio.codec_name === "aac", `${delivery.id} audio must use AAC.`);
  invariant(Number(audio.sample_rate) === 48_000, `${delivery.id} audio must use 48 kHz.`);
  invariant(audio.channels === 2, `${delivery.id} audio must be stereo.`);
  if (audio.channel_layout != null) invariant(audio.channel_layout === "stereo", `${delivery.id} audio channel layout must be stereo.`);

  const moov = atoms.find((atom) => atom.type === "moov");
  const mdat = atoms.find((atom) => atom.type === "mdat");
  invariant(moov && mdat && moov.offset < mdat.offset, `${delivery.id} must use fast-start MP4 atom ordering.`);
  return {
    codec: video.codec_name,
    width: video.width,
    height: video.height,
    frameRate: rationalNumber(video.avg_frame_rate),
    decodedFrames,
    durationSeconds,
    pixelFormat: video.pix_fmt,
    color: {
      range: video.color_range,
      space: video.color_space,
      transfer: video.color_transfer,
      primaries: video.color_primaries,
    },
    audio: {codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels},
    fastStart: true,
  };
}

export function validateLumaAnalysis(analysis, delivery) {
  const durationSeconds = delivery.durationFrames / delivery.fps;
  invariant(analysis.sampleCount >= durationSeconds * SAMPLE_FPS - 1, `${delivery.id} produced too few decoded luma samples.`);
  invariant(analysis.maxBlackRunSeconds <= 0.8, `${delivery.id} contains a ${analysis.maxBlackRunSeconds.toFixed(1)}s black span.`);
  invariant(analysis.maxFrozenRunSeconds <= 3, `${delivery.id} contains a ${analysis.maxFrozenRunSeconds.toFixed(1)}s frozen span.`);
  invariant(analysis.meanLuma.average >= 8 && analysis.meanLuma.average <= 247, `${delivery.id} has implausible average luma.`);
  invariant(analysis.meanLuma.maximum - analysis.meanLuma.minimum >= 3, `${delivery.id} lacks meaningful luma evolution.`);
  return analysis;
}

export function validatePosterProbe(probeResult, delivery, luma) {
  const streams = probeResult?.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  invariant(streams.length === 1, `${delivery.id} poster must decode as one image stream.`);
  const poster = streams[0];
  invariant(poster.codec_name === "png", `${delivery.id} poster must be PNG.`);
  invariant(poster.width === delivery.width && poster.height === delivery.height, `${delivery.id} poster dimensions are invalid.`);
  invariant(luma.sampleCount === 1, `${delivery.id} poster must decode as exactly one frame.`);
  invariant(luma.meanLuma.average >= 8 && luma.meanLuma.average <= 247, `${delivery.id} poster has implausible average luma.`);
  invariant(luma.minimumFrameStandardDeviation >= 8, `${delivery.id} poster is blank or visually flat.`);
  return {
    codec: poster.codec_name,
    width: poster.width,
    height: poster.height,
    meanLuma: luma.meanLuma.average,
    standardDeviation: luma.minimumFrameStandardDeviation,
  };
}

export function validateReadmePosterProbe(probeResult, delivery, luma) {
  const streams = probeResult?.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  invariant(streams.length === 1, `${delivery.id} README poster must decode as one image stream.`);
  const poster = streams[0];
  invariant(poster.codec_name === "mjpeg", `${delivery.id} README poster must be JPEG.`);
  invariant(poster.width === 1280 && poster.height === 720, `${delivery.id} README poster must be 1280x720.`);
  invariant(luma.sampleCount === 1, `${delivery.id} README poster must decode as exactly one frame.`);
  invariant(luma.meanLuma.average >= 8 && luma.meanLuma.average <= 247, `${delivery.id} README poster has implausible average luma.`);
  invariant(luma.minimumFrameStandardDeviation >= 8, `${delivery.id} README poster is blank or visually flat.`);
  return {
    codec: poster.codec_name,
    width: poster.width,
    height: poster.height,
    meanLuma: luma.meanLuma.average,
    standardDeviation: luma.minimumFrameStandardDeviation,
  };
}

function newestMtimeMs(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path, {withFileTypes: true})) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(entryPath));
    else if (entry.isFile()) newest = Math.max(newest, statSync(entryPath).mtimeMs);
  }
  return newest;
}

export function assertArtifactFreshness({artifactPath, dependencyPaths, root = process.cwd()}) {
  const resolvedArtifact = resolve(root, artifactPath);
  invariant(existsSync(resolvedArtifact), `Missing media artifact ${artifactPath}.`);
  invariant(Array.isArray(dependencyPaths) && dependencyPaths.length > 0, `${artifactPath} must declare render dependencies.`);
  const dependencies = dependencyPaths.map((dependencyPath) => {
    const path = resolve(root, dependencyPath);
    invariant(existsSync(path), `Missing render dependency ${dependencyPath}.`);
    return {path: dependencyPath, modifiedMs: newestMtimeMs(path)};
  });
  const artifactModifiedMs = statSync(resolvedArtifact).mtimeMs;
  const newestDependency = dependencies.reduce((left, right) => left.modifiedMs >= right.modifiedMs ? left : right);
  invariant(artifactModifiedMs >= newestDependency.modifiedMs, `${artifactPath} predates ${newestDependency.path}; re-render before verification.`);
  return {
    artifactModifiedAt: new Date(artifactModifiedMs).toISOString(),
    newestDependency: newestDependency.path,
    newestDependencyModifiedAt: new Date(newestDependency.modifiedMs).toISOString(),
  };
}

function sampleVideo(path, delivery, root) {
  const landscape = delivery.width >= delivery.height;
  const sampleWidth = landscape ? SAMPLE_LONG_EDGE : SAMPLE_SHORT_EDGE;
  const sampleHeight = landscape ? SAMPLE_SHORT_EDGE : SAMPLE_LONG_EDGE;
  const result = run("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `fps=${SAMPLE_FPS},scale=${sampleWidth}:${sampleHeight}:flags=area,format=gray`,
    "-an", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], root, {encoding: null});
  const analysis = analyzeSampleBuffer(result.stdout, sampleWidth * sampleHeight, SAMPLE_FPS);
  return validateLumaAnalysis({...analysis, sampleWidth, sampleHeight}, delivery);
}

function samplePoster(path, delivery, root) {
  const landscape = delivery.width >= delivery.height;
  const sampleWidth = landscape ? SAMPLE_LONG_EDGE : SAMPLE_SHORT_EDGE;
  const sampleHeight = landscape ? SAMPLE_SHORT_EDGE : SAMPLE_LONG_EDGE;
  const result = run("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `scale=${sampleWidth}:${sampleHeight}:flags=area,format=gray`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], root, {encoding: null});
  return analyzeSampleBuffer(result.stdout, sampleWidth * sampleHeight, 1);
}

export function verifyRenderedDelivery(contract, delivery, root = process.cwd()) {
  const sourcePaths = delivery.sourceRefs.map((sourceRef) => contract.sources[sourceRef].path);
  const commonDependencies = [contract.rootRegistrationPath, ...sourcePaths, delivery.captureRoot];
  const freshness = {
    video: assertArtifactFreshness({
      artifactPath: delivery.videoPath,
      dependencyPaths: [...commonDependencies, delivery.audioPath],
      root,
    }),
    poster: assertArtifactFreshness({
      artifactPath: delivery.posterPath,
      dependencyPaths: commonDependencies,
      root,
    }),
  };

  const videoPath = resolve(root, delivery.videoPath);
  const posterPath = resolve(root, delivery.posterPath);
  const media = validateMediaProbe(probe(videoPath, root, true), delivery, readTopLevelMp4Atoms(videoPath));
  const luma = sampleVideo(videoPath, delivery, root);
  const poster = validatePosterProbe(probe(posterPath, root), delivery, samplePoster(posterPath, delivery, root));
  let readmePoster = null;
  if (delivery.readmePosterPath) {
    const readmePosterPath = resolve(root, delivery.readmePosterPath);
    const readmeFreshness = assertArtifactFreshness({
      artifactPath: delivery.readmePosterPath,
      dependencyPaths: [delivery.posterPath],
      root,
    });
    readmePoster = {
      ...validateReadmePosterProbe(probe(readmePosterPath, root), delivery, samplePoster(readmePosterPath, delivery, root)),
      freshness: readmeFreshness,
      sha256: sha256File(readmePosterPath),
    };
  }
  return {
    ...media,
    luma,
    poster,
    readmePoster,
    freshness,
    hashes: {video: sha256File(videoPath), poster: sha256File(posterPath)},
  };
}

export function verifyEnglishDemoGallery(root = process.cwd(), options = {}) {
  const staticOnly = options.staticOnly === true;
  const contractPath = resolve(root, CONTRACT_PATH);
  invariant(existsSync(contractPath), `Missing English gallery contract ${CONTRACT_PATH}.`);
  const contractText = readFileSync(contractPath, "utf8");
  const contract = JSON.parse(contractText);
  const contractSummary = validateGalleryContract(contract, {contractText});
  const staticBindings = verifyStaticBindings(contract, root);
  const media = staticOnly
    ? {status: "skipped", reason: "static-only mode"}
    : {
        status: "passed",
        deliveries: Object.fromEntries(contract.deliveries.map((delivery) => [
          delivery.id,
          verifyRenderedDelivery(contract, delivery, root),
        ])),
      };
  return {
    verificationVersion: 1,
    result: "passed",
    mode: staticOnly ? "static-only" : "full",
    verifiedAt: new Date().toISOString(),
    contract: {...contractSummary, sha256: sha256(contractText)},
    staticBindings,
    media,
  };
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const allowed = new Set(["--static-only"]);
  for (const argument of argv) invariant(allowed.has(argument), `Unknown argument ${argument}. Use --static-only or no arguments.`);
  const staticOnly = argv.includes("--static-only");
  const report = verifyEnglishDemoGallery(root, {staticOnly});
  if (!staticOnly) {
    const receiptPath = resolve(root, RECEIPT_PATH);
    mkdirSync(dirname(receiptPath), {recursive: true});
    writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`English demo gallery verification passed (${report.mode}; ${report.contract.deliveryCount} deliveries).`);
  if (!staticOnly) console.log(`Receipt: ${relative(root, resolve(root, RECEIPT_PATH))}`);
  return report;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`English demo gallery verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
