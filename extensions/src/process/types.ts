import type { ChildProcess, SpawnOptions } from "node:child_process";

export type ProcessCompletion =
  | {
      type: "exited";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      type: "spawn-failed";
      error: Error;
    };

export type ProcessCompletionObserver = {
  completion: Promise<ProcessCompletion>;
  isSettled(): boolean;
};

export type TerminationOutcome =
  | { type: "termination-observed" }
  | { type: "already-exited" }
  | { type: "termination-failed"; error: Error }
  | { type: "termination-unconfirmed" };

export type RunningProcess = {
  completion: Promise<ProcessCompletion>;
  terminate(): Promise<TerminationOutcome>;
};

export type ProcessRunner = {
  start({ command }: { command: [string, ...Array<string>] }): RunningProcess;
  cleanup(): Promise<Array<TerminationOutcome>>;
};

export type SpawnProcess = {
  ({
    executable,
    args,
    options,
  }: {
    executable: string;
    args: Array<string>;
    options: SpawnOptions;
  }): ChildProcess;
};

export type ScheduleTimeout = {
  ({
    callback,
    delayMs,
  }: {
    callback: () => void;
    delayMs: number;
  }): () => void;
};

export type ProcessRunnerDependencies = {
  spawnProcess: SpawnProcess;
  scheduleTimeout: ScheduleTimeout;
  terminationGracePeriodMs: number;
  terminationFinalWaitMs: number;
};
