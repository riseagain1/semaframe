import { readFile } from "node:fs/promises";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { spawnOwnedProcessTree } from "./owned-process-tree.mjs";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 8_192;
const MAX_DIAGNOSTIC_CHARS = 2_000;
const DEVTOOLS_STDERR_PATTERN = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d{1,5})\/devtools\/browser\/[^\s]+/u;

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function portFromStderr(stderr) {
  return validPort(DEVTOOLS_STDERR_PATTERN.exec(stderr)?.[1]);
}

async function portFromActivePortFile(profile) {
  try {
    const [portLine, browserPath] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/u);
    if (!browserPath?.startsWith("/devtools/browser/")) return undefined;
    return validPort(portLine);
  } catch {
    return undefined;
  }
}

async function devToolsEndpointIsReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      cache: "no-store",
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function sanitizeChromeSmokeDiagnostic(value) {
  return String(value ?? "")
    .replace(/(?:https?|wss?|file):\/\/[^\s)\]}]+/giu, "[url]")
    .replace(/((?:approval|session|transaction|access|refresh|auth|pairing)?[_-]?(?:token|secret|credential|authorization|bearer)\s*[:=]\s*)[^\s,;}\]]+/giu, "$1[redacted]")
    .replace(/\bBearer\s+[^\s,;}\]]+/giu, "Bearer [redacted]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:()[\]{}]+[\\/])+[^\s:()[\]{}]*/gu, "[path]")
    .replace(/[A-Za-z0-9._~-]{40,}/gu, "[redacted]")
    .replace(/[\t ]+/gu, " ")
    .trim()
    .slice(-MAX_DIAGNOSTIC_CHARS);
}

function startupFailure(message, diagnostics) {
  const safeDiagnostics = sanitizeChromeSmokeDiagnostic(diagnostics);
  return new Error(`${message}${safeDiagnostics ? ` Chrome diagnostics: ${safeDiagnostics}` : " Chrome produced no safe diagnostics."}`);
}

function stderrTail(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, MAX_STDERR_CHARS));
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function launchChromeForSmoke({
  executable,
  profile,
  extraArgs = [],
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
}) {
  // Chrome can give detached helpers inherited stderr handles. A pipe would
  // keep ChildProcess's "close" pending after Browser.close and after its PGID
  // disappears. Keep diagnostics in this disposable, private profile instead;
  // never weaken the owned-tree guard or signal a vanished/reused PGID.
  const stderrPath = join(profile, ".semaframe-smoke-stderr.log");
  const stderrDescriptor = openSync(stderrPath, "wx+", 0o600);
  let browserTree;
  try {
    browserTree = spawnOwnedProcessTree(
      executable,
      [
        ...extraArgs,
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", stderrDescriptor] },
      { termGraceMs: 5_000, forceGraceMs: 5_000 },
    );
  } finally {
    closeSync(stderrDescriptor);
  }
  const { child: browser } = browserTree;

  const diagnosticText = () => sanitizeChromeSmokeDiagnostic(stderrTail(stderrPath));

  let exitState;
  let spawnFailed = false;
  const recordExit = (code, signal) => {
    exitState = { code, signal };
  };
  const recordSpawnError = () => {
    spawnFailed = true;
  };
  browser.once("exit", recordExit);
  browser.once("error", recordSpawnError);

  const started = Date.now();
  try {
    while (Date.now() - started < timeoutMs) {
      const stderr = stderrTail(stderrPath);
      if (spawnFailed) {
        throw startupFailure("Chrome could not be started.", stderr);
      }
      if (exitState) {
        const reason = exitState.signal ? `signal ${exitState.signal}` : `code ${exitState.code ?? "unknown"}`;
        throw startupFailure(`Chrome exited before DevTools became ready (${reason}).`, stderr);
      }
      const port = portFromStderr(stderr) ?? await portFromActivePortFile(profile);
      if (port && await devToolsEndpointIsReady(port)) {
        browser.off("exit", recordExit);
        browser.off("error", recordSpawnError);
        return {
          browser,
          browserTree,
          cdpPort: port,
          diagnosticText,
        };
      }
      await delay(50);
    }
    throw startupFailure("Chrome did not expose DevTools within the startup deadline.", stderrTail(stderrPath));
  } catch (error) {
    browser.off("exit", recordExit);
    browser.off("error", recordSpawnError);
    try {
      await browserTree.stop();
    } catch { /* preserve the bounded, sanitized startup failure */ }
    throw error;
  }
}
