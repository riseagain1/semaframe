import type { OpenCascadeInstance } from "replicad-opencascadejs";
import type { Shape3D } from "replicad";
import {
  CAD_KERNEL_LIMITS,
  loadCadKernel,
} from "./cadKernel";
import {
  withEvaluatedCadPartShapes,
} from "./cad/cadPartEvaluator";
import {
  cadPartDefinitionDigest,
  type CadPartDefinitionV1,
} from "./cad/cadDocument";
import type { ParametricPrimitive } from "./parametricGeometry";

export type CadHandoffVector3 = Readonly<{ x: number; y: number; z: number }>;
export type CadHandoffQuaternion = Readonly<{ x: number; y: number; z: number; w: number }>;

export type CadHandoffBounds = Readonly<{
  min: CadHandoffVector3;
  max: CadHandoffVector3;
  size: CadHandoffVector3;
}>;

export const CAD_HANDOFF_BOUNDS_ABSOLUTE_TOLERANCE_M = 1e-6;
export const CAD_HANDOFF_MAX_PARTS = CAD_KERNEL_LIMITS.maximumLiveShapes;

export type CadHandoffRigidTransform = Readonly<{
  translationM: CadHandoffVector3;
  rotationQuaternion: CadHandoffQuaternion;
}>;

export type CadHandoffSurfaceColor = Readonly<{
  /** Linear-light RGB channels as expected by OCCT Quantity_ColorRGBA. */
  red: number;
  green: number;
  blue: number;
  alpha: number;
}>;

type CadHandoffOcctPartCommon = Readonly<{
  nodeId: string;
  definitionName: string;
  /** Uniform scale accumulated from the model root through this part. */
  bakedUniformScale: number;
  color: CadHandoffSurfaceColor;
  visible: boolean;
}>;

export type CadHandoffOcctPart = CadHandoffOcctPartCommon & (
  | Readonly<{
      sourceKind: "primitive";
      primitive: ParametricPrimitive;
    }>
  | Readonly<{
      sourceKind: "cad-part-body";
      sourceComponentNodeId: string;
      bodyId: string;
      definition: CadPartDefinitionV1;
    }>
);

export type CadHandoffOcctAssembly = Readonly<{
  nodeId: string;
  definitionName: string;
  visible: boolean;
}>;

export type CadHandoffOcctOccurrence = Readonly<{
  nodeId: string;
  parentAssemblyNodeId: string;
  childNodeId: string;
  occurrenceName: string;
  transform: CadHandoffRigidTransform;
}>;

export type CadHandoffOcctDocument = Readonly<{
  documentName: string;
  containerName: string;
  rootNodeId: string;
  parts: readonly CadHandoffOcctPart[];
  assemblies: readonly CadHandoffOcctAssembly[];
  occurrences: readonly CadHandoffOcctOccurrence[];
  rootOccurrence: Readonly<{
    occurrenceName: string;
    transform: CadHandoffRigidTransform;
  }>;
}>;

export type CadHandoffOcctRuntime = Readonly<{
  oc: OpenCascadeInstance;
  replicad: typeof import("replicad");
}>;

export type CadHandoffOcctRuntimeLoader = () => Promise<CadHandoffOcctRuntime>;

export type CadHandoffOcctVerification = Readonly<{
  passed: boolean;
  readerStatus: string;
  rootCount: number;
  transferredRootCount: number;
  importedShapeCount: number;
  solidCount: number;
  expectedPartCount: number;
  validBrep: boolean;
  schema: "AP242";
  units: "metre";
  assemblyOccurrenceCount: number;
  expectedOccurrenceCount: number;
  expectedVolumeM3: number;
  importedVolumeM3: number;
  volumeRelativeError: number;
  expectedBoundsM: CadHandoffBounds;
  boundsM: CadHandoffBounds;
  boundsAbsoluteErrorM: CadHandoffBounds;
  boundsMaximumAbsoluteErrorM: number;
  boundsAbsoluteToleranceM: number;
  boundsMatch: boolean;
}>;

export type CadHandoffOcctExportResult = Readonly<{
  stepText: string;
  byteLength: number;
  verification: CadHandoffOcctVerification;
}>;

export type CadHandoffOcctExportOptions = Readonly<{
  runtimeLoader?: CadHandoffOcctRuntimeLoader;
  /** Optional independent analytic expectation; exact CAD bodies are measured before export. */
  expectedVolumeM3?: number;
  volumeRelativeTolerance?: number;
  /** Optional independent aggregate expectation used to detect transform drift before STEP export. */
  expectedBoundsM?: CadHandoffBounds;
  boundsAbsoluteToleranceM?: number;
}>;

type Deletable = { delete(): void };

let defaultRuntimePromise: Promise<CadHandoffOcctRuntime> | undefined;
let operationTail: Promise<void> = Promise.resolve();
let virtualFileCounter = 0;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function deleteQuietly(value: Deletable | undefined): void {
  if (value === undefined) return;
  try {
    value.delete();
  } catch {
    // Some embind value wrappers may already have released their C++ object.
  }
}

