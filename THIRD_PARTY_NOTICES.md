# Third-party notices

SemaFrame's own source code and project-owned visual assets are distributed under the repository's [MIT License](LICENSE). Third-party packages retain their own licenses; installing the project does not relicense those packages under MIT.

The authoritative dependency list and resolved versions are recorded in `package.json` and `package-lock.json`. Runtime dependencies are predominantly MIT, Apache-2.0, BSD, ISC, MPL-2.0, and similarly permissive packages.

## Remotion video toolchain

The reproducible launch-video source under `video/` uses Remotion packages as development dependencies. Remotion is distributed under the separate [Remotion License](https://www.remotion.dev/license), not the SemaFrame MIT License. At the pinned 4.x version, Remotion permits free use by individuals, non-profit organizations, and for-profit organizations with up to three employees; other for-profit organizations may require a company license. Consult the upstream license before running or modifying the video toolchain.

Remotion is not included in the SemaFrame browser runtime. The rendered demo videos and the original generated score are project-owned outputs.

## Procedural assets

The built-in low-poly spatial assets and SemaFrame brand graphics in this repository are generated from project-owned procedural code and data. No third-party model files are bundled.
