import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  analyzeSampleBuffer,
} from "./verify-emergency-city-v3.mjs";
import {
  assertArtifactFreshness,
  assertTruthfulClaims,
  validateSemanticOverlaySource,
  validateTimedTranscript,
  validateVisualContract,
} from "./verify-emergency-city-v4.mjs";

const fixtureContract = JSON.parse(readFileSync(
  new URL("../video/emergency-city-v4.visual-contract.json", import.meta.url),
  "utf8",
));
const semanticOverlaySource = readFileSync(
  new URL("../video/src/EmergencyCitySemanticLens.tsx", import.meta.url),
  "utf8",
);

function makeContract() {
  return structuredClone(fixtureContract);
}

function srtTimestamp(frame) {
  const totalMilliseconds = Math.round(frame * 1000 / 30);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function makeSrt(cues, language) {
  return `${cues.map((cue, index) => [
    String(index + 1),
    `${srtTimestamp(cue.startFrame)} --> ${srtTimestamp(cue.endFrame)}`,
    ...cue.text[language],
  ].join("\n")).join("\n\n")}\n`;
}

function validate(contract = makeContract()) {
  return validateVisualContract(contract, {
    compositionSourceHash: contract.compositionSourceSha256,
    semanticOverlaySourceHash: contract.semanticOverlaySourceSha256,
    rejectedRevisionBefore: 8,
    rejectedRevisionAfter: 8,
  });
}

test("accepts the complete V4 silent-first visual contract", () => {
  const report = validate();
  assert.equal(report.landscape.comprehensionBeatCount, 12);
  assert.equal(report.landscape.timedTranscriptCueCount, 13);
  assert.equal(report.vertical.productComprehensionDeadlineFrame, 120);
});

test("rejects product name or definition that extends past the comprehension deadline", () => {
  const contract = makeContract();
  contract.variants.vertical.layers.find((layer) => layer.id === "product-name").endFrame = 121;
  contract.variants.vertical.layers.find((layer) => layer.id === "product-definition").endFrame = 121;
  assert.throws(() => validate(contract), /must be visible by 4s/u);
});

test("rejects an independent title without 45 fully stable frames", () => {
  const contract = makeContract();
  contract.variants.vertical.layers.find((layer) => layer.id === "goal-primary").endFrame = 179;
  assert.throws(() => validate(contract), /45 fully stable frames/u);
});

test("rejects an overlong primary title", () => {
  const contract = makeContract();
  contract.variants.landscape.layers.find((layer) => layer.id === "space-primary").text = "这是一个明显超过十八个字符并且无法静音快速理解的主标题";
  assert.throws(() => validate(contract), /18-character maximum/u);
});

test("rejects a missing semantic, data, space, action, or history overlay", () => {
  for (const id of ["semantic-model", "data-readout", "space-scan", "action-fanout", "history-states"]) {
    const contract = makeContract();
    contract.variants.landscape.nonTextOverlays = contract.variants.landscape.nonTextOverlays.filter((overlay) => overlay.id !== id);
    assert.throws(() => validate(contract), new RegExp(`missing required overlay ${id}`, "u"));
  }
});

test("rejects a required overlay outside the portrait safe area", () => {
  const contract = makeContract();
  contract.variants.vertical.nonTextOverlays.find((overlay) => overlay.id === "data-readout").bounds.x = 0;
  assert.throws(() => validate(contract), /violates the left safe area/u);
});

test("rejects action fan-out outside its exact source-visible ranges", () => {
  for (const variantName of ["landscape", "vertical"]) {
    const contract = makeContract();
    const overlay = contract.variants[variantName].nonTextOverlays.find((entry) => entry.id === "action-fanout");
    if (overlay.regions) {
      for (const region of overlay.regions) region.endFrame += 1;
    } else {
      overlay.endFrame += 1;
    }
    assert.throws(() => validate(contract), /exact source-visible range/u);
  }
  assert.throws(
    () => validateSemanticOverlaySource(semanticOverlaySource.replace('? 42 : 34', '? 43 : 34')),
    /exact local end frames 42\/34/u,
  );
});

test("rejects data readout semantics that stop identifying a planner constraint", () => {
  const contract = makeContract();
  contract.semanticTruthContract.dataReadout.roadSecondary = "BOUND TO ROAD";
  assert.throws(() => validate(contract), /semantic truth contract/u);
  assert.throws(
    () => validateSemanticOverlaySource(semanticOverlaySource.replace('secondary: "PLANNER CONSTRAINT"', 'secondary: "BOUND TO ROAD"')),
    /PLANNER CONSTRAINT/u,
  );
});

test("rejects history highlights that drift from local frames 12, 40, and 60", () => {
  const contract = makeContract();
  contract.semanticTruthContract.historyHighlight.localTransitionFrames[1] = 41;
  assert.throws(() => validate(contract), /semantic truth contract/u);

  const regionDrift = makeContract();
  regionDrift.variants.vertical.nonTextOverlays.find((overlay) => overlay.id === "history-states").regions[1].endFrame += 1;
  assert.throws(() => validate(regionDrift), /exact local frames 12, 40, and 60/u);
  assert.throws(
    () => validateSemanticOverlaySource(semanticOverlaySource.replace('const redoAppliedFrame = 40;', 'const redoAppliedFrame = 41;')),
    /exact local frames 12, 40, and 60/u,
  );
});

test("rejects staggered revision-label reveal", () => {
  const contract = makeContract();
  contract.semanticTruthContract.historyHighlight.labelsRevealTogether = false;
  assert.throws(() => validate(contract), /semantic truth contract/u);
  assert.throws(
    () => validateSemanticOverlaySource(semanticOverlaySource.replace(
      'const progress = revealProgress(frame, fps);',
      'const progress = revealProgress(frame, fps, index);',
    )),
    /reveal every revision label together|must not stagger/u,
  );
});

test("rejects fake-network wording while allowing LIVE CODEX", () => {
  assert.doesNotThrow(() => assertTruthfulClaims("LIVE CODEX · deterministic snapshot"));
  assert.throws(() => assertTruthfulClaims("AI reads live data"), /fake live-network data/u);
  const contract = makeContract();
  contract.variants.vertical.layers.find((layer) => layer.id === "data-proof").text = "实时数据 · ETA 28秒";
  assert.throws(() => validate(contract), /fake live-network data/u);
});

test("rejects continuous-path or continuous-physics overclaims", () => {
  assert.throws(() => assertTruthfulClaims("全程无碰撞"), /continuous-physics overclaim/u);
  assert.throws(() => assertTruthfulClaims("continuous path collision-free"), /continuous-physics overclaim/u);
});

test("rejects unsupported attribution of the rejected candidate to AI", () => {
  assert.throws(() => assertTruthfulClaims("AI的第一个候选会撞树"), /unsupported rejected-candidate attribution/u);
});

test("rejects source-range drift from the frozen V4 timeline", () => {
  const contract = makeContract();
  contract.variants.vertical.sourceFrameRanges.find((range) => range.id === "space_read").sourceStart = 44;
  assert.throws(() => validate(contract), /source ranges differ/u);
});

test("rejects a stale composition source hash", () => {
  const contract = makeContract();
  assert.throws(() => validateVisualContract(contract, {
    compositionSourceHash: `sha256:${"b".repeat(64)}`,
  }), /stale relative/u);
});

test("rejects a stale semantic-overlay source hash", () => {
  const contract = makeContract();
  assert.throws(() => validateVisualContract(contract, {
    compositionSourceHash: contract.compositionSourceSha256,
    semanticOverlaySourceHash: `sha256:${"c".repeat(64)}`,
  }), /stale relative to EmergencyCitySemanticLens/u);
});

test("rejects a rendered video that predates either source dependency", () => {
  assert.throws(() => assertArtifactFreshness({
    artifactLabel: "fixture.mp4",
    artifactModifiedMs: 100,
    dependencies: [
      {label: "composition.tsx", modifiedMs: 90},
      {label: "semantic-lens.tsx", modifiedMs: 101},
    ],
  }), /predates semantic-lens\.tsx/u);
  assert.doesNotThrow(() => assertArtifactFreshness({
    artifactLabel: "fixture.mp4",
    artifactModifiedMs: 101,
    dependencies: [
      {label: "composition.tsx", modifiedMs: 90},
      {label: "semantic-lens.tsx", modifiedMs: 101},
    ],
  }));
});

test("rejects source-derived overlay geometry drift", () => {
  const contract = makeContract();
  contract.variants.landscape.nonTextOverlays.find((overlay) => overlay.id === "semantic-model").bounds.x += 1;
  assert.throws(() => validate(contract), /bounds differ from the source-derived V4 overlay geometry/u);
});

test("accepts generated fixture transcripts only when timing and copy exactly match V4", () => {
  for (const variant of ["landscape", "vertical"]) {
    for (const language of ["en", "zh"]) {
      const cues = fixtureContract.timedTranscriptCues[variant];
      const report = validateTimedTranscript(makeSrt(cues, language), {
        id: `${variant}-${language}`,
        durationSeconds: fixtureContract.variants[variant].durationFrames / 30,
        language,
        expectedCues: cues,
      });
      assert.equal(report.cueCount, 13);
      assert.ok(report.maximumCps <= 25);
      assert.ok(report.longestLine <= 40);
    }
  }
});

test("accepts the four actual V4 transcript artifacts", () => {
  const entries = [
    ["landscape-en", "../video/captions/semaframe-emergency-city-v4.en-US.srt", "landscape", "en", 32],
    ["landscape-zh", "../video/captions/semaframe-emergency-city-v4.zh-CN.srt", "landscape", "zh", 32],
    ["vertical-en", "../video/captions/semaframe-emergency-city-v4-vertical.en-US.srt", "vertical", "en", 28],
    ["vertical-zh", "../video/captions/semaframe-emergency-city-v4-vertical.zh-CN.srt", "vertical", "zh", 28],
  ];
  for (const [id, path, variant, language, durationSeconds] of entries) {
    const report = validateTimedTranscript(readFileSync(new URL(path, import.meta.url), "utf8"), {
      id,
      durationSeconds,
      language,
      expectedCues: fixtureContract.timedTranscriptCues[variant],
    });
    assert.equal(report.cueCount, 13);
  }
});

test("rejects transcript timing or visible-copy drift", () => {
  const cues = fixtureContract.timedTranscriptCues.vertical;
  const correct = makeSrt(cues, "zh");
  assert.throws(() => validateTimedTranscript(correct.replace("00:00:02,000 -->", "00:00:02,033 -->"), {
    id: "vertical-zh-timing-drift",
    durationSeconds: 28,
    language: "zh",
    expectedCues: cues,
  }), /frozen V4 frame timing/u);
  assert.throws(() => validateTimedTranscript(correct.replace("唯一通道已堵死", "唯一通道可能堵塞"), {
    id: "vertical-zh-copy-drift",
    durationSeconds: 28,
    language: "zh",
    expectedCues: cues,
  }), /text differs/u);
});

test("luma fixture reports black and frozen spans", () => {
  const frameSize = 16;
  const blackFrames = Array.from({ length: 4 }, () => Buffer.alloc(frameSize, 0));
  const movingFrames = Array.from({ length: 3 }, (_, index) => Buffer.alloc(frameSize, 40 + index * 20));
  const report = analyzeSampleBuffer(Buffer.concat([...blackFrames, ...movingFrames]), frameSize, 5);
  assert.equal(report.maxBlackRunSeconds, 0.8);
  assert.equal(report.maxFrozenRunSeconds, 0.6);
  assert.equal(report.sampleCount, 7);
});
