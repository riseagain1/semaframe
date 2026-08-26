import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  XR_PROTOCOL_LIMITS,
  XR_RELAY_PROTOCOL_VERSION,
  XR_SESSION_CONTROL_CHANNEL,
  XR_SESSION_PRESENCE_CHANNEL,
  XrProtocolValidationError,
  parseXrTargetedExitRequest,
  parseXrViewerPresence,
  parseXrOpaqueId,
  parseXrReconnectCursor,
  parseXrRelayMessage,
  parseXrWorkspaceId,
  type XrAckMessage,
  type XrDeltaMessage,
  type XrEphemeralMessage,
  type XrErrorCode,
  type XrErrorMessage,
  type XrInputMessage,
  type XrRoutableMessage,
  type XrSessionRole,
  type XrSnapshotMessage,
} from "../../src/xr/protocol";
import {
  XR_INPUT_RESULT_CHANNEL,
  parseXrInputResult,
} from "../../src/xr/authority/XrInputResult";
import {
  XrPairingError,
  XrPairingStore,
  type XrPairingGrant,
} from "./XrPairingStore";

const DEFAULT_MAXIMUM_DELTA_HISTORY = 128;
const DEFAULT_MAXIMUM_OUTBOX_MESSAGES = 512;
const DEFAULT_MAXIMUM_REQUEST_HISTORY = 512;
const DEFAULT_MAXIMUM_RENDERER_SESSIONS = 16;
const MAXIMUM_FAILED_PAIRING_CODE_ATTEMPTS = 5;
const PAIRING_CODE_FAILURE_WINDOW_MS = 60_000;
const RENDERER_SESSION_IDLE_TIMEOUT_MS = 10_000;
const SESSION_BEARER_BYTES = 32;
const MAXIMUM_OUTBOX_BYTES = XR_PROTOCOL_LIMITS.maximumControlResponseBytes * 2;
const MAXIMUM_OPAQUE_ID = "x".repeat(128);
// Leave one maximum control envelope for HTTP framing and future metadata.
// The full reconnect plan is the largest plan; delta-only/current plans are
// strict subsets of this byte budget.
const MAXIMUM_RECONNECT_PLAN_BYTES = XR_PROTOCOL_LIMITS.maximumControlResponseBytes
  - XR_PROTOCOL_LIMITS.maximumControlBytes;

const SESSION_BEARER_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const EMPTY_BEARER_DIGEST = Buffer.alloc(32);

function isPendingInputResult(message: XrRoutableMessage): boolean {
  return message.messageType === "ephemeral" && message.channel === XR_INPUT_RESULT_CHANNEL;
}

export type XrRelaySession = Readonly<{
  sessionId: string;
  role: XrSessionRole;
  authorityEpoch: string;
  workspaceId: string;
  connectedAtMs: number;
  pairingId?: string;
  capabilities?: Readonly<{ voiceRelay: boolean }>;
}>;

export type XrRelayConnection = XrRelaySession & Readonly<{
  /** Returned on creation or exact idempotent recovery. The relay stores only its SHA-256 digest. */
  sessionBearer: string;
}>;

export type XrRelayCredential = Readonly<{
  sessionId: string;
  sessionBearer: string;
}>;

type MutableSession = {
  sessionId: string;
  role: XrSessionRole;
  authorityEpoch: string;
  workspaceId: string;
  connectedAtMs: number;
  lastSeenAtMs: number;
  pairingId?: string;
  voiceRelay?: boolean;
};

type RequestRecord = Readonly<{
  fingerprint: string;
}>;

type EphemeralSequenceRecord = Readonly<{
  sequence: number;
  requestId: string;
  fingerprint: string;
}>;

type InputRouteRecord = Readonly<{
  rendererSessionId: string;
  fingerprint: string;
  inputType: XrInputMessage["inputType"];
  workspaceRevision: number;
  utteranceId?: string;
  completed: boolean;
}>;

type RelayState = {
  revision: number;
  snapshotDigest: `sha256:${string}`;
  baselineSnapshot: XrSnapshotMessage;
  deltas: XrDeltaMessage[];
  revisionDigests: Map<number, `sha256:${string}`>;
};

type XrRelayDeliveryBase = Readonly<{
  deliveryId: string;
  message: XrRoutableMessage;
}>;

type XrQueuedRelayDelivery = XrRelayDeliveryBase & (
  | Readonly<{
      /** Authenticated renderer sender recorded when the relay accepts the delivery. */
      sourceSessionId: string;
      serverReceivedAtMs: number;
    }>
  | Readonly<{
      sourceSessionId?: never;
      serverReceivedAtMs?: never;
    }>
);

export type XrRelayDelivery = XrRelayDeliveryBase & (
  | Readonly<{
  /**
   * Relay-authenticated sender provenance. This exists only on deliveries
   * routed from an authenticated renderer to the authority; message.sessionId
   * remains bound to the recipient transport.
   */
      sourceSessionId: string;
      /** Relay-clock acceptance time, for provenance and diagnostics only. */
      serverReceivedAtMs: number;
      /** Elapsed relay queue time computed again for every authority poll. */
      serverQueueAgeMs: number;
    }>
  | Readonly<{
      sourceSessionId?: never;
      serverReceivedAtMs?: never;
      serverQueueAgeMs?: never;
    }>
);

export type XrRendererRemovalEvent = Readonly<{
  session: XrRelaySession;
  reason: "disconnected" | "expired";
}>;

export type XrRendererRemovalListener = (
  event: XrRendererRemovalEvent,
) => void | Promise<void>;

export type XrReconnectPlan =
  | Readonly<{
      kind: "unavailable";
      reason: "authority_unavailable" | "awaiting_snapshot";
      workspaceId: string;
      requestId: string;
    }>
  | Readonly<{
      kind: "current";
      authorityEpoch: string;
      workspaceId: string;
      revision: number;
      snapshotDigest: `sha256:${string}`;
      requestId: string;
    }>
  | Readonly<{
      kind: "deltas";
      authorityEpoch: string;
      workspaceId: string;
      fromRevision: number;
      revision: number;
      snapshotDigest: `sha256:${string}`;
      requestId: string;
      deltas: readonly XrDeltaMessage[];
    }>
  | Readonly<{
      kind: "full_snapshot";
      authorityEpoch: string;
      workspaceId: string;
      revision: number;
      snapshotDigest: `sha256:${string}`;
      requestId: string;
      snapshot: XrSnapshotMessage;
      deltas: readonly XrDeltaMessage[];
    }>;

export type XrRelayOptions = Readonly<{
  now?: () => number;
  idFactory?: (kind: "session" | "epoch" | "request") => string;
  sessionBearerFactory?: () => string;
  pairingStore?: XrPairingStore;
  maximumDeltaHistory?: number;
  maximumOutboxMessages?: number;
  maximumRequestHistory?: number;
  maximumRendererSessions?: number;
}>;

export class XrRelayControlError extends Error {
  constructor(
    readonly code:
      | "invalid_control_request"
      | "authority_already_connected"
      | "authority_required"
      | "session_not_found"
      | "session_unauthorized"
      | "role_not_allowed"
      | "workspace_mismatch"
      | "pairing_invalid"
      | "pairing_rate_limited"
      | "renderer_capacity",
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "XrRelayControlError";
  }
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new XrRelayControlError("invalid_control_request", "XR relay control input must be an object.");
  }
  const body = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedSet.has(key))) {
    throw new XrRelayControlError("invalid_control_request", "XR relay control input contains an unknown field.");
  }
  if (required.some((key) => !Object.hasOwn(body, key))) {
    throw new XrRelayControlError("invalid_control_request", "XR relay control input is missing a required field.");
  }
  return body;
}

function checkedLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 10_000) {
    throw new RangeError(`${name} must be an integer between 1 and 10000.`);
  }
  return result;
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("XR relay clock returned an invalid time.");
  return value;
}

