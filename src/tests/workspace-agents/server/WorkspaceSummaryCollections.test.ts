import { describe, expect, it } from "vitest";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import { DEFAULT_SPATIAL_PHYSICS } from "../../../workspace/physics";
import { inspectRealityAsset } from "../../../workspace/assets";
import { WorkspaceStore } from "../../../workspace/state";
import { binaryPly } from "../../workspace-assets/fixtures";
import { workspaceBatch } from "../../workspace/helpers";

const world = (x: number) => ({ space: "world3d" as const, position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
const reader = { sessionId: "summary_session", clientId: "summary_client", clientName: "Summary test", scopes: ["workspace:read" as const] };

describe("Agent summary collections and constraint inspection", () => {
  it("sorts resources, assets, connections and views and exposes constraint intent without changing source state", async () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "seed", [{
      op: "create_component", op_id: "stage", id: "STAGE", component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world(0),
    }, ...["Z", "A"].map((id, index) => ({
      op: "create_component" as const, op_id: `timer_${id}`, id: `TIMER_${id}`, component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport" as const, anchor: "top_left" as const, offset: { x: index * 500, y: 0 } },
    })), ...["Z", "A"].map((id) => ({
      op: "upsert_resource" as const, op_id: `resource_${id}`,
      resource: { id: `RESOURCE_${id}`, label: id, connectorType: "http-json", connectorVersion: "1",
        outputSchema: { type: "object" }, config: { city: "London" }, secretRef: "vault:weather",
        policy: { mode: "manual" as const, offline: "keep_last_good" as const }, status: "unconfigured" as const },
    })), ...["Z", "A"].map((id) => ({
      op: "present_view" as const, op_id: `view_${id}`, view: { id: `VIEW_${id}`, label: id, componentIds: [`TIMER_${id}`] },
    })), ...["Z", "A"].map((id) => ({
      op: "connect_event" as const, op_id: `connection_${id}`, connection: {
        kind: "event_connection" as const, id: `CONNECTION_${id}`, sourceComponentId: "TIMER_A", event: "finished", targetComponentId: "TIMER_Z", action: "start", enabled: true,
      },
    })), {
      op: "create_component", op_id: "anchor", id: "ANCHOR", component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"), placement: world(0),
      props: { assetId: "primitive_box", entityKind: "primitive" },
    }, {
      op: "create_component", op_id: "body", id: "BODY", component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"), placement: world(3),
      props: { assetId: "primitive_box", entityKind: "primitive", physics: { ...DEFAULT_SPATIAL_PHYSICS, bodyType: "dynamic", constraints: [{
        id: "HINGE", type: "hinge", targetId: "ANCHOR", anchor: { x: 0, y: 0, z: 0 }, targetAnchor: { x: 3, y: 0, z: 0 },
        axis: { x: 0, y: 1, z: 0 }, enabled: true, limits: { min: -1, max: 1 },
      }] } },
    }]));
    for (const offset of [2, 1]) {
      const { descriptor } = await inspectRealityAsset(binaryPly([
        [offset, 0, 0, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
        [offset + 1, 1, 1, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
      ]));
      store.apply(workspaceBatch(store, `asset_${offset}`, [{ op: "register_reality_asset", op_id: "asset", asset: descriptor }]));
    }
    const adapter = new WorkspaceStoreEngineAdapter(store);
    const summary = adapter.getState().summary as {
      resources: Array<{ id: string; secretRef?: string }>;
      reality_assets: Array<{ asset_id: string }>;
      connections: Array<{ id: string }>;
      shared_views: Array<{ id: string }>;
      physics_validation: { constrained_body_count: number };
    };
    expect(summary.resources.map((r) => r.id)).toEqual(["RESOURCE_A", "RESOURCE_Z"]);
    expect(JSON.stringify(summary)).not.toContain("vault:weather");
    expect(summary.reality_assets.map((a) => a.asset_id)).toEqual([...store.getState().realityAssets.keys()].sort());
    expect(summary.connections.map((c) => c.id)).toEqual(["CONNECTION_A", "CONNECTION_Z"]);
    expect(summary.shared_views.map((v) => v.id)).toEqual(["VIEW_A", "VIEW_Z"]);
    expect(summary.physics_validation.constrained_body_count).toBe(1);
    const physics = await adapter.inspectPhysics(["BODY"], reader);
    expect(physics).toMatchObject({ physicsValidation: { bodies: [expect.objectContaining({ component_id: "BODY",
      constraints: [expect.objectContaining({ id: "HINGE", target_id: "ANCHOR", limits: { min: -1, max: 1 } })],
    })] } });
    const component = await adapter.inspectComponent("TIMER_A", reader);
    expect(JSON.stringify(component)).toContain("CONNECTION_A");
    expect(JSON.stringify(component)).toContain("CONNECTION_Z");
    await adapter.simulatePhysics({}, reader);
    expect(store.getRevision()).toBe(3);
  });
});
