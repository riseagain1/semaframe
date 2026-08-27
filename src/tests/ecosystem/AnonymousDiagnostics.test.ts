import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANONYMOUS_PERFORMANCE_DIAGNOSTIC_CONFIG,
  parseAnonymousPerformanceDiagnosticPayload,
  previewAnonymousPerformanceDiagnostic,
} from "../../ecosystem/diagnostics";
import {
  AnonymousPerformanceCollector,
  InMemoryAnonymousDiagnosticRetentionStore,
  InMemoryAnonymousDiagnosticRateLimiter,
  admitAndDiscardDiagnosticTransportMetadata,
} from "../../../server/diagnostics";

const environment = {
  releaseChannel: "preview",
  runtime: "desktop",
  renderer: "webgl",
  hardwareTier: "medium",
} as const;
const metrics = { startup_ms: 420, frame_p95_ms: 18.2, dropped_frame_ratio: 0.01 } as const;

describe("anonymous performance diagnostics", () => {
  it("is default-off and previews the exact payload only after opt-in", () => {
    const disabled = previewAnonymousPerformanceDiagnostic(
      environment,
      metrics,
      DEFAULT_ANONYMOUS_PERFORMANCE_DIAGNOSTIC_CONFIG,
    );
    expect(disabled).toMatchObject({ enabled: false, payload: null, serializedPayload: null, byteLength: 0 });

    const enabled = previewAnonymousPerformanceDiagnostic(environment, metrics, { enabled: true });
    expect(enabled.payload).toEqual(JSON.parse(enabled.serializedPayload!));
    expect(enabled.byteLength).toBe(new TextEncoder().encode(enabled.serializedPayload!).byteLength);
    expect(enabled.serializedPayload).not.toMatch(/(?:https?:|sha256:|\/Users\/|token|project|session|userAgent|ipAddress)/iu);
  });

  it("rejects non-allowlisted identifiers, content, URLs, paths, digests, and metrics", () => {
    const payload = previewAnonymousPerformanceDiagnostic(environment, metrics, { enabled: true }).payload!;
    for (const [field, value] of [
      ["projectId", "PROJECT_STABLE_ID"],
      ["url", "https://example.test/workspace"],
      ["path", "/Users/name/project"],
      ["digest", `sha256:${"a".repeat(64)}`],
      ["token", "secret-token"],
    ] as const) {
      expect(() => parseAnonymousPerformanceDiagnosticPayload({ ...payload, [field]: value })).toThrow(/not allowlisted/u);
    }
    expect(() => parseAnonymousPerformanceDiagnosticPayload({
      ...payload,
      metrics: { ...payload.metrics, component_count: 12 },
    })).toThrow(/not allowlisted/u);
  });

  it("discards transport metadata before collection, rate-limits, and enforces retention", async () => {
    const limiter = new InMemoryAnonymousDiagnosticRateLimiter(1, 60_000);
    const firstAdmission = await admitAndDiscardDiagnosticTransportMetadata({
      ipAddress: "203.0.113.4",
      userAgent: "SECRET-UA/1.0",
    }, limiter, 120_000);
    const secondAdmission = await admitAndDiscardDiagnosticTransportMetadata({
      ipAddress: "203.0.113.4",
      userAgent: "ANOTHER-UA/2.0",
    }, limiter, 120_001);
    expect(firstAdmission).toEqual({ allowed: true });
    expect(secondAdmission).toMatchObject({ allowed: false });

    const store = new InMemoryAnonymousDiagnosticRetentionStore();
    const collector = new AnonymousPerformanceCollector(store, 60_000);
    const payload = previewAnonymousPerformanceDiagnostic(environment, metrics, { enabled: true }).payload!;
    await expect(collector.collect(payload, firstAdmission, 120_000)).resolves.toEqual({ status: "accepted" });
    await expect(collector.collect(payload, secondAdmission, 120_001)).resolves.toMatchObject({ status: "rate_limited" });
    const serialized = JSON.stringify(store.snapshot());
    expect(serialized).not.toContain("203.0.113.4");
    expect(serialized).not.toContain("SECRET-UA");
    expect(store.snapshot()).toHaveLength(1);
    await expect(collector.enforceRetention(180_001)).resolves.toBe(1);
    expect(store.snapshot()).toEqual([]);
  });

  it("bounds anonymous source buckets and retained records under hostile cardinality", async () => {
    const limiter = new InMemoryAnonymousDiagnosticRateLimiter(10, 60_000, 2);
    await expect(limiter.consume("203.0.113.1", 120_000)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume("203.0.113.2", 120_000)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume("203.0.113.3", 120_000)).resolves.toMatchObject({ allowed: false });
    await expect(limiter.consume("203.0.113.3", 180_000)).resolves.toEqual({ allowed: true });

    const payload = previewAnonymousPerformanceDiagnostic(environment, metrics, { enabled: true }).payload!;
    const store = new InMemoryAnonymousDiagnosticRetentionStore(2);
    await store.append({ receivedAtMs: 1, payload });
    await store.append({ receivedAtMs: 2, payload });
    await store.append({ receivedAtMs: 3, payload });
    expect(store.snapshot().map((record) => record.receivedAtMs)).toEqual([2, 3]);
  });
});
