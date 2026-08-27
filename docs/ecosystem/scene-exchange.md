# Scene Exchange and downstream bridges

`.semaframe-exchange` is an immutable interoperability package for one Workspace revision. It is deliberately different from `.semaframe-project`: an exchange carries enough geometry and semantics for a downstream tool, but not Workspace persistence authority or private host data.

Version `1.0` contains:

| Path | Meaning |
| --- | --- |
| `semaframe.exchange.json` | Stable IDs, hierarchy, component type refs, placement, visibility, tags, action/event schemas, safe resource descriptors, and data/event connections |
| `fidelity-report.json` | Per-component exact, parametric, visual, or semantic representation plus explicit limitations |
| `scene.usda` | Deterministic metre-based right-handed Y-up OpenUSD scene layer for world-space transforms and supported geometry/materials |
| `geometry.glb` | Self-contained glTF 2.0 binary with scene geometry and SemaFrame stable-ID extras |
| `exact/model.step` | Optional exact STEP B-rep artifact supplied by the host for mapped components |

The built-in Project Bar export and live Bridge currently publish OpenUSD/GLB plus semantics. They do not synthesize a combined STEP document for the whole Workspace. `exact/model.step` is present only when an embedding host supplies non-empty, verified STEP bytes and unique mapped `world3d` component IDs; the app's existing exact CAD workflow remains the Export Center CAD handoff.

The semantic manifest includes all components. Only world-space components become 3D transforms and geometry. 2D layout, actions, events, data bindings, and semantic-only components remain explicit manifest data rather than being fabricated as CAD or mesh geometry.

Connector configuration, secret references, cached feed values, local paths, and host-vault Reality bytes are excluded. A Gaussian splat is represented as visual/semantic evidence unless a separate downstream-safe artifact is deliberately added in a future contract.

## Pull bridge

`BridgeSessionService` holds a bounded set of expiring, target-specific sessions. A downstream tool uses its session bearer to:

- inspect the current publication, optionally waiting after a monotonic sequence;
- download the exact immutable archive by digest; and
- submit a bounded change proposal tied to that Workspace ID, revision, exchange digest, and bridge target.

Only the host owner can create, republish, inspect the proposal queue, discard proposals, or close a session. A publication cannot change Workspace identity, sequence cannot move backward, and revision cannot rewind. The default session lifetime is 30 minutes, with an eight-hour maximum. The local browser owner surface limits a live archive to 64 MiB; the reusable service has a 512 MiB embedding ceiling. A session holds at most 100 pending proposals.

The public bridge HTTP handler exposes only session-scoped pull/download/proposal routes. The bearer belongs in the `Authorization` header and is never part of the archive or proposal.

## Proposal review and commit

A `semaframe-bridge-change-proposal` `1.0` document can propose:

- a complete placement replacement, with an optional bounded transition;
- complete component props replacement;
- label, visibility, or tags; or
- attach/detach hierarchy changes with explicit local/world transform preservation.

Parsing rejects unknown fields, cycles in the JSON value, invalid IDs, non-finite transforms, invalid placements, duplicate change IDs, oversized notes, more than 100 changes, or a document above 1 MiB.

Review marks the proposal stale if its Workspace, revision, or exchange digest differs from the selected publication. It also reports missing components/parents, locks, invalid props, a move between 2D and 3D placement domains, self-parenting, and hierarchy cycles. A stale proposal has no eligible changes.

`approvedBridgeChangesToWorkspaceOperations` accepts only change IDs that the person explicitly selected and that review marked eligible. It produces normal Workspace operations; it does not commit them. The caller must still use the ordinary begin/submit transaction path, where revision, authorization, 2D layout, 3D collision, and enabled physics are enforced atomically.

## Included adapters

The repository contains narrow reference adapters:

- [Blender bridge](../../integrations/blender/README.md): pulls GLB, preserves stable IDs, and proposes selected world-transform edits. It does not synthesize Blender modifiers or parametric history.
- [FreeCAD bridge](../../integrations/freecad/README.md): prefers exact STEP when supplied, creates stable semantic node holders, and proposes transforms. Neutral STEP does not recreate native FreeCAD feature history or constraints.
- [Unity bridge](../../integrations/unity/README.md): imports the exchange into editor-owned objects and proposes the supported editor changes; it is not a runtime synchronization system.
- [Unreal bridge](../../integrations/unreal/README.md): uses the supported editor import path and stable metadata; it is not a multiplayer/live-game state bridge.

Repository verifiers can check source contracts, endpoint safety, digest validation, and expected adapter structure without installing every desktop host. They are not a claim of physical validation across all Blender, FreeCAD, Unity, Unreal, OS, plugin, graphics-driver, and project combinations. Follow each adapter README's exact version and host setup, and validate a representative project before production use.

The shared [bridge guide](../bridges/README.md) documents the exact protocol, security model, compatibility matrix, and physical-host release checks.
