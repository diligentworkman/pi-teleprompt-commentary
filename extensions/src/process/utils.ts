import { spawn, type ChildProcess } from "node:child_process";
import { errorMessageTemplates } from "./messages.ts";
import type {
  ProcessCompletion,
  ProcessCompletionObserver,
  RunningProcess,
  ScheduleTimeout,
  SpawnProcess,
  TerminationOutcome,
} from "./types.ts";

export const spawnProcess: SpawnProcess = ({ executable, args, options }) => {
  return spawn(executable, args, options);
};

export const scheduleTimeout: ScheduleTimeout = ({ callback, delayMs }) => {
  const timeout = setTimeout(callback, delayMs);

  return () => {
    clearTimeout(timeout);
  };
};

export function observeProcessCompletion(
  childProcess: ChildProcess,
): ProcessCompletionObserver {
  let settled = false;
  let spawned = false;
  const completion = new Promise<ProcessCompletion>((resolve) => {
    function settle(processCompletion: ProcessCompletion): void {
      if (settled) {
        return;
      }
      settled = true;
      resolve(processCompletion);
    }
    childProcess.once("spawn", () => {
      spawned = true;
    });
    childProcess.once("error", (error) => {
      if (!spawned) {
        settle({
          type: "spawn-failed",
          error,
        });
      }
    });
    childProcess.once("exit", (exitCode, signal) => {
      settle({
        type: "exited",
        exitCode,
        signal,
      });
    });
  });

  return {
    completion,
    isSettled() {
      return settled;
    },
  };
}

export async function terminateProcess({
  childProcess,
  isCompletionSettled,
  completion,
  scheduleTimeout,
  gracePeriodMs,
  finalWaitMs,
}: {
  childProcess: ChildProcess;
  isCompletionSettled: () => boolean;
  completion: Promise<ProcessCompletion>;
  scheduleTimeout: ScheduleTimeout;
  gracePeriodMs: number;
  finalWaitMs: number;
}): Promise<TerminationOutcome> {
  if (isCompletionSettled()) {
    return { type: "already-exited" };
  }
  const gracefulTerminationError = requestTermination({ childProcess });
  if (
    await completionObservedBeforeTimeout({
      completion,
      scheduleTimeout,
      delayMs: gracePeriodMs,
    })
  ) {
    return { type: "termination-observed" };
  }
  const forcedTerminationError = requestTermination({
    childProcess,
    signal: "SIGKILL",
  });
  if (
    await completionObservedBeforeTimeout({
      completion,
      scheduleTimeout,
      delayMs: finalWaitMs,
    })
  ) {
    return { type: "termination-observed" };
  }
  const terminationError = forcedTerminationError ?? gracefulTerminationError;
  if (terminationError) {
    return { type: "termination-failed", error: terminationError };
  }

  return { type: "termination-unconfirmed" };
}

function requestTermination({
  childProcess,
  signal,
}: {
  childProcess: ChildProcess;
  signal?: NodeJS.Signals;
}): Error | undefined {
  try {
    if (!childProcess.kill(signal)) {
      return new Error(errorMessageTemplates.terminationRequestFailed());
    }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function completionObservedBeforeTimeout({
  completion,
  scheduleTimeout,
  delayMs,
}: {
  completion: Promise<ProcessCompletion>;
  scheduleTimeout: ScheduleTimeout;
  delayMs: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const cancelTimeout = scheduleTimeout({
      callback() {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
      delayMs,
    });
    completion.then(() => {
      if (!settled) {
        settled = true;
        cancelTimeout();
        resolve(true);
      }
    });
  });
}

export function createSpawnFailure(error: unknown): RunningProcess {
  const completion = Promise.resolve<ProcessCompletion>({
    type: "spawn-failed",
    error: error instanceof Error ? error : new Error(String(error)),
  });

  return {
    completion,
    async terminate() {
      return { type: "already-exited" };
    },
  };
}
