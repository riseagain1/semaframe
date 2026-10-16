import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway, type AgentGatewayOptions } from "../../../server/agent/AgentGateway";
import type { BrowserAgentCommand } from "../../../server/agent/contracts";

const gateways: AgentGateway[] = [];

function setup(options: Partial<AgentGatewayOptions> = {}) {
  const gateway = new AgentGateway({
    publicBaseUrl: "http://127.0.0.1:8788",
    workspaceRoot: "/workspace/SemaFrame",
    commandTimeoutMs: 1_000,
    pollTimeoutMs: 1,
    browserTtlMs: 10_000,
    ...options,
  });
  gateways.push(gateway);
  gateway.setEnabled(true);
  const { browserConnectionId } = gateway.registerBrowser("queue-test-browser");
  return {
    gateway,
    browserConnectionId,
    async next() {
      const poll = await gateway.pollBrowser(browserConnectionId);
      expect(poll.kind).toBe("command");
      if (poll.kind !== "command") throw new Error("Expected a queued command");
      return poll.command;
    },
    complete(command: BrowserAgentCommand, result: unknown = { ok: true, data: {} }) {
      gateway.submitBrowserResult({ browserConnectionId, commandId: command.id, ok: true, result });
    },
  };
}

type Fixture = ReturnType<typeof setup>;

async function approved(fixture: Fixture, completeHandshake = true) {
  const path = new URL(fixture.gateway.getConfig().connectionUrl!).pathname;
  const response = await fixture.gateway.dispatchOffer(path, "get_workspace_instructions", {
    client_id: "queue-agent", client_name: "Queue Agent", requested_scopes: ["workspace:read"],
  }, {});
  const details = (response.payload as { error: { details: { approval_token: string; claim_id: string } } }).error.details;
  fixture.gateway.approveClaim(details.claim_id);
  const redeem = () => fixture.gateway.dispatchOffer(path, "get_workspace_instructions", { approval_token: details.approval_token }, {});
  if (completeHandshake) {
    const handshake = redeem();
    fixture.complete(await fixture.next(), { ok: true, data: { granted_scopes: ["workspace:read"] } });
    expect((await handshake).responseOk).toBe(true);
  }
  return { path, redeem, claimId: details.claim_id };
}

afterEach(() => {
  gateways.splice(0).forEach((gateway) => gateway.close());
  vi.useRealTimers();
});

