import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createExplicitHostFeedMapping,
  deriveHostFeedMappingPresets,
  discoverHostFeedValuePaths,
  normalizeHostFeedUrl,
  parseLocalInlineSource,
  type HostFeedFetchResponse,
  type HostFeedFormat,
  type HostFeedMappingPreset,
  type HostFeedTargetType,
  type HostFeedValueKind,
  type ParsedLocalInlineSource,
  type ResourceBindingDiagnostic,
  type ResourceRefreshPolicy,
  type WorkspaceHostFeedPreviewRequest,
  type WorkspaceHostFeedSaveRequest,
} from "../../../workspace/data";
import type { LocalInlineSourceFormat } from "../../../workspace/data/localInlineSource";
import {
  hostFeedPreviewConfigurationKey,
  planWorkspaceSourceCreateTargets,
  type WorkspaceSourceCreateTargetType,
  type WorkspaceSourceWizardKind,
  type WorkspaceSourceWizardStep,
} from "./workspaceSourceWizard";
import "./WorkspaceSourcePanel.css";

const EXAMPLE_CHART_JSON = `{
  "labels": ["09:30", "10:30", "11:30"],
  "series": [{ "id": "price", "label": "Price", "values": [187.4, 188.1, 187.8] }]
}`;

export type WorkspaceSourceItem = Readonly<{
  id: string;
  label: string;
  connectorType: string;
  connectorVersion?: string;
  status?: "ready" | "refreshing" | "stale" | "error";
  retrievedAt?: string;
  citation?: string;
  provenanceLabel?: string;
  bindingCount?: number;
  diagnostics?: readonly ResourceBindingDiagnostic[];
  editableJson?: string;
  reapplyable?: boolean;
  refreshable?: boolean;
  automationPaused?: boolean;
  lastError?: string;
  hostFeedConfig?: Readonly<{ url: string; format: HostFeedFormat; policy: ResourceRefreshPolicy }>;
  bindings?: readonly Readonly<{
    id: string;
    componentId: string;
    componentLabel: string;
    targetProp: string;
    sourcePath: string;
  }>[];
}>;

export type WorkspaceSourceBindingTarget = Readonly<{
  id: string;
  label: string;
  typeId: string;
  writableProps: readonly string[];
}>;

export type WorkspaceInlineSourceSaveRequest = Readonly<{
  resourceId?: string;
  label: string;
  format: LocalInlineSourceFormat;
  text: string;
  targetComponentId?: string;
  targetProp?: string;
  sourcePath?: string;
}>;

export type WorkspaceSourceNewTargetDestination = Readonly<{
  mode: "create";
  componentType: WorkspaceSourceCreateTargetType;
  componentLabel: string;
  mapping: HostFeedMappingPreset;
}>;

/** Atomic host boundary: component + resource + bindings must be one command. */
export type WorkspaceSourceAtomicCreateRequest =
  | Readonly<{ kind: "local"; source: WorkspaceInlineSourceSaveRequest; destination: WorkspaceSourceNewTargetDestination }>
  | Readonly<{ kind: "https"; source: WorkspaceHostFeedSaveRequest; destination: WorkspaceSourceNewTargetDestination }>;

export type WorkspaceSourcePanelProps = Readonly<{
  sources: readonly WorkspaceSourceItem[];
  bindingTargets?: readonly WorkspaceSourceBindingTarget[];
  diagnostics?: readonly ResourceBindingDiagnostic[];
  onSaveInlineSource?: (request: WorkspaceInlineSourceSaveRequest) => boolean;
  onRefresh?: (sourceId: string) => void;
  onPreviewHostFeed?: (request: WorkspaceHostFeedPreviewRequest) => Promise<HostFeedFetchResponse>;
  onSaveHostFeed?: (request: WorkspaceHostFeedSaveRequest) => boolean | Promise<boolean>;
  onCommitSourceWithNewTarget?: (request: WorkspaceSourceAtomicCreateRequest) => boolean | Promise<boolean>;
  /** Change for every project/workspace generation to retire pending responses. */
  scopeKey?: string | number;
  onUnbindSource?: (bindingId: string) => void;
  onDeleteSource?: (sourceId: string) => void;
}>;

type DestinationMode = "unbound" | "existing" | "create";
const HOST_FEED_TARGET_TYPES = new Set<HostFeedTargetType>(["data-panel", "chart", "table", "text", "document"]);
const EXPLICIT_MAPPING_ID = "__explicit__";
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86_400;

