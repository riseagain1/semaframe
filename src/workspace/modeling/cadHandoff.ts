import type { JSONObject, World3DPlacement } from "../components/componentTypes";
import {
  deterministicDigest,
  stableStringify,
} from "../components/manifestDigest";
import {
  assertModelDefinition,
  type ModelDefinition,
  type ModelDefinitionNode,
} from "./modelDefinitions";
import {
  deriveParametricVolumeM3,
  parseParametricPrimitive,
  type ParametricPrimitive,
} from "./parametricGeometry";
import {
  cadPartDefinitionDigest,
  parseCadPartDefinition,
  type CadPartDefinitionV1,
} from "./cad/cadDocument";
import { exportParametricModelToUsda } from "./openUsdExporter";
import { modelDefinitionToOpenUsdDocument } from "./workspaceOpenUsd";
import { createDeterministicCadHandoffArchive } from "./cadHandoffArchive";
import {
  CAD_HANDOFF_MAX_PARTS,
  exportCadHandoffAssemblyWithOcct,
  type CadHandoffOcctDocument,
  type CadHandoffOcctRuntimeLoader,
  type CadHandoffOcctVerification,
  type CadHandoffQuaternion,
  type CadHandoffRigidTransform,
  type CadHandoffSurfaceColor,
} from "./cadHandoffOcct";

export const CAD_HANDOFF_FORMAT_VERSION = "2.0" as const;
export const CAD_HANDOFF_GENERATOR_VERSION = "2.0.0" as const;

export const CAD_HANDOFF_PATHS = Object.freeze({
  step: "model.step",
  usda: "model.usda",
  manifest: "semaframe-cad.json",
  report: "report.json",
});

export type CadHandoffSha256 = `sha256:${string}`;

export type CadHandoffArtifact = Readonly<{
  path: string;
  mediaType: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: CadHandoffSha256;
}>;

export type CadHandoffNodeMapping = Readonly<{
  semaframeNodeId: string;
  sourceComponentId: string;
  logicalNodeId?: string;
  parentNodeId?: string;
  kind: "assembly" | "part";
  humanName: string;
  partNumber?: string;
  materialName?: string;
  stepDefinitionName: string;
  stepOccurrenceName?: string;
  stepBodyDefinitions?: readonly Readonly<{
    bodyId: string;
    definitionName: string;
    occurrenceName: string;
  }>[];
  usdPrimPath: string;
  localTransform: Readonly<{
    translationM: Readonly<{ x: number; y: number; z: number }>;
    rotationEulerXyzRad: Readonly<{ x: number; y: number; z: number }>;
    scale: Readonly<{ x: number; y: number; z: number }>;
  }>;
  geometry?: ParametricPrimitive | Readonly<{
    kind: "cad-part";
    definitionDigest: string;
    activeBodyIds: readonly string[];
    definition: CadPartDefinitionV1;
  }>;
  material?: JSONObject;
  visible: boolean;
}>;

export type CadHandoffManifest = Readonly<{
  format: "semaframe-cad-handoff";
  version: typeof CAD_HANDOFF_FORMAT_VERSION;
  generator: Readonly<{ name: "SemaFrame"; version: typeof CAD_HANDOFF_GENERATOR_VERSION }>;
  source: Readonly<{
    modelId: string;
    modelVersion: string;
    modelDigest: string;
    sourceRevision: number;
  }>;
  /** Full immutable SemaFrame recipe so CAD history and assembly semantics remain editable. */
  editableModelDefinition: ModelDefinition;
  authoritativeGeometry: typeof CAD_HANDOFF_PATHS.step;
  sceneDescription: typeof CAD_HANDOFF_PATHS.usda;
  report: typeof CAD_HANDOFF_PATHS.report;
  units: "metre";
  coordinateSystem: Readonly<{
    handedness: "right";
    upAxis: "Y";
    transformOrder: "translate-rotate-scale";
  }>;
  files: readonly Readonly<{
    path: string;
    mediaType: string;
    byteLength: number;
    sha256: CadHandoffSha256;
  }>[];
  nodes: readonly CadHandoffNodeMapping[];
  editability: Readonly<{
    stepGeometry: "exact-brep-direct-editable";
    assemblyStructure: "xcaf-product-occurrences";
    nativeCadFeatureHistory: false;
    semaframeRecipe: "embedded-in-sidecar";
  }>;
}>;

