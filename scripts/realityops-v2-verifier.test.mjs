import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {
  assertTruthfulVisibleCopy,
  computeCaptureAssetManifest,
  imageDimensions,
  validateEvidence,
  validateTimedTranscript,
  validateVisualContract,
} from "./verify-realityops-v2.mjs";

const root = resolve(import.meta.dirname, "..");
const loadJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const loadContract = () => {
  const contract = loadJson("video/realityops-v2.visual-contract.json");
  contract.source.compositionSourceSha256 = `sha256:${"a".repeat(64)}`;
  return contract;
};
const clone = (value) => structuredClone(value);

test("accepts the complete dual-format RealityOps V2 visual contract", () => {
  const summary = validateVisualContract(loadContract(), {
    sourceText: readFileSync(resolve(root, "video/src/RealityOpsProofV2.tsx"), "utf8"),
  });
  assert.deepEqual(summary, {requiredBeatCount: 12, landscapeFrames: 1080, verticalFrames: 960});
});

test("rejects a non-silent-first contract", () => {
  const contract = loadContract();
  contract.silentFirst = false;
  assert.throws(() => validateVisualContract(contract), /silentFirst/u);
});

test("rejects duplicate comprehension beats", () => {
  const contract = loadContract();
  contract.requiredBeats[11] = contract.requiredBeats[10];
  assert.throws(() => validateVisualContract(contract), /unique/u);
});

test("rejects non-contiguous beat timing", () => {
  const contract = loadContract();
  contract.delivery.landscape.beats[4].from += 1;
  assert.throws(() => validateVisualContract(contract), /must begin/u);
});

test("rejects a timeline that does not cover the composition", () => {
  const contract = loadContract();
  contract.delivery.vertical.beats.at(-1).duration -= 1;
  assert.throws(() => validateVisualContract(contract), /complete composition/u);
});

test("rejects a late product definition", () => {
  const contract = loadContract();
  contract.delivery.landscape.productComprehensionDeadlineFrame = 120;
  assert.throws(() => validateVisualContract(contract), /declared deadline/u);
});

test("rejects text outside the portrait safe area", () => {
  const contract = loadContract();
  contract.delivery.vertical.boundaryNoteBounds.y = 1730;
  assert.throws(() => validateVisualContract(contract), /safe area/u);
});

test("rejects overlapping title and proof regions", () => {
  const contract = loadContract();
  contract.delivery.landscape.proofBounds.y = 200;
  assert.throws(() => validateVisualContract(contract), /overlap/u);
});

test("rejects unsupported live-telemetry claims", () => {
  assert.throws(() => assertTruthfulVisibleCopy("Connect live plant telemetry"), /unsupported claim/u);
});

test("rejects unsupported autonomous-design claims", () => {
  assert.throws(() => assertTruthfulVisibleCopy("The AI autonomously designed the retrofit"), /unsupported claim/u);
});

test("accepts the four complete timed transcripts", () => {
  const contract = loadContract();
  for (const [variant, delivery] of Object.entries(contract.delivery)) {
    for (const [language, path] of Object.entries(delivery.captions)) {
      const result = validateTimedTranscript(readFileSync(resolve(root, path), "utf8"), {
        id: `${variant}-${language}`,
        language,
        durationSeconds: delivery.durationFrames / delivery.fps,
      });
      assert.equal(result.cueCount, 12);
    }
  }
});

test("rejects a timed-transcript gap", () => {
  const path = resolve(root, "video/captions/semaframe-realityops-v2.zh-CN.srt");
  const contents = readFileSync(path, "utf8").replace("00:00:02,000 --> 00:00:04,500", "00:00:02,100 --> 00:00:04,500");
  assert.throws(() => validateTimedTranscript(contents, {id: "gap", language: "zh-CN", durationSeconds: 36}), /gap or overlap/u);
});

test("rejects an unreadably dense timed transcript", () => {
  const path = resolve(root, "video/captions/semaframe-realityops-v2.en-US.srt");
  const contents = readFileSync(path, "utf8").replace("Add a backup pump.", "A".repeat(80));
  assert.throws(() => validateTimedTranscript(contents, {id: "dense", language: "en-US", durationSeconds: 36}), /characters per second|line longer/u);
});

test("accepts the captured collision, model, action, persistence, and export evidence", () => {
  const evidence = loadJson("video/public/realityops/evidence.json");
  const summary = validateEvidence(
    evidence,
    readFileSync(resolve(root, "artifacts/realityops/realityops-pump-room.semaframe.json"), "utf8"),
    {
      usda: readFileSync(resolve(root, `artifacts/realityops/${evidence.exports.usda.filename}`)),
      step: readFileSync(resolve(root, `artifacts/realityops/${evidence.exports.step.filename}`)),
    },
  );
  assert.equal(summary.rejectedRevision, 10);
  assert.equal(summary.correctedRevision, 15);
  assert.equal(summary.modelNodeCount, 8);
  assert.equal(summary.savedComponentCount, 37);
});

test("rejects a collision attempt that changed the revision", () => {
  const evidence = loadJson("video/public/realityops/evidence.json");
  evidence.collisionPreflight.revisionAfterRejection = 11;
  assert.throws(() => validateEvidence(evidence, "{}", {usda: Buffer.alloc(0), step: Buffer.alloc(0)}), /revision 10 atomically/u);
});

test("rejects telemetry mislabeled as a live connector", () => {
  const evidence = loadJson("video/public/realityops/evidence.json");
  evidence.dataAndAction.resourceMode = "live";
  assert.throws(() => validateEvidence(evidence, "{}", {usda: Buffer.alloc(0), step: Buffer.alloc(0)}), /snapshot resource/u);
});

test("rejects a saved-project hash mismatch", () => {
  const evidence = loadJson("video/public/realityops/evidence.json");
  const badProject = readFileSync(resolve(root, "artifacts/realityops/realityops-pump-room.semaframe.json"), "utf8")
    .replace(/\}\s*$/u, ',"tampered":true}');
  assert.throws(() => validateEvidence(evidence, badProject, {usda: Buffer.alloc(0), step: Buffer.alloc(0)}), /project hash/u);
});

test("binds all 340 current capture assets into one deterministic manifest", () => {
  const contract = loadContract();
  const manifest = computeCaptureAssetManifest(root, contract);
  assert.equal(manifest.fileCount, 340);
  assert.equal(manifest.hash, contract.source.captureAssetManifestSha256);
});

test("detects an incomplete capture manifest", () => {
  const contract = loadContract();
  contract.source.frameCountPerFolder = 47;
  const manifest = computeCaptureAssetManifest(root, contract);
  assert.equal(manifest.fileCount, 333);
  assert.notEqual(manifest.hash, contract.source.captureAssetManifestSha256);
});

test("reads source JPEG and generated PNG dimensions without browser heuristics", () => {
  assert.deepEqual(imageDimensions(resolve(root, "video/public/realityops/immersive-final-frames/frame-0000.jpg")), {width: 1600, height: 900});
  assert.deepEqual(imageDimensions(resolve(root, "artifacts/semaframe-realityops-poster.png")), {width: 1920, height: 1080});
});

test("rejects composition source without the truth-boundary copy", () => {
  const contract = loadContract();
  const source = readFileSync(resolve(root, "video/src/RealityOpsProofV2.tsx"), "utf8").replace("遥测为确定性快照", "遥测");
  assert.throws(() => validateVisualContract(clone(contract), {sourceText: source}), /确定性快照/u);
});
