import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  buildDeterministicWorkspaceFixture,
  planDeterministicWorkspaceFixture,
  resolveWorkspacePerformanceProfile,
  runWorkspacePerformanceBenchmark,
  WORKSPACE_PERFORMANCE_BENCHMARK_TIERS,
} from "../../benchmarks/workspacePerformanceBenchmark";
import benchmarkSchema from "../../benchmarks/workspacePerformanceBenchmark.schema.json";
import { findLayoutOverlaps } from "../../workspace/layout";
import { toRenderSnapshot } from "../../workspace/renderer/contracts";
import { workspaceToSceneState } from "../../workspace/renderer/ThreeComponentRenderer";

describe("Workspace core performance benchmark", () => {
  it("plans the canonical 100, 500, and 2000 component tiers deterministically", () => {
    expect(WORKSPACE_PERFORMANCE_BENCHMARK_TIERS).toEqual([100, 500, 2_000]);
    expect(resolveWorkspacePerformanceProfile({ profile: "ci" })).toMatchObject({
      profile: "ci",
      tiers: [100, 500],
    });
    expect(resolveWorkspacePerformanceProfile({ profile: "full" })).toMatchObject({
      profile: "full",
      tiers: [100, 500, 2_000],
    });
    expect(WORKSPACE_PERFORMANCE_BENCHMARK_TIERS.map(planDeterministicWorkspaceFixture)).toEqual([
      expect.objectContaining({
        requestedComponents: 100,
        spatialComponents: 95,
        controlComponents: 4,
        connections: 2,
        collisionEnabledComponents: 4,
      }),
      expect.objectContaining({
        requestedComponents: 500,
        spatialComponents: 479,
        controlComponents: 20,
        connections: 10,
        collisionEnabledComponents: 20,
      }),
      expect.objectContaining({
        requestedComponents: 2_000,
        spatialComponents: 1_919,
        controlComponents: 80,
        connections: 40,
        collisionEnabledComponents: 77,
      }),
    ]);
  });

  it("builds the fixture through Workspace commands with exact semantic counts", () => {
    const fixture = buildDeterministicWorkspaceFixture(100);
    const state = fixture.store.getState();
    const renderSnapshot = toRenderSnapshot(state);
    const scene = workspaceToSceneState(renderSnapshot);
    expect(state.components.size).toBe(100);
    expect(state.connections.size).toBe(2);
    expect(scene.entities.size).toBe(95);
    expect(scene.revision).toBe(state.revision);
    expect(findLayoutOverlaps(state)).toEqual([]);
    expect(state.components.get(fixture.firstSpatialComponentId)?.props.collision).toMatchObject({
      enabled: true,
      role: "solid",
    });
  });

  it("emits schema-valid JSON and verifies persistence/projection semantics without time thresholds", () => {
    let clock = 0;
    const report = runWorkspacePerformanceBenchmark({
      profile: "smoke",
      samplesPerMeasurement: 1,
      warmupSamples: 0,
      clock: () => {
        clock += 0.25;
        return clock;
      },
      generatedAt: "2026-08-26T00:00:00.000Z",
      runtime: { node: "test", platform: "test", arch: "test" },
    });
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(benchmarkSchema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.results).toHaveLength(1);
    const result = report.results[0]!;
    expect(result.fixture).toMatchObject({
      components: 100,
      spatialComponents: 95,
      connections: 2,
      collisionEnabledComponents: 4,
    });
    expect(result.verification).toMatchObject({
      sceneEntities: 95,
      semanticRoundTripVerified: true,
    });
    expect(result.verification.reopenedWorkspaceDigest).toBe(result.verification.workspaceDigest);
    for (const measurement of Object.values(result.measurements)) {
      expect(measurement.samples).toBe(1);
      expect(measurement.durationsMs).toHaveLength(1);
      expect(measurement.minMs).toBeGreaterThanOrEqual(0);
      expect(measurement.maxMs).toBeGreaterThanOrEqual(measurement.minMs);
    }
  });
});
