# SemaFrame v0.5.0 — Runtime-aware Agent layout and DeepSeek Harness

SemaFrame v0.5.0 adds runtime-aware desktop layout, progressive Agent discovery,
and an integration with the official external DeepSeek Harness (DSH). Agents
and people continue to edit the same revision-controlled Workspace. The existing
modeling, precision, Reality, XR, history, and export capabilities remain available.

## What changes

- **Reason about the actual view.** An ephemeral `view_graph` reports the desktop
  viewport in CSS pixels, projected panel bounds, camera/canvas state, and
  app-owned toolbar regions. Current-view preflight and final-draft validation
  detect 2D overlap, clipping, and host obstruction. View epochs prevent stale
  screen assumptions from being silently committed. Canonical 2D layout and
  physical 3D collision remain separate domains.
- **Discover only the contracts needed.** The mandatory guide and exact type
  catalog are compact by default. The new `inspect_workspace_capabilities` tool
  returns selected full manifests, guidance topics, and canonical operation
  schemas. This reduces response payloads without weakening command validation
  or permissions; explicit full-reference modes remain available.
- **Connect official DSH without an embedded provider.** The packaged CLI can
  export a credential-free Cordis overlay or launch the installed DSH Web profile
  with a temporary overlay and the persistent SemaFrame MCP bridge. The
  connection screen can copy the same configuration. SemaFrame does not install
  DSH, edit its profile, store model keys, or approve Workspace access for it.
- **Recover clearly after approval.** A pending request retains its bounded
  2-minute deadline. First approval starts a separate 10-minute instruction
  handshake window; repeated approval cannot extend it. The UI distinguishes
  approval, waiting for the Agent, in-flight instruction reads, and expiry.
  Completed sessions are not disconnected by these setup deadlines.
- **Move assemblies and fit controls more reliably.** Existing-assembly
  preflight checks descendant colliders and reports parent-local/world frames,
  including transformed suggestions. Button content fits its allocated panel;
  new button 1.3.0 reserves a 44 px target without rewriting earlier manifests.
  REST/MCP forwarding, final routed effects, history replay, and process cleanup
  have additional regression coverage.

## Upgrade guidance for Agent clients

The default discovery response shape changes in this minor release. Clients
must not assume the initial instruction response or preparation contains every
component and operation schema.

1. Read `get_workspace_instructions` and retain its instruction digest. Read
   current Workspace state and the exact type/version/digest catalog.
2. Call `inspect_workspace_capabilities` for the needed contracts: up to four
   component type IDs, four guide topics, and eight operation names per request.
   Its 48,000-byte cap fails explicitly instead of truncating schemas; split
   oversized selections. Cache contracts only while the registry digest matches.
3. For a deliberate full reference, use instruction `detail: "full"` or
   inspection/preparation `capability_detail: "full"`.
4. For visible 2D placement, inspect a ready `view_graph`. Use current-view
   preflight and pass its exact `{view_id, view_epoch}` as `view_guard` to both
   the query and `begin_workspace_update`, with `layout_frame: "current_view"`.
   Submission retains the prepared guard automatically. After a stale-view
   rejection, re-inspect and reprepare rather than rewriting the epoch.

Explicit canonical-only authoring remains supported for headless or camera-first
work. It validates logical layout, not on-screen visibility. Settling, unavailable,
or stale view data is not a visual pass. Runtime view metadata is ephemeral and
does not enter project files or undo history.

Workspace Protocol remains 1.3 and project schema remains 1.4. Agent Guide is 3.4,
with 27 Workspace MCP tools plus 10 ephemeral host-control tools. Portable
manifest 1.0/1.1 behavior is unchanged. Existing component instances remain
pinned to their exact manifests; upgrading them remains an explicit operation.

## Verification evidence and limits

The merged implementation in PR #42 passed all CI checks on October 14,
including 272 test files with 2,205 passing tests and two existing conditional
skips under the existing two-worker configuration. Coverage thresholds were
unchanged. The checks also covered lint, type checking, desktop/XR builds,
packed CLI startup, Chrome Workspace/Agent/precision smoke, Windows XR tooling,
and CodeQL. An isolated local fixture used the real official DSH MCP plugin.
These are software acceptance results, not universal model or hardware claims.

A bounded real-model task using official macOS DSH 0.2.0-rc.2 and DeepSeek V4.1
Flash created a table, chair, and working 2D control, used runtime placement data,
and demonstrated geometry editing, undo/redo, and readback. The run recovered
from session/stale-view errors. Browser click/DOM checks were live; saved-state
reopen was checked with the production loader offline. This is one observed
task, not an autonomous success rate or a claim of error-free first calls. The
[dated DSH acceptance record](https://github.com/riseagain1/semaframe/blob/v0.5.0/docs/agents/deepseek-harness.md)
preserves the assisted earlier runs, subsequent fixes, and exact boundaries.

Windows DSH shutdown starts owned-tree termination while the root is alive. If
the root has already exited before cleanup is confirmed, the launcher reports
unverified cleanup and a nonzero status rather than targeting a potentially
reused PID. A real Windows DSH modeling session has not been accepted.

Runtime layout validation does not prove arbitrary embedded-content aesthetics,
swept-path collision safety, or universal Agent reliability. This release does
not add physical-accuracy certification, full mechanical CAD, GD&T, FEA, or
universal headset acceptance. Stable describes the distribution channel, not
those separate acceptance claims.

## Install and run

SemaFrame requires Node.js 22.12 or newer. Use the stable npm channel:

```sh
npm exec --yes --package=semaframe -- semaframe doctor
npm exec --yes --package=semaframe -- semaframe start
```

Pin this release for reproducible execution:

```sh
npm exec --yes --package=semaframe@0.5.0 -- semaframe doctor
npm exec --yes --package=semaframe@0.5.0 -- semaframe start
npm exec --yes --package=semaframe@0.5.0 -- semaframe agent launch --client dsh
```

`doctor` is non-mutating. The DSH command requires the official DSH runtime and
its provider configuration to be installed separately. The tested DSH runtime
requires Node `^22.19.0 || >=24.0.0`, which is stricter than SemaFrame's minimum.
Keep SemaFrame's authoritative browser open and approve the matching client
identity and intended scopes normally. The launcher uses DSH's Web profile, not
an already-open Desktop profile. The SemaFrame package remains a source CLI,
not a signed desktop installer.

See the [README](https://github.com/riseagain1/semaframe/blob/v0.5.0/README.md),
[changelog](https://github.com/riseagain1/semaframe/blob/v0.5.0/CHANGELOG.md),
[precision acceptance protocol](https://github.com/riseagain1/semaframe/blob/v0.5.0/docs/precision-acceptance.md),
and [hardware matrix](https://github.com/riseagain1/semaframe/blob/v0.5.0/docs/hardware-support.md).
[Compare v0.4.0 with v0.5.0](https://github.com/riseagain1/semaframe/compare/v0.4.0...v0.5.0).
