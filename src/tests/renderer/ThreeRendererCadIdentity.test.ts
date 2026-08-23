import { describe, expect, it } from "vitest";
import { cadEntityRenderIdentity } from "../../renderer/ThreeRenderer";
import type { EntityRenderGeometry } from "../../renderer/sceneRenderTypes";
import { defaultCadPartDefinition } from "../../workspace/modeling/cad";

type CadRenderGeometry = Extract<EntityRenderGeometry, { kind: "cad" }>;

function source(): CadRenderGeometry {
  return {
    kind: "cad",
    definition: defaultCadPartDefinition(),
    definitionDigest: "fnv1a32:12345678",
    material: {
      baseColor: "#AABBCC",
      metallic: 0.2,
      roughness: 0.5,
      opacity: 1,
      emissiveColor: "#000000",
      emissiveIntensity: 0,
    },
    castShadow: true,
    receiveShadow: true,
  };
}

describe("CAD render identity", () => {
  it("is stable for an identical presentation contract", () => {
    expect(cadEntityRenderIdentity(source())).toBe(cadEntityRenderIdentity(structuredClone(source())));
  });

  it.each([
    ["base color", (value: CadRenderGeometry): CadRenderGeometry => ({ ...value, material: { ...value.material, baseColor: "#112233" } })],
    ["metallic", (value: CadRenderGeometry): CadRenderGeometry => ({ ...value, material: { ...value.material, metallic: 0.8 } })],
    ["roughness", (value: CadRenderGeometry): CadRenderGeometry => ({ ...value, material: { ...value.material, roughness: 0.1 } })],
    ["opacity", (value: CadRenderGeometry): CadRenderGeometry => ({ ...value, material: { ...value.material, opacity: 0.4 } })],
    ["emissive color", (value: CadRenderGeometry): CadRenderGeometry => ({ ...value, material: { ...value.material, emissiveColor: "#FF2200" } })],
    ["emissive intensity", (value: CadRenderGeometry): CadRenderGeometry => ({ ...value, material: { ...value.material, emissiveIntensity: 1.5 } })],
    ["cast shadow", (value: CadRenderGeometry): CadRenderGeometry => ({ ...value, castShadow: false })],
    ["receive shadow", (value: CadRenderGeometry): CadRenderGeometry => ({ ...value, receiveShadow: false })],
  ] as const)("changes when %s changes", (_label, change) => {
    const initial = source();
    expect(cadEntityRenderIdentity(change(initial))).not.toBe(cadEntityRenderIdentity(initial));
  });
});
