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
  BridgeSessionError,
  BridgeSessionService,
  createBridgeHttpHandler,
  type BridgePublication,
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

function archive(revision = 3): Uint8Array {
  return createDeterministicCadHandoffArchive([{
    path: "semaframe.exchange.json",
    bytes: bridgeJsonBytes(manifest(revision)),
  }]);
}

function digest(revision = 3): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(archive(revision)).digest("hex")}`;
}

const DIGEST = digest();

function publication(sequence = 1, revision = 3): BridgePublication {
  const bytes = archive(revision);
  return {
    sequence,
    workspaceId: "WORKSPACE",
    revision,
    exchangeDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    manifest: manifest(revision),
    archive: bytes,
  };
}

function proposal(revision = 3) {
  return {
    format: SEMAFRAME_CHANGE_PROPOSAL_FORMAT,
    version: SEMAFRAME_CHANGE_PROPOSAL_VERSION,
    proposalId: "unity-1",
    target: "unity",
    source: { workspaceId: "WORKSPACE", baseRevision: revision, exchangeDigest: DIGEST },
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

describe("BridgeSessionService", () => {
  it("uses scoped bearer capabilities and publishes monotonic immutable exchanges", () => {
    let now = 1_000;
    const service = new BridgeSessionService(() => now);
    const access = service.create("owner-a", "unity", publication(), 10_000);
    expect(access.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(() => service.pull(access.sessionId, "x".repeat(43))).toThrow(BridgeSessionError);
    expect(service.pull(access.sessionId, access.bearer)?.publication.sequence).toBe(1);
    expect(service.pull(access.sessionId, access.bearer, 1)).toBeUndefined();

    expect(() => service.publish("owner-a", access.sessionId, publication(1, 4))).toThrow(/advance sequence/);
    expect(service.publish("owner-a", access.sessionId, publication(2, 4)).publication.revision).toBe(4);
    const currentDigest = digest(4);
    const bytes = service.readArchive(access.sessionId, access.bearer, currentDigest);
    bytes[0] = 0;
    expect(service.readArchive(access.sessionId, access.bearer, currentDigest)[0]).not.toBe(0);

    now = 11_001;
    expect(() => service.pull(access.sessionId, access.bearer)).toThrow(/expired/);
  });

  it("queues matching proposals for owner review and rejects stale or cross-target proposals", () => {
    const service = new BridgeSessionService(() => 1_000);
    const access = service.create("owner-a", "unity", publication(), 10_000);
    const record = service.submitProposal(access.sessionId, access.bearer, proposal());
    expect(record.cursor).toBe(1);
    expect(service.readProposals("owner-a", access.sessionId)).toEqual([record]);
    expect(() => service.submitProposal(access.sessionId, access.bearer, { ...proposal(), target: "blender" }))
      .toThrow(/does not match/);
    expect(() => service.submitProposal(access.sessionId, access.bearer, proposal(2)))
      .toThrow(/does not match/);
    expect(() => service.submitProposal(access.sessionId, access.bearer, {}))
      .toThrowError(expect.objectContaining({ code: "invalid_proposal" }));
    service.discardProposals("owner-a", access.sessionId, record.cursor);
    expect(service.readProposals("owner-a", access.sessionId)).toEqual([]);
    expect(() => service.close("owner-b", access.sessionId)).toThrow(/authorization/);
    service.close("owner-a", access.sessionId);
    expect(() => service.pull(access.sessionId, access.bearer)).toThrow(/not found/);
  });

  it("rejects trailing data and a mismatched ZIP central directory", () => {
    const service = new BridgeSessionService(() => 1_000);
    const valid = publication();
    const trailing = new Uint8Array(valid.archive.byteLength + 1);
    trailing.set(valid.archive);
    const trailingPublication: BridgePublication = {
      ...valid,
      archive: trailing,
      exchangeDigest: `sha256:${createHash("sha256").update(trailing).digest("hex")}`,
    };
    expect(() => service.create("owner-a", "unity", trailingPublication, 10_000))
      .toThrow(/end record/);

    const mismatchedDirectory = valid.archive.slice();
    const view = new DataView(
      mismatchedDirectory.buffer,
      mismatchedDirectory.byteOffset,
      mismatchedDirectory.byteLength,
    );
    let centralOffset = 0;
    while (view.getUint32(centralOffset, true) === 0x04034b50) {
      centralOffset += 30
        + view.getUint16(centralOffset + 26, true)
        + view.getUint16(centralOffset + 28, true)
        + view.getUint32(centralOffset + 22, true);
    }
    view.setUint32(centralOffset + 42, 1, true);
    const mismatchedPublication: BridgePublication = {
      ...valid,
      archive: mismatchedDirectory,
      exchangeDigest: `sha256:${createHash("sha256").update(mismatchedDirectory).digest("hex")}`,
    };
    expect(() => service.create("owner-a", "unity", mismatchedPublication, 10_000))
      .toThrow(/directory entry/);
  });

  it("serves pull/download/proposal endpoints without exposing owner operations", async () => {
    const service = new BridgeSessionService(() => 1_000);
    const access = service.create("owner-a", "unity", publication(), 10_000);
    const handle = createBridgeHttpHandler(service);
    const authorization = { authorization: `Bearer ${access.bearer}` };
    const pulled = await handle(new Request(`http://localhost/v1/bridge/sessions/${access.sessionId}`, {
      headers: authorization,
    }));
    expect(pulled?.status).toBe(200);
    expect(await pulled?.json()).toMatchObject({ ok: true, data: { publication: { sequence: 1 } } });
    const unchanged = await handle(new Request(`http://localhost/v1/bridge/sessions/${access.sessionId}?after_sequence=1`, {
      headers: authorization,
    }));
    expect(unchanged?.status).toBe(204);
    const downloaded = await handle(new Request(`http://localhost/v1/bridge/sessions/${access.sessionId}/exchange?digest=${DIGEST}`, {
      headers: authorization,
    }));
    expect(downloaded?.headers.get("content-type")).toBe("application/vnd.semaframe.exchange+zip");
    expect((await downloaded?.arrayBuffer())?.byteLength).toBe(archive().byteLength);
    const submitted = await handle(new Request(`http://localhost/v1/bridge/sessions/${access.sessionId}/proposals`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(proposal()),
    }));
    expect(submitted?.status).toBe(202);
    expect(await submitted?.json()).toEqual({ ok: true, data: { cursor: 1, status: "review_required" } });
    expect(await handle(new Request("http://localhost/elsewhere"))).toBeUndefined();
  });

  it("rejects ambiguous paths, query fields, encodings, and invalid UTF-8", async () => {
    const service = new BridgeSessionService(() => 1_000);
    const access = service.create("owner-a", "unity", publication(), 10_000);
    const handle = createBridgeHttpHandler(service);
    const authorization = { authorization: `Bearer ${access.bearer}` };
    const base = `http://localhost/v1/bridge/sessions/${access.sessionId}`;

    expect((await handle(new Request(`${base}/`, { headers: authorization })))?.status).toBe(404);
    expect((await handle(new Request(`${base}?after_sequence=0&after_sequence=1`, { headers: authorization })))?.status).toBe(422);
    expect((await handle(new Request(`${base}/exchange?digest=${DIGEST}&extra=1`, { headers: authorization })))?.status).toBe(422);
    expect((await handle(new Request(`${base}/proposals?extra=1`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(proposal()),
    })))?.status).toBe(422);
    expect((await handle(new Request(`${base}/proposals`, {
      method: "POST",
      headers: {
        ...authorization,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: JSON.stringify(proposal()),
    })))?.status).toBe(422);
    expect((await handle(new Request(`${base}/proposals`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    })))?.status).toBe(422);
    const invalidProposal = await handle(new Request(`${base}/proposals`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: "{}",
    }));
    expect(invalidProposal?.status).toBe(422);
    expect(await invalidProposal?.json()).toMatchObject({ error: { code: "invalid_proposal" } });
  });
});
