import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");

async function packageJson(name) {
  const path = name.startsWith("@")
    ? resolve(root, "node_modules", ...name.split("/"), "package.json")
    : resolve(root, "node_modules", name, "package.json");
  return JSON.parse(await readFile(path, "utf8"));
}

const project = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const spark = await packageJson("@sparkjsdev/spark");
const three = await packageJson("three");
const threeTypes = await packageJson("@types/three");
const fflate = await packageJson("fflate");

const expected = [
  ["project @sparkjsdev/spark pin", project.dependencies?.["@sparkjsdev/spark"], "2.1.0"],
  ["installed @sparkjsdev/spark", spark.version, "2.1.0"],
  ["project Three.js pin", project.dependencies?.three, "0.180.0"],
  ["installed Three.js", three.version, "0.180.0"],
  ["project @types/three pin", project.devDependencies?.["@types/three"], "0.180.0"],
  ["installed @types/three", threeTypes.version, "0.180.0"],
  ["Spark Three.js peer boundary", spark.peerDependencies?.three, ">=0.180.0"],
  ["Spark license", spark.license, "MIT"],
  ["Three.js license", three.license, "MIT"],
  ["fflate license", fflate.license, "MIT"],
];

for (const [label, actual, wanted] of expected) {
  if (actual !== wanted) {
    throw new Error(`${label}: expected ${wanted}, found ${String(actual)}.`);
  }
}

const bundle = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    target: "es2022",
    write: false,
    minify: true,
    lib: {
      entry: resolve(root, "src/renderer/reality/RealitySplatRuntime.ts"),
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) => id === "three" || id.startsWith("three/"),
    },
  },
});

const outputs = Array.isArray(bundle) ? bundle.flatMap((entry) => entry.output) : bundle.output;
const chunks = outputs.filter((entry) => entry.type === "chunk");
const entry = chunks.find((chunk) => chunk.isEntry);
if (!entry) throw new Error("Reality runtime probe did not produce an entry chunk.");
if (entry.dynamicImports.length !== 1) {
  throw new Error(`Reality runtime must have exactly one lazy Spark import; found ${entry.dynamicImports.length}.`);
}
if (entry.code.includes("spark_worker_rs") || entry.code.includes("__wbg_init")) {
  throw new Error("Spark worker/WASM code leaked into the ordinary Reality runtime entry chunk.");
}
const sparkChunk = chunks.find((chunk) => !chunk.isEntry && (
  chunk.fileName.includes("spark.module")
  || chunk.code.includes("spark_worker_rs")
  || chunk.code.includes("class SplatMesh")
));
if (!sparkChunk) throw new Error("The lazy Spark implementation chunk was not emitted separately.");
if (sparkChunk.code.length < entry.code.length * 10) {
  throw new Error("Spark implementation was not materially isolated from the lightweight runtime adapter.");
}

console.log(
  `Reality runtime verified: ${entry.fileName} ${(entry.code.length / 1024).toFixed(1)} KiB; `
  + `lazy ${sparkChunk.fileName} ${(sparkChunk.code.length / 1024 / 1024).toFixed(2)} MiB; MIT dependency set.`,
);
