import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import sharp from "sharp";
import {
  CAPTURE_EVIDENCE_FORMAT,
  CAPTURE_EVIDENCE_VERSION,
  chromeGpuArguments,
  dimensionResidualWithin,
  dimensionsFromBounds,
  invariant,
  loadRealityTwinFixture,
  maximumDimensionDelta,
  parseProcessTable,
  protectiveCaseGeometry,
  publishedModelReceipts,
  prepareCaptureOutputs,
  promoteCaptureOutputsAfterCleanup,
  profileRelatedProcessIds,
  resolveCaptureOutputPlan,
  resolveCaptureAsset,
  runUsdChecker,
  sha256,
  signedDimensionResidual,
  validateCaptureEvidence,
  writeFileAtomically,
} from "./reality-twin-capture-core.mjs";

const fixture = loadRealityTwinFixture();
const smokeFrameCount = process.env.REALITY_TWIN_SMOKE_FRAME_COUNT === undefined
  ? undefined
  : Number(process.env.REALITY_TWIN_SMOKE_FRAME_COUNT);
invariant(smokeFrameCount === undefined || (Number.isSafeInteger(smokeFrameCount) && smokeFrameCount >= 8 && smokeFrameCount <= 30),
  "REALITY_TWIN_SMOKE_FRAME_COUNT must be an integer from 8 through 30.");
const captureRunId = `reality-twin-${randomUUID()}`;
const outputPlan = resolveCaptureOutputPlan({ smokeFrameCount, runId: captureRunId });
const publicRoot = outputPlan.publicRoot;
const captureRoot = outputPlan.captureRoot;
const artifactRoot = outputPlan.artifactRoot;

function targetFrameCount(folder) {
  const contractCount = fixture.capture.sequenceFrameCounts[folder];
  invariant(Number.isSafeInteger(contractCount) && contractCount > 0, `No frame contract exists for ${folder}.`);
  return smokeFrameCount ?? contractCount;
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function browserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  invariant(executable, "Chrome/Chromium was not found. Set BROWSER_EXECUTABLE.");
  return executable;
}

function monitorChild(child, label) {
  let resolveFailure;
  let resolveExit;
  const state = {
    child,
    label,
    stopping: false,
    exited: false,
    failure: new Promise((resolveFailurePromise) => { resolveFailure = resolveFailurePromise; }),
    exit: new Promise((resolveExitPromise) => { resolveExit = resolveExitPromise; }),
  };
  child.once("error", (error) => {
    state.exited = true;
    resolveExit();
    if (!state.stopping) resolveFailure(new Error(`${label} failed to start: ${error.message}`, { cause: error }));
  });
  child.once("exit", (code, signal) => {
    state.exited = true;
    resolveExit();
    if (!state.stopping) resolveFailure(new Error(`${label} exited before capture completion (code=${code}, signal=${signal ?? "none"}).`));
  });
  return state;
}

function signalManagedChild(monitor, signal) {
  const pid = monitor?.child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || monitor.exited) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try {
    monitor.child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopManagedChild(monitor) {
  if (!monitor) return;
  monitor.stopping = true;
  signalManagedChild(monitor, "SIGTERM");
  if (!monitor.exited) await Promise.race([monitor.exit, delay(3_000)]);
  if (!monitor.exited) {
    signalManagedChild(monitor, "SIGKILL");
    await Promise.race([monitor.exit, delay(2_000)]);
  }
  invariant(monitor.exited, `${monitor.label} did not exit after SIGTERM/SIGKILL cleanup.`);
}

function readProcessRows() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  invariant(!result.error && result.status === 0, `Could not inspect browser cleanup state: ${result.error?.message ?? result.stderr}`);
  return parseProcessTable(result.stdout);
}

function profileProcessSnapshot(profile, knownPids) {
  const rows = readProcessRows();
  for (const pid of profileRelatedProcessIds(rows, profile)) knownPids.add(pid);
  const livePids = new Set(rows.map((row) => row.pid));
  return [...knownPids].filter((pid) => livePids.has(pid));
}

function signalExactPids(pids, signal) {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function stopCaptureBrowser(monitor, profile) {
  if (!profile) {
    await stopManagedChild(monitor);
    return { stoppedPids: [], profileProcessesRemaining: 0 };
  }
  if (monitor) monitor.stopping = true;
  const knownPids = new Set();
  if (monitor && !monitor.exited && Number.isSafeInteger(monitor.child?.pid)) knownPids.add(monitor.child.pid);
  let livePids = profileProcessSnapshot(profile, knownPids);
  signalManagedChild(monitor, "SIGTERM");
  signalExactPids(livePids, "SIGTERM");
  const termDeadline = Date.now() + 3_000;
  while (Date.now() < termDeadline) {
    await delay(100);
    livePids = profileProcessSnapshot(profile, knownPids);
    if (livePids.length === 0) break;
  }
  if (livePids.length > 0) {
    signalManagedChild(monitor, "SIGKILL");
    signalExactPids(livePids, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline) {
      await delay(100);
      livePids = profileProcessSnapshot(profile, knownPids);
      if (livePids.length === 0) break;
    }
  }
  const remainingProfilePids = profileRelatedProcessIds(readProcessRows(), profile);
  invariant(livePids.length === 0 && remainingProfilePids.length === 0,
    `Capture browser cleanup left profile-bound processes: ${JSON.stringify({ profile, livePids, remainingProfilePids })}`);
  return { stoppedPids: [...knownPids].sort((a, b) => a - b), profileProcessesRemaining: 0 };
}

function failOnUnexpectedChildExit(monitors) {
  return Promise.race(monitors.map((monitor) => monitor.failure)).then((error) => { throw error; });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
    } catch { /* still starting */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.scriptParsed = [];
  }

  async connect() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method === "Debugger.scriptParsed") this.scriptParsed.push(message.params);
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => this.listeners.set(method, (this.listeners.get(method) ?? []).filter((item) => item !== listener));
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function poll(cdp, expression, label, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await cdp.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function clickExactButton(text) {
  return `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

function clickButtonWithAriaLabel(label) {
  return `(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

async function setNativeValue(cdp, selector, value) {
  return cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) return false;
    const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value === ${JSON.stringify(String(value))};
  })()`);
}

function agentPayload(result, toolName) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object" && typeof structured.ok === "boolean") return structured;
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof text === "string") {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
  }
  throw new Error(`MCP tool ${toolName} returned no SemaFrame payload.`);
}

async function callAgent(client, name, args) {
  return agentPayload(await client.callTool({ name, arguments: args }), name);
}

function world(x, y, z) {
  return {
    space: "world3d",
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function material(baseColor, options = {}) {
  return {
    baseColor,
    metallic: options.metallic ?? 0.15,
    roughness: options.roughness ?? 0.48,
    opacity: options.opacity ?? 1,
    emissiveColor: options.emissiveColor ?? "#000000",
    emissiveIntensity: options.emissiveIntensity ?? 0,
  };
}

const disabledPhysics = Object.freeze({
  enabled: false,
  bodyType: "static",
  massKg: 1,
  centerOfMass: { x: 0, y: 0, z: 0 },
  friction: 0.6,
  restitution: 0.1,
  gravityScale: 1,
  stabilityMode: "report",
  constraints: [],
});

const solidCollision = Object.freeze({ enabled: true, role: "solid", shape: "asset_bounds", margin: 0 });

function componentRef(manifest, typeId) {
  const entry = manifest.component_types.find((candidate) => candidate.typeId === typeId);
  invariant(entry, `Missing component manifest ${typeId}.`);
  return { typeId: entry.typeId, version: entry.version, digest: entry.digest };
}

function primitive({ id, label, geometry, placement, parentId, color, opacity, metallic, roughness, collision, visibility }) {
  return {
    op: "create_component",
    op_id: `create_${id}`,
    id,
    label,
    component_type: null,
    props: {
      geometry,
      material: material(color, { opacity, metallic, roughness }),
      collision: collision ?? solidCollision,
      physics: disabledPhysics,
      castShadow: true,
      receiveShadow: true,
    },
    placement,
    ...(parentId ? { parent_id: parentId } : {}),
    ...(visibility ? { visibility } : {}),
  };
}

async function captureBuffer(cdp, format = "png", quality) {
  const result = await cdp.send("Page.captureScreenshot", {
    format,
    ...(quality === undefined ? {} : { quality }),
    fromSurface: true,
    captureBeyondViewport: false,
  });
  return Buffer.from(result.data, "base64");
}

async function capture(cdp, filename) {
  writeFileSync(join(captureRoot, filename), await captureBuffer(cdp));
}

function frameDirectory(folder) {
  const directory = join(captureRoot, folder);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

async function captureJpeg(cdp, directory, index) {
  writeFileSync(
    join(directory, `frame-${String(index).padStart(4, "0")}.jpg`),
    await captureBuffer(cdp, "jpeg", 88),
  );
}

async function orbitNudge(cdp, direction = 1) {
  const rect = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return undefined;
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  })()`);
  invariant(rect, "3D canvas was not available for an authentic camera nudge.");
  const startX = rect.left + rect.width * 0.42;
  const startY = rect.top + rect.height * 0.48;
  const endX = startX + direction * 14;
  const endY = startY + 3;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: endX, y: endY, button: "left", buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: endY, button: "left", buttons: 0, clickCount: 1 });
  await delay(120);
}

async function orbitCameraWithPointer(cdp, travelRatio = 0.11) {
  const rect = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return undefined;
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  })()`);
  invariant(rect, "3D canvas was unavailable for the authentic width-view orbit.");
  const startX = rect.left + rect.width * 0.47;
  const startY = rect.top + rect.height * 0.50;
  const travel = rect.width * travelRatio;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", buttons: 1, clickCount: 1 });
  try {
    for (let step = 1; step <= 8; step += 1) {
      const progress = step / 8;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + travel * progress,
        y: startY - Math.sin(progress * Math.PI) * 10,
        button: "left",
        buttons: 1,
      });
      await delay(45);
    }
  } finally {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: startX + travel, y: startY, button: "left", buttons: 0, clickCount: 1 });
  }
  await delay(750);
}

async function captureStableFrames(cdp, folder, frameCount = targetFrameCount(folder), frameDelayMs = 64) {
  const directory = frameDirectory(folder);
  for (let index = 0; index < frameCount; index += 1) {
    await captureJpeg(cdp, directory, index);
    if (index + 1 < frameCount) await delay(frameDelayMs);
  }
}

async function captureDuring(cdp, folder, action, options = {}) {
  const directory = frameDirectory(folder);
  const frameCount = targetFrameCount(folder);
  const requestedActionAt = options.actionAt ?? Math.max(2, Math.floor(frameCount * 0.22));
  // Even the eight-frame smoke must retain post-action frames for visual QA;
  // the full contracts keep their explicitly requested earlier action point.
  const actionAt = Math.min(frameCount - 3, requestedActionAt);
  const requiredTransitions = Math.max(2, Math.ceil((frameCount - 1) * 0.04));
  const nudgeCount = actionAt + 1 < frameCount ? Math.max(0, requiredTransitions - 1) : 0;
  const nudgeIndices = new Set(Array.from({ length: nudgeCount }, (_, index) => (
    actionAt + Math.max(1, Math.floor(((index + 1) * (frameCount - actionAt - 1)) / (nudgeCount + 1)))
  )));
  for (let index = 0; index < frameCount; index += 1) {
    if (index === actionAt) {
      await action();
      await delay(options.settleMs ?? 500);
    }
    if (nudgeIndices.has(index)) await orbitNudge(cdp, index % 2 === 0 ? 1 : -1);
    await captureJpeg(cdp, directory, index);
    await delay(options.frameDelayMs ?? 72);
  }
}

async function captureStages(cdp, folder, stages, options = {}) {
  invariant(Array.isArray(stages) && stages.length > 0, `${folder} has no genuine stages.`);
  const directory = frameDirectory(folder);
  const frameCount = targetFrameCount(folder);
  const stateCount = stages.length + 1;
  const base = Math.floor(frameCount / stateCount);
  const remainder = frameCount % stateCount;
  let frameIndex = 0;
  const captureState = async (count, stateIndex) => {
    for (let index = 0; index < count; index += 1) {
      if (count >= 3
        && index === Math.floor(count / 2)
        && (stateIndex > 0 || options.nudgeInitialState !== false)) {
        await orbitNudge(cdp, stateIndex % 2 === 0 ? 1 : -1);
      }
      await captureJpeg(cdp, directory, frameIndex++);
      if (index + 1 < count) await delay(options.frameDelayMs ?? 64);
    }
  };
  await captureState(base + (remainder > 0 ? 1 : 0), 0);
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    await stages[stageIndex]();
    await delay(options.settleMs ?? 420);
    await captureState(base + (stageIndex + 1 < remainder ? 1 : 0), stageIndex + 1);
  }
  invariant(frameIndex === frameCount, `${folder} wrote ${frameIndex}/${frameCount} frames.`);
}

async function captureOrbit(cdp, folder, options = {}) {
  const directory = frameDirectory(folder);
  const frameCount = targetFrameCount(folder);
  const rect = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return undefined;
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  })()`);
  invariant(rect, "3D canvas was not available for orbit capture.");
  const startX = rect.left + rect.width * (options.startXRatio ?? 0.47);
  const startY = rect.top + rect.height * (options.startYRatio ?? 0.5);
  const travel = rect.width * (options.travelRatio ?? 0.11);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", buttons: 1, clickCount: 1 });
  try {
    for (let index = 0; index < frameCount; index += 1) {
      const progress = frameCount === 1 ? 1 : index / (frameCount - 1);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + travel * progress,
        y: startY - Math.sin(progress * Math.PI) * 22,
        button: "left",
        buttons: 1,
      });
      await delay(42);
      await captureJpeg(cdp, directory, index);
    }
  } finally {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: startX + travel, y: startY, button: "left", buttons: 0, clickCount: 1 });
  }
}

