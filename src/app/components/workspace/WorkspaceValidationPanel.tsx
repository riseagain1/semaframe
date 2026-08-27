import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleHelp,
  Info,
  ShieldCheck,
  WandSparkles,
} from "lucide-react";
import { useId } from "react";
import type {
  WorkspaceValidationDomain,
  WorkspaceValidationIssue,
  WorkspaceValidationTarget,
  WorkspaceValidationView,
} from "../../validation/buildWorkspaceValidationView";
import "./WorkspaceValidationPanel.css";

export type WorkspaceValidationPanelProps = Readonly<{
  view: WorkspaceValidationView;
  disabled?: boolean;
  onNavigate?: (target: WorkspaceValidationTarget) => void;
  onAutoArrange2D?: () => void;
}>;

const DOMAIN_LABEL: Readonly<Record<WorkspaceValidationDomain, string>> = Object.freeze({
  spatial: "Spatial",
  layout: "2D layout",
  physics: "Physics",
  reality: "Reality",
  data: "Data",
});

const DOMAINS: readonly WorkspaceValidationDomain[] = ["spatial", "layout", "physics", "reality", "data"];

function IssueIcon({ issue }: { issue: WorkspaceValidationIssue }) {
  if (issue.severity === "blocking") return <AlertCircle size={15} aria-hidden="true" />;
  if (issue.severity === "warning") return <AlertTriangle size={15} aria-hidden="true" />;
  return <Info size={15} aria-hidden="true" />;
}

/** A read-only summary. Navigation is delegated so the host owns panel state. */
export function WorkspaceValidationPanel({
  view,
  disabled = false,
  onNavigate,
  onAutoArrange2D,
}: WorkspaceValidationPanelProps) {
  const groupId = useId();
  const hasLayoutOverlap = view.issues.some((issue) => issue.code === "layout_overlap");
  return (
    <aside className="workspace-validation-panel" aria-label="Workspace checks">
      <header className="workspace-validation-panel__header">
        <div>
          <p>Validation center</p>
          <h2>Checks</h2>
        </div>
        <span>Revision {view.revision}</span>
      </header>

      <p className="workspace-validation-panel__boundary">
        <ShieldCheck size={15} aria-hidden="true" />
        Bounded checks of the current Workspace—not engineering certification.
      </p>

      <dl className="workspace-validation-panel__counts" aria-label={`${view.counts.total} current check issues`}>
        <div className="is-blocking"><dt>Blocking</dt><dd>{view.counts.blocking}</dd></div>
        <div className="is-warning"><dt>Warnings</dt><dd>{view.counts.warning}</dd></div>
        <div className="is-info"><dt>Notices</dt><dd>{view.counts.info}</dd></div>
      </dl>

      {hasLayoutOverlap && onAutoArrange2D && (
        <button
          className="workspace-validation-panel__auto-arrange"
          type="button"
          onClick={onAutoArrange2D}
          disabled={disabled}
        >
          <WandSparkles size={15} aria-hidden="true" />
          Auto-arrange movable 2D panels
        </button>
      )}

      {view.issues.length === 0 ? (
        <section className="workspace-validation-panel__clear" role="status">
          <CheckCircle2 size={21} aria-hidden="true" />
          <div>
            <h3>No current issues found by these bounded checks</h3>
            <p>This does not certify the scene. Review the published coverage and limits before export or production use.</p>
          </div>
        </section>
      ) : (
        <div className="workspace-validation-panel__groups">
          {DOMAINS.map((domain) => {
            const domainIssues = view.issues.filter((issue) => issue.domain === domain);
            if (domainIssues.length === 0) return null;
            return (
              <section key={domain} className="workspace-validation-panel__group" aria-labelledby={`${groupId}-${domain}`}>
                <h3 id={`${groupId}-${domain}`}>{DOMAIN_LABEL[domain]} <span>{domainIssues.length}</span></h3>
                <ul>
                  {domainIssues.map((issue) => (
                    <li key={issue.id} className={`is-${issue.severity}`}>
                      <span className="workspace-validation-panel__issue-icon"><IssueIcon issue={issue} /></span>
                      <div>
                        <p className="workspace-validation-panel__issue-meta">
                          <span>{issue.severity}</span><code>{issue.code}</code>
                        </p>
                        <strong>{issue.title}</strong>
                        <small>{issue.detail}</small>
                      </div>
                      {issue.target && onNavigate && (
                        <button
                          type="button"
                          onClick={() => onNavigate(issue.target!)}
                          disabled={disabled}
                          aria-label={`Review ${issue.title}`}
                        >
                          Review <ArrowUpRight size={13} aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <details className="workspace-validation-panel__details">
        <summary><CircleHelp size={14} aria-hidden="true" />What is checked—and what is not</summary>
        <section>
          <h3>Current coverage</h3>
          <ul>{view.coverage.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section>
          <h3>Limits</h3>
          <ul>{view.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      </details>
    </aside>
  );
}
