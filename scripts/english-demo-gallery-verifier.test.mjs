import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import test from "node:test";
import {
  assertArtifactFreshness,
  assertTruthfulEnglishCopy,
  validateEnglishSrt,
  validateGalleryContract,
  validateLumaAnalysis,
  validateMediaProbe,
  validatePosterProbe,
  validateReadmePosterProbe,
  validateRootRegistrations,
  verifyEnglishDemoGallery,
  verifyStaticBindings,
} from "./verify-english-demo-gallery.mjs";

const root = resolve(import.meta.dirname, "..");
const contractPath = resolve(root, "video/english-demo-gallery.visual-contract.json");
const contractText = readFileSync(contractPath, "utf8");
const fixtureContract = JSON.parse(contractText);
const clone = (value) => structuredClone(value);

function delivery(id = "pump-landscape") {
  return clone(fixtureContract.deliveries.find((entry) => entry.id === id));
}

function validProbe(spec) {
  return {
    format: {
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: String(spec.durationFrames / spec.fps),
    },
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: spec.width,
        height: spec.height,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
        nb_read_frames: String(spec.durationFrames),
        color_range: "tv",
        color_space: "bt709",
        color_transfer: "bt709",
        color_primaries: "bt709",
      },
      {
        index: 1,
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
        channel_layout: "stereo",
      },
    ],
  };
}

const fastStartAtoms = [
  {type: "ftyp", offset: 0, size: 32},
  {type: "moov", offset: 32, size: 100},
  {type: "mdat", offset: 132, size: 1_000},
];

test("accepts the complete five-delivery English gallery contract", () => {
  assert.deepEqual(validateGalleryContract(clone(fixtureContract), {contractText}), {
    deliveryCount: 5,
    compositionCount: 5,
    posterCount: 5,
    readmePosterCount: 3,
    locale: "en-US",
  });
});

test("static-only verification binds current sources, contracts, captions, and Root registrations", () => {
  const report = verifyEnglishDemoGallery(root, {staticOnly: true});
  assert.equal(report.result, "passed");
  assert.equal(report.mode, "static-only");
  assert.equal(Object.keys(report.staticBindings.sourceHashes).length, 4);
  assert.equal(Object.keys(report.staticBindings.captions).length, 5);
  assert.deepEqual(report.staticBindings.registrations, {compositions: 5, posters: 5, fps: 30});
  assert.deepEqual(report.staticBindings.readmeGallery, {path: "README.md", posterCount: 3, releaseTag: "demo-gallery-v1"});
  assert.equal(report.media.status, "skipped");
});

test("rejects delivery dimensions, duration, IDs, and output-name drift", () => {
  for (const [field, value] of [
    ["width", 1919],
    ["durationFrames", 1079],
    ["compositionId", "WrongComposition"],
    ["videoPath", "artifacts/wrong.mp4"],
  ]) {
    const contract = clone(fixtureContract);
    contract.deliveries[0][field] = value;
    assert.throws(() => validateGalleryContract(contract), /frozen English gallery specification/u);
  }
});

test("rejects non-English, non-silent-first, or weakened claim-boundary contracts", () => {
  const wrongLocale = clone(fixtureContract);
  wrongLocale.locale = "zh-CN";
  assert.throws(() => validateGalleryContract(wrongLocale), /locale must be en-US/u);

  const audibleOnly = clone(fixtureContract);
  audibleOnly.silentFirst = false;
  assert.throws(() => validateGalleryContract(audibleOnly), /silent-first/u);

  const weakenedBoundary = clone(fixtureContract);
  weakenedBoundary.claimBoundaries.pump.physicsScope = "certified_safe";
  assert.throws(() => validateGalleryContract(weakenedBoundary), /claim boundaries/u);
});

test("rejects a source or supporting-contract hash that no longer matches disk", () => {
  const staleSource = clone(fixtureContract);
  staleSource.sources.realityOps.sha256 = `sha256:${"0".repeat(64)}`;
  assert.throws(() => verifyStaticBindings(staleSource, root), /RealityOpsProofV2\.tsx is stale/u);

  const staleContract = clone(fixtureContract);
  staleContract.supportingContracts[0].sha256 = `sha256:${"1".repeat(64)}`;
  assert.throws(() => verifyStaticBindings(staleContract, root), /living-room-public-demo-en.*stale/u);
});

