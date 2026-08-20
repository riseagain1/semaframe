import { describe, expect, it } from "vitest";
import { ProjectionBridge } from "../../workspace/renderer/ProjectionBridge";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

describe("ProjectionBridge", () => {
  it("keeps a timer billboard anchored to a moving 3D desk", () => {
    const bridge = new ProjectionBridge({
      camera: { position: { x: 0, y: 2, z: 10 }, target: { x: 0, y: 1, z: 0 }, fovDeg: 45 },
    });
    bridge.setViewport({ width: 800, height: 600 });
    const desk = spatial("desk", { x: 0, y: 0, z: 0 });
    const timer = component("timer", "timer", {
      space: "billboard",
      targetId: "desk",
      offset: { x: 0, y: 2, z: 0 },
      size: { width: 200, height: 100 },
    });
    bridge.setComponents([desk, timer]);
    const before = bridge.project(timer);

    const movedDesk = spatial("desk", { x: 2, y: 0, z: 0 });
    bridge.setComponents([movedDesk, timer]);
    const after = bridge.project(timer);

    expect(before.visible).toBe(true);
    expect(after.visible).toBe(true);
    expect(after.left).toBeGreaterThan(before.left + 80);
    expect(bridge.resolveWorldAnchor("timer")).toEqual({ x: 2, y: 2, z: 0 });
  });

  it("projects all five placement spaces with finite coordinates", () => {
    const bridge = new ProjectionBridge({
      camera: { position: { x: 0, y: 1, z: 10 }, target: { x: 0, y: 1, z: 0 }, fovDeg: 45 },
    });
    bridge.setViewport({ width: 1000, height: 700 });
    const anchor = spatial("anchor", { x: 0, y: 0, z: 0 });
    const values = [
      anchor,
      component("canvas", "panel", { space: "canvas2d", position: { x: 100, y: -50 } }),
      component("surface", "panel", { space: "surface", targetId: "anchor", surface: "top", offset: { x: 12, y: -8 } }),
      component("billboard", "text", { space: "billboard", targetId: "anchor", offset: { x: 0, y: 2, z: 0 } }),
      component("viewport", "checklist", { space: "viewport", anchor: "bottom_right", offset: { x: -12, y: -12 } }),
    ];
    bridge.setComponents(values);

    for (const projected of bridge.projectAll().values()) {
      expect(Number.isFinite(projected.left)).toBe(true);
      expect(Number.isFinite(projected.top)).toBe(true);
      expect(projected.width).toBeGreaterThan(0);
      expect(projected.height).toBeGreaterThan(0);
    }
  });

  it("gives an unsized video player a full 16:9 provider viewport plus its title strip", () => {
    const bridge = new ProjectionBridge();
    bridge.setViewport({ width: 900, height: 700 });
    const video = component("video", "video-player", {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
    });
    bridge.setComponents([video]);

    expect(bridge.project(video)).toMatchObject({
      width: 480,
      height: 306,
      left: 210,
      top: 197,
    });
  });

  it("fits a viewport video on a narrow screen without rewriting its placement", () => {
    const bridge = new ProjectionBridge();
    bridge.setViewport({ width: 390, height: 844 });
    const placement = {
      space: "viewport" as const,
      anchor: "center" as const,
      offset: { x: 0, y: 0 },
      size: { width: 480, height: 306 },
    };
    const video = component("mobile-video", "video-player", placement);
    bridge.setComponents([video]);

    const projected = bridge.project(video);
    expect(projected.width).toBe(366);
    expect(projected.height).toBeCloseTo(241.875, 3);
    expect(projected.left).toBe(12);
    expect(video.placement).toEqual(placement);
  });

  it("uses only canonical placement geometry and renders valid sub-24px boxes exactly", () => {
    const bridge = new ProjectionBridge();
    bridge.setViewport({ width: 800, height: 600 });
    const fixed = {
      ...component("fixed", "recipe.fixed-card", {
        space: "viewport",
        anchor: "center",
        offset: { x: 0, y: 0 },
        size: { width: 8, height: 9 },
      }),
      props: { width: 800, height: 400 },
    };
    bridge.setComponents([fixed]);

    expect(bridge.project(fixed)).toMatchObject({
      width: 8,
      height: 9,
      left: 396,
      top: 295.5,
    });
  });

  it("projects a world DOM component from its box size without a second scale lane", () => {
    const bridge = new ProjectionBridge({
      camera: { position: { x: 0, y: 1, z: 10 }, target: { x: 0, y: 1, z: 0 }, fovDeg: 45 },
    });
    bridge.setViewport({ width: 800, height: 600 });
    const panel = component("world-panel", "panel", {
      space: "world3d",
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      size: { width: 180, height: 90 },
    });
    bridge.setComponents([panel]);

    expect(bridge.project(panel)).toMatchObject({
      width: 180,
      height: 90,
      spatialOnly: false,
    });
  });

  it("keeps native primitives and model assemblies exclusively in the 3D renderer", () => {
    const bridge = new ProjectionBridge();
    bridge.setViewport({ width: 800, height: 600 });
    const placement = {
      space: "world3d" as const,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const primitive = component("primitive", "spatial-primitive", placement);
    const assembly = component("assembly", "model-assembly", placement);
    bridge.setComponents([primitive, assembly]);

    expect(bridge.project(primitive).spatialOnly).toBe(true);
    expect(bridge.project(assembly).spatialOnly).toBe(true);
  });

  it("does not apply privileged host projection behavior to suffix-colliding recipe IDs", () => {
    const bridge = new ProjectionBridge();
    bridge.setViewport({ width: 390, height: 844 });
    const recipeStage = component("recipe-stage", "recipe.stage-3d", {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      size: { width: 80, height: 60 },
    });
    const recipeSpatial = component("recipe-spatial", "recipe.spatial-entity", {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      size: { width: 90, height: 70 },
    });
    const recipeVideo = component("recipe-video", "recipe.video-player", {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: { width: 480, height: 306 },
    });
    bridge.setComponents([recipeStage, recipeSpatial, recipeVideo]);

    expect(bridge.project(recipeStage)).toMatchObject({ spatialOnly: false, width: 80, height: 60 });
    expect(bridge.project(recipeSpatial)).toMatchObject({ spatialOnly: false, width: 90, height: 70 });
    expect(bridge.project(recipeVideo)).toMatchObject({
      spatialOnly: false,
      width: 480,
      height: 306,
      left: -45,
    });
  });
});

function spatial(id: string, position: { x: number; y: number; z: number }): WorkspaceRenderComponent {
  return component(id, "spatial-entity", {
    space: "world3d",
    position,
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
}

function component(
  id: string,
  typeId: string,
  placement: WorkspaceRenderComponent["placement"],
): WorkspaceRenderComponent {
  return {
    id,
    type: { typeId, version: "1.0.0", digest: "test" },
    label: id,
    props: {},
    durableState: {},
    placement,
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}
