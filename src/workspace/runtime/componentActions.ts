import Ajv2020 from "ajv/dist/2020.js";
import type {
  ComponentInstance,
  ComponentManifest,
  ComponentVisibility,
  JSONObject,
} from "../components/componentTypes";

export class ComponentActionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ComponentActionError";
  }
}

export type ActionEventDraft = {
  id?: string;
  event: string;
  payload: JSONObject;
};

export type ComponentActionResolution = {
  durableState: JSONObject;
  /** Optional host-owned top-level presentation effect. */
  visibility?: ComponentVisibility;
  events: ActionEventDraft[];
};

export type TimerPhase = "idle" | "running" | "paused" | "completed";

export type TimerProjection = {
  phase: TimerPhase;
  durationMs: number;
  remainingMs: number;
  elapsedMs: number;
  progress: number;
  runGeneration: number;
  completionEventId?: string;
  observedAtMs: number;
};

function numberField(value: JSONObject, key: string, fallback = 0): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isFinite(result)) return fallback;
  return result;
}

function phaseField(value: JSONObject): TimerPhase {
  const phase = value.phase;
  return phase === "idle" || phase === "running" || phase === "paused" || phase === "completed"
    ? phase
    : "idle";
}

/** Pure projection. Calling it every animation frame never changes durable state. */
export function projectTimer(
  component: Pick<ComponentInstance, "id" | "type" | "durableState">,
  observedAtMs: number,
): TimerProjection {
  if (component.type.typeId !== "timer") {
    throw new ComponentActionError(`Component ${component.id} is not a timer`, "not_a_timer");
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new ComponentActionError("observedAtMs must be a non-negative integer", "invalid_effective_time");
  }
  const state = component.durableState;
  const durationMs = numberField(state, "durationMs");
  const generation = numberField(state, "runGeneration");
  const storedPhase = phaseField(state);
  let remainingMs = numberField(state, "remainingMs", durationMs);
  if (storedPhase === "running") {
    remainingMs = Math.max(0, numberField(state, "deadlineAtMs", observedAtMs) - observedAtMs);
  }
  const phase: TimerPhase = storedPhase === "running" && remainingMs === 0 ? "completed" : storedPhase;
  // Older saved projects may carry the former component-id-derived event ID.
  // New completions deliberately leave event identity to WorkspaceStore's
  // globally monotonic cursor allocator so deleting/recreating a component ID
  // can never suppress a later completion.
  const completionEventId = phase === "completed" && typeof state.completionEventId === "string"
    ? state.completionEventId
    : undefined;
  return {
    phase,
    durationMs,
    remainingMs,
    elapsedMs: Math.max(0, durationMs - remainingMs),
    progress: durationMs === 0 ? 1 : Math.min(1, Math.max(0, (durationMs - remainingMs) / durationMs)),
    runGeneration: generation,
    ...(completionEventId ? { completionEventId } : {}),
    observedAtMs,
  };
}

export function dueTimerCompletionEvent(
  component: Pick<ComponentInstance, "id" | "type" | "durableState">,
  observedAtMs: number,
): ActionEventDraft | null {
  const projection = projectTimer(component, observedAtMs);
  if (phaseField(component.durableState) !== "running" || projection.phase !== "completed") return null;
  return {
    event: "finished",
    payload: { generation: projection.runGeneration },
  };
}

function validateActionInput(manifest: ComponentManifest, actionName: string, input: JSONObject): void {
  const action = manifest.actions[actionName];
  if (!action) throw new ComponentActionError(`Unknown action ${actionName} for ${manifest.typeId}`, "unknown_component_action");
  const ajv = new Ajv2020({ allErrors: true, strict: false, strictNumbers: true });
  const validate = ajv.compile(structuredClone(action.inputSchema));
  if (!validate(input)) {
    throw new ComponentActionError(
      `Invalid ${manifest.typeId}.${actionName} input: ${ajv.errorsText(validate.errors)}`,
      "invalid_action_input",
    );
  }
}

