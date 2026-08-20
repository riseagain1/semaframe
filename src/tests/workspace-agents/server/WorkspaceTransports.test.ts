import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_REST_PATHS,
  createWorkspaceAgentRestHandler,
} from "../../../../server/workspace/WorkspaceAgentRestHandler";
import {
  createWorkspaceMcpServer,
  registerWorkspaceTools,
  workspaceControllerMcpBackend,
  type WorkspaceMcpBackend,
} from "../../../../server/workspace/WorkspaceMcpTools";
import type {
  WorkspaceAgentResult,
  WorkspaceAgentToolName,
} from "../../../workspace/agents/contracts";
import type { ZodType } from "zod/v4";

type RegisteredTool = {
  definition: Record<string, unknown>;
  handler: (input: Record<string, unknown>, context: ServerContext) => Promise<unknown>;
};

class RecordingMcpServer {
  readonly tools = new Map<string, RegisteredTool>();
  readonly resources = new Map<string, unknown>();

  registerTool(
    name: string,
    definition: Record<string, unknown>,
    handler: RegisteredTool["handler"],
  ): void {
    this.tools.set(name, { definition, handler });
  }

  registerResource(name: string, ...rest: unknown[]): void {
    this.resources.set(name, rest);
  }
}

const EXPECTED_WORKSPACE_TOOLS = [
  "begin_workspace_update",
  "get_workspace_instructions",
  "inspect_workspace",
  "inspect_workspace_component",
  "inspect_workspace_model",
  "inspect_workspace_physics",
  "inspect_workspace_space",
  "query_spatial_placement",
  "query_stable_placement",
  "read_workspace_events",
  "redo_workspace_batch",
  "simulate_workspace_physics",
  "submit_workspace_batch",
  "undo_workspace_batch",
];

