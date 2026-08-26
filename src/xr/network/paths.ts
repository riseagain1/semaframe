/** Browser-safe mirror of the server's fixed XR v1 routes. */
export const XR_HTTP_API_PREFIX = "/api/xr/v1" as const;
export const XR_HTTP_SESSION_HEADER = "x-semaframe-xr-session" as const;
export const XR_HTTP_POLL_MODE = "immediate" as const;

export const XR_HTTP_PATHS = Object.freeze({
  authorityConnect: `${XR_HTTP_API_PREFIX}/authority/connect`,
  authorityPairings: `${XR_HTTP_API_PREFIX}/authority/pairings`,
  authorityPairingsRevoke: `${XR_HTTP_API_PREFIX}/authority/pairings/revoke`,
  rendererConnect: `${XR_HTTP_API_PREFIX}/renderer/connect`,
  sessionSend: `${XR_HTTP_API_PREFIX}/session/send`,
  sessionPoll: `${XR_HTTP_API_PREFIX}/session/poll`,
  rendererReconnect: `${XR_HTTP_API_PREFIX}/renderer/reconnect`,
  rendererUltraProbe: `${XR_HTTP_API_PREFIX}/renderer/ultra/probe`,
  rendererUltraSample: `${XR_HTTP_API_PREFIX}/renderer/ultra/sample`,
  sessionDisconnect: `${XR_HTTP_API_PREFIX}/session/disconnect`,
} as const);

export type XrHttpPath = (typeof XR_HTTP_PATHS)[keyof typeof XR_HTTP_PATHS];