function completedTimerState(
  component: ComponentInstance,
  projection: TimerProjection,
): ComponentActionResolution {
  return {
    durableState: {
      phase: "completed",
      durationMs: projection.durationMs,
      remainingMs: 0,
      runGeneration: projection.runGeneration,
    },
    events: [{ event: "finished", payload: { generation: projection.runGeneration } }],
  };
}

function resolveTimerAction(
  component: ComponentInstance,
  actionName: string,
  input: JSONObject,
  effectiveTimeMs: number,
): ComponentActionResolution {
  const projection = projectTimer(component, effectiveTimeMs);
  const generation = projection.runGeneration;
  if (actionName === "start") {
    const requested = input.durationMs;
    const durationMs = typeof requested === "number" ? requested : numberField(component.props, "durationMs", projection.durationMs);
    const nextGeneration = generation + 1;
    if (durationMs === 0) {
      return {
        durableState: { phase: "completed", durationMs, remainingMs: 0, runGeneration: nextGeneration },
        events: [
          { event: "started", payload: { generation: nextGeneration } },
          { event: "finished", payload: { generation: nextGeneration } },
        ],
      };
    }
    return {
      durableState: {
        phase: "running", durationMs, remainingMs: durationMs,
        startedAtMs: effectiveTimeMs, deadlineAtMs: effectiveTimeMs + durationMs,
        runGeneration: nextGeneration,
      },
      events: [{ event: "started", payload: { generation: nextGeneration } }],
    };
  }
  if (actionName === "pause") {
    if (projection.phase === "completed") {
      return phaseField(component.durableState) === "completed"
        ? { durableState: structuredClone(component.durableState), events: [] }
        : completedTimerState(component, projection);
    }
    if (projection.phase !== "running") {
      throw new ComponentActionError("Only a running timer can be paused", "invalid_timer_transition");
    }
    return {
      durableState: {
        phase: "paused", durationMs: projection.durationMs,
        remainingMs: projection.remainingMs, runGeneration: generation,
      },
      events: [{ event: "paused", payload: { remainingMs: projection.remainingMs } }],
    };
  }
  if (actionName === "resume") {
    if (projection.phase !== "paused") {
      throw new ComponentActionError("Only a paused timer can be resumed", "invalid_timer_transition");
    }
    if (projection.remainingMs === 0) return completedTimerState(component, projection);
    return {
      durableState: {
        phase: "running", durationMs: projection.durationMs,
        remainingMs: projection.remainingMs, startedAtMs: effectiveTimeMs,
        deadlineAtMs: effectiveTimeMs + projection.remainingMs,
        runGeneration: generation,
      },
      events: [{ event: "resumed", payload: { generation } }],
    };
  }
  if (actionName === "reset") {
    const requested = input.durationMs;
    const durationMs = typeof requested === "number" ? requested : numberField(component.props, "durationMs", projection.durationMs);
    return {
      durableState: { phase: "idle", durationMs, remainingMs: durationMs, runGeneration: generation + 1 },
      events: [{ event: "reset", payload: {} }],
    };
  }
  if (actionName === "add_time") {
    const amountMs = numberField(input, "amountMs");
    const remainingMs = Math.max(0, Math.min(31_536_000_000, projection.remainingMs + amountMs));
    const durationMs = Math.max(0, Math.min(31_536_000_000, projection.durationMs + amountMs));
    if (projection.phase === "running") {
      if (remainingMs === 0) return completedTimerState(component, { ...projection, durationMs, remainingMs });
      return {
        durableState: {
          phase: "running", durationMs, remainingMs,
          startedAtMs: effectiveTimeMs, deadlineAtMs: effectiveTimeMs + remainingMs,
          runGeneration: generation,
        },
        events: [],
      };
    }
    const phase: TimerPhase = projection.phase === "completed" && remainingMs > 0 ? "paused" : projection.phase;
    return {
      durableState: { phase, durationMs, remainingMs, runGeneration: generation },
      events: [],
    };
  }
  if (actionName === "complete_if_due") {
    // Projection may present an overdue running timer as completed. Persist
    // that edge exactly once: once the durable phase is completed, later host
    // callbacks are harmless and cannot re-emit the deterministic event ID.
    if (phaseField(component.durableState) !== "running" || projection.phase !== "completed") {
      return { durableState: structuredClone(component.durableState), events: [] };
    }
    return completedTimerState(component, projection);
  }
  throw new ComponentActionError(`Unsupported timer action ${actionName}`, "unknown_component_action");
}