describe("composable Workspace MCP tools", () => {
  it("registers all fourteen Workspace tools and its guide", async () => {
    const recorder = new RecordingMcpServer();
    const dispatch = vi.fn(async (name: WorkspaceAgentToolName, input: unknown) => ({
      responseOk: true,
      status: 200,
      payload: { ok: true, data: { name, input } },
    }));
    const backend: WorkspaceMcpBackend = { dispatch };

    const returned = registerWorkspaceTools(recorder as unknown as McpServer, backend);
    expect(returned).toBe(recorder);
    expect([...recorder.tools.keys()].sort()).toEqual(EXPECTED_WORKSPACE_TOOLS);
    expect(recorder.resources.has("workspace-controller-guide")).toBe(true);
    expect(EXPECTED_WORKSPACE_TOOLS.every(
      (name) => Boolean(recorder.tools.get(name)?.definition.outputSchema),
    )).toBe(true);

    const instructionInput = recorder.tools.get("get_workspace_instructions")
      ?.definition.inputSchema as ZodType | undefined;
    expect(instructionInput?.safeParse({
      client_id: "jarvis",
      approval_token: "a".repeat(43),
    }).success).toBe(true);
    expect(instructionInput?.safeParse({
      client_id: "jarvis",
      approval_token: "too-short",
    }).success).toBe(false);

    const componentInput = recorder.tools.get("inspect_workspace_component")
      ?.definition.inputSchema as ZodType | undefined;
    expect(componentInput?.safeParse({
      session_token: "workspace_session_1234567890",
      instruction_digest: "guide_digest_1234567890",
      component_id: "CMP_TARGET_061",
    }).success).toBe(true);
    expect(componentInput?.safeParse({
      session_token: "workspace_session_1234567890",
      instruction_digest: "guide_digest_1234567890",
      component_id: "bad component id",
    }).success).toBe(false);

    const spatialPlacementInput = recorder.tools.get("query_spatial_placement")
      ?.definition.inputSchema as ZodType | undefined;
    const exactParametricCandidate = {
      session_token: "workspace_session_1234567890",
      instruction_digest: "guide_digest_1234567890",
      candidate: {
        geometry: {
          kind: "capsule",
          radiusM: 0.25,
          cylinderHeightM: 1.5,
          axis: "z",
        },
        placement: {
          space: "world3d",
          position: { x: 1, y: 2, z: 3 },
          rotation: { x: 0, y: 0.25, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
    };
    expect(spatialPlacementInput?.safeParse(exactParametricCandidate).success).toBe(true);
    expect(spatialPlacementInput?.safeParse({
      ...exactParametricCandidate,
      candidate: {
        ...exactParametricCandidate.candidate,
        geometry: { kind: "capsule", radiusM: 0, cylinderHeightM: 1.5, axis: "z" },
      },
    }).success).toBe(false);
    expect(spatialPlacementInput?.safeParse({
      ...exactParametricCandidate,
      candidate: {
        ...exactParametricCandidate.candidate,
        geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 }, rendererScale: 2 },
      },
    }).success).toBe(false);
    expect(spatialPlacementInput?.safeParse({
      ...exactParametricCandidate,
      candidate: {
        ...exactParametricCandidate.candidate,
        geometry: { kind: "mesh", uri: "https://example.invalid/model.glb" },
      },
    }).success).toBe(false);

    const componentOutput = recorder.tools.get("inspect_workspace_component")
      ?.definition.outputSchema as ZodType | undefined;
    const validComponentOutput = {
      ok: true,
      data: {
        client_id: "jarvis",
        workspace_id: "workspace_main",
        workspace_revision: 7,
        registry_digest: "registry_digest",
        component: { id: "CMP_TARGET_061" },
        pinned_manifest: { typeId: "timer", version: "1.1.0", digest: "digest" },
        current_geometry: { kind: "box2d", size: { width: 210, height: 112 } },
        active_resize_policy: { kind: "box2d", mode: "free" },
        current_visual_effects: {
          opacity: 1,
          emissive: { color: "#FFFFFF", intensity: 0 },
          glow: { color: "#66CCFF", intensity: 0, spread: 0.35 },
        },
        visual_effects_policy: {
          opacity: { min: 0, max: 1 },
          emissiveIntensity: { min: 0, max: 8 },
          glowIntensity: { min: 0, max: 4 },
          glowSpread: { min: 0, max: 1 },
        },
        redacted_fields: [],
        state_truncated: false,
        omitted_state_bytes: 0,
        component_metadata_truncated: true,
        omitted_binding_count: 4,
        omitted_tag_count: 2,
        omitted_redacted_field_count: 1,
        manifest_truncated: false,
      },
    };
    expect(componentOutput?.safeParse(validComponentOutput).success).toBe(true);
    const { omitted_binding_count: _omitted, ...missingOmittedCount } = validComponentOutput.data;
    expect(componentOutput?.safeParse({
      ok: true,
      data: missingOmittedCount,
    }).success).toBe(false);

    const instructions = recorder.tools.get("get_workspace_instructions")!;
    const result = await instructions.handler(
      { client_id: "jarvis", client_name: "JARVIS" },
      {} as ServerContext,
    ) as { structuredContent: WorkspaceAgentResult<{ name: string }>; content: Array<{ type: string; uri?: string }> };
    expect(dispatch).toHaveBeenCalledWith(
      "get_workspace_instructions",
      { client_id: "jarvis", client_name: "JARVIS" },
      expect.objectContaining({ clientId: "jarvis", clientName: "JARVIS" }),
    );
    expect(result.structuredContent).toMatchObject({ ok: true, data: { name: "get_workspace_instructions" } });
    expect(result.content).toContainEqual(expect.objectContaining({
      type: "resource_link",
      uri: "workspace://instructions/v1",
    }));
  });

  it("advertises and enforces the complete canonical WorkspaceCommandBatch schema", async () => {
    const dispatch = vi.fn(async (name: WorkspaceAgentToolName, input: unknown) => ({
      responseOk: true,
      status: 200,
      payload: { ok: true, data: { name, input } },
    }));
    const server = createWorkspaceMcpServer({ dispatch });
    const client = new Client(
      { name: "workspace-schema-test", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getInstructions()).toContain(
        "set instruction_digest to the exact get_workspace_instructions.data.guide_digest value",
      );
      expect(client.getInstructions()).toContain(
        "first call inspect_workspace, then call begin_workspace_update",
      );
      expect(client.getInstructions()).toContain("Copy begin_workspace_update.data.envelope unchanged");
      expect(client.getInstructions()).toContain("reserved_component_ids");
      expect(client.getInstructions()).toContain("exact typeId/version/digest tuple");
      expect(client.getInstructions()).toContain("submit_workspace_batch");

      const tools = await client.listTools();
      const submit = tools.tools.find(({ name }) => name === "submit_workspace_batch");
      expect(submit).toBeDefined();
      const inputSchema = submit?.inputSchema as Record<string, unknown>;
      expect(inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["session_token", "instruction_digest", "transaction_token", "batch"],
        properties: {
          session_token: { type: "string", minLength: 8, maxLength: 256 },
          instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
          transaction_token: { type: "string", minLength: 8, maxLength: 256 },
          batch: { $ref: "#/$defs/workspaceCommandBatch" },
        },
      });
      const definitions = inputSchema.$defs as Record<string, Record<string, unknown>>;
      expect(definitions.workspaceCommandBatch).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: [
          "protocol_version",
          "request_id",
          "workspace_id",
          "input_revision",
          "base_workspace_revision",
          "registry_digest",
          "mode",
          "operations",
        ],
      });
      expect(definitions.operation).toMatchObject({
        oneOf: expect.arrayContaining([{ $ref: "#/$defs/createComponent" }]),
      });
      expect(definitions.createComponent).toMatchObject({
        required: ["op", "op_id", "id", "component_type", "placement"],
        properties: {
          op: { const: "create_component" },
          component_type: { $ref: "#/$defs/componentType" },
          placement: { $ref: "#/$defs/placement" },
        },
      });

      const validInput = {
        session_token: "session_12345678",
        instruction_digest: "digest_12345678",
        transaction_token: "transaction_12345678",
        batch: {
          protocol_version: "1.1",
          request_id: "request_1",
          workspace_id: "workspace_main",
          input_revision: 1,
          base_workspace_revision: 0,
          registry_digest: "registry_digest_v1",
          mode: "commit",
          operations: [{
            op: "create_component",
            op_id: "create_timer",
            id: "CMP_TIMER",
            component_type: { typeId: "timer", version: "1.1.0", digest: "timer_digest" },
            placement: {
              space: "viewport",
              anchor: "center",
              offset: { x: 0, y: 0 },
            },
          }],
        },
      };
      const { component_type: _componentType, ...invalidOperation } = validInput.batch.operations[0]!;
      const invalidComponent = {
        ...validInput,
        batch: {
          ...validInput.batch,
          operations: [invalidOperation],
        },
      };
      expect(await client.callTool({
        name: "submit_workspace_batch",
        arguments: invalidComponent,
      })).toMatchObject({ isError: true });
      expect(dispatch).not.toHaveBeenCalled();

      expect(await client.callTool({
        name: "submit_workspace_batch",
        arguments: { ...validInput, session_token: "1234567" },
      })).toMatchObject({ isError: true });
      expect(dispatch).not.toHaveBeenCalled();

      expect(await client.callTool({
        name: "submit_workspace_batch",
        arguments: validInput,
      })).toMatchObject({
        isError: false,
        structuredContent: { ok: true },
      });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith(
        "submit_workspace_batch",
        validInput,
        expect.objectContaining({ protocolEra: "legacy" }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("adapts the controller's structured errors to transport statuses", async () => {
    const backend = workspaceControllerMcpBackend({
      async dispatch(): Promise<WorkspaceAgentResult<unknown>> {
        return {
          ok: false,
          error: {
            code: "destructive_permission_required",
            message: "approval required",
            retryable: false,
          },
        };
      },
    });
    expect(await backend.dispatch("submit_workspace_batch", {}, { protocolEra: "modern" })).toEqual({
      responseOk: false,
      status: 403,
      payload: {
        ok: false,
        error: {
          code: "destructive_permission_required",
          message: "approval required",
          retryable: false,
        },
      },
    });
  });
});

describe("Workspace REST adapter", () => {
  it("requires transport authentication before it dispatches instruction sessions", async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, data: {} }));
    const handler = createWorkspaceAgentRestHandler(
      { dispatch },
      { authenticate: () => false },
    );
    const response = await handler(new Request(
      `http://localhost${WORKSPACE_REST_PATHS.get_workspace_instructions}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ));
    expect(response.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches exact paths over the same structured controller and maps stale results to 409", async () => {
    const dispatch = vi.fn(async (name: unknown, input: unknown): Promise<WorkspaceAgentResult<unknown>> => {
      if (name === "submit_workspace_batch") {
        return {
          ok: false,
          error: {
            code: "stale_workspace_revision",
            message: "stale",
            retryable: true,
            required_action: "begin_workspace_update",
          },
        };
      }
      return { ok: true, data: { name, input } };
    });
    const handler = createWorkspaceAgentRestHandler(
      { dispatch },
      { authenticate: (request) => request.headers.get("authorization") === "Bearer paired" },
    );
    const response = await handler(new Request(
      `http://localhost${WORKSPACE_REST_PATHS.submit_workspace_batch}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer paired",
        },
        body: JSON.stringify({ transaction_token: "tx", batch: {} }),
      },
    ));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "stale_workspace_revision" } });
    expect(dispatch).toHaveBeenCalledWith("submit_workspace_batch", {
      transaction_token: "tx",
      batch: {},
    });

    const targeted = await handler(new Request(
      `http://localhost${WORKSPACE_REST_PATHS.inspect_workspace_component}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer paired",
        },
        body: JSON.stringify({
          session_token: "workspace_session_1234567890",
          instruction_digest: "guide_digest_1234567890",
          component_id: "CMP_TARGET_061",
        }),
      },
    ));
    expect(targeted.status).toBe(200);
    expect(dispatch).toHaveBeenCalledWith("inspect_workspace_component", {
      session_token: "workspace_session_1234567890",
      instruction_digest: "guide_digest_1234567890",
      component_id: "CMP_TARGET_061",
    });
  });

  it("rejects wrong media types and oversized bodies before controller dispatch", async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, data: {} }));
    const handler = createWorkspaceAgentRestHandler(
      { dispatch },
      { authenticate: () => true, bodyLimitBytes: 8 },
    );
    const wrongMedia = await handler(new Request(
      `http://localhost${WORKSPACE_REST_PATHS.inspect_workspace}`,
      { method: "POST", body: "{}" },
    ));
    expect(wrongMedia.status).toBe(400);

    const oversized = await handler(new Request(
      `http://localhost${WORKSPACE_REST_PATHS.inspect_workspace}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ too_big: "xxxxxxxx" }),
      },
    ));
    expect(oversized.status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
