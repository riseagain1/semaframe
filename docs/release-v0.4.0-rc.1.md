# SemaFrame v0.4.0-rc.1 — Product hardening release candidate

SemaFrame v0.4.0-rc.1 turns the existing modeling, Reality, data, Agent, and XR
capabilities into a more dependable product surface. The underlying authority
model is unchanged: one revisioned `WorkspaceStore` remains the source of truth
for human edits, Agent transactions, rendering, history, recovery, and export.

This release candidate focuses on making that power understandable, recoverable,
installable, and continuously verifiable.

## Product experience

- **Explicit Agent connection states.** Boot, unavailable, waiting, approval,
  approved, disconnected, and error states now have bounded, human-readable
  guidance. Raw capabilities and sensitive gateway details are not echoed into
  generic UI errors.
- **Start Center and Checks.** A true empty project offers clear starting paths,
  while one Checks surface combines collision, physics, binding, source, and
  Reality readiness with navigation back to the affected component or tool.
- **Basic and Advanced Inspector.** Common transforms, dimensions, materials,
  CAD parameters, collision, and physics stay approachable. Manifests, feature
  history, compound colliders, mates, constraints, and raw state remain
  available without losing hidden configuration when Basic edits are made.
- **Sources Wizard.** Local JSON/CSV and approved public HTTPS feeds use one
  choose/configure/preview/destination flow with freshness, provenance, and
  citation evidence. A new Data Panel, Chart, or Table plus its resource and
  bindings is committed as one revision and undone once—never as partial UI
  side effects.
- **Export Center.** OpenUSD, editable CAD handoff, STEP, OBJ, and STL are grouped
  by intended downstream use with honest preparation/readiness, unavailable
  reasons, indeterminate busy state, and success or failure feedback.
- **XR Setup Assistant.** Same-device WebXR, Quest/remote-headset mode, and
  Windows Ultra are separated into guided paths while preserving trusted user
  gestures, single-use pairing, and fail-closed hardware qualification. Voice
  Relay remains optional and off by default; a voice-capable Agent may use the
  computer microphone directly.

## Reliability and recovery

- Workspace recovery moves to digest-verified IndexedDB records with atomic
  `current`/`previous` rotation and a localStorage fallback.
- Recovery writes are serialized and coalesced. Project replacement creates a
  hard generation boundary, so a late write from the previous project cannot
  resurrect it.
- A corrupt current record falls back to a verified previous record. Legacy
  recovery is removed only after verified migration, and reset/dismiss does not
  claim success if either recovery store failed to clear.
- Agent/project/XR replacement helpers are isolated from the top-level App and
  directly regression-tested.

## Install and diagnose

The repository now ships a source-distributed CLI:

```bash
npm exec --yes --package=github:riseagain1/semaframe -- semaframe doctor
npm exec --yes --package=github:riseagain1/semaframe -- semaframe start
npm exec --yes --package=github:riseagain1/semaframe -- semaframe xr
npm exec --yes --package=github:riseagain1/semaframe -- semaframe agent install --client codex
```

`doctor` is non-mutating. It validates the Node floor, package completeness, and
required ports; XR and Voice Relay limitations are warnings unless they block
the requested mode. Codex and Claude Code onboarding is also available in the
Agent connection screen, with status, update, and removal actions. It installs
one stable loopback-discovery launcher through the client's official CLI, then
survives Gateway restarts and MCP tool-list changes without rewriting the
client configuration. Fresh Gateway lifetimes still require fresh human
approval, and ambiguous failed mutations are never replayed automatically.

The packaged-install test creates a tarball, installs only production
dependencies in a clean temporary directory, invokes the npm bin, starts the
installed stdio bridge, starts the Workspace, gateway, and XR origins, checks
all three over HTTP, and tears them down.

See the [hardware and runtime support matrix](./hardware-support.md) before
making a physical-device or production claim.

## Verification gates

- ESLint flat config with ratcheted existing Hook suppressions; new violations
  fail the build.
- V8 coverage thresholds for protocol, persistence, state, security, Agent,
  feed, and XR authority modules.
- Separate real-Chrome Workspace and Agent smoke job in CI.
- Windows XR launcher, native Voice Relay build, and XR production build job.
- Deterministic 100, 500, and 2,000-component benchmark with persistence digest
  round-trip and render/scene projection verification. Machine timings are
  reported as evidence, not enforced before CI runner history exists.
- Packaged production-dependency-only CLI and three-service launch smoke.

## Compatibility and boundaries

This release candidate does not advance the Workspace command protocol, project
schema, SemaFrame Spatial Graph, MCP, or OpenAPI solely for these product
surfaces. Existing public authority and permission boundaries remain in force.

It also does not turn bounded physics into FEA, Gaussian splats into metrology,
WebXR interface coverage into universal headset certification, or a successful
CAD re-import into certification for every downstream kernel. Those boundaries
remain explicit in the Workspace, Checks, exports, README, and hardware matrix.
