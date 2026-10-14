import { afterEach, describe, expect, it } from "vitest";
import {
  AgentGateway,
  type AgentGatewayOptions,
} from "../../../server/agent/AgentGateway";

const START = Date.parse("2026-10-13T04:00:00.000Z");
const gateways: AgentGateway[] = [];

function setup(overrides: Partial<AgentGatewayOptions> = {}) {
  let time = START;
  const gateway = new AgentGateway({
    publicBaseUrl: "http://127.0.0.1:8788",
    workspaceRoot: "/workspace/SemaFrame",
    commandTimeoutMs: 1_000,
    pollTimeoutMs: 1,
    browserTtlMs: 24 * 60 * 60_000,
    now: () => time,
    ...overrides,
  });
  gateways.push(gateway);
  gateway.setEnabled(true);
  const { browserConnectionId } = gateway.registerBrowser("approval-lifecycle-browser");
  return {
    gateway,
    browserConnectionId,
    setTime: (elapsed: number) => { time = START + elapsed; },
    path: () => new URL(gateway.getConfig().connectionUrl!).pathname,
  };
}

type Fixture = ReturnType<typeof setup>;
type Claim = Readonly<{
  path: string;
  token: string;
  id: string;
  fingerprint: string;
}>;

async function claim(fixture: Fixture): Promise<Claim> {
  const path = fixture.path();
  const response = await fixture.gateway.dispatchOffer(path, "get_workspace_instructions", {
    client_id: "approved-readonly-agent",
    client_name: "Read-only agent",
    requested_scopes: ["workspace:read"],
  }, {});
  const body = response.payload as { error: { code: string; details: {
    approval_token: string;
    approval_fingerprint: string;
    claim_id: string;
  } } };
  expect(body.error.code).toBe("approval_pending");
  return {
    path,
    token: body.error.details.approval_token,
    id: body.error.details.claim_id,
    fingerprint: body.error.details.approval_fingerprint,
  };
}

function redeem(fixture: Fixture, request: Claim, extra: Record<string, unknown> = {}) {
  return fixture.gateway.dispatchOffer(request.path, "get_workspace_instructions", {
    approval_token: request.token,
    ...extra,
  }, {});
}

async function complete(fixture: Fixture) {
  const poll = await fixture.gateway.pollBrowser(fixture.browserConnectionId);
  expect(poll.kind).toBe("command");
  if (poll.kind !== "command") throw new Error("Expected an instruction command");
  fixture.gateway.submitBrowserResult({
    browserConnectionId: fixture.browserConnectionId,
    commandId: poll.command.id,
    ok: true,
    result: { ok: true, data: {
      guide_digest: "sha256:test-guide",
      session_token: "private-core-session",
      granted_scopes: ["workspace:read"],
    } },
  });
  return poll.command;
}

afterEach(() => gateways.splice(0).forEach((gateway) => gateway.close()));

