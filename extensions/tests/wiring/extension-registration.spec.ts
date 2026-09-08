import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import {
  commands as configEditorCommands,
  errorMessageTemplates as configEditorErrorMessageTemplates,
  messages,
} from "#/config-editor/index.ts";
import { errorMessageTemplates } from "#/config-loader/messages.ts";
import telepromptCommentary, {
  registerTelepromptCommentary,
  type TelepromptCommentaryDependencies,
} from "#/index.ts";
import {
  commands as workspaceCommands,
  notifications,
  type Notification,
} from "#/workspaces/index.ts";

import type { ProcessCompletion } from "#/process/index.ts";

type EditorRequest = {
  title: string;
  source: string;
};

type WiringObservations = {
  notifications: Notification[];
  editorRequests: EditorRequest[];
  savedSources: string[];
  processCommands: string[][];
  configurationReadCount: number;
};

type RegisteredCommand = {
  handler(args: string, context: any): Promise<void> | void;
};

function collectEntryPointCommandNames(): string[] {
  const commandNames: string[] = [];
  telepromptCommentary({
    on() {},
    registerCommand(name: string) {
      commandNames.push(name);
    },
  } as any);

  return commandNames;
}

function createPendingProcessCompletion() {
  let resolveCompletion: (completion: ProcessCompletion) => void = () => {
    throw new Error("Process completion resolver was unavailable.");
  };
  const promise = new Promise<ProcessCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  return {
    promise,
    resolve(completion: ProcessCompletion) {
      resolveCompletion(completion);
    },
  };
}

function createWiringHarness({
  configurationSource = "",
  starterSource = "",
  piEditorResult,
  processCompletion,
}: {
  configurationSource?: string;
  starterSource?: string;
  piEditorResult?: string;
  processCompletion?: Promise<ProcessCompletion>;
} = {}) {
  const commands = new Map<string, RegisteredCommand>();
  const sessionStartHandlers: Array<
    (event: unknown, context: any) => Promise<void> | void
  > = [];
  const observations: WiringObservations = {
    notifications: [],
    editorRequests: [],
    savedSources: [],
    processCommands: [],
    configurationReadCount: 0,
  };
  const dependencies: TelepromptCommentaryDependencies = {
    configFilePath: "/config/teleprompt-commentary/config.toml",
    fileSystem: {
      async createDirectory() {},
      async createFileExclusively() {},
      async readFile() {
        return configurationSource;
      },
    },
    processRunner: {
      start({ command }) {
        if (processCompletion === undefined) {
          throw new Error("The process runner was not expected to start.");
        }
        observations.processCommands.push(command);

        return {
          completion: processCompletion,
          async terminate() {
            return { type: "already-exited" };
          },
        };
      },
      async cleanup() {
        return [];
      },
    },
    async readConfigurationFile() {
      observations.configurationReadCount += 1;

      return configurationSource;
    },
    async readStarterConfigurationSource() {
      return starterSource;
    },
    async saveConfiguration(source) {
      observations.savedSources.push(source);
    },
  };
  registerTelepromptCommentary({
    pi: {
      on(event: string, handler: any) {
        if (event === "session_start") {
          sessionStartHandlers.push(handler);
        }
      },
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
    } as any,
    dependencies,
  });
  function createContext(hasUI: boolean) {
    return {
      hasUI,
      ui: {
        async editor(title: string, source: string) {
          observations.editorRequests.push({ title, source });

          return piEditorResult;
        },
        notify(message: string, type: Notification["type"]) {
          observations.notifications.push({ message, type });
        },
      },
    };
  }

  return {
    observations,
    commandNames: [...commands.keys()],
    async startSession(hasUI = true) {
      if (sessionStartHandlers.length !== 1) {
        throw new Error("The harness requires one session-start handler.");
      }
      await sessionStartHandlers[0]({}, createContext(hasUI));
    },
    async runCommand({
      name,
      args = "",
      hasUI = true,
    }: {
      name: string;
      args?: string;
      hasUI?: boolean;
    }) {
      const command = commands.get(name);
      if (!command) {
        throw new Error(
          `The harness has no registered command named "${name}".`,
        );
      }
      await command.handler(args, createContext(hasUI));
    },
  };
}

