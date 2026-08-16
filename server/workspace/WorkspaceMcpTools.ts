import {
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  WORKSPACE_AGENT_GUIDE,
  WORKSPACE_PERMISSION_SCOPES,
  type WorkspaceAgentResult,
  type WorkspaceAgentToolName,
  type WorkspacePermissionScope,
} from "../../src/workspace/agents";
import {
  workspaceProtocolSchema,
  type WorkspaceCommandBatch,
} from "../../src/workspace/protocol";

export const WORKSPACE_MCP_SERVER_INFO = Object.freeze({
  name: "semaframe-workspace-engine",
  version: "1.6.0",
});

export type WorkspaceMcpBackendResult = Readonly<{
  responseOk: boolean;
  status: number;
  payload: unknown;
}>;

export type WorkspaceMcpClientContext = Readonly<{
  clientId?: string;
  clientName?: string;
  protocolEra: "legacy" | "modern";
}>;

export interface WorkspaceMcpBackend {
  dispatch(
    name: WorkspaceAgentToolName,
    input: unknown,
    client: WorkspaceMcpClientContext,
  ): Promise<WorkspaceMcpBackendResult>;
}

export type RegisterWorkspaceToolsOptions = Readonly<{
  protocolEra?: "legacy" | "modern";
  registerGuideResource?: boolean;
}>;

const requiredActionSchema = z.enum([
  "get_workspace_instructions",
  "inspect_workspace",
  "inspect_workspace_component",
  "inspect_workspace_space",
  "query_spatial_placement",
  "inspect_workspace_physics",
  "query_stable_placement",
  "simulate_workspace_physics",
  "begin_workspace_update",
  "submit_workspace_batch",
  "undo_workspace_batch",
  "redo_workspace_batch",
  "read_workspace_events",
  "request_user_approval",
]);

const workspaceAgentErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  required_action: requiredActionSchema.optional(),
  details: z.unknown().optional(),
});

export const workspaceMcpResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: workspaceAgentErrorSchema }),
]);

export const workspaceComponentInspectionDataSchema = z.strictObject({
  client_id: z.string(),
  client_name: z.string().optional(),
  workspace_id: z.string(),
  workspace_revision: z.number().int().nonnegative(),
  registry_digest: z.string(),
  component: z.unknown(),
  pinned_manifest: z.unknown(),
  current_geometry: z.unknown(),
  active_resize_policy: z.unknown(),
  current_visual_effects: z.unknown(),
  visual_effects_policy: z.unknown(),
  redacted_fields: z.array(z.string()),
  state_truncated: z.boolean(),
  omitted_state_bytes: z.number().int().nonnegative(),
  component_metadata_truncated: z.boolean(),
  omitted_binding_count: z.number().int().nonnegative(),
  omitted_tag_count: z.number().int().nonnegative(),
  omitted_redacted_field_count: z.number().int().nonnegative(),
  manifest_truncated: z.literal(false),
});

export const workspaceComponentInspectionMcpResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: workspaceComponentInspectionDataSchema }),
  z.strictObject({ ok: z.literal(false), error: workspaceAgentErrorSchema }),
]);

function normalizeResult(result: WorkspaceMcpBackendResult): z.infer<typeof workspaceMcpResultSchema> {
  const parsed = workspaceMcpResultSchema.safeParse(result.payload);
  if (parsed.success) return parsed.data;
  return {
    ok: false,
    error: {
      code: "gateway_error",
      message: `The Workspace gateway returned an invalid result (${result.status}).`,
      retryable: false,
    },
  };
}

function clientContext(
  identity: { client_id?: string; client_name?: string },
  _context: ServerContext,
  protocolEra: "legacy" | "modern",
): WorkspaceMcpClientContext {
  return {
    ...(identity.client_id ? { clientId: identity.client_id } : {}),
    ...(identity.client_name ? { clientName: identity.client_name } : {}),
    protocolEra,
  };
}

