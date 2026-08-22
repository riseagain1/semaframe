import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const publicRoot = resolve("video/public/realityops");
const artifactRoot = resolve("artifacts/realityops");
const FRAME_COUNT = Number(process.env.REALITYOPS_FRAME_COUNT ?? 48);
if (!Number.isSafeInteger(FRAME_COUNT) || FRAME_COUNT < 8 || FRAME_COUNT > 120) {
  throw new Error("REALITYOPS_FRAME_COUNT must be an integer from 8 through 120.");
}

const IMMERSIVE_SEQUENCE_FOLDERS = [
  "immersive-room-frames",
  "immersive-build-frames",
  "immersive-collision-frames",
  "immersive-correction-frames",
  "immersive-control-frames",
  "immersive-undo-redo-frames",
  "immersive-final-frames",
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

async function capture(cdp, filename) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(join(publicRoot, filename), Buffer.from(result.data, "base64"));
}

async function captureMotion(cdp, folder, frameCount = FRAME_COUNT, frameDelayMs = 88) {
  const directory = join(publicRoot, folder);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < frameCount; index += 1) {
    const result = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 86,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    writeFileSync(join(directory, `frame-${String(index).padStart(4, "0")}.jpg`), Buffer.from(result.data, "base64"));
    await delay(frameDelayMs);
  }
}

async function recordAction(cdp, folder, action) {
  const recording = captureMotion(cdp, folder);
  await delay(320);
  const result = await action();
  await recording;
  return result;
}

function prepareFrameDirectory(folder) {
  const directory = join(publicRoot, folder);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

async function captureJpeg(cdp, directory, index) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 90,
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(
    join(directory, `frame-${String(index).padStart(4, "0")}.jpg`),
    Buffer.from(result.data, "base64"),
  );
}

function allocateStateFrames(totalFrames, stateCount) {
  if (stateCount < 1 || totalFrames < stateCount) {
    throw new Error(`Cannot allocate ${totalFrames} frames across ${stateCount} visible states.`);
  }
  const base = Math.floor(totalFrames / stateCount);
  const remainder = totalFrames % stateCount;
  return Array.from({ length: stateCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Capture a deterministic sequence of genuine committed Workspace states.
 * Stable duplicate frames are intentional holds; visible progression comes
 * only from the real transactions supplied in `stages`, never from an edit-time
 * interpolation that pretends one atomic update was a build animation.
 */
async function captureStagedMotion(cdp, folder, stages, options = {}) {
  const directory = prepareFrameDirectory(folder);
  const allocations = allocateStateFrames(FRAME_COUNT, stages.length + 1);
  const frameDelayMs = options.frameDelayMs ?? 72;
  let frameIndex = 0;

  const captureState = async (count) => {
    for (let index = 0; index < count; index += 1) {
      await captureJpeg(cdp, directory, frameIndex);
      frameIndex += 1;
      if (index + 1 < count) await delay(frameDelayMs);
    }
  };

  await captureState(allocations[0]);
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    await stages[stageIndex]();
    // Let the committed React/Three state enter its real presentation
    // transition before recording the new state and its stable hold.
    await delay(options.settleMs ?? 90);
    await captureState(allocations[stageIndex + 1]);
  }
  if (frameIndex !== FRAME_COUNT) throw new Error(`${folder} wrote ${frameIndex}/${FRAME_COUNT} frames.`);
}

async function enterImmersive(cdp) {
  if (!await cdp.evaluate("document.querySelector('.viewport-shell')?.classList.contains('is-immersive')")) {
    if (!await cdp.evaluate(clickButtonWithAriaLabel("Enter full screen"))) {
      throw new Error("The Workspace immersive full-screen control was unavailable.");
    }
  }
  await poll(cdp, "document.querySelector('.viewport-shell')?.classList.contains('is-immersive')", "immersive Workspace");
  await cdp.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur(); true");
  await delay(280);
}

async function exitImmersive(cdp) {
  if (await cdp.evaluate("document.querySelector('.viewport-shell')?.classList.contains('is-immersive')")) {
    if (!await cdp.evaluate(clickButtonWithAriaLabel("Exit full screen"))) {
      throw new Error("The Workspace immersive exit control was unavailable.");
    }
  }
  await poll(cdp, "!document.querySelector('.viewport-shell')?.classList.contains('is-immersive')", "standard Workspace view");
  await delay(280);
}

async function captureOrbitMotion(cdp, folder) {
  const directory = prepareFrameDirectory(folder);
  const startX = 650;
  const y = 450;
  const travel = 260;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: startX, y, button: "left", buttons: 1, clickCount: 1,
  });
  try {
    for (let index = 0; index < FRAME_COUNT; index += 1) {
      const progress = FRAME_COUNT === 1 ? 1 : index / (FRAME_COUNT - 1);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + travel * progress,
        y: y - Math.sin(progress * Math.PI) * 34,
        button: "left",
        buttons: 1,
      });
      await delay(42);
      await captureJpeg(cdp, directory, index);
    }
  } finally {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: startX + travel, y, button: "left", buttons: 0, clickCount: 1,
    });
  }
}

function frameCountFor(folder) {
  const directory = join(publicRoot, folder);
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((name) => /^frame-\d{4}\.jpg$/.test(name)).length;
}

async function frameAll(cdp) {
  await cdp.evaluate(clickButtonWithAriaLabel("Frame all"));
  await delay(850);
}

async function zoomScene(cdp, repetitions = 3) {
  for (let index = 0; index < repetitions; index += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 800,
      y: 470,
      deltaX: 0,
      deltaY: -480,
    });
    await delay(120);
  }
  await delay(350);
}

async function clearCanvasSelection(cdp) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1080, y: 740, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1080, y: 740, button: "left", clickCount: 1 });
  await delay(250);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

