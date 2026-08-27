import {
  SEMAFRAME_EXCHANGE_FORMAT,
  SEMAFRAME_EXCHANGE_VERSION,
  type SemaFrameBridgeTarget,
  type SemaFrameExchangeManifest,
  type SemaFrameSha256,
} from "../../src/bridge";
import {
  BRIDGE_SESSION_LIMITS,
  BridgeSessionError,
  type BridgePublication,
  type BridgeSessionService,
} from "./BridgeSessionService";

export const BRIDGE_BROWSER_HTTP_PREFIX = "/api/agent/bridge/sessions" as const;
export const BRIDGE_BROWSER_LIVE_ARCHIVE_LIMIT = 64 * 1024 * 1024;

const METADATA_LIMIT = 4 * 1024 * 1024;
const JSON_BODY_LIMIT = 64 * 1024;
const TARGETS: readonly SemaFrameBridgeTarget[] = ["blender", "freecad", "unity", "unreal", "custom"];

type PublicationMetadata = Readonly<{
  target?: SemaFrameBridgeTarget;
  sequence: number;
  workspaceId: string;
  revision: number;
  exchangeDigest: SemaFrameSha256;
  manifest: SemaFrameExchangeManifest;
  ttlMs?: number;
}>;

class BridgeBrowserRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "BridgeBrowserRequestError";
  }
}

function exactRecord(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge metadata must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(record, key))) {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge metadata fields do not match the contract.");
  }
  return record;
}

function boundedText(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BridgeBrowserRequestError(400, "invalid_request", `${name} is invalid.`);
  }
  return value;
}

function publicationMetadata(value: unknown, creating: boolean): PublicationMetadata {
  const allowed = ["target", "sequence", "workspaceId", "revision", "exchangeDigest", "manifest", "ttlMs"];
  const required = ["sequence", "workspaceId", "revision", "exchangeDigest", "manifest", ...(creating ? ["target"] : [])];
  const body = exactRecord(value, allowed, required);
  if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1
    || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge sequence or revision is invalid.");
  }
  if (typeof body.exchangeDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(body.exchangeDigest)) {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge exchange digest is invalid.");
  }
  if (body.target !== undefined && !TARGETS.includes(body.target as SemaFrameBridgeTarget)) {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge target is invalid.");
  }
  if (body.ttlMs !== undefined && (!Number.isSafeInteger(body.ttlMs)
    || Number(body.ttlMs) < 1_000 || Number(body.ttlMs) > BRIDGE_SESSION_LIMITS.maximumTtlMs)) {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge TTL is invalid.");
  }
  const manifest = body.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge manifest is invalid.");
  }
  const typedManifest = manifest as Partial<SemaFrameExchangeManifest>;
  if (typedManifest.format !== SEMAFRAME_EXCHANGE_FORMAT
    || typedManifest.version !== SEMAFRAME_EXCHANGE_VERSION
    || !typedManifest.source || typeof typedManifest.source !== "object") {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge manifest format is unsupported.");
  }
  return Object.freeze({
    ...(body.target === undefined ? {} : { target: body.target as SemaFrameBridgeTarget }),
    sequence: Number(body.sequence),
    workspaceId: boundedText(body.workspaceId, "workspaceId"),
    revision: Number(body.revision),
    exchangeDigest: body.exchangeDigest as SemaFrameSha256,
    manifest: manifest as SemaFrameExchangeManifest,
    ...(body.ttlMs === undefined ? {} : { ttlMs: Number(body.ttlMs) }),
  });
}

async function boundedBytes(request: Request, maximum: number): Promise<Uint8Array> {
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new BridgeBrowserRequestError(415, "invalid_content_encoding", "Compressed Bridge request bodies are not supported.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
      throw new BridgeBrowserRequestError(413, "body_too_large", "Bridge request body is too large.");
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new BridgeBrowserRequestError(413, "body_too_large", "Bridge request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function multipartPublication(request: Request, creating: boolean): Promise<Readonly<{
  metadata: PublicationMetadata;
  publication: BridgePublication;
}>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data"
    || !/;\s*boundary=(?:"[^"]+"|[^;\s]+)(?:\s*;|\s*$)/iu.test(contentType)) {
    throw new BridgeBrowserRequestError(415, "invalid_content_type", "Use multipart/form-data.");
  }
  const bytes = await boundedBytes(request, BRIDGE_BROWSER_LIVE_ARCHIVE_LIMIT + METADATA_LIMIT + 1024 * 1024);
  let form: FormData;
  try {
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    form = await new Request("http://semaframe.local/bridge", {
      method: "POST",
      headers: { "content-type": contentType },
      body: owned.buffer,
    }).formData();
  } catch {
    throw new BridgeBrowserRequestError(400, "invalid_multipart", "Bridge multipart body is invalid.");
  }
  const keys = [...form.keys()];
  if (keys.length !== 2 || keys.filter((key) => key === "metadata").length !== 1
    || keys.filter((key) => key === "archive").length !== 1) {
    throw new BridgeBrowserRequestError(400, "invalid_multipart", "Bridge multipart body must contain one metadata and one archive field.");
  }
  const metadataValue = form.get("metadata");
  const archiveValue = form.get("archive");
  if (typeof metadataValue !== "string" || new TextEncoder().encode(metadataValue).byteLength > METADATA_LIMIT
    || !(archiveValue instanceof Blob) || archiveValue.size > BRIDGE_BROWSER_LIVE_ARCHIVE_LIMIT) {
    throw new BridgeBrowserRequestError(400, "invalid_multipart", "Bridge multipart fields are invalid.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(metadataValue) as unknown;
  } catch {
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge metadata must be valid JSON.");
  }
  const metadata = publicationMetadata(decoded, creating);
  const archive = new Uint8Array(await archiveValue.arrayBuffer());
  return Object.freeze({
    metadata,
    publication: Object.freeze({
      sequence: metadata.sequence,
      workspaceId: metadata.workspaceId,
      revision: metadata.revision,
      exchangeDigest: metadata.exchangeDigest,
      manifest: metadata.manifest,
      archive,
    }),
  });
}

async function smallJson(
  request: Request,
  allowed: readonly string[],
  required: readonly string[] = [],
): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new BridgeBrowserRequestError(415, "invalid_content_type", "Use application/json.");
  }
  const bytes = await boundedBytes(request, JSON_BODY_LIMIT);
  try {
    return exactRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, allowed, required);
  } catch (error) {
    if (error instanceof BridgeBrowserRequestError) throw error;
    throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge request body must be valid JSON.");
  }
}

