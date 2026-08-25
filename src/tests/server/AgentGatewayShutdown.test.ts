import { describe, expect, it, vi } from "vitest";
import { closeAgentGatewayStack } from "../../../server/agent/shutdown";

describe("Agent Gateway process shutdown", () => {
  it("stops admission first and waits for slow cleanup before resolving", async () => {
    const events: string[] = [];
    let finishServerClose!: () => void;
    const serverClosed = new Promise<void>((resolve) => { finishServerClose = resolve; });
    const server = {
      close(callback: (error?: Error) => void) {
        events.push("server-stop-admission");
        void serverClosed.then(() => {
          events.push("server-closed");
          callback();
        });
      },
    };
    const gateway = { close: vi.fn(() => { events.push("gateway-revoked"); }) };
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const handler = {
      close: vi.fn(async () => {
        events.push("cleanup-started");
        await cleanup;
        events.push("cleanup-finished");
      }),
    };

    let resolved = false;
    const operation = closeAgentGatewayStack({ server, gateway, handler, timeoutMs: 1_000 })
      .then(() => { resolved = true; });
    await Promise.resolve();
    expect(events.slice(0, 3)).toEqual([
      "server-stop-admission",
      "gateway-revoked",
      "cleanup-started",
    ]);
    finishServerClose();
    await serverClosed;
    expect(resolved).toBe(false);
    finishCleanup();
    await operation;
    expect(events).toEqual([
      "server-stop-admission",
      "gateway-revoked",
      "cleanup-started",
      "server-closed",
      "cleanup-finished",
    ]);
  });

  it("fails safely on timeout instead of reporting a clean shutdown", async () => {
    const never = new Promise<void>(() => undefined);
    await expect(closeAgentGatewayStack({
      server: { close: () => undefined },
      gateway: { close: () => undefined },
      handler: { close: () => never },
      timeoutMs: 5,
    })).rejects.toThrow("cleanup deadline");
  });
});
