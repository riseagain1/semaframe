// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import { createAgentGatewayHttpHandler } from "../../../server/agent/AgentGatewayHttpHandler";

const base = "http://127.0.0.1:8788";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

describe("public REST component reservation contract", () => {
  it("forwards zero unchanged, preserves omission, and rejects values outside integer 0–100 before dispatch", async () => {
    const gateway = new AgentGateway({ publicBaseUrl: base, workspaceRoot: process.cwd() });
    const handle = createAgentGatewayHttpHandler(gateway, {
      allowedOrigins: ["http://127.0.0.1:4173"], publicBaseUrl: base,
      browserBootstrapToken: "b".repeat(43),
    });
    cleanups.push(async () => { await handle.close(); gateway.close(); });
    gateway.setEnabled(true);
    const bearer = gateway.revealPairing().pairingBearer;
    const dispatch = vi.spyOn(gateway, "dispatch").mockResolvedValue({ ok: true, data: {} });
    const session = { session_token: "workspace_session_example", instruction_digest: "workspace_guide_digest" };
    const send = (requested_component_ids: unknown) => handle(new Request(`${base}/v1/workspace/updates/begin`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...session, intent: "Edit existing part", requested_component_ids }),
    }));
    for (const count of [0, 1, 100, undefined]) {
      expect((await send(count)).status).toBe(200);
      const input = dispatch.mock.calls.at(-1)?.[1];
      if (count === undefined) expect(input).not.toHaveProperty("requested_component_ids");
      else expect(input).toMatchObject({ requested_component_ids: count });
    }
    expect(dispatch).toHaveBeenCalledTimes(4);
    for (const count of [-1, 0.5, 100.5, 101, Number.MAX_SAFE_INTEGER, "0", null]) {
      const response = await send(count);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(dispatch).toHaveBeenCalledTimes(4);
  });
});
