import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMPONENT_TYPE_IDS,
  ComponentRegistry,
  DEFAULT_COMPONENT_REGISTRY,
} from "../../workspace/components";
import { prepareComponentRecipe } from "../../workspace/protocol";

describe("universal component registry", () => {
  it("ships the complete deterministic built-in catalog", () => {
    expect(BUILTIN_COMPONENT_TYPE_IDS).toEqual([
      "stage-3d", "spatial-entity", "group", "panel", "text", "image",
      "video-player", "web-panel", "data-panel", "annotation", "timer", "checklist", "chart", "table", "document", "button",
      "spatial-primitive", "model-assembly", "gaussian-splat",
    ]);
    const rebuilt = new ComponentRegistry([...DEFAULT_COMPONENT_REGISTRY.list()].reverse());
    expect(rebuilt.digest).toBe(DEFAULT_COMPONENT_REGISTRY.digest);
    expect(rebuilt.listLatest().map((manifest) => manifest.typeId).sort()).toEqual(
      [...BUILTIN_COMPONENT_TYPE_IDS].sort(),
    );
    // Existing types retain 1.0/1.1 compatibility refs; button starts at 1.2,
    // while spatial-entity alone adds collision-aware 1.3, physics-aware 1.4,
    // and master-switch 1.5 contracts.
    expect(rebuilt.list()).toHaveLength(52);
    for (const typeId of BUILTIN_COMPONENT_TYPE_IDS) {
      const expectedVersion = typeId === "spatial-entity"
        ? "1.5.0"
        : ["spatial-primitive", "model-assembly", "gaussian-splat"].includes(typeId)
          ? "1.0.0"
          : "1.2.0";
      expect(rebuilt.require(typeId).version).toBe(expectedVersion);
    }
    expect(rebuilt.require("image", "1.0.0").resizePolicy.viewport).toMatchObject({
      kind: "box2d",
      mode: "free",
      minSize: { width: 1, height: 1 },
      maxSize: { width: 4_096, height: 4_096 },
    });
    expect(rebuilt.require("image", "1.1.0").resizePolicy.viewport).toMatchObject({
      kind: "box2d",
      mode: "aspect_locked",
    });
    expect(rebuilt.require("stage-3d", "1.0.0").resizePolicy.world3d).toMatchObject({
      kind: "stage_dimensions",
      minDimensions: { width: Number.MIN_VALUE, height: Number.MIN_VALUE, depth: Number.MIN_VALUE },
      maxDimensions: { width: Number.MAX_VALUE, height: Number.MAX_VALUE, depth: Number.MAX_VALUE },
    });
  });

  it("pins exact type versions/digests and validates every default contract", () => {
    for (const manifest of DEFAULT_COMPONENT_REGISTRY.list()) {
      const ref = DEFAULT_COMPONENT_REGISTRY.ref(manifest.typeId, manifest.version);
      expect(() => DEFAULT_COMPONENT_REGISTRY.resolve(ref)).not.toThrow();
      expect(() => DEFAULT_COMPONENT_REGISTRY.assertProps(ref, manifest.defaultProps)).not.toThrow();
      expect(() => DEFAULT_COMPONENT_REGISTRY.assertDurableState(ref, manifest.defaultDurableState)).not.toThrow();
      expect(() => DEFAULT_COMPONENT_REGISTRY.resolve({ ...ref, digest: "tampered" })).toThrow(/digest mismatch/i);
    }
  });

  it("publishes closed modeling contracts with digest-pinned model references", () => {
    const primitive = DEFAULT_COMPONENT_REGISTRY.require("spatial-primitive");
    expect(primitive.allowedPlacements).toEqual(["world3d"]);
    expect(primitive.resizePolicy.world3d).toEqual({ kind: "none", mode: "none" });
    expect(() => DEFAULT_COMPONENT_REGISTRY.assertProps(primitive, {
      ...structuredClone(primitive.defaultProps),
      geometry: { kind: "box", sizeM: { x: 0.6, y: 0.4, z: 0.2 } },
      material: { ...structuredClone(primitive.defaultProps.material as object), debugShader: true },
    } as never)).toThrow(/additional properties/i);

    const assembly = DEFAULT_COMPONENT_REGISTRY.require("model-assembly");
    expect(() => DEFAULT_COMPONENT_REGISTRY.assertProps(assembly, {
      description: "Published fixture",
      collisionPolicy: "external_only",
      modelRef: { modelId: "fixture-a", version: "1.0.0", digest: "sha256:abc" },
    })).not.toThrow();

  });

  it("rejects policies that advertise impossible host ranges or incomplete coupled axes", () => {
    const incompleteAspect = DEFAULT_COMPONENT_REGISTRY.require("image");
    const aspectPolicy = incompleteAspect.resizePolicy.viewport;
    if (!aspectPolicy || aspectPolicy.kind !== "box2d") throw new Error("Expected image box policy");
    aspectPolicy.allowedAxes = ["width"];
    expect(() => new ComponentRegistry([incompleteAspect])).toThrow(/invalid box2d resize policy/i);

    const oversized = DEFAULT_COMPONENT_REGISTRY.require("panel");
    const oversizedPolicy = oversized.resizePolicy.viewport;
    if (!oversizedPolicy || oversizedPolicy.kind !== "box2d") throw new Error("Expected panel box policy");
    oversizedPolicy.maxSize.width = 4_097;
    expect(() => new ComponentRegistry([oversized])).toThrow(/invalid box2d resize policy/i);

    const partialUniform = DEFAULT_COMPONENT_REGISTRY.require("spatial-entity");
    const uniformPolicy = partialUniform.resizePolicy.world3d;
    if (!uniformPolicy || uniformPolicy.kind !== "scale3d") throw new Error("Expected spatial scale policy");
    uniformPolicy.mode = "uniform";
    uniformPolicy.allowedAxes = ["x", "y"];
    expect(() => new ComponentRegistry([partialUniform])).toThrow(/invalid scale3d resize policy/i);
  });

  it("reserves 3D scale policies for actually Three-rendered spatial entities and model assemblies", () => {
    const recipe = prepareComponentRecipe({
      typeId: "recipe.fake-spatial",
      version: "1.1.0",
      displayName: "Fake spatial",
      allowedPlacements: ["world3d"],
      resizePolicy: {
        world3d: {
          kind: "scale3d", mode: "free",
          defaultScale: { x: 1, y: 1, z: 1 },
          minScale: { x: 0.01, y: 0.01, z: 0.01 },
          maxScale: { x: 100, y: 100, z: 100 },
          allowedAxes: ["x", "y", "z"], units: "ratio",
        },
      },
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [], actions: {}, events: {},
      root: { id: "root", primitive: "asset3d" },
    });
    expect(() => new ComponentRegistry([ComponentRegistry.manifestFromRecipe(recipe)]))
      .toThrow(/invalid scale3d resize policy/i);
  });
});