export type CadHandoffReport = Readonly<{
  format: "semaframe-cad-report";
  version: typeof CAD_HANDOFF_FORMAT_VERSION;
  outcome: "passed";
  source: CadHandoffManifest["source"];
  artifactsVerified: readonly Readonly<{
    path: string;
    byteLength: number;
    sha256: CadHandoffSha256;
  }>[];
  export: Readonly<{
    schema: "STEP AP242";
    units: "metre";
    exactBrep: true;
    booleanUnionAppliedAcrossParts: false;
    partCount: number;
    modelAssemblyCount: number;
    cadPartAssemblyCount: number;
    stepContainerAssemblyCount: number;
    occurrenceCount: number;
    names: "definition-and-occurrence";
    colors: "surface-rgb";
    uniformScaleHandling: "baked-into-part-brep";
  }>;
  occtRoundTrip: CadHandoffOcctVerification;
  limitations: readonly string[];
}>;

export type CadHandoffPackage = Readonly<{
  format: "semaframe-cad-package";
  version: typeof CAD_HANDOFF_FORMAT_VERSION;
  archive: CadHandoffArtifact;
  files: readonly CadHandoffArtifact[];
  manifest: CadHandoffManifest;
  report: CadHandoffReport;
}>;

export type CreateModelCadHandoffOptions = Readonly<{
  runtimeLoader?: CadHandoffOcctRuntimeLoader;
  volumeRelativeTolerance?: number;
}>;

export type CadHandoffErrorCode =
  | "invalid_model"
  | "unsupported_component"
  | "unsupported_primitive"
  | "non_uniform_scale"
  | "invalid_scale"
  | "invalid_options"
  | "hash_unavailable"
  | "aborted"
  | "operation_timeout"
  | "worker_failed"
  | "export_failed";

export class CadHandoffError extends Error {
  constructor(
    readonly code: CadHandoffErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CadHandoffError";
  }
}

type ModelAdapterResult = Readonly<{
  occtDocument: CadHandoffOcctDocument;
  expectedVolumeM3?: number;
  modelAssemblyCount: number;
  cadPartAssemblyCount: number;
  stepNames: ReadonlyMap<string, Readonly<{
    definitionName: string;
    occurrenceName?: string;
    bodyDefinitions?: readonly Readonly<{
      bodyId: string;
      definitionName: string;
      occurrenceName: string;
    }>[];
  }>>;
}>;

const encoder = new TextEncoder();
const UNIFORM_SCALE_TOLERANCE = 1e-9;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(
  code: CadHandoffErrorCode,
  message: string,
  cause?: unknown,
): never {
  const options = cause === undefined
    ? undefined
    : { cause: cause instanceof Error ? cause : new Error(String(cause)) };
  throw new CadHandoffError(code, message, options);
}

function normalizedQuaternion(value: CadHandoffQuaternion): CadHandoffQuaternion {
  const magnitude = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(magnitude) || magnitude < 1e-12) {
    fail("invalid_model", "Model placement contains an invalid rotation");
  }
  return Object.freeze({
    x: value.x / magnitude,
    y: value.y / magnitude,
    z: value.z / magnitude,
    w: value.w / magnitude,
  });
}

function quaternionFromEulerXyz(
  rotation: World3DPlacement["rotation"],
): CadHandoffQuaternion {
  const cx = Math.cos(rotation.x / 2);
  const sx = Math.sin(rotation.x / 2);
  const cy = Math.cos(rotation.y / 2);
  const sy = Math.sin(rotation.y / 2);
  const cz = Math.cos(rotation.z / 2);
  const sz = Math.sin(rotation.z / 2);
  return normalizedQuaternion({
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  });
}

function uniformPositiveScale(node: ModelDefinitionNode): number {
  const { x, y, z } = node.placement.scale;
  if (![x, y, z].every(Number.isFinite) || x <= 0 || y <= 0 || z <= 0) {
    fail("invalid_scale", `Model node ${node.nodeId} must have positive finite scale`);
  }
  const tolerance = UNIFORM_SCALE_TOLERANCE * Math.max(1, Math.abs(x), Math.abs(y), Math.abs(z));
  if (Math.abs(x - y) > tolerance || Math.abs(x - z) > tolerance) {
    fail(
      "non_uniform_scale",
      `Model node ${node.nodeId} uses non-uniform scale; exact XCAF occurrences are rigid, so V2 fails closed instead of shearing CAD geometry`,
    );
  }
  return x;
}

