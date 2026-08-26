import { describe, expect, it } from "vitest";
import {
  XR_PROTOCOL_LIMITS,
  XR_RELAY_PROTOCOL_VERSION,
  parseXrRelayMessage,
  type XrDeltaMessage,
  type XrInputMessage,
  type XrSnapshotMessage,
} from "../../xr/protocol";
import {
  XrPairingStore,
  XrRelay,
  XrRelayControlError,
  type XrRelayConnection,
  type XrRelaySession,
} from "../../../server/xr";

const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;
const DIGEST_C = `sha256:${"c".repeat(64)}` as const;
const REGISTRY_DIGEST = `sha256:${"d".repeat(64)}` as const;

function setup(options: {
  maximumDeltaHistory?: number;
  maximumOutboxMessages?: number;
  maximumRequestHistory?: number;
  maximumRendererSessions?: number;
  now?: () => number;
} = {}) {
  let tokenCursor = 0;
  let codeCursor = 0;
  let pairingCursor = 0;
  let bearerCursor = 0;
  const idCursors = { session: 0, epoch: 0, request: 0 };
  const now = options.now ?? (() => 1_000);
  const pairingStore = new XrPairingStore({
    now,
    tokenFactory: () => Buffer.alloc(32, ++tokenCursor).toString("base64url"),
    pairingCodeFactory: () => String(++codeCursor).padStart(6, "0"),
    idFactory: () => `pairing-${String(++pairingCursor).padStart(4, "0")}`,
  });
  const relay = new XrRelay({
    now,
    pairingStore,
    maximumDeltaHistory: options.maximumDeltaHistory,
    maximumOutboxMessages: options.maximumOutboxMessages,
    maximumRequestHistory: options.maximumRequestHistory,
    maximumRendererSessions: options.maximumRendererSessions,
    idFactory: (kind) => `${kind}-${String(++idCursors[kind]).padStart(4, "0")}`,
    sessionBearerFactory: () => Buffer.alloc(32, ++bearerCursor).toString("base64url"),
  });
  const authority = relay.connectAuthority({ workspaceId: "workspace-xr" });
  const pairing = relay.createPairing(credential(authority));
  const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
  return { relay, pairingStore, authority, renderer, pairing };
}

function credential(connection: XrRelayConnection) {
  return {
    sessionId: connection.sessionId,
    sessionBearer: connection.sessionBearer,
  } as const;
}

function snapshot(
  authority: XrRelaySession,
  revision = 0,
  digest: `sha256:${string}` = DIGEST_A,
  requestId = `snapshot-${revision.toString().padStart(4, "0")}`,
): XrSnapshotMessage {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "snapshot",
    sessionId: authority.sessionId,
    authorityEpoch: authority.authorityEpoch,
    workspaceId: authority.workspaceId,
    revision,
    requestId,
    registryDigest: REGISTRY_DIGEST,
    snapshotDigest: digest,
    snapshot: { revision, components: [] },
  };
}

function delta(
  authority: XrRelaySession,
  baseRevision: number,
  revision: number,
  baseSnapshotDigest: `sha256:${string}`,
  snapshotDigest: `sha256:${string}`,
  requestId = `delta-${revision.toString().padStart(4, "0")}`,
): XrDeltaMessage {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "delta",
    sessionId: authority.sessionId,
    authorityEpoch: authority.authorityEpoch,
    workspaceId: authority.workspaceId,
    revision,
    requestId,
    baseRevision,
    baseSnapshotDigest,
    snapshotDigest,
    delta: { operations: [{ op: "project", revision }] },
  };
}

function input(
  renderer: XrRelaySession,
  authorityEpoch: string,
  revision: number,
  requestId: string,
): XrInputMessage {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "input",
    sessionId: renderer.sessionId,
    authorityEpoch,
    workspaceId: renderer.workspaceId,
    revision,
    requestId,
    inputType: "select",
    payload: { componentId: "CMP_1" },
  };
}

function poseInput(
  renderer: XrRelaySession,
  authorityEpoch: string,
  revision: number,
  requestId: string,
  sample: number,
): XrInputMessage {
  return {
    ...input(renderer, authorityEpoch, revision, requestId),
    inputType: "pose",
    payload: { sample },
  };
}

function panelInput(
  renderer: XrRelaySession,
  authorityEpoch: string,
  revision: number,
  requestId: string,
): XrInputMessage {
  return {
    ...input(renderer, authorityEpoch, revision, requestId),
    inputType: "panel_action",
    payload: { panelId: "panel-controls", actionId: "start" },
  };
}

function inputResult(
  authority: XrRelaySession,
  sequence: number,
  requestId = `input-result-${sequence.toString().padStart(4, "0")}`,
  inputRequestId = `renderer-input-${sequence.toString().padStart(4, "0")}`,
) {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "ephemeral" as const,
    sessionId: authority.sessionId,
    authorityEpoch: authority.authorityEpoch,
    workspaceId: authority.workspaceId,
    revision: 3,
    requestId,
    channel: "input.result",
    sequence,
    payload: {
      inputRequestId,
      inputType: "select",
      workspaceRevision: 3,
      status: "handled",
      code: "selected",
    },
  } as const;
}

