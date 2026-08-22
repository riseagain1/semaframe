# Third-party notices

SemaFrame's own source code and project-owned visual assets are distributed under the repository's [MIT License](LICENSE). Third-party packages retain their own licenses; installing the project does not relicense those packages under MIT.

The authoritative dependency list and resolved versions are recorded in `package.json` and `package-lock.json`. Runtime dependencies are predominantly MIT, Apache-2.0, BSD, ISC, MPL-2.0, and similarly permissive packages.

## Remotion video toolchain

The reproducible launch-video source under `video/` uses Remotion packages as development dependencies. Remotion is distributed under the separate [Remotion License](https://www.remotion.dev/license), not the SemaFrame MIT License. At the pinned 4.x version, Remotion permits free use by individuals, non-profit organizations, and for-profit organizations with up to three employees; other for-profit organizations may require a company license. Consult the upstream license before running or modifying the video toolchain.

Remotion is not included in the SemaFrame browser runtime. The rendered demo videos and the original generated score are project-owned outputs.

## Procedural assets

The built-in low-poly spatial assets and SemaFrame brand graphics in this repository are generated from project-owned procedural code and data. No third-party model files are bundled.

## Gaussian splat rendering

The optional Reality Layer lazy-loads the following pinned browser-runtime packages only when a Gaussian splat component is present:

| Package | Version | License | Upstream |
| --- | --- | --- | --- |
| `@sparkjsdev/spark` | 2.1.0 | MIT | <https://github.com/sparkjsdev/spark> |
| `three` | 0.180.0 | MIT | <https://github.com/mrdoob/three.js> |
| `fflate` | 0.8.3 | MIT | <https://github.com/101arrowz/fflate> |

The published Spark package metadata and included license file identify the distributed package as MIT. SemaFrame consumes that published distribution and does not bundle Spark source or training tools. Its implementation remains in a separate lazy chunk so projects without Reality Layer content do not download or initialize it.

## Geometry kernels

SemaFrame's optional modeling export paths lazy-load the following pinned browser-runtime packages:

| Package | Version | License | Upstream |
| --- | --- | --- | --- |
| `manifold-3d` | 3.5.1 | Apache-2.0 | <https://github.com/elalish/manifold> |
| `replicad` | 1.0.0 | MIT | <https://replicad.xyz/> |
| `replicad-opencascadejs` | 1.0.0 | LGPL-2.1-only | <https://github.com/sgenoud/replicad> |

Manifold provides the bounded watertight mesh CSG path. Replicad is the narrow TypeScript adapter around the OpenCascade Technology WebAssembly binary supplied by `replicad-opencascadejs`. These packages and their generated artifacts remain under their respective upstream licenses; SemaFrame's MIT license does not relicense them.

The exact license texts ship in each resolved package (`node_modules/manifold-3d/LICENSE`, `node_modules/replicad/LICENSE`, and `node_modules/replicad-opencascadejs/LICENSE`) and are available from the upstream projects above. Anyone redistributing a built browser bundle must preserve the applicable copyright and license notices and satisfy the LGPL-2.1-only requirements for the OpenCascade WebAssembly library, including applicable modification, relinking, and debugging rights. Release owners should review their distribution mechanism with qualified counsel; this notice is engineering documentation, not legal advice.

## Reality Twin preparation toolchain

The local-only Reality Twin source preparation and verification scripts use the following development dependencies. They are not included in the SemaFrame browser runtime.

| Package | Resolved version | License | Upstream |
| --- | --- | --- | --- |
| `@gltf-transform/core` | 4.4.2 | MIT | <https://github.com/donmccurdy/glTF-Transform> |
| `sharp` | 0.35.3 | Apache-2.0 | <https://github.com/lovell/sharp> |
| `@img/sharp-libvips-*` | 1.3.2 | LGPL-3.0-or-later | <https://github.com/lovell/sharp-libvips> |

The platform-specific `@img/sharp-libvips-*` package supplies the libvips binary used by `sharp`. Anyone redistributing that binary or a packaged preparation tool must preserve the applicable notices and satisfy the LGPL-3.0-or-later terms. The exact platform package is selected by npm; the resolved variants and versions are recorded in `package-lock.json`.
