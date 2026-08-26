import { describe, expect, it } from "vitest";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import {
  diffXrWorkspaceProjection,
  digestXrProjection,
  toXrWorkspaceProjection,
  xrProjectionAsJsonObject,
} from "../../xr/authority";
import {
  createXrViewerInputMessage,
  XrViewerProjectionReplica,
} from "../../xr/app";
import { XR_RELAY_PROTOCOL_VERSION, type XrDeltaMessage, type XrSnapshotMessage } from "../../xr/protocol";

const identity = {
  sessionId: "session-viewer-0001",
  authorityEpoch: "authority-epoch-0001",
  workspaceId: "workspace-xr-app",
} as const;

function workspace(revision: number, labels: readonly string[]): WorkspaceRenderSnapshot {
  return {
    workspaceId: identity.workspaceId,
    revision,
    components: labels.map((label, index) => ({
      id: `part-${index}`,
      type: { typeId: "spatial-entity", version: "1.0.0", digest: "fixture-digest" },
      label,
      props: { assetId: "primitive_box", entityKind: "primitive" },
      durableState: {},
      placement: {
        space: "world3d",
        position: { x: index, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      tags: [],
      visibility: "visible",
      locks: { placement: false },
    })),
  };
}

async function snapshotMessage(revision: number, labels: readonly string[]): Promise<XrSnapshotMessage> {
  const projection = toXrWorkspaceProjection(workspace(revision, labels));
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "snapshot",
    ...identity,
    revision,
    requestId: `snapshot-request-${revision}`,
    registryDigest: `sha256:${"a".repeat(64)}`,
    snapshotDigest: await digestXrProjection(projection),
    snapshot: xrProjectionAsJsonObject(projection),
  };
}

async function deltaMessage(
  beforeRevision: number,
  beforeLabels: readonly string[],
  afterLabels: readonly string[],
): Promise<XrDeltaMessage> {
  const before = toXrWorkspaceProjection(workspace(beforeRevision, beforeLabels));
  const after = toXrWorkspaceProjection(workspace(beforeRevision + 1, afterLabels));
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "delta",
    ...identity,
    revision: after.revision,
    requestId: `delta-request-${after.revision}`,
    baseRevision: before.revision,
    baseSnapshotDigest: await digestXrProjection(before),
    snapshotDigest: await digestXrProjection(after),
    delta: xrProjectionAsJsonObject(diffXrWorkspaceProjection(before, after)),
  };
}

describe("XrViewerProjectionReplica", () => {
  it("applies an authoritative snapshot and exact one-revision delta without creating a Store", async () => {
    const replica = new XrViewerProjectionReplica(identity);
    await expect(replica.apply(await snapshotMessage(4, ["Desk"]))).resolves.toMatchObject({
      status: "applied",
      projection: { revision: 4, workspaceId: identity.workspaceId },
    });
    await expect(replica.apply(await deltaMessage(4, ["Desk"], ["Desk moved", "Lamp"]))).resolves.toMatchObject({
      status: "applied",
      projection: { revision: 5 },
    });
    expect(replica.projection?.components.map(({ label }) => label)).toEqual(["Desk moved", "Lamp"]);
  });

  it("rejects tampered digests, cross-session data, and deltas without a base snapshot", async () => {
    const replica = new XrViewerProjectionReplica(identity);
    const snapshot = await snapshotMessage(1, ["Desk"]);
    await expect(replica.apply({ ...snapshot, snapshotDigest: `sha256:${"f".repeat(64)}` }))
      .rejects.toMatchObject({ code: "digest_mismatch" });
    await expect(replica.apply({ ...snapshot, sessionId: "another-session-0001" }))
      .rejects.toMatchObject({ code: "session_mismatch" });
    await expect(new XrViewerProjectionReplica(identity).apply(await deltaMessage(1, ["Desk"], ["Lamp"])))
      .rejects.toMatchObject({ code: "snapshot_required" });
  });

  it("creates reconnect cursors and outbound inputs pinned to the current identity and revision", async () => {
    const replica = new XrViewerProjectionReplica(identity);
    await replica.apply(await snapshotMessage(8, ["Desk"]));
    expect(replica.reconnectCursor("reconnect-request-0001")).toMatchObject({
      ...identity,
      revision: 8,
      snapshotDigest: await digestXrProjection(toXrWorkspaceProjection(workspace(8, ["Desk"]))),
    });
    expect(createXrViewerInputMessage({
      identity,
      revision: 8,
      requestId: "input-request-0001",
      inputType: "activate",
      payload: { componentId: "part-0" },
    })).toMatchObject({
      messageType: "input",
      inputType: "activate",
      ...identity,
      revision: 8,
    });
  });

  it("atomically replaces a newer divergent replica only through a full reconnect checkpoint", async () => {
    const replica = new XrViewerProjectionReplica(identity);
    await replica.apply(await snapshotMessage(8, ["Locally newer"]));

    const checkpoint = await snapshotMessage(4, ["Authoritative base"]);
    const revisionFive = await deltaMessage(4, ["Authoritative base"], ["Recovered five"]);
    const invalidRevisionSix = {
      ...(await deltaMessage(5, ["Recovered five"], ["Tampered six"])),
      snapshotDigest: `sha256:${"f".repeat(64)}` as const,
    };
    await expect(replica.applyReconnect({
      kind: "full_snapshot",
      messages: [checkpoint, revisionFive, invalidRevisionSix],
    })).rejects.toMatchObject({ code: "digest_mismatch" });
    expect(replica.projection).toMatchObject({ revision: 8 });
    expect(replica.projection?.components[0]?.label).toBe("Locally newer");

    const revisionSix = await deltaMessage(5, ["Recovered five"], ["Recovered six"]);
    await expect(replica.applyReconnect({
      kind: "full_snapshot",
      messages: [checkpoint, revisionFive, revisionSix],
    })).resolves.toMatchObject({
      status: "applied",
      projection: { revision: 6 },
    });
    expect(replica.projection?.components[0]?.label).toBe("Recovered six");
  });
});
