# Scene Exchange Bridge Protocol v1

The host-owned bridge surface is deliberately fixed. Dynamic adapters do not create new MCP tools and do not receive direct access to the Workspace store.

## Pull surface

Every request uses `Authorization: Bearer CAPABILITY`, and public responses use `Cache-Control: no-store`.

- `GET /v1/bridge/sessions/{sessionId}` returns `{ "ok": true, "data": BridgeSessionView }`. `?after_sequence=N` may return `204` when there is no newer immutable publication.
- `GET /v1/bridge/sessions/{sessionId}/exchange?digest=sha256:...` returns `application/vnd.semaframe.exchange+zip`. The digest precondition prevents an adapter from accidentally downloading a publication that changed between the view and exchange requests.
- `POST /v1/bridge/sessions/{sessionId}/proposals` accepts a `semaframe-bridge-change-proposal` v1 and returns `202` with `{ "status": "review_required" }`.

Redirects are intentionally not part of the protocol. First-party adapters accept only `localhost`, `127.0.0.1`, or `::1` with an explicit port and disable redirects; Unity and Unreal also bypass configured HTTP proxies for this local capability channel.

## Immutable exchange

The `.semaframe-exchange` is a ZIP with an exact path allowlist:

- `semaframe.exchange.json`
- `fidelity-report.json`
- `scene.usda`
- `geometry.glb`
- optional `exact/model.step`

Adapters verify the archive SHA-256 supplied by the publication, then verify every file's `byteLength` and `sha256` from `semaframe.exchange.json`. They reject unknown paths, absolute paths, backslashes, empty/dot/parent segments, encryption, symlinks, duplicate or case-fold-colliding entries, and expanded content beyond the adapter limit.

`semaframe.exchange.json` declares metre units, right handedness, Y-up, radians, source Workspace/revision/digests, stable nodes, semantic resources/connections, fidelity, and the available artifacts. Connector values, connector configuration, errors, secret handles, and live snapshots do not cross this boundary.

## Stable identity

The same SemaFrame component ID appears as:

- manifest `nodes[].stableId`;
- OpenUSD prim path mapping in `nodes[].usdPrimPath` when applicable;
- GLB node extras `semaframeStableId` and `nodes[].gltfNodeIndex` when applicable;
- host-specific custom property, component, document property, or USD component tag.

Labels and downstream object names are display data, not identity. Blender has a label-only fallback solely for old/broken glTF importer behavior and accepts it only when the label is unique.

## Reviewable change proposal

A proposal has an exact source tuple and cannot float across publications:

```json
{
  "format": "semaframe-bridge-change-proposal",
  "version": "1.0",
  "proposalId": "blender-UUID",
  "target": "blender",
  "source": {
    "workspaceId": "WORKSPACE",
    "baseRevision": 42,
    "exchangeDigest": "sha256:..."
  },
  "changes": [
    {
      "changeId": "blender-transform-1",
      "kind": "transform",
      "componentId": "stable-component-id",
      "placement": {
        "space": "world3d",
        "position": { "x": 0, "y": 1, "z": 0 },
        "rotation": { "x": 0, "y": 0, "z": 0 },
        "scale": { "x": 1, "y": 1, "z": 1 }
      }
    }
  ]
}
```

SemaFrame parses the proposal with exact-key, finite-number, ID, size, count, target, revision, and digest checks. It then produces an eligibility review. Only the SemaFrame owner can choose whether eligible changes enter a normal Workspace update transaction.