test("validates all five English caption tracks and their complete timing", () => {
  for (const spec of fixtureContract.deliveries) {
    const result = validateEnglishSrt(readFileSync(resolve(root, spec.captionPath), "utf8"), spec);
    assert.equal(result.cueCount, spec.captionCueCount);
    assert.equal(result.durationSeconds, spec.durationFrames / spec.fps);
    assert.ok(result.maximumCps <= spec.maxCaptionCps);
    assert.ok(result.maximumGapSeconds <= spec.maxCaptionGapSeconds + 0.002);
  }
});

test("rejects CJK residue, caption overlap, excessive gaps, and incomplete timing", () => {
  const spec = delivery();
  const original = readFileSync(resolve(root, spec.captionPath), "utf8");
  assert.throws(() => validateEnglishSrt(original.replace("Add a backup pump.", "添加备用泵。"), spec), /contains CJK/u);
  assert.throws(() => validateEnglishSrt(original.replace("00:00:02,000 --> 00:00:04,500", "00:00:01,900 --> 00:00:04,500"), spec), /overlap/u);
  assert.throws(() => validateEnglishSrt(original.replace("00:00:02,000 --> 00:00:04,500", "00:00:02,500 --> 00:00:04,500"), spec), /excessive/u);
  assert.throws(() => validateEnglishSrt(original.replace("00:00:36,000", "00:00:35,900"), spec), /must end/u);
});

test("truthfulness guard rejects live-feed, certification, continuous-path, and autonomous-design overclaims", () => {
  assert.doesNotThrow(() => assertTruthfulEnglishCopy("AI can operate a live 3D world from a deterministic snapshot."));
  assert.throws(() => assertTruthfulEnglishCopy("The Agent reads live plant data."), /unsupported claim/u);
  assert.throws(() => assertTruthfulEnglishCopy("The model is engineering certified."), /unsupported claim/u);
  assert.throws(() => assertTruthfulEnglishCopy("The route has continuous collision checking."), /unsupported claim/u);
  assert.throws(() => assertTruthfulEnglishCopy("The AI autonomously engineered the pump."), /unsupported claim/u);
});

test("Root validation rejects a missing composition, wrong dimensions, or missing component export", () => {
  const rootSource = readFileSync(resolve(root, fixtureContract.rootRegistrationPath), "utf8");
  const sourceTexts = Object.fromEntries(Object.entries(fixtureContract.sources).map(([id, source]) => [
    id,
    readFileSync(resolve(root, source.path), "utf8"),
  ]));
  assert.doesNotThrow(() => validateRootRegistrations(fixtureContract, rootSource, sourceTexts));
  assert.throws(
    () => validateRootRegistrations(fixtureContract, rootSource.replace('id="SemaFrameRealityOpsProofV2English"', 'id="BrokenPump"'), sourceTexts),
    /registered exactly once/u,
  );
  const badWidth = rootSource.replace(
    /id="SemaFrameRealityOpsProofV2English"([\s\S]*?)width=\{1920\}/u,
    'id="SemaFrameRealityOpsProofV2English"$1width={1919}',
  );
  assert.throws(() => validateRootRegistrations(fixtureContract, badWidth, sourceTexts), /width=\{1920\}/u);
  assert.throws(
    () => validateRootRegistrations(fixtureContract, rootSource, {...sourceTexts, realityOps: sourceTexts.realityOps.replace("export const SemaFrameRealityOpsProofV2English", "const SemaFrameRealityOpsProofV2English")}),
    /is not exported/u,
  );
});

test("accepts exact H.264, CFR 30, BT.709, AAC stereo, and fast-start media metadata", () => {
  const spec = delivery("traffic-vertical");
  const report = validateMediaProbe(validProbe(spec), spec, fastStartAtoms);
  assert.equal(report.codec, "h264");
  assert.equal(report.decodedFrames, 840);
  assert.equal(report.fastStart, true);
  assert.deepEqual(report.audio, {codec: "aac", sampleRate: 48_000, channels: 2});
});

