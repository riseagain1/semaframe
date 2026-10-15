# Connect DeepSeek Harness to SemaFrame

On the connection screen, **Connect your Agent** presents Codex, Claude Code,
and DeepSeek Harness as peer choices. Expand **DeepSeek Harness** for the setup
described here. All three use the same Workspace tools, human approval, and
scope checks; DSH does not receive a separate access level. Model selection,
provider configuration, and authentication belong to whichever Agent client
you choose.

Codex and Claude Code use managed MCP registration through their official CLIs.
DSH instead uses a Cordis overlay and Web-profile launch, without modifying its
existing profile. See the [common Agent setup guide](../../README.md#connect-your-agent)
for the other clients and shared approval behavior.

This integration targets the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), whose executable is `dsh`, and its [`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md). It is not a DeepSeek API proxy, a built-in chat system, or an integration with an unrelated executable also named `dsh`.

The commands below are included from `semaframe@0.5.0`; the historical `semaframe@0.4.0` package does not contain this integration. The examples pin v0.5.1 for reproducibility; this patch presents the three Agent clients together without changing the connection protocol. With SemaFrame already installed on PATH, `semaframe` can replace the npm launcher; in a development checkout, use `node bin/semaframe.mjs`.

## Prerequisites

- Install the official DSH CLI or macOS Desktop app separately using its [official instructions](https://deepseek.com/en/harness/). SemaFrame does not silently download or install an Agent client. The launcher prefers `dsh` on PATH; on macOS, if absent, it recognizes the official app's bundled CLI under `/Applications` or your user's `Applications` directory without changing PATH.
- Follow DSH's own Node requirement, which can be higher than SemaFrame's. The tested DSH 0.2.0-rc.2 runtime declares `^22.19.0 || >=24.0.0`; SemaFrame's `22.12` minimum alone does not establish DSH compatibility. Check the requirement of the DSH version you install.
- Configure the chosen model and authentication inside DSH. Do not paste model credentials into SemaFrame, an MCP overlay, or a connection URL.
- Keep the authoritative SemaFrame browser tab open with Agent control enabled. The external Agent must be able to reach its local Gateway.
- A cloud-hosted DSH process cannot reach the Mac's loopback address just because it received the configuration. This integration targets DSH running on the same computer.

## Launch without editing a DSH profile

With the official DSH runtime installed and SemaFrame open:

```sh
npm exec --yes --package=semaframe@0.5.1 -- semaframe agent launch --client dsh
```

This runs the installed `dsh web --patch <temporary-overlay>` as a foreground child. The working directory remains the one you launched from; the existing DSH model/provider environment remains DSH's responsibility. SemaFrame writes only its own temporary overlay and removes it after the child exits. Interrupting the launcher forwards shutdown to the child. The wrapper does not modify `~/.dsh`, select a different model, enter credentials, or bypass browser approval. DSH may perform its own normal first-run initialization.

On Windows, an interrupt starts bounded process-tree termination while the owned DSH root is still alive. If that root exits naturally or crashes before tree termination is confirmed, the launcher reports an unverified cleanup and returns a nonzero status. It does not target a potentially reused PID or claim that inherited terminal handles prove all descendants exited. Check Task Manager for processes belonging to that DSH launch before retrying. Automatic cleanup after a natural Windows root exit is not supported; Windows ordering and failure cases have regression tests, but a real Windows DSH modeling session has not been accepted.

Finding a Desktop installation does not attach the overlay to an already-open Desktop window. This launcher explicitly uses the Web profile. If DSH itself reports `EACCES` while initializing its home/profile directory, fix that local installation permission issue with the machine owner before retrying; SemaFrame does not change ownership, run DSH as root, or silently substitute another profile directory.

DSH owns its Web UI and model loop. SemaFrame owns Workspace validation, rendering, history and permissions. DSH's official MCP plugin owns its stdio child; SemaFrame's existing bridge discovers current Gateway offers and refreshes its tool catalog. A Gateway restart can require renewed human approval, but does not require embedding a new temporary connection URL in the overlay.

## Export a reusable overlay

On SemaFrame's connection screen, expand **DeepSeek Harness** under **Connect your Agent**, choose **Copy DSH configuration**, save the copied JSON in a new `semaframe.dsh.json` file, then run:

```sh
dsh web --patch ./semaframe.dsh.json
```

Alternatively, the following command prints only the overlay JSON to stdout:

```sh
npm exec --yes --package=semaframe@0.5.1 -- semaframe agent config --client dsh
```

Save that output in a new file of your choice. JSON is valid YAML for the official Cordis overlay loader, so no YAML conversion or executable `!!js` expressions are required.

The overlay inserts one `@deepseek-ai/dsh-mcp-client` entry named `semaframe-mcp`, using the `semaframe` tool namespace and stdio transport. It points directly to the installed Node/tsx/SemaFrame bridge files, not an npm wrapper or a custom one-shot script. The only explicit child environment values are the fixed loopback Gateway origin and the display name `DeepSeek Harness`.

Do not overwrite an existing DSH profile/home patch. Passing `--patch` leaves it intact. Do not load this overlay twice in the same scope, because DSH server names must be unique. For another existing DSH profile, the same exported overlay can be passed through its documented `--patch` option. The convenience launcher deliberately selects only `web`; it does not claim to manage the Desktop-owned profile.

Regenerate the overlay after moving/upgrading the SemaFrame installation if launcher paths change. Temporary connection offers and approvals must never be copied into it. An unsupported or credentialed setup is rejected instead of silently exported.

## First connection and acceptance

1. Start SemaFrame and enable Agent control; keep the browser tab open.
2. Start DSH with one of the workflows above. Its tools should include `mcp__semaframe__get_workspace_instructions`.
3. Ask DSH to connect to SemaFrame and inspect the current Workspace. Compare the displayed identity/fingerprint and approve only the requested scopes you intend to grant.
4. DSH must retain the returned session and instruction digest, inspect current state, discover the needed component manifests/topics/operation schemas with `inspect_workspace_capabilities`, then prepare and submit revision-bound edits through the normal tools.
5. For an end-to-end modeling check, ask for two non-overlapping objects and a separate 2D panel, inspect the actual result, then test a modification and undo. A successful connection alone is not this modeling acceptance.

The default setup does not enable Voice Relay, grant deletion or photo-reconstruction permission, start a headset session, or change an existing project. Those remain separate explicit choices.

### Approval timing and recovery

From v0.5.0, a pending approval request has a 2-minute deadline (also
bounded by the original connection offer). Clicking **Approve client** starts a
separate 10-minute instruction-handshake window. It is set once; clicking approval
again does not renew it. This gives an external model time to resume after the
human approves, without granting indefinite setup authority. A handshake already
in flight can finish within its normal command timeout, and completed sessions
are not invalidated by setup deadlines.

Keep the same private approval credential for that approved request when asking
DSH to continue. If the request expired and SemaFrame has rotated to a fresh
offer, do not repeat the old credential or assume prior approval still applies.
Ask DSH to start a new `get_workspace_instructions` request with the same identity
and intended scopes but no old approval token; compare and approve the newly
displayed fingerprint. Neither SemaFrame nor DSH may approve that replacement on
the user's behalf. The historical `0.4.0` package does not include this timing fix.

## Verification boundaries

Regression tests cover configuration generation, rejection of secrets/legacy offers, path and origin validation, UI copying, CLI dispatch and child lifecycle. Production-package verification checks that exported loader and bridge paths resolve inside the installed package.

An opt-in interoperability check uses the real official `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2` with SemaFrame's production Gateway/stdio bridge and an isolated in-memory Workspace. Install that exact package separately in a disposable npm prefix, then run:

```sh
SEMAFRAME_DSH_RUNTIME_ROOT=/absolute/path/to/isolated-prefix npm run test:agent:dsh
```

The verifier does not download dependencies, read DSH profiles, call a model, or approve a real Workspace. It checks approval gating, delayed redemption beyond the fixture's original pending/offer deadlines using an isolated injected clock, compact guide/catalog byte budgets, targeted full-schema discovery, error propagation/recovery, revision-bound mutation, and tool catalog refresh. It is not part of the default test run because it requires an explicitly prepared third-party runtime. Pin the stated version rather than relying on the MCP package's `latest` tag.

### Progressive discovery (guide 3.4)

The default instruction response contains the mandatory core rules, not every
subsystem's schema. `inspect_workspace` and `begin_workspace_update` return an
exact type/version/digest catalog marked `schemas_included: false`. Before using
a type or operation, request its full contract with
`inspect_workspace_capabilities`: select at most four `component_type_ids`, four
`guide_topics`, and eight `operation_names` per call. Cache them only while the
registry digest matches the preparation. Existing instances stay pinned; use
`inspect_workspace_component` for their exact manifests.

Selected discovery has a 48,000-byte result cap and fails explicitly rather than
truncating a schema. Split an oversized selection. For intentionally large
references, `get_workspace_instructions` accepts `detail: "full"`; workspace
inspection/preparation accepts `capability_detail: "full"`. The slim advertised
submit schema does not relax execution: the complete canonical command schema
is still validated before dispatch and again by the authoritative core.

Protocol-level interoperability and successful tool discovery do not establish that every DeepSeek model will autonomously complete every modeling task. A real model acceptance run requires a configured DSH provider, normal browser approval, and an explicit test scene. No API key or paid model call is required for the local configuration tests.

### Observed real-model check (2026-10-13)

The installed official macOS DSH 0.2.0-rc.2 Web runtime, using DeepSeek V4.1 Flash
through the user's configured OpenRouter provider, completed a human-approved
`workspace:read` check against this source version. The same DSH process and MCP
bridge remained running across a SemaFrame Gateway restart. After fresh human
approval, the original credential redeemed successfully beyond its original
2-minute pending deadline; `get_workspace_instructions` and one
`inspect_workspace` call both succeeded. The browser independently displayed the
connected client. The empty test Workspace remained at revision 0, and both the
`layout_graph` (`ui2d`) and `spatial_graph` (`world3d`) were returned.

That initial check was read-only. In a subsequent modeling check, the user
revoked the read-only pairing and explicitly approved the same runtime with
`workspace:read`, `workspace:write`, `workspace:history`, `component:create`,
`component:update`, `component:invoke`, and `event:connect`. Delete/clear and
asset/network access were not granted. All scene mutations below were performed
by the actual DeepSeek model through the registered MCP tools, not by a test
script creating the scene on its behalf.

The assisted run demonstrated:

- A multipart table and chair: two assemblies and eleven independently editable
  solid primitives, plus a Stage and a 2D button (15 components in total).
- A working `pressed` to `move_to` binding: the first connected UI button press
  moved the chair assembly and all six children by 0.35 m. Subsequent presses
  used the same absolute target and therefore did not move it farther.
- A tabletop geometry edit from 1.4 m to 1.6 m width and a wood-to-blue material
  change, followed by actual MCP undo and redo calls with inspected readbacks.
  Tabletop height, depth, thickness and unit placement scale were preserved;
  parametric bounds and the resolved collider agreed with the new geometry.
- Exported project loading and complete history replay using the production
  serializer, preserving the connection and prior UI actions. This was an
  offline project-load check, not a claim that the live browser was reloaded.
- No reported solid collision or 2D overlap in this simple scene. Only one 2D
  control was present; this does not establish complex dashboard layout or
  dynamic physical stability.

This was **not an unassisted, one-shot pass**. The first attempt duplicated world
offsets in chair-local coordinates and omitted the button connection. The model
corrected both after feedback and several rejected preflight calls. Large guide
and manifest results spilled to DSH temporary files; after stopping an initial
no-shell-policy violation, the operator allowed bounded, read-only parsing of
that run's own tool-output files. No custom MCP client was used. Later modeling,
history and layout corrections used the registered tools without shell helpers.

Visual acceptance also caught a valid 160-by-40-pixel button panel clipping its
44-pixel inner control. The model enlarged the same panel to 160 by 76 pixels;
the browser then confirmed that the control fit fully inside. Layout validity
alone did not prove rendered-content fit. Smaller discovery responses, clearer
parent-local placement/preflight examples, and content-aware minimum panel
sizes were usability gaps exposed by this initial test.

### Fix verification and fresh-model rerun status (2026-10-13)

The subsequent source fixes add progressive discovery, explicit coordinate-frame
evidence and real descendant-collider assembly preflight, and a fitted button
renderer with a versioned 1.3.0 minimum size. Existing button manifests remain
unchanged. Automated verification passed all 2,149 tests across 266 files,
TypeScript, ESLint, desktop/XR builds, CLI tests, package verification, and the
official DSH plugin protocol fixture. The official client measured a 5,645-byte
core guide and a 6,836-byte preparation in the empty fixture; these are payload
sizes, not token-cost or real-model reliability claims.

A subsequent gateway review also found and fixed the opt-in `detail: "full"`
field being dropped before browser dispatch. Both core/full forwarding now have
regression coverage; all 30 tests in the approval lifecycle, MCP HTTP and
capability-discovery suites passed after that correction.

A fresh real DeepSeek V4.1 Flash conversation and restarted official MCP bridge
completed the post-fix test after explicit seven-scope human approval, without
carrying over the old modeling conversation. In one modeling task the model
discovered the needed schemas, created 15 components and one event connection,
preflighted and moved the entire chair by 0.35 m, and changed the tabletop from
1.4 m/wood to 1.6 m/blue. Actual successful MCP undo (revision 6 to 5) and redo
(5 to 6) responses were inspected. Every modeling batch succeeded on its first
submission; discovery stayed in the registered MCP tools without shell/file
parsing or a custom client. This is one measured run, not a reliability rate.

An independent production-serializer/history replay audit confirmed the saved
geometry, exact child-local preservation, event causality, and zero collisions
even when the two assemblies' default `external_only` policies were tightened
to `all` offline. The 11 solid colliders matched their geometry, with table and
seat surfaces at 0.75 m and 0.45 m respectively.

**The October 13 visual acceptance required one human-observer feedback round.** The model
self-corrected the canonical safe-inset offset, but the layout graph did not
include the host application's floating toolbars at that time. Its first lower-left button
was therefore obscured in the actual 501-by-639-pixel workspace even though
the canonical component graph reported no overlap. After that visual feedback,
DSH repositioned the same 160-by-48-pixel button above the toolbar and reset the
chair for a browser click test. The fitted control had no content overflow;
five interior hit tests reached the button. An actual UI click committed
revision 8; the saved user-event/binding-event chain moved the root and all six
children by 0.35 m while preserving child-local coordinates. Both the pre-click
and post-click exports reopened and replayed through the production loader.
This corrected placement must not be described as an unaided visual
pass or as general host-toolbar-aware layout support.

These observations apply to that local source version, this model/provider and
this assisted task. They do not establish universal Agent compatibility,
unattended modeling reliability, CAD accuracy, photogrammetry quality, or
reusable-model publication/instancing acceptance.

### Runtime-view repair verification (2026-10-14 source checkout)

Agents can now inspect the ephemeral `view_graph` alongside the canonical
`layout_graph` and physical `spatial_graph`. The official DSH client fixture
verifies that nonempty graphs, summary/full runtime detail and prepared view
guards survive the production MCP/stdio path. The JSON text shown to the model
is checked against `structuredContent`; this is an interoperability test with
zero model API calls, not an autonomous modeling result.

An isolated real-browser fixture using the production renderer, projection,
Store and Agent adapter reproduced the former 501-by-639 viewport false pass.
It detected actual overlap and host-toolbar obstruction, applied a returned
valid placement suggestion, and verified an actual button click. Projected
bounds matched the rendered DOM within 0.007 CSS pixels across 1440-by-900,
390-by-844 and 501-by-639 viewports, rotation, pan and zoom. The application
Agent toolbar was also checked in connected/applying states and with changing
history counts; its bounds and view epoch stayed stable.

Regression coverage includes final event-routed effects, stale views after
asynchronous CAD preparation, camera-dependent UI, rollback without partial
state/history/events, pure-3D independence, and save/reopen without persisting
ephemeral view metadata. These checks do not establish visual quality of
arbitrary embedded content or universal model reliability. They do not replace
a fresh authorized model run. The October 13 results above remain explicitly
assisted; the separate October 14 run is recorded below.

### Fresh real-model runtime-view acceptance (2026-10-14)

The same official DSH/DeepSeek V4.1 Flash/OpenRouter setup completed a fresh
modeling task from an empty revision-0 Workspace. The owner explicitly
authorized the operator to approve the matching client fingerprint and the
same seven modeling scopes; no delete/clear, file, network or host permission
was added. SemaFrame's normal approval UI and instruction handshake were used.

The real model read all three graphs, discovered the required contracts, and
created a Stage, two assemblies, eleven solid primitives and a 2D button in
six committed batches. It chose the button's placement from runtime data
without operator-provided screen coordinates or a layout-correction prompt.
Its registered MCP preflight used `frame: "current_view"` and returned ready,
canonical/current-view valid, with no reported issues. In the final 741-by-639
viewport, the 120-by-48 panel was clear of app toolbars. Five actual DOM
interior hit tests reached the button, and its content did not overflow.

Actual successful MCP undo/redo responses were inspected: tabletop width and
material changed from 1.4 m/wood to 1.6 m/blue, undo returned revision 5 to 4,
and redo restored revision 5. The model then reset the chair for a browser
click test. That click committed revision 7 from revision 6, increased the
button press count and moved the chair root plus all six children by 0.35 m.
An independent production-loader audit verified the user-event/binding-event
causal chain, unchanged child-local placements, geometry-matching colliders,
no external or internal collisions, exact project/history replay and
save/reopen state equality. Table and seat top heights were 0.75 m and 0.45 m.
Runtime view metadata was absent from both exports.

A final real-model read-only MCP check then independently observed revision 7,
press count 2, chair Z=1.35, the unchanged event connection, and a ready/valid
runtime view. That post-click readback used the same active session without
another pairing request.

This was **not an error-free first-call run**: initial session recovery and two
stale-view rejections were observed. The model recovered through the normal
tools and reinspection, without another approval or human geometry/layout
correction. No custom MCP client, shell or file parsing was used for modeling.
Some model commentary was inconsistent; acceptance is based on tool responses,
rendered DOM and independently replayed exports, not its prose alone.

The source passed the existing CI-equivalent configuration of two Vitest
workers: 271 test files and 2,202 tests, with all existing coverage thresholds
met. Lint, type checking, both builds, clean packed-CLI verification and the
official DSH interoperability fixture also passed. The Mac's default nine-worker
test run encountered wall-clock timeouts; the failed files passed independently
without changing their deadlines. The final full passing run used the existing
CI concurrency, not relaxed test timeouts or combined partial runs.

This is one successful bounded acceptance task, not a reliability rate for
all models or scenes. Swept-path collision safety, arbitrary embedded content
aesthetics, engineering accuracy and hardware XR acceptance were not established
by this run. The browser click and DOM were tested live; project reopen was
verified with the production loader offline, not a live-browser reload.

Upstream reference: [DSH CLI overlays and profile behavior](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md), [official generic MCP configuration example](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md#bring-another-mcp-server).