function colorByte(value: string, start: number): number {
  return Number.parseInt(value.slice(start, start + 2), 16) / 255;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function materialRecord(value: unknown): JSONObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as JSONObject)
    : {};
}

function surfaceColor(value: unknown): CadHandoffSurfaceColor {
  const material = materialRecord(value);
  const base = typeof material.baseColor === "string"
    && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(material.baseColor)
    ? material.baseColor
    : "#68D5FF";
  const materialOpacity = typeof material.opacity === "number" && Number.isFinite(material.opacity)
    ? Math.max(0, Math.min(1, material.opacity))
    : 1;
  const encodedAlpha = base.length === 9 ? colorByte(base, 7) : 1;
  return Object.freeze({
    red: srgbToLinear(colorByte(base, 1)),
    green: srgbToLinear(colorByte(base, 3)),
    blue: srgbToLinear(colorByte(base, 5)),
    alpha: encodedAlpha * materialOpacity,
  });
}

function stableNodeToken(nodeId: string): string {
  return deterministicDigest({ nodeId }).slice("fnv1a32:".length).toUpperCase();
}

function cleanHumanName(value: string, fallback: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return (cleaned || fallback).slice(0, 160);
}

function definitionName(node: ModelDefinitionNode): string {
  const kind = node.componentType.typeId === "model-assembly" ? "ASM" : "PART";
  const partNumber = "partNumber" in node && node.partNumber
    ? ` (${cleanHumanName(node.partNumber, node.nodeId)})`
    : "";
  return `${cleanHumanName(node.label, node.nodeId)}${partNumber} [SF:${kind}:${stableNodeToken(node.nodeId)}]`;
}

function occurrenceName(node: ModelDefinitionNode): string {
  return `${cleanHumanName(node.label, node.nodeId)} [SF:OCC:${stableNodeToken(node.nodeId)}]`;
}

function cadBodyNodeId(nodeId: string, bodyId: string): string {
  return `${nodeId}#cad-body:${bodyId}`;
}

function cadBodyDefinitionName(node: ModelDefinitionNode, bodyId: string): string {
  return `${cleanHumanName(node.label, node.nodeId)} / ${cleanHumanName(bodyId, "body")} [SF:PART:${stableNodeToken(cadBodyNodeId(node.nodeId, bodyId))}]`;
}

function cadBodyOccurrenceName(node: ModelDefinitionNode, bodyId: string): string {
  return `${cleanHumanName(bodyId, "body")} [SF:OCC:${stableNodeToken(cadBodyNodeId(node.nodeId, bodyId))}]`;
}

function rigidTransform(
  placement: World3DPlacement,
  translationScale: number,
): CadHandoffRigidTransform {
  return Object.freeze({
    translationM: Object.freeze({
      x: placement.position.x * translationScale,
      y: placement.position.y * translationScale,
      z: placement.position.z * translationScale,
    }),
    rotationQuaternion: quaternionFromEulerXyz(placement.rotation),
  });
}

