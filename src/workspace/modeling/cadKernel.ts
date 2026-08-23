import type { OpenCascadeInstance } from "replicad-opencascadejs";
import type {
  Shape3D,
  ShapeMesh,
} from "replicad";
import {
  CadPartEvaluationError,
  evaluateCadPartWithRuntime,
  type CadPartDefinitionV1,
  type CadPartEvaluationOptions,
  type CadPartEvaluationResultV1,
} from "./cad";

/** Version of the stable SemaFrame browser-CAD contract. */
export const CAD_KERNEL_CONTRACT_VERSION = 2 as const;

/**
 * Hard caps applied before work is admitted and again before results escape
 * the kernel boundary. All distances use SI metres.
 */
export const CAD_KERNEL_LIMITS = Object.freeze({
  minimumDimensionM: 1e-6,
  maximumPrimitiveExtentM: 1_000,
  maximumShapeExtentM: 5_000,
  maximumCoordinateMagnitudeM: 1_000_000,
  maximumUniformScale: 1_000,
  minimumUniformScale: 1e-6,
  maximumLiveShapes: 256,
  maximumBooleanComplexity: 128,
  maximumMeshVertices: 500_000,
  maximumMeshTriangles: 1_000_000,
  maximumMeshFaceGroups: 50_000,
  minimumLinearDeflectionM: 1e-5,
  maximumLinearDeflectionM: 100,
  minimumAngularDeflectionRad: 1e-3,
  maximumAngularDeflectionRad: Math.PI,
  maximumExtentToDeflectionRatio: 100_000,
  maximumStepBytes: 64 * 1024 * 1024,
  minimumOperationBudgetMs: 1,
  maximumOperationBudgetMs: 120_000,
  defaultOperationBudgetMs: 30_000,
  maximumDensityKgM3: 100_000,
});

export type CadAxis = "x" | "y" | "z";

export type CadVector3 = Readonly<{
  x: number;
  y: number;
  z: number;
}>;

export type CadBounds = Readonly<{
  min: CadVector3;
  max: CadVector3;
  size: CadVector3;
  center: CadVector3;
}>;

/** Opaque within one kernel instance. Handles cannot cross worker/kernel instances. */
export type CadShapeHandle = Readonly<{
  id: string;
}>;

export type CadBoxInput = Readonly<{
  sizeM: CadVector3;
}>;

export type CadCylinderInput = Readonly<{
  radiusM: number;
  heightM: number;
  axis?: CadAxis;
}>;

export type CadSphereInput = Readonly<{
  radiusM: number;
}>;

/**
 * Transform order is uniform scale about the origin, then axis-angle rotation
 * about the origin, then translation. Angles are radians.
 */
export type CadTransform = Readonly<{
  uniformScale?: number;
  rotation?: Readonly<{
    axis: CadVector3;
    angleRad: number;
  }>;
  translationM?: CadVector3;
}>;

export type CadBooleanOperation = "union" | "cut" | "intersect";

export type CadOperationOptions = Readonly<{
  /** Cooperative for direct calls; hard cancellation is provided by the worker client. */
  signal?: AbortSignal;
  /** Includes time spent waiting for earlier operations on this kernel instance. */
  budgetMs?: number;
}>;

export type CadValidationResult = Readonly<{
  valid: boolean;
  isNull: boolean;
}>;

export type CadMassProperties = Readonly<{
  bounds: CadBounds;
  volumeM3: number;
  surfaceAreaM2: number;
  densityKgM3: number;
  massKg: number;
  centerOfMassM: CadVector3;
}>;

export type CadTessellationOptions = CadOperationOptions & Readonly<{
  linearDeflectionM?: number;
  angularDeflectionRad?: number;
}>;

export type CadPartKernelEvaluationOptions = CadOperationOptions & CadPartEvaluationOptions;

/** Bounded, indexed triangle mesh suitable for Three.js BufferGeometry. */
export type CadIndexedMesh = Readonly<{
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  groups: readonly Readonly<{
    start: number;
    count: number;
    faceId: number;
  }>[];
  bounds: CadBounds;
}>;

export type CadStepExport = Readonly<{
  format: "step";
  mimeType: "application/step";
  units: "metre";
  text: string;
  byteLength: number;
}>;

export type CadKernelInfo = Readonly<{
  contractVersion: typeof CAD_KERNEL_CONTRACT_VERSION;
  engine: "OpenCascade Technology";
  adapter: "replicad";
  execution: "single-threaded-wasm";
  units: "metre";
  runtimeAsset: "bundled-local-wasm";
}>;

