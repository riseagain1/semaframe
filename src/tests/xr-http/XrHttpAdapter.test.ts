// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  XR_HTTP_PATHS,
  XR_HTTP_POLL_MODE,
  XR_HTTP_SESSION_HEADER,
  XrRelay,
  createXrHttpHandler,
  type WindowsUltraEvidenceProvider,
  type XrHttpAdapterOptions,
  type XrHttpHandler,
  type XrRelayConnection,
  type XrRelayOptions,
} from "../../../server/xr";
import {
  XR_PROTOCOL_LIMITS,
  XR_RELAY_PROTOCOL_VERSION,
  type XrInputMessage,
  type XrSnapshotMessage,
} from "../../xr/protocol";
import { ULTRA_POLICY_VERSION } from "../../xr/ultra";

const API_ORIGIN = "https://host.semaframe.test";
const RENDERER_ORIGIN = "https://xr.semaframe.test";
const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const REGISTRY_DIGEST = `sha256:${"b".repeat(64)}` as const;

type SuccessBody<T> = Readonly<{ ok: true; data: T }>;
type ErrorBody = Readonly<{
  ok: false;
  error: Readonly<{ code: string; message: string }>;
}>;

function request(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  init: Omit<RequestInit, "method" | "headers" | "body"> = {},
): Request {
  return new Request(`${API_ORIGIN}${path}`, {
    ...init,
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function success<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json() as SuccessBody<T>;
  expect(body.ok).toBe(true);
  return body.data;
}

async function failure(response: Response, status: number, code: string): Promise<ErrorBody> {
  expect(response.status).toBe(status);
  const body = await response.json() as ErrorBody;
  expect(body).toEqual({
    ok: false,
    error: {
      code,
      message: expect.any(String),
    },
  });
  return body;
}

function bearerHeaders(
  connection: XrRelayConnection,
  includeSessionHeader = true,
): Record<string, string> {
  return {
    authorization: `Bearer ${connection.sessionBearer}`,
    ...(includeSessionHeader ? { [XR_HTTP_SESSION_HEADER]: connection.sessionId } : {}),
  };
}

function rig(
  trustedLocalAuthority: (request: Request) => boolean | Promise<boolean> = (localRequest) => (
    localRequest.headers.get("x-local-authority") === "trusted"
  ),
  options: Omit<XrHttpAdapterOptions, "trustedLocalAuthority" | "rendererOrigins"> = {},
  relayOptions: XrRelayOptions = {},
): { relay: XrRelay; handle: XrHttpHandler } {
  const relay = new XrRelay(relayOptions);
  return {
    relay,
    handle: createXrHttpHandler(relay, {
      trustedLocalAuthority,
      rendererOrigins: [RENDERER_ORIGIN],
      ...options,
    }),
  };
}

async function connectAuthority(handle: XrHttpHandler): Promise<XrRelayConnection> {
  return success<XrRelayConnection>(await handle(request(
    XR_HTTP_PATHS.authorityConnect,
    { workspaceId: "workspace-http" },
    { "x-local-authority": "trusted" },
  )));
}

function snapshot(authority: XrRelayConnection, revision = 0): XrSnapshotMessage {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "snapshot",
    sessionId: authority.sessionId,
    authorityEpoch: authority.authorityEpoch,
    workspaceId: authority.workspaceId,
    revision,
    requestId: `http-snapshot-${revision.toString().padStart(4, "0")}`,
    registryDigest: REGISTRY_DIGEST,
    snapshotDigest: DIGEST_A,
    snapshot: { revision, components: [{ id: "CMP_HTTP" }] },
  };
}

describe("XR Fetch HTTP adapter", () => {
  it("requires trusted local authority bootstrap and applies security headers", async () => {
    const trustedLocalAuthority = vi.fn((localRequest: Request) => (
      localRequest.headers.get("x-local-authority") === "trusted"
    ));
    const { relay, handle } = rig(trustedLocalAuthority);

    const rejected = await handle(new Request(`${API_ORIGIN}${XR_HTTP_PATHS.authorityConnect}`, {
      method: "POST",
      body: "not authenticated JSON",
    }));
    await failure(rejected, 401, "unauthorized");
    expect(relay.authority).toBeUndefined();

    const authorityResponse = await handle(request(
      XR_HTTP_PATHS.authorityConnect,
      { workspaceId: "workspace-http" },
      { "x-local-authority": "trusted" },
    ));
    const authority = await success<XrRelayConnection>(authorityResponse);
    expect(Buffer.from(authority.sessionBearer, "base64url")).toHaveLength(32);
    expect(relay.authority).not.toHaveProperty("sessionBearer");
    expect(authorityResponse.headers.get("cache-control")).toBe("no-store");
    expect(authorityResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(authorityResponse.headers.get("permissions-policy")).toContain("microphone=()");
    expect(authorityResponse.headers.get("x-content-type-options")).toBe("nosniff");

    await failure(await handle(request(
      XR_HTTP_PATHS.authorityConnect,
      { workspaceId: "workspace-http" },
      { "x-local-authority": "trusted" },
    )), 409, "conflict");

    const wrongMethod = await handle(new Request(`${API_ORIGIN}${XR_HTTP_PATHS.sessionPoll}`));
    await failure(wrongMethod, 405, "method_not_allowed");
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    await failure(await handle(request(
      `${XR_HTTP_PATHS.sessionPoll}?sessionId=${authority.sessionId}`,
      {},
      bearerHeaders(authority),
    )), 404, "not_found");
    expect(trustedLocalAuthority).toHaveBeenCalledTimes(3);
  });

  it("runs pairing, one-time renderer connect, send, immediate poll, reconnect, and disconnect", async () => {
    const { handle } = rig();
    const authority = await connectAuthority(handle);
    const pairing = await success<{
      pairingId: string;
      pairingToken: string;
      expiresAtMs: number;
    }>(await handle(request(
      XR_HTTP_PATHS.authorityPairings,
      { sessionId: authority.sessionId, ttlMs: 30_000 },
      bearerHeaders(authority, false),
    )));
    expect(Buffer.from(pairing.pairingToken, "base64url")).toHaveLength(32);

    const rendererResponse = await handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: pairing.pairingToken },
      { origin: RENDERER_ORIGIN },
    ));
    const renderer = await success<XrRelayConnection>(rendererResponse);
    expect(rendererResponse.headers.get("access-control-allow-origin")).toBe(RENDERER_ORIGIN);
    expect(renderer.role).toBe("xr_renderer");

    const reused = await handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: pairing.pairingToken },
      { origin: RENDERER_ORIGIN },
    ));
    const reusedBody = await failure(reused, 401, "unauthorized");
    expect(JSON.stringify(reusedBody)).not.toContain(pairing.pairingToken);

    const committed = snapshot(authority, 4);
    const sendSnapshot = await success<{ response: { messageType: string; status: string } }>(await handle(request(
      XR_HTTP_PATHS.sessionSend,
      { sessionId: authority.sessionId, message: committed },
      bearerHeaders(authority, false),
    )));
    expect(sendSnapshot.response).toMatchObject({ messageType: "ack", status: "accepted" });

    const rendererPoll = await success<{
      mode: string;
      deliveries: readonly Readonly<{ deliveryId: string; message: XrSnapshotMessage }>[];
    }>(await handle(request(
      XR_HTTP_PATHS.sessionPoll,
      {},
      {
        ...bearerHeaders(renderer),
        origin: RENDERER_ORIGIN,
      },
    )));
    expect(rendererPoll).toMatchObject({
      mode: XR_HTTP_POLL_MODE,
      deliveries: [{
        deliveryId: expect.stringMatching(/^delivery-/u),
        message: { messageType: "snapshot", revision: 4 },
      }],
    });

    const rendererInput: XrInputMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "input",
      sessionId: renderer.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 4,
      requestId: "http-input-0001",
      inputType: "panel_action",
      payload: { actionId: "start", componentId: "CMP_HTTP" },
    };
    const sendInput = await success<{ response: { status: string } }>(await handle(request(
      XR_HTTP_PATHS.sessionSend,
      { sessionId: renderer.sessionId, message: rendererInput },
      {
        ...bearerHeaders(renderer, false),
        origin: RENDERER_ORIGIN,
      },
    )));
    expect(sendInput.response.status).toBe("accepted");

    const authorityPoll = await success<{
      deliveries: readonly Readonly<{
        deliveryId: string;
        message: XrInputMessage;
        sourceSessionId: string;
      }>[];
    }>(await handle(request(
      XR_HTTP_PATHS.sessionPoll,
      {},
      bearerHeaders(authority),
    )));
    expect(authorityPoll.deliveries).toMatchObject([{
      deliveryId: expect.stringMatching(/^delivery-/u),
      sourceSessionId: renderer.sessionId,
      message: { messageType: "input", inputType: "panel_action" },
    }]);

    const reconnect = await success<{ plan: { kind: string; revision: number } }>(await handle(request(
      XR_HTTP_PATHS.rendererReconnect,
      {
        sessionId: renderer.sessionId,
        cursor: {
          protocolVersion: XR_RELAY_PROTOCOL_VERSION,
          sessionId: renderer.sessionId,
          authorityEpoch: authority.authorityEpoch,
          workspaceId: renderer.workspaceId,
          revision: 4,
          snapshotDigest: DIGEST_A,
          requestId: "http-reconnect-0001",
        },
      },
      {
        ...bearerHeaders(renderer, false),
        origin: RENDERER_ORIGIN,
      },
    )));
    expect(reconnect.plan).toMatchObject({ kind: "current", revision: 4 });

    expect(await success(await handle(request(
      XR_HTTP_PATHS.sessionDisconnect,
      {},
      {
        ...bearerHeaders(renderer),
        origin: RENDERER_ORIGIN,
      },
    )))).toEqual({ disconnected: true });
    await failure(await handle(request(
      XR_HTTP_PATHS.sessionPoll,
      {},
      {
        ...bearerHeaders(renderer),
        origin: RENDERER_ORIGIN,
      },
    )), 401, "unauthorized");

    const revokedPairing = await success<{ pairingId: string; pairingToken: string }>(await handle(request(
      XR_HTTP_PATHS.authorityPairings,
      {},
      bearerHeaders(authority),
    )));
    const revokedRenderer = await success<XrRelayConnection>(await handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: revokedPairing.pairingToken },
      { origin: RENDERER_ORIGIN },
    )));
    expect(await success(await handle(request(
      XR_HTTP_PATHS.authorityPairingsRevoke,
      { pairingId: revokedPairing.pairingId },
      bearerHeaders(authority),
    )))).toEqual({ revoked: true });
    await failure(await handle(request(
      XR_HTTP_PATHS.sessionPoll,
      {},
      {
        ...bearerHeaders(revokedRenderer),
        origin: RENDERER_ORIGIN,
      },
    )), 401, "unauthorized");
  });

  it("exposes native Ultra evidence only to the paired renderer and fails closed when unavailable", async () => {
    const collectedAt = "2026-08-25T09:00:00.000Z";
    const collectStaticProbe = vi.fn<WindowsUltraEvidenceProvider["collectStaticProbe"]>(async (_scope, browser) => ({
      version: 1,
      policyVersion: ULTRA_POLICY_VERSION,
      platform: "windows",
      architecture: "x64",
      operatingSystemVersion: "10.0.26100",
      logicalProcessorCount: 24,
      systemMemoryBytes: 32 * 1024 * 1024 * 1024,
      graphics: {
        adapterFingerprint: `sha256:${"c".repeat(64)}`,
        driverVersion: "32.0.15.9000",
        hardwareAccelerated: true,
        supportedByRuntime: true,
      },
      runtime: { kind: "meta_horizon_link", version: "1.100.0", openXrActive: true },
      webXr: browser,
      collectedAt,
    }));
    const sampleRuntime = vi.fn<WindowsUltraEvidenceProvider["sampleRuntime"]>(async () => ({
      version: 1,
      transport: "link_cable",
      processRssBytes: 2 * 1024 * 1024 * 1024,
      gpuMemoryUsageRatio: 0.5,
      gpuMemoryHeadroomBytes: 6 * 1024 * 1024 * 1024,
      thermalThrottleObserved: false,
      runtimeConnected: true,
      sampledAt: collectedAt,
    }));
    const ultraEvidence: WindowsUltraEvidenceProvider = { collectStaticProbe, sampleRuntime };
    const { handle } = rig(undefined, { ultraEvidence });
    const authority = await connectAuthority(handle);
    const pairing = await success<{ pairingToken: string }>(await handle(request(
      XR_HTTP_PATHS.authorityPairings,
      {},
      bearerHeaders(authority),
    )));
    const renderer = await success<XrRelayConnection>(await handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: pairing.pairingToken },
      { origin: RENDERER_ORIGIN },
    )));
    const rendererHeaders = { ...bearerHeaders(renderer), origin: RENDERER_ORIGIN };
    const browser = {
      browserEngine: "chromium",
      secureContext: true,
      immersiveVrSupported: true,
    } as const;

    await expect(success(await handle(request(
      XR_HTTP_PATHS.rendererUltraProbe,
      { browser },
      rendererHeaders,
    )))).resolves.toMatchObject({
      probe: { platform: "windows", webXr: browser },
    });
    await failure(await handle(request(
      XR_HTTP_PATHS.rendererUltraProbe,
      { browser },
      rendererHeaders,
    )), 429, "ultra_rate_limited");
    await expect(success(await handle(request(
      XR_HTTP_PATHS.rendererUltraSample,
      {},
      rendererHeaders,
    )))).resolves.toMatchObject({
      sample: { version: 1, transport: "link_cable", runtimeConnected: true },
    });
    expect(collectStaticProbe).toHaveBeenCalledWith(
      { rendererSessionId: renderer.sessionId },
      browser,
      expect.any(AbortSignal),
    );
    expect(sampleRuntime).toHaveBeenCalledWith(
      { rendererSessionId: renderer.sessionId },
      expect.any(AbortSignal),
    );

    await failure(await handle(request(
      XR_HTTP_PATHS.rendererUltraSample,
      {},
      { ...bearerHeaders(authority), origin: RENDERER_ORIGIN },
    )), 403, "forbidden");
    await failure(await handle(request(
      XR_HTTP_PATHS.rendererUltraProbe,
      { browser },
      { ...rendererHeaders, origin: "https://attacker.example" },
    )), 403, "origin_forbidden");

    const unavailable = rig();
    const unavailableAuthority = await connectAuthority(unavailable.handle);
    const unavailablePairing = await success<{ pairingToken: string }>(await unavailable.handle(request(
      XR_HTTP_PATHS.authorityPairings,
      {},
      bearerHeaders(unavailableAuthority),
    )));
    const unavailableRenderer = await success<XrRelayConnection>(await unavailable.handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: unavailablePairing.pairingToken },
      { origin: RENDERER_ORIGIN },
    )));
    await failure(await unavailable.handle(request(
      XR_HTTP_PATHS.rendererUltraProbe,
      { browser },
      { ...bearerHeaders(unavailableRenderer), origin: RENDERER_ORIGIN },
    )), 503, "ultra_evidence_unavailable");
  });

  it("rate limits each renderer with bounded state while allowing the normal six-second sample cadence", async () => {
    const runtimeSample = {
      version: 1 as const,
      transport: "link_cable" as const,
      processRssBytes: 2 * 1024 * 1024 * 1024,
      gpuMemoryUsageRatio: 0.5,
      gpuMemoryHeadroomBytes: 6 * 1024 * 1024 * 1024,
      thermalThrottleObserved: false,
      runtimeConnected: true,
      sampledAt: "2026-08-25T09:00:00.000Z",
    };
    let releaseFirst!: () => void;
    const firstSample = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sampleRuntime = vi.fn<WindowsUltraEvidenceProvider["sampleRuntime"]>(async () => {
      if (sampleRuntime.mock.calls.length === 1) await firstSample;
      return runtimeSample;
    });
    const ultraEvidence: WindowsUltraEvidenceProvider = {
      collectStaticProbe: vi.fn(),
      sampleRuntime,
    };
    let now = 10_000;
    const { handle } = rig(undefined, {
      ultraEvidence,
      ultraRateLimit: {
        now: () => now,
        cooldownMs: 5_000,
        maximumTrackedSessions: 1,
      },
    });
    const authority = await connectAuthority(handle);
    const connectRenderer = async () => {
      const pairing = await success<{ pairingToken: string }>(await handle(request(
        XR_HTTP_PATHS.authorityPairings,
        {},
        bearerHeaders(authority),
      )));
      return success<XrRelayConnection>(await handle(request(
        XR_HTTP_PATHS.rendererConnect,
        { pairingToken: pairing.pairingToken },
        { origin: RENDERER_ORIGIN },
      )));
    };
    const firstRenderer = await connectRenderer();
    const secondRenderer = await connectRenderer();
    const headersFor = (renderer: XrRelayConnection) => ({
      ...bearerHeaders(renderer),
      origin: RENDERER_ORIGIN,
    });

    const first = handle(request(
      XR_HTTP_PATHS.rendererUltraSample,
      {},
      headersFor(firstRenderer),
    ));
    await vi.waitFor(() => expect(sampleRuntime).toHaveBeenCalledOnce());
    await failure(await handle(request(
      XR_HTTP_PATHS.rendererUltraSample,
      {},
      headersFor(firstRenderer),
    )), 429, "ultra_rate_limited");
    releaseFirst();
    await expect(success(await first)).resolves.toEqual({ sample: runtimeSample });

    now += 6_000;
    await expect(success(await handle(request(
      XR_HTTP_PATHS.rendererUltraSample,
      {},
      headersFor(firstRenderer),
    )))).resolves.toEqual({ sample: runtimeSample });
    await failure(await handle(request(
      XR_HTTP_PATHS.rendererUltraSample,
      {},
      headersFor(secondRenderer),
    )), 429, "ultra_rate_limited");

    await success(await handle(request(
      XR_HTTP_PATHS.sessionDisconnect,
      {},
      headersFor(firstRenderer),
    )));
    await expect(success(await handle(request(
      XR_HTTP_PATHS.rendererUltraSample,
      {},
      headersFor(secondRenderer),
    )))).resolves.toEqual({ sample: runtimeSample });
    expect(sampleRuntime).toHaveBeenCalledTimes(3);
  });

  it("pages a maximum poll queue by encoded response bytes without dropping unacknowledged deliveries", async () => {
    // Queue construction deliberately serializes enough data to exercise the
    // response byte ceiling. Keep lease time deterministic so a contended CI
    // runner cannot turn this pagination test into an idle-timeout test.
    const { relay, handle } = rig(undefined, {}, { now: () => 10_000 });
    const authority = await connectAuthority(handle);
    const authorityCredential = {
      sessionId: authority.sessionId,
      sessionBearer: authority.sessionBearer,
    };
    const pairing = relay.createPairing(authorityCredential);
    const renderer = relay.connectRenderer({ pairingToken: pairing.pairingToken });
    const rendererCredential = {
      sessionId: renderer.sessionId,
      sessionBearer: renderer.sessionBearer,
    };
    expect(relay.acceptMessage(authorityCredential, snapshot(authority, 0)))
      .toMatchObject({ status: "accepted" });
    relay.drainMessages(rendererCredential);

    const deliveryCount = 300;
    for (let index = 1; index <= deliveryCount; index += 1) {
      expect(relay.acceptMessage(authorityCredential, {
        protocolVersion: XR_RELAY_PROTOCOL_VERSION,
        messageType: "ephemeral",
        sessionId: authority.sessionId,
        authorityEpoch: authority.authorityEpoch,
        workspaceId: authority.workspaceId,
        revision: 0,
        requestId: `poll-budget-${index.toString().padStart(4, "0")}`,
        channel: "viewer.status",
        sequence: index,
        payload: { padding: "x".repeat(60_000) },
      })).toMatchObject({ status: "accepted" });
    }

    const firstResponse = await handle(request(
      XR_HTTP_PATHS.sessionPoll,
      {},
      { ...bearerHeaders(renderer), origin: RENDERER_ORIGIN },
    ));
    const firstBytes = (await firstResponse.clone().arrayBuffer()).byteLength;
    const first = await success<{
      deliveries: readonly Readonly<{ deliveryId: string }>[];
    }>(firstResponse);
    expect(firstBytes).toBeLessThanOrEqual(XR_PROTOCOL_LIMITS.maximumControlResponseBytes);
    expect(first.deliveries.length).toBeGreaterThan(0);
    expect(first.deliveries.length).toBeLessThan(deliveryCount);

    const secondResponse = await handle(request(
      XR_HTTP_PATHS.sessionPoll,
      { acknowledgedDeliveryIds: first.deliveries.map(({ deliveryId }) => deliveryId) },
      { ...bearerHeaders(renderer), origin: RENDERER_ORIGIN },
    ));
    const secondBytes = (await secondResponse.clone().arrayBuffer()).byteLength;
    const second = await success<{
      deliveries: readonly Readonly<{ deliveryId: string }>[];
    }>(secondResponse);
    expect(secondBytes).toBeLessThanOrEqual(XR_PROTOCOL_LIMITS.maximumControlResponseBytes);
    expect(second.deliveries.length).toBe(deliveryCount - first.deliveries.length);
    expect(new Set([
      ...first.deliveries.map(({ deliveryId }) => deliveryId),
      ...second.deliveries.map(({ deliveryId }) => deliveryId),
    ]).size).toBe(deliveryCount);
  }, 15_000);

  it("requires the bearer on every session route, prevents identity mixing, and role-checks authority routes", async () => {
    const { handle } = rig();
    const authority = await connectAuthority(handle);
    const pairing = await success<{ pairingToken: string }>(await handle(request(
      XR_HTTP_PATHS.authorityPairings,
      {},
      bearerHeaders(authority),
    )));
    const renderer = await success<XrRelayConnection>(await handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: pairing.pairingToken },
      { origin: RENDERER_ORIGIN },
    )));
    const badBearer = Buffer.alloc(32, 199).toString("base64url");
    const badHeaders = {
      authorization: `Bearer ${badBearer}`,
      [XR_HTTP_SESSION_HEADER]: renderer.sessionId,
      origin: RENDERER_ORIGIN,
    };
    const cursor = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      sessionId: renderer.sessionId,
      authorityEpoch: authority.authorityEpoch,
      workspaceId: renderer.workspaceId,
      revision: 0,
      snapshotDigest: DIGEST_A,
      requestId: "http-reconnect-auth",
    } as const;
    const protectedRequests = [
      request(XR_HTTP_PATHS.sessionSend, {
        message: {
          protocolVersion: XR_RELAY_PROTOCOL_VERSION,
          messageType: "input",
          sessionId: renderer.sessionId,
          authorityEpoch: authority.authorityEpoch,
          workspaceId: renderer.workspaceId,
          revision: 0,
          requestId: "http-protected-input",
          inputType: "select",
          payload: {},
        },
      }, badHeaders),
      request(XR_HTTP_PATHS.sessionPoll, {}, badHeaders),
      request(XR_HTTP_PATHS.rendererReconnect, { cursor }, badHeaders),
      request(XR_HTTP_PATHS.sessionDisconnect, {}, badHeaders),
    ];
    for (const protectedRequest of protectedRequests) {
      const response = await handle(protectedRequest);
      const body = await failure(response, 401, "unauthorized");
      expect(JSON.stringify(body)).not.toContain(badBearer);
    }

    await failure(await handle(request(
      XR_HTTP_PATHS.sessionPoll,
      { sessionId: authority.sessionId },
      bearerHeaders(renderer),
    )), 401, "unauthorized");
    await failure(await handle(request(
      XR_HTTP_PATHS.authorityPairings,
      {},
      bearerHeaders(renderer),
    )), 403, "forbidden");
    await failure(await handle(request(
      XR_HTTP_PATHS.sessionPoll,
      { sessionId: renderer.sessionId, unexpected: true },
      {
        ...bearerHeaders(renderer, false),
        origin: RENDERER_ORIGIN,
      },
    )), 400, "invalid_request");
  });

  it("enforces exact renderer CORS and rejects disallowed preflights before consuming pairing", async () => {
    const { handle } = rig();
    const authority = await connectAuthority(handle);
    const pairing = await success<{ pairingToken: string }>(await handle(request(
      XR_HTTP_PATHS.authorityPairings,
      {},
      bearerHeaders(authority),
    )));

    const preflight = await handle(new Request(`${API_ORIGIN}${XR_HTTP_PATHS.rendererConnect}`, {
      method: "OPTIONS",
      headers: {
        origin: RENDERER_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(RENDERER_ORIGIN);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
    expect(preflight.headers.get("vary")).toContain("Access-Control-Request-Headers");

    await failure(await handle(new Request(`${API_ORIGIN}${XR_HTTP_PATHS.rendererConnect}`, {
      method: "OPTIONS",
      headers: {
        origin: RENDERER_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-unreviewed-header",
      },
    })), 403, "origin_forbidden");

    const forbidden = await handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: pairing.pairingToken },
      { origin: "https://xr.semaframe.test.evil.example" },
    ));
    await failure(forbidden, 403, "origin_forbidden");
    expect(forbidden.headers.get("access-control-allow-origin")).toBeNull();

    const allowed = await handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: pairing.pairingToken },
      { origin: RENDERER_ORIGIN },
    ));
    expect(allowed.status).toBe(200);

    expect(() => createXrHttpHandler(new XrRelay(), {
      trustedLocalAuthority: () => true,
      rendererOrigins: [`${RENDERER_ORIGIN}/`],
    })).toThrow(/canonical HTTP/u);
  });

  it("rejects wrong media, oversized or malformed bodies, unknown fields, and aborted requests", async () => {
    const { relay, handle } = rig();
    await failure(await handle(new Request(`${API_ORIGIN}${XR_HTTP_PATHS.authorityConnect}`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-local-authority": "trusted",
      },
      body: "{}",
    })), 415, "unsupported_media_type");
    await failure(await handle(request(
      XR_HTTP_PATHS.authorityConnect,
      "{broken-json",
      { "x-local-authority": "trusted" },
    )), 400, "invalid_request");
    await failure(await handle(request(
      XR_HTTP_PATHS.authorityConnect,
      { workspaceId: "workspace-http", takeover: true },
      { "x-local-authority": "trusted" },
    )), 400, "invalid_request");
    expect(relay.authority).toBeUndefined();

    const tiny = rig(undefined, { controlBodyLimitBytes: 32, messageBodyLimitBytes: 64 });
    await failure(await tiny.handle(request(
      XR_HTTP_PATHS.rendererConnect,
      { pairingToken: "x".repeat(200) },
      { origin: RENDERER_ORIGIN },
    )), 413, "body_too_large");
    await failure(await tiny.handle(request(
      XR_HTTP_PATHS.sessionSend,
      { sessionId: "session-oversized", message: { payload: "x".repeat(200) } },
      { origin: RENDERER_ORIGIN },
    )), 413, "body_too_large");

    const controller = new AbortController();
    controller.abort();
    await failure(await handle(request(
      XR_HTTP_PATHS.authorityConnect,
      { workspaceId: "workspace-http" },
      { "x-local-authority": "trusted" },
      { signal: controller.signal },
    )), 408, "request_aborted");
    expect(relay.authority).toBeUndefined();

    const streamingController = new AbortController();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{"workspaceId":'));
      },
      cancel: cancelled,
    });
    const streamingRequest = new Request(`${API_ORIGIN}${XR_HTTP_PATHS.authorityConnect}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-authority": "trusted",
      },
      body: stream,
      signal: streamingController.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const streamingResponse = handle(streamingRequest);
    await new Promise<void>((resolve) => setImmediate(resolve));
    streamingController.abort();
    await failure(await streamingResponse, 408, "request_aborted");
    expect(cancelled).toHaveBeenCalled();
    expect(relay.authority).toBeUndefined();
  });

  it("does not mutate authority state when bootstrap is aborted during async trust", async () => {
    let releaseTrust: ((trusted: boolean) => void) | undefined;
    const { relay, handle } = rig(() => new Promise<boolean>((resolve) => {
      releaseTrust = resolve;
    }));
    const controller = new AbortController();
    const pending = handle(request(
      XR_HTTP_PATHS.authorityConnect,
      { workspaceId: "workspace-http" },
      {},
      { signal: controller.signal },
    ));
    await Promise.resolve();
    controller.abort();
    await failure(await pending, 408, "request_aborted");
    releaseTrust?.(true);
    await Promise.resolve();
    expect(relay.authority).toBeUndefined();
  });
});
