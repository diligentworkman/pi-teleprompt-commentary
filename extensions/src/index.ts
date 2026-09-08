import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  commands as configEditorCommands,
  configurationFileSystem,
  errorMessageTemplates as configEditorErrorMessageTemplates,
  messages as configEditorMessages,
  createConfigEditor,
  ensureConfigurationFile,
  readStarterConfigurationSource,
  resolveConfigurationEditorCommand,
  writeConfigurationFileAtomically,
  type ConfigurationFileSystem,
  type ConfigEditOutcome,
} from "#/config-editor/index.ts";
import {
  createConfigLoader,
  resolveConfigPath,
} from "#/config-loader/index.ts";
import { createProcessRunner, type ProcessRunner } from "#/process/index.ts";
import {
  commands as workspaceCommands,
  notifications,
} from "#/workspaces/index.ts";

export type TelepromptCommentaryDependencies = {
  configFilePath: string;
  fileSystem: ConfigurationFileSystem;
  processRunner: ProcessRunner;
  readConfigurationFile(): Promise<string>;
  readStarterConfigurationSource(): Promise<string>;
  saveConfiguration(source: string): Promise<void>;
};

function reportConfigEditOutcome({
  outcome,
  notify,
}: {
  outcome: ConfigEditOutcome;
  notify(message: string, level: "info" | "warning"): void;
}): void {
  if (outcome.type === "pi-editor-saved") {
    notify(configEditorMessages.saved, "info");
  } else if (outcome.type === "pi-editor-cancelled") {
    notify(configEditorMessages.cancelled, "info");
  } else if (outcome.type === "editor-unavailable") {
    notify(configEditorMessages.editorUnavailable, "warning");
  } else if (
    outcome.completion.type === "exited" &&
    outcome.completion.exitCode === 0 &&
    outcome.completion.signal === null
  ) {
    notify(configEditorMessages.configuredEditorFinished, "info");
  } else {
    notify(
      configEditorErrorMessageTemplates.configuredEditorDidNotExitCleanly(
        outcome.completion,
      ),
      "warning",
    );
  }
}

export function registerTelepromptCommentary({
  pi,
  dependencies,
}: {
  pi: ExtensionAPI;
  dependencies: TelepromptCommentaryDependencies;
}): void {
  const createLoader = (
    reportConfigurationWarning: (message: string) => void,
  ) => {
    return createConfigLoader({
      readConfigurationFile: dependencies.readConfigurationFile,
      reportConfigurationWarning,
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    const configLoader = createLoader((message) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
    });
    await configLoader.load();
  });
  pi.registerCommand(configEditorCommands.edit.name, {
    description: configEditorCommands.edit.description,
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        if (ctx.hasUI) {
          ctx.ui.notify(configEditorMessages.usage, "warning");
        }

        return;
      }
      const configLoader = createLoader((message) => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        }
      });
      const configEditor = createConfigEditor({
        async ensureConfigurationFile() {
          return ensureConfigurationFile({
            configFilePath: dependencies.configFilePath,
            starterSource: await dependencies.readStarterConfigurationSource(),
            fileSystem: dependencies.fileSystem,
          });
        },
        resolveConfigurationEditor() {
          return resolveConfigurationEditorCommand({
            configLoader,
            configFilePath: dependencies.configFilePath,
          });
        },
        processRunner: dependencies.processRunner,
        readConfigurationFile: dependencies.readConfigurationFile,
        reportConfiguredEditorFailure(completion) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              configEditorErrorMessageTemplates.configuredEditorDidNotExitCleanly(
                completion,
              ),
              "warning",
            );
          }
        },
        openPiEditor: ctx.hasUI
          ? (source) =>
              ctx.ui.editor(configEditorCommands.edit.editorTitle, source)
          : undefined,
        saveConfiguration: dependencies.saveConfiguration,
        async revalidateConfiguration() {
          await configLoader.load();
        },
      });
      const outcome = await configEditor.edit();
      if (ctx.hasUI) {
        reportConfigEditOutcome({
          outcome,
          notify(message, level) {
            ctx.ui.notify(message, level);
          },
        });
      }
    },
  });
  pi.registerCommand(workspaceCommands.list.name, {
    description: workspaceCommands.list.description,
    handler: async (_args, ctx) => {
      ctx.ui.notify(notifications.wc.message, notifications.wc.type);
    },
  });
}

export default function telepromptCommentary(pi: ExtensionAPI): void {
  const configFilePath = resolveConfigPath({
    piAgentDirectory: process.env.PI_CODING_AGENT_DIR,
    homeDirectory: homedir(),
  });
  registerTelepromptCommentary({
    pi,
    dependencies: {
      configFilePath,
      fileSystem: configurationFileSystem,
      processRunner: createProcessRunner(),
      async readConfigurationFile() {
        return readFile(configFilePath, "utf8");
      },
      readStarterConfigurationSource,
      saveConfiguration(source) {
        return writeConfigurationFileAtomically({ configFilePath, source });
      },
    },
  });
}
