import {createHash} from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {basename, join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {
  analyzeSampleBuffer,
  readTopLevelMp4Atoms,
} from "./verify-emergency-city-v3.mjs";

const CONTRACT_PATH = "video/realityops-v2.visual-contract.json";
const RECEIPT_PATH = "artifacts/semaframe-realityops-v2-verification.json";
const PROJECT_PATH = "artifacts/realityops/realityops-pump-room.semaframe.json";
const EXPORT_ROOT = "artifacts/realityops";
const AUDIO_PATH = "video/public/audio/semaframe-original-bed.wav";
const MAX_BUFFER = 256 * 1024 * 1024;

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
    throw new Error(`${label} failed: ${stderr || stdout || result.error?.message || "unknown error"}`);
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

function resolved(root, path) {
  return resolve(root, path);
}

function isSha256(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
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

export function assertTruthfulVisibleCopy(text, label = "visible copy") {
  const forbidden = [
    /\b(?:live|real-time) (?:plant )?(?:data|telemetry)\b/iu,
    /(?:现场实时|实时工厂|实时遥测)/u,
    /\bautonom(?:ous|ously) (?:design|designed|engineer)/iu,
    /自主(?:设计|完成工程)/u,
    /(?:engineering|safety|manufacturing) certified/iu,
    /(?:工程|安全|制造)认证通过/u,
    /whole (?:pump room|workspace) export/iu,
    /导出(?:整个|完整)泵房/u,
  ];
  for (const pattern of forbidden) {
    invariant(!pattern.test(text), `${label} contains an unsupported claim: ${pattern}.`);
  }
}

export function validateVisualContract(contract, options = {}) {
  invariant(contract?.format === "semaframe-realityops-proof-visual-contract", "RealityOps V2 contract format is invalid.");
  invariant(contract.version === 2, "RealityOps V2 contract version must be 2.");
  invariant(contract.silentFirst === true, "RealityOps V2 must declare silentFirst=true.");
  invariant(contract.audioRequiredForComprehension === false, "RealityOps V2 audio must be optional for comprehension.");
  invariant(Array.isArray(contract.requiredBeats) && contract.requiredBeats.length === 12, "RealityOps V2 must declare exactly 12 required beats.");
  invariant(new Set(contract.requiredBeats).size === 12, "RealityOps V2 beat IDs must be unique.");
  invariant(contract.source.captureDimensions.width === 1600 && contract.source.captureDimensions.height === 900, "RealityOps capture dimensions must be 1600x900.");
  invariant(contract.source.frameCountPerFolder === 48, "RealityOps source folders must contain 48 frames.");
  for (const key of ["compositionSourceSha256", "captureScriptSha256", "evidenceSha256", "captureAssetManifestSha256"]) {
    invariant(isSha256(contract.source[key]), `RealityOps contract ${key} must be a concrete SHA-256 value.`);
  }

  const expected = {
    landscape: {width: 1920, height: 1080, frames: 1080, deadline: 150},
    vertical: {width: 1080, height: 1920, frames: 960, deadline: 120},
  };
  for (const [variant, delivery] of Object.entries(contract.delivery)) {
    const target = expected[variant];
    invariant(target, `Unknown RealityOps V2 delivery variant ${variant}.`);
    invariant(delivery.width === target.width && delivery.height === target.height, `${variant} delivery dimensions are invalid.`);
    invariant(delivery.fps === 30 && delivery.durationFrames === target.frames, `${variant} delivery timing is invalid.`);
    invariant(delivery.productComprehensionDeadlineFrame <= target.deadline, `${variant} product-comprehension deadline is too late.`);
    invariant(Array.isArray(delivery.beats) && delivery.beats.length === contract.requiredBeats.length, `${variant} must contain all required beats.`);
    let cursor = 0;
    for (const [index, beat] of delivery.beats.entries()) {
      invariant(beat.id === contract.requiredBeats[index], `${variant} beat ${index + 1} must be ${contract.requiredBeats[index]}.`);
      invariant(beat.from === cursor, `${variant} beat ${beat.id} must begin at frame ${cursor}.`);
      invariant(Number.isInteger(beat.duration) && beat.duration >= 45, `${variant} beat ${beat.id} is too short for silent comprehension.`);
      cursor += beat.duration;
      assertTruthfulVisibleCopy(`${beat.title} ${beat.source}`, `${variant} ${beat.id}`);
    }
    invariant(cursor === delivery.durationFrames, `${variant} beats must cover the complete composition.`);
    const productBeat = delivery.beats.find((beat) => beat.id === "product_definition");
    invariant(productBeat.from + productBeat.duration <= delivery.productComprehensionDeadlineFrame, `${variant} product definition misses its declared deadline.`);
    for (const [label, rect] of [
      ["title", delivery.titleBounds],
      ["proof", delivery.proofBounds],
      ["boundary note", delivery.boundaryNoteBounds],
      ...delivery.overlayBounds.map((rect) => [`overlay ${rect.id}`, rect]),
    ]) {
      invariant(insideSafeArea(rect, delivery), `${variant} ${label} leaves the declared safe area.`);
    }
    invariant(!rectanglesIntersect(delivery.titleBounds, delivery.proofBounds), `${variant} title and proof bounds overlap.`);
    invariant(!rectanglesIntersect(delivery.proofBounds, delivery.boundaryNoteBounds), `${variant} proof and boundary note overlap.`);
    invariant(Object.keys(delivery.captions).sort().join(",") === "en-US,zh-CN", `${variant} must declare zh-CN and en-US captions.`);
  }
  if (options.sourceText) {
    const text = options.sourceText;
    for (const required of [
      "premountFor={fps}",
      "<Img",
      "useCurrentFrame",
      "ROOT + 7 EDITABLE PARTS",
      "遥测为确定性快照",
      "REJECTED · 修订号保持 10",
      "仅发布泵组",
    ]) {
      invariant(text.includes(required), `RealityOps composition source is missing ${required}.`);
    }
    invariant(!/transition:\s|animation:\s/gu.test(text), "RealityOps composition must not use CSS transitions or animations.");
  }
  return {
    requiredBeatCount: contract.requiredBeats.length,
    landscapeFrames: contract.delivery.landscape.durationFrames,
    verticalFrames: contract.delivery.vertical.durationFrames,
  };
}

function timestampSeconds(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u.exec(value);
  invariant(match, `Invalid SRT timestamp ${value}.`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function nonWhitespaceLength(value) {
  return Array.from(value.replace(/\s/gu, "")).length;
}

export function validateTimedTranscript(contents, options) {
  const blocks = contents.trim().split(/\r?\n\r?\n+/gu);
  invariant(blocks.length === 12, `${options.id} must contain exactly 12 cues.`);
  let previousEnd = 0;
  let maximumCps = 0;
  let longestLine = 0;
  const text = [];
  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/gu);
    invariant(lines[0] === String(index + 1), `${options.id} cue numbers must be contiguous.`);
    const range = lines[1]?.split(" --> ");
    invariant(range?.length === 2, `${options.id} cue ${index + 1} timing is invalid.`);
    const start = timestampSeconds(range[0]);
    const end = timestampSeconds(range[1]);
    invariant(Math.abs(start - previousEnd) <= 0.002, `${options.id} has a gap or overlap before cue ${index + 1}.`);
    invariant(end > start, `${options.id} cue ${index + 1} must have positive duration.`);
    const linesOfText = lines.slice(2);
    invariant(linesOfText.length >= 1 && linesOfText.every((line) => line.trim()), `${options.id} cue ${index + 1} has empty text.`);
    longestLine = Math.max(longestLine, ...linesOfText.map((line) => Array.from(line).length));
    const cueText = linesOfText.join(" ");
    maximumCps = Math.max(maximumCps, nonWhitespaceLength(cueText) / (end - start));
    text.push(cueText);
    previousEnd = end;
  }
  invariant(Math.abs(previousEnd - options.durationSeconds) <= 0.002, `${options.id} must cover the complete composition.`);
  invariant(maximumCps <= 22, `${options.id} exceeds 22 non-whitespace characters per second.`);
  invariant(longestLine <= 42, `${options.id} contains a line longer than 42 characters.`);
  const transcript = text.join(" ");
  assertTruthfulVisibleCopy(transcript, options.id);
  if (options.language === "zh-CN") {
    invariant(/SemaFrame/iu.test(transcript) && /修订号保持 10/u.test(transcript), `${options.id} must preserve product and rejection evidence.`);
  } else {
    invariant(/SemaFrame/iu.test(transcript) && /Revision 10 stays unchanged/iu.test(transcript), `${options.id} must preserve product and rejection evidence.`);
  }
  return {cueCount: blocks.length, maximumCps, longestLine, durationSeconds: previousEnd};
}

function walkObjects(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (!Array.isArray(value)) result.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) walkObjects(child, result);
  return result;
}

export function validateEvidence(evidence, projectText, exportFiles) {
  invariant(evidence.format === "semaframe-realityops-demo-evidence" && evidence.version === 1, "RealityOps evidence identity is invalid.");
  invariant(evidence.syntheticBaseline === true && evidence.sourcePhotosOrScansUsed === false, "RealityOps must remain a synthetic no-scan baseline.");
  invariant(evidence.claimBoundary.telemetry === "deterministic inline snapshot replay", "RealityOps telemetry boundary changed.");
  invariant(/not certification/iu.test(evidence.claimBoundary.physics), "RealityOps physics boundary must deny certification.");
  invariant(evidence.claimBoundary.exports === "published pump model only", "RealityOps export boundary changed.");

  const collision = evidence.collisionPreflight;
  invariant(collision.valid === false && collision.rejectedBatchCode === "spatial_collision", "RealityOps collision rejection is missing.");
  invariant(Array.isArray(collision.conflicts) && collision.conflicts.length > 0, "RealityOps rejected candidate must include a conflict.");
  invariant(collision.revisionBeforeRejection === 10 && collision.revisionAfterRejection === 10 && collision.atomic === true, "RealityOps rejection must preserve revision 10 atomically.");

  const corrected = evidence.correctedWorkspace;
  invariant(corrected.revision === 15 && corrected.ssgFormat === "semaframe-spatial-graph" && corrected.ssgVersion === "3.1", "RealityOps corrected spatial state is invalid.");
  invariant(corrected.collisionConflictCount === 0, "RealityOps corrected state must have zero collisions.");
  invariant(corrected.physicsVersion === "2.0" && corrected.physicsFeasible === true && corrected.physicsIssueCodes.length === 0, "RealityOps bounded physics evidence is invalid.");

  const model = evidence.model;
  invariant(model.modelId === "com.semaframe.realityops.pump-skid" && model.version === "1.0.0", "RealityOps model identity changed.");
  invariant(model.nodeCount === 8 && model.sourceRootId !== model.instanceRootId && model.editableSourceAndInstance === true, "RealityOps reusable model evidence is invalid.");

  const data = evidence.dataAndAction;
  invariant(data.resourceId === "RES_p102_vibration" && data.resourceMode === "manual", "RealityOps snapshot resource evidence changed.");
  invariant(data.bindingIds.join(",") === "BIND_p102_labels,BIND_p102_series", "RealityOps chart bindings changed.");
  invariant(data.eventConnectionId === "EVENT_start_p102" && data.action === "button.pressed -> beacon.toggle_visibility", "RealityOps 2D-to-3D action evidence changed.");

  const persistence = evidence.persistence;
  invariant(persistence.savedRevision === 15 && persistence.reopenedRevision === 15, "RealityOps reopened revision must remain 15.");
  invariant(persistence.savedComponentCount === 37 && persistence.reopenedComponentCount === 37 && persistence.preserved === true, "RealityOps component persistence evidence is invalid.");
  invariant(sha256(projectText.trim()) === persistence.projectSha256, "RealityOps project hash does not match the captured save payload.");
  const project = JSON.parse(projectText);
  const objects = walkObjects(project);
  invariant(objects.some((object) => object.pressCount === 1), "RealityOps project does not preserve the real button press.");
  invariant(objects.some((object) => object.id === "CMP_000117" && object.visibility === "visible"), "RealityOps project does not preserve the visible 3D beacon.");
  invariant(objects.some((object) => object.causedBy?.connectionId === "EVENT_start_p102"), "RealityOps project does not preserve the button-to-beacon connection cause.");

  for (const kind of ["usda", "step"]) {
    const descriptor = evidence.exports[kind];
    const bytes = exportFiles[kind];
    invariant(descriptor.valid === true && bytes.length === descriptor.byteLength, `RealityOps ${kind} export size is invalid.`);
    invariant(sha256(bytes) === descriptor.sha256, `RealityOps ${kind} export hash is invalid.`);
  }
  const usda = exportFiles.usda.toString("utf8");
  invariant(/metersPerUnit\s*=\s*1/u.test(usda) && /upAxis\s*=\s*"Y"/u.test(usda), "RealityOps USDA stage metadata is invalid.");
  invariant(/def Xform "Pump_skid_P_101_source"/u.test(usda), "RealityOps USDA does not contain the published pump root.");
  const step = exportFiles.step.toString("utf8");
  invariant(step.startsWith("ISO-10303-21;") && /FILE_SCHEMA/u.test(step) && /MANIFOLD_SOLID_BREP/u.test(step) && /END-ISO-10303-21;/u.test(step), "RealityOps STEP structure is invalid.");
  return {
    rejectedRevision: collision.revisionBeforeRejection,
    correctedRevision: corrected.revision,
    modelNodeCount: model.nodeCount,
    savedComponentCount: persistence.savedComponentCount,
    action: data.action,
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
    if (sof.has(marker)) return {height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5)};
    offset += length;
  }
  throw new Error("JPEG dimensions were not found.");
}

