#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const paths = Object.freeze({
  blenderManifest: "integrations/blender/semaframe_bridge/blender_manifest.toml",
  blenderSource: "integrations/blender/semaframe_bridge/__init__.py",
  freecadSource: "integrations/freecad/semaframe_bridge.py",
  unityPackage: "integrations/unity/com.semaframe.bridge/package.json",
  unityRuntimeAsmdef: "integrations/unity/com.semaframe.bridge/Runtime/SemaFrame.Bridge.Runtime.asmdef",
  unityEditorAsmdef: "integrations/unity/com.semaframe.bridge/Editor/SemaFrame.Bridge.Editor.asmdef",
  unityWindow: "integrations/unity/com.semaframe.bridge/Editor/SemaFrameBridgeWindow.cs",
  unrealPlugin: "integrations/unreal/SemaFrameBridge/SemaFrameBridge.uplugin",
  unrealInit: "integrations/unreal/SemaFrameBridge/Content/Python/init_unreal.py",
  unrealSource: "integrations/unreal/SemaFrameBridge/Content/Python/semaframe_bridge.py",
  bridgeContracts: "src/bridge/contracts.ts",
});

function source(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function parseJson(path) {
  return JSON.parse(source(path));
}

function runPython(pythonArguments) {
  const candidates = [
    ...(process.env.PYTHON ? [[process.env.PYTHON]] : []),
    ["python3"],
    ["python"],
    ["py", "-3"],
  ];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, ...pythonArguments], { cwd: repositoryRoot, encoding: "utf8" });
    if (result.error?.code === "ENOENT") continue;
    return result;
  }
  throw new Error("Python 3 is required to validate the host adapter sources");
}

export function assertSafeArchiveEntry(path, existing = new Set()) {
  assert.equal(typeof path, "string", "archive path must be text");
  assert(path.length > 0, "archive path cannot be empty");
  assert(!path.startsWith("/"), "absolute paths are forbidden");
  assert(!path.includes("\\"), "backslash paths are forbidden");
  assert(!/[\u0000-\u001f\u007f]/u.test(path), "control characters are forbidden");
  const parts = path.split("/");
  assert(parts.every((part) => part && part !== "." && part !== ".."), "dot and empty path segments are forbidden");
  const folded = path.toLocaleLowerCase("en-US");
  assert(![...existing].some((candidate) => candidate.toLocaleLowerCase("en-US") === folded), "case-fold duplicates are forbidden");
  return path;
}

function assertContains(text, needles, label) {
  for (const needle of needles) assert(text.includes(needle), `${label} is missing ${needle}`);
}

function verifyPythonSyntax(path) {
  const result = runPython(["-c", "import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), sys.argv[1], 'exec')", resolve(repositoryRoot, path)]);
  assert.equal(result.status, 0, `${path} failed Python syntax validation: ${result.stderr}`);
}

function verifyTomlSyntax(path) {
  const result = runPython(["-c", "import pathlib,sys,tomllib; tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))", resolve(repositoryRoot, path)]);
  assert.equal(result.status, 0, `${path} failed TOML syntax validation: ${result.stderr}`);
}

