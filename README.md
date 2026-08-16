# Scene Thread — Universal 2D/3D Workspace

Scene Thread is a browser-authoritative visual workspace. A project can combine a navigable Three.js world, ordinary 2D panels, timers and checklists, data-backed charts, safe website embeds, and bounded agent-defined components on one canvas.

There is one state authority: `WorkspaceStore` and Workspace Protocol 1.2. People edit through Components, Inspector, Sources, and direct canvas interaction. External agents use the same Workspace through approval-gated MCP or OpenAPI transactions. The retired Compose interpreter, Scene Protocol v0.2, SceneStore, and dual-project compatibility envelope are not part of the product.

## Run locally

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. The development command starts Vite and the loopback Agent Gateway. To run only the browser UI, use `npm run dev:vite`.

Production output:

```bash
npm run build
```

## One workspace

The Workspace is unlocked after an approved Agent completes the instruction handshake. Before that, the app shows only the Agent connection gate; committed project state remains preserved locally but is not editable until control reconnects:

- **Components** creates registered 2D and 3D components.
- **Inspector** edits the selected component and invokes its declared actions.
- **Sources** creates, previews, refreshes, binds, and manages data snapshots.
- Canvas controls move and resize components, frame content, reset the view, zoom, and enter presentation full screen.
- Project controls provide New, Open, Save, Undo, and Redo.
- **Manage** opens Agent connection settings without switching to another product mode.

A fresh project has zero components. `canvas2d` and `viewport` content needs no stage. Create exactly one `stage-3d` before adding `world3d`, `surface`, or `billboard` content.

The built-in registry contains `stage-3d`, `spatial-entity`, `group`, `panel`, `text`, `image`, `video-player`, `web-panel`, `data-panel`, `annotation`, `button`, `timer`, `checklist`, `chart`, `table`, and `document`.

## Agent connection

Any Streamable HTTP MCP-capable client can operate the open Workspace:

1. Choose **Manage** in the Agent controls.
2. Enable Agent control and copy the short-lived connection URL.
3. Add that URL as an MCP server or connector in the external client.
4. The client reads `workspace://instructions/v1` and calls `get_workspace_instructions` first.
5. Verify its name, fingerprint, and requested scopes in Scene Thread, then approve it.
6. The client inspects and changes the same open project through revision-bound transactions.

The URL contains a random offer identifier, not authority. The first instruction request creates a separate approval claim that only the authoritative browser can approve. A completed endpoint remains active until replaced or revoked. Failed or expired incomplete offers can be replaced with **Create fresh URL**.

Voice, realtime, and multimodal clients use this same contract. They keep partial model output in client-side preview state and submit only final intent through `begin_workspace_update` and `submit_workspace_batch`. Scene Thread owns validation, transactions, rendering, history, and permissions; it does not bundle a model or voice transport.

The gateway exposes exactly thirteen Workspace tools:

- `get_workspace_instructions`
- `inspect_workspace`
- `inspect_workspace_component`
- `inspect_workspace_space`
- `query_spatial_placement`
- `inspect_workspace_physics`
- `query_stable_placement`
- `simulate_workspace_physics`
- `begin_workspace_update`
- `submit_workspace_batch`
- `undo_workspace_batch`
- `redo_workspace_batch`
- `read_workspace_events`

For clients without MCP, the gateway publishes OpenAPI 3.1 at `http://127.0.0.1:8788/openapi.json` with bearer-authenticated `/v1/workspace/*` routes. `npm run agent:mcp` provides a stdio bridge.

The gateway starts disabled, binds to loopback, and keeps approval, session, and transaction capabilities out of URLs, browser storage, recovery data, and project files. **Revoke pairing** invalidates the active offer and sessions. Closing the authoritative browser makes the engine unavailable rather than creating a hidden second workspace.

## Universal canvas

Every object is a versioned component with typed props, durable state, placement, locks, bindings, events, provenance, and a pinned content digest. Placement spaces are:

For model spatial reasoning, `inspect_workspace_space` returns a revision-bound **Universal Space Data** projection: parent-aware world transforms, stable prim paths, asset-derived world bounds, exact collider parts, rigid-body intent, and support/intersection relations. `since_revision` requests a delta when it is unambiguous. This is a derived JSON view of the authoritative Workspace, not a second scene database or an OpenUSD file.

New `spatial-entity@1.5.0` components support `asset_bounds`, explicit box, and up to 16 compound oriented-box collider parts. Solid overlaps reject the entire atomic update; touching faces and trigger volumes are handled explicitly. Parent/child faces may attach through their safety margin, but actual solid penetration remains invalid. The Inspector edits collision shapes and rigid-body properties.

