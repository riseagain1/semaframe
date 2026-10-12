// @vitest-environment node
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
// @ts-expect-error The executable .mjs helper does not ship declarations.
import { launchChromeForSmoke } from "../../scripts/lib/chrome-smoke-launcher.mjs";

// The fake browser uses a real OS process and HTTP startup endpoint. Its
// deliberately detached, short-lived helper holds stderr after browser exit,
// just as a Chrome helper can. No unrelated process is signalled.
const fakeBrowser = String.raw`
  import { createServer } from "node:http";
  import { spawn } from "node:child_process";
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Connection", "close");
    if (request.url === "/close") {
      const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
        detached: true, stdio: ["ignore", "ignore", 2],
      });
      helper.unref();
      response.end("{}");
      server.close(() => process.exit(0));
    } else response.end("{}");
  });
  server.listen(0, "127.0.0.1", () => {
    process.stderr.write("DevTools listening on ws://127.0.0.1:" + server.address().port + "/devtools/browser/fixture\n");
    process.stderr.write("fixture-ready auth_token=never-print-this-token\n");
  });
`;

describe("Chrome smoke process diagnostics", () => {
  it("closes the owned browser without waiting on a detached helper's inherited stderr", async () => {
    const profile = await mkdtemp(join(tmpdir(), "semaframe-launcher-test-"));
    let launch;
    try {
      launch = await launchChromeForSmoke({
        executable: process.execPath, profile,
        extraArgs: ["--input-type=module", "--eval", fakeBrowser, "--"],
        timeoutMs: 5_000,
      });
      expect(launch.browser.stderr).toBeNull();
      expect(launch.diagnosticText()).toContain("fixture-ready");
      expect(launch.diagnosticText()).not.toContain("never-print-this-token");
      if (process.platform !== "win32") {
        expect((await stat(join(profile, ".semaframe-smoke-stderr.log"))).mode & 0o777).toBe(0o600);
      }
      const closed = once(launch.browser, "close", { signal: AbortSignal.timeout(1_000) });
      await fetch(`http://127.0.0.1:${launch.cdpPort}/close`);
      await closed;
      expect(launch.browserTree.closed).toBe(true);
      await expect(launch.browserTree.stop()).resolves.toBeUndefined();
    } finally {
      await launch?.browserTree.stop();
      // The test helper self-terminates; never kill it by an unowned PID.
      await delay(2_100);
      await rm(profile, { recursive: true, force: true });
    }
  }, 10_000);

  it("retains bounded sanitized startup failure diagnostics without a stderr pipe", async () => {
    const profile = await mkdtemp(join(tmpdir(), "semaframe-launcher-failure-test-"));
    try {
      await expect(launchChromeForSmoke({
        executable: process.execPath, profile,
        extraArgs: ["--eval", "process.stderr.write('fixture-startup-failure auth_token=never-print-this-token'); process.exit(3)", "--"],
        timeoutMs: 2_000,
      })).rejects.toThrow(/Chrome exited before DevTools became ready \(code 3\).*fixture-startup-failure auth_token=\[redacted\]/u);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
