import { describe, expect, it } from "vitest";
import { XrRelay, type XrRelayCredential } from "../../../server/xr";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import {
  XrAuthorityController,
  XrAuthoritySyncError,
  digestXrProjection,
  type XrAuthorityTransport,
} from "../../xr/authority";
import type { XrRoutableMessage } from "../../xr/protocol";

function snapshot(revision: number, label = `Box ${revision}`): WorkspaceRenderSnapshot {
  return {
    workspaceId: "workspace_xr_authority",
    revision,
    components: [{
      id: "box",
      type: { typeId: "spatial-entity", version: "1.2", digest: "manifest:test" },
      label,
      props: { shape: "box", color: "#68D5FF" },
      durableState: {},
      placement: {
        space: "world3d",
        position: { x: revision, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      tags: [],
      visibility: "visible",
      locks: { placement: false },
    }],
  };
}

class MemoryAuthorityTransport implements XrAuthorityTransport {
  credential?: XrRelayCredential;
  readonly sentMessages: XrRoutableMessage[] = [];

  constructor(readonly relay: XrRelay) {}

  async connect(workspaceId: string) {
    const connection = this.relay.connectAuthority({ workspaceId });
    this.credential = { sessionId: connection.sessionId, sessionBearer: connection.sessionBearer };
    return connection;
  }

  async send(message: XrRoutableMessage) {
    this.sentMessages.push(structuredClone(message));
    return this.relay.acceptMessage(this.credential, message);
  }

  async poll(acknowledgedDeliveryIds: readonly string[] = []) {
    return this.relay.pollDeliveries(this.credential, acknowledgedDeliveryIds).map((delivery) => {
      if (!delivery.sourceSessionId) throw new Error("Authority delivery is missing renderer provenance");
      return { ...delivery, sourceSessionId: delivery.sourceSessionId };
    });
  }

  async createPairing(ttlMs?: number) {
    return this.relay.createPairing(this.credential, ttlMs === undefined ? {} : { ttlMs });
  }

  async revokePairing(pairingId: string) {
    return this.relay.revokePairing(this.credential, { pairingId });
  }

  async disconnect() {
    if (this.credential) this.relay.disconnectSession(this.credential);
    this.credential = undefined;
  }
}

class LostEphemeralAckTransport extends MemoryAuthorityTransport {
  readonly ephemeralAttempts: XrRoutableMessage[] = [];
  #dropNextEphemeralAck = true;

  override async send(message: XrRoutableMessage) {
    const response = await super.send(message);
    if (message.messageType === "ephemeral") {
      this.ephemeralAttempts.push(structuredClone(message));
      if (this.#dropNextEphemeralAck) {
        this.#dropNextEphemeralAck = false;
        throw Object.assign(new Error("The committed relay ACK was lost."), { retryable: true });
      }
    }
    return response;
  }
}

describe("XrAuthorityController", () => {
  it("serializes slow preparation and publishes only the latest queued revision", async () => {
    const relay = new XrRelay();
    const transport = new MemoryAuthorityTransport(relay);
    let releaseRevisionTwo!: () => void;
    let markRevisionTwoStarted!: () => void;
    const revisionTwoStarted = new Promise<void>((resolve) => { markRevisionTwoStarted = resolve; });
    const revisionTwoGate = new Promise<void>((resolve) => { releaseRevisionTwo = resolve; });
    const prepared: number[] = [];
    let concurrentPreparations = 0;
    let maximumConcurrentPreparations = 0;
    const authority = new XrAuthorityController(transport, {
      prepareSnapshot: async (candidate) => {
        prepared.push(candidate.revision);
        concurrentPreparations += 1;
        maximumConcurrentPreparations = Math.max(maximumConcurrentPreparations, concurrentPreparations);
        if (candidate.revision === 2) {
          markRevisionTwoStarted();
          await revisionTwoGate;
        }
        concurrentPreparations -= 1;
      },
    });
    await authority.connect(snapshot(0), "registry");
    const pairing = await authority.createPairing();
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const rendererCredential = { sessionId: renderer.sessionId, sessionBearer: renderer.sessionBearer };

    const revisionTwo = authority.sync(snapshot(2), "registry");
    await revisionTwoStarted;
    const revisionThree = authority.sync(snapshot(3), "registry");
    releaseRevisionTwo();
    await Promise.all([revisionTwo, revisionThree]);

    expect(maximumConcurrentPreparations).toBe(1);
    expect(prepared).toEqual([0, 2, 3]);
    expect(relay.drainMessages(rendererCredential)).toEqual([
      expect.objectContaining({ messageType: "snapshot", revision: 3 }),
    ]);
    expect(authority.snapshot).toMatchObject({ phase: "connected", revision: 3 });
  });

  it("publishes the canonical projection, contiguous deltas, and a skipped-revision checkpoint", async () => {
    const relay = new XrRelay();
    const transport = new MemoryAuthorityTransport(relay);
    const authority = new XrAuthorityController(transport, {
      requestId: (() => { let id = 0; return () => `request-${++id}`; })(),
    });
    await authority.connect(snapshot(0), "fnv1a32:registry");
    const pairing = await authority.createPairing();
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const rendererCredential = { sessionId: renderer.sessionId, sessionBearer: renderer.sessionBearer };
    const reconnect = relay.planReconnect(rendererCredential, {
      protocolVersion: 1,
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 0,
      snapshotDigest: `sha256:${"0".repeat(64)}`,
      requestId: "reconnect-1",
    });
    expect(reconnect).toMatchObject({ kind: "full_snapshot", revision: 0 });

    await authority.sync(snapshot(1), "fnv1a32:registry");
    expect(relay.drainMessages(rendererCredential)).toEqual([
      expect.objectContaining({ messageType: "delta", baseRevision: 0, revision: 1 }),
    ]);

    await authority.sync(snapshot(4), "fnv1a32:registry");
    expect(relay.drainMessages(rendererCredential)).toEqual([
      expect.objectContaining({ messageType: "snapshot", revision: 4 }),
    ]);
    expect(authority.snapshot).toMatchObject({ phase: "connected", revision: 4 });
  });

  it("routes revision-bound renderer input back without granting renderer authority", async () => {
    const relay = new XrRelay();
    const transport = new MemoryAuthorityTransport(relay);
    const authority = new XrAuthorityController(transport);
    await authority.connect(snapshot(3), "registry");
    const pairing = await authority.createPairing();
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const credential = { sessionId: renderer.sessionId, sessionBearer: renderer.sessionBearer };
    expect(relay.acceptMessage(credential, {
      protocolVersion: 1,
      messageType: "input",
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 3,
      requestId: "input-0001",
      inputType: "activate",
      payload: { componentId: "box" },
    })).toMatchObject({ messageType: "ack", status: "accepted" });
    const deliveries = await authority.pollInputs();
    expect(deliveries).toEqual([
      expect.objectContaining({
        deliveryId: expect.stringMatching(/^delivery-/u),
        message: expect.objectContaining({ messageType: "input", inputType: "activate" }),
      }),
    ]);
    authority.acknowledgeInput(deliveries[0]!.deliveryId);
    expect(await authority.pollInputs()).toEqual([]);
    expect(authority.snapshot.rendererInputCount).toBe(1);
  });

  it("retries the exact ephemeral envelope after an ambiguous committed ACK loss", async () => {
    const relay = new XrRelay({ maximumRequestHistory: 1 });
    const transport = new LostEphemeralAckTransport(relay);
    const authority = new XrAuthorityController(transport, {
      requestId: (() => { let id = 0; return () => `request-lost-ack-${++id}`; })(),
    });
    await authority.connect(snapshot(3), "registry");
    const pairing = await authority.createPairing();
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const credential = { sessionId: renderer.sessionId, sessionBearer: renderer.sessionBearer };
    const payload = {
      inputRequestId: "renderer-input-lost-ack",
      inputType: "voice_final",
      workspaceRevision: 3,
      status: "handled",
      code: "voice_intent_forwarded",
    } as const;
    expect(relay.acceptMessage(credential, {
      protocolVersion: 1,
      messageType: "input",
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 3,
      requestId: payload.inputRequestId,
      inputType: payload.inputType,
      payload: {},
    })).toMatchObject({ status: "accepted" });
    relay.drainMessages(transport.credential);

    await expect(authority.publishEphemeral("input.result", payload))
      .rejects.toThrow("committed relay ACK was lost");
    expect(relay.drainMessages(credential)).toEqual([
      expect.objectContaining({ messageType: "ephemeral", channel: "input.result" }),
    ]);

    // Evict the normal request-history entry. The relay's per-channel exact
    // checkpoint must still recognize the retried envelope without rerouting.
    await authority.sync(snapshot(3), "registry-next");
    relay.drainMessages(credential);
    await authority.publishEphemeral("input.result", payload);
    expect(transport.ephemeralAttempts).toHaveLength(2);
    expect(transport.ephemeralAttempts[1]).toEqual(transport.ephemeralAttempts[0]);
    expect(relay.drainMessages(credential)).toEqual([]);
  });

  it("retains the exact result envelope across explicit bounded backpressure", async () => {
    const relay = new XrRelay({ maximumOutboxMessages: 1 });
    const transport = new MemoryAuthorityTransport(relay);
    const authority = new XrAuthorityController(transport, {
      requestId: (() => { let id = 0; return () => `request-capacity-${++id}`; })(),
    });
    await authority.connect(snapshot(3), "registry");
    const pairing = await authority.createPairing();
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const credential = { sessionId: renderer.sessionId, sessionBearer: renderer.sessionBearer };
    const first = {
      inputRequestId: "renderer-input-capacity-1",
      inputType: "voice_final",
      workspaceRevision: 3,
      status: "handled",
      code: "voice_intent_forwarded",
    } as const;
    const second = { ...first, inputRequestId: "renderer-input-capacity-2" } as const;
    expect(relay.acceptMessage(credential, {
      protocolVersion: 1,
      messageType: "input",
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 3,
      requestId: first.inputRequestId,
      inputType: first.inputType,
      payload: {},
    })).toMatchObject({ status: "accepted" });
    relay.drainMessages(transport.credential);
    await authority.publishEphemeral("input.result", first);
    expect(relay.acceptMessage(credential, {
      protocolVersion: 1,
      messageType: "input",
      sessionId: renderer.sessionId,
      authorityEpoch: renderer.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 3,
      requestId: second.inputRequestId,
      inputType: second.inputType,
      payload: {},
    })).toMatchObject({ status: "accepted" });
    relay.drainMessages(transport.credential);
    await expect(authority.publishEphemeral("input.result", second)).rejects.toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
    } satisfies Partial<XrAuthoritySyncError>);
    const failedEnvelope = transport.sentMessages.at(-1);
    expect(failedEnvelope).toMatchObject({ messageType: "ephemeral", sequence: 2, payload: second });

    relay.drainMessages(credential);
    await authority.publishEphemeral("input.result", second);
    expect(transport.sentMessages.at(-1)).toEqual(failedEnvelope);
    expect(relay.drainMessages(credential)).toEqual([
      expect.objectContaining({ messageType: "ephemeral", sequence: 2, payload: second }),
    ]);
  });

  it("checkpoints before bounded history fills and rejects same-revision divergence", async () => {
    const relay = new XrRelay({ maximumDeltaHistory: 1 });
    const transport = new MemoryAuthorityTransport(relay);
    const authority = new XrAuthorityController(transport, { checkpointInterval: 1 });
    await authority.connect(snapshot(0), "registry");
    const pairing = await authority.createPairing();
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const credential = { sessionId: renderer.sessionId, sessionBearer: renderer.sessionBearer };
    await authority.sync(snapshot(1), "registry");
    expect(relay.drainMessages(credential)).toEqual([
      expect.objectContaining({ messageType: "snapshot", revision: 1 }),
    ]);
    await expect(authority.sync(snapshot(1, "Diverged"), "registry"))
      .rejects.toMatchObject({ code: "revision_conflict" } satisfies Partial<XrAuthoritySyncError>);
  });

  it("publishes a checkpoint when registry identity changes without a Workspace revision", async () => {
    const relay = new XrRelay();
    const transport = new MemoryAuthorityTransport(relay);
    const authority = new XrAuthorityController(transport);
    await authority.connect(snapshot(0), "registry-a");
    const pairing = await authority.createPairing();
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const rendererCredential = { sessionId: renderer.sessionId, sessionBearer: renderer.sessionBearer };

    await authority.sync(snapshot(0), "registry-b");
    expect(relay.drainMessages(rendererCredential)).toEqual([
      expect.objectContaining({
        messageType: "snapshot",
        revision: 0,
        registryDigest: await digestXrProjection({ registryIdentity: "registry-b" }),
      }),
    ]);
    await authority.sync(snapshot(0), "registry-b");
    expect(relay.drainMessages(rendererCredential)).toEqual([]);

    await authority.sync(snapshot(1), "registry-c");
    expect(relay.drainMessages(rendererCredential)).toEqual([
      expect.objectContaining({ messageType: "snapshot", revision: 1 }),
    ]);
  });

  it("disconnects without discarding or mutating the host snapshot", async () => {
    const state = snapshot(7);
    const before = structuredClone(state);
    const relay = new XrRelay();
    const authority = new XrAuthorityController(new MemoryAuthorityTransport(relay));
    await authority.connect(state, "registry");
    await authority.disconnect();
    expect(authority.snapshot).toEqual({ phase: "idle", rendererInputCount: 0 });
    expect(state).toEqual(before);
    expect(relay.authority).toBeUndefined();
  });
});
