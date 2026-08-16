import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceInspector,
  type WorkspaceComponentResizeRequest,
} from "../../app/components/workspace/WorkspaceInspector";
import {
  resizePolicyForPlacement,
  type ComponentResizePolicy,
} from "../../workspace/components/componentTypes";
import { prepareComponentRecipe } from "../../workspace/protocol";
import { toRenderSnapshot, type WorkspaceRenderComponent } from "../../workspace/renderer/contracts";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

afterEach(cleanup);

describe("Workspace resize Inspector controls", () => {
  it("keeps aspect-locked dimensions synchronized and submits one absolute resize", () => {
    const onResize = vi.fn();
    render(<WorkspaceInspector
      component={component({
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 480, height: 270 },
      })}
      resizePolicy={policy({ kind: "box2d" })}
      onResize={onResize}
    />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "640" } });
    expect(screen.getByRole("spinbutton", { name: "Height" })).toHaveValue(360);
    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));

    expect(onResize).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledWith({
      componentId: "component-1",
      resize: { kind: "box2d", size: { width: 640, height: 360 } },
    });
  });

  it("provides exact independent scale controls for a spatial component", () => {
    const onResize = vi.fn();
    render(<WorkspaceInspector
      component={component({
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1.5, z: .75 },
      }, "spatial-entity")}
      resizePolicy={policy({ kind: "scale3d" })}
      onResize={onResize}
    />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "X" }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Z" }), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));

    expect(onResize).toHaveBeenCalledWith({
      componentId: "component-1",
      resize: { kind: "scale3d", scale: { x: 2, y: 1.5, z: 1.25 } },
    });
  });

  it("uses stage dimensions and prevents submission when resize is locked", () => {
    const onResize = vi.fn();
    render(<WorkspaceInspector
      component={{
        ...component({
          space: "world3d",
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        }, "stage-3d"),
        props: { dimensions: { width: 18, height: 6, depth: 12 } },
        locks: { placement: false, resize: true, props: false, deletion: false, actions: false },
      }}
      resizePolicy={policy({ kind: "stage_dimensions" })}
      onResize={onResize}
    />);

    expect(screen.getByRole("spinbutton", { name: "Width" })).toHaveValue(18);
    expect(screen.getByRole("spinbutton", { name: "Depth" })).toHaveValue(12);
    expect(screen.getByRole("button", { name: "Apply size" })).toBeDisabled();
    expect(screen.getByText("Resizing is locked for this component.")).toBeVisible();
    expect(onResize).not.toHaveBeenCalled();
  });

  it("rejects out-of-range numeric dimensions without silently clamping", () => {
    const onResize = vi.fn();
    render(<WorkspaceInspector
      component={component({
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 480, height: 270 },
      })}
      resizePolicy={policy({ kind: "box2d", mode: "free" })}
      onResize={onResize}
    />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Width must be between 80 and 1200 px");
    expect(onResize).not.toHaveBeenCalled();
  });

  it("keeps exact numeric resizing available for camera-projected boxes", () => {
    const onResize = vi.fn();
    render(<WorkspaceInspector
      component={component({
        space: "surface",
        targetId: "desk",
        surface: "top",
        offset: { x: 0, y: 0 },
        size: { width: 480, height: 270 },
      })}
      resizePolicy={policy({ kind: "box2d" })}
      onResize={onResize}
    />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "640" } });
    expect(screen.getByRole("spinbutton", { name: "Height" })).toHaveValue(360);
    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));
    expect(onResize).toHaveBeenCalledWith({
      componentId: "component-1",
      resize: { kind: "box2d", size: { width: 640, height: 360 } },
    });
  });

  it("round-trips irrational aspect geometry and derives edits at full precision", () => {
    const onResize = vi.fn();
    const ratio = Math.SQRT2;
    const exactHeight = 2 / ratio;
    render(<WorkspaceInspector
      component={component({
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 2, height: exactHeight },
      })}
      resizePolicy={irrationalAspectPolicy(ratio)}
      onResize={onResize}
    />);

    expect(screen.getByRole("spinbutton", { name: "Height" })).toHaveAttribute(
      "value",
      String(exactHeight),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));
    expect(onResize).toHaveBeenNthCalledWith(1, {
      componentId: "component-1",
      resize: { kind: "box2d", size: { width: 2, height: exactHeight } },
    });

    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "3" } });
    expect(screen.getByRole("spinbutton", { name: "Height" })).toHaveAttribute(
      "value",
      String(3 / ratio),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));
    expect(onResize).toHaveBeenNthCalledWith(2, {
      componentId: "component-1",
      resize: { kind: "box2d", size: { width: 3, height: 3 / ratio } },
    });
  });

  it("rejects truncated irrational aspect geometry before the Store boundary", () => {
    const onResize = vi.fn();
    render(<WorkspaceInspector
      component={component({
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 2, height: 1.4142 },
      })}
      resizePolicy={irrationalAspectPolicy(Math.SQRT2)}
      onResize={onResize}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));
    expect(screen.getByRole("alert")).toHaveTextContent("must preserve");
    expect(onResize).not.toHaveBeenCalled();
  });

  it("submits a synchronized irrational aspect resize that the Store accepts", () => {
    const ratio = Math.SQRT2;
    const recipe = prepareComponentRecipe({
      typeId: "recipe.irrational-card",
      version: "1.1.0",
      displayName: "Irrational card",
      allowedPlacements: ["viewport"],
      resizePolicy: { viewport: irrationalAspectPolicy(ratio) },
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {},
      defaultDurableState: {},
      writableProps: [],
      actions: {},
      events: {},
      root: { id: "root", primitive: "stack" },
    });
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_irrational", [{
      op: "define_component_recipe",
      op_id: "define_irrational",
      recipe,
    }, {
      op: "create_component",
      op_id: "create_irrational",
      id: "CMP_IRRATIONAL",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: ratio, height: 1 },
      },
    }]));
    const rendered = toRenderSnapshot(store.getState()).components[0]!;
    const manifest = store.getComponentManifest(rendered.type.typeId, rendered.type.version)!;
    const resizePolicy = resizePolicyForPlacement(manifest, rendered.placement);
    const onResize = vi.fn((request: WorkspaceComponentResizeRequest) => {
      store.apply(workspaceBatch(store, "resize_irrational", [{
        op: "resize_component",
        op_id: "resize_irrational",
        id: request.componentId,
        resize: request.resize,
      }]));
    });
    render(<WorkspaceInspector
      component={rendered}
      resizePolicy={resizePolicy}
      onResize={onResize}
    />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "2" } });
    expect(screen.getByRole("spinbutton", { name: "Height" })).toHaveAttribute(
      "value",
      String(2 / ratio),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));

    expect(onResize).toHaveBeenCalledOnce();
    expect(store.getState().components.get("CMP_IRRATIONAL")?.placement).toMatchObject({
      size: { width: 2, height: 2 / ratio },
    });
    expect(store.getRevision()).toBe(2);
  });
});

