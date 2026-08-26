import { describe, expect, it } from "vitest";
import {
  XrPairingError,
  XrPairingStore,
} from "../../../server/xr/XrPairingStore";

function deterministicStore(now: () => number) {
  let tokenCursor = 0;
  let idCursor = 0;
  return new XrPairingStore({
    now,
    tokenFactory: () => Buffer.alloc(32, ++tokenCursor).toString("base64url"),
    idFactory: () => `pairing-${String(++idCursor).padStart(4, "0")}`,
  });
}

describe("XrPairingStore", () => {
  it("mints a bounded capability and consumes it exactly once", () => {
    let now = 1_000;
    const store = deterministicStore(() => now);
    const grant = store.create({
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000001",
      ttlMs: 1_000,
    });
    expect(grant).toEqual({
      pairingId: "pairing-0001",
      pairingToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000001",
      expiresAtMs: 2_000,
    });
    expect(store.consume(grant.pairingToken)).toMatchObject({ pairingId: grant.pairingId });
    expect(() => store.consume(grant.pairingToken)).toThrowError(expect.objectContaining({
      code: "pairing_consumed",
    }));
    now += 1;
  });

  it("fails closed on expiry, explicit revoke, epoch revoke, and malformed input", () => {
    let now = 10_000;
    const store = deterministicStore(() => now);
    const expired = store.create({
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000001",
      ttlMs: 10,
    });
    now = 10_010;
    expect(() => store.consume(expired.pairingToken)).toThrowError(expect.objectContaining({
      code: "pairing_expired",
    }));

    const revoked = store.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000002" });
    expect(store.revoke(revoked.pairingId)).toBe(true);
    expect(() => store.consume(revoked.pairingToken)).toThrowError(expect.objectContaining({
      code: "pairing_revoked",
    }));

    const epochA = store.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000003" });
    const epochB = store.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000004" });
    expect(store.revokeAuthorityEpoch("epoch-000003")).toEqual([epochA.pairingId]);
    expect(() => store.consume(epochA.pairingToken)).toThrowError(expect.objectContaining({
      code: "pairing_revoked",
    }));
    expect(() => store.consume(epochB.pairingToken)).not.toThrow();

    expect(() => store.create({
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000005",
      extra: true,
    })).toThrow(/unknown field/u);
    expect(() => store.create({
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000005",
      ttlMs: "1000",
    })).toThrow(/ttlMs/u);
    const inherited = Object.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000005" });
    expect(() => store.create(inherited)).toThrow(/must be an object/u);
    expect(() => store.consume("not-a-capability")).toThrow(XrPairingError);
  });
});
