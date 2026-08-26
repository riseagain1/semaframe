import type { RequiredUserAction, RequiredUserActionKind } from "./hostControlContracts";

export type HostActionDecision = "confirmed" | "declined" | "expired";

type PendingHostAction = {
  action: RequiredUserAction;
  dedupeKey: string;
  trustEpoch: number;
  expiresAtMs: number;
};

export class HostActionLedgerError extends Error {
  constructor(readonly code: "host_action_pending" | "host_action_not_found", message: string) {
    super(message);
    this.name = "HostActionLedgerError";
  }
}

/** Keeps at most one visible Agent-requested host action and deduplicates retries. */
export class HostActionLedger {
  private pending?: PendingHostAction;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  request(input: Readonly<{
    kind: RequiredUserActionKind;
    label: string;
    dedupeKey: string;
    trustEpoch: number;
    ttlMs?: number;
  }>): RequiredUserAction {
    this.expire();
    if (!Number.isSafeInteger(input.trustEpoch) || input.trustEpoch < 0) {
      throw new RangeError("Host action trust epoch must be a non-negative safe integer.");
    }
    if (this.pending && this.pending.trustEpoch !== input.trustEpoch) this.pending = undefined;
    if (this.pending) {
      if (this.pending.dedupeKey === input.dedupeKey) return this.pending.action;
      throw new HostActionLedgerError(
        "host_action_pending",
        "Another Agent-requested host action is already awaiting the user.",
      );
    }
    const ttlMs = input.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000) {
      throw new RangeError("Host action TTL must be between 1 second and 5 minutes.");
    }
    const expiresAtMs = this.now() + ttlMs;
    const action = Object.freeze({
      action_id: this.createId(),
      kind: input.kind,
      label: input.label.slice(0, 200),
      expires_at: new Date(expiresAtMs).toISOString(),
    });
    this.pending = { action, dedupeKey: input.dedupeKey, trustEpoch: input.trustEpoch, expiresAtMs };
    return action;
  }

  current(): RequiredUserAction | undefined {
    this.expire();
    return this.pending?.action;
  }

  decide(
    actionId: string,
    decision: Exclude<HostActionDecision, "expired">,
    trustEpoch: number,
  ): HostActionDecision {
    this.expire();
    if (!this.pending
      || this.pending.action.action_id !== actionId
      || this.pending.trustEpoch !== trustEpoch) {
      throw new HostActionLedgerError("host_action_not_found", "This Agent-requested host action is no longer pending.");
    }
    this.pending = undefined;
    return decision;
  }

  clear(): void {
    this.pending = undefined;
  }

  private expire(): void {
    if (this.pending && this.now() >= this.pending.expiresAtMs) this.pending = undefined;
  }
}
