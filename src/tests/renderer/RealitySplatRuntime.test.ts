import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { RealitySplatRuntime } from "../../renderer/reality/RealitySplatRuntime";
import type {
  SparkModuleLike,
  SparkRendererLike,
  SparkSplatMeshLike,
} from "../../renderer/reality/sparkModule";
import type {
  RealitySplatInstanceDescriptor,
  RealitySplatRuntimeStatus,
} from "../../renderer/reality/types";

type ProviderOptions = ConstructorParameters<SparkModuleLike["SparkRenderer"]>[0];
type MeshOptions = ConstructorParameters<SparkModuleLike["SplatMesh"]>[0];

class FakeSparkRenderer extends THREE.Group implements SparkRendererLike {
  static instances: FakeSparkRenderer[] = [];
  readonly options: ProviderOptions;
  disposed = false;
  dirtyCalls = 0;

  constructor(options: ProviderOptions) {
    super();
    this.options = options;
    FakeSparkRenderer.instances.push(this);
  }

  setDirty(): void {
    this.dirtyCalls += 1;
    this.options.onDirty?.();
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeSplatMesh extends THREE.Group implements SparkSplatMeshLike {
  static instances: FakeSplatMesh[] = [];
  readonly options: MeshOptions;
  initialized: Promise<SparkSplatMeshLike>;
  isInitialized = false;
  opacity = 1;
  raycastable = true;
  enableLod?: boolean;
  lodScale = 1;
  disposed = false;

  constructor(options: MeshOptions) {
    super();
    this.options = options;
    this.enableLod = options.enableLod;
    this.lodScale = options.lodScale;
    FakeSplatMesh.instances.push(this);
    options.onProgress?.({ loaded: options.fileBytes.byteLength } as ProgressEvent);
    this.initialized = Promise.resolve().then(() => {
      this.isInitialized = true;
      return this;
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}

const fakeModule: SparkModuleLike = {
  SparkRenderer: FakeSparkRenderer,
  SplatMesh: FakeSplatMesh,
  SplatFileType: {
    PLY: "ply",
    SPZ: "spz",
    PCSOGSZIP: "pcsogszip",
  },
};

function instance(
  instanceId: string,
  patch: Partial<RealitySplatInstanceDescriptor> = {},
): RealitySplatInstanceDescriptor {
  return {
    instanceId,
    entityId: `ENTITY_${instanceId}`,
    asset: {
      assetId: `asset_${instanceId}`,
      digest: `sha256:${instanceId}`,
      format: "spz-v4",
      byteLength: 4,
      splatCount: 1_000,
      bounds: {
        min: { x: -1, y: 0, z: -2 },
        max: { x: 1, y: 4, z: 2 },
      },
    },
    ...patch,
  };
}

function runtime(options: {
  moduleLoader?: () => Promise<SparkModuleLike>;
  statuses?: RealitySplatRuntimeStatus[];
  requestRender?: () => void;
} = {}): { scene: THREE.Scene; value: RealitySplatRuntime } {
  const scene = new THREE.Scene();
  return {
    scene,
    value: new RealitySplatRuntime({
      renderer: {} as THREE.WebGLRenderer,
      scene,
      moduleLoader: options.moduleLoader ?? (async () => fakeModule),
      onStatus: (status) => options.statuses?.push(status),
      requestRender: options.requestRender,
    }),
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("RealitySplatRuntime", () => {
  it("keeps Spark lazy, shares one depth-aware provider, and uses bounds for selection", async () => {
    FakeSparkRenderer.instances = [];
    FakeSplatMesh.instances = [];
    const moduleLoader = vi.fn(async () => fakeModule);
    const requestRender = vi.fn();
    const { scene, value } = runtime({ moduleLoader, requestRender });

    expect(moduleLoader).not.toHaveBeenCalled();
    expect(value.snapshot()).toEqual({
      disposed: false,
      contextLost: false,
      providerLoaded: false,
      instanceIds: [],
      pendingInstanceIds: [],
    });

    const first = await value.load({ instance: instance("one"), bytes: new Uint8Array(4) });
    const second = await value.load({
      instance: instance("two", { quality: "low", opacity: 0.4 }),
      bytes: new Uint8Array(4),
    });

    expect(moduleLoader).toHaveBeenCalledTimes(1);
    expect(FakeSparkRenderer.instances).toHaveLength(1);
    expect(FakeSparkRenderer.instances[0]?.options).toMatchObject({
      enableLod: true,
      lodSplatCount: 2_500_000,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    expect(FakeSplatMesh.instances).toHaveLength(2);
    expect(FakeSplatMesh.instances[0]?.options.raycastable).toBe(false);
    expect(FakeSplatMesh.instances[1]?.lodScale).toBe(0.35);
    expect(FakeSplatMesh.instances[1]?.opacity).toBe(0.4);
    expect(first.root.userData.engineeringAuthority).toBe("visual_only");
    expect(first.selectionObject.userData.entityId).toBe("ENTITY_one");
    expect(scene.getObjectByName("semaframe-reality-spark-provider")).toBeTruthy();
    expect(scene.getObjectByName("reality-layer:one")).toBe(first.root);
    expect(scene.getObjectByName("reality-layer:two")).toBe(second.root);

    value.setSelected("one", true);
    expect(first.root.getObjectByName("reality-splat-bounds-outline")?.visible).toBe(true);
    value.setSelected("one", false);
    expect(first.root.getObjectByName("reality-splat-bounds-outline")?.visible).toBe(false);
    expect(requestRender).toHaveBeenCalled();
  });

  it("routes a live Apple Gaussian PLY instance through Spark's PLY loader", async () => {
    FakeSparkRenderer.instances = [];
    FakeSplatMesh.instances = [];
    const { value } = runtime();
    const source = instance("apple-ply");

    const handle = await value.load({
      instance: {
        ...source,
        asset: { ...source.asset, format: "ply" },
      },
      bytes: new Uint8Array(4),
    });

    expect(handle.root.userData.realityAssetId).toBe("asset_apple-ply");
    expect(FakeSplatMesh.instances).toHaveLength(1);
    expect(FakeSplatMesh.instances[0]?.options).toMatchObject({
      fileType: fakeModule.SplatFileType.PLY,
      fileName: "asset_apple-ply.ply",
    });
  });

  it("updates transforms and rendering controls without replacing asset identity", async () => {
    const { value } = runtime();
    const original = instance("update");
    const handle = await value.load({ instance: original, bytes: new Uint8Array(4) });
    const changed: RealitySplatInstanceDescriptor = {
      ...original,
      transform: {
        position: { x: 3, y: 2, z: 1 },
        rotationRadians: { x: 0, y: Math.PI / 2, z: 0 },
        uniformScale: 2,
      },
      visible: false,
      opacity: 0.25,
      quality: "medium",
    };

    value.update(changed);
    expect(handle.root.position.toArray()).toEqual([3, 2, 1]);
    expect(handle.root.scale.toArray()).toEqual([2, 2, 2]);
    expect(handle.root.visible).toBe(false);
    const splat = FakeSplatMesh.instances.at(-1);
    expect(splat?.opacity).toBe(0.25);
    expect(splat?.lodScale).toBe(0.65);

    expect(() => value.update({
      ...changed,
      asset: { ...changed.asset, digest: "sha256:different" },
    })).toThrow("atomic load replacement");
  });

  it("temporarily enables surface raycasts, returns the nearest hit, and recovers source coordinates", async () => {
    FakeSplatMesh.instances = [];
    const descriptor = instance("surface-hit", {
      transform: {
        position: { x: 7, y: -3, z: 5 },
        rotationRadians: { x: Math.PI / 7, y: -Math.PI / 5, z: Math.PI / 9 },
        uniformScale: 2.5,
      },
    });
    const { value } = runtime();
    await value.load({ instance: descriptor, bytes: new Uint8Array(4) });
    const splat = FakeSplatMesh.instances.at(-1);
    expect(splat).toBeDefined();
    if (!splat) throw new Error("Expected the fake splat to load.");

    // Match the axis-sign correction applied to a real capture child. The
    // returned source point must be before both this transform and placement.
    splat.position.set(0.75, -0.25, 1.5);
    splat.rotation.set(-Math.PI / 8, Math.PI / 6, 0, "XYZ");
    splat.scale.set(-1, 1, -1);
    splat.updateWorldMatrix(true, true);

    const expectedSourcePoint = new THREE.Vector3(0.35, 1.2, -0.8);
    const fartherSourcePoint = new THREE.Vector3(-1.1, 0.4, 2.3);
    const expectedWorldPoint = splat.localToWorld(expectedSourcePoint.clone());
    const fartherWorldPoint = splat.localToWorld(fartherSourcePoint.clone());
    expect(splat.raycastable).toBe(false);

    splat.raycast = vi.fn((_raycaster, intersections) => {
      expect(splat.raycastable).toBe(true);
      // Deliberately return the farther hit first; Three's Raycaster owns the
      // distance ordering that the runtime consumes.
      intersections.push({
        distance: 11,
        point: fartherWorldPoint.clone(),
        object: splat,
      });
      intersections.push({
        distance: 3.25,
        point: expectedWorldPoint.clone(),
        object: splat,
      });
    });

    const hit = value.raycastSurface("surface-hit", new THREE.Raycaster());

    expect(splat.raycast).toHaveBeenCalledOnce();
    expect(splat.raycastable).toBe(false);
    expect(hit).toMatchObject({ cameraDistance: 3.25, fidelity: "gaussian-lod" });
    expect(hit?.worldPoint.x).toBeCloseTo(expectedWorldPoint.x, 8);
    expect(hit?.worldPoint.y).toBeCloseTo(expectedWorldPoint.y, 8);
    expect(hit?.worldPoint.z).toBeCloseTo(expectedWorldPoint.z, 8);
    expect(hit?.sourcePoint.x).toBeCloseTo(expectedSourcePoint.x, 8);
    expect(hit?.sourcePoint.y).toBeCloseTo(expectedSourcePoint.y, 8);
    expect(hit?.sourcePoint.z).toBeCloseTo(expectedSourcePoint.z, 8);
  });

  it("restores the prior raycastable state when Spark raycasting throws", async () => {
    FakeSplatMesh.instances = [];
    const { value } = runtime();
    await value.load({ instance: instance("surface-error"), bytes: new Uint8Array(4) });
    const splat = FakeSplatMesh.instances.at(-1);
    expect(splat).toBeDefined();
    if (!splat) throw new Error("Expected the fake splat to load.");
    const failure = new Error("synthetic Spark raycast failure");
    splat.raycast = vi.fn(() => {
      expect(splat.raycastable).toBe(true);
      throw failure;
    });

    expect(() => value.raycastSurface("surface-error", new THREE.Raycaster())).toThrow(failure);
    expect(splat.raycastable).toBe(false);
  });

  it("fails closed for no hit, hidden captures, and WebGL context loss", async () => {
    FakeSplatMesh.instances = [];
    const descriptor = instance("surface-closed");
    const { scene, value } = runtime();
    await value.load({ instance: descriptor, bytes: new Uint8Array(4) });
    const splat = FakeSplatMesh.instances.at(-1);
    expect(splat).toBeDefined();
    if (!splat) throw new Error("Expected the fake splat to load.");
    splat.raycast = vi.fn(() => undefined);
    const raycaster = new THREE.Raycaster();

    expect(value.raycastSurface("surface-closed", raycaster)).toBeUndefined();
    expect(splat.raycast).toHaveBeenCalledOnce();
    expect(splat.raycastable).toBe(false);

    value.update({ ...descriptor, visible: false });
    expect(value.raycastSurface("surface-closed", raycaster)).toBeUndefined();
    expect(splat.raycast).toHaveBeenCalledOnce();
    expect(splat.raycastable).toBe(false);

    value.update({ ...descriptor, visible: true });
    scene.visible = false;
    expect(value.raycastSurface("surface-closed", raycaster)).toBeUndefined();
    expect(splat.raycast).toHaveBeenCalledOnce();
    scene.visible = true;

    value.handleContextLost();
    expect(value.raycastSurface("surface-closed", raycaster)).toBeUndefined();
    expect(splat.raycast).toHaveBeenCalledOnce();
  });

  it("cancels before provider creation and never commits a late instance", async () => {
    let resolveModule!: (module: SparkModuleLike) => void;
    const modulePromise = new Promise<SparkModuleLike>((resolve) => { resolveModule = resolve; });
    const statuses: RealitySplatRuntimeStatus[] = [];
    const { scene, value } = runtime({ moduleLoader: async () => await modulePromise, statuses });
    const controller = new AbortController();
    const loading = value.load(
      { instance: instance("cancel"), bytes: new Uint8Array(4) },
      controller.signal,
    );

    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    resolveModule(fakeModule);
    await modulePromise;
    await Promise.resolve();

    expect(value.snapshot().instanceIds).toEqual([]);
    expect(scene.getObjectByName("reality-layer:cancel")).toBeUndefined();
    expect(scene.getObjectByName("semaframe-reality-spark-provider")).toBeUndefined();
    expect(statuses).toContainEqual({ kind: "instance-cancelled", instanceId: "cancel" });
  });

  it("rebuilds provider and splat resources from AssetVault bytes across context loss", async () => {
    FakeSparkRenderer.instances = [];
    FakeSplatMesh.instances = [];
    const statuses: RealitySplatRuntimeStatus[] = [];
    const { value } = runtime({ statuses });
    const reloadBytes = vi.fn(async () => new Uint8Array(4));
    await value.load({
      instance: instance("restore"),
      bytes: new Uint8Array(4),
      reloadBytes,
    });
    const originalProvider = FakeSparkRenderer.instances[0];

    const lostEvent = { preventDefault: vi.fn() } as unknown as Event;
    value.handleContextLost(lostEvent);
    await value.handleContextRestored();

    expect(lostEvent.preventDefault).toHaveBeenCalledOnce();
    expect(originalProvider?.disposed).toBe(true);
    expect(reloadBytes).toHaveBeenCalledOnce();
    expect(FakeSparkRenderer.instances).toHaveLength(2);
    expect(FakeSplatMesh.instances).toHaveLength(2);
    expect(value.snapshot()).toMatchObject({ contextLost: false, providerLoaded: true });
    expect(statuses.map((status) => status.kind)).toEqual(expect.arrayContaining([
      "context-lost",
      "context-restoring",
      "context-restored",
    ]));
  });

  it("does not resurrect an instance removed while its AssetVault reload is pending", async () => {
    FakeSparkRenderer.instances = [];
    FakeSplatMesh.instances = [];
    const statuses: RealitySplatRuntimeStatus[] = [];
    const { scene, value } = runtime({ statuses });
    const reloadStarted = deferred<void>();
    const releaseReload = deferred<Uint8Array>();
    await value.load({
      instance: instance("removed-during-restore"),
      bytes: new Uint8Array(4),
      reloadBytes: async () => {
        reloadStarted.resolve();
        return await releaseReload.promise;
      },
    });

    value.handleContextLost();
    const restoring = value.handleContextRestored();
    await reloadStarted.promise;
    expect(value.remove("removed-during-restore")).toBe(true);
    releaseReload.resolve(new Uint8Array(4));
    await restoring;

    expect(value.snapshot()).toMatchObject({ instanceIds: [], pendingInstanceIds: [] });
    expect(scene.getObjectByName("reality-layer:removed-during-restore")).toBeUndefined();
    expect(statuses.filter((status) => status.kind === "error")).toEqual([]);
  });

  it("actively cancels a never-settling Spark initialization on context loss", async () => {
    let neverInitializedSplat: NeverInitializedSplat | undefined;
    class NeverInitializedSplat extends THREE.Group implements SparkSplatMeshLike {
      readonly initialized = new Promise<SparkSplatMeshLike>(() => undefined);
      readonly isInitialized = false;
      opacity = 1;
      raycastable = false;
      enableLod?: boolean;
      lodScale = 1;
      disposed = false;
      constructor() {
        super();
        neverInitializedSplat = this;
      }
      dispose(): void { this.disposed = true; }
    }
    const neverModule: SparkModuleLike = {
      ...fakeModule,
      SplatMesh: NeverInitializedSplat as SparkModuleLike["SplatMesh"],
    };
    const { value } = runtime({ moduleLoader: async () => neverModule });
    const loading = value.load({
      instance: instance("pending-at-loss"),
      bytes: new Uint8Array(4),
      reloadBytes: async () => new Uint8Array(4),
    });
    await vi.waitFor(() => {
      expect(value.snapshot().pendingInstanceIds).toEqual(["pending-at-loss"]);
      expect(value.snapshot().providerLoaded).toBe(true);
    });

    value.handleContextLost();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(neverInitializedSplat?.disposed).toBe(true);
    await value.handleContextRestored();

    expect(value.snapshot()).toMatchObject({
      contextLost: false,
      providerLoaded: false,
      instanceIds: [],
      pendingInstanceIds: [],
    });
  });

  it("retains not-yet-restored records across a second context loss", async () => {
    FakeSparkRenderer.instances = [];
    FakeSplatMesh.instances = [];
    const statuses: RealitySplatRuntimeStatus[] = [];
    const { value } = runtime({ statuses });
    const firstReloadStarted = deferred<void>();
    const releaseFirstReload = deferred<Uint8Array>();
    let firstReloadCount = 0;
    const firstReload = vi.fn(async () => {
      firstReloadCount += 1;
      if (firstReloadCount === 1) {
        firstReloadStarted.resolve();
        return await releaseFirstReload.promise;
      }
      return new Uint8Array(4);
    });
    const secondReload = vi.fn(async () => new Uint8Array(4));
    await value.load({ instance: instance("first"), bytes: new Uint8Array(4), reloadBytes: firstReload });
    await value.load({ instance: instance("second"), bytes: new Uint8Array(4), reloadBytes: secondReload });

    value.handleContextLost();
    const firstRestore = value.handleContextRestored();
    await firstReloadStarted.promise;
    value.handleContextLost();
    releaseFirstReload.resolve(new Uint8Array(4));
    await firstRestore;
    expect(value.snapshot()).toMatchObject({ contextLost: true, instanceIds: [] });
    expect(statuses.filter((status) => status.kind === "context-restored")).toHaveLength(0);

    await value.handleContextRestored();
    expect(value.snapshot()).toMatchObject({
      contextLost: false,
      instanceIds: ["first", "second"],
      pendingInstanceIds: [],
    });
    expect(firstReload).toHaveBeenCalledTimes(2);
    expect(secondReload).toHaveBeenCalledTimes(1);
    expect(statuses.filter((status) => status.kind === "context-restored")).toHaveLength(1);
  });

  it("disposes provider, splats, and bounds deterministically", async () => {
    FakeSparkRenderer.instances = [];
    FakeSplatMesh.instances = [];
    const statuses: RealitySplatRuntimeStatus[] = [];
    const { scene, value } = runtime({ statuses });
    const handle = await value.load({ instance: instance("dispose"), bytes: new Uint8Array(4) });
    const provider = FakeSparkRenderer.instances[0];
    const splat = FakeSplatMesh.instances[0];

    value.dispose();
    value.dispose();

    expect(provider?.disposed).toBe(true);
    expect(splat?.disposed).toBe(true);
    expect(handle.root.parent).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(value.snapshot()).toMatchObject({ disposed: true, providerLoaded: false, instanceIds: [] });
    expect(statuses.filter((status) => status.kind === "disposed")).toHaveLength(1);
    await expect(value.load({ instance: instance("late"), bytes: new Uint8Array(4) })).rejects.toThrow(
      "has been disposed",
    );
  });

  it("rejects mismatched bytes and unsafe transforms before importing Spark", async () => {
    const moduleLoader = vi.fn(async () => fakeModule);
    const { value } = runtime({ moduleLoader });
    await expect(value.load({ instance: instance("short"), bytes: new Uint8Array(3) })).rejects.toThrow(
      "byte length mismatch",
    );
    await expect(value.load({
      instance: instance("scale", {
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotationRadians: { x: 0, y: 0, z: 0 },
          uniformScale: 0,
        },
      }),
      bytes: new Uint8Array(4),
    })).rejects.toThrow("positive uniform scale");
    expect(moduleLoader).not.toHaveBeenCalled();
  });
});
