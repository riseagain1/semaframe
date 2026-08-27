# Contributing to SemaFrame

Thank you for helping improve SemaFrame. The project values changes that keep the Workspace semantic, deterministic, inspectable, and safe for both people and Agents.

## Before opening a change

- Use [GitHub Discussions](https://github.com/riseagain1/semaframe/discussions) for architecture proposals, new public protocol operations, or large UX changes.
- Use an issue for reproducible bugs and bounded feature requests.
- Report security issues privately according to [SECURITY.md](SECURITY.md).
- Keep pull requests focused. Separate refactors from behavioral changes when practical.

## Local setup

Requirements:

- Node.js 22.12 or newer
- npm
- a modern browser with WebGL support for browser smoke tests

```bash
git clone https://github.com/riseagain1/semaframe.git
cd semaframe
npm ci
npm run dev
```

## Required verification

Run the deterministic local gate before opening a pull request:

```bash
npm run typecheck
npm run demo:typecheck
npm run build
npm test -- --run --maxWorkers=2
npm run test:cad:bundle
npm run test:csg:bundle
npm run test:reality:runtime
npm run test:p2:ecosystem
```

`test:p2:ecosystem` covers extension and provider contracts, portable projects, Scene Exchange, and host-independent adapter checks. It executes the pure Python setup/archive behavior for Blender, FreeCAD, and Unreal, but cannot launch those applications or compile Unity C#; changes to a first-party adapter still require the physical-host matrix in [`docs/bridges/compatibility.md`](docs/bridges/compatibility.md) before a supported-host release claim.

Changes to connection, rendering, persistence, or browser security should also run the relevant smoke flow when the environment provides Chrome:

```bash
npm run smoke:workspace
npm run smoke:agent
```

## Architecture expectations

- `WorkspaceStore` remains the sole project authority.
- Public contracts stay closed, bounded, versioned, and schema validated.
- Agent mutations remain revision-bound, permission checked, atomic, and replayable.
- Renderers project semantic state; they do not become a second state authority.
- Host-only approvals, secrets, and capabilities never enter saved projects or diagnostics.
- Physics and spatial claims must state modeled and unmodeled properties honestly.

When a public contract changes, update its JSON Schema, TypeScript type, controller or adapter, Agent guide, focused regression, and at least one cross-layer test together.

## Community templates

Project and model templates are declarative Workspace Protocol transactions, not installer scripts. A contribution must:

- conform to `src/ecosystem/catalog/templateDescriptor.schema.json` and the stricter runtime parser;
- use exact, digest-pinned component references and declare every permission required by its operations;
- contain no executable installer hook, credential, remote script, or implicit authorization;
- keep component IDs and placements deterministic, with no blocking 2D or 3D overlap;
- state its SPDX license and include attribution for any bundled asset;
- add a conformance test under `src/tests/ecosystem/`.

Catalog entries are merged only after the descriptor bytes are assigned a SHA-256 digest. Release maintainers publish the signed catalog sequence; contributors never submit or reuse a release signing key. See [Template catalog and contributions](docs/extensions/template-catalog.md).

## Pull requests

A good pull request includes:

- the user-visible outcome and motivation;
- the security, persistence, and compatibility impact;
- tests that fail without the change;
- screenshots or short recordings for material UI changes;
- documentation updates for changed public behavior.

By contributing, you agree that your contributions are licensed under the repository's [MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
