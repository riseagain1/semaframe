import workspaceProtocolSchema from "../../src/workspace/protocol/workspaceProtocol.schema.json";
import { WORKSPACE_PERMISSION_SCOPES } from "../../src/workspace/agents/contracts";

const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
    },
  },
} as const;

const agentControlErrorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "retryable"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    retryable: { type: "boolean" },
    required_action: {
      type: "string",
      enum: [
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
      ],
    },
    validation_errors: { type: "array", items: {} },
    details: { type: "object" },
  },
} as const;

const agentResultSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["ok", "data"],
      properties: { ok: { const: true }, data: {} },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["ok", "error"],
      properties: {
        ok: { const: false },
        error: { $ref: "#/components/schemas/AgentControlError" },
      },
    },
  ],
} as const;

const inspectWorkspaceComponentDataSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "client_id",
    "workspace_id",
    "workspace_revision",
    "registry_digest",
    "component",
    "pinned_manifest",
    "current_geometry",
    "active_resize_policy",
    "current_visual_effects",
    "visual_effects_policy",
    "redacted_fields",
    "state_truncated",
    "omitted_state_bytes",
    "component_metadata_truncated",
    "omitted_binding_count",
    "omitted_tag_count",
    "omitted_redacted_field_count",
    "manifest_truncated",
  ],
  properties: {
    client_id: { type: "string" },
    client_name: { type: "string" },
    workspace_id: { type: "string" },
    workspace_revision: { type: "integer", minimum: 0 },
    registry_digest: { type: "string" },
    component: {},
    pinned_manifest: {},
    current_geometry: {},
    active_resize_policy: {},
    current_visual_effects: {},
    visual_effects_policy: {},
    redacted_fields: { type: "array", items: { type: "string" } },
    state_truncated: { type: "boolean" },
    omitted_state_bytes: { type: "integer", minimum: 0 },
    component_metadata_truncated: { type: "boolean" },
    omitted_binding_count: { type: "integer", minimum: 0 },
    omitted_tag_count: { type: "integer", minimum: 0 },
    omitted_redacted_field_count: { type: "integer", minimum: 0 },
    manifest_truncated: { const: false },
  },
} as const;

const inspectWorkspaceComponentResultSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["ok", "data"],
      properties: {
        ok: { const: true },
        data: { $ref: "#/components/schemas/InspectWorkspaceComponentData" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["ok", "error"],
      properties: {
        ok: { const: false },
        error: { $ref: "#/components/schemas/AgentControlError" },
      },
    },
  ],
} as const;

const successResponses = {
  "200": {
    description: "The browser-authoritative Workspace completed the command.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/AgentResult" } } },
  },
  "400": {
    description: "The request wrapper is invalid.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "401": {
    description: "The pairing bearer is missing or invalid.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "409": {
    description: "The engine is busy or the Workspace context is stale.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "413": {
    description: "The bounded request body is too large.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "415": {
    description: "The request body is not application/json.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "422": {
    description: "The Workspace command failed engine validation.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "503": {
    description: "Agent control or the browser engine is unavailable.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "504": {
    description: "The browser engine did not complete in time.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
} as const;

const inspectWorkspaceComponentResponses = {
  ...successResponses,
  "200": {
    description: "The browser-authoritative Workspace returned the bounded component inspection.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/InspectWorkspaceComponentResult" },
      },
    },
  },
} as const;

