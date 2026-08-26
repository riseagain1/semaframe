// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  XR_ASSET_HTTP_DIGEST_HEADER,
  XR_ASSET_HTTP_FORMAT_HEADER,
  XR_ASSET_HTTP_LENGTH_HEADER,
  xrAssetHttpPath,
} from "../../xr/assets";
import {
  XR_HTTP_PATHS,
  XR_HTTP_SESSION_HEADER,
  XrNetworkError,
  XrViewerHttpTransport,
} from "../../xr/network";
import { ULTRA_POLICY_VERSION } from "../../xr/ultra";
import { VOICE_RELAY_HTTP_PATHS } from "../../voice-relay";
import type { XrReconnectCursor } from "../../xr/protocol";
import {
  AUTHORITY_EPOCH,
  DIGEST_A,
  DIGEST_B,
  ManualTimers,
  PAIRING_TOKEN,
  TEST_ORIGIN,
  VIEWER_BEARER,
  VIEWER_SESSION,
  WORKSPACE_ID,
  ack,
  cursor,
  delta,
  input,
  jsonFailure,
  jsonSuccess,
  requestOf,
  routedFetch,
  settle,
  snapshot,
  viewerConnection,
} from "./fixtures";

function fullSnapshotPlan(
  requestCursor: XrReconnectCursor,
  message = snapshot(),
): Record<string, unknown> {
  return {
    plan: {
      kind: "full_snapshot",
      authorityEpoch: AUTHORITY_EPOCH,
      workspaceId: WORKSPACE_ID,
      revision: message.revision,
      snapshotDigest: message.snapshotDigest,
      requestId: requestCursor.requestId,
      snapshot: message,
      deltas: [],
    },
  };
}

function abortPendingResponse(request: Request): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  });
}

