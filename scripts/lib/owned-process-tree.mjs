import { spawn } from "node:child_process";

const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_FORCE_GRACE_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function validPid(value, platform = process.platform) {
  // POSIX assigns special broadcast semantics to negative PID 1, so a group
  // leader of 1 must never reach process.kill(-pid, ...). Keep the capability
  // within the host's ordinary PID range.
  const maximum = platform === "win32" ? 0xffffffff : 0x7fffffff;
  return Number.isSafeInteger(value) && value > 1 && value <= maximum;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(pid, killProcess) {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (cause) {
    if (cause && typeof cause === "object" && cause.code === "ESRCH") return false;
    throw cause;
  }
}

function signalProcessGroup(pid, signal, killProcess) {
  try {
    killProcess(-pid, signal);
    return true;
  } catch (cause) {
    if (cause && typeof cause === "object" && cause.code === "ESRCH") return false;
    throw cause;
  }
}

async function waitUntil(predicate, timeoutMs, pollIntervalMs, wait, now) {
  const deadline = now() + timeoutMs;
  while (!predicate()) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await wait(Math.min(pollIntervalMs, remaining));
  }
  return true;
}

/**
 * Invoke Windows' own process-tree terminator without a command shell. The
 * returned process is itself bounded so a broken host utility cannot stall
 * shutdown forever.
 */
function runWindowsTaskkill(pid, {
  force = false,
  timeoutMs = DEFAULT_TERM_GRACE_MS,
  spawnProcess = spawn,
} = {}) {
  if (!validPid(pid, "win32")) throw new TypeError("Owned process PID is outside the Windows PID range.");
  positiveSafeInteger(timeoutMs, "taskkill timeout");
  const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
  return new Promise((resolve, reject) => {
    const taskkill = spawnProcess("taskkill.exe", args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (outcome, cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cause) reject(cause);
      else resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { taskkill.kill("SIGKILL"); } catch { /* already gone */ }
      finish(Object.freeze({ code: null, timedOut: true }));
    }, timeoutMs);
    taskkill.once("error", (cause) => finish(undefined, cause));
    taskkill.once("exit", (code) => finish(Object.freeze({ code, timedOut: false })));
  });
}

async function terminatePosixTree(tree, options) {
  const { pid, closed } = tree;
  // Once every inherited handle is closed, the owned tree is fully drained.
  // Do not even probe its former PGID: the kernel may already have reused the
  // numeric identifier for an unrelated process group.
  if (closed()) return;
  let groupObservedGone = false;
  const gone = () => {
    if (!groupObservedGone && !processGroupExists(pid, options.killProcess)) {
      // A vanished PGID can later be reused by an unrelated process. Once it
      // is observed absent, never signal that numeric ID again.
      groupObservedGone = true;
    }
    return groupObservedGone && closed();
  };
  if (gone()) return;
  if (groupObservedGone) {
    throw new Error("Owned process group exited but inherited pipes did not close.");
  }

  if (!signalProcessGroup(pid, "SIGTERM", options.killProcess)) groupObservedGone = true;
  if (await waitUntil(
    gone,
    options.termGraceMs,
    options.pollIntervalMs,
    options.wait,
    options.now,
  )) return;
  if (groupObservedGone) {
    throw new Error("Owned process group exited after SIGTERM but inherited pipes did not close.");
  }

  if (!signalProcessGroup(pid, "SIGKILL", options.killProcess)) groupObservedGone = true;
  if (await waitUntil(
    gone,
    options.forceGraceMs,
    options.pollIntervalMs,
    options.wait,
    options.now,
  )) return;
  throw new Error("Owned process tree did not close after SIGTERM and SIGKILL.");
}

