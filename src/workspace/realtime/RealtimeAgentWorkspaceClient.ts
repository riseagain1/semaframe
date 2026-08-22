import type {
  BeginWorkspaceUpdateData,
  InspectWorkspaceComponentData,
  InspectWorkspaceData,
  ReadWorkspaceResourceSnapshotData,
  InspectWorkspaceSpaceData,
  QuerySpatialPlacementData,
  InspectWorkspacePhysicsData,
  QueryStablePlacementData,
  SimulateWorkspacePhysicsData,
  SubmitWorkspaceBatchData,
  WorkspaceEventsData,
  WorkspaceHistoryData,
  WorkspaceInstructionsData,
} from "../agents/WorkspaceAgentController";
import type {
  WorkspaceAgentResult,
  WorkspaceAgentToolName,
  WorkspacePermissionScope,
} from "../agents/contracts";

export interface WorkspaceToolTransport {
  call<T = unknown>(name: WorkspaceAgentToolName, input: unknown): Promise<WorkspaceAgentResult<T>>;
}

export type RealtimeAgentPreview = Readonly<{
  utteranceId: string;
  text: string;
  sequence: number;
  ephemeral: true;
}>;

/**
 * A preview sink projects partial agent input only. Implementations must not write to
 * Workspace state, history, component actions, data connectors, or event logs.
 */
export interface RealtimeAgentPreviewSink {
  updatePreview(preview: RealtimeAgentPreview): void | Promise<void>;
  clearPreview(utteranceId: string): void | Promise<void>;
  cancelPreview(utteranceId: string, reason: string): void | Promise<void>;
}

export type RealtimeAgentFinalUpdateInput = Readonly<{
  utteranceId: string;
  intent: string;
  requestedComponentIds?: number;
  buildBatch(
    preparation: BeginWorkspaceUpdateData,
    context: Readonly<{ signal: AbortSignal }>,
  ): unknown | Promise<unknown>;
}>;

type ActiveUtterance = {
  phase: "preview" | "preparing" | "submitting";
  sequence: number;
  abort: AbortController;
};

function localFailure<T>(code: string, message: string, retryable = false): WorkspaceAgentResult<T> {
  return { ok: false, error: { code, message, retryable } };
}

function sessionInput(session: WorkspaceInstructionsData | undefined):
  | { session_token: string; instruction_digest: string }
  | WorkspaceAgentResult<never> {
  if (!session) {
    return localFailure(
      "instructions_required",
      "Connect the realtime agent with get_workspace_instructions first",
      true,
    );
  }
  return {
    session_token: session.session_token,
    instruction_digest: session.guide_digest,
  };
}

/**
 * Provider-neutral realtime Agent adapter. It contains no model SDK, audio
 * transport, API key, or provider assumptions. Partial utterances touch only
 * RealtimeAgentPreviewSink; final durable changes always use begin + submit on
 * the canonical Agent tool surface.
 */
export class RealtimeAgentWorkspaceClient {
  private session?: WorkspaceInstructionsData;
  private readonly utterances = new Map<string, ActiveUtterance>();

  constructor(
    private readonly transport: WorkspaceToolTransport,
    private readonly previews: RealtimeAgentPreviewSink,
  ) {}

  get connected(): boolean {
    return Boolean(this.session);
  }

  get grantedScopes(): readonly WorkspacePermissionScope[] {
    return this.session?.granted_scopes ?? [];
  }

  async connect(input: {
    clientId?: string;
    clientName?: string;
    requestedScopes?: readonly WorkspacePermissionScope[];
  } = {}): Promise<WorkspaceAgentResult<WorkspaceInstructionsData>> {
    const result = await this.transport.call<WorkspaceInstructionsData>(
      "get_workspace_instructions",
      {
        ...(input.clientId ? { client_id: input.clientId } : {}),
        ...(input.clientName ? { client_name: input.clientName } : {}),
        ...(input.requestedScopes ? { requested_scopes: [...input.requestedScopes] } : {}),
      },
    );
    if (result.ok) this.session = result.data;
    return result;
  }