function pngDimensions(buffer) {
  invariant(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Invalid PNG signature.");
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

export function imageDimensions(path) {
  const bytes = readFileSync(path);
  return bytes[0] === 0x89 ? pngDimensions(bytes) : jpegDimensions(bytes);
}

export function computeCaptureAssetManifest(root, contract) {
  const relative = contract.source.captureFolders.flatMap((folder) =>
    Array.from({length: contract.source.frameCountPerFolder}, (_, frame) =>
      join(contract.source.assetRoot, folder, `frame-${String(frame).padStart(4, "0")}.jpg`),
    ),
  ).concat(contract.source.stills.map((name) => join(contract.source.assetRoot, name)));
  const entries = relative.map((path) => {
    const absolute = resolved(root, path);
    invariant(existsSync(absolute), `RealityOps source asset is missing: ${path}.`);
    return `${path}:${sha256File(absolute).slice("sha256:".length)}`;
  });
  return {fileCount: relative.length, hash: sha256(entries.join("\n")), files: relative};
}

function verifyCaptureAssets(root, contract) {
  for (const folder of contract.source.captureFolders) {
    const directory = resolved(root, join(contract.source.assetRoot, folder));
    const expected = Array.from({length: 48}, (_, frame) => `frame-${String(frame).padStart(4, "0")}.jpg`);
    const actual = readdirSync(directory).filter((name) => name.endsWith(".jpg")).sort();
    invariant(actual.join("\n") === expected.join("\n"), `${folder} must contain exactly 48 contiguous JPEGs.`);
    for (const name of [actual[0], actual.at(-1)]) {
      const dimensions = imageDimensions(join(directory, name));
      invariant(dimensions.width === 1600 && dimensions.height === 900, `${folder}/${name} must be 1600x900.`);
    }
    run("ffmpeg", ["-v", "error", "-framerate", "30", "-pattern_type", "glob", "-i", join(directory, "*.jpg"), "-f", "null", "-"], `${folder} decode`);
  }
  for (const name of contract.source.stills) {
    const dimensions = imageDimensions(resolved(root, join(contract.source.assetRoot, name)));
    invariant(dimensions.width === 1600 && dimensions.height === 900, `${name} must be 1600x900.`);
  }
  const manifest = computeCaptureAssetManifest(root, contract);
  invariant(manifest.fileCount === 340, "RealityOps V2 must bind exactly 340 source assets.");
  invariant(manifest.hash === contract.source.captureAssetManifestSha256, "RealityOps capture asset manifest hash changed.");
  return manifest;
}

function parseLoudness(stderr, label) {
  const reports = stderr.match(/\{\s*"input_i"[\s\S]*?\}/gu) ?? [];
  const report = JSON.parse(reports.at(-1) ?? "null");
  invariant(report && Number.isFinite(Number(report.input_i)) && Number.isFinite(Number(report.input_tp)), `${label} loudness analysis is invalid.`);
  return {integratedLufs: Number(report.input_i), truePeakDbfs: Number(report.input_tp), loudnessRangeLu: Number(report.input_lra)};
}

function posterAnalysis(path) {
  const raw = run("ffmpeg", ["-v", "error", "-i", path, "-vf", "scale=160:90:flags=area,format=gray", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], `${basename(path)} poster analysis`, {encoding: null}).stdout;
  const analysis = analyzeSampleBuffer(raw, 160 * 90, 1);
  invariant(analysis.meanLuma.average >= 12 && analysis.minimumFrameStandardDeviation >= 8, `${basename(path)} is blank or visually flat.`);
  return {meanLuma: analysis.meanLuma.average, standardDeviation: analysis.minimumFrameStandardDeviation};
}

function probeMedia(path, delivery) {
  const probe = readJsonFromCommand("ffprobe", [
    "-v", "error", "-count_frames",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,nb_frames,color_range,color_space,color_transfer,color_primaries,sample_rate,channels",
    "-of", "json", path,
  ], `${basename(path)} ffprobe`);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  invariant(video?.codec_name === "h264", `${basename(path)} must use H.264.`);
  invariant(video.width === delivery.width && video.height === delivery.height, `${basename(path)} dimensions are invalid.`);
  invariant(video.pix_fmt === "yuv420p", `${basename(path)} must use yuv420p.`);
  invariant(video.r_frame_rate === "30/1" && video.avg_frame_rate === "30/1", `${basename(path)} must be constant 30 fps.`);
  invariant(Number(video.nb_read_frames ?? video.nb_frames) === delivery.durationFrames, `${basename(path)} decoded frame count is invalid.`);
  invariant(Math.abs(Number(probe.format.duration) - delivery.durationFrames / delivery.fps) <= 0.08, `${basename(path)} duration is invalid.`);
  invariant(video.color_range === "tv" && video.color_space === "bt709" && video.color_transfer === "bt709" && video.color_primaries === "bt709", `${basename(path)} must be limited-range BT.709.`);
  invariant(audio?.codec_name === "aac" && Number(audio.sample_rate) === 48000 && audio.channels === 2, `${basename(path)} must contain 48 kHz stereo AAC.`);
  const atoms = readTopLevelMp4Atoms(path);
  const moov = atoms.findIndex((atom) => atom.type === "moov");
  const mdat = atoms.findIndex((atom) => atom.type === "mdat");
  invariant(moov >= 0 && mdat >= 0 && moov < mdat, `${basename(path)} must use fast-start atom ordering.`);

  const raw = run("ffmpeg", ["-v", "error", "-i", path, "-vf", "fps=5,scale=160:90:flags=area,format=gray", "-an", "-f", "rawvideo", "-pix_fmt", "gray", "-"], `${basename(path)} luma analysis`, {encoding: null}).stdout;
  const luma = analyzeSampleBuffer(raw, 160 * 90, 5);
  invariant(luma.blackSampleCount === 0 && luma.maxBlackRunSeconds <= 0.4, `${basename(path)} contains a black run.`);
  invariant(luma.maxFrozenRunSeconds <= 2.2, `${basename(path)} contains a frozen run longer than 2.2 seconds.`);
  const loudnessRun = run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "loudnorm=I=-16:TP=-1:LRA=7:print_format=json", "-f", "null", "-"], `${basename(path)} loudness`);
  const loudness = parseLoudness(loudnessRun.stderr, basename(path));
  invariant(loudness.integratedLufs >= -16.5 && loudness.integratedLufs <= -15.5, `${basename(path)} must be normalized to -16±0.5 LUFS.`);
  invariant(loudness.truePeakDbfs <= -1, `${basename(path)} true peak must not exceed -1 dBTP.`);
  return {
    width: video.width,
    height: video.height,
    decodedFrames: Number(video.nb_read_frames ?? video.nb_frames),
    durationSeconds: Number(probe.format.duration),
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    color: {range: video.color_range, space: video.color_space, transfer: video.color_transfer, primaries: video.color_primaries},
    fastStart: true,
    audio: loudness,
    luma,
  };
}

