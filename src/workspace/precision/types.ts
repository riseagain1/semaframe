export type PrecisionVec3 = readonly [number, number, number];
export type PrecisionTriangle = readonly [number, number, number];
export type PrecisionUnit =
  | "metre"
  | "millimetre"
  | "centimetre"
  | "inch"
  | "unknown";
export type MeasurementGeometry = Readonly<{
  geometryId: string;
  positions: readonly PrecisionVec3[];
  triangles?: readonly PrecisionTriangle[];
  units: PrecisionUnit;
  coordinateBasis: "RUB";
  source: Readonly<{ sha256: string; format: string; provenance: string }>;
}>;
export type PrecisionPointObservation = Readonly<{
  id: string;
  vertexIndex: number;
  referencePointM: PrecisionVec3;
  uncertaintyM: number | null;
  provenance: string;
  regionId: string;
}>;
export type PrecisionDimensionObservation = Readonly<{
  id: string;
  aIndex: number;
  bIndex: number;
  referenceDistanceM: number;
  uncertaintyM: number | null;
  provenance: string;
  regionId: string;
}>;
export type PrecisionStudyV1 = Readonly<{
  version: 1;
  geometry: MeasurementGeometry;
  controls: readonly PrecisionPointObservation[];
  checks: readonly PrecisionPointObservation[];
  dimensions: readonly PrecisionDimensionObservation[];
  calibration: Readonly<{ mode: "declared-units" | "rigid" | "similarity" }>;
  policy: Readonly<{
    intendedUse: string;
    toleranceM: number;
    minimumIndependentChecks: number;
    requiredRegions: readonly string[];
    uncertaintyBasis: string;
    /** Supplied conservative registration error bound over the declared check regions; never inferred from RMS. */
    registrationUncertaintyM?: number | null;
    /** Supplied scan-surface bound; independent point checks alone cannot establish it. */
    surfaceUncertaintyM?: number | null;
    surfaceUncertaintyBasis?: string;
  }>;
  referenceSurface?: Readonly<{
    geometry: MeasurementGeometry;
    uncertaintyM: number | null;
    provenance: string;
  }>;
}>;
export type PrecisionStatus =
  | "unverified"
  | "pass_for_scope"
  | "fail"
  | "inconclusive";
export type PrecisionTransform = Readonly<{
  scale: number;
  rotation: readonly PrecisionVec3[];
  translation: PrecisionVec3;
  fitRmsM: number;
  fitMaximumResidualM: number;
  controlCount: number;
}>;
export type PrecisionCheckResult = Readonly<{
  id: string;
  kind: "point" | "dimension" | "surface";
  errorM: number;
  uncertaintyM: number | null;
  conservativeErrorM: number | null;
  status: "pass" | "fail" | "inconclusive";
}>;
export type PrecisionReport = Readonly<{
  version: 1;
  evaluatorVersion: "precision-v1";
  dependencyDigest: string;
  status: PrecisionStatus;
  intendedUse: string;
  toleranceM: number;
  transform: PrecisionTransform | null;
  checks: readonly PrecisionCheckResult[];
  reasons: readonly string[];
  verifiedRegions: readonly string[];
  scope: "declared-independent-observations-only";
  limitations: readonly string[];
}>;
export const PRECISION_LIMITS = Object.freeze({
  maximumVertices: 25_000,
  maximumTriangles: 50_000,
  maximumObservations: 256,
  maximumSurfaceComparisons: 2_000_000,
  maximumCoordinateMagnitude: 1e9,
});