export const CAD_KERNEL_INFO: CadKernelInfo = Object.freeze({
  contractVersion: CAD_KERNEL_CONTRACT_VERSION,
  engine: "OpenCascade Technology",
  adapter: "replicad",
  execution: "single-threaded-wasm",
  units: "metre",
  runtimeAsset: "bundled-local-wasm",
});

export type CadKernelErrorCode =
  | "kernel_initialization_failed"
  | "invalid_input"
  | "limit_exceeded"
  | "invalid_handle"
  | "shape_invalid"
  | "boolean_failed"
  | "transform_failed"
  | "tessellation_failed"
  | "cad_part_evaluation_failed"
  | "step_export_failed"
  | "aborted"
  | "operation_timeout"
  | "kernel_disposed";

export class CadKernelError extends Error {
  readonly code: CadKernelErrorCode;
  readonly operation: string;

  constructor(
    code: CadKernelErrorCode,
    operation: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CadKernelError";
    this.code = code;
    this.operation = operation;
  }
}

/**
 * The closed application-facing B-rep API. The same asynchronous contract is
 * implemented by the direct worker-safe kernel and by the browser Worker RPC
 * client in `cadWorkerClient.ts`.
 */
export interface CadKernel {
  readonly info: CadKernelInfo;
  createBox(input: CadBoxInput, options?: CadOperationOptions): Promise<CadShapeHandle>;
  createCylinder(input: CadCylinderInput, options?: CadOperationOptions): Promise<CadShapeHandle>;
  createSphere(input: CadSphereInput, options?: CadOperationOptions): Promise<CadShapeHandle>;
  transform(
    shape: CadShapeHandle,
    transform: CadTransform,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle>;
  boolean(
    operation: CadBooleanOperation,
    left: CadShapeHandle,
    right: CadShapeHandle,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle>;
  validate(shape: CadShapeHandle, options?: CadOperationOptions): Promise<CadValidationResult>;
  measure(
    shape: CadShapeHandle,
    densityKgM3?: number,
    options?: CadOperationOptions,
  ): Promise<CadMassProperties>;
  tessellate(shape: CadShapeHandle, options?: CadTessellationOptions): Promise<CadIndexedMesh>;
  evaluatePart(
    definition: CadPartDefinitionV1,
    options?: CadPartKernelEvaluationOptions,
  ): Promise<CadPartEvaluationResultV1>;
  exportStep(
    shape: CadShapeHandle,
    name?: string,
    options?: CadOperationOptions,
  ): Promise<CadStepExport>;
  release(shape: CadShapeHandle): Promise<void>;
  dispose(): Promise<void>;
}

type ReplicadRuntime = typeof import("replicad");

export type CadRuntime = Readonly<{
  oc: OpenCascadeInstance;
  replicad: ReplicadRuntime;
}>;

/** Injection seam used by tests/custom workers; normal callers omit it. */
export type CadRuntimeLoader = () => Promise<CadRuntime>;

export type LoadCadKernelOptions = Readonly<{
  runtimeLoader?: CadRuntimeLoader;
}>;

type ShapeEntry = {
  shape: Shape3D;
  complexity: number;
};

type OperationContext = Readonly<{
  operation: string;
  queuedAtMs: number;
  budgetMs: number;
  signal?: AbortSignal;
}>;

let sharedRuntimePromise: Promise<CadRuntime> | undefined;

function clockNowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function asCause(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function fail(
  code: CadKernelErrorCode,
  operation: string,
  message: string,
  cause?: unknown,
): never {
  throw new CadKernelError(
    code,
    operation,
    message,
    cause === undefined ? undefined : { cause: asCause(cause) },
  );
}

function assertRecord(value: unknown, operation: string, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_input", operation, `${path} must be an object`);
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  operation: string,
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    fail("invalid_input", operation, `${path}.${unknown} is not supported`);
  }
}

function finiteNumber(value: unknown, operation: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_input", operation, `${path} must be a finite number`);
  }
  return value;
}

function positiveDimension(value: unknown, operation: string, path: string): number {
  const number = finiteNumber(value, operation, path);
  if (number < CAD_KERNEL_LIMITS.minimumDimensionM) {
    fail(
      "invalid_input",
      operation,
      `${path} must be at least ${CAD_KERNEL_LIMITS.minimumDimensionM} metres`,
    );
  }
  if (number > CAD_KERNEL_LIMITS.maximumPrimitiveExtentM) {
    fail(
      "limit_exceeded",
      operation,
      `${path} exceeds ${CAD_KERNEL_LIMITS.maximumPrimitiveExtentM} metres`,
    );
  }
  return number;
}

function vector3(
  value: unknown,
  operation: string,
  path: string,
  options: Readonly<{ maximumMagnitude?: number; nonZero?: boolean }> = {},
): CadVector3 {
  assertRecord(value, operation, path);
  assertOnlyKeys(value, ["x", "y", "z"], operation, path);
  const result = {
    x: finiteNumber(value.x, operation, `${path}.x`),
    y: finiteNumber(value.y, operation, `${path}.y`),
    z: finiteNumber(value.z, operation, `${path}.z`),
  };
  if (options.maximumMagnitude !== undefined) {
    for (const axis of ["x", "y", "z"] as const) {
      if (Math.abs(result[axis]) > options.maximumMagnitude) {
        fail(
          "limit_exceeded",
          operation,
          `${path}.${axis} exceeds magnitude ${options.maximumMagnitude}`,
        );
      }
    }
  }
  if (options.nonZero && Math.hypot(result.x, result.y, result.z) < 1e-12) {
    fail("invalid_input", operation, `${path} must be non-zero`);
  }
  return Object.freeze(result);
}

function operationBudget(options: CadOperationOptions | undefined, operation: string): number {
  if (options === undefined) return CAD_KERNEL_LIMITS.defaultOperationBudgetMs;
  assertRecord(options, operation, "options");
  assertOnlyKeys(options, ["signal", "budgetMs"], operation, "options");
  if (options.budgetMs === undefined) return CAD_KERNEL_LIMITS.defaultOperationBudgetMs;
  const budget = finiteNumber(options.budgetMs, operation, "options.budgetMs");
  if (
    budget < CAD_KERNEL_LIMITS.minimumOperationBudgetMs
    || budget > CAD_KERNEL_LIMITS.maximumOperationBudgetMs
  ) {
    fail(
      "limit_exceeded",
      operation,
      `options.budgetMs must be between ${CAD_KERNEL_LIMITS.minimumOperationBudgetMs} and ${CAD_KERNEL_LIMITS.maximumOperationBudgetMs}`,
    );
  }
  return budget;
}

function toTuple(value: CadVector3): [number, number, number] {
  return [value.x, value.y, value.z];
}

function axisVector(axis: CadAxis): CadVector3 {
  if (axis === "x") return { x: 1, y: 0, z: 0 };
  if (axis === "y") return { x: 0, y: 1, z: 0 };
  return { x: 0, y: 0, z: 1 };
}

function deleteShape(shape: Shape3D | undefined): void {
  if (shape === undefined) return;
  try {
    shape.delete();
  } catch {
    // Emscripten wrappers can already be deleted after a failed transformation.
  }
}

async function defaultCadRuntimeLoader(): Promise<CadRuntime> {
  const [ocModule, replicad] = await Promise.all([
    import("replicad-opencascadejs"),
    import("replicad"),
  ]);

  const isNodeRuntime = typeof process !== "undefined" && process.versions?.node !== undefined;
  // Node resolves the package's sibling file directly. Browser code supplies
  // an explicit Vite URL so both dev and production point at the binary rather
  // than relying on the optimized dependency module's relative URL.
  const oc = isNodeRuntime
    ? await ocModule.default()
    : await import("replicad-opencascadejs/wasm?url&no-inline").then(
      (wasmAsset) => ocModule.default({ locateFile: () => wasmAsset.default }),
    );
  replicad.setOC(oc);
  return Object.freeze({ oc, replicad });
}

function loadSharedRuntime(): Promise<CadRuntime> {
  sharedRuntimePromise ??= defaultCadRuntimeLoader().catch((error: unknown) => {
    sharedRuntimePromise = undefined;
    fail(
      "kernel_initialization_failed",
      "load",
      "OpenCascade WASM could not be initialized from the bundled local asset",
      error,
    );
  });
  return sharedRuntimePromise;
}

class OpenCascadeCadKernel implements CadKernel {
  readonly info = CAD_KERNEL_INFO;
  private readonly entries = new Map<string, ShapeEntry>();
  private nextShapeId = 1;
  private disposed = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: CadRuntime) {}

