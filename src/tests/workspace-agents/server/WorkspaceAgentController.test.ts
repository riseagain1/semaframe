import { describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  WorkspaceAgentController,
  destructiveWorkspaceOperations,
  requiredScopesForWorkspaceBatch,
} from "../../../workspace/agents/WorkspaceAgentController";
import {
  WORKSPACE_AGENT_GUIDE,
  getWorkspaceAgentGuideDigest,
  stableJson,
} from "../../../workspace/agents/guide";
import type {
  WorkspaceAgentPrincipal,
  WorkspaceAgentResult,
  WorkspaceCommitReceipt,
  WorkspaceComponentStateView,
  WorkspaceEnginePort,
  WorkspaceEventPage,
  WorkspaceHistoryReceipt,
  WorkspacePermissionScope,
  WorkspacePreparedUpdate,
  WorkspaceSpatialPlacementView,
  WorkspaceSpatialStateView,
  WorkspacePhysicsPlacementView,
  WorkspacePhysicsSimulationView,
  WorkspacePhysicsStateView,
  WorkspaceStateView,
} from "../../../workspace/agents/contracts";
import {
  WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES,
  WorkspaceEngineError,
} from "../../../workspace/agents/contracts";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import { WorkspaceStore } from "../../../workspace/state/WorkspaceStore";
import type { WorkspaceState } from "../../../workspace/state/workspaceState";

class FakeWorkspaceEngine implements WorkspaceEnginePort {
  revision = 0;
  registryDigest = "registry_digest_v1";
  inputRevision = 0;
  prepareCalls: Array<{ intent: string; requestedIds?: number; principal?: WorkspaceAgentPrincipal }> = [];
  submitCalls: Array<{ prepared: WorkspacePreparedUpdate; batch: unknown; principal: WorkspaceAgentPrincipal }> = [];
  undoCalls: Array<{ expected: number; principal: WorkspaceAgentPrincipal }> = [];
  redoCalls: Array<{ expected: number; principal: WorkspaceAgentPrincipal }> = [];
  readCalls: Array<{ cursor?: string; limit: number }> = [];
  componentInspectionCalls: Array<{ componentId: string; principal: WorkspaceAgentPrincipal }> = [];
  submitError?: WorkspaceEngineError;
  submitBarrier?: Promise<void>;

  getState(): WorkspaceStateView {
    return {
      workspaceId: "workspace_main",
      revision: this.revision,
      summary: { component_count: 0 },
      capabilityManifest: { component_types: ["builtin.timer"] },
    };
  }

  getRevision(): number {
    return this.revision;
  }

  inspectComponent(
    componentId: string,
    principal: WorkspaceAgentPrincipal,
  ): WorkspaceComponentStateView {
    this.componentInspectionCalls.push({ componentId, principal });
    if (componentId === "missing") {
      throw new WorkspaceEngineError("component_not_found", "Component does not exist", {
        retryable: true,
        requiredAction: "inspect_workspace",
      });
    }
    return {
      workspaceId: "workspace_main",
      revision: this.revision,
      registryDigest: this.registryDigest,
      component: {
        id: componentId,
        type: { typeId: "timer", version: "1.1.0", digest: "timer_digest" },
        label: "Focus timer",
        props: { durationMs: 10_000 },
        durable_state: { running: false },
        placement: {
          space: "viewport",
          anchor: "top_right",
          offset: { x: -24, y: 24 },
          size: { width: 210, height: 112 },
        },
        bindings: [],
        tags: [],
        visibility: "visible",
        locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
        provenance: { createdRevision: 0, createdBy: "user" },
      },
      pinnedManifest: {
        typeId: "timer",
        version: "1.1.0",
        digest: "timer_digest",
        resizePolicy: {},
      },
      interactionCompatibility: {
        status: "legacy_pinned",
        pinned_version: "1.1.0",
        current_version: "1.2.0",
        supports_current_interactions: false,
      },
      eventConnections: [],
      currentGeometry: { kind: "box2d", size: { width: 210, height: 112 } },
      activeResizePolicy: {
        kind: "box2d",
        mode: "free",
        defaultSize: { width: 210, height: 112 },
        minSize: { width: 120, height: 72 },
        maxSize: { width: 4096, height: 4096 },
        allowedAxes: ["width", "height"],
        units: "px",
      },
      currentVisualEffects: {
        opacity: 1,
        emissive: { color: "#FFFFFF", intensity: 0 },
        glow: { color: "#68D5FF", intensity: 0, spread: 0.5 },
      },
      visualEffectsPolicy: {
        opacity: { min: 0, max: 1 },
        emissive_intensity: { min: 0, max: 8 },
        glow_intensity: { min: 0, max: 4 },
        glow_spread: { min: 0, max: 1 },
        colors: "#RRGGBB",
      },
      redactedFields: [],
      stateTruncated: false,
      omittedStateBytes: 0,
      componentMetadataTruncated: false,
      omittedBindingCount: 0,
      omittedEventConnectionCount: 0,
      omittedTagCount: 0,
      omittedRedactedFieldCount: 0,
      manifestTruncated: false,
    };
  }

