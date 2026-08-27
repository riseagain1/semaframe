# Blender 4.5 LTS bridge

This extension pulls an immutable `.semaframe-exchange`, imports its self-contained GLB, retains `semaframeStableId` custom properties, and explicitly submits selected world-transform edits as a `semaframe-bridge-change-proposal` v1. SemaFrame remains authoritative; a submitted proposal is only queued for review.

## Install and use

1. Use Blender 4.5 LTS or newer. Build the extension with `blender --command extension build --source-dir integrations/blender/semaframe_bridge`, then install the resulting ZIP through **Preferences → Get Extensions → Install from Disk**.
2. Enable Blender's **Allow Online Access** setting. The adapter checks `bpy.app.online_access`, even though the only accepted destinations are `localhost`, `127.0.0.1`, and `::1`.
3. In SemaFrame, create a Bridge session targeting Blender and choose **Copy setup JSON**. In Blender's **3D View → SemaFrame**, choose **Connect from SemaFrame Clipboard**. The ordinary **Connect** dialog can also accept the complete document in **Setup JSON (masked)**; its endpoint/session/capability fields are only a manual fallback.
4. Choose **Pull Immutable Exchange**. Move selected imported objects, then choose **Propose Selected Transforms**. Review and approve or reject the proposal in SemaFrame.

The setup JSON and session capability are password-style `SKIP_SAVE` operator fields and are cleared from the dialog after every connection attempt. A successful connection retains only the capability in Blender process memory; it is never stored on objects or preferences and is cleared when the extension unloads. The client validates that setup URLs, target, session, and authorization agree, disables redirects, rejects non-loopback endpoints, validates the archive digest and each declared artifact, and rejects unsafe ZIP entries.

## Fidelity and limits

- Blender's bundled glTF importer is the visual path. The adapter requests scene extras so SemaFrame stable IDs survive as custom properties.
- The exchange's OpenUSD and optional STEP files remain available for pipeline use, but this adapter does not pretend that Blender creates native parametric CAD history from them.
- Only world transforms are proposed in v1. Geometry, modifiers, materials, new objects, and destructive edits are intentionally not round-tripped yet.
- Pull replaces objects previously marked `semaframeBridgeOwned`; save or duplicate local work before pulling a newer publication.
- The adapter makes no background network requests. Every pull and proposal is a visible operator action.