function verifyPythonAdapterBehavior(path, target) {
  const smoke = String.raw`
import importlib.util
import io
import json
import pathlib
import sys
import types
import zipfile

path = pathlib.Path(sys.argv[1])
target = sys.argv[2]
if target == "blender":
    bpy = types.ModuleType("bpy")
    props = types.ModuleType("bpy.props")
    props.StringProperty = lambda **_kwargs: None
    props.BoolProperty = lambda **_kwargs: None
    bpy.props = props
    bpy.types = types.SimpleNamespace(Operator=object, Panel=object)
    bpy.app = types.SimpleNamespace(online_access=True, online_access_overriden=False)
    sys.modules["bpy"] = bpy
    sys.modules["bpy.props"] = props
    mathutils = types.ModuleType("mathutils")
    mathutils.Matrix = lambda *_args, **_kwargs: object()
    sys.modules["mathutils"] = mathutils
elif target == "unreal":
    sys.modules["unreal"] = types.ModuleType("unreal")

spec = importlib.util.spec_from_file_location("semaframe_adapter_" + target, path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
session_input = "A0B1C2D3-E4F5-4A67-8B90-A1B2C3D4E5F6"
session = session_input.lower()
origin = "http://127.0.0.1:8788"
setup = {
    "format": "semaframe-bridge-setup",
    "version": "1.0",
    "target": target,
    "sessionId": session_input,
    "pullUrl": origin + "/v1/bridge/sessions/" + session,
    "exchangeUrl": origin + "/v1/bridge/sessions/" + session + "/exchange",
    "authorization": {"header": "Authorization", "value": "Bearer " + "A" * 43},
}
parser = module.parse_setup_json if target == "freecad" else module._parse_setup_json
assert parser(json.dumps(setup)) == (origin, session, "A" * 43)
setup["target"] = "unity"
try:
    parser(json.dumps(setup))
except (TypeError, ValueError):
    pass
else:
    raise AssertionError("mismatched setup target was accepted")

archive = io.BytesIO()
with zipfile.ZipFile(archive, "w") as package:
    package.writestr("../scene.usda", b"unsafe")
if target == "blender":
    validator = module._safe_zip
elif target == "freecad":
    validator = module.validate_archive
else:
    validator = lambda value: module._validate_archive(value, pathlib.Path("unused"))
try:
    validator(archive.getvalue())
except ValueError:
    pass
else:
    raise AssertionError("unsafe archive entry was accepted")
`;
  const result = runPython(["-c", smoke, resolve(repositoryRoot, path), target]);
  assert.equal(result.status, 0, `${path} failed executable parser/archive checks: ${result.stderr || result.stdout}`);
}

function verifyDescriptors() {
  verifyTomlSyntax(paths.blenderManifest);
  const blender = source(paths.blenderManifest);
  assert.match(blender, /^schema_version = "1\.0\.0"$/mu);
  assert.match(blender, /^version = "1\.0\.0"$/mu);
  assert.match(blender, /^blender_version_min = "4\.5\.0"$/mu);
  assert.match(blender, /^license = \["SPDX:MIT"\]$/mu);
  assert.match(blender, /^network = /mu);
  assert.match(blender, /^files = /mu);

  const unity = parseJson(paths.unityPackage);
  assert.equal(unity.name, "com.semaframe.bridge");
  assert.equal(unity.version, "1.0.0");
  assert.equal(unity.unity, "6000.0");
  assert.equal(unity.license, "MIT");
  assert.equal(unity.dependencies["com.unity.nuget.newtonsoft-json"], "3.2.1");
  assert.equal(parseJson(paths.unityRuntimeAsmdef).name, "SemaFrame.Bridge.Runtime");
  assert(parseJson(paths.unityEditorAsmdef).includePlatforms.includes("Editor"));

  const unreal = parseJson(paths.unrealPlugin);
  assert.equal(unreal.VersionName, "1.0.0");
  assert.equal(unreal.EngineVersion, "5.6.0");
  assert(unreal.Plugins.some((plugin) => plugin.Name === "PythonScriptPlugin" && plugin.Enabled));
  assert(unreal.Plugins.some((plugin) => plugin.Name === "USDImporter" && plugin.Enabled));
}

function verifyContractAgreement() {
  const contract = source(paths.bridgeContracts);
  assertContains(contract, [
    '"semaframe-scene-exchange"',
    '"semaframe-bridge-change-proposal"',
    'manifest: "semaframe.exchange.json"',
    'openUsd: "scene.usda"',
    'glb: "geometry.glb"',
    'exactStep: "exact/model.step"',
    'directMutation: false',
    'editsReturnAs: "reviewable_change_proposal"',
  ], "bridge contract");
  for (const [target, path, stableMarker] of [
    ["blender", paths.blenderSource, "semaframeStableId"],
    ["freecad", paths.freecadSource, "SemaFrameStableId"],
    ["unity", paths.unityWindow, "SemaFrameStableId"],
    ["unreal", paths.unrealSource, "SemaFrameStableId="],
  ]) {
    const text = source(path);
    assertContains(text, [
      "semaframe-scene-exchange",
      "semaframe-bridge-change-proposal",
      '"version"',
      `"${target}"`,
      "/v1/bridge/sessions/",
      "/exchange?digest=",
      "/proposals",
      "review_required",
      stableMarker,
      "semaframe.exchange.json",
      "fidelity-report.json",
      "scene.usda",
      "geometry.glb",
      "exact/model.step",
    ], `${target} adapter`);
  }
}

