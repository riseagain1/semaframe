import {existsSync, mkdirSync, readFileSync} from "node:fs";
import {dirname, relative, resolve} from "node:path";
import {spawnSync} from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const contractPath = resolve(root, "video/english-demo-gallery.visual-contract.json");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const deliveries = contract.deliveries.filter((delivery) => delivery.readmePosterPath != null);
invariant(deliveries.length === 3, "Expected exactly three published README gallery posters.");
invariant(deliveries.every((delivery) => delivery.variant === "landscape"), "README gallery posters must use landscape deliveries.");

for (const delivery of deliveries) {
  const input = resolve(root, delivery.posterPath);
  const output = resolve(root, delivery.readmePosterPath);
  invariant(existsSync(input), `Missing rendered poster ${delivery.posterPath}.`);
  mkdirSync(dirname(output), {recursive: true});
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", input,
    "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
    "-frames:v", "1",
    "-q:v", "2",
    output,
  ], {cwd: root, encoding: "utf8"});
  invariant(!result.error, `ffmpeg could not start: ${result.error?.message ?? "unknown error"}`);
  invariant(result.status === 0, `Failed to render ${delivery.readmePosterPath}: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  console.log(`Rendered ${relative(root, output)} from ${relative(root, input)}.`);
}
