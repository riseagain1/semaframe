import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAssetIngress } from "../../../server/agent/AgentAssetIngress";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import {
  createAgentGatewayHttpHandler,
  type AgentGatewayFetchHandler,
} from "../../../server/agent/AgentGatewayHttpHandler";
import { WorkspaceAgentController } from "../../workspace/agents";
import { WorkspaceStoreEngineAdapter } from "../../workspace/agents/WorkspaceStoreEngineAdapter";
import { inspectRealityAsset, MemoryAssetVault } from "../../workspace/assets";
import { readBlobRange } from "../../workspace/assets/blobIO";
import { WorkspaceProjectSerializer, workspaceStateDigest } from "../../workspace/persistence";
import type { WorkspaceOperation } from "../../workspace/protocol";
import { WorkspaceStore } from "../../workspace/state";
import { binaryPly } from "../workspace-assets/fixtures";
import { workspaceBatch } from "../workspace/helpers";

const PUBLIC_URL = "http://127.0.0.1:8788";
const ORIGIN = "http://127.0.0.1:4173";

type ToolData = Record<string, unknown>;

const handlers: AgentGatewayFetchHandler[] = [];
const clients: Client[] = [];
const gateways: AgentGateway[] = [];
const temporaryParents: string[] = [];
const vaults: MemoryAssetVault[] = [];

function toolData(result: Awaited<ReturnType<Client["callTool"]>>): ToolData {
  const payload = result.structuredContent as
    | { ok: true; data: ToolData }
    | { ok: false; error: { code: string; message: string } }
    | undefined;
  if (!payload) throw new Error("MCP result has no structured payload");
  if (!payload.ok) throw new Error(`${payload.error.code}: ${payload.error.message}`);
  return payload.data;
}

async function bridgeOne(
  gateway: AgentGateway,
  browserConnectionId: string,
  controller: WorkspaceAgentController,
): Promise<void> {
  let polled = await gateway.pollBrowser(browserConnectionId);
  for (let attempt = 0; polled.kind === "idle" && attempt < 5; attempt += 1) {
    polled = await gateway.pollBrowser(browserConnectionId);
  }
  if (polled.kind !== "command") throw new Error("Expected a browser-authoritative Workspace command");
  const result = await controller.dispatch(polled.command.name, polled.command.input);
  gateway.submitBrowserResult({
    browserConnectionId,
    commandId: polled.command.id,
    ok: true,
    result,
  });
}

