/**
 * Hard application limits. These are aligned with what the browser renderer,
 * validator, persistence layer, and undo model can handle without unbounded
 * main-thread work or memory growth.
 */
export const MAX_WORKSPACE_COMPONENTS = 2_000;
export const MAX_WORKSPACE_RESOURCES = 1_000;
export const MAX_WORKSPACE_CONNECTIONS = 5_000;
export const MAX_WORKSPACE_ALIASES = 4_000;
export const MAX_WORKSPACE_SHARED_VIEWS = 500;
export const MAX_WORKSPACE_RECIPES = 200;
export const MAX_WORKSPACE_MODEL_DEFINITIONS = 200;
export const MAX_WORKSPACE_HISTORY_SUMMARIES = 512;

/** Recent commands remain undoable; older commands are folded into checkpoint. */
export const MAX_WORKSPACE_UNDO_ENTRIES = 64;
export const MAX_WORKSPACE_IDEMPOTENCY_ENTRIES = 4_096;

/** Maximum UTF-8 size accepted by the project reader/writer. */
export const MAX_WORKSPACE_PROJECT_BYTES = 25 * 1024 * 1024;
