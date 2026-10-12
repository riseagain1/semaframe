import { useEffect, useMemo, useRef, useState } from "react";
import type { CadPartDefinitionV1 } from "../../../workspace/modeling/cad";
import { exportMeasurementGeometry, exportPrecisionEvidenceBundle, importPrecisionEvidenceBundle } from "../../../workspace/precision/geometryExport";
import { proposeMeasurementPlateCad, proposeMeasurementShaftCad, type CadFitProposal } from "../../../workspace/precision/fitting";
import { calibratedGeometry } from "../../../workspace/precision/calibration";
import { evaluatePrecisionStudy } from "../../../workspace/precision/verification";
import { createPrecisionStudy, parsePrecisionStudy } from "../../../workspace/precision/validation";
import type { PrecisionReport, PrecisionStudyV1, PrecisionUnit } from "../../../workspace/precision/types";
import { importMeasurementGeometry, MEASUREMENT_IMPORT_LIMITS, type MeasurementImportFormat } from "../../../workspace/precision/geometryImport";
import { defaultPrecisionEvidenceVault, parsePrecisionEvidenceRef, type PrecisionEvidenceRef, type PrecisionEvidenceVault } from "../../../workspace/precision/evidenceVault";
import { inspectCaptureBundle } from "../../../reconstruction/captureBundle";
import { readPortableBlobRange } from "../../../workspace/persistence/portable/crc32";
import { PrecisionGeometryPreview } from "./PrecisionGeometryPreview";
import { authenticatePrecisionEvidence } from "../../../workspace/precision/evidenceAuthentication";
import "./WorkspacePrecisionStudy.css";

export type PrecisionStudyViewProps = Readonly<{ document: unknown; evidenceSources?: unknown; workspaceRevision?: number; evidenceVault?: PrecisionEvidenceVault }>;
export type PrecisionStudyInspectorProps = PrecisionStudyViewProps & Readonly<{
  onUpdate: (document: unknown, evidenceSources?: unknown[]) => boolean | void;
  disabled?: boolean;
  onCreateCad?: (definition: CadPartDefinitionV1) => void | Promise<void>;
  onCompareCad?: (targetComponentId: string) => Promise<unknown>;
}>;

function message(error: unknown): string { return error instanceof Error ? error.message : "The precision operation could not be completed."; }
function inspect(document: unknown): { study?: PrecisionStudyV1; report?: PrecisionReport; error?: string } {
  try { const study = parsePrecisionStudy(document); return { study, report: evaluatePrecisionStudy(study) }; }
  catch (error) { return { error: message(error) }; }
}
function label(report: PrecisionReport): string {
  return report.status === "pass_for_scope" ? "Pass for declared checks only" : report.status === "inconclusive" ? "Inconclusive — more evidence required" : report.status === "fail" ? "Outside the declared tolerance" : "Unverified";
}
function mm(value: number | null | undefined): string { return value == null ? "unknown" : `${(value * 1_000).toPrecision(4)} mm`; }
function comparisonOverview(result: unknown): { status: string; conservativeMaximumM: number | null; scope: string } {
  const root = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const comparison = root.comparison && typeof root.comparison === "object" ? root.comparison as Record<string, unknown> : root;
  const status = comparison.status === "pass_for_scope" ? "Pass for sampled comparison scope only" : comparison.status === "fail" ? "Outside comparison tolerance" : comparison.status === "inconclusive" ? "Inconclusive" : "Unverified";
  return { status, conservativeMaximumM: typeof comparison.conservativeMaximumM === "number" && Number.isFinite(comparison.conservativeMaximumM) ? comparison.conservativeMaximumM : null,
    scope: typeof comparison.scope === "string" ? comparison.scope : "See the host report; no unrestricted accuracy claim is implied." };
}
function download(text: string, filename: string, mediaType: string): void {
  downloadBlob(new Blob([text], { type: mediaType }), filename);
}
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a"); anchor.href = url; anchor.download = filename;
  anchor.click(); globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Compact human inspection surface. All status comes from a fresh host-side evaluation. */
