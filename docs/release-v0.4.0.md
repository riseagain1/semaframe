# SemaFrame v0.4.0 — Agent-native spatial modeling and validation

SemaFrame v0.4.0 is the stable release of the v0.4 Workspace, modeling, Reality,
XR, and ecosystem capabilities. An approved Agent and a person work on the same
editable, revision-controlled scene, with shared validation, undo/redo, recovery,
and export.

This promotion changes release metadata and distribution channels from
`v0.4.0-rc.3`; it does not introduce a new modeling algorithm or change the
precision workflow's behavior. npm `latest` and GitHub Latest now identify this
stable release. Stability of the software release is not certification of a
physical model, downstream application, or headset.

## What is included

- **Agent-first shared Workspace.** Direct entry after approval and the
  instruction handshake, a reusable MCP launcher, prepared atomic edits, and
  explicit permission boundaries. Human editing uses the same authoritative
  Workspace state; an Agent does not need to automate the application's UI.
- **Independent 2D and 3D reasoning.** The Layout Graph describes 2D occupancy
  independently of the Spatial Graph and physical 3D collision. Panels may
  overlay 3D content without mixing the two collision domains. Approved data
  snapshots and typed events connect 2D controls to scene behavior.
- **Editable modeling and CAD handoff.** Parametric OCCT B-rep parts, bounded
  sketch constraints and feature history, human Inspector editing, reusable
  models, and assembly-aware STEP/OpenUSD/GLB handoff. Export evidence and
  limitations remain inspectable rather than being replaced by a success label.
- **Reality and measurement-driven validation.** Photo-set reconstruction can
  retain native mesh, material, and texture evidence alongside visual Reality
  assets. Approved OBJ/PLY/XYZ measurement import, metric registration, separate
  fit controls and held-out checks, declared tolerances and uncertainty, geometric
  fitting, editable CAD proposals, and host-evaluated scan-to-CAD comparison form
  a traceable workflow.
- **An XR view of the same scene.** A separately paired WebXR renderer presents
  revisioned updates, live panels, interaction state, spatial pins, and
  collision-checked teleport. Agent-readable pose and controller evidence has
  freshness and tracking-quality metadata. Voice Relay is optional; the Windows
  PCVR Ultra path remains gated by configuration checks.
- **Portable projects and bounded bridges.** Portable bundles preserve scene
  state and required asset/evidence bytes through retained history. Scene Exchange
  carries sanitized semantics, stable IDs, and a fidelity report. Blender,
  FreeCAD, Unity, and Unreal reference bridges can return review-only proposals;
  they cannot bypass Workspace transactions. Extension, provider, and template
  contracts remain bounded integration primitives, not a turnkey marketplace.

## Verification and compatibility

Release gates cover dependency auditing, type checking, lint, unit/integration
coverage, real-Chrome Workspace and precision smoke, isolated packed CLI startup,
desktop/XR builds, modeling and Reality runtimes, ecosystem contracts, and Windows
XR tooling. The dependency security updates and additional boundary regressions
from rc.3 remain included without lowering the existing coverage thresholds.

Workspace Protocol remains 1.3 and project schema remains 1.4, with 26 Workspace
MCP tools plus 10 ephemeral host-control tools. Portable bundles containing
precision evidence use manifest 1.1; this reader accepts 1.0 and 1.1, and bundles
without that evidence retain 1.0. Older readers may reject 1.1 explicitly.

## Important boundaries

- Measurement import is bounded to 16 MiB, 25,000 vertices, and 50,000 triangles;
  retained native capture bundles are bounded to 256 MiB. Existing transaction,
  project, and comparison budgets still apply.
- Precision reports concern declared independent observations and supplied
  uncertainty bounds. Hashes establish byte integrity, not measurement truth or
  instrument calibration. Scan-to-CAD comparison uses bounded bidirectional
  sampled-vertex-to-surface evidence, not a continuous whole-surface error proof;
  the CAD target and its ancestors must currently have identity placement.
- Synthetic tests and OCCT STEP round trips establish software behavior and
  numerical transfer, not achieved physical accuracy. No independently measured
  physical-object validation campaign has been completed. This is not a claim
  of field-validated millimetre reconstruction, arbitrary photo-to-CAD conversion,
  full mechanical CAD, GD&T, FEA, or manufacturing certification.
- XR builds and automated tests do not certify every headset, browser, controller,
  runtime, or GPU. Reference bridge checks do not establish every downstream
  application's real-world round-trip behavior. Platform-specific reconstruction
  and optional native services retain their documented requirements.

Read the [precision acceptance protocol](https://github.com/riseagain1/semaframe/blob/v0.4.0/docs/precision-acceptance.md),
[hardware support matrix](https://github.com/riseagain1/semaframe/blob/v0.4.0/docs/hardware-support.md),
and [bridge compatibility matrix](https://github.com/riseagain1/semaframe/blob/v0.4.0/docs/bridges/compatibility.md)
before relying on these workflows for a particular application.

## Install and run

Node.js 22.12 or newer is required. Download and run the default stable package:

```bash
npm exec --yes --package=semaframe -- semaframe doctor
npm exec --yes --package=semaframe -- semaframe start
```

For reproducible installation and execution, pin this release:

```bash
npm exec --yes --package=semaframe@0.4.0 -- semaframe doctor
npm exec --yes --package=semaframe@0.4.0 -- semaframe start
npm exec --yes --package=semaframe@0.4.0 -- semaframe xr
npm exec --yes --package=semaframe@0.4.0 -- semaframe agent install --client codex
```

`doctor` is non-mutating. Use `xr` instead of `start` to include the separate XR
renderer. The package remains a source-distributed CLI, not a signed desktop
installer. The `next` channel is for prereleases and is not needed to install
this stable version.

See the [v0.4.0 README](https://github.com/riseagain1/semaframe/blob/v0.4.0/README.md)
and [changelog](https://github.com/riseagain1/semaframe/blob/v0.4.0/CHANGELOG.md), or
[compare rc.3 with v0.4.0](https://github.com/riseagain1/semaframe/compare/v0.4.0-rc.3...v0.4.0).