function readJsonFromCommand(command, args, label) {
  const result = run(command, args, label);
  return JSON.parse(result.stdout);
}

function assertFresh(path, dependencies, label) {
  const artifactMs = statSync(path).mtimeMs;
  const newest = Math.max(...dependencies.map((dependency) => statSync(dependency).mtimeMs));
  invariant(artifactMs >= newest, `${label} is stale relative to its source dependencies.`);
  return {artifactModifiedAt: new Date(artifactMs).toISOString(), newestDependencyModifiedAt: new Date(newest).toISOString()};
}

function verifyDelivery(root, variant, delivery, dependencyFiles) {
  const videoPath = resolved(root, delivery.video);
  const posterPath = resolved(root, delivery.poster);
  invariant(existsSync(videoPath), `${variant} RealityOps V2 video is missing.`);
  invariant(existsSync(posterPath), `${variant} RealityOps V2 poster is missing.`);
  const freshness = {
    video: assertFresh(videoPath, [...dependencyFiles, resolved(root, AUDIO_PATH)], `${variant} RealityOps V2 video`),
    poster: assertFresh(posterPath, dependencyFiles, `${variant} RealityOps V2 poster`),
  };
  const media = probeMedia(videoPath, delivery);
  const posterDimensions = imageDimensions(posterPath);
  invariant(posterDimensions.width === delivery.width && posterDimensions.height === delivery.height, `${variant} poster dimensions are invalid.`);
  invariant(statSync(posterPath).size >= 80_000, `${variant} poster is unexpectedly small.`);
  return {
    ...media,
    poster: {...posterDimensions, ...posterAnalysis(posterPath)},
    freshness,
    hashes: {video: sha256File(videoPath), poster: sha256File(posterPath)},
  };
}