The same manifest persists an explicit physics master switch, static/dynamic/kinematic body type, mass, center-of-mass offset, friction, restitution, gravity scale, report/enforce stability mode, and up to 16 fixed/hinge/slider/ball constraints. Turning physics off preserves those values while removing the body from support, constraint, and settle participation; collision remains independently controlled. Physics report 2.0 derives exact horizontal OBB/compound contact polygons, finite-Stage contact, recursive grounded load paths, world COM, stability margin, collisions, and conservative joint equilibrium. Disabled, trigger, none, hidden, unsupported, or unstable bodies cannot carry another body. `query_stable_placement` preflights one candidate. `simulate_workspace_physics` runs a bounded, deterministic, fixed-step vertical drop preview and returns absolute placement proposals plus explicit modeled/ignored properties. It validates layout feasibility and quasi-static support; it does not claim frictional sliding, bounce, angular dynamics, stress, fracture, soft bodies, fluids, or general engineering feasibility.

- `world3d`: spatial content inside the Stage;
- `canvas2d`: content on the zoomable 2D plane;
- `surface`: a 2D component attached to a named component surface;
- `billboard`: screen-facing content anchored to a 3D target; and
- `viewport`: fixed HUD-style content.

### Navigation and presentation

Scroll or pinch over the 3D background to zoom the spatial world and 2D plane around the pointer. `viewport` components remain fixed in screen pixels. **Frame all** recovers both layers and **Reset view** restores the canonical camera. Navigation is browser-local and does not change revision, history, dirty state, saved files, or Agent authority.

Full screen hides editing chrome while keeping 2D and 3D components live. It is browser-local presentation state and never creates a Workspace operation or undo entry.

### Geometry, effects, and animation

Every manifest declares a resize policy for each supported placement. Geometry is one of `box2d`, `scale3d`, `stage_dimensions`, or `none`. The engine validates absolute geometry, bounds, locks, aspect/uniform constraints, and placement compatibility rather than silently clamping commands.

All components support renderer-neutral opacity, emissive color/intensity, glow, visibility actions, and bounded transitions. A transition has duration, optional delay, and a closed easing value. Final semantic state commits once; DOM and Three.js interpolate that revision without per-frame history writes and honor reduced-motion preferences.

Spatial components expose discoverable animation clips and durable `play_animation`/`stop_animation` actions. Playback starts only while both the entity and Stage are visible. Hiding or collapsing either one deterministically stops active playback. Renderer completion is a host-only signal and cannot be forged by an Agent or unattended event route.

### Cross-component actions

`connect_event` executes declared semantic actions in the same atomic Workspace commit as the source event. Routes are cycle-checked, bounded, deterministically ordered, permission-checked again at execution, and recorded with causation. Privileged network, external-write, and extension effects cannot be wired for unattended execution.

Examples:

- a 2D button can start a supported 3D animation;
- double-click or Enter/Space on a spatial object can show or hide a 2D panel;
- a completed timer can add an item to a checklist.

Connections may provide static validated input or forward the complete event payload when source and target schemas are exactly identical. Arbitrary expressions and JavaScript are never evaluated.

## Media and websites

### Video player

`video-player` supports normalized YouTube, Vimeo, and public HTTPS MP4/WebM sources. It begins as a facade and creates no iframe or media element until a person chooses **Load video**. Private, DRM, owner-disabled, unsupported, or expired media may remain unavailable. Pasted iframe HTML and credential-bearing URLs are rejected.

### Website panel

`web-panel` embeds an approved public HTTPS page in a resizable 2D panel. It always starts as a no-network facade. A person must choose **Load website** for that exact component instance; URL changes, project replacement, and component recreation require another gesture.

The Store rejects HTTP, local/private/special-use targets, custom ports, embedded credentials, signed/session/login capability patterns, and other recognized secret-bearing URLs. The frame uses an opaque-origin `allow-scripts` sandbox with no forms, same-origin authority, popup, top-navigation, referrer, or ambient browser permissions. **Unload** destroys it and **Open in browser** is an explicit fallback.

Not every website can be embedded. A remote site may refuse framing with CSP or `X-Frame-Options`, and browsers do not expose a reliable cross-origin load-success signal. Scene Thread reports that an embed was requested, not that the site loaded. Truly arbitrary browsing requires a separate trusted browser or native webview surface.

## Data feeds and bindings

Resources store a connector type/version, safe public configuration, last-good immutable snapshot, content hash, retrieval time, refresh policy, and bounded provenance. Credentials are never persisted.

Two data paths are available:

- `inline.snapshot@1.0.0`: paste or Agent-submit bounded JSON/CSV-like data with no network execution.
- `http.feed@1.0.0`: a person previews a public HTTPS JSON, CSV, RSS, or Atom endpoint through the trusted loopback broker.

The feed broker sends no cookies, credentials, custom headers, or request body. It revalidates DNS and redirects, blocks private/link-local targets, pins TLS to the validated address, and bounds time, redirects, concurrency, compressed and decoded size, XML structure, output schema, and credential-like content. Preview/fetch uses a short-lived single-use server-held approval capability bound to the canonical URL and format.

Manual refresh is always an explicit local action. Interval and on-open automation is authorized only by an in-memory consent recorded after a successful preview and matching save; opening or restoring an untrusted project cannot start network reads. Changing URL, format, policy, project, or resource revokes that automation consent.

