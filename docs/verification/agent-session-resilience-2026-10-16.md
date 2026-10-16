# Agent session resilience and cross-Agent acceptance

Date: 2026-10-16 (Asia/Shanghai). Source based on `v0.5.3`, branch `codex/agent-session-resilience`. The acceptance runtime uses a locally packed and installed patched snapshot. This is not a new npm release.

**Status: completed for the workflow described below.** Final automated gates passed. Real DeepSeek modeling, Chrome refresh recovery, saved-project reopen, Codex continued editing with undo/redo, portable save/reopen, and final DeepSeek readback completed. Independent production-importer audits passed for all six artifacts. DeepSeek needed one geometry correction and a human reminder; this is not a claim that model reasoning was error-free.

## Changes and safety boundaries

### Approval handshake continuation

The official stdio MCP adapter now retains the gateway-issued approval continuation in memory for one downstream protocol session. A later `get_workspace_instructions` call can omit the continuation token without losing the pending request, provided the connection offer, client identity, and requested scope set still match.

- Human approval and the gateway's authorization checks remain required. The adapter does not approve requests or manufacture authority.
- An explicit token is never overwritten. Explicitly different identities or scope sets do not inherit the retained token.
- Tokens are not persisted to project files or disk. Protocol-session close, gateway/offer replacement, denial, revocation, and invalidating errors clear the continuation.
- Concurrent instruction requests are serialized so later calls can continue the first pending request. Workspace writes are not automatically repeated.

Implementation: [handshake session](../../server/agent/AgentMcpHandshakeSession.ts), [stdio adapter](../../scripts/agent-mcp.ts). Regression coverage: [handshake tests](../../src/tests/server/AgentMcpHandshakeSession.test.ts), [real stdio bridge tests](../../src/tests/server/AgentMcpStdioBridge.test.ts).

### Update-only transactions and canonical spatial parameters

`begin_workspace_update.requested_component_ids` accepts integers from `0` through `100` consistently in MCP, REST, the controller, and the store adapter. Use `0` when modifying existing objects without creating new components. This returns an empty reservation and consumes no component IDs; creation with an unreserved ID remains rejected. Omission retains the existing default of eight IDs. Negative, fractional, over-limit, string, and null values remain invalid.

The spatial-query description and modeling guide now include an executable example shared with REST documentation:

- `candidate.placement` contains `space: "world3d"`, `position`, `rotation`, and `scale`.
- The primitive discriminator is `geometry.kind`; the collider discriminator is `collision.shape`.
- Explicit box colliders use `center` and full `size`, not half-extents.
- `world_transform` is readback evidence, not an input alias. Top-level candidate `shape` or `position` fields remain rejected rather than silently reinterpreted.
- New candidates use world coordinates; existing children use parent-local placement. Intended face contact can use an explicit matching enabled solid collider at margin zero, without weakening other clearances or disabling collision.

Implementation: [MCP tool contract](../../server/workspace/WorkspaceMcpTools.ts), [REST parsing](../../server/agent/AgentGatewayHttpHandler.ts), [OpenAPI](../../server/agent/openapi.ts), [guide](../../src/workspace/agents/guide.ts). Regression coverage: [transport contract](../../src/tests/workspace-agents/server/WorkspaceTransports.test.ts), [REST reservation bounds](../../src/tests/server/AgentGatewayReservationContract.test.ts), [store preparation](../../src/tests/workspace-agents/server/WorkspaceStoreEngineAdapter.test.ts), [executable spatial example](../../src/tests/workspace-agents/server/WorkspaceSpatialUsability.test.ts).

### Bounded FIFO command scheduling

The gateway queues normal overlapping requests instead of rejecting the second request immediately with `engine_busy`. Reads and writes share a bounded FIFO; only one command is delivered to the browser at a time, and later reads cannot overtake a write. The core still validates transaction ownership, revisions, and schemas when each operation executes.

- Queue overflow remains an explicit rejection; the queue is not unlimited.
- Approval, connection lifetime, and the request's deadline are checked again before queued execution.
- Revocation, disable, browser replacement/disconnect, and shutdown invalidate waiting work. Queued commands are not replayed on a different browser.
- A command that times out before delivery is reported as not executed. A delivered command with an unknown outcome remains a barrier until acknowledgement or browser reconnection; the gateway does not guess that a mutation failed or automatically replay it.

Implementation and regression coverage: [gateway](../../server/agent/AgentGateway.ts), [queue tests](../../src/tests/server/AgentGatewayQueue.test.ts).

### Browser refresh transport recovery

The browser client makes at most three attempts to read configuration when native fetch fails before returning a response, with bounded delays of 250 ms and 750 ms. This retry is restricted to the read-only configuration GET. HTTP rejection, invalid response data, registration, command execution, and result acknowledgements are not automatically retried.

Stop/cancellation aborts pending configuration recovery. If a known browser lease cannot complete setup, only that exact lease is released; an unknown registration outcome is not guessed, and another tab is not taken over. A result-acknowledgement failure is no longer treated as a handler failure: the client neither reruns the handler nor sends a contradictory error acknowledgement for the same completed command.

