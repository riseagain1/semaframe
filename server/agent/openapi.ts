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
        "inspect_workspace_asset",
        "inspect_workspace_model",
        "inspect_workspace_space",
        "query_spatial_placement",
        "inspect_workspace_physics",
        "query_stable_placement",
        "simulate_workspace_physics",
        "begin_workspace_asset_import",
        "cancel_workspace_asset_import",
        "complete_workspace_asset_import",
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

const agentAssetImportResultSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["ok", "data"],
      properties: {
        ok: { const: true },
        data: { $ref: "#/components/schemas/AgentAssetImportGrant" },
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

const agentAssetCandidateRequired = [
  "version", "candidate_handle", "request_id", "workspace_id", "display_name", "format",
  "media_type", "byte_length", "sha256", "status", "expires_at",
] as const;

const agentAssetCandidateProperties = {
  version: { const: 1 },
  candidate_handle: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  request_id: { type: "string" },
  workspace_id: { type: "string" },
  display_name: { type: "string" },
  format: { enum: ["ply", "spz", "sog"] },
  media_type: { type: "string" },
  byte_length: { type: "integer", minimum: 1 },
  sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
  status: { enum: ["awaiting_upload", "ready"] },
  expires_at: { type: "string", format: "date-time" },
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
      "/assets/imports/begin": {
        post: {
          operationId: "begin_agent_asset_import",
          summary: "Mint an expiring, client- and Workspace-bound upload grant for a user-provided Reality asset.",
          description: "Requires a browser-issued Workspace session with asset:import. Stream bytes with the returned PUT grant; JSON/base64 bodies, local paths, and source URLs are not accepted.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "request_id", "workspace_id", "display_name", "format", "media_type", "byte_length", "sha256"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              request_id: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$" },
              workspace_id: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$" },
              display_name: { type: "string", minLength: 1, maxLength: 255, description: "A plain display label, never a path or URL." },
              format: { enum: ["ply", "spz", "sog"] },
              media_type: { type: "string", minLength: 3, maxLength: 192 },
              byte_length: { type: "integer", minimum: 1, maximum: 268_435_456 },
              sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
            },
          }),
          responses: {
            ...successResponses,
            "200": {
              description: "An idempotent upload grant or already-ready candidate.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AgentAssetImportResult" } } },
            },
            "403": {
              description: "The approved client does not hold asset:import.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/assets/imports/cancel": {
        post: {
          operationId: "cancel_agent_asset_import",
          summary: "Cancel and delete one unconsumed candidate owned by the approved client claim.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "candidate_handle"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              candidate_handle: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
            },
          }),
          responses: successResponses,
        },
      },
      "/assets/imports/complete": {
        post: {
          operationId: "complete_workspace_asset_import",
          summary: "Ask the authoritative browser to preflight, store, and register one ready Reality Asset candidate.",
          description: "The browser streams the staged bytes through its private candidate handoff. Raw bytes never enter this JSON request or response.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "candidate_handle"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              candidate_handle: { type: "string", minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]{43}$" },
            },
          }),
          responses: successResponses,
        },
      },
      "/assets/uploads/{grant_id}": {
        put: {
          operationId: "upload_agent_asset_bytes",
          summary: "Stream the exact granted binary body into secure temporary storage.",
          description: "Use the one-use upload bearer, not the pairing bearer. Content-Type, Content-Length, and SHA-256 must exactly match the grant.",
          security: [{ AssetUploadBearer: [] }],
          parameters: [{ in: "path", name: "grant_id", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          responses: {
            "200": {
              description: "Digest-verified opaque candidate ready for browser-authoritative handoff.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AgentAssetCandidate" } } },
            },
            "401": { description: "Invalid upload bearer.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "410": { description: "Expired or cancelled grant.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "422": { description: "Streamed size or digest mismatch.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
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
      "/workspace/assets/inspect": {
        post: {
          operationId: "inspect_workspace_asset",
          summary: "Inspect one exact registered Reality Asset descriptor without exposing local bytes or paths.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "asset_id"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              asset_id: {
                type: "string",
                minLength: 67,
                maxLength: 67,
                pattern: "^ra_[a-f0-9]{64}$",
              },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/models/inspect": {
        post: {
          operationId: "inspect_workspace_model",
          summary: "Inspect one exact digest-pinned reusable model and its instance ID-map keys.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "model_id", "version"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              model_id: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Za-z][A-Za-z0-9._:-]{0,127}$",
              },
              version: {
                type: "string",
                minLength: 5,
                maxLength: 64,
                pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?$",
              },
            },
          }),
          responses: successResponses,
        },
      },
      "/workspace/space/inspect": {
        post: {
          operationId: "inspect_workspace_space",
          summary: "Inspect the derived SemaFrame Spatial Graph with world transforms, bounds, collisions, and relations.",
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
        AssetUploadBearer: { type: "http", scheme: "bearer", bearerFormat: "one-use-asset-upload-token" },
      },
      schemas: {
        Error: errorSchema,
        AgentControlError: agentControlErrorSchema,
        AgentResult: agentResultSchema,
        AgentAssetImportResult: agentAssetImportResultSchema,
        InspectWorkspaceComponentData: inspectWorkspaceComponentDataSchema,
        InspectWorkspaceComponentResult: inspectWorkspaceComponentResultSchema,
        AgentAssetCandidate: {
          type: "object",
          additionalProperties: false,
          required: agentAssetCandidateRequired,
          properties: agentAssetCandidateProperties,
        },
        AgentAssetImportGrant: {
          type: "object",
          additionalProperties: false,
          required: agentAssetCandidateRequired,
          properties: {
            ...agentAssetCandidateProperties,
            upload: {
              type: "object",
              additionalProperties: false,
              required: ["method", "url", "authorization", "token", "content_type", "content_length"],
              properties: {
                method: { const: "PUT" },
                url: { type: "string", format: "uri" },
                authorization: { const: "Bearer" },
                token: { type: "string", minLength: 43, maxLength: 43 },
                content_type: { type: "string" },
                content_length: { type: "integer", minimum: 1 },
              },
            },
          },
        },
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