type ChecklistItem = { id: string; text: string; completed: boolean };

function checklistItems(component: ComponentInstance): ChecklistItem[] {
  const items = component.durableState.items;
  if (!Array.isArray(items)) return [];
  return structuredClone(items) as ChecklistItem[];
}

function resolveChecklistAction(
  component: ComponentInstance,
  actionName: string,
  input: JSONObject,
): ComponentActionResolution {
  let items = checklistItems(component);
  const id = typeof input.id === "string" ? input.id : "";
  if (actionName === "add_item") {
    if (items.some((item) => item.id === id)) throw new ComponentActionError(`Checklist item ${id} already exists`, "duplicate_checklist_item");
    items.push({ id, text: String(input.text), completed: false });
  } else if (actionName === "toggle_item") {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new ComponentActionError(`Unknown checklist item ${id}`, "unknown_checklist_item");
    item.completed = !item.completed;
  } else if (actionName === "remove_item") {
    if (!items.some((item) => item.id === id)) throw new ComponentActionError(`Unknown checklist item ${id}`, "unknown_checklist_item");
    items = items.filter((item) => item.id !== id);
  } else if (actionName === "clear_completed") {
    items = items.filter((item) => !item.completed);
  } else {
    throw new ComponentActionError(`Unsupported checklist action ${actionName}`, "unknown_component_action");
  }
  return { durableState: { items: items as unknown as JSONObject["items"] }, events: [{ event: "changed", payload: {} }] };
}

function resolveVideoPlayerAction(
  component: ComponentInstance,
  actionName: string,
  input: JSONObject,
): ComponentActionResolution {
  const generation = Math.max(0, Math.trunc(numberField(component.durableState, "commandGeneration"))) + 1;
  const currentTime = Math.max(0, Math.min(86_400, numberField(component.durableState, "requestedTimeSeconds")));
  const currentDesired = component.durableState.desiredPlayback === "playing" || component.durableState.desiredPlayback === "paused"
    ? component.durableState.desiredPlayback
    : "stopped";
  if (actionName === "play") {
    return {
      durableState: {
        desiredPlayback: "playing", lastCommand: "play",
        requestedTimeSeconds: currentTime, commandGeneration: generation,
      },
      events: [{ event: "play_requested", payload: { generation } }],
    };
  }
  if (actionName === "pause") {
    return {
      durableState: {
        desiredPlayback: "paused", lastCommand: "pause",
        requestedTimeSeconds: currentTime, commandGeneration: generation,
      },
      events: [{ event: "pause_requested", payload: { generation } }],
    };
  }
  if (actionName === "seek") {
    const timeSeconds = Math.max(0, Math.min(86_400, numberField(input, "timeSeconds")));
    return {
      durableState: {
        desiredPlayback: currentDesired, lastCommand: "seek",
        requestedTimeSeconds: timeSeconds, commandGeneration: generation,
      },
      events: [{ event: "seek_requested", payload: { generation, timeSeconds } }],
    };
  }
  if (actionName === "stop") {
    return {
      durableState: {
        desiredPlayback: "stopped", lastCommand: "stop",
        requestedTimeSeconds: 0, commandGeneration: generation,
      },
      events: [{ event: "stop_requested", payload: { generation } }],
    };
  }
  throw new ComponentActionError(`Unsupported video-player action ${actionName}`, "unknown_component_action");
}