  getRegistryDigest(): string {
    return this.registryDigest;
  }

  inspectSpace(): WorkspaceSpatialStateView {
    return {
      workspaceId: "workspace_main",
      revision: this.revision,
      registryDigest: this.registryDigest,
      universalSpaceData: { format: "universal-space-data", version: "2.0", nodes: [] },
    };
  }

  querySpatialPlacement(): WorkspaceSpatialPlacementView {
    return {
      workspaceId: "workspace_main",
      revision: this.revision,
      registryDigest: this.registryDigest,
      placementCheck: { valid: true, candidate_id: "candidate", conflicts: [], suggested_placements: [] },
    };
  }

  inspectPhysics(): WorkspacePhysicsStateView {
    return {
      workspaceId: "workspace_main",
      revision: this.revision,
      registryDigest: this.registryDigest,
      physicsValidation: { format: "workspace-physics-report", version: "2.0", feasible: true, bodies: [], issues: [] },
    };
  }

  queryStablePlacement(): WorkspacePhysicsPlacementView {
    return {
      workspaceId: "workspace_main",
      revision: this.revision,
      registryDigest: this.registryDigest,
      stabilityCheck: { valid: true, candidate_id: "candidate", issues: [], suggested_placements: [] },
    };
  }

  simulatePhysics(): WorkspacePhysicsSimulationView {
    return {
      workspaceId: "workspace_main",
      revision: this.revision,
      registryDigest: this.registryDigest,
      simulation: { format: "workspace-physics-settle", version: "2.0", mutates_workspace: false, proposals: [] },
    };
  }

  prepare(intent: string, requestedIds?: number, principal?: WorkspaceAgentPrincipal): WorkspacePreparedUpdate {
    this.prepareCalls.push({ intent, requestedIds, principal });
    this.inputRevision += 1;
    return {
      envelope: {
        protocol_version: "1.2",
        request_id: `workspace_request_${this.inputRevision}`,
        workspace_id: "workspace_main",
        input_revision: this.inputRevision,
        base_workspace_revision: this.revision,
        registry_digest: this.registryDigest,
        mode: "commit",
      },
      workspace_summary: { component_count: 0 },
      capability_manifest: { component_types: ["builtin.timer"] },
      reserved_component_ids: Array.from(
        { length: requestedIds ?? 1 },
        (_, index) => `CMP_${this.inputRevision}_${index + 1}`,
      ),
    };
  }

