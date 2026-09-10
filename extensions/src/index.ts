import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  commands as configEditorCommands,
  configurationFileSystem,
  errorMessageTemplates as configEditorErrorMessageTemplates,
  configEditMessages,
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
import { resolveInputPath } from "#/paths/index.ts";
import { createProcessRunner, type ProcessRunner } from "#/process/index.ts";
import {
  addWorkspace,
  commands as workspaceCommands,
  confirmationMessageTemplates as workspaceConfirmationMessageTemplates,
  errorMessageTemplates as workspaceErrorMessageTemplates,
  formatWorkspaceList,
  infoMessageTemplates as workspaceInfoMessageTemplates,
  openWorkspace,
  removeWorkspace,
  resolveWorkspaceDirectory,
  restoreWorkspaceSnapshot,
  warningMessageTemplates as workspaceWarningMessageTemplates,
  workspaceEntryType,
} from "#/workspaces/index.ts";

export type TelepromptCommentaryDependencies = {
  configFilePath: string;
  fileSystem: ConfigurationFileSystem;
  processRunner: ProcessRunner;
  readConfigurationFile(): Promise<string>;
  readStarterConfigurationSource(): Promise<string>;
  saveConfiguration(source: string): Promise<void>;
  createWorkspaceGroupId?(): string;
};

