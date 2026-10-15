# SemaFrame v0.5.3 — Agent modeling guidance and automatic scene recovery

This patch improves how Agents reason about collision clearance and multipart
models, and makes refreshing the browser restore the last local scene automatically.

## What changes

- **Clear collision evidence.** Spatial and stable-placement preflights report
  effective collision settings and actual padded collider bounds. Margin-only
  overlap is distinguished from unpadded-collider penetration; both remain
  blocking. Instructions explain the default 0.02 m margin and consistent,
  explicit zero-margin solid contact where appropriate.
- **Complete editable groups.** Agent Guide 3.5 requires a separate assembly
  root for every requested multipart object, including a lamp on a table, and
  checks child IDs, counts and parents. Regrouping existing parts preserves world
  transforms. DSH documentation and the packaged Agent skill match this guidance.
- **Automatic recovery.** On refresh, SemaFrame validates and replays the last
  local Workspace before Agent polling or autosave starts, retaining project
  identity, components, relationships and edit history. No manual Continue action
  is needed for a valid snapshot; explicit New/Open wins over a pending restore.
- **Safer failure handling.** Corrupt or inaccessible storage is not treated as
  an empty first launch. Unresolved recovery pauses autosave with a persistent
  warning and preserves snapshots. Verified fallbacks survive rotation, failed
  clears can be retried, and failed replacements do not release protection or
  falsely report inaccessible data as cleared.

Project schema 1.4, Workspace Protocol 1.3 and existing permission scopes remain
unchanged. Recovery does not restore saved Agent credentials, grants, feed
approvals or host-control consent. A still-approved gateway client needs a fresh
instruction handshake after browser refresh; explicit project Open still revokes
the old connection. Local recovery is not a portable backup.

## Verification and boundaries

Local final gates passed: **277 Vitest files / 2,310 tests**, **45 CLI tests**,
TypeScript, lint, and desktop/XR production builds. Independent recovery review
passed 83 focused tests. Release CI and registry publication are separate gates.

A fresh real DeepSeek V4.1 Flash session created a desk, chair, three-part lamp
and linked 2D button: **19 components and three assembly roots**. It used the
ordinary MCP tools and seven modeling scopes without delete/clear or host access.
It self-corrected three invalid preflight IDs and one stale-view rejection without
operator modeling corrections. Real button activation, continued editing,
undo/redo, repeated automatic refresh recovery, and disk save/reopen all passed.
Complete saved-project comparisons excluded only the export timestamp. The
original user's scene was independently verified unchanged.

The [acceptance report](https://github.com/riseagain1/semaframe/blob/v0.5.3/docs/verification/agent-modeling-recovery-2026-10-15.md)
records source checks, artifact identities and limitations. Its source-only
wording describes the acceptance run before this release was prepared. This is
one successful self-correcting workflow, not proof every Agent or task succeeds.
Collider tests remain conservative OBB proxies; static physics is not engineering
certification. This run adds no physical-headset acceptance or photogrammetry
accuracy claim. Existing build warnings concern large chunks and dependency
`node:module` externalization.

## Install and run

Requires Node.js 22.12 or newer:

```sh
npm exec --yes --package=semaframe@latest -- semaframe doctor
npm exec --yes --package=semaframe@latest -- semaframe start
```

Pin the patch for reproducibility:

```sh
npm exec --yes --package=semaframe@0.5.3 -- semaframe doctor
npm exec --yes --package=semaframe@0.5.3 -- semaframe start
npm exec --yes --package=semaframe@0.5.3 -- semaframe agent launch --client dsh
```

Configure the chosen Agent separately; model-provider credentials stay in that
Agent. The tested DSH runtime requires Node `^22.19.0 || >=24.0.0`. SemaFrame is
a source CLI package, not a signed desktop installer. Stable denotes the release
channel, not zero bugs or universal hardware acceptance.

See the [README](https://github.com/riseagain1/semaframe/blob/v0.5.3/README.md),
[changelog](https://github.com/riseagain1/semaframe/blob/v0.5.3/CHANGELOG.md), and
[v0.5.2…v0.5.3 comparison](https://github.com/riseagain1/semaframe/compare/v0.5.2...v0.5.3).
