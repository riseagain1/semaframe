# Changelog

All notable SemaFrame changes are recorded here. The project follows semantic versioning while it remains pre-1.0: minor releases may advance public Workspace, Agent, or persistence contracts, with explicit migrations and release notes.

## [Unreleased]

## [0.5.3] - 2026-10-15

### Fixed

- Restore the last validated local Workspace and edit history automatically before Agent requests or autosave start; explicit New/Open takes precedence over pending startup recovery.
- Distinguish absent recovery from corrupt or unavailable storage. Protect unresolved snapshots against autosave, show a persistent warning, preserve verified fallback records during rotation, and allow safe retries after failed clears. Failed Open/New/Dismiss operations cannot silently release protection or claim inaccessible data was cleared.
- Clarify default collision padding, intended face contact, and independent multipart assembly roots in Agent Guide 3.5, DSH instructions, and the distributed Agent skill. Collisions remain enabled and blocking; assembly membership must be verified after a commit.

### Added

- Add effective collision configuration, padded collider bounds, and margin-only versus unpadded-collider penetration diagnostics to spatial and stable-placement preflights. These remain conservative OBB-proxy checks, not exact mesh intersection or engineering certification.

### Verification

- Completed local gates: 277 Vitest files / 2,310 tests, 45 CLI tests, lint, TypeScript checks, and desktop/XR production builds. Independent recovery review passed 83 focused tests.
- A fresh DeepSeek V4.1 Flash run built 19 components with three correct assembly roots, then verified button-driven chair movement, automatic refresh recovery, continued edits, undo/redo, and disk save/reopen. Exact project comparisons excluded only export timestamps. The Agent self-corrected rejected preflight/view calls; this is not a zero-error or universal Agent claim. See the [verification report](https://github.com/riseagain1/semaframe/blob/v0.5.3/docs/verification/agent-modeling-recovery-2026-10-15.md).

## [0.5.2] - 2026-10-15

### Fixed

- Open the native portable-project save picker directly from the user action on its `Window` receiver, before asynchronous preparation. Validate before opening a writable, stream the archive, and report success only after the file closes successfully.
- Distinguish native-picker cancellation from preparation, open, read, write, and close failures. Preserve visible failure reporting and stream cleanup without an unsolicited download fallback; browsers without a picker retain a size-bounded download path.
- Keep newer edits marked unsaved when the Workspace, project metadata, or undo/redo state changes during export, including changes that reuse the captured revision number.

### Changed

- Save portable projects as picker-safe `.semaframe.zip` files and strip the complete suffix from imported project names. Existing `.semaframe-project` files remain importable without conversion; archive format, media type, manifest versions, and project schema are unchanged.

### Verification

- Add regression coverage for native save failures/cancellation and independent Agent-session handoff with real current/history-only asset bytes, an empty destination vault, revoked old sessions, exact readback, undo/redo, and re-export/replay.
- Verify a real Codex-to-DeepSeek handoff through native Chrome save/open and a final packed-build reopen: preserve 15 component IDs, a Reality Asset and event connection, edit existing geometry/material, and confirm undo/redo and exact asset digests. This bounded synthetic case is not a universal Agent, accuracy, or hardware guarantee.
- Completed local gates: 276 Vitest files / 2,272 tests, 45 CLI tests, 23 XR launcher tests, lint, and desktop/XR builds. Details and limitations are in the [verification report](https://github.com/riseagain1/semaframe/blob/v0.5.2/docs/verification/portable-agent-handoff-2026-10-15.md); release CI and publication are separate gates.

## [0.5.1] - 2026-10-15

### Changed

- Present Codex, Claude Code, and DeepSeek Harness as peer, expandable choices under **Connect your Agent**, with client-specific registration or overlay instructions and one shared approval/scopes explanation. This is a setup UI/documentation change, not a protocol, permission, or model-provider change.
- Keep each client's instructions in independently expandable, keyboard-operable details, with the same client choices available when managed registration status is loading or unavailable. Update the Agent setup documentation while preserving the previous README section anchor.

### Compatibility

- Workspace tools, API and protocol contracts, project schema, and approval/scope enforcement are unchanged from v0.5.0. Selecting or expanding a client does not launch it or grant Workspace access.

## [0.5.0] - 2026-10-14

### Added

- Ephemeral desktop `view_graph` with actual CSS-pixel viewport, live projection camera/canvas transform, app-owned toolbar regions and projected 2D boundaries. Explicit ready/settling/unavailable states and bounded detail never enter project files or undo history.
- Current-view 2D preflight and final-draft atomic validation, with separate canonical/current-view results and view-epoch preparation guards. Explicit canonical-only authoring supports headless workflows without certifying screen layout.
- External DeepSeek Harness (DSH) MCP setup through its official client: credential-free Cordis configuration export, a connection-page copy action, and a foreground DSH Web launcher using an isolated temporary overlay and the existing persistent SemaFrame bridge.
- DSH setup and lifecycle validation without embedding a model provider, modifying the user's DSH profile, or changing Workspace authorization.
- Progressive Agent discovery: a compact mandatory guide and exact type catalog by default, with authenticated `inspect_workspace_capabilities` for selected manifests, topics, and canonical operation schemas. Explicit full-reference modes remain available; validation and authorization are unchanged.

### Fixed

- Detect actual-viewport 2D overlap, host toolbar occlusion and fixed-HUD clipping. Validate final routed effects, preserve idempotent receipts/history replay, and keep 2D/3D overlap independent of physical collision.
- Give a newly approved Agent a separate, bounded 10-minute instruction-handshake window instead of expiring it on the original 2-minute approval-request deadline. Repeated approval does not renew this window; permissions and token binding remain unchanged.
- Show approval and handshake deadlines separately, distinguish waiting for the Agent from an in-flight instruction read, and explain expired incomplete approvals after automatic offer rotation.
- Existing-assembly movement preflight now checks real descendant colliders, reports parent-local versus world coordinates, and returns correctly transformed suggestions for rotated/scaled parents. Clarify hierarchy, event wiring, and move-versus-resize workflows and rejection messages.
- Fit button content to its allocated panel instead of clipping a fixed-height control inside padded small panels. New button 1.3.0 reserves a 44 px target; exact earlier manifests and saved small controls remain supported.
- Preserve the requested instruction detail through approved Gateway dispatch, including the opt-in full-reference guide.
- Forward runtime-view detail, layout-frame selection, and exact view guards through the public REST Gateway; reject malformed guards and unknown fields before dispatch.
- Keep browser smoke tool/route inventories and full-manifest comparisons aligned with progressive capability discovery.
- Start Windows DSH tree shutdown before terminating its root. Report unverified descendant cleanup if the root has already exited instead of claiming success or targeting a potentially reused PID.
- Align the README Agent tool count and table with the 27-tool surface, including `analyze_workspace_precision` and targeted capability discovery.

## [0.4.0] - 2026-10-13

### Stable release

- Promote the validated v0.4.0-rc.3 application to the stable release channel without changing its modeling, precision, Agent, or XR behavior.
- Make `semaframe@0.4.0` the default npm `latest` installation and publish `v0.4.0` as the non-prerelease GitHub Latest release.
- Update installation instructions, packaged release notes, and the package verification gate so stable releases require `latest` while prereleases require `next`.
- Include the complete v0.4 candidate feature set below: editable CAD and verified handoff, independent 2D layout, measurement-driven modeling and scoped verification, cross-platform XR, portable evidence-bearing projects, review-only Scene Bridges, and dependency/security hardening.

### Boundaries

- Stable is a release-channel designation, not a claim of zero bugs, industrial certification, independently proven reconstruction accuracy, or universal headset compatibility. Existing scope, format, resource, and physical-acceptance limits remain in force.
- Workspace Protocol 1.3, project schema 1.4, and portable manifest 1.0/1.1 behavior remain unchanged from v0.4.0-rc.3. Earlier release candidates remain available as immutable historical versions.

## [0.4.0-rc.3] - 2026-10-13

### Added

- An editable `precision-study` component and approval-gated Agent import of bounded OBJ, PLY, and XYZ measurement sources, with original-byte retention, SHA-256 identity, declared units, and double-precision measurement coordinates.
- Optional retention of native photo-reconstruction mesh, material, and texture evidence alongside visual Reality assets.
- Rigid or uniform-similarity metric registration, separate fit controls and independent checks, explicit tolerance/uncertainty/region policies, and dependency-bound reports that distinguish unverified, inconclusive, failed, and scope-limited passing results.
- Robust plane, circle, and cylinder fitting; editable shaft and measured-plate CAD proposals; and bounded, host-evaluated bidirectional sampled scan-to-CAD comparison.
- Read-only `analyze_workspace_precision` Agent analysis, human-editable study controls and geometry previews, metric OBJ/PLY exports, and a documented physical-acceptance protocol.
- Portable precision evidence closure through current state, checkpoint, undo/redo, and save/reopen. Evidence-bearing bundles use manifest 1.1; bundles without precision evidence retain 1.0, and the reader accepts both. Older readers may reject 1.1.

### Security and reliability

- Updated MCP, image-processing, and transitive dependencies to address reported advisories; upgraded Vitest and V8 coverage to 4.1.11.
- Added a runtime-and-development dependency audit to CI, preserving the existing core coverage thresholds.
- Expanded regression coverage for Gateway and MCP authorization, asset ingress, feed boundaries, recovery, portable archives, and precision evidence authentication.
- Hardened browser-smoke owned-process cleanup and kept browser command acceptance aligned with the canonical tool surface.
- Package verification now checks the release notes matching the packed version and the precision acceptance guide.

### Boundaries

- This is a precision modeling and validation workflow, not field-validated millimetre reconstruction. Synthetic fixtures and software checks do not establish physical accuracy, reference-instrument calibration, manufacturing fitness, or engineering certification.
- Scan-to-CAD comparison is bounded sampled-vertex-to-surface evidence, not continuous whole-surface certification. Photorealistic splats remain visual evidence, not measurement or CAD authority.
- This release remains an npm `next` / GitHub prerelease candidate. Use the pinned version or `semaframe@next` to receive these changes.

## [0.4.0-rc.2] - 2026-08-28

### Added

- SemaFrame Layout Graph 1.0, an independent `ui2d` Universal Space Data projection with canonical 1440×900 bounds, exact rotated-rectangle overlap relations, deterministic `query_layout_placement` suggestions, and explicit projection-dependent nodes.
- One-click, atomic **Auto-arrange 2D** repair for movable legacy panels.
- Deterministic `.semaframe-project` ZIP/ZIP64 portability with replay-verified Workspace state, complete retained-history Reality closure, streamed export, staged import, and rollback on project replacement failure.
- Immutable `.semaframe-exchange` packages with sanitized semantics, fidelity reporting, OpenUSD, self-contained GLB, optional embedding-host STEP, stable IDs, and short-lived downstream pull sessions.
- Review-only Scene Bridge round trips for Blender, FreeCAD, Unity, Unreal, and custom clients; all returned edits remain proposals until an eligible selection passes the ordinary authoritative Workspace transaction gates.
- Source-level Extension API 1.0, immutable connector registries, bounded artifact jobs, signed static template catalogs, and opt-in previewable anonymous performance diagnostics for embedding hosts.
- A Basic/Advanced Inspector split that keeps everyday modeling approachable while preserving access to exact manifests, feature history, mates, compound colliders, constraints, and raw state without losing hidden configuration.
- A single Sources Wizard for local JSON/CSV and approved HTTPS feeds, including freshness/provenance/citation preview and atomic create-component/resource/binding transactions.
- An outcome-aware Export Center grouped by OpenUSD, editable CAD, and mesh use cases, with capability readiness and honest busy/error feedback.
- An XR Setup Assistant for same-device WebXR, Quest/remote-headset mode, and Windows Ultra that preserves the existing trusted-user-gesture and fail-closed hardware gates.
- A public source-distributed `semaframe` npm CLI with `doctor`, `start`, and `xr` commands plus a production-dependency-only packed-install/start smoke.
- A deterministic 100/500/2,000-component performance benchmark and an explicit hardware/runtime evidence matrix.
- `read_workspace_resource_snapshot`, an exact, revision-preserving read of canonical host-normalized inline or HTTP-feed snapshots behind explicit `workspace:read` plus non-default `effect:data_read` approval.
- A typed, event-routable `move_to` action for current spatial entities, parametric primitives, CAD parts, and model assemblies, with scale preservation, endpoint collision and enforced-physics validation, atomic fan-out, renderer transitions, and deterministic `moved` event replay.
- Editable `cad-part` components with SI parameter expressions, bounded constraint sketches, ordered feature history, real OCCT B-rep evaluation, exact B-rep measurements and SSG evidence, tessellated rendering, conservative bounds-based collision/physics, and atomic human or Agent editing.
- Model Assembly 2.0 manufacturing identity and validated fixed/revolute/slider/planar mate metadata, preserved through reusable Model Definition 2.0 instances.
- A deterministic CAD handoff ZIP with a non-unioned AP242/XCAF assembly, names, colors, occurrences, OpenUSD, the complete editable SemaFrame sidecar, a limitations report, hashes, and geometric OCCT re-import verification.

### Changed

- Removed the automatic Start Center overlay so an approved Agent lands directly in the authoritative empty Workspace without a human task-picker interrupting the workflow.
- New 2D overlaps now reject atomically without entering the physical 3D collision domain. Existing overlapping projects remain openable and editable, cannot worsen their layout, and can be repaired progressively.
- General 2D components now default to the zoomable canvas and choose a deterministic free placement instead of accumulating fixed-viewport cards at tiny ordinal offsets.
- The public Agent surface advances to 25 Workspace MCP tools, Agent Guide 3.2, MCP server 1.10.0, and Agent Gateway OpenAPI 1.3.0; `inspect_workspace_space` returns separate `layout_graph` (`ui2d`) and `spatial_graph` (`world3d`) projections.
- The pre-handshake Workspace remains mounted for renderer continuity but is inert, hidden from accessibility, and unavailable until an approved Agent completes the instruction handshake.
- Agent/project/XR replacement lifecycle helpers are isolated from the top-level App and directly regression-tested.
- Workspace recovery now uses digest-verified IndexedDB `current`/`previous` records with a localStorage fallback, serialized/coalesced writes, and hard project-generation boundaries.
- Workspace project schema advances to 1.4 for Model Definition 2.0 persistence while the command protocol remains 1.3; valid schema 1.3 projects migrate on load and save back as 1.4.
- Current-project loading now rebases registry-derived command and history digests through verified replay when append-only built-in manifests change, preserving pre-change project-schema 1.3 files without weakening history validation.

### Security and reliability

- Native stdio extensions require exact manifest/package verification, a manifest-pinned complete runtime file tree, host-version compatibility, per-provider method authorization, and execution from a private verified snapshot; the process remains trusted native code rather than an OS sandbox.
- Scene Exchange excludes connector configuration, secret references, feed values, local-path data, and Reality bytes; downstream bearers authorize immutable pulls and bounded proposals, never direct Workspace mutation.
- Portable project import verifies canonical archive structure, CRC and SHA-256 identity, Reality format, replay, and exact closure before staging any destination bytes.
- Catalog verification, connector results, artifact requests/results, and diagnostics storage now fail closed under forged provenance, credential-like material, unbounded output, or cardinality pressure.
- The public npm tarball excludes prebuilt native Relay binaries; the launcher hashes its exact locally built helper and no longer enables unsigned-helper acceptance by default.
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

[Unreleased]: https://github.com/riseagain1/semaframe/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/riseagain1/semaframe/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/riseagain1/semaframe/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/riseagain1/semaframe/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/riseagain1/semaframe/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/riseagain1/semaframe/compare/v0.4.0-rc.3...v0.4.0
[0.4.0-rc.3]: https://github.com/riseagain1/semaframe/compare/v0.4.0-rc.2...v0.4.0-rc.3
[0.4.0-rc.2]: https://github.com/riseagain1/semaframe/compare/v0.3.0...v0.4.0-rc.2
[0.3.0]: https://github.com/riseagain1/semaframe/compare/v0.2.0...v0.3.0