function verifyCaptions(root, contract) {
  const results = {};
  for (const [variant, delivery] of Object.entries(contract.delivery)) {
    for (const [language, path] of Object.entries(delivery.captions)) {
      const id = `${variant}-${language}`;
      results[id] = {
        ...validateTimedTranscript(readFileSync(resolved(root, path), "utf8"), {
          id,
          language,
          durationSeconds: delivery.durationFrames / delivery.fps,
        }),
        sha256: sha256File(resolved(root, path)),
      };
    }
  }
  return results;
}

function verifyRegistration(root, contract) {
  const rootSource = readFileSync(resolved(root, "video/src/Root.tsx"), "utf8");
  const packageJson = readJson(resolved(root, "package.json"));
  for (const delivery of Object.values(contract.delivery)) {
    invariant(rootSource.includes(`id="${delivery.composition}"`), `${delivery.composition} is not registered.`);
    invariant(rootSource.includes(`id="${delivery.posterComposition}"`), `${delivery.posterComposition} is not registered.`);
  }
  for (const script of [
    "demo:test:realityops:v2-verifier",
    "demo:render:realityops:v2",
    "demo:render:realityops:v2:posters",
    "demo:verify:realityops:v2",
    "demo:release:realityops:v2",
  ]) {
    invariant(typeof packageJson.scripts?.[script] === "string", `package.json is missing ${script}.`);
  }
}

