/**
 * Ephemeral host-control requests that an approved Agent may ask the open
 * SemaFrame app to prepare. These requests never mutate Workspace state and
 * never grant the Agent the user gesture or OS permission they request.
 */
export const AGENT_HOST_CONTROL_COMMAND_NAMES = [
  "inspect_voice_relay",
  "prepare_voice_relay_setup",
  "run_voice_relay_diagnostics",
  "request_voice_relay_arm",
  "inspect_xr_readiness",
  "prepare_xr_session",
  "request_enter_xr",
  "wait_for_xr_session_state",
  "request_exit_xr",
  "get_live_xr_context",
] as const;

export type AgentHostControlCommandName = typeof AGENT_HOST_CONTROL_COMMAND_NAMES[number];

export const AGENT_HOST_CONTROL_SCOPES = [
  "host:voice_relay_setup",
  "host:xr_prepare",
] as const;

export type AgentHostControlScope = typeof AGENT_HOST_CONTROL_SCOPES[number];

export const REQUIRED_USER_ACTION_KINDS = [
  "grant_accessibility",
  "confirm_target",
  "confirm_safe_test",
  "arm_voice_relay",
  "open_headset_link",
  "enter_immersive_xr",
  "exit_immersive_xr",
] as const;

export type RequiredUserActionKind = typeof REQUIRED_USER_ACTION_KINDS[number];

export type RequiredUserAction = Readonly<{
  action_id: string;
  kind: RequiredUserActionKind;
  label: string;
  expires_at?: string;
}>;

export type VoiceRelayHostPhase =
  | "off"
  | "needs_configuration"
  | "awaiting_user_confirmation"
  | "ready"
  | "armed"
  | "error";

export type XrHostPhase =
  | "unavailable"
  | "idle"
  | "preparing"
  | "pairing"
  | "ready"
  | "replica_ready"
  | "awaiting_user_gesture"
  | "entering"
  | "immersive_entering"
  | "active"
  | "exiting"
  | "ended"
  | "disconnected"
  | "expired"
  | "error";

export type AgentHostControlData = Readonly<{
  command: AgentHostControlCommandName;
  phase: VoiceRelayHostPhase | XrHostPhase;
  message: string;
  required_user_action?: RequiredUserAction;
  capabilities?: Readonly<Record<string, boolean | string | number | null>>;
}>;

export function isAgentHostControlCommandName(value: unknown): value is AgentHostControlCommandName {
  return typeof value === "string" &&
    (AGENT_HOST_CONTROL_COMMAND_NAMES as readonly string[]).includes(value);
}

export function hostControlScopeForCommand(
  command: AgentHostControlCommandName,
): AgentHostControlScope | "workspace:read" {
  if ([
    "prepare_voice_relay_setup",
    "run_voice_relay_diagnostics",
    "request_voice_relay_arm",
  ].includes(command)) return "host:voice_relay_setup";
  if ([
    "prepare_xr_session",
    "request_enter_xr",
    "request_exit_xr",
  ].includes(command)) return "host:xr_prepare";
  return "workspace:read";
}
