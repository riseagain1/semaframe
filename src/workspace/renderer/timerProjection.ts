export type TimerPhase = "idle" | "running" | "paused" | "completed";

export type TimerProjectionInput = Readonly<{
  props: Readonly<Record<string, unknown>>;
  durableState: Readonly<Record<string, unknown>>;
  nowMs: number;
}>;

export type TimerProjection = Readonly<{
  phase: TimerPhase;
  durationMs: number;
  remainingMs: number;
  elapsedMs: number;
  progress: number;
  runGeneration: number;
}>;

/**
 * Resolve the timer's display without mutating durable state. Running timers
 * are derived from their engine-stamped deadline, so rendering never creates a
 * per-tick workspace revision.
 */
export function projectTimer(input: TimerProjectionInput): TimerProjection {
  const durable = input.durableState;
  const rawPhase = durable.phase;
  const phase: TimerPhase = rawPhase === "running" || rawPhase === "paused" || rawPhase === "completed"
    ? rawPhase
    : "idle";
  const durationMs = clampMs(numberValue(durable.durationMs) ?? numberValue(input.props.durationMs) ?? 0);
  const anchoredRemaining = clampMs(numberValue(durable.remainingMs) ?? durationMs);
  const deadlineAtMs = numberValue(durable.deadlineAtMs);
  const remainingMs = phase === "running" && deadlineAtMs !== undefined
    ? clampMs(deadlineAtMs - input.nowMs)
    : phase === "completed"
      ? 0
      : anchoredRemaining;
  const projectedPhase: TimerPhase = phase === "running" && remainingMs === 0 ? "completed" : phase;
  const elapsedMs = Math.max(0, durationMs - remainingMs);
  return {
    phase: projectedPhase,
    durationMs,
    remainingMs,
    elapsedMs,
    progress: durationMs <= 0 ? (remainingMs <= 0 ? 1 : 0) : Math.min(1, elapsedMs / durationMs),
    runGeneration: Math.max(0, Math.trunc(numberValue(durable.runGeneration) ?? 0)),
  };
}

export function formatTimer(ms: number, format: unknown = "clock"): string {
  const wholeSeconds = Math.max(0, Math.ceil(ms / 1_000));
  if (format === "seconds") return `${wholeSeconds}s`;
  if (format === "compact") {
    if (wholeSeconds >= 3_600) return `${Math.floor(wholeSeconds / 3_600)}h ${Math.floor((wholeSeconds % 3_600) / 60)}m`;
    if (wholeSeconds >= 60) return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
    return `${wholeSeconds}s`;
  }
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const seconds = wholeSeconds % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function clampMs(value: number): number {
  return Math.max(0, Math.min(31_536_000_000, Math.trunc(Number.isFinite(value) ? value : 0)));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
