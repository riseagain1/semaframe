import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCanvasOverlay } from "../../app/components/workspace/WorkspaceCanvasOverlay";
import type { ProjectedComponent, WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

afterEach(cleanup);

describe("WorkspaceCanvasOverlay", () => {
  it("exposes a synchronized accessible component tree including 3D entities", () => {
    const components = [
      component("desk", "spatial-entity", "Desk"),
      component("brief", "panel", "Mission brief"),
      component("timer", "timer", "Launch timer", {
        durationMs: 600_000,
        label: "Launch",
        showProgress: true,
      }, {
        phase: "paused",
        durationMs: 600_000,
        remainingMs: 300_000,
        runGeneration: 1,
      }),
    ];
    const projections = new Map<string, ProjectedComponent>([
      ["desk", projected("desk", true)],
      ["brief", projected("brief", false)],
      ["timer", projected("timer", false)],
    ]);
    render(<WorkspaceCanvasOverlay
      components={components}
      projections={projections}
      selectedId="desk"
      onSelect={vi.fn()}
    />);

    const tree = screen.getByRole("tree", { name: "Workspace components" });
    expect(within(tree).getAllByRole("treeitem")).toHaveLength(3);
    expect(within(tree).getByRole("treeitem", { name: /Desk, spatial-entity, visible/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: /Mission brief, panel component/i })).toBeVisible();
    expect(screen.getByRole("region", { name: /Launch timer, timer component/i })).toBeVisible();
    expect(screen.getByLabelText("05:00 remaining")).toBeInTheDocument();
  });

  it("exposes eight named, keyboard-focusable handles for a selected free-size component", () => {
    const panel = component("brief", "panel", "Mission brief");
    render(<WorkspaceCanvasOverlay
      components={[panel]}
      projections={new Map([["brief", projected("brief", false)]])}
      selectedId="brief"
      getResizePolicy={() => ({
        kind: "box2d",
        mode: "free",
        defaultSize: { width: 240, height: 144 },
        minSize: { width: 80, height: 60 },
        maxSize: { width: 1_200, height: 900 },
        allowedAxes: ["width", "height"],
        units: "px",
      })}
    />);

    const region = screen.getByRole("region", { name: /Mission brief, panel component/i });
    const handles = within(region).getAllByRole("button", { name: /Resize Mission brief from/i });
    expect(handles).toHaveLength(8);
    expect(within(region).getByRole("button", { name: /bottom right/i })).toHaveAttribute(
      "data-workspace-resize-handle",
      "se",
    );
    for (const handle of handles) expect(handle).not.toHaveAttribute("tabindex", "-1");
  });

  it("does not render resize handles when resize or placement is locked", () => {
    const panel = {
      ...component("brief", "panel", "Mission brief"),
      locks: { placement: false, resize: true, props: false, deletion: false, actions: false },
    };
    render(<WorkspaceCanvasOverlay
      components={[panel]}
      projections={new Map([["brief", projected("brief", false)]])}
      selectedId="brief"
      getResizePolicy={() => ({
        kind: "box2d",
        mode: "free",
        defaultSize: { width: 240, height: 144 },
        minSize: { width: 80, height: 60 },
        maxSize: { width: 1_200, height: 900 },
        allowedAxes: ["width", "height"],
        units: "px",
      })}
    />);

    expect(screen.queryByRole("button", { name: /Resize Mission brief from/i })).not.toBeInTheDocument();
  });

  it("keeps camera-projected and responsive boxes on the exact Inspector path", () => {
    const surfacePanel: WorkspaceRenderComponent = {
      ...component("surface-brief", "panel", "Surface brief"),
      placement: {
        space: "surface",
        targetId: "desk",
        surface: "top",
        offset: { x: 0, y: 0 },
        size: { width: 240, height: 144 },
      },
    };
    const responsiveVideo: WorkspaceRenderComponent = {
      ...component("video", "video-player", "Video Player"),
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 640, height: 408 },
      },
    };
    const resizePolicy = () => ({
      kind: "box2d" as const,
      mode: "free" as const,
      defaultSize: { width: 240, height: 144 },
      minSize: { width: 80, height: 60 },
      maxSize: { width: 1_200, height: 900 },
      allowedAxes: ["width", "height"] as Array<"width" | "height">,
      units: "px" as const,
    });

    const { rerender } = render(<WorkspaceCanvasOverlay
      components={[surfacePanel]}
      projections={new Map([["surface-brief", {
        ...projected("surface-brief", false),
        space: "surface",
      }]])}
      selectedId="surface-brief"
      getResizePolicy={resizePolicy}
    />);
    expect(screen.getByRole("region", { name: /Surface brief, panel component/i }))
      .toHaveAttribute("data-workspace-resizable", "false");
    expect(screen.queryByRole("button", { name: /Resize Surface brief from/i })).not.toBeInTheDocument();

    rerender(<WorkspaceCanvasOverlay
      components={[responsiveVideo]}
      projections={new Map([["video", {
        ...projected("video", false),
        width: 500,
        height: 330,
      }]])}
      selectedId="video"
      getResizePolicy={resizePolicy}
    />);
    expect(screen.getByRole("region", { name: /Video Player, video-player component/i }))
      .toHaveAttribute("data-workspace-resizable", "false");
    expect(screen.queryByRole("button", { name: /Resize Video Player from/i })).not.toBeInTheDocument();
  });
});

function component(
  id: string,
  typeId: string,
  label: string,
  props: Record<string, unknown> = {},
  durableState: Record<string, unknown> = {},
): WorkspaceRenderComponent {
  return {
    id,
    type: { typeId, version: "1.0.0", digest: "test" },
    label,
    props,
    durableState,
    placement: typeId === "spatial-entity"
      ? { space: "world3d", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      : { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}

function projected(componentId: string, spatialOnly: boolean): ProjectedComponent {
  return {
    componentId,
    space: spatialOnly ? "world3d" : "viewport",
    left: 20,
    top: 20,
    width: 240,
    height: 144,
    zIndex: 1,
    visible: true,
    spatialOnly,
  };
}
