import { execFile, spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { lstat, readdir, realpath, statfs } from "node:fs/promises";
import { freemem } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { PHOTO_RECONSTRUCTION_LIMITS } from "../../src/reconstruction/contracts";
import {
  RECONSTRUCTION_DETAILS,
  ReconstructionBackendError,
} from "./ReconstructionBackend";
import type {
  ReconstructionBackend,
  ReconstructionBackendProbe,
  ReconstructionProgressEvent,
  ReconstructionRequest,
  ReconstructionResult,
} from "./ReconstructionBackend";

const moduleUrl = new URL(import.meta.url);
const DEFAULT_SCRIPT_PATH = moduleUrl.protocol === "file:"
  ? fileURLToPath(new URL("../../scripts/apple-object-capture.swift", moduleUrl))
  : resolve(process.cwd(), "scripts/apple-object-capture.swift");
const DEFAULT_RECONSTRUCTION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_ARTIFACTS = 100_000;
const MAX_DIRECTORY_DEPTH = 24;
const DEFAULT_OUTPUT_QUOTA_POLL_MS = 1_000;
const DEFAULT_MEMORY_POLL_MS = 1_000;
const DEFAULT_PROBE_PROCESS_RSS_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_OUTPUT_FREE_SPACE_RESERVE_BYTES =
  PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeReserveBytes;
const DEFAULT_FREE_MEMORY_RESERVE_BYTES =
  PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeMemoryReserveBytes;
const DEFAULT_OUTPUT_BYTES_BY_DETAIL = Object.freeze({
  preview: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureOutputBytesByProfile.preview,
  reduced: 2 * 1024 * 1024 * 1024,
  medium: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureOutputBytesByProfile.balanced,
  full: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureOutputBytesByProfile.quality,
});
const DEFAULT_MAXIMUM_PIXELS_BY_DETAIL = Object.freeze({
  preview: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumPixelsByProfile.preview,
  reduced: 400_000_000,
  medium: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumPixelsByProfile.balanced,
  full: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumPixelsByProfile.quality,
});
const DEFAULT_MAXIMUM_PROCESS_RSS_BYTES_BY_DETAIL = Object.freeze({
  preview: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile.preview,
  reduced: 3 * 1024 * 1024 * 1024,
  medium: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile.balanced,
  full: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile.quality,
});
const MAX_PROCESS_TABLE_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_TABLE_ROWS = 131_072;
const execFileAsync = promisify(execFile);

type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

type AvailableOutputBytes = (path: string) => Promise<bigint>;
type AvailableMemoryBytes = () => Promise<bigint>;
type ProcessTreeUsage = Readonly<{
  rssBytes: bigint;
  pids: readonly number[];
  processGroupId: number;
}>;
type ProcessTableRow = Readonly<{
  ppid: number;
  pgid: number;
  rssKiB: bigint;
}>;
type InspectProcessTree = (rootPid: number) => Promise<ProcessTreeUsage>;

export type AppleObjectCaptureBackendOptions = Readonly<{
  scriptPath?: string;
  command?: string;
  commandPrefixArguments?: readonly string[];
  reconstructionTimeoutMs?: number;
  probeTimeoutMs?: number;
  terminateGraceMs?: number;
  maximumOutputBytes?: number;
  outputQuotaPollMs?: number;
  minimumFreeBytesAfterOutput?: number;
  availableOutputBytes?: AvailableOutputBytes;
  memoryPollMs?: number;
  minimumFreeMemoryBytes?: number;
  availableMemoryBytes?: AvailableMemoryBytes;
  inspectProcessTree?: InspectProcessTree;
  spawnProcess?: SpawnProcess;
}>;

type ProtocolRecord = Record<string, unknown> & {
  version: 1;
  type: string;
};

type ProcessResult = Readonly<{
  records: readonly ProtocolRecord[];
  stderr: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}>;

function checkedTimeout(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 24 * 60 * 60 * 1_000) {
    throw new TypeError("Object Capture timeout must be an integer between 1 ms and 24 hours");
  }
  return candidate;
}

function checkedGrace(value: number | undefined): number {
  const candidate = value ?? 1_000;
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 30_000) {
    throw new TypeError("Object Capture terminate grace must be an integer between 0 and 30000 ms");
  }
  return candidate;
}

function checkedMaximumOutputBytes(value: number | undefined): number {
  const candidate = value ?? PHOTO_RECONSTRUCTION_LIMITS.maximumObjectCaptureOutputBytes;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError("Object Capture maximum output bytes must be a positive safe integer");
  }
  return candidate;
}

function checkedQuotaPollMs(value: number | undefined): number {
  const candidate = value ?? DEFAULT_OUTPUT_QUOTA_POLL_MS;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 60_000) {
    throw new TypeError("Object Capture quota poll interval must be an integer between 1 and 60000 ms");
  }
  return candidate;
}

