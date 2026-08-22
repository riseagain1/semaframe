import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const outputRoot = resolve("video/public/living-room");
const frameFolders = [
  "room-frames",
  "build-frames",
  "collision-frames",
  "correction-frames",
  "cinema-control-frames",
  "undo-redo-frames",
  "final-orbit-frames",
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
    } catch { /* the local stack is still starting */ }
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
  mkdirSync(outputRoot, { recursive: true });
  for (const folder of frameFolders) {
    rmSync(join(outputRoot, folder), { recursive: true, force: true });
    mkdirSync(join(outputRoot, folder), { recursive: true });
  }
}

async function screenshot(cdp, format = "jpeg") {
  const result = await cdp.send("Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality: 90 } : {}),
    fromSurface: true,
    captureBeyondViewport: false,
  });
  return Buffer.from(result.data, "base64");
}

async function captureFrames(cdp, folder, options = {}) {
  const frameCount = options.frameCount ?? 48;
  const frameDelayMs = options.frameDelayMs ?? 80;
  const directory = join(outputRoot, folder);
  for (let index = 0; index < frameCount; index += 1) {
    if (options.beforeFrame) await options.beforeFrame(index, frameCount);
    writeFileSync(
      join(directory, `frame-${String(index).padStart(4, "0")}.jpg`),
      await screenshot(cdp),
    );
    await delay(frameDelayMs);
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
  await cdp.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur(); true");
  await delay(280);
}

async function frameAll(cdp) {
  if (!await cdp.evaluate(clickButtonWithAriaLabel("Frame all"))) {
    throw new Error("The Workspace Frame all control was unavailable.");
  }
  await delay(850);
}

async function zoomScene(cdp, repetitions = 5) {
  for (let index = 0; index < repetitions; index += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 800,
      y: 450,
      deltaX: 0,
      deltaY: -420,
    });
    await delay(110);
  }
  await delay(320);
}

async function captureOrbit(cdp, folder) {
  const rect = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  })()`);
  if (!rect) throw new Error("The 3D canvas was unavailable for the final orbit.");
  const startX = rect.left + rect.width * 0.56;
  const startY = rect.top + rect.height * 0.5;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startX, y: startY });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", clickCount: 1 });
  try {
    await captureFrames(cdp, folder, {
      beforeFrame: async (index, count) => {
        const progress = index / Math.max(1, count - 1);
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: startX + progress * Math.min(120, rect.width * 0.1),
          y: startY + Math.sin(progress * Math.PI) * 24,
          button: "left",
          buttons: 1,
        });
      },
    });
  } finally {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: startX + Math.min(120, rect.width * 0.1),
      y: startY,
      button: "left",
      clickCount: 1,
    });
  }
}

function world(x, y, z, rotation = { x: 0, y: 0, z: 0 }) {
  return {
    space: "world3d",
    position: { x, y, z },
    rotation,
    scale: { x: 1, y: 1, z: 1 },
  };
}

function material(baseColor, opacity = 1, options = {}) {
  return {
    baseColor,
    metallic: options.metallic ?? 0.08,
    roughness: options.roughness ?? 0.72,
    opacity,
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

const enabledPhysics = Object.freeze({
  enabled: true,
  bodyType: "static",
  massKg: 1,
  centerOfMass: { x: 0, y: 0, z: 0 },
  friction: 0.6,
  restitution: 0.1,
  gravityScale: 1,
  stabilityMode: "report",
  constraints: [],
});

async function connectAgent(cdp, label, requestedScopes) {
  if (await cdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-disabled'))")) {
    if (!await cdp.evaluate(clickExactButton("Enable agent control"))) {
      throw new Error(`${label} could not enable Agent control.`);
    }
  }
  await poll(
    cdp,
    "Boolean(document.querySelector('.agent-connection-page.status-waiting .agent-connection-url-wrap input'))",
    `${label} connection URL`,
  );
  const connectionUrl = await cdp.evaluate("document.querySelector('.agent-connection-url-wrap input')?.value");
  if (typeof connectionUrl !== "string" || !connectionUrl.startsWith("http://127.0.0.1:")) {
    throw new Error(`${label} did not receive a loopback connection URL.`);
  }
  const client = new Client({ name: label, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connectionUrl)));
  const identity = {
    client_id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    client_name: label,
    ...(requestedScopes ? { requested_scopes: requestedScopes } : {}),
  };
  const pending = await callAgent(client, "get_workspace_instructions", identity);
  const approvalToken = pending.error?.details?.approval_token;
  if (pending.ok !== false || pending.error?.code !== "approval_pending" || typeof approvalToken !== "string") {
    throw new Error(`${label} did not enter explicit approval.`);
  }
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-approval'))", `${label} approval card`);
  if (!await cdp.evaluate(clickExactButton("Approve client"))) throw new Error(`${label} could not be approved.`);
  await poll(cdp, "!document.querySelector('.agent-connection-page.status-approval')", `${label} approval handoff`);
  const instructions = await callAgent(client, "get_workspace_instructions", {
    ...identity,
    approval_token: approvalToken,
  });
  if (!instructions.ok || typeof instructions.data?.session_token !== "string") {
    throw new Error(`${label} handshake failed: ${instructions.error?.code ?? "invalid_response"}`);
  }
  await poll(cdp, "Boolean(document.querySelector('.agent-workspace-controls.status-connected'))", `${label} Workspace`);
  return {
    client,
    session: {
      session_token: instructions.data.session_token,
      instruction_digest: instructions.data.guide_digest,
    },
  };
}

function componentRef(capability, typeId) {
  const entry = capability.component_types.find((candidate) => candidate.typeId === typeId);
  if (!entry) throw new Error(`The Workspace did not advertise ${typeId}.`);
  return { typeId: entry.typeId, version: entry.version, digest: entry.digest };
}

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
    tags: options.tags ?? ["living-room", "assembly"],
  };
}

function primitiveOperation(id, label, geometry, placement, ref, options = {}) {
  const props = {
    geometry,
    ...(options.material ? { material: options.material } : {}),
    ...(options.collision ? { collision: options.collision } : {}),
    ...(options.physics ? { physics: options.physics } : {}),
  };
  return {
    op: "create_component",
    op_id: `create_${options.key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    id,
    component_type: ref,
    label,
    props,
    placement,
    ...(options.parentId ? { parent_id: options.parentId } : {}),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(options.transition ? { transition: options.transition } : {}),
    tags: options.tags ?? ["living-room", "parametric"],
  };
}

