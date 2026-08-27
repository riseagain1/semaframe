import { describe, expect, it } from "vitest";
import {
  agentExperienceLegacyStatus,
  deriveAgentExperienceState,
  type AgentExperienceInput,
} from "../../app/agentExperience";
import type { AgentGatewayConfig } from "../../agent/AgentGatewayClient";

const config = (overrides: Partial<AgentGatewayConfig> = {}): AgentGatewayConfig => ({
  version: 1,
  gatewayInstanceId: "gateway-test",
  configRevision: 1,
  enabled: true,
  connected: false,
  engineConnected: true,
  instructionVersion: "guide-test",
  csrfToken: "csrf-test",
  connectionUrl: "http://127.0.0.1:8788/mcp/connect/test-offer",
  offerExpiresAt: "2030-01-01T00:00:00.000Z",
  offerStatus: "waiting",
  ...overrides,
});

const input = (overrides: Partial<AgentExperienceInput> = {}): AgentExperienceInput => ({
  configPhase: "ready",
  gatewayStatus: "waiting",
  config: config(),
  sessionReady: false,
  ...overrides,
});

describe("Agent experience state", () => {
  it("distinguishes boot, unavailable, disabled, and occupied before offer state", () => {
    expect(deriveAgentExperienceState(input({ configPhase: "loading", occupied: true })).kind).toBe("booting");
    expect(deriveAgentExperienceState(input({ configPhase: "error", gatewayError: " Gateway offline " }))).toEqual({
      kind: "gateway_unavailable",
      message: "Gateway offline",
    });
    expect(deriveAgentExperienceState(input({ config: config({ enabled: false }) }))).toEqual({ kind: "control_disabled" });
    expect(deriveAgentExperienceState(input({ occupied: true }))).toEqual({ kind: "occupied" });
  });

  it("retains the exact ready offer without treating it as approval", () => {
    expect(deriveAgentExperienceState(input())).toEqual({
      kind: "offer_ready",
      url: "http://127.0.0.1:8788/mcp/connect/test-offer",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("projects a pending claim into a display-safe client", () => {
    const state = deriveAgentExperienceState(input({
      config: config({
        offerStatus: "approval_pending",
        pendingApproval: {
          claimId: "claim-test",
          clientId: "codex-local",
          clientName: "Codex Desktop",
          scopes: ["workspace:read", "workspace:write"],
          fingerprint: "fingerprint-test",
          requestedAt: "2029-12-31T23:59:00.000Z",
          expiresAt: "2030-01-01T00:01:00.000Z",
        },
      }),
    }));

    expect(state).toEqual({
      kind: "approval_pending",
      client: {
        name: "Codex Desktop",
        clientId: "codex-local · fingerprint-test",
        scopes: ["workspace:read", "workspace:write"],
        connected: false,
      },
    });
  });

  it("keeps approval granted separate until this browser handles instructions", () => {
    const client = { name: "Codex", scopes: ["workspace:read", "workspace:write"] } as const;
    for (const offerStatus of ["approval_granted", "approved"] as const) {
      expect(deriveAgentExperienceState(input({
        gatewayStatus: "connected",
        config: config({ offerStatus, clientName: "Codex" }),
        client,
      }))).toEqual({ kind: "approval_granted", client });
    }
  });

  it("unlocks only with both browser-local instructions and a live transport", () => {
    const client = { name: "Codex", scopes: ["workspace:read"] } as const;
    expect(deriveAgentExperienceState(input({
      gatewayStatus: "connected",
      config: config({ offerStatus: "approved" }),
      sessionReady: true,
      client,
    }))).toEqual({
      kind: "workspace_ready",
      client: { ...client, connected: true },
      applying: false,
    });
    expect(deriveAgentExperienceState(input({
      gatewayStatus: "applying",
      config: config({ offerStatus: "approved" }),
      sessionReady: true,
      client,
    }))).toMatchObject({ kind: "workspace_ready", applying: true });
    expect(deriveAgentExperienceState(input({
      gatewayStatus: "disconnected",
      config: config({ offerStatus: "approved" }),
      sessionReady: true,
      client,
    }))).toEqual({ kind: "reconnecting", client });
    expect(deriveAgentExperienceState(input({
      gatewayStatus: "connected",
      config: config({ offerStatus: "waiting" }),
      sessionReady: true,
      client,
    }))).toEqual({
      kind: "offer_ready",
      url: "http://127.0.0.1:8788/mcp/connect/test-offer",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("gives expired and denied offers a specific recovery state", () => {
    expect(deriveAgentExperienceState(input({ config: config({ offerStatus: "expired" }) }))).toEqual({
      kind: "offer_invalid",
      reason: "expired",
    });
    expect(deriveAgentExperienceState(input({ config: config({ offerStatus: "denied" }) }))).toEqual({
      kind: "offer_invalid",
      reason: "denied",
    });
  });

  it("maps every experience state to the incremental legacy UI surface", () => {
    const states = [
      { kind: "booting" },
      { kind: "gateway_unavailable" },
      { kind: "control_disabled" },
      { kind: "offer_ready" },
      { kind: "approval_pending", client: { name: "A", scopes: [] } },
      { kind: "approval_granted", client: { name: "A", scopes: [] } },
      { kind: "workspace_ready", client: { name: "A", scopes: [] }, applying: false },
      { kind: "reconnecting" },
      { kind: "offer_invalid", reason: "expired" },
      { kind: "occupied" },
    ] as const;

    expect(states.map(agentExperienceLegacyStatus)).toEqual([
      "booting", "unavailable", "disabled", "waiting", "approval", "approved",
      "connected", "disconnected", "invalid", "occupied",
    ]);
  });
});
