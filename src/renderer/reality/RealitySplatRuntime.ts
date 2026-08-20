import * as THREE from "three";
import { RealitySplatBoundsProxy } from "./RealitySplatBoundsProxy";
import {
  loadSparkModule,
  type SparkFileType,
  type SparkModuleLike,
  type SparkModuleLoader,
  type SparkRendererLike,
  type SparkSplatMeshLike,
} from "./sparkModule";
import {
  DEFAULT_REALITY_SPLAT_TRANSFORM,
  type RealityAssetFormat,
  type RealitySplatInstanceDescriptor,
  type RealitySplatLoadRequest,
  type RealitySplatQuality,
  type RealitySplatRuntimeSnapshot,
  type RealitySplatRuntimeStatus,
} from "./types";

export type RealitySplatRuntimeOptions = Readonly<{
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  moduleLoader?: SparkModuleLoader;
  onStatus?: (status: RealitySplatRuntimeStatus) => void;
  requestRender?: () => void;
  lodSplatCount?: number;
}>;

export type RealitySplatHandle = Readonly<{
  instanceId: string;
  root: THREE.Group;
  selectionObject: THREE.Object3D;
}>;

type InstanceRecord = {
  descriptor: RealitySplatInstanceDescriptor;
  root: THREE.Group;
  splat: SparkSplatMeshLike;
  boundsProxy: RealitySplatBoundsProxy;
  reloadBytes?: () => Promise<Uint8Array | ArrayBuffer>;
};

type ContextRestoreRecord = Pick<InstanceRecord, "descriptor" | "reloadBytes">;

type PendingLoadRecord = Readonly<{
  controller: AbortController;
  generation: number;
}>;

const QUALITY_LOD_SCALE: Record<RealitySplatQuality, number> = {
  auto: 1,
  low: 0.35,
  medium: 0.65,
  high: 1,
};
const MAX_REALITY_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_REALITY_SPLAT_COUNT = 4_000_000;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

/**
 * Isolated Spark runtime for Gaussian splat layers.
 *
 * The class owns only ephemeral Three/Spark resources. Durable asset bytes and
 * descriptors remain host-owned, and callers may throw this runtime away at
 * any time without changing Workspace state.
 */
export class RealitySplatRuntime {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly moduleLoader: SparkModuleLoader;
  private readonly onStatus?: (status: RealitySplatRuntimeStatus) => void;
  private readonly requestRender?: () => void;
  private readonly lodSplatCount: number;
  private readonly instances = new Map<string, InstanceRecord>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Set<string>();
  private readonly pendingLoads = new Map<string, PendingLoadRecord>();
  private modulePromise: Promise<SparkModuleLike> | null = null;
  private sparkModule: SparkModuleLike | null = null;
  private provider: SparkRendererLike | null = null;
  private disposed = false;
  private contextLost = false;
  private readonly contextRestoreQueue = new Map<string, ContextRestoreRecord>();
  private lifecycleGeneration = 0;

  constructor(options: RealitySplatRuntimeOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.moduleLoader = options.moduleLoader ?? loadSparkModule;
    this.onStatus = options.onStatus;
    this.requestRender = options.requestRender;
    this.lodSplatCount = clampInteger(options.lodSplatCount ?? 2_500_000, 100_000, 4_000_000);
  }

  snapshot(): RealitySplatRuntimeSnapshot {
    return {
      disposed: this.disposed,
      contextLost: this.contextLost,
      providerLoaded: this.provider !== null,
      instanceIds: [...this.instances.keys()].sort(),
      pendingInstanceIds: [...this.pending].sort(),
    };
  }