`bind_resource` projects snapshot values into writable component props through closed transforms. Binding `$.labels` and `$.series` creates a stock chart; binding `$` to `data-panel.data` renders a general feed as a bounded table, card list, or inert JSON view. Projection does not mutate canonical component props or create a revision. Refreshes produce discrete replayable snapshots; SSE, WebSockets, credentialed APIs, arbitrary request headers/bodies, and private-network endpoints remain outside the connector.

Agents can inspect an existing host feed and bind it to components, but cannot mint feed approval, initiate network reads, forge host provenance, or create `http.feed` resources.

## Agent-defined components

An approved Agent can define a bounded declarative `recipe.*` component type in one transaction, then inspect and create it with its canonical pinned digest in a second transaction. Recipes declare schemas, defaults, writable props, actions, events, placements, resize policies, and a bounded node tree.

The renderer accepts only its closed data-only vocabulary: stacks, grids, overlays, scrolling, text, shapes, images, icons, charts, tables, asset placeholders, buttons, sliders, toggles, inputs, and timers. Recipes cannot execute HTML, JavaScript, JSX, iframe code, shaders, network requests, or arbitrary packages. Untrusted schemas reject regular expressions, references, unbounded combinators, and other synchronous validation-amplification paths.

## Workspace Protocol 1.2

The closed protocol supports 19 operations:

- lifecycle: `define_component_recipe`, `create_component`, `update_component`, `upgrade_component_manifest`, `delete_component`;
- layout: `place_component`, `resize_component`, `attach_component`, `detach_component`;
- behavior: `set_component_visual_effects`, `invoke_component_action`;
- data: `upsert_resource`, `delete_resource`, `bind_resource`, `unbind_resource`;
- wiring: `connect_event`, `disconnect_event`;
- metadata/reset: `present_view`, `clear_workspace`.

Every batch carries exact Workspace identity, revisions, registry digest, request ID, and a bounded operation array. Validation and reduction happen on a draft; any failure leaves authoritative state unchanged. Identical retries are idempotent. Changed retries, stale revisions, unknown fields, unpinned component digests, and missing permissions fail closed.

Saved components remain pinned to their manifest version. `upgrade_component_manifest` explicitly repins a compatible older built-in as one atomic, undoable, replayable operation. Workspace 1.0 and 1.1 project migrations remain supported; this is Workspace version migration, not the removed Scene compatibility system.

## Saved projects

**Save** exports one direct `WorkspaceProjectFile` (`formatVersion: "1.0"`) containing:

- the checkpoint and current Workspace state;
- component recipes, pins, geometry, state, locks, aliases, and provenance;
- resources, bindings, event connections, and shared views;
- monotonic component/event counters; and
- resolved command and event history for deterministic replay.

Open validates the closed schema, versions, registry digests, counters, command continuity, resource invariants, and replay before replacing the current project. It never reruns actions, models, assets, or connector reads.

Legacy Scene v0.2 files and the former dual `scene-thread-workspace` envelope are intentionally unsupported. Local recovery uses the same Workspace-only format. Provider credentials, feed approvals, MCP approvals, session tokens, and transaction tokens are never saved.

## Architecture

```text
Human tools ──────────────────────────────────────────────┐
Agent client ─→ MCP/OpenAPI approval + session + tx ─────┤
Feed preview ─→ one-use approval + bounded HTTPS broker ─┤
                                                          ▼
                                                WorkspaceStore 1.2
                                                          │
                                              semantic render snapshot
                                                 ┌────────┴────────┐
                                      Three.js spatial layer   DOM/SVG 2D layer
```

Key invariants:

- `WorkspaceStore` is the only project authority.
- State is semantic and renderer-independent; Three.js and DOM/SVG are projections.
- Stable IDs and event cursors are monotonic and restored from projects.
- Type versions/digests pin validation and replay behavior.
- Timed and routed actions store resolved effects so replay does not depend on wall-clock execution.
- Resources carry host-validated hashes and provenance while secrets remain outside the Workspace.
- One coherent intent is one atomic batch and one undo step; host settlement is excluded from user undo history.

The renderer still uses a compact internal spatial render DTO for Three.js deltas. It is not a second Store, public protocol, persistence format, or Agent API.

## Verification

```bash
npm run typecheck
npm test -- --run --maxWorkers=2
npm run build
npm run smoke:workspace
npm run smoke:agent
```

- `smoke:workspace` verifies the always-visible Workspace, mixed 2D/3D canvas, component creation and actions, direct Workspace project save/open, undo/redo, responsive layout, and console health.
- `smoke:agent` uses a real Streamable HTTP MCP client and browser. It covers connection offers, multi-tab lease conflict/takeover, approval, instruction-first behavior, Workspace creation/data/event flows, idempotency, undo/redo, persistence, revocation, responsive layout, and capability-secret scans.

Unit and integration tests cover all Workspace operations, component manifests and recipes, video and website security, placements and geometry, timers/buttons/spatial actions, deterministic event routing, data-feed security and consent, binding projection, transitions and reduced motion, permissions, stale contexts, rollback, idempotency, persistence/replay, hybrid rendering, and gateway MCP/OpenAPI contracts.
