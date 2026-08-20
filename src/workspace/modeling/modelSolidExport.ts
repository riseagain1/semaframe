import type { ComponentInstance, JSONObject, Vec3 } from "../components/componentTypes";
import { resolveComponentWorldTransform } from "../state/worldTransform";
import {
  assertModelDefinition,
  type ModelDefinition,
  type ModelDefinitionNode,
} from "./modelDefinitions";
import {
  CSG_DEFINITION_LIMITS,
  evaluateCsg,
  evaluateCsgInWorker,
  exportCsgMeshToBinaryStl,
  exportCsgMeshToObj,
  parseCsgDefinition,
  type CsgDefinition,
  type CsgEvaluationOptions,
  type CsgEvaluationResult,
  type EvaluateCsgInWorkerOptions,
  type CsgNode,
} from "./csg";
import { parseParametricPrimitive, type ParametricPrimitive } from "./parametricGeometry";
import {
  createCadWorkerKernel,
  type CreateCadWorkerKernelOptions,
} from "./cadWorkerClient";
import {
  CAD_KERNEL_LIMITS,
  type CadKernel,
  type CadMassProperties,
  type CadOperationOptions,
  type CadShapeHandle,
  type CadStepExport,
} from "./cadKernel";

export type ModelSolidExportErrorCode =
  | "empty_model"
  | "non_solid_primitive"
  | "csg_primitive_limit"
  | "cad_primitive_limit"
  | "non_affine_hierarchy_transform"
  | "unsupported_cad_primitive"
  | "non_uniform_cad_scale";

export class ModelSolidExportError extends Error {
  constructor(
    readonly code: ModelSolidExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelSolidExportError";
  }
}

type SolidNode = Readonly<{
  node: ModelDefinitionNode;
  primitive: ParametricPrimitive;
  transform: ReturnType<typeof resolveComponentWorldTransform>;
}>;

function componentsForDefinition(definition: ModelDefinition): Map<string, ComponentInstance> {
  return new Map(definition.nodes.map((node): [string, ComponentInstance] => [node.nodeId, {
    id: node.nodeId,
    type: structuredClone(node.componentType),
    label: node.label,
    props: structuredClone(node.props),
    durableState: structuredClone(node.durableState),
    placement: structuredClone(node.placement),
    ...(node.parentNodeId ? { parentId: node.parentNodeId } : {}),
    bindings: [],
    tags: [...node.tags],
    visibility: node.visibility,
    ...(node.visualEffects ? { visualEffects: structuredClone(node.visualEffects) } : {}),
    locks: {
      placement: false,
      resize: false,
      visualEffects: false,
      props: false,
      deletion: false,
      actions: false,
    },
    provenance: { createdRevision: definition.sourceRevision, createdBy: "system" },
  }]));
}

function vectorScaleIsUniform(value: Vec3): boolean {
  const tolerance = 1e-9 * Math.max(1, Math.abs(value.x), Math.abs(value.y), Math.abs(value.z));
  return Math.abs(value.x - value.y) <= tolerance && Math.abs(value.x - value.z) <= tolerance;
}

function vectorRotationIsIdentity(value: Vec3): boolean {
  return Math.abs(value.x) <= 1e-12
    && Math.abs(value.y) <= 1e-12
    && Math.abs(value.z) <= 1e-12;
}

/**
 * A quaternion plus component-wise scale cannot represent shear. Three.js
 * preserves the complete parentScale * childRotation matrix, so fail closed
 * when flattening this hierarchy would silently change exported geometry.
 */
