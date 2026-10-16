import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { AgentMcpHandshakeSession } from "../../../server/agent/AgentMcpHandshakeSession";

const TOKEN = "private-approval-token-never-log-0001";
const OFFER = "gateway-instance-1/offer-1";
const identity = {
  client_id: "client-one",
  client_name: "Client One",
  requested_scopes: ["workspace:read", "workspace:write"],
};
const success: CallToolResult = { content: [], structuredContent: { ok: true, data: {} } };

function error(code: string, details?: Record<string, unknown>): CallToolResult {
  return { content: [], isError: true, structuredContent: { ok: false, error: { code, details } } };
}

async function claim(session: AgentMcpHandshakeSession): Promise<void> {
  await session.call(OFFER, "get_workspace_instructions", identity, async () => error("approval_pending", {
    approval_token: TOKEN,
    requested_scopes: identity.requested_scopes,
  }));
}

describe("Agent MCP protocol-session handshake continuation", () => {
  it("retains an upstream-generated anonymous identity for omitted or explicit continuation", async () => {
    const session = new AgentMcpHandshakeSession();
    const clientId = "workspace_client_public-claim-id";
    await session.call(OFFER, "get_workspace_instructions", { requested_scopes: ["workspace:read"] }, async () => error("approval_pending", {
      approval_token: TOKEN, client_id: clientId, requested_scopes: ["workspace:read"],
    }));
    const invoke = vi.fn(async () => success);
    await session.call(OFFER, "get_workspace_instructions", {}, invoke);
    expect(invoke).toHaveBeenLastCalledWith({ client_id: clientId, requested_scopes: ["workspace:read"], approval_token: TOKEN });
    await session.call(OFFER, "get_workspace_instructions", { client_id: clientId }, invoke);
    expect(invoke).toHaveBeenLastCalledWith({ client_id: clientId, requested_scopes: ["workspace:read"], approval_token: TOKEN });
    await session.call(OFFER, "get_workspace_instructions", { client_id: "different-public-id" }, invoke);
    expect(invoke).toHaveBeenLastCalledWith({ client_id: "different-public-id" });
  });

  it("retains the first token through later pending results and instruction refreshes", async () => {
    const session = new AgentMcpHandshakeSession();
    await claim(session);
    const invoke = vi.fn(async () => error("approval_pending", { claim_id: "same-claim" }));
    await session.call(OFFER, "get_workspace_instructions", identity, invoke);
    expect(invoke).toHaveBeenLastCalledWith({ ...identity, approval_token: TOKEN });
    const approved = vi.fn(async () => success);
    await session.call(OFFER, "get_workspace_instructions", {}, approved);
    await session.call(OFFER, "get_workspace_instructions", { detail: "full" }, approved);
    expect(approved).toHaveBeenLastCalledWith({ ...identity, detail: "full", approval_token: TOKEN });
  });

  it.each([
    { client_id: "different-client" },
    { client_name: "Different Client" },
    { requested_scopes: ["workspace:read"] },
    { requested_scopes: ["workspace:read", "workspace:write", "workspace:delete"] },
    { requested_scopes: [] },
  ])("never lends a claim to explicitly different identity/scopes %j", async (input) => {
    const session = new AgentMcpHandshakeSession();
    await claim(session);
    const invoke = vi.fn(async () => error("approval_token_required"));
    await session.call(OFFER, "get_workspace_instructions", input, invoke);
    expect(invoke).toHaveBeenCalledWith(input);
  });

  it("matches scope sets independent of order/duplicates but never overwrites an explicit token", async () => {
    const session = new AgentMcpHandshakeSession();
    await claim(session);
    const invoke = vi.fn(async () => success);
    const input = { ...identity, requested_scopes: ["workspace:write", "workspace:read", "workspace:read"] };
    await session.call(OFFER, "get_workspace_instructions", input, invoke);
    expect(invoke).toHaveBeenLastCalledWith({ ...input, approval_token: TOKEN });
    await session.call(OFFER, "get_workspace_instructions", { approval_token: "explicit-other-token" }, invoke);
    expect(invoke).toHaveBeenLastCalledWith({ approval_token: "explicit-other-token" });
  });

  it("does not inject authority into workspace calls or another protocol session", async () => {
    const session = new AgentMcpHandshakeSession();
    await claim(session);
    const invoke = vi.fn(async () => success);
    await session.call(OFFER, "submit_workspace_batch", { batch: "unchanged" }, invoke);
    expect(invoke).toHaveBeenLastCalledWith({ batch: "unchanged" });
    await new AgentMcpHandshakeSession().call(OFFER, "get_workspace_instructions", identity, invoke);
    expect(invoke).toHaveBeenLastCalledWith(identity);
  });

  it.each(["approval_invalid", "approval_denied", "connection_invalid", "connection_offer_expired", "pairing_rotated", "agent_mode_disabled"])(
    "forgets the private continuation after %s", async (code) => {
      const session = new AgentMcpHandshakeSession();
      await claim(session);
      await session.call(OFFER, "get_workspace_instructions", {}, async () => error(code));
      const invoke = vi.fn(async () => success);
      await session.call(OFFER, "get_workspace_instructions", identity, invoke);
      expect(invoke).toHaveBeenLastCalledWith(identity);
    },
  );

  it("forgets tokens on new gateway/offer and explicit reset", async () => {
    const session = new AgentMcpHandshakeSession();
    await claim(session);
    const invoke = vi.fn(async () => success);
    await session.call("gateway-instance-2/offer-1", "get_workspace_instructions", identity, invoke);
    expect(invoke).toHaveBeenLastCalledWith(identity);
    await claim(session);
    await session.call("gateway-instance-1/offer-2", "get_workspace_instructions", identity, invoke);
    expect(invoke).toHaveBeenLastCalledWith(identity);
    await claim(session);
    session.clear();
    await session.call(OFFER, "get_workspace_instructions", identity, invoke);
    expect(invoke).toHaveBeenLastCalledWith(identity);
  });

  it("serializes simultaneous initial claims without replaying mutations", async () => {
    const session = new AgentMcpHandshakeSession();
    let firstFinished!: (result: CallToolResult) => void;
    const first = session.call(OFFER, "get_workspace_instructions", identity, async () => await new Promise((resolve) => {
      firstFinished = resolve;
    }));
    const secondInvoke = vi.fn(async () => success);
    const second = session.call(OFFER, "get_workspace_instructions", {}, secondInvoke);
    await Promise.resolve();
    expect(secondInvoke).not.toHaveBeenCalled();
    const mutation = vi.fn(async () => error("engine_busy"));
    await session.call(OFFER, "submit_workspace_batch", {}, mutation);
    expect(mutation).toHaveBeenCalledTimes(1);
    firstFinished(error("approval_pending", { approval_token: TOKEN, requested_scopes: identity.requested_scopes }));
    await Promise.all([first, second]);
    expect(secondInvoke).toHaveBeenCalledExactlyOnceWith({ ...identity, approval_token: TOKEN });
  });

  it("does not resurrect a token from a late response after reset", async () => {
    const session = new AgentMcpHandshakeSession();
    let finish!: (result: CallToolResult) => void;
    const pending = session.call(OFFER, "get_workspace_instructions", identity, async () => await new Promise((resolve) => {
      finish = resolve;
    }));
    await Promise.resolve();
    session.clear();
    finish(error("approval_pending", { approval_token: TOKEN }));
    await pending;
    const invoke = vi.fn(async () => success);
    await session.call(OFFER, "get_workspace_instructions", identity, invoke);
    expect(invoke).toHaveBeenCalledWith(identity);
  });

  it("does not dispatch a cancelled queued instruction or poison the queue", async () => {
    const session = new AgentMcpHandshakeSession();
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const invoke = vi.fn(async () => success);
    await expect(session.call(OFFER, "get_workspace_instructions", identity, invoke, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
    await session.call(OFFER, "get_workspace_instructions", identity, invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
