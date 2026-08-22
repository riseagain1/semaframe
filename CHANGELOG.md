# Changelog

All notable SemaFrame changes are recorded here. The project follows semantic versioning while it remains pre-1.0: minor releases may advance public Workspace, Agent, or persistence contracts, with explicit migrations and release notes.

## [Unreleased]

### Added

- `read_workspace_resource_snapshot`, an exact, revision-preserving read of canonical host-normalized inline or HTTP-feed snapshots behind explicit `workspace:read` plus non-default `effect:data_read` approval.
- A typed, event-routable `move_to` action for current spatial entities, parametric primitives, and model assemblies, with scale preservation, endpoint collision and enforced-physics validation, atomic fan-out, renderer transitions, and deterministic `moved` event replay.

### Changed

- The current public Agent surface advances to 19 MCP tools, Agent Guide 2.7, MCP server 1.8.0, and Agent Gateway OpenAPI 1.1.0.
- Current-project loading now rebases registry-derived command and history digests through verified replay when append-only built-in manifests change, preserving pre-change Workspace 1.3 projects without weakening history validation.

### Security and reliability

- Resource readback fails closed for legacy or unknown connectors, never refreshes or accesses the network, omits connector configuration, secret references, and connector errors, and returns an exact bounded result or an explicit oversize error without truncation.
- One component may receive at most one `move_to` endpoint per revision, preventing an intermediate collision from being hidden by a later target in the same atomic commit.

## [0.3.0] - 2026-08-21

### Added

- Exact SI-metre parametric primitives, editable model assemblies, immutable digest-pinned reusable models, numeric transforms, and human/Agent authoring flows.
- Deterministic OpenUSD USDA export, bounded Manifold STL/OBJ export, and a real OpenCascade AP242 STEP subset in lazy cancellable Workers.
- SemaFrame Spatial Graph 3.1 with primitive, assembly, asset, and visual-only Reality nodes; analytic geometry, semantic proxies, collision, support, mass, and placement evidence.
- A Gaussian Splat Reality Layer for local PLY, SPZ v4, and SOG v2 assets with explicit calibration, content-addressed browser storage, digest relinking, placeholders, selection, LOD, visual effects, and WebGL context recovery.
- Approval-scoped Agent Reality imports using one-use streaming upload grants, browser-side hashing and preflight, descriptor-only inspection, and an end-to-end MCP import workflow.
- A dedicated Reality panel and Inspector controls for availability, quality, calibration, proxy links, relinking, and safe project removal.

### Changed

- Workspace Protocol and project schema advance to 1.3, with migrations for Workspace 1.0 through 1.2 projects.
- The public Agent surface advances to 18 MCP tools, Agent Guide 2.6, and MCP server 1.7.0.
- Three.js is pinned to 0.180.0 and Spark 2.1 is loaded only when Reality content is rendered.
- Release CI now verifies CAD, CSG, and Reality lazy-runtime bundles in addition to type-checking, building, and the full test suite.

### Security and reliability

- Asset uploads are bound to the approved client, Workspace, session, exact digest, media type, and byte length; capabilities and raw asset bytes never enter project JSON or public inspection.
- Candidate downloads now cancel and release readers on disconnect and honor Node stream backpressure.
- Ambiguous finalization responses are retry-safe without discarding locally committed assets.
- Reality renderer loads and context restoration are cancellable and cannot resurrect deleted components or block the authoritative render queue.

### Boundaries

- Gaussian splats are visual evidence, not collision, physics, CAD, or structural authority; editable semantic proxies carry engineering claims.
- Project JSON stores Reality descriptors and digests, not binary payloads. Another browser may require exact-digest relinking.
- Modeling remains light CAD: this release does not claim a general sketch constraint system, full feature tree, FEA, GD&T, or engineering certification.

[Unreleased]: https://github.com/riseagain1/semaframe/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/riseagain1/semaframe/compare/v0.2.0...v0.3.0
