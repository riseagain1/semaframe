// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { JSONObject } from "../../../workspace/components/componentTypes";
import {
  applyCadDocumentEdits,
  cadLengthExpression,
  cadPartDefinitionDigest,
  parseCadEvaluationEvidence,
  parseCadPartDefinition,
  type CadFeature,
  type CadPartDefinitionV1,
} from "../../../workspace/modeling/cad";
import { loadCadKernel } from "../../../workspace/modeling/cadKernel";
import {
  verifyWorkspaceProjectCadEvidence,
  WorkspaceProjectSerializer,
} from "../../../workspace/persistence";
import type { WorkspaceCommandBatch, WorkspaceOperation } from "../../../workspace/protocol/workspaceTypes";
import { WorkspaceStore } from "../../../workspace/state/WorkspaceStore";
import {
  WorkspaceStoreEngineAdapter,
} from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import type {
  WorkspaceAgentPrincipal,
  WorkspacePreparedUpdate,
} from "../../../workspace/agents/contracts";

function actor(): WorkspaceAgentPrincipal {
  return {
    sessionId: "cad_session",
    clientId: "cad_agent",
    clientName: "CAD test agent",
    scopes: [
      "workspace:read",
      "workspace:write",
      "workspace:history",
      "component:create",
      "component:update",
    ],
  };
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

function plateDefinition(distanceM: number): CadPartDefinitionV1 {
  const sketch: Extract<CadFeature, { kind: "sketch" }> = {
    id: "plate_profile",
    name: "Plate profile",
    kind: "sketch",
    sketch: {
      plane: {
        originM: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
      entities: [
        { id: "bottom", kind: "line", start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
        { id: "right", kind: "line", start: { x: 2, y: 0 }, end: { x: 2, y: 1 } },
        { id: "top", kind: "line", start: { x: 2, y: 1 }, end: { x: 0, y: 1 } },
        { id: "left", kind: "line", start: { x: 0, y: 1 }, end: { x: 0, y: 0 } },
      ],
      loops: [{ id: "outer", role: "outer", entityIds: ["bottom", "right", "top", "left"] }],
      constraints: [],
    },
  };
  return {
    formatVersion: "1.0",
    partId: "agent_plate",
    displayName: "Agent plate",
    units: "metre",
    parameters: [],
    history: [sketch, {
      id: "plate_extrude",
      name: "Plate extrude",
      kind: "extrude",
      profile: { sketchFeatureId: "plate_profile", loopIds: ["outer"] },
      distance: cadLengthExpression(distanceM),
      operation: "new",
      resultBodyId: "plate",
    }],
    activeBodyIds: ["plate"],
  };
}

function unsupportedShellDefinition(): CadPartDefinitionV1 {
  const base = plateDefinition(0.5);
  return {
    ...base,
    history: [...base.history, {
      id: "unsupported_shell",
      name: "Unsupported shell",
      kind: "shell",
      targetBodyId: "plate",
      resultBodyId: "hollow_plate",
      thickness: cadLengthExpression(0.05),
      removedFaces: [{
        bodyId: "plate",
        producerFeatureId: "plate_extrude",
        elementType: "face",
        role: "top_face",
      }],
    }],
    activeBodyIds: ["hollow_plate"],
  };
}

function offsetHoleDefinition(): CadPartDefinitionV1 {
  const base = plateDefinition(0.5);
  return {
    ...base,
    partId: "offset_hole_plate",
    displayName: "Offset-hole plate",
    history: [...base.history, {
      id: "offset_hole",
      name: "Offset hole",
      kind: "hole",
      targetBodyId: "plate",
      resultBodyId: "offset_hole_plate",
      centerM: { x: 0.25, y: 0.5, z: 0.25 },
      axis: { x: 0, y: 0, z: 1 },
      diameter: cadLengthExpression(0.2),
      throughAll: true,
    }],
    activeBodyIds: ["offset_hole_plate"],
  };
}

function forgedProps(definition: CadPartDefinitionV1): JSONObject {
  return {
    definition: structuredClone(definition) as unknown as JSONObject,
    definitionDigest: "fnv1a32:00000000",
    evaluation: { marker: "agent-forged-evidence" },
  };
}

describe("Agent-authored CAD parts", () => {
  it("uses the evaluated CAD solid center of mass in rotated world-space physics", async () => {
    const store = new WorkspaceStore();
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: (revision) => `cad_com_request_${revision}`,
      cadKernelFactory: loadCadKernel,
    });
    const principal = actor();
    const definition = offsetHoleDefinition();
    const cadManifest = store.getComponentManifest("cad-part")!;
    const stageManifest = store.getComponentManifest("stage-3d")!;
    const prepared = await adapter.prepare("Create an asymmetric CAD part", 2, principal);
    const [stageId, componentId] = prepared.reserved_component_ids;
    await adapter.submit(prepared, batchFor(prepared, [{
      op: "create_component",
      op_id: "create_com_stage",
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
      op_id: "create_asymmetric_cad",
      id: componentId!,
      component_type: {
        typeId: cadManifest.typeId,
        version: cadManifest.version,
        digest: cadManifest.digest,
      },
      props: forgedProps(definition),
      placement: {
        space: "world3d",
        position: { x: 4, y: 0, z: 2 },
        rotation: { x: 0, y: Math.PI / 2, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]), principal);

    const component = store.getState().components.get(componentId!)!;
    const evidence = parseCadEvaluationEvidence(component.props.evaluation, definition);
    const localCenter = evidence.bodies[0]!.centerOfMassM;
    expect(localCenter.x).toBeGreaterThan(1);
    const view = await adapter.inspectPhysics([componentId!], principal);
    const report = view.physicsValidation as unknown as {
      bodies: Array<{ component_id: string; center_of_mass_world: { x: number; y: number; z: number } }>;
    };
    const body = report.bodies.find((candidate) => candidate.component_id === componentId)!;
    expect(body.center_of_mass_world.x).toBeCloseTo(4 + localCenter.z, 7);
    expect(body.center_of_mass_world.y).toBeCloseTo(localCenter.y, 7);
    expect(body.center_of_mass_world.z).toBeCloseTo(2 - localCenter.x, 7);
    // The rotated AABB centre is z=1; exact CAD mass evidence shifts it.
    expect(body.center_of_mass_world.z).toBeLessThan(1);
  }, 30_000);

  it("host-evaluates atomically, overwrites forged evidence, and preserves editable CAD through undo/reopen", async () => {
    const store = new WorkspaceStore();
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: (revision) => `cad_request_${revision}`,
      cadKernelFactory: loadCadKernel,
    });
    const principal = actor();
    const initialDefinition = plateDefinition(0.5);
    const manifest = store.getComponentManifest("cad-part")!;
    const stageManifest = store.getComponentManifest("stage-3d")!;
    const create = await adapter.prepare("Create a stage and editable CAD plate", 2, principal);
    const [stageId, componentId] = create.reserved_component_ids;
    const receipt = await adapter.submit(create, batchFor(create, [{
      op: "create_component",
      op_id: "create_cad_stage",
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
      op_id: "create_cad_plate",
      id: componentId!,
      component_type: {
        typeId: manifest.typeId,
        version: manifest.version,
        digest: manifest.digest,
      },
      props: forgedProps(initialDefinition),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]), principal);

    expect(receipt).toMatchObject({
      baseWorkspaceRevision: 0,
      resultingWorkspaceRevision: 1,
      status: "committed",
    });
    expect(store.getCommandHistory()).toHaveLength(1);
    const created = store.getState().components.get(componentId!)!;
    const createdDefinition = parseCadPartDefinition(created.props.definition);
    const createdEvidence = parseCadEvaluationEvidence(created.props.evaluation, createdDefinition);
    expect(created.props.definitionDigest).toBe(cadPartDefinitionDigest(initialDefinition));
    expect(created.props.evaluation).not.toHaveProperty("marker");
    expect(createdEvidence.bodies[0]!.volumeM3).toBeCloseTo(1, 7);
    expect(JSON.stringify(receipt.resolvedBatch)).not.toContain("agent-forged-evidence");

    const spatialView = await adapter.inspectSpace(undefined, principal);
    const spatialGraph = spatialView.spatialGraph as unknown as {
      version: string;
      nodes: Array<{
        id: string;
        node_kind: string;
        cad?: Record<string, unknown>;
        collision?: Record<string, unknown>;
        physics?: Record<string, unknown>;
      }>;
    };
    const cadNode = spatialGraph.nodes.find((node) => node.id === componentId);
    expect(spatialGraph.version).toBe("3.2");
    expect(cadNode).toMatchObject({
      node_kind: "cad",
      cad: {
        definition_digest: cadPartDefinitionDigest(initialDefinition),
        exactness: "brep",
        body_count: 1,
        volume_m3: expect.closeTo(1, 7),
        center_of_mass_m: { x: 1, y: 0.5, z: 0.25 },
      },
      collision: { source: "cad_bounds" },
      physics: { geometry_volume_m3: expect.closeTo(1, 7) },
    });

    const tallerDefinition = plateDefinition(1);
    const update = await adapter.prepare("Make the CAD plate one metre tall", 1, principal);
    await adapter.submit(update, batchFor(update, [{
      op: "update_component",
      op_id: "edit_cad_plate",
      id: componentId!,
      patch: { props: forgedProps(tallerDefinition) },
    }]), principal);
    const updated = store.getState().components.get(componentId!)!;
    const updatedDefinition = parseCadPartDefinition(updated.props.definition);
    const updatedEvidence = parseCadEvaluationEvidence(updated.props.evaluation, updatedDefinition);
    expect(updatedEvidence.bodies[0]!.volumeM3).toBeCloseTo(2, 7);
    expect(store.getRevision()).toBe(2);

    await expect(adapter.undo(2, principal)).resolves.toMatchObject({
      action: "undo",
      changed: true,
      workspaceRevision: 1,
    });
    const reverted = store.getState().components.get(componentId!)!;
    const revertedDefinition = parseCadPartDefinition(reverted.props.definition);
    const revertedEvidence = parseCadEvaluationEvidence(reverted.props.evaluation, revertedDefinition);
    expect(revertedDefinition).toEqual(initialDefinition);
    expect(revertedEvidence).toEqual(createdEvidence);

    const serializer = new WorkspaceProjectSerializer();
    const savedProject = serializer.deserialize(serializer.serialize(
      serializer.fromStore("cad_part_round_trip", store),
    ));
    await verifyWorkspaceProjectCadEvidence(savedProject, { cadKernelFactory: loadCadKernel });
    const reopened = serializer.openStore(savedProject);
    const reopenedComponent = reopened.getState().components.get(componentId!)!;
    const reopenedDefinition = parseCadPartDefinition(reopenedComponent.props.definition);
    expect(reopenedDefinition).toEqual(initialDefinition);
    expect(parseCadEvaluationEvidence(reopenedComponent.props.evaluation, reopenedDefinition)).toEqual(createdEvidence);
    expect(applyCadDocumentEdits(reopenedDefinition, [{
      kind: "rename_part",
      displayName: "Human edited plate",
    }])).toMatchObject({
      displayName: "Human edited plate",
      history: initialDefinition.history,
    });
  }, 30_000);

  it("rejects invalid OCCT evaluation without committing any revision or state", async () => {
    const store = new WorkspaceStore();
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: (revision) => `bad_cad_request_${revision}`,
      cadKernelFactory: loadCadKernel,
    });
    const principal = actor();
    const manifest = store.getComponentManifest("cad-part")!;
    const stageManifest = store.getComponentManifest("stage-3d")!;
    const prepared = await adapter.prepare("Create a stage with an unsupported shell", 2, principal);
    const beforeState = store.getState();
    const beforeHistory = store.getCommandHistory();
    const beforeRevision = store.getRevision();

    const operation = adapter.submit(prepared, batchFor(prepared, [{
      op: "create_component",
      op_id: "create_stage_before_invalid_cad",
      id: prepared.reserved_component_ids[0]!,
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
      op_id: "create_invalid_cad_part",
      id: prepared.reserved_component_ids[1]!,
      component_type: {
        typeId: manifest.typeId,
        version: manifest.version,
        digest: manifest.digest,
      },
      props: forgedProps(unsupportedShellDefinition()),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]), principal);
    await expect(operation).rejects.toMatchObject({
      code: "cad_evaluation_failed",
      options: expect.objectContaining({
        retryable: true,
        requiredAction: "begin_workspace_update",
        details: expect.objectContaining({
          kernel_code: "cad_part_evaluation_failed",
          operation: "evaluate_part",
        }),
      }),
    });
    expect(store.getRevision()).toBe(beforeRevision);
    expect(store.getState()).toEqual(beforeState);
    expect(store.getCommandHistory()).toEqual(beforeHistory);
  }, 30_000);

  it("fails closed instead of running untrusted Agent CAD synchronously when no disposable Worker is available", async () => {
    const store = new WorkspaceStore();
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: (revision) => `no_worker_cad_request_${revision}`,
    });
    const principal = actor();
    const prepared = await adapter.prepare("Create CAD without a hard-stop runtime", 1, principal);
    const manifest = store.getComponentManifest("cad-part")!;
    await expect(adapter.submit(prepared, batchFor(prepared, [{
      op: "create_component",
      op_id: "create_without_worker",
      id: prepared.reserved_component_ids[0]!,
      component_type: {
        typeId: manifest.typeId,
        version: manifest.version,
        digest: manifest.digest,
      },
      props: forgedProps(plateDefinition(0.5)),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]), principal)).rejects.toMatchObject({
      code: "cad_evaluation_unavailable",
      options: {
        retryable: false,
        details: { hard_stop_required: true, in_process_fallback_used: false },
      },
    });
    expect(store.getRevision()).toBe(0);
    expect(store.getState().components.size).toBe(0);
    expect(store.getCommandHistory()).toHaveLength(0);
  });

  it("rejects an oversized CAD evaluation batch before any partial commit", async () => {
    const store = new WorkspaceStore();
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: (revision) => `bounded_cad_request_${revision}`,
      cadKernelFactory: loadCadKernel,
    });
    const principal = actor();
    const stageManifest = store.getComponentManifest("stage-3d")!;
    const cadManifest = store.getComponentManifest("cad-part")!;
    const stage = await adapter.prepare("Create the CAD stage", 1, principal);
    await adapter.submit(stage, batchFor(stage, [{
      op: "create_component",
      op_id: "create_bounded_cad_stage",
      id: stage.reserved_component_ids[0]!,
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
    }]), principal);

    const beforeState = store.getState();
    const beforeHistory = store.getCommandHistory();
    const prepared = await adapter.prepare("Create too many CAD parts at once", 9, principal);
    const operations: WorkspaceOperation[] = prepared.reserved_component_ids.map((id, index) => ({
      op: "create_component",
      op_id: `create_bounded_cad_${index}`,
      id,
      component_type: {
        typeId: cadManifest.typeId,
        version: cadManifest.version,
        digest: cadManifest.digest,
      },
      placement: {
        space: "world3d",
        position: { x: index, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }));
    await expect(adapter.submit(prepared, batchFor(prepared, operations), principal)).rejects.toMatchObject({
      code: "cad_evaluation_failed",
      options: expect.objectContaining({
        retryable: true,
        details: {
          evaluation_count: 9,
          maximum_evaluations_per_batch: 8,
        },
      }),
    });
    expect(store.getRevision()).toBe(1);
    expect(store.getState()).toEqual(beforeState);
    expect(store.getCommandHistory()).toEqual(beforeHistory);
  });
});
