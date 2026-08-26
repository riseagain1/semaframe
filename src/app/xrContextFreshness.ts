import type { XRUserTrackingState } from "../xr/client";

export type RemoteXrContextFreshnessInput = Readonly<{
  contextWorkspaceId: string;
  contextWorkspaceRevision: number;
  expectedWorkspaceId: string;
  expectedWorkspaceRevision: number;
  receivedAtMs: number;
  nowMs: number;
  relayQueueAgeMs: number;
  sourceAgeMs: number;
  trackingState: XRUserTrackingState;
  maximumAgeMs: number;
}>;

export type RemoteXrContextAgeInput = Pick<
  RemoteXrContextFreshnessInput,
  "receivedAtMs" | "nowMs" | "relayQueueAgeMs" | "sourceAgeMs"
>;

/**
 * Returns the conservative known age without ever comparing clocks from
 * different devices: desktop receipt age + relay-computed queue age +
 * renderer-computed sample age.
 */
export function remoteXrContextKnownAgeMs(input: RemoteXrContextAgeInput): number | undefined {
  if (!Number.isSafeInteger(input.receivedAtMs)
    || !Number.isSafeInteger(input.nowMs)
    || input.receivedAtMs < 0
    || input.nowMs < 0
    || input.receivedAtMs > input.nowMs
    || !Number.isSafeInteger(input.relayQueueAgeMs)
    || input.relayQueueAgeMs < 0
    || !Number.isFinite(input.sourceAgeMs)
    || input.sourceAgeMs < 0) return undefined;
  const ageMs = input.nowMs - input.receivedAtMs
    + input.relayQueueAgeMs
    + input.sourceAgeMs;
  return Number.isFinite(ageMs) && ageMs <= Number.MAX_SAFE_INTEGER
    ? ageMs
    : undefined;
}

/**
 * Remote capture timestamps come from the headset clock and therefore cannot
 * establish freshness on the desktop. Freshness is measured only from the
 * three same-clock relative ages: the renderer's own sample age, relay queue
 * age, and time since the desktop received the authenticated delivery.
 */
export function isRemoteXrContextFresh(input: RemoteXrContextFreshnessInput): boolean {
  const ageMs = remoteXrContextKnownAgeMs(input);
  return input.contextWorkspaceId === input.expectedWorkspaceId
    && input.contextWorkspaceRevision === input.expectedWorkspaceRevision
    && (input.trackingState === "tracked" || input.trackingState === "limited")
    && ageMs !== undefined
    && ageMs <= input.maximumAgeMs;
}
