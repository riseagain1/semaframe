export const VOICE_RELAY_HTTP_PATHS = Object.freeze({
  desktopBase: "/api/agent/voice-relay",
  xrBase: "/api/xr/voice-relay",
  status: "/status",
  prepareSetup: "/setup/prepare",
  requestAccessibility: "/setup/accessibility",
  diagnostics: "/diagnostics",
  configureTarget: "/setup/target",
  arm: "/arm",
  disarm: "/disarm",
  stages: "/stages",
});

/** One-use desktop confirmation proof. Never send this header from XR. */
export const VOICE_RELAY_HOST_ACTION_HEADER = "x-semaframe-voice-relay-host-action" as const;

export function voiceRelayStageActionPath(
  baseUrl: string,
  stageId: string,
  action: "confirm" | "cancel" | "reply",
): string {
  return `${baseUrl}${VOICE_RELAY_HTTP_PATHS.stages}/${encodeURIComponent(stageId)}/${action}`;
}
