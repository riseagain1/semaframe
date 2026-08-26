import { describe, expect, it, vi } from "vitest";
import {
  AgentHostControlCoordinator,
  AgentHostControlError,
  type AgentHostControlPorts,
} from "../../agent/AgentHostControlCoordinator";

function fixture() {
  const result = { phase: "ready", message: "ready" };
  const port = vi.fn(async () => result);
  const ports: AgentHostControlPorts = {
    workspaceId: () => "workspace-1",
    inspectVoiceRelay: port,
    prepareVoiceRelaySetup: port,
    runVoiceRelayDiagnostics: port,
    requestVoiceRelayArm: port,
    inspectXrReadiness: port,
    prepareXrSession: port,
    requestEnterXr: port,
    waitForXrSessionState: port,
    requestExitXr: port,
    getLiveXrContext: port,
  };
  return { coordinator: new AgentHostControlCoordinator(ports), port };
}

const envelope = {
  session_token: "session-token",
  instruction_digest: "guide-digest",
  workspace_id: "workspace-1",
};

describe("AgentHostControlCoordinator", () => {
  it("strips capabilities before invoking a host port", async () => {
    const { coordinator, port } = fixture();
    await expect(coordinator.handle("prepare_xr_session", {
      ...envelope,
      mode: "same_device",
      render_profile: "balanced",
    }, { signal: new AbortController().signal })).resolves.toEqual({
      ok: true,
      data: { phase: "ready", message: "ready" },
    });
    expect(port).toHaveBeenCalledWith({ mode: "same_device", render_profile: "balanced" }, expect.anything());
  });

  it("rejects a stale Workspace and unexpected fields", async () => {
    const { coordinator, port } = fixture();
    await expect(coordinator.handle("inspect_xr_readiness", {
      ...envelope,
      workspace_id: "other",
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "host_workspace_mismatch" });
    await expect(coordinator.handle("inspect_xr_readiness", {
      ...envelope,
      transcript: "secret",
    }, { signal: new AbortController().signal })).rejects.toBeInstanceOf(AgentHostControlError);
    expect(port).not.toHaveBeenCalled();
  });

  it("honors cancellation before reaching the host", async () => {
    const { coordinator, port } = fixture();
    const abort = new AbortController();
    abort.abort("cancelled");
    await expect(coordinator.handle("inspect_voice_relay", envelope, { signal: abort.signal })).rejects.toBe("cancelled");
    expect(port).not.toHaveBeenCalled();
  });

  it("passes only a validated XR lifecycle cursor to the wait port", async () => {
    const { coordinator, port } = fixture();
    await coordinator.handle("wait_for_xr_session_state", {
      ...envelope,
      wait_ms: 500,
      after_sequence: 17,
    }, { signal: new AbortController().signal });
    expect(port).toHaveBeenCalledWith({ wait_ms: 500, after_sequence: 17 }, expect.anything());
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid XR lifecycle cursor %s",
    async (afterSequence) => {
      const { coordinator, port } = fixture();
      await expect(coordinator.handle("wait_for_xr_session_state", {
        ...envelope,
        after_sequence: afterSequence,
      }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "invalid_request" });
      expect(port).not.toHaveBeenCalled();
    },
  );
});
