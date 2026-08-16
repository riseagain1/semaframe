import * as THREE from "three";

export type RenderVisualEffects = Readonly<{
  opacity: number;
  emissiveColor: string;
  emissiveIntensity: number;
  glowColor: string;
  glowIntensity: number;
  glowSpread: number;
}>;

type MaterialBaseline = Readonly<{
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
  emissive?: number;
  emissiveIntensity?: number;
}>;

const BASELINE_KEY = "workspaceVisualEffectsBaseline";

/** Apply absolute effects from an immutable material baseline (never cumulatively). */
export function applyObjectVisualEffects(
  root: THREE.Object3D,
  effects: RenderVisualEffects,
): void {
  root.userData.workspaceGlowIntensity = effects.glowIntensity;
  root.userData.workspaceGlowSpread = effects.glowSpread;
  root.traverse((object) => {
    if (!isRenderableObject(object)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) applyMaterialVisualEffects(material, effects);
  });
}

/** Restore semantic materials before their normal appearance/state reducers run. */
export function restoreObjectVisualEffects(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!isRenderableObject(object)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const baseline = material.userData[BASELINE_KEY] as MaterialBaseline | undefined;
      if (!baseline) continue;
      material.opacity = baseline.opacity;
      material.transparent = baseline.transparent;
      material.depthWrite = baseline.depthWrite;
      material.visible = true;
      if (isMeshStandardMaterial(material)) {
        material.emissive.setHex(baseline.emissive ?? 0);
        material.emissiveIntensity = baseline.emissiveIntensity ?? 0;
      }
      delete material.userData[BASELINE_KEY];
      material.needsUpdate = true;
    }
  });
}

type RenderableObject = THREE.Object3D & { material: THREE.Material | THREE.Material[] };

function isRenderableObject(object: THREE.Object3D): object is RenderableObject {
  const candidate = object as THREE.Object3D & {
    isMesh?: boolean;
    isLine?: boolean;
    isLineSegments?: boolean;
    isPoints?: boolean;
    material?: THREE.Material | THREE.Material[];
  };
  return Boolean(candidate.material)
    && (candidate.isMesh === true || candidate.isLine === true
      || candidate.isLineSegments === true || candidate.isPoints === true);
}

function applyMaterialVisualEffects(material: THREE.Material, effects: RenderVisualEffects): void {
  const existing = material.userData[BASELINE_KEY] as MaterialBaseline | undefined;
  const standard = isMeshStandardMaterial(material);
  const baseline: MaterialBaseline = existing ?? {
    opacity: material.opacity,
    transparent: material.transparent,
    depthWrite: material.depthWrite,
    ...(standard ? {
      emissive: material.emissive.getHex(),
      emissiveIntensity: material.emissiveIntensity,
    } : {}),
  };
  if (!existing) material.userData[BASELINE_KEY] = baseline;

  const opacity = THREE.MathUtils.clamp(baseline.opacity * effects.opacity, 0, 1);
  const transparent = baseline.transparent || opacity < 0.999;
  const changedTransparency = material.transparent !== transparent;
  material.opacity = opacity;
  material.transparent = transparent;
  material.depthWrite = baseline.depthWrite && opacity >= 0.98;
  material.visible = opacity > 0.001;

  if (standard) {
    const activeGlow = effects.glowIntensity > 0;
    const activeEmissive = effects.emissiveIntensity > 0;
    if (activeGlow || activeEmissive) {
      material.emissive = new THREE.Color(activeGlow ? effects.glowColor : effects.emissiveColor);
      material.emissiveIntensity = (baseline.emissiveIntensity ?? 0)
        + effects.emissiveIntensity
        // Glow is amplified again by the post-process pass. Keep its material
        // contribution below the semantic 0–4 control so midrange values
        // illuminate the object without bleaching the rest of the scene.
        + effects.glowIntensity * 0.75;
    } else {
      material.emissive.setHex(baseline.emissive ?? 0);
      material.emissiveIntensity = baseline.emissiveIntensity ?? 0;
    }
  }
  if (changedTransparency) material.needsUpdate = true;
}

function isMeshStandardMaterial(material: THREE.Material): material is THREE.MeshStandardMaterial {
  return "emissive" in material && "emissiveIntensity" in material;
}

export function visualEffectsFromEnvironment(
  properties: Readonly<Record<string, unknown>> | undefined,
): RenderVisualEffects {
  return {
    opacity: finite(properties?.workspaceOpacity, 1),
    emissiveColor: color(properties?.workspaceEmissiveColor, "#FFFFFF"),
    emissiveIntensity: finite(properties?.workspaceEmissiveIntensity, 0),
    glowColor: color(properties?.workspaceGlowColor, "#68D5FF"),
    glowIntensity: finite(properties?.workspaceGlowIntensity, 0),
    glowSpread: finite(properties?.workspaceGlowSpread, 0.5),
  };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}