async function defaultRuntimeLoader(): Promise<CadHandoffOcctRuntime> {
  // Reuse the exact OCCT instance already owned by the bounded CAD kernel.
  // Replicad keeps that instance in its module-level adapter after the
  // bootstrap kernel is disposed, avoiding a second incompatible WASM heap.
  const bootstrap = await loadCadKernel();
  try {
    const replicad = await import("replicad");
    return Object.freeze({ oc: replicad.getOC(), replicad });
  } finally {
    await bootstrap.dispose();
  }
}

function loadDefaultRuntime(): Promise<CadHandoffOcctRuntime> {
  defaultRuntimePromise ??= defaultRuntimeLoader().catch((error: unknown) => {
    defaultRuntimePromise = undefined;
    throw error;
  });
  return defaultRuntimePromise;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertFinite(value: number, path: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
}

function assertUnitQuaternion(value: CadHandoffQuaternion, path: string): void {
  const magnitude = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(magnitude) || magnitude < 1e-12 || Math.abs(magnitude - 1) > 1e-8) {
    throw new TypeError(`${path} must be a normalized quaternion`);
  }
}

function assertDocument(document: CadHandoffOcctDocument): void {
  const assemblies = new Map(document.assemblies.map((entry) => [entry.nodeId, entry]));
  const parts = new Map(document.parts.map((entry) => [entry.nodeId, entry]));
  const allIds = new Set<string>();
  for (const entry of [...document.assemblies, ...document.parts]) {
    if (!entry.nodeId || allIds.has(entry.nodeId)) {
      throw new TypeError(`CAD handoff node IDs must be non-empty and unique: ${entry.nodeId}`);
    }
    if (!entry.definitionName.trim()) throw new TypeError(`CAD handoff node ${entry.nodeId} needs a name`);
    allIds.add(entry.nodeId);
  }
  if (!assemblies.has(document.rootNodeId)) {
    throw new TypeError("CAD handoff root must reference an assembly node");
  }
  if (document.parts.length === 0) throw new TypeError("CAD handoff requires at least one solid part");
  if (document.parts.length > CAD_HANDOFF_MAX_PARTS) {
    throw new RangeError(`CAD handoff supports at most ${CAD_HANDOFF_MAX_PARTS} parts`);
  }
  const childIds = new Set<string>();
  const occurrenceIds = new Set<string>();
  const childrenByAssembly = new Map<string, string[]>();
  for (const occurrence of document.occurrences) {
    if (!occurrence.nodeId || occurrenceIds.has(occurrence.nodeId)) {
      throw new TypeError(`CAD handoff occurrence IDs must be non-empty and unique: ${occurrence.nodeId}`);
    }
    if (!occurrence.occurrenceName.trim()) {
      throw new TypeError(`CAD handoff occurrence ${occurrence.nodeId} needs a name`);
    }
    occurrenceIds.add(occurrence.nodeId);
    if (!assemblies.has(occurrence.parentAssemblyNodeId)) {
      throw new TypeError(`Occurrence ${occurrence.nodeId} has an unknown parent assembly`);
    }
    if (!allIds.has(occurrence.childNodeId)) {
      throw new TypeError(`Occurrence ${occurrence.nodeId} has an unknown child`);
    }
    if (childIds.has(occurrence.childNodeId)) {
      throw new TypeError(`Node ${occurrence.childNodeId} has more than one assembly occurrence`);
    }
    childIds.add(occurrence.childNodeId);
    const children = childrenByAssembly.get(occurrence.parentAssemblyNodeId) ?? [];
    children.push(occurrence.childNodeId);
    childrenByAssembly.set(occurrence.parentAssemblyNodeId, children);
    for (const [axis, component] of Object.entries(occurrence.transform.translationM)) {
      assertFinite(component, `occurrence:${occurrence.nodeId}.translationM.${axis}`);
      if (Math.abs(component) > CAD_KERNEL_LIMITS.maximumCoordinateMagnitudeM) {
        throw new RangeError(`Occurrence ${occurrence.nodeId} exceeds the CAD coordinate limit`);
      }
    }
    assertUnitQuaternion(
      occurrence.transform.rotationQuaternion,
      `occurrence:${occurrence.nodeId}.rotationQuaternion`,
    );
  }
  for (const id of allIds) {
    if (id !== document.rootNodeId && !childIds.has(id)) {
      throw new TypeError(`CAD handoff node ${id} is disconnected from the root assembly`);
    }
  }
  if (childIds.has(document.rootNodeId)) {
    throw new TypeError("CAD handoff root assembly cannot be used as a child occurrence");
  }
  const reachable = new Set<string>();
  const active = new Set<string>();
  const visit = (nodeId: string): void => {
    if (active.has(nodeId)) throw new TypeError(`CAD handoff assembly graph contains a cycle at ${nodeId}`);
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    if (!assemblies.has(nodeId)) return;
    active.add(nodeId);
    for (const childId of childrenByAssembly.get(nodeId) ?? []) visit(childId);
    active.delete(nodeId);
  };
  visit(document.rootNodeId);
  for (const id of allIds) {
    if (!reachable.has(id)) throw new TypeError(`CAD handoff node ${id} is outside the root occurrence tree`);
  }
  if (!document.containerName.trim() || !document.documentName.trim()) {
    throw new TypeError("CAD handoff document and container names must be non-empty");
  }
  if (!document.rootOccurrence.occurrenceName.trim()) {
    throw new TypeError("CAD handoff root occurrence needs a name");
  }
  assertUnitQuaternion(
    document.rootOccurrence.transform.rotationQuaternion,
    "rootOccurrence.rotationQuaternion",
  );
  for (const [axis, component] of Object.entries(document.rootOccurrence.transform.translationM)) {
    assertFinite(component, `rootOccurrence.translationM.${axis}`);
    if (Math.abs(component) > CAD_KERNEL_LIMITS.maximumCoordinateMagnitudeM) {
      throw new RangeError("CAD handoff root occurrence exceeds the CAD coordinate limit");
    }
  }
  for (const part of parts.values()) {
    if (!Number.isFinite(part.bakedUniformScale)
      || part.bakedUniformScale < CAD_KERNEL_LIMITS.minimumUniformScale
      || part.bakedUniformScale > CAD_KERNEL_LIMITS.maximumUniformScale) {
      throw new TypeError(`Part ${part.nodeId} has an invalid baked uniform scale`);
    }
    if (part.sourceKind === "cad-part-body") {
      if (!part.sourceComponentNodeId || !part.bodyId) {
        throw new TypeError(`CAD body part ${part.nodeId} needs source component and body IDs`);
      }
      if (!part.definition.activeBodyIds.includes(part.bodyId)) {
        throw new TypeError(`CAD body part ${part.nodeId} is not active in its source definition`);
      }
    }
    for (const [channel, value] of Object.entries(part.color)) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`Part ${part.nodeId} color channel ${channel} must be in [0, 1]`);
      }
    }
  }
}

