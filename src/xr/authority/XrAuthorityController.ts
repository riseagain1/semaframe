import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import {
  XR_RELAY_PROTOCOL_VERSION,
  type XrAckMessage,
  type XrEphemeralMessage,
  type XrErrorMessage,
  type XrInputMessage,
  type XrJsonObject,
  type XrRoutableMessage,
} from "../protocol";
import {
  diffXrWorkspaceProjection,
  digestXrProjection,
  toXrWorkspaceProjection,
  xrProjectionAsJsonObject,
  type XrWorkspaceProjection,
} from "./XrWorkspaceProjection";

export type XrAuthorityConnectionView = Readonly<{
  sessionId: string;
  authorityEpoch: string;
  workspaceId: string;
}>;

export type XrAuthorityPairingGrant = Readonly<{
  pairingId: string;
  pairingToken: string;
  /** Human-enterable alias for the same single-use pairing grant. */
  pairingCode: string;
  workspaceId: string;
  authorityEpoch: string;
  expiresAtMs: number;
}>;

export type XrAuthorityPairingCapabilities = Readonly<{
  voiceRelay?: boolean;
}>;

export interface XrAuthorityTransport {
  connect(workspaceId: string): Promise<XrAuthorityConnectionView>;
  send(message: XrRoutableMessage): Promise<XrAckMessage | XrErrorMessage>;
  poll(acknowledgedDeliveryIds?: readonly string[]): Promise<readonly XrAuthorityPollDelivery[]>;
  createPairing(ttlMs?: number, capabilities?: XrAuthorityPairingCapabilities): Promise<XrAuthorityPairingGrant>;
  revokePairing(pairingId: string): Promise<boolean>;
  disconnect(): Promise<void>;
}

export type XrAuthorityPollDelivery = Readonly<{
  deliveryId: string;
  message: XrRoutableMessage;
  /** Authenticated by the relay; never inferred from message.sessionId. */
  sourceSessionId: string;
  /** Relay-clock acceptance timestamp retained for audit, never cross-clock subtraction. */
  serverReceivedAtMs: number;
  /** Time already spent in the relay queue when this poll response was created. */
  serverQueueAgeMs: number;
}>;

export type XrAuthorityInputDelivery = Readonly<{
  deliveryId: string;
  message: XrInputMessage | XrEphemeralMessage;
  sourceSessionId: string;
  serverReceivedAtMs: number;
  serverQueueAgeMs: number;
}>;

export type XrAuthorityPhase = "idle" | "connecting" | "connected" | "disconnecting" | "error";

export type XrAuthoritySnapshot = Readonly<{
  phase: XrAuthorityPhase;
  workspaceId?: string;
  revision?: number;
  rendererInputCount: number;
  error?: Readonly<{ code: string; message: string }>;
}>;

export type XrAuthorityControllerOptions = Readonly<{
  requestId?: () => string;
  checkpointInterval?: number;
  /**
   * Completes host-owned prerequisites (for example asset residency) after the
   * authority session exists but before any snapshot or delta can reference
   * the candidate revision.
   */
  prepareSnapshot?: (snapshot: WorkspaceRenderSnapshot) => void | Promise<void>;
}>;

type XrSyncWaiter = Readonly<{
  resolve(): void;
  reject(cause: unknown): void;
}>;

type XrPendingSync = {
  snapshot: WorkspaceRenderSnapshot;
  registryIdentity: string;
  waiters: XrSyncWaiter[];
};

type XrPendingEphemeral = Readonly<{
  payloadKey: string;
  message: XrEphemeralMessage;
}>;

export class XrAuthoritySyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "XrAuthoritySyncError";
  }
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `xr-request-${Date.now().toString(36)}`;
}

function checkedCheckpointInterval(value: number | undefined): number {
  const interval = value ?? 96;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 128) {
    throw new RangeError("XR checkpoint interval must be an integer between 1 and 128");
  }
  return interval;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function isDefinitivelyNonRetryable(cause: unknown): boolean {
  return cause !== null
    && typeof cause === "object"
    && "retryable" in cause
    && (cause as { retryable?: unknown }).retryable === false;
}

