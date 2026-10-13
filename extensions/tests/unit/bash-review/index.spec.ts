import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startBashExternalReview } from "#/bash-review/index.ts";
import type {
  ProcessCompletion,
  ProcessRunner,
  TerminationOutcome,
} from "#/process/index.ts";

function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createProcessRunnerHarness({
  completion,
  terminate,
}: {
  completion: Promise<ProcessCompletion>;
  terminate?: () => Promise<TerminationOutcome>;
}) {
  const startedCommands: Array<[string, ...Array<string>]> = [];
  let terminationCount = 0;
  const processRunner: ProcessRunner = {
    start({ command }) {
      startedCommands.push(command);

      return {
        completion,
        async terminate() {
          terminationCount += 1;

          return terminate
            ? terminate()
            : { type: "termination-observed" };
        },
      };
    },
    async cleanup() {
      return [];
    },
  };

  return {
    processRunner,
    startedCommands,
    getTerminationCount: () => terminationCount,
  };
}

function startReview({
  processRunner,
  readCommandFile,
}: {
  processRunner: ProcessRunner;
  readCommandFile?: (path: string) => Promise<string>;
}) {
  return startBashExternalReview({
    input: {
      command: ["editor", "--wait", "/runtime/command.txt"],
      commandFilePath: "/runtime/command.txt",
      originalCommand: "printf 'original'",
    },
    dependencies: {
      processRunner,
      readCommandFile:
        readCommandFile ?? (async () => "printf 'original'"),
    },
  });
}

