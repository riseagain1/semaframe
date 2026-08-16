export type WorkspaceHistoryStatus =
  | "ready"
  | "queued"
  | "understanding"
  | "checking"
  | "preparing_assets"
  | "applying"
  | "committed"
  | "approximated"
  | "ambiguous"
  | "failed"
  | "stale_retry"
  | "idempotent"
  | "undone";

export type WorkspaceHistoryEntry = {
  id: string;
  inputRevision: number;
  text: string;
  status: WorkspaceHistoryStatus;
  source?: "manual" | "agent";
  clientName?: string;
  summary?: string;
  detail?: string;
  traceId?: string;
};

export type AppNotice = {
  id: string;
  tone: "neutral" | "success" | "warning" | "error";
  message: string;
};