  async createBox(
    input: CadBoxInput,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle> {
    const operation = "create_box";
    assertRecord(input, operation, "input");
    assertOnlyKeys(input, ["sizeM"], operation, "input");
    const size = vector3(input.sizeM, operation, "input.sizeM");
    const x = positiveDimension(size.x, operation, "input.sizeM.x");
    const y = positiveDimension(size.y, operation, "input.sizeM.y");
    const z = positiveDimension(size.z, operation, "input.sizeM.z");
    this.assertCapacity(operation);
    const shape = await this.executeShape(operation, options, () => this.runtime.replicad.makeBox(
      [-x / 2, -y / 2, -z / 2],
      [x / 2, y / 2, z / 2],
    ));
    return this.register(shape, 1);
  }

  async createCylinder(
    input: CadCylinderInput,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle> {
    const operation = "create_cylinder";
    assertRecord(input, operation, "input");
    assertOnlyKeys(input, ["radiusM", "heightM", "axis"], operation, "input");
    const radius = positiveDimension(input.radiusM, operation, "input.radiusM");
    const height = positiveDimension(input.heightM, operation, "input.heightM");
    if (radius * 2 > CAD_KERNEL_LIMITS.maximumPrimitiveExtentM) {
      fail(
        "limit_exceeded",
        operation,
        `input.radiusM creates a diameter above ${CAD_KERNEL_LIMITS.maximumPrimitiveExtentM} metres`,
      );
    }
    const axis = input.axis ?? "z";
    if (axis !== "x" && axis !== "y" && axis !== "z") {
      fail("invalid_input", operation, "input.axis must be x, y, or z");
    }
    const direction = axisVector(axis);
    const location: CadVector3 = {
      x: -direction.x * height / 2,
      y: -direction.y * height / 2,
      z: -direction.z * height / 2,
    };
    this.assertCapacity(operation);
    const shape = await this.executeShape(operation, options, () => this.runtime.replicad.makeCylinder(
      radius,
      height,
      toTuple(location),
      toTuple(direction),
    ));
    return this.register(shape, 1);
  }

  async createSphere(
    input: CadSphereInput,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle> {
    const operation = "create_sphere";
    assertRecord(input, operation, "input");
    assertOnlyKeys(input, ["radiusM"], operation, "input");
    const radius = positiveDimension(input.radiusM, operation, "input.radiusM");
    if (radius * 2 > CAD_KERNEL_LIMITS.maximumPrimitiveExtentM) {
      fail(
        "limit_exceeded",
        operation,
        `input.radiusM creates a diameter above ${CAD_KERNEL_LIMITS.maximumPrimitiveExtentM} metres`,
      );
    }
    this.assertCapacity(operation);
    const shape = await this.executeShape(
      operation,
      options,
      () => this.runtime.replicad.makeSphere(radius),
    );
    return this.register(shape, 1);
  }

  async transform(
    handle: CadShapeHandle,
    input: CadTransform,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle> {
    const operation = "transform";
    assertRecord(input, operation, "transform");
    assertOnlyKeys(input, ["uniformScale", "rotation", "translationM"], operation, "transform");
    if (Object.keys(input).length === 0) {
      fail("invalid_input", operation, "transform must contain at least one operation");
    }

    let uniformScale: number | undefined;
    if (input.uniformScale !== undefined) {
      uniformScale = finiteNumber(input.uniformScale, operation, "transform.uniformScale");
      if (
        uniformScale < CAD_KERNEL_LIMITS.minimumUniformScale
        || uniformScale > CAD_KERNEL_LIMITS.maximumUniformScale
      ) {
        fail(
          "limit_exceeded",
          operation,
          `transform.uniformScale must be between ${CAD_KERNEL_LIMITS.minimumUniformScale} and ${CAD_KERNEL_LIMITS.maximumUniformScale}`,
        );
      }
    }

    let rotation: { axis: CadVector3; angleRad: number } | undefined;
    if (input.rotation !== undefined) {
      assertRecord(input.rotation, operation, "transform.rotation");
      assertOnlyKeys(input.rotation, ["axis", "angleRad"], operation, "transform.rotation");
      rotation = {
        axis: vector3(input.rotation.axis, operation, "transform.rotation.axis", { nonZero: true }),
        angleRad: finiteNumber(input.rotation.angleRad, operation, "transform.rotation.angleRad"),
      };
      if (Math.abs(rotation.angleRad) > Math.PI * 2 * 1_000_000) {
        fail("limit_exceeded", operation, "transform.rotation.angleRad is unreasonably large");
      }
    }

    const translation = input.translationM === undefined
      ? undefined
      : vector3(input.translationM, operation, "transform.translationM", {
        maximumMagnitude: CAD_KERNEL_LIMITS.maximumCoordinateMagnitudeM,
      });

    this.assertCapacity(operation);
    let sourceComplexity = 1;
    const shape = await this.executeShape(operation, options, () => {
      // Resolve handles inside the serialized operation. An earlier queued
      // release must make this operation fail cleanly instead of leaving it
      // with a deleted Emscripten wrapper captured before the queue ran.
      const entry = this.requireEntry(handle, operation);
      sourceComplexity = entry.complexity;
      let transformed = entry.shape.clone();
      try {
        if (uniformScale !== undefined) transformed = transformed.scale(uniformScale);
        if (rotation !== undefined) {
          transformed = transformed.rotate(
            rotation.angleRad * 180 / Math.PI,
            [0, 0, 0],
            toTuple(rotation.axis),
          );
        }
        if (translation !== undefined) transformed = transformed.translate(toTuple(translation));
        return transformed;
      } catch (error) {
        deleteShape(transformed);
        fail("transform_failed", operation, "OpenCascade could not apply the transform", error);
      }
    });
    return this.register(shape, sourceComplexity);
  }

  async boolean(
    kind: CadBooleanOperation,
    leftHandle: CadShapeHandle,
    rightHandle: CadShapeHandle,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle> {
    const operation = `boolean_${String(kind)}`;
    if (kind !== "union" && kind !== "cut" && kind !== "intersect") {
      fail("invalid_input", operation, "operation must be union, cut, or intersect");
    }
    this.assertCapacity(operation);
    let complexity = 1;
    const shape = await this.executeShape(operation, options, () => {
      const left = this.requireEntry(leftHandle, operation);
      const right = this.requireEntry(rightHandle, operation);
      complexity = left.complexity + right.complexity + 1;
      if (complexity > CAD_KERNEL_LIMITS.maximumBooleanComplexity) {
        fail(
          "limit_exceeded",
          operation,
          `boolean complexity exceeds ${CAD_KERNEL_LIMITS.maximumBooleanComplexity}`,
        );
      }
      try {
        if (kind === "union") return left.shape.fuse(right.shape);
        if (kind === "cut") return left.shape.cut(right.shape);
        return left.shape.intersect(right.shape);
      } catch (error) {
        fail("boolean_failed", operation, `OpenCascade ${kind} failed`, error);
      }
    });
    return this.register(shape, complexity);
  }

  async validate(
    handle: CadShapeHandle,
    options?: CadOperationOptions,
  ): Promise<CadValidationResult> {
    const operation = "validate";
    return this.execute(operation, options, () => {
      const entry = this.requireEntry(handle, operation);
      return this.validateRaw(entry.shape);
    });
  }

  async measure(
    handle: CadShapeHandle,
    densityKgM3 = 1,
    options?: CadOperationOptions,
  ): Promise<CadMassProperties> {
    const operation = "measure";
    densityKgM3 = finiteNumber(densityKgM3, operation, "densityKgM3");
    if (densityKgM3 <= 0) fail("invalid_input", operation, "densityKgM3 must be greater than zero");
    if (densityKgM3 > CAD_KERNEL_LIMITS.maximumDensityKgM3) {
      fail(
        "limit_exceeded",
        operation,
        `densityKgM3 exceeds ${CAD_KERNEL_LIMITS.maximumDensityKgM3}`,
      );
    }
    return this.execute(operation, options, () => {
      const entry = this.requireEntry(handle, operation);
      const validity = this.validateRaw(entry.shape);
      if (!validity.valid) fail("shape_invalid", operation, "mass properties require a valid solid");

      const volumeProperties = this.runtime.replicad.measureShapeVolumeProperties(entry.shape);
      const surfaceProperties = this.runtime.replicad.measureShapeSurfaceProperties(entry.shape);
      try {
        const volumeM3 = volumeProperties.volume;
        const surfaceAreaM2 = surfaceProperties.area;
        const center = volumeProperties.centerOfMass;
        for (const [path, value] of [
          ["volumeM3", volumeM3],
          ["surfaceAreaM2", surfaceAreaM2],
          ["centerOfMassM.x", center[0]],
          ["centerOfMassM.y", center[1]],
          ["centerOfMassM.z", center[2]],
        ] as const) {
          if (!Number.isFinite(value)) {
            fail("shape_invalid", operation, `${path} is not finite`);
          }
        }
        if (volumeM3 <= 0) fail("shape_invalid", operation, "shape does not have positive volume");
        return Object.freeze({
          bounds: this.boundsFor(entry.shape, operation),
          volumeM3,
          surfaceAreaM2,
          densityKgM3,
          massKg: volumeM3 * densityKgM3,
          centerOfMassM: Object.freeze({ x: center[0], y: center[1], z: center[2] }),
        });
      } finally {
        volumeProperties.delete();
        surfaceProperties.delete();
      }
    });
  }

  async tessellate(
    handle: CadShapeHandle,
    options: CadTessellationOptions = {},
  ): Promise<CadIndexedMesh> {
    const operation = "tessellate";
    assertRecord(options, operation, "options");
    assertOnlyKeys(
      options,
      ["signal", "budgetMs", "linearDeflectionM", "angularDeflectionRad"],
      operation,
      "options",
    );
    const linear = options.linearDeflectionM === undefined
      ? 0.001
      : finiteNumber(options.linearDeflectionM, operation, "options.linearDeflectionM");
    const angular = options.angularDeflectionRad === undefined
      ? 0.2
      : finiteNumber(options.angularDeflectionRad, operation, "options.angularDeflectionRad");
    if (
      linear < CAD_KERNEL_LIMITS.minimumLinearDeflectionM
      || linear > CAD_KERNEL_LIMITS.maximumLinearDeflectionM
    ) {
      fail(
        "limit_exceeded",
        operation,
        `linearDeflectionM must be between ${CAD_KERNEL_LIMITS.minimumLinearDeflectionM} and ${CAD_KERNEL_LIMITS.maximumLinearDeflectionM}`,
      );
    }
    if (
      angular < CAD_KERNEL_LIMITS.minimumAngularDeflectionRad
      || angular > CAD_KERNEL_LIMITS.maximumAngularDeflectionRad
    ) {
      fail(
        "limit_exceeded",
        operation,
        `angularDeflectionRad must be between ${CAD_KERNEL_LIMITS.minimumAngularDeflectionRad} and ${CAD_KERNEL_LIMITS.maximumAngularDeflectionRad}`,
      );
    }
    const operationOptions: CadOperationOptions = {
      signal: options.signal,
      budgetMs: options.budgetMs,
    };
    return this.execute(operation, operationOptions, () => {
      const entry = this.requireEntry(handle, operation);
      const bounds = this.boundsFor(entry.shape, operation);
      const largestExtent = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
      if (largestExtent / linear > CAD_KERNEL_LIMITS.maximumExtentToDeflectionRatio) {
        fail(
          "limit_exceeded",
          operation,
          `requested deflection is too fine for a ${largestExtent} metre shape`,
        );
      }
      let raw: ShapeMesh;
      try {
        raw = entry.shape.mesh({ tolerance: linear, angularTolerance: angular });
      } catch (error) {
        fail("tessellation_failed", operation, "OpenCascade tessellation failed", error);
      }
      this.validateMesh(raw, operation);
      return Object.freeze({
        positions: Float32Array.from(raw.vertices),
        normals: Float32Array.from(raw.normals),
        indices: Uint32Array.from(raw.triangles),
        groups: Object.freeze(raw.faceGroups.map((group) => Object.freeze({ ...group }))),
        bounds,
      });
    });
  }

  async evaluatePart(
    definition: CadPartDefinitionV1,
    options: CadPartKernelEvaluationOptions = {},
  ): Promise<CadPartEvaluationResultV1> {
    const operation = "evaluate_part";
    assertRecord(options, operation, "options");
    assertOnlyKeys(
      options,
      ["signal", "budgetMs", "linearDeflectionM", "angularDeflectionRad", "includeMeshes"],
      operation,
      "options",
    );
    const operationOptions: CadOperationOptions = {
      signal: options.signal,
      budgetMs: options.budgetMs,
    };
    return this.execute(operation, operationOptions, () => {
      try {
        return evaluateCadPartWithRuntime(this.runtime, definition, options);
      } catch (error) {
        if (error instanceof CadPartEvaluationError) {
          const feature = error.featureId ? ` at feature ${error.featureId}` : "";
          fail(
            "cad_part_evaluation_failed",
            operation,
            `CAD part evaluation failed${feature}: ${error.message}`,
            error,
          );
        }
        throw error;
      }
    });
  }

  async exportStep(
    handle: CadShapeHandle,
    name = "SemaFrame model",
    options?: CadOperationOptions,
  ): Promise<CadStepExport> {
    const operation = "export_step";
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 256) {
      fail("invalid_input", operation, "name must be a non-empty string of at most 256 characters");
    }
    if (/\p{Cc}/u.test(name)) {
      fail("invalid_input", operation, "name cannot contain control characters");
    }
    return this.execute(operation, options, async () => {
      const entry = this.requireEntry(handle, operation);
      const validity = this.validateRaw(entry.shape);
      if (!validity.valid) fail("shape_invalid", operation, "STEP export requires a valid solid");
      try {
        const blob = this.runtime.replicad.exportSTEP(
          [{ shape: entry.shape, name }],
          { unit: "M", modelUnit: "M" },
        );
        if (blob.size > CAD_KERNEL_LIMITS.maximumStepBytes) {
          fail(
            "limit_exceeded",
            operation,
            `STEP output exceeds ${CAD_KERNEL_LIMITS.maximumStepBytes} bytes`,
          );
        }
        const text = await blob.text();
        const byteLength = new TextEncoder().encode(text).byteLength;
        if (byteLength > CAD_KERNEL_LIMITS.maximumStepBytes) {
          fail(
            "limit_exceeded",
            operation,
            `STEP output exceeds ${CAD_KERNEL_LIMITS.maximumStepBytes} bytes`,
          );
        }
        if (
          !text.startsWith("ISO-10303-21;")
          || !text.includes("HEADER;")
          || !text.includes("DATA;")
          || !text.trimEnd().endsWith("END-ISO-10303-21;")
        ) {
          fail("step_export_failed", operation, "OpenCascade returned an incomplete STEP Part 21 file");
        }
        return Object.freeze({
          format: "step" as const,
          mimeType: "application/step" as const,
          units: "metre" as const,
          text,
          byteLength,
        });
      } catch (error) {
        if (error instanceof CadKernelError) throw error;
        fail("step_export_failed", operation, "OpenCascade STEP export failed", error);
      }
    });
  }

  async release(handle: CadShapeHandle): Promise<void> {
    const operation = "release";
    await this.execute(operation, undefined, () => {
      const entry = this.requireEntry(handle, operation);
      this.entries.delete(handle.id);
      deleteShape(entry.shape);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.operationTail.catch(() => undefined);
    for (const entry of this.entries.values()) deleteShape(entry.shape);
    this.entries.clear();
  }

  private requireEntry(handle: CadShapeHandle, operation: string): ShapeEntry {
    this.assertUsable(operation);
    assertRecord(handle, operation, "shape");
    assertOnlyKeys(handle, ["id"], operation, "shape");
    if (typeof handle.id !== "string" || handle.id.length === 0) {
      fail("invalid_handle", operation, "shape.id must be a non-empty string");
    }
    const entry = this.entries.get(handle.id);
    if (entry === undefined) {
      fail("invalid_handle", operation, "shape handle does not belong to this live kernel instance");
    }
    return entry;
  }

  private register(shape: Shape3D, complexity: number): CadShapeHandle {
    if (this.entries.size >= CAD_KERNEL_LIMITS.maximumLiveShapes) {
      deleteShape(shape);
      fail(
        "limit_exceeded",
        "register",
        `release a shape before exceeding ${CAD_KERNEL_LIMITS.maximumLiveShapes} live shapes`,
      );
    }
    const id = `cad:${this.nextShapeId}`;
    this.nextShapeId += 1;
    this.entries.set(id, { shape, complexity });
    return Object.freeze({ id });
  }

  private assertUsable(operation: string): void {
    if (this.disposed) fail("kernel_disposed", operation, "CAD kernel has been disposed");
  }

  private assertCapacity(operation: string): void {
    this.assertUsable(operation);
    if (this.entries.size >= CAD_KERNEL_LIMITS.maximumLiveShapes) {
      fail(
        "limit_exceeded",
        operation,
        `release a shape before exceeding ${CAD_KERNEL_LIMITS.maximumLiveShapes} live shapes`,
      );
    }
  }

  private validateRaw(shape: Shape3D): CadValidationResult {
    const isNull = shape.isNull;
    if (isNull) return Object.freeze({ valid: false, isNull: true });
    const analyzer = new this.runtime.oc.BRepCheck_Analyzer(shape.wrapped, true, false, true);
    try {
      return Object.freeze({ valid: analyzer.IsValid(), isNull: false });
    } finally {
      analyzer.delete();
    }
  }

  private boundsFor(shape: Shape3D, operation: string): CadBounds {
    const box = shape.boundingBox;
    try {
      const [minimum, maximum] = box.bounds;
      const values = [...minimum, ...maximum];
      if (values.some((value) => !Number.isFinite(value))) {
        fail("shape_invalid", operation, "shape bounds are not finite");
      }
      const size = {
        x: maximum[0] - minimum[0],
        y: maximum[1] - minimum[1],
        z: maximum[2] - minimum[2],
      };
      if (Math.max(size.x, size.y, size.z) > CAD_KERNEL_LIMITS.maximumShapeExtentM) {
        fail(
          "limit_exceeded",
          operation,
          `shape bounds exceed ${CAD_KERNEL_LIMITS.maximumShapeExtentM} metres`,
        );
      }
      if (values.some((value) => Math.abs(value) > CAD_KERNEL_LIMITS.maximumCoordinateMagnitudeM)) {
        fail(
          "limit_exceeded",
          operation,
          `shape coordinate exceeds magnitude ${CAD_KERNEL_LIMITS.maximumCoordinateMagnitudeM}`,
        );
      }
      return Object.freeze({
        min: Object.freeze({ x: minimum[0], y: minimum[1], z: minimum[2] }),
        max: Object.freeze({ x: maximum[0], y: maximum[1], z: maximum[2] }),
        size: Object.freeze(size),
        center: Object.freeze({
          x: (minimum[0] + maximum[0]) / 2,
          y: (minimum[1] + maximum[1]) / 2,
          z: (minimum[2] + maximum[2]) / 2,
        }),
      });
    } finally {
      box.delete();
    }
  }

  private validateMesh(mesh: ShapeMesh, operation: string): void {
    if (
      mesh.vertices.length % 3 !== 0
      || mesh.normals.length !== mesh.vertices.length
      || mesh.triangles.length % 3 !== 0
    ) {
      fail("tessellation_failed", operation, "kernel returned malformed mesh arrays");
    }
    const vertexCount = mesh.vertices.length / 3;
    const triangleCount = mesh.triangles.length / 3;
    if (vertexCount > CAD_KERNEL_LIMITS.maximumMeshVertices) {
      fail(
        "limit_exceeded",
        operation,
        `mesh contains ${vertexCount} vertices; maximum is ${CAD_KERNEL_LIMITS.maximumMeshVertices}`,
      );
    }
    if (triangleCount > CAD_KERNEL_LIMITS.maximumMeshTriangles) {
      fail(
        "limit_exceeded",
        operation,
        `mesh contains ${triangleCount} triangles; maximum is ${CAD_KERNEL_LIMITS.maximumMeshTriangles}`,
      );
    }
    if (mesh.faceGroups.length > CAD_KERNEL_LIMITS.maximumMeshFaceGroups) {
      fail(
        "limit_exceeded",
        operation,
        `mesh contains too many face groups`,
      );
    }
    if (mesh.vertices.some((value) => !Number.isFinite(value))) {
      fail("tessellation_failed", operation, "mesh contains a non-finite vertex");
    }
    if (mesh.normals.some((value) => !Number.isFinite(value))) {
      fail("tessellation_failed", operation, "mesh contains a non-finite normal");
    }
    if (mesh.triangles.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
      fail("tessellation_failed", operation, "mesh contains an out-of-range triangle index");
    }
  }

  private async executeShape(
    operation: string,
    options: CadOperationOptions | undefined,
    body: () => Shape3D,
  ): Promise<Shape3D> {
    return this.execute(operation, options, () => {
      let shape: Shape3D | undefined;
      try {
        shape = body();
        const validity = this.validateRaw(shape);
        if (!validity.valid) fail("shape_invalid", operation, "OpenCascade produced an invalid solid");
        this.boundsFor(shape, operation);
        return shape;
      } catch (error) {
        deleteShape(shape);
        throw error;
      }
    }, deleteShape);
  }

  private execute<T>(
    operation: string,
    options: CadOperationOptions | undefined,
    body: () => T | Promise<T>,
    cleanup?: (value: T) => void,
  ): Promise<T> {
    this.assertUsable(operation);
    const context: OperationContext = {
      operation,
      queuedAtMs: clockNowMs(),
      budgetMs: operationBudget(options, operation),
      signal: options?.signal,
    };
    const result = this.operationTail.then(async () => {
      this.guardOperation(context);
      let value: T | undefined;
      try {
        value = await body();
        this.guardOperation(context);
        return value;
      } catch (error) {
        if (value !== undefined) cleanup?.(value);
        if (error instanceof CadKernelError) throw error;
        fail("shape_invalid", operation, `OpenCascade operation ${operation} failed`, error);
      }
    });
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private guardOperation(context: OperationContext): void {
    this.assertUsable(context.operation);
    if (context.signal?.aborted) {
      fail("aborted", context.operation, "operation was aborted");
    }
    const elapsed = clockNowMs() - context.queuedAtMs;
    if (elapsed > context.budgetMs) {
      fail(
        "operation_timeout",
        context.operation,
        `operation exceeded its ${context.budgetMs} ms budget`,
      );
    }
  }
}

/**
 * Constructs the bounded adapter around an already initialized OCCT runtime.
 * Browser workers use this seam with static imports so Vite can emit its
 * default single-file worker format without dynamic worker chunks.
 */
export function createCadKernelFromRuntime(runtime: CadRuntime): CadKernel {
  runtime.replicad.setOC(runtime.oc);
  return new OpenCascadeCadKernel(runtime);
}

/**
 * Lazily initializes the bundled single-threaded OCCT WebAssembly asset.
 * Importing this module alone performs no heavy work and makes no external
 * network request. Put this call inside a Worker for hard cancellation.
 */
export async function loadCadKernel(
  options: LoadCadKernelOptions = {},
): Promise<CadKernel> {
  try {
    const runtime = options.runtimeLoader
      ? await options.runtimeLoader()
      : await loadSharedRuntime();
    return createCadKernelFromRuntime(runtime);
  } catch (error) {
    if (error instanceof CadKernelError) throw error;
    fail(
      "kernel_initialization_failed",
      "load",
      "OpenCascade WASM could not be initialized",
      error,
    );
  }
}
