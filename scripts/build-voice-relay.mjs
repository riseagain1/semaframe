import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function modifiedAt(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function helperBuildSpec(platform = process.platform) {
  if (platform === "darwin") {
    const directory = join(SCRIPT_ROOT, "native", "voice-relay", "macos");
    return {
      source: join(directory, "SemaFrameVoiceRelayHelper.swift"),
      output: join(directory, "build", "SemaFrameVoiceRelayHelper"),
      command: "/bin/sh",
      args: [join(directory, "build.sh")],
    };
  }
  if (platform === "win32") {
    const directory = join(SCRIPT_ROOT, "native", "voice-relay", "windows");
    return {
      source: join(directory, "Program.cs"),
      output: join(directory, "build", "SemaFrameVoiceRelayHelper.exe"),
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(directory, "build.ps1")],
    };
  }
  return undefined;
}

/** Builds only when missing or stale. Optional mode keeps the rest of SemaFrame usable. */
export function buildVoiceRelayNativeHelper({ optional = false, platform = process.platform } = {}) {
  const spec = helperBuildSpec(platform);
  if (!spec) return { status: "unsupported" };
  if (modifiedAt(spec.output) >= modifiedAt(spec.source) && modifiedAt(spec.output) >= 0) {
    return { status: "current", output: spec.output };
  }
  const result = spawnSync(spec.command, spec.args, {
    cwd: SCRIPT_ROOT,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || modifiedAt(spec.output) < 0) {
    if (optional) {
      console.warn("SemaFrame Voice Relay helper could not be built; optional relay setup will remain unavailable.");
      return { status: "unavailable" };
    }
    throw result.error ?? new Error("SemaFrame Voice Relay helper build failed.");
  }
  return { status: "built", output: spec.output };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = buildVoiceRelayNativeHelper();
    if (result.status === "unsupported") {
      console.error("Voice Relay native helpers are supported only on macOS and Windows.");
      process.exitCode = 1;
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "Voice Relay helper build failed.");
    process.exitCode = 1;
  }
}
