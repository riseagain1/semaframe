import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const componentPath = resolve(root, "video/src/EmergencyCityProofV3.tsx");
const semanticPath = resolve(root, "video/src/EmergencyCitySemanticLens.tsx");
const contractPath = resolve(root, "video/emergency-city-v4-english.visual-contract.json");

const sha256 = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const componentSource = readFileSync(componentPath, "utf8");
const semanticSource = readFileSync(semanticPath, "utf8");

test("English V4 contract is bound to the current shared sources", () => {
  assert.equal(contract.compositionSourceSha256, sha256(componentPath));
  assert.equal(contract.semanticOverlaySourceSha256, sha256(semanticPath));
  assert.equal(contract.sharesEvidenceAndTimelineWithV4, true);
  assert.equal(contract.silentFirst, true);
  assert.equal(contract.audioRequiredForComprehension, false);
});

test("English V4 exports landscape, portrait, and both posters", () => {
  for (const name of [
    "SemaFrameEmergencyCityProofV4English",
    "SemaFrameEmergencyCityProofV4EnglishVertical",
    "SemaFrameEmergencyCityProofV4EnglishPoster",
    "SemaFrameEmergencyCityProofV4EnglishVerticalPoster",
  ]) {
    assert.match(componentSource, new RegExp(`export const ${name}\\b`, "u"));
  }
  assert.match(componentSource, /<EmergencyCityProofV4 variant="landscape" language="en" \/>/u);
  assert.match(componentSource, /<EmergencyCityProofV4 variant="vertical" language="en" \/>/u);
});

test("English V4 uses localized semantic evidence without changing the Chinese default", () => {
  assert.match(semanticSource, /language\?: EmergencyCitySemanticLensLanguage/u);
  assert.match(semanticSource, /language = "zh"/u);
  for (const label of Object.values(contract.semanticLabels).flat()) {
    assert.ok(semanticSource.includes(label), `Missing English semantic label: ${label}`);
  }
  assert.ok(semanticSource.includes('primary: "对象 · AMB-07"'), "Chinese semantic labels must remain available.");
  assert.match(componentSource, /const CaptureEnglishLocalization =/u);
  assert.match(componentSource, /DISPATCH · ETA 28s/u);
  assert.match(componentSource, /CLEAR 1\.6m/u);
  assert.match(componentSource, /OPEN EMERGENCY ROUTE/u);
  assert.match(componentSource, /language === "en" \? <CaptureEnglishLocalization \/> : null/u);
  assert.match(semanticSource, /variant === "vertical" && index === 2/u);
});

test("English visible copy and poster copy contain no CJK characters", () => {
  const copy = [
    ...Object.values(contract.visibleCopy).flat(),
    ...Object.values(contract.semanticLabels).flat(),
    ...contract.posterCopy.title,
    contract.posterCopy.proof,
  ].join("\n");
  assert.doesNotMatch(copy, /[\u3400-\u9fff]/u);
  for (const text of Object.values(contract.visibleCopy).flat()) {
    assert.ok(componentSource.includes(text), `Missing English on-screen copy: ${text}`);
  }
});

test("English variants retain exact V4 timing and safe areas", () => {
  assert.deepEqual(
    {
      landscape: [contract.variants.landscape.width, contract.variants.landscape.height, contract.variants.landscape.fps, contract.variants.landscape.durationFrames],
      vertical: [contract.variants.vertical.width, contract.variants.vertical.height, contract.variants.vertical.fps, contract.variants.vertical.durationFrames],
    },
    {
      landscape: [1920, 1080, 30, 960],
      vertical: [1080, 1920, 30, 840],
    },
  );
  assert.deepEqual(contract.variants.landscape.safeArea, {top: 54, left: 72, right: 72, bottom: 54});
  assert.deepEqual(contract.variants.vertical.safeArea, {top: 120, left: 60, right: 60, bottom: 180});
});
