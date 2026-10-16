# SemaFrame v0.5.4 — Reliable Agent sessions and verified handoff

This patch fixes connection, parameter and concurrency failures encountered in
real DeepSeek and Codex modeling workflows.

## What changes

- **Handshake continuation.** The official stdio adapter retains pending approval
  proof in memory for the matching session, gateway, offer, client and scopes.
  An Agent can omit `approval_token` on a matching subsequent instruction request;
  the approved client identity remains stable and successful handshakes obtain
  fresh core sessions. Changed identity/scopes or invalidated offers do not inherit
  authority. Human approval is still required and credentials are not saved in projects.
- **Precise parameter contracts.** Update-only transactions can request zero new
  component IDs consistently through MCP, REST and the core. Canonical spatial
  placement and full-size collider examples help Agents form valid requests
  without weakening schema or collision checks.
- **Bounded concurrency.** Normal overlapping requests enter a FIFO queue instead
  of immediately failing with `engine_busy`. Authorization and deadlines are checked
  before delivery; revocation and connection changes invalidate waiting work.
  Queue overflow and unknown delivered-command outcomes remain explicit failures.
- **Safer browser recovery.** Only native failures of the configuration GET receive
  bounded retries. Known owned leases are released after setup failure, late
  registration cannot reactivate a stopped client, and failed acknowledgements
  cannot trigger a contradictory second result. Writes are never replayed automatically.

Workspace Protocol 1.3, project schema 1.4 and permission scopes remain unchanged.
Refresh can reuse a still-approved client after a fresh instruction handshake;
explicit project Open or a gateway restart still requires normal approval.

## Verification and boundaries

Local final gates passed: **280 Vitest files / 2,385 tests**, **45 CLI tests**,
**23 XR launcher tests**, TypeScript, lint, and desktop/XR production builds.
Release CI, fresh-package verification and registry publication are separate gates.

The real acceptance flow used a separate copy of the user's scene:

1. DeepSeek widened a tabletop and built an editable three-part notebook with its
   own assembly root, producing 23 components and preserving the existing interaction.
2. Chrome refresh and saved-project reopen preserved the scene and resolved history.
3. A real Codex CLI session issued three overlapping reads, requested zero new IDs,
   changed only the notebook cover color, and performed actual undo/redo.
4. The final portable ZIP was saved, reopened through the browser file chooser,
   and read back by DeepSeek with only `workspace:read`. Six artifacts passed
   independent production-importer and history-replay checks.

DeepSeek required one geometry correction and a human reminder. This proves this
bounded workflow, not universal Agent reliability or error-free model reasoning.
The [acceptance report](https://github.com/riseagain1/semaframe/blob/v0.5.4/docs/verification/agent-session-resilience-2026-10-16.md)
records the exact checks, history-rebase investigation and evidence identities.
Its source-snapshot wording describes the acceptance run before release preparation.
Collider checks remain proxies, not engineering certification. No new physical
headset, Windows-device or photogrammetry-accuracy acceptance is claimed. Existing
build warnings concern large chunks and dependency `node:module` externalization.

## Install and run

Requires Node.js 22.12 or newer:

```sh
npm exec --yes --package=semaframe@latest -- semaframe doctor
npm exec --yes --package=semaframe@latest -- semaframe start
```

Pin this patch for reproducibility:

```sh
npm exec --yes --package=semaframe@0.5.4 -- semaframe doctor
npm exec --yes --package=semaframe@0.5.4 -- semaframe start
npm exec --yes --package=semaframe@0.5.4 -- semaframe agent launch --client dsh
```

Configure the chosen Agent separately; provider credentials stay in that Agent.
The tested DSH runtime requires Node `^22.19.0 || >=24.0.0`. Existing managed Agent
registrations may need their normal update command when installation paths change.
SemaFrame is a source CLI package, not a signed desktop installer. Stable denotes
the release channel, not zero bugs or universal hardware acceptance.

See the [README](https://github.com/riseagain1/semaframe/blob/v0.5.4/README.md),
[changelog](https://github.com/riseagain1/semaframe/blob/v0.5.4/CHANGELOG.md), and
[v0.5.3…v0.5.4 comparison](https://github.com/riseagain1/semaframe/compare/v0.5.3...v0.5.4).
