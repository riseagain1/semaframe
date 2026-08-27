import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalizeExtensionJson,
  assertExtensionHostCompatibilityV1,
  assertVerifiedExtensionPackageV1,
  extensionManifestSha256V1,
  isSafeExtensionPackagePathV1,
  parseExtensionManifestV1,
  sha256ExtensionBytes,
  type ExtensionJsonValue,
  type ExtensionManifestV1,
  type ExtensionPackageVerificationV1,
  type ExtensionPermissionIdV1,
  type ExtensionProviderDescriptorV1,
} from "../../src/extensions";
import {
  DEFAULT_EXTENSION_MAX_FRAME_BYTES,
  encodeExtensionRpcFrameV1,
  EXTENSION_NATIVE_PROTOCOL,
  ExtensionRpcFrameDecoderV1,
  type ExtensionRpcMessageV1,
  type ExtensionRpcRequestV1,
  type ExtensionRpcResponseV1,
} from "./ExtensionNativeProtocol";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_MAX_PENDING = 32;
const KILL_GRACE_MS = 500;

export class NativeStdioExtensionHostError extends Error {
  constructor(
    readonly code:
      | "invalid_configuration"
      | "incompatible_host"
      | "package_verification_failed"
      | "package_root_verification_failed"
      | "entrypoint_escape"
      | "process_unavailable"
      | "protocol_error"
      | "request_timeout"
      | "request_aborted"
      | "request_failed"
      | "process_closed"
      | "capacity_exhausted"
      | "permission_denied",
    message: string,
  ) {
    super(message);
    this.name = "NativeStdioExtensionHostError";
  }
}

export type ExtensionHostAuthorizationRequestV1 = Readonly<{
  extensionId: string;
  extensionVersion: string;
  manifestSha256: `sha256:${string}`;
  providerId: string;
  permission: ExtensionPermissionIdV1;
}>;

export type NativeStdioExtensionHostOptions = Readonly<{
  manifest: ExtensionManifestV1;
  /** Ephemeral evidence returned by verifyExtensionPackageV1 for this exact manifest/package. */
  packageVerification: ExtensionPackageVerificationV1;
  /** Absolute extracted root; every entry must exactly match manifest.package.rootFiles. */
  packageRoot: string;
  hostVersion: string;
  /** Optional absolute interpreter/runner. Without one the package entrypoint is executed directly. */
  command?: string;
  extraArgs?: readonly string[];
  cwd?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  maxFrameBytes?: number;
  maxStderrBytes?: number;
  maxPendingRequests?: number;
  environment?: Readonly<Record<string, string>>;
  authorize(request: ExtensionHostAuthorizationRequestV1): void | Promise<void>;
  handleHostCall?: (
    method: string,
    params: ExtensionJsonValue,
    context: Readonly<{ signal: AbortSignal }>,
  ) => ExtensionJsonValue | Promise<ExtensionJsonValue>;
  onStderr?: (text: string) => void;
}>;