  async load(request: RealitySplatLoadRequest, signal?: AbortSignal): Promise<RealitySplatHandle> {
    this.assertUsable();
    validateLoadRequest(request);
    throwIfAborted(signal);
    if (this.contextLost) throw abortError("Reality splat loading is paused while WebGL context is lost.");

    const { instance } = request;
    this.cancelPendingLoad(instance.instanceId);
    const generation = (this.generations.get(instance.instanceId) ?? 0) + 1;
    this.generations.set(instance.instanceId, generation);
    const controller = new AbortController();
    this.pendingLoads.set(instance.instanceId, { controller, generation });
    this.pending.add(instance.instanceId);
    this.emit({
      kind: "instance-loading",
      instanceId: instance.instanceId,
      totalBytes: instance.asset.byteLength,
      loadedBytes: 0,
    });

    let splat: SparkSplatMeshLike | null = null;
    let boundsProxy: RealitySplatBoundsProxy | null = null;
    let root: THREE.Group | null = null;
    try {
      const spark = await raceAbort(this.ensureSparkModule(), signal, controller.signal);
      this.assertCurrent(instance.instanceId, generation, signal, controller.signal);
      this.ensureProvider(spark);
      const quality = instance.quality ?? "auto";
      splat = new spark.SplatMesh({
        fileBytes: request.bytes,
        fileType: splatFileType(spark, instance.asset.format),
        fileName: `${instance.asset.assetId}.${fileExtension(instance.asset.format)}`,
        editable: false,
        raycastable: false,
        lod: true,
        enableLod: true,
        lodScale: QUALITY_LOD_SCALE[quality],
        onProgress: (event) => {
          if (!this.isCurrent(instance.instanceId, generation) || signal?.aborted) return;
          const loadedBytes = Number.isFinite(event.loaded)
            ? Math.min(instance.asset.byteLength, Math.max(0, Math.round(event.loaded)))
            : undefined;
          this.emit({
            kind: "instance-loading",
            instanceId: instance.instanceId,
            totalBytes: instance.asset.byteLength,
            ...(loadedBytes === undefined ? {} : { loadedBytes }),
          });
        },
      });
      splat.name = `reality-splat:${instance.instanceId}`;
      splat.userData.realityAssetId = instance.asset.assetId;
      splat.userData.realityAssetDigest = instance.asset.digest;
      splat.raycastable = false;

      root = new THREE.Group();
      root.name = `reality-layer:${instance.instanceId}`;
      root.userData.realityInstanceId = instance.instanceId;
      root.userData.realityAssetId = instance.asset.assetId;
      root.userData.engineeringAuthority = "visual_only";
      if (instance.entityId) root.userData.entityId = instance.entityId;
      root.add(splat);
      boundsProxy = new RealitySplatBoundsProxy(instance.asset.bounds, instance.entityId);
      root.add(boundsProxy);
      applyDescriptor(root, splat, instance);

      await raceAbort(splat.initialized, signal, controller.signal);
      this.assertCurrent(instance.instanceId, generation, signal, controller.signal);
      if (!splat.isInitialized) {
        throw new Error("Spark completed without initializing the Gaussian splat mesh.");
      }
      const previous = this.instances.get(instance.instanceId);
      if (previous) this.disposeRecord(previous);
      this.scene.add(root);
      const record: InstanceRecord = {
        descriptor: instance,
        root,
        splat,
        boundsProxy,
        ...(request.reloadBytes ? { reloadBytes: request.reloadBytes } : {}),
      };
      this.instances.set(instance.instanceId, record);
      this.pending.delete(instance.instanceId);
      this.emit({
        kind: "instance-ready",
        instanceId: instance.instanceId,
        splatCount: instance.asset.splatCount,
      });
      this.provider?.setDirty();
      this.requestRender?.();
      return {
        instanceId: instance.instanceId,
        root,
        selectionObject: boundsProxy.hitTarget,
      };
    } catch (error) {
      const aborted = isAbortError(error)
        || signal?.aborted
        || controller.signal.aborted
        || !this.isCurrent(instance.instanceId, generation);
      if (root) root.removeFromParent();
      if (boundsProxy) boundsProxy.dispose();
      if (splat) disposeSplatAfterInitialization(splat);
      if (this.isCurrent(instance.instanceId, generation)) this.pending.delete(instance.instanceId);
      if (aborted) {
        this.emit({ kind: "instance-cancelled", instanceId: instance.instanceId });
        throw abortError();
      }
      const message = error instanceof Error ? error.message : "Gaussian splat rendering failed.";
      this.emit({ kind: "error", instanceId: instance.instanceId, message });
      throw error;
    } finally {
      const pendingLoad = this.pendingLoads.get(instance.instanceId);
      if (pendingLoad?.controller === controller) this.pendingLoads.delete(instance.instanceId);
    }
  }