function adaptModelDefinition(definition: ModelDefinition): ModelAdapterResult {
  try {
    assertModelDefinition(definition);
  } catch (error) {
    fail("invalid_model", "CAD handoff requires a valid immutable model definition", error);
  }
  const nodes = new Map(definition.nodes.map((node) => [node.nodeId, node]));
  const root = nodes.get(definition.rootNodeId);
  if (root === undefined || root.componentType.typeId !== "model-assembly") {
    fail("invalid_model", "CAD handoff root must be a model assembly");
  }
  const children = new Map<string, ModelDefinitionNode[]>();
  for (const node of definition.nodes) {
    if (node.nodeId === definition.rootNodeId) {
      if (node.parentNodeId !== undefined) {
        fail("invalid_model", "CAD handoff root cannot have a parent");
      }
      continue;
    }
    if (node.parentNodeId === undefined) {
      fail("invalid_model", `Model node ${node.nodeId} is disconnected from the root`);
    }
    const parent = nodes.get(node.parentNodeId);
    if (parent?.componentType.typeId !== "model-assembly") {
      fail("invalid_model", `Model node ${node.nodeId} must be owned by an assembly`);
    }
    const siblings = children.get(node.parentNodeId) ?? [];
    siblings.push(node);
    children.set(node.parentNodeId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => compareText(left.nodeId, right.nodeId));
  }

  const cumulativeScale = new Map<string, number>();
  const visited = new Set<string>();
  const visit = (node: ModelDefinitionNode, parentScale: number): void => {
    if (visited.has(node.nodeId)) fail("invalid_model", `Model hierarchy repeats ${node.nodeId}`);
    visited.add(node.nodeId);
    const scale = parentScale * uniformPositiveScale(node);
    cumulativeScale.set(node.nodeId, scale);
    for (const child of children.get(node.nodeId) ?? []) visit(child, scale);
  };
  visit(root, 1);
  if (visited.size !== definition.nodes.length) {
    fail("invalid_model", "CAD handoff model contains nodes outside the root hierarchy");
  }

  const modelAssemblyNodes = definition.nodes
    .filter((node) => node.componentType.typeId === "model-assembly");
  const cadPartNodes = definition.nodes
    .filter((node) => node.componentType.typeId === "cad-part");
  const cadDefinitions = new Map<string, ReturnType<typeof parseCadPartDefinition>>();
  for (const node of cadPartNodes) {
    try {
      const cadDefinition = parseCadPartDefinition(node.props.definition);
      const digest = cadPartDefinitionDigest(cadDefinition);
      if (node.props.definitionDigest !== digest) {
        fail("invalid_model", `CAD part ${node.nodeId} definition digest is stale or missing`);
      }
      if (cadDefinition.activeBodyIds.length === 0) {
        fail("invalid_model", `CAD part ${node.nodeId} has no active solid bodies`);
      }
      cadDefinitions.set(node.nodeId, cadDefinition);
    } catch (error) {
      if (error instanceof CadHandoffError) throw error;
      fail("invalid_model", `CAD part ${node.nodeId} has an invalid editable definition`, error);
    }
  }
  const assemblies = [
    ...modelAssemblyNodes,
    ...cadPartNodes,
  ].map((node) => Object.freeze({
    nodeId: node.nodeId,
    definitionName: definitionName(node),
    visible: node.visibility === "visible",
  }));
  const parts: CadHandoffOcctDocument["parts"][number][] = [];
  for (const node of definition.nodes) {
    if (node.componentType.typeId === "model-assembly") continue;
    if (node.componentType.typeId === "spatial-primitive") {
      const primitive = parseParametricPrimitive(node.props.geometry);
      if (primitive.kind === "plane" || primitive.kind === "cone" || primitive.kind === "capsule") {
        fail(
          "unsupported_primitive",
          `Exact AP242 handoff currently supports box, sphere, and cylinder parts; ${node.nodeId} is ${primitive.kind}`,
        );
      }
      parts.push(Object.freeze({
        nodeId: node.nodeId,
        definitionName: definitionName(node),
        sourceKind: "primitive",
        primitive,
        bakedUniformScale: cumulativeScale.get(node.nodeId)!,
        color: surfaceColor(node.props.material),
        visible: node.visibility === "visible",
      }));
      continue;
    }
    if (node.componentType.typeId === "cad-part") {
      const cadDefinition = cadDefinitions.get(node.nodeId)!;
      for (const bodyId of cadDefinition.activeBodyIds) {
        parts.push(Object.freeze({
          nodeId: cadBodyNodeId(node.nodeId, bodyId),
          definitionName: cadBodyDefinitionName(node, bodyId),
          sourceKind: "cad-part-body",
          sourceComponentNodeId: node.nodeId,
          bodyId,
          definition: cadDefinition,
          bakedUniformScale: cumulativeScale.get(node.nodeId)!,
          color: surfaceColor(node.props.material),
          visible: node.visibility === "visible",
        }));
      }
      continue;
    }
    fail(
      "unsupported_component",
      `Exact AP242 handoff does not support component type ${node.componentType.typeId}`,
    );
  }
  if (parts.length === 0) fail("invalid_model", "CAD handoff requires at least one solid part");
  if (parts.length > CAD_HANDOFF_MAX_PARTS) {
    fail(
      "invalid_model",
      `CAD handoff supports at most ${CAD_HANDOFF_MAX_PARTS} solid parts; this model expands to ${parts.length}`,
    );
  }

  const modelOccurrences = definition.nodes
    .filter((node) => node.nodeId !== definition.rootNodeId)
    .map((node) => {
      const parentId = node.parentNodeId!;
      return Object.freeze({
        nodeId: node.nodeId,
        parentAssemblyNodeId: parentId,
        childNodeId: node.nodeId,
        occurrenceName: occurrenceName(node),
        transform: rigidTransform(node.placement, cumulativeScale.get(parentId)!),
      });
    });
  const identityTransform = Object.freeze({
    translationM: Object.freeze({ x: 0, y: 0, z: 0 }),
    rotationQuaternion: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }),
  });
  const cadBodyOccurrences = cadPartNodes.flatMap((node) => {
    const cadDefinition = cadDefinitions.get(node.nodeId)!;
    return cadDefinition.activeBodyIds.map((bodyId) => Object.freeze({
      nodeId: cadBodyNodeId(node.nodeId, bodyId),
      parentAssemblyNodeId: node.nodeId,
      childNodeId: cadBodyNodeId(node.nodeId, bodyId),
      occurrenceName: cadBodyOccurrenceName(node, bodyId),
      transform: identityTransform,
    }));
  });
  const occurrences = [...modelOccurrences, ...cadBodyOccurrences];
  const stepNames = new Map(definition.nodes.map((node) => {
    const cadDefinition = cadDefinitions.get(node.nodeId);
    return [node.nodeId, Object.freeze({
      definitionName: definitionName(node),
      occurrenceName: occurrenceName(node),
      ...(cadDefinition ? {
        bodyDefinitions: Object.freeze(cadDefinition.activeBodyIds.map((bodyId) => Object.freeze({
          bodyId,
          definitionName: cadBodyDefinitionName(node, bodyId),
          occurrenceName: cadBodyOccurrenceName(node, bodyId),
        }))),
      } : {}),
    })] as const;
  }));
  const expectedVolumeM3 = cadPartNodes.length === 0
    ? parts.reduce((total, part) => (
        part.sourceKind === "primitive"
          ? total + deriveParametricVolumeM3(part.primitive) * part.bakedUniformScale ** 3
          : total
      ), 0)
    : undefined;
  return Object.freeze({
    ...(expectedVolumeM3 === undefined ? {} : { expectedVolumeM3 }),
    modelAssemblyCount: modelAssemblyNodes.length,
    cadPartAssemblyCount: cadPartNodes.length,
    stepNames,
    occtDocument: Object.freeze({
      documentName: `${definition.displayName} AP242 handoff`,
      containerName: `${cleanHumanName(definition.displayName, definition.modelId)} [SF:HANDOFF]`,
      rootNodeId: definition.rootNodeId,
      parts,
      assemblies,
      occurrences,
      rootOccurrence: Object.freeze({
        occurrenceName: occurrenceName(root),
        transform: rigidTransform(root.placement, 1),
      }),
    }),
  });
}

