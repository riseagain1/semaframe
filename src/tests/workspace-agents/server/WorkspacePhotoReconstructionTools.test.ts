import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
  beginWorkspacePhotoReconstructionInputSchema,
  cancelWorkspacePhotoReconstructionInputSchema,
  createWorkspaceMcpServer,
  finalizeWorkspacePhotoReconstructionInputSchema,
  inspectWorkspacePhotoReconstructionInputSchema,
  startWorkspacePhotoReconstructionInputSchema,
  type WorkspaceMcpBackend,
} from "../../../../server/workspace/WorkspaceMcpTools";
import {
  WorkspaceAgentController,
  WorkspaceStoreEngineAdapter,
} from "../../../workspace/agents";
import { WorkspaceStore } from "../../../workspace/state";

const SESSION = {
  session_token: "workspace-session-token",
  instruction_digest: "workspace-guide-digest",
} as const;
const WORKSPACE_ID = "workspace_main";
const JOB_ID = "00000000-0000-4000-8000-000000000001";

function photo(index: number, byteLength = 1_024) {
  return {
    photo_id: `photo_${index}`,
    media_type: "image/jpeg" as const,
    byte_length: byteLength,
    sha256: `sha256:${index.toString(16).padStart(64, "0")}`,
  };
}

const validBeginInput = {
  ...SESSION,
  request_id: "reconstruct-001",
  workspace_id: WORKSPACE_ID,
  profile: "balanced" as const,
  photos: [photo(1), photo(2)],
};

