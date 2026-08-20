import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceMcpServer,
  workspaceControllerMcpBackend,
} from "../../../../server/workspace/WorkspaceMcpTools";
import {
  WorkspaceAgentController,
  WORKSPACE_AGENT_TOOL_NAMES,
  WORKSPACE_OPERATION_NAMES,
  WORKSPACE_PERMISSION_SCOPES,
} from "../../../workspace/agents";
import {
  destructiveWorkspaceOperations,
  requiredScopesForWorkspaceBatch,
} from "../../../workspace/agents/WorkspaceAgentController";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import { prepareComponentRecipe } from "../../../workspace/protocol";
import type { WorkspaceOperation } from "../../../workspace/protocol/workspaceTypes";
import { WorkspaceStore } from "../../../workspace/state";

type ToolPayload =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

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

describe("public Workspace Agent surface", () => {
  it("keeps every advertised operation behind its exact controller scope", () => {
    const operationScopes = {
      define_component_recipe: "component:recipe_define",
      create_component: "component:create",
      update_component: "component:update",
      upgrade_component_manifest: "component:update",
      delete_component: "component:delete",
      place_component: "component:update",
      resize_component: "component:update",
      set_component_visual_effects: "component:update",
      attach_component: "component:update",
      detach_component: "component:update",
      invoke_component_action: "component:invoke",
      upsert_resource: "connector:write",
      delete_resource: "connector:delete",
      bind_resource: "connector:bind",
      unbind_resource: "connector:bind",
      connect_event: "event:connect",
      disconnect_event: "event:connect",
      present_view: "view:present",
      publish_model: "component:update",
      instantiate_model: "component:create",
      delete_model_definition: "component:delete",
      clear_workspace: "workspace:clear",
    } as const;

    expect(new Set(Object.keys(operationScopes))).toEqual(new Set(WORKSPACE_OPERATION_NAMES));

    for (const [op, required] of Object.entries(operationScopes)) {
      expect(requiredScopesForWorkspaceBatch({ operations: [{ op }] }), op).toEqual(
        [required, "workspace:write"].sort(),
      );
    }
    expect(destructiveWorkspaceOperations({
      operations: Object.keys(operationScopes).map((op, index) => ({ op, op_id: `operation_${index}` })),
    })).toEqual([
      { index: 4, op: "delete_component", op_id: "operation_4" },
      { index: 12, op: "delete_resource", op_id: "operation_12" },
      { index: 20, op: "delete_model_definition", op_id: "operation_20" },
      { index: 21, op: "clear_workspace", op_id: "operation_21" },
    ]);
  });

  it("round-trips every public tool and advertised operation through MCP, controller, and the real store", async () => {
    const store = new WorkspaceStore({ clock: () => 30_000 });
    let requestSequence = 0;
    let tokenSequence = 0;
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: () => `public_surface_request_${++requestSequence}`,
    });
    const controller = new WorkspaceAgentController(adapter, {
      randomToken: (prefix) => `${prefix}_${String(++tokenSequence).padStart(32, "0")}`,
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
    });
    const server = createWorkspaceMcpServer(workspaceControllerMcpBackend(controller));
    const client = new Client(
      { name: "workspace-public-surface-coverage", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name).sort()).toEqual(
        [...WORKSPACE_AGENT_TOOL_NAMES].sort(),
      );

      const instructions = data(await client.callTool({
        name: "get_workspace_instructions",
        arguments: {
          client_id: "public-surface-agent",
          client_name: "Public surface coverage agent",
          requested_scopes: [...WORKSPACE_PERMISSION_SCOPES],
        },
      }));
      expect(instructions.granted_scopes).toEqual([...WORKSPACE_PERMISSION_SCOPES].sort());
      const session = {
        session_token: String(instructions.session_token),
        instruction_digest: String(instructions.guide_digest),
      };

      const inspectedEmpty = data(await client.callTool({
        name: "inspect_workspace",
        arguments: session,
      }));
      expect(inspectedEmpty).toMatchObject({ workspace_revision: 0 });

      const commit = async (
        intent: string,
        operations: (
          preparation: Record<string, unknown>,
        ) => readonly WorkspaceOperation[],
        requestedComponentIds = 1,
      ): Promise<Record<string, unknown>> => {
        const preparation = data(await client.callTool({
          name: "begin_workspace_update",
          arguments: {
            ...session,
            intent,
            requested_component_ids: requestedComponentIds,
          },
        }));
        const receipt = data(await client.callTool({
          name: "submit_workspace_batch",
          arguments: {
            ...session,
            transaction_token: String(preparation.transaction_token),
            batch: {
              ...(preparation.envelope as Record<string, unknown>),
              operations: [...operations(preparation)],
            },
          },
        }));
        return receipt;
      };

      const recipe = prepareComponentRecipe({
        typeId: "recipe.public-surface-note",
        version: "1.0.0",
        displayName: "Public surface note",
        allowedPlacements: ["viewport"],
        resizePolicy: {
          viewport: {
            kind: "box2d",
            mode: "free",
            defaultSize: { width: 240, height: 120 },
            minSize: { width: 120, height: 60 },
            maxSize: { width: 800, height: 600 },
            allowedAxes: ["width", "height"],
            units: "px",
          },
        },
        propsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: { text: { type: "string", maxLength: 1_000 } },
        },
        durableStateSchema: { type: "object", additionalProperties: false },
        defaultProps: { text: "Agent note" },
        defaultDurableState: {},
        writableProps: ["text"],
        actions: {},
        events: {},
        root: { id: "note", primitive: "text", props: { text: "{{props.text}}" } },
      });
      await commit("Define a bounded public-surface recipe", () => [{
        op: "define_component_recipe",
        op_id: "define_public_surface_note",
        recipe: { ...recipe, digest: "auto" },
      }]);

      let firstTimerId = "";
      let secondTimerId = "";
      let legacyPanelId = "";
      await commit("Create two controllable timers and one legacy panel", (preparation) => {
        const reserved = preparation.reserved_component_ids as string[];
        const capability = preparation.capability_manifest as {
          component_types: Array<{ typeId: string; version: string; digest: string }>;
        };
        const timer = capability.component_types.find(({ typeId }) => typeId === "timer");
        if (!timer) throw new Error("Timer capability was not advertised");
        const componentType = {
          typeId: timer.typeId,
          version: timer.version,
          digest: timer.digest,
        };
        [firstTimerId, secondTimerId, legacyPanelId] = reserved;
        const timers: WorkspaceOperation[] = [firstTimerId, secondTimerId].map((id, index) => ({
          op: "create_component" as const,
          op_id: `create_timer_${index + 1}`,
          id,
          component_type: componentType,
          placement: {
            space: "viewport" as const,
            anchor: index === 0 ? "top_left" as const : "top_right" as const,
            offset: { x: index === 0 ? 16 : -16, y: 16 },
          },
        }));
        return [...timers, {
          op: "create_component" as const,
          op_id: "create_legacy_panel",
          id: legacyPanelId,
          component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel", "1.1.0"),
          placement: {
            space: "viewport" as const,
            anchor: "center" as const,
            offset: { x: 0, y: 0 },
          },
        }];
      }, 3);

      const exactComponent = data(await client.callTool({
        name: "inspect_workspace_component",
        arguments: { ...session, component_id: firstTimerId },
      }));
      expect(exactComponent).toMatchObject({
        workspace_revision: 2,
        component: { id: firstTimerId },
        pinned_manifest: { typeId: "timer" },
      });

      await commit("Exercise every non-destructive Workspace operation", () => [{
        op: "update_component",
        op_id: "update_timer",
        id: firstTimerId,
        patch: { props: { label: "Updated by Agent" } },
      }, {
        op: "upgrade_component_manifest",
        op_id: "upgrade_legacy_panel",
        id: legacyPanelId,
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      }, {
        op: "place_component",
        op_id: "place_timer",
        id: firstTimerId,
        placement: {
          space: "viewport",
          anchor: "bottom_left",
          offset: { x: 24, y: -24 },
          size: { width: 210, height: 112 },
        },
      }, {
        op: "resize_component",
        op_id: "resize_timer",
        id: firstTimerId,
        resize: { kind: "box2d", size: { width: 300, height: 160 } },
      }, {
        op: "set_component_visual_effects",
        op_id: "set_timer_effects",
        id: firstTimerId,
        visual_effects: {
          opacity: 0.9,
          emissive: { color: "#FFFFFF", intensity: 0.2 },
          glow: { color: "#68D5FF", intensity: 0.4, spread: 0.5 },
        },
      }, {
        op: "attach_component",
        op_id: "attach_timer",
        child_id: secondTimerId,
        parent_id: firstTimerId,
      }, {
        op: "detach_component",
        op_id: "detach_timer",
        child_id: secondTimerId,
      }, {
        op: "invoke_component_action",
        op_id: "start_timer",
        id: firstTimerId,
        action: "start",
        input: { durationMs: 10_000 },
      }, {
        op: "upsert_resource",
        op_id: "upsert_feed",
        resource: {
          id: "resource_feed",
          label: "Public feed",
          connectorType: "inline.snapshot",
          connectorVersion: "1.0.0",
          outputSchema: { type: "string" },
          config: {},
          policy: { mode: "manual", offline: "keep_last_good" },
          snapshot: {
            data: "Public feed",
            contentHash: "host-computed",
            retrievedAt: "2026-08-15T01:02:03.000Z",
            stale: false,
            provenance: [],
          },
          status: "ready",
        },
      }, {
        op: "bind_resource",
        op_id: "bind_feed",
        binding: {
          kind: "resource_binding",
          id: "binding_feed",
          resourceId: "resource_feed",
          componentId: firstTimerId,
          targetProp: "label",
          mode: "snapshot",
          transform: { kind: "identity" },
          enabled: true,
        },
      }, {
        op: "unbind_resource",
        op_id: "unbind_feed",
        binding_id: "binding_feed",
      }, {
        op: "connect_event",
        op_id: "connect_timers",
        connection: {
          kind: "event_connection",
          id: "connection_timers",
          sourceComponentId: firstTimerId,
          event: "started",
          targetComponentId: secondTimerId,
          action: "reset",
          input: {},
          enabled: true,
        },
      }, {
        op: "disconnect_event",
        op_id: "disconnect_timers",
        connection_id: "connection_timers",
      }, {
        op: "present_view",
        op_id: "present_timers",
        view: {
          id: "view_timers",
          label: "Timers",
          componentIds: [firstTimerId, secondTimerId],
        },
      }]);

      const events = data(await client.callTool({
        name: "read_workspace_events",
        arguments: { ...session, limit: 20 },
      }));
      expect(events).toMatchObject({
        events: [expect.objectContaining({ type: "started", componentId: firstTimerId })],
        has_more: false,
      });

      const undone = data(await client.callTool({
        name: "undo_workspace_batch",
        arguments: { ...session, expected_workspace_revision: 3 },
      }));
      expect(undone).toMatchObject({ action: "undo", changed: true, workspace_revision: 2 });
      const redone = data(await client.callTool({
        name: "redo_workspace_batch",
        arguments: { ...session, expected_workspace_revision: 2 },
      }));
      expect(redone).toMatchObject({ action: "redo", changed: true, workspace_revision: 3 });

      await commit("Remove the temporary resource and second timer", () => [{
        op: "delete_resource",
        op_id: "delete_feed",
        resource_id: "resource_feed",
      }, {
        op: "delete_component",
        op_id: "delete_second_timer",
        id: secondTimerId,
        policy: "orphan",
      }]);

      await commit("Clear all remaining native Workspace content", () => [{
        op: "clear_workspace",
        op_id: "clear_native_workspace",
        confirm: true,
        include_resources: true,
      }]);

      const finalInspection = data(await client.callTool({
        name: "inspect_workspace",
        arguments: session,
      }));
      expect(finalInspection).toMatchObject({
        workspace_revision: 5,
        workspace_summary: { component_count: 0, resource_count: 0 },
      });

      const exercisedOperations = store.getCommandHistory()
        .flatMap(({ resolvedOperations }) => resolvedOperations.map(({ op }) => op));
      expect(new Set(exercisedOperations)).toEqual(new Set([
        "define_component_recipe",
        "create_component",
        "update_component",
        "upgrade_component_manifest",
        "delete_component",
        "place_component",
        "resize_component",
        "set_component_visual_effects",
        "attach_component",
        "detach_component",
        "invoke_component_action",
        "upsert_resource",
        "delete_resource",
        "bind_resource",
        "unbind_resource",
        "connect_event",
        "disconnect_event",
        "present_view",
        "clear_workspace",
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);
});
