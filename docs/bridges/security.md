# Bridge security model

The Bridge bearer is a scoped, short-lived capability for one session and one target. It can read the current immutable publication and submit matching proposals; it cannot create/publish/close sessions, read other proposal queues, access connector credentials, or directly mutate the Workspace.

## Adapter guarantees

- **Loopback only:** first-party clients compare the literal hostname with `localhost`, `127.0.0.1`, or `::1`; they do not resolve an arbitrary hostname and trust a loopback result.
- **No redirect expansion:** redirects are disabled so an accepted loopback request cannot carry its bearer to another origin.
- **No proxy forwarding:** all first-party adapters bypass configured HTTP proxies for the local capability channel.
- **No credential persistence:** Blender uses a password-style `SKIP_SAVE` operator field; FreeCAD reads a masked prompt or stdin; Unity uses a non-serialized editor field; Unreal pops a process environment variable. No adapter writes the capability into preferences, project files, scene metadata, object tags, command arguments, or logs.
- **Content validation before import:** adapters bound network and expanded sizes, validate SHA-256, enforce a path allowlist, and reject traversal/symlink/duplicate/encrypted entries before handing files to a host importer.
- **Explicit write-back:** no adapter watches or submits in the background. A named command/operator/button produces a proposal whose receipt must say `review_required`.

## Operational guidance

- Treat the capability like a password until the session expires or is closed. Do not paste it into issue trackers, screenshots, shell command arguments, or recorded demo consoles.
- Create a new session after sharing a `.blend`, `.FCStd`, Unity scene, or Unreal project. Those files contain source IDs and digests for provenance, but should never contain the bearer.
- Close a session when downstream review finishes. Re-publish after each authoritative Workspace revision rather than trying to merge silently in a host.
- Only install adapters from a reviewed build. A host extension runs with the host application's file and network authority even though the SemaFrame capability itself is constrained.

## Explicit non-goals in v1

- internet or LAN Bridge endpoints;
- arbitrary adapter-provided executable UI inside SemaFrame;
- secret/connector-data export;
- automatic conflict resolution;
- direct bidirectional file watching;
- native CAD feature-history synthesis or lossless engine-specific material/script round-trip.
