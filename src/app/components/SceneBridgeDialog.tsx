import {
  AlertTriangle,
  Boxes,
  Check,
  Clipboard,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
  AgentBridgeProposalRecord,
  AgentBridgeSessionAccess,
} from "../../agent/AgentGatewayClient";
import type {
  SemaFrameBridgeChange,
  SemaFrameBridgeProposalReview,
  SemaFrameBridgeTarget,
  SemaFrameSha256,
} from "../../bridge";
import "./SceneBridgeDialog.css";

export type SceneBridgePublicationSummary = Readonly<{
  sequence: number;
  revision: number;
  digest: SemaFrameSha256;
}>;

export type SceneBridgeProposalItem = Readonly<{
  record: AgentBridgeProposalRecord;
  review: SemaFrameBridgeProposalReview;
}>;

export type SceneBridgeDialogProps = Readonly<{
  open: boolean;
  session?: AgentBridgeSessionAccess;
  publication?: SceneBridgePublicationSummary;
  proposals?: readonly SceneBridgeProposalItem[];
  busy?: boolean;
  error?: string;
  onClose(): void;
  onCreate(target: SemaFrameBridgeTarget): void | Promise<void>;
  onPublish(): void | Promise<void>;
  onRefreshProposals(): void | Promise<void>;
  onApplyProposal(
    record: AgentBridgeProposalRecord,
    eligibleChangeIds: readonly string[],
  ): void | Promise<void>;
  onDiscardThrough(cursor: number): void | Promise<void>;
  onCloseSession(): void | Promise<void>;
}>;

const TARGET_OPTIONS: readonly Readonly<{
  value: SemaFrameBridgeTarget;
  label: string;
  detail: string;
}>[] = Object.freeze([
  { value: "blender", label: "Blender", detail: "Blender extension" },
  { value: "freecad", label: "FreeCAD", detail: "FreeCAD workbench" },
  { value: "unity", label: "Unity", detail: "Unity editor package" },
  { value: "unreal", label: "Unreal Engine", detail: "Unreal editor plugin" },
  { value: "custom", label: "Custom tool", detail: "Scene Bridge protocol client" },
]);

const SENSITIVE_QUERY_KEY = /^(?:access[_-]?token|authorization|bearer|key|secret|token)$/iu;

function bridgeUrlWithoutBearer(value: string, bearer: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const [key, entry] of [...url.searchParams.entries()]) {
      if (SENSITIVE_QUERY_KEY.test(key) || entry === bearer || entry.includes(`Bearer ${bearer}`)) {
        url.searchParams.delete(key);
      }
    }
    if (url.hash.includes(bearer)) url.hash = "";
    return url.toString();
  } catch {
    // Gateway responses are validated before reaching this component. Avoid
    // reflecting malformed input into native-tool setup if a custom host errs.
    return "";
  }
}

export function createSceneBridgeSetupJson(session: AgentBridgeSessionAccess): string {
  return JSON.stringify({
    format: "semaframe-bridge-setup",
    version: "1.0",
    target: session.target,
    sessionId: session.sessionId,
    pullUrl: bridgeUrlWithoutBearer(session.pullUrl, session.bearer),
    exchangeUrl: bridgeUrlWithoutBearer(session.exchangeUrl, session.bearer),
    authorization: {
      header: "Authorization",
      value: `Bearer ${session.bearer}`,
    },
    expiresAt: session.expiresAt,
  }, null, 2);
}

function safeError(cause: unknown): string {
  return (cause instanceof Error ? cause.message : "Scene Bridge operation failed.").slice(0, 500);
}

function proposalKey(item: SceneBridgeProposalItem): string {
  return `${item.record.cursor}:${item.record.proposal.proposalId}`;
}

function changeLabel(change: SemaFrameBridgeChange): string {
  if (change.kind === "transform") return "Transform";
  if (change.kind === "properties") return "Properties";
  if (change.kind === "presentation") return "Presentation";
  return "Hierarchy";
}