export function PrecisionStudyView({ document, evidenceSources, evidenceVault }: PrecisionStudyViewProps) {
  const inspected = useMemo(() => inspect(document), [document]);
  const evidenceKey = useMemo(() => JSON.stringify([document, evidenceSources ?? []]), [document, evidenceSources]);
  const [evidenceState, setEvidenceState] = useState<{ key: string; status: "checking" | "verified" | "missing" | "embedded"; reason?: string }>({ key: "", status: "checking" });
  useEffect(() => {
    let cancelled = false;
    const verify = async () => {
      try {
        if (evidenceSources !== undefined && !Array.isArray(evidenceSources)) throw new Error("Malformed source evidence references");
        if (!cancelled) setEvidenceState({ key: evidenceKey, status: "checking" });
        const storage = evidenceVault ?? defaultPrecisionEvidenceVault();
        const result = await authenticatePrecisionEvidence(document, evidenceSources, storage);
        if (!cancelled) setEvidenceState({ key: evidenceKey, status: result.sourceBytesAuthenticated ? "verified" : "embedded" });
      } catch (error) { if (!cancelled) setEvidenceState({ key: evidenceKey, status: "missing", reason: message(error) }); }
    };
    void verify(); return () => { cancelled = true; };
  }, [document, evidenceKey, evidenceSources, evidenceVault]);
  if (!inspected.study || !inspected.report) return <div className="precision-study" role="status"><strong>Precision study unavailable</strong><p>{inspected.error}</p></div>;
  const { study, report } = inspected;
  const noReferences = evidenceSources === undefined || (Array.isArray(evidenceSources) && evidenceSources.length === 0);
  const evidenceStatus = noReferences ? "embedded" : evidenceState.key === evidenceKey ? evidenceState.status : "checking";
  const withheldPass = report.status === "pass_for_scope" && (evidenceStatus === "checking" || evidenceStatus === "missing");
  return <section className="precision-study" aria-label="Precision study">
    <header><strong>{study.policy.intendedUse}</strong><span className={`precision-study__status is-${withheldPass ? "unverified" : report.status}`}>{withheldPass ? evidenceStatus === "checking" ? "Source evidence verification pending" : "Source evidence missing or corrupt — pass withheld" : label(report)}</span></header>
    <p>Acceptance tolerance: {mm(report.toleranceM)}. Fit residuals and visual realism are not accuracy certification.</p>
    <p className="precision-study__evidence" role="status">{evidenceStatus === "embedded" ? "Embedded geometry only — no matching original source bytes authenticate these positions." : evidenceStatus === "verified" ? "Attached source bytes and normalized geometry correspondence verified; this does not certify physical accuracy." : evidenceStatus === "checking" ? "Checking retained source evidence…" : `Source evidence unavailable: ${evidenceState.reason ?? "missing or corrupt bytes"}`}</p>
    <PrecisionGeometryPreview study={study} report={report} />
    <dl className="precision-study__facts">
      <div><dt>Calibration controls</dt><dd>{study.controls.length}</dd></div>
      <div><dt>Independent point checks</dt><dd>{study.checks.length}</dd></div>
      <div><dt>Dimension checks</dt><dd>{study.dimensions.length}</dd></div>
      <div><dt>Source attachments</dt><dd>{Array.isArray(evidenceSources) ? evidenceSources.length : 0}</dd></div>
    </dl>
    {report.reasons.length > 0 && <ul>{report.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    {report.checks.length > 0 && <div className="precision-study__table"><table><thead><tr><th>Check</th><th>Error</th><th>Error + uncertainty</th><th>Result</th></tr></thead><tbody>
      {report.checks.map((check) => <tr key={`${check.kind}:${check.id}`}><td>{check.id}</td><td>{mm(check.errorM)}</td><td>{mm(check.conservativeErrorM)}</td><td>{check.status}</td></tr>)}
    </tbody></table></div>}
    <details><summary>Scope and limitations</summary><p>Verified regions: {report.verifiedRegions.join(", ") || "none"}. Unchecked surfaces and hidden geometry are not verified.</p><ul>{report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details>
  </section>;
}

export function PrecisionStudyInspector({ document, evidenceSources, workspaceRevision, onUpdate, disabled = false, onCreateCad, onCompareCad, evidenceVault }: PrecisionStudyInspectorProps) {
  const serialized = useMemo(() => JSON.stringify(document, null, 2) ?? "{}", [document]);
  const [draft, setDraft] = useState(serialized);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<MeasurementImportFormat>("obj");
  const [units, setUnits] = useState<PrecisionUnit>("unknown");
  const [basisConfirmed, setBasisConfirmed] = useState(false);
  const [fitToleranceM, setFitToleranceM] = useState("0.001");
  const [thicknessM, setThicknessM] = useState("");
  const [thicknessProvenance, setThicknessProvenance] = useState("");
  const [proposal, setProposal] = useState<CadFitProposal>();
  const [capture, setCapture] = useState<Awaited<ReturnType<typeof inspectCaptureBundle>>>();
  const [captureRef, setCaptureRef] = useState<PrecisionEvidenceRef>();
  const [targetComponentId, setTargetComponentId] = useState("");
  const [comparison, setComparison] = useState<{ documentKey: string; targetId: string; result: unknown }>();
  const interactionKey = `${workspaceRevision ?? "unknown"}:${serialized}`;
  const latestInteractionKey = useRef(interactionKey);
  latestInteractionKey.current = interactionKey;
  const sourceMutationKey = `${interactionKey}:${JSON.stringify(evidenceSources ?? [])}`;
  const latestSourceMutationKey = useRef<string | null>(sourceMutationKey);
  latestSourceMutationKey.current = sourceMutationKey;
  useEffect(() => {
    latestSourceMutationKey.current = sourceMutationKey; latestInteractionKey.current = interactionKey;
    return () => { latestSourceMutationKey.current = null; latestInteractionKey.current = "unmounted"; };
  }, [interactionKey, sourceMutationKey]);
  useEffect(() => { setDraft(serialized); setProposal(undefined); setComparison(undefined); }, [serialized, workspaceRevision]);
  useEffect(() => { setCapture(undefined); setCaptureRef(undefined); }, [evidenceSources]);
  const current = useMemo(() => inspect(document), [document]);
  const parsedDraft = useMemo(() => {
    if (draft.length > 16 * 1024 * 1024) return { error: "Study JSON exceeds 16 MiB" };
    try { return inspect(JSON.parse(draft)); } catch (error) { return { error: message(error) }; }
  }, [draft]);
  const blocked = disabled || busy;
  const freshComparison = comparison?.documentKey === interactionKey && comparison.targetId === targetComponentId.trim() ? comparison : undefined;
  const compare = async () => {
    if (!onCompareCad || !targetComponentId.trim()) return;
    const requestKey = interactionKey; const targetId = targetComponentId.trim();
    setBusy(true); setComparison(undefined); setStatus("Comparing the current CAD geometry with the measurement study…");
    try {
      const result = await onCompareCad(targetId);
      const resultRevision = result && typeof result === "object" ? (result as Record<string, unknown>).workspace_revision : undefined;
      if (latestInteractionKey.current !== requestKey || (workspaceRevision !== undefined && resultRevision !== undefined && resultRevision !== workspaceRevision)) {
        setStatus("Comparison discarded because the workspace changed. Compare again against the current geometry."); return;
      }
      setComparison({ documentKey: requestKey, targetId, result });
      setStatus("CAD comparison complete. It applies only to this workspace revision and the reported sampled scope.");
    } catch (error) { setStatus(message(error)); } finally { setBusy(false); }
  };
  const sources = useMemo(() => {
    try { return { refs: (Array.isArray(evidenceSources) ? evidenceSources : []).map(parsePrecisionEvidenceRef), error: undefined }; }
    catch (error) { return { refs: [] as PrecisionEvidenceRef[], error: message(error) }; }
  }, [evidenceSources]);
  const run = (operation: () => void) => { try { operation(); } catch (error) { setStatus(message(error)); } };
  const vault = () => evidenceVault ?? defaultPrecisionEvidenceVault();
  const importSource = async (file: File) => {
    const mutationKey = sourceMutationKey;
    if (!basisConfirmed) throw new Error("Establish the source coordinate basis before admission");
    if (file.size > MEASUREMENT_IMPORT_LIMITS.maximumBytes) throw new Error("Measurement geometry exceeds 16 MiB; use an explicitly prepared region. No automatic downsampling is performed.");
    if (sources.error) throw new Error(sources.error);
    const geometry = importMeasurementGeometry({ data: await readPortableBlobRange(file, 0, file.size), format,
      geometryId: "imported_measurement", coordinateBasis: "RUB", units,
      provenance: "User-selected local measurement source; units and RUB basis declared at admission" });
    const ref: PrecisionEvidenceRef = { digest: geometry.source.sha256 as `sha256:${string}`, byteLength: file.size, kind: "measurement-source", mediaType: format === "obj" ? "model/obj" : format === "ply" ? "application/ply" : "text/csv" };
    if (latestSourceMutationKey.current !== mutationKey) throw new Error("Workspace changed while reading the source; import was discarded. Retry against the current study.");
    const storage = vault(); const retained = await storage.put(ref, file);
    try {
      if (latestSourceMutationKey.current !== mutationKey) throw new Error("Workspace changed while retaining the source; import was discarded. Retry against the current study.");
      const nextSources = [...sources.refs.filter((source) => source.digest !== ref.digest), ref];
      if (onUpdate(createPrecisionStudy(geometry), nextSources) === false) throw new Error("The workspace rejected the import; its previous study is unchanged.");
    } catch (error) { if (retained.inserted) await storage.delete(ref.digest); throw error; }
    setProposal(undefined);
  };
  const propose = (kind: "shaft" | "plate") => run(() => {
    if (!current.study) throw new Error("A valid study is required");
    const geometry = calibratedGeometry(current.study);
    const options = { toleranceM: Number(fitToleranceM), partId: `fitted_${kind}` };
    const result = kind === "shaft" ? proposeMeasurementShaftCad(geometry, options) : proposeMeasurementPlateCad(geometry, { ...options, thicknessM: Number(thicknessM), thicknessProvenance });
    setProposal(result); setStatus("Editable CAD proposal prepared. Fit quality is not independent verification; review the assumptions before creating it.");
  });
  const exportGeometry = async (exportFormat: "obj" | "ply") => {
    const exportKey = sourceMutationKey; setBusy(true);
    try {
      if (!current.study) throw new Error("A valid study is required");
      await authenticatePrecisionEvidence(current.study, evidenceSources, vault());
      if (latestSourceMutationKey.current !== exportKey) throw new Error("Workspace changed while authenticating the export; retry against the current study.");
      const geometry = calibratedGeometry(current.study);
      const result = exportMeasurementGeometry(geometry, exportFormat);
      download(result.text, `measurement.${exportFormat}`, result.mediaType);
      setStatus("Metric measurement geometry exported. Export the report + study JSON as its units, provenance and validation sidecar.");
    } catch (error) { setStatus(message(error)); } finally { setBusy(false); }
  };
  return <section className="precision-study precision-study--inspector" aria-label="Precision study inspector">
    <PrecisionStudyView document={document} evidenceSources={evidenceSources} evidenceVault={evidenceVault} />
    <details>
      <summary>Import measurement geometry</summary>
      <p>OBJ, ordinary PLY and typed x,y,z CSV only. Gaussian PLY is rejected. V1 keeps all points up to 25,000; larger sources are not silently reduced.</p>
      <label>Source format<select value={format} disabled={blocked} onChange={(event) => setFormat(event.target.value as MeasurementImportFormat)}><option value="obj">OBJ mesh</option><option value="ply">PLY points / mesh</option><option value="xyz-csv">XYZ CSV</option></select></label>
      <label>Declared source units<select value={units} disabled={blocked} onChange={(event) => setUnits(event.target.value as PrecisionUnit)}><option value="unknown">Unknown — calibration required</option><option value="metre">Metres</option><option value="millimetre">Millimetres</option><option value="centimetre">Centimetres</option><option value="inch">Inches</option></select></label>
      <label className="precision-study__checkbox"><input type="checkbox" checked={basisConfirmed} disabled={blocked} onChange={(event) => setBasisConfirmed(event.target.checked)} />I have established the source basis as RUB (+X right, +Y up, +Z back). Units alone do not establish axes.</label>
      <input type="file" aria-label="Import measurement source" accept={format === "xyz-csv" ? ".csv" : `.${format}`} disabled={blocked || !basisConfirmed} onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        setBusy(true); setStatus("Importing measurement source…");
        try { await importSource(file); setStatus("Measurement source imported and original bytes retained. Re-establish calibration and independent checks before acceptance."); }
        catch (error) { setStatus(message(error)); } finally { setBusy(false); }
      }} />
    </details>
    <details>
      <summary>Retained source evidence</summary>
      <p>Source hashes prove byte integrity, not dimensional accuracy. Native capture bundles have unknown scale and axes until explicitly established.</p>
      {sources.error && <p role="alert">{sources.error}</p>}
      {sources.refs.map((ref) => <div key={ref.digest} className="precision-study__source">
        <code>{ref.kind} · {ref.digest.slice(0, 22)}… · {(ref.byteLength / 1_024).toFixed(1)} KiB</code>
        <button type="button" disabled={blocked} onClick={async () => {
          setBusy(true); try { downloadBlob(await vault().open(ref), `${ref.kind}-${ref.digest.slice(7, 19)}${ref.kind === "capture-bundle" ? ".zip" : ref.mediaType === "model/obj" ? ".obj" : ref.mediaType === "application/ply" ? ".ply" : ".csv"}`); setStatus("Verified original evidence downloaded."); }
          catch (error) { setStatus(message(error)); } finally { setBusy(false); }
        }}>Download original source</button>
        {ref.kind === "capture-bundle" && <button type="button" disabled={blocked} onClick={async () => {
          setBusy(true); try { const verified = await inspectCaptureBundle(await vault().open(ref), { expectedSha256: ref.digest }); setCapture(verified); setCaptureRef(ref); setStatus("Capture manifest and every native file verified. No file was extracted or external reference loaded."); }
          catch (error) { setStatus(message(error)); } finally { setBusy(false); }
        }}>Inspect retained native files</button>}
      </div>)}
      {capture && <div>
        <p>Backend: {capture.manifest.backend.id}. Scale: unknown. Axes: unknown. Downloads use safe basenames; retain manifest-relative paths when assembling OBJ materials externally.</p>
        <button type="button" disabled={blocked} onClick={() => download(JSON.stringify(capture.manifest, null, 2), "capture-manifest.json", "application/json")}>Download capture manifest</button>
        {capture.manifest.files.map((file) => <button type="button" disabled={blocked} key={file.path} onClick={() => downloadBlob(capture.files.get(file.path)!, file.path.split("/").at(-1)!)}>Download {file.path}</button>)}
        <button type="button" disabled={blocked || !basisConfirmed || !captureRef} onClick={async () => {
          const mutationKey = sourceMutationKey;
          setBusy(true); try {
            if (capture.mesh.size > MEASUREMENT_IMPORT_LIMITS.maximumBytes) throw new Error("Native mesh exceeds the 16 MiB inspectable geometry limit. Export native files and explicitly prepare a bounded region; no silent downsampling is performed.");
            const geometry = importMeasurementGeometry({ data: await readPortableBlobRange(capture.mesh, 0, capture.mesh.size), format: "obj", geometryId: "retained_capture_mesh", coordinateBasis: "RUB", units,
              provenance: `Retained native mesh from ${capture.manifest.backend.id}; operator explicitly declared basis and units` });
            if (latestSourceMutationKey.current !== mutationKey) throw new Error("Workspace changed during mesh admission; the outdated import was discarded.");
            if (onUpdate(createPrecisionStudy(geometry), sources.refs) === false) throw new Error("The workspace rejected measurement admission; retained source evidence is unchanged.");
            setProposal(undefined); setStatus("Native mesh admitted as unverified measurement geometry. Add calibration and independent checks; no accuracy pass was granted.");
          } catch (error) { setStatus(message(error)); } finally { setBusy(false); }
        }}>Admit retained mesh with declared units and RUB basis</button>
      </div>}
    </details>
    <details>
      <summary>Edit calibration and independent evidence</summary>
      <p>Controls establish alignment. Checks must be independent of those controls. Every observation needs provenance, region and uncertainty; unknown uncertainty cannot yield a verified pass.</p>
      <label>Study document (geometry, controls, checks, dimensions and acceptance policy)<textarea aria-label="Precision study document JSON" rows={14} value={draft} disabled={blocked} spellCheck={false} onChange={(event) => setDraft(event.target.value)} /></label>
      <p role="status">{parsedDraft.error ?? (parsedDraft.report ? `Draft: ${label(parsedDraft.report)}` : "")}</p>
      <button type="button" disabled={blocked || !parsedDraft.study || draft === serialized} onClick={() => run(() => { if (parsedDraft.study) { if (onUpdate(parsedDraft.study) === false) throw new Error("The workspace rejected the study update; its previous state is unchanged."); setProposal(undefined); setStatus("Study updated; validation was recomputed from the new document."); } })}>Apply study changes</button>
      <button type="button" disabled={blocked || draft === serialized} onClick={() => setDraft(serialized)}>Discard draft</button>
      <label>Import precision audit bundle (.json)<input type="file" aria-label="Import precision audit bundle" accept=".json,application/json" disabled={blocked} onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        const mutationKey = sourceMutationKey;
        setBusy(true); try {
          if (file.size > 32 * 1024 * 1024) throw new Error("Precision audit bundle exceeds 32 MiB");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(await readPortableBlobRange(file, 0, file.size));
          const bundle = importPrecisionEvidenceBundle(text);
          if (latestSourceMutationKey.current !== mutationKey) throw new Error("Workspace changed while reading the audit bundle; the outdated import was discarded.");
          if (onUpdate(bundle.study, []) === false) throw new Error("The workspace rejected the precision audit import");
          setProposal(undefined); setComparison(undefined);
          setStatus("Audit bundle imported with validation recomputed. Embedded status was not trusted; original capture/source attachments are not part of this JSON bundle.");
        } catch (error) { setStatus(message(error)); } finally { setBusy(false); }
      }} /></label>
    </details>
    <details>
      <summary>Fit editable CAD proposal</summary>
      <p>Fit an observed cylinder or planar region. A fitted solid is a proposal, not proof of real-world dimensions or hidden geometry. First select/import the intended region; mixed objects should not be fitted together.</p>
      <label>Fit tolerance (metres)<input type="number" min="0.000001" step="0.0001" value={fitToleranceM} disabled={blocked} onChange={(event) => { setFitToleranceM(event.target.value); setProposal(undefined); }} /></label>
      <button type="button" disabled={blocked || !current.study} onClick={() => propose("shaft")}>Propose fitted shaft</button>
      <label>Measured plate thickness (metres)<input type="number" min="0.000001" step="0.001" value={thicknessM} disabled={blocked} onChange={(event) => { setThicknessM(event.target.value); setProposal(undefined); }} /></label>
      <label>Thickness measurement provenance<input type="text" value={thicknessProvenance} disabled={blocked} placeholder="Instrument, observation and measurement reference" onChange={(event) => { setThicknessProvenance(event.target.value); setProposal(undefined); }} /></label>
      <button type="button" disabled={blocked || !current.study || !thicknessProvenance.trim() || !(Number(thicknessM) > 0)} onClick={() => propose("plate")}>Propose fitted plate</button>
      {proposal && <div className="precision-study__proposal">
        <strong>Unvalidated {proposal.fit.kind} CAD proposal</strong>
        <p>Inlier fit RMS: {mm(proposal.fit.evidence.inlierRmsM)}. {proposal.fit.evidence.outlierIndices.length} outliers retained in evidence. This is not independent accuracy.</p>
        <ul>{proposal.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>
        <button type="button" disabled={blocked} onClick={() => download(JSON.stringify(proposal, null, 2), "fitted-cad-proposal.json", "application/json")}>Export editable proposal JSON</button>
        <button type="button" disabled={blocked || !onCreateCad} onClick={async () => {
          if (!onCreateCad) return; setBusy(true);
          try { await onCreateCad(proposal.definition); setStatus("CAD proposal submitted through normal authoring. Its real-world accuracy remains unverified."); }
          catch (error) { setStatus(message(error)); } finally { setBusy(false); }
        }}>Create editable CAD proposal</button>
      </div>}
    </details>
    <details>
      <summary>Compare current CAD against this study</summary>
      <p>Uses the host's current CAD geometry and measurement calibration. A small fit residual alone is not independent acceptance. Changing either model or workspace revision invalidates this result.</p>
      <label>Target CAD component ID<input type="text" aria-label="Target CAD component ID" placeholder="CMP_…" value={targetComponentId} disabled={blocked} onChange={(event) => { setTargetComponentId(event.target.value); setComparison(undefined); }} /></label>
      <button type="button" disabled={blocked || !current.study || !onCompareCad || !targetComponentId.trim()} onClick={() => void compare()}>Compare current CAD</button>
      {freshComparison && <div className="precision-study__comparison">
        <strong>Current-revision CAD comparison</strong>
        <p>Target: {freshComparison.targetId}. Workspace revision: {workspaceRevision ?? "not supplied"}. See result scope and uncertainty before relying on it.</p>
        <dl className="precision-study__facts"><div><dt>Result</dt><dd>{comparisonOverview(freshComparison.result).status}</dd></div><div><dt>Conservative maximum deviation</dt><dd>{mm(comparisonOverview(freshComparison.result).conservativeMaximumM)}</dd></div></dl>
        <p>Scope: {comparisonOverview(freshComparison.result).scope}</p>
        <details><summary>Full comparison evidence</summary><pre aria-label="CAD comparison result">{JSON.stringify(freshComparison.result, null, 2)}</pre></details>
        <button type="button" disabled={blocked} onClick={() => run(() => download(JSON.stringify(freshComparison.result, null, 2), "cad-measurement-comparison.json", "application/json"))}>Export CAD comparison JSON</button>
      </div>}
    </details>
    <div className="precision-study__actions">
      <button type="button" disabled={blocked || !current.study} onClick={async () => {
        const exportKey = sourceMutationKey; setBusy(true);
        try {
          if (!current.study || !current.report) throw new Error("A valid study is required");
          await authenticatePrecisionEvidence(current.study, evidenceSources, vault());
          if (latestSourceMutationKey.current !== exportKey) throw new Error("Workspace changed while authenticating the report; retry against the current study.");
          download(JSON.stringify(exportPrecisionEvidenceBundle(current.study), null, 2), "precision-study-report.json", "application/json");
          setStatus("Report and full study geometry exported. Original source attachment bytes require portable project export.");
        } catch (error) { setStatus(message(error)); } finally { setBusy(false); }
      }}>Export report + study JSON</button>
      <button type="button" disabled={blocked || !current.study} onClick={() => void exportGeometry("ply")}>Export metric PLY</button>
      <button type="button" disabled={blocked || !current.study} onClick={() => void exportGeometry("obj")}>Export metric OBJ</button>
    </div>
    {status && <p role="status" className="precision-study__message">{status}</p>}
  </section>;
}
