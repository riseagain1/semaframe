// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAgentGatewayOpenApi } from "../../server/agent/openapi";
import { AGENT_HOST_CONTROL_COMMAND_NAMES } from "../agent/hostControlContracts";
import { WORKSPACE_AGENT_TOOL_NAMES } from "../workspace/agents/contracts";
// Importing the guarded runner does not launch a browser or start services.
// @ts-expect-error The executable .mjs file does not ship a declaration file.
import { assertAgentConnectionGuidance } from "../../scripts/agent-smoke.mjs";

// These are source-level runner contracts, not substitutes for Chrome smoke.
// Reading the source never launches browsers or starts a Gateway.
const source = readFileSync(new URL("../../scripts/agent-smoke.mjs", import.meta.url), "utf8");
const connectionPageSource = readFileSync(new URL("../app/components/AgentConnectionPage.tsx", import.meta.url), "utf8");

describe("Agent browser smoke contract compatibility", () => {
  const manualGuidance = "For manual setup, paste the copied address into your agent client and ask it to connect.";
  const launcherGuidance = "An installed stable launcher finds the current offer without copying.";
  const approvalGuidance = "Access still requires approval on this page.";
  const guidance = [manualGuidance, launcherGuidance, approvalGuidance].join(" ");
  const copyLabel = "Copy connection URL";

  it("checks both connection setup paths and human approval in the rendered smoke snapshot", () => {
    expect(source).toContain("assertAgentConnectionGuidance(preConnectionUi);");
    // Keep this fixture tied to the real UI copy so future wording changes
    // fail the fast contract suite instead of first failing remote Chrome.
    expect(connectionPageSource).toContain(JSON.stringify(guidance));
    expect(() => assertAgentConnectionGuidance({ guidance, copyLabel })).not.toThrow();
    expect(() => assertAgentConnectionGuidance({ guidance: guidance.replaceAll(" ", "\n  "), copyLabel })).not.toThrow();
  });

  it.each([
    { guidance: [launcherGuidance, approvalGuidance].join(" "), copyLabel, reason: "manual URL copy-and-paste" },
    { guidance, copyLabel: undefined, reason: "manual URL copy-and-paste" },
    { guidance, copyLabel: "Connect", reason: "manual URL copy-and-paste" },
    { guidance: [manualGuidance, approvalGuidance].join(" "), copyLabel, reason: "automatic offer discovery" },
    { guidance: [manualGuidance, launcherGuidance].join(" "), copyLabel, reason: "in-page approval" },
    { guidance: undefined, copyLabel, reason: "manual URL copy-and-paste" },
  ])("rejects missing connection guidance: $reason", ({ reason, ...snapshot }) => {
    expect(() => assertAgentConnectionGuidance(snapshot)).toThrow(reason);
  });

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