function publicSession(session: MutableSession): XrRelaySession {
  return Object.freeze({
    sessionId: session.sessionId,
    role: session.role,
    authorityEpoch: session.authorityEpoch,
    workspaceId: session.workspaceId,
    connectedAtMs: session.connectedAtMs,
    ...(session.pairingId ? { pairingId: session.pairingId } : {}),
    ...(session.role === "xr_renderer"
      ? { capabilities: Object.freeze({ voiceRelay: session.voiceRelay === true }) }
      : {}),
  });
}

function publicConnection(session: MutableSession, sessionBearer: string): XrRelayConnection {
  return Object.freeze({
    ...publicSession(session),
    sessionBearer,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(recordValue[key])}`)
    .join(",")}}`;
}

function messageFingerprint(message: XrRoutableMessage): string {
  return createHash("sha256").update(canonicalJson(message), "utf8").digest("hex");
}

function checkedSessionBearer(value: unknown): string {
  if (typeof value !== "string" || !SESSION_BEARER_PATTERN.test(value)) {
    throw new XrRelayControlError("session_unauthorized", "XR session credential is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== SESSION_BEARER_BYTES || decoded.toString("base64url") !== value) {
    throw new XrRelayControlError("session_unauthorized", "XR session credential is invalid.");
  }
  return value;
}

function bearerDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class XrRelay {
  readonly #now: () => number;
  readonly #idFactory: NonNullable<XrRelayOptions["idFactory"]>;
  readonly #sessionBearerFactory: NonNullable<XrRelayOptions["sessionBearerFactory"]>;
  readonly #authorityRecoverySecret = randomBytes(32);
  readonly #pairingStore: XrPairingStore;
  readonly #maximumDeltaHistory: number;
  readonly #maximumOutboxMessages: number;
  readonly #maximumRequestHistory: number;
  readonly #maximumRendererSessions: number;
  readonly #sessions = new Map<string, MutableSession>();
  readonly #sessionBearerDigests = new Map<string, Buffer>();
  readonly #rendererSessionByPairingId = new Map<string, string>();
  readonly #pairingScopes = new Map<string, {
    workspaceId: string;
    authorityEpoch: string;
    voiceRelay: boolean;
  }>();
  readonly #outboxes = new Map<string, XrQueuedRelayDelivery[]>();
  readonly #outboxBytes = new Map<string, number>();
  readonly #requestHistory = new Map<string, Map<string, RequestRecord>>();
  readonly #ephemeralSequences = new Map<string, Map<string, EphemeralSequenceRecord>>();
  // Targets are derived only from the authenticated renderer that submitted an
  // input. The authority result payload never gets to choose a recipient.
  readonly #inputRoutes = new Map<string, InputRouteRecord>();
  readonly #rendererRemovalListeners = new Set<XrRendererRemovalListener>();
  readonly #rendererRemovalCleanups = new Set<Promise<void>>();
  readonly #rendererRemovalFailures: unknown[] = [];
  readonly #failedPairingCodeAttempts: number[] = [];
  #authority?: MutableSession;
  #state?: RelayState;

  constructor(options: XrRelayOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
    this.#sessionBearerFactory = options.sessionBearerFactory
      ?? (() => randomBytes(SESSION_BEARER_BYTES).toString("base64url"));
    this.#pairingStore = options.pairingStore ?? new XrPairingStore({ now: this.#now });
    this.#maximumDeltaHistory = checkedLimit(
      options.maximumDeltaHistory,
      DEFAULT_MAXIMUM_DELTA_HISTORY,
      "maximumDeltaHistory",
    );
    this.#maximumOutboxMessages = checkedLimit(
      options.maximumOutboxMessages,
      DEFAULT_MAXIMUM_OUTBOX_MESSAGES,
      "maximumOutboxMessages",
    );
    this.#maximumRequestHistory = checkedLimit(
      options.maximumRequestHistory,
      DEFAULT_MAXIMUM_REQUEST_HISTORY,
      "maximumRequestHistory",
    );
    this.#maximumRendererSessions = checkedLimit(
      options.maximumRendererSessions,
      DEFAULT_MAXIMUM_RENDERER_SESSIONS,
      "maximumRendererSessions",
    );
  }

  connectAuthority(value: unknown): XrRelayConnection {
    const body = exactRecord(value, ["workspaceId", "requestId"], ["workspaceId"]);
    let workspaceId: string;
    let connectRequestId: string | undefined;
    try {
      workspaceId = parseXrWorkspaceId(body.workspaceId, "$.workspaceId");
      connectRequestId = body.requestId === undefined
        ? undefined
        : parseXrOpaqueId(body.requestId, "$.requestId");
    } catch (cause) {
      throw new XrRelayControlError("invalid_control_request", "XR authority Workspace is invalid.", { cause });
    }
    if (this.#authority) {
      if (connectRequestId !== undefined
        && workspaceId === this.#authority.workspaceId) {
        const recoverableBearer = this.#recoverableAuthorityBearer(this.#authority, connectRequestId);
        const storedDigest = this.#sessionBearerDigests.get(this.#authority.sessionId);
        if (storedDigest && timingSafeEqual(storedDigest, bearerDigest(recoverableBearer))) {
          return publicConnection(this.#authority, recoverableBearer);
        }
      }
      throw new XrRelayControlError(
        "authority_already_connected",
        "An XR Workspace authority is already connected.",
      );
    }
    const authorityEpoch = this.#newId("epoch");
    const connectedAtMs = checkedNow(this.#now);
    const session: MutableSession = {
      sessionId: this.#newId("session"),
      role: "authority",
      authorityEpoch,
      workspaceId,
      connectedAtMs,
      lastSeenAtMs: connectedAtMs,
    };
    const sessionBearer = connectRequestId === undefined
      ? this.#newSessionBearer()
      : this.#recoverableAuthorityBearer(session, connectRequestId);
    this.#authority = session;
    this.#sessions.set(session.sessionId, session);
    this.#sessionBearerDigests.set(session.sessionId, bearerDigest(sessionBearer));
    this.#replaceOutbox(session.sessionId, []);
    this.#requestHistory.clear();
    this.#ephemeralSequences.clear();
    this.#inputRoutes.clear();
    this.#state = undefined;
    // A renderer identity is pinned to the authority epoch it paired with.
    // Never mutate that identity across a host restart; require a fresh,
    // user-visible one-time pairing instead.
    for (const renderer of this.#rendererSessions()) this.#removeRenderer(renderer.sessionId);
    return publicConnection(session, sessionBearer);
  }

  createPairing(authorityCredential: unknown, value: unknown = {}): XrPairingGrant {
    const authority = this.#requireAuthority(authorityCredential);
    const body = exactRecord(value, ["ttlMs", "voiceRelay"], []);
    if (body.voiceRelay !== undefined && typeof body.voiceRelay !== "boolean") {
      throw new XrRelayControlError("invalid_control_request", "XR pairing voiceRelay must be boolean.");
    }
    try {
      const pairing = this.#pairingStore.create({
        workspaceId: authority.workspaceId,
        authorityEpoch: authority.authorityEpoch,
        ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
      });
      this.#pairingScopes.set(pairing.pairingId, {
        workspaceId: pairing.workspaceId,
        authorityEpoch: pairing.authorityEpoch,
        voiceRelay: body.voiceRelay === true,
      });
      this.#prunePairingScopes();
      return pairing;
    } catch (cause) {
      if (cause instanceof XrPairingError) {
        throw new XrRelayControlError("pairing_invalid", cause.message, { cause });
      }
      throw cause;
    }
  }

  connectRenderer(value: unknown): XrRelayConnection {
    const body = exactRecord(value, ["pairingToken", "pairingCode"], []);
    const hasPairingToken = Object.hasOwn(body, "pairingToken");
    const hasPairingCode = Object.hasOwn(body, "pairingCode");
    if (hasPairingToken === hasPairingCode) {
      throw new XrRelayControlError(
        "invalid_control_request",
        "XR renderer connect requires exactly one pairing credential.",
      );
    }
    const authority = this.#authority;
    if (!authority) {
      throw new XrRelayControlError("authority_required", "The XR Workspace authority is unavailable.");
    }
    if (this.#rendererSessions().length >= this.#maximumRendererSessions) {
      throw new XrRelayControlError("renderer_capacity", "XR renderer session capacity is exhausted.");
    }
    // Validate the local capability generator before consuming the one-shot
    // pairing capability, so an adapter configuration error remains retryable.
    const sessionBearer = this.#newSessionBearer();
    if (hasPairingCode) this.#requirePairingCodeAttempt();
    let consumed;
    try {
      consumed = hasPairingCode
        ? this.#pairingStore.consumeCode(body.pairingCode)
        : this.#pairingStore.consumeToken(body.pairingToken);
    } catch (cause) {
      if (hasPairingCode && cause instanceof XrPairingError) {
        this.#recordFailedPairingCodeAttempt();
      }
      throw new XrRelayControlError(
        "pairing_invalid",
        cause instanceof Error ? cause.message : "XR pairing failed.",
        { cause },
      );
    }
    if (hasPairingCode) this.#failedPairingCodeAttempts.length = 0;
    const scope = this.#pairingScopes.get(consumed.pairingId);
    if (!scope || consumed.workspaceId !== authority.workspaceId || consumed.authorityEpoch !== authority.authorityEpoch
      || scope.workspaceId !== authority.workspaceId || scope.authorityEpoch !== authority.authorityEpoch) {
      this.#pairingStore.revoke(consumed.pairingId);
      this.#pairingScopes.delete(consumed.pairingId);
      throw new XrRelayControlError("pairing_invalid", "XR pairing capability belongs to an inactive authority.");
    }
    const connectedAtMs = checkedNow(this.#now);
    const session: MutableSession = {
      sessionId: this.#newId("session"),
      role: "xr_renderer",
      authorityEpoch: authority.authorityEpoch,
      workspaceId: authority.workspaceId,
      connectedAtMs,
      lastSeenAtMs: connectedAtMs,
      pairingId: consumed.pairingId,
      voiceRelay: scope.voiceRelay,
    };
    this.#sessions.set(session.sessionId, session);
    this.#sessionBearerDigests.set(session.sessionId, bearerDigest(sessionBearer));
    this.#rendererSessionByPairingId.set(consumed.pairingId, session.sessionId);
    this.#replaceOutbox(session.sessionId, []);
    return publicConnection(session, sessionBearer);
  }

  revokePairing(authorityCredential: unknown, value: unknown): boolean {
    const authority = this.#requireAuthority(authorityCredential);
    const body = exactRecord(value, ["pairingId"], ["pairingId"]);
    let pairingId: string;
    try {
      pairingId = parseXrOpaqueId(body.pairingId, "$.pairingId");
    } catch (cause) {
      throw new XrRelayControlError("invalid_control_request", "XR pairing identifier is invalid.", { cause });
    }
    const pairing = this.#pairingScopes.get(pairingId);
    if (!pairing) return false;
    if (pairing.authorityEpoch !== authority.authorityEpoch || pairing.workspaceId !== authority.workspaceId) {
      throw new XrRelayControlError("pairing_invalid", "XR pairing capability belongs to another authority.");
    }
    const revoked = this.#pairingStore.revoke(pairingId);
    const rendererSessionId = this.#rendererSessionByPairingId.get(pairingId);
    if (rendererSessionId) this.#removeRenderer(rendererSessionId);
    this.#pairingScopes.delete(pairingId);
    return revoked || Boolean(rendererSessionId) || Boolean(pairing);
  }

  disconnectSession(credential: unknown): boolean {
    const session = this.#requireSession(credential);
    if (session.role === "authority") {
      this.#pairingStore.revokeAuthorityEpoch(session.authorityEpoch);
      for (const [pairingId, scope] of this.#pairingScopes) {
        if (scope.authorityEpoch === session.authorityEpoch
          && !this.#rendererSessionByPairingId.has(pairingId)) this.#pairingScopes.delete(pairingId);
      }
      this.#sessions.delete(session.sessionId);
      this.#sessionBearerDigests.delete(session.sessionId);
      this.#outboxes.delete(session.sessionId);
      this.#outboxBytes.delete(session.sessionId);
      this.#authority = undefined;
      this.#state = undefined;
      this.#requestHistory.clear();
      this.#ephemeralSequences.clear();
      this.#inputRoutes.clear();
      for (const renderer of this.#rendererSessions()) this.#removeRenderer(renderer.sessionId);
      return true;
    }
    this.#removeRenderer(session.sessionId);
    return true;
  }

  get authority(): XrRelaySession | undefined {
    return this.#authority ? publicSession(this.#authority) : undefined;
  }

  onRendererSessionRemoved(listener: XrRendererRemovalListener): () => void {
    this.#rendererRemovalListeners.add(listener);
    return () => { this.#rendererRemovalListeners.delete(listener); };
  }

  /** Waits for terminal adjacent-service cleanup started by renderer removal. */
  async drainRendererRemovals(): Promise<void> {
    while (this.#rendererRemovalCleanups.size > 0) {
      await Promise.all([...this.#rendererRemovalCleanups]);
    }
    const failures = this.#rendererRemovalFailures.splice(0);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "XR renderer removal cleanup failed.");
    }
  }

  getSession(sessionIdValue: unknown): XrRelaySession | undefined {
    let sessionId: string;
    try {
      sessionId = parseXrOpaqueId(sessionIdValue, "$.sessionId");
    } catch {
      return undefined;
    }
    const session = this.#sessions.get(sessionId);
    return session ? publicSession(session) : undefined;
  }

  /**
   * Authenticates a credential for an adjacent relay service such as the
   * content-addressed XR asset endpoint. The bearer itself is never returned.
   */
  authorizeSession(credential: unknown): XrRelaySession {
    return publicSession(this.#requireSession(credential));
  }

  /** Authorizes only a renderer whose one-time pairing enabled Voice Relay. */
  authorizeVoiceRelaySession(credential: unknown): XrRelaySession {
    const session = this.#requireSession(credential);
    if (session.role !== "xr_renderer" || session.voiceRelay !== true) {
      throw new XrRelayControlError("role_not_allowed", "This XR session is not allowed to use Voice Relay.");
    }
    return publicSession(session);
  }

  acceptMessage(credential: unknown, value: unknown): XrAckMessage | XrErrorMessage {
    const session = this.#requireSession(credential);
    let message;
    try {
      message = parseXrRelayMessage(value);
    } catch (cause) {
      return this.#error(
        session,
        this.#safeRequestId(value),
        "invalid_message",
        cause instanceof Error ? cause.message : "XR relay message is invalid.",
        false,
      );
    }
    if (message.sessionId !== session.sessionId) {
      return this.#error(session, message.requestId, "session_mismatch", "XR message session does not match its transport.", false);
    }
    const authority = this.#authority;
    if (!authority) {
      return this.#error(session, message.requestId, "authority_unavailable", "The XR Workspace authority is unavailable.", true);
    }
    if (message.workspaceId !== session.workspaceId || message.workspaceId !== authority.workspaceId) {
      return this.#error(session, message.requestId, "workspace_mismatch", "XR message Workspace does not match its session.", false);
    }
    if (message.authorityEpoch !== authority.authorityEpoch) {
      return this.#error(
        session,
        message.requestId,
        "stale_epoch",
        "XR message belongs to an inactive authority epoch.",
        true,
        { expectedAuthorityEpoch: authority.authorityEpoch },
      );
    }
    if (session.role === "authority" && session.sessionId !== authority.sessionId) {
      return this.#error(session, message.requestId, "authority_unavailable", "The XR authority lease is inactive.", false);
    }
    if (!this.#roleAllows(session.role, message.messageType)) {
      return this.#error(session, message.requestId, "role_not_allowed", "XR session role cannot send this message type.", false);
    }
    const routable = message as XrRoutableMessage;
    const fingerprint = messageFingerprint(routable);
    const previous = this.#requestHistory.get(session.sessionId)?.get(message.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return this.#error(
          session,
          message.requestId,
          "duplicate_conflict",
          "XR request identifier was reused with different content.",
          false,
        );
      }
      return this.#ack(session, message.requestId, "duplicate");
    }
    if (routable.messageType === "ephemeral") {
      const previousChannelMessage = this.#ephemeralSequences
        .get(session.sessionId)
        ?.get(routable.channel);
      // Request history is intentionally bounded. Retain one exact envelope per
      // ephemeral channel as a longer-lived idempotency checkpoint so an ACK
      // lost after relay commit can still converge without routing twice.
      if (previousChannelMessage?.sequence === routable.sequence
        && previousChannelMessage.requestId === routable.requestId
        && previousChannelMessage.fingerprint === fingerprint) {
        this.#rememberRequest(session.sessionId, message.requestId, fingerprint);
        return this.#ack(session, message.requestId, "duplicate");
      }
    }

    let failure: XrErrorMessage | undefined;
    switch (routable.messageType) {
      case "snapshot": failure = this.#acceptSnapshot(session, routable); break;
      case "delta": failure = this.#acceptDelta(session, routable); break;
      case "input": failure = this.#acceptInput(session, routable, fingerprint); break;
      case "ephemeral": failure = this.#acceptEphemeral(session, routable, fingerprint); break;
    }
    if (failure) return failure;
    this.#rememberRequest(session.sessionId, message.requestId, fingerprint);
    return this.#ack(session, message.requestId, "accepted");
  }

  drainMessages(credential: unknown): readonly XrRoutableMessage[] {
    const session = this.#requireSession(credential);
    const deliveries = this.#outboxes.get(session.sessionId) ?? [];
    this.#replaceOutbox(session.sessionId, []);
    return Object.freeze(deliveries.map(({ message }) => message));
  }

  /**
   * Reliable HTTP-poll view. Deliveries remain queued until the authenticated
   * recipient acknowledges their relay-generated identifiers on a later poll.
   */
  pollDeliveries(
    credential: unknown,
    acknowledgedDeliveryIdsValue: unknown = [],
  ): readonly XrRelayDelivery[] {
    const session = this.#requireSession(credential);
    if (session.role === "authority") this.#sweepExpiredRenderers();
    if (!Array.isArray(acknowledgedDeliveryIdsValue)
      || acknowledgedDeliveryIdsValue.length > this.#maximumOutboxMessages * 2) {
      throw new XrRelayControlError("invalid_control_request", "XR delivery acknowledgements are invalid.");
    }
    const acknowledged = new Set<string>();
    try {
      for (const [index, value] of acknowledgedDeliveryIdsValue.entries()) {
        acknowledged.add(parseXrOpaqueId(value, `$.acknowledgedDeliveryIds[${index}]`));
      }
    } catch (cause) {
      throw new XrRelayControlError(
        "invalid_control_request",
        "XR delivery acknowledgements are invalid.",
        { cause },
      );
    }
    if (acknowledged.size !== acknowledgedDeliveryIdsValue.length) {
      throw new XrRelayControlError("invalid_control_request", "XR delivery acknowledgements are invalid.");
    }
    const retained = (this.#outboxes.get(session.sessionId) ?? [])
      .filter(({ deliveryId }) => !acknowledged.has(deliveryId));
    this.#replaceOutbox(session.sessionId, retained);
    const pollNow = session.role === "authority" ? checkedNow(this.#now) : undefined;
    return Object.freeze(retained.map((delivery): XrRelayDelivery => {
      if (delivery.sourceSessionId !== undefined) {
        if (pollNow === undefined || delivery.serverReceivedAtMs === undefined) {
          throw new Error("XR renderer delivery provenance reached a non-authority outbox.");
        }
        if (pollNow < delivery.serverReceivedAtMs) {
          throw new Error("XR relay clock moved backwards while an authenticated renderer delivery was queued.");
        }
        return Object.freeze({
          ...delivery,
          serverQueueAgeMs: pollNow - delivery.serverReceivedAtMs,
        });
      }
      return Object.freeze({ ...delivery });
    }));
  }

  planReconnect(credential: unknown, value: unknown): XrReconnectPlan | XrErrorMessage {
    const session = this.#requireSession(credential);
    const cursor = parseXrReconnectCursor(value);
    if (cursor.sessionId !== session.sessionId) {
      return this.#error(
        session,
        cursor.requestId,
        "session_mismatch",
        "XR reconnect cursor does not match its authenticated session.",
        false,
      );
    }
    if (session.role !== "xr_renderer") {
      return this.#error(session, cursor.requestId, "role_not_allowed", "Only an XR renderer can request a reconnect plan.", false);
    }
    const authority = this.#authority;
    if (!authority) {
      return Object.freeze({
        kind: "unavailable",
        reason: "authority_unavailable",
        workspaceId: session.workspaceId,
        requestId: cursor.requestId,
      });
    }
    if (cursor.workspaceId !== session.workspaceId || cursor.workspaceId !== authority.workspaceId) {
      return this.#error(session, cursor.requestId, "workspace_mismatch", "XR reconnect Workspace does not match its session.", false);
    }
    const state = this.#state;
    if (!state) {
      return Object.freeze({
        kind: "unavailable",
        reason: "awaiting_snapshot",
        workspaceId: session.workspaceId,
        requestId: cursor.requestId,
      });
    }
    const finishReconnect = (plan: XrReconnectPlan): XrReconnectPlan => {
      // The reconnect plan is a complete recovery checkpoint. Any unacknowledged
      // renderer deliveries predate it and would otherwise replay stale snapshots
      // or deltas immediately after the replica has recovered. A host input
      // completion is different: it closes a renderer-owned pending action and
      // must survive a lost poll response plus the recovery handshake.
      const pendingInputResults = (this.#outboxes.get(session.sessionId) ?? [])
        .filter(({ message }) => isPendingInputResult(message));
      this.#replaceOutbox(session.sessionId, pendingInputResults);
      return plan;
    };
    const full = (): XrReconnectPlan => finishReconnect(Object.freeze({
      kind: "full_snapshot",
      authorityEpoch: authority.authorityEpoch,
      workspaceId: authority.workspaceId,
      revision: state.revision,
      snapshotDigest: state.snapshotDigest,
      requestId: cursor.requestId,
      snapshot: this.#forSession(session, state.baselineSnapshot),
      deltas: Object.freeze(state.deltas.map((delta) => this.#forSession(session, delta))),
    }));
    if (cursor.authorityEpoch !== authority.authorityEpoch) return full();
    if (cursor.revision > state.revision) return full();
    const knownDigest = state.revisionDigests.get(cursor.revision);
    if (knownDigest !== cursor.snapshotDigest) return full();
    if (cursor.revision === state.revision) {
      return finishReconnect(Object.freeze({
        kind: "current",
        authorityEpoch: authority.authorityEpoch,
        workspaceId: authority.workspaceId,
        revision: state.revision,
        snapshotDigest: state.snapshotDigest,
        requestId: cursor.requestId,
      }));
    }
    const deltas = state.deltas.filter((delta) => delta.baseRevision >= cursor.revision);
    let expected = cursor.revision;
    for (const delta of deltas) {
      if (delta.baseRevision !== expected || delta.revision !== expected + 1) return full();
      expected = delta.revision;
    }
    if (expected !== state.revision) return full();
    return finishReconnect(Object.freeze({
      kind: "deltas",
      authorityEpoch: authority.authorityEpoch,
      workspaceId: authority.workspaceId,
      fromRevision: cursor.revision,
      revision: state.revision,
      snapshotDigest: state.snapshotDigest,
      requestId: cursor.requestId,
      deltas: Object.freeze(deltas.map((delta) => this.#forSession(session, delta))),
    }));
  }

  #acceptSnapshot(session: MutableSession, message: XrSnapshotMessage): XrErrorMessage | undefined {
    if (session.role !== "authority") return this.#roleError(session, message.requestId);
    const state = this.#state;
    if (state) {
      if (message.revision < state.revision) return this.#revisionError(session, message.requestId, "stale_revision");
      if (message.revision === state.revision && message.snapshotDigest !== state.snapshotDigest) {
        return this.#error(
          session,
          message.requestId,
          "revision_conflict",
          "XR snapshot conflicts with the committed digest at this revision.",
          false,
          { expectedRevision: state.revision },
        );
      }
    }
    // A complete authority projection is a checkpoint, not an incremental
    // update. It may jump over revisions that were coalesced by the host.
    this.#state = {
      revision: message.revision,
      snapshotDigest: message.snapshotDigest,
      baselineSnapshot: message,
      deltas: [],
      revisionDigests: new Map([[message.revision, message.snapshotDigest]]),
    };
    this.#routeAuthorityMessage(message);
    return undefined;
  }

  #acceptDelta(session: MutableSession, message: XrDeltaMessage): XrErrorMessage | undefined {
    if (session.role !== "authority") return this.#roleError(session, message.requestId);
    const state = this.#state;
    if (!state) {
      return this.#error(session, message.requestId, "snapshot_required", "Publish a full XR snapshot before a delta.", true);
    }
    if (message.baseRevision < state.revision) return this.#revisionError(session, message.requestId, "stale_revision");
    if (message.baseRevision > state.revision) return this.#revisionError(session, message.requestId, "future_revision");
    if (message.revision !== message.baseRevision + 1) {
      return this.#error(
        session,
        message.requestId,
        "out_of_order",
        "XR delta must advance exactly one committed revision.",
        true,
        { expectedRevision: state.revision + 1 },
      );
    }
    if (message.baseSnapshotDigest !== state.snapshotDigest) {
      return this.#error(
        session,
        message.requestId,
        "digest_mismatch",
        "XR delta base digest does not match the committed revision.",
        true,
        { expectedRevision: state.revision },
      );
    }
    if (state.deltas.length >= this.#maximumDeltaHistory) {
      return this.#error(
        session,
        message.requestId,
        "snapshot_required",
        "Publish a fresh full XR snapshot before extending delta history.",
        true,
        { expectedRevision: state.revision },
      );
    }
    if (this.#maximumFullReconnectPlanBytes(state, message) > MAXIMUM_RECONNECT_PLAN_BYTES) {
      return this.#error(
        session,
        message.requestId,
        "snapshot_required",
        "Publish a fresh full XR snapshot before the reconnect byte budget is exhausted.",
        true,
        { expectedRevision: state.revision },
      );
    }
    state.deltas.push(message);
    state.revision = message.revision;
    state.snapshotDigest = message.snapshotDigest;
    state.revisionDigests.set(message.revision, message.snapshotDigest);
    this.#routeAuthorityMessage(message);
    return undefined;
  }

  #acceptInput(
    session: MutableSession,
    message: XrInputMessage,
    fingerprint: string,
  ): XrErrorMessage | undefined {
    if (session.role !== "xr_renderer") return this.#roleError(session, message.requestId);
    const state = this.#state;
    if (!state) {
      return this.#error(session, message.requestId, "authority_unavailable", "The XR authority has not published a snapshot.", true);
    }
    if (message.revision < state.revision) return this.#revisionError(session, message.requestId, "stale_revision");
    if (message.revision > state.revision) return this.#revisionError(session, message.requestId, "future_revision");
    const existingRoute = this.#inputRoutes.get(message.requestId);
    if (existingRoute) {
      if (existingRoute.rendererSessionId === session.sessionId
        && existingRoute.fingerprint === fingerprint) {
        // The per-session request history may have compacted while the host was
        // still handling this input. Do not enqueue the action twice.
        return undefined;
      }
      return this.#error(
        session,
        message.requestId,
        "duplicate_conflict",
        "XR input request identifier is already bound to another authenticated input.",
        false,
      );
    }
    if (this.#inputRoutes.size >= this.#maximumRequestHistory) {
      const completed = [...this.#inputRoutes].find(([, route]) => route.completed);
      if (completed) this.#inputRoutes.delete(completed[0]);
    }
    if (this.#inputRoutes.size >= this.#maximumRequestHistory) {
      return this.#error(
        session,
        message.requestId,
        "capacity_exhausted",
        "The XR input correlation table is full. Retry after pending input completes.",
        true,
      );
    }
    if (!this.#queue(
      this.#authority!.sessionId,
      this.#forSession(this.#authority!, message),
      false,
      session.sessionId,
    )) {
      return this.#error(
        session,
        message.requestId,
        "capacity_exhausted",
        "The XR authority input queue is full. Retry after the host acknowledges pending input.",
        true,
      );
    }
    const utteranceId = message.inputType === "voice_final"
      && typeof message.payload.utteranceId === "string"
      ? message.payload.utteranceId
      : undefined;
    this.#inputRoutes.set(message.requestId, Object.freeze({
      rendererSessionId: session.sessionId,
      fingerprint,
      inputType: message.inputType,
      workspaceRevision: message.revision,
      ...(utteranceId === undefined ? {} : { utteranceId }),
      // Pose is high-rate, fire-and-forget renderer telemetry. It is complete
      // once accepted into the authority queue and therefore never reserves a
      // reliable input-result slot. Keeping its fingerprint briefly still
      // deduplicates a bounded HTTP retry whose ACK was lost.
      completed: message.inputType === "pose",
    }));
    return undefined;
  }

  #acceptEphemeral(
    session: MutableSession,
    message: XrEphemeralMessage,
    fingerprint: string,
  ): XrErrorMessage | undefined {
    if (isPendingInputResult(message) && session.role !== "authority") {
      return this.#error(
        session,
        message.requestId,
        "role_not_allowed",
        "Only the XR authority can publish a host input result.",
        false,
      );
    }
    if ((message.channel === XR_SESSION_PRESENCE_CHANNEL && session.role !== "xr_renderer")
      || (message.channel === XR_SESSION_CONTROL_CHANNEL && session.role !== "authority")) {
      return this.#error(
        session,
        message.requestId,
        "role_not_allowed",
        "XR session lifecycle channels are reserved for their authenticated owner.",
        false,
      );
    }
    let routedRendererPresence: XrEphemeralMessage | undefined;
    if (message.channel === XR_SESSION_PRESENCE_CHANNEL) {
      try {
        const presence = parseXrViewerPresence(message.payload);
        if (!session.pairingId) throw new TypeError("Renderer pairing provenance is unavailable.");
        routedRendererPresence = Object.freeze({
          ...message,
          payload: Object.freeze({
            phase: presence.phase,
            sourceSessionId: session.sessionId,
            sourcePairingId: session.pairingId,
            serverReceivedAtMs: checkedNow(this.#now),
          }),
        });
      } catch {
        return this.#error(
          session,
          message.requestId,
          "invalid_message",
          "XR renderer presence is invalid.",
          false,
        );
      }
    }
    let parsedInputResult: ReturnType<typeof parseXrInputResult>;
    if (isPendingInputResult(message)) {
      try {
        parsedInputResult = parseXrInputResult(message);
      } catch {
        return this.#error(
          session,
          message.requestId,
          "invalid_message",
          "XR input-result payload is invalid.",
          false,
        );
      }
    }
    const state = this.#state;
    if (!state) {
      return this.#error(session, message.requestId, "authority_unavailable", "The XR authority has not published a snapshot.", true);
    }
    if (message.revision < state.revision) return this.#revisionError(session, message.requestId, "stale_revision");
    if (message.revision > state.revision) return this.#revisionError(session, message.requestId, "future_revision");
    const channels = this.#ephemeralSequences.get(session.sessionId)
      ?? new Map<string, EphemeralSequenceRecord>();
    const previousSequence = channels.get(message.channel)?.sequence;
    if (previousSequence !== undefined && message.sequence <= previousSequence) {
      return this.#error(
        session,
        message.requestId,
        "out_of_order",
        "XR ephemeral sequence must increase within its channel.",
        false,
        { expectedRevision: state.revision },
      );
    }
    if (session.role === "authority") {
      if (isPendingInputResult(message)) {
        const route = this.#routeReliableInputResult(message, parsedInputResult!);
        if (route !== "routed") {
          return this.#error(
            session,
            message.requestId,
            route === "capacity" ? "capacity_exhausted" : "invalid_message",
            route === "capacity"
              ? "The reliable XR input-result queue is full. Retry after the renderer acknowledges pending results."
              : "XR input result does not match a pending authenticated renderer input.",
            route === "capacity",
            { expectedRevision: state.revision },
          );
        }
      }
      if (!isPendingInputResult(message) && message.channel === XR_SESSION_CONTROL_CHANNEL) {
        let control: ReturnType<typeof parseXrTargetedExitRequest>;
        try {
          control = parseXrTargetedExitRequest(message.payload);
        } catch {
          return this.#error(
            session,
            message.requestId,
            "invalid_message",
            "XR session-control request is invalid.",
            false,
          );
        }
        const target = this.#sessions.get(control.targetSessionId);
        if (!target || target.role !== "xr_renderer"
          || target.workspaceId !== session.workspaceId
          || target.authorityEpoch !== session.authorityEpoch) {
          return this.#error(
            session,
            message.requestId,
            "invalid_message",
            "The targeted XR renderer session is unavailable.",
            false,
          );
        }
        const routedControl = Object.freeze({
          ...message,
          payload: Object.freeze({ action: "request_exit" }),
        });
        if (!this.#queue(target.sessionId, this.#forSession(target, routedControl))) {
          return this.#error(
            session,
            message.requestId,
            "capacity_exhausted",
            "The targeted XR renderer control queue is busy.",
            true,
          );
        }
      } else if (!isPendingInputResult(message)) {
        this.#routeAuthorityMessage(message);
      }
    } else {
      this.#queue(
        this.#authority!.sessionId,
        this.#forSession(this.#authority!, routedRendererPresence ?? message),
        true,
        session.sessionId,
      );
    }
    channels.set(message.channel, Object.freeze({
      sequence: message.sequence,
      requestId: message.requestId,
      fingerprint,
    }));
    this.#ephemeralSequences.set(session.sessionId, channels);
    return undefined;
  }

  /**
   * Host input completion is a bounded reliable delivery even though it uses
   * the generic ephemeral envelope. Its destination comes from the relay's
   * authenticated input route, never from authority/browser-supplied target
   * metadata. Reliable results have their own message quota alongside the
   * ordinary outbox quota.
   */
  #routeReliableInputResult(
    message: XrEphemeralMessage,
    result: NonNullable<ReturnType<typeof parseXrInputResult>>,
  ): "routed" | "unmatched" | "capacity" {
    const route = this.#inputRoutes.get(result.inputRequestId);
    if (!route || route.completed
      || route.inputType !== result.inputType
      || route.workspaceRevision !== result.workspaceRevision
      || route.utteranceId !== result.utteranceId) return "unmatched";
    const renderer = this.#sessions.get(route.rendererSessionId);
    if (!renderer || renderer.role !== "xr_renderer"
      || renderer.workspaceId !== message.workspaceId
      || renderer.authorityEpoch !== message.authorityEpoch) return "unmatched";
    const routed = this.#forSession(renderer, message);
    const queue = this.#planReliableInputResult(renderer.sessionId, routed);
    if (!queue) return "capacity";
    this.#replaceOutbox(renderer.sessionId, queue);
    this.#inputRoutes.set(result.inputRequestId, Object.freeze({ ...route, completed: true }));
    return "routed";
  }

  #planReliableInputResult(
    sessionId: string,
    message: XrEphemeralMessage,
  ): XrQueuedRelayDelivery[] | undefined {
    const queue = [...(this.#outboxes.get(sessionId) ?? [])];
    if (queue.filter(({ message: entry }) => isPendingInputResult(entry)).length
      >= this.#maximumOutboxMessages) return undefined;
    const delivery: XrQueuedRelayDelivery = Object.freeze({
      deliveryId: `delivery-${randomBytes(18).toString("base64url")}`,
      message,
    });
    const deliveryBytes = this.#encodedDeliveryBytes(delivery);
    if (deliveryBytes > MAXIMUM_OUTBOX_BYTES) return undefined;
    let queueBytes = this.#outboxBytes.get(sessionId) ?? 0;
    while (queueBytes + deliveryBytes > MAXIMUM_OUTBOX_BYTES) {
      const evictableIndex = queue.findIndex(({ message: entry }) => (
        entry.messageType === "ephemeral" && !isPendingInputResult(entry)
      ));
      if (evictableIndex < 0) return undefined;
      const [removed] = queue.splice(evictableIndex, 1);
      if (removed) queueBytes -= this.#encodedDeliveryBytes(removed);
    }
    queue.push(delivery);
    return queue;
  }

  #routeAuthorityMessage(message: XrSnapshotMessage | XrDeltaMessage | XrEphemeralMessage): void {
    for (const renderer of this.#rendererSessions()) {
      if (renderer.workspaceId === message.workspaceId) {
        this.#queue(renderer.sessionId, this.#forSession(renderer, message));
      }
    }
  }

  /**
   * `sessionId` binds an envelope to the authenticated transport carrying it.
   * The sender is checked before acceptance; routed copies are rebound to the
   * recipient so clients can reject cross-session delivery.
   */
  #forSession<T extends XrRoutableMessage>(session: MutableSession, message: T): T {
    return Object.freeze({ ...message, sessionId: session.sessionId }) as T;
  }

  /**
   * Computes the largest legal serialized full-reconnect plan for this state:
   * both the future renderer session id and cursor request id are expanded to
   * their protocol maxima. Keeping this below the response budget guarantees
   * every exact per-session plan will fit the default client envelope.
   */
  #maximumFullReconnectPlanBytes(state: RelayState, candidate?: XrDeltaMessage): number {
    const deltas = candidate ? [...state.deltas, candidate] : state.deltas;
    const final = candidate ?? deltas.at(-1) ?? state.baselineSnapshot;
    const plan = {
      kind: "full_snapshot",
      authorityEpoch: this.#authority?.authorityEpoch ?? state.baselineSnapshot.authorityEpoch,
      workspaceId: state.baselineSnapshot.workspaceId,
      revision: final.revision,
      snapshotDigest: final.snapshotDigest,
      requestId: MAXIMUM_OPAQUE_ID,
      snapshot: { ...state.baselineSnapshot, sessionId: MAXIMUM_OPAQUE_ID },
      deltas: deltas.map((delta) => ({ ...delta, sessionId: MAXIMUM_OPAQUE_ID })),
    };
    return Buffer.byteLength(JSON.stringify(plan), "utf8");
  }

  #queue(
    sessionId: string,
    message: XrRoutableMessage,
    allowCriticalEviction = true,
    sourceSessionId?: string,
  ): boolean {
    const queue = [...(this.#outboxes.get(sessionId) ?? [])];
    // Every mutation below updates this cached exact total. Re-serializing the
    // entire growing queue for each delivery made a maximum-sized outbox O(n²)
    // in payload bytes and could starve an otherwise healthy renderer lease.
    let queueBytes = this.#outboxBytes.get(sessionId)
      ?? queue.reduce((total, queued) => total + this.#encodedDeliveryBytes(queued), 0);
    if (message.messageType === "input" && message.inputType === "pose") {
      // Live pose is latest-value telemetry, not an action log. Coalesce every
      // unacknowledged sample so a stalled authority cannot be flooded by the
      // 250ms Agent-readable heartbeat or starve select/panel/voice actions.
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const queued = queue[index]?.message;
        if (queued?.messageType === "input" && queued.inputType === "pose") {
          const [removed] = queue.splice(index, 1);
          if (removed) queueBytes -= this.#encodedDeliveryBytes(removed);
        }
      }
    }
    const presenceSource = message.messageType === "ephemeral"
      && message.channel === XR_SESSION_PRESENCE_CHANNEL
      && typeof message.payload.sourceSessionId === "string"
      ? message.payload.sourceSessionId
      : undefined;
    const presencePhase = presenceSource
      && message.messageType === "ephemeral"
      && typeof message.payload.phase === "string"
      ? message.payload.phase
      : undefined;
    if (presenceSource) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const queued = queue[index]?.message;
        if (queued?.messageType === "ephemeral"
          && queued.channel === XR_SESSION_PRESENCE_CHANNEL
          && queued.payload.sourceSessionId === presenceSource
          // Repeated active heartbeats (and other duplicate phases) are
          // latest-value lease telemetry. Distinct transitions such as
          // ended -> replica_ready are an ordered lifecycle log and must both
          // survive until the authority acknowledges them.
          && queued.payload.phase === presencePhase) {
          const [removed] = queue.splice(index, 1);
          if (removed) queueBytes -= this.#encodedDeliveryBytes(removed);
        }
      }
    }
    const delivery: XrQueuedRelayDelivery = sourceSessionId === undefined
      ? Object.freeze({
          deliveryId: `delivery-${randomBytes(18).toString("base64url")}`,
          message,
        })
      : Object.freeze({
          deliveryId: `delivery-${randomBytes(18).toString("base64url")}`,
          message,
          sourceSessionId,
          serverReceivedAtMs: checkedNow(this.#now),
        });
    const deliveryBytes = this.#encodedDeliveryBytes(delivery);
    let ordinaryMessages = queue.filter(({ message: entry }) => !isPendingInputResult(entry)).length;
    while (ordinaryMessages >= this.#maximumOutboxMessages
      || queueBytes + deliveryBytes > MAXIMUM_OUTBOX_BYTES) {
      const poseIndex = queue.findIndex(({ message: entry }) => (
        entry.messageType === "input" && entry.inputType === "pose"
      ));
      if (poseIndex >= 0) {
        const [removed] = queue.splice(poseIndex, 1);
        if (removed) {
          queueBytes -= this.#encodedDeliveryBytes(removed);
          ordinaryMessages -= 1;
        }
        continue;
      }
      const ephemeralIndex = queue.findIndex(({ message: entry }) => (
        entry.messageType === "ephemeral" && !isPendingInputResult(entry)
      ));
      if (ephemeralIndex >= 0) {
        const [removed] = queue.splice(ephemeralIndex, 1);
        if (removed) {
          queueBytes -= this.#encodedDeliveryBytes(removed);
          ordinaryMessages -= 1;
        }
      } else if (message.messageType === "ephemeral") {
        // Ephemeral state is explicitly lossy and must never evict a reliable
        // renderer action merely because the best-effort channel is busy.
        return false;
      } else if (allowCriticalEviction) {
        const evictableIndex = queue.findIndex(({ message: entry }) => !isPendingInputResult(entry));
        if (evictableIndex < 0) return false;
        const [removed] = queue.splice(evictableIndex, 1);
        if (removed) {
          queueBytes -= this.#encodedDeliveryBytes(removed);
          ordinaryMessages -= 1;
        }
      }
      else return false;
    }
    queue.push(delivery);
    this.#replaceOutbox(sessionId, queue, queueBytes + deliveryBytes);
    return true;
  }

  #encodedDeliveryBytes(delivery: XrQueuedRelayDelivery | XrRelayDelivery): number {
    return Buffer.byteLength(JSON.stringify(delivery), "utf8");
  }

  #replaceOutbox(
    sessionId: string,
    queue: XrQueuedRelayDelivery[],
    encodedBytes = queue.reduce((total, delivery) => total + this.#encodedDeliveryBytes(delivery), 0),
  ): void {
    this.#outboxes.set(sessionId, queue);
    this.#outboxBytes.set(sessionId, encodedBytes);
  }

  #rememberRequest(sessionId: string, requestId: string, fingerprint: string): void {
    const history = this.#requestHistory.get(sessionId) ?? new Map<string, RequestRecord>();
    if (history.size >= this.#maximumRequestHistory) {
      const oldest = history.keys().next().value as string | undefined;
      if (oldest) history.delete(oldest);
    }
    history.set(requestId, Object.freeze({ fingerprint }));
    this.#requestHistory.set(sessionId, history);
  }

  #roleAllows(role: XrSessionRole, messageType: string): boolean {
    return role === "authority"
      ? ["snapshot", "delta", "ephemeral"].includes(messageType)
      : ["input", "ephemeral"].includes(messageType);
  }

  #ack(session: MutableSession, requestId: string, status: XrAckMessage["status"]): XrAckMessage {
    const authorityEpoch = this.#authority?.authorityEpoch ?? session.authorityEpoch;
    return Object.freeze({
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ack",
      sessionId: session.sessionId,
      authorityEpoch,
      workspaceId: session.workspaceId,
      revision: this.#state?.revision ?? 0,
      requestId,
      status,
    });
  }

  #error(
    session: MutableSession,
    requestId: string,
    code: XrErrorCode,
    message: string,
    retryable: boolean,
    expected: Readonly<{ expectedRevision?: number; expectedAuthorityEpoch?: string }> = {},
  ): XrErrorMessage {
    const authorityEpoch = this.#authority?.authorityEpoch ?? session.authorityEpoch;
    return Object.freeze({
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "error",
      sessionId: session.sessionId,
      authorityEpoch,
      workspaceId: session.workspaceId,
      revision: this.#state?.revision ?? 0,
      requestId,
      code,
      message: message.slice(0, 2_000),
      retryable,
      ...(expected.expectedRevision === undefined ? {} : { expectedRevision: expected.expectedRevision }),
      ...(expected.expectedAuthorityEpoch === undefined
        ? {}
        : { expectedAuthorityEpoch: expected.expectedAuthorityEpoch }),
    });
  }

  #revisionError(
    session: MutableSession,
    requestId: string,
    code: "stale_revision" | "future_revision",
  ): XrErrorMessage {
    const expectedRevision = this.#state?.revision ?? 0;
    return this.#error(
      session,
      requestId,
      code,
      code === "stale_revision"
        ? "XR message revision is older than the committed Workspace projection."
        : "XR message revision is ahead of the committed Workspace projection.",
      true,
      { expectedRevision },
    );
  }

  #roleError(session: MutableSession, requestId: string): XrErrorMessage {
    return this.#error(session, requestId, "role_not_allowed", "XR session role cannot send this message type.", false);
  }

  #safeRequestId(value: unknown): string {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      try {
        return parseXrOpaqueId((value as Record<string, unknown>).requestId, "$.requestId");
      } catch {
        // A generated response identifier prevents reflecting malformed input.
      }
    }
    return this.#newId("request");
  }

  #requireSession(credentialValue: unknown): MutableSession {
    let body: Record<string, unknown>;
    let sessionId: string;
    let sessionBearer: string;
    try {
      body = exactRecord(
        credentialValue,
        ["sessionId", "sessionBearer"],
        ["sessionId", "sessionBearer"],
      );
      sessionId = parseXrOpaqueId(body.sessionId, "$.sessionId");
      sessionBearer = checkedSessionBearer(body.sessionBearer);
    } catch (cause) {
      if (cause instanceof XrRelayControlError && cause.code === "session_unauthorized") throw cause;
      throw new XrRelayControlError("session_unauthorized", "XR session credential is invalid.", { cause });
    }
    const suppliedDigest = bearerDigest(sessionBearer);
    const storedDigest = this.#sessionBearerDigests.get(sessionId);
    const matches = timingSafeEqual(storedDigest ?? EMPTY_BEARER_DIGEST, suppliedDigest);
    const session = this.#sessions.get(sessionId);
    if (!storedDigest || !matches || !session) {
      throw new XrRelayControlError("session_unauthorized", "XR session credential is invalid.");
    }
    const now = checkedNow(this.#now);
    if (session.role === "xr_renderer"
      && now - session.lastSeenAtMs > RENDERER_SESSION_IDLE_TIMEOUT_MS) {
      this.#removeRenderer(session.sessionId, "expired");
      throw new XrRelayControlError("session_unauthorized", "XR renderer session expired.");
    }
    session.lastSeenAtMs = now;
    return session;
  }

  #requireAuthority(credential: unknown): MutableSession {
    const session = this.#requireSession(credential);
    if (session.role !== "authority") {
      throw new XrRelayControlError("role_not_allowed", "Only the XR Workspace authority may perform this action.");
    }
    if (!this.#authority || this.#authority.sessionId !== session.sessionId) {
      throw new XrRelayControlError("authority_required", "The XR Workspace authority is unavailable.");
    }
    return session;
  }

  #rendererSessions(): MutableSession[] {
    return [...this.#sessions.values()].filter((session) => session.role === "xr_renderer");
  }

  #prunePairingScopes(): void {
    for (const pairingId of this.#pairingScopes.keys()) {
      if (this.#rendererSessionByPairingId.has(pairingId)) continue;
      const pairing = this.#pairingStore.get(pairingId);
      if (!pairing || pairing.state !== "active") this.#pairingScopes.delete(pairingId);
    }
  }

  #requirePairingCodeAttempt(): void {
    const now = checkedNow(this.#now);
    this.#pruneFailedPairingCodeAttempts(now);
    if (this.#failedPairingCodeAttempts.length >= MAXIMUM_FAILED_PAIRING_CODE_ATTEMPTS) {
      throw new XrRelayControlError(
        "pairing_rate_limited",
        "XR pairing code attempts are temporarily rate limited.",
      );
    }
  }

  #recordFailedPairingCodeAttempt(): void {
    const now = checkedNow(this.#now);
    this.#pruneFailedPairingCodeAttempts(now);
    this.#failedPairingCodeAttempts.push(now);
    if (this.#failedPairingCodeAttempts.length >= MAXIMUM_FAILED_PAIRING_CODE_ATTEMPTS) {
      throw new XrRelayControlError(
        "pairing_rate_limited",
        "XR pairing code attempts are temporarily rate limited.",
      );
    }
  }

  #pruneFailedPairingCodeAttempts(now: number): void {
    while (this.#failedPairingCodeAttempts.length > 0
      && now - this.#failedPairingCodeAttempts[0] >= PAIRING_CODE_FAILURE_WINDOW_MS) {
      this.#failedPairingCodeAttempts.shift();
    }
  }

  #sweepExpiredRenderers(): void {
    const now = checkedNow(this.#now);
    for (const renderer of this.#rendererSessions()) {
      if (now - renderer.lastSeenAtMs > RENDERER_SESSION_IDLE_TIMEOUT_MS) {
        this.#removeRenderer(renderer.sessionId, "expired");
      }
    }
  }

  #removeRenderer(sessionId: string, reason: "disconnected" | "expired" = "disconnected"): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.role !== "xr_renderer") return;
    this.#publishRendererRemoval(session, reason);
    this.#sessions.delete(sessionId);
    this.#sessionBearerDigests.delete(sessionId);
    this.#outboxes.delete(sessionId);
    this.#outboxBytes.delete(sessionId);
    this.#requestHistory.delete(sessionId);
    this.#ephemeralSequences.delete(sessionId);
    for (const [requestId, route] of this.#inputRoutes) {
      if (route.rendererSessionId === sessionId && !route.completed) {
        this.#inputRoutes.set(requestId, Object.freeze({ ...route, completed: true }));
      }
    }
    if (session.pairingId) {
      this.#rendererSessionByPairingId.delete(session.pairingId);
      this.#pairingScopes.delete(session.pairingId);
      this.#pairingStore.revoke(session.pairingId);
    }
    const event = Object.freeze({ session: publicSession(session), reason });
    for (const listener of this.#rendererRemovalListeners) {
      let cleanup: Promise<void>;
      cleanup = Promise.resolve()
        .then(() => listener(event))
        .catch((error) => { this.#rendererRemovalFailures.push(error); })
        .finally(() => { this.#rendererRemovalCleanups.delete(cleanup); });
      this.#rendererRemovalCleanups.add(cleanup);
    }
  }

  #publishRendererRemoval(
    session: MutableSession,
    phase: "disconnected" | "expired",
  ): void {
    const authority = this.#authority;
    const state = this.#state;
    if (!authority || !state || !session.pairingId
      || session.authorityEpoch !== authority.authorityEpoch
      || session.workspaceId !== authority.workspaceId) return;
    const previous = this.#ephemeralSequences
      .get(session.sessionId)
      ?.get(XR_SESSION_PRESENCE_CHANNEL)?.sequence ?? 0;
    const now = checkedNow(this.#now);
    const message: XrEphemeralMessage = Object.freeze({
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral",
      sessionId: authority.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: authority.workspaceId,
      revision: state.revision,
      requestId: this.#newId("request"),
      channel: XR_SESSION_PRESENCE_CHANNEL,
      sequence: previous + 1,
      payload: Object.freeze({
        phase,
        sourceSessionId: session.sessionId,
        sourcePairingId: session.pairingId,
        serverReceivedAtMs: now,
      }),
    });
    this.#queue(authority.sessionId, message, true, session.sessionId);
  }

  #newId(kind: "session" | "epoch" | "request"): string {
    try {
      return parseXrOpaqueId(this.#idFactory(kind), `$.${kind}Id`);
    } catch (cause) {
      if (cause instanceof XrProtocolValidationError) {
        throw new Error(`XR ${kind} factory returned an invalid identifier.`, { cause });
      }
      throw cause;
    }
  }

  #newSessionBearer(): string {
    let sessionBearer: string;
    try {
      sessionBearer = checkedSessionBearer(this.#sessionBearerFactory());
    } catch (cause) {
      throw new Error("XR session bearer factory returned an invalid 256-bit capability.", { cause });
    }
    const digest = bearerDigest(sessionBearer);
    for (const existing of this.#sessionBearerDigests.values()) {
      if (timingSafeEqual(existing, digest)) {
        throw new Error("XR session bearer factory returned a duplicate capability.");
      }
    }
    return sessionBearer;
  }

  #recoverableAuthorityBearer(session: MutableSession, requestId: string): string {
    // The relay retains neither the request id nor the raw bearer. An exact
    // retry deterministically reconstructs a candidate from the process-local
    // HMAC key, then authenticates it against the normal stored bearer digest.
    return createHmac("sha256", this.#authorityRecoverySecret)
      .update(`${session.sessionId.length}:${session.sessionId}`)
      .update(`${session.authorityEpoch.length}:${session.authorityEpoch}`)
      .update(`${session.workspaceId.length}:${session.workspaceId}`)
      .update(`${requestId.length}:${requestId}`)
      .digest("base64url");
  }
}
