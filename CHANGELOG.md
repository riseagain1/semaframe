# Changelog

All notable SemaFrame changes are recorded here. The project follows semantic versioning while it remains pre-1.0: minor releases may advance public Workspace, Agent, or persistence contracts, with explicit migrations and release notes.

## [Unreleased]

### Added

- SemaFrame Layout Graph 1.0, an independent `ui2d` Universal Space Data projection with canonical 1440×900 bounds, exact rotated-rectangle overlap relations, deterministic `query_layout_placement` suggestions, and explicit projection-dependent nodes.
- One-click, atomic **Auto-arrange 2D** repair for movable legacy panels.
- Deterministic `.semaframe-project` ZIP/ZIP64 portability with replay-verified Workspace state, complete retained-history Reality closure, streamed export, staged import, and rollback on project replacement failure.
- Immutable `.semaframe-exchange` packages with sanitized semantics, fidelity reporting, OpenUSD, self-contained GLB, optional embedding-host STEP, stable IDs, and short-lived downstream pull sessions.
- Review-only Scene Bridge round trips for Blender, FreeCAD, Unity, Unreal, and custom clients; all returned edits remain proposals until an eligible selection passes the ordinary authoritative Workspace transaction gates.
- Source-level Extension API 1.0, immutable connector registries, bounded artifact jobs, signed static template catalogs, and opt-in previewable anonymous performance diagnostics for embedding hosts.

### Changed

- New 2D overlaps now reject atomically without entering the physical 3D collision domain. Existing overlapping projects remain openable and editable, cannot worsen their layout, and can be repaired progressively.
- General 2D components now default to the zoomable canvas and choose a deterministic free placement instead of accumulating fixed-viewport cards at tiny ordinal offsets.
- The public Agent surface advances to 25 Workspace MCP tools, Agent Guide 3.2, MCP server 1.10.0, and Agent Gateway OpenAPI 1.3.0; `inspect_workspace_space` returns separate `layout_graph` (`ui2d`) and `spatial_graph` (`world3d`) projections.

### Security and reliability

- Native stdio extensions require exact manifest/package verification, a manifest-pinned complete runtime file tree, host-version compatibility, per-provider method authorization, and execution from a private verified snapshot; the process remains trusted native code rather than an OS sandbox.
- Scene Exchange excludes connector configuration, secret references, feed values, local-path data, and Reality bytes; downstream bearers authorize immutable pulls and bounded proposals, never direct Workspace mutation.
- Portable project import verifies canonical archive structure, CRC and SHA-256 identity, Reality format, replay, and exact closure before staging any destination bytes.
- Catalog verification, connector results, artifact requests/results, and diagnostics storage now fail closed under forged provenance, credential-like material, unbounded output, or cardinality pressure.

## [0.4.0-rc.1] - 2026-08-27

### Added

- A guided Start Center and unified Checks panel for empty-project onboarding, collision/physics/binding/Reality readiness, and direct issue navigation.
- A Basic/Advanced Inspector split that keeps everyday modeling approachable while preserving access to exact manifests, feature history, mates, compound colliders, constraints, and raw state without losing hidden configuration.
- A single Sources Wizard for local JSON/CSV and approved HTTPS feeds, including freshness/provenance/citation preview and atomic create-component/resource/binding transactions.
- An outcome-aware Export Center grouped by OpenUSD, editable CAD, and mesh use cases, with capability readiness and honest busy/error feedback.
- An XR Setup Assistant for same-device WebXR, Quest/remote-headset mode, and Windows Ultra that preserves the existing trusted-user-gesture and fail-closed hardware gates.
- A source-distributed `semaframe` CLI with `doctor`, `start`, and `xr` commands plus a production-dependency-only packed-install/start smoke.
- A deterministic 100/500/2,000-component performance benchmark and an explicit hardware/runtime evidence matrix.
- `read_workspace_resource_snapshot`, an exact, revision-preserving read of canonical host-normalized inline or HTTP-feed snapshots behind explicit `workspace:read` plus non-default `effect:data_read` approval.
- A typed, event-routable `move_to` action for current spatial entities, parametric primitives, CAD parts, and model assemblies, with scale preservation, endpoint collision and enforced-physics validation, atomic fan-out, renderer transitions, and deterministic `moved` event replay.
- Editable `cad-part` components with SI parameter expressions, bounded constraint sketches, ordered feature history, real OCCT B-rep evaluation, exact B-rep measurements and SSG evidence, tessellated rendering, conservative bounds-based collision/physics, and atomic human or Agent editing.
- Model Assembly 2.0 manufacturing identity and validated fixed/revolute/slider/planar mate metadata, preserved through reusable Model Definition 2.0 instances.
- A deterministic CAD handoff ZIP with a non-unioned AP242/XCAF assembly, names, colors, occurrences, OpenUSD, the complete editable SemaFrame sidecar, a limitations report, hashes, and geometric OCCT re-import verification.

