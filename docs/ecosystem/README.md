# SemaFrame ecosystem layer

SemaFrame's ecosystem layer extends one authoritative Workspace without giving an extension, catalog, or downstream desktop tool a second mutation path. It is made of versioned contracts that can be tested independently and then composed by the host.

The extension and service entries below are repository-source embedding contracts, not an installed end-user plugin runtime. The private application package has no compiled public npm SDK entrypoint, and the current app/gateway does not automatically construct the native extension host, extension grants, connector registry, artifact scheduler/HTTP handler, catalog installer, or diagnostics collector. An embedding host must import, configure, authorize, and expose the specific services it chooses; there is no built-in extension installation UI or public registry.

| Surface | Current contract | What it is for |
| --- | --- | --- |
| Portable project | `.semaframe-project` / `application/vnd.semaframe.project+zip` | Move a validated Workspace together with the Reality Asset bytes required by its current state, checkpoint, replay, and retained undo history |
| Scene Exchange | `.semaframe-exchange` / `application/vnd.semaframe.exchange+zip` | Send one immutable Workspace revision to Blender, FreeCAD, Unity, Unreal, or a custom downstream tool without transferring Workspace authority |
| Extension SDK | API `1.0` manifests, providers, grants, conformance helpers | Add connector, importer, exporter, or bridge providers behind host-owned capabilities |
| Native extension host | framed stdio protocol `1` | Run one verified native entrypoint with bounded messages, explicit authorization, cancellation, and hard process termination |
| Connector registry | `ConnectorRegistryV1` | Resolve built-in and extension connector types from an immutable, digest-bound registry captured for one Workspace session |
| Artifact jobs | `ArtifactJobService` / schema `1.0` | Schedule bounded exporter or bridge work and retain digest-addressed results for a limited time |
| Template catalog | signed static catalog schema `1` | Verify community project/model descriptors and turn them into reviewable Workspace transaction proposals |
| Diagnostics | anonymous performance schema `1` | Preview a tiny allowlisted performance payload; collection remains disabled unless the caller explicitly opts in and sends it |

These are compatibility contracts, not ambient authority. `WorkspaceStore` remains the only project authority, and a provider result is data until the host validates it and the person authorizes the corresponding operation.

## End-to-end workflows

### Move a complete project

1. Serialize and replay-verify the direct Workspace project.
2. Compute the full Reality closure, including descriptors referenced by the current state, checkpoint, retained register operations, and retained component creation operations.
3. Read every required object from the browser-owned vault and verify its size, SHA-256, media type, and format preflight.
4. Stream a canonical stored ZIP/ZIP64 archive with a canonical manifest, the direct Workspace JSON, and content-addressed Reality objects.
5. On import, validate the whole archive and project before mutating the destination. Stage missing objects, atomically replace the project, and remove newly inserted objects if the replacement rejects.

See [Portable projects](./portable-projects.md).

### Work in a downstream 3D tool

1. Export one immutable `.semaframe-exchange` revision.
2. Pull its semantic manifest, fidelity report, OpenUSD layer, self-contained GLB, and optional exact STEP artifact into the downstream tool.
3. Preserve SemaFrame stable IDs while editing only the supported downstream surface.
4. Return edits as a `semaframe-bridge-change-proposal` `1.0` document.
5. Review for source staleness, locks, invalid properties, placement-domain changes, missing nodes, and hierarchy cycles.
6. Translate only explicitly approved and eligible changes into ordinary Workspace operations. The normal revision, permission, 2D-layout, collision, and physics gates still decide whether the atomic batch commits.

See [Scene Exchange and bridges](./scene-exchange.md).

### Add a provider

1. Declare exact provider metadata, compatibility, package digest, permissions, and an optional Ed25519 signature in an Extension API `1.0` manifest.
2. Verify package length and SHA-256 before launch. A production installer can require a signature and supply its own pinned-key verifier.
3. Issue a time-bounded grant tied to the exact extension ID, version, manifest digest, Workspace, provider IDs, permissions, and optional network/secret scopes.
4. Invoke the provider through a host-owned broker or one owned stdio subprocess.
5. Normalize connector output into immutable snapshots, or run exporter/bridge work through the bounded artifact scheduler.

See [Extension SDK and native host](./extensions.md) and [Host services](./host-services.md).

## Trust boundaries

- An extension receives only the capabilities its host context exposes. The SDK has no ambient browser `fetch`, credential value, or filesystem-path API.
- A native stdio extension is an operating-system process, not a security sandbox. Package-root checks, a minimized environment, framed messages, timeouts, and process ownership reduce accidental authority; they do not make untrusted native code safe to install.
- Connector and artifact registries are immutable after creation. Installing code affects a later Workspace session rather than hot-swapping executable providers beneath an open project.
- Missing connectors fail to a read-only state so an existing immutable snapshot remains inspectable.
- Catalog verification authenticates a signed static index and digest-pinned descriptor. Installation planning still returns `authorization.status = "not_granted"` and cannot mutate a Store.
- Scene Exchange excludes connector configuration, secret references, feed snapshot values, host-owned local-path references, and Reality Asset bytes. User-authored semantic labels and tags remain user content. Its fidelity report states which representation was exact, parametric, visual, or semantic.
- Bridge bearers are session-scoped and held by the downstream tool. Pulls return immutable publications; proposals never mutate the Workspace directly.
- Anonymous diagnostics are off by default. Enabling payload construction is separate from sending, and the included collector has no vendor endpoint.

## Current limits

This layer does not yet provide a published npm SDK, a built-in extension installer/runtime UI, a hosted extension marketplace, dependency resolution, automatic updates, a general OS sandbox, arbitrary connector networking, or native feature-history reconstruction in external DCC/CAD tools. The included Blender, FreeCAD, Unity, and Unreal adapters are deliberately narrow and their repository checks do not replace physical testing in every supported host version and operating system.

The source entry points are:

- `src/extensions/` and `server/extensions/`;
- `src/ecosystem/` and `server/diagnostics/`;
- `src/workspace/data/ConnectorRegistry.ts`;
- `src/workspace/artifacts/` and `server/artifacts/`;
- `src/workspace/persistence/portable/`;
- `src/bridge/` and `server/bridge/`.
