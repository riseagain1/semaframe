# Agent modeling guidance and automatic recovery acceptance

Date: 2026-10-15 (Asia/Shanghai). Tested local source based on `v0.5.2`, branch `codex/agent-modeling-recovery`. This is not a new npm release.

## Changes

- Agent Guide 3.5 distinguishes geometric bounds from padded collision bounds. Preflights expose effective collision configuration, actual collider bounds, and margin-only versus unpadded-collider penetration evidence. Both conflict kinds still block; collision rules were not weakened.
- Modeling instructions require a separate assembly root for each requested multipart whole, including objects resting on other assemblies. Agents must verify child IDs, counts and parents. Existing parts can be regrouped with world transforms preserved.
- Startup validates and replays the last local project before Agent polling or autosave starts. Normal refresh restores project identity, components, relationships and edit history without a manual Continue action. Explicit New/Open takes precedence over pending recovery.
- Recovery diagnostics distinguish absent data from corruption and unavailable storage. Unresolved failures centrally pause autosave with a persistent warning, preserving snapshots. Known hash-invalid records cannot evict the verified fallback during rotation. Failed clear/open operations do not release protection or poison subsequent retries.
- Recovery never restores persisted Agent credentials, grants, feed approvals or host-control consent. A browser refresh can reuse a still-approved gateway client after its fresh instruction handshake; explicit project Open revokes the old connection as before.

## Final automated gates

| Gate | Result |
| --- | --- |
| `npm test -- --maxWorkers=2` | 277 files, 2,310 tests passed |
| `npm run test:cli` | 45/45 passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build:all` | Desktop and XR builds passed |
| `git diff --check` | Passed |
| Independent final recovery review | 6 focused files, 83 tests passed; no blocking findings |

Existing build warnings concern large chunks and dependency `node:module` externalization. They are not failed builds. The browser smoke script's recovery expectations were updated, but that script was not executed in this run; real browser actions below were performed through the browser-control interface.

Relevant regressions cover default 0.02 m padding, explicit face contact at margin 0, real penetration remaining blocked, another object's nonzero margin, compound colliders, rotated/scaled assemblies, recovery cancellation, StrictMode, history replay, Reality references, inaccessible/corrupt storage, protected writes, fallback retention and clear retry.

## Fresh real DeepSeek run

An official DeepSeek Harness 0.2.0-rc.2 instance used the user's already configured DeepSeek V4.1 Flash model and the official SemaFrame stdio MCP adapter. The test workspace ran on separate loopback ports `4177` / `8791`; the original project stayed on `4173` / `8788`. No provider credentials or global Agent configuration were changed.

The fresh conversation received a study-corner task, not hand-written batches or corrections. It used SemaFrame tools to build:

- A blue desk with a 1.5 × 0.7 m tabletop, top surface at 0.78 m, and four wooden legs.
- A chair with seat, back and four legs.
- A tabletop lamp with exactly three separately editable parts: base, stem and shade.
- One assembly root per object: desk with five children, chair with six, lamp with three.
- A 2D button connected to the chair assembly's `move_to` action.

Result: **19 components, three assembly roots, 14 enabled solid colliders, one event connection, revision 2**. Explicit zero margins were used for intended face contact; all primitive collision/physics configurations stayed enabled. No collision or 2D overlap conflicts were reported under the configured policy.

Seven modeling scopes were approved without delete/clear, filesystem, host-action or external-write authority. DeepSeek encountered three preflight errors from using not-yet-created component IDs and one stale-view rejection, then recovered from tool feedback without operator modeling corrections. There were no rejected or partially applied modeling batches. This was a successful self-correcting run, not a zero-error Agent run.

## Persistence and continued editing

1. Downloaded the built scene through the real project menu, refreshed the browser, and did not click Open or Continue. The existing approved DeepSeek client completed a fresh instruction handshake and read back all 19 components at revision 2.
2. Exported the recovered scene. The complete project, including checkpoint, resolved command history, counters and workspace state, matched the pre-refresh export exactly after excluding only the export timestamp `updatedAt`.
3. Clicked the actual **Move chair away** button once. The chair assembly moved from `z=1.05` to `z=2.05`, its children followed, button press count became 1, and revision advanced to 3. The persisted causal events link the button press to the chair movement.
4. Saved and refreshed again. DeepSeek read back the event outcome, changed only the existing shade's `material.baseColor` to `#2A9D8F`, and verified revision 4. A real MCP undo restored `#F3E7CE` at revision 3; redo restored the new color at revision 4. Independent component comparison found only the intended material field changed. History `inputRevision` fields legitimately rebase during undo/redo.
5. Rebuilt the finalized source, refreshed again, and repeated DeepSeek read-only inspection. The complete exported project again matched the saved revision-4 project exactly, excluding only `updatedAt`.
6. Used the real file chooser to Open the saved project from disk. After normal fresh approval limited to `workspace:read`, DeepSeek verified the same IDs, assemblies, shade material, chair position, press count, connection and causal events. The exported reopened project again matched exactly. Two approval requests expired while the operator was collecting other evidence; a fresh matching fingerprint was approved successfully. No timeout or approval rule was bypassed.
7. Inspected the actual renderer: desk, chair, three-part lamp and button were present with no missing-part or loading placeholder. The lamp retains warm emission, so this is not a pixel-color calibration claim.

Production importer/serializer checks used empty in-memory asset/evidence vaults, replayed the full history and performed offline undo/redo followed by a second reopen. All snapshots passed. This particular scene has no Reality Assets; it does not retest large binary portability or reconstruction accuracy.

### Evidence identities

| Evidence | State digest | Artifact SHA-256 |
| --- | --- | --- |
| Fresh DeepSeek build | `fnv1a32:4381de19` | `b6d5a2dc027934b1696273e5d02d0ce285a801d0e92ea29bd68c74c34053d7e5` |
| Continued edit and redo | `fnv1a32:6a78240b` | `25eea7e2a9f112dbd3b8e932172974da36df74387d81cb47bcc2ed69997f185f` |
| Final automatic refresh | `fnv1a32:6a78240b` | `4b2a66ecec16d1e8ac4e0c83e894e8694ffcac4fd1586353b879fb3faf2aa494` |
| File reopened and re-exported | `fnv1a32:6a78240b` | `bb1865ae5c08254b11bfaa634e41094dc427a42fb691dc1b1112ce4f50d62966` |

Artifact byte hashes differ because their export timestamps differ; complete-project comparisons exclude only that root timestamp, not geometry, metadata, events or history.

## Original scene preservation and limits

The original scene was backed up first. After source updates and a final refresh, read-only MCP inspection and an independently checked export confirmed **19 components, revision 10, ten history entries and one event connection**. Its complete project matched the original backup excluding `updatedAt`; state digest remained `fnv1a32:a16b2789`. No modeling operations were sent to the original workspace.

This validates one fresh DeepSeek modeling workflow plus its continued edits and persistence, not every Agent, every task, calibrated physical accuracy or certified engineering feasibility. Physical headset/Windows acceptance and npm installation were not rerun for this source-only change. New-project precedence and corrupted-storage cases were covered by automated tests, not by damaging the user's browser storage. No PR, merge, npm publication, tag or Release was created in this turn.