function resolveVisibilityAction(
  component: ComponentInstance,
  actionName: string,
): ComponentActionResolution {
  const visibility: ComponentVisibility = actionName === "show"
    ? "visible"
    : actionName === "hide"
      ? "hidden"
      : component.visibility === "visible" ? "hidden" : "visible";
  return {
    durableState: structuredClone(component.durableState),
    visibility,
    events: [{ event: "visibility_changed", payload: { visibility } }],
  };
}

function resolveButtonAction(
  component: ComponentInstance,
  effectiveTimeMs: number,
): ComponentActionResolution {
  const current = component.durableState.pressCount;
  const pressCount = (typeof current === "number" && Number.isSafeInteger(current) && current >= 0
    ? current
    : 0) + 1;
  return {
    durableState: { pressCount, lastPressedAtMs: effectiveTimeMs },
    events: [{ event: "pressed", payload: { pressCount, pressedAtMs: effectiveTimeMs } }],
  };
}

type SpatialPlayback = {
  clip: "idle" | "walk" | "run" | "enter" | "exit";
  playing: boolean;
  loop: boolean;
  speed: number;
  generation: number;
};

const DEFAULT_SPATIAL_PLAYBACK: Readonly<SpatialPlayback> = Object.freeze({
  clip: "idle",
  playing: false,
  loop: true,
  speed: 1,
  generation: 0,
});

function spatialPlayback(component: ComponentInstance): SpatialPlayback {
  const value = component.durableState.playback;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_SPATIAL_PLAYBACK };
  }
  const record = value as Record<string, unknown>;
  const clip = record.clip === "walk" || record.clip === "run" || record.clip === "enter" || record.clip === "exit"
    ? record.clip
    : "idle";
  return {
    clip,
    playing: record.playing === true,
    loop: record.loop !== false,
    speed: typeof record.speed === "number" && Number.isFinite(record.speed) ? record.speed : 1,
    generation: typeof record.generation === "number" && Number.isSafeInteger(record.generation) && record.generation >= 0
      ? record.generation
      : 0,
  };
}

function resolveSpatialAnimationAction(
  component: ComponentInstance,
  actionName: string,
  input: JSONObject,
): ComponentActionResolution {
  const current = spatialPlayback(component);
  if (actionName === "play_animation") {
    const generation = current.generation + 1;
    const clip = input.clip as SpatialPlayback["clip"];
    const playback: SpatialPlayback = {
      clip,
      playing: true,
      loop: typeof input.loop === "boolean" ? input.loop : current.loop,
      speed: typeof input.speed === "number" ? input.speed : current.speed,
      generation,
    };
    return {
      durableState: { ...structuredClone(component.durableState), playback: playback as unknown as JSONObject["playback"] },
      events: [{ event: "animation_started", payload: { clip, generation } }],
    };
  }
  if (actionName === "complete_animation") {
    // Completion is a trusted renderer acknowledgement. Stale callbacks,
    // duplicate callbacks, and looping clips are deterministic no-ops.
    if (!current.playing || current.loop || input.generation !== current.generation) {
      return { durableState: structuredClone(component.durableState), events: [] };
    }
    const playback: SpatialPlayback = { ...current, playing: false };
    return {
      durableState: { ...structuredClone(component.durableState), playback: playback as unknown as JSONObject["playback"] },
      events: [{
        event: "animation_finished",
        payload: { clip: playback.clip, generation: playback.generation },
      }],
    };
  }
  const generation = current.generation + 1;
  const playback: SpatialPlayback = { ...current, playing: false, generation };
  return {
    durableState: { ...structuredClone(component.durableState), playback: playback as unknown as JSONObject["playback"] },
    events: [{ event: "animation_stopped", payload: { clip: playback.clip, generation } }],
  };
}

