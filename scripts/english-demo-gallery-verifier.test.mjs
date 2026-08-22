import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import test from "node:test";
import {
  assertArtifactFreshness,
  assertNoUnpublishedReleaseReference,
  assertTruthfulEnglishCopy,
  main,
  validateEnglishSrt,
  validateGalleryContract,
  validateLumaAnalysis,
  validateMediaProbe,
  validatePosterProbe,
  validateReadmePosterProbe,
  validateRootRegistrations,
  verifyEnglishDemoGallery,
  verifyStaticBindings,
  writeEnglishGalleryVerificationReceiptAtomic,
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

test("accepts the complete seven-delivery English gallery contract", () => {
  assert.deepEqual(validateGalleryContract(clone(fixtureContract), {contractText}), {
    deliveryCount: 7,
    compositionCount: 7,
    posterCount: 7,
    readmePosterCount: 3,
    locale: "en-US",
  });
});

test("freezes three published README films and keeps Reality Twin local", () => {
  const readmeDeliveries = fixtureContract.deliveries.filter((entry) => entry.readmePosterPath);
  assert.deepEqual(readmeDeliveries.map((entry) => entry.readmeLink.kind), [
    "published-release-asset",
    "published-release-asset",
    "published-release-asset",
  ]);
  const realityTwin = delivery("reality-twin-landscape");
  assert.equal(realityTwin.readmeLink, undefined);
  assert.equal(realityTwin.readmePosterPath, undefined);

  const fabricatedRelease = clone(fixtureContract);
  const fabricated = fabricatedRelease.deliveries.find((entry) => entry.id === "reality-twin-landscape");
  fabricated.readmeLink = {
    kind: "published-release-asset",
    href: "https://github.com/riseagain1/semaframe/releases/download/demo-gallery-v1/semaframe-reality-twin-v1-en.mp4",
  };
  assert.throws(() => validateGalleryContract(fabricatedRelease), /must not declare a README link/u);

  assert.throws(() => assertNoUnpublishedReleaseReference(
    '<a href="https://github.com/riseagain1/semaframe/releases/download/not-published/semaframe-reality-twin-v1-en.mp4">Fake film</a>',
    realityTwin,
  ), /fabricates an unpublished release asset/u);
});

test("static-only verification binds current sources, contracts, captions, and Root registrations", () => {
  const report = verifyEnglishDemoGallery(root, {staticOnly: true});
  assert.equal(report.result, "passed");
  assert.equal(report.mode, "static-only");
  assert.equal(Object.keys(report.staticBindings.sourceHashes).length, 5);
  assert.equal(Object.keys(report.staticBindings.captions).length, 7);
  assert.deepEqual(report.staticBindings.registrations, {compositions: 7, posters: 7, fps: 30});
  assert.deepEqual(report.staticBindings.readmeGallery, {
    path: "README.md",
    posterCount: 3,
    publishedVideoCount: 3,
    localPreviewCount: 0,
    releaseTags: ["demo-gallery-v1"],
  });
  assert.equal(report.media.status, "skipped");
});

test("CLI invalidates a stale passed receipt before argument or dependency failure", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "semaframe-gallery-receipt-"));
  const receiptPath = resolve(temporaryRoot, "artifacts/semaframe-english-demo-gallery-verification.json");
  try {
    mkdirSync(resolve(temporaryRoot, "artifacts"), {recursive: true});
    writeFileSync(receiptPath, '{"result":"passed","stale":true}\n');
    assert.throws(() => main(["--invalid"], temporaryRoot), /Unknown argument/u);
    assert.equal(existsSync(receiptPath), false);

    writeFileSync(receiptPath, '{"result":"passed","stale":true}\n');
    assert.throws(() => main(["--static-only"], temporaryRoot), /Missing English gallery contract/u);
    assert.equal(existsSync(receiptPath), false);
  } finally {
    rmSync(temporaryRoot, {recursive: true, force: true});
  }
});

