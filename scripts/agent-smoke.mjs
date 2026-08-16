import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const artifacts = resolve("artifacts");
const REDACTED_DIAGNOSTIC = "[redacted]";

function isSensitiveDiagnosticKey(key) {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return normalized === "guidedigest" ||
    normalized === "instructiondigest" ||
    normalized === "authorization" ||
    normalized === "bearer" ||
    normalized === "credential" ||
    normalized === "secret" ||
    /(?:approval|session|transaction|access|refresh|auth|pairing).*token/u.test(normalized) ||
    /(?:browser|pairing).*bearer/u.test(normalized);
}

export function redactAgentSmokeDiagnosticText(value, sensitiveValues = []) {
  let redacted = String(value ?? "");
  const knownSecrets = [...new Set(sensitiveValues)]
    .filter((secret) => typeof secret === "string" && secret.length >= 6)
    .sort((left, right) => right.length - left.length);

  redacted = redacted
    .replace(
      /((?:approval[_-]?token|session[_-]?token|transaction[_-]?token|guide[_-]?digest|instruction[_-]?digest|authorization|bearer)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+[A-Za-z0-9._~-]+|[^\s,;}\]]+)/giu,
      `$1${REDACTED_DIAGNOSTIC}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, `Bearer ${REDACTED_DIAGNOSTIC}`)
    .replace(/(\/mcp\/connect\/)[A-Za-z0-9_-]+/giu, `$1${REDACTED_DIAGNOSTIC}`);
  for (const secret of knownSecrets) redacted = redacted.split(secret).join(REDACTED_DIAGNOSTIC);
  return redacted.replace(/[A-Za-z0-9_-]{40,}/gu, REDACTED_DIAGNOSTIC);
}

export function redactAgentSmokeDiagnostic(value, sensitiveValues = [], seen = new WeakSet()) {
  if (typeof value === "string") return redactAgentSmokeDiagnosticText(value, sensitiveValues);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactAgentSmokeDiagnosticText(value.message, sensitiveValues),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAgentSmokeDiagnostic(item, sensitiveValues, seen));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveDiagnosticKey(key)
      ? REDACTED_DIAGNOSTIC
      : redactAgentSmokeDiagnostic(item, sensitiveValues, seen),
  ]));
}

export function stringifyAgentSmokeDiagnostic(value, sensitiveValues = []) {
  try {
    return JSON.stringify(redactAgentSmokeDiagnostic(value, sensitiveValues));
  } catch {
    return JSON.stringify("[unserializable diagnostic]");
  }
}

export function sanitizeAgentSmokeFailure(error, sensitiveValues = []) {
  const failureMessage = error instanceof Error
    ? error.message
    : stringifyAgentSmokeDiagnostic(error, sensitiveValues);
  return new Error(redactAgentSmokeDiagnosticText(failureMessage, sensitiveValues));
}

function browserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome/Chromium was not found. Set BROWSER_EXECUTABLE to run agent smoke.");
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

async function waitForJson(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response.json();
    } catch { /* process is starting */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch { /* process is starting */ }
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
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function openCdpPage(debugPort, url) {
  const target = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  ).then((response) => response.json());
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  return { cdp, target };
}

async function closeCdpPage(cdp) {
  // Page.close normally closes the DevTools socket before its reply arrives.
  // Bound the wait so a correct page teardown cannot stall the smoke runner.
  await Promise.race([
    cdp.send("Page.close").catch(() => undefined),
    delay(500),
  ]);
  cdp.close();
}

async function poll(cdp, expression, label, timeoutMs = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await cdp.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function clickButton(text) {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}));
    if (!button) return false;
    button.click();
    return true;
  })()`;
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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

async function captureSavedProject(cdp) {
  await cdp.evaluate(`(() => {
    window.__agentSmokeSavedProject = '';
    if (!window.__agentSmokeCaptureInstalled) {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (value) => {
        if (value instanceof Blob) void value.text().then((text) => { window.__agentSmokeSavedProject = text; });
        return createObjectURL(value);
      };
      window.__agentSmokeCaptureInstalled = true;
    }
    document.querySelector('button[aria-label="Save project"]')?.click();
    return true;
  })()`);
  await poll(cdp, "Boolean(window.__agentSmokeSavedProject)", "captured saved project");
  return cdp.evaluate("window.__agentSmokeSavedProject");
}

function agentPayload(result, toolName) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object" && typeof structured.ok === "boolean") return structured;
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
    } catch { /* reported below */ }
  }
  throw new Error(`MCP tool ${toolName} returned no SemaFrame payload.`);
}

async function callAgent(client, name, args) {
  return agentPayload(await client.callTool({ name, arguments: args }), name);
}

export async function runAgentSmoke() {
const sensitiveDiagnosticValues = new Set();
const rememberSensitiveDiagnostic = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.length >= 6) sensitiveDiagnosticValues.add(value);
  }
};
const diagnosticJson = (value) => stringifyAgentSmokeDiagnostic(value, sensitiveDiagnosticValues);
const diagnosticText = (value) => redactAgentSmokeDiagnosticText(value, sensitiveDiagnosticValues);

const gatewayPort = await freePort();
const vitePort = await freePort();
const cdpPort = await freePort();
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const appUrl = `http://127.0.0.1:${vitePort}/`;
const profile = mkdtempSync(join(tmpdir(), "semaframe-agent-smoke-"));
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
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const processLogs = [];
for (const child of [stack]) {
  child.stdout.on("data", (chunk) => processLogs.push(String(chunk)));
  child.stderr.on("data", (chunk) => processLogs.push(String(chunk)));
}