  async submit(
    prepared: WorkspacePreparedUpdate,
    batch: unknown,
    principal: WorkspaceAgentPrincipal,
  ): Promise<WorkspaceCommitReceipt> {
    this.submitCalls.push({ prepared, batch, principal });
    await this.submitBarrier;
    if (this.submitError) {
      const error = this.submitError;
      this.submitError = undefined;
      throw error;
    }
    const base = this.revision;
    this.revision += 1;
    return {
      requestId: prepared.envelope.request_id,
      baseWorkspaceRevision: base,
      resultingWorkspaceRevision: this.revision,
      status: "committed",
      summary: "Workspace updated",
      delta: { added: prepared.reserved_component_ids.slice(0, 1) },
      resolvedBatch: batch as never,
    };
  }

  undo(expectedRevision: number, principal: WorkspaceAgentPrincipal): WorkspaceHistoryReceipt {
    this.undoCalls.push({ expected: expectedRevision, principal });
    if (this.revision > 0) this.revision -= 1;
    return { action: "undo", changed: true, workspaceRevision: this.revision, delta: { undone: true } };
  }

  redo(expectedRevision: number, principal: WorkspaceAgentPrincipal): WorkspaceHistoryReceipt {
    this.redoCalls.push({ expected: expectedRevision, principal });
    this.revision += 1;
    return { action: "redo", changed: true, workspaceRevision: this.revision, delta: { redone: true } };
  }

  readEvents(cursor: string | undefined, limit: number): WorkspaceEventPage {
    this.readCalls.push({ cursor, limit });
    return {
      events: [{
        id: "event_timer_finished",
        cursor: "cursor_2",
        type: "timer.finished",
        source: "system",
        workspaceRevision: this.revision,
        occurredAt: "2026-08-14T00:00:00.000Z",
        componentId: "CMP_TIMER",
        payload: { run_id: "run_1" },
      }],
      nextCursor: "cursor_2",
      hasMore: false,
    };
  }
}