function assertFlattenableTrs(
  components: ReadonlyMap<string, ComponentInstance>,
  componentId: string,
): void {
  const chain: ComponentInstance[] = [];
  const visiting = new Set<string>();
  let current = components.get(componentId);
  while (current) {
    if (visiting.has(current.id)) {
      throw new ModelSolidExportError(
        "non_affine_hierarchy_transform",
        `Model hierarchy cycle includes ${current.id}`,
      );
    }
    visiting.add(current.id);
    chain.push(current);
    current = current.parentId ? components.get(current.parentId) : undefined;
  }
  chain.reverse();

  let ancestorScale: Vec3 = { x: 1, y: 1, z: 1 };
  let scaleSourceId: string | undefined;
  for (const component of chain) {
    if (component.placement.space !== "world3d") continue;
    if (!vectorScaleIsUniform(ancestorScale)
      && !vectorRotationIsIdentity(component.placement.rotation)) {
      throw new ModelSolidExportError(
        "non_affine_hierarchy_transform",
        `Model node ${component.id} is rotated beneath non-uniform scale from ${scaleSourceId ?? "an ancestor"}; solid export cannot preserve that affine transform exactly. Use uniform ancestor scale or bake the hierarchy first.`,
      );
    }
    ancestorScale = {
      x: ancestorScale.x * component.placement.scale.x,
      y: ancestorScale.y * component.placement.scale.y,
      z: ancestorScale.z * component.placement.scale.z,
    };
    scaleSourceId = vectorScaleIsUniform(ancestorScale) ? undefined : component.id;
  }
}

function solidNodes(definition: ModelDefinition): SolidNode[] {
  assertModelDefinition(definition);
  const components = componentsForDefinition(definition);
  const result = definition.nodes
    .filter((node) => node.componentType.typeId === "spatial-primitive")
    .map((node) => {
      assertFlattenableTrs(components, node.nodeId);
      return {
        node,
        primitive: parseParametricPrimitive(node.props.geometry),
        transform: resolveComponentWorldTransform(components, node.nodeId),
      };
    });
  if (!result.length) {
    throw new ModelSolidExportError("empty_model", "A solid export requires at least one spatial primitive");
  }
  return result;
}

function csgLeaf(entry: SolidNode): CsgNode {
  if (entry.primitive.kind === "plane") {
    throw new ModelSolidExportError(
      "non_solid_primitive",
      `Model node ${entry.node.nodeId} is a plane; planes cannot participate in a watertight solid export`,
    );
  }
  return {
    kind: "primitive",
    primitive: entry.primitive,
    transform: {
      translationM: structuredClone(entry.transform.position),
      rotationQuaternion: structuredClone(entry.transform.rotation),
      scale: structuredClone(entry.transform.scale),
    },
  };
}

function balancedUnion(leaves: readonly CsgNode[], start = 0, end = leaves.length): CsgNode {
  if (end - start === 1) return leaves[start]!;
  const middle = start + Math.floor((end - start) / 2);
  return {
    kind: "union",
    left: balancedUnion(leaves, start, middle),
    right: balancedUnion(leaves, middle, end),
  };
}

/** Convert a reusable model assembly into a deterministic, depth-bounded union-only solid tree. */
export function modelDefinitionToCsgDefinition(definition: ModelDefinition): CsgDefinition {
  const leaves = solidNodes(definition).map(csgLeaf);
  if (leaves.length > CSG_DEFINITION_LIMITS.maximumLeaves) {
    throw new ModelSolidExportError(
      "csg_primitive_limit",
      `STL/OBJ export supports at most ${CSG_DEFINITION_LIMITS.maximumLeaves} solid primitives; this model contains ${leaves.length}.`,
    );
  }
  const root = balancedUnion(leaves);
  return parseCsgDefinition({ version: 1, root });
}

export type ModelCsgCompatibility = Readonly<{
  supported: boolean;
  reason?: string;
}>;

/** Cheap synchronous gate used by the Models panel before allocating a CSG Worker. */
export function modelDefinitionCsgCompatibility(
  definition: ModelDefinition,
): ModelCsgCompatibility {
  try {
    modelDefinitionToCsgDefinition(definition);
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : "This model is outside the STL/OBJ export subset.",
    };
  }
}

