import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceMcpServer,
  workspaceControllerMcpBackend,
} from "../../../../server/workspace/WorkspaceMcpTools";
import { WorkspaceAgentController } from "../../../workspace/agents";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import { deterministicDigest } from "../../../workspace/components";
import type { WorkspaceResource } from "../../../workspace/data";
import type { WorkspaceOperation } from "../../../workspace/protocol";
import { toRenderSnapshot } from "../../../workspace/renderer";
import { WorkspaceStore } from "../../../workspace/state";
import { workspaceBatch } from "../../workspace/helpers";

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

function canonicalHostFeed(): WorkspaceResource {
  const retrievedAt = "2026-08-15T05:06:07.000Z";
  const feedData = { items: [{ symbol: "ACME", price: 188.4 }] };
  return {
    id: "RES_host_feed",
    label: "Approved market feed",
    connectorType: "http.feed",
    connectorVersion: "1.0.0",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["symbol", "price"],
            properties: { symbol: { type: "string" }, price: { type: "number" } },
          },
        },
      },
    },
    config: { url: "https://feeds.example.org/market.json", format: "json" },
    policy: { mode: "manual", offline: "keep_last_good" },
    snapshot: {
      data: feedData,
      contentHash: deterministicDigest(feedData),
      retrievedAt,
      stale: false,
      provenance: [{
        uri: "https://feeds.example.org/market.json",
        publisher: "feeds.example.org",
        retrievedAt,
        citation: "https://feeds.example.org/market.json",
      }],
    },
    status: "ready",
  };
}

describe("Workspace Agent host-feed handoff", () => {
  it("inspects a host-approved feed, creates and binds a Data Panel, and cannot forge a host refresh", async () => {
    const store = new WorkspaceStore();
    const hostFeed = canonicalHostFeed();
    store.applyDetailed(workspaceBatch(store, "host_seed_feed", [{
      op: "upsert_resource",
      op_id: "host_seed_feed",
      resource: hostFeed,
    }]), { actor: "system", permissions: ["*"] });

    let requestSequence = 0;
    let tokenSequence = 0;
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: () => `host_feed_request_${++requestSequence}`,
    });
    const controller = new WorkspaceAgentController(adapter, {
      randomToken: (prefix) => `${prefix}_${String(++tokenSequence).padStart(32, "0")}`,
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
    });
    const server = createWorkspaceMcpServer(workspaceControllerMcpBackend(controller));
    const client = new Client(
      { name: "workspace-agent-host-feed-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const instructions = data(await client.callTool({
        name: "get_workspace_instructions",
        arguments: {
          client_id: "host-feed-agent",
          client_name: "Host feed regression agent",
        },
      }));
      const session = {
        session_token: String(instructions.session_token),
        instruction_digest: String(instructions.guide_digest),
      };
      const inspected = data(await client.callTool({
        name: "inspect_workspace",
        arguments: session,
      }));
      expect(inspected.workspace_summary).toMatchObject({
        resource_count: 1,
        resources: [expect.objectContaining({
          id: hostFeed.id,
          connector_type: "http.feed",
          connector_version: "1.0.0",
          output_schema: expect.objectContaining({
            type: "object",
            required: ["items"],
            properties: expect.objectContaining({ items: expect.any(Object) }),
          }),
          status: "ready",
          snapshot: expect.objectContaining({
            content_hash: hostFeed.snapshot!.contentHash,
            retrieved_at: hostFeed.snapshot!.retrievedAt,
            provenance: hostFeed.snapshot!.provenance,
          }),
        })],
      });

      const preparation = data(await client.callTool({
        name: "begin_workspace_update",
        arguments: { ...session, intent: "Show the approved feed in a Data Panel", requested_component_ids: 1 },
      }));
      const capability = preparation.capability_manifest as {
        component_types: Array<Record<string, unknown>>;
        connector_types: Array<Record<string, unknown>>;
      };
      const dataPanel = capability.component_types.find(({ typeId }) => typeId === "data-panel");
      expect(dataPanel).toMatchObject({
        typeId: "data-panel",
        writableProps: expect.arrayContaining(["data"]),
        propsSchema: expect.objectContaining({ properties: expect.objectContaining({ data: {} }) }),
      });
      expect(capability.connector_types).toEqual(expect.arrayContaining([
        expect.objectContaining({
          connectorType: "http.feed",
          execution: "host",
          agentWritePolicy: "host_approval_required",
          networkAccess: true,
        }),
      ]));
      if (!dataPanel) throw new Error("Data Panel was not advertised");
      const componentId = (preparation.reserved_component_ids as string[])[0]!;
      const operations: WorkspaceOperation[] = [{
        op: "create_component",
        op_id: "create_data_panel",
        id: componentId,
        component_type: {
          typeId: String(dataPanel.typeId),
          version: String(dataPanel.version),
          digest: String(dataPanel.digest),
        },
        placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      }, {
        op: "bind_resource",
        op_id: "bind_host_feed_root",
        binding: {
          kind: "resource_binding",
          id: "BIND_host_feed_root",
          resourceId: hostFeed.id,
          componentId,
          targetProp: "data",
          sourcePath: "$",
          mode: "snapshot",
          transform: { kind: "identity" },
          enabled: true,
        },
      }];
      const committed = data(await client.callTool({
        name: "submit_workspace_batch",
        arguments: {
          ...session,
          transaction_token: String(preparation.transaction_token),
          batch: { ...(preparation.envelope as Record<string, unknown>), operations },
        },
      }));
      expect(committed).toMatchObject({ status: "committed" });
      expect(toRenderSnapshot(store.getState()).components.find(({ id }) => id === componentId)?.props.data)
        .toEqual(hostFeed.snapshot!.data);

      const deniedPreparation = data(await client.callTool({
        name: "begin_workspace_update",
        arguments: { ...session, intent: "Try to forge a feed refresh", requested_component_ids: 1 },
      }));
      const denied = payload(await client.callTool({
        name: "submit_workspace_batch",
        arguments: {
          ...session,
          transaction_token: String(deniedPreparation.transaction_token),
          batch: {
            ...(deniedPreparation.envelope as Record<string, unknown>),
            operations: [{
              op: "upsert_resource",
              op_id: "agent_forge_host_feed",
              resource: { ...structuredClone(hostFeed), label: "Agent-forged feed" },
            }],
          },
        },
      }));
      expect(denied).toMatchObject({
        ok: false,
        error: expect.objectContaining({ message: expect.stringMatching(/not available for new Agent writes/u) }),
      });
      expect(store.getState().resources.get(hostFeed.id)?.label).toBe(hostFeed.label);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
