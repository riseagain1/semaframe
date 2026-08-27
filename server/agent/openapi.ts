import workspaceProtocolSchema from "../../src/workspace/protocol/workspaceProtocol.schema.json";
import {
  PHOTO_RECONSTRUCTION_LIMITS,
  PHOTO_RECONSTRUCTION_MEDIA_TYPES,
} from "../../src/reconstruction/contracts";
import {
  WORKSPACE_MODEL_INSPECTION_MAX_BYTES,
  WORKSPACE_PERMISSION_SCOPE_REQUEST_LIMIT,
  WORKSPACE_PERMISSION_SCOPES,
  WORKSPACE_RESOURCE_SNAPSHOT_MAX_BYTES,
  WORKSPACE_RESOURCE_SNAPSHOT_UNTRUSTED_DATA_NOTICE,
} from "../../src/workspace/agents/contracts";

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
        "read_workspace_resource_snapshot",
        "inspect_workspace_asset",
        "inspect_workspace_model",
        "inspect_workspace_space",
        "query_spatial_placement",
        "query_layout_placement",
        "inspect_workspace_physics",
        "query_stable_placement",
        "simulate_workspace_physics",
        "begin_workspace_asset_import",
        "cancel_workspace_asset_import",
        "complete_workspace_asset_import",
        "begin_workspace_photo_reconstruction",
        "start_workspace_photo_reconstruction",
        "inspect_workspace_photo_reconstruction",
        "cancel_workspace_photo_reconstruction",
        "finalize_workspace_photo_reconstruction",
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

const readWorkspaceResourceSnapshotDataSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "client_id",
    "workspace_id",
    "workspace_revision",
    "registry_digest",
    "resource_id",
    "label",
    "connector_type",
    "connector_version",
    "output_schema",
    "status",
    "snapshot_authority",
    "snapshot",
    "complete",
    "response_limit_bytes",
    "untrusted_data_notice",
  ],
  properties: {
    client_id: { type: "string" },
    client_name: { type: "string" },
    workspace_id: { type: "string" },
    workspace_revision: { type: "integer", minimum: 0 },
    registry_digest: { type: "string" },
    resource_id: { type: "string" },
    label: { type: "string" },
    connector_type: { type: "string" },
    connector_version: { type: "string" },
    output_schema: {},
    status: { enum: ["unconfigured", "ready", "stale", "error"] },
    snapshot_authority: { const: "host_normalized" },
    snapshot: {
      type: "object",
      additionalProperties: false,
      required: ["data", "content_hash", "retrieved_at", "stale", "provenance"],
      properties: {
        data: {},
        content_hash: { type: "string" },
        retrieved_at: { type: "string", format: "date-time" },
        stale: { type: "boolean" },
        provenance: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["retrieved_at"],
            properties: {
              title: { type: "string" },
              uri: { type: "string" },
              publisher: { type: "string" },
              retrieved_at: { type: "string", format: "date-time" },
              citation: { type: "string" },
            },
          },
        },
      },
    },
    complete: { const: true },
    response_limit_bytes: { const: WORKSPACE_RESOURCE_SNAPSHOT_MAX_BYTES },
    untrusted_data_notice: { const: WORKSPACE_RESOURCE_SNAPSHOT_UNTRUSTED_DATA_NOTICE },
  },
} as const;

const readWorkspaceResourceSnapshotResultSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["ok", "data"],
      properties: {
        ok: { const: true },
        data: { $ref: "#/components/schemas/ReadWorkspaceResourceSnapshotData" },
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

const photoReconstructionCandidateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidateHandle", "format", "mediaType", "byteLength", "sha256"],
  properties: {
    candidateHandle: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    format: { enum: ["ply", "spz", "sog"] },
    mediaType: { type: "string", minLength: 3, maxLength: 192 },
    byteLength: {
      type: "integer",
      minimum: 1,
      maximum: PHOTO_RECONSTRUCTION_LIMITS.maximumOutputBytes,
    },
    sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
  },
} as const;

const photoReconstructionJobSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version", "jobId", "requestId", "workspaceId", "photoSetDigest", "profile", "status",
    "progress", "inputPhotoCount", "uploadedPhotoCount", "backend", "warnings", "createdAt",
    "updatedAt", "expiresAt",
  ],
  properties: {
    version: { const: 1 },
    jobId: { type: "string", format: "uuid" },
    requestId: { type: "string", minLength: 8, maxLength: 128 },
    workspaceId: { type: "string", minLength: 1, maxLength: 256 },
    photoSetDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    profile: { enum: ["preview", "balanced", "quality"] },
    status: {
      enum: ["awaiting_upload", "queued", "camera_solving", "training", "packing", "ready", "failed", "cancelled"],
    },
    progress: { type: "number", minimum: 0, maximum: 1 },
    inputPhotoCount: {
      type: "integer",
      minimum: PHOTO_RECONSTRUCTION_LIMITS.minimumPhotoCount,
      maximum: PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount,
    },
    uploadedPhotoCount: {
      type: "integer",
      minimum: 0,
      maximum: PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount,
    },
    registeredPhotoCount: {
      type: "integer",
      minimum: 0,
      maximum: PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount,
    },
    backend: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 64 },
        version: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    warnings: {
      type: "array",
      maxItems: PHOTO_RECONSTRUCTION_LIMITS.maximumWireWarnings,
      uniqueItems: true,
      items: {
        enum: [
          "low_photo_count",
          "duplicate_content_removed",
          "partial_camera_registration",
          "source_scale_unknown",
          "source_coordinates_unknown",
        ],
      },
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    result: { $ref: "#/components/schemas/PhotoReconstructionCandidate" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
      },
    },
  },
} as const;

const realityAssetDescriptorSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version", "assetId", "digest", "format", "formatVersion", "mediaType", "byteLength",
    "splatCount", "sphericalHarmonicsDegree", "model", "antialiased", "coordinateSystem",
    "engineeringAuthority",
  ],
  properties: {
    version: { const: 1 },
    assetId: { type: "string", pattern: "^ra_[a-f0-9]{64}$" },
    digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    format: { enum: ["spz-v4", "ply", "sog-v2"] },
    formatVersion: { type: "integer", minimum: 1, maximum: 65_535 },
    mediaType: { enum: ["application/x-spz", "application/ply", "model/vnd.sog"] },
    byteLength: { type: "integer", minimum: 1, maximum: 268_435_456 },
    splatCount: { type: "integer", minimum: 1, maximum: 4_000_000 },
    sphericalHarmonicsDegree: { type: ["integer", "null"], minimum: 0, maximum: 4 },
    model: { enum: ["gaussian-3d", "gaussian-2d", "unknown"] },
    antialiased: { type: ["boolean", "null"] },
    coordinateSystem: {
      type: "object",
      additionalProperties: false,
      required: ["system", "provenance"],
      properties: {
        system: {
          enum: [
            "UNKNOWN", "LDB", "RDB", "LUB", "RUB", "LDF", "RDF", "LUF", "RUF",
            "LFD", "RFD", "LFU", "RFU", "LBD", "RBD", "LBU", "RBU",
          ],
        },
        provenance: { enum: ["embedded", "format-default", "unknown"] },
      },
    },
    sourceBounds: {
      type: "object",
      additionalProperties: false,
      required: ["min", "max"],
      properties: {
        min: { $ref: "#/components/schemas/RealityAssetPoint" },
        max: { $ref: "#/components/schemas/RealityAssetPoint" },
      },
    },
    engineeringAuthority: { const: "visual_only" },
  },
} as const;

function agentDataResultSchema(data: unknown) {
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["ok", "data"],
        properties: { ok: { const: true }, data },
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
}

const beginPhotoReconstructionResultSchema = agentDataResultSchema({
  type: "object",
  additionalProperties: false,
  required: ["job", "uploads"],
  properties: {
    job: { $ref: "#/components/schemas/PhotoReconstructionJob" },
    uploads: {
      type: "array",
      maxItems: PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount,
      items: { $ref: "#/components/schemas/PhotoReconstructionUploadGrant" },
    },
  },
});

const photoReconstructionJobResultSchema = agentDataResultSchema({
  $ref: "#/components/schemas/PhotoReconstructionJob",
});

const cancelPhotoReconstructionResultSchema = agentDataResultSchema({
  type: "object",
  additionalProperties: false,
  required: ["cancelled", "job"],
  properties: {
    cancelled: { const: true },
    job: { $ref: "#/components/schemas/PhotoReconstructionJob" },
  },
});

