# Unity 6 Editor bridge

`com.semaframe.bridge` is a Unity 6 (`6000.0`) editor package. It pulls immutable Scene Exchanges, preserves `SemaFrameStableId` components, and submits explicit transform proposals for SemaFrame review. It never writes directly to a Workspace.

## Install

In Unity Package Manager choose **Add package from disk** and select `integrations/unity/com.semaframe.bridge/package.json`, or copy the package into your project's `Packages` folder. The package pins Unity's Newtonsoft JSON package at `3.2.1`.

The adapter includes a deterministic importer for SemaFrame's GLB subset, so it works without a general-purpose glTF dependency. If you want the OpenUSD path, add Unity's official pre-release importer to your project manifest:

```json
"com.unity.importer.usd": "1.0.0-pre.2"
```

That USD importer is optional and pre-release. The Bridge first tries it when **Prefer USD Importer** is enabled, verifies that every exported USD prim maps to exactly one stable-ID object, and otherwise falls back to the bundled GLB path.

Open **Window → SemaFrame → Bridge**, create a SemaFrame Bridge session targeting Unity, choose **Copy setup JSON**, then choose **Paste setup JSON from clipboard** and **Connect** in Unity. The masked field also accepts direct paste; the three individual connection fields remain only as a manual fallback. Pull the latest exchange, edit imported transforms, and choose **Propose Changed Imported Transforms**. SemaFrame queues at most 100 changed nodes for human review.

## Security and fidelity

- Setup JSON and the capability are non-serialized fields that are cleared after each connection attempt. A successful connection retains only the capability in a runtime-only static value; neither is written to `EditorPrefs`, scenes, assets, logs, or package settings.
- The HTTP client accepts only explicit-port `localhost`, `127.0.0.1`, or `::1`, bypasses proxies, disables redirects, bounds reads, and validates the archive plus every declared artifact digest.
- Extraction is limited to the five Scene Exchange paths and rejects traversal, unknown paths, case-fold duplicates, and symbolic links.
- GLB meshes/materials and optional USD imports are persisted under `Assets/SemaFrameBridge`, so a saved scene can reopen without a live Bridge session. The adapter does not automatically delete those assets because another scene or prefab may reference them.
- Unity is left-handed Y-up. The GLB importer mirrors Z and winding; transform proposals reverse that conversion and emit metres/radians in SemaFrame's right-handed Y-up coordinates.
- v1 round-trips transforms only. Prefab overrides, colliders, materials, scripts, animation, and new Unity objects remain downstream-only work.