export type ModelCsgExportResult = Readonly<{
  evaluation: CsgEvaluationResult;
  obj: string;
  stl: Uint8Array;
}>;

export type ModelCsgArtifactFormat = "obj" | "stl";

export type ModelCsgObjArtifactResult = Readonly<{
  format: "obj";
  evaluation: CsgEvaluationResult;
  obj: string;
}>;

export type ModelCsgStlArtifactResult = Readonly<{
  format: "stl";
  evaluation: CsgEvaluationResult;
  stl: Uint8Array;
}>;

export type ModelCsgArtifactResult = ModelCsgObjArtifactResult | ModelCsgStlArtifactResult;

function assertExportableEvaluation(evaluation: CsgEvaluationResult): void {
  if (evaluation.diagnostics.empty || !evaluation.diagnostics.manifold) {
    throw new ModelSolidExportError(
      "empty_model",
      "The model did not evaluate to a non-empty manifold solid",
    );
  }
}

function packageCsgArtifact(
  definition: ModelDefinition,
  evaluation: CsgEvaluationResult,
  format: ModelCsgArtifactFormat,
): ModelCsgArtifactResult {
  assertExportableEvaluation(evaluation);
  if (format === "obj") {
    return Object.freeze({
      format,
      evaluation,
      obj: exportCsgMeshToObj(evaluation.mesh, { name: definition.displayName }),
    });
  }
  return Object.freeze({
    format,
    evaluation,
    stl: exportCsgMeshToBinaryStl(evaluation.mesh, { name: definition.displayName }),
  });
}

function packageCsgExport(
  definition: ModelDefinition,
  evaluation: CsgEvaluationResult,
): ModelCsgExportResult {
  assertExportableEvaluation(evaluation);
  return Object.freeze({
    evaluation,
    obj: exportCsgMeshToObj(evaluation.mesh, { name: definition.displayName }),
    stl: exportCsgMeshToBinaryStl(evaluation.mesh, { name: definition.displayName }),
  });
}

/** Evaluate and package the model as a bounded watertight mesh export. */
export async function exportModelDefinitionToCsg(
  definition: ModelDefinition,
  options: CsgEvaluationOptions = {},
): Promise<ModelCsgExportResult> {
  const evaluation = await evaluateCsg(modelDefinitionToCsgDefinition(definition), options);
  return packageCsgExport(definition, evaluation);
}

/** Production browser path: identical output with hard cancellation in a Worker. */
export async function exportModelDefinitionToCsgInWorker(
  definition: ModelDefinition,
  options: EvaluateCsgInWorkerOptions = {},
): Promise<ModelCsgExportResult> {
  const evaluation = await evaluateCsgInWorker(modelDefinitionToCsgDefinition(definition), options);
  return packageCsgExport(definition, evaluation);
}

/**
 * Evaluate and materialize exactly one mesh artifact. This keeps the existing
 * combined API intact while bounding peak memory for single-format callers.
 */
export function exportModelDefinitionCsgArtifact(
  definition: ModelDefinition,
  format: "obj",
  options?: CsgEvaluationOptions,
): Promise<ModelCsgObjArtifactResult>;
export function exportModelDefinitionCsgArtifact(
  definition: ModelDefinition,
  format: "stl",
  options?: CsgEvaluationOptions,
): Promise<ModelCsgStlArtifactResult>;
export function exportModelDefinitionCsgArtifact(
  definition: ModelDefinition,
  format: ModelCsgArtifactFormat,
  options?: CsgEvaluationOptions,
): Promise<ModelCsgArtifactResult>;
export async function exportModelDefinitionCsgArtifact(
  definition: ModelDefinition,
  format: ModelCsgArtifactFormat,
  options: CsgEvaluationOptions = {},
): Promise<ModelCsgArtifactResult> {
  const evaluation = await evaluateCsg(modelDefinitionToCsgDefinition(definition), options);
  return packageCsgArtifact(definition, evaluation, format);
}