function component(
  placement: WorkspaceRenderComponent["placement"],
  typeId = "panel",
): WorkspaceRenderComponent {
  return {
    id: "component-1",
    type: { typeId, version: "1.1.0", digest: "test" },
    label: "Test component",
    props: {},
    durableState: {},
    placement,
    tags: [],
    visibility: "visible",
    locks: { placement: false, resize: false, props: false, deletion: false, actions: false },
  };
}

function policy(
  input:
    | { kind: "box2d"; mode?: "free" | "aspect_locked" }
    | { kind: "scale3d" }
    | { kind: "stage_dimensions" },
): ComponentResizePolicy {
  if (input.kind === "box2d") return {
    kind: "box2d",
    mode: input.mode ?? "aspect_locked",
    defaultSize: { width: 480, height: 270 },
    minSize: { width: 80, height: 45 },
    maxSize: { width: 1_200, height: 675 },
    aspectRatio: 16 / 9,
    allowedAxes: ["width", "height"],
    units: "px",
  };
  if (input.kind === "scale3d") return {
    kind: "scale3d",
    mode: "free",
    defaultScale: { x: 1, y: 1, z: 1 },
    minScale: { x: .01, y: .01, z: .01 },
    maxScale: { x: 100, y: 100, z: 100 },
    allowedAxes: ["x", "y", "z"],
    units: "ratio",
  };
  return {
    kind: "stage_dimensions",
    mode: "free",
    defaultDimensions: { width: 16, height: 6, depth: 12 },
    minDimensions: { width: 1, height: 1, depth: 1 },
    maxDimensions: { width: 200, height: 50, depth: 200 },
    allowedAxes: ["width", "height", "depth"],
    units: "m",
  };
}

function irrationalAspectPolicy(aspectRatio: number): ComponentResizePolicy {
  return {
    kind: "box2d",
    mode: "aspect_locked",
    defaultSize: { width: aspectRatio, height: 1 },
    minSize: { width: 1, height: 1 },
    maxSize: { width: 100, height: 100 },
    aspectRatio,
    allowedAxes: ["width", "height"],
    units: "px",
  };
}
