import type { ComponentInstance } from "../workspace/components";
import type {
  AnimationCompletionRequest,
  ComponentActionRequest,
} from "../workspace/renderer";
import type { WorkspaceState } from "../workspace/state";

export type WorkspaceActionSupport = (
  component: Readonly<ComponentInstance>,
  action: string,
) => boolean;

export type WorkspaceTimerSignalPlan = Readonly<{
  due: readonly ComponentActionRequest[];
  nextDeadlineAtMs?: number;
}>;

/**
 * Produces host timer signals without mutating the Workspace. The caller owns
 * scheduling and commits the returned action through the normal Store lane,
 * preserving one deterministic revision, event graph, and undo record. Only
 * the first due timer is returned: its routed fanout shares the Store's bounded
 * action budget, so batching unrelated timers could exceed that budget and
 * livelock. The resulting revision causes the host to plan the next timer.
 */
export function planWorkspaceTimerSignals(
  state: Readonly<WorkspaceState>,
  supportsAction: WorkspaceActionSupport,
  observedAtMs: number,
): WorkspaceTimerSignalPlan {
  const due: ComponentActionRequest[] = [];
  let nextDeadlineAtMs: number | undefined;
  for (const component of state.components.values()) {
    if (component.type.typeId !== "timer"
      || component.durableState.phase !== "running"
      || component.locks.actions
      || !supportsAction(component, "complete_if_due")) continue;
    const deadlineAtMs = component.durableState.deadlineAtMs;
    if (typeof deadlineAtMs !== "number"
      || !Number.isSafeInteger(deadlineAtMs)
      || deadlineAtMs < 0) continue;
    if (deadlineAtMs <= observedAtMs) {
      due.push({ componentId: component.id, action: "complete_if_due", input: {} });
      continue;
    }
    nextDeadlineAtMs = nextDeadlineAtMs === undefined
      ? deadlineAtMs
      : Math.min(nextDeadlineAtMs, deadlineAtMs);
  }
  due.sort((left, right) => left.componentId.localeCompare(right.componentId));
  return { due: due.slice(0, 1), ...(nextDeadlineAtMs === undefined ? {} : { nextDeadlineAtMs }) };
}

/**
 * Converts a trusted renderer completion callback into a host action only
 * while it still matches the currently playing non-looping generation.
 */
export function workspaceAnimationCompletionAction(
  state: Readonly<WorkspaceState>,
  request: AnimationCompletionRequest,
  supportsAction: WorkspaceActionSupport,
): ComponentActionRequest | undefined {
  const component = state.components.get(request.componentId);
  if (!component || component.type.typeId !== "spatial-entity"
    || !supportsAction(component, "complete_animation")) return undefined;
  const playback = component.durableState.playback;
  if (!isRecord(playback)
    || playback.playing !== true
    || playback.loop === true
    || playback.generation !== request.generation
    || playback.clip !== request.clip) return undefined;
  return {
    componentId: component.id,
    action: "complete_animation",
    input: { generation: request.generation },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