/** Production browser path that evaluates in a Worker and builds only the requested artifact. */
export function exportModelDefinitionCsgArtifactInWorker(
  definition: ModelDefinition,
  format: "obj",
  options?: EvaluateCsgInWorkerOptions,
): Promise<ModelCsgObjArtifactResult>;
export function exportModelDefinitionCsgArtifactInWorker(
  definition: ModelDefinition,
  format: "stl",
  options?: EvaluateCsgInWorkerOptions,
): Promise<ModelCsgStlArtifactResult>;
export function exportModelDefinitionCsgArtifactInWorker(
  definition: ModelDefinition,
  format: ModelCsgArtifactFormat,
  options?: EvaluateCsgInWorkerOptions,
): Promise<ModelCsgArtifactResult>;
export async function exportModelDefinitionCsgArtifactInWorker(
  definition: ModelDefinition,
  format: ModelCsgArtifactFormat,
  options: EvaluateCsgInWorkerOptions = {},
): Promise<ModelCsgArtifactResult> {
  const evaluation = await evaluateCsgInWorker(modelDefinitionToCsgDefinition(definition), options);
  return packageCsgArtifact(definition, evaluation, format);
}

function isZeroVector(value: Vec3): boolean {
  return value.x === 0 && value.y === 0 && value.z === 0;
}

function isIdentityQuaternion(value: Readonly<{ x: number; y: number; z: number; w: number }>): boolean {
  return value.x === 0 && value.y === 0 && value.z === 0 && value.w === 1;
}

function uniformScale(value: Vec3, nodeId: string): number {
  const tolerance = 1e-9 * Math.max(1, Math.abs(value.x), Math.abs(value.y), Math.abs(value.z));
  if (Math.abs(value.x - value.y) > tolerance || Math.abs(value.x - value.z) > tolerance) {
    throw new ModelSolidExportError(
      "non_uniform_cad_scale",
      `Model node ${nodeId} has non-uniform world scale; the v1 B-rep export supports uniform assembly scale only`,
    );
  }
  return value.x;
}

function axisAngle(value: Readonly<{ x: number; y: number; z: number; w: number }>) {
  const w = Math.max(-1, Math.min(1, value.w));
  const angleRad = 2 * Math.acos(w);
  const denominator = Math.sqrt(Math.max(0, 1 - w * w));
  if (angleRad < 1e-12 || denominator < 1e-12) return undefined;
  return {
    axis: { x: value.x / denominator, y: value.y / denominator, z: value.z / denominator },
    angleRad,
  };
}

async function createCadPrimitive(
  kernel: CadKernel,
  primitive: ParametricPrimitive,
  options: CadOperationOptions,
): Promise<CadShapeHandle> {
  switch (primitive.kind) {
    case "box":
      return kernel.createBox({ sizeM: primitive.sizeM }, options);
    case "sphere":
      return kernel.createSphere({ radiusM: primitive.radiusM }, options);
    case "cylinder":
      return kernel.createCylinder({
        radiusM: primitive.radiusM,
        heightM: primitive.heightM,
        axis: primitive.axis,
      }, options);
    case "cone":
    case "capsule":
    case "plane":
      throw new ModelSolidExportError(
        "unsupported_cad_primitive",
        `STEP v1 supports box, sphere, and cylinder nodes; ${primitive.kind} requires the mesh-solid export`,
      );
  }
}

export type ModelStepExportOptions = CadOperationOptions & Readonly<{
  kernel?: CadKernel;
  worker?: CreateCadWorkerKernelOptions;
  densityKgM3?: number;
}>;

export type ModelStepExportResult = Readonly<{
  step: CadStepExport;
  properties: CadMassProperties;
}>;

export type ModelStepCompatibility = Readonly<{
  supported: boolean;
  reason?: string;
}>;

const MAX_CAD_UNION_PRIMITIVES = Math.floor((CAD_KERNEL_LIMITS.maximumBooleanComplexity + 1) / 2);

