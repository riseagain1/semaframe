// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  XR_ASSET_HTTP_COLLECTION_PATH,
  XR_ASSET_HTTP_DIGEST_HEADER,
  XR_ASSET_HTTP_FORMAT_HEADER,
  XR_ASSET_HTTP_LENGTH_HEADER,
  XR_ASSET_HTTP_TTL_HEADER,
  xrAssetHttpPath,
} from "../../xr/assets";
import {
  XR_HTTP_PATHS,
  XR_HTTP_SESSION_HEADER,
  XrAuthorityHttpTransport,
  XrNetworkError,
} from "../../xr/network";
import {
  AUTHORITY_BEARER,
  AUTHORITY_EPOCH,
  AUTHORITY_SESSION,
  ManualTimers,
  PAIRING_TOKEN,
  TEST_ORIGIN,
  WORKSPACE_ID,
  ack,
  authorityConnection,
  input,
  jsonFailure,
  jsonSuccess,
  requestOf,
  routedFetch,
  settle,
  snapshot,
} from "./fixtures";

describe("XrAuthorityHttpTransport", () => {
  it("runs authority lifecycle while keeping the bearer in headers only", async () => {
    const requests: Request[] = [];
    const sentSnapshot = { ...snapshot(AUTHORITY_SESSION), requestId: "authority-send-0001" };
    const assetBytes = new TextEncoder().encode("asset-upload-bytes");
    const assetDigest = `sha256:${createHash("sha256").update(assetBytes).digest("hex")}` as const;
    const assetPath = xrAssetHttpPath(assetDigest);
    const fetch = routedFetch({
      [XR_HTTP_PATHS.authorityConnect]: (_request, body) => {
        expect(body).toEqual({ workspaceId: WORKSPACE_ID, requestId: expect.any(String) });
        return jsonSuccess(authorityConnection());
      },
      [XR_HTTP_PATHS.sessionSend]: (request, body) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${AUTHORITY_BEARER}`);
        expect(request.headers.get(XR_HTTP_SESSION_HEADER)).toBe(AUTHORITY_SESSION);
        expect(body).toEqual({ message: sentSnapshot });
        expect(JSON.stringify(body)).not.toContain(AUTHORITY_BEARER);
        return jsonSuccess({
          response: ack(AUTHORITY_SESSION, sentSnapshot.revision, sentSnapshot.requestId),
        });
      },
      [XR_HTTP_PATHS.sessionPoll]: (request, body) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${AUTHORITY_BEARER}`);
        expect(body).toEqual({ acknowledgedDeliveryIds: [] });
        return jsonSuccess({
          mode: "immediate",
          deliveries: [{
            deliveryId: "delivery-authority-0001",
            message: input(AUTHORITY_SESSION),
            sourceSessionId: "renderer-source-session-0001",
            serverReceivedAtMs: 1_250,
            serverQueueAgeMs: 40,
          }],
        });
      },
      [XR_HTTP_PATHS.authorityPairings]: (request, body) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${AUTHORITY_BEARER}`);
        expect(body).toEqual({ ttlMs: 30_000 });
        return jsonSuccess({
          pairingId: "pairing-id-0001",
          pairingToken: PAIRING_TOKEN,
          pairingCode: "012345",
          workspaceId: WORKSPACE_ID,
          authorityEpoch: AUTHORITY_EPOCH,
          expiresAtMs: 31_000,
        });
      },
      [XR_HTTP_PATHS.authorityPairingsRevoke]: (_request, body) => {
        expect(body).toEqual({ pairingId: "pairing-id-0001" });
        return jsonSuccess({ revoked: true });
      },
      [XR_ASSET_HTTP_COLLECTION_PATH]: async (request, body) => {
        expect(request.method).toBe("PUT");
        expect(body).toBeUndefined();
        expect(request.headers.get("authorization")).toBe(`Bearer ${AUTHORITY_BEARER}`);
        expect(request.headers.get(XR_HTTP_SESSION_HEADER)).toBe(AUTHORITY_SESSION);
        expect(request.headers.get(XR_ASSET_HTTP_DIGEST_HEADER)).toBe(assetDigest);
        expect(request.headers.get(XR_ASSET_HTTP_FORMAT_HEADER)).toBe("mesh-glb");
        expect(request.headers.get(XR_ASSET_HTTP_LENGTH_HEADER)).toBe(String(assetBytes.byteLength));
        expect(request.headers.get(XR_ASSET_HTTP_TTL_HEADER)).toBe("60000");
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(assetBytes);
        return jsonSuccess({
          descriptor: {
            version: 1,
            digest: assetDigest,
            representation: "mesh",
            format: "mesh-glb",
            mediaType: "model/gltf-binary",
            byteLength: assetBytes.byteLength,
          },
          createdAtMs: 2_000,
          expiresAtMs: 62_000,
          deduplicated: false,
          evictedDigests: [],
        });
      },
      [assetPath]: (request, body) => {
        expect(request.method).toBe("HEAD");
        expect(body).toBeUndefined();
        expect(request.headers.get("authorization")).toBe(`Bearer ${AUTHORITY_BEARER}`);
        expect(request.headers.get(XR_HTTP_SESSION_HEADER)).toBe(AUTHORITY_SESSION);
        expect(request.headers.get("accept")).toBe("model/gltf-binary");
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "model/gltf-binary",
            "content-length": String(assetBytes.byteLength),
            etag: `"${assetDigest}"`,
            [XR_ASSET_HTTP_DIGEST_HEADER]: assetDigest,
            [XR_ASSET_HTTP_FORMAT_HEADER]: "mesh-glb",
            [XR_ASSET_HTTP_LENGTH_HEADER]: String(assetBytes.byteLength),
          },
        });
      },
      [XR_HTTP_PATHS.sessionDisconnect]: (_request, body) => {
        expect(body).toEqual({});
        return jsonSuccess({ disconnected: true });
      },
    }, requests);
    const transport = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });

    const connection = await transport.connect(WORKSPACE_ID);
    expect(connection).toEqual({
      sessionId: AUTHORITY_SESSION,
      authorityEpoch: AUTHORITY_EPOCH,
      workspaceId: WORKSPACE_ID,
    });
    expect(connection).not.toHaveProperty("sessionBearer");
    expect(JSON.stringify(transport)).not.toContain(AUTHORITY_BEARER);

    await expect(transport.send(sentSnapshot)).resolves.toMatchObject({
      messageType: "ack",
      status: "accepted",
    });
    await expect(transport.poll()).resolves.toEqual([{
      deliveryId: "delivery-authority-0001",
      message: input(AUTHORITY_SESSION),
      sourceSessionId: "renderer-source-session-0001",
      serverReceivedAtMs: 1_250,
      serverQueueAgeMs: 40,
    }]);
    const pairing = await transport.createPairing(30_000);
    expect(pairing.pairingToken).toBe(PAIRING_TOKEN);
    expect(pairing.pairingCode).toBe("012345");
    expect(JSON.stringify(transport)).not.toContain(PAIRING_TOKEN);
    await expect(transport.revokePairing(pairing.pairingId)).resolves.toBe(true);
    const put = await transport.putAsset(
      new Blob([assetBytes], { type: "application/octet-stream" }),
      assetDigest,
      "mesh-glb",
      60_000,
    );
    expect(put.descriptor).toMatchObject({
      digest: assetDigest,
      format: "mesh-glb",
      byteLength: assetBytes.byteLength,
    });
    await expect(transport.hasAsset(assetDigest, "mesh-glb", assetBytes.byteLength)).resolves.toBe(true);
    await expect(transport.disconnect()).resolves.toBeUndefined();
    await expect(transport.poll()).rejects.toMatchObject({ code: "not_connected" });

    for (const request of requests) {
      expect(new URL(request.url).search).toBe("");
      expect(request.url).not.toContain(AUTHORITY_BEARER);
      expect(request.url).not.toContain(PAIRING_TOKEN);
    }
  });

  it("treats only a scoped 404 as absent and rejects forged residency metadata", async () => {
    const assetBytes = new TextEncoder().encode("authority-head-asset");
    const assetDigest = `sha256:${createHash("sha256").update(assetBytes).digest("hex")}` as const;
    const assetPath = xrAssetHttpPath(assetDigest);
    let mode: "missing" | "forged" = "missing";
    const requests: Request[] = [];
    const fetch = routedFetch({
      [XR_HTTP_PATHS.authorityConnect]: () => jsonSuccess(authorityConnection()),
      [assetPath]: () => mode === "missing"
        ? jsonFailure(404, "asset_not_found")
        : new Response(null, {
            status: 200,
            headers: {
              "content-type": "model/gltf-binary",
              "content-length": String(assetBytes.byteLength),
              etag: `"${assetDigest}"`,
              [XR_ASSET_HTTP_DIGEST_HEADER]: assetDigest,
              [XR_ASSET_HTTP_FORMAT_HEADER]: "gaussian-ply",
              [XR_ASSET_HTTP_LENGTH_HEADER]: String(assetBytes.byteLength),
            },
          }),
    }, requests);
    const transport = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });
    await transport.connect(WORKSPACE_ID);

    await expect(transport.hasAsset(assetDigest, "mesh-glb", assetBytes.byteLength)).resolves.toBe(false);
    mode = "forged";
    await expect(transport.hasAsset(assetDigest, "mesh-glb", assetBytes.byteLength)).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
    for (const request of requests.filter((candidate) => candidate.method === "HEAD")) {
      expect(new URL(request.url).search).toBe("");
      expect(request.url).not.toContain(AUTHORITY_BEARER);
    }
  });

  it("replays the exact authority envelope once when its committed HTTP acknowledgement is lost", async () => {
    const bodies: unknown[] = [];
    let attempts = 0;
    const message = { ...snapshot(AUTHORITY_SESSION), requestId: "authority-lost-http-ack-0001" };
    const fetch = routedFetch({
      [XR_HTTP_PATHS.authorityConnect]: () => jsonSuccess(authorityConnection()),
      [XR_HTTP_PATHS.sessionSend]: (_request, body) => {
        attempts += 1;
        bodies.push(body);
        if (attempts === 1) {
          throw new TypeError("simulated lost acknowledgement after relay commit");
        }
        return jsonSuccess({
          response: {
            ...ack(AUTHORITY_SESSION, message.revision, message.requestId),
            status: "duplicate",
          },
        });
      },
    });
    const transport = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });
    await transport.connect(WORKSPACE_ID);

    await expect(transport.send(message)).resolves.toMatchObject({
      messageType: "ack",
      status: "duplicate",
    });
    expect(attempts).toBe(2);
    expect(bodies).toEqual([{ message }, { message }]);
  });

  it("replays an exact idempotent pairing revocation after a lost acknowledgement", async () => {
    const bodies: unknown[] = [];
    let attempts = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.authorityConnect]: () => jsonSuccess(authorityConnection()),
      [XR_HTTP_PATHS.authorityPairingsRevoke]: (_request, body) => {
        attempts += 1;
        bodies.push(body);
        if (attempts === 1) throw new TypeError("simulated lost revoke acknowledgement");
        // A false retry result proves the exact pairing is already absent,
        // including when the first request committed before its ACK was lost.
        return jsonSuccess({ revoked: false });
      },
    });
    const transport = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });
    await transport.connect(WORKSPACE_ID);

    await expect(transport.revokePairing("pairing-id-lost-ack-0001")).resolves.toBe(false);
    expect(attempts).toBe(2);
    expect(bodies).toEqual([
      { pairingId: "pairing-id-lost-ack-0001" },
      { pairingId: "pairing-id-lost-ack-0001" },
    ]);
  });

  it("rejects unknown response fields and mismatched local messages before sending", async () => {
    let calls = 0;
    const fetch = routedFetch({
      [XR_HTTP_PATHS.authorityConnect]: () => {
        calls += 1;
        return jsonSuccess(authorityConnection({ unexpected: true }));
      },
    });
    const malformed = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch });
    await expect(malformed.connect(WORKSPACE_ID)).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
    // A malformed 2xx connection body is ambiguous: the relay may already
    // have committed it, so replay the exact request once before failing.
    expect(calls).toBe(2);

    const sendFetch = vi.fn(async () => jsonSuccess(authorityConnection()));
    const transport = new XrAuthorityHttpTransport({ baseUrl: TEST_ORIGIN, fetch: sendFetch });
    await transport.connect(WORKSPACE_ID);
    const fetchCount = sendFetch.mock.calls.length;
    await expect(transport.send(snapshot("another-session-0001"))).rejects.toMatchObject({
      code: "session_mismatch",
    });
    expect(sendFetch).toHaveBeenCalledTimes(fetchCount);
  });

  it("redacts server errors and cleans up timeout and abort timers", async () => {
    const timers = new ManualTimers();
    const never = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestOf(_input, init);
      return new Promise<Response>(() => undefined);
    });
    const timed = new XrAuthorityHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch: never,
      timers,
      requestTimeoutMs: 5,
    });
    const pending = timed.connect(WORKSPACE_ID);
    expect(timers.pendingDelays()).toEqual([5]);
    expect(timers.runNext(5)).toBe(true);
    await settle();
    expect(timers.pendingDelays()).toEqual([5]);
    expect(timers.runNext(5)).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(never).toHaveBeenCalledTimes(2);
    expect(timers.pendingDelays()).toEqual([]);

    const secret = "server-should-not-reflect-this-secret";
    const denied = new XrAuthorityHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch: async () => jsonFailure(401, "unauthorized", secret),
    });
    const deniedError = await denied.connect(WORKSPACE_ID).catch((error: unknown) => error);
    expect(deniedError).toBeInstanceOf(XrNetworkError);
    expect((deniedError as Error).message).toBe("XR authentication failed.");
    expect((deniedError as Error).message).not.toContain(secret);

    const abortTimers = new ManualTimers();
    const controller = new AbortController();
    const aborted = new XrAuthorityHttpTransport({
      baseUrl: TEST_ORIGIN,
      fetch: never,
      timers: abortTimers,
      requestTimeoutMs: 50,
    }).connect(WORKSPACE_ID);
    await settle();
    // The transport API has no per-call authority signal; abort safety is
    // exercised on the viewer surface where requests are caller-cancellable.
    controller.abort();
    expect(abortTimers.pendingDelays()).toEqual([50]);
    expect(abortTimers.runNext(50)).toBe(true);
    await settle();
    expect(abortTimers.pendingDelays()).toEqual([50]);
    expect(abortTimers.runNext(50)).toBe(true);
    await expect(aborted).rejects.toMatchObject({ code: "timeout" });
  });

  it("accepts only a canonical HTTP(S) origin", () => {
    expect(() => new XrAuthorityHttpTransport({
      baseUrl: `${TEST_ORIGIN}/api`,
      fetch: async () => jsonSuccess({}),
    })).toThrow(/canonical HTTP\(S\) origin/u);
    expect(() => new XrAuthorityHttpTransport({
      baseUrl: `https://user:secret@xr-host.semaframe.test`,
      fetch: async () => jsonSuccess({}),
    })).toThrow(/canonical HTTP\(S\) origin/u);
  });
});