  update(instance: RealitySplatInstanceDescriptor): void {
    this.assertUsable();
    validateInstanceDescriptor(instance);
    const record = this.instances.get(instance.instanceId);
    const restoreRecord = this.contextRestoreQueue.get(instance.instanceId);
    if (!record && restoreRecord) {
      if (restoreRecord.descriptor.asset.digest !== instance.asset.digest) {
        throw new Error("Changing a RealityAsset digest requires an atomic load replacement.");
      }
      restoreRecord.descriptor = instance;
      return;
    }
    if (!record) throw new Error(`Reality splat instance ${instance.instanceId} is not loaded.`);
    if (record.descriptor.asset.digest !== instance.asset.digest) {
      throw new Error("Changing a RealityAsset digest requires an atomic load replacement.");
    }
    record.descriptor = instance;
    applyDescriptor(record.root, record.splat, instance);
    this.provider?.setDirty();
    this.requestRender?.();
  }

  setSelected(instanceId: string, selected: boolean): void {
    this.instances.get(instanceId)?.boundsProxy.setSelected(selected);
    this.requestRender?.();
  }

  getHandle(instanceId: string): RealitySplatHandle | undefined {
    const record = this.instances.get(instanceId);
    if (!record) return undefined;
    return {
      instanceId,
      root: record.root,
      selectionObject: record.boundsProxy.hitTarget,
    };
  }

  remove(instanceId: string): boolean {
    const generation = (this.generations.get(instanceId) ?? 0) + 1;
    this.generations.set(instanceId, generation);
    this.cancelPendingLoad(instanceId);
    this.pending.delete(instanceId);
    const restoreRemoved = this.contextRestoreQueue.delete(instanceId);
    const record = this.instances.get(instanceId);
    if (!record) {
      if (restoreRemoved) this.emit({ kind: "instance-removed", instanceId });
      return restoreRemoved;
    }
    this.instances.delete(instanceId);
    this.disposeRecord(record);
    this.provider?.setDirty();
    this.emit({ kind: "instance-removed", instanceId });
    this.requestRender?.();
    return true;
  }

  handleContextLost(event?: Event): void {
    event?.preventDefault();
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    for (const instanceId of this.pending) this.invalidatePendingLoad(instanceId);
    this.pending.clear();
    // Do not clear records that have not finished a previous restoration. A
    // second loss during recovery must retain both the not-yet-restored records
    // and the instances that already made it onto the replacement context.
    for (const record of this.instances.values()) {
      this.contextRestoreQueue.set(record.descriptor.instanceId, {
        descriptor: record.descriptor,
        ...(record.reloadBytes ? { reloadBytes: record.reloadBytes } : {}),
      });
    }
    for (const record of this.instances.values()) this.disposeRecord(record);
    this.instances.clear();
    // Dispose while the context is already lost. Waiting until the restoration
    // callback makes Three delete invalid handles from the old context.
    this.provider?.removeFromParent();
    this.provider?.dispose();
    this.provider = null;
    this.emit({ kind: "context-lost" });
  }

