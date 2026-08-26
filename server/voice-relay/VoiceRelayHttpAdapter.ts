import {
  VOICE_RELAY_HTTP_PATHS,
  parseVoiceRelayIdentifier,
  type VoiceRelayDiagnosticRequest,
} from "../../src/voice-relay";
import { VoiceRelayContractError } from "../../src/voice-relay";
import { VoiceRelayService, VoiceRelayServiceError } from "./VoiceRelayService";

const MAXIMUM_BODY_BYTES = 16 * 1024;
const STAGE_ACTION_PATH_PATTERN = /^\/stages\/([^/]+)\/(confirm|cancel|reply)$/u;
const SERVICE_ROUTE_PATHS = new Set<string>([
  VOICE_RELAY_HTTP_PATHS.prepareSetup,
  VOICE_RELAY_HTTP_PATHS.requestAccessibility,
  VOICE_RELAY_HTTP_PATHS.diagnostics,
  VOICE_RELAY_HTTP_PATHS.configureTarget,
  VOICE_RELAY_HTTP_PATHS.arm,
  VOICE_RELAY_HTTP_PATHS.disarm,
  VOICE_RELAY_HTTP_PATHS.stages,
]);

export type VoiceRelayHttpSurface = "desktop" | "xr";
export type VoiceRelayDesktopHostAction =
  | "voice_relay_accessibility"
  | "voice_relay_configure_target"
  | "voice_relay_draft_round_trip"
  | "voice_relay_arm";

export type VoiceRelayHttpAdapterOptions = Readonly<{
  /** Omitted on hosts without a supported native helper. Status still degrades safely. */
  service?: VoiceRelayService;
  /**
   * Gateway-owned authentication. Desktop must validate bootstrap, allowed
   * origin and CSRF; XR must validate the paired renderer session and role.
   */
  authorize(
    request: Request,
    surface: VoiceRelayHttpSurface,
  ): boolean | Readonly<{ ownerId: string }> | Promise<boolean | Readonly<{ ownerId: string }>>;
  /** Consumes a one-shot, user-confirmed desktop HostAction capability. */
  consumeDesktopHostAction(
    request: Request,
    action: VoiceRelayDesktopHostAction,
  ): boolean | Promise<boolean>;
}>;

export type VoiceRelayHttpHandler = Readonly<{
  matches(pathname: string): boolean;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}>;

class VoiceRelayHttpAdapterError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly recoverable = true) {
    super(message);
    this.name = "VoiceRelayHttpAdapterError";
  }
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof VoiceRelayServiceError) {
    return json(error.status, {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    });
  }
  if (error instanceof VoiceRelayContractError) {
    return json(400, { code: error.code, message: error.message, recoverable: true });
  }
  if (error instanceof VoiceRelayHttpAdapterError) {
    return json(error.status, { code: error.code, message: error.message, recoverable: error.recoverable });
  }
  return json(500, {
    code: "voice_relay_internal_error",
    message: "Voice Relay could not complete the request.",
    recoverable: true,
  });
}

const UNAVAILABLE_STATUS = Object.freeze({
  enabled: false,
  armed: false,
  phase: "off",
  error: Object.freeze({
    code: "voice_relay_unavailable",
    message: "Voice Relay is unavailable because this host has no supported native helper.",
    recoverable: false,
  }),
});

function exactObject(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new VoiceRelayHttpAdapterError(400, "invalid_request", "Request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedSet.has(key))
    || required.some((key) => !Object.hasOwn(body, key))) {
    throw new VoiceRelayHttpAdapterError(400, "invalid_request", "Request body fields are invalid.");
  }
  return body;
}