function serviceStatus(error: BridgeSessionError): number {
  if (error.code === "unauthorized") return 403;
  if (error.code === "session_not_found") return 404;
  if (error.code === "session_expired") return 410;
  if (error.code === "capacity_exceeded") return 429;
  if (error.code === "proposal_mismatch" || error.code === "stale_publication") return 409;
  return 422;
}

function response(status: number, value: unknown, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function sessionUrls(publicBaseUrl: string, sessionId: string) {
  const pullUrl = new URL(`/v1/bridge/sessions/${sessionId}`, publicBaseUrl).toString();
  return Object.freeze({ pullUrl, exchangeUrl: `${pullUrl}/exchange` });
}

/** Trusted local-browser owner surface. Outer gateway code enforces origin, bootstrap and CSRF. */
export function createBridgeBrowserHttpHandler(
  service: BridgeSessionService,
  options: Readonly<{ publicBaseUrl: string }>,
) {
  const publicBaseUrl = new URL(options.publicBaseUrl).origin;
  return Object.freeze({
    matches: (pathname: string) => pathname === BRIDGE_BROWSER_HTTP_PREFIX
      || pathname.startsWith(`${BRIDGE_BROWSER_HTTP_PREFIX}/`),
    fetch: async (
      request: Request,
      ownerId: string,
      extraHeaders: HeadersInit = {},
    ): Promise<Response> => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      try {
        if (url.search) {
          throw new BridgeBrowserRequestError(400, "invalid_request", "Bridge owner routes do not accept query parameters.");
        }
        if (pathname === BRIDGE_BROWSER_HTTP_PREFIX) {
          if (request.method !== "POST") throw new BridgeBrowserRequestError(405, "method_not_allowed", "Use POST.");
          const { metadata, publication } = await multipartPublication(request, true);
          const access = service.create(
            ownerId,
            metadata.target!,
            publication,
            metadata.ttlMs ?? BRIDGE_SESSION_LIMITS.defaultTtlMs,
          );
          return response(201, { ...access, ...sessionUrls(publicBaseUrl, access.sessionId) }, extraHeaders);
        }
        const match = new RegExp(`^${BRIDGE_BROWSER_HTTP_PREFIX}/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/(inspect|publish|proposals/read|proposals/discard|close)$`, "iu").exec(pathname);
        if (!match) throw new BridgeBrowserRequestError(404, "not_found", "Bridge owner route was not found.");
        if (request.method !== "POST") throw new BridgeBrowserRequestError(405, "method_not_allowed", "Use POST.");
        const [, sessionId, action] = match;
        if (action === "publish") {
          const { publication } = await multipartPublication(request, false);
          return response(200, service.publish(ownerId, sessionId, publication), extraHeaders);
        }
        if (action === "inspect") {
          await smallJson(request, []);
          return response(200, service.inspect(ownerId, sessionId), extraHeaders);
        }
        if (action === "proposals/read") {
          const body = await smallJson(request, ["afterCursor"]);
          const afterCursor = body.afterCursor === undefined ? 0 : body.afterCursor;
          if (!Number.isSafeInteger(afterCursor) || Number(afterCursor) < 0) {
            throw new BridgeBrowserRequestError(400, "invalid_request", "afterCursor is invalid.");
          }
          return response(200, { proposals: service.readProposals(ownerId, sessionId, Number(afterCursor)) }, extraHeaders);
        }
        if (action === "proposals/discard") {
          const body = await smallJson(request, ["throughCursor"], ["throughCursor"]);
          if (!Number.isSafeInteger(body.throughCursor) || Number(body.throughCursor) < 0) {
            throw new BridgeBrowserRequestError(400, "invalid_request", "throughCursor is invalid.");
          }
          service.discardProposals(ownerId, sessionId, Number(body.throughCursor));
          return response(200, { discardedThroughCursor: Number(body.throughCursor) }, extraHeaders);
        }
        await smallJson(request, []);
        service.close(ownerId, sessionId);
        return response(200, { closed: true }, extraHeaders);
      } catch (error) {
        if (error instanceof BridgeBrowserRequestError) {
          return response(error.status, { error: { code: error.code, message: error.message } }, extraHeaders);
        }
        if (error instanceof BridgeSessionError) {
          return response(serviceStatus(error), { error: { code: error.code, message: error.message } }, extraHeaders);
        }
        return response(500, { error: { code: "bridge_error", message: "Bridge owner request failed." } }, extraHeaders);
      }
    },
  });
}