  disconnect(): void {
    for (const [utteranceId, state] of this.utterances) {
      if (state.phase !== "submitting") state.abort.abort("realtime_agent_disconnected");
      void this.previews.cancelPreview(utteranceId, "realtime_agent_disconnected");
    }
    this.utterances.clear();
    this.session = undefined;
  }

  async updatePartialUtterance(
    utteranceId: string,
    text: string,
    sequence: number,
  ): Promise<WorkspaceAgentResult<{ previewed: true }>> {
    if (!utteranceId || utteranceId.length > 256 || text.length > 20_000 || !Number.isSafeInteger(sequence) || sequence < 0) {
      return localFailure("invalid_realtime_preview", "Realtime preview id, text, or sequence is invalid", true);
    }
    const existing = this.utterances.get(utteranceId);
    if (existing?.phase === "preparing" || existing?.phase === "submitting") {
      return localFailure("utterance_already_finalizing", "This utterance is already being finalized");
    }
    if (existing && sequence <= existing.sequence) {
      return { ok: true, data: { previewed: true } };
    }
    const state: ActiveUtterance = existing ?? {
      phase: "preview",
      sequence,
      abort: new AbortController(),
    };
    state.sequence = sequence;
    this.utterances.set(utteranceId, state);
    await this.previews.updatePreview({ utteranceId, text, sequence, ephemeral: true });
    return { ok: true, data: { previewed: true } };
  }

  async interrupt(utteranceId: string, reason = "user_interrupted"): Promise<void> {
    const state = this.utterances.get(utteranceId);
    if (state && state.phase !== "submitting") {
      state.abort.abort(reason);
      this.utterances.delete(utteranceId);
    }
    // A submitting call intentionally receives no AbortSignal. Cancellation of
    // its preview cannot cancel or obscure an already-dispatched commit.
    await this.previews.cancelPreview(utteranceId, reason);
  }

