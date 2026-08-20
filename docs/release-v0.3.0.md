# SemaFrame v0.3.0 — Spatial Modeling & Reality

SemaFrame v0.3.0 turns the semantic spatial workspace into an editable modeling and reality environment. An approved Agent can now build exact parametric assemblies, inspect collision and bounded physics evidence, publish reusable models, import a user-supplied Gaussian capture, connect it to semantic engineering proxies, preserve the result through undo/save/reopen, and export standard modeling formats while a person remains able to inspect and edit the same authoritative Workspace.

## Highlights

- **Parametric modeling:** exact SI primitives, editable assemblies, reusable digest-pinned models, numeric transforms, and collision-aware placement.
- **Interchange:** OpenUSD USDA, Manifold STL/OBJ, and an OpenCascade AP242 STEP subset from bounded lazy Workers.
- **Reality Layer:** PLY, SPZ v4, and SOG v2 Gaussian splats with explicit calibration, local content-addressed storage, digest relinking, semantic proxies, LOD, and context recovery.
- **Agent-native workflow:** 18 approval-gated MCP tools, descriptor-only Reality inspection, one-use streaming uploads, SSG 3.1 spatial understanding, and atomic revision-bound mutations.
- **One human/Agent authority:** UI edits, Agent transactions, rendering, history, persistence, data bindings, collision, and physics continue to share the same `WorkspaceStore`.

## Public contract changes

- Workspace Protocol / project schema: **1.3**
- SemaFrame Spatial Graph: **3.1**
- Agent Guide: **2.6**
- MCP server: **1.7.0**
- Public MCP tools: **18**
- Built-in components: **19**, including `spatial-primitive`, `model-assembly`, and `gaussian-splat`

Workspace 1.0 through 1.2 project files migrate through the validated serializer. Projects from the removed pre-Workspace Scene/Compose runtime remain intentionally unsupported.

## Upgrade

```bash
git pull
npm ci
npm run dev
```

Node.js 22.12 or newer is required. This repository remains a source-distributed browser application and is not published as an npm CLI package in v0.3.0.

The v0.3.0 GitHub Release should use GitHub's generated source archives only. Do not attach the current `dist/` directory as a binary distribution: the optional OpenCascade WebAssembly path requires a dedicated redistribution package with complete third-party license texts and corresponding-source/relinking information.

## Validation evidence

- TypeScript project references and demo source type-check successfully.
- Production Vite build succeeds with fingerprinted Manifold and OpenCascade WASM assets and a lazy Spark Reality chunk.
- Full Vitest suite: **103 files / 773 tests**.
- CAD, CSG, and Reality runtime bundle verifiers pass.
- Real browser Agent smoke and Workspace smoke pass, including approval, 18-tool discovery, SSG 3.1, persistence, responsive layout, and the exclusive pre-handshake connection gate.
- `npm audit --omit=dev`: **0 known vulnerabilities**.
- Independent Reality security/lifecycle audit: **no remaining P0/P1 findings** in the reviewed scope.

## Important boundaries

Gaussian splats remain visual-only. Collision, mass, support, structural feasibility, CAD export, and engineering claims must come from explicit parametric, asset, or assembly proxies. Current physics is bounded feasibility preflight rather than FEA or certification. Reality binaries stay in the importing browser's private asset vault and are not embedded in project JSON.

Third-party runtime obligations are documented in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), including the LGPL-2.1-only OpenCascade WebAssembly dependency used by the optional STEP path.
