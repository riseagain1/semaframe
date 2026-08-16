import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  anchoredPlacementForBoxResize,
  InteractionRouter,
} from "../../workspace/interaction/InteractionRouter";
import { SelectionCoordinator } from "../../workspace/interaction/SelectionCoordinator";
import {
  placementCommitOperation,
  resizeCommitOperation,
} from "../../workspace/interaction/interactionOperations";
import type { Box2DResizePolicy } from "../../workspace/components/componentTypes";
import type { WorkspacePlacement } from "../../workspace/renderer/contracts";

describe("InteractionRouter", () => {
  it("uses preview-only pointer movement and commits one placement on pointer-up", async () => {
    const root = document.createElement("div");
    const item = document.createElement("div");
    item.dataset.workspaceComponentId = "panel-1";
    item.dataset.workspaceDraggable = "true";
    item.tabIndex = 0;
    root.appendChild(item);
    document.body.appendChild(root);
    const original: WorkspacePlacement = {
      space: "canvas2d",
      position: { x: 10, y: 20 },
      size: { width: 100, height: 80 },
    };
    const previewPlacement = vi.fn();
    const commitPlacement = vi.fn();
    const cancelPreview = vi.fn();
    let currentRevision = 8;
    const router = new InteractionRouter({
      selection: new SelectionCoordinator(),
      getBaseRevision: () => currentRevision,
      getPlacement: () => original,
      previewPlacement,
      cancelPreview,
      commitPlacement,
    });
    router.attach(root);

    fireEvent(item, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 80 }));
    currentRevision = 9;
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 140, clientY: 110 }));

    expect(original).toEqual({
      space: "canvas2d",
      position: { x: 10, y: 20 },
      size: { width: 100, height: 80 },
    });
    expect(previewPlacement).toHaveBeenCalledOnce();
    expect(previewPlacement.mock.calls[0]?.[1]).toMatchObject({ position: { x: 50, y: 50 } });
    expect(commitPlacement).not.toHaveBeenCalled();

    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 140, clientY: 110 }));
    expect(commitPlacement).toHaveBeenCalledOnce();
    expect(commitPlacement).toHaveBeenCalledWith(expect.objectContaining({
      componentId: "panel-1",
      baseRevision: 8,
      placement: expect.objectContaining({ position: { x: 50, y: 50 } }),
      originalPlacement: original,
    }));
    expect(placementCommitOperation(commitPlacement.mock.calls[0]![0], "OP_MOVE")).toEqual({
      op: "place_component",
      op_id: "OP_MOVE",
      id: "panel-1",
      placement: {
        space: "canvas2d",
        position: { x: 50, y: 50 },
        size: { width: 100, height: 80 },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelPreview).toHaveBeenCalledOnce();
    router.dispose();
    root.remove();
  });

  it("restores the preview on Escape without committing", () => {
    const root = document.createElement("div");
    const item = document.createElement("div");
    item.dataset.workspaceComponentId = "desk";
    item.dataset.workspaceDraggable = "true";
    item.tabIndex = 0;
    root.appendChild(item);
    document.body.appendChild(root);
    const placement: WorkspacePlacement = {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const commitPlacement = vi.fn();
    const cancelPreview = vi.fn();
    const router = new InteractionRouter({
      selection: new SelectionCoordinator(),
      getBaseRevision: () => 1,
      getPlacement: () => placement,
      previewPlacement: vi.fn(),
      cancelPreview,
      commitPlacement,
    });
    router.attach(root);

    fireEvent(item, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 20 }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(cancelPreview).toHaveBeenCalledWith("desk", placement);
    expect(commitPlacement).not.toHaveBeenCalled();
    router.dispose();
    root.remove();
  });

  it("previews box resizing during pointer movement and commits once on pointer-up", async () => {
    const root = document.createElement("div");
    const item = document.createElement("div");
    item.dataset.workspaceComponentId = "panel-1";
    item.dataset.workspaceDraggable = "true";
    const handle = document.createElement("button");
    handle.dataset.workspaceResizeHandle = "se";
    item.appendChild(handle);
    root.appendChild(item);
    document.body.appendChild(root);
    const placement: WorkspacePlacement = {
      space: "canvas2d",
      position: { x: 0, y: 0 },
      size: { width: 100, height: 80 },
    };
    const previewResize = vi.fn();
    const commitResize = vi.fn();
    const cancelResizePreview = vi.fn();
    let currentRevision = 12;
    const router = new InteractionRouter({
      selection: new SelectionCoordinator(),
      getBaseRevision: () => currentRevision,
      getPlacement: () => placement,
      getResizePolicy: () => FREE_BOX_POLICY,
      previewPlacement: vi.fn(),
      cancelPreview: vi.fn(),
      commitPlacement: vi.fn(),
      previewResize,
      cancelResizePreview,
      commitResize,
    });
    router.attach(root);

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 80 }));
    currentRevision = 13;
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 140, clientY: 110 }));

    expect(previewResize).toHaveBeenCalledOnce();
    expect(previewResize.mock.calls[0]?.[1]).toEqual({
      kind: "box2d",
      size: { width: 140, height: 110 },
    });
    expect(previewResize.mock.calls[0]?.[3]).toEqual({
      space: "canvas2d",
      position: { x: 20, y: 15 },
      size: { width: 140, height: 110 },
    });
    expect(commitResize).not.toHaveBeenCalled();

    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 140, clientY: 110 }));
    expect(commitResize).toHaveBeenCalledOnce();
    const request = commitResize.mock.calls[0]![0];
    expect(request).toEqual({
      componentId: "panel-1",
      resize: { kind: "box2d", size: { width: 140, height: 110 } },
      originalResize: { kind: "box2d", size: { width: 100, height: 80 } },
      placement: {
        space: "canvas2d",
        position: { x: 20, y: 15 },
        size: { width: 140, height: 110 },
      },
      originalPlacement: placement,
      baseRevision: 12,
    });
    expect(resizeCommitOperation(request, "OP_RESIZE")).toEqual({
      op: "resize_component",
      op_id: "OP_RESIZE",
      id: "panel-1",
      resize: { kind: "box2d", size: { width: 140, height: 110 } },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelResizePreview).toHaveBeenCalledOnce();
    router.dispose();
    root.remove();
  });

  it("cancels an active resize on Escape without a durable commit", () => {
    const root = document.createElement("div");
    const item = document.createElement("div");
    item.dataset.workspaceComponentId = "video-1";
    const handle = document.createElement("button");
    handle.dataset.workspaceResizeHandle = "se";
    item.appendChild(handle);
    root.appendChild(item);
    document.body.appendChild(root);
    const placement: WorkspacePlacement = {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: { width: 480, height: 306 },
    };
    const commitResize = vi.fn();
    const cancelResizePreview = vi.fn();
    const router = new InteractionRouter({
      selection: new SelectionCoordinator(),
      getBaseRevision: () => 4,
      getPlacement: () => placement,
      getResizePolicy: () => ASPECT_BOX_POLICY,
      previewPlacement: vi.fn(),
      cancelPreview: vi.fn(),
      commitPlacement: vi.fn(),
      previewResize: vi.fn(),
      cancelResizePreview,
      commitResize,
    });
    router.attach(root);

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 30 }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(commitResize).not.toHaveBeenCalled();
    expect(cancelResizePreview).toHaveBeenCalledWith(
      "video-1",
      { kind: "box2d", size: { width: 480, height: 306 } },
    );
    router.dispose();
    root.remove();
  });

  it("supports keyboard resizing from focused handles", async () => {
    const root = document.createElement("div");
    const item = document.createElement("div");
    item.dataset.workspaceComponentId = "panel-1";
    const handle = document.createElement("button");
    handle.dataset.workspaceResizeHandle = "e";
    item.appendChild(handle);
    root.appendChild(item);
    document.body.appendChild(root);
    const commitResize = vi.fn();
    const router = new InteractionRouter({
      selection: new SelectionCoordinator(),
      getBaseRevision: () => 5,
      getPlacement: () => ({
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 200, height: 120 },
      }),
      getResizePolicy: () => FREE_BOX_POLICY,
      previewPlacement: vi.fn(),
      cancelPreview: vi.fn(),
      commitPlacement: vi.fn(),
      previewResize: vi.fn(),
      cancelResizePreview: vi.fn(),
      commitResize,
    });
    router.attach(root);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(commitResize).toHaveBeenCalledOnce();
    expect(commitResize).toHaveBeenCalledWith(expect.objectContaining({
      componentId: "panel-1",
      resize: { kind: "box2d", size: { width: 208, height: 120 } },
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 4, y: 0 },
        size: { width: 208, height: 120 },
      },
      baseRevision: 5,
    }));
    await Promise.resolve();
    router.dispose();
    root.remove();
  });

  it("keeps the opposite viewport edge anchored for north and west handles", () => {
    const centered: WorkspacePlacement = {
      space: "viewport",
      anchor: "center",
      offset: { x: 12, y: -8 },
      size: { width: 100, height: 80 },
    };
    expect(anchoredPlacementForBoxResize(
      centered,
      { width: 100, height: 80 },
      { width: 140, height: 110 },
      "nw",
    )).toEqual({
      space: "viewport",
      anchor: "center",
      offset: { x: -8, y: -23 },
      size: { width: 140, height: 110 },
    });

    const bottomRight: WorkspacePlacement = {
      space: "viewport",
      anchor: "bottom_right",
      offset: { x: 3, y: 4 },
      size: { width: 100, height: 80 },
    };
    expect(anchoredPlacementForBoxResize(
      bottomRight,
      { width: 100, height: 80 },
      { width: 140, height: 110 },
      "nw",
    )).toEqual({
      space: "viewport",
      anchor: "bottom_right",
      offset: { x: 3, y: 4 },
      size: { width: 140, height: 110 },
    });
  });

  it("anchors resized canvas edges in the component's rotated local axes", () => {
    expect(anchoredPlacementForBoxResize(
      {
        space: "canvas2d",
        position: { x: 10, y: 20 },
        size: { width: 100, height: 80 },
        rotationDeg: 90,
      },
      { width: 100, height: 80 },
      { width: 120, height: 100 },
      "nw",
    )).toEqual({
      space: "canvas2d",
      position: { x: 20, y: 10 },
      size: { width: 120, height: 100 },
      rotationDeg: 90,
    });
  });

  it("never turns interaction with embedded media into a canvas drag", () => {
    const root = document.createElement("div");
    const item = document.createElement("div");
    item.dataset.workspaceComponentId = "video-1";
    item.dataset.workspaceDraggable = "true";
    const iframe = document.createElement("iframe");
    iframe.title = "Video player";
    item.appendChild(iframe);
    root.appendChild(item);
    document.body.appendChild(root);
    const placement: WorkspacePlacement = {
      space: "canvas2d",
      position: { x: 10, y: 20 },
      size: { width: 480, height: 270 },
    };
    const selection = new SelectionCoordinator();
    const previewPlacement = vi.fn();
    const commitPlacement = vi.fn();
    const cancelPreview = vi.fn();
    const onSelection = vi.fn();
    const unsubscribe = selection.subscribe(onSelection);
    const router = new InteractionRouter({
      selection,
      getBaseRevision: () => 3,
      getPlacement: () => placement,
      previewPlacement,
      cancelPreview,
      commitPlacement,
    });
    router.attach(root);

    fireEvent(iframe, new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 80,
      clientY: 70,
    }));
    fireEvent(document, new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 180,
      clientY: 170,
    }));
    fireEvent(document, new MouseEvent("pointerup", {
      bubbles: true,
      clientX: 180,
      clientY: 170,
    }));

    expect(onSelection).toHaveBeenCalledWith(expect.objectContaining({ componentId: "video-1" }));
    expect(previewPlacement).not.toHaveBeenCalled();
    expect(commitPlacement).not.toHaveBeenCalled();
    expect(cancelPreview).not.toHaveBeenCalled();

    unsubscribe();
    router.dispose();
    root.remove();
  });
});

const FREE_BOX_POLICY: Box2DResizePolicy = {
  kind: "box2d",
  mode: "free",
  defaultSize: { width: 240, height: 144 },
  minSize: { width: 80, height: 60 },
  maxSize: { width: 1000, height: 800 },
  allowedAxes: ["width", "height"],
  units: "px",
};

const ASPECT_BOX_POLICY: Box2DResizePolicy = {
  ...FREE_BOX_POLICY,
  mode: "aspect_locked",
  aspectRatio: 16 / 9,
  defaultSize: { width: 480, height: 270 },
};