function shortDigest(digest: string | undefined): string {
  if (!digest) return "Not published";
  return `${digest.slice(0, 15)}…${digest.slice(-8)}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>([
    "button:not([disabled])",
    "select:not([disabled])",
    "input:not([disabled])",
    "[href]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(","))).filter((element) => !element.hasAttribute("hidden"));
}

export function SceneBridgeDialog(props: SceneBridgeDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const [target, setTarget] = useState<SemaFrameBridgeTarget>("blender");
  const [selected, setSelected] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [pending, setPending] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const proposals = useMemo(() => props.proposals ?? [], [props.proposals]);
  const disabled = Boolean(props.busy || pending);

  useEffect(() => {
    if (!props.open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = globalThis.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      globalThis.cancelAnimationFrame(frame);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      if (copyFeedbackTimerRef.current !== undefined) {
        globalThis.clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = undefined;
      }
      setCopied(false);
      setLocalError(undefined);
      setPending(undefined);
    }
    return () => {
      if (copyFeedbackTimerRef.current !== undefined) {
        globalThis.clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = undefined;
      }
    };
  }, [props.open]);

  useEffect(() => {
    const allowedByProposal = new Map(proposals.map((item) => [
      proposalKey(item),
      new Set(item.review.stale ? [] : item.review.eligibleChangeIds),
    ] as const));
    setSelected((current) => Object.fromEntries(Object.entries(current)
      .map(([key, changeIds]) => [
        key,
        changeIds.filter((changeId) => allowedByProposal.get(key)?.has(changeId)),
      ] as const)
      .filter(([key]) => allowedByProposal.has(key))));
  }, [proposals]);

  const run = useCallback(async (label: string, operation: () => void | Promise<void>) => {
    if (props.busy || pending) return;
    setPending(label);
    setLocalError(undefined);
    try {
      await operation();
    } catch (cause) {
      setLocalError(safeError(cause));
    } finally {
      setPending(undefined);
    }
  }, [pending, props.busy]);

  const setupJson = useMemo(
    () => props.session ? createSceneBridgeSetupJson(props.session) : undefined,
    [props.session],
  );

  const copySetup = useCallback(() => {
    void run("copy", async () => {
      if (!setupJson || !globalThis.navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable. Use a secure context and try again.");
      }
      await globalThis.navigator.clipboard.writeText(setupJson);
      setCopied(true);
      if (copyFeedbackTimerRef.current !== undefined) {
        globalThis.clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = globalThis.setTimeout(() => {
        setCopied(false);
        copyFeedbackTimerRef.current = undefined;
      }, 2_000);
    });
  }, [run, setupJson]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled) props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialogRef.current);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [disabled, props]);

  const toggleChange = useCallback((key: string, changeId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current[key] ?? []);
      if (checked) next.add(changeId);
      else next.delete(changeId);
      return { ...current, [key]: [...next] };
    });
  }, []);

  if (!props.open) return null;

  return createPortal(<div
    className="scene-bridge-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !disabled) props.onClose();
    }}
  >
    <section
      ref={dialogRef}
      className="scene-bridge-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={disabled ? "true" : undefined}
      onKeyDown={handleKeyDown}
    >
      <header className="scene-bridge-header">
        <div className="scene-bridge-heading">
          <span className="scene-bridge-mark" aria-hidden="true"><Boxes size={20} /></span>
          <div>
            <p className="scene-bridge-eyebrow">Native tool round trip</p>
            <h2 id={titleId}>Scene Bridge</h2>
            <p id={descriptionId}>
              Publish an immutable scene to a native tool, then review every returned edit before it reaches this Workspace.
            </p>
          </div>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="scene-bridge-icon-button"
          aria-label="Close Scene Bridge"
          disabled={disabled}
          onClick={props.onClose}
        ><X size={18} /></button>
      </header>

      {!props.session ? <div className="scene-bridge-create-view">
        <section className="scene-bridge-intro-card" aria-labelledby={`${titleId}-create`}>
          <ShieldCheck size={23} aria-hidden="true" />
          <div>
            <h3 id={`${titleId}-create`}>Start a scoped session</h3>
            <p>The native tool can pull one immutable Scene Exchange and submit proposals. It cannot mutate your Workspace directly.</p>
          </div>
        </section>
        <label className="scene-bridge-field">
          <span>Destination tool</span>
          <select value={target} disabled={disabled} onChange={(event) => setTarget(event.target.value as SemaFrameBridgeTarget)}>
            {TARGET_OPTIONS.map((option) => <option key={option.value} value={option.value}>
              {option.label} — {option.detail}
            </option>)}
          </select>
        </label>
        <div className="scene-bridge-boundaries" aria-label="Scene Bridge security boundaries">
          <span><Check size={14} /> Stable IDs and editable semantics</span>
          <span><Check size={14} /> Session-scoped bearer</span>
          <span><Check size={14} /> Human-reviewed changes</span>
        </div>
        <button
          type="button"
          className="scene-bridge-primary-button scene-bridge-create-button"
          disabled={disabled}
          onClick={() => void run("create", () => props.onCreate(target))}
        >{pending === "create" ? <LoaderCircle className="scene-bridge-spin" size={16} /> : <ExternalLink size={16} />}
          Create {TARGET_OPTIONS.find((option) => option.value === target)?.label} session
        </button>
      </div> : <div className="scene-bridge-session-view">
        <section className="scene-bridge-session-card" aria-labelledby={`${titleId}-session`}>
          <div className="scene-bridge-session-topline">
            <div>
              <p className="scene-bridge-eyebrow">Active session</p>
              <h3 id={`${titleId}-session`}>{TARGET_OPTIONS.find((option) => option.value === props.session?.target)?.label ?? props.session.target}</h3>
            </div>
            <span className="scene-bridge-live"><i /> Live until {formatTimestamp(props.session.expiresAt)}</span>
          </div>
          <dl className="scene-bridge-metadata">
            <div><dt>Session</dt><dd>{props.session.sessionId}</dd></div>
            <div><dt>Publication</dt><dd>{props.publication ? `#${props.publication.sequence} · revision ${props.publication.revision}` : "Preparing"}</dd></div>
            <div><dt>Digest</dt><dd title={props.publication?.digest}>{shortDigest(props.publication?.digest)}</dd></div>
          </dl>
          <div className="scene-bridge-auth-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>Authorization stays out of the URL</strong>
              <p>The bearer is sent separately as an <code>Authorization: Bearer …</code> header. It is never appended to the pull or exchange URL.</p>
            </div>
          </div>
          <div className="scene-bridge-session-actions">
            <button type="button" className="scene-bridge-secondary-button" disabled={disabled} onClick={copySetup}>
              {pending === "copy" ? <LoaderCircle className="scene-bridge-spin" size={15} /> : copied ? <Check size={15} /> : <Clipboard size={15} />}
              {copied ? "Setup JSON copied" : "Copy setup JSON"}
            </button>
            <button type="button" className="scene-bridge-secondary-button" disabled={disabled} onClick={() => void run("publish", props.onPublish)}>
              {pending === "publish" ? <LoaderCircle className="scene-bridge-spin" size={15} /> : <Send size={15} />}
              Publish current revision
            </button>
          </div>
          <p className="scene-bridge-secret-warning">Setup JSON contains the session bearer. Share it only with the selected native tool; the session expires automatically.</p>
        </section>

        <section className="scene-bridge-proposals" aria-labelledby={`${titleId}-proposals`}>
          <div className="scene-bridge-section-heading">
            <div>
              <p className="scene-bridge-eyebrow">Review queue</p>
              <h3 id={`${titleId}-proposals`}>Proposed changes <span>{proposals.length}</span></h3>
              <p>Nothing is selected or applied automatically.</p>
            </div>
            <button type="button" className="scene-bridge-secondary-button" disabled={disabled} onClick={() => void run("refresh", props.onRefreshProposals)}>
              {pending === "refresh" ? <LoaderCircle className="scene-bridge-spin" size={15} /> : <RefreshCw size={15} />}
              Refresh
            </button>
          </div>

          {proposals.length === 0 ? <div className="scene-bridge-empty">
            <Boxes size={22} aria-hidden="true" />
            <strong>No proposals waiting</strong>
            <p>Edit the published scene in the native tool, then send a change proposal back for review.</p>
          </div> : <div className="scene-bridge-proposal-list">
            {proposals.map((item) => {
              const key = proposalKey(item);
              const selectedIds = selected[key] ?? [];
              const eligible = new Set(item.review.stale ? [] : item.review.eligibleChangeIds);
              const allEligibleSelected = eligible.size > 0 && [...eligible].every((id) => selectedIds.includes(id));
              return <article key={key} className="scene-bridge-proposal" data-stale={item.review.stale ? "true" : "false"}>
                <header>
                  <div>
                    <span className="scene-bridge-proposal-id">Proposal {item.record.proposal.proposalId}</span>
                    <small>Cursor {item.record.cursor} · {formatTimestamp(item.record.receivedAt)}</small>
                  </div>
                  <span className={item.review.stale ? "scene-bridge-badge scene-bridge-badge-stale" : "scene-bridge-badge"}>
                    {item.review.stale ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}
                    {item.review.stale ? "Stale" : "Review required"}
                  </span>
                </header>

                {item.record.proposal.note && <p className="scene-bridge-proposal-note">{item.record.proposal.note}</p>}
                {item.review.issues.length > 0 && <ul className="scene-bridge-issues" aria-label={`Issues for proposal ${item.record.proposal.proposalId}`}>
                  {item.review.issues.map((issue, index) => <li key={`${issue.code}:${issue.changeId ?? "proposal"}:${index}`}>
                    <AlertTriangle size={13} aria-hidden="true" />
                    <span><strong>{issue.code.replaceAll("_", " ")}</strong>{issue.changeId ? ` · ${issue.changeId}` : ""}: {issue.message}</span>
                  </li>)}
                </ul>}

                <div className="scene-bridge-change-toolbar">
                  <span>{eligible.size} of {item.record.proposal.changes.length} changes eligible</span>
                  <button
                    type="button"
                    disabled={disabled || eligible.size === 0}
                    onClick={() => setSelected((current) => ({
                      ...current,
                      [key]: allEligibleSelected ? [] : [...eligible],
                    }))}
                  >{allEligibleSelected ? "Clear selection" : "Select all eligible"}</button>
                </div>

                <ul className="scene-bridge-changes">
                  {item.record.proposal.changes.map((change) => {
                    const canApply = eligible.has(change.changeId);
                    const checked = canApply && selectedIds.includes(change.changeId);
                    const changeIssues = item.review.issues.filter((issue) => issue.changeId === change.changeId);
                    return <li key={change.changeId} data-eligible={canApply ? "true" : "false"}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled || !canApply}
                          aria-describedby={changeIssues.length ? `${titleId}-${item.record.cursor}-${change.changeId}-issue` : undefined}
                          onChange={(event) => toggleChange(key, change.changeId, event.target.checked)}
                        />
                        <span className="scene-bridge-change-copy">
                          <strong>{changeLabel(change)} <small>{change.changeId}</small></strong>
                          <span>Component {change.componentId}</span>
                          {!canApply && <em id={`${titleId}-${item.record.cursor}-${change.changeId}-issue`}>
                            {item.review.stale ? "Disabled because this proposal targets an older publication." : changeIssues[0]?.message ?? "This change is not eligible for application."}
                          </em>}
                        </span>
                      </label>
                    </li>;
                  })}
                </ul>

                <footer>
                  <button
                    type="button"
                    className="scene-bridge-discard-button"
                    disabled={disabled}
                    onClick={() => void run(`discard:${item.record.cursor}`, () => props.onDiscardThrough(item.record.cursor))}
                  >{pending === `discard:${item.record.cursor}` ? <LoaderCircle className="scene-bridge-spin" size={14} /> : <Trash2 size={14} />}
                    Discard through cursor {item.record.cursor}
                  </button>
                  <button
                    type="button"
                    className="scene-bridge-primary-button"
                    disabled={disabled || item.review.stale || selectedIds.length === 0}
                    title={item.review.stale
                      ? "Refresh or republish before reviewing this stale proposal."
                      : selectedIds.length === 0 ? "Select at least one eligible change." : undefined}
                    onClick={() => void run(`apply:${item.record.cursor}`, () => props.onApplyProposal(item.record, selectedIds))}
                  >{pending === `apply:${item.record.cursor}` ? <LoaderCircle className="scene-bridge-spin" size={14} /> : <Check size={14} />}
                    Apply {selectedIds.length || "selected"}
                  </button>
                </footer>
              </article>;
            })}
          </div>}
        </section>
      </div>}

      {(localError || props.error) && <p className="scene-bridge-error" role="alert">
        <AlertTriangle size={15} aria-hidden="true" /> {localError ?? props.error}
      </p>}

      {props.session && <footer className="scene-bridge-footer">
        <p>Closing revokes this session’s bearer and removes its queued proposals.</p>
        <button type="button" className="scene-bridge-danger-button" disabled={disabled} onClick={() => void run("close-session", props.onCloseSession)}>
          {pending === "close-session" ? <LoaderCircle className="scene-bridge-spin" size={15} /> : <X size={15} />}
          Close session
        </button>
      </footer>}
    </section>
  </div>, document.body);
}
