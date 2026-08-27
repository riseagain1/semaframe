# Adapter compatibility and release checks

The repository separates deterministic contract validation from physical-host acceptance. Passing the repository verifier means the checked-in adapters agree with the SemaFrame protocol and pass the listed host-independent safety gates; it does not claim that a host application was installed or launched on that machine.

| Adapter | Pinned baseline | Repository gate | Physical-host release gate |
| --- | --- | --- | --- |
| Blender | 4.5 LTS | extension manifest, Python syntax, executable setup/unsafe-ZIP smoke with stubbed host API, protocol/security scan | build extension ZIP; install; paste setup JSON; pull GLB; move two parented nodes; submit; approve/reject; repull |
| FreeCAD | 1.0+ | CLI parser, Python syntax, executable setup/unsafe-ZIP smoke, protocol/security scan | `FreeCADCmd` setup-stdin pull of STEP and no-STEP exchanges; save/reopen; edit stable nodes; proposal/submit |
| Unity | 6 / `6000.0` | package/asmdef JSON and C# source-structure/protocol/security scan; no repository C# compilation | package import in clean Unity 6 project; paste setup JSON; GLB fallback; optional USD `1.0.0-pre.2`; domain reload; proposal |
| Unreal | 5.6+ | `.uplugin` JSON, Python syntax, executable setup/unsafe-ZIP smoke with stubbed host API, protocol/security scan | enable Python + USD plugins; consume setup environment; pull USD Stage; refresh IDs; edit parented prims; submit; stage reload |

## Cross-host acceptance fixture

A release candidate should publish the same fixture to every target. The fixture should contain:

- at least three nested, non-uniformly transformed 3D components with distinct stable IDs;
- one parametric mesh, one semantic-only node, and an optional exact STEP assembly;
- one hidden node and one material with opacity;
- one 2D component, one connector descriptor, and one event connection to confirm they remain semantic rather than being silently converted to 3D;
- metre-scale values that make axis/unit mistakes obvious.

For each host, record the imported stable-ID count, visual result, transformed values after round-trip, proposal source tuple, SemaFrame review result, and stale-proposal rejection after a new publication. Never accept screenshots alone as evidence of round-trip correctness.

## Honest fidelity boundary

- GLB is a visual interchange representation, not preserved parametric or CAD history.
- OpenUSD carries hierarchy, transforms, materials, and scene semantics within the exporter/host feature intersection; unsupported host features stay in the manifest/fidelity report.
- STEP carries exact B-rep geometry when exported, but downstream native constraints and feature trees are not synthesized.
- v1 adapter proposals are transform-only. Geometry editing and host-native behaviors are intentionally not described as round-trippable.

Upstream reference documentation: [Blender 4.5 extensions](https://docs.blender.org/manual/en/4.5/advanced/extensions/addons.html), [Unity USD Importer 1.0.0-pre.2](https://docs.unity3d.com/Packages/com.unity.importer.usd@latest/), [Unreal USD](https://dev.epicgames.com/documentation/unreal-engine/universal-scene-description-in-unreal-engine?lang=en-US), and [FreeCAD features/Python/import formats](https://www.freecad.org/features.php?lang=en_and_dwg_import).
