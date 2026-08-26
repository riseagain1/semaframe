import {
  applyXrWorkspaceProjectionDelta,
  digestXrProjection,
  parseXrWorkspaceProjection,
  parseXrWorkspaceProjectionDelta,
  type XrWorkspaceProjection,
} from "../authority";
import {
  XR_RELAY_PROTOCOL_VERSION,
  parseXrRelayMessage,
  type XrDeltaMessage,
  type XrInputMessage,
  type XrInputType,
  type XrJsonObject,
  type XrReconnectCursor,
  type XrRelayMessage,
  type XrSnapshotMessage,
} from "../protocol";
import type { XrViewerSessionIdentity } from "./contracts";
import type { XrViewerReconnectDelivery } from "./contracts";

export class XrViewerReplicaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "XrViewerReplicaError";
  }
}

export type XrViewerReplicaApplyResult = Readonly<{
  status: "applied" | "duplicate";
  projection: XrWorkspaceProjection;
}>;

function projectionFrom(message: XrSnapshotMessage): XrWorkspaceProjection {
  const value = parseXrWorkspaceProjection(message.snapshot);
  if (value.workspaceId !== message.workspaceId || value.revision !== message.revision) {
    throw new XrViewerReplicaError("invalid_projection", "XR snapshot metadata is inconsistent");
  }
  return value;
}

function deltaFrom(message: XrDeltaMessage) {
  const value = parseXrWorkspaceProjectionDelta(message.delta);
  if (value.workspaceId !== message.workspaceId || value.baseRevision !== message.baseRevision
    || value.revision !== message.revision) {
    throw new XrViewerReplicaError("invalid_delta", "XR delta metadata is inconsistent");
  }
  return value;
}

function sameIdentity(message: XrRelayMessage, identity: XrViewerSessionIdentity): void {
  if (message.sessionId !== identity.sessionId || message.authorityEpoch !== identity.authorityEpoch
    || message.workspaceId !== identity.workspaceId) {
    throw new XrViewerReplicaError("session_mismatch", "XR message does not belong to this renderer session");
  }
}

/** Exact, renderer-only replica. It never exposes a mutation API or creates a WorkspaceStore. */
export class XrViewerProjectionReplica {
  private current?: XrWorkspaceProjection;
  private currentDigest?: `sha256:${string}`;

  constructor(readonly identity: XrViewerSessionIdentity) {}

  get projection(): XrWorkspaceProjection | undefined {
    return this.current;
  }

  get snapshotDigest(): `sha256:${string}` | undefined {
    return this.currentDigest;
  }

  async apply(input: unknown): Promise<XrViewerReplicaApplyResult> {
    const parsed = parseXrRelayMessage(input);
    sameIdentity(parsed, this.identity);
    if (parsed.messageType !== "snapshot" && parsed.messageType !== "delta") {
      throw new XrViewerReplicaError("role_not_allowed", "Renderer replicas accept snapshot and delta messages only");
    }
    return parsed.messageType === "snapshot" ? this.applySnapshot(parsed) : this.applyDelta(parsed);
  }

  /**
   * Applies a reconnect plan to an isolated candidate and commits it only once
   * the whole chain has validated. A full snapshot intentionally starts from a
   * fresh replica, so an authoritative recovery checkpoint can replace a
   * locally newer but digest-divergent copy without weakening ordinary stale
   * snapshot rejection.
   */
  async applyReconnect(delivery: XrViewerReconnectDelivery): Promise<XrViewerReplicaApplyResult> {
    const candidate = new XrViewerProjectionReplica(this.identity);
    if (delivery.kind !== "full_snapshot") {
      candidate.current = this.current;
      candidate.currentDigest = this.currentDigest;
    }

    if (delivery.kind === "current") {
      if (delivery.messages.length !== 0) {
        throw new XrViewerReplicaError("invalid_reconnect", "A current XR reconnect plan cannot contain messages");
      }
    } else if (delivery.kind === "full_snapshot") {
      if (delivery.messages[0]?.messageType !== "snapshot") {
        throw new XrViewerReplicaError("snapshot_required", "A full XR reconnect plan must begin with a snapshot");
      }
    } else if (delivery.messages.some(({ messageType }) => messageType !== "delta")) {
      throw new XrViewerReplicaError("invalid_reconnect", "An incremental XR reconnect plan may contain only deltas");
    }

    let status: XrViewerReplicaApplyResult["status"] = "duplicate";
    for (const message of delivery.messages) {
      const result = await candidate.apply(message);
      if (result.status === "applied") status = "applied";
    }
    if (!candidate.current || !candidate.currentDigest) {
      throw new XrViewerReplicaError("snapshot_required", "An XR snapshot is required before reconnect can complete");
    }

    this.current = candidate.current;
    this.currentDigest = candidate.currentDigest;
    return Object.freeze({ status, projection: this.current });
  }

  reconnectCursor(requestId: string): XrReconnectCursor | undefined {
    if (!this.current || !this.currentDigest) return undefined;
    return Object.freeze({
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      ...this.identity,
      revision: this.current.revision,
      snapshotDigest: this.currentDigest,
      requestId,
    });
  }

  private async applySnapshot(message: XrSnapshotMessage): Promise<XrViewerReplicaApplyResult> {
    const digest = await digestXrProjection(message.snapshot);
    if (digest !== message.snapshotDigest) {
      throw new XrViewerReplicaError("digest_mismatch", "XR snapshot digest does not match its contents");
    }
    const next = projectionFrom(message);
    if (this.current) {
      if (next.revision < this.current.revision) {
        throw new XrViewerReplicaError("stale_revision", "XR snapshot is older than the renderer replica");
      }
      if (next.revision === this.current.revision) {
        if (digest !== this.currentDigest) {
          throw new XrViewerReplicaError("revision_conflict", "XR snapshot conflicts with the current revision");
        }
        return Object.freeze({ status: "duplicate", projection: this.current });
      }
    }
    this.current = next;
    this.currentDigest = digest;
    return Object.freeze({ status: "applied", projection: next });
  }

  private async applyDelta(message: XrDeltaMessage): Promise<XrViewerReplicaApplyResult> {
    if (!this.current || !this.currentDigest) {
      throw new XrViewerReplicaError("snapshot_required", "An XR snapshot is required before deltas");
    }
    if (message.baseRevision !== this.current.revision || message.revision !== this.current.revision + 1) {
      throw new XrViewerReplicaError("out_of_order", "XR delta does not extend the current revision");
    }
    if (message.baseSnapshotDigest !== this.currentDigest) {
      throw new XrViewerReplicaError("digest_mismatch", "XR delta starts from a different snapshot digest");
    }
    const next = applyXrWorkspaceProjectionDelta(this.current, deltaFrom(message));
    const digest = await digestXrProjection(next);
    if (digest !== message.snapshotDigest) {
      throw new XrViewerReplicaError("digest_mismatch", "XR delta result digest does not match its envelope");
    }
    this.current = next;
    this.currentDigest = digest;
    return Object.freeze({ status: "applied", projection: next });
  }
}

export function createXrViewerInputMessage(input: Readonly<{
  identity: XrViewerSessionIdentity;
  revision: number;
  requestId: string;
  inputType: XrInputType;
  payload: XrJsonObject;
}>): XrInputMessage {
  return parseXrRelayMessage({
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "input",
    ...input.identity,
    revision: input.revision,
    requestId: input.requestId,
    inputType: input.inputType,
    payload: input.payload,
  }) as XrInputMessage;
}
