import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const outputRoot = resolve("video/public/emergency-city");
const CAPTURE_FPS = 30;
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1080;
const FRAME_CONTRACT = Object.freeze({
  "crisis-frames": 120,
  "prompt-frames": 60,
  "understand-frames": 90,
  "collision-frames": 120,
  "plan-frames": 90,
  "response-frames": 300,
  "undo-redo-frames": 90,
  "reopen-frames": 90,
  "final-frames": 150,
});
const frameFolders = Object.freeze(Object.keys(FRAME_CONTRACT));
const PLANNER_MODEL = process.env.SEMAFRAME_DEMO_PLANNER_MODEL ?? "gpt-5.5";
const CODEX_BIN = process.env.SEMAFRAME_CODEX_BIN ?? "codex";
const PLANNER_MAX_ATTEMPTS = 3;
const PLANNER_SCRIPT = resolve("scripts/emergency-city-real-planner.mjs");
const LOGIC_ONLY = process.env.SEMAFRAME_DEMO_LOGIC_ONLY === "1";

// `blank_stage` already owns a ground whose top surface is y=0. The V1 plinth
// also ended at y=0, which made the two faces fight in the depth buffer during
// an orbit. V3 treats these as physical height layers rather than tiny offsets.
const VISUAL_LAYERS = Object.freeze({
  stageGroundTopY: 0,
  plinthBottomY: 0,
  plinthTopY: 0.24,
  roadMainY: 0.268,
  roadCrossY: 0.282,
  destinationPadY: 0.29,
  safeBayY: 0.3,
  routeBlockedY: 0.304,
  routeOpenY: 0.318,
  laneMarkingCenterY: 0.338,
  roadDetailY: 0.352,
  cityBaseY: 0.24,
  minimumOverlappingSurfaceGapM: 0.012,
});

// These camera states are Workspace-authored presentation state, rather than
// post-production crops. Each shot therefore remains a truthful view of the
// same editable scene at its recorded revision. Targets deliberately leave the
// viewport data panel and bottom action control clear at native 1920x1080.
const CAMERA_PRESETS = Object.freeze({
  crisis: Object.freeze({
    position: Object.freeze({ x: 17.8, y: 19.5, z: 18.8 }),
    target: Object.freeze({ x: 0, y: 0.7, z: 0 }),
    fovDeg: 42,
    shot: "overhead",
  }),
  prompt: Object.freeze({
    position: Object.freeze({ x: 17.4, y: 8.8, z: 13.6 }),
    target: Object.freeze({ x: 0.5, y: 0.95, z: -0.4 }),
    fovDeg: 41,
    shot: "medium_wide",
  }),
  understand: Object.freeze({
    position: Object.freeze({ x: 3.2, y: 25.5, z: 10.4 }),
    target: Object.freeze({ x: 0, y: 0.45, z: -0.2 }),
    fovDeg: 40,
    shot: "overhead",
  }),
  collision: Object.freeze({
    // Look north along the street-tree row. The unsafe car's long x-axis then
    // protrudes beside the tree instead of being foreshortened behind it, while
    // the translucent contact volume still visibly overlaps the protected tree.
    position: Object.freeze({ x: 6.8, y: 5.6, z: -4.5 }),
    target: Object.freeze({ x: 6.55, y: 0.9, z: 3.65 }),
    fovDeg: 35,
    shot: "close_up",
  }),
  plan: Object.freeze({
    position: Object.freeze({ x: 4.5, y: 23.5, z: 12.6 }),
    target: Object.freeze({ x: -0.6, y: 0.45, z: 0 }),
    fovDeg: 40,
    shot: "overhead",
  }),
  response: Object.freeze({
    // High oblique view keeps the hospital, ambulance, all four displaced
    // blockers, and the full open corridor simultaneously legible. Projected
    // controls retain at least 95 px clearance at the native 1920x1080 frame.
    position: Object.freeze({ x: 18.05, y: 22.5, z: 10.5 }),
    target: Object.freeze({ x: -1, y: 0.7, z: -0.5 }),
    fovDeg: 42,
    shot: "overhead",
  }),
  reopen: Object.freeze({
    position: Object.freeze({ x: 14.8, y: 11.8, z: 15.6 }),
    target: Object.freeze({ x: -1.4, y: 0.7, z: -0.25 }),
    fovDeg: 40,
    shot: "medium_wide",
  }),
  final: Object.freeze({
    position: Object.freeze({ x: 13.4, y: 9.2, z: 13.8 }),
    target: Object.freeze({ x: -2.1, y: 0.9, z: -0.6 }),
    fovDeg: 37,
    shot: "medium",
  }),
});

const requestedScopes = [
  "workspace:read",
  "workspace:write",
  "workspace:history",
  "component:create",
  "component:update",
  "component:recipe_define",
  "component:invoke",
  "connector:write",
  "connector:bind",
  "event:connect",
  "view:present",
  "asset:import",
  "effect:data_read",
];

function browserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Chrome/Chromium was not found. Set BROWSER_EXECUTABLE.");
  return executable;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
    } catch { /* local services are still starting */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
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
    const id = this.nextId++;
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

async function poll(cdp, expression, label, timeoutMs = 15_000) {
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

function prepareOutput() {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  for (const folder of frameFolders) {
    mkdirSync(join(outputRoot, folder), { recursive: true });
  }
}

async function screenshot(cdp, format = "jpeg") {
  const result = await cdp.send("Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality: 94 } : {}),
    fromSurface: true,
    captureBeyondViewport: false,
  });
  return Buffer.from(result.data, "base64");
}

async function stabilizeWebGlFrame(cdp) {
  const status = await cdp.evaluate(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        resolve({ ok: false, reason: 'canvas_missing' });
        return;
      }
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) {
        resolve({ ok: false, reason: 'webgl_missing' });
        return;
      }
      gl.finish();
      resolve({ ok: !gl.isContextLost(), reason: gl.isContextLost() ? 'context_lost' : null });
    }));
  })`);
  if (!status?.ok) throw new Error(`WebGL frame did not stabilize: ${status?.reason ?? "unknown"}.`);
}

async function captureFrames(cdp, folder, options = {}) {
  const frameCount = options.frameCount ?? FRAME_CONTRACT[folder];
  if (!Number.isInteger(frameCount) || frameCount <= 0) throw new Error(`Invalid frame count for ${folder}.`);
  if (FRAME_CONTRACT[folder] !== undefined && frameCount !== FRAME_CONTRACT[folder]) {
    throw new Error(`${folder} must contain exactly ${FRAME_CONTRACT[folder]} frames, received ${frameCount}.`);
  }
  const directory = join(outputRoot, folder);
  for (let index = 0; index < frameCount; index += 1) {
    if (options.beforeFrame) await options.beforeFrame(index, frameCount);
    // Logic-only mode exercises every time-based semantic transition (including
    // the real pointer click, undo/redo, Save/Open, and session rotations) while
    // deliberately omitting the expensive native WebGL screenshots. It is an
    // explicit diagnostic mode and can never produce release evidence.
    if (LOGIC_ONLY) continue;
    // Every source image is a separately rendered 30fps sample. The two-RAF
    // barrier prevents a CDP screenshot from racing an OrbitControls update.
    await stabilizeWebGlFrame(cdp);
    writeFileSync(join(directory, `frame-${String(index).padStart(4, "0")}.jpg`), await screenshot(cdp));
  }
}

export function summarizeEmergencyCityValidation(spaceInspection, physicsInspection) {
  const spatialGraph = spaceInspection?.data?.spatial_graph;
  const physicsValidation = physicsInspection?.data?.physics_validation;
  const conflicts = Array.isArray(spatialGraph?.collision_conflicts)
    ? spatialGraph.collision_conflicts
    : [];
  const bodies = Array.isArray(physicsValidation?.bodies) ? physicsValidation.bodies : [];
  const enabledBodies = bodies.filter((body) => body?.enabled === true);
  const kinematicBodies = enabledBodies.filter((body) => body?.body_type === "kinematic");
  const issues = Array.isArray(physicsValidation?.issues) ? physicsValidation.issues : [];
  const reasons = [];
  if (spaceInspection?.ok !== true) reasons.push("space_inspection_failed");
  if (physicsInspection?.ok !== true) reasons.push("physics_inspection_failed");
  if (conflicts.length !== 0) reasons.push("collision_conflicts_present");
  if (physicsValidation?.feasible !== true) reasons.push("physics_not_feasible");
  if (enabledBodies.length === 0) reasons.push("no_enabled_physics_bodies");
  if (kinematicBodies.length !== 10) reasons.push("kinematic_vehicle_count_not_10");
  return {
    ok: reasons.length === 0,
    diagnostics: {
      reasons,
      spaceInspectionOk: spaceInspection?.ok === true,
      physicsInspectionOk: physicsInspection?.ok === true,
      collisionConflictCount: conflicts.length,
      collisionConflicts: conflicts.slice(0, 20),
      physicsFeasible: physicsValidation?.feasible === true,
      physicsVersion: physicsValidation?.version ?? null,
      physicsModel: physicsValidation?.model ?? null,
      physicsIssues: issues.slice(0, 20),
      enabledBodyCount: enabledBodies.length,
      kinematicBodyCount: kinematicBodies.length,
      enabledBodies: enabledBodies.map((body) => ({
        componentId: body.component_id ?? null,
        bodyType: body.body_type ?? null,
        stable: body.stable ?? null,
        grounded: body.grounded ?? null,
        stabilityReason: body.stability_reason ?? null,
      })),
    },
  };
}

async function canvasRect(cdp) {
  const rect = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  })()`);
  if (!rect) throw new Error("The 3D canvas was unavailable for the camera track.");
  return rect;
}

async function assertNativeCaptureViewport(cdp, label) {
  const metrics = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    const rect = canvas instanceof HTMLCanvasElement ? canvas.getBoundingClientRect() : null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      canvas: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
    };
  })()`);
  if (metrics?.viewport?.width !== CAPTURE_WIDTH || metrics?.viewport?.height !== CAPTURE_HEIGHT
    || !metrics.canvas
    || metrics.canvas.width < CAPTURE_WIDTH - 1 || metrics.canvas.height < CAPTURE_HEIGHT - 1
    || Math.abs(metrics.canvas.left) > 0.5 || Math.abs(metrics.canvas.top) > 0.5) {
    throw new Error(`${label} did not own the native ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT} capture surface: ${JSON.stringify(metrics)}.`);
  }
}

async function assertProjectedControlsInsideViewport(cdp, label) {
  const escaped = await cdp.evaluate(`(() => [...document.querySelectorAll('.workspace-projected-component')]
    .filter((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01
        && rect.width > 0 && rect.height > 0;
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        label: node.getAttribute('aria-label') ?? node.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? 'projected component',
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    })
    .filter((rect) => rect.left < -0.5 || rect.top < -0.5 || rect.right > window.innerWidth + 0.5 || rect.bottom > window.innerHeight + 0.5))()`);
  if (escaped.length) {
    throw new Error(`${label} contains cropped or half-visible projected controls: ${JSON.stringify(escaped)}.`);
  }
}

function smoothstep(progress) {
  const value = Math.max(0, Math.min(1, progress));
  return value * value * (3 - 2 * value);
}

async function captureDragTrack(cdp, folder, options = {}) {
  const frameCount = FRAME_CONTRACT[folder];
  const rect = await canvasRect(cdp);
  const startX = rect.left + rect.width * (options.startXRatio ?? 0.52);
  const startY = rect.top + rect.height * (options.startYRatio ?? 0.5);
  const deltaX = options.deltaX ?? 0;
  const deltaY = options.deltaY ?? 0;
  const arcY = options.arcY ?? 0;
  const button = options.button ?? "left";
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startX, y: startY });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button, clickCount: 1 });
  try {
    await captureFrames(cdp, folder, {
      frameCount,
      beforeFrame: async (index, count) => {
        const progress = smoothstep(index / Math.max(1, count - 1));
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: startX + deltaX * progress,
          y: startY + deltaY * progress + Math.sin(progress * Math.PI) * arcY,
          button,
          buttons: button === "left" ? 1 : 2,
        });
        if (options.beforeFrame) await options.beforeFrame(index, count, progress);
      },
    });
  } finally {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: startX + deltaX,
      y: startY + deltaY,
      button,
      clickCount: 1,
    });
  }
}

async function captureZoomTrack(cdp, folder, options = {}) {
  const frameCount = FRAME_CONTRACT[folder];
  const rect = await canvasRect(cdp);
  const x = rect.left + rect.width * (options.xRatio ?? 0.5);
  const y = rect.top + rect.height * (options.yRatio ?? 0.5);
  const totalDeltaY = options.totalDeltaY ?? -420;
  await captureFrames(cdp, folder, {
    frameCount,
    beforeFrame: async (index, count) => {
      if (index > 0) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY: totalDeltaY / Math.max(1, count - 1),
        });
      }
      if (options.beforeFrame) await options.beforeFrame(index, count);
    },
  });
}

async function captureResponseTrack(cdp, onClick) {
  const folder = "response-frames";
  const frameCount = FRAME_CONTRACT[folder];
  const rect = await canvasRect(cdp);
  const startX = rect.left + rect.width * 0.53;
  const startY = rect.top + rect.height * 0.52;
  const followStart = 92;
  const followEnd = 268;
  let following = false;
  try {
    await captureFrames(cdp, folder, {
      frameCount,
      beforeFrame: async (index) => {
        if (index === 45) await onClick();
        if (index === followStart) {
          following = true;
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startX, y: startY });
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "right", clickCount: 1 });
        }
        if (following && index >= followStart && index <= followEnd) {
          const progress = smoothstep((index - followStart) / (followEnd - followStart));
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: startX - 74 * progress,
            y: startY + 8 * progress + Math.sin(progress * Math.PI) * 7,
            button: "right",
            buttons: 2,
          });
        }
        if (following && index === followEnd) {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: startX - 74,
            y: startY + 8,
            button: "right",
            clickCount: 1,
          });
          following = false;
        }
      },
    });
  } finally {
    if (following) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: startX - 74, y: startY + 8, button: "right", clickCount: 1,
      });
    }
  }
}

async function pointerClickTextButton(cdp, text) {
  const point = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`Visible enabled button ${text} was not found.`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await delay(120);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await delay(90);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function enterImmersive(cdp) {
  if (!await cdp.evaluate("document.querySelector('.viewport-shell')?.classList.contains('is-immersive')")) {
    if (!await cdp.evaluate(clickButtonWithAriaLabel("Enter full screen"))) {
      throw new Error("The Workspace immersive full-screen control was unavailable.");
    }
  }
  await poll(cdp, "document.querySelector('.viewport-shell')?.classList.contains('is-immersive')", "immersive Workspace");
  await cdp.evaluate(`(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const exitControl = document.querySelector('.viewport-fullscreen-toggle');
    if (exitControl instanceof HTMLElement) {
      exitControl.style.opacity = '0';
      exitControl.style.pointerEvents = 'none';
    }
    return true;
  })()`);
  await delay(280);
}

async function captureFinalArc(cdp) {
  await captureDragTrack(cdp, "final-frames", {
    deltaX: 90,
    deltaY: 8,
    arcY: 12,
    startXRatio: 0.55,
    startYRatio: 0.48,
  });
}

async function connectAgent(cdp, label) {
  if (await cdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-disabled'))")) {
    if (!await cdp.evaluate(clickExactButton("Enable agent control"))) {
      throw new Error(`${label} could not enable Agent control.`);
    }
  }
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-waiting .agent-connection-url-wrap input'))", `${label} connection URL`);
  const connectionUrl = await cdp.evaluate("document.querySelector('.agent-connection-url-wrap input')?.value");
  if (typeof connectionUrl !== "string" || !connectionUrl.startsWith("http://127.0.0.1:")) {
    throw new Error(`${label} did not receive a loopback connection URL.`);
  }
  const client = new Client({ name: label, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connectionUrl)));
  const identity = {
    client_id: "emergency-city-hero-agent",
    client_name: label,
    requested_scopes: requestedScopes,
  };
  const pending = await callAgent(client, "get_workspace_instructions", identity);
  const approvalToken = pending.error?.details?.approval_token;
  if (pending.ok !== false || pending.error?.code !== "approval_pending" || typeof approvalToken !== "string") {
    throw new Error(`${label} did not enter explicit approval.`);
  }
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-approval'))", `${label} approval card`);
  if (!await cdp.evaluate(clickExactButton("Approve client"))) throw new Error(`${label} could not be approved.`);
  await poll(cdp, "!document.querySelector('.agent-connection-page.status-approval')", `${label} approval handoff`);
  const approvedSession = await issueApprovedAgentSession(client, {
    identity,
    approvalToken,
    label,
  });
  await poll(cdp, "document.querySelector('.hybrid-workspace-canvas')?.dataset.sceneEngineReady === 'true'", `${label} renderer ready`, 20_000);
  await poll(cdp, "Boolean(document.querySelector('.agent-workspace-controls.status-connected'))", `${label} Workspace`);
  const grantedScopes = approvedSession.grantedScopes;
  if (!grantedScopes.includes("effect:data_read")) {
    throw new Error("The emergency demo Agent did not receive explicit effect:data_read authorization.");
  }
  return {
    client,
    ...approvedSession,
    grantedScopes,
    // Keep the approval credential inside this closure. Long native captures
    // rotate short-lived Workspace sessions through the already-approved
    // offer instead of weakening the product-wide 30-minute default.
    refreshSession: () => issueApprovedAgentSession(client, {
      identity,
      approvalToken,
      label,
    }),
  };
}

export async function issueApprovedAgentSession(client, { identity, approvalToken, label }) {
  const instructions = await callAgent(client, "get_workspace_instructions", {
    ...identity,
    approval_token: approvalToken,
  });
  const sessionToken = instructions.data?.session_token;
  const instructionDigest = instructions.data?.guide_digest;
  const sessionExpiresAt = instructions.data?.session_expires_at;
  const expiresAtMs = typeof sessionExpiresAt === "string" ? Date.parse(sessionExpiresAt) : Number.NaN;
  if (!instructions.ok
    || typeof sessionToken !== "string"
    || typeof instructionDigest !== "string"
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= Date.now()) {
    throw new Error(`${label} handshake failed: ${instructions.error?.code ?? "invalid_response"}`);
  }
  return {
    session: {
      session_token: sessionToken,
      instruction_digest: instructionDigest,
    },
    sessionExpiresAt,
    grantedScopes: instructions.data.granted_scopes ?? [],
  };
}

async function captureWorkspaceProject(cdp, key) {
  await cdp.evaluate(`(() => {
    window.__emergencyCitySavedProjects ??= {};
    window.__emergencyCitySaveKey = ${JSON.stringify(key)};
    delete window.__emergencyCitySavedProjects[window.__emergencyCitySaveKey];
    if (!window.__emergencyCityObjectUrlHooked) {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (value) => {
        const saveKey = window.__emergencyCitySaveKey;
        if (saveKey && value instanceof Blob) {
          void value.text().then((contents) => {
            window.__emergencyCitySavedProjects[saveKey] = contents;
          });
        }
        return createObjectURL(value);
      };
      window.__emergencyCityObjectUrlHooked = true;
    }
    document.querySelector('button[aria-label="Save project"]')?.click();
  })()`);
  await poll(cdp, `Boolean(window.__emergencyCitySavedProjects?.[${JSON.stringify(key)}])`, `captured ${key} project`);
  return cdp.evaluate(`window.__emergencyCitySavedProjects[${JSON.stringify(key)}]`);
}

function canonicalProjectValue(value) {
  if (Array.isArray(value)) return value.map(canonicalProjectValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalProjectValue(value[key])]));
}

function capturedControlRoutes(project, sourceComponentId) {
  const connections = project?.workspace?.connections;
  if (!Array.isArray(connections)) throw new Error("Saved project has no serialized Workspace connections.");
  return connections
    .filter((entry) => Array.isArray(entry) && entry.length === 2)
    .filter(([, connection]) => (
      connection?.kind === "event_connection" && connection.sourceComponentId === sourceComponentId
    ))
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(canonicalProjectValue);
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalProjectValue(value))).digest("hex")}`;
}

