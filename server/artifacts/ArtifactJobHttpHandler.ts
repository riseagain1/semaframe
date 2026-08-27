import { Buffer } from "node:buffer";
import type { ExtensionJsonValue } from "../../src/extensions";
import type {
  ArtifactJobScopeV1,
  ArtifactJobSnapshotV1,
  ArtifactJobSubmitRequestV1,
} from "../../src/workspace/artifacts";
import {
  ArtifactJobServiceError,
  type ArtifactJobService,
} from "./ArtifactJobService";

export const ARTIFACT_JOB_HTTP_PREFIX = "/api/agent/artifacts/jobs" as const;
export const ARTIFACT_JOB_HTTP_DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024;
export const ARTIFACT_JOB_HTTP_DEFAULT_MAX_WAIT_MS = 30_000;

const MAX_CONFIGURED_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_WAIT_MS = 60_000;
const WAIT_BODY_LIMIT = 4 * 1024;
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/u;

export type ArtifactJobHttpContext = Readonly<{
  /** Identity established by the outer, browser-authenticated gateway. */
  ownerId: string;
  /** Workspace established by the outer gateway, never accepted from JSON. */
  workspaceId: string;
  /** Optional narrowing for a provider-scoped outer capability. */
  providerId?: string;
  /** Host-resolved extension grant. It is never read from a request header/body. */
  extensionGrantToken?: string;
}>;

export type ArtifactJobHttpHandlerOptions = Readonly<{
  maxJsonBodyBytes?: number;
  maxWaitMs?: number;
}>;

export type ArtifactJobHttpHandler = (
  request: Request,
  context: ArtifactJobHttpContext,
) => Promise<Response | undefined>;

class ArtifactJobHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactJobHttpError";
  }
}

function securityHeaders(contentType = "application/json; charset=utf-8"): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function json(status: number, value: unknown, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...securityHeaders(), ...extraHeaders },
  });
}

function methodNotAllowed(allowed: readonly string[]): Response {
  return json(405, { error: { code: "method_not_allowed", message: "Method not allowed." } }, {
    allow: allowed.join(", "),
  });
}

