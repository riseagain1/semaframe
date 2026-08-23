import { describe, expect, it } from "vitest";
import type { ComponentPlacement } from "../../../workspace/components/componentTypes";
import type { WorkspaceCommandBatch, WorkspaceOperation } from "../../../workspace/protocol/workspaceTypes";
import { prepareComponentRecipe } from "../../../workspace/protocol/validateWorkspaceBatch";
import { WorkspaceStore } from "../../../workspace/state/WorkspaceStore";
import type { WorkspaceState } from "../../../workspace/state/workspaceState";
import {
  WORKSPACE_OPERATION_NAMES,
  WorkspaceStoreEngineAdapter,
} from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import type {
  WorkspaceAgentPrincipal,
  WorkspacePermissionScope,
  WorkspacePreparedUpdate,
} from "../../../workspace/agents/contracts";
import { WorkspaceEngineError } from "../../../workspace/agents/contracts";

const textBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function principal(
  scopes: readonly WorkspacePermissionScope[],
  sessionId = "session_a",
  clientId = "client_a",
): WorkspaceAgentPrincipal {
  return { sessionId, clientId, clientName: "Test agent", scopes };
}

function adapterFor(store = new WorkspaceStore(), options: ConstructorParameters<typeof WorkspaceStoreEngineAdapter>[1] = {}) {
  return new WorkspaceStoreEngineAdapter(store, {
    requestId: (inputRevision) => `agent_request_${inputRevision}`,
    ...options,
  });
}

function batchFor(
  prepared: WorkspacePreparedUpdate,
  operations: readonly WorkspaceOperation[],
): WorkspaceCommandBatch {
  return {
    ...prepared.envelope,
    protocol_version: "1.2",
    operations: [...structuredClone(operations)],
  };
}

function applyCurrentBatch(
  store: WorkspaceStore,
  requestId: string,
  operations: readonly WorkspaceOperation[],
): void {
  const state = store.getState();
  store.apply({
    protocol_version: "1.3",
    request_id: requestId,
    workspace_id: state.workspaceId,
    input_revision: state.revision,
    base_workspace_revision: state.revision,
    registry_digest: state.registryDigest,
    mode: "commit",
    operations: [...structuredClone(operations)],
  });
}

