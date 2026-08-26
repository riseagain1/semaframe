import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hostHeaderValidation } from "@modelcontextprotocol/node";
import { loadRootEnvironment } from "../../scripts/lib/root-env.mjs";
import { AgentGateway } from "./AgentGateway";
import { createNodeAgentGatewayHttpHandler } from "./AgentGatewayHttpHandler";
import { resolveAgentGatewayNetworkConfig } from "./AgentGatewayNetworkConfig";
import { closeAgentGatewayStack } from "./shutdown";
import { createWindowsUltraEvidenceProvider } from "../xr";
import {
  VoiceRelayService,
  createVoiceRelayNativeClient,
} from "../voice-relay";

loadRootEnvironment();

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function allowedOrigins(
  value: string | undefined,
  variableName = "SEMAFRAME_AGENT_ALLOWED_ORIGINS",
  fallback = "http://127.0.0.1:4173,http://localhost:4173",
): string[] {
  const values = (value ?? fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!values.length) throw new Error(`${variableName} must contain at least one exact origin.`);
  return [...new Set(values.map((entry) => {
    const url = new URL(entry);
    if (url.origin !== entry || url.username || url.password || url.pathname !== "/") {
      throw new Error(`Invalid exact browser origin: ${entry}`);
    }
    return url.origin;
  }))];
}

const network = resolveAgentGatewayNetworkConfig(process.env);
const { bindHost: host, port, publicBaseUrl } = network;
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, "");
const browserOrigins = [
  ...new Set([
    ...allowedOrigins(process.env.SEMAFRAME_AGENT_ALLOWED_ORIGINS),
    new URL(publicBaseUrl).origin,
  ]),
];
const xrRendererOrigins = allowedOrigins(
  process.env.SEMAFRAME_XR_ALLOWED_ORIGINS,
  "SEMAFRAME_XR_ALLOWED_ORIGINS",
  "http://127.0.0.1:4174,http://localhost:4174",
);
const bodyLimitBytes = positiveInteger("SEMAFRAME_AGENT_BODY_LIMIT_BYTES", 512 * 1024);
const shutdownTimeoutMs = positiveInteger("SEMAFRAME_AGENT_SHUTDOWN_TIMEOUT_MS", 15_000);
const browserBootstrapToken = process.env.SEMAFRAME_AGENT_BROWSER_TOKEN?.trim()
  || randomBytes(32).toString("base64url");
if (!/^[A-Za-z0-9_-]{43}$/u.test(browserBootstrapToken)) {
  throw new Error("SEMAFRAME_AGENT_BROWSER_TOKEN must be a 256-bit base64url capability.");
}
const xrUltraEvidence = createWindowsUltraEvidenceProvider();
const voiceRelayNative = await createVoiceRelayNativeClient({
  workspaceRoot,
  ...(process.env.SEMAFRAME_VOICE_RELAY_HELPER_PATH?.trim()
    ? { helperPath: process.env.SEMAFRAME_VOICE_RELAY_HELPER_PATH.trim() }
    : {}),
  ...(process.env.SEMAFRAME_VOICE_RELAY_HELPER_SHA256?.trim()
    ? { expectedSha256: process.env.SEMAFRAME_VOICE_RELAY_HELPER_SHA256.trim().toLowerCase() }
    : {}),
  allowUnsignedDevelopmentHelper: process.env.SEMAFRAME_VOICE_RELAY_ALLOW_UNSIGNED_HELPER === "1",
  requestTimeoutMs: positiveInteger("SEMAFRAME_VOICE_RELAY_REQUEST_TIMEOUT_MS", 15_000),
}).catch(() => undefined);
const voiceRelayService = voiceRelayNative ? new VoiceRelayService(voiceRelayNative) : undefined;

const gateway = new AgentGateway({
  publicBaseUrl,
  workspaceRoot,
  commandTimeoutMs: positiveInteger("SEMAFRAME_AGENT_COMMAND_TIMEOUT_MS", 45_000),
  pollTimeoutMs: positiveInteger("SEMAFRAME_AGENT_POLL_TIMEOUT_MS", 25_000),
  browserTtlMs: positiveInteger("SEMAFRAME_AGENT_BROWSER_TTL_MS", 65_000),
  offerTtlMs: positiveInteger("SEMAFRAME_AGENT_OFFER_TTL_MS", 10 * 60_000),
  approvalTtlMs: positiveInteger("SEMAFRAME_AGENT_APPROVAL_TTL_MS", 2 * 60_000),
});
const handle = createNodeAgentGatewayHttpHandler(gateway, {
  allowedOrigins: browserOrigins,
  publicBaseUrl,
  bodyLimitBytes,
  browserBootstrapToken,
  xrRendererOrigins,
  ...(xrUltraEvidence ? { xrUltraEvidence } : {}),
  ...(voiceRelayService ? { voiceRelayService } : {}),
});
const validateHost = hostHeaderValidation([...network.allowedHostnames]);

const server = createServer((request, response) => {
  if (!validateHost(request, response)) return;
  void handle(request, response);
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, host, () => {
  // This is intentionally the only startup log. Pairing credentials are never logged.
  console.log(`SemaFrame Agent Gateway listening on ${publicBaseUrl}`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void closeAgentGatewayStack({
    server,
    gateway,
    handler: handle,
    timeoutMs: shutdownTimeoutMs,
  }).then(
    () => process.exit(0),
    () => {
      // Keep diagnostics deliberately path- and credential-free.
      console.error("SemaFrame Agent Gateway shutdown could not complete all cleanup work.");
      process.exit(1);
    },
  );
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