Project recovery still does not restore persisted credentials or grant new permissions. Explicit project Open retains the normal authorization boundary. Implementation and regression coverage: [browser client](../../src/agent/AgentGatewayClient.ts), [browser client tests](../../src/tests/agent/AgentGatewayClient.test.ts).

## Final automated gates

| Gate | Final result |
| --- | --- |
| Focused parameter/guide regression run | 6 files, 62 tests passed |
| Parameter implementation TypeScript and targeted lint checks | Passed at that checkpoint |
| Final single-worker complete test run | 2,385 tests passed; no failures |
| Final lint | Passed |
| Desktop and XR production builds | Passed |
| CLI tests | 45/45 passed |
| XR launcher tests | 23/23 passed |
| Independent final project audit | All six baseline/model/refresh/handoff/portable/reopen artifacts passed |
| Report relative links and diff checks | Passed |

An earlier full-suite run had 2,373 passing tests and two timing-related failures: a `VoiceRelayNativeClient` health request with a 100 ms budget and a `WorkspaceResizeMigration` test exceeding 30 seconds. That run was not accepted as passing. The finalized single-worker run completed with all 2,385 tests passing; the earlier failures are retained here rather than hidden behind the final result.

## Real DeepSeek modeling: completed stage

The official DeepSeek Harness used the configured DeepSeek model and SemaFrame MCP adapter against a separate Chrome acceptance workspace. The original workspace on port `4173` was not used as the modeling target. A saved copy of its 19-component, revision-10 scene was imported for this run.

DeepSeek received a modeling request, not an operator-authored command batch: widen the existing tabletop from 1.8 m to 2.0 m and add a separately editable three-part notebook with its own assembly root, preserving the other objects and interaction.

The first batch produced the notebook but had 3 mm and 1 mm internal penetrations. DeepSeek identified only part of the problem and presented correction as optional; it did not independently detect and resolve both overlaps. The operator pointed out both penetrations, reiterated the existing zero-overlap requirement, and requested internal collision validation, without supplying replacement coordinates. DeepSeek then committed a corrective batch with the notebook's `collisionPolicy` set to `all` and corrected the part placements. **This required two DeepSeek commits and a human reminder; it was not a one-shot or fully unassisted geometry result.**

The resulting project was saved through the real application as `02-after-deepseek.semaframe.json`. Independent validation using the patched production importer and serializer confirmed:

- **23 components, revision 12, 12 history entries, one event connection.**
- All 19 original component IDs remain. Among original components, only the tabletop's geometry width and matching collider width changed to 2.0 m.
- `Resilience verification notebook` is a distinct assembly with exactly three direct, editable primitive children: bottom cover, paper pages, and upper cover.
- All three new colliders match their box geometry, remain enabled solids with explicit zero margins, and retain enabled physics.
- The notebook bottom touches the tabletop at `y=0.75`; adjacent part faces touch at `y=0.758` and `y=0.764`, without gaps or penetration.
- All 17 solid colliders remain enabled. No 2D overlaps or 3D collision conflicts were found, including an independent offline check that enables internal collision checking on every assembly.
- The original ten history entries and the event connection match exactly. Production history replay, offline undo/redo, and another serialize/reopen cycle passed.
- The next component sequence is 36, compared with 32 in the baseline: exactly four new IDs were consumed across the two modeling batches.

## Real refresh, reopen, and Codex handoff

1. **Chrome refresh recovery:** refreshed the actual acceptance tab and had DeepSeek inspect the restored scene. `03-after-refresh.semaframe.json` matches the complete DeepSeek export exactly after excluding only root `updatedAt`, including component identities, hierarchy, command history, events, counters, and geometry.
2. **Actual saved-project open:** opened the saved file through the real browser file chooser. Subsequent Agent work used normal approval and instruction handshakes rather than a direct state injection or a replacement scene.
3. **Real Codex continued edit:** a Codex CLI session connected through the official MCP adapter. It inspected the existing notebook and changed only the upper cover's `material.baseColor` from `#1B2A4A` to `#E3A536`, advancing revision 12 to 13. Its preparation requested zero new IDs and returned an empty reservation. The component allocator remained at 36.
4. **Actual undo and redo:** Codex undid the color change and read back the DeepSeek result, then redid it and read back the gold cover. The model's workspace summaries matched the corresponding pre-edit/committed states. No replacement components or duplicate scene were created.
5. **Concurrent tool use:** the Codex transcript contains 15 MCP calls, with a peak of three overlapping calls: one expected initial `approval_pending` result and 14 successful results. It contains no unexpected handshake, parameter-validation, or `engine_busy` error. This verifies normal bounded concurrency in this run, not unlimited parallel throughput.
6. **Final portable save and real reopen:** saved `SemaFrame-agent-handoff-verified.semaframe.zip`, then opened that exact archive through the real UI. A new DeepSeek connection received only `workspace:read`; after approval, it read back 23 components at revision 13, the gold upper cover, the 2.0 m tabletop, notebook face contacts at 0.750/0.758/0.764 m, and the preserved chair, lamp, and event connection. That final read-only check had no tool errors.
7. **Re-export after portable reopen:** `05-portable-reopened.semaframe.json` matches both the final Codex JSON and the imported portable project exactly after excluding only root `updatedAt`. All three share state digest `fnv1a32:f293786f`. Production replay, offline undo/redo, and a second serialize/reopen passed, with 17 enabled solid colliders and no overlap conflicts even when every assembly's internal collisions were enabled offline.

