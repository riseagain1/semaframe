import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { launchChromeForSmoke } from "./lib/chrome-smoke-launcher.mjs";
import { spawnOwnedProcessTree, stopOwnedProcessTrees } from "./lib/owned-process-tree.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const withTimeout = (promise, timeoutMs, label) => new Promise((resolvePromise, rejectPromise) => {
  const timeout = setTimeout(() => rejectPromise(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  promise.then(
    (value) => { clearTimeout(timeout); resolvePromise(value); },
    (error) => { clearTimeout(timeout); rejectPromise(error); },
  );
});
const artifacts = resolve("artifacts");
const recoverySmokeOnly = process.argv.includes("--recovery-only");
const RECOVERY_SMOKE_COMPLETE = Symbol("recovery-smoke-complete");

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
  if (!found) throw new Error("Chrome/Chromium was not found. Set BROWSER_EXECUTABLE to run the Workspace smoke check.");
  return found;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
    } catch { /* process is still starting */ }
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
  }

  async connect() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  waitFor(method, timeoutMs = 15_000) {
    return new Promise((resolveEvent, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        const listeners = this.listeners.get(method) ?? [];
        this.listeners.set(method, listeners.filter((candidate) => candidate !== listener));
      };
      const listener = (params) => {
        cleanup();
        resolveEvent(params);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Chrome DevTools event ${method}`));
      }, timeoutMs);
      this.on(method, listener);
    });
  }

  send(method, params = {}, timeoutMs = 15_000) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      const timeoutError = new Error(`Timed out waiting for Chrome DevTools ${method}`);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolveCall(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(description);
    }
    return result.result.value;
  }

  close() {
    for (const pending of this.pending.values()) pending.reject(new Error("Chrome DevTools connection closed"));
    this.pending.clear();
    this.socket.close();
  }
}

async function poll(cdp, expression, label, timeoutMs = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await cdp.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function readWorkspaceRecoveryStorage(cdp) {
  return cdp.evaluate(`new Promise((resolve) => {
    const request = indexedDB.open('semaframe-workspace-recovery-v3', 1);
    request.onerror = () => resolve({ slots: [], databaseError: true });
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('snapshots')) {
        database.close();
        resolve({ slots: [], fallbackPresent: Boolean(localStorage.getItem('semaframe-workspace-recovery-v3-fallback')), legacyPresent: Boolean(localStorage.getItem('semaframe-workspace-recovery-v2')) });
        return;
      }
      const transaction = database.transaction('snapshots', 'readonly');
      const records = transaction.objectStore('snapshots').getAll();
      let value = { slots: [], databaseError: true };
      transaction.onerror = () => { database.close(); resolve({ slots: [], databaseError: true }); };
      transaction.onabort = () => { database.close(); resolve({ slots: [], databaseError: true }); };
      transaction.oncomplete = () => { database.close(); resolve(value); };
      records.onerror = () => { value = { slots: [], databaseError: true }; };
      records.onsuccess = () => {
        value = {
          slots: records.result.map((record) => ({ slot: record.slot, sequence: record.sequence, projectName: record.projectName })),
          fallbackPresent: Boolean(localStorage.getItem('semaframe-workspace-recovery-v3-fallback')),
          legacyPresent: Boolean(localStorage.getItem('semaframe-workspace-recovery-v2')),
        };
      };
    };
  })`);
}

async function waitForWorkspaceRecoverySlots(cdp, requiredSlots, label, timeoutMs = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await readWorkspaceRecoveryStorage(cdp);
    if (requiredSlots.every((slot) => state.slots.some((record) => record.slot === slot))) return state;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function corruptCurrentWorkspaceRecovery(cdp) {
  return cdp.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('semaframe-workspace-recovery-v3', 1);
    request.onerror = () => reject(request.error ?? new Error('Recovery database could not open'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('snapshots', 'readwrite');
      transaction.onerror = () => reject(transaction.error ?? new Error('Recovery transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recovery transaction aborted'));
      const store = transaction.objectStore('snapshots');
      const current = store.get('current');
      let updated = false;
      current.onerror = () => reject(current.error ?? new Error('Current recovery could not be read'));
      current.onsuccess = () => {
        if (!current.result) return;
        updated = true;
        store.put({ ...current.result, sha256: 'sha256:' + 'f'.repeat(64) });
      };
      transaction.oncomplete = () => { database.close(); resolve(updated); };
    };
  })`);
}

