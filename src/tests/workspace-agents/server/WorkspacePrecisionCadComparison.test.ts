// @vitest-environment node
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../../workspace/state/WorkspaceStore";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import type { WorkspaceAgentPrincipal } from "../../../workspace/agents/contracts";
import type { JSONObject } from "../../../workspace/components/componentTypes";
import type { WorkspaceOperation } from "../../../workspace/protocol/workspaceTypes";
import { loadCadKernel, type CadKernel } from "../../../workspace/modeling/cadKernel";
import { cadPartDefinitionDigest } from "../../../workspace/modeling/cad";
import { createPrecisionStudy } from "../../../workspace/precision/validation";
import { proposeMeasurementPlateCad } from "../../../workspace/precision/fitting";
import type { MeasurementGeometry, PrecisionTriangle, PrecisionVec3 } from "../../../workspace/precision/types";

const reader: WorkspaceAgentPrincipal = { sessionId: "precision_session", clientId: "precision_agent", clientName: "Precision test", scopes: ["workspace:read"] };
const world = (x = 0) => ({ space: "world3d" as const, position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });

function apply(store: WorkspaceStore, operations: WorkspaceOperation[]) {
  const state = store.getState();
  store.apply({ protocol_version: "1.3", workspace_id: state.workspaceId, request_id: `precision_test_${state.revision}`,
    input_revision: state.revision, base_workspace_revision: state.revision, registry_digest: state.registryDigest, mode: "commit", operations });
}

async function setup() {
  const kernel = await loadCadKernel();
  const plane: MeasurementGeometry = { geometryId: "plane", units: "metre", coordinateBasis: "RUB",
    positions: [[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [0, 1, 0], [0.5, 1, 0], [1, 1, 0]],
    source: { sha256: `sha256:${"a".repeat(64)}`, format: "obj", provenance: "Synthetic CAD test input" } };
  const proposal = proposeMeasurementPlateCad(plane, { toleranceM: 0.001, partId: "plate", thicknessM: 0.1, thicknessProvenance: "Known synthetic fixture thickness" });
  const evaluated = await kernel.evaluatePart(proposal.definition, { includeMeshes: true, linearDeflectionM: 0.0005 });
  await kernel.dispose();
  const mesh = evaluated.meshes[0]!.mesh;
  const positions: PrecisionVec3[] = [];
  const triangles: PrecisionTriangle[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) positions.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
  for (let i = 0; i < mesh.indices.length; i += 3) triangles.push([mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!]);
  const geometry: MeasurementGeometry = { ...plane, geometryId: "source_mesh", positions, triangles };
  const base = createPrecisionStudy(geometry);
  const study = { ...base, policy: { ...base.policy, toleranceM: 0.003, requiredRegions: ["fixture"],
    surfaceUncertaintyM: 0.0001, surfaceUncertaintyBasis: "Synthetic fixture bound; not real object metrology" },
    checks: [0, 1, 2].map((vertexIndex) => ({ id: `heldout_${vertexIndex}`, vertexIndex,
      referencePointM: positions[vertexIndex]!, uncertaintyM: 0.0001, provenance: "Synthetic independent reference fixture", regionId: "fixture" })),
  };
  const store = new WorkspaceStore();
  const stage = store.getComponentManifest("stage-3d")!;
  const cad = store.getComponentManifest("cad-part")!;
  const precision = store.getComponentManifest("precision-study")!;
  apply(store, [
    { op: "create_component", op_id: "stage", id: "STAGE", component_type: { typeId: stage.typeId, version: stage.version, digest: stage.digest }, placement: world() },
    { op: "create_component", op_id: "target", id: "TARGET", component_type: { typeId: cad.typeId, version: cad.version, digest: cad.digest }, placement: world(),
      props: { definition: proposal.definition as unknown as JSONObject, definitionDigest: cadPartDefinitionDigest(proposal.definition), evaluation: evaluated.evidence as unknown as JSONObject } },
    { op: "create_component", op_id: "study", id: "STUDY", component_type: { typeId: precision.typeId, version: precision.version, digest: precision.digest },
      placement: { space: "viewport", anchor: "top_left", offset: { x: 24, y: 24 } }, props: { document: study as unknown as JSONObject } },
  ]);
  return { store, adapter: new WorkspaceStoreEngineAdapter(store, { cadKernelFactory: loadCadKernel }) };
}

describe("host-evaluated precision CAD comparison", () => {
  it("compares a current real OCCT target with explicit approximation allowance and no mutation", async () => {
    const { store, adapter } = await setup();
    const before = store.getRevision();
    const result = await adapter.analyzePrecision("STUDY", "compare_cad", { targetComponentId: "TARGET" }, reader);
    expect(result).toMatchObject({ workspace_revision: before, target_component_id: "TARGET",
      comparison_frame: "shared_identity_working_frame_not_geodetic", comparison: { status: "pass_for_scope",
        scope: "bidirectional-sampled-vertices-only", uncertaintyAuthority: "supplied-not-certified",
        sourceToCad: { method: "point-to-triangle" }, cadToSource: { method: "point-to-triangle" } } });
    expect(store.getRevision()).toBe(before);
    expect(JSON.stringify(result)).not.toContain('"positions":');
  }, 30_000);

  it("rejects moved CAD instead of silently ignoring target placement and rejects wrong target type", async () => {
    const { store, adapter } = await setup();
    apply(store, [{ op: "place_component", op_id: "move_target", id: "TARGET", placement: world(2) }]);
    await expect(adapter.analyzePrecision("STUDY", "compare_cad", { targetComponentId: "TARGET" }, reader))
      .rejects.toMatchObject({ code: "precision_frame_mismatch" });
    await expect(adapter.analyzePrecision("STUDY", "compare_cad", { targetComponentId: "STUDY" }, reader))
      .rejects.toMatchObject({ code: "invalid_precision_target" });
  }, 30_000);

  it("rejects a changed workspace while asynchronous target evaluation is running", async () => {
    const { store } = await setup();
    const adapter = new WorkspaceStoreEngineAdapter(store, { cadKernelFactory: async () => {
      const kernel = await loadCadKernel();
      return new Proxy(kernel, { get(target, property) {
        if (property === "evaluatePart") return async (...args: Parameters<CadKernel["evaluatePart"]>) => {
          const result = await target.evaluatePart(...args);
          apply(store, [{ op: "update_component", op_id: "human_edit", id: "TARGET", patch: { label: "Human changed target" } }]);
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } });
    await expect(adapter.analyzePrecision("STUDY", "compare_cad", { targetComponentId: "TARGET" }, reader))
      .rejects.toMatchObject({ code: "stale_workspace_revision" });
  }, 30_000);
});