function resolveBuiltInSelectionAction(
  component: ComponentInstance,
  actionName: string,
  input: JSONObject,
): ComponentActionResolution | null {
  if (component.type.typeId === "chart" && actionName === "select_point") {
    const pointId = input.pointId as string;
    return {
      durableState: { ...structuredClone(component.durableState), selectedPoint: pointId },
      events: [{ event: "point_selected", payload: { pointId } }],
    };
  }
  if (component.type.typeId === "table" && actionName === "select_row") {
    const rowId = input.rowId as string;
    return {
      durableState: { ...structuredClone(component.durableState), selectedRow: rowId },
      events: [{ event: "row_selected", payload: { rowId } }],
    };
  }
  return null;
}

/**
 * Closed declarative state mutation convention for recipe controls.
 *
 * A recipe must explicitly declare a `set_value` action whose input schema
 * accepts `{ key, value }`. Only an existing top-level durable-state field can
 * be changed, and WorkspaceStore validates the complete resulting state
 * against the recipe schema before commit. No paths, code, or prototype keys
 * are interpreted.
 */
function resolveDeclarativeSetValue(
  component: ComponentInstance,
  manifest: ComponentManifest,
  input: JSONObject,
): ComponentActionResolution {
  const key = typeof input.key === "string" ? input.key : "";
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(key)
    || key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new ComponentActionError("set_value.key must be a safe top-level state key", "invalid_state_key");
  }
  if (!Object.prototype.hasOwnProperty.call(component.durableState, key)) {
    throw new ComponentActionError(`set_value cannot create undeclared state field ${key}`, "unknown_state_key");
  }
  if (!("value" in input)) {
    throw new ComponentActionError("set_value requires a value", "invalid_action_input");
  }
  const durableState = structuredClone(component.durableState);
  durableState[key] = structuredClone(input.value!);
  return {
    durableState,
    events: manifest.events.set_value
      ? [{ event: "set_value", payload: structuredClone(input) }]
      : [],
  };
}

export function resolveComponentAction(
  component: ComponentInstance,
  manifest: ComponentManifest,
  actionName: string,
  input: JSONObject,
  effectiveTimeMs: number,
): ComponentActionResolution {
  validateActionInput(manifest, actionName, input);
  if (manifest.trustTier === "builtin"
    && (actionName === "show" || actionName === "hide" || actionName === "toggle_visibility")) {
    return resolveVisibilityAction(component, actionName);
  }
  if (component.type.typeId === "button" && actionName === "press") {
    return resolveButtonAction(component, effectiveTimeMs);
  }
  if (component.type.typeId === "spatial-entity"
    && (actionName === "play_animation" || actionName === "stop_animation" || actionName === "complete_animation")) {
    return resolveSpatialAnimationAction(component, actionName, input);
  }
  if (component.type.typeId === "spatial-entity" && actionName === "activate") {
    return {
      durableState: structuredClone(component.durableState),
      events: [{ event: "activated", payload: {} }],
    };
  }
  if (component.type.typeId === "timer") {
    return resolveTimerAction(component, actionName, input, effectiveTimeMs);
  }
  if (component.type.typeId === "checklist") {
    return resolveChecklistAction(component, actionName, input);
  }
  if (component.type.typeId === "video-player") {
    return resolveVideoPlayerAction(component, actionName, input);
  }
  const selection = resolveBuiltInSelectionAction(component, actionName, input);
  if (selection) return selection;
  if (manifest.trustTier === "declarative" && actionName === "set_value") {
    return resolveDeclarativeSetValue(component, manifest, input);
  }
  // Declarative controls can expose validated semantic events without host code.
  return {
    durableState: structuredClone(component.durableState),
    events: manifest.events[actionName]
      ? [{ event: actionName, payload: structuredClone(input) }]
      : [],
  };
}
