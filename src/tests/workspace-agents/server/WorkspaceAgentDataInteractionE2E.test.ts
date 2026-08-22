import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceMcpServer,
  workspaceControllerMcpBackend,
} from "../../../../server/workspace/WorkspaceMcpTools";
import { WorkspaceAgentController } from "../../../workspace/agents";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import {
  WorkspaceProjectSerializer,
  workspaceStateDigest,
} from "../../../workspace/persistence";
import type { WorkspaceOperation } from "../../../workspace/protocol";
import { toRenderSnapshot } from "../../../workspace/renderer/contracts";
import { workspaceToSceneState } from "../../../workspace/renderer/ThreeComponentRenderer";
import { WorkspaceStore } from "../../../workspace/state";

type ToolPayload =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

type AdvertisedComponent = {
  typeId: string;
  version: string;
  digest: string;
  actions: Record<string, unknown>;
  events: Record<string, unknown>;
};

type AdvertisedAsset = {
  asset_id: string;
  kind: string;
  animations: string[];
};

type AdvertisedConnector = {
  connectorType: string;
  connectorVersion: string;
  networkAccess: boolean;
  recommendedOutputSchemas?: Array<{ id: string; schema: Record<string, unknown> }>;
};

function data(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const structured = result.structuredContent as ToolPayload | undefined;
  if (!structured || typeof structured.ok !== "boolean") {
    throw new Error(`Workspace MCP tool returned no structured payload: ${JSON.stringify(result)}`);
  }
  if (!structured.ok) throw new Error(`${structured.error.code}: ${structured.error.message}`);
  return structured.data;
}

function capability(preparation: Record<string, unknown>) {
  return preparation.capability_manifest as {
    component_types: AdvertisedComponent[];
    connector_types: AdvertisedConnector[];
    asset_library: { assets: AdvertisedAsset[] };
  };
}

function componentRef(
  manifest: ReturnType<typeof capability>,
  typeId: string,
): Pick<AdvertisedComponent, "typeId" | "version" | "digest"> {
  const advertised = manifest.component_types.find((entry) => entry.typeId === typeId);
  if (!advertised) throw new Error(`${typeId} was not advertised by the Workspace capability manifest`);
  return {
    typeId: advertised.typeId,
    version: advertised.version,
    digest: advertised.digest,
  };
}