test("verification receipt uses an atomic rename and cleans a failed temporary write", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "semaframe-gallery-atomic-"));
  const receiptDirectory = resolve(temporaryRoot, "artifacts");
  const receiptPath = resolve(receiptDirectory, "semaframe-english-demo-gallery-verification.json");
  const report = {verificationVersion: 2, result: "passed"};
  try {
    assert.throws(() => writeEnglishGalleryVerificationReceiptAtomic(
      temporaryRoot,
      report,
      {rename: () => { throw new Error("synthetic rename failure"); }},
    ), /synthetic rename failure/u);
    assert.equal(existsSync(receiptPath), false);
    assert.deepEqual(readdirSync(receiptDirectory), []);

    assert.equal(writeEnglishGalleryVerificationReceiptAtomic(temporaryRoot, report), receiptPath);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), report);
    assert.deepEqual(readdirSync(receiptDirectory), ["semaframe-english-demo-gallery-verification.json"]);
  } finally {
    rmSync(temporaryRoot, {recursive: true, force: true});
  }
});

test("release pipeline rebuilds Reality once from a clean clone and gates QA stills plus OCR", () => {
  const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
  const realityRelease = scripts["demo:release:reality-twin:v1"];
  const publishedRender = scripts["demo:render:english-gallery:published"];
  const completeRender = scripts["demo:render:english-gallery"];
  const galleryRelease = scripts["demo:release:english-gallery"];

  for (const command of [
    "demo:test:audio",
    "demo:test:reality-twin:metadata",
    "demo:test:reality-twin:limits",
    "demo:test:reality-twin-capture",
    "demo:test:reality-twin:asset-verifier",
    "demo:test:reality-twin:v1-verifier",
    "demo:prepare:reality-twin",
    "demo:verify:reality-twin:asset",
    "demo:capture:reality-twin",
    "demo:render:reality-twin:v1",
    "demo:render:reality-twin:v1:posters",
    "demo:verify:reality-twin:v1",
  ]) assert.ok(realityRelease.includes(`npm run ${command}`), `Reality release omits ${command}`);
  assert.equal(scripts["demo:test:audio"], "node --test scripts/generate-demo-audio.test.mjs");
  assert.equal(
    scripts["demo:test:reality-twin:metadata"],
    "node --test scripts/reality-twin-metadata-text.test.mjs",
  );
  assert.equal(
    scripts["demo:test:reality-twin:limits"],
    "node --test scripts/reality-twin-import-limits.test.mjs",
  );
  assert.equal(
    scripts["demo:test:reality-twin:asset-verifier"],
    "node --test scripts/reality-twin-asset-verifier.test.mjs",
  );
  assert.ok(realityRelease.indexOf("demo:prepare:reality-twin") < realityRelease.indexOf("demo:capture:reality-twin"));
  assert.ok(realityRelease.indexOf("demo:capture:reality-twin") < realityRelease.indexOf("demo:render:reality-twin:v1"));

  assert.ok(!publishedRender.includes("reality-twin"));
  assert.equal(completeRender.match(/demo:render:reality-twin:v1(?!:posters)/gu)?.length, 1);
  assert.equal(completeRender.match(/demo:render:reality-twin:v1:posters/gu)?.length, 1);
  assert.equal(galleryRelease.match(/demo:release:reality-twin:v1/gu)?.length, 1);
  assert.ok(!galleryRelease.includes("demo:render:reality-twin:v1"));
  assert.ok(!galleryRelease.includes("demo:render:english-gallery &&"));
  assert.ok(galleryRelease.indexOf("demo:release:reality-twin:v1") < galleryRelease.indexOf("demo:render:english-gallery:published"));
  assert.ok(galleryRelease.indexOf("demo:render:english-gallery:published") < galleryRelease.indexOf("demo:render:readme-posters"));
  assert.ok(galleryRelease.indexOf("demo:render:readme-posters") < galleryRelease.indexOf("demo:qa:english-gallery"));
  assert.ok(galleryRelease.indexOf("demo:qa:english-gallery") < galleryRelease.indexOf("demo:verify:english-gallery"));
  assert.equal(
    scripts["demo:qa:english-gallery"],
    "node scripts/render-english-demo-qa-stills.mjs artifacts/qa-english && swift scripts/verify-english-demo-cjk-ocr.swift artifacts/qa-english",
  );
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

test("validates all seven English caption tracks and their complete timing", () => {
  for (const spec of fixtureContract.deliveries) {
    const result = validateEnglishSrt(readFileSync(resolve(root, spec.captionPath), "utf8"), spec);
    assert.equal(result.cueCount, spec.captionCueCount);
    assert.equal(result.durationSeconds, spec.durationFrames / spec.fps);
    assert.ok(result.maximumCps <= spec.maxCaptionCps);
    assert.ok(result.maximumGapSeconds <= spec.maxCaptionGapSeconds + 0.002);
  }
});

test("keeps the Reality Twin transcript ceiling local to its two deliveries", () => {
  for (const id of ["reality-twin-landscape", "reality-twin-vertical"]) {
    const spec = delivery(id);
    const contents = readFileSync(resolve(root, spec.captionPath), "utf8");
    const result = validateEnglishSrt(contents, spec);
    assert.ok(result.longestLine > 42);
    assert.ok(result.longestLine <= 52);
    assert.throws(
      () => validateEnglishSrt(contents, {...spec, maxCaptionLineCharacters: 42}),
      /longer than 42 characters/u,
    );
  }
  assert.equal(delivery("pump-landscape").maxCaptionLineCharacters, 42);
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
  assert.throws(() => assertTruthfulEnglishCopy("SemaFrame reconstructed the museum scan."), /unsupported claim/u);
  assert.throws(() => assertTruthfulEnglishCopy("This is a native Gaussian capture."), /unsupported claim/u);
  assert.throws(() => assertTruthfulEnglishCopy("The scan is survey-grade."), /unsupported claim/u);
  assert.throws(() => assertTruthfulEnglishCopy("The Gaussian representation owns collision."), /unsupported claim/u);
  assert.throws(() => assertTruthfulEnglishCopy("The Agent reads raw splats."), /unsupported claim/u);
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
    /composition IDs|registered exactly once/u,
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

test("Root validation rejects an uncontracted composition inside English-Demos", () => {
  const rootSource = readFileSync(resolve(root, fixtureContract.rootRegistrationPath), "utf8");
  const sourceTexts = Object.fromEntries(Object.entries(fixtureContract.sources).map(([id, source]) => [
    id,
    readFileSync(resolve(root, source.path), "utf8"),
  ]));
  const marker = `<Folder name="${fixtureContract.rootFolderName}">`;
  const folderStart = rootSource.indexOf(marker);
  const folderEnd = rootSource.indexOf("</Folder>", folderStart);
  const extra = `\n      <Composition id="UncontractedEnglishDemo" component={SemaFrameRealityTwinProofV1} width={1920} height={1080} fps={FPS} durationInFrames={REALITY_TWIN_PROOF_V1_LANDSCAPE_DURATION} />\n    `;
  const withExtra = `${rootSource.slice(0, folderEnd)}${extra}${rootSource.slice(folderEnd)}`;
  assert.throws(
    () => validateRootRegistrations(fixtureContract, withExtra, sourceTexts),
    /English-Demos composition IDs differs/u,
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

test("accepts the 900-frame Reality Twin vertical delivery metadata", () => {
  const spec = delivery("reality-twin-vertical");
  const report = validateMediaProbe(validProbe(spec), spec, fastStartAtoms);
  assert.equal(report.decodedFrames, 900);
  assert.equal(report.width, 1080);
  assert.equal(report.height, 1920);
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
  const spec = delivery("reality-twin-landscape");
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
