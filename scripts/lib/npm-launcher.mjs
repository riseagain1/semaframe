import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, win32 } from "node:path";

function checkedArguments(value) {
  if (!Array.isArray(value)
    || value.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("npm arguments must be strings without NUL bytes.");
  }
  return [...value];
}

function absoluteForPlatform(value, platform) {
  return platform === "win32" ? win32.isAbsolute(value) : isAbsolute(value);
}

/**
 * Resolves npm without asking a shell to parse arguments. npm-run scripts expose
 * npm_execpath, so Windows can execute that JavaScript entrypoint with the
 * current Node binary instead of relying on the non-executable npm.cmd shim.
 */
export function resolveNpmLaunch(
  npmArguments,
  {
    platform = process.platform,
    nodeExecutable = process.execPath,
    npmExecPath = process.env.npm_execpath,
    fileExists = existsSync,
  } = {},
) {
  const args = checkedArguments(npmArguments);
  const configuredCli = npmExecPath?.trim();
  if (configuredCli
    && absoluteForPlatform(configuredCli, platform)
    && fileExists(configuredCli)) {
    return Object.freeze({
      command: nodeExecutable,
      args: Object.freeze([configuredCli, ...args]),
      source: "npm_execpath",
    });
  }

  if (platform === "win32") {
    const bundledCli = win32.join(
      win32.dirname(nodeExecutable),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (fileExists(bundledCli)) {
      return Object.freeze({
        command: nodeExecutable,
        args: Object.freeze([bundledCli, ...args]),
        source: "bundled_npm_cli",
      });
    }
    throw new Error(
      "npm could not be located safely on Windows. Start SemaFrame with `npm run dev` or `npm run dev:xr`.",
    );
  }

  const bundledCli = join(dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js");
  if (fileExists(bundledCli)) {
    return Object.freeze({
      command: nodeExecutable,
      args: Object.freeze([bundledCli, ...args]),
      source: "bundled_npm_cli",
    });
  }
  return Object.freeze({ command: "npm", args: Object.freeze(args), source: "path" });
}