function assertAck(result: XrAckMessage | XrErrorMessage): XrAckMessage {
  if (result.messageType === "error") {
    throw new XrAuthoritySyncError(result.code, result.message, result.retryable);
  }
  return result;
}

/**
 * Host-side projection publisher. It owns transport sequencing, never a second
 * Workspace, and accepts only snapshots emitted by the canonical App store.
 */
export class XrAuthorityController {
  readonly #transport: XrAuthorityTransport;
  readonly #requestId: () => string;
  readonly #checkpointInterval: number;
  readonly #prepareSnapshot: NonNullable<XrAuthorityControllerOptions["prepareSnapshot"]> | undefined;
  readonly #listeners = new Set<(snapshot: XrAuthoritySnapshot) => void>();
  readonly #ephemeralSequences = new Map<string, number>();
  readonly #pendingEphemerals = new Map<string, XrPendingEphemeral>();
  readonly #acknowledgedInputDeliveryIds = new Set<string>();
  #state: XrAuthoritySnapshot = Object.freeze({ phase: "idle", rendererInputCount: 0 });
  #connection?: XrAuthorityConnectionView;
  #projection?: XrWorkspaceProjection;
  #projectionDigest?: `sha256:${string}`;
  #registryDigest?: `sha256:${string}`;
  #deltasSinceCheckpoint = 0;
  #queue: Promise<void> = Promise.resolve();
  #pendingSync?: XrPendingSync;
  #activeSyncRevision?: number;
  #syncDrainQueued = false;

  constructor(transport: XrAuthorityTransport, options: XrAuthorityControllerOptions = {}) {
    this.#transport = transport;
    this.#requestId = options.requestId ?? requestId;
    this.#checkpointInterval = checkedCheckpointInterval(options.checkpointInterval);
    this.#prepareSnapshot = options.prepareSnapshot;
  }

  get snapshot(): XrAuthoritySnapshot {
    return this.#state;
  }