let cdp;
let mcpClient;
try {
  await waitForJson(`${gatewayUrl}/healthz`);
  await waitForHttp(`http://127.0.0.1:${vitePort}/`);
  await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`);
  const target = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" }).then((response) => response.json());
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  const problems = [];
  const agentNetwork = [];
  const instrumentBrowser = async (connection, tabLabel) => {
    connection.on("Runtime.exceptionThrown", ({ exceptionDetails }) => problems.push(`${tabLabel} exception: ${exceptionDetails.text}`));
    connection.on("Runtime.consoleAPICalled", ({ type, args }) => {
      const text = args.map((arg) => arg.value ?? arg.description).join(" ");
      if (["error", "warning"].includes(type) && !/GL Driver Message|software WebGL/i.test(text)) problems.push(`${tabLabel} ${type}: ${text}`);
    });
    connection.on("Network.requestWillBeSent", ({ requestId, request }) => {
      if (!request.url.includes("/api/agent/")) return;
      agentNetwork.push({ tabLabel, requestId, method: request.method, path: new URL(request.url).pathname });
    });
    connection.on("Network.responseReceived", ({ requestId, response }) => {
      const record = agentNetwork.find((entry) => entry.tabLabel === tabLabel && entry.requestId === requestId);
      if (record) Object.assign(record, { status: response.status, statusText: response.statusText });
    });
    await Promise.all([
      connection.send("Page.enable"),
      connection.send("Runtime.enable"),
      connection.send("Log.enable"),
      connection.send("Network.enable"),
    ]);
  };
  await instrumentBrowser(cdp, "primary tab");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: appUrl });
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled'))", "disabled Agent connection gate");

  const initialConnectionGate = await cdp.evaluate(`({
    connectionLabel: document.querySelector('.agent-connection-gate')?.getAttribute('aria-label'),
    hasWorkspace: Boolean(document.querySelector('.app-workspace')),
    hasProjectBar: Boolean(document.querySelector('.project-bar')),
    hasBackButton: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Back to workspace')),
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    hasLegacyAgentDialog: Boolean(document.querySelector('.agent-mode-dialog')),
  })`);
  if (initialConnectionGate.connectionLabel !== "Agent connection" || initialConnectionGate.hasWorkspace ||
      initialConnectionGate.hasProjectBar || initialConnectionGate.hasBackButton ||
      initialConnectionGate.hasLegacyModeSwitch || initialConnectionGate.hasLegacyAgentDialog) {
    throw new Error(`The app did not open behind the exclusive Agent connection gate: ${JSON.stringify(initialConnectionGate)}`);
  }
  if (!await cdp.evaluate(clickButton("Enable agent control"))) {
    const disabledState = await cdp.evaluate(`({
      page: document.querySelector('.agent-connection-page')?.innerText,
      buttons: [...document.querySelectorAll('.agent-connection-page button')].map((button) => ({ text: button.textContent?.trim(), disabled: button.disabled })),
    })`);
    throw new Error(`Agent control could not be enabled: ${JSON.stringify(disabledState)}`);
  }
  try {
    await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-waiting'))", "waiting Agent connection gate");
  } catch (error) {
    const state = await cdp.evaluate(`({ page: document.querySelector('.agent-connection-page')?.innerText, toast: document.querySelector('.toast-stack')?.innerText })`);
    throw new Error(`${error.message}. UI state: ${JSON.stringify(state)}. Agent network: ${JSON.stringify(agentNetwork)}`);
  }
  const preConnectionUi = await cdp.evaluate(`({
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    hasViewport: Boolean(document.querySelector('.viewport-canvas')),
    hasComposer: Boolean(document.querySelector('textarea[aria-label="Describe what happens next"]')),
    hasDialog: Boolean(document.querySelector('.agent-mode-dialog')),
    guidance: document.querySelector('.agent-copy-guidance')?.textContent,
    copyLabel: [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Copy connection URL'))?.textContent,
    connectionUrl: document.querySelector('.agent-connection-url-wrap input')?.value,
    expiresAt: document.querySelector('.agent-expiry time')?.dateTime,
  })`);
  if (preConnectionUi.hasLegacyModeSwitch || preConnectionUi.hasViewport || preConnectionUi.hasComposer || preConnectionUi.hasDialog) {
    throw new Error(`The waiting Agent connection gate exposed the Workspace before the handshake: ${JSON.stringify(preConnectionUi)}`);
  }
  if (!preConnectionUi.guidance?.includes("paste it into your agent") || !preConnectionUi.copyLabel) {
    throw new Error("Agent connection management did not clearly tell the user to copy and paste the URL into their agent.");
  }
  let connectionUrl = preConnectionUi.connectionUrl;
  const parsedConnectionUrl = new URL(connectionUrl);
  if (parsedConnectionUrl.origin !== gatewayUrl || !/^\/mcp\/connect\/[A-Za-z0-9_-]{24,}$/u.test(parsedConnectionUrl.pathname) || parsedConnectionUrl.search || parsedConnectionUrl.hash) {
    throw new Error(`The displayed connection URL was not the expected exact, query-free offer URL: ${connectionUrl}`);
  }
  const expiresAt = Date.parse(preConnectionUi.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 11 * 60_000) {
    throw new Error("The connection page did not expose a valid short-lived expiry.");
  }

  const connectionResponse = await fetch(connectionUrl, { headers: { accept: "application/json" }, cache: "no-store" });
  const connectionDocument = await connectionResponse.json();
  if (!connectionResponse.ok || connectionDocument.mcpEndpoint !== connectionUrl || connectionDocument.transport !== "streamable-http" || connectionDocument.offer?.urlIsAuthorization !== false) {
    throw new Error("The copied address did not resolve to its non-authorizing Streamable HTTP MCP connection document.");
  }
  if (!connectionDocument.instructions?.instructions || !connectionDocument.instructions?.workspace_command_schema ||
      "legacySceneInstructions" in connectionDocument ||
      !connectionDocument.handshake?.some((line) => line.includes("get_workspace_instructions")) ||
      JSON.stringify(connectionDocument).includes("get_scene_instructions")) {
    throw new Error("The connection document did not expose an exclusive Workspace workflow.");
  }
  if (/bearer|token=/iu.test(parsedConnectionUrl.search) || /authorization|bearer/iu.test(connectionUrl)) {
    throw new Error("The connection URL contained authorization material.");
  }

  // A failed client setup must have a direct recovery path that replaces the
  // offer instead of merely re-reading and redisplaying the same URL.
  const replacedConnectionUrl = connectionUrl;
  if (!await cdp.evaluate(clickButton("Create fresh URL"))) {
    throw new Error("The waiting Agent page did not offer a fresh connection URL action.");
  }
  await poll(
    cdp,
    `document.querySelector('.agent-connection-url-wrap input')?.value !== ${JSON.stringify(replacedConnectionUrl)}`,
    "fresh Agent connection URL",
  );
  connectionUrl = await cdp.evaluate("document.querySelector('.agent-connection-url-wrap input')?.value");
  const refreshedConnectionUrl = new URL(connectionUrl);
  if (refreshedConnectionUrl.origin !== gatewayUrl || !/^\/mcp\/connect\/[A-Za-z0-9_-]{24,}$/u.test(refreshedConnectionUrl.pathname)) {
    throw new Error(`The replacement Agent connection URL was invalid: ${connectionUrl}`);
  }
  if ((await fetch(replacedConnectionUrl, { cache: "no-store" })).status !== 404) {
    throw new Error("Creating a fresh Agent connection URL did not invalidate the previous offer.");
  }
  if (!(await fetch(connectionUrl, { cache: "no-store" })).ok) {
    throw new Error("The fresh Agent connection URL was not usable.");
  }

  // An active browser lease is deliberate single-writer protection. A second
  // tab must remain behind the occupied connection gate rather than exposing
  // the Workspace or waiting for the 65-second TTL.
  const occupiedPage = await openCdpPage(cdpPort, "about:blank");
  const occupiedCdp = occupiedPage.cdp;
  await instrumentBrowser(occupiedCdp, "occupied tab");
  await occupiedCdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await occupiedCdp.send("Page.navigate", { url: appUrl });
  try {
    await poll(occupiedCdp, "Boolean(document.querySelector('.agent-connection-page.status-occupied'))", "active-tab connection gate conflict", 6_000);
  } catch (error) {
    const occupiedState = await occupiedCdp.evaluate(`({
      pageClass: document.querySelector('.agent-connection-page')?.className,
      page: document.querySelector('.agent-connection-page')?.innerText,
      controls: document.querySelector('.agent-workspace-controls')?.innerText,
    })`);
    throw new Error(`${error.message}: ${JSON.stringify(occupiedState)}`);
  }
  const occupiedUi = await occupiedCdp.evaluate(`({
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    heading: document.querySelector('.agent-connection-page.status-occupied h1')?.textContent,
    hasComposer: Boolean(document.querySelector('textarea[aria-label="Describe what happens next"]')),
    hasTakeover: [...document.querySelectorAll('button')].some((item) => item.textContent?.includes('Move control to this tab')),
  })`);
  if (occupiedUi.hasLegacyModeSwitch || !occupiedUi.heading?.includes("Another tab owns Agent control") || occupiedUi.hasComposer || !occupiedUi.hasTakeover) {
    throw new Error(`A genuinely concurrent tab did not stay in a usable Agent conflict state: ${JSON.stringify(occupiedUi)}`);
  }
  await delay(500);
  const stableOccupiedMode = await occupiedCdp.evaluate(`({
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    occupied: Boolean(document.querySelector('.agent-connection-page.status-occupied')),
    hasComposer: Boolean(document.querySelector('textarea[aria-label="Describe what happens next"]')),
  })`);
  if (stableOccupiedMode.hasLegacyModeSwitch || !stableOccupiedMode.occupied || stableOccupiedMode.hasComposer) {
    throw new Error(`The concurrent tab left its Agent conflict surface: ${JSON.stringify(stableOccupiedMode)}`);
  }

  if (!await occupiedCdp.evaluate(clickButton("Move control to this tab"))) {
    throw new Error("The explicit browser takeover action was unavailable.");
  }
  await poll(occupiedCdp, "Boolean(document.querySelector('.agent-takeover-confirmation'))", "takeover confirmation");
  if (!await occupiedCdp.evaluate(clickButton("Move control here"))) {
    throw new Error("The confirmed browser takeover action was unavailable.");
  }
  await poll(
    occupiedCdp,
    "Boolean(document.querySelector('.agent-connection-page.status-waiting')) && !document.querySelector('.app-workspace')",
    "successful browser takeover at the waiting connection gate",
    6_000,
  );
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disconnected'))", "old bridge invalidation after takeover", 6_000);
  const takeoverRequest = agentNetwork.find((entry) => entry.tabLabel === "occupied tab" && entry.path === "/api/agent/browser/takeover");
  if (!takeoverRequest || takeoverRequest.status !== 200) {
    throw new Error(`The confirmed takeover did not reach the browser lease endpoint: ${JSON.stringify(takeoverRequest)}`);
  }

  // Closing an already-replaced tab may send a late unregister. It must not
  // evict the newer lease.
  await closeCdpPage(cdp);
  await delay(250);
  if (!await occupiedCdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-waiting'))")) {
    throw new Error("Closing the replaced tab evicted the newer browser bridge.");
  }

  // Closing the active tab must release its lease immediately. A fresh tab
  // should connect in seconds, not after SEMAFRAME_AGENT_BROWSER_TTL_MS (65 seconds).
  const reopenStartedAt = Date.now();
  await closeCdpPage(occupiedCdp);
  const reopenedPage = await openCdpPage(cdpPort, "about:blank");
  cdp = reopenedPage.cdp;
  await instrumentBrowser(cdp, "reopened tab");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: appUrl });
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-waiting'))", "immediate Agent reconnect after tab close", 6_000);
  const reopenElapsedMs = Date.now() - reopenStartedAt;
  if (reopenElapsedMs >= 8_000) {
    throw new Error(`A closed browser lease took ${reopenElapsedMs}ms to reopen instead of releasing immediately.`);
  }
  const reopenedUi = await cdp.evaluate(`({
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    hasComposer: Boolean(document.querySelector('textarea[aria-label="Describe what happens next"]')),
    connectionUrl: document.querySelector('.agent-connection-url-wrap input')?.value,
  })`);
  if (reopenedUi.hasLegacyModeSwitch || reopenedUi.hasComposer || reopenedUi.connectionUrl !== connectionUrl) {
    throw new Error(`The fresh tab did not reclaim the same usable Agent session: ${JSON.stringify(reopenedUi)}`);
  }
  const bridgeReadyStartedAt = Date.now();
  while (Date.now() - bridgeReadyStartedAt < 6_000) {
    const registered = agentNetwork.some((entry) =>
      entry.tabLabel === "reopened tab" && entry.path === "/api/agent/browser/register" && entry.status === 200
    );
    const polling = agentNetwork.some((entry) =>
      entry.tabLabel === "reopened tab" && entry.path === "/api/agent/browser/poll"
    );
    if (registered && polling) break;
    await delay(50);
  }
  const reopenedRegistered = agentNetwork.some((entry) =>
    entry.tabLabel === "reopened tab" && entry.path === "/api/agent/browser/register" && entry.status === 200
  );
  const reopenedPolling = agentNetwork.some((entry) =>
    entry.tabLabel === "reopened tab" && entry.path === "/api/agent/browser/poll"
  );
  if (!reopenedRegistered || !reopenedPolling) {
    throw new Error(`The reopened tab rendered before its browser bridge was ready: ${JSON.stringify(agentNetwork.filter((entry) => entry.tabLabel === "reopened tab"))}`);
  }

  mcpClient = new Client(
    { name: "agent-smoke-controller", version: "1.0.0" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 3_000, maxRetries: 0 } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(connectionUrl));
  await mcpClient.connect(transport);
  const tools = await mcpClient.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  const expectedTools = [
    "get_workspace_instructions", "inspect_workspace", "inspect_workspace_component", "inspect_workspace_space", "query_spatial_placement", "inspect_workspace_physics", "query_stable_placement", "simulate_workspace_physics", "begin_workspace_update", "submit_workspace_batch",
    "undo_workspace_batch", "redo_workspace_batch", "read_workspace_events",
  ];
  for (const required of expectedTools) {
    if (!toolNames.has(required)) throw new Error(`Streamable HTTP MCP is missing ${required}.`);
  }
  if (toolNames.size !== expectedTools.length) {
    throw new Error(`Streamable HTTP MCP exposed unexpected tools: ${JSON.stringify([...toolNames].sort())}`);
  }
  if (!mcpClient.getInstructions()?.includes("get_workspace_instructions")) {
    throw new Error("MCP initialization did not instruct the agent to use the native Workspace guide first.");
  }
  const workspaceGuideResource = await mcpClient.readResource({ uri: "workspace://instructions/v1" });
  const workspaceGuideText = workspaceGuideResource.contents?.find((content) => "text" in content)?.text;
  let workspaceGuideDocument;
  try {
    workspaceGuideDocument = JSON.parse(workspaceGuideText ?? "");
  } catch {
    throw new Error("The canonical native Workspace instruction resource was not JSON.");
  }
  const quickstartSteps = workspaceGuideDocument.creation_quickstart?.steps;
  const standaloneCreateSchema = workspaceGuideDocument.create_component_schema;
  if (!workspaceGuideText?.includes("get_workspace_instructions") || !workspaceGuideText.includes("submit_workspace_batch") ||
      workspaceGuideDocument.creation_quickstart?.digest_binding?.later_input_field !== "instruction_digest" ||
      !Array.isArray(quickstartSteps) ||
      !quickstartSteps.some((step) => step?.tool === "inspect_workspace") ||
      !quickstartSteps.some((step) => step?.tool === "begin_workspace_update") ||
      !quickstartSteps.some((step) => step?.tool === "submit_workspace_batch") ||
      standaloneCreateSchema?.properties?.op?.const !== "create_component" ||
      !standaloneCreateSchema?.required?.includes("component_type") ||
      !standaloneCreateSchema?.required?.includes("placement")) {
    throw new Error("The canonical native Workspace instruction resource was incomplete.");
  }

  const denied = await callAgent(mcpClient, "begin_workspace_update", {
    session_token: "missing_session",
    instruction_digest: "sha256:missing",
    intent: "This must not change the workspace",
  });
  if (denied.ok !== false || denied.error?.code !== "instructions_required") {
    throw new Error("The native Workspace instruction-first mutation gate did not reject a missing session.");
  }

  const workspaceScopes = [
    "workspace:read",
    "workspace:write",
    "workspace:history",
    "component:create",
  ];
  const workspaceClientName = "Workspace native smoke agent";
  const approvalRequest = await callAgent(mcpClient, "get_workspace_instructions", {
    client_id: "agent-smoke",
    client_name: workspaceClientName,
    requested_scopes: workspaceScopes,
  });
  const approvalToken = approvalRequest.error?.details?.approval_token;
  rememberSensitiveDiagnostic(approvalToken);
  if (approvalRequest.ok !== false || approvalRequest.error?.code !== "approval_pending" || typeof approvalToken !== "string") {
    throw new Error("The first native Workspace instruction call did not stop for explicit in-app approval.");
  }
  const approvalAlreadyVisible = await cdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-approval'))");
  const requestedApprovalRefresh = approvalAlreadyVisible || await cdp.evaluate(clickButton("Check status"));
  // The long poll can replace the waiting page with approval between the two
  // observations above. Treat that as success instead of requiring a button
  // that was correctly removed by the state transition.
  const approvalBecameVisible = requestedApprovalRefresh || await cdp.evaluate("Boolean(document.querySelector('.agent-connection-page.status-approval'))");
  if (!approvalBecameVisible) {
    const approvalState = await cdp.evaluate(`({
      pageClass: document.querySelector('.agent-connection-page')?.className,
      pageText: document.querySelector('.agent-connection-page')?.innerText,
      toast: document.querySelector('.toast-stack')?.innerText,
    })`);
    throw new Error(`Agent connection status refresh was unavailable: ${JSON.stringify(approvalState)}`);
  }
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-approval'))", "inline agent approval");
  const approvalUi = await cdp.evaluate("document.querySelector('.agent-approval-card')?.innerText");
  if (!approvalUi?.includes(workspaceClientName) || workspaceScopes.some((scope) => !approvalUi.includes(scope)) ||
      approvalUi.includes("component:delete") || approvalUi.includes("workspace:clear")) {
    throw new Error(`The inline approval did not identify the client and requested scopes: ${approvalUi}`);
  }
  await poll(cdp, `[...document.querySelectorAll('button')].some((item) => item.textContent?.includes('Approve client') && !item.disabled)`, "enabled client approval action");
  if (!await cdp.evaluate(clickButton("Approve client"))) throw new Error("Approve client action was unavailable.");
  try {
    await poll(cdp, "!document.querySelector('.agent-connection-page.status-approval')", "approved client state");
  } catch (error) {
    const approvedState = await cdp.evaluate(`({
      pageClass: document.querySelector('.agent-connection-page')?.className,
      pageText: document.querySelector('.agent-connection-page')?.innerText,
      toast: document.querySelector('.toast-stack')?.innerText,
    })`);
    throw new Error(`${error.message}: ${JSON.stringify(approvedState)}. Agent network: ${JSON.stringify(agentNetwork.filter((entry) => entry.tabLabel === 'reopened tab'))}`);
  }

  try {
    await poll(
      cdp,
      `document.querySelector('.agent-last-client strong')?.textContent?.includes(${JSON.stringify(workspaceClientName)}) === true && !document.querySelector('.agent-connection-permission')`,
      "approved Workspace client handoff",
    );
  } catch (error) {
    const transitionalState = await cdp.evaluate(`({
      pageClass: document.querySelector('.agent-connection-page')?.className,
      pageText: document.querySelector('.agent-connection-page')?.innerText,
      client: document.querySelector('.agent-last-client strong')?.textContent,
      destructivePermissionVisible: Boolean(document.querySelector('.agent-connection-permission')),
      status: document.querySelector('.agent-workspace-status')?.textContent,
    })`);
    throw new Error(`${error.message}: ${JSON.stringify(transitionalState)}`);
  }

  const workspaceInstructions = await callAgent(mcpClient, "get_workspace_instructions", {
    client_id: "agent-smoke",
    client_name: workspaceClientName,
    requested_scopes: workspaceScopes,
    approval_token: approvalToken,
  });
  rememberSensitiveDiagnostic(
    workspaceInstructions.data?.session_token,
    workspaceInstructions.data?.guide_digest,
  );
  if (workspaceInstructions.ok !== true || !workspaceInstructions.data?.guide_digest ||
      !workspaceInstructions.data?.guide?.workspace_command_schema ||
      workspaceScopes.some((scope) => !workspaceInstructions.data.granted_scopes?.includes(scope)) ||
      workspaceInstructions.data.granted_scopes?.includes("component:delete") ||
      workspaceInstructions.data.granted_scopes?.includes("workspace:clear")) {
    throw new Error("The full native Workspace instruction handshake failed or granted the wrong scopes.");
  }
  const workspaceSession = workspaceInstructions.data;
  const workspaceSessionInput = {
    session_token: workspaceSession.session_token,
    // get_workspace_instructions returns guide_digest; later tool schemas call
    // the same capability instruction_digest.
    instruction_digest: workspaceSession.guide_digest,
  };
  await poll(cdp, "Boolean(document.querySelector('.agent-workspace-controls.status-connected')) && !document.querySelector('.agent-connection-page')", "automatic Agent handoff to the Workspace");
  const connectedUi = await cdp.evaluate(`({
    status: document.querySelector('.agent-workspace-status')?.textContent,
    hasViewport: Boolean(document.querySelector('.viewport-canvas')),
    hasComposer: Boolean(document.querySelector('textarea[aria-label="Describe what happens next"]')),
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    hasLegacyStoryRail: Boolean(document.querySelector('.story-rail')),
  })`);
  if (!connectedUi.status?.includes(workspaceClientName) || !connectedUi.hasViewport || connectedUi.hasComposer || connectedUi.hasLegacyModeSwitch || connectedUi.hasLegacyStoryRail) {
    throw new Error(`Successful native Workspace handshake did not return to the unified Workspace: ${JSON.stringify(connectedUi)}`);
  }

  const initialWorkspace = await callAgent(mcpClient, "inspect_workspace", workspaceSessionInput);
  const initialSummary = initialWorkspace.data?.workspace_summary;
  if (initialWorkspace.ok !== true || initialWorkspace.data?.workspace_revision !== 0 ||
      initialSummary?.revision !== 0 || initialSummary?.component_count !== 0 || initialSummary?.components?.length !== 0) {
    throw new Error(`The fresh native Workspace was not an empty revision 0 workspace: ${JSON.stringify(initialWorkspace)}`);
  }
  if (initialSummary?.universal_space_data?.version !== "2.0" ||
      initialSummary?.physics_validation?.version !== "2.0") {
    throw new Error(`The Workspace summary did not advertise USD/Physics 2.0: ${diagnosticJson(initialSummary)}`);
  }
  const initialCapability = initialWorkspace.data.capability_manifest;
  const spatialManifest = initialCapability?.component_types?.find((candidate) => candidate?.typeId === "spatial-entity");
  if (spatialManifest?.version !== "1.5.0" || spatialManifest?.defaultProps?.physics?.enabled !== true ||
      spatialManifest?.defaultProps?.physics?.bodyType !== "static" ||
      spatialManifest?.defaultProps?.collision?.shape !== "asset_bounds") {
    throw new Error(`The capability manifest did not publish the current physics-aware spatial contract: ${diagnosticJson(spatialManifest)}`);
  }
  const emptyPhysics = await callAgent(mcpClient, "inspect_workspace_physics", workspaceSessionInput);
  if (emptyPhysics.ok !== true || emptyPhysics.data?.physics_validation?.feasible !== true ||
      emptyPhysics.data?.physics_validation?.bodies?.length !== 0) {
    throw new Error(`Empty Workspace physics inspection was not feasible: ${diagnosticJson(emptyPhysics)}`);
  }
  const dynamicPhysics = {
    enabled: true,
    bodyType: "dynamic", massKg: 2, centerOfMass: { x: 0, y: 0, z: 0 },
    friction: 0.6, restitution: 0.1, gravityScale: 1, stabilityMode: "report", constraints: [],
  };
  const stability = await callAgent(mcpClient, "query_stable_placement", {
    ...workspaceSessionInput,
    candidate: {
      asset_id: "primitive_box",
      entity_kind: "primitive",
      placement: {
        space: "world3d",
        position: { x: 0, y: 3, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      physics: dynamicPhysics,
    },
  });
  if (stability.ok !== true || stability.data?.stability_check?.valid !== false ||
      stability.data?.stability_check?.issues?.[0]?.code !== "unsupported" ||
      stability.data?.stability_check?.suggested_placements?.length !== 0) {
    throw new Error(`Stage-less stable-placement preflight invented an implicit ground correction: ${diagnosticJson(stability)}`);
  }
  const emptySettle = await callAgent(mcpClient, "simulate_workspace_physics", {
    ...workspaceSessionInput,
    duration_ms: 1000,
    time_step_ms: 20,
  });
  if (emptySettle.ok !== true || emptySettle.data?.simulation?.mutates_workspace !== false ||
      emptySettle.data?.simulation?.proposals?.length !== 0) {
    throw new Error(`Empty Workspace physics simulation was not a read-only no-op: ${diagnosticJson(emptySettle)}`);
  }
  const timerManifest = initialCapability?.component_types?.find((candidate) => candidate?.typeId === "timer");
  const timerDefaultProps = timerManifest?.defaultProps;
  const timerDefaultDurableState = timerManifest?.defaultDurableState;
  const timerDefaultSize = timerManifest?.resizePolicy?.viewport?.defaultSize;
  if (!timerManifest || typeof timerManifest.version !== "string" || typeof timerManifest.digest !== "string" ||
      !timerDefaultProps || typeof timerDefaultProps.durationMs !== "number" || typeof timerDefaultProps.label !== "string" ||
      !timerDefaultDurableState || timerDefaultDurableState.phase !== "idle" ||
      typeof timerDefaultDurableState.remainingMs !== "number" || timerManifest.defaultsRedacted !== false ||
      !Array.isArray(timerManifest.redactedDefaultFields) || timerManifest.redactedDefaultFields.length !== 0 ||
      timerManifest.resizePolicy?.viewport?.kind !== "box2d" ||
      typeof timerDefaultSize?.width !== "number" || typeof timerDefaultSize?.height !== "number") {
    throw new Error(`The capability manifest did not publish a complete, safe native timer contract: ${JSON.stringify(timerManifest)}`);
  }
  const timerType = {
    typeId: timerManifest.typeId,
    version: timerManifest.version,
    digest: timerManifest.digest,
  };

  const workspacePrepared = await callAgent(mcpClient, "begin_workspace_update", {
    ...workspaceSessionInput,
    intent: "Create a native timer from the advertised Workspace defaults",
    requested_component_ids: 1,
  });
  rememberSensitiveDiagnostic(workspacePrepared.data?.transaction_token);
  if (workspacePrepared.ok !== true || !workspacePrepared.data?.transaction_token ||
      workspacePrepared.data?.envelope?.base_workspace_revision !== 0 ||
      workspacePrepared.data?.reserved_component_ids?.length !== 1) {
    throw new Error(`Native Workspace transaction preparation failed: ${diagnosticJson(workspacePrepared)}`);
  }
  const workspaceTransaction = workspacePrepared.data;
  const timerId = workspaceTransaction.reserved_component_ids[0];
  const preparedTimerManifest = workspaceTransaction.capability_manifest?.component_types
    ?.find((candidate) => candidate?.typeId === "timer");
  if (!sameJson(preparedTimerManifest, timerManifest)) {
    throw new Error("The prepared transaction did not retain the exact inspected native timer capability.");
  }
  const unreservedTimerId = "CMP_AGENT_SMOKE_UNRESERVED";
  if (workspaceTransaction.reserved_component_ids.includes(unreservedTimerId)) {
    throw new Error("The deliberately unreserved native component ID collided with the transaction reservation.");
  }
  const nativeTimerOperation = (id) => ({
    op: "create_component",
    op_id: "create_native_default_timer",
    id,
    component_type: timerType,
    label: "Native default timer",
    // props, durable_state, and placement.size are intentionally omitted. The
    // engine must materialize the exact defaults advertised in the manifest.
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
  });
  const invalidWorkspaceBatch = {
    ...workspaceTransaction.envelope,
    operations: [nativeTimerOperation(unreservedTimerId)],
  };
  const invalidWorkspaceSubmission = await callAgent(mcpClient, "submit_workspace_batch", {
    ...workspaceSessionInput,
    transaction_token: workspaceTransaction.transaction_token,
    batch: invalidWorkspaceBatch,
  });
  if (invalidWorkspaceSubmission.ok !== false || invalidWorkspaceSubmission.error?.code !== "command_validation_failed" ||
      !invalidWorkspaceSubmission.error?.details?.unreserved_component_ids?.includes(unreservedTimerId)) {
    throw new Error(`An unreserved native component ID was not rejected precisely: ${JSON.stringify(invalidWorkspaceSubmission)}`);
  }
  const afterInvalidWorkspace = await callAgent(mcpClient, "inspect_workspace", workspaceSessionInput);
  if (afterInvalidWorkspace.ok !== true || afterInvalidWorkspace.data?.workspace_revision !== 0 ||
      afterInvalidWorkspace.data?.workspace_summary?.component_count !== 0) {
    throw new Error("The rejected unreserved-ID batch changed the native Workspace revision or component tree.");
  }

  const nativeWorkspaceBatch = {
    ...workspaceTransaction.envelope,
    operations: [nativeTimerOperation(timerId)],
  };
  const nativeSubmissionBody = {
    ...workspaceSessionInput,
    transaction_token: workspaceTransaction.transaction_token,
    batch: nativeWorkspaceBatch,
  };
  const nativeCommitted = await callAgent(mcpClient, "submit_workspace_batch", nativeSubmissionBody);
  if (nativeCommitted.ok !== true || nativeCommitted.data?.base_workspace_revision !== 0 ||
      nativeCommitted.data?.resulting_workspace_revision !== 1 || nativeCommitted.data?.status !== "committed") {
    throw new Error(`The native timer did not commit Workspace revision 1: ${JSON.stringify(nativeCommitted)}`);
  }
  const nativeDuplicate = await callAgent(mcpClient, "submit_workspace_batch", nativeSubmissionBody);
  if (nativeDuplicate.ok !== true || nativeDuplicate.data?.request_id !== nativeCommitted.data?.request_id ||
      nativeDuplicate.data?.base_workspace_revision !== nativeCommitted.data?.base_workspace_revision ||
      nativeDuplicate.data?.resulting_workspace_revision !== nativeCommitted.data?.resulting_workspace_revision ||
      nativeDuplicate.data?.summary !== nativeCommitted.data?.summary ||
      !["committed", "idempotent"].includes(nativeDuplicate.data?.status)) {
    throw new Error("An identical native Workspace transport retry was not idempotent.");
  }

  const nativeInspection = await callAgent(mcpClient, "inspect_workspace_component", {
    ...workspaceSessionInput,
    component_id: timerId,
  });
  const nativeTimer = nativeInspection.data?.component;
  if (nativeInspection.ok !== true || nativeInspection.data?.workspace_revision !== 1 ||
      !sameJson(nativeTimer?.type, timerType) || !sameJson(nativeTimer?.props, timerDefaultProps) ||
      !sameJson(nativeTimer?.durable_state, timerDefaultDurableState) ||
      nativeTimer?.placement?.space !== "viewport" || !sameJson(nativeTimer?.placement?.size, timerDefaultSize) ||
      nativeTimer?.provenance?.createdBy !== "agent" || nativeTimer?.provenance?.createdRevision !== 1 ||
      !sameJson(nativeInspection.data?.current_geometry, { kind: "box2d", size: timerDefaultSize }) ||
      !sameJson(nativeInspection.data?.pinned_manifest?.defaultProps, timerDefaultProps) ||
      !sameJson(nativeInspection.data?.pinned_manifest?.defaultDurableState, timerDefaultDurableState)) {
    throw new Error(`The native timer did not materialize its advertised defaults/provenance: ${JSON.stringify(nativeInspection)}`);
  }
  await poll(
    cdp,
    `Boolean(document.querySelector('[role="region"][data-workspace-component-id="${timerId}"]')) && [...document.querySelectorAll('.workspace-component-tree button')].some((item) => item.dataset.workspaceComponentId === ${JSON.stringify(timerId)} && item.textContent?.trim() === 'Native default timer') && document.querySelector('.scene-stat')?.textContent?.includes('rev 1')`,
    "native timer tree, projection, and revision",
  );
  const nativeRender = await cdp.evaluate(`({
    text: document.querySelector('[role="region"][data-workspace-component-id="${timerId}"]')?.textContent,
    type: document.querySelector('[role="region"][data-workspace-component-id="${timerId}"]')?.dataset.workspaceComponentType,
    label: document.querySelector('[role="region"][data-workspace-component-id="${timerId}"]')?.getAttribute('aria-label'),
  })`);
  if (nativeRender.type !== "timer" || !nativeRender.label?.includes("Native default timer") ||
      !nativeRender.text?.includes(String(timerDefaultProps.label))) {
    throw new Error(`The native timer projection did not render its advertised defaults: ${JSON.stringify(nativeRender)}`);
  }

  if (!await cdp.evaluate(clickButton("History"))) throw new Error("Native Workspace history control was unavailable.");
  await poll(
    cdp,
    `[...document.querySelectorAll('.agent-history-drawer .workspace-history-entry')].some((entry) => entry.querySelector('.entry-source')?.textContent?.includes(${JSON.stringify(`Agent · ${workspaceClientName}`)}))`,
    "native Workspace provenance entry",
  );
  await cdp.evaluate(`(() => { const b = document.querySelector('button[aria-label="Close workspace history"]'); b?.click(); return Boolean(b); })()`);
  await poll(cdp, "!document.querySelector('.agent-history-drawer')", "closed native Workspace history drawer");

  const nativeUndone = await callAgent(mcpClient, "undo_workspace_batch", {
    ...workspaceSessionInput,
    expected_workspace_revision: 1,
  });
  if (nativeUndone.ok !== true || nativeUndone.data?.changed !== true || nativeUndone.data?.workspace_revision !== 0) {
    throw new Error("Native Workspace undo did not restore revision 0.");
  }
  await poll(cdp, `!document.querySelector('[data-workspace-component-id="${timerId}"]') && document.querySelector('.scene-stat')?.textContent?.includes('rev 0')`, "native timer undo projection");
  const nativeRedone = await callAgent(mcpClient, "redo_workspace_batch", {
    ...workspaceSessionInput,
    expected_workspace_revision: 0,
  });
  if (nativeRedone.ok !== true || nativeRedone.data?.changed !== true || nativeRedone.data?.workspace_revision !== 1) {
    throw new Error("Native Workspace redo did not restore revision 1.");
  }
  await poll(cdp, `Boolean(document.querySelector('[role="region"][data-workspace-component-id="${timerId}"]')) && document.querySelector('.scene-stat')?.textContent?.includes('rev 1')`, "native timer redo projection");
  const afterNativeRedo = await callAgent(mcpClient, "inspect_workspace_component", {
    ...workspaceSessionInput,
    component_id: timerId,
  });
  if (afterNativeRedo.ok !== true || !sameJson(afterNativeRedo.data?.component, nativeTimer)) {
    throw new Error("Native Workspace redo did not restore the exact inspected timer.");
  }

  const nativeSavedProjectText = await captureSavedProject(cdp);
  const nativeSavedProject = JSON.parse(nativeSavedProjectText);
  const savedNativeTimer = nativeSavedProject.workspace?.components
    ?.find(([id]) => id === timerId)?.[1];
  const savedNativeCommand = nativeSavedProject.commandHistory
    ?.find((command) => command.requestId === nativeCommitted.data.request_id);
  if (nativeSavedProject.formatVersion !== "1.0" || "sceneProject" in nativeSavedProject || "workspaceProject" in nativeSavedProject ||
      nativeSavedProject.workspace?.revision !== 1 ||
      !sameJson(savedNativeTimer?.props, timerDefaultProps) ||
      !sameJson(savedNativeTimer?.durableState, timerDefaultDurableState) ||
      savedNativeTimer?.provenance?.createdBy !== "agent" || savedNativeCommand?.actor !== "agent" ||
      savedNativeCommand?.resultingWorkspaceRevision !== 1) {
    throw new Error("The saved Workspace project did not persist the native timer, defaults, revision, and agent-authored command history.");
  }

  const secrets = [
    approvalToken,
    workspaceSession.session_token,
    workspaceSession.guide_digest,
    workspaceTransaction.transaction_token,
  ];
  const leaks = await cdp.evaluate(`(() => {
    const needles = ${JSON.stringify(secrets)};
    const local = Object.fromEntries(Array.from({length: localStorage.length}, (_, i) => { const k = localStorage.key(i); return [k, k ? localStorage.getItem(k) : null]; }));
    const session = Object.fromEntries(Array.from({length: sessionStorage.length}, (_, i) => { const k = sessionStorage.key(i); return [k, k ? sessionStorage.getItem(k) : null]; }));
    const surfaces = { html: document.documentElement.outerHTML, inputs: [...document.querySelectorAll('input,textarea')].map((item) => item.value), local, session, cookies: document.cookie, url: location.href, savedProject: window.__agentSmokeSavedProject };
    return Object.entries(surfaces).flatMap(([surface, value]) => needles.filter((needle) => JSON.stringify(value).includes(needle)).map((needle) => ({ surface, suffix: needle.slice(-8) })));
  })()`);
  if (leaks.length) throw new Error(`Agent capability leaked into browser/project surfaces: ${JSON.stringify(leaks)}`);
  if (agentNetwork.some((entry) => entry.path.includes("reveal"))) {
    throw new Error("The browser revealed a pairing bearer while using link-based Agent control.");
  }
  for (const secret of secrets) {
    if (connectionUrl.includes(secret)) throw new Error("An agent capability was embedded in the connection URL.");
  }

  await poll(cdp, "Boolean(document.querySelector('.agent-workspace-controls.status-connected'))", "settled connected Agent controls");
  await poll(cdp, "!document.querySelector('.toast-stack .toast')", "settled Agent workspace notices", 8_000);
  mkdirSync(artifacts, { recursive: true });
  const desktop = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(artifacts, "agent-browser-smoke-desktop.png"), Buffer.from(desktop.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  const mobile = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(artifacts, "agent-browser-smoke-mobile.png"), Buffer.from(mobile.data, "base64"));
  const mobileLayout = await cdp.evaluate(`({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    hasLegacyModeSwitch: Boolean(document.querySelector('.control-mode-switch')),
    connectionGateVisible: Boolean(document.querySelector('.agent-connection-page')),
    workspaceVisible: Boolean(document.querySelector('.app-workspace')),
    controlsVisible: Boolean(document.querySelector('.agent-workspace-controls.status-connected')),
    composerVisible: Boolean(document.querySelector('textarea[aria-label="Describe what happens next"]')),
  })`);
  if (mobileLayout.overflow || mobileLayout.hasLegacyModeSwitch || mobileLayout.connectionGateVisible || !mobileLayout.workspaceVisible || !mobileLayout.controlsVisible || mobileLayout.composerVisible) {
    throw new Error(`Mobile connected Agent Workspace was not usable: ${JSON.stringify(mobileLayout)}`);
  }

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (!await cdp.evaluate(clickExactButton("Manage"))) throw new Error("Agent connection management control was unavailable.");
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-connected'))", "connected Agent management page");
  if (!await cdp.evaluate(clickButton("Disable agent control"))) throw new Error("Agent control could not be disabled.");
  await poll(cdp, "Boolean(document.querySelector('.agent-connection-page.status-disabled')) && !document.querySelector('.app-workspace')", "disabled Agent connection gate");
  const disabledGate = await cdp.evaluate(`({
    hasConnectionPage: Boolean(document.querySelector('.agent-connection-page.status-disabled')),
    hasWorkspace: Boolean(document.querySelector('.app-workspace')),
    hasProjectBar: Boolean(document.querySelector('.project-bar')),
    hasBackButton: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Back to workspace')),
  })`);
  if (!disabledGate.hasConnectionPage || disabledGate.hasWorkspace || disabledGate.hasProjectBar || disabledGate.hasBackButton) {
    throw new Error(`Disabling Agent control did not return to the exclusive connection gate: ${JSON.stringify(disabledGate)}`);
  }
  const revokedOffer = await fetch(connectionUrl, { cache: "no-store" });
  if (revokedOffer.ok) throw new Error("Disabling Agent control did not revoke the copied connection offer.");

  if (problems.length) throw new Error(`Browser reported problems: ${problems.join(" | ")}`);
  const openApi = await fetch(`${gatewayUrl}/openapi.json`).then((response) => response.json());
  if (openApi.openapi !== "3.1.0" ||
      openApi.paths?.["/workspace/instructions"]?.post?.operationId !== "get_workspace_instructions" ||
      openApi.paths?.["/workspace/space/inspect"]?.post?.operationId !== "inspect_workspace_space" ||
      openApi.paths?.["/workspace/space/query"]?.post?.operationId !== "query_spatial_placement" ||
      openApi.paths?.["/workspace/physics/inspect"]?.post?.operationId !== "inspect_workspace_physics" ||
      openApi.paths?.["/workspace/physics/placement/query"]?.post?.operationId !== "query_stable_placement" ||
      openApi.paths?.["/workspace/physics/simulate"]?.post?.operationId !== "simulate_workspace_physics" ||
      openApi.paths?.["/workspace/updates/submit"]?.post?.operationId !== "submit_workspace_batch" ||
      Object.keys(openApi.paths ?? {}).length !== 13 ||
      /get_scene|inspect_scene|begin_scene|submit_scene|undo_scene|redo_scene|SceneCommandBatch|expected_scene_revision/u.test(JSON.stringify(openApi))) {
    throw new Error("Agent OpenAPI discovery document is incomplete.");
  }
  console.log("Agent browser smoke passed: exclusive thirteen-tool Workspace MCP/OpenAPI contract, explicit approval, USD 2.0 and physics inspect/stable-placement/settle discovery, rejected unreserved ID with no revision change, default-materialized timer commit and identical retry, exact inspection/tree/render/revision/provenance, native undo/redo and saved persistence, secret scan, and responsive screenshots.");
} catch (error) {
  const safeLogs = diagnosticText(processLogs.join(""));
  if (safeLogs.trim()) console.error(safeLogs.slice(-4_000));
  throw sanitizeAgentSmokeFailure(error, sensitiveDiagnosticValues);
} finally {
  await mcpClient?.close().catch(() => undefined);
  cdp?.close();
  for (const child of [browser, stack]) child.kill("SIGTERM");
  await delay(150);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runAgentSmoke();
}
