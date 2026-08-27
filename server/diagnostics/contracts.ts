import type { AnonymousPerformanceDiagnosticPayload } from "../../src/ecosystem/diagnostics";

export type DiagnosticTransportMetadata = Readonly<{
  ipAddress?: string;
  userAgent?: string;
}>;

export type AnonymousDiagnosticAdmission = Readonly<{
  allowed: boolean;
  retryAfterMs?: number;
}>;

export interface AnonymousDiagnosticRateLimiter {
  /** The implementation may inspect an address only for an ephemeral rate window. */
  consume(ipAddress: string | undefined, nowMs: number): Promise<AnonymousDiagnosticAdmission>;
}

export type AnonymousDiagnosticRetentionRecord = Readonly<{
  receivedAtMs: number;
  payload: AnonymousPerformanceDiagnosticPayload;
}>;

export interface AnonymousDiagnosticRetentionStore {
  append(record: AnonymousDiagnosticRetentionRecord): Promise<void>;
  deleteBefore(cutoffMs: number): Promise<number>;
}
