import { loadEnvFile } from "node:process";

const ROOT_ENV_FILE = new URL("../../.env", import.meta.url);
const PROTECTED_CHILD_PROCESS_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "npm_execpath",
  "npm_node_execpath",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
]);
const PROTECTED_CHILD_PROCESS_KEY_SET = new Set(
  PROTECTED_CHILD_PROCESS_KEYS.map((key) => key.toUpperCase()),
);

function isProtectedChildProcessKey(key) {
  return PROTECTED_CHILD_PROCESS_KEY_SET.has(key.toUpperCase());
}

function protectedEnvironmentEntries() {
  return Object.entries(process.env)
    .filter(([key]) => isProtectedChildProcessKey(key));
}

function restoreProtectedEnvironment(entries) {
  // Windows environment keys are case-insensitive, while POSIX permits a file
  // to introduce a differently-cased twin such as `Path`. Remove every casing
  // loaded from the file before restoring the shell's exact original entries.
  for (const key of Object.keys(process.env)) {
    if (isProtectedChildProcessKey(key)) delete process.env[key];
  }
  for (const [key, value] of entries) process.env[key] = value;
}

function errorCode(value) {
  return value !== null && typeof value === "object" && "code" in value
    ? value.code
    : undefined;
}

/**
 * Loads the repository-root .env with Node's parser. Existing shell values win.
 * Variables that could alter a subsequently spawned Node/native process are
 * accepted only from the shell, never introduced by the project file.
 */
export function loadRootEnvironment({ file = ROOT_ENV_FILE } = {}) {
  const protectedValues = protectedEnvironmentEntries();
  try {
    loadEnvFile(file);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return Object.freeze({ found: false });
    throw cause;
  } finally {
    restoreProtectedEnvironment(protectedValues);
  }
  return Object.freeze({ found: true });
}
