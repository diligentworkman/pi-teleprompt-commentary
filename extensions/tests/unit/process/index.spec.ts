import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createProcessRunner } from "#/process/index.ts";

class FakeChildProcess extends EventEmitter {
  readonly childProcess = this as unknown as ChildProcess;
  readonly terminationSignals: Array<NodeJS.Signals | number | undefined> = [];

  constructor() {
    super();
    this.childProcess.kill = (signal) => {
      this.terminationSignals.push(signal);

      return true;
    };
  }

  spawn() {
    this.emit("spawn");
  }

  exit({
    exitCode,
    signal = null,
  }: {
    exitCode: number | null;
    signal?: NodeJS.Signals | null;
  }) {
    this.emit("exit", exitCode, signal);
  }
}

class FakeTimeoutScheduler {
  private readonly timeouts: Array<{
    callback: () => void;
    active: boolean;
  }> = [];

  schedule(callback: () => void): () => void {
    const timeout = { callback, active: true };
    this.timeouts.push(timeout);

    return () => {
      timeout.active = false;
    };
  }

  async expireNext(): Promise<void> {
    const timeout = this.timeouts.find(({ active }) => active);
    if (!timeout) {
      throw new Error("The harness has no active timeout to expire.");
    }
    timeout.active = false;
    timeout.callback();
    await Promise.resolve();
  }

  async exhaustTerminationWaits(): Promise<void> {
    await this.expireNext();
    await this.expireNext();
  }
}

type SpawnRequest = {
  executable: string;
  args: Array<string>;
  options: SpawnOptions;
};

function createProcessRunnerHarness(spawnError?: Error) {
  const terminationWaitMs = 1;
  const timeoutScheduler = new FakeTimeoutScheduler();
  let childForStart: FakeChildProcess | undefined;
  let spawnRequest: SpawnRequest | undefined;
  const runner = createProcessRunner({
    spawnProcess(parameters) {
      if (spawnError) {
        throw spawnError;
      }
      if (!childForStart) {
        throw new Error("The harness did not prepare a child before spawning.");
      }
      spawnRequest = parameters;

      return childForStart.childProcess;
    },
    scheduleTimeout({ callback }) {
      return timeoutScheduler.schedule(callback);
    },
    terminationGracePeriodMs: terminationWaitMs,
    terminationFinalWaitMs: terminationWaitMs,
  });
  function getSpawnRequest(): SpawnRequest {
    if (!spawnRequest) {
      throw new Error("The harness has no recorded spawn request.");
    }

    return spawnRequest;
  }

  return {
    timeoutScheduler,
    start(command: [string, ...Array<string>]) {
      const child = new FakeChildProcess();
      childForStart = child;
      const runningProcess = runner.start({ command });
      childForStart = undefined;

      return { runningProcess, child };
    },
    cleanup() {
      return runner.cleanup();
    },
    spawnedCommand() {
      const { executable, args } = getSpawnRequest();

      return { executable, args };
    },
    spawnOptions() {
      const { shell, stdio } = getSpawnRequest().options;

      return { shell, stdio };
    },
  };
}

describe("process runner", () => {
  describe("start", () => {
    it("preserves direct argv elements", () => {
      const harness = createProcessRunnerHarness();
      harness.start(["code", "--wait", "a b"]);
      assert.deepEqual(harness.spawnedCommand(), {
        executable: "code",
        args: ["--wait", "a b"],
      });
    });
    it("disables the shell and inherits standard streams", () => {
      const harness = createProcessRunnerHarness();
      harness.start(["code"]);
      assert.deepEqual(harness.spawnOptions(), {
        shell: false,
        stdio: "inherit",
      });
    });
    it("reports child completion", async () => {
      const harness = createProcessRunnerHarness();
      const { runningProcess, child } = harness.start(["code"]);
      child.spawn();
      child.exit({ exitCode: 0 });
      assert.deepEqual(await runningProcess.completion, {
        type: "exited",
        exitCode: 0,
        signal: null,
      });
    });
    it("normalizes synchronous spawn failures", async () => {
      const error = new Error("missing executable");
      const harness = createProcessRunnerHarness(error);
      const { runningProcess } = harness.start(["missing"]);
      assert.deepEqual(await runningProcess.completion, {
        type: "spawn-failed",
        error,
      });
      assert.deepEqual(await runningProcess.terminate(), {
        type: "already-exited",
      });
    });
  });
  describe("terminate", () => {
    it("shares one active termination attempt between concurrent callers", async () => {
      const harness = createProcessRunnerHarness();
      const { runningProcess, child } = harness.start(["code"]);
      child.spawn();
      const firstTermination = runningProcess.terminate();
      const concurrentTermination = runningProcess.terminate();
      child.exit({ exitCode: null, signal: "SIGTERM" });
      assert.equal(concurrentTermination, firstTermination);
      assert.deepEqual(await firstTermination, {
        type: "termination-observed",
      });
      assert.deepEqual(child.terminationSignals, [undefined]);
    });
    it("allows a later explicit retry after unconfirmed termination", async () => {
      const harness = createProcessRunnerHarness();
      const { runningProcess, child } = harness.start(["code"]);
      child.spawn();
      const firstTermination = runningProcess.terminate();
      await harness.timeoutScheduler.exhaustTerminationWaits();
      assert.deepEqual(await firstTermination, {
        type: "termination-unconfirmed",
      });
      const retry = runningProcess.terminate();
      await harness.timeoutScheduler.exhaustTerminationWaits();
      assert.deepEqual(await retry, { type: "termination-unconfirmed" });
      assert.deepEqual(child.terminationSignals, [
        undefined,
        "SIGKILL",
        undefined,
        "SIGKILL",
      ]);
    });
  });
  describe("cleanup", () => {
    it("starts termination for every active child before awaiting completion", async () => {
      const harness = createProcessRunnerHarness();
      const first = harness.start(["first"]);
      const second = harness.start(["second"]);
      first.child.spawn();
      second.child.spawn();
      const cleanup = harness.cleanup();
      assert.deepEqual(first.child.terminationSignals, [undefined]);
      assert.deepEqual(second.child.terminationSignals, [undefined]);
      first.child.exit({ exitCode: null, signal: "SIGTERM" });
      second.child.exit({ exitCode: null, signal: "SIGTERM" });
      assert.deepEqual(await cleanup, [
        { type: "termination-observed" },
        { type: "termination-observed" },
      ]);
    });
    it("excludes children whose completion has settled", async () => {
      const harness = createProcessRunnerHarness();
      const completed = harness.start(["completed"]);
      completed.child.spawn();
      completed.child.exit({ exitCode: 0 });
      await completed.runningProcess.completion;
      const active = harness.start(["active"]);
      active.child.spawn();
      const cleanup = harness.cleanup();
      assert.deepEqual(completed.child.terminationSignals, []);
      assert.deepEqual(active.child.terminationSignals, [undefined]);
      active.child.exit({ exitCode: null, signal: "SIGTERM" });
      assert.deepEqual(await cleanup, [{ type: "termination-observed" }]);
    });
  });
});
