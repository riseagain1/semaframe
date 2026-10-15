# Portable project and cross-Agent handoff verification

Date: 2026-10-15 (Asia/Shanghai). This report covers locally patched SemaFrame `0.5.1` source, not a newly published npm release.

## Scope and fixes

The reported browser save failure was reproduced: `.semaframe-project` is not a valid extension filter for the native Chromium save picker. Current exports use `.semaframe.zip`; existing `.semaframe-project` files still import without renaming or conversion. The archive format and media type are unchanged. Manifest `1.0` remains valid without measurement evidence; retained measurement evidence uses `1.1`.

The browser save path now:

- Opens the native picker directly from the user's action, on its `Window` receiver, before asynchronous archive preparation.
- Validates the bundle before opening a writable, streams bytes, and reports success only after the stream closes successfully.
- Treats only native-picker cancellation as a quiet cancellation. Preparation, open, read, write, and close failures remain visible; failed streams cancel/abort without masking the original error.
- Does not silently fall back to a download after a native-picker failure. Browsers without that picker retain a size-bounded download path.
- Tracks the saved snapshot so concurrent edits, project changes, and undo/redo cannot incorrectly mark newer state as saved.

Implementation: [browser save helper](../../src/app/portableProjectSave.ts), [App integration](../../src/app/App.tsx), and [portable constants](../../src/workspace/persistence/portable/constants.ts). Format details: [Portable projects](../ecosystem/portable-projects.md).

## Automated source gates

These results are from the finalized source after the export error-handling changes, not the earlier intermediate test run.

| Gate | Result |
| --- | --- |
| `npm test -- --maxWorkers=2` | 276 files, 2,272 tests passed; no failures |
| `npm run lint` | Passed |
| `npm run test:cli` | 45/45 passed |
| `npm run test:xr:launcher` | 23/23 passed |
| `npm run build:all` | Desktop and XR production builds passed, including TypeScript checks |
| Documentation checks | 48 relative links/anchors valid; `git diff --check` passed |

Build warnings remain for dependency `node:module` externalization and chunks larger than 500 kB. These were warnings, not failed builds or proof of runtime failure.

[Portable save tests](../../src/tests/app/PortableProjectSave.test.ts) cover picker timing, receiver binding, cancellation, streaming and close failures, bounded fallback, and snapshot freshness. [Independent Agent handoff coverage](../../src/tests/workspace-portable/PortableAgentHandoff.test.ts) uses production controllers, serializers, and vaults: export with actual current/history-only asset bytes, import into an empty vault, revoke the old session, reject its old transaction in the new session, read the same IDs/state, edit, undo/redo, and export/reopen again with replay verification.

## Real browser and Agent acceptance

The patched source was packed and installed with an isolated npm cache and production dependencies. The acceptance server used separate loopback ports `4175` / `8789`, leaving the user's project on its original origin.

1. **Codex created the scene through MCP.** A real Codex CLI session modeled a table, stool, and **Move stool** button: 14 components. Invoking the button through the browser moved the stool from `z=1.05` to `z=1.65`.
2. **A real asset was added through the UI.** Importing a synthetic 654-byte, eight-splat PLY produced 15 components at revision 5, with one Reality Asset and one event connection.
3. **Native portable save and open succeeded.** Chrome's genuine system save picker wrote the first `.semaframe.zip`; the actual file chooser reopened it.
4. **DeepSeek independently took over.** A fresh DeepSeek V4.1 Flash session in DSH completed an actual MCP handshake with the same seven modeling scopes, without delete/clear permission. It read back the reopened 15 components, one event connection, and one Reality Asset.
5. **DeepSeek edited existing objects.** One batch changed the tabletop width from `1.4` to `1.6`, its blue `#246BCE` material to orange `#F28C28`, its label, and the assembly description, advancing revision 5 to 6. No duplicate reconstruction was used.
6. **History survived the handoff.** Undo returned to revision 5 and readback confirmed the original values; redo returned to revision 6 and readback confirmed the new values. All component IDs, the stool at `z=1.65`, and the button's press count of `1` were preserved. DSH encountered one `stale_view_context` rejection, refreshed its context, and recovered successfully.
7. **The edited scene was saved natively again.** Both exported files passed independent production-importer validation into empty `MemoryAssetVault` instances, exact PLY byte-digest comparison, history replay, and offline undo/redo.
8. **Final-package close/reopen passed.** The test tab was closed, the finalized source was repacked and installed, and the isolated server was restarted. A new Chrome tab opened the saved `.semaframe.zip` through the real file chooser. After normal reapproval, DeepSeek read back revision 6, all 15 original IDs, the 1.6 m orange tabletop, the stool at `z=1.65`, one Reality Asset, one event connection, and button press count `1`. The project title had no leftover archive suffix.
9. **Native cancellation and final save passed.** A project-name edit made the workspace dirty. Cancelling the real system save dialog created no file and retained the unsaved marker. Retrying and accepting the dialog saved the final artifact below and cleared that marker. This final archive again imported into an empty vault with exact asset bytes, valid replay, and successful undo/redo.

Codex CLI write approvals were limited to the three requested MCP tools (submit,
undo, redo) for this isolated run. The shell sandbox stayed read-only; no global
Agent configuration or model-provider credentials were changed.

### Artifact integrity

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Before DeepSeek handoff | 81,708 | `e789aba2b62a1cfc0c0495e8c1c5e1f7c9df368637e9c23466ec9a578360ccc2` |
| After DeepSeek edit and redo | 84,237 | `692c5ed740b2e696a8c95eb3fa284afbb2519cf315eb7fe19b7b72f8c973be1a` |
| Final package native save after reopen | 84,237 | `9769dcfaa88e5e1d7eeea39912186d40108686c846ba57be29422ca8d1c730e8` |
| PLY asset preserved by both archives | 654 | `34feacf79e3b46ac56b6e7fd16c120a9c9d2dcd4db7330494f8c4ba4201369f4` |

## Original project preservation

Source hot reload reset the original browser runtime on port `4173`. **Continue recovered project** restored its revision 7, 15 components, one event connection, and zero Reality Assets. Read-only MCP inspection was compared against the pre-test backup: all 15 component IDs, labels, type references, geometry/material/physics properties, placements, parents, durable states, bindings, tags, visibility, locks, and visual effects matched exactly. The handoff modeling and asset tests ran in the separate acceptance workspace.

## Boundaries

- This demonstrates one real Codex-to-DeepSeek workflow, not reliable operation by every Agent or every model.
- The eight-splat asset is a small synthetic portability fixture, not evidence of photogrammetry accuracy, calibrated dimensions, or large-scene performance. The two expected uncalibrated-asset warnings were not import/save errors.
- No physical Windows/Safari or headset acceptance was performed in this workflow. Automated XR launcher tests and an XR build are not physical-device validation.
- No PR, npm publication, tag, or GitHub Release was created as part of this verification turn. Authentication/session tokens and private local paths are intentionally omitted.
