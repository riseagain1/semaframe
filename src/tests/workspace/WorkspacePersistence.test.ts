import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  WorkspaceProjectError,
  WorkspaceProjectSerializer,
  workspaceStateDigest,
} from "../../workspace/persistence";
import {
  MODELING_WORKSPACE_PROTOCOL_VERSION,
  MODELING_WORKSPACE_SCHEMA_VERSION,
  REALITY_WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_PROTOCOL_VERSION,
  WORKSPACE_SCHEMA_VERSION,
} from "../../workspace/protocol";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

describe("Workspace Project 1.0 persistence", () => {
  it("keeps protocol 1.3 while normalizing project schema 1.3 to 1.4", () => {
    expect(WORKSPACE_PROTOCOL_VERSION).toBe("1.3");
    expect(WORKSPACE_SCHEMA_VERSION).toBe("1.4");

    const serializer = new WorkspaceProjectSerializer();
    const current = serializer.fromStore("schema_1_4", new WorkspaceStore());
    expect(current).toMatchObject({
      protocolVersion: "1.3",
      workspaceSchemaVersion: "1.4",
      checkpoint: { protocolVersion: "1.3", workspaceSchemaVersion: "1.4" },
      workspace: { protocolVersion: "1.3", workspaceSchemaVersion: "1.4" },
    });

    const schema13 = structuredClone(current) as unknown as {
      workspaceSchemaVersion: string;
      checkpoint: { workspaceSchemaVersion: string };
      workspace: { workspaceSchemaVersion: string };
    };
    schema13.workspaceSchemaVersion = REALITY_WORKSPACE_SCHEMA_VERSION;
    schema13.checkpoint.workspaceSchemaVersion = REALITY_WORKSPACE_SCHEMA_VERSION;
    schema13.workspace.workspaceSchemaVersion = REALITY_WORKSPACE_SCHEMA_VERSION;

    const migrated = serializer.deserialize(schema13);
    expect(migrated).toMatchObject({
      protocolVersion: "1.3",
      workspaceSchemaVersion: "1.4",
      checkpoint: { protocolVersion: "1.3", workspaceSchemaVersion: "1.4" },
      workspace: { protocolVersion: "1.3", workspaceSchemaVersion: "1.4" },
    });
    expect(JSON.parse(serializer.serialize(migrated))).toMatchObject({
      protocolVersion: "1.3",
      workspaceSchemaVersion: "1.4",
    });
  });

  it("retains the released 1.2 project migration path when saving as schema 1.4", () => {
    const serializer = new WorkspaceProjectSerializer();
    const schema12 = structuredClone(
      serializer.fromStore("schema_1_2", new WorkspaceStore()),
    ) as unknown as {
      protocolVersion: string;
      workspaceSchemaVersion: string;
      checkpoint: {
        protocolVersion: string;
        workspaceSchemaVersion: string;
        realityAssets?: unknown;
      };
      workspace: {
        protocolVersion: string;
        workspaceSchemaVersion: string;
        realityAssets?: unknown;
      };
    };
    schema12.protocolVersion = MODELING_WORKSPACE_PROTOCOL_VERSION;
    schema12.workspaceSchemaVersion = MODELING_WORKSPACE_SCHEMA_VERSION;
    for (const snapshot of [schema12.checkpoint, schema12.workspace]) {
      snapshot.protocolVersion = MODELING_WORKSPACE_PROTOCOL_VERSION;
      snapshot.workspaceSchemaVersion = MODELING_WORKSPACE_SCHEMA_VERSION;
      // Reality Assets were introduced by Workspace 1.3, so a released 1.2
      // file legitimately has no catalog field at all.
      delete snapshot.realityAssets;
    }

    const migrated = serializer.deserialize(schema12);
    expect(migrated).toMatchObject({
      protocolVersion: "1.3",
      workspaceSchemaVersion: "1.4",
      checkpoint: { protocolVersion: "1.3", workspaceSchemaVersion: "1.4" },
      workspace: { protocolVersion: "1.3", workspaceSchemaVersion: "1.4" },
    });
    expect(migrated.checkpoint.realityAssets).toEqual([]);
    expect(migrated.workspace.realityAssets).toEqual([]);
  });

  it("round-trips normalized Maps, history, resources, bindings, IDs and event cursors", () => {
    const store = new WorkspaceStore({ clock: () => 500 });
    store.apply(workspaceBatch(store, "setup", [{
      op: "create_component", op_id: "timer", id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport", anchor: "top_right", offset: { x: 10, y: 10 } },
      props: { durationMs: 5_000 },
    }, {
      op: "upsert_resource", op_id: "resource",
      resource: {
        id: "RES_1", label: "Numbers", connectorType: "fixture", connectorVersion: "1",
        outputSchema: { type: "object" }, config: {},
        policy: { mode: "manual", offline: "keep_last_good" }, status: "ready",
        snapshot: { data: { duration: 5_000 }, contentHash: "sha256:fixture", retrievedAt: "2026-01-01T00:00:00.000Z", stale: false, provenance: [] },
      },
    }, {
      op: "bind_resource", op_id: "binding",
      binding: {
        kind: "resource_binding", id: "BIND_1", resourceId: "RES_1",
        componentId: "CMP_000001", targetProp: "durationMs", sourcePath: "$.duration",
        mode: "snapshot", transform: { kind: "identity" }, enabled: true,
      },
    }]));
    store.apply(workspaceBatch(store, "start", [{
      op: "invoke_component_action", op_id: "start", id: "CMP_000001", action: "start", input: {},
    }]));
    // Burn an unused reservation; persistence must retain the monotonic counter.
    expect(store.reserveComponentIds(2)).toEqual(["CMP_000002", "CMP_000003"]);

    const serializer = new WorkspaceProjectSerializer();
    const serialized = serializer.serialize(serializer.fromStore("project_1", store));
    const reopened = serializer.openStore(serializer.deserialize(serialized));
    expect(workspaceStateDigest(reopened.getState() as never)).toBe(workspaceStateDigest(store.getState() as never));
    expect(reopened.getState().components).toBeInstanceOf(Map);
    expect(reopened.getState().resources).toBeInstanceOf(Map);
    expect(reopened.getState().connections.get("BIND_1")?.kind).toBe("resource_binding");
    expect(reopened.getCommandHistory()).toEqual(store.getCommandHistory());
    expect(reopened.getAllocatorSnapshot()).toBe(store.getAllocatorSnapshot());
    expect(reopened.getNextEventCursor()).toBe(store.getNextEventCursor());
    expect(reopened.canUndo()).toBe(true);
  });

  it("replays an already host-normalized inline snapshot without stamping a new clock", () => {
    const observedAtMs = 42_000;
    const store = new WorkspaceStore({ clock: () => observedAtMs });
    store.apply(workspaceBatch(store, "inline_snapshot", [{
      op: "upsert_resource",
      op_id: "upsert_inline_snapshot",
      resource: {
        id: "RES_inline",
        label: "Inline values",
        connectorType: "inline.snapshot",
        connectorVersion: "1.0.0",
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["values"],
          properties: { values: { type: "array", items: { type: "number" } } },
        },
        config: {},
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data: { values: [1, 2, 3] },
          contentHash: "caller-value",
          retrievedAt: "1970-01-01T00:00:00.000Z",
          stale: false,
          provenance: [],
        },
        status: "ready",
      },
    }]));
    const normalized = store.getState().resources.get("RES_inline")!;
    expect(normalized.snapshot?.retrievedAt).toBe("1970-01-01T00:00:42.000Z");
    expect(store.getCommandHistory()[0]?.resolvedOperations[0]).toMatchObject({
      op: "upsert_resource",
      resource: { snapshot: { retrievedAt: "1970-01-01T00:00:42.000Z" } },
    });

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("inline_snapshot_replay", store),
    )));
    expect(reopened.getState().resources.get("RES_inline")).toEqual(normalized);
    expect(reopened.getCommandHistory()).toEqual(store.getCommandHistory());
  });

  it("rejects tampered canonical inline resources in saved state and resolved replay history", () => {
    const store = new WorkspaceStore({ clock: () => 42_000 });
    store.apply(workspaceBatch(store, "inline_integrity", [{
      op: "upsert_resource",
      op_id: "upsert_inline_integrity",
      resource: {
        id: "RES_inline",
        label: "Inline values",
        connectorType: "inline.snapshot",
        connectorVersion: "1.0.0",
        outputSchema: { type: "array", items: { type: "number" } },
        config: {},
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data: [1, 2, 3],
          contentHash: "caller-value",
          retrievedAt: "1970-01-01T00:00:00.000Z",
          stale: false,
          provenance: [],
        },
        status: "ready",
      },
    }]));
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.fromStore("inline_integrity", store);

    const stateTamper = structuredClone(project);
    stateTamper.workspace.resources.find(([id]) => id === "RES_inline")![1].snapshot!.contentHash = "forged";
    expect(() => serializer.deserialize(JSON.stringify(stateTamper))).toThrow(/canonical host-owned form/u);

    const replayTamper = structuredClone(project);
    const upsert = replayTamper.commandHistory[0]!.resolvedOperations.find((operation) => operation.op === "upsert_resource");
    if (!upsert || upsert.op !== "upsert_resource") throw new Error("Expected resource operation");
    upsert.resource.snapshot!.provenance = [];
    expect(() => serializer.deserialize(JSON.stringify(replayTamper))).toThrow(/canonical host-owned form/u);
  });

  it("rejects saved-state or resolved-history tampering", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "panel", [{
      op: "create_component", op_id: "panel", id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.fromStore("project_1", store);
    project.commandHistory[0]!.resultingWorkspaceRevision = 99;
    expect(() => serializer.serialize(project)).toThrow(WorkspaceProjectError);
  });

  it("rejects event cursors that move backward across the checkpoint floor or within a command", () => {
    const store = new WorkspaceStore({ clock: () => 100 });
    store.apply(workspaceBatch(store, "zero_timer", [{
      op: "create_component", op_id: "timer", id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
      placement: { space: "viewport", anchor: "top", offset: { x: 0, y: 0 } },
      props: { durationMs: 0 },
    }]));
    store.apply(workspaceBatch(store, "start_zero", [{
      op: "invoke_component_action", op_id: "start", id: "CMP_000001", action: "start", input: {},
    }]));
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.fromStore("cursor_tamper", store);

    const backwardFromCheckpoint = structuredClone(project);
    backwardFromCheckpoint.checkpointNextEventCursor = 2;
    expect(() => serializer.serialize(backwardFromCheckpoint)).toThrow(/Event cursor ordering mismatch/);

    const reversedWithinCommand = structuredClone(project);
    const events = reversedWithinCommand.commandHistory.find((command) => command.requestId === "start_zero")!.resolvedEvents;
    [events[0]!.cursor, events[1]!.cursor] = [events[1]!.cursor, events[0]!.cursor];
    expect(() => serializer.serialize(reversedWithinCommand)).toThrow(/Event cursor ordering mismatch/);
  });

  it("rejects unsupported wrappers and project extensions", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "panel", [{
      op: "create_component", op_id: "panel", id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.fromStore("workspace_only", store);

    expect(() => serializer.deserialize({
      kind: "unsupported-wrapper",
      formatVersion: "1.0",
      projectId: "wrapped_project",
      payload: project,
    })).toThrow(WorkspaceProjectError);

    expect(() => serializer.deserialize({
      ...structuredClone(project),
      unsupportedAudit: { contentHash: "retired" },
    })).toThrow(/additional properties/u);

    const systemCheckpoint = structuredClone(project) as unknown as Record<string, unknown>;
    const history = systemCheckpoint.commandHistory as Array<Record<string, unknown>>;
    history[0]!.hostResolution = { snapshot: {} };
    expect(() => serializer.deserialize(systemCheckpoint)).toThrow(/additional properties/u);
  });
});
