// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAgentGatewayOpenApi } from "../../server/agent/openapi";
import { AGENT_HOST_CONTROL_COMMAND_NAMES } from "../agent/hostControlContracts";
import { WORKSPACE_AGENT_TOOL_NAMES } from "../workspace/agents/contracts";

// These are source-level runner contracts, not substitutes for Chrome smoke.
// Reading the source never launches browsers or starts a Gateway.
const source = readFileSync(new URL("../../scripts/agent-smoke.mjs", import.meta.url), "utf8");

describe("Agent browser smoke contract compatibility", () => {
  it("expects exactly the registered Workspace and host-control tool names", () => {
    const block = source.match(/const expectedTools = \[([\s\S]*?)\];/u)?.[1];
    expect(block).toBeDefined();
    const names = [...block!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...WORKSPACE_AGENT_TOOL_NAMES, ...AGENT_HOST_CONTROL_COMMAND_NAMES].sort());
  });

  it("keeps its strict OpenAPI route count and capability discovery check current", () => {
    const advertised = createAgentGatewayOpenApi("http://127.0.0.1:8788");
    const expectedCount = Number(source.match(/Object\.keys\(openApi\.paths \?\? \{\}\)\.length !== (\d+)/u)?.[1]);
    expect(expectedCount).toBe(Object.keys(advertised.paths as object).length);
    expect(source).toContain('openApi.paths?.["/workspace/capabilities/inspect"]?.post?.operationId !== "inspect_workspace_capabilities"');
  });

  it("explicitly asks for full prepare capabilities when comparing complete manifests", () => {
    const preparation = source.match(/const workspacePrepared = await callAgent\(mcpClient, "begin_workspace_update", \{([\s\S]*?)\n {2}\}\);/u)?.[1];
    expect(preparation).toBeDefined();
    expect(preparation).toContain('capability_detail: "full"');
    expect(preparation).not.toContain('layout_frame: "canonical"');
    expect(source).toContain('"inspect_workspace", { ...workspaceSessionInput, capability_detail: "full" }');
    expect(source).toContain("sameJson(preparedTimerManifest, timerManifest)");
  });
});