function axisVector(axis: "x" | "y" | "z"): [number, number, number] {
  if (axis === "x") return [1, 0, 0];
  if (axis === "y") return [0, 1, 0];
  return [0, 0, 1];
}

function makePrimitivePartShape(
  runtime: CadHandoffOcctRuntime,
  part: Extract<CadHandoffOcctPart, { sourceKind: "primitive" }>,
): Shape3D {
  const { replicad } = runtime;
  const scale = part.bakedUniformScale;
  switch (part.primitive.kind) {
    case "box":
      return replicad.makeBox(
        [
          -part.primitive.sizeM.x * scale / 2,
          -part.primitive.sizeM.y * scale / 2,
          -part.primitive.sizeM.z * scale / 2,
        ],
        [
          part.primitive.sizeM.x * scale / 2,
          part.primitive.sizeM.y * scale / 2,
          part.primitive.sizeM.z * scale / 2,
        ],
      );
    case "sphere":
      return replicad.makeSphere(part.primitive.radiusM * scale);
    case "cylinder": {
      const direction = axisVector(part.primitive.axis);
      const height = part.primitive.heightM * scale;
      return replicad.makeCylinder(
        part.primitive.radiusM * scale,
        height,
        direction.map((component) => -component * height / 2) as [number, number, number],
        direction,
      );
    }
    case "cone":
    case "capsule":
    case "plane":
      throw new TypeError(
        `Exact AP242 handoff does not yet support ${part.primitive.kind} node ${part.nodeId}`,
      );
  }
}

function extendedString(oc: OpenCascadeInstance, value: string) {
  return new oc.TCollection_ExtendedString(value, true);
}

function setLabelName(
  oc: OpenCascadeInstance,
  label: InstanceType<OpenCascadeInstance["TDF_Label"]>,
  value: string,
): void {
  const text = extendedString(oc, value);
  let attribute: Deletable | undefined;
  try {
    attribute = oc.TDataStd_Name.Set(label, text);
  } finally {
    deleteQuietly(attribute);
    deleteQuietly(text);
  }
}

function locationForTransform(
  oc: OpenCascadeInstance,
  transform: CadHandoffRigidTransform,
) {
  const { x, y, z, w } = transform.rotationQuaternion;
  const { x: tx, y: ty, z: tz } = transform.translationM;
  const matrix = new oc.gp_Trsf();
  matrix.SetValues(
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    tx,
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    ty,
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
    tz,
  );
  const location = new oc.TopLoc_Location(matrix);
  matrix.delete();
  return location;
}

