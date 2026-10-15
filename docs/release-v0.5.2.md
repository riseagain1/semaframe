# SemaFrame v0.5.2 — Portable saving and verified Agent handoff

SemaFrame v0.5.2 fixes browser-native portable-project saving and adds regression
and real-Agent evidence for saving a scene, reopening it, and handing the same
editable project to another approved Agent.

## What changes

- **Picker-safe portable filenames.** New exports use `.semaframe.zip` instead
  of `.semaframe-project`, whose extension filter is rejected by Chromium's
  native save picker. Existing files with the old suffix still import without
  renaming or conversion, and imported project names strip either full suffix.
- **Correct native-save lifecycle.** The picker opens directly from the user's
  action, before asynchronous bundle preparation, with the correct `Window`
  receiver. The archive is validated before a writable opens, streamed to disk,
  and considered saved only after the stream closes successfully.
- **Honest cancellation and errors.** Only native-picker cancellation is quiet.
  Preparation, open, read, write, and close failures remain visible. Stream
  cleanup preserves the original error, and a failed picker does not trigger
  an unsolicited fallback download. Browsers without a native picker keep the
  existing size-bounded download route.
- **Accurate unsaved state.** Changes to the Workspace or project metadata
  during export stay marked unsaved. Snapshot tracking also catches undo/redo
  and different edits that happen to reuse the saved revision number.

Workspace tools, protocols, approved scopes, and project schema are unchanged.
The archive format and media type are unchanged: manifest `1.0` remains valid
without measurement evidence, while retained measurement evidence uses `1.1`.
The peer Codex, Claude Code, and DSH connection experience from v0.5.1 remains.

## Verification and boundaries

Completed local source gates: **276 Vitest files / 2,272 tests**, **45 CLI tests**,
**23 XR launcher tests**, lint, and desktop/XR production builds including
TypeScript checks. These are local results; release CI and publication are
separate gates. Existing build warnings concern dependency `node:module`
externalization and large chunks.

A real Codex CLI session built a table, stool, and working 2D control. After a
small synthetic PLY import and native Chrome portable save/open, a fresh
DeepSeek V4.1 Flash session in DSH read the same **15 component IDs, one Reality
Asset, and one event connection**, then edited the existing tabletop from
1.4 m blue to 1.6 m orange. Undo and redo preserved the original and changed
values. The final packed-build close/reopen and native cancellation/retry also
passed. Independent imports into empty asset vaults verified exact asset bytes,
history replay, and offline undo/redo. DSH recovered one stale-view rejection
by refreshing its context; the run was not an error-free sequence of calls.

The regression suite separately covers historical asset closure, independent
Agent sessions, revoked old sessions and transactions, exact reopened state,
and re-export/replay. The
[full verification report](https://github.com/riseagain1/semaframe/blob/v0.5.2/docs/verification/portable-agent-handoff-2026-10-15.md)
records artifact sizes, SHA-256 digests, source gates, and original-project
preservation. Its `0.5.1` wording identifies the locally patched source used
for acceptance before the release version was advanced.

This is one bounded cross-Agent workflow, not proof that every Agent succeeds.
The eight-splat asset is a portability fixture, not an accuracy or large-scene
benchmark; its two uncalibrated-asset warnings were expected. This workflow
does not add physical Windows, Safari, or headset acceptance. Stable describes
the release channel, not engineering certification or a guarantee of zero bugs.

## Install and run

SemaFrame requires Node.js 22.12 or newer. Use the stable npm channel:

```sh
npm exec --yes --package=semaframe@latest -- semaframe doctor
npm exec --yes --package=semaframe@latest -- semaframe start
```

Pin this patch for reproducible execution:

```sh
npm exec --yes --package=semaframe@0.5.2 -- semaframe doctor
npm exec --yes --package=semaframe@0.5.2 -- semaframe start
npm exec --yes --package=semaframe@0.5.2 -- semaframe agent launch --client dsh
```

`doctor` is non-mutating. Install and configure the chosen Agent separately;
model-provider credentials remain in that Agent. The tested official DSH runtime
requires Node `^22.19.0 || >=24.0.0`, stricter than SemaFrame's minimum. Keep the
authoritative SemaFrame browser open and approve only the intended identity and
scopes. SemaFrame remains a source CLI package, not a signed desktop installer.

See the [README](https://github.com/riseagain1/semaframe/blob/v0.5.2/README.md),
[changelog](https://github.com/riseagain1/semaframe/blob/v0.5.2/CHANGELOG.md), and
[v0.5.1…v0.5.2 comparison](https://github.com/riseagain1/semaframe/compare/v0.5.1...v0.5.2).