function assertExactFrameContract() {
  for (const [folder, expected] of Object.entries(FRAME_CONTRACT)) {
    const directory = join(outputRoot, folder);
    const frames = readdirSync(directory).filter((name) => /^frame-\d{4}\.jpg$/u.test(name)).sort();
    if (frames.length !== expected
      || frames[0] !== "frame-0000.jpg"
      || frames.at(-1) !== `frame-${String(expected - 1).padStart(4, "0")}.jpg`) {
      throw new Error(`${folder} violated the exact ${expected}-frame source contract.`);
    }
  }
}

function componentRef(capability, typeId) {
  const entry = capability.component_types.find((candidate) => candidate.typeId === typeId);
  if (!entry) throw new Error(`The Workspace did not advertise ${typeId}.`);
  return { typeId: entry.typeId, version: entry.version, digest: entry.digest };
}

function world(x, y, z, rotation = { x: 0, y: 0, z: 0 }) {
  return { space: "world3d", position: { x, y, z }, rotation, scale: { x: 1, y: 1, z: 1 } };
}

function target(x, y, z, rotation = { x: 0, y: 0, z: 0 }) {
  return { space: "world3d", position: { x, y, z }, rotation };
}

function material(baseColor, options = {}) {
  return {
    baseColor,
    metallic: options.metallic ?? 0.08,
    roughness: options.roughness ?? 0.72,
    opacity: options.opacity ?? 1,
    emissiveColor: options.emissiveColor ?? "#000000",
    emissiveIntensity: options.emissiveIntensity ?? 0,
  };
}

const noCollision = Object.freeze({ enabled: false, role: "none", shape: "asset_bounds", margin: 0 });
const solidCollision = Object.freeze({ enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02 });
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
const enabledStaticPhysics = Object.freeze({
  ...disabledPhysics,
  enabled: true,
});
const enabledKinematicPhysics = Object.freeze({
  ...enabledStaticPhysics,
  bodyType: "kinematic",
});

