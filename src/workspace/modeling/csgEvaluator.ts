import type {
  ErrorStatus,
  ExecutionContext,
  Manifold,
  ManifoldToplevel,
  Mat4,
} from "manifold-3d/manifold";
import type { SpatialBounds } from "../spatial/spatialTypes";
import {
  CSG_DEFINITION_LIMITS,
  csgDefinitionDigest,
  parseCsgDefinition,
  type CsgDefinition,
  type CsgNode,
  type CsgQuaternion,
  type CsgTransform,
} from "./csgTypes";
import type { ParametricPrimitive } from "./parametricGeometry";

export const CSG_ENGINE = Object.freeze({
  name: "Manifold",
  packageName: "manifold-3d",
  version: "3.5.1",
  license: "Apache-2.0",
  runtime: "WebAssembly",
  /** Imported only when a CSG evaluation is first requested. */
  loading: "lazy",
} as const);

export const CSG_EVALUATION_LIMITS = Object.freeze({
  minimumCircularSegments: 8,
  defaultCircularSegments: 32,
  maximumCircularSegments: 96,
  defaultMaximumVertices: 200_000,
  hardMaximumVertices: 500_000,
  defaultMaximumTriangles: 400_000,
  hardMaximumTriangles: 1_000_000,
});

export type CsgEvaluationProgress = Readonly<{
  phase: "validate" | "load_engine" | "build_tree" | "evaluate" | "extract_mesh" | "complete";
  progress: number;
}>;

export type CsgEvaluationOptions = Readonly<{
  /** Fixed tessellation makes curved-leaf evaluation reproducible. */
  circularSegments?: number;
  maxVertices?: number;
  maxTriangles?: number;
  signal?: AbortSignal;
  onProgress?: (update: CsgEvaluationProgress) => void;
}>;

export type CsgIndexedMesh = Readonly<{
  format: "indexed-triangle-mesh";
  units: "metres";
  coordinateSystem: "right-handed-y-up";
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}>;

export type CsgDiagnostics = Readonly<{
  engine: typeof CSG_ENGINE;
  status: ErrorStatus;
  /** A NoError Manifold is an oriented, closed two-manifold triangle mesh. */
  manifold: boolean;
  watertight: boolean;
  empty: boolean;
  genus: number | null;
  toleranceM: number;
  surfaceAreaM2: number;
}>;

export type CsgEvaluationResult = Readonly<{
  definition: CsgDefinition;
  definitionDigest: string;
  resultDigest: string;
  options: Readonly<{
    circularSegments: number;
    maxVertices: number;
    maxTriangles: number;
  }>;
  mesh: CsgIndexedMesh;
  /** Null is the only sensible bound for a valid empty intersection. */
  bounds: SpatialBounds | null;
  /** Exact signed-polyhedron volume reported by the Manifold kernel. */
  volumeM3: number;
  diagnostics: CsgDiagnostics;
}>;

export class CsgEvaluationError extends Error {
  readonly code:
    | "aborted"
    | "invalid_options"
    | "kernel_error"
    | "mesh_limit_exceeded"
    | "coordinate_limit_exceeded"
    | "operation_timeout";

  constructor(code: CsgEvaluationError["code"], message: string) {
    super(message);
    this.name = code === "aborted" ? "AbortError" : "CsgEvaluationError";
    this.code = code;
  }
}

type RuntimeManifoldModule = ManifoldToplevel & Readonly<{
  /** Present in Manifold 3.5.1, but omitted from its narrow toplevel interface. */
  ExecutionContext: new () => ExecutionContext;
}>;

type NormalizedOptions = Readonly<{
  circularSegments: number;
  maxVertices: number;
  maxTriangles: number;
  signal?: AbortSignal;
  onProgress?: (update: CsgEvaluationProgress) => void;
}>;

let modulePromise: Promise<RuntimeManifoldModule> | undefined;

