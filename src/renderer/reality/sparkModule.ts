import type * as THREE from "three";

export type SparkFileType = "ply" | "spz" | "pcsogszip";

export interface SparkRendererLike extends THREE.Object3D {
  dispose(): void;
  setDirty(): void;
}

export interface SparkSplatMeshLike extends THREE.Object3D {
  initialized: Promise<SparkSplatMeshLike>;
  isInitialized: boolean;
  opacity: number;
  raycastable: boolean;
  enableLod?: boolean;
  lodScale: number;
  dispose(): void;
}

export type SparkModuleLike = Readonly<{
  SparkRenderer: new (options: {
    renderer: THREE.WebGLRenderer;
    onDirty?: () => void;
    enableLod?: boolean;
    lodSplatCount?: number;
    transparent?: boolean;
    depthTest?: boolean;
    depthWrite?: boolean;
  }) => SparkRendererLike;
  SplatMesh: new (options: {
    fileBytes: Uint8Array | ArrayBuffer;
    fileType: SparkFileType;
    fileName: string;
    editable: boolean;
    raycastable: boolean;
    lod: boolean;
    enableLod: boolean;
    lodScale: number;
    onProgress?: (event: ProgressEvent) => void;
  }) => SparkSplatMeshLike;
  SplatFileType: Readonly<{
    PLY: "ply";
    SPZ: "spz";
    PCSOGSZIP: "pcsogszip";
  }>;
}>;

export type SparkModuleLoader = () => Promise<SparkModuleLike>;

/** Kept behind a dynamic import so an ordinary Workspace never downloads Spark. */
export const loadSparkModule: SparkModuleLoader = async () =>
  await import("@sparkjsdev/spark") as unknown as SparkModuleLike;