async function bridgedTool(
  client: Client,
  gateway: AgentGateway,
  browserConnectionId: string,
  controller: WorkspaceAgentController,
  name: string,
  args: Record<string, unknown>,
) {
  const response = client.callTool({ name, arguments: args });
  await bridgeOne(gateway, browserConnectionId, controller);
  return response;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function componentRef(preparation: ToolData, typeId: string) {
  const capability = preparation.capability_manifest as {
    component_types: Array<{ typeId: string; version: string; digest: string }>;
  };
  const manifest = capability.component_types.find((candidate) => candidate.typeId === typeId);
  if (!manifest) throw new Error(`Missing advertised component ${typeId}`);
  return { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest };
}

const world = (x: number, y: number, z: number) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(handlers.splice(0).map((handler) => handler.close()));
  gateways.splice(0).forEach((gateway) => gateway.close());
  vaults.splice(0).forEach((vault) => vault.dispose());
  await Promise.allSettled(temporaryParents.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Reality Asset Agent MCP vertical slice", () => {
  it("approves, streams, finalizes, inspects, places, proxies, undoes, reopens, and derives SSG without exposing bytes", async () => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "semaframe-reality-mcp-e2e-"));
    temporaryParents.push(temporaryParent);
    const assetIngress = new AgentAssetIngress({
      publicBaseUrl: PUBLIC_URL,
      temporaryDirectory: temporaryParent,
      sweepIntervalMs: 0,
      maxBytes: 1024 * 1024,
    });
    const store = new WorkspaceStore({ clock: () => 84_000 });
    const vault = new MemoryAssetVault();
    vaults.push(vault);
    let requestSequence = 0;
    let tokenSequence = 0;
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: () => `reality_e2e_request_${++requestSequence}`,
    });
    const controller = new WorkspaceAgentController(adapter, {
      now: () => 84_000,
      randomToken: (prefix) => `${prefix}_${String(++tokenSequence).padStart(32, "0")}`,
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
      completeRealityAssetImport: async (candidateHandle, principal) => {
        expect(principal.scopes).toContain("asset:import");
        const workspaceId = store.getState().workspaceId;
        const opened = await assetIngress.open(candidateHandle, workspaceId);
        const blob = await new Response(opened.body, {
          headers: { "content-type": opened.descriptor.mediaType },
        }).blob();
        const candidate = await inspectRealityAsset(blob);
        expect(candidate.descriptor.digest).toBe(opened.descriptor.sha256);
        await vault.put(candidate, blob);
        if (!store.getState().realityAssets.has(candidate.descriptor.assetId)) {
          store.apply(workspaceBatch(store, `register_${opened.descriptor.requestId}`, [{
            op: "register_reality_asset",
            op_id: "register_agent_reality",
            asset: candidate.descriptor,
          }]));
        }
        await assetIngress.complete(candidateHandle, workspaceId);
        return {
          asset_ref: {
            asset_id: candidate.descriptor.assetId,
            digest: candidate.descriptor.digest,
          },
          descriptor: candidate.descriptor,
          warnings: [...candidate.warnings],
        };
      },
    });
    const gateway = new AgentGateway({
      publicBaseUrl: PUBLIC_URL,
      workspaceRoot: "/workspace/SemaFrame",
      commandTimeoutMs: 2_000,
      pollTimeoutMs: 10,
      browserTtlMs: 5_000,
    });
    gateways.push(gateway);
    const handle = createAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
      browserBootstrapToken: "b".repeat(43),
      assetIngress,
    });
    handlers.push(handle);
    gateway.setEnabled(true);
    const reveal = gateway.revealPairing();
    const registration = gateway.registerBrowser("reality-mcp-e2e-browser");
    const client = new Client(
      { name: "reality-mcp-e2e-agent", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 2_000 } } },
    );
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(reveal.connectionUrl), {
      fetch: (input, init) => {
        const { signal: _signal, ...requestInit } = init ?? {};
        return handle(new Request(input, requestInit));
      },
    }));

    const claim = await client.callTool({
      name: "get_workspace_instructions",
      arguments: {
        client_id: "reality-e2e-agent",
        client_name: "Reality Layer regression Agent",
        requested_scopes: ["workspace:read", "workspace:write", "workspace:history", "component:create", "asset:import"],
      },
    });
    const claimPayload = claim.structuredContent as {
      error: { details: { approval_token: string; claim_id: string } };
    };
    gateway.approveClaim(claimPayload.error.details.claim_id);
    const guidePromise = client.callTool({
      name: "get_workspace_instructions",
      arguments: { approval_token: claimPayload.error.details.approval_token },
    });
    await bridgeOne(gateway, registration.browserConnectionId, controller);
    const guide = toolData(await guidePromise);
    expect(guide.granted_scopes).toEqual(expect.arrayContaining(["asset:import", "component:create"]));
    const session = {
      session_token: String(guide.session_token),
      instruction_digest: String(guide.guide_digest),
    };

    const source = binaryPly([
      [-0.5, 0, -0.5, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
      [0.5, 8, 0.5, 1, -1, -1, -1, 0, 0, 0, 1, 0.5, 0.5, 0.5],
    ]);
    const sourceBytes = await readBlobRange(source, 0, source.size);
    const begin = toolData(await bridgedTool(
      client, gateway, registration.browserConnectionId, controller,
      "begin_workspace_asset_import",
      {
        ...session,
        request_id: "reality-pole-import-0001",
        workspace_id: store.getState().workspaceId,
        display_name: "utility-pole.ply",
        format: "ply",
        media_type: "model/ply",
        byte_length: sourceBytes.byteLength,
        sha256: digest(sourceBytes),
      },
    ));
    const grantJson = JSON.stringify(begin);
    expect(grantJson).not.toMatch(/base64|local_path|file:\/\//iu);
    const upload = begin.upload as {
      url: string; token: string; content_type: string; content_length: number;
    };
    const uploadResponse = await handle(new Request(upload.url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${upload.token}`,
        "content-type": upload.content_type,
        "content-length": String(upload.content_length),
      },
      body: sourceBytes.slice().buffer,
    }));
    expect(uploadResponse.status).toBe(200);

    const completed = toolData(await bridgedTool(
      client, gateway, registration.browserConnectionId, controller,
      "complete_workspace_asset_import",
      { ...session, candidate_handle: begin.candidate_handle },
    ));
    const completion = completed.result as {
      asset_ref: { asset_id: string; digest: string };
      descriptor: Record<string, unknown>;
    };
    expect(completion).toMatchObject({
      asset_ref: { asset_id: expect.stringMatching(/^ra_[a-f0-9]{64}$/u), digest: digest(sourceBytes) },
      descriptor: { engineeringAuthority: "visual_only", format: "ply", splatCount: 2 },
    });
    expect(await vault.has(completion.asset_ref.asset_id as `ra_${string}`)).toBe(true);

    const exactAsset = toolData(await bridgedTool(
      client, gateway, registration.browserConnectionId, controller,
      "inspect_workspace_asset",
      { ...session, asset_id: completion.asset_ref.asset_id },
    ));
    expect(exactAsset).toMatchObject({
      descriptor: completion.descriptor,
      binary_availability: "host_local_unknown",
    });
    expect(JSON.stringify(exactAsset)).not.toMatch(/local_path|upload|token|raw_bytes/iu);

    const preparation = toolData(await bridgedTool(
      client, gateway, registration.browserConnectionId, controller,
      "begin_workspace_update",
      { ...session, intent: "Place a utility-pole Reality scan with an engineering proxy", requested_component_ids: 3 },
    ));
    const [stageId, proxyId, scanId] = preparation.reserved_component_ids as string[];
    const operations: WorkspaceOperation[] = [{
      op: "create_component", op_id: "stage", id: stageId!,
      component_type: componentRef(preparation, "stage-3d"), placement: world(0, 0, 0),
    }, {
      op: "create_component", op_id: "proxy", id: proxyId!,
      component_type: componentRef(preparation, "spatial-primitive"),
      label: "Editable utility-pole proxy", placement: world(0, 4, 0),
      props: { geometry: { kind: "cylinder", radiusM: 0.25, heightM: 8, axis: "y" } },
    }, {
      op: "create_component", op_id: "scan", id: scanId!,
      component_type: componentRef(preparation, "gaussian-splat"),
      label: "Utility-pole Reality scan", placement: world(0, 0, 0),
      props: {
        assetRef: { assetId: completion.asset_ref.asset_id, digest: completion.asset_ref.digest },
        calibration: {
          version: 1, status: "metadata-declared", sourceCoordinateSystem: "RUB",
          targetCoordinateSystem: "RUB", metersPerSourceUnit: 1, declaredUnit: "metre",
        },
        quality: "auto",
        semanticProxyIds: [proxyId!],
      },
    }];
    const receipt = toolData(await bridgedTool(
      client, gateway, registration.browserConnectionId, controller,
      "submit_workspace_batch",
      {
        ...session,
        transaction_token: preparation.transaction_token,
        batch: { ...(preparation.envelope as Record<string, unknown>), operations },
      },
    ));
    expect(receipt).toMatchObject({ status: "committed", resulting_workspace_revision: 2 });

    const space = toolData(await bridgedTool(
      client, gateway, registration.browserConnectionId, controller,
      "inspect_workspace_space", session,
    ));
    const graph = space.spatial_graph as {
      version: string;
      collision_conflicts: unknown[];
      nodes: Array<Record<string, unknown>>;
    };
    expect(graph.version).toBe("3.2");
    expect(graph.collision_conflicts).toEqual([]);
    expect(graph.nodes.find(({ id }) => id === scanId)).toMatchObject({
      node_kind: "reality",
      reality: {
        engineering_authority: "visual_only",
        semantic_proxy_ids: [proxyId],
      },
      relations: [`represented_by:${proxyId}`],
    });
    expect(graph.nodes.find(({ id }) => id === proxyId)).toMatchObject({
      relations: expect.arrayContaining([`proxy_for:${scanId}`]),
    });

    const undone = toolData(await bridgedTool(
      client, gateway, registration.browserConnectionId, controller,
      "undo_workspace_batch", { ...session, expected_workspace_revision: 2 },
    ));
    expect(undone).toMatchObject({ changed: true, workspace_revision: 1 });
    expect(store.getState().components.size).toBe(0);
    const redone = toolData(await bridgedTool(
      client, gateway, registration.browserConnectionId, controller,
      "redo_workspace_batch", { ...session, expected_workspace_revision: 1 },
    ));
    expect(redone).toMatchObject({ changed: true, workspace_revision: 2 });

    const serializer = new WorkspaceProjectSerializer();
    const serialized = serializer.serialize(serializer.fromStore("reality_mcp_e2e", store));
    expect(serialized).not.toContain("end_header");
    const reopened = serializer.openStore(serializer.deserialize(serialized));
    expect(workspaceStateDigest(reopened.getState() as never))
      .toBe(workspaceStateDigest(store.getState() as never));
    expect(reopened.getState().components.get(scanId!)?.props.semanticProxyIds).toEqual([proxyId]);
    expect(reopened.getState().realityAssets.has(completion.asset_ref.asset_id)).toBe(true);
  });
});
