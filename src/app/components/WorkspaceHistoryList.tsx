import { useEffect, useRef } from "react";
import type { WorkspaceHistoryEntry } from "../uiTypes";
import { StatusPill } from "./StatusPill";

export type WorkspaceHistoryListProps = {
  entries: WorkspaceHistoryEntry[];
  emptyMessage?: string;
};

export function WorkspaceHistoryList({
  entries,
  emptyMessage = "No workspace changes yet.",
}: WorkspaceHistoryListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    bottomRef.current?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [entries.length]);

  if (entries.length === 0) return <p className="workspace-history-empty">{emptyMessage}</p>;

  return (
    <div className="workspace-history-list" aria-label="Workspace changes">
      {entries.map((entry, index) => (
        <article className={`workspace-history-entry status-${entry.status}`} key={entry.id}>
          <div className="entry-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</div>
          <div className="entry-body">
            <p className="entry-text">{entry.text}</p>
            <div className="entry-meta">
              <StatusPill status={entry.status} compact />
              {entry.source === "agent" && <span className="entry-source">Agent{entry.clientName ? ` · ${entry.clientName}` : ""}</span>}
              {entry.source === "manual" && <span className="entry-source source-manual">Manual</span>}
              {entry.traceId && <code className="entry-trace" title={entry.traceId}>Trace {entry.traceId.slice(0, 8)}</code>}
              {entry.summary && <span className="entry-summary">{entry.summary}</span>}
            </div>
            {entry.detail && <p className="entry-detail">{entry.detail}</p>}
          </div>
        </article>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
