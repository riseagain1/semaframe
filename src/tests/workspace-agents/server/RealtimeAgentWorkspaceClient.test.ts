import { describe, expect, it, vi } from "vitest";
import {
  RealtimeAgentWorkspaceClient,
  type RealtimeAgentPreview,
  type RealtimeAgentPreviewSink,
  type WorkspaceToolTransport,
} from "../../../workspace/realtime/RealtimeAgentWorkspaceClient";
import { WORKSPACE_AGENT_GUIDE } from "../../../workspace/agents/guide";
import type {
  BeginWorkspaceUpdateData,
  SubmitWorkspaceBatchData,
  WorkspaceInstructionsData,
} from "../../../workspace/agents/WorkspaceAgentController";
import type {
  WorkspaceAgentResult,
  WorkspaceAgentToolName,
} from "../../../workspace/agents/contracts";

class RecordingPreviewSink implements RealtimeAgentPreviewSink {
  readonly updates: RealtimeAgentPreview[] = [];
  readonly clears: string[] = [];
  readonly cancellations: Array<{ id: string; reason: string }> = [];

  updatePreview(preview: RealtimeAgentPreview): void {
    this.updates.push(preview);
  }

  clearPreview(utteranceId: string): void {
    this.clears.push(utteranceId);
  }

  cancelPreview(utteranceId: string, reason: string): void {
    this.cancellations.push({ id: utteranceId, reason });
  }
}

class ScriptedTransport implements WorkspaceToolTransport {
  readonly calls: Array<{ name: WorkspaceAgentToolName; input: unknown }> = [];
  handler: (name: WorkspaceAgentToolName, input: unknown) => Promise<WorkspaceAgentResult<unknown>> =
    async () => ({ ok: false, error: { code: "not_scripted", message: "not scripted", retryable: false } });

  async call<T>(name: WorkspaceAgentToolName, input: unknown): Promise<WorkspaceAgentResult<T>> {
    this.calls.push({ name, input });
    return this.handler(name, input) as Promise<WorkspaceAgentResult<T>>;
  }
}

const INSTRUCTIONS: WorkspaceInstructionsData = {
  session_token: "workspace_session_1234567890",
  session_expires_at: "2026-08-14T01:00:00.000Z",
  guide_digest: "guide_digest_1234567890",
  guide: WORKSPACE_AGENT_GUIDE,
  client_id: "realtime-agent",
  requested_scopes: ["workspace:read", "workspace:write", "component:create"],
  granted_scopes: ["workspace:read", "workspace:write", "component:create"],
  denied_scopes: [],
};

const PREPARATION: BeginWorkspaceUpdateData = {
  client_id: "realtime-agent",
  instruction_digest: INSTRUCTIONS.guide_digest,
  transaction_token: "workspace_tx_1234567890",
  transaction_expires_at: "2026-08-14T00:02:00.000Z",
  intent: "Create a timer",
  envelope: {
    protocol_version: "1.1",
    request_id: "workspace_request_1",
    workspace_id: "workspace_main",
    input_revision: 1,
    base_workspace_revision: 0,
    registry_digest: "registry_digest_v1",
    mode: "commit",
  },
  workspace_summary: { component_count: 0 },
  capability_manifest: { component_types: ["builtin.timer"] },
  reserved_component_ids: ["CMP_TIMER"],
};

const COMMIT: SubmitWorkspaceBatchData = {
  client_id: "realtime-agent",
  transaction_token: PREPARATION.transaction_token,
  request_id: PREPARATION.envelope.request_id,
  base_workspace_revision: 0,
  resulting_workspace_revision: 1,
  status: "committed",
  summary: "Created timer",
};

function configureConnect(transport: ScriptedTransport): void {
  transport.handler = async (name) => name === "get_workspace_instructions"
    ? { ok: true, data: INSTRUCTIONS }
    : { ok: false, error: { code: "not_scripted", message: "not scripted", retryable: false } };
}

