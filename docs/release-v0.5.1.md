# SemaFrame v0.5.1 — One connection experience for every Agent

SemaFrame v0.5.1 is a setup UI and documentation patch. Codex, Claude Code, and
DeepSeek Harness now appear as peers under **Connect your Agent**, rather than
giving DSH a separate "External Agent" category. All three are Agent clients
connecting to the same SemaFrame Workspace.

## What changes

- **One client chooser.** Each client has independently expandable, keyboard-
  operable setup details. The three choices remain visible when managed
  registration status is loading or unavailable.
- **Accurate client-specific steps.** Codex and Claude Code keep their official
  MCP CLI registration actions. DSH keeps its Web-profile launcher and
  credential-free Cordis overlay copy action. The setup mechanisms differ;
  choosing a client does not change its access level.
- **One shared approval explanation.** Model/provider configuration stays in
  the chosen Agent. SemaFrame still requires the intended client identity,
  instruction handshake, and approved scopes. Expanding setup details does not
  launch a client, copy its configuration, or approve access.
- **Matching documentation.** The README presents all three clients together
  and retains the earlier `#first-agent-connection` anchor for existing links.

## Compatibility and verification boundaries

Workspace tools, API and protocol contracts, project schema, and authorization
behavior are unchanged from v0.5.0. Existing client registrations, DSH overlays,
and saved projects do not need migration for this patch. Runtime-aware layout,
progressive discovery, and the DSH integration remain the capabilities introduced
in [v0.5.0](https://github.com/riseagain1/semaframe/blob/v0.5.1/docs/release-v0.5.0.md).

The chooser implementation was checked with 446 related tests, type checking,
lint, and a production build. Real Chrome checks covered desktop layout,
390 px and 320 px narrow viewports, and keyboard disclosure operation. These
are UI and regression checks, not a new model-performance benchmark or a claim
that every Agent completes every task reliably. Historical DSH modeling
acceptance and its limitations remain in the
[DSH guide](https://github.com/riseagain1/semaframe/blob/v0.5.1/docs/agents/deepseek-harness.md).

This patch does not add modeling, engineering certification, or headset
acceptance. Stable describes the release channel, not a guarantee of zero bugs.

## Install and run

SemaFrame requires Node.js 22.12 or newer. Use the stable npm channel:

```sh
npm exec --yes --package=semaframe@latest -- semaframe doctor
npm exec --yes --package=semaframe@latest -- semaframe start
```

Pin this patch for reproducible execution:

```sh
npm exec --yes --package=semaframe@0.5.1 -- semaframe doctor
npm exec --yes --package=semaframe@0.5.1 -- semaframe start
npm exec --yes --package=semaframe@0.5.1 -- semaframe agent launch --client dsh
```

`doctor` is non-mutating. Install and configure the chosen Agent separately.
The tested official DSH runtime requires Node `^22.19.0 || >=24.0.0`, which is
stricter than SemaFrame's minimum. Its launcher starts the Web profile with a
temporary overlay, not an already-open Desktop profile, and does not change
the existing DSH configuration. Keep the authoritative SemaFrame browser open
and approve only the intended identity and scopes. SemaFrame remains a source
CLI package, not a signed desktop installer.

See the [README](https://github.com/riseagain1/semaframe/blob/v0.5.1/README.md),
[changelog](https://github.com/riseagain1/semaframe/blob/v0.5.1/CHANGELOG.md), and
[v0.5.0…v0.5.1 comparison](https://github.com/riseagain1/semaframe/compare/v0.5.0...v0.5.1).
