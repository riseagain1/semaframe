# Agent pairing recovery verification — 2026-10-16

## Scope

This report covers the pairing hotfix prepared for v0.5.5, initially applied to a
local v0.5.4 connector. It does not treat package publication, CI completion, a
live browser reload or a complete modeling workflow as implied by a unit test.
No credentials, private connection URLs or user project files accompany this report.

## Reproduced failure and correction

A discovery request for an old offer could finish after a replacement connection
had established a new pending approval. Reading the current client only after the
network await associated that old response with the new connection. The adapter
could then close the replacement and erase its in-memory approval continuation,
leaving the next retry with `approval_token_required`.

The corrected code binds the read to the client and discovery snapshot captured
before the await. It rejects stale results both in the helper and immediately
before mutation, including after catalog refresh. A real stdio regression test
reproduces the delayed-response interleaving rather than relying on a mock-only
state inspection.

Explicit identity/scope mismatch now preserves the original continuation and
returns an actionable diagnostic without forwarding its proof. A caller's
explicit proof is adopted only after upstream success and only with the canonical
response identity and requested scopes, never by trusting changed retry arguments.
Tokens remain local to the downstream protocol session and in memory. Existing
expiration, denial, revocation and Gateway authorization checks remain authoritative.

## Automated verification

- Connector regression suite: 49 tests across three files passed.
- Independent final review: 93 tests across the three connector and two UI files passed.
- CLI tests: 45 passed at the implementation checkpoint.
- TypeScript, lint, desktop/XR builds and diff checks passed at that checkpoint.
- An implementation full-suite run passed 2,401 tests across 280 files before the
  final consumer-guard and explicit-proof additions; the focused suites above
  cover those additions. Release preparation reruns the complete final source,
  isolated packed installation and CI as separate gates.

Source tests:

- [Discovery race and mutation guard](../../src/tests/server/AgentMcpBridgeReliability.test.ts)
- [Handshake provenance and context](../../src/tests/server/AgentMcpHandshakeSession.test.ts)
- [Real stdio transport recovery](../../src/tests/server/AgentMcpStdioBridge.test.ts)
- [Connection page recovery](../../src/tests/app/AgentConnectionPage.test.tsx)
- [Connection experience](../../src/tests/app/AgentConnectionExperience.test.tsx)

## Live read-only acceptance

The existing local Workspace and Gateway remained running. Only the three
connector source files were hotfixed after byte-for-byte comparison with the
tested source; originals were retained in a local rollback directory. The browser
was not reloaded and its scene was not replaced or imported.

An initial approval window expired; it is not counted as success. A subsequent
normal approved handshake through the registered native MCP tool succeeded with
only `workspace:read`. A follow-up instruction call without explicit proof also
succeeded, followed by three concurrent Workspace reads without a new approval.

All reads returned the same complete bounded summary, with zero omitted components:

- Workspace revision: **10**.
- Components: **19**.
- Event connections: **1**.
- Component properties, durable state, placements, hierarchy, visibility, bindings,
  locks, visual effects and connection metadata matched the pre-fix summary exactly.
- Registry digest and revision were unchanged.
- The original saved backup checksum remained unchanged.
- Scene write calls made during this acceptance: **0**.
- Workspace HTTP status: **200**; Gateway health: **OK**.

The patched connector initialized with 27 exposed tools. The installed package
still identified as v0.5.4 during this hotfix acceptance; calling it a published
v0.5.5 installation would misstate the evidence.

## Limits

This validates the reproduced race, selected continuation/recovery paths and
original-scene preservation in this run. It does not promise uninterrupted service
after every process restart, unlimited concurrency, automatic approval, universal
Agent compatibility or a new full DeepSeek/Codex modeling acceptance. The UI
guidance is covered by automated tests but was not hot-reloaded into the original
user tab. No headset or other physical-device acceptance was performed here.