function toolResult(name: WorkspaceAgentToolName, result: WorkspaceMcpBackendResult) {
  const structuredContent = normalizeResult(result);
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) },
      ...(name === "get_workspace_instructions" ? [{
        type: "resource_link" as const,
        uri: "workspace://instructions/v1",
        name: "SemaFrame Workspace controller guide",
        description: "Canonical complete instructions for the universal component workspace.",
        mimeType: "application/json",
      }] : []),
    ],
    structuredContent,
    isError: !result.responseOk || structuredContent.ok === false,
  };
}

function componentInspectionToolResult(result: WorkspaceMcpBackendResult) {
  const generic = normalizeResult(result);
  const parsed = workspaceComponentInspectionMcpResultSchema.safeParse(generic);
  const structuredContent: z.infer<typeof workspaceComponentInspectionMcpResultSchema> = parsed.success
    ? parsed.data
    : {
        ok: false,
        error: {
          code: "gateway_error",
          message: "The Workspace gateway returned an invalid component inspection result.",
          retryable: false,
        },
      };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: !result.responseOk || structuredContent.ok === false,
  };
}

const sessionFields = {
  session_token: z.string().min(8).max(256),
  instruction_digest: z.string().min(8).max(256),
};

type SubmitWorkspaceBatchInput = Readonly<{
  session_token: string;
  instruction_digest: string;
  transaction_token: string;
  batch: WorkspaceCommandBatch;
}>;

const {
  $schema: workspaceSchemaDialect,
  $id: _workspaceSchemaId,
  title: _workspaceSchemaTitle,
  $defs: workspaceSchemaDefs,
  ...workspaceCommandBatchDefinition
} = workspaceProtocolSchema;

/**
 * Keep the transport advertisement and runtime validation on the canonical
 * Protocol 1.2 schema. Nesting the batch behind a local definition preserves
 * every operation definition and its root-relative references in tools/list.
 */
const submitWorkspaceBatchInputSchema = fromJsonSchema<SubmitWorkspaceBatchInput>({
  $schema: workspaceSchemaDialect,
  type: "object",
  additionalProperties: false,
  required: ["session_token", "instruction_digest", "transaction_token", "batch"],
  properties: {
    session_token: { type: "string", minLength: 8, maxLength: 256 },
    instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
    transaction_token: { type: "string", minLength: 8, maxLength: 256 },
    batch: { $ref: "#/$defs/workspaceCommandBatch" },
  },
  $defs: {
    ...workspaceSchemaDefs,
    workspaceCommandBatch: workspaceCommandBatchDefinition,
  },
} as unknown as JsonSchemaType);

/**
 * Adds all Workspace tools to any MCP server. This is the integration point for
 * the existing SemaFrame offer: call this on the same McpServer before its
 * transport connects, using the same gateway-backed dispatcher.
 */