describe("telepromptCommentary", () => {
  describe("extension entry point", () => {
    it("registers namespaced commands", () => {
      assert.deepEqual(collectEntryPointCommandNames(), [
        configEditorCommands.edit.name,
        workspaceCommands.list.name,
      ]);
    });
  });
  describe("workspace list command", () => {
    it("retains the placeholder behavior", async () => {
      const harness = createWiringHarness();
      await harness.runCommand({ name: workspaceCommands.list.name });
      assert.deepEqual(harness.observations.notifications, [notifications.wc]);
    });
  });
  describe("session_start", () => {
    it("loads configuration and reports warnings through Pi UI", async () => {
      const harness = createWiringHarness({
        configurationSource: "handlers = [",
      });
      await harness.startSession();
      assert.equal(harness.observations.configurationReadCount, 1);
      assert.equal(harness.observations.notifications.length, 1);
      assert.equal(harness.observations.notifications[0].type, "warning");
      assert.ok(
        harness.observations.notifications[0].message.startsWith(
          errorMessageTemplates.configurationSourceInvalid(""),
        ),
      );
    });
  });
  describe("edit configuration command", () => {
    it("runs the configured editor and revalidates after completion", async () => {
      const completion = createPendingProcessCompletion();
      const harness = createWiringHarness({
        configurationSource: `
[[handlers.configuration_editor]]
action = ["editor", "--wait", "argument with spaces", { var = "config_file_path" }]
`,
        processCompletion: completion.promise,
      });
      let commandFinished = false;
      const command = harness
        .runCommand({ name: configEditorCommands.edit.name })
        .then(() => {
          commandFinished = true;
        });
      // Drain ready promise continuations while editor completion stays pending.
      await nextEventLoopTurn();
      assert.equal(commandFinished, false);
      assert.equal(harness.observations.configurationReadCount, 1);
      assert.deepEqual(harness.observations.notifications, []);
      assert.deepEqual(harness.observations.processCommands, [
        [
          "editor",
          "--wait",
          "argument with spaces",
          "/config/teleprompt-commentary/config.toml",
        ],
      ]);
      assert.deepEqual(harness.observations.editorRequests, []);
      assert.deepEqual(harness.observations.savedSources, []);
      completion.resolve({ type: "exited", exitCode: 0, signal: null });
      await command;
      assert.equal(commandFinished, true);
      assert.deepEqual(harness.observations.editorRequests, []);
      assert.deepEqual(harness.observations.savedSources, []);
      assert.equal(harness.observations.configurationReadCount, 2);
      assert.deepEqual(harness.observations.notifications, [
        { message: messages.configuredEditorFinished, type: "info" },
      ]);
    });
    it("warns and falls back to Pi after a nonzero editor exit, then revalidates", async () => {
      const completion: ProcessCompletion = {
        type: "exited",
        exitCode: 7,
        signal: null,
      };
      const configurationSource = `
[[handlers.configuration_editor]]
action = ["editor", "--wait", { var = "config_file_path" }]
`;
      const cancelledEditorResult = undefined;
      const harness = createWiringHarness({
        configurationSource,
        processCompletion: Promise.resolve(completion),
        piEditorResult: cancelledEditorResult,
      });
      await harness.runCommand({ name: configEditorCommands.edit.name });
      assert.deepEqual(harness.observations.processCommands, [
        ["editor", "--wait", "/config/teleprompt-commentary/config.toml"],
      ]);
      assert.deepEqual(harness.observations.editorRequests, [
        { title: configEditorCommands.edit.editorTitle, source: configurationSource },
      ]);
      assert.deepEqual(harness.observations.savedSources, []);
      assert.equal(harness.observations.configurationReadCount, 3);
      assert.deepEqual(harness.observations.notifications, [
        {
          message:
            configEditorErrorMessageTemplates.configuredEditorDidNotExitCleanly(
              completion,
            ),
          type: "warning",
        },
        { message: messages.cancelled, type: "info" },
      ]);
    });
    it("reports usage without editing when arguments are provided", async () => {
      const harness = createWiringHarness();
      await harness.runCommand({
        name: configEditorCommands.edit.name,
        args: "unexpected",
      });
      assert.deepEqual(harness.observations.notifications, [
        { message: messages.usage, type: "warning" },
      ]);
      assert.deepEqual(harness.observations.editorRequests, []);
    });
    it("saves and revalidates text returned by Pi's editor", async () => {
      const starterSource = "starter configuration";
      const editedSource = "edited configuration";
      const harness = createWiringHarness({
        starterSource,
        piEditorResult: editedSource,
      });
      await harness.runCommand({ name: configEditorCommands.edit.name });
      assert.deepEqual(harness.observations.editorRequests, [
        {
          title: configEditorCommands.edit.editorTitle,
          source: starterSource,
        },
      ]);
      assert.deepEqual(harness.observations.savedSources, [editedSource]);
      assert.equal(harness.observations.configurationReadCount, 2);
      assert.deepEqual(harness.observations.notifications, [
        { message: messages.saved, type: "info" },
      ]);
    });
    it("silently revalidates without editing when no UI or configured editor is available", async () => {
      const harness = createWiringHarness({ configurationSource: "" });
      await harness.runCommand({
        name: configEditorCommands.edit.name,
        hasUI: false,
      });
      assert.deepEqual(harness.observations.processCommands, []);
      assert.deepEqual(harness.observations.editorRequests, []);
      assert.deepEqual(harness.observations.savedSources, []);
      assert.deepEqual(harness.observations.notifications, []);
      assert.equal(harness.observations.configurationReadCount, 2);
    });
    it("preserves and revalidates the file when Pi's editor is cancelled", async () => {
      const starterSource = "starter configuration";
      const cancelledEditorResult = undefined;
      const harness = createWiringHarness({
        starterSource,
        piEditorResult: cancelledEditorResult,
      });
      await harness.runCommand({ name: configEditorCommands.edit.name });
      assert.deepEqual(harness.observations.editorRequests, [
        {
          title: configEditorCommands.edit.editorTitle,
          source: starterSource,
        },
      ]);
      assert.deepEqual(harness.observations.savedSources, []);
      assert.equal(harness.observations.configurationReadCount, 2);
      assert.deepEqual(harness.observations.notifications, [
        { message: messages.cancelled, type: "info" },
      ]);
    });
  });
});
