import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceMcpServer,
  workspaceControllerMcpBackend,
} from "../../../../server/workspace/WorkspaceMcpTools";
import { WorkspaceAgentController } from "../../../workspace/agents";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import { exportParametricModelToUsda } from "../../../workspace/modeling/openUsdExporter";
import { modelDefinitionToOpenUsdDocument } from "../../../workspace/modeling/workspaceOpenUsd";
import { WorkspaceProjectSerializer } from "../../../workspace/persistence";
import type { WorkspaceOperation } from "../../../workspace/protocol";
import { WorkspaceStore } from "../../../workspace/state";

type ToolPayload =
  | { ok: true; data: Record<string, unknown> }
  | {
    ok: false;
    error: {
      code: string;
      message: string;
      retryable: boolean;
      required_action?: string;
      details?: unknown;
    };
  };

type AdvertisedComponent = Readonly<{
  typeId: string;
  version: string;
  digest: string;
  propsSchema: Record<string, unknown>;
  defaultProps: Record<string, unknown>;
  allowedPlacements: string[];
}>;

type CapabilityManifest = Readonly<{
  component_types: AdvertisedComponent[];
  allowed_operations: string[];
}>;

type ModelNodeDto = Readonly<{
  node_id: string;
  parent_node_id?: string;
  component_type: { typeId: string; version: string; digest: string };
  props: Record<string, unknown>;
  placement: Record<string, unknown>;
}>;

type ModelDefinitionDto = Readonly<{
  model_id: string;
  version: string;
  digest: string;
  root_node_id: string;
  node_count: number;
  id_map_keys: string[];
  nodes: ModelNodeDto[];
}>;

const world = (x: number, y: number, z: number) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

function payload(result: Awaited<ReturnType<Client["callTool"]>>): ToolPayload {
  const structured = result.structuredContent as ToolPayload | undefined;
  if (!structured || typeof structured.ok !== "boolean") {
    throw new Error(`Workspace MCP tool returned no structured payload: ${JSON.stringify(result)}`);
  }
  return structured;
}

function data(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const structured = payload(result);
  if (!structured.ok) throw new Error(`${structured.error.code}: ${structured.error.message}`);
  return structured.data;
}

function error(result: Awaited<ReturnType<Client["callTool"]>>): Extract<ToolPayload, { ok: false }>["error"] {
  const structured = payload(result);
  if (structured.ok) throw new Error(`Expected a Workspace error, received ${JSON.stringify(structured.data)}`);
  return structured.error;
}

function capability(preparation: Record<string, unknown>): CapabilityManifest {
  return preparation.capability_manifest as CapabilityManifest;
}

function componentRef(
  manifest: CapabilityManifest,
  typeId: string,
): Pick<AdvertisedComponent, "typeId" | "version" | "digest"> {
  const advertised = manifest.component_types.find((entry) => entry.typeId === typeId);
  if (!advertised) throw new Error(`${typeId} is absent from the advertised component manifest`);
  return {
    typeId: advertised.typeId,
    version: advertised.version,
    digest: advertised.digest,
  };
}