async function readJson(request: Request): Promise<unknown> {
  const essence = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (essence !== "application/json") {
    throw new VoiceRelayHttpAdapterError(415, "unsupported_media_type", "Use application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAXIMUM_BODY_BYTES) {
    throw new VoiceRelayHttpAdapterError(413, "body_too_large", "Voice Relay request is too large.");
  }
  if (!request.body) throw new VoiceRelayHttpAdapterError(400, "invalid_request", "A JSON body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAXIMUM_BODY_BYTES) {
      await reader.cancel();
      throw new VoiceRelayHttpAdapterError(413, "body_too_large", "Voice Relay request is too large.");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new VoiceRelayHttpAdapterError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

function surfaceAndRelativePath(pathname: string): Readonly<{
  surface: VoiceRelayHttpSurface;
  relative: string;
}> | undefined {
  for (const [surface, base] of [
    ["desktop", VOICE_RELAY_HTTP_PATHS.desktopBase],
    ["xr", VOICE_RELAY_HTTP_PATHS.xrBase],
  ] as const) {
    if (pathname === base) return { surface, relative: "" };
    if (pathname.startsWith(`${base}/`)) return { surface, relative: pathname.slice(base.length) };
  }
  return undefined;
}

function requireMethod(request: Request, method: "GET" | "POST"): void {
  if (request.method !== method) throw new VoiceRelayHttpAdapterError(405, "method_not_allowed", `Use ${method}.`);
}

async function requireAuthorization(
  options: VoiceRelayHttpAdapterOptions,
  request: Request,
  surface: VoiceRelayHttpSurface,
): Promise<Readonly<{ ownerId: string }> | undefined> {
  const authorization = await options.authorize(request, surface);
  if (!authorization || (surface === "xr" && authorization === true)) {
    await request.body?.cancel().catch(() => undefined);
    throw new VoiceRelayHttpAdapterError(403, "voice_relay_unauthorized", "Voice Relay authorization failed.", false);
  }
  if (surface === "desktop") return undefined;
  if (authorization === true) {
    throw new VoiceRelayHttpAdapterError(403, "voice_relay_unauthorized", "Voice Relay authorization failed.", false);
  }
  return Object.freeze({
    ownerId: parseVoiceRelayIdentifier(authorization.ownerId, "Voice Relay XR owner"),
  });
}

/**
 * Fetch adapter with separate desktop and paired-XR route allowlists. It never
 * interprets authentication headers itself; the embedding gateway owns those
 * transport facts and supplies the authorization callbacks above.
 */
export function createVoiceRelayHttpHandler(options: VoiceRelayHttpAdapterOptions): VoiceRelayHttpHandler {
  if (!options || typeof options.authorize !== "function" || typeof options.consumeDesktopHostAction !== "function") {
    throw new TypeError("Voice Relay HTTP authorization callbacks are required.");
  }

  return Object.freeze({
    matches(pathname: string): boolean {
      return surfaceAndRelativePath(pathname) !== undefined;
    },

    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        const route = surfaceAndRelativePath(url.pathname);
        if (!route || url.hash) throw new VoiceRelayHttpAdapterError(404, "not_found", "Voice Relay route was not found.");
        const owner = await requireAuthorization(options, request, route.surface);
        const { surface, relative } = route;
        const desktopOnly = new Set<string>([
          VOICE_RELAY_HTTP_PATHS.prepareSetup,
          VOICE_RELAY_HTTP_PATHS.requestAccessibility,
          VOICE_RELAY_HTTP_PATHS.diagnostics,
          VOICE_RELAY_HTTP_PATHS.configureTarget,
          VOICE_RELAY_HTTP_PATHS.arm,
          VOICE_RELAY_HTTP_PATHS.disarm,
        ]);
        if (surface === "xr" && desktopOnly.has(relative)) {
          throw new VoiceRelayHttpAdapterError(403, "desktop_action_required", "This Voice Relay action requires the trusted desktop.", false);
        }
        if (relative === VOICE_RELAY_HTTP_PATHS.status) {
          requireMethod(request, "POST");
          if (url.search) throw new VoiceRelayHttpAdapterError(400, "invalid_request", "Status does not accept query parameters.");
          exactObject(await readJson(request), [], []);
          return json(200, options.service?.inspect(owner) ?? UNAVAILABLE_STATUS);
        }
        if (!options.service) {
          const knownWithoutService = SERVICE_ROUTE_PATHS.has(relative)
            || STAGE_ACTION_PATH_PATTERN.test(relative);
          if (!knownWithoutService) {
            throw new VoiceRelayHttpAdapterError(404, "not_found", "Voice Relay route was not found.");
          }
          throw new VoiceRelayHttpAdapterError(
            503,
            "voice_relay_unavailable",
            "Voice Relay is unavailable because this host has no supported native helper.",
            false,
          );
        }
        if (relative === VOICE_RELAY_HTTP_PATHS.prepareSetup) {
          requireMethod(request, "POST");
          exactObject(await readJson(request), [], []);
          return json(200, await options.service.prepareSetup(request.signal));
        }
        if (relative === VOICE_RELAY_HTTP_PATHS.requestAccessibility) {
          requireMethod(request, "POST");
          exactObject(await readJson(request), [], []);
          if (!await options.consumeDesktopHostAction(request, "voice_relay_accessibility")) {
            throw new VoiceRelayHttpAdapterError(
              403,
              "host_action_confirmation_required",
              "Confirm the operating-system Accessibility permission flow on the desktop.",
            );
          }
          return json(200, await options.service.requestAccessibility(request.signal));
        }
        if (relative === VOICE_RELAY_HTTP_PATHS.diagnostics) {
          requireMethod(request, "POST");
          const body = exactObject(await readJson(request), ["performDraftRoundTrip"], []);
          if (body.performDraftRoundTrip !== undefined && typeof body.performDraftRoundTrip !== "boolean") {
            throw new VoiceRelayHttpAdapterError(400, "invalid_request", "performDraftRoundTrip must be boolean.");
          }
          const diagnosticRequest: VoiceRelayDiagnosticRequest = {
            ...(body.performDraftRoundTrip === true ? { performDraftRoundTrip: true } : {}),
          };
          if (diagnosticRequest.performDraftRoundTrip
            && !await options.consumeDesktopHostAction(request, "voice_relay_draft_round_trip")) {
            throw new VoiceRelayHttpAdapterError(
              403,
              "host_action_confirmation_required",
              "Confirm the no-send Agent composer test on the desktop.",
              true,
            );
          }
          return json(200, await options.service.runDiagnostics(diagnosticRequest, request.signal));
        }
        if (relative === VOICE_RELAY_HTTP_PATHS.configureTarget) {
          requireMethod(request, "POST");
          const body = exactObject(await readJson(request), ["candidateId"]);
          if (!await options.consumeDesktopHostAction(request, "voice_relay_configure_target")) {
            throw new VoiceRelayHttpAdapterError(
              403,
              "host_action_confirmation_required",
              "Confirm the exact Agent window target on the desktop.",
            );
          }
          return json(200, await options.service.configureTarget({
            candidateId: parseVoiceRelayIdentifier(body.candidateId, "candidateId"),
          }, request.signal));
        }
        if (relative === VOICE_RELAY_HTTP_PATHS.arm) {
          requireMethod(request, "POST");
          const body = exactObject(await readJson(request), ["targetId"], []);
          if (!await options.consumeDesktopHostAction(request, "voice_relay_arm")) {
            throw new VoiceRelayHttpAdapterError(403, "host_action_confirmation_required", "Confirm Voice Relay arming on the desktop.");
          }
          return json(200, await options.service.arm(
            body.targetId === undefined ? undefined : parseVoiceRelayIdentifier(body.targetId, "targetId"),
            request.signal,
          ));
        }
        if (relative === VOICE_RELAY_HTTP_PATHS.disarm) {
          requireMethod(request, "POST");
          exactObject(await readJson(request), [], []);
          return json(200, await options.service.disarm(request.signal));
        }
        if (relative === VOICE_RELAY_HTTP_PATHS.stages) {
          requireMethod(request, "POST");
          const body = exactObject(await readJson(request), ["utteranceId", "text", "ttlMs"], ["utteranceId", "text"]);
          if (typeof body.text !== "string"
            || (body.ttlMs !== undefined && (typeof body.ttlMs !== "number" || !Number.isSafeInteger(body.ttlMs)))) {
            throw new VoiceRelayHttpAdapterError(400, "invalid_request", "Voice Relay stage fields are invalid.");
          }
          return json(200, await options.service.stage({
            utteranceId: parseVoiceRelayIdentifier(body.utteranceId, "utteranceId"),
            text: body.text,
            ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
          }, request.signal, owner));
        }
        const match = STAGE_ACTION_PATH_PATTERN.exec(relative);
        if (!match) throw new VoiceRelayHttpAdapterError(404, "not_found", "Voice Relay route was not found.");
        let stageId: string;
        try {
          stageId = parseVoiceRelayIdentifier(decodeURIComponent(match[1]!), "stageId");
        } catch {
          throw new VoiceRelayHttpAdapterError(400, "invalid_request", "Voice Relay stage identifier is invalid.");
        }
        const action = match[2]!;
        if (action === "reply") {
          requireMethod(request, "POST");
          if (url.search) throw new VoiceRelayHttpAdapterError(400, "invalid_request", "Reply does not accept query parameters.");
          const body = exactObject(await readJson(request), ["afterSequence"], []);
          const afterSequence = body.afterSequence ?? 0;
          if (typeof afterSequence !== "number" || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
            throw new VoiceRelayHttpAdapterError(400, "invalid_request", "afterSequence is invalid.");
          }
          return json(200, await options.service.readReply(stageId, afterSequence, request.signal, owner));
        }
        requireMethod(request, "POST");
        exactObject(await readJson(request), [], []);
        return json(200, action === "confirm"
          ? await options.service.confirm(stageId, request.signal, owner)
          : await options.service.cancel(stageId, request.signal, owner));
      } catch (cause) {
        return errorResponse(cause);
      }
    },

    close(): Promise<void> {
      return options.service?.close() ?? Promise.resolve();
    },
  });
}