function checkedFreeSpaceReserve(value: number | undefined): number {
  const candidate = value ?? DEFAULT_OUTPUT_FREE_SPACE_RESERVE_BYTES;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new TypeError("Object Capture free-space reserve must be a non-negative safe integer");
  }
  return candidate;
}

function checkedMemoryPollMs(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MEMORY_POLL_MS;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 60_000) {
    throw new TypeError("Object Capture memory poll interval must be an integer between 1 and 60000 ms");
  }
  return candidate;
}

function checkedFreeMemoryReserve(value: number | undefined): number {
  const candidate = value ?? DEFAULT_FREE_MEMORY_RESERVE_BYTES;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new TypeError("Object Capture free-memory reserve must be a non-negative safe integer");
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function filesystemAvailableBytes(path: string): Promise<bigint> {
  let candidate = resolve(path);
  while (true) {
    try {
      const stats = await statfs(candidate, { bigint: true });
      return stats.bavail * stats.bsize;
    } catch (cause) {
      if (!isRecord(cause) || cause.code !== "ENOENT") throw cause;
      const parent = dirname(candidate);
      if (parent === candidate) throw cause;
      candidate = parent;
    }
  }
}

function parsedNonNegativeInteger(value: string, label: string): bigint {
  const candidate = value.trim().replace(/\.$/u, "");
  if (!/^\d+$/u.test(candidate)) throw new Error(`${label} was not a non-negative integer`);
  return BigInt(candidate);
}

async function macAvailableMemoryBytes(): Promise<bigint> {
  const result = await execFileAsync("/usr/bin/vm_stat", [], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  const stdout = String(result.stdout);
  const pageSizeMatch = stdout.match(/page size of (\d+) bytes/iu);
  if (!pageSizeMatch) throw new Error("vm_stat omitted its page size");
  const pageSize = parsedNonNegativeInteger(pageSizeMatch[1]!, "vm_stat page size");
  if (pageSize < 1n) throw new Error("vm_stat page size was zero");
  const pages = new Map<string, bigint>();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const match = rawLine.match(/^([^:]+):\s*([0-9]+)\.?\s*$/u);
    if (!match) continue;
    pages.set(match[1]!.trim().toLowerCase(), parsedNonNegativeInteger(match[2]!, match[1]!));
  }
  const free = pages.get("pages free");
  const inactive = pages.get("pages inactive");
  const speculative = pages.get("pages speculative");
  if (free === undefined || inactive === undefined || speculative === undefined) {
    throw new Error("vm_stat omitted required reclaimable-memory counters");
  }
  // Purgeable pages are deliberately omitted because they may already be
  // represented inside inactive memory. This estimate is conservative.
  return (free + inactive + speculative) * pageSize;
}

async function systemAvailableMemoryBytes(): Promise<bigint> {
  if (process.platform === "darwin") return macAvailableMemoryBytes();
  const available = freemem();
  if (!Number.isSafeInteger(available) || available < 0) {
    throw new Error("The operating system returned an invalid available-memory value");
  }
  return BigInt(available);
}

/** @internal Exported for deterministic resource-boundary regression tests. */
export function aggregateAppleObjectCaptureProcessRows(
  rootPid: number,
  rows: ReadonlyMap<number, ProcessTableRow>,
): ProcessTreeUsage {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) throw new Error("Object Capture root PID is invalid");
  if (rows.size > MAX_PROCESS_TABLE_ROWS) throw new Error("The process table exceeded its row limit");
  for (const [pid, row] of rows) {
    if (!Number.isSafeInteger(pid) || pid < 1
      || !Number.isSafeInteger(row.ppid) || row.ppid < 0
      || !Number.isSafeInteger(row.pgid) || row.pgid < 1
      || typeof row.rssKiB !== "bigint" || row.rssKiB < 0n) {
      throw new Error("The process table contains an invalid row");
    }
  }
  const root = rows.get(rootPid);
  if (!root) throw new Error("Object Capture root process was absent from the process table");
  const children = new Map<number, number[]>();
  for (const [pid, row] of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(pid);
    children.set(row.ppid, siblings);
  }
  // A helper can be reparented to launchd/PID 1 before the next poll while it
  // remains inside our owned detached process group. Seed traversal with every
  // group member, then follow PPID edges from each seed so descendants that
  // create their own group are still charged to the same reconstruction.
  const pending = [...rows]
    .filter(([, row]) => row.pgid === root.pgid)
    .map(([pid]) => pid);
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    const row = rows.get(pid);
    if (!row) continue;
    visited.add(pid);
    for (const childPid of children.get(pid) ?? []) pending.push(childPid);
  }
  const pids = [...visited].sort((left, right) => left - right);
  const rssBytes = pids.reduce((total, pid) => total + rows.get(pid)!.rssKiB * 1024n, 0n);
  return Object.freeze({ rssBytes, pids: Object.freeze(pids), processGroupId: root.pgid });
}

