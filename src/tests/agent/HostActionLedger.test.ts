import { describe, expect, it } from "vitest";
import { HostActionLedger } from "../../agent/HostActionLedger";

describe("HostActionLedger", () => {
  it("deduplicates one pending request and blocks prompt replacement", () => {
    const ledger = new HostActionLedger(() => 1_000, () => "action-1");
    const first = ledger.request({ kind: "enter_immersive_xr", label: "Enter XR", dedupeKey: "enter", trustEpoch: 1 });
    expect(ledger.request({
      kind: "enter_immersive_xr",
      label: "Enter XR",
      dedupeKey: "enter",
      trustEpoch: 1,
    })).toBe(first);
    expect(() => ledger.request({ kind: "arm_voice_relay", label: "Arm", dedupeKey: "arm", trustEpoch: 1 }))
      .toThrow(/already awaiting/u);
  });

  it("expires without retaining an Agent action", () => {
    let now = 1_000;
    const ledger = new HostActionLedger(() => now, () => "action-1");
    ledger.request({ kind: "arm_voice_relay", label: "Arm", dedupeKey: "arm", trustEpoch: 1, ttlMs: 1_000 });
    now = 2_000;
    expect(ledger.current()).toBeUndefined();
  });

  it("cannot confirm or deduplicate an action across a trust-epoch boundary", () => {
    let nextId = 0;
    const ledger = new HostActionLedger(() => 1_000, () => `action-${++nextId}`);
    const stale = ledger.request({ kind: "arm_voice_relay", label: "Arm", dedupeKey: "arm", trustEpoch: 3 });

    expect(() => ledger.decide(stale.action_id, "confirmed", 4)).toThrow(/no longer pending/u);

    const fresh = ledger.request({ kind: "arm_voice_relay", label: "Arm", dedupeKey: "arm", trustEpoch: 4 });
    expect(fresh.action_id).not.toBe(stale.action_id);
    expect(ledger.decide(fresh.action_id, "confirmed", 4)).toBe("confirmed");
  });
});