describe("bounded serial browser command queue", () => {
  it("answers parallel reads in FIFO order, once each, without engine_busy", async () => {
    const fixture = setup();
    const requests = Array.from({ length: 8 }, (_, index) => fixture.gateway.dispatch("inspect_workspace", { index }));
    const ids = new Set<string>();
    for (let index = 0; index < requests.length; index += 1) {
      const command = await fixture.next();
      expect(command.input).toEqual({ index });
      ids.add(command.id);
      // Concurrent polls must not receive an already-delivered command, or
      // receive the next command before the current result is acknowledged.
      expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
      fixture.complete(command, { ok: true, data: { index } });
      expect(await requests[index]).toEqual({ ok: true, data: { index } });
      expect(() => fixture.complete(command)).toThrow(/no longer awaiting/u);
    }
    expect(ids.size).toBe(8);
  });

  it("keeps reads and writes ordered and passes stale transaction failures through without replay", async () => {
    const fixture = setup();
    const requestOne = fixture.gateway.dispatch("inspect_workspace", { order: 1 });
    const staleWrite = fixture.gateway.dispatch("submit_workspace_batch", { expected_workspace_revision: 1 });
    const requestThree = fixture.gateway.dispatch("inspect_workspace", { order: 3 });
    fixture.complete(await fixture.next(), { ok: true, data: { revision: 2 } });
    await requestOne;
    const mutation = await fixture.next();
    expect(mutation.name).toBe("submit_workspace_batch");
    const rejection = { ok: false, error: { code: "workspace_revision_conflict", retryable: false } };
    fixture.complete(mutation, rejection);
    expect(await staleWrite).toEqual(rejection);
    const last = await fixture.next();
    expect(last.input).toEqual({ order: 3 });
    fixture.complete(last);
    await requestThree;
    expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
  });

  it("bounds waiting work without evicting an earlier request", async () => {
    const fixture = setup({ commandQueueLimit: 2 });
    const requests = [1, 2, 3].map((index) => fixture.gateway.dispatch("inspect_workspace", { index }));
    expect(() => fixture.gateway.dispatch("inspect_workspace", { index: 4 })).toThrow(/queue is full/u);
    for (const [index, request] of requests.entries()) {
      const command = await fixture.next();
      expect(command.input).toEqual({ index: index + 1 });
      fixture.complete(command);
      await request;
    }
    const next = fixture.gateway.dispatch("inspect_workspace", { index: 5 });
    fixture.complete(await fixture.next());
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it.each(["disable", "rotate", "takeover", "unregister", "close"] as const)(
    "rejects all waiting work on %s and cannot replay it on a new browser",
    async (action) => {
      const fixture = setup();
      const responses = [1, 2, 3].map((index) => fixture.gateway.dispatch("submit_workspace_batch", { index }).catch((error: unknown) => error));
      const command = await fixture.next();
      const expected = action === "disable" ? "agent_mode_disabled" : action === "rotate" ? "pairing_rotated"
        : action === "takeover" ? "browser_replaced" : action === "unregister" ? "engine_unavailable" : "gateway_closed";
      if (action === "disable") fixture.gateway.setEnabled(false);
      if (action === "rotate") fixture.gateway.rotatePairing();
      if (action === "takeover") fixture.gateway.takeoverBrowser("queue-new-browser");
      if (action === "unregister") fixture.gateway.unregisterBrowser(fixture.browserConnectionId);
      if (action === "close") fixture.gateway.close();
      for (const response of responses) expect(await response).toMatchObject({ code: expected });
      if (action === "rotate") {
        expect(() => fixture.gateway.dispatch("inspect_workspace", {})).toThrow(/still finishing/u);
        fixture.complete(command);
        expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
      } else {
        expect(() => fixture.complete(command)).toThrow();
      }
    },
  );

  it("invalidates a queued approved claim on refresh without cancelling unrelated legacy work", async () => {
    const fixture = setup();
    const claim = await approved(fixture);
    const legacy = fixture.gateway.dispatch("inspect_workspace", { legacy: true });
    const queued = fixture.gateway.dispatchOffer(claim.path, "inspect_workspace", {}, {});
    fixture.gateway.refreshOffer();
    expect(await queued).toMatchObject({ payload: { error: { code: "connection_invalid" } } });
    const command = await fixture.next();
    expect(command.input).toEqual({ legacy: true });
    fixture.complete(command);
    expect(await legacy).toMatchObject({ ok: true });
    expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
  });

  it("does not resurrect a delivered claim after refresh while an old result is outstanding", async () => {
    const fixture = setup();
    const claim = await approved(fixture);
    const active = fixture.gateway.dispatchOffer(claim.path, "inspect_workspace", {}, {});
    const queued = fixture.gateway.dispatchOffer(claim.path, "inspect_workspace", {}, {});
    const command = await fixture.next();
    fixture.gateway.refreshOffer();
    expect(await active).toMatchObject({ payload: { error: { code: "connection_invalid" } } });
    expect(await queued).toMatchObject({ payload: { error: { code: "connection_invalid" } } });
    expect(() => fixture.gateway.dispatch("inspect_workspace", {})).toThrow(/still finishing/u);
    fixture.complete(command);
    expect(fixture.gateway.getConfig().connected).toBe(false);
    expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
  });

  it("rechecks expiry before a queued handshake starts", async () => {
    let time = 0;
    const fixture = setup({ now: () => time, approvedHandshakeTtlMs: 50 });
    const claim = await approved(fixture, false);
    const legacy = fixture.gateway.dispatch("inspect_workspace", {});
    const queuedHandshake = claim.redeem();
    expect(fixture.gateway.getConfig().approvedHandshake?.status).toBe("waiting");
    time = 51;
    fixture.complete(await fixture.next());
    await legacy;
    expect(await queuedHandshake).toMatchObject({ payload: { error: { code: "connection_offer_expired" } } });
    expect(fixture.gateway.getConfig().offerStatus).toBe("waiting");
    expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
  });

  it("denial cancels an approved-but-queued handshake before browser execution", async () => {
    const fixture = setup();
    const claim = await approved(fixture, false);
    const legacy = fixture.gateway.dispatch("inspect_workspace", {});
    const handshake = claim.redeem();
    fixture.gateway.denyClaim(claim.claimId);
    expect(await handshake).toMatchObject({ payload: { error: { code: "approval_denied" } } });
    fixture.complete(await fixture.next());
    await legacy;
    expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
  });

  it.each(["core", "transport"] as const)("revokes a fatal %s handshake before another queued redemption can reach the browser", async (failure) => {
    const fixture = setup();
    const claim = await approved(fixture, false);
    const first = claim.redeem();
    const second = claim.redeem();
    const command = await fixture.next();
    if (failure === "core") {
      fixture.complete(command, { ok: false, error: { code: "invalid_request", retryable: false } });
    } else {
      fixture.gateway.submitBrowserResult({
        browserConnectionId: fixture.browserConnectionId, commandId: command.id,
        ok: false, error: { code: "invalid_request", message: "Rejected handshake" },
      });
    }
    // Poll synchronously before either dispatchOffer promise continuation.
    expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
    expect(await first).toMatchObject({ payload: { error: { code: "invalid_request" } } });
    expect(await second).toMatchObject({ payload: { error: { code: "connection_invalid" } } });
    expect(fixture.gateway.getConfig().offerStatus).toBe("waiting");
  });

  it("bounds total waiting time and never runs a queued mutation after an uncertain delivered timeout", async () => {
    vi.useFakeTimers();
    const fixture = setup({ commandTimeoutMs: 100 });
    const first = fixture.gateway.dispatch("submit_workspace_batch", { transaction_token: "one" }).catch((error: unknown) => error);
    const queued = fixture.gateway.dispatch("submit_workspace_batch", { transaction_token: "two" }).catch((error: unknown) => error);
    const command = await fixture.next();
    await vi.advanceTimersByTimeAsync(101);
    expect(await first).toMatchObject({ code: "engine_timeout", details: { command_dispatched: true, mutation_outcome: "unknown" } });
    expect(await queued).toMatchObject({ code: "engine_timeout", details: { command_dispatched: false } });
    expect(() => fixture.gateway.dispatch("inspect_workspace", {})).toThrow(/still finishing/u);
    fixture.complete(command);
    // A late result releases the barrier, but never resubmits either mutation.
    const fresh = fixture.gateway.dispatch("inspect_workspace", {});
    expect((await fixture.next()).name).toBe("inspect_workspace");
    fixture.gateway.close();
    await expect(fresh).rejects.toMatchObject({ code: "gateway_closed" });
  });

  it("an undelivered timeout is explicit and permits fresh work", async () => {
    vi.useFakeTimers();
    const fixture = setup({ commandTimeoutMs: 100 });
    const pending = fixture.gateway.dispatch("submit_workspace_batch", {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ code: "engine_timeout", details: { command_dispatched: false } });
    const fresh = fixture.gateway.dispatch("inspect_workspace", {});
    fixture.complete(await fixture.next());
    await expect(fresh).resolves.toMatchObject({ ok: true });
  });

  it("keeps the original deadline when queued work becomes active", async () => {
    let time = 0;
    const fixture = setup({ now: () => time, commandTimeoutMs: 100 });
    const first = fixture.gateway.dispatch("inspect_workspace", {});
    const queued = fixture.gateway.dispatch("submit_workspace_batch", {}).catch((error: unknown) => error);
    const command = await fixture.next();
    time = 90;
    fixture.complete(command);
    await first;
    time = 100;
    expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
    expect(await queued).toMatchObject({ code: "engine_timeout", details: { command_dispatched: false } });
  });

  it("checks the deadline at actual poll delivery before delayed timers fire", async () => {
    let time = 0;
    const fixture = setup({ now: () => time, commandTimeoutMs: 100 });
    const pending = fixture.gateway.dispatch("submit_workspace_batch", {}).catch((error: unknown) => error);
    time = 100;
    expect(await fixture.gateway.pollBrowser(fixture.browserConnectionId)).toEqual({ kind: "idle" });
    expect(await pending).toMatchObject({ code: "engine_timeout", details: { command_dispatched: false } });
  });

  it("does not turn an overdue acknowledgement into success before delayed timers fire", async () => {
    let time = 0;
    const fixture = setup({ now: () => time, commandTimeoutMs: 100 });
    const pending = fixture.gateway.dispatch("submit_workspace_batch", {}).catch((error: unknown) => error);
    const command = await fixture.next();
    time = 100;
    fixture.complete(command);
    expect(await pending).toMatchObject({ code: "engine_timeout", details: { command_dispatched: true } });
    const fresh = fixture.gateway.dispatch("inspect_workspace", {});
    fixture.complete(await fixture.next());
    await expect(fresh).resolves.toMatchObject({ ok: true });
  });

  it("rejects invalid queue capacity", () => {
    expect(() => setup({ commandQueueLimit: 0 })).toThrow(/positive integer/u);
    expect(() => setup({ commandQueueLimit: 1.5 })).toThrow(/positive integer/u);
  });
});
