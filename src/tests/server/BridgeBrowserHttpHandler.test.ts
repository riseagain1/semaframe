// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SEMAFRAME_CHANGE_PROPOSAL_FORMAT,
  SEMAFRAME_CHANGE_PROPOSAL_VERSION,
  SEMAFRAME_EXCHANGE_FORMAT,
  SEMAFRAME_EXCHANGE_VERSION,
  bridgeJsonBytes,
  type SemaFrameExchangeManifest,
} from "../../bridge";
import { createDeterministicCadHandoffArchive } from "../../workspace/modeling/cadHandoffArchive";
import {
  BridgeSessionService,
  createBridgeBrowserHttpHandler,
  createBridgeHttpHandler,
} from "../../../server/bridge";

function manifest(revision = 3): SemaFrameExchangeManifest {
  return {
    format: SEMAFRAME_EXCHANGE_FORMAT,
    version: SEMAFRAME_EXCHANGE_VERSION,
    generator: { name: "SemaFrame", version: "test" },
    source: {
      workspaceId: "WORKSPACE",
      revision,
      workspaceDigest: `sha256:${"0".repeat(64)}`,
      registryDigest: "fnv1a32:11111111",
    },
    coordinateSystem: { units: "metre", handedness: "right", upAxis: "Y", angles: "radian" },
    nodes: [],
    resources: [],
    connections: [],
    files: [],
    roundTrip: { stableIds: true, directMutation: false, editsReturnAs: "reviewable_change_proposal" },
  };
}

function packageBytes(revision = 3): Uint8Array {
  return createDeterministicCadHandoffArchive([{
    path: "semaframe.exchange.json",
    bytes: bridgeJsonBytes(manifest(revision)),
  }]);
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function publicationRequest(
  url: string,
  bytes: Uint8Array,
  options: Readonly<{ creating?: boolean; sequence?: number; revision?: number; digest?: string }> = {},
): Request {
  const revision = options.revision ?? 3;
  const metadata = JSON.stringify({
    ...(options.creating === false ? {} : { target: "unity" }),
    sequence: options.sequence ?? 1,
    workspaceId: "WORKSPACE",
    revision,
    exchangeDigest: options.digest ?? digest(bytes),
    manifest: manifest(revision),
    ...(options.creating === false ? {} : { ttlMs: 10_000 }),
  });
  const boundary = "semaframe-test-boundary";
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="scene.semaframe-exchange"\r\n`
    + "Content-Type: application/vnd.semaframe.exchange+zip\r\n\r\n",
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.byteLength + bytes.byteLength + suffix.byteLength);
  body.set(prefix, 0);
  body.set(bytes, prefix.byteLength);
  body.set(suffix, prefix.byteLength + bytes.byteLength);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: body.buffer,
  });
}

function proposal(exchangeDigest: string) {
  return {
    format: SEMAFRAME_CHANGE_PROPOSAL_FORMAT,
    version: SEMAFRAME_CHANGE_PROPOSAL_VERSION,
    proposalId: "unity-1",
    target: "unity",
    source: { workspaceId: "WORKSPACE", baseRevision: 3, exchangeDigest },
    changes: [{
      changeId: "move-1",
      kind: "transform",
      componentId: "CUBE",
      placement: {
        space: "world3d",
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }],
  };
}

describe("Bridge browser owner HTTP surface", () => {
  it("creates an isolated native pull session and exposes queued edits only to its owner", async () => {
    const bytes = packageBytes();
    const service = new BridgeSessionService(() => 1_000);
    const browser = createBridgeBrowserHttpHandler(service, { publicBaseUrl: "http://127.0.0.1:8788" });
    const created = await browser.fetch(publicationRequest(
      "http://localhost/api/agent/bridge/sessions",
      bytes,
    ), "owner-a");
    expect(created.status).toBe(201);
    const access = await created.json() as Record<string, string>;
    expect(access.pullUrl).toBe(`http://127.0.0.1:8788/v1/bridge/sessions/${access.sessionId}`);
    expect(access.pullUrl).not.toContain(access.bearer);

    const native = createBridgeHttpHandler(service);
    const pulled = await native(new Request(access.pullUrl, {
      headers: { authorization: `Bearer ${access.bearer}` },
    }));
    expect(pulled?.status).toBe(200);

    service.submitProposal(access.sessionId, access.bearer, proposal(digest(bytes)));
    const queue = await browser.fetch(new Request(
      `http://localhost/api/agent/bridge/sessions/${access.sessionId}/proposals/read`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ), "owner-a");
    expect(await queue.json()).toMatchObject({ proposals: [{ cursor: 1, proposal: { proposalId: "unity-1" } }] });

    const denied = await browser.fetch(new Request(
      `http://localhost/api/agent/bridge/sessions/${access.sessionId}/inspect`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ), "owner-b");
    expect(denied.status).toBe(403);

    const queryRejected = await browser.fetch(new Request(
      `http://localhost/api/agent/bridge/sessions/${access.sessionId}/inspect?extra=1`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ), "owner-a");
    expect(queryRejected.status).toBe(400);

    const unrelatedBodyRejected = await browser.fetch(new Request(
      `http://localhost/api/agent/bridge/sessions/${access.sessionId}/inspect`,
      { method: "POST", headers: { "content-type": "application/json" }, body: '{"afterCursor":0}' },
    ), "owner-a");
    expect(unrelatedBodyRejected.status).toBe(400);

    const encodingRejected = await browser.fetch(new Request(
      `http://localhost/api/agent/bridge/sessions/${access.sessionId}/inspect`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: "{}",
      },
    ), "owner-a");
    expect(encodingRejected.status).toBe(415);
  });

  it("publishes only monotonic digest-verified packages and closes explicitly", async () => {
    const bytes = packageBytes();
    const service = new BridgeSessionService(() => 1_000);
    const browser = createBridgeBrowserHttpHandler(service, { publicBaseUrl: "http://127.0.0.1:8788" });
    const created = await browser.fetch(publicationRequest(
      "http://localhost/api/agent/bridge/sessions",
      bytes,
    ), "owner-a");
    const access = await created.json() as Record<string, string>;

    const tampered = await browser.fetch(publicationRequest(
      `http://localhost/api/agent/bridge/sessions/${access.sessionId}/publish`,
      bytes,
      { creating: false, sequence: 2, revision: 4, digest: `sha256:${"a".repeat(64)}` },
    ), "owner-a");
    expect(tampered.status).toBe(422);
    expect(await tampered.json()).toMatchObject({ error: { code: "invalid_publication" } });

    const nextBytes = packageBytes(4);
    const published = await browser.fetch(publicationRequest(
      `http://localhost/api/agent/bridge/sessions/${access.sessionId}/publish`,
      nextBytes,
      { creating: false, sequence: 2, revision: 4 },
    ), "owner-a");
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ publication: { sequence: 2, revision: 4 } });

    const closed = await browser.fetch(new Request(
      `http://localhost/api/agent/bridge/sessions/${access.sessionId}/close`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ), "owner-a");
    expect(await closed.json()).toEqual({ closed: true });
    expect(() => service.inspect("owner-a", access.sessionId)).toThrow(/not found/u);
  });
});