describe("bounded post-approval instruction redemption", () => {
  it.each(["core", "full"])("forwards explicit %s guide detail without changing the approved identity or exposing claim proof", async (detail) => {
    const fixture = setup();
    const request = await claim(fixture);
    fixture.gateway.approveClaim(request.id);
    const pending = redeem(fixture, request, {
      detail,
      client_id: "unapproved-retry-identity",
      client_name: "Unapproved retry name",
      requested_scopes: ["workspace:read", "workspace:write"],
    });
    const command = await complete(fixture);
    expect((await pending).responseOk).toBe(true);
    expect(command.input).toEqual({
      client_id: "approved-readonly-agent",
      client_name: "Read-only agent",
      requested_scopes: ["workspace:read"],
      detail,
    });
    expect(command.input).not.toHaveProperty("approval_token");
  });

  it("keeps pending approval at two minutes but starts a new ten-minute window at first approval", async () => {
    const fixture = setup();
    const request = await claim(fixture);
    expect(fixture.gateway.getConfig().pendingApproval?.expiresAt).toBe(new Date(START + 120_000).toISOString());
    fixture.setTime(119_000);
    fixture.gateway.approveClaim(request.id);
    const approved = fixture.gateway.getConfig();
    expect(approved.approvedHandshake).toEqual({
      clientId: "approved-readonly-agent",
      clientName: "Read-only agent",
      scopes: ["workspace:read"],
      fingerprint: request.fingerprint,
      approvedAt: new Date(START + 119_000).toISOString(),
      expiresAt: new Date(START + 719_000).toISOString(),
      status: "waiting",
    });
    expect(approved.pendingApproval).toBeUndefined();
    expect(approved.connected).toBe(false);
    fixture.setTime(121_000);
    const pending = redeem(fixture, request);
    expect(fixture.gateway.getConfig().approvedHandshake?.status).toBe("in_flight");
    await complete(fixture);
    expect((await pending).responseOk).toBe(true);
    expect(fixture.gateway.getConfig()).toMatchObject({ connected: true, offerStatus: "approved" });
    expect(fixture.gateway.getConfig().approvedHandshake).toBeUndefined();
  });

  it("gives approval near original offer expiry the complete new bounded window", async () => {
    const fixture = setup({ offerTtlMs: 100, approvalTtlMs: 50, approvedHandshakeTtlMs: 200 });
    fixture.setTime(95);
    const request = await claim(fixture);
    fixture.setTime(99);
    fixture.gateway.approveClaim(request.id);
    expect(fixture.gateway.getConfig()).toMatchObject({
      offerExpiresAt: new Date(START + 299).toISOString(),
      approvedHandshake: { expiresAt: new Date(START + 299).toISOString() },
    });
    fixture.setTime(250);
    const pending = redeem(fixture, request);
    await complete(fixture);
    expect((await pending).responseOk).toBe(true);
  });

  it("does not let repeated approval renew the original approval time or redemption deadline", async () => {
    const fixture = setup({ approvedHandshakeTtlMs: 200 });
    const request = await claim(fixture);
    fixture.setTime(20);
    fixture.gateway.approveClaim(request.id);
    const original = fixture.gateway.getConfig();
    fixture.setTime(219);
    fixture.gateway.approveClaim(request.id);
    expect(fixture.gateway.getConfig().approvedHandshake).toEqual(original.approvedHandshake);
    expect(fixture.gateway.getConfig().offerExpiresAt).toBe(original.offerExpiresAt);
    fixture.setTime(220);
    expect(() => fixture.gateway.approveClaim(request.id)).toThrow(/invalid or expired/u);
    expect(fixture.gateway.getConfig().connectionNotice?.reason).toBe("handshake_expired");
  });

  it("invalidates expired capabilities, retains safe recovery notice, and clears it for a fresh claim", async () => {
    const fixture = setup({ offerTtlMs: 100, approvalTtlMs: 50, approvedHandshakeTtlMs: 200 });
    const request = await claim(fixture);
    fixture.gateway.approveClaim(request.id);
    fixture.setTime(200);
    const expired = fixture.gateway.getConfig();
    expect(expired).toMatchObject({
      connected: false,
      offerStatus: "waiting",
      connectionNotice: { reason: "handshake_expired", occurredAt: new Date(START + 200).toISOString() },
    });
    expect(expired.approvedHandshake).toBeUndefined();
    expect(new URL(expired.connectionUrl!).pathname).not.toBe(request.path);
    expect(await redeem(fixture, request)).toMatchObject({
      responseOk: false, payload: { error: { code: "connection_invalid" } },
    });
    expect(await fixture.gateway.dispatchOffer(fixture.path(), "get_workspace_instructions", {
      approval_token: request.token,
    }, {})).toMatchObject({ responseOk: false, payload: { error: { code: "approval_invalid" } } });
    fixture.setTime(301);
    const later = fixture.gateway.getConfig();
    expect(later.connectionNotice).toEqual(expired.connectionNotice);
    const fresh = await claim(fixture);
    expect(fresh.token).not.toBe(request.token);
    expect(fixture.gateway.getConfig().connectionNotice).toBeUndefined();
    expect(fixture.gateway.getConfig().offerStatus).toBe("approval_pending");
  });

  it("expires pending claims unchanged and distinguishes an unclaimed offer expiry", async () => {
    const fixture = setup({ approvalTtlMs: 50, offerTtlMs: 100 });
    const request = await claim(fixture);
    fixture.setTime(50);
    expect(() => fixture.gateway.approveClaim(request.id)).toThrow(/invalid or expired/u);
    expect(fixture.gateway.getConfig().connectionNotice).toEqual({
      reason: "approval_expired", occurredAt: new Date(START + 50).toISOString(),
    });
    fixture.gateway.refreshOffer();
    expect(fixture.gateway.getConfig().connectionNotice).toBeUndefined();
    fixture.setTime(150);
    expect(fixture.gateway.getConfig().connectionNotice?.reason).toBe("offer_expired");
    fixture.gateway.setEnabled(false);
    expect(fixture.gateway.getConfig().connectionNotice).toBeUndefined();
    fixture.gateway.setEnabled(true);
    expect(fixture.gateway.getConfig().connectionNotice).toBeUndefined();
    fixture.setTime(250);
    expect(fixture.gateway.getConfig().connectionNotice?.reason).toBe("offer_expired");
    fixture.gateway.rotatePairing();
    expect(fixture.gateway.getConfig().connectionNotice).toBeUndefined();
  });

  it("lets a bounded in-flight handshake finish beyond expiry and keeps completed connections active", async () => {
    const fixture = setup({ offerTtlMs: 100, approvedHandshakeTtlMs: 200 });
    const request = await claim(fixture);
    fixture.gateway.approveClaim(request.id);
    fixture.setTime(199);
    const pending = redeem(fixture, request);
    fixture.setTime(300);
    expect(fixture.gateway.getConfig()).toMatchObject({
      connectionUrl: expect.stringContaining(request.path),
      offerStatus: "approval_granted",
      approvedHandshake: { status: "in_flight", expiresAt: new Date(START + 200).toISOString() },
    });
    await complete(fixture);
    expect((await pending).responseOk).toBe(true);
    fixture.setTime(900_000);
    expect(fixture.gateway.getConfig()).toMatchObject({
      connected: true, offerStatus: "approved", connectionUrl: expect.stringContaining(request.path),
    });
    expect(fixture.gateway.getConfig().approvedHandshake).toBeUndefined();
    expect(fixture.gateway.getConfig().connectionNotice).toBeUndefined();
  });

  it("does not renew approval on transient failure and expires after an overdue in-flight failure", async () => {
    const fixture = setup({ approvedHandshakeTtlMs: 200 });
    const request = await claim(fixture);
    fixture.gateway.approveClaim(request.id);
    const original = fixture.gateway.getConfig().approvedHandshake;
    const first = redeem(fixture, request);
    const busy = await redeem(fixture, request);
    expect(busy).toMatchObject({ responseOk: false, payload: { error: { code: "engine_busy" } } });
    expect(fixture.gateway.getConfig().approvedHandshake?.expiresAt).toBe(original?.expiresAt);
    const poll = await fixture.gateway.pollBrowser(fixture.browserConnectionId);
    if (poll.kind !== "command") throw new Error("Expected a command");
    fixture.setTime(201);
    fixture.gateway.submitBrowserResult({
      browserConnectionId: fixture.browserConnectionId,
      commandId: poll.command.id,
      ok: false,
      error: { code: "engine_timeout", message: "Transient test failure" },
    });
    expect(await first).toMatchObject({ responseOk: false, payload: { error: { code: "engine_timeout" } } });
    expect(fixture.gateway.getConfig().connectionNotice?.reason).toBe("handshake_expired");
  });

  it("rotates after the real bounded command timer expires and rejects the old proof", async () => {
    const fixture = setup({ commandTimeoutMs: 25, approvedHandshakeTtlMs: 200 });
    const request = await claim(fixture);
    fixture.gateway.approveClaim(request.id);
    fixture.setTime(199);
    const pending = redeem(fixture, request);
    fixture.setTime(201);
    expect(fixture.gateway.getConfig().approvedHandshake?.status).toBe("in_flight");
    expect(await pending).toMatchObject({
      responseOk: false, payload: { error: { code: "engine_timeout" } },
    });
    expect(fixture.gateway.getConfig()).toMatchObject({
      offerStatus: "waiting",
      connectionNotice: { reason: "handshake_expired" },
    });
    expect(fixture.gateway.getConfig().approvedHandshake).toBeUndefined();
    expect(await redeem(fixture, request)).toMatchObject({
      responseOk: false, payload: { error: { code: "connection_invalid" } },
    });
    expect(await fixture.gateway.dispatchOffer(fixture.path(), "get_workspace_instructions", {
      approval_token: request.token,
    }, {})).toMatchObject({ responseOk: false, payload: { error: { code: "approval_invalid" } } });
  });

  it("pins approved identity/scopes and keeps approval/session secrets out of public config", async () => {
    const fixture = setup();
    const request = await claim(fixture);
    const bearer = fixture.gateway.revealPairing().pairingBearer;
    fixture.gateway.approveClaim(request.id);
    const publicConfig = JSON.stringify(fixture.gateway.getConfig());
    for (const secret of [request.token, bearer, "tokenHash", "approval_token", "session_token"]) {
      expect(publicConfig).not.toContain(secret);
    }
    const pending = redeem(fixture, request, {
      client_id: "impostor",
      client_name: "Different name",
      requested_scopes: ["workspace:read", "workspace:write", "component:delete"],
    });
    const command = await complete(fixture);
    expect(command.input).toEqual({
      client_id: "approved-readonly-agent", client_name: "Read-only agent", requested_scopes: ["workspace:read"],
    });
    await pending;
    expect(fixture.gateway.getConfig().clientScopes).toEqual(["workspace:read"]);
    expect(JSON.stringify(fixture.gateway.getConfig())).not.toContain("private-core-session");
    expect(() => fixture.gateway.requireApprovedClientScope("workspace:write", {
      approvalToken: request.token,
    })).toThrow(/does not include/u);
  });

  it("keeps wrong tokens, denial, and explicit revocation fail-closed", async () => {
    const fixture = setup();
    const request = await claim(fixture);
    fixture.gateway.approveClaim(request.id);
    expect(await redeem(fixture, { ...request, token: "x".repeat(43) })).toMatchObject({
      responseOk: false, payload: { error: { code: "approval_invalid" } },
    });
    fixture.gateway.denyClaim(request.id);
    expect(fixture.gateway.getConfig().approvedHandshake).toBeUndefined();
    expect(() => fixture.gateway.approveClaim(request.id)).toThrow(/already denied/u);
    expect(await redeem(fixture, request)).toMatchObject({
      responseOk: false, payload: { error: { code: "approval_denied" } },
    });
    fixture.gateway.refreshOffer();
    const fresh = await claim(fixture);
    fixture.gateway.approveClaim(fresh.id);
    fixture.gateway.rotatePairing();
    expect(await redeem(fixture, fresh)).toMatchObject({
      responseOk: false, payload: { error: { code: "connection_invalid" } },
    });
    expect(fixture.gateway.getConfig().approvedHandshake).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid redemption window %s", (approvedHandshakeTtlMs) => {
    expect(() => setup({ approvedHandshakeTtlMs })).toThrow(/approvedHandshakeTtlMs must be a positive integer/u);
  });
});
