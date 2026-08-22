import {spawnSync} from "node:child_process";
import {mkdir, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {bundle} from "@remotion/bundler";
import {getCompositions, renderStill} from "@remotion/renderer";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(repositoryRoot, process.argv[2] ?? "artifacts/qa-english");

const targets = [
  {
    id: "SemaFrameRealityOpsProofV2English",
    slug: "pump-landscape",
    frames: [24, 90, 174, 276, 438, 612, 822, 1014],
    thumbnailWidth: 480,
  },
  {
    id: "SemaFrameRealityOpsProofV2VerticalEnglish",
    slug: "pump-vertical",
    frames: [18, 72, 132, 216, 366, 510, 702, 888],
    thumbnailWidth: 270,
  },
  {
    id: "SemaFrameLivingRoomPublicDemoEnglish",
    slug: "furniture-landscape",
    frames: [30, 108, 198, 342, 522, 690, 888, 1146],
    thumbnailWidth: 480,
  },
  {
    id: "SemaFrameEmergencyCityProofV4English",
    slug: "traffic-landscape",
    frames: [24, 90, 174, 282, 438, 588, 750, 906],
    thumbnailWidth: 480,
  },
  {
    id: "SemaFrameEmergencyCityProofV4EnglishVertical",
    slug: "traffic-vertical",
    frames: [18, 72, 144, 252, 390, 522, 660, 786],
    thumbnailWidth: 270,
  },
  {
    id: "SemaFrameRealityTwinProofV1",
    slug: "reality-twin-landscape",
    frames: [24, 90, 165, 278, 390, 592, 802, 930],
    thumbnailWidth: 480,
  },
  {
    id: "SemaFrameRealityTwinProofV1Vertical",
    slug: "reality-twin-vertical",
    frames: [24, 90, 157, 255, 352, 525, 727, 862],
    thumbnailWidth: 270,
  },
];

const run = (command, args, label) => {
  const result = spawnSync(command, args, {encoding: "utf8"});
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
  }
};

await mkdir(outputRoot, {recursive: true});
const serveUrl = await bundle({
  entryPoint: resolve(repositoryRoot, "video/src/index.ts"),
  publicDir: resolve(repositoryRoot, "video/public"),
  onProgress: () => undefined,
});
const compositions = await getCompositions(serveUrl, {inputProps: {}});

for (const target of targets) {
  const composition = compositions.find((candidate) => candidate.id === target.id);
  if (!composition) throw new Error(`Missing Remotion composition: ${target.id}`);
  const targetRoot = resolve(outputRoot, target.slug);
  await mkdir(targetRoot, {recursive: true});

  for (const [index, frame] of target.frames.entries()) {
    if (frame < 0 || frame >= composition.durationInFrames) {
      throw new Error(`${target.id} QA frame ${frame} is outside 0..${composition.durationInFrames - 1}.`);
    }
    await renderStill({
      composition,
      serveUrl,
      frame,
      output: resolve(targetRoot, `frame-${String(index).padStart(2, "0")}.png`),
      imageFormat: "png",
      overwrite: true,
      logLevel: "error",
    });
  }

  const contactSheet = resolve(outputRoot, `${target.slug}-contact-sheet.jpg`);
  run("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-pattern_type", "glob",
    "-i", resolve(targetRoot, "frame-*.png"),
    "-vf", `scale=${target.thumbnailWidth}:-1:flags=lanczos,tile=4x2:padding=8:margin=8:color=0x07111d`,
    "-frames:v", "1",
    "-q:v", "2",
    contactSheet,
  ], `${target.id} contact sheet`);
}

await writeFile(resolve(outputRoot, "manifest.json"), `${JSON.stringify({targets}, null, 2)}\n`, "utf8");
process.stdout.write(`Rendered ${targets.reduce((sum, target) => sum + target.frames.length, 0)} English QA stills and ${targets.length} contact sheets to ${outputRoot}.\n`);