test("rejects wrong frame count, color tags, audio layout, or non-fast-start MP4", () => {
  const spec = delivery();
  const wrongFrames = validProbe(spec);
  wrongFrames.streams[0].nb_read_frames = "1079";
  assert.throws(() => validateMediaProbe(wrongFrames, spec, fastStartAtoms), /exactly 1080 frames/u);

  const wrongColor = validProbe(spec);
  wrongColor.streams[0].color_space = "bt470bg";
  assert.throws(() => validateMediaProbe(wrongColor, spec, fastStartAtoms), /BT\.709/u);

  const mono = validProbe(spec);
  mono.streams[1].channels = 1;
  assert.throws(() => validateMediaProbe(mono, spec, fastStartAtoms), /stereo/u);

  const slowStart = [
    {type: "ftyp", offset: 0, size: 32},
    {type: "mdat", offset: 32, size: 1_000},
    {type: "moov", offset: 1_032, size: 100},
  ];
  assert.throws(() => validateMediaProbe(validProbe(spec), spec, slowStart), /fast-start/u);
});

test("video luma validation catches long black and frozen spans", () => {
  const spec = delivery();
  const good = {
    sampleCount: 180,
    maxBlackRunSeconds: 0,
    maxFrozenRunSeconds: 0.8,
    meanLuma: {minimum: 20, maximum: 180, average: 80},
  };
  assert.equal(validateLumaAnalysis(good, spec), good);
  assert.throws(() => validateLumaAnalysis({...good, maxBlackRunSeconds: 1}, spec), /black span/u);
  assert.throws(() => validateLumaAnalysis({...good, maxFrozenRunSeconds: 3.2}, spec), /frozen span/u);
});

test("poster validation enforces PNG identity, exact size, and non-flat pixels", () => {
  const spec = delivery("furniture-landscape");
  const probe = {streams: [{codec_type: "video", codec_name: "png", width: 1920, height: 1080}]};
  const luma = {sampleCount: 1, meanLuma: {average: 72}, minimumFrameStandardDeviation: 19};
  assert.equal(validatePosterProbe(probe, spec, luma).standardDeviation, 19);
  assert.throws(() => validatePosterProbe({streams: [{...probe.streams[0], width: 1919}]}, spec, luma), /dimensions/u);
  assert.throws(() => validatePosterProbe(probe, spec, {...luma, minimumFrameStandardDeviation: 2}), /blank or visually flat/u);
});

test("README poster validation enforces JPEG identity, 1280x720 size, and non-flat pixels", () => {
  const spec = delivery("furniture-landscape");
  const probe = {streams: [{codec_type: "video", codec_name: "mjpeg", width: 1280, height: 720}]};
  const luma = {sampleCount: 1, meanLuma: {average: 72}, minimumFrameStandardDeviation: 19};
  assert.equal(validateReadmePosterProbe(probe, spec, luma).standardDeviation, 19);
  assert.throws(() => validateReadmePosterProbe({streams: [{...probe.streams[0], height: 719}]}, spec, luma), /1280x720/u);
  assert.throws(() => validateReadmePosterProbe(probe, spec, {...luma, minimumFrameStandardDeviation: 2}), /blank or visually flat/u);
});

test("artifact freshness rejects a video or poster older than any render dependency", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "semaframe-english-gallery-"));
  try {
    writeFileSync(resolve(temporaryRoot, "artifact.mp4"), "artifact");
    writeFileSync(resolve(temporaryRoot, "source.tsx"), "source");
    const old = new Date("2026-01-01T00:00:00.000Z");
    const fresh = new Date("2026-01-02T00:00:00.000Z");
    utimesSync(resolve(temporaryRoot, "artifact.mp4"), old, old);
    utimesSync(resolve(temporaryRoot, "source.tsx"), fresh, fresh);
    assert.throws(() => assertArtifactFreshness({artifactPath: "artifact.mp4", dependencyPaths: ["source.tsx"], root: temporaryRoot}), /predates source\.tsx/u);
    utimesSync(resolve(temporaryRoot, "artifact.mp4"), fresh, fresh);
    assert.doesNotThrow(() => assertArtifactFreshness({artifactPath: "artifact.mp4", dependencyPaths: ["source.tsx"], root: temporaryRoot}));
  } finally {
    rmSync(temporaryRoot, {recursive: true, force: true});
  }
});