async function reloadWorkspaceApp(cdp, label) {
  await cdp.evaluate("window.__workspaceRecoveryReloadMarker = 'before'");
  const loaded = cdp.waitFor("Page.loadEventFired");
  await cdp.send("Page.reload", { ignoreCache: true });
  await loaded;
  await poll(
    cdp,
    "window.__workspaceRecoveryReloadMarker !== 'before' && Boolean(document.querySelector('.app-shell'))",
    label,
  );
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

function clickHierarchyItem(label) {
  return `(() => {
    const button = [...document.querySelectorAll('.workspace-model-hierarchy button')]
      .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

function workspaceAgentPayload(result, toolName) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object" && typeof structured.ok === "boolean") return structured;
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
    } catch { /* reported below without echoing capability-bearing content */ }
  }
  throw new Error(`MCP tool ${toolName} returned no SemaFrame payload.`);
}

async function callWorkspaceAgent(client, name, args) {
  return workspaceAgentPayload(await client.callTool({ name, arguments: args }), name);
}

async function unlockWorkspaceThroughAgent(cdp, clientLabel) {
  if (await cdp.evaluate("document.querySelector('.app-workspace')?.dataset.agentWorkspaceActive === 'true'")) return undefined;
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page'))", `${clientLabel} connection gate`);
  let connectionInputReady = false;
  for (let attempt = 0; attempt < 3 && !connectionInputReady; attempt += 1) {
    if (await cdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-approved'))")) {
      await cdp.evaluate(clickExactButton(attempt === 0 ? "Check status" : "Start over with a fresh URL"));
      await delay(50);
    } else if (await cdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-disconnected'))")) {
      await cdp.evaluate(clickExactButton("Check status"));
      await delay(50);
    }
    if (await cdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-disabled'))")) {
      await poll(
        cdp,
        "Boolean(document.querySelector('.agent-connection-page.status-disabled:not([aria-busy=\"true\"]) button.agent-primary-action:not(:disabled)'))",
        `${clientLabel} settled enable action`,
      );
      if (!await cdp.evaluate(clickExactButton("Enable agent control"))) {
        throw new Error(`${clientLabel} could not enable Agent control.`);
      }
      await delay(50);
    }
    try {
      await poll(
        cdp,
        "document.querySelector('.app-workspace')?.dataset.agentWorkspaceActive === 'true' || Boolean(document.querySelector('.agent-connection-page.status-waiting .agent-connection-url-wrap input')) || Boolean(document.querySelector('.agent-connection-error'))",
        `${clientLabel} active Workspace, waiting connection URL, or actionable error`,
        4_000,
      );
    } catch {
      // Project replacement can render the disabled gate just before its
      // exclusive operation releases. Re-evaluate and retry only while the
      // page is still the same enabled, non-busy disabled state.
    }
    connectionInputReady = await cdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-waiting .agent-connection-url-wrap input'))");
    if (connectionInputReady) break;
    if (await cdp.evaluate("document.querySelector('.app-workspace')?.dataset.agentWorkspaceActive === 'true'")) {
      return undefined;
    }
    const actionError = await cdp.evaluate("document.querySelector('.agent-connection-error')?.textContent?.trim() ?? ''");
    const retryableDisabledGate = await cdp.evaluate(
      "Boolean(document.querySelector('.agent-connection-page.status-disabled:not([aria-busy=\"true\"]) button.agent-primary-action:not(:disabled)'))",
    );
    if (actionError && !retryableDisabledGate && !/workspace operation is still in progress/iu.test(actionError)) {
      throw new Error(`${clientLabel} could not enable Agent control: ${actionError || "unknown connection error"}`);
    }
    await delay(100);
  }
  if (!connectionInputReady) {
    const state = await cdp.evaluate(`({
      pageClass: document.querySelector('.agent-connection-page')?.className,
      workspaceActive: document.querySelector('.app-workspace')?.dataset.agentWorkspaceActive,
      buttons: [...document.querySelectorAll('.agent-connection-page button')].map((button) => ({
        text: button.textContent?.replace(/\\s+/g, ' ').trim(),
        disabled: button.disabled,
      })),
      actionError: document.querySelector('.agent-connection-error')?.textContent,
      toast: document.querySelector('.toast-stack')?.textContent,
    })`);
    throw new Error(`${clientLabel} did not reach a waiting connection URL. Non-sensitive UI state: ${JSON.stringify(state)}`);
  }
  const connectionUrl = await cdp.evaluate("document.querySelector('.agent-connection-url-wrap input')?.value");
  if (typeof connectionUrl !== "string" || !connectionUrl.startsWith("http://127.0.0.1:")) {
    throw new Error(`${clientLabel} did not receive a local connection URL.`);
  }
  const client = new Client({ name: clientLabel, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connectionUrl)));
  const requestedScopes = ["workspace:read"];
  const pending = await callWorkspaceAgent(client, "get_workspace_instructions", {
    client_id: clientLabel,
    client_name: clientLabel,
    requested_scopes: requestedScopes,
  });
  const approvalToken = pending.error?.details?.approval_token;
  if (pending.ok !== false || pending.error?.code !== "approval_pending" || typeof approvalToken !== "string") {
    throw new Error(`${clientLabel} did not enter explicit approval.`);
  }
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-approval'))", `${clientLabel} approval gate`);
  if (!await cdp.evaluate(clickExactButton("Approve client"))) {
    throw new Error(`${clientLabel} could not be approved.`);
  }
  await poll(cdp, "!document.querySelector('.agent-connection-page.status-approval')", `${clientLabel} approved handoff`);
  const instructions = await callWorkspaceAgent(client, "get_workspace_instructions", {
    client_id: clientLabel,
    client_name: clientLabel,
    requested_scopes: requestedScopes,
    approval_token: approvalToken,
  });
  if (instructions.ok !== true || typeof instructions.data?.session_token !== "string") {
    throw new Error(`${clientLabel} did not complete the Workspace instruction handshake (${instructions.error?.code ?? "invalid_response"}).`);
  }
  await poll(
    cdp,
    "document.querySelector('.app-workspace')?.dataset.agentWorkspaceActive === 'true' && document.querySelector('.hybrid-workspace-canvas')?.dataset.sceneEngineReady === 'true'",
    `${clientLabel} authenticated Workspace unlock`,
  );
  return client;
}

function clickButtonWithAriaLabel(label) {
  return `(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

async function clickVisibleButtonWithPointer(cdp, label) {
  const point = await cdp.evaluate(`(async () => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== button && !button.contains(hit))) return null;
    return { x, y };
  })()`);
  if (!point) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  return true;
}

function setInspectorNumber(label, value) {
  return `(() => {
    const input = [...document.querySelectorAll('.workspace-inspector__dimension-grid label')]
      .find((candidate) => candidate.querySelector('span')?.textContent?.trim() === ${JSON.stringify(label)})
      ?.querySelector('input');
    if (!(input instanceof HTMLInputElement) || input.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

function setInspectorEffect(label, value) {
  return `(() => {
    const labelElement = [...document.querySelectorAll('.workspace-inspector__effects label')]
      .find((candidate) => candidate.querySelector('span')?.textContent?.trim() === ${JSON.stringify(label)}
        || candidate.childNodes[0]?.textContent?.trim() === ${JSON.stringify(label)});
    const input = labelElement?.htmlFor
      ? document.getElementById(labelElement.htmlFor)
      : labelElement?.querySelector('input');
    if (!(input instanceof HTMLInputElement) || input.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

async function captureWorkspaceProject(cdp, key) {
  await cdp.evaluate(`(() => {
    window.__workspaceSmokeSavedProjects ??= {};
    window.__workspaceSmokeSaveKey = ${JSON.stringify(key)};
    delete window.__workspaceSmokeSavedProjects[window.__workspaceSmokeSaveKey];
    if (!window.__workspaceSmokeObjectUrlHooked) {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (value) => {
        const saveKey = window.__workspaceSmokeSaveKey;
        if (saveKey && value instanceof Blob) {
          void value.text().then((contents) => {
            window.__workspaceSmokeSavedProjects[saveKey] = contents;
          });
        }
        return createObjectURL(value);
      };
      window.__workspaceSmokeObjectUrlHooked = true;
    }
    document.querySelector('button[aria-label="Save project"]')?.click();
  })()`);
  await poll(
    cdp,
    `Boolean(window.__workspaceSmokeSavedProjects?.[${JSON.stringify(key)}])`,
    `captured ${key} Workspace project`,
  );
  return cdp.evaluate(`window.__workspaceSmokeSavedProjects[${JSON.stringify(key)}]`);
}

function componentPair(project, typeId) {
  return project.workspace?.components?.find((entry) => entry?.[1]?.type?.typeId === typeId);
}

function assertOneResizeCommand(beforeSerialized, afterSerialized, typeId, expectedResize) {
  const before = JSON.parse(beforeSerialized);
  const after = JSON.parse(afterSerialized);
  const component = componentPair(after, typeId)?.[1];
  if (!component) throw new Error(`Resize smoke could not find ${typeId} in the saved project.`);
  if (after.workspace.revision !== before.workspace.revision + 1) {
    throw new Error(`Resize changed revision ${before.workspace.revision} -> ${after.workspace.revision}; expected exactly one revision.`);
  }
  if (after.commandHistory.length !== before.commandHistory.length + 1 || after.workspace.history.length !== before.workspace.history.length + 1) {
    throw new Error(`Resize did not append exactly one command/history record: ${before.commandHistory.length}/${before.workspace.history.length} -> ${after.commandHistory.length}/${after.workspace.history.length}.`);
  }
  const lastCommand = after.commandHistory.at(-1);
  if (lastCommand?.resolvedOperations?.length !== 1 || lastCommand.resolvedOperations[0]?.op !== "resize_component") {
    throw new Error("Human resize was not recorded as one canonical resize_component operation.");
  }
  if (JSON.stringify(lastCommand.resolvedOperations[0].resize) !== JSON.stringify(expectedResize)) {
    throw new Error(`Resize history stored unexpected absolute geometry: ${JSON.stringify(lastCommand.resolvedOperations[0].resize)}.`);
  }
  return { before, after, component };
}

function assertFullscreenPreservedWorkspace(beforeSerialized, afterSerialized, label) {
  const before = JSON.parse(beforeSerialized);
  const after = JSON.parse(afterSerialized);
  if (after.workspace.revision !== before.workspace.revision) {
    throw new Error(`${label} changed Workspace revision ${before.workspace.revision} -> ${after.workspace.revision}.`);
  }
  if (JSON.stringify(after.commandHistory) !== JSON.stringify(before.commandHistory)
    || JSON.stringify(after.workspace.history) !== JSON.stringify(before.workspace.history)) {
    throw new Error(`${label} changed command or Workspace history.`);
  }
  if (JSON.stringify(after.workspace) !== JSON.stringify(before.workspace)) {
    throw new Error(`${label} changed authoritative Workspace state.`);
  }
}

function assertWorkspaceProject(serialized) {
  const project = JSON.parse(serialized);
  if (project.formatVersion !== "1.0" || typeof project.projectId !== "string" || "sceneProject" in project || "workspaceProject" in project) {
    throw new Error("Save did not produce one direct WorkspaceProjectFile 1.0 payload.");
  }
  const timer = componentPair(project, "timer")?.[1];
  const stage = componentPair(project, "stage-3d")?.[1];
  const video = componentPair(project, "video-player")?.[1];
  const spatialComponents = project.workspace.components
    .filter((entry) => entry?.[1]?.type?.typeId === "spatial-entity")
    .map((entry) => entry[1]);
  const desk = spatialComponents.find((component) => component.label === "Work desk");
  if (!timer || timer.label !== "Presentation timer" || timer.durableState?.phase !== "running") {
    throw new Error("Saved Workspace project did not preserve the running 2D presentation timer.");
  }
  if (!desk || !spatialComponents.some((component) => component.label === "Presenter")) {
    throw new Error("Saved Workspace project did not preserve both mixed-demo 3D components.");
  }
  if (project.protocolVersion !== "1.3" || project.workspaceSchemaVersion !== "1.4") {
    throw new Error("Saved Workspace project did not use the Protocol 1.3 / Project Schema 1.4 envelope.");
  }
  if (video?.placement?.size?.width !== 640 || video?.placement?.size?.height !== 408) {
    throw new Error("Saved Workspace project did not preserve the human-resized video player geometry.");
  }
  if (video?.visualEffects?.opacity !== 0.72
    || video?.visualEffects?.emissive?.color !== "#FF7722"
    || video?.visualEffects?.emissive?.intensity !== 2.4
    || video?.visualEffects?.glow?.color !== "#55DDFF"
    || video?.visualEffects?.glow?.intensity !== 1.5
    || video?.visualEffects?.glow?.spread !== 0.65) {
    throw new Error(`Saved Workspace project did not preserve the video visual effects: ${JSON.stringify(video?.visualEffects)}.`);
  }
  if (stage?.props?.dimensions?.width !== 16 || stage?.props?.dimensions?.height !== 4 || stage?.props?.dimensions?.depth !== 10) {
    throw new Error("Saved Workspace project did not preserve the resized 3D stage dimensions.");
  }
  if (desk.placement?.scale?.x !== 1.5 || desk.placement?.scale?.y !== 0.75 || desk.placement?.scale?.z !== 2) {
    throw new Error("Saved Workspace project did not preserve the resized 3D desk scale.");
  }
  if (desk.visualEffects?.opacity !== 0.9
    || desk.visualEffects?.emissive?.color !== "#FF3311"
    || desk.visualEffects?.emissive?.intensity !== 1.8
    || desk.visualEffects?.glow?.color !== "#FFAA00"
    || desk.visualEffects?.glow?.intensity !== 2.2
    || desk.visualEffects?.glow?.spread !== 0.4) {
    throw new Error(`Saved Workspace project did not preserve the 3D desk visual effects: ${JSON.stringify(desk.visualEffects)}.`);
  }
  const commands = project.commandHistory ?? [];
  if (!commands.some((command) => command.resolvedOperations?.some((operation) => operation.op === "invoke_component_action" && operation.action === "start"))) {
    throw new Error("Saved Workspace history did not retain the semantic timer action.");
  }
  const visualEffectOperations = commands.flatMap((command) => command.resolvedOperations ?? [])
    .filter((operation) => operation.op === "set_component_visual_effects");
  if (visualEffectOperations.length !== 2) {
    throw new Error(`Saved Workspace history did not retain both 2D and 3D visual-effects commands: ${visualEffectOperations.length}.`);
  }
  const resizeKinds = commands.flatMap((command) => command.resolvedOperations ?? [])
    .filter((operation) => operation.op === "resize_component")
    .map((operation) => operation.resize?.kind);
  if (JSON.stringify(resizeKinds) !== JSON.stringify(["box2d", "stage_dimensions", "scale3d"])) {
    throw new Error(`Saved Workspace history did not retain all resize variants in order: ${JSON.stringify(resizeKinds)}.`);
  }
  return project;
}

const gatewayPort = await freePort();
const vitePort = await freePort();
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const appUrl = `http://127.0.0.1:${vitePort}/`;
const profile = mkdtempSync(join(tmpdir(), "semaframe-workspace-smoke-"));
let browserStartup;
try {
  browserStartup = await launchChromeForSmoke({
    executable: browserExecutable(),
    profile,
    extraArgs: [
      "--headless=new",
      "--disable-gpu-sandbox",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
    ],
  });
} catch (error) {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  throw error;
}
const { browserTree, cdpPort } = browserStartup;
let stackTree;
try {
  stackTree = spawnOwnedProcessTree("npm", ["run", "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SEMAFRAME_AGENT_GATEWAY_PORT: String(gatewayPort),
      SEMAFRAME_AGENT_GATEWAY_PUBLIC_URL: gatewayUrl,
      SEMAFRAME_AGENT_VITE_PORT: String(vitePort),
      SEMAFRAME_DISABLE_HMR: "1",
    },
  }, { termGraceMs: 20_000, forceGraceMs: 5_000 });
} catch (error) {
  await browserTree.stop().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  throw error;
}
const { child: stack } = stackTree;
const processLogs = [];
stack.stdout.on("data", (chunk) => processLogs.push(String(chunk)));
stack.stderr.on("data", (chunk) => processLogs.push(String(chunk)));

let cdp;
const workspaceAgentClients = [];
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

  const problems = [];
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    problems.push(`exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
    const value = args.map((arg) => arg.value ?? arg.description).join(" ");
    if (["error", "warning"].includes(type) && !/GL Driver Message|software WebGL|Automatic fallback|Allow attribute will take precedence over 'allowfullscreen'|Blocked attempt to show a 'beforeunload' confirmation panel for a frame that never had a user gesture/iu.test(value)) {
      problems.push(`${type}: ${value}`);
    }
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    const ignored = /favicon\.ico|GL Driver Message|software WebGL|Automatic fallback|Allow attribute will take precedence over 'allowfullscreen'|Blocked attempt to show a 'beforeunload' confirmation panel for a frame that never had a user gesture/iu.test(entry.text);
    if (["error", "warning"].includes(entry.level) && !ignored) problems.push(`${entry.level}: ${entry.text}`);
  });
  cdp.on("Page.javascriptDialogOpening", ({ type, message }) => {
    const isBeforeUnload = type === "beforeunload";
    if (!isBeforeUnload) problems.push(`unexpected ${type} dialog: ${message}`);
    void cdp.send("Page.handleJavaScriptDialog", { accept: isBeforeUnload }).catch((error) => {
      problems.push(`dialog handling: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  cdp.on("Fetch.requestPaused", ({ requestId }) => {
    void cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
      body: Buffer.from("<!doctype html><title>Workspace smoke video</title><p>Deterministic embedded player stub</p>").toString("base64"),
    }).catch((error) => problems.push(`video stub: ${error instanceof Error ? error.message : String(error)}`));
  });
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Log.enable"),
    cdp.send("Network.enable"),
    cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "https://www.youtube-nocookie.com/*", requestStage: "Request" }],
    }),
  ]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: appUrl });
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page'))", "initial Agent connection gate");
  await cdp.evaluate("localStorage.clear(); sessionStorage.clear()");
  await reloadWorkspaceApp(cdp, "clean Workspace reload");
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "clean disabled Agent connection gate");
  const initialGate = await cdp.evaluate(`({
    workspaceMounted: Boolean(document.querySelector('.app-workspace')),
    workspaceActive: document.querySelector('.app-workspace')?.dataset.agentWorkspaceActive,
    workspaceInert: document.querySelector('.app-workspace')?.hasAttribute('inert'),
    workspaceAriaHidden: document.querySelector('.app-workspace')?.getAttribute('aria-hidden'),
    hasProjectBar: Boolean(document.querySelector('.project-bar')),
    hasBackButton: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Back to workspace')),
  })`);
  if (!initialGate.workspaceMounted || initialGate.workspaceActive !== "false" || !initialGate.workspaceInert ||
      initialGate.workspaceAriaHidden !== "true" || initialGate.hasProjectBar || initialGate.hasBackButton) {
    throw new Error(`The disconnected app did not keep its mounted Workspace inert behind the connection gate: ${JSON.stringify(initialGate)}`);
  }
  const initialAgentClient = await unlockWorkspaceThroughAgent(cdp, "Workspace browser smoke");
  if (initialAgentClient) workspaceAgentClients.push(initialAgentClient);

  const initialUi = await cdp.evaluate(`({
    panelLabel: document.querySelector('.app-workspace')?.getAttribute('aria-label'),
    workspaceActive: document.querySelector('.app-workspace')?.dataset.agentWorkspaceActive,
    workspaceInert: document.querySelector('.app-workspace')?.hasAttribute('inert'),
    canvasLabel: document.querySelector('.hybrid-workspace-canvas')?.getAttribute('aria-label'),
    hasWebGlCanvas: Boolean(document.querySelector('.hybrid-workspace-canvas canvas')),
    hasTools: Boolean(document.querySelector('.workspace-tool-dock')),
    hasAgentControls: Boolean(document.querySelector('.agent-workspace-controls')),
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
  })`);
  if (initialUi.panelLabel !== "Workspace" || initialUi.workspaceActive !== "true" || initialUi.workspaceInert ||
      initialUi.canvasLabel !== "Universal 2D and 3D workspace canvas" || !initialUi.hasWebGlCanvas ||
      !initialUi.hasTools || !initialUi.hasAgentControls || initialUi.hasLegacyModeSwitch) {
    throw new Error(`The unified hybrid Workspace did not open with its human and Agent controls: ${JSON.stringify(initialUi)}`);
  }
  await poll(cdp, clickExactButton("Components"), "enabled Component library control");
  await poll(
    cdp,
    "Boolean([...document.querySelectorAll('.workspace-library button strong')].some((item) => item.textContent?.trim() === '3D Stage')) && document.querySelectorAll('.workspace-component-tree [role=treeitem]').length === 0",
    "empty workspace with an explicit 3D Stage palette item",
  );
  if (!await cdp.evaluate(`(() => {
    const label = [...document.querySelectorAll('.workspace-library button strong')]
      .find((item) => item.textContent?.trim() === '3D Stage');
    const button = label?.closest('button');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`)) throw new Error("The human 3D Stage palette item could not be created.");
  await poll(
    cdp,
    "document.querySelectorAll('.workspace-component-tree [role=treeitem]').length === 1 && ![...document.querySelectorAll('.workspace-library button strong')].some((item) => item.textContent?.trim() === '3D Stage')",
    "one-stage human palette invariant",
  );
  if (!await cdp.evaluate(`(() => {
    const panel = document.querySelector('.workspace-tool-panel');
    if (!panel) return true;
    const button = panel.querySelector('.workspace-tool-panel__close');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`)) throw new Error("Component library could not be closed.");
  await poll(cdp, "!document.querySelector('.workspace-tool-panel')", "closed component panel");

  if (recoverySmokeOnly) {
    if (!await cdp.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Project name"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'recovery-smoke-current');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)) throw new Error("Project name could not create the focused recovery snapshot.");
    const recoverySlots = await waitForWorkspaceRecoverySlots(
      cdp,
      ["current", "previous"],
      "focused current and previous recovery snapshots",
    );
    const previousProjectName = recoverySlots.slots.find((record) => record.slot === "previous")?.projectName;
    if (typeof previousProjectName !== "string" || !previousProjectName) {
      throw new Error(`Focused recovery previous snapshot had no project name: ${JSON.stringify(recoverySlots)}`);
    }
    if (!await corruptCurrentWorkspaceRecovery(cdp)) {
      throw new Error("The focused current recovery snapshot was unavailable for corruption testing.");
    }
    await reloadWorkspaceApp(cdp, "focused Workspace recovery reload");
    const reloadClient = await unlockWorkspaceThroughAgent(cdp, "Focused Workspace recovery reload");
    if (reloadClient) workspaceAgentClients.push(reloadClient);
    await poll(cdp, "Boolean(document.querySelector('.recovery-banner'))", "focused recovery banner");
    if (!await cdp.evaluate(clickExactButton("Continue recovered project"))) {
      throw new Error("The focused recovery banner could not restore its previous snapshot.");
    }
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page'))", "focused recovery replacement gate");
    const restoreClient = await unlockWorkspaceThroughAgent(cdp, "Focused Workspace after recovery restore");
    if (restoreClient) workspaceAgentClients.push(restoreClient);
    await poll(
      cdp,
      `document.querySelector('input[aria-label="Project name"]')?.value === ${JSON.stringify(previousProjectName)} && document.querySelectorAll('.workspace-component-tree [role=treeitem]').length === 1`,
      "focused previous recovery restoration",
    );
    await reloadWorkspaceApp(cdp, "focused Workspace reload before dismissal");
    const dismissClient = await unlockWorkspaceThroughAgent(cdp, "Focused Workspace recovery dismissal");
    if (dismissClient) workspaceAgentClients.push(dismissClient);
    await poll(cdp, "Boolean(document.querySelector('.recovery-banner'))", "focused recovery banner before dismissal");
    if (!await cdp.evaluate(clickExactButton("Dismiss"))) throw new Error("Focused recovery dismissal was unavailable.");
    await poll(cdp, "!document.querySelector('.recovery-banner')", "focused dismissed recovery banner");
    const dismissed = await readWorkspaceRecoveryStorage(cdp);
    if (dismissed.slots.length !== 0 || dismissed.fallbackPresent || dismissed.legacyPresent) {
      throw new Error(`Focused Dismiss did not clear every recovery store: ${JSON.stringify(dismissed)}`);
    }
    if (problems.length) throw new Error(`Browser reported warnings/errors:\n${problems.join("\n")}`);
    console.log("Focused Workspace recovery browser smoke passed: current/previous write, corrupt-current reload fallback, project restore, and verified dismissal.");
    throw RECOVERY_SMOKE_COMPLETE;
  }

  await poll(cdp, clickExactButton("Mixed demo"), "enabled Mixed demo control");
  await poll(
    cdp,
    "Boolean(document.querySelector('[data-workspace-component-type=\"timer\"] .workspace-timer') && [...document.querySelectorAll('.workspace-component-tree [role=treeitem]')].some((item) => item.textContent?.trim() === 'Work desk') && [...document.querySelectorAll('.workspace-component-tree [role=treeitem]')].some((item) => item.textContent?.trim() === 'Presenter'))",
    "mixed 3D desk, 3D presenter, and 2D timer",
  );
  const mixedUi = await cdp.evaluate(`({
    componentCount: document.querySelectorAll('.workspace-component-tree [role="treeitem"]').length,
    timerPlacement: document.querySelector('[data-workspace-component-type="timer"]')?.getAttribute('data-workspace-placement'),
    timerPhase: document.querySelector('.workspace-timer__phase')?.textContent?.trim(),
    timerReadout: document.querySelector('.workspace-timer__readout')?.textContent?.trim(),
    treeLabels: [...document.querySelectorAll('.workspace-component-tree [role=treeitem]')].map((item) => item.textContent?.trim()),
    revision: document.querySelector('.scene-stat')?.textContent,
  })`);
  if (mixedUi.componentCount !== 4 || mixedUi.timerPlacement !== "viewport" || mixedUi.timerPhase !== "idle" || mixedUi.timerReadout !== "05:00" || !mixedUi.revision?.includes("rev 2")) {
    throw new Error(`Mixed demo did not commit as one complete hybrid Workspace batch: ${JSON.stringify(mixedUi)}`);
  }
  await poll(cdp, clickExactButton("Components"), "enabled Component library control after creating a stage");
  const duplicateStageVisible = await cdp.evaluate(
    "[...document.querySelectorAll('.workspace-library button strong')].some((item) => item.textContent?.trim() === '3D Stage')",
  );
  if (duplicateStageVisible) throw new Error("The component library offered a duplicate 3D Stage.");
  if (!await cdp.evaluate(`(() => {
    const panel = document.querySelector('.workspace-tool-panel');
    if (!panel) return true;
    const button = panel.querySelector('.workspace-tool-panel__close');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`)) throw new Error("Component library could not be closed after the stage check.");
  await poll(cdp, "!document.querySelector('.workspace-tool-panel')", "closed component panel after the stage check");

  await poll(cdp, clickExactButton("Components"), "enabled Component library control for the video resize flow");
  if (!await cdp.evaluate(`(() => {
    const label = [...document.querySelectorAll('.workspace-library button strong')]
      .find((item) => item.textContent?.trim() === 'Video Player');
    const button = label?.closest('button');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`)) throw new Error("The normal component-library path could not create a video player.");
  await poll(
    cdp,
    "Boolean(document.querySelector('[data-workspace-component-type=\"video-player\"] .workspace-video-player') && document.querySelector('.workspace-inspector__resize') && !document.querySelector('.workspace-tool-panel')?.matches('[inert], [aria-disabled=\"true\"]'))",
    "new video player and its resize Inspector",
  );
  if (!await cdp.evaluate(`(() => {
    const button = document.querySelector('.workspace-tool-panel__close');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`)) throw new Error("The video Inspector could not be closed before the real pointer activation check.");
  await poll(cdp, "!document.querySelector('.workspace-tool-panel')", "closed video Inspector before activation");
  if (!await clickVisibleButtonWithPointer(cdp, "Load YouTube player demo")) {
    throw new Error("The video player activation facade was unavailable.");
  }
  await poll(
    cdp,
    "Boolean(document.querySelector('[data-workspace-component-type=\"video-player\"] iframe[title=\"YouTube player demo\"]'))",
    "active embedded video player",
  );
  await cdp.evaluate(`(() => {
    window.__workspaceSmokeActiveVideoFrame = document.querySelector('[data-workspace-component-type="video-player"] iframe');
    window.__workspaceSmokeActiveVideoSrc = window.__workspaceSmokeActiveVideoFrame?.src;
  })()`);
  await poll(cdp, clickExactButton("Inspector"), "enabled video Inspector control after activation");
  await poll(cdp, "Boolean(document.querySelector('.workspace-inspector__resize'))", "reopened video resize Inspector");

  const beforeVideoResizeText = await captureWorkspaceProject(cdp, "video-resize-before");
  if (!await cdp.evaluate(setInspectorNumber("Width", 640))) {
    throw new Error("The video player's exact Width field was unavailable.");
  }
  await poll(
    cdp,
    "[...document.querySelectorAll('.workspace-inspector__dimension-grid label')].find((label) => label.querySelector('span')?.textContent?.trim() === 'Height')?.querySelector('input')?.value === '408'",
    "aspect-locked video height",
  );
  if (!await cdp.evaluate(clickExactButton("Apply size"))) throw new Error("The video resize could not be applied.");
  await poll(
    cdp,
    "document.querySelector('.scene-stat')?.textContent?.includes('rev 4') && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.width === '640px' && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.height === '408px'",
    "one committed video resize",
  );
  const afterVideoResizeText = await captureWorkspaceProject(cdp, "video-resize-after");
  const videoResize = assertOneResizeCommand(
    beforeVideoResizeText,
    afterVideoResizeText,
    "video-player",
    { kind: "box2d", size: { width: 640, height: 408 } },
  );
  if (videoResize.component.placement?.size?.width !== 640 || videoResize.component.placement?.size?.height !== 408) {
    throw new Error("The video resize command did not update its durable placement size.");
  }
  if (!await cdp.evaluate("window.__workspaceSmokeActiveVideoFrame === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe')")) {
    throw new Error("Applying a video resize replaced or unloaded its active iframe.");
  }

  if (!await cdp.evaluate(clickButtonWithAriaLabel("Undo last change"))) throw new Error("Resize undo was unavailable.");
  await poll(
    cdp,
    "document.querySelector('.scene-stat')?.textContent?.includes('rev 3') && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.width === '480px' && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.height === '306px'",
    "video resize undo",
  );
  const undoneVideoResizeText = await captureWorkspaceProject(cdp, "video-resize-undone");
  const undoneVideoResize = JSON.parse(undoneVideoResizeText);
  if (undoneVideoResize.workspace.revision !== videoResize.before.workspace.revision
    || undoneVideoResize.commandHistory.length !== videoResize.before.commandHistory.length
    || undoneVideoResize.workspace.history.length !== videoResize.before.workspace.history.length) {
    throw new Error("Undo did not restore the pre-resize revision and history exactly.");
  }
  if (!await cdp.evaluate("window.__workspaceSmokeActiveVideoFrame === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe')")) {
    throw new Error("Undoing a video resize replaced or unloaded its active iframe.");
  }
  if (!await cdp.evaluate(clickButtonWithAriaLabel("Redo last change"))) throw new Error("Resize redo was unavailable.");
  await poll(
    cdp,
    "document.querySelector('.scene-stat')?.textContent?.includes('rev 4') && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.width === '640px' && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.height === '408px'",
    "video resize redo",
  );
  const redoneVideoResizeText = await captureWorkspaceProject(cdp, "video-resize-redone");
  const redoneVideoResize = JSON.parse(redoneVideoResizeText);
  if (redoneVideoResize.workspace.revision !== videoResize.after.workspace.revision
    || redoneVideoResize.commandHistory.length !== videoResize.after.commandHistory.length
    || redoneVideoResize.workspace.history.length !== videoResize.after.workspace.history.length
    || redoneVideoResize.commandHistory.at(-1)?.resolvedOperations?.[0]?.op !== "resize_component") {
    throw new Error("Redo did not restore exactly one canonical video resize command.");
  }
  if (!await cdp.evaluate("window.__workspaceSmokeActiveVideoFrame === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe')")) {
    throw new Error("Redoing a video resize replaced or unloaded its active iframe.");
  }

  if (!await cdp.evaluate(setInspectorEffect("Object opacity", 0.72))
    || !await cdp.evaluate(setInspectorEffect("Emission color", "#ff7722"))
    || !await cdp.evaluate(setInspectorEffect("Emission", 2.4))
    || !await cdp.evaluate(setInspectorEffect("Glow color", "#55ddff"))
    || !await cdp.evaluate(setInspectorEffect("Glow", 1.5))
    || !await cdp.evaluate(setInspectorEffect("Spread", 0.65))) {
    throw new Error("The universal visual-effects Inspector fields were unavailable.");
  }
  if (!await cdp.evaluate(clickExactButton("Apply effects"))) {
    throw new Error("The video visual effects could not be applied.");
  }
  await poll(
    cdp,
    `(() => {
      const component = document.querySelector('[data-workspace-component-type="video-player"]');
      return document.querySelector('.scene-stat')?.textContent?.includes('rev 5')
        && component?.style.opacity === '0.72'
        && component?.style.boxShadow.includes('85, 221, 255');
    })()`,
    "one committed video visual-effects update",
  );
  const afterVisualEffectsText = await captureWorkspaceProject(cdp, "video-effects-after");
  const beforeVisualEffects = JSON.parse(redoneVideoResizeText);
  const afterVisualEffects = JSON.parse(afterVisualEffectsText);
  const effectCommand = afterVisualEffects.commandHistory.at(-1);
  if (afterVisualEffects.workspace.revision !== beforeVisualEffects.workspace.revision + 1
    || afterVisualEffects.commandHistory.length !== beforeVisualEffects.commandHistory.length + 1
    || afterVisualEffects.workspace.history.length !== beforeVisualEffects.workspace.history.length + 1
    || effectCommand?.resolvedOperations?.length !== 1
    || effectCommand.resolvedOperations[0]?.op !== "set_component_visual_effects") {
    throw new Error("Visual effects were not recorded as one canonical command, revision, and history entry.");
  }
  if (!await cdp.evaluate("window.__workspaceSmokeActiveVideoFrame === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe')")) {
    throw new Error("Applying visual effects replaced or unloaded the active video iframe.");
  }
  if (!await cdp.evaluate(clickButtonWithAriaLabel("Undo last change"))) throw new Error("Visual-effects undo was unavailable.");
  await poll(
    cdp,
    "document.querySelector('.scene-stat')?.textContent?.includes('rev 4') && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.opacity === '1'",
    "visual-effects undo",
  );
  if (!await cdp.evaluate("window.__workspaceSmokeActiveVideoFrame === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe')")) {
    throw new Error("Undoing visual effects replaced or unloaded the active video iframe.");
  }
  if (!await cdp.evaluate(clickButtonWithAriaLabel("Redo last change"))) throw new Error("Visual-effects redo was unavailable.");
  await poll(
    cdp,
    "document.querySelector('.scene-stat')?.textContent?.includes('rev 5') && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.opacity === '0.72'",
    "visual-effects redo",
  );
  if (!await cdp.evaluate("window.__workspaceSmokeActiveVideoFrame === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe')")) {
    throw new Error("Redoing visual effects replaced or unloaded the active video iframe.");
  }
  const redoneVisualEffectsText = await captureWorkspaceProject(cdp, "video-effects-redone");

  const navigationBefore = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.hybrid-workspace-canvas');
    const video = document.querySelector('[data-workspace-component-type="video-player"]');
    return {
      cameraDistance: Number(canvas?.dataset.cameraDistance),
      canvasZoom: Number(canvas?.dataset.canvasZoom),
      videoWidth: video?.style.width,
      videoHeight: video?.style.height,
    };
  })()`);
  if (!(navigationBefore.cameraDistance > 1) || navigationBefore.canvasZoom !== 1) {
    throw new Error(`Infinite-navigation telemetry was not ready: ${JSON.stringify(navigationBefore)}.`);
  }
  const wheelPoint = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.workspace-three-layer canvas');
    const rect = canvas?.getBoundingClientRect();
    if (!(canvas instanceof HTMLCanvasElement) || !rect) return null;
    for (let row = 1; row < 10; row += 1) {
      for (let column = 1; column < 10; column += 1) {
        const x = rect.left + rect.width * (column / 10);
        const y = rect.top + rect.height * (row / 10);
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
    }
    return null;
  })()`);
  if (!wheelPoint) throw new Error("The WebGL background was unavailable for pointer-centered zoom.");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: wheelPoint.x,
    y: wheelPoint.y,
    deltaX: 0,
    deltaY: -120,
  });
  await poll(
    cdp,
    `${JSON.stringify(navigationBefore.cameraDistance)} > Number(document.querySelector('.hybrid-workspace-canvas')?.dataset.cameraDistance) && Number(document.querySelector('.hybrid-workspace-canvas')?.dataset.canvasZoom) > 1`,
    "pointer-centered hybrid wheel zoom",
  );
  if (!await cdp.evaluate(clickButtonWithAriaLabel("Reset view"))) throw new Error("Reset view was unavailable after wheel zoom.");
  await poll(cdp, "Number(document.querySelector('.hybrid-workspace-canvas')?.dataset.canvasZoom) === 1", "hybrid Reset view recovery");
  await delay(400);
  if (!await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Zoom in"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    for (let index = 0; index < 40; index += 1) button.click();
    return true;
  })()`)) throw new Error("The accessible hybrid Zoom in control was unavailable.");
  await poll(
    cdp,
    "Number(document.querySelector('.hybrid-workspace-canvas')?.dataset.canvasZoom) > 1000 && Number(document.querySelector('.hybrid-workspace-canvas')?.dataset.cameraDistance) < 0.05",
    "microscopic hybrid zoom",
  );
  if (!await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Zoom out"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    for (let index = 0; index < 100; index += 1) button.click();
    return true;
  })()`)) throw new Error("The accessible hybrid Zoom out control was unavailable.");
  await poll(
    cdp,
    `(() => {
      const canvas = document.querySelector('.hybrid-workspace-canvas');
      const distance = Number(canvas?.dataset.cameraDistance);
      const near = Number(canvas?.dataset.cameraNear);
      const far = Number(canvas?.dataset.cameraFar);
      return Number(canvas?.dataset.canvasZoom) === 0.0001
        && distance > 100000
        && near > 0
        && far > distance;
    })()`,
    "planetary hybrid zoom with adaptive clipping",
  );
  const distantNavigation = await cdp.evaluate(`(() => {
    const video = document.querySelector('[data-workspace-component-type="video-player"]');
    return {
      videoWidth: video?.style.width,
      videoHeight: video?.style.height,
      sameIframe: window.__workspaceSmokeActiveVideoFrame === video?.querySelector('iframe'),
    };
  })()`);
  if (distantNavigation.videoWidth !== navigationBefore.videoWidth
    || distantNavigation.videoHeight !== navigationBefore.videoHeight
    || !distantNavigation.sameIframe) {
    throw new Error(`Screen-fixed video changed during extreme navigation: ${JSON.stringify(distantNavigation)}.`);
  }
  if (!await cdp.evaluate(clickButtonWithAriaLabel("Frame all"))) throw new Error("Frame all recovery was unavailable after distant zoom.");
  await poll(
    cdp,
    "Number(document.querySelector('.hybrid-workspace-canvas')?.dataset.cameraDistance) < 100 && Number(document.querySelector('.hybrid-workspace-canvas')?.dataset.canvasZoom) === 1",
    "Frame all recovery from planetary zoom",
  );
  const afterNavigationText = await captureWorkspaceProject(cdp, "infinite-navigation-after");
  assertFullscreenPreservedWorkspace(redoneVisualEffectsText, afterNavigationText, "Effectively infinite camera navigation");

  await cdp.evaluate(`(() => {
    const shell = document.querySelector('.viewport-shell');
    if (!(shell instanceof HTMLElement)) return false;
    Object.defineProperty(shell, 'requestFullscreen', { configurable: true, value: undefined });
    Object.defineProperty(shell, 'webkitRequestFullscreen', { configurable: true, value: undefined });
    return true;
  })()`);
  if (!await cdp.evaluate(clickButtonWithAriaLabel("Enter full screen"))) {
    throw new Error("The scene full-screen control was unavailable.");
  }
  await poll(
    cdp,
    "document.querySelector('.viewport-shell')?.dataset.fullscreenMode !== 'off'",
    "desktop scene full-screen entry",
  );
  await delay(100);
  const fullscreenUi = await cdp.evaluate(`(() => {
    const shell = document.querySelector('.viewport-shell');
    const canvas = document.querySelector('.hybrid-workspace-canvas');
    const videoFrame = document.querySelector('[data-workspace-component-type="video-player"] iframe');
    const exit = document.querySelector('button[aria-label="Exit full screen"]');
    const rect = shell?.getBoundingClientRect();
    const visible = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const sceneOwnsPoint = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(shell && hit && shell.contains(hit));
    };
    return {
      mode: shell?.dataset.fullscreenMode,
      immersive: shell?.classList.contains('is-immersive'),
      fillsViewport: Boolean(rect && rect.left <= 1 && rect.top <= 1 && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1),
      sceneVisible: Boolean(canvas && visible('.hybrid-workspace-canvas')),
      workspaceDockVisible: visible('.workspace-tool-dock'),
      inspectorVisible: visible('.workspace-tool-panel'),
      statusVisible: visible('.viewport-topline'),
      frameControlVisible: visible('button[aria-label="Frame all"]'),
      exitVisible: Boolean(exit && visible('button[aria-label="Exit full screen"]')),
      sceneOccludesAppChrome: sceneOwnsPoint(4, 4) && sceneOwnsPoint(Math.max(4, innerWidth - 4), 4),
      videoIdentityPreserved: videoFrame === window.__workspaceSmokeActiveVideoFrame,
      videoSourcePreserved: videoFrame?.src === window.__workspaceSmokeActiveVideoSrc,
    };
  })()`);
  if (fullscreenUi.mode !== 'fallback'
    || !fullscreenUi.immersive
    || !fullscreenUi.fillsViewport
    || !fullscreenUi.sceneVisible
    || fullscreenUi.workspaceDockVisible
    || fullscreenUi.inspectorVisible
    || fullscreenUi.statusVisible
    || fullscreenUi.frameControlVisible
    || !fullscreenUi.exitVisible
    || !fullscreenUi.sceneOccludesAppChrome
    || !fullscreenUi.videoIdentityPreserved
    || !fullscreenUi.videoSourcePreserved) {
    throw new Error(`Desktop full screen was not a scene-only, media-preserving view: ${JSON.stringify(fullscreenUi)}`);
  }
  mkdirSync(artifacts, { recursive: true });
  const fullscreenScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(artifacts, "workspace-smoke-fullscreen.png"), Buffer.from(fullscreenScreenshot.data, "base64"));

  if (!await cdp.evaluate(clickButtonWithAriaLabel("Exit full screen"))) {
    throw new Error("The explicit full-screen exit control was unavailable.");
  }
  await poll(cdp, "document.querySelector('.viewport-shell')?.dataset.fullscreenMode === 'off'", "explicit desktop full-screen exit");
  if (!await cdp.evaluate("window.__workspaceSmokeActiveVideoFrame === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe') && window.__workspaceSmokeActiveVideoSrc === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe')?.src")) {
    throw new Error("Exiting scene full screen explicitly replaced or reloaded the active video iframe.");
  }

  if (!await cdp.evaluate(clickButtonWithAriaLabel("Enter full screen"))) {
    throw new Error("The scene full-screen control was unavailable for the Escape flow.");
  }
  await poll(cdp, "document.querySelector('.viewport-shell')?.dataset.fullscreenMode !== 'off'", "second desktop scene full-screen entry");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await poll(cdp, "document.querySelector('.viewport-shell')?.dataset.fullscreenMode === 'off'", "Escape desktop full-screen exit");
  if (!await cdp.evaluate("window.__workspaceSmokeActiveVideoFrame === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe') && window.__workspaceSmokeActiveVideoSrc === document.querySelector('[data-workspace-component-type=\"video-player\"] iframe')?.src")) {
    throw new Error("Escaping scene full screen replaced or reloaded the active video iframe.");
  }
  const afterFullscreenText = await captureWorkspaceProject(cdp, "fullscreen-after");
  assertFullscreenPreservedWorkspace(afterNavigationText, afterFullscreenText, "Entering and exiting scene full screen");

  if (!await cdp.evaluate(clickExactButton("Models"))) throw new Error("The Models panel was unavailable for 3D selection.");
  await poll(cdp, "Boolean(document.querySelector('.workspace-model-hierarchy'))", "visible 3D hierarchy");
  if (!await cdp.evaluate(clickHierarchyItem("3D Stage"))) throw new Error("The 3D Stage could not be selected from the visible hierarchy.");
  if (!await cdp.evaluate(clickExactButton("Inspector"))) throw new Error("The 3D Stage Inspector could not be opened.");
  await poll(cdp, "document.querySelector('.workspace-inspector')?.getAttribute('aria-label') === 'Inspector for 3D Stage'", "3D Stage Inspector");
  if (!await cdp.evaluate(setInspectorNumber("Width", 16))) throw new Error("The stage Width field was unavailable.");
  if (!await cdp.evaluate(clickExactButton("Apply size"))) throw new Error("The stage dimensions could not be applied.");
  await poll(cdp, "document.querySelector('.scene-stat')?.textContent?.includes('rev 6')", "stage-dimension resize revision");

  if (!await cdp.evaluate(clickExactButton("Models"))) throw new Error("The Models panel was unavailable for desk selection.");
  await poll(cdp, "Boolean(document.querySelector('.workspace-model-hierarchy'))", "visible 3D hierarchy for desk selection");
  if (!await cdp.evaluate(clickHierarchyItem("Work desk"))) throw new Error("The Work desk could not be selected from the visible hierarchy.");
  if (!await cdp.evaluate(clickExactButton("Inspector"))) throw new Error("The Work desk Inspector could not be opened.");
  await poll(cdp, "document.querySelector('.workspace-inspector')?.getAttribute('aria-label') === 'Inspector for Work desk'", "3D desk Inspector");
  if (!await cdp.evaluate(setInspectorNumber("X", 1.5))
    || !await cdp.evaluate(setInspectorNumber("Y", 0.75))
    || !await cdp.evaluate(setInspectorNumber("Z", 2))) {
    throw new Error("The 3D scale fields were not all available.");
  }
  if (!await cdp.evaluate(clickExactButton("Apply size"))) throw new Error("The 3D scale could not be applied.");
  await poll(cdp, "document.querySelector('.scene-stat')?.textContent?.includes('rev 7')", "3D scale resize revision");

  if (!await cdp.evaluate(setInspectorEffect("Object opacity", 0.9))
    || !await cdp.evaluate(setInspectorEffect("Emission color", "#ff3311"))
    || !await cdp.evaluate(setInspectorEffect("Emission", 1.8))
    || !await cdp.evaluate(setInspectorEffect("Glow color", "#ffaa00"))
    || !await cdp.evaluate(setInspectorEffect("Glow", 2.2))
    || !await cdp.evaluate(setInspectorEffect("Spread", 0.4))) {
    throw new Error("The 3D desk visual-effects fields were unavailable.");
  }
  if (!await cdp.evaluate(clickExactButton("Apply effects"))) throw new Error("The 3D desk visual effects could not be applied.");
  await poll(cdp, "document.querySelector('.scene-stat')?.textContent?.includes('rev 8')", "3D desk visual-effects revision");

  if (!await cdp.evaluate(`(() => {
    const button = document.querySelector('.workspace-timer button[aria-label="Start timer"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`)) throw new Error("The presentation timer could not be started.");
  await poll(cdp, "Boolean(document.querySelector('.workspace-timer.is-running button[aria-label=\"Pause timer\"]'))", "running timer state");
  await poll(
    cdp,
    "document.querySelector('.workspace-timer__phase')?.textContent?.trim() === 'running' && document.querySelector('.scene-stat')?.textContent?.includes('rev 9')",
    "durable running timer revision",
  );
  await poll(
    cdp,
    "(() => { const text = document.querySelector('.workspace-timer__readout')?.textContent?.trim() ?? ''; return /^\\d{2}:\\d{2}$/.test(text) && text !== '05:00'; })()",
    "live timer countdown",
    5_000,
  );
  const runningUi = await cdp.evaluate(`({
    phase: document.querySelector('.workspace-timer__phase')?.textContent?.trim(),
    readout: document.querySelector('.workspace-timer__readout')?.textContent?.trim(),
    revision: document.querySelector('.scene-stat')?.textContent,
  })`);
  if (runningUi.phase !== "running" || !/^\d{2}:\d{2}$/u.test(runningUi.readout ?? "") || !runningUi.revision?.includes("rev 9")) {
    throw new Error(`Timer action did not produce one durable semantic revision and a live projection: ${JSON.stringify(runningUi)}`);
  }

  const savedProjectText = await captureWorkspaceProject(cdp, "final-resized-workspace");
  assertWorkspaceProject(savedProjectText);

  await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled mixed-workspace notices", 10_000);
  mkdirSync(artifacts, { recursive: true });
  const mixedScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(artifacts, "workspace-smoke-mixed.png"), Buffer.from(mixedScreenshot.data, "base64"));

  let projectActionDiagnostics;
  const projectActionDeadline = Date.now() + 12_000;
  while (Date.now() < projectActionDeadline) {
    projectActionDiagnostics = await cdp.evaluate(`({
      topLevel: window === window.top,
      href: location.href,
      readyState: document.readyState,
      projectBarPresent: Boolean(document.querySelector('.project-bar')),
      buttonCount: document.querySelectorAll('button').length,
      controls: [...document.querySelectorAll('button')]
        .map((button) => button.getAttribute('aria-controls'))
        .filter(Boolean),
    })`);
    if (projectActionDiagnostics.controls.includes('project-actions-menu')) break;
    await delay(100);
  }
  if (!projectActionDiagnostics?.controls.includes('project-actions-menu')) {
    throw new Error(`Project actions button did not become available after save: ${JSON.stringify(projectActionDiagnostics)}`);
  }
  if (!await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.getAttribute('aria-controls') === 'project-actions-menu');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`)) throw new Error("Project actions menu was unavailable.");
  await poll(cdp, "Boolean(document.querySelector('[role=menu]'))", "project actions menu");
  if (!await cdp.evaluate(clickExactButton("New project"))) throw new Error("New project action was unavailable.");
  await poll(cdp, "document.querySelector('[role=alertdialog] #confirm-title')?.textContent?.includes('Start a new project')", "new-project confirmation");
  if (!await cdp.evaluate(clickExactButton("Start new"))) throw new Error("New project confirmation was unavailable.");
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "new-project Agent connection gate");
  const newProjectAgentClient = await unlockWorkspaceThroughAgent(cdp, "Workspace browser smoke after new project");
  if (newProjectAgentClient) workspaceAgentClients.push(newProjectAgentClient);
  await poll(
    cdp,
    "!document.querySelector('.workspace-timer') && !document.querySelector('[data-workspace-component-type=\"video-player\"]') && !document.querySelector('[data-workspace-component-type=\"stage-3d\"]') && !document.querySelector('iframe') && document.querySelectorAll('.workspace-component-tree [role=treeitem]').length === 0",
    "fresh blank universal workspace",
  );
  const resetRecoveryStorage = await readWorkspaceRecoveryStorage(cdp);
  if (resetRecoveryStorage.slots.length !== 0 || resetRecoveryStorage.fallbackPresent || resetRecoveryStorage.legacyPresent) {
    throw new Error(`New project did not clear every recovery store: ${JSON.stringify(resetRecoveryStorage)}`);
  }

  const injected = await cdp.evaluate(`(() => {
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(savedProjectText)}], 'workspace-mixed-smoke.semaframe.json', { type: 'application/json' }));
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!injected) throw new Error("The saved Workspace project could not be supplied to the Open control.");
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "opened-project Agent connection gate");
  const reopenedProjectAgentClient = await unlockWorkspaceThroughAgent(cdp, "Workspace browser smoke after open project");
  if (reopenedProjectAgentClient) workspaceAgentClients.push(reopenedProjectAgentClient);
  await poll(
    cdp,
    "Boolean(document.querySelector('.workspace-timer.is-running') && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.width === '640px' && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.height === '408px' && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.opacity === '0.72' && document.querySelector('[data-workspace-component-type=\"video-player\"]')?.style.boxShadow.includes('85, 221, 255') && [...document.querySelectorAll('.workspace-component-tree [role=treeitem]')].some((item) => item.textContent?.trim() === 'Work desk') && [...document.querySelectorAll('.workspace-component-tree [role=treeitem]')].some((item) => item.textContent?.trim() === 'Presenter'))",
    "reopened resized mixed Workspace project",
  );
  const reopenedUi = await cdp.evaluate(`({
    projectName: document.querySelector('input[aria-label="Project name"]')?.value,
    componentCount: document.querySelectorAll('.workspace-component-tree [role="treeitem"]').length,
    timerPhase: document.querySelector('.workspace-timer__phase')?.textContent?.trim(),
    toast: document.querySelector('.toast-stack')?.textContent,
  })`);
  if (reopenedUi.projectName !== "workspace-mixed-smoke" || reopenedUi.componentCount !== 5 || reopenedUi.timerPhase !== "running" || !reopenedUi.toast?.includes("Workspace opened from its validated resolved history")) {
    throw new Error(`Open did not faithfully restore the Workspace project: ${JSON.stringify(reopenedUi)}`);
  }
  await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled project-open notice", 10_000);

  if (!await cdp.evaluate(clickExactButton("Manage"))) throw new Error("Agent management was unavailable from the Workspace.");
  await poll(
    cdp,
    "Boolean(document.querySelector('.agent-connection-page.status-connected .agent-connection-url-wrap input'))",
    "connected Agent management page",
  );
  const agentUi = await cdp.evaluate(`({
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    panelLabel: document.querySelector('.app-workspace')?.getAttribute('aria-label'),
    connectionUrl: document.querySelector('.agent-connection-url-wrap input')?.value,
    connectionPageText: document.querySelector('.agent-connection-page')?.textContent,
    hasComposer: Boolean(document.querySelector('textarea[aria-label="Describe what happens next"]')),
    hasViewport: Boolean(document.querySelector('.hybrid-workspace-canvas')),
    timerVisible: Boolean(document.querySelector('.workspace-timer')),
  })`);
  if (agentUi.hasLegacyModeSwitch || agentUi.panelLabel !== "Workspace" || !/^http:\/\/127\.0\.0\.1:\d+\/mcp\/connect\/[A-Za-z0-9_-]{24,}$/u.test(agentUi.connectionUrl ?? "") || !agentUi.connectionPageText?.includes("Manage this connection") || agentUi.hasComposer || !agentUi.hasViewport || !agentUi.timerVisible) {
    throw new Error(`Connected Agent management did not cover the same composer-free Workspace: ${JSON.stringify(agentUi)}`);
  }

  await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled Agent-mode notices", 10_000);
  const agentScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(artifacts, "workspace-smoke-agent.png"), Buffer.from(agentScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.evaluate("window.scrollTo({ top: 0, left: 0, behavior: 'instant' })");
  await delay(250);
  const mobileUi = await cdp.evaluate(`({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    connectionVisible: Boolean(document.querySelector('.agent-connection-page.status-connected')),
  })`);
  if (mobileUi.overflow || mobileUi.hasLegacyModeSwitch || !mobileUi.connectionVisible) {
    throw new Error(`Responsive Agent connection flow was not usable: ${JSON.stringify(mobileUi)}`);
  }
  const mobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(artifacts, "workspace-smoke-agent-mobile.png"), Buffer.from(mobileScreenshot.data, "base64"));

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (!await cdp.evaluate(clickExactButton("Back to workspace"))) throw new Error("Connected Agent management could not return to the Workspace.");
  await poll(cdp, "!document.querySelector('.agent-connection-page') && Boolean(document.querySelector('.workspace-timer'))", "connected Workspace return");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await delay(250);
  await cdp.evaluate(`(() => {
    const shell = document.querySelector('.viewport-shell');
    if (!(shell instanceof HTMLElement)) return false;
    Object.defineProperty(shell, 'requestFullscreen', { configurable: true, value: undefined });
    Object.defineProperty(shell, 'webkitRequestFullscreen', { configurable: true, value: undefined });
    return true;
  })()`);
  if (!await cdp.evaluate(clickButtonWithAriaLabel("Enter full screen"))) {
    throw new Error("The scene full-screen control was unavailable at the mobile breakpoint.");
  }
  await poll(cdp, "document.querySelector('.viewport-shell')?.dataset.fullscreenMode !== 'off'", "mobile scene full-screen entry");
  await delay(100);
  const mobileFullscreenUi = await cdp.evaluate(`(() => {
    const shell = document.querySelector('.viewport-shell');
    const exit = document.querySelector('button[aria-label="Exit full screen"]');
    const rect = shell?.getBoundingClientRect();
    const exitRect = exit?.getBoundingClientRect();
    const visible = (element) => element instanceof HTMLElement
      && getComputedStyle(element).display !== 'none'
      && getComputedStyle(element).visibility !== 'hidden'
      && element.getClientRects().length > 0;
    return {
      mode: shell?.dataset.fullscreenMode,
      fillsViewport: Boolean(rect && rect.left <= 1 && rect.top <= 1 && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1),
      sceneVisible: visible(document.querySelector('.hybrid-workspace-canvas')),
      dockVisible: visible(document.querySelector('.workspace-tool-dock')),
      inspectorVisible: visible(document.querySelector('.workspace-tool-panel')),
      exitVisible: visible(exit),
      exitInsideViewport: Boolean(exitRect && exitRect.left >= 0 && exitRect.top >= 0 && exitRect.right <= innerWidth && exitRect.bottom <= innerHeight),
      sceneOwnsCorners: [
        document.elementFromPoint(4, 4),
        document.elementFromPoint(Math.max(4, innerWidth - 4), 4),
        document.elementFromPoint(4, Math.max(4, innerHeight - 4)),
      ].every((hit) => Boolean(hit && shell?.contains(hit))),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  if (mobileFullscreenUi.mode !== 'fallback'
    || !mobileFullscreenUi.fillsViewport
    || !mobileFullscreenUi.sceneVisible
    || mobileFullscreenUi.dockVisible
    || mobileFullscreenUi.inspectorVisible
    || !mobileFullscreenUi.exitVisible
    || !mobileFullscreenUi.exitInsideViewport
    || !mobileFullscreenUi.sceneOwnsCorners
    || mobileFullscreenUi.horizontalOverflow) {
    throw new Error(`Mobile full screen was not a safe scene-only layout: ${JSON.stringify(mobileFullscreenUi)}`);
  }
  const mobileFullscreenScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(artifacts, "workspace-smoke-fullscreen-mobile.png"), Buffer.from(mobileFullscreenScreenshot.data, "base64"));
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await poll(cdp, "document.querySelector('.viewport-shell')?.dataset.fullscreenMode === 'off'", "mobile Escape full-screen exit");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Produce a second durable snapshot, corrupt only the newest IndexedDB head,
  // and prove a real reload can still recover the previous semantic project.
  if (!await cdp.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Project name"]');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'workspace-mixed-smoke-recovery-current');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)) throw new Error("Project name could not create the recovery smoke snapshot.");
  await poll(
    cdp,
    "document.querySelector('input[aria-label=\"Project name\"]')?.value === 'workspace-mixed-smoke-recovery-current'",
    "recovery project-name snapshot",
  );
  await waitForWorkspaceRecoverySlots(cdp, ["current", "previous"], "current and previous recovery snapshots");
  if (!await corruptCurrentWorkspaceRecovery(cdp)) throw new Error("The current recovery snapshot was unavailable for corruption testing.");

  await reloadWorkspaceApp(cdp, "Workspace reload with a corrupt current recovery");
  const recoveryReloadAgentClient = await unlockWorkspaceThroughAgent(cdp, "Workspace recovery reload");
  if (recoveryReloadAgentClient) workspaceAgentClients.push(recoveryReloadAgentClient);
  await poll(cdp, "Boolean(document.querySelector('.recovery-banner'))", "recovery banner after reload");
  if (!await cdp.evaluate(clickExactButton("Continue recovered project"))) {
    throw new Error("The recovery banner could not restore its last-known-good snapshot.");
  }
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page'))", "recovery project replacement gate");
  const restoredRecoveryAgentClient = await unlockWorkspaceThroughAgent(cdp, "Workspace after recovery restore");
  if (restoredRecoveryAgentClient) workspaceAgentClients.push(restoredRecoveryAgentClient);
  await poll(
    cdp,
    "document.querySelector('input[aria-label=\"Project name\"]')?.value === 'workspace-mixed-smoke' && document.querySelectorAll('.workspace-component-tree [role=treeitem]').length === 5 && document.querySelector('.toast-stack')?.textContent?.includes('last-known-good Workspace snapshot')",
    "last-known-good previous recovery restoration",
  );

  // The recovery remains available until the human dismisses it. A second
  // reload exercises the actual Dismiss button and verifies both stores clear.
  await reloadWorkspaceApp(cdp, "Workspace reload before recovery dismissal");
  const dismissRecoveryAgentClient = await unlockWorkspaceThroughAgent(cdp, "Workspace recovery dismissal");
  if (dismissRecoveryAgentClient) workspaceAgentClients.push(dismissRecoveryAgentClient);
  await poll(cdp, "Boolean(document.querySelector('.recovery-banner'))", "recovery banner before dismissal");
  if (!await cdp.evaluate(clickExactButton("Dismiss"))) throw new Error("Recovery dismissal was unavailable.");
  await poll(cdp, "!document.querySelector('.recovery-banner')", "dismissed recovery banner");
  const dismissedRecoveryStorage = await readWorkspaceRecoveryStorage(cdp);
  if (dismissedRecoveryStorage.slots.length !== 0 || dismissedRecoveryStorage.fallbackPresent || dismissedRecoveryStorage.legacyPresent) {
    throw new Error(`Dismiss did not clear every recovery store: ${JSON.stringify(dismissedRecoveryStorage)}`);
  }

  if (!await cdp.evaluate(clickExactButton("Manage"))) throw new Error("Final Agent management was unavailable.");
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-connected'))", "final connected Agent management");
  if (!await cdp.evaluate(clickExactButton("Disable agent control"))) throw new Error("Agent control could not be disabled.");
  await poll(
    cdp,
    "Boolean(document.querySelector('.agent-connection-page.status-disabled')) && Boolean(document.querySelector('.app-workspace[data-agent-workspace-active=\"false\"][inert][aria-hidden=\"true\"]'))",
    "final disabled Agent connection gate with mounted inert Workspace",
  );
  const finalGate = await cdp.evaluate(`({
    hasProjectBar: Boolean(document.querySelector('.project-bar')),
    workspaceMounted: Boolean(document.querySelector('.app-workspace')),
    workspaceActive: document.querySelector('.app-workspace')?.dataset.agentWorkspaceActive,
    workspaceInert: document.querySelector('.app-workspace')?.hasAttribute('inert'),
    workspaceAriaHidden: document.querySelector('.app-workspace')?.getAttribute('aria-hidden'),
    hasBackButton: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Back to workspace')),
  })`);
  if (finalGate.hasProjectBar || !finalGate.workspaceMounted || finalGate.workspaceActive !== "false" ||
      !finalGate.workspaceInert || finalGate.workspaceAriaHidden !== "true" || finalGate.hasBackButton) {
    throw new Error(`Disabled Agent control did not preserve an inert mounted Workspace: ${JSON.stringify(finalGate)}`);
  }

  if (problems.length) throw new Error(`Browser reported warnings/errors:\n${problems.join("\n")}`);
  console.log("Workspace browser smoke passed: exclusive pre-handshake Agent gate, authenticated Workspace unlock, unified hybrid canvas, one-batch 3D desk + presenter + 2D timer, normal-path active video creation, one-command aspect-locked resize, universal 2D halo and 3D emission/bloom effects, microscopic-to-planetary hybrid zoom with adaptive clipping and Frame recovery, screen-fixed iframe preservation and unchanged Workspace history, desktop/mobile full screen with native fallback, explicit/Escape exit, exact stage dimensions and 3D scale, semantic timer action/live projection, Protocol 1.3 universal save validation, gated blank reset/open round trip, corrupt-current reload fallback, verified recovery dismissal, connected Agent management, and responsive layout.");
  console.log(`Screenshots: ${join(artifacts, "workspace-smoke-mixed.png")}, ${join(artifacts, "workspace-smoke-fullscreen.png")}, ${join(artifacts, "workspace-smoke-fullscreen-mobile.png")}, ${join(artifacts, "workspace-smoke-agent.png")}, ${join(artifacts, "workspace-smoke-agent-mobile.png")}`);
} catch (error) {
  if (error === RECOVERY_SMOKE_COMPLETE) {
    // The focused mode exits through the shared resource cleanup below.
  } else {
  const safeLogs = processLogs.join("").replace(/[A-Za-z0-9_-]{40,}/gu, "[redacted]");
  if (safeLogs.trim()) console.error(safeLogs.slice(-5_000));
  throw error;
  }
} finally {
  await Promise.allSettled(workspaceAgentClients.map((client, index) => withTimeout(
    client.close(),
    5_000,
    `Workspace smoke Agent client ${index + 1} to close`,
  )));
  if (cdp) {
    await cdp.send("Browser.close", {}, 5_000).catch(() => undefined);
    cdp.close();
    const browserCloseDeadline = Date.now() + 5_000;
    while (!browserTree.closed && Date.now() < browserCloseDeadline) await delay(50);
  }
  await stopOwnedProcessTrees([browserTree, stackTree]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
