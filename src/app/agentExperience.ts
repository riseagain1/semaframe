import type {
  AgentGatewayConfig,
  AgentGatewayOfferStatus,
  AgentGatewayStatus,
} from "../agent/AgentGatewayClient";
import type { AgentConnectionClient } from "./components/AgentConnectionPage";

export type AgentConfigPhase = "loading" | "ready" | "error";

export type AgentExperienceState =
  | Readonly<{ kind: "booting" }>
  | Readonly<{ kind: "gateway_unavailable"; message?: string }>
  | Readonly<{ kind: "control_disabled" }>
  | Readonly<{ kind: "offer_ready"; url?: string; expiresAt?: string }>
  | Readonly<{ kind: "approval_pending"; client: AgentConnectionClient }>
  | Readonly<{ kind: "approval_granted"; client: AgentConnectionClient }>
  | Readonly<{ kind: "workspace_ready"; client: AgentConnectionClient; applying: boolean }>
  | Readonly<{ kind: "reconnecting"; client?: AgentConnectionClient }>
  | Readonly<{ kind: "offer_invalid"; reason: "expired" | "denied" }>
  | Readonly<{ kind: "occupied" }>;

export type AgentExperienceInput = Readonly<{
  configPhase: AgentConfigPhase;
  gatewayStatus: AgentGatewayStatus;
  config?: AgentGatewayConfig;
  /** Browser-local proof that this App handled the current instruction handshake. */
  sessionReady: boolean;
  occupied?: boolean;
  /** Retains the approved identity while the gateway no longer exposes pendingApproval. */
  client?: AgentConnectionClient | null;
  gatewayError?: string;
}>;

function pendingClient(config: AgentGatewayConfig): AgentConnectionClient | undefined {
  const pending = config.pendingApproval;
  if (!pending) return undefined;
  return Object.freeze({
    name: pending.clientName?.trim() || "Unnamed agent",
    ...(pending.clientId || pending.fingerprint
      ? { clientId: pending.clientId
        ? `${pending.clientId} · ${pending.fingerprint}`
        : pending.fingerprint }
      : {}),
    scopes: Object.freeze([...pending.scopes]),
    connected: false,
  });
}

function configuredClient(
  config: AgentGatewayConfig,
  fallback?: AgentConnectionClient | null,
): AgentConnectionClient {
  if (fallback) return Object.freeze({
    ...fallback,
    scopes: Object.freeze([...fallback.scopes]),
  });
  return Object.freeze({
    name: config.clientName?.trim() || "Unnamed MCP client",
    scopes: Object.freeze([...(config.clientScopes ?? [])]),
    connected: config.connected,
  });
}

function offerInvalidReason(status: AgentGatewayOfferStatus | undefined): "expired" | "denied" | undefined {
  return status === "expired" || status === "denied" ? status : undefined;
}

/**
 * Projects gateway, offer, and browser-handshake facts into one user-facing
 * lifecycle. It does not grant authority: Workspace unlock remains separately
 * bound to the browser-local instruction handshake.
 */
export function deriveAgentExperienceState(input: AgentExperienceInput): AgentExperienceState {
  if (input.configPhase === "loading") return Object.freeze({ kind: "booting" });
  if (input.configPhase === "error") {
    return Object.freeze({
      kind: "gateway_unavailable",
      ...(input.gatewayError?.trim() ? { message: input.gatewayError.trim() } : {}),
    });
  }
  if (input.occupied) return Object.freeze({ kind: "occupied" });

  const config = input.config;
  if (!config || !config.enabled) return Object.freeze({ kind: "control_disabled" });

  const invalidReason = offerInvalidReason(config.offerStatus);
  if (invalidReason) return Object.freeze({ kind: "offer_invalid", reason: invalidReason });

  const client = pendingClient(config) ?? configuredClient(config, input.client);
  if (config.offerStatus === "approval_pending") {
    return Object.freeze({ kind: "approval_pending", client });
  }

  const transportLive = input.gatewayStatus === "connected" || input.gatewayStatus === "applying";
  const approvalReachedInstructions = config.offerStatus === "approval_granted"
    || config.offerStatus === "approved";
  if (input.sessionReady && transportLive && approvalReachedInstructions) {
    return Object.freeze({
      kind: "workspace_ready",
      client: Object.freeze({ ...client, connected: true }),
      applying: input.gatewayStatus === "applying",
    });
  }

  if (input.gatewayStatus === "disconnected") {
    return Object.freeze({
      kind: "reconnecting",
      ...(input.client || config.clientName || config.offerStatus === "approval_granted" || config.offerStatus === "approved"
        ? { client: configuredClient(config, input.client) }
        : {}),
    });
  }

  if (config.offerStatus === "approval_granted" || config.offerStatus === "approved") {
    return Object.freeze({ kind: "approval_granted", client: configuredClient(config, input.client) });
  }

  return Object.freeze({
    kind: "offer_ready",
    ...(config.connectionUrl ? { url: config.connectionUrl } : {}),
    ...(config.offerExpiresAt ? { expiresAt: config.offerExpiresAt } : {}),
  });
}

/** Legacy App wiring can adopt the state model without changing its prop shape in one step. */
export function agentExperienceLegacyStatus(
  state: AgentExperienceState,
): "disabled" | "waiting" | "approval" | "approved" | "connected" | "disconnected" | "occupied" | "booting" | "unavailable" | "invalid" {
  switch (state.kind) {
    case "booting": return "booting";
    case "gateway_unavailable": return "unavailable";
    case "control_disabled": return "disabled";
    case "offer_ready": return "waiting";
    case "approval_pending": return "approval";
    case "approval_granted": return "approved";
    case "workspace_ready": return "connected";
    case "reconnecting": return "disconnected";
    case "offer_invalid": return "invalid";
    case "occupied": return "occupied";
  }
}