async function psProcessTreeUsage(rootPid: number): Promise<ProcessTreeUsage> {
  const result = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss="], {
    encoding: "utf8",
    maxBuffer: MAX_PROCESS_TABLE_BYTES,
    timeout: 10_000,
  });
  const rows = new Map<number, ProcessTableRow>();
  for (const rawLine of String(result.stdout).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/u);
    if (columns.length !== 4 || !columns.every((column) => /^\d+$/u.test(column))) {
      throw new Error("ps emitted an invalid process row");
    }
    if (rows.size >= MAX_PROCESS_TABLE_ROWS) throw new Error("The process table exceeded its row limit");
    const pid = Number(columns[0]);
    const ppid = Number(columns[1]);
    const pgid = Number(columns[2]);
    if (!Number.isSafeInteger(pid) || pid < 1
      || !Number.isSafeInteger(ppid) || ppid < 0
      || !Number.isSafeInteger(pgid) || pgid < 1) {
      throw new Error("ps emitted an invalid process identifier");
    }
    rows.set(pid, { ppid, pgid, rssKiB: parsedNonNegativeInteger(columns[3]!, "ps RSS") });
  }
  return aggregateAppleObjectCaptureProcessRows(rootPid, rows);
}

async function checkedAvailableMemory(
  availableMemoryBytes: AvailableMemoryBytes,
  errorMessage: string,
): Promise<bigint> {
  try {
    const available = await availableMemoryBytes();
    if (typeof available !== "bigint" || available < 0n) throw new Error("available memory was invalid");
    return available;
  } catch (cause) {
    throw new ReconstructionBackendError("resource_exhausted", errorMessage, { cause });
  }
}

async function ensureMemoryCapacity(
  maximumProcessRssBytes: number,
  minimumFreeMemoryBytes: number,
  availableMemoryBytes: AvailableMemoryBytes,
): Promise<void> {
  const available = await checkedAvailableMemory(
    availableMemoryBytes,
    "Object Capture could not verify available system memory",
  );
  const required = BigInt(maximumProcessRssBytes) + BigInt(minimumFreeMemoryBytes);
  if (available < required) {
    throw new ReconstructionBackendError(
      "resource_exhausted",
      "Object Capture does not have enough available memory for the selected reconstruction profile",
      { details: { maximumProcessRssBytes, minimumFreeMemoryBytes } },
    );
  }
}

async function ensureOutputCapacity(
  outputDirectory: string,
  maximumOutputBytes: number,
  minimumFreeBytesAfterOutput: number,
  availableOutputBytes: AvailableOutputBytes,
): Promise<void> {
  let available: bigint;
  try {
    available = await availableOutputBytes(outputDirectory);
  } catch (cause) {
    throw new ReconstructionBackendError(
      "resource_exhausted",
      "Object Capture could not verify bounded temporary storage capacity",
      { cause },
    );
  }
  const required = BigInt(maximumOutputBytes) + BigInt(minimumFreeBytesAfterOutput);
  if (available < required) {
    throw new ReconstructionBackendError(
      "resource_exhausted",
      "Object Capture does not have enough free temporary storage for its bounded output budget",
      { details: { maximumOutputBytes, minimumFreeBytesAfterOutput } },
    );
  }
}

async function ensureOutputFreeSpaceReserve(
  outputDirectory: string,
  minimumFreeBytesAfterOutput: number,
  availableOutputBytes: AvailableOutputBytes,
): Promise<void> {
  let available: bigint;
  try {
    available = await availableOutputBytes(outputDirectory);
  } catch (cause) {
    throw new ReconstructionBackendError(
      "resource_exhausted",
      "Object Capture could not verify bounded temporary storage capacity",
      { cause },
    );
  }
  if (available < BigInt(minimumFreeBytesAfterOutput)) {
    throw new ReconstructionBackendError(
      "resource_exhausted",
      "Object Capture could not preserve its configured temporary storage reserve",
      { details: { minimumFreeBytesAfterOutput } },
    );
  }
}

async function ensureFreeMemoryReserve(
  minimumFreeMemoryBytes: number,
  availableMemoryBytes: AvailableMemoryBytes,
): Promise<void> {
  const available = await checkedAvailableMemory(
    availableMemoryBytes,
    "Object Capture could not verify its free-memory reserve",
  );
  if (available < BigInt(minimumFreeMemoryBytes)) {
    throw new ReconstructionBackendError(
      "resource_exhausted",
      "Object Capture could not preserve its configured free-memory reserve",
      { details: { minimumFreeMemoryBytes } },
    );
  }
}

async function inspectBoundedProcessTree(
  rootPid: number,
  maximumProcessRssBytes: number,
  inspectProcessTree: InspectProcessTree,
): Promise<ProcessTreeUsage> {
  let usage: ProcessTreeUsage;
  try {
    usage = await inspectProcessTree(rootPid);
    if (typeof usage.rssBytes !== "bigint" || usage.rssBytes < 0n
      || !Array.isArray(usage.pids)
      || usage.pids.length < 1
      || usage.pids.length > MAX_PROCESS_TABLE_ROWS
      || !usage.pids.includes(rootPid)
      || usage.pids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
      || !Number.isSafeInteger(usage.processGroupId)
      || usage.processGroupId !== rootPid) {
      throw new Error("The process-tree inspector returned invalid usage data");
    }
  } catch (cause) {
    throw new ReconstructionBackendError(
      "resource_exhausted",
      "Object Capture could not verify its process-tree memory use",
      { cause },
    );
  }
  if (usage.rssBytes > BigInt(maximumProcessRssBytes)) {
    throw new ReconstructionBackendError(
      "resource_exhausted",
      "Object Capture exceeded its process-tree memory budget",
      { details: { maximumProcessRssBytes } },
    );
  }
  return usage;
}

