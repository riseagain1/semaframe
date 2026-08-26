import { describe, expect, it } from "vitest";
import {
  VoiceRelayStateError,
  VoiceRelayStateMachine,
  type VoiceRelayTargetSummary,
} from "../../voice-relay";

const TARGET: VoiceRelayTargetSummary = Object.freeze({
  targetId: "agent-main",
  label: "Codex",
  capabilities: Object.freeze({ draftInsertion: true, explicitSend: true, replyObservation: true }),
});

describe("VoiceRelayStateMachine", () => {
  it("models explicit human confirmation between recognition and Send", () => {
    const machine = new VoiceRelayStateMachine();
    machine.dispatch({ type: "enable" });
    machine.dispatch({ type: "configured", target: TARGET });
    machine.dispatch({ type: "listen" });
    machine.dispatch({ type: "transcribe" });
    machine.dispatch({ type: "stage" });
    machine.dispatch({ type: "staged", stageId: "stage-1", expiresAtMs: 10_000 });
    expect(machine.snapshot).toMatchObject({ phase: "awaiting_confirmation", stageId: "stage-1" });

    machine.dispatch({ type: "confirm" });
    machine.dispatch({ type: "sent" });
    machine.dispatch({ type: "reply", sequence: 1, complete: true });
    machine.dispatch({ type: "speak" });
    machine.dispatch({ type: "complete" });
    expect(machine.snapshot).toEqual({ phase: "ready", enabled: true, target: TARGET });
  });

  it("does not allow confirmation before a verified draft exists", () => {
    const machine = new VoiceRelayStateMachine();
    machine.dispatch({ type: "enable" });
    machine.dispatch({ type: "configured", target: TARGET });
    expect(() => machine.dispatch({ type: "confirm" })).toThrow(VoiceRelayStateError);
    expect(machine.snapshot.phase).toBe("ready");
  });

  it("makes an ambiguous send terminal until explicit recovery", () => {
    const machine = new VoiceRelayStateMachine();
    for (const event of [
      { type: "enable" },
      { type: "configured", target: TARGET },
      { type: "listen" },
      { type: "transcribe" },
      { type: "stage" },
      { type: "staged", stageId: "stage-2", expiresAtMs: 20_000 },
      { type: "confirm" },
      { type: "send_outcome_unknown" },
    ] as const) machine.dispatch(event);

    expect(() => machine.dispatch({ type: "listen" })).toThrow(VoiceRelayStateError);
    machine.dispatch({ type: "recover" });
    expect(machine.snapshot.phase).toBe("ready");
  });

  it("drops all target and stage data when disabled", () => {
    const machine = new VoiceRelayStateMachine();
    machine.dispatch({ type: "enable" });
    machine.dispatch({ type: "configured", target: TARGET });
    machine.dispatch({ type: "disable" });
    expect(machine.snapshot).toEqual({ phase: "off", enabled: false });
  });
});