function frameCountFor(folder) {
  const directory = join(captureRoot, folder);
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => /^frame-\d{4}\.jpg$/u.test(name)).length
    : 0;
}

async function frameAll(cdp) {
  invariant(await cdp.evaluate(clickButtonWithAriaLabel("Frame all")), "Frame-all control was unavailable.");
  await delay(1_000);
}

async function zoomIn(cdp, repetitions = 3) {
  for (let index = 0; index < repetitions; index += 1) {
    invariant(await cdp.evaluate(clickButtonWithAriaLabel("Zoom in")), "Zoom-in control was unavailable.");
    await delay(140);
  }
  await delay(300);
}

async function focusScan(cdp) {
  await frameAll(cdp);
  await zoomIn(cdp, 9);
}

async function resetView(cdp) {
  invariant(await cdp.evaluate(clickButtonWithAriaLabel("Reset view")), "Reset-view control was unavailable.");
  await delay(700);
}

async function clearWorkspaceSelection(cdp) {
  const point = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return undefined;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + 36, y: rect.top + 118 };
  })()`);
  invariant(point, "3D canvas was unavailable for clearing selection.");
  await canvasPointerClick(cdp, point.x, point.y);
  await delay(300);
}

async function mouseClick(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function canvasPointerClick(cdp, x, y) {
  const dispatched = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const init = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1,
      clientX: ${JSON.stringify(x)}, clientY: ${JSON.stringify(y)} };
    canvas.dispatchEvent(new PointerEvent('pointerdown', init));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    return true;
  })()`);
  invariant(dispatched, "Canvas pointer event could not be dispatched.");
}

const requestedScopes = Object.freeze([
  "workspace:read",
  "workspace:write",
  "workspace:history",
  "component:create",
  "component:update",
  "asset:import",
]);

async function authorizeWorkspace(cdp, label, captures = {}) {
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", `${label} disabled connection gate`);
  invariant(await cdp.evaluate(clickExactButton("Enable agent control")), `${label} could not enable Agent control.`);
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-waiting'))", `${label} waiting connection gate`);
  const connectionUrl = await cdp.evaluate("document.querySelector('.agent-connection-url-wrap input')?.value");
  invariant(typeof connectionUrl === "string", `${label} connection URL was not rendered.`);
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.agent-connection-url-wrap input');
    if (input instanceof HTMLInputElement) input.value = 'http://127.0.0.1:8788/mcp/connect/••••••••';
  })()`);
  if (captures.connection) await capture(cdp, captures.connection);

  const client = new Client({ name: label, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connectionUrl)));
  const pending = await callAgent(client, "get_workspace_instructions", {
    client_id: label,
    client_name: label,
    requested_scopes: requestedScopes,
  });
  const approvalToken = pending.error?.details?.approval_token;
  invariant(pending.ok === false && pending.error?.code === "approval_pending" && typeof approvalToken === "string",
    `${label} did not enter approval_pending.`);
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-approval'))", `${label} approval card`);
  if (captures.approval) await capture(cdp, captures.approval);
  invariant(await cdp.evaluate(clickExactButton("Approve client")), `${label} could not approve the Agent.`);
  await poll(cdp, "!document.querySelector('.agent-connection-page.status-approval')", `${label} approved handoff`);
  const instructions = await callAgent(client, "get_workspace_instructions", {
    client_id: label,
    client_name: label,
    requested_scopes: requestedScopes,
    approval_token: approvalToken,
  });
  invariant(instructions.ok, `${label} handshake failed: ${instructions.error?.code}`);
  for (const scope of requestedScopes) {
    invariant(instructions.data.granted_scopes.includes(scope), `${label} was not granted ${scope}.`);
  }
  await poll(cdp, "document.querySelector('.hybrid-workspace-canvas')?.dataset.sceneEngineReady === 'true'", `${label} renderer ready`, 30_000);
  await poll(cdp, "Boolean(document.querySelector('.agent-workspace-controls.status-connected'))", `${label} Workspace connected`);
  return {
    client,
    session: {
      session_token: instructions.data.session_token,
      instruction_digest: instructions.data.guide_digest,
    },
    grantedScopes: instructions.data.granted_scopes,
  };
}

async function captureWorkspaceProject(cdp, key) {
  await cdp.evaluate(`(() => {
    window.__realityTwinSavedProjects ??= {};
    window.__realityTwinSaveKey = ${JSON.stringify(key)};
    delete window.__realityTwinSavedProjects[window.__realityTwinSaveKey];
    if (!window.__realityTwinObjectUrlHooked) {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (value) => {
        const saveKey = window.__realityTwinSaveKey;
        if (saveKey && value instanceof Blob) {
          void value.text().then((contents) => { window.__realityTwinSavedProjects[saveKey] = contents; });
        }
        return createObjectURL(value);
      };
      window.__realityTwinObjectUrlHooked = true;
    }
    document.querySelector('button[aria-label="Save project"]')?.click();
  })()`);
  await poll(cdp, `Boolean(window.__realityTwinSavedProjects?.[${JSON.stringify(key)}])`, `captured ${key} project`);
  return cdp.evaluate(`window.__realityTwinSavedProjects[${JSON.stringify(key)}]`);
}

async function installArtifactCapture(cdp) {
  await cdp.evaluate(`(() => {
    window.__realityTwinArtifacts = {};
    window.__realityTwinBlobs = new Map();
    if (!window.__realityTwinArtifactHooked) {
      const createObjectURL = URL.createObjectURL.bind(URL);
      const nativeClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (value) => {
        const url = createObjectURL(value);
        if (value instanceof Blob) window.__realityTwinBlobs.set(url, value);
        return url;
      };
      HTMLAnchorElement.prototype.click = function click() {
        const blob = window.__realityTwinBlobs.get(this.href);
        const filename = this.download;
        if (blob instanceof Blob && filename) {
          void blob.text().then((contents) => {
            window.__realityTwinArtifacts[filename] = { contents, byteLength: blob.size, type: blob.type };
          });
        }
        return nativeClick.call(this);
      };
      window.__realityTwinArtifactHooked = true;
    }
    return true;
  })()`);
}

async function capturedUsda(cdp, timeoutMs = 120_000) {
  await poll(
    cdp,
    'Object.keys(window.__realityTwinArtifacts ?? {}).some((name) => name.endsWith(".usda"))',
    "USDA download",
    timeoutMs,
  );
  return cdp.evaluate(`(() => {
    const name = Object.keys(window.__realityTwinArtifacts).find((candidate) => candidate.endsWith('.usda'));
    return name ? { name, ...window.__realityTwinArtifacts[name] } : undefined;
  })()`);
}

async function locateRealityMeasurementScript(cdp, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const candidates = cdp.scriptParsed.filter((script) => /\/src\/renderer\/ThreeRenderer\.ts(?:\?|$)/u.test(script.url));
    for (const candidate of candidates.reverse()) {
      const source = await cdp.send("Debugger.getScriptSource", { scriptId: candidate.scriptId });
      const marker = "const first = session.points[0]";
      const offset = source.scriptSource.indexOf(marker);
      if (offset < 0) continue;
      const lineNumber = source.scriptSource.slice(0, offset).split("\n").length - 1;
      return { scriptId: candidate.scriptId, url: candidate.url, lineNumber };
    }
    await delay(100);
  }
  throw new Error("Could not locate the live ThreeRenderer measurement callback for read-only point receipts.");
}

async function installMeasurementReceiptProbe(cdp) {
  const location = await locateRealityMeasurementScript(cdp);
  const breakpoint = await cdp.send("Debugger.setBreakpoint", {
    location: { scriptId: location.scriptId, lineNumber: location.lineNumber, columnNumber: 0 },
  });
  const points = [];
  const removeListener = cdp.on("Debugger.paused", (params) => {
    void (async () => {
      try {
        const frame = params.callFrames?.find((candidate) => candidate.location.scriptId === location.scriptId)
          ?? params.callFrames?.[0];
        if (frame) {
          const evaluated = await cdp.send("Debugger.evaluateOnCallFrame", {
            callFrameId: frame.callFrameId,
            expression: "({ sourcePoint: point.sourcePoint, worldPoint: point.worldPoint, cameraDistance: point.cameraDistance, fidelity: point.fidelity, sessionId: session.sessionId })",
            returnByValue: true,
            silent: true,
          });
          const value = evaluated.result?.value;
          if (value?.sourcePoint && value?.fidelity === "gaussian-lod") points.push(value);
        }
      } finally {
        await cdp.send("Debugger.resume").catch(() => undefined);
      }
    })();
  });
  return {
    points,
    reset: () => points.splice(0, points.length),
    dispose: async () => {
      removeListener();
      await cdp.send("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId }).catch(() => undefined);
    },
  };
}

async function imageDifferenceBounds(beforePng, afterPng, clip = {}) {
  const before = await sharp(beforePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await sharp(afterPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  invariant(before.info.width === after.info.width && before.info.height === after.info.height, "Selection screenshots changed dimensions.");
  const { width, height, channels } = before.info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  const startY = Math.max(70, Math.floor(clip.minY ?? 70));
  const endY = Math.min(height - 100, Math.ceil(clip.maxY ?? height - 100));
  const startX = Math.max(20, Math.floor(clip.minX ?? 20));
  const endX = Math.min(width - 20, Math.ceil(clip.maxX ?? width - 20));
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * width + x) * channels;
      const delta = Math.abs(before.data[offset] - after.data[offset])
        + Math.abs(before.data[offset + 1] - after.data[offset + 1])
        + Math.abs(before.data[offset + 2] - after.data[offset + 2]);
      if (delta < 70) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
    }
  }
  invariant(count >= 24 && maxX > minX && maxY > minY, "Could not detect the selected Reality bounds in the genuine screenshots.");
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, changedPixelCount: count };
}

async function selectRealityAndMeasureOutline(cdp) {
  invariant(await cdp.evaluate(clickExactButton("Reality")), "Reality panel was unavailable.");
  await poll(cdp, "Boolean(document.querySelector('.workspace-reality-card'))", "Reality asset card", 20_000);
  invariant(await cdp.evaluate(clickExactButton("Select 1")), "Reality instance could not be selected.");
  invariant(await cdp.evaluate(clickButtonWithAriaLabel("Close reality panel")), "Reality panel could not be closed.");
  invariant(await cdp.evaluate(clickExactButton("Inspector")), "Inspector panel was unavailable after Reality selection.");
  await poll(cdp, "Boolean(document.querySelector('.workspace-inspector__reality'))", "selected Reality Inspector");
  const canvasRect = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return undefined;
    const rect = canvas.getBoundingClientRect();
    const panel = document.querySelector('#workspace-tool-panel');
    const panelRect = panel instanceof HTMLElement ? panel.getBoundingClientRect() : undefined;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      contentRight: panelRect ? Math.min(rect.right, panelRect.left - 8) : rect.right,
    };
  })()`);
  invariant(canvasRect, "Reality canvas bounds were unavailable.");
  await canvasPointerClick(cdp, canvasRect.left + 28, canvasRect.top + 110);
  await poll(cdp, "!document.querySelector('.workspace-inspector__reality')", "cleared Reality selection");
  const before = await captureBuffer(cdp);
  invariant(await cdp.evaluate(clickExactButton("Reality")), "Reality panel was unavailable for reselection.");
  await poll(cdp, "Boolean(document.querySelector('.workspace-reality-card'))", "Reality asset card for reselection", 20_000);
  invariant(await cdp.evaluate(clickExactButton("Select 1")), "Reality instance could not be reselected.");
  invariant(await cdp.evaluate(clickButtonWithAriaLabel("Close reality panel")), "Reality panel could not be closed after reselection.");
  invariant(await cdp.evaluate(clickExactButton("Inspector")), "Inspector panel was unavailable after Reality reselection.");
  await poll(cdp, "Boolean(document.querySelector('.workspace-inspector__reality'))", "reselected Reality Inspector");
  await delay(300);
  const after = await captureBuffer(cdp);
  return imageDifferenceBounds(before, after, {
    minX: canvasRect.left,
    maxX: canvasRect.contentRight,
    minY: canvasRect.top,
    maxY: canvasRect.bottom,
  });
}

