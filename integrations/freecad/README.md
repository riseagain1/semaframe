# FreeCAD 1.0+ bridge

`semaframe_bridge.py` is a headless-friendly FreeCAD adapter. It prefers the exchange's exact AP242 STEP artifact, uses GLB when the running FreeCAD build has an importer, and preserves the OpenUSD file as an explicit semantic fallback. Every world-space exchange node also becomes an editable `App::Part` with a `SemaFrameStableId`, so transforms can make a deterministic round trip even when imported CAD topology has no one-to-one SemaFrame identity.

## Pull, edit, propose

Create a Bridge session targeting FreeCAD, copy its setup JSON, then pipe it directly from the clipboard into FreeCAD 1.0 or newer. On macOS:

```sh
pbpaste | FreeCADCmd integrations/freecad/semaframe_bridge.py pull \
  --setup-stdin \
  --output scene.FCStd

FreeCADCmd integrations/freecad/semaframe_bridge.py proposal \
  --document scene.FCStd \
  --output proposal.json

pbpaste | FreeCADCmd integrations/freecad/semaframe_bridge.py submit \
  --setup-stdin \
  --proposal proposal.json
```

PowerShell users can replace `pbpaste |` with `Get-Clipboard |`. The adapter validates the complete setup document, including its target, UUID, two loopback URLs, and bearer header. For a manual fallback, omit `--setup-stdin`, pass `--endpoint` and `--session`, and enter the capability at the masked prompt; automation may use `--bearer-stdin` for exactly one capability line. There is deliberately no `--bearer` argument, setup-file option, environment-variable fallback, or document property for credentials.

The client accepts only explicit-port loopback endpoints, disables redirects, verifies the complete archive digest and declared file digests, and rejects unknown, encrypted, duplicate, symlink, or traversal ZIP entries.

## Fidelity and limits

- The exact STEP file is authoritative geometry when present, but native FreeCAD feature history and constraints cannot be inferred from neutral STEP. SemaFrame semantic node holders remain separate from imported STEP shapes in v1.
- GLB availability depends on the installed FreeCAD import modules. If unavailable, the document remains a useful semantic/hierarchy handoff and embeds the OpenUSD source lines on `SemaFrameUsdReference`, but it will not fabricate CAD solids from a visual mesh.
- SemaFrame scale is exposed as three properties because a FreeCAD `Placement` does not carry non-uniform scale.
- Stable-node translations convert SemaFrame metres/right-handed Y-up to FreeCAD millimetres/right-handed Z-up and reverse that conversion in proposals. The exact STEP container receives the same Y-up to Z-up basis rotation; STEP's declared metre unit is handled by FreeCAD's importer.
- v1 proposals contain at most 100 changed stable-node transforms. They never write back to the Workspace directly and always require review.