export type ExtensionInvokeOptionsV1 = Readonly<{
  permission: ExtensionPermissionIdV1;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

type PendingRequest = Readonly<{
  resolve(value: ExtensionJsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort(): void;
}>;

type ResolvedLaunch = Readonly<{
  manifest: ExtensionManifestV1;
  manifestSha256: `sha256:${string}`;
  packageRoot: string;
  entrypoint: string;
  command: string;
  args: readonly string[];
  cwd: string;
  snapshotRoot: string;
}>;

type PackageRootFileV1 = ExtensionManifestV1["package"]["rootFiles"][number];
type PackageRootTree = Readonly<{
  files: ReadonlySet<string>;
  directories: ReadonlySet<string>;
}>;

const MAX_PACKAGE_ROOT_ENTRIES = 8_192;

function within(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function portableRelative(parent: string, candidate: string): string {
  return relative(parent, candidate).split(sep).join("/");
}

function packageRootError(message: string): NativeStdioExtensionHostError {
  return new NativeStdioExtensionHostError("package_root_verification_failed", message);
}

async function scanPackageRoot(root: string): Promise<PackageRootTree> {
  const files = new Set<string>();
  const directories = new Set<string>();
  let entriesSeen = 0;
  const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    let entries;
    try {
      const directory = await opendir(absoluteDirectory);
      entries = [];
      for await (const entry of directory) entries.push(entry);
    } catch {
      throw packageRootError("Extension package root contains an unreadable directory.");
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_PACKAGE_ROOT_ENTRIES) {
        throw packageRootError(`Extension package root exceeds ${MAX_PACKAGE_ROOT_ENTRIES} entries.`);
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!isSafeExtensionPackagePathV1(relativePath)) {
        throw packageRootError("Extension package root contains a non-canonical or unsafe relative path.");
      }
      const absolutePath = join(absoluteDirectory, entry.name);
      let status;
      try {
        status = await lstat(absolutePath);
      } catch {
        throw packageRootError(`Extension package root entry ${relativePath} changed during verification.`);
      }
      if (status.isSymbolicLink()) {
        throw packageRootError(`Extension package root entry ${relativePath} must not be a symbolic link.`);
      }
      if (status.isDirectory()) {
        directories.add(relativePath);
        await visit(absolutePath, relativePath);
      } else if (status.isFile()) {
        files.add(relativePath);
      } else {
        throw packageRootError(`Extension package root entry ${relativePath} must be a regular file or directory.`);
      }
    }
  };
  await visit(root, "");
  return Object.freeze({ files, directories });
}

function expectedPackageDirectories(files: readonly PackageRootFileV1[]): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return directories;
}

function assertPackageRootShape(tree: PackageRootTree, manifest: ExtensionManifestV1): void {
  const expectedFiles = new Set(manifest.package.rootFiles.map((file) => file.path));
  const expectedDirectories = expectedPackageDirectories(manifest.package.rootFiles);
  const missingFile = [...expectedFiles].find((path) => !tree.files.has(path));
  const extraFile = [...tree.files].find((path) => !expectedFiles.has(path));
  const missingDirectory = [...expectedDirectories].find((path) => !tree.directories.has(path));
  const extraDirectory = [...tree.directories].find((path) => !expectedDirectories.has(path));
  if (missingFile || extraFile || missingDirectory || extraDirectory) {
    throw packageRootError("Extension package root does not exactly match the manifest-pinned file tree.");
  }
}