export function verifyRealityOpsV2(root = process.cwd()) {
  const contract = readJson(resolved(root, CONTRACT_PATH));
  const compositionPath = resolved(root, contract.source.composition);
  const captureScriptPath = resolved(root, contract.source.captureScript);
  const evidencePath = resolved(root, contract.source.evidence);
  const compositionSource = readFileSync(compositionPath, "utf8");
  const contractSummary = validateVisualContract(contract, {sourceText: compositionSource});
  invariant(sha256File(compositionPath) === contract.source.compositionSourceSha256, "RealityOps composition source hash changed.");
  invariant(sha256File(captureScriptPath) === contract.source.captureScriptSha256, "RealityOps capture script hash changed.");
  invariant(sha256File(evidencePath) === contract.source.evidenceSha256, "RealityOps evidence hash changed.");

  verifyRegistration(root, contract);
  const assetManifest = verifyCaptureAssets(root, contract);
  const evidence = readJson(evidencePath);
  const evidenceSummary = validateEvidence(
    evidence,
    readFileSync(resolved(root, PROJECT_PATH), "utf8"),
    {
      usda: readFileSync(resolved(root, join(EXPORT_ROOT, evidence.exports.usda.filename))),
      step: readFileSync(resolved(root, join(EXPORT_ROOT, evidence.exports.step.filename))),
    },
  );
  const captions = verifyCaptions(root, contract);
  const dependencies = [compositionPath, ...assetManifest.files.map((path) => resolved(root, path))];
  const media = Object.fromEntries(Object.entries(contract.delivery).map(([variant, delivery]) => [
    variant,
    verifyDelivery(root, variant, delivery, dependencies),
  ]));

  const receipt = {
    format: "semaframe-realityops-v2-verification",
    version: 1,
    result: "passed",
    verifiedAt: new Date().toISOString(),
    silentFirst: {declared: true, audioRequiredForComprehension: false, ...contractSummary},
    evidence: evidenceSummary,
    sources: {
      composition: contract.source.compositionSourceSha256,
      captureScript: contract.source.captureScriptSha256,
      evidence: contract.source.evidenceSha256,
      captureAssetManifest: assetManifest.hash,
      captureAssetCount: assetManifest.fileCount,
    },
    captions,
    media,
    claimBoundary: contract.claimBoundary,
  };
  const receiptPath = resolved(root, RECEIPT_PATH);
  const temporary = `${receiptPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temporary, receiptPath);
  return receipt;
}

export function main() {
  const receipt = verifyRealityOpsV2();
  console.log("RealityOps V2 silent-first verification passed.");
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`RealityOps V2 verification FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
