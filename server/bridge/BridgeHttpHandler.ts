import { BridgeSessionError, type BridgeSessionService } from "./BridgeSessionService";

export const BRIDGE_HTTP_PREFIX = "/v1/bridge/sessions/" as const;
const PROPOSAL_BODY_LIMIT = 1_048_576;

function headers(contentType = "application/json; charset=utf-8"): HeadersInit {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: headers() });
}

function statusFor(error: BridgeSessionError): number {
  if (error.code === "unauthorized") return 401;
  if (error.code === "session_not_found") return 404;
  if (error.code === "session_expired") return 410;
  if (error.code === "capacity_exceeded") return 429;
  if (error.code === "proposal_mismatch" || error.code === "stale_publication") return 409;
  return 422;
}

function bearer(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (!match) throw new BridgeSessionError("unauthorized", "Use the Bridge bearer capability");
  return match[1];
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BridgeSessionError("invalid_publication", "Use application/json");
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new BridgeSessionError("invalid_publication", "Compressed proposal bodies are not supported");
  }
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new BridgeSessionError("invalid_publication", "Proposal Content-Length is invalid");
    }
    if (declared > PROPOSAL_BODY_LIMIT) {
      throw new BridgeSessionError("invalid_publication", "Proposal body is too large");
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw new BridgeSessionError("invalid_publication", "Proposal body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PROPOSAL_BODY_LIMIT) {
        await reader.cancel();
        throw new BridgeSessionError("invalid_publication", "Proposal body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new BridgeSessionError("invalid_publication", "Proposal body must be valid JSON");
  }
}

/** Public native-tool surface. Session creation and approval stay host-internal. */
export function createBridgeHttpHandler(service: BridgeSessionService) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(BRIDGE_HTTP_PREFIX)) return undefined;
    try {
      const suffix = url.pathname.slice(BRIDGE_HTTP_PREFIX.length);
      const segments = suffix.split("/");
      if (segments.length < 1 || segments.length > 2 || segments.some((segment) => !segment)) {
        return json(404, { error: { code: "not_found" } });
      }
      const sessionId = segments[0];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)) {
        return json(404, { error: { code: "not_found" } });
      }
      const capability = bearer(request);
      if (segments.length === 1 && request.method === "GET") {
        if ([...url.searchParams.keys()].some((key) => key !== "after_sequence")
          || url.searchParams.getAll("after_sequence").length > 1) {
          throw new BridgeSessionError("invalid_publication", "Only one after_sequence cursor is supported");
        }
        const raw = url.searchParams.get("after_sequence");
        const after = raw === null ? undefined : Number(raw);
        if (raw !== null && (!Number.isSafeInteger(after) || Number(after) < 0)) {
          throw new BridgeSessionError("invalid_publication", "after_sequence is invalid");
        }
        const view = service.pull(sessionId, capability, after);
        return view ? json(200, { ok: true, data: view }) : new Response(null, { status: 204, headers: headers() });
      }
      if (segments[1] === "exchange" && request.method === "GET") {
        if ([...url.searchParams.keys()].some((key) => key !== "digest")
          || url.searchParams.getAll("digest").length > 1) {
          throw new BridgeSessionError("invalid_publication", "Only one exchange digest is supported");
        }
        const digest = url.searchParams.get("digest") ?? undefined;
        const bytes = service.readArchive(sessionId, capability, digest);
        const body = new Uint8Array(bytes.byteLength);
        body.set(bytes);
        return new Response(body.buffer, {
          status: 200,
          headers: {
            ...headers("application/vnd.semaframe.exchange+zip"),
            "content-length": String(bytes.byteLength),
            "content-disposition": 'attachment; filename="scene.semaframe-exchange"',
          },
        });
      }
      if (segments[1] === "proposals" && request.method === "POST") {
        if (url.search) throw new BridgeSessionError("invalid_publication", "Proposal endpoints do not accept query parameters");
        const record = service.submitProposal(sessionId, capability, await boundedJson(request));
        return json(202, { ok: true, data: { cursor: record.cursor, status: "review_required" } });
      }
      return json(405, { error: { code: "method_not_allowed" } });
    } catch (cause) {
      if (cause instanceof BridgeSessionError) {
        return json(statusFor(cause), { error: { code: cause.code, message: cause.message } });
      }
      return json(500, { error: { code: "bridge_error", message: "Bridge request failed" } });
    }
  };
}
