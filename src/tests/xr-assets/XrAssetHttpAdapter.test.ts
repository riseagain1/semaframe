// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  XrAssetRelayCache,
  XrRelay,
  createXrHttpHandler,
} from "../../../server/xr";
import {
  XR_ASSET_HTTP_COLLECTION_PATH,
  XR_ASSET_HTTP_DIGEST_HEADER,
  XR_ASSET_HTTP_FORMAT_HEADER,
  XR_ASSET_HTTP_LENGTH_HEADER,
  XR_ASSET_HTTP_TTL_HEADER,
  xrAssetHttpPath,
  type XrAssetDigest,
} from "../../xr/assets";
import {
  XR_HTTP_PATHS,
  XR_HTTP_SESSION_HEADER,
} from "../../xr/network/paths";

const API_ORIGIN = "https://host.semaframe.test";
const XR_ORIGIN = "https://xr.semaframe.test";

function glb(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x67, 0x6c, 0x54, 0x46]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, size, true);
  bytes.fill(7, 12);
  return bytes;
}

function digest(bytes: Uint8Array): XrAssetDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function post(handle: (request: Request) => Promise<Response>, path: string, body: unknown, headers: HeadersInit = {}) {
  return handle(new Request(`${API_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(body),
  }));
}

async function success<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json() as { ok: true; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

describe("XR authenticated asset HTTP relay", () => {
  it("streams a host-verified asset only to a paired renderer in the same authority epoch", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, {
      trustedLocalAuthority: (request) => request.headers.get("x-local-authority") === "trusted",
      rendererOrigins: [XR_ORIGIN],
      assetCache: new XrAssetRelayCache({
        maximumAssetBytes: 128,
        maximumAggregateBytes: 256,
        maximumTtlMs: 10_000,
      }),
    });
    const authority = await success<{
      sessionId: string;
      sessionBearer: string;
      authorityEpoch: string;
      workspaceId: string;
    }>(await post(handle, XR_HTTP_PATHS.authorityConnect, { workspaceId: "workspace-assets" }, {
      "x-local-authority": "trusted",
    }));
    const authorityHeaders = {
      authorization: `Bearer ${authority.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: authority.sessionId,
    };
    const pairing = await success<{ pairingToken: string }>(await post(
      handle,
      XR_HTTP_PATHS.authorityPairings,
      {},
      authorityHeaders,
    ));
    const renderer = await success<{
      sessionId: string;
      sessionBearer: string;
    }>(await post(handle, XR_HTTP_PATHS.rendererConnect, { pairingToken: pairing.pairingToken }, {
      origin: XR_ORIGIN,
    }));
    const rendererHeaders = {
      authorization: `Bearer ${renderer.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: renderer.sessionId,
      origin: XR_ORIGIN,
    };

    const bytes = glb(32);
    const assetDigest = digest(bytes);
    const stored = await handle(new Request(`${API_ORIGIN}${XR_ASSET_HTTP_COLLECTION_PATH}`, {
      method: "PUT",
      headers: {
        ...authorityHeaders,
        "content-type": "model/gltf-binary",
        "x-local-authority": "trusted",
        [XR_ASSET_HTTP_DIGEST_HEADER]: assetDigest,
        [XR_ASSET_HTTP_FORMAT_HEADER]: "mesh-glb",
        [XR_ASSET_HTTP_LENGTH_HEADER]: String(bytes.byteLength),
        [XR_ASSET_HTTP_TTL_HEADER]: "1000",
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    }));
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      ok: true,
      data: { descriptor: { digest: assetDigest, format: "mesh-glb", byteLength: 32 } },
    });

    const untrustedAuthorityHead = await handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(assetDigest)}`, {
      method: "HEAD",
      headers: authorityHeaders,
    }));
    expect(untrustedAuthorityHead.status).toBe(401);

    const authorityHead = await handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(assetDigest)}`, {
      method: "HEAD",
      headers: { ...authorityHeaders, "x-local-authority": "trusted" },
    }));
    expect(authorityHead.status).toBe(200);
    expect(authorityHead.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(authorityHead.headers.get(XR_ASSET_HTTP_DIGEST_HEADER)).toBe(assetDigest);
    expect(authorityHead.headers.get(XR_ASSET_HTTP_FORMAT_HEADER)).toBe("mesh-glb");
    expect(authorityHead.headers.get("etag")).toBe(`"${assetDigest}"`);

    const downloaded = await handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(assetDigest)}`, {
      headers: rendererHeaders,
    }));
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get(XR_ASSET_HTTP_DIGEST_HEADER)).toBe(assetDigest);
    expect(downloaded.headers.get(XR_ASSET_HTTP_FORMAT_HEADER)).toBe("mesh-glb");
    expect(downloaded.headers.get("content-type")).toBe("model/gltf-binary");
    expect(downloaded.headers.get("access-control-allow-origin")).toBe(XR_ORIGIN);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

    const ranged = await handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(assetDigest)}`, {
      headers: { ...rendererHeaders, range: "bytes=4-11" },
    }));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 4-11/32");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(4, 12));

    const authorityRead = await handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(assetDigest)}`, {
      headers: { ...authorityHeaders, origin: XR_ORIGIN },
    }));
    expect(authorityRead.status).toBe(403);

    await post(handle, XR_HTTP_PATHS.sessionDisconnect, {}, authorityHeaders);
    const expiredRendererRead = await handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(assetDigest)}`, {
      headers: rendererHeaders,
    }));
    expect(expiredRendererRead.status).toBe(401);
  });

  it("reports LRU eviction to the scoped authority so the host can re-upload before sync", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, {
      trustedLocalAuthority: (request) => request.headers.get("x-local-authority") === "trusted",
      rendererOrigins: [XR_ORIGIN],
      assetCache: new XrAssetRelayCache({
        maximumAssetBytes: 24,
        maximumAggregateBytes: 24,
        maximumTtlMs: 10_000,
      }),
    });
    const authority = await success<{
      sessionId: string;
      sessionBearer: string;
    }>(await post(handle, XR_HTTP_PATHS.authorityConnect, { workspaceId: "workspace-eviction" }, {
      "x-local-authority": "trusted",
    }));
    const authorityHeaders = {
      authorization: `Bearer ${authority.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: authority.sessionId,
      "x-local-authority": "trusted",
    };
    const first = glb(20);
    const second = glb(21);
    const upload = (bytes: Uint8Array) => handle(new Request(`${API_ORIGIN}${XR_ASSET_HTTP_COLLECTION_PATH}`, {
      method: "PUT",
      headers: {
        ...authorityHeaders,
        "content-type": "model/gltf-binary",
        [XR_ASSET_HTTP_DIGEST_HEADER]: digest(bytes),
        [XR_ASSET_HTTP_FORMAT_HEADER]: "mesh-glb",
        [XR_ASSET_HTTP_LENGTH_HEADER]: String(bytes.byteLength),
        [XR_ASSET_HTTP_TTL_HEADER]: "1000",
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    }));
    const head = (bytes: Uint8Array) => handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(digest(bytes))}`, {
      method: "HEAD",
      headers: authorityHeaders,
    }));

    expect((await upload(first)).status).toBe(200);
    expect((await head(first)).status).toBe(200);
    expect((await upload(second)).status).toBe(200);
    expect((await head(first)).status).toBe(404);
    expect((await head(second)).status).toBe(200);
  });

  it("reconciles expired cache entries out of the sidecar scope registry", async () => {
    let now = 1_000;
    const cache = new XrAssetRelayCache({
      maximumAssetBytes: 64,
      maximumAggregateBytes: 128,
      maximumTtlMs: 1_000,
      now: () => now,
    });
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, {
      trustedLocalAuthority: (request) => request.headers.get("x-local-authority") === "trusted",
      rendererOrigins: [XR_ORIGIN],
      assetCache: cache,
    });
    const authority = await success<{
      sessionId: string;
      sessionBearer: string;
    }>(await post(handle, XR_HTTP_PATHS.authorityConnect, { workspaceId: "workspace-expiry" }, {
      "x-local-authority": "trusted",
    }));
    const authorityHeaders = {
      authorization: `Bearer ${authority.sessionBearer}`,
      [XR_HTTP_SESSION_HEADER]: authority.sessionId,
      "x-local-authority": "trusted",
    };
    const bytes = glb(20);
    const assetDigest = digest(bytes);
    const uploadRequest = {
      version: 1 as const,
      digest: assetDigest,
      format: "mesh-glb" as const,
      byteLength: bytes.byteLength,
      ttlMs: 100,
    };
    const uploaded = await handle(new Request(`${API_ORIGIN}${XR_ASSET_HTTP_COLLECTION_PATH}`, {
      method: "PUT",
      headers: {
        ...authorityHeaders,
        "content-type": "model/gltf-binary",
        [XR_ASSET_HTTP_DIGEST_HEADER]: assetDigest,
        [XR_ASSET_HTTP_FORMAT_HEADER]: "mesh-glb",
        [XR_ASSET_HTTP_LENGTH_HEADER]: String(bytes.byteLength),
        [XR_ASSET_HTTP_TTL_HEADER]: "100",
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    }));
    expect(uploaded.status).toBe(200);

    now = 1_101;
    // Reconcile via a different asset route so the expired digest is not
    // opportunistically removed only because it was directly requested.
    const housekeeping = await handle(new Request(
      `${API_ORIGIN}${xrAssetHttpPath(`sha256:${"0".repeat(64)}`)}?invalid=1`,
    ));
    expect(housekeeping.status).toBe(404);
    await cache.put(uploadRequest, bytes);
    const staleScopeProbe = await handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(assetDigest)}`, {
      method: "HEAD",
      headers: authorityHeaders,
    }));
    // The direct cache reinsert has no authorization scope. A stale sidecar
    // entry would incorrectly turn this into 200.
    expect(staleScopeProbe.status).toBe(404);
  });

  it("rejects untrusted uploads, invalid content, query aliases, and unsafe CORS methods", async () => {
    const relay = new XrRelay();
    const handle = createXrHttpHandler(relay, {
      trustedLocalAuthority: (request) => request.headers.get("x-local-authority") === "trusted",
      rendererOrigins: [XR_ORIGIN],
    });
    const bytes = glb(20);
    const rejected = await handle(new Request(`${API_ORIGIN}${XR_ASSET_HTTP_COLLECTION_PATH}`, {
      method: "PUT",
      headers: {
        [XR_ASSET_HTTP_DIGEST_HEADER]: digest(bytes),
        [XR_ASSET_HTTP_FORMAT_HEADER]: "mesh-glb",
        [XR_ASSET_HTTP_LENGTH_HEADER]: String(bytes.byteLength),
        [XR_ASSET_HTTP_TTL_HEADER]: "1000",
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    }));
    expect(rejected.status).toBe(401);

    const queryAlias = await handle(new Request(
      `${API_ORIGIN}${xrAssetHttpPath(digest(bytes))}?token=forbidden`,
    ));
    expect(queryAlias.status).toBe(404);

    const preflight = await handle(new Request(`${API_ORIGIN}${xrAssetHttpPath(digest(bytes))}`, {
      method: "OPTIONS",
      headers: {
        origin: XR_ORIGIN,
        "access-control-request-method": "PUT",
      },
    }));
    expect(preflight.status).toBe(403);
  });
});
