import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeSampleBuffer, validateTimedTranscript, validateVisualContract } from "./verify-emergency-city-v3.mjs";

const REQUIRED_BEATS = [
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
];

function makeVariant(width, height, durationFrames, safeArea) {
  const landscape = width > height;
  const sourceFrameRanges = landscape
    ? [
        ["crisis", 0, 90, "crisis-frames", 0, 119], ["goal", 90, 165, "prompt-frames", 0, 59],
        ["spatial_read", 165, 255, "understand-frames", 0, 89], ["collision_rejection", 255, 360, "collision-frames", 0, 119],
        ["safe_plan", 360, 450, "plan-frames", 0, 89], ["human_confirm", 450, 510, "response-frames", 0, 44],
        ["response", 510, 675, "response-frames", 45, 219], ["resolution", 675, 750, "final-frames", 0, 74],
        ["undo", 750, 790, "undo-redo-frames", 0, 39],
        ["redo", 790, 830, "undo-redo-frames", 40, 89], ["reopen", 830, 870, "reopen-frames", 0, 89],
        ["identity", 870, 960, "final-frames", 30, 149],
      ]
    : [
        ["crisis", 0, 75, "crisis-frames", 0, 119], ["goal", 75, 135, "prompt-frames", 0, 59],
        ["spatial_read", 135, 210, "understand-frames", 0, 89], ["collision_rejection", 210, 300, "collision-frames", 0, 119],
        ["safe_plan", 300, 375, "plan-frames", 0, 89], ["human_confirm", 375, 435, "response-frames", 0, 44],
        ["response", 435, 575, "response-frames", 45, 219], ["resolution", 575, 645, "final-frames", 0, 74],
        ["undo", 645, 680, "undo-redo-frames", 0, 39],
        ["redo", 680, 715, "undo-redo-frames", 40, 89], ["reopen", 715, 750, "reopen-frames", 0, 89],
        ["identity", 750, 840, "final-frames", 30, 149],
      ];
  return {
    width,
    height,
    durationFrames,
    fps: 30,
    safeArea,
    layers: [
      {
        id: "primary-a",
        kind: "primary",
        text: "生命通道被堵死",
        startFrame: 0,
        endFrame: 60,
        bounds: { x: safeArea.left, y: safeArea.top, width: 500, height: 100 },
      },
      {
        id: "proof-a",
        kind: "proof",
        text: "0 COLLISIONS",
        startFrame: 0,
        endFrame: durationFrames,
        bounds: { x: safeArea.left, y: safeArea.top + 140, width: 360, height: 70 },
      },
    ],
    nonTextOverlays: ["spatial-scan", "collision-mark", "safe-plan-checks", "confirm-pointer"].map((id, index) => ({
      id,
      safeAreaPolicy: "safe_area",
      regions: [{
        startFrame: 60 + index * 60,
        endFrame: 105 + index * 60,
        bounds: { x: safeArea.left + 620, y: safeArea.top + 300, width: 120, height: 80 },
      }],
    })),
    sourceFrameRanges: sourceFrameRanges.map(([id, startFrame, endFrame, folder, sourceStart, sourceEnd]) => ({
      id, startFrame, endFrame, folder, sourceStart, sourceEnd,
    })),
  };
}

function makeContract() {
  return {
    version: "3.0",
    rangeSemantics: "startInclusiveEndExclusive",
    sourceRangeSemantics: "sourceStartInclusiveSourceEndInclusive",
    compositionSourceSha256: `sha256:${"a".repeat(64)}`,
    silentFirst: true,
    audioRequiredForComprehension: false,
    timedCaptionFilesAreTranscriptsOnly: true,
    masterRequiresTimedCaptions: false,
    textMotionContract: {
      titleEnterFrames: 10,
      titleExitFrames: 5,
      proofEnterFrames: 8,
      proofExitFrames: 4,
      goalTypingCompleteFrame: 9,
      minimumStableFrames: 45,
    },
    variants: {
      landscape: makeVariant(1920, 1080, 960, { top: 54, right: 72, bottom: 54, left: 72 }),
      vertical: makeVariant(1080, 1920, 840, { top: 120, right: 60, bottom: 180, left: 60 }),
    },
    comprehensionBeats: REQUIRED_BEATS.map((id, index) => ({
      id,
      ranges: {
        landscape: { startFrame: index * 60, endFrame: index * 60 + 45 },
        vertical: { startFrame: index * 60, endFrame: index * 60 + 45 },
      },
    })),
  };
}

test("accepts a complete silent-first visual contract", () => {
  const contract = makeContract();
  const report = validateVisualContract(contract, { compositionSourceHash: contract.compositionSourceSha256 });
  assert.equal(report.landscape.comprehensionBeatCount, 10);
  assert.equal(report.vertical.safeArea.bottom, 180);
});

test("rejects primary/proof overlap in time and screen space", () => {
  const contract = makeContract();
  contract.variants.landscape.layers[1].bounds.y = contract.variants.landscape.safeArea.top + 20;
  assert.throws(() => validateVisualContract(contract, { compositionSourceHash: contract.compositionSourceSha256 }), /overlaps/u);
});