### Changed

- The pre-handshake Workspace remains mounted for renderer continuity but is inert, hidden from accessibility, and unavailable until an approved Agent completes the instruction handshake.
- Agent/project/XR replacement lifecycle helpers are isolated from the top-level App and directly regression-tested.
- Workspace recovery now uses digest-verified IndexedDB `current`/`previous` records with a localStorage fallback, serialized/coalesced writes, and hard project-generation boundaries.
- Workspace project schema advances to 1.4 for Model Definition 2.0 persistence while the command protocol remains 1.3; valid schema 1.3 projects migrate on load and save back as 1.4.
- The current public Agent surface advances to 24 Workspace MCP tools plus 10 ephemeral host-control tools, Agent Guide 3.0, MCP server 1.9.0, Agent Gateway OpenAPI 1.2.0, and SemaFrame Spatial Graph 3.2.
- Current-project loading now rebases registry-derived command and history digests through verified replay when append-only built-in manifests change, preserving pre-change project-schema 1.3 files without weakening history validation.

### Security and reliability

- CI now enforces lint, ratcheted core V8 coverage, separate real-Chrome Agent/Workspace smoke, packaged CLI startup, and the existing Windows XR gates.
- Corrupt recovery heads fall back to a verified previous record; failed primary writes cannot shadow a newer fallback, and partial clear is reported instead of falsely hiding recoverable state.
- Sources Wizard preview results are generation- and exact-config-bound, while creating a destination, resource, and all bindings is one revision-stale-checked Store batch.
- XR setup never exposes pairing secrets outside the existing pairing dialog, synthesizes a WebXR gesture, enables Voice Relay by default, or bypasses the physical Ultra benchmark.
- Resource readback fails closed for legacy or unknown connectors, never refreshes or accesses the network, omits connector configuration, secret references, and connector errors, and returns an exact bounded result or an explicit oversize error without truncation.
- One component may receive at most one `move_to` endpoint per revision, preventing an intermediate collision from being hidden by a later target in the same atomic commit.
- CAD evidence is authored only by the host after bounded OCCT evaluation; stale or forged evidence is replaced, and any invalid/unsupported feature rejects the complete revision without damaging the last valid solid.
- Deserialized CAD projects cannot open until every unique definition is re-evaluated in a disposable Worker and its full measurement evidence matches; headless Agent hosts without a hard-stop Worker fail CAD evaluation closed.
- Resource bindings cannot target atomic CAD definition, digest, evidence, collision, or physics fields; presentation-safe metadata and material projections remain available through an explicit manifest policy.

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

[Unreleased]: https://github.com/riseagain1/semaframe/compare/v0.4.0-rc.1...HEAD
[0.4.0-rc.1]: https://github.com/riseagain1/semaframe/compare/v0.3.0...v0.4.0-rc.1
[0.3.0]: https://github.com/riseagain1/semaframe/compare/v0.2.0...v0.3.0