async function readVerifiedPackageFile(
  root: string,
  file: PackageRootFileV1,
): Promise<Uint8Array> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolve(root, file.path));
  } catch {
    throw packageRootError(`Extension package file ${file.path} is unavailable.`);
  }
  if (!within(root, canonicalPath)) {
    throw packageRootError(`Extension package file ${file.path} escapes the package root.`);
  }
  let handle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw packageRootError(`Extension package file ${file.path} could not be opened without following links.`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(file.byteLength)) {
      throw packageRootError(`Extension package file ${file.path} has the wrong type or byte length.`);
    }
    const bytes = Uint8Array.from(await handle.readFile());
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      throw packageRootError(`Extension package file ${file.path} changed while it was being read.`);
    }
    const digest = await sha256ExtensionBytes(bytes);
    if (bytes.byteLength !== file.byteLength || !capabilityMatches(digest, file.sha256)) {
      throw packageRootError(`Extension package file ${file.path} does not match its manifest digest.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyPackageRootTree(root: string, manifest: ExtensionManifestV1): Promise<void> {
  assertPackageRootShape(await scanPackageRoot(root), manifest);
  for (const file of manifest.package.rootFiles) await readVerifiedPackageFile(root, file);
}

async function makeSnapshotDirectoriesReadOnly(root: string, directories: ReadonlySet<string>): Promise<void> {
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await chmod(resolve(root, directory), 0o500);
  }
  await chmod(root, 0o500);
}

async function restoreDirectoryWrites(root: string): Promise<void> {
  try {
    await chmod(root, 0o700);
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await restoreDirectoryWrites(join(root, entry.name));
    }
  } catch {
    // Best-effort preparation for removal; rm reports any material failure.
  }
}

async function cleanupSnapshot(root: string): Promise<void> {
  await restoreDirectoryWrites(root);
  await rm(root, { recursive: true, force: true });
}

async function sealPackageRoot(sourceRoot: string, manifest: ExtensionManifestV1): Promise<string> {
  if (manifest.entrypoint.kind !== "native_stdio") {
    throw packageRootError("Only native stdio extensions have an executable package root.");
  }
  const entrypointPath = manifest.entrypoint.path;
  await verifyPackageRootTree(sourceRoot, manifest);
  const snapshotRoot = await realpath(await mkdtemp(join(tmpdir(), "semaframe-extension-")));
  const directories = expectedPackageDirectories(manifest.package.rootFiles);
  try {
    for (const directory of [...directories].sort()) {
      await mkdir(resolve(snapshotRoot, directory), { recursive: true, mode: 0o700 });
    }
    for (const file of manifest.package.rootFiles) {
      const bytes = await readVerifiedPackageFile(sourceRoot, file);
      await writeFile(resolve(snapshotRoot, file.path), bytes, {
        flag: "wx",
        mode: file.path === entrypointPath ? 0o500 : 0o400,
      });
    }
    // Detect source-tree additions/removals that raced the copy. Later source
    // changes are irrelevant because execution uses only this private snapshot.
    await verifyPackageRootTree(sourceRoot, manifest);
    await verifyPackageRootTree(snapshotRoot, manifest);
    await makeSnapshotDirectoriesReadOnly(snapshotRoot, directories);
    return snapshotRoot;
  } catch (error) {
    await cleanupSnapshot(snapshotRoot);
    throw error;
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new NativeStdioExtensionHostError("invalid_configuration", `${label} must be between ${min} and ${max}.`);
  }
  return resolved;
}

function exactObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NativeStdioExtensionHostError("protocol_error", `${label} must be an object.`);
  }
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) throw new NativeStdioExtensionHostError("protocol_error", `${label} contains unknown field ${extra}.`);
  return body;
}

function safeEnvironment(environment: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined && value.length <= 4_096) output[name] = value;
  }
  output.NO_COLOR = "1";
  output.SEMAFRAME_EXTENSION_PROTOCOL = "1";
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (!/^SEMAFRAME_EXTENSION_[A-Z0-9_]{1,64}$/u.test(name)
      || name === "SEMAFRAME_EXTENSION_PROTOCOL"
      || typeof value !== "string"
      || value.length > 1_024
      || /[\u0000\r\n]/u.test(value)) {
      throw new NativeStdioExtensionHostError("invalid_configuration", `Extension environment field ${name} is not allowed.`);
    }
    output[name] = value;
  }
  return output;
}

async function resolveLaunch(options: NativeStdioExtensionHostOptions): Promise<ResolvedLaunch> {
  const manifest = parseExtensionManifestV1(options.manifest);
  try {
    assertExtensionHostCompatibilityV1(manifest, options.hostVersion);
  } catch (error) {
    throw new NativeStdioExtensionHostError(
      "incompatible_host",
      error instanceof Error ? error.message : "Extension is incompatible with this host.",
    );
  }
  try {
    await assertVerifiedExtensionPackageV1(manifest, options.packageVerification);
  } catch (error) {
    throw new NativeStdioExtensionHostError(
      "package_verification_failed",
      error instanceof Error ? error.message : "Extension package verification failed.",
    );
  }
  if (manifest.entrypoint.kind !== "native_stdio") {
    throw new NativeStdioExtensionHostError("invalid_configuration", "Native stdio host requires a native_stdio extension entrypoint.");
  }
  if (!isAbsolute(options.packageRoot)) {
    throw new NativeStdioExtensionHostError("invalid_configuration", "Extension package root must be absolute.");
  }
  let sourcePackageRoot: string;
  let sourceCwd: string;
  let externalCommand: string | undefined;
  try {
    const rootStatus = await lstat(options.packageRoot);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      throw packageRootError("Extension package root must be a real directory, not a symbolic link.");
    }
    sourcePackageRoot = await realpath(options.packageRoot);
    sourceCwd = await realpath(options.cwd ?? sourcePackageRoot);
    externalCommand = options.command ? await realpath(options.command) : undefined;
  } catch (error) {
    if (error instanceof NativeStdioExtensionHostError) throw error;
    throw new NativeStdioExtensionHostError("process_unavailable", "Extension package root, working directory, or runner is unavailable.");
  }
  if (!within(sourcePackageRoot, sourceCwd)) {
    throw new NativeStdioExtensionHostError("entrypoint_escape", "Extension working directory must remain inside the verified package root.");
  }
  if (externalCommand && within(sourcePackageRoot, externalCommand)) {
    throw new NativeStdioExtensionHostError(
      "invalid_configuration",
      "An optional host runner must be outside the extension package root; execute a packaged binary as the entrypoint instead.",
    );
  }
  const cwdRelative = portableRelative(sourcePackageRoot, sourceCwd);
  if (cwdRelative && !isSafeExtensionPackagePathV1(cwdRelative)) {
    throw new NativeStdioExtensionHostError("invalid_configuration", "Extension working directory is not a canonical package path.");
  }
  const extraArgs = options.extraArgs ?? [];
  if (extraArgs.length > 32 || extraArgs.some((arg) => typeof arg !== "string" || arg.length > 512 || /\u0000/u.test(arg))) {
    throw new NativeStdioExtensionHostError("invalid_configuration", "Extension runner arguments are invalid.");
  }
  const snapshotRoot = await sealPackageRoot(sourcePackageRoot, manifest);
  try {
    const entrypoint = resolve(snapshotRoot, manifest.entrypoint.path);
    const cwd = cwdRelative ? resolve(snapshotRoot, cwdRelative) : snapshotRoot;
    const cwdStatus = await lstat(cwd);
    if (!cwdStatus.isDirectory() || cwdStatus.isSymbolicLink()) {
      throw packageRootError("Extension working directory is not present in the verified package snapshot.");
    }
    const command = externalCommand ?? entrypoint;
    if (!isAbsolute(command)) {
      throw new NativeStdioExtensionHostError("invalid_configuration", "Extension command must be absolute.");
    }
    const args = externalCommand
      ? [entrypoint, ...manifest.entrypoint.args, ...extraArgs]
      : [...manifest.entrypoint.args, ...extraArgs];
    return Object.freeze({
      manifest,
      manifestSha256: await extensionManifestSha256V1(manifest),
      packageRoot: snapshotRoot,
      entrypoint,
      command,
      args: Object.freeze(args),
      cwd,
      snapshotRoot,
    });
  } catch (error) {
    await cleanupSnapshot(snapshotRoot);
    throw error;
  }
}

function capabilityMatches(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function requestedPermissions(manifest: ExtensionManifestV1): ReadonlySet<ExtensionPermissionIdV1> {
  return new Set(manifest.requestedPermissions.map((request) => request.permission));
}

function providerMethodPermission(
  provider: ExtensionProviderDescriptorV1,
  method: string,
  suppliedPermission: ExtensionPermissionIdV1,
): ExtensionPermissionIdV1 {
  if (provider.kind === "connector") {
    if (method !== "probe" && method !== "read") {
      throw new NativeStdioExtensionHostError("invalid_configuration", `Connector method ${method} is not declared by API v1.`);
    }
    return "connector:execute";
  }
  if (provider.kind === "importer") {
    if (method !== "inspect" && method !== "import") {
      throw new NativeStdioExtensionHostError("invalid_configuration", `Importer method ${method} is not declared by API v1.`);
    }
    return "importer:execute";
  }
  if (provider.kind === "exporter") {
    if (method !== "plan" && method !== "export") {
      throw new NativeStdioExtensionHostError("invalid_configuration", `Exporter method ${method} is not declared by API v1.`);
    }
    return "exporter:execute";
  }
  if (method === "pull") {
    if (!provider.directions.includes("pull")) {
      throw new NativeStdioExtensionHostError("permission_denied", `Bridge ${provider.id} does not declare pull.`);
    }
    return "bridge:pull";
  }
  if (method === "push") {
    if (!provider.directions.includes("push")) {
      throw new NativeStdioExtensionHostError("permission_denied", `Bridge ${provider.id} does not declare push.`);
    }
    return "bridge:push";
  }
  if (method === "probe") {
    if (suppliedPermission === "bridge:pull" && provider.directions.includes("pull")) return suppliedPermission;
    if (suppliedPermission === "bridge:push" && provider.directions.includes("push")) return suppliedPermission;
    throw new NativeStdioExtensionHostError(
      "permission_denied",
      `Bridge ${provider.id} probe requires one of its declared direction permissions.`,
    );
  }
  throw new NativeStdioExtensionHostError("invalid_configuration", `Bridge method ${method} is not declared by API v1.`);
}

/**
 * Owns exactly one extension subprocess. The boundary is length-framed JSON,
 * shell-free, capability-scoped, size-bounded in both directions, and starts
 * with no inherited credentials or ambient PATH/HOME.
 */
export class NativeStdioExtensionHost {
  readonly manifest: ExtensionManifestV1;
  readonly manifestSha256: `sha256:${string}`;
  readonly #capability = randomBytes(32).toString("base64url");
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder: ExtensionRpcFrameDecoderV1;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #inbound = new Map<string, AbortController>();
  readonly #requestTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #maxFrameBytes: number;
  readonly #maxStderrBytes: number;
  readonly #maxPendingRequests: number;
  readonly #authorize: NativeStdioExtensionHostOptions["authorize"];
  readonly #handleHostCall: NativeStdioExtensionHostOptions["handleHostCall"];
  readonly #onStderr: NativeStdioExtensionHostOptions["onStderr"];
  readonly #snapshotRoot: string;
  readonly #exitPromise: Promise<void>;
  #resolveExit!: () => void;
  #nextRequestId = 1;
  #stderrBytes = 0;
  #closed = false;
  #exited = false;
  #closing = false;

  static async launch(options: NativeStdioExtensionHostOptions): Promise<NativeStdioExtensionHost> {
    if (typeof options.authorize !== "function") {
      throw new NativeStdioExtensionHostError("invalid_configuration", "Extension host requires an authorization callback.");
    }
    const resolved = await resolveLaunch(options);
    try {
      await options.authorize({
        extensionId: resolved.manifest.id,
        extensionVersion: resolved.manifest.version,
        manifestSha256: resolved.manifestSha256,
        providerId: resolved.manifest.providers[0]!.id,
        permission: "native:stdio",
      });
    } catch {
      await cleanupSnapshot(resolved.snapshotRoot);
      throw new NativeStdioExtensionHostError("permission_denied", "Extension permission native:stdio was denied.");
    }
    try {
      await verifyPackageRootTree(resolved.snapshotRoot, resolved.manifest);
    } catch (error) {
      await cleanupSnapshot(resolved.snapshotRoot);
      throw error;
    }
    let host: NativeStdioExtensionHost;
    try {
      host = new NativeStdioExtensionHost(options, resolved);
    } catch (error) {
      await cleanupSnapshot(resolved.snapshotRoot);
      throw error;
    }
    try {
      await host.#initialize();
      return host;
    } catch (error) {
      await host.kill("Extension initialization failed.");
      throw error;
    }
  }

  private constructor(options: NativeStdioExtensionHostOptions, resolved: ResolvedLaunch) {
    this.manifest = resolved.manifest;
    this.manifestSha256 = resolved.manifestSha256;
    this.#requestTimeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 100, 120_000, "requestTimeoutMs");
    this.#startupTimeoutMs = boundedInteger(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 100, 30_000, "startupTimeoutMs");
    this.#maxFrameBytes = boundedInteger(options.maxFrameBytes, DEFAULT_EXTENSION_MAX_FRAME_BYTES, 1024, 16 * 1024 * 1024, "maxFrameBytes");
    this.#maxStderrBytes = boundedInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 1024, 4 * 1024 * 1024, "maxStderrBytes");
    this.#maxPendingRequests = boundedInteger(options.maxPendingRequests, DEFAULT_MAX_PENDING, 1, 256, "maxPendingRequests");
    this.#authorize = options.authorize;
    this.#handleHostCall = options.handleHostCall;
    this.#onStderr = options.onStderr;
    this.#snapshotRoot = resolved.snapshotRoot;
    this.#decoder = new ExtensionRpcFrameDecoderV1(this.#maxFrameBytes);
    this.#exitPromise = new Promise<void>((resolveExit) => { this.#resolveExit = resolveExit; });
    this.#child = spawn(resolved.command, [...resolved.args], {
      cwd: resolved.cwd,
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeEnvironment(options.environment),
    });
    this.#child.stdout.on("data", (chunk: Buffer | string) => this.#receive(Buffer.from(chunk)));
    this.#child.stderr.on("data", (chunk: Buffer | string) => this.#receiveStderr(Buffer.from(chunk)));
    this.#child.stdin.on("error", () => this.#failClosed("Extension input pipe closed."));
    this.#child.once("error", () => this.#failClosed("Extension process failed to start.", "process_unavailable"));
    this.#child.once("close", () => {
      this.#exited = true;
      this.#closed = true;
      try {
        this.#decoder.finish();
      } catch {
        this.#failAll(new NativeStdioExtensionHostError("protocol_error", "Extension closed with a partial frame."));
      }
      this.#failAll(new NativeStdioExtensionHostError("process_closed", "Extension process closed."));
      for (const controller of this.#inbound.values()) controller.abort();
      this.#inbound.clear();
      void cleanupSnapshot(this.#snapshotRoot)
        .catch(() => undefined)
        .finally(() => this.#resolveExit());
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #initialize(): Promise<void> {
    const result = await this.#requestRaw("initialize", {
      apiVersion: "1.0",
      protocol: EXTENSION_NATIVE_PROTOCOL,
      extensionId: this.manifest.id,
      extensionVersion: this.manifest.version,
      manifestSha256: this.manifestSha256,
      providers: this.manifest.providers.map((provider) => ({ id: provider.id, kind: provider.kind })),
      limits: {
        maxFrameBytes: this.#maxFrameBytes,
        maxPendingRequests: this.#maxPendingRequests,
      },
    }, undefined, this.#startupTimeoutMs);
    const body = exactObject(
      result,
      ["apiVersion", "protocol", "extensionId", "extensionVersion", "manifestSha256", "providerIds"],
      "Extension initialize result",
    );
    if (body.apiVersion !== "1.0"
      || body.protocol !== EXTENSION_NATIVE_PROTOCOL
      || body.extensionId !== this.manifest.id
      || body.extensionVersion !== this.manifest.version
      || body.manifestSha256 !== this.manifestSha256
      || !Array.isArray(body.providerIds)
      || body.providerIds.some((id) => typeof id !== "string")) {
      throw new NativeStdioExtensionHostError("protocol_error", "Extension initialize identity did not match the verified manifest.");
    }
    const expected = [...this.manifest.providers.map((provider) => provider.id)].sort();
    const actual = [...body.providerIds as string[]].sort();
    if (canonicalizeExtensionJson(expected) !== canonicalizeExtensionJson(actual)) {
      throw new NativeStdioExtensionHostError("protocol_error", "Extension initialize providers did not match the verified manifest.");
    }
  }

  async invoke(
    providerId: string,
    method: string,
    input: ExtensionJsonValue,
    options: ExtensionInvokeOptionsV1,
  ): Promise<ExtensionJsonValue> {
    const provider = this.manifest.providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new NativeStdioExtensionHostError("invalid_configuration", `Extension provider ${providerId} is not declared.`);
    }
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(method)) {
      throw new NativeStdioExtensionHostError("invalid_configuration", "Extension provider method is invalid.");
    }
    canonicalizeExtensionJson(input);
    const requiredPermission = providerMethodPermission(provider, method, options.permission);
    if (options.permission !== requiredPermission) {
      throw new NativeStdioExtensionHostError(
        "permission_denied",
        `Provider ${providerId} requires ${requiredPermission}; caller supplied ${options.permission}.`,
      );
    }
    if (!requestedPermissions(this.manifest).has(requiredPermission)) {
      throw new NativeStdioExtensionHostError("permission_denied", `Extension did not request ${requiredPermission}.`);
    }
    try {
      await this.#authorize({
        extensionId: this.manifest.id,
        extensionVersion: this.manifest.version,
        manifestSha256: this.manifestSha256,
        providerId,
        permission: requiredPermission,
      });
    } catch {
      throw new NativeStdioExtensionHostError("permission_denied", `Extension permission ${requiredPermission} was denied.`);
    }
    return this.#requestRaw("provider.invoke", { providerId, method, input }, options.signal, options.timeoutMs);
  }

  async close(): Promise<void> {
    if (this.#exited) return;
    if (this.#closed && !this.#closing) {
      await this.#exitPromise;
      return;
    }
    this.#closing = true;
    try {
      const response = exactObject(
        await this.#requestRaw("shutdown", {}, undefined, Math.min(this.#requestTimeoutMs, 2_000)),
        ["closed"],
        "Extension shutdown result",
      );
      if (response.closed !== true) throw new Error("invalid shutdown acknowledgement");
      this.#child.stdin.end();
      if (!await this.#waitForExit(KILL_GRACE_MS)) await this.kill("Extension shutdown grace expired.");
    } catch {
      await this.kill("Extension shutdown failed.");
    } finally {
      this.#closing = false;
    }
  }

  async kill(reason = "Extension process was terminated."): Promise<void> {
    this.#beginKill(reason);
    await this.#waitForExit(KILL_GRACE_MS + 250);
  }

  #requestRaw(
    method: string,
    params: ExtensionJsonValue,
    signal?: AbortSignal,
    timeoutMsValue?: number,
  ): Promise<ExtensionJsonValue> {
    if (this.#closed) {
      return Promise.reject(new NativeStdioExtensionHostError("process_closed", "Extension process is closed."));
    }
    if (signal?.aborted) {
      return Promise.reject(new NativeStdioExtensionHostError("request_aborted", "Extension request was aborted."));
    }
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(new NativeStdioExtensionHostError("capacity_exhausted", "Extension pending request capacity is exhausted."));
    }
    const timeoutMs = boundedInteger(timeoutMsValue, this.#requestTimeoutMs, 100, 120_000, "request timeout");
    const id = `h_${this.#nextRequestId++}`;
    if (!Number.isSafeInteger(this.#nextRequestId)) {
      return Promise.reject(new NativeStdioExtensionHostError("capacity_exhausted", "Extension request sequence is exhausted."));
    }
    const request: ExtensionRpcRequestV1 = Object.freeze({
      protocol: EXTENSION_NATIVE_PROTOCOL,
      type: "request",
      id,
      capability: this.#capability,
      method,
      params,
    });
    return new Promise<ExtensionJsonValue>((resolveRequest, rejectRequest) => {
      const interrupt = (error: NativeStdioExtensionHostError) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanupAbort();
        rejectRequest(error);
        this.#sendCancellation(id);
        this.#beginKill(error.message);
      };
      const timer = setTimeout(() => interrupt(new NativeStdioExtensionHostError(
        "request_timeout",
        `Extension request ${method} timed out and the process was terminated.`,
      )), timeoutMs);
      timer.unref?.();
      const onAbort = () => interrupt(new NativeStdioExtensionHostError(
        "request_aborted",
        `Extension request ${method} was aborted and the process was terminated.`,
      ));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, Object.freeze({
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
        cleanupAbort: () => signal?.removeEventListener("abort", onAbort),
      }));
      void this.#write(request).catch(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanupAbort();
        pending.reject(new NativeStdioExtensionHostError("process_closed", "Extension input pipe closed."));
        this.#beginKill("Extension input pipe closed.");
      });
    });
  }

  #receive(chunk: Uint8Array): void {
    try {
      for (const message of this.#decoder.push(chunk)) this.#receiveMessage(message);
    } catch {
      this.#protocolFailure("Extension emitted an invalid or oversized RPC frame.");
    }
  }

  #receiveMessage(message: ExtensionRpcMessageV1): void {
    if (!capabilityMatches(this.#capability, message.capability)) {
      this.#protocolFailure("Extension RPC capability did not match this process.");
      return;
    }
    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#protocolFailure("Extension returned an unknown response id.");
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      if (message.error) {
        pending.reject(new NativeStdioExtensionHostError(
          "request_failed",
          `${message.error.code}: ${message.error.message}`,
        ));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }
    if (message.type === "notification") {
      this.#inbound.get(message.params.requestId)?.abort();
      return;
    }
    void this.#handleInboundRequest(message);
  }

  async #handleInboundRequest(request: ExtensionRpcRequestV1): Promise<void> {
    if (!request.id.startsWith("x_") || this.#inbound.has(request.id) || this.#inbound.size >= this.#maxPendingRequests) {
      this.#protocolFailure("Extension host-call request id or capacity is invalid.");
      return;
    }
    const controller = new AbortController();
    this.#inbound.set(request.id, controller);
    try {
      if (!this.#handleHostCall) {
        await this.#write({
          protocol: EXTENSION_NATIVE_PROTOCOL,
          type: "response",
          id: request.id,
          capability: this.#capability,
          error: Object.freeze({ code: "host_method_unavailable", message: "Host callbacks are not enabled." }),
        });
        return;
      }
      const result = await this.#handleHostCall(request.method, request.params, { signal: controller.signal });
      canonicalizeExtensionJson(result);
      await this.#write({
        protocol: EXTENSION_NATIVE_PROTOCOL,
        type: "response",
        id: request.id,
        capability: this.#capability,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300) : "Host callback failed.";
      try {
        await this.#write({
          protocol: EXTENSION_NATIVE_PROTOCOL,
          type: "response",
          id: request.id,
          capability: this.#capability,
          error: Object.freeze({ code: controller.signal.aborted ? "host_call_aborted" : "host_call_failed", message }),
        });
      } catch {
        this.#protocolFailure("Extension host-call response could not be written.");
      }
    } finally {
      this.#inbound.delete(request.id);
    }
  }

  #sendCancellation(requestId: string): void {
    if (this.#closed) return;
    void this.#write({
      protocol: EXTENSION_NATIVE_PROTOCOL,
      type: "notification",
      capability: this.#capability,
      method: "cancel",
      params: Object.freeze({ requestId }),
    }).catch(() => undefined);
  }

  #write(message: ExtensionRpcMessageV1): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new NativeStdioExtensionHostError("process_closed", "Extension process is closed."));
    }
    const frame = encodeExtensionRpcFrameV1(message, this.#maxFrameBytes);
    return new Promise<void>((resolveWrite, rejectWrite) => {
      this.#child.stdin.write(frame, (error) => {
        if (error) rejectWrite(new NativeStdioExtensionHostError("process_closed", "Extension input pipe closed."));
        else resolveWrite();
      });
    });
  }

  #receiveStderr(chunk: Uint8Array): void {
    this.#stderrBytes += chunk.byteLength;
    if (this.#stderrBytes > this.#maxStderrBytes) {
      this.#protocolFailure("Extension stderr exceeded its byte limit.");
      return;
    }
    if (this.#onStderr) {
      const text = Buffer.from(chunk).toString("utf8").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ").slice(0, 2_000);
      if (text) this.#onStderr(text);
    }
  }

  #protocolFailure(message: string): void {
    this.#failAll(new NativeStdioExtensionHostError("protocol_error", message));
    this.#beginKill(message);
  }

  #failClosed(message: string, code: "process_closed" | "process_unavailable" = "process_closed"): void {
    this.#failAll(new NativeStdioExtensionHostError(code, message));
    this.#beginKill(message);
  }

  #failAll(error: NativeStdioExtensionHostError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #beginKill(reason: string): void {
    if (this.#exited) return;
    this.#closed = true;
    this.#failAll(new NativeStdioExtensionHostError("process_closed", reason));
    for (const controller of this.#inbound.values()) controller.abort();
    this.#inbound.clear();
    try { this.#child.stdin.destroy(); } catch { /* already closed */ }
    try { this.#child.kill("SIGTERM"); } catch { /* already exited */ }
    const timer = setTimeout(() => {
      if (!this.#exited) {
        try { this.#child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) return true;
    return new Promise<boolean>((resolveWait) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolveWait(false);
      }, timeoutMs);
      timer.unref?.();
      void this.#exitPromise.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveWait(true);
      });
    });
  }
}
