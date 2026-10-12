import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../../workspace/state/WorkspaceStore";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import type { WorkspaceAgentPrincipal } from "../../../workspace/agents/contracts";
import type { JSONObject } from "../../../workspace/components/componentTypes";
import { createPrecisionStudy } from "../../../workspace/precision/validation";
import { analyzePrecisionDocument } from "../../../workspace/precision/workspaceAnalysis";
import type { MeasurementGeometry } from "../../../workspace/precision/types";
import { MemoryPrecisionEvidenceVault } from "../../../workspace/precision/evidenceVault";
import { digestBlobSha256 } from "../../../workspace/assets/digest";
import { importMeasurementGeometry } from "../../../workspace/precision/geometryImport";

const reader: WorkspaceAgentPrincipal = { sessionId: "precision_session", clientId: "precision_agent", clientName: "Precision agent", scopes: ["workspace:read"] };

function geometry(units: MeasurementGeometry["units"] = "metre", width = 10): MeasurementGeometry {
  return {
    geometryId: "measured_plate", units, coordinateBasis: "RUB",
    source: { sha256: `sha256:${"a".repeat(64)}`, format: "obj", provenance: "Synthetic planar fixture, not physical measurements" },
    positions: Array.from({ length: width * width }, (_, index) => [index % width, Math.floor(index / width), 0] as const),
  };
}

function setup(document: unknown = createPrecisionStudy(geometry()), options: ConstructorParameters<typeof WorkspaceStoreEngineAdapter>[1] = {}, evidenceSources: unknown[] = []) {
  const store = new WorkspaceStore();
  const type = store.getComponentManifest("precision-study")!;
  const state = store.getState();
  store.apply({ protocol_version: "1.3", request_id: "create_precision_panel", workspace_id: state.workspaceId,
    input_revision: state.revision, base_workspace_revision: state.revision, registry_digest: state.registryDigest,
    mode: "commit", operations: [{ op: "create_component", op_id: "create_study", id: "STUDY",
      component_type: { typeId: type.typeId, version: type.version, digest: type.digest },
      props: { document: document as JSONObject, evidenceSources: evidenceSources as JSONObject[] },
      placement: { space: "viewport", anchor: "top_left", offset: { x: 24, y: 24 } },
    }],
  });
  return { store, adapter: new WorkspaceStoreEngineAdapter(store, options) };
}