describe("Workspace Agent parametric modeling vertical slice", () => {
  it("authors, preflights, publishes, inspects, instantiates, edits, exports, persists, and enforces model permissions through MCP", async () => {
    const observedAtMs = 84_000;
    const store = new WorkspaceStore({ clock: () => observedAtMs });
    let requestSequence = 0;
    let tokenSequence = 0;
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: () => `modeling_e2e_request_${++requestSequence}`,
    });
    const controller = new WorkspaceAgentController(adapter, {
      now: () => observedAtMs,
      randomToken: (prefix) => `${prefix}_${String(++tokenSequence).padStart(32, "0")}`,
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
    });
    const server = createWorkspaceMcpServer(workspaceControllerMcpBackend(controller));
    const client = new Client(
      { name: "workspace-modeling-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const instructions = data(await client.callTool({
        name: "get_workspace_instructions",
        arguments: {
          client_id: "parametric-modeling-agent",
          client_name: "Parametric modeling regression agent",
        },
      }));
      expect(instructions.granted_scopes).toEqual(expect.arrayContaining([
        "workspace:read",
        "workspace:write",
        "workspace:history",
        "component:create",
        "component:update",
      ]));
      expect(instructions.guide).toMatchObject({
        modeling_quickstart: {
          authoring: expect.any(Array),
          units_and_authority: expect.objectContaining({ preflight: expect.any(String) }),
          reusable_models: {
            publish: expect.objectContaining({ op: "publish_model" }),
            instantiate: expect.objectContaining({ op: "instantiate_model" }),
            discovery: expect.any(String),
            rule: expect.any(String),
          },
        },
      });
      const session = {
        session_token: String(instructions.session_token),
        instruction_digest: String(instructions.guide_digest),
      };

      const begin = async (intent: string, requestedComponentIds = 1) => data(await client.callTool({
        name: "begin_workspace_update",
        arguments: {
          ...session,
          intent,
          requested_component_ids: requestedComponentIds,
        },
      }));
      const submit = async (
        preparation: Record<string, unknown>,
        operations: readonly WorkspaceOperation[],
      ) => data(await client.callTool({
        name: "submit_workspace_batch",
        arguments: {
          ...session,
          transaction_token: String(preparation.transaction_token),
          batch: {
            ...(preparation.envelope as Record<string, unknown>),
            operations: [...operations],
          },
        },
      }));

      const authored = await begin("Author a reusable exact two-part fixture", 4);
      const advertised = capability(authored);
      expect(advertised.allowed_operations).toEqual(expect.arrayContaining([
        "publish_model",
        "instantiate_model",
        "delete_model_definition",
      ]));
      const stageManifest = advertised.component_types.find(({ typeId }) => typeId === "stage-3d");
      const assemblyManifest = advertised.component_types.find(({ typeId }) => typeId === "model-assembly");
      const primitiveManifest = advertised.component_types.find(({ typeId }) => typeId === "spatial-primitive");
      expect(stageManifest).toMatchObject({ version: expect.any(String), digest: expect.any(String) });
      expect(assemblyManifest).toMatchObject({
        version: "1.0.0",
        allowedPlacements: ["world3d"],
        defaultProps: { description: "", collisionPolicy: "external_only" },
        propsSchema: {
          additionalProperties: false,
          properties: {
            description: { type: "string", maxLength: 2_000 },
            collisionPolicy: { enum: ["external_only", "all", "none"] },
          },
        },
      });
      expect(primitiveManifest).toMatchObject({
        version: "1.0.0",
        allowedPlacements: ["world3d"],
        propsSchema: {
          additionalProperties: false,
          required: ["geometry", "material", "collision", "physics", "castShadow", "receiveShadow"],
          properties: { geometry: { oneOf: expect.any(Array) } },
        },
      });
      const primitiveAlternatives = ((primitiveManifest?.propsSchema.properties as {
        geometry: { oneOf: Array<{ properties: { kind: { const: string } } }> };
      }).geometry.oneOf).map((entry) => entry.properties.kind.const);
      expect(primitiveAlternatives).toEqual(["box", "sphere", "cylinder", "cone", "capsule", "plane"]);

      const geometryPreflight = data(await client.callTool({
        name: "query_spatial_placement",
        arguments: {
          ...session,
          candidate: {
            geometry: { kind: "box", sizeM: { x: 2, y: 0.2, z: 1 } },
            placement: world(0, 0.1, 0),
          },
        },
      }));
      expect(geometryPreflight).toMatchObject({
        workspace_revision: 0,
        placement_check: {
          valid: true,
          candidate_id: "__SPATIAL_CANDIDATE__",
          conflicts: [],
        },
      });
      const invalidIdentity = await client.callTool({
        name: "query_spatial_placement",
        arguments: {
          ...session,
          candidate: {
            asset_id: "primitive_box",
            entity_kind: "primitive",
            geometry: { kind: "box", sizeM: { x: 2, y: 0.2, z: 1 } },
            placement: world(0, 0.1, 0),
          },
        },
      });
      expect(invalidIdentity.isError).toBe(true);
      expect(invalidIdentity.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Input validation error") }),
      ]));

      const [stageId, assemblyId, baseId, postId] = authored.reserved_component_ids as string[];
      const stageRef = componentRef(advertised, "stage-3d");
      const assemblyRef = componentRef(advertised, "model-assembly");
      const primitiveRef = componentRef(advertised, "spatial-primitive");
      const baseGeometry = { kind: "box" as const, sizeM: { x: 2, y: 0.2, z: 1 } };
      const postGeometry = { kind: "cylinder" as const, radiusM: 0.1, heightM: 1.5, axis: "y" as const };
      const staticPhysics = (massKg: number) => ({
        enabled: true,
        bodyType: "static" as const,
        massKg,
        centerOfMass: { x: 0, y: 0, z: 0 },
        friction: 0.6,
        restitution: 0.1,
        gravityScale: 1,
        stabilityMode: "report" as const,
        constraints: [],
      });
      const authoredReceipt = await submit(authored, [{
        op: "create_component",
        op_id: "create_stage",
        id: stageId!,
        component_type: stageRef,
        placement: world(0, 0, 0),
      }, {
        op: "create_component",
        op_id: "create_fixture_assembly",
        id: assemblyId!,
        component_type: assemblyRef,
        label: "Agent fixture",
        props: { description: "Exact two-part fixture", collisionPolicy: "external_only" },
        placement: world(0, 0, 0),
      }, {
        op: "create_component",
        op_id: "create_fixture_base",
        id: baseId!,
        component_type: primitiveRef,
        label: "Fixture base",
        props: { geometry: baseGeometry, physics: staticPhysics(8) },
        placement: world(0, 0.1, 0),
        parent_id: assemblyId!,
      }, {
        op: "create_component",
        op_id: "create_fixture_post",
        id: postId!,
        component_type: primitiveRef,
        label: "Fixture post",
        props: { geometry: postGeometry, physics: staticPhysics(2) },
        placement: world(0, 0.95, 0),
        parent_id: assemblyId!,
      }]);
      expect(authoredReceipt).toMatchObject({ status: "committed", resulting_workspace_revision: 1 });

      const publish = await begin("Publish the authored fixture", 1);
      const published = await submit(publish, [{
        op: "publish_model",
        op_id: "publish_fixture",
        model_id: "com.semaframe.agent-fixture",
        version: "1.0.0",
        display_name: "Agent Fixture",
        root_id: assemblyId!,
      }]);
      expect(published).toMatchObject({ status: "committed", resulting_workspace_revision: 2 });

      const inspection = data(await client.callTool({
        name: "inspect_workspace",
        arguments: session,
      }));
      expect(inspection.workspace_summary).toMatchObject({
        revision: 2,
        model_definition_count: 1,
        omitted_model_definition_count: 0,
        model_definitions: [expect.objectContaining({
          model_id: "com.semaframe.agent-fixture",
          version: "1.0.0",
          display_name: "Agent Fixture",
          root_node_id: assemblyId,
          node_count: 3,
          digest: expect.any(String),
        })],
      });

      const modelInspection = data(await client.callTool({
        name: "inspect_workspace_model",
        arguments: {
          ...session,
          model_id: "com.semaframe.agent-fixture",
          version: "1.0.0",
        },
      }));
      const model = modelInspection.model_definition as ModelDefinitionDto;
      expect(model).toMatchObject({
        model_id: "com.semaframe.agent-fixture",
        version: "1.0.0",
        digest: expect.any(String),
        root_node_id: assemblyId,
        node_count: 3,
        id_map_keys: [assemblyId, baseId, postId],
        nodes: [
          expect.objectContaining({ node_id: assemblyId, component_type: assemblyRef }),
          expect.objectContaining({ node_id: baseId, parent_node_id: assemblyId, component_type: primitiveRef }),
          expect.objectContaining({ node_id: postId, parent_node_id: assemblyId, component_type: primitiveRef }),
        ],
      });
      const immutableBaseNode = model.nodes.find(({ node_id }) => node_id === baseId)!;
      expect(immutableBaseNode.props.geometry).toEqual(baseGeometry);

      const definition = store.getState().modelDefinitions.get("com.semaframe.agent-fixture@1.0.0")!;
      const usd = exportParametricModelToUsda(modelDefinitionToOpenUsdDocument(definition));
      expect(usd).toMatchObject({ format: "usda", version: "1.0" });
      expect(usd.usda).toContain("#usda 1.0");
      expect(usd.usda).toContain("metersPerUnit = 1");
      expect(usd.usda).toContain('upAxis = "Y"');
      expect(usd.usda).toContain('string "semaframe:id" = "com.semaframe.agent-fixture@1.0.0"');

      const instantiate = await begin("Instantiate the exact published fixture", model.node_count);
      const reservedInstanceIds = instantiate.reserved_component_ids as string[];
      expect(reservedInstanceIds).toHaveLength(model.id_map_keys.length);
      const idMap = Object.fromEntries(model.id_map_keys.map((nodeId, index) => [nodeId, reservedInstanceIds[index]!]));
      const instantiated = await submit(instantiate, [{
        op: "instantiate_model",
        op_id: "instantiate_fixture",
        model: {
          modelId: model.model_id,
          version: model.version,
          digest: model.digest,
        },
        id_map: idMap,
        root_placement: world(4, 0, 0),
      }]);
      expect(instantiated).toMatchObject({ status: "committed", resulting_workspace_revision: 3 });
      const instanceAssemblyId = idMap[assemblyId!];
      const instanceBaseId = idMap[baseId!];
      const instancePostId = idMap[postId!];
      expect(store.getState().components.get(instanceAssemblyId!)).toMatchObject({
        props: {
          modelRef: {
            modelId: model.model_id,
            version: model.version,
            digest: model.digest,
          },
        },
        placement: world(4, 0, 0),
      });

      const edit = await begin("Edit the materialized instance without mutating its published source", 1);
      const editedGeometry = { kind: "box" as const, sizeM: { x: 2.5, y: 0.2, z: 1 } };
      const edited = await submit(edit, [{
        op: "update_component",
        op_id: "resize_instance_base_exactly",
        id: instanceBaseId!,
        patch: { props: { geometry: editedGeometry } },
      }]);
      expect(edited).toMatchObject({ status: "committed", resulting_workspace_revision: 4 });
      expect(store.getState().components.get(instanceBaseId!)?.props.geometry).toEqual(editedGeometry);
      expect(store.getState().components.get(baseId!)?.props.geometry).toEqual(baseGeometry);
      expect(store.getState().modelDefinitions.get("com.semaframe.agent-fixture@1.0.0")?.nodes
        .find(({ nodeId }) => nodeId === baseId)?.props.geometry).toEqual(baseGeometry);

      const modelAfterEdit = data(await client.callTool({
        name: "inspect_workspace_model",
        arguments: {
          ...session,
          model_id: model.model_id,
          version: model.version,
        },
      })).model_definition as ModelDefinitionDto;
      expect(modelAfterEdit.digest).toBe(model.digest);
      expect(modelAfterEdit.nodes.find(({ node_id }) => node_id === baseId)?.props.geometry).toEqual(baseGeometry);

      const space = data(await client.callTool({
        name: "inspect_workspace_space",
        arguments: session,
      })).spatial_graph as {
        format: string;
        version: string;
        nodes: Array<Record<string, unknown>>;
      };
      expect(space).toMatchObject({ format: "semaframe-spatial-graph", version: "3.1" });
      const instanceAssembly = space.nodes.find(({ id }) => id === instanceAssemblyId)!;
      const instanceBase = space.nodes.find(({ id }) => id === instanceBaseId)!;
      const instancePost = space.nodes.find(({ id }) => id === instancePostId)!;
      expect(instanceAssembly).toMatchObject({
        node_kind: "assembly",
        assembly: {
          collision_policy: "external_only",
          model_ref: { modelId: model.model_id, version: model.version, digest: model.digest },
        },
        assembly_ancestry: [],
        world_bounds: expect.any(Object),
      });
      expect(instanceBase).toMatchObject({
        node_kind: "primitive",
        parent_id: instanceAssemblyId,
        geometry: {
          kind: "box",
          parameters: editedGeometry,
          dimensions_m: { x: 2.5, y: 0.2, z: 1 },
          volume_m3: 0.5,
          digest: expect.any(String),
          local_bounds: expect.any(Object),
          collider: { shape: "box", sizeM: { x: 2.5, y: 0.2, z: 1 } },
        },
        assembly_ancestry: [{
          id: instanceAssemblyId,
          collision_policy: "external_only",
          model_ref: { modelId: model.model_id, version: model.version, digest: model.digest },
        }],
        physics: {
          enabled: true,
          body_type: "static",
          mass_kg: 8,
          mass_source: "explicit",
          geometry_volume_m3: 0.5,
        },
      });
      expect(instancePost).toMatchObject({
        node_kind: "primitive",
        parent_id: instanceAssemblyId,
        geometry: {
          kind: "cylinder",
          parameters: postGeometry,
          dimensions_m: { x: 0.2, y: 1.5, z: 0.2 },
          volume_m3: Math.PI * 0.1 * 0.1 * 1.5,
        },
        assembly_ancestry: [expect.objectContaining({ id: instanceAssemblyId })],
        physics: {
          mass_kg: 2,
          mass_source: "explicit",
          geometry_volume_m3: Math.PI * 0.1 * 0.1 * 1.5,
        },
      });

      const undone = data(await client.callTool({
        name: "undo_workspace_batch",
        arguments: { ...session, expected_workspace_revision: 4 },
      }));
      expect(undone).toMatchObject({ action: "undo", changed: true, workspace_revision: 3 });
      expect(store.getState().components.get(instanceBaseId!)?.props.geometry).toEqual(baseGeometry);
      const redone = data(await client.callTool({
        name: "redo_workspace_batch",
        arguments: { ...session, expected_workspace_revision: 3 },
      }));
      expect(redone).toMatchObject({ action: "redo", changed: true, workspace_revision: 4 });
      expect(store.getState().components.get(instanceBaseId!)?.props.geometry).toEqual(editedGeometry);

      const serializer = new WorkspaceProjectSerializer();
      const project = serializer.fromStore("agent-modeling-e2e", store);
      const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(project)));
      expect(reopened.getRevision()).toBe(4);
      expect(reopened.getState().modelDefinitions.get("com.semaframe.agent-fixture@1.0.0")?.digest).toBe(model.digest);
      expect(reopened.getState().components.get(instanceBaseId!)?.props.geometry).toEqual(editedGeometry);
      expect(reopened.undo()).not.toBeNull();
      expect(reopened.getState().components.get(instanceBaseId!)?.props.geometry).toEqual(baseGeometry);
      expect(reopened.redo()).not.toBeNull();
      expect(reopened.getState().components.get(instanceBaseId!)?.props.geometry).toEqual(editedGeometry);

      const restrictedInstructions = data(await client.callTool({
        name: "get_workspace_instructions",
        arguments: {
          client_id: "restricted-modeling-agent",
          requested_scopes: ["workspace:read", "workspace:write", "workspace:history"],
        },
      }));
      const restrictedSession = {
        session_token: String(restrictedInstructions.session_token),
        instruction_digest: String(restrictedInstructions.guide_digest),
      };
      const restrictedBegin = async (intent: string, ids = 1) => data(await client.callTool({
        name: "begin_workspace_update",
        arguments: { ...restrictedSession, intent, requested_component_ids: ids },
      }));
      const restrictedSubmit = async (
        preparation: Record<string, unknown>,
        operations: readonly WorkspaceOperation[],
      ) => error(await client.callTool({
        name: "submit_workspace_batch",
        arguments: {
          ...restrictedSession,
          transaction_token: String(preparation.transaction_token),
          batch: { ...(preparation.envelope as Record<string, unknown>), operations: [...operations] },
        },
      }));
      const revisionBeforeDenials = store.getRevision();

      const deniedPublishPreparation = await restrictedBegin("Attempt an unapproved model publish");
      expect(await restrictedSubmit(deniedPublishPreparation, [{
        op: "publish_model",
        op_id: "denied_publish",
        model_id: "com.semaframe.denied-fixture",
        version: "1.0.0",
        display_name: "Denied Fixture",
        root_id: assemblyId!,
      }])).toMatchObject({
        code: "permission_denied",
        required_action: "request_user_approval",
        details: { missing_scopes: ["component:update"] },
      });

      const deniedInstantiatePreparation = await restrictedBegin("Attempt an unapproved model instance", model.node_count);
      const deniedIds = deniedInstantiatePreparation.reserved_component_ids as string[];
      expect(await restrictedSubmit(deniedInstantiatePreparation, [{
        op: "instantiate_model",
        op_id: "denied_instantiate",
        model: { modelId: model.model_id, version: model.version, digest: model.digest },
        id_map: Object.fromEntries(model.id_map_keys.map((nodeId, index) => [nodeId, deniedIds[index]!])),
        root_placement: world(-4, 0, 0),
      }])).toMatchObject({
        code: "permission_denied",
        required_action: "request_user_approval",
        details: { missing_scopes: ["component:create"] },
      });

      const deniedDeletePreparation = await restrictedBegin("Attempt an unapproved model deletion");
      expect(await restrictedSubmit(deniedDeletePreparation, [{
        op: "delete_model_definition",
        op_id: "denied_delete",
        model: { modelId: model.model_id, version: model.version, digest: model.digest },
        confirm: true,
      }])).toMatchObject({
        code: "destructive_permission_required",
        required_action: "request_user_approval",
        details: {
          missing_scopes: ["component:delete"],
          destructive_operations: [expect.objectContaining({ op: "delete_model_definition" })],
        },
      });
      expect(store.getRevision()).toBe(revisionBeforeDenials);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