async function sha256(bytes: Uint8Array): Promise<CadHandoffSha256> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) fail("hash_unavailable", "Web Crypto SHA-256 is unavailable");
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(await subtle.digest("SHA-256", copy.buffer));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${stableStringify(value)}\n`);
}

async function artifact(
  path: string,
  mediaType: string,
  bytes: Uint8Array,
): Promise<CadHandoffArtifact> {
  return Object.freeze({
    path,
    mediaType,
    bytes,
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes),
  });
}

function artifactDescriptor(value: CadHandoffArtifact) {
  return Object.freeze({
    path: value.path,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    sha256: value.sha256,
  });
}

function reportArtifactDescriptor(value: CadHandoffArtifact) {
  return Object.freeze({
    path: value.path,
    byteLength: value.byteLength,
    sha256: value.sha256,
  });
}

function archiveSlug(definition: ModelDefinition): string {
  const value = `${definition.modelId}-${definition.version}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return value || `semaframe-${stableNodeToken(definition.modelId).toLowerCase()}`;
}

export type ModelDefinitionCadHandoffCompatibility = Readonly<{
  supported: boolean;
  reason?: string;
}>;

/** Fast, side-effect-free UI gate; the Worker still repeats every check. */
export function modelDefinitionCadHandoffCompatibility(
  definition: ModelDefinition,
): ModelDefinitionCadHandoffCompatibility {
  try {
    adaptModelDefinition(definition);
    return Object.freeze({ supported: true });
  } catch (error) {
    return Object.freeze({
      supported: false,
      reason: error instanceof Error ? error.message : "This model is outside the exact CAD handoff subset.",
    });
  }
}

