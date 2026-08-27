import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createOwnedProcessSupervisor,
  spawnOwnedProcessTree,
  stopOwnedProcessTrees,
} from "./lib/owned-process-tree.mjs";

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killedWith = [];
  }

  kill(signal) {
    this.killedWith.push(signal);
    return true;
  }

  close(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

function noSuchProcess() {
  return Object.assign(new Error("no such process"), { code: "ESRCH" });
}

function virtualClock() {
  let current = 0;
  return {
    now: () => current,
    wait: async (milliseconds) => { current += milliseconds; },
  };
}

test("spawns an owned POSIX process group and drains it with SIGTERM", async () => {
  const child = new FakeChild(4101);
  let groupAlive = true;
  let spawnCall;
  const signals = [];
  const tree = spawnOwnedProcessTree("node", ["server.mjs"], { stdio: "inherit" }, {
    platform: "linux",
    spawnProcess(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    killProcess(pid, signal) {
      assert.equal(pid, -4101);
      if (signal === 0) {
        if (!groupAlive) throw noSuchProcess();
        return;
      }
      signals.push(signal);
      if (signal === "SIGTERM") {
        groupAlive = false;
        child.close(0, "SIGTERM");
      }
    },
  });

  assert.deepEqual(spawnCall, {
    command: "node",
    args: ["server.mjs"],
    options: { stdio: "inherit", detached: true },
  });
  await tree.stop();
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(tree.stopping, true);
});

test("escalates only the same owned POSIX group after the TERM deadline", async () => {
  const child = new FakeChild(4102);
  const clock = virtualClock();
  let groupAlive = true;
  const signals = [];
  const tree = spawnOwnedProcessTree("node", [], {}, {
    platform: "darwin",
    spawnProcess: () => child,
    now: clock.now,
    wait: clock.wait,
    termGraceMs: 10,
    forceGraceMs: 10,
    pollIntervalMs: 2,
    killProcess(pid, signal) {
      assert.equal(pid, -4102);
      if (signal === 0) {
        if (!groupAlive) throw noSuchProcess();
        return;
      }
      signals.push(signal);
      if (signal === "SIGKILL") {
        groupAlive = false;
        child.close(null, "SIGKILL");
      }
    },
  });

  await tree.stop();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("never probes or signals a POSIX PGID after the owned child has fully closed", async () => {
  const child = new FakeChild(4105);
  let killCalls = 0;
  const tree = spawnOwnedProcessTree("node", [], {}, {
    platform: "linux",
    spawnProcess: () => child,
    killProcess: () => { killCalls += 1; },
  });
  child.close(0, null);

  await tree.stop();
  assert.equal(killCalls, 0);
});

test("requires inherited output pipes to close instead of accepting leader exit", async () => {
  const child = new FakeChild(4103);
  const clock = virtualClock();
  let groupAlive = true;
  let idReused = false;
  const signals = [];
  const tree = spawnOwnedProcessTree("node", [], {}, {
    platform: "linux",
    spawnProcess: () => child,
    now: clock.now,
    wait: async (milliseconds) => {
      await clock.wait(milliseconds);
      idReused = true;
    },
    termGraceMs: 4,
    forceGraceMs: 4,
    pollIntervalMs: 1,
    killProcess(_pid, signal) {
      if (signal === 0) {
        if (!groupAlive && !idReused) throw noSuchProcess();
        return;
      }
      signals.push(signal);
      groupAlive = false;
      // Deliberately omit close: a surviving descendant still owns the pipe.
    },
  });

  await assert.rejects(tree.stop(), /did not close/u);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("uses taskkill without a shell and adds force only for escalation", async () => {
  const invocations = [];
  const ownedChild = new FakeChild(4201);
  let taskkillPid = 5101;
  const tree = spawnOwnedProcessTree("node.exe", ["server.mjs"], {}, {
    platform: "win32",
    spawnProcess: () => ownedChild,
    taskkillSpawnProcess(command, args, options) {
      invocations.push({ command, args, options });
      const taskkillChild = new FakeChild(taskkillPid);
      taskkillPid += 1;
      queueMicrotask(() => {
        const forced = args.includes("/F");
        taskkillChild.emit("exit", forced ? 0 : 1, null);
        if (forced) ownedChild.close(null, "SIGKILL");
      });
      return taskkillChild;
    },
    termGraceMs: 100,
    forceGraceMs: 100,
  });

  await tree.stop();
  assert.deepEqual(invocations, [
    {
      command: "taskkill.exe",
      args: ["/PID", "4201", "/T"],
      options: { shell: false, stdio: "ignore", windowsHide: true },
    },
    {
      command: "taskkill.exe",
      args: ["/PID", "4201", "/T", "/F"],
      options: { shell: false, stdio: "ignore", windowsHide: true },
    },
  ]);
});

test("Windows tree cleanup escalates from /T to /T /F and is single-flight", async () => {
  const child = new FakeChild(4202);
  const calls = [];
  const tree = spawnOwnedProcessTree("node.exe", ["server.mjs"], {}, {
    platform: "win32",
    spawnProcess(_command, _args, options) {
      assert.equal(options.detached, false);
      return child;
    },
    taskkill: async (pid, options) => {
      calls.push({ pid, ...options });
      if (options.force) child.close(null, "SIGKILL");
      return { code: options.force ? 0 : 1, timedOut: false };
    },
  });

  const first = tree.stop();
  const second = tree.stop();
  assert.equal(first, second);
  await first;
  assert.deepEqual(calls, [
    { pid: 4202, force: false, timeoutMs: 5_000 },
    { pid: 4202, force: true, timeoutMs: 2_000 },
  ]);
});

test("rejects an unowned or invalid child PID before any group signal", () => {
  for (const pid of [1, 0, -1]) {
    const child = new FakeChild(pid);
    assert.throws(() => spawnOwnedProcessTree("node", [], {}, {
      platform: "linux",
      spawnProcess: () => child,
    }), /valid child PID/u);
    assert.deepEqual(child.killedWith, []);
  }
});

test("never invokes taskkill after the owned Windows PID has exited", async () => {
  const child = new FakeChild(4203);
  const clock = virtualClock();
  let taskkillCalls = 0;
  const tree = spawnOwnedProcessTree("node.exe", [], {}, {
    platform: "win32",
    spawnProcess: () => child,
    taskkill: async () => {
      taskkillCalls += 1;
      return { code: 0, timedOut: false };
    },
    now: clock.now,
    wait: clock.wait,
    termGraceMs: 4,
    forceGraceMs: 4,
    pollIntervalMs: 1,
  });
  child.emit("exit", 0, null);

  await assert.rejects(tree.stop(), /root exited.*pipes did not close/u);
  assert.equal(taskkillCalls, 0);
});

test("does not force a reused Windows PID when the root exits after taskkill", async () => {
  const child = new FakeChild(4204);
  const clock = virtualClock();
  const calls = [];
  const tree = spawnOwnedProcessTree("node.exe", [], {}, {
    platform: "win32",
    spawnProcess: () => child,
    taskkill: async (_pid, options) => {
      calls.push(options.force);
      child.emit("exit", 0, null);
      return { code: 1, timedOut: false };
    },
    now: clock.now,
    wait: clock.wait,
    termGraceMs: 4,
    forceGraceMs: 4,
    pollIntervalMs: 1,
  });

  await assert.rejects(tree.stop(), /exited after taskkill.*pipes did not close/u);
  assert.deepEqual(calls, [false]);
});

test("drains every owned tree even when one cleanup fails", async () => {
  const stopped = [];
  await assert.rejects(stopOwnedProcessTrees([
    { async stop() { stopped.push("first"); throw new Error("first failed"); } },
    { async stop() { stopped.push("second"); } },
  ]), /first failed/u);
  assert.deepEqual(stopped, ["first", "second"]);
});

test("supervisor coalesces concurrent child exits and exits after the drain", async () => {
  let releaseDrain;
  let drains = 0;
  const exits = [];
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  const supervisor = createOwnedProcessSupervisor([], {
    stopTrees: async () => { drains += 1; await drain; },
    exitProcess: (code) => { exits.push(code); },
  });

  const first = supervisor.stop(7);
  const second = supervisor.stop(1);
  assert.equal(first, second);
  assert.equal(supervisor.stopping, true);
  assert.equal(drains, 1);
  assert.deepEqual(exits, []);
  releaseDrain();
  await first;
  assert.deepEqual(exits, [7]);
});