describe("XrRelay single-authority core", () => {
  it("scopes Voice Relay permission to the exact one-time renderer pairing", () => {
    const { relay, authority, renderer } = setup();
    expect(renderer.capabilities).toEqual({ voiceRelay: false });
    expect(() => relay.authorizeVoiceRelaySession(credential(renderer))).toThrowError(
      expect.objectContaining({ code: "role_not_allowed" }),
    );

    const enabledPairing = relay.createPairing(credential(authority), { voiceRelay: true });
    const enabledRenderer = relay.connectRenderer({ pairingToken: enabledPairing.pairingToken });
    expect(enabledRenderer.capabilities).toEqual({ voiceRelay: true });
    expect(relay.authorizeVoiceRelaySession(credential(enabledRenderer))).toMatchObject({
      sessionId: enabledRenderer.sessionId,
      role: "xr_renderer",
      capabilities: { voiceRelay: true },
    });
  });

  it("recovers an exact idempotent authority connect without retaining its raw bearer", () => {
    const relay = new XrRelay();
    const first = relay.connectAuthority({
      workspaceId: "workspace-connect-recovery",
      requestId: "authority-connect-recovery-0001",
    });
    const recovered = relay.connectAuthority({
      workspaceId: "workspace-connect-recovery",
      requestId: "authority-connect-recovery-0001",
    });
    expect(recovered).toEqual(first);
    expect(relay.authority).not.toHaveProperty("sessionBearer");
    expect(() => relay.connectAuthority({
      workspaceId: "workspace-connect-recovery",
      requestId: "authority-connect-different-0001",
    })).toThrowError(expect.objectContaining({ code: "authority_already_connected" }));
  });

  it("uses a separate 256-bit bearer for every authenticated session operation", () => {
    const { relay, authority, renderer } = setup();
    expect(Buffer.from(authority.sessionBearer, "base64url")).toHaveLength(32);
    expect(Buffer.from(renderer.sessionBearer, "base64url")).toHaveLength(32);
    expect(authority.sessionBearer).not.toBe(renderer.sessionBearer);
    expect(relay.authority).not.toHaveProperty("sessionBearer");
    expect(relay.getSession(renderer.sessionId)).not.toHaveProperty("sessionBearer");

    const wrongCredential = {
      sessionId: renderer.sessionId,
      sessionBearer: Buffer.alloc(32, 250).toString("base64url"),
    } as const;
    const currentInput = input(renderer, authority.authorityEpoch, 0, "bearer-input");
    const reconnectCursor = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      sessionId: renderer.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 0,
      snapshotDigest: DIGEST_A,
      requestId: "bearer-reconnect",
    } as const;

    expect(() => relay.acceptMessage(wrongCredential, currentInput)).toThrowError(expect.objectContaining({
      code: "session_unauthorized",
    }));
    expect(() => relay.drainMessages(wrongCredential)).toThrowError(expect.objectContaining({
      code: "session_unauthorized",
    }));
    expect(() => relay.planReconnect(wrongCredential, reconnectCursor)).toThrowError(expect.objectContaining({
      code: "session_unauthorized",
    }));
    expect(() => relay.acceptMessage({ sessionId: renderer.sessionId }, currentInput)).toThrowError(
      expect.objectContaining({ code: "session_unauthorized" }),
    );
    expect(() => relay.drainMessages({
      ...credential(renderer),
      extra: true,
    })).toThrowError(expect.objectContaining({ code: "session_unauthorized" }));
    expect(() => relay.drainMessages({
      sessionId: renderer.sessionId,
      sessionBearer: authority.sessionBearer,
    })).toThrowError(expect.objectContaining({ code: "session_unauthorized" }));

    expect(relay.disconnectSession(credential(renderer))).toBe(true);
    expect(() => relay.drainMessages(credential(renderer))).toThrowError(expect.objectContaining({
      code: "session_unauthorized",
    }));
  });

  it("enforces one authority and separates authority and renderer roles", () => {
    const { relay, authority, renderer } = setup();
    expect(() => relay.connectAuthority({ workspaceId: "workspace-other" })).toThrowError(expect.objectContaining({
      code: "authority_already_connected",
    }));
    expect(() => relay.createPairing(credential(renderer))).toThrowError(expect.objectContaining({
      code: "role_not_allowed",
    }));

    const rendererSnapshot = { ...snapshot(authority), sessionId: renderer.sessionId };
    expect(relay.acceptMessage(credential(renderer), rendererSnapshot)).toMatchObject({
      messageType: "error",
      code: "role_not_allowed",
    });
    const authorityInput = {
      ...input(renderer, authority.authorityEpoch, 0, "authority-input"),
      sessionId: authority.sessionId,
    };
    expect(relay.acceptMessage(credential(authority), authorityInput)).toMatchObject({
      messageType: "error",
      code: "role_not_allowed",
    });
    expect(() => relay.connectAuthority({ workspaceId: "workspace-xr", extra: true })).toThrow(/unknown field/u);
  });

  it("accepts a contiguous committed stream and handles exact duplicates without routing twice", () => {
    const { relay, authority, renderer } = setup();
    const initial = snapshot(authority, 2, DIGEST_A, "snapshot-request");
    expect(relay.acceptMessage(credential(authority), initial)).toMatchObject({
      messageType: "ack", status: "accepted", revision: 2,
    });
    expect(relay.drainMessages(credential(renderer))).toEqual([parseXrRelayMessage({
      ...initial,
      sessionId: renderer.sessionId,
    })]);

    expect(relay.acceptMessage(credential(authority), initial)).toMatchObject({
      messageType: "ack", status: "duplicate", revision: 2,
    });
    expect(relay.acceptMessage(credential(authority), {
      ...initial,
      snapshot: { components: [], revision: 2 },
    })).toMatchObject({ messageType: "ack", status: "duplicate" });
    expect(relay.drainMessages(credential(renderer))).toEqual([]);
    expect(relay.acceptMessage(credential(authority), {
      ...initial,
      snapshot: { revision: 2, components: [{ id: "changed" }] },
    })).toMatchObject({ messageType: "error", code: "duplicate_conflict" });

    const next = delta(authority, 2, 3, DIGEST_A, DIGEST_B);
    expect(relay.acceptMessage(credential(authority), next)).toMatchObject({
      messageType: "ack", status: "accepted", revision: 3,
    });
    expect(relay.drainMessages(credential(renderer))).toEqual([parseXrRelayMessage({
      ...next,
      sessionId: renderer.sessionId,
    })]);
  });

  it("rejects stale, future, conflicting, digest-mismatched, and non-contiguous updates", () => {
    const { relay, authority } = setup();
    expect(relay.acceptMessage(credential(authority), snapshot(authority, 5, DIGEST_A))).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(authority), delta(
      authority, 4, 5, DIGEST_A, DIGEST_B, "stale-delta",
    ))).toMatchObject({ code: "stale_revision", expectedRevision: 5 });
    expect(relay.acceptMessage(credential(authority), delta(
      authority, 6, 7, DIGEST_A, DIGEST_B, "future-delta",
    ))).toMatchObject({ code: "future_revision", expectedRevision: 5 });
    expect(relay.acceptMessage(credential(authority), delta(
      authority, 5, 7, DIGEST_A, DIGEST_B, "jump-delta",
    ))).toMatchObject({ code: "out_of_order", expectedRevision: 6 });
    expect(relay.acceptMessage(credential(authority), delta(
      authority, 5, 6, DIGEST_B, DIGEST_C, "wrong-digest",
    ))).toMatchObject({ code: "digest_mismatch", expectedRevision: 5 });
    expect(relay.acceptMessage(credential(authority), snapshot(
      authority, 5, DIGEST_B, "conflicting-snapshot",
    ))).toMatchObject({ code: "revision_conflict" });
  });

  it("accepts a newer full snapshot as a resync checkpoint and resets reconnect history", () => {
    const { relay, authority, renderer } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 1, DIGEST_A));
    relay.acceptMessage(credential(authority), delta(authority, 1, 2, DIGEST_A, DIGEST_B));
    relay.drainMessages(credential(renderer));

    const checkpoint = snapshot(authority, 7, DIGEST_C, "checkpoint-0007");
    expect(relay.acceptMessage(credential(authority), checkpoint)).toMatchObject({
      messageType: "ack",
      status: "accepted",
      revision: 7,
    });
    expect(relay.drainMessages(credential(renderer))).toEqual([parseXrRelayMessage({
      ...checkpoint,
      sessionId: renderer.sessionId,
    })]);

    expect(relay.planReconnect(credential(renderer), {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      sessionId: renderer.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 2,
      snapshotDigest: DIGEST_B,
      requestId: "checkpoint-reconnect-old",
    })).toMatchObject({
      kind: "full_snapshot",
      revision: 7,
      snapshot: { revision: 7, snapshotDigest: DIGEST_C },
      deltas: [],
    });
    expect(relay.acceptMessage(credential(authority), snapshot(
      authority, 6, DIGEST_B, "stale-checkpoint",
    ))).toMatchObject({ code: "stale_revision", expectedRevision: 7 });
    expect(relay.acceptMessage(credential(authority), snapshot(
      authority, 7, DIGEST_B, "conflicting-checkpoint",
    ))).toMatchObject({ code: "revision_conflict", expectedRevision: 7 });
  });

  it("requires a refreshing snapshot before bounded delta history can overflow", () => {
    const { relay, authority } = setup({ maximumDeltaHistory: 1 });
    relay.acceptMessage(credential(authority), snapshot(authority, 0, DIGEST_A));
    relay.acceptMessage(credential(authority), delta(authority, 0, 1, DIGEST_A, DIGEST_B));
    expect(relay.acceptMessage(credential(authority), delta(
      authority, 1, 2, DIGEST_B, DIGEST_C,
    ))).toMatchObject({ code: "snapshot_required", expectedRevision: 1 });
    expect(relay.acceptMessage(credential(authority), snapshot(
      authority, 1, DIGEST_B, "refresh-snapshot",
    ))).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(authority), delta(
      authority, 1, 2, DIGEST_B, DIGEST_C,
    ))).toMatchObject({ status: "accepted", revision: 2 });
  });

  it("requires a checkpoint before a maximum-size reconnect history can exceed the client envelope", () => {
    const { relay, authority, renderer } = setup();
    const digestAt = (revision: number) => (
      `sha256:${revision.toString(16).padStart(64, "0")}` as `sha256:${string}`
    );
    expect(relay.acceptMessage(
      credential(authority),
      snapshot(authority, 0, digestAt(0)),
    )).toMatchObject({ status: "accepted" });
    relay.drainMessages(credential(renderer));

    let revision = 0;
    let rejected: XrDeltaMessage | undefined;
    while (revision < 128) {
      const nextRevision = revision + 1;
      const candidate: XrDeltaMessage = {
        ...delta(authority, revision, nextRevision, digestAt(revision), digestAt(nextRevision)),
        delta: {
          padding: [
            "x".repeat((XR_PROTOCOL_LIMITS.maximumDeltaBytes - 4_096) / 2),
            "y".repeat((XR_PROTOCOL_LIMITS.maximumDeltaBytes - 4_096) / 2),
          ],
        },
      };
      const result = relay.acceptMessage(credential(authority), candidate);
      if (result.messageType === "error") {
        expect(result).toMatchObject({ code: "snapshot_required", expectedRevision: revision });
        rejected = candidate;
        break;
      }
      revision = nextRevision;
    }
    expect(rejected).toBeDefined();
    expect(revision).toBeGreaterThan(1);

    const plan = relay.planReconnect(credential(renderer), {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: Number.MAX_SAFE_INTEGER,
      snapshotDigest: DIGEST_A,
      requestId: "maximum-byte-reconnect",
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, data: { plan } }), "utf8"))
      .toBeLessThanOrEqual(XR_PROTOCOL_LIMITS.maximumControlResponseBytes);

    expect(relay.acceptMessage(
      credential(authority),
      snapshot(authority, revision, digestAt(revision), "byte-budget-checkpoint"),
    )).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(authority), rejected!)).toMatchObject({ status: "accepted" });
  });

  it("routes only current-revision renderer inputs and deduplicates them", () => {
    const { relay, authority, renderer } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    expect(relay.acceptMessage(credential(renderer), input(
      renderer, authority.authorityEpoch, 2, "input-stale",
    ))).toMatchObject({ code: "stale_revision", expectedRevision: 3 });
    expect(relay.acceptMessage(credential(renderer), input(
      renderer, authority.authorityEpoch, 4, "input-future",
    ))).toMatchObject({ code: "future_revision", expectedRevision: 3 });

    const accepted = input(renderer, authority.authorityEpoch, 3, "input-current");
    expect(relay.acceptMessage(credential(renderer), accepted)).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(renderer), accepted)).toMatchObject({ status: "duplicate" });
    expect(relay.drainMessages(credential(authority))).toEqual([parseXrRelayMessage({
      ...accepted,
      sessionId: authority.sessionId,
    })]);
  });

  it("retains accepted input until its relay delivery is explicitly acknowledged", () => {
    const { relay, authority, renderer } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    const accepted = input(renderer, authority.authorityEpoch, 3, "input-reliable-0001");
    expect(relay.acceptMessage(credential(renderer), accepted)).toMatchObject({ status: "accepted" });

    const first = relay.pollDeliveries(credential(authority));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      deliveryId: expect.stringMatching(/^delivery-/u),
      sourceSessionId: renderer.sessionId,
      message: { messageType: "input", requestId: "input-reliable-0001" },
    });
    // A lost HTTP response sends no acknowledgement, so the exact delivery is
    // returned again instead of silently dropping an accepted user action.
    expect(relay.pollDeliveries(credential(authority))).toEqual(first);
    expect(relay.pollDeliveries(credential(authority), [first[0]!.deliveryId])).toEqual([]);
    expect(relay.pollDeliveries(credential(authority))).toEqual([]);
  });

  it("reports renderer-to-authority queue age from the relay clock on every poll", () => {
    let now = 10_000;
    const { relay, authority, renderer } = setup({ now: () => now });
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    expect(relay.acceptMessage(
      credential(renderer),
      poseInput(renderer, authority.authorityEpoch, 3, "pose-delayed-poll", 1),
    )).toMatchObject({ status: "accepted" });

    now = 10_375;
    const first = relay.pollDeliveries(credential(authority));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      sourceSessionId: renderer.sessionId,
      serverReceivedAtMs: 10_000,
      serverQueueAgeMs: 375,
      message: { inputType: "pose", requestId: "pose-delayed-poll" },
    });

    now = 11_250;
    expect(relay.pollDeliveries(credential(authority))).toEqual([{
      ...first[0]!,
      serverQueueAgeMs: 1_250,
    }]);
    now = 9_999;
    expect(() => relay.pollDeliveries(credential(authority))).toThrow(/clock moved backwards/u);
    expect(relay.pollDeliveries(credential(renderer))).toEqual([]);
  });

  it("drops a saturated ephemeral update instead of evicting reliable renderer input", () => {
    const { relay, authority, renderer } = setup({ maximumOutboxMessages: 1 });
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    const accepted = input(renderer, authority.authorityEpoch, 3, "input-survives-ephemeral");
    expect(relay.acceptMessage(credential(renderer), accepted)).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(renderer), {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral",
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 3,
      requestId: "ephemeral-dropped-when-full",
      channel: "pose.left_hand",
      sequence: 1,
      payload: { x: 1 },
    })).toMatchObject({ status: "accepted" });
    expect(relay.pollDeliveries(credential(authority))).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ requestId: "input-survives-ephemeral" }),
      }),
    ]);
  });

  it("coalesces live pose under one-slot pressure without starving reliable renderer actions", () => {
    const { relay, authority, renderer } = setup({ maximumOutboxMessages: 1 });
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));

    for (const sample of [1, 2, 3]) {
      expect(relay.acceptMessage(credential(renderer), poseInput(
        renderer,
        authority.authorityEpoch,
        3,
        `pose-sample-${sample}`,
        sample,
      ))).toMatchObject({ status: "accepted" });
    }
    const latestPose = relay.pollDeliveries(credential(authority));
    expect(latestPose).toHaveLength(1);
    expect(latestPose[0]).toMatchObject({
      message: {
        messageType: "input",
        inputType: "pose",
        requestId: "pose-sample-3",
        payload: { sample: 3 },
      },
    });
    expect(relay.pollDeliveries(
      credential(authority),
      [latestPose[0]!.deliveryId],
    )).toEqual([]);

    const select = input(renderer, authority.authorityEpoch, 3, "select-survives-pose");
    expect(relay.acceptMessage(credential(renderer), select)).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(renderer), poseInput(
      renderer,
      authority.authorityEpoch,
      3,
      "pose-cannot-evict-select",
      4,
    ))).toMatchObject({ code: "capacity_exhausted", retryable: true });
    const reliableSelect = relay.pollDeliveries(credential(authority));
    expect(reliableSelect).toHaveLength(1);
    expect(reliableSelect[0]).toMatchObject({
      message: { inputType: "select", requestId: "select-survives-pose" },
    });
    expect(relay.pollDeliveries(
      credential(authority),
      [reliableSelect[0]!.deliveryId],
    )).toEqual([]);

    expect(relay.acceptMessage(credential(renderer), poseInput(
      renderer,
      authority.authorityEpoch,
      3,
      "pose-yields-to-panel",
      5,
    ))).toMatchObject({ status: "accepted" });
    const panel = panelInput(renderer, authority.authorityEpoch, 3, "panel-evicts-pose");
    expect(relay.acceptMessage(credential(renderer), panel)).toMatchObject({ status: "accepted" });
    expect(relay.pollDeliveries(credential(authority))).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          inputType: "panel_action",
          requestId: "panel-evicts-pose",
        }),
      }),
    ]);
  });

  it("routes ephemeral messages without persistence and enforces per-channel sequence order", () => {
    const { relay, authority, renderer } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 1, DIGEST_A));
    relay.drainMessages(credential(renderer));
    const ephemeral = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral",
      sessionId: renderer.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 1,
      requestId: "ephemeral-0001",
      channel: "pose.left_hand",
      sequence: 4,
      payload: { position: [0, 1, 0] },
    } as const;
    expect(relay.acceptMessage(credential(renderer), ephemeral)).toMatchObject({ status: "accepted" });
    expect(relay.drainMessages(credential(authority))).toEqual([parseXrRelayMessage({
      ...ephemeral,
      sessionId: authority.sessionId,
    })]);
    expect(relay.acceptMessage(credential(renderer), {
      ...ephemeral,
      requestId: "ephemeral-0002",
      sequence: 3,
    })).toMatchObject({ code: "out_of_order" });
  });

  it("rewrites presence provenance, coalesces duplicate heartbeats, and retains ordered transitions", () => {
    const { relay, authority, renderer, pairing } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 1, DIGEST_A));
    relay.drainMessages(credential(renderer));
    const presence = (phase: "active" | "ended" | "replica_ready", sequence: number) => ({
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral" as const,
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 1,
      requestId: `renderer-presence-${sequence.toString().padStart(4, "0")}`,
      channel: "xr.session.presence",
      sequence,
      payload: { phase },
    });

    expect(relay.acceptMessage(credential(renderer), presence("active", 1)))
      .toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(renderer), presence("active", 2)))
      .toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(renderer), presence("ended", 3)))
      .toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(renderer), presence("replica_ready", 4)))
      .toMatchObject({ status: "accepted" });
    const routed = relay.pollDeliveries(credential(authority));
    expect(routed).toHaveLength(3);
    expect(routed[0]).toMatchObject({
      sourceSessionId: renderer.sessionId,
      message: {
        channel: "xr.session.presence",
        sequence: 2,
        payload: { phase: "active" },
      },
    });
    expect(routed[1]).toMatchObject({
      sourceSessionId: renderer.sessionId,
      message: {
        messageType: "ephemeral",
        channel: "xr.session.presence",
        sequence: 3,
        payload: {
          phase: "ended",
          sourceSessionId: renderer.sessionId,
          sourcePairingId: pairing.pairingId,
          serverReceivedAtMs: 1_000,
        },
      },
    });
    expect(routed[2]).toMatchObject({
      sourceSessionId: renderer.sessionId,
      message: {
        channel: "xr.session.presence",
        sequence: 4,
        payload: { phase: "replica_ready" },
      },
    });
    expect(relay.acceptMessage(credential(authority), {
      ...presence("active", 5),
      sessionId: authority.sessionId,
      requestId: "authority-forged-presence",
    })).toMatchObject({ code: "role_not_allowed" });
    expect(relay.acceptMessage(credential(renderer), {
      ...presence("active", 5),
      requestId: "renderer-forged-presence",
      payload: { phase: "active", sourceSessionId: "forged-session" },
    })).toMatchObject({ code: "invalid_message" });
  });

  it("routes a desktop exit request only to its authenticated target renderer", () => {
    const { relay, authority, renderer } = setup({ maximumRendererSessions: 2 });
    const otherPairing = relay.createPairing(credential(authority));
    const otherRenderer = relay.connectRenderer({ pairingToken: otherPairing.pairingToken });
    relay.acceptMessage(credential(authority), snapshot(authority, 1, DIGEST_A));
    relay.drainMessages(credential(renderer));
    relay.drainMessages(credential(otherRenderer));
    const control = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral" as const,
      sessionId: authority.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: authority.workspaceId,
      revision: 1,
      requestId: "targeted-exit-request-0001",
      channel: "xr.session.control",
      sequence: 1,
      payload: { action: "request_exit", targetSessionId: renderer.sessionId },
    } as const;
    expect(relay.acceptMessage(credential(authority), control)).toMatchObject({ status: "accepted" });
    expect(relay.drainMessages(credential(renderer))).toEqual([
      expect.objectContaining({
        channel: "xr.session.control",
        payload: { action: "request_exit" },
      }),
    ]);
    expect(relay.drainMessages(credential(otherRenderer))).toEqual([]);
    expect(relay.acceptMessage(credential(otherRenderer), {
      ...control,
      sessionId: otherRenderer.sessionId,
      requestId: "renderer-exit-forgery-0001",
    })).toMatchObject({ code: "role_not_allowed" });
  });

  it("expires an idle renderer lease, awaits owner cleanup, and publishes authenticated terminal presence", async () => {
    let now = 1_000;
    const rig = setup({ now: () => now });
    const { relay, authority, renderer, pairing } = rig;
    const removals: Array<Readonly<{ sessionId: string; reason: string }>> = [];
    relay.onRendererSessionRemoved(async ({ session, reason }) => {
      await Promise.resolve();
      removals.push({ sessionId: session.sessionId, reason });
    });
    relay.acceptMessage(credential(authority), snapshot(authority, 1, DIGEST_A));
    relay.drainMessages(credential(renderer));
    expect(relay.acceptMessage(credential(renderer), {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral",
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 1,
      requestId: "presence-before-expiry-0001",
      channel: "xr.session.presence",
      sequence: 1,
      payload: { phase: "active" },
    })).toMatchObject({ status: "accepted" });
    const activePresence = relay.pollDeliveries(credential(authority));
    expect(activePresence).toHaveLength(1);
    expect(relay.pollDeliveries(
      credential(authority),
      [activePresence[0]!.deliveryId],
    )).toEqual([]);

    now += 10_001;
    const terminal = relay.pollDeliveries(credential(authority));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      message: {
        channel: "xr.session.presence",
        sequence: 2,
        payload: {
          phase: "expired",
          sourceSessionId: renderer.sessionId,
          sourcePairingId: pairing.pairingId,
          serverReceivedAtMs: now,
        },
      },
    });
    expect(() => relay.authorizeSession(credential(renderer))).toThrowError(
      expect.objectContaining({ code: "session_unauthorized" }),
    );
    await relay.drainRendererRemovals();
    expect(removals).toEqual([{ sessionId: renderer.sessionId, reason: "expired" }]);
  });

  it("produces current, delta, and full-snapshot reconnect plans", () => {
    const { relay, authority, renderer } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 2, DIGEST_A));
    relay.acceptMessage(credential(authority), delta(authority, 2, 3, DIGEST_A, DIGEST_B));
    relay.acceptMessage(credential(authority), delta(authority, 3, 4, DIGEST_B, DIGEST_C));

    const cursor = (revision: number, snapshotDigest: `sha256:${string}`, authorityEpoch = authority.authorityEpoch) => ({
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      sessionId: renderer.sessionId,
      authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision,
      snapshotDigest,
      requestId: `reconnect-${revision.toString().padStart(4, "0")}`,
    });
    expect(relay.planReconnect(credential(renderer), cursor(4, DIGEST_C))).toMatchObject({ kind: "current", revision: 4 });
    // A reconnect plan supersedes any state deliveries that were left
    // unacknowledged when the previous poll connection was interrupted.
    expect(relay.pollDeliveries(credential(renderer))).toEqual([]);
    expect(relay.planReconnect(credential(renderer), cursor(2, DIGEST_A))).toMatchObject({
      kind: "deltas",
      fromRevision: 2,
      revision: 4,
      deltas: [{ revision: 3 }, { revision: 4 }],
    });
    expect(relay.planReconnect(credential(renderer), cursor(3, DIGEST_A))).toMatchObject({
      kind: "full_snapshot",
      snapshot: { revision: 2 },
      deltas: [{ revision: 3 }, { revision: 4 }],
    });
    expect(relay.planReconnect(credential(renderer), cursor(4, DIGEST_C, "epoch-obsolete"))).toMatchObject({
      kind: "full_snapshot",
      revision: 4,
    });
  });

  it("retains an unacknowledged host input result across renderer recovery", () => {
    const { relay, authority, renderer } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    expect(relay.acceptMessage(credential(renderer), input(
      renderer, authority.authorityEpoch, 3, "renderer-input-request-0001",
    ))).toMatchObject({ status: "accepted" });
    relay.drainMessages(credential(authority));
    const result = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral",
      sessionId: authority.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: authority.workspaceId,
      revision: 3,
      requestId: "input-result-delivery-0001",
      channel: "input.result",
      sequence: 1,
      payload: {
        inputRequestId: "renderer-input-request-0001",
        inputType: "select",
        workspaceRevision: 3,
        status: "handled",
        code: "selected",
      },
    } as const;
    expect(relay.acceptMessage(credential(authority), result)).toMatchObject({ status: "accepted" });
    const originalDelivery = relay.pollDeliveries(credential(renderer));
    expect(originalDelivery).toHaveLength(1);

    expect(relay.planReconnect(credential(renderer), {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      sessionId: renderer.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 3,
      snapshotDigest: DIGEST_A,
      requestId: "reconnect-after-input-result",
    })).toMatchObject({ kind: "current", revision: 3 });
    expect(relay.pollDeliveries(credential(renderer))).toEqual(originalDelivery);
    expect(relay.pollDeliveries(
      credential(renderer),
      [originalDelivery[0]!.deliveryId],
    )).toEqual([]);
  });

  it("routes each host input result only to its authenticated source renderer", () => {
    const { relay, authority, renderer } = setup({ maximumRendererSessions: 2 });
    const secondPairing = relay.createPairing(credential(authority));
    const secondRenderer = relay.connectRenderer({ pairingToken: secondPairing.pairingToken });
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    relay.drainMessages(credential(secondRenderer));

    expect(relay.acceptMessage(credential(renderer), input(
      renderer, authority.authorityEpoch, 3, "renderer-one-input-0001",
    ))).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(credential(secondRenderer), input(
      secondRenderer, authority.authorityEpoch, 3, "renderer-two-input-0001",
    ))).toMatchObject({ status: "accepted" });
    relay.drainMessages(credential(authority));

    expect(relay.acceptMessage(credential(authority), inputResult(
      authority, 1, "renderer-one-result-0001", "renderer-one-input-0001",
    ))).toMatchObject({ status: "accepted" });
    expect(relay.pollDeliveries(credential(renderer))).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ requestId: "renderer-one-result-0001" }) }),
    ]);
    expect(relay.pollDeliveries(credential(secondRenderer))).toEqual([]);

    expect(relay.acceptMessage(credential(authority), inputResult(
      authority, 2, "renderer-two-result-0001", "renderer-two-input-0001",
    ))).toMatchObject({ status: "accepted" });
    expect(relay.pollDeliveries(credential(secondRenderer))).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ requestId: "renderer-two-result-0001" }) }),
    ]);
  });

  it("protects reliable input results from ordinary outbox eviction", () => {
    const { relay, authority, renderer } = setup({ maximumOutboxMessages: 2 });
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    expect(relay.acceptMessage(credential(renderer), input(
      renderer, authority.authorityEpoch, 3, "renderer-input-0001",
    ))).toMatchObject({ status: "accepted" });
    relay.drainMessages(credential(authority));
    const result = inputResult(authority, 1);
    expect(relay.acceptMessage(credential(authority), result)).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(
      credential(authority),
      snapshot(authority, 3, DIGEST_A, "snapshot-pressure-0001"),
    )).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(
      credential(authority),
      snapshot(authority, 3, DIGEST_A, "snapshot-pressure-0002"),
    )).toMatchObject({ status: "accepted" });
    expect(relay.acceptMessage(
      credential(authority),
      snapshot(authority, 3, DIGEST_A, "snapshot-pressure-0003"),
    )).toMatchObject({ status: "accepted" });

    const deliveries = relay.pollDeliveries(credential(renderer));
    expect(deliveries.map(({ message }) => message)).toEqual([
      expect.objectContaining({ messageType: "ephemeral", channel: "input.result" }),
      expect.objectContaining({ messageType: "snapshot", requestId: "snapshot-pressure-0002" }),
      expect.objectContaining({ messageType: "snapshot", requestId: "snapshot-pressure-0003" }),
    ]);
    // Reliable and ordinary quotas can coexist above either individual quota;
    // one bounded page can acknowledge that combined delivery set.
    expect(relay.pollDeliveries(
      credential(renderer),
      deliveries.map(({ deliveryId }) => deliveryId),
    )).toEqual([]);
  });

  it("applies reliable-result backpressure only to the authenticated source renderer", () => {
    const { relay, authority, renderer } = setup({
      maximumOutboxMessages: 2,
      maximumRendererSessions: 2,
    });
    const secondPairing = relay.createPairing(credential(authority));
    const secondRenderer = relay.connectRenderer({ pairingToken: secondPairing.pairingToken });
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    relay.drainMessages(credential(secondRenderer));

    for (const sequence of [1, 2, 3]) {
      expect(relay.acceptMessage(credential(secondRenderer), input(
        secondRenderer,
        authority.authorityEpoch,
        3,
        `renderer-input-${sequence.toString().padStart(4, "0")}`,
      ))).toMatchObject({ status: "accepted" });
      relay.drainMessages(credential(authority));
      if (sequence < 3) {
        expect(relay.acceptMessage(credential(authority), inputResult(authority, sequence)))
          .toMatchObject({ status: "accepted" });
      }
    }
    const third = inputResult(authority, 3);
    expect(relay.acceptMessage(credential(authority), third)).toMatchObject({
      messageType: "error",
      code: "capacity_exhausted",
      retryable: true,
    });
    expect(relay.drainMessages(credential(renderer))).toEqual([]);
    expect(relay.drainMessages(credential(secondRenderer))).toHaveLength(2);

    expect(relay.acceptMessage(credential(authority), third)).toMatchObject({ status: "accepted" });
    expect(relay.drainMessages(credential(renderer))).toEqual([]);
    expect(relay.drainMessages(credential(secondRenderer))).toEqual([
      expect.objectContaining({ requestId: third.requestId }),
    ]);
  });

  it("deduplicates an exact ephemeral retry after bounded request history eviction", () => {
    const { relay, authority, renderer } = setup({ maximumRequestHistory: 1 });
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    relay.drainMessages(credential(renderer));
    expect(relay.acceptMessage(credential(renderer), input(
      renderer, authority.authorityEpoch, 3, "renderer-input-0001",
    ))).toMatchObject({ status: "accepted" });
    relay.drainMessages(credential(authority));
    const result = inputResult(authority, 1, "input-result-lost-ack");
    expect(relay.acceptMessage(credential(authority), result)).toMatchObject({ status: "accepted" });
    relay.drainMessages(credential(renderer));
    expect(relay.acceptMessage(
      credential(authority),
      snapshot(authority, 3, DIGEST_A, "request-history-evictor"),
    )).toMatchObject({ status: "accepted" });
    relay.drainMessages(credential(renderer));

    expect(relay.acceptMessage(credential(authority), result)).toMatchObject({ status: "duplicate" });
    expect(relay.drainMessages(credential(renderer))).toEqual([]);
  });

  it("rejects renderer attempts to spoof the authority input-result channel", () => {
    const { relay, authority, renderer } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 3, DIGEST_A));
    expect(relay.acceptMessage(credential(authority), {
      ...inputResult(authority, 1, "invalid-authority-result"),
      payload: { status: "handled" },
    })).toMatchObject({
      messageType: "error",
      code: "invalid_message",
      retryable: false,
    });
    const spoof = {
      ...inputResult(authority, 1, "renderer-result-spoof"),
      sessionId: renderer.sessionId,
    };
    expect(relay.acceptMessage(credential(renderer), spoof)).toMatchObject({
      messageType: "error",
      code: "role_not_allowed",
      retryable: false,
    });
  });

  it("expires renderer identity across authority reconnect and rejects the old epoch after re-pairing", () => {
    const { relay, authority, renderer } = setup();
    relay.acceptMessage(credential(authority), snapshot(authority, 1, DIGEST_A));
    expect(relay.disconnectSession(credential(authority))).toBe(true);
    expect(() => relay.acceptMessage(credential(renderer), input(
      renderer, authority.authorityEpoch, 1, "offline-input",
    ))).toThrowError(expect.objectContaining({ code: "session_unauthorized" }));

    const nextAuthority = relay.connectAuthority({ workspaceId: "workspace-xr" });
    expect(nextAuthority.authorityEpoch).not.toBe(authority.authorityEpoch);
    relay.acceptMessage(credential(nextAuthority), snapshot(nextAuthority, 0, DIGEST_B));
    expect(() => relay.acceptMessage(credential(renderer), input(
      renderer, authority.authorityEpoch, 0, "expired-renderer-input",
    ))).toThrowError(expect.objectContaining({ code: "session_unauthorized" }));

    const nextPairing = relay.createPairing(credential(nextAuthority));
    const nextRenderer = relay.connectRenderer({ pairingToken: nextPairing.pairingToken });
    expect(relay.acceptMessage(credential(nextRenderer), input(
      nextRenderer, authority.authorityEpoch, 0, "old-epoch-input",
    ))).toMatchObject({
      code: "stale_epoch",
      expectedAuthorityEpoch: nextAuthority.authorityEpoch,
    });
    expect(relay.planReconnect(credential(nextRenderer), {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      sessionId: nextRenderer.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 1,
      snapshotDigest: DIGEST_A,
      requestId: "reconnect-new-epoch",
    })).toMatchObject({
      kind: "full_snapshot",
      authorityEpoch: nextAuthority.authorityEpoch,
      snapshot: { revision: 0, snapshotDigest: DIGEST_B },
    });
  });

  it("makes pairing single-use and revocation disconnects a paired renderer", () => {
    const { relay, authority, renderer, pairing } = setup();
    expect(() => relay.connectRenderer({ pairingToken: pairing.pairingToken })).toThrowError(expect.objectContaining({
      code: "pairing_invalid",
    }));
    // Minting a later grant may compact the pairing store's terminal-token
    // records. Relay-owned scope metadata must still let the authority revoke
    // the live renderer without retaining the original secret.
    relay.createPairing(credential(authority));
    expect(relay.revokePairing(credential(authority), { pairingId: pairing.pairingId })).toBe(true);
    expect(relay.getSession(renderer.sessionId)).toBeUndefined();
    expect(() => relay.drainMessages(credential(renderer))).toThrow(XrRelayControlError);
  });

  it("accepts exactly one pairing credential and makes code and token aliases single-use", () => {
    const { relay, authority } = setup();
    const pairing = relay.createPairing(credential(authority));
    expect(pairing.pairingCode).toMatch(/^[0-9]{6}$/u);
    expect(() => relay.connectRenderer({})).toThrowError(expect.objectContaining({
      code: "invalid_control_request",
    }));
    expect(() => relay.connectRenderer({
      pairingToken: pairing.pairingToken,
      pairingCode: pairing.pairingCode,
    })).toThrowError(expect.objectContaining({
      code: "invalid_control_request",
    }));
    expect(() => relay.connectRenderer({ pairingToken: pairing.pairingCode })).toThrowError(expect.objectContaining({
      code: "pairing_invalid",
    }));
    expect(() => relay.connectRenderer({ pairingCode: pairing.pairingToken })).toThrowError(expect.objectContaining({
      code: "pairing_invalid",
    }));
    expect(relay.connectRenderer({ pairingCode: pairing.pairingCode })).toMatchObject({
      role: "xr_renderer",
      pairingId: pairing.pairingId,
    });
    expect(() => relay.connectRenderer({ pairingToken: pairing.pairingToken })).toThrowError(expect.objectContaining({
      code: "pairing_invalid",
    }));
  });

  it("rate limits failed six-digit attempts without changing long-token behavior", () => {
    let now = 1_000;
    const { relay, authority } = setup({ now: () => now });
    const codePairing = relay.createPairing(credential(authority));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(() => relay.connectRenderer({
        pairingCode: String(900_001 + attempt).padStart(6, "0"),
      })).toThrowError(expect.objectContaining({ code: "pairing_invalid" }));
    }
    expect(() => relay.connectRenderer({ pairingCode: "900005" })).toThrowError(expect.objectContaining({
      code: "pairing_rate_limited",
    }));

    const tokenPairing = relay.createPairing(credential(authority));
    expect(relay.connectRenderer({ pairingToken: tokenPairing.pairingToken })).toMatchObject({
      role: "xr_renderer",
    });

    now += 60_000;
    expect(relay.connectRenderer({ pairingCode: codePairing.pairingCode })).toMatchObject({
      role: "xr_renderer",
      pairingId: codePairing.pairingId,
    });
  });

  it("bounds renderer sessions without consuming a rejected pairing capability", () => {
    const { relay, authority, renderer } = setup({ maximumRendererSessions: 1 });
    const second = relay.createPairing(credential(authority));
    expect(() => relay.connectRenderer({ pairingToken: second.pairingToken })).toThrowError(expect.objectContaining({
      code: "renderer_capacity",
    }));
    expect(relay.disconnectSession(credential(renderer))).toBe(true);
    expect(relay.connectRenderer({ pairingToken: second.pairingToken })).toMatchObject({ role: "xr_renderer" });
  });

  it("turns malformed wire messages into valid closed errors without accepting them", () => {
    const { relay, authority } = setup();
    const response = relay.acceptMessage(credential(authority), {
      ...snapshot(authority),
      requestId: "invalid-message-request",
      hiddenMutation: { op: "delete_component" },
    });
    expect(response).toMatchObject({
      messageType: "error",
      code: "invalid_message",
      requestId: "invalid-message-request",
    });
    expect(parseXrRelayMessage(response)).toEqual(response);
  });
});
