// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { JSONObject } from "../../workspace/components/componentTypes";
import {
  MODEL_DEFINITION_FORMAT_VERSION,
  MODEL_DEFINITION_GENERATOR_VERSION,
  assertModelDefinition,
  modelDefinitionRef,
} from "../../workspace/modeling/modelDefinitions";
import {
  cadLengthExpression,
  cadPartDefinitionDigest,
  parseCadEvaluationEvidence,
  parseCadPartDefinition,
  type CadFeature,
  type CadPartDefinitionV1,
} from "../../workspace/modeling/cad";
import { loadCadKernel } from "../../workspace/modeling/cadKernel";
import {
  verifyWorkspaceProjectCadEvidence,
  WorkspaceProjectSerializer,
} from "../../workspace/persistence";
import {
  REALITY_WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_PROTOCOL_VERSION,
  WORKSPACE_SCHEMA_VERSION,
} from "../../workspace/protocol";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const world = (x: number, y: number, z: number) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

function boxDefinition(
  partId: string,
  displayName: string,
  widthM: number,
  depthM: number,
  heightM: number,
): CadPartDefinitionV1 {
  const sketchId = `${partId}_profile`;
  const sketch: Extract<CadFeature, { kind: "sketch" }> = {
    id: sketchId,
    name: `${displayName} profile`,
    kind: "sketch",
    sketch: {
      plane: {
        originM: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
      entities: [
        { id: "bottom", kind: "line", start: { x: 0, y: 0 }, end: { x: widthM, y: 0 } },
        { id: "right", kind: "line", start: { x: widthM, y: 0 }, end: { x: widthM, y: depthM } },
        { id: "top", kind: "line", start: { x: widthM, y: depthM }, end: { x: 0, y: depthM } },
        { id: "left", kind: "line", start: { x: 0, y: depthM }, end: { x: 0, y: 0 } },
      ],
      loops: [{ id: "outer", role: "outer", entityIds: ["bottom", "right", "top", "left"] }],
      constraints: [],
    },
  };
  return {
    formatVersion: "1.0",
    partId,
    displayName,
    units: "metre",
    parameters: [],
    history: [sketch, {
      id: `${partId}_extrude`,
      name: `${displayName} extrude`,
      kind: "extrude",
      profile: { sketchFeatureId: sketchId, loopIds: ["outer"] },
      distance: cadLengthExpression(heightM),
      operation: "new",
      resultBodyId: `${partId}_body`,
    }],
    activeBodyIds: [`${partId}_body`],
  };
}

describe("reusable CAD ModelDefinition V2", () => {
  it("publishes two exact CAD parts with a mate, remaps two editable instances, and survives undo/reopen", async () => {
    const firstDefinition = boxDefinition("base_part", "Base part", 2, 1, 0.2);
    const secondDefinition = boxDefinition("post_part", "Post part", 0.3, 0.3, 1.2);
    const kernel = await loadCadKernel();
    let firstEvidence: ReturnType<typeof parseCadEvaluationEvidence>;
    let secondEvidence: ReturnType<typeof parseCadEvaluationEvidence>;
    try {
      firstEvidence = (await kernel.evaluatePart(firstDefinition)).evidence;
      secondEvidence = (await kernel.evaluatePart(secondDefinition)).evidence;
    } finally {
      await kernel.dispose();
    }
    expect(firstEvidence.bodies[0]!.volumeM3).toBeCloseTo(0.4, 8);
    expect(secondEvidence.bodies[0]!.volumeM3).toBeCloseTo(0.108, 8);

    const store = new WorkspaceStore();
    const rootId = "CAD_ASSEMBLY";
    const firstId = "BASE_PART";
    // Regression: component and V2 logical IDs may begin with a number.
    const secondId = "2ND_PART";
    store.apply(workspaceBatch(store, "cad_model_source", [{
      op: "create_component",
      op_id: "stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: world(0, 0, 0),
    }, {
      op: "create_component",
      op_id: "assembly",
      id: rootId,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
      props: {
        description: "Reusable two-part CAD fixture",
        collisionPolicy: "external_only",
        partNumber: "ASM-200",
        materialName: "Assembly",
        mates: [],
      },
      placement: world(0, 0, 0),
    }, {
      op: "create_component",
      op_id: "base_part",
      id: firstId,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("cad-part"),
      props: {
        definition: structuredClone(firstDefinition) as unknown as JSONObject,
        definitionDigest: cadPartDefinitionDigest(firstDefinition),
        evaluation: structuredClone(firstEvidence) as unknown as JSONObject,
        partNumber: "BASE-001",
        materialName: "Aluminium 6061",
      },
      placement: world(-1.5, 0, 0),
      parent_id: rootId,
    }, {
      op: "create_component",
      op_id: "numeric_part",
      id: secondId,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("cad-part"),
      props: {
        definition: structuredClone(secondDefinition) as unknown as JSONObject,
        definitionDigest: cadPartDefinitionDigest(secondDefinition),
        evaluation: structuredClone(secondEvidence) as unknown as JSONObject,
        partNumber: "POST-002",
        materialName: "Steel 1045",
      },
      placement: world(1.5, 0, 0),
      parent_id: rootId,
    }]));

    const sourceMate = {
      id: "base_to_post",
      kind: "fixed" as const,
      a: { componentId: firstId, datumId: "top_plane" },
      b: { componentId: secondId, topologyRole: "mount_face" },
      offsetM: 0,
      angleRad: 0,
      enabled: true,
    };
    store.apply(workspaceBatch(store, "add_cad_mate", [{
      op: "update_component",
      op_id: "mate",
      id: rootId,
      patch: { props: { mates: [sourceMate] } },
    }]));
    store.apply(workspaceBatch(store, "publish_cad_fixture", [{
      op: "publish_model",
      op_id: "publish",
      model_id: "com.semaframe.cad-fixture",
      version: "2.0.0",
      display_name: "CAD Fixture",
      root_id: rootId,
    }]));

    const definition = store.getState().modelDefinitions.get("com.semaframe.cad-fixture@2.0.0")!;
    assertModelDefinition(definition);
    expect(definition).toMatchObject({
      formatVersion: MODEL_DEFINITION_FORMAT_VERSION,
      generatorVersion: MODEL_DEFINITION_GENERATOR_VERSION,
      rootNodeId: rootId,
      digest: expect.stringMatching(/^fnv1a32:[0-9a-f]{8}$/u),
    });
    if (definition.formatVersion !== MODEL_DEFINITION_FORMAT_VERSION) throw new Error("Expected V2 model definition");
    expect(definition.nodes.map((node) => node.logicalNodeId)).toEqual([rootId, secondId, firstId]);
    expect(definition.nodes.find((node) => node.nodeId === secondId)).toMatchObject({
      logicalNodeId: secondId,
      partNumber: "POST-002",
      materialName: "Steel 1045",
    });
    expect(definition.nodes.find((node) => node.nodeId === rootId)?.props.mates).toEqual([sourceMate]);

    const ref = modelDefinitionRef(definition);
    const firstMap = {
      [rootId]: "FIXTURE_A",
      [firstId]: "FIXTURE_A_BASE",
      [secondId]: "FIXTURE_A_2ND",
    };
    const secondMap = {
      [rootId]: "FIXTURE_B",
      [firstId]: "FIXTURE_B_BASE",
      [secondId]: "FIXTURE_B_2ND",
    };
    store.apply(workspaceBatch(store, "instantiate_cad_fixture_twice", [{
      op: "instantiate_model",
      op_id: "instance_a",
      model: ref,
      id_map: firstMap,
      root_placement: world(-10, 0, 0),
    }, {
      op: "instantiate_model",
      op_id: "instance_b",
      model: ref,
      id_map: secondMap,
      root_placement: world(10, 0, 0),
    }]));

    expect(store.getState().components.get(firstMap[rootId])?.props.mates).toEqual([{
      ...sourceMate,
      a: { ...sourceMate.a, componentId: firstMap[firstId] },
      b: { ...sourceMate.b, componentId: firstMap[secondId] },
    }]);
    expect(store.getState().components.get(secondMap[rootId])?.props.mates).toEqual([{
      ...sourceMate,
      a: { ...sourceMate.a, componentId: secondMap[firstId] },
      b: { ...sourceMate.b, componentId: secondMap[secondId] },
    }]);

    const firstNode = definition.nodes.find((node) => node.nodeId === firstId)!;
    const secondNode = definition.nodes.find((node) => node.nodeId === secondId)!;
    for (const idMap of [firstMap, secondMap]) {
      expect(store.getState().components.get(idMap[firstId])?.props).toEqual(firstNode.props);
      expect(store.getState().components.get(idMap[secondId])?.props).toEqual(secondNode.props);
      expect(store.getState().components.get(idMap[firstId])?.locks.props).toBe(false);
      expect(store.getState().components.get(idMap[secondId])?.locks.props).toBe(false);
    }

    store.apply(workspaceBatch(store, "temporary_instance_edits", [{
      op: "update_component",
      op_id: "edit_a",
      id: firstMap[firstId],
      patch: { props: { partNumber: "TEMP-A" } },
    }, {
      op: "update_component",
      op_id: "edit_b",
      id: secondMap[secondId],
      patch: { props: { partNumber: "TEMP-B" } },
    }]));
    expect(store.undo()).not.toBeNull();
    expect(store.getState().components.get(firstMap[firstId])?.props).toEqual(firstNode.props);
    expect(store.getState().components.get(secondMap[secondId])?.props).toEqual(secondNode.props);

    const serializer = new WorkspaceProjectSerializer();
    const currentProject = serializer.fromStore("reusable_cad_v2", store);
    expect(currentProject).toMatchObject({
      protocolVersion: WORKSPACE_PROTOCOL_VERSION,
      workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
      checkpoint: {
        protocolVersion: WORKSPACE_PROTOCOL_VERSION,
        workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
      },
      workspace: {
        protocolVersion: WORKSPACE_PROTOCOL_VERSION,
        workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
      },
    });

    // Compatibility with projects saved while ModelDefinition 2.0 support was
    // present but the project schema envelope was still stamped as 1.3.
    const schema13Project = structuredClone(currentProject) as unknown as {
      workspaceSchemaVersion: string;
      checkpoint: { workspaceSchemaVersion: string };
      workspace: { workspaceSchemaVersion: string };
    };
    schema13Project.workspaceSchemaVersion = REALITY_WORKSPACE_SCHEMA_VERSION;
    schema13Project.checkpoint.workspaceSchemaVersion = REALITY_WORKSPACE_SCHEMA_VERSION;
    schema13Project.workspace.workspaceSchemaVersion = REALITY_WORKSPACE_SCHEMA_VERSION;
    const migratedProject = serializer.deserialize(schema13Project);
    expect(migratedProject).toMatchObject({
      protocolVersion: WORKSPACE_PROTOCOL_VERSION,
      workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
      checkpoint: { workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION },
      workspace: { workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION },
    });
    expect(migratedProject.workspace.modelDefinitions?.[0]?.[1]).toEqual(definition);

    const serializedProject = serializer.deserialize(serializer.serialize(migratedProject));
    await verifyWorkspaceProjectCadEvidence(serializedProject, { cadKernelFactory: loadCadKernel });
    const reopened = serializer.openStore(serializedProject);
    expect(reopened.getState().modelDefinitions.get("com.semaframe.cad-fixture@2.0.0")).toEqual(definition);
    for (const idMap of [firstMap, secondMap]) {
      const first = reopened.getState().components.get(idMap[firstId])!;
      const second = reopened.getState().components.get(idMap[secondId])!;
      expect(parseCadPartDefinition(first.props.definition)).toEqual(firstDefinition);
      expect(parseCadEvaluationEvidence(first.props.evaluation, firstDefinition)).toEqual(firstEvidence);
      expect(parseCadPartDefinition(second.props.definition)).toEqual(secondDefinition);
      expect(parseCadEvaluationEvidence(second.props.evaluation, secondDefinition)).toEqual(secondEvidence);
    }

    reopened.apply(workspaceBatch(reopened, "edit_both_reopened_instances", [{
      op: "update_component",
      op_id: "edit_reopened_a",
      id: firstMap[firstId],
      patch: { props: { partNumber: "INSTANCE-A-EDIT" } },
    }, {
      op: "update_component",
      op_id: "edit_reopened_b",
      id: secondMap[secondId],
      patch: { props: { materialName: "INSTANCE-B-EDIT" } },
    }]));
    expect(reopened.getState().components.get(firstMap[firstId])?.props.partNumber).toBe("INSTANCE-A-EDIT");
    expect(reopened.getState().components.get(secondMap[secondId])?.props.materialName).toBe("INSTANCE-B-EDIT");
    expect(parseCadEvaluationEvidence(
      reopened.getState().components.get(firstMap[firstId])!.props.evaluation,
      firstDefinition,
    )).toEqual(firstEvidence);
    expect(parseCadEvaluationEvidence(
      reopened.getState().components.get(secondMap[secondId])!.props.evaluation,
      secondDefinition,
    )).toEqual(secondEvidence);
  }, 30_000);
});
