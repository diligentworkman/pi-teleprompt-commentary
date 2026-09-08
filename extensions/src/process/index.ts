import {
  terminationFinalWaitMs,
  terminationGracePeriodMs,
} from "./constants.ts";
import {
  createSpawnFailure,
  observeProcessCompletion,
  scheduleTimeout,
  spawnProcess,
  terminateProcess,
} from "./utils.ts";
import type {
  ProcessRunner,
  ProcessRunnerDependencies,
  RunningProcess,
  TerminationOutcome,
} from "./types.ts";
import type { ChildProcess } from "node:child_process";

export type {
  ProcessCompletion,
  ProcessRunner,
  RunningProcess,
  TerminationOutcome,
} from "./types.ts";

const defaultProcessRunnerDependencies: ProcessRunnerDependencies = {
  spawnProcess,
  scheduleTimeout,
  terminationGracePeriodMs,
  terminationFinalWaitMs,
};

export function createProcessRunner(
  dependencies: ProcessRunnerDependencies = defaultProcessRunnerDependencies,
): ProcessRunner {
  const {
    spawnProcess,
    scheduleTimeout,
    terminationGracePeriodMs,
    terminationFinalWaitMs,
  } = dependencies;
  const runningProcesses = new Set<RunningProcess>();

  return {
    start({ command }) {
      let childProcess: ChildProcess;
      try {
        childProcess = spawnProcess({
          executable: command[0],
          args: command.slice(1),
          options: { shell: false, stdio: "inherit" },
        });
      } catch (error) {
        return createSpawnFailure(error);
      }
      let termination: Promise<TerminationOutcome> | undefined;
      const completionObserver = observeProcessCompletion(childProcess);
      const runningProcess: RunningProcess = {
        completion: completionObserver.completion,
        terminate() {
          if (termination) {
            return termination;
          }
          const terminationAttempt = terminateProcess({
            childProcess,
            isCompletionSettled: completionObserver.isSettled,
            completion: completionObserver.completion,
            scheduleTimeout,
            gracePeriodMs: terminationGracePeriodMs,
            finalWaitMs: terminationFinalWaitMs,
          });
          termination = terminationAttempt;
          terminationAttempt.then(() => {
            if (termination === terminationAttempt) {
              termination = undefined;
            }
          });

          return terminationAttempt;
        },
      };
      runningProcesses.add(runningProcess);
      completionObserver.completion.then(() => {
        runningProcesses.delete(runningProcess);
      });

      return runningProcess;
    },
    async cleanup() {
      return Promise.all(
        [...runningProcesses].map((runningProcess) =>
          runningProcess.terminate(),
        ),
      );
    },
  };
}
