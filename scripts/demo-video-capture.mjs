import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const outputRoot = resolve("video/public/captures");

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

function clickButton(text) {
  return `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)}));
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
  writeFileSync(join(outputRoot, filename), Buffer.from(result.data, "base64"));
}

async function captureMotion(cdp, folder, frameCount = 48, frameDelayMs = 80) {
  const directory = join(outputRoot, folder);
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < frameCount; index += 1) {
    const result = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 88,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    writeFileSync(join(directory, `frame-${String(index).padStart(4, "0")}.jpg`), Buffer.from(result.data, "base64"));
    await delay(frameDelayMs);
  }
}

function compactDemoEvidence({ space, physicsBefore, physicsAfter, overlap, simulation }) {
  const spaceData = space?.data?.universal_space_data ?? {};
  const before = physicsBefore?.data?.physics_validation ?? {};
  const after = physicsAfter?.data?.physics_validation ?? {};
  const placement = overlap?.data?.placement_check ?? {};
  const settle = simulation?.data?.simulation ?? {};
  return {
    universalSpaceData: {
      format: spaceData.format,
      version: spaceData.version,
      workspaceRevision: space?.data?.workspace_revision,
      stage: spaceData.stage,
      nodes: (spaceData.nodes ?? []).map((node) => ({
        id: node.id,
        primPath: node.prim_path,
        label: node.label,
        bounds: node.world_bounds,
        collision: node.collision ? { enabled: node.collision.enabled, role: node.collision.role, shape: node.collision.shape } : undefined,
      })),
      relations: (spaceData.relations ?? []).slice(0, 12),
    },
    physicsBefore: {
      model: before.model,
      feasible: before.feasible,
      issues: before.issues,
      bodies: (before.bodies ?? []).map((body) => ({
        componentId: body.component_id,
        bodyType: body.body_type,
        grounded: body.grounded,
        stabilityReason: body.stability_reason,
      })),
    },
    collisionPreflight: {
      valid: placement.valid,
      collisions: placement.collisions,
      suggestedPlacements: (placement.suggested_placements ?? []).slice(0, 2),
    },
    settlePreview: {
      model: settle.model,
      mutatesWorkspace: settle.mutates_workspace,
      proposals: settle.proposals,
    },
    physicsAfter: {
      model: after.model,
      feasible: after.feasible,
      issues: after.issues,
    },
  };
}

export async function captureDemoVideoAssets() {
  mkdirSync(outputRoot, { recursive: true });
  const gatewayPort = await freePort();
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const appUrl = `http://127.0.0.1:${vitePort}/`;
  const profile = mkdtempSync(join(tmpdir(), "semaframe-demo-video-"));
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
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "disabled connection gate");
    await capture(cdp, "01-connection-gate.png");

    if (!await cdp.evaluate(clickButton("Enable agent control"))) throw new Error("Could not enable Agent control.");
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-waiting'))", "waiting connection gate");
    const connectionUrl = await cdp.evaluate("document.querySelector('.agent-connection-url-wrap input')?.value");
    if (typeof connectionUrl !== "string") throw new Error("No Agent connection URL was rendered.");
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.agent-connection-url-wrap input');
      if (input instanceof HTMLInputElement) input.value = 'http://127.0.0.1:8788/mcp/connect/••••••••';
    })()`);
    await capture(cdp, "02-connection-url.png");

    client = new Client({ name: "SemaFrame demo agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(connectionUrl)));
    const pending = await callAgent(client, "get_workspace_instructions", {
      client_id: "semaframe-demo",
      client_name: "SemaFrame Demo Agent",
    });
    const approvalToken = pending.error?.details?.approval_token;
    if (pending.ok !== false || pending.error?.code !== "approval_pending" || typeof approvalToken !== "string") {
      throw new Error("The demo Agent did not enter approval_pending.");
    }
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-approval'))", "approval card");
    await capture(cdp, "03-agent-approval.png");
    if (!await cdp.evaluate(clickButton("Approve client"))) throw new Error("Could not approve demo Agent.");
    await poll(cdp, "!document.querySelector('.agent-connection-page.status-approval')", "approved Agent handoff");

    const instructions = await callAgent(client, "get_workspace_instructions", {
      client_id: "semaframe-demo",
      client_name: "SemaFrame Demo Agent",
      approval_token: approvalToken,
    });
    if (!instructions.ok) throw new Error(`Workspace handshake failed: ${instructions.error?.code}`);
    const session = {
      session_token: instructions.data.session_token,
      instruction_digest: instructions.data.guide_digest,
    };
    await poll(cdp, "Boolean(document.querySelector('.agent-workspace-controls.status-connected'))", "connected Workspace");
    await capture(cdp, "04-empty-workspace.png");

    const inspect = await callAgent(client, "inspect_workspace", session);
    if (!inspect.ok) throw new Error("Initial Workspace inspection failed.");
    const capability = inspect.data.capability_manifest;
    const componentRef = (manifest, typeId) => {
      const entry = manifest.component_types.find((candidate) => candidate.typeId === typeId);
      if (!entry) throw new Error(`Missing component manifest ${typeId}`);
      return { typeId: entry.typeId, version: entry.version, digest: entry.digest };
    };
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

    const stagePreparation = await begin("Create the semantic 3D stage", 1);
    const stageId = stagePreparation.reserved_component_ids[0];
    await submit(stagePreparation, [{
      op: "create_component",
      op_id: "create_stage",
      id: stageId,
      label: "Operations room",
      component_type: componentRef(stagePreparation.capability_manifest, "stage-3d"),
      props: { environmentPreset: "simple_room" },
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      transition: { durationMs: 320, easing: "ease_out" },
    }]);

    const setup = await begin("Build a live operations room with data and controls", 6);
    const [tableId, chairId, runnerId, crateId, chartId, buttonId] = setup.reserved_component_ids;
    const manifest = setup.capability_manifest;
    const inline = manifest.connector_types.find((entry) => entry.connectorType === "inline.snapshot" && entry.connectorVersion === "1.0.0");
    const outputSchema = inline?.recommendedOutputSchemas?.find((entry) => entry.id === "chart.timeseries.v1")?.schema;
    if (!inline || !outputSchema) throw new Error("The chart snapshot connector was not advertised.");
    const world = (x, y, z, scale = 1) => ({
      space: "world3d",
      position: { x, y, z },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: scale, y: scale, z: scale },
    });
    const dynamicPhysics = {
      enabled: true,
      bodyType: "dynamic",
      massKg: 4,
      centerOfMass: { x: 0, y: 0, z: 0 },
      friction: 0.6,
      restitution: 0.1,
      gravityScale: 1,
      stabilityMode: "report",
      constraints: [],
    };
    await submit(setup, [{
      op: "create_component", op_id: "create_table", id: tableId, label: "Telemetry desk",
      component_type: componentRef(manifest, "spatial-entity"),
      props: { assetId: "table_wood_simple_01", entityKind: "prop" },
      placement: world(-1.6, 0, 0),
    }, {
      op: "create_component", op_id: "create_chair", id: chairId, label: "Operator chair",
      component_type: componentRef(manifest, "spatial-entity"),
      props: { assetId: "chair_wood_simple_01", entityKind: "prop" },
      placement: world(-1.6, 0, 1.35),
    }, {
      op: "create_component", op_id: "create_runner", id: runnerId, label: "Simulation runner",
      component_type: componentRef(manifest, "spatial-entity"),
      props: { assetId: "humanoid_adult_neutral_01", entityKind: "character" },
      placement: world(0.8, 0, 0.7),
    }, {
      op: "create_component", op_id: "create_crate", id: crateId, label: "Floating telemetry crate",
      component_type: componentRef(manifest, "spatial-entity"),
      props: { assetId: "box_small_02", entityKind: "prop", physics: dynamicPhysics },
      placement: world(2.7, 2.2, -0.3, 1.4),
    }, {
      op: "create_component", op_id: "create_chart", id: chartId, label: "Live system load",
      component_type: componentRef(manifest, "chart"),
      props: { title: "System load · live snapshot", chartType: "area" },
      placement: { space: "viewport", anchor: "top_right", offset: { x: -32, y: 72 }, size: { width: 410, height: 260 } },
      transition: { durationMs: 260, easing: "ease_out" },
    }, {
      op: "create_component", op_id: "create_button", id: buttonId, label: "Simulation control",
      component_type: componentRef(manifest, "button"),
      props: { label: "Run simulation", variant: "primary" },
      placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: -36 }, size: { width: 210, height: 72 } },
      transition: { durationMs: 180, easing: "ease_out" },
    }, {
      op: "upsert_resource", op_id: "upsert_load", resource: {
        id: "RES_system_load",
        label: "System load snapshot",
        connectorType: inline.connectorType,
        connectorVersion: inline.connectorVersion,
        outputSchema,
        config: {},
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data: {
            labels: ["10:00", "10:05", "10:10", "10:15", "10:20", "10:25"],
            series: [{ id: "load", label: "Load", values: [42, 51, 49, 67, 63, 78], color: "#68D5FF" }],
          },
          contentHash: "host-normalized",
          retrievedAt: "1970-01-01T00:00:00.000Z",
          stale: false,
          provenance: [],
        },
        status: "ready",
      },
    }, {
      op: "bind_resource", op_id: "bind_labels", binding: {
        kind: "resource_binding", id: "BIND_load_labels", resourceId: "RES_system_load",
        componentId: chartId, targetProp: "labels", sourcePath: "$.labels", mode: "snapshot",
        transform: { kind: "identity" }, enabled: true,
      },
    }, {
      op: "bind_resource", op_id: "bind_series", binding: {
        kind: "resource_binding", id: "BIND_load_series", resourceId: "RES_system_load",
        componentId: chartId, targetProp: "series", sourcePath: "$.series", mode: "snapshot",
        transform: { kind: "identity" }, enabled: true,
      },
    }, {
      op: "connect_event", op_id: "connect_button_runner", connection: {
        kind: "event_connection", id: "EVENT_run_simulation", sourceComponentId: buttonId,
        event: "pressed", targetComponentId: runnerId, action: "play_animation",
        input: { clip: "run", loop: true, speed: 1 }, enabled: true,
        transition: { durationMs: 220, easing: "ease_out" },
      },
    }, {
      op: "connect_event", op_id: "connect_runner_chart", connection: {
        kind: "event_connection", id: "EVENT_runner_chart", sourceComponentId: runnerId,
        event: "activated", targetComponentId: chartId, action: "toggle_visibility", input: {}, enabled: true,
      },
    }]);
    await poll(cdp, "document.querySelector('.scene-stat')?.textContent?.includes('rev 2') === true", "rendered demo Workspace");
    await delay(700);
    await cdp.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="Frame all"]');
      if (button instanceof HTMLButtonElement) button.click();
    })()`);
    await delay(900);
    await capture(cdp, "05-workspace-before-fix.png");

    const space = await callAgent(client, "inspect_workspace_space", session);
    const physicsBefore = await callAgent(client, "inspect_workspace_physics", session);
    const overlap = await callAgent(client, "query_spatial_placement", {
      ...session,
      candidate: {
        asset_id: "box_small_02",
        entity_kind: "prop",
        placement: world(-1.6, 0, 0),
      },
    });
    const simulation = await callAgent(client, "simulate_workspace_physics", {
      ...session,
      component_ids: [crateId],
      duration_ms: 1_000,
      time_step_ms: 20,
    });
    if (!space.ok || !physicsBefore.ok || !overlap.ok || !simulation.ok) throw new Error("Spatial evidence collection failed.");
    const proposal = simulation.data.simulation.proposals.find((entry) => entry.component_id === crateId);
    if (!proposal?.to) throw new Error("The physics preview did not propose a crate placement.");
    const correction = await begin("Apply the physics settle proposal");
    await submit(correction, [{
      op: "place_component",
      op_id: "settle_crate",
      id: crateId,
      placement: proposal.to,
      transition: { durationMs: 420, easing: "ease_out" },
    }]);
    await poll(cdp, "document.querySelector('.scene-stat')?.textContent?.includes('rev 3') === true", "settled crate revision");
    await delay(700);
    const physicsAfter = await callAgent(client, "inspect_workspace_physics", session);
    if (!physicsAfter.ok) throw new Error("Post-correction physics inspection failed.");
    writeFileSync(
      join(outputRoot, "demo-evidence.json"),
      `${JSON.stringify(compactDemoEvidence({ space, physicsBefore, physicsAfter, overlap, simulation }), null, 2)}\n`,
    );
    await capture(cdp, "06-workspace-after-fix.png");

    const selected = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.workspace-component-tree button')]
        .find((item) => item.textContent?.trim() === 'Floating telemetry crate');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (selected) {
      await cdp.evaluate(clickButton("Inspector"));
      await poll(cdp, "Boolean(document.querySelector('.workspace-inspector'))", "physics inspector");
      await delay(300);
      await capture(cdp, "07-collision-physics-inspector.png");
    }

    await cdp.evaluate(clickButton("Inspector"));
    await poll(cdp, "!document.querySelector('.workspace-inspector')", "closed physics inspector");
    await cdp.evaluate(`(() => {
      const run = document.querySelector('.workspace-button');
      if (!(run instanceof HTMLButtonElement) || run.disabled) return false;
      run.click();
      return true;
    })()`);
    await captureMotion(cdp, "interaction-frames");
    await capture(cdp, "08-interaction-running.png");

    if (await cdp.evaluate(clickButton("History"))) {
      await poll(cdp, "Boolean(document.querySelector('.agent-history-drawer'))", "Workspace history drawer");
      await delay(250);
      await capture(cdp, "09-deterministic-history.png");
    }

    console.log(`Demo capture complete: ${outputRoot}`);
  } catch (error) {
    const tail = logs.join("").slice(-4_000);
    if (tail.trim()) console.error(tail);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
    cdp?.close();
    stack.kill("SIGTERM");
    browser.kill("SIGTERM");
    await delay(250);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (import.meta.url === new URL(`file://${resolve(process.argv[1] ?? "")}`).href) {
  await captureDemoVideoAssets();
}
