import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrecisionStudyInspector, PrecisionStudyView } from "../../app/components/workspace/WorkspacePrecisionStudy";
import { importMeasurementGeometry } from "../../workspace/precision/geometryImport";
import { createPrecisionStudy } from "../../workspace/precision/validation";
import { MemoryPrecisionEvidenceVault, type PrecisionEvidenceRef } from "../../workspace/precision/evidenceVault";
import type { PrecisionStudyV1, PrecisionVec3 } from "../../workspace/precision/types";
import { digestBlobSha256 } from "../../workspace/assets/digest";
import { crc32Blob } from "../../workspace/persistence/portable/crc32";
import { materializePortableArchive, planPortableArchive } from "../../workspace/persistence/portable/archive";
import { exportPrecisionEvidenceBundle } from "../../workspace/precision/geometryExport";

afterEach(cleanup);
function study(): PrecisionStudyV1 {
  const geometry = importMeasurementGeometry({ data: "x,y,z\n0,0,0\n1,0,0\n0,1,0\n1,1,0", format: "xyz-csv", geometryId: "fixture", units: "metre", coordinateBasis: "RUB", provenance: "Synthetic UI fixture, not real measurement" });
  const base = createPrecisionStudy(geometry);
  return { ...base, policy: { ...base.policy, intendedUse: "Bracket setup inspection", uncertaintyBasis: "Synthetic fixture bounds", requiredRegions: ["fixture-region"] },
    checks: geometry.positions.slice(0, 3).map((referencePointM, vertexIndex) => ({ id: `check_${vertexIndex}`, vertexIndex, referencePointM, uncertaintyM: 0.0001, provenance: "Held-out synthetic observation", regionId: "fixture-region" })) };
}