function boundedConfiguration(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${name} must be a positive bounded integer.`);
  }
  return resolved;
}

function trustedText(value: string, name: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
}

function validateContext(context: ArtifactJobHttpContext): void {
  if (!context || typeof context !== "object") throw new TypeError("Artifact HTTP context is required.");
  trustedText(context.ownerId, "Artifact owner context");
  trustedText(context.workspaceId, "Artifact workspace context");
  if (context.providerId !== undefined && !PROVIDER_ID.test(context.providerId)) {
    throw new TypeError("Artifact provider context is invalid.");
  }
  if (context.extensionGrantToken !== undefined
    && (typeof context.extensionGrantToken !== "string"
      || context.extensionGrantToken.length < 16
      || context.extensionGrantToken.length > 256
      || /[\u0000-\u001f\u007f]/u.test(context.extensionGrantToken))) {
    throw new TypeError("Artifact extension grant context is invalid.");
  }
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactJobHttpError(400, "invalid_request", "Artifact request must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(record, key))) {
    throw new ArtifactJobHttpError(400, "invalid_request", "Artifact request fields do not match the contract.");
  }
  return record;
}

function jsonValue(value: unknown): ExtensionJsonValue {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 64) {
      throw new ArtifactJobHttpError(400, "invalid_request", "Artifact JSON exceeds its depth limit.");
    }
    if (current.value === null
      || typeof current.value === "string"
      || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        throw new ArtifactJobHttpError(400, "invalid_request", "Artifact JSON contains a non-finite number.");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const nested of current.value) pending.push({ value: nested, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value === "object") {
      for (const nested of Object.values(current.value as Record<string, unknown>)) {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
      continue;
    }
    throw new ArtifactJobHttpError(400, "invalid_request", "Artifact request contains a non-JSON value.");
  }
  return value as ExtensionJsonValue;
}

async function boundedJson(request: Request, maximum: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ArtifactJobHttpError(415, "invalid_content_type", "Use application/json.");
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new ArtifactJobHttpError(415, "unsupported_content_encoding", "Compressed request bodies are not supported.");
  }
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new ArtifactJobHttpError(400, "invalid_request", "Content-Length is invalid.");
    }
    if (declared > maximum) {
      throw new ArtifactJobHttpError(413, "body_too_large", "Artifact request body is too large.");
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ArtifactJobHttpError(400, "invalid_request", "Artifact request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new ArtifactJobHttpError(413, "body_too_large", "Artifact request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length < 1) throw new ArtifactJobHttpError(400, "invalid_request", "Artifact request body is required.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArtifactJobHttpError(400, "invalid_request", "Artifact request body must be UTF-8 JSON.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ArtifactJobHttpError(400, "invalid_request", "Artifact request body must be valid JSON.");
  }
}

function ensureNoBody(request: Request): void {
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new ArtifactJobHttpError(400, "invalid_request", "Content-Length is invalid.");
    }
    if (declared > 0) {
      throw new ArtifactJobHttpError(400, "unexpected_body", "This artifact endpoint does not accept a request body.");
    }
  }
  if (request.body !== null) {
    throw new ArtifactJobHttpError(400, "unexpected_body", "This artifact endpoint does not accept a request body.");
  }
}

function decodeSegment(raw: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw new ArtifactJobHttpError(404, "not_found", "Artifact endpoint was not found.");
  }
  if (!value || value === "." || value === ".." || /[\\/\u0000-\u001f\u007f]/u.test(value)) {
    throw new ArtifactJobHttpError(404, "not_found", "Artifact endpoint was not found.");
  }
  return value;
}

function providerFromSegment(raw: string): string {
  const value = decodeSegment(raw);
  if (value.length > 128 || !PROVIDER_ID.test(value)) {
    throw new ArtifactJobHttpError(404, "not_found", "Artifact endpoint was not found.");
  }
  return value;
}

function jobFromSegment(raw: string): string {
  const value = decodeSegment(raw);
  if (!JOB_ID.test(value)) throw new ArtifactJobHttpError(404, "not_found", "Artifact endpoint was not found.");
  return value;
}

function artifactFromSegment(raw: string): string {
  const value = decodeSegment(raw);
  if (!ARTIFACT_ID.test(value)) throw new ArtifactJobHttpError(404, "not_found", "Artifact endpoint was not found.");
  return value;
}

function assertProviderAccess(context: ArtifactJobHttpContext, providerId: string): void {
  if (context.providerId !== undefined && context.providerId !== providerId) {
    throw new ArtifactJobHttpError(404, "not_found", "Artifact job was not found.");
  }
}

function scope(context: ArtifactJobHttpContext, providerId: string): ArtifactJobScopeV1 {
  assertProviderAccess(context, providerId);
  return Object.freeze({
    ownerId: context.ownerId,
    workspaceId: context.workspaceId,
    providerId,
  });
}

function terminal(snapshot: ArtifactJobSnapshotV1): boolean {
  return snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "canceled";
}

function errorResponse(cause: unknown): Response {
  if (cause instanceof ArtifactJobHttpError) {
    return json(cause.status, { error: { code: cause.code, message: cause.message } });
  }
  if (!(cause instanceof ArtifactJobServiceError)) {
    return json(500, { error: { code: "artifact_service_error", message: "Artifact request failed." } });
  }
  if (cause.code === "invalid_request") {
    return json(400, { error: { code: cause.code, message: cause.message } });
  }
  if (cause.code === "provider_not_found") {
    return json(404, { error: { code: cause.code, message: "Artifact provider was not found." } });
  }
  if (cause.code === "job_not_found" || cause.code === "artifact_not_found") {
    return json(404, { error: { code: "not_found", message: "Artifact job or artifact was not found." } });
  }
  if (cause.code === "idempotency_mismatch" || cause.code === "job_not_terminal") {
    return json(409, { error: { code: cause.code, message: cause.message } });
  }
  if (cause.code === "capacity_exhausted") {
    return json(429, { error: { code: cause.code, message: cause.message } }, { "retry-after": "1" });
  }
  if (cause.code === "permission_required") {
    return json(403, { error: { code: cause.code, message: "Artifact provider permission is required." } });
  }
  if (cause.code === "artifact_digest_mismatch") {
    return json(500, { error: { code: "artifact_unavailable", message: "Artifact content is unavailable." } });
  }
  return json(500, { error: { code: "artifact_service_error", message: "Artifact service configuration failed." } });
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/["\\]/gu, "_");
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function artifactResponse(snapshot: ArtifactJobSnapshotV1, artifactId: string, bytes: Uint8Array): Response {
  const artifact = snapshot.artifacts.find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) {
    throw new ArtifactJobServiceError("artifact_not_found", "Artifact was not found for this job.");
  }
  const digestBase64 = Buffer.from(artifact.sha256.slice("sha256:".length), "hex").toString("base64");
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, {
    status: 200,
    headers: {
      ...securityHeaders(artifact.mediaType),
      "content-digest": `sha-256=:${digestBase64}:`,
      "content-disposition": contentDisposition(artifact.fileName),
      "content-length": String(artifact.byteLength),
      etag: `"${artifact.sha256}"`,
      "x-semaframe-content-sha256": artifact.sha256,
    },
  });
}

/**
 * Browser-owner artifact routes. Authentication and workspace selection belong
 * to the outer gateway; this adapter only narrows that established context.
 */
export function createArtifactJobHttpHandler(
  service: ArtifactJobService,
  options: ArtifactJobHttpHandlerOptions = {},
): ArtifactJobHttpHandler {
  const maxJsonBodyBytes = boundedConfiguration(
    options.maxJsonBodyBytes,
    ARTIFACT_JOB_HTTP_DEFAULT_MAX_JSON_BYTES,
    MAX_CONFIGURED_JSON_BYTES,
    "maxJsonBodyBytes",
  );
  const maxWaitMs = boundedConfiguration(
    options.maxWaitMs,
    ARTIFACT_JOB_HTTP_DEFAULT_MAX_WAIT_MS,
    MAX_CONFIGURED_WAIT_MS,
    "maxWaitMs",
  );

  return async (request: Request, context: ArtifactJobHttpContext): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== ARTIFACT_JOB_HTTP_PREFIX
      && !url.pathname.startsWith(`${ARTIFACT_JOB_HTTP_PREFIX}/`)) return undefined;

    try {
      validateContext(context);
      if (url.search) {
        throw new ArtifactJobHttpError(400, "invalid_request", "Artifact endpoints do not accept query parameters.");
      }
      const suffix = url.pathname.slice(ARTIFACT_JOB_HTTP_PREFIX.length);
      const segments = suffix === "" ? [] : suffix.slice(1).split("/");

      if (segments.length === 0) {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        const body = exactRecord(
          await boundedJson(request, maxJsonBodyBytes),
          ["requestId", "providerId", "input", "options"],
          ["requestId", "providerId", "input"],
        );
        if (typeof body.requestId !== "string" || typeof body.providerId !== "string") {
          throw new ArtifactJobHttpError(400, "invalid_request", "Artifact requestId or providerId is invalid.");
        }
        const providerId = body.providerId;
        if (providerId.length > 128 || !PROVIDER_ID.test(providerId)) {
          throw new ArtifactJobHttpError(400, "invalid_request", "Artifact providerId is invalid.");
        }
        assertProviderAccess(context, providerId);
        const submitRequest: ArtifactJobSubmitRequestV1 = {
          ownerId: context.ownerId,
          workspaceId: context.workspaceId,
          providerId,
          requestId: body.requestId,
          input: jsonValue(body.input),
          ...(Object.hasOwn(body, "options") ? { options: jsonValue(body.options) } : {}),
        };
        const snapshot = service.submit(
          submitRequest,
          context.extensionGrantToken === undefined ? undefined : { grantToken: context.extensionGrantToken },
        );
        return json(terminal(snapshot) ? 200 : 202, { ok: true, data: snapshot }, {
          location: `${ARTIFACT_JOB_HTTP_PREFIX}/${encodeURIComponent(providerId)}/${encodeURIComponent(snapshot.jobId)}`,
        });
      }

      if (segments.length < 2 || segments.length > 4 || segments.some((segment) => segment.length === 0)) {
        return json(404, { error: { code: "not_found", message: "Artifact endpoint was not found." } });
      }
      const providerId = providerFromSegment(segments[0]!);
      const jobId = jobFromSegment(segments[1]!);
      const jobScope = scope(context, providerId);

      if (segments.length === 2) {
        if (request.method === "GET") {
          ensureNoBody(request);
          return json(200, { ok: true, data: service.get(jobScope, jobId) });
        }
        if (request.method === "DELETE") {
          ensureNoBody(request);
          service.discard(jobScope, jobId);
          return new Response(null, { status: 204, headers: securityHeaders() });
        }
        return methodNotAllowed(["GET", "DELETE"]);
      }

      if (segments.length === 3 && segments[2] === "cancel") {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        ensureNoBody(request);
        const snapshot = service.cancel(jobScope, jobId);
        return json(terminal(snapshot) ? 200 : 202, { ok: true, data: snapshot });
      }

      if (segments.length === 3 && segments[2] === "wait") {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        const body = exactRecord(
          await boundedJson(request, Math.min(maxJsonBodyBytes, WAIT_BODY_LIMIT)),
          ["waitMs"],
          [],
        );
        if (body.waitMs !== undefined && typeof body.waitMs !== "number") {
          throw new ArtifactJobHttpError(400, "invalid_request", `waitMs must be between 1 and ${maxWaitMs}.`);
        }
        const waitMs = body.waitMs ?? maxWaitMs;
        if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > maxWaitMs) {
          throw new ArtifactJobHttpError(400, "invalid_request", `waitMs must be between 1 and ${maxWaitMs}.`);
        }
        try {
          const snapshot = await service.waitForTerminal(jobScope, jobId, waitMs);
          return json(200, { ok: true, data: snapshot });
        } catch (cause) {
          if (cause instanceof ArtifactJobServiceError && cause.code === "job_not_terminal") {
            return json(202, { ok: true, data: service.get(jobScope, jobId) }, { "retry-after": "1" });
          }
          throw cause;
        }
      }

      if (segments.length === 4 && segments[2] === "artifacts") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        ensureNoBody(request);
        const artifactId = artifactFromSegment(segments[3]!);
        const snapshot = service.get(jobScope, jobId);
        const bytes = service.readArtifact(jobScope, jobId, artifactId);
        return artifactResponse(snapshot, artifactId, bytes);
      }

      return json(404, { error: { code: "not_found", message: "Artifact endpoint was not found." } });
    } catch (cause) {
      return errorResponse(cause);
    }
  };
}
