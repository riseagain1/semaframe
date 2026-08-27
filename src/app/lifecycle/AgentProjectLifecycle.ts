import type {
  AgentGatewayClient,
  AgentGatewayConfig,
  AgentGatewayStatus,
} from "../../agent/AgentGatewayClient";
import type { RealityMeasurementEvent } from "../../renderer/reality";
import type { XRHeadsetSessionButtonHandle } from "../components/XRHeadsetSessionButton";
import type { XRWorkspaceButtonHandle } from "../components/XRWorkspaceButton";

type RecoverableAgentBridgeClient = Pick<AgentGatewayClient, "running" | "start" | "stop">;

/**
 * Restores this tab's browser-engine lease after an offer mutation. A gateway
 * restart can make a refresh/rotation succeed against a new process while the
 * old polling loop is still unwinding, so wait for that loop before claiming
 * the new lease.
 */
export async function restoreAgentBrowserBridge(
  client: RecoverableAgentBridgeClient,
  config: Pick<AgentGatewayConfig, "engineConnected">,
  claimAndStart: () => Promise<boolean>,
): Promise<boolean> {
  if (client.running && config.engineConnected) return true;
  if (client.running) {
    const previousRun = client.start();
    client.stop("disconnected");
    await previousRun.catch(() => undefined);
  }
  return claimAndStart();
}

/**
 * Keeps local capabilities valid until the remote offer replacement is
 * confirmed. Once confirmed, local state must move to the new offer even when
 * restoring the browser lease subsequently fails.
 */
export async function replaceAgentOfferAndRestoreBridge(
  replaceOffer: () => Promise<AgentGatewayConfig>,
  onOfferReplaced: (config: AgentGatewayConfig) => void,
  restoreBridge: (config: AgentGatewayConfig) => Promise<boolean>,
): Promise<boolean> {
  const config = await replaceOffer();
  onOfferReplaced(config);
  return restoreBridge(config);
}

/** The visual Workspace is private until an approved client completes its instruction handshake. */
export function isAgentWorkspaceUnlocked(
  sessionReady: boolean,
  status: AgentGatewayStatus,
): boolean {
  return sessionReady && (status === "connected" || status === "applying");
}

/** Ephemeral renderer measurements must never outlive the gated Workspace canvas. */
export function shouldClearRealityMeasurementForWorkspaceGate(
  workspaceActive: boolean,
  measurement: RealityMeasurementEvent | undefined,
): boolean {
  return !workspaceActive && measurement !== undefined;
}

/** Project identity changes remain an explicit XR teardown boundary. */
export async function stopXrSessionsForProjectReplacement(
  sameDevice: Pick<XRWorkspaceButtonHandle, "exitFromUserGesture"> | null | undefined,
  headset: Pick<XRHeadsetSessionButtonHandle, "stop"> | null | undefined,
): Promise<readonly Readonly<{ target: "same_device" | "headset"; reason: unknown }>[]> {
  type TeardownOutcome = Readonly<{
    locallyReleased: boolean;
    teardownConfirmed: boolean;
    error?: string;
  }>;
  const pending: Readonly<{ target: "same_device" | "headset"; operation: Promise<TeardownOutcome> }>[] = [
    ...(sameDevice ? [{ target: "same_device" as const, operation: sameDevice.exitFromUserGesture() }] : []),
    ...(headset ? [{ target: "headset" as const, operation: headset.stop() }] : []),
  ];
  const settled = await Promise.allSettled(pending.map(({ operation }) => operation));
  return Object.freeze(settled.flatMap((result, index) => {
    if (result.status === "rejected") {
      return [Object.freeze({ target: pending[index]!.target, reason: result.reason })];
    }
    if (result.value.locallyReleased && result.value.teardownConfirmed) return [];
    return [Object.freeze({
      target: pending[index]!.target,
      reason: result.value.error ?? "XR teardown was not fully confirmed.",
    })];
  }));
}

type ProjectReplacementAgentBridge = Pick<AgentGatewayClient, "running" | "start" | "stop" | "disable">;

/** Abort and drain the browser command loop before a project can replace its store. */
export async function quiesceAgentBridgeForProjectReplacement(input: Readonly<{
  client?: ProjectReplacementAgentBridge;
  occupied: boolean;
  revoke: () => void;
  waitForTrustRevocation: () => Promise<unknown>;
}>): Promise<void> {
  const previousRun = input.client?.running ? input.client.start() : undefined;
  input.revoke();
  input.client?.stop(input.occupied ? "disconnected" : "disabled");
  const disable = !input.occupied && input.client
    ? input.client.disable().catch(() => input.client?.stop("disabled"))
    : Promise.resolve();
  await Promise.all([
    previousRun?.catch(() => undefined),
    input.waitForTrustRevocation().catch(() => undefined),
    disable,
  ]);
}
