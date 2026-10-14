import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceMcpServer, workspaceControllerMcpBackend } from "../../../../server/workspace/WorkspaceMcpTools";
import { WorkspaceAgentController } from "../../../workspace/agents/WorkspaceAgentController";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import { WORKSPACE_AGENT_GUIDE, getWorkspaceAgentGuideDigest } from "../../../workspace/agents/guide";
import { WorkspaceStore } from "../../../workspace/state/WorkspaceStore";
import type { JSONValue, WorkspaceAgentResult } from "../../../workspace/agents/contracts";

function unwrap<T>(result: WorkspaceAgentResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function fixture(read = true) {
  const store = new WorkspaceStore();
  const adapter = new WorkspaceStoreEngineAdapter(store);
  const controller = new WorkspaceAgentController(adapter, {
    grantScopes: () => read ? ["workspace:read", "workspace:write", "component:create"] : [],
  });
  return { store, controller, adapter };
}

describe("progressive Workspace capability discovery", () => {
  it("defaults to core instructions and exact compact type bindings while keeping complete opt-in discovery", async () => {
    const { controller } = fixture();
    const instructions = unwrap(await controller.getWorkspaceInstructions());
    expect(instructions.guide_detail).toBe("core");
    expect(instructions.guide_digest).toBe(await getWorkspaceAgentGuideDigest());
    expect(instructions.guide.workspace_command_schema).toBeUndefined();
    expect(JSON.stringify(instructions.guide).length).toBeLessThan(10_000);
    const session = { session_token: instructions.session_token, instruction_digest: instructions.guide_digest };
    const compact = unwrap(await controller.inspectWorkspace(session));
    const full = unwrap(await controller.inspectWorkspace({ ...session, capability_detail: "full" }));
    const catalog = compact.capability_manifest as { component_types: Array<Record<string, JSONValue>>; schemas_included: boolean };
    const legacy = full.capability_manifest as { component_types: Array<Record<string, JSONValue>> };
    expect(catalog.schemas_included).toBe(false);
    expect(catalog.component_types).toHaveLength(legacy.component_types.length);
    for (const entry of catalog.component_types) {
      const complete = legacy.component_types.find((type) => type.typeId === entry.typeId)!;
      expect(entry).toMatchObject({ typeId: complete.typeId, version: complete.version, digest: complete.digest });
      expect(entry.propsSchema).toBeUndefined();
      expect(entry.defaultProps).toBeUndefined();
    }
    expect(unwrap(await controller.getWorkspaceInstructions({ detail: "full" })).guide).toEqual(WORKSPACE_AGENT_GUIDE);
    const selected = unwrap(await controller.inspectWorkspaceCapabilities({ ...session, component_type_ids: ["button", "model-assembly"], guide_topics: ["modeling"], operation_names: ["connect_event"] })) as Record<string, JSONValue>;
    expect(selected.component_types).toEqual(legacy.component_types.filter((type) => ["button", "model-assembly"].includes(String(type.typeId))));
    expect(selected.guide_topics).toHaveProperty("modeling");
    expect(selected.operation_schemas).toHaveProperty("connect_event");
    expect(selected.registry_digest).toBe(compact.registry_digest);
  });

  it("authenticates every selector, rejects stale digests and invalid names without fallback or mutation", async () => {
    const { controller, store } = fixture();
    const instructions = unwrap(await controller.getWorkspaceInstructions());
    const session = { session_token: instructions.session_token, instruction_digest: instructions.guide_digest };
    const initial = store.getState();
    expect(await controller.inspectWorkspaceCapabilities({ component_type_ids: ["button"] })).toMatchObject({ ok: false, error: { code: "instructions_required" } });
    expect(await controller.inspectWorkspaceCapabilities({ ...session, instruction_digest: "wrong-digest", component_type_ids: ["button"] })).toMatchObject({ ok: false, error: { code: "instruction_digest_mismatch" } });
    for (const selector of [{}, { component_type_ids: ["not-a-type"] }, { component_type_ids: Array(5).fill("button") }, { guide_topics: ["constructor"] }, { operation_names: ["arbitrary_script"] }, { include_connectors: "yes" }]) {
      expect(await controller.inspectWorkspaceCapabilities({ ...session, ...selector })).toMatchObject({ ok: false });
    }
    expect(store.getState()).toEqual(initial);
    const denied = fixture(false).controller;
    const deniedInstructions = unwrap(await denied.getWorkspaceInstructions());
    expect(await denied.inspectWorkspaceCapabilities({ session_token: deniedInstructions.session_token, instruction_digest: deniedInstructions.guide_digest, component_type_ids: ["button"] })).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  it("bounds exact discovery without truncation and offers an explicit full fallback for inherently large manifests", async () => {
    const { controller, adapter } = fixture();
    const instructions = unwrap(await controller.getWorkspaceInstructions());
    const session = { session_token: instructions.session_token, instruction_digest: instructions.guide_digest };
    const snapshot = adapter.getState();
    const manifest = snapshot.capabilityManifest as Record<string, JSONValue>;
    const hugeType = { typeId: "large-test-type", version: "1.0.0", digest: "test-digest", propsSchema: { description: "a".repeat(49_000) } };
    vi.spyOn(adapter, "getState").mockReturnValue({ ...snapshot, capabilityManifest: { ...manifest, component_types: [hugeType] } });
    expect(await controller.inspectWorkspaceCapabilities({ ...session, component_type_ids: ["large-test-type"] })).toMatchObject({ ok: false, error: { code: "capability_discovery_too_large", message: expect.stringContaining("capability_detail full") } });
    const full = unwrap(await controller.inspectWorkspace({ ...session, capability_detail: "full" }));
    expect(full.capability_manifest).toHaveProperty("component_types", [hugeType]);
  });

  it("never labels a stale manifest with a newer registry cache binding", async () => {
    const { controller, adapter } = fixture();
    const instructions = unwrap(await controller.getWorkspaceInstructions());
    const session = { session_token: instructions.session_token, instruction_digest: instructions.guide_digest };
    const snapshot = adapter.getState();
    const stale = { ...snapshot, capabilityManifest: { ...(snapshot.capabilityManifest as object), registry_digest: "stale-registry" } as JSONValue };
    const state = vi.spyOn(adapter, "getState").mockReturnValueOnce(stale);
    const result = unwrap(await controller.inspectWorkspaceCapabilities({ ...session, component_type_ids: ["button"] })) as Record<string, JSONValue>;
    expect(result.registry_digest).toBe(adapter.getRegistryDigest());
    expect(state).toHaveBeenCalledTimes(2);
    state.mockReturnValue(stale);
    expect(await controller.inspectWorkspaceCapabilities({ ...session, component_type_ids: ["button"] })).toMatchObject({ ok: false, error: { code: "workspace_busy" } });
  });

  it("keeps actual text+structured MCP responses and repeated prepares bounded while enforcing canonical operations", async () => {
    const { controller, store } = fixture();
    const server = createWorkspaceMcpServer(workspaceControllerMcpBackend(controller));
    const client = new Client({ name: "compact-discovery-check", version: "1" }, { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const resultData = (result: Awaited<ReturnType<typeof call>>) => unwrap(result.structuredContent as WorkspaceAgentResult<Record<string, unknown>>);
    try {
      const instructions = await call("get_workspace_instructions", {});
      expect(Buffer.byteLength(JSON.stringify(instructions))).toBeLessThan(24_000);
      const auth = resultData(instructions);
      const session = { session_token: auth.session_token, instruction_digest: auth.guide_digest };
      const listing = await client.listTools();
      expect(Buffer.byteLength(JSON.stringify(listing))).toBeLessThan(100_000);
      const submitDefinition = listing.tools.find(({ name }) => name === "submit_workspace_batch")!;
      expect(Buffer.byteLength(JSON.stringify(submitDefinition.inputSchema))).toBeLessThan(3_000);
      const inspection = await call("inspect_workspace", session);
      expect(Buffer.byteLength(JSON.stringify(inspection))).toBeLessThan(24_000);
      const discovery = resultData(await call("inspect_workspace_capabilities", { ...session, component_type_ids: ["button"], operation_names: ["create_component"] }));
      const manifests = discovery.component_types as Array<{ typeId: string; version: string; digest: string }>;
      const schemas = discovery.operation_schemas as Record<string, object>;
      const validate = new Ajv2020({ strict: true }).compile(schemas.create_component);
      for (let index = 0; index < 3; index += 1) {
        const preparedResponse = await call("begin_workspace_update", { ...session, intent: "Create one compact-discovery test button", requested_component_ids: 1 });
        expect(Buffer.byteLength(JSON.stringify(preparedResponse))).toBeLessThan(28_000);
        const preparation = resultData(preparedResponse);
        expect(preparation.capability_manifest).not.toHaveProperty("component_types.0.propsSchema");
        expect(preparation.layout_frame).toBe("canonical");
        expect(preparation).not.toHaveProperty("view_guard");
        expect(preparation.envelope).not.toHaveProperty("layout_frame");
        expect(preparation.envelope).not.toHaveProperty("view_guard");
        if (index !== 2) continue;
        const operation = {
          op: "create_component", op_id: "create_test_button", id: (preparation.reserved_component_ids as string[])[0],
          component_type: { typeId: manifests[0].typeId, version: manifests[0].version, digest: manifests[0].digest },
          props: { label: "Compact MCP" },
          placement: { space: "viewport", anchor: "top_left", offset: { x: 20, y: 80 }, size: { width: 180, height: 100 } },
        };
        expect(validate(operation), JSON.stringify(validate.errors)).toBe(true);
        const batch = { ...(preparation.envelope as object), operations: [operation] };
        const submitted = await call("submit_workspace_batch", { ...session, transaction_token: preparation.transaction_token, batch });
        expect(submitted).toMatchObject({ isError: false, structuredContent: { ok: true } });
        expect(store.getState().components.size).toBe(1);
        const revision = store.getState().revision;
        const malformed = { ...batch, operations: [{ ...operation, injected_unknown_field: true }] };
        expect(await call("submit_workspace_batch", { ...session, transaction_token: preparation.transaction_token, batch: malformed })).toMatchObject({ isError: true, structuredContent: { ok: false } });
        expect(store.getState().revision).toBe(revision);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
