import {
  BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS,
  type ComponentManifest,
  type JSONObject,
} from "../../../workspace/components";
import type { ParametricPrimitive } from "../../../workspace/modeling";
import type { ComponentLibraryItem } from "./WorkspaceComponentLibrary";

const PRIMITIVE_COPY: Readonly<Record<ParametricPrimitive["kind"], Readonly<{
  displayName: string;
  description: string;
}>>> = Object.freeze({
  box: Object.freeze({ displayName: "Box", description: "Exact width, height, and depth" }),
  sphere: Object.freeze({ displayName: "Sphere", description: "Exact radius with analytic bounds" }),
  cylinder: Object.freeze({ displayName: "Cylinder", description: "Exact radius, height, and axis" }),
  cone: Object.freeze({ displayName: "Cone", description: "Exact base radius, height, and axis" }),
  capsule: Object.freeze({ displayName: "Capsule", description: "Exact radius, cylinder length, and axis" }),
  plane: Object.freeze({ displayName: "Plane", description: "Exact two-axis surface dimensions" }),
});

export type ComponentCatalogOptions = Readonly<{
  hasStage: boolean;
}>;

function normalDescription(manifest: ComponentManifest): string {
  if (manifest.typeId === "video-player") return "Play YouTube, Vimeo, or direct HTTPS media";
  if (manifest.typeId === "web-panel") return "Embed an HTTPS website after explicit approval";
  if (manifest.typeId === "data-panel") return "Display JSON, CSV, RSS, or Atom feed data";
  if (manifest.typeId === "model-assembly") return "Collect editable 3D parts under one transform root";
  return `${manifest.allowedPlacements.join(" · ")} · ${manifest.trustTier}`;
}

function primitiveItems(manifest: ComponentManifest): ComponentLibraryItem[] {
  return (Object.keys(BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS) as ParametricPrimitive["kind"][])
    .map((kind) => ({
      libraryId: `${manifest.typeId}:${kind}`,
      typeId: manifest.typeId,
      displayName: PRIMITIVE_COPY[kind].displayName,
      description: PRIMITIVE_COPY[kind].description,
      placements: manifest.allowedPlacements,
      trustTier: manifest.trustTier,
      configureOnCreate: true,
      badge: "Parametric",
      creation: {
        label: PRIMITIVE_COPY[kind].displayName,
        props: {
          geometry: structuredClone(BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS[kind]) as unknown as JSONObject,
        },
      },
    }));
}

/**
 * Projects one manifest per type into a creation palette. Parametric
 * primitives expand into six exact presets. Published models remain ordinary
 * model-assembly trees so every instance is inspectable and editable.
 */
export function buildWorkspaceComponentCatalog(
  manifests: readonly ComponentManifest[],
  options: ComponentCatalogOptions,
): ComponentLibraryItem[] {
  return manifests.flatMap((manifest) => {
    if (manifest.typeId === "stage-3d" && options.hasStage) return [];
    if (manifest.typeId === "spatial-primitive") return primitiveItems(manifest);
    return [{
      libraryId: manifest.typeId,
      typeId: manifest.typeId,
      displayName: manifest.displayName,
      description: normalDescription(manifest),
      placements: manifest.allowedPlacements,
      trustTier: manifest.trustTier,
      configureOnCreate: manifest.typeId === "video-player"
        || manifest.typeId === "web-panel"
        || manifest.typeId === "model-assembly",
    }];
  });
}
