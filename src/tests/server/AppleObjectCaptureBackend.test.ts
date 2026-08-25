import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateAppleObjectCaptureProcessRows,
  AppleObjectCaptureBackend,
  appleObjectCaptureScriptPath,
} from "../../../server/reconstruction/AppleObjectCaptureBackend";
import { PHOTO_RECONSTRUCTION_LIMITS } from "../../reconstruction/contracts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "semaframe-apple-capture-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeRunner(root: string, body: string): Promise<string> {
  const path = join(root, "runner.mjs");
  await writeFile(path, body, { mode: 0o700 });
  return path;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Process ${pid} remained alive`);
}

function backendFor(scriptPath: string, overrides: ConstructorParameters<typeof AppleObjectCaptureBackend>[0] = {}) {
  return new AppleObjectCaptureBackend({
    scriptPath,
    command: process.execPath,
    commandPrefixArguments: [],
    probeTimeoutMs: 2_000,
    reconstructionTimeoutMs: 2_000,
    terminateGraceMs: 0,
    availableMemoryBytes: async () => 64n * 1024n * 1024n * 1024n,
    inspectProcessTree: async (rootPid) => ({ rssBytes: 1n, pids: [rootPid], processGroupId: rootPid }),
    ...overrides,
  });
}

describe("AppleObjectCaptureBackend", () => {
  it("charges reparented same-PGID helpers and moved-group descendants exactly once", () => {
    const rootPid = 10_000;
    const usage = aggregateAppleObjectCaptureProcessRows(rootPid, new Map([
      [rootPid, { ppid: 1, pgid: rootPid, rssKiB: 10n }],
      // This helper is no longer a PPID descendant of root, but it remains in
      // the detached group and must not disappear from the RSS total.
      [10_001, { ppid: 1, pgid: rootPid, rssKiB: 20n }],
      // This row is both a PPID descendant and a group member; it is counted once.
      [10_002, { ppid: rootPid, pgid: rootPid, rssKiB: 30n }],
      // A child of the reparented helper moved into a new group, so PPID
      // traversal seeded by every owned-group row must retain it.
      [10_003, { ppid: 10_001, pgid: 10_003, rssKiB: 40n }],
      [20_000, { ppid: 1, pgid: 20_000, rssKiB: 1_000n }],
    ]));

    expect(usage).toEqual({
      rssBytes: 100n * 1024n,
      pids: [10_000, 10_001, 10_002, 10_003],
      processGroupId: rootPid,
    });
  });

  it("enforces the contract default and validates injectable quota controls", async () => {
    const root = await temporaryDirectory();
    const runner = await fakeRunner(root, "console.log(JSON.stringify({version:1,type:'probe',supported:true}));");

    expect(PHOTO_RECONSTRUCTION_LIMITS.maximumObjectCaptureOutputBytes).toBe(8 * 1024 * 1024 * 1024);
    expect(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureOutputBytesByProfile).toEqual({
      preview: 1 * 1024 * 1024 * 1024,
      balanced: 4 * 1024 * 1024 * 1024,
      quality: 8 * 1024 * 1024 * 1024,
    });
    expect(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumPixelsByProfile).toEqual({
      preview: 250_000_000,
      balanced: 600_000_000,
      quality: 1_000_000_000,
    });
    expect(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile).toEqual({
      preview: 2 * 1024 * 1024 * 1024,
      balanced: 6 * 1024 * 1024 * 1024,
      quality: 8 * 1024 * 1024 * 1024,
    });
    expect(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeMemoryReserveBytes).toBe(1024 * 1024 * 1024);
    expect(() => backendFor(runner, { maximumOutputBytes: 0 }))
      .toThrow("Object Capture maximum output bytes must be a positive safe integer");
    expect(() => backendFor(runner, { outputQuotaPollMs: 0 }))
      .toThrow("Object Capture quota poll interval must be an integer between 1 and 60000 ms");
    expect(() => backendFor(runner, { minimumFreeBytesAfterOutput: -1 }))
      .toThrow("Object Capture free-space reserve must be a non-negative safe integer");
    expect(() => backendFor(runner, { memoryPollMs: 0 }))
      .toThrow("Object Capture memory poll interval must be an integer between 1 and 60000 ms");
    expect(() => backendFor(runner, { minimumFreeMemoryBytes: -1 }))
      .toThrow("Object Capture free-memory reserve must be a non-negative safe integer");
  });

  it("fails before launch when the filesystem cannot preserve the configured free-space reserve", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, "throw new Error('must not launch');");
    let availableProbePath = "";
    const backend = backendFor(runner, {
      maximumOutputBytes: 64,
      minimumFreeBytesAfterOutput: 32,
      availableOutputBytes: async (path) => {
        availableProbePath = path;
        return 95n;
      },
    });

    await expect(backend.reconstruct({
      inputDirectory,
      outputDirectory: join(root, "capacity-output"),
      detail: "preview",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      details: { maximumOutputBytes: 64, minimumFreeBytesAfterOutput: 32 },
    });
    expect(availableProbePath).toBe(join(root, "capacity-output"));
  });

  it("rejects profile pixel excess and unavailable memory before launching native work", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, "throw new Error('must not launch');");
    let spawnCalls = 0;
    const backend = backendFor(runner, {
      spawnProcess: (command, args, options) => {
        spawnCalls += 1;
        return spawn(command, args, options);
      },
    });

    await expect(backend.reconstruct({
      inputDirectory,
      outputDirectory: join(root, "pixel-output"),
      detail: "preview",
      aggregatePixelCount: 250_000_001,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Object Capture photo set exceeds the selected profile's decoded pixel budget",
      details: { aggregatePixelCount: 250_000_001, maximumAggregatePixelCount: 250_000_000 },
    });

    const requiredPreviewMemory = BigInt(
      PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile.preview
      + PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeMemoryReserveBytes,
    );
    await expect(backendFor(runner, {
      availableMemoryBytes: async () => requiredPreviewMemory - 1n,
      spawnProcess: (command, args, options) => {
        spawnCalls += 1;
        return spawn(command, args, options);
      },
    }).reconstruct({
      inputDirectory,
      outputDirectory: join(root, "memory-output"),
      detail: "preview",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Object Capture does not have enough available memory for the selected reconstruction profile",
      details: {
        maximumProcessRssBytes: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile.preview,
        minimumFreeMemoryBytes: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeMemoryReserveBytes,
      },
    });
    expect(spawnCalls).toBe(0);
  });

  it("requires the balanced RSS ceiling plus reserve and accepts the exact live ceiling", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, `
      import { mkdir, writeFile } from "node:fs/promises";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      await mkdir(output, {recursive:true});
      await writeFile(output + "/model.obj", "v 0 0 0\\n");
      console.log(JSON.stringify({version:1,type:"started"}));
      await new Promise((resolve) => setTimeout(resolve, 30));
      console.log(JSON.stringify({version:1,type:"complete",progress:1}));
    `);
    const maximumProcessRssBytes =
      PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile.balanced;
    const requiredMemory = BigInt(
      maximumProcessRssBytes
      + PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeMemoryReserveBytes,
    );
    let spawnCalls = 0;
    const countedSpawn = (command: string, args: string[], options: SpawnOptions) => {
      spawnCalls += 1;
      return spawn(command, args, options);
    };

    await expect(backendFor(runner, {
      availableMemoryBytes: async () => requiredMemory - 1n,
      spawnProcess: countedSpawn,
    }).reconstruct({
      inputDirectory,
      outputDirectory: join(root, "balanced-preflight-rejected"),
      detail: "medium",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Object Capture does not have enough available memory for the selected reconstruction profile",
      details: {
        maximumProcessRssBytes,
        minimumFreeMemoryBytes: PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeMemoryReserveBytes,
      },
    });
    expect(spawnCalls).toBe(0);

    await expect(backendFor(runner, {
      availableMemoryBytes: async () => requiredMemory,
      inspectProcessTree: async (rootPid) => ({
        rssBytes: BigInt(maximumProcessRssBytes),
        pids: [rootPid],
        processGroupId: rootPid,
      }),
      memoryPollMs: 5,
      spawnProcess: countedSpawn,
    }).reconstruct({
      inputDirectory,
      outputDirectory: join(root, "balanced-exact-boundary"),
      detail: "medium",
      aggregatePixelCount: 1,
    })).resolves.toMatchObject({
      objPath: join(root, "balanced-exact-boundary", "model.obj"),
    });
    expect(spawnCalls).toBe(1);
  });

  it("fails closed before launch when available-memory preflight cannot be established", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, "throw new Error('must not launch');");
    let spawnCalls = 0;
    const backend = backendFor(runner, {
      availableMemoryBytes: async () => { throw new Error("memory probe unavailable"); },
      spawnProcess: (command, args, options) => {
        spawnCalls += 1;
        return spawn(command, args, options);
      },
    });

    await expect(backend.reconstruct({
      inputDirectory,
      outputDirectory: join(root, "probe-output"),
      detail: "preview",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Object Capture could not verify available system memory",
    });
    expect(spawnCalls).toBe(0);
  });

  it("spawns without a shell, streams progress, and independently discovers the OBJ", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "result");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, `
      import { mkdir, writeFile } from "node:fs/promises";
      const args = process.argv.slice(2);
      if (args.includes("--probe")) {
        console.log(JSON.stringify({version:1,type:"probe",supported:true}));
      } else {
        const output = args[args.indexOf("--output") + 1];
        await mkdir(output, {recursive:true});
        await mkdir(output + "/nested");
        await writeFile(output + "/nested/model.obj", "v 0 0 0\\n");
        await writeFile(output + "/model.mtl", "newmtl x\\n");
        console.log(JSON.stringify({version:1,type:"started"}));
        console.log(JSON.stringify({version:1,type:"progress",progress:0.5}));
        console.log(JSON.stringify({version:1,type:"complete",progress:1}));
      }
    `);
    const spawnCalls: Array<{ command: string; args: string[]; shell: unknown; detached: unknown }> = [];
    const backend = backendFor(runner, {
      spawnProcess: (command, args, options) => {
        spawnCalls.push({ command, args, shell: options.shell, detached: options.detached });
        return spawn(command, args, options);
      },
    });
    await expect(backend.probe()).resolves.toEqual({
      version: 1,
      backendId: "apple-object-capture",
      supported: true,
    });
    const progress: string[] = [];
    const result = await backend.reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "preview",
      aggregatePixelCount: 1,
      onProgress: (event) => progress.push(event.type),
    });
    expect(result.objPath).toBe(join(outputDirectory, "nested/model.obj"));
    expect(result.artifacts).toEqual([
      join(outputDirectory, "model.mtl"),
      join(outputDirectory, "nested/model.obj"),
    ]);
    expect(progress).toEqual(["started", "progress", "complete"]);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls.every((call) => call.shell === false)).toBe(true);
    expect(spawnCalls.every((call) => call.detached === (process.platform !== "win32"))).toBe(true);
    expect(spawnCalls[1]!.args).toContain("--input");
    expect(spawnCalls[1]!.args).toContain("--output");
  });

  it("rejects malformed JSONL, timeouts, and AbortSignal cancellation", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    await mkdir(inputDirectory);

    const malformed = await fakeRunner(root, "console.log('not-json');");
    await expect(backendFor(malformed).reconstruct({
      inputDirectory,
      outputDirectory: join(root, "malformed-output"),
      detail: "preview",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({ code: "protocol_error" });

    const hanging = await fakeRunner(root, "setInterval(() => {}, 1000);");
    await expect(backendFor(hanging, { reconstructionTimeoutMs: 30 }).reconstruct({
      inputDirectory,
      outputDirectory: join(root, "timeout-output"),
      detail: "reduced",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const operation = backendFor(hanging).reconstruct({
      inputDirectory,
      outputDirectory: join(root, "abort-output"),
      detail: "medium",
      aggregatePixelCount: 1,
      signal: controller.signal,
    });
    controller.abort(new Error("stop"));
    await expect(operation).rejects.toMatchObject({ code: "aborted" });
  });

  it.skipIf(process.platform === "win32")("reaps a helper when abort arrives before the first RSS inspection settles", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "early-abort-output");
    const helperPath = join(root, "early-abort-helper.mjs");
    const helperPidPath = join(root, "early-abort-helper-pid.txt");
    const helperReadyPath = join(root, "early-abort-helper-ready.txt");
    await mkdir(inputDirectory);
    await writeFile(helperPath, `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      writeFileSync(${JSON.stringify(helperReadyPath)}, "ready");
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });
    const runner = await fakeRunner(root, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const helper = spawn(process.execPath, [${JSON.stringify(helperPath)}], {stdio:"ignore"});
      helper.unref();
      writeFileSync(${JSON.stringify(helperPidPath)}, String(helper.pid));
      console.log(JSON.stringify({version:1,type:"started"}));
      setInterval(() => {}, 1000);
    `);
    let releaseInspection: (() => void) | undefined;
    let reportInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>((resolvePromise) => { reportInspectionStarted = resolvePromise; });
    const controller = new AbortController();
    const backend = backendFor(runner, {
      reconstructionTimeoutMs: 5_000,
      terminateGraceMs: 50,
      inspectProcessTree: async (rootPid) => {
        reportInspectionStarted();
        await new Promise<void>((resolvePromise) => { releaseInspection = resolvePromise; });
        return { rssBytes: 1n, pids: [rootPid], processGroupId: rootPid };
      },
    });
    const operation = backend.reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "preview",
      aggregatePixelCount: 1,
      signal: controller.signal,
    });
    let helperPid = 0;
    try {
      helperPid = Number(await waitForFile(helperPidPath));
      await waitForFile(helperReadyPath);
      await inspectionStarted;
      expect(processIsAlive(helperPid)).toBe(true);
      controller.abort(new Error("early stop"));
      await expect(operation).rejects.toMatchObject({ code: "aborted" });
      await waitForProcessExit(helperPid);
      expect(processIsAlive(helperPid)).toBe(false);
    } finally {
      releaseInspection?.();
      if (helperPid > 0 && processIsAlive(helperPid)) {
        try { process.kill(helperPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it.skipIf(process.platform === "win32")("reaps a helper before accepting success when close wins the first RSS inspection", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "early-close-output");
    const helperPath = join(root, "early-close-helper.mjs");
    const helperPidPath = join(root, "early-close-helper-pid.txt");
    const helperReadyPath = join(root, "early-close-helper-ready.txt");
    const allowCompletePath = join(root, "early-close-allow-complete.txt");
    await mkdir(inputDirectory);
    await writeFile(helperPath, `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      writeFileSync(${JSON.stringify(helperReadyPath)}, "ready");
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });
    const runner = await fakeRunner(root, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { access, mkdir, writeFile } from "node:fs/promises";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      const helper = spawn(process.execPath, [${JSON.stringify(helperPath)}], {stdio:"ignore"});
      helper.unref();
      writeFileSync(${JSON.stringify(helperPidPath)}, String(helper.pid));
      while (true) {
        try { await access(${JSON.stringify(helperReadyPath)}); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
      }
      while (true) {
        try { await access(${JSON.stringify(allowCompletePath)}); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
      }
      await mkdir(output, {recursive:true});
      await writeFile(output + "/model.obj", "v 0 0 0\\n");
      console.log(JSON.stringify({version:1,type:"started"}));
      console.log(JSON.stringify({version:1,type:"complete",progress:1}));
    `);
    let releaseInspection: (() => void) | undefined;
    let reportInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>((resolvePromise) => { reportInspectionStarted = resolvePromise; });
    const backend = backendFor(runner, {
      inspectProcessTree: async (rootPid) => {
        reportInspectionStarted();
        await new Promise<void>((resolvePromise) => { releaseInspection = resolvePromise; });
        return { rssBytes: 1n, pids: [rootPid], processGroupId: rootPid };
      },
    });
    const operation = backend.reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "preview",
      aggregatePixelCount: 1,
    });
    let helperPid = 0;
    try {
      helperPid = Number(await waitForFile(helperPidPath));
      await waitForFile(helperReadyPath);
      await inspectionStarted;
      expect(processIsAlive(helperPid)).toBe(true);
      await writeFile(allowCompletePath, "go");
      await expect(operation).resolves.toMatchObject({ objPath: join(outputDirectory, "model.obj") });
      await waitForProcessExit(helperPid);
      expect(processIsAlive(helperPid)).toBe(false);
    } finally {
      releaseInspection?.();
      if (helperPid > 0 && processIsAlive(helperPid)) {
        try { process.kill(helperPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("recursively accounts regular files and terminates a running process when its quota is exceeded", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "quota-output");
    const terminationMarker = join(root, "terminated.txt");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, `
      import { mkdir, writeFile } from "node:fs/promises";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      process.on("SIGTERM", () => {
        void writeFile(${JSON.stringify(terminationMarker)}, "terminated").finally(() => process.exit(0));
      });
      await mkdir(output + "/nested", {recursive:true});
      await writeFile(output + "/first.bin", Buffer.alloc(40));
      await writeFile(output + "/nested/second.bin", Buffer.alloc(40));
      console.log(JSON.stringify({version:1,type:"started"}));
      setInterval(() => {}, 1000);
    `);
    const backend = backendFor(runner, {
      maximumOutputBytes: 64,
      outputQuotaPollMs: 5,
      reconstructionTimeoutMs: 5_000,
      terminateGraceMs: 200,
    });
    const startedAt = Date.now();

    await expect(backend.reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "full",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      details: { maximumOutputBytes: 64 },
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(readFile(terminationMarker, "utf8")).resolves.toBe("terminated");
  });

  it("terminates a running process when free space falls below the configured reserve", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "depleted-output");
    const terminationMarker = join(root, "depleted-terminated.txt");
    const producerReadyMarker = join(root, "depleted-ready.txt");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, `
      import { mkdir, writeFile } from "node:fs/promises";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      process.on("SIGTERM", () => {
        void writeFile(${JSON.stringify(terminationMarker)}, "terminated").finally(() => process.exit(0));
      });
      await mkdir(output, {recursive:true});
      await writeFile(${JSON.stringify(producerReadyMarker)}, "ready");
      console.log(JSON.stringify({version:1,type:"started"}));
      setInterval(() => {}, 1000);
    `);
    let capacityChecks = 0;
    const backend = backendFor(runner, {
      maximumOutputBytes: 64,
      minimumFreeBytesAfterOutput: 32,
      availableOutputBytes: async () => {
        capacityChecks += 1;
        if (capacityChecks === 1) return 96n;
        return readFile(producerReadyMarker).then(() => 31n, () => 96n);
      },
      outputQuotaPollMs: 5,
      reconstructionTimeoutMs: 5_000,
      terminateGraceMs: 200,
    });
    const startedAt = Date.now();

    await expect(backend.reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "full",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Object Capture could not preserve its configured temporary storage reserve",
      details: { minimumFreeBytesAfterOutput: 32 },
    });
    expect(capacityChecks).toBeGreaterThanOrEqual(2);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(readFile(terminationMarker, "utf8")).resolves.toBe("terminated");
  });

  it("terminates a running process when available memory falls below the live reserve", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "memory-depleted-output");
    const terminationMarker = join(root, "memory-depleted-terminated.txt");
    const producerReadyMarker = join(root, "memory-depleted-ready.txt");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, `
      import { mkdirSync, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      process.on("SIGTERM", () => {
        writeFileSync(${JSON.stringify(terminationMarker)}, "terminated");
        process.exit(0);
      });
      mkdirSync(output, {recursive:true});
      writeFileSync(${JSON.stringify(producerReadyMarker)}, "ready");
      console.log(JSON.stringify({version:1,type:"started"}));
      setInterval(() => {}, 1000);
    `);
    let memoryChecks = 0;
    const minimumFreeMemoryBytes = 64;
    const backend = backendFor(runner, {
      minimumFreeMemoryBytes,
      availableMemoryBytes: async () => {
        memoryChecks += 1;
        if (memoryChecks === 1) return 16n * 1024n * 1024n * 1024n;
        return readFile(producerReadyMarker).then(() => 63n, () => 16n * 1024n * 1024n * 1024n);
      },
      memoryPollMs: 5,
      reconstructionTimeoutMs: 5_000,
      terminateGraceMs: 200,
    });

    await expect(backend.reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "preview",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Object Capture could not preserve its configured free-memory reserve",
      details: { minimumFreeMemoryBytes },
    });
    expect(memoryChecks).toBeGreaterThanOrEqual(2);
    await expect(readFile(terminationMarker, "utf8")).resolves.toBe("terminated");
  });

  it.skipIf(process.platform === "win32")("enforces aggregate process-tree RSS and terminates helper processes", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "rss-output");
    const parentMarker = join(root, "rss-parent-terminated.txt");
    const helperMarker = join(root, "rss-helper-terminated.txt");
    const helperReady = join(root, "rss-helper-ready.txt");
    const helperPidPath = join(root, "rss-helper-pid.txt");
    await mkdir(inputDirectory);
    const helper = join(root, "helper.mjs");
    await writeFile(helper, `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {
        writeFileSync(${JSON.stringify(helperMarker)}, "terminated");
        process.exit(0);
      });
      writeFileSync(${JSON.stringify(helperReady)}, "ready");
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });
    const runner = await fakeRunner(root, `
      import { spawn } from "node:child_process";
      import { mkdirSync, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      process.on("SIGTERM", () => {
        writeFileSync(${JSON.stringify(parentMarker)}, "terminated");
        process.exit(0);
      });
      mkdirSync(output, {recursive:true});
      const helper = spawn(process.execPath, [${JSON.stringify(helper)}], {stdio:"ignore"});
      writeFileSync(${JSON.stringify(helperPidPath)}, String(helper.pid));
      console.log(JSON.stringify({version:1,type:"started"}));
      setInterval(() => {}, 1000);
    `);
    let treeChecks = 0;
    const maximumProcessRssBytes =
      PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile.balanced;
    const backend = backendFor(runner, {
      memoryPollMs: 5,
      reconstructionTimeoutMs: 5_000,
      terminateGraceMs: 300,
      inspectProcessTree: async (rootPid) => {
        treeChecks += 1;
        try {
          await readFile(helperReady);
          const helperPid = Number(await readFile(helperPidPath, "utf8"));
          return {
            rssBytes: BigInt(maximumProcessRssBytes) + 1n,
            pids: [rootPid, helperPid],
            processGroupId: rootPid,
          };
        } catch {
          return { rssBytes: 1n, pids: [rootPid], processGroupId: rootPid };
        }
      },
    });

    await expect(backend.reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "medium",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Object Capture exceeded its process-tree memory budget",
      details: { maximumProcessRssBytes },
    });
    expect(treeChecks).toBeGreaterThanOrEqual(1);
    await expect(readFile(parentMarker, "utf8")).resolves.toBe("terminated");
    await expect(readFile(helperMarker, "utf8")).resolves.toBe("terminated");
  });

  it("fails closed and terminates native work when dedicated process-group isolation cannot be verified", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "unsupervised-output");
    const terminationMarker = join(root, "unsupervised-terminated.txt");
    const producerReadyMarker = join(root, "unsupervised-ready.txt");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, `
      import { mkdirSync, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      process.on("SIGTERM", () => {
        writeFileSync(${JSON.stringify(terminationMarker)}, "terminated");
        process.exit(0);
      });
      mkdirSync(output, {recursive:true});
      writeFileSync(${JSON.stringify(producerReadyMarker)}, "ready");
      console.log(JSON.stringify({version:1,type:"started"}));
      setInterval(() => {}, 1000);
    `);
    const backend = backendFor(runner, {
      memoryPollMs: 5,
      reconstructionTimeoutMs: 5_000,
      terminateGraceMs: 200,
      inspectProcessTree: async (rootPid) => {
        try {
          await readFile(producerReadyMarker);
        } catch {
          return { rssBytes: 1n, pids: [rootPid], processGroupId: rootPid };
        }
        return { rssBytes: 1n, pids: [rootPid], processGroupId: rootPid + 1 };
      },
    });

    await expect(backend.reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "preview",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Object Capture could not verify its process-tree memory use",
    });
    await expect(readFile(terminationMarker, "utf8")).resolves.toBe("terminated");
  });

  it("rejects a symbolic link in the live output tree and terminates the producer", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "symlink-output");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, `
      import { mkdir, symlink } from "node:fs/promises";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      await mkdir(output, {recursive:true});
      await symlink(${JSON.stringify(root)}, output + "/escape");
      console.log(JSON.stringify({version:1,type:"started"}));
      setInterval(() => {}, 1000);
    `);

    await expect(backendFor(runner, {
      maximumOutputBytes: 1_024,
      outputQuotaPollMs: 5,
      reconstructionTimeoutMs: 5_000,
    }).reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "preview",
      aggregatePixelCount: 1,
    })).rejects.toMatchObject({
      code: "output_missing",
      message: "Object Capture output contains a symbolic link",
    });
  });

  it.skipIf(process.platform === "win32")("rejects a special file in the live output tree", async () => {
    const root = await temporaryDirectory();
    const inputDirectory = join(root, "photos");
    const outputDirectory = join(root, "special-output");
    await mkdir(inputDirectory);
    const runner = await fakeRunner(root, `
      import { mkdir } from "node:fs/promises";
      import { execFileSync } from "node:child_process";
      const args = process.argv.slice(2);
      const output = args[args.indexOf("--output") + 1];
      await mkdir(output, {recursive:true});
      execFileSync("/usr/bin/mkfifo", [output + "/special.fifo"]);
      console.log(JSON.stringify({version:1,type:"started"}));
      setInterval(() => {}, 1000);
    `);

    const operation = backendFor(runner, {
      maximumOutputBytes: 1_024,
      outputQuotaPollMs: 5,
      reconstructionTimeoutMs: 5_000,
    }).reconstruct({
      inputDirectory,
      outputDirectory,
      detail: "preview",
      aggregatePixelCount: 1,
    });
    await expect(operation).rejects.toMatchObject({
      code: "output_missing",
      message: "Object Capture output contains a special file",
    });
  });

  it.skipIf(process.platform !== "darwin")("runs the checked-in Swift probe without exposing paths", async () => {
    const backend = new AppleObjectCaptureBackend({ probeTimeoutMs: 30_000 });
    const probe = await backend.probe();
    expect(probe).toMatchObject({
      version: 1,
      backendId: "apple-object-capture",
      supported: expect.any(Boolean),
    });
    expect(JSON.stringify(probe)).not.toContain(appleObjectCaptureScriptPath);
    expect(JSON.stringify(probe)).not.toContain("/Users/");
  });

  it.skipIf(process.platform !== "darwin")("keeps Swift JSONL failures free of input and temporary paths", async () => {
    const root = await temporaryDirectory();
    const secretInput = join(root, "private-photo-set");
    const secretOutput = join(root, "private-output");
    const result = await new Promise<{ code: number | null; stdout: string }>((resolvePromise, reject) => {
      const child = spawn("/usr/bin/xcrun", [
        "swift",
        appleObjectCaptureScriptPath,
        "--input",
        secretInput,
        "--output",
        secretOutput,
        "--detail",
        "preview",
      ], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ code, stdout }));
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain(root);
    expect(result.stdout).not.toContain(secretInput);
    expect(result.stdout).not.toContain(secretOutput);
    expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ version: 1, type: "error", message: "Input must be an existing directory" }),
    ]);
  });
});