/**
 * Build a reproducible CAD handoff: an authoritative non-unioned AP242/XCAF
 * assembly, a human/agent-readable USDA twin, canonical sidecar and report,
 * plus a deterministic ZIP containing those four files.
 */
export async function createModelDefinitionCadHandoffPackage(
  definition: ModelDefinition,
  options: CreateModelCadHandoffOptions = {},
): Promise<CadHandoffPackage> {
  try {
    const adapted = adaptModelDefinition(definition);
    const [step, usd] = await Promise.all([
      exportCadHandoffAssemblyWithOcct(adapted.occtDocument, {
        ...(adapted.expectedVolumeM3 === undefined
          ? {}
          : { expectedVolumeM3: adapted.expectedVolumeM3 }),
        ...(options.runtimeLoader ? { runtimeLoader: options.runtimeLoader } : {}),
        ...(options.volumeRelativeTolerance === undefined
          ? {}
          : { volumeRelativeTolerance: options.volumeRelativeTolerance }),
      }),
      Promise.resolve(exportParametricModelToUsda(modelDefinitionToOpenUsdDocument(definition))),
    ]);
    const stepArtifact = await artifact(
      CAD_HANDOFF_PATHS.step,
      "application/step",
      encoder.encode(step.stepText),
    );
    const usdArtifact = await artifact(
      CAD_HANDOFF_PATHS.usda,
      "model/vnd.usda",
      encoder.encode(usd.usda),
    );
    const nodes = [...definition.nodes]
      .sort((left, right) => compareText(left.nodeId, right.nodeId))
      .map((node): CadHandoffNodeMapping => {
        const names = adapted.stepNames.get(node.nodeId);
        const usdPrimPath = usd.nodePrimPaths[node.nodeId];
        if (names === undefined || usdPrimPath === undefined) {
          throw new Error(`Internal handoff mapping is missing node ${node.nodeId}`);
        }
        const isPrimitive = node.componentType.typeId === "spatial-primitive";
        const isCadPart = node.componentType.typeId === "cad-part";
        const isPart = isPrimitive || isCadPart;
        const cadDefinition = isCadPart ? parseCadPartDefinition(node.props.definition) : undefined;
        return Object.freeze({
          semaframeNodeId: node.nodeId,
          sourceComponentId: node.sourceComponentId,
          ...("logicalNodeId" in node ? { logicalNodeId: node.logicalNodeId } : {}),
          ...(node.parentNodeId ? { parentNodeId: node.parentNodeId } : {}),
          kind: isPart ? "part" : "assembly",
          humanName: node.label,
          ...("partNumber" in node && node.partNumber ? { partNumber: node.partNumber } : {}),
          ...("materialName" in node && node.materialName ? { materialName: node.materialName } : {}),
          stepDefinitionName: names.definitionName,
          ...(names.occurrenceName ? { stepOccurrenceName: names.occurrenceName } : {}),
          ...(names.bodyDefinitions ? { stepBodyDefinitions: names.bodyDefinitions } : {}),
          usdPrimPath,
          localTransform: Object.freeze({
            translationM: Object.freeze({ ...node.placement.position }),
            rotationEulerXyzRad: Object.freeze({ ...node.placement.rotation }),
            scale: Object.freeze({ ...node.placement.scale }),
          }),
          ...(isPrimitive ? { geometry: parseParametricPrimitive(node.props.geometry) } : {}),
          ...(cadDefinition ? {
            geometry: Object.freeze({
              kind: "cad-part" as const,
              definitionDigest: cadPartDefinitionDigest(cadDefinition),
              activeBodyIds: Object.freeze([...cadDefinition.activeBodyIds]),
              definition: structuredClone(cadDefinition),
            }),
          } : {}),
          ...(isPart ? { material: materialRecord(node.props.material) } : {}),
          visible: node.visibility === "visible",
        });
      });
    const source = Object.freeze({
      modelId: definition.modelId,
      modelVersion: definition.version,
      modelDigest: definition.digest,
      sourceRevision: definition.sourceRevision,
    });
    const manifest: CadHandoffManifest = Object.freeze({
      format: "semaframe-cad-handoff",
      version: CAD_HANDOFF_FORMAT_VERSION,
      generator: Object.freeze({ name: "SemaFrame", version: CAD_HANDOFF_GENERATOR_VERSION }),
      source,
      editableModelDefinition: structuredClone(definition),
      authoritativeGeometry: CAD_HANDOFF_PATHS.step,
      sceneDescription: CAD_HANDOFF_PATHS.usda,
      report: CAD_HANDOFF_PATHS.report,
      units: "metre",
      coordinateSystem: Object.freeze({
        handedness: "right",
        upAxis: "Y",
        transformOrder: "translate-rotate-scale",
      }),
      files: Object.freeze([
        artifactDescriptor(stepArtifact),
        artifactDescriptor(usdArtifact),
      ]),
      nodes: Object.freeze(nodes),
      editability: Object.freeze({
        stepGeometry: "exact-brep-direct-editable",
        assemblyStructure: "xcaf-product-occurrences",
        nativeCadFeatureHistory: false,
        semaframeRecipe: "embedded-in-sidecar",
      }),
    });
    const manifestArtifact = await artifact(
      CAD_HANDOFF_PATHS.manifest,
      "application/json",
      jsonBytes(manifest),
    );
    const report: CadHandoffReport = Object.freeze({
      format: "semaframe-cad-report",
      version: CAD_HANDOFF_FORMAT_VERSION,
      outcome: "passed",
      source,
      artifactsVerified: Object.freeze([
        reportArtifactDescriptor(stepArtifact),
        reportArtifactDescriptor(usdArtifact),
        reportArtifactDescriptor(manifestArtifact),
      ]),
      export: Object.freeze({
        schema: "STEP AP242",
        units: "metre",
        exactBrep: true,
        booleanUnionAppliedAcrossParts: false,
        partCount: adapted.occtDocument.parts.length,
        modelAssemblyCount: adapted.modelAssemblyCount,
        cadPartAssemblyCount: adapted.cadPartAssemblyCount,
        stepContainerAssemblyCount: 1,
        occurrenceCount: adapted.occtDocument.occurrences.length + 1,
        names: "definition-and-occurrence",
        colors: "surface-rgb",
        uniformScaleHandling: "baked-into-part-brep",
      }),
      occtRoundTrip: step.verification,
      limitations: Object.freeze([
        "STEP preserves exact B-rep and product occurrences, not native feature history for a specific CAD system.",
        "Uniform hierarchy scale is baked into part B-rep dimensions; non-uniform scale fails closed.",
        "STEP surface RGB is guaranteed; OCCT may also serialize transparency, while PBR values, visibility and the editable SemaFrame recipe remain authoritative in USDA and semaframe-cad.json.",
        "Semantic PMI/GD&T is not authored by this handoff version.",
        "Assembly mate intent is preserved in semaframe-cad.json; STEP product occurrences do not encode downstream-native mate constraints.",
        "The OCCT round trip is a geometric proof (solids, bounds, volume, units and occurrence count); this version does not re-read every hierarchy, name or color through STEPCAFControl_Reader.",
        "Cone, capsule and plane ModelDefinition primitives are outside the exact AP242 V2 subset.",
        "USDA retains CAD-part hierarchy and transforms but does not embed the feature document or duplicate exact CAD B-rep as polygonal USD geometry; semaframe-cad.json preserves edits and model.step is authoritative.",
      ]),
    });
    const reportArtifact = await artifact(
      CAD_HANDOFF_PATHS.report,
      "application/json",
      jsonBytes(report),
    );
    const files = Object.freeze([
      stepArtifact,
      usdArtifact,
      manifestArtifact,
      reportArtifact,
    ].sort((left, right) => compareText(left.path, right.path)));
    const archiveBytes = createDeterministicCadHandoffArchive(files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
    })));
    const archive = await artifact(
      `${archiveSlug(definition)}.cad-handoff.zip`,
      "application/zip",
      archiveBytes,
    );
    return Object.freeze({
      format: "semaframe-cad-package",
      version: CAD_HANDOFF_FORMAT_VERSION,
      archive,
      files,
      manifest,
      report,
    });
  } catch (error) {
    if (error instanceof CadHandoffError) throw error;
    fail("export_failed", "Could not create the CAD handoff package", error);
  }
}
