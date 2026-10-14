import { createConfigLoader } from "#/config-loader/index.ts";
import type { ProcessCompletion, ProcessRunner } from "#/process/index.ts";
import { errorMessageTemplates, openWorkspace, warningMessageTemplates } from "#/workspaces/index.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });

  return { promise, resolve, reject };
}

function createObservedProcessRunner({ commands, completion = Promise.resolve<ProcessCompletion>({ type: "exited", exitCode: 0, signal: null }) }: {
  commands: Array<Array<string>>;
  completion?: Promise<ProcessCompletion>;
}): ProcessRunner {
  return {
    start({ command }) {
      commands.push(command);

      return {
        completion,
        async terminate() {
          return { type: "already-exited" };
        },
      };
    },
    async cleanup() {
      return [];
    },
  };
}

function createStaticConfigLoader(source: string) {
  return createConfigLoader({
    async readConfigurationFile() {
      return source;
    },
    reportConfigurationWarning() {},
  });
}

describe("workspace opener lifecycle", () => {
  const workspacePath = "/workspace";
  const groupId = "workspace-group";
  const configurationSource = '[[handlers.workspace_opener]]\naction = ["opener", { var = "workspace_directory_path" }, { var = "workspace_group_id" }]';
  describe("when observing opener completion", () => {
    it("returns before completion and reports a rejected observer best-effort", async () => {
      const completion = createDeferred<ProcessCompletion>();
      const commands: Array<Array<string>> = [];
      const warnings: Array<string> = [];
      const observationError = new Error("completion observer failed");
      await openWorkspace({
        workspacePath,
        groupId,
        configLoader: createStaticConfigLoader(configurationSource),
        processRunner: createObservedProcessRunner({ commands, completion: completion.promise }),
        reportWarning(message) {
          warnings.push(message);
        },
      });
      assert.deepEqual(commands, [["opener", workspacePath, groupId]]);
      assert.deepEqual(warnings, []);
      completion.reject(observationError);
      await nextEventLoopTurn();
      assert.deepEqual(warnings, [errorMessageTemplates.workspaceOpenFailed({
        workspacePath,
        errorMessage: observationError.message,
      })]);
    });
    for (const failure of ["rejection", "nonzero-exit"] as const) {
      it(`contains a throwing warning callback after ${failure} without an unhandled rejection`, async () => {
        const completion = createDeferred<ProcessCompletion>();
        const observationError = new Error("completion observer failed");
        const commands: Array<Array<string>> = [];
        const warnings: Array<string> = [];
        const warned = createDeferred<void>();
        await openWorkspace({
          workspacePath,
          groupId,
          configLoader: createStaticConfigLoader(configurationSource),
          processRunner: createObservedProcessRunner({ commands, completion: completion.promise }),
          reportWarning(message) {
            warnings.push(message);
            warned.resolve();
            throw new Error("warning callback failed");
          },
        });
        const failedExit: ProcessCompletion = { type: "exited", exitCode: 7, signal: null };
        if (failure === "rejection") {
          completion.reject(observationError);
        } else {
          completion.resolve(failedExit);
        }
        await warned.promise;
        await nextEventLoopTurn();
        assert.deepEqual(warnings, [failure === "rejection"
          ? errorMessageTemplates.workspaceOpenFailed({ workspacePath, errorMessage: observationError.message })
          : warningMessageTemplates.workspaceOpenerDidNotExitCleanly({ workspacePath, completion: failedExit })]);
        assert.deepEqual(commands, [["opener", workspacePath, groupId]]);
      });
    }
    it("contains completion rejection after shutdown without notifying the disposed runtime", async () => {
      const completion = createDeferred<ProcessCompletion>();
      const commands: Array<Array<string>> = [];
      const warnings: Array<string> = [];
      let shuttingDown = false;
      await openWorkspace({
        workspacePath,
        groupId,
        configLoader: createStaticConfigLoader(configurationSource),
        processRunner: createObservedProcessRunner({ commands, completion: completion.promise }),
        reportWarning(message) {
          warnings.push(message);
        },
        isShuttingDown() {
          return shuttingDown;
        },
      });
      shuttingDown = true;
      completion.reject(new Error("observer failed after shutdown"));
      await nextEventLoopTurn();
      assert.deepEqual(commands, [["opener", workspacePath, groupId]]);
      assert.deepEqual(warnings, []);
    });
  });
  it("contains a throwing missing-handler warning and permits a later independent opener", async () => {
    const commands: Array<Array<string>> = [];
    const warnings: Array<string> = [];
    const processRunner = createObservedProcessRunner({ commands });
    await openWorkspace({
      workspacePath,
      groupId,
      configLoader: createStaticConfigLoader(""),
      processRunner,
      reportWarning(message) {
        warnings.push(message);
        throw new Error("warning callback failed");
      },
    });
    await openWorkspace({
      workspacePath,
      groupId,
      configLoader: createStaticConfigLoader(configurationSource),
      processRunner,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(warnings, [warningMessageTemplates.workspaceOpenerNotConfigured(workspacePath)]);
    assert.deepEqual(commands, [["opener", workspacePath, groupId]]);
  });
  it("does not resolve configuration or launch a process when shutdown has already started", async () => {
    let configurationReads = 0;
    const commands: Array<Array<string>> = [];
    const warnings: Array<string> = [];
    const configLoader = createConfigLoader({
      async readConfigurationFile() {
        configurationReads += 1;

        return configurationSource;
      },
      reportConfigurationWarning(message) {
        warnings.push(message);
      },
    });
    await openWorkspace({
      workspacePath,
      groupId,
      configLoader,
      processRunner: createObservedProcessRunner({ commands }),
      reportWarning(message) {
        warnings.push(message);
      },
      isShuttingDown() {
        return true;
      },
    });
    assert.equal(configurationReads, 0);
    assert.deepEqual(commands, []);
    assert.deepEqual(warnings, []);
  });
  it("does not launch an opener when shutdown begins during configuration loading", async () => {
    const resolving = createDeferred<void>();
    const source = createDeferred<string>();
    let shuttingDown = false;
    const commands: Array<Array<string>> = [];
    const warnings: Array<string> = [];
    const configLoader = createConfigLoader({
      readConfigurationFile() {
        resolving.resolve();

        return source.promise;
      },
      reportConfigurationWarning(message) {
        warnings.push(message);
      },
    });
    const opening = openWorkspace({
      workspacePath,
      groupId,
      configLoader,
      processRunner: createObservedProcessRunner({ commands }),
      reportWarning(message) {
        warnings.push(message);
      },
      isShuttingDown() {
        return shuttingDown;
      },
    });
    await resolving.promise;
    shuttingDown = true;
    source.resolve(configurationSource);
    await opening;
    assert.deepEqual(commands, []);
    assert.deepEqual(warnings, []);
  });
  it("preserves normal opener launch and variables while the runtime is active", async () => {
    const commands: Array<Array<string>> = [];
    const warnings: Array<string> = [];
    const configLoader = createConfigLoader({
      async readConfigurationFile() {
        return configurationSource;
      },
      reportConfigurationWarning(message) {
        warnings.push(message);
      },
    });
    await openWorkspace({
      workspacePath,
      groupId,
      configLoader,
      processRunner: createObservedProcessRunner({ commands }),
      reportWarning(message) {
        warnings.push(message);
      },
      isShuttingDown() {
        return false;
      },
    });
    assert.deepEqual(commands, [["opener", workspacePath, groupId]]);
    assert.deepEqual(warnings, []);
  });
});
