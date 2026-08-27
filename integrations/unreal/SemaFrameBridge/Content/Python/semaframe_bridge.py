"""Unreal Editor 5.6+ adapter for SemaFrame Scene Exchange v1.

The adapter consumes copied setup JSON from SEMAFRAME_BRIDGE_SETUP (or the
manual bearer fallback) and immediately removes it from the process environment.
Credentials are never accepted as console arguments, logged, tagged on an Actor,
or written to project files.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import pathlib
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

import unreal


ADAPTER_VERSION = "1.0.0"
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_JSON_BYTES = 1024 * 1024
MAX_SETUP_BYTES = 64 * 1024
ALLOWED_ENTRIES = {
    "semaframe.exchange.json",
    "fidelity-report.json",
    "scene.usda",
    "geometry.glb",
    "exact/model.step",
}
BRIDGE_ACTOR_TAG = "SemaFrameBridgeOwned"
_PENDING_SETUP = os.environ.pop("SEMAFRAME_BRIDGE_SETUP", "")
_PENDING_BEARER = os.environ.pop("SEMAFRAME_BRIDGE_BEARER", "")
_RUNTIME = {
    "endpoint": "",
    "session": "",
    "bearer": "",
    "view": None,
    "manifest": None,
    "stage_actor": None,
    "components": {},
    "baselines": {},
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        del request, file_pointer, code, message, headers, new_url
        raise urllib.error.HTTPError("", 403, "Bridge redirects are disabled", {}, None)


def _endpoint(value: str) -> str:
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Bridge endpoint must use http or https")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Bridge endpoint must resolve to the local machine")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Bridge endpoint cannot contain credentials, query, or fragment")
    if parsed.path not in {"", "/"} or parsed.port is None:
        raise ValueError("Bridge endpoint must contain only a host and explicit port")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


def _session(value: str) -> str:
    return str(uuid.UUID(value.strip()))


def _parse_setup_json(text: str):
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_SETUP_BYTES:
        raise ValueError("Bridge setup JSON is missing or exceeds 64 KiB")
    try:
        setup = json.loads(text)
    except json.JSONDecodeError as cause:
        raise ValueError("Bridge setup JSON is invalid") from cause
    if not isinstance(setup, dict) or setup.get("format") != "semaframe-bridge-setup" or setup.get("version") != "1.0":
        raise ValueError("Bridge setup JSON is unsupported")
    if setup.get("target") != "unreal":
        raise ValueError("Bridge setup JSON targets another host")
    session = _session(setup.get("sessionId", ""))
    pull = urllib.parse.urlsplit(setup.get("pullUrl", ""))
    exchange = urllib.parse.urlsplit(setup.get("exchangeUrl", ""))
    expected_path = f"/v1/bridge/sessions/{session}"
    if (
        pull.path != expected_path
        or pull.query
        or pull.fragment
        or exchange.path != expected_path + "/exchange"
        or exchange.query
        or exchange.fragment
        or pull.scheme != exchange.scheme
        or pull.netloc != exchange.netloc
    ):
        raise ValueError("Bridge setup URLs do not match its session")
    endpoint = _endpoint(urllib.parse.urlunsplit((pull.scheme, pull.netloc, "", "", "")))
    authorization = setup.get("authorization")
    if not isinstance(authorization, dict) or authorization.get("header") != "Authorization":
        raise ValueError("Bridge setup authorization header is unsupported")
    value = authorization.get("value")
    if not isinstance(value, str) or not value.startswith("Bearer "):
        raise ValueError("Bridge setup authorization must use Bearer")
    capability = value[7:]
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", capability):
        raise ValueError("Bridge setup capability is invalid")
    return endpoint, session, capability


def _request(path: str, *, method="GET", payload=None, maximum=MAX_ARCHIVE_BYTES):
    if not _RUNTIME["endpoint"] or not _RUNTIME["session"] or not _RUNTIME["bearer"]:
        raise RuntimeError("Connect the SemaFrame Bridge first")
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    outbound = urllib.request.Request(
        f"{_RUNTIME['endpoint']}/v1/bridge/sessions/{_RUNTIME['session']}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {_RUNTIME['bearer']}",
            "Accept": "application/json, application/vnd.semaframe.exchange+zip",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(outbound, timeout=30) as response:
        data = response.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("Bridge response exceeds the adapter limit")
        return response.status, response.headers, data


def _view():
    status, _headers, data = _request("", maximum=MAX_JSON_BYTES)
    if status != 200:
        raise RuntimeError(f"Unexpected Bridge status {status}")
    envelope = json.loads(data.decode("utf-8"))
    view = envelope.get("data") if isinstance(envelope, dict) and envelope.get("ok") is True else None
    if not isinstance(view, dict) or view.get("target") != "unreal":
        raise ValueError("Bridge response is invalid or targets another host")
    return view


def connect_from_environment(endpoint="http://127.0.0.1:8788", session=None):
    """Connect without putting setup or a capability into Output Log history.

    Prefer SEMAFRAME_BRIDGE_SETUP in the environment that launches the Editor.
    Environment values are popped when this module loads and cleared after use.
    """
    global _PENDING_SETUP, _PENDING_BEARER
    setup = _PENDING_SETUP or os.environ.pop("SEMAFRAME_BRIDGE_SETUP", "")
    capability = _PENDING_BEARER or os.environ.pop("SEMAFRAME_BRIDGE_BEARER", "")
    _PENDING_SETUP = ""
    _PENDING_BEARER = ""
    try:
        if setup:
            endpoint, session, capability = _parse_setup_json(setup)
        elif not re.fullmatch(r"[A-Za-z0-9_-]{43}", capability):
            raise ValueError("SEMAFRAME_BRIDGE_SETUP is required (or provide the manual bearer fallback)")
        _RUNTIME.update(endpoint=_endpoint(endpoint), session=_session(session or ""), bearer=capability)
        view = _view()
        _RUNTIME["view"] = view
        unreal.log("SemaFrame Bridge connected; capability retained in process memory only")
        return {"target": view["target"], "expiresAt": view["expiresAt"], "revision": view["publication"]["revision"]}
    except Exception:
        _RUNTIME.update(endpoint="", session="", bearer="", view=None)
        raise
    finally:
        setup = ""
        capability = ""


def disconnect():
    _RUNTIME.update(endpoint="", session="", bearer="", view=None, manifest=None, stage_actor=None, components={}, baselines={})
    unreal.log("SemaFrame Bridge disconnected")


def _validate_archive(archive: bytes, destination: pathlib.Path):
    values = {}
    casefolded = set()
    expanded = 0
    with zipfile.ZipFile(io.BytesIO(archive), "r") as package:
        for info in package.infolist():
            name = info.filename
            parts = pathlib.PurePosixPath(name).parts
            if (
                name not in ALLOWED_ENTRIES
                or name.startswith("/")
                or "\\" in name
                or any(part in {"", ".", ".."} for part in parts)
                or info.flag_bits & 0x1
                or ((info.external_attr >> 16) & 0o170000) == 0o120000
                or name.casefold() in casefolded
            ):
                raise ValueError(f"Unsafe or unknown exchange entry: {name}")
            casefolded.add(name.casefold())
            expanded += info.file_size
            if expanded > MAX_ARCHIVE_BYTES:
                raise ValueError("Expanded exchange exceeds the adapter limit")
            values[name] = package.read(info)
    required = {"semaframe.exchange.json", "fidelity-report.json", "scene.usda", "geometry.glb"}
    if not required.issubset(values):
        raise ValueError("Exchange is missing a required file")
    if len(values["semaframe.exchange.json"]) > MAX_JSON_BYTES:
        raise ValueError("Exchange manifest exceeds the adapter limit")
    manifest = json.loads(values["semaframe.exchange.json"].decode("utf-8"))
    if manifest.get("format") != "semaframe-scene-exchange" or manifest.get("version") != "1.0":
        raise ValueError("Unsupported SemaFrame exchange")
    entries = [entry for entry in manifest.get("files", []) if isinstance(entry, dict)]
    nodes = manifest.get("nodes")
    if not isinstance(nodes, list) or len(nodes) > 10_000:
        raise ValueError("Exchange node list is invalid or too large")
    stable_ids = [node.get("stableId") for node in nodes if isinstance(node, dict)]
    if len(stable_ids) != len(nodes) or any(not isinstance(value, str) or not value for value in stable_ids) or len(set(stable_ids)) != len(stable_ids):
        raise ValueError("Exchange stable IDs are invalid or duplicated")
    listed = {entry.get("path"): entry for entry in entries}
    if len(entries) != len(listed) or set(values) - {"semaframe.exchange.json"} != set(listed):
        raise ValueError("Exchange files and manifest declarations disagree")
    for entry in listed.values():
        if not isinstance(entry, dict) or entry.get("path") not in values:
            raise ValueError("Manifest references an unavailable entry")
        name = entry["path"]
        actual = "sha256:" + hashlib.sha256(values[name]).hexdigest()
        if entry.get("sha256") != actual or entry.get("byteLength") != len(values[name]):
            raise ValueError(f"Exchange integrity check failed: {name}")
    destination.mkdir(parents=True, exist_ok=True)
    for name, data in values.items():
        output = destination.joinpath(*pathlib.PurePosixPath(name).parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
    return manifest


def _previous_stages():
    subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    return [
        actor for actor in subsystem.get_all_level_actors()
        if any(str(tag) == BRIDGE_ACTOR_TAG for tag in actor.tags)
    ]


def pull_latest_exchange():
    """Pull the current immutable exchange and open scene.usda on a USD Stage Actor."""
    view = _view()
    publication = view["publication"]
    digest = publication["exchangeDigest"]
    status, headers, archive = _request("/exchange?digest=" + urllib.parse.quote(digest, safe=":"))
    if status != 200 or not headers.get_content_type().startswith("application/vnd.semaframe.exchange"):
        raise ValueError("Bridge did not return a SemaFrame exchange")
    if "sha256:" + hashlib.sha256(archive).hexdigest() != digest:
        raise ValueError("Exchange archive digest mismatch")
    destination = pathlib.Path(unreal.Paths.project_saved_dir()) / "SemaFrameBridge" / digest[7:23]
    manifest = _validate_archive(archive, destination)
    subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    previous = _previous_stages()
    actor = subsystem.spawn_actor_from_class(unreal.UsdStageActor, unreal.Vector(0.0, 0.0, 0.0))
    try:
        actor.set_actor_label(f"SemaFrame {publication['workspaceId']} r{publication['revision']}")
        actor.tags = [unreal.Name(BRIDGE_ACTOR_TAG)]
        usda = str((destination / "scene.usda").resolve())
        if hasattr(actor, "set_use_prim_kinds_for_collapsing"):
            actor.set_use_prim_kinds_for_collapsing(False)
        if hasattr(actor, "set_root_layer"):
            actor.set_root_layer(usda)
        else:
            actor.set_editor_property("root_layer", unreal.FilePath(file_path=usda))
    except Exception:
        subsystem.destroy_actor(actor)
        raise
    for previous_actor in previous:
        subsystem.destroy_actor(previous_actor)
    _RUNTIME.update(view=view, manifest=manifest, stage_actor=actor, components={}, baselines={})
    mapped, expected = refresh_stable_id_mapping()
    unreal.log(f"SemaFrame Bridge pulled revision {publication['revision']}; mapped {mapped}/{expected} stable USD prims")
    return {"revision": publication["revision"], "mapped": mapped, "expected": expected, "stageActor": actor.get_name()}


def refresh_stable_id_mapping():
    """Re-resolve stable IDs after the USD Stage finishes or reloads."""
    actor = _RUNTIME.get("stage_actor")
    manifest = _RUNTIME.get("manifest")
    if not actor or not manifest:
        raise RuntimeError("Pull an exchange before refreshing stable IDs")
    components = {}
    expected = 0
    for node in manifest.get("nodes", []):
        prim_path = node.get("usdPrimPath") if isinstance(node, dict) else None
        if not prim_path:
            continue
        expected += 1
        component = actor.get_generated_component(prim_path)
        if component is None:
            continue
        stable_id = node["stableId"]
        tags = [tag for tag in component.get_editor_property("component_tags") if not str(tag).startswith("SemaFrameStableId=")]
        tags.append(unreal.Name(f"SemaFrameStableId={stable_id}"))
        component.set_editor_property("component_tags", tags)
        components[stable_id] = component
        if stable_id not in _RUNTIME["baselines"]:
            _RUNTIME["baselines"][stable_id] = _placement_signature(_component_placement(component))
    _RUNTIME["components"] = components
    return len(components), expected


def _quaternion_to_euler(quaternion):
    x, y, z, w = quaternion
    sinr = 2 * (w * x + y * z)
    cosr = 1 - 2 * (x * x + y * y)
    roll = math.atan2(sinr, cosr)
    sinp = 2 * (w * y - z * x)
    pitch = math.copysign(math.pi / 2, sinp) if abs(sinp) >= 1 else math.asin(sinp)
    siny = 2 * (w * z + x * y)
    cosy = 1 - 2 * (y * y + z * z)
    yaw = math.atan2(siny, cosy)
    return roll, pitch, yaw


def _component_placement(component):
    position = component.get_editor_property("relative_location")
    rotation = component.get_editor_property("relative_rotation").quaternion()
    scale = component.get_editor_property("relative_scale3d")
    # Unreal is centimetre, left-handed Z-up. Undo the USD Stage basis conversion.
    sema_quaternion = (-rotation.x, -rotation.z, -rotation.y, rotation.w)
    rx, ry, rz = _quaternion_to_euler(sema_quaternion)
    return {
        "space": "world3d",
        "position": {"x": position.x / 100.0, "y": position.z / 100.0, "z": position.y / 100.0},
        "rotation": {"x": rx, "y": ry, "z": rz},
        "scale": {"x": scale.x, "y": scale.z, "z": scale.y},
    }


def _placement_signature(value):
    def normalized(item):
        if isinstance(item, float):
            return round(item, 7)
        if isinstance(item, dict):
            return {key: normalized(child) for key, child in item.items()}
        return item
    return json.dumps(normalized(value), sort_keys=True, separators=(",", ":"))


def build_transform_proposal():
    view = _RUNTIME.get("view")
    if not view:
        raise RuntimeError("Pull an exchange before building a proposal")
    mapped, expected = refresh_stable_id_mapping()
    if mapped != expected:
        raise RuntimeError(f"USD Stage stable-ID mapping is incomplete ({mapped}/{expected})")
    changes = []
    for stable_id, component in sorted(_RUNTIME["components"].items()):
        placement = _component_placement(component)
        if _placement_signature(placement) == _RUNTIME["baselines"].get(stable_id):
            continue
        numeric = [
            *placement["position"].values(),
            *placement["rotation"].values(),
            *placement["scale"].values(),
        ]
        if not all(math.isfinite(value) for value in numeric) or not all(
            value > 0 for value in placement["scale"].values()
        ):
            raise RuntimeError(f"{stable_id} has a non-finite value or non-positive scale")
        changes.append({
            "changeId": f"unreal-transform-{len(changes) + 1}",
            "kind": "transform",
            "componentId": stable_id,
            "placement": placement,
        })
        if len(changes) > 100:
            raise RuntimeError("A proposal can contain at most 100 changed components")
    if not changes:
        raise RuntimeError("USD Stage has no changed mapped components; refresh after it finishes loading")
    publication = view["publication"]
    return {
        "format": "semaframe-bridge-change-proposal",
        "version": "1.0",
        "proposalId": f"unreal-{uuid.uuid4()}",
        "target": "unreal",
        "source": {
            "workspaceId": publication["workspaceId"],
            "baseRevision": publication["revision"],
            "exchangeDigest": publication["exchangeDigest"],
        },
        "changes": changes,
        "note": "Explicit transform proposal from Unreal 5.6+; requires SemaFrame review.",
    }


def submit_transform_proposal():
    """Explicitly submit current mapped component transforms for SemaFrame review."""
    proposal = build_transform_proposal()
    status, _headers, data = _request("/proposals", method="POST", payload=proposal, maximum=MAX_JSON_BYTES)
    envelope = json.loads(data.decode("utf-8"))
    if status != 202 or envelope.get("data", {}).get("status") != "review_required":
        raise RuntimeError("Bridge did not queue the proposal for review")
    unreal.log(f"SemaFrame Bridge queued {len(proposal['changes'])} transforms for human review")
    return envelope["data"]
