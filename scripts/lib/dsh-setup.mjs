// Browser-safe conversion of the host's stable MCP setup to DSH's official
// Cordis overlay format. JSON is a YAML subset; no executable YAML expressions
// or credentials are needed. This module never reads or edits DSH settings.
const INVALID_SETUP = "DSH setup requires the current credential-free SemaFrame stdio configuration. Refresh the local setup and try again.";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 8192
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function absolutePath(value) {
  return safeString(value) && (/^\//u.test(value) || /^[A-Za-z]:[\\/]/u.test(value));
}

function localGateway(value) {
  if (!safeString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && url.pathname === "/" && !url.search && !url.hash
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function localLoader(value) {
  if (!safeString(value)) return false;
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).replace(/\\/gu, "/");
    return url.protocol === "file:" && !url.host && !url.search && !url.hash
      && !url.username && !url.password
      && path.endsWith("/node_modules/tsx/dist/loader.mjs");
  } catch {
    return false;
  }
}

/** Convert only SemaFrame's known, stable stdio launcher; never REST authority. */
export function createDshMcpPatch(mcpConfig) {
  let parsed;
  try {
    if (typeof mcpConfig !== "string" || mcpConfig.length > 65536) throw new Error();
    parsed = JSON.parse(mcpConfig);
  } catch {
    throw new TypeError(INVALID_SETUP);
  }
  const servers = parsed?.mcpServers;
  const entry = servers?.semaframe;
  const env = entry?.env;
  if (!record(parsed) || Object.keys(parsed).some((key) => key !== "mcpServers")
    || !record(servers) || Object.keys(servers).length !== 1 || !record(entry)
    || Object.keys(entry).some((key) => !["command", "args", "env"].includes(key))
    || !absolutePath(entry.command) || !/(?:^|[\\/])node(?:\.exe)?$/iu.test(entry.command)
    || !Array.isArray(entry.args) || entry.args.length !== 3
    || entry.args[0] !== "--import" || !localLoader(entry.args[1])
    || !absolutePath(entry.args[2])
    || !entry.args[2].replace(/\\/gu, "/").endsWith("/scripts/agent-mcp.ts")
    || !record(env) || !localGateway(env.SEMAFRAME_AGENT_GATEWAY_URL)
    || Object.keys(env).some((key) => !["SEMAFRAME_AGENT_GATEWAY_URL", "SEMAFRAME_AGENT_NAME"].includes(key))
    || (env.SEMAFRAME_AGENT_NAME !== undefined && !safeString(env.SEMAFRAME_AGENT_NAME))) {
    throw new TypeError(INVALID_SETUP);
  }
  return JSON.stringify([{
    insert: [{
      id: "semaframe-mcp",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: "semaframe",
        transport: "stdio",
        command: entry.command,
        args: [...entry.args],
        env: {
          SEMAFRAME_AGENT_GATEWAY_URL: new URL(env.SEMAFRAME_AGENT_GATEWAY_URL).origin,
          SEMAFRAME_AGENT_NAME: "DeepSeek Harness",
        },
        toolCallTimeoutMs: 60000,
      },
    }],
  }], null, 2);
}
