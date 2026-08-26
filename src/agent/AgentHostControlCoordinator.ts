import {
  AGENT_HOST_CONTROL_COMMAND_NAMES,
  type AgentHostControlCommandName,
} from "./hostControlContracts";

export type AgentHostControlContext = Readonly<{ signal: AbortSignal }>;

export type AgentHostControlPorts = Readonly<{
  workspaceId(): string;
  inspectVoiceRelay(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  prepareVoiceRelaySetup(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  runVoiceRelayDiagnostics(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  requestVoiceRelayArm(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  inspectXrReadiness(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  prepareXrSession(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  requestEnterXr(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  waitForXrSessionState(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  requestExitXr(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
  getLiveXrContext(input: Readonly<Record<string, unknown>>, context: AgentHostControlContext): unknown | Promise<unknown>;
}>;

export class AgentHostControlError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "AgentHostControlError";
  }
}

const COMMAND_KEYS: Readonly<Record<AgentHostControlCommandName, readonly string[]>> = Object.freeze({
  inspect_voice_relay: [],
  prepare_voice_relay_setup: ["target_hint"],
  run_voice_relay_diagnostics: ["include_safe_input_test"],
  request_voice_relay_arm: [],
  inspect_xr_readiness: ["mode"],
  prepare_xr_session: ["mode", "render_profile", "voice_relay"],
  request_enter_xr: [],
  wait_for_xr_session_state: ["wait_ms", "after_sequence"],
  request_exit_xr: [],
  get_live_xr_context: ["maximum_age_ms"],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Agent host-control request cancelled", "AbortError");
}

function sanitizeInput(
  command: AgentHostControlCommandName,
  input: unknown,
  expectedWorkspaceId: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(input)) throw new AgentHostControlError("invalid_request", "Host-control input must be an object.");
  const allowed = new Set(["session_token", "instruction_digest", "workspace_id", ...COMMAND_KEYS[command]]);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new AgentHostControlError("invalid_request", `Unexpected host-control fields: ${unexpected.join(", ")}.`);
  }
  if (typeof input.workspace_id !== "string" || input.workspace_id !== expectedWorkspaceId) {
    throw new AgentHostControlError("host_workspace_mismatch", "The host-control request does not match the open Workspace.");
  }
  if (typeof input.session_token !== "string" || input.session_token.length < 8 ||
      typeof input.instruction_digest !== "string" || input.instruction_digest.length < 8) {
    throw new AgentHostControlError("invalid_request", "The host-control capability envelope is invalid.");
  }
  const safe: Record<string, unknown> = {};
  for (const key of COMMAND_KEYS[command]) {
    if (input[key] !== undefined) safe[key] = structuredClone(input[key]);
  }
  if (safe.target_hint !== undefined && (typeof safe.target_hint !== "string" || safe.target_hint.length > 160)) {
    throw new AgentHostControlError("invalid_request", "target_hint must be at most 160 characters.");
  }
  for (const key of ["include_safe_input_test"]) {
    if (safe[key] !== undefined && typeof safe[key] !== "boolean") {
      throw new AgentHostControlError("invalid_request", `${key} must be boolean.`);
    }
  }
  if (safe.mode !== undefined && !["auto", "same_device", "remote_headset"].includes(String(safe.mode))) {
    throw new AgentHostControlError("invalid_request", "mode is invalid.");
  }
  if (safe.render_profile !== undefined && !["balanced", "validated_ultra"].includes(String(safe.render_profile))) {
    throw new AgentHostControlError("invalid_request", "render_profile is invalid.");
  }
  if (safe.voice_relay !== undefined && !["off", "if_configured"].includes(String(safe.voice_relay))) {
    throw new AgentHostControlError("invalid_request", "voice_relay is invalid.");
  }
  if (safe.wait_ms !== undefined && (!Number.isSafeInteger(safe.wait_ms) || Number(safe.wait_ms) < 0 || Number(safe.wait_ms) > 25_000)) {
    throw new AgentHostControlError("invalid_request", "wait_ms must be an integer between 0 and 25000.");
  }
  if (safe.after_sequence !== undefined && (!Number.isSafeInteger(safe.after_sequence)
    || Number(safe.after_sequence) < 0)) {
    throw new AgentHostControlError("invalid_request", "after_sequence must be a non-negative safe integer.");
  }
  if (safe.maximum_age_ms !== undefined && (!Number.isSafeInteger(safe.maximum_age_ms)
    || Number(safe.maximum_age_ms) < 50 || Number(safe.maximum_age_ms) > 10_000)) {
    throw new AgentHostControlError("invalid_request", "maximum_age_ms must be an integer between 50 and 10000.");
  }
  return Object.freeze(safe);
}

/** Routes approved, ephemeral host requests without exposing session secrets to UI ports. */
export class AgentHostControlCoordinator {
  constructor(private readonly ports: AgentHostControlPorts) {}

  handles(name: string): name is AgentHostControlCommandName {
    return (AGENT_HOST_CONTROL_COMMAND_NAMES as readonly string[]).includes(name);
  }

  async handle(
    command: AgentHostControlCommandName,
    input: unknown,
    context: AgentHostControlContext,
  ): Promise<Readonly<{ ok: true; data: unknown }>> {
    throwIfAborted(context.signal);
    const safe = sanitizeInput(command, input, this.ports.workspaceId());
    const method = {
      inspect_voice_relay: this.ports.inspectVoiceRelay,
      prepare_voice_relay_setup: this.ports.prepareVoiceRelaySetup,
      run_voice_relay_diagnostics: this.ports.runVoiceRelayDiagnostics,
      request_voice_relay_arm: this.ports.requestVoiceRelayArm,
      inspect_xr_readiness: this.ports.inspectXrReadiness,
      prepare_xr_session: this.ports.prepareXrSession,
      request_enter_xr: this.ports.requestEnterXr,
      wait_for_xr_session_state: this.ports.waitForXrSessionState,
      request_exit_xr: this.ports.requestExitXr,
      get_live_xr_context: this.ports.getLiveXrContext,
    }[command];
    const data = await method(safe, context);
    throwIfAborted(context.signal);
    return Object.freeze({ ok: true as const, data: structuredClone(data) });
  }
}
