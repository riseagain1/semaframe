import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentPath = new URL("../video/src/LivingRoomPublicDemo.tsx", import.meta.url);
const contractPath = new URL("../video/living-room-public-demo-en.visual-contract.json", import.meta.url);
const evidencePath = new URL("../video/public/living-room/evidence.json", import.meta.url);
const captionsPath = new URL("../video/captions/semaframe-living-room-public-demo.en-US.srt", import.meta.url);

const [component, contractText, evidenceText, captions] = await Promise.all([
  readFile(componentPath, "utf8"),
  readFile(contractPath, "utf8"),
  readFile(evidencePath, "utf8"),
  readFile(captionsPath, "utf8"),
]);

const contract = JSON.parse(contractText);
const evidence = JSON.parse(evidenceText);

const componentSha256 = `sha256:${createHash("sha256").update(component).digest("hex")}`;

const flattenStrings = (value) => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenStrings);
  return [];
};

const parseSrtTime = (value) => {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
  assert.ok(match, `Invalid SRT timestamp: ${value}`);
  const [, hours, minutes, seconds, milliseconds] = match.map(Number);
  return (((hours * 60 + minutes) * 60) + seconds) * 1000 + milliseconds;
};

test("English wrapper keeps the original 40-second timeline", () => {
  assert.equal(contract.compositionExport, "SemaFrameLivingRoomPublicDemoEnglish");
  assert.equal(contract.compositionSourceSha256, componentSha256);
  assert.equal(contract.posterExport, "SemaFrameLivingRoomPublicDemoEnglishPoster");
  assert.equal(contract.durationFrames, 1200);
  assert.equal(contract.durationSeconds, 40);
  assert.equal(contract.timeline.at(0).startFrame, 0);
  assert.equal(contract.timeline.at(-1).endFrame, contract.durationFrames);
  assert.match(component, /export const LIVING_ROOM_PUBLIC_ENGLISH_DURATION = LIVING_ROOM_PUBLIC_DURATION/);
  assert.match(component, /export const SemaFrameLivingRoomPublicDemoEnglish/);
  assert.match(component, /export const SemaFrameLivingRoomPublicDemoEnglishPoster/);
  assert.match(component, /locale === "en-US" && folder !== "room-frames"/);
  assert.match(captions, /--> 00:00:40,000/);
});

test("every contracted English line is visible copy in the component", () => {
  const englishCopy = flattenStrings(contract.screenCopy);
  assert.ok(englishCopy.length >= 20);
  for (const text of englishCopy) {
    assert.doesNotMatch(text, /\p{Script=Han}/u);
    assert.ok(component.includes(text), `Missing English screen copy: ${text}`);
  }
});

test("English claims stay within the captured evidence", () => {
  assert.equal(evidence.syntheticBaseline, true);
  assert.equal(evidence.collisionGuard.errorCode, "spatial_collision");
  assert.equal(evidence.collisionGuard.revisionBefore, evidence.collisionGuard.revisionAfterRejection);
  assert.equal(evidence.collisionGuard.correctedPreflightValid, true);
  assert.equal(evidence.correction.collisionConflictCount, 0);
  assert.equal(evidence.cinemaMode.pointerInput, true);
  assert.equal(evidence.cinemaMode.routedVisibilityEventCount, 5);
  assert.equal(evidence.undoRedo.restored, true);
  assert.match(contract.claimBoundaries.roomSource, /synthetic/);
  assert.match(contract.claimBoundaries.validationScope, /not_building_certification/);
  assert.match(contract.claimBoundaries.cinemaControlScope, /not_smart_home_network/);
});

test("Remotion media and sequencing follow deterministic render rules", () => {
  assert.match(component, /<Img/);
  assert.match(component, /staticFile\(/);
  assert.match(component, /premountFor=/);
  assert.match(component, /useCurrentFrame\(\)/);
  assert.doesNotMatch(component, /<img\b/);
  assert.doesNotMatch(component, /\banimation\s*:/);
  assert.doesNotMatch(component, /\btransition\s*:/);
});

test("English accessibility captions are ordered and readable", () => {
  const blocks = captions.trim().split(/\n{2,}/);
  assert.equal(blocks.length, 14);
  let previousEnd = 0;
  blocks.forEach((block, index) => {
    const [number, timing, ...lines] = block.split("\n");
    assert.equal(Number(number), index + 1);
    const [startText, endText] = timing.split(" --> ");
    const start = parseSrtTime(startText);
    const end = parseSrtTime(endText);
    assert.ok(start >= previousEnd, `Caption ${index + 1} overlaps its predecessor`);
    assert.ok(end > start, `Caption ${index + 1} has no duration`);
    assert.ok(lines.length >= 1 && lines.length <= 2);
    for (const line of lines) {
      assert.ok(line.length <= 42, `Caption ${index + 1} exceeds 42 characters per line`);
      assert.doesNotMatch(line, /\p{Script=Han}/u);
    }
    const charactersPerSecond = lines.join(" ").length / ((end - start) / 1000);
    assert.ok(charactersPerSecond <= 22.5, `Caption ${index + 1} is too fast: ${charactersPerSecond.toFixed(1)} CPS`);
    previousEnd = end;
  });
  assert.equal(previousEnd, 40_000);
});