The notebook description still contains the earlier word “navy.” That text was intentionally left unchanged because the handoff test authorized exactly one material-color field change. This test proves precise scoped editing, not automatic synchronization of every free-text description with model appearance.

### Exact history-rebase investigation

The first strict audit rejected the Codex export because two earlier DeepSeek history records had different `inputRevision` values. Investigation reproduced the behavior with the production store rather than ignoring the field:

- `WorkspaceProjectSerializer.openStore` replays each saved `inputRevision` unchanged; opening alone does not normalize it.
- Agent undo/redo calls `WorkspaceStore.undoUserCommand` / `redoUserCommand`. Their history rebuild deliberately uses the current replay revision as `input_revision`, rebasing retained command metadata to each command's `baseWorkspaceRevision`.
- In this run, the two DeepSeek records changed from 11 to 10 and from 12 to 11. Their matching workspace-history summaries changed identically. The original ten baseline records were already canonical and remained exactly unchanged.
- The audit independently executed the production undo/redo path, then required the saved prefix to equal that reproduced history. Only those exact `inputRevision` changes were accepted. Request IDs, actors, base/result revisions, registry digests, resolved operations, resolved events, action effects, and every other field remained exact. A different `inputRevision` rewrite would still fail.

The pre-handoff digest is `fnv1a32:856a5b55`; its production-rebased history form is `fnv1a32:24400d71`. Offline undo of the final project reproduces that exact canonical DeepSeek state. The difference is accounted for by the two history-summary metadata fields, not lost geometry or an unvalidated change to scene contents. Implementation: [production history replay](../../src/workspace/persistence/WorkspaceProjectSerializer.ts), [user-command history rebuild](../../src/workspace/state/WorkspaceStore.ts).

### Evidence identities

| Evidence | State digest | Bytes | Artifact SHA-256 |
| --- | --- | ---: | --- |
| Unchanged original-scene backup | `fnv1a32:a16b2789` | 114,556 | `c4057bb8e18fcb015266d4aeafe9c02560d4bbae3692fdd2ea8cc3b055751aef` |
| DeepSeek model after corrective batch | `fnv1a32:856a5b55` | 142,441 | `42288a5595f8deebf1d936fedae44c32df0cd2d4a3fc9bba891a3d88783df948` |
| After real Chrome refresh | `fnv1a32:856a5b55` | 142,441 | `f4c57fe98fe55158730512b933b4b1ae02c9030188c36fc2fd1761124ffa8dfe` |
| Codex edit after undo/redo | `fnv1a32:f293786f` | 143,598 | `fc7ba6a1dbc1704f4bc5fd0656e42e5df7f3e19d997f6e91b34bde11a31dd11e` |
| Final portable archive | `fnv1a32:f293786f` | 144,223 | `bb766714a8f11ddbb1a4634d1f5150497c729795662e943d884b24e1155bffbf` |
| Real portable reopen and re-export | `fnv1a32:f293786f` | 143,598 | `7256015e3e0713fbc0fe9f29e9beb024cd4940560abadf2ef672ddd7c2474c6a` |

Different artifact byte hashes are expected for changed export timestamps and archive containers. Same-revision project comparisons exclude only root `updatedAt`; they do not exclude scene data, counters, resolved history, or events. The explicitly investigated history rebase applies only across the actual undo/redo handoff, not as a blanket exception for refresh or file reopen.

## Original workspace preservation

All modeling and persistence acceptance took place in the separate Chrome test workspace. The original service on `4173` and its gateway were not restarted or used as mutation targets; their checked process IDs remained 44554 and 44557. The original saved baseline retains its exact SHA-256 shown above, 19 components, revision 10, ten history entries, and one connection.

Process identity and backup integrity are the preservation evidence for this run, not a newly exported live-state comparison of the original browser. The audit validates the exported test copy independently and does not claim it inspected hidden original-tab state.

## Limits

This run evaluates a specific DeepSeek/Codex modeling and persistence workflow, not every Agent or a guarantee of error-free model reasoning. Proxy collision and quasi-static checks do not establish calibrated dimensional accuracy, structural strength, or engineering certification. The scene contains no Reality Assets, so it is not a new large-binary portability or photogrammetry-accuracy benchmark. No physical headset or Windows-device acceptance is claimed. No PR, merge, npm publication, tag, or GitHub Release was performed as part of this verification. Approval tokens, credentials, and private local paths are intentionally omitted.
