import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
  generateDemoAudio,
  writeFileAtomicIfChanged,
} from "./generate-demo-audio.mjs";

test("deterministic demo audio preserves its existing mtime when bytes are identical", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "semaframe-demo-audio-"));
  const outputPath = join(temporaryRoot, "nested", "score.wav");
  try {
    const first = generateDemoAudio({
      outputPath,
      durationSeconds: 0.02,
      copyBrandAssets: false,
    });
    assert.equal(first.changed, true);
    assert.equal(first.frameCount, 960);
    const expected = readFileSync(outputPath);
    assert.equal(expected.length, 44 + first.frameCount * first.channels * 2);

    const frozenTime = new Date("2001-02-03T04:05:06.000Z");
    utimesSync(outputPath, frozenTime, frozenTime);
    const before = statSync(outputPath, {bigint: true});

    const second = generateDemoAudio({
      outputPath,
      durationSeconds: 0.02,
      copyBrandAssets: false,
    });
    const after = statSync(outputPath, {bigint: true});
    assert.equal(second.changed, false);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(readFileSync(outputPath), expected);

    writeFileSync(outputPath, "stale bytes");
    const replaced = generateDemoAudio({
      outputPath,
      durationSeconds: 0.02,
      copyBrandAssets: false,
    });
    assert.equal(replaced.changed, true);
    assert.deepEqual(readFileSync(outputPath), expected);
    assert.deepEqual(readdirSync(join(temporaryRoot, "nested")), ["score.wav"]);
  } finally {
    rmSync(temporaryRoot, {recursive: true, force: true});
  }
});

test("failed atomic replacement preserves the previous file and removes its temporary file", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "semaframe-demo-audio-atomic-"));
  const outputPath = join(temporaryRoot, "score.wav");
  try {
    writeFileSync(outputPath, "published score");
    let temporaryPath;
    assert.throws(() => writeFileAtomicIfChanged(
      outputPath,
      Buffer.from("replacement score"),
      {
        rename(source) {
          temporaryPath = source;
          throw new Error("simulated rename failure");
        },
      },
    ), /simulated rename failure/u);
    assert.equal(readFileSync(outputPath, "utf8"), "published score");
    assert.equal(existsSync(temporaryPath), false);
    assert.deepEqual(readdirSync(temporaryRoot), ["score.wav"]);
  } finally {
    rmSync(temporaryRoot, {recursive: true, force: true});
  }
});