const finalizePhotoReconstructionResultSchema = agentDataResultSchema({
  type: "object",
  additionalProperties: false,
  required: ["asset_ref", "descriptor", "warnings"],
  properties: {
    asset_ref: {
      type: "object",
      additionalProperties: false,
      required: ["asset_id", "digest"],
      properties: {
        asset_id: { type: "string", pattern: "^ra_[a-f0-9]{64}$" },
        digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
    },
    descriptor: { $ref: "#/components/schemas/RealityAssetDescriptor" },
    warnings: { type: "array", maxItems: 32, items: { type: "string" } },
  },
});

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

const photoReconstructionResponses = {
  ...successResponses,
  "403": {
    description: "The approved client does not hold the non-default asset:reconstruct scope.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "404": {
    description: "The client-owned reconstruction job is invalid, expired, or belongs to another Workspace.",
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

const readWorkspaceResourceSnapshotResponses = {
  "200": {
    description: "Returns the exact current persisted resource snapshot when ok is true. Missing scopes/resources, non-readable resources, and oversized exact results are returned as structured ok:false domain errors in this same envelope.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ReadWorkspaceResourceSnapshotResult" },
      },
    },
  },
  "400": successResponses["400"],
  "401": successResponses["401"],
  "409": successResponses["409"],
  "413": successResponses["413"],
  "415": successResponses["415"],
  "503": successResponses["503"],
  "504": successResponses["504"],
} as const;

