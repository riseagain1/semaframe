import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const vitePort = process.env.SEMAFRAME_AGENT_VITE_PORT?.trim() || "4173";
const viteArguments = ["run", "dev:local", "--", "--port", vitePort];
const browserOrigins = `http://127.0.0.1:${vitePort},http://localhost:${vitePort}`;
const gatewayPort = process.env.SEMAFRAME_AGENT_GATEWAY_PORT?.trim() || "8788";
const gatewayHost = process.env.SEMAFRAME_AGENT_GATEWAY_HOST?.trim() || "127.0.0.1";
const gatewayPublicHost = gatewayHost === "::1" ? "[::1]" : gatewayHost;
const gatewayInternalUrl = `http://${gatewayPublicHost}:${gatewayPort}`;
const browserBootstrapToken = process.env.SEMAFRAME_AGENT_BROWSER_TOKEN?.trim()
  || randomBytes(32).toString("base64url");
if (!/^[A-Za-z0-9_-]{43}$/u.test(browserBootstrapToken)) {
  throw new Error("SEMAFRAME_AGENT_BROWSER_TOKEN must be a 256-bit base64url capability.");
}
const gatewayEnvironment = {
  ...process.env,
  SEMAFRAME_AGENT_ALLOWED_ORIGINS: process.env.SEMAFRAME_AGENT_ALLOWED_ORIGINS || browserOrigins,
  SEMAFRAME_AGENT_BROWSER_TOKEN: browserBootstrapToken,
};
const viteEnvironment = {
  ...process.env,
  VITE_AGENT_CONTROL_ENDPOINT: "/api/agent",
  // Browser-authority routes always travel to the loopback listener. The
  // separately advertised HTTPS origin is only for external MCP/upload links.
  SEMAFRAME_AGENT_GATEWAY_URL: gatewayInternalUrl,
  SEMAFRAME_AGENT_BROWSER_TOKEN: browserBootstrapToken,
};

const children = [
  // Keep the browser UI and gateway on the same source revision during local
  // development. The one-shot agent:gateway script remains available for
  // production-style and manual launches.
  spawn("npm", ["run", "agent:gateway:watch"], { stdio: "inherit", env: gatewayEnvironment }),
  spawn("npm", viteArguments, { stdio: "inherit", env: viteEnvironment }),
];

let exiting = false;
function stop(exitCode = 0) {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 100).unref();
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!exiting) {
      console.error(`SemaFrame development process stopped (${signal ?? code ?? "unknown"}).`);
      stop(code ?? 1);
    }
  });
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
