import { describe, expect, it } from "vitest";
import { MemoryAssetVault } from "../../workspace/assets";
import { digestBlobSha256 } from "../../workspace/assets/digest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { JSONObject } from "../../workspace/components/componentTypes";
import { WorkspaceStore } from "../../workspace/state";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { createPortableProjectBundle, importPortableProjectBundle, inspectPortableArchive } from "../../workspace/persistence/portable";
import { collectPortablePrecisionEvidence, precisionEvidencePath } from "../../workspace/persistence/portable/precisionClosure";
import { MemoryPrecisionEvidenceVault, type PrecisionEvidenceRef } from "../../workspace/precision/evidenceVault";
import { importMeasurementGeometry } from "../../workspace/precision/geometryImport";
import { createPrecisionStudy, evaluatePrecisionStudy } from "../../workspace/precision";
import { workspaceBatch } from "../workspace/helpers";
import { readPortableBlobRange } from "../../workspace/persistence/portable/crc32";

async function fixture() {
  const text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
  const blob = new Blob([text], { type: "model/obj" });
  const ref: PrecisionEvidenceRef = { digest: await digestBlobSha256(blob), byteLength: blob.size, kind: "measurement-source", mediaType: "model/obj" };
  const evidenceVault = new MemoryPrecisionEvidenceVault();
  await evidenceVault.put(ref, blob);
  const study = createPrecisionStudy(importMeasurementGeometry({ data: text, format: "obj", geometryId: "source", coordinateBasis: "RUB", units: "metre", provenance: "Synthetic unit test; not measured accuracy" }));
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "precision_create", [{ op: "create_component", op_id: "create", id: "study",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("precision-study"),
    placement: { space: "canvas2d", position: { x: 0, y: 0 }, size: { width: 520, height: 420 }, zIndex: 0 },
    props: { document: study as unknown as JSONObject, evidenceSources: [ref as unknown as JSONObject] } }]));
  const serializer = new WorkspaceProjectSerializer();
  return { ref, blob, evidenceVault, study, store, serializer };
}

describe("portable precision evidence", () => {
  it("reopens geometry and exact source bytes in a clean profile and retains deleted study undo", async () => {
    const f = await fixture();
    f.store.apply(workspaceBatch(f.store, "delete_study", [{ op: "delete_component", op_id: "delete", id: "study" }]));
    const project = f.serializer.fromStore("precision_project", f.store);
    expect(collectPortablePrecisionEvidence(project)).toEqual([f.ref]);
    const result = await createPortableProjectBundle(project, new MemoryAssetVault(), { evidenceVault: f.evidenceVault });
    expect(result.manifest.version).toBe("1.1");
    const target = new MemoryPrecisionEvidenceVault();
    const reopened = await importPortableProjectBundle(await result.toBlob(), { vault: new MemoryAssetVault(), evidenceVault: target });
    expect(await readPortableBlobRange(await target.open(f.ref), 0, f.blob.size)).toEqual(await readPortableBlobRange(f.blob, 0, f.blob.size));
    const store = f.serializer.openStore(reopened.project);
    store.undo();
    expect(store.getState().components.get("study")?.props.document).toEqual(f.study);
    expect(evaluatePrecisionStudy(f.study).status).toBe("unverified");
    store.redo();
    expect(store.getState().components.has("study")).toBe(false);
  });

  it("refuses missing bytes and corrupted archive bytes before mutating target", async () => {
    const f = await fixture();
    const project = f.serializer.fromStore("precision_project", f.store);
    await expect(createPortableProjectBundle(project, new MemoryAssetVault(), { evidenceVault: new MemoryPrecisionEvidenceVault() })).rejects.toThrow(/Missing precision evidence/);
    class CorruptCustomVault extends MemoryPrecisionEvidenceVault {
      override async open(): Promise<Blob> { return new Blob(["corrupted custom vault response"]); }
    }
    await expect(createPortableProjectBundle(project, new MemoryAssetVault(), { evidenceVault: new CorruptCustomVault() })).rejects.toThrow(/SHA-256/);
    const bundle = await createPortableProjectBundle(project, new MemoryAssetVault(), { evidenceVault: f.evidenceVault });
    const blob = await bundle.toBlob();
    const layout = await inspectPortableArchive(blob);
    const entry = layout.entries.find((item) => item.path === precisionEvidencePath(f.ref))!;
    const bytes = await readPortableBlobRange(blob, 0, blob.size);
    bytes[entry.dataOffset] = bytes[entry.dataOffset]! ^ 1;
    let committed = false;
    const target = new MemoryPrecisionEvidenceVault();
    await expect(importPortableProjectBundle(new Blob([bytes as BlobPart]), { vault: new MemoryAssetVault(), evidenceVault: target, commitProject: () => { committed = true; } })).rejects.toThrow();
    expect(committed).toBe(false);
    await expect(target.open(f.ref)).rejects.toThrow(/Missing/);
  });

  it("rolls back newly imported source bytes when project commit fails, preserves reused evidence", async () => {
    const f = await fixture();
    const bundle = await createPortableProjectBundle(f.serializer.fromStore("precision_project", f.store), new MemoryAssetVault(), { evidenceVault: f.evidenceVault });
    const blob = await bundle.toBlob();
    const target = new MemoryPrecisionEvidenceVault();
    const rejectCommit = () => { throw new Error("commit rejected"); };
    await expect(importPortableProjectBundle(blob, { vault: new MemoryAssetVault(), evidenceVault: target, commitProject: rejectCommit })).rejects.toThrow();
    await expect(target.open(f.ref)).rejects.toThrow(/Missing/);
    await target.put(f.ref, f.blob);
    await expect(importPortableProjectBundle(blob, { vault: new MemoryAssetVault(), evidenceVault: target, commitProject: rejectCommit })).rejects.toThrow();
    expect((await target.open(f.ref)).size).toBe(f.blob.size);
  });

  it("rejects caller-forged reports at the transaction boundary without mutating state", async () => {
    const f = await fixture(); const revision = f.store.getRevision();
    expect(() => f.store.apply(workspaceBatch(f.store, "forge_report", [{ op: "update_component", op_id: "forge", id: "study", patch: { props: { document: { ...f.study, status: "pass_for_scope" } as unknown as JSONObject } } }]))).toThrow();
    expect(f.store.getRevision()).toBe(revision);
  });
});