describe("RealtimeAgentWorkspaceClient", () => {
  it("projects partial utterances without making any Workspace tool call", async () => {
    const transport = new ScriptedTransport();
    const previews = new RecordingPreviewSink();
    const client = new RealtimeAgentWorkspaceClient(transport, previews);

    expect(await client.updatePartialUtterance("utterance-1", "Put a timer", 1)).toEqual({
      ok: true,
      data: { previewed: true },
    });
    expect(await client.updatePartialUtterance("utterance-1", "Put a timer above the desk", 2)).toEqual({
      ok: true,
      data: { previewed: true },
    });
    // An out-of-order partial is ignored rather than replaying old visual state.
    await client.updatePartialUtterance("utterance-1", "old", 1);
    expect(transport.calls).toEqual([]);
    expect(previews.updates).toEqual([
      { utteranceId: "utterance-1", text: "Put a timer", sequence: 1, ephemeral: true },
      { utteranceId: "utterance-1", text: "Put a timer above the desk", sequence: 2, ephemeral: true },
    ]);
  });

  it("turns one final utterance into canonical begin then submit calls", async () => {
    const transport = new ScriptedTransport();
    const previews = new RecordingPreviewSink();
    const client = new RealtimeAgentWorkspaceClient(transport, previews);
    configureConnect(transport);
    expect((await client.connect({ clientName: "Realtime voice agent" })).ok).toBe(true);
    await client.updatePartialUtterance("utterance-2", "Create a timer", 1);

    transport.handler = async (name) => {
      if (name === "begin_workspace_update") return { ok: true, data: PREPARATION };
      if (name === "submit_workspace_batch") return { ok: true, data: COMMIT };
      return { ok: false, error: { code: "unexpected", message: name, retryable: false } };
    };
    const buildBatch = vi.fn((preparation: BeginWorkspaceUpdateData) => ({
      ...preparation.envelope,
      operations: [{
        op: "create_component",
        op_id: "create_timer",
        id: preparation.reserved_component_ids[0],
      }],
    }));
    const result = await client.commitFinalUpdate({
      utteranceId: "utterance-2",
      intent: "Create a timer",
      requestedComponentIds: 1,
      buildBatch,
    });

    expect(result).toEqual({ ok: true, data: COMMIT });
    expect(buildBatch).toHaveBeenCalledWith(PREPARATION, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(transport.calls.map(({ name }) => name)).toEqual([
      "get_workspace_instructions",
      "begin_workspace_update",
      "submit_workspace_batch",
    ]);
    expect(transport.calls[2]?.input).toEqual({
      session_token: INSTRUCTIONS.session_token,
      instruction_digest: INSTRUCTIONS.guide_digest,
      transaction_token: PREPARATION.transaction_token,
      batch: {
        ...PREPARATION.envelope,
        operations: [{ op: "create_component", op_id: "create_timer", id: "CMP_TIMER" }],
      },
    });
    expect(previews.clears).toEqual(["utterance-2"]);
  });

  it("interrupts a prepared-but-not-submitted update and never sends its batch", async () => {
    const transport = new ScriptedTransport();
    const previews = new RecordingPreviewSink();
    const client = new RealtimeAgentWorkspaceClient(transport, previews);
    configureConnect(transport);
    await client.connect();

    let releasePreparation!: () => void;
    const preparationBarrier = new Promise<void>((resolve) => { releasePreparation = resolve; });
    transport.handler = async (name) => {
      if (name === "begin_workspace_update") {
        await preparationBarrier;
        return { ok: true, data: PREPARATION };
      }
      if (name === "submit_workspace_batch") return { ok: true, data: COMMIT };
      return { ok: false, error: { code: "unexpected", message: name, retryable: false } };
    };
    const final = client.commitFinalUpdate({
      utteranceId: "utterance-interrupted",
      intent: "Create a timer",
      buildBatch: () => ({ ...PREPARATION.envelope, operations: [] }),
    });
    await vi.waitFor(() => expect(transport.calls.at(-1)?.name).toBe("begin_workspace_update"));
    await client.interrupt("utterance-interrupted", "user_spoke_again");
    releasePreparation();

    expect(await final).toMatchObject({ ok: false, error: { code: "realtime_update_interrupted" } });
    expect(transport.calls.filter(({ name }) => name === "submit_workspace_batch")).toHaveLength(0);
    expect(previews.cancellations).toContainEqual({
      id: "utterance-interrupted",
      reason: "user_spoke_again",
    });
  });

  it("never cancels a submit already dispatched when the user interrupts", async () => {
    const transport = new ScriptedTransport();
    const previews = new RecordingPreviewSink();
    const client = new RealtimeAgentWorkspaceClient(transport, previews);
    configureConnect(transport);
    await client.connect();

    let releaseCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => { releaseCommit = resolve; });
    transport.handler = async (name): Promise<WorkspaceAgentResult<unknown>> => {
      if (name === "begin_workspace_update") return { ok: true, data: PREPARATION };
      if (name === "submit_workspace_batch") {
        await commitBarrier;
        return { ok: true, data: COMMIT };
      }
      return { ok: false, error: { code: "unexpected", message: name, retryable: false } };
    };
    const final = client.commitFinalUpdate({
      utteranceId: "utterance-committing",
      intent: "Create a timer",
      buildBatch: () => ({ ...PREPARATION.envelope, operations: [] }),
    });
    await vi.waitFor(() => expect(transport.calls.at(-1)?.name).toBe("submit_workspace_batch"));
    await client.interrupt("utterance-committing", "user_interrupted");
    releaseCommit();

    expect(await final).toEqual({ ok: true, data: COMMIT });
    expect(transport.calls.filter(({ name }) => name === "submit_workspace_batch")).toHaveLength(1);
    expect(previews.cancellations).toContainEqual({
      id: "utterance-committing",
      reason: "user_interrupted",
    });
  });

  it("does not expose provider configuration or bypass sessions for read/history tools", async () => {
    const transport = new ScriptedTransport();
    const previews = new RecordingPreviewSink();
    const client = new RealtimeAgentWorkspaceClient(transport, previews);
    expect(await client.inspect()).toMatchObject({ ok: false, error: { code: "instructions_required" } });
    expect(await client.inspectComponent("CMP_TARGET_061")).toMatchObject({
      ok: false,
      error: { code: "instructions_required" },
    });
    expect(await client.readResourceSnapshot("RES_traffic_feed")).toMatchObject({
      ok: false,
      error: { code: "instructions_required" },
    });
    expect(await client.queryLayoutPlacement({
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 320, height: 220 },
      },
    })).toMatchObject({ ok: false, error: { code: "instructions_required" } });
    configureConnect(transport);
    await client.connect();
    transport.handler = async (name, input) => ({ ok: true, data: { name, input } });

    await client.inspectComponent("CMP_TARGET_061");
    await client.readResourceSnapshot("RES_traffic_feed");
    await client.queryLayoutPlacement({
      component_id: "CMP_TARGET_061",
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 320, height: 220 },
      },
    });
    await client.readEvents("cursor-4", 20);
    await client.undo(7);
    expect(transport.calls.slice(-5)).toEqual([
      {
        name: "inspect_workspace_component",
        input: {
          session_token: INSTRUCTIONS.session_token,
          instruction_digest: INSTRUCTIONS.guide_digest,
          component_id: "CMP_TARGET_061",
        },
      },
      {
        name: "read_workspace_resource_snapshot",
        input: {
          session_token: INSTRUCTIONS.session_token,
          instruction_digest: INSTRUCTIONS.guide_digest,
          resource_id: "RES_traffic_feed",
        },
      },
      {
        name: "query_layout_placement",
        input: {
          session_token: INSTRUCTIONS.session_token,
          instruction_digest: INSTRUCTIONS.guide_digest,
          candidate: {
            component_id: "CMP_TARGET_061",
            placement: {
              space: "viewport",
              anchor: "center",
              offset: { x: 0, y: 0 },
              size: { width: 320, height: 220 },
            },
          },
        },
      },
      {
        name: "read_workspace_events",
        input: {
          session_token: INSTRUCTIONS.session_token,
          instruction_digest: INSTRUCTIONS.guide_digest,
          after_cursor: "cursor-4",
          limit: 20,
        },
      },
      {
        name: "undo_workspace_batch",
        input: {
          session_token: INSTRUCTIONS.session_token,
          instruction_digest: INSTRUCTIONS.guide_digest,
          expected_workspace_revision: 7,
        },
      },
    ]);
    expect(JSON.stringify(client)).not.toMatch(/api[_-]?key|openai|openrouter/iu);
  });
});
