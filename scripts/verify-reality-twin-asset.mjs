#!/usr/bin/env node

/**
 * Verify the prepared Smithsonian Reality Twin asset through the two consumers
 * that matter: Semaframe's current untrusted-PLY preflight and Spark's browser
 * decoder/renderer. Default mode appends the result to asset-evidence.json;
 * --check-only performs the same live gates in a disposable QA workdir.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  REALITY_TWIN_MAX_ASSET_BYTES,
  REALITY_TWIN_MAX_SPLAT_COUNT,
} from "./reality-twin-import-limits.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const QA_ROOT = resolve(REPOSITORY_ROOT, "artifacts/reality-twin/qa");
const PREVIEW_PATH = resolve(QA_ROOT, "spark-render.png");

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relativePath(path, repositoryRoot = REPOSITORY_ROOT) {
  return path.slice(repositoryRoot.length + 1);
}

function browserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome/Chromium was not found; set BROWSER_EXECUTABLE");
  return found;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject).listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) throw new Error("Could not reserve a local verification port");
  return port;
}

async function waitForHttp(url, timeoutMilliseconds = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMilliseconds) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // The local process is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  }
}

class Cdp {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function pollValue(cdp, expression, label, timeoutMilliseconds = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMilliseconds) {
    const value = await cdp.evaluate(expression);
    if (value) return value;
    await delay(200);
  }
  const error = await cdp.evaluate("window.__sparkQa?.error || null");
  throw new Error(`Timed out waiting for ${label}${error ? `: ${error}` : ""}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approximatelyEqual(left, right, tolerance = 1e-9) {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= tolerance;
}

function assertObjectBoundsMatch(persisted, fresh, label) {
  for (const bound of ["min", "max"]) {
    for (const axis of ["x", "y", "z"]) {
      assert(
        approximatelyEqual(persisted?.[bound]?.[axis], fresh?.[bound]?.[axis]),
        `${label}.${bound}.${axis} differs from the persisted verification receipt`,
      );
    }
  }
}

function assertArrayBoundsMatch(persisted, fresh, label) {
  for (const bound of ["min", "max"]) {
    assert(Array.isArray(persisted?.[bound]) && persisted[bound].length === 3,
      `${label}.${bound} is missing from the persisted verification receipt`);
    assert(Array.isArray(fresh?.[bound]) && fresh[bound].length === 3,
      `${label}.${bound} is missing from the fresh verification receipt`);
    for (let axis = 0; axis < 3; axis += 1) {
      assert(
        approximatelyEqual(persisted[bound][axis], fresh[bound][axis]),
        `${label}.${bound}[${axis}] differs from the persisted verification receipt`,
      );
    }
  }
}

export function assertPersistedAssetVerificationMatchesFresh(persisted, fresh) {
  assert(persisted?.status === "passed", "Persisted asset verification has not passed");
  const persistedPreflight = persisted?.semaframe_current_preflight;
  const freshPreflight = fresh?.semaframe_current_preflight;
  assertObjectBoundsMatch(
    persistedPreflight?.descriptor?.sourceBounds,
    freshPreflight?.descriptor?.sourceBounds,
    "Current preflight sourceBounds",
  );
  const persistedWarnings = [...(persistedPreflight?.warnings ?? [])].sort();
  const freshWarnings = [...(freshPreflight?.warnings ?? [])].sort();
  assert(
    JSON.stringify(persistedWarnings) === JSON.stringify(freshWarnings),
    "Current preflight warnings differ from the persisted verification receipt",
  );

  const persistedSpark = persisted?.spark_browser_import;
  const freshSpark = fresh?.spark_browser_import;
  assert(persistedSpark?.package === freshSpark?.package,
    "Spark package differs from the persisted verification receipt");
  assert(persistedSpark?.version === freshSpark?.version,
    "Spark version differs from the persisted verification receipt");
  assert(persistedSpark?.decoded_splats === freshSpark?.decoded_splats,
    "Spark decoded splat count differs from the persisted verification receipt");
  assert(persistedSpark?.active_splats === freshSpark?.active_splats,
    "Spark active splat count differs from the persisted verification receipt");
  assertArrayBoundsMatch(
    persistedSpark?.decoded_bounds,
    freshSpark?.decoded_bounds,
    "Spark decoded_bounds",
  );
}

function runCurrentPreflight(assetPath, qaRoot = QA_ROOT, repositoryRoot = REPOSITORY_ROOT) {
  const preflightScriptPath = resolve(qaRoot, "current-preflight.ts");
  const inspectModulePath = resolve(
    repositoryRoot,
    "src/workspace/assets/inspectRealityAsset.ts",
  );
  writeFileSync(preflightScriptPath, [
    'import { readFileSync } from "node:fs";',
    `import { inspectRealityAsset } from ${JSON.stringify(inspectModulePath)};`,
    "const path = process.argv[2];",
    "const bytes = readFileSync(path);",
    'const result = await inspectRealityAsset(new Blob([bytes], { type: "application/ply" }));',
    "process.stdout.write(JSON.stringify(result));",
    "",
  ].join("\n"));
  const executable = resolve(repositoryRoot, "node_modules/.bin/tsx");
  const result = spawnSync(executable, [preflightScriptPath, assetPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Current PLY preflight failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function sparkQaHtml(assetRelativePath) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Semaframe Reality Twin Spark QA</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #31443d; }
    canvas { display: block; width: 100%; height: 100%; }
    #label { position: fixed; left: 28px; top: 24px; color: #d9f6e8; font: 600 15px/1.45 system-ui; letter-spacing: .08em; }
    #label small { display: block; color: #7bb59c; font-weight: 500; letter-spacing: .03em; }
  </style>
</head>
<body>
<div id="label">SMITHSONIAN CC0 · SPARK QA<small>1.5M textured surface Gaussians</small></div>
<script type="module">
  import * as THREE from "three";
  import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
  window.__sparkQa = { status: "loading" };
  try {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#31443d");
    const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.01, 10);
    camera.position.set(0.48, 0.30, 0.62);
    camera.lookAt(0, 0.155, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    document.body.prepend(renderer.domElement);
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.27, 0.035, 64),
      new THREE.MeshStandardMaterial({ color: "#17251f", roughness: 0.82, metalness: 0.08 }),
    );
    plinth.position.y = -0.02;
    scene.add(plinth);
    scene.add(new THREE.HemisphereLight("#d9fff1", "#07100d", 1.4));
    const key = new THREE.DirectionalLight("#ffe8c7", 2.2);
    key.position.set(-0.6, 0.8, -0.5);
    scene.add(key);
    const splat = new SplatMesh({ url: ${JSON.stringify(`/${assetRelativePath}`)}, maxSh: 0 });
    scene.add(splat);
    await splat.initialized;
    const bounds = splat.getBoundingBox(true);
    const context = renderer.getContext();
    let renderedFrames = 0;
    let activeFrames = 0;
    renderer.setAnimationLoop(() => {
      renderer.render(scene, camera);
      renderedFrames += 1;
      activeFrames = spark.activeSplats > 0 ? activeFrames + 1 : 0;
      if (activeFrames < 2) return;
      renderer.setAnimationLoop(null);
      window.__sparkQa = {
        status: "ready",
        numSplats: splat.numSplats,
        initialized: splat.isInitialized,
        renderedFrames,
        activeSplats: spark.activeSplats,
        bounds: {
          min: bounds.min.toArray(),
          max: bounds.max.toArray(),
        },
        renderer: context.getParameter(context.RENDERER),
        webglVersion: context instanceof WebGL2RenderingContext ? 2 : 1,
        canvas: { width: renderer.domElement.width, height: renderer.domElement.height },
      };
    });
  } catch (error) {
    window.__sparkQa = { status: "error", error: String(error?.stack || error) };
  }
</script>
</body>
</html>`;
}

async function runSparkQa(assetPath, expectedSplats, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const qaRoot = options.qaRoot ?? QA_ROOT;
  const previewPath = options.previewPath ?? PREVIEW_PATH;
  const previewPersisted = options.previewPersisted !== false;
  const assetRelativePath = relativePath(assetPath, repositoryRoot);
  const htmlPath = resolve(qaRoot, "spark-check.html");
  writeFileSync(htmlPath, sparkQaHtml(assetRelativePath));
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const qaUrl = `http://127.0.0.1:${vitePort}/${relativePath(htmlPath, repositoryRoot)}`;
  const profile = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-qa-"));
  const vite = spawn(
    resolve(repositoryRoot, "node_modules/.bin/vite"),
    ["--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const chrome = spawn(browserExecutable(), [
    "--headless=new",
    "--disable-gpu-sandbox",
    "--enable-webgl",
    "--hide-scrollbars",
    "--disable-extensions",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });
  const logs = [];
  vite.stdout.on("data", (chunk) => logs.push(String(chunk)));
  vite.stderr.on("data", (chunk) => logs.push(String(chunk)));
  let cdp;
  try {
    await waitForHttp(qaUrl);
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);
    const target = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(qaUrl)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 960,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const sparkResult = await pollValue(
      cdp,
      "window.__sparkQa?.status === 'ready' ? window.__sparkQa : (window.__sparkQa?.status === 'error' ? (() => { throw new Error(window.__sparkQa.error) })() : null)",
      "Spark decode",
    );
    assert(sparkResult.initialized === true, "Spark SplatMesh did not initialize");
    assert(sparkResult.numSplats === expectedSplats, "Spark decoded an unexpected splat count");
    assert(sparkResult.activeSplats > 0, "Spark produced no active splats after depth sorting");
    await delay(1_000);
    const canvasDataUrl = await Promise.race([
      cdp.evaluate("document.querySelector('canvas')?.toDataURL('image/png') || null"),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Spark QA canvas readback timed out")),
        30_000,
      )),
    ]);
    assert(typeof canvasDataUrl === "string" && canvasDataUrl.startsWith("data:image/png;base64,"),
      "Spark QA canvas did not return PNG pixels");
    writeFileSync(previewPath, Buffer.from(canvasDataUrl.slice("data:image/png;base64,".length), "base64"));
    const image = sharp(previewPath);
    const [metadata, statistics, subjectRaw] = await Promise.all([
      image.metadata(),
      image.stats(),
      sharp(previewPath)
        .extract({ left: 200, top: 100, width: 560, height: 520 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
    const channelStandardDeviations = statistics.channels
      .slice(0, 3)
      .map((channel) => channel.stdev);
    const subjectChannels = subjectRaw.info.channels;
    const subjectPixels = subjectRaw.info.width * subjectRaw.info.height;
    const subjectSums = [0, 0, 0];
    const subjectSquareSums = [0, 0, 0];
    let subjectNonBackgroundPixels = 0;
    for (let pixel = 0; pixel < subjectPixels; pixel += 1) {
      let backgroundDistance = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = subjectRaw.data[pixel * subjectChannels + channel];
        subjectSums[channel] += value;
        subjectSquareSums[channel] += value * value;
        backgroundDistance += Math.abs(value - [49, 68, 61][channel]);
      }
      if (backgroundDistance > 30) subjectNonBackgroundPixels += 1;
    }
    const subjectStandardDeviations = subjectSums.map((sum, channel) => {
      const mean = sum / subjectPixels;
      return Math.sqrt(Math.max(0, subjectSquareSums[channel] / subjectPixels - mean * mean));
    });
    const subjectMeanStandardDeviation = subjectStandardDeviations
      .reduce((sum, value) => sum + value, 0) / subjectStandardDeviations.length;
    const subjectNonBackgroundFraction = subjectNonBackgroundPixels / subjectPixels;
    assert(metadata.width === 960 && metadata.height === 960, "Spark QA screenshot size changed");
    assert(subjectMeanStandardDeviation > 10, "Spark QA subject region appears blank or visually degenerate");
    assert(subjectNonBackgroundFraction > 0.15, "Spark QA subject region contains too few visible splat pixels");
    return Object.freeze({
      ...sparkResult,
      rendered: true,
      screenshot: {
        ...(previewPersisted
          ? { relative_path: relativePath(previewPath, repositoryRoot), persisted: true }
          : { relative_path: null, persisted: false, temporary: true }),
        bytes: statSync(previewPath).size,
        sha256: sha256File(previewPath),
        width: metadata.width,
        height: metadata.height,
        rgb_standard_deviation: channelStandardDeviations,
        subject_crop_rgb_standard_deviation: subjectStandardDeviations,
        subject_crop_non_background_fraction: subjectNonBackgroundFraction,
      },
    });
  } catch (error) {
    throw new Error(`${error.message}\n${logs.join("").slice(-4_000)}`);
  } finally {
    cdp?.close();
    await Promise.all([stopProcess(vite), stopProcess(chrome)]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}

export async function verifyRealityTwinAsset(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const evidencePath = resolve(options.evidencePath
    ?? join(repositoryRoot, "video/public/reality-twin/asset-evidence.json"));
  const canonicalQaRoot = resolve(options.qaRoot
    ?? join(repositoryRoot, "artifacts/reality-twin/qa"));
  const canonicalPreviewPath = resolve(options.previewPath
    ?? join(canonicalQaRoot, "spark-render.png"));
  const checkOnly = options.checkOnly === true;
  const checkOnlyQaParent = resolve(options.checkOnlyQaParent
    ?? join(repositoryRoot, "artifacts/reality-twin"));
  assert(existsSync(evidencePath), `Asset evidence is missing: ${evidencePath}`);
  mkdirSync(checkOnly ? checkOnlyQaParent : canonicalQaRoot, { recursive: true });
  const qaRoot = checkOnly
    ? mkdtempSync(join(checkOnlyQaParent, "asset-check-only-"))
    : canonicalQaRoot;
  const previewPath = checkOnly ? join(qaRoot, "spark-render.png") : canonicalPreviewPath;
  let result;
  try {
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert(
      evidence.schema === "semaframe.reality-twin-asset-evidence.v1",
      "Asset evidence schema is unsupported",
    );
    const assetPath = resolve(repositoryRoot, evidence.output.relative_path);
    assert(existsSync(assetPath), `Prepared asset is missing: ${assetPath}`);
    assert(statSync(assetPath).size === evidence.output.bytes, "Prepared asset byte length changed");
    assert(sha256File(assetPath) === evidence.output.sha256, "Prepared asset digest changed");
    assert(evidence.output.bytes <= REALITY_TWIN_MAX_ASSET_BYTES, "Prepared asset exceeds Semaframe byte limit");
    assert(evidence.conversion.splat_count <= REALITY_TWIN_MAX_SPLAT_COUNT, "Prepared asset exceeds Semaframe splat limit");

    options.log?.("[1/2] Running current Semaframe untrusted-PLY preflight...");
    const preflightRunner = options.preflightRunner ?? runCurrentPreflight;
    const preflight = await preflightRunner(assetPath, qaRoot, repositoryRoot);
    const descriptor = preflight.descriptor;
    assert(descriptor.format === "ply", "Current preflight did not identify PLY");
    assert(descriptor.model === "gaussian-3d", "Current preflight did not identify 3D Gaussians");
    assert(descriptor.splatCount === evidence.conversion.splat_count, "Preflight splat count changed");
    assert(descriptor.byteLength === evidence.output.bytes, "Preflight byte length changed");
    assert(descriptor.digest === `sha256:${evidence.output.sha256}`, "Preflight digest changed");
    assert(descriptor.sphericalHarmonicsDegree === 0, "Preflight SH degree changed");
    assert(descriptor.engineeringAuthority === "visual_only", "Reality truth boundary changed");

    options.log?.("[2/2] Decoding and rendering the full asset through Spark in Chromium...");
    const sparkRunner = options.sparkRunner ?? runSparkQa;
    const spark = await sparkRunner(assetPath, evidence.conversion.splat_count, {
      repositoryRoot,
      qaRoot,
      previewPath,
      previewPersisted: !checkOnly,
    });
    assert(spark.initialized === true, "Spark SplatMesh did not initialize");
    assert(spark.numSplats === evidence.conversion.splat_count,
      "Spark decoded an unexpected splat count");
    assert(spark.activeSplats === evidence.conversion.splat_count,
      "Spark did not activate every prepared splat");
    assert(spark.rendered === true && spark.webglVersion === 2,
      "Spark did not produce the required WebGL2 render");
    const sparkVersion = options.sparkPackageVersion ?? JSON.parse(readFileSync(
      resolve(repositoryRoot, "node_modules/@sparkjsdev/spark/package.json"),
      "utf8",
    )).version;
    const validation = {
      status: "passed",
      command: checkOnly
        ? "node scripts/verify-reality-twin-asset.mjs --check-only"
        : "node scripts/verify-reality-twin-asset.mjs",
      semaframe_current_preflight: preflight,
      spark_browser_import: {
        package: "@sparkjsdev/spark",
        version: sparkVersion,
        initialized: spark.initialized,
        decoded_splats: spark.numSplats,
        active_splats: spark.activeSplats,
        decoded_bounds: spark.bounds,
        rendered_frames: spark.renderedFrames,
        renderer: spark.renderer,
        webgl_version: spark.webglVersion,
        rendered: spark.rendered,
        screenshot: spark.screenshot,
      },
      assertions: [
        "Current host preflight accepted the exact 84 MB binary PLY and recomputed its pinned SHA-256.",
        "Current host preflight classified 1.5M records as gaussian-3d with SH degree 0 and visual_only authority.",
        "Spark decoded all 1.5M splats in Chromium and produced a non-blank WebGL render.",
        "The output remains within Semaframe's inclusive 256 MiB and 4M-splat host limits.",
      ],
    };
    if (checkOnly) {
      assertPersistedAssetVerificationMatchesFresh(evidence.validation, validation);
    } else {
      evidence.validation = validation;
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    result = {
      status: "passed",
      mode: checkOnly ? "check-only" : "update-evidence",
      asset: relativePath(assetPath, repositoryRoot),
      digest: descriptor.digest,
      splats: descriptor.splatCount,
      preflight: descriptor.model,
      spark: {
        version: sparkVersion,
        initialized: spark.initialized,
        decodedSplats: spark.numSplats,
        activeSplats: spark.activeSplats,
        rendered: spark.rendered,
        renderer: spark.renderer,
        screenshotSha256: spark.screenshot.sha256,
      },
      preview: checkOnly ? { persisted: false, path: null } : relativePath(previewPath, repositoryRoot),
      evidence: relativePath(evidencePath, repositoryRoot),
      evidenceModified: !checkOnly,
    };
  } finally {
    if (checkOnly) rmSync(qaRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
  return {
    ...result,
    checkOnlyQaWorkdirRemoved: checkOnly ? !existsSync(qaRoot) : undefined,
  };
}

export function parseAssetVerifierArguments(args) {
  const unsupported = args.filter((argument) => argument !== "--check-only");
  assert(unsupported.length === 0, `Unsupported asset-verifier arguments: ${unsupported.join(" ")}`);
  return { checkOnly: args.includes("--check-only") };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const options = parseAssetVerifierArguments(process.argv.slice(2));
    const result = await verifyRealityTwinAsset({ ...options, log: console.log });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Reality Twin asset verification FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