function expectedKinds(type: HostFeedTargetType, prop: string): readonly HostFeedValueKind[] {
  if (type === "data-panel" && prop === "data") return ["array", "object", "string", "number", "boolean", "null"];
  if ((type === "chart" && ["labels", "series"].includes(prop)) || (type === "table" && ["columns", "rows"].includes(prop))) return ["array"];
  if (type === "table" && prop === "striped") return ["boolean"];
  return ["string"];
}

function sourceOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return "approved host"; }
}

function displayRetrievedAt(value?: string): string {
  if (!value) return "No snapshot";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Invalid snapshot time" : date.toLocaleString();
}

const stepNumber: Record<WorkspaceSourceWizardStep, number> = { choose: 0, configure: 0, preview: 1, destination: 2, done: 3 };

export function WorkspaceSourcePanel({
  sources,
  bindingTargets = [],
  diagnostics = [],
  onSaveInlineSource,
  onRefresh,
  onPreviewHostFeed,
  onSaveHostFeed,
  onCommitSourceWithNewTarget,
  scopeKey = "default",
  onUnbindSource,
  onDeleteSource,
}: WorkspaceSourcePanelProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<WorkspaceSourceWizardKind>();
  const [step, setStep] = useState<WorkspaceSourceWizardStep>("choose");
  const [destination, setDestination] = useState<DestinationMode>("unbound");
  const [createType, setCreateType] = useState<WorkspaceSourceCreateTargetType>("data-panel");
  const [createLabel, setCreateLabel] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();

  const [editingId, setEditingId] = useState<string>();
  const [label, setLabel] = useState("Market snapshot");
  const [format, setFormat] = useState<LocalInlineSourceFormat>("json");
  const [text, setText] = useState(EXAMPLE_CHART_JSON);
  const [localPreview, setLocalPreview] = useState<ParsedLocalInlineSource>();
  const [localError, setLocalError] = useState<string>();
  const [targetId, setTargetId] = useState("");
  const [targetProp, setTargetProp] = useState("");
  const [sourcePath, setSourcePath] = useState("$");

  const [editingFeedId, setEditingFeedId] = useState<string>();
  const [feedLabel, setFeedLabel] = useState("External feed");
  const [feedUrl, setFeedUrl] = useState("");
  const [feedFormat, setFeedFormat] = useState<HostFeedFormat>("auto");
  const [feedPolicyMode, setFeedPolicyMode] = useState<ResourceRefreshPolicy["mode"]>("manual");
  const [feedIntervalSeconds, setFeedIntervalSeconds] = useState(60);
  const [feedPreview, setFeedPreview] = useState<HostFeedFetchResponse>();
  const [feedPreviewKey, setFeedPreviewKey] = useState<string>();
  const [feedPending, setFeedPending] = useState<"preview" | "save">();
  const [feedError, setFeedError] = useState<string>();
  const [feedTargetId, setFeedTargetId] = useState("");
  const [feedMappingId, setFeedMappingId] = useState("");
  const [feedTargetProp, setFeedTargetProp] = useState("");
  const [feedSourcePath, setFeedSourcePath] = useState("$");

  const aliveRef = useRef(true);
  const openRef = useRef(false);
  const kindRef = useRef<WorkspaceSourceWizardKind | undefined>(undefined);
  const scopeRef = useRef(scopeKey);
  const generationRef = useRef(0);

  useEffect(() => () => { aliveRef.current = false; generationRef.current += 1; }, []);
  useEffect(() => {
    if (scopeRef.current === scopeKey) return;
    scopeRef.current = scopeKey;
    generationRef.current += 1;
    openRef.current = false;
    kindRef.current = undefined;
    setOpen(false);
    setKind(undefined);
    setStep("choose");
    setFeedPending(undefined);
    setFeedPreview(undefined);
    setFeedPreviewKey(undefined);
    setLocalPreview(undefined);
  }, [scopeKey]);

  const target = useMemo(() => bindingTargets.find((item) => item.id === targetId), [bindingTargets, targetId]);
  const feedTargets = useMemo(() => bindingTargets.filter((item) => HOST_FEED_TARGET_TYPES.has(item.typeId as HostFeedTargetType)), [bindingTargets]);
  const feedTarget = useMemo(() => feedTargets.find((item) => item.id === feedTargetId), [feedTargets, feedTargetId]);
  const feedTargetType = feedTarget?.typeId as HostFeedTargetType | undefined;
  const previewData = kind === "local" ? localPreview?.data : feedPreview?.snapshot.data;
  const createPlans = useMemo(() => previewData === undefined ? [] : planWorkspaceSourceCreateTargets(previewData), [previewData]);
  const feedPaths = useMemo(() => feedPreview ? discoverHostFeedValuePaths(feedPreview.snapshot.data) : [], [feedPreview]);
  const feedPresets = useMemo(() => feedPreview && feedTargetType
    ? deriveHostFeedMappingPresets(feedPreview.snapshot.data).filter((item) => item.targetType === feedTargetType)
    : [], [feedPreview, feedTargetType]);
  const mappingId = feedMappingId && (feedMappingId === EXPLICIT_MAPPING_ID || feedPresets.some((item) => item.id === feedMappingId))
    ? feedMappingId : (feedPresets[0]?.id ?? EXPLICIT_MAPPING_ID);
  const effectiveProp = feedTargetProp && feedTarget?.writableProps.includes(feedTargetProp)
    ? feedTargetProp
    : feedTargetType === "data-panel" && feedTarget?.writableProps.includes("data")
      ? "data" : (feedTarget?.writableProps[0] ?? "");
  const matchingPaths = effectiveProp && feedTargetType
    ? feedPaths.filter((item) => expectedKinds(feedTargetType, effectiveProp).includes(item.kind)) : feedPaths;
  const effectivePath = matchingPaths.some((item) => item.path === feedSourcePath) ? feedSourcePath : (matchingPaths[0]?.path ?? "$");

  function resetDest(): void {
    setDestination("unbound"); setCreateType("data-panel"); setCreateLabel("");
    setTargetId(""); setTargetProp(""); setSourcePath("$");
    setFeedTargetId(""); setFeedMappingId(""); setFeedTargetProp(""); setFeedSourcePath("$");
  }
  function resetLocal(): void {
    setEditingId(undefined); setLabel("Market snapshot"); setFormat("json"); setText(EXAMPLE_CHART_JSON);
    setLocalPreview(undefined); setLocalError(undefined); setTargetId(""); setTargetProp(""); setSourcePath("$");
  }
  function resetFeed(): void {
    setEditingFeedId(undefined); setFeedLabel("External feed"); setFeedUrl(""); setFeedFormat("auto");
    setFeedPolicyMode("manual"); setFeedIntervalSeconds(60); setFeedPreview(undefined); setFeedPreviewKey(undefined);
    setFeedPending(undefined); setFeedError(undefined); setFeedTargetId(""); setFeedMappingId(""); setFeedTargetProp(""); setFeedSourcePath("$");
  }
  function close(): void {
    generationRef.current += 1; openRef.current = false; kindRef.current = undefined;
    setOpen(false); setKind(undefined); setStep("choose"); setFeedPending(undefined);
  }
  function start(): void {
    generationRef.current += 1; resetLocal(); resetFeed(); resetDest();
    openRef.current = true; kindRef.current = undefined; setOpen(true); setKind(undefined); setStep("choose");
  }
  function selectKind(next: WorkspaceSourceWizardKind): void {
    generationRef.current += 1; if (next === "local") resetFeed(); else resetLocal(); resetDest();
    kindRef.current = next; setKind(next); setStep("configure");
  }
  function edit(source: WorkspaceSourceItem): void {
    generationRef.current += 1; resetDest(); openRef.current = true; setOpen(true); setStep("configure");
    if (source.hostFeedConfig) {
      resetLocal(); resetFeed(); kindRef.current = "https"; setKind("https"); setEditingFeedId(source.id); setFeedLabel(source.label);
      setFeedUrl(source.hostFeedConfig.url); setFeedFormat(source.hostFeedConfig.format); setFeedPolicyMode(source.hostFeedConfig.policy.mode);
      setFeedIntervalSeconds(source.hostFeedConfig.policy.intervalMs ? Math.round(source.hostFeedConfig.policy.intervalMs / 1_000) : 60);
    } else if (source.editableJson !== undefined) {
      resetFeed(); resetLocal(); kindRef.current = "local"; setKind("local"); setEditingId(source.id); setLabel(source.label); setText(source.editableJson);
    }
  }
  function policy(): ResourceRefreshPolicy {
    if (feedPolicyMode !== "interval") return { mode: feedPolicyMode, offline: "keep_last_good" };
    if (!Number.isSafeInteger(feedIntervalSeconds) || feedIntervalSeconds < MIN_INTERVAL_SECONDS || feedIntervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error(`Refresh interval must be ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS} seconds`);
    }
    return { mode: "interval", intervalMs: feedIntervalSeconds * 1_000, offline: "keep_last_good" };
  }
  function invalidateFeed(): void {
    generationRef.current += 1; setFeedPending(undefined); setFeedPreview(undefined); setFeedPreviewKey(undefined); setFeedError(undefined); setFeedMappingId(""); setStep("configure");
  }
  function previewLocal(event: FormEvent): void {
    event.preventDefault(); setLocalError(undefined);
    try { setLocalPreview(parseLocalInlineSource(format, text)); setStep("preview"); }
    catch (error) { setLocalPreview(undefined); setLocalError(error instanceof Error ? error.message : "The local snapshot could not be parsed"); }
  }
  async function previewFeed(event: FormEvent): Promise<void> {
    event.preventDefault(); if (!onPreviewHostFeed || feedPending) return;
    let url: string; let refreshPolicy: ResourceRefreshPolicy;
    try { url = normalizeHostFeedUrl(feedUrl); refreshPolicy = policy(); }
    catch (error) { setFeedError(error instanceof Error ? error.message : "Invalid feed configuration"); return; }
    const generation = ++generationRef.current; const requestScope = scopeRef.current;
    const key = hostFeedPreviewConfigurationKey({ url, format: feedFormat, policy: refreshPolicy });
    setFeedPending("preview"); setFeedError(undefined);
    try {
      const result = await onPreviewHostFeed({ url, format: feedFormat, policy: refreshPolicy });
      if (!aliveRef.current || !openRef.current || kindRef.current !== "https" || requestScope !== scopeRef.current || generation !== generationRef.current) return;
      setFeedPreview(result); setFeedUrl(result.requestedUrl); setFeedPreviewKey(key); setFeedMappingId(""); setFeedSourcePath("$"); setStep("preview");
    } catch (error) {
      if (aliveRef.current && openRef.current && requestScope === scopeRef.current && generation === generationRef.current) {
        setFeedPreview(undefined); setFeedPreviewKey(undefined); setFeedError(error instanceof Error ? error.message : "The host could not preview this feed");
      }
    } finally { if (aliveRef.current && generation === generationRef.current) setFeedPending(undefined); }
  }
  function selectedFeedMapping(): HostFeedMappingPreset | undefined {
    if (!feedTarget || !feedTargetType) return undefined;
    const result = mappingId === EXPLICIT_MAPPING_ID
      ? effectiveProp && matchingPaths.some((item) => item.path === effectivePath)
        ? createExplicitHostFeedMapping({ targetType: feedTargetType, targetProp: effectiveProp, sourcePath: effectivePath }) : undefined
      : feedPresets.find((item) => item.id === mappingId);
    if (!result) throw new Error("Choose a compatible feed mapping for the selected component");
    if (result.bindings.some((binding) => !feedTarget.writableProps.includes(binding.targetProp))) throw new Error("The mapping targets a property that is not writable");
    return result;
  }
  async function save(): Promise<void> {
    if (!kind || previewData === undefined || feedPending) return;
    const generation = ++generationRef.current; const requestScope = scopeRef.current;
    setLocalError(undefined); setFeedError(undefined);
    try {
      let saved: boolean | undefined;
      if (kind === "local") {
        const cleanLabel = label.trim(); if (!cleanLabel) throw new Error("Give the local snapshot a label");
        if (destination === "existing" && !target) throw new Error("Choose an existing component");
        if (destination === "existing" && target?.typeId !== "chart" && !targetProp) throw new Error("Choose a writable target property");
        const source: WorkspaceInlineSourceSaveRequest = {
          ...(editingId ? { resourceId: editingId } : {}), label: cleanLabel, format, text,
          ...(destination === "existing" && target ? {
            targetComponentId: target.id,
            ...(target.typeId === "chart" ? { sourcePath: "$" } : { targetProp, sourcePath: sourcePath.trim() || "$" }),
          } : {}),
        };
        if (destination === "create") {
          const plan = createPlans.find((item) => item.typeId === createType);
          if (!onCommitSourceWithNewTarget || !plan?.available) throw new Error(plan?.unavailableReason ?? "Atomic create-and-bind is unavailable");
          saved = await onCommitSourceWithNewTarget({ kind: "local", source, destination: { mode: "create", componentType: createType, componentLabel: createLabel.trim() || `${cleanLabel} ${plan.label}`, mapping: plan.mapping } });
        } else saved = onSaveInlineSource?.(source);
      } else {
        if (!feedPreview || !onSaveHostFeed) throw new Error("Preview this feed before saving it");
        const cleanLabel = feedLabel.trim(); if (!cleanLabel) throw new Error("Give the feed a label");
        const refreshPolicy = policy(); const url = normalizeHostFeedUrl(feedUrl);
        if (hostFeedPreviewConfigurationKey({ url, format: feedFormat, policy: refreshPolicy }) !== feedPreviewKey) throw new Error("Preview this exact URL, format, and refresh policy again before saving");
        if (destination === "existing" && !feedTarget) throw new Error("Choose an existing component");
        const mapping = destination === "existing" ? selectedFeedMapping() : undefined;
        const source: WorkspaceHostFeedSaveRequest = {
          ...(editingFeedId ? { resourceId: editingFeedId } : {}), label: cleanLabel, requestedFormat: feedFormat,
          policy: refreshPolicy, feed: feedPreview,
          ...(destination === "existing" && feedTarget ? { targetComponentId: feedTarget.id } : {}), ...(mapping ? { mapping } : {}),
        };
        setFeedPending("save");
        if (destination === "create") {
          const plan = createPlans.find((item) => item.typeId === createType);
          if (!onCommitSourceWithNewTarget || !plan?.available) throw new Error(plan?.unavailableReason ?? "Atomic create-and-bind is unavailable");
          saved = await onCommitSourceWithNewTarget({ kind: "https", source, destination: { mode: "create", componentType: createType, componentLabel: createLabel.trim() || `${cleanLabel} ${plan.label}`, mapping: plan.mapping } });
        } else saved = await onSaveHostFeed(source);
      }
      if (aliveRef.current && openRef.current && requestScope === scopeRef.current && generation === generationRef.current && saved) setStep("done");
    } catch (error) {
      if (aliveRef.current && openRef.current && requestScope === scopeRef.current && generation === generationRef.current) {
        const message = error instanceof Error ? error.message : "The source could not be saved";
        if (kind === "https") setFeedError(message); else setLocalError(message);
      }
    } finally { if (aliveRef.current && generation === generationRef.current) setFeedPending(undefined); }
  }

  const canAdd = Boolean(onSaveInlineSource || (onPreviewHostFeed && onSaveHostFeed));
  return <aside className="workspace-side-panel workspace-sources" aria-label="Data sources">
    <header><strong>Sources</strong><span>{sources.length}</span></header>
    {sources.length === 0 ? <p className="workspace-empty-copy">Connect local JSON/CSV or a public HTTPS feed, preview it, then choose where it goes.</p> : <ul className="workspace-sources__list">
      {sources.map((source) => <li key={source.id} className="workspace-source">
        <div className="workspace-source__summary">
          <button type="button" className="workspace-source__main" onClick={() => edit(source)} disabled={source.editableJson === undefined && !source.hostFeedConfig}>
            <strong>{source.label}</strong><span>{source.connectorType}{source.connectorVersion ? `@${source.connectorVersion}` : ""} · {source.status ?? "ready"}</span>
            <small>{source.connectorType === "http.feed" ? "Last good" : "Retrieved"} {displayRetrievedAt(source.retrievedAt)} · {source.bindingCount ?? 0} binding{source.bindingCount === 1 ? "" : "s"}</small>
            {source.provenanceLabel && <small>Provenance: {source.provenanceLabel}</small>}{source.citation && <small>Citation: {source.citation}</small>}
            {source.automationPaused && <small className="workspace-source__diagnostic">Automation paused; Preview/update to enable.</small>}
            {source.lastError && <small className="workspace-source__diagnostic">Last refresh: {source.lastError}</small>}
            {source.diagnostics?.map((item) => <small className="workspace-source__diagnostic" key={`${source.id}-${item.bindingId}-${item.code}`}>{item.code}: {item.message}</small>)}
          </button>
          <div className="workspace-source__actions">
            {source.hostFeedConfig && <button type="button" onClick={() => edit(source)}>Manage</button>}
            <button type="button" onClick={() => onRefresh?.(source.id)} disabled={!onRefresh || !(source.refreshable ?? source.reapplyable) || source.status === "refreshing"}>{source.status === "refreshing" ? "Refreshing…" : source.connectorType === "http.feed" ? "Refresh" : "Reapply"}</button>
            {onDeleteSource && (pendingDeleteId === source.id ? <><button type="button" className="is-danger" onClick={() => { onDeleteSource(source.id); if (editingId === source.id || editingFeedId === source.id) close(); setPendingDeleteId(undefined); }}>Confirm delete</button><button type="button" onClick={() => setPendingDeleteId(undefined)}>Cancel</button></> : <button type="button" onClick={() => setPendingDeleteId(source.id)}>Delete</button>)}
          </div>
        </div>
        {source.bindings?.length ? <ul className="workspace-source__bindings" aria-label={`${source.label} bindings`}>{source.bindings.map((binding) => <li key={binding.id}><span>{binding.componentLabel}.{binding.targetProp} ← {binding.sourcePath}</span>{onUnbindSource && <button type="button" onClick={() => onUnbindSource(binding.id)}>Unbind</button>}</li>)}</ul> : null}
      </li>)}
    </ul>}
    {diagnostics.length > 0 && <section className="workspace-sources__diagnostics" aria-label="Binding diagnostics"><strong>Binding diagnostics</strong>{diagnostics.map((item) => <p key={`${item.bindingId}-${item.code}`}>{item.code}: {item.message}</p>)}</section>}
    {canAdd && !open && <button type="button" className="workspace-source-wizard__launch" onClick={start}>Add source</button>}
    {open && <section className="workspace-source-wizard" aria-label="Source setup">
      <div className="workspace-source-wizard__heading"><div><span>{editingId || editingFeedId ? "Manage source" : "Source setup"}</span><strong>{kind === "local" ? "Local JSON / CSV" : kind === "https" ? "Public HTTPS feed" : "Connect project data"}</strong></div><button type="button" onClick={close}>Close</button></div>
      {step !== "choose" && <ol className="workspace-source-wizard__steps" aria-label="Source setup progress">{(["configure", "preview", "destination"] as const).map((item, index) => { const state = stepNumber[step] === index ? "active" : stepNumber[step] > index ? "complete" : "pending"; return <li key={item} data-status={state} aria-current={state === "active" ? "step" : undefined}><span>{state === "complete" ? "✓" : index + 1}</span>{item === "configure" ? "Source" : item === "preview" ? "Preview" : "Destination"}</li>; })}</ol>}
      {step === "choose" && <div className="workspace-source-wizard__choose"><p>Choose a source. Nothing is added before the final step.</p>{onSaveInlineSource && <button type="button" onClick={() => selectKind("local")}><strong>Local JSON / CSV</strong><span>Paste bounded project data. No network request.</span></button>}{onPreviewHostFeed && onSaveHostFeed && <button type="button" onClick={() => selectKind("https")}><strong>Public HTTPS feed</strong><span>Host-brokered JSON, CSV, RSS, or Atom after approval.</span></button>}</div>}
      {step === "configure" && kind === "local" && <form className="workspace-source-form" onSubmit={previewLocal}>
        <label>Source label<input required value={label} onChange={(event) => setLabel(event.target.value)} /></label>
        <label>Format<select value={format} onChange={(event) => { setFormat(event.target.value as LocalInlineSourceFormat); setLocalPreview(undefined); }}><option value="json">JSON</option><option value="csv">CSV time series</option></select></label>
        <label>Snapshot data<textarea required rows={9} value={text} onChange={(event) => { setText(event.target.value); setLocalPreview(undefined); }} aria-describedby="workspace-source-format-hint" /></label>
        <p id="workspace-source-format-hint" className="workspace-source-form__hint">CSV uses the first column as labels and numeric columns as chart series. Data stays in this project; no URL is fetched.</p>
        {localError && <p className="workspace-source__diagnostic" role="alert">{localError}</p>}<button type="submit">Preview snapshot</button>
      </form>}
      {step === "configure" && kind === "https" && <form className="workspace-source-form" onSubmit={(event) => void previewFeed(event)}>
        <p className="workspace-source-form__hint">The host broker reads approved public HTTPS data. Existing SSRF and approval checks remain in force.</p>
        <label>Feed label<input required value={feedLabel} onChange={(event) => setFeedLabel(event.target.value)} /></label>
        <label>HTTPS feed URL<input required inputMode="url" placeholder="https://example.com/feed.json" value={feedUrl} onChange={(event) => { setFeedUrl(event.target.value); invalidateFeed(); }} /></label>
        <label>Feed format<select value={feedFormat} onChange={(event) => { setFeedFormat(event.target.value as HostFeedFormat); invalidateFeed(); }}><option value="auto">Detect automatically</option><option value="json">JSON</option><option value="csv">CSV</option><option value="rss">RSS / Atom</option></select></label>
        <label>Refresh policy<select value={feedPolicyMode} onChange={(event) => { setFeedPolicyMode(event.target.value as ResourceRefreshPolicy["mode"]); invalidateFeed(); }}><option value="manual">Manual</option><option value="interval">Interval</option><option value="on_open">When project opens</option></select></label>
        {feedPolicyMode === "interval" && <label>Refresh interval (seconds)<input type="number" min={MIN_INTERVAL_SECONDS} max={MAX_INTERVAL_SECONDS} step={1} value={feedIntervalSeconds} onChange={(event) => { setFeedIntervalSeconds(Number(event.target.value)); invalidateFeed(); }} /></label>}
        {feedError && <p className="workspace-source__diagnostic" role="alert">{feedError}</p>}<button type="submit" disabled={feedPending === "preview"}>{feedPending === "preview" ? "Previewing…" : "Preview feed"}</button>
      </form>}
      {step === "preview" && previewData !== undefined && <div className="workspace-source-wizard__preview-step"><section className="workspace-feed-preview" aria-label={kind === "https" ? "Feed preview" : "Snapshot preview"}>
        {kind === "https" && feedPreview ? <><div className="workspace-feed-preview__status"><strong>{feedPreview.format.toUpperCase()} from {sourceOrigin(feedPreview.finalUrl)}</strong><span data-freshness={feedPreview.snapshot.stale ? "stale" : "fresh"}>{feedPreview.snapshot.stale ? "Stale snapshot" : "Fresh snapshot"}</span></div><small>Retrieved {displayRetrievedAt(feedPreview.retrievedAt)} · {feedPreview.contentType}</small>{feedPreview.snapshot.provenance[0]?.publisher && <small>Publisher: {feedPreview.snapshot.provenance[0].publisher}</small>}{feedPreview.snapshot.provenance[0]?.citation && <small>Citation: {feedPreview.snapshot.provenance[0].citation}</small>}</> : <><div className="workspace-feed-preview__status"><strong>{format.toUpperCase()} project snapshot</strong><span data-freshness="local">Local</span></div><small>No network request · stored with the project · {localPreview?.kind === "chart_timeseries" ? "normalized chart series" : "structured JSON"}</small></>}
        <pre>{JSON.stringify(previewData, null, 2).slice(0, 4_000)}</pre></section><div className="workspace-source-wizard__navigation"><button type="button" onClick={() => setStep("configure")}>Back to edit</button><button type="button" onClick={() => { resetDest(); setStep("destination"); }}>Choose destination</button></div></div>}
      {step === "destination" && previewData !== undefined && <div className="workspace-source-wizard__destination">
        {kind === "local" && <p className="workspace-source-form__hint">This snapshot stays inside the project; no URL is fetched.</p>}
        <fieldset><legend>Where should this data go?</legend>
          <label className="workspace-source-wizard__destination-option"><input type="radio" name="source-destination" checked={destination === "unbound"} onChange={() => setDestination("unbound")} /><span><strong>Save as a source</strong><small>Keep it available without binding.</small></span></label>
          <label className="workspace-source-wizard__destination-option"><input type="radio" name="source-destination" checked={destination === "existing"} onChange={() => setDestination("existing")} /><span><strong>Use an existing component</strong><small>Bind to a compatible target in this project.</small></span></label>
          <label className="workspace-source-wizard__destination-option"><input type="radio" name="source-destination" checked={destination === "create"} disabled={!onCommitSourceWithNewTarget} onChange={() => setDestination("create")} /><span><strong>Create a new component</strong><small>{onCommitSourceWithNewTarget ? "Create, connect, and bind in one undoable transaction." : "Requires the host atomic create-and-bind callback."}</small></span></label>
        </fieldset>
        {destination === "existing" && kind === "local" && <div className="workspace-source-wizard__destination-config"><label>Existing component<select value={targetId} onChange={(event) => { setTargetId(event.target.value); setTargetProp(""); }}><option value="">Choose component</option>{bindingTargets.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.typeId}</option>)}</select></label>{target?.typeId === "chart" && <p className="workspace-source-form__hint">Normalized chart data automatically binds $.labels and $.series.</p>}{targetId && target?.typeId !== "chart" && <details className="workspace-source-wizard__advanced"><summary>Advanced property and JSON path</summary><label>Target property<select value={targetProp} onChange={(event) => setTargetProp(event.target.value)}><option value="">Choose property</option>{target?.writableProps.map((prop) => <option key={prop} value={prop}>{prop}</option>)}</select></label><label>Source path<input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="$.value" /></label></details>}</div>}
        {destination === "existing" && kind === "https" && <div className="workspace-source-wizard__destination-config"><label>Existing component<select value={feedTargetId} onChange={(event) => { setFeedTargetId(event.target.value); setFeedMappingId(""); setFeedTargetProp(""); setFeedSourcePath("$"); }}><option value="">Choose component</option>{feedTargets.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.typeId}</option>)}</select></label>{feedTarget && feedTargetType === "data-panel" && <p className="workspace-source-form__hint">The complete feed automatically binds to the Data Panel data property.</p>}{feedTarget && feedTargetType !== "data-panel" && <><label>Feed mapping<select value={mappingId} onChange={(event) => setFeedMappingId(event.target.value)}>{feedPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}<option value={EXPLICIT_MAPPING_ID}>Choose one property and source field</option></select></label>{mappingId === EXPLICIT_MAPPING_ID && <details className="workspace-source-wizard__advanced"><summary>Advanced property and JSON path</summary><label>Target property<select value={effectiveProp} onChange={(event) => { setFeedTargetProp(event.target.value); setFeedSourcePath("$"); }}>{feedTarget.writableProps.map((prop) => <option key={prop} value={prop}>{prop}</option>)}</select></label><label>Source field<select value={effectivePath} onChange={(event) => setFeedSourcePath(event.target.value)}>{matchingPaths.map((item) => <option key={item.path} value={item.path}>{item.label} · {item.kind}</option>)}</select></label>{matchingPaths.length === 0 && <p className="workspace-source-form__hint">No compatible source field for this property.</p>}</details>}</>}</div>}
        {destination === "create" && <div className="workspace-source-wizard__create-targets"><label>New component label<input value={createLabel} onChange={(event) => setCreateLabel(event.target.value)} placeholder={`${kind === "local" ? label : feedLabel} view`} /></label><div role="radiogroup" aria-label="New component type">{createPlans.map((plan) => <label key={plan.typeId} data-unavailable={!plan.available || !onCommitSourceWithNewTarget || undefined}><input type="radio" name="new-source-target" value={plan.typeId} checked={createType === plan.typeId} disabled={!plan.available || !onCommitSourceWithNewTarget} onChange={() => setCreateType(plan.typeId)} /><span><strong>{plan.label}</strong><small>{plan.available ? plan.description : plan.unavailableReason}</small></span></label>)}</div></div>}
        {(localError || feedError) && <p className="workspace-source__diagnostic" role="alert">{localError ?? feedError}</p>}<div className="workspace-source-wizard__navigation"><button type="button" onClick={() => setStep("preview")}>Back to preview</button><button type="button" disabled={Boolean(feedPending)} onClick={() => void save()}>{feedPending === "save" ? "Saving…" : kind === "local" ? editingId ? "Update snapshot" : "Save snapshot" : editingFeedId ? "Update feed" : "Save feed"}</button></div>
      </div>}
      {step === "done" && <div className="workspace-source-wizard__done" role="status"><span>✓</span><strong>{editingId || editingFeedId ? "Source updated" : "Source connected"}</strong><p>The source and destination were committed successfully. Freshness, provenance, and bindings remain visible in the source list.</p><div><button type="button" onClick={start}>Add another source</button><button type="button" onClick={close}>Done</button></div></div>}
    </section>}
  </aside>;
}