async function loadManifoldModule(): Promise<RuntimeManifoldModule> {
  modulePromise ??= (async () => {
    const manifoldRuntime = await import("manifold-3d/lib/wasm");
    const isNodeRuntime = typeof process !== "undefined" && process.versions?.node !== undefined;
    // Node resolves the package's sibling file directly. In a browser, Vite
    // serves optimized dependency modules from a different directory, so the
    // generated loader's relative fallback can resolve to the app HTML. Give
    // Manifold one explicit local asset URL before the first instantiation.
    if (!isNodeRuntime) {
      const wasmAsset = await import("manifold-3d/manifold.wasm?url&no-inline");
      manifoldRuntime.setWasmUrl(wasmAsset.default);
    }
    const module = await manifoldRuntime.getManifoldModule() as RuntimeManifoldModule;
    if (typeof module.ExecutionContext !== "function") {
      throw new CsgEvaluationError(
        "kernel_error",
        "Manifold runtime does not expose the required cancellation context",
      );
    }
    return module;
  })().catch((error: unknown) => {
    // A transient asset or initialization failure must not poison every later
    // evaluation in this realm with the same rejected Promise.
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

function integerOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number"
    || !Number.isSafeInteger(resolved)
    || resolved < minimum
    || resolved > maximum) {
    throw new CsgEvaluationError(
      "invalid_options",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

function normalizeOptions(options: CsgEvaluationOptions): NormalizedOptions {
  return Object.freeze({
    circularSegments: integerOption(
      options.circularSegments,
      CSG_EVALUATION_LIMITS.defaultCircularSegments,
      CSG_EVALUATION_LIMITS.minimumCircularSegments,
      CSG_EVALUATION_LIMITS.maximumCircularSegments,
      "circularSegments",
    ),
    maxVertices: integerOption(
      options.maxVertices,
      CSG_EVALUATION_LIMITS.defaultMaximumVertices,
      1,
      CSG_EVALUATION_LIMITS.hardMaximumVertices,
      "maxVertices",
    ),
    maxTriangles: integerOption(
      options.maxTriangles,
      CSG_EVALUATION_LIMITS.defaultMaximumTriangles,
      1,
      CSG_EVALUATION_LIMITS.hardMaximumTriangles,
      "maxTriangles",
    ),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

function report(options: NormalizedOptions, update: CsgEvaluationProgress): void {
  options.onProgress?.(Object.freeze(update));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CsgEvaluationError("aborted", "CSG evaluation was cancelled");
  }
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function rotatePrimitiveToAxis(
  manifold: Manifold,
  axis: "x" | "y" | "z",
): Manifold {
  if (axis === "z") return manifold;
  const rotated = axis === "x"
    ? manifold.rotate([0, 90, 0])
    : manifold.rotate([-90, 0, 0]);
  manifold.delete();
  return rotated;
}

function makeCapsule(
  module: RuntimeManifoldModule,
  radiusM: number,
  cylinderHeightM: number,
  axis: "x" | "y" | "z",
  circularSegments: number,
): Manifold {
  const cylinder = module.Manifold.cylinder(
    cylinderHeightM,
    radiusM,
    radiusM,
    circularSegments,
    true,
  );
  const lowerSource = module.Manifold.sphere(radiusM, circularSegments);
  const upperSource = module.Manifold.sphere(radiusM, circularSegments);
  const lower = lowerSource.translate([0, 0, -cylinderHeightM / 2]);
  const upper = upperSource.translate([0, 0, cylinderHeightM / 2]);
  lowerSource.delete();
  upperSource.delete();
  try {
    return rotatePrimitiveToAxis(module.Manifold.union([cylinder, lower, upper]), axis);
  } finally {
    cylinder.delete();
    lower.delete();
    upper.delete();
  }
}

function makePrimitive(
  module: RuntimeManifoldModule,
  primitive: ParametricPrimitive,
  circularSegments: number,
): Manifold {
  switch (primitive.kind) {
    case "box":
      return module.Manifold.cube([
        primitive.sizeM.x,
        primitive.sizeM.y,
        primitive.sizeM.z,
      ], true);
    case "sphere":
      return module.Manifold.sphere(primitive.radiusM, circularSegments);
    case "cylinder":
      return rotatePrimitiveToAxis(module.Manifold.cylinder(
        primitive.heightM,
        primitive.radiusM,
        primitive.radiusM,
        circularSegments,
        true,
      ), primitive.axis);
    case "cone":
      return rotatePrimitiveToAxis(module.Manifold.cylinder(
        primitive.heightM,
        primitive.radiusM,
        0,
        circularSegments,
        true,
      ), primitive.axis);
    case "capsule":
      return makeCapsule(
        module,
        primitive.radiusM,
        primitive.cylinderHeightM,
        primitive.axis,
        circularSegments,
      );
    case "plane":
      throw new CsgEvaluationError("kernel_error", "A plane cannot be evaluated as a CSG solid");
  }
}

function transformMatrix(transform: CsgTransform): Mat4 {
  const { x, y, z, w } = transform.rotationQuaternion
    ?? ({ x: 0, y: 0, z: 0, w: 1 } satisfies CsgQuaternion);
  const scale = transform.scale ?? { x: 1, y: 1, z: 1 };
  const translation = transform.translationM ?? { x: 0, y: 0, z: 0 };

  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  const m00 = 1 - 2 * (yy + zz);
  const m01 = 2 * (xy - wz);
  const m02 = 2 * (xz + wy);
  const m10 = 2 * (xy + wz);
  const m11 = 1 - 2 * (xx + zz);
  const m12 = 2 * (yz - wx);
  const m20 = 2 * (xz - wy);
  const m21 = 2 * (yz + wx);
  const m22 = 1 - 2 * (xx + yy);

  // Manifold matrices are column-major. Scaling the basis columns applies
  // scale in local space, followed by rotation and translation.
  return [
    m00 * scale.x, m10 * scale.x, m20 * scale.x, 0,
    m01 * scale.y, m11 * scale.y, m21 * scale.y, 0,
    m02 * scale.z, m12 * scale.z, m22 * scale.z, 0,
    translation.x, translation.y, translation.z, 1,
  ];
}

function applyTransform(manifold: Manifold, transform: CsgTransform | undefined): Manifold {
  if (!transform) return manifold;
  const transformed = manifold.transform(transformMatrix(transform));
  manifold.delete();
  return transformed;
}

type BuildState = {
  visitedNodes: number;
};

async function buildNode(
  module: RuntimeManifoldModule,
  node: CsgNode,
  options: NormalizedOptions,
  state: BuildState,
): Promise<Manifold> {
  throwIfAborted(options.signal);
  state.visitedNodes += 1;
  if (state.visitedNodes % 8 === 0) {
    await yieldToHost();
    throwIfAborted(options.signal);
  }
  report(options, {
    phase: "build_tree",
    progress: Math.min(0.5, 0.15 + 0.35 * state.visitedNodes / CSG_DEFINITION_LIMITS.maximumNodes),
  });

  if (node.kind === "primitive") {
    return applyTransform(
      makePrimitive(module, node.primitive, options.circularSegments),
      node.transform,
    );
  }

  let left: Manifold | undefined;
  let right: Manifold | undefined;
  try {
    left = await buildNode(module, node.left, options, state);
    right = await buildNode(module, node.right, options, state);
    throwIfAborted(options.signal);
    switch (node.kind) {
      case "union": return left.add(right);
      case "subtract": return left.subtract(right);
      case "intersect": return left.intersect(right);
    }
    throw new CsgEvaluationError("kernel_error", "Unsupported CSG operation");
  } finally {
    left?.delete();
    right?.delete();
  }
}

function normalizedZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function spatialBounds(min: readonly number[], max: readonly number[]): SpatialBounds {
  const minValue = Object.freeze({ x: min[0]!, y: min[1]!, z: min[2]! });
  const maxValue = Object.freeze({ x: max[0]!, y: max[1]!, z: max[2]! });
  return Object.freeze({
    min: minValue,
    max: maxValue,
    center: Object.freeze({
      x: (minValue.x + maxValue.x) / 2,
      y: (minValue.y + maxValue.y) / 2,
      z: (minValue.z + maxValue.z) / 2,
    }),
    size: Object.freeze({
      x: maxValue.x - minValue.x,
      y: maxValue.y - minValue.y,
      z: maxValue.z - minValue.z,
    }),
  });
}

function validateBounds(bounds: SpatialBounds): void {
  for (const value of [
    bounds.min.x,
    bounds.min.y,
    bounds.min.z,
    bounds.max.x,
    bounds.max.y,
    bounds.max.z,
  ]) {
    if (!Number.isFinite(value)
      || Math.abs(value) > CSG_DEFINITION_LIMITS.maximumOutputCoordinateM) {
      throw new CsgEvaluationError(
        "coordinate_limit_exceeded",
        `CSG output coordinates must remain within +/-${CSG_DEFINITION_LIMITS.maximumOutputCoordinateM} metres`,
      );
    }
  }
}

function extractPositions(interleaved: Float32Array, numProp: number): Float32Array {
  if (!Number.isSafeInteger(numProp) || numProp < 3 || interleaved.length % numProp !== 0) {
    throw new CsgEvaluationError("kernel_error", "Manifold returned an invalid vertex layout");
  }
  const positions = new Float32Array((interleaved.length / numProp) * 3);
  for (let source = 0, target = 0; source < interleaved.length; source += numProp) {
    const x = interleaved[source]!;
    const y = interleaved[source + 1]!;
    const z = interleaved[source + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new CsgEvaluationError("kernel_error", "Manifold returned a non-finite vertex");
    }
    positions[target] = x;
    positions[target + 1] = y;
    positions[target + 2] = z;
    target += 3;
  }
  return positions;
}

function updateHashByte(hash: number, value: number): number {
  return Math.imul((hash ^ value) >>> 0, 0x01000193) >>> 0;
}

function updateHashString(hash: number, value: string): number {
  let result = hash;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result = updateHashByte(result, code & 0xff);
    result = updateHashByte(result, code >>> 8);
  }
  return result;
}

function resultDigest(
  definitionDigest: string,
  options: NormalizedOptions,
  positions: Float32Array,
  indices: Uint32Array,
): string {
  let hash = updateHashString(0x811c9dc5, [
    "csg-result-v1",
    CSG_ENGINE.packageName,
    CSG_ENGINE.version,
    definitionDigest,
    options.circularSegments,
  ].join("|"));
  const scratch = new DataView(new ArrayBuffer(4));
  for (const position of positions) {
    scratch.setFloat32(0, position, true);
    for (let byte = 0; byte < 4; byte += 1) {
      hash = updateHashByte(hash, scratch.getUint8(byte));
    }
  }
  for (const index of indices) {
    scratch.setUint32(0, index, true);
    for (let byte = 0; byte < 4; byte += 1) {
      hash = updateHashByte(hash, scratch.getUint8(byte));
    }
  }
  return `csg-result-v1:fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Evaluate a bounded CSG tree with the real Manifold WASM kernel.
 *
 * The dynamic import is a worker-friendly seam: production callers should run
 * this in a dedicated Worker and terminate that Worker for hard cancellation.
 * AbortSignal is also observed during loading/tree construction and is wired to
 * Manifold's ExecutionContext for kernel-supported cancellation.
 */
export async function evaluateCsg(
  value: unknown,
  evaluationOptions: CsgEvaluationOptions = {},
): Promise<CsgEvaluationResult> {
  const options = normalizeOptions(evaluationOptions);
  report(options, { phase: "validate", progress: 0 });
  throwIfAborted(options.signal);
  const definition = parseCsgDefinition(value);
  const definitionDigest = csgDefinitionDigest(definition);

  report(options, { phase: "load_engine", progress: 0.05 });
  const module = await loadManifoldModule();
  throwIfAborted(options.signal);

  let root: Manifold | undefined;
  let evaluated: Manifold | undefined;
  let context: ExecutionContext | undefined;
  const abort = (): void => context?.cancel();
  try {
    root = await buildNode(module, definition.root, options, { visitedNodes: 0 });
    throwIfAborted(options.signal);

    context = new module.ExecutionContext();
    options.signal?.addEventListener("abort", abort, { once: true });
    evaluated = root.withContext(context);
    report(options, { phase: "evaluate", progress: 0.55 });
    const status = evaluated.status();
    if (status === "Cancelled" || options.signal?.aborted) {
      throw new CsgEvaluationError("aborted", "CSG evaluation was cancelled");
    }
    if (status !== "NoError") {
      throw new CsgEvaluationError("kernel_error", `Manifold evaluation failed: ${status}`);
    }

    const vertexCount = evaluated.numVert();
    const triangleCount = evaluated.numTri();
    if (vertexCount > options.maxVertices || triangleCount > options.maxTriangles) {
      throw new CsgEvaluationError(
        "mesh_limit_exceeded",
        `CSG result has ${vertexCount} vertices/${triangleCount} triangles; limits are ${options.maxVertices}/${options.maxTriangles}`,
      );
    }

    const empty = evaluated.isEmpty();
    const bounds = empty ? null : spatialBounds(
      evaluated.boundingBox().min,
      evaluated.boundingBox().max,
    );
    if (bounds) validateBounds(bounds);
    const volumeM3 = normalizedZero(evaluated.volume());
    const surfaceAreaM2 = normalizedZero(evaluated.surfaceArea());
    const genus = empty ? null : evaluated.genus();
    const toleranceM = evaluated.tolerance();

    report(options, { phase: "extract_mesh", progress: 0.85 });
    const kernelMesh = evaluated.getMesh();
    const positions = extractPositions(kernelMesh.vertProperties, kernelMesh.numProp);
    const indices = kernelMesh.triVerts.slice();
    if (positions.length / 3 > options.maxVertices || indices.length / 3 > options.maxTriangles) {
      throw new CsgEvaluationError(
        "mesh_limit_exceeded",
        "CSG property mesh exceeds the configured vertex or triangle limit",
      );
    }
    for (const index of indices) {
      if (index >= positions.length / 3) {
        throw new CsgEvaluationError("kernel_error", "Manifold returned an out-of-range index");
      }
    }

    const mesh: CsgIndexedMesh = Object.freeze({
      format: "indexed-triangle-mesh",
      units: "metres",
      coordinateSystem: "right-handed-y-up",
      positions,
      indices,
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    });
    const publicOptions = Object.freeze({
      circularSegments: options.circularSegments,
      maxVertices: options.maxVertices,
      maxTriangles: options.maxTriangles,
    });
    const digest = resultDigest(definitionDigest, options, positions, indices);
    const diagnostics: CsgDiagnostics = Object.freeze({
      engine: CSG_ENGINE,
      status,
      manifold: true,
      watertight: true,
      empty,
      genus,
      toleranceM,
      surfaceAreaM2,
    });
    report(options, { phase: "complete", progress: 1 });
    return Object.freeze({
      definition,
      definitionDigest,
      resultDigest: digest,
      options: publicOptions,
      mesh,
      bounds,
      volumeM3,
      diagnostics,
    });
  } catch (error) {
    if (error instanceof CsgEvaluationError) throw error;
    if (options.signal?.aborted) {
      throw new CsgEvaluationError("aborted", "CSG evaluation was cancelled");
    }
    throw new CsgEvaluationError(
      "kernel_error",
      `Manifold evaluation failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
    evaluated?.delete();
    root?.delete();
    context?.delete();
  }
}
