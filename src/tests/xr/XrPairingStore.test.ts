import { describe, expect, it } from "vitest";
import {
  XrPairingError,
  XrPairingStore,
} from "../../../server/xr/XrPairingStore";

function deterministicStore(now: () => number) {
  let tokenCursor = 0;
  let codeCursor = 0;
  let idCursor = 0;
  return new XrPairingStore({
    now,
    tokenFactory: () => Buffer.alloc(32, ++tokenCursor).toString("base64url"),
    pairingCodeFactory: () => String(++codeCursor).padStart(6, "0"),
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
      pairingCode: "000001",
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000001",
      expiresAtMs: 2_000,
    });
    expect(() => store.consumeToken(grant.pairingCode)).toThrowError(expect.objectContaining({
      code: "pairing_invalid",
    }));
    expect(() => store.consumeCode(grant.pairingToken)).toThrowError(expect.objectContaining({
      code: "pairing_invalid",
    }));
    expect(store.consumeCode(grant.pairingCode)).toMatchObject({ pairingId: grant.pairingId });
    expect(() => store.consumeToken(grant.pairingToken)).toThrowError(expect.objectContaining({
      code: "pairing_consumed",
    }));
    const tokenGrant = store.create({
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000001",
    });
    expect(store.consumeToken(tokenGrant.pairingToken)).toMatchObject({ pairingId: tokenGrant.pairingId });
    expect(() => store.consumeCode(tokenGrant.pairingCode)).toThrowError(expect.objectContaining({
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
    expect(() => store.consumeToken(expired.pairingToken)).toThrowError(expect.objectContaining({
      code: "pairing_expired",
    }));

    const revoked = store.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000002" });
    expect(store.revoke(revoked.pairingId)).toBe(true);
    expect(() => store.consumeCode(revoked.pairingCode)).toThrowError(expect.objectContaining({
      code: "pairing_revoked",
    }));

    const epochA = store.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000003" });
    const epochB = store.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000004" });
    expect(store.revokeAuthorityEpoch("epoch-000003")).toEqual([epochA.pairingId]);
    expect(() => store.consumeToken(epochA.pairingToken)).toThrowError(expect.objectContaining({
      code: "pairing_revoked",
    }));
    expect(() => store.consumeToken(epochB.pairingToken)).not.toThrow();

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
    expect(() => store.consumeToken("not-a-capability")).toThrow(XrPairingError);
    expect(() => store.consumeCode("12345")).toThrow(XrPairingError);
  });

  it("reserves consumed and revoked codes until their original expiry", () => {
    let now = 1_000;
    let tokenCursor = 0;
    let idCursor = 0;
    const codeCandidates = [
      "123456",
      "123456", "234567",
      "345678",
      "345678", "456789",
      "123456",
    ];
    const store = new XrPairingStore({
      now: () => now,
      tokenFactory: () => Buffer.alloc(32, ++tokenCursor).toString("base64url"),
      pairingCodeFactory: () => {
        const candidate = codeCandidates.shift();
        if (!candidate) throw new Error("pairing code fixture exhausted");
        return candidate;
      },
      idFactory: () => `pairing-${String(++idCursor).padStart(4, "0")}`,
    });

    const consumed = store.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000001" });
    expect(consumed.pairingCode).toBe("123456");
    store.consumeCode(consumed.pairingCode);
    expect(store.create({
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000001",
    }).pairingCode).toBe("234567");

    const revoked = store.create({ workspaceId: "workspace-xr", authorityEpoch: "epoch-000001" });
    expect(revoked.pairingCode).toBe("345678");
    store.revoke(revoked.pairingId);
    expect(store.create({
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000001",
    }).pairingCode).toBe("456789");

    now = 121_000;
    expect(store.create({
      workspaceId: "workspace-xr",
      authorityEpoch: "epoch-000001",
    }).pairingCode).toBe("123456");
  });
});
