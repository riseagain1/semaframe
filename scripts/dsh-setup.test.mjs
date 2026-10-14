import assert from "node:assert/strict";
import test from "node:test";
import { createDshMcpPatch } from "./lib/dsh-setup.mjs";

function setup(overrides = {}) {
  return { mcpServers: { semaframe: {
    command: "/opt/node/bin/node",
    args: ["--import", "file:///Applications/Sema%20Frame/node_modules/tsx/dist/loader.mjs", "/Applications/Sema Frame/scripts/agent-mcp.ts"],
    env: { SEMAFRAME_AGENT_GATEWAY_URL: "http://127.0.0.1:8788" },
    ...overrides,
  } } };
}

function patch(value) { return JSON.parse(createDshMcpPatch(JSON.stringify(value))); }

test("DSH overlay uses the official client and stable launcher without model credentials", () => {
  const config = setup();
  const generated = patch(config);
  assert.deepEqual(generated, [{ insert: [{
    id: "semaframe-mcp",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "semaframe", transport: "stdio",
      command: config.mcpServers.semaframe.command,
      args: config.mcpServers.semaframe.args,
      env: { SEMAFRAME_AGENT_GATEWAY_URL: "http://127.0.0.1:8788", SEMAFRAME_AGENT_NAME: "DeepSeek Harness" },
      toolCallTimeoutMs: 60000,
    },
  }] }]);
  assert.equal(generated[0].insert[0].config.args[2], "/Applications/Sema Frame/scripts/agent-mcp.ts");
});

test("DSH accepts absolute Windows paths and preserves literal shell metacharacters", () => {
  const generated = patch(setup({
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["--import", "file:///C:/Sema%20Frame/node_modules/tsx/dist/loader.mjs", "C:\\Sema Frame\\$literal;dir\\scripts\\agent-mcp.ts"],
  }));
  assert.equal(generated[0].insert[0].config.args[2], "C:\\Sema Frame\\$literal;dir\\scripts\\agent-mcp.ts");
});

test("DSH accepts only credential-free loopback origins and normalizes the trailing slash", () => {
  for (const origin of ["http://localhost:4990/", "http://[::1]:4991/", "http://127.0.0.1:8788/"]) {
    assert.equal(patch(setup({ env: { SEMAFRAME_AGENT_GATEWAY_URL: origin } }))[0].insert[0].config.env.SEMAFRAME_AGENT_GATEWAY_URL, new URL(origin).origin);
  }
  for (const origin of ["https://example.com", "http://192.168.8.1:8788", "http://localhost/mcp/connect/id", "http://localhost/?token=private", "http://localhost/#private", "http://user:private@localhost/", "not a URL"]) {
    assert.throws(() => patch(setup({ env: { SEMAFRAME_AGENT_GATEWAY_URL: origin } })), /credential-free/u);
  }
});

test("DSH rejects REST secrets, legacy offers and unexpected environment fields without echoing them", () => {
  const privateValue = "private-example-do-not-echo";
  const cases = [
    { semaframeRest: { baseUrl: "http://127.0.0.1:8788/v1", authorization: privateValue } },
    setup({ env: { SEMAFRAME_AGENT_MCP_URL: `http://localhost/mcp/connect/${privateValue}` } }),
    setup({ env: { SEMAFRAME_AGENT_GATEWAY_URL: "http://localhost:8788", DEEPSEEK_API_KEY: privateValue } }),
    { ...setup(), authorization: privateValue },
    setup({ headers: { Authorization: privateValue } }),
  ];
  for (const candidate of cases) {
    assert.throws(() => patch(candidate), (error) => error instanceof TypeError && !error.message.includes(privateValue));
  }
});

test("DSH fails closed on noncanonical or incomplete launchers", () => {
  for (const overrides of [
    { command: "node" }, { command: "/bin/sh" }, { command: "/node\n" },
    { args: ["--import", "file:///tmp/arbitrary.mjs", "/app/scripts/agent-mcp.ts"] },
    { args: ["--import", "file://remote/node_modules/tsx/dist/loader.mjs", "/app/scripts/agent-mcp.ts"] },
    { args: ["--import", "file:///tmp/node_modules/tsx/dist/loader.mjs#inject", "/app/scripts/agent-mcp.ts"] },
    { args: ["-e", "console.log('hello')"] },
    { args: ["--import", "file:///tmp/node_modules/tsx/dist/loader.mjs", "relative/scripts/agent-mcp.ts"] },
    { args: ["--import", "file:///tmp/node_modules/tsx/dist/loader.mjs", "/app/scripts/not-bridge.ts"] },
    { env: null },
    { env: { SEMAFRAME_AGENT_GATEWAY_URL: "http://localhost:8788", SEMAFRAME_AGENT_NAME: "bad\nname" } },
  ]) assert.throws(() => patch(setup(overrides)), /credential-free/u);
  for (const value of [null, [], {}, { mcpServers: [] }, { mcpServers: { ...setup().mcpServers, other: {} } }]) {
    assert.throws(() => patch(value), /credential-free/u);
  }
  for (const text of ["not json", "x".repeat(65537), undefined]) {
    assert.throws(() => createDshMcpPatch(text), /credential-free/u);
  }
});
