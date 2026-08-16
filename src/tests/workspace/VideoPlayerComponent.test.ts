import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceProjectSerializer, workspaceStateDigest } from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

describe("video-player workspace component", () => {
  it("publishes deterministic desired-playback actions without observed media state", () => {
    const manifest = DEFAULT_COMPONENT_REGISTRY.require("video-player");
    expect(manifest).toMatchObject({
      typeId: "video-player",
      version: "1.2.0",
      trustTier: "builtin",
      allowedPlacements: ["canvas2d", "surface", "billboard", "viewport"],
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultDurableState: {
        desiredPlayback: "stopped",
        lastCommand: "none",
        requestedTimeSeconds: 0,
        commandGeneration: 0,
      },
    });
    expect(manifest.defaultProps).toMatchObject({
      sourceKind: "youtube",
      controls: true,
      autoplay: false,
      preload: "none",
    });
    expect(Object.keys(manifest.actions)).toEqual([
      "play", "pause", "seek", "stop", "show", "hide", "toggle_visibility",
    ]);
    expect(Object.keys(manifest.events)).toEqual([
      "play_requested", "pause_requested", "seek_requested", "stop_requested", "visibility_changed",
    ]);
    expect(() => DEFAULT_COMPONENT_REGISTRY.assertProps(
      DEFAULT_COMPONENT_REGISTRY.ref("video-player"),
      manifest.defaultProps,
    )).not.toThrow();
  });

  it("creates, updates, saves and reopens provider configuration without playback writes", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_video", [{
      op: "create_component",
      op_id: "video",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("video-player"),
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 480, height: 306 },
      },
      props: {
        sourceUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
        sourceKind: "youtube",
        title: "Initial demo",
        startAtSeconds: 12,
      },
    }]));
    store.apply(workspaceBatch(store, "update_video", [{
      op: "update_component",
      op_id: "update_video",
      id: "CMP_000001",
      patch: { props: {
        sourceUrl: "https://vimeo.com/76979871",
        sourceKind: "vimeo",
        title: "Workspace briefing",
        caption: "Source: Vimeo",
        loop: true,
        muted: true,
      } },
    }]));

    const component = store.getState().components.get("CMP_000001");
    expect(component).toMatchObject({
      props: {
        sourceUrl: "https://vimeo.com/76979871",
        sourceKind: "vimeo",
        startAtSeconds: 12,
        loop: true,
      },
      durableState: {
        desiredPlayback: "stopped",
        lastCommand: "none",
        requestedTimeSeconds: 0,
        commandGeneration: 0,
      },
    });
    expect(store.getCommandHistory()).toHaveLength(2);
    expect(store.getEventHistory()).toEqual([]);

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(
      serializer.serialize(serializer.fromStore("video_project", store)),
    ));
    expect(workspaceStateDigest(reopened.getState() as never))
      .toBe(workspaceStateDigest(store.getState() as never));
    expect(reopened.getState().components.get("CMP_000001")?.props)
      .toEqual(component?.props);
  });

  it("records bounded playback intent without pretending to observe provider state", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_video", [{
      op: "create_component", op_id: "video", id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("video-player"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    for (const [requestId, action, input] of [
      ["play_video", "play", {}],
      ["seek_video", "seek", { timeSeconds: 42.5 }],
      ["pause_video", "pause", {}],
      ["stop_video", "stop", {}],
    ] as const) {
      store.apply(workspaceBatch(store, requestId, [{
        op: "invoke_component_action", op_id: requestId, id: "CMP_000001", action, input,
      }]));
    }
    expect(store.getState().components.get("CMP_000001")?.durableState).toEqual({
      desiredPlayback: "stopped",
      lastCommand: "stop",
      requestedTimeSeconds: 0,
      commandGeneration: 4,
    });
    expect(store.getEventHistory().map(({ event, payload }) => ({ event, payload }))).toEqual([
      { event: "play_requested", payload: { generation: 1 } },
      { event: "seek_requested", payload: { generation: 2, timeSeconds: 42.5 } },
      { event: "pause_requested", payload: { generation: 3 } },
      { event: "stop_requested", payload: { generation: 4 } },
    ]);
  });

  it("rejects world3d placement while allowing a video surface in the 3D scene", () => {
    const store = new WorkspaceStore();
    expect(() => store.apply(workspaceBatch(store, "world_video", [{
      op: "create_component",
      op_id: "world_video",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("video-player"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]))).toThrow(/cannot be placed in world3d/i);

    store.apply(workspaceBatch(store, "surface_video", [{
      op: "create_component",
      op_id: "stage",
      id: "CMP_000004",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }, {
      op: "create_component",
      op_id: "display",
      id: "CMP_000002",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      props: { assetId: "fallback_prop_box", entityKind: "prop" },
    }, {
      op: "create_component",
      op_id: "surface_video",
      id: "CMP_000003",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("video-player"),
      placement: {
        space: "surface",
        targetId: "CMP_000002",
        surface: "screen",
        offset: { x: 0, y: 0 },
        size: { width: 480, height: 306 },
      },
    }]));
    expect(store.getState().components.get("CMP_000003")?.placement.space).toBe("surface");
  });
});