function sendSignalToProcessTree(
  child: ChildProcess,
  knownTreePids: readonly number[],
  processGroupVerified: boolean,
  signal: NodeJS.Signals,
): void {
  const rootPid = child.pid;
  let groupSignalled = false;
  // Reconstruction children are placed in a dedicated POSIX process group.
  // Signalling the group first covers helpers created between RSS polls.
  if (processGroupVerified
    && process.platform !== "win32"
    && Number.isSafeInteger(rootPid)
    && rootPid! > 0) {
    try {
      process.kill(-rootPid!, signal);
      groupSignalled = true;
    } catch (cause) {
      if (!isRecord(cause) || cause.code !== "ESRCH") {
        // Individual PID signalling below is still attempted. Termination is
        // best-effort only after a successfully established dedicated group.
      }
    }
  }
  // A dedicated group receives SIGTERM exactly once. Repeating it immediately
  // for every known PID can re-enter graceful handlers and corrupt cleanup.
  // SIGKILL has no handler, so the escalation path also targets the last known
  // descendants in case a helper moved itself into another process group.
  if (groupSignalled && signal === "SIGTERM") return;
  for (const pid of [...knownTreePids].reverse()) {
    if (pid === rootPid) continue;
    try {
      process.kill(pid, signal);
    } catch (cause) {
      if (!isRecord(cause) || cause.code !== "ESRCH") {
        // Continue terminating the rest of the known process tree.
      }
    }
  }
  if (!groupSignalled) {
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the group and direct signals.
    }
  }
}

function parseProtocolLine(line: string): ProtocolRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new ReconstructionBackendError(
      "protocol_error",
      "Apple Object Capture emitted malformed JSONL",
      { cause },
    );
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.type !== "string") {
    throw new ReconstructionBackendError(
      "protocol_error",
      "Apple Object Capture emitted an invalid protocol record",
    );
  }
  return parsed as ProtocolRecord;
}

function protocolMessage(record: ProtocolRecord | undefined): string | undefined {
  return typeof record?.message === "string" && record.message.length > 0
    ? record.message.slice(0, 4_096)
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toProgressEvent(record: ProtocolRecord): ReconstructionProgressEvent | undefined {
  const allowed = new Set<ReconstructionProgressEvent["type"]>([
    "started",
    "progress",
    "progress_info",
    "invalid_sample",
    "skipped_sample",
    "warning",
    "complete",
  ]);
  if (!allowed.has(record.type as ReconstructionProgressEvent["type"])) return undefined;

  const progress = asFiniteNumber(record.progress);
  if (progress !== undefined && (progress < 0 || progress > 1)) {
    throw new ReconstructionBackendError("protocol_error", "Object Capture progress was outside [0, 1]");
  }
  const sampleId = asFiniteNumber(record.sampleId);
  if (sampleId !== undefined && (!Number.isSafeInteger(sampleId) || sampleId < 0)) {
    throw new ReconstructionBackendError("protocol_error", "Object Capture sample id was invalid");
  }
  const estimated = asFiniteNumber(record.estimatedRemainingSeconds);
  if (estimated !== undefined && estimated < 0) {
    throw new ReconstructionBackendError("protocol_error", "Object Capture remaining time was invalid");
  }
  return Object.freeze({
    version: 1,
    type: record.type as ReconstructionProgressEvent["type"],
    ...(progress === undefined ? {} : { progress }),
    ...(typeof record.stage === "string" ? { stage: record.stage.slice(0, 128) } : {}),
    ...(estimated === undefined ? {} : { estimatedRemainingSeconds: estimated }),
    ...(sampleId === undefined ? {} : { sampleId }),
    ...(typeof record.message === "string" ? { message: record.message.slice(0, 4_096) } : {}),
  });
}

function pathContains(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function ensureRegularFile(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    throw new ReconstructionBackendError("invalid_request", `${label} does not exist`, { cause });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ReconstructionBackendError("invalid_request", `${label} must be a regular file`);
  }
}

async function validateRequestPaths(request: ReconstructionRequest): Promise<{
  inputDirectory: string;
  outputDirectory: string;
}> {
  if (!isAbsolute(request.inputDirectory) || !isAbsolute(request.outputDirectory)) {
    throw new ReconstructionBackendError(
      "invalid_request",
      "Object Capture input and output directories must be absolute paths",
    );
  }
  if (!RECONSTRUCTION_DETAILS.includes(request.detail)) {
    throw new ReconstructionBackendError("invalid_request", "Object Capture detail is invalid");
  }

  let inputDirectory: string;
  try {
    const info = await lstat(request.inputDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("not a regular directory");
    }
    inputDirectory = await realpath(request.inputDirectory);
  } catch (cause) {
    throw new ReconstructionBackendError(
      "invalid_request",
      "Object Capture input must be an existing non-symlink directory",
      { cause },
    );
  }
  const outputDirectory = resolve(request.outputDirectory);
  try {
    const outputInfo = await lstat(outputDirectory);
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
      throw new ReconstructionBackendError(
        "invalid_request",
        "Object Capture output must be a non-symlink directory when it already exists",
      );
    }
  } catch (cause) {
    if (cause instanceof ReconstructionBackendError) throw cause;
    if (!isRecord(cause) || cause.code !== "ENOENT") {
      throw new ReconstructionBackendError(
        "invalid_request",
        "Object Capture output path is not accessible",
        { cause },
      );
    }
  }
  if (pathContains(inputDirectory, outputDirectory) || pathContains(outputDirectory, inputDirectory)) {
    throw new ReconstructionBackendError(
      "invalid_request",
      "Object Capture input and output directories must not overlap",
    );
  }
  return { inputDirectory, outputDirectory };
}