  subscribe(listener: (snapshot: XrAuthoritySnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  async connect(snapshot: WorkspaceRenderSnapshot, registryIdentity: string): Promise<XrAuthoritySnapshot> {
    if (this.#state.phase !== "idle" && this.#state.phase !== "error") {
      throw new XrAuthoritySyncError("already_connected", "XR authority is already connected");
    }
    this.#publish({ phase: "connecting", workspaceId: snapshot.workspaceId, rendererInputCount: 0 });
    try {
      const connection = await this.#transport.connect(snapshot.workspaceId);
      if (connection.workspaceId !== snapshot.workspaceId) {
        throw new XrAuthoritySyncError("workspace_mismatch", "XR relay connected to the wrong Workspace");
      }
      this.#connection = connection;
      await this.#prepareSnapshot?.(snapshot);
      const projection = toXrWorkspaceProjection(snapshot);
      const [projectionDigest, registryDigest] = await Promise.all([
        digestXrProjection(projection),
        digestXrProjection({ registryIdentity }),
      ]);
      assertAck(await this.#transport.send({
        protocolVersion: XR_RELAY_PROTOCOL_VERSION,
        messageType: "snapshot",
        sessionId: connection.sessionId,
        authorityEpoch: connection.authorityEpoch,
        workspaceId: connection.workspaceId,
        revision: projection.revision,
        requestId: this.#requestId(),
        registryDigest,
        snapshotDigest: projectionDigest,
        snapshot: xrProjectionAsJsonObject(projection),
      }));
      this.#projection = projection;
      this.#projectionDigest = projectionDigest;
      this.#registryDigest = registryDigest;
      this.#deltasSinceCheckpoint = 0;
      this.#ephemeralSequences.clear();
      this.#publish({
        phase: "connected",
        workspaceId: projection.workspaceId,
        revision: projection.revision,
        rendererInputCount: 0,
      });
      return this.#state;
    } catch (cause) {
      await this.#transport.disconnect().catch(() => undefined);
      this.#clearConnection();
      const error = cause instanceof XrAuthoritySyncError
        ? cause
        : new XrAuthoritySyncError("connect_failed", cause instanceof Error ? cause.message : "XR relay connection failed", true);
      this.#publish({
        phase: "error",
        workspaceId: snapshot.workspaceId,
        rendererInputCount: 0,
        error: Object.freeze({ code: error.code, message: error.message }),
      });
      throw error;
    }
  }

  sync(snapshot: WorkspaceRenderSnapshot, registryIdentity: string): Promise<void> {
    try {
      this.#requireConnected();
      const minimumRevision = Math.max(
        this.#projection?.revision ?? -1,
        this.#activeSyncRevision ?? -1,
        this.#pendingSync?.snapshot.revision ?? -1,
      );
      if (snapshot.revision < minimumRevision) {
        throw new XrAuthoritySyncError("stale_revision", "XR projection revision moved backwards");
      }
    } catch (cause) {
      return Promise.reject(cause);
    }

    const result = new Promise<void>((resolve, reject) => {
      const waiter = Object.freeze({ resolve, reject });
      if (this.#pendingSync) {
        this.#pendingSync.snapshot = snapshot;
        this.#pendingSync.registryIdentity = registryIdentity;
        this.#pendingSync.waiters.push(waiter);
      } else {
        this.#pendingSync = { snapshot, registryIdentity, waiters: [waiter] };
      }
    });
    this.#ensureSyncDrain();
    return result;
  }

  async createPairing(
    ttlMs?: number,
    capabilities?: XrAuthorityPairingCapabilities,
  ): Promise<XrAuthorityPairingGrant> {
    this.#requireConnected();
    return this.#transport.createPairing(ttlMs, capabilities);
  }

  async revokePairing(pairingId: string): Promise<boolean> {
    this.#requireConnected();
    return this.#transport.revokePairing(pairingId);
  }

  async pollInputs(): Promise<readonly XrAuthorityInputDelivery[]> {
    this.#requireConnected();
    const acknowledgements = Object.freeze([...this.#acknowledgedInputDeliveryIds]);
    const deliveries = await this.#transport.poll(acknowledgements);
    for (const deliveryId of acknowledgements) this.#acknowledgedInputDeliveryIds.delete(deliveryId);
    const routed = deliveries.filter(
      (delivery): delivery is XrAuthorityInputDelivery =>
        delivery.message.messageType === "input" || delivery.message.messageType === "ephemeral",
    );
    if (routed.length) {
      this.#publish({ ...this.#state, rendererInputCount: this.#state.rendererInputCount + routed.length });
    }
    return Object.freeze(routed);
  }

  /** Mark one successfully routed delivery for removal on the next poll. */
  acknowledgeInput(deliveryId: string): void {
    this.#requireConnected();
    if (typeof deliveryId !== "string" || deliveryId.length < 8 || deliveryId.length > 128) {
      throw new XrAuthoritySyncError("invalid_delivery", "XR input delivery identifier is invalid");
    }
    this.#acknowledgedInputDeliveryIds.add(deliveryId);
  }

  publishEphemeral(channel: string, payload: XrJsonObject): Promise<void> {
    const desiredPayload = structuredClone(payload);
    const desiredPayloadKey = canonicalJson(desiredPayload);
    return this.#enqueue(async () => {
      const previous = this.#pendingEphemerals.get(channel);
      if (previous) {
        await this.#sendPendingEphemeral(previous);
        // The caller is retrying the same logical publication after an
        // ambiguous response. The exact envelope has now converged at the
        // relay, so do not manufacture a second completion.
        if (previous.payloadKey === desiredPayloadKey) return;
      }
      const connection = this.#requireConnected();
      const projection = this.#projection!;
      const sequence = (this.#ephemeralSequences.get(channel) ?? 0) + 1;
      const pending: XrPendingEphemeral = Object.freeze({
        payloadKey: desiredPayloadKey,
        message: Object.freeze({
          protocolVersion: XR_RELAY_PROTOCOL_VERSION,
          messageType: "ephemeral",
          sessionId: connection.sessionId,
          authorityEpoch: connection.authorityEpoch,
          workspaceId: connection.workspaceId,
          revision: projection.revision,
          requestId: this.#requestId(),
          channel,
          sequence,
          payload: desiredPayload,
        }),
      });
      this.#pendingEphemerals.set(channel, pending);
      await this.#sendPendingEphemeral(pending);
    });
  }

  async #sendPendingEphemeral(pending: XrPendingEphemeral): Promise<void> {
    try {
      assertAck(await this.#transport.send(pending.message));
    } catch (cause) {
      // Unknown/network failures are ambiguous: the relay may have committed
      // the envelope before its ACK was lost, so retain the exact request and
      // sequence for the next bounded host retry. A definitive protocol
      // rejection did not commit and must not poison the channel forever.
      if (isDefinitivelyNonRetryable(cause)
        && this.#pendingEphemerals.get(pending.message.channel) === pending) {
        this.#pendingEphemerals.delete(pending.message.channel);
      }
      throw cause;
    }
    if (this.#pendingEphemerals.get(pending.message.channel) !== pending) return;
    this.#ephemeralSequences.set(pending.message.channel, pending.message.sequence);
    this.#pendingEphemerals.delete(pending.message.channel);
  }

  async disconnect(): Promise<boolean> {
    if (this.#state.phase === "idle") return true;
    this.#publish({ ...this.#state, phase: "disconnecting" });
    await this.#queue.catch(() => undefined);
    let remotelyConfirmed = true;
    await this.#transport.disconnect().catch(() => { remotelyConfirmed = false; });
    this.#clearConnection();
    this.#publish({ phase: "idle", rendererInputCount: 0 });
    return remotelyConfirmed;
  }

  async #syncNow(snapshot: WorkspaceRenderSnapshot, registryIdentity: string): Promise<void> {
    const connection = this.#requireConnected();
    const before = this.#projection!;
    const baseDigest = this.#projectionDigest!;
    if (snapshot.workspaceId !== connection.workspaceId) {
      throw new XrAuthoritySyncError("workspace_mismatch", "XR projection cannot switch Workspace inside an authority epoch");
    }
    if (snapshot.revision < before.revision) {
      throw new XrAuthoritySyncError("stale_revision", "XR projection revision moved backwards");
    }
    const after = toXrWorkspaceProjection(snapshot);
    const [afterDigest, registryDigest] = await Promise.all([
      digestXrProjection(after),
      digestXrProjection({ registryIdentity }),
    ]);
    if (after.revision === before.revision) {
      if (afterDigest !== baseDigest) {
        throw new XrAuthoritySyncError("revision_conflict", "XR projection changed without a Workspace revision");
      }
      if (registryDigest !== this.#registryDigest) {
        assertAck(await this.#transport.send({
          protocolVersion: XR_RELAY_PROTOCOL_VERSION,
          messageType: "snapshot",
          sessionId: connection.sessionId,
          authorityEpoch: connection.authorityEpoch,
          workspaceId: connection.workspaceId,
          revision: after.revision,
          requestId: this.#requestId(),
          registryDigest,
          snapshotDigest: afterDigest,
          snapshot: xrProjectionAsJsonObject(after),
        }));
        this.#registryDigest = registryDigest;
        this.#deltasSinceCheckpoint = 0;
      }
      return;
    }
    const shouldCheckpoint = after.revision !== before.revision + 1
      || this.#deltasSinceCheckpoint + 1 >= this.#checkpointInterval
      || registryDigest !== this.#registryDigest;
    if (shouldCheckpoint) {
      assertAck(await this.#transport.send({
        protocolVersion: XR_RELAY_PROTOCOL_VERSION,
        messageType: "snapshot",
        sessionId: connection.sessionId,
        authorityEpoch: connection.authorityEpoch,
        workspaceId: connection.workspaceId,
        revision: after.revision,
        requestId: this.#requestId(),
        registryDigest,
        snapshotDigest: afterDigest,
        snapshot: xrProjectionAsJsonObject(after),
      }));
      this.#deltasSinceCheckpoint = 0;
    } else {
      const delta = diffXrWorkspaceProjection(before, after);
      const result = await this.#transport.send({
        protocolVersion: XR_RELAY_PROTOCOL_VERSION,
        messageType: "delta",
        sessionId: connection.sessionId,
        authorityEpoch: connection.authorityEpoch,
        workspaceId: connection.workspaceId,
        revision: after.revision,
        requestId: this.#requestId(),
        baseRevision: before.revision,
        baseSnapshotDigest: baseDigest,
        snapshotDigest: afterDigest,
        delta: xrProjectionAsJsonObject(delta),
      });
      if (result.messageType === "error" && result.code === "snapshot_required") {
        assertAck(await this.#transport.send({
          protocolVersion: XR_RELAY_PROTOCOL_VERSION,
          messageType: "snapshot",
          sessionId: connection.sessionId,
          authorityEpoch: connection.authorityEpoch,
          workspaceId: connection.workspaceId,
          revision: after.revision,
          requestId: this.#requestId(),
          registryDigest,
          snapshotDigest: afterDigest,
          snapshot: xrProjectionAsJsonObject(after),
        }));
        this.#deltasSinceCheckpoint = 0;
      } else {
        assertAck(result);
        this.#deltasSinceCheckpoint += 1;
      }
    }
    this.#projection = after;
    this.#projectionDigest = afterDigest;
    this.#registryDigest = registryDigest;
    this.#publish({ ...this.#state, revision: after.revision });
  }

  #ensureSyncDrain(): void {
    if (this.#syncDrainQueued) return;
    this.#syncDrainQueued = true;
    const drain = this.#enqueue(() => this.#drainSyncs());
    // Individual sync promises carry the actionable failure. The queue already
    // has its own rejection sink, so this prevents an internal unhandled task.
    void drain.catch(() => undefined);
  }

  async #drainSyncs(): Promise<void> {
    let current: XrPendingSync | undefined;
    try {
      while ((current = this.#pendingSync) !== undefined) {
        this.#pendingSync = undefined;
        this.#activeSyncRevision = current.snapshot.revision;
        await this.#prepareSnapshot?.(current.snapshot);

        // A newer candidate arriving during a slow prerequisite supersedes
        // this one before it can publish. Its callers resolve only after the
        // latest candidate is durably acknowledged.
        const superseding = this.#pendingSync as XrPendingSync | undefined;
        if (superseding) {
          superseding.waiters.unshift(...current.waiters);
          current = undefined;
          continue;
        }

        await this.#syncNow(current.snapshot, current.registryIdentity);
        for (const waiter of current.waiters) waiter.resolve();
        current = undefined;
      }
    } catch (cause) {
      const waiters = [
        ...(current?.waiters ?? []),
        ...(this.#pendingSync?.waiters ?? []),
      ];
      this.#pendingSync = undefined;
      for (const waiter of waiters) waiter.reject(cause);
      throw cause;
    } finally {
      this.#activeSyncRevision = undefined;
      this.#syncDrainQueued = false;
      // A sync can be requested by a completion callback at the edge of the
      // final await/finally turn. Never strand that candidate.
      if (this.#pendingSync) this.#ensureSyncDrain();
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #requireConnected(): XrAuthorityConnectionView {
    if (this.#state.phase !== "connected" || !this.#connection || !this.#projection
      || !this.#projectionDigest || !this.#registryDigest) {
      throw new XrAuthoritySyncError("not_connected", "XR authority is not connected");
    }
    return this.#connection;
  }

  #clearConnection(): void {
    this.#connection = undefined;
    this.#projection = undefined;
    this.#projectionDigest = undefined;
    this.#registryDigest = undefined;
    this.#deltasSinceCheckpoint = 0;
    this.#ephemeralSequences.clear();
    this.#pendingEphemerals.clear();
    this.#acknowledgedInputDeliveryIds.clear();
    const pending = this.#pendingSync;
    this.#pendingSync = undefined;
    this.#activeSyncRevision = undefined;
    this.#syncDrainQueued = false;
    if (pending) {
      const error = new XrAuthoritySyncError("not_connected", "XR authority is not connected");
      for (const waiter of pending.waiters) waiter.reject(error);
    }
  }

  #publish(snapshot: XrAuthoritySnapshot): void {
    this.#state = Object.freeze({ ...snapshot });
    for (const listener of this.#listeners) listener(this.#state);
  }
}
