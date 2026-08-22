import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const requested = process.argv.slice(2);
const inputs = (requested.length > 0 ? requested : [
  "artifacts/semaframe-emergency-city-v3.mp4",
  "artifacts/semaframe-emergency-city-v3-vertical.mp4",
]).map((path) => resolve(path));

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
  }
  return result;
}

function normalize(input) {
  if (!existsSync(input)) throw new Error(`V3 render does not exist: ${input}`);
  const temporary = join(dirname(input), `.${basename(input, ".mp4")}.normalized.mp4`);
  rmSync(temporary, { force: true });

  const loudnessProbe = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", input,
    "-vn",
    "-af", "loudnorm=I=-16:TP=-1:LRA=7:print_format=json",
    "-f", "null",
    "-",
  ], `${basename(input)} loudness analysis`);

  const loudnessReports = loudnessProbe.stderr.match(/\{\s*"input_i"[\s\S]*?\}/gu) ?? [];
  const measured = JSON.parse(loudnessReports.at(-1) ?? "null");
  for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    if (!measured || !Number.isFinite(Number(measured[key]))) {
      throw new Error(`${basename(input)} loudness analysis did not return finite ${key}.`);
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

  try {
    run("ffmpeg", [
      "-y",
      "-loglevel", "error",
      "-i", input,
      "-vf", "scale=in_range=full:out_range=tv,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off",
      "-color_range", "tv",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-bsf:v", "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-af", loudnessFilter,
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-ac", "2",
      "-r", "30",
      "-fps_mode", "cfr",
      "-movflags", "+faststart",
      temporary,
    ], `${basename(input)} normalization`);
    renameSync(temporary, input);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  process.stdout.write(`Normalized ${input} to BT.709 limited-range yuv420p and -16 LUFS / -1 dBTP.\n`);
}

for (const input of inputs) normalize(input);