describe("Workspace Agent data and interaction vertical slice", () => {
  it("builds, binds, routes, renders, undo/redoes, and reopens through the real MCP stack", async () => {
    const observedAtMs = 42_000;
    const store = new WorkspaceStore({ clock: () => observedAtMs });
    let requestSequence = 0;
    let tokenSequence = 0;
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: () => `vertical_slice_request_${++requestSequence}`,
    });
    const controller = new WorkspaceAgentController(adapter, {
      now: () => observedAtMs,
      randomToken: (prefix) => `${prefix}_${String(++tokenSequence).padStart(32, "0")}`,
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
    });
    const server = createWorkspaceMcpServer(workspaceControllerMcpBackend(controller));
    const client = new Client(
      { name: "workspace-data-interaction-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const instructions = data(await client.callTool({
        name: "get_workspace_instructions",
        arguments: {
          client_id: "vertical-slice-agent",
          client_name: "Vertical slice regression agent",
        },
      }));
      expect(instructions.granted_scopes).toEqual(expect.arrayContaining([
        "workspace:read",
        "workspace:write",
        "workspace:history",
        "component:create",
        "component:invoke",
        "connector:write",
        "connector:bind",
        "event:connect",
      ]));
      expect(instructions.guide).toMatchObject({
        data_interaction_quickstart: {
          stock_chart: expect.any(Object),
          interactions: expect.any(Array),
          animation: expect.any(Object),
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

      const stagePreparation = await begin("Create the required 3D stage", 1);
      const stageId = (stagePreparation.reserved_component_ids as string[])[0]!;
      const stageRef = componentRef(capability(stagePreparation), "stage-3d");
      const stageReceipt = await submit(stagePreparation, [{
        op: "create_component",
        op_id: "create_stage",
        id: stageId,
        component_type: stageRef,
        props: { environmentPreset: "simple_room" },
        placement: {
          space: "world3d",
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        transition: { durationMs: 320, delayMs: 0, easing: "ease_out" },
      }]);
      expect(stageReceipt).toMatchObject({ status: "committed", resulting_workspace_revision: 1 });

      const setup = await begin("Create a bound stock chart and wire 2D and 3D interactions", 3);
      const setupCapabilities = capability(setup);
      const [chartId, buttonId, spatialId] = setup.reserved_component_ids as string[];
      const chartRef = componentRef(setupCapabilities, "chart");
      const buttonRef = componentRef(setupCapabilities, "button");
      const spatialRef = componentRef(setupCapabilities, "spatial-entity");
      expect(setupCapabilities.component_types.find(({ typeId }) => typeId === "chart"))
        .toMatchObject({
          actions: { toggle_visibility: expect.any(Object) },
          events: { visibility_changed: expect.any(Object) },
        });
      expect(setupCapabilities.component_types.find(({ typeId }) => typeId === "button"))
        .toMatchObject({
          actions: { press: expect.any(Object) },
          events: { pressed: expect.any(Object) },
        });
      expect(setupCapabilities.component_types.find(({ typeId }) => typeId === "spatial-entity"))
        .toMatchObject({
          actions: {
            activate: expect.any(Object),
            play_animation: expect.any(Object),
            move_to: expect.objectContaining({
              effectClass: "semantic",
              requiredPermissions: ["component:update"],
            }),
          },
          events: {
            activated: expect.any(Object),
            animation_started: expect.any(Object),
            moved: expect.any(Object),
          },
        });
      const characterAsset = setupCapabilities.asset_library.assets.find(
        ({ asset_id }) => asset_id === "humanoid_adult_neutral_01",
      );
      if (!characterAsset || characterAsset.kind !== "character" || !characterAsset.animations.includes("run")) {
        throw new Error("The advertised asset catalog has no runnable neutral character");
      }
      const snapshotConnector = setupCapabilities.connector_types.find(
        ({ connectorType, connectorVersion }) =>
          connectorType === "inline.snapshot" && connectorVersion === "1.0.0",
      );
      const stockSchema = snapshotConnector?.recommendedOutputSchemas?.find(
        ({ id }) => id === "chart.timeseries.v1",
      )?.schema;
      if (!snapshotConnector || snapshotConnector.networkAccess || !stockSchema) {
        throw new Error("The safe normalized chart snapshot connector was not advertised");
      }
      const stockData = {
        labels: ["09:30", "09:31", "09:32"],
        series: [{
          id: "close",
          label: "Close",
          values: [188.4, 189.1, 188.8],
          color: "#68D5FF",
        }],
      };

      const setupReceipt = await submit(setup, [{
        op: "create_component",
        op_id: "create_chart",
        id: chartId!,
        component_type: chartRef,
        props: { title: "ACME intraday", chartType: "line" },
        placement: { space: "viewport", anchor: "top_right", offset: { x: -24, y: 24 } },
        transition: { durationMs: 320, delayMs: 0, easing: "ease_out" },
      }, {
        op: "create_component",
        op_id: "create_button",
        id: buttonId!,
        component_type: buttonRef,
        props: { label: "Run simulation", variant: "primary" },
        placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: -24 } },
        transition: { durationMs: 180, easing: "ease_out" },
      }, {
        op: "create_component",
        op_id: "create_character",
        id: spatialId!,
        component_type: spatialRef,
        props: {
          assetId: characterAsset.asset_id,
          entityKind: characterAsset.kind as "character",
        },
        placement: {
          space: "world3d",
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        transition: { durationMs: 320, easing: "ease_out" },
      }, {
        op: "upsert_resource",
        op_id: "upsert_stock_snapshot",
        resource: {
          id: "RES_stock_snapshot",
          label: "ACME intraday snapshot",
          connectorType: snapshotConnector.connectorType,
          connectorVersion: snapshotConnector.connectorVersion,
          outputSchema: stockSchema,
          config: {},
          policy: { mode: "manual", offline: "keep_last_good" },
          snapshot: {
            data: stockData,
            contentHash: "caller-value-must-be-replaced",
            retrievedAt: "1970-01-01T00:00:00.000Z",
            stale: false,
            provenance: [],
          },
          status: "ready",
        },
      }, {
        op: "bind_resource",
        op_id: "bind_stock_labels",
        binding: {
          kind: "resource_binding",
          id: "BIND_stock_labels",
          resourceId: "RES_stock_snapshot",
          componentId: chartId!,
          targetProp: "labels",
          sourcePath: "$.labels",
          mode: "snapshot",
          transform: { kind: "identity" },
          enabled: true,
        },
      }, {
        op: "bind_resource",
        op_id: "bind_stock_series",
        binding: {
          kind: "resource_binding",
          id: "BIND_stock_series",
          resourceId: "RES_stock_snapshot",
          componentId: chartId!,
          targetProp: "series",
          sourcePath: "$.series",
          mode: "snapshot",
          transform: { kind: "identity" },
          enabled: true,
        },
      }, {
        op: "connect_event",
        op_id: "connect_button_to_animation",
        connection: {
          kind: "event_connection",
          id: "EVENT_button_animation",
          sourceComponentId: buttonId!,
          event: "pressed",
          targetComponentId: spatialId!,
          action: "play_animation",
          input: { clip: "run", loop: true, speed: 1 },
          enabled: true,
        },
      }, {
        op: "connect_event",
        op_id: "connect_spatial_to_chart",
        connection: {
          kind: "event_connection",
          id: "EVENT_spatial_chart",
          sourceComponentId: spatialId!,
          event: "activated",
          targetComponentId: chartId!,
          action: "toggle_visibility",
          input: {},
          enabled: true,
        },
      }]);
      expect(setupReceipt).toMatchObject({ status: "committed", resulting_workspace_revision: 2 });

      const canonicalChart = store.getState().components.get(chartId!)!;
      expect(canonicalChart.props).toMatchObject({ labels: [], series: [] });
      const firstSnapshot = toRenderSnapshot(store.getState());
      expect(firstSnapshot.bindingDiagnostics).toBeUndefined();
      expect(firstSnapshot.components.find(({ id }) => id === chartId!)?.props).toMatchObject(stockData);
      expect(store.getState().components.get(chartId!)?.props).toMatchObject({ labels: [], series: [] });
      expect(store.getState().resources.get("RES_stock_snapshot")?.snapshot).toMatchObject({
        retrievedAt: "1970-01-01T00:00:42.000Z",
        stale: false,
        provenance: [{ publisher: "SemaFrame inline snapshot" }],
      });
      expect(store.getState().resources.get("RES_stock_snapshot")?.snapshot?.contentHash)
        .not.toBe("caller-value-must-be-replaced");

      const press = await begin("Press the 2D control to start the 3D animation");
      const pressReceipt = await submit(press, [{
        op: "invoke_component_action",
        op_id: "press_run_simulation",
        id: buttonId!,
        action: "press",
        input: {},
        transition: { durationMs: 180, easing: "ease_out" },
      }]);
      expect(pressReceipt).toMatchObject({ status: "committed", resulting_workspace_revision: 3 });
      expect(store.getState().components.get(buttonId!)?.durableState).toEqual({
        pressCount: 1,
        lastPressedAtMs: observedAtMs,
      });
      expect(store.getState().components.get(spatialId!)?.durableState).toEqual({
        playback: { clip: "run", playing: true, loop: true, speed: 1, generation: 1 },
      });
      expect(store.getCommandHistory().at(-1)?.resolvedOperations).toHaveLength(2);
      expect(store.getCommandHistory().at(-1)?.resolvedOperations[1]).toMatchObject({
        op: "invoke_component_action",
        id: spatialId,
        action: "play_animation",
      });
      expect(workspaceToSceneState(toRenderSnapshot(store.getState())).entities.get(spatialId!)?.state)
        .toMatchObject({
          type: "character",
          animation: "run",
          animationPlaying: true,
          animationLoop: true,
          animationSpeed: 1,
          animationGeneration: 1,
        });

      const activate = await begin("Activate the 3D character to toggle the 2D chart");
      const activateReceipt = await submit(activate, [{
        op: "invoke_component_action",
        op_id: "activate_character",
        id: spatialId!,
        action: "activate",
        input: {},
      }]);
      expect(activateReceipt).toMatchObject({ status: "committed", resulting_workspace_revision: 4 });
      expect(store.getState().components.get(chartId!)?.visibility).toBe("hidden");
      expect(store.getCommandHistory().at(-1)?.resolvedOperations).toHaveLength(2);
      expect(store.getCommandHistory().at(-1)?.resolvedOperations[1]).toMatchObject({
        op: "invoke_component_action",
        id: chartId,
        action: "toggle_visibility",
      });

      const events = data(await client.callTool({
        name: "read_workspace_events",
        arguments: { ...session, limit: 10 },
      }));
      expect(events.events).toEqual([
        expect.objectContaining({ type: "pressed", source: "agent", componentId: buttonId }),
        expect.objectContaining({ type: "animation_started", source: "binding", componentId: spatialId }),
        expect.objectContaining({ type: "activated", source: "agent", componentId: spatialId }),
        expect.objectContaining({ type: "visibility_changed", source: "binding", componentId: chartId }),
      ]);

      const undone = data(await client.callTool({
        name: "undo_workspace_batch",
        arguments: { ...session, expected_workspace_revision: 4 },
      }));
      expect(undone).toMatchObject({ action: "undo", changed: true, workspace_revision: 3 });
      expect(store.getState().components.get(chartId!)?.visibility).toBe("visible");
      expect(store.getState().components.get(spatialId!)?.durableState).toMatchObject({
        playback: { clip: "run", playing: true, generation: 1 },
      });

      const redone = data(await client.callTool({
        name: "redo_workspace_batch",
        arguments: { ...session, expected_workspace_revision: 3 },
      }));
      expect(redone).toMatchObject({ action: "redo", changed: true, workspace_revision: 4 });
      expect(store.getState().components.get(chartId!)?.visibility).toBe("hidden");

      const serializer = new WorkspaceProjectSerializer();
      const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
        serializer.fromStore("agent_data_interaction_vertical_slice", store),
      )));
      expect(workspaceStateDigest(reopened.getState() as never))
        .toBe(workspaceStateDigest(store.getState() as never));
      expect(reopened.getCommandHistory()).toEqual(store.getCommandHistory());
      expect(reopened.getEventHistory()).toEqual(store.getEventHistory());
      expect(reopened.canUndo()).toBe(true);
      const reopenedSnapshot = toRenderSnapshot(reopened.getState());
      expect(reopenedSnapshot.bindingDiagnostics).toBeUndefined();
      expect(reopenedSnapshot.components.find(({ id }) => id === chartId!)?.props)
        .toMatchObject(stockData);
      expect(reopenedSnapshot.components.find(({ id }) => id === chartId!)?.visibility).toBe("hidden");
      expect(workspaceToSceneState(reopenedSnapshot).entities.get(spatialId!)?.state).toMatchObject({
        animation: "run",
        animationPlaying: true,
        animationGeneration: 1,
      });
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);
});
