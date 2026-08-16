import { Bot, History, LoaderCircle, Settings2, WifiOff, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { WorkspaceHistoryEntry } from "../uiTypes";
import { WorkspaceHistoryList } from "./WorkspaceHistoryList";

export type AgentWorkspaceStatus = "connected" | "applying" | "disconnected";

export type AgentWorkspaceControlsProps = {
  status: AgentWorkspaceStatus;
  clientName?: string;
  historyCount: number;
  historyExpanded?: boolean;
  manageExpanded?: boolean;
  historyDrawerId?: string;
  managePanelId?: string;
  onHistory: () => void;
  onManage: () => void;
};

export function AgentWorkspaceControls({
  status,
  clientName,
  historyCount,
  historyExpanded = false,
  manageExpanded = false,
  historyDrawerId = "agent-history-drawer",
  managePanelId = "agent-manage-panel",
  onHistory,
  onManage,
}: AgentWorkspaceControlsProps) {
  const controllerLabel = clientName?.trim() || "Agent";
  const statusCopy = status === "connected"
    ? `${controllerLabel} connected`
    : status === "applying"
      ? `Applying ${controllerLabel} change`
      : `${controllerLabel} disconnected`;

  return (
    <section
      className={`agent-workspace-controls status-${status}`}
      aria-label="Agent workspace controls"
      aria-busy={status === "applying" || undefined}
      aria-hidden={manageExpanded || undefined}
      inert={manageExpanded || undefined}
    >
      <div className="agent-workspace-status" role="status" aria-live="polite" aria-atomic="true">
        {status === "applying"
          ? <LoaderCircle className="spin-slow" size={15} aria-hidden="true" />
          : status === "disconnected"
            ? <WifiOff size={15} aria-hidden="true" />
            : <Bot size={15} aria-hidden="true" />}
        <span>{statusCopy}</span>
      </div>
      <button
        type="button"
        onClick={onHistory}
        aria-expanded={historyExpanded}
        aria-controls={historyDrawerId}
      >
        <History size={15} aria-hidden="true" />
        <span>History</span>
        {historyCount > 0 && <b aria-label={`${historyCount} ${historyCount === 1 ? "entry" : "entries"}`}>{historyCount}</b>}
      </button>
      <button
        type="button"
        onClick={onManage}
        aria-expanded={manageExpanded}
        aria-controls={managePanelId}
      >
        <Settings2 size={15} aria-hidden="true" />
        <span>Manage</span>
      </button>
    </section>
  );
}

export type AgentHistoryDrawerProps = {
  open: boolean;
  entries: WorkspaceHistoryEntry[];
  onClose: () => void;
  id?: string;
};

export function AgentHistoryDrawer({ open, entries, onClose, id = "agent-history-drawer" }: AgentHistoryDrawerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleEscape);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return (
    <aside id={id} className="agent-history-drawer" aria-labelledby={titleId}>
      <header>
        <div><p className="eyebrow">Shared project record</p><h2 id={titleId}>Workspace history</h2></div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close workspace history"><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="agent-history-body">
        <WorkspaceHistoryList entries={entries} emptyMessage="No agent has committed a workspace change yet." />
      </div>
      <footer>{entries.length} {entries.length === 1 ? "change" : "changes"} · All Workspace changes share one undo history</footer>
    </aside>
  );
}