function rangedAssetResponse(
  request: Request,
  bytes: Uint8Array,
  digest: `sha256:${string}`,
  format: "mesh-glb" | "gaussian-spz-v4" | "gaussian-ply" | "gaussian-sog-v2",
  mediaType: string,
): Response {
  const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(request.headers.get("range") ?? "");
  if (!match) throw new Error("Expected one explicit asset byte range");
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const body = bytes.slice(start, endInclusive + 1);
  return new Response(body, {
    status: 206,
    headers: {
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${endInclusive}/${bytes.byteLength}`,
      "content-type": mediaType,
      "content-length": String(body.byteLength),
      etag: `"${digest}"`,
      [XR_ASSET_HTTP_DIGEST_HEADER]: digest,
      [XR_ASSET_HTTP_FORMAT_HEADER]: format,
      [XR_ASSET_HTTP_LENGTH_HEADER]: String(bytes.byteLength),
    },
  });
}

describe("XrViewerHttpTransport", () => {
  it("posts a six-digit manual code without manufacturing or exposing a deep-link token", async () => {
    const timers = new ManualTimers();
    const requests: Request[] = [];
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: (_request, body) => {
        expect(body).toEqual({ pairingCode: "012345" });
        expect(body).not.toHaveProperty("pairingToken");
        return jsonSuccess(viewerConnection());
      },
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    }, requests);
    const transport = new XrViewerHttpTransport({ baseUrl: TEST_ORIGIN, fetch, timers });
    const session = await transport.pair({
      pairingCode: "012345",
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });

    const connectRequest = requests.find(
      (request) => new URL(request.url).pathname === XR_HTTP_PATHS.rendererConnect,
    )!;
    expect(await connectRequest.json()).toEqual({ pairingCode: "012345" });
    await session.close();

    const rejectedFetch = vi.fn();
    await expect(new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch: rejectedFetch,
      timers,
    }).pair({
      pairingCode: "12345",
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    })).rejects.toMatchObject({ code: "pairing_invalid", retryable: false });
    expect(rejectedFetch).not.toHaveBeenCalled();
  });

  it("rejects runtime requests containing both or neither pairing credential", async () => {
    const timers = new ManualTimers();
    const fetch = vi.fn();
    const invalidTransport = new XrViewerHttpTransport({ baseUrl: TEST_ORIGIN, fetch, timers });
    const callbacks = {
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    };
    await expect(invalidTransport.pair({
      ...callbacks,
      pairingToken: PAIRING_TOKEN,
      pairingCode: "012345",
    } as unknown as Parameters<XrViewerHttpTransport["pair"]>[0])).rejects.toMatchObject({
      code: "pairing_invalid",
      retryable: false,
    });
    await expect(invalidTransport.pair({
      ...callbacks,
    } as unknown as Parameters<XrViewerHttpTransport["pair"]>[0])).rejects.toMatchObject({
      code: "pairing_invalid",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose Voice Relay when the one-time pairing disabled it", async () => {
    const timers = new ManualTimers();
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection({
        capabilities: { voiceRelay: false },
      })),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({ baseUrl: TEST_ORIGIN, fetch, timers }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });

    expect(session.voiceRelay).toBeUndefined();
    await session.close();
  });

  it("routes paired Voice Relay requests through the configured direct gateway origin", async () => {
    const timers = new ManualTimers();
    const requests: Request[] = [];
    const statusPath = `${VOICE_RELAY_HTTP_PATHS.xrBase}${VOICE_RELAY_HTTP_PATHS.status}`;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [statusPath]: (request, body) => {
        expect(request.url).toBe(`${TEST_ORIGIN}${statusPath}`);
        expect(request.headers.get("authorization")).toBe(`Bearer ${VIEWER_BEARER}`);
        expect(request.headers.get(XR_HTTP_SESSION_HEADER)).toBe(VIEWER_SESSION);
        expect(body).toEqual({});
        return new Response(JSON.stringify({ enabled: false, armed: false, phase: "off" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    }, requests);
    const session = await new XrViewerHttpTransport({ baseUrl: TEST_ORIGIN, fetch, timers }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });

    await expect(session.voiceRelay!.inspect()).resolves.toEqual({
      enabled: false,
      armed: false,
      phase: "off",
    });
    expect(requests.some((request) => request.url === `${TEST_ORIGIN}${statusPath}`)).toBe(true);
    await session.close();
  });

  it("installs the bundled Ultra evidence port only inside a paired Windows x64 session", async () => {
    const timers = new ManualTimers();
    const browserProbe = {
      browserEngine: "chromium",
      secureContext: true,
      immersiveVrSupported: true,
    } as const;
    const staticProbe = {
      version: 1,
      policyVersion: ULTRA_POLICY_VERSION,
      platform: "windows",
      architecture: "x64",
      operatingSystemVersion: "10.0.26100",
      logicalProcessorCount: 24,
      systemMemoryBytes: 32 * 1024 * 1024 * 1024,
      graphics: {
        adapterFingerprint: `sha256:${"e".repeat(64)}`,
        driverVersion: "32.0.15.9000",
        hardwareAccelerated: true,
        supportedByRuntime: true,
      },
      runtime: { kind: "meta_horizon_link", version: "1.100.0", openXrActive: true },
      webXr: browserProbe,
      collectedAt: "2026-08-25T09:00:00.000Z",
    } as const;
    const probeBodies: unknown[] = [];
    let session: Awaited<ReturnType<XrViewerHttpTransport["pair"]>> | undefined;
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit Chrome/140.0",
      platform: "Win32",
      xr: { isSessionSupported: vi.fn(async () => true) },
    });
    vi.stubGlobal("isSecureContext", true);
    try {
      const fetch = routedFetch({
        [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
        [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
          jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
        ),
        [XR_HTTP_PATHS.rendererUltraProbe]: (_request, body) => {
          probeBodies.push(body);
          return jsonSuccess({ probe: staticProbe });
        },
        [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
      });
      session = await new XrViewerHttpTransport({ baseUrl: TEST_ORIGIN, fetch, timers }).pair({
        pairingToken: PAIRING_TOKEN,
        signal: new AbortController().signal,
        onMessage: vi.fn(),
        onDisconnected: vi.fn(),
      });

      expect(session.ultraEvidence).toBeDefined();
      await expect(session.ultraEvidence!.collectStaticProbe({
        signal: new AbortController().signal,
      })).resolves.toEqual(staticProbe);
      expect(probeBodies).toEqual([{ browser: browserProbe }]);
    } finally {
      await session?.close();
      vi.unstubAllGlobals();
    }
  });

  it("pairs once, delivers after pair resolves, authenticates privately, and opens a verified asset", async () => {
    const timers = new ManualTimers();
    const requests: Request[] = [];
    const received: unknown[] = [];
    const disconnected: unknown[] = [];
    const assetBytes = new TextEncoder().encode("semaframe-xr-asset");
    const assetDigest = `sha256:${createHash("sha256").update(assetBytes).digest("hex")}` as const;
    const assetPath = xrAssetHttpPath(assetDigest);
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: (request, body) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(body).toEqual({ pairingToken: PAIRING_TOKEN });
        return jsonSuccess(viewerConnection());
      },
      [XR_HTTP_PATHS.rendererReconnect]: (request, body) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${VIEWER_BEARER}`);
        expect(request.headers.get(XR_HTTP_SESSION_HEADER)).toBe(VIEWER_SESSION);
        expect(body).not.toHaveProperty("sessionBearer");
        expect(body).not.toHaveProperty("sessionId");
        return jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor));
      },
      [XR_HTTP_PATHS.sessionPoll]: () => jsonSuccess({ mode: "immediate", deliveries: [] }),
      [XR_HTTP_PATHS.sessionSend]: (request, body) => {
        const message = body!.message as ReturnType<typeof input>;
        expect(request.headers.get("authorization")).toBe(`Bearer ${VIEWER_BEARER}`);
        expect(body).toEqual({ message });
        return jsonSuccess({ response: ack(VIEWER_SESSION, message.revision, message.requestId) });
      },
      [assetPath]: (request, body) => {
        expect(request.method).toBe("GET");
        expect(body).toBeUndefined();
        expect(request.headers.get("authorization")).toBe(`Bearer ${VIEWER_BEARER}`);
        expect(request.headers.get(XR_HTTP_SESSION_HEADER)).toBe(VIEWER_SESSION);
        expect(request.headers.get("accept")).toBe("model/gltf-binary");
        return rangedAssetResponse(request, assetBytes, assetDigest, "mesh-glb", "model/gltf-binary");
      },
      [XR_HTTP_PATHS.sessionDisconnect]: (_request, body) => {
        expect(body).toEqual({});
        return jsonSuccess({ disconnected: true });
      },
    }, requests);
    const transport = new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      requestId: () => "viewer-initial-request-0001",
    });

    const pairPromise = transport.pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: (message) => { received.push(message); },
      onReconnectDelivery: (delivery) => { received.push(...delivery.messages); },
      onDisconnected: (event) => disconnected.push(event),
    });
    const session = await pairPromise;
    expect(received).toEqual([]);
    expect(session.identity).toEqual({
      sessionId: VIEWER_SESSION,
      authorityEpoch: AUTHORITY_EPOCH,
      workspaceId: WORKSPACE_ID,
    });
    expect(JSON.stringify(session)).not.toContain(VIEWER_BEARER);
    expect(JSON.stringify(session)).not.toContain(PAIRING_TOKEN);

    expect(timers.runNext(0)).toBe(true);
    await settle(128);
    expect(received).toEqual([snapshot()]);
    expect(disconnected).toEqual([]);
    expect(timers.pendingDelays()).toEqual([100]);

    await session.send(input());
    const blob = await session.openAsset(assetDigest, "mesh-glb", assetBytes.byteLength);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(assetBytes);
    expect(blob.type).toBe("model/gltf-binary");

    const connectRequest = requests.find((request) => new URL(request.url).pathname === XR_HTTP_PATHS.rendererConnect)!;
    expect(await connectRequest.json()).toEqual({ pairingToken: PAIRING_TOKEN });
    for (const request of requests.filter((entry) => entry !== connectRequest)) {
      expect(request.url).not.toContain(PAIRING_TOKEN);
      expect(request.url).not.toContain(VIEWER_BEARER);
      if (request.method !== "GET") {
        expect(JSON.stringify(await request.json())).not.toContain(VIEWER_BEARER);
      }
    }

    await session.close();
    expect(timers.pendingDelays()).toEqual([]);
  });

  it("replays the exact viewer input once when its committed HTTP acknowledgement is lost", async () => {
    const timers = new ManualTimers();
    const sentBodies: unknown[] = [];
    let attempts = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [XR_HTTP_PATHS.sessionSend]: (_request, body) => {
        attempts += 1;
        sentBodies.push(body);
        const message = body!.message as ReturnType<typeof input>;
        if (attempts === 1) {
          // The relay-side mutation has happened, but the response never
          // reaches Fetch. Retrying must not manufacture a new envelope.
          throw new TypeError("simulated lost acknowledgement");
        }
        return jsonSuccess({
          response: {
            ...ack(VIEWER_SESSION, message.revision, message.requestId),
            status: "duplicate",
          },
        });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });
    const message = input(VIEWER_SESSION, 4, "input-lost-http-ack-0001");

    await expect(session.send(message)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(sentBodies).toEqual([{ message }, { message }]);

    await session.close();
    expect(timers.pendingDelays()).toEqual([]);
  });

  it("publishes serialized lifecycle presence without accepting caller-supplied provenance", async () => {
    const timers = new ManualTimers();
    const sent: Array<Record<string, unknown>> = [];
    let requestSequence = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [XR_HTTP_PATHS.sessionSend]: (request, body) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${VIEWER_BEARER}`);
        const message = body!.message as Record<string, unknown>;
        sent.push(message);
        return jsonSuccess({
          response: ack(VIEWER_SESSION, Number(message.revision), String(message.requestId)),
        });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      requestId: () => `viewer-presence-${String(++requestSequence).padStart(4, "0")}`,
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });

    await session.publishPresence!("active", 4);
    await session.publishPresence!("ended", 4);
    expect(sent).toEqual([
      expect.objectContaining({
        protocolVersion: 1,
        messageType: "ephemeral",
        sessionId: VIEWER_SESSION,
        authorityEpoch: AUTHORITY_EPOCH,
        workspaceId: WORKSPACE_ID,
        revision: 4,
        channel: "xr.session.presence",
        sequence: 1,
        payload: { phase: "active" },
      }),
      expect.objectContaining({
        channel: "xr.session.presence",
        sequence: 2,
        payload: { phase: "ended" },
      }),
    ]);
    expect(sent.some((message) => JSON.stringify(message.payload).includes("sourceSessionId"))).toBe(false);
    await expect(session.publishPresence!("forged" as "active", 4)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(sent).toHaveLength(2);
    await session.close();
  });

  it("coalesces stalled heartbeats while preserving a following terminal transition", async () => {
    const timers = new ManualTimers();
    const sent: Array<Record<string, unknown>> = [];
    let releaseFirstSend!: () => void;
    const firstSendGate = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [XR_HTTP_PATHS.sessionSend]: async (_request, body) => {
        const message = body!.message as Record<string, unknown>;
        sent.push(message);
        if (sent.length === 1) await firstSendGate;
        return jsonSuccess({
          response: ack(VIEWER_SESSION, Number(message.revision), String(message.requestId)),
        });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    let requestSequence = 0;
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      requestId: () => `viewer-backlog-${String(++requestSequence).padStart(4, "0")}`,
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });

    const firstHeartbeat = session.publishPresence!("active", 4);
    await settle();
    const repeatedHeartbeatA = session.publishPresence!("active", 4);
    const repeatedHeartbeatB = session.publishPresence!("active", 4);
    const ended = session.publishPresence!("ended", 4);
    await settle();
    expect(sent).toHaveLength(1);

    releaseFirstSend();
    await Promise.all([firstHeartbeat, repeatedHeartbeatA, repeatedHeartbeatB, ended]);
    expect(sent.map((message) => message.payload)).toEqual([
      { phase: "active" },
      { phase: "ended" },
    ]);
    expect(sent.map((message) => message.sequence)).toEqual([1, 2]);
    await session.close();
  });

  it("applies each initial and explicit reconnect delivery exactly once", async () => {
    const timers = new ManualTimers();
    const applied = vi.fn();
    let reconnects = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => {
        reconnects += 1;
        const reconnectCursor = body!.cursor as XrReconnectCursor;
        if (reconnects === 1) return jsonSuccess(fullSnapshotPlan(reconnectCursor));
        return jsonSuccess({ plan: {
          kind: "current",
          authorityEpoch: AUTHORITY_EPOCH,
          workspaceId: WORKSPACE_ID,
          revision: reconnectCursor.revision,
          snapshotDigest: reconnectCursor.snapshotDigest,
          requestId: reconnectCursor.requestId,
        } });
      },
      [XR_HTTP_PATHS.sessionPoll]: (request) => abortPendingResponse(request),
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      requestId: () => "viewer-initial-exactly-once-0001",
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onReconnectDelivery: applied,
      onDisconnected: vi.fn(),
    });

    expect(timers.runNext(0)).toBe(true);
    await settle();
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "full_snapshot" }));

    await session.reconnect(cursor(4, DIGEST_A, "reconnect-exactly-once-0001"), {
      applyDelivery: applied,
    });
    expect(applied).toHaveBeenCalledTimes(2);
    expect(applied).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "current" }));

    await session.close();
  });

  it("validates current, delta, and full-snapshot reconnect plans before callbacks", async () => {
    const timers = new ManualTimers();
    const received: unknown[] = [];
    const disconnected = vi.fn();
    let reconnectCall = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => {
        reconnectCall += 1;
        const reconnectCursor = body!.cursor as XrReconnectCursor;
        if (reconnectCall === 1) return jsonSuccess(fullSnapshotPlan(reconnectCursor));
        if (reconnectCall === 2) {
          return jsonSuccess({ plan: {
            kind: "current",
            authorityEpoch: AUTHORITY_EPOCH,
            workspaceId: WORKSPACE_ID,
            revision: reconnectCursor.revision,
            snapshotDigest: reconnectCursor.snapshotDigest,
            requestId: reconnectCursor.requestId,
          } });
        }
        if (reconnectCall === 3) {
          return jsonSuccess({ plan: {
            kind: "deltas",
            authorityEpoch: AUTHORITY_EPOCH,
            workspaceId: WORKSPACE_ID,
            fromRevision: reconnectCursor.revision,
            revision: 5,
            snapshotDigest: DIGEST_B,
            requestId: reconnectCursor.requestId,
            deltas: [delta()],
          } });
        }
        if (reconnectCall === 4) {
          return jsonSuccess(fullSnapshotPlan(reconnectCursor, snapshot(VIEWER_SESSION, 7, DIGEST_A)));
        }
        return jsonSuccess({ plan: {
          kind: "deltas",
          authorityEpoch: AUTHORITY_EPOCH,
          workspaceId: WORKSPACE_ID,
          fromRevision: reconnectCursor.revision,
          revision: 8,
          snapshotDigest: DIGEST_B,
          requestId: reconnectCursor.requestId,
          // Contiguous revisions alone are insufficient: this deliberately
          // forks from the wrong digest and must be rejected atomically.
          deltas: [delta(VIEWER_SESSION, 7, 8, DIGEST_B, DIGEST_B)],
        } });
      },
      [XR_HTTP_PATHS.sessionPoll]: (request) => abortPendingResponse(request),
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      requestId: () => "viewer-initial-request-0002",
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: (message) => { received.push(message); },
      onDisconnected: disconnected,
    });

    // Explicit reconnect cancels the deferred initial callback, so an old
    // projection cannot be applied after the caller has already resynced.
    await session.reconnect(cursor(4, DIGEST_A, "reconnect-current-0001"));
    expect(received).toEqual([]);
    await session.reconnect(cursor(4, DIGEST_A, "reconnect-deltas-0001"));
    expect(received).toEqual([delta()]);
    await session.reconnect(cursor(5, DIGEST_B, "reconnect-full-0001"));
    expect(received).toEqual([delta(), snapshot(VIEWER_SESSION, 7, DIGEST_A)]);
    await expect(session.reconnect(cursor(7, DIGEST_A, "reconnect-forked-0001"))).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
    expect(received).toEqual([delta(), snapshot(VIEWER_SESSION, 7, DIGEST_A)]);
    expect(disconnected).toHaveBeenCalledWith({
      reason: "The XR relay returned an invalid response.",
      retryable: false,
    });
    expect(reconnectCall).toBe(5);
    await session.close();
  });

  it("rejects a mixed-identity poll batch before delivering any message from that batch", async () => {
    const timers = new ManualTimers();
    const received: unknown[] = [];
    const disconnected: unknown[] = [];
    let polls = 0;
    let remoteDisconnects = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [XR_HTTP_PATHS.sessionPoll]: () => {
        polls += 1;
        return jsonSuccess({
          mode: "immediate",
          deliveries: [
            { deliveryId: "delivery-viewer-valid-0001", message: snapshot(VIEWER_SESSION, 5, DIGEST_B, "poll-valid-0001") },
            { deliveryId: "delivery-viewer-wrong-0001", message: snapshot("different-renderer-session", 5, DIGEST_B, "poll-wrong-0001") },
          ],
        });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: (request) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${VIEWER_BEARER}`);
        remoteDisconnects += 1;
        return jsonSuccess({ disconnected: true });
      },
    });
    await new XrViewerHttpTransport({ baseUrl: TEST_ORIGIN, fetch, timers }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: (message) => { received.push(message); },
      onDisconnected: (event) => disconnected.push(event),
    });
    expect(timers.runNext(0)).toBe(true);
    await settle();

    expect(polls).toBe(1);
    expect(received).toEqual([snapshot()]);
    expect(disconnected).toEqual([{
      reason: "The XR relay response belongs to another session.",
      retryable: false,
    }]);
    expect(remoteDisconnects).toBe(1);
  });

  it("does not acknowledge a failed projection delivery and reapplies it after reconnect", async () => {
    const timers = new ManualTimers();
    const disconnected = vi.fn();
    const pollBodies: unknown[] = [];
    let reconnects = 0;
    let failApplication = true;
    const delivery = {
      deliveryId: "delivery-retryable-0001",
      message: delta(),
    };
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => {
        reconnects += 1;
        const reconnectCursor = body!.cursor as XrReconnectCursor;
        return reconnects === 1
          ? jsonSuccess(fullSnapshotPlan(reconnectCursor))
          : jsonSuccess({ plan: {
            kind: "current",
            authorityEpoch: AUTHORITY_EPOCH,
            workspaceId: WORKSPACE_ID,
            revision: reconnectCursor.revision,
            snapshotDigest: reconnectCursor.snapshotDigest,
            requestId: reconnectCursor.requestId,
          } });
      },
      [XR_HTTP_PATHS.sessionPoll]: (_request, body) => {
        pollBodies.push(body);
        const acknowledgements = body!.acknowledgedDeliveryIds as string[];
        return jsonSuccess({
          mode: "immediate",
          deliveries: acknowledgements.includes(delivery.deliveryId) ? [] : [delivery],
        });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const received: string[] = [];
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      maximumPollFailures: 1,
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: (message) => {
        received.push(message.requestId);
        if (message.messageType === "delta" && failApplication) throw new Error("replica gap");
      },
      onDisconnected: disconnected,
    });

    expect(timers.runNext(0)).toBe(true);
    await settle(128);
    expect(pollBodies).toEqual([{ acknowledgedDeliveryIds: [] }]);
    expect(disconnected).toHaveBeenCalledWith({
      reason: "The XR viewer could not apply a relay message.",
      retryable: true,
    });

    failApplication = false;
    await session.reconnect(cursor(4, DIGEST_A, "retry-application-0001"));
    await settle();
    expect(pollBodies).toEqual([
      { acknowledgedDeliveryIds: [] },
      { acknowledgedDeliveryIds: [] },
    ]);
    expect(received.filter((id) => id === delivery.message.requestId)).toHaveLength(2);

    expect(timers.runNext(100)).toBe(true);
    await settle();
    expect(pollBodies[2]).toEqual({ acknowledgedDeliveryIds: [delivery.deliveryId] });
    await session.close();
  });

  it("backs off bounded immediate polling, reports a retryable break, and reconnects with the same session", async () => {
    const timers = new ManualTimers();
    const disconnected: unknown[] = [];
    let polls = 0;
    let reconnects = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => {
        reconnects += 1;
        const reconnectCursor = body!.cursor as XrReconnectCursor;
        return reconnects === 1
          ? jsonSuccess(fullSnapshotPlan(reconnectCursor))
          : jsonSuccess({ plan: {
            kind: "current",
            authorityEpoch: AUTHORITY_EPOCH,
            workspaceId: WORKSPACE_ID,
            revision: reconnectCursor.revision,
            snapshotDigest: reconnectCursor.snapshotDigest,
            requestId: reconnectCursor.requestId,
          } });
      },
      [XR_HTTP_PATHS.sessionPoll]: () => {
        polls += 1;
        return polls <= 2
          ? jsonFailure(503, "authority_unavailable")
          : jsonSuccess({ mode: "immediate", deliveries: [] });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      pollBackoffBaseMs: 5,
      pollBackoffMaximumMs: 20,
      maximumPollFailures: 2,
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: (event) => disconnected.push(event),
    });

    expect(timers.runNext(0)).toBe(true);
    await settle();
    expect(polls).toBe(1);
    expect(timers.pendingDelays()).toEqual([5]);
    expect(timers.runNext(5)).toBe(true);
    await settle();
    expect(polls).toBe(2);
    expect(disconnected).toEqual([{
      reason: "The XR relay is temporarily unavailable.",
      retryable: true,
    }]);

    await session.reconnect(cursor(4, DIGEST_A, "retry-reconnect-0001"));
    await settle();
    expect(reconnects).toBe(2);
    expect(polls).toBe(3);
    await session.close();
  });

  it("redacts failed pairing secrets and aborts a pending request without retaining its timeout", async () => {
    const serverSecret = "relay-error-secret";
    const denied = new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch: async () => jsonFailure(401, "unauthorized", `${PAIRING_TOKEN}:${serverSecret}`),
    });
    const deniedError = await denied.pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    }).catch((error: unknown) => error);
    expect(deniedError).toBeInstanceOf(XrNetworkError);
    expect((deniedError as Error).message).toBe("XR authentication failed.");
    expect((deniedError as Error).message).not.toContain(PAIRING_TOKEN);
    expect((deniedError as Error).message).not.toContain(serverSecret);
    expect(JSON.stringify(denied)).not.toContain(PAIRING_TOKEN);

    const timers = new ManualTimers();
    const controller = new AbortController();
    const fetch = vi.fn((inputValue: RequestInfo | URL, init?: RequestInit) => {
      const request = requestOf(inputValue, init);
      return abortPendingResponse(request);
    });
    const transport = new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      requestTimeoutMs: 50,
    });
    const pending = transport.pair({
      pairingToken: PAIRING_TOKEN,
      signal: controller.signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });
    expect(timers.pendingDelays()).toEqual([50]);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(timers.pendingDelays()).toEqual([]);
  });

  it("resumes an interrupted immutable range at the exact received byte offset with bounded chunks", async () => {
    const timers = new ManualTimers();
    const bytes = new TextEncoder().encode("ply\nformat ascii 1.0\nend_header\nresume-me");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const assetRequests: Request[] = [];
    const progress = vi.fn();
    let assetAttempts = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [xrAssetHttpPath(digest)]: (request) => {
        assetRequests.push(request.clone());
        assetAttempts += 1;
        if (assetAttempts === 1) {
          expect(request.headers.get("range")).toBe(`bytes=0-${bytes.byteLength - 1}`);
          let pulls = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(bytes.slice(0, 7));
              else controller.error(new TypeError("simulated LAN interruption"));
            },
          });
          return new Response(stream, {
            status: 206,
            headers: {
              "accept-ranges": "bytes",
              "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
              "content-type": "application/ply",
              "content-length": String(bytes.byteLength),
              etag: `"${digest}"`,
              [XR_ASSET_HTTP_DIGEST_HEADER]: digest,
              [XR_ASSET_HTTP_FORMAT_HEADER]: "gaussian-ply",
              [XR_ASSET_HTTP_LENGTH_HEADER]: String(bytes.byteLength),
            },
          });
        }
        expect(request.headers.get("range")).toBe(`bytes=7-${bytes.byteLength - 1}`);
        return rangedAssetResponse(request, bytes, digest, "gaussian-ply", "application/ply");
      },
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      onAssetDownloadProgress: progress,
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });

    const blob = await session.openAsset(digest, "gaussian-ply", bytes.byteLength);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(assetAttempts).toBe(2);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      receivedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
      resumeCount: 1,
    }));
    expect(Math.max(...progress.mock.calls.map(([event]) => event.peakResponseChunkBytes as number)))
      .toBeLessThanOrEqual(bytes.byteLength - 7);
    for (const request of assetRequests) {
      expect(request.url).not.toContain(VIEWER_BEARER);
      expect(Number(request.headers.get("range")?.split("-")[1]) + 1).toBeLessThanOrEqual(bytes.byteLength);
    }
    await session.close();
  });

  it("uses a byte-progress idle deadline instead of the fixed control request timeout", async () => {
    const timers = new ManualTimers();
    const bytes = new TextEncoder().encode("asset-timeout");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [xrAssetHttpPath(digest)]: (request) => abortPendingResponse(request),
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      requestTimeoutMs: 90_000,
      assetProgressTimeoutMs: 5,
      assetMaximumRetries: 0,
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });

    const pending = session.openAsset(digest, "gaussian-ply", bytes.byteLength);
    await settle();
    expect(timers.pendingDelays()).toContain(5);
    expect(timers.runNext(5)).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(timers.pendingDelays()).not.toContain(5);
    await session.close();
  });

  it("resumes after a stalled range even when the abandoned reader cancel never settles", async () => {
    const timers = new ManualTimers();
    const bytes = new TextEncoder().encode("asset-stalled-cancel-recovery");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    let assetAttempts = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [xrAssetHttpPath(digest)]: (request) => {
        assetAttempts += 1;
        if (assetAttempts > 1) {
          return rangedAssetResponse(request, bytes, digest, "gaussian-ply", "application/ply");
        }
        const stream = new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: () => new Promise<void>(() => undefined),
        });
        return new Response(stream, {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
            "content-type": "application/ply",
            "content-length": String(bytes.byteLength),
            etag: `"${digest}"`,
            [XR_ASSET_HTTP_DIGEST_HEADER]: digest,
            [XR_ASSET_HTTP_FORMAT_HEADER]: "gaussian-ply",
            [XR_ASSET_HTTP_LENGTH_HEADER]: String(bytes.byteLength),
          },
        });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch,
      timers,
      assetProgressTimeoutMs: 5,
      assetMaximumRetries: 1,
    }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });

    const pending = session.openAsset(digest, "gaussian-ply", bytes.byteLength);
    await settle();
    expect(timers.runNext(5)).toBe(true);
    await expect(pending).resolves.toBeInstanceOf(Blob);
    expect(assetAttempts).toBe(2);

    await session.close();
  });

  it("rejects asset metadata or bytes that do not match the immutable descriptor", async () => {
    const timers = new ManualTimers();
    const bytes = new TextEncoder().encode("bad-asset");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.rendererConnect]: () => jsonSuccess(viewerConnection()),
      [XR_HTTP_PATHS.rendererReconnect]: (_request, body) => (
        jsonSuccess(fullSnapshotPlan(body!.cursor as XrReconnectCursor))
      ),
      [xrAssetHttpPath(digest)]: (request) => rangedAssetResponse(
        request,
        bytes,
        digest,
        "gaussian-spz-v4",
        "application/ply",
      ),
      [XR_HTTP_PATHS.sessionDisconnect]: () => jsonSuccess({ disconnected: true }),
    });
    const session = await new XrViewerHttpTransport({ baseUrl: TEST_ORIGIN, fetch, timers }).pair({
      pairingToken: PAIRING_TOKEN,
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
    });
    await expect(session.openAsset(digest, "gaussian-ply", bytes.byteLength)).rejects.toMatchObject({
      code: "invalid_response",
    });
    await session.close();
  });
});
