# SemaFrame v0.4.0-rc.2 — Agent-first ecosystem release candidate

SemaFrame v0.4.0-rc.2 synchronizes the source package with the complete v0.4
candidate surface. It preserves one browser-authoritative, revisioned
`WorkspaceStore` for Agent transactions, human edits, rendering, history,
recovery, and export.

## Agent-first Workspace

- An approved Agent now enters the empty Workspace directly. The former
  automatic Start Center task picker no longer interrupts the Agent workflow.
- The pre-handshake Workspace remains mounted but inert and inaccessible until
  a person approves an Agent and the Agent completes the instruction handshake.
- The stable stdio launcher discovers new Gateway lifetimes and refreshed tool
  lists without rewriting the MCP client configuration. New Gateway lifetimes
  still require fresh human approval.

## Spatial and modeling surface

- SemaFrame Layout Graph 1.0 keeps `ui2d` occupancy independent from physical
  `world3d` collision. New 2D/2D and 3D/3D overlaps reject in their own domains;
  2D and 3D may overlap intentionally.
- Editable OCCT B-rep parts, verified CAD handoff, routed `move_to`, photo-set
  Reality reconstruction, portable projects, and the cross-platform XR client
  remain part of the v0.4 candidate.
- Workspace Protocol remains 1.3, project schema 1.4, Agent Guide 3.2, MCP
  server 1.10.0, Agent Gateway OpenAPI 1.3.0, and SemaFrame Spatial Graph 3.2.

## Portable ecosystem

- `.semaframe-project` ZIP/ZIP64 bundles carry replay-verified state and the
  complete retained-history Reality byte closure.
- `.semaframe-exchange` packages carry sanitized semantics, a fidelity report,
  OpenUSD, self-contained GLB, optional exact STEP, and stable IDs.
- Blender, FreeCAD, Unity, Unreal, and custom Scene Bridge clients receive
  immutable snapshots and may return review-only proposals; they never mutate
  the Workspace directly.
- Extension API 1.0, connector registries, artifact jobs, signed template
  catalogs, and opt-in diagnostics expose bounded host-service contracts. They
  remain source-level embedding primitives rather than an in-app marketplace.

## Install the tagged candidate

Run the exact public candidate from npm:

```bash
npm exec --yes --package=semaframe@0.4.0-rc.2 -- semaframe doctor
npm exec --yes --package=semaframe@0.4.0-rc.2 -- semaframe start
npm exec --yes --package=semaframe@0.4.0-rc.2 -- semaframe xr
npm exec --yes --package=semaframe@0.4.0-rc.2 -- semaframe agent install --client codex
```

The `next` dist-tag points to the newest release candidate without changing the
stable `latest` channel. `doctor` is non-mutating. The CLI remains
source-distributed and requires Node 22.12 or newer; this candidate is not a
signed desktop installer.

## Verification and boundaries

CI covers type checking, lint, unit and integration suites, ratcheted core
coverage, real-Chrome Workspace/Agent smoke, production package startup,
Reality/CAD/CSG lazy runtimes, XR production bundles, and Windows Voice Relay.

The release does not claim full CAD, FEA, metrology, arbitrary authenticated
feeds, certified headset compatibility, or certified downstream DCC round
trips. See the README, hardware matrix, bridge compatibility matrix, and export
limitations before relying on those boundaries in production.
