import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const input = resolve("artifacts/semaframe-emergency-city-hero.mp4");
const temporary = join(dirname(input), ".semaframe-emergency-city-hero.normalized.mp4");

if (!existsSync(input)) throw new Error(`Hero render does not exist: ${input}`);
rmSync(temporary, { force: true });

const loudnessProbe = spawnSync("ffmpeg", [
  "-hide_banner",
  "-nostats",
  "-i", input,
  "-vn",
  "-af", "loudnorm=I=-16:TP=-1:LRA=7:print_format=json",
  "-f", "null",
  "-",
], { encoding: "utf8" });

if (loudnessProbe.status !== 0) {
  throw new Error(`Emergency-city loudness analysis failed: ${loudnessProbe.stderr}`);
}

const loudnessReports = loudnessProbe.stderr.match(/\{\s*"input_i"[\s\S]*?\}/gu) ?? [];
const measured = JSON.parse(loudnessReports.at(-1) ?? "null");
for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
  if (!measured || !Number.isFinite(Number(measured[key]))) {
    throw new Error(`Emergency-city loudness analysis did not return finite ${key}.`);
  }
}

const loudnessFilter = [
  "loudnorm=I=-16:TP=-1:LRA=7",
  `measured_I=${measured.input_i}`,
  `measured_TP=${measured.input_tp}`,
  `measured_LRA=${measured.input_lra}`,
  `measured_thresh=${measured.input_thresh}`,
  `offset=${measured.target_offset}`,
  "linear=true",
  "print_format=summary",
].join(":");

const result = spawnSync("ffmpeg", [
  "-y",
  "-loglevel", "error",
  "-i", input,
  "-vf", "scale=in_range=full:out_range=tv,format=yuv420p",
  "-c:v", "libx264",
  "-preset", "medium",
  "-crf", "18",
  "-color_range", "tv",
  "-colorspace", "bt709",
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-af", loudnessFilter,
  "-c:a", "aac",
  "-b:a", "192k",
  "-ar", "48000",
  "-ac", "2",
  "-r", "30",
  "-fps_mode", "cfr",
  "-movflags", "+faststart",
  temporary,
], { encoding: "utf8" });

if (result.status !== 0) {
  rmSync(temporary, { force: true });
  throw new Error(`Emergency-city color normalization failed: ${result.stderr}`);
}
renameSync(temporary, input);
console.log(`Normalized emergency-city hero to BT.709 limited-range yuv420p and -16 LUFS / -1 dBTP audio: ${input}`);
