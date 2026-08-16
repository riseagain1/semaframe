import { describe, expect, it } from "vitest";
import {
  hostFeedRetryDelayMs,
  nextHostFeedRefreshDelayMs,
} from "../../app/hostFeedRefreshPolicy";

describe("host feed retry policy", () => {
  it("backs off exponentially and caps retries by interval and five minutes", () => {
    expect([1, 2, 3, 4, 5].map((count) => hostFeedRetryDelayMs(30_000, count)))
      .toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
    expect(hostFeedRetryDelayMs(86_400_000, 20)).toBe(300_000);
  });

  it("normalizes invalid inputs to one bounded retry", () => {
    expect(hostFeedRetryDelayMs(Number.NaN, 0)).toBe(5_000);
  });

  it("uses a failed refresh retry deadline instead of leaving an overdue interval unscheduled", () => {
    const now = Date.parse("2026-08-15T03:00:00.000Z");
    expect(nextHostFeedRefreshDelayMs({
      now,
      intervalMs: 30_000,
      retrievedAt: "2026-08-15T02:00:00.000Z",
      nextRetryAt: now + 10_000,
    })).toBe(10_000);
    expect(nextHostFeedRefreshDelayMs({
      now,
      intervalMs: 30_000,
      retrievedAt: "2026-08-15T02:00:00.000Z",
    })).toBe(0);
  });
});