const disabledPhysics = {
  enabled: false,
  bodyType: "static",
  massKg: 1,
  centerOfMass: { x: 0, y: 0, z: 0 },
  friction: 0.6,
  restitution: 0.1,
  gravityScale: 1,
  stabilityMode: "report",
  constraints: [],
};

async function authorizeWorkspace(cdp, label, captures = {}) {
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", `${label} disabled connection gate`);
  if (!await cdp.evaluate(clickExactButton("Enable agent control"))) throw new Error(`${label} could not enable Agent control.`);
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-waiting'))", `${label} waiting connection gate`);
  const connectionUrl = await cdp.evaluate("document.querySelector('.agent-connection-url-wrap input')?.value");
  if (typeof connectionUrl !== "string") throw new Error(`${label} connection URL was not rendered.`);
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
  });
  const approvalToken = pending.error?.details?.approval_token;
  if (pending.ok !== false || pending.error?.code !== "approval_pending" || typeof approvalToken !== "string") {
    throw new Error(`${label} did not enter approval_pending.`);
  }
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-approval'))", `${label} approval card`);
  if (captures.approval) await capture(cdp, captures.approval);
  if (!await cdp.evaluate(clickExactButton("Approve client"))) throw new Error(`${label} could not approve the Agent.`);
  await poll(cdp, "!document.querySelector('.agent-connection-page.status-approval')", `${label} approved handoff`);
  const instructions = await callAgent(client, "get_workspace_instructions", {
    client_id: label,
    client_name: label,
    approval_token: approvalToken,
  });
  if (!instructions.ok) throw new Error(`${label} handshake failed: ${instructions.error?.code}`);
  await poll(cdp, "document.querySelector('.hybrid-workspace-canvas')?.dataset.sceneEngineReady === 'true'", `${label} renderer ready`);
  await poll(cdp, "Boolean(document.querySelector('.agent-workspace-controls.status-connected'))", `${label} Workspace connected`);
  return {
    client,
    session: {
      session_token: instructions.data.session_token,
      instruction_digest: instructions.data.guide_digest,
    },
  };
}

async function captureWorkspaceProject(cdp, key) {
  await cdp.evaluate(`(() => {
    window.__realityOpsSavedProjects ??= {};
    window.__realityOpsSaveKey = ${JSON.stringify(key)};
    delete window.__realityOpsSavedProjects[window.__realityOpsSaveKey];
    if (!window.__realityOpsObjectUrlHooked) {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (value) => {
        const saveKey = window.__realityOpsSaveKey;
        if (saveKey && value instanceof Blob) {
          void value.text().then((contents) => {
            window.__realityOpsSavedProjects[saveKey] = contents;
          });
        }
        return createObjectURL(value);
      };
      window.__realityOpsObjectUrlHooked = true;
    }
    document.querySelector('button[aria-label="Save project"]')?.click();
  })()`);
  await poll(cdp, `Boolean(window.__realityOpsSavedProjects?.[${JSON.stringify(key)}])`, `captured ${key} project`);
  return cdp.evaluate(`window.__realityOpsSavedProjects[${JSON.stringify(key)}]`);
}

async function installArtifactCapture(cdp) {
  await cdp.evaluate(`(() => {
    window.__realityOpsArtifacts = {};
    window.__realityOpsBlobs = new Map();
    if (!window.__realityOpsArtifactHooked) {
      const createObjectURL = URL.createObjectURL.bind(URL);
      const nativeClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (value) => {
        const url = createObjectURL(value);
        if (value instanceof Blob) window.__realityOpsBlobs.set(url, value);
        return url;
      };
      HTMLAnchorElement.prototype.click = function click() {
        const blob = window.__realityOpsBlobs.get(this.href);
        const filename = this.download;
        if (blob instanceof Blob && filename) {
          void blob.text().then((contents) => {
            window.__realityOpsArtifacts[filename] = { contents, byteLength: blob.size, type: blob.type };
          });
        }
        return nativeClick.call(this);
      };
      window.__realityOpsArtifactHooked = true;
    }
    return true;
  })()`);
}

async function capturedArtifact(cdp, extension, timeoutMs = 120_000) {
  await poll(
    cdp,
    `Object.keys(window.__realityOpsArtifacts ?? {}).some((name) => name.endsWith(${JSON.stringify(extension)}))`,
    `${extension} download`,
    timeoutMs,
  );
  return cdp.evaluate(`(() => {
    const name = Object.keys(window.__realityOpsArtifacts).find((candidate) => candidate.endsWith(${JSON.stringify(extension)}));
    return name ? { name, ...window.__realityOpsArtifacts[name] } : undefined;
  })()`);
}

function componentRef(manifest, typeId) {
  const entry = manifest.component_types.find((candidate) => candidate.typeId === typeId);
  if (!entry) throw new Error(`Missing component manifest ${typeId}`);
  return { typeId: entry.typeId, version: entry.version, digest: entry.digest };
}

function primitive({ id, label, geometry, placement, parentId, color, opacity, metallic, roughness, emissiveColor, emissiveIntensity, collision, physics, visibility }) {
  return {
    op: "create_component",
    op_id: `create_${id}`,
    id,
    label,
    component_type: null,
    props: {
      geometry,
      material: material(color, { opacity, metallic, roughness, emissiveColor, emissiveIntensity }),
      ...(collision ? { collision } : {}),
      ...(physics ? { physics } : {}),
    },
    placement,
    ...(parentId ? { parent_id: parentId } : {}),
    ...(visibility ? { visibility } : {}),
  };
}