describe("Bash external review process adaptation", () => {
  describe("when the editor process exits successfully", () => {
    it("starts the exact direct-argv command and reports unchanged command content", async () => {
      const harness = createProcessRunnerHarness({
        completion: Promise.resolve({
          type: "exited",
          exitCode: 0,
          signal: null,
        }),
      });
      const readPaths: Array<string> = [];
      const operation = startReview({
        processRunner: harness.processRunner,
        async readCommandFile(path) {
          readPaths.push(path);

          return "printf 'original'";
        },
      });

      assert.deepEqual(harness.startedCommands, [
        ["editor", "--wait", "/runtime/command.txt"],
      ]);
      assert.deepEqual(await operation.outcome, {
        type: "decided",
        value: { type: "unchanged" },
      });
      assert.deepEqual(readPaths, ["/runtime/command.txt"]);
    });

    it("reports changed command content as a suggestion without executing it", async () => {
      const harness = createProcessRunnerHarness({
        completion: Promise.resolve({
          type: "exited",
          exitCode: 0,
          signal: null,
        }),
      });
      const operation = startReview({
        processRunner: harness.processRunner,
        readCommandFile: async () => "rm -rf suggested-only",
      });

      assert.deepEqual(await operation.outcome, {
        type: "decided",
        value: {
          type: "changed",
          suggestion: "rm -rf suggested-only",
        },
      });
      assert.deepEqual(harness.startedCommands, [
        ["editor", "--wait", "/runtime/command.txt"],
      ]);
    });

    it("preserves an empty edited command as a changed suggestion", async () => {
      const harness = createProcessRunnerHarness({
        completion: Promise.resolve({
          type: "exited",
          exitCode: 0,
          signal: null,
        }),
      });
      const operation = startReview({
        processRunner: harness.processRunner,
        readCommandFile: async () => "",
      });

      assert.deepEqual(await operation.outcome, {
        type: "decided",
        value: { type: "changed", suggestion: "" },
      });
    });
  });

  describe("when process completion is not successful", () => {
    it("preserves a nonzero process completion without reading the command file", async () => {
      const completion: ProcessCompletion = {
        type: "exited",
        exitCode: 23,
        signal: null,
      };
      const harness = createProcessRunnerHarness({
        completion: Promise.resolve(completion),
      });
      let readCount = 0;
      const operation = startReview({
        processRunner: harness.processRunner,
        readCommandFile: async () => {
          readCount += 1;

          return "unreachable";
        },
      });

      assert.deepEqual(await operation.outcome, {
        type: "failed",
        error: { type: "process-failed", completion },
      });
      assert.equal(readCount, 0);
    });

    it("preserves a signalled process completion without reading the command file", async () => {
      const completion: ProcessCompletion = {
        type: "exited",
        exitCode: null,
        signal: "SIGTERM",
      };
      const harness = createProcessRunnerHarness({
        completion: Promise.resolve(completion),
      });
      let readCount = 0;
      const operation = startReview({
        processRunner: harness.processRunner,
        readCommandFile: async () => {
          readCount += 1;

          return "unreachable";
        },
      });

      assert.deepEqual(await operation.outcome, {
        type: "failed",
        error: { type: "process-failed", completion },
      });
      assert.equal(readCount, 0);
    });

    it("preserves a process startup failure completion", async () => {
      const startupError = new Error("editor executable was not found");
      const completion: ProcessCompletion = {
        type: "spawn-failed",
        error: startupError,
      };
      const harness = createProcessRunnerHarness({
        completion: Promise.resolve(completion),
      });
      const operation = startReview({ processRunner: harness.processRunner });

      assert.deepEqual(await operation.outcome, {
        type: "failed",
        error: { type: "process-failed", completion },
      });
    });

    it("preserves a rejected process completion promise", async () => {
      const observationError = { reason: "observer rejected" };
      const harness = createProcessRunnerHarness({
        completion: Promise.reject(observationError),
      });
      const operation = startReview({ processRunner: harness.processRunner });

      assert.deepEqual(await operation.outcome, {
        type: "failed",
        error: {
          type: "process-observation-failed",
          error: observationError,
        },
      });
    });
  });

  describe("when the successful editor result cannot be read", () => {
    it("preserves the exact command-file read failure", async () => {
      const readError = { code: "EACCES" };
      const harness = createProcessRunnerHarness({
        completion: Promise.resolve({
          type: "exited",
          exitCode: 0,
          signal: null,
        }),
      });
      const operation = startReview({
        processRunner: harness.processRunner,
        readCommandFile: async () => Promise.reject(readError),
      });

      assert.deepEqual(await operation.outcome, {
        type: "failed",
        error: { type: "command-file-read-failed", error: readError },
      });
    });
  });

  describe("when the coordinator cancels the editor operation", () => {
    it("maps observed termination to cancelled and terminates at most once", async () => {
      const completion = createDeferred<ProcessCompletion>();
      const harness = createProcessRunnerHarness({
        completion: completion.promise,
        terminate: async () => ({ type: "termination-observed" }),
      });
      const operation = startReview({ processRunner: harness.processRunner });

      const firstCancellation = operation.cancel();
      const secondCancellation = operation.cancel();
      assert.equal(firstCancellation, secondCancellation);
      assert.deepEqual(await firstCancellation, { type: "cancelled" });
      assert.equal(harness.getTerminationCount(), 1);
    });

    it("maps an already-exited process to already-completed", async () => {
      const completion = createDeferred<ProcessCompletion>();
      const harness = createProcessRunnerHarness({
        completion: completion.promise,
        terminate: async () => ({ type: "already-exited" }),
      });
      const operation = startReview({ processRunner: harness.processRunner });

      assert.deepEqual(await operation.cancel(), {
        type: "already-completed",
      });
    });

    it("preserves a reported termination failure as unconfirmed", async () => {
      const terminationError = new Error("kill failed");
      const completion = createDeferred<ProcessCompletion>();
      const harness = createProcessRunnerHarness({
        completion: completion.promise,
        terminate: async () => ({
          type: "termination-failed",
          error: terminationError,
        }),
      });
      const operation = startReview({ processRunner: harness.processRunner });

      assert.deepEqual(await operation.cancel(), {
        type: "unconfirmed",
        error: terminationError,
      });
    });

    it("maps unconfirmed process termination without inventing an error", async () => {
      const completion = createDeferred<ProcessCompletion>();
      const harness = createProcessRunnerHarness({
        completion: completion.promise,
        terminate: async () => ({ type: "termination-unconfirmed" }),
      });
      const operation = startReview({ processRunner: harness.processRunner });

      assert.deepEqual(await operation.cancel(), { type: "unconfirmed" });
    });

    it("preserves a rejected termination request as unconfirmed", async () => {
      const terminationError = { reason: "termination rejected" };
      const completion = createDeferred<ProcessCompletion>();
      const harness = createProcessRunnerHarness({
        completion: completion.promise,
        terminate: async () => Promise.reject(terminationError),
      });
      const operation = startReview({ processRunner: harness.processRunner });

      assert.deepEqual(await operation.cancel(), {
        type: "unconfirmed",
        error: terminationError,
      });
    });
  });
});