function assemblyOperation(id, label, placement, ref, options = {}) {
  return {
    op: "create_component",
    op_id: `create_${options.key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    id,
    component_type: ref,
    label,
    props: {
      description: options.description ?? label,
      collisionPolicy: options.collisionPolicy ?? "external_only",
    },
    placement,
    ...(options.parentId ? { parent_id: options.parentId } : {}),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(options.transition ? { transition: options.transition } : {}),
    tags: options.tags ?? ["emergency-city", "assembly"],
  };
}

function primitiveOperation(id, label, geometry, placement, ref, options = {}) {
  return {
    op: "create_component",
    op_id: `create_${options.key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    id,
    component_type: ref,
    label,
    props: {
      geometry,
      material: options.material ?? material("#8796A8"),
      collision: options.collision ?? noCollision,
      physics: options.physics ?? (
        options.collision?.enabled === true && options.collision?.role === "solid"
          ? enabledStaticPhysics
          : disabledPhysics
      ),
      castShadow: options.castShadow ?? false,
      receiveShadow: options.receiveShadow ?? false,
    },
    placement,
    ...(options.parentId ? { parent_id: options.parentId } : {}),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(options.transition ? { transition: options.transition } : {}),
    tags: options.tags ?? ["emergency-city", "parametric"],
  };
}

function vehicleOperations({
  ids,
  label,
  placement,
  assemblyRef,
  primitiveRef,
  color,
  kind = "car",
  physics = enabledKinematicPhysics,
  transition,
}) {
  const [rootId, bodyId, cabinId, wheelFrontLeftId, wheelFrontRightId, wheelRearLeftId, wheelRearRightId] = ids;
  const isBus = kind === "bus";
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const bodySize = isBus ? { x: 3.2, y: 0.66, z: 1.08 } : { x: 1.95, y: 0.46, z: 0.94 };
  const cabinSize = isBus ? { x: 2.65, y: 0.56, z: 0.96 } : { x: 1.08, y: 0.42, z: 0.78 };
  const wheelX = isBus ? 1.05 : 0.62;
  const wheelZ = isBus ? 0.57 : 0.5;
  return [
    assemblyOperation(rootId, label, placement, assemblyRef, {
      key: `${key}_root`,
      transition,
      tags: ["emergency-city", "vehicle", kind, "movable"],
    }),
    primitiveOperation(bodyId, `${label} body`, { kind: "box", sizeM: bodySize }, world(0, isBus ? 0.42 : 0.33, 0), primitiveRef, {
      key: `${key}_body`,
      parentId: rootId,
      material: material(color, { metallic: 0.46, roughness: 0.3 }),
      collision: solidCollision,
      physics,
      castShadow: true,
      receiveShadow: true,
      transition,
      tags: ["emergency-city", "vehicle-part", "collision-solid"],
    }),
    primitiveOperation(cabinId, `${label} cabin`, { kind: "box", sizeM: cabinSize }, world(isBus ? 0 : -0.08, isBus ? 0.98 : 0.73, 0), primitiveRef, {
      key: `${key}_cabin`,
      parentId: rootId,
      material: material(isBus ? "#9ED3E5" : "#AFD2E2", {
        metallic: 0.56,
        roughness: 0.16,
        opacity: 0.88,
        emissiveColor: "#1E6687",
        emissiveIntensity: 0.18,
      }),
      collision: solidCollision,
      physics,
      castShadow: true,
      transition,
      tags: ["emergency-city", "vehicle-part", "collision-solid"],
    }),
    ...[
      [wheelFrontLeftId, wheelX, wheelZ, "front left"],
      [wheelFrontRightId, wheelX, -wheelZ, "front right"],
      [wheelRearLeftId, -wheelX, wheelZ, "rear left"],
      [wheelRearRightId, -wheelX, -wheelZ, "rear right"],
    ].filter(([id]) => Boolean(id)).map(([id, x, z, positionLabel], index) => primitiveOperation(
      id,
      `${label} ${positionLabel} wheel`,
      { kind: "cylinder", radiusM: isBus ? 0.25 : 0.2, heightM: 0.14, axis: "z" },
      world(x, isBus ? 0.27 : 0.22, z),
      primitiveRef,
      {
        key: `${key}_wheel_${index + 1}`,
        parentId: rootId,
        material: material("#111820", { metallic: 0.18, roughness: 0.92 }),
        castShadow: true,
        transition,
        tags: ["emergency-city", "vehicle-part", "wheel"],
      },
    )),
  ];
}

function idMap(names, ids) {
  if (names.length !== ids.length) throw new Error(`Expected ${names.length} reserved IDs, received ${ids.length}.`);
  return Object.fromEntries(names.map((name, index) => [name, ids[index]]));
}

function plannerComponentDefinitions(city, foundation) {
  return [
    { id: city.button, role: "human_editable_control", allowed_actions: [], allowed_events: ["pressed"] },
    { id: city.blueRoot, role: "corridor_blocker_candidate", allowed_actions: ["move_to"], size_m: { x: 2.05, y: 1.25, z: 1.02 } },
    { id: city.taxiRoot, role: "corridor_blocker_candidate", allowed_actions: ["move_to"], size_m: { x: 2.05, y: 1.25, z: 1.02 } },
    { id: city.busRoot, role: "corridor_blocker_candidate", allowed_actions: ["move_to"], size_m: { x: 3.3, y: 1.62, z: 1.14 } },
    { id: city.redRoot, role: "corridor_blocker_candidate", allowed_actions: ["move_to"], size_m: { x: 2.05, y: 1.25, z: 1.02 } },
    { id: city.ambulanceRoot, role: "emergency_vehicle", allowed_actions: ["move_to"], size_m: { x: 2.85, y: 1.65, z: 1.2 } },
    { id: foundation.corridorBlocked, role: "blocked_route_visual", allowed_actions: ["hide"] },
    { id: foundation.corridorOpen, role: "open_route_visual", allowed_actions: ["show"] },
    { id: city.signalRedA, role: "stop_signal", allowed_actions: ["hide"] },
    { id: city.signalRedB, role: "stop_signal", allowed_actions: ["hide"] },
    { id: city.signalGreenA, role: "go_signal", allowed_actions: ["show"] },
    { id: city.signalGreenB, role: "go_signal", allowed_actions: ["show"] },
    { id: city.hospitalRoot, role: "hospital_destination", allowed_actions: [] },
    { id: city.safeBlue, role: "civilian_safe_bay", allowed_actions: [] },
    { id: city.safeTaxi, role: "civilian_safe_bay", allowed_actions: [] },
    { id: city.safeBus, role: "civilian_safe_bay", allowed_actions: [] },
    { id: city.safeRed, role: "civilian_safe_bay", allowed_actions: [] },
    { id: city.tree3Trunk, role: "protected_static_obstacle", allowed_actions: [] },
  ];
}

async function buildEmergencyPlannerContext({
  client,
  session,
  authority,
  city,
  foundation,
  feedRead,
  readData,
  validationFeedback,
}) {
  const definitions = plannerComponentDefinitions(city, foundation);
  const inspectedComponents = [];
  for (const definition of definitions) {
    const inspection = await callAgent(client, "inspect_workspace_component", {
      ...session,
      component_id: definition.id,
    });
    if (!inspection.ok || !inspection.data?.component) {
      throw new Error(`Planner could not inspect authoritative component ${definition.id}: ${inspection.error?.code ?? "missing_component_payload"} ${inspection.error?.message ?? ""}`);
    }
    const component = inspection.data.component;
    const placement = component.placement?.space === "world3d" ? component.placement : undefined;
    inspectedComponents.push({
      id: definition.id,
      label: component.label,
      role: definition.role,
      allowed_actions: definition.allowed_actions,
      ...(definition.allowed_events ? { allowed_events: definition.allowed_events } : {}),
      ...(definition.size_m ? { geometry_size_m: definition.size_m } : {}),
      ...(placement ? { placement } : {}),
      visibility: component.visibility,
    });
  }
  const space = await callAgent(client, "inspect_workspace_space", session);
  if (!space.ok || !space.data?.spatial_graph) {
    throw new Error("Planner could not inspect the authoritative SemaFrame Spatial Graph.");
  }
  const graph = space.data.spatial_graph;
  if (graph.workspace_id !== authority.workspace_id
    || graph.workspace_revision !== authority.revision) {
    throw new Error(`Planner authority drifted before inference: ${JSON.stringify({
      envelopeWorkspaceId: authority.workspace_id,
      envelopeRevision: authority.revision,
      graphWorkspaceId: graph.workspace_id,
      graphRevision: graph.workspace_revision,
    })}`);
  }
  return {
    context_version: "1.0",
    authority: {
      workspace_id: authority.workspace_id,
      workspace_revision: authority.revision,
      registry_digest: authority.registry_digest,
      dispatch_snapshot_hash: feedRead.data.snapshot.content_hash,
    },
    mission: {
      goal: "Use the current dispatch snapshot and spatial layout to clear every civilian blocker from the emergency avenue, send AMB-07 to the hospital arrival zone, switch both signals and route visuals, and compile the result behind one human-editable pressed control.",
      constraints: {
        eta_seconds: readData.incident.etaSeconds,
        current_clearance_m: readData.incident.currentClearanceM,
        required_clearance_m: readData.incident.requiredClearanceM,
        route_status: readData.route.status,
        collision_must_remain_enabled: true,
      },
      operational_zones: {
        emergency_avenue: {
          center_z_m: -0.9,
          blocked_half_width_m: 2.2,
          instruction: "Every civilian blocker endpoint must leave this band completely.",
        },
        civilian_safe_bay_component_ids: [city.safeBlue, city.safeTaxi, city.safeBus, city.safeRed],
        hospital_arrival_zone: {
          min: { x: -10.9, y: VISUAL_LAYERS.cityBaseY - 0.01, z: -1.8 },
          max: { x: -8.0, y: VISUAL_LAYERS.cityBaseY + 0.01, z: 0.1 },
        },
      },
      decision_boundary: "Safe-bay labels and geometry are scene facts, not approved endpoints. The model chooses assignments and exact endpoints; the host separately preflights every proposal at this exact revision.",
    },
    components: inspectedComponents,
    dispatch_snapshot: {
      resource_id: feedRead.data.resource_id,
      content_hash: feedRead.data.snapshot.content_hash,
      retrieved_at: feedRead.data.snapshot.retrieved_at,
      snapshot_authority: feedRead.data.snapshot_authority,
      data: feedRead.data.snapshot.data,
      untrusted_data_notice: feedRead.data.untrusted_data_notice,
    },
    spatial_graph: graph,
    ...(validationFeedback ? { validation_feedback: validationFeedback } : {}),
  };
}

async function runEmergencyPlanner(context, attempt) {
  const plannerRoot = join(outputRoot, "planner");
  const attemptRoot = join(plannerRoot, `attempt-${String(attempt).padStart(2, "0")}`);
  const plannerOutput = join(attemptRoot, "output");
  mkdirSync(plannerOutput, { recursive: true });
  const contextPath = join(attemptRoot, "planner-context.json");
  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      PLANNER_SCRIPT,
      "--context", contextPath,
      "--out", plannerOutput,
      "--model", PLANNER_MODEL,
      "--codex-bin", CODEX_BIN,
      "--timeout-ms", "240000",
    ], {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectRun(error);
      else resolveRun(value);
    };
    const append = (current, chunk, stream) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > 64 * 1024 * 1024) {
        child.kill("SIGTERM");
        finish(new Error(`Live Codex emergency planner ${stream} exceeded 64 MiB.`));
      }
      return next;
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      finish(new Error(`Live Codex emergency planner timed out after 260000 ms (attempt ${attempt}).`));
    }, 260_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
    child.on("error", (error) => finish(new Error(`Could not start live Codex emergency planner: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish(new Error(`Live Codex emergency planner failed without fallback (attempt ${attempt}, ${code ?? signal ?? "unknown"}): ${stderr.trim() || "unknown failure"}`));
        return;
      }
      finish(undefined, { stdout, stderr });
    });
  });
  const readPlannerJSON = (name) => JSON.parse(readFileSync(join(plannerOutput, name), "utf8"));
  return {
    attempt,
    contextPath,
    outputDirectory: plannerOutput,
    stdout: result.stdout.trim(),
    plan: readPlannerJSON("emergency-plan.json"),
    manifest: readPlannerJSON("planner-run.json"),
    truthWindow: readPlannerJSON("truth-window-events.json"),
  };
}

function nearlyEqual(left, right, epsilon = 1e-6) {
  return Math.abs(left - right) <= epsilon;
}

function compileEmergencyPlan({ plannerRun, context, city, foundation }) {
  const plan = plannerRun.plan;
  const expectedBlockers = new Set([city.blueRoot, city.taxiRoot, city.busRoot, city.redRoot]);
  const selectedBlockers = new Set(plan.blockers.map((blocker) => blocker.component_id));
  if (selectedBlockers.size !== expectedBlockers.size
    || [...expectedBlockers].some((id) => !selectedBlockers.has(id))) {
    throw new Error("The model plan did not identify exactly the civilian components occupying the emergency avenue.");
  }
  if (plan.control.source_component_id !== city.button || plan.control.source_event !== "pressed") {
    throw new Error("The model plan did not retain the visible human-editable pressed control.");
  }

  const moverDefinitions = new Map(plannerComponentDefinitions(city, foundation)
    .filter((definition) => definition.size_m)
    .map((definition) => [definition.id, definition]));
  const requiredMoveTargets = new Set([...expectedBlockers, city.ambulanceRoot]);
  const moveActions = plan.control.actions.filter((action) => action.action === "move_to");
  const actualMoveTargets = new Set(moveActions.map((action) => action.target_component_id));
  if (actualMoveTargets.size !== requiredMoveTargets.size
    || [...requiredMoveTargets].some((id) => !actualMoveTargets.has(id))) {
    throw new Error("The model plan did not move every blocker and AMB-07 exactly once.");
  }

  const requiredStateActions = new Map([
    [foundation.corridorBlocked, "hide"],
    [foundation.corridorOpen, "show"],
    [city.signalRedA, "hide"],
    [city.signalRedB, "hide"],
    [city.signalGreenA, "show"],
    [city.signalGreenB, "show"],
  ]);
  for (const [targetId, requiredAction] of requiredStateActions) {
    if (!plan.control.actions.some((action) => (
      action.target_component_id === targetId && action.action === requiredAction
    ))) {
      throw new Error(`The model plan omitted required scene state ${requiredAction} on ${targetId}.`);
    }
  }

  const safeBaySizes = new Map([
    [city.safeBlue, { x: 2.3, z: 1.35 }],
    [city.safeTaxi, { x: 2.3, z: 1.35 }],
    [city.safeBus, { x: 3.6, z: 1.35 }],
    [city.safeRed, { x: 2.3, z: 1.35 }],
  ]);
  const safeBayPositions = context.components
    .filter((component) => component.role === "civilian_safe_bay")
    .map((component) => ({
      id: component.id,
      position: component.placement?.position,
      size: safeBaySizes.get(component.id),
    }))
    .filter((entry) => entry.position && entry.size);
  const claimedBays = new Set();
  const endpoints = moveActions.map((action, index) => {
    const definition = moverDefinitions.get(action.target_component_id);
    const targetPlacement = action.input.target;
    if (!definition || !targetPlacement || targetPlacement.space !== "world3d") {
      throw new Error(`Model action ${action.action_id} has no compilable world3d endpoint.`);
    }
    const position = targetPlacement.position;
    const sourcePlacement = context.components.find((component) => component.id === action.target_component_id)?.placement;
    if (!nearlyEqual(position.y, VISUAL_LAYERS.cityBaseY, 0.011)) {
      throw new Error(`Model action ${action.action_id} did not preserve the ground-contact origin.`);
    }
    if (!sourcePlacement || ["x", "y", "z"].some((axis) => (
      !nearlyEqual(targetPlacement.rotation[axis], sourcePlacement.rotation[axis])
    ))) {
      throw new Error(`Model action ${action.action_id} rotated a vehicle; this demo validates axis-aligned endpoint volumes.`);
    }
    if (action.target_component_id === city.ambulanceRoot) {
      const zone = context.mission.operational_zones.hospital_arrival_zone;
      const halfX = definition.size_m.x / 2;
      const halfZ = definition.size_m.z / 2;
      if (position.x - halfX < zone.min.x || position.x + halfX > zone.max.x
        || position.y < zone.min.y || position.y > zone.max.y
        || position.z - halfZ < zone.min.z || position.z + halfZ > zone.max.z) {
        throw new Error(`Model action ${action.action_id} missed the hospital arrival zone.`);
      }
    } else {
      const corridorEdgeDistance = Math.abs(
        position.z - context.mission.operational_zones.emergency_avenue.center_z_m,
      ) - definition.size_m.z / 2;
      if (corridorEdgeDistance < context.mission.operational_zones.emergency_avenue.blocked_half_width_m) {
        throw new Error(`Model action ${action.action_id} left a civilian vehicle inside the emergency avenue.`);
      }
      const nearestBay = safeBayPositions
        .map((bay) => ({ ...bay, distance: Math.hypot(position.x - bay.position.x, position.z - bay.position.z) }))
        .sort((left, right) => left.distance - right.distance)[0];
      const fitsBay = nearestBay
        && Math.abs(position.x - nearestBay.position.x) + definition.size_m.x / 2 <= nearestBay.size.x / 2 + 0.02
        && Math.abs(position.z - nearestBay.position.z) + definition.size_m.z / 2 <= nearestBay.size.z / 2 + 0.02;
      if (!nearestBay || !fitsBay || claimedBays.has(nearestBay.id)) {
        throw new Error(`Model action ${action.action_id} did not choose a distinct visible safe bay.`);
      }
      claimedBays.add(nearestBay.id);
    }
    const size = definition.size_m;
    const candidatePlacement = {
      ...targetPlacement,
      position: { ...position, y: position.y + size.y / 2 },
    };
    const routeTarget = {
      space: targetPlacement.space,
      position: targetPlacement.position,
      rotation: targetPlacement.rotation,
    };
    return Object.freeze({
      actionId: action.action_id,
      rationale: action.rationale,
      label: context.components.find((component) => component.id === action.target_component_id)?.label
        ?? action.target_component_id,
      targetId: action.target_component_id,
      size,
      placement: candidatePlacement,
      target: routeTarget,
      finalPosition: Object.freeze({ ...position }),
      finalRotation: Object.freeze({ ...targetPlacement.rotation }),
      finalScale: Object.freeze({ ...targetPlacement.scale }),
      sequence: index,
    });
  });

  for (let leftIndex = 0; leftIndex < endpoints.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < endpoints.length; rightIndex += 1) {
      const left = endpoints[leftIndex];
      const right = endpoints[rightIndex];
      const overlapsX = Math.abs(left.finalPosition.x - right.finalPosition.x) < (left.size.x + right.size.x) / 2 + 0.04;
      const overlapsZ = Math.abs(left.finalPosition.z - right.finalPosition.z) < (left.size.z + right.size.z) / 2 + 0.04;
      if (overlapsX && overlapsZ) {
        throw new Error(`Model endpoints overlap each other: ${left.actionId} and ${right.actionId}.`);
      }
    }
  }

  const moveRoutes = endpoints.map((endpoint, index) => ({
    actionId: endpoint.actionId,
    connectionId: `EVENT_model_${endpoint.actionId}`.replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 180),
    targetId: endpoint.targetId,
    target: endpoint.target,
    transition: endpoint.targetId === city.ambulanceRoot
      ? { durationMs: 5_200, delayMs: 1_100, easing: "ease_in_out" }
      : { durationMs: 2_400 + index * 180, delayMs: index * 140, easing: "ease_out" },
  }));
  const visibilityRoutes = plan.control.actions
    .filter((action) => action.action === "show" || action.action === "hide")
    .map((action, index) => ({
      actionId: action.action_id,
      connectionId: `EVENT_model_${action.action_id}`.replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 180),
      targetId: action.target_component_id,
      action: action.action,
      transition: {
        durationMs: action.action === "show" ? 520 : 380,
        ...(action.action === "show" ? { delayMs: 180 + index * 20 } : {}),
        easing: "ease_out",
      },
    }));
  return Object.freeze({
    source: "codex_cli_live",
    plannerRun,
    endpoints: Object.freeze(endpoints),
    safeCandidates: Object.freeze(endpoints.map((endpoint) => ({
      actionId: endpoint.actionId,
      targetId: endpoint.targetId,
      label: endpoint.label,
      size: endpoint.size,
      placement: endpoint.placement,
    }))),
    moveRoutes: Object.freeze(moveRoutes),
    visibilityRoutes: Object.freeze(visibilityRoutes),
  });
}

function publishFinalPlannerArtifacts(plannerRun) {
  const finalDirectory = join(outputRoot, "planner", "final");
  mkdirSync(finalDirectory, { recursive: true });
  copyFileSync(plannerRun.contextPath, join(finalDirectory, "planner-context.json"));
  for (const name of ["emergency-plan.json", "codex-trace.raw.jsonl", "truth-window-events.json", "planner-run.json"]) {
    copyFileSync(join(plannerRun.outputDirectory, name), join(finalDirectory, name));
  }
  return finalDirectory;
}

export async function captureEmergencyCityDemo() {
  prepareOutput();
  const gatewayPort = await freePort();
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const appUrl = `http://127.0.0.1:${vitePort}/`;
  const profile = mkdtempSync(join(tmpdir(), "semaframe-emergency-city-"));
  const stack = spawn("npm", ["run", "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SEMAFRAME_AGENT_GATEWAY_PORT: String(gatewayPort),
      SEMAFRAME_AGENT_GATEWAY_PUBLIC_URL: gatewayUrl,
      SEMAFRAME_AGENT_VITE_PORT: String(vitePort),
    },
  });
  const browser = spawn(browserExecutable(), [
    "--headless=new",
    "--disable-gpu-sandbox",
    "--enable-webgl",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--hide-scrollbars",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });
  const logs = [];
  stack.stdout.on("data", (chunk) => logs.push(String(chunk)));
  stack.stderr.on("data", (chunk) => logs.push(String(chunk)));
  let cdp;
  let client;

  try {
    await waitForHttp(`${gatewayUrl}/healthz`);
    await waitForHttp(appUrl);
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);
    const browserTarget = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(appUrl)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    cdp = new Cdp(browserTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: appUrl });
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "Agent connection gate");
    const connected = await connectAgent(cdp, "Emergency City Hero Agent");
    client = connected.client;
    let session = connected.session;
    const sessionLifecycle = [{
      phase: "initial",
      issuedAt: new Date().toISOString(),
      expiresAt: connected.sessionExpiresAt,
    }];
    const refreshSession = async (phase) => {
      const previousToken = session.session_token;
      const refreshed = await connected.refreshSession();
      if (refreshed.session.session_token === previousToken) {
        throw new Error(`Workspace session rotation did not issue a fresh token at ${phase}.`);
      }
      if (!refreshed.grantedScopes.includes("effect:data_read")) {
        throw new Error(`Workspace session rotation lost effect:data_read at ${phase}.`);
      }
      session = refreshed.session;
      sessionLifecycle.push({
        phase,
        issuedAt: new Date().toISOString(),
        expiresAt: refreshed.sessionExpiresAt,
      });
    };
    const initialInspection = await callAgent(client, "inspect_workspace", session);
    if (!initialInspection.ok || initialInspection.data?.workspace_summary?.component_count !== 0) {
      throw new Error("The emergency-city capture did not start from an empty Workspace.");
    }

    const begin = async (intent, count = 0) => {
      const prepared = await callAgent(client, "begin_workspace_update", {
        ...session,
        intent,
        ...(count ? { requested_component_ids: count } : {}),
      });
      if (!prepared.ok) throw new Error(`Could not prepare ${intent}: ${prepared.error?.code}`);
      return prepared.data;
    };
    const submitResult = async (prepared, operations) => callAgent(client, "submit_workspace_batch", {
      ...session,
      transaction_token: prepared.transaction_token,
      batch: { ...prepared.envelope, operations },
    });
    const submit = async (prepared, operations) => {
      const result = await submitResult(prepared, operations);
      if (!result.ok) throw new Error(`Workspace update failed: ${result.error?.code} ${result.error?.message ?? ""}`);
      return result.data;
    };

    await enterImmersive(cdp);
    await assertNativeCaptureViewport(cdp, "Initial immersive Workspace");
    const stagePreparation = await begin("Create a 30 metre miniature-city stage", 1);
    const stageId = stagePreparation.reserved_component_ids[0];
    await submit(stagePreparation, [{
      op: "create_component",
      op_id: "create_emergency_city_stage",
      id: stageId,
      component_type: componentRef(stagePreparation.capability_manifest, "stage-3d"),
      label: "Emergency City digital twin",
      props: {
        environmentPreset: "blank_stage",
        dimensions: { width: 32, height: 10, depth: 22 },
        background: "#07101B",
        gridVisible: false,
        lighting: {
          preset: "emergency_city_architectural_maquette",
          exposure: 1.08,
          lights: [
            { id: "city_fill", kind: "ambient", intensity: 0.58, color: "#AFC2D2" },
            { id: "city_key", kind: "directional", intensity: 1.92, color: "#FFE5BD", position: { x: -9, y: 14, z: 7 }, target: { x: -1, y: 0.8, z: 0 } },
            { id: "city_rim", kind: "directional", intensity: 0.96, color: "#79B5E8", position: { x: 11, y: 8, z: -10 }, target: { x: 0, y: 0.9, z: 0 } },
            { id: "hospital_welcome", kind: "point", intensity: 22, color: "#8FD8FF", position: { x: -9.8, y: 3.2, z: -2.7 } },
            { id: "junction_warmth", kind: "point", intensity: 11, color: "#FFD08A", position: { x: 0, y: 4.8, z: 1.4 } },
          ],
        },
      },
      placement: world(0, 0, 0),
      transition: { durationMs: 500, easing: "ease_out" },
      tags: ["emergency-city", "stage", "synthetic-baseline"],
    }]);

    const presentCamera = async (name) => {
      const camera = CAMERA_PRESETS[name];
      if (!camera) throw new Error(`Unknown emergency-city camera preset ${name}.`);
      const prepared = await begin(`Present the ${name} architectural-maquette camera`);
      await submit(prepared, [{
        op: "update_component",
        op_id: `present_${name}_camera`,
        id: stageId,
        patch: { props: { activeCamera: camera } },
        transition: { durationMs: 620, easing: "ease_in_out" },
      }]);
      await delay(760);
      await stabilizeWebGlFrame(cdp);
    };

    const foundationNames = [
      "ground", "roadMain", "roadCross", "corridorBlocked", "corridorOpen",
      "mark1", "mark2", "mark3", "mark4", "mark5", "mark6", "mark7",
      "curbNorth", "curbSouth",
      "crosswalk1", "crosswalk2", "crosswalk3", "crosswalk4", "crosswalk5", "crosswalk6",
      "sidewalkNorth", "sidewalkSouth",
      "plinthEdgeNorth", "plinthEdgeSouth", "plinthEdgeEast", "plinthEdgeWest",
      "stopBarWest", "stopBarEast",
      "lampPole1", "lampPole2", "lampPole3", "lampPole4",
      "lampGlow1", "lampGlow2", "lampGlow3", "lampGlow4",
      "hospitalArrivalPad",
    ];
    const foundationPreparation = await begin("Lay out the miniature city roads and emergency corridor", foundationNames.length);
    const foundation = idMap(foundationNames, foundationPreparation.reserved_component_ids);
    const foundationPrimitiveRef = componentRef(foundationPreparation.capability_manifest, "spatial-primitive");
    const reveal = { durationMs: 900, easing: "ease_out" };
    const foundationOperations = [
      primitiveOperation(foundation.ground, "Miniature city plinth", { kind: "box", sizeM: { x: 30, y: 0.24, z: 20 } }, world(0, 0.12, 0), foundationPrimitiveRef, {
        material: material("#15212B", { metallic: 0.22, roughness: 0.8 }),
        castShadow: true,
        receiveShadow: true,
        transition: reveal,
        tags: ["emergency-city", "ground"],
      }),
      primitiveOperation(foundation.roadMain, "Central emergency avenue", { kind: "plane", sizeM: { x: 28, y: 4.4 }, normalAxis: "y" }, world(0, VISUAL_LAYERS.roadMainY, 0), foundationPrimitiveRef, {
        material: material("#202B34", { metallic: 0.04, roughness: 0.96 }),
        receiveShadow: true,
        transition: reveal,
        tags: ["emergency-city", "road", "main-corridor"],
      }),
      primitiveOperation(foundation.roadCross, "Market Street junction", { kind: "plane", sizeM: { x: 5, y: 18 }, normalAxis: "y" }, world(0, VISUAL_LAYERS.roadCrossY, 0), foundationPrimitiveRef, {
        material: material("#202B34", { metallic: 0.04, roughness: 0.96 }),
        receiveShadow: true,
        transition: reveal,
        tags: ["emergency-city", "road", "junction"],
      }),
      primitiveOperation(foundation.corridorBlocked, "Blocked emergency route", { kind: "plane", sizeM: { x: 22.8, y: 1.46 }, normalAxis: "y" }, world(0.1, VISUAL_LAYERS.routeBlockedY, -0.9), foundationPrimitiveRef, {
        material: material("#E13456", { opacity: 0.58, emissiveColor: "#FF214F", emissiveIntensity: 1.55 }),
        transition: reveal,
        tags: ["emergency-city", "route", "blocked"],
      }),
      primitiveOperation(foundation.corridorOpen, "Open emergency route", { kind: "plane", sizeM: { x: 22.8, y: 1.46 }, normalAxis: "y" }, world(0.1, VISUAL_LAYERS.routeOpenY, -0.9), foundationPrimitiveRef, {
        material: material("#16CF7D", { opacity: 0.76, emissiveColor: "#2DFF96", emissiveIntensity: 1.45 }),
        visibility: "hidden",
        transition: reveal,
        tags: ["emergency-city", "route", "open"],
      }),
      ...[-9, -6, -3, 0, 3, 6, 9].map((x, index) => primitiveOperation(
        foundation[`mark${index + 1}`],
        `Avenue lane marker ${index + 1}`,
        { kind: "box", sizeM: { x: 1.25, y: 0.035, z: 0.08 } },
        world(x, VISUAL_LAYERS.laneMarkingCenterY, 0),
        foundationPrimitiveRef,
        {
          material: material("#EFD37E", { opacity: 0.9, emissiveColor: "#D8B85C", emissiveIntensity: 0.35 }),
          transition: reveal,
          tags: ["emergency-city", "road-marking"],
        },
      )),
      ...[
        [foundation.curbNorth, 2.38, "North avenue curb"],
        [foundation.curbSouth, -2.38, "South avenue curb"],
      ].map(([id, z, label], index) => primitiveOperation(
        id,
        label,
        { kind: "box", sizeM: { x: 28, y: 0.16, z: 0.16 } },
        world(0, VISUAL_LAYERS.cityBaseY + 0.08, z),
        foundationPrimitiveRef,
        {
          key: `avenue_curb_${index + 1}`,
          material: material("#8C9190", { metallic: 0.05, roughness: 0.96 }),
          castShadow: true,
          receiveShadow: true,
          transition: reveal,
          tags: ["emergency-city", "road-detail", "curb"],
        },
      )),
      ...[
        [foundation.sidewalkNorth, 2.74, "North pedestrian promenade"],
        [foundation.sidewalkSouth, -2.74, "South pedestrian promenade"],
      ].map(([id, z, label], index) => primitiveOperation(
        id,
        label,
        { kind: "box", sizeM: { x: 28, y: 0.18, z: 0.48 } },
        world(0, VISUAL_LAYERS.cityBaseY + 0.09, z),
        foundationPrimitiveRef,
        {
          key: `pedestrian_promenade_${index + 1}`,
          material: material(index === 0 ? "#51606A" : "#485862", { metallic: 0.12, roughness: 0.82 }),
          castShadow: true,
          receiveShadow: true,
          transition: reveal,
          tags: ["emergency-city", "streetscape", "sidewalk"],
        },
      )),
      ...[
        [foundation.plinthEdgeNorth, { x: 30.16, y: 0.32, z: 0.1 }, [0, 0.16, 10.05], "North brass plinth edge"],
        [foundation.plinthEdgeSouth, { x: 30.16, y: 0.32, z: 0.1 }, [0, 0.16, -10.05], "South brass plinth edge"],
        [foundation.plinthEdgeEast, { x: 0.1, y: 0.32, z: 20 }, [15.05, 0.16, 0], "East brass plinth edge"],
        [foundation.plinthEdgeWest, { x: 0.1, y: 0.32, z: 20 }, [-15.05, 0.16, 0], "West brass plinth edge"],
      ].map(([id, size, position, label], index) => primitiveOperation(
        id,
        label,
        { kind: "box", sizeM: size },
        world(position[0], position[1], position[2]),
        foundationPrimitiveRef,
        {
          key: `plinth_edge_${index + 1}`,
          material: material("#B99A61", { metallic: 0.82, roughness: 0.28 }),
          castShadow: true,
          transition: reveal,
          tags: ["emergency-city", "maquette-detail", "plinth-trim"],
        },
      )),
      ...[
        [foundation.stopBarWest, -2.7, "West junction stop bar"],
        [foundation.stopBarEast, 2.7, "East junction stop bar"],
      ].map(([id, x, label], index) => primitiveOperation(
        id,
        label,
        { kind: "box", sizeM: { x: 0.14, y: 0.032, z: 3.82 } },
        world(x, VISUAL_LAYERS.roadDetailY, 0),
        foundationPrimitiveRef,
        {
          key: `junction_stop_bar_${index + 1}`,
          material: material("#F4F0E6", { roughness: 0.88, emissiveColor: "#D8D4CA", emissiveIntensity: 0.12 }),
          transition: reveal,
          tags: ["emergency-city", "road-detail", "stop-bar"],
        },
      )),
      ...[
        [foundation.lampPole1, foundation.lampGlow1, -8, 2.74],
        [foundation.lampPole2, foundation.lampGlow2, 5.8, 2.74],
        [foundation.lampPole3, foundation.lampGlow3, -5, -2.74],
        [foundation.lampPole4, foundation.lampGlow4, 9, -2.74],
      ].flatMap(([poleId, glowId, x, z], index) => [
        primitiveOperation(poleId, `Promenade lamp ${index + 1} stem`, { kind: "cylinder", radiusM: 0.055, heightM: 1.6, axis: "y" }, world(x, VISUAL_LAYERS.cityBaseY + 0.98, z), foundationPrimitiveRef, {
          key: `promenade_lamp_${index + 1}_stem`,
          material: material("#293743", { metallic: 0.78, roughness: 0.3 }),
          castShadow: true,
          transition: reveal,
          tags: ["emergency-city", "streetscape", "lamp"],
        }),
        primitiveOperation(glowId, `Promenade lamp ${index + 1} glow`, { kind: "sphere", radiusM: 0.13 }, world(x, VISUAL_LAYERS.cityBaseY + 1.82, z), foundationPrimitiveRef, {
          key: `promenade_lamp_${index + 1}_glow`,
          material: material("#FFE8B0", { emissiveColor: "#FFD27A", emissiveIntensity: 3.4, roughness: 0.2 }),
          transition: reveal,
          tags: ["emergency-city", "streetscape", "lamp-glow"],
        }),
      ]),
      primitiveOperation(foundation.hospitalArrivalPad, "Hospital ambulance arrival pad", { kind: "plane", sizeM: { x: 2.86, y: 1.82 }, normalAxis: "y" }, world(-9.45, VISUAL_LAYERS.destinationPadY, -0.85), foundationPrimitiveRef, {
        key: "hospital_arrival_pad",
        material: material("#A8DBEE", { opacity: 0.34, emissiveColor: "#5CCBFF", emissiveIntensity: 0.65 }),
        transition: reveal,
        tags: ["emergency-city", "destination", "arrival-zone"],
      }),
      ...[-0.9, -0.54, -0.18, 0.18, 0.54, 0.9].map((x, index) => primitiveOperation(
        foundation[`crosswalk${index + 1}`],
        `Hospital crosswalk stripe ${index + 1}`,
        { kind: "box", sizeM: { x: 0.2, y: 0.025, z: 1.7 } },
        world(-10.1 + x, VISUAL_LAYERS.routeOpenY + 0.025, 0.82),
        foundationPrimitiveRef,
        {
          key: `hospital_crosswalk_${index + 1}`,
          material: material("#E8ECE8", { roughness: 0.94 }),
          transition: reveal,
          tags: ["emergency-city", "road-detail", "crosswalk"],
        },
      )),
    ];
    if (foundationOperations.length !== foundationNames.length || foundationOperations.length > 100) {
      throw new Error(`Emergency-city foundation must create exactly ${foundationNames.length} reserved components within the 100-operation cap; received ${foundationOperations.length}.`);
    }
    await submit(foundationPreparation, foundationOperations);

    const cityNames = [
      "hospitalRoot", "hospitalBody", "hospitalTower", "hospitalCrossH", "hospitalCrossV", "helipad",
      "hospitalEntrance", "hospitalCanopy", "hospitalSign", "hospitalWindowBand",
      "building1", "building2", "building3", "building4", "building5", "building6", "building7",
      "windowBand1", "windowBand2", "windowBand3", "windowBand4", "windowBand5", "windowBand6", "windowBand7",
      "roof1", "roof2", "roof3",
      "tree1Trunk", "tree1Crown", "tree2Trunk", "tree2Crown", "tree3Trunk", "tree3Crown", "tree4Trunk", "tree4Crown",
      "signalPoleA", "signalPoleB", "signalHousingA", "signalHousingB", "signalRedA", "signalRedB", "signalGreenA", "signalGreenB",
      "ambulanceRoot", "ambulanceBody", "ambulanceCabin", "ambulanceStripe", "ambulanceCrossH", "ambulanceCrossV", "ambulanceBeacon",
      "ambulanceBeaconRight",
      "ambulanceWindshield", "ambulanceWheelFL", "ambulanceWheelFR", "ambulanceWheelRL", "ambulanceWheelRR", "ambulanceHeadlightL", "ambulanceHeadlightR",
      "blueRoot", "blueBody", "blueCabin", "blueWheelFL", "blueWheelFR", "blueWheelRL", "blueWheelRR",
      "taxiRoot", "taxiBody", "taxiCabin", "taxiWheelFL", "taxiWheelFR", "taxiWheelRL", "taxiWheelRR",
      "busRoot", "busBody", "busCabin", "busWheelFL", "busWheelFR", "busWheelRL", "busWheelRR",
      "redRoot", "redBody", "redCabin", "redWheelFL", "redWheelFR", "redWheelRL", "redWheelRR",
      "incidentRoot", "incidentBody", "incidentCabin",
      "chart", "button",
      "safeBlue", "safeTaxi", "safeBus", "safeRed",
    ];
    const cityPreparation = await begin("Build the blocked miniature city, traffic feed, and one-click emergency response", cityNames.length);
    const city = idMap(cityNames, cityPreparation.reserved_component_ids);
    const manifest = cityPreparation.capability_manifest;
    const assemblyRef = componentRef(manifest, "model-assembly");
    const primitiveRef = componentRef(manifest, "spatial-primitive");
    const chartRef = componentRef(manifest, "chart");
    const buttonRef = componentRef(manifest, "button");
    const inline = manifest.connector_types.find((entry) => entry.connectorType === "inline.snapshot" && entry.connectorVersion === "1.0.0");
    if (!inline || inline.networkAccess) throw new Error("The deterministic inline snapshot connector was not advertised safely.");

    const trafficSchema = {
      type: "object",
      additionalProperties: false,
      required: ["labels", "series", "incident", "route"],
      properties: {
        labels: { type: "array", items: { type: "string" } },
        series: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label", "values", "color"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              values: { type: "array", items: { type: "number" } },
              color: { type: "string" },
            },
          },
        },
        incident: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "ambulanceId", "etaSeconds", "currentClearanceM", "requiredClearanceM"],
          properties: {
            severity: { type: "string" },
            ambulanceId: { type: "string" },
            etaSeconds: { type: "number" },
            currentClearanceM: { type: "number" },
            requiredClearanceM: { type: "number" },
          },
        },
        route: {
          type: "object",
          additionalProperties: false,
          required: ["from", "via", "to", "status"],
          properties: {
            from: { type: "string" },
            via: { type: "string" },
            to: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    };
    const initialTrafficData = {
      labels: ["T-28", "T-21", "T-14", "T-7", "NOW"],
      series: [{ id: "clearance", label: "通道净宽 m", values: [3.8, 3.1, 2.4, 1.9, 1.6], color: "#FF637C" }],
      incident: {
        severity: "critical",
        ambulanceId: "AMB-07",
        etaSeconds: 28,
        currentClearanceM: 1.6,
        requiredClearanceM: 3.2,
      },
      route: {
        from: "Market Street incident",
        via: "Central emergency avenue",
        to: "City General Hospital",
        status: "blocked",
      },
    };
    const trafficResource = {
      id: "RES_emergency_traffic_snapshot",
      label: "Emergency dispatch snapshot",
      connectorType: inline.connectorType,
      connectorVersion: inline.connectorVersion,
      outputSchema: trafficSchema,
      config: {},
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: {
        data: initialTrafficData,
        contentHash: "caller-value-is-host-normalized",
        retrievedAt: "1970-01-01T00:00:00.000Z",
        stale: false,
        provenance: [],
      },
      status: "ready",
    };
    const cityReveal = { durationMs: 1_050, easing: "ease_out" };
    const buildingSpecs = [
      [city.building1, "Civic offices", { x: 4.2, y: 3.2, z: 3.2 }, [-7, 1.6, 6.3], "#718392"],
      [city.building2, "North tower", { x: 3.2, y: 4.4, z: 3 }, [-2, 2.2, 6.2], "#627989"],
      [city.building3, "Market hall", { x: 4, y: 3.1, z: 3.4 }, [4, 1.55, 6.2], "#886B66"],
      [city.building4, "Residential tower", { x: 3.4, y: 3.8, z: 3 }, [9, 1.9, 6.1], "#667B89"],
      [city.building5, "West apartments", { x: 3, y: 3.7, z: 3 }, [-6, 1.85, -6.2], "#716B80"],
      [city.building6, "South library", { x: 3.4, y: 2.8, z: 3 }, [1, 1.4, -6.2], "#897357"],
      [city.building7, "Transit hub", { x: 4.1, y: 3.2, z: 3.1 }, [7, 1.6, -6.2], "#587673"],
    ];
    const buildingWindowSpecs = [
      [city.windowBand1, "Civic offices window ribbon", { x: 3.3, y: 0.38, z: 0.07 }, [-7, 2.08, 7.94], "#8CD6EF"],
      [city.windowBand2, "North tower window ribbon", { x: 2.45, y: 0.42, z: 0.07 }, [-2, 2.72, 7.74], "#83CCE8"],
      [city.windowBand3, "Market hall window ribbon", { x: 3.15, y: 0.42, z: 0.07 }, [4, 1.92, 7.94], "#FFD590"],
      [city.windowBand4, "Residential window ribbon", { x: 2.6, y: 0.4, z: 0.07 }, [9, 2.34, 7.64], "#91D2E7"],
      [city.windowBand5, "West apartments window ribbon", { x: 2.3, y: 0.4, z: 0.07 }, [-6, 2.3, -4.67], "#B5A3EE"],
      [city.windowBand6, "Library reading-room windows", { x: 2.62, y: 0.42, z: 0.07 }, [1, 1.74, -4.67], "#FFD18A"],
      [city.windowBand7, "Transit hub window ribbon", { x: 3.2, y: 0.4, z: 0.07 }, [7, 2.04, -4.62], "#83D7CF"],
    ];
    const cityOperations = [
      assemblyOperation(city.hospitalRoot, "City General Hospital", world(-11.2, VISUAL_LAYERS.cityBaseY, -6.1), assemblyRef, {
        key: "hospital_root",
        description: "Editable miniature hospital and emergency destination.",
        transition: cityReveal,
        tags: ["emergency-city", "hospital", "destination"],
      }),
      primitiveOperation(city.hospitalBody, "Hospital main wing", { kind: "box", sizeM: { x: 4.2, y: 3.2, z: 3.4 } }, world(0, 1.6, 0), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#E9EEEC", { metallic: 0.12, roughness: 0.52 }),
        collision: solidCollision,
        castShadow: true,
        receiveShadow: true,
        transition: cityReveal,
        tags: ["emergency-city", "hospital-part", "collision-solid"],
      }),
      primitiveOperation(city.hospitalTower, "Hospital emergency tower", { kind: "box", sizeM: { x: 1.7, y: 1.8, z: 1.8 } }, world(0.4, 4.1, 0), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#A9CBD9", { metallic: 0.38, roughness: 0.3, emissiveColor: "#245D74", emissiveIntensity: 0.16 }),
        collision: solidCollision,
        castShadow: true,
        transition: cityReveal,
      }),
      primitiveOperation(city.hospitalCrossH, "Hospital cross horizontal", { kind: "box", sizeM: { x: 1.05, y: 0.25, z: 0.12 } }, world(0.4, 4.35, 0.96), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#FF3B57", { emissiveColor: "#FF315A", emissiveIntensity: 2.6 }),
        transition: cityReveal,
      }),
      primitiveOperation(city.hospitalCrossV, "Hospital cross vertical", { kind: "box", sizeM: { x: 0.25, y: 1.05, z: 0.12 } }, world(0.4, 4.35, 0.97), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#FF3B57", { emissiveColor: "#FF315A", emissiveIntensity: 2.6 }),
        transition: cityReveal,
      }),
      primitiveOperation(city.helipad, "Hospital helipad", { kind: "cylinder", radiusM: 1.25, heightM: 0.1, axis: "y" }, world(-1.05, 3.28, 0), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#3B5968", { metallic: 0.3, roughness: 0.52 }),
        transition: cityReveal,
      }),
      primitiveOperation(city.hospitalEntrance, "Hospital emergency entrance", { kind: "box", sizeM: { x: 1.35, y: 1.65, z: 0.16 } }, world(1.15, 0.83, 1.76), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#225C73", { metallic: 0.42, roughness: 0.26, emissiveColor: "#4CC9FF", emissiveIntensity: 0.45 }),
        castShadow: true,
        transition: cityReveal,
        tags: ["emergency-city", "hospital-part", "entrance"],
      }),
      primitiveOperation(city.hospitalCanopy, "Hospital ambulance canopy", { kind: "box", sizeM: { x: 2.1, y: 0.18, z: 1.05 } }, world(1.15, 1.72, 2.16), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#D9E8EE", { metallic: 0.18, roughness: 0.48 }),
        castShadow: true,
        transition: cityReveal,
        tags: ["emergency-city", "hospital-part", "canopy"],
      }),
      primitiveOperation(city.hospitalSign, "Hospital emergency sign", { kind: "box", sizeM: { x: 1.5, y: 0.38, z: 0.08 } }, world(1.15, 2.2, 1.78), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#FF315A", { emissiveColor: "#FF315A", emissiveIntensity: 2.4 }),
        transition: cityReveal,
        tags: ["emergency-city", "hospital-part", "signage"],
      }),
      primitiveOperation(city.hospitalWindowBand, "Hospital window band", { kind: "box", sizeM: { x: 3.5, y: 0.42, z: 0.08 } }, world(-0.15, 2.3, 1.74), primitiveRef, {
        parentId: city.hospitalRoot,
        material: material("#5EA3BF", { metallic: 0.48, roughness: 0.22, emissiveColor: "#1D6684", emissiveIntensity: 0.3 }),
        transition: cityReveal,
        tags: ["emergency-city", "hospital-part", "window-band"],
      }),
      ...buildingSpecs.map(([id, label, size, position, color], index) => primitiveOperation(
        id,
        label,
        { kind: "box", sizeM: size },
        world(position[0], position[1] + VISUAL_LAYERS.cityBaseY, position[2]),
        primitiveRef,
        {
          key: `building_${index + 1}`,
          material: material(color, { metallic: 0.18, roughness: 0.58, emissiveColor: "#172A39", emissiveIntensity: 0.1 }),
          collision: solidCollision,
          castShadow: true,
          receiveShadow: true,
          transition: cityReveal,
          tags: ["emergency-city", "building", "collision-solid"],
        },
      )),
      ...buildingWindowSpecs.map(([id, label, size, position, color], index) => primitiveOperation(
        id,
        label,
        { kind: "box", sizeM: size },
        world(position[0], position[1] + VISUAL_LAYERS.cityBaseY, position[2]),
        primitiveRef,
        {
          key: `building_window_ribbon_${index + 1}`,
          material: material(color, { metallic: 0.5, roughness: 0.18, emissiveColor: color, emissiveIntensity: 0.38 }),
          transition: cityReveal,
          tags: ["emergency-city", "building-detail", "window-ribbon"],
        },
      )),
      ...[
        [city.roof1, -2, 4.47, 6.2, "#8FD7EE"],
        [city.roof2, 9, 3.88, 6.1, "#E7C98D"],
        [city.roof3, -6, 3.78, -6.2, "#B9A9D8"],
      ].map(([id, x, y, z, color], index) => primitiveOperation(id, `Rooftop skylight ${index + 1}`, { kind: "cylinder", radiusM: 0.36, heightM: 0.16, axis: "y" }, world(x, y + VISUAL_LAYERS.cityBaseY, z), primitiveRef, {
        key: `roof_skylight_${index + 1}`,
        material: material(color, { metallic: 0.58, roughness: 0.2, emissiveColor: color, emissiveIntensity: 0.24 }),
        transition: cityReveal,
        tags: ["emergency-city", "building-detail", "skylight"],
      })),
      ...[
        [city.tree1Trunk, city.tree1Crown, -9, 3.7],
        [city.tree2Trunk, city.tree2Crown, -9, -3.5],
        [city.tree3Trunk, city.tree3Crown, 7, 3.65],
        [city.tree4Trunk, city.tree4Crown, 10.5, -3.55],
      ].flatMap(([trunkId, crownId, x, z], index) => [
        primitiveOperation(trunkId, `Street tree ${index + 1} trunk`, { kind: "cylinder", radiusM: 0.13, heightM: 1.1, axis: "y" }, world(x, VISUAL_LAYERS.cityBaseY + 0.55, z), primitiveRef, {
          key: `tree_${index + 1}_trunk`, material: material("#72523A"), collision: solidCollision, transition: cityReveal,
        }),
        primitiveOperation(crownId, `Street tree ${index + 1} crown`, { kind: "cone", radiusM: 0.68, heightM: 1.65, axis: "y" }, world(x, VISUAL_LAYERS.cityBaseY + 1.75, z), primitiveRef, {
          key: `tree_${index + 1}_crown`, material: material("#2D7E65", { roughness: 0.9 }), transition: cityReveal,
        }),
      ]),
      primitiveOperation(city.signalPoleA, "North signal pole", { kind: "cylinder", radiusM: 0.09, heightM: 2.8, axis: "y" }, world(0, VISUAL_LAYERS.cityBaseY + 1.4, 2.55), primitiveRef, {
        material: material("#26313B", { metallic: 0.72, roughness: 0.3 }), transition: cityReveal,
      }),
      primitiveOperation(city.signalPoleB, "South signal pole", { kind: "cylinder", radiusM: 0.09, heightM: 2.8, axis: "y" }, world(0, VISUAL_LAYERS.cityBaseY + 1.4, -2.55), primitiveRef, {
        material: material("#26313B", { metallic: 0.72, roughness: 0.3 }), transition: cityReveal,
      }),
      ...[
        [city.signalHousingA, 2.55], [city.signalHousingB, -2.55],
      ].map(([id, z], index) => primitiveOperation(id, `Emergency signal housing ${index + 1}`, { kind: "box", sizeM: { x: 0.18, y: 1.0, z: 0.48 } }, world(-0.18, VISUAL_LAYERS.cityBaseY + 2.39, z), primitiveRef, {
        key: `signal_housing_${index + 1}`,
        material: material("#17212A", { metallic: 0.68, roughness: 0.26 }),
        castShadow: true,
        transition: cityReveal,
        tags: ["emergency-city", "traffic-signal", "housing"],
      })),
      ...[
        [city.signalRedA, 2.55], [city.signalRedB, -2.55],
      ].map(([id, z], index) => primitiveOperation(id, `Emergency red signal ${index + 1}`, { kind: "sphere", radiusM: 0.2 }, world(0, VISUAL_LAYERS.cityBaseY + 2.62, z), primitiveRef, {
        key: `red_signal_${index + 1}`,
        material: material("#FF355E", { emissiveColor: "#FF214F", emissiveIntensity: 4.5 }),
        transition: cityReveal,
        tags: ["emergency-city", "traffic-signal", "red"],
      })),
      ...[
        [city.signalGreenA, 2.55], [city.signalGreenB, -2.55],
      ].map(([id, z], index) => primitiveOperation(id, `Emergency green signal ${index + 1}`, { kind: "sphere", radiusM: 0.2 }, world(0, VISUAL_LAYERS.cityBaseY + 2.16, z), primitiveRef, {
        key: `green_signal_${index + 1}`,
        material: material("#39E58C", { emissiveColor: "#2DFF8C", emissiveIntensity: 4.5 }),
        visibility: "hidden",
        transition: cityReveal,
        tags: ["emergency-city", "traffic-signal", "green"],
      })),
      assemblyOperation(city.ambulanceRoot, "Ambulance AMB-07", world(10.6, VISUAL_LAYERS.cityBaseY, -0.9), assemblyRef, {
        key: "ambulance_root", transition: cityReveal, tags: ["emergency-city", "ambulance", "movable"],
      }),
      primitiveOperation(city.ambulanceBody, "Ambulance body", { kind: "box", sizeM: { x: 2.75, y: 0.72, z: 1.12 } }, world(0, 0.45, 0), primitiveRef, {
        parentId: city.ambulanceRoot, material: material("#F4F7FA", { metallic: 0.28, roughness: 0.38 }), collision: solidCollision, physics: enabledKinematicPhysics, castShadow: true, receiveShadow: true, transition: cityReveal,
      }),
      primitiveOperation(city.ambulanceCabin, "Ambulance cabin", { kind: "box", sizeM: { x: 1.2, y: 0.65, z: 1.02 } }, world(-0.55, 1.1, 0), primitiveRef, {
        parentId: city.ambulanceRoot, material: material("#B8D8E8", { metallic: 0.42, roughness: 0.24 }), collision: solidCollision, physics: enabledKinematicPhysics, castShadow: true, transition: cityReveal,
      }),
      primitiveOperation(city.ambulanceStripe, "Ambulance rescue stripe", { kind: "box", sizeM: { x: 2.82, y: 0.14, z: 1.14 } }, world(0, 0.55, 0), primitiveRef, {
        parentId: city.ambulanceRoot, material: material("#FF315A", { emissiveColor: "#FF315A", emissiveIntensity: 1.15 }), transition: cityReveal,
      }),
      primitiveOperation(city.ambulanceCrossH, "Ambulance cross horizontal", { kind: "box", sizeM: { x: 0.72, y: 0.15, z: 0.05 } }, world(0.45, 0.88, -0.58), primitiveRef, {
        parentId: city.ambulanceRoot, material: material("#FF315A", { emissiveColor: "#FF315A", emissiveIntensity: 2 }), transition: cityReveal,
      }),
      primitiveOperation(city.ambulanceCrossV, "Ambulance cross vertical", { kind: "box", sizeM: { x: 0.15, y: 0.72, z: 0.05 } }, world(0.45, 0.88, -0.59), primitiveRef, {
        parentId: city.ambulanceRoot, material: material("#FF315A", { emissiveColor: "#FF315A", emissiveIntensity: 2 }), transition: cityReveal,
      }),
      primitiveOperation(city.ambulanceBeacon, "Ambulance left blue beacon", { kind: "sphere", radiusM: 0.14 }, world(-0.55, 1.5, 0.28), primitiveRef, {
        parentId: city.ambulanceRoot, material: material("#48BFFF", { emissiveColor: "#32C7FF", emissiveIntensity: 5 }), transition: cityReveal,
      }),
      primitiveOperation(city.ambulanceBeaconRight, "Ambulance right blue beacon", { kind: "sphere", radiusM: 0.14 }, world(-0.55, 1.5, -0.28), primitiveRef, {
        key: "ambulance_right_beacon", parentId: city.ambulanceRoot,
        material: material("#48BFFF", { emissiveColor: "#32C7FF", emissiveIntensity: 5 }), transition: cityReveal,
        tags: ["emergency-city", "ambulance-part", "beacon"],
      }),
      primitiveOperation(city.ambulanceWindshield, "Ambulance windshield", { kind: "box", sizeM: { x: 0.08, y: 0.48, z: 0.86 } }, world(-1.18, 1.08, 0), primitiveRef, {
        parentId: city.ambulanceRoot, material: material("#28566E", { metallic: 0.55, roughness: 0.18, opacity: 0.88 }), transition: cityReveal,
        tags: ["emergency-city", "ambulance-part", "windshield"],
      }),
      ...[
        [city.ambulanceWheelFL, 0.88, 0.62, "front left"],
        [city.ambulanceWheelFR, 0.88, -0.62, "front right"],
        [city.ambulanceWheelRL, -0.88, 0.62, "rear left"],
        [city.ambulanceWheelRR, -0.88, -0.62, "rear right"],
      ].map(([id, x, z, label], index) => primitiveOperation(id, `Ambulance ${label} wheel`, { kind: "cylinder", radiusM: 0.24, heightM: 0.14, axis: "z" }, world(x, 0.25, z), primitiveRef, {
        key: `ambulance_wheel_${index + 1}`, parentId: city.ambulanceRoot, material: material("#101820", { roughness: 0.94 }), castShadow: true, transition: cityReveal,
        tags: ["emergency-city", "ambulance-part", "wheel"],
      })),
      ...[
        [city.ambulanceHeadlightL, 0.34], [city.ambulanceHeadlightR, -0.34],
      ].map(([id, z], index) => primitiveOperation(id, `Ambulance headlight ${index + 1}`, { kind: "sphere", radiusM: 0.1 }, world(-1.4, 0.55, z), primitiveRef, {
        key: `ambulance_headlight_${index + 1}`, parentId: city.ambulanceRoot,
        material: material("#FFF4BF", { emissiveColor: "#FFF0A0", emissiveIntensity: 3.2 }), transition: cityReveal,
        tags: ["emergency-city", "ambulance-part", "headlight"],
      })),
      ...vehicleOperations({ ids: [city.blueRoot, city.blueBody, city.blueCabin, city.blueWheelFL, city.blueWheelFR, city.blueWheelRL, city.blueWheelRR], label: "Blue sedan", placement: world(5.2, VISUAL_LAYERS.cityBaseY, -0.9), assemblyRef, primitiveRef, color: "#3A7BD5", transition: cityReveal }),
      ...vehicleOperations({ ids: [city.taxiRoot, city.taxiBody, city.taxiCabin, city.taxiWheelFL, city.taxiWheelFR, city.taxiWheelRL, city.taxiWheelRR], label: "Yellow taxi", placement: world(2.1, VISUAL_LAYERS.cityBaseY, -0.9), assemblyRef, primitiveRef, color: "#E9B93F", transition: cityReveal }),
      ...vehicleOperations({ ids: [city.busRoot, city.busBody, city.busCabin, city.busWheelFL, city.busWheelFR, city.busWheelRL, city.busWheelRR], label: "City bus", placement: world(-2.2, VISUAL_LAYERS.cityBaseY, -0.9), assemblyRef, primitiveRef, color: "#56A78D", kind: "bus", transition: cityReveal }),
      ...vehicleOperations({ ids: [city.redRoot, city.redBody, city.redCabin, city.redWheelFL, city.redWheelFR, city.redWheelRL, city.redWheelRR], label: "Red compact", placement: world(-5.8, VISUAL_LAYERS.cityBaseY, -0.9), assemblyRef, primitiveRef, color: "#D9585E", transition: cityReveal }),
      ...vehicleOperations({ ids: [city.incidentRoot, city.incidentBody, city.incidentCabin], label: "Incident vehicle", placement: world(10.4, VISUAL_LAYERS.cityBaseY, 0.92), assemblyRef, primitiveRef, color: "#8C5FD1", physics: enabledStaticPhysics, transition: cityReveal }),
      {
        op: "create_component", op_id: "create_emergency_chart", id: city.chart, label: "Emergency dispatch snapshot",
        component_type: chartRef,
        props: { title: "急救调度 · ETA 28 秒 · 净宽 1.6 m", chartType: "area" },
        placement: { space: "viewport", anchor: "top_right", offset: { x: -28, y: 70 }, size: { width: 420, height: 248 } },
        transition: { durationMs: 420, easing: "ease_out" },
        tags: ["emergency-city", "traffic-feed", "data-panel"],
      },
      {
        op: "create_component", op_id: "create_open_corridor_button", id: city.button, label: "Open emergency corridor control",
        component_type: buttonRef,
        props: { label: "一键打开急救通道", variant: "primary" },
        placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: -34 }, size: { width: 270, height: 70 } },
        visibility: "collapsed",
        transition: { durationMs: 360, easing: "ease_out" },
        tags: ["emergency-city", "control", "one-click-response"],
      },
      ...[
        [city.safeBlue, 4.4, 3.65, "Blue sedan safe bay"],
        [city.safeTaxi, 1.1, -3.65, "Taxi safe bay"],
        [city.safeBus, -3.1, 3.65, "Bus safe bay"],
        [city.safeRed, -6.3, -3.65, "Red car safe bay"],
      ].map(([id, x, z, label], index) => primitiveOperation(id, label, { kind: "plane", sizeM: { x: index === 2 ? 3.6 : 2.3, y: 1.35 }, normalAxis: "y" }, world(x, VISUAL_LAYERS.safeBayY, z), primitiveRef, {
        key: `safe_bay_${index + 1}`,
        material: material("#34DA8B", { opacity: 0.46, emissiveColor: "#2DFF96", emissiveIntensity: 2.05 }),
        visibility: "hidden",
        transition: cityReveal,
        tags: ["emergency-city", "safe-bay", "validated-endpoint"],
      })),
      { op: "upsert_resource", op_id: "upsert_emergency_traffic_snapshot", resource: trafficResource },
      {
        op: "bind_resource", op_id: "bind_emergency_labels", binding: {
          kind: "resource_binding", id: "BIND_emergency_labels", resourceId: trafficResource.id,
          componentId: city.chart, targetProp: "labels", sourcePath: "$.labels", mode: "snapshot",
          transform: { kind: "identity" }, enabled: true,
        },
      },
      {
        op: "bind_resource", op_id: "bind_emergency_series", binding: {
          kind: "resource_binding", id: "BIND_emergency_series", resourceId: trafficResource.id,
          componentId: city.chart, targetProp: "series", sourcePath: "$.series", mode: "snapshot",
          transform: { kind: "identity" }, enabled: true,
        },
      },
    ];
    const cityOperationCount = cityOperations.length;
    const expectedCityOperationCount = cityNames.length + 3; // one per reserved component + resource + two bindings
    if (cityOperationCount !== expectedCityOperationCount || cityOperationCount > 100) {
      throw new Error(`Emergency-city build must contain ${expectedCityOperationCount} complete operations within the protocol cap; received ${cityOperationCount}.`);
    }

    const cityBuildReceipt = await submit(cityPreparation, cityOperations);
    if (!cityBuildReceipt) throw new Error("The staged miniature-city build did not commit.");
    await delay(1_500);
    await presentCamera("crisis");
    await assertProjectedControlsInsideViewport(cdp, "Crisis shot");

    // A readable overhead crisis establishing move: the full route, hospital,
    // incident vehicle, feed panel, and blocked traffic remain in one frame.
    await captureDragTrack(cdp, "crisis-frames", {
      deltaX: 22,
      deltaY: 2,
      arcY: 5,
      startXRatio: 0.52,
      startYRatio: 0.49,
    });

    // The prompt is a genuine lower Workspace camera, not a crop of the crisis
    // frame. A restrained dolly-in makes the maquette read as dimensional.
    await presentCamera("prompt");
    await captureZoomTrack(cdp, "prompt-frames", { totalDeltaY: -72, xRatio: 0.48, yRatio: 0.5 });

    const revisionBeforeRead = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
    const feedRead = await callAgent(client, "read_workspace_resource_snapshot", {
      ...session,
      resource_id: trafficResource.id,
    });
    if (!feedRead.ok) throw new Error(`The Agent could not read the dispatch snapshot: ${feedRead.error?.code}`);
    const revisionAfterRead = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
    const readData = feedRead.data?.snapshot?.data;
    if (revisionAfterRead !== revisionBeforeRead
      || readData?.incident?.etaSeconds !== 28
      || readData?.incident?.currentClearanceM !== 1.6
      || readData?.incident?.requiredClearanceM !== 3.2
      || readData?.route?.status !== "blocked") {
      throw new Error("The exact dispatch snapshot read did not preserve revision or match the expected bounded fields.");
    }
    await presentCamera("understand");
    await captureDragTrack(cdp, "understand-frames", {
      deltaX: -18,
      deltaY: -3,
      arcY: 3,
      startXRatio: 0.5,
      startYRatio: 0.48,
    });

    const ghostPreparation = await begin("Visualize the Blue sedan endpoint that clips a protected street tree", 4);
    const [ghostId, ghostBodyId, ghostCabinId, ghostContactId] = ghostPreparation.reserved_component_ids;
    const ghostComponentIds = [ghostId, ghostBodyId, ghostCabinId, ghostContactId];
    const assertRejectedPreviewCollapsed = async (label) => {
      const components = [];
      for (const componentId of ghostComponentIds) {
        const inspection = await callAgent(client, "inspect_workspace_component", {
          ...session,
          component_id: componentId,
        });
        const visibility = inspection.data?.component?.visibility;
        components.push({ componentId, visibility });
        if (!inspection.ok || visibility !== "collapsed") {
          throw new Error(`${label} retained visible rejected-preview geometry: ${JSON.stringify(components)}.`);
        }
      }
      return components;
    };
    const ghostAssemblyRef = componentRef(ghostPreparation.capability_manifest, "model-assembly");
    const ghostPrimitiveRef = componentRef(ghostPreparation.capability_manifest, "spatial-primitive");
    const ghostReveal = { durationMs: 420, easing: "ease_out" };
    await submit(ghostPreparation, [
      assemblyOperation(
        ghostId,
        "Street-tree collision endpoint · preview only",
        world(6.2, VISUAL_LAYERS.cityBaseY, 3.65),
        ghostAssemblyRef,
        {
          key: "unsafe_blue_preview_root",
          transition: ghostReveal,
          tags: ["emergency-city", "preview-only", "unsafe-endpoint", "vehicle-ghost"],
        },
      ),
      primitiveOperation(ghostBodyId, "Unsafe Blue sedan ghost body", { kind: "box", sizeM: { x: 1.95, y: 0.46, z: 0.94 } }, world(0, 0.33, 0), ghostPrimitiveRef, {
        key: "unsafe_blue_preview_body",
        parentId: ghostId,
        material: material("#58A9F5", { opacity: 0.42, emissiveColor: "#2C8CE5", emissiveIntensity: 0.9, metallic: 0.38, roughness: 0.24 }),
        collision: noCollision,
        transition: ghostReveal,
        tags: ["emergency-city", "preview-only", "vehicle-ghost"],
      }),
      primitiveOperation(ghostCabinId, "Unsafe Blue sedan ghost cabin", { kind: "box", sizeM: { x: 1.08, y: 0.42, z: 0.78 } }, world(-0.08, 0.73, 0), ghostPrimitiveRef, {
        key: "unsafe_blue_preview_cabin",
        parentId: ghostId,
        material: material("#BFE8F7", { opacity: 0.32, emissiveColor: "#63C7F3", emissiveIntensity: 0.72, metallic: 0.5, roughness: 0.16 }),
        collision: noCollision,
        transition: ghostReveal,
        tags: ["emergency-city", "preview-only", "vehicle-ghost"],
      }),
      primitiveOperation(ghostContactId, "Protected-tree collision contact", { kind: "sphere", radiusM: 0.62 }, world(0.8, 0.72, 0), ghostPrimitiveRef, {
        key: "unsafe_blue_preview_contact",
        parentId: ghostId,
        material: material("#FF355E", { opacity: 0.3, emissiveColor: "#FF214F", emissiveIntensity: 4.1, metallic: 0.05, roughness: 0.28 }),
        collision: noCollision,
        transition: ghostReveal,
        tags: ["emergency-city", "preview-only", "collision-contact"],
      }),
    ]);
    await presentCamera("collision");
    let badMovePreparation;
    const collisionQuery = await callAgent(client, "query_spatial_placement", {
      ...session,
      candidate: {
        geometry: { kind: "box", sizeM: { x: 2.05, y: 1.25, z: 1.02 } },
        placement: world(6.2, VISUAL_LAYERS.cityBaseY + 0.625, 3.65),
        collision: solidCollision,
      },
    });
    if (!collisionQuery.ok || collisionQuery.data?.placement_check?.valid !== false) {
      throw new Error("The protected street-tree collision preflight did not reject the unsafe endpoint.");
    }
    let rejectedMove;
    let revisionAfterRejection;
    await captureDragTrack(cdp, "collision-frames", {
      deltaX: 15,
      deltaY: -3,
      arcY: 2,
      startXRatio: 0.49,
      startYRatio: 0.5,
      beforeFrame: async (index) => {
        if (index !== 42) return;
        // Native 1920x1080 capture can take longer than a prepared transaction
        // token's TTL. Prepare at the exact evidence frame, then immediately
        // submit the intentionally unsafe move so expiry cannot masquerade as
        // a spatial rejection.
        badMovePreparation = await begin("Try to move the Blue sedan through a protected street tree");
        rejectedMove = await submitResult(badMovePreparation, [{
          op: "invoke_component_action",
          op_id: "move_blue_sedan_into_market_hall",
          id: city.blueRoot,
          action: "move_to",
          input: { target: target(6.2, VISUAL_LAYERS.cityBaseY, 3.65) },
          transition: { durationMs: 900, easing: "ease_out" },
        }]);
        if (rejectedMove.ok || rejectedMove.error?.code !== "spatial_collision") {
          throw new Error(`The unsafe move_to was not atomically rejected: ${rejectedMove.error?.code ?? "committed"}`);
        }
        revisionAfterRejection = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
        if (revisionAfterRejection !== badMovePreparation.envelope.base_workspace_revision) {
          throw new Error("The rejected move_to changed the Workspace revision.");
        }
      },
    });
    if (!badMovePreparation || !rejectedMove || revisionAfterRejection === undefined) {
      throw new Error("The fixed-frame collision rejection did not complete.");
    }

    await refreshSession("before_live_planner");
    // The collision ghost is evidence for the rejection beat, not part of the
    // accepted emergency plan. Dismiss every independently-rendered preview
    // component before locking planner authority. Keeping this lifecycle in a
    // host-authored transaction preserves the model's truthful 11-action fan-
    // out and prevents Undo from resurrecting rejected geometry.
    const previewDismissalPreparation = await begin("Dismiss the rejected endpoint preview after collision evidence");
    const previewDismissalReceipt = await submit(
      previewDismissalPreparation,
      ghostComponentIds.map((id, index) => ({
        op: "update_component",
        op_id: `collapse_rejected_preview_${index + 1}`,
        id,
        patch: { visibility: "collapsed" },
        transition: { durationMs: 240, easing: "ease_out" },
      })),
    );
    if (previewDismissalReceipt.status !== "committed"
      || previewDismissalReceipt.resulting_workspace_revision !== revisionAfterRejection + 1) {
      throw new Error(`Rejected-preview dismissal was not one committed host revision: ${JSON.stringify(previewDismissalReceipt)}.`);
    }
    const previewAfterDismissal = await assertRejectedPreviewCollapsed("Preview dismissal");
    await presentCamera("plan");
    const planningInspection = await callAgent(client, "inspect_workspace", session);
    const plannerAuthority = planningInspection.data?.workspace_summary;
    if (!planningInspection.ok || !plannerAuthority?.workspace_id
      || !Number.isInteger(plannerAuthority.revision) || !plannerAuthority.registry_digest) {
      throw new Error("The live planner could not lock an authoritative Workspace identity.");
    }
    const plannerFeedRead = await callAgent(client, "read_workspace_resource_snapshot", {
      ...session,
      resource_id: trafficResource.id,
    });
    if (!plannerFeedRead.ok
      || plannerFeedRead.data?.workspace_id !== plannerAuthority.workspace_id
      || plannerFeedRead.data?.workspace_revision !== plannerAuthority.revision
      || plannerFeedRead.data?.registry_digest !== plannerAuthority.registry_digest
      || plannerFeedRead.data?.snapshot?.content_hash !== feedRead.data?.snapshot?.content_hash
      || JSON.stringify(plannerFeedRead.data?.snapshot?.data) !== JSON.stringify(readData)) {
      throw new Error("The dispatch snapshot was not re-read under the exact planner authority.");
    }
    const plannerAttempts = [];
    let validationFeedback;
    let emergencyPlan;
    let plannerContext;
    let safePreflights;
    let preflightRevisionAfter;
    for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt += 1) {
      plannerContext = await buildEmergencyPlannerContext({
        client,
        session,
        authority: plannerAuthority,
        city,
        foundation,
        feedRead: plannerFeedRead,
        readData,
        validationFeedback,
      });
      const plannerRun = await runEmergencyPlanner(plannerContext, attempt);
      plannerAttempts.push({
        attempt,
        runId: plannerRun.manifest.run_id,
        runHash: plannerRun.manifest.run_hash,
        planHash: plannerRun.manifest.hashes?.plan,
      });
      try {
        emergencyPlan = compileEmergencyPlan({ plannerRun, context: plannerContext, city, foundation });
      } catch (error) {
        if (attempt === PLANNER_MAX_ATTEMPTS) throw error;
        validationFeedback = {
          previous_run_id: plannerRun.manifest.run_id,
          rejection_type: "host_mission_contract",
          message: error.message,
          instruction: "Revise the plan from the same authoritative scene. Do not repeat the rejected plan.",
        };
        continue;
      }

      safePreflights = [];
      for (const { actionId, targetId, label, size, placement } of emergencyPlan.safeCandidates) {
        const result = await callAgent(client, "query_spatial_placement", {
          ...session,
          candidate: { geometry: { kind: "box", sizeM: size }, placement, collision: solidCollision },
        });
        safePreflights.push({
          actionId,
          targetId,
          label,
          workspaceId: result.data?.workspace_id,
          workspaceRevision: result.data?.workspace_revision,
          registryDigest: result.data?.registry_digest,
          valid: result.ok
            && result.data?.workspace_id === plannerAuthority.workspace_id
            && result.data?.workspace_revision === plannerAuthority.revision
            && result.data?.registry_digest === plannerAuthority.registry_digest
            && result.data?.placement_check?.valid === true,
          conflicts: result.data?.placement_check?.conflicts ?? [],
          ...(result.ok ? {} : { errorCode: result.error?.code }),
        });
      }
      preflightRevisionAfter = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
      const rejectedPreflights = safePreflights.filter((entry) => !entry.valid || entry.conflicts.length > 0);
      if (preflightRevisionAfter !== plannerAuthority.revision) {
        throw new Error(`Workspace revision drifted during model endpoint preflight: ${plannerAuthority.revision} -> ${preflightRevisionAfter}.`);
      }
      if (rejectedPreflights.length === 0) break;
      if (attempt === PLANNER_MAX_ATTEMPTS) {
        throw new Error(`The live model did not produce collision-safe endpoints after ${attempt} attempts: ${JSON.stringify(rejectedPreflights)}`);
      }
      validationFeedback = {
        previous_run_id: plannerRun.manifest.run_id,
        rejection_type: "authoritative_query_spatial_placement",
        rejected_endpoints: rejectedPreflights.map((entry) => ({
          action_id: entry.actionId,
          target_component_id: entry.targetId,
          conflicts: entry.conflicts,
          error_code: entry.errorCode,
        })),
        instruction: "Choose different endpoints from the same scene and preserve collision.",
      };
      emergencyPlan = undefined;
    }
    if (!emergencyPlan || !safePreflights?.every((entry) => entry.valid && entry.conflicts.length === 0)) {
      throw new Error("The live Codex planner did not produce a host-validated emergency plan.");
    }
    // A model attempt can be arbitrarily slow. Rotate again only after every
    // prepared transaction is complete, then prove the pinned Workspace
    // authority is unchanged before compiling the plan.
    await refreshSession("after_live_planner");
    const postPlannerAuthority = await callAgent(client, "inspect_workspace", session);
    if (!postPlannerAuthority.ok
      || postPlannerAuthority.data?.workspace_summary?.workspace_id !== plannerAuthority.workspace_id
      || postPlannerAuthority.data?.workspace_summary?.revision !== plannerAuthority.revision
      || postPlannerAuthority.data?.workspace_summary?.registry_digest !== plannerAuthority.registry_digest) {
      throw new Error("Workspace authority changed while rotating the post-planner session.");
    }
    const finalPlannerDirectory = publishFinalPlannerArtifacts(emergencyPlan.plannerRun);
    const hostValidationReceipt = {
      receipt_version: "1.0",
      planner_run_id: emergencyPlan.plannerRun.manifest.run_id,
      planner_plan_hash: emergencyPlan.plannerRun.manifest.hashes.plan,
      authority: {
        workspace_id: plannerAuthority.workspace_id,
        workspace_revision: plannerAuthority.revision,
        registry_digest: plannerAuthority.registry_digest,
        dispatch_snapshot_hash: plannerFeedRead.data.snapshot.content_hash,
      },
      validation_tool: "query_spatial_placement",
      endpoint_receipts: safePreflights,
      all_endpoints_valid: safePreflights.every((entry) => entry.valid && entry.conflicts.length === 0),
      route_compilation_pending: true,
    };
    const hostValidationReceiptHash = hashCanonical(hostValidationReceipt);
    writeFileSync(
      join(finalPlannerDirectory, "host-validation-receipt.json"),
      `${JSON.stringify(hostValidationReceipt, null, 2)}\n`,
    );
    let planPreparation;
    let planReceipt;
    await captureFrames(cdp, "plan-frames", {
      beforeFrame: async (index) => {
        if (index !== 15) return;
        planPreparation = await begin("Compile the live model plan and reveal the one-click control");
        if (planPreparation.envelope.workspace_id !== emergencyPlan.plannerRun.plan.source.workspace_id
          || planPreparation.envelope.base_workspace_revision !== emergencyPlan.plannerRun.plan.source.workspace_revision
          || planPreparation.envelope.registry_digest !== emergencyPlan.plannerRun.plan.source.registry_digest) {
          throw new Error("Workspace authority changed after model planning and before route compilation.");
        }
        planReceipt = await submit(planPreparation, [{
          op: "update_component",
          op_id: "reveal_emergency_control",
          id: city.button,
          patch: { visibility: "visible" },
          transition: { durationMs: 460, easing: "ease_out" },
        }, ...[city.safeBlue, city.safeTaxi, city.safeBus, city.safeRed].map((id, index) => ({
          op: "update_component",
          op_id: `reveal_validated_bay_${index + 1}`,
          id,
          patch: { visibility: "visible" },
          transition: { durationMs: 520, delayMs: index * 80, easing: "ease_out" },
        })), ...emergencyPlan.moveRoutes.map(({ connectionId, targetId, target: moveTarget, transition }, routeIndex) => ({
          op: "connect_event",
          op_id: `connect_model_move_${routeIndex + 1}`,
          connection: {
            kind: "event_connection",
            id: connectionId,
            sourceComponentId: city.button,
            event: "pressed",
            targetComponentId: targetId,
            action: "move_to",
            input: { target: moveTarget },
            enabled: true,
            transition,
          },
        })), ...emergencyPlan.visibilityRoutes.map(({ connectionId, targetId, action, transition }, routeIndex) => ({
          op: "connect_event",
          op_id: `connect_model_state_${routeIndex + 1}`,
          connection: {
            kind: "event_connection",
            id: connectionId,
            sourceComponentId: city.button,
            event: "pressed",
            targetComponentId: targetId,
            action,
            input: {},
            enabled: true,
            transition,
          },
        }))]);
      },
    });
    if (!planPreparation || !planReceipt) throw new Error("The validated emergency plan was not revealed.");
    const previewAfterPlan = await assertRejectedPreviewCollapsed("Validated plan");
    await assertProjectedControlsInsideViewport(cdp, "Validated-plan shot");

    await presentCamera("response");
    const cameraReadyForClick = await callAgent(client, "inspect_workspace", session);
    const revisionBeforeClick = cameraReadyForClick.data.workspace_summary.revision;
    let pointerClicked = false;
    await captureResponseTrack(cdp, async () => {
      await pointerClickTextButton(cdp, "一键打开急救通道");
      pointerClicked = true;
    });
    if (!pointerClicked) throw new Error("The real pointer click did not run in the response capture.");
    await refreshSession("after_response_capture");
    const afterClick = await callAgent(client, "inspect_workspace", session);
    const revisionAfterClick = afterClick.data.workspace_summary.revision;
    if (revisionAfterClick !== revisionBeforeClick + 1) {
      throw new Error(`The one-click response was not one atomic revision: ${revisionBeforeClick} -> ${revisionAfterClick}.`);
    }
    const expectedPlacements = emergencyPlan.endpoints.map((endpoint) => [endpoint.targetId, {
      position: endpoint.finalPosition,
      rotation: endpoint.finalRotation,
      scale: endpoint.finalScale,
    }]);
    const ambulanceEndpoint = emergencyPlan.endpoints.find((endpoint) => endpoint.targetId === city.ambulanceRoot);
    if (!ambulanceEndpoint) throw new Error("The compiled model plan has no ambulance endpoint.");
    const finalPlacements = [];
    for (const [componentId, expectedPlacement] of expectedPlacements) {
      const inspection = await callAgent(client, "inspect_workspace_component", {
        ...session,
        component_id: componentId,
      });
      const placement = inspection.data?.component?.placement;
      const actualPlacement = placement && {
        position: placement.position,
        rotation: placement.rotation,
        scale: placement.scale,
      };
      if (!inspection.ok || JSON.stringify(actualPlacement) !== JSON.stringify(expectedPlacement)) {
        throw new Error(`Routed move_to did not reach ${componentId}: ${JSON.stringify(actualPlacement)}.`);
      }
      finalPlacements.push({ componentId, ...actualPlacement });
    }
    const expectedVisibility = emergencyPlan.visibilityRoutes.map((route) => [
      route.targetId,
      route.action === "show" ? "visible" : "hidden",
    ]);
    const finalVisibility = [];
    for (const [componentId, expected] of expectedVisibility) {
      const inspection = await callAgent(client, "inspect_workspace_component", { ...session, component_id: componentId });
      const visibility = inspection.data?.component?.visibility;
      if (!inspection.ok || visibility !== expected) {
        throw new Error(`Routed visibility did not reach ${componentId}: ${visibility}.`);
      }
      finalVisibility.push({ componentId, visibility });
    }
    const eventPage = await callAgent(client, "read_workspace_events", { ...session, limit: 50 });
    const responseEvents = eventPage.data?.events ?? [];
    const pressEvents = responseEvents.filter((event) => event.type === "pressed" && event.componentId === city.button);
    const movedEvents = responseEvents.filter((event) => event.type === "moved" && event.source === "binding");
    const routedVisibilityEvents = responseEvents.filter((event) => event.type === "visibility_changed" && event.source === "binding");
    if (pressEvents.length !== 1
      || movedEvents.length !== emergencyPlan.moveRoutes.length
      || routedVisibilityEvents.length !== emergencyPlan.visibilityRoutes.length) {
      throw new Error(`Unexpected one-click event fan-out: ${pressEvents.length} press, ${movedEvents.length} moved, ${routedVisibilityEvents.length} visibility.`);
    }

    let undoResult;
    let redoResult;
    await captureFrames(cdp, "undo-redo-frames", {
      beforeFrame: async (index) => {
        if (index === 16) {
          undoResult = await callAgent(client, "undo_workspace_batch", {
            ...session,
            expected_workspace_revision: revisionAfterClick,
          });
          if (!undoResult.ok || undoResult.data?.changed !== true) throw new Error("The emergency response undo failed.");
          await delay(800);
        }
        if (index === 56) {
          if (!undoResult?.ok) throw new Error("Redo ran before a successful emergency response undo.");
          redoResult = await callAgent(client, "redo_workspace_batch", {
            ...session,
            expected_workspace_revision: undoResult.data.workspace_revision,
          });
          if (!redoResult.ok || redoResult.data?.changed !== true) throw new Error("The emergency response redo failed.");
          await delay(800);
        }
      },
    });
    if (!undoResult?.ok || !redoResult?.ok) throw new Error("The fixed-frame emergency undo/redo sequence did not complete.");
    await delay(2_300);
    const ambulanceAfterRedo = await callAgent(client, "inspect_workspace_component", {
      ...session,
      component_id: city.ambulanceRoot,
    });
    const ambulanceAfterRedoPlacement = ambulanceAfterRedo.data?.component?.placement;
    if (JSON.stringify({
      position: ambulanceAfterRedoPlacement?.position,
      rotation: ambulanceAfterRedoPlacement?.rotation,
      scale: ambulanceAfterRedoPlacement?.scale,
    }) !== JSON.stringify({
      position: ambulanceEndpoint.finalPosition,
      rotation: ambulanceEndpoint.finalRotation,
      scale: ambulanceEndpoint.finalScale,
    })) {
      throw new Error("Redo did not restore the ambulance endpoint.");
    }

    const resolvedTrafficData = {
      labels: ["OPEN", "+3s", "+6s", "+9s", "+12s"],
      series: [{ id: "clearance", label: "通道净宽 m", values: [3.2, 3.35, 3.5, 3.65, 3.8], color: "#42E79A" }],
      incident: {
        severity: "critical",
        ambulanceId: "AMB-07",
        etaSeconds: 11,
        currentClearanceM: 3.8,
        requiredClearanceM: 3.2,
      },
      route: {
        from: "Market Street incident",
        via: "Central emergency avenue",
        to: "City General Hospital",
        status: "open",
      },
    };
    const resolvePreparation = await begin("Record the deterministic dispatch snapshot after the corridor response");
    await submit(resolvePreparation, [{
      op: "upsert_resource",
      op_id: "resolve_emergency_traffic_snapshot",
      resource: {
        ...trafficResource,
        snapshot: {
          data: resolvedTrafficData,
          contentHash: "caller-value-is-host-normalized-again",
          retrievedAt: "1970-01-01T00:00:12.000Z",
          stale: false,
          provenance: [],
        },
      },
    }, {
      op: "update_component",
      op_id: "update_emergency_chart_title",
      id: city.chart,
      patch: { props: { title: "通道已开 · ETA 11 秒 · 净宽 3.8 m" } },
      transition: { durationMs: 420, easing: "ease_out" },
    }]);
    const postReadRevision = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
    const resolvedRead = await callAgent(client, "read_workspace_resource_snapshot", {
      ...session,
      resource_id: trafficResource.id,
    });
    const postReadRevisionAfter = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
    if (!resolvedRead.ok
      || resolvedRead.data?.snapshot?.data?.route?.status !== "open"
      || resolvedRead.data?.snapshot?.data?.incident?.etaSeconds !== 11
      || postReadRevisionAfter !== postReadRevision) {
      throw new Error("The post-response snapshot did not read back exactly without mutating the Workspace.");
    }
    const preSaveWorkspace = await callAgent(client, "inspect_workspace", session);
    const preSaveSpaceInspection = await callAgent(client, "inspect_workspace_space", session);
    const preSavePhysicsInspection = await callAgent(client, "inspect_workspace_physics", session);
    const preSavePhysicsValidation = preSavePhysicsInspection.data?.physics_validation;
    const preSaveValidation = summarizeEmergencyCityValidation(
      preSaveSpaceInspection,
      preSavePhysicsInspection,
    );
    if (!preSaveValidation.ok) {
      writeFileSync(
        join(outputRoot, "pre-save-validation-failure.json"),
        `${JSON.stringify(preSaveValidation.diagnostics, null, 2)}\n`,
      );
      throw new Error(`The final emergency city did not pass spatial and bounded physics validation: ${JSON.stringify(preSaveValidation.diagnostics)}`);
    }

    const savedProjectText = await captureWorkspaceProject(cdp, "emergency-city-v3");
    const savedProject = JSON.parse(savedProjectText);
    if (savedProject.formatVersion !== "1.0" || savedProject.workspace?.revision !== preSaveWorkspace.data?.workspace_summary?.revision) {
      throw new Error("The saved emergency-city project did not preserve the validated Workspace revision.");
    }
    const savedControlRoutes = capturedControlRoutes(savedProject, city.button);
    if (savedControlRoutes.length !== emergencyPlan.moveRoutes.length + emergencyPlan.visibilityRoutes.length) {
      throw new Error("The saved emergency-city project did not contain every compiled model route.");
    }
    const savedControlRoutesHash = hashCanonical(savedControlRoutes);
    await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled emergency-city save notice", 12_000);
    const injected = await cdp.evaluate(`(() => {
      const input = document.querySelector('input[type="file"][accept*="semaframe"]')
        ?? document.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(savedProjectText)}], 'emergency-city-v3.semaframe.json', { type: 'application/json' }));
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!injected) throw new Error("The saved emergency-city project could not be supplied to Open.");
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "reopened emergency-city Agent gate", 20_000);
    await client.close().catch(() => undefined);
    const reopenedConnection = await connectAgent(cdp, "Emergency City Reopen Verification Agent");
    client = reopenedConnection.client;
    session = reopenedConnection.session;
    const reopenedWorkspace = await callAgent(client, "inspect_workspace", session);
    const beforeSaveSummary = preSaveWorkspace.data?.workspace_summary;
    const reopenedSummary = reopenedWorkspace.data?.workspace_summary;
    if (!reopenedWorkspace.ok
      || reopenedSummary?.revision !== beforeSaveSummary?.revision
      || reopenedSummary?.component_count !== beforeSaveSummary?.component_count
      || reopenedSummary?.resource_count !== beforeSaveSummary?.resource_count
      || reopenedSummary?.connection_count !== beforeSaveSummary?.connection_count) {
      throw new Error(`Reopen did not preserve the validated emergency-city Workspace: ${JSON.stringify({ beforeSaveSummary, reopenedSummary })}`);
    }
    const reopenedProjectText = await captureWorkspaceProject(cdp, "emergency-city-v3-reopened");
    const reopenedProject = JSON.parse(reopenedProjectText);
    const reopenedControlRoutes = capturedControlRoutes(reopenedProject, city.button);
    const reopenedControlRoutesHash = hashCanonical(reopenedControlRoutes);
    if (reopenedControlRoutesHash !== savedControlRoutesHash
      || JSON.stringify(reopenedControlRoutes) !== JSON.stringify(savedControlRoutes)) {
      throw new Error("Reopen did not preserve every model route ID, action, input, and transition.");
    }
    await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled reopened-project route verification save", 12_000);
    const reopenedAmbulance = await callAgent(client, "inspect_workspace_component", { ...session, component_id: city.ambulanceRoot });
    const reopenedSnapshot = await callAgent(client, "read_workspace_resource_snapshot", { ...session, resource_id: trafficResource.id });
    const previewAfterReopen = await assertRejectedPreviewCollapsed("Reopened Workspace");
    const reopenedAmbulancePlacement = reopenedAmbulance.data?.component?.placement;
    if (JSON.stringify({
      position: reopenedAmbulancePlacement?.position,
      rotation: reopenedAmbulancePlacement?.rotation,
      scale: reopenedAmbulancePlacement?.scale,
    }) !== JSON.stringify({
      position: ambulanceEndpoint.finalPosition,
      rotation: ambulanceEndpoint.finalRotation,
      scale: ambulanceEndpoint.finalScale,
    })
      || reopenedSnapshot.data?.snapshot?.data?.route?.status !== "open") {
      throw new Error("Reopen did not restore the final ambulance endpoint and open dispatch snapshot.");
    }
    await enterImmersive(cdp);
    await assertNativeCaptureViewport(cdp, "Reopened immersive Workspace");
    await delay(1_100);
    await presentCamera("reopen");
    await captureDragTrack(cdp, "reopen-frames", {
      deltaX: -18,
      deltaY: 3,
      arcY: 3,
      startXRatio: 0.53,
      startYRatio: 0.5,
    });

    const spaceInspection = await callAgent(client, "inspect_workspace_space", session);
    const physicsInspection = await callAgent(client, "inspect_workspace_physics", session);
    const spatialGraph = spaceInspection.data?.spatial_graph;
    const physicsValidation = physicsInspection.data?.physics_validation;
    const reopenedValidation = summarizeEmergencyCityValidation(spaceInspection, physicsInspection);
    const physicsEnabledBodyCount = reopenedValidation.diagnostics.enabledBodyCount;
    const physicsKinematicBodyCount = reopenedValidation.diagnostics.kinematicBodyCount;
    if (!reopenedValidation.ok) {
      writeFileSync(
        join(outputRoot, "reopen-validation-failure.json"),
        `${JSON.stringify(reopenedValidation.diagnostics, null, 2)}\n`,
      );
      throw new Error(`The reopened emergency city did not pass spatial and bounded physics validation: ${JSON.stringify(reopenedValidation.diagnostics)}`);
    }
    await presentCamera("final");
    await captureFinalArc(cdp);
    if (LOGIC_ONLY) {
      const logicEvidence = {
        mode: "logic_only",
        generatedAt: new Date().toISOString(),
        releaseEvidence: false,
        sourceFramesWritten: 0,
        livePlanner: emergencyPlan.plannerRun.manifest.live_model === true,
        plannerMode: emergencyPlan.plannerRun.manifest.mode,
        plannerRunId: emergencyPlan.plannerRun.manifest.run_id,
        savedRevision: beforeSaveSummary.revision,
        reopenedRevision: reopenedSummary.revision,
        modelRoutesPreservedExactly: reopenedControlRoutesHash === savedControlRoutesHash,
        rejectedPreviewLifecycle: {
          componentIds: ghostComponentIds,
          partOfModelPlan: false,
          dismissalRevision: previewDismissalReceipt.resulting_workspace_revision,
          planCameraRevision: plannerAuthority.revision,
          afterDismissal: previewAfterDismissal,
          afterPlan: previewAfterPlan,
          afterReopen: previewAfterReopen,
        },
        spatialAndPhysics: reopenedValidation.diagnostics,
      };
      writeFileSync(join(outputRoot, "logic-validation.json"), `${JSON.stringify(logicEvidence, null, 2)}\n`);
      console.log(`Emergency-city logic validation complete: ${outputRoot}`);
      return;
    }
    assertExactFrameContract();

    const webgl = await cdp.evaluate(`(() => {
      const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) return null;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        context: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
        renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        contextLost: gl.isContextLost(),
      };
    })()`);
    if (!webgl || webgl.contextLost) throw new Error("WebGL was unhealthy after the exact-frame capture.");

    const finalWorkspace = await callAgent(client, "inspect_workspace", session);
    const finalEvents = await callAgent(client, "read_workspace_events", { ...session, limit: 100 });
    const evidence = {
      demo: "SemaFrame miniature-city emergency corridor hero",
      generatedAt: new Date().toISOString(),
      syntheticBaseline: true,
      workspace: {
        revision: finalWorkspace.data?.workspace_summary?.revision,
        componentCount: finalWorkspace.data?.workspace_summary?.component_count,
        historyCount: finalWorkspace.data?.workspace_summary?.history_count,
        foundationOperationCount: foundationOperations.length,
        atomicBuildOperationCount: cityOperationCount,
      },
      agentSessionLifecycle: {
        strategy: "rotate_through_approved_offer",
        rotationCount: sessionLifecycle.length - 1,
        checkpoints: sessionLifecycle,
        productDefaultTtlChanged: false,
        approvalCredentialPersisted: false,
      },
      dispatchSnapshot: {
        connectorType: feedRead.data.connector_type,
        connectorVersion: feedRead.data.connector_version,
        authorizedScope: connected.grantedScopes.includes("effect:data_read"),
        snapshotAuthority: feedRead.data.snapshot_authority,
        initialHash: feedRead.data.snapshot?.content_hash,
        initialRetrievedAt: feedRead.data.snapshot?.retrieved_at,
        initialEtaSeconds: readData.incident.etaSeconds,
        initialClearanceM: readData.incident.currentClearanceM,
        requiredClearanceM: readData.incident.requiredClearanceM,
        revisionBeforeRead,
        revisionAfterRead,
        readWasNonMutating: revisionBeforeRead === revisionAfterRead,
        finalHash: resolvedRead.data.snapshot?.content_hash,
        finalRetrievedAt: resolvedRead.data.snapshot?.retrieved_at,
        finalEtaSeconds: resolvedRead.data.snapshot?.data?.incident?.etaSeconds,
        finalClearanceM: resolvedRead.data.snapshot?.data?.incident?.currentClearanceM,
        finalOutcomeAuthority: "deterministic_synthetic_scenario",
        finalOutcomeGeometryDerived: false,
        untrustedDataNotice: feedRead.data.untrusted_data_notice,
      },
      rejectedEndpoint: {
        componentId: city.blueRoot,
        previewComponentId: ghostId,
        previewOnly: true,
        errorCode: rejectedMove.error.code,
        requiredAction: rejectedMove.error.required_action,
        revisionBefore: badMovePreparation.envelope.base_workspace_revision,
        revisionAfter: revisionAfterRejection,
        atomic: revisionAfterRejection === badMovePreparation.envelope.base_workspace_revision,
        preflightValid: collisionQuery.data.placement_check.valid,
        conflicts: collisionQuery.data.placement_check.conflicts,
        previewLifecycle: {
          componentIds: ghostComponentIds,
          hostAuthoredCleanup: true,
          partOfModelPlan: false,
          dismissalStatus: previewDismissalReceipt.status,
          dismissalRevision: previewDismissalReceipt.resulting_workspace_revision,
          planCameraRevision: plannerAuthority.revision,
          collapsedAfterDismissal: previewAfterDismissal,
          collapsedAfterPlan: previewAfterPlan,
          collapsedAfterReopen: previewAfterReopen,
          persistedAcrossSaveReopen: previewAfterReopen.every((entry) => entry.visibility === "collapsed"),
        },
      },
      planner: {
        mode: emergencyPlan.plannerRun.manifest.mode,
        liveModel: emergencyPlan.plannerRun.manifest.live_model,
        hardcodedFallback: emergencyPlan.plannerRun.manifest.hardcoded_fallback,
        model: emergencyPlan.plannerRun.manifest.model,
        runtimeVersion: emergencyPlan.plannerRun.manifest.runtime_version,
        runId: emergencyPlan.plannerRun.manifest.run_id,
        runHash: emergencyPlan.plannerRun.manifest.run_hash,
        hashes: emergencyPlan.plannerRun.manifest.hashes,
        attempts: plannerAttempts,
        successfulAttempt: emergencyPlan.plannerRun.attempt,
        truthEventCount: emergencyPlan.plannerRun.truthWindow.events?.length,
        finalArtifactDirectory: finalPlannerDirectory.slice(outputRoot.length + 1),
        vehicleToBayAssignmentSupplied: false,
        safeBayCandidateRegionsSupplied: true,
        endpointCoordinatesAuthoredByModelWithinHostRegions: true,
        requiredEffectsDefinedByHostMission: true,
        actionCountWasNotPresentedAsAnOpenDecision: true,
        hostMissionContractValidated: true,
        hostPreflightRevision: plannerAuthority.revision,
        preflightRevisionAfter,
        dispatchSnapshotReadRevision: plannerFeedRead.data.workspace_revision,
        dispatchSnapshotReadRegistryDigest: plannerFeedRead.data.registry_digest,
        hostValidationReceiptHash,
      },
      validatedPlan: {
        authoringSource: emergencyPlan.source,
        safePreflights,
        buttonId: city.button,
        planActionCount: emergencyPlan.plannerRun.plan.control.actions.length,
        routeCount: emergencyPlan.moveRoutes.length + emergencyPlan.visibilityRoutes.length,
        moveTargetIds: expectedPlacements.map(([componentId]) => componentId),
        visibilityTargetIds: expectedVisibility.map(([componentId]) => componentId),
      },
      oneClickResponse: {
        pointerInput: true,
        sourceButtonId: city.button,
        revisionBefore: revisionBeforeClick,
        revisionAfter: revisionAfterClick,
        revisionDelta: revisionAfterClick - revisionBeforeClick,
        pressEventCount: pressEvents.length,
        movedEventCount: movedEvents.length,
        routedVisibilityEventCount: routedVisibilityEvents.length,
        routedActionCount: movedEvents.length + routedVisibilityEvents.length,
        finalPlacements,
        finalVisibility,
        eventSummary: responseEvents.map((event) => ({
          type: event.type,
          componentId: event.componentId,
          source: event.source,
        })),
      },
      undoRedo: {
        undoRevision: undoResult.data.workspace_revision,
        redoRevision: redoResult.data.workspace_revision,
        ambulanceRestored: true,
        undoSourceFrame: 16,
        redoSourceFrame: 56,
      },
      saveReopen: {
        realUiSave: true,
        realUiOpen: true,
        projectFormatVersion: savedProject.formatVersion,
        projectProtocolVersion: savedProject.protocolVersion,
        savedRevision: beforeSaveSummary.revision,
        reopenedRevision: reopenedSummary.revision,
        savedComponentCount: beforeSaveSummary.component_count,
        reopenedComponentCount: reopenedSummary.component_count,
        savedResourceCount: beforeSaveSummary.resource_count,
        reopenedResourceCount: reopenedSummary.resource_count,
        savedConnectionCount: beforeSaveSummary.connection_count,
        reopenedConnectionCount: reopenedSummary.connection_count,
        ambulanceEndpointRestored: true,
        dispatchSnapshotRestored: true,
        modelRoutesRestoredExactly: true,
        modelRouteCount: savedControlRoutes.length,
        modelRoutesHash: savedControlRoutesHash,
      },
      validation: {
        spatialGraphVersion: spatialGraph.version,
        collisionConflictCount: (spatialGraph.collision_conflicts ?? []).length,
        physicsVersion: physicsValidation.version,
        physicsModel: physicsValidation.model,
        physicsFeasible: physicsValidation.feasible,
        physicsIssues: physicsValidation.issues,
        physicsEnabledBodyCount,
        physicsKinematicBodyCount,
        finalEventCount: finalEvents.data?.events?.length,
      },
      capture: {
        width: CAPTURE_WIDTH,
        height: CAPTURE_HEIGHT,
        fps: CAPTURE_FPS,
        durationSeconds: Object.values(FRAME_CONTRACT).reduce((sum, count) => sum + count, 0) / CAPTURE_FPS,
        totalSourceFrames: Object.values(FRAME_CONTRACT).reduce((sum, count) => sum + count, 0),
        sourceFrameMapping: "one_source_image_per_30fps_output_frame",
        nativeSourceResolution: true,
        cameraStateAuthoredInWorkspace: true,
        cameraPresets: Object.keys(CAMERA_PRESETS),
        projectedControlCropGuard: true,
        captureChromeHidden: ["fullscreen_exit_control"],
        webgl,
        frameFolders,
        frameCounts: FRAME_CONTRACT,
        visualLayersM: VISUAL_LAYERS,
        stabilization: "two_requestAnimationFrame_then_webgl_finish_before_each_capture",
      },
      claimBoundaries: [
        "The city is a synthetic parametric miniature, not a survey or municipal digital twin.",
        "The dispatch feed is a deterministic host-normalized inline snapshot, not a network refresh.",
        "The post-response ETA and clearance values are scripted synthetic scenario state, not values calculated from vehicle dynamics or a routing engine.",
        "The host defined the required emergency effects and candidate safe regions; a live isolated Codex model identified blockers, assigned vehicles to bays, and authored exact endpoint coordinates before host preflight and route compilation.",
        "move_to validates the committed endpoint; renderer interpolation is not swept-path collision detection or continuous physics.",
        "Spatial and physics checks are deterministic preflight evidence, not emergency-services certification.",
      ],
    };
    writeFileSync(join(outputRoot, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Emergency-city capture complete: ${outputRoot}`);
  } catch (error) {
    const tail = logs.join("").slice(-6_000);
    if (tail.trim()) console.error(tail);
    throw error;
  } finally {
    stack.kill("SIGTERM");
    browser.kill("SIGTERM");
    cdp?.close();
    await Promise.race([
      client ? client.close().catch(() => undefined) : Promise.resolve(),
      delay(1_200),
    ]);
    await delay(250);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (import.meta.url === new URL(`file://${resolve(process.argv[1] ?? "")}`).href) {
  await captureEmergencyCityDemo();
  process.exit(0);
}
