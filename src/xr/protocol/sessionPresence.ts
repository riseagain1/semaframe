import { parseXrOpaqueId } from "./validation";

export const XR_SESSION_PRESENCE_CHANNEL = "xr.session.presence" as const;
export const XR_SESSION_CONTROL_CHANNEL = "xr.session.control" as const;

export const XR_VIEWER_PRESENCE_PHASES = Object.freeze([
  "replica_ready",
  "immersive_entering",
  "active",
  "exiting",
  "ended",
] as const);

export type XrViewerPresencePhase = typeof XR_VIEWER_PRESENCE_PHASES[number];
export type XrRoutedPresencePhase = XrViewerPresencePhase | "disconnected" | "expired";

export type XrRoutedSessionPresence = Readonly<{
  phase: XrRoutedPresencePhase;
  sourceSessionId: string;
  sourcePairingId: string;
  serverReceivedAtMs: number;
}>;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("XR session presence must be a plain object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(record).length !== keys.length
    || Object.keys(record).some((key) => !allowed.has(key))
    || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError("XR session presence fields are invalid.");
  }
  return record;
}

function phase(value: unknown): XrViewerPresencePhase {
  if (typeof value !== "string"
    || !(XR_VIEWER_PRESENCE_PHASES as readonly string[]).includes(value)) {
    throw new TypeError("XR session presence phase is invalid.");
  }
  return value as XrViewerPresencePhase;
}

function routedPhase(value: unknown): XrRoutedPresencePhase {
  if (value === "disconnected" || value === "expired") return value;
  return phase(value);
}

/** Strict renderer-supplied payload. Provenance is deliberately absent. */
export function parseXrViewerPresence(value: unknown): Readonly<{ phase: XrViewerPresencePhase }> {
  const body = exactRecord(value, ["phase"]);
  return Object.freeze({ phase: phase(body.phase) });
}

/** Strict relay-rewritten payload consumed by the authoritative desktop. */
export function parseXrRoutedSessionPresence(value: unknown): XrRoutedSessionPresence {
  const body = exactRecord(value, [
    "phase",
    "sourceSessionId",
    "sourcePairingId",
    "serverReceivedAtMs",
  ]);
  if (!Number.isSafeInteger(body.serverReceivedAtMs) || Number(body.serverReceivedAtMs) < 0) {
    throw new TypeError("XR session presence server time is invalid.");
  }
  return Object.freeze({
    phase: routedPhase(body.phase),
    sourceSessionId: parseXrOpaqueId(body.sourceSessionId, "$.sourceSessionId"),
    sourcePairingId: parseXrOpaqueId(body.sourcePairingId, "$.sourcePairingId"),
    serverReceivedAtMs: Number(body.serverReceivedAtMs),
  });
}

export function parseXrTargetedExitRequest(value: unknown): Readonly<{
  action: "request_exit";
  targetSessionId: string;
}> {
  const body = exactRecord(value, ["action", "targetSessionId"]);
  if (body.action !== "request_exit") throw new TypeError("XR session control action is invalid.");
  return Object.freeze({
    action: "request_exit",
    targetSessionId: parseXrOpaqueId(body.targetSessionId, "$.targetSessionId"),
  });
}