describe("Workspace photo reconstruction Agent contract", () => {
  it("does not let a reconstruction-only session complete an unattested arbitrary asset candidate", async () => {
    const store = new WorkspaceStore();
    const completeRealityAssetImport = vi.fn(async () => ({
      asset_ref: {
        asset_id: `ra_${"a".repeat(64)}`,
        digest: `sha256:${"a".repeat(64)}`,
      },
    }));
    const controller = new WorkspaceAgentController(new WorkspaceStoreEngineAdapter(store), {
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
      completeRealityAssetImport,
    });
    const instructions = await controller.getWorkspaceInstructions({
      client_id: "reconstruction-only-agent",
      requested_scopes: ["asset:reconstruct"],
    });
    if (!instructions.ok) throw new Error(instructions.error.message);

    const candidateHandle = "r".repeat(43);
    const completed = await controller.completeWorkspaceAssetImport({
      session_token: instructions.data.session_token,
      instruction_digest: instructions.data.guide_digest,
      candidate_handle: candidateHandle,
    });

    expect(completed).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        details: { missing_scopes: ["asset:import"] },
      },
    });
    expect(completeRealityAssetImport).not.toHaveBeenCalled();
  });

  it("keeps reconstruction non-default and authorizes every operation only for the exact Workspace", async () => {
    const store = new WorkspaceStore();
    const adapter = new WorkspaceStoreEngineAdapter(store);
    const controller = new WorkspaceAgentController(adapter, {
      grantScopes: ({ requestedScopes }) => [...requestedScopes],
    });

    const defaultInstructions = await controller.getWorkspaceInstructions({ client_id: "default-agent" });
    expect(defaultInstructions).toMatchObject({
      ok: true,
      data: { granted_scopes: expect.not.arrayContaining(["asset:reconstruct"]) },
    });
    if (!defaultInstructions.ok) throw new Error(defaultInstructions.error.message);
    expect(await controller.beginWorkspacePhotoReconstruction({
      ...validBeginInput,
      session_token: defaultInstructions.data.session_token,
      instruction_digest: defaultInstructions.data.guide_digest,
    })).toMatchObject({
      ok: false,
      error: { code: "permission_denied", details: { missing_scopes: ["asset:reconstruct"] } },
    });

    const instructions = await controller.getWorkspaceInstructions({
      client_id: "reconstruction-agent",
      requested_scopes: ["asset:reconstruct"],
    });
    if (!instructions.ok) throw new Error(instructions.error.message);
    const authorizedSession = {
      session_token: instructions.data.session_token,
      instruction_digest: instructions.data.guide_digest,
    };
    const expectedAuthorization = {
      ok: true,
      data: {
        client_id: "reconstruction-agent",
        workspace_id: WORKSPACE_ID,
        workspace_revision: 0,
      },
    };

    expect(await controller.beginWorkspacePhotoReconstruction({
      ...validBeginInput,
      ...authorizedSession,
    })).toMatchObject(expectedAuthorization);
    expect(await controller.startWorkspacePhotoReconstruction({
      ...authorizedSession,
      workspace_id: WORKSPACE_ID,
      job_id: JOB_ID,
    })).toMatchObject(expectedAuthorization);
    expect(await controller.inspectWorkspacePhotoReconstruction({
      ...authorizedSession,
      workspace_id: WORKSPACE_ID,
      job_id: JOB_ID,
    })).toMatchObject(expectedAuthorization);
    expect(await controller.cancelWorkspacePhotoReconstruction({
      ...authorizedSession,
      workspace_id: WORKSPACE_ID,
      job_id: JOB_ID,
      confirm: true,
    })).toMatchObject(expectedAuthorization);
    expect(await controller.finalizeWorkspacePhotoReconstruction({
      ...authorizedSession,
      workspace_id: WORKSPACE_ID,
      job_id: JOB_ID,
      display_name: "Courtyard capture",
      expected_output_sha256: `sha256:${"a".repeat(64)}`,
    })).toMatchObject(expectedAuthorization);

    expect(await controller.inspectWorkspacePhotoReconstruction({
      ...authorizedSession,
      workspace_id: "workspace_other",
      job_id: JOB_ID,
    })).toMatchObject({
      ok: false,
      error: { code: "workspace_id_mismatch", required_action: "inspect_workspace" },
    });
    expect(await controller.inspectWorkspacePhotoReconstruction({
      ...authorizedSession,
      workspace_id: WORKSPACE_ID,
      job_id: JOB_ID,
      unexpected: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("uses closed, bounded schemas and rejects duplicate content and unsafe finalization", () => {
    expect(beginWorkspacePhotoReconstructionInputSchema.safeParse(validBeginInput).success).toBe(true);
    expect(beginWorkspacePhotoReconstructionInputSchema.safeParse({
      ...validBeginInput,
      unexpected: true,
    }).success).toBe(false);
    expect(beginWorkspacePhotoReconstructionInputSchema.safeParse({
      ...validBeginInput,
      photos: [{ ...photo(1), unexpected: true }, photo(2)],
    }).success).toBe(false);
    expect(beginWorkspacePhotoReconstructionInputSchema.safeParse({
      ...validBeginInput,
      photos: [photo(1), { ...photo(2), sha256: photo(1).sha256 }],
    }).success).toBe(false);
    expect(beginWorkspacePhotoReconstructionInputSchema.safeParse({
      ...validBeginInput,
      photos: Array.from({ length: 33 }, (_, index) => photo(index + 1, 64 * 1024 * 1024)),
    }).success).toBe(false);

    const jobInput = { ...SESSION, workspace_id: WORKSPACE_ID, job_id: JOB_ID };
    expect(startWorkspacePhotoReconstructionInputSchema.safeParse(jobInput).success).toBe(true);
    expect(inspectWorkspacePhotoReconstructionInputSchema.safeParse(jobInput).success).toBe(true);
    expect(startWorkspacePhotoReconstructionInputSchema.safeParse({
      ...jobInput,
      job_id: "not-a-uuid",
    }).success).toBe(false);
    expect(cancelWorkspacePhotoReconstructionInputSchema.safeParse({
      ...jobInput,
      confirm: false,
    }).success).toBe(false);
    expect(finalizeWorkspacePhotoReconstructionInputSchema.safeParse({
      ...jobInput,
      display_name: "Capture",
      expected_output_sha256: "sha256:not-canonical",
    }).success).toBe(false);
  });

  it("advertises closed MCP schemas and routes all five operations through optional backend hooks", async () => {
    const dispatch = vi.fn<WorkspaceMcpBackend["dispatch"]>(async () => ({
      responseOk: false,
      status: 500,
      payload: { ok: false, error: { code: "unexpected_dispatch", message: "Unexpected fallback", retryable: false } },
    }));
    const hookResult = (hook: string) => ({
      responseOk: true,
      status: 200,
      payload: { ok: true, data: { hook } },
    });
    const backend = {
      dispatch,
      beginPhotoReconstruction: vi.fn(async () => hookResult("begin")),
      startPhotoReconstruction: vi.fn(async () => hookResult("start")),
      inspectPhotoReconstruction: vi.fn(async () => hookResult("inspect")),
      cancelPhotoReconstruction: vi.fn(async () => hookResult("cancel")),
      finalizePhotoReconstruction: vi.fn(async () => hookResult("finalize")),
    } satisfies WorkspaceMcpBackend;
    const server = createWorkspaceMcpServer(backend);
    const client = new Client(
      { name: "photo-reconstruction-contract-test", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const beginTool = tools.tools.find(({ name }) => name === "begin_workspace_photo_reconstruction");
      expect(beginTool?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: [
          "session_token", "instruction_digest", "request_id", "workspace_id", "profile", "photos",
        ],
        properties: {
          photos: {
            minItems: 2,
            maxItems: 400,
            items: { type: "object", additionalProperties: false },
          },
        },
      });
      expect(tools.tools.find(({ name }) => name === "cancel_workspace_photo_reconstruction")?.inputSchema)
        .toMatchObject({ type: "object", additionalProperties: false, properties: { confirm: { const: true } } });

      const jobInput = { ...SESSION, workspace_id: WORKSPACE_ID, job_id: JOB_ID };
      const calls = [
        ["begin_workspace_photo_reconstruction", validBeginInput, "begin"],
        ["start_workspace_photo_reconstruction", jobInput, "start"],
        ["inspect_workspace_photo_reconstruction", jobInput, "inspect"],
        ["cancel_workspace_photo_reconstruction", { ...jobInput, confirm: true }, "cancel"],
        ["finalize_workspace_photo_reconstruction", {
          ...jobInput,
          display_name: "Courtyard capture",
          expected_output_sha256: `sha256:${"a".repeat(64)}`,
        }, "finalize"],
      ] as const;
      for (const [name, argumentsValue, expectedHook] of calls) {
        const result = await client.callTool({ name, arguments: argumentsValue });
        expect(result.structuredContent).toEqual({ ok: true, data: { hook: expectedHook } });
      }
      expect(backend.beginPhotoReconstruction).toHaveBeenCalledTimes(1);
      expect(backend.startPhotoReconstruction).toHaveBeenCalledTimes(1);
      expect(backend.inspectPhotoReconstruction).toHaveBeenCalledTimes(1);
      expect(backend.cancelPhotoReconstruction).toHaveBeenCalledTimes(1);
      expect(backend.finalizePhotoReconstruction).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