const agentAssetCandidateRequired = [
  "version", "candidate_handle", "request_id", "workspace_id", "display_name", "format",
  "media_type", "byte_length", "sha256", "purpose", "status", "expires_at",
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
  purpose: {
    enum: ["generic_import", "photo_reconstruction"],
    description: "Host-authored provenance. Public asset-import endpoints always mint generic_import; photo_reconstruction is reserved for the reconstruction service.",
  },
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
      version: "1.3.0",
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
      "/reconstructions/begin": {
        post: {
          operationId: "begin_workspace_photo_reconstruction",
          summary: "Declare a digest-bound photo set and mint one-time upload grants.",
          description: `Requires the non-default asset:reconstruct scope. Declares ${PHOTO_RECONSTRUCTION_LIMITS.minimumPhotoCount}-${PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount} user-provided photos by exact media type, byte length, and SHA-256. The response contains one bounded PUT grant per missing photo; raw bytes, local paths, filenames, and EXIF never enter this JSON request or the saved Workspace. The complete set may not exceed ${PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoSetBytes} bytes.`,
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "request_id", "workspace_id", "profile", "photos", "approval_token"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              approval_token: {
                type: "string",
                minLength: 16,
                maxLength: 256,
                description: "Private proof from the active user-approved MCP connection. Never log or persist it.",
              },
              request_id: {
                type: "string",
                minLength: 8,
                maxLength: 128,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$",
              },
              workspace_id: {
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$",
              },
              profile: { enum: ["preview", "balanced", "quality"] },
              photos: {
                type: "array",
                minItems: PHOTO_RECONSTRUCTION_LIMITS.minimumPhotoCount,
                maxItems: PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount,
                items: { $ref: "#/components/schemas/PhotoReconstructionPhotoInput" },
              },
            },
          }),
          responses: {
            ...photoReconstructionResponses,
            "200": {
              description: "An idempotent reconstruction job plus upload grants for photos not yet staged.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/BeginPhotoReconstructionResult" },
                },
              },
            },
            "429": {
              description: "The bounded reconstruction job or temporary-storage capacity is exhausted.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/reconstructions/start": {
        post: {
          operationId: "start_workspace_photo_reconstruction",
          summary: "Start a photo reconstruction after every declared upload is byte-verified.",
          description: "Identical retries are idempotent. The host rejects an incomplete photo set rather than queuing a partial reconstruction.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "workspace_id", "job_id", "approval_token"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              approval_token: { type: "string", minLength: 16, maxLength: 256, description: "Private proof from the active user-approved MCP connection." },
              workspace_id: {
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$",
              },
              job_id: { type: "string", format: "uuid" },
            },
          }),
          responses: {
            ...photoReconstructionResponses,
            "200": {
              description: "The exact current job state after the idempotent start request.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PhotoReconstructionJobResult" },
                },
              },
            },
          },
        },
      },
      "/reconstructions/inspect": {
        post: {
          operationId: "inspect_workspace_photo_reconstruction",
          summary: "Inspect one authorized photo reconstruction job.",
          description: "Returns bounded progress, phase, warnings, backend identity, and the digest-pinned output candidate when ready. It never returns photo bytes, source metadata, local paths, credentials, or backend logs.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "workspace_id", "job_id", "approval_token"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              approval_token: { type: "string", minLength: 16, maxLength: 256, description: "Private proof from the active user-approved MCP connection." },
              workspace_id: {
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$",
              },
              job_id: { type: "string", format: "uuid" },
            },
          }),
          responses: {
            ...photoReconstructionResponses,
            "200": {
              description: "The exact current bounded job view.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PhotoReconstructionJobResult" },
                },
              },
            },
          },
        },
      },
      "/reconstructions/cancel": {
        post: {
          operationId: "cancel_workspace_photo_reconstruction",
          summary: "Cancel one owned photo reconstruction job and clean up temporary bytes.",
          description: "Requires confirm=true. Cancellation schedules staged source and unfinalized output bytes for deletion; an asset already finalized into the browser-owned vault is not deleted.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "workspace_id", "job_id", "confirm", "approval_token"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              approval_token: { type: "string", minLength: 16, maxLength: 256, description: "Private proof from the active user-approved MCP connection." },
              workspace_id: {
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$",
              },
              job_id: { type: "string", format: "uuid" },
              confirm: { const: true },
            },
          }),
          responses: {
            ...photoReconstructionResponses,
            "200": {
              description: "Cancellation acknowledgement and the terminal job view.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CancelPhotoReconstructionResult" },
                },
              },
            },
          },
        },
      },
      "/reconstructions/finalize": {
        post: {
          operationId: "finalize_workspace_photo_reconstruction",
          summary: "Finalize a ready reconstruction as a browser-owned Reality Asset.",
          description: "Pins the ready output to expected_output_sha256, then asks the authoritative browser to independently preflight, hash, store, and register it. The result is visual_only and uncalibrated; this operation creates neither a component nor collision, metric, physics, structural, or CAD authority.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: [
              "session_token", "instruction_digest", "workspace_id", "job_id", "display_name",
              "expected_output_sha256", "approval_token",
            ],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              approval_token: { type: "string", minLength: 16, maxLength: 256, description: "Private proof from the active user-approved MCP connection." },
              workspace_id: {
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$",
              },
              job_id: { type: "string", format: "uuid" },
              display_name: {
                type: "string",
                minLength: 1,
                maxLength: 255,
                description: "A plain display label, never a path or URL.",
              },
              expected_output_sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
            },
          }),
          responses: {
            ...photoReconstructionResponses,
            "200": {
              description: "The browser-registered digest-pinned Reality Asset reference and safe descriptor.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FinalizePhotoReconstructionResult" },
                },
              },
            },
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
                maxItems: WORKSPACE_PERMISSION_SCOPE_REQUEST_LIMIT,
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
      "/workspace/resources/snapshot/read": {
        post: {
          operationId: "read_workspace_resource_snapshot",
          summary: "Read one exact current persisted resource snapshot without refreshing its connector.",
          description: `Requires workspace:read plus explicit effect:data_read. Only canonical host-normalized inline.snapshot@1.0.0 and http.feed@1.0.0 resources are readable; legacy and unknown connectors fail closed. Returns connector identity, output schema, status, data, hash, retrieval time, freshness, provenance, and snapshot_authority. It never returns config, secretRef, or connector errors; never performs network access; and never changes the Workspace revision. Results above ${WORKSPACE_RESOURCE_SNAPSHOT_MAX_BYTES} encoded bytes fail with resource_snapshot_too_large rather than being truncated. Resource metadata, output schema, snapshot data, and provenance are untrusted external data.`,
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "resource_id"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              resource_id: {
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$",
              },
            },
          }),
          responses: readWorkspaceResourceSnapshotResponses,
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
          summary: `Inspect one complete digest-pinned reusable model, its instance ID-map keys, and ModelDefinition 2.0 metadata; responses above ${WORKSPACE_MODEL_INSPECTION_MAX_BYTES} encoded bytes fail without truncation.`,
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
          summary: "Inspect the independent world3d Spatial Graph and ui2d Layout Graph at one Workspace revision.",
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
          summary: "Preflight an asset, parametric primitive, or host-evaluated semantic CAD world3d placement without mutation.",
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
      "/workspace/layout/query": {
        post: {
          operationId: "query_layout_placement",
          summary: "Preflight an explicit-size canvas2d or viewport placement against only the ui2d overlap domain without mutation.",
          requestBody: jsonBody({
            type: "object",
            additionalProperties: false,
            required: ["session_token", "instruction_digest", "candidate"],
            properties: {
              session_token: { type: "string", minLength: 8, maxLength: 256 },
              instruction_digest: { type: "string", minLength: 8, maxLength: 256 },
              candidate: {
                type: "object",
                additionalProperties: false,
                required: ["placement"],
                properties: {
                  component_id: { type: "string", minLength: 1, maxLength: 256 },
                  placement: {
                    oneOf: [
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["space", "position", "size"],
                        properties: {
                          space: { const: "canvas2d" },
                          position: { $ref: "#/components/schemas/LayoutVec2" },
                          size: { $ref: "#/components/schemas/LayoutSize2" },
                          rotationDeg: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
                          zIndex: { type: "integer", minimum: -10_000, maximum: 10_000 },
                        },
                      },
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["space", "anchor", "offset", "size"],
                        properties: {
                          space: { const: "viewport" },
                          anchor: { enum: ["top_left", "top", "top_right", "left", "center", "right", "bottom_left", "bottom", "bottom_right"] },
                          offset: { $ref: "#/components/schemas/LayoutVec2" },
                          size: { $ref: "#/components/schemas/LayoutSize2" },
                          zIndex: { type: "integer", minimum: -10_000, maximum: 10_000 },
                        },
                      },
                    ],
                  },
                },
              },
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
          summary: "Preflight collision and center-of-mass stability for an asset, primitive, or host-evaluated semantic CAD world3d placement without mutation.",
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
        ReadWorkspaceResourceSnapshotData: readWorkspaceResourceSnapshotDataSchema,
        ReadWorkspaceResourceSnapshotResult: readWorkspaceResourceSnapshotResultSchema,
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
        PhotoReconstructionPhotoInput: {
          type: "object",
          additionalProperties: false,
          required: ["photo_id", "media_type", "byte_length", "sha256"],
          properties: {
            photo_id: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$",
            },
            media_type: { enum: PHOTO_RECONSTRUCTION_MEDIA_TYPES },
            byte_length: {
              type: "integer",
              minimum: 1,
              maximum: PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoBytes,
            },
            sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
          },
        },
        PhotoReconstructionUploadGrant: {
          type: "object",
          additionalProperties: false,
          required: [
            "photoId", "method", "url", "authorization", "token", "contentType", "contentLength",
            "expiresAt",
          ],
          properties: {
            photoId: { type: "string", minLength: 1, maxLength: 64 },
            method: { const: "PUT" },
            url: { type: "string", format: "uri" },
            authorization: { const: "Bearer" },
            token: { type: "string", minLength: 43, maxLength: 43 },
            contentType: { enum: PHOTO_RECONSTRUCTION_MEDIA_TYPES },
            contentLength: {
              type: "integer",
              minimum: 1,
              maximum: PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoBytes,
            },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        PhotoReconstructionCandidate: photoReconstructionCandidateSchema,
        PhotoReconstructionJob: photoReconstructionJobSchema,
        BeginPhotoReconstructionResult: beginPhotoReconstructionResultSchema,
        PhotoReconstructionJobResult: photoReconstructionJobResultSchema,
        CancelPhotoReconstructionResult: cancelPhotoReconstructionResultSchema,
        FinalizePhotoReconstructionResult: finalizePhotoReconstructionResultSchema,
        RealityAssetPoint: {
          type: "object",
          additionalProperties: false,
          required: ["x", "y", "z"],
          properties: {
            x: { type: "number", minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 },
            y: { type: "number", minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 },
            z: { type: "number", minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 },
          },
        },
        RealityAssetDescriptor: realityAssetDescriptorSchema,
        LayoutVec2: {
          type: "object",
          additionalProperties: false,
          required: ["x", "y"],
          properties: {
            x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
            y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
          },
        },
        LayoutSize2: {
          type: "object",
          additionalProperties: false,
          required: ["width", "height"],
          properties: {
            width: { type: "number", minimum: 1, maximum: 4_096 },
            height: { type: "number", minimum: 1, maximum: 4_096 },
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
