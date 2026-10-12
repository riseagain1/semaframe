import { describe, expect, it } from "vitest";
import { AGENT_GATEWAY_COMMAND_NAMES } from "../../agent/AgentGatewayClient";
import { AGENT_HOST_CONTROL_COMMAND_NAMES } from "../../agent/hostControlContracts";
import { WORKSPACE_AGENT_TOOL_NAMES } from "../../workspace/agents/contracts";

describe("browser command discovery parity", () => {
  it("accepts every canonical MCP command so newly exposed tools cannot disappear into poll timeouts", () => {
    expect(new Set(AGENT_GATEWAY_COMMAND_NAMES)).toEqual(new Set([
      ...WORKSPACE_AGENT_TOOL_NAMES, ...AGENT_HOST_CONTROL_COMMAND_NAMES, "complete_workspace_reconstruction_asset",
    ]));
    expect(AGENT_GATEWAY_COMMAND_NAMES).toContain("analyze_workspace_precision");
    expect(new Set(AGENT_GATEWAY_COMMAND_NAMES).size).toBe(AGENT_GATEWAY_COMMAND_NAMES.length);
  });
});
