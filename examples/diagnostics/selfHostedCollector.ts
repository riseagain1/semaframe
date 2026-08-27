import {
  AnonymousPerformanceCollector,
  InMemoryAnonymousDiagnosticRetentionStore,
  InMemoryAnonymousDiagnosticRateLimiter,
  admitAndDiscardDiagnosticTransportMetadata,
} from "../../server/diagnostics";

const limiter = new InMemoryAnonymousDiagnosticRateLimiter(60, 60_000);
const retention = new InMemoryAnonymousDiagnosticRetentionStore();
const collector = new AnonymousPerformanceCollector(retention);

/** Wire this function to an operator-owned HTTP adapter; it performs no outbound request. */
export async function acceptAnonymousDiagnostic(
  body: unknown,
  transport: Readonly<{ ipAddress?: string; userAgent?: string }>,
): Promise<Readonly<{ status: "accepted" | "rate_limited"; retryAfterMs?: number }>> {
  const admission = await admitAndDiscardDiagnosticTransportMetadata(transport, limiter);
  return collector.collect(body, admission);
}