async function listArtifacts(
  root: string,
  maximumOutputBytes: number,
  allowMissingRoot = false,
): Promise<string[]> {
  const artifacts: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;
  let totalBytes = 0;

  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new ReconstructionBackendError(
        "output_missing",
        "Object Capture output must remain a non-symlink directory",
      );
    }
  } catch (cause) {
    if (allowMissingRoot && isRecord(cause) && cause.code === "ENOENT") return artifacts;
    if (cause instanceof ReconstructionBackendError) throw cause;
    throw new ReconstructionBackendError("output_missing", "Object Capture output directory is unreadable", {
      cause,
    });
  }

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_DIRECTORY_DEPTH) {
      throw new ReconstructionBackendError("output_missing", "Object Capture output is nested too deeply");
    }
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (cause) {
      if (allowMissingRoot && isRecord(cause) && cause.code === "ENOENT") continue;
      throw new ReconstructionBackendError("output_missing", "Object Capture output directory is unreadable", {
        cause,
      });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ARTIFACTS) {
        throw new ReconstructionBackendError("output_missing", "Object Capture produced too many artifacts");
      }
      const path = resolve(current.path, entry.name);
      let info;
      try {
        info = await lstat(path);
      } catch (cause) {
        // Object Capture may atomically replace intermediate artifacts while a
        // scan is in progress. A vanished entry contributes no retained bytes.
        if (isRecord(cause) && cause.code === "ENOENT") continue;
        throw new ReconstructionBackendError("output_missing", "Object Capture output is unreadable", {
          cause,
        });
      }
      if (info.isSymbolicLink()) {
        throw new ReconstructionBackendError("output_missing", "Object Capture output contains a symbolic link");
      }
      if (info.isDirectory()) {
        pending.push({ path, depth: current.depth + 1 });
      } else if (info.isFile()) {
        if (!Number.isSafeInteger(info.size) || info.size < 0) {
          throw new ReconstructionBackendError("output_missing", "Object Capture output has an invalid file size");
        }
        totalBytes += info.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumOutputBytes) {
          throw new ReconstructionBackendError(
            "resource_exhausted",
            "Object Capture exceeded its bounded intermediate output budget",
            { details: { maximumOutputBytes } },
          );
        }
        artifacts.push(path);
      } else {
        throw new ReconstructionBackendError("output_missing", "Object Capture output contains a special file");
      }
    }
  }
  return artifacts.sort((left, right) => left.localeCompare(right, "en"));
}

export class AppleObjectCaptureBackend implements ReconstructionBackend {
  readonly id = "apple-object-capture";
  readonly #scriptPath: string;
  readonly #command: string;
  readonly #commandPrefixArguments: readonly string[];
  readonly #reconstructionTimeoutMs: number;
  readonly #probeTimeoutMs: number;
  readonly #terminateGraceMs: number;
  readonly #maximumOutputBytes: number;
  readonly #outputQuotaPollMs: number;
  readonly #minimumFreeBytesAfterOutput: number;
  readonly #availableOutputBytes: AvailableOutputBytes;
  readonly #memoryPollMs: number;
  readonly #minimumFreeMemoryBytes: number;
  readonly #availableMemoryBytes: AvailableMemoryBytes;
  readonly #inspectProcessTree: InspectProcessTree;
  readonly #spawnProcess: SpawnProcess;
  readonly #nativeSpawnOwnsDetachedProcessGroup: boolean;

