import { spawn } from "node:child_process";

const vitePort = process.env.TTV_AGENT_VITE_PORT?.trim() || "4173";
const viteArguments = ["run", "dev:local", "--", "--port", vitePort];
const browserOrigins = `http://127.0.0.1:${vitePort},http://localhost:${vitePort}`;
const gatewayPort = process.env.TTV_AGENT_GATEWAY_PORT?.trim() || "8788";
const gatewayHost = process.env.TTV_AGENT_GATEWAY_HOST?.trim() || "127.0.0.1";
const gatewayPublicHost = gatewayHost === "::1" ? "[::1]" : gatewayHost;
const gatewayUrl = process.env.TTV_AGENT_GATEWAY_PUBLIC_URL?.trim() ||
  `http://${gatewayPublicHost}:${gatewayPort}`;
const gatewayEnvironment = {
  ...process.env,
  TTV_AGENT_ALLOWED_ORIGINS: process.env.TTV_AGENT_ALLOWED_ORIGINS || browserOrigins,
};
const viteEnvironment = {
  ...process.env,
  VITE_AGENT_CONTROL_ENDPOINT: "/api/agent",
  TTV_AGENT_GATEWAY_URL: gatewayUrl,
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
      console.error(`Scene Thread development process stopped (${signal ?? code ?? "unknown"}).`);
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