  async inspect(): Promise<WorkspaceAgentResult<InspectWorkspaceData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<InspectWorkspaceData>("inspect_workspace", session);
  }

  async inspectComponent(
    componentId: string,
  ): Promise<WorkspaceAgentResult<InspectWorkspaceComponentData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<InspectWorkspaceComponentData>("inspect_workspace_component", {
      ...session,
      component_id: componentId,
    });
  }

  async readResourceSnapshot(
    resourceId: string,
  ): Promise<WorkspaceAgentResult<ReadWorkspaceResourceSnapshotData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<ReadWorkspaceResourceSnapshotData>("read_workspace_resource_snapshot", {
      ...session,
      resource_id: resourceId,
    });
  }

  async inspectSpace(
    sinceRevision?: number,
  ): Promise<WorkspaceAgentResult<InspectWorkspaceSpaceData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<InspectWorkspaceSpaceData>("inspect_workspace_space", {
      ...session,
      ...(sinceRevision === undefined ? {} : { since_revision: sinceRevision }),
    });
  }

  async querySpatialPlacement(
    candidate: unknown,
  ): Promise<WorkspaceAgentResult<QuerySpatialPlacementData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<QuerySpatialPlacementData>("query_spatial_placement", {
      ...session,
      candidate,
    });
  }

  async inspectPhysics(
    componentIds?: readonly string[],
  ): Promise<WorkspaceAgentResult<InspectWorkspacePhysicsData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<InspectWorkspacePhysicsData>("inspect_workspace_physics", {
      ...session,
      ...(componentIds ? { component_ids: componentIds } : {}),
    });
  }

  async queryStablePlacement(
    candidate: unknown,
  ): Promise<WorkspaceAgentResult<QueryStablePlacementData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<QueryStablePlacementData>("query_stable_placement", {
      ...session,
      candidate,
    });
  }

  async simulatePhysics(options: Readonly<{
    componentIds?: readonly string[];
    durationMs?: number;
    timeStepMs?: number;
  }> = {}): Promise<WorkspaceAgentResult<SimulateWorkspacePhysicsData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<SimulateWorkspacePhysicsData>("simulate_workspace_physics", {
      ...session,
      ...(options.componentIds ? { component_ids: options.componentIds } : {}),
      ...(options.durationMs === undefined ? {} : { duration_ms: options.durationMs }),
      ...(options.timeStepMs === undefined ? {} : { time_step_ms: options.timeStepMs }),
    });
  }

  async readEvents(
    afterCursor?: string,
    limit?: number,
  ): Promise<WorkspaceAgentResult<WorkspaceEventsData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<WorkspaceEventsData>("read_workspace_events", {
      ...session,
      ...(afterCursor ? { after_cursor: afterCursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    });
  }

  async undo(expectedWorkspaceRevision: number): Promise<WorkspaceAgentResult<WorkspaceHistoryData>> {
    return this.mutateHistory("undo_workspace_batch", expectedWorkspaceRevision);
  }

  async redo(expectedWorkspaceRevision: number): Promise<WorkspaceAgentResult<WorkspaceHistoryData>> {
    return this.mutateHistory("redo_workspace_batch", expectedWorkspaceRevision);
  }

  async commitFinalUpdate(
    input: RealtimeAgentFinalUpdateInput,
  ): Promise<WorkspaceAgentResult<SubmitWorkspaceBatchData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    if (!input.utteranceId || input.utteranceId.length > 256 || !input.intent.trim() || input.intent.length > 4_000) {
      return localFailure("invalid_final_utterance", "A final utterance requires a valid id and intent", true);
    }
    const existing = this.utterances.get(input.utteranceId);
    if (existing?.phase === "preparing" || existing?.phase === "submitting") {
      return localFailure("utterance_already_finalizing", "This utterance is already being finalized");
    }
    const state: ActiveUtterance = existing ?? {
      phase: "preview",
      sequence: 0,
      abort: new AbortController(),
    };
    state.phase = "preparing";
    this.utterances.set(input.utteranceId, state);
    await this.previews.clearPreview(input.utteranceId);

    try {
      const preparation = await this.transport.call<BeginWorkspaceUpdateData>(
        "begin_workspace_update",
        {
          ...session,
          intent: input.intent.trim(),
          ...(input.requestedComponentIds === undefined
            ? {}
            : { requested_component_ids: input.requestedComponentIds }),
        },
      );
      if (!preparation.ok) return preparation;
      if (state.abort.signal.aborted || this.utterances.get(input.utteranceId) !== state) {
        return localFailure("realtime_update_interrupted", "The final update was interrupted before submission", true);
      }

      let batch: unknown;
      try {
        batch = await input.buildBatch(preparation.data, { signal: state.abort.signal });
      } catch (cause) {
        if (state.abort.signal.aborted) {
          return localFailure("realtime_update_interrupted", "The final update was interrupted before submission", true);
        }
        return localFailure(
          "realtime_batch_build_failed",
          cause instanceof Error ? cause.message : "The realtime agent could not build a Workspace batch",
          true,
        );
      }
      if (state.abort.signal.aborted || this.utterances.get(input.utteranceId) !== state) {
        return localFailure("realtime_update_interrupted", "The final update was interrupted before submission", true);
      }

      state.phase = "submitting";
      return await this.transport.call<SubmitWorkspaceBatchData>(
        "submit_workspace_batch",
        {
          ...session,
          transaction_token: preparation.data.transaction_token,
          batch,
        },
      );
    } finally {
      if (this.utterances.get(input.utteranceId) === state) {
        this.utterances.delete(input.utteranceId);
      }
    }
  }

  private async mutateHistory(
    tool: "undo_workspace_batch" | "redo_workspace_batch",
    expectedWorkspaceRevision: number,
  ): Promise<WorkspaceAgentResult<WorkspaceHistoryData>> {
    const session = sessionInput(this.session);
    if ("ok" in session) return session;
    return this.transport.call<WorkspaceHistoryData>(tool, {
      ...session,
      expected_workspace_revision: expectedWorkspaceRevision,
    });
  }
}

export function workspaceControllerTransport(controller: {
  dispatch(name: unknown, input: unknown): Promise<WorkspaceAgentResult<unknown>>;
}): WorkspaceToolTransport {
  return {
    async call<T>(name: WorkspaceAgentToolName, input: unknown): Promise<WorkspaceAgentResult<T>> {
      return controller.dispatch(name, input) as Promise<WorkspaceAgentResult<T>>;
    },
  };
}
