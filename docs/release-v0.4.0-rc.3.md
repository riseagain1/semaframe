# SemaFrame v0.4.0-rc.3 — Measurement-driven modeling and validation

This candidate brings the measurement-driven precision workflow and dependency
security updates from [PR #38](https://github.com/riseagain1/semaframe/pull/38)
into the public npm package. Agents and people use the same editable,
revision-controlled Workspace; passing labels never replace retained evidence.

## From captured geometry to an inspectable CAD proposal

- Import ordinary OBJ, PLY, or XYZ measurement geometry through approved Agent
  asset ingress, or retain the native mesh, materials, and textures from photo
  reconstruction alongside the visual Reality asset.
- Declare units and working axes, register geometry with a rigid or uniform
  similarity transform, and keep fitting controls separate from held-out checks.
- Record tolerances, supplied uncertainty bounds, and required regions. Reports
  distinguish unverified, inconclusive, failed, and scope-limited passing results.
- Fit planes, circles, and cylinders; create editable shaft or measured-plate CAD
  proposals; and compare the actual host-evaluated CAD part against the admitted
  geometry using bounded bidirectional sampled-vertex-to-surface distances.
- Inspect and edit the study in the human interface or use the read-only
  `analyze_workspace_precision` tool. Changes still pass the normal prepared
  Workspace transaction, approval, and revision checks.
- Preserve evidence through undo/redo and portable save/reopen. Export metric
  OBJ/PLY geometry and study/report sidecars; continue using the existing exact
  STEP handoff for supported CAD parts.

## Security and regression hardening

MCP, image-processing, and transitive dependencies have been updated to address
reported advisories. CI now audits runtime and development dependencies. The
Vitest/V8 coverage toolchain advances to 4.1.11 without lowering the established
core coverage thresholds. Additional tests cover authorization, ingress, feeds,
recovery, archive validation, and forged or stale precision evidence.

Release gates cover type checking, lint, unit/integration coverage, real-Chrome
Workspace and precision smoke, clean packed CLI install/startup, desktop/XR
builds, CAD/CSG/Reality lazy runtimes, ecosystem adapters, and Windows XR tooling.
Synthetic OCCT STEP round trips verify numerical transfer, not physical accuracy.

## Compatibility and limits

- Workspace Protocol remains 1.3 and project schema remains 1.4. The public
  surface now contains 26 Workspace MCP tools plus 10 ephemeral host-control
  tools; the Agent guide describes the new precision analysis tool.
- Portable bundles containing precision evidence use manifest 1.1. This reader
  supports 1.0 and 1.1; projects without precision evidence still export as 1.0.
  Older readers may reject evidence-bearing 1.1 bundles explicitly.
- Ordinary measurement sources are bounded to 16 MiB, 25,000 vertices, and
  50,000 triangles. Retained native capture bundles are bounded to 256 MiB.
  Existing transaction, project, and comparison budgets still apply.
- Current scan-to-CAD comparison requires the CAD target and its ancestors to
  use identity placement. The comparison is sampled evidence, not a guaranteed
  continuous maximum error over every surface.
- Source hashes establish integrity, not the truth of measurements or instrument
  calibration. No independently measured physical-object validation campaign has
  been completed. This release does **not** claim field-validated millimetre
  reconstruction, arbitrary photo-to-CAD conversion, GD&T, FEA, or certification.

See [Precision acceptance](./precision-acceptance.md) for the physical validation
protocol and [the changelog](../CHANGELOG.md) for the release history.

## Install this candidate

Node.js 22.12 or newer is required. Run the exact release:

```bash
npm exec --yes --package=semaframe@0.4.0-rc.3 -- semaframe doctor
npm exec --yes --package=semaframe@0.4.0-rc.3 -- semaframe start
npm exec --yes --package=semaframe@0.4.0-rc.3 -- semaframe xr
npm exec --yes --package=semaframe@0.4.0-rc.3 -- semaframe agent install --client codex
```

`semaframe@next` selects the newest candidate. This release does not promote the
project to stable or move the legacy npm `latest` tag; use the explicit version
or `next`. It is a source-distributed CLI, not a signed desktop installer.

[Compare v0.4.0-rc.2 to v0.4.0-rc.3](https://github.com/riseagain1/semaframe/compare/v0.4.0-rc.2...v0.4.0-rc.3).