export async function captureRealityOpsDemoAssets() {
  mkdirSync(publicRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const gatewayPort = await freePort();
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const appUrl = `http://127.0.0.1:${vitePort}/`;
  const profile = mkdtempSync(join(tmpdir(), "semaframe-realityops-video-"));
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
  const clients = [];
  let cdp;

  try {
    await waitForHttp(`${gatewayUrl}/healthz`);
    await waitForHttp(appUrl);
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);
    const target = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })
      .then((response) => response.json());
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: appUrl });

    let authorization = await authorizeWorkspace(cdp, "RealityOps Demo Agent", {
      connection: "00-connection.png",
      approval: "01-approved.png",
    });
    clients.push(authorization.client);
    let { client, session } = authorization;
    await cdp.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Project name"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'RealityOps Pump Room');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await delay(250);
    await capture(cdp, "02-empty.png");

    const initial = await callAgent(client, "inspect_workspace", session);
    if (!initial.ok) throw new Error(`Initial inspection failed: ${initial.error?.code}`);
    const begin = async (intent, count) => {
      const prepared = await callAgent(client, "begin_workspace_update", {
        ...session,
        intent,
        ...(count ? { requested_component_ids: count } : {}),
      });
      if (!prepared.ok) throw new Error(`Could not prepare ${intent}: ${prepared.error?.code}`);
      return prepared.data;
    };
    const submitResult = (prepared, operations) => callAgent(client, "submit_workspace_batch", {
      ...session,
      transaction_token: prepared.transaction_token,
      batch: { ...prepared.envelope, operations },
    });
    const submit = async (prepared, operations) => {
      const result = await submitResult(prepared, operations);
      if (!result.ok) throw new Error(`Workspace update failed: ${result.error?.code} ${result.error?.message ?? ""}`);
      return result.data;
    };

    const baseline = await begin("Create a synthetic 16 metre brownfield pump room baseline", 18);
    const [
      stageId, roomId, backId, leftId, rightId, aisleId, cabinetId, cabinetBodyId, cabinetLampId, serviceId,
      pipeRackId, headerPipeId, leftDropId, rightDropId, bollardAId, bollardBId, bollardCId, bollardDId,
    ] = baseline.reserved_component_ids;
    const baselineManifest = baseline.capability_manifest;
    const stageRef = componentRef(baselineManifest, "stage-3d");
    const assemblyRef = componentRef(baselineManifest, "model-assembly");
    const primitiveRef = componentRef(baselineManifest, "spatial-primitive");
    const solidCollision = { enabled: true, role: "solid", shape: "asset_bounds", margin: 0 };
    const withPrimitiveRef = (operation) => ({ ...operation, component_type: primitiveRef });
    await enterImmersive(cdp);
    await captureStagedMotion(cdp, "immersive-room-frames", [async () => {
      await submit(baseline, [{
      op: "create_component",
      op_id: "create_realityops_stage",
      id: stageId,
      label: "Synthetic brownfield pump room",
      component_type: stageRef,
      props: {
        environmentPreset: "simple_room",
        dimensions: { width: 16, height: 5, depth: 12 },
        background: "#0B1118",
        gridVisible: true,
      },
      placement: world(0, 0, 0),
      transition: { durationMs: 360, easing: "ease_out" },
    }, {
      op: "create_component",
      op_id: "create_room_shell",
      id: roomId,
      label: "Brownfield room shell",
      component_type: assemblyRef,
      props: { description: "Synthetic procedural room shell", collisionPolicy: "external_only" },
      placement: world(0, 0, 0),
    }, withPrimitiveRef(primitive({
      id: backId, label: "Back wall", geometry: { kind: "box", sizeM: { x: 15.5, y: 4.5, z: 0.15 } },
      placement: world(0, 2.25, -5.75), parentId: roomId, color: "#34414D",
    })), withPrimitiveRef(primitive({
      id: leftId, label: "Left wall", geometry: { kind: "box", sizeM: { x: 0.15, y: 4.5, z: 11.5 } },
      placement: world(-7.75, 2.25, 0), parentId: roomId, color: "#2B3742",
    })), withPrimitiveRef(primitive({
      id: rightId, label: "Right wall", geometry: { kind: "box", sizeM: { x: 0.15, y: 4.5, z: 11.5 } },
      placement: world(7.75, 2.25, 0), parentId: roomId, color: "#2B3742",
    })), withPrimitiveRef(primitive({
      id: aisleId, label: "Protected service aisle · 1.6 m", geometry: { kind: "box", sizeM: { x: 1.6, y: 0.06, z: 9.4 } },
      placement: world(0, 0.03, 0), color: "#FFB86B", opacity: 0.32, collision: solidCollision, physics: disabledPhysics,
      visibility: "collapsed",
    })), {
      op: "create_component",
      op_id: "create_electrical_cabinet",
      id: cabinetId,
      label: "Electrical cabinet E-07",
      component_type: assemblyRef,
      props: { description: "Existing electrical cabinet and indicator", collisionPolicy: "external_only" },
      placement: world(4.8, 0, -4.9),
      visibility: "collapsed",
    }, withPrimitiveRef(primitive({
      id: cabinetBodyId, label: "E-07 cabinet body", geometry: { kind: "box", sizeM: { x: 1.2, y: 2.2, z: 0.6 } },
      placement: world(0, 1.1, 0), parentId: cabinetId, color: "#717D87", metallic: 0.4,
    })), withPrimitiveRef(primitive({
      id: cabinetLampId, label: "E-07 status lamp", geometry: { kind: "sphere", radiusM: 0.08 },
      placement: world(0, 1.75, 0.34), parentId: cabinetId, color: "#68D5FF", emissiveColor: "#68D5FF", emissiveIntensity: 3,
    })), withPrimitiveRef(primitive({
      id: serviceId, label: "Electrical service clearance", geometry: { kind: "box", sizeM: { x: 1.8, y: 2, z: 1.8 } },
      placement: world(4.8, 1, -3.45), color: "#FF6B7D", opacity: 0.18, collision: solidCollision, physics: disabledPhysics,
      visibility: "collapsed",
    })), {
      op: "create_component",
      op_id: "create_existing_pipe_rack",
      id: pipeRackId,
      label: "Existing process-water header",
      component_type: assemblyRef,
      props: { description: "Existing connected pipe header", collisionPolicy: "external_only" },
      placement: world(0, 0, 0),
      visibility: "collapsed",
    }, withPrimitiveRef(primitive({
      id: headerPipeId, label: "Overhead water header", geometry: { kind: "cylinder", radiusM: 0.18, heightM: 10, axis: "x" },
      placement: world(0, 3, -4.2), parentId: pipeRackId, color: "#4E8B92", metallic: 0.48,
    })), withPrimitiveRef(primitive({
      id: leftDropId, label: "P-101 header drop", geometry: { kind: "cylinder", radiusM: 0.13, heightM: 2.4, axis: "y" },
      placement: world(-4, 1.8, -4.2), parentId: pipeRackId, color: "#4E8B92", metallic: 0.48,
    })), withPrimitiveRef(primitive({
      id: rightDropId, label: "P-102 header drop", geometry: { kind: "cylinder", radiusM: 0.13, heightM: 2.4, axis: "y" },
      placement: world(1.6, 1.8, -4.2), parentId: pipeRackId, color: "#4E8B92", metallic: 0.48,
    })), ...[
      [bollardAId, -1.05, -3],
      [bollardBId, 1.05, -3],
      [bollardCId, -1.05, 3],
      [bollardDId, 1.05, 3],
    ].map(([id, x, z], index) => withPrimitiveRef(primitive({
      id,
      label: `Service aisle bollard ${index + 1}`,
      geometry: { kind: "cylinder", radiusM: 0.08, heightM: 1, axis: "y" },
      placement: world(x, 0.5, z),
      color: "#F1B44C",
      metallic: 0.25,
      visibility: "collapsed",
    })))]);
      await frameAll(cdp);
    }, async () => {
      const safetyReveal = await begin("Reveal the protected aisle and electrical clearance");
      await submit(safetyReveal, [aisleId, cabinetId, serviceId].map((id, index) => ({
        op: "update_component",
        op_id: `reveal_safety_${index}`,
        id,
        patch: { visibility: "visible" },
        transition: { durationMs: 520, easing: "ease_out" },
      })));
    }, async () => {
      const pipingReveal = await begin("Reveal the existing process-water header");
      await submit(pipingReveal, [{
        op: "update_component",
        op_id: "reveal_process_water_header",
        id: pipeRackId,
        patch: { visibility: "visible" },
        transition: { durationMs: 520, easing: "ease_out" },
      }]);
    }, async () => {
      const protectionReveal = await begin("Reveal the service-aisle bollards");
      await submit(protectionReveal, [bollardAId, bollardBId, bollardCId, bollardDId].map((id, index) => ({
        op: "update_component",
        op_id: `reveal_bollard_${index}`,
        id,
        patch: { visibility: "visible" },
        transition: { durationMs: 420, easing: "ease_out" },
      })));
    }]);
    await exitImmersive(cdp);
    await frameAll(cdp);
    await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled baseline notices", 12_000);
    await capture(cdp, "03-synthetic-baseline.png");
    await enterImmersive(cdp);
    await frameAll(cdp);
    await zoomScene(cdp, 7);

    const build = await begin("Author and publish a connected seven-part centrifugal pump skid", 10);
    const [pumpId, baseId, bodyId, motorId, inletId, outletId, guardId, statusId, chartId, buttonId] = build.reserved_component_ids;
    const manifest = build.capability_manifest;
    const buildAssemblyRef = componentRef(manifest, "model-assembly");
    const buildPrimitiveRef = componentRef(manifest, "spatial-primitive");
    const chartRef = componentRef(manifest, "chart");
    const buttonRef = componentRef(manifest, "button");
    const inline = manifest.connector_types.find((entry) => entry.connectorType === "inline.snapshot" && entry.connectorVersion === "1.0.0");
    const outputSchema = inline?.recommendedOutputSchemas?.find((entry) => entry.id === "chart.timeseries.v1")?.schema;
    if (!inline || !outputSchema) throw new Error("The chart snapshot connector was not advertised.");
    const pumpPart = (configuration) => ({ ...primitive(configuration), component_type: buildPrimitiveRef });
    const initialResource = {
      id: "RES_p102_vibration",
      label: "P-102 telemetry replay",
      connectorType: inline.connectorType,
      connectorVersion: inline.connectorVersion,
      outputSchema,
      config: {},
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: {
        data: {
          labels: ["10:00", "10:05", "10:10", "10:15", "10:20", "10:25"],
          series: [{ id: "vibration", label: "Vibration mm/s", values: [1.8, 2.0, 2.1, 2.4, 2.2, 2.6], color: "#68D5FF" }],
        },
        contentHash: "realityops-replay-v1",
        retrievedAt: "1970-01-01T00:00:00.000Z",
        stale: false,
        provenance: [],
      },
      status: "ready",
    };
    await captureStagedMotion(cdp, "immersive-build-frames", [async () => {
      await submit(build, [{
        op: "create_component", op_id: "create_pump_skid", id: pumpId, label: "Pump skid P-101 · source",
        component_type: buildAssemblyRef,
        props: { description: "Parametric seven-part centrifugal pump skid", collisionPolicy: "external_only" },
        placement: world(-4.2, 0, 1.6), transition: { durationMs: 420, easing: "ease_out" },
      }, pumpPart({
        id: baseId, label: "Skid base", geometry: { kind: "box", sizeM: { x: 2.4, y: 0.22, z: 1.4 } },
        placement: world(0, 0.11, 0), parentId: pumpId, color: "#344B5E",
      }), pumpPart({
        id: bodyId, label: "Pump body", geometry: { kind: "cylinder", radiusM: 0.42, heightM: 0.85, axis: "x" },
        placement: world(-0.35, 0.64, 0), parentId: pumpId, color: "#D66B45", metallic: 0.35,
        visibility: "collapsed",
      }), pumpPart({
        id: motorId, label: "Drive motor", geometry: { kind: "cylinder", radiusM: 0.36, heightM: 0.95, axis: "x" },
        placement: world(0.58, 0.58, 0), parentId: pumpId, color: "#4E7184", metallic: 0.55,
        visibility: "collapsed",
      }), pumpPart({
        id: inletId, label: "Suction inlet", geometry: { kind: "cylinder", radiusM: 0.16, heightM: 0.72, axis: "z" },
        placement: world(-0.35, 0.64, -0.7), parentId: pumpId, color: "#7FA8B5", metallic: 0.5,
        visibility: "collapsed",
      }), pumpPart({
        id: outletId, label: "Discharge outlet", geometry: { kind: "cylinder", radiusM: 0.14, heightM: 0.75, axis: "y" },
        placement: world(-0.35, 1.14, 0), parentId: pumpId, color: "#7FA8B5", metallic: 0.5,
        visibility: "collapsed",
      }), pumpPart({
        id: guardId, label: "Coupling guard", geometry: { kind: "box", sizeM: { x: 0.5, y: 0.5, z: 0.65 } },
        placement: world(0.12, 0.47, 0), parentId: pumpId, color: "#F1B44C", opacity: 0.92,
        visibility: "collapsed",
      }), pumpPart({
        id: statusId, label: "Pump running beacon", geometry: { kind: "sphere", radiusM: 0.11 },
        placement: world(-0.35, 1.55, 0), parentId: pumpId, color: "#73F2A7", emissiveColor: "#73F2A7", emissiveIntensity: 4,
        visibility: "hidden",
      }), {
        op: "create_component", op_id: "create_vibration_chart", id: chartId, label: "P-102 vibration telemetry",
        component_type: chartRef, props: { title: "P-102 vibration · telemetry replay", chartType: "area" },
        placement: { space: "viewport", anchor: "top_right", offset: { x: -28, y: 70 }, size: { width: 430, height: 250 } },
        transition: { durationMs: 320, easing: "ease_out" },
        visibility: "collapsed",
      }, {
        op: "create_component", op_id: "create_start_button", id: buttonId, label: "Backup pump control",
        component_type: buttonRef, props: { label: "Start backup pump", variant: "primary" },
        placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: -34 }, size: { width: 230, height: 64 } },
        transition: { durationMs: 260, easing: "ease_out" },
        visibility: "collapsed",
      }, {
        op: "upsert_resource", op_id: "upsert_p102_replay", resource: initialResource,
      }, {
        op: "bind_resource", op_id: "bind_p102_labels", binding: {
          kind: "resource_binding", id: "BIND_p102_labels", resourceId: initialResource.id,
          componentId: chartId, targetProp: "labels", sourcePath: "$.labels", mode: "snapshot",
          transform: { kind: "identity" }, enabled: true,
        },
      }, {
        op: "bind_resource", op_id: "bind_p102_series", binding: {
          kind: "resource_binding", id: "BIND_p102_series", resourceId: initialResource.id,
          componentId: chartId, targetProp: "series", sourcePath: "$.series", mode: "snapshot",
          transform: { kind: "identity" }, enabled: true,
        },
      }]);
    }, async () => {
      const coreReveal = await begin("Reveal the pump body and drive motor");
      await submit(coreReveal, [bodyId, motorId].map((id, index) => ({
        op: "update_component",
        op_id: `reveal_pump_core_${index}`,
        id,
        patch: { visibility: "visible" },
        transition: { durationMs: 520, easing: "ease_out" },
      })));
    }, async () => {
      const connectionReveal = await begin("Reveal the pump ports and coupling guard");
      await submit(connectionReveal, [inletId, outletId, guardId].map((id, index) => ({
        op: "update_component",
        op_id: `reveal_pump_connection_${index}`,
        id,
        patch: { visibility: "visible" },
        transition: { durationMs: 460, easing: "ease_out" },
      })));
    }, async () => {
      const controlReveal = await begin("Reveal the live telemetry panel and physical control");
      await submit(controlReveal, [chartId, buttonId].map((id, index) => ({
        op: "update_component",
        op_id: `reveal_pump_control_${index}`,
        id,
        patch: { visibility: "visible" },
        transition: { durationMs: 420, easing: "ease_out" },
      })));
    }]);
    const publish = await begin("Publish the completed connected pump skid as a reusable model");
    await submit(publish, [{
      op: "publish_model",
      op_id: "publish_pump_skid",
      model_id: "com.semaframe.realityops.pump-skid",
      version: "1.0.0",
      display_name: "RealityOps Pump Skid",
      root_id: pumpId,
    }]);

    const modelInspection = await callAgent(client, "inspect_workspace_model", {
      ...session,
      model_id: "com.semaframe.realityops.pump-skid",
      version: "1.0.0",
    });
    if (!modelInspection.ok) throw new Error(`Published model inspection failed: ${modelInspection.error?.code}`);
    const model = modelInspection.data.model_definition;
    const collisionQuery = await callAgent(client, "query_spatial_placement", {
      ...session,
      candidate: {
        geometry: { kind: "box", sizeM: { x: 2.4, y: 1.75, z: 1.5 } },
        placement: world(0, 0.875, 0),
        collision: { enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02 },
      },
    });
    if (!collisionQuery.ok || collisionQuery.data.placement_check?.valid !== false) {
      throw new Error("The protected-aisle collision preflight did not reject the candidate.");
    }
    let revisionBeforeRejection;
    let revisionAfterRejection;
    let rejected;
    let ghostId;
    await captureStagedMotion(cdp, "immersive-collision-frames", [async () => {
      const ghostPreparation = await begin("Visualize the unsafe candidate envelope before committing", 1);
      [ghostId] = ghostPreparation.reserved_component_ids;
      await submit(ghostPreparation, [{
        ...primitive({
          id: ghostId,
          label: "Candidate placement envelope · preview only",
          geometry: { kind: "box", sizeM: { x: 2.4, y: 1.75, z: 1.5 } },
          placement: world(0, 0.875, 0),
          color: "#F1B44C",
          opacity: 0.38,
          emissiveColor: "#F1B44C",
          emissiveIntensity: 1.2,
          collision: { enabled: false, role: "none", shape: "asset_bounds", margin: 0 },
          physics: disabledPhysics,
        }),
        component_type: componentRef(ghostPreparation.capability_manifest, "spatial-primitive"),
      }]);
    }, async () => {
      revisionBeforeRejection = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
      const badInstance = await begin("Attempt to place P-102 across the protected service aisle", model.node_count);
      const badIds = badInstance.reserved_component_ids;
      const badIdMap = Object.fromEntries(model.id_map_keys.map((nodeId, index) => [nodeId, badIds[index]]));
      rejected = await submitResult(badInstance, [{
        op: "instantiate_model",
        op_id: "instantiate_p102_unsafe",
        model: { modelId: model.model_id, version: model.version, digest: model.digest },
        id_map: badIdMap,
        root_placement: world(0, 0, 0),
      }]);
      if (rejected.ok || rejected.error?.code !== "spatial_collision") {
        throw new Error(`Unsafe model instance was not rejected atomically: ${rejected.error?.code ?? "unexpected_success"}`);
      }
      revisionAfterRejection = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
      if (revisionAfterRejection !== revisionBeforeRejection) throw new Error("Rejected placement changed the Workspace revision.");
      const rejectFeedback = await begin("Mark the atomically rejected placement in the scene");
      await submit(rejectFeedback, [{
        op: "update_component",
        op_id: "mark_rejected_candidate",
        id: ghostId,
        patch: {
          label: "Rejected candidate envelope · preview only",
          props: { material: material("#FF6B7D", {
            opacity: 0.48,
            metallic: 0.05,
            roughness: 0.42,
            emissiveColor: "#FF355E",
            emissiveIntensity: 2.6,
          }) },
        },
        transition: { durationMs: 380, easing: "ease_out" },
      }]);
    }]);
    await exitImmersive(cdp);
    await capture(cdp, "04-collision-preflight.png");
    await enterImmersive(cdp);

    let instanceIds;
    let instanceIdMap;
    await captureStagedMotion(cdp, "immersive-correction-frames", [async () => {
      const removeGhost = await begin("Collapse the rejected preview envelope");
      await submit(removeGhost, [{
        op: "update_component", op_id: "collapse_rejected_preview", id: ghostId,
        patch: { visibility: "collapsed" }, transition: { durationMs: 260, easing: "ease_out" },
      }]);
    }, async () => {
      const corrected = await begin("Place the backup pump beside the aisle and connect its control", model.node_count);
      instanceIds = corrected.reserved_component_ids;
      instanceIdMap = Object.fromEntries(model.id_map_keys.map((nodeId, index) => [nodeId, instanceIds[index]]));
      await submit(corrected, [{
        op: "instantiate_model",
        op_id: "instantiate_p102_corrected",
        model: { modelId: model.model_id, version: model.version, digest: model.digest },
        id_map: instanceIdMap,
        root_placement: world(3.3, 0, 1.6),
      }, {
        op: "connect_event", op_id: "connect_start_to_beacon", connection: {
          kind: "event_connection", id: "EVENT_start_p102", sourceComponentId: buttonId,
          event: "pressed", targetComponentId: instanceIdMap[statusId], action: "toggle_visibility",
          input: {}, enabled: true, transition: { durationMs: 260, easing: "ease_out" },
        },
      }]);
    }]);
    await exitImmersive(cdp);
    await capture(cdp, "05-corrected.png");
    await enterImmersive(cdp);

    const replayResource = {
      ...initialResource,
      snapshot: {
        ...initialResource.snapshot,
        data: {
          labels: ["10:10", "10:15", "10:20", "10:25", "10:30", "10:35"],
          series: [{ id: "vibration", label: "Vibration mm/s", values: [2.1, 2.4, 2.2, 2.6, 3.1, 2.7], color: "#68D5FF" }],
        },
        contentHash: "realityops-replay-v2",
        retrievedAt: "1970-01-01T00:00:10.000Z",
      },
    };
    await captureStagedMotion(cdp, "immersive-control-frames", [async () => {
      const updateReplay = await begin("Advance the deterministic P-102 telemetry replay");
      await submit(updateReplay, [{ op: "upsert_resource", op_id: "advance_p102_replay", resource: replayResource }]);
    }, async () => {
      const buttonRect = await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll('.workspace-button')]
          .find((candidate) => candidate.textContent?.includes('Start backup pump'));
        if (!(button instanceof HTMLButtonElement) || button.disabled) return undefined;
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (!buttonRect) throw new Error("The rendered backup-pump control was unavailable.");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: buttonRect.x, y: buttonRect.y });
      await delay(120);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: buttonRect.x, y: buttonRect.y, button: "left", buttons: 1, clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: buttonRect.x, y: buttonRect.y, button: "left", buttons: 0, clickCount: 1,
      });
      await delay(260);
    }]);
    await exitImmersive(cdp);
    await clearCanvasSelection(cdp);
    await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled control action notice", 12_000);
    await capture(cdp, "06-control-running.png");
    await enterImmersive(cdp);

    const space = await callAgent(client, "inspect_workspace_space", session);
    const physics = await callAgent(client, "inspect_workspace_physics", session);
    if (!space.ok || !physics.ok) throw new Error("Spatial or physics evidence collection failed.");
    if (space.data.spatial_graph.collision_conflicts?.length) throw new Error("Corrected workspace still contains collision conflicts.");
    if (physics.data.physics_validation.feasible !== true) throw new Error("Corrected workspace did not pass bounded physics preflight.");

    let undoEvidence;
    let redoEvidence;
    await captureStagedMotion(cdp, "immersive-undo-redo-frames", [async () => {
      const beforeUndo = await callAgent(client, "inspect_workspace", session);
      const undo = await callAgent(client, "undo_workspace_batch", {
        ...session,
        expected_workspace_revision: beforeUndo.data.workspace_summary.revision,
      });
      if (!undo.ok || !undo.data.changed) throw new Error(`Undo failed: ${undo.error?.code ?? "unchanged"}`);
      undoEvidence = undo.data;
    }, async () => {
      const redo = await callAgent(client, "redo_workspace_batch", {
        ...session,
        expected_workspace_revision: undoEvidence.workspace_revision,
      });
      if (!redo.ok || !redo.data.changed) throw new Error(`Redo failed: ${redo.error?.code ?? "unchanged"}`);
      redoEvidence = redo.data;
    }]);
    await exitImmersive(cdp);
    await poll(cdp, "Boolean(document.querySelector('.agent-workspace-controls.status-connected'))", "connected controls before history");
    if (!await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.agent-workspace-controls button')]
        .find((candidate) => candidate.textContent?.replace(/\\s+/g, ' ').trim().includes('History') && !candidate.disabled);
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`)) throw new Error("History drawer was unavailable.");
    await poll(cdp, "Boolean(document.querySelector('.agent-history-drawer'))", "RealityOps history drawer");
    await delay(250);
    await capture(cdp, "07-history.png");
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.agent-workspace-controls button')]
        .find((candidate) => candidate.textContent?.replace(/\\s+/g, ' ').trim().includes('History') && !candidate.disabled);
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await poll(cdp, "!document.querySelector('.agent-history-drawer')", "closed RealityOps history drawer");

    const beforeSave = await callAgent(client, "inspect_workspace", session);
    const savedProjectText = await captureWorkspaceProject(cdp, "realityops-pump-room");
    const savedProject = JSON.parse(savedProjectText);
    writeFileSync(join(artifactRoot, "realityops-pump-room.semaframe.json"), `${savedProjectText.trim()}\n`);
    await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled save notice", 12_000);

    const injected = await cdp.evaluate(`(() => {
      const input = document.querySelector('input[type="file"][accept*="semaframe"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(savedProjectText)}], 'realityops-pump-room.semaframe.json', { type: 'application/json' }));
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!injected) throw new Error("The saved RealityOps project could not be supplied to Open.");
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "reopened-project Agent gate", 20_000);
    await client.close().catch(() => undefined);
    authorization = await authorizeWorkspace(cdp, "RealityOps Reopen Verification Agent");
    clients.push(authorization.client);
    ({ client, session } = authorization);
    const reopened = await callAgent(client, "inspect_workspace", session);
    if (!reopened.ok) throw new Error(`Reopened Workspace inspection failed: ${reopened.error?.code}`);
    const reopenedSummary = reopened.data.workspace_summary;
    const beforeSaveSummary = beforeSave.data.workspace_summary;
    if (reopenedSummary.revision !== beforeSaveSummary.revision
      || reopenedSummary.component_count !== beforeSaveSummary.component_count
      || reopenedSummary.model_definition_count !== beforeSaveSummary.model_definition_count
      || reopenedSummary.resource_count !== beforeSaveSummary.resource_count
      || reopenedSummary.connection_count !== beforeSaveSummary.connection_count) {
      throw new Error(`Reopened Workspace did not preserve the saved summary: ${JSON.stringify({ beforeSaveSummary, reopenedSummary })}`);
    }
    // Project state is available to the Agent before the renderer has necessarily
    // rebuilt every mesh. Give React Three Fiber a stable frame before framing it.
    await delay(1_200);
    await frameAll(cdp);
    await delay(400);
    await zoomScene(cdp, 4);
    await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled reopen notices", 12_000);
    await capture(cdp, "08-reopened.png");

    await installArtifactCapture(cdp);
    if (!await cdp.evaluate(clickExactButton("Models"))) throw new Error("Models panel was unavailable.");
    await poll(cdp, "Boolean(document.querySelector('.workspace-models'))", "RealityOps Models panel");
    await cdp.evaluate(`(() => {
      const card = document.querySelector('.workspace-model-card');
      card?.scrollIntoView({ block: 'center', inline: 'nearest' });
      return Boolean(card);
    })()`);
    await delay(300);
    if (!await cdp.evaluate(clickExactButton("USDA"))) throw new Error("USDA export was unavailable.");
    const usda = await capturedArtifact(cdp, ".usda", 20_000);
    if (!await cdp.evaluate(clickExactButton("STEP"))) throw new Error("STEP export was unavailable.");
    const step = await capturedArtifact(cdp, ".step", 180_000);
    if (typeof usda?.contents !== "string" || !usda.contents.startsWith("#usda 1.0")
      || !usda.contents.includes("metersPerUnit = 1") || !usda.contents.includes('upAxis = "Y"')) {
      throw new Error("USDA export did not satisfy the deterministic OpenUSD contract.");
    }
    if (typeof step?.contents !== "string" || !step.contents.startsWith("ISO-10303-21;")
      || !step.contents.includes("END-ISO-10303-21;")) {
      throw new Error("STEP export did not produce a complete Part 21 artifact.");
    }
    writeFileSync(join(artifactRoot, usda.name), usda.contents);
    writeFileSync(join(artifactRoot, step.name), step.contents);
    await cdp.evaluate(`document.querySelector('.workspace-model-card')?.scrollIntoView({ block: 'center', inline: 'nearest' })`);
    await delay(250);
    await capture(cdp, "09-model-exports.png");
    await cdp.evaluate(clickExactButton("Models"));
    await poll(cdp, "!document.querySelector('.workspace-models')", "closed RealityOps Models panel");
    await frameAll(cdp);
    await zoomScene(cdp, 4);
    await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled export notices", 12_000);
    await capture(cdp, "10-final.png");
    await enterImmersive(cdp);
    await frameAll(cdp);
    await zoomScene(cdp, 4);
    await captureOrbitMotion(cdp, "immersive-final-frames");

    const legacySequenceFolders = ["build-frames", "correction-frames", "control-frames", "undo-redo-frames"];
    const legacyFrameCounts = Object.fromEntries(legacySequenceFolders.map((folder) => [folder, frameCountFor(folder)]));
    const legacyUniqueCounts = [...new Set(Object.values(legacyFrameCounts))];
    const immersiveFrameCounts = Object.fromEntries(IMMERSIVE_SEQUENCE_FOLDERS.map((folder) => [folder, frameCountFor(folder)]));
    for (const [folder, count] of Object.entries(immersiveFrameCounts)) {
      if (count !== FRAME_COUNT) throw new Error(`${folder} evidence found ${count}/${FRAME_COUNT} frames.`);
    }

    const collisionCheck = collisionQuery.data.placement_check;
    const physicsReport = physics.data.physics_validation;
    const spatialGraph = space.data.spatial_graph;
    const evidence = {
      format: "semaframe-realityops-demo-evidence",
      version: 1,
      syntheticBaseline: true,
      sourcePhotosOrScansUsed: false,
      claimBoundary: {
        telemetry: "deterministic inline snapshot replay",
        physics: "bounded quasi-static preflight, not certification",
        exports: "published pump model only",
      },
      collisionPreflight: {
        valid: collisionCheck.valid,
        candidateId: collisionCheck.candidate_id,
        conflicts: collisionCheck.conflicts,
        suggestedPlacements: (collisionCheck.suggested_placements ?? []).slice(0, 2),
        rejectedBatchCode: rejected.error.code,
        revisionBeforeRejection,
        revisionAfterRejection,
        atomic: revisionBeforeRejection === revisionAfterRejection,
      },
      correctedWorkspace: {
        revision: spatialGraph.workspace_revision ?? space.data.workspace_revision,
        ssgFormat: spatialGraph.format,
        ssgVersion: spatialGraph.version,
        collisionConflictCount: spatialGraph.collision_conflicts?.length ?? 0,
        physicsVersion: physicsReport.version,
        physicsModel: physicsReport.model,
        physicsFeasible: physicsReport.feasible,
        physicsIssueCodes: physicsReport.issues.map((issue) => issue.code),
      },
      model: {
        modelId: model.model_id,
        version: model.version,
        digest: model.digest,
        nodeCount: model.node_count,
        sourceRootId: pumpId,
        instanceRootId: instanceIdMap[model.root_node_id],
        editableSourceAndInstance: true,
      },
      dataAndAction: {
        resourceId: initialResource.id,
        resourceMode: initialResource.policy.mode,
        bindingIds: ["BIND_p102_labels", "BIND_p102_series"],
        eventConnectionId: "EVENT_start_p102",
        action: "button.pressed -> beacon.toggle_visibility",
      },
      persistence: {
        projectSha256: sha256(savedProjectText),
        savedRevision: savedProject.workspace?.revision,
        reopenedRevision: reopenedSummary.revision,
        savedComponentCount: beforeSaveSummary.component_count,
        reopenedComponentCount: reopenedSummary.component_count,
        preserved: true,
      },
      exports: {
        usda: { filename: usda.name, byteLength: usda.byteLength, sha256: sha256(usda.contents), valid: true },
        step: { filename: step.name, byteLength: step.byteLength, sha256: sha256(step.contents), valid: true },
      },
      captures: {
        viewport: { width: 1600, height: 900 },
        frameCountPerSequence: legacyUniqueCounts.length === 1 ? legacyUniqueCounts[0] : null,
        sequences: legacySequenceFolders,
        frameCounts: legacyFrameCounts,
        immersive: {
          fullscreen: true,
          frameCountPerSequence: FRAME_COUNT,
          sequences: IMMERSIVE_SEQUENCE_FOLDERS,
          frameCounts: immersiveFrameCounts,
          stagedVisibleStateCounts: {
            "immersive-room-frames": 5,
            "immersive-build-frames": 5,
            "immersive-collision-frames": 3,
            "immersive-correction-frames": 3,
            "immersive-control-frames": 3,
            "immersive-undo-redo-frames": 3,
          },
          finalOrbitFrameCount: immersiveFrameCounts["immersive-final-frames"],
        },
      },
    };
    writeFileSync(join(publicRoot, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`RealityOps capture complete: ${publicRoot}`);
  } catch (error) {
    const tail = logs.join("").slice(-5_000);
    if (tail.trim()) console.error(tail);
    throw error;
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    cdp?.close();
    stack.kill("SIGTERM");
    browser.kill("SIGTERM");
    await delay(350);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (import.meta.url === new URL(`file://${resolve(process.argv[1] ?? "")}`).href) {
  await captureRealityOpsDemoAssets();
}
