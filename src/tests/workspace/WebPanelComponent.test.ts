import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceProjectSerializer, workspaceStateDigest } from "../../workspace/persistence";
import { toRenderSnapshot } from "../../workspace/renderer/contracts";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

describe("web-panel authoritative component contract", () => {
  it("canonicalizes create/update history and round-trips source, geometry, and undo state", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_web", [{
      op: "create_component",
      op_id: "create_web",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("web-panel"),
      label: "Markets",
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
      },
      props: {
        sourceUrl: "https://EXAMPLE.com:443/markets",
        title: "Markets",
      },
    }]));
    expect(store.getState().components.get("CMP_000001")).toMatchObject({
      props: { sourceUrl: "https://example.com/markets", title: "Markets" },
      placement: { size: { width: 560, height: 420 } },
      durableState: {},
    });
    expect(toRenderSnapshot(store.getState()).components[0]?.instanceRevision).toBe(1);
    expect(store.getCommandHistory()[0]?.resolvedOperations[0]).toMatchObject({
      op: "create_component",
      props: { sourceUrl: "https://example.com/markets" },
    });

    store.apply(workspaceBatch(store, "update_web", [{
      op: "update_component",
      op_id: "update_web",
      id: "CMP_000001",
      patch: { props: { sourceUrl: "https://Example.org/dashboard?q=close" } },
    }]));
    expect(store.getState().components.get("CMP_000001")?.props.sourceUrl)
      .toBe("https://example.org/dashboard?q=close");
    expect(store.getCommandHistory()[1]?.resolvedOperations[0]).toMatchObject({
      op: "update_component",
      patch: { props: { sourceUrl: "https://example.org/dashboard?q=close" } },
    });

    store.apply(workspaceBatch(store, "resize_web", [{
      op: "resize_component",
      op_id: "resize_web",
      id: "CMP_000001",
      resize: { kind: "box2d", size: { width: 720, height: 520 } },
    }]));
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 720, height: 520 });
    store.undo();
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 560, height: 420 });
    store.redo();

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("web_panel_project", store),
    )));
    expect(workspaceStateDigest(reopened.getState() as never))
      .toBe(workspaceStateDigest(store.getState() as never));
    expect(reopened.getState().components.get("CMP_000001")?.props.sourceUrl)
      .toBe("https://example.org/dashboard?q=close");
  });

  it.each([
    "http://example.com/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://example.com/?apiKey=secret",
    "https://example.com/#access_token=secret",
    "https://localhost/",
    "https://192.168.1.1/",
    "https://[::1]/",
    "https://example.com/?code=0123456789abcdef0123456789abcdef",
    "https://example.com/#eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "https://example.com/magic-login/0123456789abcdef0123456789abcdef",
  ])("rejects unsafe Agent-equivalent writes before committing: %s", (sourceUrl) => {
    const store = new WorkspaceStore();
    expect(() => store.apply(workspaceBatch(store, "unsafe_web", [{
      op: "create_component",
      op_id: "unsafe_web",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("web-panel"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      props: { sourceUrl, title: "Unsafe" },
    }]))).toThrow();
    expect(store.getRevision()).toBe(0);
    expect(store.getState().components.size).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
  });
});
