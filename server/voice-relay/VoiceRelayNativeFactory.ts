import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { VoiceRelayNativeClient } from "./VoiceRelayNativeClient";

export type VoiceRelayNativeFactoryOptions = Readonly<{
  workspaceRoot: string;
  platform?: NodeJS.Platform;
  helperPath?: string;
  helperArgs?: readonly string[];
  expectedSha256?: string;
  /** Development/test only. Production launchers must supply the packaged digest. */
  allowUnsignedDevelopmentHelper?: boolean;
  requestTimeoutMs?: number;
}>;

export class VoiceRelayNativeFactoryError extends Error {
  constructor(
    readonly code: "unsupported_platform" | "helper_invalid" | "helper_integrity_failed",
    message: string,
  ) {
    super(message);
    this.name = "VoiceRelayNativeFactoryError";
  }
}

export function defaultVoiceRelayHelperPath(workspaceRoot: string, platform: NodeJS.Platform = process.platform): string {
  const root = resolve(workspaceRoot);
  if (platform === "darwin") {
    return join(root, "native", "voice-relay", "macos", "build", "SemaFrameVoiceRelayHelper");
  }
  if (platform === "win32") {
    return join(root, "native", "voice-relay", "windows", "build", "SemaFrameVoiceRelayHelper.exe");
  }
  throw new VoiceRelayNativeFactoryError(
    "unsupported_platform",
    "Voice Relay native window control is available only on macOS and Windows.",
  );
}

/** Verifies the packaged binary before granting it the privileged child-process channel. */
export async function createVoiceRelayNativeClient(
  options: VoiceRelayNativeFactoryOptions,
): Promise<VoiceRelayNativeClient> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    throw new VoiceRelayNativeFactoryError(
      "unsupported_platform",
      "Voice Relay native window control is available only on macOS and Windows.",
    );
  }
  const helperPath = options.helperPath ?? defaultVoiceRelayHelperPath(options.workspaceRoot, platform);
  if (!isAbsolute(helperPath)) {
    throw new VoiceRelayNativeFactoryError("helper_invalid", "Voice Relay helper path must be absolute.");
  }
  const metadata = await lstat(helperPath).catch(() => undefined);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new VoiceRelayNativeFactoryError("helper_invalid", "Voice Relay helper must be a regular, non-symlink file.");
  }
  if (platform !== "win32") {
    if ((metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) {
      throw new VoiceRelayNativeFactoryError(
        "helper_invalid",
        "Voice Relay helper must be executable and not group/world writable.",
      );
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && metadata.uid !== currentUid && metadata.uid !== 0) {
      throw new VoiceRelayNativeFactoryError("helper_invalid", "Voice Relay helper owner is not trusted.");
    }
  }
  if (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(options.expectedSha256)) {
    throw new VoiceRelayNativeFactoryError("helper_integrity_failed", "Voice Relay helper digest is invalid.");
  }
  if (!options.expectedSha256 && !options.allowUnsignedDevelopmentHelper) {
    throw new VoiceRelayNativeFactoryError(
      "helper_integrity_failed",
      "A packaged Voice Relay helper SHA-256 digest is required.",
    );
  }
  if (options.expectedSha256) {
    const actual = createHash("sha256").update(await readFile(helperPath)).digest("hex");
    if (actual !== options.expectedSha256) {
      throw new VoiceRelayNativeFactoryError("helper_integrity_failed", "Voice Relay helper integrity check failed.");
    }
  }
  const client = new VoiceRelayNativeClient({
    command: helperPath,
    args: options.helperArgs,
    requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
  });
  try {
    await client.health();
    return client;
  } catch (cause) {
    await client.close();
    throw cause;
  }
}