function unwrap<T>(result: WorkspaceAgentResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function controllerFor(engine: FakeWorkspaceEngine, scopes: readonly WorkspacePermissionScope[]) {
  let tokenSequence = 0;
  return new WorkspaceAgentController(engine, {
    randomToken: (prefix) => `${prefix}_${String(++tokenSequence).padStart(32, "0")}`,
    grantScopes: ({ requestedScopes }) => scopes.filter((scope) => requestedScopes.includes(scope)),
  });
}

async function sessionFor(
  controller: WorkspaceAgentController,
  requestedScopes: readonly WorkspacePermissionScope[],
) {
  const instructions = unwrap(await controller.getWorkspaceInstructions({
    client_id: "realtime-client",
    client_name: "Realtime\u202e controller",
    requested_scopes: requestedScopes,
  }));
  return {
    session_token: instructions.session_token,
    instruction_digest: instructions.guide_digest,
  };
}

async function begin(
  controller: WorkspaceAgentController,
  session: { session_token: string; instruction_digest: string },
) {
  return unwrap(await controller.beginWorkspaceUpdate({
    ...session,
    intent: "Create a timer above the desk",
    requested_component_ids: 2,
  }));
}

describe("WorkspaceAgentController", () => {
  it("issues the canonical digest, sanitizes identity, and grants only requested approved scopes", async () => {
    const engine = new FakeWorkspaceEngine();
    const controller = controllerFor(engine, ["workspace:read", "workspace:write", "component:create"]);
    const instructions = unwrap(await controller.getWorkspaceInstructions({
      client_id: "client-a",
      client_name: "JARVIS\u202e admin",
      requested_scopes: ["workspace:read", "workspace:write", "component:create", "component:delete"],
    }));

    expect(instructions.guide).toEqual(WORKSPACE_AGENT_GUIDE);
    expect(instructions.guide.instructions).toContain("component:delete");
    expect(instructions.guide.instructions).toContain("connector:delete");
    expect(instructions.guide.instructions).toContain("workspace:clear");
    expect(instructions.guide.instructions).not.toContain("workspace:delete");
    expect(instructions.guide.guide_version).toBe("2.4");
    expect(instructions.guide.protocol_version).toBe("1.2");
    expect(instructions.guide.data_interaction_quickstart).toMatchObject({
      required_scopes: expect.arrayContaining(["connector:bind", "event:connect"]),
      stock_chart: {
        resource: {
          resource: {
            outputSchema: {
              type: "object",
              required: ["labels", "series"],
            },
          },
        },
      },
      interactions: expect.any(Array),
    });
    expect(instructions.guide.instructions).toContain("registered video-player component");
    expect(instructions.guide.instructions).toContain("Do not put iframe markup");
    expect(instructions.guide.instructions).toContain("Connect through SemaFrame agent controls");
    expect(instructions.guide.instructions).toContain("there is no separate privileged authority or alternate protocol");
    expect(instructions.guide.instructions).toContain('digest: "auto"');
    expect(instructions.guide.instructions).toContain("A fresh or reset Workspace has zero components");
    expect(instructions.guide.instructions).toContain("canvas2d and viewport work without one");
    expect(instructions.guide.instructions).toContain("create exactly one stage-3d");
    expect(instructions.guide.instructions).toContain("explicit resize_component operation");
    expect(instructions.guide.instructions).toContain("current_geometry");
    expect(instructions.guide.instructions).toContain("inspect_workspace_component");
    expect(instructions.guide.instructions).toContain("stage_dimensions");
    expect(instructions.guide.instructions).toContain("never silently clamps an Agent value");
    expect(instructions.guide.instructions).toContain("instruction_digest to the exact");
    expect(instructions.guide.instructions).toContain("Never send a later input");
    expect(instructions.guide.instructions).toContain("top level, not deeply");
    expect(instructions.guide.instructions).not.toContain("compat:scene-v0.2");
    expect(instructions.guide.default_requested_scopes).toContain("component:recipe_define");
    expect(JSON.stringify(instructions.guide)).toContain("workspace_command_schema");
    expect(JSON.stringify(instructions.guide)).toContain("define_component_recipe");
    expect(JSON.stringify(instructions.guide)).toContain("resize_component");
    expect(JSON.stringify(instructions.guide)).toContain("clear_workspace");
    expect(instructions.guide_digest).toBe(await getWorkspaceAgentGuideDigest());
    expect(instructions.client_name).toBe("JARVIS admin");
    expect(instructions.granted_scopes).toEqual(["component:create", "workspace:read", "workspace:write"]);
    expect(instructions.denied_scopes).toEqual(["component:delete"]);

    const invalid = await controller.getWorkspaceInstructions({ unknown: true });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("publishes an executable digest binding and a standalone create_component schema", async () => {
    const engine = new FakeWorkspaceEngine();
    const controller = controllerFor(engine, ["workspace:read"]);
    const instructions = unwrap(await controller.getWorkspaceInstructions({
      client_id: "quickstart-client",
      requested_scopes: ["workspace:read"],
    }));
    const quickstart = instructions.guide.creation_quickstart as {
      digest_binding: { source: string; later_input_field: string };
      required_scopes: string[];
    };
    expect(quickstart.digest_binding).toEqual(expect.objectContaining({
      source: "get_workspace_instructions.data.guide_digest",
      later_input_field: "instruction_digest",
    }));
    expect(quickstart.required_scopes).toEqual([
      "workspace:read",
      "workspace:write",
      "component:create",
    ]);

    const laterInput = {
      session_token: instructions.session_token,
      [quickstart.digest_binding.later_input_field]: instructions.guide_digest,
    };
    expect(laterInput).not.toHaveProperty("guide_digest");
    expect(unwrap(await controller.inspectWorkspace(laterInput))).toMatchObject({
      workspace_id: "workspace_main",
    });

    const validateCreate = new Ajv2020({ allErrors: true, strict: true }).compile(
      instructions.guide.create_component_schema as object,
    );
    expect(validateCreate({
      op: "create_component",
      op_id: "create_text",
      id: "CMP_000001",
      component_type: { typeId: "text", version: "1.1.0", digest: "sha256:exact" },
      props: { text: "Hello" },
      placement: { space: "canvas2d", position: { x: 0, y: 0 } },
    })).toBe(true);
    expect(validateCreate({
      op: "create_component",
      op_id: "create_text",
      id: "CMP_000001",
      component_type: { typeId: "text", version: "1.1.0", digest: "sha256:exact" },
    })).toBe(false);
  });

  it("requires an instruction session and the exact guide digest for every later tool", async () => {
    const engine = new FakeWorkspaceEngine();
    const controller = controllerFor(engine, ["workspace:read"]);
    expect(await controller.inspectWorkspace({})).toMatchObject({
      ok: false,
      error: {
        code: "instructions_required",
        message: expect.stringContaining("set instruction_digest to its returned guide_digest"),
        required_action: "get_workspace_instructions",
      },
    });
    const session = await sessionFor(controller, ["workspace:read"]);
    expect(await controller.inspectWorkspace({ ...session, instruction_digest: "wrong_digest" })).toMatchObject({
      ok: false,
      error: { code: "instruction_digest_mismatch" },
    });
    const inspection = unwrap(await controller.inspectWorkspace(session));
    expect(inspection).toMatchObject({
      workspace_id: "workspace_main",
      workspace_revision: 0,
      registry_digest: "registry_digest_v1",
    });
  });

  it("inspects one exact component by ID through the scoped instruction session", async () => {
    const engine = new FakeWorkspaceEngine();
    const controller = controllerFor(engine, ["workspace:read"]);
    const session = await sessionFor(controller, ["workspace:read"]);
    const inspection = unwrap(await controller.inspectWorkspaceComponent({
      ...session,
      component_id: "CMP_TARGET_061",
    }));

    expect(inspection).toMatchObject({
      workspace_id: "workspace_main",
      workspace_revision: 0,
      registry_digest: "registry_digest_v1",
      component: { id: "CMP_TARGET_061", label: "Focus timer" },
      pinned_manifest: { typeId: "timer", version: "1.1.0", digest: "timer_digest" },
      current_geometry: { kind: "box2d", size: { width: 210, height: 112 } },
      active_resize_policy: { kind: "box2d", mode: "free" },
      redacted_fields: [],
      state_truncated: false,
      omitted_state_bytes: 0,
      component_metadata_truncated: false,
      omitted_binding_count: 0,
      omitted_tag_count: 0,
      omitted_redacted_field_count: 0,
      manifest_truncated: false,
    });
    expect(engine.componentInspectionCalls).toEqual([{
      componentId: "CMP_TARGET_061",
      principal: expect.objectContaining({ clientId: "realtime-client", scopes: ["workspace:read"] }),
    }]);
    expect(await controller.inspectWorkspaceComponent({
      ...session,
      component_id: "bad component id",
    })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await controller.inspectWorkspaceComponent({
      ...session,
      component_id: "missing",
    })).toMatchObject({
      ok: false,
      error: { code: "component_not_found", required_action: "inspect_workspace" },
    });

    const deniedController = controllerFor(new FakeWorkspaceEngine(), []);
    const deniedSession = await sessionFor(deniedController, ["workspace:read"]);
    expect(await deniedController.inspectWorkspaceComponent({
      ...deniedSession,
      component_id: "CMP_TARGET_061",
    })).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  it("keeps the final public inspection wrapper within one MiB at maximum client identity lengths", async () => {
    const seed = new WorkspaceStore();
    const initialState = seed.getState() as WorkspaceState;
    const timerManifest = seed.getComponentManifest("timer")!;
    const bindingIds = Array.from({ length: 5_000 }, (_, index) =>
      `BIND_${String(index).padStart(5, "0")}_${"x".repeat(180)}`);
    initialState.resources.set("RES_wrapper_fixture", {
      id: "RES_wrapper_fixture",
      label: "Wrapper fixture",
      connectorType: "fixture",
      connectorVersion: "1",
      outputSchema: { type: "number" },
      config: {},
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: {
        data: 10_000,
        contentHash: "sha256:wrapper-fixture",
        retrievedAt: "2026-08-14T00:00:00.000Z",
        stale: false,
        provenance: [],
      },
      status: "ready",
    });
    initialState.components.set("CMP_WRAPPER_BOUND", {
      id: "CMP_WRAPPER_BOUND",
      type: {
        typeId: timerManifest.typeId,
        version: timerManifest.version,
        digest: timerManifest.digest,
      },
      label: "Wrapper-bound timer",
      props: structuredClone(timerManifest.defaultProps),
      durableState: structuredClone(timerManifest.defaultDurableState),
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 210, height: 112 },
      },
      bindings: [...bindingIds],
      tags: [],
      visibility: "visible",
      locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
      provenance: { createdRevision: 0, createdBy: "user" },
    });
    for (const id of bindingIds) {
      initialState.connections.set(id, {
        kind: "resource_binding",
        id,
        resourceId: "RES_wrapper_fixture",
        componentId: "CMP_WRAPPER_BOUND",
        targetProp: "durationMs",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      });
    }
    const adapter = new WorkspaceStoreEngineAdapter(new WorkspaceStore({ initialState }), {
      requestId: (inputRevision) => `wrapper_request_${inputRevision}`,
    });
    let tokenSequence = 0;
    const controller = new WorkspaceAgentController(adapter, {
      randomToken: (prefix) => `${prefix}_${String(++tokenSequence).padStart(32, "0")}`,
      grantScopes: () => ["workspace:read"],
    });
    const maximumClientId = "界".repeat(128);
    const maximumClientName = "名".repeat(160);
    const instructions = unwrap(await controller.getWorkspaceInstructions({
      client_id: maximumClientId,
      client_name: maximumClientName,
      requested_scopes: ["workspace:read"],
    }));
    const publicResult = await controller.inspectWorkspaceComponent({
      session_token: instructions.session_token,
      instruction_digest: instructions.guide_digest,
      component_id: "CMP_WRAPPER_BOUND",
    });

    expect(publicResult).toMatchObject({
      ok: true,
      data: {
        client_id: maximumClientId,
        client_name: maximumClientName,
        component_metadata_truncated: false,
        omitted_binding_count: expect.any(Number),
        manifest_truncated: false,
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(publicResult)).byteLength)
      .toBeLessThanOrEqual(WORKSPACE_COMPONENT_INSPECTION_MAX_BYTES);
  }, 15_000);

  it("prepares and commits through an exact revision- and registry-bound envelope", async () => {
    const engine = new FakeWorkspaceEngine();
    const controller = controllerFor(engine, ["workspace:read", "workspace:write", "component:create"]);
    const session = await sessionFor(controller, ["workspace:read", "workspace:write", "component:create"]);
    const preparation = await begin(controller, session);
    const batch = {
      ...preparation.envelope,
      operations: [{
        op: "create_component",
        op_id: "create_timer",
        id: preparation.reserved_component_ids[0],
      }],
    };
    const receipt = unwrap(await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: preparation.transaction_token,
      batch,
    }));

    expect(receipt).toMatchObject({
      request_id: preparation.envelope.request_id,
      base_workspace_revision: 0,
      resulting_workspace_revision: 1,
      status: "committed",
    });
    expect(engine.submitCalls).toHaveLength(1);
    expect(engine.submitCalls[0]?.principal.scopes).toContain("component:create");
    expect(engine.prepareCalls[0]).toMatchObject({ requestedIds: 2 });
  });

  it("rejects envelope tampering, stale revisions, and stale registry digests before core submission", async () => {
    const engine = new FakeWorkspaceEngine();
    const controller = controllerFor(engine, ["workspace:read", "workspace:write", "component:update"]);
    const session = await sessionFor(controller, ["workspace:read", "workspace:write", "component:update"]);

    const tampered = await begin(controller, session);
    const tamperedResult = await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: tampered.transaction_token,
      batch: { ...tampered.envelope, workspace_id: "other", operations: [] },
    });
    expect(tamperedResult).toMatchObject({ ok: false, error: { code: "batch_envelope_mismatch" } });

    const staleRevision = await begin(controller, session);
    engine.revision += 1;
    expect(await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: staleRevision.transaction_token,
      batch: { ...staleRevision.envelope, operations: [] },
    })).toMatchObject({ ok: false, error: { code: "stale_workspace_revision" } });

    const staleRegistry = await begin(controller, session);
    engine.registryDigest = "registry_digest_v2";
    expect(await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: staleRegistry.transaction_token,
      batch: { ...staleRegistry.envelope, operations: [] },
    })).toMatchObject({ ok: false, error: { code: "stale_registry_digest" } });
    expect(engine.submitCalls).toHaveLength(0);
  });

  it("deduplicates identical concurrent and completed retries while rejecting changed content", async () => {
    const engine = new FakeWorkspaceEngine();
    let release!: () => void;
    engine.submitBarrier = new Promise<void>((resolve) => { release = resolve; });
    const controller = controllerFor(engine, ["workspace:read", "workspace:write", "component:update"]);
    const session = await sessionFor(controller, ["workspace:read", "workspace:write", "component:update"]);
    const preparation = await begin(controller, session);
    const batch = { ...preparation.envelope, operations: [] };
    const input = { ...session, transaction_token: preparation.transaction_token, batch };

    const first = controller.submitWorkspaceBatch(input);
    const second = controller.submitWorkspaceBatch(input);
    await vi.waitFor(() => expect(engine.submitCalls).toHaveLength(1));
    release();
    expect(unwrap(await first)).toEqual(unwrap(await second));
    expect(unwrap(await controller.submitWorkspaceBatch(input)).resulting_workspace_revision).toBe(1);

    expect(await controller.submitWorkspaceBatch({
      ...input,
      batch: { ...batch, operations: [{ op: "update_component", op_id: "different", id: "CMP_X", patch: {} }] },
    })).toMatchObject({ ok: false, error: { code: "batch_retry_mismatch" } });
    expect(engine.submitCalls).toHaveLength(1);
  });

  it("allows a corrected batch after authoritative validation failure", async () => {
    const engine = new FakeWorkspaceEngine();
    engine.submitError = new WorkspaceEngineError(
      "command_validation_failed",
      "props do not match component schema",
      { retryable: true },
    );
    const controller = controllerFor(engine, ["workspace:read", "workspace:write", "component:update"]);
    const session = await sessionFor(controller, ["workspace:read", "workspace:write", "component:update"]);
    const preparation = await begin(controller, session);
    const first = await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: preparation.transaction_token,
      batch: { ...preparation.envelope, operations: [] },
    });
    expect(first).toMatchObject({ ok: false, error: { code: "command_validation_failed" } });

    const corrected = unwrap(await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: preparation.transaction_token,
      batch: {
        ...preparation.envelope,
        operations: [{ op: "update_component", op_id: "corrected", id: "CMP_X", patch: { label: "Timer" } }],
      },
    }));
    expect(corrected.resulting_workspace_revision).toBe(1);
    expect(engine.submitCalls).toHaveLength(2);
  });

  it("maps exact core v1 operations to scopes and denies delete_resource and bind_resource without grants", async () => {
    expect(requiredScopesForWorkspaceBatch({ operations: [{ op: "resize_component" }] })).toEqual([
      "component:update",
      "workspace:write",
    ]);
    expect(requiredScopesForWorkspaceBatch({ operations: [{ op: "set_component_visual_effects" }] })).toEqual([
      "component:update",
      "workspace:write",
    ]);
    expect(requiredScopesForWorkspaceBatch({ operations: [{ op: "delete_resource" }] })).toEqual([
      "connector:delete",
      "workspace:write",
    ]);
    expect(requiredScopesForWorkspaceBatch({ operations: [{ op: "bind_resource" }] })).toEqual([
      "connector:bind",
      "workspace:write",
    ]);
    expect(destructiveWorkspaceOperations({ operations: [{ op: "delete_resource", op_id: "delete_feed" }] })).toEqual([
      { index: 0, op: "delete_resource", op_id: "delete_feed" },
    ]);

    const engine = new FakeWorkspaceEngine();
    const controller = controllerFor(engine, ["workspace:read", "workspace:write"]);
    const session = await sessionFor(controller, [
      "workspace:read",
      "workspace:write",
      "component:update",
      "connector:delete",
      "connector:bind",
    ]);
    const resizing = await begin(controller, session);
    expect(await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: resizing.transaction_token,
      batch: {
        ...resizing.envelope,
        operations: [{
          op: "resize_component",
          op_id: "resize_timer",
          id: "CMP_TIMER",
          resize: { kind: "box2d", size: { width: 300, height: 160 } },
        }],
      },
    })).toMatchObject({
      ok: false,
      error: { code: "permission_denied", details: { missing_scopes: ["component:update"] } },
    });
    const deletion = await begin(controller, session);
    expect(await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: deletion.transaction_token,
      batch: {
        ...deletion.envelope,
        operations: [{ op: "delete_resource", op_id: "delete_feed", resource_id: "feed" }],
      },
    })).toMatchObject({
      ok: false,
      error: {
        code: "destructive_permission_required",
        details: { missing_scopes: ["connector:delete"] },
      },
    });

    const binding = await begin(controller, session);
    expect(await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: binding.transaction_token,
      batch: {
        ...binding.envelope,
        operations: [{ op: "bind_resource", op_id: "bind_feed", binding: {} }],
      },
    })).toMatchObject({
      ok: false,
      error: { code: "permission_denied", details: { missing_scopes: ["connector:bind"] } },
    });
    expect(engine.submitCalls).toHaveLength(0);
  });

  it("guards history by exact revision and reads bounded resumable event pages", async () => {
    const engine = new FakeWorkspaceEngine();
    engine.revision = 2;
    const controller = controllerFor(engine, ["workspace:read", "workspace:history"]);
    const session = await sessionFor(controller, ["workspace:read", "workspace:history"]);
    expect(await controller.undoWorkspaceBatch({
      ...session,
      expected_workspace_revision: 1,
    })).toMatchObject({ ok: false, error: { code: "stale_workspace_revision" } });
    expect(unwrap(await controller.undoWorkspaceBatch({
      ...session,
      expected_workspace_revision: 2,
    }))).toMatchObject({ action: "undo", workspace_revision: 1 });

    expect(await controller.readWorkspaceEvents({ ...session, limit: 201 })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    const page = unwrap(await controller.readWorkspaceEvents({
      ...session,
      after_cursor: "cursor_1",
      limit: 20,
    }));
    expect(page.next_cursor).toBe("cursor_2");
    expect(page.events[0]).toMatchObject({ id: "event_timer_finished", source: "system" });
    expect(engine.readCalls).toEqual([{ cursor: "cursor_1", limit: 20 }]);
  });

  it("rejects cyclic, prototype-shaped, over-deep, and oversized batch data before the engine", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => stableJson(cycle)).toThrow(/cycle/u);
    expect(() => stableJson(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(/prohibited key/u);
    let deep: unknown = "leaf";
    for (let index = 0; index < 34; index += 1) deep = { child: deep };
    expect(() => stableJson(deep)).toThrow(/depth/u);
    expect(() => stableJson({ text: "x".repeat(1_048_576) })).toThrow(/encoded size/u);

    const engine = new FakeWorkspaceEngine();
    const controller = controllerFor(engine, ["workspace:read", "workspace:write"]);
    const session = await sessionFor(controller, ["workspace:read", "workspace:write"]);
    const preparation = await begin(controller, session);
    expect(await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: preparation.transaction_token,
      batch: cycle,
    })).toMatchObject({ ok: false, error: { code: "invalid_batch" } });
    expect(engine.submitCalls).toHaveLength(0);
  });
});
