import { verifyWorkspaceProjectCadEvidence } from "../../workspace/persistence";
import type { WorkspaceProjectFile, WorkspaceProjectSerializer } from "../../workspace/persistence";
import type { WorkspaceStore } from "../../workspace/state";
import type { WorkspaceRecoveryCoordinator } from "./WorkspaceRecoveryCoordinator";
import { inspectWorkspaceRecoveryRepository, legacyWorkspaceRecoverySnapshot, type WorkspaceRecoveryReadResult } from "./WorkspaceRecoveryRepository";

export type WorkspaceStartupRecoveryResult =
  | Readonly<{ status: "restored"; recoveredFromPrevious: boolean; writeProtection?: string }>
  | Readonly<{ status: "empty" | "cancelled" }>
  | Readonly<{ status: "unavailable" | "invalid"; error: unknown }>;

/**
 * Startup only restores project data, never Agent grants or connection tokens.
 * Reads are intentionally non-destructive: a corrupt head must not destroy a
 * valid fallback, and a storage outage must not clear the user's recovery.
 * The caller's synchronous commit is guarded after every asynchronous boundary
 * so an unmount, StrictMode replay, or explicit New/Open always wins.
 */
export async function restoreWorkspaceOnStartup(options: Readonly<{
  coordinator?: Pick<WorkspaceRecoveryCoordinator, "readCandidates"> & Partial<Pick<WorkspaceRecoveryCoordinator, "inspectStartupRecovery">>;
  serializer: WorkspaceProjectSerializer;
  legacy?: string | null;
  isCurrent(): boolean;
  commit(project: WorkspaceProjectFile, store: WorkspaceStore, recovery: WorkspaceRecoveryReadResult): void;
  verifyProject?: (project: WorkspaceProjectFile) => Promise<void>;
}>): Promise<WorkspaceStartupRecoveryResult> {
  if (!options.isCurrent()) return { status: "cancelled" };
  const inspection = options.coordinator
    ? await inspectWorkspaceRecoveryRepository(options.coordinator)
    : { candidates: [], issues: [{ kind: "unavailable" as const, message: "Browser recovery storage is unavailable." }] };
  let candidates: readonly WorkspaceRecoveryReadResult[] = inspection.candidates;
  if (!options.isCurrent()) return { status: "cancelled" };
  // Read legacy data without migrating/writing during startup. Otherwise a
  // slow migration could overwrite a concurrent explicit New/Open operation.
  const legacy = options.legacy ? legacyWorkspaceRecoverySnapshot(options.legacy) : undefined;
  if (legacy && !candidates.some(({ snapshot }) => snapshot.serializedProject === legacy.serializedProject)) {
    candidates = [...candidates, { snapshot: legacy, source: "previous", recoveredFromPrevious: true }];
  }
  if (candidates.length === 0) {
    const unavailable = inspection.issues.some((issue) => issue.kind === "unavailable");
    const invalid = inspection.issues.some((issue) => issue.kind === "invalid") || Boolean(options.legacy && !legacy);
    return unavailable || invalid
      ? { status: unavailable ? "unavailable" : "invalid", error: new Error(
        inspection.issues.map((issue) => issue.message).join(" ") || "Legacy browser recovery data is invalid.",
      ) }
      : { status: "empty" };
  }
  let lastError: unknown;
  for (const candidate of candidates) {
    let project: WorkspaceProjectFile;
    let store: WorkspaceStore;
    try {
      project = options.serializer.deserialize(candidate.snapshot.serializedProject);
      await (options.verifyProject ?? verifyWorkspaceProjectCadEvidence)(project);
      if (!options.isCurrent()) return { status: "cancelled" };
      store = options.serializer.openStore(project);
    } catch (error) {
      if (!options.isCurrent()) return { status: "cancelled" };
      lastError = error;
      continue;
    }
    // There is no await between this guard and replacing the live store.
    if (!options.isCurrent()) return { status: "cancelled" };
    options.commit(project, store, candidate);
    const unresolved = inspection.issues.some((issue) => issue.kind === "unavailable") || lastError !== undefined;
    return {
      status: "restored", recoveredFromPrevious: candidate.recoveredFromPrevious,
      ...(unresolved ? { writeProtection: "A recovery source is unreadable or could not be replayed. Existing snapshots are protected until you explicitly open or start a project." } : {}),
    };
  }
  return { status: "invalid", error: lastError ?? new Error("No valid Workspace recovery snapshot was found.") };
}
