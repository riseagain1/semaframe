import type {
  WorkspaceAgentResult,
  WorkspaceAgentToolName,
} from "../../src/workspace/agents";

export const WORKSPACE_REST_PATHS = Object.freeze({
  get_workspace_instructions: "/v1/workspace/instructions",
  inspect_workspace: "/v1/workspace/inspect",
  inspect_workspace_component: "/v1/workspace/components/inspect",
  read_workspace_resource_snapshot: "/v1/workspace/resources/snapshot/read",
  inspect_workspace_asset: "/v1/workspace/assets/inspect",
  inspect_workspace_model: "/v1/workspace/models/inspect",
  inspect_workspace_space: "/v1/workspace/space/inspect",
  query_spatial_placement: "/v1/workspace/space/query",
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
  read_workspace_events: "/v1/workspace/events/read",
} satisfies Record<WorkspaceAgentToolName, string>);

export type WorkspaceAgentRestController = Readonly<{
  dispatch(name: unknown, input: unknown): Promise<WorkspaceAgentResult<unknown>>;
}>;

export type WorkspaceAgentRestHandlerOptions = Readonly<{
  /** Transport authentication is mandatory; instruction sessions are not pairing credentials. */
  authenticate(request: Request): boolean | Promise<boolean>;
  bodyLimitBytes?: number;
}>;

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}
class InvalidBodyError extends Error {}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new InvalidBodyError("Use application/json");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  if (!request.body) throw new InvalidBodyError("Request body must be a JSON object");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined)) as unknown;
  } catch {
    throw new InvalidBodyError("Request body must be valid JSON");
  }
}

function toolForPath(pathname: string): WorkspaceAgentToolName | undefined {
  return (Object.entries(WORKSPACE_REST_PATHS) as [WorkspaceAgentToolName, string][])
    .find(([, path]) => path === pathname)?.[0];
}

function statusForResult(result: WorkspaceAgentResult<unknown>): number {
  if (result.ok) return 200;
  const { code } = result.error;
  if (code === "instructions_required" || code === "session_expired") return 401;
  if (code === "instruction_digest_mismatch" || code === "permission_denied" || code === "destructive_permission_required") return 403;
  if (code === "resource_not_found") return 404;
  if (code === "resource_snapshot_unavailable") return 409;
  if (code === "resource_snapshot_not_readable") return 422;
  if (/stale|transaction|retry_mismatch|envelope_mismatch|session_mismatch/u.test(code)) return 409;
  if (code === "resource_snapshot_too_large" || code === "model_inspection_too_large") return 413;
  if (/invalid|validation|unsupported/u.test(code)) return 422;
  return 500;
}

/** REST projection over the exact same controller used by every external Agent client. */
export function createWorkspaceAgentRestHandler(
  controller: WorkspaceAgentRestController,
  options: WorkspaceAgentRestHandlerOptions,
): (request: Request) => Promise<Response> {
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
    throw new RangeError("bodyLimitBytes must be a positive integer");
  }

  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    const tool = toolForPath(pathname);
    if (!tool) return jsonResponse(404, { error: { code: "not_found", message: "Unknown Workspace endpoint" } });
    if (request.method !== "POST") {
      return jsonResponse(405, { error: { code: "method_not_allowed", message: "Use POST" } });
    }
    let authenticated = false;
    try {
      authenticated = await options.authenticate(request);
    } catch {
      authenticated = false;
    }
    if (!authenticated) {
      return jsonResponse(401, { error: { code: "transport_unauthorized", message: "Workspace transport authentication failed" } });
    }
    try {
      const body = await readBoundedJson(request, bodyLimit);
      const result = await controller.dispatch(tool, body);
      return jsonResponse(statusForResult(result), result);
    } catch (cause) {
      if (cause instanceof BodyTooLargeError) {
        return jsonResponse(413, { error: { code: "body_too_large", message: `Request body exceeds ${bodyLimit} bytes` } });
      }
      if (cause instanceof InvalidBodyError) {
        return jsonResponse(400, { error: { code: "invalid_request", message: cause.message } });
      }
      return jsonResponse(500, { error: { code: "handler_error", message: "Workspace request could not be processed" } });
    }
  };
}
