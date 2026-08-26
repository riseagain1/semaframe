import type {
  VoiceRelayErrorDetails,
  VoiceRelayPhase,
  VoiceRelayTargetSummary,
} from "./contracts";

export type VoiceRelayUiState = Readonly<{
  phase: VoiceRelayPhase;
  enabled: boolean;
  target?: VoiceRelayTargetSummary;
  stageId?: string;
  expiresAtMs?: number;
  replySequence?: number;
  error?: VoiceRelayErrorDetails;
}>;

export type VoiceRelayUiEvent =
  | Readonly<{ type: "enable" }>
  | Readonly<{ type: "disable" }>
  | Readonly<{ type: "configured"; target: VoiceRelayTargetSummary }>
  | Readonly<{ type: "target_lost"; message?: string }>
  | Readonly<{ type: "listen" }>
  | Readonly<{ type: "transcribe" }>
  | Readonly<{ type: "stage" }>
  | Readonly<{ type: "staged"; stageId: string; expiresAtMs: number }>
  | Readonly<{ type: "confirm" }>
  | Readonly<{ type: "sent" }>
  | Readonly<{ type: "send_outcome_unknown" }>
  | Readonly<{ type: "reply"; sequence: number; complete: boolean }>
  | Readonly<{ type: "speak" }>
  | Readonly<{ type: "complete" }>
  | Readonly<{ type: "cancel" }>
  | Readonly<{ type: "fail"; error: VoiceRelayErrorDetails }>
  | Readonly<{ type: "recover" }>;

export class VoiceRelayStateError extends Error {
  constructor(readonly code: "invalid_transition", message: string) {
    super(message);
    this.name = "VoiceRelayStateError";
  }
}

const INITIAL_STATE: VoiceRelayUiState = Object.freeze({
  phase: "off",
  enabled: false,
});

function requirePhase(state: VoiceRelayUiState, event: string, phases: readonly VoiceRelayPhase[]): void {
  if (!phases.includes(state.phase)) {
    throw new VoiceRelayStateError(
      "invalid_transition",
      `Voice Relay cannot ${event} while ${state.phase}.`,
    );
  }
}

function stableState(state: VoiceRelayUiState): VoiceRelayUiState {
  return Object.freeze({
    phase: state.target ? "ready" : "unconfigured",
    enabled: true,
    ...(state.target ? { target: state.target } : {}),
  });
}

export function reduceVoiceRelayState(
  state: VoiceRelayUiState,
  event: VoiceRelayUiEvent,
): VoiceRelayUiState {
  if (event.type === "disable") return INITIAL_STATE;
  if (event.type === "enable") {
    requirePhase(state, "enable", ["off"]);
    return Object.freeze({ phase: "unconfigured", enabled: true });
  }
  if (!state.enabled) {
    throw new VoiceRelayStateError("invalid_transition", `Voice Relay cannot ${event.type} while off.`);
  }

  switch (event.type) {
    case "configured":
      requirePhase(state, "configure a target", ["unconfigured", "ready", "error"]);
      return Object.freeze({ phase: "ready", enabled: true, target: event.target });
    case "target_lost":
      return Object.freeze({
        phase: "error",
        enabled: true,
        error: Object.freeze({
          code: "target_lost",
          message: event.message ?? "The configured Agent target is no longer available.",
          recoverable: true,
        }),
      });
    case "listen":
      requirePhase(state, "start listening", ["ready", "reply_ready", "speaking"]);
      return Object.freeze({ phase: "listening", enabled: true, target: state.target });
    case "transcribe":
      requirePhase(state, "finish listening", ["listening"]);
      return Object.freeze({ phase: "transcribing", enabled: true, target: state.target });
    case "stage":
      requirePhase(state, "stage a transcript", ["transcribing"]);
      return Object.freeze({ phase: "staging", enabled: true, target: state.target });
    case "staged":
      requirePhase(state, "await confirmation", ["staging"]);
      return Object.freeze({
        phase: "awaiting_confirmation",
        enabled: true,
        target: state.target,
        stageId: event.stageId,
        expiresAtMs: event.expiresAtMs,
      });
    case "confirm":
      requirePhase(state, "confirm", ["awaiting_confirmation"]);
      return Object.freeze({ ...state, phase: "sending" });
    case "sent":
      requirePhase(state, "finish sending", ["sending"]);
      return Object.freeze({ ...state, phase: "waiting_response" });
    case "send_outcome_unknown":
      requirePhase(state, "record an ambiguous send", ["sending"]);
      return Object.freeze({ ...state, phase: "send_outcome_unknown" });
    case "reply":
      requirePhase(state, "receive a reply", ["waiting_response", "reply_ready"]);
      return Object.freeze({
        ...state,
        phase: event.complete ? "reply_ready" : "waiting_response",
        replySequence: event.sequence,
      });
    case "speak":
      requirePhase(state, "speak", ["reply_ready"]);
      return Object.freeze({ ...state, phase: "speaking" });
    case "complete":
      requirePhase(state, "complete", ["waiting_response", "reply_ready", "speaking"]);
      return stableState(state);
    case "cancel":
      requirePhase(state, "cancel", [
        "listening",
        "transcribing",
        "staging",
        "awaiting_confirmation",
        "waiting_response",
        "reply_ready",
        "speaking",
      ]);
      return stableState(state);
    case "fail":
      return Object.freeze({
        phase: "error",
        enabled: true,
        ...(state.target ? { target: state.target } : {}),
        error: event.error,
      });
    case "recover":
      requirePhase(state, "recover", ["error", "send_outcome_unknown"]);
      return stableState(state);
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

export class VoiceRelayStateMachine {
  #state: VoiceRelayUiState = INITIAL_STATE;

  get snapshot(): VoiceRelayUiState {
    return this.#state;
  }

  dispatch(event: VoiceRelayUiEvent): VoiceRelayUiState {
    this.#state = reduceVoiceRelayState(this.#state, event);
    return this.#state;
  }
}
