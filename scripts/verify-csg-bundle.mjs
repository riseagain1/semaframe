import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = await mkdtemp(join(tmpdir(), "semaframe-csg-bundle-"));
const expectedWasmBytes = 541_470;

async function filesBelow(directory, prefix = "") {
  const files = [];
  for (const name of await readdir(directory)) {
    const absolute = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await stat(absolute);
    if (info.isDirectory()) files.push(...await filesBelow(absolute, relative));
    else files.push({ absolute, relative, bytes: info.size });
  }
  return files;
}

function invariant(condition, message) {
  if (!condition) throw new Error(`CSG bundle regression: ${message}`);
}

try {
  await build({
    root: workspaceRoot,
    logLevel: "warn",
    build: {
      target: "es2022",
      outDir: outputDirectory,
      emptyOutDir: true,
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: resolve(workspaceRoot, "src/workspace/modeling/csgWorkerClient.ts"),
      },
    },
  });

  const files = await filesBelow(outputDirectory);
  const wasmFiles = files.filter(({ relative }) => relative.endsWith(".wasm"));
  const workerFiles = files.filter(({ relative }) => /csgKernel\.worker-[\w-]+\.js$/u.test(relative));

  invariant(wasmFiles.length === 1, `expected one external WASM asset, found ${wasmFiles.length}`);
  invariant(
    /^assets\/manifold-[\w-]{8}\.wasm$/u.test(wasmFiles[0].relative),
    `WASM asset is not fingerprinted: ${wasmFiles[0].relative}`,
  );
  invariant(
    wasmFiles[0].bytes === expectedWasmBytes,
    `pinned Manifold WASM size changed from ${expectedWasmBytes} to ${wasmFiles[0].bytes} bytes`,
  );
  invariant(workerFiles.length === 1, `expected one CSG Worker chunk, found ${workerFiles.length}`);
  invariant(
    workerFiles[0].bytes < 2_000_000,
    `CSG Worker is ${workerFiles[0].bytes} bytes; Manifold WASM was probably inlined`,
  );

  const workerSource = await readFile(workerFiles[0].absolute, "utf8");
  invariant(
    !workerSource.includes("data:application/wasm;base64,"),
    "CSG Worker contains an inlined WASM data URL",
  );
  invariant(
    workerSource.includes(wasmFiles[0].relative.split("/").at(-1)),
    "CSG Worker does not reference the emitted fingerprinted WASM asset",
  );

  console.log(
    `CSG bundle verified: ${workerFiles[0].relative} (${workerFiles[0].bytes} bytes), ${wasmFiles[0].relative} (${wasmFiles[0].bytes} bytes)`,
  );
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
