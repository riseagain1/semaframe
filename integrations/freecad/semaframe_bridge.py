#!/usr/bin/env python3
"""FreeCAD 1.0+ CLI bridge for SemaFrame Scene Exchange v1.

Run this file with FreeCADCmd for document import/export. Connection setup and
network credentials are accepted only from a masked prompt or stdin, never argv
or disk.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import io
import json
import math
import pathlib
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile


ADAPTER_VERSION = "1.0.0"
MINIMUM_FREECAD_VERSION = (1, 0, 0)
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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        del request, file_pointer, code, message, headers, new_url
        raise urllib.error.HTTPError("", 403, "Bridge redirects are disabled", {}, None)


def validated_endpoint(value: str) -> str:
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


def validated_session(value: str) -> str:
    return str(uuid.UUID(value.strip()))


def read_bearer(from_stdin: bool) -> str:
    bearer = sys.stdin.readline().strip() if from_stdin else getpass.getpass("SemaFrame session capability: ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", bearer):
        raise ValueError("The Bridge capability must contain 43 base64url characters")
    return bearer


def parse_setup_json(text: str, target="freecad"):
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_SETUP_BYTES:
        raise ValueError("Bridge setup JSON is missing or exceeds 64 KiB")
    try:
        setup = json.loads(text)
    except json.JSONDecodeError as cause:
        raise ValueError("Bridge setup JSON is invalid") from cause
    if not isinstance(setup, dict) or setup.get("format") != "semaframe-bridge-setup" or setup.get("version") != "1.0":
        raise ValueError("Bridge setup JSON is unsupported")
    if setup.get("target") != target:
        raise ValueError("Bridge setup JSON targets another host")
    session = validated_session(setup.get("sessionId", ""))
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
    endpoint = validated_endpoint(urllib.parse.urlunsplit((pull.scheme, pull.netloc, "", "", "")))
    authorization = setup.get("authorization")
    if not isinstance(authorization, dict) or authorization.get("header") != "Authorization":
        raise ValueError("Bridge setup authorization header is unsupported")
    value = authorization.get("value")
    if not isinstance(value, str) or not value.startswith("Bearer "):
        raise ValueError("Bridge setup authorization must use Bearer")
    bearer = value[7:]
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", bearer):
        raise ValueError("Bridge setup capability is invalid")
    return endpoint, session, bearer


def read_setup_stdin() -> str:
    encoded = sys.stdin.buffer.read(MAX_SETUP_BYTES + 1)
    if len(encoded) > MAX_SETUP_BYTES:
        raise ValueError("Bridge setup JSON exceeds 64 KiB")
    try:
        return encoded.decode("utf-8")
    except UnicodeDecodeError as cause:
        raise ValueError("Bridge setup JSON must be UTF-8") from cause


def resolve_connection(arguments):
    if arguments.setup_stdin:
        return parse_setup_json(read_setup_stdin())
    if not arguments.session:
        raise ValueError("--session is required unless --setup-stdin is used")
    return validated_endpoint(arguments.endpoint), validated_session(arguments.session), read_bearer(arguments.bearer_stdin)


def request(endpoint: str, session: str, bearer: str, path: str, *, method="GET", payload=None, maximum=MAX_ARCHIVE_BYTES):
    endpoint = validated_endpoint(endpoint)
    session = validated_session(session)
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", bearer):
        raise ValueError("Invalid Bridge capability")
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    outbound = urllib.request.Request(
        f"{endpoint}/v1/bridge/sessions/{session}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json, application/vnd.semaframe.exchange+zip",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(outbound, timeout=30) as response:
        data = response.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("Bridge response exceeds the adapter limit")
        return response.status, response.headers, data


def pull_view(endpoint: str, session: str, bearer: str):
    status, _headers, data = request(endpoint, session, bearer, "", maximum=MAX_JSON_BYTES)
    if status != 200:
        raise RuntimeError(f"Unexpected Bridge status {status}")
    envelope = json.loads(data.decode("utf-8"))
    view = envelope.get("data") if isinstance(envelope, dict) and envelope.get("ok") is True else None
    if not isinstance(view, dict) or view.get("target") != "freecad":
        raise ValueError("Bridge response is invalid or targets another host")
    return view


def validate_archive(archive: bytes):
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
    listed = {
        entry.get("path"): entry
        for entry in entries
    }
    if len(entries) != len(listed) or set(values) - {"semaframe.exchange.json"} != set(listed):
        raise ValueError("Exchange files and manifest declarations disagree")
    for entry in listed.values():
        if not isinstance(entry, dict) or entry.get("path") not in values:
            raise ValueError("Manifest references an unavailable exchange entry")
        name = entry["path"]
        digest = "sha256:" + hashlib.sha256(values[name]).hexdigest()
        if entry.get("sha256") != digest or entry.get("byteLength") != len(values[name]):
            raise ValueError(f"Exchange integrity check failed: {name}")
    return manifest, values


def semaframe_quaternion(rotation):
    cx, sx = math.cos(rotation["x"] / 2), math.sin(rotation["x"] / 2)
    cy, sy = math.cos(rotation["y"] / 2), math.sin(rotation["y"] / 2)
    cz, sz = math.cos(rotation["z"] / 2), math.sin(rotation["z"] / 2)
    return (
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    )


def quaternion_to_euler(quaternion):
    x, y, z, w = quaternion
    sinr_cosp = 2 * (w * x + y * z)
    cosr_cosp = 1 - 2 * (x * x + y * y)
    roll = math.atan2(sinr_cosp, cosr_cosp)
    sinp = 2 * (w * y - z * x)
    pitch = math.copysign(math.pi / 2, sinp) if abs(sinp) >= 1 else math.asin(sinp)
    siny_cosp = 2 * (w * z + x * y)
    cosy_cosp = 1 - 2 * (y * y + z * z)
    yaw = math.atan2(siny_cosp, cosy_cosp)
    return roll, pitch, yaw


def holder_placement(item):
    base = item.Placement.Base
    qx, qy, qz, qw = item.Placement.Rotation.Q
    # FreeCAD uses right-handed Z-up. Undo the adapter's +90 degree X basis change.
    sx, sy, sz, sw = qx, qz, -qy, qw
    rx, ry, rz = quaternion_to_euler((sx, sy, sz, sw))
    return {
        "space": "world3d",
        "position": {"x": base.x / 1000.0, "y": base.z / 1000.0, "z": -base.y / 1000.0},
        "rotation": {"x": rx, "y": ry, "z": rz},
        "scale": {
            "x": float(item.SemaFrameScaleX),
            "y": float(item.SemaFrameScaleY),
            "z": float(item.SemaFrameScaleZ),
        },
    }


def placement_signature(value):
    def normalized(item):
        if isinstance(item, float):
            return round(item, 9)
        if isinstance(item, dict):
            return {key: normalized(child) for key, child in item.items()}
        return item
    return json.dumps(normalized(value), sort_keys=True, separators=(",", ":"))


def import_document(manifest, files, output: pathlib.Path):
    try:
        import FreeCAD as App
        import Import
    except ImportError as cause:
        raise RuntimeError("Run the import command with FreeCADCmd 1.0 or newer") from cause
    version = tuple(int(part) for part in App.Version()[:3])
    if version < MINIMUM_FREECAD_VERSION:
        raise RuntimeError("SemaFrame Bridge requires FreeCAD 1.0 or newer")
    document = App.newDocument("SemaFrameExchange")
    metadata = document.addObject("App::FeaturePython", "SemaFrameBridgeMetadata")
    metadata.addProperty("App::PropertyString", "SemaFrameWorkspaceId", "SemaFrame")
    metadata.addProperty("App::PropertyString", "SemaFrameBaseRevision", "SemaFrame")
    metadata.addProperty("App::PropertyString", "SemaFrameExchangeDigest", "SemaFrame")
    metadata.addProperty("App::PropertyString", "SemaFrameAdapterVersion", "SemaFrame")
    metadata.SemaFrameWorkspaceId = manifest["source"]["workspaceId"]
    metadata.SemaFrameBaseRevision = str(manifest["source"]["revision"])
    metadata.SemaFrameExchangeDigest = manifest["__exchangeDigest"]
    metadata.SemaFrameAdapterVersion = ADAPTER_VERSION

    with tempfile.TemporaryDirectory(prefix="semaframe-freecad-") as directory:
        root = pathlib.Path(directory)
        for name, data in files.items():
            destination = root.joinpath(*pathlib.PurePosixPath(name).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        geometry_group = document.addObject("App::Part", "SemaFrameGeometry")
        imported = []
        step = root / "exact" / "model.step"
        if step.exists():
            before = set(document.Objects)
            Import.insert(str(step), document.Name)
            imported = [item for item in document.Objects if item not in before]
            geometry_group.Placement = App.Placement(
                App.Vector(0.0, 0.0, 0.0),
                App.Rotation(App.Vector(1.0, 0.0, 0.0), 90.0),
            )
            geometry_group.Label = "SemaFrame exact STEP geometry"
        else:
            glb = root / "geometry.glb"
            try:
                import ImportGui
                before = set(document.Objects)
                ImportGui.insert(str(glb), document.Name)
                imported = [item for item in document.Objects if item not in before]
                geometry_group.Label = "SemaFrame GLB visual geometry"
            except (ImportError, RuntimeError, TypeError, ValueError):
                reference = document.addObject("App::FeaturePython", "SemaFrameUsdReference")
                reference.addProperty("App::PropertyString", "SourceFormat", "SemaFrame")
                reference.addProperty("App::PropertyString", "SourceNotice", "SemaFrame")
                reference.addProperty("App::PropertyStringList", "OpenUsdSource", "SemaFrame")
                reference.SourceFormat = "OpenUSD (scene.usda)"
                reference.SourceNotice = "This FreeCAD build has no GLB importer; semantic nodes remain editable."
                reference.OpenUsdSource = files["scene.usda"].decode("utf-8").splitlines()
                imported = [reference]
                geometry_group.Label = "SemaFrame OpenUSD semantic fallback"
        for item in imported:
            geometry_group.addObject(item)

    nodes_by_id = {}
    for index, node in enumerate(manifest.get("nodes", [])):
        if not isinstance(node, dict) or node.get("placement", {}).get("space") != "world3d":
            continue
        stable_id = node["stableId"]
        name = re.sub(r"[^A-Za-z0-9_]", "_", stable_id)[:48] or f"Node_{index + 1}"
        holder = document.addObject("App::Part", f"SemaFrame_{name}_{index + 1}")
        holder.Label = node.get("label") or stable_id
        holder.addProperty("App::PropertyString", "SemaFrameStableId", "SemaFrame")
        holder.addProperty("App::PropertyFloat", "SemaFrameScaleX", "SemaFrame")
        holder.addProperty("App::PropertyFloat", "SemaFrameScaleY", "SemaFrame")
        holder.addProperty("App::PropertyFloat", "SemaFrameScaleZ", "SemaFrame")
        holder.addProperty("App::PropertyString", "SemaFrameBaselinePlacement", "SemaFrame")
        holder.SemaFrameStableId = stable_id
        placement = node["placement"]
        position = placement["position"]
        scale = placement["scale"]
        qx, qy, qz, qw = semaframe_quaternion(placement["rotation"])
        holder.Placement = App.Placement(
            App.Vector(position["x"] * 1000.0, -position["z"] * 1000.0, position["y"] * 1000.0),
            App.Rotation(qx, -qz, qy, qw),
        )
        holder.SemaFrameScaleX = scale["x"]
        holder.SemaFrameScaleY = scale["y"]
        holder.SemaFrameScaleZ = scale["z"]
        holder.SemaFrameBaselinePlacement = placement_signature(holder_placement(holder))
        nodes_by_id[stable_id] = holder
    root_nodes = document.addObject("App::DocumentObjectGroup", "SemaFrameStableNodes")
    for node in manifest.get("nodes", []):
        holder = nodes_by_id.get(node.get("stableId")) if isinstance(node, dict) else None
        if holder is None:
            continue
        parent = nodes_by_id.get(node.get("parentStableId"))
        (parent if parent is not None else root_nodes).addObject(holder)
    document.recompute()
    output.parent.mkdir(parents=True, exist_ok=True)
    document.saveAs(str(output.resolve()))
    return len(nodes_by_id), "STEP" if "exact/model.step" in files else "GLB/OpenUSD fallback"


def document_proposal(document_path: pathlib.Path):
    try:
        import FreeCAD as App
    except ImportError as cause:
        raise RuntimeError("Run proposal generation with FreeCADCmd 1.0 or newer") from cause
    document = App.openDocument(str(document_path.resolve()))
    metadata = document.getObject("SemaFrameBridgeMetadata")
    if metadata is None:
        raise ValueError("Document does not contain SemaFrame source metadata")
    changes = []
    seen = set()
    for item in document.Objects:
        if "SemaFrameStableId" not in item.PropertiesList:
            continue
        placement = holder_placement(item)
        if placement_signature(placement) == item.SemaFrameBaselinePlacement:
            continue
        stable_id = item.SemaFrameStableId
        if stable_id in seen:
            raise ValueError(f"Document maps the stable ID more than once: {stable_id}")
        seen.add(stable_id)
        numeric = [
            *placement["position"].values(),
            *placement["rotation"].values(),
            *placement["scale"].values(),
        ]
        if not all(math.isfinite(value) for value in numeric) or not all(
            value > 0 for value in placement["scale"].values()
        ):
            raise ValueError(f"{stable_id} has a non-finite value or non-positive scale")
        changes.append({
            "changeId": f"freecad-transform-{len(changes) + 1}",
            "kind": "transform",
            "componentId": stable_id,
            "placement": placement,
        })
        if len(changes) > 100:
            raise ValueError("A proposal can contain at most 100 changed nodes")
    if not changes:
        raise ValueError("Document has no changed SemaFrame stable nodes")
    return {
        "format": "semaframe-bridge-change-proposal",
        "version": "1.0",
        "proposalId": f"freecad-{uuid.uuid4()}",
        "target": "freecad",
        "source": {
            "workspaceId": metadata.SemaFrameWorkspaceId,
            "baseRevision": int(metadata.SemaFrameBaseRevision),
            "exchangeDigest": metadata.SemaFrameExchangeDigest,
        },
        "changes": changes,
        "note": "Explicit transform proposal from FreeCAD 1.0+; requires SemaFrame review.",
    }


def pull_command(arguments):
    endpoint, session, bearer = resolve_connection(arguments)
    try:
        view = pull_view(endpoint, session, bearer)
        digest = view["publication"]["exchangeDigest"]
        status, headers, archive = request(
            endpoint,
            session,
            bearer,
            "/exchange?digest=" + urllib.parse.quote(digest, safe=":"),
        )
        if status != 200 or not headers.get_content_type().startswith("application/vnd.semaframe.exchange"):
            raise ValueError("Bridge did not return a SemaFrame exchange")
        if "sha256:" + hashlib.sha256(archive).hexdigest() != digest:
            raise ValueError("Exchange archive digest mismatch")
        manifest, files = validate_archive(archive)
        manifest["__exchangeDigest"] = digest
        count, geometry = import_document(manifest, files, pathlib.Path(arguments.output))
        print(f"Imported {count} stable nodes using {geometry}: {arguments.output}")
    finally:
        bearer = ""  # Deliberately drop the last local reference.


def proposal_command(arguments):
    proposal = document_proposal(pathlib.Path(arguments.document))
    output = json.dumps(proposal, sort_keys=True, separators=(",", ":")) + "\n"
    if arguments.output == "-":
        sys.stdout.write(output)
    else:
        pathlib.Path(arguments.output).write_text(output, encoding="utf-8")


def submit_command(arguments):
    value = json.loads(pathlib.Path(arguments.proposal).read_text(encoding="utf-8"))
    if value.get("format") != "semaframe-bridge-change-proposal" or value.get("target") != "freecad":
        raise ValueError("Proposal file is not a FreeCAD SemaFrame proposal")
    endpoint, session, bearer = resolve_connection(arguments)
    try:
        status, _headers, data = request(
            endpoint,
            session,
            bearer,
            "/proposals",
            method="POST",
            payload=value,
            maximum=MAX_JSON_BYTES,
        )
        envelope = json.loads(data.decode("utf-8"))
        if status != 202 or envelope.get("data", {}).get("status") != "review_required":
            raise RuntimeError("Bridge did not queue the proposal for review")
        print("Proposal queued in SemaFrame for human review")
    finally:
        bearer = ""


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    pull = commands.add_parser("pull", help="Pull an immutable exchange into an FCStd document")
    pull.add_argument("--endpoint", default="http://127.0.0.1:8788")
    pull.add_argument("--session")
    pull.add_argument("--output", required=True)
    pull_credentials = pull.add_mutually_exclusive_group()
    pull_credentials.add_argument("--bearer-stdin", action="store_true", help="Read one capability line from stdin")
    pull_credentials.add_argument("--setup-stdin", action="store_true", help="Read copied SemaFrame setup JSON from stdin")
    pull.set_defaults(run=pull_command)
    proposal = commands.add_parser("proposal", help="Write a reviewable transform proposal")
    proposal.add_argument("--document", required=True)
    proposal.add_argument("--output", default="-")
    proposal.set_defaults(run=proposal_command)
    submit = commands.add_parser("submit", help="Explicitly submit an existing proposal")
    submit.add_argument("--endpoint", default="http://127.0.0.1:8788")
    submit.add_argument("--session")
    submit.add_argument("--proposal", required=True)
    submit_credentials = submit.add_mutually_exclusive_group()
    submit_credentials.add_argument("--bearer-stdin", action="store_true", help="Read one capability line from stdin")
    submit_credentials.add_argument("--setup-stdin", action="store_true", help="Read copied SemaFrame setup JSON from stdin")
    submit.set_defaults(run=submit_command)
    return root


def main(argv=None):
    arguments = parser().parse_args(argv)
    arguments.run(arguments)


if __name__ == "__main__":
    main()
