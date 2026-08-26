import { spawn } from "node:child_process";
import { resolveNpmLaunch } from "./lib/npm-launcher.mjs";

const launch = resolveNpmLaunch(["--version"]);
const child = spawn(launch.command, launch.args, {
  env: process.env,
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});

const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
timeout.unref();

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`npm launcher was terminated by ${signal}.`));
    else resolve(code ?? 1);
  });
}).finally(() => clearTimeout(timeout));

if (exitCode !== 0) throw new Error(`npm launcher exited with code ${exitCode}.`);
