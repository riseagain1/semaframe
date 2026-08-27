# Portable projects

SemaFrame has two project artifacts with different purposes:

| Artifact | Contents | Use it when |
| --- | --- | --- |
| `.semaframe.json` | Workspace metadata, descriptors, checkpoint, and resolved history; no Reality bytes | The destination already has the same content-addressed Reality objects, or relinking is acceptable |
| `.semaframe-project` | The validated direct project plus the complete required Reality byte closure | Moving or archiving a project across browser profiles or machines without separate Reality relinking |

The portable media type is `application/vnd.semaframe.project+zip`. Version `1.0` is a deterministic, uncompressed ZIP/ZIP64 container with this canonical layout:

```text
manifest.json
project/workspace.semaframe.json
objects/sha256/ab/abcdef...   # one path per Reality digest
```

`manifest.json` is canonical JSON and must be the first entry. The direct Workspace project must be second. Asset entries are sorted by digest and use their content-addressed path. There are no archive comments, encrypted entries, compression, symlinks, extra files, duplicate or case-colliding names, absolute paths, traversal segments, drive letters, or hidden bytes between entries.

## Export guarantees

`createPortableProjectBundle` first round-trips and verifies the direct project, including CAD evidence. It then computes the Reality closure needed by:

- the current Workspace catalog and Gaussian components;
- the checkpoint catalog and Gaussian components; and
- retained `register_reality_asset` and Gaussian `create_component` operations used by replay or undo.

Every source object is opened from the host vault and independently checked against its descriptor before the archive can be streamed. Export fails if any required byte object is absent, changed while streaming, has the wrong digest or size, or fails the PLY/SPZ/SOG preflight.

The bundle exposes a `ReadableStream` so a host can save a large valid project without materializing the entire archive in memory. `toBlob()` is a convenience path with a default 512 MiB materialization budget; callers should use streaming above that budget. The format itself follows existing Workspace limits: at most 128 Reality objects, 256 MiB per object, a 25 MiB direct project, and a 1 MiB manifest.

In the browser UI, true streaming save requires the File System Access API (`showSaveFilePicker`). Browsers without that API use the bounded `toBlob()` fallback and therefore cannot export a portable bundle above 512 MiB; for larger projects use a compatible Chromium/desktop host. This is a host limitation, not a ZIP-format limit.

## Import guarantees

Import is fail-closed and staged:

1. inspect exact ZIP or ZIP64 structure and limits;
2. require the canonical entry order and exact manifest closure;
3. verify CRC and SHA-256 for the project and every supplied Reality object;
4. deserialize, migrate, replay, and verify the embedded direct project;
5. independently preflight every Reality object even when an identical digest is already cached;
6. verify any cached descriptor and bytes before reusing them;
7. insert only missing verified objects; then
8. call the host's atomic project-replacement callback.

If object insertion or project replacement fails, newly inserted objects are removed in reverse order. A rollback failure is reported explicitly rather than being hidden as success. Existing content-addressed objects are never deleted by that rollback.

`importWorkspaceProjectArtifact` uses file magic, not only an extension, to distinguish a portable ZIP from a legacy direct JSON project. The direct JSON path remains supported and uses the same project/CAD verification, but it imports no Reality bytes.

## Security notes

- A portable project is project authority and may contain all user-authored Workspace semantics and history. Treat it as sensitive user data.
- It never contains provider credentials, feed approvals, MCP sessions, browser activation, or other ephemeral capabilities because the underlying direct project excludes them.
- Content addressing detects corruption; it does not authenticate who created the file. Use a trusted distribution or add an external signature when provenance matters.
- ZIP64 support permits valid offsets beyond 4 GiB, but every entry, aggregate byte count, path, and central directory remains bounded before allocation or reading.
