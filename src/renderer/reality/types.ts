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

export const DEFAULT_REALITY_SPLAT_TRANSFORM: RealitySplatTransform = Object.freeze({
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  rotationRadians: Object.freeze({ x: 0, y: 0, z: 0 }),
  uniformScale: 1,
});
