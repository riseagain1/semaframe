import { DEFAULT_COMPONENT_REGISTRY } from "../workspace/components";
import {
  type WorkspaceCommandBatch,
  type WorkspaceOperation,
  WORKSPACE_PROTOCOL_VERSION,
} from "../workspace/protocol";
import {
  WorkspaceProjectSerializer,
  workspaceStateDigest,
} from "../workspace/persistence";
import { toRenderSnapshot } from "../workspace/renderer/contracts";
import { workspaceToSceneState } from "../workspace/renderer/ThreeComponentRenderer";
import {
  createInitialWorkspace,
  MAX_WORKSPACE_COMPONENTS,
  WorkspaceStore,
} from "../workspace/state";

export const WORKSPACE_PERFORMANCE_BENCHMARK_SCHEMA_VERSION = "1.0.0" as const;
export const WORKSPACE_PERFORMANCE_BENCHMARK_NAME = "semaframe.workspace-core" as const;
export const WORKSPACE_PERFORMANCE_BENCHMARK_TIERS = [100, 500, 2_000] as const;

const FIXTURE_CLOCK_MS = 1_750_000_000_000;
const FIXTURE_TIMESTAMP = "2025-06-15T15:06:40.000Z";
const COMPONENT_BATCH_SIZE = 100;
const CONNECTION_STRIDE = 50;
const COLLISION_STRIDE = 25;

export type WorkspacePerformanceProfile = "smoke" | "ci" | "full" | "custom";

export type WorkspacePerformanceRuntime = Readonly<{
  node: string;
  platform: string;
  arch: string;
}>;

export type WorkspaceFixturePlan = Readonly<{
  requestedComponents: number;
  stageComponents: 1;
  spatialComponents: number;
  controlComponents: number;
  connections: number;
  collisionEnabledComponents: number;
  collisionStride: number;
  connectionStride: number;
}>;

export type WorkspaceTimingSummary = Readonly<{
  samples: number;
  durationsMs: readonly number[];
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}>;

export type WorkspacePerformanceMeasurements = Readonly<{
  commit: WorkspaceTimingSummary;
  getStateClone: WorkspaceTimingSummary;
  projectSerialize: WorkspaceTimingSummary;
  projectDeserialize: WorkspaceTimingSummary;
  projectOpenStore: WorkspaceTimingSummary;
  toRenderSnapshot: WorkspaceTimingSummary;
  workspaceToSceneState: WorkspaceTimingSummary;
}>;

export type WorkspacePerformanceTierResult = Readonly<{
  tier: Readonly<{ requestedComponents: number }>;
  fixture: Readonly<{
    workspaceId: string;
    revision: number;
    components: number;
    spatialComponents: number;
    connections: number;
    collisionEnabledComponents: number;
    projectBytes: number;
  }>;
  measurements: WorkspacePerformanceMeasurements;
  verification: Readonly<{
    workspaceDigest: string;
    reopenedWorkspaceDigest: string;
    sceneRevision: number;
    sceneEntities: number;
    commitResultingRevision: number;
    semanticRoundTripVerified: boolean;
  }>;
}>;

export type WorkspacePerformanceReport = Readonly<{
  schemaVersion: typeof WORKSPACE_PERFORMANCE_BENCHMARK_SCHEMA_VERSION;
  benchmark: typeof WORKSPACE_PERFORMANCE_BENCHMARK_NAME;
  generatedAt: string;
  profile: WorkspacePerformanceProfile;
  runtime: WorkspacePerformanceRuntime;
  configuration: Readonly<{
    tiers: readonly number[];
    samplesPerMeasurement: number;
    warmupSamples: number;
    collisionStride: number;
    connectionStride: number;
  }>;
  results: readonly WorkspacePerformanceTierResult[];
}>;

export type WorkspacePerformanceRunOptions = Readonly<{
  profile?: Exclude<WorkspacePerformanceProfile, "custom">;
  tiers?: readonly number[];
  samplesPerMeasurement?: number;
  warmupSamples?: number;
  clock?: () => number;
  generatedAt?: string;
  runtime?: WorkspacePerformanceRuntime;
}>;

