import { describe, expect, it } from "vitest";
import { formatTimer, projectTimer } from "../../workspace/renderer/timerProjection";

describe("timer presentation", () => {
  it("derives running time without mutating durable state or creating ticks", () => {
    const durableState = Object.freeze({
      phase: "running",
      durationMs: 60_000,
      remainingMs: 60_000,
      deadlineAtMs: 150_000,
      runGeneration: 3,
    });
    const before = JSON.stringify(durableState);
    const first = projectTimer({ props: {}, durableState, nowMs: 100_000 });
    const second = projectTimer({ props: {}, durableState, nowMs: 110_500 });

    expect(first.remainingMs).toBe(50_000);
    expect(second.remainingMs).toBe(39_500);
    expect(second.runGeneration).toBe(3);
    expect(JSON.stringify(durableState)).toBe(before);
    expect(formatTimer(second.remainingMs)).toBe("00:40");
    expect(projectTimer({ props: {}, durableState, nowMs: 150_000 })).toMatchObject({
      phase: "completed",
      remainingMs: 0,
    });
  });
});