function jsonBody(schema: unknown) {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

export function createAgentGatewayOpenApi(publicBaseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "SemaFrame Agent Gateway",
      version: "1.0.0",
      description: "Provider-neutral control of the browser-authoritative universal Workspace. Obtain the ephemeral bearer from the in-app agent setup; never place it in a URL.",
    },
    servers: [{ url: `${publicBaseUrl.replace(/\/$/u, "")}/v1` }],
    security: [{ PairingBearer: [] }],
    paths: {
      "/workspace/instructions": {
        post: {
          operationId: "get_workspace_instructions",
          summary: "Receive the required universal Workspace guide and open a scoped client session.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            properties: {
              client_id: { type: "string", minLength: 1, maxLength: 128 },
              client_name: { type: "string", minLength: 1, maxLength: 160 },
              requested_scopes: {
                type: "array",
                maxItems: 20,
                uniqueItems: true,
                items: { enum: WORKSPACE_PERMISSION_SCOPES },
              },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/inspect": {
        post: {
          operationId: "inspect_workspace",
          summary: "Inspect bounded authoritative component, resource, and capability state.",
          requestBody: jsonBody({ $ref: "#/components/schemas/WorkspaceSession" }),
          responses: successResponses,
        },
      },
      "/workspace/components/inspect": {
        post: {
          operationId: "inspect_workspace_component",
          summary: "Inspect one exact component, its pinned manifest, and authoritative resize state by ID.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "component_id"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              component_id: {
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$",
              },
            },
          }),
          responses: inspectWorkspaceComponentResponses,
        },
      },
      "/workspace/space/inspect": {
        post: {
          operationId: "inspect_workspace_space",
          summary: "Inspect derived Universal Space Data with world transforms, bounds, collisions, and relations.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              since_revision: { type: "integer", minimum: 0 },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/space/query": {
        post: {
          operationId: "query_spatial_placement",
          summary: "Preflight an asset-bound, explicit-box, or compound collision-aware world3d placement without mutation.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "candidate"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              candidate: { type: "object" },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/physics/inspect": {
        post: {
          operationId: "inspect_workspace_physics",
          summary: "Inspect deterministic rigid-body, support, stability, collision, and constraint feasibility.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              component_ids: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 256 } },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/physics/placement/query": {
        post: {
          operationId: "query_stable_placement",
          summary: "Preflight collision and center-of-mass stability for a world3d placement without mutation.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "candidate"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              candidate: { type: "object" },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/physics/simulate": {
        post: {
          operationId: "simulate_workspace_physics",
          summary: "Run a bounded non-mutating deterministic gravity settle and return placement proposals.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              component_ids: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 256 } },
              duration_ms: { type: "integer", minimum: 0, maximum: 5_000 },
              time_step_ms: { type: "integer", minimum: 4, maximum: 100 },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/updates/begin": {
        post: {
          operationId: "begin_workspace_update",
          summary: "Prepare one revision- and registry-bound Workspace transaction.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "intent"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              intent: { type: "string", minLength: 1, maxLength: 4_000 },
              requested_component_ids: { type: "integer", minimum: 1, maximum: 100 },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/updates/submit": {
        post: {
          operationId: "submit_workspace_batch",
          summary: "Validate and atomically commit one canonical WorkspaceCommandBatch.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "transaction_token", "batch"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              transaction_token: { type: "string", minLength: 8, maxLength: 256 },
              batch: { $ref: "#/components/schemas/WorkspaceCommandBatch" },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/undo": {
        post: {
          operationId: "undo_workspace_batch",
          summary: "Undo one atomic Workspace batch at an exact revision.",
          requestBody: jsonBody({ $ref: "#/components/schemas/AuthorizedWorkspaceSession" }),
          responses: successResponses,
        },
      },
      "/workspace/redo": {
        post: {
          operationId: "redo_workspace_batch",
          summary: "Redo one atomic Workspace batch at an exact revision.",
          requestBody: jsonBody({ $ref: "#/components/schemas/AuthorizedWorkspaceSession" }),
          responses: successResponses,
        },
      },
      "/workspace/events": {
        post: {
          operationId: "read_workspace_events",
          summary: "Read an ordered, resumable page of semantic Workspace events.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              after_cursor: { type: "string", minLength: 1, maxLength: 256 },
              limit: { type: "integer", minimum: 1, maximum: 200 },
            },
          }),
          responses: successResponses,
        },
      },
    },
    components: {
      securitySchemes: {
        PairingBearer: { type: "http", scheme: "bearer", bearerFormat: "ephemeral-local-token" },
      },
      schemas: {
        Error: errorSchema,
        AgentControlError: agentControlErrorSchema,
        AgentResult: agentResultSchema,
        InspectWorkspaceComponentData: inspectWorkspaceComponentDataSchema,
        InspectWorkspaceComponentResult: inspectWorkspaceComponentResultSchema,
        WorkspaceSession: {
          type: "object",
          additionalProperties: false,
          required: ["session_token", "instruction_digest"],
          properties: {
            session_token: { type: "string", minLength: 8, maxLength: 256 },
            instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
          },
        },
        AuthorizedWorkspaceSession: {
          type: "object",
          additionalProperties: false,
          required: ["session_token", "instruction_digest", "expected_workspace_revision"],
          properties: {
            session_token: { type: "string", minLength: 8, maxLength: 256 },
            instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
            expected_workspace_revision: { type: "integer", minimum: 0 },
          },
        },
        WorkspaceCommandBatch: workspaceProtocolSchema,
      },
    },
  };
}