test("rejects an overlong primary line", () => {
  const contract = makeContract();
  contract.variants.vertical.layers[0].text = "这是一个明显超过十八个字符并且不适合静音传播的主标题";
  assert.throws(() => validateVisualContract(contract, { compositionSourceHash: contract.compositionSourceSha256 }), /maximum is 18/u);
});

test("rejects a text layer without 45 fully stable frames after motion", () => {
  const contract = makeContract();
  contract.variants.vertical.layers[0].endFrame = 59;
  assert.throws(
    () => validateVisualContract(contract, { compositionSourceHash: contract.compositionSourceSha256 }),
    /fully stable frames/u,
  );
});

test("includes goal typing time in the fully stable-frame gate", () => {
  const contract = makeContract();
  contract.variants.vertical.layers[0].id = "goal-primary";
  contract.textMotionContract.goalTypingCompleteFrame = 11;
  assert.throws(
    () => validateVisualContract(contract, { compositionSourceHash: contract.compositionSourceSha256 }),
    /fully stable frames/u,
  );
});

test("rejects a stale composition source hash", () => {
  const contract = makeContract();
  assert.throws(() => validateVisualContract(contract, { compositionSourceHash: `sha256:${"b".repeat(64)}` }), /stale relative/u);
});

test("rejects ambiguous source range semantics", () => {
  const contract = makeContract();
  delete contract.sourceRangeSemantics;
  assert.throws(() => validateVisualContract(contract, { compositionSourceHash: contract.compositionSourceSha256 }), /source ranges/u);
});

test("rejects stale visible revision evidence", () => {
  const contract = makeContract();
  for (const variant of Object.values(contract.variants)) {
    variant.layers[1].id = "collision-proof";
    variant.layers[1].text = "空间预检拒绝 · rev 4 → 4";
  }
  assert.throws(() => validateVisualContract(contract, {
    compositionSourceHash: contract.compositionSourceSha256,
    rejectedRevisionBefore: 8,
    rejectedRevisionAfter: 8,
  }), /stale revision evidence/u);
});

test("accepts revision-independent collision proof", () => {
  const contract = makeContract();
  for (const variant of Object.values(contract.variants)) {
    variant.layers[1].id = "collision-proof";
    variant.layers[1].text = "空间预检拒绝 · 修订未改变";
  }
  assert.doesNotThrow(() => validateVisualContract(contract, {
    compositionSourceHash: contract.compositionSourceSha256,
    rejectedRevisionBefore: 8,
    rejectedRevisionAfter: 8,
  }));
});

test("rejects a non-text overlay outside the safe area", () => {
  const contract = makeContract();
  contract.variants.vertical.nonTextOverlays[0].regions[0].bounds.x = 0;
  assert.throws(() => validateVisualContract(contract, { compositionSourceHash: contract.compositionSourceSha256 }), /left safe area/u);
});

test("accepts time-sliced regions for a moving overlay", () => {
  const contract = makeContract();
  contract.variants.landscape.nonTextOverlays.at(-1).regions = [
    { startFrame: 240, endFrame: 260, bounds: { x: 720, y: 360, width: 120, height: 80 } },
    { startFrame: 260, endFrame: 285, bounds: { x: 520, y: 520, width: 120, height: 80 } },
  ];
  assert.doesNotThrow(() => validateVisualContract(contract, { compositionSourceHash: contract.compositionSourceSha256 }));
});

test("luma sampler reports black and frozen runs", () => {
  const frameSize = 16;
  const blackFrames = Array.from({ length: 4 }, () => Buffer.alloc(frameSize, 0));
  const movingFrames = Array.from({ length: 3 }, (_, index) => Buffer.alloc(frameSize, 40 + index * 20));
  const result = analyzeSampleBuffer(Buffer.concat([...blackFrames, ...movingFrames]), frameSize, 5);
  assert.equal(result.maxBlackRunSeconds, 0.8);
  assert.equal(result.maxFrozenRunSeconds, 0.6);
  assert.equal(result.sampleCount, 7);
});

test("accepts all four complete low-density timed transcripts", () => {
  const entries = [
    ["landscape-en", "video/captions/semaframe-emergency-city-v3.en-US.srt", 32, "en"],
    ["landscape-zh", "video/captions/semaframe-emergency-city-v3.zh-CN.srt", 32, "zh"],
    ["vertical-en", "video/captions/semaframe-emergency-city-v3-vertical.en-US.srt", 28, "en"],
    ["vertical-zh", "video/captions/semaframe-emergency-city-v3-vertical.zh-CN.srt", 28, "zh"],
  ];
  for (const [id, path, durationSeconds, language] of entries) {
    const report = validateTimedTranscript(readFileSync(path, "utf8"), { id, durationSeconds, language });
    assert.equal(report.cueCount, 11);
    assert.ok(report.maximumCps <= 25);
    assert.ok(report.longestLine <= 40);
  }
});