function publishedCadModel(cadPartCount = 1): WorkspaceStore {
  const store = new WorkspaceStore();
  const stage = store.getComponentManifest("stage-3d")!;
  const assembly = store.getComponentManifest("model-assembly", "2.0.0")!;
  const cadPart = store.getComponentManifest("cad-part")!;
  const world = (x: number) => ({
    space: "world3d" as const,
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
  applyCurrentBatch(store, "author_cad_model", [{
    op: "create_component",
    op_id: "stage",
    id: "STAGE",
    component_type: { typeId: stage.typeId, version: stage.version, digest: stage.digest },
    placement: world(0),
  }, {
    op: "create_component",
    op_id: "assembly",
    id: "CAD_ASSEMBLY",
    component_type: { typeId: assembly.typeId, version: assembly.version, digest: assembly.digest },
    props: {
      description: `CAD-heavy reusable assembly ${"x".repeat(1_800)}`,
      collisionPolicy: "external_only",
      partNumber: "ASM-ROOT-001",
      materialName: "Assembly steel",
      mates: [],
    },
    placement: world(0),
  }, ...Array.from({ length: cadPartCount }, (_, index): WorkspaceOperation => ({
    op: "create_component",
    op_id: `cad_part_${index}`,
    id: `CAD_PART_${String(index).padStart(3, "0")}`,
    component_type: { typeId: cadPart.typeId, version: cadPart.version, digest: cadPart.digest },
    props: {
      partNumber: `CAD-${String(index).padStart(3, "0")}-${"P".repeat(100)}`,
      materialName: `Machined alloy ${"M".repeat(220)}`,
    },
    placement: world(index + 1),
    parent_id: "CAD_ASSEMBLY",
  }))]);
  applyCurrentBatch(store, "publish_cad_model", [{
    op: "publish_model",
    op_id: "publish_cad",
    model_id: "com.semaframe.agent-cad",
    version: "2.0.0",
    display_name: "Agent CAD assembly",
    root_id: "CAD_ASSEMBLY",
  }]);
  return store;
}

function timerCreate(
  store: WorkspaceStore,
  id: string,
  opId = "create_timer",
): WorkspaceOperation {
  const manifest = store.getComponentManifest("timer");
  if (!manifest) throw new Error("timer manifest missing");
  return {
    op: "create_component",
    op_id: opId,
    id,
    component_type: {
      typeId: manifest.typeId,
      version: manifest.version,
      digest: manifest.digest,
    },
    props: { durationMs: 10_000, label: "Focus" },
    placement: {
      space: "viewport",
      anchor: "top_right",
      offset: { x: -24, y: 24 },
    },
  };
}

type AdvertisedComponentType = Readonly<{
  typeId: string;
  version: string;
  digest: string;
  allowedPlacements: readonly string[];
  defaultProps: Record<string, unknown>;
  defaultDurableState: Record<string, unknown>;
  defaultsRedacted: boolean;
}>;

function advertisedComponentTypes(prepared: WorkspacePreparedUpdate): AdvertisedComponentType[] {
  return (prepared.capability_manifest as { component_types: AdvertisedComponentType[] }).component_types;
}

function defaultCreatePlacement(manifest: AdvertisedComponentType, index = 0): ComponentPlacement {
  if (manifest.allowedPlacements.includes("viewport")) {
    return {
      space: "viewport",
      anchor: "center",
      offset: { x: index * 12, y: index * 12 },
    };
  }
  if (manifest.allowedPlacements.includes("world3d")) {
    return {
      space: "world3d",
      position: { x: index * 1.5, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
  }
  throw new Error(`No test placement for ${manifest.typeId}`);
}

describe("WorkspaceStoreEngineAdapter", () => {
  it("preserves ModelDefinition V2 logical and manufacturing metadata in exact model inspection", async () => {
    const adapter = adapterFor(publishedCadModel());
    const inspection = await adapter.inspectModel(
      "com.semaframe.agent-cad",
      "2.0.0",
      principal(["workspace:read"]),
    );
    const model = inspection.modelDefinition as {
      format_version: string;
      id_map_keys: string[];
      nodes: Array<Record<string, unknown>>;
    };

    expect(model.format_version).toBe("2.0");
    expect(model.id_map_keys).toEqual(["CAD_ASSEMBLY", "CAD_PART_000"]);
    expect(model.nodes).toEqual([
      expect.objectContaining({
        node_id: "CAD_ASSEMBLY",
        logical_node_id: "CAD_ASSEMBLY",
        part_number: "ASM-ROOT-001",
        material_name: "Assembly steel",
      }),
      expect.objectContaining({
        node_id: "CAD_PART_000",
        logical_node_id: "CAD_PART_000",
        part_number: expect.stringMatching(/^CAD-000-/u),
        material_name: expect.stringMatching(/^Machined alloy/u),
      }),
    ]);
  });

  it("rejects an oversized CAD-heavy model inspection exactly without truncating nodes or metadata", async () => {
    const store = publishedCadModel(16);
    const responseLimit = 8_192;
    const adapter = adapterFor(store, { maxModelInspectionBytes: responseLimit });
    const revision = store.getRevision();

    await expect(adapter.inspectModel(
      "com.semaframe.agent-cad",
      "2.0.0",
      principal(["workspace:read"]),
    )).rejects.toMatchObject({
      code: "model_inspection_too_large",
      options: {
        retryable: false,
        details: {
          model_id: "com.semaframe.agent-cad",
          version: "2.0.0",
          encoded_view_bytes: expect.any(Number),
          max_response_bytes: responseLimit,
          wrapper_reserve_bytes: 2_048,
          truncation_performed: false,
        },
      },
    });
    expect(store.getRevision()).toBe(revision);

    const complete = await adapterFor(store).inspectModel(
      "com.semaframe.agent-cad",
      "2.0.0",
      principal(["workspace:read"]),
    );
    expect((complete.modelDefinition as { id_map_keys: string[] }).id_map_keys).toHaveLength(17);
  });

  it("prepares exact revision/registry envelopes, unique reservations, and bounded manifests", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:read", "workspace:write", "component:create"]);
    const prepared = await adapter.prepare("Create a focus timer", 3, actor);

    expect(prepared.envelope).toEqual({
      protocol_version: "1.3",
      request_id: "agent_request_1",
      workspace_id: "workspace_main",
      input_revision: 1,
      base_workspace_revision: 0,
      registry_digest: store.getRegistryDigest(),
      mode: "commit",
    });
    expect(prepared.reserved_component_ids).toEqual(["CMP_000001", "CMP_000002", "CMP_000003"]);
    expect(new Set(prepared.reserved_component_ids).size).toBe(3);
    expect(textBytes(prepared.workspace_summary)).toBeLessThanOrEqual(300_000);
    expect(textBytes(prepared.capability_manifest)).toBeLessThanOrEqual(200_000);
    expect(prepared.capability_manifest).toMatchObject({
      protocol_version: "1.3",
      registry_digest: store.getRegistryDigest(),
      allowed_operations: WORKSPACE_OPERATION_NAMES,
      component_type_count: 20,
      connector_types: expect.arrayContaining([
        expect.objectContaining({
          connectorType: "inline.snapshot",
          connectorVersion: "1.0.0",
          execution: "none",
          networkAccess: false,
        }),
      ]),
      asset_library: expect.objectContaining({
        version: "neutral_low_poly_v1.0.0",
        omitted_asset_count: 0,
        assets: expect.arrayContaining([
          expect.objectContaining({
            asset_id: "humanoid_adult_neutral_01",
            kind: "character",
            animations: ["idle", "walk", "run", "enter", "exit"],
          }),
        ]),
      }),
      component_types: expect.arrayContaining([
        expect.objectContaining({
          typeId: "video-player",
          version: "1.2.0",
          allowedPlacements: ["canvas2d", "surface", "billboard", "viewport"],
          defaultProps: expect.objectContaining({
            sourceKind: "youtube",
            controls: true,
          }),
          defaultDurableState: {
            desiredPlayback: "stopped",
            lastCommand: "none",
            requestedTimeSeconds: 0,
            commandGeneration: 0,
          },
          defaultsRedacted: false,
          redactedDefaultFields: [],
          resizePolicy: expect.objectContaining({
            viewport: expect.objectContaining({
              kind: "box2d",
              mode: "aspect_locked",
              defaultSize: { width: 480, height: 306 },
              minSize: { width: 356, height: 236 },
              allowedAxes: ["width", "height"],
              units: "px",
            }),
          }),
          actions: expect.objectContaining({
            play: expect.any(Object),
            pause: expect.any(Object),
            seek: expect.any(Object),
            stop: expect.any(Object),
          }),
          events: expect.objectContaining({
            play_requested: expect.any(Object),
            seek_requested: expect.any(Object),
          }),
        }),
      ]),
    });
    const exposedTypes = (prepared.capability_manifest as {
      component_types: Array<{ typeId: string; actions: unknown }>;
    }).component_types;
    expect(Object.fromEntries(exposedTypes.map(({ typeId, actions }) => [typeId, actions]))).toEqual(
      Object.fromEntries(store.getComponentCatalog().map(({ typeId, actions }) => [typeId, actions])),
    );
  });

  it("publishes built-in defaults and applies them when create_component omits props and durable_state", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:read", "workspace:write", "component:create"]);
    const prepared = await adapter.prepare("Create a timer from published defaults", 1, actor);
    const timerManifest = store.getComponentManifest("timer")!;
    const capability = prepared.capability_manifest as {
      component_types: Array<{
        typeId: string;
        version: string;
        digest: string;
        defaultProps: Record<string, unknown>;
        defaultDurableState: Record<string, unknown>;
        defaultsRedacted: boolean;
        redactedDefaultFields: string[];
      }>;
    };
    const publicTimer = capability.component_types.find((entry) => entry.typeId === "timer");
    expect(publicTimer).toMatchObject({
      typeId: timerManifest.typeId,
      version: timerManifest.version,
      digest: timerManifest.digest,
      defaultProps: timerManifest.defaultProps,
      defaultDurableState: timerManifest.defaultDurableState,
      defaultsRedacted: false,
      redactedDefaultFields: [],
    });

    const id = prepared.reserved_component_ids[0]!;
    await adapter.submit(prepared, batchFor(prepared, [{
      op: "create_component",
      op_id: "create_default_timer",
      id,
      component_type: {
        typeId: timerManifest.typeId,
        version: timerManifest.version,
        digest: timerManifest.digest,
      },
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]), actor);

    expect(store.getState().components.get(id)).toMatchObject({
      props: timerManifest.defaultProps,
      durableState: timerManifest.defaultDurableState,
    });
  });

  it("creates every advertised built-in from omitted props/state with the documented stage-first workflow", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:read", "workspace:write", "component:create"]);
    const expectedCatalog = store.getComponentCatalog();

    const stagePreparation = await adapter.prepare("Create the root 3D stage", 1, actor);
    const advertisedStage = advertisedComponentTypes(stagePreparation)
      .find((manifest) => manifest.typeId === "stage-3d");
    expect(advertisedStage).toBeDefined();
    const stageId = stagePreparation.reserved_component_ids[0]!;
    await adapter.submit(stagePreparation, batchFor(stagePreparation, [{
      op: "create_component",
      op_id: "create_builtin_stage_3d",
      id: stageId,
      component_type: {
        typeId: advertisedStage!.typeId,
        version: advertisedStage!.version,
        digest: advertisedStage!.digest,
      },
      placement: defaultCreatePlacement(advertisedStage!),
    }]), actor);

    const remainingPreparation = await adapter.prepare(
      "Create every remaining built-in from its advertised defaults",
      expectedCatalog.length - 1,
      actor,
    );
    const remainingTypes = advertisedComponentTypes(remainingPreparation)
      .filter((manifest) => manifest.typeId !== "stage-3d");
    expect(remainingTypes).toHaveLength(expectedCatalog.length - 1);
    const idsByType = new Map<string, string>([["stage-3d", stageId]]);
    const operations: WorkspaceOperation[] = remainingTypes.map((manifest, index) => {
      const id = remainingPreparation.reserved_component_ids[index]!;
      idsByType.set(manifest.typeId, id);
      return {
        op: "create_component",
        op_id: `create_builtin_${manifest.typeId.replace(/[^A-Za-z0-9._:@/-]/gu, "_")}`,
        id,
        component_type: {
          typeId: manifest.typeId,
          version: manifest.version,
          digest: manifest.digest,
        },
        placement: defaultCreatePlacement(manifest, index + 1),
      };
    });
    await adapter.submit(remainingPreparation, batchFor(remainingPreparation, operations), actor);

    const state = store.getState();
    expect(state.components.size).toBe(expectedCatalog.length);
    const advertisedByType = new Map([
      [advertisedStage!.typeId, advertisedStage!],
      ...remainingTypes.map((manifest) => [manifest.typeId, manifest] as const),
    ]);
    for (const expected of expectedCatalog) {
      const advertised = advertisedByType.get(expected.typeId);
      const component = state.components.get(idsByType.get(expected.typeId)!);
      expect(advertised, `missing advertised manifest ${expected.typeId}`).toBeDefined();
      expect(advertised?.defaultsRedacted).toBe(false);
      expect(component, `missing created component ${expected.typeId}`).toMatchObject({
        type: {
          typeId: advertised!.typeId,
          version: advertised!.version,
          digest: advertised!.digest,
        },
        props: advertised!.defaultProps,
        durableState: advertised!.defaultDurableState,
      });
    }
  });

  it("keeps the documented top-level merge warning aligned with nested default replacement", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:read", "workspace:write", "component:create"]);
    const prepared = await adapter.prepare("Create a stage with an incomplete nested override", 1, actor);
    const stageManifest = store.getComponentManifest("stage-3d")!;

    await expect(adapter.submit(prepared, batchFor(prepared, [{
      op: "create_component",
      op_id: "create_partial_stage",
      id: prepared.reserved_component_ids[0]!,
      component_type: {
        typeId: stageManifest.typeId,
        version: stageManifest.version,
        digest: stageManifest.digest,
      },
      props: { dimensions: { width: 20 } },
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]), actor)).rejects.toMatchObject({
      code: "command_validation_failed",
      options: { details: { validation_code: "invalid_component_props" } },
    });
    expect(store.getRevision()).toBe(0);
  });

  it("commits through the real store, records the agent actor, and makes retries idempotent", async () => {
    const store = new WorkspaceStore({ clock: () => 1_000 });
    const adapter = adapterFor(store);
    const actor = principal(["workspace:write", "component:create"]);
    const prepared = await adapter.prepare("Create a focus timer", 1, actor);
    const create = timerCreate(store, prepared.reserved_component_ids[0]!);
    const command = batchFor(prepared, [create]);

    const committed = await adapter.submit(prepared, command, actor);
    expect(committed).toMatchObject({
      requestId: "agent_request_1",
      baseWorkspaceRevision: 0,
      resultingWorkspaceRevision: 1,
      status: "committed",
      delta: { added: [prepared.reserved_component_ids[0]] },
    });
    expect(store.getState().components.get(prepared.reserved_component_ids[0]!)?.props).toMatchObject({
      durationMs: 10_000,
      label: "Focus",
    });
    expect(store.getCommandHistory()[0]?.actor).toBe("agent");

    await expect(adapter.submit(prepared, command, actor)).resolves.toMatchObject({ status: "idempotent" });
    await expect(adapter.submit(prepared, {
      ...command,
      operations: [{ ...create, label: "Changed retry" }],
    }, actor)).rejects.toMatchObject({ code: "batch_retry_mismatch" });
    expect(store.getRevision()).toBe(1);
  });

  it("publishes exact geometry/effects and commits absolute Agent resize and styling commands", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal([
      "workspace:read",
      "workspace:write",
      "workspace:history",
      "component:create",
      "component:update",
    ]);
    const creation = await adapter.prepare("Create a resizable focus timer", 1, actor);
    const timerId = creation.reserved_component_ids[0]!;
    await adapter.submit(creation, batchFor(creation, [timerCreate(store, timerId)]), actor);

    const initialView = adapter.getState();
    expect(initialView.capabilityManifest).toMatchObject({
      allowed_operations: expect.arrayContaining(["resize_component", "set_component_visual_effects"]),
      component_types: expect.arrayContaining([expect.objectContaining({
        typeId: "timer",
        version: "1.2.0",
        resizePolicy: expect.objectContaining({
          viewport: expect.objectContaining({
            kind: "box2d",
            mode: "free",
            defaultSize: { width: 210, height: 112 },
          }),
        }),
      })]),
    });
    expect(initialView.summary).toMatchObject({
      revision: 1,
      components: [expect.objectContaining({
        id: timerId,
        placement: expect.objectContaining({ size: { width: 210, height: 112 } }),
        active_resize_policy: expect.objectContaining({
          kind: "box2d",
          mode: "free",
          defaultSize: { width: 210, height: 112 },
        }),
        current_geometry: { kind: "box2d", size: { width: 210, height: 112 } },
        current_visual_effects: {
          opacity: 1,
          emissive: { color: "#FFFFFF", intensity: 0 },
          glow: { color: "#68D5FF", intensity: 0, spread: 0.5 },
        },
        visual_effects_policy: expect.objectContaining({
          glow_intensity: { min: 0, max: 4 },
        }),
        locks: expect.objectContaining({ resize: false }),
      })],
    });

    const resizing = await adapter.prepare("Resize the focus timer", 1, actor);
    const receipt = await adapter.submit(resizing, batchFor(resizing, [{
      op: "resize_component",
      op_id: "resize_timer",
      id: timerId,
      resize: { kind: "box2d", size: { width: 300, height: 160 } },
    }]), actor);

    expect(receipt).toMatchObject({
      baseWorkspaceRevision: 1,
      resultingWorkspaceRevision: 2,
      status: "committed",
    });
    expect(store.getState().components.get(timerId)?.placement).toMatchObject({
      size: { width: 300, height: 160 },
    });
    expect(adapter.getState().summary).toMatchObject({
      revision: 2,
      components: [expect.objectContaining({
        id: timerId,
        current_geometry: { kind: "box2d", size: { width: 300, height: 160 } },
      })],
    });
    expect(store.getCommandHistory().at(-1)?.resolvedOperations).toEqual([
      expect.objectContaining({ op: "resize_component", id: timerId }),
    ]);

    const styling = await adapter.prepare("Make the focus timer translucent and glowing", 1, actor);
    const effects = {
      opacity: 0.78,
      emissive: { color: "#FF8844" as const, intensity: 1.6 },
      glow: { color: "#66DDFF" as const, intensity: 1.25, spread: 0.6 },
    };
    const effectReceipt = await adapter.submit(styling, batchFor(styling, [{
      op: "set_component_visual_effects",
      op_id: "style_timer",
      id: timerId,
      visual_effects: effects,
    }]), actor);
    expect(effectReceipt).toMatchObject({
      baseWorkspaceRevision: 2,
      resultingWorkspaceRevision: 3,
      status: "committed",
    });
    expect(store.getState().components.get(timerId)?.visualEffects).toEqual(effects);
    expect(adapter.getState().summary).toMatchObject({
      revision: 3,
      components: [expect.objectContaining({ id: timerId, current_visual_effects: effects })],
    });
    expect(store.getCommandHistory().at(-1)?.resolvedOperations).toEqual([
      expect.objectContaining({ op: "set_component_visual_effects", id: timerId, visual_effects: effects }),
    ]);
  });

  it("inspects an exact component omitted from the bounded summary", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store, { maxSummaryComponents: 1 });
    const actor = principal(["workspace:read", "workspace:write", "component:create"]);
    const creation = await adapter.prepare("Create two focus timers", 2, actor);
    const [firstId, targetId] = creation.reserved_component_ids;
    await adapter.submit(creation, batchFor(creation, [
      timerCreate(store, firstId!, "create_first_timer"),
      timerCreate(store, targetId!, "create_target_timer"),
    ]), actor);

    expect(adapter.getState().summary).toMatchObject({
      component_count: 2,
      omitted_component_count: 1,
      components: [{ id: firstId }],
    });
    const inspection = await adapter.inspectComponent(targetId!, actor);
    expect(inspection).toMatchObject({
      workspaceId: "workspace_main",
      revision: 1,
      registryDigest: store.getRegistryDigest(),
      component: {
        id: targetId,
        type: { typeId: "timer", version: "1.2.0" },
        props: { durationMs: 10_000, label: "Focus" },
        placement: { size: { width: 210, height: 112 } },
        locks: { placement: false, resize: false },
      },
      pinnedManifest: {
        typeId: "timer",
        version: "1.2.0",
        resizePolicy: { viewport: { kind: "box2d", mode: "free" } },
      },
      currentGeometry: { kind: "box2d", size: { width: 210, height: 112 } },
      activeResizePolicy: { kind: "box2d", mode: "free" },
      redactedFields: [],
    });
    await expect(adapter.inspectComponent(targetId!, principal([]))).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(adapter.inspectComponent("CMP_UNKNOWN", actor)).rejects.toMatchObject({
      code: "component_not_found",
      options: { requiredAction: "inspect_workspace" },
    });
  });

  it("returns exact control metadata when an omitted document state exceeds the inspection budget", async () => {
    const seed = new WorkspaceStore();
    const initialState = seed.getState() as WorkspaceState;
    const timerManifest = seed.getComponentManifest("timer")!;
    const documentManifest = seed.getComponentManifest("document")!;
    initialState.components.set("CMP_000001", {
      id: "CMP_000001",
      type: {
        typeId: timerManifest.typeId,
        version: timerManifest.version,
        digest: timerManifest.digest,
      },
      label: "Summary sentinel",
      props: structuredClone(timerManifest.defaultProps),
      durableState: structuredClone(timerManifest.defaultDurableState),
      placement: { space: "viewport", anchor: "top_left", offset: { x: 16, y: 16 } },
      bindings: [],
      tags: [],
      visibility: "visible",
      locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
      provenance: { createdRevision: 0, createdBy: "user" },
    });
    const largeContent = "D".repeat(2_000_000);
    initialState.components.set("CMP_999999", {
      id: "CMP_999999",
      type: {
        typeId: documentManifest.typeId,
        version: documentManifest.version,
        digest: documentManifest.digest,
      },
      label: "Large research document",
      props: { ...structuredClone(documentManifest.defaultProps), content: largeContent },
      durableState: structuredClone(documentManifest.defaultDurableState),
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 640, height: 720 },
      },
      bindings: [],
      tags: ["large-document"],
      visibility: "visible",
      locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
      provenance: { createdRevision: 0, createdBy: "user" },
    });
    const store = new WorkspaceStore({ initialState });
    const adapter = adapterFor(store, { maxSummaryComponents: 1 });
    const actor = principal(["workspace:read"]);

    expect(adapter.getState().summary).toMatchObject({
      component_count: 2,
      omitted_component_count: 1,
      components: [{ id: "CMP_000001" }],
    });
    const inspection = await adapter.inspectComponent("CMP_999999", actor);
    expect(inspection).toMatchObject({
      workspaceId: "workspace_main",
      revision: 0,
      registryDigest: store.getRegistryDigest(),
      component: {
        id: "CMP_999999",
        type: {
          typeId: "document",
          version: documentManifest.version,
          digest: documentManifest.digest,
        },
        placement: { size: { width: 640, height: 720 } },
        locks: { placement: false, resize: false, props: false },
      },
      pinnedManifest: {
        typeId: "document",
        version: documentManifest.version,
        digest: documentManifest.digest,
        resizePolicy: { viewport: { kind: "box2d", mode: "free" } },
        actions: documentManifest.actions,
      },
      currentGeometry: { kind: "box2d", size: { width: 640, height: 720 } },
      activeResizePolicy: { kind: "box2d", mode: "free" },
      stateTruncated: true,
      manifestTruncated: false,
    });
    expect(inspection.omittedStateBytes).toBeGreaterThan(1_900_000);
    const publicContent = (inspection.component as {
      props: { content: string };
    }).props.content;
    expect(publicContent).toHaveLength(2_001);
    expect(publicContent.endsWith("…")).toBe(true);
    expect(textBytes(inspection)).toBeLessThanOrEqual(1_048_576);
  });

  it("bounds oversized binding metadata without dropping the exact control contract", async () => {
    const seed = new WorkspaceStore();
    const initialState = seed.getState() as WorkspaceState;
    const timerManifest = seed.getComponentManifest("timer")!;
    const bindingIds = Array.from({ length: 240 }, (_, index) =>
      `BIND_${String(index).padStart(4, "0")}_${"x".repeat(180)}`);
    initialState.resources.set("RES_fixture", {
      id: "RES_fixture",
      label: "Fixture",
      connectorType: "fixture",
      connectorVersion: "1",
      outputSchema: { type: "number" },
      config: {},
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: {
        data: 10_000,
        contentHash: "sha256:fixture",
        retrievedAt: "2026-08-14T00:00:00.000Z",
        stale: false,
        provenance: [],
      },
      status: "ready",
    });
    initialState.components.set("CMP_BINDINGS", {
      id: "CMP_BINDINGS",
      type: {
        typeId: timerManifest.typeId,
        version: timerManifest.version,
        digest: timerManifest.digest,
      },
      label: "Bound timer",
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
        resourceId: "RES_fixture",
        componentId: "CMP_BINDINGS",
        targetProp: "durationMs",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      });
    }
    const store = new WorkspaceStore({ initialState });
    const maxBytes = 16_000;
    const adapter = adapterFor(store, { maxComponentInspectionBytes: maxBytes });
    const inspection = await adapter.inspectComponent("CMP_BINDINGS", principal(["workspace:read"]));

    expect(textBytes(inspection)).toBeLessThanOrEqual(maxBytes);
    expect(inspection).toMatchObject({
      componentMetadataTruncated: true,
      omittedBindingCount: expect.any(Number),
      pinnedManifest: {
        typeId: "timer",
        version: timerManifest.version,
        digest: timerManifest.digest,
        propsSchema: timerManifest.propsSchema,
        durableStateSchema: timerManifest.durableStateSchema,
      },
      currentGeometry: { kind: "box2d", size: { width: 210, height: 112 } },
      activeResizePolicy: { kind: "box2d", mode: "free" },
    });
    expect(inspection.omittedBindingCount).toBeGreaterThan(0);
    expect((inspection.component as { bindings: string[] }).bindings.length
      + inspection.omittedBindingCount).toBe(bindingIds.length);
    expect(inspection.manifestTruncated).toBe(false);
  });

  it("redacts credential-like component fields from targeted inspection", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal([
      "workspace:read",
      "workspace:write",
      "component:create",
      "component:recipe_define",
    ]);
    const recipe = prepareComponentRecipe({
      typeId: "recipe.private-control",
      version: "1.0.0",
      displayName: "Private control",
      allowedPlacements: ["viewport"],
      propsSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "api_key", "authEnvelope"],
        properties: {
          title: { type: "string" },
          api_key: { type: "string" },
          authEnvelope: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      durableStateSchema: {
        type: "object",
        additionalProperties: false,
        required: ["token", "session"],
        properties: {
          token: { type: "string" },
          session: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      defaultProps: {
        title: "Control",
        api_key: "PROP_SECRET_SENTINEL",
        authEnvelope: {
          accessToken: "ACCESS_TOKEN_SENTINEL",
          tokenCount: 3,
          nested: [{
            clientSecret: "CLIENT_SECRET_SENTINEL",
            secretRef: "SECRET_REF_SENTINEL",
          }],
        },
      },
      defaultDurableState: {
        token: "STATE_SECRET_SENTINEL",
        session: {
          refreshToken: "REFRESH_TOKEN_SENTINEL",
          credentialRef: "CREDENTIAL_REF_SENTINEL",
          privateKey: "PRIVATE_KEY_SENTINEL",
          tokenCount: 7,
        },
      },
      writableProps: ["title"],
      actions: {},
      events: {},
      root: { id: "root", primitive: "text", props: { text: "{{props.title}}" } },
    });
    const creation = await adapter.prepare("Define and create a private control", 1, actor);
    const componentId = creation.reserved_component_ids[0]!;
    await adapter.submit(creation, batchFor(creation, [{
      op: "define_component_recipe",
      op_id: "define_private_control",
      recipe,
    }, {
      op: "create_component",
      op_id: "create_private_control",
      id: componentId,
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]), actor);

    const inspection = await adapter.inspectComponent(componentId, actor);
    expect(inspection.pinnedManifest).toMatchObject({
      defaultProps: {
        title: "Control",
        api_key: "[redacted]",
        authEnvelope: {
          accessToken: "[redacted]",
          tokenCount: 3,
          nested: [{ clientSecret: "[redacted]", secretRef: "[redacted]" }],
        },
      },
      defaultDurableState: {
        token: "[redacted]",
        session: {
          refreshToken: "[redacted]",
          credentialRef: "[redacted]",
          privateKey: "[redacted]",
          tokenCount: 7,
        },
      },
      defaultsRedacted: true,
      redactedDefaultFields: expect.arrayContaining([
        "defaultProps.api_key",
        "defaultProps.authEnvelope.accessToken",
        "defaultProps.authEnvelope.nested[0].clientSecret",
        "defaultDurableState.token",
        "defaultDurableState.session.refreshToken",
      ]),
    });
    expect(inspection.component).toMatchObject({
      props: {
        title: "Control",
        api_key: "[redacted]",
        authEnvelope: {
          accessToken: "[redacted]",
          tokenCount: 3,
          nested: [{ clientSecret: "[redacted]", secretRef: "[redacted]" }],
        },
      },
      durable_state: {
        token: "[redacted]",
        session: {
          refreshToken: "[redacted]",
          credentialRef: "[redacted]",
          privateKey: "[redacted]",
          tokenCount: 7,
        },
      },
    });
    expect(inspection.redactedFields).toEqual(expect.arrayContaining([
      "component.props.api_key",
      "component.props.authEnvelope.accessToken",
      "component.props.authEnvelope.nested[0].clientSecret",
      "component.props.authEnvelope.nested[0].secretRef",
      "component.durable_state.token",
      "component.durable_state.session.refreshToken",
      "component.durable_state.session.credentialRef",
      "component.durable_state.session.privateKey",
    ]));
    expect(inspection.redactedFields).not.toContain("component.props.authEnvelope.tokenCount");
    expect(inspection.redactedFields).not.toContain("component.durable_state.session.tokenCount");
    const serialized = JSON.stringify(inspection);
    const secretSentinels = [
      "PROP_SECRET_SENTINEL",
      "ACCESS_TOKEN_SENTINEL",
      "CLIENT_SECRET_SENTINEL",
      "SECRET_REF_SENTINEL",
      "STATE_SECRET_SENTINEL",
      "REFRESH_TOKEN_SENTINEL",
      "CREDENTIAL_REF_SENTINEL",
      "PRIVATE_KEY_SENTINEL",
    ];
    for (const sentinel of secretSentinels) {
      expect(serialized).not.toContain(sentinel);
    }

    const currentSummary = adapter.getState().summary;
    const prepared = await adapter.prepare("Read the redacted component summary", 1, actor);
    for (const capability of [adapter.getState().capabilityManifest, prepared.capability_manifest]) {
      expect(capability).toMatchObject({
        component_types: expect.arrayContaining([expect.objectContaining({
          typeId: "recipe.private-control",
          defaultProps: expect.objectContaining({ api_key: "[redacted]" }),
          defaultDurableState: expect.objectContaining({ token: "[redacted]" }),
          defaultsRedacted: true,
          redactedDefaultFields: expect.arrayContaining([
            "defaultProps.api_key",
            "defaultDurableState.token",
          ]),
        })]),
      });
      for (const sentinel of secretSentinels) expect(JSON.stringify(capability)).not.toContain(sentinel);
    }
    for (const summary of [currentSummary, prepared.workspace_summary]) {
      const summaryJson = JSON.stringify(summary);
      for (const sentinel of secretSentinels) expect(summaryJson).not.toContain(sentinel);
      expect(summary).toMatchObject({
        components: [expect.objectContaining({
          id: componentId,
          props: {
            title: "Control",
            api_key: "[redacted]",
            authEnvelope: expect.objectContaining({
              accessToken: "[redacted]",
              tokenCount: 3,
            }),
          },
          durable_state: {
            token: "[redacted]",
            session: expect.objectContaining({
              refreshToken: "[redacted]",
              tokenCount: 7,
            }),
          },
          redacted_fields: expect.arrayContaining([
            "component.props.authEnvelope.accessToken",
            "component.durable_state.session.refreshToken",
          ]),
        })],
      });
    }
  });

  it("normalizes stage dimensions and spatial scale in the agent summary", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:read", "workspace:write", "component:create", "component:update"]);
    const creation = await adapter.prepare("Create a stage and spatial object", 2, actor);
    const [stageId, entityId] = creation.reserved_component_ids;
    const stageManifest = store.getComponentManifest("stage-3d")!;
    const entityManifest = store.getComponentManifest("spatial-entity")!;
    await adapter.submit(creation, batchFor(creation, [{
      op: "create_component",
      op_id: "create_stage",
      id: stageId!,
      component_type: {
        typeId: stageManifest.typeId,
        version: stageManifest.version,
        digest: stageManifest.digest,
      },
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }, {
      op: "create_component",
      op_id: "create_entity",
      id: entityId!,
      component_type: {
        typeId: entityManifest.typeId,
        version: entityManifest.version,
        digest: entityManifest.digest,
      },
      placement: {
        space: "world3d",
        position: { x: 1, y: 0, z: 2 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]), actor);

    expect((adapter.getState().summary as { components: unknown[] }).components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: stageId,
          current_geometry: {
            kind: "stage_dimensions",
            dimensions: { width: 12, height: 4, depth: 10 },
          },
        }),
        expect.objectContaining({
          id: entityId,
          current_geometry: { kind: "scale3d", scale: { x: 1, y: 1, z: 1 } },
        }),
      ]),
    );

    const resizing = await adapter.prepare("Resize the stage and spatial object", 1, actor);
    await adapter.submit(resizing, batchFor(resizing, [{
      op: "resize_component",
      op_id: "resize_stage",
      id: stageId!,
      resize: { kind: "stage_dimensions", dimensions: { width: 20, height: 6, depth: 16 } },
    }, {
      op: "resize_component",
      op_id: "scale_entity",
      id: entityId!,
      resize: { kind: "scale3d", scale: { x: 2, y: 1.5, z: 0.5 } },
    }]), actor);

    expect((adapter.getState().summary as { components: unknown[] }).components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: stageId,
          current_geometry: {
            kind: "stage_dimensions",
            dimensions: { width: 20, height: 6, depth: 16 },
          },
        }),
        expect.objectContaining({
          id: entityId,
          current_geometry: { kind: "scale3d", scale: { x: 2, y: 1.5, z: 0.5 } },
        }),
      ]),
    );
  });

  it("rejects unreserved component IDs and cross-session preparations before store mutation", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:write", "component:create"]);
    const prepared = await adapter.prepare("Create a timer", 1, actor);

    await expect(adapter.submit(
      prepared,
      batchFor(prepared, [timerCreate(store, "CMP_999999")]),
      actor,
    )).rejects.toMatchObject({ code: "command_validation_failed" });
    expect(store.getRevision()).toBe(0);

    await expect(adapter.submit(
      prepared,
      batchFor(prepared, [timerCreate(store, prepared.reserved_component_ids[0]!)]),
      principal(["workspace:write", "component:create"], "session_b", "client_b"),
    )).rejects.toMatchObject({ code: "transaction_session_mismatch" });
    expect(store.getRevision()).toBe(0);
  });

  it("maps delete_resource and bind_resource through exact core permission scopes", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:write"]);

    const deletePreparation = await adapter.prepare("Delete a resource", 1, actor);
    await expect(adapter.submit(deletePreparation, batchFor(deletePreparation, [{
      op: "delete_resource",
      op_id: "delete_feed",
      resource_id: "resource_feed",
    }]), actor)).rejects.toMatchObject({
      code: "permission_denied",
      options: { details: { missing_permissions: ["connector:delete"] } },
    });

    const bindPreparation = await adapter.prepare("Bind a resource", 1, actor);
    await expect(adapter.submit(bindPreparation, batchFor(bindPreparation, [{
      op: "bind_resource",
      op_id: "bind_feed",
      binding: {
        kind: "resource_binding",
        id: "binding_feed",
        resourceId: "resource_feed",
        componentId: "CMP_000001",
        targetProp: "text",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      },
    }]), actor)).rejects.toMatchObject({
      code: "permission_denied",
      options: { details: { missing_permissions: ["connector:bind"] } },
    });
    expect(store.getRevision()).toBe(0);
  });

  it("serializes simultaneous submissions FIFO so only the first stale-base contender commits", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:write", "component:create"]);
    const first = await adapter.prepare("Create first timer", 1, actor);
    const second = await adapter.prepare("Create second timer", 1, actor);

    const outcomes = await Promise.allSettled([
      adapter.submit(first, batchFor(first, [timerCreate(store, first.reserved_component_ids[0]!, "create_first")]), actor),
      adapter.submit(second, batchFor(second, [timerCreate(store, second.reserved_component_ids[0]!, "create_second")]), actor),
    ]);
    expect(outcomes[0]).toMatchObject({ status: "fulfilled" });
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: { code: "stale_workspace_revision" },
    });
    expect(store.getRevision()).toBe(1);
    expect([...store.getState().components.keys()]).toEqual([first.reserved_component_ids[0]]);
  });

  it("exposes ordered events and keeps undo/redo in the same serialized history lane", async () => {
    const store = new WorkspaceStore({ clock: () => 50_000 });
    const adapter = adapterFor(store);
    const actor = principal([
      "workspace:read",
      "workspace:write",
      "workspace:history",
      "component:create",
      "component:invoke",
    ]);
    const createPreparation = await adapter.prepare("Create timer", 1, actor);
    const timerId = createPreparation.reserved_component_ids[0]!;
    await adapter.submit(
      createPreparation,
      batchFor(createPreparation, [timerCreate(store, timerId)]),
      actor,
    );
    const actionPreparation = await adapter.prepare("Start timer", 1, actor);
    await adapter.submit(actionPreparation, batchFor(actionPreparation, [{
      op: "invoke_component_action",
      op_id: "start_timer",
      id: timerId,
      action: "start",
      input: {},
    }]), actor);

    await expect(adapter.readEvents(undefined, 1)).resolves.toMatchObject({
      events: [{
        cursor: "1",
        type: "started",
        source: "agent",
        workspaceRevision: 2,
        componentId: timerId,
        occurredAt: "1970-01-01T00:00:50.000Z",
      }],
      nextCursor: "1",
      hasMore: false,
    });
    await expect(adapter.readEvents("not-a-cursor", 1)).rejects.toMatchObject({ code: "invalid_event_cursor" });
    await expect(adapter.readEvents(undefined, 201)).rejects.toMatchObject({ code: "invalid_request" });

    await expect(adapter.undo(2, actor)).resolves.toMatchObject({
      action: "undo",
      changed: true,
      workspaceRevision: 1,
    });
    expect((await adapter.readEvents(undefined, 10)).events).toHaveLength(0);
    await expect(adapter.redo(1, actor)).resolves.toMatchObject({
      action: "redo",
      changed: true,
      workspaceRevision: 2,
    });
    expect((await adapter.readEvents(undefined, 10)).events).toHaveLength(1);
  });

  it("never exposes connector config or secretRef in public summaries", async () => {
    const store = new WorkspaceStore();
    const initial = store.getState();
    // Legacy connector records remain loadable/user-owned, but are not an
    // executable or newly Agent-writable capability.
    store.apply({
      protocol_version: "1.2",
      request_id: "seed_legacy_connector",
      workspace_id: initial.workspaceId,
      input_revision: 1,
      base_workspace_revision: 0,
      registry_digest: initial.registryDigest,
      mode: "commit",
      operations: [{
      op: "upsert_resource",
      op_id: "upsert_feed",
      resource: {
        id: "resource_feed",
        label: "Public feed",
        connectorType: "http-json",
        connectorVersion: "1.0.0",
        outputSchema: { type: "object" },
        config: {
          endpoint: "https://private-config.invalid/feed",
          marker: "CONFIG_SENTINEL_DO_NOT_EXPOSE",
        },
        secretRef: "vault.resource_feed",
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data: {},
          contentHash: "legacy-caller-hash",
          retrievedAt: "2026-08-15T01:02:03.000Z",
          stale: false,
          provenance: [{
            uri: "https://PROVENANCE_SENTINEL_DO_NOT_EXPOSE.invalid",
            citation: "PROVENANCE_SENTINEL_DO_NOT_EXPOSE",
            publisher: "PROVENANCE_SENTINEL_DO_NOT_EXPOSE",
            retrievedAt: "2026-08-15T01:02:03.000Z",
          }],
        },
        status: "error",
        lastError: "LAST_ERROR_SENTINEL_DO_NOT_EXPOSE",
      },
    }],
    });
    const adapter = adapterFor(store);

    const serialized = JSON.stringify(adapter.getState().summary);
    expect(serialized).not.toContain("private-config.invalid");
    expect(serialized).not.toContain("CONFIG_SENTINEL_DO_NOT_EXPOSE");
    expect(serialized).not.toContain("vault.resource_feed");
    expect(serialized).not.toContain("PROVENANCE_SENTINEL_DO_NOT_EXPOSE");
    expect(serialized).not.toContain("LAST_ERROR_SENTINEL_DO_NOT_EXPOSE");
    expect(serialized).toContain("[redacted connector error]");
    expect(serialized).toContain('"redacted":true');
    expect(serialized).toContain("resource_feed");
  });

  it("maps embedded connector credentials to a correctable validation error", async () => {
    const store = new WorkspaceStore();
    const adapter = adapterFor(store);
    const actor = principal(["workspace:write", "connector:write"]);
    const prepared = await adapter.prepare("Connect a feed", 1, actor);
    await expect(adapter.submit(prepared, batchFor(prepared, [{
      op: "upsert_resource",
      op_id: "upsert_unsafe_feed",
      resource: {
        id: "resource_feed",
        label: "Unsafe feed",
        connectorType: "http-json",
        connectorVersion: "1.0.0",
        outputSchema: { type: "object" },
        config: { api_key: "raw-secret" },
        policy: { mode: "manual", offline: "keep_last_good" },
        status: "ready",
      },
    }]), actor)).rejects.toMatchObject({
      code: "command_validation_failed",
      options: { details: { validation_code: "embedded_secret" } },
    });
    expect(store.getRevision()).toBe(0);
  });

  it("preserves migration provenance on the external event wire contract", async () => {
    const seed = new WorkspaceStore();
    const digest = seed.getRegistryDigest();
    const store = new WorkspaceStore({
      commandHistory: [{
        requestId: "migration_seed",
        actor: "migration",
        inputRevision: 1,
        baseWorkspaceRevision: 0,
        inputRegistryDigest: digest,
        resultingRegistryDigest: digest,
        resolvedOperations: [],
        resolvedEvents: [{
          id: "migration_event",
          cursor: 1,
          workspaceRevision: 0,
          event: "workspace.migrated",
          payload: { schema: "1.0" },
          source: "migration",
          effectiveTimeMs: 1_000,
        }],
        resultingWorkspaceRevision: 0,
      }],
    });
    const events = await adapterFor(store).readEvents(undefined, 10);
    expect(events.events).toEqual([expect.objectContaining({
      id: "migration_event",
      cursor: "1",
      type: "workspace.migrated",
      source: "migration",
    })]);
  });

  it("fails closed when configured byte ceilings cannot hold even the public header", () => {
    const adapter = adapterFor(new WorkspaceStore(), { maxCapabilityBytes: 1, maxSummaryBytes: 1 });
    expect(() => adapter.getState()).toThrow(WorkspaceEngineError);
    expect(() => adapterFor(new WorkspaceStore(), { maxModelInspectionBytes: 2_048 }))
      .toThrow(/model.*wrapper reserve/i);
  });
});