  constructor(options: AppleObjectCaptureBackendOptions = {}) {
    this.#scriptPath = resolve(options.scriptPath ?? DEFAULT_SCRIPT_PATH);
    this.#command = options.command ?? "/usr/bin/xcrun";
    this.#commandPrefixArguments = options.commandPrefixArguments ?? ["swift"];
    this.#reconstructionTimeoutMs = checkedTimeout(
      options.reconstructionTimeoutMs,
      DEFAULT_RECONSTRUCTION_TIMEOUT_MS,
    );
    this.#probeTimeoutMs = checkedTimeout(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
    this.#terminateGraceMs = checkedGrace(options.terminateGraceMs);
    this.#maximumOutputBytes = checkedMaximumOutputBytes(options.maximumOutputBytes);
    this.#outputQuotaPollMs = checkedQuotaPollMs(options.outputQuotaPollMs);
    this.#minimumFreeBytesAfterOutput = checkedFreeSpaceReserve(options.minimumFreeBytesAfterOutput);
    this.#availableOutputBytes = options.availableOutputBytes ?? filesystemAvailableBytes;
    this.#memoryPollMs = checkedMemoryPollMs(options.memoryPollMs);
    this.#minimumFreeMemoryBytes = checkedFreeMemoryReserve(options.minimumFreeMemoryBytes);
    this.#availableMemoryBytes = options.availableMemoryBytes ?? systemAvailableMemoryBytes;
    this.#inspectProcessTree = options.inspectProcessTree ?? psProcessTreeUsage;
    this.#spawnProcess = options.spawnProcess ?? spawn;
    // node:child_process.spawn with detached:true performs setsid(2) on POSIX:
    // the returned PID is therefore the session/process-group leader before
    // user code can run. Do not extend this synchronous ownership guarantee to
    // an injected spawn adapter; those must pass the independent ps check.
    this.#nativeSpawnOwnsDetachedProcessGroup = options.spawnProcess === undefined;
  }

  async probe(signal?: AbortSignal): Promise<ReconstructionBackendProbe> {
    try {
      await ensureRegularFile(this.#scriptPath, "Object Capture Swift script");
      const result = await this.#run(
        ["--probe"],
        this.#probeTimeoutMs,
        signal,
        undefined,
        undefined,
        this.#maximumOutputBytes,
        DEFAULT_PROBE_PROCESS_RSS_BYTES,
      );
      const record = result.records.find((candidate) => candidate.type === "probe");
      if (!record || typeof record.supported !== "boolean") {
        throw new ReconstructionBackendError(
          "protocol_error",
          "Object Capture probe did not return a support result",
        );
      }
      return Object.freeze({
        version: 1,
        backendId: this.id,
        supported: record.supported,
        ...(typeof record.reason === "string" ? { reason: record.reason.slice(0, 4_096) } : {}),
      });
    } catch (error) {
      if (error instanceof ReconstructionBackendError && error.code === "aborted") throw error;
      return Object.freeze({
        version: 1,
        backendId: this.id,
        supported: false,
        reason: error instanceof Error ? error.message : "Object Capture probe failed",
      });
    }
  }

  async reconstruct(request: ReconstructionRequest): Promise<ReconstructionResult> {
    if (request.signal?.aborted) {
      throw new ReconstructionBackendError("aborted", "Object Capture was aborted", {
        cause: request.signal.reason,
      });
    }
    await ensureRegularFile(this.#scriptPath, "Object Capture Swift script");
    const paths = await validateRequestPaths(request);
    const effectiveOutputBytes = Math.min(
      this.#maximumOutputBytes,
      DEFAULT_OUTPUT_BYTES_BY_DETAIL[request.detail],
    );
    if (!Number.isSafeInteger(request.aggregatePixelCount) || request.aggregatePixelCount < 1) {
      throw new ReconstructionBackendError(
        "invalid_request",
        "Object Capture aggregate pixel count must be a positive safe integer",
      );
    }
    const maximumAggregatePixelCount = DEFAULT_MAXIMUM_PIXELS_BY_DETAIL[request.detail];
    if (request.aggregatePixelCount > maximumAggregatePixelCount) {
      throw new ReconstructionBackendError(
        "resource_exhausted",
        "Object Capture photo set exceeds the selected profile's decoded pixel budget",
        { details: { aggregatePixelCount: request.aggregatePixelCount, maximumAggregatePixelCount } },
      );
    }
    const maximumProcessRssBytes = DEFAULT_MAXIMUM_PROCESS_RSS_BYTES_BY_DETAIL[request.detail];
    await ensureMemoryCapacity(
      maximumProcessRssBytes,
      this.#minimumFreeMemoryBytes,
      this.#availableMemoryBytes,
    );
    await ensureOutputCapacity(
      paths.outputDirectory,
      effectiveOutputBytes,
      this.#minimumFreeBytesAfterOutput,
      this.#availableOutputBytes,
    );
    await listArtifacts(paths.outputDirectory, effectiveOutputBytes, true);
    const recordsSeen: ProtocolRecord[] = [];
    await this.#run(
      [
        "--input",
        paths.inputDirectory,
        "--output",
        paths.outputDirectory,
        "--detail",
        request.detail,
      ],
      this.#reconstructionTimeoutMs,
      request.signal,
      (record) => {
        recordsSeen.push(record);
        const event = toProgressEvent(record);
        if (event) request.onProgress?.(event);
      },
      paths.outputDirectory,
      effectiveOutputBytes,
      maximumProcessRssBytes,
    );
    const artifacts = await listArtifacts(paths.outputDirectory, effectiveOutputBytes);
    if (!recordsSeen.some((record) => record.type === "complete")) {
      throw new ReconstructionBackendError(
        "protocol_error",
        "Object Capture exited without a completion event",
      );
    }

    const objPath = artifacts.find((path) => path.toLowerCase().endsWith(".obj"));
    if (!objPath) {
      throw new ReconstructionBackendError(
        "output_missing",
        "Object Capture completed without producing an OBJ model",
      );
    }
    return Object.freeze({
      backendId: this.id,
      outputDirectory: paths.outputDirectory,
      objPath,
      artifacts: Object.freeze(artifacts),
    });
  }

  #run(
    arguments_: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    onRecord?: (record: ProtocolRecord) => void,
    outputDirectory?: string,
    outputQuotaBytes = this.#maximumOutputBytes,
    maximumProcessRssBytes?: number,
  ): Promise<ProcessResult> {
    if (signal?.aborted) {
      return Promise.reject(new ReconstructionBackendError("aborted", "Object Capture was aborted", {
        cause: signal.reason,
      }));
    }

    return new Promise((resolvePromise, rejectPromise) => {
      let child: ChildProcess;
      try {
        child = this.#spawnProcess(
          this.#command,
          [...this.#commandPrefixArguments, this.#scriptPath, ...arguments_],
          {
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
          },
        );
      } catch (cause) {
        rejectPromise(new ReconstructionBackendError(
          "process_failed",
          "Failed to launch Apple Object Capture",
          { cause },
        ));
        return;
      }
      const records: ProtocolRecord[] = [];
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let forcedError: ReconstructionBackendError | undefined;
      let escalationTimer: NodeJS.Timeout | undefined;
      let quotaTimer: NodeJS.Timeout | undefined;
      let memoryTimer: NodeJS.Timeout | undefined;
      let knownTreePids: readonly number[] = child.pid === undefined ? [] : [child.pid];
      let processGroupVerified = this.#nativeSpawnOwnsDetachedProcessGroup
        && process.platform !== "win32"
        && Number.isSafeInteger(child.pid)
        && child.pid! > 0;
      let terminationSignalled = false;

      if (maximumProcessRssBytes !== undefined
        && (!Number.isSafeInteger(child.pid) || child.pid! < 1 || process.platform === "win32")) {
        // Apple reconstruction is supported only on macOS. A missing POSIX
        // process-group identity means helper-tree termination cannot be
        // guaranteed, so reconstruction fails closed before doing work.
        forcedError = new ReconstructionBackendError(
          "resource_exhausted",
          "Object Capture could not establish supervised process-group isolation",
        );
        try {
          child.kill("SIGKILL");
        } catch {
          // The async spawn error/close path below remains authoritative.
        }
      }

      const signalTermination = (): void => {
        if (!forcedError || settled || terminationSignalled || !processGroupVerified) return;
        terminationSignalled = true;
        sendSignalToProcessTree(child, knownTreePids, processGroupVerified, "SIGTERM");
        escalationTimer = setTimeout(() => {
          sendSignalToProcessTree(child, knownTreePids, processGroupVerified, "SIGKILL");
        }, this.#terminateGraceMs);
        escalationTimer.unref();
      };

      const terminate = (error: ReconstructionBackendError): void => {
        if (forcedError || settled) return;
        forcedError = error;
        // Default POSIX spawn has a synchronous setsid ownership guarantee, so
        // early abort can safely target -pid immediately. Injected spawners are
        // held until the first independent PGID/RSS inspection verifies that
        // the child actually owns a dedicated group.
        signalTermination();
      };

      const scheduleQuotaScan = (): void => {
        if (!outputDirectory || settled || forcedError) return;
        quotaTimer = setTimeout(() => {
          void listArtifacts(outputDirectory, outputQuotaBytes, true)
            .then(() => ensureOutputFreeSpaceReserve(
              outputDirectory,
              this.#minimumFreeBytesAfterOutput,
              this.#availableOutputBytes,
            ))
            .then(() => scheduleQuotaScan())
            .catch((cause: unknown) => {
              terminate(cause instanceof ReconstructionBackendError
                ? cause
                : new ReconstructionBackendError(
                    "output_missing",
                    "Object Capture output quota scan failed",
                    { cause },
                  ));
            });
        }, this.#outputQuotaPollMs);
        quotaTimer.unref();
      };
      scheduleQuotaScan();

      const scheduleMemoryScan = (delayMs: number): void => {
        if (maximumProcessRssBytes === undefined || settled || forcedError) return;
        const rootPid = child.pid;
        if (!Number.isSafeInteger(rootPid) || rootPid! < 1) {
          terminate(new ReconstructionBackendError(
            "resource_exhausted",
            "Object Capture could not establish supervised process-group isolation",
          ));
          return;
        }
        memoryTimer = setTimeout(() => {
          void inspectBoundedProcessTree(rootPid!, maximumProcessRssBytes, this.#inspectProcessTree)
            .then((usage) => {
              knownTreePids = usage.pids;
              processGroupVerified = true;
              signalTermination();
              return ensureFreeMemoryReserve(this.#minimumFreeMemoryBytes, this.#availableMemoryBytes);
            })
            .then(() => scheduleMemoryScan(this.#memoryPollMs))
            .catch((cause: unknown) => {
              if (settled || child.exitCode !== null || child.signalCode !== null) return;
              terminate(cause instanceof ReconstructionBackendError
                ? cause
                : new ReconstructionBackendError(
                    "resource_exhausted",
                    "Object Capture memory supervision failed",
                    { cause },
                  ));
            });
        }, delayMs);
        memoryTimer.unref();
      };
      scheduleMemoryScan(0);

      const handleLine = (rawLine: string): void => {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) return;
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          terminate(new ReconstructionBackendError("protocol_error", "Object Capture JSONL line was too large"));
          return;
        }
        try {
          const record = parseProtocolLine(line);
          records.push(record);
          if (record.type === "error") {
            // The exit status remains authoritative, but preserving the record
            // provides a safe, structured error message below.
            return;
          }
          onRecord?.(record);
        } catch (cause) {
          terminate(cause instanceof ReconstructionBackendError
            ? cause
            : new ReconstructionBackendError("protocol_error", "Object Capture progress handler failed", { cause }));
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > MAX_CAPTURE_BYTES) {
          terminate(new ReconstructionBackendError("protocol_error", "Object Capture emitted too much stdout"));
          return;
        }
        stdout += chunk;
        let newline = stdout.indexOf("\n");
        while (newline >= 0) {
          handleLine(stdout.slice(0, newline));
          stdout = stdout.slice(newline + 1);
          newline = stdout.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        const remaining = MAX_CAPTURE_BYTES - stderrBytes;
        if (remaining <= 0) return;
        const buffer = Buffer.from(chunk, "utf8");
        stderr += buffer.subarray(0, remaining).toString("utf8");
        stderrBytes += Math.min(buffer.byteLength, remaining);
      });

      const timeout = setTimeout(() => {
        terminate(new ReconstructionBackendError(
          "timeout",
          `Object Capture exceeded its ${timeoutMs} ms timeout`,
        ));
      }, timeoutMs);
      timeout.unref();

      const onAbort = (): void => {
        terminate(new ReconstructionBackendError("aborted", "Object Capture was aborted", {
          cause: signal?.reason,
        }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (escalationTimer) clearTimeout(escalationTimer);
        if (quotaTimer) clearTimeout(quotaTimer);
        if (memoryTimer) clearTimeout(memoryTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: ReconstructionBackendError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      };

      child.once("error", (cause) => {
        rejectOnce(new ReconstructionBackendError(
          "process_failed",
          "Failed to launch Apple Object Capture",
          { cause },
        ));
      });
      child.once("close", (exitCode, exitSignal) => {
        if (settled) return;
        if (stdout.length > 0) handleLine(stdout);
        cleanup();
        if (forcedError) {
          // If the group leader exited on SIGTERM while a helper ignored it,
          // close would otherwise cancel escalation and leave that helper
          // behind. Kill the dedicated group and the last observed tree before
          // returning the resource failure.
          sendSignalToProcessTree(child, knownTreePids, processGroupVerified, "SIGKILL");
          rejectOnce(forcedError);
          return;
        }
        if (maximumProcessRssBytes !== undefined && !processGroupVerified) {
          rejectOnce(new ReconstructionBackendError(
            "resource_exhausted",
            "Object Capture exited before supervised process-group ownership could be established",
          ));
          return;
        }
        // The group leader may report success while a compiler/native helper is
        // still alive. Reap the owned detached group before accepting the
        // result, including when the first asynchronous RSS snapshot has not
        // yet settled. A group with no remaining members yields ESRCH.
        if (processGroupVerified) {
          sendSignalToProcessTree(child, knownTreePids, true, "SIGKILL");
        }
        const errorRecord = [...records].reverse().find((record) => record.type === "error");
        if (exitCode !== 0) {
          rejectOnce(new ReconstructionBackendError(
            exitCode === 3 ? "unsupported" : "process_failed",
            protocolMessage(errorRecord) ?? `Apple Object Capture exited with code ${String(exitCode)}`,
            { details: { exitCode, exitSignal } },
          ));
          return;
        }
        if (errorRecord) {
          rejectOnce(new ReconstructionBackendError(
            "process_failed",
            protocolMessage(errorRecord) ?? "Apple Object Capture reported an error",
            { details: { exitCode, exitSignal } },
          ));
          return;
        }
        settled = true;
        resolvePromise(Object.freeze({
          records: Object.freeze(records),
          stderr,
          exitCode,
          exitSignal,
        }));
      });
    });
  }
}

export const appleObjectCaptureScriptPath = DEFAULT_SCRIPT_PATH;
