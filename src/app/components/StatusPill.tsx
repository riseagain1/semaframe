import { AlertCircle, Check, CircleDashed, Sparkles } from "lucide-react";
import type { WorkspaceHistoryStatus } from "../uiTypes";

const STATUS_COPY: Record<WorkspaceHistoryStatus, string> = {
  ready: "Ready",
  queued: "Queued",
  understanding: "Understanding",
  checking: "Checking",
  preparing_assets: "Preparing assets",
  applying: "Updating workspace",
  committed: "Updated",
  approximated: "Updated with a stand-in",
  ambiguous: "Needs more detail",
  failed: "Couldn’t apply",
  stale_retry: "Refreshing understanding",
  idempotent: "Already applied",
  undone: "Undone",
};

export function statusLabel(status: WorkspaceHistoryStatus): string {
  return STATUS_COPY[status];
}

export function StatusPill({ status, compact = false }: { status: WorkspaceHistoryStatus; compact?: boolean }) {
  const processing = ["queued", "understanding", "checking", "preparing_assets", "applying", "stale_retry"].includes(status);
  const warning = status === "approximated" || status === "ambiguous";
  const error = status === "failed";
  const Icon = processing ? CircleDashed : warning ? Sparkles : error ? AlertCircle : Check;
  return (
    <span className={`status-pill status-${status}${compact ? " is-compact" : ""}`}>
      <Icon size={compact ? 12 : 13} aria-hidden="true" className={processing ? "spin-slow" : ""} />
      <span>{STATUS_COPY[status]}</span>
    </span>
  );
}