  /**
   * Recreates Spark resources from the immutable AssetVault bytes after WebGL
   * restoration. Spark's old DataTextures belong to the lost context and cannot
   * be reused reliably; no large binary is retained by this runtime itself.
   */
  async handleContextRestored(): Promise<void> {
    if (this.disposed || !this.contextLost) return;
    this.emit({ kind: "context-restoring" });
    this.contextLost = false;
    try {
      for (const instanceId of [...this.contextRestoreQueue.keys()]) {
        if (this.disposed || this.contextLost) return;
        const record = this.contextRestoreQueue.get(instanceId);
        if (!record) continue;
        if (!record.reloadBytes) {
          this.emit({
            kind: "error",
            instanceId: record.descriptor.instanceId,
            message: "Reality asset cannot recover because no AssetVault byte provider was supplied.",
          });
          if (this.contextRestoreQueue.get(instanceId) === record) {
            this.contextRestoreQueue.delete(instanceId);
          }
          continue;
        }
        const generation = this.generations.get(instanceId) ?? 0;
        try {
          const bytes = await record.reloadBytes();
          if (this.disposed || this.contextLost) return;
          if (this.contextRestoreQueue.get(instanceId) !== record
            || (this.generations.get(instanceId) ?? 0) !== generation) continue;
          await this.load({ instance: record.descriptor, bytes, reloadBytes: record.reloadBytes });
          // Presentation-only updates may arrive while Spark initializes. Apply
          // the latest descriptor retained by the addressable restore record
          // before declaring recovery complete.
          if (this.contextRestoreQueue.get(instanceId) === record) {
            this.update(record.descriptor);
          }
          if (this.contextRestoreQueue.get(instanceId) === record) {
            this.contextRestoreQueue.delete(instanceId);
          }
        } catch (error) {
          if (this.disposed || this.contextLost) return;
          // Removal/replacement intentionally cancels the old restoration. It
          // is not an asset failure and must not surface a stale error.
          if (this.contextRestoreQueue.get(instanceId) !== record) continue;
          if (isAbortError(error)) {
            this.contextRestoreQueue.delete(instanceId);
            continue;
          }
          this.contextRestoreQueue.delete(instanceId);
          const message = error instanceof Error ? error.message : "Reality asset could not reload after context restoration.";
          this.emit({ kind: "error", instanceId: record.descriptor.instanceId, message });
        }
      }
      this.emit({ kind: "context-restored" });
      this.requestRender?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Spark could not recover after WebGL restoration.";
      this.emit({ kind: "error", message });
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    for (const instanceId of this.pending) this.invalidatePendingLoad(instanceId);
    this.pending.clear();
    this.pendingLoads.clear();
    for (const record of this.instances.values()) this.disposeRecord(record);
    this.instances.clear();
    this.contextRestoreQueue.clear();
    this.provider?.removeFromParent();
    this.provider?.dispose();
    this.provider = null;
    this.sparkModule = null;
    this.modulePromise = null;
    this.emit({ kind: "disposed" });
  }

  private async ensureSparkModule(): Promise<SparkModuleLike> {
    this.assertUsable();
    if (this.sparkModule) return this.sparkModule;
    const lifecycleGeneration = this.lifecycleGeneration;
    if (!this.modulePromise) {
      this.emit({ kind: "module-loading" });
      this.modulePromise = this.moduleLoader().catch((error) => {
        this.modulePromise = null;
        throw error;
      });
    }
    const spark = await this.modulePromise;
    if (this.disposed || lifecycleGeneration !== this.lifecycleGeneration) throw abortError();
    this.sparkModule = spark;
    return spark;
  }

  private ensureProvider(spark: SparkModuleLike): void {
    if (this.provider) return;
    const provider = new spark.SparkRenderer({
      renderer: this.renderer,
      onDirty: this.requestRender,
      enableLod: true,
      lodSplatCount: this.lodSplatCount,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    provider.name = "semaframe-reality-spark-provider";
    provider.userData.semaframeRuntime = "gaussian-splat";
    this.scene.add(provider);
    this.provider = provider;
    this.emit({ kind: "provider-ready" });
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("RealitySplatRuntime has been disposed.");
  }

  private isCurrent(instanceId: string, generation: number): boolean {
    return !this.disposed && this.generations.get(instanceId) === generation;
  }

  private assertCurrent(
    instanceId: string,
    generation: number,
    signal?: AbortSignal,
    internalSignal?: AbortSignal,
  ): void {
    throwIfAborted(signal, internalSignal);
    if (!this.isCurrent(instanceId, generation)) throw abortError();
  }

  private invalidatePendingLoad(instanceId: string): void {
    this.generations.set(instanceId, (this.generations.get(instanceId) ?? 0) + 1);
    this.cancelPendingLoad(instanceId);
  }

  private cancelPendingLoad(instanceId: string): void {
    const pendingLoad = this.pendingLoads.get(instanceId);
    pendingLoad?.controller.abort();
    if (this.pendingLoads.get(instanceId) === pendingLoad) this.pendingLoads.delete(instanceId);
  }

  private disposeRecord(record: InstanceRecord): void {
    record.root.removeFromParent();
    record.boundsProxy.dispose();
    record.splat.removeFromParent();
    record.splat.dispose();
    record.root.clear();
  }

  private emit(status: RealitySplatRuntimeStatus): void {
    this.onStatus?.(status);
  }

}

function applyDescriptor(
  root: THREE.Group,
  splat: SparkSplatMeshLike,
  instance: RealitySplatInstanceDescriptor,
): void {
  const transform = instance.transform ?? DEFAULT_REALITY_SPLAT_TRANSFORM;
  root.position.set(transform.position.x, transform.position.y, transform.position.z);
  root.rotation.set(
    transform.rotationRadians.x,
    transform.rotationRadians.y,
    transform.rotationRadians.z,
    "XYZ",
  );
  root.scale.setScalar(transform.uniformScale);
  root.visible = instance.visible ?? true;
  splat.opacity = clamp(instance.opacity ?? 1, 0, 1);
  splat.enableLod = true;
  splat.lodScale = QUALITY_LOD_SCALE[instance.quality ?? "auto"];
}

function validateLoadRequest(request: RealitySplatLoadRequest): void {
  validateInstanceDescriptor(request.instance);
  const byteLength = request.bytes.byteLength;
  if (byteLength !== request.instance.asset.byteLength) {
    throw new Error(`Reality asset byte length mismatch: expected ${request.instance.asset.byteLength}, got ${byteLength}.`);
  }
}

function validateInstanceDescriptor(instance: RealitySplatInstanceDescriptor): void {
  if (!INSTANCE_ID_PATTERN.test(instance.instanceId)) {
    throw new Error("Reality splat instanceId is not a valid Workspace component identifier.");
  }
  const { asset } = instance;
  if (!asset.assetId || !asset.digest) throw new Error("Reality asset identity is required.");
  if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > MAX_REALITY_ASSET_BYTES) {
    throw new Error(`Reality asset byteLength must be between 1 and ${MAX_REALITY_ASSET_BYTES}.`);
  }
  if (!Number.isSafeInteger(asset.splatCount) || asset.splatCount <= 0 || asset.splatCount > MAX_REALITY_SPLAT_COUNT) {
    throw new Error(`Reality asset splatCount must be between 1 and ${MAX_REALITY_SPLAT_COUNT}.`);
  }
  const bounds = asset.bounds;
  const boundsValues = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z];
  if (!boundsValues.every(Number.isFinite)
    || bounds.min.x > bounds.max.x
    || bounds.min.y > bounds.max.y
    || bounds.min.z > bounds.max.z) {
    throw new Error("Reality asset bounds must be finite and ordered.");
  }
  const transform = instance.transform ?? DEFAULT_REALITY_SPLAT_TRANSFORM;
  const transformValues = [
    transform.position.x,
    transform.position.y,
    transform.position.z,
    transform.rotationRadians.x,
    transform.rotationRadians.y,
    transform.rotationRadians.z,
    transform.uniformScale,
  ];
  if (!transformValues.every(Number.isFinite) || transform.uniformScale <= 0) {
    throw new Error("Reality splat transform must be finite with a positive uniform scale.");
  }
  if (instance.opacity !== undefined && (!Number.isFinite(instance.opacity) || instance.opacity < 0 || instance.opacity > 1)) {
    throw new Error("Reality splat opacity must be between 0 and 1.");
  }
}

function splatFileType(spark: SparkModuleLike, format: RealityAssetFormat): SparkFileType {
  if (format === "ply") return spark.SplatFileType.PLY;
  if (format === "spz-v4") return spark.SplatFileType.SPZ;
  return spark.SplatFileType.PCSOGSZIP;
}

function fileExtension(format: RealityAssetFormat): string {
  if (format === "spz-v4") return "spz";
  if (format === "sog-v2") return "sog.zip";
  return format;
}

async function raceAbort<T>(
  promise: Promise<T>,
  ...signals: Array<AbortSignal | undefined>
): Promise<T> {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  throwIfAborted(...activeSignals);
  if (activeSignals.length === 0) return await promise;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      for (const signal of activeSignals) signal.removeEventListener("abort", abort);
    };
    const settle = (callback: (value: T | PromiseLike<T>) => void, value: T | PromiseLike<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(abortError());
    for (const signal of activeSignals) signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => settle(resolve, value), fail);
  });
}

function disposeSplatAfterInitialization(splat: SparkSplatMeshLike): void {
  splat.removeFromParent();
  // Spark 2.1's dispose() is field-guarded and safe before initialization. An
  // immediate call releases constructor-time buffers even when initialization
  // never settles; a second call handles resources produced by a late worker.
  splat.dispose();
  void splat.initialized.then(
    () => splat.dispose(),
    () => splat.dispose(),
  );
}

function throwIfAborted(...signals: Array<AbortSignal | undefined>): void {
  if (signals.some((signal) => signal?.aborted)) throw abortError();
}

function abortError(message = "Reality splat loading was cancelled."): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.round(clamp(Number.isFinite(value) ? value : min, min, max));
}