export type DeterministicWorkspaceFixture = Readonly<{
  store: WorkspaceStore;
  plan: WorkspaceFixturePlan;
  firstSpatialComponentId: string;
}>;

type ProfileDefaults = Readonly<{
  tiers: readonly number[];
  samplesPerMeasurement: number;
  warmupSamples: number;
}>;

const PROFILE_DEFAULTS: Readonly<Record<Exclude<WorkspacePerformanceProfile, "custom">, ProfileDefaults>> = {
  smoke: { tiers: [100], samplesPerMeasurement: 1, warmupSamples: 0 },
  ci: { tiers: [100, 500], samplesPerMeasurement: 3, warmupSamples: 1 },
  full: { tiers: WORKSPACE_PERFORMANCE_BENCHMARK_TIERS, samplesPerMeasurement: 1, warmupSamples: 0 },
};

function fixedClock(): number {
  return FIXTURE_CLOCK_MS;
}

function componentId(sequence: number): string {
  return `CMP_${String(sequence).padStart(6, "0")}`;
}

function worldPlacement(index: number) {
  const side = Math.ceil(Math.sqrt(MAX_WORKSPACE_COMPONENTS));
  const column = index % side;
  const row = Math.floor(index / side);
  return {
    space: "world3d" as const,
    position: {
      x: (column - Math.floor(side / 2)) * 2.5,
      y: 0.5,
      z: (row - Math.floor(side / 2)) * 2.5,
    },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function viewportPlacement(index: number) {
  // The full tier contains 80 controls with different intrinsic sizes. Keep
  // every cell larger than the widest/tallest control so the benchmark tests
  // Store throughput rather than intentionally exercising layout rejection.
  const columns = 8;
  return {
    space: "viewport" as const,
    anchor: "top_left" as const,
    offset: {
      x: (index % columns) * 320,
      y: Math.floor(index / columns) * 280,
    },
  };
}

function workspaceBatch(
  store: WorkspaceStore,
  requestId: string,
  operations: WorkspaceOperation[],
): WorkspaceCommandBatch {
  return {
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    request_id: requestId,
    workspace_id: store.getState().workspaceId,
    input_revision: store.getRevision(),
    base_workspace_revision: store.getRevision(),
    registry_digest: store.getRegistryDigest(),
    mode: "commit",
    operations,
  };
}

function applyInBatches(
  store: WorkspaceStore,
  requestPrefix: string,
  operations: readonly WorkspaceOperation[],
): void {
  for (let offset = 0; offset < operations.length; offset += COMPONENT_BATCH_SIZE) {
    const batch = operations.slice(offset, offset + COMPONENT_BATCH_SIZE);
    store.apply(workspaceBatch(store, `${requestPrefix}_${offset / COMPONENT_BATCH_SIZE}`, batch));
  }
}

function collisionEnabledCount(store: WorkspaceStore): number {
  return [...store.getState().components.values()].filter((component) => {
    const collision = component.props.collision;
    return collision !== null
      && typeof collision === "object"
      && !Array.isArray(collision)
      && collision.enabled === true;
  }).length;
}

export function planDeterministicWorkspaceFixture(componentCount: number): WorkspaceFixturePlan {
  if (!Number.isSafeInteger(componentCount) || componentCount < 5 || componentCount > MAX_WORKSPACE_COMPONENTS) {
    throw new RangeError(`componentCount must be an integer from 5 to ${MAX_WORKSPACE_COMPONENTS}`);
  }
  const connections = Math.max(1, Math.floor(componentCount / CONNECTION_STRIDE));
  const controlComponents = connections * 2;
  const spatialComponents = componentCount - controlComponents - 1;
  if (spatialComponents < 1) throw new RangeError("componentCount is too small for the deterministic fixture");
  return {
    requestedComponents: componentCount,
    stageComponents: 1,
    spatialComponents,
    controlComponents,
    connections,
    collisionEnabledComponents: Math.ceil(spatialComponents / COLLISION_STRIDE),
    collisionStride: COLLISION_STRIDE,
    connectionStride: CONNECTION_STRIDE,
  };
}

/**
 * Builds a deterministic mixed 2D/3D Workspace exclusively through public
 * WorkspaceStore command batches. Solid collision participants and event
 * connections are intentionally sparse so the benchmark exercises those
 * validation paths without turning the fixture into a collision stress test.
 */
export function buildDeterministicWorkspaceFixture(componentCount: number): DeterministicWorkspaceFixture {
  const plan = planDeterministicWorkspaceFixture(componentCount);
  const workspaceId = `benchmark_${String(componentCount).padStart(4, "0")}`;
  const fixtureStore = new WorkspaceStore({
    initialState: createInitialWorkspace(workspaceId, DEFAULT_COMPONENT_REGISTRY),
    registry: DEFAULT_COMPONENT_REGISTRY,
    clock: fixedClock,
  });

  const operations: WorkspaceOperation[] = [{
    op: "create_component",
    op_id: "create_stage",
    id: componentId(1),
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    label: "Benchmark Stage",
    placement: worldPlacement(0),
    props: {
      environmentPreset: "blank_stage",
      dimensions: { width: 160, height: 20, depth: 160 },
      gridVisible: true,
    },
  }];
  const buttonIds: string[] = [];
  const checklistIds: string[] = [];
  let sequence = 2;
  for (let index = 0; index < plan.connections; index += 1) {
    const buttonId = componentId(sequence++);
    const checklistId = componentId(sequence++);
    buttonIds.push(buttonId);
    checklistIds.push(checklistId);
    operations.push({
      op: "create_component",
      op_id: `create_button_${index}`,
      id: buttonId,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("button"),
      label: `Benchmark Button ${index}`,
      placement: viewportPlacement(index * 2),
      props: { label: `Run ${index}`, variant: "secondary" },
    }, {
      op: "create_component",
      op_id: `create_checklist_${index}`,
      id: checklistId,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("checklist"),
      label: `Benchmark Checklist ${index}`,
      placement: viewportPlacement(index * 2 + 1),
      props: { title: `Results ${index}`, showCompleted: true },
    });
  }

  const firstSpatialComponentId = componentId(sequence);
  for (let index = 0; index < plan.spatialComponents; index += 1) {
    const id = componentId(sequence++);
    const collisionEnabled = index % COLLISION_STRIDE === 0;
    operations.push({
      op: "create_component",
      op_id: `create_spatial_${index}`,
      id,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      label: `Benchmark Spatial ${index}`,
      placement: worldPlacement(index),
      props: {
        assetId: "primitive_box",
        entityKind: "primitive",
        appearance: { color: index % 2 === 0 ? "#4F8CFF" : "#78D6A6" },
        state: { fixtureIndex: index },
        collision: collisionEnabled
          ? { enabled: true, role: "solid", shape: "asset_bounds", margin: 0 }
          : { enabled: false, role: "none", shape: "asset_bounds", margin: 0 },
      },
    });
  }
  applyInBatches(fixtureStore, `fixture_${componentCount}_components`, operations);

  const connectionOperations: WorkspaceOperation[] = buttonIds.map((buttonId, index) => ({
    op: "connect_event",
    op_id: `connect_${index}`,
    connection: {
      kind: "event_connection",
      id: `CONN_${String(index + 1).padStart(6, "0")}`,
      sourceComponentId: buttonId,
      event: "pressed",
      targetComponentId: checklistIds[index]!,
      action: "add_item",
      input: { id: `item_${index}`, text: `Triggered ${index}` },
      enabled: true,
    },
  }));
  applyInBatches(fixtureStore, `fixture_${componentCount}_connections`, connectionOperations);

  const state = fixtureStore.getState();
  const observedCollisionEnabled = collisionEnabledCount(fixtureStore);
  if (
    state.components.size !== plan.requestedComponents
    || state.connections.size !== plan.connections
    || observedCollisionEnabled !== plan.collisionEnabledComponents
  ) {
    throw new Error(
      `Fixture count mismatch: expected ${plan.requestedComponents}/${plan.connections}/${plan.collisionEnabledComponents}, `
      + `observed ${state.components.size}/${state.connections.size}/${observedCollisionEnabled}`,
    );
  }
  return { store: fixtureStore, plan, firstSpatialComponentId };
}

function roundTiming(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]!;
}

function summarizeDurations(durations: readonly number[]): WorkspaceTimingSummary {
  const sorted = [...durations].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    samples: sorted.length,
    durationsMs: durations.map(roundTiming),
    minMs: roundTiming(sorted[0]!),
    medianMs: roundTiming(median),
    p95Ms: roundTiming(percentile(sorted, 0.95)),
    maxMs: roundTiming(sorted[sorted.length - 1]!),
  };
}