async function clickMeasurementCandidate(cdp, x, y, expectedState, timeoutMs = 2_500) {
  await mouseClick(cdp, x, y);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await cdp.evaluate("document.querySelector('.hybrid-workspace-canvas canvas')?.dataset.realityMeasurement");
    if (state === expectedState) return true;
    if (state === "complete" && expectedState === "complete") return true;
    await delay(60);
  }
  return false;
}

async function completedMeasurementReceipt(cdp, receiptProbe, label) {
  const waitStarted = Date.now();
  while (receiptProbe.points.length < 2 && Date.now() - waitStarted < 3_000) await delay(50);
  invariant(receiptProbe.points.length >= 2, `${label} points were not captured by the read-only debugger probe.`);
  // The read-only breakpoint is intentionally before the renderer's overlap
  // guard. A rejected, overlapping B probe can therefore appear between the
  // accepted A and the final complete B. The UI session's first and last hits
  // are the authoritative accepted pair once the canvas reports `complete`.
  const pointA = receiptProbe.points[0];
  const pointB = receiptProbe.points.at(-1);
  invariant(pointA.sessionId === pointB.sessionId, `${label} debugger points belong to different measurement sessions.`);
  const pointDistance = Math.hypot(
    pointA.sourcePoint.x - pointB.sourcePoint.x,
    pointA.sourcePoint.y - pointB.sourcePoint.y,
    pointA.sourcePoint.z - pointB.sourcePoint.z,
  );
  await poll(cdp, `(() => {
    const input = document.querySelector('input[aria-label="Source distance"]');
    return input instanceof HTMLInputElement
      && Number.isFinite(Number(input.value))
      && Math.abs(Number(input.value) - ${JSON.stringify(pointDistance)}) <= 1e-5;
  })()`, `${label} source-distance readout`);
  const sourceDistance = Number(await cdp.evaluate("document.querySelector('input[aria-label=\"Source distance\"]')?.value"));
  invariant(Math.abs(pointDistance - sourceDistance) <= 1e-5,
    `${label} debugger points do not match the visible source-distance readout: ${JSON.stringify({
      sessionId: pointA.sessionId,
      pointDistance,
      sourceDistance,
      pointA: pointA.sourcePoint,
      pointB: pointB.sourcePoint,
    })}`);
  invariant(await cdp.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Source distance"]');
    if (!(input instanceof HTMLInputElement)) return false;
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  })()`), `${label} source-distance readout could not be brought into view.`);
  await delay(250);
  return { pointA, pointB, sourceDistance };
}

async function performTwoPointCalibration(cdp, receiptProbe, outline, expectedSourceHeight, descriptorBounds) {
  if (!await cdp.evaluate("Boolean(document.querySelector('.workspace-inspector__reality'))")) {
    invariant(await cdp.evaluate(clickExactButton("Inspector")), "Inspector panel was unavailable for Reality calibration.");
  }
  await poll(cdp, "Boolean(document.querySelector('.workspace-inspector__reality'))", "Reality Inspector");
  const width = outline.width;
  const height = outline.height;
  // Pick the visually broad crest first, then probe the much thinner base
  // silhouette while point A remains active. A/B order has no effect on the
  // distance or scale, and this keeps every candidate a genuine UI raycast.
  const pointACandidates = [
    [0.56, 0.06],
    [0.56, 0.08],
    [0.58, 0.07],
    [0.60, 0.06],
    [0.58, 0.03],
    [0.60, 0.03],
    [0.62, 0.04],
    [0.64, 0.04],
    [0.66, 0.05],
    [0.68, 0.06],
    [0.70, 0.08],
    [0.60, 0.08],
    [0.58, 0.10],
    [0.65, 0.08],
  ];
  const pointBCandidates = [
    [0.46, 0.90],
    [0.45, 0.92],
    [0.44, 0.90],
    [0.47, 0.90],
    [0.48, 0.90],
    [0.45, 0.88],
    [0.44, 0.88],
    [0.47, 0.88],
    [0.48, 0.88],
    [0.46, 0.86],
    [0.43, 0.86],
    [0.49, 0.86],
    [0.43, 0.82],
    [0.40, 0.84],
    [0.50, 0.84],
    [0.38, 0.84],
    [0.30, 0.80],
    [0.26, 0.75],
    [0.62, 0.78],
    [0.66, 0.76],
  ];
  const attempts = [];
  const assessCandidate = ({ pointA, pointB, sourceDistance }) => {
    const minimum = fixture.physicalTruth.calibration.minimumAcceptedSourceSpanM;
    const maximum = fixture.physicalTruth.calibration.maximumAcceptedSourceSpanM;
    const sourceDelta = {
      x: Math.abs(pointA.sourcePoint.x - pointB.sourcePoint.x),
      y: Math.abs(pointA.sourcePoint.y - pointB.sourcePoint.y),
      z: Math.abs(pointA.sourcePoint.z - pointB.sourcePoint.z),
    };
    const candidateScale = fixture.physicalTruth.calibration.knownDistanceM / sourceDistance;
    const candidateScanDimensions = dimensionsFromBounds(descriptorBounds, candidateScale);
    const candidateScanResidual = signedDimensionResidual(candidateScanDimensions, fixture.physicalTruth.catalogDimensionsM);
    const heightDominates = sourceDelta.y >= sourceDelta.x && sourceDelta.y >= sourceDelta.z;
    const impliedMetricHeight = expectedSourceHeight
      * fixture.physicalTruth.calibration.knownDistanceM / sourceDistance;
    const rejectionReasonCodes = [];
    if (sourceDistance < minimum) rejectionReasonCodes.push("source_span_below_minimum");
    if (sourceDistance > maximum) rejectionReasonCodes.push("source_span_above_maximum");
    if (!heightDominates) rejectionReasonCodes.push("source_y_not_dominant");
    if (sourceDelta.y < expectedSourceHeight * 0.9) rejectionReasonCodes.push("source_y_below_90_percent_of_aabb_height");
    if (sourceDistance / sourceDelta.y > 1.2) rejectionReasonCodes.push("non_y_path_exceeds_ratio_limit");
    if (Math.abs(sourceDistance - expectedSourceHeight) > 0.02) rejectionReasonCodes.push("source_span_differs_from_aabb_height");
    if (Math.abs(impliedMetricHeight - fixture.physicalTruth.catalogDimensionsM.y)
      > fixture.physicalTruth.scanResidualToleranceM.y) {
      rejectionReasonCodes.push("implied_catalog_height_residual_exceeds_tolerance");
    }
    if (!dimensionResidualWithin(candidateScanResidual, fixture.physicalTruth.scanResidualToleranceM)) {
      rejectionReasonCodes.push("calibrated_scan_aabb_residual_exceeds_tolerance");
    }
    return {
      pointA,
      pointB,
      sourceDistance,
      sourceDelta,
      candidateScale,
      candidateScanDimensions,
      candidateScanResidual,
      rejectionReasonCodes,
      accepted: rejectionReasonCodes.length === 0,
    };
  };
  const rejectedCandidates = [];
  let acceptedCandidate;
  searchAcceptedPair:
  for (const [ax, ay] of pointACandidates) {
    let activePointA = false;
    for (const [bx, by] of pointBCandidates) {
      if (!activePointA) {
        receiptProbe.reset();
        const startLabel = await cdp.evaluate(`(() => [...document.querySelectorAll('button')]
          .some((button) => ['Pick two points', 'Restart two-point pick'].includes(button.textContent?.trim()) && !button.disabled))()`);
        invariant(startLabel, "Two-point calibration action was unavailable; the Gaussian may not be ready.");
        const started = await cdp.evaluate(clickExactButton("Pick two points"))
          || await cdp.evaluate(clickExactButton("Restart two-point pick"));
        invariant(started, "Could not start two-point Gaussian measurement.");
        await poll(cdp, "document.querySelector('.hybrid-workspace-canvas canvas')?.dataset.realityMeasurement === 'picking-point-a'", "point-A measurement mode");
        activePointA = await clickMeasurementCandidate(
          cdp,
          outline.minX + width * ax,
          outline.minY + height * ay,
          "picking-point-b",
          1_500,
        );
        if (!activePointA) {
          attempts.push({ ax, ay, pointAHit: false });
          break;
        }
      }
      const pointBHit = await clickMeasurementCandidate(
        cdp,
        outline.minX + width * bx,
        outline.minY + height * by,
        "complete",
        800,
      );
      if (!pointBHit) {
        attempts.push({ ax, ay, bx, by, pointAHit: true, pointBHit: false });
        continue;
      }
      activePointA = false;
      const receipt = await completedMeasurementReceipt(cdp, receiptProbe, "Calibration");
      const assessed = assessCandidate(receipt);
      attempts.push({
        ax, ay, bx, by, pointAHit: true, pointBHit: true, ...assessed,
      });
      if (!assessed.accepted) {
        rejectedCandidates.push({ ...assessed, controlKind: "search_candidate" });
        continue;
      }
      acceptedCandidate = { ...assessed, screen: { ax, ay, bx, by } };
      break searchAcceptedPair;
    }
  }
  invariant(acceptedCandidate,
    `Could not obtain a genuine near-full-height A/B span from the visible Gaussian surface: ${JSON.stringify({ outline, attempts })}`);

  const pickScreenPair = async ({ ax, ay, bx, by }, label) => {
    receiptProbe.reset();
    const started = await cdp.evaluate(clickExactButton("Pick two points"))
      || await cdp.evaluate(clickExactButton("Restart two-point pick"));
    invariant(started, `Could not start ${label}.`);
    await poll(cdp, "document.querySelector('.hybrid-workspace-canvas canvas')?.dataset.realityMeasurement === 'picking-point-a'", `${label} point-A mode`);
    const pointAHit = await clickMeasurementCandidate(
      cdp,
      outline.minX + width * ax,
      outline.minY + height * ay,
      "picking-point-b",
      1_500,
    );
    if (!pointAHit) return { pointAHit: false };
    const pointBHit = await clickMeasurementCandidate(
      cdp,
      outline.minX + width * bx,
      outline.minY + height * by,
      "complete",
      1_000,
    );
    if (!pointBHit) return { pointAHit: true, pointBHit: false };
    return {
      pointAHit: true,
      pointBHit: true,
      receipt: await completedMeasurementReceipt(cdp, receiptProbe, label),
    };
  };

  // Derive the negative-control screen locations from the already proven live
  // BASE-to-CREST pair. Interpolating along that visible surface path is more
  // stable than assuming a fixed silhouette location, while still executing a
  // separate genuine current-LOD measurement session.
  const { ax, ay, bx, by } = acceptedCandidate.screen;
  let shortControl;
  for (const fraction of [0.12, 0.18, 0.24, 0.30, 0.38, 0.46]) {
    const screen = {
      ax,
      ay,
      bx: ax + (bx - ax) * fraction,
      by: ay + (by - ay) * fraction,
    };
    const picked = await pickScreenPair(screen, "Calibration negative control");
    if (!picked.receipt) {
      attempts.push({ kind: "negative-control", fraction, ...screen, ...picked });
      continue;
    }
    const assessed = assessCandidate(picked.receipt);
    attempts.push({ kind: "negative-control", fraction, ...screen, ...picked, ...assessed });
    if (!assessed.accepted
      && assessed.sourceDistance < fixture.physicalTruth.calibration.minimumAcceptedSourceSpanM) {
      shortControl = { ...assessed, controlKind: "visible_short_span" };
      rejectedCandidates.push(shortControl);
      break;
    }
  }
  invariant(shortControl,
    `Could not obtain a genuine rejected short-span calibration control: ${JSON.stringify({ outline, acceptedScreen: acceptedCandidate.screen, attempts })}`);

  // The negative control intentionally changed the Inspector session. Re-pick
  // the proven BASE-to-CREST screen pair so the displayed/applied calibration
  // receipt remains the accepted pair, never the rejected control.
  let restoredAccepted;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const picked = await pickScreenPair(acceptedCandidate.screen, "Calibration accepted pair");
    if (!picked.receipt) {
      attempts.push({ kind: "accepted-restore", attempt, ...acceptedCandidate.screen, ...picked });
      continue;
    }
    const assessed = assessCandidate(picked.receipt);
    attempts.push({ kind: "accepted-restore", attempt, ...acceptedCandidate.screen, ...picked, ...assessed });
    if (assessed.accepted) {
      restoredAccepted = assessed;
      break;
    }
  }
  invariant(restoredAccepted,
    `Could not restore the genuine accepted BASE-to-CREST pair after the negative control: ${JSON.stringify({ outline, acceptedScreen: acceptedCandidate.screen, attempts })}`);
  return {
    pointA: restoredAccepted.pointA,
    pointB: restoredAccepted.pointB,
    sourceDistance: restoredAccepted.sourceDistance,
    knownDistanceM: fixture.physicalTruth.calibration.knownDistanceM,
    metersPerSourceUnit: restoredAccepted.candidateScale,
    sourceHeightM: expectedSourceHeight,
    rejectedCandidateCount: rejectedCandidates.length,
    rejectedCandidates,
  };
}

async function applyTwoPointCalibration(cdp) {
  invariant(await setNativeValue(cdp, 'select[aria-label="Source coordinates"]', "RUB"), "Could not set RUB source coordinates.");
  invariant(await setNativeValue(cdp, 'input[aria-label="Real distance (m)"]', fixture.physicalTruth.calibration.knownDistanceM), "Could not enter the known catalog height.");
  invariant(await cdp.evaluate(clickExactButton("Apply Reality settings")), "Could not apply Reality settings.");
  await delay(500);
}

async function performIndependentWidthMeasurement(cdp, receiptProbe, outline, metersPerSourceUnit) {
  await poll(cdp, "Boolean(document.querySelector('.workspace-inspector__reality'))", "Reality Inspector for independent check");
  const width = outline.width;
  const height = outline.height;
  // The selected outline is a projected AABB, not a silhouette mask. Reuse a
  // genuine A hit while probing several B surface pixels so misses do not
  // discard the first Gaussian raycast.
  const pointACandidates = [
    [0.18, 0.72],
    [0.19, 0.72],
    [0.17, 0.70],
    [0.18, 0.75],
    [0.16, 0.75],
    [0.14, 0.42],
    [0.16, 0.42],
    [0.12, 0.40],
    [0.18, 0.45],
    [0.20, 0.45],
    [0.14, 0.58],
    [0.16, 0.62],
    [0.11, 0.58],
    [0.12, 0.62],
    [0.14, 0.66],
    [0.16, 0.70],
    [0.10, 0.52],
    [0.14, 0.55],
    [0.18, 0.62],
    [0.20, 0.72],
    [0.24, 0.66],
    [0.28, 0.60],
    [0.32, 0.52],
    [0.38, 0.44],
    [0.44, 0.36],
  ];
  const pointBCandidates = [
    [0.86, 0.22],
    [0.85, 0.22],
    [0.87, 0.24],
    [0.84, 0.20],
    [0.86, 0.20],
    [0.85, 0.38],
    [0.84, 0.40],
    [0.86, 0.38],
    [0.82, 0.42],
    [0.88, 0.36],
    [0.82, 0.35],
    [0.84, 0.28],
    [0.84, 0.22],
    [0.82, 0.18],
    [0.86, 0.18],
    [0.82, 0.25],
    [0.85, 0.30],
    [0.80, 0.22],
    [0.78, 0.25],
    [0.75, 0.30],
    [0.72, 0.35],
    [0.80, 0.35],
    [0.75, 0.42],
    [0.70, 0.48],
    [0.72, 0.55],
    [0.66, 0.60],
    [0.61, 0.68],
    [0.57, 0.78],
    [0.53, 0.88],
    [0.66, 0.12],
    [0.61, 0.18],
    [0.56, 0.25],
    [0.50, 0.32],
    [0.45, 0.40],
    [0.38, 0.48],
    [0.31, 0.58],
    [0.25, 0.66],
  ];
  const completedAttempts = [];
  for (const [ax, ay] of pointACandidates) {
    let activePointA = false;
    for (const [bx, by] of pointBCandidates) {
      if (!activePointA) {
        receiptProbe.reset();
        const started = await cdp.evaluate(clickExactButton("Pick two points"))
          || await cdp.evaluate(clickExactButton("Restart two-point pick"));
        invariant(started, "Could not start the independent Gaussian width measurement.");
        await poll(cdp, "document.querySelector('.hybrid-workspace-canvas canvas')?.dataset.realityMeasurement === 'picking-point-a'", "independent point-A mode");
        activePointA = await clickMeasurementCandidate(
          cdp,
          outline.minX + width * ax,
          outline.minY + height * ay,
          "picking-point-b",
          1_500,
        );
        if (!activePointA) {
          completedAttempts.push({ ax, ay, pointAHit: false });
          break;
        }
      }
      const bHit = await clickMeasurementCandidate(
        cdp,
        outline.minX + width * bx,
        outline.minY + height * by,
        "complete",
        800,
      );
      if (!bHit) {
        completedAttempts.push({ ax, ay, bx, by, pointAHit: true, pointBHit: false });
        continue;
      }
      activePointA = false;
      const { pointA, pointB, sourceDistance } = await completedMeasurementReceipt(cdp, receiptProbe, "Second span");
      const sourceDelta = {
        x: Math.abs(pointA.sourcePoint.x - pointB.sourcePoint.x),
        y: Math.abs(pointA.sourcePoint.y - pointB.sourcePoint.y),
        z: Math.abs(pointA.sourcePoint.z - pointB.sourcePoint.z),
      };
      const measuredM = sourceDistance * metersPerSourceUnit;
      const expectedM = fixture.physicalTruth.catalogDimensionsM.x;
      const residualM = Math.abs(measuredM - expectedM);
      const widthAxisSpanM = sourceDelta.x * metersPerSourceUnit;
      completedAttempts.push({
        ax, ay, bx, by, pointAHit: true, pointBHit: true,
        sourceDistance, measuredM, residualM, widthAxisSpanM, sourceDelta,
      });
      const widthDominates = sourceDelta.x >= sourceDelta.y && sourceDelta.x >= sourceDelta.z;
      if (measuredM < 0.28
        || measuredM > 0.36
        || residualM > fixture.physicalTruth.independentWidthToleranceM
        || widthAxisSpanM < expectedM - fixture.physicalTruth.independentWidthToleranceM
        || !widthDominates) continue;
      return { pointA, pointB, sourceDistance, measuredM, expectedM, residualM, widthAxisSpanM };
    }
  }
  throw new Error(`Could not obtain a genuine near-full-width second span from the current Gaussian LOD: ${JSON.stringify({ outline, attempts: completedAttempts })}`);
}

function sourceBoundsFromDescriptor(descriptor) {
  const bounds = descriptor?.sourceBounds ?? descriptor?.source_bounds;
  invariant(bounds?.min && bounds?.max, "Browser asset descriptor omitted source bounds.");
  return bounds;
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function captureManifestReceipt(frameCounts) {
  const entries = [];
  const receiptRoot = outputPlan.smoke
    ? relative(resolve("."), captureRoot).replaceAll("\\", "/")
    : "video/public/reality-twin";
  for (const folder of fixture.capture.sequences) {
    const count = frameCounts[folder];
    invariant(Number.isSafeInteger(count) && count > 0, `${folder} has no completed frame count.`);
    for (let index = 0; index < count; index += 1) {
      const name = `frame-${String(index).padStart(4, "0")}.jpg`;
      const relativePath = `${receiptRoot}/${folder}/${name}`;
      entries.push(`${relativePath}:${hashFile(join(captureRoot, folder, name)).slice("sha256:".length)}`);
    }
  }
  return { fileCount: entries.length, hash: sha256(entries.join("\n")) };
}

export async function captureRealityTwinDemo() {
  const startedAt = new Date().toISOString();
  const logs = [];
  const clients = [];
  let profile;
  let stackMonitor;
  let browserMonitor;
  let cdp;
  let receiptProbe;
  let smokeReceipt;
  let pendingPromotion;
  let cleanupComplete = false;
  let completionMessage;

  try {
    prepareCaptureOutputs(outputPlan);
    const asset = resolveCaptureAsset();
    const gatewayPort = await freePort();
    const vitePort = await freePort();
    const cdpPort = await freePort();
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const appUrl = `http://127.0.0.1:${vitePort}/`;
    profile = mkdtempSync(join(tmpdir(), "semaframe-reality-twin-capture-"));
    const detached = process.platform !== "win32";
    const stack = spawn("npm", ["run", "dev"], {
      detached,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SEMAFRAME_AGENT_GATEWAY_PORT: String(gatewayPort),
        SEMAFRAME_AGENT_GATEWAY_PUBLIC_URL: gatewayUrl,
        SEMAFRAME_AGENT_VITE_PORT: String(vitePort),
      },
    });
    stackMonitor = monitorChild(stack, "SemaFrame development stack");
    stack.stdout.on("data", (chunk) => logs.push(String(chunk)));
    stack.stderr.on("data", (chunk) => logs.push(String(chunk)));
    const browser = spawn(browserExecutable(), [
      "--headless=new",
      ...chromeGpuArguments(),
      "--hide-scrollbars",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { detached, stdio: "ignore" });
    browserMonitor = monitorChild(browser, "Reality Twin capture browser");

    await Promise.race([(async () => {
    await waitForHttp(`${gatewayUrl}/healthz`);
    await waitForHttp(appUrl);
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);
    const target = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })
      .then((response) => response.json());
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Debugger.enable"),
    ]);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: fixture.capture.viewport.width,
      height: fixture.capture.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: appUrl });

    const authorization = await authorizeWorkspace(cdp, "Reality Twin Capture Agent", {
      connection: "00-connection.png",
      approval: "01-approval.png",
    });
    clients.push(authorization.client);
    let { client, session } = authorization;
    const graphicsReceipt = await cdp.evaluate(`(() => {
      const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return undefined;
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return undefined;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        api: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
        vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      };
    })()`);
    invariant(graphicsReceipt?.api === "webgl2" && typeof graphicsReceipt.renderer === "string",
      "Capture browser did not expose the live WebGL2 renderer receipt.");
    invariant(!/swiftshader|software/iu.test(`${graphicsReceipt.vendor} ${graphicsReceipt.renderer}`),
      `Capture requires hardware WebGL, received ${graphicsReceipt.renderer}.`);
    await setNativeValue(cdp, 'input[aria-label="Project name"]', fixture.workspace.projectName);
    await delay(250);

    const initial = await callAgent(client, "inspect_workspace", session);
    invariant(initial.ok, `Initial Workspace inspection failed: ${initial.error?.code}`);
    const workspaceId = initial.data.workspace_summary.workspace_id;
    const begin = async (intent, count) => {
      const prepared = await callAgent(client, "begin_workspace_update", {
        ...session,
        intent,
        ...(count ? { requested_component_ids: count } : {}),
      });
      invariant(prepared.ok, `Could not prepare ${intent}: ${prepared.error?.code}`);
      return prepared.data;
    };
    const submitResult = (prepared, operations) => callAgent(client, "submit_workspace_batch", {
      ...session,
      transaction_token: prepared.transaction_token,
      batch: { ...prepared.envelope, operations },
    });
    const submit = async (prepared, operations) => {
      const result = await submitResult(prepared, operations);
      invariant(result.ok, `Workspace update failed: ${result.error?.code} ${result.error?.message ?? ""}`);
      return result.data;
    };

    let importBegin;
    let uploadStatus;
    let assetCompletion;
    let localBytesReady = false;
    let stageId;
    let scanId;
    await captureDuring(cdp, "import-frames", async () => {
      importBegin = await callAgent(client, "begin_workspace_asset_import", {
        ...session,
        request_id: "reality-twin-smithsonian-gong-0001",
        workspace_id: workspaceId,
        display_name: fixture.gaussian.displayName,
        format: fixture.gaussian.format,
        media_type: fixture.gaussian.mediaType,
        byte_length: asset.bytes.byteLength,
        sha256: asset.digest,
      });
      invariant(importBegin.ok, `Reality Asset import could not begin: ${importBegin.error?.code}`);
      const upload = importBegin.data.upload;
      const response = await fetch(upload.url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${upload.token}`,
          "content-type": upload.content_type,
          "content-length": String(upload.content_length),
        },
        body: asset.bytes,
      });
      uploadStatus = response.status;
      invariant(response.status === 200, `Reality Asset upload failed with HTTP ${response.status}.`);
      const completion = await callAgent(client, "complete_workspace_asset_import", {
        ...session,
        candidate_handle: importBegin.data.candidate_handle,
      });
      invariant(completion.ok, `Browser-authoritative Reality preflight failed: ${completion.error?.code}`);
      assetCompletion = completion.data.result;
      invariant(assetCompletion.asset_ref.digest === asset.digest, "Browser asset digest differs from the prepared PLY.");
      invariant(assetCompletion.descriptor.splatCount === asset.assetEvidence.conversion.splat_count, "Browser splat count differs from asset evidence.");
      invariant(assetCompletion.descriptor.engineeringAuthority === "visual_only", "Imported Gaussian did not remain visual-only.");
      const preparation = await begin("Create an invisible 3D basis and place the verified Smithsonian-derived Gaussian", 2);
      [stageId, scanId] = preparation.reserved_component_ids;
      await submit(preparation, [{
        op: "create_component",
        op_id: "create_reality_twin_coordinate_basis",
        id: stageId,
        label: "Reality Twin coordinate basis",
        component_type: componentRef(preparation.capability_manifest, "stage-3d"),
        props: {
          environmentPreset: "__workspace_empty__",
          dimensions: {
            width: fixture.workspace.stage.widthM,
            height: fixture.workspace.stage.heightM,
            depth: fixture.workspace.stage.depthM,
          },
          background: "#080D12",
          gridVisible: false,
        },
        placement: world(0, 0, 0),
      }, {
        op: "create_component",
        op_id: "create_smithsonian_gong_reality",
        id: scanId,
        label: "Smithsonian gong · GLB scan derived Gaussian",
        component_type: componentRef(preparation.capability_manifest, "gaussian-splat"),
        props: {
          assetRef: {
            assetId: assetCompletion.asset_ref.asset_id,
            digest: assetCompletion.asset_ref.digest,
          },
          calibration: {
            version: 1,
            status: "uncalibrated",
            sourceCoordinateSystem: "RUB",
            targetCoordinateSystem: "RUB",
            metersPerSourceUnit: null,
          },
          quality: "high",
          semanticProxyIds: [],
        },
        placement: world(
          fixture.workspace.scanPlacement.x,
          fixture.workspace.scanPlacement.y,
          fixture.workspace.scanPlacement.z,
        ),
      }]);
      invariant(await cdp.evaluate(clickExactButton("Reality")), "Reality panel was unavailable after import.");
      await poll(
        cdp,
        "document.querySelector('.workspace-reality-card .is-available')?.textContent?.includes('Local bytes ready')",
        "browser-local Reality bytes",
        30_000,
      );
      localBytesReady = await cdp.evaluate(
        "document.querySelector('.workspace-reality-card .is-available')?.textContent?.includes('Local bytes ready') === true",
      );
      invariant(localBytesReady, "Imported Reality asset did not prove local browser bytes ready.");
      invariant(await cdp.evaluate(clickButtonWithAriaLabel("Close reality panel")), "Reality panel could not be closed after import verification.");
      // Asset-vault readiness precedes Spark's first rendered frame. Give the
      // browser-authoritative 1.5M-splat decode time to finish before framing;
      // otherwise Frame all observes only the invisible coordinate basis.
      await delay(8_000);
      await focusScan(cdp);
    }, { actionAt: 8, settleMs: 8_000, frameDelayMs: 54 });
    await poll(cdp, "document.querySelector('.scene-stat')?.textContent?.includes('2 components')", "imported Reality Workspace", 30_000);
    await focusScan(cdp);
    await delay(8_000);
    await capture(cdp, "02-imported-scan.png");
    await captureOrbit(cdp, "orbit-frames");

    receiptProbe = await installMeasurementReceiptProbe(cdp);
    await resetView(cdp);
    await focusScan(cdp);
    const descriptorBounds = sourceBoundsFromDescriptor(assetCompletion.descriptor);
    const expectedSourceHeight = descriptorBounds.max.y - descriptorBounds.min.y;
    const outline = await selectRealityAndMeasureOutline(cdp);
    let calibrationReceipt;
    await captureStages(cdp, "calibration-frames", [
      async () => {
        calibrationReceipt = await performTwoPointCalibration(
          cdp,
          receiptProbe,
          outline,
          expectedSourceHeight,
          descriptorBounds,
        );
      },
      async () => {
        await applyTwoPointCalibration(cdp);
      },
    ], { settleMs: 900, frameDelayMs: 50, nudgeInitialState: false });
    const calibratedComponent = await callAgent(client, "inspect_workspace_component", {
      ...session,
      component_id: scanId,
    });
    invariant(calibratedComponent.ok, "Agent could not read back calibrated Reality component.");
    const appliedCalibration = calibratedComponent.data.component.props.calibration;
    invariant(appliedCalibration.status === "reference-distance", "Reality component did not persist reference-distance calibration.");
    invariant(Math.abs(appliedCalibration.metersPerSourceUnit - calibrationReceipt.metersPerSourceUnit) <= 1e-9,
      "Persisted calibration scale differs from the genuine A/B receipt.");
    await focusScan(cdp);
    await capture(cdp, "03-calibrated-scan.png");
    await orbitCameraWithPointer(cdp, 0.11);
    const independentOutline = await selectRealityAndMeasureOutline(cdp);
    let independentReceipt;
    await captureDuring(cdp, "verification-frames", async () => {
      independentReceipt = await performIndependentWidthMeasurement(
        cdp,
        receiptProbe,
        independentOutline,
        appliedCalibration.metersPerSourceUnit,
      );
      const measuredMm = Math.round(independentReceipt.measuredM * 1_000);
      const expectedMm = Math.round(independentReceipt.expectedM * 1_000);
      const residualMm = Math.round(independentReceipt.residualM * 1_000);
      invariant(await setNativeValue(
        cdp,
        'input[aria-label="Project name"]',
        `Second span · ${measuredMm} mm vs ${expectedMm} mm · Δ ${residualMm} mm`,
      ), "Could not show the genuine second-span result in the project bar.");
    }, { actionAt: 8, settleMs: 700, frameDelayMs: 58 });
    invariant(await cdp.evaluate(clickExactButton("Clear markers")), "Independent Gaussian markers could not be cleared.");
    await setNativeValue(cdp, 'input[aria-label="Project name"]', fixture.workspace.projectName);
    invariant(independentReceipt.pointA.sessionId !== calibrationReceipt.pointA.sessionId,
      "Independent dimension check reused the calibration measurement session.");
    invariant(await cdp.evaluate(clickButtonWithAriaLabel("Close inspector panel")), "Inspector panel could not be closed after measurement proof.");
    await clearWorkspaceSelection(cdp);

    const scanMetricDimensions = dimensionsFromBounds(descriptorBounds, appliedCalibration.metersPerSourceUnit);
    const catalogDimensions = fixture.physicalTruth.catalogDimensionsM;
    const residualM = signedDimensionResidual(scanMetricDimensions, catalogDimensions);
    invariant(dimensionResidualWithin(residualM, fixture.physicalTruth.scanResidualToleranceM),
      `Calibrated scan residual exceeded demo tolerance: ${JSON.stringify(residualM)}`);

    let proxyId;
    let plinthId;
    let sourceCaseRootId;
    let sourcePanelIds;
    const caseGeometry = protectiveCaseGeometry(fixture);
    await captureStages(cdp, "proxy-build-frames", [async () => {
      const preparation = await begin("Reveal the conservation stage and create the exact catalog proxy and museum plinth", 2);
      [proxyId, plinthId] = preparation.reserved_component_ids;
      const primitiveRef = componentRef(preparation.capability_manifest, "spatial-primitive");
      await submit(preparation, [{
        op: "update_component",
        op_id: "reveal_reality_twin_conservation_stage",
        id: stageId,
        patch: {
          label: "Museum conservation stage",
          props: {
            environmentPreset: "dark_room",
            background: "#080D12",
            gridVisible: false,
          },
        },
      }, {
        op: "resize_component",
        op_id: "resize_reality_twin_conservation_stage",
        id: stageId,
        resize: {
          kind: "stage_dimensions",
          dimensions: {
            width: fixture.workspace.stage.widthM,
            height: fixture.workspace.stage.heightM,
            depth: fixture.workspace.stage.depthM,
          },
        },
      }, {
        ...primitive({
          id: proxyId,
          label: "Editable catalog proxy · 322 x 322 x 157 mm",
          geometry: { kind: "box", sizeM: fixture.physicalTruth.proxyDimensionsM },
          placement: world(
            fixture.workspace.proxy.center.x,
            fixture.workspace.proxy.center.y,
            fixture.workspace.proxy.center.z,
          ),
          color: "#36DDF5",
          opacity: 0.18,
          metallic: 0.08,
          roughness: 0.25,
        }),
        component_type: primitiveRef,
      }, {
        ...primitive({
          id: plinthId,
          label: "Museum plinth",
          geometry: { kind: "box", sizeM: fixture.workspace.plinth.sizeM },
          placement: world(
            fixture.workspace.plinth.center.x,
            fixture.workspace.plinth.center.y,
            fixture.workspace.plinth.center.z,
          ),
          color: "#E5E0D4",
          opacity: 1,
          metallic: 0.02,
          roughness: 0.82,
        }),
        component_type: primitiveRef,
      }, {
        op: "update_component",
        op_id: "link_exact_catalog_proxy_to_reality",
        id: scanId,
        patch: {
          props: {
            assetRef: calibratedComponent.data.component.props.assetRef,
            calibration: appliedCalibration,
            quality: "high",
            semanticProxyIds: [proxyId],
          },
        },
      }]);
      await resetView(cdp);
      await frameAll(cdp);
      await zoomIn(cdp, 8);
    }, async () => {
      const preparation = await begin("Author a transparent five-panel protective display case with 40 mm clearance", 6);
      [sourceCaseRootId, ...sourcePanelIds] = preparation.reserved_component_ids;
      const assemblyRef = componentRef(preparation.capability_manifest, "model-assembly");
      const primitiveRef = componentRef(preparation.capability_manifest, "spatial-primitive");
      const panelEntries = Object.entries(caseGeometry.panels);
      await submit(preparation, [{
        op: "create_component",
        op_id: "create_protective_case_source",
        id: sourceCaseRootId,
        label: "Protective display case · reusable source",
        component_type: assemblyRef,
        props: {
          description: "Editable five-panel glass case with 40 mm catalog-proxy clearance",
          collisionPolicy: "external_only",
        },
        placement: world(fixture.workspace.case.sourceRootX, fixture.workspace.case.rootY, 0),
      }, ...panelEntries.map(([name, panel], index) => ({
        ...primitive({
          id: sourcePanelIds[index],
          label: `Protective case ${name} glass`,
          geometry: { kind: "box", sizeM: panel.sizeM },
          placement: world(panel.center.x, panel.center.y, panel.center.z),
          parentId: sourceCaseRootId,
          color: "#BDEFFF",
          opacity: 0.2,
          metallic: 0.05,
          roughness: 0.08,
        }),
        component_type: primitiveRef,
      }))]);
      await resetView(cdp);
      await frameAll(cdp);
      await zoomIn(cdp, 8);
    }]);
    await resetView(cdp);
    await frameAll(cdp);
    await zoomIn(cdp, 8);
    await capture(cdp, "04-proxy-and-case-source.png");

    let spaceReadback;
    await captureDuring(cdp, "spatial-read-frames", async () => {
      const space = await callAgent(client, "inspect_workspace_space", session);
      invariant(space.ok, `Agent spatial readback failed: ${space.error?.code}`);
      spaceReadback = space.data.spatial_graph;
      const realityNode = spaceReadback.nodes.find((node) => node.id === scanId);
      const proxyNode = spaceReadback.nodes.find((node) => node.id === proxyId);
      invariant(realityNode?.node_kind === "reality", "SSG omitted the Reality node.");
      invariant(realityNode.reality.engineering_authority === "visual_only", "SSG elevated the Gaussian to engineering authority.");
      invariant(realityNode.reality.semantic_proxy_ids.includes(proxyId), "SSG omitted the Reality-to-proxy link.");
      invariant(realityNode.relations.includes(`represented_by:${proxyId}`), "SSG omitted represented_by relation.");
      invariant(proxyNode?.relations.includes(`proxy_for:${scanId}`), "SSG omitted proxy_for relation.");
      const safeJson = JSON.stringify(space.data);
      invariant(!/"(?:raw[_-]?(?:splats|pixels|bytes)|base64|source[_-]?glb|upload_token)"\s*:/iu.test(safeJson),
        "Agent spatial readback exposed raw asset content.");
      await setNativeValue(
        cdp,
        'input[aria-label="Project name"]',
        `Agent readback · ${realityNode.reality.splat_count.toLocaleString()} splats · visual-only + exact proxy`,
      );
    }, { actionAt: 8, settleMs: 650, frameDelayMs: 58 });
    await setNativeValue(cdp, 'input[aria-label="Project name"]', fixture.workspace.projectName);

    let model;
    let publishedRevision;
    let collisionPreflight;
    let rejectedBatch;
    let revisionBeforeRejection;
    let revisionAfterRejection;
    let instanceIds;
    let instanceIdMap;
    let instanceRootId;
    let instanceTopId;
    let numericBefore;
    let numericAfter;
    let undoReceipt;
    let redoReceipt;
    let undoReadback;
    let redoReadback;
    const panelNames = Object.keys(caseGeometry.panels);
    const sourceTopId = sourcePanelIds[panelNames.indexOf("top")];
    await captureStages(cdp, "proxy-edit-frames", [async () => {
      const publish = await begin("Publish the editable 40 mm-clearance protective display case");
      const publishReceipt = await submit(publish, [{
        op: "publish_model",
        op_id: "publish_reality_twin_case",
        model_id: fixture.workspace.modelId,
        version: fixture.workspace.modelVersion,
        display_name: "Reality Twin Protective Display Case",
        root_id: sourceCaseRootId,
      }, {
        op: "update_component",
        op_id: "hide_published_case_source",
        id: sourceCaseRootId,
        patch: { visibility: "collapsed" },
      }]);
      publishedRevision = publishReceipt.resulting_workspace_revision;
      const inspected = await callAgent(client, "inspect_workspace_model", {
        ...session,
        model_id: fixture.workspace.modelId,
        version: fixture.workspace.modelVersion,
      });
      invariant(inspected.ok, "Published protective-case model could not be inspected.");
      model = inspected.data.model_definition;
      invariant(model.node_count === 6, `Protective case published ${model.node_count}/6 nodes.`);
    }, async () => {
      const rightPanel = caseGeometry.panels.right;
      const unsafeRightWorld = {
        x: fixture.workspace.case.unsafeRootX + rightPanel.center.x,
        y: fixture.workspace.case.rootY + rightPanel.center.y,
        z: rightPanel.center.z,
      };
      const query = await callAgent(client, "query_spatial_placement", {
        ...session,
        candidate: {
          geometry: { kind: "box", sizeM: rightPanel.sizeM },
          placement: world(unsafeRightWorld.x, unsafeRightWorld.y, unsafeRightWorld.z),
          collision: solidCollision,
        },
      });
      invariant(query.ok && query.data.placement_check.valid === false,
        "Unsafe shifted display-case wall was not rejected by placement preflight.");
      collisionPreflight = query.data.placement_check;
      const before = await callAgent(client, "inspect_workspace", session);
      revisionBeforeRejection = before.data.workspace_summary.revision;
      const unsafe = await begin("Attempt a too-tight display case that intersects the exact proxy", model.node_count);
      const unsafeIds = unsafe.reserved_component_ids;
      const unsafeMap = Object.fromEntries(model.id_map_keys.map((nodeId, index) => [nodeId, unsafeIds[index]]));
      rejectedBatch = await submitResult(unsafe, [{
        op: "instantiate_model",
        op_id: "instantiate_too_tight_case",
        model: { modelId: model.model_id, version: model.version, digest: model.digest },
        id_map: unsafeMap,
        root_placement: world(fixture.workspace.case.unsafeRootX, fixture.workspace.case.rootY, 0),
      }]);
      invariant(rejectedBatch.ok === false && rejectedBatch.error?.code === "spatial_collision",
        `Unsafe case was not atomically rejected: ${rejectedBatch.error?.code ?? "unexpected_success"}`);
      const after = await callAgent(client, "inspect_workspace", session);
      revisionAfterRejection = after.data.workspace_summary.revision;
      invariant(revisionAfterRejection === revisionBeforeRejection, "Rejected case changed Workspace revision.");
      await setNativeValue(cdp, 'input[aria-label="Project name"]', "COLLISION BLOCKED · too-tight case rejected atomically");
    }, async () => {
      const corrected = await begin("Place the corrected 40 mm-clearance case around the exact catalog proxy", model.node_count);
      instanceIds = corrected.reserved_component_ids;
      instanceIdMap = Object.fromEntries(model.id_map_keys.map((nodeId, index) => [nodeId, instanceIds[index]]));
      await submit(corrected, [{
        op: "instantiate_model",
        op_id: "instantiate_validated_clearance_case",
        model: { modelId: model.model_id, version: model.version, digest: model.digest },
        id_map: instanceIdMap,
        root_placement: world(fixture.workspace.case.correctedRootX, fixture.workspace.case.rootY, 0),
      }]);
      instanceRootId = instanceIdMap[model.root_node_id];
      instanceTopId = instanceIdMap[sourceTopId];
      invariant(instanceRootId && instanceTopId, "Corrected case ID map omitted root or top panel.");
      await setNativeValue(cdp, 'input[aria-label="Project name"]', "VALIDATED · corrected case keeps 40 mm clearance");
      await resetView(cdp);
      await frameAll(cdp);
      await zoomIn(cdp, 8);
    }, async () => {
      const before = await callAgent(client, "inspect_workspace_component", { ...session, component_id: instanceTopId });
      invariant(before.ok, "Could not inspect the materialized top panel before numeric edit.");
      numericBefore = before.data.component.props.geometry.sizeM.y;
      const edit = await begin("Numerically edit the materialized top-glass thickness without mutating the published model");
      await submit(edit, [{
        op: "update_component",
        op_id: "edit_instance_top_glass_thickness",
        id: instanceTopId,
        patch: {
          props: {
            geometry: {
              kind: "box",
              sizeM: {
                ...caseGeometry.panels.top.sizeM,
                y: fixture.workspace.case.editedTopThicknessM,
              },
            },
          },
        },
      }]);
      const after = await callAgent(client, "inspect_workspace_component", { ...session, component_id: instanceTopId });
      numericAfter = after.data.component.props.geometry.sizeM.y;
      invariant(numericBefore === fixture.workspace.case.glassThicknessM
        && numericAfter === fixture.workspace.case.editedTopThicknessM,
      "Exact numeric top-glass edit did not persist.");
      await setNativeValue(cdp, 'input[aria-label="Project name"]', "HUMAN-EDITABLE · top glass 8 mm → 10 mm");
    }, async () => {
      const beforeUndo = await callAgent(client, "inspect_workspace", session);
      const undo = await callAgent(client, "undo_workspace_batch", {
        ...session,
        expected_workspace_revision: beforeUndo.data.workspace_summary.revision,
      });
      invariant(undo.ok && undo.data.changed, `Undo failed: ${undo.error?.code ?? "unchanged"}`);
      undoReceipt = undo.data;
      const readback = await callAgent(client, "inspect_workspace_component", { ...session, component_id: instanceTopId });
      undoReadback = readback.data.component.props.geometry.sizeM.y;
      invariant(undoReadback === numericBefore, "Undo did not restore the 8 mm top glass.");
    }, async () => {
      const redo = await callAgent(client, "redo_workspace_batch", {
        ...session,
        expected_workspace_revision: undoReceipt.workspace_revision,
      });
      invariant(redo.ok && redo.data.changed, `Redo failed: ${redo.error?.code ?? "unchanged"}`);
      redoReceipt = redo.data;
      const readback = await callAgent(client, "inspect_workspace_component", { ...session, component_id: instanceTopId });
      redoReadback = readback.data.component.props.geometry.sizeM.y;
      invariant(redoReadback === numericAfter, "Redo did not restore the 10 mm top glass.");
      await setNativeValue(cdp, 'input[aria-label="Project name"]', fixture.workspace.projectName);
    }], { frameDelayMs: 48, settleMs: 480 });

    const correctedSpace = await callAgent(client, "inspect_workspace_space", session);
    invariant(correctedSpace.ok, "Corrected spatial graph could not be inspected.");
    invariant(correctedSpace.data.spatial_graph.collision_conflicts.length === 0,
      "Corrected case retains a collision conflict.");
    const finalProxyNode = correctedSpace.data.spatial_graph.nodes.find((node) => node.id === proxyId);
    invariant(finalProxyNode?.geometry?.parameters?.kind === "box"
      && maximumDimensionDelta(finalProxyNode.geometry.parameters.sizeM, fixture.physicalTruth.proxyDimensionsM) <= 1e-12,
      "Exact catalog proxy geometry drifted.");
    await resetView(cdp);
    await frameAll(cdp);
    await zoomIn(cdp, 8);
    await capture(cdp, "05-corrected-editable-case.png");

    await installArtifactCapture(cdp);
    let usda;
    let usdaArtifactPath;
    let stagedUsdaArtifactPath;
    let usdcheckerReceipt;
    let exportWorkspaceRevision;
    let exportedAt;
    await captureDuring(cdp, "export-frames", async () => {
      const exportWorkspace = await callAgent(client, "inspect_workspace", session);
      invariant(exportWorkspace.ok, "Workspace could not be inspected immediately before export.");
      exportWorkspaceRevision = exportWorkspace.data.workspace_summary.revision;
      invariant(await cdp.evaluate(clickExactButton("Models")), "Models panel was unavailable.");
      await poll(cdp, "Boolean(document.querySelector('.workspace-model-card'))", "published Reality Twin model card");
      await cdp.evaluate("document.querySelector('.workspace-model-card')?.scrollIntoView({ block: 'center', inline: 'nearest' }); true");
      invariant(await cdp.evaluate(clickExactButton("USDA")), "USDA export was unavailable.");
      usda = await capturedUsda(cdp);
      invariant(typeof usda?.contents === "string" && usda.contents.startsWith("#usda 1.0"), "USDA export is not OpenUSD ASCII.");
      invariant(usda.contents.includes("metersPerUnit = 1") && usda.contents.includes('upAxis = "Y"'),
        "USDA stage metadata is invalid.");
      stagedUsdaArtifactPath = join(artifactRoot, usda.name);
      usdaArtifactPath = outputPlan.smoke
        ? relative(resolve("."), stagedUsdaArtifactPath).replaceAll("\\", "/")
        : join("artifacts", "reality-twin", "capture", usda.name);
      writeFileSync(stagedUsdaArtifactPath, usda.contents);
      exportedAt = new Date().toISOString();
      usdcheckerReceipt = runUsdChecker(stagedUsdaArtifactPath);
      await setNativeValue(cdp, 'input[aria-label="Project name"]', "OPENUSD · fresh export passes usdchecker");
    }, { actionAt: 8, settleMs: 650, frameDelayMs: 58 });
    invariant(await cdp.evaluate(clickButtonWithAriaLabel("Close models panel")), "Models panel could not be closed.");
    await setNativeValue(cdp, 'input[aria-label="Project name"]', fixture.workspace.projectName);
    await capture(cdp, "06-openusd-validated.png");

    const beforeSave = await callAgent(client, "inspect_workspace", session);
    invariant(beforeSave.ok, "Workspace could not be inspected before Save.");
    const savedProjectText = await captureWorkspaceProject(cdp, "reality-twin-shang-gong");
    const savedProject = JSON.parse(savedProjectText);
    const modelDefinitionEntry = savedProject.workspace?.modelDefinitions?.find(([key]) => (
      key === `${model.model_id}@${model.version}`
    ));
    invariant(Array.isArray(modelDefinitionEntry) && modelDefinitionEntry.length === 2,
      "Saved project omitted the canonical published protective-case definition.");
    const canonicalPublishedModelDefinition = modelDefinitionEntry[1];
    const modelReceipts = publishedModelReceipts(canonicalPublishedModelDefinition);
    invariant(modelReceipts.toolDigest === model.digest,
      "Published-model inspection digest differs from the saved canonical definition.");
    invariant(canonicalPublishedModelDefinition.modelId === model.model_id
      && canonicalPublishedModelDefinition.version === model.version
      && canonicalPublishedModelDefinition.nodes?.length === model.node_count,
    "Saved canonical model definition differs from the read-only model inspection.");
    const projectArtifactPath = outputPlan.smoke
      ? relative(resolve("."), join(artifactRoot, "reality-twin-shang-gong.semaframe.json")).replaceAll("\\", "/")
      : join("artifacts", "reality-twin", "capture", "reality-twin-shang-gong.semaframe.json");
    const projectArtifactBytes = `${savedProjectText.trim()}\n`;
    writeFileSync(join(artifactRoot, basename(projectArtifactPath)), projectArtifactBytes);
    await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled Save notice", 15_000);

    let reopenedSummary;
    let reopenedTop;
    await captureDuring(cdp, "reopen-frames", async () => {
      const injected = await cdp.evaluate(`(() => {
        const input = document.querySelector('input[type="file"][accept*="semaframe"]');
        if (!(input instanceof HTMLInputElement)) return false;
        const transfer = new DataTransfer();
        transfer.items.add(new File([${JSON.stringify(savedProjectText)}], 'reality-twin-shang-gong.semaframe.json', { type: 'application/json' }));
        Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      invariant(injected, "Saved Reality Twin project could not be supplied to Open.");
      await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "reopened project Agent gate", 30_000);
      await client.close().catch(() => undefined);
      const reopenedAuthorization = await authorizeWorkspace(cdp, "Reality Twin Reopen Verification Agent");
      clients.push(reopenedAuthorization.client);
      client = reopenedAuthorization.client;
      session = reopenedAuthorization.session;
      const reopened = await callAgent(client, "inspect_workspace", session);
      invariant(reopened.ok, "Reopened Workspace could not be inspected.");
      reopenedSummary = reopened.data.workspace_summary;
      const prior = beforeSave.data.workspace_summary;
      invariant(reopenedSummary.revision === prior.revision
        && reopenedSummary.component_count === prior.component_count
        && reopenedSummary.model_definition_count === prior.model_definition_count
        && reopenedSummary.reality_asset_count === prior.reality_asset_count,
      `Save/reopen did not preserve Workspace summary: ${JSON.stringify({ prior, reopenedSummary })}`);
      const top = await callAgent(client, "inspect_workspace_component", { ...session, component_id: instanceTopId });
      invariant(top.ok, "Reopened materialized top panel could not be inspected.");
      reopenedTop = top.data.component.props.geometry.sizeM.y;
      invariant(reopenedTop === numericAfter, "Save/reopen lost the numeric case edit.");
      await delay(8_000);
      await resetView(cdp);
      await frameAll(cdp);
      await zoomIn(cdp, 8);
      await setNativeValue(cdp, 'input[aria-label="Project name"]', "SAVE / REOPEN · model, scan, proxy, numeric edit preserved");
    }, { actionAt: 8, settleMs: 850, frameDelayMs: 58 });
    await setNativeValue(cdp, 'input[aria-label="Project name"]', fixture.workspace.projectName);
    await capture(cdp, "07-reopened.png");

    await resetView(cdp);
    await frameAll(cdp);
    await zoomIn(cdp, 8);
    await captureOrbit(cdp, "final-frames", { travelRatio: 0.025 });
    await capture(cdp, "08-final.png");

    const frameCounts = Object.fromEntries(fixture.capture.sequences.map((folder) => [folder, frameCountFor(folder)]));
    if (smokeFrameCount !== undefined) {
      invariant(Object.values(frameCounts).every((count) => count === smokeFrameCount), "Smoke capture frame counts drifted.");
    } else {
      for (const [folder, expected] of Object.entries(fixture.capture.sequenceFrameCounts)) {
        invariant(frameCounts[folder] === expected, `${folder} wrote ${frameCounts[folder]}/${expected} contract frames.`);
      }
    }

    const reopenedSpace = await callAgent(client, "inspect_workspace_space", session);
    invariant(reopenedSpace.ok, "Reopened Agent spatial readback failed.");
    const reopenedRealityNode = reopenedSpace.data.spatial_graph.nodes.find((node) => node.id === scanId);
    const reopenedProxyNode = reopenedSpace.data.spatial_graph.nodes.find((node) => node.id === proxyId);
    invariant(reopenedRealityNode && reopenedProxyNode, "Reopened SSG omitted Reality or proxy node.");
    const modelTypes = [...new Set(model.nodes.map((node) => node.component_type.typeId))].sort();
    const integrityPaths = {
      visualContract: resolve("video/reality-twin-v1.visual-contract.json"),
      compositionSource: resolve("video/src/RealityTwinProofV1.tsx"),
      rootSource: resolve("video/src/Root.tsx"),
      assetEvidence: asset.assetEvidencePath,
      landscapeCaption: resolve("video/captions/semaframe-reality-twin-v1.en-US.srt"),
      verticalCaption: resolve("video/captions/semaframe-reality-twin-v1-vertical.en-US.srt"),
    };
    for (const [label, path] of Object.entries(integrityPaths)) invariant(existsSync(path), `${label} integrity source is missing: ${path}`);
    const captureManifest = captureManifestReceipt(frameCounts);

    const bindMeasurementPoint = (point, role) => ({
      ...point.sourcePoint,
      pickedOnCurrentGaussianLod: true,
      pointId: `measurement-${point.sessionId}-${role}`,
      sessionId: point.sessionId,
      assetId: assetCompletion.asset_ref.asset_id,
      assetDigest: assetCompletion.asset_ref.digest,
    });
    const calibrationPointA = bindMeasurementPoint(calibrationReceipt.pointA, "a");
    const calibrationPointB = bindMeasurementPoint(calibrationReceipt.pointB, "b");
    const independentPointA = bindMeasurementPoint(independentReceipt.pointA, "a");
    const independentPointB = bindMeasurementPoint(independentReceipt.pointB, "b");
    // Evidence presents the explicit negative control first, followed by the
    // target-guided search rejections. Session IDs preserve actual UI order.
    const orderedCalibrationRejections = [
      ...calibrationReceipt.rejectedCandidates.filter((candidate) => candidate.controlKind === "visible_short_span"),
      ...calibrationReceipt.rejectedCandidates.filter((candidate) => candidate.controlKind !== "visible_short_span"),
    ];
    const calibrationRejectedCandidates = orderedCalibrationRejections.map((candidate, index) => ({
      sequence: index + 1,
      controlKind: candidate.controlKind,
      accepted: false,
      measurementFidelity: "gaussian-lod",
      pointA: bindMeasurementPoint(candidate.pointA, "a"),
      pointB: bindMeasurementPoint(candidate.pointB, "b"),
      sourceDistance: candidate.sourceDistance,
      sourceDelta: candidate.sourceDelta,
      candidateMetersPerSourceUnit: candidate.candidateScale,
      calibratedScanAabbM: candidate.candidateScanDimensions,
      catalogResidualM: candidate.candidateScanResidual,
      residualToleranceM: fixture.physicalTruth.scanResidualToleranceM,
      rejectionReasonCodes: candidate.rejectionReasonCodes,
    }));
    const sourceGlbDigests = asset.assetEvidence.source.glbFiles.map((entry) => ({
      part: entry.part,
      fileName: entry.fileName,
      sha256: `sha256:${entry.sha256}`,
      byteLength: entry.byteLength,
    }));
    const completedAt = new Date().toISOString();
    const evidence = {
      format: CAPTURE_EVIDENCE_FORMAT,
      version: CAPTURE_EVIDENCE_VERSION,
      status: "complete",
      captureRunId,
      startedAt,
      completedAt,
      ...(outputPlan.smoke ? { captureMode: "smoke", deliveryEvidence: false } : {}),
      source: {
        derivation: "smithsonian_glb_scan_to_gaussian_ply",
        nativeGaussianCapture: false,
        sourceClass: "official_museum_mesh_scan",
        conversionLocation: "offline",
        assetEvidencePath: "video/public/reality-twin/asset-evidence.json",
        sourceGlbDigests,
        derivedPlyDigest: asset.digest,
        claimBoundary: "The app imports a Gaussian PLY derived offline from two official Smithsonian GLB scan parts. SemaFrame does not reconstruct this asset from photos and the PLY is not a native Gaussian capture.",
      },
      agentExecution: {
        kind: "deterministic_authorized_mcp_client",
        generativePlannerUsed: false,
        fixtureDriven: true,
      },
      integrity: {
        visualContractSha256: hashFile(integrityPaths.visualContract),
        compositionSourceSha256: hashFile(integrityPaths.compositionSource),
        rootSourceSha256: hashFile(integrityPaths.rootSource),
        assetEvidenceSha256: hashFile(integrityPaths.assetEvidence),
        landscapeCaptionSha256: hashFile(integrityPaths.landscapeCaption),
        verticalCaptionSha256: hashFile(integrityPaths.verticalCaption),
        captureAssetManifestSha256: captureManifest.hash,
        captureAssetCount: captureManifest.fileCount,
      },
      assetImport: {
        browserAuthoritative: true,
        requestId: "reality-twin-smithsonian-gong-0001",
        localBytesReady,
        upload: {
          httpStatus: uploadStatus,
          byteLength: asset.bytes.byteLength,
          mediaType: fixture.gaussian.mediaType,
          transport: "one-time streaming PUT; bytes never entered MCP JSON",
        },
        assetRef: {
          assetId: assetCompletion.asset_ref.asset_id,
          digest: assetCompletion.asset_ref.digest,
        },
        descriptor: assetCompletion.descriptor,
      },
      calibration: {
        label: fixture.physicalTruth.calibration.label,
        measurementFidelity: "gaussian-lod",
        measurementCompleted: true,
        blindValidation: false,
        selectionPolicy: "target_guided_visible_candidate_search_with_aabb_residual_gate",
        rejectedCandidateCount: calibrationReceipt.rejectedCandidateCount,
        rejectedCandidates: calibrationRejectedCandidates,
        appliedThroughInspectorUi: true,
        inputDriver: "automated_cdp_pointer_and_form_events",
        humanInputClaimed: false,
        pickedOnCurrentGaussianLod: true,
        assetDigest: assetCompletion.asset_ref.digest,
        pointA: calibrationPointA,
        pointB: calibrationPointB,
        sourceDistance: calibrationReceipt.sourceDistance,
        knownDistanceM: calibrationReceipt.knownDistanceM,
        metersPerSourceUnit: appliedCalibration.metersPerSourceUnit,
        componentReadback: appliedCalibration,
        workspaceRevision: calibratedComponent.data.workspace_revision,
        residualPolicy: "one uniform BASE-to-CREST scale; no anisotropic deformation",
      },
      independentDimensionCheck: {
        axis: "x",
        label: "second visible width pair",
        source: "live_calibrated_gaussian_measurement",
        displayedWithoutSubstitution: true,
        blindValidation: false,
        selectionPolicy: "target_guided_visible_candidate_search",
        viewPreparation: "automated_canvas_orbit_pointer_events",
        measurementFidelity: "gaussian-lod",
        pointA: independentPointA,
        pointB: independentPointB,
        sourceDistance: independentReceipt.sourceDistance,
        expectedM: independentReceipt.expectedM,
        measuredM: independentReceipt.measuredM,
        residualM: independentReceipt.residualM,
        residualPercent: independentReceipt.residualM / independentReceipt.expectedM,
        toleranceM: fixture.physicalTruth.independentWidthToleranceM,
        toleranceSource: fixture.physicalTruth.toleranceSource,
        distinctFromCalibrationPair: independentReceipt.pointA.sessionId !== calibrationReceipt.pointA.sessionId,
        passed: independentReceipt.residualM <= fixture.physicalTruth.independentWidthToleranceM,
      },
      scanAabbComparison: {
        expectedCatalogM: catalogDimensions,
        calibratedScanAabbM: scanMetricDimensions,
        residualM,
        residualPercent: Object.fromEntries(["x", "y", "z"].map((axis) => [axis, residualM[axis] / catalogDimensions[axis]])),
        toleranceM: fixture.physicalTruth.scanResidualToleranceM,
        passed: dimensionResidualWithin(residualM, fixture.physicalTruth.scanResidualToleranceM),
        exactCatalogMatchClaimed: false,
      },
      agentReadback: {
        tool: "inspect_workspace_space",
        safeDescriptorOnly: true,
        rawSplatsExposed: false,
        rawPixelsExposed: false,
        sourceGlbExposed: false,
        assetDigest: assetCompletion.asset_ref.digest,
        calibration: reopenedRealityNode.reality,
        worldBounds: { ...reopenedRealityNode.world_bounds, units: "metres" },
        worldBoundsRaw: reopenedRealityNode.world_bounds,
        worldBoundsUnits: "metres",
        semanticProxyIds: reopenedRealityNode.reality.semantic_proxy_ids,
        relations: reopenedRealityNode.relations,
      },
      semanticProxy: {
        linked: reopenedRealityNode.reality.semantic_proxy_ids.includes(proxyId),
        realityId: scanId,
        proxyId,
        engineeringAuthority: "proxy",
        realityEngineeringAuthority: reopenedRealityNode.reality.engineering_authority,
        exactGeometry: true,
        exactGeometryParameters: reopenedProxyNode.geometry.parameters,
        worldBounds: reopenedProxyNode.world_bounds,
        relations: reopenedProxyNode.relations,
      },
      collision: {
        preflightValid: collisionPreflight.valid,
        preflightConflicts: collisionPreflight.conflicts,
        rejectedBatchCode: rejectedBatch.error.code,
        revisionBeforeRejection,
        revisionAfterRejection,
        atomic: revisionBeforeRejection === revisionAfterRejection,
        proxyColliderEnabled: true,
        realityColliderEnabled: false,
        correctedCollisionConflictCount: correctedSpace.data.spatial_graph.collision_conflicts.length,
      },
      numericEdit: {
        componentId: instanceTopId,
        property: "props.geometry.sizeM.y",
        beforeM: numericBefore,
        afterM: numericAfter,
        readbackAfterM: redoReadback,
        undoRestoredBefore: undoReadback === numericBefore,
        redoRestoredAfter: redoReadback === numericAfter,
      },
      history: {
        undo: { applied: undoReceipt.changed, changed: undoReceipt.changed, readbackM: undoReadback, workspaceRevision: undoReceipt.workspace_revision },
        redo: { applied: redoReceipt.changed, changed: redoReceipt.changed, readbackM: redoReadback, workspaceRevision: redoReceipt.workspace_revision },
      },
      persistence: {
        projectPath: projectArtifactPath,
        projectSha256: sha256(projectArtifactBytes),
        savedRevision: beforeSave.data.workspace_summary.revision,
        reopenedRevision: reopenedSummary.revision,
        savedComponentCount: beforeSave.data.workspace_summary.component_count,
        reopenedComponentCount: reopenedSummary.component_count,
        savedRealityAssetCount: beforeSave.data.workspace_summary.reality_asset_count,
        reopenedRealityAssetCount: reopenedSummary.reality_asset_count,
        numericEditAfterReopenM: reopenedTop,
        preserved: true,
      },
      model: {
        modelId: model.model_id,
        version: model.version,
        toolDigest: modelReceipts.toolDigest,
        contentSha256: modelReceipts.contentSha256,
        canonicalDefinition: canonicalPublishedModelDefinition,
        nodeCount: model.node_count,
        sourceRootId: sourceCaseRootId,
        instanceRootId,
        instanceTopId,
        publishedRevision,
        published: true,
        editableInstance: true,
        publishedSubtreeTypes: modelTypes,
        publishedSubtree: {
          rootId: sourceCaseRootId,
          rootType: "model-assembly",
          excludesReality: true,
          contentClass: "protective_case_model",
          containsReality: false,
        },
      },
      exports: {
        usda: {
          filename: usda.name,
          artifactPath: usdaArtifactPath,
          byteLength: usda.byteLength,
          sha256: sha256(usda.contents),
          validOpenUsd: true,
          captureRunId,
          sourceModelToolDigest: modelReceipts.toolDigest,
          sourceModelContentSha256: modelReceipts.contentSha256,
          sourceWorkspaceRevision: publishedRevision,
          invokedAtWorkspaceRevision: exportWorkspaceRevision,
          exportedAt,
          freshExport: true,
          usdchecker: { ...usdcheckerReceipt, args: usdcheckerReceipt.arguments },
        },
      },
      captures: {
        viewport: { ...fixture.capture.viewport, fps: 30 },
        browserGraphics: {
          ...graphicsReceipt,
          webgl2: true,
          hardwareAccelerated: true,
          softwareRenderer: false,
        },
        sequences: fixture.capture.sequences,
        frameCounts,
        stills: [
          "00-connection.png",
          "01-approval.png",
          "02-imported-scan.png",
          "03-calibrated-scan.png",
          "04-proxy-and-case-source.png",
          "05-corrected-editable-case.png",
          "06-openusd-validated.png",
          "07-reopened.png",
          "08-final.png",
        ],
      },
    };
    const validationFixture = outputPlan.smoke ? structuredClone(fixture) : fixture;
    if (outputPlan.smoke) {
      validationFixture.capture.sequenceFrameCounts = Object.fromEntries(
        fixture.capture.sequences.map((folder) => [folder, smokeFrameCount]),
      );
    }
    validateCaptureEvidence(evidence, validationFixture);
    if (outputPlan.smoke) {
      smokeReceipt = evidence;
      completionMessage = `Reality Twin smoke capture complete (${smokeFrameCount} frames/sequence): ${captureRoot}`;
      return;
    }
    writeFileAtomically(outputPlan.stagedEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, captureRunId);
    pendingPromotion = {
      plan: outputPlan,
      assetEvidencePath: asset.assetEvidencePath,
    };
    completionMessage = `Reality Twin browser-authoritative capture complete: ${publicRoot}`;
    })(), failOnUnexpectedChildExit([stackMonitor, browserMonitor])]);
  } catch (error) {
    const tail = logs.join("").slice(-8_000);
    if (tail.trim()) console.error(tail);
    throw error;
  } finally {
    await receiptProbe?.dispose().catch(() => undefined);
    await Promise.allSettled(clients.map((client) => client.close()));
    cdp?.close();
    const cleanupResults = await Promise.allSettled([
      stopCaptureBrowser(browserMonitor, profile),
      stopManagedChild(stackMonitor),
    ]);
    const cleanupFailures = cleanupResults.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (cleanupFailures.length === 0 && profile) {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "Reality Twin capture cleanup failed.");
    if (smokeReceipt) {
      const browserCleanup = cleanupResults[0].status === "fulfilled" ? cleanupResults[0].value : undefined;
      const completedSmokeReceipt = {
        ...smokeReceipt,
        cleanup: {
          captureBrowser: browserCleanup,
          developmentStackExited: stackMonitor?.exited === true,
          captureProfileRemoved: profile ? !existsSync(profile) : true,
          verifiedAt: new Date().toISOString(),
        },
      };
      invariant(completedSmokeReceipt.cleanup.captureBrowser?.profileProcessesRemaining === 0
        && completedSmokeReceipt.cleanup.developmentStackExited
        && completedSmokeReceipt.cleanup.captureProfileRemoved,
      "Smoke capture cleanup receipt is incomplete.");
      writeFileAtomically(
        join(captureRoot, "smoke-evidence.json"),
        `${JSON.stringify(completedSmokeReceipt, null, 2)}\n`,
        captureRunId,
      );
    }
    cleanupComplete = true;
  }
  if (pendingPromotion) {
    promoteCaptureOutputsAfterCleanup(
      pendingPromotion.plan,
      pendingPromotion.assetEvidencePath,
      { cleanupComplete },
    );
  }
  if (completionMessage) console.log(completionMessage);
}

if (import.meta.url === new URL(`file://${resolve(process.argv[1] ?? "")}`).href) {
  await captureRealityTwinDemo();
}
