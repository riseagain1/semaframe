# First-party Scene Exchange bridges

SemaFrame's first-party adapters make a narrow, auditable promise: a host tool can pull an immutable `.semaframe-exchange`, preserve SemaFrame stable IDs, and return explicit edits as a `semaframe-bridge-change-proposal` v1. The host never receives Workspace authority and never commits changes directly.

| Host | Supported baseline | Primary scene path | v1 write-back |
| --- | --- | --- | --- |
| Blender | 4.5 LTS+ extension | self-contained GLB with extras | selected transforms |
| FreeCAD | 1.0+ `FreeCADCmd` script | STEP; GLB/OpenUSD fallback | stable-node transforms |
| Unity | Unity 6 (`6000.0`) editor package | optional USD Importer `1.0.0-pre.2`; bundled SemaFrame GLB importer | imported transforms |
| Unreal | 5.6+ content/Python plugin | USD Stage Actor | mapped USD component transforms |

The per-host install and use instructions live in:

- [`integrations/blender/README.md`](../../integrations/blender/README.md)
- [`integrations/freecad/README.md`](../../integrations/freecad/README.md)
- [`integrations/unity/README.md`](../../integrations/unity/README.md)
- [`integrations/unreal/README.md`](../../integrations/unreal/README.md)

## End-to-end flow

1. The SemaFrame owner publishes a revision into a short-lived Bridge session for one target host.
2. The host receives the loopback origin, session UUID, and scoped bearer capability out of band.
3. The adapter fetches the session view, downloads the exchange by its SHA-256 digest, validates the ZIP and declared artifacts, and imports the best supported representation.
4. The host retains `stableId` mapping while a person edits the downstream scene.
5. A visible user action builds and submits a bounded change proposal tied to the exact Workspace ID, base revision, target, and exchange digest.
6. SemaFrame marks the submission `review_required`. Existing transaction, schema, layout, collision, and physics validation still decide whether approved operations can commit.

This is a pull/proposal bridge, not a shared writable database or a background live-sync claim. A newer publication makes proposals from the previous revision stale by design.

## Validation boundary

Run `node scripts/verify-bridge-adapters.mjs` and `node --test scripts/verify-bridge-adapters.test.mjs` from the repository root. They deterministically validate descriptors, pinned versions, protocol markers, Python syntax, and credential-handling invariants. Stubbed host modules let the gate execute setup-JSON parsing and unsafe-archive rejection in the Blender, FreeCAD, and Unreal Python adapters. Unity remains a descriptor/source-structure check: repository CI does not compile its C# or import any adapter into a real desktop host.

Physical-host smoke tests remain separate release gates because those applications and their licensed/runtime-specific importers are not installed in normal repository CI. See [compatibility.md](compatibility.md) for the exact test matrix and the claims this repository does and does not make.