async function terminateWindowsTree(tree, options) {
  if (tree.closed()) return;
  if (tree.exited()) {
    if (await waitUntil(
      tree.closed,
      options.termGraceMs,
      options.pollIntervalMs,
      options.wait,
      options.now,
    )) return;
    throw new Error("Owned Windows root exited but inherited pipes did not close.");
  }
  const graceful = await options.taskkill(tree.pid, {
    force: false,
    timeoutMs: options.termGraceMs,
  });
  if (graceful.code === 0
    && await waitUntil(
      tree.closed,
      options.termGraceMs,
      options.pollIntervalMs,
      options.wait,
      options.now,
    )) {
    return;
  }
  if (tree.closed()) return;
  if (tree.exited()) {
    if (await waitUntil(
      tree.closed,
      options.forceGraceMs,
      options.pollIntervalMs,
      options.wait,
      options.now,
    )) return;
    throw new Error("Owned Windows root exited after taskkill but inherited pipes did not close.");
  }

  await options.taskkill(tree.pid, {
    force: true,
    timeoutMs: options.forceGraceMs,
  });
  if (await waitUntil(
    tree.closed,
    options.forceGraceMs,
    options.pollIntervalMs,
    options.wait,
    options.now,
  )) return;
  throw new Error("Owned Windows process tree did not close after taskkill escalation.");
}

/**
 * Spawn a process whose PID and process-group ownership are established here,
 * rather than accepting an arbitrary PID from a caller. POSIX children become
 * group leaders, so descendants can be terminated without touching the host's
 * or caller's process group. Windows termination is scoped to this PID's tree.
 */
export function spawnOwnedProcessTree(command, args, spawnOptions = {}, {
  platform = process.platform,
  spawnProcess = spawn,
  killProcess = process.kill.bind(process),
  taskkillSpawnProcess = spawn,
  taskkill = (pid, options) => runWindowsTaskkill(pid, {
    ...options,
    spawnProcess: taskkillSpawnProcess,
  }),
  wait = sleep,
  now = Date.now,
  termGraceMs = DEFAULT_TERM_GRACE_MS,
  forceGraceMs = DEFAULT_FORCE_GRACE_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    throw new TypeError("Owned process command must be a non-empty string without NUL bytes.");
  }
  if (!Array.isArray(args)
    || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("Owned process arguments must be strings without NUL bytes.");
  }
  positiveSafeInteger(termGraceMs, "TERM grace period");
  positiveSafeInteger(forceGraceMs, "force-kill grace period");
  positiveSafeInteger(pollIntervalMs, "process-tree poll interval");

  const child = spawnProcess(command, [...args], {
    ...spawnOptions,
    detached: platform !== "win32",
  });
  if (!validPid(child?.pid, platform) || typeof child.once !== "function") {
    throw new Error("Owned process did not provide a valid child PID.");
  }

  let childExited = typeof child.exitCode === "number"
    || (typeof child.signalCode === "string" && child.signalCode.length > 0);
  let childClosed = false;
  const exited = () => childExited
    || typeof child.exitCode === "number"
    || (typeof child.signalCode === "string" && child.signalCode.length > 0);
  child.once("exit", () => { childExited = true; });
  child.once("close", () => {
    childExited = true;
    childClosed = true;
  });
  const tree = Object.freeze({
    child,
    pid: child.pid,
    closed: () => childClosed,
    exited,
  });
  let stopPromise;
  return Object.freeze({
    child,
    pid: child.pid,
    get closed() { return childClosed; },
    get exited() { return exited(); },
    get stopping() { return stopPromise !== undefined; },
    stop() {
      if (!stopPromise) {
        const options = {
          forceGraceMs,
          killProcess,
          now,
          pollIntervalMs,
          taskkill,
          termGraceMs,
          wait,
        };
        stopPromise = platform === "win32"
          ? terminateWindowsTree(tree, options)
          : terminatePosixTree(tree, options);
      }
      return stopPromise;
    },
  });
}

export async function stopOwnedProcessTrees(trees) {
  if (!Array.isArray(trees) || trees.some((tree) => typeof tree?.stop !== "function")) {
    throw new TypeError("Owned process trees must provide stop().");
  }
  const results = await Promise.allSettled(trees.map((tree) => tree.stop()));
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Multiple owned process trees failed to stop.");
  }
}

/** Coordinates all exit paths so concurrent child failures initiate one drain. */
export function createOwnedProcessSupervisor(trees, {
  stopTrees = stopOwnedProcessTrees,
  exitProcess = (code) => process.exit(code),
  reportFailure = () => undefined,
} = {}) {
  let stopPromise;
  return Object.freeze({
    get stopping() { return stopPromise !== undefined; },
    stop(exitCode = 0) {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        let finalCode = exitCode;
        try {
          await stopTrees(trees);
        } catch (cause) {
          finalCode = 1;
          reportFailure(cause);
        }
        exitProcess(finalCode);
      })();
      return stopPromise;
    },
  });
}
