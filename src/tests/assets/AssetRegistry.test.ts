import { describe, expect, it } from "vitest";
import { AssetRegistry, normalizeAssetText } from "../../assets/AssetRegistry";
import {
  ASSET_MANIFEST,
  type AssetManifest,
  type AssetRecord,
} from "../../assets/assetManifest";

describe("AssetRegistry", () => {
  it("normalizes Unicode deterministically", () => {
    expect(normalizeAssetText("  Ｓｍａｌｌ—RED Box! ")).toBe("small red box");
  });

  it("resolves exact semantic assets and fallbacks without randomness", () => {
    const registry = new AssetRegistry();
    const first = registry.resolve({ query: "small red box", kind: "prop" });
    const second = registry.resolve({ query: "small red box", kind: "prop" });
    expect(first.assetId).toBe("box_small_02");
    expect(second).toEqual(first);
    expect(first.approximated).toBe(false);

    const person = registry.resolve({
      query: "generic adult man low poly",
      kind: "character",
      styleFamily: "neutral_low_poly_v1",
    });
    expect(person.assetId).toBe("humanoid_adult_man_01");
    expect(person.approximated).toBe(false);

    const door = registry.resolve({
      query: "simple door",
      kind: "structure",
      styleFamily: "neutral_low_poly_v1",
    });
    expect(door.assetId).toBe("door_interior_01");
    expect(door.approximated).toBe(false);

    const unavailable = registry.resolve({ query: "orbital quantum loom", kind: "structure" });
    expect(unavailable.assetId).toBe("fallback_structure_box");
    expect(unavailable.approximated).toBe(true);
  });

  it("uses lexical assetId as the stable final tie-break", () => {
    const base = ASSET_MANIFEST.assets.find((asset) => asset.assetId === "fallback_prop_box")!;
    const make = (assetId: string): AssetRecord => ({
      ...structuredClone(base),
      assetId,
      displayName: "Identical Object",
      tags: ["identical", "object"],
      fallback: false,
    });
    const manifest: AssetManifest = {
      assetLibraryVersion: "test-1",
      styleFamily: "neutral_low_poly_v1",
      assets: [
        ...ASSET_MANIFEST.assets.filter((asset) => asset.kind !== "prop"),
        make("z_identical"),
        make("a_identical"),
        structuredClone(base),
      ],
    };
    const result = new AssetRegistry(manifest).search({ query: "identical object", kind: "prop" });
    expect(result.slice(0, 2).map((item) => item.assetId)).toEqual([
      "a_identical",
      "z_identical",
    ]);
  });

  it("contains the starter breadth and authoritative bounds", () => {
    const registry = new AssetRegistry();
    expect(registry.all().length).toBeGreaterThanOrEqual(20);
    for (const record of registry.all()) {
      expect(record.bounds.width).toBeGreaterThan(0);
      expect(record.bounds.height).toBeGreaterThan(0);
      expect(record.bounds.depth).toBeGreaterThan(0);
    }
  });

  it("rejects arbitrary manifests that violate the bundled GLB runtime contract", () => {
    const malformed = structuredClone(ASSET_MANIFEST) as unknown as Record<string, unknown>;
    const assets = malformed.assets as Array<Record<string, unknown>>;
    assets[0] = {
      ...assets[0],
      source: "bundled",
      // Bundled assets must declare a .glb runtime with meters, +Y and +Z.
    };

    expect(() => new AssetRegistry(malformed as unknown as AssetManifest)).toThrow(
      /assetManifest\.schema\.json.*runtime/i,
    );
  });

  it("rejects procedural manifests that try to smuggle in a non-contract runtime", () => {
    const malformed = structuredClone(ASSET_MANIFEST) as unknown as Record<string, unknown>;
    const assets = malformed.assets as Array<Record<string, unknown>>;
    assets[0] = {
      ...assets[0],
      runtime: {
        uri: "assets/person.obj",
        format: "obj",
        unitScaleMeters: 1,
        upAxis: "+Z",
        forwardAxis: "+Y",
        originRule: "ground_center",
      },
    };

    expect(() => new AssetRegistry(malformed as unknown as AssetManifest)).toThrow(
      /assetManifest\.schema\.json/i,
    );
  });
});
