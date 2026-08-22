/** Mirrors the canonical host RealityAsset format/version identifiers. */
export type RealityAssetFormat = "ply" | "spz-v4" | "sog-v2";

export type RealityVector3 = Readonly<{
  x: number;
  y: number;
  z: number;
}>;

export type RealityBounds = Readonly<{
  min: RealityVector3;
  max: RealityVector3;
}>;

/**
 * Renderer-safe projection of a host-owned RealityAsset descriptor.
 *
 * This deliberately excludes local paths, upload tokens, mutable URLs, and
 * arbitrary source metadata. The renderer only needs immutable identity and
 * bounded spatial facts that were already validated by the host import path.
 */
export type RealityAssetRenderDescriptor = Readonly<{
  assetId: string;
  digest: string;
  format: RealityAssetFormat;
  byteLength: number;
  splatCount: number;
  bounds: RealityBounds;
}>;

export type RealitySplatQuality = "auto" | "low" | "medium" | "high";

export type RealitySplatTransform = Readonly<{
  position: RealityVector3;
  rotationRadians: RealityVector3;
  uniformScale: number;
}>;

export type RealitySplatInstanceDescriptor = Readonly<{
  instanceId: string;
  entityId?: string;
  asset: RealityAssetRenderDescriptor;
  transform?: RealitySplatTransform;
  visible?: boolean;
  opacity?: number;
  quality?: RealitySplatQuality;
}>;

export type RealitySplatLoadRequest = Readonly<{
  instance: RealitySplatInstanceDescriptor;
  bytes: Uint8Array | ArrayBuffer;
  /** Re-reads the immutable asset from AssetVault after WebGL context loss. */
  reloadBytes?: () => Promise<Uint8Array | ArrayBuffer>;
}>;

export type RealitySplatRuntimeStatus =
  | { kind: "module-loading" }
  | { kind: "provider-ready" }
  | { kind: "instance-loading"; instanceId: string; loadedBytes?: number; totalBytes: number }
  | { kind: "instance-ready"; instanceId: string; splatCount: number }
  | { kind: "instance-cancelled"; instanceId: string }
  | { kind: "instance-removed"; instanceId: string }
  | { kind: "context-lost" }
  | { kind: "context-restoring" }
  | { kind: "context-restored" }
  | { kind: "error"; instanceId?: string; message: string }
  | { kind: "disposed" };

export type RealitySplatRuntimeSnapshot = Readonly<{
  disposed: boolean;
  contextLost: boolean;
  providerLoaded: boolean;
  instanceIds: readonly string[];
  pendingInstanceIds: readonly string[];
}>;

/**
 * One visual-surface hit returned by Spark's bounded LOD raycast index.
 *
 * `worldPoint` is in the live Three.js render coordinate system. `sourcePoint`
 * is the same hit transformed back into the immutable capture coordinate
 * system, before Workspace placement, calibration scale, or axis conversion.
 */
export type RealitySplatSurfaceHit = Readonly<{
  worldPoint: RealityVector3;
  sourcePoint: RealityVector3;
  cameraDistance: number;
  fidelity: "gaussian-lod";
}>;

export type RealityMeasurementPoint = Readonly<{
  sourcePoint: RealityVector3;
  /** Floating-origin-safe Workspace world coordinates. */
  worldPoint: RealityVector3;
  cameraDistance: number;
  fidelity: "gaussian-lod";
}>;

type RealityMeasurementSubject = Readonly<{
  componentId: string;
  assetId: string;
  assetDigest: string;
  sessionId: number;
}>;

export type RealityMeasurementEvent = RealityMeasurementSubject & (
  | Readonly<{
      kind: "started";
    }>
  | Readonly<{
      kind: "point";
      pointIndex: 1 | 2;
      point: RealityMeasurementPoint;
    }>
  | Readonly<{
      kind: "complete";
      points: readonly [RealityMeasurementPoint, RealityMeasurementPoint];
      sourceDistance: number;
      displayedDistance: number;
      fidelity: "gaussian-lod";
    }>
  | Readonly<{
      kind: "miss";
      pickedPoints: 0 | 1;
      message: string;
    }>
  | Readonly<{
      kind: "cancelled";
    }>
);

export const DEFAULT_REALITY_SPLAT_TRANSFORM: RealitySplatTransform = Object.freeze({
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  rotationRadians: Object.freeze({ x: 0, y: 0, z: 0 }),
  uniformScale: 1,
});
