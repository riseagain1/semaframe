import { describe, expect, it } from "vitest";
import {
  isPhysicalSpatialTypeId,
  isRealitySpatialTypeId,
  isSpatialRenderTypeId,
  spatialComponentKind,
} from "../../workspace/spatial/spatialComponentKinds";

describe("Workspace spatial component classification", () => {
  it("classifies every host-owned spatial surface from one closed table", () => {
    expect(spatialComponentKind("stage-3d")).toBe("stage");
    expect(spatialComponentKind("spatial-entity")).toBe("asset");
    expect(spatialComponentKind("spatial-primitive")).toBe("primitive");
    expect(spatialComponentKind("model-assembly")).toBe("assembly");
    expect(spatialComponentKind("gaussian-splat")).toBe("reality");
    expect(spatialComponentKind("recipe.gaussian-splat")).toBeUndefined();
  });

  it("keeps visual reality out of physical-authority classification", () => {
    expect(isSpatialRenderTypeId("gaussian-splat")).toBe(true);
    expect(isRealitySpatialTypeId("gaussian-splat")).toBe(true);
    expect(isPhysicalSpatialTypeId("gaussian-splat")).toBe(false);
    expect(isPhysicalSpatialTypeId("spatial-primitive")).toBe(true);
    expect(isSpatialRenderTypeId("stage-3d")).toBe(false);
  });
});
