// @vitest-environment node
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { createAgentMcpServer } from "../../../server/agent/AgentMcpServer";

describe("MCP registered host and asset handlers", () => {
  it("observes each registration once, binds client era, preserves failures, and dispatches cancellation separately", async () => {
    const dispatch = vi.fn().mockResolvedValue({ responseOk: true, status: 200, payload: { ok: true, data: {} } });
    const cancelAssetImport = vi.fn().mockResolvedValue({ responseOk: true, status: 200, payload: { ok: true, data: { cancelled: true } } });
    const hostControl = vi.fn().mockResolvedValue({ responseOk: true, status: 200, payload: { ok: true, data: { phase: "ready" } } });
    const onToolRegistered = vi.fn();
    const server = createAgentMcpServer({ dispatch, cancelAssetImport, hostControl }, { onToolRegistered, protocolEra: "legacy" });
    const client = new Client({ name: "host-security-test", version: "1" }, { versionNegotiation: { mode: "legacy" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      expect(onToolRegistered).toHaveBeenCalledTimes(tools.length);
      expect(new Set(onToolRegistered.mock.calls.map(([name]) => name)).size).toBe(tools.length);
      const arguments_ = { session_token: "session-token", instruction_digest: "instruction-digest", workspace_id: "workspace" };
      expect(await client.callTool({ name: "inspect_voice_relay", arguments: arguments_ })).toMatchObject({ isError: false, structuredContent: { ok: true, data: { phase: "ready" } } });
      expect(hostControl).toHaveBeenCalledWith("inspect_voice_relay", arguments_, { protocolEra: "legacy" });
      hostControl.mockResolvedValueOnce({ responseOk: true, status: 200, payload: { ok: false, error: { code: "scope_missing", message: "Not approved", retryable: false } } });
      expect(await client.callTool({ name: "request_enter_xr", arguments: arguments_ })).toMatchObject({ isError: true, structuredContent: { ok: false } });
      hostControl.mockResolvedValueOnce({ responseOk: false, status: 503, payload: { ok: true, data: {} } });
      expect(await client.callTool({ name: "inspect_xr_readiness", arguments: arguments_ })).toMatchObject({ isError: true });
      const cancelInput = { session_token: "session-token", instruction_digest: "instruction-digest", candidate_handle: "c".repeat(43) };
      expect(await client.callTool({ name: "cancel_workspace_asset_import", arguments: cancelInput })).toMatchObject({ isError: false, structuredContent: { data: { cancelled: true } } });
      expect(cancelAssetImport).toHaveBeenCalledWith(cancelInput, expect.objectContaining({ protocolEra: "legacy" }));
      expect(dispatch).not.toHaveBeenCalled();
      expect((await client.callTool({ name: "request_enter_xr", arguments: { ...arguments_, synthesize_gesture: true } })).isError).toBe(true);
      expect(hostControl).toHaveBeenCalledTimes(3);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
