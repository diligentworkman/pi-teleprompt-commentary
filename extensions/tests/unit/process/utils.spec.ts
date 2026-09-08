import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import type { ProcessCompletion } from "#/process/index.ts";
import { errorMessageTemplates } from "#/process/messages.ts";
import {
  observeProcessCompletion,
  scheduleTimeout,
  spawnProcess,
  terminateProcess,
} from "#/process/utils.ts";

function createChildProcess(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

function createPendingProcessCompletion(): {
  promise: Promise<ProcessCompletion>;
  resolve(completion: ProcessCompletion): void;
} {
  let resolveCompletion: (completion: ProcessCompletion) => void = () => {
    throw new Error("Process completion resolver was unavailable.");
  };
  const promise = new Promise<ProcessCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  return {
    promise,
    resolve(completion) {
      resolveCompletion(completion);
    },
  };
}

describe("process utilities", () => {
  describe("spawnProcess", () => {
    it("passes an argv element containing spaces to the child unchanged", async () => {
      const argumentWithSpaces = "a b";
      const verifyArgumentScript = `
        if (process.argv[1] !== ${JSON.stringify(argumentWithSpaces)}) {
          process.exit(1);
        }
      `;
      const childProcess = spawnProcess({
        executable: process.execPath,
        args: ["-e", verifyArgumentScript, argumentWithSpaces],
        options: { shell: false, stdio: "ignore" },
      });
      assert.deepEqual(
        await observeProcessCompletion(childProcess).completion,
        {
          type: "exited",
          exitCode: 0,
          signal: null,
        },
      );
    });
  });
  describe("scheduleTimeout", () => {
    it("cancels a scheduled timeout", async () => {
      let callbackWasCalled = false;
      const cancelTimeout = scheduleTimeout({
        callback() {
          callbackWasCalled = true;
        },
        delayMs: 1,
      });
      cancelTimeout();
      await delay(5);
      assert.equal(callbackWasCalled, false);
    });
  });
  describe("observeProcessCompletion", () => {
    it("reports an error before spawn as a spawn failure", async () => {
      const childProcess = createChildProcess();
      const observer = observeProcessCompletion(childProcess);
      const error = new Error("executable not found");
      childProcess.emit("error", error);
      assert.deepEqual(await observer.completion, {
        type: "spawn-failed",
        error,
      });
    });
    it("reports a normal process exit", async () => {
      const childProcess = createChildProcess();
      const observer = observeProcessCompletion(childProcess);
      childProcess.emit("spawn");
      childProcess.emit("exit", 0, null);
      assert.equal(observer.isSettled(), true);
      assert.deepEqual(await observer.completion, {
        type: "exited",
        exitCode: 0,
        signal: null,
      });
    });
    it("reports an exit caused by a signal", async () => {
      const childProcess = createChildProcess();
      const observer = observeProcessCompletion(childProcess);
      childProcess.emit("spawn");
      childProcess.emit("exit", null, "SIGTERM");
      assert.deepEqual(await observer.completion, {
        type: "exited",
        exitCode: null,
        signal: "SIGTERM",
      });
    });
    it("ignores errors after spawn and preserves the first completion", async () => {
      const childProcess = createChildProcess();
      const observer = observeProcessCompletion(childProcess);
      childProcess.emit("spawn");
      childProcess.emit("error", new Error("later error"));
      childProcess.emit("exit", 1, null);
      childProcess.emit("exit", 0, null);
      assert.deepEqual(await observer.completion, {
        type: "exited",
        exitCode: 1,
        signal: null,
      });
    });
  });
  describe("terminateProcess", () => {
    const terminationWaitMs = 1;
    it("does not signal a process whose completion was already observed", async () => {
      const childProcess = createChildProcess();
      let killCallCount = 0;
      childProcess.kill = () => {
        killCallCount += 1;

        return true;
      };
      assert.deepEqual(
        await terminateProcess({
          childProcess,
          isCompletionSettled() {
            return true;
          },
          completion: Promise.resolve({
            type: "exited",
            exitCode: 0,
            signal: null,
          }),
          scheduleTimeout() {
            throw new Error("A settled process must not schedule a timeout.");
          },
          gracePeriodMs: terminationWaitMs,
          finalWaitMs: terminationWaitMs,
        }),
        { type: "already-exited" },
      );
      assert.equal(killCallCount, 0);
    });
    it("observes completion after a graceful termination request", async () => {
      const childProcess = createChildProcess();
      const completion = createPendingProcessCompletion();
      let timeoutWasCancelled = false;
      childProcess.kill = () => {
        completion.resolve({
          type: "exited",
          exitCode: null,
          signal: "SIGTERM",
        });

        return true;
      };
      const outcome = await terminateProcess({
        childProcess,
        isCompletionSettled() {
          return false;
        },
        completion: completion.promise,
        scheduleTimeout() {
          return () => {
            timeoutWasCancelled = true;
          };
        },
        gracePeriodMs: terminationWaitMs,
        finalWaitMs: terminationWaitMs,
      });
      assert.deepEqual(outcome, { type: "termination-observed" });
      assert.equal(timeoutWasCancelled, true);
    });
    it("escalates to forceful termination after the grace period", async () => {
      const childProcess = createChildProcess();
      const completion = createPendingProcessCompletion();
      const scheduledTimeouts: Array<() => void> = [];
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      childProcess.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          completion.resolve({
            type: "exited",
            exitCode: null,
            signal: "SIGKILL",
          });
        }

        return true;
      };
      const termination = terminateProcess({
        childProcess,
        isCompletionSettled() {
          return false;
        },
        completion: completion.promise,
        scheduleTimeout({ callback }) {
          scheduledTimeouts.push(callback);

          return () => {};
        },
        gracePeriodMs: terminationWaitMs,
        finalWaitMs: terminationWaitMs,
      });
      scheduledTimeouts[0]();
      assert.deepEqual(await termination, { type: "termination-observed" });
      assert.deepEqual(signals, [undefined, "SIGKILL"]);
    });
    it("reports failed termination requests", async () => {
      const childProcess = createChildProcess();
      childProcess.kill = () => false;
      const completion = createPendingProcessCompletion();
      const outcome = await terminateProcess({
        childProcess,
        isCompletionSettled() {
          return false;
        },
        completion: completion.promise,
        scheduleTimeout({ callback }) {
          callback();

          return () => {};
        },
        gracePeriodMs: terminationWaitMs,
        finalWaitMs: terminationWaitMs,
      });
      assert.deepEqual(outcome, {
        type: "termination-failed",
        error: new Error(errorMessageTemplates.terminationRequestFailed()),
      });
    });
    it("reports unconfirmed termination after both bounded waits", async () => {
      const childProcess = createChildProcess();
      childProcess.kill = () => true;
      const completion = createPendingProcessCompletion();
      assert.deepEqual(
        await terminateProcess({
          childProcess,
          isCompletionSettled() {
            return false;
          },
          completion: completion.promise,
          scheduleTimeout({ callback }) {
            callback();

            return () => {};
          },
          gracePeriodMs: terminationWaitMs,
          finalWaitMs: terminationWaitMs,
        }),
        { type: "termination-unconfirmed" },
      );
    });
  });
});