function assertCadPrimitiveCount(entries: readonly SolidNode[]): void {
  if (entries.length > MAX_CAD_UNION_PRIMITIVES) {
    throw new ModelSolidExportError(
      "cad_primitive_limit",
      `STEP export supports at most ${MAX_CAD_UNION_PRIMITIVES} solid primitives; this model contains ${entries.length}.`,
    );
  }
}

/** Cheap synchronous gate used by the UI before the heavy CAD worker loads. */
export function modelDefinitionStepCompatibility(
  definition: ModelDefinition,
): ModelStepCompatibility {
  try {
    const entries = solidNodes(definition);
    assertCadPrimitiveCount(entries);
    for (const entry of entries) {
      if (entry.primitive.kind !== "box"
        && entry.primitive.kind !== "sphere"
        && entry.primitive.kind !== "cylinder") {
        return {
          supported: false,
          reason: `STEP v1 supports box, sphere, and cylinder nodes; ${entry.primitive.kind} is available through STL/OBJ.`,
        };
      }
      uniformScale(entry.transform.scale, entry.node.nodeId);
    }
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : "This model is outside the STEP v1 subset.",
    };
  }
}

/**
 * Fuse the supported model subset with the real browser OCCT kernel and emit
 * AP242 STEP. The default path owns and hard-cancels a dedicated Worker.
 */
export async function exportModelDefinitionToStep(
  definition: ModelDefinition,
  options: ModelStepExportOptions = {},
): Promise<ModelStepExportResult> {
  const entries = solidNodes(definition);
  assertCadPrimitiveCount(entries);
  const ownsKernel = options.kernel === undefined;
  const kernel = options.kernel ?? await createCadWorkerKernel(options.worker);
  const operationOptions: CadOperationOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  };
  const live = new Map<string, CadShapeHandle>();
  const track = (handle: CadShapeHandle): CadShapeHandle => {
    live.set(handle.id, handle);
    return handle;
  };
  const release = async (handle: CadShapeHandle): Promise<void> => {
    if (!live.delete(handle.id)) return;
    await kernel.release(handle);
  };

  try {
    let combined: CadShapeHandle | undefined;
    for (const entry of entries) {
      let handle = track(await createCadPrimitive(kernel, entry.primitive, operationOptions));
      const scale = uniformScale(entry.transform.scale, entry.node.nodeId);
      const rotation = axisAngle(entry.transform.rotation);
      const translation = entry.transform.position;
      if (scale !== 1 || rotation || !isZeroVector(translation)) {
        const transformed = track(await kernel.transform(handle, {
          ...(scale === 1 ? {} : { uniformScale: scale }),
          ...(rotation ? { rotation } : {}),
          ...(isZeroVector(translation) ? {} : { translationM: translation }),
        }, operationOptions));
        await release(handle);
        handle = transformed;
      }
      if (!combined) {
        combined = handle;
      } else {
        const next = track(await kernel.boolean("union", combined, handle, operationOptions));
        await release(combined);
        await release(handle);
        combined = next;
      }
    }
    if (!combined) throw new ModelSolidExportError("empty_model", "A STEP export requires a solid");
    const validation = await kernel.validate(combined, operationOptions);
    if (!validation.valid || validation.isNull) {
      throw new ModelSolidExportError("empty_model", "The fused B-rep is null or invalid");
    }
    const properties = await kernel.measure(combined, options.densityKgM3 ?? 1, operationOptions);
    const step = await kernel.exportStep(combined, definition.displayName, operationOptions);
    await release(combined);
    return Object.freeze({ step, properties });
  } finally {
    await Promise.allSettled([...live.values()].map((handle) => kernel.release(handle)));
    live.clear();
    if (ownsKernel) await kernel.dispose();
  }
}

/** Helper for exact JSON stores/tests without widening the public DTO. */
export function modelNodeGeometry(node: ModelDefinitionNode): JSONObject {
  return structuredClone(node.props.geometry as JSONObject);
}