function measureSync<Prepared, Result>(input: Readonly<{
  samples: number;
  warmups: number;
  clock: () => number;
  prepare: () => Prepared;
  run: (prepared: Prepared, ordinal: number) => Result;
}>): Readonly<{ summary: WorkspaceTimingSummary; result: Result }> {
  for (let index = 0; index < input.warmups; index += 1) {
    input.run(input.prepare(), -(index + 1));
  }
  const durations: number[] = [];
  let result: Result | undefined;
  for (let index = 0; index < input.samples; index += 1) {
    const prepared = input.prepare();
    const startedAt = input.clock();
    result = input.run(prepared, index);
    durations.push(Math.max(0, input.clock() - startedAt));
  }
  if (result === undefined) throw new Error("Benchmark measurement produced no samples");
  return { summary: summarizeDurations(durations), result };
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 0 to ${maximum}`);
  }
  return value;
}

export function resolveWorkspacePerformanceProfile(
  options: WorkspacePerformanceRunOptions = {},
): Readonly<{
  profile: WorkspacePerformanceProfile;
  tiers: readonly number[];
  samplesPerMeasurement: number;
  warmupSamples: number;
}> {
  const requestedProfile = options.profile ?? "ci";
  const defaults = PROFILE_DEFAULTS[requestedProfile];
  const tiers = [...(options.tiers ?? defaults.tiers)].map((tier) => {
    const normalized = positiveInteger(tier, "tier", MAX_WORKSPACE_COMPONENTS);
    if (normalized < 5) {
      throw new RangeError(`tier must be an integer from 5 to ${MAX_WORKSPACE_COMPONENTS}`);
    }
    return normalized;
  });
  if (!tiers.length) throw new RangeError("At least one benchmark tier is required");
  if (new Set(tiers).size !== tiers.length) throw new RangeError("Benchmark tiers must be unique");
  tiers.sort((left, right) => left - right);
  return {
    profile: options.tiers ? "custom" : requestedProfile,
    tiers,
    samplesPerMeasurement: positiveInteger(
      options.samplesPerMeasurement ?? defaults.samplesPerMeasurement,
      "samplesPerMeasurement",
      20,
    ),
    warmupSamples: nonNegativeInteger(
      options.warmupSamples ?? defaults.warmupSamples,
      "warmupSamples",
      10,
    ),
  };
}

function runTier(
  componentCount: number,
  samples: number,
  warmups: number,
  clock: () => number,
): WorkspacePerformanceTierResult {
  const fixture = buildDeterministicWorkspaceFixture(componentCount);
  const serializer = new WorkspaceProjectSerializer(DEFAULT_COMPONENT_REGISTRY);
  const baselineState = fixture.store.getState();
  const project = serializer.fromStore(`perf_${componentCount}`, fixture.store, {
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  });
  const serialized = serializer.serialize(project);
  const deserialized = serializer.deserialize(serialized);
  const renderSnapshot = toRenderSnapshot(baselineState);

  const commit = measureSync({
    samples,
    warmups,
    clock,
    prepare: () => {
      const store = new WorkspaceStore({
        initialState: baselineState,
        registry: DEFAULT_COMPONENT_REGISTRY,
        clock: fixedClock,
      });
      return {
        store,
        batch: workspaceBatch(store, `benchmark_commit_${componentCount}`, [{
          op: "update_component",
          op_id: "update_benchmark_label",
          id: fixture.firstSpatialComponentId,
          patch: { label: "Benchmark commit result" },
        }]),
      };
    },
    run: ({ store, batch }) => {
      store.apply(batch);
      return store.getRevision();
    },
  });
  const getStateClone = measureSync({
    samples,
    warmups,
    clock,
    prepare: () => fixture.store,
    run: (store) => store.getState(),
  });
  const projectSerialize = measureSync({
    samples,
    warmups,
    clock,
    prepare: () => project,
    run: (candidate) => serializer.serialize(candidate),
  });
  const projectDeserialize = measureSync({
    samples,
    warmups,
    clock,
    prepare: () => serialized,
    run: (candidate) => serializer.deserialize(candidate),
  });
  const projectOpenStore = measureSync({
    samples,
    warmups,
    clock,
    prepare: () => deserialized,
    run: (candidate) => serializer.openStore(candidate),
  });
  const renderProjection = measureSync({
    samples,
    warmups,
    clock,
    prepare: () => baselineState,
    run: (state) => toRenderSnapshot(state),
  });
  const sceneProjection = measureSync({
    samples,
    warmups,
    clock,
    prepare: () => renderSnapshot,
    run: (snapshot) => workspaceToSceneState(snapshot),
  });

  const workspaceDigest = workspaceStateDigest(baselineState);
  const reopenedWorkspaceDigest = workspaceStateDigest(projectOpenStore.result.getState());
  const semanticRoundTripVerified = workspaceDigest === reopenedWorkspaceDigest
    && baselineState.components.size === fixture.plan.requestedComponents
    && baselineState.connections.size === fixture.plan.connections
    && sceneProjection.result.entities.size === fixture.plan.spatialComponents;
  if (!semanticRoundTripVerified) {
    throw new Error(`Workspace benchmark semantic verification failed for tier ${componentCount}`);
  }

  return {
    tier: { requestedComponents: componentCount },
    fixture: {
      workspaceId: baselineState.workspaceId,
      revision: baselineState.revision,
      components: baselineState.components.size,
      spatialComponents: fixture.plan.spatialComponents,
      connections: baselineState.connections.size,
      collisionEnabledComponents: collisionEnabledCount(fixture.store),
      projectBytes: new TextEncoder().encode(serialized).byteLength,
    },
    measurements: {
      commit: commit.summary,
      getStateClone: getStateClone.summary,
      projectSerialize: projectSerialize.summary,
      projectDeserialize: projectDeserialize.summary,
      projectOpenStore: projectOpenStore.summary,
      toRenderSnapshot: renderProjection.summary,
      workspaceToSceneState: sceneProjection.summary,
    },
    verification: {
      workspaceDigest,
      reopenedWorkspaceDigest,
      sceneRevision: sceneProjection.result.revision,
      sceneEntities: sceneProjection.result.entities.size,
      commitResultingRevision: commit.result,
      semanticRoundTripVerified,
    },
  };
}

export function runWorkspacePerformanceBenchmark(
  options: WorkspacePerformanceRunOptions = {},
): WorkspacePerformanceReport {
  const resolved = resolveWorkspacePerformanceProfile(options);
  const clock = options.clock ?? (() => globalThis.performance.now());
  return {
    schemaVersion: WORKSPACE_PERFORMANCE_BENCHMARK_SCHEMA_VERSION,
    benchmark: WORKSPACE_PERFORMANCE_BENCHMARK_NAME,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    profile: resolved.profile,
    runtime: options.runtime ?? { node: "unknown", platform: "unknown", arch: "unknown" },
    configuration: {
      tiers: resolved.tiers,
      samplesPerMeasurement: resolved.samplesPerMeasurement,
      warmupSamples: resolved.warmupSamples,
      collisionStride: COLLISION_STRIDE,
      connectionStride: CONNECTION_STRIDE,
    },
    results: resolved.tiers.map((tier) => runTier(
      tier,
      resolved.samplesPerMeasurement,
      resolved.warmupSamples,
      clock,
    )),
  };
}
