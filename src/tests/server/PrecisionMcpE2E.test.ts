import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import { createAgentGatewayHttpHandler } from "../../../server/agent/AgentGatewayHttpHandler";
import { WorkspaceAgentController } from "../../workspace/agents";
import { WorkspaceStoreEngineAdapter } from "../../workspace/agents/WorkspaceStoreEngineAdapter";
import { WorkspaceStore } from "../../workspace/state";
import { MemoryPrecisionEvidenceVault } from "../../workspace/precision/evidenceVault";
import { importMeasurementGeometry } from "../../workspace/precision/geometryImport";
import { createPrecisionStudy } from "../../workspace/precision/validation";
import { digestBlobSha256 } from "../../workspace/assets/digest";

type Data = Record<string, unknown>;
const PUBLIC_URL = "http://127.0.0.1:8788";
function data(result: Awaited<ReturnType<Client["callTool"]>>): Data {
  const payload = result.structuredContent as { ok: boolean; data?: Data; error?: unknown };
  if (!payload?.ok || !payload.data) throw new Error(`MCP failed: ${JSON.stringify(payload)}`);
  return payload.data;
}

describe("precision public MCP vertical slice", () => {
  it.each([true, false])("reads byte-bound public MCP evidence only with approved read scope (read enabled: %s)", async (canRead) => {
    const sourceText = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const blob = new Blob([sourceText]);
    const ref = { digest: await digestBlobSha256(blob), byteLength: blob.size, kind: "measurement-source" as const, mediaType: "model/obj" };
    const vault = new MemoryPrecisionEvidenceVault();
    await vault.put(ref, blob);
    const document = createPrecisionStudy(importMeasurementGeometry({ data: sourceText, format: "obj", geometryId: "source", units: "metre",
      coordinateBasis: "RUB", provenance: "Synthetic fixture, not real physical measurement" }));
    const store = new WorkspaceStore();
    const controller = new WorkspaceAgentController(new WorkspaceStoreEngineAdapter(store, { precisionEvidenceVault: vault }), {
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
    });
    const gateway = new AgentGateway({ publicBaseUrl: PUBLIC_URL, workspaceRoot: "/workspace/SemaFrame",
      commandTimeoutMs: 2_000, pollTimeoutMs: 10, browserTtlMs: 30_000 });
    const handler = createAgentGatewayHttpHandler(gateway, { allowedOrigins: ["http://127.0.0.1:4173"],
      publicBaseUrl: PUBLIC_URL, browserBootstrapToken: "b".repeat(43) });
    gateway.setEnabled(true);
    const reveal = gateway.revealPairing();
    const registration = gateway.registerBrowser("precision-public-mcp-browser");
    const client = new Client({ name: "precision-public-mcp-test", version: "1" }, {
      versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 2_000 } },
    });
    async function bridged(name: string, args: Data) {
      const result = client.callTool({ name, arguments: args });
      let polled = await gateway.pollBrowser(registration.browserConnectionId);
      for (let tries = 0; polled.kind === "idle" && tries < 10; tries += 1) polled = await gateway.pollBrowser(registration.browserConnectionId);
      if (polled.kind !== "command") throw new Error(`No browser command for ${name}`);
      gateway.submitBrowserResult({ browserConnectionId: registration.browserConnectionId, commandId: polled.command.id, ok: true,
        result: await controller.dispatch(polled.command.name, polled.command.input) });
      return result;
    }
    async function instructions(scopes: string[]) {
      const claim = await client.callTool({ name: "get_workspace_instructions", arguments: {
        client_id: "precision-test-agent", requested_scopes: scopes,
      } });
      const payload = claim.structuredContent as { error: { details: { claim_id: string; approval_token: string } } };
      gateway.approveClaim(payload.error.details.claim_id);
      const guide = data(await bridged("get_workspace_instructions", { approval_token: payload.error.details.approval_token }));
      return { session_token: guide.session_token, instruction_digest: guide.guide_digest };
    }
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(reveal.connectionUrl), { fetch: (input, init) => {
        const { signal: _signal, ...options } = init ?? {};
        return handler(new Request(input, options));
      } }));
      const session = await instructions(canRead ? ["workspace:read", "workspace:write", "component:create"] : ["workspace:write"]);
      if (!canRead) {
        // A separately approved write-only client must be rejected by the
        // canonical controller before it can read component evidence.
        const denied = await bridged("analyze_workspace_precision", { ...session,
          component_id: "unreadable_study", action: "inspect", options: {} });
        expect(denied.structuredContent).toMatchObject({ ok: false, error: { code: "permission_denied" } });
        return;
      }
      const preparation = data(await bridged("begin_workspace_update", { ...session, intent: "Create a precision source study", requested_component_ids: 1 }));
      const componentId = (preparation.reserved_component_ids as string[])[0]!;
      const manifest = (preparation.capability_manifest as { component_types: { typeId: string; version: string; digest: string }[] })
        .component_types.find((entry) => entry.typeId === "precision-study")!;
      const receipt = data(await bridged("submit_workspace_batch", { ...session, transaction_token: preparation.transaction_token,
        batch: { ...(preparation.envelope as Data), operations: [{ op: "create_component", op_id: "source", id: componentId,
          component_type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
          placement: { space: "viewport", anchor: "top_left", offset: { x: 24, y: 24 } }, props: { document, evidenceSources: [ref] } }] } }));
      expect(receipt.status).toBe("committed");
      const before = store.getRevision();
      const input = { ...session, component_id: componentId, action: "inspect", options: {} };
      expect(data(await bridged("analyze_workspace_precision", input))).toMatchObject({ workspace_revision: before,
        analysis: { report: { status: "unverified" }, evidence: { sourceBytesAuthenticated: true, physicalAccuracyCertified: false } } });
      expect(store.getRevision()).toBe(before);
      const unknown = await client.callTool({ name: "analyze_workspace_precision", arguments: { ...input, action: "certify_everything" } });
      expect(unknown.isError).toBe(true);
      await vault.delete(ref.digest);
      const missing = await bridged("analyze_workspace_precision", input);
      expect(missing.structuredContent).toMatchObject({ ok: false, error: { code: "precision_source_unavailable" } });
    } finally {
      await client.close();
      await handler.close();
      gateway.close();
    }
  });
});
