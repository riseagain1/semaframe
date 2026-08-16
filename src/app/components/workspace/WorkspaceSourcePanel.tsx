import { useMemo, useState, type FormEvent } from "react";
import {
  createExplicitHostFeedMapping,
  deriveHostFeedMappingPresets,
  discoverHostFeedValuePaths,
  normalizeHostFeedUrl,
  type HostFeedFetchResponse,
  type HostFeedFormat,
  type HostFeedMappingPreset,
  type HostFeedTargetType,
  type HostFeedValueKind,
  type ResourceBindingDiagnostic,
  type ResourceRefreshPolicy,
  type WorkspaceHostFeedPreviewRequest,
  type WorkspaceHostFeedSaveRequest,
} from "../../../workspace/data";
import type { LocalInlineSourceFormat } from "../../../workspace/data/localInlineSource";

const EXAMPLE_CHART_JSON = `{
  "labels": ["09:30", "10:30", "11:30"],
  "series": [{
    "id": "price",
    "label": "Price",
    "values": [187.4, 188.1, 187.8]
  }]
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
  /** Present only for canonical host-owned inline snapshots. */
  editableJson?: string;
  reapplyable?: boolean;
  refreshable?: boolean;
  automationPaused?: boolean;
  lastError?: string;
  hostFeedConfig?: Readonly<{
    url: string;
    format: HostFeedFormat;
    policy: ResourceRefreshPolicy;
  }>;
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

export type WorkspaceSourcePanelProps = Readonly<{
  sources: readonly WorkspaceSourceItem[];
  bindingTargets?: readonly WorkspaceSourceBindingTarget[];
  diagnostics?: readonly ResourceBindingDiagnostic[];
  onSaveInlineSource?: (request: WorkspaceInlineSourceSaveRequest) => boolean;
  onRefresh?: (sourceId: string) => void;
  onPreviewHostFeed?: (request: WorkspaceHostFeedPreviewRequest) => Promise<HostFeedFetchResponse>;
  onSaveHostFeed?: (request: WorkspaceHostFeedSaveRequest) => boolean | Promise<boolean>;
  onUnbindSource?: (bindingId: string) => void;
  onDeleteSource?: (sourceId: string) => void;
}>;

const HOST_FEED_TARGET_TYPES = new Set<HostFeedTargetType>(["data-panel", "chart", "table", "text", "document"]);
const EXPLICIT_MAPPING_ID = "__explicit__";
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86_400;

function expectedKinds(targetType: HostFeedTargetType, targetProp: string): readonly HostFeedValueKind[] {
  if (targetType === "data-panel" && targetProp === "data") return ["array", "object", "string", "number", "boolean", "null"];
  if ((targetType === "chart" && ["labels", "series"].includes(targetProp))
    || (targetType === "table" && ["columns", "rows"].includes(targetProp))) return ["array"];
  if (targetType === "table" && targetProp === "striped") return ["boolean"];
  return ["string"];
}

function sourceOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "approved host";
  }
}

function displayRetrievedAt(value: string | undefined): string {
  if (!value) return "No snapshot";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Invalid snapshot time" : date.toLocaleString();
}

export function WorkspaceSourcePanel({
  sources,
  bindingTargets = [],
  diagnostics = [],
  onSaveInlineSource,
  onRefresh,
  onPreviewHostFeed,
  onSaveHostFeed,
  onUnbindSource,
  onDeleteSource,
}: WorkspaceSourcePanelProps) {
  const [editingId, setEditingId] = useState<string>();
  const [label, setLabel] = useState("Market snapshot");
  const [format, setFormat] = useState<LocalInlineSourceFormat>("json");
  const [text, setText] = useState(EXAMPLE_CHART_JSON);
  const [targetId, setTargetId] = useState("");
  const [targetProp, setTargetProp] = useState("");
  const [sourcePath, setSourcePath] = useState("$");
  const target = useMemo(() => bindingTargets.find((candidate) => candidate.id === targetId), [bindingTargets, targetId]);
  const [feedLabel, setFeedLabel] = useState("External feed");
  const [editingFeedId, setEditingFeedId] = useState<string>();
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const [feedUrl, setFeedUrl] = useState("");
  const [feedFormat, setFeedFormat] = useState<HostFeedFormat>("auto");
  const [feedPolicyMode, setFeedPolicyMode] = useState<ResourceRefreshPolicy["mode"]>("manual");
  const [feedIntervalSeconds, setFeedIntervalSeconds] = useState(60);
  const [feedPreview, setFeedPreview] = useState<HostFeedFetchResponse>();
  const [feedPending, setFeedPending] = useState<"preview" | "save">();
  const [feedError, setFeedError] = useState<string>();
  const [feedTargetId, setFeedTargetId] = useState("");
  const [feedMappingId, setFeedMappingId] = useState("");
  const [feedTargetProp, setFeedTargetProp] = useState("");
  const [feedSourcePath, setFeedSourcePath] = useState("$");
  const feedTargets = useMemo(() => bindingTargets.filter((candidate) =>
    HOST_FEED_TARGET_TYPES.has(candidate.typeId as HostFeedTargetType),
  ), [bindingTargets]);
  const feedTarget = useMemo(
    () => feedTargets.find((candidate) => candidate.id === feedTargetId),
    [feedTargetId, feedTargets],
  );
  const feedTargetType = feedTarget?.typeId as HostFeedTargetType | undefined;
  const feedPaths = useMemo(
    () => feedPreview ? discoverHostFeedValuePaths(feedPreview.snapshot.data) : [],
    [feedPreview],
  );
  const feedPresets = useMemo(
    () => feedPreview && feedTargetType
      ? deriveHostFeedMappingPresets(feedPreview.snapshot.data).filter((preset) => preset.targetType === feedTargetType)
      : [],
    [feedPreview, feedTargetType],
  );
  const effectiveMappingId = feedMappingId && (
    feedMappingId === EXPLICIT_MAPPING_ID || feedPresets.some((preset) => preset.id === feedMappingId)
  ) ? feedMappingId : (feedPresets[0]?.id ?? EXPLICIT_MAPPING_ID);
  const effectiveTargetProp = feedTargetProp && feedTarget?.writableProps.includes(feedTargetProp)
    ? feedTargetProp
    : feedTargetType === "data-panel" && feedTarget?.writableProps.includes("data")
      ? "data"
      : (feedTarget?.writableProps[0] ?? "");
  const matchingFeedPaths = effectiveTargetProp && feedTargetType
    ? feedPaths.filter((candidate) => expectedKinds(feedTargetType, effectiveTargetProp).includes(candidate.kind))
    : feedPaths;
  const effectiveSourcePath = matchingFeedPaths.some((candidate) => candidate.path === feedSourcePath)
    ? feedSourcePath
    : (matchingFeedPaths[0]?.path ?? "$");

  const resetForm = () => {
    setEditingId(undefined);
    setLabel("Market snapshot");
    setFormat("json");
    setText(EXAMPLE_CHART_JSON);
    setTargetId("");
    setTargetProp("");
    setSourcePath("$");
  };
  const editSource = (source: WorkspaceSourceItem) => {
    if (source.hostFeedConfig) {
      const { url, format: hostFormat, policy } = source.hostFeedConfig;
      setEditingFeedId(source.id);
      setEditingId(undefined);
      setFeedLabel(source.label);
      setFeedUrl(url);
      setFeedFormat(hostFormat);
      setFeedPolicyMode(policy.mode);
      setFeedIntervalSeconds(policy.intervalMs ? Math.round(policy.intervalMs / 1_000) : 60);
      setFeedPreview(undefined);
      setFeedError(undefined);
      setFeedTargetId("");
      setFeedMappingId("");
      setFeedTargetProp("");
      setFeedSourcePath("$");
      return;
    }
    if (source.editableJson !== undefined) {
      setEditingFeedId(undefined);
      setEditingId(source.id);
      setLabel(source.label);
      setFormat("json");
      setText(source.editableJson);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const saved = onSaveInlineSource?.({
      ...(editingId ? { resourceId: editingId } : {}),
      label,
      format,
      text,
      ...(targetId ? {
        targetComponentId: targetId,
        ...(targetProp ? { targetProp } : {}),
        ...(sourcePath.trim() ? { sourcePath: sourcePath.trim() } : {}),
      } : {}),
    });
    if (saved) resetForm();
  };

  const resetHostFeedForm = () => {
    setEditingFeedId(undefined);
    setFeedLabel("External feed");
    setFeedUrl("");
    setFeedFormat("auto");
    setFeedPolicyMode("manual");
    setFeedIntervalSeconds(60);
    setFeedPreview(undefined);
    setFeedError(undefined);
    setFeedTargetId("");
    setFeedMappingId("");
    setFeedTargetProp("");
    setFeedSourcePath("$");
  };
  const invalidateHostFeedPreview = () => {
    setFeedPreview(undefined);
    setFeedError(undefined);
    setFeedMappingId("");
  };
  const currentHostFeedPolicy = (): ResourceRefreshPolicy => {
    if (feedPolicyMode !== "interval") {
      return { mode: feedPolicyMode, offline: "keep_last_good" };
    }
    if (!Number.isSafeInteger(feedIntervalSeconds)
      || feedIntervalSeconds < MIN_INTERVAL_SECONDS
      || feedIntervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error(`Refresh interval must be ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS} seconds`);
    }
    return {
      mode: "interval",
      intervalMs: feedIntervalSeconds * 1_000,
      offline: "keep_last_good",
    };
  };
  const previewHostFeed = async (event: FormEvent) => {
    event.preventDefault();
    if (!onPreviewHostFeed || feedPending) return;
    setFeedPending("preview");
    setFeedError(undefined);
    try {
      const url = normalizeHostFeedUrl(feedUrl);
      const policy = currentHostFeedPolicy();
      const preview = await onPreviewHostFeed({ url, format: feedFormat, policy });
      setFeedPreview(preview);
      setFeedUrl(preview.requestedUrl);
      setFeedMappingId("");
      setFeedSourcePath("$");
    } catch (error) {
      setFeedPreview(undefined);
      setFeedError(error instanceof Error ? error.message : "The host could not preview this feed");
    } finally {
      setFeedPending(undefined);
    }
  };
  const saveHostFeed = async () => {
    if (!onSaveHostFeed || !feedPreview || feedPending) return;
    const normalizedLabel = feedLabel.trim();
    if (!normalizedLabel) {
      setFeedError("Give the feed a label");
      return;
    }
    let policy: ResourceRefreshPolicy;
    try {
      policy = currentHostFeedPolicy();
    } catch (error) {
      setFeedError(error instanceof Error ? error.message : "The refresh policy is invalid");
      return;
    }

    let mapping: HostFeedMappingPreset | undefined;
    if (feedTarget && feedTargetType) {
      mapping = effectiveMappingId === EXPLICIT_MAPPING_ID
        ? effectiveTargetProp && matchingFeedPaths.some((candidate) => candidate.path === effectiveSourcePath)
          ? createExplicitHostFeedMapping({
            targetType: feedTargetType,
            targetProp: effectiveTargetProp,
            sourcePath: effectiveSourcePath,
          })
          : undefined
        : feedPresets.find((preset) => preset.id === effectiveMappingId);
      if (!mapping) {
        setFeedError("Choose a compatible feed mapping for the selected component");
        return;
      }
      if (mapping.bindings.some((binding) => !feedTarget.writableProps.includes(binding.targetProp))) {
        setFeedError("The selected mapping targets a property that is not writable on this component");
        return;
      }
    }

    setFeedPending("save");
    setFeedError(undefined);
    try {
      const saved = await onSaveHostFeed({
        ...(editingFeedId ? { resourceId: editingFeedId } : {}),
        label: normalizedLabel,
        requestedFormat: feedFormat,
        policy,
        feed: feedPreview,
        ...(feedTarget ? { targetComponentId: feedTarget.id } : {}),
        ...(mapping ? { mapping } : {}),
      });
      if (saved) resetHostFeedForm();
    } catch (error) {
      setFeedError(error instanceof Error ? error.message : "The host could not save this feed");
    } finally {
      setFeedPending(undefined);
    }
  };

  return (
    <aside className="workspace-side-panel workspace-sources" aria-label="Data sources">
      <header><strong>Sources</strong><span>{sources.length}</span></header>
      {sources.length === 0 ? <p className="workspace-empty-copy">Add a local snapshot or preview an approved HTTPS feed, then bind it to a component property.</p> : (
        <ul className="workspace-sources__list">
          {sources.map((source) => (
            <li key={source.id} className="workspace-source">
              <div className="workspace-source__summary">
                <button type="button" className="workspace-source__main" onClick={() => editSource(source)} disabled={source.editableJson === undefined && !source.hostFeedConfig}>
                  <strong>{source.label}</strong>
                  <span>{source.connectorType}{source.connectorVersion ? `@${source.connectorVersion}` : ""} · {source.status ?? "ready"}</span>
                  <small>{source.connectorType === "http.feed" ? "Last good" : "Retrieved"} {displayRetrievedAt(source.retrievedAt)} · {source.bindingCount ?? 0} binding{source.bindingCount === 1 ? "" : "s"}</small>
                  {source.provenanceLabel && <small>Provenance: {source.provenanceLabel}</small>}
                  {source.citation && <small>Citation: {source.citation}</small>}
                  {source.automationPaused && <small className="workspace-source__diagnostic">Automation paused; Preview/update to enable.</small>}
                  {source.lastError && <small className="workspace-source__diagnostic">Last refresh: {source.lastError}</small>}
                  {source.diagnostics?.map((item) => <small className="workspace-source__diagnostic" key={`${source.id}-${item.bindingId}-${item.code}`}>{item.code}: {item.message}</small>)}
                </button>
                <div className="workspace-source__actions">
                  {source.hostFeedConfig && <button type="button" onClick={() => editSource(source)}>Manage</button>}
                  <button type="button" onClick={() => onRefresh?.(source.id)} disabled={!onRefresh || !(source.refreshable ?? source.reapplyable) || source.status === "refreshing"}>
                    {source.status === "refreshing" ? "Refreshing…" : source.connectorType === "http.feed" ? "Refresh" : "Reapply"}
                  </button>
                  {onDeleteSource && (pendingDeleteId === source.id ? <>
                    <button type="button" className="is-danger" onClick={() => {
                      onDeleteSource(source.id);
                      if (editingFeedId === source.id) resetHostFeedForm();
                      if (editingId === source.id) resetForm();
                      setPendingDeleteId(undefined);
                    }}>Confirm delete</button>
                    <button type="button" onClick={() => setPendingDeleteId(undefined)}>Cancel</button>
                  </> : <button type="button" onClick={() => setPendingDeleteId(source.id)}>Delete</button>)}
                </div>
              </div>
              {source.bindings?.length ? <ul className="workspace-source__bindings" aria-label={`${source.label} bindings`}>
                {source.bindings.map((binding) => <li key={binding.id}>
                  <span>{binding.componentLabel}.{binding.targetProp} ← {binding.sourcePath}</span>
                  {onUnbindSource && <button type="button" onClick={() => onUnbindSource(binding.id)}>Unbind</button>}
                </li>)}
              </ul> : null}
            </li>
          ))}
        </ul>
      )}

      {diagnostics.length > 0 && <section className="workspace-sources__diagnostics" aria-label="Binding diagnostics">
        <strong>Binding diagnostics</strong>
        {diagnostics.map((item) => <p key={`${item.bindingId}-${item.code}`}>{item.code}: {item.message}</p>)}
      </section>}

      {onSaveInlineSource && <form className="workspace-source-form" onSubmit={submit}>
        <div className="workspace-source-form__heading">
          <strong>{editingId ? "Update local snapshot" : "New local snapshot"}</strong>
          {editingId && <button type="button" onClick={resetForm}>New</button>}
        </div>
        <label>
          Source label
          <input required value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          Format
          <select value={format} onChange={(event) => setFormat(event.target.value as LocalInlineSourceFormat)}>
            <option value="json">JSON</option>
            <option value="csv">CSV time series</option>
          </select>
        </label>
        <label>
          Snapshot data
          <textarea required rows={9} value={text} onChange={(event) => setText(event.target.value)} aria-describedby="workspace-source-format-hint" />
        </label>
        <p id="workspace-source-format-hint" className="workspace-source-form__hint">
          CSV uses the first column as labels and every remaining numeric column as a chart series. Data stays inside this project; no URL is fetched.
        </p>
        <label>
          Bind to component (optional)
          <select value={targetId} onChange={(event) => { setTargetId(event.target.value); setTargetProp(""); }}>
            <option value="">Save without binding</option>
            {bindingTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label} · {candidate.typeId}</option>)}
          </select>
        </label>
        {targetId && target?.typeId !== "chart" && <>
          <label>
            Target property
            <select required value={targetProp} onChange={(event) => setTargetProp(event.target.value)}>
              <option value="">Choose property</option>
              {target?.writableProps.map((property) => <option key={property} value={property}>{property}</option>)}
            </select>
          </label>
          <label>
            Source path
            <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="$.value" />
          </label>
        </>}
        {target?.typeId === "chart" && <p className="workspace-source-form__hint">Normalized chart data automatically binds $.labels and $.series.</p>}
        <button type="submit">{editingId ? "Update snapshot" : "Save snapshot"}</button>
      </form>}

      {onPreviewHostFeed && onSaveHostFeed && <form className="workspace-source-form workspace-host-feed-form" onSubmit={(event) => void previewHostFeed(event)}>
        <div className="workspace-source-form__heading">
          <strong>{editingFeedId ? "Manage HTTPS feed" : "New HTTPS feed"}</strong>
          {(feedPreview || editingFeedId) && <button type="button" onClick={resetHostFeedForm}>New</button>}
        </div>
        <p className="workspace-source-form__hint">
          {editingFeedId
            ? "Preview again to approve the URL and apply policy changes. Existing bindings remain until you replace or unbind them."
            : "The local host broker reads public HTTPS JSON, CSV, or RSS/Atom after approval. Components never fetch the URL directly."}
        </p>
        <label>
          Feed label
          <input required value={feedLabel} onChange={(event) => setFeedLabel(event.target.value)} />
        </label>
        <label>
          HTTPS feed URL
          <input
            required
            inputMode="url"
            placeholder="https://example.com/feed.json"
            value={feedUrl}
            onChange={(event) => { setFeedUrl(event.target.value); invalidateHostFeedPreview(); }}
          />
        </label>
        <label>
          Feed format
          <select value={feedFormat} onChange={(event) => { setFeedFormat(event.target.value as HostFeedFormat); invalidateHostFeedPreview(); }}>
            <option value="auto">Detect automatically</option>
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
            <option value="rss">RSS / Atom</option>
          </select>
        </label>
        <label>
          Refresh policy
          <select value={feedPolicyMode} onChange={(event) => {
            setFeedPolicyMode(event.target.value as ResourceRefreshPolicy["mode"]);
            invalidateHostFeedPreview();
          }}>
            <option value="manual">Manual</option>
            <option value="interval">Interval</option>
            <option value="on_open">When project opens</option>
          </select>
        </label>
        {feedPolicyMode === "interval" && <label>
          Refresh interval (seconds)
          <input
            type="number"
            min={MIN_INTERVAL_SECONDS}
            max={MAX_INTERVAL_SECONDS}
            step={1}
            value={feedIntervalSeconds}
            onChange={(event) => {
              setFeedIntervalSeconds(Number(event.target.value));
              invalidateHostFeedPreview();
            }}
          />
        </label>}
        <button type="submit" disabled={Boolean(feedPending)}>
          {feedPending === "preview" ? "Previewing…" : feedPreview ? "Preview again" : "Preview feed"}
        </button>

        {feedPreview && <section className="workspace-feed-preview" aria-label="Feed preview">
          <strong>{feedPreview.format.toUpperCase()} from {sourceOrigin(feedPreview.finalUrl)}</strong>
          <small>Retrieved {displayRetrievedAt(feedPreview.retrievedAt)} · {feedPreview.contentType}</small>
          {feedPreview.snapshot.provenance[0]?.publisher && <small>Publisher: {feedPreview.snapshot.provenance[0].publisher}</small>}
          <pre>{JSON.stringify(feedPreview.snapshot.data, null, 2).slice(0, 4_000)}</pre>
        </section>}

        {feedPreview && <label>
          Bind feed to component (optional)
          <select value={feedTargetId} onChange={(event) => {
            setFeedTargetId(event.target.value);
            setFeedMappingId("");
            setFeedTargetProp("");
            setFeedSourcePath("$");
          }}>
            <option value="">Save without binding</option>
            {feedTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label} · {candidate.typeId}</option>)}
          </select>
        </label>}

        {feedPreview && feedTarget && feedTargetType === "data-panel" && <p className="workspace-source-form__hint">
          The complete feed automatically binds to the Data Panel data property.
        </p>}

        {feedPreview && feedTarget && feedTargetType !== "data-panel" && <>
          <label>
            Feed mapping
            <select value={effectiveMappingId} onChange={(event) => setFeedMappingId(event.target.value)}>
              {feedPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              <option value={EXPLICIT_MAPPING_ID}>Choose one property and source field</option>
            </select>
          </label>
          {effectiveMappingId === EXPLICIT_MAPPING_ID && <>
            <label>
              Target property
              <select value={effectiveTargetProp} onChange={(event) => { setFeedTargetProp(event.target.value); setFeedSourcePath("$"); }}>
                {feedTarget.writableProps.map((property) => <option key={property} value={property}>{property}</option>)}
              </select>
            </label>
            <label>
              Source field
              <select value={effectiveSourcePath} onChange={(event) => setFeedSourcePath(event.target.value)}>
                {matchingFeedPaths.map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.label} · {candidate.kind}</option>)}
              </select>
            </label>
            {matchingFeedPaths.length === 0 && <p className="workspace-source-form__hint">No source field has a compatible value type for this property.</p>}
          </>}
        </>}

        {feedError && <p className="workspace-source__diagnostic" role="alert">{feedError}</p>}
        {feedPreview && <button type="button" disabled={Boolean(feedPending)} onClick={() => void saveHostFeed()}>
          {feedPending === "save" ? "Saving…" : editingFeedId ? "Update feed" : "Save feed"}
        </button>}
      </form>}
    </aside>
  );
}