describe("revision-bound precision agent analysis", () => {
  it("authenticates declared evidence and raw geometry before reporting, without certifying physical truth", async () => {
    const text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const blob = new Blob([text]);
    const ref = { digest: await digestBlobSha256(blob), byteLength: blob.size, kind: "measurement-source" as const, mediaType: "model/obj" };
    const vault = new MemoryPrecisionEvidenceVault();
    await vault.put(ref, blob);
    const document = createPrecisionStudy(importMeasurementGeometry({ data: text, format: "obj", units: "metre", coordinateBasis: "RUB",
      geometryId: "source", provenance: "Synthetic fixture; metric unit choice is caller-supplied" }));
    const { adapter } = setup(document, { precisionEvidenceVault: vault }, [ref]);
    expect(await adapter.analyzePrecision("STUDY", "inspect", {}, reader)).toMatchObject({ analysis: { evidence: {
      retainedBytesStatus: "all-declared-references-verified", sourceBytesAuthenticated: true, physicalAccuracyCertified: false,
      normalizedGeometryStatus: "exact-retained-source-correspondence",
    } } });
    const modified = { ...document, geometry: { ...document.geometry, positions: [[0, 0, 0], [2, 0, 0], [0, 1, 0]] } };
    const forged = setup(modified, { precisionEvidenceVault: vault }, [ref]);
    await expect(forged.adapter.analyzePrecision("STUDY", "inspect", {}, reader)).rejects.toMatchObject({ code: "precision_source_geometry_mismatch" });
    await expect(forged.adapter.inspectComponent("STUDY", reader)).rejects.toMatchObject({ code: "precision_source_geometry_mismatch" });
    const forgedTopology = setup({ ...document, geometry: { ...document.geometry, triangles: [[0, 2, 1]] } }, { precisionEvidenceVault: vault }, [ref]);
    await expect(forgedTopology.adapter.analyzePrecision("STUDY", "fit_plane", {}, reader)).rejects.toMatchObject({ code: "precision_source_geometry_mismatch" });
    await vault.delete(ref.digest);
    await expect(adapter.analyzePrecision("STUDY", "inspect", {}, reader)).rejects.toMatchObject({ code: "precision_source_unavailable" });
    await expect(adapter.inspectComponent("STUDY", reader)).rejects.toMatchObject({ code: "precision_source_unavailable" });
    // Even a custom vault that incorrectly returns corrupt bytes cannot grant authority.
    const corrupt = setup(document, { precisionEvidenceVault: {
      open: async () => new Blob([text.replace("v 1", "v 2")]), put: async () => ({ inserted: false }), delete: async () => undefined,
    } }, [ref]);
    await expect(corrupt.adapter.analyzePrecision("STUDY", "inspect", {}, reader)).rejects.toMatchObject({ code: "precision_source_unavailable" });
  });
  it("prepares a source from an approved exact evidence reference without granting arbitrary file access or mutation", async () => {
    const vault = new MemoryPrecisionEvidenceVault();
    const blob = new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"]);
    const ref = { digest: await digestBlobSha256(blob), byteLength: blob.size, kind: "measurement-source" as const, mediaType: "model/obj" };
    await vault.put(ref, blob);
    const { adapter, store } = setup(null, { precisionEvidenceVault: vault }, [ref]);
    const before = store.getRevision();
    const input = { sourceDigest: ref.digest, format: "obj", coordinateBasis: "RUB", provenance: "Operator declares working-frame axes; scale still unknown" };
    expect(await adapter.analyzePrecision("STUDY", "prepare_source", input, reader)).toMatchObject({
      document: { geometry: { units: "unknown", coordinateBasis: "RUB", positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]] } },
      commit: { mutated: false }, analysis: { report: { status: "unverified" } },
    });
    expect(store.getRevision()).toBe(before);
    expect(store.getState().components.get("STUDY")!.props.document).toBeNull();
    await expect(adapter.analyzePrecision("STUDY", "prepare_source", { ...input, sourceDigest: `sha256:${"b".repeat(64)}` }, reader))
      .rejects.toMatchObject({ code: "precision_source_not_registered" });
    await expect(adapter.analyzePrecision("STUDY", "prepare_source", { ...input, path: "/private/source.obj" }, reader))
      .rejects.toMatchObject({ code: "invalid_precision_options" });
    await vault.delete(ref.digest);
    await expect(adapter.analyzePrecision("STUDY", "prepare_source", input, reader))
      .rejects.toMatchObject({ code: "precision_source_unavailable" });
  });
  it("requires read scope, derives compact evidence, and exposes the same report in component inspection", async () => {
    const { store, adapter } = setup();
    await expect(adapter.analyzePrecision("STUDY", "inspect", {}, { ...reader, scopes: [] })).rejects.toMatchObject({ code: "permission_denied" });
    const before = store.getState().revision;
    const analyzed = await adapter.analyzePrecision("STUDY", "inspect", {}, reader) as Record<string, unknown>;
    expect(analyzed).toMatchObject({ workspace_id: store.getState().workspaceId, workspace_revision: before, component_id: "STUDY",
      analysis: { source: { vertexCount: 100, sourceGeometryOnly: true, linkedCadCertified: false }, report: { status: "unverified", assessmentUsedAllChecks: true },
        evidence: { normalizedGeometryStatus: "embedded-geometry-only", sourceBytesAuthenticated: false } } });
    const inspected = await adapter.inspectComponent("STUDY", reader);
    expect(inspected.currentGeometry).toMatchObject({ precision: analyzed.analysis });
    expect(store.getState().revision).toBe(before);
    await expect(adapter.analyzePrecision("missing", "inspect", {}, reader)).rejects.toMatchObject({ code: "component_not_found" });
  });

  it("keeps fitting distinct from independent validation and never returns giant index arrays", async () => {
    const { store, adapter } = setup();
    const before = store.getState().revision;
    const result = await adapter.analyzePrecision("STUDY", "fit_plane", { toleranceM: 0.001 }, reader);
    expect(result).toMatchObject({ analysis: { report: { status: "unverified" }, fit: { kind: "plane", evidence: {
      status: "fit_only_not_independent_validation", sampleCount: 100, inlierCount: 100,
      indicesTruncated: true, fitUsedAllSamples: true,
    } } } });
    const json = JSON.stringify(result);
    expect(json).not.toContain('"inlierIndices":');
    expect(json.length).toBeLessThan(12_000);
    expect(store.getState().revision).toBe(before);
  });

  it("returns editable CAD proposals without mutation or transferring source accuracy certification", async () => {
    const { store, adapter } = setup();
    const before = store.getState().revision;
    expect(await adapter.analyzePrecision("STUDY", "propose_plate", {
      toleranceM: 0.001, partId: "measured_plate_proposal", thicknessM: 0.01,
      thicknessProvenance: "Independent micrometer reading, synthetic test",
    }, reader)).toMatchObject({ analysis: { proposal: { status: "proposal_not_validated", sourceReportCertifiesProposal: false,
      definition: { partId: "measured_plate_proposal", units: "metre" } }, commit: { mutated: false, requiredWorkflow: "begin_workspace_update_then_submit_workspace_batch" } } });
    expect(store.getState().revision).toBe(before);
    expect(store.getState().components.size).toBe(1);
  });

  it("fails unknown scale, malformed documents/actions/options instead of fabricating dimensions", async () => {
    const { adapter } = setup(createPrecisionStudy(geometry("unknown")));
    await expect(adapter.analyzePrecision("STUDY", "fit_plane", {}, reader)).rejects.toMatchObject({ code: "precision_calibration_required" });
    await expect(adapter.analyzePrecision("STUDY", "certify_whole_factory", {}, reader)).rejects.toMatchObject({ code: "invalid_precision_action" });
    await expect(adapter.analyzePrecision("STUDY", "inspect", { status: "pass" }, reader)).rejects.toMatchObject({ code: "invalid_precision_options" });
    await expect(adapter.analyzePrecision("STUDY", "propose_plate", { partId: "plate", thicknessM: 0.01 }, reader)).rejects.toMatchObject({ code: "invalid_precision_options" });
    expect(() => analyzePrecisionDocument({ status: "pass" })).toThrow("missing or invalid");
    const empty = setup(null);
    expect((await empty.adapter.inspectComponent("STUDY", reader)).currentGeometry).toMatchObject({ precision: { status: "unverified", documentPresent: false } });
    await expect(empty.adapter.analyzePrecision("STUDY", "inspect", {}, reader)).resolves.toMatchObject({ analysis: { status: "unverified", documentPresent: false } });
  });

  it("reports truncated check previews honestly while an omitted failing check determines status", () => {
    const base = createPrecisionStudy(geometry());
    const study = { ...base, policy: { ...base.policy, requiredRegions: ["plate"], toleranceM: 0.002 },
      checks: base.geometry.positions.slice(0, 40).map((point, index) => ({
        id: `check_${index}`, vertexIndex: index, referencePointM: index === 39 ? [point[0], point[1], 1] : point,
        uncertaintyM: 0.0001, provenance: "Independent fixture observations", regionId: "plate",
      })),
    };
    expect(analyzePrecisionDocument(study)).toMatchObject({ report: { status: "fail", checkCount: 40, checksTruncated: true, omittedCheckCount: 8, assessmentUsedAllChecks: true } });
  });
});