function verifySecurityMarkers() {
  const blender = source(paths.blenderSource);
  assertContains(blender, ["bpy.app.online_access", "SKIP_SAVE", "setup_json", "_parse_setup_json", "ProxyHandler({})", "_NoRedirect", "127.0.0.1", "info.external_attr", "hashlib.sha256"], "Blender adapter");
  assert(!/AddonPreferences[\s\S]{0,2000}bearer/iu.test(blender), "Blender must not persist the bearer in add-on preferences");

  const freecad = source(paths.freecadSource);
  assertContains(freecad, ["getpass.getpass", "--bearer-stdin", "--setup-stdin", "parse_setup_json", "ProxyHandler({})", "NoRedirect", "127.0.0.1", "info.external_attr", "hashlib.sha256"], "FreeCAD adapter");
  assert(!/add_argument\(["']--bearer["']/u.test(freecad), "FreeCAD must not expose a bearer argv value");
  assert(!/os\.environ[^\n]*BEARER/u.test(freecad), "FreeCAD must not silently source a persisted environment bearer");

  const unity = source(paths.unityWindow);
  assertContains(unity, ["[NonSerialized] private string setupJson", "[NonSerialized] private string bearer", "ConfigureFromSetupJson", "parsedSession.ToString(\"D\")", "AllowAutoRedirect = false", "UseProxy = false", "127.0.0.1", "ExternalAttributes", "SHA256.Create"], "Unity adapter");
  assert(!/EditorPrefs[^\n]*(?:bearer|token|capability)/iu.test(unity), "Unity must not persist credentials in EditorPrefs");
  assert(!/PlayerPrefs[^\n]*(?:bearer|token|capability)/iu.test(unity), "Unity must not persist credentials in PlayerPrefs");
  assert(!/\[SerializeField\][^\n]*bearer/iu.test(unity), "Unity bearer must not be serialized");

  const unreal = source(paths.unrealSource);
  assertContains(unreal, ['os.environ.pop("SEMAFRAME_BRIDGE_SETUP"', 'os.environ.pop("SEMAFRAME_BRIDGE_BEARER"', "_parse_setup_json", "ProxyHandler({})", "NoRedirect", "127.0.0.1", "info.external_attr", "hashlib.sha256"], "Unreal adapter");
  assert(!/def connect[^\n]*bearer/iu.test(unreal), "Unreal must not accept the bearer in a console function signature");
  assert(!/(?:configparser|save_config|set_editor_property)[^\n]*(?:bearer|token|capability)/iu.test(unreal), "Unreal must not persist credentials");
}

function verifyStaticImportBoundaries() {
  verifyPythonSyntax(paths.blenderSource);
  verifyPythonSyntax(paths.freecadSource);
  verifyPythonSyntax(paths.unrealInit);
  verifyPythonSyntax(paths.unrealSource);
  verifyPythonAdapterBehavior(paths.blenderSource, "blender");
  verifyPythonAdapterBehavior(paths.freecadSource, "freecad");
  verifyPythonAdapterBehavior(paths.unrealSource, "unreal");
  const unity = source(paths.unityWindow);
  assertContains(unity, ["class SemaFrameBridgeWindow", "class BridgeRuntime", "class SemaFrameGlbImporter", "SemaFrameBridgeSource", "SemaFrameStableId"], "Unity package");
  let braces = 0;
  for (const character of unity.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "")) {
    if (character === "{") braces += 1;
    if (character === "}") braces -= 1;
    assert(braces >= 0, "Unity source has an unmatched closing brace");
  }
  assert.equal(braces, 0, "Unity source has unmatched braces");
}

export function verifyBridgeAdapters() {
  verifyDescriptors();
  verifyContractAgreement();
  verifySecurityMarkers();
  verifyStaticImportBoundaries();
  for (const valid of ["geometry.glb", "exact/model.step", "semaframe.exchange.json"])
    assertSafeArchiveEntry(valid);
  return Object.freeze({ adapters: 4, protocolVersion: "1.0", executablePythonAdapterChecks: 3, staticHostSyntaxChecks: 4 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyBridgeAdapters();
  process.stdout.write(`Bridge adapters verified: ${result.adapters} adapters, protocol ${result.protocolVersion}, ${result.executablePythonAdapterChecks} executable Python checks, ${result.staticHostSyntaxChecks} host syntax/static checks.\n`);
}
