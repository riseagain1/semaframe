/**
 * One authoritative classification for built-in spatial component types.
 *
 * Keeping this independent from renderer and Store implementations prevents a
 * new spatial type from rendering as a 2D card or accidentally participating
 * in collision/physics merely because one call site forgot to classify it.
 */
export type WorkspaceSpatialComponentKind =
  | "stage"
  | "asset"
  | "primitive"
  | "cad"
  | "assembly"
  | "reality";

export function spatialComponentKind(typeId: string): WorkspaceSpatialComponentKind | undefined {
  switch (typeId) {
    case "stage-3d":
      return "stage";
    case "spatial-entity":
      return "asset";
    case "spatial-primitive":
      return "primitive";
    case "cad-part":
      return "cad";
    case "model-assembly":
      return "assembly";
    case "gaussian-splat":
      return "reality";
    default:
      return undefined;
  }
}

/** Components represented in the Three.js layer, excluding the Stage basis. */
export function isSpatialRenderTypeId(typeId: string): boolean {
  const kind = spatialComponentKind(typeId);
  return kind !== undefined && kind !== "stage";
}

/** Components whose own geometry may be authoritative for collision/physics. */
export function isPhysicalSpatialTypeId(typeId: string): boolean {
  const kind = spatialComponentKind(typeId);
  return kind === "asset" || kind === "primitive" || kind === "cad";
}

/** Reality captures are visual evidence and can never be physical authority. */
export function isRealitySpatialTypeId(typeId: string): boolean {
  return spatialComponentKind(typeId) === "reality";
}