function canonicalPart21Layout(value: string): string {
  let output = "";
  let inString = false;
  let pendingWhitespace = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      output += character;
      if (character === "'") {
        if (value[index + 1] === "'") {
          output += "'";
          index += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (character === "'") {
      if (pendingWhitespace && output && !/[\n(,=]/u.test(output.at(-1)!)) output += " ";
      pendingWhitespace = false;
      inString = true;
      output += character;
      continue;
    }
    if (/\s/u.test(character)) {
      pendingWhitespace = true;
      continue;
    }
    if (/[(),;=]/u.test(character)) {
      pendingWhitespace = false;
      output += character;
      if (character === ";") output += "\n";
      continue;
    }
    if (pendingWhitespace && output && !/[\n(,=]/u.test(output.at(-1)!)) output += " ";
    pendingWhitespace = false;
    output += character;
  }
  return output.trimEnd() + "\n";
}

type StepEntityRecord = Readonly<{ id: number; body: string }>;

function canonicalizePresentationOrder(value: string): string {
  const records = new Map<number, StepEntityRecord>();
  for (const match of value.matchAll(/^#(\d+)=(.*);$/gmu)) {
    const id = Number.parseInt(match[1]!, 10);
    records.set(id, Object.freeze({ id, body: match[2]! }));
  }
  const roots = [...records.values()]
    .filter((record) => record.body.startsWith("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION"));
  if (roots.length === 0) return value;
  const tailStart = Math.min(...roots.map((root) => root.id));
  const tailRecords = [...records.values()]
    .filter((record) => record.id >= tailStart)
    .sort((left, right) => left.id - right.id);
  if (tailRecords.some((record, offset) => record.id !== tailStart + offset)) return value;

  const blocks = roots.map((root) => {
    const visited = new Set<number>();
    const ordered: StepEntityRecord[] = [];
    const visit = (id: number): void => {
      if (visited.has(id)) return;
      const record = records.get(id);
      if (record === undefined || id < tailStart) return;
      visited.add(id);
      ordered.push(record);
      for (const reference of record.body.matchAll(/#(\d+)/gu)) {
        visit(Number.parseInt(reference[1]!, 10));
      }
    };
    visit(root.id);
    const styled = ordered.find((record) => record.body.startsWith("STYLED_ITEM"));
    const target = styled?.body.match(/^STYLED_ITEM\(.*,#(\d+)\)$/u);
    if (target === null || target === undefined) return undefined;
    return Object.freeze({
      targetShapeId: Number.parseInt(target[1]!, 10),
      records: Object.freeze(ordered),
      signature: ordered.map((record) => record.body.replace(/#\d+/gu, "#")).join("|"),
    });
  }).filter((block): block is NonNullable<typeof block> => block !== undefined);
  if (blocks.length !== roots.length) return value;
  const claimed = new Set<number>();
  for (const block of blocks) {
    for (const record of block.records) {
      if (claimed.has(record.id)) return value;
      claimed.add(record.id);
    }
  }
  if (claimed.size !== tailRecords.length || tailRecords.some((record) => !claimed.has(record.id))) {
    return value;
  }

  const orderedBlocks = [...blocks].sort((left, right) => (
    left.targetShapeId - right.targetShapeId
    || compareText(left.signature, right.signature)
  ));
  let nextId = tailStart;
  const idMap = new Map<number, number>();
  for (const block of orderedBlocks) {
    for (const record of block.records) {
      idMap.set(record.id, nextId);
      nextId += 1;
    }
  }
  const canonicalRecords: string[] = [];
  for (const block of orderedBlocks) {
    for (const record of block.records) {
      const destinationId = idMap.get(record.id)!;
      const body = record.body.replace(/#(\d+)/gu, (reference, rawId: string) => {
        const mapped = idMap.get(Number.parseInt(rawId, 10));
        return mapped === undefined ? reference : `#${mapped}`;
      });
      canonicalRecords.push(`#${destinationId}=${body};`);
    }
  }
  const lines = value.split("\n");
  const first = lines.findIndex((line) => line.startsWith(`#${tailStart}=`));
  const end = lines.findIndex((line, index) => index > first && line === "ENDSEC;");
  if (first < 0 || end < 0) return value;
  for (let index = 0; index < first; index += 1) {
    lines[index] = lines[index]!.replace(/#(\d+)/gu, (reference, rawId: string) => {
      const mapped = idMap.get(Number.parseInt(rawId, 10));
      return mapped === undefined ? reference : `#${mapped}`;
    });
  }
  lines.splice(first, end - first, ...canonicalRecords);
  return lines.join("\n");
}

function canonicalStepText(value: string): string {
  const normalized = canonicalPart21Layout(value);
  const canonicalHeader = normalized.replace(
    /FILE_NAME\('[^']*','[^']*'/u,
    "FILE_NAME('model.step','1970-01-01T00:00:00'",
  );
  let occurrenceId = 0;
  const canonicalOccurrences = canonicalHeader.replace(
    /NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d+'/gu,
    () => `NEXT_ASSEMBLY_USAGE_OCCURRENCE('${occurrenceId += 1}'`,
  );
  const canonicalPresentation = canonicalizePresentationOrder(canonicalOccurrences);
  return canonicalPresentation.endsWith("\n")
    ? canonicalPresentation
    : `${canonicalPresentation}\n`;
}

function countPattern(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function relativeError(expected: number, actual: number): number {
  if (expected === 0) return actual === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(actual - expected) / Math.abs(expected);
}

function freezeBounds(
  minimum: readonly [number, number, number],
  maximum: readonly [number, number, number],
): CadHandoffBounds {
  return Object.freeze({
    min: Object.freeze({ x: minimum[0], y: minimum[1], z: minimum[2] }),
    max: Object.freeze({ x: maximum[0], y: maximum[1], z: maximum[2] }),
    size: Object.freeze({
      x: maximum[0] - minimum[0],
      y: maximum[1] - minimum[1],
      z: maximum[2] - minimum[2],
    }),
  });
}

function shapeBounds(shape: Shape3D): CadHandoffBounds {
  const box = shape.boundingBox;
  try {
    const [minimum, maximum] = box.bounds;
    return freezeBounds(minimum, maximum);
  } finally {
    box.delete();
  }
}

function cloneBounds(value: CadHandoffBounds): CadHandoffBounds {
  return freezeBounds(
    [value.min.x, value.min.y, value.min.z],
    [value.max.x, value.max.y, value.max.z],
  );
}

function assertBounds(value: CadHandoffBounds, path: string): void {
  for (const group of ["min", "max", "size"] as const) {
    for (const axis of ["x", "y", "z"] as const) {
      assertFinite(value[group][axis], `${path}.${group}.${axis}`);
    }
  }
  for (const axis of ["x", "y", "z"] as const) {
    const size = value.max[axis] - value.min[axis];
    if (size < 0 || Math.abs(size - value.size[axis]) > 1e-9 * Math.max(1, Math.abs(size))) {
      throw new TypeError(`${path}.${axis} is internally inconsistent`);
    }
  }
}

type BoundsComparison = Readonly<{
  absoluteErrorM: CadHandoffBounds;
  maximumAbsoluteErrorM: number;
  matches: boolean;
}>;

function compareBounds(
  expected: CadHandoffBounds,
  actual: CadHandoffBounds,
  absoluteToleranceM: number,
): BoundsComparison {
  const error = (group: "min" | "max" | "size", axis: "x" | "y" | "z") => (
    Math.abs(actual[group][axis] - expected[group][axis])
  );
  const absoluteErrorM: CadHandoffBounds = Object.freeze({
    min: Object.freeze({ x: error("min", "x"), y: error("min", "y"), z: error("min", "z") }),
    max: Object.freeze({ x: error("max", "x"), y: error("max", "y"), z: error("max", "z") }),
    size: Object.freeze({ x: error("size", "x"), y: error("size", "y"), z: error("size", "z") }),
  });
  const maximumAbsoluteErrorM = Math.max(
    ...Object.values(absoluteErrorM.min),
    ...Object.values(absoluteErrorM.max),
    ...Object.values(absoluteErrorM.size),
  );
  return Object.freeze({
    absoluteErrorM,
    maximumAbsoluteErrorM,
    matches: maximumAbsoluteErrorM <= absoluteToleranceM,
  });
}

function writeAssembly(
  runtime: CadHandoffOcctRuntime,
  document: CadHandoffOcctDocument,
): Readonly<{
  stepText: string;
  sourceVolumeM3: number;
  sourceBoundsM: CadHandoffBounds;
}> {
  const { oc } = runtime;
  const owned: Deletable[] = [];
  const shapes: Shape3D[] = [];
  const labels = new Map<string, InstanceType<OpenCascadeInstance["TDF_Label"]>>();
  const filename = `/semaframe_handoff_${virtualFileCounter += 1}.step`;
  let sourceVolumeM3 = 0;
  try {
    const storageFormat = extendedString(oc, "XmlOcaf");
    owned.push(storageFormat);
    const doc = new oc.TDocStd_Document(storageFormat);
    owned.push(doc);
    oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
    const main = doc.Main();
    owned.push(main);
    const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(main);
    const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(main);
    owned.push(shapeTool, colorTool);

    const addPartLabel = (part: CadHandoffOcctPart, shape: Shape3D): void => {
      const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, true);
      try {
        if (!analyzer.IsValid()) throw new Error(`CAD handoff part ${part.nodeId} is not a valid B-rep`);
      } finally {
        analyzer.delete();
      }
      const box = shape.boundingBox;
      try {
        const [minimum, maximum] = box.bounds;
        const coordinates = [...minimum, ...maximum];
        if (coordinates.some((value) => !Number.isFinite(value)
          || Math.abs(value) > CAD_KERNEL_LIMITS.maximumCoordinateMagnitudeM)) {
          throw new Error(`CAD handoff part ${part.nodeId} exceeds the CAD coordinate limit`);
        }
        const extents = maximum.map((value, axis) => value - minimum[axis]!) as [number, number, number];
        if (extents.some((value) => value > CAD_KERNEL_LIMITS.maximumShapeExtentM)) {
          throw new Error(`CAD handoff part ${part.nodeId} exceeds the CAD extent limit`);
        }
      } finally {
        box.delete();
      }
      const volume = runtime.replicad.measureVolume(shape);
      if (!Number.isFinite(volume) || volume <= 0) {
        throw new Error(`CAD handoff part ${part.nodeId} has invalid source volume`);
      }
      sourceVolumeM3 += volume;
      const label = shapeTool.NewShape();
      owned.push(label);
      shapeTool.SetShape(label, shape.wrapped);
      setLabelName(oc, label, part.definitionName);
      const color = new oc.Quantity_ColorRGBA(
        part.color.red,
        part.color.green,
        part.color.blue,
        part.color.alpha,
      );
      owned.push(color);
      colorTool.SetColor(label, color, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
      colorTool.SetVisibility(label, part.visible);
      labels.set(part.nodeId, label);
    };

    const orderedParts = [...document.parts].sort((left, right) => compareText(left.nodeId, right.nodeId));
    for (const part of orderedParts.filter((entry) => entry.sourceKind === "primitive")) {
      const shape = makePrimitivePartShape(runtime, part);
      shapes.push(shape);
      addPartLabel(part, shape);
    }

    const cadGroups = new Map<string, Extract<CadHandoffOcctPart, { sourceKind: "cad-part-body" }>[]>();
    for (const part of orderedParts.filter((entry) => entry.sourceKind === "cad-part-body")) {
      const group = cadGroups.get(part.sourceComponentNodeId) ?? [];
      group.push(part);
      cadGroups.set(part.sourceComponentNodeId, group);
    }
    for (const [sourceNodeId, group] of [...cadGroups].sort(([left], [right]) => compareText(left, right))) {
      const definition = group[0]!.definition;
      const digest = cadPartDefinitionDigest(definition);
      if (group.some((part) => cadPartDefinitionDigest(part.definition) !== digest)) {
        throw new Error(`CAD component ${sourceNodeId} contains inconsistent body definitions`);
      }
      withEvaluatedCadPartShapes(runtime, definition, (bodies, evidence) => {
        const byBodyId = new Map(bodies.map((body) => [body.bodyId, body.shape]));
        const evidenceByBodyId = new Map(evidence.bodies.map((body) => [body.bodyId, body]));
        for (const part of group) {
          const borrowedShape = byBodyId.get(part.bodyId);
          const bodyEvidence = evidenceByBodyId.get(part.bodyId);
          if (borrowedShape === undefined || bodyEvidence === undefined) {
            throw new Error(`CAD component ${sourceNodeId} did not evaluate body ${part.bodyId}`);
          }
          let exportShape = borrowedShape;
          if (Math.abs(part.bakedUniformScale - 1) > 1e-12) {
            exportShape = borrowedShape.scale(part.bakedUniformScale);
            shapes.push(exportShape);
          }
          const expectedScaledVolume = bodyEvidence.volumeM3 * part.bakedUniformScale ** 3;
          const measuredScaledVolume = runtime.replicad.measureVolume(exportShape);
          if (relativeError(expectedScaledVolume, measuredScaledVolume) > 1e-8) {
            throw new Error(`CAD component ${sourceNodeId} body ${part.bodyId} changed volume while preparing handoff`);
          }
          addPartLabel(part, exportShape);
        }
      });
    }

    for (const assembly of [...document.assemblies].sort((left, right) => compareText(left.nodeId, right.nodeId))) {
      const label = shapeTool.NewShape();
      owned.push(label);
      setLabelName(oc, label, assembly.definitionName);
      colorTool.SetVisibility(label, assembly.visible);
      labels.set(assembly.nodeId, label);
    }

    for (const occurrence of [...document.occurrences].sort((left, right) => (
      compareText(left.parentAssemblyNodeId, right.parentAssemblyNodeId)
      || compareText(left.childNodeId, right.childNodeId)
      || compareText(left.nodeId, right.nodeId)
    ))) {
      const parent = labels.get(occurrence.parentAssemblyNodeId);
      const child = labels.get(occurrence.childNodeId);
      if (parent === undefined || child === undefined) {
        throw new Error(`Internal XCAF label mapping failed for occurrence ${occurrence.nodeId}`);
      }
      const location = locationForTransform(oc, occurrence.transform);
      owned.push(location);
      const component = shapeTool.AddComponent(parent, child, location);
      owned.push(component);
      setLabelName(oc, component, occurrence.occurrenceName);
    }

    const container = shapeTool.NewShape();
    owned.push(container);
    setLabelName(oc, container, document.containerName);
    const rootDefinition = labels.get(document.rootNodeId);
    if (rootDefinition === undefined) throw new Error("Internal XCAF root label mapping failed");
    const rootLocation = locationForTransform(oc, document.rootOccurrence.transform);
    owned.push(rootLocation);
    const rootComponent = shapeTool.AddComponent(container, rootDefinition, rootLocation);
    owned.push(rootComponent);
    setLabelName(oc, rootComponent, document.rootOccurrence.occurrenceName);
    shapeTool.UpdateAssemblies();

    const rawSourceAssembly = oc.XCAFDoc_ShapeTool.GetShape(container);
    let sourceAssembly: ReturnType<typeof runtime.replicad.cast> | undefined;
    let sourceBoundsM: CadHandoffBounds;
    try {
      if (rawSourceAssembly.IsNull()) throw new Error("OpenCascade produced a null source assembly");
      sourceAssembly = runtime.replicad.cast(rawSourceAssembly);
      if (!runtime.replicad.isShape3D(sourceAssembly)) {
        throw new Error("OpenCascade did not produce a 3D source assembly");
      }
      sourceBoundsM = shapeBounds(sourceAssembly);
    } finally {
      if (sourceAssembly) deleteQuietly(sourceAssembly);
      else deleteQuietly(rawSourceAssembly);
    }

    // The first STEP writer construction initializes process-wide defaults.
    // Construct it before overriding units, matching OCCT's documented/static
    // parameter lifecycle and avoiding a later reset back to millimetres.
    const defaultsBootstrap = new oc.STEPCAFControl_Writer();
    owned.push(defaultsBootstrap);
    oc.Interface_Static.SetCVal("xstep.cascade.unit", "M");
    oc.Interface_Static.SetCVal("write.step.unit", "M");
    oc.Interface_Static.SetIVal("write.surfacecurve.mode", 1);
    oc.Interface_Static.SetIVal("write.precision.mode", 0);
    oc.Interface_Static.SetIVal("write.step.assembly", 2);
    oc.Interface_Static.SetIVal("write.step.schema", 5);

    const session = new oc.XSControl_WorkSession();
    const writer = new oc.STEPCAFControl_Writer(session, false);
    const progress = new oc.Message_ProgressRange();
    owned.push(session, writer, progress);
    writer.SetColorMode(true);
    writer.SetNameMode(true);
    writer.SetLayerMode(true);
    writer.SetPropsMode(true);
    writer.SetDimTolMode(false);
    if (!writer.Perform(doc, filename, progress)) {
      throw new Error("OpenCascade XCAF writer did not produce a STEP document");
    }
    const bytes = oc.FS.readFile(filename);
    if (bytes.byteLength > CAD_KERNEL_LIMITS.maximumStepBytes) {
      throw new RangeError(
        `STEP output exceeds ${CAD_KERNEL_LIMITS.maximumStepBytes} bytes`,
      );
    }
    return Object.freeze({
      stepText: canonicalStepText(new TextDecoder().decode(bytes)),
      sourceVolumeM3,
      sourceBoundsM,
    });
  } finally {
    try {
      oc.FS.unlink(filename);
    } catch {
      // The file is absent when export failed before writer output.
    }
    for (const shape of shapes.reverse()) deleteQuietly(shape);
    for (const value of owned.reverse()) deleteQuietly(value);
  }
}

function verifyStep(
  runtime: CadHandoffOcctRuntime,
  stepText: string,
  expectedPartCount: number,
  expectedOccurrenceCount: number,
  expectedVolumeM3: number,
  volumeRelativeTolerance: number,
  expectedBoundsM: CadHandoffBounds,
  boundsAbsoluteToleranceM: number,
): CadHandoffOcctVerification {
  const { oc, replicad } = runtime;
  const filename = `/semaframe_verify_${virtualFileCounter += 1}.step`;
  const owned: Deletable[] = [];
  let imported: ReturnType<typeof replicad.cast> | undefined;
  try {
    oc.FS.writeFile(filename, new TextEncoder().encode(stepText));
    const reader = new oc.STEPControl_Reader();
    owned.push(reader);
    const readerStatus = reader.ReadFile(filename);
    if (readerStatus !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      throw new Error(`OpenCascade STEP reader returned ${readerStatus}`);
    }
    const rootCount = reader.NbRootsForTransfer();
    const progress = new oc.Message_ProgressRange();
    owned.push(progress);
    const transferredRootCount = reader.TransferRoots(progress);
    const importedShapeCount = reader.NbShapes();
    const rawShape = reader.OneShape();
    owned.push(rawShape);
    if (rawShape.IsNull()) throw new Error("OpenCascade STEP reader returned a null shape");
    imported = replicad.cast(rawShape);
    if (!replicad.isShape3D(imported)) {
      throw new Error("OpenCascade STEP reader did not return a 3D assembly shape");
    }

    const analyzer = new oc.BRepCheck_Analyzer(imported.wrapped, true, false, true);
    const explorer = new oc.TopExp_Explorer(
      imported.wrapped,
      oc.TopAbs_ShapeEnum.TopAbs_SOLID,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    owned.push(analyzer, explorer);
    let solidCount = 0;
    while (explorer.More()) {
      solidCount += 1;
      explorer.Next();
    }
    const validBrep = analyzer.IsValid();
    const importedVolumeM3 = replicad.measureVolume(imported);
    const error = relativeError(expectedVolumeM3, importedVolumeM3);
    const boundsM = shapeBounds(imported);
    const boundsComparison = compareBounds(expectedBoundsM, boundsM, boundsAbsoluteToleranceM);
    const assemblyOccurrenceCount = countPattern(
      stepText,
      /NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/gu,
    );
    const schemaMatches = stepText.includes("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING");
    const unitsMatch = /SI_UNIT\(\$,.METRE\.\)/u.test(stepText);
    const passed = rootCount === 1
      && transferredRootCount >= 1
      && importedShapeCount >= 1
      && solidCount === expectedPartCount
      && validBrep
      && schemaMatches
      && unitsMatch
      && assemblyOccurrenceCount === expectedOccurrenceCount
      && error <= volumeRelativeTolerance
      && boundsComparison.matches;
    return Object.freeze({
      passed,
      readerStatus: String(readerStatus),
      rootCount,
      transferredRootCount,
      importedShapeCount,
      solidCount,
      expectedPartCount,
      validBrep,
      schema: "AP242",
      units: "metre",
      assemblyOccurrenceCount,
      expectedOccurrenceCount,
      expectedVolumeM3,
      importedVolumeM3,
      volumeRelativeError: error,
      expectedBoundsM,
      boundsM,
      boundsAbsoluteErrorM: boundsComparison.absoluteErrorM,
      boundsMaximumAbsoluteErrorM: boundsComparison.maximumAbsoluteErrorM,
      boundsAbsoluteToleranceM,
      boundsMatch: boundsComparison.matches,
    });
  } finally {
    try {
      oc.FS.unlink(filename);
    } catch {
      // The verifier file is absent if setup failed before the write.
    }
    deleteQuietly(imported);
    for (const value of owned.reverse()) deleteQuietly(value);
  }
}

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation);
  operationTail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Export an exact, non-unioned XCAF assembly and prove that the emitted AP242
 * document can be read back by OCCT with the expected solids, volume, and
 * aggregate world-space bounds.
 */
export async function exportCadHandoffAssemblyWithOcct(
  document: CadHandoffOcctDocument,
  options: CadHandoffOcctExportOptions,
): Promise<CadHandoffOcctExportResult> {
  assertDocument(document);
  if (options.expectedVolumeM3 !== undefined
    && (!Number.isFinite(options.expectedVolumeM3) || options.expectedVolumeM3 <= 0)) {
    throw new TypeError("expectedVolumeM3 must be a positive finite number");
  }
  const tolerance = options.volumeRelativeTolerance ?? 1e-8;
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1e-3) {
    throw new TypeError("volumeRelativeTolerance must be in (0, 0.001]");
  }
  const boundsTolerance = options.boundsAbsoluteToleranceM
    ?? CAD_HANDOFF_BOUNDS_ABSOLUTE_TOLERANCE_M;
  if (!Number.isFinite(boundsTolerance) || boundsTolerance <= 0 || boundsTolerance > 0.01) {
    throw new TypeError("boundsAbsoluteToleranceM must be in (0, 0.01]");
  }
  if (options.expectedBoundsM) assertBounds(options.expectedBoundsM, "expectedBoundsM");
  try {
    return await serialized(async () => {
      const runtime = await (options.runtimeLoader?.() ?? loadDefaultRuntime());
      runtime.replicad.setOC(runtime.oc);
      const written = writeAssembly(runtime, document);
      const expectedVolumeM3 = options.expectedVolumeM3 ?? written.sourceVolumeM3;
      if (relativeError(expectedVolumeM3, written.sourceVolumeM3) > tolerance) {
        throw new Error(
          `CAD source volume ${written.sourceVolumeM3} does not match analytic expectation ${expectedVolumeM3}`,
        );
      }
      const expectedBoundsM = options.expectedBoundsM
        ? cloneBounds(options.expectedBoundsM)
        : written.sourceBoundsM;
      const sourceBoundsComparison = compareBounds(
        expectedBoundsM,
        written.sourceBoundsM,
        boundsTolerance,
      );
      if (!sourceBoundsComparison.matches) {
        throw new Error(
          `CAD source bounds do not match the independent expectation: ${JSON.stringify(sourceBoundsComparison)}`,
        );
      }
      const verification = verifyStep(
        runtime,
        written.stepText,
        document.parts.length,
        document.occurrences.length + 1,
        expectedVolumeM3,
        tolerance,
        expectedBoundsM,
        boundsTolerance,
      );
      if (!verification.passed) {
        throw new Error(
          `OCCT round-trip verification failed: ${JSON.stringify(verification)}`,
        );
      }
      return Object.freeze({
        stepText: written.stepText,
        byteLength: new TextEncoder().encode(written.stepText).byteLength,
        verification,
      });
    });
  } catch (error) {
    throw new Error("CAD AP242/XCAF handoff failed", { cause: asError(error) });
  }
}
