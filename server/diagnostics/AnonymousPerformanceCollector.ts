import { parseAnonymousPerformanceDiagnosticPayload } from "../../src/ecosystem/diagnostics";
import type {
  AnonymousDiagnosticAdmission,
  AnonymousDiagnosticRetentionRecord,
  AnonymousDiagnosticRetentionStore,
} from "./contracts";

const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export class AnonymousPerformanceCollector {
  constructor(
    readonly store: AnonymousDiagnosticRetentionStore,
    readonly retentionMs = 7 * 24 * 60 * 60 * 1_000,
  ) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000 || retentionMs > MAX_RETENTION_MS) {
      throw new TypeError("retentionMs must be between one minute and 30 days");
    }
  }

  async collect(
    value: unknown,
    admission: AnonymousDiagnosticAdmission,
    nowMs = Date.now(),
  ): Promise<Readonly<{ status: "accepted" | "rate_limited"; retryAfterMs?: number }>> {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError("nowMs must be a non-negative finite number");
    if (!admission.allowed) {
      return Object.freeze({
        status: "rate_limited",
        ...(admission.retryAfterMs === undefined ? {} : { retryAfterMs: admission.retryAfterMs }),
      });
    }
    const payload = parseAnonymousPerformanceDiagnosticPayload(value);
    await this.store.deleteBefore(nowMs - this.retentionMs);
    await this.store.append(Object.freeze({ receivedAtMs: nowMs, payload }));
    return Object.freeze({ status: "accepted" });
  }

  async enforceRetention(nowMs = Date.now()): Promise<number> {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError("nowMs must be a non-negative finite number");
    return this.store.deleteBefore(nowMs - this.retentionMs);
  }
}

export class InMemoryAnonymousDiagnosticRetentionStore implements AnonymousDiagnosticRetentionStore {
  readonly #records: AnonymousDiagnosticRetentionRecord[] = [];

  constructor(readonly capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
      throw new TypeError("capacity must be between 1 and 1000000");
    }
  }

  async append(record: AnonymousDiagnosticRetentionRecord): Promise<void> {
    const overflow = this.#records.length - this.capacity + 1;
    if (overflow > 0) this.#records.splice(0, overflow);
    this.#records.push(structuredClone(record));
  }

  async deleteBefore(cutoffMs: number): Promise<number> {
    const retained = this.#records.filter((record) => record.receivedAtMs >= cutoffMs);
    const removed = this.#records.length - retained.length;
    this.#records.splice(0, this.#records.length, ...retained);
    return removed;
  }

  snapshot(): readonly AnonymousDiagnosticRetentionRecord[] {
    return structuredClone(this.#records);
  }
}