function reportConfigEditOutcome({
  outcome,
  notify,
}: {
  outcome: ConfigEditOutcome;
  notify(message: string, level: "info" | "warning"): void;
}): void {
  if (outcome.type === "pi-editor-saved") {
    notify(configEditMessages.saved, "info");
  } else if (outcome.type === "pi-editor-cancelled") {
    notify(configEditMessages.cancelled, "info");
  } else if (outcome.type === "editor-unavailable") {
    notify(configEditMessages.editorUnavailable, "warning");
  } else if (
    outcome.completion.type === "exited" &&
    outcome.completion.exitCode === 0 &&
    outcome.completion.signal === null
  ) {
    notify(configEditMessages.configuredEditorFinished, "info");
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
  let additionalWorkspaces: readonly string[] = [];
  const createLoader = (
    reportConfigurationWarning: (message: string) => void,
  ) => {
    return createConfigLoader({
      readConfigurationFile: dependencies.readConfigurationFile,
      reportConfigurationWarning,
    });
  };
  const resolveAvailableWorkspacePaths = async (
    ctx: ExtensionCommandContext,
  ) => {
    let primaryWorkspace: string | undefined;
    try {
      primaryWorkspace = await resolveWorkspaceDirectory({
        workspacePath: ctx.cwd,
      });
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          workspaceWarningMessageTemplates.primaryWorkspaceUnavailable({
            workspacePath: ctx.cwd,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          }),
          "warning",
        );
      }
    }

    return {
      primaryWorkspace,
      workspacePaths:
        primaryWorkspace === undefined
          ? [...additionalWorkspaces]
          : [primaryWorkspace, ...additionalWorkspaces],
    };
  };
  pi.on("session_start", async (_event, ctx) => {
    additionalWorkspaces = restoreWorkspaceSnapshot(
      ctx.sessionManager.getBranch(),
    ).additionalWorkspaces;
    const configLoader = createLoader((message) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
    });
    await configLoader.load();
  });
  pi.on("session_tree", (_event, ctx) => {
    additionalWorkspaces = restoreWorkspaceSnapshot(
      ctx.sessionManager.getBranch(),
    ).additionalWorkspaces;
  });
  pi.registerCommand(configEditorCommands.edit.name, {
    description: configEditorCommands.edit.description,
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        if (ctx.hasUI) {
          ctx.ui.notify(configEditMessages.usage, "warning");
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
  pi.registerCommand(workspaceCommands.add.name, {
    description: workspaceCommands.add.description,
    handler: async (args, ctx) => {
      let inputPath = args.trim();
      if (inputPath === "") {
        if (!ctx.hasUI) {
          return;
        }
        inputPath =
          (
            await ctx.ui.input(
              workspaceCommands.add.inputTitle,
              workspaceCommands.add.inputPlaceholder,
            )
          )?.trim() ?? "";
        if (inputPath === "") {
          return;
        }
      }
      let primaryWorkspace: string;
      let workspacePath: string;
      try {
        primaryWorkspace = await resolveWorkspaceDirectory({
          workspacePath: ctx.cwd,
        });
        workspacePath = await resolveWorkspaceDirectory({
          workspacePath: resolveInputPath({
            inputPath,
            cwd: ctx.cwd,
            homeDirectory: homedir(),
          }),
        });
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceErrorMessageTemplates.workspaceAddFailed(
              error instanceof Error ? error.message : String(error),
            ),
            "warning",
          );
        }

        return;
      }
      const outcome = addWorkspace({
        state: { primaryWorkspace, additionalWorkspaces },
        workspacePath,
      });
      if (outcome.type === "workspace-already-present") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceInfoMessageTemplates.workspaceAlreadyPresent(
              workspacePath,
            ),
            "info",
          );
        }

        return;
      }
      if (!ctx.hasUI) {
        return;
      }
      const confirmed = await ctx.ui.confirm(
        workspaceCommands.add.confirmTitle,
        workspaceConfirmationMessageTemplates.addWorkspace(workspacePath),
      );
      if (!confirmed) {
        return;
      }
      try {
        pi.appendEntry(workspaceEntryType, {
          additionalWorkspaces: outcome.state.additionalWorkspaces,
        });
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceErrorMessageTemplates.workspaceAddFailed(
              error instanceof Error ? error.message : String(error),
            ),
            "warning",
          );
        }

        return;
      }
      additionalWorkspaces = outcome.state.additionalWorkspaces;
      await ctx.reload();
    },
  });
  pi.registerCommand(workspaceCommands.remove.name, {
    description: workspaceCommands.remove.description,
    handler: async (args, ctx) => {
      let workspacePath = args.trim();
      if (workspacePath === "") {
        if (!ctx.hasUI) {
          return;
        }
        if (additionalWorkspaces.length === 0) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.noAdditionalWorkspacesToRemove(),
            "warning",
          );

          return;
        }
        workspacePath =
          (await ctx.ui.select(workspaceCommands.remove.selectTitle, [
            ...additionalWorkspaces,
          ])) ?? "";
        if (workspacePath === "") {
          return;
        }
      }
      let primaryWorkspace: string;
      try {
        primaryWorkspace = await resolveWorkspaceDirectory({
          workspacePath: ctx.cwd,
        });
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceErrorMessageTemplates.workspaceRemoveFailed(
              error instanceof Error ? error.message : String(error),
            ),
            "warning",
          );
        }

        return;
      }
      const outcome = removeWorkspace({
        state: { primaryWorkspace, additionalWorkspaces },
        workspacePath,
      });
      if (outcome.type === "primary-workspace-not-removable") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.primaryWorkspaceNotRemovable(
              workspacePath,
            ),
            "warning",
          );
        }

        return;
      }
      if (outcome.type === "workspace-not-found") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.workspaceNotFound(workspacePath),
            "warning",
          );
        }

        return;
      }
      if (!ctx.hasUI) {
        return;
      }
      const confirmed = await ctx.ui.confirm(
        workspaceCommands.remove.confirmTitle,
        workspaceConfirmationMessageTemplates.removeWorkspace(workspacePath),
      );
      if (!confirmed) {
        return;
      }
      try {
        pi.appendEntry(workspaceEntryType, {
          additionalWorkspaces: outcome.state.additionalWorkspaces,
        });
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceErrorMessageTemplates.workspaceRemoveFailed(
              error instanceof Error ? error.message : String(error),
            ),
            "warning",
          );
        }

        return;
      }
      additionalWorkspaces = outcome.state.additionalWorkspaces;
      await ctx.reload();
    },
  });
  pi.registerCommand(workspaceCommands.open.name, {
    description: workspaceCommands.open.description,
    handler: async (args, ctx) => {
      const suppliedWorkspacePath = args.trim();
      if (suppliedWorkspacePath === "" && !ctx.hasUI) {
        return;
      }
      const { workspacePaths } = await resolveAvailableWorkspacePaths(ctx);
      let workspacePath = suppliedWorkspacePath;
      if (workspacePath === "") {
        if (workspacePaths.length === 0) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.noWorkspacesAvailableToOpen(),
            "warning",
          );

          return;
        }
        workspacePath =
          (await ctx.ui.select(
            workspaceCommands.open.selectTitle,
            workspacePaths,
          )) ?? "";
        if (workspacePath === "") {
          return;
        }
      } else if (!workspacePaths.includes(workspacePath)) {
        if (ctx.hasUI && suppliedWorkspacePath !== ctx.cwd) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.workspaceNotFound(workspacePath),
            "warning",
          );
        }

        return;
      }
      const configLoader = createLoader((message) => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        }
      });
      await openWorkspace({
        workspacePath,
        groupId: dependencies.createWorkspaceGroupId?.() ?? randomUUID(),
        configLoader,
        processRunner: dependencies.processRunner,
        reportWarning(message) {
          if (ctx.hasUI) {
            ctx.ui.notify(message, "warning");
          }
        },
      });
    },
  });
  pi.registerCommand(workspaceCommands.openAll.name, {
    description: workspaceCommands.openAll.description,
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.workspacesOpenDoesNotAcceptArguments(),
            "warning",
          );
        }

        return;
      }
      const { workspacePaths } = await resolveAvailableWorkspacePaths(ctx);
      if (workspacePaths.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.noWorkspacesAvailableToOpen(),
            "warning",
          );
        }

        return;
      }
      const groupId = dependencies.createWorkspaceGroupId?.() ?? randomUUID();
      const configLoader = createLoader((message) => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        }
      });
      await Promise.all(
        workspacePaths.map((workspacePath) =>
          openWorkspace({
            workspacePath,
            groupId,
            configLoader,
            processRunner: dependencies.processRunner,
            reportWarning(message) {
              if (ctx.hasUI) {
                ctx.ui.notify(message, "warning");
              }
            },
          }),
        ),
      );
    },
  });
  pi.registerCommand(workspaceCommands.list.name, {
    description: workspaceCommands.list.description,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      let canonicalPrimaryWorkspace: string | undefined;
      try {
        canonicalPrimaryWorkspace = await resolveWorkspaceDirectory({
          workspacePath: ctx.cwd,
        });
      } catch (error) {
        ctx.ui.notify(
          workspaceWarningMessageTemplates.primaryWorkspaceUnavailable({
            workspacePath: ctx.cwd,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          }),
          "warning",
        );
      }
      ctx.ui.notify(
        formatWorkspaceList({
          primaryWorkspace:
            canonicalPrimaryWorkspace === undefined
              ? { path: ctx.cwd, availability: "unavailable" }
              : {
                  path: canonicalPrimaryWorkspace,
                  availability: "available",
                },
          additionalWorkspaces,
        }),
        "info",
      );
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