export function registerWorkspaceTools(
  server: McpServer,
  backend: WorkspaceMcpBackend,
  options: RegisterWorkspaceToolsOptions = {},
): McpServer {
  const protocolEra = options.protocolEra ?? "legacy";
  if (options.registerGuideResource !== false) {
    server.registerResource(
      "workspace-controller-guide",
      "workspace://instructions/v1",
      { title: "SemaFrame Workspace controller guide", mimeType: "application/json" },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(WORKSPACE_AGENT_GUIDE, null, 2),
        }],
      }),
    );
  }

  server.registerTool(
    "get_workspace_instructions",
    {
      title: "Get required Workspace instructions",
      description: "Mandatory first call for universal component Workspace tools. Returns the canonical guide, session capability, digest, and granted permission scopes.",
      inputSchema: z.strictObject({
        client_id: z.string().min(1).max(128).optional(),
        client_name: z.string().min(1).max(160).optional(),
        requested_scopes: z.array(z.enum(WORKSPACE_PERMISSION_SCOPES)).max(20).optional(),
        // Transport-only claim proof for the public connection offer. The
        // gateway consumes it before dispatch and never forwards it to the
        // browser controller or canonical instruction DTO.
        approval_token: z.string().min(32).max(256).optional(),
      }),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "get_workspace_instructions",
      await backend.dispatch(
        "get_workspace_instructions",
        input,
        clientContext(input, context, protocolEra),
      ),
    ),
  );

  server.registerTool(
    "inspect_workspace",
    {
      title: "Inspect authoritative Workspace state",
      description: "Reads a bounded Workspace summary, revision, registry digest, and component capability manifest without reserving IDs or mutating state.",
      inputSchema: z.strictObject(sessionFields),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "inspect_workspace",
      await backend.dispatch("inspect_workspace", input, clientContext({}, context, protocolEra)),
    ),
  );

  server.registerTool(
    "inspect_workspace_component",
    {
      title: "Inspect one authoritative Workspace component",
      description: "Reads one component by ID with exact identity, revision, locks, current geometry, active resize policy, and its full pinned public manifest. The complete result is capped at 1,048,576 encoded bytes; oversized public state and binding/tag/redaction-path metadata are compacted with explicit truncation and omitted-count fields. Use this when the bounded workspace summary omits the target.",
      inputSchema: z.strictObject({
        ...sessionFields,
        component_id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/u),
      }),
      outputSchema: workspaceComponentInspectionMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => componentInspectionToolResult(
      await backend.dispatch("inspect_workspace_component", input, clientContext({}, context, protocolEra)),
    ),
  );

  server.registerTool(
    "inspect_workspace_space",
    {
      title: "Inspect Universal Space Data",
      description: "Reads the authoritative derived 3D spatial graph with world transforms, asset-derived bounds, collision volumes, hierarchy, support/intersection relations, and optional revision deltas. This is the model-facing Universal Space Data view, not a second persisted scene authority.",
      inputSchema: z.strictObject({
        ...sessionFields,
        since_revision: z.number().int().nonnegative().optional(),
      }),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "inspect_workspace_space",
      await backend.dispatch("inspect_workspace_space", input, clientContext({}, context, protocolEra)),
    ),
  );

  const spatialVectorSchema = z.strictObject({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  });
  const collisionBase = {
    enabled: z.boolean(),
    role: z.enum(["solid", "trigger", "none"]),
    margin: z.number().min(0).max(10),
  };
  const spatialCollisionSchema = z.discriminatedUnion("shape", [
    z.strictObject({ ...collisionBase, shape: z.literal("asset_bounds") }),
    z.strictObject({
      ...collisionBase,
      shape: z.literal("box"),
      center: spatialVectorSchema,
      size: z.strictObject({
        x: z.number().positive().max(1_000),
        y: z.number().positive().max(1_000),
        z: z.number().positive().max(1_000),
      }),
    }),
    z.strictObject({
      ...collisionBase,
      shape: z.literal("compound"),
      parts: z.array(z.strictObject({
        id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
        center: spatialVectorSchema,
        size: z.strictObject({
          x: z.number().positive().max(1_000),
          y: z.number().positive().max(1_000),
          z: z.number().positive().max(1_000),
        }),
        rotation: spatialVectorSchema,
      })).min(1).max(16),
    }),
  ]);
  const physicsConstraintSchema = z.strictObject({
    id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/u),
    type: z.enum(["fixed", "hinge", "slider", "ball"]),
    targetId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/u),
    anchor: spatialVectorSchema,
    targetAnchor: spatialVectorSchema,
    axis: z.strictObject({
      x: z.number().min(-1).max(1),
      y: z.number().min(-1).max(1),
      z: z.number().min(-1).max(1),
    }),
    limits: z.strictObject({ min: z.number().min(-1_000_000).max(1_000_000), max: z.number().min(-1_000_000).max(1_000_000) }).optional(),
    enabled: z.boolean(),
  });
  const spatialPhysicsSchema = z.strictObject({
    enabled: z.boolean(),
    bodyType: z.enum(["static", "dynamic", "kinematic"]),
    massKg: z.number().min(0.001).max(1_000_000),
    centerOfMass: spatialVectorSchema,
    friction: z.number().min(0).max(2),
    restitution: z.number().min(0).max(1),
    gravityScale: z.number().min(0).max(10),
    stabilityMode: z.enum(["report", "enforce"]),
    constraints: z.array(physicsConstraintSchema).max(16),
  });
  const spatialCandidateSchema = z.strictObject({
    component_id: z.string().min(1).max(256).optional(),
    asset_id: z.string().min(1).max(256).optional(),
    entity_kind: z.enum(["character", "animal", "prop", "structure", "effect", "primitive"]).optional(),
    placement: z.strictObject({
      space: z.literal("world3d"),
      position: spatialVectorSchema,
      rotation: spatialVectorSchema,
      scale: spatialVectorSchema,
    }),
    collision: spatialCollisionSchema.optional(),
    physics: spatialPhysicsSchema.optional(),
  });
  server.registerTool(
    "query_spatial_placement",
    {
      title: "Preflight a collision-aware 3D placement",
      description: "Checks a proposed new or existing spatial entity placement against authoritative asset-bound, explicit-box, or compound colliders without mutating the Workspace. Returns conflicts and deterministic nearby placement suggestions.",
      inputSchema: z.strictObject({
        ...sessionFields,
        candidate: spatialCandidateSchema,
      }),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "query_spatial_placement",
      await backend.dispatch("query_spatial_placement", input, clientContext({}, context, protocolEra)),
    ),
  );

  server.registerTool(
    "inspect_workspace_physics",
    {
      title: "Inspect Workspace physics feasibility",
      description: "Returns Physics 2.0 quasi-static feasibility: exact horizontal OBB/compound contacts, finite-Stage contact, recursive grounded load paths, world center of mass, conservative joint equilibrium, collisions, and issues without mutation.",
      inputSchema: z.strictObject({
        ...sessionFields,
        component_ids: z.array(z.string().min(1).max(256)).max(100).optional(),
      }),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "inspect_workspace_physics",
      await backend.dispatch("inspect_workspace_physics", input, clientContext({}, context, protocolEra)),
    ),
  );

  server.registerTool(
    "query_stable_placement",
    {
      title: "Preflight a stable physical placement",
      description: "Checks a proposed spatial placement against collision, finite-Stage bounds, grounded support, constraints, and center-of-mass stability, returning deterministic corrections without mutation.",
      inputSchema: z.strictObject({ ...sessionFields, candidate: spatialCandidateSchema }),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "query_stable_placement",
      await backend.dispatch("query_stable_placement", input, clientContext({}, context, protocolEra)),
    ),
  );

  server.registerTool(
    "simulate_workspace_physics",
    {
      title: "Preview a deterministic vertical physics settle",
      description: "Runs a bounded fixed-step, non-mutating vertical drop preview and returns exact placement proposals plus the post-settle report. The result declares ignored mass/friction/restitution/angular properties; this is not a general dynamics engine.",
      inputSchema: z.strictObject({
        ...sessionFields,
        component_ids: z.array(z.string().min(1).max(256)).max(100).optional(),
        duration_ms: z.number().int().min(0).max(5_000).optional(),
        time_step_ms: z.number().int().min(4).max(100).optional(),
      }),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "simulate_workspace_physics",
      await backend.dispatch("simulate_workspace_physics", input, clientContext({}, context, protocolEra)),
    ),
  );

  server.registerTool(
    "begin_workspace_update",
    {
      title: "Begin an atomic Workspace update",
      description: "Prepares a revision- and component-registry-bound transaction and returns the exact envelope, reserved component IDs, summary, and capabilities.",
      inputSchema: z.strictObject({
        ...sessionFields,
        intent: z.string().min(1).max(4_000),
        requested_component_ids: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "begin_workspace_update",
      await backend.dispatch("begin_workspace_update", input, clientContext({}, context, protocolEra)),
    ),
  );

  server.registerTool(
    "submit_workspace_batch",
    {
      title: "Submit an atomic Workspace batch",
      description: "Validates and commits exactly one prepared WorkspaceCommandBatch. Identical retries are idempotent; changed retries and stale revisions fail closed.",
      inputSchema: submitWorkspaceBatchInputSchema,
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "submit_workspace_batch",
      await backend.dispatch("submit_workspace_batch", input, clientContext({}, context, protocolEra)),
    ),
  );

  const historySchema = z.strictObject({
    ...sessionFields,
    expected_workspace_revision: z.number().int().nonnegative(),
  });
  server.registerTool(
    "undo_workspace_batch",
    {
      title: "Undo the latest Workspace batch",
      description: "Undoes one complete Workspace batch through the serialized mutation lane at an exact expected revision.",
      inputSchema: historySchema,
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "undo_workspace_batch",
      await backend.dispatch("undo_workspace_batch", input, clientContext({}, context, protocolEra)),
    ),
  );
  server.registerTool(
    "redo_workspace_batch",
    {
      title: "Redo the latest Workspace batch",
      description: "Redoes one complete Workspace batch through the serialized mutation lane at an exact expected revision.",
      inputSchema: historySchema,
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "redo_workspace_batch",
      await backend.dispatch("redo_workspace_batch", input, clientContext({}, context, protocolEra)),
    ),
  );

  server.registerTool(
    "read_workspace_events",
    {
      title: "Read semantic Workspace events",
      description: "Reads an ordered bounded page of at-least-once semantic events. Resume with next_cursor and deduplicate by event id.",
      inputSchema: z.strictObject({
        ...sessionFields,
        after_cursor: z.string().min(1).max(256).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: workspaceMcpResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => toolResult(
      "read_workspace_events",
      await backend.dispatch("read_workspace_events", input, clientContext({}, context, protocolEra)),
    ),
  );

  return server;
}

export function createWorkspaceMcpServer(
  backend: WorkspaceMcpBackend,
  options: RegisterWorkspaceToolsOptions = {},
): McpServer {
  const server = new McpServer(WORKSPACE_MCP_SERVER_INFO, {
    instructions: [
      "Call get_workspace_instructions before every other Workspace tool.",
      "For every later Workspace tool input, set instruction_digest to the exact get_workspace_instructions.data.guide_digest value; never send a later field named guide_digest.",
      "To create a component, first call inspect_workspace, then call begin_workspace_update.",
      "Copy begin_workspace_update.data.envelope unchanged, use one of its reserved_component_ids, and copy the exact typeId/version/digest tuple for the chosen type from its capability_manifest.component_types.",
      "Submit those exact fields plus the create_component operation through submit_workspace_batch with the returned transaction_token.",
      "Use inspect_workspace_component when a target is omitted from the bounded summary, and inspect exact current geometry and resize policy before any absolute resize_component operation.",
      "Before spatial creation or movement, inspect Universal Space Data and preflight collision plus physical stability. inspect_workspace_physics reports support, center of mass, constraints, and feasibility; simulate_workspace_physics returns non-mutating settle proposals.",
      "For a data-backed chart, use data_interaction_quickstart: create an inline.snapshot@1.0.0 resource and bind $.labels and $.series in snapshot mode.",
      "For 2D and 3D interaction, connect declared semantic events to declared actions; button.pressed can invoke spatial play_animation, and spatial.activated can invoke a window visibility action.",
      "Copy exact asset IDs and supported animation clips from capability_manifest.asset_library; never guess them.",
      "All external controllers use the same Workspace agent controls. Realtime partials are client-side previews only; final mutations use begin_workspace_update then submit_workspace_batch.",
    ].join(" "),
  });
  return registerWorkspaceTools(server, backend, options);
}

/** Adapts the transport-neutral core controller to MCP's status wrapper. */
export function workspaceControllerMcpBackend(controller: {
  dispatch(name: unknown, input: unknown): Promise<WorkspaceAgentResult<unknown>>;
}): WorkspaceMcpBackend {
  return {
    async dispatch(name, input) {
      const payload = await controller.dispatch(name, input);
      return {
        responseOk: payload.ok,
        status: payload.ok ? 200 : statusForCode(payload.error.code),
        payload,
      };
    },
  };
}

function statusForCode(code: string): number {
  if (code === "instructions_required" || code === "session_expired") return 401;
  if (code === "instruction_digest_mismatch" || code === "permission_denied" || code === "destructive_permission_required") return 403;
  if (/stale|transaction|retry_mismatch|envelope_mismatch/u.test(code)) return 409;
  if (/invalid|validation|unsupported/u.test(code)) return 422;
  return 500;
}

export type { WorkspacePermissionScope };
