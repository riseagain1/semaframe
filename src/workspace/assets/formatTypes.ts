import type {
  RealityAssetBounds,
  RealityAssetFormat,
  RealityAssetModel,
  RealityAssetWarningCode,
  RealityCoordinateDeclaration,
} from "./types";

export type RealityAssetFormatPreflight = Readonly<{
  format: RealityAssetFormat;
  formatVersion: number;
  mediaType: "application/x-spz" | "application/ply" | "model/vnd.sog";
  splatCount: number;
  sphericalHarmonicsDegree: 0 | 1 | 2 | 3 | 4 | null;
  model: RealityAssetModel;
  antialiased: boolean | null;
  coordinateSystem: RealityCoordinateDeclaration;
  sourceBounds?: RealityAssetBounds;
  warnings: readonly RealityAssetWarningCode[];
}>;
