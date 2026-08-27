import {
  McpServer,
  type RegisteredTool,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type {
  BeginWorkspacePhotoReconstructionInput,
  CancelWorkspacePhotoReconstructionInput,
  FinalizeWorkspacePhotoReconstructionInput,
  InspectWorkspacePhotoReconstructionInput,
  StartWorkspacePhotoReconstructionInput,
  WorkspaceAgentToolName,
} from "../../src/workspace/agents";
import {
  WORKSPACE_MCP_SERVER_INFO,
  registerWorkspaceTools,
  workspaceMcpResultSchema,
  type WorkspaceMcpBackendResult,
  type WorkspaceMcpClientContext,
} from "../workspace/WorkspaceMcpTools";
import {
  type AgentHostControlCommandName,
} from "../../src/agent/hostControlContracts";

export const AGENT_MCP_SERVER_INFO = WORKSPACE_MCP_SERVER_INFO;

export const AGENT_REST_PATHS = Object.freeze({
  get_workspace_instructions: "/v1/workspace/instructions",
  inspect_workspace: "/v1/workspace/inspect",
  inspect_workspace_component: "/v1/workspace/components/inspect",
  read_workspace_resource_snapshot: "/v1/workspace/resources/snapshot/read",
  inspect_workspace_asset: "/v1/workspace/assets/inspect",
  inspect_workspace_model: "/v1/workspace/models/inspect",
  inspect_workspace_space: "/v1/workspace/space/inspect",
  query_spatial_placement: "/v1/workspace/space/query",
  query_layout_placement: "/v1/workspace/layout/query",
  inspect_workspace_physics: "/v1/workspace/physics/inspect",
  query_stable_placement: "/v1/workspace/physics/placement/query",
  simulate_workspace_physics: "/v1/workspace/physics/simulate",
  begin_workspace_asset_import: "/v1/assets/imports/begin",
  cancel_workspace_asset_import: "/v1/assets/imports/cancel",
  complete_workspace_asset_import: "/v1/assets/imports/complete",
  begin_workspace_photo_reconstruction: "/v1/reconstructions/begin",
  start_workspace_photo_reconstruction: "/v1/reconstructions/start",
  inspect_workspace_photo_reconstruction: "/v1/reconstructions/inspect",
  cancel_workspace_photo_reconstruction: "/v1/reconstructions/cancel",
  finalize_workspace_photo_reconstruction: "/v1/reconstructions/finalize",
  begin_workspace_update: "/v1/workspace/updates/begin",
  submit_workspace_batch: "/v1/workspace/updates/submit",
  undo_workspace_batch: "/v1/workspace/undo",
  redo_workspace_batch: "/v1/workspace/redo",
  read_workspace_events: "/v1/workspace/events",
} as const satisfies Record<WorkspaceAgentToolName, string>);

export type AgentMcpBackendResult = WorkspaceMcpBackendResult;
export type AgentMcpClientContext = WorkspaceMcpClientContext;

export type AgentMcpBackend = Readonly<{
  dispatch(
    name: WorkspaceAgentToolName,
    input: unknown,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
  beginAssetImport?(
    input: unknown,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
  cancelAssetImport?(
    input: unknown,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
  beginPhotoReconstruction?(
    input: BeginWorkspacePhotoReconstructionInput,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
  startPhotoReconstruction?(
    input: StartWorkspacePhotoReconstructionInput,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
  inspectPhotoReconstruction?(
    input: InspectWorkspacePhotoReconstructionInput,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
  cancelPhotoReconstruction?(
    input: CancelWorkspacePhotoReconstructionInput,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
  finalizePhotoReconstruction?(
    input: FinalizeWorkspacePhotoReconstructionInput,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
  hostControl?(
    name: AgentHostControlCommandName,
    input: unknown,
    client: AgentMcpClientContext,
  ): Promise<AgentMcpBackendResult>;
}>;

export type CreateAgentMcpServerOptions = Readonly<{
  protocolEra?: "legacy" | "modern";
  /** Observes initial registrations so a long-lived proxy can adopt them. */
  onToolRegistered?: (name: string, registration: RegisteredTool) => void;
}>;

/**
 * One transport-neutral Workspace MCP definition shared by the public HTTP
 * offer endpoint and the stdio adapter. Authorization stays in the gateway;
 * MCP protocol-era negotiation is independent from the retired Scene API.
 */
export function createAgentMcpServer(
  backend: AgentMcpBackend,
  options: CreateAgentMcpServerOptions = {},
): McpServer {
  const protocolEra = options.protocolEra ?? "legacy";
  const server = new McpServer(AGENT_MCP_SERVER_INFO, {
    instructions: "SemaFrame is a universal 2D/3D component workspace. Call get_workspace_instructions first and set instruction_digest in every later call to the returned data.guide_digest value. Before spatial work, inspect both graphs returned by inspect_workspace_space: spatial_graph is the world3d collision domain and layout_graph is the separate ui2d overlap domain. Use query_spatial_placement for world3d, query_layout_placement for explicit-size canvas2d or viewport panels, and collision plus physics placement preflights for physical structures. 2D panels may visually overlap 3D content; 2D-to-2D and solid 3D-to-3D conflicts remain independently blocked. inspect_workspace_physics and simulate_workspace_physics expose deterministic support, center-of-mass, constraints, and short settle proposals without mutating the Workspace. To create a component: inspect_workspace, begin_workspace_update, copy its exact envelope and one reserved component ID, copy an exact typeId/version/digest from its capability manifest, then submit one schema-valid batch. In immersive XR, one get_live_xr_context call exposes fresh HMD, body, per-input pose/ray/hit/action, active-source, selection, tracking, and optional Spatial Pin state through its dedicated output schema. Require a matching Workspace revision and acceptable age/tracking quality; Pin coordinates are rendered placement hints, not CAD or survey evidence. Host-control tools only prepare user-visible Voice Relay or XR actions; they never grant OS permissions, arm a target, or synthesize the trusted user gesture required to enter immersive WebXR. A remote HTTP connection requires explicit approval in the open app; the URL itself grants no authority.",
  });

  const originalRegisterTool = server.registerTool.bind(server);
  if (options.onToolRegistered) {
    server.registerTool = ((...args: Parameters<McpServer["registerTool"]>) => {
      const registration = originalRegisterTool(...args);
      options.onToolRegistered!(args[0], registration);
      return registration;
    }) as McpServer["registerTool"];
  }

  try {
    registerWorkspaceTools(server, {
      dispatch: (name: WorkspaceAgentToolName, input, client) => backend.dispatch(name, input, client),
      ...(backend.beginAssetImport ? {
        beginAssetImport: (input: unknown, client: AgentMcpClientContext) => backend.beginAssetImport!(input, client),
      } : {}),
      ...(backend.cancelAssetImport ? {
        cancelAssetImport: (input: unknown, client: AgentMcpClientContext) => backend.cancelAssetImport!(input, client),
      } : {}),
      ...(backend.beginPhotoReconstruction ? {
        beginPhotoReconstruction: (input: BeginWorkspacePhotoReconstructionInput, client: AgentMcpClientContext) =>
          backend.beginPhotoReconstruction!(input, client),
      } : {}),
      ...(backend.startPhotoReconstruction ? {
        startPhotoReconstruction: (input: StartWorkspacePhotoReconstructionInput, client: AgentMcpClientContext) =>
          backend.startPhotoReconstruction!(input, client),
      } : {}),
      ...(backend.inspectPhotoReconstruction ? {
        inspectPhotoReconstruction: (input: InspectWorkspacePhotoReconstructionInput, client: AgentMcpClientContext) =>
          backend.inspectPhotoReconstruction!(input, client),
      } : {}),
      ...(backend.cancelPhotoReconstruction ? {
        cancelPhotoReconstruction: (input: CancelWorkspacePhotoReconstructionInput, client: AgentMcpClientContext) =>
          backend.cancelPhotoReconstruction!(input, client),
      } : {}),
      ...(backend.finalizePhotoReconstruction ? {
        finalizePhotoReconstruction: (input: FinalizeWorkspacePhotoReconstructionInput, client: AgentMcpClientContext) =>
          backend.finalizePhotoReconstruction!(input, client),
      } : {}),
    }, {
      protocolEra,
      registerGuideResource: true,
    });

    if (backend.hostControl) registerHostControlTools(server, backend.hostControl, protocolEra);
  } finally {
    if (options.onToolRegistered) server.registerTool = originalRegisterTool;
  }

  return server;
}

const hostBaseShape = {
  session_token: z.string().min(8).max(256),
  instruction_digest: z.string().min(8).max(256),
  workspace_id: z.string().min(1).max(256),
} as const;

const xrFiniteNumberSchema = z.number().finite();
const xrVec2Schema = z.strictObject({
  x: xrFiniteNumberSchema.describe("Horizontal axis value."),
  y: xrFiniteNumberSchema.describe("Vertical axis value."),
});
const xrVec3Schema = z.strictObject({
  x: xrFiniteNumberSchema.describe("Right-axis component."),
  y: xrFiniteNumberSchema.describe("Up-axis component."),
  z: xrFiniteNumberSchema.describe("Back-axis component."),
});
const xrQuaternionSchema = z.strictObject({
  x: xrFiniteNumberSchema,
  y: xrFiniteNumberSchema,
  z: xrFiniteNumberSchema,
  w: xrFiniteNumberSchema,
});
const xrPoseSchema = z.strictObject({
  position: xrVec3Schema.describe("Position in metre-based workspace-world-rub coordinates."),
  orientation: xrQuaternionSchema.describe("Normalized orientation quaternion."),
});
const xrRaySchema = z.strictObject({
  origin: xrVec3Schema.describe("Workspace-world ray origin in metres."),
  direction: xrVec3Schema.describe("Normalized, unitless Workspace-world ray direction."),
  maxDistance: xrFiniteNumberSchema.positive(),
});
const xrRayHitSchema = z.strictObject({
  kind: z.enum(["component", "ground", "surface"]),
  targetId: z.string().min(1).max(256).optional(),
  point: xrVec3Schema.describe("Full-precision rendered-surface hit coordinate."),
  normal: xrVec3Schema.describe("Normalized, unitless rendered-surface normal."),
  distance: xrFiniteNumberSchema.nonnegative().describe("Distance from ray origin in metres."),
});
const xrInputActionsSchema = z.strictObject({
  available: z.boolean().describe("Whether button and thumbstick state is available for this input source."),
  selectPressed: z.boolean(),
  squeezePressed: z.boolean(),
  primaryButtonPressed: z.boolean(),
  secondaryButtonPressed: z.boolean(),
  thumbstickPressed: z.boolean(),
  thumbstick: xrVec2Schema.describe("Normalized thumbstick axes; zero when unavailable."),
});
const xrTrackedInputSchema = z.strictObject({
  sourceId: z.string().min(1).max(256).describe("Stable identity for this input source during the XR session."),
  handedness: z.enum(["left", "right", "none"]),
  trackingState: z.enum(["tracked", "emulated", "unavailable", "unknown"]),
  targetRayMode: z.enum(["gaze", "tracked-pointer", "screen", "transient-pointer", "unknown"]),
  targetRayPose: xrPoseSchema,
  gripPose: xrPoseSchema.optional().describe("Physical grip pose when the runtime supplies one."),
  ray: xrRaySchema.optional().describe("This input source's own Workspace-world pointing ray."),
  rayHit: xrRayHitSchema.optional().describe("This input source's own current rendered-surface hit."),
  actions: xrInputActionsSchema,
});
const xrSpatialPinSchema = z.strictObject({
  pinId: z.string().min(1).max(256),
  pinSequence: z.number().int().positive().safe(),
  workspacePositionM: xrVec3Schema.describe("Full-precision user-pinned Workspace-world coordinate in metres."),
  surfaceNormal: xrVec3Schema.describe("Normalized, unitless rendered-surface normal."),
  hitKind: z.enum(["component", "ground", "surface"]),
  targetComponentId: z.string().min(1).max(256).optional(),
  sourceId: z.string().min(1).max(256),
  handedness: z.enum(["left", "right", "none"]),
  placedAtMs: xrFiniteNumberSchema.nonnegative(),
  placedAtWorkspaceRevision: z.number().int().nonnegative().safe(),
  coordinateSpace: z.literal("workspace-world-rub"),
  units: z.literal("metre"),
  authority: z.literal("render-interaction-estimate"),
});
const xrTrackingSchema = z.strictObject({
  state: z.enum(["tracked", "limited", "lost", "unknown"])
    .describe("Aggregate tracking quality for this sample."),
  headPoseState: z.enum(["tracked", "emulated", "unavailable", "unknown"]),
  sourceTimestampMs: xrFiniteNumberSchema.nonnegative()
    .describe("Renderer/source sampling timestamp."),
  sourceTimestampBasis: z.enum(["performance-time-origin", "unix-epoch", "unknown"])
    .describe("Clock basis for sourceTimestampMs; do not compare different bases directly."),
  sourceAgeMs: xrFiniteNumberSchema.nonnegative()
    .describe("Age already accumulated before the host received this sample."),
  sessionVisibility: z.enum(["visible", "visible-blurred", "hidden", "unknown"]),
});
const liveXrContextSchema = z.strictObject({
  format: z.literal("semaframe-xr-context"),
  version: z.literal("1.2"),
  ephemeral: z.literal(true),
  persistence: z.literal("forbidden"),
  source: z.literal("immersive-xr")
    .describe("This tool returns only an active immersive session, never desktop-simulator input."),
  workspaceId: z.string().min(1).max(256),
  workspaceRevision: z.number().int().nonnegative().safe(),
  sampleSequence: z.number().int().nonnegative().safe()
    .describe("Monotonic renderer sample sequence for ordering repeated reads."),
  capturedAtMs: xrFiniteNumberSchema.nonnegative(),
  tracking: xrTrackingSchema,
  referenceSpace: z.enum(["local", "local-floor", "bounded-floor", "unbounded"]),
  headPose: xrPoseSchema.describe("Current HMD/camera pose."),
  trackedInputs: z.array(xrTrackedInputSchema).max(16)
    .describe("Every currently reported controller, hand, gaze, or screen input source."),
  primaryInputSourceId: z.string().min(1).max(256).optional()
    .describe("Source whose ray is mirrored by top-level primaryRay/rayHit for compatibility."),
  activeInputSourceId: z.string().min(1).max(256).optional()
    .describe("Most recently active input source; resolve it against trackedInputs.sourceId."),
  primaryRay: xrRaySchema.optional(),
  rayHit: xrRayHitSchema.optional(),
  spatialPin: xrSpatialPinSchema.optional()
    .describe("Latest-only user-placed reference coordinate; absence means no active Pin."),
  selectedComponentId: z.string().min(1).max(256).optional(),
  playerCapsule: z.strictObject({
    feet: xrVec3Schema.describe("Room-scale body feet position derived from the current HMD pose."),
    radius: xrFiniteNumberSchema.positive(),
    height: xrFiniteNumberSchema.positive(),
  }).describe("Current conservative body/clearance volume."),
});

const liveXrContextErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  required_action: z.string().optional(),
  details: z.unknown().optional(),
});

/** Dedicated discoverable output contract for the Agent-readable XR user-state tool. */
export const liveXrContextMcpResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    data: z.strictObject({
      command: z.literal("get_live_xr_context"),
      phase: z.literal("active"),
      message: z.string(),
      source: z.enum(["same_device", "remote_headset"])
        .describe("Whether the sample was captured in this browser or received from the paired renderer."),
      maximum_age_ms: z.number().int().min(50).max(10_000),
      age_ms: xrFiniteNumberSchema.nonnegative()
        .describe("Conservative end-to-end sample age; already includes renderer sourceAgeMs, so do not add it again."),
      context: liveXrContextSchema,
    }),
  }),
  z.strictObject({ ok: z.literal(false), error: liveXrContextErrorSchema }),
]);

function registerHostControlTools(
  server: McpServer,
  hostControl: NonNullable<AgentMcpBackend["hostControl"]>,
  protocolEra: "legacy" | "modern",
): void {
  const register = (
    name: AgentHostControlCommandName,
    title: string,
    description: string,
    inputSchema: z.ZodType,
    readOnly: boolean,
    outputSchema: z.ZodType = workspaceMcpResultSchema,
  ) => server.registerTool(
    name,
    {
      title,
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) => mcpBackendToolResult(await hostControl(
      name,
      input,
      mcpClientContext(context, protocolEra),
    )),
  );

  register(
    "inspect_voice_relay",
    "Inspect Voice Relay readiness",
    "Reads sanitized Voice Relay capability and readiness state. It never exposes transcripts, window contents, native selectors, or target credentials.",
    z.strictObject(hostBaseShape),
    true,
  );
  register(
    "prepare_voice_relay_setup",
    "Prepare a user-visible Voice Relay setup",
    "Asks the open app to inspect prerequisites, recommend this approved Agent as a target, and open a setup prompt. The Agent cannot approve the target, grant OS permissions, or arm the Relay.",
    z.strictObject({
      ...hostBaseShape,
      target_hint: z.string().min(1).max(160).optional(),
    }),
    false,
  );
  register(
    "run_voice_relay_diagnostics",
    "Request Voice Relay diagnostics",
    "Requests capability checks and an explicitly user-confirmed, non-sending input readback test. It never presses Send.",
    z.strictObject({
      ...hostBaseShape,
      include_safe_input_test: z.boolean().optional(),
    }),
    false,
  );
  register(
    "request_voice_relay_arm",
    "Request Voice Relay arm",
    "Shows a user confirmation to arm the already configured target for this local session. Calling this tool does not itself arm the Relay.",
    z.strictObject(hostBaseShape),
    false,
  );
  register(
    "inspect_xr_readiness",
    "Inspect XR readiness",
    "Reads sanitized WebXR, headset, projection, asset, and render-profile readiness without starting an immersive session.",
    z.strictObject({
      ...hostBaseShape,
      mode: z.enum(["auto", "same_device", "remote_headset"]).optional(),
    }),
    true,
  );
  register(
    "prepare_xr_session",
    "Prepare an XR session",
    "Prepares the authoritative XR projection, assets, safe render profile, and a user-visible pairing or entry action. Immersive entry still requires the user's trusted gesture.",
    z.strictObject({
      ...hostBaseShape,
      mode: z.enum(["auto", "same_device", "remote_headset"]).optional(),
      render_profile: z.enum(["balanced", "validated_ultra"]).optional(),
      voice_relay: z.enum(["off", "if_configured"]).optional(),
    }),
    false,
  );
  register(
    "request_enter_xr",
    "Request immersive XR entry",
    "Shows the trusted Enter XR action in the correct browser or headset. It never synthesizes the user gesture required by WebXR.",
    z.strictObject(hostBaseShape),
    false,
  );
  register(
    "wait_for_xr_session_state",
    "Wait for XR session state",
    "Waits briefly for the next sanitized XR lifecycle transition. Pass the lifecycle_sequence returned by XR inspect, prepare, enter, exit, or a previous wait so short transitions cannot be missed.",
    z.strictObject({
      ...hostBaseShape,
      wait_ms: z.number().int().min(0).max(25_000).optional(),
      after_sequence: z.number().int().nonnegative().safe().optional(),
    }),
    true,
  );
  register(
    "request_exit_xr",
    "Request XR exit",
    "Shows a user-visible exit request. It does not silently terminate another immersive application.",
    z.strictObject(hostBaseShape),
    false,
  );
  register(
    "get_live_xr_context",
    "Read live XR user state",
    "Call once to read the newest fresh, revision-bound XR user-state sample. data.context exposes the HMD/head pose, room-scale body capsule, every tracked input and its own pose/ray/hit/actions, primary and recently active input IDs, selection, tracking quality/timestamps, and optional Spatial Pin. Use data.age_ms as the conservative end-to-end age; it already includes renderer source age. The context contains no audio or transcript, is session-ephemeral, and cannot mutate or persist the Workspace.",
    z.strictObject({
      ...hostBaseShape,
      maximum_age_ms: z.number().int().min(50).max(10_000).optional(),
    }),
    true,
    liveXrContextMcpResultSchema,
  );
}

function mcpClientContext(
  _context: ServerContext,
  protocolEra: "legacy" | "modern",
): AgentMcpClientContext {
  return { protocolEra };
}

function mcpBackendToolResult(result: AgentMcpBackendResult) {
  const payload = result.payload as Readonly<{ ok?: unknown; data?: unknown }>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: !result.responseOk || payload?.ok === false,
  };
}