export async function captureLivingRoomDemo() {
  prepareOutput();
  const gatewayPort = await freePort();
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const appUrl = `http://127.0.0.1:${vitePort}/`;
  const profile = mkdtempSync(join(tmpdir(), "semaframe-living-room-"));
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
    const target = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(appUrl)}`,
      { method: "PUT" },
    ).then((response) => response.json());
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
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "Agent connection gate");
    const connected = await connectAgent(cdp, "Living Room Demo Agent");
    client = connected.client;
    const session = connected.session;
    const inspect = await callAgent(client, "inspect_workspace", session);
    if (!inspect.ok || inspect.data?.workspace_summary?.component_count !== 0) {
      throw new Error("The living-room capture did not start from an empty Workspace.");
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
    const submit = async (prepared, operations) => {
      const result = await callAgent(client, "submit_workspace_batch", {
        ...session,
        transaction_token: prepared.transaction_token,
        batch: { ...prepared.envelope, operations },
      });
      if (!result.ok) throw new Error(`Workspace update failed: ${result.error?.code} ${result.error?.message ?? ""}`);
      return result.data;
    };

    await enterImmersive(cdp);
    const roomFrames = captureFrames(cdp, "room-frames");
    await delay(160);
    const stagePreparation = await begin("Create a warm 14 metre living-room stage", 1);
    const stageId = stagePreparation.reserved_component_ids[0];
    await submit(stagePreparation, [{
      op: "create_component",
      op_id: "create_living_room_stage",
      id: stageId,
      component_type: componentRef(stagePreparation.capability_manifest, "stage-3d"),
      label: "Warm living room",
      props: {
        environmentPreset: "simple_room",
        dimensions: { width: 14, height: 5, depth: 10 },
        background: "#15110F",
        gridVisible: true,
      },
      placement: world(0, 0, 0),
      transition: { durationMs: 500, easing: "ease_out" },
    }]);

    const roomPreparation = await begin("Build the warm room shell, real door, and protected doorway", 7);
    const [roomId, backId, leftId, rightId, rugId, doorId, doorZoneId] = roomPreparation.reserved_component_ids;
    const roomCapability = roomPreparation.capability_manifest;
    const assemblyRef = componentRef(roomCapability, "model-assembly");
    const primitiveRef = componentRef(roomCapability, "spatial-primitive");
    const roomSpatialRef = componentRef(roomCapability, "spatial-entity");
    const warmWall = material("#D9CBBF", 1, { roughness: 0.88 });
    await submit(roomPreparation, [
      assemblyOperation(roomId, "Living room shell", world(0, 0, 0), assemblyRef),
      primitiveOperation(backId, "Warm back wall", { kind: "box", sizeM: { x: 13.5, y: 4.5, z: 0.16 } }, world(0, 2.25, -4.75), primitiveRef, { parentId: roomId, material: warmWall }),
      primitiveOperation(leftId, "Left wall", { kind: "box", sizeM: { x: 0.16, y: 4.5, z: 9.5 } }, world(-6.75, 2.25, 0), primitiveRef, { parentId: roomId, material: warmWall }),
      primitiveOperation(rightId, "Right wall", { kind: "box", sizeM: { x: 0.16, y: 4.5, z: 9.5 } }, world(6.75, 2.25, 0), primitiveRef, { parentId: roomId, material: warmWall }),
      primitiveOperation(rugId, "Woven living-room rug", { kind: "plane", sizeM: { x: 5.4, y: 3.2 }, normalAxis: "y" }, world(0, 0.01, 0.55), primitiveRef, {
        material: material("#A86F55", 0.92, { roughness: 0.96 }),
        collision: { enabled: false, role: "none", shape: "asset_bounds", margin: 0 },
        physics: disabledPhysics,
      }),
      {
        op: "create_component",
        op_id: "create_open_living_room_door",
        id: doorId,
        component_type: roomSpatialRef,
        label: "Open warm-wood entrance door",
        props: {
          assetId: "door_interior_01",
          entityKind: "structure",
          appearance: { color: "#8B5E3C", variant: "wood" },
          state: { open: true },
          collision: { enabled: false, role: "none", shape: "asset_bounds", margin: 0 },
          physics: disabledPhysics,
        },
        placement: world(-6.55, 0, 2.7, { x: 0, y: Math.PI / 2, z: 0 }),
        transition: { durationMs: 520, easing: "ease_out" },
        tags: ["living-room", "entrance", "open-door"],
      },
      primitiveOperation(doorZoneId, "Visible doorway safety channel", { kind: "box", sizeM: { x: 2.2, y: 1.5, z: 3.4 } }, world(-4.3, 0.75, 2.7), primitiveRef, {
        material: material("#35D07F", 0.34, { roughness: 0.72, emissiveColor: "#2ED67B", emissiveIntensity: 0.82 }),
        collision: { enabled: true, role: "solid", shape: "asset_bounds", margin: 0 },
        physics: disabledPhysics,
        tags: ["living-room", "door-clearance", "must-stay-clear"],
      }),
    ]);
    await roomFrames;

    const buildPreparation = await begin("Furnish the living room and wire one cinema-mode control", 30);
    const [
      tvId, consoleId, tvFrameId, movieId, tvScreenId, movieSunId, movieMountainLeftId, movieMountainRightId,
      lampId, lampBaseId, lampStemId, lampShadeId, lampGlowId,
      ambientLeftId, ambientRightId,
      deskId, deskTopId, deskLeftId, deskRightId, chairId, monitorFrameId, monitorScreenId, monitorStandId,
      coffeeId, coffeeTopId, coffeeLeg1Id, coffeeLeg2Id, coffeeLeg3Id, coffeeLeg4Id,
      buttonId,
    ] = buildPreparation.reserved_component_ids;
    const buildCapability = buildPreparation.capability_manifest;
    const buildAssemblyRef = componentRef(buildCapability, "model-assembly");
    const buildPrimitiveRef = componentRef(buildCapability, "spatial-primitive");
    const spatialRef = componentRef(buildCapability, "spatial-entity");
    const buttonRef = componentRef(buildCapability, "button");
    const reveal = { durationMs: 680, delayMs: 0, easing: "ease_out" };
    const noCollision = { enabled: false, role: "none", shape: "asset_bounds", margin: 0 };
    const buildFrames = captureFrames(cdp, "build-frames");
    await delay(140);
    await submit(buildPreparation, [
      assemblyOperation(tvId, "Cinema wall", world(0, 0, 0), buildAssemblyRef, { transition: reveal }),
      primitiveOperation(consoleId, "Oak media console", { kind: "box", sizeM: { x: 3.8, y: 0.55, z: 0.62 } }, world(0, 0.275, -3.9), buildPrimitiveRef, {
        parentId: tvId,
        material: material("#8B5E3C", 1, { roughness: 0.68 }),
        transition: reveal,
      }),
      primitiveOperation(tvFrameId, "Television frame", { kind: "box", sizeM: { x: 3.75, y: 2.1, z: 0.12 } }, world(0, 1.78, -4.25), buildPrimitiveRef, {
        parentId: tvId,
        material: material("#171A1E", 1, { metallic: 0.62, roughness: 0.24 }),
        transition: reveal,
      }),
      assemblyOperation(movieId, "Hidden cinema landscape", world(0, 0, 0), buildAssemblyRef, {
        parentId: tvId,
        visibility: "hidden",
        transition: reveal,
        tags: ["living-room", "cinema-mode", "controlled-content"],
      }),
      primitiveOperation(tvScreenId, "Cinema blue-sky screen", { kind: "box", sizeM: { x: 3.46, y: 1.82, z: 0.05 } }, world(0, 1.78, -4.15), buildPrimitiveRef, {
        parentId: movieId,
        material: material("#65BEE8", 1, { metallic: 0.02, roughness: 0.22, emissiveColor: "#4BAEE0", emissiveIntensity: 2.1 }),
        collision: noCollision,
        physics: disabledPhysics,
        transition: reveal,
        tags: ["living-room", "cinema-mode", "movie-content"],
      }),
      primitiveOperation(movieSunId, "Cinema landscape sun", { kind: "sphere", radiusM: 0.24 }, world(1.08, 2.28, -4.08), buildPrimitiveRef, {
        parentId: movieId,
        material: material("#FFD76A", 1, { roughness: 0.18, emissiveColor: "#FFC84A", emissiveIntensity: 3.8 }),
        collision: noCollision,
        physics: disabledPhysics,
        transition: reveal,
        tags: ["living-room", "cinema-mode", "movie-content"],
      }),
      primitiveOperation(movieMountainLeftId, "Cinema landscape left mountain", { kind: "cone", radiusM: 0.82, heightM: 1.2, axis: "y" }, world(-0.78, 1.26, -4.06), buildPrimitiveRef, {
        parentId: movieId,
        material: material("#315E55", 1, { roughness: 0.84, emissiveColor: "#244F49", emissiveIntensity: 0.55 }),
        collision: noCollision,
        physics: disabledPhysics,
        transition: reveal,
        tags: ["living-room", "cinema-mode", "movie-content"],
      }),
      primitiveOperation(movieMountainRightId, "Cinema landscape right mountain", { kind: "cone", radiusM: 0.7, heightM: 0.96, axis: "y" }, world(0.42, 1.18, -4.05), buildPrimitiveRef, {
        parentId: movieId,
        material: material("#3F7565", 1, { roughness: 0.84, emissiveColor: "#315E55", emissiveIntensity: 0.55 }),
        collision: noCollision,
        physics: disabledPhysics,
        transition: reveal,
        tags: ["living-room", "cinema-mode", "movie-content"],
      }),

      assemblyOperation(lampId, "Reading floor lamp", world(0, 0, 0), buildAssemblyRef, { transition: reveal }),
      primitiveOperation(lampBaseId, "Lamp base", { kind: "cylinder", radiusM: 0.34, heightM: 0.09, axis: "y" }, world(4.5, 0.045, -2.35), buildPrimitiveRef, {
        parentId: lampId,
        material: material("#34383E", 1, { metallic: 0.72, roughness: 0.3 }),
        transition: reveal,
      }),
      primitiveOperation(lampStemId, "Lamp stem", { kind: "cylinder", radiusM: 0.045, heightM: 2.05, axis: "y" }, world(4.5, 1.07, -2.35), buildPrimitiveRef, {
        parentId: lampId,
        material: material("#5F646B", 1, { metallic: 0.8, roughness: 0.25 }),
        transition: reveal,
      }),
      primitiveOperation(lampShadeId, "Linen lamp shade", { kind: "cylinder", radiusM: 0.38, heightM: 0.46, axis: "y" }, world(4.5, 2.13, -2.35), buildPrimitiveRef, {
        parentId: lampId,
        material: material("#E8D7B9", 0.92, { roughness: 0.95 }),
        transition: reveal,
      }),
      primitiveOperation(lampGlowId, "Floor lamp warm glow", { kind: "sphere", radiusM: 0.24 }, world(4.5, 2.08, -2.35), buildPrimitiveRef, {
        parentId: lampId,
        material: material("#FFD287", 0.82, { roughness: 0.2, emissiveColor: "#FFB75E", emissiveIntensity: 4.8 }),
        visibility: "hidden",
        transition: reveal,
        tags: ["living-room", "cinema-mode", "controlled-light"],
      }),

      primitiveOperation(ambientLeftId, "Left ambient wall light", { kind: "box", sizeM: { x: 2.4, y: 0.08, z: 0.04 } }, world(-3.4, 3.72, -4.61), buildPrimitiveRef, {
        material: material("#FF9862", 0.92, { roughness: 0.22, emissiveColor: "#FF7A45", emissiveIntensity: 4.2 }),
        collision: noCollision,
        physics: disabledPhysics,
        visibility: "hidden",
        transition: reveal,
        tags: ["living-room", "cinema-mode", "controlled-light"],
      }),
      primitiveOperation(ambientRightId, "Right ambient wall light", { kind: "box", sizeM: { x: 2.4, y: 0.08, z: 0.04 } }, world(3.4, 3.72, -4.61), buildPrimitiveRef, {
        material: material("#FF9862", 0.92, { roughness: 0.22, emissiveColor: "#FF7A45", emissiveIntensity: 4.2 }),
        collision: noCollision,
        physics: disabledPhysics,
        visibility: "hidden",
        transition: reveal,
        tags: ["living-room", "cinema-mode", "controlled-light"],
      }),

      assemblyOperation(deskId, "Compact home office", world(-3.9, 0, -2.55), buildAssemblyRef, { transition: reveal }),
      primitiveOperation(deskTopId, "Home office desk top", { kind: "box", sizeM: { x: 2.15, y: 0.12, z: 0.82 } }, world(0, 0.82, 0), buildPrimitiveRef, {
        parentId: deskId,
        material: material("#9B6A45", 1, { roughness: 0.7 }),
        transition: reveal,
      }),
      primitiveOperation(deskLeftId, "Desk left support", { kind: "box", sizeM: { x: 0.12, y: 0.78, z: 0.7 } }, world(-0.91, 0.39, 0), buildPrimitiveRef, {
        parentId: deskId,
        material: material("#4D5055", 1, { metallic: 0.6, roughness: 0.35 }),
        transition: reveal,
      }),
      primitiveOperation(deskRightId, "Desk right support", { kind: "box", sizeM: { x: 0.12, y: 0.78, z: 0.7 } }, world(0.91, 0.39, 0), buildPrimitiveRef, {
        parentId: deskId,
        material: material("#4D5055", 1, { metallic: 0.6, roughness: 0.35 }),
        transition: reveal,
      }),
      {
        op: "create_component",
        op_id: "create_home_office_chair",
        id: chairId,
        component_type: spatialRef,
        label: "Home office chair",
        props: { assetId: "chair_wood_simple_01", entityKind: "prop" },
        placement: world(-3.9, 0, -1.15),
        transition: reveal,
        tags: ["living-room", "home-office"],
      },
      primitiveOperation(monitorFrameId, "Home-office monitor frame", { kind: "box", sizeM: { x: 0.94, y: 0.62, z: 0.08 } }, world(0, 1.27, -0.16), buildPrimitiveRef, {
        parentId: deskId,
        material: material("#171A1E", 1, { metallic: 0.48, roughness: 0.28 }),
        collision: noCollision,
        physics: disabledPhysics,
        transition: reveal,
        tags: ["living-room", "home-office", "monitor"],
      }),
      primitiveOperation(monitorScreenId, "Home-office active screen", { kind: "box", sizeM: { x: 0.82, y: 0.5, z: 0.035 } }, world(0, 1.27, -0.1), buildPrimitiveRef, {
        parentId: deskId,
        material: material("#62E7C8", 1, { roughness: 0.2, emissiveColor: "#42DDBA", emissiveIntensity: 2.8 }),
        collision: noCollision,
        physics: disabledPhysics,
        transition: reveal,
        tags: ["living-room", "home-office", "controlled-screen"],
      }),
      primitiveOperation(monitorStandId, "Home-office monitor stand", { kind: "box", sizeM: { x: 0.08, y: 0.35, z: 0.08 } }, world(0, 0.99, -0.16), buildPrimitiveRef, {
        parentId: deskId,
        material: material("#3E444A", 1, { metallic: 0.62, roughness: 0.3 }),
        collision: noCollision,
        physics: disabledPhysics,
        transition: reveal,
        tags: ["living-room", "home-office", "monitor"],
      }),

      assemblyOperation(coffeeId, "Coffee table", world(0, 0, 0.2), buildAssemblyRef, { transition: reveal }),
      primitiveOperation(coffeeTopId, "Coffee table top", { kind: "box", sizeM: { x: 2.05, y: 0.12, z: 1.02 } }, world(0, 0.52, 0), buildPrimitiveRef, {
        parentId: coffeeId,
        material: material("#A8754F", 1, { roughness: 0.66 }),
        transition: reveal,
      }),
      ...[
        [coffeeLeg1Id, -0.84, -0.34], [coffeeLeg2Id, 0.84, -0.34],
        [coffeeLeg3Id, -0.84, 0.34], [coffeeLeg4Id, 0.84, 0.34],
      ].map(([id, x, z], index) => primitiveOperation(id, `Coffee table leg ${index + 1}`, { kind: "box", sizeM: { x: 0.12, y: 0.5, z: 0.12 } }, world(x, 0.25, z), buildPrimitiveRef, {
        parentId: coffeeId,
        material: material("#4A3A31", 1, { roughness: 0.72 }),
        transition: reveal,
      })),
      {
        op: "create_component",
        op_id: "create_cinema_mode_button",
        id: buttonId,
        component_type: buttonRef,
        label: "Cinema mode control",
        props: { label: "开启观影模式", variant: "primary" },
        placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: -34 }, size: { width: 240, height: 66 } },
        transition: { durationMs: 360, easing: "ease_out" },
        tags: ["living-room", "cinema-mode", "control"],
      },
      ...[
        ["EVENT_cinema_tv", movieId],
        ["EVENT_cinema_floor_lamp", lampGlowId],
        ["EVENT_cinema_ambient_left", ambientLeftId],
        ["EVENT_cinema_ambient_right", ambientRightId],
        ["EVENT_cinema_work_screen", monitorScreenId],
      ].map(([connectionId, targetId], index) => ({
        op: "connect_event",
        op_id: `connect_cinema_light_${index + 1}`,
        connection: {
          kind: "event_connection",
          id: connectionId,
          sourceComponentId: buttonId,
          event: "pressed",
          targetComponentId: targetId,
          action: "toggle_visibility",
          input: {},
          enabled: true,
          transition: { durationMs: 720, easing: "ease_out" },
        },
      })),
    ]);
    await buildFrames;
    await frameAll(cdp);
    await zoomScene(cdp, 5);

    const solidCollision = { enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02 };
    const previewSofaFabric = material("#F3C75B", 0.9, { roughness: 0.78, emissiveColor: "#E9A936", emissiveIntensity: 0.36 });
    const previewCushionFabric = material("#FFD979", 0.92, { roughness: 0.82, emissiveColor: "#E9A936", emissiveIntensity: 0.28 });
    const finalSofaFabric = material("#6F8792", 1, { roughness: 0.93 });
    const finalCushionFabric = material("#89A0AA", 1, { roughness: 0.96 });
    const rejectedFabric = material("#E85757", 0.9, { roughness: 0.7, emissiveColor: "#D9364A", emissiveIntensity: 0.72 });
    const rejectedCushionFabric = material("#FF7B6E", 0.92, { roughness: 0.76, emissiveColor: "#D9364A", emissiveIntensity: 0.58 });
    const sofaPartSpecs = [
      { key: "base", label: "Sofa base", geometry: { kind: "box", sizeM: { x: 3.2, y: 0.45, z: 1.25 } }, placement: world(0, 0.35, 0), cushion: false },
      { key: "back", label: "Sofa back", geometry: { kind: "box", sizeM: { x: 3.2, y: 1.1, z: 0.25 } }, placement: world(0, 1.05, 0.5), cushion: false },
      { key: "left_arm", label: "Sofa left arm", geometry: { kind: "box", sizeM: { x: 0.25, y: 0.68, z: 1.2 } }, placement: world(-1.48, 0.65, 0), cushion: false },
      { key: "right_arm", label: "Sofa right arm", geometry: { kind: "box", sizeM: { x: 0.25, y: 0.68, z: 1.2 } }, placement: world(1.48, 0.65, 0), cushion: false },
      { key: "left_cushion", label: "Left sofa cushion", geometry: { kind: "box", sizeM: { x: 0.9, y: 0.18, z: 0.88 } }, placement: world(-1, 0.68, -0.08), cushion: true },
      { key: "center_cushion", label: "Center sofa cushion", geometry: { kind: "box", sizeM: { x: 0.9, y: 0.18, z: 0.88 } }, placement: world(0, 0.68, -0.08), cushion: true },
      { key: "right_cushion", label: "Right sofa cushion", geometry: { kind: "box", sizeM: { x: 0.9, y: 0.18, z: 0.88 } }, placement: world(1, 0.68, -0.08), cushion: true },
    ];
    const sofaOperations = ({ prepared, ids, rootPlacement, prefix, fabric, cushionFabric, collision, physics }) => {
      const [rootId, ...partIds] = ids;
      const sofaAssemblyRef = componentRef(prepared.capability_manifest, "model-assembly");
      const sofaPrimitiveRef = componentRef(prepared.capability_manifest, "spatial-primitive");
      return [
        assemblyOperation(rootId, "Modular family sofa", rootPlacement, sofaAssemblyRef, {
          key: `${prefix}_root`,
          description: "Editable eight-node sofa assembled from exact metric primitives.",
          transition: { durationMs: 900, easing: "ease_out" },
          tags: ["living-room", "sofa", "editable-model", prefix],
        }),
        ...sofaPartSpecs.map((part, index) => primitiveOperation(
          partIds[index],
          part.label,
          part.geometry,
          part.placement,
          sofaPrimitiveRef,
          {
            key: `${prefix}_${part.key}`,
            parentId: rootId,
            material: part.cushion ? cushionFabric : fabric,
            collision,
            physics,
            transition: { durationMs: 900, easing: "ease_out" },
            tags: ["living-room", "sofa", "editable-part", prefix],
          },
        )),
      ];
    };

    const previewPreparation = await begin("Create a non-authoritative sofa placement preview", 8);
    const sofaIds = previewPreparation.reserved_component_ids;
    const [sofaId, ...sofaPartIds] = sofaIds;
    await submit(previewPreparation, sofaOperations({
      prepared: previewPreparation,
      ids: sofaIds,
      rootPlacement: world(-4.3, 0, 2.7),
      prefix: "preview",
      fabric: previewSofaFabric,
      cushionFabric: previewCushionFabric,
      collision: noCollision,
      physics: disabledPhysics,
    }));
    const placementPreflight = await callAgent(client, "query_spatial_placement", {
      ...session,
      candidate: {
        geometry: { kind: "box", sizeM: { x: 3.2, y: 1.6, z: 1.3 } },
        placement: world(-4.3, 0.8, 2.7),
        collision: { enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02 },
      },
    });
    if (!placementPreflight.ok || placementPreflight.data?.placement_check?.valid !== false) {
      throw new Error("The doorway collision preflight did not report an invalid placement.");
    }

    const badSofaPreparation = await begin("Try the authoritative solid sofa at the blocked doorway", 8);
    let badSofaSubmission;
    let revisionAfterRejection;
    await captureFrames(cdp, "collision-frames", {
      beforeFrame: async (index) => {
        if (index !== 24) return;
        badSofaSubmission = await callAgent(client, "submit_workspace_batch", {
          ...session,
          transaction_token: badSofaPreparation.transaction_token,
          batch: {
            ...badSofaPreparation.envelope,
            operations: sofaOperations({
              prepared: badSofaPreparation,
              ids: badSofaPreparation.reserved_component_ids,
              rootPlacement: world(-4.3, 0, 2.7),
              prefix: "authoritative_blocked",
              fabric: finalSofaFabric,
              cushionFabric: finalCushionFabric,
              collision: solidCollision,
              physics: enabledPhysics,
            }),
          },
        });
        if (badSofaSubmission.ok || badSofaSubmission.error?.code !== "spatial_collision") {
          throw new Error(`The doorway-blocking sofa was not atomically rejected: ${badSofaSubmission.error?.code ?? "committed"}`);
        }
        revisionAfterRejection = (await callAgent(client, "inspect_workspace", session)).data.workspace_summary.revision;
        if (revisionAfterRejection !== badSofaPreparation.envelope.base_workspace_revision) {
          throw new Error("Rejected sofa placement changed the Workspace revision.");
        }

        const rejectionFeedback = await begin("Mark the rejected sofa preview and door channel red");
        await submit(rejectionFeedback, [
          ...sofaPartIds.map((id, partIndex) => ({
            op: "update_component",
            op_id: `mark_rejected_sofa_part_${partIndex + 1}`,
            id,
            patch: { props: { material: sofaPartSpecs[partIndex].cushion ? rejectedCushionFabric : rejectedFabric } },
            transition: { durationMs: 380, easing: "ease_out" },
          })),
          {
            op: "update_component",
            op_id: "mark_blocked_door_channel",
            id: doorZoneId,
            patch: { props: { material: material("#E85757", 0.2, { roughness: 0.72, emissiveColor: "#D9364A", emissiveIntensity: 0.78 }) } },
            transition: { durationMs: 380, easing: "ease_out" },
          },
        ]);
      },
    });
    if (!badSofaSubmission || revisionAfterRejection === undefined) {
      throw new Error("The fixed-frame collision rejection sequence did not complete.");
    }

    const safePlacementPreflight = await callAgent(client, "query_spatial_placement", {
      ...session,
      candidate: {
        geometry: { kind: "box", sizeM: { x: 3.2, y: 1.6, z: 1.3 } },
        placement: world(0, 0.8, 2.35),
        collision: { enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02 },
      },
    });
    if (!safePlacementPreflight.ok || safePlacementPreflight.data?.placement_check?.valid !== true) {
      throw new Error("The corrected sofa position did not pass spatial preflight.");
    }

    const correctionPreparation = await begin("Move the preview sofa to a safe position and make it authoritative");
    let correctedSofa;
    let correctionCommitPromise;
    let correctionCommitError;
    await captureFrames(cdp, "correction-frames", {
      frameDelayMs: 24,
      beforeFrame: async (index) => {
        if (index !== 8) return;
        correctionCommitPromise = callAgent(client, "submit_workspace_batch", {
          ...session,
          transaction_token: correctionPreparation.transaction_token,
          batch: {
            ...correctionPreparation.envelope,
            operations: [{
              op: "place_component",
              op_id: "move_sofa_preview_to_safe_position",
              id: sofaId,
              placement: world(0, 0, 2.35),
              transition: { durationMs: 900, easing: "ease_out" },
            }, ...sofaPartIds.map((id, partIndex) => ({
              op: "update_component",
              op_id: `authorize_safe_sofa_part_${partIndex + 1}`,
              id,
              patch: {
                props: {
                  material: sofaPartSpecs[partIndex].cushion ? finalCushionFabric : finalSofaFabric,
                  collision: solidCollision,
                  physics: enabledPhysics,
                },
              },
              transition: { durationMs: 900, easing: "ease_out" },
            })), {
              op: "update_component",
              op_id: "restore_clear_door_channel",
              id: doorZoneId,
              patch: { props: { material: material("#35D07F", 0.34, { roughness: 0.72, emissiveColor: "#2ED67B", emissiveIntensity: 0.82 }) } },
              transition: { durationMs: 900, easing: "ease_out" },
            }],
          },
        }).then((result) => {
          correctedSofa = result;
          return result;
        }).catch((error) => {
          correctionCommitError = error;
          return undefined;
        });
      },
    });
    if (!correctionCommitPromise) throw new Error("The fixed-frame correction transaction never started.");
    await correctionCommitPromise;
    if (correctionCommitError) throw correctionCommitError;
    if (correctedSofa && !correctedSofa.ok) {
      throw new Error(`The safe sofa correction failed: ${correctedSofa.error?.code} ${correctedSofa.error?.message ?? ""}`);
    }
    if (!correctedSofa?.ok) throw new Error("The correction sequence never committed the safe sofa.");

    const spaceAfterCorrection = await callAgent(client, "inspect_workspace_space", session);
    const physicsAfterCorrection = await callAgent(client, "inspect_workspace_physics", session);
    const graph = spaceAfterCorrection.data?.spatial_graph;
    const physics = physicsAfterCorrection.data?.physics_validation;
    if (!spaceAfterCorrection.ok || !physicsAfterCorrection.ok
      || (graph?.collision_conflicts ?? []).length !== 0
      || physics?.feasible !== true) {
      throw new Error("The corrected living room did not pass spatial and physics validation.");
    }

    let cinemaPointerClicked = false;
    let cinemaClickPromise;
    let cinemaClickError;
    await captureFrames(cdp, "cinema-control-frames", {
      frameDelayMs: 24,
      beforeFrame: async (index) => {
        if (index !== 28) return;
        cinemaClickPromise = pointerClickTextButton(cdp, "开启观影模式")
          .then(() => {
            cinemaPointerClicked = true;
          })
          .catch((error) => {
            cinemaClickError = error;
          });
      },
    });
    if (!cinemaClickPromise) throw new Error("The fixed-frame cinema pointer action never started.");
    await cinemaClickPromise;
    if (cinemaClickError) throw cinemaClickError;
    if (!cinemaPointerClicked) throw new Error("The cinema-mode source frame did not execute the pointer click.");
    const controlledIds = [movieId, lampGlowId, ambientLeftId, ambientRightId, monitorScreenId];
    const controlledStates = [];
    for (const componentId of controlledIds) {
      const inspection = await callAgent(client, "inspect_workspace_component", {
        ...session,
        component_id: componentId,
      });
      if (!inspection.ok) throw new Error(`Could not inspect cinema-mode target ${componentId}.`);
      controlledStates.push(inspection.data.component?.visibility);
    }
    const expectedCinemaVisibility = ["visible", "visible", "visible", "visible", "hidden"];
    if (controlledStates.some((visibility, index) => visibility !== expectedCinemaVisibility[index])) {
      throw new Error(`Cinema-mode pointer click did not route all five targets: ${JSON.stringify(controlledStates)}`);
    }
    const eventPage = await callAgent(client, "read_workspace_events", { ...session, limit: 20 });
    const events = eventPage.data?.events ?? [];
    const pressedEvent = events.find((event) => event.type === "pressed" && event.componentId === buttonId);
    const routedVisibilityEvents = events.filter((event) => event.type === "visibility_changed" && event.source === "binding");
    if (!pressedEvent || routedVisibilityEvents.length < 5) {
      throw new Error("Cinema-mode event fan-out was not recorded as one press plus five routed visibility changes.");
    }

    const currentState = await callAgent(client, "inspect_workspace", session);
    const revisionBeforeUndo = currentState.data.workspace_summary.revision;
    let undoResult;
    let redoResult;
    await captureFrames(cdp, "undo-redo-frames", {
      beforeFrame: async (index) => {
        if (index === 16) {
          undoResult = await callAgent(client, "undo_workspace_batch", {
            ...session,
            expected_workspace_revision: revisionBeforeUndo,
          });
          if (!undoResult.ok || undoResult.data?.changed !== true) throw new Error("Cinema-mode undo failed.");
        }
        if (index === 32) {
          if (!undoResult?.ok) throw new Error("Cinema-mode redo ran before a successful undo.");
          redoResult = await callAgent(client, "redo_workspace_batch", {
            ...session,
            expected_workspace_revision: undoResult.data.workspace_revision,
          });
          if (!redoResult.ok || redoResult.data?.changed !== true) throw new Error("Cinema-mode redo failed.");
        }
      },
    });
    if (!undoResult?.ok || !redoResult?.ok) throw new Error("The fixed-frame undo/redo sequence did not complete.");
    const finalTarget = await callAgent(client, "inspect_workspace_component", {
      ...session,
      component_id: movieId,
    });
    if (finalTarget.data?.component?.visibility !== "visible") {
      throw new Error("Redo did not restore cinema mode.");
    }

    await captureOrbit(cdp, "final-orbit-frames");

    const finalWorkspace = await callAgent(client, "inspect_workspace", session);
    const evidence = {
      demo: "SemaFrame warm living-room physical pull request",
      generatedAt: new Date().toISOString(),
      syntheticBaseline: true,
      workspace: {
        revision: finalWorkspace.data?.workspace_summary?.revision,
        componentCount: finalWorkspace.data?.workspace_summary?.component_count,
        historyCount: finalWorkspace.data?.workspace_summary?.history_count,
      },
      collisionGuard: {
        errorCode: badSofaSubmission.error.code,
        requiredAction: badSofaSubmission.error.required_action,
        revisionBefore: badSofaPreparation.envelope.base_workspace_revision,
        revisionAfterRejection,
        previewComponentIds: sofaIds,
        rejectedReservedComponentIds: badSofaPreparation.reserved_component_ids,
        preflightValid: placementPreflight.data.placement_check.valid,
        conflicts: placementPreflight.data.placement_check.conflicts,
        suggestionCount: placementPreflight.data.placement_check.suggested_placements?.length ?? 0,
        correctedPreflightValid: safePlacementPreflight.data.placement_check.valid,
        correctedPreflightConflicts: safePlacementPreflight.data.placement_check.conflicts,
      },
      correction: {
        resultingRevision: correctedSofa.data.resulting_workspace_revision,
        spatialGraphVersion: graph.version,
        collisionConflictCount: (graph.collision_conflicts ?? []).length,
        physicsVersion: physics.version,
        physicsModel: physics.model,
        physicsFeasible: physics.feasible,
        physicsIssues: physics.issues,
      },
      cinemaMode: {
        pointerInput: true,
        sourceButtonId: buttonId,
        controlledComponentIds: controlledIds,
        expectedVisibility: expectedCinemaVisibility,
        sourceFrame: 28,
        routedVisibilityEventCount: routedVisibilityEvents.length,
        finalVisibility: controlledStates,
        eventSummary: events.map((event) => ({
          type: event.type,
          componentId: event.componentId,
          source: event.source,
        })),
      },
      undoRedo: {
        revisionBeforeUndo,
        undoRevision: undoResult.data.workspace_revision,
        redoRevision: redoResult.data.workspace_revision,
        restored: finalTarget.data.component.visibility === "visible",
        undoSourceFrame: 16,
        redoSourceFrame: 32,
      },
      capture: {
        width: 1600,
        height: 900,
        frameCountPerSequence: 48,
        frameFolders,
      },
      claimBoundaries: [
        "The room is a synthetic procedural baseline, not a scan of a real home.",
        "Collision and physics are deterministic preflight, not building-code certification.",
        "Cinema mode uses durable event routing and renderer transitions, not a smart-home network.",
      ],
    };
    writeFileSync(join(outputRoot, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Living-room capture complete: ${outputRoot}`);
  } catch (error) {
    const tail = logs.join("").slice(-5_000);
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
  await captureLivingRoomDemo();
  process.exit(0);
}
