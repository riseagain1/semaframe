"""Blender 4.5 LTS adapter for immutable SemaFrame Scene Exchanges.

The bearer capability only lives in this module's process memory. Imported
objects retain stable IDs and source metadata, but never credentials.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import pathlib
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

import bpy
from bpy.props import BoolProperty, StringProperty
from mathutils import Matrix


bl_info = {
    "name": "SemaFrame Bridge",
    "author": "SemaFrame Contributors",
    "version": (1, 0, 0),
    "blender": (4, 5, 0),
    "location": "View3D > Sidebar > SemaFrame",
    "description": "Pull immutable exchanges and submit reviewable transforms",
    "category": "Import-Export",
}

_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
_MAX_MANIFEST_BYTES = 1024 * 1024
_MAX_SETUP_BYTES = 64 * 1024
_ALLOWED_ENTRIES = {
    "semaframe.exchange.json",
    "fidelity-report.json",
    "scene.usda",
    "geometry.glb",
    "exact/model.step",
}
_RUNTIME = {
    "endpoint": "http://127.0.0.1:8788",
    "session_id": "",
    "bearer": "",
    "view": None,
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        del request, file_pointer, code, message, headers, new_url
        raise urllib.error.HTTPError("", 403, "Bridge redirects are disabled", {}, None)


def _base_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Bridge endpoint must use http or https")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Bridge endpoint must resolve to the local machine")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Bridge endpoint cannot contain credentials, query, or fragment")
    if parsed.path not in {"", "/"}:
        raise ValueError("Bridge endpoint must not contain a path")
    if parsed.port is None:
        raise ValueError("Bridge endpoint must include the SemaFrame port")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


def _session_id(value: str) -> str:
    parsed = uuid.UUID(value.strip())
    return str(parsed)


def _parse_setup_json(value: str):
    if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > _MAX_SETUP_BYTES:
        raise ValueError("SemaFrame setup JSON is empty or too large")
    setup = json.loads(value)
    if not isinstance(setup, dict) or setup.get("format") != "semaframe-bridge-setup" or setup.get("version") != "1.0":
        raise ValueError("Unsupported SemaFrame Bridge setup JSON")
    if setup.get("target") != "blender":
        raise ValueError("This setup JSON targets another host")
    session = _session_id(str(setup.get("sessionId", "")))
    pull = urllib.parse.urlsplit(str(setup.get("pullUrl", "")))
    expected_path = f"/v1/bridge/sessions/{session}"
    if pull.path != expected_path or pull.query or pull.fragment:
        raise ValueError("Setup pull URL does not match its session")
    endpoint = _base_url(urllib.parse.urlunsplit((pull.scheme, pull.netloc, "", "", "")))
    exchange = urllib.parse.urlsplit(str(setup.get("exchangeUrl", "")))
    if (
        exchange.scheme != pull.scheme
        or exchange.netloc != pull.netloc
        or exchange.path != f"{expected_path}/exchange"
        or exchange.query
        or exchange.fragment
    ):
        raise ValueError("Setup exchange URL does not match its pull URL")
    authorization = setup.get("authorization")
    if not isinstance(authorization, dict) or authorization.get("header") != "Authorization":
        raise ValueError("Setup JSON is missing its Authorization header")
    match = re.fullmatch(r"Bearer ([A-Za-z0-9_-]{43})", str(authorization.get("value", "")))
    if not match:
        raise ValueError("Setup JSON contains an invalid Bridge capability")
    return endpoint, session, match.group(1)


def _online_allowed() -> None:
    if not bpy.app.online_access:
        suffix = " (forced by Blender startup options)" if bpy.app.online_access_overriden else ""
        raise PermissionError(f"Enable Blender's Allow Online Access setting{suffix}")


def _request(path: str, *, method: str = "GET", payload=None, maximum=_MAX_ARCHIVE_BYTES):
    _online_allowed()
    endpoint = _base_url(_RUNTIME["endpoint"])
    session = _session_id(_RUNTIME["session_id"])
    bearer = _RUNTIME["bearer"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", bearer or ""):
        raise PermissionError("Connect with the 43-character Bridge capability first")
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        f"{endpoint}/v1/bridge/sessions/{session}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json, application/vnd.semaframe.exchange+zip",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    with opener.open(request, timeout=30) as response:
        data = response.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("Bridge response exceeds the adapter limit")
        return response.status, response.headers, data


def _json_response(path: str):
    status, _headers, data = _request(path, maximum=_MAX_MANIFEST_BYTES)
    if status != 200:
        raise RuntimeError(f"Unexpected Bridge status {status}")
    value = json.loads(data.decode("utf-8"))
    if not isinstance(value, dict) or value.get("ok") is not True or not isinstance(value.get("data"), dict):
        raise ValueError("Bridge returned an invalid response envelope")
    return value["data"]


def _safe_zip(archive: bytes):
    result = {}
    casefolded = set()
    total = 0
    with zipfile.ZipFile(io.BytesIO(archive), "r") as package:
        for info in package.infolist():
            name = info.filename
            path = pathlib.PurePosixPath(name)
            if (
                name not in _ALLOWED_ENTRIES
                or name.startswith("/")
                or "\\" in name
                or any(part in {"", ".", ".."} for part in path.parts)
                or info.flag_bits & 0x1
                or ((info.external_attr >> 16) & 0o170000) == 0o120000
                or name.casefold() in casefolded
            ):
                raise ValueError(f"Unsafe or unknown exchange entry: {name}")
            casefolded.add(name.casefold())
            total += info.file_size
            if total > _MAX_ARCHIVE_BYTES:
                raise ValueError("Expanded exchange exceeds the adapter limit")
            result[name] = package.read(info)
    required = {"semaframe.exchange.json", "fidelity-report.json", "scene.usda", "geometry.glb"}
    if not required.issubset(result):
        raise ValueError("Exchange is missing a required file")
    if len(result["semaframe.exchange.json"]) > _MAX_MANIFEST_BYTES:
        raise ValueError("Exchange manifest exceeds the adapter limit")
    manifest = json.loads(result["semaframe.exchange.json"].decode("utf-8"))
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
    if len(entries) != len(listed) or set(result) - {"semaframe.exchange.json"} != set(listed):
        raise ValueError("Exchange files and manifest declarations disagree")
    for name, entry in listed.items():
        if name not in result or name not in _ALLOWED_ENTRIES:
            raise ValueError(f"Manifest references unavailable entry: {name}")
        expected = entry.get("sha256")
        actual = "sha256:" + hashlib.sha256(result[name]).hexdigest()
        if expected != actual or entry.get("byteLength") != len(result[name]):
            raise ValueError(f"Exchange integrity check failed: {name}")
    return manifest, result


def _import_exchange(view, archive: bytes, scene) -> int:
    manifest, files = _safe_zip(archive)
    previous = [obj for obj in scene.objects if obj.get("semaframeBridgeOwned") is True]
    before = set(bpy.data.objects)
    with tempfile.TemporaryDirectory(prefix="semaframe-blender-") as directory:
        glb_path = pathlib.Path(directory) / "geometry.glb"
        glb_path.write_bytes(files["geometry.glb"])
        try:
            bpy.ops.import_scene.gltf(
                filepath=str(glb_path),
                import_scene_extras=True,
                import_scene_as_collection=True,
                import_select_created_objects=True,
            )
        except Exception:
            for obj in [item for item in bpy.data.objects if item not in before]:
                bpy.data.objects.remove(obj, do_unlink=True)
            raise
    created = [obj for obj in bpy.data.objects if obj not in before]
    nodes = {node["stableId"]: node for node in manifest.get("nodes", []) if isinstance(node, dict)}
    by_label = {}
    for node in nodes.values():
        by_label.setdefault(node.get("label"), []).append(node)
    mapped_ids = set()
    try:
        for obj in created:
            stable_id = obj.get("semaframeStableId")
            if not isinstance(stable_id, str) or stable_id not in nodes:
                matches = by_label.get(obj.name, [])
                stable_id = matches[0]["stableId"] if len(matches) == 1 else None
            if stable_id:
                obj["semaframeStableId"] = stable_id
                obj["semaframeBridgeOwned"] = True
                obj["semaframeSourceRevision"] = int(view["publication"]["revision"])
                obj["semaframeExchangeDigest"] = view["publication"]["exchangeDigest"]
                obj["semaframeBaselinePlacement"] = _placement_signature(_semaframe_placement(obj))
                if stable_id in mapped_ids:
                    raise ValueError(f"GLB mapped the stable ID more than once: {stable_id}")
                mapped_ids.add(stable_id)
        expected_ids = {
            node["stableId"] for node in manifest.get("nodes", [])
            if isinstance(node, dict) and "gltfNodeIndex" in node
        }
        if mapped_ids != expected_ids:
            raise ValueError("GLB stable-ID mapping is incomplete")
    except Exception:
        for obj in created:
            bpy.data.objects.remove(obj, do_unlink=True)
        raise
    for obj in previous:
        bpy.data.objects.remove(obj, do_unlink=True)
    _RUNTIME["view"] = view
    return len(mapped_ids)


_GLTF_TO_BLENDER = Matrix(((1.0, 0.0, 0.0, 0.0), (0.0, 0.0, -1.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0)))


def _semaframe_placement(obj):
    matrix = _GLTF_TO_BLENDER.inverted() @ obj.matrix_local @ _GLTF_TO_BLENDER
    location, quaternion, scale = matrix.decompose()
    rotation = quaternion.to_euler("XYZ")
    return {
        "space": "world3d",
        "position": {"x": location.x, "y": location.y, "z": location.z},
        "rotation": {"x": rotation.x, "y": rotation.y, "z": rotation.z},
        "scale": {"x": scale.x, "y": scale.y, "z": scale.z},
    }


def _placement_signature(value):
    def normalized(item):
        if isinstance(item, float):
            return round(item, 7)
        if isinstance(item, dict):
            return {key: normalized(child) for key, child in item.items()}
        return item
    return json.dumps(normalized(value), sort_keys=True, separators=(",", ":"))


def _proposal(objects):
    view = _RUNTIME.get("view")
    if not isinstance(view, dict):
        raise RuntimeError("Pull an exchange before proposing edits")
    publication = view["publication"]
    changes = []
    seen = set()
    for obj in objects:
        stable_id = obj.get("semaframeStableId")
        if isinstance(stable_id, str):
            if (
                obj.get("semaframeExchangeDigest") != publication["exchangeDigest"]
                or obj.get("semaframeSourceRevision") != publication["revision"]
            ):
                raise ValueError("Selected objects come from another publication; pull the current exchange")
            if stable_id in seen:
                raise ValueError(f"Selection maps the stable ID more than once: {stable_id}")
            seen.add(stable_id)
            placement = _semaframe_placement(obj)
            numeric = [
                *placement["position"].values(),
                *placement["rotation"].values(),
                *placement["scale"].values(),
            ]
            if not all(math.isfinite(value) for value in numeric) or not all(
                value > 0 for value in placement["scale"].values()
            ):
                raise ValueError(f"{stable_id} has a non-finite value or non-positive scale")
            canonical = _placement_signature(placement)
            if canonical == obj.get("semaframeBaselinePlacement"):
                continue
            changes.append({
                "changeId": f"blender-transform-{len(changes) + 1}",
                "kind": "transform",
                "componentId": stable_id,
                "placement": placement,
            })
            if len(changes) > 100:
                raise ValueError("Select at most 100 changed objects per proposal")
    if not changes:
        raise ValueError("Select at least one changed imported SemaFrame object")
    return {
        "format": "semaframe-bridge-change-proposal",
        "version": "1.0",
        "proposalId": f"blender-{uuid.uuid4()}",
        "target": "blender",
        "source": {
            "workspaceId": publication["workspaceId"],
            "baseRevision": publication["revision"],
            "exchangeDigest": publication["exchangeDigest"],
        },
        "changes": changes,
        "note": "Explicit transform proposal from Blender 4.5; requires SemaFrame review.",
    }


class SEMAFRAME_OT_connect(bpy.types.Operator):
    bl_idname = "semaframe.connect"
    bl_label = "Connect SemaFrame Bridge"
    bl_options = {"REGISTER"}

    from_clipboard: BoolProperty(
        name="Read setup JSON from clipboard",
        description="Use only after explicitly copying setup JSON in SemaFrame",
        default=False,
        options={"SKIP_SAVE"},
    )
    endpoint: StringProperty(name="Endpoint", default="http://127.0.0.1:8788")
    session_id: StringProperty(name="Session ID")
    bearer: StringProperty(name="Session capability", subtype="PASSWORD", options={"SKIP_SAVE"})
    setup_json: StringProperty(
        name="Setup JSON (masked)",
        description="Paste the setup JSON copied from SemaFrame; when present it replaces the manual fields",
        subtype="PASSWORD",
        options={"SKIP_SAVE"},
    )

    def invoke(self, context, event):
        del event
        if self.from_clipboard:
            self.setup_json = context.window_manager.clipboard
            return self.execute(context)
        self.endpoint = _RUNTIME["endpoint"]
        self.session_id = _RUNTIME["session_id"]
        self.bearer = ""
        self.setup_json = ""
        return context.window_manager.invoke_props_dialog(self, width=520)

    def execute(self, context):
        try:
            if self.setup_json.strip():
                endpoint, session_id, bearer = _parse_setup_json(self.setup_json)
            else:
                endpoint = _base_url(self.endpoint)
                session_id = _session_id(self.session_id)
                bearer = self.bearer.strip()
            _RUNTIME.update(
                endpoint=endpoint,
                session_id=session_id,
                bearer=bearer,
                view=None,
            )
            view = _json_response("")
            if view.get("target") != "blender":
                raise ValueError("This Bridge session targets a different host")
            _RUNTIME["view"] = view
            self.bearer = ""
            self.setup_json = ""
            self.report({"INFO"}, "Connected; capability retained in memory only")
            return {"FINISHED"}
        except Exception as cause:  # Blender operators must translate host/network failures.
            _RUNTIME["bearer"] = ""
            self.bearer = ""
            self.setup_json = ""
            self.report({"ERROR"}, str(cause))
            return {"CANCELLED"}


class SEMAFRAME_OT_pull(bpy.types.Operator):
    bl_idname = "semaframe.pull"
    bl_label = "Pull Immutable Exchange"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            view = _json_response("")
            if view.get("target") != "blender":
                raise ValueError("This Bridge session targets a different host")
            digest = view["publication"]["exchangeDigest"]
            status, headers, archive = _request(f"/exchange?digest={urllib.parse.quote(digest, safe=':')}")
            if status != 200 or not headers.get_content_type().startswith("application/vnd.semaframe.exchange"):
                raise ValueError("Bridge did not return a SemaFrame exchange")
            if "sha256:" + hashlib.sha256(archive).hexdigest() != digest:
                raise ValueError("Exchange archive digest mismatch")
            mapped = _import_exchange(view, archive, context.scene)
            self.report({"INFO"}, f"Pulled revision {view['publication']['revision']}; mapped {mapped} objects")
            return {"FINISHED"}
        except Exception as cause:
            self.report({"ERROR"}, str(cause))
            return {"CANCELLED"}


class SEMAFRAME_OT_propose_transforms(bpy.types.Operator):
    bl_idname = "semaframe.propose_transforms"
    bl_label = "Propose Selected Transforms"
    bl_options = {"REGISTER"}

    def execute(self, context):
        try:
            proposal = _proposal(context.selected_objects)
            status, _headers, data = _request(
                "/proposals", method="POST", payload=proposal, maximum=_MAX_MANIFEST_BYTES
            )
            if status != 202:
                raise RuntimeError(f"Bridge rejected the proposal with status {status}")
            response = json.loads(data.decode("utf-8"))
            if response.get("ok") is not True or response.get("data", {}).get("status") != "review_required":
                raise ValueError("Bridge returned an invalid proposal receipt")
            self.report({"INFO"}, "Proposal queued in SemaFrame for human review")
            return {"FINISHED"}
        except Exception as cause:
            self.report({"ERROR"}, str(cause))
            return {"CANCELLED"}


class SEMAFRAME_PT_bridge(bpy.types.Panel):
    bl_label = "SemaFrame Bridge"
    bl_idname = "SEMAFRAME_PT_bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "SemaFrame"

    def draw(self, context):
        layout = self.layout
        layout.operator("semaframe.connect", icon="LINKED")
        clipboard = layout.operator("semaframe.connect", text="Connect from SemaFrame Clipboard")
        clipboard.from_clipboard = True
        layout.operator("semaframe.pull", icon="IMPORT")
        row = layout.row()
        row.enabled = bool(context.selected_objects)
        row.operator("semaframe.propose_transforms", icon="EXPORT")
        layout.label(text="Edits always require SemaFrame review", icon="INFO")


_CLASSES = (
    SEMAFRAME_OT_connect,
    SEMAFRAME_OT_pull,
    SEMAFRAME_OT_propose_transforms,
    SEMAFRAME_PT_bridge,
)


def register():
    for item in _CLASSES:
        bpy.utils.register_class(item)


def unregister():
    _RUNTIME.update(session_id="", bearer="", view=None)
    for item in reversed(_CLASSES):
        bpy.utils.unregister_class(item)