describe("precision study human inspection", () => {
  it("scopes a passing result and never hides unknown uncertainty behind a green global badge", () => {
    const current = study();
    const rendered = render(<PrecisionStudyView document={current} />);
    expect(screen.getByText("Pass for declared checks only")).toBeInTheDocument();
    expect(screen.getByText(/Unchecked surfaces and hidden geometry are not verified/)).toBeInTheDocument();
    rendered.rerender(<PrecisionStudyView document={{ ...current, checks: current.checks.map((check) => ({ ...check, uncertaintyM: null })) }} />);
    expect(screen.queryByText("Pass for declared checks only")).not.toBeInTheDocument();
    expect(screen.getByText("Inconclusive — more evidence required")).toBeInTheDocument();
  });

  it("validates human JSON edits before invoking revisioned host updates", () => {
    const current = study(); const onUpdate = vi.fn();
    render(<PrecisionStudyInspector document={current} onUpdate={onUpdate} />);
    const editor = screen.getByLabelText("Precision study document JSON");
    fireEvent.change(editor, { target: { value: "{broken" } });
    expect(screen.getByRole("button", { name: "Apply study changes" })).toBeDisabled();
    const changed = { ...current, policy: { ...current.policy, toleranceM: 0.003 } };
    fireEvent.change(editor, { target: { value: JSON.stringify(changed) } });
    fireEvent.click(screen.getByRole("button", { name: "Apply study changes" }));
    expect(onUpdate).toHaveBeenCalledWith(changed);
  });

  it("requires basis confirmation, retains source bytes, and leaves new geometry unverified", async () => {
    const onUpdate = vi.fn(); const vault = new MemoryPrecisionEvidenceVault();
    render(<PrecisionStudyInspector document={null} onUpdate={onUpdate} evidenceVault={vault} />);
    const fileInput = screen.getByLabelText("Import measurement source");
    expect(fileInput).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I have established/ }));
    expect(fileInput).toBeEnabled();
    const file = new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"], "measurement.obj", { type: "model/obj" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    const [document, refs] = onUpdate.mock.calls[0]! as [PrecisionStudyV1, PrecisionEvidenceRef[]];
    expect(document.geometry.units).toBe("unknown");
    expect(document.checks).toEqual([]);
    await expect(vault.open(refs[0]!)).resolves.toHaveProperty("size", file.size);
    expect(screen.getByText(/original bytes retained/)).toBeInTheDocument();
  });

  it("rolls back newly staged source bytes if the workspace rejects the import", async () => {
    const onUpdate = vi.fn(() => false); const vault = new MemoryPrecisionEvidenceVault();
    render(<PrecisionStudyInspector document={null} onUpdate={onUpdate} evidenceVault={vault} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /I have established/ }));
    const file = new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"], "measurement.obj", { type: "model/obj" });
    fireEvent.change(screen.getByLabelText("Import measurement source"), { target: { files: [file] } });
    await screen.findByText(/workspace rejected the import/);
    const refs = (onUpdate.mock.calls[0] as unknown as [unknown, PrecisionEvidenceRef[]])[1];
    await expect(vault.open(refs[0]!)).rejects.toThrow(/Missing/);
  });

  it("prepares an editable shaft proposal and awaits host errors without pretending creation succeeded", async () => {
    const points = Array.from({ length: 5 }, (_, ring) => Array.from({ length: 36 }, (_, index): PrecisionVec3 => [Math.cos(index / 36 * 2 * Math.PI) * 0.2, ring * 0.3, Math.sin(index / 36 * 2 * Math.PI) * 0.2])).flat();
    const current = study(); const document = createPrecisionStudy({ ...current.geometry, positions: points });
    const onCreateCad = vi.fn(async () => { throw new Error("OCCT worker rejected proposal"); });
    render(<PrecisionStudyInspector document={document} onUpdate={vi.fn()} onCreateCad={onCreateCad} />);
    fireEvent.click(screen.getByRole("button", { name: "Propose fitted shaft" }));
    expect(screen.getByText("Unvalidated cylinder CAD proposal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create editable CAD proposal" }));
    await screen.findByText("OCCT worker rejected proposal");
    expect(onCreateCad).toHaveBeenCalledOnce();
    expect(screen.queryByText(/CAD proposal submitted/)).not.toBeInTheDocument();
  });

  it("verifies retained capture bytes and admits native mesh only after basis confirmation", async () => {
    const mesh = new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"], { type: "model/obj" });
    const meshDigest = await digestBlobSha256(mesh);
    const manifest = { schema: "semaframe.capture-bundle.v1", backend: { id: "test-backend", version: "1" }, profile: "preview", inputPhotoCount: 2,
      sourcePhotosRetained: false, units: "unknown", axes: "unknown", engineeringAuthority: "unverified_measurement", visualSha256: `sha256:${"a".repeat(64)}`, geometryPath: "native.obj",
      files: [{ path: "native.obj", objectPath: `objects/${meshDigest.slice(7)}`, role: "mesh", mediaType: "model/obj", byteLength: mesh.size, sha256: meshDigest }] };
    const manifestBlob = new Blob([JSON.stringify(manifest)]);
    const bundle = await materializePortableArchive(planPortableArchive([
      { path: "manifest.json", blob: manifestBlob, crc32: await crc32Blob(manifestBlob) },
      { path: `objects/${meshDigest.slice(7)}`, blob: mesh, crc32: await crc32Blob(mesh) },
    ]));
    const ref: PrecisionEvidenceRef = { digest: await digestBlobSha256(bundle), byteLength: bundle.size, kind: "capture-bundle", mediaType: "application/vnd.semaframe.capture+zip" };
    const vault = new MemoryPrecisionEvidenceVault(); await vault.put(ref, bundle);
    const onUpdate = vi.fn();
    render(<PrecisionStudyInspector document={null} evidenceSources={[ref]} onUpdate={onUpdate} evidenceVault={vault} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect retained native files" }));
    const admit = await screen.findByRole("button", { name: "Admit retained mesh with declared units and RUB basis" });
    expect(admit).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download native.obj" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I have established/ }));
    fireEvent.click(admit);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    const [document, refs] = onUpdate.mock.calls[0]! as [PrecisionStudyV1, PrecisionEvidenceRef[]];
    expect(document.geometry.source.sha256).toBe(meshDigest);
    expect(document.geometry.units).toBe("unknown");
    expect(document.checks).toEqual([]);
    expect(refs).toEqual([ref]);
    expect(screen.getByText(/no accuracy pass was granted/)).toBeInTheDocument();
  });

  it("withholds a scoped pass while referenced evidence is absent or corrupt", async () => {
    const current = study();
    const ref: PrecisionEvidenceRef = { digest: current.geometry.source.sha256 as `sha256:${string}`, byteLength: 20, kind: "measurement-source", mediaType: "text/csv" };
    render(<PrecisionStudyView document={current} evidenceSources={[ref]} evidenceVault={new MemoryPrecisionEvidenceVault()} />);
    expect(screen.queryByText("Pass for declared checks only")).not.toBeInTheDocument();
    await screen.findByText("Source evidence missing or corrupt — pass withheld");
    expect(screen.queryByText("Pass for declared checks only")).not.toBeInTheDocument();
  });

  it("withholds a pass when intact source bytes do not reproduce the normalized geometry", async () => {
    const current = study();
    const blob = new Blob(["x,y,z\n0,0,0\n1,0,0\n0,1,0\n1,1,0"]);
    const ref: PrecisionEvidenceRef = { digest: current.geometry.source.sha256 as `sha256:${string}`, byteLength: blob.size, kind: "measurement-source", mediaType: "text/csv" };
    const vault = new MemoryPrecisionEvidenceVault(); await vault.put(ref, blob);
    const changed = { ...current, geometry: { ...current.geometry, positions: [...current.geometry.positions.slice(0, 3), [2, 2, 0] as const] } };
    render(<PrecisionStudyView document={changed} evidenceSources={[ref]} evidenceVault={vault} />);
    await screen.findByText("Source evidence missing or corrupt — pass withheld");
    expect(screen.queryByText("Pass for declared checks only")).not.toBeInTheDocument();
    expect(screen.getByText(/normalized positions or topology do not exactly reproduce/)).toBeInTheDocument();
  });

  it("invalidates CAD comparisons when the workspace revision changes and discards delayed old results", async () => {
    const current = study();
    let finish: (value: unknown) => void = () => undefined;
    const onCompareCad = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const rendered = render(<PrecisionStudyInspector document={current} workspaceRevision={10} onUpdate={vi.fn()} onCompareCad={onCompareCad} />);
    fireEvent.change(screen.getByLabelText("Target CAD component ID"), { target: { value: "CMP_CAD" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare current CAD" }));
    rendered.rerender(<PrecisionStudyInspector document={current} workspaceRevision={11} onUpdate={vi.fn()} onCompareCad={onCompareCad} />);
    finish({ workspace_revision: 10, status: "pass_for_scope" });
    await screen.findByText(/Comparison discarded because the workspace changed/);
    expect(screen.queryByLabelText("CAD comparison result")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare current CAD" }));
    finish({ workspace_revision: 11, status: "pass_for_scope", scope: "sampled points only" });
    await screen.findByLabelText("CAD comparison result");
    rendered.rerender(<PrecisionStudyInspector document={current} workspaceRevision={12} onUpdate={vi.fn()} onCompareCad={onCompareCad} />);
    expect(screen.queryByLabelText("CAD comparison result")).not.toBeInTheDocument();
  });

  it("discards a staged source import if an agent changed the document during storage", async () => {
    const storage = new MemoryPrecisionEvidenceVault();
    let finish: () => void = () => undefined;
    const staged = new Promise<void>((resolve) => { finish = resolve; });
    const put = vi.fn(async (ref: PrecisionEvidenceRef, blob: Blob) => { const result = await storage.put(ref, blob); await staged; return result; });
    const vault = { put, open: storage.open.bind(storage), delete: vi.fn(storage.delete.bind(storage)) };
    const onUpdate = vi.fn();
    const rendered = render(<PrecisionStudyInspector document={null} workspaceRevision={10} onUpdate={onUpdate} evidenceVault={vault} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /I have established/ }));
    fireEvent.change(screen.getByLabelText("Import measurement source"), { target: { files: [new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"], "measurement.obj")] } });
    await waitFor(() => expect(put).toHaveBeenCalledOnce());
    rendered.rerender(<PrecisionStudyInspector document={study()} workspaceRevision={11} onUpdate={onUpdate} evidenceVault={vault} />);
    finish();
    await screen.findByText(/Workspace changed while retaining the source/);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(vault.delete).toHaveBeenCalledOnce();
  });

  it("imports audit JSON with recomputed status and no inherited original-source references", async () => {
    const current = createPrecisionStudy(study().geometry); const onUpdate = vi.fn();
    const bundle = exportPrecisionEvidenceBundle(current);
    const forged = { ...bundle, report: { status: "pass_for_scope" } };
    render(<PrecisionStudyInspector document={null} onUpdate={onUpdate} />);
    fireEvent.change(screen.getByLabelText("Import precision audit bundle"), { target: { files: [new File([JSON.stringify(forged)], "audit.json", { type: "application/json" })] } });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(current, []));
    expect(screen.getByText(/Embedded status was not trusted/)).toBeInTheDocument();
  });
});
