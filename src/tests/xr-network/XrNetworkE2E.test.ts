// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { XrRelay, createXrHttpHandler } from "../../../server/xr";
import { parseXrInputResult, type XrInputResult } from "../../xr/authority";
import {
  XR_HTTP_PATHS,
  XrAuthorityHttpTransport,
  XrViewerHttpTransport,
  type XrNetworkFetch,
} from "../../xr/network";
import {
  XR_RELAY_PROTOCOL_VERSION,
  type XrEphemeralMessage,
  type XrInputMessage,
  type XrSnapshotMessage,
} from "../../xr/protocol";
import {
  ManualTimers,
  REGISTRY_DIGEST,
  TEST_ORIGIN,
  settle,
} from "./fixtures";

const SNAPSHOT_DIGEST = `sha256:${"d".repeat(64)}` as const;

function glb(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x67, 0x6c, 0x54, 0x46]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, byteLength, true);
  bytes.fill(7, 12);
  return bytes;
}

describe("XR browser transports through the in-memory Fetch handler", () => {
  it("recovers one authority connection after its creation response is lost", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, { trustedLocalAuthority: () => true });
    const connectBodies: unknown[] = [];
    let discardResponse = true;
    const fetch: XrNetworkFetch = async (inputValue, init) => {
      const request = new Request(inputValue, init);
      if (new URL(request.url).pathname === XR_HTTP_PATHS.authorityConnect) {
        connectBodies.push(await request.clone().json());
        const response = await handle(request);
        if (discardResponse) {
          discardResponse = false;
          throw new TypeError("simulated authority connect response loss");
        }
        return response;
      }
      return handle(request);
    };
    const authority = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });

    const identity = await authority.connect("workspace-e2e-connect-recovery");
    expect(connectBodies).toHaveLength(2);
    expect(connectBodies[1]).toEqual(connectBodies[0]);
    expect(connectBodies[0]).toEqual({
      workspaceId: "workspace-e2e-connect-recovery",
      requestId: expect.any(String),
    });
    expect(relay.authority).toMatchObject(identity);

    await authority.disconnect();
    expect(relay.authority).toBeUndefined();
  });

  it("recovers a committed authority connection after its success body is truncated", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, { trustedLocalAuthority: () => true });
    const connectBodies: unknown[] = [];
    let truncateResponse = true;
    const fetch: XrNetworkFetch = async (inputValue, init) => {
      const request = new Request(inputValue, init);
      if (new URL(request.url).pathname === XR_HTTP_PATHS.authorityConnect) {
        connectBodies.push(await request.clone().json());
        const committed = await handle(request);
        if (truncateResponse) {
          truncateResponse = false;
          return new Response('{"ok":true,"data":', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return committed;
      }
      return handle(request);
    };
    const authority = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });

    const identity = await authority.connect("workspace-e2e-connect-truncated");
    expect(connectBodies).toHaveLength(2);
    expect(connectBodies[1]).toEqual(connectBodies[0]);
    expect(relay.authority).toMatchObject(identity);

    await authority.disconnect();
    expect(relay.authority).toBeUndefined();
  });

  it("round-trips authority state, one-shot pairing, renderer input, reconnect, and assets", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, {
      trustedLocalAuthority: () => true,
    });
    const observedRequests: Request[] = [];
    const fetch: XrNetworkFetch = async (input, init) => {
      const request = new Request(input, init);
      observedRequests.push(request.clone());
      return handle(request);
    };
    const authority = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });
    const authorityIdentity = await authority.connect("workspace-e2e");
    const committed: XrSnapshotMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "snapshot",
      ...authorityIdentity,
      revision: 3,
      requestId: "e2e-snapshot-request",
      registryDigest: REGISTRY_DIGEST,
      snapshotDigest: SNAPSHOT_DIGEST,
      snapshot: { revision: 3, components: [{ id: "CMP_E2E" }] },
    };
    await expect(authority.send(committed)).resolves.toMatchObject({
      messageType: "ack",
      status: "accepted",
    });

    const bytes = glb(32);
    const assetDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const stored = await authority.putAsset(
      new Blob([
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ], { type: "model/gltf-binary" }),
      assetDigest,
      "mesh-glb",
      60_000,
    );
    expect(stored.descriptor).toMatchObject({ digest: assetDigest, byteLength: 32 });

    const pairing = await authority.createPairing(30_000);
    const timers = new ManualTimers();
    const received: XrSnapshotMessage[] = [];
    const viewerTransport = new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      requestId: () => "e2e-initial-reconnect",
    });
    const viewer = await viewerTransport.pair({
      pairingToken: pairing.pairingToken,
      signal: new AbortController().signal,
      onMessage: (message) => {
        if (message.messageType === "snapshot") received.push(message);
      },
      onDisconnected: vi.fn(),
    });

    const reusedTransport = new XrViewerHttpTransport({ baseUrl: TEST_ORIGIN, fetch });
    await expect(reusedTransport.pair({
      pairingToken: pairing.pairingToken,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    })).rejects.toMatchObject({ code: "unauthorized", retryable: false });

    expect(timers.runNext(0)).toBe(true);
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      sessionId: viewer.identity.sessionId,
      authorityEpoch: viewer.identity.authorityEpoch,
      workspaceId: viewer.identity.workspaceId,
      revision: 3,
      snapshotDigest: SNAPSHOT_DIGEST,
    });

    const rendererInput: XrInputMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "input",
      ...viewer.identity,
      revision: 3,
      requestId: "e2e-viewer-input",
      inputType: "activate",
      payload: { componentId: "CMP_E2E" },
    };
    await viewer.send(rendererInput);
    await expect(authority.poll()).resolves.toEqual([{
      deliveryId: expect.stringMatching(/^delivery-/u),
      sourceSessionId: viewer.identity.sessionId,
      serverReceivedAtMs: expect.any(Number),
      serverQueueAgeMs: expect.any(Number),
      message: {
        ...rendererInput,
        sessionId: authorityIdentity.sessionId,
      },
    }]);

    const downloaded = await viewer.openAsset(assetDigest, "mesh-glb", bytes.byteLength);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

    await viewer.reconnect({
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      ...viewer.identity,
      revision: 3,
      snapshotDigest: SNAPSHOT_DIGEST,
      requestId: "e2e-current-reconnect",
    });
    expect(received).toHaveLength(1);

    await viewer.close();
    await authority.disconnect();
    expect(relay.authority).toBeUndefined();
    expect(timers.pendingDelays()).toEqual([]);

    for (const request of observedRequests) {
      expect(new URL(request.url).search).toBe("");
      expect(request.url).not.toContain(pairing.pairingToken);
    }
    const pairingBodies = await Promise.all(observedRequests
      .filter((request) => request.method === "POST")
      .map(async (request) => JSON.stringify(await request.json())));
    expect(pairingBodies.filter((body) => body.includes(pairing.pairingToken))).toHaveLength(2);
    expect(JSON.stringify(authority)).not.toContain(pairing.pairingToken);
    expect(JSON.stringify(viewer)).not.toContain(pairing.pairingToken);
  });

  it("converges after a committed viewer input acknowledgement is lost without executing the host action twice", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, { trustedLocalAuthority: () => true });
    const authorityFetch: XrNetworkFetch = (input, init) => handle(new Request(input, init));
    const authority = new XrAuthorityHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch: authorityFetch,
    });
    const authorityIdentity = await authority.connect("workspace-e2e-lost-ack");
    const committed: XrSnapshotMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "snapshot",
      ...authorityIdentity,
      revision: 3,
      requestId: "e2e-lost-ack-snapshot",
      registryDigest: REGISTRY_DIGEST,
      snapshotDigest: SNAPSHOT_DIGEST,
      snapshot: { revision: 3, components: [{ id: "CMP_E2E_ACK" }] },
    };
    await expect(authority.send(committed)).resolves.toMatchObject({ status: "accepted" });

    const pairing = await authority.createPairing(30_000);
    const viewerSendBodies: unknown[] = [];
    let discardFirstCommittedAck = true;
    const viewerFetch: XrNetworkFetch = async (inputValue, init) => {
      const request = new Request(inputValue, init);
      if (new URL(request.url).pathname === XR_HTTP_PATHS.sessionSend) {
        const body = await request.clone().json() as Record<string, unknown>;
        const message = body.message as Record<string, unknown> | undefined;
        if (message?.messageType === "input") {
          viewerSendBodies.push(body);
          const response = await handle(request);
          if (discardFirstCommittedAck) {
            discardFirstCommittedAck = false;
            throw new TypeError("simulated response loss after relay commit");
          }
          return response;
        }
      }
      return handle(request);
    };
    const timers = new ManualTimers();
    const inputResults: XrInputResult[] = [];
    const viewer = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch: viewerFetch,
      timers,
      requestId: () => "e2e-lost-ack-reconnect",
    }).pair({
      pairingToken: pairing.pairingToken,
      signal: new AbortController().signal,
      onMessage: (message) => {
        if (message.messageType !== "ephemeral") return;
        const result = parseXrInputResult(message);
        if (result) inputResults.push(result);
      },
      onDisconnected: vi.fn(),
    });
    const rendererInput: XrInputMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "input",
      ...viewer.identity,
      revision: 3,
      requestId: "e2e-viewer-input-lost-ack",
      inputType: "activate",
      payload: { componentId: "CMP_E2E_ACK" },
    };

    await expect(viewer.send(rendererInput)).resolves.toBeUndefined();
    expect(viewerSendBodies).toHaveLength(2);
    expect(viewerSendBodies[0]).toEqual(viewerSendBodies[1]);
    expect(viewerSendBodies[0]).toEqual({ message: rendererInput });

    const deliveries = await authority.poll();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.message).toMatchObject({
      messageType: "input",
      requestId: rendererInput.requestId,
      inputType: rendererInput.inputType,
      payload: rendererInput.payload,
    });
    let hostActionCount = 0;
    hostActionCount += 1;
    const inputResult: XrEphemeralMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral",
      ...authorityIdentity,
      revision: 3,
      requestId: "e2e-input-result-lost-ack",
      channel: "input.result",
      sequence: 1,
      payload: {
        inputRequestId: rendererInput.requestId,
        inputType: rendererInput.inputType,
        workspaceRevision: rendererInput.revision,
        status: "handled",
        code: "activated",
      },
    };
    await expect(authority.send(inputResult)).resolves.toMatchObject({ status: "accepted" });
    await expect(authority.poll([deliveries[0]!.deliveryId])).resolves.toEqual([]);
    expect(hostActionCount).toBe(1);

    expect(timers.runNext(0)).toBe(true);
    await settle(128);
    expect(inputResults).toEqual([{
      inputRequestId: rendererInput.requestId,
      inputType: rendererInput.inputType,
      workspaceRevision: rendererInput.revision,
      status: "handled",
      code: "activated",
    }]);

    await viewer.close();
    await authority.disconnect();
    expect(timers.pendingDelays()).toEqual([]);
  });

  it("replays a committed authority snapshot after a lost acknowledgement without routing it twice", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, { trustedLocalAuthority: () => true });
    const authorityBodies: unknown[] = [];
    let discardFirstCommittedAck = false;
    const authorityFetch: XrNetworkFetch = async (inputValue, init) => {
      const request = new Request(inputValue, init);
      if (new URL(request.url).pathname === XR_HTTP_PATHS.sessionSend) {
        authorityBodies.push(await request.clone().json());
        const response = await handle(request);
        if (discardFirstCommittedAck) {
          discardFirstCommittedAck = false;
          throw new TypeError("simulated authority response loss after relay commit");
        }
        return response;
      }
      return handle(request);
    };
    const directFetch: XrNetworkFetch = (input, init) => handle(new Request(input, init));
    const authority = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch: authorityFetch });
    const identity = await authority.connect("workspace-e2e-authority-lost-ack");
    await authority.send({
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "snapshot",
      ...identity,
      revision: 1,
      requestId: "e2e-authority-initial-snapshot",
      registryDigest: REGISTRY_DIGEST,
      snapshotDigest: SNAPSHOT_DIGEST,
      snapshot: { revision: 1, components: [] },
    });
    authorityBodies.length = 0;
    const pairing = await authority.createPairing();
    const timers = new ManualTimers();
    const received: XrSnapshotMessage[] = [];
    const viewer = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch: directFetch,
      timers,
      requestId: () => "authority-lost-ack-initial-reconnect",
    }).pair({
      pairingToken: pairing.pairingToken,
      signal: new AbortController().signal,
      onMessage: (message) => {
        if (message.messageType === "snapshot") received.push(message);
      },
      onDisconnected: vi.fn(),
    });
    expect(timers.runNext(0)).toBe(true);
    await settle(128);
    received.length = 0;
    discardFirstCommittedAck = true;
    const committed: XrSnapshotMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "snapshot",
      ...identity,
      revision: 2,
      requestId: "e2e-authority-snapshot-lost-ack",
      registryDigest: REGISTRY_DIGEST,
      snapshotDigest: SNAPSHOT_DIGEST,
      snapshot: { revision: 2, components: [{ id: "CMP_AUTHORITY_REPLAY" }] },
    };

    await expect(authority.send(committed)).resolves.toMatchObject({ status: "duplicate" });
    expect(authorityBodies).toEqual([{ message: committed }, { message: committed }]);
    expect(timers.runNext(100)).toBe(true);
    await settle(128);
    expect(received).toEqual([expect.objectContaining({
      requestId: committed.requestId,
      revision: committed.revision,
      sessionId: viewer.identity.sessionId,
    })]);

    await viewer.close();
    await authority.disconnect();
  });

  it("releases an epoch-expired viewer so the same page transport can pair to a restarted authority", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, { trustedLocalAuthority: () => true });
    const fetch: XrNetworkFetch = (input, init) => handle(new Request(input, init));
    const publish = async (authority: XrAuthorityHttpTransport, revision: number) => {
      const identity = await authority.connect("workspace-e2e-repair");
      await authority.send({
        protocolVersion: XR_RELAY_PROTOCOL_VERSION,
        messageType: "snapshot",
        ...identity,
        revision,
        requestId: `epoch-snapshot-${revision.toString().padStart(4, "0")}`,
        registryDigest: REGISTRY_DIGEST,
        snapshotDigest: SNAPSHOT_DIGEST,
        snapshot: { revision, components: [] },
      });
      return identity;
    };

    const firstAuthority = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });
    const firstIdentity = await publish(firstAuthority, 1);
    const firstPairing = await firstAuthority.createPairing();
    const timers = new ManualTimers();
    const disconnected = vi.fn();
    const viewerTransport = new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      pollIntervalMs: 5,
      maximumPollFailures: 1,
    });
    const firstViewer = await viewerTransport.pair({
      pairingToken: firstPairing.pairingToken,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: disconnected,
    });
    expect(timers.runNext(0)).toBe(true);
    await settle();

    await firstAuthority.disconnect();
    expect(timers.runNext(5)).toBe(true);
    await settle();
    expect(disconnected).toHaveBeenCalledWith({
      reason: "XR authentication failed.",
      retryable: false,
    });

    const secondAuthority = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });
    const secondIdentity = await publish(secondAuthority, 2);
    const secondPairing = await secondAuthority.createPairing();
    const secondViewer = await viewerTransport.pair({
      pairingToken: secondPairing.pairingToken,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });
    expect(secondIdentity.authorityEpoch).not.toBe(firstIdentity.authorityEpoch);
    expect(secondViewer.identity.authorityEpoch).toBe(secondIdentity.authorityEpoch);
    expect(secondViewer.identity.sessionId).not.toBe(firstViewer.identity.sessionId);

    await secondViewer.close();
    await secondAuthority.disconnect();
  });
});
